//! judgments.json(Phase 3 の judge が出す判定結果)の読み取り口。packages/report/src/lib/judgments.ts の移植。
//! レポートに要る項目だけを拾う。report は judge に依存しないので、ここでは表示に必要な最低限を検査し、
//! 形が合わない項目は捨てずにエラーにする(黙って欠損させない)。

use crate::types::{JudgmentEffects, JudgmentSummary};
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

pub fn parse_judgments(raw: &Value) -> Result<JudgmentsIndex> {
    let truthy_obj = matches!(raw, Value::Object(_) | Value::Array(_));
    if !truthy_obj {
        bail!("judgments.json がオブジェクトではありません");
    }
    let o = obj(Some(raw));
    if o.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) {
        bail!("judgments.json の schemaVersion が 1 ではありません({})", js_string(o.get("schemaVersion")));
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
                ..Default::default()
            }
        );
        assert!(parse_judgments(&json!({ "schemaVersion": 1, "items": [{ "sessionId": "x", "humanEffort": {} }] })).unwrap_err().to_string().contains("hours"));
        assert!(parse_judgments(&json!({ "schemaVersion": 2, "items": [] })).unwrap_err().to_string().contains("schemaVersion"));
        assert!(parse_judgments(&json!({ "schemaVersion": 1, "items": [{}] })).unwrap_err().to_string().contains("sessionId"));
        assert_eq!(parse_judgments(&json!({ "items": [] })).unwrap_err().to_string(), "judgments.json の schemaVersion が 1 ではありません(undefined)");
    }
}
