//! judgments.json の読み書き・外部判定の取り込み(packages/judge/src/judgments-io.ts の移植)。

use crate::schema::{empty_judgments, item_problems, items_from_candidates, json_candidates, merge_judgments, schema_version_for, validate_judgment_item, validate_judgments, wiki_pages_note, FileJudge, JudgeMeta, JudgmentItem, JudgmentValidationError, JudgmentsFile};
use anyhow::{anyhow, bail, Result};
use atlas_core::{jsdate, js};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// judgments.json を読んで検証する。無ければ None。JSON として読めない・形が違うときはエラー
pub fn read_judgments(path: &Path) -> Result<Option<JudgmentsFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let p = path.display();
    let bytes = std::fs::read(path).map_err(|e| anyhow!("{p} を JSON として読めません: {e}"))?;
    let raw = js::parse_json(&String::from_utf8_lossy(&bytes)).map_err(|e| anyhow!("{p} を JSON として読めません: {e}"))?;
    validate_judgments(&raw).map(Some).map_err(|e| anyhow!("{p}: {e}"))
}

/// 取り込みのロックの中で、今の判定のファイルが読めないとき(壊れた JSON・形の違い)の誤り。書き換えずに止め、
/// serve は 409 で返す(BrokenFile。タスクの紐づけのファイルと同じ)
pub fn broken_judgments(path: &Path, e: anyhow::Error) -> anyhow::Error {
    anyhow::Error::from(atlas_report::tasks::BrokenFile(format!(
        "判定のファイルが壊れています。{} を確かめてください(直すか、別の名前に変えてから取り込み直します。壊れたファイルは書き換えません。何も取り込んでいません。{e:#})",
        path.display()
    )))
}

/// 一時ファイル(タスクの状態と同じ `<path>.<pid>-<時刻>-<連番>.tmp`。tasks::tmp_path)に JSON を書いてから置き換える
/// (途中で落ちても壊れたファイルを残さない。共有の置き場で、同じ pid の別の PC のプロセスや同じプロセスの別のスレッドと一時ファイルが重ならない)
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, v: &T) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = atlas_report::tasks::tmp_path(path);
    std::fs::write(&tmp, format!("{}\n", atlas_core::json::to_js_string_pretty(v)?))?;
    if let Err(e) = atlas_core::fs_retry::rename_replacing(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// 一時ファイルに書いてから置き換える(途中で落ちても壊れたファイルを残さない)
/// 版は項目で決める(どの項目も wikiPages を持たない間は 1。前の版の atlas.exe でも読めるように)
pub fn write_judgments(path: &Path, j: &JudgmentsFile) -> Result<()> {
    let j = JudgmentsFile { schema_version: schema_version_for(&j.items), ..j.clone() };
    validate_judgments(&serde_json::to_value(&j)?)?;
    write_json_atomic(path, &j)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportResult {
    pub imported: usize,
    /// 取り込み元で同じ sessionId が複数回出た件数(後の方を採用)
    pub duplicates: usize,
    /// 既存の判定を上書きした件数
    pub overwritten: usize,
    /// known_ids に無い sessionId(レポートには出ない)
    pub unknown_ids: Vec<String>,
    pub total: usize,
    /// 取り込んだが、llm-wiki のページごとの判定(wikiPages)の形が崩れていて一部を捨てた項目の知らせ(「セッション <id>: …」)
    pub notes: Vec<String>,
}

#[derive(Default)]
pub struct ImportOptions<'a> {
    pub known_ids: Option<&'a HashSet<String>>,
    /// 取り込んだ時刻(ISO)。None なら今
    pub now: Option<String>,
    /// エラーで取り込み元を指す名前
    pub label: Option<String>,
}

/// 外部で作った判定(JSON、または JSON コードブロックを含む Markdown)を検証して judgments.json にマージする。
/// 1 件でも形が合わなければ何も書かずにエラー(部分的に取り込まない)。
pub fn import_judgments(file: &Path, judgments_path: &Path, o: ImportOptions<'_>) -> Result<ImportResult> {
    if !file.exists() {
        bail!("取り込むファイルがありません: {}", file.display());
    }
    let text = String::from_utf8_lossy(&std::fs::read(file)?).into_owned();
    import_judgments_text(&text, judgments_path, ImportOptions { label: Some(file.display().to_string()), ..o })
}

/// `{ ...it }`(配列は添字をキーにしたオブジェクトになる)。オブジェクトでなければそのまま
fn spread(it: &Value) -> Value {
    match it {
        Value::Array(a) => Value::Object(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
        other => other.clone(),
    }
}

/// import_judgments の本文版(atlas serve の画面に貼った返答)。label はエラーで取り込み元を指す名前
pub fn import_judgments_text(input: &str, judgments_path: &Path, o: ImportOptions<'_>) -> Result<ImportResult> {
    let file = o.label.clone().unwrap_or_else(|| "貼り付けた返答".into());
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let cands = json_candidates(text);
    if cands.is_empty() {
        bail!("{file} から JSON を取り出せません(JSON ファイルか、```json のコードブロックを含む Markdown を指定してください)");
    }
    let raw = items_from_candidates(&cands);
    if raw.is_empty() {
        bail!("{file} に判定項目(items)がありません");
    }

    let mut model: Option<String> = None;
    let mut ran_at: Option<String> = None;
    for c in &cands {
        let Some(j) = c.as_object().and_then(|c| c.get("judge")).and_then(Value::as_object) else { continue };
        if let Some(m) = j.get("model").and_then(Value::as_str).filter(|m| !m.is_empty())
            && model.is_none()
        {
            model = Some(m.to_string());
        }
        if let Some(r) = j.get("ranAt").and_then(Value::as_str).filter(|r| jsdate::parse_ms(r).is_some())
            && ran_at.is_none()
        {
            ran_at = Some(r.to_string());
        }
    }
    let now = o.now.clone().unwrap_or_else(jsdate::now_iso);
    // 返答の ranAt が取り込んだ時刻より後(LLM が書いた先の日時)なら、取り込んだ時刻にする(判定のぶれの「セッションの終わりより後」を、
    // 書き間違えた日時で通さないため)。そのときと、ranAt の無い返答は、日時を書いた返答とはみなさない(explicit_ran_at が false)
    let now_ms = jsdate::parse_ms(&now);
    let ran_at = ran_at.filter(|r| matches!((jsdate::parse_ms(r), now_ms), (Some(r), Some(n)) if r <= n));
    let explicit_ran_at = ran_at.is_some();
    let ran_at = ran_at.unwrap_or_else(|| now.clone());

    let mut problems: Vec<String> = Vec::new();
    for (i, it) in raw.iter().enumerate() {
        let mut x = spread(it);
        if let Some(m) = x.as_object_mut() {
            m.shift_remove("judge");
        }
        // 何件目かとセッション ID を添える(どの判定を直せばよいか、チャットに伝えられるように)
        let id = x.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty());
        let head = format!("{} 件目{}", i + 1, id.map(|id| format!("(セッション {id})")).unwrap_or_default());
        // item_problems の「<path>.humanEffort …」「<path> が…」を「1 件目(…)の humanEffort …」「1 件目(…)が…」にする
        for p in item_problems(&x, &head) {
            problems.push(p.replacen(&format!("{head}."), &format!("{head}の "), 1).replacen(&format!("{head} が"), &format!("{head}が"), 1));
        }
    }
    if !problems.is_empty() {
        return Err(JudgmentValidationError::with_prefix(problems, &format!("{file} の判定が judgments のスキーマに合いません(何も取り込んでいません)")).into());
    }

    let mut by: IndexMap<String, JudgmentItem> = IndexMap::new();
    let mut duplicates = 0;
    let mut notes: Vec<String> = Vec::new();
    for it in &raw {
        let mut x = spread(it);
        if let Some(m) = x.as_object_mut() {
            m.shift_remove("judge");
        }
        let mut v = validate_judgment_item(&x, "item")?;
        if let Some(n) = wiki_pages_note(&x) {
            notes.push(format!("セッション {}: {n}", v.session_id));
        }
        if by.contains_key(&v.session_id) {
            duplicates += 1;
        }
        v.judge = Some(JudgeMeta { backend: "external".into(), model: model.clone(), ran_at: ran_at.clone() });
        by.insert(v.session_id.clone(), v);
    }
    let items: Vec<JudgmentItem> = by.into_values().collect();
    // 読み直してから混ぜて書くまでを、ファイルのロックの中で行う(共有の置き場では、ほかの集計する人も同じファイルに取り込むため。
    // 同じセッションは後から取り込んだもので置き換え、ほかのセッションの判定は残す)。
    // 置き換える前の判定は、判定の履歴(judgments-history.json。history_path)に足してから本体を書く(判定のぶれを測るため)。
    // 履歴は、本体のロックの中で、履歴のロック(<履歴>.lock)も取って書く。2 つのロックはいつも本体 → 履歴の順に取る
    // (履歴のロックの印で、共有のフォルダで別の PC が作った直後の履歴を「無い」と見て、空から書き直さない。tasks::with_file_lock)。
    // 履歴を先に書くので、本体を書く前に落ちても前の判定は残る(取り込み直すと、同じものは足さない)
    let history = history_path(judgments_path);
    let (overwritten, total) = atlas_report::tasks::with_file_lock(judgments_path, || {
        let base = read_judgments(judgments_path).map_err(|e| broken_judgments(judgments_path, e))?.unwrap_or_else(|| empty_judgments("external", model.as_deref(), &now));
        let existing: HashSet<&str> = base.items.iter().map(|i| i.session_id.as_str()).collect();
        let overwritten = items.iter().filter(|i| existing.contains(i.session_id.as_str())).count();
        // 置き換えるものが無ければ、履歴のロックも取らない(履歴を使わない人の置き場に .lock を増やさない)
        if items.iter().any(|n| base.items.iter().any(|o| o.session_id == n.session_id && is_new_judgment(o, n, explicit_ran_at))) {
            atlas_report::tasks::with_file_lock(&history, || append_history(&history, &base.items, &items, &now, explicit_ran_at))?;
        }
        let merged = merge_judgments(&base, &items, FileJudge { backend: "external".into(), model: model.clone(), ran_at: now.clone(), usage: None });
        write_judgments(judgments_path, &merged)?;
        Ok((overwritten, merged.items.len()))
    })?;
    Ok(ImportResult {
        imported: items.len(),
        duplicates,
        overwritten,
        unknown_ids: o.known_ids.map(|k| items.iter().map(|i| i.session_id.clone()).filter(|id| !k.contains(id)).collect()).unwrap_or_default(),
        total,
        notes,
    })
}

// ---------- 判定の履歴(判定のぶれ) ----------

/// 判定の履歴の版
pub const HISTORY_SCHEMA_VERSION: i64 = 1;

/// 置き換えた判定 1 件(置き換える前の項目をそのまま。judge の ranAt・model も入る)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// 置き換えた時刻(取り込んだ時刻。ISO)
    pub replaced_at: String,
    pub item: JudgmentItem,
}

/// 判定の履歴(judgments-history.json)。取り込みで同じセッションの判定を置き換えたとき、前の判定を足していく。
/// judgments.json とは別のファイルにする(前の版の atlas.exe が judgments.json を読めるように、そちらには項目を足さない)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFile {
    pub schema_version: i64,
    pub items: Vec<HistoryEntry>,
}

/// 判定の履歴の場所: 工数の判定のファイルの隣の `<名前>-history.json`(judgments.json なら judgments-history.json)。
/// 判定のファイルの場所(Paths::judgments。設定のフォルダ・--judgments)に従う
pub fn history_path(judgments: &Path) -> std::path::PathBuf {
    let stem = judgments.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "judgments".into());
    judgments.with_file_name(format!("{stem}-history.json"))
}

/// 判定の履歴を読む。無ければ None。読めない・形が違うときはエラー
pub fn read_history(path: &Path) -> Result<Option<HistoryFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let p = path.display();
    let bytes = std::fs::read(path).map_err(|e| anyhow!("{p} を読めません: {e}"))?;
    let v = js::parse_json(&String::from_utf8_lossy(&bytes)).map_err(|e| anyhow!("{p} を JSON として読めません: {e}"))?;
    if v.get("schemaVersion").and_then(Value::as_f64) != Some(HISTORY_SCHEMA_VERSION as f64) {
        bail!("{p} の schemaVersion が {HISTORY_SCHEMA_VERSION} ではありません");
    }
    serde_json::from_value(v).map(Some).map_err(|e| anyhow!("{p} の形が正しくありません: {e}"))
}

/// 判定の中身が同じか(誰がいつ判定したか judge は見ない)
fn same_content(a: &JudgmentItem, b: &JudgmentItem) -> bool {
    JudgmentItem { judge: None, ..a.clone() } == JudgmentItem { judge: None, ..b.clone() }
}

/// 取り込む判定(new)を、前の判定(old)とは別の新しい判定とみなすか: 中身が違うか、返答に日時(ranAt)が書いてあって前の判定の日時と違う。
/// 返答に日時が無く(取り込んだ時刻で代えた)中身が同じものは、同じ返答の取り込み直しとみなす(判定し直したのか見分けられないため)。
/// 中身が同じで日時の違う判定し直しも数える(完全に一致した組を落とすと、一致の割合が低い方に偏るため)
fn is_new_judgment(old: &JudgmentItem, new: &JudgmentItem, explicit_ran_at: bool) -> bool {
    if !same_content(old, new) {
        return true;
    }
    explicit_ran_at && old.judge.as_ref().map(|j| j.ran_at.as_str()) != new.judge.as_ref().map(|j| j.ran_at.as_str())
}

/// 取り込む項目(incoming)が置き換える前の判定(base にある同じセッションのもの)を、判定の履歴に足す。足すものが無ければ書かない。
/// 足さないもの: 新しい判定とみなさないもの(is_new_judgment。日時の無い返答で中身が同じ = 同じ返答の取り込み直し。
/// 日時も中身も同じ返答の取り込み直し)と、履歴にもうある同じもの(同じ ranAt・同じ中身。本体を書く前に落ちて、取り込み直したときなど)。
/// 履歴が読めなければエラー(壊れたファイルは書き換えない。何も取り込まない)。呼ぶのは本体と履歴のロックの中
fn append_history(path: &Path, base: &[JudgmentItem], incoming: &[JudgmentItem], now: &str, explicit_ran_at: bool) -> Result<()> {
    let old: std::collections::HashMap<&str, &JudgmentItem> = base.iter().map(|i| (i.session_id.as_str(), i)).collect();
    let replaced: Vec<&JudgmentItem> = incoming.iter().filter_map(|n| old.get(n.session_id.as_str()).copied().filter(|o| is_new_judgment(o, n, explicit_ran_at))).collect();
    if replaced.is_empty() {
        return Ok(());
    }
    let mut file = read_history(path)
        .map_err(|e| anyhow::Error::from(atlas_report::tasks::BrokenFile(format!("判定の履歴が壊れています。{} を確かめてください(直すか、別の名前に変えてから取り込み直します。壊れたファイルは書き換えません。何も取り込んでいません。{e:#})", path.display()))))?
        .unwrap_or(HistoryFile { schema_version: HISTORY_SCHEMA_VERSION, items: vec![] });
    let before = file.items.len();
    for o in replaced {
        if !file.items.iter().any(|h| h.item == *o) {
            file.items.push(HistoryEntry { replaced_at: now.to_string(), item: o.clone() });
        }
    }
    if file.items.len() == before {
        return Ok(());
    }
    write_json_atomic(path, &file)
}

/// 移した後の前の置き場の名前(<file>.moved-<時刻>。もう読まない。中身を確かめたいときのために消さずに残す)。
/// 前に移したもの(同じ出力先で設定のフォルダを外して作り直し、また移したときなど)を上書きしないよう、時刻を付け、それでも重なれば -2, -3 … を足す
pub fn moved_path(from: &Path) -> std::path::PathBuf {
    let stamp: String = atlas_core::jsdate::now_iso().chars().filter(|c| c.is_ascii_alphanumeric()).take(15).collect();
    let name = |n: usize| {
        let mut s = from.as_os_str().to_owned();
        s.push(if n < 2 { format!(".moved-{stamp}") } else { format!(".moved-{stamp}-{n}") });
        std::path::PathBuf::from(s)
    };
    (1..).map(name).find(|p| !p.exists()).expect("空いた名前がある")
}

/// 前の置き場から移した結果
#[derive(Debug, Clone, PartialEq)]
pub struct Moved {
    /// 足したもの(セッション。依頼ごとの判定は依頼)の数
    pub added: usize,
    /// 前のファイルの新しい名前(moved_path)
    pub renamed_to: std::path::PathBuf,
}

/// 前の置き場(from。開いたフォルダの出力先)の判定を、共有の置き場(to。設定のフォルダ)に混ぜて移す。
/// 共有の側にあるセッションは共有の側のままにし、無いものだけを足す。移したら from は moved_path の名前に変える(次からは移さない)。
/// from が無ければ None、あれば足したセッションの数と、前のファイルの新しい名前。from が読めなければエラー(何も書かず、from も残す)。
/// 判定に失敗した記録(failures)は、どちらにも判定の無いセッションのものを、セッションごとに 1 つだけ残す(共有の側を先に)。
/// 読んで書くまでは to のロックの中で行う(ほかの集計する人の取り込みと重ならないように)
pub fn move_judgments_into(from: &Path, to: &Path) -> Result<Option<Moved>> {
    if !from.exists() {
        return Ok(None);
    }
    atlas_report::tasks::with_file_lock(to, || {
        let Some(old) = read_judgments(from)? else { return Ok(None) };
        let cur = read_judgments(to)?;
        let have: HashSet<String> = cur.as_ref().map(|c| c.items.iter().map(|i| i.session_id.clone()).collect()).unwrap_or_default();
        let add: Vec<JudgmentItem> = old.items.iter().filter(|i| !have.contains(&i.session_id)).cloned().collect();
        let mut merged = cur.unwrap_or_else(|| JudgmentsFile { failures: None, items: vec![], ..old.clone() });
        merged.items.extend(add.iter().cloned());
        // 判定に失敗した記録は、どちらにも判定の無いセッションのものだけを残す(共有の側の記録を先に)。
        // 同じセッションの記録が両方にあれば先の 1 つだけ(セッション ID の無い記録は、同じ中身のものを 1 つに)
        let judged: HashSet<&str> = merged.items.iter().map(|i| i.session_id.as_str()).collect();
        let mut seen: HashSet<String> = HashSet::new();
        let mut failures: Vec<Value> = Vec::new();
        for f in merged.failures.iter().flatten().chain(old.failures.iter().flatten()) {
            let id = f.get("sessionId").and_then(Value::as_str);
            if id.is_some_and(|id| judged.contains(id)) {
                continue;
            }
            let key = id.map_or_else(|| format!("\u{0}{f}"), str::to_string);
            if seen.insert(key) {
                failures.push(f.clone());
            }
        }
        merged.failures = (!failures.is_empty()).then_some(failures);
        write_judgments(to, &merged)?;
        let renamed_to = moved_path(from);
        atlas_core::fs_retry::rename_replacing(from, &renamed_to)?;
        Ok(Some(Moved { added: add.len(), renamed_to }))
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
    fn imports_markdown_and_overwrites_by_session() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let md = d.path().join("reply.md");
        let mut b2 = item("b");
        b2["taskSummary"] = json!("後");
        let whole = json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": "m365", "ranAt": "2026-10-01T00:00:00Z" }, "items": [item("a"), item("b")] });
        std::fs::write(&md, format!("回答:\n```json\n{}\n```\n追加:\n```json\n{}\n```", whole, b2)).unwrap();
        let known: HashSet<String> = ["a".to_string()].into_iter().collect();
        let r = import_judgments(&md, &jp, ImportOptions { known_ids: Some(&known), ..Default::default() }).unwrap();
        assert_eq!(r, ImportResult { imported: 2, duplicates: 1, overwritten: 0, unknown_ids: vec!["b".into()], total: 2, notes: vec![] });
        let j = read_judgments(&jp).unwrap().unwrap();
        assert_eq!(j.judge.backend, "external");
        assert_eq!(j.items.iter().find(|i| i.session_id == "b").unwrap().task_summary, "後");
        assert_eq!(j.items[0].judge, Some(JudgeMeta { backend: "external".into(), model: Some("m365".into()), ran_at: "2026-10-01T00:00:00Z".into() }));

        // 1 件でも壊れていれば何も書かない
        let before = std::fs::read(&jp).unwrap();
        let bad = d.path().join("bad.json");
        let mut a2 = item("a");
        a2["taskSummary"] = json!("変更");
        std::fs::write(&bad, json!([a2, { "sessionId": "z" }]).to_string()).unwrap();
        let e = import_judgments(&bad, &jp, ImportOptions::default()).unwrap_err();
        assert!(e.to_string().contains("何も取り込んでいません"), "{e}");
        let v = e.downcast_ref::<JudgmentValidationError>().unwrap();
        assert!(v.problems.iter().any(|p| p.starts_with("2 件目(セッション z)の taskCategory")), "{:?}", v.problems);
        assert_eq!(std::fs::read(&jp).unwrap(), before);
        assert!(import_judgments(&d.path().join("none.json"), &jp, ImportOptions::default()).unwrap_err().to_string().contains("ありません"));
        // 本文版(画面に貼った返答): 先頭の BOM を許し、エラーは取り込み元を「貼り付けた返答」と呼ぶ
        let r = import_judgments_text(&format!("\u{feff}{}", json!([item("c")])), &jp, ImportOptions::default()).unwrap();
        assert_eq!((r.imported, r.total), (1, 3));
        assert!(import_judgments_text("説明だけ", &jp, ImportOptions::default()).unwrap_err().to_string().starts_with("貼り付けた返答 から JSON を取り出せません"));
        let e = import_judgments_text("[1]", &jp, ImportOptions::default()).unwrap_err();
        assert!(e.downcast_ref::<JudgmentValidationError>().unwrap().problems[0].starts_with("1 件目が無いか"), "{e}");
    }

    /// 返答 1 つ(ranAt つき)
    fn reply(ran_at: &str, items: Vec<Value>) -> String {
        json!({ "judge": { "model": "m-a", "ranAt": ran_at }, "items": items }).to_string()
    }

    /// 判定の履歴: 同じセッションを置き換えたら、前の判定(judge の ranAt・model つき)を隣の <名前>-history.json に足す。
    /// 同じ返答の取り込み直し(日時も中身も同じ・日時の無い返答で中身が同じ)と、履歴にもうあるもの(同じ ranAt・同じ中身)は足さない
    #[test]
    fn replaced_judgments_go_to_the_history() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let hp = history_path(&jp);
        assert_eq!(hp, d.path().join("judgments-history.json"));
        assert_eq!(history_path(&d.path().join("mine.json")), d.path().join("mine-history.json"));
        let opts = || ImportOptions { now: Some("2026-11-25T00:00:00.000Z".into()), ..Default::default() };
        // 初めての判定は置き換えないので、履歴を作らない
        import_judgments_text(&reply("2026-11-20T00:00:00Z", vec![item("a"), item("b")]), &jp, opts()).unwrap();
        assert!(!hp.exists());
        // 同じ返答(日時も中身も同じ)を取り込み直しても、判定し直したのではないので足さない(履歴のロックも取らない)
        let r = import_judgments_text(&reply("2026-11-20T00:00:00Z", vec![item("a")]), &jp, opts()).unwrap();
        assert_eq!(r.overwritten, 1);
        assert!(!hp.exists());
        assert!(!atlas_report::tasks::lock_path(&hp).exists());
        // 日時の無い返答で中身が同じものも、取り込み直しとみなして足さない(本体の日時は取り込んだ時刻になる)
        import_judgments_text(&json!([item("b")]).to_string(), &jp, opts()).unwrap();
        assert!(!hp.exists());
        // 中身が同じでも、返答に別の日時が書いてあれば判定し直したものとして足す(完全に一致した組を落とさない)
        import_judgments_text(&reply("2026-11-21T00:00:00Z", vec![item("a")]), &jp, opts()).unwrap();
        let h = read_history(&hp).unwrap().unwrap();
        assert_eq!(h.items.len(), 1);
        assert_eq!(h.items[0].item.judge.as_ref().map(|j| j.ran_at.as_str()), Some("2026-11-20T00:00:00Z"));
        // 中身の違う判定で置き換えると、前の判定を足す(前の ranAt とモデルのまま)
        let mut a2 = item("a");
        a2["humanEffort"]["hours"] = json!(3);
        import_judgments_text(&json!({ "judge": { "model": "m-b", "ranAt": "2026-11-22T00:00:00Z" }, "items": [a2] }).to_string(), &jp, opts()).unwrap();
        let h = read_history(&hp).unwrap().unwrap();
        assert_eq!(h.schema_version, HISTORY_SCHEMA_VERSION);
        assert_eq!(h.items.len(), 2);
        let h = HistoryFile { items: h.items[1..].to_vec(), ..h };
        assert_eq!(h.items[0].replaced_at, "2026-11-25T00:00:00.000Z");
        assert_eq!(h.items[0].item.session_id, "a");
        assert_eq!(h.items[0].item.human_effort.hours, 2.0);
        // 日時を書いて判定し直したときの判定(ranAt 11/21)が履歴に入る
        assert_eq!(h.items[0].item.judge, Some(JudgeMeta { backend: "external".into(), model: Some("m-a".into()), ran_at: "2026-11-21T00:00:00Z".into() }));
        let cur = read_judgments(&jp).unwrap().unwrap();
        assert_eq!(cur.items.iter().find(|i| i.session_id == "a").unwrap().human_effort.hours, 3.0);
        // 本体は前の版と同じ形(履歴の項目を足さない)
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&jp).unwrap()).unwrap();
        assert_eq!(raw.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["schemaVersion", "judge", "items"]);
        // もう 1 度判定し直すと、その前の判定も足す(古い順)
        let mut a3 = item("a");
        a3["humanEffort"]["hours"] = json!(3.5);
        import_judgments_text(&reply("2026-11-23T00:00:00Z", vec![a3]), &jp, opts()).unwrap();
        let h = read_history(&hp).unwrap().unwrap();
        assert_eq!(h.items.iter().map(|e| e.item.human_effort.hours).collect::<Vec<_>>(), [2.0, 2.0, 3.0]);
        // 書き込みの一時ファイルは残らない
        let left: Vec<String> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect();
        assert!(left.is_empty(), "{left:?}");
        // 履歴もロック(<履歴>.lock)の中で書く
        assert!(atlas_report::tasks::lock_path(&hp).is_file());
        assert!(atlas_report::tasks::lock_path(&jp).is_file());
    }

    /// 返答の日時が取り込んだ時刻より後(LLM が先の日時を書いた)なら、取り込んだ時刻にする。そのときは日時を書いた返答とみなさない
    /// (中身が同じなら取り込み直しとして、履歴に足さない)
    #[test]
    fn future_ran_at_is_clamped_to_the_import_time() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let hp = history_path(&jp);
        let now = "2026-11-25T00:00:00.000Z";
        let opts = || ImportOptions { now: Some(now.into()), ..Default::default() };
        import_judgments_text(&reply("2027-01-01T00:00:00Z", vec![item("a")]), &jp, opts()).unwrap();
        let j = read_judgments(&jp).unwrap().unwrap();
        assert_eq!(j.items[0].judge.as_ref().map(|m| m.ran_at.as_str()), Some(now));
        // 取り込んだ時刻ちょうどは、そのまま使う
        let mut a2 = item("a");
        a2["taskSummary"] = json!("後");
        import_judgments_text(&reply(now, vec![a2.clone()]), &jp, opts()).unwrap();
        assert_eq!(read_judgments(&jp).unwrap().unwrap().items[0].judge.as_ref().map(|m| m.ran_at.as_str()), Some(now));
        // 先の日時で中身が同じ返答は、取り込み直しとみなして足さない(履歴は中身の違った 1 件だけ)
        import_judgments_text(&reply("2027-02-01T00:00:00Z", vec![a2]), &jp, ImportOptions { now: Some("2026-11-26T00:00:00.000Z".into()), ..Default::default() }).unwrap();
        assert_eq!(read_history(&hp).unwrap().unwrap().items.len(), 1);
    }

    /// 履歴を先に書いてから本体を書く: 本体を書く前に落ちても前の判定は履歴に残り、取り込み直しても同じものを 2 つにしない
    #[test]
    fn history_is_written_before_the_main_file_and_not_duplicated() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let hp = history_path(&jp);
        import_judgments_text(&reply("2026-11-20T00:00:00Z", vec![item("a")]), &jp, ImportOptions::default()).unwrap();
        let mut a2 = item("a");
        a2["taskSummary"] = json!("判定し直し");
        let again = reply("2026-11-22T00:00:00Z", vec![a2]);
        // 本体を書く前に落ちたとき: 履歴は書いたが、本体は前のまま(append_history だけを呼んで再現する)
        let base = read_judgments(&jp).unwrap().unwrap();
        let mut incoming = base.items.clone();
        incoming[0].task_summary = "判定し直し".into();
        append_history(&hp, &base.items, &incoming, "2026-11-22T00:00:01.000Z", true).unwrap();
        assert_eq!(read_judgments(&jp).unwrap().unwrap(), base);
        assert_eq!(read_history(&hp).unwrap().unwrap().items.len(), 1);
        // 取り込み直すと本体が置き換わり、履歴は 1 件のまま(同じ ranAt・同じ中身は足さない)
        import_judgments_text(&again, &jp, ImportOptions::default()).unwrap();
        let h = read_history(&hp).unwrap().unwrap();
        assert_eq!(h.items.len(), 1);
        assert_eq!(h.items[0].item, base.items[0]);
        assert_eq!(read_judgments(&jp).unwrap().unwrap().items[0].task_summary, "判定し直し");

        // 壊れた履歴は書き換えず、本体も変えない(BrokenFile。serve は 409)
        std::fs::write(&hp, "{").unwrap();
        let before = std::fs::read(&jp).unwrap();
        let mut a3 = item("a");
        a3["taskSummary"] = json!("3 回目");
        let e = import_judgments_text(&reply("2026-11-24T00:00:00Z", vec![a3]), &jp, ImportOptions::default()).unwrap_err();
        assert!(e.downcast_ref::<atlas_report::tasks::BrokenFile>().is_some(), "{e:#}");
        assert!(e.to_string().contains("判定の履歴が壊れています"), "{e}");
        assert_eq!(std::fs::read(&jp).unwrap(), before);
        assert_eq!(std::fs::read_to_string(&hp).unwrap(), "{");
        // 置き換えない取り込み(新しいセッションだけ)は、履歴を読まないので止まらない
        import_judgments_text(&reply("2026-11-24T00:00:00Z", vec![item("z")]), &jp, ImportOptions::default()).unwrap();
    }

    /// 本体のロックを別の書き手が持っている間は、履歴も本体も書かない(待ちきれなければ LockBusy)。
    /// ロックは本体 → 履歴の順に取るので、履歴のロックだけを持つ書き手がいても、本体のロックを取ったまま待つだけで、取り合いにならない
    #[test]
    fn history_waits_for_the_main_lock() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let hp = history_path(&jp);
        import_judgments_text(&reply("2026-11-20T00:00:00Z", vec![item("a")]), &jp, ImportOptions::default()).unwrap();
        let mut a2 = item("a");
        a2["taskSummary"] = json!("後");
        let text = reply("2026-11-22T00:00:00Z", vec![a2]);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|s| {
            let holder = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(atlas_report::tasks::lock_path(&hp)).unwrap();
            holder.lock().unwrap();
            let h = s.spawn(|| {
                let r = import_judgments_text(&text, &jp, ImportOptions::default());
                tx.send(()).unwrap();
                r
            });
            // 履歴のロックを持っている間は、取り込みは終わらない(本体もまだ前のまま)
            assert!(rx.recv_timeout(std::time::Duration::from_millis(300)).is_err());
            assert_eq!(read_judgments(&jp).unwrap().unwrap().items[0].task_summary, "要約");
            holder.unlock().unwrap();
            h.join().unwrap().unwrap();
        });
        assert_eq!(read_history(&hp).unwrap().unwrap().items.len(), 1);
        assert_eq!(read_judgments(&jp).unwrap().unwrap().items[0].task_summary, "後");
    }

    /// 共有の置き場へ移す: 共有の側にあるセッションはそのまま、無いものだけ足し、前のファイルは .moved にする。2 回目は何もしない
    #[test]
    fn moves_old_judgments_into_shared() {
        let d = tempfile::tempdir().unwrap();
        let (old, shared) = (d.path().join("out").join("judgments.json"), d.path().join("AtlasSettings").join("judgments.json"));
        assert_eq!(move_judgments_into(&old, &shared).unwrap(), None);
        let mut a_old = item("a");
        a_old["taskSummary"] = json!("前の出力先");
        import_judgments_text(&json!([a_old, item("b")]).to_string(), &old, ImportOptions::default()).unwrap();
        let mut a_new = item("a");
        a_new["taskSummary"] = json!("共有");
        import_judgments_text(&json!([a_new, item("c")]).to_string(), &shared, ImportOptions::default()).unwrap();
        let m = move_judgments_into(&old, &shared).unwrap().unwrap();
        assert_eq!(m.added, 1);
        let j = read_judgments(&shared).unwrap().unwrap();
        let mut ids: Vec<&str> = j.items.iter().map(|i| i.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(j.items.iter().find(|i| i.session_id == "a").unwrap().task_summary, "共有");
        assert!(!old.exists() && m.renamed_to.exists());
        let name = m.renamed_to.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("judgments.json.moved-") && name.len() > "judgments.json.moved-".len(), "{name}");
        assert_eq!(move_judgments_into(&old, &shared).unwrap(), None);
        // 共有の側がまだ無ければ、前の判定をそのまま移す。前に移したファイルは上書きしない(別の名前にする)
        let other = d.path().join("other").join("judgments.json");
        std::fs::copy(&m.renamed_to, &old).unwrap();
        let m2 = move_judgments_into(&old, &other).unwrap().unwrap();
        assert_eq!(m2.added, 2);
        assert_ne!(m2.renamed_to, m.renamed_to);
        assert!(m.renamed_to.exists() && m2.renamed_to.exists());
        // 読めない前の判定は移さず、残す
        std::fs::write(&old, "{").unwrap();
        assert!(move_judgments_into(&old, &shared).is_err());
        assert!(old.exists());
    }

    /// 判定に失敗した記録は、移すときにセッションごとに 1 つにする(共有の側を先に。判定のあるセッションの記録は捨てる)
    #[test]
    fn move_dedups_failures_by_session() {
        let d = tempfile::tempdir().unwrap();
        let (old, shared) = (d.path().join("out").join("judgments.json"), d.path().join("s").join("judgments.json"));
        import_judgments_text(&json!([item("a")]).to_string(), &old, ImportOptions::default()).unwrap();
        import_judgments_text(&json!([item("b")]).to_string(), &shared, ImportOptions::default()).unwrap();
        let add_failures = |p: &Path, fs: Value| {
            let mut v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
            v["failures"] = fs;
            std::fs::write(p, v.to_string()).unwrap();
        };
        add_failures(&shared, json!([{ "sessionId": "x", "error": "共有" }, { "sessionId": "x", "error": "共有の 2 つ目" }, { "error": "ID なし" }]));
        add_failures(&old, json!([{ "sessionId": "x", "error": "前" }, { "sessionId": "y", "error": "前" }, { "sessionId": "b", "error": "判定あり" }, { "error": "ID なし" }]));
        move_judgments_into(&old, &shared).unwrap().unwrap();
        let j = read_judgments(&shared).unwrap().unwrap();
        assert_eq!(j.failures.unwrap(), vec![json!({ "sessionId": "x", "error": "共有" }), json!({ "error": "ID なし" }), json!({ "sessionId": "y", "error": "前" })]);
    }

    /// 書き込みの一時ファイルは、タスクの状態と同じ名前の付け方(pid・時刻・連番)で、書いた後は残らない
    #[test]
    fn writes_through_a_unique_temporary_file() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let (a, b) = (atlas_report::tasks::tmp_path(&jp), atlas_report::tasks::tmp_path(&jp));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains(&format!("judgments.json.{}-", std::process::id())));
        import_judgments_text(&json!([item("a")]).to_string(), &jp, ImportOptions::default()).unwrap();
        let left: Vec<String> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    // llm-wiki のページごとの判定: 版 1 の返答も版 2 の返答も取り込む。wikiPages が壊れていても項目は取り込み、知らせる
    #[test]
    fn imports_wiki_pages_leniently() {
        let d = tempfile::tempdir().unwrap();
        let jp = d.path().join("judgments.json");
        let mut ok = item("a");
        ok["wikiPages"] = json!([{ "page": "wiki/a.md", "helpful": "yes", "reason": "使った" }]);
        let mut bad = item("b");
        bad["wikiPages"] = json!("壊れた");
        let v1 = json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": "m365", "ranAt": "2026-10-01T00:00:00Z" }, "items": [ok, bad, item("c")] });
        let r = import_judgments_text(&format!("```json\n{v1}\n```"), &jp, ImportOptions::default()).unwrap();
        assert_eq!(r.imported, 3);
        assert_eq!(r.notes.len(), 1);
        assert!(r.notes[0].starts_with("セッション b: wikiPages が配列ではない"), "{:?}", r.notes);
        let j = read_judgments(&jp).unwrap().unwrap();
        assert_eq!(j.schema_version, 2);
        let by = |id: &str| j.items.iter().find(|i| i.session_id == id).unwrap().wiki_pages.clone();
        assert_eq!(by("a").unwrap()[0].helpful, "yes");
        assert_eq!(by("b"), None);
        assert_eq!(by("c"), None);

        // wikiPages を持つ項目が無い間は版 1 で書く(前の版の atlas.exe でも読める)
        let jp1 = d.path().join("v1.json");
        import_judgments_text(&json!([item("x")]).to_string(), &jp1, ImportOptions::default()).unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&jp1).unwrap()).unwrap();
        assert_eq!(raw["schemaVersion"], json!(1));
    }
}
