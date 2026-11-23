//! タスクの状態(<notes-dir>/tasks.json)。管理ツールの XML を読むたびに更新する。
//! 観測の時刻は XML のファイルの更新時刻(書き出した時刻)。同じ更新時刻の XML をもう一度読んでも何も変えない。
//! - 未完了 → 完了: 完了を確認した時刻(doneAt)= その観測の時刻。同じ読み方の 2 回の読み込みで変わったときだけ、完了に変わるのを見た(doneObserved)とする
//!   (読み方(doneStatus など)を変えたせいで完了になったものは、初めて見たときと同じく見ていないとする)
//! - 初めて見たときに完了していたタスク: doneAt はその観測の時刻だが、完了した時刻ではないので doneObserved にしない
//!   (工数では「完了の時刻が分からない」として比べない)
//! - 完了 → 未完了(開き直された): doneAt を消す
//! - XML から消えたタスク: missing にして、最後に見た値を残す(履歴を消さない)
//! - 前に読んだものより古い XML(同じファイル・同じ読み方で、更新時刻が前): 何も変えずに注意を出す(古い書き出しで完了を巻き戻さない)。
//!   別のファイルを指した・読み方を変えたときと、前に読んだ更新時刻が今より 1 日以上先のとき(時計の狂い)は、ふつうに読む
//!
//! 完了を確認した時刻は、管理ツールで完了にした時刻ではなく、完了を最初に見た書き出しの時刻(書き出す間隔だけずれる。出所は「観測」)。
//! 設定に完了日時の項目(tasks.doneAt)があり、完了のタスクの値を読めれば(hours::parse_done_at)、その日時を完了の時刻にする(出所は「記録」)。
//! 記録の完了日時は完了の時刻が分かるものとして、初めて見たときに完了していたタスクでも doneObserved にする。
//! 読めない値は数を知らせ、そのタスクは観測の決め方に戻す。完了のまま記録が無くなったときは、前に決めた時刻と出所を残す。
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
    /// 完了の時刻が分かる(未完了から完了に変わるのを見た、か、XML に完了日時の記録があった)。
    /// 初めて見たときに完了していて記録も無ければ false
    #[serde(default)]
    pub done_observed: bool,
    /// 完了の時刻の出所(記録: XML の完了日時。観測: 完了を見た書き出しの時刻)。未完了なら無い。前の版の tasks.json には無い(観測として読む)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at_source: Option<DoneAtSource>,
}

/// 完了の時刻の出所
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoneAtSource {
    /// 管理ツールの XML にあった完了日時(設定の tasks.doneAt)
    Recorded,
    /// 完了を最初に見た書き出し(XML の更新時刻)
    Observed,
}

impl DoneAtSource {
    pub fn label(self) -> &'static str {
        match self {
            DoneAtSource::Recorded => "記録",
            DoneAtSource::Observed => "観測",
        }
    }
}

impl TaskState {
    /// 完了の時刻の出所(完了していて時刻があるときだけ。前の版の tasks.json は観測)
    pub fn done_source(&self) -> Option<DoneAtSource> {
        (self.done && self.done_at.is_some()).then(|| self.done_at_source.unwrap_or(DoneAtSource::Observed))
    }
}

/// 最後に読んだ XML
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksStamp {
    /// ファイルの名前(画面に出す)
    pub file: String,
    /// 読んだファイルの場所(設定の相対パスを解決したもの)。前の版の tasks.json には無い
    #[serde(default)]
    pub path: String,
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
    /// 完了のタスクのうち、XML の完了日時を完了の時刻にした数(記録)
    pub recorded: usize,
    /// 完了のタスクのうち、完了日時の値を読めなかった数(観測の決め方に戻した)
    pub done_at_unreadable: usize,
}

/// 読んだ XML を状態に反映する(完了日時は読まない)。stamp が前に読んだものと同じなら何もしない
pub fn apply_read(f: &mut TasksFile, read: &XmlRead, stamp: TasksStamp, is_done: impl Fn(&str) -> bool) -> SyncSummary {
    apply_read_with(f, read, stamp, is_done, |_| None)
}

/// apply_read に、XML の完了日時の読み方(読めなければ None)を足したもの
pub fn apply_read_with(f: &mut TasksFile, read: &XmlRead, stamp: TasksStamp, is_done: impl Fn(&str) -> bool, done_at_of: impl Fn(&str) -> Option<i64>) -> SyncSummary {
    if f.source.as_ref() == Some(&stamp) {
        return SyncSummary { unchanged: true, total: read.tasks.len(), ..Default::default() };
    }
    if is_older(f, &stamp, atlas_core::jsdate::now_ms()) {
        return SyncSummary { unchanged: true, older: true, total: read.tasks.len(), ..Default::default() };
    }
    // 同じ読み方での 2 回目以降の読み込みか(読み方を変えて完了になったものは、完了に変わるのを見たとしない)
    let same_settings = f.source.as_ref().is_some_and(|p| p.settings == stamp.settings);
    let obs = stamp.modified_at.clone();
    let mut s = SyncSummary { total: read.tasks.len(), ..Default::default() };
    let mut present = std::collections::HashSet::new();
    for t in &read.tasks {
        present.insert(t.id.as_str());
        let done = is_done(&t.status);
        // XML の完了日時(完了のタスクだけ見る)
        let recorded = if done { t.done_at.as_deref().map(|v| done_at_of(v).map(atlas_core::jsdate::to_iso)) } else { None };
        if matches!(recorded, Some(None)) {
            s.done_at_unreadable += 1;
        }
        let recorded = recorded.flatten();
        if recorded.is_some() {
            s.recorded += 1;
        }
        match f.tasks.get_mut(&t.id) {
            None => {
                s.added += 1;
                if done {
                    s.completed += 1;
                }
                let mut st = TaskState {
                    name: t.name.clone(),
                    status: t.status.clone(),
                    done,
                    first_seen_at: obs.clone(),
                    done_at: done.then(|| obs.clone()),
                    last_seen_at: obs.clone(),
                    missing: false,
                    done_observed: false,
                    done_at_source: done.then_some(DoneAtSource::Observed),
                };
                if let Some(r) = recorded {
                    (st.done_at, st.done_observed, st.done_at_source) = (Some(r), true, Some(DoneAtSource::Recorded));
                }
                f.tasks.insert(t.id.clone(), st);
            }
            Some(cur) => {
                if cur.missing {
                    s.returned += 1;
                }
                if done && !cur.done {
                    s.completed += 1;
                    cur.done_at = Some(obs.clone());
                    cur.done_observed = same_settings;
                    cur.done_at_source = Some(DoneAtSource::Observed);
                } else if !done && cur.done {
                    s.reopened += 1;
                    cur.done_at = None;
                    cur.done_observed = false;
                    cur.done_at_source = None;
                } else if done && cur.done_at.is_none() {
                    cur.done_at = Some(obs.clone());
                    cur.done_observed = false;
                    cur.done_at_source = Some(DoneAtSource::Observed);
                }
                // XML に完了日時の記録があれば、いつもそれを完了の時刻にする(書き出しごとに読み直す)
                if let Some(r) = recorded {
                    (cur.done_at, cur.done_observed, cur.done_at_source) = (Some(r), true, Some(DoneAtSource::Recorded));
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

/// 前に読んだ XML より古いか(同じファイル・同じ読み方で、更新時刻が前)。前に読んだ更新時刻が今より 1 日以上先なら(時計の狂い)止めない
fn is_older(f: &TasksFile, stamp: &TasksStamp, now_ms: i64) -> bool {
    let Some(prev) = f.source.as_ref() else { return false };
    if prev.path != stamp.path || prev.settings != stamp.settings {
        return false;
    }
    let ms = |s: &str| atlas_core::jsdate::parse_ms(s);
    matches!((ms(&prev.modified_at), ms(&stamp.modified_at)), (Some(p), Some(n)) if n < p && p <= now_ms + 86_400_000)
}

/// 読んだファイルの場所(stamp に残す)
fn path_of(p: &Path) -> String {
    p.to_string_lossy().into_owned()
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
        let stamp = TasksStamp { file: file_name(&source.file), path: path_of(&source.file), modified_at: atlas_core::jsdate::to_iso(mtime), settings: settings.clone() };
        if *prev == stamp {
            let total = state.tasks.values().filter(|t| !t.missing).count();
            return Ok(SyncReport { summary: SyncSummary { unchanged: true, total, ..Default::default() }, notes: vec![], state });
        }
    }
    let (read, mtime) = read_tasks_file(&source.file, &XmlSpec::of(source))?;
    let stamp = TasksStamp { file: file_name(&source.file), path: path_of(&source.file), modified_at: atlas_core::jsdate::to_iso(mtime), settings };
    let prev = state.source.as_ref().map(|p| p.modified_at.clone());
    let summary = apply_read_with(&mut state, &read, stamp.clone(), |s| source.is_done(s), |v| super::hours::parse_done_at(v, &source.work_hours));
    if summary.older {
        let when = |iso: &str| atlas_core::jsdate::parse_ms(iso).map_or_else(|| iso.to_string(), |ms| crate::format::date_time(Some(&atlas_core::jsdate::to_iso(ms)), "-"));
        let note = format!(
            "XML の更新時刻({})が、前に読んだもの({})より前です。古い書き出しで状態を戻さないよう、タスクの状態は変えていません。管理ツールから書き出し直すと読みます(古い書き出しを使うときは、tasks.json を消すと初めから読み直します。そのときは完了を確認した時刻が消え、完了済みのタスクは完了の時刻が分からないものになります)",
            when(&stamp.modified_at),
            prev.as_deref().map(when).unwrap_or_default()
        );
        return Ok(SyncReport { summary, notes: vec![note], state });
    }
    if !summary.unchanged {
        save_tasks(state_path, &state).map_err(|e| format!("{e:#}"))?;
    }
    let mut notes = read.notes();
    if summary.done_at_unreadable > 0 {
        notes.push(format!(
            "完了日時(設定の tasks.doneAt)を読めない完了のタスク {} 件は、完了を見た書き出しの時刻(観測)で数えます。読める書き方: 2026-11-20T15:30:00+09:00 などの ISO 8601、2026-11-20・2026/11/20(後ろに 15:30 などの時刻を付けられます)",
            summary.done_at_unreadable
        ));
    }
    Ok(SyncReport { summary, notes, state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::xml::XmlTask;

    fn read(items: &[(&str, &str, &str)]) -> XmlRead {
        XmlRead { tasks: items.iter().map(|(i, n, s)| XmlTask { id: i.to_string(), name: n.to_string(), status: s.to_string(), done_at: None }).collect(), items: items.len(), ..Default::default() }
    }

    /// XML の完了日時: 読めれば完了の時刻(記録)にし、初めて見たときに完了していても時刻が分かるとする。読めなければ観測の決め方
    #[test]
    fn recorded_completion_from_xml() {
        let rec = |items: &[(&str, &str, Option<&str>)]| XmlRead {
            tasks: items.iter().map(|(i, s, d)| XmlTask { id: i.to_string(), name: i.to_string(), status: s.to_string(), done_at: d.map(str::to_string) }).collect(),
            items: items.len(),
            ..Default::default()
        };
        let parse = |v: &str| atlas_core::jsdate::parse_ms(v).filter(|_| v.contains('T'));
        let mut f = TasksFile::default();
        let s = apply_read_with(&mut f, &rec(&[("A", "Done", Some("2026-11-01T10:00:00.000Z")), ("B", "Done", Some("いつか")), ("C", "Open", Some("2026-11-01T10:00:00.000Z")), ("D", "Open", None)]), stamp(T1), done, parse);
        assert_eq!((s.recorded, s.done_at_unreadable), (1, 1));
        assert_eq!((f.tasks["A"].done_at.as_deref(), f.tasks["A"].done_observed, f.tasks["A"].done_source()), (Some("2026-11-01T10:00:00.000Z"), true, Some(DoneAtSource::Recorded)));
        // 読めない値は観測(初めて見たときに完了なので、時刻は分からない)
        assert_eq!((f.tasks["B"].done_at.as_deref(), f.tasks["B"].done_observed, f.tasks["B"].done_source()), (Some(T1), false, Some(DoneAtSource::Observed)));
        // 未完了のタスクの完了日時は使わない
        assert_eq!((f.tasks["C"].done_at.as_deref(), f.tasks["C"].done_source()), (None, None));
        // D が完了になった(記録なし): 観測。C は記録つきで完了になった
        let s = apply_read_with(&mut f, &rec(&[("A", "Done", None), ("B", "Done", Some("2026-11-02T08:00:00.000Z")), ("C", "Done", Some("2026-11-02T09:00:00.000Z")), ("D", "Done", None)]), stamp(T2), done, parse);
        assert_eq!((s.completed, s.recorded), (2, 2));
        assert_eq!((f.tasks["D"].done_at.as_deref(), f.tasks["D"].done_observed, f.tasks["D"].done_source()), (Some(T2), true, Some(DoneAtSource::Observed)));
        assert_eq!((f.tasks["C"].done_at.as_deref(), f.tasks["C"].done_source()), (Some("2026-11-02T09:00:00.000Z"), Some(DoneAtSource::Recorded)));
        // 後から記録が読めるようになった B は記録に。記録が無くなった A は前の時刻と出所のまま
        assert_eq!((f.tasks["B"].done_at.as_deref(), f.tasks["B"].done_observed, f.tasks["B"].done_source()), (Some("2026-11-02T08:00:00.000Z"), true, Some(DoneAtSource::Recorded)));
        assert_eq!((f.tasks["A"].done_at.as_deref(), f.tasks["A"].done_source()), (Some("2026-11-01T10:00:00.000Z"), Some(DoneAtSource::Recorded)));
        // 開き直されたら、時刻も出所も消す
        apply_read_with(&mut f, &rec(&[("A", "Open", Some("2026-11-01T10:00:00.000Z"))]), stamp(T3), done, parse);
        assert_eq!((f.tasks["A"].done_at.as_deref(), f.tasks["A"].done_source(), f.tasks["A"].done_at_source), (None, None, None));
        // 前の版の tasks.json(出所が無い)の完了は観測として読む
        let old: TaskState = serde_json::from_value(serde_json::json!({ "name": "n", "status": "Done", "done": true, "firstSeenAt": T1, "doneAt": T1, "lastSeenAt": T1 })).unwrap();
        assert_eq!(old.done_source(), Some(DoneAtSource::Observed));
    }

    /// ファイルから: 設定の doneAt で読み、読めない値は注意を出す。時刻の無い日付は稼働時間帯の終わり
    #[test]
    fn sync_reads_done_at_from_file() {
        atlas_core::jsdate::with_zone(&atlas_core::jsdate::TimeZone::fixed(atlas_core::jsdate::Offset::constant(9)), || {
            let d = tempfile::tempdir().unwrap();
            let xml = d.path().join("export.xml");
            let state = d.path().join(crate::tasks::TASKS_FILE_NAME);
            let src = TaskSource { done_at: Some("ClosedDate".into()), ..TaskSource::with_file(&xml) };
            std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Done" ClosedDate="2026/11/20"/><Task Id="B" Status="Done"><ClosedDate>先週</ClosedDate></Task></Tasks>"#).unwrap();
            let r = sync_tasks(&src, &state).unwrap();
            assert_eq!(r.state.tasks["A"].done_at.as_deref(), Some("2026-11-20T09:00:00.000Z"));
            assert_eq!(r.state.tasks["A"].done_source(), Some(DoneAtSource::Recorded));
            assert_eq!(r.state.tasks["B"].done_source(), Some(DoneAtSource::Observed));
            assert!(r.notes.iter().any(|n| n.contains("読めない完了のタスク 1 件")), "{:?}", r.notes);
            let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
            assert_eq!(saved["tasks"]["A"]["doneAtSource"], "recorded");
            assert_eq!(saved["tasks"]["B"]["doneAtSource"], "observed");
            // 項目を指さない設定の目印は、前の版と同じ(読み直しで完了の変化を見落とさない)
            assert_eq!(TaskSource::with_file(&xml).settings_key(), TaskSource { done_at: None, ..src.clone() }.settings_key());
            assert_ne!(TaskSource::with_file(&xml).settings_key(), src.settings_key());
        });
    }

    fn stamp(at: &str) -> TasksStamp {
        TasksStamp { file: "export.xml".into(), path: "x/export.xml".into(), modified_at: at.into(), settings: "k".into() }
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
        // 別のファイルを指した・読み方を変えたときは、ふつうに読む
        let mut g = before.clone();
        let s = apply_read(&mut g, &read(&[("A", "a", "Open")]), TasksStamp { path: "y/export.xml".into(), ..stamp(T1) }, done);
        assert!(!s.older && !g.tasks["A"].done);
        let mut g = before.clone();
        let s = apply_read(&mut g, &read(&[("A", "a", "Open")]), TasksStamp { settings: "k2".into(), ..stamp(T1) }, done);
        assert!(!s.older && !g.tasks["A"].done);
        // 前に読んだ更新時刻が今より 1 日以上先(時計の狂い)なら止めない
        let mut g = TasksFile::default();
        apply_read(&mut g, &read(&[("A", "a", "Done")]), stamp("2999-01-01T00:00:00.000Z"), done);
        assert!(!apply_read(&mut g, &read(&[("A", "a", "Open")]), stamp(T1), done).older);
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
        assert!(r.notes[0].contains("書き出し直す") && r.notes[0].contains("tasks.json を消す"), "{:?}", r.notes);
        assert!(r.state.tasks["A"].done);
        assert_eq!(std::fs::read_to_string(&state).unwrap(), saved);
        crate::tasks::with_file_lock(&state, || Ok(())).unwrap();
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

    /// 読み方(doneStatus など)を変えたせいで完了になったものは、完了に変わるのを見たとしない
    #[test]
    fn completion_caused_by_changed_settings_is_not_observed() {
        let mut f = TasksFile::default();
        apply_read(&mut f, &read(&[("A", "a", "Resolved"), ("B", "b", "Open")]), stamp(T1), done);
        assert!(!f.tasks["A"].done);
        // 読み方を変えた(Resolved も完了にした)ので A が完了になった: 完了の時刻は分からない
        let wider = |s: &str| s == "Done" || s == "Resolved";
        apply_read(&mut f, &read(&[("A", "a", "Resolved"), ("B", "b", "Open")]), TasksStamp { settings: "k2".into(), ..stamp(T2) }, wider);
        assert!(f.tasks["A"].done && !f.tasks["A"].done_observed);
        // 同じ読み方で次に読んだときに完了になった B は見た
        apply_read(&mut f, &read(&[("A", "a", "Resolved"), ("B", "b", "Done")]), TasksStamp { settings: "k2".into(), ..stamp(T3) }, wider);
        assert!(f.tasks["B"].done_observed);
        assert_eq!(f.tasks["A"].done_at.as_deref(), Some(T2));
        assert!(!f.tasks["A"].done_observed);
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
        // 一時ファイルを残さない(残るのは tasks.json と、消さずに置くロックのファイルだけ)
        let mut left: Vec<String> = std::fs::read_dir(state.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["tasks.json", "tasks.json.lock"]);
        // 版の違うもの
        std::fs::write(&state, r#"{"version":2,"tasks":{}}"#).unwrap();
        assert!(load_tasks_for_write(&state).unwrap_err().to_string().contains("版 2"));
    }
}
