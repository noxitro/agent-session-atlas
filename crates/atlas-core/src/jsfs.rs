//! Node の fs・path と同じ結果にするための小道具(TS 版と出力を同じにするため)。
//!
//! - readdir の順と種類: Node(libuv)は Windows ではファイルシステムが返す順のまま、ほかでは名前のバイト順に並べる。
//!   種類は、Windows では再解析ポイント(シンボリックリンク・ジャンクションなど)をリンク、それ以外をフォルダかファイルとみなす。
//! - mtimeMs: `sec * 1000 + nsec / 1e6`(Node の Stats と同じ式)。`stat.mtime`(Date)はそれを丸めたもの。
//! - エラーのコード: libuv が OS のエラーから決める名前(EBUSY・EPERM など)。

use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// readdir の withFileTypes の種類
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    Other,
}

/// readdir の 1 件(Node の Dirent)
#[derive(Debug, Clone)]
pub struct Dirent {
    pub name: String,
    pub kind: Kind,
}

impl Dirent {
    pub fn is_file(&self) -> bool {
        self.kind == Kind::File
    }
    pub fn is_dir(&self) -> bool {
        self.kind == Kind::Dir
    }
    pub fn is_link(&self) -> bool {
        self.kind == Kind::Link
    }
}

#[cfg(windows)]
fn kind_of(e: &fs::DirEntry) -> io::Result<Kind> {
    use std::os::windows::fs::MetadataExt;
    // libuv の fs__scandir と同じ: 再解析ポイントはリンク、フォルダの属性があればフォルダ、ほかはファイル
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let a = e.metadata()?.file_attributes();
    Ok(if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Kind::Link
    } else if a & FILE_ATTRIBUTE_DIRECTORY != 0 {
        Kind::Dir
    } else {
        Kind::File
    })
}

#[cfg(not(windows))]
fn kind_of(e: &fs::DirEntry) -> io::Result<Kind> {
    let t = e.file_type()?;
    Ok(if t.is_symlink() {
        Kind::Link
    } else if t.is_dir() {
        Kind::Dir
    } else if t.is_file() {
        Kind::File
    } else {
        Kind::Other
    })
}

/// `readdir(dir, { withFileTypes: true })`。順は Node と同じ(Windows はファイルシステムの順、ほかは名前のバイト順)
pub fn read_dir(dir: &Path) -> io::Result<Vec<Dirent>> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir)? {
        let e = e?;
        let kind = kind_of(&e)?;
        out.push(Dirent { name: e.file_name().to_string_lossy().into_owned(), kind });
    }
    if !cfg!(windows) {
        out.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    }
    Ok(out)
}

/// `readdir(dir)`(名前だけ)
pub fn read_dir_names(dir: &Path) -> io::Result<Vec<String>> {
    Ok(read_dir(dir)?.into_iter().map(|e| e.name).collect())
}

fn time_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0,
        Err(e) => {
            let d = e.duration();
            -(d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0)
        }
    }
}

/// `stat.mtimeMs`
pub fn mtime_ms(m: &Metadata) -> f64 {
    m.modified().map(time_ms).unwrap_or(0.0)
}

/// `stat.atimeMs`
pub fn atime_ms(m: &Metadata) -> f64 {
    m.accessed().map(time_ms).unwrap_or(0.0)
}

/// `stat.mtime`(Date)の時刻値: Node は mtimeMs を Math.round で丸めて Date にする
pub fn date_ms(ms: f64) -> i64 {
    (ms + 0.5).floor() as i64
}

/// `stat.mtime.toISOString()`
pub fn mtime_iso(m: &Metadata) -> String {
    crate::jsdate::to_iso(date_ms(mtime_ms(m)))
}

/// ミリ秒の時刻値を SystemTime に
pub fn system_time(ms: i64) -> SystemTime {
    if ms >= 0 { UNIX_EPOCH + Duration::from_millis(ms as u64) } else { UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs()) }
}

/// `fs.utimes(p, atime, mtime)`(Date を渡したときと同じく、ミリ秒の精度で書く)。
/// Windows では libuv と同じく属性の書き込みだけで開く(読み取り専用のファイルでも書ける)
pub fn utimes(p: &Path, atime_ms: i64, mtime_ms: i64) -> io::Result<()> {
    let mut o = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        o.access_mode(FILE_WRITE_ATTRIBUTES);
    }
    #[cfg(not(windows))]
    o.write(true);
    let f = o.open(p)?;
    f.set_times(fs::FileTimes::new().set_accessed(system_time(atime_ms)).set_modified(system_time(mtime_ms)))
}

/// `existsSync(p)`(リンクは辿る)
pub fn exists(p: &Path) -> bool {
    fs::metadata(p).is_ok()
}

/// `fs.promises.access(p)` が通るか。Windows の libuv は GetFileAttributesW で確かめるので、最後のリンクは辿らない
/// (指す先の無いリンクもあるとみなす)。ほかでは辿る
pub fn access_exists(p: &Path) -> bool {
    if cfg!(windows) { fs::symlink_metadata(p).is_ok() } else { fs::metadata(p).is_ok() }
}

/// io::Error が「無い」(ENOENT)か
pub fn is_not_found(e: &io::Error) -> bool {
    code(e) == "ENOENT"
}

/// anyhow::Error の元が「無い」(ENOENT)の io::Error か
pub fn is_not_found_any(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<io::Error>().is_some_and(is_not_found))
}

/// `rm(p, { force: true })`(ファイル 1 つ。無ければ何もしない)
pub fn rm_force(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Err(e) if is_not_found(&e) => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() && !m.is_symlink() => Err(io::Error::other(format!("Path is a directory: rm returned EISDIR (is a directory) {}", p.display()))),
        Ok(m) => remove_link_or_file(p, &m),
    }
}

fn remove_link_or_file(p: &Path, m: &Metadata) -> io::Result<()> {
    match fs::remove_file(p) {
        // Windows のフォルダへのリンク・ジャンクションは remove_dir で消す
        Err(e) if m.is_symlink() => fs::remove_dir(p).map_err(|_| e),
        r => r,
    }
}

/// `rm(p, { recursive: true, force: true })`(リンクは辿らずリンクだけを消す)
pub fn rm_rf(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Err(e) if is_not_found(&e) => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_symlink() => remove_link_or_file(p, &m),
        Ok(m) if m.is_dir() => match fs::remove_dir_all(p) {
            Err(e) if is_not_found(&e) => Ok(()),
            r => r,
        },
        Ok(m) => remove_link_or_file(p, &m),
    }
}

/// Windows の canonicalize が付ける \\?\ を外す(Node の realpath と同じ書き方にする)
pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// `fs.realpath(p)`
pub fn realpath(p: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(p).map(strip_verbatim)
}

/// Node の path.resolve 相当(カレントディレクトリからの絶対パスにし、. と .. を畳む。末尾の区切りは落とす。ファイルシステムは見ない)
pub fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.relative(from, to)` のうち、to が from の下にあるとき(区切りは /)。下に無ければ to をそのまま / 区切りで
pub fn rel_slash(from: &Path, to: &Path) -> String {
    let r = to.strip_prefix(from).map(Path::to_path_buf).unwrap_or_else(|_| to.to_path_buf());
    r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// / 区切りの相対パスを base の下のパスにする(`join(base, ...rel.split('/'))`)
pub fn join_slash(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() && part != "." {
            p.push(part);
        }
    }
    p
}

/// libuv が付けるエラーのコード(`err.code`)。分からないものは UNKNOWN
pub fn code(e: &io::Error) -> String {
    if let Some(n) = e.raw_os_error() {
        if let Some(c) = os_code(n) {
            return c.to_string();
        }
    }
    use io::ErrorKind as K;
    match e.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => {
            if cfg!(windows) {
                "EPERM"
            } else {
                "EACCES"
            }
        }
        K::AlreadyExists => "EEXIST",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::NotADirectory => "ENOTDIR",
        K::IsADirectory => "EISDIR",
        K::ResourceBusy => "EBUSY",
        K::StorageFull => "ENOSPC",
        K::ReadOnlyFilesystem => "EROFS",
        K::InvalidInput => "EINVAL",
        _ => "UNKNOWN",
    }
    .to_string()
}

#[cfg(windows)]
fn os_code(n: i32) -> Option<&'static str> {
    // libuv の uv_translate_sys_error(src/win/error.c)のうち、ファイルの操作で出るもの
    Some(match n {
        2 | 3 | 15 | 53 | 67 | 123 | 161 | 1231 => "ENOENT",
        4 => "EMFILE",
        5 | 1314 => "EPERM",
        17 => "EXDEV",
        19 => "EROFS",
        21 => "EAGAIN",
        32 | 33 | 170 => "EBUSY",
        39 | 112 => "ENOSPC",
        64 => "ECONNRESET",
        80 | 183 => "EEXIST",
        87 | 4390 => "EINVAL",
        145 => "ENOTEMPTY",
        206 => "ENAMETOOLONG",
        267 => "ENOTDIR",
        1117 => "EIO",
        1920 => "EACCES",
        1921 => "ELOOP",
        _ => return None,
    })
}

#[cfg(not(windows))]
fn os_code(n: i32) -> Option<&'static str> {
    Some(match n {
        1 => "EPERM",
        2 => "ENOENT",
        5 => "EIO",
        11 => "EAGAIN",
        13 => "EACCES",
        16 => "EBUSY",
        17 => "EEXIST",
        18 => "EXDEV",
        20 => "ENOTDIR",
        21 => "EISDIR",
        22 => "EINVAL",
        23 => "ENFILE",
        24 => "EMFILE",
        28 => "ENOSPC",
        30 => "EROFS",
        36 => "ENAMETOOLONG",
        39 | 66 => "ENOTEMPTY",
        40 | 62 => "ELOOP",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_rounds_like_node() {
        assert_eq!(date_ms(1.4), 1);
        assert_eq!(date_ms(1.5), 2);
        assert_eq!(date_ms(-2.5), -2);
    }

    #[test]
    fn resolve_like_node() {
        let base = if cfg!(windows) { PathBuf::from(r"C:\a") } else { PathBuf::from("/a") };
        assert_eq!(resolve(&base.join("b").join("..").join("c")), base.join("c"));
        let with_sep = PathBuf::from(format!("{}{}", base.join("b").display(), std::path::MAIN_SEPARATOR));
        assert_eq!(resolve(&with_sep), base.join("b"));
    }

    #[test]
    fn utimes_works_on_read_only_files() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("ro.txt");
        fs::write(&p, "x").unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&p, perm.clone()).unwrap();
        let r = utimes(&p, 1_600_000_000_123, 1_600_000_000_456);
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&p, perm).unwrap();
        r.unwrap();
        assert_eq!(date_ms(mtime_ms(&fs::metadata(&p).unwrap())), 1_600_000_000_456);
    }

    #[test]
    fn rel_and_join() {
        let base = PathBuf::from("root");
        let p = base.join("a").join("b");
        assert_eq!(rel_slash(&base, &p), "a/b");
        assert_eq!(join_slash(&base, "a/b"), p);
        assert_eq!(join_slash(&base, "."), base);
    }
}
