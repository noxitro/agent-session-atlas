//! グループのアップロード(packages/cli/src/group-upload.ts の移植): グループのセッションの生ログを、決めておいた場所へタスク(グループ)ごとに写す。
//!   <基底>/<グループ名>/<セッション id>/events.jsonl            ← Copilot のセッションのフォルダ(前回の集計で複製したもの)
//!                                      workspace.yaml / session.db / plan.md / checkpoints/ / files/ …
//!                                      atlas-session-store.json   ← session-store.db と data.db(許可リストの列)のそのセッションの行(atlas が添える)
//!                                      atlas-memo.md / atlas-memo/ ← そのセッションのメモと画像(atlas-notes/memos/。あれば)
//!   <基底>/<グループ名>/README.md                                 ← グループ名・説明・写した日時・セッションの一覧(写すたびに書き直す)
//!   <基底>/<グループ名>/atlas-installed.json                      ← 送った人がインストールしている skill・プラグインの名前(集計し直す側が使う)
//! 同じセッションのフォルダは丸ごと置き換える。ただし、前に送ったときから中身が変わっていないセッションは写し直さない(2 回目からは変わったものだけを送る)。
//! グループから外したセッションや、ほかの回・ほかの PC から写したセッションのフォルダには触れない(前に写したものを消さないため)。
//! 送った先は `atlas all --home <基底>/<グループ名>` でそのまま集計できる。
//! 元(~/.copilot)は読まず、前回の集計で out/snapshot/ に複製したものを写す(SQLite は一貫した複製を取ってあるため)。

use anyhow::{anyhow, bail, Result};
use atlas_core::atlas_version::AtlasBuild;
use atlas_core::desktop::{desktop_for_session, DesktopData};
use atlas_core::js::{self, RE_S};
use atlas_core::snapshot::{
    upload_old_name, upload_tmp_name, DESKTOP_JSON, SESSION_STORE_JSON, UPLOAD_INDEX, UPLOAD_INSTALLED, UPLOAD_MEMO_FILE, UPLOAD_MEMO_IMAGES, UPLOAD_SESSION_META,
    UPLOAD_VCS_META,
};
use atlas_core::vcs_retention::ComputedOn;
use atlas_core::vcs_step::{read_vcs_retention, sender_vcs_json, VCS_RETENTION_FILE};
use atlas_core::{collate, fs_retry, jsdate, jsfs};
use atlas_report::format::{date_time, truncate};
use atlas_report::groups::{load_groups, safe_dir_name};
use regex::Regex;
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// スナップショットのセッションのフォルダにある、atlas の作業用のファイル(写さない)
const SNAPSHOT_PRIVATE: &str = ".session.db.src";
/// セッション id として写してよい名前(Copilot の id は英数字と - だけ。. で始まるもの・区切りを含むものは除く)
static SAFE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]*$").unwrap());
/// グループ・プロジェクトのフォルダの説明(人が読む)
pub const UPLOAD_README: &str = "README.md";

fn safe_id(id: &str) -> bool {
    SAFE_ID.is_match(id)
}

/// 索引とセッションのフォルダに書く、1 セッション分の情報
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedSession {
    pub id: String,
    pub title: Option<String>,
    pub project: Option<String>,
    /// プロジェクト名の決め方。集計に無いセッションは null
    pub project_source: Option<Value>,
    /// タスクタグ(そのセッションが入っているグループの名前)。無ければ空
    pub tags: Vec<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub memo: bool,
}

/// タスクタグ(グループ)ごとの、入っているセッションの id。groups.json が無い・読めなければ空
fn tags_by_id(groups_path: &Path) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for g in load_groups(groups_path).groups {
        for id in g.ids {
            out.entry(id).or_default().push(g.name.clone());
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct GroupUploadPaths {
    /// out/snapshot(前回の集計の複製)
    pub snapshot: PathBuf,
    pub groups: PathBuf,
    /// メモの置き場の親(atlas-notes/)。無ければメモは添えない
    pub notes: Option<PathBuf>,
    /// out/sessions.json(README の題名と日付に使う)。無ければ ID だけ並べる
    pub sessions: Option<PathBuf>,
}

impl GroupUploadPaths {
    pub fn of(p: &crate::paths::Paths) -> Self {
        GroupUploadPaths { snapshot: p.snapshot.clone(), groups: p.groups.clone(), notes: Some(p.notes.clone()), sessions: Some(p.sessions.clone()) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUploadResult {
    pub name: String,
    /// 写した先(<基底>/<グループ名>)
    pub dir: String,
    /// 写したセッション
    pub uploaded: usize,
    /// そのうち、前にも写してあって置き換えたもの
    pub replaced: usize,
    /// 前に送ったときから中身が変わっていないので、写し直さなかったセッション
    pub unchanged: usize,
    /// 写さなかったセッションのうち、添えた記録を書き直せなかったもの
    pub stale_meta: Vec<String>,
    /// グループの id のうち、前回の集計の複製に無かったもの
    pub missing: Vec<String>,
    /// 写した元の複製を作った日時(前回の集計)。分からなければ null
    pub snapshot_at: Option<String>,
    /// メモを添えたセッションの数
    pub memos: usize,
    /// 置き換えた前のフォルダのうち、消せずに残ったもの(手で消してもらう)
    pub leftovers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    /// セッションのフォルダからの相対パス(区切りは /)
    pub rel: String,
    pub bytes: u64,
    /// 更新時刻(ミリ秒。空のフォルダは 0)
    pub mtime: i64,
    /// シンボリックリンク(中身は辿らず、リンクのまま写す)
    pub link: bool,
    /// 空のフォルダ
    pub dir: bool,
}

type Skip<'a> = &'a dyn Fn(&str, &str, bool) -> bool;

/// セッションのフォルダの中のファイル(atlas の作業用のファイルは除く)。skip に当たるもの(フォルダなら中身ごと)も除く。
/// 除いた結果で中身が無くなったフォルダは、空のフォルダとして返す
fn list_files(base: &Path, sub: &str, skip: Option<Skip<'_>>) -> std::io::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for e in jsfs::read_dir(&jsfs::join_slash(base, sub))? {
        if e.name == SNAPSHOT_PRIVATE {
            continue;
        }
        let rel = if sub.is_empty() { e.name.clone() } else { format!("{sub}/{}", e.name) };
        if skip.is_some_and(|s| s(&rel, &e.name, e.is_dir())) {
            continue;
        }
        if e.is_dir() {
            let inner = list_files(base, &rel, skip)?;
            if inner.is_empty() {
                out.push(FileEntry { rel, bytes: 0, mtime: 0, link: false, dir: true });
            } else {
                out.extend(inner);
            }
        } else if e.is_link() {
            let m = std::fs::symlink_metadata(jsfs::join_slash(base, &rel))?;
            out.push(FileEntry { rel, bytes: 0, mtime: jsfs::mtime_ms(&m).round() as i64, link: true, dir: false });
        } else if e.is_file() {
            let m = std::fs::metadata(jsfs::join_slash(base, &rel))?;
            out.push(FileEntry { rel, bytes: m.len(), mtime: jsfs::mtime_ms(&m).round() as i64, link: false, dir: false });
        }
    }
    Ok(out)
}

/// 写すセッションのフォルダの中身。atlas が足して写すもの(メモと画像・atlas-session.json)は除く
fn session_files(base: &Path) -> std::io::Result<Vec<FileEntry>> {
    let added = [UPLOAD_MEMO_FILE, UPLOAD_MEMO_IMAGES, UPLOAD_SESSION_META, UPLOAD_VCS_META];
    Ok(list_files(base, "", None)?.into_iter().filter(|f| !added.contains(&f.rel.split('/').next().unwrap_or(""))).collect())
}

/// シンボリックリンクをリンクのまま写す(`cp(from, to, { verbatimSymlinks: true })`)
fn copy_link(from: &Path, to: &Path) -> std::io::Result<()> {
    let target = std::fs::read_link(from)?;
    #[cfg(windows)]
    {
        if std::fs::metadata(from).is_ok_and(|m| m.is_dir()) {
            std::os::windows::fs::symlink_dir(&target, to)
        } else {
            std::os::windows::fs::symlink_file(&target, to)
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, to)
    }
}

/// 一覧のファイルを写し、1 つ写すごとにその大きさを知らせる
fn copy_files(src: &Path, dest: &Path, files: &[FileEntry], on_bytes: &mut dyn FnMut(u64)) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    let mut made: HashSet<String> = HashSet::new();
    for f in files {
        let parts: Vec<&str> = f.rel.split('/').collect();
        let parent = parts[..parts.len() - 1].join("/");
        if !parent.is_empty() && !made.contains(&parent) {
            std::fs::create_dir_all(jsfs::join_slash(dest, &parent))?;
            made.insert(parent);
        }
        let from = jsfs::join_slash(src, &f.rel);
        let to = jsfs::join_slash(dest, &f.rel);
        if f.dir {
            std::fs::create_dir_all(&to)?;
        } else if f.link {
            copy_link(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
        on_bytes(f.bytes);
    }
    Ok(())
}

/// フォルダを丸ごと写す(`cp(src, dest, { recursive: true })`。リンクはリンクのまま)
fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for e in jsfs::read_dir(src)? {
        let (from, to) = (src.join(&e.name), dest.join(&e.name));
        if e.is_dir() {
            copy_tree(&from, &to)?;
        } else if e.is_link() {
            copy_link(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 前に送ったものと同じかを比べる要約の版。写し方や添えるものを変えたら上げる(上げると、次の回は全部を写し直す)
const CONTENTS_VERSION: u32 = 1;

fn sha(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// 送り先で OS や NAS が勝手に作るファイル(前に送ったときのままかを比べるときは数えない)
static OS_ADDED_FILES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:thumbs\.db|ehthumbs\.db|desktop\.ini|\.ds_store|\._.+)$").unwrap());
/// 同じく、NAS が勝手に作るフォルダ
static OS_ADDED_DIRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:@eadir|\.@__thumb|\.appledouble)$").unwrap());

/// 要約に入れない、デスクトップアプリの行の列(セッションの中身と関係なく変わるもの)
const DESKTOP_VOLATILE: [(&str, &[&str]); 3] = [
    ("project", &["last_opened_at", "show_in_sidebar"]),
    ("workspace", &["updated_at", "last_diff_files_changed", "last_diff_insertions", "last_diff_deletions", "last_diff_updated_at"]),
    ("activity", &["is_read", "updated_at"]),
];

/// 要約に入れる DB の行の文字列(DESKTOP_VOLATILE の列を除いたもの)。読めなければそのまま
pub fn store_key_text(store: &str) -> String {
    let Ok(mut j) = js::parse_json(store) else { return store.to_string() };
    if let Some(Value::Object(desk)) = j.get_mut("desktop") {
        let drop = |r: &mut Value, cols: &[&str]| {
            if let Value::Object(o) = r {
                o.retain(|k, _| !cols.contains(&k.as_str()));
            }
        };
        for (k, cols) in DESKTOP_VOLATILE {
            match desk.get_mut(k) {
                Some(Value::Array(a)) => a.iter_mut().for_each(|r| drop(r, cols)),
                Some(r) => drop(r, cols),
                None => {}
            }
        }
    }
    atlas_core::json::to_js_string(&j).unwrap_or_else(|_| store.to_string())
}

/// 要約に入れる照合の結果の文字列。照合した日時(computedAt と evaluated.at)は除く。読めなければそのまま
pub fn vcs_key_text(vcs: &str) -> String {
    let Ok(mut j) = js::parse_json(vcs) else { return vcs.to_string() };
    if let Value::Object(o) = &mut j {
        o.shift_remove("computedAt");
        if let Some(Value::Object(ev)) = o.get_mut("result").and_then(|r| r.get_mut("evaluated")) {
            ev.shift_remove("at");
        }
    }
    atlas_core::json::to_js_string(&j).unwrap_or_else(|_| vcs.to_string())
}

fn entry_line(prefix: &str, f: &FileEntry) -> String {
    format!("{prefix}{}\t{}\t{}\t{}", if f.dir { 'd' } else if f.link { 'l' } else { 'f' }, f.rel, f.bytes, f.mtime)
}

/// 送り先で比べるときの大きさの印: リンク / 空のフォルダ / 中身を問わないファイル(atlas が書くもの)
const WANT_LINK: i64 = -1;
const WANT_DIR: i64 = -2;
const WANT_ANY_FILE: i64 = -3;

fn want_of(f: &FileEntry) -> i64 {
    if f.link {
        WANT_LINK
    } else if f.dir {
        WANT_DIR
    } else {
        f.bytes as i64
    }
}

fn by_rel(a: &FileEntry, b: &FileEntry) -> std::cmp::Ordering {
    js::cmp_utf16(&a.rel, &b.rel)
}

/// そのセッションの、送る中身の要約。セッションのフォルダのファイルの名前・大きさ・更新時刻と、atlas が足すもの(DB の行・メモの本文・メモの画像)から作る
fn contents_key(id: &str, files: &[FileEntry], added: &UploadContext) -> Result<String> {
    let mut lines = vec![format!("v{CONTENTS_VERSION}")];
    let mut sorted = files.to_vec();
    sorted.sort_by(by_rel);
    lines.extend(sorted.iter().map(|f| entry_line("", f)));
    let store = added.store_json(id)?;
    lines.push(format!("store\t{}", store.as_deref().map_or("-".to_string(), |s| sha(&store_key_text(s)))));
    let memo = added.memo(id)?;
    lines.push(format!("memo\t{}", memo.as_deref().map_or("-".to_string(), sha)));
    let mut images = added.memo_images(id)?;
    images.sort_by(by_rel);
    lines.extend(images.iter().map(|f| entry_line("image\t", f)));
    // 照合の結果は、あるときだけ行を足す
    if let Some(v) = added.vcs_json(id) {
        lines.push(format!("vcs\t{}", sha(&vcs_key_text(&v))));
    }
    Ok(sha(&lines.join("\n")))
}

/// 送り先のそのセッションのフォルダが、前に送ったときのままか
fn same_as_sent(dest: &Path, id: &str, key: &str, files: &[FileEntry], added: &UploadContext, trusted: Option<&HashMap<PathBuf, String>>) -> bool {
    if !dest.exists() {
        return false;
    }
    if trusted.and_then(|t| t.get(dest)).is_some_and(|k| k == key) && dest.join(UPLOAD_SESSION_META).exists() {
        return true;
    }
    let check = || -> Result<bool> {
        let meta = js::parse_json(&std::fs::read_to_string(dest.join(UPLOAD_SESSION_META))?)?;
        if meta.get("id").and_then(Value::as_str) != Some(id) || meta.get("contents").and_then(Value::as_str) != Some(key) {
            return Ok(false);
        }
        let mut want: HashMap<String, i64> = files.iter().map(|f| (f.rel.clone(), want_of(f))).collect();
        want.insert(UPLOAD_SESSION_META.into(), WANT_ANY_FILE);
        if added.store_json(id)?.is_some() {
            want.insert(SESSION_STORE_JSON.into(), WANT_ANY_FILE);
        }
        if added.vcs_json(id).is_some() {
            want.insert(UPLOAD_VCS_META.into(), WANT_ANY_FILE);
        }
        if let Some(memo) = added.memo(id)? {
            want.insert(UPLOAD_MEMO_FILE.into(), memo_for_upload(&memo, id).len() as i64);
            for f in added.memo_images(id)? {
                want.insert(format!("{UPLOAD_MEMO_IMAGES}/{}", f.rel), want_of(&f));
            }
        }
        // OS や NAS が勝手に作るもの(Thumbs.db・._<名前>・@eaDir など)は、送ったものに無ければ数えない
        let skip = |rel: &str, name: &str, dir: bool| !want.contains_key(rel) && if dir { OS_ADDED_DIRS.is_match(name) } else { OS_ADDED_FILES.is_match(name) };
        let have = list_files(dest, "", Some(&skip))?;
        if have.len() != want.len() {
            return Ok(false);
        }
        for f in &have {
            let Some(&w) = want.get(&f.rel) else { return Ok(false) };
            let bad = match w {
                WANT_LINK => !f.link,
                WANT_DIR => !f.dir,
                WANT_ANY_FILE => f.dir || f.link,
                n => f.dir || f.link || f.bytes as i64 != n,
            };
            if bad {
                return Ok(false);
            }
        }
        Ok(true)
    };
    // 記録が無い・読めない・フォルダを読めない: 写し直す
    check().unwrap_or(false)
}

/// 送り先のフォルダを読む数の上限(NAS へ 1 つずつ順に聞くと、待ち時間が積み重なるため)
const PLAN_CONCURRENCY: usize = 8;

/// 送るセッションごとの、写すファイルと要約と、前に送ったときのままか
#[derive(Debug, Clone)]
struct SessionPlan {
    id: String,
    files: Vec<FileEntry>,
    key: String,
    unchanged: bool,
}

/// 写すセッションを、写すものと、前に送ったときのままのものに分ける(点検とアップロードで同じ分け方)。full なら全部写す
fn plan_sessions(state_dir: &Path, dir: &Path, present: &[String], added: &UploadContext, full: bool, trusted: Option<&HashMap<PathBuf, String>>) -> Result<Vec<SessionPlan>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out: Mutex<Vec<Option<Result<SessionPlan>>>> = Mutex::new((0..present.len()).map(|_| None).collect());
    let worker = || {
        loop {
            let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if i >= present.len() {
                break;
            }
            let id = &present[i];
            let r = (|| -> Result<SessionPlan> {
                let files = session_files(&state_dir.join(id))?;
                let key = contents_key(id, &files, added)?;
                let unchanged = !full && same_as_sent(&dir.join(id), id, &key, &files, added, trusted);
                Ok(SessionPlan { id: id.clone(), files, key, unchanged })
            })();
            out.lock().unwrap()[i] = Some(r);
        }
    };
    std::thread::scope(|s| {
        for _ in 0..PLAN_CONCURRENCY.min(present.len()) {
            s.spawn(worker);
        }
    });
    out.into_inner().unwrap().into_iter().map(|x| x.expect("すべて調べた")).collect()
}

/// 先頭がこの大きさの中に NUL があればバイナリとして中身を調べない
const SNIFF_BYTES: usize = 8192;
/// 区切りをまたぐ文字列を取りこぼさないよう、前の塊の末尾をこれだけ重ねて調べる(鍵 1 つより長く取る。バイト数)
const SCAN_OVERLAP: usize = 16 * 1024;
const SCAN_CHUNK: usize = 4 * 1024 * 1024;

/// API キー・トークンらしい形(種類名, 正規表現)。セッション記録の伏せ字と同じもの
use atlas_report::transcript::SECRET_PATTERNS;

/// 種類ごとの数(見つかった種類の順。JS の Map と同じく、最初に見つかった順)
pub type SecretCounts = Vec<(String, usize)>;

fn add_count(c: &mut SecretCounts, label: &str, n: usize) {
    match c.iter_mut().find(|x| x.0 == label) {
        Some(x) => x.1 += n,
        None => c.push((label.to_string(), n)),
    }
}

/// バイト列の末尾の、まだ文字になりきっていない UTF-8 の長さ(StringDecoder が次に持ち越す分)
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=3.min(b.len()) {
        let c = b[b.len() - back];
        if c & 0xC0 == 0x80 {
            continue;
        }
        let need = if c >= 0xF0 { 4 } else if c >= 0xE0 { 3 } else if c >= 0xC0 { 2 } else { 1 };
        return if need > back { back } else { 0 };
    }
    0
}

/// ファイルの中の秘密らしい文字列を種類ごとに数える。バイナリなら None
pub fn scan_secrets(path: &Path) -> std::io::Result<Option<SecretCounts>> {
    let mut f = std::fs::File::open(path)?;
    let mut head = vec![0u8; SNIFF_BYTES];
    let mut n = 0;
    while n < SNIFF_BYTES {
        let r = f.read(&mut head[n..])?;
        if r == 0 {
            break;
        }
        n += r;
    }
    if head[..n].contains(&0) {
        return Ok(None);
    }
    let mut counts: SecretCounts = Vec::new();
    let mut carry = String::new();
    let mut from: usize = 0;
    // 塊ごとに、重ねる部分より前で始まるものだけを数える(重ねた部分は次の塊で数える)。最後の塊は末尾まで数える
    let mut scan = |text: &str, last: bool, carry: &mut String, from: &mut usize| {
        let mut limit = if last { text.len() } else { text.len() - SCAN_OVERLAP };
        while !text.is_char_boundary(limit) {
            limit -= 1;
        }
        for (label, re) in SECRET_PATTERNS.iter() {
            let k = re.find_iter(text).filter(|m| m.start() >= *from && m.start() < limit).count();
            if k > 0 {
                add_count(&mut counts, label, k);
            }
        }
        // \b が前の文字を見られるよう 1 文字だけ持ち越す
        let keep = text[..limit].char_indices().next_back().map_or(0, |(i, _)| i);
        if last {
            carry.clear();
            *from = 0;
        } else {
            *carry = text[keep..].to_string();
            *from = limit - keep;
        }
    };
    let mut f = std::fs::File::open(path)?;
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; SCAN_CHUNK];
    loop {
        let r = f.read(&mut buf)?;
        if r == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..r]);
        let tail = incomplete_tail(&pending);
        let rest = pending.split_off(pending.len() - tail);
        let text = format!("{carry}{}", String::from_utf8_lossy(&pending));
        pending = rest;
        if text.len() > SCAN_OVERLAP + from {
            scan(&text, false, &mut carry, &mut from);
        } else {
            carry = text;
        }
    }
    let text = format!("{carry}{}", String::from_utf8_lossy(&pending));
    let mut c2 = String::new();
    scan(&text, true, &mut c2, &mut from);
    Ok(Some(counts))
}

/// 文字列の中の秘密らしい文字列を種類ごとに数える(atlas が足して写すもの: DB の行・メモ)
fn count_secrets(text: &str) -> SecretCounts {
    let mut c = Vec::new();
    for (label, re) in SECRET_PATTERNS.iter() {
        let n = re.find_iter(text).count();
        if n > 0 {
            add_count(&mut c, label, n);
        }
    }
    c
}

/// アップロード先のグループのフォルダ(<基底>/<グループ名>)。フォルダ名に使えない文字は _ にする
pub fn upload_dir(root: &Path, name: &str) -> PathBuf {
    root.join(safe_dir_name(name))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LargeEntry {
    pub id: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SecretKind {
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SecretFile {
    pub id: String,
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SecretSummary {
    /// 見つかった数(偽陽性もありうる)
    pub count: usize,
    pub kinds: Vec<SecretKind>,
    /// 見つかったファイル。多い順に最大 10 件
    pub files: Vec<SecretFile>,
    /// 中身を調べなかったバイナリのファイルの数
    pub skipped: usize,
}

/// 写す前の点検(画面の確認に出す)。大きさと、秘密らしい文字列
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCheck {
    pub name: String,
    pub dir: String,
    /// 今回写すセッション
    pub sessions: usize,
    /// 前に送ったときから中身が変わっていないので、写さないセッション
    pub unchanged: usize,
    pub missing: Vec<String>,
    /// 今回写すもののうち、前にも写してあって置き換えるもの
    pub replace: usize,
    pub bytes: u64,
    pub files: usize,
    /// 大きいもの(セッションの直下のフォルダ・ファイル)。大きい順に最大 5 件
    pub largest: Vec<LargeEntry>,
    pub secrets: SecretSummary,
    pub snapshot_at: Option<String>,
    /// この点検の指紋。写すときに渡すと、写す直前に点検し直して違えば写さない
    pub fingerprint: String,
    /// 点検で、送り先のフォルダが前に送ったときのままと確かめたもの(送り先のセッションのフォルダ → 要約。TS 版の trustedByCheck)
    #[serde(skip)]
    pub trusted: HashMap<PathBuf, String>,
}

/// 確認してから写すまでの間に、写す中身が変わった(写していない)
#[derive(Debug, Clone)]
pub struct UploadChangedError;

impl std::fmt::Display for UploadChangedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("確かめた後に、写すログが変わりました(集計し直したなど)。何も写していません。もう一度確かめてください")
    }
}

impl std::error::Error for UploadChangedError {}

/// 写している途中の進み具合
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct UploadProgress {
    pub sessions: usize,
    pub done: usize,
    pub bytes: u64,
    pub copied: u64,
    /// 写しているセッション
    pub current: Option<String>,
}

/// 確認に「大きいもの」を出す目安(段 5 の serve の画面が使う)
#[allow(dead_code)]
pub const UPLOAD_CONFIRM_BYTES: u64 = 100 * 1024 * 1024;

/// 写すセッションのまとまり(グループか、集計のプロジェクト)。名前がアップロード先のフォルダ名になる
#[derive(Debug, Clone, PartialEq)]
pub struct UploadTarget {
    /// group / project
    pub kind: String,
    pub name: String,
    /// README に書く説明
    pub note: String,
    pub ids: Vec<String>,
}

fn kind_label(kind: &str) -> &'static str {
    if kind == "group" { "タスクタグ" } else { "プロジェクト" }
}

struct Prepared {
    state_dir: PathBuf,
    dir: PathBuf,
    present: Vec<String>,
    missing: Vec<String>,
}

/// groups.json のグループ(画面ではタスクタグ)を、写すまとまりにする(無い・空・フォルダ名が別のタグと同じなら止まる)
pub fn group_target(groups_path: &Path, name: &str) -> Result<UploadTarget> {
    let loaded = load_groups(groups_path);
    let Some(g) = loaded.groups.iter().find(|x| x.name == name) else {
        let names: Vec<&str> = loaded.groups.iter().map(|x| x.name.as_str()).collect();
        bail!("タスクタグ「{name}」はありません{}", if names.is_empty() { String::new() } else { format!("(あるのは: {})", names.join(", ")) });
    };
    if g.ids.is_empty() {
        bail!("タスクタグ「{name}」にセッションがありません");
    }
    // フォルダ名に直すと同じになる別のタスクタグがあれば、混ざるので写さない
    let folder = safe_dir_name(name);
    if let Some(clash) = loaded.groups.iter().find(|x| x.name != name && js::to_lower(&safe_dir_name(&x.name)) == js::to_lower(&folder)) {
        bail!("タスクタグ「{name}」と「{}」は、アップロード先のフォルダ名が同じ「{folder}」になります。どちらかの名前を変えてください", clash.name);
    }
    Ok(UploadTarget { kind: "group".into(), name: name.into(), note: g.note.clone(), ids: g.ids.clone() })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub name: String,
    /// 送れるセッション(空でなく、前回の集計の複製にログのフォルダがあるもの)
    pub sessions: usize,
    /// 記録はあるが、ログのフォルダが無いので送れないもの
    pub no_log: usize,
    pub updated_at: Option<String>,
}

/// sessions.json のセッションの記録のうち、アップロードで使うもの
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRecord {
    pub id: String,
    #[serde(default)]
    pub empty: bool,
    #[serde(default)]
    pub project: Option<Value>,
    #[serde(default)]
    pub project_source: Option<Value>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub first_user_message: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl UploadRecord {
    fn project_name(&self) -> Option<&str> {
        self.project.as_ref().and_then(Value::as_str)
    }
}

#[derive(Deserialize)]
struct SessionsOnly {
    sessions: Vec<UploadRecord>,
}

/// sessions.json のセッションの記録。無ければ止まる(先に集計してもらう)
pub fn read_sessions(path: &Path) -> Result<Vec<UploadRecord>> {
    if !path.exists() {
        bail!("{} がありません。先に集計してください(atlas.bat か atlas all)", path.display());
    }
    let text = std::fs::read(path)?;
    Ok(js::parse_json_as::<SessionsOnly>(&String::from_utf8_lossy(&text))?.sessions)
}

/// 集計のプロジェクトごとの、送れるセッションの数と最終更新。多い順。
/// snapshot を渡すと、ログのフォルダがあるものだけを数え、無いものは noLog に分ける
pub fn list_projects(records: &[UploadRecord], snapshot: Option<&Path>) -> Vec<ProjectSummary> {
    let state_dir = snapshot.map(|s| s.join("session-state"));
    let mut by: indexmap::IndexMap<String, ProjectSummary> = indexmap::IndexMap::new();
    for s in records {
        let Some(project) = s.project_name().filter(|_| !s.empty) else { continue };
        let x = by.entry(project.to_string()).or_insert_with(|| ProjectSummary { name: project.to_string(), sessions: 0, no_log: 0, updated_at: None });
        if state_dir.as_ref().is_some_and(|d| !(safe_id(&s.id) && d.join(&s.id).exists())) {
            x.no_log += 1;
        } else {
            x.sessions += 1;
            if let Some(u) = s.updated_at.as_deref().filter(|u| !u.is_empty()) {
                if x.updated_at.as_deref().is_none_or(|cur| cur.is_empty() || js::cmp_utf16(u, cur).is_gt()) {
                    x.updated_at = Some(u.to_string());
                }
            }
        }
    }
    let mut out: Vec<ProjectSummary> = by.into_values().filter(|x| x.sessions > 0).collect();
    out.sort_by(|a, b| b.sessions.cmp(&a.sessions).then_with(|| collate::locale_compare(&a.name, &b.name)));
    out
}

/// 集計のプロジェクトの、送れるセッション(空でなく、ログのフォルダがあるもの)を、写すまとまりにする
pub fn project_target(snapshot: &Path, name: &str, records: &[UploadRecord]) -> Result<UploadTarget> {
    let state_dir = snapshot.join("session-state");
    let ids: Vec<String> = records.iter().filter(|s| s.project_name() == Some(name) && !s.empty && safe_id(&s.id) && state_dir.join(&s.id).exists()).map(|s| s.id.clone()).collect();
    if ids.is_empty() {
        bail!("プロジェクト「{name}」の送れるセッションは、前回の集計にありません(空のセッションと、ログのフォルダが無いものは送りません)");
    }
    Ok(UploadTarget { kind: "project".into(), name: name.into(), note: format!("集計のプロジェクト「{name}」のセッション(空のものとログのフォルダが無いものを除く {} 件)", ids.len()), ids })
}

struct IndexInfo {
    kind: String,
    name: String,
    uploaded_at: Option<String>,
}

/// 送り先のフォルダの索引(前に送ったときに書いたもの)。無いか読めなければ None
fn read_index(dir: &Path) -> Option<IndexInfo> {
    let path = dir.join(UPLOAD_INDEX);
    let j = js::parse_json(&String::from_utf8_lossy(&std::fs::read(path).ok()?)).ok()?;
    let kind = j.get("kind").and_then(Value::as_str).filter(|k| *k == "group" || *k == "project")?;
    let name = j.get("name").and_then(Value::as_str)?;
    Some(IndexInfo { kind: kind.into(), name: name.into(), uploaded_at: j.get("uploadedAt").and_then(Value::as_str).map(str::to_string) })
}

/// 送り先のフォルダに前に送ったときの日時(索引の uploadedAt)。無ければ None(段 5 の serve の画面が使う)
#[allow(dead_code)]
pub fn uploaded_at(root: &Path, name: &str) -> Option<String> {
    read_index(&upload_dir(root, name))?.uploaded_at
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// snapshot-manifest.json のうち、アップロードで使うもの(TS 版は形を確かめずに JSON.parse したものを読む)
struct ManifestInfo {
    created_at: Option<String>,
    layout: Option<String>,
    installed: Option<Value>,
}

/// 出力先の snapshot-manifest.json を読む(無ければ None。JSON として読めなければ失敗)
fn read_manifest(snapshot: &Path) -> Result<Option<ManifestInfo>> {
    let p = snapshot.join(atlas_core::snapshot::SNAPSHOT_MANIFEST);
    if !p.exists() {
        return Ok(None);
    }
    let v = js::parse_json(&String::from_utf8_lossy(&std::fs::read(&p)?))?;
    Ok(Some(ManifestInfo {
        created_at: v.get("createdAt").and_then(Value::as_str).map(str::to_string),
        layout: v.get("layout").and_then(Value::as_str).map(str::to_string),
        installed: v.get("installed").filter(|i| js::truthy(Some(i))).cloned(),
    }))
}

/// 写せるかを確かめ、写すセッションと写さないセッションに分ける(点検とアップロードで同じ条件)
fn prepare(p: &GroupUploadPaths, g: &UploadTarget, root: &Path) -> Result<Prepared> {
    let name = &g.name;
    // 基底のフォルダは作らない(ネットワークドライブの切断やドライブ名の違いで、思わぬ場所に作らないように)
    if !is_dir(root) {
        bail!("アップロード先のフォルダが見つかりません: {}(フォルダを作るか、場所を選び直してください)", root.display());
    }
    let state_dir = p.snapshot.join("session-state");
    if !state_dir.exists() {
        bail!("{} がありません。先に集計してください(atlas.bat か atlas all)", state_dir.display());
    }
    // 1 件も写せないなら、フォルダを作らず README も書き直さない
    if !g.ids.iter().any(|id| safe_id(id) && state_dir.join(id).exists()) {
        bail!("{}「{name}」のセッション({} 件)は、前回の集計に 1 件もありません。先に集計し直してください(何も写していません)", kind_label(&g.kind), g.ids.len());
    }
    let dir = upload_dir(root, name);
    // 送り先のフォルダに、別のものがすでに送られていれば、README と索引が上書きし合うので写さない
    if let Some(prev) = read_index(&dir) {
        if prev.kind != g.kind || prev.name != *name {
            bail!(
                "送り先のフォルダ「{}」には、{}「{}」がすでに送られています。混ざるので写しません({}送り先を変えてください)",
                dir.display(),
                kind_label(&prev.kind),
                prev.name,
                if g.kind == "group" { "タスクタグの名前を変えるか、" } else { "" }
            );
        }
    }
    // groups.json は手で書けるので、フォルダの外を指す id は写さない
    let (mut present, mut missing) = (Vec::new(), Vec::new());
    for id in &g.ids {
        if safe_id(id) && state_dir.join(id).exists() {
            present.push(id.clone());
        } else {
            missing.push(id.clone());
        }
    }
    Ok(Prepared { state_dir, dir, present, missing })
}

/// グループ(タスクタグ)を写す前の点検
pub fn check_upload(p: &GroupUploadPaths, name: &str, root: &Path) -> Result<UploadCheck> {
    check_target(p, &group_target(&p.groups, name)?, root, None, false)
}

/// session-store.db をセッションごとに読む道具(core の extract.ts の openSessionStoreReader)
struct SessionStoreReader {
    db: rusqlite::Connection,
    has: HashMap<&'static str, bool>,
    schema_version: Option<f64>,
}

/// session-store.db から読む表と列(extract の STORE_QUERIES と同じ)
const STORE_QUERIES: [(&str, &str, &str, &str); 4] = [
    ("sessions", "SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions", "id", ""),
    ("turns", "SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns", "session_id", ""),
    ("assistant_usage_events", "SELECT * FROM assistant_usage_events", "session_id", " ORDER BY id"),
    ("session_files", "SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files", "session_id", ""),
];

/// SQLite の値を JS の値にしたもの(node:sqlite と同じ: 整数・実数は数、文字列、NULL)
fn sql_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => serde_json::json!(i as f64),
        ValueRef::Real(f) => serde_json::json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(b.iter().map(u8::to_string).collect::<Vec<_>>().join(",")),
    }
}

impl SessionStoreReader {
    fn open(db_path: &Path) -> Result<Option<Self>> {
        if !db_path.exists() {
            return Ok(None);
        }
        let db = atlas_core::sqlite::open_read_only(db_path)?;
        let mut has = HashMap::new();
        for t in ["sessions", "turns", "assistant_usage_events", "session_files", "schema_version"] {
            let e = db.prepare_cached("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")?.exists([t])?;
            has.insert(t, e);
        }
        let schema_version = if has["schema_version"] { db.query_row("SELECT version FROM schema_version", [], |r| Ok(sql_value(r.get_ref(0)?))).ok().and_then(|v| v.as_f64()) } else { None };
        Ok(Some(SessionStoreReader { db, has, schema_version }))
    }

    fn rows(&self, id: &str) -> Result<Option<Value>> {
        let mut parts: Vec<Value> = Vec::new();
        let mut total = 0;
        for (table, sql, key, order) in STORE_QUERIES {
            if !self.has[table] {
                parts.push(Value::Array(vec![]));
                continue;
            }
            let mut st = self.db.prepare_cached(&format!("{sql} WHERE {key} = ?{order}"))?;
            let names: Vec<String> = st.column_names().map(|s| s.to_string()).collect();
            let mut rows = st.query([id])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                let mut m = Map::new();
                for (i, n) in names.iter().enumerate() {
                    m.insert(n.clone(), sql_value(r.get_ref(i)?));
                }
                out.push(Value::Object(m));
            }
            total += out.len();
            parts.push(Value::Array(out));
        }
        if total == 0 {
            return Ok(None);
        }
        let mut o = Map::new();
        o.insert("version".into(), Value::from(1));
        o.insert("schemaVersion".into(), self.schema_version.map_or(Value::Null, |v| serde_json::json!(v)));
        for (k, v) in ["sessions", "turns", "usage", "files"].into_iter().zip(parts) {
            o.insert(k.into(), v);
        }
        Ok(Some(Value::Object(o)))
    }
}

/// atlas が足して写すもの(DB の行・メモと画像)を読む口。session-store.db を開いたままにする。
/// 点検とアップロードで共有できる(何プロジェクトかをまとめて点検・送るときに 1 回だけ開く)
pub struct UploadContext {
    reader: Option<Mutex<SessionStoreReader>>,
    desktop: Option<DesktopData>,
    memo_dir: Option<PathBuf>,
    vcs: HashMap<String, String>,
    stores: Mutex<HashMap<String, Option<String>>>,
    memos: Mutex<HashMap<String, Option<String>>>,
    images: Mutex<HashMap<String, Vec<FileEntry>>>,
}

/// 点検とアップロードで共有できる、atlas が足して写すものを読む口
pub fn open_upload_context(p: &GroupUploadPaths) -> Result<UploadContext> {
    // session-store.db は 1 回だけ開く
    let reader = SessionStoreReader::open(&p.snapshot.join("session-store.db"))?.map(Mutex::new);
    // デスクトップアプリのセッションは題名・モデル・トークン数などが data.db にしかない
    let desktop = read_desktop_json(&p.snapshot.join(DESKTOP_JSON));
    let memo_dir = p.notes.as_ref().map(|n| n.join(atlas_report::memo::MEMOS_DIR_NAME));
    // 照合の結果は out/(スナップショットの親)にある。送り先から集計したもの(computedOn が sender)は、この PC の結果ではないので添えない
    let mut vcs = HashMap::new();
    if let Some(r) = read_vcs_retention(&p.snapshot.parent().unwrap_or(Path::new(".")).join(VCS_RETENTION_FILE)) {
        if r.computed_on == ComputedOn::Local {
            for s in &r.sessions {
                vcs.insert(s.session_id.clone(), sender_vcs_json(s, &r.generated_at, r.mode));
            }
        }
    }
    Ok(UploadContext { reader, desktop, memo_dir, vcs, stores: Mutex::default(), memos: Mutex::default(), images: Mutex::default() })
}

impl UploadContext {
    /// atlas-session-store.json の中身(DB にも data.db にも行が無ければ None)
    pub fn store_json(&self, id: &str) -> Result<Option<String>> {
        if let Some(s) = self.stores.lock().unwrap().get(id) {
            return Ok(s.clone());
        }
        let rows = match &self.reader {
            Some(r) => r.lock().unwrap().rows(id)?,
            None => None,
        };
        let desk = self.desktop.as_ref().and_then(|d| desktop_for_session(d, id));
        let text = if rows.is_none() && desk.is_none() {
            None
        } else {
            let mut o = match rows {
                Some(Value::Object(o)) => o,
                _ => serde_json::from_value(serde_json::json!({ "version": 1, "schemaVersion": null, "sessions": [], "turns": [], "usage": [], "files": [] })).unwrap(),
            };
            if let Some(d) = desk {
                o.insert("desktop".into(), serde_json::to_value(d)?);
            }
            Some(format!("{}\n", atlas_core::json::to_js_string(&o)?))
        };
        self.stores.lock().unwrap().insert(id.to_string(), text.clone());
        Ok(text)
    }

    /// メモの本文(無いか空なら None)
    pub fn memo(&self, id: &str) -> Result<Option<String>> {
        if let Some(m) = self.memos.lock().unwrap().get(id) {
            return Ok(m.clone());
        }
        let m = match &self.memo_dir {
            Some(d) => read_memo_text(d, id)?.filter(|t| !js::trim(t).is_empty()),
            None => None,
        };
        self.memos.lock().unwrap().insert(id.to_string(), m.clone());
        Ok(m)
    }

    /// この PC で照合した結果(atlas-vcs.json の中身)。照合していなければ None
    pub fn vcs_json(&self, id: &str) -> Option<String> {
        self.vcs.get(id).cloned()
    }

    /// メモの画像(<notes>/memos/<id>/。空のフォルダとリンクも含む)。メモの本文が無ければ写さないので空
    pub fn memo_images(&self, id: &str) -> Result<Vec<FileEntry>> {
        if let Some(x) = self.images.lock().unwrap().get(id) {
            return Ok(x.clone());
        }
        let x = match &self.memo_dir {
            Some(d) if self.memo(id)?.is_some() && is_dir(&d.join(id)) => list_files(&d.join(id), "", None)?,
            _ => Vec::new(),
        };
        self.images.lock().unwrap().insert(id.to_string(), x.clone());
        Ok(x)
    }

    /// atlas が足して写すものの大きさの合計(本文・DB の行・画像)
    pub fn bytes(&self, id: &str) -> Result<u64> {
        let s = self.store_json(id)?.map_or(0, |s| s.len() as u64);
        let m = self.memo(id)?.map_or(0, |m| m.len() as u64);
        let v = self.vcs_json(id).map_or(0, |v| v.len() as u64);
        Ok(s + m + v + self.memo_images(id)?.iter().map(|f| f.bytes).sum::<u64>())
    }
}

/// メモの本文を読む(<dir>/<id>.md。BOM は取り除く)
fn read_memo_text(dir: &Path, id: &str) -> Result<Option<String>> {
    Ok(atlas_report::memo_io::read_memo(dir, id)?.map(|m| m.text))
}

/// 写す前の点検(大きさと秘密らしい文字列)。何も写さない。ctx は共有する読む口
pub fn check_target(p: &GroupUploadPaths, target: &UploadTarget, root: &Path, ctx: Option<&UploadContext>, full: bool) -> Result<UploadCheck> {
    Ok(inspect(p, target, root, ctx, full, None)?.0)
}

/// 点検の本体。写すときに使い回せるよう、セッションごとの分け方も返す
fn inspect(p: &GroupUploadPaths, target: &UploadTarget, root: &Path, ctx: Option<&UploadContext>, full: bool, trusted: Option<&HashMap<PathBuf, String>>) -> Result<(UploadCheck, Vec<SessionPlan>)> {
    let Prepared { state_dir, dir, present, missing } = prepare(p, target, root)?;
    let own;
    let added = match ctx {
        Some(c) => c,
        None => {
            own = open_upload_context(p)?;
            &own
        }
    };
    let mut tops: Vec<LargeEntry> = Vec::new();
    let mut hits: Vec<SecretFile> = Vec::new();
    let mut kinds: SecretCounts = Vec::new();
    let (mut bytes, mut files, mut skipped) = (0u64, 0usize, 0usize);
    let mut tally = |id: &str, path: &str, found: &SecretCounts, kinds: &mut SecretCounts| {
        let mut n = 0;
        for (label, c) in found {
            add_count(kinds, label, *c);
            n += c;
        }
        if n > 0 {
            hits.push(SecretFile { id: id.into(), path: path.into(), count: n });
        }
    };
    let add_top = |tops: &mut Vec<LargeEntry>, id: &str, path: &str, n: u64| match tops.iter_mut().find(|x| x.id == id && x.path == path) {
        Some(t) => t.bytes += n,
        None => tops.push(LargeEntry { id: id.into(), path: path.into(), bytes: n }),
    };
    let mut send: Vec<String> = Vec::new();
    let mut unchanged: Vec<String> = Vec::new();
    let plans = plan_sessions(&state_dir, &dir, &present, added, full, trusted)?;
    for plan in &plans {
        let id = &plan.id;
        if plan.unchanged {
            unchanged.push(id.clone());
            continue;
        }
        send.push(id.clone());
        let base = state_dir.join(id);
        for f in &plan.files {
            // 空のフォルダは数えない。シンボリックリンクはリンクのまま写すので中身を開かない
            if f.dir {
                continue;
            }
            bytes += f.bytes;
            files += 1;
            add_top(&mut tops, id, f.rel.split('/').next().unwrap_or(""), f.bytes);
            if f.link {
                continue;
            }
            match scan_secrets(&jsfs::join_slash(&base, &f.rel))? {
                None => skipped += 1,
                Some(found) => tally(id, &f.rel, &found, &mut kinds),
            }
        }
        // atlas が足して写すもの(DB の行には依頼文や応答の本文が入る。メモには利用者が貼ったものが入る)も調べる
        for (path, text) in [(SESSION_STORE_JSON, added.store_json(id)?), (UPLOAD_MEMO_FILE, added.memo(id)?), (UPLOAD_VCS_META, added.vcs_json(id))] {
            let Some(text) = text else { continue };
            let n = text.len() as u64;
            bytes += n;
            files += 1;
            add_top(&mut tops, id, path, n);
            tally(id, path, &count_secrets(&text), &mut kinds);
        }
        // メモの画像も写すので、大きさに入れる(中身は画像なので調べない。空のフォルダは数えない)
        for f in added.memo_images(id)?.iter().filter(|x| !x.dir) {
            bytes += f.bytes;
            files += 1;
            skipped += 1;
            add_top(&mut tops, id, UPLOAD_MEMO_IMAGES, f.bytes);
        }
    }
    let manifest = read_manifest(&p.snapshot)?;
    let count: usize = kinds.iter().map(|k| k.1).sum();
    let snapshot_at = manifest.as_ref().and_then(|m| m.created_at.clone());
    tops.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    tops.truncate(5);
    let mut kinds_out: Vec<SecretKind> = kinds.into_iter().map(|(label, count)| SecretKind { label, count }).collect();
    kinds_out.sort_by(|a, b| b.count.cmp(&a.count));
    hits.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| collate::locale_compare(&a.id, &b.id)).then_with(|| collate::locale_compare(&a.path, &b.path)));
    hits.truncate(10);
    let fingerprint = [send.join(","), unchanged.join(","), files.to_string(), bytes.to_string(), count.to_string(), snapshot_at.clone().unwrap_or_default()].join("|");
    let check = UploadCheck {
        name: target.name.clone(),
        dir: dir.to_string_lossy().into_owned(),
        sessions: send.len(),
        unchanged: unchanged.len(),
        missing,
        replace: send.iter().filter(|id| dir.join(id).exists()).count(),
        bytes,
        files,
        largest: tops,
        secrets: SecretSummary { count, kinds: kinds_out, files: hits, skipped },
        snapshot_at,
        fingerprint,
        trusted: plans.iter().filter(|x| x.unchanged).map(|x| (dir.join(&x.id), x.key.clone())).collect(),
    };
    Ok((check, plans))
}

#[derive(Default)]
pub struct UploadOptions<'a> {
    pub on_progress: Option<&'a dyn Fn(&UploadProgress)>,
    /// 確かめたときの点検の指紋。渡すと写す直前に点検し直し、違えば UploadChangedError で止まる(何も写さない)
    pub expect: Option<String>,
    /// 読み込み済みの sessions.json の記録(README の題名と日付に使う。無ければ読む)
    pub sessions: Option<&'a [UploadRecord]>,
    /// 共有する読む口(渡せば閉じない)
    pub context: Option<&'a UploadContext>,
    /// 前に送ったときから変わっていないセッションも写し直す
    pub full: bool,
    /// 確かめたときの点検(渡すと、そのとき前に送ったときのままと確かめたセッションの送り先の一覧を読み直さない)
    pub check: Option<&'a UploadCheck>,
    /// 添える atlas の版(テスト用。既定はこのプロセスの版)
    pub atlas: Option<AtlasBuild>,
}

pub fn upload_group(p: &GroupUploadPaths, name: &str, root: &Path, log: &dyn Fn(&str), opts: &UploadOptions<'_>) -> Result<GroupUploadResult> {
    upload_target(p, &group_target(&p.groups, name)?, root, log, opts)
}

/// まとまり(グループかプロジェクト)のセッションを <基底>/<名前>/<セッション id>/ に写す
pub fn upload_target(p: &GroupUploadPaths, target: &UploadTarget, root: &Path, log: &dyn Fn(&str), opts: &UploadOptions<'_>) -> Result<GroupUploadResult> {
    // 確かめてから今までに中身が変わっていたら写さない(点検していないログを写さないように)
    let mut planned: Option<Vec<SessionPlan>> = None;
    if let Some(expect) = &opts.expect {
        let (check, plans) = inspect(p, target, root, opts.context, opts.full, opts.check.map(|c| &c.trusted))?;
        if check.fingerprint != *expect {
            return Err(UploadChangedError.into());
        }
        planned = Some(plans);
    }
    let g = target;
    let Prepared { state_dir, dir, present, missing } = prepare(p, target, root)?;
    let name = &target.name;
    let manifest = read_manifest(&p.snapshot)?;
    std::fs::create_dir_all(&dir)?;
    let own;
    let added = match opts.context {
        Some(c) => c,
        None => {
            own = open_upload_context(p)?;
            &own
        }
    };
    let memo_dir = p.notes.as_ref().map(|n| n.join(atlas_report::memo::MEMOS_DIR_NAME));
    let mut done: Vec<String> = Vec::new();
    let mut with_memo: HashSet<String> = HashSet::new();
    // 前に送ったときのままなので写さなかったもの(README と索引には入れる)
    let mut kept: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let (mut uploaded, mut replaced) = (0usize, 0usize);
    let mut leftovers: Vec<String> = Vec::new();
    let mut stale_meta: Vec<String> = Vec::new();
    let records = read_records(opts.sessions, p.sessions.as_deref(), &present);
    let tags = tags_by_id(&p.groups);
    // 送る atlas の版。写し直さないセッションの記録も、この版に書き直す
    let atlas = opts.atlas.clone().unwrap_or_else(|| atlas_core::atlas_build::current_atlas_build(&crate::paths::REPO_ROOT));
    let info = |id: &str, with_memo: &HashSet<String>| -> UploadedSession {
        let r = records.get(id);
        UploadedSession {
            id: id.into(),
            title: r.and_then(|r| r.name.clone().filter(|n| !n.is_empty()).or_else(|| r.first_user_message.clone().filter(|n| !n.is_empty()))),
            project: r.and_then(|r| r.project_name().map(str::to_string)),
            project_source: r.and_then(|r| r.project_source.clone()),
            tags: tags.get(id).cloned().unwrap_or_default(),
            created_at: r.and_then(|r| r.created_at.clone()),
            updated_at: r.and_then(|r| r.updated_at.clone()),
            memo: with_memo.contains(id),
        }
    };
    let meta_text = |s: UploadedSession, key: Option<&String>| -> Result<String> {
        #[derive(Serialize)]
        struct Meta<'a> {
            version: u32,
            #[serde(flatten)]
            info: UploadedSession,
            #[serde(skip_serializing_if = "Option::is_none")]
            contents: Option<&'a String>,
            atlas: &'a AtlasBuild,
        }
        Ok(format!("{}\n", atlas_core::json::to_js_string_pretty(&Meta { version: 1, info: s, contents: key, atlas: &atlas })?))
    };
    // 進み具合はバイト数で出す。合計は点検と同じく、atlas が足して写すもの(DB の行・メモと画像)も入れる
    let mut lists: HashMap<String, Vec<FileEntry>> = HashMap::new();
    let mut keys: HashMap<String, String> = HashMap::new();
    let mut extra: HashMap<String, u64> = HashMap::new();
    let mut send: Vec<String> = Vec::new();
    let plans = match planned {
        Some(p) => p,
        None => plan_sessions(&state_dir, &dir, &present, added, opts.full, None)?,
    };
    for plan in plans {
        keys.insert(plan.id.clone(), plan.key.clone());
        if plan.unchanged {
            kept.insert(plan.id);
            continue;
        }
        extra.insert(plan.id.clone(), added.bytes(&plan.id)?);
        send.push(plan.id.clone());
        lists.insert(plan.id, plan.files);
    }
    let total = lists.values().flatten().map(|f| f.bytes).sum::<u64>() + extra.values().sum::<u64>();
    let mut progress = UploadProgress { sessions: send.len(), done: 0, bytes: total, copied: 0, current: None };
    let report = |p: &UploadProgress| {
        if let Some(f) = opts.on_progress {
            f(p);
        }
    };
    for id in &send {
        let src = state_dir.join(id);
        let dest = dir.join(id);
        progress.current = Some(id.clone());
        report(&progress);
        // 書きかけのフォルダを残さないよう、隣に写し終えてから置き換える
        let tmp = dir.join(upload_tmp_name(id));
        jsfs::rm_rf(&tmp)?;
        let step = (|| -> Result<()> {
            copy_files(&src, &tmp, lists.get(id).map(Vec::as_slice).unwrap_or(&[]), &mut |n| {
                progress.copied += n;
                report(&progress);
            })?;
            if let Some(store) = added.store_json(id)? {
                std::fs::write(tmp.join(SESSION_STORE_JSON), store)?;
            }
            if let Some(vcs) = added.vcs_json(id) {
                std::fs::write(tmp.join(UPLOAD_VCS_META), vcs)?;
            }
            if let Some(md) = &memo_dir {
                if copy_memo(md, id, &tmp)? {
                    with_memo.insert(id.clone());
                }
            }
            progress.copied += extra.get(id).copied().unwrap_or(0);
            report(&progress);
            // 中身の要約(contents)を添えておき、次の回に同じなら写し直さない
            std::fs::write(tmp.join(UPLOAD_SESSION_META), meta_text(info(id, &with_memo), keys.get(id))?)?;
            let had = dest.exists();
            // 前のフォルダは先に消さず、名前を変えて退ける。新しいフォルダを置けなければ前のフォルダを戻す。退けたものは最後に消す
            let old = dir.join(upload_old_name(id));
            if had {
                jsfs::rm_rf(&old)?;
                fs_retry::rename_replacing(&dest, &old)?;
            }
            if let Err(e) = fs_retry::rename_replacing(&tmp, &dest) {
                if had {
                    let _ = fs_retry::rename_replacing(&old, &dest);
                }
                return Err(e.into());
            }
            uploaded += 1;
            done.push(id.clone());
            progress.done = uploaded;
            report(&progress);
            if had {
                replaced += 1;
            }
            // 退けた前のフォルダを消す。前の回が置き換えの途中で止まって残したものも、ここで消す
            if had || old.exists() {
                if let Err(e) = jsfs::rm_rf(&old) {
                    leftovers.push(old.to_string_lossy().into_owned());
                    log(&format!("{} upload: 前のフォルダ {} を消せませんでした({e})。手で消してください", g.kind, old.display()));
                }
            }
            Ok(())
        })();
        if let Err(e) = step {
            let _ = jsfs::rm_rf(&tmp);
            bail!("セッション {id} を写せませんでした({e})。前に写したフォルダはそのままです。写し終えたのは {uploaded} 件です");
        }
    }
    // 写さないものも、添えた記録(タスクタグ・題名など)が変わっていれば書き直す。書き直せなくても止めずに、セッションを知らせる
    for id in &kept {
        let dest = dir.join(id);
        if added.memo(id)?.is_some() {
            with_memo.insert(id.clone());
        }
        let meta = meta_text(info(id, &with_memo), keys.get(id))?;
        let path = dest.join(UPLOAD_SESSION_META);
        let tmp = dest.join(format!(".{UPLOAD_SESSION_META}.tmp"));
        let r = (|| -> std::io::Result<()> {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(meta.as_str()) {
                std::fs::write(&tmp, &meta)?;
                fs_retry::rename_replacing(&tmp, &path)?;
            }
            Ok(())
        })();
        if let Err(e) = r {
            let _ = jsfs::rm_force(&tmp);
            stale_meta.push(id.clone());
            log(&format!("{} upload: セッション {id} の記録({UPLOAD_SESSION_META})を書き直せませんでした({e})。ログは前に送ったときのままです", g.kind));
        }
        // 前の回が置き換えの途中で止まって残したものを片付ける。消せなければ知らせる
        for left in [dir.join(upload_old_name(id)), dir.join(upload_tmp_name(id))] {
            if !left.exists() {
                continue;
            }
            if let Err(e) = jsfs::rm_rf(&left) {
                leftovers.push(left.to_string_lossy().into_owned());
                log(&format!("{} upload: 前のフォルダ {} を消せませんでした({e})。手で消してください", g.kind, left.display()));
            }
        }
    }
    let snapshot_at = manifest.as_ref().and_then(|m| m.created_at.clone());
    let now = jsdate::now_iso();
    // README と索引には、写したものと、前に送ったときのままのものの両方を、まとまりの順で載せる
    let sessions: Vec<UploadedSession> = present.iter().filter(|id| kept.contains(*id) || done.contains(id)).map(|id| info(id, &with_memo)).collect();
    std::fs::write(
        dir.join(UPLOAD_README),
        group_readme(&ReadmeInput { kind: &g.kind, name, note: &g.note, dir: &dir.to_string_lossy(), sessions: &sessions, missing: &missing, snapshot_at: snapshot_at.as_deref(), now: &now }),
    )?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Index<'a> {
        version: u32,
        kind: &'a str,
        name: &'a str,
        note: &'a str,
        uploaded_at: &'a str,
        snapshot_at: Option<&'a str>,
        atlas: &'a AtlasBuild,
        sessions: &'a [UploadedSession],
        missing: &'a [String],
    }
    let index = Index { version: 1, kind: &g.kind, name, note: &g.note, uploaded_at: &now, snapshot_at: snapshot_at.as_deref(), atlas: &atlas, sessions: &sessions, missing: &missing };
    std::fs::write(dir.join(UPLOAD_INDEX), format!("{}\n", atlas_core::json::to_js_string_pretty(&index)?))?;
    // 送った人がインストールしている skill・プラグインの名前。~/.copilot から集計したときだけ書く
    if let Some(m) = &manifest {
        if let (Some(installed), false) = (&m.installed, matches!(m.layout.as_deref(), Some("flat") | Some("merged"))) {
            let mut o = Map::new();
            o.insert("version".into(), Value::from(1));
            o.insert("sentAt".into(), Value::String(now.clone()));
            if let Value::Object(inv) = installed {
                o.extend(inv.clone());
            }
            std::fs::write(dir.join(UPLOAD_INSTALLED), format!("{}\n", atlas_core::json::to_js_string_pretty(&o)?))?;
        }
    }
    log(&format!(
        "{} upload: 「{name}」 {uploaded} セッション(置き換え {replaced} 件・メモ {} 件{})→ {}{}",
        g.kind,
        with_memo.len(),
        if kept.is_empty() { String::new() } else { format!("・前に送ったときのままの {} 件は写していません", kept.len()) },
        dir.display(),
        if missing.is_empty() { String::new() } else { format!("。前回の集計に無い {} 件は写していません", missing.len()) }
    ));
    Ok(GroupUploadResult {
        name: name.clone(),
        dir: dir.to_string_lossy().into_owned(),
        uploaded,
        replaced,
        unchanged: kept.len(),
        stale_meta,
        missing,
        snapshot_at,
        memos: with_memo.len(),
        leftovers,
    })
}

/// そのセッションのメモと画像を、写すフォルダの atlas-memo.md と atlas-memo/ に入れる。メモが無ければ false
fn copy_memo(memo_dir: &Path, id: &str, into: &Path) -> Result<bool> {
    let Some(text) = read_memo_text(memo_dir, id)?.filter(|t| !js::trim(t).is_empty()) else { return Ok(false) };
    let images = memo_dir.join(id);
    if is_dir(&images) {
        copy_tree(&images, &into.join(UPLOAD_MEMO_IMAGES))?;
    }
    std::fs::write(into.join(UPLOAD_MEMO_FILE), memo_for_upload(&text, id))?;
    Ok(true)
}

/// 送り先に書くメモの本文。画像の参照(<id>/<名前>)を atlas-memo/<名前> に直す
fn memo_for_upload(text: &str, id: &str) -> String {
    // id は SAFE_ID(英数字・_・-)なので、そのまま正規表現に入れてよい
    let re = Regex::new(&format!(r"(\]\()(\./)?{}/", regex::escape(id))).expect("正規表現");
    re.replace_all(text, format!("${{1}}{UPLOAD_MEMO_IMAGES}/").as_str()).into_owned()
}

/// README に載せる題名と日付のため、sessions.json から写したセッションだけを拾う。読めなければ空
fn read_records(given: Option<&[UploadRecord]>, path: Option<&Path>, ids: &[String]) -> HashMap<String, UploadRecord> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let want: HashSet<&String> = ids.iter().collect();
    let owned;
    let list: &[UploadRecord] = match given {
        Some(l) => l,
        None => match path {
            Some(p) if p.exists() => match read_sessions(p) {
                Ok(l) => {
                    owned = l;
                    &owned
                }
                Err(_) => return out,
            },
            _ => return out,
        },
    };
    for s in list {
        if want.contains(&s.id) {
            out.insert(s.id.clone(), s.clone());
        }
    }
    out
}

static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{RE_S}+")).unwrap());

/// 表のセルに入れる文字(| と改行で表を崩さない)
fn cell(s: &str) -> String {
    js::trim(&WS_RUN.replace_all(s, " ").replace('|', "\\|")).to_string()
}

/// この PC の時刻で「YYYY-MM-DD hh:mm」(画面と同じ dateTime。無ければ -)
fn local_time(iso: Option<&str>) -> String {
    date_time(iso, "-")
}

pub struct ReadmeInput<'a> {
    pub kind: &'a str,
    pub name: &'a str,
    pub note: &'a str,
    pub dir: &'a str,
    pub sessions: &'a [UploadedSession],
    pub missing: &'a [String],
    pub snapshot_at: Option<&'a str>,
    /// 写した日時(ISO)
    pub now: &'a str,
}

/// グループのフォルダの README.md(写すたびに書き直す)。人が開いて、何のまとまりか・どれにメモがあるかが分かるように
pub fn group_readme(o: &ReadmeInput<'_>) -> String {
    let mut lines: Vec<String> = vec![format!("# {}", o.name), String::new()];
    let note = js::trim(o.note);
    lines.push(if note.is_empty() { "(グループの説明はありません。atlas の画面のタスクタグの見出しで書けます)".into() } else { note.into() });
    lines.push(String::new());
    lines.push(format!("- アップロードした日時: {}", local_time(Some(o.now))));
    lines.push(format!("- ログの時点: {}", o.snapshot_at.filter(|s| !s.is_empty()).map_or("不明".to_string(), |s| format!("{} の集計", local_time(Some(s))))));
    lines.push(format!("- セッション: {} 件(うちメモあり {} 件)", o.sessions.len(), o.sessions.iter().filter(|s| s.memo).count()));
    lines.push(String::new());
    lines.push(format!("この README と {UPLOAD_INDEX}(プログラムや AI が読む索引)はアップロードするたびに書き直します。このフォルダには、ほかの回やほかの PC から写したセッションのフォルダもあることがあります。"));
    lines.push(format!("タスクタグは、atlas の画面でセッションに付けたものです(各セッションのフォルダの {UPLOAD_SESSION_META} にもあります)。"));
    lines.push(String::new());
    lines.push("| セッション ID | 題名 | タスクタグ | 最終更新 | メモ |".into());
    lines.push("| --- | --- | --- | --- | --- |".into());
    for s in o.sessions {
        let memo = if s.memo { format!("[あり]({}/{UPLOAD_MEMO_FILE})", s.id) } else { String::new() };
        let title = cell(&truncate(Some(s.title.as_deref().unwrap_or("")), 60));
        lines.push(format!(
            "| [{id}]({id}/) | {} | {} | {} | {} |",
            if title.is_empty() { "-".to_string() } else { title },
            if s.tags.is_empty() { "タグなし".to_string() } else { cell(&s.tags.join("、")) },
            local_time(s.updated_at.as_deref()),
            if memo.is_empty() { "-".to_string() } else { memo },
            id = s.id
        ));
    }
    // タスクごとに見分けられるよう、タグごとの一覧も書く(1 つのセッションが複数のタグに入ることがある)
    let mut by_tag: indexmap::IndexMap<String, Vec<&UploadedSession>> = indexmap::IndexMap::new();
    for s in o.sessions {
        let tags: Vec<String> = if s.tags.is_empty() { vec![String::new()] } else { s.tags.clone() };
        for t in tags {
            by_tag.entry(t).or_default().push(s);
        }
    }
    if by_tag.len() > 1 || !by_tag.contains_key(o.name) {
        lines.extend(["".into(), "## タスクタグごと".into(), "".into()]);
        let mut order: Vec<&String> = by_tag.keys().collect();
        order.sort_by(|a, b| match (a.is_empty(), b.is_empty()) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => collate::locale_compare(a, b),
        });
        for tag in order {
            let list = &by_tag[tag];
            lines.push(format!("### {}({} 件)", if tag.is_empty() { "タグなし".to_string() } else { cell(tag) }, list.len()));
            lines.push(String::new());
            for s in list {
                lines.push(format!("- [{}]({}/) — {}", cell(&truncate(Some(s.title.as_deref().unwrap_or(&s.id)), 60)), s.id, local_time(s.updated_at.as_deref())));
            }
            lines.push(String::new());
        }
        lines.pop();
    }
    if !o.missing.is_empty() {
        lines.push(String::new());
        lines.push(format!("{}にあっても、前回の集計に無かったため写していないもの: {}", kind_label(o.kind), o.missing.iter().map(|x| format!("`{}`", cell(x))).collect::<Vec<_>>().join(", ")));
    }
    lines.extend(
        [
            "",
            "## 集計し直すには(読みやすい記録もここで作れます)",
            "",
            "agent-session-atlas のフォルダで、次を実行します(出力先は、このフォルダの集計だけに使う場所にします。ほかの集計に使った出力先を指定すると、セッションが混ざらないように止まります)。",
            "",
            "```",
        ]
        .map(String::from),
    );
    lines.push(format!("npm run atlas -- all --home \"{}\" --out \"<出力先>\"", o.dir));
    lines.extend(
        [
            "```",
            "",
            "<出力先> に、画面(atlas.html)と、セッションごとの読みやすい記録(sessions\\<セッション ID>.md。依頼・応答・ツールの経過・消費をまとめた Markdown)ができます。",
            "記録はここに送った生ログから作れるので、送るものには含めていません(送り先の容量を使わないため)。",
            "",
        ]
        .map(String::from),
    );
    lines.push(format!("メモ(各セッションのフォルダの {UPLOAD_MEMO_FILE})とタスクタグ({UPLOAD_SESSION_META} の tags)は、このフォルダを集計し直した画面に、読むだけで出ます。ファイルを開いて読むこともできます。"));
    lines.push(String::new());
    lines.join("\n")
}

/// snapshot の desktop.json を読む。無いか読めなければ None(添えないだけで、アップロードは止めない)
fn read_desktop_json(path: &Path) -> Option<DesktopData> {
    let t = std::fs::read(path).ok()?;
    js::parse_json_as(&String::from_utf8_lossy(&t)).ok()
}

/// `atlas group upload`(commands.ts の runGroup の upload)。--to か設定の uploadRoot に写す。
/// 写す前に大きさと秘密らしい文字列を調べ、秘密らしい文字列があれば --force が無い限り写さない
pub fn run_group_upload(p: &crate::paths::Paths, name: &str, to: Option<&str>, force: bool, config: Option<&str>, log: &(dyn Fn(&str) + Sync)) -> Result<()> {
    let root = match to {
        None => {
            let explicit = config.map(str::to_string).or_else(|| std::env::var("ATLAS_CONFIG").ok());
            let path = match &explicit {
                Some(c) => crate::paths::resolve(c).to_string_lossy().into_owned(),
                None => crate::paths::REPO_ROOT.join(crate::config::CONFIG_FILE).to_string_lossy().into_owned(),
            };
            let cfg = crate::config::load_config(&path, explicit.is_some())?;
            cfg.upload_root.ok_or_else(|| anyhow!("アップロード先が決まっていません。--to <フォルダ> で指定するか、setup.bat か画面のグループの見出しで既定の場所を決めてください"))?
        }
        Some(t) => crate::config::parse_upload_root(&Value::String(t.into())).map_err(anyhow::Error::msg)?,
    };
    let root = PathBuf::from(root);
    // 前回の集計の複製(out/snapshot/)を読むので、集計の途中と重ならないよう印を取る
    let lock = crate::jobs::acquire_out_lock(&p.out, "group upload", "cli")?;
    let gp = GroupUploadPaths::of(p);
    let r = (|| -> Result<()> {
        let mb = crate::commands::mb;
        let c = check_upload(&gp, name, &root)?;
        log(&format!(
            "group upload: {} セッション・{}{}{}",
            c.sessions,
            mb(c.bytes),
            if c.unchanged > 0 { format!("(前に送ったときから変わっていない {} セッションは写しません)", c.unchanged) } else { String::new() },
            if c.largest.is_empty() {
                String::new()
            } else {
                format!("(大きいもの: {})", c.largest.iter().take(3).map(|x| format!("{}/{} {}", js::head(&x.id, 8), x.path, mb(x.bytes))).collect::<Vec<_>>().join("、"))
            }
        ));
        if c.secrets.count > 0 {
            log(&format!(
                "group upload: 秘密らしい文字列が {} 件あります({}。偽陽性もありえます)",
                c.secrets.count,
                c.secrets.kinds.iter().map(|k| format!("{} {}", k.label, k.count)).collect::<Vec<_>>().join("・")
            ));
            for f in &c.secrets.files {
                log(&format!("  {}/{}: {} 件", f.id, f.path, f.count));
            }
            if !force {
                bail!("写していません。写した先で見られる人を確かめ、それでも写すなら --force を付けてください(本物の鍵なら作り直してください)");
            }
        }
        // 点検したときの分け方を使い回す(送り先の一覧を 2 度読まない)。点検の後に中身が変わっていれば写さずに止まる
        let r = upload_group(&gp, name, &root, &|m| log(m), &UploadOptions { expect: Some(c.fingerprint.clone()), check: Some(&c), ..Default::default() })?;
        if !r.missing.is_empty() {
            log(&format!("group upload: 前回の集計に無いセッション: {}", r.missing.join(", ")));
        }
        if let Some(at) = &r.snapshot_at {
            log(&format!("group upload: 写したのは {at} の集計の時点のログです(新しくするには先に atlas all)"));
        }
        Ok(())
    })();
    lock.release();
    r
}

#[cfg(test)]
pub(crate) mod tests;
