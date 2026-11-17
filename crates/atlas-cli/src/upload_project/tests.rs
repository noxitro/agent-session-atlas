//! upload_project.rs のテスト(packages/cli/test/upload-project.test.ts の振る舞いを決めている部分)

use super::*;
use std::fs;
use std::sync::Mutex;

/// 答えを順に返し、選ぶ画面は picks を順に返す io(尋ねた文と表示した行を残す)
pub(crate) struct Scripted {
    answers: Mutex<Vec<String>>,
    picks: Mutex<Vec<Option<String>>>,
    pub asked: Mutex<Vec<String>>,
    pub printed_lines: Mutex<Vec<String>>,
    pub picked_from: Mutex<Vec<Option<String>>>,
    pub statuses: Option<Mutex<Vec<String>>>,
    /// 尋ねたときに動かす(確かめた後にログを書き換えるなど)
    pub on_ask: Option<Box<dyn Fn(&str) + Sync>>,
}

impl Scripted {
    pub fn new(answers: &[&str]) -> Self {
        Scripted::with(answers, vec![])
    }
    pub fn with(answers: &[&str], picks: Vec<Option<String>>) -> Self {
        Scripted {
            answers: Mutex::new(answers.iter().rev().map(|s| s.to_string()).collect()),
            picks: Mutex::new(picks.into_iter().rev().collect()),
            asked: Mutex::default(),
            printed_lines: Mutex::default(),
            picked_from: Mutex::default(),
            statuses: None,
            on_ask: None,
        }
    }
    pub fn printed(&self) -> String {
        self.printed_lines.lock().unwrap().join("\n")
    }
}

impl ConsoleIo for Scripted {
    fn ask(&self, q: &str) -> String {
        self.asked.lock().unwrap().push(q.into());
        if let Some(f) = &self.on_ask {
            f(q);
        }
        self.answers.lock().unwrap().pop().unwrap_or_default()
    }
    fn print(&self, line: &str) {
        self.printed_lines.lock().unwrap().push(line.into());
    }
    fn pick(&self, initial: Option<&str>) -> Result<Option<String>> {
        self.picked_from.lock().unwrap().push(initial.map(str::to_string));
        Ok(self.picks.lock().unwrap().pop().flatten())
    }
    fn status(&self, text: &str) {
        if let Some(s) = &self.statuses {
            s.lock().unwrap().push(text.into());
        }
    }
    fn has_status(&self) -> bool {
        self.statuses.is_some()
    }
}

struct Env {
    _t: tempfile::TempDir,
    dir: PathBuf,
    out: PathBuf,
    config: String,
    root_a: PathBuf,
    root_b: PathBuf,
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().to_path_buf();
    let out = dir.join("out");
    let (root_a, root_b) = (dir.join("logs-a"), dir.join("logs-b"));
    fs::create_dir_all(&root_a).unwrap();
    fs::create_dir_all(&root_b).unwrap();
    let sessions = serde_json::json!([
        { "id": "s1", "project": "owner/app", "projectSource": "git-remote", "empty": false, "updatedAt": "2026-11-01T00:00:00.000Z" },
        { "id": "s2", "project": "owner/app", "empty": false, "updatedAt": "2026-11-03T00:00:00.000Z" },
        { "id": "s3", "project": "owner/app", "empty": true, "updatedAt": "2026-11-04T00:00:00.000Z" },
        { "id": "s4", "project": "X:\\work\\tool", "empty": false, "updatedAt": "2026-10-01T00:00:00.000Z" },
    ]);
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("sessions.json"), serde_json::json!({ "sessions": sessions }).to_string()).unwrap();
    for s in sessions.as_array().unwrap() {
        let id = s["id"].as_str().unwrap();
        let d = out.join("snapshot").join("session-state").join(id);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("events.jsonl"), format!("{{\"id\":\"{id}\"}}\n")).unwrap();
    }
    Env { config: dir.join("atlas.config.json").to_string_lossy().into_owned(), dir, out, root_a, root_b, _t: t }
}

fn paths(e: &Env) -> GroupUploadPaths {
    GroupUploadPaths { snapshot: e.out.join("snapshot"), groups: e.dir.join("notes").join("groups.json"), notes: None, sessions: Some(e.out.join("sessions.json")) }
}

fn opts<'a>(e: &Env, auto: bool, summary: Option<&'a Mutex<UploadSummary>>) -> UploadProjectOptions<'a> {
    UploadProjectOptions { paths: paths(e), config_path: e.config.clone(), auto, summary }
}

fn config(e: &Env, v: serde_json::Value) {
    fs::write(&e.config, v.to_string()).unwrap();
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn token(body: &str) -> String {
    ["ghp", body].join("_")
}

#[test]
fn projects_are_listed_and_no_log_is_counted() {
    let e = env();
    let records = read_sessions(&e.out.join("sessions.json")).unwrap();
    let l = list_projects(&records, None);
    assert_eq!(l.iter().map(|p| (p.name.as_str(), p.sessions, p.no_log)).collect::<Vec<_>>(), vec![("owner/app", 2, 0), ("X:\\work\\tool", 1, 0)]);
    assert_eq!(l[0].updated_at.as_deref(), Some("2026-11-03T00:00:00.000Z"));
    assert_eq!(project_target(&e.out.join("snapshot"), "owner/app", &records).unwrap().ids, vec!["s1", "s2"]);
    assert!(project_target(&e.out.join("snapshot"), "無い", &records).unwrap_err().to_string().contains("前回の集計にありません"));
    fs::remove_dir_all(e.out.join("snapshot").join("session-state").join("s2")).unwrap();
    let l = list_projects(&records, Some(&e.out.join("snapshot")));
    assert_eq!((l[0].sessions, l[0].no_log, l[0].updated_at.as_deref()), (1, 1, Some("2026-11-01T00:00:00.000Z")));
    let io = Scripted::new(&[""]);
    run_upload_project(&io, &opts(&e, false, None)).unwrap();
    assert!(Regex::new(r"1\. owner/app +1 セッション +最終更新 2026-11-01\(ほかに、ログが無くて送れないもの 1 件\)").unwrap().is_match(&io.printed()));
}

#[test]
fn changed_after_check_is_rechecked() {
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    let ev = e.out.join("snapshot").join("session-state").join("s1").join("events.jsonl");
    let changed = Mutex::new(false);
    let mut io = Scripted::new(&["1", "y", ""]);
    io.on_ask = Some(Box::new(move |q: &str| {
        let mut c = changed.lock().unwrap();
        if q.contains("y = 送る") && !*c {
            *c = true;
            fs::write(&ev, format!("{}\n", serde_json::json!({ "data": token("CHANGEDFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE") }))).unwrap();
        }
    }));
    assert!(!run_upload_project(&io, &opts(&e, false, None)).unwrap());
    let text = io.printed();
    assert!(text.contains("確かめた後に、写すログが変わりました"));
    assert!(text.contains("秘密らしい文字列が 1 件あります"));
    assert!(!e.root_a.join("owner_app").exists());
}

#[test]
fn lost_root_is_chosen_again_and_busy_out_stops() {
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.dir.join("gone")) }));
    let io = Scripted::with(&["1", "y"], vec![Some(s(&e.root_b))]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert!(io.printed().contains("覚えている送り先が見つかりません"));
    assert_eq!(js::parse_json(&fs::read_to_string(&e.config).unwrap()).unwrap(), serde_json::json!({ "uploadRoot": s(&e.root_b) }));
    assert!(e.root_b.join("owner_app").join("s1").exists());
    // 集計し直している最中(out/.job.json を別の生きている処理が持つ)は送らずに止まる
    let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "ping -n 5 127.0.0.1 >nul"] } else { ["-c", "sleep 5"] }).spawn().unwrap();
    fs::write(e.out.join(".job.json"), serde_json::json!({ "pid": child.id(), "kind": "refresh", "by": "serve" }).to_string()).unwrap();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    let err = run_upload_project(&Scripted::new(&["1", "y"]), &opts(&e, false, None)).unwrap_err().to_string();
    let _ = child.kill();
    let _ = child.wait();
    assert!(Regex::new("動いています.*何も送っていません").unwrap().is_match(&err), "{err}");
    assert!(!e.root_a.join("owner_app").exists());
}

#[test]
fn tags_are_written_and_root_is_remembered() {
    let e = env();
    fs::create_dir_all(e.dir.join("notes")).unwrap();
    fs::write(e.dir.join("notes").join("groups.json"), serde_json::json!({ "version": 1, "groups": [{ "name": "Player-Weapon", "note": "", "ids": ["s1", "s4"] }, { "name": "調査", "note": "", "ids": ["s1"] }] }).to_string()).unwrap();
    // 送り先が未定ならエクスプローラーで選んで覚える
    let io = Scripted::with(&["1", "y"], vec![Some(s(&e.root_a))]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert_eq!(*io.picked_from.lock().unwrap(), vec![None]);
    let dest = e.root_a.join("owner_app");
    let index = js::parse_json(&fs::read_to_string(dest.join("atlas-index.json")).unwrap()).unwrap();
    assert_eq!(index["kind"], "project");
    assert_eq!(index["sessions"][0]["tags"], serde_json::json!(["Player-Weapon", "調査"]));
    assert_eq!(index["sessions"][1]["tags"], serde_json::json!([]));
    let meta = js::parse_json(&fs::read_to_string(dest.join("s1").join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta["projectSource"], "git-remote");
    let meta2 = js::parse_json(&fs::read_to_string(dest.join("s2").join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta2["projectSource"], serde_json::Value::Null);
    let readme = fs::read_to_string(dest.join("README.md")).unwrap();
    assert!(readme.starts_with("# owner/app\n\n集計のプロジェクト「owner/app」のセッション"));
    assert!(readme.contains("| [s1](s1/) | - | Player-Weapon、調査 |"));
    assert!(readme.contains("| [s2](s2/) | - | タグなし |"));
    assert!(Regex::new(r"## タスクタグごと\n\n### Player-Weapon\(1 件\)\n\n- \[s1\]\(s1/\)(?s:.)*### 調査\(1 件\)(?s:.)*### タグなし\(1 件\)\n\n- \[s2\]\(s2/\)").unwrap().is_match(&readme));
    assert!(io.printed().contains(&format!("送り先: {}", dest.display())));
}

#[test]
fn many_projects_change_root_and_recheck_numbers() {
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    // c で送り先を選び直して覚える
    let io = Scripted::with(&["2", "c", "y"], vec![Some(s(&e.root_b))]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert_eq!(*io.picked_from.lock().unwrap(), vec![Some(s(&e.root_a))]);
    assert!(e.root_b.join("X__work_tool").join("s4").join("events.jsonl").exists());
    // 当たらない番号は尋ね直す
    let io = Scripted::new(&["9", "3-1", ""]);
    assert!(!run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert!(io.printed().contains("「9」に当たるプロジェクトがありません。一覧の番号(1〜2)か名前を入れ直してください。"));
    assert_eq!(io.asked.lock().unwrap().iter().filter(|q| q.contains("番号を入れて Enter")).count(), 3);
    // 番号を複数選ぶと、まとめて確かめてからすべて送る
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    let io = Scripted::new(&["1 2", "y"]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    let text = io.printed();
    assert!(text.contains(&format!("送り先: {}(この中にプロジェクトごとのフォルダを作ります)", e.root_a.display())));
    for re in [r"1\. owner/app +2 セッション", r"2\. X:\\work\\tool +1 セッション", r"合計 +3 セッション", r"\[1/2\] owner/app +2 セッションを送りました", r"\[2/2\] X:\\work\\tool +1 セッションを送りました"] {
        assert!(Regex::new(re).unwrap().is_match(&text), "{re}\n{text}");
    }
    assert!(text.contains("== 終わりました =="));
    assert!(text.contains("2 プロジェクト・3 セッションを送りました。"));
    assert!(text.contains("毎回同じものを送るなら"));
    // 2 回目: 変わったセッションだけを送る
    fs::write(e.out.join("snapshot").join("session-state").join("s1").join("events.jsonl"), "{\"id\":\"s1\",\"more\":true}\n").unwrap();
    let io = Scripted::new(&["1-2", "y"]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert!(io.printed().contains("うち 1 セッションは、前に送ったものを置き換えます。"));
    assert!(io.printed().contains("2 プロジェクト・1 セッションを送りました(変わっていない 2 セッションはそのまま)。"));
    let io = Scripted::new(&["1-2", "y"]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    assert!(io.asked.lock().unwrap().iter().any(|q| q.contains("y = 送り先の一覧(README.md)だけ書き直す   n = 番号で選び直す   c = 送り先を変える")));
    assert!(io.printed().contains("2 プロジェクト・0 セッションを送りました(変わっていない 3 セッションはそのまま)。"));
}

#[test]
fn marked_and_auto() {
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a), "uploadProjects": ["X:\\work\\tool", "消えたプロジェクト"] }));
    let io = Scripted::new(&["y"]);
    assert!(run_upload_project(&io, &opts(&e, false, None)).unwrap());
    let text = io.printed();
    assert!(text.contains("画面で印を付けた 1 プロジェクトを送ります。"));
    assert!(text.contains("印はあるが、送れるセッションが無いもの: 消えたプロジェクト"));
    assert!(text.contains("印の無い 1 プロジェクトは送りません(最近更新: owner/app)。"));
    assert!(!text.contains("毎回同じものを送るなら"));
    // 自動で送る: 何も尋ねずに送り、送ったものと秘密らしい文字列の数を summary に書く
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a), "uploadProjects": ["owner/app", "X:\\work\\tool"] }));
    fs::write(e.out.join("snapshot").join("session-state").join("s4").join("events.jsonl"), format!("{}\n", serde_json::json!({ "data": token("AUTOFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE") }))).unwrap();
    let io = Scripted::new(&[]);
    let summary = Mutex::new(UploadSummary::default());
    assert!(run_upload_project(&io, &opts(&e, true, Some(&summary))).unwrap());
    assert!(io.asked.lock().unwrap().is_empty());
    let s2 = summary.into_inner().unwrap();
    assert_eq!(s2.sent.iter().map(|p| (p.name.as_str(), p.sessions)).collect::<Vec<_>>(), vec![("owner/app", 2.0), ("X:\\work\\tool", 1.0)]);
    assert_eq!((s2.secrets, s2.root.as_deref()), (1, Some(s(&e.root_a).as_str())));
    assert!(io.printed().contains("印を付けた 2 プロジェクトを送ります: owner/app、X:\\work\\tool"));
    // 印が無ければ、尋ねないと進めないので止まる(何も送らない)
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    let err = run_upload_project(&Scripted::new(&[]), &opts(&e, true, None)).unwrap_err();
    assert!(err.is::<AutoUploadBlockedError>());
}

#[test]
fn incomplete_and_same_folder_names() {
    let e = env();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a), "uploadProjects": ["owner/app"] }));
    fs::write(e.root_a.join("owner_app"), "ファイル").unwrap();
    let io = Scripted::new(&["y"]);
    let err = run_upload_project(&io, &opts(&e, false, None)).unwrap_err();
    assert!(err.is::<UploadIncompleteError>());
    assert!(io.printed().contains("== 送れなかったものがあります =="));
    // フォルダ名が同じになるプロジェクトを一度に選ぶと、何も送らずに止まる
    let e = env();
    let mut v: serde_json::Value = js::parse_json(&fs::read_to_string(e.out.join("sessions.json")).unwrap()).unwrap();
    v["sessions"].as_array_mut().unwrap().push(serde_json::json!({ "id": "s5", "project": "owner_app", "empty": false }));
    fs::write(e.out.join("sessions.json"), v.to_string()).unwrap();
    fs::create_dir_all(e.out.join("snapshot").join("session-state").join("s5")).unwrap();
    config(&e, serde_json::json!({ "uploadRoot": s(&e.root_a) }));
    let err = run_upload_project(&Scripted::new(&["1-3"]), &opts(&e, false, None)).unwrap_err().to_string();
    assert!(err.contains("送り先のフォルダ名が同じ「owner_app」になります"), "{err}");
}

#[test]
fn numbers_width_and_fit() {
    assert_eq!(parse_numbers("1 3 5-8", 9), Some(vec![1, 3, 5, 6, 7, 8]));
    assert_eq!(parse_numbers("3,1、3", 3), Some(vec![3, 1]));
    assert_eq!(parse_numbers("２ １－２", 2), Some(vec![2, 1]));
    assert_eq!(parse_numbers("1, 2 - 3", 3), Some(vec![1, 2, 3]));
    assert_eq!(parse_numbers("3 〜 3", 3), Some(vec![3]));
    for bad in ["0", "4", "2-1", "1-4", "a", "1 x", "", "-1", "99999999999999999999999"] {
        assert_eq!(parse_numbers(bad, 3), None, "{bad}");
    }
    assert_eq!(width("owner/app"), 9);
    assert_eq!(width("送り先(abc)"), 11);
    assert_eq!(width("ＡＢ"), 4);
    assert_eq!(fit("写しています abc", 7), "写して");
    assert_eq!(fit("abc", 10), "abc");
    assert_eq!(width("☕a"), 3);
    assert_eq!(width("✅"), 2);
    assert_eq!(width("✔\u{fe0f}"), 2);
    assert_eq!(width("e\u{301}"), 1);
    assert_eq!(width("a\u{200d}b"), 2);
    assert_eq!(fit("☕☕", 3), "☕");
    assert!(width(&fit("✔\u{fe0f}✔\u{fe0f}✔\u{fe0f}", 5)) <= 5);
    assert_eq!(width("🇯🇵"), 2);
    assert_eq!(width("🇯🇵🇺🇸"), 4);
    assert_eq!(width("👨\u{200d}👩\u{200d}👧"), 2);
    assert_eq!(width("a👨\u{200d}👩b"), 4);
    assert_eq!(width("👍🏽"), 2);
    assert_eq!(width("👋🏻a"), 3);
    assert_eq!(width("🏽"), 2);
    assert_eq!(width("a\u{ad}b"), 3);
    assert_eq!(width(&fit("👍🏽👍🏽👍🏽", 5)), 4);
    assert_eq!(width("漢🏽"), 4);
    assert_eq!(width("a🏽"), 3);
    assert_eq!(width("☝🏽"), 2);
    assert_eq!(width("👍🏽🏽"), 4);
}

#[test]
fn refresh_shows_stages_and_notices_and_failures() {
    let d = tempfile::tempdir().unwrap();
    let log_path = d.path().join("upload.log");
    let mut io = Scripted::new(&[]);
    io.statuses = Some(Mutex::default());
    let ok = refresh_aggregate(&io, &log_path, &|log| {
        log("snapshot: 12 セッション");
        log("snapshot: 注意 session-store.db を\n複製できず前回の複製を使いました");
        log("extract: 注意 伏せた文字列 3 件");
        log("レポートのテンプレートをビルドしています…\n2 行目");
        log("build: 完了");
        Ok(())
    });
    assert!(ok);
    let st = io.statuses.as_ref().unwrap().lock().unwrap().clone();
    assert_eq!(st, vec!["  ログを写しています...", "  ログを読んでいます...", "  レポートのテンプレートをビルドしています… 2 行目", "  レポートを作っています..."]);
    let text = io.printed();
    assert!(text.contains("  注意: session-store.db を 複製できず前回の複製を使いました"));
    assert!(!text.contains("伏せた文字列"));
    assert!(text.ends_with("  集計しました。"));
    let file = fs::read_to_string(&log_path).unwrap();
    assert!(file.starts_with("snapshot: 12 セッション\n"));
    assert!(file.contains("extract: 注意 伏せた文字列 3 件\n"));
    // 失敗したら、理由と経過のファイルの場所を出して false
    let io = Scripted::new(&[]);
    assert!(!refresh_aggregate(&io, &log_path, &|_| Err(anyhow!("集計が\n止まった"))));
    let text = io.printed();
    assert!(text.contains("  集計に失敗しました: 集計が 止まった"));
    assert!(text.contains(&format!("  集計の経過: {}", log_path.display())));
    assert!(fs::read_to_string(&log_path).unwrap().contains("失敗しました: 集計が\n止まった"));
}

/// 書いたものを残す出力
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Sink {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

#[test]
fn console_status_and_piped_input() {
    // 端末なら status で 1 行を窓の幅に収めて書き、次の print の前に消す
    let out = Sink::default();
    let c = Console::with(Box::new(out.clone()), true, 20, Box::new(std::io::Cursor::new(Vec::new())), false);
    c.status(&format!("  {}", "あ".repeat(30)));
    assert_eq!(c.last_status(), format!("  {}", "あ".repeat(8)));
    c.print("結果");
    let all = out.text();
    assert!(all.find("\x1b[2K").unwrap() > all.find('あ').unwrap());
    assert!(all.ends_with("結果\n"));
    // 書き換える行が無ければ、消す制御文字は書かない
    let out = Sink::default();
    let c = Console::with(Box::new(out.clone()), true, 20, Box::new(std::io::Cursor::new(Vec::new())), false);
    c.print("a");
    assert_eq!(out.text(), "a\n");
    // 端末でなければ status を持たない
    let out = Sink::default();
    let c = Console::with(Box::new(out.clone()), false, 80, Box::new(std::io::Cursor::new(b"1\r\n y \n".to_vec())), false);
    assert!(!c.has_status());
    c.status("x");
    // 流し込んだ入力では、届いた行を順に答えに使い、終わったら空
    assert_eq!(c.ask("> "), "1");
    assert_eq!(c.ask("> "), "y");
    assert_eq!(c.ask("> "), "");
    assert_eq!(out.text(), "> > > ");
    // status は改行を空白にして 1 行にする
    let out = Sink::default();
    let c = Console::with(Box::new(out.clone()), true, 80, Box::new(std::io::Cursor::new(Vec::new())), false);
    c.status("a\nb\tc");
    assert_eq!(c.last_status(), "a b c");
}
