//! snapshot の振る舞いを決めているテスト(packages/core/test/snapshot.test.ts と upload-read.test.ts の snapshot の部分の移植)。

use super::*;
use crate::sqlite::{open_read_only, open_writable};
use serde_json::json;
use std::collections::BTreeMap;

const EVENT: &str = "{\"type\":\"session.start\",\"data\":{\"sessionId\":\"x\",\"version\":1},\"id\":\"e1\",\"timestamp\":\"2026-07-02T09:00:00.000Z\",\"parentId\":null}\n";

fn work() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("atlas-snap-").tempdir().unwrap()
}

/// セッションのフォルダ(events.jsonl と、渡されたファイル)を作る
fn session(dir: &Path, files: &[(&str, &str)]) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("events.jsonl"), EVENT).unwrap();
    for (name, text) in files {
        fs::write(dir.join(name), text).unwrap();
    }
}

fn snap(src: &Path, dest: &Path) -> Result<SnapshotManifest> {
    snapshot(src, dest, &SnapshotOptions::default())
}

fn mtimes(dir: &Path) -> BTreeMap<PathBuf, f64> {
    let mut out = BTreeMap::new();
    fn rec(d: &Path, out: &mut BTreeMap<PathBuf, f64>) {
        for e in fs::read_dir(d).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            if e.file_type().unwrap().is_dir() {
                rec(&p, out);
            } else {
                out.insert(p.clone(), jsfs::mtime_ms(&fs::metadata(&p).unwrap()));
            }
        }
    }
    rec(dir, &mut out);
    out
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn skipped_with(m: &SnapshotManifest, reason: &str) -> Vec<String> {
    m.extras.as_ref().unwrap().skipped.iter().filter(|s| s.reason == reason).map(|s| s.path.clone()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn recovered(m: &SnapshotManifest) -> Option<Vec<(String, String)>> {
    m.extras.as_ref().unwrap().recovered.as_ref().map(|r| r.iter().map(|x| (x.id.clone(), x.path.clone())).collect())
}

fn meta(id: &str) -> String {
    json!({ "version": 1, "id": id }).to_string()
}

fn owners(m: &SnapshotManifest) -> Vec<(String, String)> {
    m.merged.as_ref().unwrap().owners.as_ref().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

fn set_mtime(p: &Path, iso: &str) {
    let t = jsdate::parse_ms(iso).unwrap();
    jsfs::utimes(p, t, t).unwrap();
}

/// ファイルへのシンボリックリンクを作る。作れない環境(Windows で権限が無い)なら false
fn link(target: &Path, path: &Path) -> bool {
    #[cfg(windows)]
    let r = std::os::windows::fs::symlink_file(target, path);
    #[cfg(not(windows))]
    let r = std::os::unix::fs::symlink(target, path);
    r.is_ok()
}

/// フォルダのジャンクション(Windows)かシンボリックリンクを作る。作れなければ false
fn dir_link(target: &Path, path: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(path).arg(target).output().is_ok_and(|o| o.status.success())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, path).is_ok()
    }
}

// ---------- snapshot.test.ts ----------

#[test]
fn copies_wal_rows_without_touching_source_and_skips_old_by_since() {
    let base = work();
    let src = base.path().join("src");
    let dest = base.path().join("dest");
    fs::create_dir_all(src.join("session-state").join("new")).unwrap();
    fs::create_dir_all(src.join("session-state").join("old")).unwrap();
    fs::create_dir_all(src.join("session-state").join("empty").join("files")).unwrap();
    fs::write(src.join("session-state").join("new").join("events.jsonl"), "{\"type\":\"x\"}\n").unwrap();
    fs::write(src.join("session-state").join("new").join("workspace.yaml"), "id: new\n").unwrap();
    fs::write(src.join("session-state").join("old").join("events.jsonl"), "{\"type\":\"x\"}\n").unwrap();
    set_mtime(&src.join("session-state").join("old").join("events.jsonl"), "2020-01-01T00:00:00Z");

    let w = open_writable(&src.join("session-store.db")).unwrap();
    let _: String = w.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).unwrap();
    w.execute_batch("PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('a'),('b');").unwrap();
    assert!(src.join("session-store.db-wal").exists());
    let before = mtimes(&src);
    let opts = SnapshotOptions { since: Some("2025-01-01T00:00:00Z".into()), ..Default::default() };
    let m = snapshot(&src, &dest, &opts).unwrap();
    assert_eq!(mtimes(&src), before);
    assert_eq!((m.sessions.dirs, m.sessions.skipped_by_since, m.sessions.copied_files), (1, 1, 2));
    assert!(!dest.join("session-state").join("old").exists());
    assert!(!dest.join("session-state").join("empty").exists());
    let r = open_read_only(&dest.join("session-store.db")).unwrap();
    assert_eq!(r.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(r.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap(), "delete");
    drop(r);
    // 2 回目は変わっていないファイルを再利用する
    let m2 = snapshot(&src, &dest, &opts).unwrap();
    assert_eq!((m2.sessions.copied_files, m2.sessions.reused_files), (0, 2));
    drop(w);
}

#[test]
fn data_db_is_not_copied_and_stale_copy_is_removed() {
    let base = work();
    let src = base.path().join("src");
    let dest = base.path().join("dest");
    fs::create_dir_all(src.join("session-state")).unwrap();
    fs::create_dir_all(&dest).unwrap();
    fs::write(src.join("data.db"), "not read").unwrap();
    fs::write(dest.join("data.db"), "stale copy").unwrap();
    let before = mtimes(&src);
    let m = snap(&src, &dest).unwrap();
    assert_eq!(mtimes(&src), before);
    assert!(!dest.join("data.db").exists());
    assert!(!m.databases.contains_key("data.db"));
}

#[test]
fn session_store_failure_keeps_previous_copy() {
    let base = work();
    let src = base.path().join("src");
    let dest = base.path().join("dest");
    session(&src.join("session-state").join("s1"), &[]);
    let w = open_writable(&src.join("session-store.db")).unwrap();
    w.execute_batch("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('a');").unwrap();
    drop(w);
    assert!(snap(&src, &dest).unwrap().databases["session-store.db"].copied);
    // 元が SQLite として読めなくなった(書きかけ・壊れた)
    fs::write(src.join("session-store.db"), "x".repeat(4096)).unwrap();
    let m = snap(&src, &dest).unwrap();
    let d = &m.databases["session-store.db"];
    assert!(!d.copied);
    assert!(d.error.as_deref().is_some_and(|e| !e.is_empty()));
    assert!(d.bytes > 0);
    assert_eq!(m.sessions.dirs, 1);
    let r = open_read_only(&dest.join("session-store.db")).unwrap();
    assert_eq!(r.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    drop(r);
    assert!(!dest.join(".tmp-sqlite").exists());
}

#[test]
fn parallel_copy_keeps_counts_and_order_and_leaves_no_temp() {
    let base = work();
    let src = base.path().join("src");
    let dest = base.path().join("dest");
    // 並べる数(SNAPSHOT_CONCURRENCY)より多いセッション。9 件おきに session.db(並べて動かす枠より多い 6 件)、5 件おきに写さない名前のフォルダを置く
    let ids: Vec<String> = (0..SNAPSHOT_CONCURRENCY * 3 + 5).map(|i| format!("s{i:03}")).collect();
    for (i, id) in ids.iter().enumerate() {
        let dir = src.join("session-state").join(id);
        fs::create_dir_all(dir.join("files")).unwrap();
        fs::write(dir.join("events.jsonl"), format!("{{\"type\":\"x\",\"i\":{i}}}\n")).unwrap();
        fs::write(dir.join("files").join("a.txt"), id).unwrap();
        if i % 9 == 0 {
            let db = open_writable(&dir.join("session.db")).unwrap();
            db.execute_batch(&format!("CREATE TABLE todos(id TEXT); INSERT INTO todos VALUES ('{id}');")).unwrap();
        }
        if i % 5 == 0 {
            fs::create_dir(dir.join("unknown-dir")).unwrap();
        }
    }
    let with_db = ids.iter().enumerate().filter(|(i, _)| i % 9 == 0).count() as u64;
    let m = snap(&src, &dest).unwrap();
    assert_eq!((m.sessions.dirs, m.sessions.copied_files, m.sessions.db_copied), (ids.len() as u64, ids.len() as u64, Some(with_db)));
    let x = m.extras.as_ref().unwrap();
    assert_eq!(x.session_files, ids.len() as u64);
    let want: Vec<String> = ids.iter().enumerate().filter(|(i, _)| i % 5 == 0).map(|(_, id)| format!("session-state/{id}/unknown-dir")).collect();
    assert_eq!(x.skipped.iter().map(|s| s.path.clone()).collect::<Vec<_>>(), want);
    assert!(names(&dest).iter().all(|n| !n.starts_with(".tmp-sqlite")));
    let r = open_read_only(&dest.join("session-state").join(&ids[9]).join("session.db")).unwrap();
    assert_eq!(r.query_row("SELECT id FROM todos", [], |r| r.get::<_, String>(0)).unwrap(), ids[9]);
    drop(r);
    let again = snap(&src, &dest).unwrap();
    assert_eq!((again.sessions.copied_files, again.sessions.reused_files, again.sessions.db_copied, again.sessions.db_reused), (0, ids.len() as u64, Some(0), Some(with_db)));
}

#[test]
fn missing_source_is_an_error() {
    let base = work();
    let e = snap(&base.path().join("atlas-no-such-dir-xyz"), &base.path().join("atlas-x")).unwrap_err();
    assert!(e.to_string().contains("元ディレクトリが無い"));
}

// ---------- upload-read.test.ts(snapshot の部分) ----------

#[test]
fn stops_when_dest_was_made_from_another_source() {
    let base = work();
    let a = base.path().join("logs").join("group-a");
    let b = base.path().join("logs").join("group-b");
    let dest = base.path().join("out").join("snapshot");
    session(&a.join("sa"), &[]);
    session(&b.join("sb"), &[]);
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
    let e = snap(&b, &dest).unwrap_err().to_string();
    assert!(e.contains("別の場所") && e.contains("から集計したもの") && e.contains("--out"), "{e}");
    assert!(dest.join("session-state").join("sa").join("events.jsonl").exists());
    assert!(!dest.join("session-state").join("sb").exists());
    // 同じ場所(末尾の区切り・.. を含む書き方)は同じ元
    let with_sep = PathBuf::from(format!("{}{}", a.display(), std::path::MAIN_SEPARATOR));
    assert_eq!(snap(&with_sep, &dest).unwrap().sessions.dirs, 1);
    assert_eq!(snap(&a.join("..").join("group-a"), &dest).unwrap().sessions.dirs, 1);
    // 止めるときの文は、消すファイル(マニフェストと、始めたときの印)を両方挙げる。片方だけ消しても止まる
    let e = snap(&b, &dest).unwrap_err().to_string();
    assert!(e.contains(&format!("{} と {} を消してから", dest.join(SNAPSHOT_MANIFEST).display(), dest.join(SNAPSHOT_SOURCE).display())), "{e}");
    fs::remove_file(dest.join(SNAPSHOT_MANIFEST)).unwrap();
    assert!(snap(&b, &dest).unwrap_err().to_string().contains("別の場所"));
    // 両方を消せば(案内のとおり)、今の出力先を使い続けられる
    fs::remove_file(dest.join(SNAPSHOT_SOURCE)).unwrap();
    assert_eq!(snap(&b, &dest).unwrap().sessions.dirs, 1);
    // 読めないマニフェスト・印は無いものとして扱う(止めない)
    fs::write(dest.join(SNAPSHOT_MANIFEST), "{broken").unwrap();
    fs::write(dest.join(SNAPSHOT_SOURCE), "[1]").unwrap();
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
}

fn source_root(p: &Path) -> String {
    serde_json::from_str::<Value>(&fs::read_to_string(p).unwrap()).unwrap()["sourceRoot"].as_str().unwrap().to_string()
}

#[test]
fn empty_previous_snapshot_can_switch_source() {
    let base = work();
    let empty = base.path().join("logs").join("empty");
    let a = base.path().join("logs").join("group-a");
    let b = base.path().join("logs").join("group-b");
    let dest = base.path().join("out").join("snapshot");
    fs::create_dir_all(&empty).unwrap();
    session(&a.join("sa"), &[]);
    session(&b.join("sb"), &[]);
    assert_eq!(snap(&empty, &dest).unwrap().sessions.dirs, 0);
    assert_eq!(source_root(&dest.join(SNAPSHOT_MANIFEST)), empty.to_string_lossy());
    // 0 件だった集計の印は消して、今の元のものに書き直す
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
    assert_eq!(source_root(&dest.join(SNAPSHOT_MANIFEST)), a.to_string_lossy());
    assert_eq!(source_root(&dest.join(SNAPSHOT_SOURCE)), a.to_string_lossy());
    // 写したものがある出力先は、今までどおり止める
    assert!(snap(&b, &dest).unwrap_err().to_string().contains("別の場所"));
    assert!(!dest.join("session-state").join("sb").exists());
    // 0 件のまま途中で止まった集計(印だけがある)の後も同じ
    let dest2 = base.path().join("out2").join("snapshot");
    snap(&empty, &dest2).unwrap();
    fs::remove_file(dest2.join(SNAPSHOT_MANIFEST)).unwrap();
    assert_eq!(snap(&b, &dest2).unwrap().sessions.dirs, 1);
    assert_eq!(source_root(&dest2.join(SNAPSHOT_SOURCE)), b.to_string_lossy());
}

#[test]
fn interrupted_snapshot_still_blocks_another_source() {
    let base = work();
    let a = base.path().join("logs").join("group-a");
    let b = base.path().join("logs").join("group-b");
    let dest = base.path().join("out").join("snapshot");
    session(&a.join("sa"), &[]);
    session(&b.join("sb"), &[]);
    snap(&a, &dest).unwrap();
    // 最後まで終わらなかった集計: 写したセッションと、始めたときの印だけがある
    fs::remove_file(dest.join(SNAPSHOT_MANIFEST)).unwrap();
    assert_eq!(source_root(&dest.join(SNAPSHOT_SOURCE)), a.to_string_lossy());
    assert!(snap(&b, &dest).unwrap_err().to_string().contains("から集計したもの"));
    assert!(!dest.join("session-state").join("sb").exists());
    // 同じ元なら続きから集計できる
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
}

#[test]
fn junction_to_same_place_is_same_source() {
    let base = work();
    let a = base.path().join("logs").join("group-a");
    let alias = base.path().join("alias");
    let dest = base.path().join("out").join("snapshot");
    session(&a.join("sa"), &[]);
    if !dir_link(&a, &alias) {
        eprintln!("ジャンクションを作れないので飛ばす");
        return;
    }
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
    assert_eq!(snap(&alias, &dest).unwrap().sessions.dirs, 1);
    assert_eq!(snap(&a, &dest).unwrap().sessions.dirs, 1);
    // 元が無くなった後は、書かれたパスのまま比べる(別のパスは別の元)
    let moved = base.path().join("logs").join("moved");
    session(&moved.join("sa"), &[]);
    jsfs::rm_rf(&alias).unwrap();
    fs::remove_dir_all(&a).unwrap();
    assert!(snap(&moved, &dest).unwrap_err().to_string().contains("別の場所"));
}

#[test]
fn recovers_from_finished_uploading_dir_only() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    let meta_p = |id: &str| json!({ "version": 1, "id": id, "project": "zz-owner/zz-app", "projectSource": "git-remote" }).to_string();
    session(&src.join("ok"), &[]);
    // s1: 前のフォルダを退けたところで止まった(新しいものは写し終えている) → 新しいものを使う
    session(&src.join(upload_old_name("s1")), &[]);
    session(&src.join(upload_tmp_name("s1")), &[(UPLOAD_SESSION_META, &meta_p("s1")), ("plan.md", "# 新しい\n")]);
    // s2: 退けた前のフォルダだけが残った → 使わない
    session(&src.join(upload_old_name("s2")), &[(UPLOAD_SESSION_META, &meta_p("s2")), ("plan.md", "# 前の\n")]);
    // s3: 初めて送っている途中(記録がまだ無い) → 使わない
    session(&src.join(upload_tmp_name("s3")), &[]);
    let m = snap(&src, &dest).unwrap();
    assert_eq!(m.sessions.dirs, 2);
    assert_eq!(recovered(&m), Some(pairs(&[("s1", ".s1.uploading")])));
    assert_eq!(sorted(skipped_with(&m, UPLOAD_WORK_REASON)), [".s1.old", ".s3.uploading"]);
    assert_eq!(skipped_with(&m, UPLOAD_OLD_ONLY_REASON), [".s2.old"]);
    assert_eq!(names(&dest.join("session-state")), ["ok", "s1"]);
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("plan.md")).unwrap(), "# 新しい\n");
    assert!(!dest.join("session-state").join("s2").exists());
    // 本体のフォルダが戻れば(送り直した)、作業用のフォルダは数えないだけ
    session(&src.join("s1"), &[]);
    session(&src.join("s2"), &[]);
    let again = snap(&src, &dest).unwrap();
    assert_eq!(recovered(&again), None);
    assert!(skipped_with(&again, UPLOAD_OLD_ONLY_REASON).is_empty());
    assert_eq!(again.sessions.dirs, 3);
}

#[test]
fn unusable_work_ids_are_not_written() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    session(&src.join("s1"), &[]);
    // 写し終えた形(記録まである)の作業用のフォルダ。id は順に「..」「.」「.x.old」「x (空白で終わる)」「x.(点で終わる)」
    let bad = ["..", ".", ".x.old", "x ", "x."];
    for id in bad {
        session(&src.join(upload_tmp_name(id)),&[(UPLOAD_SESSION_META, &meta(id)), ("plan.md", "# 外に出さない\n")]);
    }
    let m = snap(&src, &dest).unwrap();
    assert_eq!(m.sessions.dirs, 1);
    assert_eq!(recovered(&m), None);
    let mut want: Vec<String> = bad.iter().map(|id| upload_tmp_name(id)).collect();
    want.sort();
    assert_eq!(sorted(skipped_with(&m, UPLOAD_WORK_REASON)), want);
    // 出力先の session-state には s1 だけがあり、その外(出力先の直下・1 つ上)には何も写っていない
    assert_eq!(names(&dest.join("session-state")), ["s1"]);
    for dir in [dest.clone(), dest.join("session-state"), dest.join("..")] {
        for f in ["events.jsonl", "plan.md", UPLOAD_SESSION_META] {
            assert!(!dir.join(f).exists(), "{}", dir.join(f).display());
        }
    }
    assert_eq!(source_root(&dest.join(SNAPSHOT_SOURCE)), src.to_string_lossy());
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("events.jsonl")).unwrap(), EVENT);
}

#[test]
fn recovered_is_recorded_only_when_copied() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    session(&src.join(upload_tmp_name("s1")), &[(UPLOAD_SESSION_META, &meta("s1"))]);
    let m = snapshot(&src, &dest, &SnapshotOptions { since: Some("2999-01-01T00:00:00Z".into()), ..Default::default() }).unwrap();
    assert_eq!((m.sessions.dirs, m.sessions.skipped_by_since), (0, 1));
    assert_eq!(recovered(&m), None);
    assert!(!dest.join("session-state").join("s1").exists());
    // 期間に入っていれば写して、残す
    let all = snap(&src, &dest).unwrap();
    assert_eq!(all.sessions.dirs, 1);
    assert_eq!(recovered(&all), Some(pairs(&[("s1", ".s1.uploading")])));
}

#[test]
fn main_dir_with_only_links_blocks_recovery() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    fs::create_dir_all(src.join("abc")).unwrap();
    // 指す先の無いリンク(本体の events.jsonl)
    if !link(&base.path().join("gone.jsonl"), &src.join("abc").join("events.jsonl")) {
        eprintln!("シンボリックリンクを作れないので飛ばす");
        return;
    }
    session(&src.join(upload_tmp_name("abc")), &[(UPLOAD_SESSION_META, &meta("abc"))]);
    let m = snap(&src, &dest).unwrap();
    assert_eq!(m.sessions.dirs, 0);
    assert_eq!(recovered(&m), None);
    assert_eq!(skipped_with(&m, UPLOAD_WORK_REASON), [".abc.uploading"]);
    assert_eq!(skipped_with(&m, LINK_REASON), ["abc/events.jsonl"]);
    assert!(!dest.join("session-state").join("abc").exists());

    // まとめて読むとき: 先のフォルダの作業用のフォルダから写した後に、後のフォルダにリンクだけの本体があっても、写した複製は残る
    let root = base.path().join("logs2").join("person");
    let dest2 = base.path().join("out2").join("snapshot");
    for f in ["proj-a", "proj-b"] {
        fs::create_dir_all(root.join(f)).unwrap();
        fs::write(root.join(f).join(UPLOAD_INDEX), "{}").unwrap();
    }
    session(&root.join("proj-a").join(upload_tmp_name("abc")), &[(UPLOAD_SESSION_META, &meta("abc"))]);
    fs::create_dir(root.join("proj-b").join("abc")).unwrap();
    link(&base.path().join("gone.jsonl"), &root.join("proj-b").join("abc").join("events.jsonl"));
    let mm = snap(&root, &dest2).unwrap();
    assert_eq!(mm.layout, Some(SourceLayout::Merged));
    assert_eq!(mm.sessions.dirs, 1);
    assert_eq!(recovered(&mm), Some(pairs(&[("abc", "proj-a/.abc.uploading")])));
    assert_eq!(fs::read_to_string(dest2.join("session-state").join("abc").join("events.jsonl")).unwrap(), EVENT);
    assert_eq!(skipped_with(&mm, LINK_REASON), ["proj-b/abc/events.jsonl"]);
}

#[test]
fn work_dirs_are_not_counted() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    session(&src.join("s1"), &[]);
    session(&src.join(upload_old_name("s1")), &[]);
    session(&src.join(upload_tmp_name("s1")), &[]);
    fs::create_dir_all(src.join(upload_old_name("s2"))).unwrap(); // 空のものは記録もしない
    let m = snap(&src, &dest).unwrap();
    assert_eq!(m.layout, Some(SourceLayout::Flat));
    assert_eq!(m.sessions.dirs, 1);
    assert_eq!(sorted(skipped_with(&m, UPLOAD_WORK_REASON)), [".s1.old", ".s1.uploading"]);
    assert_eq!(names(&dest.join("session-state")), ["s1"]);
}

#[test]
fn work_dir_names() {
    assert!(is_upload_work_dir(&upload_old_name("abc-1")));
    assert!(is_upload_work_dir(&upload_tmp_name("abc-1")));
    for n in ["abc.old", "abc.uploading", ".old", ".uploading", ".git", "abc", ".abc.older"] {
        assert!(!is_upload_work_dir(n), "{n}");
    }
    // 作業用のフォルダの名前から、元のセッションの ID を取り出す(ID に点があっても)
    assert_eq!(upload_work_dir_id(&upload_old_name("abc-1")).as_deref(), Some("abc-1"));
    assert_eq!(upload_work_dir_id(&upload_tmp_name("a.b")).as_deref(), Some("a.b"));
    for n in ["abc.old", ".old", ".uploading", "abc"] {
        assert_eq!(upload_work_dir_id(n), None, "{n}");
    }
}

fn merged_of(v: &[&str]) -> SourceShape {
    SourceShape::Merged { folders: v.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn reads_upload_folders_side_by_side() {
    let base = work();
    let root = base.path().join("logs").join("person-a");
    let dest = base.path().join("out").join("snapshot");
    let m1 = json!({ "version": 1, "id": "s1", "project": "zz-owner/zz-b", "projectSource": "git-remote" }).to_string();
    session(&root.join("proj-b").join("s1"), &[(UPLOAD_SESSION_META, &m1)]);
    session(&root.join("proj-b").join("s2"), &[]);
    let m3 = json!({ "version": 1, "id": "s3", "project": "zz-owner/zz-c", "projectSource": "git-remote" }).to_string();
    session(&root.join("proj-c").join("s3"), &[(UPLOAD_SESSION_META, &m3)]);
    fs::create_dir_all(root.join("proj-a")).unwrap();
    fs::write(root.join("proj-a").join(UPLOAD_INDEX), "{}").unwrap(); // 索引だけがあるフォルダも、アップロードしたフォルダ
    fs::create_dir(root.join("other")).unwrap();
    assert_eq!(describe_source(&root), merged_of(&["proj-a", "proj-b", "proj-c"]));
    let m = snap(&root, &dest).unwrap();
    assert_eq!(m.layout, Some(SourceLayout::Merged));
    let mg = m.merged.as_ref().unwrap();
    assert_eq!((mg.folders.clone(), mg.duplicates), (vec!["proj-a".to_string(), "proj-b".into(), "proj-c".into()], 0));
    assert_eq!(owners(&m), pairs(&[("s1", "proj-b"), ("s2", "proj-b"), ("s3", "proj-c")]));
    assert_eq!(m.sessions.dirs, 3);
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2", "s3"]);
    // 直下のフォルダ(セッションの入れ物)は、~/.copilot の直下のフォルダとしては写さない
    assert!(m.extras.as_ref().unwrap().top_level.is_empty());
    // 2 度目も同じ(出力先は同じ元のもの)
    assert_eq!(snap(&root, &dest).unwrap().sessions.dirs, 3);
    // プロジェクトのフォルダ 1 つを指したときは、今までどおり直下を読む
    assert_eq!(describe_source(&root.join("proj-b")), SourceShape::Flat);
    // ~/.copilot の形は、下にたまたまセッションの形のフォルダがあっても、今までどおり
    let home = base.path().join("home");
    session(&home.join("session-state").join("s1"), &[]);
    session(&home.join("backup").join("s9"), &[]);
    assert_eq!(describe_source(&home), SourceShape::Copilot);
    let hm = snap(&home, &base.path().join("out-home")).unwrap();
    assert_eq!(hm.sessions.dirs, 1);
    assert_eq!(hm.layout, Some(SourceLayout::Copilot));
    assert!(hm.merged.is_none());
}

#[test]
fn duplicates_count_the_larger_events() {
    let base = work();
    let root = base.path().join("person-a");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("proj-a").join("s1"), &[]);
    session(&root.join("proj-b").join("s1"), &[]);
    fs::write(root.join("proj-b").join("s1").join("events.jsonl"), format!("{EVENT}{EVENT}")).unwrap(); // 後から送ったほう(続きがある)
    session(&root.join("proj-b").join("s2"), &[]);
    // 大きさが同じなら、名前の順で先のフォルダ
    session(&root.join("proj-a").join("s4"), &[("plan.md", "a")]);
    session(&root.join("proj-b").join("s4"), &[("plan.md", "b")]);
    // 本体が別のフォルダにあるセッションの消し残しは、作業用のフォルダから写さない
    session(&root.join("proj-a").join(upload_old_name("s2")), &[]);
    // 本体がどこにも無いセッションの、写し終えた作業用のフォルダが 2 つのフォルダにあれば、1 度だけ写す
    session(&root.join("proj-a").join(upload_tmp_name("s5")), &[(UPLOAD_SESSION_META, &meta("s5"))]);
    session(&root.join("proj-b").join(upload_tmp_name("s5")), &[(UPLOAD_SESSION_META, &meta("s5"))]);
    // 退けた前のフォルダだけが 2 つのフォルダにあるものは、どちらも写さない
    session(&root.join("proj-a").join(upload_old_name("s6")), &[]);
    session(&root.join("proj-b").join(upload_old_name("s6")), &[]);
    let m = snap(&root, &dest).unwrap();
    assert_eq!(m.sessions.dirs, 4);
    assert_eq!(m.merged.as_ref().unwrap().duplicates, 2);
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("events.jsonl")).unwrap(), format!("{EVENT}{EVENT}"));
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s4").join("plan.md")).unwrap(), "a");
    assert_eq!(skipped_with(&m, DUPLICATE_REASON), ["proj-a/s1", "proj-b/s4"]);
    assert_eq!(recovered(&m), Some(pairs(&[("s5", "proj-a/.s5.uploading")])));
    assert_eq!(skipped_with(&m, UPLOAD_OLD_ONLY_REASON), ["proj-a/.s6.old", "proj-b/.s6.old"]);
    assert!(!dest.join("session-state").join("s6").exists());
    assert_eq!(sorted(skipped_with(&m, UPLOAD_WORK_REASON)), ["proj-a/.s2.old", "proj-b/.s5.uploading"]);
    // 2 度目も、数えるほうは変わらない(数えなかったほうで上書きしない)
    snap(&root, &dest).unwrap();
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("events.jsonl")).unwrap(), format!("{EVENT}{EVENT}"));
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s4").join("plan.md")).unwrap(), "a");
}

#[test]
fn reads_two_levels_down() {
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[(UPLOAD_SESSION_META, &meta("s1")), ("atlas-memo.md", "# 送った人のメモ\n\n![図](atlas-memo/p.png)")]);
    fs::create_dir(root.join("person-a").join("proj-a").join("s1").join("atlas-memo")).unwrap();
    fs::write(root.join("person-a").join("proj-a").join("s1").join("atlas-memo").join("p.png"), "png").unwrap();
    session(&root.join("person-a").join("proj-b").join("s2"), &[]);
    session(&root.join("person-b").join("proj-a").join("s3"), &[(UPLOAD_SESSION_META, &json!({ "version": 1, "id": "zz", "tags": ["他人の"] }).to_string())]);
    // 同じ id のセッションが 2 人のフォルダにあれば、1 度だけ数える
    session(&root.join("person-b").join("proj-a").join("s1"), &[]);
    for d in ["person-a/proj-a", "person-b/proj-a"] {
        fs::write(jsfs::join_slash(&root, d).join(UPLOAD_INDEX), "{}").unwrap();
    }
    fs::create_dir(root.join("other")).unwrap();
    let three = ["person-a/proj-a", "person-a/proj-b", "person-b/proj-a"];
    assert_eq!(describe_source(&root), merged_of(&three));
    let m = snap(&root, &dest).unwrap();
    assert_eq!(m.layout, Some(SourceLayout::Merged));
    assert_eq!(m.merged.as_ref().unwrap().folders, three);
    assert_eq!(m.merged.as_ref().unwrap().duplicates, 1);
    assert_eq!(owners(&m), pairs(&[("s1", "person-a/proj-a"), ("s2", "person-a/proj-b"), ("s3", "person-b/proj-a")]));
    assert_eq!(m.sessions.dirs, 3);
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2", "s3"]);
    assert_eq!(skipped_with(&m, DUPLICATE_REASON), ["person-b/proj-a/s1"]);
    assert!(m.extras.as_ref().unwrap().top_level.is_empty());
    // 送った人のメモ(atlas-memo.md と画像の atlas-memo/)も写す
    assert!(fs::read_to_string(dest.join("session-state").join("s1").join("atlas-memo.md")).unwrap().contains("送った人のメモ"));
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("atlas-memo").join("p.png")).unwrap(), "png");
    assert!(!m.extras.as_ref().unwrap().skipped.iter().any(|s| s.path.contains("atlas-memo")));
    // 人のフォルダ 1 つを指したときは、その人の分だけ
    assert_eq!(describe_source(&root.join("person-a")), merged_of(&["proj-a", "proj-b"]));
    assert_eq!(snap(&root.join("person-a"), &base.path().join("out-a")).unwrap().sessions.dirs, 2);
    // 直下にアップロードしたフォルダがあり、その横に人ごとのフォルダもあるときは、両方を読む
    session(&root.join("shared").join("s4"), &[]);
    let four = ["person-a/proj-a", "person-a/proj-b", "person-b/proj-a", "shared"];
    assert_eq!(describe_source(&root), merged_of(&four));
    assert_eq!(snap(&root, &base.path().join("out-b")).unwrap().sessions.dirs, 4);
    // どれでもないフォルダ・無いフォルダは none(今までどおり 0 件で終わる)
    assert_eq!(describe_source(&root.join("other")), SourceShape::None);
    assert_eq!(describe_source(&root.join("nothing-here")), SourceShape::None);
    assert_eq!(snap(&root.join("other"), &base.path().join("out-other")).unwrap().sessions.dirs, 0);
    // さらに 1 段上(全員の分が入ったフォルダが並ぶ場所)は読まない
    let top = base.path().join("top");
    session(&top.join("logs").join("person-a").join("proj-a").join("s1"), &[]);
    fs::write(top.join("logs").join("person-a").join("proj-a").join(UPLOAD_INDEX), "{}").unwrap();
    assert_eq!(describe_source(&top), SourceShape::None);
    // ~/.copilot の形のフォルダ(バックアップなど)が横にあっても、人ごとのフォルダとしては読まない
    session(&root.join("backup").join("session-state").join("s9"), &[]);
    assert_eq!(describe_source(&root), merged_of(&four));
}

#[test]
fn owners_come_from_counted_folders() {
    assert_eq!(person_of_folder(Some("person-a/proj-a")).as_deref(), Some("person-a"));
    assert_eq!(person_of_folder(Some("proj-a")), None);
    assert_eq!(person_of_folder(Some("/proj-a")), None);
    assert_eq!(person_of_folder(Some("")), None);
    assert_eq!(person_of_folder(None), None);
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    session(&root.join("person-b").join("proj-a").join("s2"), &[]);
    // 人のフォルダの下に無いもの(送り先の直下のフォルダ)は、人が分からない
    session(&root.join("shared").join("s3"), &[]);
    // 置き換えの途中で止まり、写し終えた作業用のフォルダだけが残ったセッションは、そのフォルダの人
    session(&root.join("person-b").join("proj-b").join(upload_tmp_name("s4")), &[(UPLOAD_SESSION_META, &meta("s4"))]);
    fs::write(root.join("person-b").join("proj-b").join(UPLOAD_INDEX), "{}").unwrap();
    let all4 = pairs(&[("s1", "person-a/proj-a"), ("s2", "person-b/proj-a"), ("s3", "shared"), ("s4", "person-b/proj-b")]);
    let m = snap(&root, &dest).unwrap();
    assert_eq!(owners(&m), all4);
    assert_eq!(m.sessions.removed, None);
    // 元から消えたセッションは、複製も消し、数えたフォルダの記録からも外す(送り先から消したセッションを数え続けない)
    fs::remove_dir_all(root.join("person-b").join("proj-a").join("s2")).unwrap();
    let again = snap(&root, &dest).unwrap();
    assert!(!dest.join("session-state").join("s2").exists());
    assert_eq!(again.sessions.removed, Some(1));
    let mut got = owners(&again);
    got.sort();
    assert_eq!(got, pairs(&[("s1", "person-a/proj-a"), ("s3", "shared"), ("s4", "person-b/proj-b")]));
    assert_eq!(kept(&again), vec![]);
    // 消した後は、消す分が無いので件数を書かない
    assert_eq!(snap(&root, &dest).unwrap().sessions.removed, None);
    // 別の人のフォルダに移したら、今あるほうの人になる(前の値より、今の元を先に見る)
    session(&root.join("person-a").join("proj-a").join("s2"), &[]);
    let m3 = snap(&root, &dest).unwrap();
    assert_eq!(m3.merged.as_ref().unwrap().owners.as_ref().unwrap()["s2"], "person-a/proj-a");
}

/// 消さなかった複製が持ち越した、フォルダの記録(id, folder)
fn kept_folders(m: &SnapshotManifest) -> Vec<(String, Option<String>)> {
    m.extras.as_ref().unwrap().gone_kept.as_ref().map(|k| k.iter().map(|x| (x.id.clone(), x.folder.clone())).collect()).unwrap_or_default()
}

fn kept(m: &SnapshotManifest) -> Vec<(String, String)> {
    m.extras.as_ref().unwrap().gone_kept.as_ref().map(|k| k.iter().map(|x| (x.id.clone(), x.reason.clone())).collect()).unwrap_or_default()
}

#[test]
fn sessions_gone_from_upload_folder_are_removed_from_copy() {
    let base = work();
    // プロジェクトのフォルダ(直下にセッションが並ぶ形)
    let proj = base.path().join("logs").join("proj-a");
    let dest = base.path().join("out").join("snapshot");
    let state = dest.join("session-state");
    for id in ["s1", "s2", "s3", "s4", "s5"] {
        session(&proj.join(id), &[]);
    }
    let first = snap(&proj, &dest).unwrap();
    assert_eq!((first.sessions.removed, kept(&first)), (None, vec![]));
    assert_eq!(names(&state), ["s1", "s2", "s3", "s4", "s5"]);
    // s2 は消した。s3 は本体が無く、置き換えで退けた前のフォルダだけが残っている(共有から消したセッションの消し残し。写さないので、複製も消す)。
    // s4 は名前の大文字小文字だけが変わった(Windows では同じフォルダなので、写したばかりの複製を消さない)。
    // s5 は本体が無く、写している途中の作業用のフォルダだけがある(送っている最中かもしれないので、複製を消さない)
    fs::remove_dir_all(proj.join("s2")).unwrap();
    fs::rename(proj.join("s3"), proj.join(upload_old_name("s3"))).unwrap();
    fs::rename(proj.join("s4"), proj.join("S4-tmp")).unwrap();
    fs::rename(proj.join("S4-tmp"), proj.join("S4")).unwrap();
    fs::rename(proj.join("s5"), proj.join(upload_tmp_name("s5"))).unwrap();
    // 複製先にある作業用のフォルダの名前のもの(前の版が写したもの)には触れない
    session(&state.join(upload_old_name("zz")), &[]);
    let m = snap(&proj, &dest).unwrap();
    assert_eq!((m.sessions.removed, kept(&m)), (Some(2), vec![]));
    let left: Vec<String> = names(&state).into_iter().map(|n| n.to_lowercase()).collect();
    for id in ["s1", "s4", "s5"] {
        assert!(left.contains(&id.to_string()), "{id} が無い: {left:?}");
    }
    assert!(!state.join("s2").exists() && !state.join("s3").exists(), "{left:?}");
    assert!(state.join("s5").join("events.jsonl").exists());
    assert!(state.join(upload_old_name("zz")).join("events.jsonl").exists());
    // 退けた場所は、消し終えたら残さない
    assert!(!dest.join(SNAPSHOT_REMOVED_DIR).exists());
    // 前の集計で消し切れなかった分が退けた場所に残っていれば、消す分が無い回でも片付ける
    session(&dest.join(SNAPSHOT_REMOVED_DIR).join("1").join("zz-left"), &[]);
    assert_eq!(snap(&proj, &dest).unwrap().sessions.removed, None);
    assert!(!dest.join(SNAPSHOT_REMOVED_DIR).exists());
}

#[test]
fn last_session_gone_is_removed_too() {
    // 最後のセッションを消しても(索引は残っている)、複製を消す。「1 件も読めなかったら消さない」という守りは置かない:
    // 消すのは、前にあった場所を読み直して、無いと確かめられたものだけなので
    let base = work();
    let people = base.path().join("people");
    let dest = base.path().join("out").join("snapshot");
    session(&people.join("person-a").join("proj-a").join("t1"), &[]);
    fs::write(people.join("person-a").join("proj-a").join(UPLOAD_INDEX), "{}").unwrap();
    assert_eq!(snap(&people, &dest).unwrap().sessions.dirs, 1);
    fs::remove_dir_all(people.join("person-a").join("proj-a").join("t1")).unwrap();
    assert_eq!(describe_source(&people), merged_of(&["person-a/proj-a"]));
    let m = snap(&people, &dest).unwrap();
    assert_eq!((m.sessions.dirs, m.sessions.removed, kept(&m)), (0, Some(1), vec![]));
    assert!(!dest.join("session-state").join("t1").exists());
    assert_eq!(owners(&m), vec![]);
}

#[test]
fn unreadable_source_folder_keeps_copy_and_owner() {
    // 前にあった場所を読めないとき(アクセス権が無い・共有フォルダが切れた)は、無くなったとみなさず、複製も数えたフォルダの記録も残す。
    // 読めないフォルダの代わりに、人のフォルダの名前のファイルを置く(フォルダとして読めない)
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    session(&root.join("person-b").join("proj-b").join("s2"), &[]);
    session(&root.join("person-b").join("proj-b").join("s3"), &[]);
    assert_eq!(owners(&snap(&root, &dest).unwrap()), pairs(&[("s1", "person-a/proj-a"), ("s2", "person-b/proj-b"), ("s3", "person-b/proj-b")]));
    let hidden = base.path().join("person-b-hidden");
    fs::rename(root.join("person-b"), &hidden).unwrap();
    fs::write(root.join("person-b"), "not a folder").unwrap();
    let m = snap(&root, &dest).unwrap();
    assert_eq!(m.sessions.removed, None);
    assert_eq!(kept(&m), pairs(&[("s2", KEPT_UNREADABLE_REASON), ("s3", KEPT_UNREADABLE_REASON)]));
    assert_eq!(kept_folders(&m), vec![("s2".to_string(), Some("person-b/proj-b".to_string())), ("s3".to_string(), Some("person-b/proj-b".to_string()))]);
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2", "s3"]);
    // 数えたフォルダは前の集計から引き継ぐ(人ごとの内訳から外さない。次に確かめるときにも要る)
    let mut got = owners(&m);
    got.sort();
    assert_eq!(got, pairs(&[("s1", "person-a/proj-a"), ("s2", "person-b/proj-b"), ("s3", "person-b/proj-b")]));
    // セッションが並ぶフォルダ(プロジェクトのフォルダ)そのものを読めないときも同じ
    fs::remove_file(root.join("person-b")).unwrap();
    fs::rename(&hidden, root.join("person-b")).unwrap();
    let hidden_proj = base.path().join("proj-b-hidden");
    fs::rename(root.join("person-b").join("proj-b"), &hidden_proj).unwrap();
    fs::write(root.join("person-b").join("proj-b"), "not a folder").unwrap();
    let lower = snap(&root, &dest).unwrap();
    assert_eq!((lower.sessions.removed, kept(&lower)), (None, pairs(&[("s2", KEPT_UNREADABLE_REASON), ("s3", KEPT_UNREADABLE_REASON)])));
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2", "s3"]);
    // 読めるようになり、s2 だけが無くなっていた: s2 の複製だけを消す
    fs::remove_file(root.join("person-b").join("proj-b")).unwrap();
    fs::rename(&hidden_proj, root.join("person-b").join("proj-b")).unwrap();
    fs::remove_dir_all(root.join("person-b").join("proj-b").join("s2")).unwrap();
    let back = snap(&root, &dest).unwrap();
    assert_eq!((back.sessions.removed, kept(&back)), (Some(1), vec![]));
    assert_eq!(names(&dest.join("session-state")), ["s1", "s3"]);
    // 人のフォルダごと無くなった: その下のセッションの複製を消す
    fs::remove_dir_all(root.join("person-b")).unwrap();
    let gone = snap(&root, &dest).unwrap();
    assert_eq!((gone.sessions.removed, kept(&gone)), (Some(1), vec![]));
    assert_eq!(names(&dest.join("session-state")), ["s1"]);
}

#[test]
fn copies_without_a_record_of_their_folder_are_kept() {
    let base = work();
    // まとめて読む形: 前の集計に、どのフォルダのセッションかの記録が無い複製(前の版が写したもの・途中で止まった集計のもの)は消さない
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    snap(&root, &dest).unwrap();
    session(&dest.join("session-state").join("old9"), &[]);
    let m = snap(&root, &dest).unwrap();
    assert_eq!((m.sessions.removed, kept(&m)), (None, pairs(&[("old9", KEPT_UNKNOWN_REASON)])));
    assert_eq!(kept_folders(&m), vec![("old9".to_string(), None)]);
    assert!(dest.join("session-state").join("old9").exists());
    // 直下にセッションが並ぶ形: 最後まで終わった集計の記録が無いうち(1 回目が途中で止まった)は消さず、記録ができた次の回に消す
    let proj = base.path().join("proj");
    let dest2 = base.path().join("out2").join("snapshot");
    session(&proj.join("p1"), &[]);
    session(&dest2.join("session-state").join("p0"), &[]);
    let first = snap(&proj, &dest2).unwrap();
    assert_eq!((first.sessions.removed, kept(&first)), (None, pairs(&[("p0", KEPT_UNKNOWN_REASON)])));
    let second = snap(&proj, &dest2).unwrap();
    assert_eq!((second.sessions.removed, kept(&second)), (Some(1), vec![]));
    assert_eq!(names(&dest2.join("session-state")), ["p1"]);
}

#[test]
fn layout_change_does_not_wipe_copies() {
    // 人ごとのフォルダが並ぶ場所の直下に、セッションのフォルダが 1 つ紛れると、直下にセッションが並ぶ形として読まれる。
    // そのときも、前の集計で数えたフォルダにまだあるセッションの複製は消さず、理由を残す。何回集計しても同じ
    // (直下に並ぶ形の回の manifest には数えたフォルダの記録が無いので、消さなかった複製の記録として持ち越す)
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    session(&root.join("person-b").join("proj-b").join("s2"), &[]);
    snap(&root, &dest).unwrap();
    session(&root.join("stray"), &[]);
    assert_eq!(describe_source(&root), SourceShape::Flat);
    for round in 1..=3 {
        let m = snap(&root, &dest).unwrap();
        assert_eq!(m.sessions.removed, None, "{round} 回目");
        assert_eq!(kept(&m), pairs(&[("s1", KEPT_PRESENT_REASON), ("s2", KEPT_PRESENT_REASON)]), "{round} 回目");
        assert_eq!(kept_folders(&m), vec![("s1".to_string(), Some("person-a/proj-a".to_string())), ("s2".to_string(), Some("person-b/proj-b".to_string()))], "{round} 回目");
        assert_eq!(names(&dest.join("session-state")), ["s1", "s2", "stray"], "{round} 回目");
    }
    // 形が変わっている間に、元から本当に無くなったものは消す
    fs::remove_dir_all(root.join("person-b").join("proj-b").join("s2")).unwrap();
    let m = snap(&root, &dest).unwrap();
    assert_eq!((m.sessions.removed, kept(&m)), (Some(1), pairs(&[("s1", KEPT_PRESENT_REASON)])));
    // 紛れたフォルダを除くと、元の形に戻る: 残した複製はそのまま数え、紛れたフォルダの複製は消す
    fs::remove_dir_all(root.join("stray")).unwrap();
    let back = snap(&root, &dest).unwrap();
    assert_eq!((back.sessions.removed, kept(&back)), (Some(1), vec![]));
    assert_eq!(owners(&back), pairs(&[("s1", "person-a/proj-a")]));
    assert_eq!(names(&dest.join("session-state")), ["s1"]);
}

#[test]
fn run_that_finds_no_sessions_keeps_copies_and_their_records() {
    // 前はアップロード先として読んだ場所に、集計できるセッションが 1 件も見つからない回(共有フォルダが空に見える、など)は、
    // 何も消さず、複製ごとのフォルダの記録を持ち越す。次に読めたときに、無くなったものだけを消せる
    let base = work();
    // まとめて読む形
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("a1"), &[]);
    session(&root.join("person-a").join("proj-a").join("a2"), &[]);
    snap(&root, &dest).unwrap();
    let away = base.path().join("person-a-away");
    fs::rename(root.join("person-a"), &away).unwrap();
    assert_eq!(describe_source(&root), SourceShape::None);
    for round in 1..=2 {
        let none = snap(&root, &dest).unwrap();
        assert_eq!(none.sessions.removed, None, "{round} 回目");
        assert_eq!(kept(&none), pairs(&[("a1", KEPT_NO_SOURCE_REASON), ("a2", KEPT_NO_SOURCE_REASON)]), "{round} 回目");
        assert_eq!(kept_folders(&none), vec![("a1".to_string(), Some("person-a/proj-a".to_string())), ("a2".to_string(), Some("person-a/proj-a".to_string()))], "{round} 回目");
    }
    fs::rename(&away, root.join("person-a")).unwrap();
    fs::remove_dir_all(root.join("person-a").join("proj-a").join("a2")).unwrap();
    let back = snap(&root, &dest).unwrap();
    assert_eq!((back.sessions.removed, kept(&back)), (Some(1), vec![]));
    assert_eq!(names(&dest.join("session-state")), ["a1"]);
    assert_eq!(owners(&back), pairs(&[("a1", "person-a/proj-a")]));
    // 直下にセッションが並ぶ形
    let proj = base.path().join("proj");
    let dest2 = base.path().join("out2").join("snapshot");
    session(&proj.join("p1"), &[]);
    session(&proj.join("p2"), &[]);
    snap(&proj, &dest2).unwrap();
    let away2 = base.path().join("p-away");
    fs::create_dir_all(&away2).unwrap();
    fs::rename(proj.join("p1"), away2.join("p1")).unwrap();
    fs::rename(proj.join("p2"), away2.join("p2")).unwrap();
    let none = snap(&proj, &dest2).unwrap();
    assert_eq!(kept_folders(&none), vec![("p1".to_string(), Some(String::new())), ("p2".to_string(), Some(String::new()))]);
    assert_eq!(names(&dest2.join("session-state")), ["p1", "p2"]);
    fs::rename(away2.join("p1"), proj.join("p1")).unwrap();
    let back2 = snap(&proj, &dest2).unwrap();
    assert_eq!((back2.sessions.removed, kept(&back2)), (Some(1), vec![]));
    assert_eq!(names(&dest2.join("session-state")), ["p1"]);
}

#[test]
fn first_record_wins_when_an_id_is_recorded_twice() {
    // 消さなかった複製の記録に、同じ id が 2 回あっても(atlas は書かないが、手で書き換えた manifest など)、先の記録の場所を確かめる
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    session(&root.join("person-b").join("proj-b").join("d1"), &[]);
    snap(&root, &dest).unwrap();
    // 直下にフォルダが紛れて形が変わった回の manifest に、d1 の記録を 2 つ書く(先は今もある場所、後は無い場所)
    session(&root.join("stray"), &[]);
    snap(&root, &dest).unwrap();
    let file = dest.join(SNAPSHOT_MANIFEST);
    let mut m: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let kept_list = m["extras"]["goneKept"].as_array_mut().unwrap();
    assert!(kept_list.iter().any(|k| k["id"] == "d1" && k["folder"] == "person-b/proj-b"));
    kept_list.push(json!({ "id": "d1", "reason": KEPT_PRESENT_REASON, "folder": "person-a/proj-a" }));
    fs::write(&file, m.to_string()).unwrap();
    let again = snap(&root, &dest).unwrap();
    assert_eq!(again.sessions.removed, None);
    assert!(dest.join("session-state").join("d1").exists());
    assert_eq!(kept_folders(&again), vec![("d1".to_string(), Some("person-b/proj-b".to_string())), ("s1".to_string(), Some("person-a/proj-a".to_string()))]);
}

#[test]
fn root_record_is_not_written_as_counted_folder() {
    // 直下にセッションが並ぶ形だった場所が、人ごとのフォルダが並ぶ形に変わった。直下にフォルダだけが残ったセッション(中身は無い)の複製は、
    // 「元のルートにあった」という記録で持ち越す。その記録は、数えたフォルダ(人ごとの内訳に使う merged.owners)には書かない
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("p8"), &[]);
    session(&root.join("p9"), &[]);
    assert_eq!(describe_source(&root), SourceShape::Flat);
    snap(&root, &dest).unwrap();
    fs::remove_dir_all(root.join("p8")).unwrap();
    fs::remove_file(root.join("p9").join("events.jsonl")).unwrap();
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    assert_eq!(describe_source(&root), merged_of(&["person-a/proj-a"]));
    for round in 1..=2 {
        let m = snap(&root, &dest).unwrap();
        assert_eq!(m.sessions.removed, if round == 1 { Some(1) } else { None }, "{round} 回目");
        assert_eq!(kept(&m), pairs(&[("p9", KEPT_PRESENT_REASON)]), "{round} 回目");
        assert_eq!(kept_folders(&m), vec![("p9".to_string(), Some(String::new()))], "{round} 回目");
        assert_eq!(owners(&m), pairs(&[("s1", "person-a/proj-a")]), "{round} 回目");
        assert_eq!(names(&dest.join("session-state")), ["p9", "s1"], "{round} 回目");
    }
}

#[cfg(unix)]
#[test]
fn copy_with_an_open_file_is_removed_on_unix() {
    // Linux・macOS では、複製の中のファイルをほかのプログラムが開いていても、フォルダごと動かして消せる(消せずに残るのは Windows だけ)
    let base = work();
    let proj = base.path().join("proj");
    let dest = base.path().join("out").join("snapshot");
    let state = dest.join("session-state");
    for id in ["g1", "keep"] {
        session(&proj.join(id), &[]);
    }
    snap(&proj, &dest).unwrap();
    fs::remove_dir_all(proj.join("g1")).unwrap();
    let held = fs::File::open(state.join("g1").join("events.jsonl")).unwrap();
    let m = snap(&proj, &dest).unwrap();
    assert_eq!((m.sessions.removed, kept(&m)), (Some(1), vec![]));
    assert_eq!(names(&state), ["keep"]);
    // 開かれていても、退けた場所ごと消える
    assert!(!dest.join(SNAPSHOT_REMOVED_DIR).exists());
    drop(held);
}

#[cfg(windows)]
#[test]
fn copy_that_cannot_be_moved_does_not_stop_the_run() {
    use std::os::windows::fs::OpenOptionsExt;
    let base = work();
    let proj = base.path().join("proj");
    let dest = base.path().join("out").join("snapshot");
    let state = dest.join("session-state");
    for id in ["g1", "g2", "keep"] {
        session(&proj.join(id), &[]);
    }
    snap(&proj, &dest).unwrap();
    fs::remove_dir_all(proj.join("g1")).unwrap();
    fs::remove_dir_all(proj.join("g2")).unwrap();
    // g2 の複製のファイルを、ほかのプログラムが共有なしで開いている
    let held = fs::OpenOptions::new().read(true).share_mode(0).open(state.join("g2").join("events.jsonl")).unwrap();
    let m = snap(&proj, &dest).unwrap();
    assert!(!state.join("g1").exists());
    // 動かせなかった複製は、丸ごと残して理由を残す(半分だけ消えた複製にしない)。動かせた環境では消えている
    if state.join("g2").exists() {
        assert_eq!((m.sessions.removed, kept(&m)), (Some(1), pairs(&[("g2", KEPT_BUSY_REASON)])));
        // 次の集計が確かめる場所(元のルート)を持ち越す
        assert_eq!(kept_folders(&m), vec![("g2".to_string(), Some(String::new()))]);
        assert!(state.join("g2").join("events.jsonl").exists());
    } else {
        assert_eq!((m.sessions.removed, kept(&m)), (Some(2), vec![]));
    }
    drop(held);
    // 開いていたプログラムが閉じた後の集計で消える
    let after = snap(&proj, &dest).unwrap();
    assert_eq!(kept(&after), vec![]);
    assert_eq!(names(&state), ["keep"]);
    assert!(!dest.join(SNAPSHOT_REMOVED_DIR).exists());
}

#[test]
fn sessions_gone_from_copilot_home_keep_their_copy() {
    // ~/.copilot を読むときは、元から消えたセッションの複製を残す(Copilot が消したログの、最後の複製かもしれない)
    let base = work();
    let home = base.path().join("home");
    let dest = base.path().join("out").join("snapshot");
    session(&home.join("session-state").join("s1"), &[]);
    session(&home.join("session-state").join("s2"), &[]);
    snap(&home, &dest).unwrap();
    fs::remove_dir_all(home.join("session-state").join("s2")).unwrap();
    let m = snap(&home, &dest).unwrap();
    assert_eq!((m.sessions.removed, kept(&m)), (None, vec![]));
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2"]);
    // セッションが 1 件も見つからない回(session-state が一時的に無い)でも、アップロード先の決まり(記録の持ち越し・警告)は掛けない
    let away = base.path().join("session-state-away");
    fs::rename(home.join("session-state"), &away).unwrap();
    assert_eq!(describe_source(&home), SourceShape::None);
    let none = snap(&home, &dest).unwrap();
    assert_eq!((none.sessions.removed, kept(&none)), (None, vec![]));
    assert_eq!(names(&dest.join("session-state")), ["s1", "s2"]);
}

#[test]
fn copilot_shaped_run_does_not_carry_upload_records() {
    // アップロード先として読んでいた場所が、~/.copilot の形として読まれた回(直下に session-state ができた)は、
    // セッションが見つかっているので、「見つからなかった」という記録を複製に付けない
    let base = work();
    let proj = base.path().join("proj");
    let dest = base.path().join("out").join("snapshot");
    session(&proj.join("p1"), &[]);
    assert_eq!(snap(&proj, &dest).unwrap().layout, Some(SourceLayout::Flat));
    session(&proj.join("session-state").join("c1"), &[]);
    assert_eq!(describe_source(&proj), SourceShape::Copilot);
    let m = snap(&proj, &dest).unwrap();
    assert_eq!((m.layout, m.sessions.removed, kept(&m)), (Some(SourceLayout::Copilot), None, vec![]));
    assert_eq!(names(&dest.join("session-state")), ["c1", "p1"]);
}

#[test]
fn two_levels_probe_uses_index_and_first_three() {
    let base = work();
    let root = base.path().join("logs");
    // 索引の無いフォルダ(前の版が写した、手で写した)でも、人のフォルダの下の先頭の 3 個までにあれば読む
    session(&root.join("person-a").join("proj-a").join("s1"), &[]);
    assert_eq!(describe_source(&root), merged_of(&["person-a/proj-a"]));
    // 4 番目より後ろにしか無ければ、読まない
    let far = base.path().join("far");
    for d in ["d1", "d2", "d3"] {
        fs::create_dir_all(far.join("person-a").join(d)).unwrap();
    }
    session(&far.join("person-a").join("proj-z").join("s1"), &[]);
    assert_eq!(describe_source(&far), SourceShape::None);
    assert_eq!(snap(&far, &base.path().join("out-far")).unwrap().sessions.dirs, 0);
    // どこか 1 つに索引があれば、索引の無いフォルダも読む
    session(&far.join("person-b").join("proj-b").join("s2"), &[]);
    fs::write(far.join("person-b").join("proj-b").join(UPLOAD_INDEX), "{}").unwrap();
    assert_eq!(describe_source(&far), merged_of(&["person-a/proj-z", "person-b/proj-b"]));
}

#[test]
fn probe_limit_is_twenty_then_reads_rest() {
    let base = work();
    let root = base.path().join("big");
    // 索引の無いフォルダが 25 個。セッションの形のものは、名前の順で 21 番目より後ろにだけある
    for i in 0..25 {
        fs::create_dir_all(root.join(format!("d{i:02}"))).unwrap();
    }
    session(&root.join("d22").join("s1"), &[]);
    assert_eq!(describe_source(&root), SourceShape::None);
    assert_eq!(snap(&root, &base.path().join("out-a")).unwrap().sessions.dirs, 0);
    // 索引のあるフォルダは、何番目にあっても見つける。まとめて読むと決めたら、索引の無い 21 番目より後ろのフォルダも読む
    fs::write(root.join("d24").join(UPLOAD_INDEX), "{}").unwrap();
    assert_eq!(describe_source(&root), merged_of(&["d22", "d24"]));
    assert_eq!(snap(&root, &base.path().join("out-b")).unwrap().sessions.dirs, 1);
    // 先頭の 20 個の中にあるセッションの形のフォルダは、索引が無くても見つける
    fs::remove_file(root.join("d24").join(UPLOAD_INDEX)).unwrap();
    session(&root.join("d03").join("s2"), &[]);
    assert_eq!(describe_source(&root), merged_of(&["d03", "d22"]));
}

#[test]
fn links_are_not_followed() {
    let base = work();
    let src = base.path().join("logs").join("group");
    let dest = base.path().join("out").join("snapshot");
    let outside = base.path().join("outside.txt");
    fs::write(&outside, "OUTSIDE\n").unwrap();
    session(&src.join("s1"), &[("plan.md", "# 計画\n"), ("workspace.yaml", "id: s1\n")]);
    session(&src.join("s2"), &[]);
    snap(&src, &dest).unwrap();
    assert_eq!(fs::read_to_string(dest.join("session-state").join("s1").join("plan.md")).unwrap(), "# 計画\n");
    // plan.md と workspace.yaml をリンクに差し替える。s2 は events.jsonl がリンク(ほかに何も無い)
    fs::remove_file(src.join("s1").join("plan.md")).unwrap();
    fs::remove_file(src.join("s1").join("workspace.yaml")).unwrap();
    fs::remove_file(src.join("s2").join("events.jsonl")).unwrap();
    if !link(&outside, &src.join("s1").join("plan.md")) {
        eprintln!("シンボリックリンクを作れないので飛ばす");
        return;
    }
    link(&outside, &src.join("s1").join("workspace.yaml"));
    link(&outside, &src.join("s2").join("events.jsonl"));
    let m = snap(&src, &dest).unwrap();
    assert!(!dest.join("session-state").join("s1").join("plan.md").exists());
    assert!(!dest.join("session-state").join("s1").join("workspace.yaml").exists());
    assert!(dest.join("session-state").join("s1").join("events.jsonl").exists());
    assert!(!dest.join("session-state").join("s2").join("events.jsonl").exists());
    assert_eq!(sorted(skipped_with(&m, LINK_REASON)), ["s1/plan.md", "s1/workspace.yaml", "s2/events.jsonl"]);
    assert_eq!(fs::read_to_string(&outside).unwrap(), "OUTSIDE\n");
}

#[test]
fn reads_upload_indexes() {
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    let atlas = json!({ "commit": "a".repeat(40), "committedAt": "2026-11-13T09:00:00+09:00", "dirty": false, "code": "0123456789abcdef" });
    for f in ["person-a/proj-a", "person-b/proj-a", "person-b/proj-b", "person-c/proj-a"] {
        session(&jsfs::join_slash(&root, f).join(format!("s-{}", f.replace('/', "-"))), &[]);
    }
    let idx = |f: &str, text: String| fs::write(jsfs::join_slash(&root, f).join(UPLOAD_INDEX), text).unwrap();
    idx("person-a/proj-a", json!({ "version": 1, "uploadedAt": "2026-11-13T00:00:00.000Z", "atlas": atlas, "sessions": [] }).to_string());
    // 版を記録するより前の atlas で送った索引
    idx("person-b/proj-a", json!({ "version": 1, "uploadedAt": "2026-11-01T09:00:00+09:00", "sessions": [] }).to_string());
    // 書きかけ・壊れた索引と、形の違う索引は、読めなかったとして入れる
    idx("person-b/proj-b", "{ \"version\": 1, \"uploadedAt\": \"2026-11-".into());
    idx("person-c/proj-a", json!({ "version": 2, "uploadedAt": "2026-11-01T00:00:00.000Z" }).to_string());
    // 索引の無いフォルダ(前の版や手で写したもの)は入れない
    session(&root.join("person-d").join("proj-a").join("s-d"), &[]);
    session(&root.join("person-d").join("proj-a").join("s-d2"), &[]);
    // セッションの一覧で大きくなった索引も、先頭(uploadedAt と atlas)だけで読む
    let sessions: Vec<Value> = (0..3000).map(|i| json!({ "id": format!("x{i}"), "title": format!("題名 \"atlas\": {{ \"commit\": \"zz\" }} {}", "あ".repeat(20)) })).collect();
    let big = json!({ "version": 1, "kind": "project", "name": "proj-b", "note": "", "uploadedAt": "2026-11-12T00:00:00.000Z", "snapshotAt": null, "atlas": atlas, "sessions": sessions, "missing": [] });
    session(&root.join("person-e").join("proj-b").join("s-e"), &[]);
    idx("person-e/proj-b", crate::json::to_js_string_pretty(&big).unwrap());
    let m = snap(&root, &dest).unwrap();
    let up = |at: Option<&str>, atlas: Option<Value>, unreadable: bool| {
        let mut v = json!({ "uploadedAt": at, "atlas": atlas });
        if unreadable {
            v["unreadable"] = json!(true);
        }
        v
    };
    let fixed = json!({ "commit": "a".repeat(40), "committedAt": "2026-11-13T00:00:00.000Z", "dirty": false, "code": "0123456789abcdef" });
    assert_eq!(
        serde_json::to_value(m.uploads.as_ref().unwrap()).unwrap(),
        json!({
            "person-a/proj-a": up(Some("2026-11-13T00:00:00.000Z"), Some(fixed.clone()), false),
            "person-b/proj-a": up(Some("2026-11-01T00:00:00.000Z"), None, false),
            "person-b/proj-b": up(None, None, true),
            "person-c/proj-a": up(None, None, true),
            "person-e/proj-b": up(Some("2026-11-12T00:00:00.000Z"), Some(fixed), false),
        })
    );
}

#[test]
fn oversized_memo_is_not_copied() {
    let base = work();
    let root = base.path().join("logs");
    let dest = base.path().join("out").join("snapshot");
    session(&root.join("s1"), &[("atlas-memo.md", "# 小さいメモ")]);
    fs::create_dir(root.join("s1").join("atlas-memo")).unwrap();
    fs::write(root.join("s1").join("atlas-memo").join("p.png"), "png").unwrap();
    assert_eq!(describe_source(&root), SourceShape::Flat);
    snap(&root, &dest).unwrap();
    assert!(dest.join("session-state").join("s1").join("atlas-memo.md").exists());
    assert!(dest.join("session-state").join("s1").join("atlas-memo").join("p.png").exists());
    fs::write(root.join("s1").join("atlas-memo.md"), "x".repeat(UPLOAD_MEMO_TEXT_LIMIT as usize + 1)).unwrap();
    let f = fs::File::create(root.join("s1").join("atlas-memo").join("big.bin")).unwrap();
    f.set_len(UPLOAD_MEMO_IMAGES_LIMIT + 1).unwrap();
    drop(f);
    let m = snap(&root, &dest).unwrap();
    assert!(!dest.join("session-state").join("s1").join("atlas-memo.md").exists());
    assert!(!dest.join("session-state").join("s1").join("atlas-memo").exists());
    let mut memo: Vec<String> = m.extras.as_ref().unwrap().skipped.iter().filter(|s| s.path.contains("atlas-memo")).map(|s| s.path.clone()).collect();
    memo.sort();
    assert_eq!(memo, ["s1/atlas-memo", "s1/atlas-memo.md"]);
}
