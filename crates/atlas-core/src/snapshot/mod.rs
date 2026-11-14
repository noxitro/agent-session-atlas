//! ~/.copilot の必要部分を出力先へ写す(packages/core/src/snapshot.ts の移植)。元は一切書き換えない。
//! - SQLite は本体と -wal をバイト列でコピーし、コピー側から VACUUM INTO(WAL の内容も含む単一ファイル)
//! - workspace.yaml / events.jsonl はファイルコピー(サイズと mtime が同じなら再利用)
//! - session-state/<id>/session.db(todos)は session-store.db と同じ方法で複製する(元は開かない)
//! - data.db(デスクトップアプリ)は複製せず、許可リストの列だけを desktop.json に書く(desktop.rs)

mod copy;
mod inventory;
mod par;
mod source;

pub use inventory::{SentInventory, UPLOAD_INSTALLED_LIMIT, read_inventory, read_sent_inventory, read_upload_indexes};
pub use par::{map_limit, par_map};
pub use source::{SourceShape, UPLOAD_PROBE_MAX, describe_source, has_session_file, is_flat_layout, person_of_folder};

use crate::atlas_version::FolderUpload;
use crate::js::{self, JsMap};
use crate::types::InstalledInventory;
use crate::desktop::read_desktop_db;
use crate::{jsdate, jsfs};
use anyhow::{Result, anyhow, bail};
use copy::{SESSION_DB_FINGERPRINT, SQLITE_COPY_ATTEMPTS, copy_if_changed, copy_session_db, copy_sqlite, copy_tree, dir_bytes, err_code, is_updated_since, size_or_0, walk};
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// 複製する SQLite(ルート直下)。data.db(デスクトップアプリ)は資格情報列を含むので複製せず、Phase 11 から許可リストの列だけを desktop.json に書く
pub const SNAPSHOT_DBS: &[&str] = &["session-store.db"];
/// 以前のバージョンが複製していたが今は複製しないファイル。snapshot 時に残っていれば消す
pub const SNAPSHOT_STALE_FILES: &[&str] = &["data.db"];
pub const SNAPSHOT_SESSION_FILES: &[&str] = &["workspace.yaml", "events.jsonl"];
/// アップロードしたセッションのフォルダに添える、session-store.db のそのセッションの行(atlas が書く。Copilot のファイルではない)。
/// 生ログ(events.jsonl など)だけだと、DB にしか無いトークン数・依頼の記録が欠けるため。extract はこれも読む
pub const SESSION_STORE_JSON: &str = "atlas-session-store.json";
/// アップロードしたセッションのフォルダに添える、送った側の記録(題名・プロジェクト名とその決め方・タスクタグ・日時)。
/// アップロード先から集計し直すとき、extract はプロジェクト名をここから取る(読む側の PC のディスクからは決めない)
pub const UPLOAD_SESSION_META: &str = "atlas-session.json";
/// アップロードしたセッションのフォルダに添える、送った側の PC で照合した「AI の変更がその後の VCS のファイルに残っているか」(vcs-step.ts)。
/// 送り先にはリポジトリが無いことが多いので、アップロード先から集計し直すときはこれを読む(無ければ照合していない扱い)
pub const UPLOAD_VCS_META: &str = "atlas-vcs.json";
/// アップロード先のフォルダ(グループ・プロジェクト)の索引。写すたびに書き直す
pub const UPLOAD_INDEX: &str = "atlas-index.json";
/// アップロード先のフォルダ(グループ・プロジェクト)に添える、送った人がインストールしている skill・プラグインの名前
/// (read_inventory と同じ形。中身は読まず名前だけ)。送るたびに書き直す。集計し直すときは「インストール済みで未使用の skill」に使う
pub const UPLOAD_INSTALLED: &str = "atlas-installed.json";
/// アップロードがセッションのフォルダを置き換えるときの作業用のフォルダ(写している途中のもの)
pub fn upload_tmp_name(id: &str) -> String {
    format!(".{id}.uploading")
}
/// アップロードがセッションのフォルダを置き換えるときに退けた、前のフォルダ(消せなかったときに残る)
pub fn upload_old_name(id: &str) -> String {
    format!(".{id}.old")
}
static UPLOAD_WORK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\.([^\n\r\u{2028}\u{2029}]+)\.(?:uploading|old)$").unwrap());
/// アップロードの作業用のフォルダの名前から、セッションの id を取る(作業用のフォルダの名前でなければ None)
pub fn upload_work_dir_id(name: &str) -> Option<String> {
    UPLOAD_WORK_RE.captures(name).map(|c| c[1].to_string())
}
/// アップロードの作業用のフォルダの名前か(upload_tmp_name / upload_old_name)。中身はセッションの複製だが、セッションとして数えない
pub fn is_upload_work_dir(name: &str) -> bool {
    upload_work_dir_id(name).is_some()
}
/// アップロードで、送った人のメモを入れるファイル(セッションのフォルダの直下)と、その画像のフォルダ。本文の画像は atlas-memo/<名前> で参照する
pub const UPLOAD_MEMO_FILE: &str = "atlas-memo.md";
pub const UPLOAD_MEMO_IMAGES: &str = "atlas-memo";
/// 送った人のメモの上限(共有フォルダに置かれたものなので、大きすぎるものは写さず、読まない)。
/// 本文はこの PC でメモを保存できる大きさ(要求の本文 1 MB)と同じ。画像のフォルダは 1 セッションの合計
pub const UPLOAD_MEMO_TEXT_LIMIT: u64 = 1024 * 1024;
pub const UPLOAD_MEMO_IMAGES_LIMIT: u64 = 100 * 1024 * 1024;
/// Phase 11: セッションフォルダの追加のファイル(あれば写す)。SESSION_STORE_JSON・UPLOAD_SESSION_META・UPLOAD_VCS_META・UPLOAD_MEMO_FILE はアップロード先から集計し直すときだけある
pub const SNAPSHOT_SESSION_EXTRA_FILES: &[&str] = &["plan.md", "vscode.metadata.json", SESSION_STORE_JSON, UPLOAD_SESSION_META, UPLOAD_VCS_META, UPLOAD_MEMO_FILE];
/// Phase 11: セッションフォルダの追加のサブフォルダ(あれば再帰的に写す)。UPLOAD_MEMO_IMAGES はアップロード先から集計し直すときだけある
pub const SNAPSHOT_SESSION_EXTRA_DIRS: &[&str] = &["checkpoints", "files", "rewind-file-snapshots", "policies", "research", "sandbox-denials", UPLOAD_MEMO_IMAGES];
/// Phase 11: 既定では写さず --snapshot-all で写すサブフォルダ(大きい。rewind-snapshots は 1 セッションで数十 MB)
pub const SNAPSHOT_SESSION_HEAVY_DIRS: &[&str] = &["rewind-snapshots"];
/// Phase 11: ~/.copilot 直下で写すフォルダ
pub const SNAPSHOT_TOP_DIRS: &[&str] = &["plans", "attachments"];
/// Phase 11: ~/.copilot 直下で既定では写さないフォルダ(--snapshot-all で写す)と理由
pub const SNAPSHOT_TOP_HEAVY_DIRS: &[(&str, &str)] = &[("logs", "アプリのログ(資格情報を含みうる。セッションの解析には使わない)")];
/// Phase 11: 写さないフォルダ(名前と容量だけ残す)と理由
pub const SNAPSHOT_TOP_SKIP_REPOS: &str = "ソースのチェックアウト(記録ではない)";
pub const SNAPSHOT_TOP_SKIP_CHATS: &str = "ユーザーが書き出した Markdown(*.md)だけ写し、他は無関係なファイル";
pub const DESKTOP_JSON: &str = "desktop.json";
/// セッションごとの SQLite(todos / todo_deps)。Phase 7 から VACUUM INTO で複製する
pub const SNAPSHOT_SESSION_DB: &str = "session.db";
pub const SNAPSHOT_MANIFEST: &str = "snapshot-manifest.json";
/// 集計を始めたときに出力先に書く、元の場所の印。SNAPSHOT_MANIFEST は最後まで終わったときにしか書かないので、
/// 途中で止まった集計の後でも、出力先がどこから集計したものかが分かるようにする
pub const SNAPSHOT_SOURCE: &str = "snapshot-source.json";
/// セッションが 1 件も見つからなかったときに添える案内(上限のせいで見つけられなかったフォルダの指定のしかた)
pub static UPLOAD_PROBE_HINT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "索引({UPLOAD_INDEX})の無いフォルダは、名前の順で先頭の {UPLOAD_PROBE_MAX} 個までしか中を確かめません。前の版でアップロードしたフォルダや手で写したフォルダが見つからないときは、そのフォルダ(セッションのフォルダが直下に並ぶもの)を直接指定してください"
    )
});
/// 同じ id のセッションが複数のフォルダにあって、数えなかったほうの理由(manifest の extras.skipped)
pub const DUPLICATE_REASON: &str = "同じ id のセッションが別のフォルダにもある(events.jsonl が大きいほうだけ数えた)";
const LINK_REASON: &str = "シンボリックリンク / ジャンクション(辿らない)";
/// アップロードの作業用のフォルダを数えなかったときの理由(manifest の extras.skipped)
pub const UPLOAD_WORK_REASON: &str = "アップロードの置き換えの途中か消し残しのフォルダ(セッションとして数えない)";
/// 本体のフォルダも写し終えた新しいフォルダも無く、退けた前のフォルダ(.<id>.old)だけが残っているもの(manifest の extras.skipped)
pub const UPLOAD_OLD_ONLY_REASON: &str = "本体のフォルダが無く、アップロードの置き換えで退けた前のフォルダだけが残っている(共有から消したセッションかもしれないので数えない)";

/// セッションのフォルダを並べて写す数。共有フォルダ(SMB)は 1 回の問い合わせごとに往復の待ちがあり、1 件ずつだと件数分積み重なる
pub const SNAPSHOT_CONCURRENCY: usize = 16;

#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {
    /// この時刻以降に更新されたセッションだけを複製する(Date.parse で読める文字列)
    pub since: Option<String>,
    /// Phase 11: 既定で写さない大きなもの(rewind-snapshots、一覧に無い名前のもの、logs/)も写す
    pub all: bool,
    /// 前回 --snapshot-all で写したが今回は写さないものを消す(既定は残して manifest の extras.leftover に日時を出す)
    pub prune: bool,
}

/// 写さなかったもの(名前と容量)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedEntry {
    /// 元のルートからの相対パス(/ 区切り)
    pub path: String,
    pub bytes: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbCopy {
    pub copied: bool,
    pub bytes: u64,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub dirs: u64,
    pub copied_files: u64,
    pub reused_files: u64,
    pub skipped_by_since: u64,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_copied: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_reused: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergedInfo {
    pub folders: Vec<String>,
    pub duplicates: u64,
    /// セッションの id ごとの、数えたフォルダ(folders と同じ書き方)。人ごとの内訳に使う
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owners: Option<JsMap<String>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesBytes {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopSummary {
    pub written: bool,
    pub sessions: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leftover {
    pub path: String,
    pub mtime: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovered {
    pub id: String,
    pub path: String,
}

/// Phase 11: 追加で写したもの(セッションフォルダの中身と ~/.copilot 直下)と、写さなかったもの
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extras {
    pub all: bool,
    pub session_files: u64,
    pub session_bytes: u64,
    pub top_level: IndexMap<String, FilesBytes>,
    pub skipped: Vec<SkippedEntry>,
    /// data.db(許可リストの列だけ)を desktop.json に書いたか。無ければ null。読めなければ理由
    pub desktop: Option<DesktopSummary>,
    /// 前回 --snapshot-all で写したが今回は写さなかったもの(残してある。--snapshot-prune で消す)
    pub leftover: Vec<Leftover>,
    /// アップロードの置き換えの途中で止まって本体のフォルダ(<id>)が無かったため、写し終えていた作業用のフォルダ(.<id>.uploading)から
    /// 今回写したセッション(path は元のルートからの相対パス)。無ければ項目ごと無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered: Option<Vec<Recovered>>,
}

/// 元の形。copilot は ~/.copilot、flat はセッションのフォルダが直下に並ぶもの、merged はそのフォルダが下(2 段下まで)に並ぶもの
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceLayout {
    Copilot,
    Flat,
    Merged,
}

/// snapshot-manifest.json。キーの順は TS 版がオブジェクトを組み立てた順
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub created_at: String,
    pub source_root: String,
    pub since: Option<String>,
    /// copied が false なら今回は複製できず、前回の複製(bytes が 0 なら無し)を使っている。理由は error
    pub databases: IndexMap<String, DbCopy>,
    pub sessions: SessionCounts,
    /// 古いマニフェストには無い(copilot と同じ)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<SourceLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged: Option<MergedInfo>,
    /// session.db を複製できなかったセッションと理由(Phase 7)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_db_errors: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<Extras>,
    /// インストール済みの skill / プラグインの名前(Phase 6。古いマニフェストには無い)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstalledInventory>,
    /// 送り先の全体を集計したときの、人のフォルダの名前ごとのインストール済みの記録(送った人が添えたもの。無ければ無い)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_by_person: Option<JsMap<InstalledInventory>>,
    /// アップロードしたフォルダから集計したときの、フォルダごとの最後に送ったときの記録。キーは元のルートからの相対パス
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploads: Option<JsMap<FolderUpload>>,
}

// ---------- JS と同じ並び ----------

/// JS の `strings.sort()`(UTF-16 の単位の順)
pub(crate) fn sort_utf16(v: &mut [String]) {
    v.sort_by(|a, b| js::cmp_utf16(a, b));
}

// ---------- セッションのフォルダの中身 ----------

const CASE_INSENSITIVE_FS: bool = cfg!(windows) || cfg!(target_os = "macos");

fn fold_name(name: &str) -> String {
    if CASE_INSENSITIVE_FS { name.to_lowercase() } else { name.to_string() }
}

/// セッションのフォルダの中身(名前 → 種類)。名前は大文字小文字を区別しないディスク(Windows・macOS)では小文字にして引く
/// (existsSync で確かめていたときと同じく、Events.jsonl も events.jsonl として見つかるように)
#[derive(Debug, Clone, Default)]
struct SessionEntries {
    list: Vec<jsfs::Dirent>,
    map: HashMap<String, usize>,
}

impl SessionEntries {
    fn new(list: Vec<jsfs::Dirent>) -> Self {
        let map = list.iter().enumerate().map(|(i, e)| (fold_name(&e.name), i)).collect();
        SessionEntries { list, map }
    }
    fn get(&self, name: &str) -> Option<&jsfs::Dirent> {
        self.map.get(&fold_name(name)).map(|i| &self.list[*i])
    }
}

/// セッションのフォルダか(has_session_file を、読んである中身で確かめる)。リンクだけは指す先があるかを確かめる
/// (existsSync はリンクを辿るので、指す先の無いリンクしか無いフォルダはセッションのフォルダとみなさない)
fn has_session_file_in(dir: &Path, ents: &SessionEntries) -> bool {
    SNAPSHOT_SESSION_FILES.iter().any(|f| ents.get(f).is_some_and(|e| !e.is_link() || jsfs::exists(&dir.join(f))))
}

type Listing = HashMap<PathBuf, Vec<(String, SessionEntries)>>;

/// セッションのフォルダが並ぶ場所ごとに、直下のフォルダ(元の readdir の順)とその中身。並べて読む。
/// 読めない・無いフォルダは空(セッションのフォルダが読めなければ、中身の無いフォルダとして扱う)
fn list_state_dirs(state_srcs: &[PathBuf]) -> Result<Listing> {
    let dirs = map_limit(state_srcs, SNAPSHOT_CONCURRENCY, |s, _| match jsfs::read_dir(s) {
        Ok(ents) => Ok(ents.into_iter().filter(|e| e.is_dir()).map(|e| e.name).collect::<Vec<_>>()),
        // 無い場所は飛ばす。それ以外の読めない理由は止める
        Err(e) if jsfs::is_not_found(&e) => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    })?;
    let flat: Vec<(usize, String)> = dirs.iter().enumerate().flat_map(|(i, names)| names.iter().map(move |n| (i, n.clone()))).collect();
    let entries = par_map(&flat, SNAPSHOT_CONCURRENCY, |(i, name)| jsfs::read_dir(&state_srcs[*i].join(name)).map(SessionEntries::new).unwrap_or_default());
    let mut out: Listing = state_srcs.iter().map(|s| (s.clone(), Vec::new())).collect();
    for ((i, name), ents) in flat.into_iter().zip(entries) {
        out.get_mut(&state_srcs[i]).expect("listed").push((name, ents));
    }
    Ok(out)
}

/// まとめて読むフォルダのうち、セッションの id ごとに、数えるほうのフォルダ(events.jsonl が大きいほう。同じなら先に見たほう)。
/// 作業用のフォルダ(置き換えの途中・消し残し)は入れない。events.jsonl の大きさは、複数のフォルダにある id だけ調べる
fn session_owners(state_srcs: &[PathBuf], listing: &Listing) -> IndexMap<String, PathBuf> {
    let mut found: Vec<(PathBuf, String)> = Vec::new();
    for dir in state_srcs {
        let mut names: Vec<&(String, SessionEntries)> = listing.get(dir).map(|v| v.iter().collect()).unwrap_or_default();
        names.sort_by(|a, b| js::cmp_utf16(&a.0, &b.0));
        for (id, ents) in names {
            if !is_upload_work_dir(id) && has_session_file_in(&dir.join(id), ents) {
                found.push((dir.clone(), id.clone()));
            }
        }
    }
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (_, id) in &found {
        *seen.entry(id.as_str()).or_default() += 1;
    }
    let sizes = par_map(&found, SNAPSHOT_CONCURRENCY, |(dir, id)| if seen[id.as_str()] < 2 { 0 } else { size_or_0(&dir.join(id).join("events.jsonl")) });
    let mut best: IndexMap<String, (PathBuf, u64)> = IndexMap::new();
    for ((dir, id), size) in found.iter().zip(sizes) {
        match best.get_mut(id) {
            Some(cur) if size <= cur.1 => {}
            Some(cur) => *cur = (dir.clone(), size),
            None => {
                best.insert(id.clone(), (dir.clone(), size));
            }
        }
    }
    best.into_iter().map(|(id, (dir, _))| (id, dir)).collect()
}

/// 作業用のフォルダの名前から取った id を、写す先のフォルダの名前に使ってよいか。
/// 共有フォルダに置かれた名前なので、そのまま信じない: 「.」「..」と、点や空白で終わる名前(Windows では別の名前のフォルダを指す)、
/// それ自体が作業用のフォルダの名前になるもの(写しても数えない)は使わない
fn is_recoverable_id(id: &str) -> bool {
    let bad_end = id.chars().last().is_some_and(|c| c == '.' || js::is_js_whitespace(c));
    !bad_end && !is_upload_work_dir(id)
}

/// 本体のフォルダ(<id>)が無いセッションを写す元にする、作業用のフォルダの名前(無ければ None)。
/// 使うのは、写し終えた新しいもの(送る側が最後に書く UPLOAD_SESSION_META まである .<id>.uploading)だけ。
/// 写している途中の .<id>.uploading(初めて送っている最中のもの)は使わない。
/// 退けた前のもの(.<id>.old)も使わない: 消し残しがあるセッションを共有から消したときと見分けられず、消したセッションが古い中身で戻ってしまう
fn orphan_source(state_src: &Path, id: &str) -> Option<String> {
    let tmp = upload_tmp_name(id);
    (jsfs::exists(&state_src.join(&tmp).join(UPLOAD_SESSION_META)) && has_session_file(&state_src.join(&tmp))).then_some(tmp)
}

static KNOWN_SESSION_ENTRIES: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let mut s: HashSet<String> = SNAPSHOT_SESSION_FILES.iter().map(|x| x.to_string()).collect();
    s.insert(SNAPSHOT_SESSION_DB.into());
    s.insert(format!("{SNAPSHOT_SESSION_DB}-wal"));
    s.insert(format!("{SNAPSHOT_SESSION_DB}-shm"));
    s.extend(SNAPSHOT_SESSION_EXTRA_FILES.iter().chain(SNAPSHOT_SESSION_EXTRA_DIRS).chain(SNAPSHOT_SESSION_HEAVY_DIRS).map(|x| x.to_string()));
    s
});
static LOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^inuse\.[0-9]+\.(lock|hold)$").unwrap());
fn is_lock(name: &str) -> bool {
    LOCK_RE.is_match(name) || name.ends_with(".lock")
}

/// 1 セッション分の、順に並べて manifest に移す記録(並べて写すので、写し終えてから元の順に移す)
#[derive(Debug, Default)]
struct SessionAcc {
    skipped: Vec<SkippedEntry>,
    leftover: Vec<Leftover>,
    db_errors: Vec<String>,
    session_files: u64,
    session_bytes: u64,
    // manifest.sessions に足す分
    dirs: u64,
    copied_files: u64,
    reused_files: u64,
    skipped_by_since: u64,
    bytes: u64,
    db_copied: u64,
    db_reused: u64,
}

struct SessionTask {
    name: String,
    dir_src: PathBuf,
    state_src: PathBuf,
    present: Vec<String>,
    ents: SessionEntries,
    recovered_from: Option<String>,
}

struct TaskOut {
    acc: SessionAcc,
    /// since で除かずに写した
    copied: bool,
    /// 最後まで済んだ(途中で元から消えたものは false)
    done: bool,
}

struct Ctx<'a> {
    src: &'a Path,
    dest: &'a Path,
    state_dest: PathBuf,
    since_ms: Option<i64>,
    all: bool,
    prune: bool,
}

/// ~/.copilot の必要部分を dest へ複製する。元は一切書き換えない。
pub fn snapshot(src: &Path, dest: &Path, opts: &SnapshotOptions) -> Result<SnapshotManifest> {
    let since_str = opts.since.as_deref().filter(|s| !s.is_empty());
    let since_ms = match since_str {
        Some(s) => Some(jsdate::parse_ms(s).ok_or_else(|| anyhow!("since が日時として解釈できない: {s}"))?),
        None => None,
    };
    let all = opts.all;
    let prune = opts.prune;
    let mut extras = Extras { all, ..Default::default() };
    if !jsfs::exists(src) {
        bail!("元ディレクトリが無い: {}", src.display());
    }
    // アップロードしたグループ・プロジェクトのフォルダ(<送り先>\<フォルダ>\<セッション id>\events.jsonl …)は、そのフォルダを session-state/ とみなす。
    // そのフォルダが並ぶ場所(人ごとのフォルダ)と、もう 1 段上(送り先そのもの。全員の分)は、下のフォルダをまとめて読む
    let shape = describe_source(src);
    let flat = shape == SourceShape::Flat;
    let merged: Option<Vec<String>> = match &shape {
        SourceShape::Merged { folders } => Some(folders.clone()),
        _ => None,
    };
    // 出力先が別の元から作ったものなら、足さずに止める(前の元のセッションと session-store.db が残っていて、黙って混ざるため)。
    // 前の複製は消さない(元で消したログの、最後の複製かもしれない)
    // 前の元は、最後まで終わった集計の manifest と、集計を始めたときに書く印(SNAPSHOT_SOURCE)の両方で確かめる
    // (manifest は最後に書くので、途中で止まった集計の後は印しか無い)
    let marks = previous_sources(dest);
    // 前の集計が何も写していなければ(場所を間違えて 0 件だったなど)、混ざるものが無いので止めない
    let kept = !marks.is_empty() && holds_copies(dest);
    for (root, file) in &marks {
        if same_location(Path::new(root), src) {
            continue;
        }
        if !kept {
            // 前の元の印は消しておく(今回の集計が途中で止まったときに、前の元と比べて止めないように)
            jsfs::rm_force(file)?;
            continue;
        }
        bail!(
            "出力先 {} は、別の場所({root})から集計したものです。同じ出力先に足すと両方のセッションが混ざるので止めました。別の出力先(--out)を指定してください。フォルダを移したなど、元が同じものだと分かっているなら、{} を消してからやり直すと、今の出力先を使い続けます",
            dest.display(),
            marks.iter().map(|(_, f)| f.display().to_string()).collect::<Vec<_>>().join(" と ")
        );
    }
    // 前の集計で、セッションごとに数えたフォルダ(元から消えたセッションの複製が出力先に残っているときに引き継ぐ)。
    // 別の元の manifest は上で消してあるので、ここで読めるのは同じ元のものだけ
    let previous_owners: Vec<(String, Value)> = if merged.is_some() { read_previous_owners(dest) } else { Vec::new() };
    fs::create_dir_all(dest)?;
    let src_str = src.to_string_lossy().into_owned();
    let mark = serde_json::json!({ "sourceRoot": src_str, "startedAt": jsdate::now_iso() });
    fs::write(dest.join(SNAPSHOT_SOURCE), format!("{}\n", crate::json::to_js_string(&mark)?))?;

    let mut manifest = SnapshotManifest {
        created_at: jsdate::now_iso(),
        source_root: src_str,
        since: since_ms.map(jsdate::to_iso),
        databases: IndexMap::new(),
        sessions: SessionCounts { db_copied: Some(0), db_reused: Some(0), ..Default::default() },
        layout: None,
        merged: None,
        session_db_errors: None,
        extras: None,
        installed: None,
        installed_by_person: None,
        uploads: None,
    };

    for name in SNAPSHOT_STALE_FILES {
        jsfs::rm_force(&dest.join(name))?;
    }

    for name in SNAPSHOT_DBS {
        let from = src.join(name);
        if !jsfs::exists(&from) {
            continue;
        }
        let to = dest.join(name);
        let r = match copy_sqlite(&from, &to, &dest.join(".tmp-sqlite")) {
            Ok(attempts) => DbCopy { copied: true, bytes: fs::metadata(&to)?.len(), attempts, error: None },
            // Copilot が書き続けていて一貫した複製が取れなくても、スナップショット全体は止めない。
            // 前回の複製があればそのまま使い(古い)、理由は manifest に残して extract が警告に出す
            Err(e) => DbCopy { copied: false, bytes: fs::metadata(&to).map(|m| m.len()).unwrap_or(0), attempts: SQLITE_COPY_ATTEMPTS, error: Some(e.to_string()) },
        };
        manifest.databases.insert(name.to_string(), r);
    }

    manifest.layout = Some(match shape {
        SourceShape::Flat => SourceLayout::Flat,
        SourceShape::Merged { .. } => SourceLayout::Merged,
        _ => SourceLayout::Copilot,
    });
    // セッションのフォルダが並ぶ場所。まとめて読むときは下のフォルダの数だけある
    let state_srcs: Vec<PathBuf> = match &merged {
        Some(m) => m.iter().map(|f| jsfs::join_slash(src, f)).collect(),
        None => vec![if flat { src.to_path_buf() } else { src.join("session-state") }],
    };
    let ctx = Ctx { src, dest, state_dest: dest.join("session-state"), since_ms, all, prune };
    // セッションのフォルダの一覧と、それぞれの中身の名前を先に並べて読む。共有フォルダでは 1 回ごとに往復の待ちがあるので、
    // 以下の判定(セッションのフォルダか・リンクか・あるか)はこの一覧で済ませ、元への問い合わせを減らす
    let mut listing = list_state_dirs(&state_srcs)?;
    // まとめて読むとき、同じ id のセッションが複数のフォルダにあれば 1 つだけ数える(events.jsonl が大きいほう。同じなら名前の順で先のフォルダ)
    let owners: Option<IndexMap<String, PathBuf>> = merged.as_ref().map(|_| session_owners(&state_srcs, &listing));
    // 元のルートからの相対パス(/ 区切り。manifest の merged.folders と同じ書き方)
    let folder_of = |state_src: &Path| jsfs::rel_slash(src, state_src);
    // セッションの id ごとの、数えたフォルダ(since で写さなかったものも入る)
    let mut owner_folders: JsMap<String> = JsMap::new();
    if let Some(o) = &owners {
        for (id, dir) in o {
            owner_folders.insert(id.clone(), folder_of(dir));
        }
    }
    let mut duplicates: u64 = 0;
    // 写すと決めたセッションの id(まとめて読むとき、作業用のフォルダから同じ id を 2 度写さないように)
    let mut taken: HashSet<String> = HashSet::new();
    // フォルダ 1 つごとの記録の枠(元の順)。写すかどうかはここで順に決め(どれを写すかが前のフォルダの結果で変わるため)、
    // 写すのは後でまとめて並べて行う。写さなかったものの記録は、枠の順に manifest へ移す(並べて写しても順が変わらないように)
    let mut slots: Vec<(Vec<SkippedEntry>, Option<usize>)> = Vec::new();
    let mut tasks: Vec<SessionTask> = Vec::new();
    for state_src in &state_srcs {
        for (ent_name, ents) in listing.remove(state_src).unwrap_or_default() {
            let mut skipped: Vec<SkippedEntry> = Vec::new();
            let dir_src = state_src.join(&ent_name);
            let rel = jsfs::rel_slash(src, &dir_src);
            // 写す先の名前(セッションの id)。作業用のフォルダから写すときだけ、フォルダの名前と違う
            let mut name = ent_name.clone();
            // 作業用のフォルダから写しているとき、その元(元のルートからの相対パス)
            let mut recovered_from: Option<String> = None;
            // アップロードの置き換えの途中・消し残しのフォルダは、同じセッションの複製なので数えない(二重に数えないように)。
            // ただし、置き換えの途中で止まって本体(<id>)が無いセッションは、写し終えていた作業用のフォルダから写す(集計から消えたままにしない)
            if let Some(work_id) = upload_work_dir_id(&ent_name) {
                // 本体があるか。フォルダがあれば、中がリンクだけでも本体があるものとして扱う(本体のほうの片付けと食い違わないように)。
                // まとめて読むときは、本体が別のフォルダにあるもの・別のフォルダの作業用のフォルダから写したものも同じ
                let has_main = jsfs::exists(&state_src.join(&work_id)) || owners.as_ref().is_some_and(|o| o.contains_key(&work_id)) || taken.contains(&work_id);
                let orphan = !has_main && is_recoverable_id(&work_id);
                let from = if orphan { orphan_source(state_src, &work_id) } else { None };
                if from.as_deref() == Some(ent_name.as_str()) {
                    name = work_id;
                    recovered_from = Some(rel.clone());
                } else {
                    // 退けた前のフォルダだけが残っているもの(本体も、写し終えた新しいものも無い)は、理由を分けて残す
                    let old_only = orphan && from.is_none() && ent_name == upload_old_name(&work_id);
                    if has_session_file_in(&dir_src, &ents) {
                        skipped.push(SkippedEntry { path: rel, bytes: 0, reason: if old_only { UPLOAD_OLD_ONLY_REASON } else { UPLOAD_WORK_REASON }.to_string() });
                    }
                    slots.push((skipped, None));
                    continue;
                }
            } else if owners.as_ref().is_some_and(|o| o.get(&name).is_some_and(|d| d != state_src)) {
                // 同じ id のセッションが別のフォルダにあり、そちらを数える(ここで止めて、下のリンクの片付けで数えるほうの複製を消さない)
                skipped.push(SkippedEntry { path: rel, bytes: 0, reason: DUPLICATE_REASON.to_string() });
                duplicates += 1;
                slots.push((skipped, None));
                continue;
            }
            // リンク(シンボリックリンク・ジャンクション)のファイルは辿らない(フォルダの外のファイルを写さないように)
            let mut present: Vec<String> = Vec::new();
            let mut linked: Vec<String> = Vec::new();
            for f in SNAPSHOT_SESSION_FILES {
                match ents.get(f) {
                    Some(e) if e.is_link() => linked.push(f.to_string()),
                    Some(_) => present.push(f.to_string()),
                    None => {}
                }
            }
            // 前に写した分は消す。この集計で同じ id を別のフォルダから写すと決めていたら、それは消さない
            if !taken.contains(&name) {
                for f in &linked {
                    jsfs::rm_force(&ctx.state_dest.join(&name).join(f))?;
                }
            }
            if present.is_empty() {
                // optimistic-chat-* など中身の無いディレクトリ。リンクしか無いものは、写さなかったことを残す
                for f in &linked {
                    skipped.push(SkippedEntry { path: format!("{rel}/{f}"), bytes: 0, reason: LINK_REASON.to_string() });
                }
                slots.push((skipped, None));
                continue;
            }
            taken.insert(name.clone());
            slots.push((skipped, Some(tasks.len())));
            tasks.push(SessionTask { name, dir_src, state_src: state_src.clone(), present, ents, recovered_from });
        }
    }
    if let Some(m) = &merged {
        manifest.merged = Some(MergedInfo { folders: m.clone(), duplicates, owners: None });
    }

    // 決めたセッションを並べて写す(1 件ずつだと、共有フォルダでは往復の待ちが件数分積み重なる)
    let outs = map_limit(&tasks, SNAPSHOT_CONCURRENCY, |t, worker| {
        let mut acc = SessionAcc::default();
        match snapshot_session(&ctx, t, &mut acc, worker) {
            Ok(copied) => Ok(TaskOut { acc, copied, done: true }),
            // 走査中にセッションが消された(Copilot の削除・一時セッションの片付け)なら飛ばす。それ以外は止める
            Err(e) if jsfs::is_not_found_any(&e) && !jsfs::exists(&t.dir_src) => Ok(TaskOut { acc, copied: false, done: false }),
            Err(e) => Err(e),
        }
    })?;
    // 記録を元の順に移す
    let mut outs: Vec<Option<TaskOut>> = outs.into_iter().map(Some).collect();
    for (pre, task) in slots {
        extras.skipped.extend(pre);
        let Some(i) = task else { continue };
        let t = &tasks[i];
        let out = outs[i].take().expect("task out");
        let a = out.acc;
        let s = &mut manifest.sessions;
        s.dirs += a.dirs;
        s.copied_files += a.copied_files;
        s.reused_files += a.reused_files;
        s.skipped_by_since += a.skipped_by_since;
        s.bytes += a.bytes;
        *s.db_copied.get_or_insert(0) += a.db_copied;
        *s.db_reused.get_or_insert(0) += a.db_reused;
        extras.skipped.extend(a.skipped);
        extras.leftover.extend(a.leftover);
        extras.session_files += a.session_files;
        extras.session_bytes += a.session_bytes;
        if !a.db_errors.is_empty() {
            manifest.session_db_errors.get_or_insert_with(Vec::new).extend(a.db_errors);
        }
        // 作業用のフォルダから写したことは、写し終えてから残す(since で写さなかったもの・途中で消えたものは入れない)
        if out.copied {
            if let Some(from) = &t.recovered_from {
                extras.recovered.get_or_insert_with(Vec::new).push(Recovered { id: t.name.clone(), path: from.clone() });
            }
        }
        // 作業用のフォルダから写したセッションは、そのフォルダのものとして数える
        if merged.is_some() && out.done && t.recovered_from.is_some() {
            owner_folders.insert(t.name.clone(), folder_of(&t.state_src));
        }
    }

    // Phase 11: ~/.copilot 直下の plans/・attachments/(と chats/ の *.md)。logs/ は --snapshot-all、repos/ は写さない。
    // 直下にセッションが並ぶ形・そのフォルダが並ぶ形では、直下のフォルダはセッションかその入れ物なので写さない(写したものとして一覧に出さない)
    if !flat && merged.is_none() {
        copy_top_level(src, dest, all, prune, &mut extras)?;
    }
    // Phase 11: data.db は複製せず、許可リストの列だけを desktop.json に書く(immutable で開く。元には触れない)
    let desktop = (|| -> Result<Option<DesktopSummary>> {
        match read_desktop_db(&src.join("data.db"))? {
            Some(d) => {
                fs::write(dest.join(DESKTOP_JSON), crate::json::to_js_string(&d)?)?;
                Ok(Some(DesktopSummary { written: true, sessions: d.tables.get("sessions").map_or(0, |r| r.len() as u64), warnings: d.warnings }))
            }
            None => {
                jsfs::rm_force(&dest.join(DESKTOP_JSON))?;
                Ok(None)
            }
        }
    })();
    extras.desktop = match desktop {
        Ok(d) => d,
        Err(e) => Some(DesktopSummary { written: false, sessions: 0, warnings: vec![format!("data.db を読めない ({e})")] }),
    };
    manifest.extras = Some(extras);

    // アップロードしたフォルダから集計するときは、送った人が添えたインストール済みの記録を読む(何人分かなら合わせる)。
    // 1 つも無ければ記録なし(元のフォルダの直下に skills/ は無いので、読むと 0 件に見えてしまう)
    if flat || merged.is_some() {
        let folders: Vec<String> = if flat { vec![".".into()] } else { merged.clone().unwrap_or_default() };
        let sent = read_sent_inventory(src, &folders);
        manifest.installed = sent.installed;
        manifest.installed_by_person = sent.by_person;
        manifest.uploads = Some(read_upload_indexes(src, &folders));
    } else {
        manifest.installed = Some(read_inventory(src));
    }

    // 元から消えたセッションの複製が出力先に残っていれば、前の集計で数えたフォルダを引き継ぐ(人ごとの内訳から外さない)
    for (id, folder) in previous_owners {
        if let Value::String(folder) = folder {
            if !owner_folders.contains_key(&id) && jsfs::exists(&ctx.state_dest.join(&id)) {
                owner_folders.insert(id, folder);
            }
        }
    }
    if let Some(m) = &mut manifest.merged {
        m.owners = Some(owner_folders);
    }

    fs::write(dest.join(SNAPSHOT_MANIFEST), crate::json::to_js_string_pretty(&manifest)?)?;
    Ok(manifest)
}

/// 1 セッション分を写す(workspace.yaml / events.jsonl・session.db・追加のファイル)。since より前のもので写さなかったら false。
/// worker は並べて動かしている枠の番号(session.db を複製する一時フォルダを分ける)
fn snapshot_session(ctx: &Ctx<'_>, t: &SessionTask, acc: &mut SessionAcc, worker: usize) -> Result<bool> {
    if let Some(since) = ctx.since_ms {
        if !is_updated_since(&t.dir_src, &t.present, since)? {
            acc.skipped_by_since += 1;
            return Ok(false);
        }
    }
    acc.dirs += 1;
    let dir_dest = ctx.state_dest.join(&t.name);
    fs::create_dir_all(&dir_dest)?;
    for f in &t.present {
        let r = match copy_if_changed(&t.dir_src.join(f), &dir_dest.join(f)) {
            Ok(r) => r,
            // 一覧の後に消えたファイル
            Err(e) if jsfs::is_not_found(&e) && !jsfs::exists(&t.dir_src.join(f)) => continue,
            Err(e) => return Err(e.into()),
        };
        acc.bytes += r.1;
        if r.0 {
            acc.copied_files += 1;
        } else {
            acc.reused_files += 1;
        }
    }
    let db_src = t.dir_src.join(SNAPSHOT_SESSION_DB);
    let db = t.ents.get(SNAPSHOT_SESSION_DB);
    let wal = t.ents.get(&format!("{SNAPSHOT_SESSION_DB}-wal"));
    let db_dest = dir_dest.join(SNAPSHOT_SESSION_DB);
    // リンクの session.db(と -wal)は辿らない(前に写したものも消す。写さなかったことは copy_session_extras が manifest に残す)
    if db.is_some_and(|e| e.is_link()) || wal.is_some_and(|e| e.is_link()) {
        jsfs::rm_force(&db_dest)?;
    } else if db.is_some() {
        match copy_session_db(&db_src, &db_dest, &ctx.dest.join(format!(".tmp-sqlite-w{worker}"))) {
            Ok(true) => acc.db_copied += 1,
            Ok(false) => acc.db_reused += 1,
            Err(e) => {
                // 1 セッションの session.db が壊れていてもスナップショット全体は止めない(理由は manifest に残し、extract が警告に出す)
                jsfs::rm_force(&db_dest)?;
                acc.db_errors.push(format!("{}: {e}", t.name));
            }
        }
    } else {
        // 元から消えたものは複製側も消す
        jsfs::rm_force(&db_dest)?;
    }
    // Phase 11: plan.md・checkpoints/・files/ などを写す。大きいもの・一覧に無いものは --snapshot-all のときだけ
    copy_session_extras(&t.dir_src, &dir_dest, ctx.src, ctx.all, ctx.prune, acc, &t.ents)?;
    Ok(true)
}

/// セッションのフォルダの追加のファイルを写す。ents は先に読んだそのフォルダの中身(元に問い合わせ直さない)
fn copy_session_extras(dir_src: &Path, dir_dest: &Path, root: &Path, all: bool, prune: bool, acc: &mut SessionAcc, ents: &SessionEntries) -> Result<()> {
    let rel_path = |p: &Path| jsfs::rel_slash(root, p);
    let copy_one = |from: &Path, to: &Path, acc: &mut SessionAcc| match copy_if_changed(from, to) {
        Ok((_, b)) => {
            acc.session_files += 1;
            acc.session_bytes += b;
        }
        Err(e) => acc.skipped.push(SkippedEntry { path: rel_path(from), bytes: 0, reason: format!("複製できなかった ({})", err_code(&e)) }),
    };
    for f in SNAPSHOT_SESSION_EXTRA_FILES {
        let p = dir_src.join(f);
        let ent = ents.get(f);
        // 送った人のメモが大きすぎるときは写さない(前に写したものも消す)
        let memo_bytes = if *f == UPLOAD_MEMO_FILE && ent.is_some() { size_or_0(&p) } else { 0 };
        if memo_bytes > UPLOAD_MEMO_TEXT_LIMIT {
            acc.skipped.push(SkippedEntry { path: rel_path(&p), bytes: memo_bytes, reason: format!("送った人のメモが大きすぎる({} MB まで)", UPLOAD_MEMO_TEXT_LIMIT / 1024 / 1024) });
            jsfs::rm_force(&dir_dest.join(f))?;
            continue;
        }
        // リンクは辿らない(下の一覧で「写さなかったもの」に残る)。前に写したものは消す
        match ent {
            Some(e) if !e.is_link() => copy_one(&p, &dir_dest.join(f), acc),
            // 元から消えたものは複製先からも消す
            _ => jsfs::rm_force(&dir_dest.join(f))?,
        }
    }
    let mut present: HashSet<String> = HashSet::new();
    for ent in &ents.list {
        let name = ent.name.as_str();
        let p = dir_src.join(name);
        if ent.is_link() {
            acc.skipped.push(SkippedEntry { path: rel_path(&p), bytes: 0, reason: LINK_REASON.to_string() });
            continue;
        }
        if ent.is_dir() {
            let heavy = SNAPSHOT_SESSION_HEAVY_DIRS.contains(&name);
            let known = SNAPSHOT_SESSION_EXTRA_DIRS.contains(&name);
            // 送った人のメモの画像が合計で大きすぎるときは写さない(--snapshot-all でも。前に写したものは下の片付けで消える)
            if name == UPLOAD_MEMO_IMAGES {
                let n = dir_bytes(&p);
                if n > UPLOAD_MEMO_IMAGES_LIMIT {
                    acc.skipped.push(SkippedEntry { path: rel_path(&p), bytes: n, reason: format!("送った人のメモの画像が大きすぎる(合計 {} MB まで)", UPLOAD_MEMO_IMAGES_LIMIT / 1024 / 1024) });
                    jsfs::rm_rf(&dir_dest.join(name))?;
                    continue;
                }
            }
            let unknown = !KNOWN_SESSION_ENTRIES.contains(name);
            if known || ((heavy || unknown) && all) {
                present.insert(name.to_string());
                let (files, bytes) = copy_tree(&p, &dir_dest.join(name), &mut acc.skipped, &rel_path(&p))?;
                acc.session_files += files;
                acc.session_bytes += bytes;
            } else if heavy || unknown {
                acc.skipped.push(SkippedEntry { path: rel_path(&p), bytes: dir_bytes(&p), reason: if heavy { "大きい(--snapshot-all で写す)" } else { "一覧に無い名前(--snapshot-all で写す)" }.to_string() });
            }
        } else if ent.is_file() && !KNOWN_SESSION_ENTRIES.contains(name) && !is_lock(name) {
            if all {
                present.insert(name.to_string());
                copy_one(&p, &dir_dest.join(name), acc);
            } else {
                acc.skipped.push(SkippedEntry { path: rel_path(&p), bytes: size_or_0(&p), reason: "一覧に無い名前(--snapshot-all で写す)".to_string() });
            }
        }
    }
    // 複製先に残っている追加のフォルダ・ファイルで今回写さなかったもの: 元から消えたものは消す。
    // 前回 --snapshot-all で写したもの(元にはまだある)は、生成物を黙って消さない方針で残し、manifest の leftover に日時を出す(--snapshot-prune で消す)
    if jsfs::exists(dir_dest) {
        for ent in jsfs::read_dir(dir_dest)? {
            let name = ent.name.as_str();
            if KNOWN_SESSION_ENTRIES.contains(name) && !SNAPSHOT_SESSION_EXTRA_DIRS.contains(&name) && !SNAPSHOT_SESSION_HEAVY_DIRS.contains(&name) {
                continue;
            }
            if name == SESSION_DB_FINGERPRINT || present.contains(name) {
                continue;
            }
            let p = dir_dest.join(name);
            if ents.get(name).is_none() || prune {
                jsfs::rm_rf(&p)?;
            } else {
                acc.leftover.push(Leftover { path: rel_path(&dir_src.join(name)), mtime: jsfs::mtime_iso(&fs::metadata(&p)?) });
            }
        }
    }
    Ok(())
}

fn copy_top_level(src: &Path, dest: &Path, all: bool, prune: bool, extras: &mut Extras) -> Result<()> {
    for name in SNAPSHOT_TOP_DIRS {
        let p = src.join(name);
        if !jsfs::exists(&p) {
            jsfs::rm_rf(&dest.join(name))?;
            continue;
        }
        let (files, bytes) = copy_tree(&p, &dest.join(name), &mut extras.skipped, name)?;
        extras.top_level.insert(name.to_string(), FilesBytes { files, bytes });
    }
    for (name, reason) in SNAPSHOT_TOP_HEAVY_DIRS {
        let p = src.join(name);
        let d = dest.join(name);
        if !jsfs::exists(&p) {
            jsfs::rm_rf(&d)?;
            continue;
        }
        if all {
            let (files, bytes) = copy_tree(&p, &d, &mut extras.skipped, name)?;
            extras.top_level.insert(name.to_string(), FilesBytes { files, bytes });
        } else {
            extras.skipped.push(SkippedEntry { path: name.to_string(), bytes: dir_bytes(&p), reason: format!("{reason}(--snapshot-all で写す)") });
            if jsfs::exists(&d) {
                if prune {
                    jsfs::rm_rf(&d)?;
                } else {
                    extras.leftover.push(Leftover { path: name.to_string(), mtime: jsfs::mtime_iso(&fs::metadata(&d)?) });
                }
            }
        }
    }
    // chats/: *.md(ユーザーが書き出したセッション記録)だけ写し、他は名前と容量だけ。元に無い .md は複製先から消す
    let chats = src.join("chats");
    if jsfs::exists(&chats) {
        let (mut files, mut bytes, mut other_bytes, mut other_files) = (0u64, 0u64, 0u64, 0u64);
        let w = walk(&chats);
        for l in &w.links {
            extras.skipped.push(SkippedEntry { path: format!("chats/{l}"), bytes: 0, reason: LINK_REASON.to_string() });
        }
        let mut keep: HashSet<&str> = HashSet::new();
        for (rel, abs) in &w.files {
            if rel.to_lowercase().ends_with(".md") {
                keep.insert(rel.as_str());
                let to = jsfs::join_slash(&dest.join("chats"), rel);
                let r = to.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| copy_if_changed(abs, &to));
                match r {
                    Ok((_, b)) => {
                        files += 1;
                        bytes += b;
                    }
                    Err(e) => extras.skipped.push(SkippedEntry { path: format!("chats/{rel}"), bytes: 0, reason: format!("複製できなかった ({})", err_code(&e)) }),
                }
            } else {
                other_files += 1;
                other_bytes += size_or_0(abs);
            }
        }
        let dchats = dest.join("chats");
        if jsfs::exists(&dchats) {
            for (rel, abs) in walk(&dchats).files {
                if !keep.contains(rel.as_str()) {
                    jsfs::rm_force(&abs)?;
                }
            }
        }
        extras.top_level.insert("chats".into(), FilesBytes { files, bytes });
        if other_files > 0 {
            extras.skipped.push(SkippedEntry { path: "chats(*.md 以外)".into(), bytes: other_bytes, reason: format!("{SNAPSHOT_TOP_SKIP_CHATS}({other_files} ファイル)") });
        }
    } else {
        jsfs::rm_rf(&dest.join("chats"))?;
    }
    let repos = src.join("repos");
    if jsfs::exists(&repos) {
        extras.skipped.push(SkippedEntry { path: "repos".into(), bytes: dir_bytes(&repos), reason: SNAPSHOT_TOP_SKIP_REPOS.into() });
    }
    Ok(())
}

/// 出力先に、前の集計が写したもの(セッションのフォルダか session-store.db)があるか
fn holds_copies(dest: &Path) -> bool {
    SNAPSHOT_DBS.iter().any(|n| jsfs::exists(&dest.join(n))) || !source::sub_dirs(&dest.join("session-state")).is_empty()
}

/// 出力先に残っている、前の集計の元の場所(最後まで終わった集計の manifest と、始めたときの印)。無い・読めないものは入れない(書き直す)
fn previous_sources(dest: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for name in [SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE] {
        let file = dest.join(name);
        let Ok(text) = fs::read_to_string(&file) else { continue };
        if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
            if let Some(Value::String(root)) = o.get("sourceRoot") {
                out.push((root.clone(), file));
            }
        }
    }
    out
}

/// 前の manifest の merged.owners(読めなければ空)
fn read_previous_owners(dest: &Path) -> Vec<(String, Value)> {
    let Ok(text) = fs::read_to_string(dest.join(SNAPSHOT_MANIFEST)) else { return Vec::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => match v.get("merged").and_then(|m| m.get("owners")) {
            Some(Value::Object(o)) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            _ => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

/// 同じ場所を指すパスか。書き方の違い(相対・末尾の区切り・Windows の大文字小文字)のほか、実際の場所が同じもの
/// (リンク・ジャンクション・割り当てたドライブなど)も同じとみなす。無くなった場所は、書かれたパスのまま比べる
fn same_location(a: &Path, b: &Path) -> bool {
    let fold = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    if fold(&jsfs::resolve(a)) == fold(&jsfs::resolve(b)) {
        return true;
    }
    let (Ok(ra), Ok(rb)) = (jsfs::realpath(a), jsfs::realpath(b)) else {
        return false;
    };
    if fold(&ra) == fold(&rb) {
        return true;
    }
    // 実際のパスの書き方が違っても、同じフォルダなら同じ(大文字小文字を区別しないディスクなど)
    same_file::is_same_file(&ra, &rb).unwrap_or(false)
}

/// 出力先の snapshot-manifest.json を読む(無ければ None)
pub fn read_snapshot_manifest(dir: &Path) -> Result<Option<SnapshotManifest>> {
    let p = dir.join(SNAPSHOT_MANIFEST);
    if !jsfs::exists(&p) {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(&p)?)?))
}

#[cfg(test)]
mod tests;
