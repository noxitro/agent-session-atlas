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

/// 一時ファイル(`<path>.<pid>.tmp`)に JSON を書いてから置き換える(途中で落ちても壊れたファイルを残さない)
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, v: &T) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, format!("{}\n", atlas_core::json::to_js_string_pretty(v)?))?;
    atlas_core::fs_retry::rename_replacing(&tmp, path)?;
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
    // 同じセッションは後から取り込んだもので置き換え、ほかのセッションの判定は残す)
    let (overwritten, total) = atlas_report::tasks::with_file_lock(judgments_path, || {
        let base = read_judgments(judgments_path)?.unwrap_or_else(|| empty_judgments("external", model.as_deref(), &now));
        let existing: HashSet<&str> = base.items.iter().map(|i| i.session_id.as_str()).collect();
        let overwritten = items.iter().filter(|i| existing.contains(i.session_id.as_str())).count();
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

/// 移した後の前の置き場の名前(<file>.moved。もう読まない。中身を確かめたいときのために消さずに残す)
pub fn moved_path(from: &Path) -> std::path::PathBuf {
    let mut s = from.as_os_str().to_owned();
    s.push(".moved");
    std::path::PathBuf::from(s)
}

/// 前の置き場(from。開いたフォルダの出力先)の判定を、共有の置き場(to。設定のフォルダ)に混ぜて移す。
/// 共有の側にあるセッションは共有の側のままにし、無いものだけを足す。移したら from は moved_path の名前に変える(次からは移さない)。
/// from が無ければ None、あれば足したセッションの数。from が読めなければエラー(何も書かず、from も残す)。
/// 読んで書くまでは to のロックの中で行う(ほかの集計する人の取り込みと重ならないように)
pub fn move_judgments_into(from: &Path, to: &Path) -> Result<Option<usize>> {
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
        // 判定に失敗した記録は、どちらにも判定の無いセッションのものだけを残す(共有の側の記録を先に)
        let judged: HashSet<&str> = merged.items.iter().map(|i| i.session_id.as_str()).collect();
        let failures: Vec<Value> = merged
            .failures
            .iter()
            .flatten()
            .chain(old.failures.iter().flatten())
            .filter(|f| !f.get("sessionId").and_then(Value::as_str).is_some_and(|id| judged.contains(id)))
            .cloned()
            .collect();
        merged.failures = (!failures.is_empty()).then_some(failures);
        write_judgments(to, &merged)?;
        atlas_core::fs_retry::rename_replacing(from, &moved_path(from))?;
        Ok(Some(add.len()))
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
        assert_eq!(move_judgments_into(&old, &shared).unwrap(), Some(1));
        let j = read_judgments(&shared).unwrap().unwrap();
        let mut ids: Vec<&str> = j.items.iter().map(|i| i.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(j.items.iter().find(|i| i.session_id == "a").unwrap().task_summary, "共有");
        assert!(!old.exists() && moved_path(&old).exists());
        assert_eq!(move_judgments_into(&old, &shared).unwrap(), None);
        // 共有の側がまだ無ければ、前の判定をそのまま移す
        let other = d.path().join("other").join("judgments.json");
        std::fs::rename(moved_path(&old), &old).unwrap();
        assert_eq!(move_judgments_into(&old, &other).unwrap(), Some(2));
        // 読めない前の判定は移さず、残す
        std::fs::write(&old, "{").unwrap();
        assert!(move_judgments_into(&old, &shared).is_err());
        assert!(old.exists());
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
