//! group_upload.rs のテスト(packages/cli/test/group-upload.test.ts の振る舞いを決めている部分)

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
    fs::write(notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "Player/Weapon", "note": "", "ids": ["s1", "s2", "gone", "../s1"] }, { "name": "空", "note": "", "ids": [] }] }).to_string()).unwrap();
    fs::create_dir_all(&root).unwrap();
    Env { _t: t, dir, out, notes, root }
}

fn paths(e: &Env) -> GroupUploadPaths {
    GroupUploadPaths { snapshot: e.out.join("snapshot"), groups: e.notes.join("groups.json"), notes: None, sessions: None }
}

fn with_notes(e: &Env) -> GroupUploadPaths {
    GroupUploadPaths { notes: Some(e.notes.clone()), ..paths(e) }
}

fn up(p: &GroupUploadPaths, root: &Path) -> GroupUploadResult {
    upload_group(p, "Player/Weapon", root, &|_| {}, &UploadOptions::default()).unwrap()
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
        GroupUploadResult {
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
    let r4 = upload_group(&paths(&e), "Player/Weapon", &e.root, &|_| {}, &UploadOptions { full: true, ..Default::default() }).unwrap();
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
    let cnt = |r: &GroupUploadResult| (r.uploaded, r.unchanged);
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
    // タスクタグを変えただけなら写し直さず、添えた記録と README を書き直す
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "Player/Weapon", "note": "", "ids": ["s1", "s2"] }, { "name": "調査", "note": "", "ids": ["s1"] }] }).to_string()).unwrap();
    assert_eq!(cnt(&up(&p, &e.root)), (0, 2));
    let meta = js::parse_json(&fs::read_to_string(dir.join("s1").join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta["tags"], json!(["Player/Weapon", "調査"]));
    assert!(fs::read_to_string(dir.join("README.md")).unwrap().contains("セッション: 2 件"));
    assert!(names(&dir).iter().all(|n| !n.starts_with('.')));
}

#[test]
fn atlas_build_is_recorded() {
    let e = env();
    let v1 = AtlasBuild { commit: Some("a".repeat(40)), committed_at: Some("2026-11-01T00:00:00.000Z".into()), dirty: Some(false), code: "0123456789abcdef".into() };
    let v2 = AtlasBuild { commit: Some("b".repeat(40)), committed_at: Some("2026-11-10T00:00:00.000Z".into()), dirty: Some(true), code: "fedcba9876543210".into() };
    let opts = |a: &AtlasBuild| UploadOptions { atlas: Some(a.clone()), ..Default::default() };
    upload_group(&paths(&e), "Player/Weapon", &e.root, &|_| {}, &opts(&v1)).unwrap();
    let meta = |id: &str| js::parse_json(&fs::read_to_string(e.root.join("Player_Weapon").join(id).join("atlas-session.json")).unwrap()).unwrap();
    assert_eq!(meta("s1")["atlas"], serde_json::to_value(&v1).unwrap());
    let ev = state(&e, "s1").join("events.jsonl");
    fs::write(&ev, "{\"type\":\"session.start\",\"id\":\"S1\"}\n").unwrap();
    atlas_core::jsfs::utimes(&ev, 1_762_646_400_000, 1_762_646_400_000).unwrap();
    let r = upload_group(&paths(&e), "Player/Weapon", &e.root, &|_| {}, &opts(&v2)).unwrap();
    assert_eq!((r.uploaded, r.unchanged), (1, 1));
    assert_eq!(meta("s2")["atlas"], serde_json::to_value(&v2).unwrap());
    let index = js::parse_json(&fs::read_to_string(e.root.join("Player_Weapon").join("atlas-index.json")).unwrap()).unwrap();
    assert_eq!(index["atlas"], serde_json::to_value(&v2).unwrap());
    let keys: Vec<&String> = index.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["version", "kind", "name", "note", "uploadedAt", "snapshotAt", "atlas", "sessions", "missing"]);
    let mkeys: Vec<String> = meta("s1").as_object().unwrap().keys().cloned().collect();
    assert_eq!(mkeys, ["version", "id", "title", "project", "projectSource", "tags", "createdAt", "updatedAt", "memo", "contents", "atlas"]);
}

#[test]
fn check_counts_only_changed_and_scans_secrets() {
    let e = env();
    up(&paths(&e), &e.root);
    let c = check_upload(&paths(&e), "Player/Weapon", &e.root).unwrap();
    assert_eq!((c.sessions, c.unchanged, c.bytes, c.files, c.replace, c.secrets.count), (0, 2, 0, 0, 0, 0));
    fs::write(state(&e, "s2").join("events.jsonl"), format!("{}\n", json!({ "data": token() }))).unwrap();
    let c = check_upload(&paths(&e), "Player/Weapon", &e.root).unwrap();
    assert_eq!((c.sessions, c.unchanged, c.replace, c.files, c.secrets.count), (1, 1, 1, 1, 1));
    assert_eq!(c.secrets.files, vec![SecretFile { id: "s2".into(), path: "events.jsonl".into(), count: 1 }]);
    // 点検を渡せば、確かめたものの送り先の一覧を読み直さない(結果は同じ)
    let r = upload_group(&paths(&e), "Player/Weapon", &e.root, &|_| {}, &UploadOptions { expect: Some(c.fingerprint.clone()), check: Some(&c), ..Default::default() }).unwrap();
    assert_eq!((r.uploaded, r.unchanged), (1, 1));
    // 点検の後に変わったら写さない
    let c = check_upload(&paths(&e), "Player/Weapon", &e.root).unwrap();
    fs::write(state(&e, "s1").join("events.jsonl"), "{\"changed\":true}\n").unwrap();
    let err = upload_group(&paths(&e), "Player/Weapon", &e.root, &|_| {}, &UploadOptions { expect: Some(c.fingerprint.clone()), ..Default::default() }).unwrap_err();
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
    let c = check_upload(&paths(&e), "Player/Weapon", &e.root).unwrap();
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
    fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "Player/Weapon", "note": "武器 | 当たり判定の\n直し", "ids": ["s1", "s2", "gone"] }] }).to_string()).unwrap();
    let sessions = e.out.join("sessions.json");
    fs::write(&sessions, json!({ "sessions": [{ "id": "s1", "name": null, "firstUserMessage": "当たり判定を | 直して", "updatedAt": "2026-11-07T03:04:00.000Z" }] }).to_string()).unwrap();
    let p = GroupUploadPaths { sessions: Some(sessions), ..with_notes(&e) };
    let seen = Mutex::new(Vec::<UploadProgress>::new());
    let on = |q: &UploadProgress| seen.lock().unwrap().push(q.clone());
    let c = check_upload(&p, "Player/Weapon", &e.root).unwrap();
    let r = upload_group(&p, "Player/Weapon", &e.root, &|_| {}, &UploadOptions { on_progress: Some(&on), ..Default::default() }).unwrap();
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
    assert!(readme.contains("| [s1](s1/) | 当たり判定を \\| 直して | Player/Weapon | "));
    assert!(readme.contains("| [あり](s1/atlas-memo.md) |"));
    assert!(readme.contains("| [s2](s2/) | - | Player/Weapon | - | - |"));
    assert!(readme.contains("写していないもの: `gone`"));
    assert!(readme.contains(&format!("--home \"{}\"", r.dir)));
    // 確認の合計と進み具合の合計は同じ
    let seen = seen.into_inner().unwrap();
    let last = seen.last().unwrap();
    assert_eq!((last.sessions, last.done, last.current.as_deref()), (2, 2, Some("s2")));
    assert_eq!((last.bytes, last.copied), (c.bytes, c.bytes));
    // メモを消してからもう一度写すと、前に添えたメモも消える
    fs::remove_file(memos.join("s1.md")).unwrap();
    assert_eq!(up(&p, &e.root).memos, 0);
    assert!(!dir.join("s1").join("atlas-memo.md").exists());
}

#[test]
fn stops_without_making_anything() {
    let e = env();
    let err = |p: &GroupUploadPaths, name: &str, root: &Path| upload_group(p, name, root, &|_| {}, &UploadOptions::default()).unwrap_err().to_string();
    assert!(err(&paths(&e), "Player/Weapon", &e.dir.join("none")).contains("アップロード先のフォルダが見つかりません"));
    assert!(!e.dir.join("none").exists());
    assert!(err(&paths(&e), "無い", &e.root).contains("タスクタグ「無い」はありません"));
    assert!(err(&paths(&e), "空", &e.root).contains("セッションがありません"));
    assert!(err(&GroupUploadPaths { snapshot: e.dir.join("nosnap"), ..paths(&e) }, "Player/Weapon", &e.root).contains("先に集計してください"));
    fs::write(
        e.notes.join("groups.json"),
        json!({ "version": 1, "groups": [{ "name": "Player/Weapon", "note": "", "ids": ["s1"] }, { "name": "player_weapon", "note": "", "ids": ["s2"] }, { "name": "古い", "note": "", "ids": ["gone", "gone2"] }] }).to_string(),
    )
    .unwrap();
    assert!(err(&paths(&e), "Player/Weapon", &e.root).contains("「Player/Weapon」と「player_weapon」は、アップロード先のフォルダ名が同じ「Player_Weapon」"));
    assert!(err(&paths(&e), "古い", &e.root).contains("(2 件)は、前回の集計に 1 件もありません"));
    assert!(names(&e.root).is_empty());
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

#[test]
fn cli_upload_needs_force_for_secrets() {
    let e = env();
    fs::write(state(&e, "s1").join("events.jsonl"), format!("{{\"data\":\"{}\"}}\n", token())).unwrap();
    let p = crate::paths::resolve_paths(crate::paths::PathInputs {
        home: Some(&e.dir.to_string_lossy()),
        out: Some(&e.out.to_string_lossy()),
        judgments: None,
        bundle: None,
        notes_dir: Some(&e.notes.to_string_lossy()),
    });
    let lines = Mutex::new(Vec::<String>::new());
    let log = |m: &str| lines.lock().unwrap().push(m.into());
    let err = run_group_upload(&p, "Player/Weapon", Some(&e.root.to_string_lossy()), false, None, &log).unwrap_err();
    assert!(err.to_string().contains("--force"));
    assert!(lines.lock().unwrap().join("\n").contains("秘密らしい文字列が 1 件あります(GitHub トークン 1"));
    assert!(!e.root.join("Player_Weapon").exists());
    run_group_upload(&p, "Player/Weapon", Some(&e.root.to_string_lossy()), true, None, &log).unwrap();
    assert!(e.root.join("Player_Weapon").join("s1").exists());
    assert!(!e.out.join(crate::jobs::JOB_LOCK_FILE).exists());
}
