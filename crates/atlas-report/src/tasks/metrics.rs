//! タスクごとの工数(Rust だけで数える。画面はこの値を出すだけ)。
//! - AI を使った場合の工数(workMs): 紐づいたセッションのうち最も早い開始から、完了を確認した時刻までの、稼働時間帯に入る長さ。完了したタスクだけ
//! - AI の実働(aiActiveMs): 紐づいたセッションの実働(activeMs)の合計
//! - AI を使わなかった場合の工数(humanHours): 紐づいたセッションの推定人手工数(LLM の判定)の合計。確信度の低い推定(aggregate::LOW_CONFIDENCE 以下)は入れない
//!
//! 合計は「比べられるタスク」(完了していて、紐づいたセッションがすべて確信度の低くない推定を持つ)だけで出す。外したタスクは理由ごとに数える。
//! 2 つの工数の比は、比べられるタスクが RATIO_MIN_TASKS 件に届いたときだけ出す(1 件だけで大きく動く値を出さない)。

use super::hours::{work_overlap_ms, WorkHours};
use super::links::LinkSource;
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
    pub missing: bool,
    /// 送った人が数えた開始(紐づいたセッションのうち最も早い開始)。手元のセッションの開始と早い方を使う
    pub start_hint: Option<String>,
}

/// セッション 1 件の、工数に使う値
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionFacts {
    pub start_ms: Option<i64>,
    pub active_ms: Option<f64>,
    /// 推定人手工数(時間)と確信度。判定が無ければ None
    pub human: Option<(f64, Option<f64>)>,
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
    /// 紐づいたセッションの開始の時刻が分からない
    NoStart,
    /// 推定人手工数の判定が無いセッションがある
    Unjudged,
    /// 確信度の低い推定のセッションがある
    LowConfidence,
}

impl Excluded {
    pub fn label(self) -> &'static str {
        match self {
            Excluded::NotDone => "未完了",
            Excluded::NoStart => "開始が分からない",
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
    pub missing: bool,
    /// 紐づいたセッションのうち最も早い開始(ISO)
    pub start: Option<String>,
    /// AI を使った場合の工数(稼働時間帯のミリ秒)。完了していなければ null
    pub work_ms: Option<f64>,
    /// AI の実働(ミリ秒)
    pub ai_active_ms: f64,
    /// AI を使わなかった場合の工数(推定人手工数の時間。確信度の低い推定は入れない)
    pub human_hours: f64,
    pub sessions: usize,
    pub judged_sessions: usize,
    pub low_confidence_sessions: usize,
    pub unjudged_sessions: usize,
    /// 紐づけの出所ごとのセッション数
    pub links: SourceCounts,
    /// 比べられるタスクか
    pub comparable: bool,
    /// 比べられないときの理由
    pub excluded: Option<Excluded>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedCounts {
    pub not_done: usize,
    pub no_start: usize,
    pub unjudged: usize,
    pub low_confidence: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    /// セッションが紐づいたタスクの数
    pub tasks: usize,
    /// そのうち完了したもの
    pub done_tasks: usize,
    /// 比べられるタスクの数
    pub included: usize,
    pub excluded: ExcludedCounts,
    /// 比べられるタスクの合計
    pub work_ms: f64,
    pub human_hours: f64,
    pub ai_active_ms: f64,
    /// 紐づいたセッションの AI の実働の合計(比べられないタスクも入れる)
    pub ai_active_ms_all: f64,
    /// AI を使わなかった場合 ÷ AI を使った場合(比べられるタスクが ratio_min に届いたときだけ)
    pub ratio: Option<f64>,
    pub ratio_min: usize,
}

/// タスクごとの工数と合計。links はセッション id → (タスク id, 出所)。返す行は tasks の順で、紐づいたセッションが無いタスクも入れる(数は 0)
pub fn compute_task_metrics(tasks: &[TaskInfo], links: &[(String, String, LinkSource)], facts: &HashMap<String, SessionFacts>, wh: &WorkHours) -> (Vec<TaskRow>, TaskSummary) {
    let mut by_task: HashMap<&str, Vec<(&str, LinkSource)>> = HashMap::new();
    for (sid, tid, src) in links {
        by_task.entry(tid.as_str()).or_default().push((sid.as_str(), *src));
    }
    let empty = SessionFacts::default();
    let mut rows = Vec::with_capacity(tasks.len());
    let mut sum = TaskSummary { ratio_min: RATIO_MIN_TASKS, ..Default::default() };
    for t in tasks {
        let linked = by_task.get(t.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        let mut row = TaskRow {
            id: t.id.clone(),
            name: t.name.clone(),
            status: t.status.clone(),
            done: t.done,
            done_at: t.done_at.clone(),
            missing: t.missing,
            start: None,
            work_ms: None,
            ai_active_ms: 0.0,
            human_hours: 0.0,
            sessions: linked.len(),
            judged_sessions: 0,
            low_confidence_sessions: 0,
            unjudged_sessions: 0,
            links: SourceCounts::default(),
            comparable: false,
            excluded: None,
        };
        let mut start: Option<i64> = t.start_hint.as_deref().and_then(atlas_core::jsdate::parse_ms);
        for (sid, src) in linked {
            let f = facts.get(*sid).unwrap_or(&empty);
            row.links.add(*src);
            if let Some(s) = f.start_ms {
                start = Some(start.map_or(s, |x| x.min(s)));
            }
            row.ai_active_ms += f.active_ms.unwrap_or(0.0);
            match f.human {
                None => row.unjudged_sessions += 1,
                Some((_, conf)) if is_low_confidence(conf) => {
                    row.judged_sessions += 1;
                    row.low_confidence_sessions += 1;
                }
                Some((h, _)) => {
                    row.judged_sessions += 1;
                    row.human_hours += h;
                }
            }
        }
        row.start = start.map(atlas_core::jsdate::to_iso);
        let done_ms = t.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms);
        if let (true, Some(s), Some(d)) = (t.done, start, done_ms) {
            row.work_ms = Some(work_overlap_ms(s, d, wh));
        }
        if !linked.is_empty() {
            sum.tasks += 1;
            sum.ai_active_ms_all += row.ai_active_ms;
            if t.done {
                sum.done_tasks += 1;
            }
            row.excluded = if !t.done || done_ms.is_none() {
                Some(Excluded::NotDone)
            } else if start.is_none() {
                Some(Excluded::NoStart)
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
                    sum.included += 1;
                    sum.work_ms += row.work_ms.unwrap_or(0.0);
                    sum.human_hours += row.human_hours;
                    sum.ai_active_ms += row.ai_active_ms;
                }
                Some(Excluded::NotDone) => sum.excluded.not_done += 1,
                Some(Excluded::NoStart) => sum.excluded.no_start += 1,
                Some(Excluded::Unjudged) => sum.excluded.unjudged += 1,
                Some(Excluded::LowConfidence) => sum.excluded.low_confidence += 1,
            }
        }
        rows.push(row);
    }
    if sum.included >= RATIO_MIN_TASKS && sum.work_ms > 0.0 {
        sum.ratio = Some(sum.human_hours / (sum.work_ms / 3_600_000.0));
    }
    (rows, sum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::jsdate::{parse_ms, with_zone, Offset, TimeZone};

    fn info(id: &str, done_at: Option<&str>) -> TaskInfo {
        TaskInfo { id: id.into(), name: format!("{id} の名前"), status: if done_at.is_some() { "Done" } else { "Open" }.into(), done: done_at.is_some(), done_at: done_at.map(str::to_string), missing: false, start_hint: None }
    }

    fn facts(start: &str, active_h: f64, human: Option<(f64, Option<f64>)>) -> SessionFacts {
        SessionFacts { start_ms: parse_ms(start), active_ms: Some(active_h * 3_600_000.0), human }
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
            assert_eq!(sum.excluded, ExcludedCounts { not_done: 1, no_start: 0, unjudged: 1, low_confidence: 1 });
            assert_eq!(sum.work_ms, 11.0 * 3_600_000.0);
            assert_eq!(sum.human_hours, 8.0);
            assert_eq!(sum.ai_active_ms, 1.5 * 3_600_000.0);
            assert_eq!(sum.ai_active_ms_all, 5.5 * 3_600_000.0);
            // 比べられるタスクが下限に届かないので比は出さない
            assert_eq!(sum.ratio, None);
            assert_eq!(sum.ratio_min, RATIO_MIN_TASKS);
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
            f.insert("x".into(), SessionFacts { start_ms: None, active_ms: None, human: Some((1.0, Some(0.9))) });
            let (rows, sum) = compute_task_metrics(&[hinted, info("X", Some("2026-11-23T12:00:00+09:00"))], &[link("h", "H", LinkSource::Llm), link("x", "X", LinkSource::Manual)], &f, &WorkHours::default());
            assert_eq!(rows[0].work_ms, Some(3.0 * 3_600_000.0));
            assert_eq!(rows[1].excluded, Some(Excluded::NoStart));
            assert_eq!(sum.excluded.no_start, 1);
        });
    }
}
