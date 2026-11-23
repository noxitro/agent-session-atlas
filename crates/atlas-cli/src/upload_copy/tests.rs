//! upload_copy.rs のテスト(packages/cli/test/group-upload.test.ts の振る舞いを決めている部分。写すまとまりはプロジェクトの形で作る)

use super::*;
use serde_json::json;
use std::fs;

struct Env {
    _t: tempfile::TempDir,
    dir: PathBuf,
    out: PathBuf,
    notes: PathBuf,
    root: PathBuf,
}

/// トークンの形をソースに直書きしない(秘密の検査に引っかからないように)
fn token() -> String {
    ["ghp", "UPLOADFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK1"].join("_")
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().to_path_buf();
    let out = dir.join("out");
    let notes = dir.join("notes");
    let root = dir.join("logs");
    for id in ["s1", "s2"] {
        let d = out.join("snapshot").join("session-state").join(id);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("events.jsonl"), format!("{{\"type\":\"session.start\",\"id\":\"{id}\"}}\n")).unwrap();
        fs::write(d.join(".session.db.src"), "1:2").unwrap();
    }
    let files = out.join("snapshot").join("session-state").join("s1").join("files");
    fs::create_dir_all(&files).unwrap();
    fs::write(files.join("a.txt"), "a").unwrap();
    fs::write(out.join("snapshot").join("snapshot-manifest.json"), json!({ "createdAt": "2026-11-08T01:02:03.000Z" }).to_string()).unwrap();
    fs::create_dir_all(&notes).unwrap();
    fs::create_dir_all(&root).unwrap();
    Env { _t: t, dir, out, notes, root }
}

fn paths(e: &Env) -> UploadPaths {
    UploadPaths { snapshot: e.out.join("snapshot"), notes: None, sessions: None }
}

fn with_notes(e: &Env) -> UploadPaths {
    UploadPaths { notes: Some(e.notes.clone()), ..paths(e) }
}

/// 写すまとまり(フォルダ名に直す文字と、記録に無い id・フォルダの外を指す id を含む)
fn target_of(name: &str, note: &str, ids: &[&str]) -> UploadTarget {
    UploadTarget { kind: "project".into(), name: name.into(), note: note.into(), ids: ids.iter().map(|x| x.to_string()).collect() }
}

fn target() -> UploadTarget {
    target_of("Player/Weapon", "", &["s1", "s2", "gone", "../s1"])
}

fn upload_with(p: &UploadPaths, root: &Path, opts: &UploadOptions<'_>) -> Result<UploadResult> {
    upload_target(p, &target(), root, &|_| {}, opts)
}

fn up(p: &UploadPaths, root: &Path) -> UploadResult {
    upload_with(p, root, &UploadOptions::default()).unwrap()
}

fn check(p: &UploadPaths, root: &Path) -> UploadCheck {
    check_target(p, &target(), root, None, false).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn state(e: &Env, id: &str) -> PathBuf {
    e.out.join("snapshot").join("session-state").join(id)
}

#[test]
fn copies_sessions_and_skips_work_files_and_bad_ids() {
    let e = env();
    let r = up(&paths(&e), &e.root);
    assert_eq!(
        r,
        UploadResult {
            name: "Player/Weapon".into(),
            dir: e.root.join("Player_Weapon").to_string_lossy().into_owned(),
            uploaded: 2,
            replaced: 0,
            unchanged: 0,
            stale_meta: vec![],
            missing: vec!["gone".into(), "../s1".into()],
            snapshot_at: Some("2026-11-08T01:02:03.000Z".into()),
            memos: 0,
            leftovers: vec![],
        }
    );
    let dir = PathBuf::from(&r.dir);
    assert_eq!(names(&dir), vec!["README.md", "atlas-index.json", "s1", "s2"]);
    assert_eq!(names(&dir.join("s1")), vec!["atlas-session.json", "events.jsonl", "files"]);
    assert!(!dir.join("s1").join("atlas-session-store.json").exists());
    // 送り先で足されたファイルがあるセッションは置き換え、変わっていないものは写さない
    fs::write(dir.join("s2").join("old.txt"), "x").unwrap();
    let r2 = up(&paths(&e), &e.root);
    assert_eq!((r2.uploaded, r2.replaced, r2.unchanged), (1, 1, 1));
    assert!(!dir.join("s2").join("old.txt").exists());
    // 退けた前のフォルダだけが残っているものも、新しいフォルダを置けたら消す
    fs::rename(dir.join("s2"), dir.join(".s2.old")).unwrap();
    let r3 = up(&paths(&e), &e.root);
    assert_eq!((r3.uploaded, r3.replaced, r3.unchanged, r3.leftovers.len()), (1, 0, 1, 0));
    // full なら全部写し直す
    let r4 = upload_with(&paths(&e), &e.root, &UploadOptions { full: true, ..Default::default() }).unwrap();
    assert_eq!((r4.uploaded, r4.replaced, r4.unchanged), (2, 2, 0));
    assert_eq!(names(&dir), vec!["README.md", "atlas-index.json", "s1", "s2"]);
    assert_eq!(upload_dir(&e.root, "con"), e.root.join("_con"));
}

#[test]
fn second_upload_sends_only_changed() {
    let e = env();
    let p = with_notes(&e);
    let r = up(&p, &e.root);
    let dir = PathBuf::from(&r.dir);
    let meta = js::parse_json(&fs::read_to_string(dir.join("s1").join("atlas-session.json")).unwrap()).unwrap();
    assert!(Regex::new("^[0-9a-f]{64}$").unwrap().is_match(meta["contents"].as_str().unwrap()));
    let cnt = |r: &UploadResult| (r.uploaded, r.unchanged);
    assert_eq!(cnt(&up(&p, &e.root)), (0, 2));
    // OS が作るものは変わったことにしない
    fs::write(dir.join("s1").join("files").join("Thumbs.db"), "thumb").unwrap();
    fs::write(dir.join("s1").join("desktop.ini"), "[.ShellClassInfo]").unwrap();
    fs::write(dir.join("s2").join(".DS_Store"), "mac").unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (0, 2));
    fs::write(dir.join("s2").join("Thumbs.db.txt"), "x").unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (1, 1));
    fs::create_dir(state(&e, "s2").join("empty")).unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (1, 1));
    fs::write(dir.join("s1").join("._events.jsonl"), "apple").unwrap();
    fs::create_dir_all(dir.join("s1").join("@eaDir").join("events.jsonl")).unwrap();
    fs::write(dir.join("s1").join("@eaDir").join("events.jsonl").join("SYNOFILE_THUMB_M.jpg"), "thumb").unwrap();
    fs::write(dir.join("s2").join("empty").join(".DS_Store"), "mac").unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (0, 2));
    // 同じ大きさでも、更新時刻が変われば写し直す
    let ev = state(&e, "s1").join("events.jsonl");
    fs::write(&ev, "{\"type\":\"session.start\",\"id\":\"S1\"}\n").unwrap();
    atlas_core::jsfs::utimes(&ev, 1_762_646_400_000, 1_762_646_400_000).unwrap();
    let r5 = up(&p, &e.root);
    assert_eq!((r5.uploaded, r5.replaced, r5.unchanged), (1, 1, 1));
    // メモを書けば写し直す
    fs::create_dir_all(e.notes.join("memos")).unwrap();
    fs::write(e.notes.join("memos").join("s2.md"), "# メモ").unwrap();
    let r6 = up(&p, &e.root);
    assert_eq!((r6.uploaded, r6.unchanged, r6.memos), (1, 1, 1));
    assert_eq!(fs::read_to_string(dir.join("s2").join("atlas-memo.md")).unwrap(), "# メモ");
    // 送り先でファイルが消されていれば写し直す
    fs::remove_file(dir.join("s1").join("files").join("a.txt")).unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (1, 1));
    // 題名が変わっただけなら写し直さず、添えた記録と README を書き直す
    let sessions = e.out.join("sessions.json");
    fs::write(&sessions, json!({ "sessions": [{ "id": "s1", "name": "新しい題名" }] }).to_string()).unwrap();
    let p = UploadPaths { sessions: Some(sessions), ..p };
    assert_eq!(cnt(&up(&p, &e.root)), (0, 2));
    let meta = js::parse_json(&fs::read_to_string(dir.join("s1").join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta["title"], json!("新しい題名"));
    assert!(fs::read_to_string(dir.join("README.md")).unwrap().contains("| [s1](s1/) | 新しい題名 |"));
    assert!(names(&dir).iter().all(|n| !n.starts_with('.')));
}

#[test]
fn atlas_build_is_recorded() {
    let e = env();
    let v1 = AtlasBuild { commit: Some("a".repeat(40)), committed_at: Some("2026-11-01T00:00:00.000Z".into()), dirty: Some(false), code: "0123456789abcdef".into() };
    let v2 = AtlasBuild { commit: Some("b".repeat(40)), committed_at: Some("2026-11-10T00:00:00.000Z".into()), dirty: Some(true), code: "fedcba9876543210".into() };
    let opts = |a: &AtlasBuild| UploadOptions { atlas: Some(a.clone()), ..Default::default() };
    upload_with(&paths(&e), &e.root, &opts(&v1)).unwrap();
    let meta = |id: &str| js::parse_json(&fs::read_to_string(e.root.join("Player_Weapon").join(id).join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta("s1")["atlas"], serde_json::to_value(&v1).unwrap());
    let ev = state(&e, "s1").join("events.jsonl");
    fs::write(&ev, "{\"type\":\"session.start\",\"id\":\"S1\"}\n").unwrap();
    atlas_core::jsfs::utimes(&ev, 1_762_646_400_000, 1_762_646_400_000).unwrap();
    let r = upload_with(&paths(&e), &e.root, &opts(&v2)).unwrap();
    assert_eq!((r.uploaded, r.unchanged), (1, 1));
    assert_eq!(meta("s2")["atlas"], serde_json::to_value(&v2).unwrap());
    let index = js::parse_json(&fs::read_to_string(e.root.join("Player_Weapon").join("atlas-index.json")).unwrap()).unwrap();
    assert_eq!(index["atlas"], serde_json::to_value(&v2).unwrap());
    let keys: Vec<&String> = index.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["version", "kind", "name", "note", "uploadedAt", "snapshotAt", "atlas", "sessions", "missing"]);
    let mkeys: Vec<String> = meta("s1").as_object().unwrap().keys().cloned().collect();
    assert_eq!(mkeys, ["version", "id", "title", "project", "projectSource", "createdAt", "updatedAt", "memo", "contents", "atlas"]);
}

#[test]
fn check_counts_only_changed_and_scans_secrets() {
    let e = env();
    up(&paths(&e), &e.root);
    let c = check(&paths(&e), &e.root);
    assert_eq!((c.sessions, c.unchanged, c.bytes, c.files, c.replace, c.secrets.count), (0, 2, 0, 0, 0, 0));
    fs::write(state(&e, "s2").join("events.jsonl"), format!("{}\n", json!({ "data": token() }))).unwrap();
    let c = check(&paths(&e), &e.root);
    assert_eq!((c.sessions, c.unchanged, c.replace, c.files, c.secrets.count), (1, 1, 1, 1, 1));
    assert_eq!(c.secrets.files, vec![SecretFile { id: "s2".into(), path: "events.jsonl".into(), count: 1 }]);
    // 点検を渡せば、確かめたものの送り先の一覧を読み直さない(結果は同じ)
    let r = upload_with(&paths(&e), &e.root, &UploadOptions { expect: Some(c.fingerprint.clone()), check: Some(&c), ..Default::default() }).unwrap();
    assert_eq!((r.uploaded, r.unchanged), (1, 1));
    // 点検の後に変わったら写さない
    let c = check(&paths(&e), &e.root);
    fs::write(state(&e, "s1").join("events.jsonl"), "{\"changed\":true}\n").unwrap();
    let err = upload_with(&paths(&e), &e.root, &UploadOptions { expect: Some(c.fingerprint.clone()), ..Default::default() }).unwrap_err();
    assert!(err.is::<UploadChangedError>());
}

#[test]
fn big_files_binary_and_chunk_boundaries() {
    let e = env();
    let s1 = state(&e, "s1");
    let t = token();
    fs::write(s1.join("events.jsonl"), format!("{{\"data\":\"token {t}\"}}\n{{\"data\":\"Bearer {}\"}}\n", "a".repeat(30))).unwrap();
    let mut big = vec![b'x'; 9 * 1024 * 1024];
    let put = |b: &mut Vec<u8>, at: usize, s: &str| b[at..at + s.len()].copy_from_slice(s.as_bytes());
    put(&mut big, 4 * 1024 * 1024 - 20, &format!(" {t} "));
    put(&mut big, 8 * 1024 * 1024 - 8 * 1024, &format!(" {t} "));
    fs::write(s1.join("files").join("big.log"), &big).unwrap();
    let mut db = vec![0u8, 1, 2];
    db.extend_from_slice(t.as_bytes());
    fs::write(state(&e, "s2").join("session.db"), db).unwrap();
    let c = check(&paths(&e), &e.root);
    assert_eq!((c.sessions, c.replace, c.files), (2, 0, 5));
    assert_eq!(c.missing, vec!["gone", "../s1"]);
    assert_eq!(c.largest[0], LargeEntry { id: "s1".into(), path: "files".into(), bytes: 9 * 1024 * 1024 + 1 });
    assert_eq!(c.secrets.kinds, vec![SecretKind { label: "GitHub トークン".into(), count: 3 }, SecretKind { label: "Bearer トークン".into(), count: 1 }]);
    assert_eq!(c.secrets.files, vec![SecretFile { id: "s1".into(), path: "events.jsonl".into(), count: 2 }, SecretFile { id: "s1".into(), path: "files/big.log".into(), count: 2 }]);
    assert_eq!(c.secrets.skipped, 1);
    assert!(!e.root.join("Player_Weapon").exists());
    // 重ねて読む部分の始まりにちょうど「x + トークンの形」が来ても、語の始まりではないので数えない
    let f = e.dir.join("edge.log");
    let mut big = vec![b'y'; 8 * 1024 * 1024];
    let at = 4 * 1024 * 1024 - 16 * 1024 - 1;
    put(&mut big, at, &format!("x{t} "));
    fs::write(&f, &big).unwrap();
    assert_eq!(scan_secrets(&f).unwrap().unwrap().iter().find(|k| k.0 == "GitHub トークン").map_or(0, |k| k.1), 0);
    put(&mut big, at, &format!(" {t} "));
    fs::write(&f, &big).unwrap();
    assert_eq!(scan_secrets(&f).unwrap().unwrap(), vec![("GitHub トークン".to_string(), 1)]);
}

#[test]
fn memos_readme_and_progress() {
    let e = env();
    let memos = e.notes.join("memos");
    fs::create_dir_all(memos.join("s1")).unwrap();
    fs::write(memos.join("s1.md"), "# 武器の当たり判定\n\n![画像](s1/abc.png) と ![別](./s1/def.png)。[外の](https://example.invalid/s1/x)\n").unwrap();
    fs::write(memos.join("s1").join("abc.png"), "png").unwrap();
    fs::write(memos.join("s1").join("def.png"), "png2").unwrap();
    fs::write(memos.join("s2.md"), "  \n").unwrap();
    let sessions = e.out.join("sessions.json");
    fs::write(&sessions, json!({ "sessions": [{ "id": "s1", "name": null, "firstUserMessage": "当たり判定を | 直して", "updatedAt": "2026-11-07T03:04:00.000Z" }] }).to_string()).unwrap();
    let p = UploadPaths { sessions: Some(sessions), ..with_notes(&e) };
    let t = target_of("Player/Weapon", "武器 | 当たり判定の\n直し", &["s1", "s2", "gone"]);
    let seen = Mutex::new(Vec::<UploadProgress>::new());
    let on = |q: &UploadProgress| seen.lock().unwrap().push(q.clone());
    let c = check_target(&p, &t, &e.root, None, false).unwrap();
    let r = upload_target(&p, &t, &e.root, &|_| {}, &UploadOptions { on_progress: Some(&on), ..Default::default() }).unwrap();
    assert_eq!(r.memos, 1);
    let dir = PathBuf::from(&r.dir);
    assert_eq!(
        fs::read_to_string(dir.join("s1").join("atlas-memo.md")).unwrap(),
        "# 武器の当たり判定\n\n![画像](atlas-memo/abc.png) と ![別](atlas-memo/def.png)。[外の](https://example.invalid/s1/x)\n"
    );
    assert_eq!(names(&dir.join("s1").join("atlas-memo")), vec!["abc.png", "def.png"]);
    assert!(!dir.join("s2").join("atlas-memo.md").exists());
    let readme = fs::read_to_string(dir.join("README.md")).unwrap();
    assert!(readme.starts_with("# Player/Weapon\n\n武器 | 当たり判定の\n直し\n"));
    assert!(readme.contains("セッション: 2 件(うちメモあり 1 件)"));
    assert!(readme.contains("| [s1](s1/) | 当たり判定を \\| 直して | "));
    assert!(readme.contains("| [あり](s1/atlas-memo.md) |"));
    assert!(readme.contains("| [s2](s2/) | - | - | - |"));
    assert!(!readme.contains("タスクタグ"));
    assert!(readme.contains("写していないもの: `gone`"));
    assert!(readme.contains(&format!("--home \"{}\"", r.dir)));
    // 確認の合計と進み具合の合計は同じ
    let seen = seen.into_inner().unwrap();
    let last = seen.last().unwrap();
    assert_eq!((last.sessions, last.done, last.current.as_deref()), (2, 2, Some("s2")));
    assert_eq!((last.bytes, last.copied), (c.bytes, c.bytes));
    // メモを消してからもう一度写すと、前に添えたメモも消える
    fs::remove_file(memos.join("s1.md")).unwrap();
    assert_eq!(upload_target(&p, &t, &e.root, &|_| {}, &UploadOptions::default()).unwrap().memos, 0);
    assert!(!dir.join("s1").join("atlas-memo.md").exists());
}

#[test]
fn stops_without_making_anything() {
    let e = env();
    let err = |p: &UploadPaths, t: &UploadTarget, root: &Path| upload_target(p, t, root, &|_| {}, &UploadOptions::default()).unwrap_err().to_string();
    assert!(err(&paths(&e), &target(), &e.dir.join("none")).contains("アップロード先のフォルダが見つかりません"));
    assert!(!e.dir.join("none").exists());
    assert!(err(&UploadPaths { snapshot: e.dir.join("nosnap"), ..paths(&e) }, &target(), &e.root).contains("先に集計してください"));
    assert!(err(&paths(&e), &target_of("古い", "", &["gone", "gone2"]), &e.root).contains("プロジェクト「古い」のセッション(2 件)は、前回の集計に 1 件もありません"));
    assert!(names(&e.root).is_empty());
    // 前の版がタスクタグを送ったフォルダ(索引の kind が group)には、同じ名前のプロジェクトでも混ぜない
    let old = e.root.join("Player_Weapon");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join(UPLOAD_INDEX), json!({ "version": 1, "kind": "group", "name": "Player/Weapon", "sessions": [] }).to_string()).unwrap();
    let m = err(&paths(&e), &target(), &e.root);
    assert!(m.contains("前の版で送ったタスクタグ「Player/Weapon」がすでに送られています"), "{m}");
    assert_eq!(names(&old), vec![UPLOAD_INDEX]);
    assert_eq!(upload_dir(&e.root, "nul.log"), e.root.join("_nul.log"));
    assert_eq!(upload_dir(&e.root, "console"), e.root.join("console"));
}

#[test]
fn store_key_text_drops_volatile_columns() {
    let row = |opened: &str, read: i64, title: &str, diff: i64| {
        json!({
            "version": 1, "sessions": [],
            "desktop": {
                "session": { "id": "s1", "title": title },
                "project": { "id": "p", "name": "app", "last_opened_at": opened, "show_in_sidebar": 1 },
                "workspace": { "id": "w", "branch": "main", "updated_at": opened, "last_diff_files_changed": diff },
                "activity": [{ "id": "a", "preview": "x", "is_read": read, "updated_at": opened }],
                "checkpoints": [], "contextUsage": []
            }
        })
        .to_string()
    };
    let a = store_key_text(&row("2026-11-01", 0, "t", 1));
    assert_eq!(store_key_text(&row("2026-11-12", 1, "t", 5)), a);
    assert_ne!(store_key_text(&row("2026-11-01", 0, "別の題名", 1)), a);
    assert_eq!(store_key_text("{壊れた"), "{壊れた");
    assert_eq!(vcs_key_text(r#"{"computedAt":"x","result":{"evaluated":{"at":"y","n":1}}}"#), r#"{"result":{"evaluated":{"n":1}}}"#);
}

/// 管理ツールのタスクに紐づいたセッションは、atlas-session.json と atlas-index.json の task と README のタスクの列に、そのタスクを添える。
/// 紐づけだけが変わったときは写し直さず、添えた記録を書き直す。受け取った側はこれを形と大きさを確かめて読む
#[test]
fn task_records_are_attached() {
    let e = env();
    let sessions = e.out.join("sessions.json");
    fs::write(&sessions, json!({ "sessions": [{ "id": "s1", "name": "画面", "createdAt": "2026-11-20T01:00:00.000Z" }, { "id": "s2", "name": "雑談", "createdAt": "2026-11-20T02:00:00.000Z" }] }).to_string()).unwrap();
    let p = UploadPaths { sessions: Some(sessions), ..with_notes(&e) };
    let r = up(&p, &e.root);
    let dir = PathBuf::from(&r.dir);
    let meta = |id: &str| js::parse_json(&fs::read_to_string(dir.join(id).join("atlas-session.json")).unwrap()).unwrap();
    assert!(meta("s1").get("tasks").is_none());
    fs::write(
        e.notes.join("tasks.json"),
        json!({ "version": 1, "tasks": {
            "T-1": { "name": "画面の | 修正", "status": "Done", "done": true, "firstSeenAt": "a", "doneAt": "2026-11-22T00:00:00.000Z", "lastSeenAt": "2026-11-22T00:00:00.000Z", "doneObserved": true },
            "T-2": { "name": "帳票", "status": "Open", "done": false, "firstSeenAt": "a", "doneAt": null, "lastSeenAt": "2026-11-22T00:00:00.000Z" }
        } })
        .to_string(),
    )
    .unwrap();
    // 前の版の task-links.json(taskId が 1 つ)も読む。s1 は 2 つのタスク(版 2 の形)
    fs::write(
        e.notes.join("task-links.json"),
        json!({ "version": 2, "links": { "s1": { "taskIds": ["T-1", "T-2"], "source": "machine", "reason": "ID が題名にある", "at": "t" }, "s2": { "taskIds": [], "source": "manual", "reason": "", "at": "t" } } }).to_string(),
    )
    .unwrap();
    let r = up(&p, &e.root);
    assert_eq!((r.uploaded, r.unchanged), (0, 2));
    let t = &meta("s1")["tasks"];
    assert_eq!(
        t[0],
        json!({ "id": "T-1", "name": "画面の | 修正", "status": "Done", "done": true, "doneAt": "2026-11-22T00:00:00.000Z", "doneObserved": true, "lastSeenAt": "2026-11-22T00:00:00.000Z", "start": "2026-11-20T01:00:00.000Z", "source": "machine", "reason": "ID が題名にある" })
    );
    assert_eq!(t[1]["id"], "T-2");
    assert_eq!(t.as_array().unwrap().len(), 2);
    // タスクが 2 つなら、前の版の task(1 つ)は書かない
    assert!(meta("s1").get("task").is_none());
    // 「どのタスクでもない」は添えない
    assert!(meta("s2").get("tasks").is_none());
    let index = js::parse_json(&fs::read_to_string(dir.join("atlas-index.json")).unwrap()).unwrap();
    assert_eq!(index["sessions"][0]["tasks"][1]["id"], "T-2");
    let readme = fs::read_to_string(dir.join("README.md")).unwrap();
    assert!(readme.contains("| [s1](s1/) | 画面 | 画面の \\| 修正(T-1)、帳票(T-2) |"), "{readme}");
    assert!(readme.contains("| [s2](s2/) | 雑談 | - |"), "{readme}");
    // 受け取った側の読み方で読める
    let got = atlas_report::tasks::sender::read_sender_tasks(&dir.join("s1").join("atlas-session.json"), "s1");
    assert_eq!(got.iter().map(|t| (t.id.as_str(), t.done, t.source)).collect::<Vec<_>>(), [("T-1", true, atlas_report::tasks::links::LinkSource::Machine), ("T-2", false, atlas_report::tasks::links::LinkSource::Machine)]);
    // 前の版の紐づけ(taskId)からも送れる
    fs::write(e.notes.join("task-links.json"), json!({ "version": 1, "links": { "s1": { "taskId": "T-2", "source": "llm", "reason": "r", "at": "t" } } }).to_string()).unwrap();
    up(&p, &e.root);
    assert_eq!(meta("s1")["tasks"].as_array().map(|a| a.iter().map(|t| t["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("T-2")]));
    // タスクがちょうど 1 つなら、前の版の atlas も読めるよう task にも同じものを添える
    assert_eq!(meta("s1")["task"], meta("s1")["tasks"][0]);
    let index = js::parse_json(&fs::read_to_string(dir.join("atlas-index.json")).unwrap()).unwrap();
    assert_eq!(index["sessions"][0]["task"]["id"], "T-2");
}
