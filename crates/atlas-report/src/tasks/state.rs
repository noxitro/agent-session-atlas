//! タスクの状態(<notes-dir>/tasks.json)。管理ツールの XML を読むたびに更新する。
//! 観測の時刻は XML のファイルの更新時刻(書き出した時刻)。同じ更新時刻の XML をもう一度読んでも何も変えない。
//! - 未完了 → 完了: 完了を確認した時刻(doneAt)= その観測の時刻。完了に変わるのを見た(doneObserved)
//! - 初めて見たときに完了していたタスク: doneAt はその観測の時刻だが、完了した時刻ではないので doneObserved にしない
//!   (工数では「完了の時刻が分からない」として比べない)
//! - 完了 → 未完了(開き直された): doneAt を消す
//! - XML から消えたタスク: missing にして、最後に見た値を残す(履歴を消さない)
//! - 前に読んだものより古い XML(更新時刻が前): 何も変えずに注意を出す(古い書き出しで完了を巻き戻さない)
//!
//! 完了を確認した時刻は、管理ツールで完了にした時刻ではなく、完了を最初に見た書き出しの時刻(書き出す間隔だけずれる)。
//! 書き込みは壊れたファイルを上書きしない(直してもらう)。読んで書く間はファイルのロック(with_file_lock)を持つ。

use super::xml::{read_tasks_file, XmlRead, XmlSpec, XML_SIZE_LIMIT};
use super::{read_json_file, write_atomic, TaskSource};
use anyhow::{bail, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const TASKS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub name: String,
    pub status: String,
    pub done: bool,
    /// 初めて見た観測の時刻(ISO)
    pub first_seen_at: String,
    /// 完了を確認した観測の時刻(未完了なら null)
    pub done_at: Option<String>,
    /// 最後に見た観測の時刻
    pub last_seen_at: String,
    /// 最後に読んだ XML に無かった
    #[serde(default)]
    pub missing: bool,
    /// 未完了から完了に変わるのを見た(doneAt が完了を見た書き出しの時刻)。初めて見たときに完了していたら false
    #[serde(default)]
    pub done_observed: bool,
}

/// 最後に読んだ XML
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksStamp {
    /// ファイルの名前(場所は設定にある)
    pub file: String,
    /// ファイルの更新時刻(ISO。観測の時刻)
    pub modified_at: String,
    /// 読み方の目印(TaskSource::settings_key)
    pub settings: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksFile {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TasksStamp>,
    #[serde(default)]
    pub tasks: IndexMap<String, TaskState>,
}

impl Default for TasksFile {
    fn default() -> Self {
        TasksFile { version: TASKS_VERSION, source: None, tasks: IndexMap::new() }
    }
}

/// 読んだ tasks.json(読めなければ空と、理由)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadedTasks {
    pub file: TasksFile,
    pub exists: bool,
    pub warnings: Vec<String>,
}

fn parse(path: &Path) -> std::result::Result<Option<TasksFile>, String> {
    let Some(v) = read_json_file(path)? else { return Ok(None) };
    let f: TasksFile = serde_json::from_value(v).map_err(|e| format!("{} の形が違います({e})", path.display()))?;
    if f.version != TASKS_VERSION {
        return Err(format!("{} の版 {} は読めません(この atlas が読めるのは {TASKS_VERSION})", path.display(), f.version));
    }
    Ok(Some(f))
}

/// 読む(無ければ空。読めなければ空と理由)
pub fn load_tasks(path: &Path) -> LoadedTasks {
    match parse(path) {
        Ok(Some(file)) => LoadedTasks { file, exists: true, warnings: vec![] },
        Ok(None) => LoadedTasks::default(),
        Err(e) => LoadedTasks { file: TasksFile::default(), exists: true, warnings: vec![e] },
    }
}

/// 書き換える前に読む。読めない・形が違うファイルは書き換えない
pub fn load_tasks_for_write(path: &Path) -> Result<TasksFile> {
    match parse(path) {
        Ok(f) => Ok(f.unwrap_or_default()),
        Err(e) => bail!("{e}。壊れたファイルは書き換えません(直すか、消してから読み直してください)"),
    }
}

pub fn save_tasks(path: &Path, f: &TasksFile) -> Result<()> {
    write_atomic(path, &format!("{}\n", atlas_core::json::to_js_string_pretty(f)?))
}

/// 1 回の読み込みで変わったこと
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSummary {
    /// 前に読んだときと同じ XML(更新時刻と読み方が同じ)なので、何も変えなかった
    pub unchanged: bool,
    /// XML のタスクの数
    pub total: usize,
    pub added: usize,
    /// 完了になった(初めて見たときに完了していたものも入れる)
    pub completed: usize,
    /// 完了から戻った
    pub reopened: usize,
    /// 今回 XML から消えた
    pub went_missing: usize,
    /// 消えていたのに、また出てきた
    pub returned: usize,
    /// 前に読んだものより古い XML なので、何も変えなかった
    pub older: bool,
}

/// 読んだ XML を状態に反映する。stamp が前に読んだものと同じなら何もしない
pub fn apply_read(f: &mut TasksFile, read: &XmlRead, stamp: TasksStamp, is_done: impl Fn(&str) -> bool) -> SyncSummary {
    if f.source.as_ref() == Some(&stamp) {
        return SyncSummary { unchanged: true, total: read.tasks.len(), ..Default::default() };
    }
    if is_older(f, &stamp) {
        return SyncSummary { unchanged: true, older: true, total: read.tasks.len(), ..Default::default() };
    }
    let obs = stamp.modified_at.clone();
    let mut s = SyncSummary { total: read.tasks.len(), ..Default::default() };
    let mut present = std::collections::HashSet::new();
    for t in &read.tasks {
        present.insert(t.id.as_str());
        let done = is_done(&t.status);
        match f.tasks.get_mut(&t.id) {
            None => {
                s.added += 1;
                if done {
                    s.completed += 1;
                }
                f.tasks.insert(
                    t.id.clone(),
                    TaskState { name: t.name.clone(), status: t.status.clone(), done, first_seen_at: obs.clone(), done_at: done.then(|| obs.clone()), last_seen_at: obs.clone(), missing: false, done_observed: false },
                );
            }
            Some(cur) => {
                if cur.missing {
                    s.returned += 1;
                }
                if done && !cur.done {
                    s.completed += 1;
                    cur.done_at = Some(obs.clone());
                    cur.done_observed = true;
                } else if !done && cur.done {
                    s.reopened += 1;
                    cur.done_at = None;
                    cur.done_observed = false;
                } else if done && cur.done_at.is_none() {
                    cur.done_at = Some(obs.clone());
                    cur.done_observed = false;
                }
                cur.done = done;
                cur.name = t.name.clone();
                cur.status = t.status.clone();
                cur.last_seen_at = obs.clone();
                cur.missing = false;
            }
        }
    }
    for (id, cur) in f.tasks.iter_mut() {
        if !present.contains(id.as_str()) && !cur.missing {
            cur.missing = true;
            s.went_missing += 1;
        }
    }
    f.source = Some(stamp);
    s
}

/// 前に読んだ XML より古いか(更新時刻が前)
fn is_older(f: &TasksFile, stamp: &TasksStamp) -> bool {
    let ms = |s: &str| atlas_core::jsdate::parse_ms(s);
    matches!((f.source.as_ref().and_then(|p| ms(&p.modified_at)), ms(&stamp.modified_at)), (Some(prev), Some(now)) if now < prev)
}

/// XML を読んで tasks.json を更新した結果
#[derive(Debug, Clone, PartialEq)]
pub struct SyncReport {
    pub summary: SyncSummary,
    /// XML を読んだときの注意(ID が空など)
    pub notes: Vec<String>,
    pub state: TasksFile,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// 設定の XML を読み、tasks.json を更新する。XML を読めない・tasks.json が壊れているときは理由を返し、何も書かない(前の状態を残す)。
/// 前に読んだものより古い XML なら何も変えず、注意(notes)を返す。読んで書く間は tasks.json のロックを持つ
pub fn sync_tasks(source: &TaskSource, state_path: &Path) -> std::result::Result<SyncReport, String> {
    let mut outcome: Option<std::result::Result<SyncReport, String>> = None;
    super::with_file_lock(state_path, || {
        outcome = Some(sync_locked(source, state_path));
        Ok(())
    })
    .map_err(|e| format!("{e:#}"))?;
    outcome.expect("ロックの中で決めた")
}

fn sync_locked(source: &TaskSource, state_path: &Path) -> std::result::Result<SyncReport, String> {
    let mut state = load_tasks_for_write(state_path).map_err(|e| e.to_string())?;
    let settings = source.settings_key();
    // 前に読んだときと同じ更新時刻なら、XML を読み直さない
    if let (Ok(meta), Some(prev)) = (std::fs::metadata(&source.file), state.source.as_ref())
        && meta.is_file()
        && meta.len() <= XML_SIZE_LIMIT
    {
        let mtime = atlas_core::jsfs::mtime_ms(&meta).floor() as i64;
        let stamp = TasksStamp { file: file_name(&source.file), modified_at: atlas_core::jsdate::to_iso(mtime), settings: settings.clone() };
        if *prev == stamp {
            let total = state.tasks.values().filter(|t| !t.missing).count();
            return Ok(SyncReport { summary: SyncSummary { unchanged: true, total, ..Default::default() }, notes: vec![], state });
        }
    }
    let (read, mtime) = read_tasks_file(&source.file, &XmlSpec::of(source))?;
    let stamp = TasksStamp { file: file_name(&source.file), modified_at: atlas_core::jsdate::to_iso(mtime), settings };
    let prev = state.source.as_ref().map(|p| p.modified_at.clone());
    let summary = apply_read(&mut state, &read, stamp.clone(), |s| source.is_done(s));
    if summary.older {
        let when = |iso: &str| atlas_core::jsdate::parse_ms(iso).map_or_else(|| iso.to_string(), |ms| crate::format::date_time(Some(&atlas_core::jsdate::to_iso(ms)), "-"));
        let note = format!(
            "XML の更新時刻({})が、前に読んだもの({})より前です。古い書き出しで状態を戻さないよう、タスクの状態は変えていません",
            when(&stamp.modified_at),
            prev.as_deref().map(when).unwrap_or_default()
        );
        return Ok(SyncReport { summary, notes: vec![note], state });
    }
    if !summary.unchanged {
        save_tasks(state_path, &state).map_err(|e| format!("{e:#}"))?;
    }
    Ok(SyncReport { summary, notes: read.notes(), state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::xml::XmlTask;

    fn read(items: &[(&str, &str, &str)]) -> XmlRead {
        XmlRead { tasks: items.iter().map(|(i, n, s)| XmlTask { id: i.to_string(), name: n.to_string(), status: s.to_string() }).collect(), items: items.len(), ..Default::default() }
    }

    fn stamp(at: &str) -> TasksStamp {
        TasksStamp { file: "export.xml".into(), modified_at: at.into(), settings: "k".into() }
    }

    fn done(s: &str) -> bool {
        s == "Done"
    }

    const T1: &str = "2026-11-02T09:00:00.000Z";
    const T2: &str = "2026-11-03T09:00:00.000Z";
    const T3: &str = "2026-11-04T09:00:00.000Z";

    #[test]
    fn transitions() {
        let mut f = TasksFile::default();
        let s = apply_read(&mut f, &read(&[("A", "画面", "Open"), ("B", "初めから完了", "Done")]), stamp(T1), done);
        assert_eq!((s.added, s.completed, s.unchanged), (2, 1, false));
        assert_eq!(f.tasks["A"].done_at, None);
        // 初めて見たときに完了していたタスクも、その観測の時刻を完了を確認した時刻にする。ただし完了に変わるのは見ていない
        assert_eq!(f.tasks["B"].done_at.as_deref(), Some(T1));
        assert!(!f.tasks["B"].done_observed);
        assert_eq!(f.tasks["B"].first_seen_at, T1);

        // A が完了になり、B は開き直された。名前の変更も写す
        let s = apply_read(&mut f, &read(&[("A", "画面(改)", "Done"), ("B", "初めから完了", "Open")]), stamp(T2), done);
        assert_eq!((s.completed, s.reopened, s.added), (1, 1, 0));
        assert_eq!(f.tasks["A"].done_at.as_deref(), Some(T2));
        assert!(f.tasks["A"].done_observed);
        assert_eq!(f.tasks["A"].name, "画面(改)");
        assert_eq!(f.tasks["B"].done_at, None);
        assert!(!f.tasks["B"].done_observed);
        assert!(!f.tasks["B"].done);

        // 完了のまま: 完了を確認した時刻は最初のまま。B は XML から消えた(最後の値を残す)
        let s = apply_read(&mut f, &read(&[("A", "画面(改)", "Done")]), stamp(T3), done);
        assert_eq!((s.completed, s.went_missing), (0, 1));
        assert_eq!(f.tasks["A"].done_at.as_deref(), Some(T2));
        assert_eq!(f.tasks["A"].last_seen_at, T3);
        assert!(f.tasks["B"].missing);
        assert_eq!(f.tasks["B"].name, "初めから完了");
        assert_eq!(f.tasks["B"].last_seen_at, T2);

        // また出てきた
        let s = apply_read(&mut f, &read(&[("A", "画面(改)", "Done"), ("B", "初めから完了", "Done")]), stamp("2026-11-05T09:00:00.000Z"), done);
        assert_eq!((s.returned, s.completed), (1, 1));
        assert!(!f.tasks["B"].missing);
        assert_eq!(f.tasks["B"].done_at.as_deref(), Some("2026-11-05T09:00:00.000Z"));
        assert!(f.tasks["B"].done_observed);
    }

    /// 前に読んだものより古い XML は、状態を変えずに注意を出す
    #[test]
    fn older_xml_does_not_roll_back() {
        let mut f = TasksFile::default();
        apply_read(&mut f, &read(&[("A", "a", "Done")]), stamp(T2), done);
        let before = f.clone();
        let s = apply_read(&mut f, &read(&[("A", "a", "Open"), ("C", "c", "Open")]), stamp(T1), done);
        assert!(s.older && s.unchanged);
        assert_eq!(f, before);
        // 読み方を変えても、古い XML では変えない
        let s = apply_read(&mut f, &read(&[("A", "a", "Open")]), TasksStamp { settings: "k2".into(), ..stamp(T1) }, done);
        assert!(s.older);
        assert_eq!(f, before);
        // ファイルから: 注意を返し、tasks.json は書かない
        let d = tempfile::tempdir().unwrap();
        let xml = d.path().join("export.xml");
        let state = d.path().join(crate::tasks::TASKS_FILE_NAME);
        let src = TaskSource::with_file(&xml);
        std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Done"/></Tasks>"#).unwrap();
        let t = 1_795_000_000_000;
        atlas_core::jsfs::utimes(&xml, t, t).unwrap();
        sync_tasks(&src, &state).unwrap();
        let saved = std::fs::read_to_string(&state).unwrap();
        std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Open"/></Tasks>"#).unwrap();
        atlas_core::jsfs::utimes(&xml, t - 3_600_000, t - 3_600_000).unwrap();
        let r = sync_tasks(&src, &state).unwrap();
        assert!(r.summary.older);
        assert!(r.notes[0].contains("前に読んだもの"), "{:?}", r.notes);
        assert!(r.state.tasks["A"].done);
        assert_eq!(std::fs::read_to_string(&state).unwrap(), saved);
        assert!(!crate::tasks::lock_path(&state).exists());
    }

    /// e2e でも使う架空の書き出し(前と後)を続けて読む
    #[test]
    fn shared_fixtures_before_and_after() {
        let d = tempfile::tempdir().unwrap();
        let xml = d.path().join("export.xml");
        let state = d.path().join(crate::tasks::TASKS_FILE_NAME);
        let src = TaskSource::with_file(&xml);
        let fixture = |name: &str| std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/tasks").join(name)).unwrap();
        std::fs::write(&xml, fixture("export-before.xml")).unwrap();
        let t1 = 1_795_000_000_000;
        atlas_core::jsfs::utimes(&xml, t1, t1).unwrap();
        let r = sync_tasks(&src, &state).unwrap();
        assert_eq!((r.summary.added, r.summary.completed), (6, 1));
        assert_eq!(r.state.tasks["DEMO-104"].done_at.as_deref(), Some(atlas_core::jsdate::to_iso(t1).as_str()));
        std::fs::write(&xml, fixture("export-after.xml")).unwrap();
        let t2 = t1 + 86_400_000;
        atlas_core::jsfs::utimes(&xml, t2, t2).unwrap();
        let r = sync_tasks(&src, &state).unwrap();
        assert_eq!((r.summary.added, r.summary.completed, r.summary.went_missing, r.summary.reopened), (1, 3, 1, 0));
        let t2s = atlas_core::jsdate::to_iso(t2);
        for id in ["DEMO-101", "DEMO-102", "DEMO-102-1"] {
            assert_eq!(r.state.tasks[id].done_at.as_deref(), Some(t2s.as_str()), "{id}");
        }
        assert_eq!(r.state.tasks["DEMO-104"].done_at.as_deref(), Some(atlas_core::jsdate::to_iso(t1).as_str()));
        assert!(!r.state.tasks["DEMO-104"].done_observed);
        assert!(r.state.tasks["DEMO-101"].done_observed);
        assert!(r.state.tasks["DEMO-106"].missing);
        assert!(!r.state.tasks["DEMO-103"].done);
    }

    #[test]
    fn same_stamp_is_idempotent() {
        let mut f = TasksFile::default();
        apply_read(&mut f, &read(&[("A", "a", "Open")]), stamp(T1), done);
        let before = f.clone();
        // 同じ更新時刻(と読み方)なら、中身が違っても何も変えない
        let s = apply_read(&mut f, &read(&[("A", "a", "Done")]), stamp(T1), done);
        assert!(s.unchanged);
        assert_eq!(f, before);
        // 読み方を変えたら読み直す
        let s = apply_read(&mut f, &read(&[("A", "a", "Done")]), TasksStamp { settings: "k2".into(), ..stamp(T1) }, done);
        assert!(!s.unchanged);
        assert!(f.tasks["A"].done);
    }

    #[test]
    fn sync_reads_files_keeps_state_on_errors_and_refuses_broken() {
        let d = tempfile::tempdir().unwrap();
        let xml = d.path().join("export.xml");
        let state = d.path().join("notes").join(crate::tasks::TASKS_FILE_NAME);
        let src = TaskSource::with_file(&xml);
        std::fs::write(&xml, r#"<Tasks><Task Id="X-1" Name="一つ目" Status="Open"/></Tasks>"#).unwrap();
        let r = sync_tasks(&src, &state).unwrap();
        assert_eq!((r.summary.added, r.summary.total), (1, 1));
        assert_eq!(load_tasks(&state).file.tasks.len(), 1);
        // 同じファイルをもう一度: 読み直さない
        let r = sync_tasks(&src, &state).unwrap();
        assert!(r.summary.unchanged);
        assert_eq!(r.summary.total, 1);
        // XML が壊れた・消えた: 理由を返し、前の状態は残す
        std::fs::write(&xml, "<Tasks><Task").unwrap();
        let later = atlas_core::jsdate::now_ms() + 60_000;
        atlas_core::jsfs::utimes(&xml, later, later).unwrap();
        assert!(sync_tasks(&src, &state).unwrap_err().contains("XML として読めません"));
        std::fs::remove_file(&xml).unwrap();
        assert!(sync_tasks(&src, &state).unwrap_err().contains("ありません"));
        assert_eq!(load_tasks(&state).file.tasks["X-1"].name, "一つ目");
        // 壊れた tasks.json は書き換えない
        std::fs::write(&xml, r#"<Tasks><Task Id="X-2"/></Tasks>"#).unwrap();
        std::fs::write(&state, "{ 壊れた").unwrap();
        assert!(sync_tasks(&src, &state).unwrap_err().contains("書き換えません"));
        assert_eq!(std::fs::read_to_string(&state).unwrap(), "{ 壊れた");
        assert!(!load_tasks(&state).warnings.is_empty());
        // 一時ファイルを残さない
        assert_eq!(std::fs::read_dir(state.parent().unwrap()).unwrap().count(), 1);
        // 版の違うもの
        std::fs::write(&state, r#"{"version":2,"tasks":{}}"#).unwrap();
        assert!(load_tasks_for_write(&state).unwrap_err().to_string().contains("版 2"));
    }
}
