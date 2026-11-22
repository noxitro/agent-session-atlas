//! 画面に埋め込むタスクの節(ReportData.tasks)と、serve の GET /api/tasks が返すもの。値はすべて Rust で決め、画面は出すだけ。

use super::hours::{format_hhmm, WorkHours};
use super::links::{LinkSource, LinksFile};
use super::metrics::{compute_task_metrics, SessionFacts, TaskInfo, TaskRow, TaskSummary};
use super::sender::{tasks_from_senders, SenderTask};
use super::state::TasksFile;
use atlas_core::types::SessionRecord;
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkHoursView {
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
}

impl From<&WorkHours> for WorkHoursView {
    fn from(w: &WorkHours) -> Self {
        WorkHoursView { days: w.days.clone(), start: format_hhmm(w.start_min), end: format_hhmm(w.end_min) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub task_id: Option<String>,
    pub source: LinkSource,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksView {
    /// この PC の設定に tasks がある
    pub configured: bool,
    /// local: この PC の tasks.json と task-links.json から。sender: 送った人がセッションごとに添えた記録から(読むだけの画面)
    pub origin: &'static str,
    /// 最後に読んだ XML のファイルの名前と、その更新時刻(観測の時刻)。sender では null
    pub file: Option<String>,
    pub observed_at: Option<String>,
    pub work_hours: WorkHoursView,
    /// XML を読めなかったなどの注意
    pub warnings: Vec<String>,
    /// タスクの一覧(XML の順。送り先から集計したときは、紐づいたセッションのあるタスクだけ)
    pub items: Vec<TaskRow>,
    /// セッション id → 紐づけ(このレポートのセッションだけ。task_id が null は「どのタスクでもない」)
    pub links: IndexMap<String, LinkView>,
    pub summary: TaskSummary,
    /// 絞り込んだセッション(--task・--session・--since など)だけで作った。serve の画面は、絞り込まない GET /api/tasks の値で置き換えない
    pub scoped: bool,
}

/// セッションの工数に使う値。human はセッション id → (推定人手工数, 確信度)
pub fn session_facts(sessions: &[&SessionRecord], human: &HashMap<String, (f64, Option<f64>)>) -> HashMap<String, SessionFacts> {
    sessions
        .iter()
        .map(|s| {
            (
                s.id.clone(),
                SessionFacts { start_ms: s.created_at.as_deref().filter(|x| !x.is_empty()).and_then(atlas_core::jsdate::parse_ms), active_ms: s.active_ms, human: human.get(&s.id).copied() },
            )
        })
        .collect()
}

pub struct LocalInputs<'a> {
    pub configured: bool,
    pub state: &'a TasksFile,
    pub links: &'a LinksFile,
    /// レポートに出すセッション(並びのとおりに links を並べる)
    pub shown: &'a [&'a str],
    /// セッションの工数に使う値(session_facts)
    pub facts: &'a HashMap<String, SessionFacts>,
    pub work_hours: &'a WorkHours,
    pub warnings: Vec<String>,
}

/// この PC のタスクの節。設定が無く、覚えたタスクも紐づけも無ければ None(節を出さない)
pub fn local_view(i: LocalInputs<'_>) -> Option<TasksView> {
    if !i.configured && i.state.tasks.is_empty() && i.links.links.is_empty() && i.warnings.is_empty() {
        return None;
    }
    let mut links: IndexMap<String, LinkView> = IndexMap::new();
    let mut pairs: Vec<(String, String, LinkSource)> = Vec::new();
    for sid in i.shown {
        if let Some(l) = i.links.links.get(*sid) {
            links.insert(sid.to_string(), LinkView { task_id: l.task_id.clone(), source: l.source, reason: l.reason.clone(), confidence: l.confidence });
            if let Some(t) = &l.task_id {
                pairs.push((sid.to_string(), t.clone(), l.source));
            }
        }
    }
    let linked: HashSet<&str> = pairs.iter().map(|p| p.1.as_str()).collect();
    // XML から消えたタスクは、このレポートのセッションが紐づいているときだけ出す
    let tasks: Vec<TaskInfo> = i
        .state
        .tasks
        .iter()
        .filter(|(id, t)| !t.missing || linked.contains(id.as_str()))
        .map(|(id, t)| TaskInfo { id: id.clone(), name: t.name.clone(), status: t.status.clone(), done: t.done, done_at: t.done_at.clone(), done_observed: t.done_observed, missing: t.missing, start_hint: None })
        .collect();
    let (items, summary) = compute_task_metrics(&tasks, &pairs, i.facts, i.work_hours);
    Some(TasksView {
        configured: i.configured,
        origin: "local",
        file: i.state.source.as_ref().map(|s| s.file.clone()),
        observed_at: i.state.source.as_ref().map(|s| s.modified_at.clone()),
        work_hours: i.work_hours.into(),
        warnings: i.warnings,
        items,
        links,
        summary,
        scoped: false,
    })
}

/// 送った人の記録からのタスクの節(読むだけの画面)。記録が 1 つも無ければ None
pub fn sender_view(per_session: &[(String, SenderTask)], shown: &[&str], facts: &HashMap<String, SessionFacts>, work_hours: &WorkHours, configured: bool) -> Option<TasksView> {
    let shown: HashSet<&str> = shown.iter().copied().collect();
    let mine: Vec<(String, SenderTask)> = per_session.iter().filter(|(sid, _)| shown.contains(sid.as_str())).cloned().collect();
    if mine.is_empty() {
        return None;
    }
    let (tasks, pairs) = tasks_from_senders(&mine);
    let links: IndexMap<String, LinkView> = mine.iter().map(|(sid, t)| (sid.clone(), LinkView { task_id: Some(t.id.clone()), source: t.source, reason: t.reason.clone(), confidence: None })).collect();
    let (items, summary) = compute_task_metrics(&tasks, &pairs, facts, work_hours);
    Some(TasksView { configured, origin: "sender", file: None, observed_at: None, work_hours: work_hours.into(), warnings: vec![], items, links, summary, scoped: false })
}

/// セッション id → タスク id(--task の絞り込みと、表の列に使う)
pub fn task_of_sessions(view: &TasksView) -> HashMap<&str, &str> {
    view.links.iter().filter_map(|(sid, l)| l.task_id.as_deref().map(|t| (sid.as_str(), t))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::links::TaskLink;
    use crate::tasks::state::TaskState;

    fn rec(id: &str, at: &str) -> SessionRecord {
        let mut it = std::iter::empty();
        let ws = atlas_core::types::WorkspaceInfo { created_at: Some(at.into()), updated_at: Some(at.into()), ..Default::default() };
        atlas_core::normalize::normalize_session(atlas_core::normalize::NormalizeInput { id: id.into(), has_dir: None, workspace: Some(&ws), db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
    }

    fn ts(name: &str, missing: bool) -> TaskState {
        TaskState { name: name.into(), status: "Open".into(), done: false, first_seen_at: "t".into(), done_at: None, last_seen_at: "t".into(), missing, done_observed: false }
    }

    #[test]
    fn local_view_shape() {
        let a = rec("s1", "2026-11-23T01:00:00Z");
        let b = rec("s2", "2026-11-23T02:00:00Z");
        let sessions = vec![&a, &b];
        let mut state = TasksFile::default();
        state.tasks.insert("T-1".into(), ts("一つ目", false));
        state.tasks.insert("GONE".into(), ts("消えた", true));
        state.tasks.insert("GONE2".into(), ts("消えて紐づきあり", true));
        let mut links = LinksFile::default();
        links.links.insert("s1".into(), TaskLink { task_id: Some("GONE2".into()), source: LinkSource::Machine, reason: "ID が題名にある".into(), confidence: None, at: "t".into() });
        links.links.insert("s2".into(), TaskLink { task_id: None, source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() });
        links.links.insert("other".into(), TaskLink { task_id: Some("T-1".into()), source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() });
        let facts = session_facts(&sessions, &HashMap::new());
        let shown = ["s1", "s2"];
        let v = local_view(LocalInputs { configured: true, state: &state, links: &links, shown: &shown, facts: &facts, work_hours: &WorkHours::default(), warnings: vec![] }).unwrap();
        assert_eq!(v.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["T-1", "GONE2"]);
        assert_eq!(v.links.keys().collect::<Vec<_>>(), ["s1", "s2"]);
        assert_eq!(v.summary.tasks, 1);
        assert_eq!(task_of_sessions(&v), HashMap::from([("s1", "GONE2")]));
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["workHours"], serde_json::json!({ "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00" }));
        assert_eq!(j["links"]["s2"], serde_json::json!({ "taskId": null, "source": "manual", "reason": "" }));
        assert_eq!(j["origin"], "local");
        // 設定も記録も無ければ節を出さない
        assert!(local_view(LocalInputs { configured: false, state: &TasksFile::default(), links: &LinksFile::default(), shown: &shown, facts: &facts, work_hours: &WorkHours::default(), warnings: vec![] }).is_none());
    }

    #[test]
    fn sender_view_uses_only_shown_sessions() {
        let a = rec("s1", "2026-11-23T01:00:00Z");
        let t = SenderTask { id: "T".into(), name: "n".into(), status: "Open".into(), done: false, done_at: None, done_observed: false, last_seen_at: None, start: None, source: LinkSource::Llm, reason: "r".into() };
        let per = vec![("s1".to_string(), t.clone()), ("hidden".to_string(), SenderTask { id: "U".into(), ..t })];
        let facts = session_facts(&[&a], &HashMap::new());
        let v = sender_view(&per, &["s1"], &facts, &WorkHours::default(), false).unwrap();
        assert_eq!(v.origin, "sender");
        assert_eq!(v.items.len(), 1);
        assert_eq!(v.items[0].sessions, 1);
        assert!(sender_view(&per[1..], &["s1"], &facts, &WorkHours::default(), false).is_none());
    }
}
