//! ファイル・フォルダ・SQLite を写す部分(snapshot.ts の walk・copyTree・copyIfChanged・copySqlite などの移植)。
//! 元は読むだけ(SQLite も元は開かず、バイト列で写してから写した側を開く)。

use super::{LINK_REASON, SkippedEntry};
use crate::{jsfs, sqlite};
use anyhow::{Result, anyhow};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(super) struct Walked {
    pub files: Vec<(String, PathBuf)>,
    pub links: Vec<String>,
    pub errors: Vec<(String, String)>,
}

/// フォルダを歩く(シンボリックリンク・ジャンクションは辿らず、リンクの一覧に返す)。相対パスは / 区切り。
/// 読めないフォルダ(EPERM / EACCES 等)は全体を止めず errors に返す
pub(super) fn walk(dir: &Path) -> Walked {
    let mut w = Walked { files: Vec::new(), links: Vec::new(), errors: Vec::new() };
    fn rec(d: &Path, rel: &str, w: &mut Walked) {
        let ents = match jsfs::read_dir(d) {
            Ok(e) => e,
            Err(e) => {
                w.errors.push((rel.to_string(), jsfs::code(&e)));
                return;
            }
        };
        for e in ents {
            let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
            if e.is_link() {
                w.links.push(r);
            } else if e.is_dir() {
                rec(&d.join(&e.name), &r, w);
            } else if e.is_file() {
                w.files.push((r, d.join(&e.name)));
            }
        }
    }
    rec(dir, "", &mut w);
    w
}

/// フォルダの容量(再帰。リンクは辿らず、読めないフォルダは数えない)
pub(super) fn dir_bytes(dir: &Path) -> u64 {
    walk(dir).files.iter().map(|(_, abs)| size_or_0(abs)).sum()
}

/// ファイルの大きさ。一覧の後に消えた・読めないものは 0
pub(super) fn size_or_0(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// サイズと mtime が同じなら写さない。写したら複製先の mtime を元に合わせる(次回の再利用判定用。元のファイルには触れない)
pub(super) fn copy_if_changed(from: &Path, to: &Path) -> io::Result<(bool, u64)> {
    let s = fs::metadata(from)?;
    let sm = jsfs::mtime_ms(&s);
    if jsfs::exists(to) {
        let d = fs::metadata(to)?;
        if d.len() == s.len() && (jsfs::mtime_ms(&d) - sm).abs() < 2.0 {
            return Ok((false, s.len()));
        }
    }
    fs::copy(from, to)?;
    // TS 版の utimes(to, s.atime, s.mtime) と同じく、Date(ミリ秒に丸めたもの)で書く
    jsfs::utimes(to, jsfs::date_ms(jsfs::atime_ms(&s)), jsfs::date_ms(sm))?;
    Ok((true, s.len()))
}

/// 複製できなかったときの理由(TS 版の `err.code ?? err.message`)
pub(super) fn err_code(e: &io::Error) -> String {
    jsfs::code(e)
}

/// フォルダを再帰的に写す(サイズと mtime が同じファイルは再利用)。元に無いファイルは複製先から消す(現存しないものを残さない)。
/// 削除の前に元の実在を確かめる(Windows で大文字小文字だけ変えた改名で、写したばかりの複製を消さない)。削除で空になったフォルダも消す。
/// 1 ファイルの失敗(EBUSY / EPERM 等)や読めないフォルダは全体を止めず skipped に理由を積む。リンクは辿らず skipped に残す
pub(super) fn copy_tree(from: &Path, to: &Path, skipped: &mut Vec<SkippedEntry>, rel_base: &str) -> Result<(u64, u64)> {
    let mut files = 0;
    let mut bytes = 0;
    fs::create_dir_all(to)?;
    let src = walk(from);
    for l in &src.links {
        skipped.push(SkippedEntry { path: format!("{rel_base}/{l}"), bytes: 0, reason: LINK_REASON.to_string() });
    }
    for (rel, code) in &src.errors {
        skipped.push(SkippedEntry { path: if rel.is_empty() { rel_base.to_string() } else { format!("{rel_base}/{rel}") }, bytes: 0, reason: format!("読めなかった ({code})") });
    }
    let keep: std::collections::HashSet<&str> = src.files.iter().map(|(r, _)| r.as_str()).collect();
    for (rel, abs) in &src.files {
        let dst = jsfs::join_slash(to, rel);
        let r = dst.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| copy_if_changed(abs, &dst));
        match r {
            Ok((_, b)) => {
                files += 1;
                bytes += b;
            }
            Err(e) => skipped.push(SkippedEntry { path: format!("{rel_base}/{rel}"), bytes: 0, reason: format!("複製できなかった ({})", err_code(&e)) }),
        }
    }
    prune_tree(from, to, &keep)?;
    Ok((files, bytes))
}

/// 複製先にあって元に無いファイルを消し、空になったフォルダも消す。元の実在は大文字小文字を区別しないファイルシステムでも確かめる
fn prune_tree(from: &Path, to: &Path, keep: &std::collections::HashSet<&str>) -> Result<()> {
    if !jsfs::exists(to) {
        return Ok(());
    }
    let dst = walk(to);
    let mut dirs: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for (rel, abs) in &dst.files {
        if keep.contains(rel.as_str()) {
            continue;
        }
        // 名前の大文字小文字だけが違う改名: 元に(大文字小文字を無視して)あるなら消さない
        if jsfs::exists(&jsfs::join_slash(from, rel)) {
            continue;
        }
        jsfs::rm_force(abs)?;
        let parts: Vec<&str> = rel.split('/').collect();
        for i in (1..parts.len()).rev() {
            let d = parts[..i].join("/");
            if seen.insert(d.clone()) {
                dirs.push(d);
            }
        }
    }
    // 深いものから(JS の安定ソートと同じく、同じ長さは見つけた順)
    dirs.sort_by_key(|d| std::cmp::Reverse(d.encode_utf16().count()));
    for d in dirs {
        let p = jsfs::join_slash(to, &d);
        if let Ok(names) = jsfs::read_dir_names(&p) {
            if names.is_empty() {
                let _ = jsfs::rm_rf(&p);
            }
        }
    }
    Ok(())
}

pub(super) const SQLITE_COPY_ATTEMPTS: u32 = 8;

/// `${size}:${mtimeMs}`(TS 版と同じ書き方。mtimeMs は JS の数値の書き方)
fn fingerprint(p: &Path) -> io::Result<String> {
    let s = fs::metadata(p)?;
    let mut b = ryu_js::Buffer::new();
    let ms = jsfs::mtime_ms(&s);
    let t = if ms == 0.0 { "0" } else { b.format(ms) };
    Ok(format!("{}:{t}", s.len()))
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// JS の `s.slice(0, n)`(UTF-16 の単位で切る。サロゲートの片割れは落とす)
fn slice_utf16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let l = c.len_utf16();
        if used + l > n {
            break;
        }
        used += l;
        out.push(c);
    }
    out
}

/// WAL 付き SQLite を元に触れずに複製する。
/// 元を直接開くと、読み取り専用接続でも -shm(WAL インデックス)に読み取りマークを書くため
/// -shm の mtime が変わる(2026-10-28 実測)。そこで本体と -wal をバイト列のままコピーし、
/// コピー側を開いて VACUUM INTO で単一ファイルにする。
/// コピー中に元が書かれた(サイズか mtime が変わった)・-wal が消えた(チェックポイント)・quick_check が通らないときは、間を空けて取り直す。
/// 複製先は一時ファイルに作ってから置き換えるので、取り直しきれなくても前回の複製は残る。
pub(super) fn copy_sqlite(from: &Path, to: &Path, tmp_dir: &Path) -> Result<u32> {
    let r = copy_sqlite_inner(from, to, tmp_dir);
    // 途中で失敗しても一時フォルダを残さない
    let _ = jsfs::rm_rf(tmp_dir);
    r
}

fn copy_sqlite_inner(from: &Path, to: &Path, tmp_dir: &Path) -> Result<u32> {
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // -wal を先に取る(後から取る本体は同じかより新しいページを持つ)
    let parts = [with_suffix(from, "-wal"), from.to_path_buf()];
    let mut last_problem = String::new();
    for attempt in 1..=SQLITE_COPY_ATTEMPTS {
        jsfs::rm_rf(tmp_dir)?;
        fs::create_dir_all(tmp_dir)?;
        let present: Vec<&PathBuf> = parts.iter().filter(|p| jsfs::exists(p)).collect();
        let step = || -> io::Result<bool> {
            let before = present.iter().map(|p| fingerprint(p)).collect::<io::Result<Vec<_>>>()?;
            for p in &present {
                fs::copy(p, tmp_dir.join(p.file_name().unwrap_or_default()))?;
            }
            let after = present.iter().map(|p| fingerprint(p)).collect::<io::Result<Vec<_>>>()?;
            Ok(before != after)
        };
        let changed = match step() {
            Ok(c) => {
                if c {
                    last_problem = "コピー中に元が更新された".into();
                }
                c
            }
            Err(e) if jsfs::is_not_found(&e) => {
                last_problem = "コピー中に元のファイルが消えた".into();
                true
            }
            Err(e) => return Err(e.into()),
        };
        if changed {
            std::thread::sleep(Duration::from_millis(200 * attempt as u64));
            continue;
        }
        let copy = tmp_dir.join(&name);
        let fresh = tmp_dir.join(format!("{name}.vacuum"));
        let mut broken = false;
        {
            // 複製側なので書けてよい(-shm は複製側に作られる)
            let db = sqlite::open_writable(&copy)?;
            let qc: Vec<String> = db.prepare("PRAGMA quick_check")?.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?;
            if qc.len() != 1 || qc[0] != "ok" {
                last_problem = format!("quick_check: {}", slice_utf16(&qc.join("; "), 200));
                broken = true;
            } else {
                jsfs::rm_force(&fresh)?;
                db.execute_batch(&format!("VACUUM INTO {}", sqlite::sql_string(&fresh.to_string_lossy())))?;
            }
        }
        if broken {
            std::thread::sleep(Duration::from_millis(200 * attempt as u64));
            continue;
        }
        crate::fs_retry::rename_replacing(&fresh, to)?;
        return Ok(attempt);
    }
    Err(anyhow!("{} を一貫した状態で複製できなかった({SQLITE_COPY_ATTEMPTS} 回): {last_problem}", from.display()))
}

/// 複製した session.db の元の指紋(サイズと mtime)。同じなら次回は複製し直さない
pub(super) const SESSION_DB_FINGERPRINT: &str = ".session.db.src";

/// session.db を複製する(copy_sqlite と同じく、元の本体と -wal をバイト列でコピーしてから複製側で VACUUM INTO)。
/// 元の指紋(本体と -wal のサイズ・mtime)が前回と同じなら複製し直さない。複製したら true
pub(super) fn copy_session_db(from: &Path, to: &Path, tmp_dir: &Path) -> Result<bool> {
    let fp_path = to.parent().unwrap_or(Path::new(".")).join(SESSION_DB_FINGERPRINT);
    let fp = [from.to_path_buf(), with_suffix(from, "-wal")].iter().filter(|p| jsfs::exists(p)).map(|p| fingerprint(p)).collect::<io::Result<Vec<_>>>()?.join("|");
    if jsfs::exists(to) && jsfs::exists(&fp_path) && fs::read_to_string(&fp_path)? == fp {
        return Ok(false);
    }
    copy_sqlite(from, to, tmp_dir)?;
    fs::write(&fp_path, fp)?;
    Ok(true)
}

/// files のどれかが since 以降に更新されたか(無いファイルは飛ばす)
pub(super) fn is_updated_since(dir: &Path, files: &[String], since_ms: i64) -> io::Result<bool> {
    for f in files {
        match fs::metadata(dir.join(f)) {
            Ok(m) => {
                if jsfs::date_ms(jsfs::mtime_ms(&m)) >= since_ms {
                    return Ok(true);
                }
            }
            Err(e) if jsfs::is_not_found(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::slice_utf16;

    #[test]
    fn slices_like_js() {
        assert_eq!(slice_utf16("abc", 2), "ab");
        assert_eq!(slice_utf16("a😀b", 2), "a");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
    }
}
