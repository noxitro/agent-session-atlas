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

/// turns の import・m365 も、judge と同じく効かない絞り込みを断る(bundle では絞り込みに使う)
#[test]
fn turns_rejects_filters_on_import_and_m365() {
    let d = tempfile::tempdir().unwrap();
    let (o, n) = (d.path().join("out").to_string_lossy().into_owned(), d.path().join("notes").to_string_lossy().into_owned());
    let e = run(&cli(&["turns", "import", "r.md", "--project", "p", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert_eq!(e, "--project は turns import では使えません(返答に入っている依頼をすべて取り込みます)");
    let e = run(&cli(&["turns", "import", "r.md", "--session", "ab", "--model", "m", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--session --model は turns import では使えません"), "{e}");
    let e = run(&cli(&["turns", "m365", "--since", "2026-11-01", "--task", "T", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--since --task は turns m365 では効きません。送るのは、作ってある添付(out/turn-bundle)のファイルです。"), "{e}");
    assert!(e.contains("bin\\atlas.exe turns bundle --since --task --unjudged で添付を作ってから turns m365"), "{e}");
    // m365 の --model は M365 Copilot のモデルの選択なので断らない。bundle の絞り込みも断らない
    assert!(cli(&["turns", "m365", "--model", "Auto"]).turns.unwrap().ignored_filters.is_empty());
    assert!(cli(&["turns", "bundle", "--project", "p", "--session", "ab"]).turns.unwrap().ignored_filters.is_empty());
}

/// tasks の import・m365 も、judge・turns と同じく効かない絞り込みを断る(何も取り込まず、送らない)
#[test]
fn tasks_rejects_filters_on_import_and_m365() {
    let d = tempfile::tempdir().unwrap();
    let (o, n) = (d.path().join("out").to_string_lossy().into_owned(), d.path().join("notes").to_string_lossy().into_owned());
    let e = run(&cli(&["tasks", "import", "r.md", "--project", "p", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert_eq!(e, "--project は tasks import では使えません(返答に入っているセッションの紐づけをすべて取り込みます)");
    let e = run(&cli(&["tasks", "import", "r.md", "--session", "ab", "--task", "T", "--model", "m", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--session --task --model は tasks import では使えません"), "{e}");
    let e = run(&cli(&["tasks", "m365", "--since", "2026-11-01", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.starts_with("--since は tasks m365 では効きません。送るのは、作ってある添付(out/task-bundle)のファイルです。"), "{e}");
    assert!(e.contains("bin\\atlas.exe tasks bundle --session <セッション id> で添付を作ってから tasks m365"), "{e}");
    // m365 の --model は M365 Copilot のモデルの選択なので断らない
    assert!(cli(&["tasks", "m365", "--model", "Auto"]).tasks_cmd.unwrap().ignored_filters.is_empty());
    // 断ったので、取り込みのファイルも紐づけも作っていない
    assert!(!d.path().join("notes").join("task-links.json").exists());
}

/// 取り込みの後の作り直しは、取り込みのコマンドの絞り込みと記録の出し方(--full など)を引き継がず、既定の出し方で作る。
/// 出力先・設定のフォルダは引き継ぐ
#[test]
fn export_after_import_drops_filters_and_transcript_options() {
    let o = cli(&[
        "export", "--since", "2026-01-01", "--project", "p", "--client", "c", "--model", "m", "--branch", "b", "--session", "ab", "--task", "T", "--full", "--tool-output", "all", "--max-chars", "500", "--out", "X", "--settings", "S",
    ]);
    let e = export_after_import(&CliOptions { command: "judge".into(), ..o });
    assert_eq!(e.command, "export");
    assert!(e.since.is_none() && e.project.is_none() && e.client.is_none() && e.model.is_none() && e.branch.is_none() && e.sessions.is_none() && e.task.is_none());
    assert_eq!((e.tool_output, e.max_chars, e.full), (crate::args::ToolOutput::Fail, None, false));
    assert_eq!((e.out.as_deref(), e.settings.as_deref()), (Some("X"), Some("S")));
    // 既定の export と、絞り込みと記録の出し方が同じ
    let plain = cli(&["export", "--out", "X", "--settings", "S"]);
    assert!(!metrics::has_filter(&metrics::SessionFilter::from_cli(&e)));
    assert_eq!((e.tool_output, e.max_chars, e.full), (plain.tool_output, plain.max_chars, plain.full));
}

/// 取り込めた後の作り直しに失敗したら、取り込みは済んでいることと作り直し方を添える(取り込んだ判定は残る)
#[test]
fn rebuild_failure_after_import_says_the_import_is_done() {
    let d = tempfile::tempdir().unwrap();
    let (home, out, notes) = (d.path().join("home"), d.path().join("out"), d.path().join("notes"));
    write_home_sessions(&home, &["aaaa1111", "bbbb2222"]);
    let (h, o, n) = (home.to_string_lossy().into_owned(), out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    run(&cli(&["all", "--home", &h, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    // レポートを書けないようにする(atlas.html をフォルダにする)
    fs::remove_file(out.join("atlas.html")).unwrap();
    fs::create_dir_all(out.join("atlas.html").join("x")).unwrap();
    let item = json!({
        "sessionId": "aaaa1111",
        "taskCategory": "feature",
        "taskSummary": "要約",
        "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
        "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
        "instructionsEffect": { "score": 1, "evidence": "e" },
        "wikiEffect": { "score": 0, "evidence": "参照なし" },
        "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
    });
    let reply = d.path().join("reply.json");
    fs::write(&reply, json!({ "schemaVersion": 2, "judge": { "backend": "external", "model": null, "ranAt": null }, "items": [item] }).to_string()).unwrap();
    let e = run(&cli(&["judge", "import", &reply.to_string_lossy(), "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err();
    let e = format!("{e:#}");
    assert!(e.ends_with(REBUILD_FAILED), "{e}");
    assert_eq!(REBUILD_FAILED, "取り込みは済んでいます。bin\\atlas.exe export でレポートを作り直してください");
    let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(out.join("judgments.json")).unwrap()).unwrap();
    assert_eq!(saved["items"][0]["sessionId"], "aaaa1111");
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

/// 工数の判定の項目(取り込める形。marker は前の判定の目印にする文字)
fn effort_item(id: &str, hours: f64, marker: &str) -> serde_json::Value {
    json!({
        "sessionId": id,
        "taskCategory": "bugfix",
        "taskSummary": format!("要約 {marker}"),
        "humanEffort": { "hours": hours, "low": hours / 2.0, "high": hours * 2.0, "confidence": 0.8, "rationale": format!("根拠 {marker}") },
        "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": format!("成果 {marker}") },
        "instructionsEffect": { "score": 0, "evidence": "なし" },
        "wikiEffect": { "score": 0, "evidence": "参照なし" },
        "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
    })
}

/// 束のフォルダの中のファイルをすべて読む
fn read_tree(dir: &std::path::Path) -> String {
    let mut out = String::new();
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.push_str(&read_tree(&p));
        } else {
            out.push_str(&String::from_utf8_lossy(&fs::read(&p).unwrap()));
        }
    }
    out
}

/// bundle --rejudge n: 判定より前に終わっていた判定済みのセッションだけで束を作る。パケットには前の判定を入れない(目隠し)。
/// manifest に判定し直す束であることと、そのときの判定の日時を書き、判定し直したものを画面の一覧で「済み」と数える。
/// 選べるものが無ければ止まる(前の束は残る)
#[test]
fn rejudge_bundle_picks_unchanged_sessions_without_the_previous_judgment() {
    let d = tempfile::tempdir().unwrap();
    let (home, out, notes) = (d.path().join("home"), d.path().join("out"), d.path().join("notes"));
    write_home_sessions(&home, &["aaaa1111", "bbbb2222", "dddd4444"]);
    // 依頼の記録が無いセッション(束の対象外)。判定済みでも、--include-empty でなければ選ばない
    write_home_session_without_request(&home, "cccc3333");
    let (h, o, n) = (home.to_string_lossy().into_owned(), out.to_string_lossy().into_owned(), notes.to_string_lossy().into_owned());
    run(&cli(&["all", "--home", &h, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    // 判定のないときは選べない
    let e = run(&cli(&["bundle", "--rejudge", "3", "--out", &o, "--notes-dir", &n]), &quiet).unwrap_err().to_string();
    assert!(e.contains("判定し直せるセッションがありません"), "{e}");
    // aaaa は終わり(7/1 09:02)の後に判定、bbbb は終わる前に判定(後から記録が続いたので選ばない)。dddd は未判定
    let reply = d.path().join("reply.json");
    let rs = reply.to_string_lossy().into_owned();
    fs::write(&reply, json!({ "judge": { "model": "m-a", "ranAt": "2026-07-02T00:00:00.000Z" }, "items": [effort_item("aaaa1111", 2.0, "前の判定の目印")] }).to_string()).unwrap();
    run(&cli(&["judge", "import", &rs, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    fs::write(&reply, json!({ "judge": { "model": "m-a", "ranAt": "2026-07-01T09:01:30.000Z" }, "items": [effort_item("bbbb2222", 2.0, "前の判定の目印")] }).to_string()).unwrap();
    run(&cli(&["judge", "import", &rs, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    fs::write(&reply, json!({ "judge": { "model": "m-a", "ranAt": "2026-07-02T00:00:00.000Z" }, "items": [effort_item("cccc3333", 1.0, "前の判定の目印")] }).to_string()).unwrap();
    run(&cli(&["judge", "import", &rs, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    let logs: Mutex<Vec<String>> = Mutex::new(vec![]);
    let log = |m: &str| logs.lock().unwrap().push(m.to_string());
    let paths = crate::paths::resolve_paths(crate::paths::PathInputs { home: Some(&h), out: Some(&o), judgments: None, bundle: None, notes_dir: Some(&n) });
    let opts = |n: u64, zip: bool| super::bundle::BundleCliOptions { include_empty: false, per_part: None, unjudged: false, rejudge: Some(n), zip, config: None };
    // --include-empty なら、依頼の記録が無いセッションも選び、束にも入る(数が合う)
    let with_empty = super::bundle::run_bundle(&paths, &super::metrics::SessionFilter::default(), &super::bundle::BundleCliOptions { include_empty: true, ..opts(5, false) }, &quiet).unwrap();
    let mut ids: Vec<&str> = with_empty.sessions.iter().map(|s| s.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["aaaa1111", "cccc3333"]);
    let m = super::bundle::run_bundle(&paths, &super::metrics::SessionFilter::default(), &opts(5, true), &log).unwrap();
    assert_eq!(m.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["aaaa1111"]);
    assert_eq!(m.scope.get("rejudge").cloned().flatten().as_deref(), Some("5"));
    assert_eq!(m.scope.get("unjudged").cloned().flatten(), None);
    assert_eq!(m.rejudge_from.as_ref().unwrap().get("aaaa1111").map(String::as_str), Some("2026-07-02T00:00:00.000Z"));
    assert!(logs.lock().unwrap().iter().any(|l| l.starts_with("bundle: 判定し直すセッション 1 件を選びました(--rejudge 5。判定済み 2 件のうち、判定より前に終わっていたもの 1 件")), "{:?}", logs.lock().unwrap());
    // 目隠し: 束のどのファイル(パケット・分割ファイル・指示・manifest)にも、前の判定の中身は無い。ZIP にも無い
    let all = read_tree(&out.join("bundle"));
    assert!(all.contains("直して"), "パケットにセッションの記録が入っている");
    assert!(!all.contains("前の判定の目印"));
    assert!(!String::from_utf8_lossy(&fs::read(out.join("bundle.zip")).unwrap()).contains("前の判定の目印"));
    // 画面の一覧: 判定し直す束で、まだ判定し直していない
    let files = crate::chat_parts::JudgedFiles { judgments: &out.join("judgments.json"), turn_judgments: &out.join("turn-judgments.json"), tasks_dir: &notes };
    let parts = crate::chat_parts::list_chat_parts(&out, &files, crate::chat_parts::ChatTarget::Effort).unwrap();
    assert_eq!((parts.rejudge, parts.unjudged_only, parts.judged, parts.parts.as_ref().unwrap()[0].judged), (Some(5), Some(false), Some(0), 0));
    // 判定し直した返答を取り込むと「済み」になり、前の判定は履歴に移る
    fs::write(&reply, json!({ "judge": { "model": "m-b", "ranAt": "2026-07-03T00:00:00.000Z" }, "items": [effort_item("aaaa1111", 3.0, "後")] }).to_string()).unwrap();
    run(&cli(&["judge", "import", &rs, "--out", &o, "--notes-dir", &n]), &quiet).unwrap();
    let parts = crate::chat_parts::list_chat_parts(&out, &files, crate::chat_parts::ChatTarget::Effort).unwrap();
    assert_eq!(parts.judged, Some(1));
    let hist = atlas_judge::judgments_io::read_history(&out.join("judgments-history.json")).unwrap().unwrap();
    assert_eq!(hist.items.len(), 1);
    assert_eq!(hist.items[0].item.judge.as_ref().map(|j| j.ran_at.as_str()), Some("2026-07-02T00:00:00.000Z"));
    // 表(judgment-repeats.csv と SQLite)に 1 組。作り直したレポートにも判定のぶれが入る
    let csv = fs::read_to_string(out.join("tables").join("judgment-repeats.csv")).unwrap();
    let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
    assert_eq!(lines.len(), 2, "{csv}");
    assert!(lines[1].starts_with("aaaa1111,"), "{}", lines[1]);
    assert!(lines[1].contains("2026-07-02T00:00:00.000Z,2026-07-03T00:00:00.000Z,m-a,m-b"), "{}", lines[1]);
    let db = rusqlite::Connection::open(out.join("tables").join(crate::tables::SQLITE_FILE)).unwrap();
    let k: i64 = db.query_row("SELECT count(*) FROM judgment_repeats", [], |r| r.get(0)).unwrap();
    assert_eq!(k, 1);
    drop(db);
    let html = fs::read_to_string(out.join("atlas.html")).unwrap();
    assert!(html.contains("\"judgmentRepeats\":{\"pairs\":1,"), "判定のぶれが埋め込まれていない");
    // 判定し直したものは後ろに回る(選べるのが判定し直したものだけなら、それを選ぶ)
    let m2 = super::bundle::run_bundle(&paths, &super::metrics::SessionFilter::default(), &opts(1, false), &log).unwrap();
    assert_eq!(m2.sessions.len(), 1);
    // 引数: --unjudged と一緒には使えない。bundle のほかでは使えない。数の範囲
    let p = |a: &[&str]| crate::args::parse_cli(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert!(p(&["bundle", "--rejudge", "3", "--unjudged"]).unwrap_err().0.contains("--rejudge と --unjudged は一緒に使えません"));
    assert!(p(&["turns", "bundle", "--rejudge", "3"]).unwrap_err().0.starts_with("--rejudge は bundle でだけ使えます"));
    assert!(p(&["bundle", "--rejudge", "0"]).unwrap_err().0.contains("1 以上の整数"));
    assert!(p(&["bundle", "--rejudge", "1001"]).unwrap_err().0.contains("1000 以下"));
    assert_eq!(p(&["bundle", "--rejudge", "7", "--zip"]).unwrap().rejudge, Some(7));
}

/// 画面のジョブ: bundle・bundle-zip に rejudge を付けると、判定し直す束(--rejudge n。--unjudged は付けない)。種類は同じ
#[test]
fn rejudge_jobs() {
    let known = |_: &str| true;
    let parse = |v: serde_json::Value| crate::jobs::parse_job_request(v.as_object().unwrap(), &known);
    let r = parse(json!({ "kind": "bundle-zip", "rejudge": 12 })).unwrap();
    assert_eq!(r, JobRequest::Rejudge { n: 12, zip: true });
    assert_eq!(r.kind(), "bundle-zip");
    assert_eq!(parse(json!({ "kind": "bundle", "rejudge": 3 })).unwrap().kind(), "bundle");
    for bad in [json!(0), json!(1.5), json!("3"), json!(1001)] {
        assert_eq!(parse(json!({ "kind": "bundle", "rejudge": bad })).unwrap_err().status, 400);
    }
    // 工数の束のほかでは使えない
    assert_eq!(parse(json!({ "kind": "turn-bundle", "rejudge": 3 })).unwrap_err().status, 400);
    let p = JobArgsInput { out_dir: "o", notes_dir: "n", home: None, settings: Some("S"), judgments: Some("J") };
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let a = job_args(&JobRequest::Rejudge { n: 12, zip: true }, &p).unwrap();
    assert_eq!(a, v(&["bundle", "--rejudge", "12", "--zip", "--out", "o", "--notes-dir", "n", "--settings", "S", "--judgments", "J"]));
    assert_eq!(crate::args::parse_cli(&a).unwrap().rejudge, Some(12));
    assert_eq!(job_args(&JobRequest::Rejudge { n: 2, zip: false }, &p).unwrap()[..3], v(&["bundle", "--rejudge", "2"])[..]);
}
