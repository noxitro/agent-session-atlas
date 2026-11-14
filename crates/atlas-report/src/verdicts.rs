//! 段階 2: 依頼ごとの LLM 判定(turn-judgments.json)を読む(packages/report/src/lib/verdicts.ts の parseVerdicts の移植)。
//! 読みは軽い検証だけ(形の合わない項目は捨てる。正しい形にして書くのは judge の取り込み側)。
//! TODO(段 4): verdictTuples・verdictAggregate など画面に載せる側は build の移植で足す

use atlas_core::tables::{turn_key, TurnVerdict, VerdictMap};
use atlas_core::turns::{MISMATCHES, OUTCOMES, REQUEST_KINDS};
use serde_json::Value;

pub struct VerdictIndex {
    pub phases: Vec<String>,
    pub model: Option<String>,
    pub ran_at: Option<String>,
    /// セッション ID → 依頼番号 → 判定
    pub by_session: VerdictMap,
}

fn pick(list: &[&'static str], v: Option<&Value>) -> Option<&'static str> {
    let s = v?.as_str()?;
    list.iter().copied().find(|x| *x == s)
}

/// turn-judgments.json を読む(形の合わない項目は捨てる)。全体の形が違えば None
pub fn parse_verdicts(raw: &Value) -> Option<VerdictIndex> {
    let obj = raw.as_object()?;
    let phases = obj.get("phases")?.as_array()?;
    let items = obj.get("items")?.as_array()?;
    let phases: Vec<String> = phases.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
    let mut by_session = VerdictMap::new();
    for it in items {
        let Some(it) = it.as_object() else { continue };
        let (Some(sid), Some(turn)) = (it.get("sessionId").and_then(Value::as_str), it.get("turn").filter(|t| t.is_number()).and_then(Value::as_f64)) else {
            continue;
        };
        let (Some(kind), Some(outcome), Some(phase)) = (pick(&REQUEST_KINDS, it.get("kind")), pick(&OUTCOMES, it.get("outcome")), it.get("phase").and_then(Value::as_str)) else {
            continue;
        };
        let v = TurnVerdict {
            turn,
            kind,
            outcome,
            mismatch: pick(&MISMATCHES, it.get("mismatch")),
            phase: phase.to_string(),
            confidence: it.get("confidence").filter(|c| c.is_number()).and_then(Value::as_f64).unwrap_or(0.0),
            note: it.get("note").and_then(Value::as_str).unwrap_or("").to_string(),
        };
        by_session.entry(sid.to_string()).or_default().insert(turn_key(turn), v);
    }
    let judge = obj.get("judge").and_then(Value::as_object);
    let s = |k: &str| judge.and_then(|j| j.get(k)).and_then(Value::as_str).map(str::to_string);
    Some(VerdictIndex { phases, model: s("model"), ran_at: s("ranAt"), by_session })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn drops_items_with_wrong_shape() {
        assert!(parse_verdicts(&json!({ "items": [] })).is_none());
        let v = parse_verdicts(&json!({
            "phases": ["実装", 3],
            "judge": { "model": "m" },
            "items": [
                { "sessionId": "s", "turn": 1, "kind": "task", "outcome": "as_is", "phase": "実装", "confidence": 0.8, "note": "n" },
                { "sessionId": "s", "turn": 2, "kind": "nope", "outcome": "as_is", "phase": "実装" },
                { "sessionId": "s", "turn": 1, "kind": "fix", "outcome": "rejected", "mismatch": "defect", "phase": "x" },
                { "sessionId": "t", "turn": "3", "kind": "task", "outcome": "as_is", "phase": "x" },
            ],
        }))
        .unwrap();
        assert_eq!(v.phases, ["実装"]);
        assert_eq!(v.model.as_deref(), Some("m"));
        assert_eq!(v.ran_at, None);
        let s = &v.by_session["s"];
        assert_eq!(s.len(), 1);
        // 同じ依頼番号は後のもので置き換える
        let t = &s[&turn_key(1.0)];
        assert_eq!((t.kind, t.outcome, t.mismatch, t.confidence), ("fix", "rejected", Some("defect"), 0.0));
        assert!(!v.by_session.contains_key("t"));
    }
}
