//! 段階 2: 依頼ごとの LLM 判定(turn-judgments.json)をレポートに載せる形(packages/report/src/lib/verdicts.ts の移植)。
//! 読みは軽い検証だけ(形の合わない項目は捨てる。正しい形にして書くのは judge の取り込み側)。
//! 埋め込みは 1 依頼 1 つの数値の組(VerdictTuple)。判定の理由(note)は HTML 本体に入れず、詳細ページにだけ出す。

use crate::turns::{from_tuple, TurnTuple};
use atlas_core::js::{self, JsMap};
use atlas_core::tables::{turn_key, TurnVerdict, TurnVerdicts, VerdictMap};
use atlas_core::turns::{add_turn, empty_turn_bucket, TurnBucket, MISMATCHES, OUTCOMES, PHASES, REQUEST_KINDS};
use serde::Serialize;
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

/// [依頼番号, 種類, 扱い, 合わなかった点(無ければ null), 普段の工程(phases の番号。無ければ -1), 確信度(0〜100)]
pub type VerdictTuple = (f64, i64, i64, Option<i64>, i64, f64);

fn index_of(list: &[&str], x: &str) -> i64 {
    list.iter().position(|k| *k == x).map_or(-1, |i| i as i64)
}

pub fn verdict_tuples(m: Option<&TurnVerdicts>, phases: &[String]) -> Vec<VerdictTuple> {
    let Some(m) = m else { return vec![] };
    let mut v: Vec<&TurnVerdict> = m.values().collect();
    v.sort_by(|a, b| crate::exec::num_cmp(a.turn, b.turn));
    v.into_iter()
        .map(|v| {
            (
                v.turn,
                index_of(&REQUEST_KINDS, v.kind),
                index_of(&OUTCOMES, v.outcome),
                v.mismatch.map(|x| index_of(&MISMATCHES, x)),
                phases.iter().position(|p| *p == v.phase).map_or(-1, |i| i as i64),
                js::round(v.confidence * 100.0),
            )
        })
        .collect()
}

/// 扱いの数え方(1 つの工程・種類ごと)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeCounts {
    pub judged: i64,
    pub by_outcome: JsMap<i64>,
    pub by_mismatch: JsMap<i64>,
    /// 同じ依頼の規則の集計(詰まり・失敗など)
    pub turns: TurnBucket,
}

fn empty_counts() -> OutcomeCounts {
    OutcomeCounts {
        judged: 0,
        by_outcome: JsMap(OUTCOMES.iter().map(|o| (o.to_string(), 0)).collect()),
        by_mismatch: JsMap(MISMATCHES.iter().map(|m| (m.to_string(), 0)).collect()),
        turns: empty_turn_bucket(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictAggregate {
    pub judged: i64,
    /// 判定済みの依頼があるセッション
    pub sessions: i64,
    /// 普段の工程名(判定に使ったもの)と、一覧に無い工程名をまとめる行
    pub phases: Vec<String>,
    pub total: OutcomeCounts,
    /// 普段の工程別(phases の並び)
    pub by_phase: Vec<OutcomeCounts>,
    /// 規則の工程別
    pub by_rule_phase: JsMap<OutcomeCounts>,
}

/// 一覧に無い工程名の判定をまとめる行の名前
pub const UNLISTED_PHASE: &str = "(一覧に無い工程)";

fn at<'a>(list: &[&'a str], i: i64) -> Option<&'a str> {
    usize::try_from(i).ok().and_then(|i| list.get(i).copied())
}

/// 絞り込み後のセッションの判定を集計する(規則の行と同じ依頼番号で結ぶ)。各セッションは (turnRows, turnVerdicts)
pub fn verdict_aggregate<'a>(sessions: impl IntoIterator<Item = (Option<&'a [TurnTuple]>, Option<&'a [VerdictTuple]>)>, phases: &[String]) -> VerdictAggregate {
    let mut total = empty_counts();
    // 一覧に無い工程名(番号 -1)も、合計と行が食い違わないよう 1 行にまとめる
    let mut names: Vec<String> = phases.to_vec();
    names.push(UNLISTED_PHASE.into());
    let mut by_phase: Vec<OutcomeCounts> = names.iter().map(|_| empty_counts()).collect();
    let mut by_rule_phase: JsMap<OutcomeCounts> = JsMap(PHASES.iter().map(|p| (p.to_string(), empty_counts())).collect());
    let (mut judged, mut with_any) = (0, 0);
    for (rows, vs) in sessions {
        let vs = vs.unwrap_or(&[]);
        if vs.is_empty() {
            continue;
        }
        with_any += 1;
        for v in vs {
            let Some(outcome) = at(&OUTCOMES, v.2) else { continue };
            let mismatch = v.3.and_then(|m| at(&MISMATCHES, m));
            // turnRows?.[v[0] - 1](依頼番号が整数でなければ当たらない)
            let idx = v.0 - 1.0;
            let row = if idx >= 0.0 && idx.fract() == 0.0 { rows.and_then(|r| r.get(idx as usize)) } else { None };
            let facts = row.map(from_tuple);
            let add = |c: &mut OutcomeCounts| {
                c.judged += 1;
                c.by_outcome.inc(outcome, 1);
                if let Some(m) = mismatch {
                    c.by_mismatch.inc(m, 1);
                }
                if let Some((_, f)) = &facts {
                    add_turn(&mut c.turns, f);
                }
            };
            judged += 1;
            add(&mut total);
            let pi = if v.4 >= 0 && (v.4 as usize) < phases.len() { v.4 as usize } else { phases.len() };
            add(&mut by_phase[pi]);
            if let Some((phase, _)) = &facts {
                add(by_rule_phase.get_mut(*phase).expect("PHASES の工程"));
            }
        }
    }
    VerdictAggregate { judged, sessions: with_any, phases: names, total, by_phase, by_rule_phase }
}

/// 作業の依頼のうち判定できたもの(判定不能・質問の扱いを除く)
pub fn work_decided(c: &OutcomeCounts) -> i64 {
    ["as_is", "fix_content", "fix_style", "rejected"].iter().map(|k| c.by_outcome.get(*k).copied().unwrap_or(0)).sum()
}

pub fn question_decided(c: &OutcomeCounts) -> i64 {
    ["helpful", "follow_up", "off_target"].iter().map(|k| c.by_outcome.get(*k).copied().unwrap_or(0)).sum()
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

    // turns-report.test.ts の「採用率の分母は判定できた作業の依頼、一覧に無い工程名は「(一覧に無い工程)」の行に入る」
    #[test]
    fn aggregates_with_unlisted_phase() {
        let row = |phase: i64| TurnTuple { phase, active_ms: Some(1000.0), tools: 1, ..Default::default() };
        let v: Vec<VerdictTuple> = vec![(1.0, 0, 0, None, 0, 80.0), (2.0, 0, 1, Some(0), 0, 70.0), (3.0, 0, 7, None, 1, 50.0), (4.0, 1, 4, None, -1, 60.0)];
        let rows = [row(2), row(2), row(0), row(5)];
        let phases = vec!["実装".to_string(), "テスト".to_string()];
        let a = verdict_aggregate([(Some(&rows[..]), Some(&v[..]))], &phases);
        assert_eq!(a.judged, 4);
        assert_eq!(a.phases, ["実装", "テスト", UNLISTED_PHASE]);
        assert_eq!(a.by_phase.iter().map(|c| c.judged).collect::<Vec<_>>(), [2, 1, 1]);
        assert_eq!((a.total.by_outcome["as_is"], a.total.by_outcome["fix_content"], a.total.by_outcome["unknown"], a.total.by_outcome["helpful"]), (1, 1, 1, 1));
        assert_eq!(a.total.by_mismatch["requirement"], 1);
        assert_eq!(a.by_rule_phase["implement"].judged, 2);
        assert_eq!(work_decided(&a.total), 2);
    }
}
