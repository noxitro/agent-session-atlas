//! 段階 2: 依頼(ターン)ごとの LLM 判定の形(turn-judgments.json)と、検証・読み書き・取り込み(packages/judge/src/turn-schema.ts の移植)。
//! 1 項目 = 1 依頼。依頼の種類・成果の扱い(採用)・合わなかった点・普段の工程名・確信度・理由。
//! 判定の対象と並びは core の session_turns と同じ(依頼番号は 1 から、セッションの先頭 200 依頼まで)。

use crate::judgments_io::write_json_atomic;
use crate::schema::{items_from_candidates, json_candidates, JudgmentValidationError, BACKENDS};
use anyhow::{anyhow, bail, Result};
use atlas_core::collate::locale_compare;
use atlas_core::js;
use atlas_core::turns::{MISMATCHES, NEEDS_MISMATCH, OUTCOMES, QUESTION_OUTCOMES, REQUEST_KINDS, WORK_OUTCOMES};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const TURN_JUDGMENTS_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnJudge {
    pub backend: String,
    pub model: Option<String>,
    pub ran_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnJudgment {
    pub session_id: String,
    /// セッションの中の依頼番号(1 から)
    pub turn: i64,
    pub kind: String,
    pub outcome: String,
    /// 合わなかった点(中身・体裁の修正、不採用、的外れのときだけ。それ以外は null)
    pub mismatch: Option<String>,
    /// 普段の工程名(turn-judgments.json の phases のどれか)
    pub phase: String,
    /// 0〜1
    pub confidence: f64,
    /// 判定の理由(短く)
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<TurnJudge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnJudgmentsFile {
    pub schema_version: i64,
    /// 判定に使った普段の工程名の一覧(判定の指示に載せたもの)
    pub phases: Vec<String>,
    pub judge: TurnJudge,
    pub items: Vec<TurnJudgment>,
    /// 判定できなかった塊(セッションと依頼番号)。形は検証しない
    pub failures: Vec<Value>,
}

fn key(session_id: &str, turn: i64) -> String {
    format!("{session_id}#{turn}")
}

fn stringify(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => atlas_core::json::to_js_string(v).unwrap_or_default(),
    }
}

fn str_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_js_string)
}

fn is_in(list: &[&str], v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| list.contains(&s))
}

/// 1 項目の問題点(空なら妥当)。phases は判定の指示に載せた工程名。
/// None なら工程名は「空でない文字列」かだけを見る(保存済みのファイルを読むとき。工程名の設定を変えた後も前の判定を読めるように)
pub fn turn_item_problems(v: &Value, path: &str, phases: Option<&[String]>) -> Vec<String> {
    let Some(o) = v.as_object() else { return vec![format!("{path}が無いか、{{ … }} の形ではありません")] };
    let mut p = Vec::new();
    let at = |field: &str| format!("{path}の {field}");
    if !o.get("sessionId").and_then(Value::as_str).is_some_and(|s| !js::trim(s).is_empty()) {
        p.push(format!("{} がありません", at("sessionId")));
    }
    if !js::num(o.get("turn")).is_some_and(|t| t.fract() == 0.0 && t >= 1.0) {
        p.push(format!("{} は 1 以上の整数です({})", at("turn"), stringify(o.get("turn"))));
    }
    let kind_ok = is_in(&REQUEST_KINDS, o.get("kind"));
    if !kind_ok {
        p.push(format!("{} は {} のどれかです({})", at("kind"), REQUEST_KINDS.join(" / "), stringify(o.get("kind"))));
    }
    if !is_in(&OUTCOMES, o.get("outcome")) {
        p.push(format!("{} は {} のどれかです({})", at("outcome"), OUTCOMES.join(" / "), stringify(o.get("outcome"))));
    } else if kind_ok {
        let allowed: &[&str] = if o.get("kind").and_then(Value::as_str) == Some("question") { &QUESTION_OUTCOMES } else { &WORK_OUTCOMES };
        if !is_in(allowed, o.get("outcome")) {
            p.push(format!("{} は kind が {} のとき {} のどれかです({})", at("outcome"), str_of(o.get("kind")), allowed.join(" / "), stringify(o.get("outcome"))));
        }
    }
    let needs = is_in(&NEEDS_MISMATCH, o.get("outcome"));
    if needs && !is_in(&MISMATCHES, o.get("mismatch")) {
        p.push(format!("{} は outcome が {} のとき {} のどれかです({})", at("mismatch"), str_of(o.get("outcome")), MISMATCHES.join(" / "), stringify(o.get("mismatch"))));
    }
    if !needs && js::present(o.get("mismatch")).is_some() {
        p.push(format!("{} は outcome が {} のときは null です({})", at("mismatch"), str_of(o.get("outcome")), stringify(o.get("mismatch"))));
    }
    let phase = o.get("phase").and_then(Value::as_str);
    match phases {
        Some(ph) => {
            if !phase.is_some_and(|x| ph.iter().any(|y| y == x)) {
                p.push(format!("{} は {} のどれかです({})", at("phase"), ph.join(" / "), stringify(o.get("phase"))));
            }
        }
        None => {
            if !phase.is_some_and(|x| !js::trim(x).is_empty()) {
                p.push(format!("{} がありません", at("phase")));
            }
        }
    }
    if !js::num(o.get("confidence")).is_some_and(|c| (0.0..=1.0).contains(&c)) {
        p.push(format!("{} は 0〜1 の数値です({})", at("confidence"), stringify(o.get("confidence"))));
    }
    if js::present(o.get("note")).is_some_and(|n| !n.is_string()) {
        p.push(format!("{} は文字列です", at("note")));
    }
    p
}

fn normalize_item(v: &Map<String, Value>) -> TurnJudgment {
    let outcome = v.get("outcome").and_then(Value::as_str).unwrap_or("").to_string();
    TurnJudgment {
        session_id: v.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string(),
        turn: v.get("turn").and_then(Value::as_f64).unwrap_or(0.0) as i64,
        kind: v.get("kind").and_then(Value::as_str).unwrap_or("").to_string(),
        mismatch: if NEEDS_MISMATCH.contains(&outcome.as_str()) { v.get("mismatch").and_then(Value::as_str).map(str::to_string) } else { None },
        outcome,
        phase: v.get("phase").and_then(Value::as_str).unwrap_or("").to_string(),
        confidence: v.get("confidence").and_then(Value::as_f64).unwrap_or(0.0),
        note: v.get("note").and_then(Value::as_str).map(|n| js::trim(n).to_string()).unwrap_or_default(),
        judge: None,
    }
}

pub fn empty_turn_judgments(phases: &[String], backend: &str, model: Option<&str>, ran_at: &str) -> TurnJudgmentsFile {
    TurnJudgmentsFile { schema_version: TURN_JUDGMENTS_VERSION, phases: phases.to_vec(), judge: TurnJudge { backend: backend.into(), model: model.map(str::to_string), ran_at: ran_at.into() }, items: vec![], failures: vec![] }
}

fn judge_of(j: &Map<String, Value>) -> TurnJudge {
    TurnJudge {
        backend: j.get("backend").and_then(Value::as_str).filter(|b| BACKENDS.contains(b)).unwrap_or("external").to_string(),
        model: j.get("model").and_then(Value::as_str).map(str::to_string),
        ran_at: j.get("ranAt").and_then(Value::as_str).unwrap_or("").to_string(),
    }
}

pub fn validate_turn_judgments(v: &Value) -> Result<TurnJudgmentsFile> {
    let Some(o) = v.as_object() else { bail!("turn-judgments が {{ … }} の形ではありません") };
    if o.get("schemaVersion").and_then(Value::as_f64) != Some(TURN_JUDGMENTS_VERSION as f64) {
        bail!("turn-judgments の版が違います({})", str_of(o.get("schemaVersion")));
    }
    let phases: Vec<String> = match o.get("phases") {
        Some(Value::Array(a)) if a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty())) => a.iter().map(|x| x.as_str().unwrap().to_string()).collect(),
        _ => bail!("turn-judgments の phases は文字列の配列です"),
    };
    let empty = vec![];
    let items = o.get("items").and_then(Value::as_array).unwrap_or(&empty);
    let problems: Vec<String> = items.iter().enumerate().flat_map(|(i, it)| turn_item_problems(it, &format!("項目 {}", i + 1), None)).collect();
    if !problems.is_empty() {
        return Err(JudgmentValidationError::with_prefix(problems, "turn-judgments の形が正しくありません").into());
    }
    let emptym = Map::new();
    let j = o.get("judge").and_then(Value::as_object).unwrap_or(&emptym);
    Ok(TurnJudgmentsFile {
        schema_version: TURN_JUDGMENTS_VERSION,
        phases,
        judge: judge_of(j),
        items: items
            .iter()
            .map(|it| {
                let m = it.as_object().expect("検証済み");
                let mut x = normalize_item(m);
                if let Some(jj) = m.get("judge").and_then(Value::as_object).filter(|jj| jj.get("ranAt").is_some_and(Value::is_string)) {
                    x.judge = Some(judge_of(jj));
                }
                x
            })
            .collect(),
        failures: o.get("failures").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

pub fn read_turn_judgments(path: &Path) -> Result<Option<TurnJudgmentsFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&std::fs::read(path)?).into_owned();
    let raw = js::parse_json(&text).map_err(|e| anyhow!("{} を JSON として読めません: {e}", path.display()))?;
    validate_turn_judgments(&raw).map(Some)
}

pub fn write_turn_judgments(path: &Path, j: &TurnJudgmentsFile) -> Result<()> {
    write_json_atomic(path, j)
}

/// 失敗の記録の依頼番号(数でないものは NaN 扱いで一致しない)
fn failure_turns(f: &Value) -> Vec<Value> {
    f.get("turns").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// 判定を足す(同じセッション・依頼番号は新しいもので置き換える)。工程名の一覧は今の設定を先に、前の一覧にしか無い名前を後ろに足す
/// (工程名を変えた後も、前の名前の判定を読めて、レポートの行にも出るように)
pub fn merge_turn_judgments(base: &TurnJudgmentsFile, items: &[TurnJudgment], phases: &[String], judge: TurnJudge) -> TurnJudgmentsFile {
    let mut by: IndexMap<String, TurnJudgment> = base.items.iter().map(|i| (key(&i.session_id, i.turn), i.clone())).collect();
    for i in items {
        by.insert(key(&i.session_id, i.turn), i.clone());
    }
    let done: HashSet<String> = items.iter().map(|i| key(&i.session_id, i.turn)).collect();
    let failures: Vec<Value> = base
        .failures
        .iter()
        .filter(|f| {
            let sid = f.get("sessionId").map(js::to_js_string).unwrap_or_else(|| "undefined".into());
            !failure_turns(f).iter().all(|t| done.contains(&format!("{sid}#{}", js::to_js_string(t))))
        })
        .cloned()
        .collect();
    let mut merged: Vec<TurnJudgment> = by.into_values().collect();
    merged.sort_by(|a, b| locale_compare(&a.session_id, &b.session_id).then(a.turn.cmp(&b.turn)));
    let mut names: Vec<String> = phases.to_vec();
    for x in &base.phases {
        if !phases.contains(x) {
            names.push(x.clone());
        }
    }
    for i in &merged {
        if !names.contains(&i.phase) {
            names.push(i.phase.clone());
        }
    }
    TurnJudgmentsFile { schema_version: TURN_JUDGMENTS_VERSION, phases: names, judge, items: merged, failures }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnImportResult {
    pub imported: usize,
    pub overwritten: usize,
    /// 集計に無いセッション、またはその依頼番号が無いもの(取り込むがレポートには出ない)
    pub unknown: Vec<String>,
    pub total: usize,
}

pub struct TurnImportOptions<'a> {
    pub phases: &'a [String],
    /// セッション ID → 依頼の数(分かるときだけ。範囲外の依頼番号を知らせる)
    pub turns_by_session: Option<&'a HashMap<String, usize>>,
    pub now: Option<String>,
    pub backend: Option<String>,
    pub model: Option<String>,
}

/// 外部で作った依頼の判定(JSON か、JSON のコードブロックを含む返答)を検証して turn-judgments.json に足す。
/// 1 件でも形が合わなければ何も書かない。
pub fn import_turn_judgments_text(input: &str, path: &Path, o: TurnImportOptions<'_>) -> Result<TurnImportResult> {
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let cands = json_candidates(text);
    if cands.is_empty() {
        bail!("貼り付けた返答から JSON を取り出せません(```json のコードブロックを含む返答を貼ってください)");
    }
    let raw = items_from_candidates(&cands);
    if raw.is_empty() {
        bail!("貼り付けた返答に判定の項目(items)がありません");
    }
    let mut model = o.model.clone();
    for c in &cands {
        if model.is_none()
            && let Some(m) = c.as_object().and_then(|c| c.get("judge")).and_then(Value::as_object).and_then(|j| j.get("model")).and_then(Value::as_str).filter(|m| !m.is_empty())
        {
            model = Some(m.to_string());
        }
    }
    let mut problems: Vec<String> = Vec::new();
    for (i, it) in raw.iter().enumerate() {
        let sid = it.get("sessionId").and_then(Value::as_str).filter(|_| it.is_object()).unwrap_or("");
        let t = it.get("turn").filter(|t| t.is_number() && it.is_object());
        let head = format!(
            "{} 件目{}",
            i + 1,
            if sid.is_empty() { String::new() } else { format!("(セッション {sid}{})", t.map(|t| format!(" の依頼 {}", js::to_js_string(t))).unwrap_or_default()) }
        );
        problems.extend(turn_item_problems(it, &head, Some(o.phases)));
    }
    if !problems.is_empty() {
        return Err(JudgmentValidationError::with_prefix(problems, "返答の形が判定の形式に合いません(何も取り込んでいません)").into());
    }
    let ran_at = o.now.clone().unwrap_or_else(atlas_core::jsdate::now_iso);
    let judge = TurnJudge { backend: o.backend.clone().unwrap_or_else(|| "external".into()), model: model.clone(), ran_at: ran_at.clone() };
    let items: Vec<TurnJudgment> = raw.iter().map(|it| TurnJudgment { judge: Some(judge.clone()), ..normalize_item(it.as_object().expect("検証済み")) }).collect();
    let base = read_turn_judgments(path)?.unwrap_or_else(|| empty_turn_judgments(o.phases, &judge.backend, model.as_deref(), &ran_at));
    let existing: HashSet<String> = base.items.iter().map(|i| key(&i.session_id, i.turn)).collect();
    let merged = merge_turn_judgments(&base, &items, o.phases, judge);
    write_turn_judgments(path, &merged)?;
    let unknown = match o.turns_by_session {
        Some(m) => items.iter().filter(|i| !m.contains_key(&i.session_id) || i.turn > *m.get(&i.session_id).unwrap_or(&0) as i64).map(|i| format!("{} の依頼 {}", i.session_id, i.turn)).collect(),
        None => vec![],
    };
    Ok(TurnImportResult { imported: items.len(), overwritten: items.iter().filter(|i| existing.contains(&key(&i.session_id, i.turn))).count(), unknown, total: merged.items.len() })
}

/// 判定の返答の JSON Schema(判定の指示に載せる)
pub fn turn_json_schema(phases: &[String]) -> Value {
    let mut mism: Vec<Value> = MISMATCHES.iter().map(|m| json!(m)).collect();
    mism.push(Value::Null);
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["items"],
        "properties": {
            "schemaVersion": { "const": TURN_JUDGMENTS_VERSION },
            "judge": { "type": "object", "properties": { "model": { "type": ["string", "null"] } } },
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["sessionId", "turn", "kind", "outcome", "mismatch", "phase", "confidence", "note"],
                    "properties": {
                        "sessionId": { "type": "string" },
                        "turn": { "type": "integer", "minimum": 1 },
                        "kind": { "enum": REQUEST_KINDS },
                        "outcome": { "enum": OUTCOMES, "description": "kind が question のときは helpful / follow_up / off_target / unknown、それ以外は as_is / fix_content / fix_style / rejected / unknown" },
                        "mismatch": { "enum": mism, "description": "outcome が fix_content / fix_style / rejected / off_target のときだけ値を入れ、それ以外は null" },
                        "phase": { "enum": phases },
                        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                        "note": { "type": "string", "maxLength": 300 }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phases() -> Vec<String> {
        ["要件定義", "設計", "実装", "テスト"].iter().map(|s| s.to_string()).collect()
    }

    pub fn item(turn: i64, p: Value) -> Value {
        let mut v = json!({ "sessionId": "s1", "turn": turn, "kind": "task", "outcome": "as_is", "mismatch": null, "phase": "実装", "confidence": 0.8, "note": "理由" });
        for (k, x) in p.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    #[test]
    fn checks_kind_outcome_mismatch_phase_confidence() {
        let ph = phases();
        let pr = |v: Value, path: &str| turn_item_problems(&v, path, Some(&ph));
        assert!(pr(item(1, json!({})), "1 件目").is_empty());
        assert!(pr(item(1, json!({"kind": "question", "outcome": "helpful"})), "1 件目").is_empty());
        assert!(pr(item(1, json!({"outcome": "fix_style", "mismatch": "quality"})), "1 件目").is_empty());
        assert!(pr(item(1, json!({"kind": "question", "outcome": "as_is"})), "1 件目").join(",").contains("kind が question のとき helpful"));
        assert!(pr(item(1, json!({"outcome": "helpful"})), "1 件目").join(",").contains("kind が task のとき as_is"));
        assert!(pr(item(1, json!({"outcome": "rejected"})), "1 件目").join(",").contains("mismatch は outcome が rejected のとき"));
        assert!(pr(item(1, json!({"mismatch": "defect"})), "1 件目").join(",").contains("mismatch は outcome が as_is のときは null"));
        assert!(pr(item(1, json!({"phase": "開発"})), "1 件目").join(",").contains("phase は 要件定義 / 設計 / 実装 / テスト"));
        assert_eq!(pr(item(0, json!({"confidence": 2})), "1 件目").len(), 2);
        assert_eq!(pr(json!("x"), "2 件目"), vec!["2 件目が無いか、{ … } の形ではありません".to_string()]);
    }

    #[test]
    fn import_is_all_or_nothing_and_overwrites() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("turn-judgments.json");
        let ph = phases();
        fn opts(ph: &[String]) -> TurnImportOptions<'_> {
            TurnImportOptions { phases: ph, turns_by_session: None, now: None, backend: None, model: None }
        }
        let bad = format!("```json\n{}\n```", json!({ "items": [item(1, json!({})), item(2, json!({"outcome": "rejected"}))] }));
        let e = import_turn_judgments_text(&bad, &path, opts(&ph)).unwrap_err();
        assert!(e.to_string().contains("何も取り込んでいません"));
        let v = e.downcast_ref::<JudgmentValidationError>().unwrap();
        assert_eq!(v.problems.len(), 1);
        assert!(v.problems[0].starts_with("2 件目(セッション s1 の依頼 2)の mismatch"), "{:?}", v.problems);
        assert!(read_turn_judgments(&path).unwrap().is_none());
        let ok = format!("判定しました\n```json\n{}\n```", json!({ "judge": { "model": "m365" }, "items": [item(1, json!({})), item(2, json!({"outcome": "fix_content", "mismatch": "requirement"})), item(9, json!({}))] }));
        let tbs: HashMap<String, usize> = [("s1".to_string(), 2)].into_iter().collect();
        let r = import_turn_judgments_text(&ok, &path, TurnImportOptions { turns_by_session: Some(&tbs), ..opts(&ph) }).unwrap();
        assert_eq!(r, TurnImportResult { imported: 3, overwritten: 0, unknown: vec!["s1 の依頼 9".into()], total: 3 });
        let again = import_turn_judgments_text(&format!("```json\n{}\n```", json!([item(2, json!({"outcome": "fix_style", "mismatch": "quality"}))])), &path, opts(&ph)).unwrap();
        assert_eq!((again.imported, again.overwritten, again.total), (1, 1, 3));
        let j = read_turn_judgments(&path).unwrap().unwrap();
        let t2 = j.items.iter().find(|i| i.turn == 2).unwrap();
        assert_eq!((t2.outcome.as_str(), t2.mismatch.as_deref(), t2.judge.as_ref().unwrap().backend.as_str()), ("fix_style", Some("quality"), "external"));
        assert_eq!(j.items.iter().find(|i| i.turn == 1).unwrap().judge.as_ref().unwrap().model.as_deref(), Some("m365"));
        assert_eq!(j.phases, ph);
        // 工程名の設定を変えて取り込んでも、前の名前の判定を読める(一覧は今の名前を先に、前の名前を後ろに残す)
        let next: Vec<String> = ["調査", "開発", "検証"].iter().map(|s| s.to_string()).collect();
        import_turn_judgments_text(&format!("```json\n{}\n```", json!([item(5, json!({"phase": "開発"}))])), &path, opts(&next)).unwrap();
        let k = read_turn_judgments(&path).unwrap().unwrap();
        assert_eq!(k.phases, ["調査", "開発", "検証", "要件定義", "設計", "実装", "テスト"]);
        assert_eq!(k.items.iter().map(|i| i.phase.as_str()).collect::<Vec<_>>(), ["実装", "実装", "開発", "実装"]);
        assert!(import_turn_judgments_text(&format!("```json\n{}\n```", json!([item(6, json!({}))])), &path, opts(&next)).unwrap_err().to_string().contains("何も取り込んでいません"));
    }
}
