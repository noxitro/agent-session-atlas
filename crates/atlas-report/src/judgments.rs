//! judgments.json(Phase 3 の judge が出す判定結果)の読み取り口。packages/report/src/lib/judgments.ts の移植。
//! レポートに要る項目だけを拾う。report は judge に依存しないので、ここでは表示に必要な最低限を検査し、
//! 形が合わない項目は捨てずにエラーにする(黙って欠損させない)。
//! ただし llm-wiki のページごとの判定(wikiPages)だけは、壊れていても項目を捨てずに、そのページを未判定として読む
//! (判定の指示でそう決めてある。docs/judge.md)。

use crate::types::{JudgmentEffects, JudgmentSummary, WikiPageVerdict};
use anyhow::{bail, Result};
use indexmap::IndexMap;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct JudgmentsIndex {
    pub backend: Option<String>,
    pub model: Option<String>,
    pub ran_at: Option<String>,
    pub by_session: IndexMap<String, JudgmentSummary>,
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

/// `v && typeof v === 'object' ? v : {}`(配列はキーを持たないものとして扱う)
fn obj(v: Option<&Value>) -> &Map<String, Value> {
    v.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// `String(v)`(undefined は "undefined")
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => atlas_core::js::to_js_string(v),
    }
}

/// 読める judgments.json のスキーマの版(1: wikiPages の無い版。2: llm-wiki のページごとの判定 wikiPages を足した版)
pub const JUDGMENTS_SCHEMA_VERSIONS: [f64; 2] = [1.0, 2.0];

/// llm-wiki のページごとの「役立ったか」の値
pub const WIKI_HELPFUL: [&str; 3] = ["yes", "no", "unknown"];

/// wikiPages を読む。配列でなければ None(そのセッションのページはすべて未判定)。形の合わない要素と、同じページの 2 回目以降は捨てる。
/// 返すのは [ページ, 見立て, 理由](理由が無ければ空)
pub fn parse_wiki_pages(v: Option<&Value>) -> Option<Vec<WikiPageVerdict>> {
    let list = v?.as_array()?;
    let mut pages: Vec<WikiPageVerdict> = Vec::new();
    for x in list {
        let o = obj(Some(x));
        let Some(page) = o.get("page").and_then(Value::as_str).map(atlas_core::js::trim).filter(|p| !p.is_empty()) else { continue };
        let Some(helpful) = o.get("helpful").and_then(Value::as_str).filter(|h| WIKI_HELPFUL.contains(h)) else { continue };
        if pages.iter().any(|(p, _, _)| p == page) {
            continue;
        }
        pages.push((page.to_string(), helpful.to_string(), o.get("reason").and_then(Value::as_str).unwrap_or("").to_string()));
    }
    Some(pages)
}

/// セッションの判定から、判定のパケットに載せたページ(atlas_core::wiki::judged_wiki_pages)の判定だけを残す。
/// パケットに無いページの名前を LLM が返したら捨てる(packages/report/src/lib/summarize.ts の judgmentForSession と同じ)
pub fn judgment_for_session(j: &JudgmentSummary, page_reads: &[String]) -> JudgmentSummary {
    let Some(list) = &j.wiki_page_verdicts else { return j.clone() };
    let (judged, _) = atlas_core::wiki::judged_wiki_pages(page_reads);
    let kept = list.iter().filter(|v| judged.contains(&v.0)).cloned().collect();
    JudgmentSummary { wiki_page_verdicts: Some(kept), ..j.clone() }
}

pub fn parse_judgments(raw: &Value) -> Result<JudgmentsIndex> {
    let truthy_obj = matches!(raw, Value::Object(_) | Value::Array(_));
    if !truthy_obj {
        bail!("judgments.json がオブジェクトではありません");
    }
    let o = obj(Some(raw));
    if !o.get("schemaVersion").and_then(Value::as_f64).is_some_and(|v| JUDGMENTS_SCHEMA_VERSIONS.contains(&v)) {
        bail!("judgments.json の schemaVersion が 1・2 のどちらでもありません({})", js_string(o.get("schemaVersion")));
    }
    let Some(items) = o.get("items").and_then(Value::as_array) else {
        bail!("judgments.json に items 配列がありません");
    };
    let judge = obj(o.get("judge"));
    let mut by_session = IndexMap::new();
    for (i, it) in items.iter().enumerate() {
        let x = obj(Some(it));
        let Some(id) = str_of(x.get("sessionId")) else {
            bail!("judgments.json の items[{i}] に sessionId がありません");
        };
        let h = obj(x.get("humanEffort"));
        let hours = num(h.get("hours")).filter(|x| *x >= 0.0);
        let Some(hours) = hours else {
            bail!("judgments.json の items[{i}]({id})の humanEffort.hours が数値ではありません");
        };
        let a = obj(x.get("aiOutcome"));
        let score = |k: &str| num(obj(x.get(k)).get("score"));
        // 項目ごとの判定の出所(judge run と取り込みが付ける)。無い古い判定は、モデルだけファイル全体のものを使う
        let item_judge = x.get("judge").and_then(Value::as_object);
        let j = JudgmentSummary {
            task_category: str_of(x.get("taskCategory")),
            hours: Some(hours),
            low: num(h.get("low")),
            high: num(h.get("high")),
            confidence: num(h.get("confidence")),
            task_summary: str_of(x.get("taskSummary")),
            completed: a.get("completed").and_then(Value::as_bool),
            quality: num(a.get("quality")),
            rework: num(a.get("rework")),
            effects: JudgmentEffects { instructions: score("instructionsEffect"), wiki: score("wikiEffect"), skills_agents: score("skillsAgentsEffect") },
            rationale: str_of(h.get("rationale")),
            backend: str_of(obj(x.get("judge")).get("backend")).or_else(|| str_of(judge.get("backend"))),
            model: match item_judge {
                Some(ij) => str_of(ij.get("model")),
                None => str_of(judge.get("model")),
            },
            ran_at: item_judge.and_then(|ij| str_of(ij.get("ranAt"))),
            wiki_page_verdicts: parse_wiki_pages(x.get("wikiPages")),
            wiki_pages: None,
        };
        by_session.insert(id, j);
    }
    Ok(JudgmentsIndex { backend: str_of(judge.get("backend")), model: str_of(judge.get("model")), ran_at: str_of(judge.get("ranAt")), by_session })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // report-lib.test.ts の「必要な項目だけ拾い、形が違えばエラーにする」
    #[test]
    fn picks_and_rejects() {
        let j = parse_judgments(&json!({
            "schemaVersion": 1,
            "judge": { "backend": "external", "model": "m", "ranAt": "2026-10-28T00:00:00Z" },
            "items": [{ "sessionId": "a", "taskCategory": "docs", "taskSummary": "s", "humanEffort": { "hours": 1.5, "low": 1, "high": 2, "confidence": 0.7 } }],
        }))
        .unwrap();
        assert_eq!(j.backend.as_deref(), Some("external"));
        assert_eq!(
            j.by_session["a"],
            JudgmentSummary {
                task_category: Some("docs".into()),
                hours: Some(1.5),
                low: Some(1.0),
                high: Some(2.0),
                confidence: Some(0.7),
                task_summary: Some("s".into()),
                backend: Some("external".into()),
                // 項目に judge が無いので、モデルはファイル全体のもの(日時は付けない)
                model: Some("m".into()),
                ..Default::default()
            }
        );
        assert!(parse_judgments(&json!({ "schemaVersion": 1, "items": [{ "sessionId": "x", "humanEffort": {} }] })).unwrap_err().to_string().contains("hours"));
    }

    /// 項目ごとの判定の日時とモデル: 項目の judge から読む。judge の無い古い項目は、モデルだけファイル全体のもの(日時は付けない)
    #[test]
    fn per_item_model_and_time() {
        let j = parse_judgments(&json!({
            "schemaVersion": 1,
            "judge": { "backend": "copilot-cli", "model": "file-model", "ranAt": "2026-11-15T00:00:00Z" },
            "items": [
                { "sessionId": "a", "humanEffort": { "hours": 1 }, "judge": { "backend": "external", "model": "m365", "ranAt": "2026-11-14T01:02:03Z" } },
                { "sessionId": "b", "humanEffort": { "hours": 1 }, "judge": { "backend": "copilot-cli", "model": null, "ranAt": "2026-11-13T00:00:00Z" } },
                { "sessionId": "c", "humanEffort": { "hours": 1 } },
            ],
        }))
        .unwrap();
        let mr = |id: &str| (j.by_session[id].model.clone(), j.by_session[id].ran_at.clone());
        assert_eq!(mr("a"), (Some("m365".into()), Some("2026-11-14T01:02:03Z".into())));
        assert_eq!(mr("b"), (None, Some("2026-11-13T00:00:00Z".into())));
        assert_eq!(mr("c"), (Some("file-model".into()), None));
        assert!(parse_judgments(&json!({ "schemaVersion": 3, "items": [] })).unwrap_err().to_string().contains("schemaVersion"));
        assert!(parse_judgments(&json!({ "schemaVersion": 1, "items": [{}] })).unwrap_err().to_string().contains("sessionId"));
        assert_eq!(parse_judgments(&json!({ "items": [] })).unwrap_err().to_string(), "judgments.json の schemaVersion が 1・2 のどちらでもありません(undefined)");
    }

    // llm-wiki のページごとの判定: 版 2 の項目を読み、壊れていても項目は捨てずにページを未判定にする
    #[test]
    fn wiki_pages() {
        let item = |wp: Value| json!({ "sessionId": "a", "humanEffort": { "hours": 1 }, "wikiPages": wp });
        let parse = |wp: Value| parse_judgments(&json!({ "schemaVersion": 2, "items": [item(wp)] })).unwrap().by_session["a"].clone();
        let j = parse(json!([
            { "page": " wiki/a.md ", "helpful": "yes", "reason": "手順に使った" },
            { "page": "wiki/b.md", "helpful": "maybe", "reason": "値が違う" },
            { "page": "wiki/c.md", "helpful": "no" },
            { "page": "wiki/a.md", "helpful": "no", "reason": "重複" },
            { "helpful": "yes" },
            "wiki/d.md",
        ]));
        let v = |p: &str, h: &str, r: &str| (p.to_string(), h.to_string(), r.to_string());
        assert_eq!(j.wiki_page_verdicts, Some(vec![v("wiki/a.md", "yes", "手順に使った"), v("wiki/c.md", "no", "")]));
        // 配列でない・無い: ページは未判定(None)。ほかの判定は読む
        assert_eq!(parse(json!({ "page": "x" })).wiki_page_verdicts, None);
        assert_eq!(parse(json!("壊れた")).hours, Some(1.0));
        let v1 = parse_judgments(&json!({ "schemaVersion": 1, "items": [{ "sessionId": "a", "humanEffort": { "hours": 1 } }] })).unwrap();
        assert_eq!(v1.by_session["a"].wiki_page_verdicts, None);
        // パケットに載せたページ(読んだページの先頭から上限まで)に無い名前は捨てる
        let reads: Vec<String> = ["wiki/a.md", "wiki/a.md"].iter().map(|s| s.to_string()).collect();
        let f = judgment_for_session(&j, &reads);
        assert_eq!(f.wiki_page_verdicts, Some(vec![v("wiki/a.md", "yes", "手順に使った")]));
        // 判定が無い(None)ものはそのまま
        assert_eq!(judgment_for_session(&v1.by_session["a"], &reads).wiki_page_verdicts, None);
    }
}
