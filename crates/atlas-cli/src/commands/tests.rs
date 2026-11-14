//! コマンドの入口のテスト(packages/cli/test/jobs.test.ts の CLI の印の部分・open-pick.test.ts・group-export.test.ts の CLI の部分)

use super::*;
use crate::args::parse_cli;
use crate::folders::{folder_paths, folders_root_of, write_folder_state, FolderError, FolderState};
use crate::jobs::{acquire_out_lock, job_args, running_job_in, JobArgsInput, JobRequest, OutBusyError, JOB_LOCK_FILE};
use serde_json::json;
use std::fs;
use std::sync::Mutex;

fn cli(args: &[&str]) -> CliOptions {
    parse_cli(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
}

fn quiet(_: &str) {}

/// 生きている別のプロセス(印の持ち主にする)
fn other_process() -> std::process::Child {
    std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "ping -n 30 127.0.0.1 >nul"] } else { ["-c", "sleep 30"] }).spawn().unwrap()
}

#[test]
fn out_lock_stops_writing_commands() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out");
    let notes = d.path().join("notes");
    fs::create_dir_all(&out).unwrap();
    let (o, n) = (out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    let lock = out.join(JOB_LOCK_FILE);
    let mut child = other_process();
    // 画面のジョブ(serve)の印があれば all は止まる
    fs::write(&lock, json!({ "pid": child.id(), "kind": "judge" }).to_string()).unwrap();
    assert_eq!(running_job_in(&out).as_deref(), Some("judge"));
    let home = d.path().join("no-home").to_string_lossy().into_owned();
    let e = run(&cli(&["all", "--out", &o, "--notes-dir", &n, "--home", &home]), &quiet).unwrap_err();
    assert!(e.to_string().contains("画面から実行した処理(judge)"), "{e}");
    // 別の atlas(CLI)が持っていれば、CLI の書き込むコマンドも止まる
    fs::write(&lock, json!({ "pid": child.id(), "kind": "judge", "by": "cli" }).to_string()).unwrap();
    assert!(acquire_out_lock(&out, "all", "cli").unwrap_err().0.contains("別の atlas の処理(judge)"));
    let e = run(&cli(&["bundle", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err();
    assert!(e.downcast_ref::<OutBusyError>().is_some(), "{e}");
    // 読めない印は、書いた直後なら書きかけとみなして止まる
    fs::write(&lock, "").unwrap();
    assert!(acquire_out_lock(&out, "all", "cli").is_err());
    let _ = child.kill();
    let _ = child.wait();
    // 自分の印・プロセスが無い古い印では止まらない
    fs::write(&lock, json!({ "pid": std::process::id(), "kind": "judge" }).to_string()).unwrap();
    assert_eq!(running_job_in(&out), None);
    fs::write(&lock, json!({ "pid": child.id(), "kind": "judge", "by": "cli" }).to_string()).unwrap();
    assert_eq!(running_job_in(&out), None);
    let l = acquire_out_lock(&out, "judge", "cli").unwrap();
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&lock).unwrap()).unwrap();
    assert_eq!((v["pid"].clone(), v["kind"].clone(), v["by"].clone()), (json!(std::process::id()), json!("judge"), json!("cli")));
    acquire_out_lock(&out, "bundle", "cli").unwrap().release();
    assert!(lock.exists());
    l.release();
    assert!(!lock.exists());
    // CLI のコマンドは終われば(失敗しても)印を外す
    let missing = d.path().join("missing.json").to_string_lossy().into_owned();
    assert!(run(&cli(&["judge", "import", &missing, "--out", &o, "--notes-dir", &n]), &quiet).is_err());
    assert!(!lock.exists());
}

#[test]
fn refresh_args_follow_the_opened_folder() {
    let p = JobArgsInput { out_dir: "o", notes_dir: "n", home: None };
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(job_args(&JobRequest::Refresh, &p), Some(v(&["all", "--out", "o", "--notes-dir", "n"])));
    let h = JobArgsInput { home: Some("/srv/logs/person-a"), ..p };
    assert_eq!(job_args(&JobRequest::Refresh, &h), Some(v(&["all", "--home", "/srv/logs/person-a", "--out", "o", "--notes-dir", "n"])));
    // 集計し直す以外は、出力先にあるものだけを使う
    assert_eq!(job_args(&JobRequest::Export, &h), Some(v(&["export", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnJudge { limit: 7 }, &h), Some(v(&["judge-flow", "--turns", "--limit", "7", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnBundle, &h), Some(v(&["turns", "bundle", "--unjudged", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::M365, &h), Some(v(&["judge", "m365", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnM365, &h), Some(v(&["turns", "m365", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::Full { id: "s1".into() }, &h), None);
}

#[test]
fn open_pick_canceled_writes_nothing() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out").to_string_lossy().into_owned();
    let notes = d.path().join("notes").to_string_lossy().into_owned();
    let o = cli(&["open", "--pick", "--out", &out, "--notes-dir", &notes, "--no-open"]);
    let root = folders_root_of(&out);
    let before = d.path().join("logs").join("person-a").to_string_lossy().into_owned();
    fs::create_dir_all(&before).unwrap();
    let at = "2026-11-01T00:00:00.000Z".to_string();
    write_folder_state(&folder_paths(&root, &notes, &before).state, &FolderState { version: 1, path: before.clone(), name: "person-a".into(), added_at: at.clone(), opened_at: at, listed: true, run: None }).unwrap();
    let asked: Mutex<Vec<Option<String>>> = Mutex::new(vec![]);
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let pick = |_t: &str, initial: Option<&str>| -> anyhow::Result<Option<String>> {
        asked.lock().unwrap().push(initial.map(str::to_string));
        Ok(None)
    };
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    let r = open::run_open(&o, &log, Some(&pick)).unwrap();
    assert_eq!(*asked.lock().unwrap(), vec![Some(before)]);
    assert!(logs.lock().unwrap().join("\n").contains("フォルダを選ばなかったので、何もしません"));
    assert!(r.build.is_none());
    assert!(!std::path::Path::new(&out).exists());
}

#[test]
fn open_pick_unusable_folder_stops_with_reason() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out").to_string_lossy().into_owned();
    let notes = d.path().join("notes").to_string_lossy().into_owned();
    let o = cli(&["open", "--pick", "--out", &out, "--notes-dir", &notes, "--no-open"]);
    let empty = d.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let asked: Mutex<Vec<Option<String>>> = Mutex::new(vec![]);
    let pick = |_t: &str, initial: Option<&str>| -> anyhow::Result<Option<String>> {
        asked.lock().unwrap().push(initial.map(str::to_string));
        Ok(Some(empty.to_string_lossy().into_owned()))
    };
    let e = open::run_open(&o, &quiet, Some(&pick)).unwrap_err();
    assert!(e.downcast_ref::<FolderError>().is_some(), "{e}");
    assert_eq!(*asked.lock().unwrap(), vec![None]);
    assert!(!std::path::Path::new(&folders_root_of(&out)).exists());
}

#[test]
fn group_and_memo_commands() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out");
    let notes = d.path().join("notes");
    fs::create_dir_all(&out).unwrap();
    let (o, n) = (out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    let take = || std::mem::take(&mut *logs.lock().unwrap()).join("\n");
    run(&cli(&["group", "list", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("はまだありません(atlas group add <名前> <id...> で作れます)"));
    run(&cli(&["group", "add", "調査", "abc", "abd", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    let l = take();
    assert!(l.contains("が無いため id を先頭一致で解決せず、そのまま書きます") && l.contains("「調査」を作りました(2 件)"), "{l}");
    // sessions.json があれば先頭一致で解決する
    fs::write(out.join("sessions.json"), json!({ "sessions": [{ "id": "abc-1" }, { "id": "xyz-2" }] }).to_string()).unwrap();
    run(&cli(&["group", "add", "調査", "xyz", "--note", "メモ", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("「調査」に 1 件を追記しました(重複 0 件を除く、計 3 件)"));
    run(&cli(&["group", "list", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("  調査: 3 件(うち記録にあるのは 1 件) — メモ"));
    assert!(run(&cli(&["group", "remove", "無い", "--out", &o, "--notes-dir", &n]), &log).unwrap_err().to_string().contains("(あるのは: 調査)"));
    run(&cli(&["group", "remove", "調査", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("「調査」を削除しました"));
    // memo
    run(&cli(&["memo", "set", "abc", "本文です", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("memo: abc-1 のメモを保存しました(4 文字)"));
    run(&cli(&["memo", "list", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("  abc-1: 本文です"));
    run(&cli(&["memo", "show", "abc-1", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert_eq!(take(), "本文です");
    run(&cli(&["memo", "remove", "abc", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(take().contains("のメモを削除しました"));
    assert!(run(&cli(&["memo", "show", "abc-1", "--out", &o, "--notes-dir", &n]), &log).unwrap_err().to_string().contains("のメモはありません"));
}
