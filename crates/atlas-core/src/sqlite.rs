//! SQLite を開く(packages/core/src/sqlite.ts の移植)。元データ(~/.copilot)の DB は開かず、snapshot が写したものを開く。
//! TS 版は node:sqlite(DatabaseSync)。Rust 版は rusqlite(SQLite を同梱)。

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// 読み取り専用で開く(写したもの・出力を読むとき)
pub fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)
}

/// 書ける形で開く(無ければ作る)。元データには使わない(写した側・atlas が作るファイルだけ)
pub fn open_writable(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)
}

/// URI(`file:///…?immutable=1` など)で読み取り専用に開く
pub fn open_uri_read_only(uri: &str) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)
}

/// SQL 文字列リテラル用のエスケープ
pub fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Node の pathToFileURL(path).href と同じ形の file: URL(SQLite が解釈できるよう、区切り以外の記号と非 ASCII は %XX にする)
pub fn path_to_file_url(path: &Path) -> String {
    let s = path.to_string_lossy();
    let s = if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() };
    let mut out = String::from(if cfg!(windows) && !s.starts_with('/') { "file:///" } else { "file://" });
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-._~/:!$&'()*+,;=@".contains(&b);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_urls() {
        assert_eq!(sql_string("a'b"), "'a''b'");
        if cfg!(windows) {
            assert_eq!(path_to_file_url(Path::new(r"C:\a b\データ.db")), "file:///C:/a%20b/%E3%83%87%E3%83%BC%E3%82%BF.db");
        } else {
            assert_eq!(path_to_file_url(Path::new("/a b/x#.db")), "file:///a%20b/x%23.db");
        }
    }
}
