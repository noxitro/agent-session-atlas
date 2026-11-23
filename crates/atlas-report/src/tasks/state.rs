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
//! 読めない値(書き方の違うもの・2000 年より前・XML の更新時刻の 1 日後より後)は数を知らせ、そのタスクは観測の決め方に戻す。
//! ただし前に記録の時刻を決めたタスクは、読めない値でも、値が無くなっても(doneAt を設定から外したときも)、前の時刻と出所を残す(数は分けて知らせる)。
//! 日付だけの完了日(hours::DoneAt::date)は、暦の日付の文字(doneDate。"2026-11-20")と doneDateOnly に残す。
//! doneAt は読んだ PC の時間帯での、その日の稼働時間帯の終わり(前の版の atlas が読む値)。
//! 工数(稼働時間帯の終わりまで)と、候補と「完了の後に始まった」の判定(その日の終わり 24:00。TaskState::done_cutoff_ms)は、
//! 日付の文字と集計する PC の時間帯から決める(見る PC の時間帯で日付がずれないように)。
//! 前の版の tasks.json(doneDateOnly だけ)は、前の版と同じ計算で日付を決める(hours::done_date_text)。
//! そのようなタスクがあれば、次の読み込みでは同じ更新時刻の XML でも読み直して doneDate を埋める(読めなければ前の版と同じ計算の日付で埋める)。
//! 「同じ読み方」かは、稼働時間帯を除いた目印(TaskSource::reading_key)で見る(稼働時間帯を変えた回に完了したタスクも、完了に変わるのを見たとする)。
//! 読み直すかは、稼働時間帯も入れた目印(settings_key)で決める(日付だけの完了日の時刻が変わるため)。
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
    /// 完了の時刻が、XML の日付だけの完了日から決めたもの(時刻はその日の稼働時間帯の終わり)。記録のときだけ。前の版の tasks.json には無い。
    /// 前の版の atlas が読むので、done_date と一緒に書く
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done_date_only: bool,
    /// 日付だけの完了日の、暦の日付の文字("YYYY-MM-DD")。done_date_only のときだけ。前の版の tasks.json には無い(done_date を使う)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_date: Option<String>,
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

    /// 日付だけの完了日の、暦の日付の文字(記録で日付だけのときだけ。前の版の tasks.json は前の版と同じ計算で決める)
    pub fn done_date(&self) -> Option<String> {
        if !self.done_date_only || self.done_source() != Some(DoneAtSource::Recorded) {
            return None;
        }
        super::hours::done_date_text(self.done_date.as_deref(), self.done_at.as_deref())
    }

    /// 候補と「完了の後に始まった」の判定に使う完了の時刻(完了していなければ None)。日付だけの完了日は、その日の終わり(24:00)
    pub fn done_cutoff_ms(&self) -> Option<i64> {
        if !self.done {
            return None;
        }
        done_cutoff(self.done_at.as_deref(), self.done_date().as_deref())
    }
}

/// 完了の時刻(ISO)から、候補と「完了の後に始まった」の判定に使う時刻。日付だけの完了日(done_date)は、
/// その日付の終わり(この PC の時間帯の翌日 0 時)
pub fn done_cutoff(done_at: Option<&str>, done_date: Option<&str>) -> Option<i64> {
    let ms = done_at.and_then(atlas_core::jsdate::parse_ms);
    if let Some(end) = done_date.and_then(super::hours::parse_date).and_then(super::hours::date_end_ms) {
        return Some(end);
    }
    ms
}

/// 完了の時刻(ISO)から、工数(稼働時間帯の長さ)を数える終わり。日付だけの完了日(done_date)は、その日付の稼働時間帯の終わり
/// (この PC の時間帯。24:00 なら翌日の 0 時)
pub fn done_work_end(done_at: Option<&str>, done_date: Option<&str>, wh: &super::hours::WorkHours) -> Option<i64> {
    if let Some(end) = done_date.and_then(super::hours::parse_date).and_then(|d| super::hours::date_work_end_ms(d, wh)) {
        return Some(end);
    }
    done_at.and_then(atlas_core::jsdate::parse_ms)
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
    /// 読み方の目印(TaskSource::settings_key。読み直すかはこれで決める)
    pub settings: String,
    /// 稼働時間帯を除いた読み方の目印(TaskSource::reading_key)。settings と違うとき(完了日時の項目を指したとき)だけ書く。
    /// 「同じ読み方」(完了に変わるのを見たか)はこれで比べる。無ければ settings と同じ
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
}

impl TasksStamp {
    /// 「同じ読み方」を比べる目印(稼働時間帯を除いたもの)
    pub fn reading_key(&self) -> &str {
        self.reading.as_deref().unwrap_or(&self.settings)
    }

    /// 読み方の目印 2 つを設定から入れる
    pub fn of(source: &TaskSource, file: String, path: String, modified_at: String) -> TasksStamp {
        let settings = source.settings_key();
        let reading = Some(source.reading_key()).filter(|r| *r != settings);
        TasksStamp { file, path, modified_at, settings, reading }
    }
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
    /// 完了のタスクのうち、完了日時の値を読めなかった数(観測の決め方に戻した)。範囲の外(2000 年より前・XML の更新時刻の 1 日後より後)も入れる
    pub done_at_unreadable: usize,
    /// 完了日時の値を読めなかったが、前に記録の時刻を決めてあったので、前の記録を残した数(done_at_unreadable とは別に数える)
    pub done_at_unreadable_kept: usize,
    /// 前の版が書いた日付だけの完了日(doneDateOnly だけで doneDate が無いもの)に、暦の日付の文字を埋めた数
    pub dates_filled: usize,
}

/// 前の版が書いた日付だけの完了日(doneDateOnly だけで doneDate が無いもの)か。あれば、同じ XML でも読み直して日付の文字を埋める
fn lacks_done_date(t: &TaskState) -> bool {
    t.done_date_only && t.done_date.is_none() && t.done_source() == Some(DoneAtSource::Recorded)
}

/// 日付の文字の無い日付だけの完了日があるか(前の版の tasks.json。次の読み込みで XML を読み直す)
pub fn needs_date_refill(f: &TasksFile) -> bool {
    f.tasks.values().any(lacks_done_date)
}

/// 2000-01-01T00:00:00Z(これより前の完了日時は読めない値とする。送った人の記録の日時と同じ範囲)
const DONE_AT_MIN_MS: i64 = 946_684_800_000;
const DAY_MS: i64 = 86_400_000;

/// 読んだ XML を状態に反映する(完了日時は読まない)。stamp が前に読んだものと同じなら何もしない
pub fn apply_read(f: &mut TasksFile, read: &XmlRead, stamp: TasksStamp, is_done: impl Fn(&str) -> bool) -> SyncSummary {
    apply_read_with(f, read, stamp, is_done, |_| None)
}

/// apply_read に、XML の完了日時の読み方(読めなければ None)を足したもの。
/// 読めても、2000 年より前・XML の更新時刻(観測の時刻)の 1 日後より後のものは、読めない値とする(書き間違い・予定日の取り違えなど)
/// 前の版が書いた日付だけの完了日(doneDate の無いもの)があれば、同じ XML でも読み直して日付の文字を埋める
/// (XML から読めなかったものは、前の版と同じ計算の日付で埋め、次からは読み直さない)
pub fn apply_read_with(f: &mut TasksFile, read: &XmlRead, stamp: TasksStamp, is_done: impl Fn(&str) -> bool, done_at_of: impl Fn(&str) -> Option<super::hours::DoneAt>) -> SyncSummary {
    let refill = needs_date_refill(f);
    if f.source.as_ref() == Some(&stamp) && !refill {
        return SyncSummary { unchanged: true, total: read.tasks.len(), ..Default::default() };
    }
    let lacking = f.tasks.values().filter(|t| lacks_done_date(t)).count();
    if is_older(f, &stamp, atlas_core::jsdate::now_ms()) {
        return SyncSummary { unchanged: true, older: true, total: read.tasks.len(), ..Default::default() };
    }
    // 同じ読み方での 2 回目以降の読み込みか(読み方を変えて完了になったものは、完了に変わるのを見たとしない)。
    // 稼働時間帯は完了かどうかの読み方を変えないので、比べる目印に入れない
    let same_settings = f.source.as_ref().is_some_and(|p| p.reading_key() == stamp.reading_key());
    let obs = stamp.modified_at.clone();
    let latest = atlas_core::jsdate::parse_ms(&obs).map(|ms| ms + DAY_MS);
    let in_range = |d: &super::hours::DoneAt| d.ms >= DONE_AT_MIN_MS && latest.is_none_or(|l| d.ms <= l);
    let mut s = SyncSummary { total: read.tasks.len(), ..Default::default() };
    let mut present = std::collections::HashSet::new();
    for t in &read.tasks {
        present.insert(t.id.as_str());
        let done = is_done(&t.status);
        // XML の完了日時(完了のタスクだけ見る)
        let recorded = if done { t.done_at.as_deref().map(|v| done_at_of(v).filter(in_range)) } else { None };
        if matches!(recorded, Some(None)) {
            // 前に記録の時刻を決めてあるタスク(完了のまま)は、前の記録を残す(下の Some(cur) の枝)。数は分けて知らせる
            if f.tasks.get(&t.id).is_some_and(|c| c.done && c.done_source() == Some(DoneAtSource::Recorded)) {
                s.done_at_unreadable_kept += 1;
            } else {
                s.done_at_unreadable += 1;
            }
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
                    done_date_only: false,
                    done_date: None,
                };
                if let Some(r) = recorded {
                    set_recorded(&mut st, &r);
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
                    cur.done_date_only = false;
                    cur.done_date = None;
                } else if !done && cur.done {
                    s.reopened += 1;
                    cur.done_at = None;
                    cur.done_observed = false;
                    cur.done_at_source = None;
                    cur.done_date_only = false;
                    cur.done_date = None;
                } else if done && cur.done_at.is_none() {
                    cur.done_at = Some(obs.clone());
                    cur.done_observed = false;
                    cur.done_at_source = Some(DoneAtSource::Observed);
                    cur.done_date_only = false;
                    cur.done_date = None;
                }
                // XML に完了日時の記録があれば、いつもそれを完了の時刻にする(書き出しごとに読み直す)
                if let Some(r) = recorded {
                    set_recorded(cur, &r);
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
        // XML から日付の文字を読めなかった前の版の日付だけの完了日は、前の版と同じ計算の日付で埋める(毎回読み直さないように)
        if lacks_done_date(cur) {
            cur.done_date = super::hours::done_date_text(None, cur.done_at.as_deref());
        }
    }
    s.dates_filled = lacking - f.tasks.values().filter(|t| lacks_done_date(t)).count();
    f.source = Some(stamp);
    s
}

/// XML の完了日時(記録)を完了の時刻にする。日付だけなら、暦の日付の文字も残す
fn set_recorded(t: &mut TaskState, r: &super::hours::DoneAt) {
    t.done_at = Some(atlas_core::jsdate::to_iso(r.ms));
    t.done_observed = true;
    t.done_at_source = Some(DoneAtSource::Recorded);
    t.done_date_only = r.date_only();
    t.done_date = r.date.map(super::hours::format_date);
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
    // 前に読んだときと同じ更新時刻なら、XML を読み直さない(前の版が書いた日付だけの完了日に、日付の文字が無いときは読み直す)
    if let (Ok(meta), Some(prev)) = (std::fs::metadata(&source.file), state.source.as_ref())
        && !needs_date_refill(&state)
        && meta.is_file()
        && meta.len() <= XML_SIZE_LIMIT
    {
        let mtime = atlas_core::jsfs::mtime_ms(&meta).floor() as i64;
        let stamp = TasksStamp::of(source, file_name(&source.file), path_of(&source.file), atlas_core::jsdate::to_iso(mtime));
        if *prev == stamp {
            let total = state.tasks.values().filter(|t| !t.missing).count();
            return Ok(SyncReport { summary: SyncSummary { unchanged: true, total, ..Default::default() }, notes: vec![], state });
        }
    }
    let (read, mtime) = read_tasks_file(&source.file, &XmlSpec::of(source))?;
    let stamp = TasksStamp::of(source, file_name(&source.file), path_of(&source.file), atlas_core::jsdate::to_iso(mtime));
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
    const READABLE: &str = "読める書き方: 2026-11-20T15:30:00+09:00 などの ISO 8601、2026-11-20・2026/11/20(後ろに 15:30 などの時刻を付けられます)。2000 年より前と、XML の書き出しの 1 日後より後の日時は読みません";
    if summary.done_at_unreadable > 0 {
        notes.push(format!("完了日時(設定の tasks.doneAt)を読めない完了のタスク {} 件は、完了を見た書き出しの時刻(観測)で数えます。{READABLE}", summary.done_at_unreadable));
    }
    if summary.dates_filled > 0 {
        notes.push(format!("前の版の atlas が書いた日付だけの完了日 {} 件に、暦の日付の文字(doneDate)を埋めました(XML を読み直しました)", summary.dates_filled));
    }
    if summary.done_at_unreadable_kept > 0 {
        notes.push(format!("完了日時(設定の tasks.doneAt)を今回は読めなかった完了のタスク {} 件は、前に読んだ完了日時(記録)を残します。{READABLE}", summary.done_at_unreadable_kept));
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
        let parse = |v: &str| atlas_core::jsdate::parse_ms(v).filter(|_| v.contains('T')).map(|ms| crate::tasks::hours::DoneAt { ms, date: None });
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
        assert!(!old.done_date_only);
    }

    /// 前に記録の時刻を決めたタスクの値が読めなくなったら、前の記録を残し、観測で数えるものとは分けて数える
    #[test]
    fn unreadable_value_keeps_the_previous_record() {
        let rec = |items: &[(&str, Option<&str>)]| XmlRead {
            tasks: items.iter().map(|(i, d)| XmlTask { id: i.to_string(), name: i.to_string(), status: "Done".into(), done_at: d.map(str::to_string) }).collect(),
            items: items.len(),
            ..Default::default()
        };
        let parse = |v: &str| atlas_core::jsdate::parse_ms(v).filter(|_| v.contains('T')).map(|ms| crate::tasks::hours::DoneAt { ms, date: None });
        let mut f = TasksFile::default();
        apply_read_with(&mut f, &rec(&[("A", Some("2026-11-01T10:00:00.000Z")), ("B", None)]), stamp(T1), done, parse);
        let s = apply_read_with(&mut f, &rec(&[("A", Some("いつか")), ("B", Some("先週"))]), stamp(T2), done, parse);
        // A は前の記録を残す(観測で数えるのは B だけ)
        assert_eq!((s.done_at_unreadable, s.done_at_unreadable_kept), (1, 1));
        assert_eq!((f.tasks["A"].done_at.as_deref(), f.tasks["A"].done_source()), (Some("2026-11-01T10:00:00.000Z"), Some(DoneAtSource::Recorded)));
        assert_eq!(f.tasks["B"].done_source(), Some(DoneAtSource::Observed));
    }

    /// XML の更新時刻の 1 日後より後と、2000 年より前の完了日時は、読めない値として観測に戻す
    #[test]
    fn future_and_too_old_done_at_are_unreadable() {
        let rec = |d: &str| XmlRead { tasks: vec![XmlTask { id: "A".into(), name: "A".into(), status: "Done".into(), done_at: Some(d.into()) }], items: 1, ..Default::default() };
        let parse = |v: &str| atlas_core::jsdate::parse_ms(v).map(|ms| crate::tasks::hours::DoneAt { ms, date: None });
        // T1 = 2026-11-02T09:00Z。1 日後ちょうどまでは読む
        for (v, ok) in [("2026-11-03T09:00:00.000Z", true), ("2026-11-03T09:00:00.001Z", false), ("2030-01-01T00:00:00.000Z", false), ("1999-12-31T23:59:59.000Z", false), ("2000-01-01T00:00:00.000Z", true)] {
            let mut f = TasksFile::default();
            let s = apply_read_with(&mut f, &rec(v), stamp(T1), done, parse);
            assert_eq!((s.recorded, s.done_at_unreadable), (usize::from(ok), usize::from(!ok)), "{v}");
            let want = if ok { (Some(v), Some(DoneAtSource::Recorded)) } else { (Some(T1), Some(DoneAtSource::Observed)) };
            assert_eq!((f.tasks["A"].done_at.as_deref(), f.tasks["A"].done_source()), want, "{v}");
        }
    }

    /// 日付だけの完了日: 時刻は稼働時間帯の終わり(工数)、候補と「完了の後に始まった」の判定はその日の終わり
    #[test]
    fn date_only_done_at_keeps_the_day_end_for_cutoffs() {
        atlas_core::jsdate::with_zone(&atlas_core::jsdate::TimeZone::fixed(atlas_core::jsdate::Offset::constant(9)), || {
            let wh = crate::tasks::WorkHours::default();
            let rec = |d: &str| XmlRead { tasks: vec![XmlTask { id: "A".into(), name: "A".into(), status: "Done".into(), done_at: Some(d.into()) }], items: 1, ..Default::default() };
            let mut f = TasksFile::default();
            apply_read_with(&mut f, &rec("2026/11/20"), stamp("2026-11-21T00:00:00.000Z"), done, |v| crate::tasks::hours::parse_done_at(v, &wh));
            let a = &f.tasks["A"];
            assert_eq!((a.done_at.as_deref(), a.done_date_only), (Some("2026-11-20T09:00:00.000Z"), true));
            let ms = |s: &str| atlas_core::jsdate::parse_ms(s).unwrap();
            assert_eq!(a.done_cutoff_ms(), Some(ms("2026-11-21T00:00:00+09:00")));
            // その日の夜(稼働時間帯の後)に始めたセッションも候補。翌日に始めたものは候補でない
            assert!(crate::tasks::links::is_candidate(a, Some(ms("2026-11-20T20:00:00+09:00"))));
            assert!(!crate::tasks::links::is_candidate(a, Some(ms("2026-11-21T00:00:00.001+09:00"))));
            let saved = serde_json::to_value(a).unwrap();
            assert_eq!(saved["doneDateOnly"], true);
            // 暦の日付の文字も残す(見る PC の時間帯で日付がずれないように)
            assert_eq!(saved["doneDate"], "2026-11-20");
            assert_eq!(a.done_date().as_deref(), Some("2026-11-20"));
            // 時間帯の違う PC で見ても、日付と締め切り(その PC の 11/21 0:00)は日付の文字から決まる
            let a2 = a.clone();
            atlas_core::jsdate::with_zone(&atlas_core::jsdate::TimeZone::fixed(atlas_core::jsdate::Offset::constant(-10)), || {
                assert_eq!(a2.done_date().as_deref(), Some("2026-11-20"));
                assert_eq!(a2.done_cutoff_ms(), Some(ms("2026-11-21T00:00:00-10:00")));
                // 前の版の tasks.json(doneDateOnly だけ)は、前の版と同じ計算(doneAt の 1 ミリ秒前の、この PC の日付)
                let old = TaskState { done_date: None, ..a2.clone() };
                assert_eq!(old.done_date().as_deref(), Some("2026-11-19"));
                assert_eq!(old.done_cutoff_ms(), Some(ms("2026-11-20T00:00:00-10:00")));
            });
            let old: TaskState = serde_json::from_value(serde_json::json!({ "name": "n", "status": "Done", "done": true, "firstSeenAt": "t", "doneAt": "2026-11-20T09:00:00.000Z", "lastSeenAt": "t", "doneObserved": true, "doneAtSource": "recorded", "doneDateOnly": true })).unwrap();
            assert_eq!((old.done_date.as_deref(), old.done_date().as_deref()), (None, Some("2026-11-20")));
            // 時刻つきの記録に変わったら、日付だけの印を外す
            apply_read_with(&mut f, &rec("2026-11-20T15:00:00+09:00"), stamp("2026-11-22T00:00:00.000Z"), done, |v| crate::tasks::hours::parse_done_at(v, &wh));
            assert!(!f.tasks["A"].done_date_only);
            assert_eq!((f.tasks["A"].done_date.as_deref(), f.tasks["A"].done_date()), (None, None));
            assert_eq!(f.tasks["A"].done_cutoff_ms(), Some(ms("2026-11-20T15:00:00+09:00")));
            assert!(serde_json::to_value(&f.tasks["A"]).unwrap().get("doneDateOnly").is_none());
            assert!(serde_json::to_value(&f.tasks["A"]).unwrap().get("doneDate").is_none());
        });
    }

    /// 稼働時間帯を変えた回に完了したタスクも、完了に変わるのを見たとする(「同じ読み方」は稼働時間帯を除いた目印で比べる)。
    /// 同じ更新時刻の XML でも、稼働時間帯を変えたら読み直す(日付だけの完了日の時刻が変わるため)
    #[test]
    fn work_hours_change_keeps_observation_but_rereads() {
        atlas_core::jsdate::with_zone(&atlas_core::jsdate::TimeZone::fixed(atlas_core::jsdate::Offset::constant(9)), || {
            let d = tempfile::tempdir().unwrap();
            let xml = d.path().join("export.xml");
            let state = d.path().join(crate::tasks::TASKS_FILE_NAME);
            let src = TaskSource { done_at: Some("ClosedDate".into()), ..TaskSource::with_file(&xml) };
            let set_mtime = |ms: i64| atlas_core::jsfs::utimes(&xml, ms, ms).unwrap();
            let now = atlas_core::jsdate::now_ms();
            std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Open"/><Task Id="B" Status="Done" ClosedDate="2020/11/20"/></Tasks>"#).unwrap();
            set_mtime(now - 3_600_000);
            sync_tasks(&src, &state).unwrap();
            // 稼働時間帯だけを変えた: 同じ更新時刻でも読み直し、日付だけの完了日の時刻を決め直す
            let late = TaskSource { work_hours: crate::tasks::WorkHours { end_min: 20 * 60, ..Default::default() }, ..src.clone() };
            assert_ne!(late.settings_key(), src.settings_key());
            assert_eq!(late.reading_key(), src.reading_key());
            let r = sync_tasks(&late, &state).unwrap();
            assert!(!r.summary.unchanged);
            assert_eq!(r.state.tasks["B"].done_at.as_deref(), Some("2020-11-20T11:00:00.000Z"));
            // 稼働時間帯を変えた回に A が完了になった(記録なし): 完了に変わるのを見たとする
            std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Done"/><Task Id="B" Status="Done" ClosedDate="2020/11/20"/></Tasks>"#).unwrap();
            set_mtime(now - 60_000);
            let r = sync_tasks(&src, &state).unwrap();
            assert_eq!((r.summary.completed, r.state.tasks["A"].done_observed, r.state.tasks["A"].done_source()), (1, true, Some(DoneAtSource::Observed)));
            let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
            assert_eq!((saved["source"]["settings"].as_str(), saved["source"]["reading"].as_str()), (Some(src.settings_key().as_str()), Some(src.reading_key().as_str())));
            // 完了日時の項目を指さなければ、目印は 1 つ(reading は書かない)
            let plain = TasksStamp::of(&TaskSource::with_file(&xml), "f".into(), "p".into(), "t".into());
            assert_eq!((plain.reading.as_deref(), plain.reading_key()), (None, TaskSource::with_file(&xml).settings_key().as_str()));
        });
    }

    /// 前の版が書いた日付だけの完了日(doneDateOnly だけで doneDate が無い)は、同じ更新時刻の XML でも次の読み込みで読み直して doneDate を埋める。
    /// 埋めた後は読み直さない。XML から読めなくなったものは、前の版と同じ計算の日付で埋める
    #[test]
    fn old_date_only_records_are_reread_to_fill_the_date() {
        atlas_core::jsdate::with_zone(&atlas_core::jsdate::TimeZone::fixed(atlas_core::jsdate::Offset::constant(9)), || {
            let d = tempfile::tempdir().unwrap();
            let xml = d.path().join("export.xml");
            let state = d.path().join(crate::tasks::TASKS_FILE_NAME);
            let src = TaskSource { done_at: Some("ClosedDate".into()), ..TaskSource::with_file(&xml) };
            std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Done" ClosedDate="2026/11/20"/><Task Id="C" Status="Done" ClosedDate="2026/11/18"/></Tasks>"#).unwrap();
            let now = atlas_core::jsdate::now_ms();
            atlas_core::jsfs::utimes(&xml, now - 3_600_000, now - 3_600_000).unwrap();
            let r = sync_tasks(&src, &state).unwrap();
            assert_eq!(r.state.tasks["A"].done_date.as_deref(), Some("2026-11-20"));
            // 前の版の tasks.json にする(doneDate を消す)
            let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
            for id in ["A", "C"] {
                v["tasks"][id].as_object_mut().unwrap().remove("doneDate");
            }
            std::fs::write(&state, serde_json::to_string(&v).unwrap()).unwrap();
            assert!(needs_date_refill(&load_tasks(&state).file));
            // 同じ更新時刻の XML でも読み直して埋める(C は XML から日付を読めなくなったので、前の版と同じ計算で埋める)
            std::fs::write(&xml, r#"<Tasks><Task Id="A" Status="Done" ClosedDate="2026/11/20"/><Task Id="C" Status="Done" ClosedDate="先週"/></Tasks>"#).unwrap();
            atlas_core::jsfs::utimes(&xml, now - 3_600_000, now - 3_600_000).unwrap();
            let r = sync_tasks(&src, &state).unwrap();
            assert!(!r.summary.unchanged);
            assert_eq!(r.summary.dates_filled, 2);
            assert!(r.notes.iter().any(|n| n.contains("日付だけの完了日 2 件に、暦の日付の文字(doneDate)を埋めました")), "{:?}", r.notes);
            let saved = load_tasks(&state).file;
            assert_eq!((saved.tasks["A"].done_date.as_deref(), saved.tasks["C"].done_date.as_deref()), (Some("2026-11-20"), Some("2026-11-18")));
            assert!(!needs_date_refill(&saved));
            // 埋めた後は、同じ更新時刻なら読み直さない
            let r = sync_tasks(&src, &state).unwrap();
            assert!(r.summary.unchanged);
        });
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
        TasksStamp { file: "export.xml".into(), path: "x/export.xml".into(), modified_at: at.into(), settings: "k".into(), reading: None }
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
