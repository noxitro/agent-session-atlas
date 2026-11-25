//! 判定のぶれ: 同じセッションを、入力が変わらないまま判定し直したときの、工数の判定(judgments.json)の一致。
//! 値はここ(Rust)で決めて埋め込み、画面は出すだけ(数え直さない)。1 つの点数にせず、ほかの値とも混ぜない。
//!
//! - 組: セッションごとに、今の判定と、判定の履歴(judgments-history.json)のうち最も新しいもの(今の判定と同じ日時・同じ中身のものは除く)。
//!   2 つの判定の日時(judge.ranAt)がどちらもセッションの終わり(updatedAt)より後のときだけ組にする(入力が変わったかもしれないものは比べない)。
//!   終わりの分からないセッションは入れない。外したものは理由ごとに数える
//! - 達成(aiOutcome.completed)の一致率・成果の質(1〜5)と手戻り(0〜5)の差の中央値は、確信度に関わらずすべての組で数える
//! - 推定人手工数(humanEffort.hours)は、推定人手工数の合計と同じ決まりで、確信度の低い推定(aggregate::is_low_confidence)を
//!   どちらかに含む組を入れない。大きい方 ÷ 小さい方の中央値と 75 パーセンタイル(どちらも 0 なら 1。片方だけ 0 は比を出せないので数を分ける)、
//!   新しい判定の時間が古い判定の幅(low〜high)に入った割合
//! - 割合と中央値は、その値を数えた組が insights::thresholds::MIN_SESSIONS に届いたときだけ出す(届かなければ数だけ)
//! - 分位は、昇順に並べた ceil(p·n) 番目(exec::quantile_sorted。集計明細の中央値・p90 と同じ決め方)
//! - 依頼ごとの判定(turn-judgments.json)は扱わない

use crate::aggregate::is_low_confidence;
use crate::exec::{quantile_sorted, sort_nums};
use crate::types::JudgmentSummary;
use serde::Serialize;
use std::collections::HashMap;

/// 割合・中央値を出す組の数の下限(率を出す所に共通の下限。どこかの環境の件数に合わせたものではない)
pub const REPEATS_MIN_PAIRS: usize = crate::insights::thresholds::MIN_SESSIONS;

/// 組にするセッション 1 件
pub struct RepeatSession<'a> {
    pub id: &'a str,
    /// セッションの終わり(ミリ秒。updatedAt)
    pub end_ms: Option<i64>,
}

/// 組の片側(1 回の判定)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatSide {
    pub ran_at: String,
    pub model: Option<String>,
    pub completed: Option<bool>,
    pub hours: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub confidence: Option<f64>,
    pub quality: Option<f64>,
    pub rework: Option<f64>,
}

impl RepeatSide {
    fn of(j: &JudgmentSummary, ran_at: &str) -> Self {
        RepeatSide { ran_at: ran_at.to_string(), model: j.model.clone(), completed: j.completed, hours: j.hours, low: j.low, high: j.high, confidence: j.confidence, quality: j.quality, rework: j.rework }
    }
}

/// 組 1 つ(古い方と新しい方。判定の日時の順。同じなら履歴の方を古い方にする)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatPair {
    pub session_id: String,
    pub older: RepeatSide,
    pub newer: RepeatSide,
}

/// 履歴はあるが組にしなかったセッションの数(理由ごと)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatsExcluded {
    /// セッションの終わりが分からない
    pub no_end: usize,
    /// どちらかの判定の日時が分からない(項目に judge の無い古い判定など)
    pub no_ran_at: usize,
    /// どちらかの判定が、セッションの終わりより前(後から記録が続き、入力が変わったかもしれない)
    pub before_end: usize,
    /// 今の判定が無い(履歴だけがある)
    pub no_current: usize,
}

/// 一致の割合(数えた組 n のうち一致した agree。n が下限に届かなければ rate は None)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgreeRate {
    pub n: usize,
    pub agree: usize,
    pub rate: Option<f64>,
}

/// 差の中央値(数えた組 n。下限に届かなければ None)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffMedian {
    pub n: usize,
    pub median_abs_diff: Option<f64>,
}

/// 推定人手工数の一致
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoursAgreement {
    /// 数えた組(どちらの推定も確信度が低くない)
    pub n: usize,
    /// 確信度の低い推定をどちらかに含むので外した組
    pub low_confidence: usize,
    /// 大きい方 ÷ 小さい方を数えた組(片方だけ 0 のものを除く)と、その中央値・75 パーセンタイル
    pub ratio_n: usize,
    pub ratio_median: Option<f64>,
    pub ratio_p75: Option<f64>,
    /// 片方だけ 0 時間で、比を出せない組
    pub one_zero: usize,
    /// 新しい判定の時間が、古い判定の幅(low〜high)に入ったか(古い判定に幅のある組だけ)
    pub inside: AgreeRate,
}

/// 判定のぶれの節(ReportData.judgmentRepeats)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentRepeats {
    /// 組の数
    pub pairs: usize,
    /// 2 つの判定のモデルが同じ・違う・どちらかが分からない組
    pub same_model: usize,
    pub different_model: usize,
    pub unknown_model: usize,
    /// 割合と中央値を出す下限(REPEATS_MIN_PAIRS)
    pub min: usize,
    /// 履歴にある判定の数(このレポートのセッションの分)と、履歴のあるセッションの数
    pub history_items: usize,
    pub history_sessions: usize,
    pub excluded: RepeatsExcluded,
    /// 達成(aiOutcome.completed)が同じだったか(どちらにも値のある組。確信度に関わらず)
    pub completed: AgreeRate,
    pub hours: HoursAgreement,
    /// 成果の質(1〜5)と手戻り(0〜5)の差の絶対値の中央値(確信度に関わらず)
    pub quality: DiffMedian,
    pub rework: DiffMedian,
}

fn ms(iso: &str) -> Option<i64> {
    atlas_core::jsdate::parse_ms(iso)
}

/// 判定がセッションの終わりより後か(入力が変わっていようがない判定か)。終わりか判定の日時が分からなければ false。
/// 組にする決まり(compute_repeats)と、判定し直すセッションの選び方(atlas_judge::rejudge)が同じこの関数を使う
pub fn judged_after_end(end_ms: Option<i64>, ran_at: Option<&str>) -> bool {
    matches!((end_ms, ran_at.and_then(ms)), (Some(end), Some(at)) if end < at)
}

/// 今の判定と組にする履歴(同じセッションの履歴のうち、判定の日時がいちばん新しいもの。今の判定と同じもの(is_current)は除く。
/// 日時の同じものは後に書いた方。日時の読めるものが無ければ、後に書いたもの)。
/// 履歴は書いた順だが、共有の置き場に前の出力先の履歴を移したときなど、書いた順が判定の順と違うことがあるので、日時で選ぶ
pub fn latest_history<'a, T: 'a>(entries: impl IntoIterator<Item = &'a T>, ran_at: impl Fn(&'a T) -> Option<&'a str>, is_current: impl Fn(&'a T) -> bool) -> Option<&'a T> {
    let mut best: Option<(&T, Option<i64>)> = None;
    for e in entries {
        if is_current(e) {
            continue;
        }
        let t = ran_at(e).and_then(ms);
        let take = match best {
            None => true,
            Some((_, bt)) => match (t, bt) {
                (Some(a), Some(b)) => a >= b,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => true,
            },
        };
        if take {
            best = Some((e, t));
        }
    }
    best.map(|(e, _)| e)
}

fn rate(agree: usize, n: usize) -> AgreeRate {
    AgreeRate { n, agree, rate: (n >= REPEATS_MIN_PAIRS && n > 0).then(|| agree as f64 / n as f64) }
}

fn q(xs: &[f64], p: f64) -> Option<f64> {
    if xs.len() < REPEATS_MIN_PAIRS {
        return None;
    }
    quantile_sorted(&sort_nums(xs), p)
}

fn diff(pairs: &[RepeatPair], f: impl Fn(&RepeatSide) -> Option<f64>) -> DiffMedian {
    let d: Vec<f64> = pairs.iter().filter_map(|p| Some((f(&p.older)? - f(&p.newer)?).abs())).collect();
    DiffMedian { n: d.len(), median_abs_diff: q(&d, 0.5) }
}

/// 組を作り、一致を数える。sessions はこのレポートのセッション、current は今の判定、history は判定の履歴(書いた順)
pub fn compute_repeats(sessions: &[RepeatSession<'_>], current: &indexmap::IndexMap<String, JudgmentSummary>, history: &[(String, JudgmentSummary)]) -> (Vec<RepeatPair>, JudgmentRepeats) {
    let mut by: HashMap<&str, Vec<&JudgmentSummary>> = HashMap::new();
    for (id, j) in history {
        by.entry(id.as_str()).or_default().push(j);
    }
    let mut ex = RepeatsExcluded::default();
    let mut pairs: Vec<RepeatPair> = Vec::new();
    let (mut history_items, mut history_sessions) = (0, 0);
    for s in sessions {
        let Some(hist) = by.get(s.id) else { continue };
        history_items += hist.len();
        history_sessions += 1;
        let Some(cur) = current.get(s.id) else {
            ex.no_current += 1;
            continue;
        };
        // 今の判定と同じもの(同じ日時・同じ中身。履歴を書いた後、本体を書く前に止まったときに残る)は比べない
        let Some(prev) = latest_history(hist.iter().copied(), |h| h.ran_at.as_deref(), |h| h == cur) else { continue };
        let (Some(a), Some(b)) = (prev.ran_at.as_deref().filter(|x| ms(x).is_some()), cur.ran_at.as_deref().filter(|x| ms(x).is_some())) else {
            ex.no_ran_at += 1;
            continue;
        };
        let Some(end) = s.end_ms else {
            ex.no_end += 1;
            continue;
        };
        if !judged_after_end(Some(end), Some(a)) || !judged_after_end(Some(end), Some(b)) {
            ex.before_end += 1;
            continue;
        }
        let (older, newer) = if ms(b) < ms(a) { (RepeatSide::of(cur, b), RepeatSide::of(prev, a)) } else { (RepeatSide::of(prev, a), RepeatSide::of(cur, b)) };
        pairs.push(RepeatPair { session_id: s.id.to_string(), older, newer });
    }
    let (mut same, mut different, mut unknown) = (0, 0, 0);
    for p in &pairs {
        match (&p.older.model, &p.newer.model) {
            (Some(x), Some(y)) if x == y => same += 1,
            (Some(_), Some(_)) => different += 1,
            _ => unknown += 1,
        }
    }
    let both: Vec<(bool, bool)> = pairs.iter().filter_map(|p| Some((p.older.completed?, p.newer.completed?))).collect();
    let completed = rate(both.iter().filter(|(x, y)| x == y).count(), both.len());

    let mut low_confidence = 0;
    let mut ratios: Vec<f64> = Vec::new();
    let mut one_zero = 0;
    let (mut inside_n, mut inside) = (0, 0);
    let mut n = 0;
    for p in &pairs {
        let (Some(ho), Some(hn)) = (p.older.hours, p.newer.hours) else { continue };
        if is_low_confidence(p.older.confidence) || is_low_confidence(p.newer.confidence) {
            low_confidence += 1;
            continue;
        }
        n += 1;
        let (lo, hi) = (ho.min(hn), ho.max(hn));
        if hi == 0.0 {
            ratios.push(1.0);
        } else if lo == 0.0 {
            one_zero += 1;
        } else {
            ratios.push(hi / lo);
        }
        if let (Some(l), Some(h)) = (p.older.low, p.older.high) {
            inside_n += 1;
            if l <= hn && hn <= h {
                inside += 1;
            }
        }
    }
    let hours = HoursAgreement { n, low_confidence, ratio_n: ratios.len(), ratio_median: q(&ratios, 0.5), ratio_p75: q(&ratios, 0.75), one_zero, inside: rate(inside, inside_n) };
    let summary = JudgmentRepeats {
        pairs: pairs.len(),
        same_model: same,
        different_model: different,
        unknown_model: unknown,
        min: REPEATS_MIN_PAIRS,
        history_items,
        history_sessions,
        excluded: ex,
        completed,
        hours,
        quality: diff(&pairs, |s| s.quality),
        rework: diff(&pairs, |s| s.rework),
    };
    (pairs, summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn j(ran_at: Option<&str>, model: &str, hours: f64, conf: f64, completed: bool, quality: f64, rework: f64) -> JudgmentSummary {
        JudgmentSummary {
            hours: Some(hours),
            low: Some(hours / 2.0),
            high: Some(hours * 2.0),
            confidence: Some(conf),
            completed: Some(completed),
            quality: Some(quality),
            rework: Some(rework),
            model: Some(model.to_string()),
            ran_at: ran_at.map(str::to_string),
            ..Default::default()
        }
    }

    const END: &str = "2026-11-10T00:00:00Z";
    const OLD: &str = "2026-11-11T00:00:00Z";
    const NEW: &str = "2026-11-12T00:00:00Z";

    fn sessions(ids: &[String]) -> Vec<RepeatSession<'_>> {
        ids.iter().map(|id| RepeatSession { id, end_ms: ms(END) }).collect()
    }

    /// 組は、どちらの判定もセッションの終わりの後のときだけ。外したものは理由ごとに数える。下限に届かなければ割合・中央値を出さない
    #[test]
    fn pairs_need_both_judgments_after_the_end() {
        let ids: Vec<String> = ["ok", "before", "no-end", "no-ran-at", "only-history", "same-as-current", "no-history"].iter().map(|s| s.to_string()).collect();
        let mut s = sessions(&ids);
        s[2].end_ms = None;
        let mut cur: IndexMap<String, JudgmentSummary> = IndexMap::new();
        let mut hist: Vec<(String, JudgmentSummary)> = Vec::new();
        let base = |at: &str| j(Some(at), "m", 2.0, 0.8, true, 4.0, 1.0);
        for id in ["ok", "no-end", "no-ran-at"] {
            cur.insert(id.into(), base(NEW));
            hist.push((id.into(), j(Some(OLD), "m", 3.0, 0.8, true, 4.0, 1.0)));
        }
        hist[2].1.ran_at = None;
        // 古い判定がセッションの終わりより前(その後に記録が続いた)
        cur.insert("before".into(), base(NEW));
        hist.push(("before".into(), base("2026-11-09T00:00:00Z")));
        hist.push(("only-history".into(), base(OLD)));
        // 履歴に今と同じもの(本体を書く前に止まった)だけがあるときは比べない
        cur.insert("same-as-current".into(), base(NEW));
        hist.push(("same-as-current".into(), base(NEW)));
        cur.insert("no-history".into(), base(NEW));
        let (pairs, r) = compute_repeats(&s, &cur, &hist);
        assert_eq!(pairs.iter().map(|p| p.session_id.as_str()).collect::<Vec<_>>(), ["ok"]);
        assert_eq!((pairs[0].older.ran_at.as_str(), pairs[0].newer.ran_at.as_str()), (OLD, NEW));
        assert_eq!(r.excluded, RepeatsExcluded { no_end: 1, no_ran_at: 1, before_end: 1, no_current: 1 });
        assert_eq!((r.pairs, r.history_items, r.history_sessions, r.min), (1, 6, 6, REPEATS_MIN_PAIRS));
        // 1 組では下限に届かない(数だけ)
        assert_eq!(r.completed, AgreeRate { n: 1, agree: 1, rate: None });
        assert_eq!((r.hours.n, r.hours.ratio_median, r.hours.inside.rate), (1, None, None));
        assert_eq!(r.quality, DiffMedian { n: 1, median_abs_diff: None });
    }

    /// 下限に届けば、達成の一致率・時間の比の中央値と 75 パーセンタイル・幅に入った割合・質と手戻りの差の中央値を出す。
    /// モデルの同じ・違う組を数え、確信度の低い推定を含む組は時間だけから外す。どちらも 0 なら比は 1、片方だけ 0 は数を分ける
    #[test]
    fn agreement_math() {
        let ids: Vec<String> = (0..8).map(|i| format!("s{i}")).collect();
        let s = sessions(&ids);
        let mut cur: IndexMap<String, JudgmentSummary> = IndexMap::new();
        let mut hist: Vec<(String, JudgmentSummary)> = Vec::new();
        // (古い時間, 新しい時間, 新しい達成, 新しい質, 新しいモデル, 新しい確信度)
        let rows: [(f64, f64, bool, f64, &str, f64); 8] = [
            (2.0, 2.0, true, 4.0, "m", 0.8),   // 比 1、幅の中
            (2.0, 3.0, true, 3.0, "m", 0.8),   // 比 1.5、幅の中(1〜4)
            (2.0, 6.0, false, 2.0, "m", 0.8),  // 比 3、幅の外
            (4.0, 2.0, true, 4.0, "m2", 0.8),  // 比 2、幅の中(2〜8)
            (1.0, 4.0, true, 5.0, "m2", 0.8),  // 比 4、幅の外(0.5〜2)
            (0.0, 0.0, true, 4.0, "m", 0.8),   // どちらも 0 → 比 1、幅の中(0〜0)
            (0.0, 1.0, true, 4.0, "m", 0.8),   // 片方だけ 0 → 比を出さない、幅の外
            (2.0, 8.0, false, 1.0, "m", 0.2),  // 確信度が低い → 時間だけ外す
        ];
        for (i, (ho, hn, c, qn, m, cn)) in rows.iter().enumerate() {
            hist.push((ids[i].clone(), j(Some(OLD), "m", *ho, 0.8, true, 4.0, 1.0)));
            cur.insert(ids[i].clone(), j(Some(NEW), m, *hn, *cn, *c, *qn, 2.0));
        }
        let (pairs, r) = compute_repeats(&s, &cur, &hist);
        assert_eq!(pairs.len(), 8);
        assert_eq!((r.same_model, r.different_model, r.unknown_model), (6, 2, 0));
        // 達成は 8 組中 6 組が同じ(確信度に関わらず)
        assert_eq!(r.completed, AgreeRate { n: 8, agree: 6, rate: Some(0.75) });
        assert_eq!((r.hours.n, r.hours.low_confidence, r.hours.one_zero, r.hours.ratio_n), (7, 1, 1, 6));
        // 比 [1, 1, 1.5, 2, 3, 4]: 中央値は ceil(0.5·6)=3 番目 → 1.5、75 パーセンタイルは ceil(0.75·6)=5 番目 → 3
        assert_eq!((r.hours.ratio_median, r.hours.ratio_p75), (Some(1.5), Some(3.0)));
        // 幅に入った: s0・s1・s3・s5 の 4 / 7
        assert_eq!(r.hours.inside, AgreeRate { n: 7, agree: 4, rate: Some(4.0 / 7.0) });
        // 質の差 [0, 1, 2, 0, 1, 0, 0, 3] → 並べて [0,0,0,0,1,1,2,3] の 4 番目 → 0。手戻りの差はどれも 1
        assert_eq!(r.quality, DiffMedian { n: 8, median_abs_diff: Some(0.0) });
        assert_eq!(r.rework, DiffMedian { n: 8, median_abs_diff: Some(1.0) });
        // モデルが分からない組
        let mut cur2 = cur.clone();
        cur2.get_mut("s0").unwrap().model = None;
        assert_eq!(compute_repeats(&s, &cur2, &hist).1.unknown_model, 1);
        // 今の判定の方が古い日時なら、古い方・新しい方を入れ替える(新しい判定の時間を、古い判定の幅で見る)
        let mut cur3 = cur.clone();
        cur3.get_mut("s2").unwrap().ran_at = Some("2026-11-10T12:00:00Z".into());
        let (p3, _) = compute_repeats(&s, &cur3, &hist);
        let x = p3.iter().find(|p| p.session_id == "s2").unwrap();
        assert_eq!((x.older.hours, x.newer.hours), (Some(6.0), Some(2.0)));
    }

    /// 組にする履歴は判定の日時で選ぶ(書いた順が判定の順と違っても。前の出力先の履歴を共有の置き場に移したときなど)
    #[test]
    fn uses_the_history_entry_with_the_latest_judgment_time() {
        let ids = vec!["a".to_string()];
        let s = sessions(&ids);
        let mut cur = IndexMap::new();
        cur.insert("a".to_string(), j(Some(NEW), "m", 2.0, 0.8, true, 4.0, 1.0));
        // 後に書いたのは古い判定(11/11)、先に書いたのが新しい判定(11/11 12:00)
        let hist = vec![("a".to_string(), j(Some("2026-11-11T12:00:00Z"), "m", 3.0, 0.8, true, 4.0, 1.0)), ("a".to_string(), j(Some(OLD), "m", 9.0, 0.8, true, 4.0, 1.0))];
        let (p, _) = compute_repeats(&s, &cur, &hist);
        assert_eq!(p[0].older.hours, Some(3.0));
        // 日時が同じなら後に書いた方、日時の読めないものは読めるものより後回し
        let at = |x: &'static (&'static str, Option<&'static str>)| x.1;
        static XS: [(&str, Option<&str>); 3] = [("first", Some(OLD)), ("second", Some(OLD)), ("none", None)];
        let xs = &XS;
        assert_eq!(latest_history(xs.iter(), at, |_| false).map(|x| x.0), Some("second"));
        assert_eq!(latest_history(xs.iter(), at, |x| x.0 == "second").map(|x| x.0), Some("first"));
        static ONLY_NONE: [(&str, Option<&str>); 1] = [("none", None)];
        let only_none = &ONLY_NONE;
        assert_eq!(latest_history(only_none.iter(), at, |_| false).map(|x| x.0), Some("none"));
        assert!(judged_after_end(ms(END), Some(OLD)));
        assert!(!judged_after_end(ms(END), Some(END)));
        assert!(!judged_after_end(None, Some(OLD)));
    }

    /// 最も新しい履歴と比べる(履歴が 2 つあれば、後に書いた方)
    #[test]
    fn uses_the_latest_history_entry() {
        let ids = vec!["a".to_string()];
        let s = sessions(&ids);
        let mut cur = IndexMap::new();
        cur.insert("a".to_string(), j(Some(NEW), "m", 2.0, 0.8, true, 4.0, 1.0));
        let hist = vec![("a".to_string(), j(Some(OLD), "m", 9.0, 0.8, true, 4.0, 1.0)), ("a".to_string(), j(Some("2026-11-11T12:00:00Z"), "m", 3.0, 0.8, true, 4.0, 1.0))];
        let (p, r) = compute_repeats(&s, &cur, &hist);
        assert_eq!(p[0].older.hours, Some(3.0));
        assert_eq!((r.history_items, r.history_sessions, r.pairs), (2, 1, 1));
    }
}
