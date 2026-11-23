//! AI の変更がその後の VCS のファイルに残っているか(atlas vcs の vcs-retention.json)を、レポートに埋め込む形と、その集計。
//! packages/report/src/lib/retention.ts の移植。状態・理由・VCS の名前の並びと表示名は atlas_core::vcs_retention / vcs と同じ。

use atlas_core::js::JsMap;
use atlas_core::jsdate;
use atlas_core::turns::{session_turns, PHASES};
use atlas_core::types::SessionRecord;
use atlas_core::vcs::{EvalMode, VcsKind};
use atlas_core::vcs_retention::{baseline_source_of, vcs_kinds_of, ComputedOn, LineCounts, Outcome, RetentionStatus, SessionRetention, RETENTION_STATUSES};
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
    /// 照合に使ったリポジトリの種類(VCS_KINDS の順)。[vcs] と同じとき・古い結果(repos が無い)では省略
    #[serde(rename = "vcsKinds", default, skip_serializing_if = "Option::is_none")]
    pub vcs_kinds: Option<Vec<VcsKind>>,
    /// observed / estimated(照合に使ったリポジトリのどれかが推定なら estimated)
    pub baseline: Option<String>,
    /// local / sender
    pub on: String,
    pub mapped: bool,
    pub hunks: StatusTuple,
    pub lines: StatusTuple,
    /// 比べた版の決め方(evaluated.mode。worktree / committed / fixed)。比べた時点の記録が無い結果・古い埋め込みには無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<EvalMode>,
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
    // 照合に使ったリポジトリの種類。セッションの vcs だけと同じなら持たない(埋め込みを増やさない)
    let kinds = vcs_kinds_of(r);
    let vcs_kinds = (!r.repos.is_empty() && kinds != r.vcs.into_iter().collect::<Vec<_>>()).then_some(kinds);
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
        vcs_kinds,
        baseline: baseline_source_of(r).map(|b| b.as_str().to_string()),
        on: r.computed_on.unwrap_or(ComputedOn::Local).as_str().into(),
        mapped: r.path_mapped == Some(true),
        hunks: tuple(&r.counts),
        lines: tuple(&r.lines),
        mode: r.evaluated.as_ref().map(|e| e.mode),
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
    /// VCS ごとの照合できたセッションの数。複数の VCS にまたがるセッションはそれぞれに入る(合計が measured を超えうる)
    pub by_vcs: JsMap<i64>,
    /// 照合できたセッションのうち、複数の VCS にまたがるもの
    pub multi_vcs: i64,
    pub sender: i64,
    pub mapped: i64,
    pub hunks: StatusTuple,
    pub lines: StatusTuple,
    pub lags: Vec<f64>,
    pub unread: i64,
    pub unread_sessions: i64,
    /// 照合できたセッションの、比べた版の決め方(mode)ごとの数(記録の無いものは入れない)。2 つ以上あれば、比べる版が混ざっている
    pub modes: JsMap<i64>,
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
            a.unattributable.inc(r.reason.as_deref().unwrap_or("unknown"), 1);
            a.unattributable_total += 1;
            continue;
        }
        a.measured += 1;
        match r.baseline.as_deref() {
            Some("estimated") => a.baseline.estimated += 1,
            Some("observed") => a.baseline.observed += 1,
            _ => {}
        }
        let kinds: Vec<VcsKind> = r.vcs_kinds.clone().unwrap_or_else(|| r.vcs.into_iter().collect());
        for v in &kinds {
            a.by_vcs.inc(v.as_str(), 1);
        }
        if kinds.len() > 1 {
            a.multi_vcs += 1;
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
        if let Some(m) = r.mode {
            a.modes.inc(m.as_str(), 1);
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

/// 工程ごとの集計(retention_by_phase の結果)
pub struct RetentionByPhase {
    /// 工程ごとのまとまりの数(状態別)
    pub by_phase: IndexMap<i64, StatusTuple>,
    /// その工程に照合できたまとまり(照合不可を除く)が 1 つ以上あるセッションの数(工程ごとの割合を出すかを決める)
    pub sessions: IndexMap<i64, i64>,
    /// 工程の記録が無く、数えなかったセッションの数
    pub without_phases: i64,
}

/// 照合できたセッションのまとまりを、工程ごとに数える。工程の記録が無いセッションは数えず、その数を返す
pub fn retention_by_phase<'a>(sessions: impl IntoIterator<Item = Option<&'a RetentionItem>>) -> RetentionByPhase {
    let mut by: IndexMap<i64, StatusTuple> = IndexMap::new();
    let mut per_phase: IndexMap<i64, i64> = IndexMap::new();
    let mut without = 0;
    for r in sessions.into_iter().flatten() {
        if r.outcome != "measured" {
            continue;
        }
        match r.phases.as_ref().filter(|p| !p.is_empty()) {
            None => without += 1,
            Some(ps) => {
                // phases は工程ごとに 1 行(retention_item が工程でまとめて書く)なので、行の数がそのままセッションの数になる
                for p in ps {
                    let t = [p[1], p[2], p[3], p[4]];
                    add(by.entry(p[0]).or_insert([0; 4]), &t);
                    if measured_of(&t) > 0 {
                        *per_phase.entry(p[0]).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    RetentionByPhase { by_phase: by, sessions: per_phase, without_phases: without }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(f: impl FnOnce(&mut RetentionItem)) -> RetentionItem {
        let mut r = RetentionItem { phases: None, lag: None, unread: None, outcome: "measured".into(), reason: None, vcs: Some(VcsKind::Git), vcs_kinds: None, baseline: Some("observed".into()), on: "local".into(), mapped: false, hunks: [0; 4], lines: [0; 4], mode: None };
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
        assert_eq!(atlas_core::json::to_js_string(&a.unattributable).unwrap(), r#"{"no_vcs":1,"unknown":1}"#);
        assert_eq!(a.baseline, BaselineCounts { observed: 2, estimated: 1 });
        assert_eq!(atlas_core::json::to_js_string(&a.by_vcs).unwrap(), r#"{"git":2,"p4":1}"#);
        assert_eq!(a.multi_vcs, 0);
        assert_eq!((a.sender, a.mapped, a.hunks, a.lines), (1, 1, [4, 1, 3, 1], [12, 2, 7, 4]));
        // 割合の分母は照合できたまとまり(照合不可を除く 8)。割合と、出すかどうかの閾値は画面(lib/retention.ts)だけが持つ
        assert_eq!(measured_of(&a.hunks), 8);
        // 比べた版の記録が無ければ、版の内訳は空
        assert!(a.modes.is_empty());
    }

    // 比べた版(evaluated.mode)の内訳は、照合できたセッションだけを数える(照合不可・変更なし・記録の無いものは入れない)。
    // retention.test.ts の「比べた版の内訳」と同じ
    #[test]
    fn aggregates_modes_of_measured_sessions() {
        let list = [
            Some(item(|r| r.mode = Some(EvalMode::Worktree))),
            Some(item(|r| r.mode = Some(EvalMode::Fixed))),
            Some(item(|r| r.mode = Some(EvalMode::Worktree))),
            Some(item(|r| {
                r.outcome = "unattributable".into();
                r.mode = Some(EvalMode::Committed);
            })),
            Some(item(|r| r.mode = None)),
        ];
        let a = aggregate_retention(list.iter().map(Option::as_ref));
        assert_eq!(atlas_core::json::to_js_string(&a.modes).unwrap(), r#"{"worktree":2,"fixed":1}"#);
        // 埋め込みには版の決め方を持つ(無ければ書かない)
        assert_eq!(serde_json::to_value(&list[1]).unwrap()["mode"], "fixed");
        assert!(serde_json::to_value(&list[4]).unwrap().get("mode").is_none());
    }

    // 複数の VCS にまたがるセッション: VCS 別は種類ごとに 1 回ずつ数え(合計が照合できたセッションを超えうる)、基準はどれかが推定なら推定
    #[test]
    fn aggregates_mixed_vcs() {
        let list = [
            Some(item(|r| {
                r.vcs = None;
                r.vcs_kinds = Some(vec![VcsKind::Svn, VcsKind::P4]);
                r.baseline = Some("estimated".into());
            })),
            Some(item(|_| {})),
            // 古い埋め込み(vcsKinds が無い)はセッションの vcs で数える
            Some(item(|r| r.vcs = Some(VcsKind::P4))),
        ];
        let a = aggregate_retention(list.iter().map(Option::as_ref));
        assert_eq!(a.measured, 3);
        assert_eq!(atlas_core::json::to_js_string(&a.by_vcs).unwrap(), r#"{"svn":1,"p4":2,"git":1}"#);
        assert_eq!((a.multi_vcs, a.baseline.clone()), (1, BaselineCounts { observed: 2, estimated: 1 }));
    }

    #[test]
    fn item_of_mixed_vcs() {
        use atlas_core::vcs::{Revision, RevisionSource};
        use atlas_core::vcs_retention::RepoRetention;
        let r: SessionRetention = serde_json::from_value(serde_json::json!({
            "sessionId": "s", "outcome": "measured", "vcs": null, "root": null, "baseline": {"rev": "3", "source": "estimated"}, "evaluated": null,
            "hunks": [], "excludedHunks": 0, "counts": {"kept": 1, "modified": 0, "missing": 0, "unattributable": 0}, "lines": {"kept": 1, "modified": 0, "missing": 0, "unattributable": 0},
            "provenance": {"aiChanges": "events", "baseline": "estimated", "context": {}},
        }))
        .unwrap();
        // repos が無い古い結果は今までどおり
        let old = retention_item(&r, &[]);
        assert_eq!((old.vcs, old.vcs_kinds.clone(), old.baseline.as_deref()), (None, None, Some("estimated")));
        let repo = |vcs, root: &str, source| RepoRetention { vcs, root: root.into(), baseline: Some(Revision { rev: "1".into(), source }), evaluated: None };
        // そのリポジトリを指すまとまり(status は状態の名前)
        let hunk = |id: i64, vcs: VcsKind, root: &str, status: &str| -> atlas_core::vcs_retention::HunkRetention {
            let lines = if status == "kept" { serde_json::json!({"kept": 1, "modified": 0, "missing": 0, "unattributable": 0}) } else { serde_json::json!({"kept": 0, "modified": 0, "missing": 0, "unattributable": 1}) };
            serde_json::from_value(serde_json::json!({"id": id, "path": format!("{root}/f"), "status": status, "lines": lines, "vcs": vcs, "root": root})).unwrap()
        };
        let mut mixed = r.clone();
        mixed.repos = vec![repo(VcsKind::P4, "a", RevisionSource::Observed), repo(VcsKind::Svn, "t", RevisionSource::Estimated)];
        mixed.hunks = vec![hunk(1, VcsKind::P4, "a", "kept"), hunk(2, VcsKind::Svn, "t", "kept")];
        let it = retention_item(&mixed, &[]);
        assert_eq!((it.vcs_kinds.clone(), it.baseline.as_deref()), (Some(vec![VcsKind::Svn, VcsKind::P4]), Some("estimated")));
        assert!(atlas_core::json::to_js_string(&it).unwrap().contains(r#""vcs":null,"vcsKinds":["svn","p4"],"baseline":"estimated""#));
        // 照合不可のまとまりだけのリポジトリ(svn)は数えない
        mixed.hunks[1] = hunk(2, VcsKind::Svn, "t", "unattributable");
        let it = retention_item(&mixed, &[]);
        assert_eq!((it.vcs_kinds.clone(), it.baseline.as_deref()), (Some(vec![VcsKind::P4]), Some("observed")));
        // セッションの vcs だけと同じなら、種類は持たない(埋め込みを増やさない)
        let mut single = r.clone();
        single.vcs = Some(VcsKind::Git);
        single.repos = vec![repo(VcsKind::Git, "g", RevisionSource::Observed)];
        single.hunks = vec![hunk(1, VcsKind::Git, "g", "kept")];
        let it = retention_item(&single, &[]);
        assert_eq!((it.vcs_kinds, it.baseline.as_deref()), (None, Some("observed")));
    }

    #[test]
    fn by_phase_counts_sessions_with_measured_hunks() {
        let with = |ps: Vec<[i64; 5]>| item(|r| r.phases = Some(ps));
        let list = [
            Some(with(vec![[0, 1, 0, 0, 0], [2, 1, 0, 1, 0]])),
            Some(with(vec![[2, 0, 1, 0, 0]])),
            // 照合不可のまとまりだけの工程は、セッションに数えない(まとまりは足す)
            Some(with(vec![[2, 0, 0, 0, 3]])),
            // すべて照合不可のセッションと、工程の記録が無いセッションは入れない
            Some(item(|r| {
                r.outcome = "unattributable".into();
                r.phases = Some(vec![[2, 0, 0, 0, 1]]);
            })),
            Some(item(|_| {})),
            None,
        ];
        let p = retention_by_phase(list.iter().map(Option::as_ref));
        assert_eq!(p.by_phase.get(&2), Some(&[1, 1, 1, 3]));
        assert_eq!((p.sessions.get(&0), p.sessions.get(&2)), (Some(&1), Some(&2)));
        assert_eq!(p.without_phases, 1);
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
