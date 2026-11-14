//! 依頼(ターン)単位の分析をレポートに載せる形(packages/report/src/lib/turns.ts の移植。段階 1)。
//! 埋め込みは 1 ターン 1 つの数値の組(TurnTuple)にして小さくし、画面で絞り込みに合わせて工程別・依頼の種類別に集計し直す。
//! 分類の規則(工程・依頼の種類)と集計の足し方は atlas_core::turns と同じものを使う。

use atlas_core::js::JsMap;
use atlas_core::turns::{add_turn, empty_turn_bucket, session_turns, TurnBucket, TurnFacts, PHASES, REQUEST_KINDS};
use atlas_core::types::SessionRecord;
use serde::Serialize;

/// [工程, 依頼の種類, 次の依頼の種類(無ければ null), 実働 ms, ツール, 失敗, 拒否, 中断, エラー, うち利用上限, 文脈圧縮, 再編集, nano AIU, サブエージェント失敗, 編集]。
/// 工程と依頼の種類は PHASES / REQUEST_KINDS の番号
pub type TurnTuple = (i64, i64, Option<i64>, Option<f64>, i64, i64, i64, i64, i64, i64, i64, i64, Option<f64>, i64, i64);

fn index_of(list: &[&str], x: &str) -> i64 {
    list.iter().position(|k| *k == x).map_or(-1, |i| i as i64)
}

pub fn turn_tuples(r: &SessionRecord) -> Vec<TurnTuple> {
    session_turns(r)
        .iter()
        .map(|t| {
            let s = t.stats;
            (
                index_of(&PHASES, t.phase),
                index_of(&REQUEST_KINDS, t.kind),
                t.next_kind.map(|k| index_of(&REQUEST_KINDS, k)),
                t.active_ms,
                s.tools,
                s.tool_failures,
                s.denied,
                s.aborts,
                s.errors,
                s.external_errors,
                s.compactions,
                s.re_edits,
                s.nano_aiu,
                s.subagent_failures,
                s.edits,
            )
        })
        .collect()
}

fn at<'a>(list: &[&'a str], i: i64) -> Option<&'a str> {
    usize::try_from(i).ok().and_then(|i| list.get(i).copied())
}

/// 埋め込みの組を集計に使う形に戻す(工程と、集計に使う項目。依頼文・時刻・使用量の入力 / 出力は持たない)
pub fn from_tuple(x: &TurnTuple) -> (&'static str, TurnFacts) {
    let phase = at(&PHASES, x.0).unwrap_or("research");
    let facts = TurnFacts {
        kind: at(&REQUEST_KINDS, x.1).unwrap_or("task"),
        next_kind: x.2.and_then(|k| at(&REQUEST_KINDS, k)),
        active_ms: x.3,
        tools: x.4,
        tool_failures: x.5,
        denied: x.6,
        aborts: x.7,
        errors: x.8,
        external_errors: x.9,
        compactions: x.10,
        re_edits: x.11,
        nano_aiu: x.12,
        subagent_failures: x.13,
        edits: x.14,
        ask_user: 0,
        input: None,
        output: None,
    };
    (phase, facts)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAggregate {
    pub turns: i64,
    /// ターンの記録があるセッション
    pub sessions: i64,
    /// 依頼があるのにターンの記録が無いセッション(古い記録・DB だけ)
    pub sessions_without_turns: i64,
    pub total: TurnBucket,
    pub by_phase: JsMap<TurnBucket>,
    pub by_kind: JsMap<TurnBucket>,
}

/// 絞り込み後のセッションのターンを集計する(turns と turnRows だけを見る)
pub fn turn_aggregate<'a>(sessions: impl IntoIterator<Item = (i64, Option<&'a [TurnTuple]>)>) -> TurnAggregate {
    let mut by_phase: JsMap<TurnBucket> = JsMap(PHASES.iter().map(|p| (p.to_string(), empty_turn_bucket())).collect());
    let mut by_kind: JsMap<TurnBucket> = JsMap(REQUEST_KINDS.iter().map(|k| (k.to_string(), empty_turn_bucket())).collect());
    let mut total = empty_turn_bucket();
    let (mut turns, mut with_turns, mut without) = (0, 0, 0);
    for (n, rows) in sessions {
        let rows = rows.unwrap_or(&[]);
        if rows.is_empty() {
            if n > 0 {
                without += 1;
            }
            continue;
        }
        with_turns += 1;
        for x in rows {
            let (phase, t) = from_tuple(x);
            turns += 1;
            add_turn(&mut total, &t);
            add_turn(by_phase.get_mut(phase).expect("PHASES の工程"), &t);
            add_turn(by_kind.get_mut(t.kind).expect("REQUEST_KINDS の種類"), &t);
        }
    }
    TurnAggregate { turns, sessions: with_turns, sessions_without_turns: without, total, by_phase, by_kind }
}
