//! 一時ファイルを本来の名前に置き換える rename(packages/core/src/fs-retry.ts の移植)。Windows では、置き換え先を別のプロセス
//! (ウイルス対策の検査や、同時に読んでいる側)が開いている間、rename が EPERM / EACCES / EBUSY で一時的に失敗する。
//! 少し待ってやり直す(graceful-fs の polyfills.js と同じ考え方)

use crate::jsfs;
use anyhow::{Result, anyhow};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// やり直しをあきらめるまでの合計の待ち時間(ms)
const RENAME_RETRY_MS: u64 = 3000;
const RETRY_CODES: [&str; 3] = ["EPERM", "EACCES", "EBUSY"];

type RenameFn<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

fn real_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

pub fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    rename_replacing_with(from, to, cfg!(windows), &real_rename)
}

/// rename_replacing の本体(テストで rename と OS を差し替える)
fn rename_replacing_with(from: &Path, to: &Path, windows: bool, rename: RenameFn<'_>) -> io::Result<()> {
    if !windows {
        return rename(from, to);
    }
    let start = Instant::now();
    let mut wait: u64 = 10;
    loop {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retry = RETRY_CODES.contains(&jsfs::code(&e).as_str());
                if !retry || start.elapsed().as_millis() as u64 + wait > RENAME_RETRY_MS {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(wait));
                wait = (wait * 2).min(200);
            }
        }
    }
}

/// やり直す種類のエラー(Node の rm の maxRetries と同じ)
fn retryable_rm(e: &io::Error) -> bool {
    matches!(jsfs::code(e).as_str(), "EBUSY" | "EMFILE" | "ENFILE" | "ENOTEMPTY" | "EPERM")
}

/// 前に作ったもの(フォルダーやファイル)を消す。ほかのプログラム(ウイルス対策・検索の索引・開いたままのアプリ)がファイルを一時的に
/// 掴んでいると Windows では EBUSY / EPERM / ENOTEMPTY になるので、少し待ってやり直す。無ければ何もしない。
/// (TS 版の `rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })`)
pub fn remove_tree(path: &Path) -> io::Result<()> {
    let mut attempt: u64 = 0;
    loop {
        match jsfs::rm_rf(path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 3 && retryable_rm(&e) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(100 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 作りかけを置く場所と、入れ替えの間だけ前のものを退ける場所(どちらも dir の直下)
const SWAP_STAGE: &str = ".next";
const SWAP_PREV: &str = ".prev";

/// dir の直下の決まった名前(names)を作り直す。build に渡す作りかけの場所へ全部を作り終えてから、前のものと入れ替える。
/// names に無いものには触らない(dir は利用者が指定した既存のフォルダーかもしれないので、フォルダーごとは置き換えない)。
/// - build が失敗したり、途中でプロセスが止められたりしても、前のものはそのまま使える(作りかけは消す。残っても次に作るときに消す)
/// - 作りかけの場所に無い名前は、前のものを消すだけになる
/// - names の先頭は一覧(それがあれば「できている」と読まれるファイル)。最初に退けて最後に入れるので、入れ替えの途中でプロセスが
///   止まっても「一覧はあるのに、それが指すファイルが無い・古い」にはならない
/// - 前のものを退けられない(ほかのアプリが中のファイルを開いている、書き込めない)ときは、退けた分を戻してから投げる
pub fn replace_entries<T>(dir: &Path, names: &[&str], build: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    replace_entries_with(dir, names, build, &|f, t| rename_replacing(f, t))
}

fn replace_entries_with<T>(dir: &Path, names: &[&str], build: impl FnOnce(&Path) -> Result<T>, rename: RenameFn<'_>) -> Result<T> {
    let stage = dir.join(SWAP_STAGE);
    let prev = dir.join(SWAP_PREV);
    remove_tree(&stage)?;
    remove_tree(&prev)?;
    fs::create_dir_all(&stage)?;
    let r = build(&stage).and_then(|result| swap(dir, &stage, &prev, names, rename).map(|()| result));
    // 作りかけ(入れ替えで残った空のフォルダーも)は、成功でも失敗でも残さない
    let _ = remove_tree(&stage);
    r
}

fn swap(dir: &Path, stage: &Path, prev: &Path, names: &[&str], rename: RenameFn<'_>) -> Result<()> {
    fs::create_dir_all(prev)?;
    let mut out: Vec<&str> = Vec::new();
    let mut moved: Vec<&str> = Vec::new();
    let mut step = || -> io::Result<()> {
        for n in names {
            if !jsfs::exists(&dir.join(n)) {
                continue;
            }
            rename(&dir.join(n), &prev.join(n))?;
            out.push(n);
        }
        for n in names.iter().rev() {
            if !jsfs::exists(&stage.join(n)) {
                continue;
            }
            rename(&stage.join(n), &dir.join(n))?;
            moved.push(n);
        }
        Ok(())
    };
    if let Err(e) = step() {
        // 元に戻す: 入れた新しいものを作りかけの場所へ返し、退けた前のものを戻す(一覧は最後)
        let mut restored = true;
        for n in moved.iter().rev() {
            if fs::rename(dir.join(n), stage.join(n)).is_err() {
                restored = false;
            }
        }
        for n in out.iter().rev() {
            if fs::rename(prev.join(n), dir.join(n)).is_err() {
                restored = false;
            }
        }
        if restored {
            let _ = remove_tree(prev);
        }
        let kept = if restored { "前の内容はそのまま残しています".to_string() } else { format!("前の内容を戻しきれませんでした(一部は {} にあります)", prev.display()) };
        return Err(anyhow!(
            "{} の中身を置き換えられません({e})。ほかのアプリがその中のファイルを開いたままにしていないか、書き込める場所かを確かめてください。{kept}",
            dir.display()
        ));
    }
    // 片付けは失敗しても入れ替えは済んでいる(残りは次に作るときに消す)
    let _ = remove_tree(prev);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;

    fn fail(code: &str) -> io::Error {
        // Display が code だけのエラー(TS のテストの fail(code) と同じ)。種類は code に合わせる
        let kind = match code {
            "ENOENT" => io::ErrorKind::NotFound,
            "EBUSY" => io::ErrorKind::ResourceBusy,
            _ => io::ErrorKind::PermissionDenied,
        };
        io::Error::new(kind, code.to_string())
    }

    #[test]
    fn windows_retries_transient_errors() {
        let calls = Cell::new(0);
        let seq = ["EPERM", "EPERM", "EBUSY"];
        let r = rename_replacing_with(Path::new("a.tmp"), Path::new("a"), true, &|_, _| {
            let i = calls.get();
            calls.set(i + 1);
            if i < seq.len() { Err(fail(seq[i])) } else { Ok(()) }
        });
        assert!(r.is_ok());
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn non_retryable_errors_throw_at_once() {
        let calls = Cell::new(0);
        let r = rename_replacing_with(Path::new("a.tmp"), Path::new("a"), true, &|_, _| {
            calls.set(calls.get() + 1);
            Err(fail("ENOENT"))
        });
        assert_eq!(r.unwrap_err().to_string(), "ENOENT");
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn no_retry_outside_windows() {
        let calls = Cell::new(0);
        let r = rename_replacing_with(Path::new("a.tmp"), Path::new("a"), false, &|_, _| {
            calls.set(calls.get() + 1);
            Err(fail("EPERM"))
        });
        assert_eq!(r.unwrap_err().to_string(), "EPERM");
        assert_eq!(calls.get(), 1);
    }

    const NAMES: [&str; 3] = ["manifest.json", "parts", "extra.md"];

    fn write(stage: &Path, tag: &str) -> Result<String> {
        fs::create_dir(stage.join("parts"))?;
        fs::write(stage.join("parts").join(format!("{tag}.md")), tag)?;
        fs::write(stage.join("manifest.json"), tag)?;
        Ok(tag.to_string())
    }

    fn sorted(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn read(p: PathBuf) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn swaps_in_built_entries_and_leaves_others() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        fs::write(d.join("memo.txt"), "利用者のファイル").unwrap();
        fs::write(d.join("extra.md"), "前の版だけにある").unwrap();
        assert_eq!(replace_entries(d, &NAMES, |s| write(s, "v1")).unwrap(), "v1");
        assert_eq!(sorted(d), ["manifest.json", "memo.txt", "parts"]);
        replace_entries(d, &NAMES, |s| write(s, "v2")).unwrap();
        assert_eq!(read(d.join("manifest.json")), "v2");
        assert_eq!(sorted(&d.join("parts")), ["v2.md"]);
        assert_eq!(sorted(d), ["manifest.json", "memo.txt", "parts"]);
    }

    #[test]
    fn build_failure_keeps_previous() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        replace_entries(d, &NAMES, |s| write(s, "v1")).unwrap();
        let e = replace_entries(d, &NAMES, |s| -> Result<String> {
            write(s, "v2")?;
            Err(anyhow!("途中で止まった"))
        })
        .unwrap_err();
        assert_eq!(e.to_string(), "途中で止まった");
        assert_eq!(read(d.join("manifest.json")), "v1");
        assert_eq!(sorted(&d.join("parts")), ["v1.md"]);
        assert_eq!(sorted(d), ["manifest.json", "parts"]);
    }

    #[test]
    fn move_out_failure_restores() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().to_path_buf();
        replace_entries(&d, &NAMES, |s| write(s, "v1")).unwrap();
        // 一覧は退けられるが、parts を退けるところで失敗する
        let parts = d.join("parts");
        let rename = |f: &Path, to: &Path| if f == parts && to.file_name().is_some_and(|n| n == "parts") { Err(fail("EBUSY")) } else { fs::rename(f, to) };
        let e = replace_entries_with(&d, &NAMES, |s| write(s, "v2"), &rename).unwrap_err().to_string();
        assert!(e.contains("の中身を置き換えられません(EBUSY)。ほかのアプリが"), "{e}");
        assert!(e.ends_with("前の内容はそのまま残しています"), "{e}");
        assert_eq!(read(d.join("manifest.json")), "v1");
        assert_eq!(sorted(&d.join("parts")), ["v1.md"]);
        assert_eq!(sorted(&d), ["manifest.json", "parts"]);
    }

    #[test]
    fn move_in_failure_restores() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().to_path_buf();
        replace_entries(&d, &NAMES, |s| write(s, "v1")).unwrap();
        // 作りかけの場所から入れるのは parts → manifest.json の順。2 つ目(一覧)で失敗させる
        let staged = d.join(".next").join("manifest.json");
        let rename = |f: &Path, to: &Path| if f == staged { Err(fail("EACCES")) } else { fs::rename(f, to) };
        let e = replace_entries_with(&d, &NAMES, |s| write(s, "v2"), &rename).unwrap_err().to_string();
        assert!(e.ends_with("前の内容はそのまま残しています"), "{e}");
        assert_eq!(read(d.join("manifest.json")), "v1");
        assert_eq!(sorted(&d.join("parts")), ["v1.md"]);
        assert_eq!(sorted(&d), ["manifest.json", "parts"]);
    }

    #[test]
    fn leftovers_are_cleaned_next_time() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        fs::create_dir_all(d.join(".next").join("parts")).unwrap();
        fs::write(d.join(".next").join("parts").join("old.md"), "残り").unwrap();
        fs::create_dir(d.join(".prev")).unwrap();
        fs::write(d.join(".prev").join("manifest.json"), "残り").unwrap();
        replace_entries(d, &NAMES, |s| write(s, "v1")).unwrap();
        assert_eq!(sorted(d), ["manifest.json", "parts"]);
        assert_eq!(sorted(&d.join("parts")), ["v1.md"]);
    }

    #[test]
    fn remove_tree_removes_and_ignores_missing() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        fs::create_dir_all(a.join("b")).unwrap();
        fs::write(a.join("b").join("c.txt"), "").unwrap();
        remove_tree(&a).unwrap();
        remove_tree(&a).unwrap();
        assert!(!a.exists());
    }
}
