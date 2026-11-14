// extract の振る舞い(packages/core/test/{phase7,upload-read}.test.ts の extract の部分と、スナップショットの形のフォルダからの通し)

use atlas_core::extract::*;
use atlas_core::project::ProjectResolverOptions;
use atlas_core::sqlite::open_writable;
use atlas_core::types::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn no_grouping() -> ProjectResolverOptions {
    ProjectResolverOptions { homes: Some(vec![]), temps: Some(vec![]), temp_patterns: Some(false), read_git: None }
}

fn write(p: &Path, text: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

#[test]
fn todos() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("session.db");
    let db = open_writable(&p).unwrap();
    db.execute_batch(
        "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT);
         CREATE TABLE todo_deps (todo_id TEXT, depends_on TEXT);
         INSERT INTO todos VALUES ('1','t','done'),('2','t','pending'),('3','t',NULL);
         INSERT INTO todo_deps VALUES ('2','1');",
    )
    .unwrap();
    drop(db);
    let t = read_todos(&p).unwrap().unwrap();
    assert_eq!((t.total, t.deps), (3.0, 1.0));
    assert_eq!(t.by_status.get("done"), Some(&1.0));
    assert_eq!(t.by_status.get("pending"), Some(&1.0));
    assert_eq!(t.by_status.get("(unknown)"), Some(&1.0));
    let empty = dir.path().join("empty.db");
    open_writable(&empty).unwrap().execute_batch("CREATE TABLE inbox_entries (id TEXT)").unwrap();
    assert_eq!(read_todos(&empty).unwrap(), Some(TodoSummary::default()));
    assert_eq!(read_todos(&dir.path().join("none.db")).unwrap(), None);
}

/// ~/.copilot の形のスナップショット(session-store.db とセッションのフォルダ)
fn copilot_snapshot(root: &Path) {
    let ss = root.join("session-state");
    write(&ss.join("a1").join("workspace.yaml"), "id: a1\ncwd: X:\\work\\app\nname: New session\ncreated_at: 2026-10-01T00:00:00.000Z\nupdated_at: 2026-10-01T00:10:00.000Z\n");
    write(
        &ss.join("a1").join("events.jsonl"),
        &[
            json!({"type": "session.start", "data": {"version": 1, "copilotVersion": "1.0.1", "context": {"cwd": "X:\\work\\app"}}, "id": "1", "timestamp": "2026-10-01T00:00:00.000Z"}).to_string(),
            json!({"type": "user.message", "data": {"content": "hello"}, "id": "2", "timestamp": "2026-10-01T00:00:01.000Z"}).to_string(),
            "{broken".to_string(),
            json!({"type": "future.kind", "data": {}, "id": "3", "timestamp": "2026-10-01T00:00:02.000Z"}).to_string(),
            json!({"type": "assistant.message", "data": {"content": "hi", "outputTokens": 3, "model": "m"}, "id": "4", "timestamp": "2026-10-01T00:00:03.000Z"}).to_string(),
        ]
        .join("\n"),
    );
    // セッションのファイルを持たないフォルダは数えない
    fs::create_dir_all(ss.join("not-a-session")).unwrap();
    let db = open_writable(&root.join("session-store.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
         CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, initiator TEXT, created_at TEXT);
         CREATE TABLE session_files (session_id TEXT, file_path TEXT, tool_name TEXT, turn_index INTEGER, first_seen_at TEXT);
         INSERT INTO sessions VALUES ('a1','X:\\work\\app','o/app','github','main','要約','2026-10-01 00:00:00','2026-10-01 00:10:00');
         INSERT INTO sessions VALUES ('d1','X:\\work\\db',NULL,NULL,NULL,'DB だけ','2026-09-01 00:00:00','2026-09-01 00:05:00');
         INSERT INTO turns VALUES ('d1',0,'q','a',NULL);
         INSERT INTO assistant_usage_events VALUES (1,'a1',0,NULL,NULL,'m',10,3,0,0,0,100,1,'user','2026-10-01 00:00:03');
         INSERT INTO session_files VALUES ('d1','src/x.ts','create',0,NULL);",
    )
    .unwrap();
}

#[test]
fn extracts_copilot_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    copilot_snapshot(dir.path());
    let mut opts = ExtractOptions::new();
    opts.projects = Some(no_grouping());
    let s = extract(dir.path(), &opts).unwrap();
    assert_eq!(s.sessions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a1", "d1"]);
    assert_eq!(serde_json::to_value(&s.counts).unwrap(), json!({"sessions": 2, "dbOnly": 1, "dirOnly": 0, "both": 1, "empty": 0}));
    let a = &s.sessions[0];
    assert_eq!(a.events.bad_lines, 1);
    assert_eq!(a.tokens.source, TokenSource::Db);
    assert_eq!((a.project.as_str(), a.project_source), ("o/app", ProjectSource::Repository));
    // workspace.yaml の仮の名前は data.db の題名が無ければそのまま
    assert_eq!(a.name.as_deref(), Some("New session"));
    assert_eq!(a.person, Some(None));
    assert_eq!(a.desktop, Some(None));
    assert_eq!(a.upload_folder, None);
    let d = &s.sessions[1];
    assert_eq!(d.sources, vec![SessionSource::Db]);
    assert_eq!(d.files.created, vec!["X:\\work\\db\\src\\x.ts"]);
    assert_eq!(d.project, "X:\\work\\db");
    assert_eq!(s.warnings.messages, vec!["a1: 壊れた行 1 件をスキップ".to_string(), "未知のイベント種別: future.kind (1 件)".to_string()]);
    assert_eq!(s.warnings.bad_lines, 1);
    assert_eq!(s.desktop, Some(None));
    assert_eq!(s.installed, None);
    assert_eq!(s.source.root, None);
    // since で絞る(更新日時がそれより前のセッションは外す)
    let mut opts = ExtractOptions::new();
    opts.since = Some(Some("2026-09-15T00:00:00Z".into()));
    let s = extract(dir.path(), &opts).unwrap();
    assert_eq!(s.sessions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a1"]);
    // 解釈できない since はどのセッションも残さない(TS 版の NaN と同じ)
    opts.since = Some(Some("not a date".into()));
    assert!(extract(dir.path(), &opts).unwrap().sessions.is_empty());
}

fn manifest(root: &Path, layout: &str, extra: Value) {
    let mut m = json!({
        "createdAt": "2026-11-01T00:00:00.000Z",
        "sourceRoot": "Z:\\shared\\logs",
        "since": null,
        "databases": {},
        "sessions": {"dirs": 1, "copiedFiles": 0, "reusedFiles": 0, "skippedBySince": 0, "bytes": 0},
        "layout": layout
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    write(&root.join("snapshot-manifest.json"), &m.to_string());
}

#[test]
fn uploaded_folders_use_sender_records_not_disk() {
    let dir = tempfile::tempdir().unwrap();
    // 読む側の PC に、ログと同じパスで別のリポジトリがある
    let repo = dir.path().join("pc").join("my-app");
    write(&repo.join(".git").join("config"), "[remote \"origin\"]\n\turl = https://github.com/zz-other/zz-on-disk.git\n");
    let repo_s = repo.to_string_lossy().into_owned();
    let yaml = format!("id: g1\ncwd: {}\ngit_root: {}\n", serde_json::to_string(&repo_s).unwrap(), serde_json::to_string(&repo_s).unwrap());
    let run = |name: &str, meta: Option<Value>, layout: &str| -> (String, ProjectSource, SessionRecord) {
        let snap = dir.path().join(name);
        let d = snap.join("session-state").join("g1");
        write(&d.join("workspace.yaml"), &yaml);
        write(&d.join("events.jsonl"), "{\"type\":\"session.start\",\"data\":{\"version\":1},\"id\":\"e1\",\"timestamp\":\"2026-07-02T09:00:00.000Z\"}\n");
        if let Some(m) = meta {
            write(&d.join("atlas-session.json"), &m.to_string());
        }
        if layout != "copilot" {
            manifest(&snap, layout, json!({}));
        }
        let mut opts = ExtractOptions::new();
        opts.projects = Some(no_grouping());
        let s = extract(&snap, &opts).unwrap();
        let r = s.sessions.into_iter().find(|x| x.id == "g1").unwrap();
        (r.project.clone(), r.project_source, r)
    };
    // 対照: ~/.copilot の形なら、ディスクの .git/config から決まる
    let (p, src, _) = run("home", None, "copilot");
    assert_eq!((p.as_str(), src), ("zz-other/zz-on-disk", ProjectSource::GitRemote));
    let meta = json!({"version": 1, "id": "g1", "title": null, "project": "zz-owner/zz-sent", "projectSource": "git-remote", "tags": ["a", " a ", "b"], "createdAt": null, "updatedAt": null, "memo": false,
        "atlas": {"commit": "a".repeat(40), "committedAt": "2026-11-13T09:00:00+09:00", "dirty": false, "code": "0123456789abcdef"}});
    let (p, src, r) = run("sent", Some(meta.clone()), "flat");
    assert_eq!((p.as_str(), src), ("zz-owner/zz-sent", ProjectSource::GitRemote));
    assert_eq!(r.upload_folder, Some(Some(".".into())));
    assert_eq!(r.upload_tags, Some(vec!["a".into(), "b".into()]));
    assert_eq!(r.upload_atlas.clone().flatten().unwrap().committed_at.as_deref(), Some("2026-11-13T00:00:00.000Z"));
    assert_eq!(r.person, Some(None));
    let mut m = meta.clone();
    m["projectSource"] = json!("repository");
    assert_eq!(run("sent-repo", Some(m), "flat").1, ProjectSource::Repository);
    // 決め方の記録が無い(前の版が書いた)ものは、名前から推す
    let mut old = meta.clone();
    old.as_object_mut().unwrap().remove("projectSource");
    assert_eq!(run("old", Some(old.clone()), "flat").1, ProjectSource::GitRemote);
    let mut o = old.clone();
    o["project"] = json!("(一時フォルダ)");
    assert_eq!(run("old-temp", Some(o), "flat").1, ProjectSource::Temp);
    let mut o = old.clone();
    o["project"] = json!("d:/work/my-app");
    assert_eq!(run("old-path", Some(o), "flat").1, ProjectSource::Path);
    let mut o = meta.clone();
    o["projectSource"] = json!("made-up");
    assert_eq!(run("odd-source", Some(o), "flat").1, ProjectSource::GitRemote);
    // 記録が無い・使えないときも、ディスクは読まない(パスから決める)
    let (p, src, r) = run("none", None, "flat");
    assert_eq!(src, ProjectSource::Path);
    assert!(!p.contains("zz-"));
    assert_eq!(r.upload_tags, Some(vec![]));
    assert_eq!(r.upload_atlas, Some(None));
    // まとめて読んだときは、人のフォルダの名前と、数えたフォルダを持たせる
    let snap = dir.path().join("merged");
    write(&snap.join("session-state").join("m1").join("events.jsonl"), "{\"type\":\"session.start\",\"data\":{},\"timestamp\":\"2026-07-02T09:00:00.000Z\"}\n");
    manifest(&snap, "merged", json!({"merged": {"folders": ["person-a/proj"], "duplicates": 0, "owners": {"m1": "person-a/proj"}}, "uploads": {"person-a/proj": {"uploadedAt": null, "atlas": null}}}));
    let s = extract(&snap, &ExtractOptions::new()).unwrap();
    assert_eq!(s.sessions[0].person, Some(Some("person-a".into())));
    assert_eq!(s.sessions[0].upload_folder, Some(Some("person-a/proj".into())));
    let src = serde_json::to_value(&s.source).unwrap();
    assert_eq!(src["layout"], "merged");
    assert_eq!(src["folders"], json!(["person-a/proj"]));
    assert_eq!(src["uploads"], json!({"person-a/proj": {"uploadedAt": null, "atlas": null}}));
}

#[test]
fn store_json_bad_shapes_are_reported_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("store.json");
    let ok = json!({
        "version": 1, "schemaVersion": 3,
        "sessions": [{"id": "s1", "cwd": "C:\\w", "repository": null, "summary": "x", "created_at": "2026-07-01T00:00:00Z", "updated_at": null}],
        "turns": [{"session_id": "s1", "turn_index": 0, "user_message": "q", "assistant_response": null, "timestamp": "2026-07-01T00:00:00Z"}],
        "usage": [{"id": 1, "session_id": "s1", "turn_index": null, "model": "gpt-x", "input_tokens": 10, "output_tokens": 2, "new_column": "v", "created_at": null}],
        "files": [{"session_id": "s1", "file_path": "a.ts", "tool_name": "edit", "turn_index": 0, "first_seen_at": null}]
    });
    let with = |k: &str, v: Value| {
        let mut o = ok.clone();
        o[k] = v;
        o.to_string()
    };
    let bad = vec![
        with("sessions", json!([null])),
        with("turns", json!([null])),
        with("usage", json!([null])),
        with("files", json!([[]])),
        with("sessions", json!([{"id": "s1", "cwd": 123}])),
        with("sessions", json!([{"id": "s1", "summary": {}}])),
        with("turns", json!([{"session_id": "s1", "turn_index": "x"}])),
        with("turns", json!([{"session_id": "s1", "user_message": "q"}])),
        with("turns", json!([{"session_id": "s1", "turn_index": 0, "user_message": {}}])),
        with("usage", json!([{"session_id": "s1", "model": "m", "input_tokens": "10"}])),
        with("usage", json!([{"session_id": "s1", "input_tokens": 10}])),
        with("usage", json!([{"session_id": "s1", "model": "m", "extra": {"a": 1}}])),
        with("files", json!([{"session_id": "s1"}])),
        with("files", json!([{"session_id": "s1", "file_path": 5}])),
        with("version", json!(2)),
        "not json".to_string(),
    ];
    for (i, text) in bad.iter().enumerate() {
        fs::write(&f, text).unwrap();
        let mut store = load_store(&dir.path().join("no.db")).unwrap();
        let mut desk = std::collections::HashMap::new();
        let msg = merge_session_store_json(&mut store, "s1", &f, &mut desk).unwrap_or_default();
        assert!(msg.starts_with("s1: atlas-session-store.json を読めない"), "{i}: {msg}");
        assert_eq!([store.sessions.len(), store.turns.len(), store.usage.len(), store.files.len()], [0, 0, 0, 0], "{i}");
    }
    let mut o = ok.clone();
    o["usage"].as_array_mut().unwrap().push(json!({"session_id": "other", "model": 5, "input_tokens": "x"}));
    fs::write(&f, o.to_string()).unwrap();
    let mut store = load_store(&dir.path().join("no.db")).unwrap();
    let mut desk = std::collections::HashMap::new();
    assert_eq!(merge_session_store_json(&mut store, "s1", &f, &mut desk), None);
    assert_eq!(store.sessions["s1"].cwd.as_deref(), Some("C:\\w"));
    assert_eq!(store.turns["s1"].len(), 1);
    assert_eq!(store.usage["s1"].len(), 1);
    assert_eq!(store.usage["s1"][0].model, "gpt-x");
    assert_eq!(store.files["s1"].len(), 1);
}

#[test]
fn sender_tags_and_trust() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("atlas-session.json");
    let valid: Vec<String> = (0..60).map(|i| format!("t{i}")).collect();
    let mut tags: Vec<Value> = vec![json!(""); 60];
    tags.extend(vec![json!("t0"); 10]);
    tags.extend(valid.iter().map(|t| json!(t)));
    fs::write(&f, json!({"version": 1, "id": "s1", "project": "owner/app", "tags": tags}).to_string()).unwrap();
    assert_eq!(read_sender_tags(&f, "s1"), valid[..50].to_vec());
    let m = read_sender_meta(&f, "s1").unwrap();
    assert_eq!(m.project, Some(SenderProject { project: "owner/app".into(), source: None }));
    assert_eq!(m.atlas, None);
    assert!(read_sender_meta(&f, "s2").is_none());
    assert!(read_sender_meta(&dir.path().join("none.json"), "s1").is_none());

    let read = |project: Value, source: Option<&str>| {
        let mut o = json!({"version": 1, "id": "s1", "project": project});
        if let Some(s) = source {
            o["projectSource"] = json!(s);
        }
        fs::write(&f, o.to_string()).unwrap();
        read_sender_project(&f, "s1")
    };
    assert_eq!(read(json!("  owner/app \n"), Some("git-remote")), Some(SenderProject { project: "owner/app".into(), source: Some(ProjectSource::GitRemote) }));
    for bad in ["owner/app\nsecond", "a\tb", "a\u{0}b", "a\u{2028}b", "a\u{85}b", "app\u{202E}gnp.exe", "app\u{200B}x", "a\u{FEFF}b", "a\u{2066}b"] {
        assert_eq!(read(json!(bad), Some("path")), None, "{bad:?}");
    }
    assert_eq!(read(json!("x".repeat(1001)), Some("path")), None);
    assert_eq!(read(json!("(一時フォルダ)"), Some("git-remote")), Some(SenderProject { project: "(一時フォルダ)".into(), source: Some(ProjectSource::Temp) }));
    for s in ["temp", "home", "atlas-judge"] {
        assert_eq!(read(json!("owner/app"), Some(s)), Some(SenderProject { project: "owner/app".into(), source: None }), "{s}");
    }
    assert_eq!(read(json!("owner/app"), Some("unknown")), Some(SenderProject { project: "owner/app".into(), source: Some(ProjectSource::Unknown) }));
}
