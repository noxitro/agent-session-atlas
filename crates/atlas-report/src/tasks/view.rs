//! 画面に埋め込むタスクの節(ReportData.tasks)と、serve の GET /api/tasks が返すもの。値はすべて Rust で決め、画面は出すだけ。

use super::hours::{format_hhmm, WorkHours};
use super::links::{LinkSource, LinksFile};
use super::metrics::{compute_task_metrics, counted_tasks, SessionFacts, TaskInfo, TaskRow, TaskSummary};
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
    /// 紐づいたタスク(並びは決めた順)。空は「どのタスクでもない」
    pub task_ids: Vec<String>,
    /// 実働と推定人手工数を数えるタスク(metrics::counted_tasks。一覧にあり、完了を確認した後に始めたのではないもの)。
    /// それぞれに 1/(この数) ずつ数える。task_ids より少ないことがある
    pub counted_task_ids: Vec<String>,
    pub source: LinkSource,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// 各紐づけに、数えるタスク(counted_task_ids)を入れる(工数の数え方と同じ関数・同じタスクの一覧で)
fn fill_counted(links: &mut IndexMap<String, LinkView>, tasks: &[TaskInfo], facts: &HashMap<String, SessionFacts>) {
    let by_id: HashMap<&str, &TaskInfo> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    for (sid, l) in links.iter_mut() {
        let start = facts.get(sid).and_then(|f| f.start_ms);
        l.counted_task_ids = counted_tasks(l.task_ids.iter().map(String::as_str), &by_id, start).into_iter().map(str::to_string).collect();
    }
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
    /// セッション id → 紐づけ(このレポートのセッションだけ。task_ids が空は「どのタスクでもない」)
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
            links.insert(sid.to_string(), LinkView { task_ids: l.task_ids.clone(), counted_task_ids: vec![], source: l.source, reason: l.reason.clone(), confidence: l.confidence });
            for t in &l.task_ids {
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
    fill_counted(&mut links, &tasks, i.facts);
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
pub fn sender_view(per_session: &[(String, Vec<SenderTask>)], shown: &[&str], facts: &HashMap<String, SessionFacts>, work_hours: &WorkHours, configured: bool) -> Option<TasksView> {
    let shown: HashSet<&str> = shown.iter().copied().collect();
    let mine: Vec<(String, Vec<SenderTask>)> = per_session.iter().filter(|(sid, ts)| !ts.is_empty() && shown.contains(sid.as_str())).cloned().collect();
    if mine.is_empty() {
        return None;
    }
    let (tasks, pairs) = tasks_from_senders(&mine);
    // 出所と理由はセッションごとに 1 つ(送る側が同じ値を各タスクに添える。食い違えば先頭のもの)
    let mut links: IndexMap<String, LinkView> = mine
        .iter()
        .map(|(sid, ts)| (sid.clone(), LinkView { task_ids: ts.iter().map(|t| t.id.clone()).collect(), counted_task_ids: vec![], source: ts[0].source, reason: ts[0].reason.clone(), confidence: None }))
        .collect();
    let (items, summary) = compute_task_metrics(&tasks, &pairs, facts, work_hours);
    fill_counted(&mut links, &tasks, facts);
    Some(TasksView { configured, origin: "sender", file: None, observed_at: None, work_hours: work_hours.into(), warnings: vec![], items, links, summary, scoped: false })
}

/// セッション id → 紐づいたタスクの id(「どのタスクでもない」は入れない)
pub fn task_of_sessions(view: &TasksView) -> HashMap<&str, &[String]> {
    view.links.iter().filter(|(_, l)| !l.task_ids.is_empty()).map(|(sid, l)| (sid.as_str(), l.task_ids.as_slice())).collect()
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
        links.links.insert("s1".into(), TaskLink { task_ids: vec!["GONE2".into(), "T-1".into()], source: LinkSource::Machine, reason: "ID が題名にある".into(), confidence: None, at: "t".into() });
        links.links.insert("s2".into(), TaskLink { task_ids: vec![], source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() });
        links.links.insert("other".into(), TaskLink { task_ids: vec!["T-1".into()], source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() });
        let facts = session_facts(&sessions, &HashMap::new());
        let shown = ["s1", "s2"];
        let v = local_view(LocalInputs { configured: true, state: &state, links: &links, shown: &shown, facts: &facts, work_hours: &WorkHours::default(), warnings: vec![] }).unwrap();
        assert_eq!(v.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["T-1", "GONE2"]);
        assert_eq!(v.links.keys().collect::<Vec<_>>(), ["s1", "s2"]);
        // s1 は 2 つのタスクに紐づく(どちらにも 1 セッション。共有のセッション)
        assert_eq!(v.summary.tasks, 2);
        assert_eq!(v.summary.shared_sessions, 1);
        assert_eq!(v.items.iter().map(|t| (t.sessions, t.shared_sessions)).collect::<Vec<_>>(), [(1, 1), (1, 1)]);
        let gone2 = ["GONE2".to_string(), "T-1".to_string()];
        assert_eq!(task_of_sessions(&v), HashMap::from([("s1", &gone2[..])]));
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["workHours"], serde_json::json!({ "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00" }));
        assert_eq!(j["links"]["s2"], serde_json::json!({ "taskIds": [], "countedTaskIds": [], "source": "manual", "reason": "" }));
        assert_eq!(j["links"]["s1"]["countedTaskIds"], serde_json::json!(["GONE2", "T-1"]));
        assert_eq!(j["links"]["s1"]["taskIds"], serde_json::json!(["GONE2", "T-1"]));
        assert_eq!(j["items"][0]["sharedSessions"], 1);
        assert_eq!(j["origin"], "local");
        // 設定も記録も無ければ節を出さない
        assert!(local_view(LocalInputs { configured: false, state: &TasksFile::default(), links: &LinksFile::default(), shown: &shown, facts: &facts, work_hours: &WorkHours::default(), warnings: vec![] }).is_none());
    }

    /// 同じ紐づけなら、この PC の節と、送った記録から作った(読むだけの)節で、数え方が同じ
    /// (一覧に無い ID と、完了を確認した後に始まったタスクは、どちらでも数えない)
    #[test]
    fn local_and_sender_views_count_the_same() {
        let mut s1 = rec("s1", "2026-11-03T00:00:00Z");
        s1.active_ms = Some(3_600_000.0);
        let mut s2 = rec("s2", "2026-11-09T00:00:00Z");
        s2.active_ms = Some(1_800_000.0);
        let mut s3 = rec("s3", "2026-11-04T00:00:00Z");
        s3.active_ms = Some(600_000.0);
        let sessions = vec![&s1, &s2, &s3];
        let mut state = TasksFile::default();
        let done = |name: &str| TaskState { name: name.into(), status: "Done".into(), done: true, first_seen_at: "t".into(), done_at: Some("2026-11-05T00:00:00.000Z".into()), last_seen_at: "2026-11-05T00:00:00.000Z".into(), missing: false, done_observed: true };
        state.tasks.insert("T".into(), done("終わった仕事"));
        state.tasks.insert("U".into(), TaskState { done: false, done_at: None, status: "Open".into(), done_observed: false, ..done("続く仕事") });
        let mut links = LinksFile::default();
        let l = |ids: &[&str]| TaskLink { task_ids: ids.iter().map(|x| x.to_string()).collect(), source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() };
        // s1: T・U と一覧に無い NOPE。s2: T の完了の後に始まった(T・U)。s3: U だけ
        links.links.insert("s1".into(), l(&["T", "NOPE", "U"]));
        links.links.insert("s2".into(), l(&["T", "U"]));
        links.links.insert("s3".into(), l(&["U"]));
        let human: HashMap<String, (f64, Option<f64>)> = [("s1", 4.0), ("s2", 2.0), ("s3", 1.0)].into_iter().map(|(k, h)| (k.to_string(), (h, Some(0.9)))).collect();
        let facts = session_facts(&sessions, &human);
        let shown = ["s1", "s2", "s3"];
        let local = local_view(LocalInputs { configured: true, state: &state, links: &links, shown: &shown, facts: &facts, work_hours: &WorkHours::default(), warnings: vec![] }).unwrap();
        let starts: HashMap<String, String> = sessions.iter().map(|s| (s.id.clone(), s.created_at.clone().unwrap())).collect();
        let per: Vec<(String, Vec<SenderTask>)> = {
            let st = crate::tasks::sender::sender_tasks(&state, &links, &starts);
            shown.iter().filter_map(|id| st.get(*id).map(|t| (id.to_string(), t.clone()))).collect()
        };
        let sender = sender_view(&per, &shown, &facts, &WorkHours::default(), false).unwrap();
        let pick = |v: &TasksView| -> Vec<(String, f64, f64, usize, usize, usize)> {
            let mut r: Vec<_> = v.items.iter().filter(|t| t.sessions > 0).map(|t| (t.id.clone(), t.ai_active_ms, t.human_hours, t.sessions, t.shared_sessions, t.after_done_sessions)).collect();
            r.sort_by(|a, b| a.0.cmp(&b.0));
            r
        };
        assert_eq!(pick(&local), pick(&sender));
        // T: s1 の半分(s2 は完了の後)。U: s1 の半分 + s2 の全部 + s3 の全部
        assert_eq!(pick(&local), [("T".to_string(), 1_800_000.0, 2.0, 2, 1, 1), ("U".to_string(), 1_800_000.0 + 1_800_000.0 + 600_000.0, 2.0 + 2.0 + 1.0, 3, 1, 0)]);
        assert_eq!((local.summary.ai_active_ms_all, sender.summary.ai_active_ms_all), (6_000_000.0, 6_000_000.0));
        assert_eq!((local.summary.shared_sessions, sender.summary.shared_sessions), (1, 1));
        for sid in shown {
            assert_eq!(local.links[sid].counted_task_ids, sender.links[sid].counted_task_ids, "{sid}");
        }
        assert_eq!(local.links["s1"].counted_task_ids, ["T", "U"]);
        assert_eq!(local.links["s2"].counted_task_ids, ["U"]);
        // 一覧に無い ID は、この PC の紐づけには残る(送った記録には入らない)
        assert_eq!(local.links["s1"].task_ids, ["T", "NOPE", "U"]);
        assert_eq!(sender.links["s1"].task_ids, ["T", "U"]);
    }

    #[test]
    fn sender_view_uses_only_shown_sessions() {
        let a = rec("s1", "2026-11-23T01:00:00Z");
        let t = SenderTask { id: "T".into(), name: "n".into(), status: "Open".into(), done: false, done_at: None, done_observed: false, last_seen_at: None, start: None, source: LinkSource::Llm, reason: "r".into() };
        let per = vec![("s1".to_string(), vec![t.clone(), SenderTask { id: "V".into(), ..t.clone() }]), ("hidden".to_string(), vec![SenderTask { id: "U".into(), ..t }])];
        let facts = session_facts(&[&a], &HashMap::new());
        let v = sender_view(&per, &["s1"], &facts, &WorkHours::default(), false).unwrap();
        assert_eq!(v.origin, "sender");
        assert_eq!(v.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["T", "V"]);
        assert_eq!((v.items[0].sessions, v.items[0].shared_sessions), (1, 1));
        assert_eq!(v.links["s1"].task_ids, ["T", "V"]);
        assert_eq!(v.links["s1"].source, LinkSource::Llm);
        assert!(sender_view(&per[1..], &["s1"], &facts, &WorkHours::default(), false).is_none());
        // タスクの無いセッションは入れない
        assert!(sender_view(&[("s1".to_string(), vec![])], &["s1"], &facts, &WorkHours::default(), false).is_none());
    }
}
