//! judgments.json のスキーマ(schemaVersion 1)と検証(packages/judge/src/schema.ts の移植のうち、読む側)。
//! 外部 LLM の出力も内部バックエンドの出力も、ここを通ったものだけを judgments.json に入れる。
//! 形が合わないものは黙って直さず、どこが違うかを列挙して落とす。
//! TODO(段 6): mergeJudgments・numericLeaves・addUsage・jsonCandidates・itemsFromCandidates・JSON スキーマは judge の移植で足す

use atlas_core::js;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const JUDGMENTS_SCHEMA_VERSION: i64 = 1;

pub const TASK_CATEGORIES: [&str; 7] = ["feature", "bugfix", "investigation", "refactor", "docs", "ops", "other"];

/// 判定を出したもの。opencode は今は選べないが、前に判定した judgments.json を読めるように残す
pub const BACKENDS: [&str; 4] = ["copilot-cli", "opencode", "anthropic", "external"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EffectScore {
    /// -2(逆効果)〜 +2(大いに役立った)。使われていなければ 0
    pub score: f64,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HumanEffort {
    pub hours: f64,
    pub low: f64,
    pub high: f64,
    pub confidence: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiOutcome {
    pub completed: bool,
    pub quality: f64,
    pub rework: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeMeta {
    pub backend: String,
    pub model: Option<String>,
    pub ran_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentItem {
    pub session_id: String,
    pub task_category: String,
    pub task_summary: String,
    pub human_effort: HumanEffort,
    pub ai_outcome: AiOutcome,
    pub instructions_effect: EffectScore,
    pub wiki_effect: EffectScore,
    pub skills_agents_effect: EffectScore,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// この項目を誰が判定したか(ツールが付ける。LLM の出力には不要)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<JudgeMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJudge {
    pub backend: String,
    pub model: Option<String>,
    pub ran_at: String,
    /// 判定自体のトークン消費(形は検証しない。TS 版と同じくそのまま持つ)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentsFile {
    pub schema_version: i64,
    /// 最後に書き込んだ判定の実行情報(項目ごとの出所は items[].judge)
    pub judge: FileJudge,
    pub items: Vec<JudgmentItem>,
    /// 判定に失敗したセッション(成功したら消える。形は検証しない)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failures: Option<Vec<Value>>,
}

/// 形の問題をまとめたエラー
#[derive(Debug, Clone, PartialEq)]
pub struct JudgmentValidationError {
    pub problems: Vec<String>,
    pub prefix: String,
}

impl JudgmentValidationError {
    pub fn new(problems: Vec<String>) -> Self {
        Self::with_prefix(problems, "judgments の形が正しくありません")
    }
    pub fn with_prefix(problems: Vec<String>, prefix: &str) -> Self {
        JudgmentValidationError { problems, prefix: prefix.to_string() }
    }
}

impl std::fmt::Display for JudgmentValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:\n- {}", self.prefix, self.problems.join("\n- "))
    }
}

impl std::error::Error for JudgmentValidationError {}

type Obj = Map<String, Value>;

/// 有限の数(typeof v === 'number' && Number.isFinite(v))
fn num(v: Option<&Value>) -> Option<f64> {
    js::num(v)
}

fn is_int(x: f64) -> bool {
    x.fract() == 0.0
}

fn is_str(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(_)))
}

/// `JSON.stringify(v)`(undefined は "undefined")
fn stringify(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => atlas_core::json::to_js_string(v).unwrap_or_default(),
    }
}

/// `${n}`(数の文字列。数でなければ String(v))
fn str_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_js_string)
}

fn check_effect(v: Option<&Value>, path: &str, p: &mut Vec<String>) {
    let Some(v) = v.and_then(Value::as_object) else {
        p.push(format!("{path} が無いか、{{ … }} の形ではありません"));
        return;
    };
    if !num(v.get("score")).is_some_and(|s| is_int(s) && (-2.0..=2.0).contains(&s)) {
        p.push(format!("{path}.score は -2〜2 の整数です({})", stringify(v.get("score"))));
    }
    if !is_str(v.get("evidence")) {
        p.push(format!("{path}.evidence は文字列です"));
    }
}

fn valid_judge(j: Option<&Value>) -> bool {
    j.and_then(Value::as_object).is_some_and(|j| j.get("backend").and_then(Value::as_str).is_some_and(|b| BACKENDS.contains(&b)) && is_str(j.get("ranAt")))
}

/// 1 項目を検証して問題点を返す(空なら妥当)
pub fn item_problems(v: &Value, path: &str) -> Vec<String> {
    let mut p = Vec::new();
    let Some(v) = v.as_object() else {
        return vec![format!("{path} が無いか、{{ … }} の形ではありません")];
    };
    if !v.get("sessionId").and_then(Value::as_str).is_some_and(|s| !js::trim(s).is_empty()) {
        p.push(format!("{path}.sessionId がありません"));
    }
    if !v.get("taskCategory").and_then(Value::as_str).is_some_and(|c| TASK_CATEGORIES.contains(&c)) {
        p.push(format!("{path}.taskCategory は {} のいずれかです({})", TASK_CATEGORIES.join(" / "), stringify(v.get("taskCategory"))));
    }
    if !v.get("taskSummary").and_then(Value::as_str).is_some_and(|s| !js::trim(s).is_empty()) {
        p.push(format!("{path}.taskSummary がありません"));
    }

    match v.get("humanEffort").and_then(Value::as_object) {
        None => p.push(format!("{path}.humanEffort が無いか、{{ … }} の形ではありません")),
        Some(h) => {
            for k in ["hours", "low", "high"] {
                if !num(h.get(k)).is_some_and(|x| x >= 0.0) {
                    p.push(format!("{path}.humanEffort.{k} は 0 以上の数値です({})", stringify(h.get(k))));
                }
            }
            if let (Some(hours), Some(low), Some(high)) = (num(h.get("hours")), num(h.get("low")), num(h.get("high")))
                && !(low <= hours && hours <= high)
            {
                p.push(format!(
                    "{path}.humanEffort は low ≤ hours ≤ high を満たす必要があります({} / {} / {})",
                    str_of(h.get("low")),
                    str_of(h.get("hours")),
                    str_of(h.get("high"))
                ));
            }
            if !num(h.get("confidence")).is_some_and(|c| (0.0..=1.0).contains(&c)) {
                p.push(format!("{path}.humanEffort.confidence は 0〜1 の数値です({})", stringify(h.get("confidence"))));
            }
            if !is_str(h.get("rationale")) {
                p.push(format!("{path}.humanEffort.rationale は文字列です"));
            }
        }
    }

    match v.get("aiOutcome").and_then(Value::as_object) {
        None => p.push(format!("{path}.aiOutcome が無いか、{{ … }} の形ではありません")),
        Some(a) => {
            if !matches!(a.get("completed"), Some(Value::Bool(_))) {
                p.push(format!("{path}.aiOutcome.completed は true / false です"));
            }
            if !num(a.get("quality")).is_some_and(|q| is_int(q) && (1.0..=5.0).contains(&q)) {
                p.push(format!("{path}.aiOutcome.quality は 1〜5 の整数です({})", stringify(a.get("quality"))));
            }
            if !num(a.get("rework")).is_some_and(|r| is_int(r) && (0.0..=5.0).contains(&r)) {
                p.push(format!("{path}.aiOutcome.rework は 0〜5 の整数です({})", stringify(a.get("rework"))));
            }
            if !is_str(a.get("rationale")) {
                p.push(format!("{path}.aiOutcome.rationale は文字列です"));
            }
        }
    }
    check_effect(v.get("instructionsEffect"), &format!("{path}.instructionsEffect"), &mut p);
    check_effect(v.get("wikiEffect"), &format!("{path}.wikiEffect"), &mut p);
    check_effect(v.get("skillsAgentsEffect"), &format!("{path}.skillsAgentsEffect"), &mut p);
    if v.get("notes").is_some_and(|n| !n.is_null() && !n.is_string()) {
        p.push(format!("{path}.notes は文字列です"));
    }
    if v.get("judge").is_some_and(|j| !valid_judge(Some(j))) {
        p.push(format!("{path}.judge は {{backend, model, ranAt}} です"));
    }
    p
}

fn effect(o: &Obj, k: &str) -> EffectScore {
    let e = &o[k];
    EffectScore { score: e["score"].as_f64().unwrap_or(0.0), evidence: e["evidence"].as_str().unwrap_or("").to_string() }
}

/// 1 項目を検証し、余分なキーを落とした正規形を返す。不正なら JudgmentValidationError
pub fn validate_judgment_item(v: &Value, path: &str) -> Result<JudgmentItem, JudgmentValidationError> {
    let p = item_problems(v, path);
    if !p.is_empty() {
        return Err(JudgmentValidationError::new(p));
    }
    let x = v.as_object().expect("item_problems で確かめた");
    let s = |o: &Value, k: &str| o[k].as_str().unwrap_or("").to_string();
    let f = |o: &Value, k: &str| o[k].as_f64().unwrap_or(0.0);
    let h = &x["humanEffort"];
    let a = &x["aiOutcome"];
    Ok(JudgmentItem {
        session_id: js::trim(x["sessionId"].as_str().unwrap_or("")).to_string(),
        task_category: s(v, "taskCategory"),
        task_summary: s(v, "taskSummary"),
        human_effort: HumanEffort { hours: f(h, "hours"), low: f(h, "low"), high: f(h, "high"), confidence: f(h, "confidence"), rationale: s(h, "rationale") },
        ai_outcome: AiOutcome { completed: a["completed"].as_bool().unwrap_or(false), quality: f(a, "quality"), rework: f(a, "rework"), rationale: s(a, "rationale") },
        instructions_effect: effect(x, "instructionsEffect"),
        wiki_effect: effect(x, "wikiEffect"),
        skills_agents_effect: effect(x, "skillsAgentsEffect"),
        notes: x.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string),
        // TS は `if (x.judge)`(真のときだけ)。検証済みなのでオブジェクト
        judge: x.get("judge").and_then(Value::as_object).map(|j| JudgeMeta {
            backend: j["backend"].as_str().unwrap_or("").to_string(),
            model: j.get("model").and_then(Value::as_str).map(str::to_string),
            ran_at: j["ranAt"].as_str().unwrap_or("").to_string(),
        }),
    })
}

/// judgments.json 全体を検証する。問題はまとめて報告する
pub fn validate_judgments(v: &Value) -> Result<JudgmentsFile, JudgmentValidationError> {
    let Some(o) = v.as_object() else {
        return Err(JudgmentValidationError::new(vec!["ルートがオブジェクトではありません".into()]));
    };
    let mut p: Vec<String> = Vec::new();
    if o.get("schemaVersion").and_then(Value::as_f64) != Some(JUDGMENTS_SCHEMA_VERSION as f64) {
        p.push(format!("schemaVersion が 1 ではありません({})", stringify(o.get("schemaVersion"))));
    }
    let j = o.get("judge");
    if !valid_judge(j) {
        p.push(format!("judge は {{backend: {}, model, ranAt}} です", BACKENDS.join("|")));
    }
    match o.get("items").and_then(Value::as_array) {
        None => p.push("items が配列ではありません".into()),
        Some(items) => {
            for (i, it) in items.iter().enumerate() {
                p.extend(item_problems(it, &format!("items[{i}]")));
            }
            let mut seen: HashSet<&str> = HashSet::new();
            for it in items {
                let Some(id) = it.get("sessionId").and_then(Value::as_str) else { continue };
                if !seen.insert(id) {
                    p.push(format!("sessionId {id} が重複しています"));
                }
            }
        }
    }
    if o.get("failures").is_some_and(|f| !f.is_array()) {
        p.push("failures が配列ではありません".into());
    }
    if !p.is_empty() {
        return Err(JudgmentValidationError::new(p));
    }
    let jj = j.and_then(Value::as_object).expect("valid_judge で確かめた");
    let items = o["items"].as_array().expect("確かめた").iter().enumerate().map(|(i, it)| validate_judgment_item(it, &format!("items[{i}]"))).collect::<Result<Vec<_>, _>>()?;
    Ok(JudgmentsFile {
        schema_version: 1,
        judge: FileJudge {
            backend: jj["backend"].as_str().unwrap_or("").to_string(),
            model: jj.get("model").and_then(Value::as_str).map(str::to_string),
            ran_at: jj["ranAt"].as_str().unwrap_or("").to_string(),
            usage: jj.get("usage").filter(|u| u.is_object()).cloned(),
        },
        items,
        failures: o.get("failures").and_then(Value::as_array).filter(|f| !f.is_empty()).cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str) -> Value {
        json!({
            "sessionId": id,
            "taskCategory": "feature",
            "taskSummary": "要約",
            "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
            "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
            "instructionsEffect": { "score": 1, "evidence": "e" },
            "wikiEffect": { "score": 0, "evidence": "参照なし" },
            "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
        })
    }

    #[test]
    fn validates_and_reports_all_problems() {
        let ok = json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": null, "ranAt": "2026-10-28T00:00:00Z" }, "items": [item("a"), item("b")] });
        assert_eq!(validate_judgments(&ok).unwrap().items.len(), 2);
        let mut op = ok.clone();
        op["judge"]["backend"] = json!("opencode");
        assert_eq!(validate_judgments(&op).unwrap().judge.backend, "opencode");
        let mut a1 = item("a");
        a1["humanEffort"] = json!({ "hours": 5, "low": 6, "high": 7, "confidence": 1.5, "rationale": "" });
        let mut a2 = item("a");
        a2["taskCategory"] = json!("nope");
        a2["aiOutcome"] = json!({ "completed": true, "quality": 9, "rework": 0, "rationale": "" });
        let mut bad = ok.clone();
        bad["items"] = json!([a1, a2]);
        let p = validate_judgments(&bad).unwrap_err().problems.join("\n");
        for w in ["low ≤ hours ≤ high を満たす必要があります(6 / 5 / 7)", "confidence", "taskCategory", "quality", "重複"] {
            assert!(p.contains(w), "{w}: {p}");
        }
        let mut v2 = ok.clone();
        v2["schemaVersion"] = json!(2);
        assert!(validate_judgments(&v2).unwrap_err().to_string().contains("schemaVersion"));
        // 正規形はキーの順を固定し、余分なキーを落とす
        let mut extra = item(" c ");
        extra["junk"] = json!(1);
        extra["notes"] = json!("");
        let it = validate_judgment_item(&extra, "item").unwrap();
        assert_eq!(it.session_id, "c");
        assert_eq!(it.notes, None);
    }
}
