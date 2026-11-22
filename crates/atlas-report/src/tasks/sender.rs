//! アップロードでセッションごとに添えるタスクの記録(atlas-session.json と atlas-index.json の task)。
//! 送る側は tasks.json と task-links.json から作る。受け取った側(送り先のフォルダを集計した読むだけの画面)は、
//! XML を持たないので、この記録だけからタスクの一覧・絞り込み・工数を作る。送り先のファイルは誰でも書けるので、形と大きさを確かめて読む。

use super::links::{LinkSource, LinksFile};
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderTask {
    pub id: String,
    pub name: String,
    pub status: String,
    pub done: bool,
    pub done_at: Option<String>,
    /// 送った人の手元で、紐づいたセッションのうち最も早い開始
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    pub source: LinkSource,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// 送るときの、セッション id → タスクの記録(紐づいていないセッション・「どのタスクでもない」セッションは入れない)。
/// starts はセッション id → 開始(ISO)。start はタスクに紐づいたセッションのうち最も早いもの
pub fn sender_tasks(state: &TasksFile, links: &LinksFile, starts: &HashMap<String, String>) -> HashMap<String, SenderTask> {
    let mut first: HashMap<&str, i64> = HashMap::new();
    for (sid, l) in &links.links {
        let (Some(tid), Some(ms)) = (l.task_id.as_deref(), starts.get(sid).and_then(|s| atlas_core::jsdate::parse_ms(s))) else { continue };
        let e = first.entry(tid).or_insert(ms);
        *e = (*e).min(ms);
    }
    let mut out = HashMap::new();
    for (sid, l) in &links.links {
        let Some(tid) = l.task_id.as_deref() else { continue };
        let Some(t) = state.tasks.get(tid) else { continue };
        out.insert(
            sid.clone(),
            SenderTask {
                id: tid.to_string(),
                name: t.name.clone(),
                status: t.status.clone(),
                done: t.done,
                done_at: t.done_at.clone(),
                start: first.get(tid).map(|ms| atlas_core::jsdate::to_iso(*ms)),
                source: l.source,
                reason: l.reason.clone(),
            },
        );
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

fn iso(v: Option<&Value>) -> Option<Option<String>> {
    match v {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.len() <= 64 => atlas_core::jsdate::parse_ms(s).map(|ms| Some(atlas_core::jsdate::to_iso(ms))),
        _ => None,
    }
}

/// 添えた記録の task を確かめて読む。形が違えば None(そのセッションはタスクに紐づいていないものとして扱う)
pub fn sender_task_of(v: Option<&Value>) -> Option<SenderTask> {
    let Some(Value::Object(o)) = v else { return None };
    let source = match js::str_of(o.get("source"))? {
        "machine" => LinkSource::Machine,
        "llm" => LinkSource::Llm,
        "manual" => LinkSource::Manual,
        _ => return None,
    };
    let done = o.get("done")?.as_bool()?;
    let done_at = iso(o.get("doneAt"))?;
    Some(SenderTask {
        id: text(o.get("id"), ID_MAX, false)?,
        name: text(o.get("name"), NAME_MAX, true)?,
        status: text(o.get("status"), STATUS_MAX, true)?,
        done,
        done_at: if done { done_at } else { None },
        start: iso(o.get("start"))?,
        source,
        reason: text(o.get("reason"), REASON_MAX, true).unwrap_or_default(),
    })
}

/// 送り先のセッションのフォルダの atlas-session.json から task を読む(無い・大きすぎる・読めない・ほかのセッションのものなら None)
pub fn read_sender_task(path: &Path, id: &str) -> Option<SenderTask> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > META_SIZE_LIMIT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let v = js::parse_json(&String::from_utf8_lossy(&bytes)).ok()?;
    if js::str_of(v.get("id")) != Some(id) {
        return None;
    }
    sender_task_of(v.get("task"))
}

/// 送った人たちの記録から、タスクの一覧と紐づけを作る。同じ ID のタスクは 1 つにまとめる
/// (完了と見た人がいれば完了。完了を確認した時刻と開始は最も早いもの。名前と状態は、完了と見た記録があればそれ、無ければ最初の記録)
pub fn tasks_from_senders(per_session: &[(String, SenderTask)]) -> (Vec<TaskInfo>, Vec<(String, String, LinkSource)>) {
    let mut tasks: IndexMap<String, TaskInfo> = IndexMap::new();
    let earlier = |a: &Option<String>, b: &Option<String>| -> Option<String> {
        match (a.as_deref().and_then(atlas_core::jsdate::parse_ms), b.as_deref().and_then(atlas_core::jsdate::parse_ms)) {
            (Some(x), Some(y)) => Some(atlas_core::jsdate::to_iso(x.min(y))),
            (Some(x), None) => Some(atlas_core::jsdate::to_iso(x)),
            (None, Some(y)) => Some(atlas_core::jsdate::to_iso(y)),
            (None, None) => None,
        }
    };
    let mut links = Vec::with_capacity(per_session.len());
    for (sid, t) in per_session {
        links.push((sid.clone(), t.id.clone(), t.source));
        match tasks.get_mut(&t.id) {
            None => {
                tasks.insert(t.id.clone(), TaskInfo { id: t.id.clone(), name: t.name.clone(), status: t.status.clone(), done: t.done, done_at: t.done_at.clone(), missing: false, start_hint: t.start.clone() });
            }
            Some(cur) => {
                if t.done && !cur.done {
                    cur.done = true;
                    cur.name = t.name.clone();
                    cur.status = t.status.clone();
                    cur.done_at = t.done_at.clone();
                } else if t.done && cur.done {
                    cur.done_at = earlier(&cur.done_at, &t.done_at);
                }
                cur.start_hint = earlier(&cur.start_hint, &t.start);
            }
        }
    }
    (tasks.into_values().collect(), links)
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
        assert!(sender_task_of(Some(&json!([]))).is_none());
        assert!(sender_task_of(None).is_none());
    }

    #[test]
    fn reads_meta_files_with_a_size_cap() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("atlas-session.json");
        std::fs::write(&p, json!({ "version": 1, "id": "s1", "task": { "id": "T", "name": "n", "status": "Open", "done": false, "doneAt": null, "source": "manual" } }).to_string()).unwrap();
        assert_eq!(read_sender_task(&p, "s1").unwrap().source, LinkSource::Manual);
        assert!(read_sender_task(&p, "s2").is_none());
        // 前の版の記録(tags はあっても task が無い)は紐づけなし
        std::fs::write(&p, json!({ "version": 1, "id": "s1", "tags": ["a"] }).to_string()).unwrap();
        assert!(read_sender_task(&p, "s1").is_none());
        std::fs::write(&p, format!("{{\"id\":\"s1\",\"pad\":\"{}\"}}", "x".repeat(META_SIZE_LIMIT as usize))).unwrap();
        assert!(read_sender_task(&p, "s1").is_none());
    }

    #[test]
    fn builds_sender_records_and_merges_them() {
        let mut state = TasksFile::default();
        state.tasks.insert("T".into(), TaskState { name: "仕事".into(), status: "Done".into(), done: true, first_seen_at: "a".into(), done_at: Some("2026-11-05T00:00:00.000Z".into()), last_seen_at: "a".into(), missing: false });
        let mut links = LinksFile::default();
        let l = |t: Option<&str>, s: LinkSource| TaskLink { task_id: t.map(str::to_string), source: s, reason: String::new(), confidence: None, at: "t".into() };
        links.links.insert("s1".into(), l(Some("T"), LinkSource::Machine));
        links.links.insert("s2".into(), l(Some("T"), LinkSource::Manual));
        links.links.insert("s3".into(), l(None, LinkSource::Manual));
        links.links.insert("s4".into(), l(Some("NOPE"), LinkSource::Llm));
        let starts: HashMap<String, String> = [("s1", "2026-11-03T00:00:00Z"), ("s2", "2026-11-02T00:00:00Z")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let st = sender_tasks(&state, &links, &starts);
        assert_eq!(st.len(), 2);
        assert_eq!(st["s1"].start.as_deref(), Some("2026-11-02T00:00:00.000Z"));
        assert_eq!(st["s2"].source, LinkSource::Manual);

        // 2 人が同じタスクを送った: 完了と見た人の記録と、早い方の時刻を使う
        let a = SenderTask { id: "T".into(), name: "古い名前".into(), status: "Open".into(), done: false, done_at: None, start: Some("2026-11-02T00:00:00.000Z".into()), source: LinkSource::Machine, reason: String::new() };
        let b = SenderTask { name: "仕事".into(), status: "Done".into(), done: true, done_at: Some("2026-11-06T00:00:00.000Z".into()), start: Some("2026-11-01T00:00:00.000Z".into()), source: LinkSource::Llm, ..a.clone() };
        let c = SenderTask { done_at: Some("2026-11-05T00:00:00.000Z".into()), ..b.clone() };
        let (tasks, links) = tasks_from_senders(&[("p1".into(), a), ("p2".into(), b), ("p3".into(), c)]);
        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].done);
        assert_eq!(tasks[0].name, "仕事");
        assert_eq!(tasks[0].done_at.as_deref(), Some("2026-11-05T00:00:00.000Z"));
        assert_eq!(tasks[0].start_hint.as_deref(), Some("2026-11-01T00:00:00.000Z"));
        assert_eq!(links.len(), 3);
    }
}
