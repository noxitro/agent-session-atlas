//! コマンドの入口のテスト(packages/cli/test/jobs.test.ts の CLI の印の部分・open-pick.test.ts)

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
    let p = JobArgsInput { out_dir: "o", notes_dir: "n", home: None, settings: None, judgments: None };
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(job_args(&JobRequest::Refresh, &p), Some(v(&["all", "--out", "o", "--notes-dir", "n"])));
    let h = JobArgsInput { home: Some("/srv/logs/person-a"), ..p };
    assert_eq!(job_args(&JobRequest::Refresh, &h), Some(v(&["all", "--home", "/srv/logs/person-a", "--out", "o", "--notes-dir", "n"])));
    // 集計し直す以外は、出力先にあるものだけを使う
    assert_eq!(job_args(&JobRequest::Export, &h), Some(v(&["export", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnBundle, &h), Some(v(&["turns", "bundle", "--unjudged", "--out", "o", "--notes-dir", "n"])));
    // ZIP は束と同じ回に作る(--zip を付けた bundle・turns bundle・tasks bundle)
    assert_eq!(job_args(&JobRequest::BundleZip, &h), Some(v(&["bundle", "--unjudged", "--zip", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnBundleZip, &h), Some(v(&["turns", "bundle", "--unjudged", "--zip", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TaskBundle, &h), Some(v(&["tasks", "bundle", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TaskBundleZip, &h), Some(v(&["tasks", "bundle", "--zip", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::M365, &h), Some(v(&["judge", "m365", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TurnM365, &h), Some(v(&["turns", "m365", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::TaskM365, &h), Some(v(&["tasks", "m365", "--out", "o", "--notes-dir", "n"])));
    assert_eq!(job_args(&JobRequest::Full { id: "s1".into() }, &h), None);
    // 設定のフォルダを使うサーバは、どのジョブにも同じ設定のフォルダを渡す
    let st = JobArgsInput { settings: Some("S"), ..h };
    assert_eq!(job_args(&JobRequest::TaskBundle, &st), Some(v(&["tasks", "bundle", "--out", "o", "--notes-dir", "n", "--settings", "S"])));
    assert_eq!(job_args(&JobRequest::M365, &st), Some(v(&["judge", "m365", "--out", "o", "--notes-dir", "n", "--settings", "S"])));
    for r in [JobRequest::Refresh, JobRequest::Bundle, JobRequest::BundleZip, JobRequest::Export, JobRequest::TurnBundle, JobRequest::TurnBundleZip, JobRequest::TaskBundleZip, JobRequest::TurnM365, JobRequest::TaskM365] {
        let a = job_args(&r, &st).unwrap();
        crate::args::parse_cli(&a).unwrap_or_else(|e| panic!("{a:?}: {e}"));
    }
    // serve --judgments X: 画面の取り込み先と同じ工数の判定のファイルを、どのジョブにも渡す(束の --unjudged・M365・作り直しが同じファイルを読む)
    let j = JobArgsInput { judgments: Some("J"), ..st };
    assert_eq!(job_args(&JobRequest::BundleZip, &j), Some(v(&["bundle", "--unjudged", "--zip", "--out", "o", "--notes-dir", "n", "--settings", "S", "--judgments", "J"])));
    assert_eq!(job_args(&JobRequest::Export, &j), Some(v(&["export", "--out", "o", "--notes-dir", "n", "--settings", "S", "--judgments", "J"])));
    for r in [JobRequest::Refresh, JobRequest::Bundle, JobRequest::BundleZip, JobRequest::Export, JobRequest::TurnBundle, JobRequest::TurnBundleZip, JobRequest::TaskBundle, JobRequest::TaskBundleZip, JobRequest::M365, JobRequest::TurnM365, JobRequest::TaskM365] {
        let a = job_args(&r, &j).unwrap();
        let o = crate::args::parse_cli(&a).unwrap_or_else(|e| panic!("{a:?}: {e}"));
        assert_eq!(o.judgments.as_deref(), Some("J"), "{a:?}");
    }
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
    write_folder_state(&folder_paths(&root, &notes, &before).state, &FolderState { version: 1, path: before.clone(), name: "person-a".into(), added_at: at.clone(), opened_at: at, listed: true, run: None, settings: None }).unwrap();
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
fn memo_commands() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out");
    let notes = d.path().join("notes");
    fs::create_dir_all(&out).unwrap();
    let (o, n) = (out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    let take = || std::mem::take(&mut *logs.lock().unwrap()).join("\n");
    // タスクタグのコマンド(group)と --group は、もう無い
    assert_eq!(parse_cli(&["group".to_string(), "list".into()]).unwrap_err().0, "不明なコマンドです: group");
    assert!(parse_cli(&["build".to_string(), "--group".into(), "g".into()]).unwrap_err().0.starts_with("Unknown option '--group'"));
    // sessions.json があれば先頭一致で解決する
    fs::write(out.join("sessions.json"), json!({ "sessions": [{ "id": "abc-1" }, { "id": "xyz-2" }] }).to_string()).unwrap();
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

// 従量課金の anthropic(skill-draft の --backend)は機能 anthropic-backend を付けたビルドだけに入る。名前は受け付け、入っていなければ入れ方を書いて止める
#[test]
fn anthropic_backend_needs_the_feature() {
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("out");
    let notes = d.path().join("notes");
    fs::create_dir_all(&out).unwrap();
    let (o, n) = (out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    let e = run(&cli(&["skill-draft", "1", "--backend", "anthropic", "--out", &o, "--notes-dir", &n]), &log).unwrap_err().to_string();
    if cfg!(feature = "anthropic-backend") {
        // 入っていれば先へ進む(キーか候補が無くて止まる。HTTP は送らない)
        assert!(!e.contains("この atlas には入っていません"), "{e}");
    } else {
        assert!(e.contains("この atlas には入っていません") && e.contains("cargo build --release -p atlas-cli --features anthropic-backend"), "{e}");
    }
    if !cfg!(feature = "anthropic-backend") {
        // 従量課金の注意も出さない(使えないので)
        assert!(logs.lock().unwrap().iter().all(|l| !l.contains("従量課金")), "{:?}", logs.lock().unwrap());
    }
}

/// 依頼ごとの判定の添付ファイルの一覧(manifest と、残すファイルの番号)を書く
fn write_turn_parts(out: &std::path::Path, extra: serde_json::Value, files: &[usize]) {
    let dir = out.join("turn-bundle");
    fs::create_dir_all(dir.join("parts")).unwrap();
    let part = |n: usize, sid: &str, turns: Vec<i64>| json!({ "path": format!("parts/part-0{n}.md"), "chunks": [{ "sessionId": sid, "turns": turns }], "turns": turns.len(), "bytes": 10 * n });
    let mut m = json!({
        "version": 1,
        "generatedAt": "2026-11-14T00:00:00.000Z",
        "phases": ["実装"],
        "count": 5,
        "unjudgedOnly": true,
        "chunks": [],
        "parts": [part(1, "s1", vec![1, 2]), part(2, "s2", vec![1]), part(3, "s1", vec![3]), part(4, "s2", vec![2])],
        "skipped": []
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    fs::write(dir.join("manifest.json"), m.to_string()).unwrap();
    for n in files {
        fs::write(dir.join("parts").join(format!("part-0{n}.md")), "# 指示").unwrap();
    }
}

#[test]
fn turn_chat_parts_mark_last_only_files() {
    use crate::chat_parts::{list_chat_parts, ChatDecidable, ChatTarget, JudgedFiles};
    let (jf, tf) = (std::path::PathBuf::from("none-judgments.json"), std::path::PathBuf::from("none-turn-judgments.json"));
    // 採用を判定できる依頼の数と先頭のファイル数を返し、その後ろのファイルに「最後の依頼だけ」の印を付ける(消えたファイルがあっても番号はずれない)
    let d = tempfile::tempdir().unwrap();
    // 先頭の 2 ファイルが判定できる依頼。part-02 は消えている
    write_turn_parts(d.path(), json!({ "decidable": { "turns": 3, "chunks": 2, "parts": 2 } }), &[1, 3, 4]);
    let r = list_chat_parts(d.path(), &JudgedFiles { judgments: &d.path().join(&jf), turn_judgments: &d.path().join(&tf), tasks_dir: d.path() }, ChatTarget::Turns).unwrap();
    assert_eq!((r.exists, r.unjudged_only, r.count, r.decidable), (true, Some(true), Some(5), Some(ChatDecidable { turns: 3, parts: 2, chunks: 2 })));
    let marks: Vec<(String, Option<bool>)> = r.parts.as_ref().unwrap().iter().map(|p| (p.name.clone(), p.last_only)).collect();
    assert_eq!(marks, [("part-01.md".to_string(), Some(false)), ("part-03.md".to_string(), Some(true)), ("part-04.md".to_string(), Some(true))]);
    // 画面に渡す形(lastOnly と decidable)
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["decidable"], json!({ "turns": 3, "parts": 2, "chunks": 2 }));
    assert_eq!(v["parts"][1]["lastOnly"], json!(true));

    // 古い添付(decidable が無い)では、数も印も返さない
    let d = tempfile::tempdir().unwrap();
    write_turn_parts(d.path(), json!({}), &[1, 2, 3, 4]);
    let r = list_chat_parts(d.path(), &JudgedFiles { judgments: &d.path().join(&jf), turn_judgments: &d.path().join(&tf), tasks_dir: d.path() }, ChatTarget::Turns).unwrap();
    assert_eq!(r.decidable, None);
    assert_eq!(r.parts.as_ref().unwrap().len(), 4);
    let v = serde_json::to_value(&r).unwrap();
    assert!(v.get("decidable").is_none());
    assert!(v["parts"].as_array().unwrap().iter().all(|p| p.get("lastOnly").is_none()));
}

/// judge に judge では効かない絞り込みを付けると、黙って添付の全体を扱わずに止め、bundle で絞って作るよう案内する
#[test]
fn judge_rejects_filters_it_ignores() {
    let d = tempfile::tempdir().unwrap();
    let (o, n) = (d.path().join("out").to_string_lossy().into_owned(), d.path().join("notes").to_string_lossy().into_owned());
    let e = run(&cli(&["judge", "import", "r.md", "--session", "ab", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--session は judge import では使えません"), "{e}");
    let e = run(&cli(&["judge", "m365", "--branch", "g", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--branch は judge m365 では効きません。"), "{e}");
    assert!(e.contains("bundle --branch --unjudged"), "{e}");
}

/// 依頼が 1 つずつあるセッションの記録(~/.copilot の session-state の形)
fn write_home_sessions(home: &std::path::Path, ids: &[&str]) {
    for id in ids {
        let d = home.join("session-state").join(id);
        fs::create_dir_all(&d).unwrap();
        let ev = [
            json!({ "type": "session.start", "id": format!("{id}-s"), "parentId": null, "timestamp": "2026-07-01T09:00:00.000Z", "data": { "sessionId": id, "version": 1, "copilotVersion": "1.0.50", "selectedModel": "gpt-5.5-mini", "context": { "cwd": "X:/p" } } }),
            json!({ "type": "user.message", "id": format!("{id}-u1"), "parentId": null, "timestamp": "2026-07-01T09:01:00.000Z", "data": { "content": "直して" } }),
            json!({ "type": "assistant.message", "id": format!("{id}-m1"), "parentId": null, "timestamp": "2026-07-01T09:02:00.000Z", "data": { "messageId": format!("{id}-mm"), "content": "終わりました。", "toolRequests": [], "outputTokens": 5 } }),
        ];
        fs::write(d.join("events.jsonl"), ev.iter().map(|e| format!("{e}\n")).collect::<String>()).unwrap();
    }
}

/// ユーザーの依頼が記録されていないセッション(束には入らない)
fn write_home_session_without_request(home: &std::path::Path, id: &str) {
    let d = home.join("session-state").join(id);
    fs::create_dir_all(&d).unwrap();
    let ev = [
        json!({ "type": "session.start", "id": format!("{id}-s"), "parentId": null, "timestamp": "2026-07-01T10:00:00.000Z", "data": { "sessionId": id, "version": 1, "copilotVersion": "1.0.50", "selectedModel": "gpt-5.5-mini", "context": { "cwd": "X:/p" } } }),
        json!({ "type": "assistant.message", "id": format!("{id}-m1"), "parentId": null, "timestamp": "2026-07-01T10:02:00.000Z", "data": { "messageId": format!("{id}-mm"), "content": "準備しました。", "toolRequests": [], "outputTokens": 5 } }),
    ];
    fs::write(d.join("events.jsonl"), ev.iter().map(|e| format!("{e}
")).collect::<String>()).unwrap();
}

/// turns bundle --zip: 束と同じ回に ZIP(INSTRUCTIONS.md・manifest.json・schema.json・chunks/)を作る。--zip なしで作り直すと、前の ZIP は消す。
/// 前の版のこのツールが判定に使った作業用の場所(out/judge-work)は、束を作るときに消す(前の版も、判定を始めるたびに消していた)
#[test]
fn turns_bundle_zip_and_stale_zip() {
    let d = tempfile::tempdir().unwrap();
    let (home, out, notes) = (d.path().join("home"), d.path().join("out"), d.path().join("notes"));
    write_home_sessions(&home, &["aaaa1111", "bbbb2222"]);
    write_home_session_without_request(&home, "cccc3333");
    let (h, o, n) = (home.to_string_lossy().into_owned(), out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    run(&cli(&["all", "--home", &h, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    fs::create_dir_all(out.join(super::bundle::OLD_JUDGE_WORK_DIR).join("bundle")).unwrap();
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    run(&cli(&["turns", "bundle", "--unjudged", "--zip", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(!out.join(super::bundle::OLD_JUDGE_WORK_DIR).exists());
    let zip = out.join("turn-bundle.zip");
    let bytes = fs::read(&zip).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    for name in ["turn-bundle/INSTRUCTIONS.md", "turn-bundle/manifest.json", "turn-bundle/schema.json", "turn-bundle/chunks/0001.md", "turn-bundle/chunks/0002.md"] {
        assert!(text.contains(name), "{name}");
    }
    assert!(!text.contains("turn-bundle/parts/"));
    assert!(logs.lock().unwrap().iter().any(|l| l.starts_with("turns bundle: ZIP にまとめました(5 ファイル")), "{:?}", logs.lock().unwrap());
    // 画面の一覧にも、今の束の ZIP として出る
    let files = crate::chat_parts::JudgedFiles { judgments: &out.join("judgments.json"), turn_judgments: &out.join("turn-judgments.json"), tasks_dir: &notes };
    let parts = crate::chat_parts::list_chat_parts(&out, &files, crate::chat_parts::ChatTarget::Turns).unwrap();
    assert_eq!(parts.zip.as_ref().map(|z| z.path.as_str()), Some("turn-bundle.zip"));
    run(&cli(&["turns", "bundle", "--unjudged", "--out", &o, "--notes-dir", &n]), &log).unwrap();
    assert!(!zip.exists());
    assert!(logs.lock().unwrap().iter().any(|l| l.starts_with("turns bundle: 前に作った ZIP は中身が古くなったので消しました")));
}

/// 前の版の作業用の場所を消すとき(fs_retry::remove_tree = std の remove_dir_all)に、中の junction を辿らない(リンクの先の中身は消えない)
#[cfg(windows)]
#[test]
fn work_dir_removal_does_not_follow_junctions() {
    let d = tempfile::tempdir().unwrap();
    let (work, target) = (d.path().join("work"), d.path().join("target"));
    fs::create_dir_all(work.join("sub")).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("keep.txt"), "x").unwrap();
    let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(work.join("sub").join("link")).arg(&target).output().unwrap();
    assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stderr));
    assert!(work.join("sub").join("link").join("keep.txt").exists());
    atlas_core::fs_retry::remove_tree(&work).unwrap();
    assert!(!work.exists());
    assert!(target.join("keep.txt").exists());
}
