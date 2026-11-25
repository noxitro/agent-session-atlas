//! タスクごとの工数(Rust だけで数える。画面はこの値を出すだけ)。
//! - AI を使った場合の工数(workMs): 紐づいたセッションのうち最も早い開始から、完了を確認した時刻までの、稼働時間帯に入る長さ。
//!   完了に変わるのを見たタスク(doneObserved)だけ。完了を確認した時刻より後に始まったセッション(手動か LLM で紐づけたときだけありうる)は、開始に使わない
//! - AI の実働(aiActiveMs): 紐づいたセッションの実働(activeMs)の合計
//! - AI を使わなかった場合の工数(humanHours): 紐づいたセッションの推定人手工数(LLM の判定)の合計。確信度の低い推定(aggregate::LOW_CONFIDENCE 以下)は入れない
//! - いくつかのタスクに紐づいたセッションの実働と推定人手工数は、数えるタスク(counted_tasks: 一覧にあり、完了を確認した後に
//!   始めたのではないタスク)の数で等分する(k 個なら 1/k ずつ)。数えないタスクには 0。
//!   合計がセッションの値を重ねて数えず、タスクの値を足すと、数えたセッションの値の合計になるように。
//!   セッションの数(判定済み・確度が低い・判定なしを含む)は等分しない(そのタスクに紐づいたセッションを 1 つずつ数える)。
//!   開始と稼働時間帯の工数は、タスクの始まりから完了までの長さなので等分しない
//!
//! 合計は「比べられるタスク」(完了の時刻が分かり、紐づいたセッションがすべて完了の前に始まり、開始から完了までが稼働時間帯に重なり、
//! 確信度の低くない推定を持つ)だけで出す。
//! 外したタスクは理由ごとに数える。完了の時刻の出所(記録: XML の完了日時・観測: 完了を見た書き出しの時刻)は、
//! 完了したタスクと比べられるタスクのそれぞれで件数を分けて出す(どちらも合計に入れる)。
//! 2 つの工数の比は、比べられるタスクが RATIO_MIN_TASKS 件に届いたときだけ出す(1 件だけで大きく動く値を出さない)。

use super::extras::{task_extras, SessionExtra, TaskFriction, TaskVerdicts, VERDICT_RATE_MIN_TURNS};
use super::hours::{work_overlap_ms, WorkHours};
use super::links::LinkSource;
pub use super::state::DoneAtSource;
use crate::aggregate::is_low_confidence;
use serde::Serialize;
use std::collections::HashMap;

/// 比を出す、比べられるタスクの数の下限。率を出す所に共通の下限(insights の MIN_SESSIONS)と同じ数にする。
/// 表示の決まりで、どこかの環境の件数に合わせたものではない
pub const RATIO_MIN_TASKS: usize = crate::insights::thresholds::MIN_SESSIONS;

/// タスク 1 件(tasks.json の状態か、送った人の記録から作ったもの)
#[derive(Debug, Clone, PartialEq)]
pub struct TaskInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub done: bool,
    pub done_at: Option<String>,
    /// 完了の時刻が分かる(未完了から完了に変わるのを見たか、XML に完了日時の記録があった。初めて見たときに完了していて記録も無ければ false)
    pub done_observed: bool,
    /// 完了の時刻の出所(完了していて時刻があるときだけ)
    pub done_at_source: Option<DoneAtSource>,
    /// 日付だけの完了日の、暦の日付の文字("YYYY-MM-DD")。工数はその日の稼働時間帯の終わりまで、「完了の後に始まった」はその日の終わりで見る
    /// (どちらもこの日付と、集計する PC の時間帯から決める)。時刻つきの完了なら None
    pub done_date: Option<String>,
    pub missing: bool,
    /// 送った人が数えた開始(紐づいたセッションのうち最も早い開始)。手元のセッションの開始と早い方を使う
    pub start_hint: Option<String>,
}

impl TaskInfo {
    /// 「完了の後に始まった」の判定に使う完了の時刻(完了していなければ None。日付だけの完了日は、その日の終わり)
    pub fn done_cutoff_ms(&self) -> Option<i64> {
        if !self.done {
            return None;
        }
        super::state::done_cutoff(self.done_at.as_deref(), self.done_date.as_deref())
    }

    /// 工数(稼働時間帯の長さ)を数える終わり(完了していなければ None。日付だけの完了日は、その日の稼働時間帯の終わり)
    pub fn done_work_end_ms(&self, wh: &WorkHours) -> Option<i64> {
        if !self.done {
            return None;
        }
        super::state::done_work_end(self.done_at.as_deref(), self.done_date.as_deref(), wh)
    }
}

/// セッション 1 件の推定人手工数(LLM の判定)
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HumanEstimate {
    /// 時間
    pub hours: f64,
    /// 確信度(0〜1)
    pub confidence: Option<f64>,
    /// 推定の幅(humanEffort.low・high。時間)。無い判定もある
    pub low: Option<f64>,
    pub high: Option<f64>,
}

impl From<(f64, Option<f64>)> for HumanEstimate {
    /// 時間と確信度だけ(幅なし)
    fn from((hours, confidence): (f64, Option<f64>)) -> Self {
        HumanEstimate { hours, confidence, low: None, high: None }
    }
}

/// セッション 1 件の、工数に使う値
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionFacts {
    pub start_ms: Option<i64>,
    pub active_ms: Option<f64>,
    /// 推定人手工数。判定が無ければ None
    pub human: Option<HumanEstimate>,
    /// タスクの表の、工数のほかの列(人数・主なモデル・摩擦・依頼ごとの判定)に使う値
    pub extra: SessionExtra,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SourceCounts {
    pub machine: usize,
    pub llm: usize,
    pub manual: usize,
}

impl SourceCounts {
    fn add(&mut self, s: LinkSource) {
        match s {
            LinkSource::Machine => self.machine += 1,
            LinkSource::Llm => self.llm += 1,
            LinkSource::Manual => self.manual += 1,
        }
    }
}

/// 比べられるタスクから外した理由(優先する順)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Excluded {
    /// まだ完了していない
    NotDone,
    /// 初めて見たときに完了していた(完了に変わった時刻が分からない)
    DoneUnobserved,
    /// 完了を確認した時刻より後に始まったセッションが紐づいている(手動か LLM の紐づけ)
    AfterDone,
    /// 紐づいたセッションの開始の時刻が分からない
    NoStart,
    /// 開始から完了までが稼働時間帯に重ならない(AI を使った場合の工数が 0 時間になる。稼働日でない日だけ・稼働時間帯の外だけで作業して完了した、
    /// 日付だけの完了日で、その日の稼働時間帯の終わりより後に始めた、など)
    NoWorkHours,
    /// 推定人手工数の判定が無いセッションがある
    Unjudged,
    /// 確信度の低い推定のセッションがある
    LowConfidence,
}

impl Excluded {
    pub fn label(self) -> &'static str {
        match self {
            Excluded::NotDone => "未完了",
            Excluded::DoneUnobserved => "完了の時刻が分からない",
            Excluded::NoStart => "開始が分からない",
            Excluded::AfterDone => "完了の後に始まったセッション",
            Excluded::NoWorkHours => "稼働時間帯に重ならない",
            Excluded::Unjudged => "判定なし",
            Excluded::LowConfidence => "確度が低い",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub done: bool,
    pub done_at: Option<String>,
    pub done_observed: bool,
    /// 完了の時刻の出所(記録・観測。未完了なら null)
    pub done_at_source: Option<DoneAtSource>,
    /// 日付だけの完了日の、暦の日付の文字("YYYY-MM-DD"。画面と tasks.csv はこれをそのまま出す)。時刻つきなら書かない。
    /// このとき done_at は、集計した PC の時間帯での、その日の稼働時間帯の終わり(工数を数えた終わり)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_date: Option<String>,
    pub missing: bool,
    /// 紐づいたセッションのうち最も早い開始(ISO。完了を確認した時刻より後に始まったセッションは使わない)
    pub start: Option<String>,
    /// AI を使った場合の工数(稼働時間帯のミリ秒)。完了に変わるのを見ていなければ null
    pub work_ms: Option<f64>,
    /// AI の実働(ミリ秒。いくつかのタスクに紐づいたセッションは、タスクの数で等分した分)
    pub ai_active_ms: f64,
    /// AI を使わなかった場合の工数(推定人手工数の時間。確信度の低い推定は入れない。いくつかのタスクに紐づいたセッションは等分した分)
    pub human_hours: f64,
    /// 推定の幅(humanEffort.low・high)の合計。human_hours と同じ数え方(同じ確信度の決まり・同じ等分)。
    /// 数えたセッションのどれかに幅が無ければ null(幅の一部だけを足した値を出さない)
    pub human_low: Option<f64>,
    pub human_high: Option<f64>,
    /// このタスクの比(human_hours ÷ AI を使った場合の工数の時間)。比べられるタスクだけ。ほかは null
    pub ratio: Option<f64>,
    pub sessions: usize,
    /// このタスクに数えたセッションのうち、ほかのタスクにも数えたもの(共有のセッション。値を等分した。counted_tasks)
    pub shared_sessions: usize,
    pub judged_sessions: usize,
    pub low_confidence_sessions: usize,
    pub unjudged_sessions: usize,
    /// 完了を確認した時刻より後に始まったセッションの数
    pub after_done_sessions: usize,
    /// 紐づけの出所ごとのセッション数
    pub links: SourceCounts,
    /// 比べられるタスクか
    pub comparable: bool,
    /// 比べられないときの理由
    pub excluded: Option<Excluded>,
    /// 紐づいたセッションの人数(人の記録のあるセッションの、人の数)。どのセッションにも人の記録が無ければ null(extras.rs)
    pub people: Option<usize>,
    /// 主なモデル(紐づいたセッションの本体のリクエストがいちばん多いモデル)と、その割合(0〜1)。記録が無ければ null
    pub main_model: Option<String>,
    pub main_model_share: Option<f64>,
    /// 摩擦(紐づいたセッションの、ツールの失敗・拒否・中断・文脈圧縮の数。等分しない)
    pub friction: TaskFriction,
    /// 依頼ごとの判定(紐づいたセッションの和。等分しない)。判定した依頼が無ければ null
    pub verdicts: Option<TaskVerdicts>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedCounts {
    pub not_done: usize,
    pub done_unobserved: usize,
    pub no_start: usize,
    pub after_done: usize,
    pub no_work_hours: usize,
    pub unjudged: usize,
    pub low_confidence: usize,
}

/// 完了の時刻の出所ごとの数
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DoneAtCounts {
    pub recorded: usize,
    pub observed: usize,
}

impl DoneAtCounts {
    fn add(&mut self, s: Option<DoneAtSource>) {
        match s {
            Some(DoneAtSource::Recorded) => self.recorded += 1,
            Some(DoneAtSource::Observed) => self.observed += 1,
            None => {}
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    /// セッションが紐づいたタスクの数
    pub tasks: usize,
    /// そのうち完了したもの
    pub done_tasks: usize,
    /// 完了したもの(done_tasks)の、完了の時刻の出所ごとの数
    pub done_sources: DoneAtCounts,
    /// 比べられるタスクの数
    pub included: usize,
    /// 比べられるタスク(included)の、完了の時刻の出所ごとの数
    pub included_sources: DoneAtCounts,
    pub excluded: ExcludedCounts,
    /// 比べられるタスクの合計
    pub work_ms: f64,
    pub human_hours: f64,
    pub ai_active_ms: f64,
    /// 紐づいたセッションの AI の実働の合計(比べられないタスクも入れる)
    pub ai_active_ms_all: f64,
    /// いくつかのタスクに数えたセッションの数(値をタスクの数で等分したもの。重ねて数えない。counted_tasks)
    pub shared_sessions: usize,
    /// AI を使わなかった場合 ÷ AI を使った場合(比べられるタスクが ratio_min に届いたときだけ)
    pub ratio: Option<f64>,
    /// 比べられるタスクごとの比のばらつき(ratio と同じ条件のときだけ)
    pub ratio_spread: Option<RatioSpread>,
    /// 推定の幅で見た比: 比べられるタスクの human_low の合計 ÷ 工数の合計、human_high の合計 ÷ 工数の合計
    /// (ratio と同じ条件で、比べられるタスクのどれにも幅があるときだけ)
    pub ratio_low: Option<f64>,
    pub ratio_high: Option<f64>,
    pub ratio_min: usize,
    /// タスクごとの依頼ごとの判定の割合を出す、分母の依頼の数の下限(extras::VERDICT_RATE_MIN_TURNS)
    pub verdict_min: usize,
}

/// 比べられるタスクごとの比(推定人手工数 ÷ AI を使った場合の工数)のばらつき。分位は昇順に並べた ceil(p·n) 番目(exec::quantile_sorted)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatioSpread {
    /// 数えたタスク(比べられるタスクのうち、工数が 0 より大きいもの)
    pub tasks: usize,
    pub median: f64,
    pub p25: f64,
    pub p75: f64,
    /// 比が 1 より小さい(AI を使った場合の工数の方が長い)タスクの数
    pub below_one: usize,
}

/// セッションの値をタスクに分ける割合(数えるタスクの数 k なら 1/k)
pub fn share_of(k: usize) -> f64 {
    if k == 0 { 0.0 } else { 1.0 / k as f64 }
}

/// 完了を確認した時刻より後に始まったセッションか(そのタスクの開始に使わず、工数にも数えない。始めた時刻か完了の時刻が分からなければ false)。
/// 日付だけの完了日は、その日の終わり(24:00)より後に始まったものだけ
pub fn started_after_done(t: &TaskInfo, start_ms: Option<i64>) -> bool {
    matches!((start_ms, t.done_cutoff_ms()), (Some(s), Some(d)) if s > d)
}

/// セッションの実働と推定人手工数を数えるタスク(等分の相手。ここが 1 か所の決まり):
/// 紐づいたタスクのうち、タスクの一覧(tasks)にあり、そのタスクの完了を確認した後に始まったのではないもの。並びは紐づけの順で、重なりは除く。
/// 一覧に無いタスク(tasks.json に無い ID・送った人の記録で形の違ったもの)と、完了の後に始まったタスクには数えない。
/// 数えるタスクが k 個なら、それぞれに 1/k ずつ(k が 0 ならどこにも数えない)
pub fn counted_tasks<'a>(task_ids: impl IntoIterator<Item = &'a str>, tasks: &HashMap<&str, &TaskInfo>, start_ms: Option<i64>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for id in task_ids {
        if out.contains(&id) {
            continue;
        }
        if tasks.get(id).is_some_and(|t| !started_after_done(t, start_ms)) {
            out.push(id);
        }
    }
    out
}

/// タスクごとの工数と合計。links は (セッション id, タスク id, 出所) の組(1 つのセッションがいくつかのタスクに紐づけば、その数だけ組がある)。
/// 返す行は tasks の順で、紐づいたセッションが無いタスクも入れる(数は 0)。
/// セッションの実働と推定人手工数は、counted_tasks のタスクに等分する(タスクの値を足すと、数えたセッションの値の合計になる)
pub fn compute_task_metrics(tasks: &[TaskInfo], links: &[(String, String, LinkSource)], facts: &HashMap<String, SessionFacts>, wh: &WorkHours) -> (Vec<TaskRow>, TaskSummary) {
    let mut by_task: HashMap<&str, Vec<(&str, LinkSource)>> = HashMap::new();
    // セッションごとの、紐づいたタスク(並びは組の順。同じ組が重なっていても 1 つ)
    let mut per_session: indexmap::IndexMap<&str, Vec<&str>> = indexmap::IndexMap::new();
    for (sid, tid, src) in links {
        let ids = per_session.entry(sid.as_str()).or_default();
        if !ids.contains(&tid.as_str()) {
            ids.push(tid.as_str());
            by_task.entry(tid.as_str()).or_default().push((sid.as_str(), *src));
        }
    }
    let by_id: HashMap<&str, &TaskInfo> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let empty = SessionFacts::default();
    // セッションごとの、数えるタスク
    let counted: HashMap<&str, Vec<&str>> = per_session.iter().map(|(sid, ids)| (*sid, counted_tasks(ids.iter().copied(), &by_id, facts.get(*sid).and_then(|f| f.start_ms)))).collect();
    let mut rows = Vec::with_capacity(tasks.len());
    let mut sum = TaskSummary { ratio_min: RATIO_MIN_TASKS, verdict_min: VERDICT_RATE_MIN_TURNS, ..Default::default() };
    for t in tasks {
        let linked = by_task.get(t.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let mut row = TaskRow {
            id: t.id.clone(),
            name: t.name.clone(),
            status: t.status.clone(),
            done: t.done,
            done_at: t.done_at.clone(),
            done_observed: t.done_observed,
            done_at_source: t.done_at_source.filter(|_| t.done && t.done_at.is_some()),
            done_date: t.done_date.clone().filter(|_| t.done && t.done_at.is_some()),
            missing: t.missing,
            start: None,
            work_ms: None,
            ai_active_ms: 0.0,
            human_hours: 0.0,
            human_low: Some(0.0),
            human_high: Some(0.0),
            ratio: None,
            sessions: linked.len(),
            shared_sessions: 0,
            judged_sessions: 0,
            low_confidence_sessions: 0,
            unjudged_sessions: 0,
            after_done_sessions: 0,
            links: SourceCounts::default(),
            comparable: false,
            excluded: None,
            people: None,
            main_model: None,
            main_model_share: None,
            friction: TaskFriction::default(),
            verdicts: None,
        };
        // 人数・主なモデル・摩擦・依頼ごとの判定は、紐づいたセッションすべてを 1 つずつ数える(等分しない。セッションの数と同じ数え方)
        let ex = task_extras(linked.iter().map(|(sid, _)| facts.get(*sid).map_or(&empty.extra, |f| &f.extra)));
        row.people = ex.people;
        row.main_model = ex.main_model;
        row.main_model_share = ex.main_model_share;
        row.friction = ex.friction;
        row.verdicts = ex.verdicts;
        // 工数(稼働時間帯の長さ)は完了の時刻まで(日付だけの完了日は、その日付の稼働時間帯の終わり。集計する PC の時間帯)
        let done_ms = t.done_work_end_ms(wh);
        if row.done_date.is_some() {
            row.done_at = done_ms.map(atlas_core::jsdate::to_iso);
        }
        // 完了を確認した時刻より後の開始は、開始に使わない(日付だけの完了日は、その日の終わりまでに始めたものを使う)
        let cutoff = t.done_cutoff_ms();
        let before_done = |s: i64| cutoff.is_none_or(|d| s <= d);
        let mut start: Option<i64> = t.start_hint.as_deref().and_then(atlas_core::jsdate::parse_ms).filter(|s| before_done(*s));
        for (sid, src) in linked {
            let f = facts.get(*sid).unwrap_or(&empty);
            let mine = counted.get(sid).map(Vec::as_slice).unwrap_or(&[]);
            let k = mine.len();
            let counts_here = mine.contains(&t.id.as_str());
            // 等分は k で割る(1/k を掛けるより丸めの誤差が出にくい)。このタスクに数えないセッションは 0
            let split = |x: f64| if counts_here { x / k as f64 } else { 0.0 };
            if counts_here && k > 1 {
                row.shared_sessions += 1;
            }
            row.links.add(*src);
            if let Some(s) = f.start_ms {
                if before_done(s) {
                    start = Some(start.map_or(s, |x| x.min(s)));
                } else {
                    row.after_done_sessions += 1;
                }
            }
            row.ai_active_ms += split(f.active_ms.unwrap_or(0.0));
            match f.human {
                None => row.unjudged_sessions += 1,
                Some(h) if is_low_confidence(h.confidence) => {
                    row.judged_sessions += 1;
                    row.low_confidence_sessions += 1;
                }
                Some(h) => {
                    row.judged_sessions += 1;
                    row.human_hours += split(h.hours);
                    // 幅も時間と同じく等分して足す。数えるセッションに幅が無ければ、このタスクの幅は出さない
                    if counts_here {
                        row.human_low = row.human_low.zip(h.low).map(|(a, b)| a + split(b));
                        row.human_high = row.human_high.zip(h.high).map(|(a, b)| a + split(b));
                    }
                }
            }
        }
        row.start = start.map(atlas_core::jsdate::to_iso);
        // 開始から完了までが稼働時間帯に重ならなければ(稼働日でない日だけ・稼働時間帯の外だけで作業して完了した、日付だけの完了日で
        // その日の稼働時間帯の終わりより後に始めた、など)、工数は 0 時間になる。その 0 時間は出さず、比べない(理由は「稼働時間帯に重ならない」)
        let mut no_work_hours = false;
        if let (true, Some(s), Some(d)) = (t.done_observed, start, done_ms) {
            let w = work_overlap_ms(s, d, wh);
            if w > 0.0 {
                row.work_ms = Some(w);
            } else {
                no_work_hours = true;
            }
        }
        if !linked.is_empty() {
            sum.tasks += 1;
            sum.ai_active_ms_all += row.ai_active_ms;
            if t.done {
                sum.done_tasks += 1;
                sum.done_sources.add(row.done_at_source);
            }
            row.excluded = if !t.done || done_ms.is_none() {
                Some(Excluded::NotDone)
            } else if !t.done_observed {
                Some(Excluded::DoneUnobserved)
            } else if row.after_done_sessions > 0 {
                Some(Excluded::AfterDone)
            } else if start.is_none() {
                Some(Excluded::NoStart)
            } else if no_work_hours {
                Some(Excluded::NoWorkHours)
            } else if row.unjudged_sessions > 0 {
                Some(Excluded::Unjudged)
            } else if row.low_confidence_sessions > 0 {
                Some(Excluded::LowConfidence)
            } else {
                None
            };
            match row.excluded {
                None => {
                    row.comparable = true;
                    row.ratio = row.work_ms.filter(|w| *w > 0.0).map(|w| row.human_hours / (w / 3_600_000.0));
                    sum.included += 1;
                    sum.included_sources.add(row.done_at_source);
                    sum.work_ms += row.work_ms.unwrap_or(0.0);
                    sum.human_hours += row.human_hours;
                    sum.ai_active_ms += row.ai_active_ms;
                }
                Some(Excluded::NotDone) => sum.excluded.not_done += 1,
                Some(Excluded::DoneUnobserved) => sum.excluded.done_unobserved += 1,
                Some(Excluded::NoStart) => sum.excluded.no_start += 1,
                Some(Excluded::AfterDone) => sum.excluded.after_done += 1,
                Some(Excluded::NoWorkHours) => sum.excluded.no_work_hours += 1,
                Some(Excluded::Unjudged) => sum.excluded.unjudged += 1,
                Some(Excluded::LowConfidence) => sum.excluded.low_confidence += 1,
            }
        }
        rows.push(row);
    }
    sum.shared_sessions = counted.values().filter(|c| c.len() > 1).count();
    if sum.included >= RATIO_MIN_TASKS && sum.work_ms > 0.0 {
        let work_h = sum.work_ms / 3_600_000.0;
        sum.ratio = Some(sum.human_hours / work_h);
        // タスクごとの比のばらつき(合計どうしの比と同じ条件のときだけ)
        let ratios: Vec<f64> = rows.iter().filter(|r| r.comparable).filter_map(|r| r.ratio).collect();
        let sorted = crate::exec::sort_nums(&ratios);
        if let (Some(median), Some(p25), Some(p75)) = (crate::exec::quantile_sorted(&sorted, 0.5), crate::exec::quantile_sorted(&sorted, 0.25), crate::exec::quantile_sorted(&sorted, 0.75)) {
            sum.ratio_spread = Some(RatioSpread { tasks: sorted.len(), median, p25, p75, below_one: sorted.iter().filter(|x| **x < 1.0).count() });
        }
        // 推定の幅で見た比(比べられるタスクのどれにも幅があるときだけ)
        let comparable: Vec<&TaskRow> = rows.iter().filter(|r| r.comparable).collect();
        let lows: Option<f64> = comparable.iter().map(|r| r.human_low).sum();
        let highs: Option<f64> = comparable.iter().map(|r| r.human_high).sum();
        sum.ratio_low = lows.map(|l| l / work_h);
        sum.ratio_high = highs.map(|h| h / work_h);
    }
    (rows, sum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::jsdate::{parse_ms, with_zone, Offset, TimeZone};

    /// 初めて見たときに完了していたタスクは完了のまま出すが、工数を数えず比べない。
    /// 完了を確認した時刻より後に始まったセッション(手動・LLM の紐づけ)は、開始に使わず、そのタスクを比べない
    #[test]
    fn unobserved_completion_and_sessions_after_done() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let mut first_sight = info("F", Some("2026-11-24T12:00:00+09:00"));
            first_sight.done_observed = false;
            let tasks = vec![first_sight, info("L", Some("2026-11-24T12:00:00+09:00"))];
            let mut f = HashMap::new();
            f.insert("f1".to_string(), facts("2026-11-23T10:00:00+09:00", 1.0, Some((5.0, Some(0.9)))));
            f.insert("l1".to_string(), facts("2026-11-23T10:00:00+09:00", 1.0, Some((5.0, Some(0.9)))));
            // 完了を確認した後(11/25)に始まったセッション
            f.insert("l2".to_string(), facts("2026-11-25T10:00:00+09:00", 2.0, Some((3.0, Some(0.9)))));
            let links = vec![link("f1", "F", LinkSource::Machine), link("l1", "L", LinkSource::Machine), link("l2", "L", LinkSource::Manual)];
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            assert!(rows[0].done);
            assert_eq!((rows[0].work_ms, rows[0].excluded), (None, Some(Excluded::DoneUnobserved)));
            assert_eq!(rows[0].start.as_deref(), Some("2026-11-23T01:00:00.000Z"));
            // L: 開始は 11/23 10:00(後のセッションは使わない)。工数は出すが比べない
            assert_eq!(rows[1].start.as_deref(), Some("2026-11-23T01:00:00.000Z"));
            assert_eq!(rows[1].work_ms, Some(11.0 * 3_600_000.0));
            assert_eq!((rows[1].after_done_sessions, rows[1].excluded), (1, Some(Excluded::AfterDone)));
            assert_eq!(sum.excluded, ExcludedCounts { done_unobserved: 1, after_done: 1, ..Default::default() });
            assert_eq!(sum.included, 0);
            // 後のセッションだけなら開始は無く、理由は後に始まったセッション
            let (rows, _) = compute_task_metrics(&tasks[1..], &[link("l2", "L", LinkSource::Llm)], &f, &WorkHours::default());
            assert_eq!((rows[0].start.clone(), rows[0].work_ms, rows[0].excluded), (None, None, Some(Excluded::AfterDone)));
            assert_eq!(Excluded::AfterDone.label(), "完了の後に始まったセッション");
            assert_eq!(Excluded::DoneUnobserved.label(), "完了の時刻が分からない");
        });
    }

    fn info(id: &str, done_at: Option<&str>) -> TaskInfo {
        TaskInfo { id: id.into(), name: format!("{id} の名前"), status: if done_at.is_some() { "Done" } else { "Open" }.into(), done: done_at.is_some(), done_at: done_at.map(str::to_string), done_observed: done_at.is_some(), done_at_source: done_at.map(|_| DoneAtSource::Observed), done_date: None, missing: false, start_hint: None }
    }

    /// 日付だけの完了日: その日の夜(稼働時間帯の後)に始めたセッションも数え(完了の後に始まったとしない)、工数は稼働時間帯の終わりまで
    #[test]
    fn date_only_done_counts_the_evening_session_and_work_stops_with_the_work_hours() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            // 月曜(11/23)が完了日(日付だけ)。done_at はその日の稼働時間帯の終わり 18:00
            let t = TaskInfo { done_date: Some("2026-11-23".into()), done_at_source: Some(DoneAtSource::Recorded), ..info("A", Some("2026-11-23T18:00:00+09:00")) };
            let mut f = HashMap::new();
            f.insert("early".to_string(), facts("2026-11-23T10:00:00+09:00", 1.0, Some((2.0, Some(0.8)))));
            f.insert("evening".to_string(), facts("2026-11-23T20:00:00+09:00", 1.0, Some((1.0, Some(0.8)))));
            assert!(!started_after_done(&t, parse_ms("2026-11-23T20:00:00+09:00")));
            assert!(started_after_done(&t, parse_ms("2026-11-24T00:00:01+09:00")));
            let (rows, sum) = compute_task_metrics(std::slice::from_ref(&t), &[link("early", "A", LinkSource::Machine), link("evening", "A", LinkSource::Machine)], &f, &WorkHours::default());
            let r = &rows[0];
            assert_eq!((r.after_done_sessions, r.excluded, r.done_date.as_deref()), (0, None, Some("2026-11-23")));
            // 10:00〜18:00 の 8 時間(夜のセッションの分は稼働時間帯の外)
            assert_eq!(r.work_ms, Some(8.0 * 3_600_000.0));
            assert_eq!((r.human_hours, sum.included), (3.0, 1));
            // 時刻つきの完了(18:00)なら、夜のセッションは完了の後
            let timed = TaskInfo { done_date: None, ..t.clone() };
            assert!(started_after_done(&timed, parse_ms("2026-11-23T20:00:00+09:00")));
            assert_eq!(serde_json::to_value(r).unwrap()["doneDate"], "2026-11-23");
            let (rows, _) = compute_task_metrics(&[timed], &[link("early", "A", LinkSource::Machine)], &f, &WorkHours::default());
            assert!(serde_json::to_value(&rows[0]).unwrap().get("doneDate").is_none());
        });
    }

    /// 日付だけの完了日で、紐づいたセッションがどれもその日の稼働時間帯の終わりより後(夜)に始まったときは、
    /// 工数が 0 時間になるので比べない。理由は「稼働時間帯に重ならない」(完了の後に始まったセッションは無いので、その数も 0 のまま)
    #[test]
    fn date_only_done_with_only_an_evening_session_is_not_compared() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let t = TaskInfo { done_date: Some("2026-11-23".into()), done_at_source: Some(DoneAtSource::Recorded), ..info("A", Some("2026-11-23T18:00:00+09:00")) };
            let mut f = HashMap::new();
            f.insert("evening".to_string(), facts("2026-11-23T20:00:00+09:00", 1.0, Some((1.0, Some(0.8)))));
            let (rows, sum) = compute_task_metrics(std::slice::from_ref(&t), &[link("evening", "A", LinkSource::Machine)], &f, &WorkHours::default());
            let r = &rows[0];
            assert_eq!((r.work_ms, r.comparable, r.excluded), (None, false, Some(Excluded::NoWorkHours)));
            assert_eq!(r.excluded.map(Excluded::label), Some("稼働時間帯に重ならない"));
            // セッションはその日のうちに始めたので、開始と実働・推定人手工数はこのタスクに数える(比べないだけ)。理由と件数が食い違わない
            assert_eq!((r.start.as_deref(), r.human_hours, r.after_done_sessions), (Some("2026-11-23T11:00:00.000Z"), 1.0, 0));
            assert_eq!(sum.excluded, ExcludedCounts { no_work_hours: 1, ..Default::default() });
            assert_eq!((sum.included, sum.work_ms), (0, 0.0));
            assert_eq!(serde_json::to_value(r).unwrap()["excluded"], "noWorkHours");
        });
    }

    /// 稼働日でない日だけ(土日)に作業して完了したタスク・稼働時間帯の外(夜)だけで作業して完了したタスクは、工数が 0 時間になるので比べない
    #[test]
    fn tasks_outside_the_work_hours_are_not_compared() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            // 11/28(土)10:00 に始めて 11/29(日)15:00 に完了。11/24(火)19:00 に始めて 22:00 に完了
            let tasks = vec![info("W", Some("2026-11-29T15:00:00+09:00")), info("N", Some("2026-11-24T22:00:00+09:00")), info("OK", Some("2026-11-24T12:00:00+09:00"))];
            let mut f = HashMap::new();
            f.insert("w".to_string(), facts("2026-11-28T10:00:00+09:00", 2.0, Some((3.0, Some(0.9)))));
            f.insert("n".to_string(), facts("2026-11-24T19:00:00+09:00", 1.0, Some((2.0, Some(0.9)))));
            f.insert("ok".to_string(), facts("2026-11-24T10:00:00+09:00", 1.0, Some((2.0, Some(0.9)))));
            let links = vec![link("w", "W", LinkSource::Machine), link("n", "N", LinkSource::Machine), link("ok", "OK", LinkSource::Machine)];
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            for r in &rows[..2] {
                assert_eq!((r.work_ms, r.comparable, r.excluded, r.after_done_sessions), (None, false, Some(Excluded::NoWorkHours), 0), "{}", r.id);
                // 開始は出す(比べないだけ)
                assert!(r.start.is_some());
            }
            assert_eq!((rows[2].work_ms, rows[2].excluded), (Some(2.0 * 3_600_000.0), None));
            assert_eq!(sum.excluded, ExcludedCounts { no_work_hours: 2, ..Default::default() });
            assert_eq!((sum.included, sum.work_ms, sum.human_hours), (1, 2.0 * 3_600_000.0, 2.0));
            // 稼働時間帯を毎日の 0:00〜24:00 にすれば、同じタスクも比べられる
            let all_day = WorkHours { days: vec![1, 2, 3, 4, 5, 6, 7], start_min: 0, end_min: 1440 };
            let (rows, _) = compute_task_metrics(&tasks, &links, &f, &all_day);
            assert!(rows.iter().all(|r| r.comparable), "{rows:?}");
        });
    }

    /// 日付だけの完了日の工数の終わりは、日付の文字と集計する PC の時間帯から決める(前に読んだ PC の時間帯の doneAt を使わない)
    #[test]
    fn date_only_work_end_follows_the_date_and_this_pcs_time_zone() {
        // JST の PC で読んだ doneAt(11/23 18:00 JST = 09:00Z)。集計は UTC の PC
        let t = TaskInfo { done_date: Some("2026-11-23".into()), done_at_source: Some(DoneAtSource::Recorded), ..info("A", Some("2026-11-23T09:00:00.000Z")) };
        let mut f = HashMap::new();
        f.insert("s".to_string(), facts("2026-11-23T10:00:00Z", 1.0, Some((1.0, Some(0.8)))));
        with_zone(&TimeZone::fixed(Offset::constant(0)), || {
            let (rows, _) = compute_task_metrics(std::slice::from_ref(&t), &[link("s", "A", LinkSource::Machine)], &f, &WorkHours::default());
            // UTC の 11/23 10:00〜18:00 の 8 時間(読んだ PC の 09:00Z で切らない)。doneAt もこの PC の 18:00
            assert_eq!((rows[0].work_ms, rows[0].done_at.as_deref(), rows[0].done_date.as_deref()), (Some(8.0 * 3_600_000.0), Some("2026-11-23T18:00:00.000Z"), Some("2026-11-23")));
            assert!(!started_after_done(&t, parse_ms("2026-11-23T23:00:00Z")));
            assert!(started_after_done(&t, parse_ms("2026-11-24T00:00:01Z")));
        });
    }

    fn facts(start: &str, active_h: f64, human: Option<(f64, Option<f64>)>) -> SessionFacts {
        SessionFacts { start_ms: parse_ms(start), active_ms: Some(active_h * 3_600_000.0), human: human.map(HumanEstimate::from), extra: Default::default() }
    }

    fn link(s: &str, t: &str, src: LinkSource) -> (String, String, LinkSource) {
        (s.into(), t.into(), src)
    }

    #[test]
    fn per_task_values_and_inclusion() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let tasks = vec![
                info("A", Some("2026-11-24T12:00:00+09:00")),
                info("B", None),
                info("C", Some("2026-11-24T12:00:00+09:00")),
                info("D", Some("2026-11-24T12:00:00+09:00")),
                info("E", None),
            ];
            let mut f = HashMap::new();
            // A: 月曜 10:00 と 14:00 に始めた 2 セッション → 開始は 10:00。火曜 12:00 完了 → 月曜 8 時間 + 火曜 3 時間
            f.insert("a1".to_string(), facts("2026-11-23T14:00:00+09:00", 1.0, Some((5.0, Some(0.8)))));
            f.insert("a2".to_string(), facts("2026-11-23T10:00:00+09:00", 0.5, Some((3.0, None))));
            f.insert("b1".to_string(), facts("2026-11-23T10:00:00+09:00", 2.0, Some((4.0, Some(0.9)))));
            f.insert("c1".to_string(), facts("2026-11-23T10:00:00+09:00", 1.0, None));
            f.insert("d1".to_string(), facts("2026-11-23T10:00:00+09:00", 1.0, Some((9.0, Some(0.3)))));
            let links = vec![link("a1", "A", LinkSource::Machine), link("a2", "A", LinkSource::Manual), link("b1", "B", LinkSource::Llm), link("c1", "C", LinkSource::Machine), link("d1", "D", LinkSource::Machine)];
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            let a = &rows[0];
            assert_eq!(a.start.as_deref(), Some("2026-11-23T01:00:00.000Z"));
            assert_eq!(a.work_ms, Some(11.0 * 3_600_000.0));
            assert_eq!(a.ai_active_ms, 1.5 * 3_600_000.0);
            // 確信度の記録が無い推定は低いとはみなさない(要約と同じ)
            assert_eq!(a.human_hours, 8.0);
            assert_eq!((a.sessions, a.judged_sessions, a.low_confidence_sessions, a.unjudged_sessions), (2, 2, 0, 0));
            assert_eq!(a.links, SourceCounts { machine: 1, llm: 0, manual: 1 });
            assert!(a.comparable);
            assert_eq!(rows[1].excluded, Some(Excluded::NotDone));
            assert_eq!(rows[1].work_ms, None);
            assert_eq!(rows[2].excluded, Some(Excluded::Unjudged));
            // 確信度 0.3 以下は推定に入れず、確度が低いとして外す
            assert_eq!((rows[3].excluded, rows[3].human_hours, rows[3].low_confidence_sessions), (Some(Excluded::LowConfidence), 0.0, 1));
            // セッションの無いタスクも行は出す(合計には入れない)
            assert_eq!((rows[4].sessions, rows[4].excluded), (0, None));
            assert_eq!(sum.tasks, 4);
            assert_eq!(sum.done_tasks, 3);
            assert_eq!(sum.included, 1);
            assert_eq!(sum.excluded, ExcludedCounts { not_done: 1, unjudged: 1, low_confidence: 1, ..Default::default() });
            assert_eq!(sum.work_ms, 11.0 * 3_600_000.0);
            assert_eq!(sum.human_hours, 8.0);
            assert_eq!(sum.ai_active_ms, 1.5 * 3_600_000.0);
            assert_eq!(sum.ai_active_ms_all, 5.5 * 3_600_000.0);
            // 比べられるタスクが下限に届かないので比は出さない
            assert_eq!(sum.ratio, None);
            assert_eq!(sum.ratio_min, RATIO_MIN_TASKS);
        });
    }

    /// いくつかのタスクに紐づいたセッションの実働と推定人手工数は、タスクの数で等分する(足すと全体の値になる)。
    /// セッションの数・判定の数は等分しない。開始と稼働時間帯の工数はタスクの長さなので等分しない
    #[test]
    fn shared_sessions_are_split_equally() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let tasks = vec![info("A", Some("2026-11-24T12:00:00+09:00")), info("B", Some("2026-11-24T12:00:00+09:00")), info("C", None)];
            let mut f = HashMap::new();
            // s1 は A と B の両方、s2 は A だけ、s3 は A・B・C の 3 つ(確信度の低い推定)
            f.insert("s1".to_string(), facts("2026-11-23T10:00:00+09:00", 2.0, Some((6.0, Some(0.9)))));
            f.insert("s2".to_string(), facts("2026-11-23T14:00:00+09:00", 1.0, Some((4.0, Some(0.9)))));
            f.insert("s3".to_string(), facts("2026-11-23T15:00:00+09:00", 3.0, Some((9.0, Some(0.2)))));
            let links = vec![
                link("s1", "A", LinkSource::Machine),
                link("s1", "B", LinkSource::Machine),
                link("s2", "A", LinkSource::Manual),
                link("s3", "A", LinkSource::Llm),
                link("s3", "B", LinkSource::Llm),
                link("s3", "C", LinkSource::Llm),
                // 同じ組が重なっても 1 つに数える
                link("s2", "A", LinkSource::Manual),
            ];
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            let (a, b, c) = (&rows[0], &rows[1], &rows[2]);
            // A: s1 の半分 + s2 の全部 + s3 の 3 分の 1
            assert_eq!(a.ai_active_ms, (1.0 + 1.0 + 1.0) * 3_600_000.0);
            assert_eq!(a.human_hours, 3.0 + 4.0);
            assert_eq!((a.sessions, a.shared_sessions, a.judged_sessions, a.low_confidence_sessions), (3, 2, 3, 1));
            assert_eq!(a.links, SourceCounts { machine: 1, llm: 1, manual: 1 });
            assert_eq!(b.ai_active_ms, (1.0 + 1.0) * 3_600_000.0);
            assert_eq!(b.human_hours, 3.0);
            assert_eq!((b.sessions, b.shared_sessions), (2, 2));
            assert_eq!(c.ai_active_ms, 3_600_000.0);
            assert_eq!((c.sessions, c.shared_sessions), (1, 1));
            // 開始と稼働時間帯の工数は等分しない(A も B も 11/23 10:00 から)
            assert_eq!((a.start.clone(), a.work_ms), (b.start.clone(), b.work_ms));
            assert_eq!(a.work_ms, Some(11.0 * 3_600_000.0));
            // 足すと全体の値(各セッションの実働の合計 6 時間)
            assert_eq!(sum.ai_active_ms_all, 6.0 * 3_600_000.0);
            assert_eq!(rows.iter().map(|r| r.ai_active_ms).sum::<f64>(), 6.0 * 3_600_000.0);
            assert_eq!(sum.shared_sessions, 2);
            // 2 つに分けたセッション 1 件だけなら、それぞれ半分
            let (rows, sum) = compute_task_metrics(&tasks[..2], &links[..2], &f, &WorkHours::default());
            assert_eq!((rows[0].ai_active_ms, rows[1].ai_active_ms), (3_600_000.0, 3_600_000.0));
            assert_eq!((rows[0].human_hours, rows[1].human_hours), (3.0, 3.0));
            assert!(rows[0].comparable && rows[1].comparable);
            assert_eq!((sum.included, sum.human_hours, sum.ai_active_ms), (2, 6.0, 2.0 * 3_600_000.0));
            assert_eq!(share_of(4), 0.25);
            assert_eq!(share_of(0), 0.0);
        });
    }

    /// 一覧に無いタスクには数えない(知っているタスクが全部を受け取る)。
    /// 完了を確認した後に始まったセッションは、そのタスクに数えず、ほかのタスクが全部を受け取る。どこにも数えなければ 0。
    /// タスクの値の合計は、数えたセッションの値の合計
    #[test]
    fn unknown_and_after_done_tasks_do_not_take_a_share() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let tasks = vec![info("A", Some("2026-11-24T12:00:00+09:00")), info("B", None)];
            let by_id: HashMap<&str, &TaskInfo> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
            let mut f = HashMap::new();
            // s1: A と一覧に無い NOPE。s2: A の完了の後に始まった(A と B)。s3: A の完了の後に始まった(A だけ)
            f.insert("s1".to_string(), facts("2026-11-23T10:00:00+09:00", 2.0, Some((6.0, Some(0.9)))));
            f.insert("s2".to_string(), facts("2026-11-25T10:00:00+09:00", 4.0, Some((8.0, Some(0.9)))));
            f.insert("s3".to_string(), facts("2026-11-25T10:00:00+09:00", 1.0, Some((1.0, Some(0.9)))));
            let links = vec![link("s1", "A", LinkSource::Manual), link("s1", "NOPE", LinkSource::Manual), link("s2", "A", LinkSource::Manual), link("s2", "B", LinkSource::Manual), link("s3", "A", LinkSource::Llm)];
            assert_eq!(counted_tasks(["A", "NOPE", "A"], &by_id, parse_ms("2026-11-23T10:00:00+09:00")), ["A"]);
            assert_eq!(counted_tasks(["A", "B"], &by_id, parse_ms("2026-11-25T10:00:00+09:00")), ["B"]);
            // 始めた時刻が分からなければ数える
            assert_eq!(counted_tasks(["A", "B"], &by_id, None), ["A", "B"]);
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            let (a, b) = (&rows[0], &rows[1]);
            // A は s1 の全部(NOPE は数えない)。s2・s3 は完了の後なので 0(セッションと完了の後のセッションには数える)
            assert_eq!((a.ai_active_ms, a.human_hours), (2.0 * 3_600_000.0, 6.0));
            assert_eq!((a.sessions, a.after_done_sessions, a.shared_sessions), (3, 2, 0));
            // B は s2 の全部
            assert_eq!((b.ai_active_ms, b.human_hours, b.sessions, b.shared_sessions), (4.0 * 3_600_000.0, 8.0, 1, 0));
            assert_eq!(sum.shared_sessions, 0);
            // 合計は、数えたセッション(s1 と s2)の値。どこにも数えない s3 は入らない
            assert_eq!(sum.ai_active_ms_all, 6.0 * 3_600_000.0);
            assert_eq!(rows.iter().map(|r| r.human_hours).sum::<f64>(), 14.0);
            assert!(!started_after_done(&tasks[1], parse_ms("2030-01-01T00:00:00Z")));
            assert!(started_after_done(&tasks[0], parse_ms("2026-11-24T12:00:01+09:00")));
            assert!(!started_after_done(&tasks[0], parse_ms("2026-11-24T12:00:00+09:00")));
        });
    }

    /// 比のばらつき: 比べられるタスクごとの比の中央値・25 と 75 パーセンタイル・1 より小さいタスクの数と、推定の幅で見た比。
    /// 合計どうしの比と同じく、比べられるタスクが下限に届いたときだけ。幅は時間と同じく等分し、幅の無い推定があれば幅の比を出さない
    #[test]
    fn ratio_spread_and_range_ratio() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let n = RATIO_MIN_TASKS;
            assert_eq!(n, 5, "下の値は 5 件で組んである");
            let hours = [1.0, 2.0, 4.0, 6.0, 10.0];
            let tasks: Vec<TaskInfo> = (0..n).map(|i| info(&format!("T{i}"), Some("2026-11-23T12:00:00+09:00"))).collect();
            let mut f = HashMap::new();
            let mut links = Vec::new();
            for (i, h) in hours.iter().enumerate() {
                let mut x = facts("2026-11-23T10:00:00+09:00", 1.0, None);
                x.human = Some(HumanEstimate { hours: *h, confidence: Some(0.9), low: Some(h / 2.0), high: Some(h * 2.0) });
                f.insert(format!("s{i}"), x);
                links.push(link(&format!("s{i}"), &format!("T{i}"), LinkSource::Machine));
            }
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            // どのタスクも工数 2 時間。比は [0.5, 1, 2, 3, 5]
            assert_eq!(rows.iter().map(|r| r.ratio).collect::<Vec<_>>(), [Some(0.5), Some(1.0), Some(2.0), Some(3.0), Some(5.0)]);
            assert_eq!((rows[0].human_low, rows[0].human_high), (Some(0.5), Some(2.0)));
            assert_eq!(sum.ratio, Some(2.3));
            // 中央値は ceil(0.5·5)=3 番目、25 パーセンタイルは 2 番目、75 パーセンタイルは 4 番目
            assert_eq!(sum.ratio_spread, Some(RatioSpread { tasks: 5, median: 2.0, p25: 1.0, p75: 3.0, below_one: 1 }));
            // 幅の合計 11.5〜46 時間 ÷ 工数 10 時間
            assert_eq!((sum.ratio_low, sum.ratio_high), (Some(1.15), Some(4.6)));
            // 下限に届かなければ、どれも出さない(タスクごとの比は出す)
            let (rows4, fewer) = compute_task_metrics(&tasks[..n - 1], &links, &f, &WorkHours::default());
            assert_eq!((fewer.ratio, fewer.ratio_spread.clone(), fewer.ratio_low, fewer.ratio_high), (None, None, None, None));
            assert_eq!(rows4[0].ratio, Some(0.5));
            // 幅の無い推定が 1 つあれば、幅の比は出さない(ばらつきは出す)
            f.get_mut("s4").unwrap().human = Some((10.0, Some(0.9)).into());
            let (rows, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            assert_eq!((rows[4].human_low, rows[4].human_high), (None, None));
            assert_eq!((sum.ratio_low, sum.ratio_high), (None, None));
            assert!(sum.ratio_spread.is_some());
            // 2 つのタスクに紐づいたセッションの幅は、時間と同じく等分する
            let mut g = HashMap::new();
            let mut y = facts("2026-11-23T10:00:00+09:00", 1.0, None);
            y.human = Some(HumanEstimate { hours: 4.0, confidence: Some(0.9), low: Some(2.0), high: Some(8.0) });
            g.insert("s".to_string(), y);
            let (rows, _) = compute_task_metrics(&tasks[..2], &[link("s", "T0", LinkSource::Manual), link("s", "T1", LinkSource::Manual)], &g, &WorkHours::default());
            assert_eq!((rows[0].human_hours, rows[0].human_low, rows[0].human_high), (2.0, Some(1.0), Some(4.0)));
            // 比べないタスクには、タスクごとの比を出さない
            let undone = vec![info("U", None)];
            let (rows, _) = compute_task_metrics(&undone, &[link("s", "U", LinkSource::Manual)], &g, &WorkHours::default());
            assert_eq!(rows[0].ratio, None);
        });
    }

    #[test]
    fn ratio_only_with_enough_tasks_and_start_hint() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            let n = RATIO_MIN_TASKS;
            let tasks: Vec<TaskInfo> = (0..n).map(|i| info(&format!("T{i}"), Some("2026-11-23T12:00:00+09:00"))).collect();
            let mut f = HashMap::new();
            let mut links = Vec::new();
            for i in 0..n {
                f.insert(format!("s{i}"), facts("2026-11-23T10:00:00+09:00", 1.0, Some((4.0, Some(0.9)))));
                links.push(link(&format!("s{i}"), &format!("T{i}"), LinkSource::Machine));
            }
            let (_, sum) = compute_task_metrics(&tasks, &links, &f, &WorkHours::default());
            assert_eq!(sum.included, n);
            // 1 タスク 2 時間(稼働)に対して推定 4 時間 → 2 倍
            assert_eq!(sum.ratio, Some(2.0));
            let (_, fewer) = compute_task_metrics(&tasks[..n - 1], &links, &f, &WorkHours::default());
            assert_eq!(fewer.ratio, None);
            // 送った人の開始が手元のセッションより早ければ、そちらを使う。開始が分からなければ外す
            let mut hinted = info("H", Some("2026-11-23T12:00:00+09:00"));
            hinted.start_hint = Some("2026-11-23T09:00:00+09:00".into());
            f.insert("h".into(), facts("2026-11-23T11:00:00+09:00", 0.1, Some((1.0, Some(0.9)))));
            f.insert("x".into(), SessionFacts { start_ms: None, active_ms: None, human: Some((1.0, Some(0.9)).into()), extra: Default::default() });
            let (rows, sum) = compute_task_metrics(&[hinted, info("X", Some("2026-11-23T12:00:00+09:00"))], &[link("h", "H", LinkSource::Llm), link("x", "X", LinkSource::Manual)], &f, &WorkHours::default());
            assert_eq!(rows[0].work_ms, Some(3.0 * 3_600_000.0));
            assert_eq!(rows[1].excluded, Some(Excluded::NoStart));
            assert_eq!(sum.excluded.no_start, 1);
        });
    }
}
