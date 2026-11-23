//! アップロードでセッションごとに添えるタスクの記録(atlas-session.json と atlas-index.json の tasks。紐づいたタスクの並び)。
//! 送る側は tasks.json と task-links.json から作る。受け取った側(送り先のフォルダを集計した読むだけの画面)は、
//! XML を持たないので、この記録だけからタスクの一覧・絞り込み・工数を作る。送り先のファイルは誰でも書けるので、形と大きさと日時の範囲を確かめて読む。
//! 前の版の記録(task。1 つのタスク)も、1 件の並びとして読む。

use super::links::{LinkSource, LinksFile, MAX_TASKS_PER_SESSION};
use super::metrics::TaskInfo;
use super::state::TasksFile;
use super::xml::{ID_MAX, NAME_MAX, STATUS_MAX};
use atlas_core::js;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// 読む atlas-session.json の大きさの上限(バイト)
const META_SIZE_LIMIT: u64 = 1024 * 1024;
/// 理由の長さの上限(文字)
const REASON_MAX: usize = 500;
/// 受け付ける日時の範囲: 2000-01-01 から、読んだ時刻の 1 日後まで
const DATE_MIN_MS: i64 = 946_684_800_000;
const DAY_MS: i64 = 86_400_000;
/// 開始から完了を確認した時刻までの長さの上限(日)。超える開始は使わない(稼働時間帯の数え方が長く回らないように)
pub const SPAN_MAX_DAYS: i64 = 3_660;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderTask {
    pub id: String,
    pub name: String,
    pub status: String,
    pub done: bool,
    pub done_at: Option<String>,
    /// 完了の時刻が分かる(未完了から完了に変わるのを見たか、XML に完了日時の記録があった)。前の版の記録には無い
    #[serde(default)]
    pub done_observed: bool,
    /// 完了の時刻が XML の完了日時(記録)か。false なら観測。前の版の記録には無い(観測として読む)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done_at_recorded: bool,
    /// 送った人が最後にそのタスクを XML で見た時刻(複数の人の記録が食い違うとき、新しい方を使う)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    /// 送った人の手元で、紐づいたセッションのうち最も早い開始
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    pub source: LinkSource,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// 送るときの、セッション id → 紐づいたタスクの記録の並び(紐づいていないセッション・「どのタスクでもない」セッションは入れない)。
/// 出所と理由はセッションごとに 1 つなので、各タスクに同じものを添える。
/// starts はセッション id → 開始(ISO)。start はタスクに紐づいたセッションのうち、完了を確認した時刻までに始まった最も早いもの
pub fn sender_tasks(state: &TasksFile, links: &LinksFile, starts: &HashMap<String, String>) -> HashMap<String, Vec<SenderTask>> {
    let mut first: HashMap<&str, i64> = HashMap::new();
    for (sid, l) in &links.links {
        let Some(ms) = starts.get(sid).and_then(|s| atlas_core::jsdate::parse_ms(s)) else { continue };
        for tid in &l.task_ids {
            let done_ms = state.tasks.get(tid).filter(|t| t.done).and_then(|t| t.done_at.as_deref()).and_then(atlas_core::jsdate::parse_ms);
            if done_ms.is_some_and(|d| ms > d) {
                continue;
            }
            let e = first.entry(tid.as_str()).or_insert(ms);
            *e = (*e).min(ms);
        }
    }
    let mut out = HashMap::new();
    for (sid, l) in &links.links {
        let ts: Vec<SenderTask> = l
            .task_ids
            .iter()
            .filter_map(|tid| {
                let t = state.tasks.get(tid)?;
                Some(SenderTask {
                    id: tid.to_string(),
                    name: t.name.clone(),
                    status: t.status.clone(),
                    done: t.done,
                    done_at: t.done_at.clone(),
                    done_observed: t.done_observed,
                    done_at_recorded: t.done_source() == Some(super::state::DoneAtSource::Recorded),
                    last_seen_at: Some(t.last_seen_at.clone()).filter(|s| atlas_core::jsdate::parse_ms(s).is_some()),
                    start: first.get(tid.as_str()).map(|ms| atlas_core::jsdate::to_iso(*ms)),
                    source: l.source,
                    reason: l.reason.clone(),
                })
            })
            .collect();
        if !ts.is_empty() {
            out.insert(sid.clone(), ts);
        }
    }
    out
}

/// 文字列の項目(前後の空白を除いて max 文字以内、制御文字なし)
fn text(v: Option<&Value>, max: usize, allow_empty: bool) -> Option<String> {
    let s = js::trim(js::str_of(v)?);
    if (!allow_empty && s.is_empty()) || s.chars().count() > max || s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.to_string())
}

/// 日時の項目。無い・null は Some(None)、形が違う・範囲の外(2000 年より前・読んだ時刻の 1 日後より後)は None
fn iso(v: Option<&Value>, now_ms: i64) -> Option<Option<i64>> {
    match v {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.len() <= 64 => atlas_core::jsdate::parse_ms(s).filter(|ms| (DATE_MIN_MS..=now_ms + DAY_MS).contains(ms)).map(Some),
        _ => None,
    }
}

fn to_iso(ms: Option<i64>) -> Option<String> {
    ms.map(atlas_core::jsdate::to_iso)
}

/// 添えた記録の task を確かめて読む。形が違えば None(そのセッションはタスクに紐づいていないものとして扱う)
pub fn sender_task_of(v: Option<&Value>) -> Option<SenderTask> {
    sender_task_at(v, atlas_core::jsdate::now_ms())
}

fn sender_task_at(v: Option<&Value>, now_ms: i64) -> Option<SenderTask> {
    let Some(Value::Object(o)) = v else { return None };
    let source = match js::str_of(o.get("source"))? {
        "machine" => LinkSource::Machine,
        "llm" => LinkSource::Llm,
        "manual" => LinkSource::Manual,
        _ => return None,
    };
    let done = o.get("done")?.as_bool()?;
    let done_observed = match o.get("doneObserved") {
        None => false,
        Some(b) => b.as_bool()?,
    };
    let done_at_recorded = match o.get("doneAtRecorded") {
        None => false,
        Some(b) => b.as_bool()?,
    };
    let done_at = if done { iso(o.get("doneAt"), now_ms)? } else { None };
    let last_seen = iso(o.get("lastSeenAt"), now_ms)?;
    // 開始は、完了を確認した時刻より後のもの・長すぎるものを使わない(記録は残し、開始だけ捨てる)
    let start = iso(o.get("start"), now_ms)?.filter(|s| done_at.is_none_or(|d| *s <= d && d - *s <= SPAN_MAX_DAYS * DAY_MS)).filter(|s| now_ms - *s <= SPAN_MAX_DAYS * DAY_MS);
    Some(SenderTask {
        id: text(o.get("id"), ID_MAX, false)?,
        name: text(o.get("name"), NAME_MAX, true)?,
        status: text(o.get("status"), STATUS_MAX, true)?,
        done,
        done_at: to_iso(done_at),
        done_observed: done && done_observed,
        done_at_recorded: done && done_at_recorded && done_at.is_some(),
        last_seen_at: to_iso(last_seen),
        start: to_iso(start),
        source,
        reason: text(o.get("reason"), REASON_MAX, true).unwrap_or_default(),
    })
}

/// 添えた記録(atlas-session.json か atlas-index.json の 1 件)から、紐づいたタスクの並びを読む。
/// tasks(並び)があればそれを、無ければ前の版の task(1 つ)を読む。形の違う項目は飛ばし、同じ ID は先のものだけ。
/// 並びが上限(MAX_TASKS_PER_SESSION)より長い・並びでなければ、紐づいていないものとして扱う(空)
pub fn sender_tasks_of(meta: &Value) -> Vec<SenderTask> {
    sender_tasks_at(meta, atlas_core::jsdate::now_ms())
}

fn sender_tasks_at(meta: &Value, now_ms: i64) -> Vec<SenderTask> {
    let items: Vec<&Value> = match meta.get("tasks") {
        Some(Value::Array(a)) if a.len() <= MAX_TASKS_PER_SESSION => a.iter().collect(),
        Some(_) => return vec![],
        None => meta.get("task").into_iter().collect(),
    };
    let mut out: Vec<SenderTask> = Vec::new();
    for v in items {
        if let Some(t) = sender_task_at(Some(v), now_ms)
            && !out.iter().any(|x| x.id == t.id)
        {
            out.push(t);
        }
    }
    out
}

/// 送り先のセッションのフォルダの atlas-session.json から、紐づいたタスクを読む(無い・大きすぎる・読めない・ほかのセッションのものなら空)
pub fn read_sender_tasks(path: &Path, id: &str) -> Vec<SenderTask> {
    let Ok(meta) = std::fs::metadata(path) else { return vec![] };
    if !meta.is_file() || meta.len() > META_SIZE_LIMIT {
        return vec![];
    }
    let Ok(bytes) = std::fs::read(path) else { return vec![] };
    let Ok(v) = js::parse_json(&String::from_utf8_lossy(&bytes)) else { return vec![] };
    if js::str_of(v.get("id")) != Some(id) {
        return vec![];
    }
    sender_tasks_of(&v)
}

/// 記録の新しさ(最後に見た時刻と、完了を確認した時刻の遅い方)
fn observed_ms(t: &SenderTask) -> i64 {
    [t.last_seen_at.as_deref(), t.done_at.as_deref()].into_iter().flatten().filter_map(atlas_core::jsdate::parse_ms).max().unwrap_or(i64::MIN)
}

/// 送った人たちの記録から、タスクの一覧と紐づけを作る。同じ ID のタスクは 1 つにまとめる。
/// 記録が食い違うときは、いちばん新しく見た記録(最後に見た時刻・完了を確認した時刻の遅いもの)の名前・状態・完了を使う。
/// 完了を確認した時刻は、完了に変わるのを見た記録のうち最も早いもの(見た記録が無ければ、完了の時刻は分からない)。開始は最も早いもの
pub fn tasks_from_senders(per_session: &[(String, Vec<SenderTask>)]) -> (Vec<TaskInfo>, Vec<(String, String, LinkSource)>) {
    let mut latest: IndexMap<String, &SenderTask> = IndexMap::new();
    let mut starts: HashMap<&str, i64> = HashMap::new();
    let mut all: HashMap<&str, Vec<&SenderTask>> = HashMap::new();
    let mut links = Vec::with_capacity(per_session.len());
    for (sid, t) in per_session.iter().flat_map(|(sid, ts)| ts.iter().map(move |t| (sid, t))) {
        links.push((sid.clone(), t.id.clone(), t.source));
        all.entry(t.id.as_str()).or_default().push(t);
        match latest.get_mut(&t.id) {
            None => {
                latest.insert(t.id.clone(), t);
            }
            Some(cur) => {
                if observed_ms(t) > observed_ms(cur) {
                    *cur = t;
                }
            }
        }
        if let Some(s) = t.start.as_deref().and_then(atlas_core::jsdate::parse_ms) {
            let e = starts.entry(t.id.as_str()).or_insert(s);
            *e = (*e).min(s);
        }
    }
    let tasks = latest
        .into_values()
        .map(|t| {
            // 完了を確認した時刻は、いちばん新しい記録が XML の完了日時(記録)ならそれ。そうでなければ、いちばん新しい記録と同じく完了で、
            // 完了に変わるのを見た記録のうち最も早いもの(観測)。どの記録も見ていなければ、完了の時刻は分からない(いちばん新しい記録の時刻のまま)
            let recorded = (t.done && t.done_at_recorded).then(|| t.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms)).flatten();
            let observed = if t.done && recorded.is_none() {
                all.get(t.id.as_str()).into_iter().flatten().filter(|x| x.done && x.done_observed && !x.done_at_recorded).filter_map(|x| x.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms)).min()
            } else {
                None
            };
            let known = recorded.or(observed);
            TaskInfo {
                id: t.id.clone(),
                name: t.name.clone(),
                status: t.status.clone(),
                done: t.done,
                done_at: known.map(atlas_core::jsdate::to_iso).or_else(|| t.done_at.clone()),
                done_observed: known.is_some(),
                done_at_source: match (t.done, recorded) {
                    (false, _) => None,
                    (true, Some(_)) => Some(super::state::DoneAtSource::Recorded),
                    (true, None) => t.done_at.as_ref().map(|_| super::state::DoneAtSource::Observed),
                },
                missing: false,
                start_hint: starts.get(t.id.as_str()).map(|ms| atlas_core::jsdate::to_iso(*ms)),
            }
        })
        .collect();
    (tasks, links)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::links::TaskLink;
    use crate::tasks::state::TaskState;
    use serde_json::json;

    #[test]
    fn validates_shape_and_sizes() {
        let ok = json!({ "id": " T-1 ", "name": "名前", "status": "Done", "done": true, "doneAt": "2026-11-02T09:00:00Z", "start": "2026-11-01T09:00:00.000Z", "source": "machine", "reason": "ID が題名にある" });
        let t = sender_task_of(Some(&ok)).unwrap();
        assert_eq!(t.id, "T-1");
        assert_eq!(t.done_at.as_deref(), Some("2026-11-02T09:00:00.000Z"));
        assert_eq!(t.source, LinkSource::Machine);
        let bad = |patch: Value| {
            let mut v = ok.clone();
            for (k, x) in patch.as_object().unwrap() {
                v[k] = x.clone();
            }
            sender_task_of(Some(&v))
        };
        assert!(bad(json!({ "id": "" })).is_none());
        assert!(bad(json!({ "id": "x".repeat(ID_MAX + 1) })).is_none());
        assert!(bad(json!({ "name": "a\u{0007}b" })).is_none());
        assert!(bad(json!({ "source": "group" })).is_none());
        assert!(bad(json!({ "done": "yes" })).is_none());
        assert!(bad(json!({ "doneAt": "いつか" })).is_none());
        assert!(bad(json!({ "start": 5 })).is_none());
        // 未完了なら doneAt は使わない
        assert_eq!(bad(json!({ "done": false })).unwrap().done_at, None);
        // 日時の範囲: 2000 年より前・今より 1 日以上後は読まない
        assert!(bad(json!({ "doneAt": "1999-12-31T00:00:00Z" })).is_none());
        assert!(bad(json!({ "lastSeenAt": "2999-01-01T00:00:00Z" })).is_none());
        assert!(bad(json!({ "doneObserved": "yes" })).is_none());
        assert!(!t.done_observed);
        assert!(bad(json!({ "doneObserved": true })).unwrap().done_observed);
        // 開始は、完了の後のもの・長すぎるもの(SPAN_MAX_DAYS を超える)を捨てる(記録は読む)
        assert_eq!(t.start.as_deref(), Some("2026-11-01T09:00:00.000Z"));
        assert_eq!(bad(json!({ "start": "2026-11-03T00:00:00Z" })).unwrap().start, None);
        assert_eq!(bad(json!({ "start": "2001-01-01T00:00:00Z" })).unwrap().start, None);
        assert!(sender_task_of(Some(&json!([]))).is_none());
        assert!(sender_task_of(None).is_none());
    }

    #[test]
    fn reads_meta_files_with_a_size_cap() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("atlas-session.json");
        // 前の版の記録(task が 1 つ)は 1 件の並び
        std::fs::write(&p, json!({ "version": 1, "id": "s1", "task": { "id": "T", "name": "n", "status": "Open", "done": false, "doneAt": null, "source": "manual" } }).to_string()).unwrap();
        let got = read_sender_tasks(&p, "s1");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].source, LinkSource::Manual);
        assert!(read_sender_tasks(&p, "s2").is_empty());
        // 今の版の記録(tasks の並び)
        let one = |id: &str| json!({ "id": id, "name": "n", "status": "Open", "done": false, "doneAt": null, "source": "machine", "reason": "ID が題名にある" });
        std::fs::write(&p, json!({ "version": 1, "id": "s1", "tasks": [one("A"), one("B")], "task": one("OLD") }).to_string()).unwrap();
        assert_eq!(read_sender_tasks(&p, "s1").iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["A", "B"]);
        // 形の違う項目は飛ばし、同じ ID は先のものだけ
        let v = json!({ "id": "s1", "tasks": [one("A"), { "id": "" }, 5, one("A"), one("C")] });
        assert_eq!(sender_tasks_of(&v).iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["A", "C"]);
        // 上限より長い並び・並びでないものは、紐づけなし
        let long: Vec<Value> = (0..=MAX_TASKS_PER_SESSION).map(|i| one(&format!("T-{i}"))).collect();
        assert!(sender_tasks_of(&json!({ "tasks": long })).is_empty());
        let full: Vec<Value> = (0..MAX_TASKS_PER_SESSION).map(|i| one(&format!("T-{i}"))).collect();
        assert_eq!(sender_tasks_of(&json!({ "tasks": full })).len(), MAX_TASKS_PER_SESSION);
        assert!(sender_tasks_of(&json!({ "tasks": one("A") })).is_empty());
        assert!(sender_tasks_of(&json!({ "tasks": [] })).is_empty());
        // 前の版の記録(tags はあっても task が無い)は紐づけなし
        std::fs::write(&p, json!({ "version": 1, "id": "s1", "tags": ["a"] }).to_string()).unwrap();
        assert!(read_sender_tasks(&p, "s1").is_empty());
        std::fs::write(&p, format!("{{\"id\":\"s1\",\"pad\":\"{}\"}}", "x".repeat(META_SIZE_LIMIT as usize))).unwrap();
        assert!(read_sender_tasks(&p, "s1").is_empty());
    }

    #[test]
    fn builds_sender_records_and_merges_them() {
        let mut state = TasksFile::default();
        state.tasks.insert("T".into(), TaskState { name: "仕事".into(), status: "Done".into(), done: true, first_seen_at: "a".into(), done_at: Some("2026-11-05T00:00:00.000Z".into()), last_seen_at: "2026-11-05T00:00:00.000Z".into(), missing: false, done_observed: true, done_at_source: None });
        let mut links = LinksFile::default();
        state.tasks.insert("U".into(), TaskState { name: "もう一つ".into(), status: "Open".into(), done: false, first_seen_at: "a".into(), done_at: None, last_seen_at: "2026-11-05T00:00:00.000Z".into(), missing: false, done_observed: false, done_at_source: None });
        let l = |t: &[&str], s: LinkSource| TaskLink { task_ids: t.iter().map(|x| x.to_string()).collect(), source: s, reason: "r".into(), confidence: None, at: "t".into() };
        links.links.insert("s1".into(), l(&["T"], LinkSource::Machine));
        links.links.insert("s2".into(), l(&["T"], LinkSource::Manual));
        links.links.insert("s3".into(), l(&[], LinkSource::Manual));
        links.links.insert("s4".into(), l(&["NOPE"], LinkSource::Llm));
        // s5 は完了を確認した後に始まったセッション(開始に使わない)
        links.links.insert("s5".into(), l(&["T"], LinkSource::Manual));
        // s6 は 2 つのタスク(知らないタスクは入れない)
        links.links.insert("s6".into(), l(&["U", "NOPE", "T"], LinkSource::Machine));
        let starts: HashMap<String, String> = [("s1", "2026-11-03T00:00:00Z"), ("s2", "2026-11-02T00:00:00Z"), ("s5", "2026-11-01T00:00:00Z"), ("s6", "2026-11-04T00:00:00Z")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let st = sender_tasks(&state, &links, &starts);
        assert_eq!(st.len(), 4);
        assert_eq!(st["s1"][0].start.as_deref(), Some("2026-11-01T00:00:00.000Z"));
        assert_eq!(st["s6"].iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["U", "T"]);
        assert!(st["s6"].iter().all(|t| t.source == LinkSource::Machine && t.reason == "r"));
        assert_eq!(st["s6"][0].start.as_deref(), Some("2026-11-04T00:00:00.000Z"));
        let late: HashMap<String, String> = [("s1", "2026-11-03T00:00:00Z"), ("s5", "2026-11-09T00:00:00Z")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        assert_eq!(sender_tasks(&state, &links, &late)["s1"][0].start.as_deref(), Some("2026-11-03T00:00:00.000Z"));
        assert_eq!(st["s2"][0].source, LinkSource::Manual);
        assert!(st["s1"][0].done_observed);
        assert_eq!(st["s1"][0].last_seen_at.as_deref(), Some("2026-11-05T00:00:00.000Z"));
        // 送った記録を読み直すと同じ並び
        let v = json!({ "tasks": serde_json::to_value(&st["s6"]).unwrap() });
        assert_eq!(sender_tasks_of(&v), st["s6"]);

        // 2 人の記録が食い違う: いちばん新しく見た記録を使う(完了と見た記録が古ければ、後で開き直された方を使う)
        let base = SenderTask {
            id: "T".into(),
            name: "古い名前".into(),
            status: "Done".into(),
            done: true,
            done_at: Some("2026-11-05T00:00:00.000Z".into()),
            done_observed: true,
            done_at_recorded: false,
            last_seen_at: Some("2026-11-05T00:00:00.000Z".into()),
            start: Some("2026-11-02T00:00:00.000Z".into()),
            source: LinkSource::Machine,
            reason: String::new(),
        };
        let reopened = SenderTask { name: "新しい名前".into(), status: "Open".into(), done: false, done_at: None, done_observed: false, last_seen_at: Some("2026-11-08T00:00:00.000Z".into()), start: Some("2026-11-01T00:00:00.000Z".into()), source: LinkSource::Llm, ..base.clone() };
        let (tasks, links) = tasks_from_senders(&[("p1".into(), vec![base.clone()]), ("p2".into(), vec![reopened.clone()])]);
        assert_eq!(tasks.len(), 1);
        assert_eq!((tasks[0].done, tasks[0].name.as_str(), tasks[0].done_at.clone()), (false, "新しい名前", None));
        assert_eq!(tasks[0].start_hint.as_deref(), Some("2026-11-01T00:00:00.000Z"));
        assert_eq!(links.len(), 2);
        // 完了が新しい記録なら完了(並びに依らない)
        let later_done = SenderTask { last_seen_at: Some("2026-11-09T00:00:00.000Z".into()), done_at: Some("2026-11-09T00:00:00.000Z".into()), ..base.clone() };
        let (tasks, _) = tasks_from_senders(&[("p2".into(), vec![reopened.clone()]), ("p3".into(), vec![later_done.clone()])]);
        assert_eq!((tasks[0].done, tasks[0].done_at.as_deref(), tasks[0].done_observed), (true, Some("2026-11-09T00:00:00.000Z"), true));
        // 完了を見た記録が何件かあれば、完了を確認した時刻は最も早いもの。見ていない記録の時刻は使わない
        let early_observed = SenderTask { last_seen_at: Some("2026-11-06T00:00:00.000Z".into()), done_at: Some("2026-11-06T00:00:00.000Z".into()), ..base.clone() };
        let first_sight = SenderTask { done_observed: false, done_at: Some("2026-11-02T00:00:00.000Z".into()), last_seen_at: Some("2026-11-10T00:00:00.000Z".into()), ..base.clone() };
        let (tasks, _) = tasks_from_senders(&[("a".into(), vec![later_done.clone()]), ("b".into(), vec![early_observed]), ("c".into(), vec![first_sight.clone()])]);
        assert_eq!((tasks[0].done_at.as_deref(), tasks[0].done_observed), (Some("2026-11-06T00:00:00.000Z"), true));
        // どの記録も完了に変わるのを見ていなければ、完了の時刻は分からない
        let (tasks, _) = tasks_from_senders(&[("c".into(), vec![first_sight])]);
        assert!(tasks[0].done && !tasks[0].done_observed);
    }
}
