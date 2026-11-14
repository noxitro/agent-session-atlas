//! AI の変更がその後の VCS のファイルに残っているか(atlas vcs の vcs-retention.json)を、レポートに埋め込む形と、その集計。
//! packages/report/src/lib/retention.ts の移植。状態・理由・VCS の名前の並びと表示名は atlas_core::vcs_retention / vcs と同じ。

use atlas_core::js::JsMap;
use atlas_core::jsdate;
use atlas_core::turns::{session_turns, PHASES};
use atlas_core::types::SessionRecord;
use atlas_core::vcs::{EvalMode, VcsKind};
use atlas_core::vcs_retention::{ComputedOn, LineCounts, Outcome, RetentionStatus, SessionRetention, RETENTION_STATUSES};
use atlas_core::vcs_step::{SenderSummary, VcsRetentionFile};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// 依頼の開始時刻と工程(PHASES の番号)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStart {
    pub started_at: Option<String>,
    pub phase: i64,
}

/// 工程がわからないまとまり(最初の依頼より前の編集・時刻の記録が無いもの)
pub const UNKNOWN_PHASE: i64 = -1;

/// 時刻 at のまとまりを作った依頼の工程(開始が at 以前の最後の依頼)。決まらなければ UNKNOWN_PHASE。
/// 開始時刻の記録が無い依頼をはさむと、その依頼のものかもしれないので決めない
pub fn phase_at(at: Option<&str>, turns: &[TurnStart]) -> i64 {
    let Some(t) = at.filter(|x| !x.is_empty()).and_then(jsdate::parse_ms) else {
        return UNKNOWN_PHASE;
    };
    let mut phase = UNKNOWN_PHASE;
    let mut unsure = false;
    for x in turns {
        let Some(s) = x.started_at.as_deref().filter(|x| !x.is_empty()).and_then(jsdate::parse_ms) else {
            unsure = true;
            continue;
        };
        if s > t {
            break;
        }
        phase = x.phase;
        unsure = false;
    }
    if unsure { UNKNOWN_PHASE } else { phase }
}

/// 工程ごとの集計に使う、依頼の開始時刻と工程(build.ts の turnStarts)。依頼の記録が先頭 200 依頼で打ち切られたセッションは、
/// 最後の依頼の終わり(時間の記録が無ければ始まり)に「不明」を足し、それより後のまとまりを最後の依頼の工程に入れないようにする
pub fn turn_starts(r: &SessionRecord) -> Vec<TurnStart> {
    let rows = session_turns(r);
    let mut out: Vec<TurnStart> = rows.iter().map(|t| TurnStart { started_at: t.stats.started_at.clone(), phase: PHASES.iter().position(|p| *p == t.phase).map_or(-1, |i| i as i64) }).collect();
    if let Some(last) = rows.last()
        && r.turns > rows.len() as i64 {
            let start = last.stats.started_at.as_deref().filter(|x| !x.is_empty());
            // TS は開始時刻を読めないと new Date(NaN).toISOString() で止まる。ここでは開始時刻のままにする
            let end = match (start, last.ms) {
                (Some(s), Some(ms)) => jsdate::parse_ms(s).map(|t| jsdate::to_iso((t as f64 + ms).trunc() as i64)).or_else(|| Some(s.to_string())),
                _ => last.stats.started_at.clone(),
            };
            out.push(TurnStart { started_at: end, phase: UNKNOWN_PHASE });
        }
    out
}

pub const STATUSES: [&str; 4] = ["kept", "modified", "missing", "unattributable"];

pub fn status_label(s: &str) -> &'static str {
    RetentionStatus::parse(s).map_or("", RetentionStatus::label)
}

pub fn reason_label(s: &str) -> &'static str {
    atlas_core::vcs_retention::UnattributableReason::parse(s).map_or("", |r| r.label())
}

pub fn vcs_label(k: &str) -> &'static str {
    match k {
        "git" => "Git",
        "svn" => "SVN",
        "p4" => "Perforce",
        _ => "",
    }
}

/// [そのまま残る, 直されて残る, 見つからない, 照合不可]
pub type StatusTuple = [i64; 4];

/// セッション 1 件の照合の結果(埋め込み用。パスは持たない)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetentionItem {
    /// 工程(PHASES の番号。UNKNOWN_PHASE は不明)ごとのまとまりの数 [工程, ...状態別]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<[i64; 5]>>,
    /// セッションの終わりから、比べた時点までの日数(小数 1 桁)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag: Option<f64>,
    /// ログから変更を取り出せなかった編集の数(0 は省略)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<i64>,
    /// measured / none / unattributable
    pub outcome: String,
    pub reason: Option<String>,
    pub vcs: Option<VcsKind>,
    /// observed / estimated
    pub baseline: Option<String>,
    /// local / sender
    pub on: String,
    pub mapped: bool,
    pub hunks: StatusTuple,
    pub lines: StatusTuple,
}

/// 照合した場所の言葉
pub fn place_label(computed_on: Option<&str>) -> &'static str {
    match computed_on {
        Some("sender") => "送った側の PC",
        Some("local") => "この PC",
        _ => "照合していない",
    }
}

fn tuple(c: &LineCounts) -> StatusTuple {
    [c.kept, c.modified, c.missing, c.unattributable]
}

pub fn retention_item(r: &SessionRetention, turns: &[TurnStart]) -> RetentionItem {
    // 工程ごとのまとまりの数(依頼の記録があり、まとまりがあるときだけ)
    let mut phases = None;
    if !turns.is_empty() && !r.hunks.is_empty() {
        let mut by: IndexMap<i64, StatusTuple> = IndexMap::new();
        for h in &r.hunks {
            let p = phase_at(h.at.as_deref(), turns);
            let i = RETENTION_STATUSES.iter().position(|s| *s == h.status).expect("状態は RETENTION_STATUSES のどれか");
            by.entry(p).or_insert([0; 4])[i] += 1;
        }
        let mut v: Vec<(i64, StatusTuple)> = by.into_iter().collect();
        v.sort_by_key(|x| x.0);
        phases = Some(v.into_iter().map(|(p, t)| [p, t[0], t[1], t[2], t[3]]).collect());
    }
    let end = r.session_end.clone().flatten().filter(|x| !x.is_empty()).and_then(|x| jsdate::parse_ms(&x));
    let at = r.evaluated.as_ref().map(|e| e.at.as_str()).filter(|x| !x.is_empty()).and_then(jsdate::parse_ms);
    let lag = match (end, at) {
        (Some(e), Some(a)) => Some(0f64.max(atlas_core::js::round(((a - e) as f64 / 86_400_000.0) * 10.0) / 10.0)),
        _ => None,
    };
    RetentionItem {
        phases,
        lag,
        unread: r.unread_edits.filter(|n| *n != 0),
        outcome: match r.outcome {
            Outcome::NoAiChanges => "none".into(),
            o => o.as_str().into(),
        },
        reason: r.reason.map(|x| x.as_str().to_string()),
        vcs: r.vcs,
        baseline: r.baseline.as_ref().map(|b| b.source.as_str().to_string()),
        on: r.computed_on.unwrap_or(ComputedOn::Local).as_str().into(),
        mapped: r.path_mapped == Some(true),
        hunks: tuple(&r.counts),
        lines: tuple(&r.lines),
    }
}

/// fixed の既定の日数(core の DEFAULT_LAG_DAYS と同じ)
pub const DEFAULT_LAG_DAYS: i64 = 7;

pub fn mode_label(m: EvalMode) -> &'static str {
    match m {
        EvalMode::Worktree => "今の作業ツリー",
        EvalMode::Committed => "最後に取り込んだ版",
        EvalMode::Fixed => "セッションの終わりから決まった日数後の版",
    }
}

/// 照合の全体の条件(ReportData.retention)。キーの順は build.ts が組み立てる順
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionMeta {
    pub generated_at: String,
    pub computed_on: ComputedOn,
    pub mode: EvalMode,
    pub similarity: f64,
    pub path_map: i64,
    /// 照合したセッションの数
    pub sessions: i64,
    pub senders: Option<SenderSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<JsMap<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lag_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// vcs-retention.json から ReportData.retention を作る(build.ts と同じ)
pub fn retention_meta(rx: &VcsRetentionFile) -> RetentionMeta {
    RetentionMeta {
        generated_at: rx.generated_at.clone(),
        computed_on: rx.computed_on,
        mode: rx.mode,
        similarity: rx.similarity,
        path_map: rx.path_map,
        sessions: rx.sessions.len() as i64,
        senders: rx.senders.clone().flatten(),
        labels: rx.labels.clone(),
        lag_days: rx.lag_days.filter(|d| *d != 0),
        note: rx.note.clone().filter(|n| !n.is_empty()),
    }
}

/// 中央値(空なら None。偶数個なら中の 2 つの平均)
pub fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let s = crate::exec::sort_nums(xs);
    let m = s.len() / 2;
    Some(if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 })
}

fn add(a: &mut StatusTuple, b: &StatusTuple) {
    for i in 0..4 {
        a[i] += b[i];
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct BaselineCounts {
    pub observed: i64,
    pub estimated: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionAgg {
    pub sessions: i64,
    pub not_checked: i64,
    pub none: i64,
    pub with_ai: i64,
    pub measured: i64,
    pub unattributable: JsMap<i64>,
    pub unattributable_total: i64,
    pub baseline: BaselineCounts,
    pub by_vcs: JsMap<i64>,
    pub sender: i64,
    pub mapped: i64,
    pub hunks: StatusTuple,
    pub lines: StatusTuple,
    pub lags: Vec<f64>,
    pub unread: i64,
    pub unread_sessions: i64,
}

/// 照合の結果を集計する(照合できたセッションだけを分母にし、照合の範囲を一緒に数える)
pub fn aggregate_retention<'a>(sessions: impl IntoIterator<Item = Option<&'a RetentionItem>>) -> RetentionAgg {
    let mut a = RetentionAgg::default();
    for r in sessions {
        a.sessions += 1;
        if let Some(u) = r.and_then(|r| r.unread).filter(|u| *u != 0) {
            a.unread += u;
            a.unread_sessions += 1;
        }
        let Some(r) = r else {
            a.not_checked += 1;
            continue;
        };
        if r.outcome == "none" {
            a.none += 1;
            continue;
        }
        a.with_ai += 1;
        if r.outcome == "unattributable" {
            a.unattributable.inc(r.reason.as_deref().unwrap_or("read_error"), 1);
            a.unattributable_total += 1;
            continue;
        }
        a.measured += 1;
        match r.baseline.as_deref() {
            Some("estimated") => a.baseline.estimated += 1,
            Some("observed") => a.baseline.observed += 1,
            _ => {}
        }
        if let Some(v) = r.vcs {
            a.by_vcs.inc(v.as_str(), 1);
        }
        if r.on == "sender" {
            a.sender += 1;
        }
        if r.mapped {
            a.mapped += 1;
        }
        if let Some(l) = r.lag {
            a.lags.push(l);
        }
        add(&mut a.hunks, &r.hunks);
        add(&mut a.lines, &r.lines);
    }
    a
}

/// 照合できたまとまり(照合不可を除く)の数
pub fn measured_of(t: &StatusTuple) -> i64 {
    t[0] + t[1] + t[2]
}

/// 照合できたまとまりに対する割合(分母が 0 なら None)
pub fn share_of(t: &StatusTuple, i: usize) -> Option<f64> {
    let d = measured_of(t);
    if d > 0 { Some(t[i] as f64 / d as f64) } else { None }
}

/// 照合できたセッションのまとまりを、工程ごとに数える。工程の記録が無いセッションは数えず、その数を返す
pub fn retention_by_phase<'a>(sessions: impl IntoIterator<Item = Option<&'a RetentionItem>>) -> (IndexMap<i64, StatusTuple>, i64) {
    let mut by: IndexMap<i64, StatusTuple> = IndexMap::new();
    let mut without = 0;
    for r in sessions.into_iter().flatten() {
        if r.outcome != "measured" {
            continue;
        }
        match r.phases.as_ref().filter(|p| !p.is_empty()) {
            None => without += 1,
            Some(ps) => {
                for p in ps {
                    add(by.entry(p[0]).or_insert([0; 4]), &[p[1], p[2], p[3], p[4]]);
                }
            }
        }
    }
    (by, without)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(f: impl FnOnce(&mut RetentionItem)) -> RetentionItem {
        let mut r = RetentionItem { phases: None, lag: None, unread: None, outcome: "measured".into(), reason: None, vcs: Some(VcsKind::Git), baseline: Some("observed".into()), on: "local".into(), mapped: false, hunks: [0; 4], lines: [0; 4] };
        f(&mut r);
        r
    }

    // retention.test.ts の aggregateRetention
    #[test]
    fn aggregates() {
        let list = [
            Some(item(|r| (r.hunks, r.lines) = ([3, 1, 1, 1], [10, 2, 3, 4]))),
            Some(item(|r| {
                r.baseline = Some("estimated".into());
                r.vcs = Some(VcsKind::P4);
                r.on = "sender".into();
                (r.hunks, r.lines) = ([1, 0, 0, 0], [2, 0, 0, 0]);
            })),
            Some(item(|r| {
                r.mapped = true;
                (r.hunks, r.lines) = ([0, 0, 2, 0], [0, 0, 4, 0]);
            })),
            Some(item(|r| {
                r.outcome = "unattributable".into();
                r.reason = Some("no_vcs".into());
                r.hunks = [0, 0, 0, 3];
            })),
            Some(item(|r| {
                r.outcome = "unattributable".into();
                r.hunks = [0, 0, 0, 1];
            })),
            Some(item(|r| r.outcome = "none".into())),
            None,
            None,
        ];
        let a = aggregate_retention(list.iter().map(Option::as_ref));
        assert_eq!((a.sessions, a.not_checked, a.none, a.with_ai, a.measured, a.unattributable_total), (8, 2, 1, 5, 3, 2));
        assert_eq!(atlas_core::json::to_js_string(&a.unattributable).unwrap(), r#"{"no_vcs":1,"read_error":1}"#);
        assert_eq!(a.baseline, BaselineCounts { observed: 2, estimated: 1 });
        assert_eq!(atlas_core::json::to_js_string(&a.by_vcs).unwrap(), r#"{"git":2,"p4":1}"#);
        assert_eq!((a.sender, a.mapped, a.hunks, a.lines), (1, 1, [4, 1, 3, 1], [12, 2, 7, 4]));
        assert_eq!(share_of(&a.hunks, 0), Some(4.0 / 8.0));
        assert_eq!(share_of(&[0, 0, 0, 5], 0), None);
    }

    #[test]
    fn phases_by_time() {
        let t = |s: Option<&str>, p: i64| TurnStart { started_at: s.map(str::to_string), phase: p };
        let turns = [t(Some("2026-11-01T00:00:00Z"), 0), t(Some("2026-11-01T01:00:00Z"), 2)];
        assert_eq!(phase_at(Some("2026-11-01T00:30:00Z"), &turns), 0);
        assert_eq!(phase_at(Some("2026-11-01T02:00:00Z"), &turns), 2);
        assert_eq!(phase_at(Some("2026-10-31T00:00:00Z"), &turns), UNKNOWN_PHASE);
        assert_eq!(phase_at(None, &turns), UNKNOWN_PHASE);
        let gap = [t(Some("2026-11-01T00:00:00Z"), 0), t(None, 2)];
        assert_eq!(phase_at(Some("2026-11-01T02:00:00Z"), &gap), UNKNOWN_PHASE);
        assert_eq!(median(&[3.0, 1.0, 2.0, 4.0]), Some(2.5));
        assert_eq!(place_label(Some("sender")), "送った側の PC");
        assert_eq!(STATUSES.map(status_label), ["そのまま残る", "直されて残る", "見つからない", "照合不可"]);
        assert_eq!(DEFAULT_LAG_DAYS, atlas_core::vcs_retention::DEFAULT_LAG_DAYS);
    }
}
