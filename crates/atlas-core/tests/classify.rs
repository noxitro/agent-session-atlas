// classify・wiki・instructions・tool-failure の振る舞い(packages/core/test/{classify,wiki,instructions,tool-failure}.test.ts を移したもの)

use atlas_core::classify::*;
use atlas_core::instructions::*;
use atlas_core::js::JsMap;
use atlas_core::normalize::{normalize_session, DbInput, NormalizeInput};
use atlas_core::tool_failure::*;
use atlas_core::types::*;
use atlas_core::wiki::{empty_wiki, WikiClassifier, WikiSpec};
use serde_json::{json, Value};

fn ev(kind: &str, data: Value, ts: &str) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(json!(ts)), parent_id: None, agent_id: None }
}

fn norm(events: Vec<CopilotEvent>, workspace: Option<WorkspaceInfo>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: "s".into(), has_dir: None, workspace: workspace.as_ref(), db: DbInput::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

fn v<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap()
}

#[test]
fn normalize_model_names() {
    assert_eq!(normalize_model("claude-haiku-5-5"), "claude-haiku-5.5");
    assert_eq!(normalize_model("claude-haiku-5.5"), "claude-haiku-5.5");
    assert_eq!(normalize_model("11111111-2222-4333-8444-555555555555/claude-sonnet-5-5"), "claude-sonnet-5.5");
    assert_eq!(normalize_model("22222222-3333-4444-8555-666666666666/thinkingmachines/inkling:free"), "thinkingmachines/inkling:free");
    assert_eq!(normalize_model("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5-20250929");
    assert_eq!(normalize_model("claude-opus-4-10"), "claude-opus-4-10");
    assert_eq!(normalize_model("gpt-5-4"), "gpt-5-4");
    assert_eq!(normalize_model("claude-sonnet-5"), "claude-sonnet-5");
}

#[test]
fn file_tracker() {
    assert_eq!(resolve_file_path("src/a.ts", Some("C:\\w\\r")), "C:\\w\\r\\src\\a.ts");
    assert_eq!(resolve_file_path("c:/w/r/src/../src/a.ts", None), "C:\\w\\r\\src\\a.ts");
    assert_eq!(resolve_file_path("src/a.ts", Some("/home/u/r")), "/home/u/r/src/a.ts");
    assert_eq!(resolve_file_path("src/a.ts", None), "src/a.ts");
    let mut t = FileTracker::new();
    t.add(FileOp::Edit, "src\\a.ts", Some("C:\\w\\r"));
    t.add(FileOp::Edit, "C:\\W\\R\\SRC\\A.TS", Some("C:\\w\\r"));
    t.add(FileOp::Create, "docs/new.md", Some("C:\\w\\r"));
    t.add(FileOp::Edit, "C:\\w\\r\\docs\\new.md", Some("C:\\w\\r"));
    t.add(FileOp::Edit, "old.txt", Some("C:\\w\\r"));
    t.add(FileOp::Delete, "C:\\w\\r\\old.txt", Some("C:\\w\\r"));
    t.add(FileOp::Create, "X:\\Home\\u\\.copilot\\session-state\\abc\\plan.md", Some("C:\\w\\r"));
    t.add(FileOp::Edit, "x:\\home\\u\\.copilot\\session-state\\abc\\plan.md", Some("C:\\w\\r"));
    let r = t.result();
    assert_eq!((r.changed, r.created, r.deleted, r.session_state), (vec!["C:\\w\\r\\src\\a.ts".to_string()], vec!["C:\\w\\r\\docs\\new.md".to_string()], vec!["C:\\w\\r\\old.txt".to_string()], 1));
}

#[test]
fn relative_inside_root() {
    let w = |s: &str| s.replace('/', "\\");
    assert_eq!(relative_inside(&w("X:/zz/repo"), "x:/ZZ/repo/src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(relative_inside(&w("X:/zz/repo/"), &w("X:/zz/repo/a.ts")).as_deref(), Some("a.ts"));
    assert_eq!(relative_inside(&w("X:/zz/repo"), &w("X:/zz/repo2/a.ts")), None);
    assert_eq!(relative_inside(&w("X:/zz/repo"), &w("X:/zz/repo")), None);
    assert_eq!(relative_inside(&w("X:/zz/repo"), &w("Y:/zz/repo/a.ts")), None);
    assert_eq!(relative_inside("/srv/repo", "/srv/repo/..cfg").as_deref(), Some("..cfg"));
    assert_eq!(relative_inside("/srv/repo", "/srv/Repo/a.ts"), None);
    assert_eq!(relative_inside("/srv/repo", "/srv/other/a.ts"), None);
}

#[test]
fn phase5_shapes() {
    let ws = || Some(WorkspaceInfo { cwd: Some("C:\\w".into()), ..Default::default() });
    let empty = norm(vec![ev("session.start", json!({}), "2026-10-01T00:00:00Z")], ws());
    assert!(empty.empty);
    let mut sub = ev("assistant.message", json!({"content": "sub", "model": "claude-haiku-5-5"}), "2026-10-01T00:00:06Z");
    sub.agent_id = Some(json!("call_x"));
    let r = norm(
        vec![
            ev("session.start", json!({"selectedModel": "11111111-2222-4333-8444-555555555555/claude-haiku-5-5", "context": {"cwd": "C:\\w"}}), "2026-10-01T00:00:00Z"),
            ev("user.message", json!({"content": "go"}), "2026-10-01T00:00:01Z"),
            ev("user.message", json!({"content": "", "isAutopilotContinuation": true}), "2026-10-01T00:00:02Z"),
            ev("tool.execution_start", json!({"toolName": "report_intent", "toolCallId": "r1"}), "2026-10-01T00:00:03Z"),
            ev("tool.execution_complete", json!({"toolCallId": "r1", "success": false}), "2026-10-01T00:00:03Z"),
            ev("tool.execution_start", json!({"toolName": "powershell", "toolCallId": "t1"}), "2026-10-01T00:00:04Z"),
            ev("tool.execution_complete", json!({"toolCallId": "t1", "success": true, "fileEdits": [{"path": "C:\\w\\gone.txt", "kind": "delete"}]}), "2026-10-01T00:00:05Z"),
            sub,
            ev("assistant.message", json!({"content": "main", "model": "claude-haiku-5.5"}), "2026-10-01T00:00:07Z"),
        ],
        ws(),
    );
    assert!(!r.empty);
    assert_eq!((r.turns, r.autopilot_continuations, r.assistant_messages), (1, 1, 1));
    assert_eq!(r.last_assistant_message.as_deref(), Some("main"));
    assert_eq!(r.models, vec!["claude-haiku-5.5"]);
    assert_eq!(
        v(&r.tools),
        json!({"byName": {"powershell": 1}, "total": 1, "internal": {"byName": {"report_intent": 1}, "total": 1}, "mcp": {}, "results": {"powershell": {"success": 1, "failure": 0, "denied": 0}}, "durations": {"powershell": [1000.0]}, "durationOutliers": {}})
    );
    assert_eq!(r.friction.tool_failures, 0);
    assert_eq!(v(&r.files), json!({"changed": [], "created": [], "deleted": ["C:\\w\\gone.txt"], "sessionState": 0}));
    assert_eq!(r.tokens.source, TokenSource::None);
}

#[test]
fn shutdown_model_metrics_merge_spellings() {
    let r = norm(
        vec![
            ev("user.message", json!({"content": "x"}), "2026-05-01T00:00:00Z"),
            ev(
                "session.shutdown",
                json!({"modelMetrics": {"claude-sonnet-5-5": {"usage": {"inputTokens": 10, "outputTokens": 1}, "requests": {"count": 1, "cost": 1}}, "claude-sonnet-5.5": {"usage": {"inputTokens": 5, "outputTokens": 2}, "requests": {"count": 2, "cost": 0}}}}),
                "2026-05-01T00:01:00Z",
            ),
        ],
        None,
    );
    assert_eq!(r.tokens.source, TokenSource::Shutdown);
    assert_eq!(r.tokens.by_model.keys().collect::<Vec<_>>(), vec!["claude-sonnet-5.5"]);
    let m = &r.tokens.by_model["claude-sonnet-5.5"];
    assert_eq!((m.input, m.output, m.requests, m.premium_requests), (Some(15.0), 3.0, Some(3.0), Some(1.0)));
    assert_eq!(r.models, vec!["claude-sonnet-5.5"]);
}

// ---------- wiki ----------

fn spec(path: &str) -> WikiSpec {
    WikiSpec { path: path.into(), ..Default::default() }
}

fn strs(xs: &[&str]) -> Option<Vec<String>> {
    Some(xs.iter().map(|s| s.to_string()).collect())
}

#[test]
fn wiki_kinds() {
    let c = WikiClassifier::new(&[WikiSpec { pages: strs(&["wiki"]), skills: strs(&["wiki-query"]), ..spec("my-wiki") }]);
    let mut w = empty_wiki();
    assert!(c.classify(&mut w, "view", Some(&json!({"path": "E:\\v\\my-wiki\\index.md"}))));
    assert!(c.classify(&mut w, "view", Some(&json!({"path": "E:\\v\\my-wiki\\wiki\\tech\\ページ.md"}))));
    assert!(c.classify(&mut w, "powershell", Some(&json!({"command": "Get-Content 'E:/v/my-wiki/wiki/meta/a b.md'"}))));
    assert!(c.classify(&mut w, "glob", Some(&json!({"pattern": "wiki*/**", "paths": ["E:\\v\\my-wiki"]}))));
    assert!(c.classify(&mut w, "edit", Some(&json!({"path": "E:\\v\\my-wiki\\log.md"}))));
    assert!(c.classify(&mut w, "skill", Some(&json!({"skill": "wiki-query"}))));
    assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": "impeccable"}))));
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "E:\\other\\index.md"}))));
    assert_eq!(v(&w), json!({"indexReads": 1, "pageReads": ["wiki/tech/ページ.md", "wiki/meta/a b.md"], "skillCalls": ["wiki-query"], "writes": 1, "otherCalls": 1}));

    let c = WikiClassifier::default();
    let mut w = empty_wiki();
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "E:/v/my-wiki/index.md"}))));
    assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": "wiki-query"}))));
    assert!(!c.is_skill("wiki-query", None));
    assert_eq!(w, empty_wiki());
}

#[test]
fn wiki_custom_formats() {
    let c = WikiClassifier::new(&[WikiSpec { index: strs(&["README.md", "00-home.md"]), pages: strs(&["notes", "areas/work"]), extensions: strs(&[".md", ".mdx"]), skills: strs(&["brain-search"]), ..spec("second-brain") }]);
    let mut w = empty_wiki();
    for p in ["D:\\vaults\\second-brain\\README.md", "D:/vaults/second-brain/00-home.md", "D:/vaults/second-brain/notes/a.mdx", "D:/vaults/second-brain/areas/work/b.md", "D:/vaults/second-brain/inbox/c.md"] {
        c.classify(&mut w, "view", Some(&json!({ "path": p })));
    }
    c.classify(&mut w, "skill", Some(&json!({"skill": "brain-search"})));
    assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": "wiki-query"}))));
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "E:\\v\\other-wiki\\index.md"}))));
    assert_eq!(v(&w), json!({"indexReads": 2, "pageReads": ["notes/a.mdx", "areas/work/b.md"], "skillCalls": ["brain-search"], "writes": 0, "otherCalls": 1}));

    let c = WikiClassifier::new(&[spec("notes")]);
    let mut w = empty_wiki();
    for p in ["D:/notes/index.md", "D:/notes/日記/2026.md", "D:/notes/top.md", "D:/notes/image.png"] {
        c.classify(&mut w, "view", Some(&json!({ "path": p })));
    }
    assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": "wiki-query"}))));
    assert_eq!(v(&w), json!({"indexReads": 1, "pageReads": ["日記/2026.md", "top.md"], "skillCalls": [], "writes": 0, "otherCalls": 1}));

    let mut w = empty_wiki();
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "D:/my-notes/index.md"}))));
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "D:/notes-app/index.md"}))));
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "D:/x/notes.md"}))));
    assert!(!c.classify(&mut w, "powershell", Some(&json!({"command": "cd D:\\x\nnotes-tool run"}))));
    assert!(c.classify(&mut w, "view", Some(&json!({"path": "D:/NOTES/index.md"}))));
    assert_eq!(w.index_reads, 1);
    assert!(c.is_skill("custom", Some(&json!("D:\\notes\\skills\\custom\\SKILL.md"))));
    assert!(!c.is_skill("custom", Some(&json!("D:\\other\\SKILL.md"))));

    let c = WikiClassifier::new(&[spec("D:\\vaults\\notes\\")]);
    let mut w = empty_wiki();
    assert!(c.classify(&mut w, "view", Some(&json!({"path": "D:/vaults/notes/index.md"}))));
    assert!(!c.classify(&mut w, "view", Some(&json!({"path": "E:\\vaults\\notes\\index.md"}))));

    let c = WikiClassifier::new(&[spec("my-wiki")]);
    let mut w = empty_wiki();
    c.classify(&mut w, "powershell", Some(&json!({"command": "cat E:/v/my-wiki/wiki/a.md\ncat E:/v/my-wiki/wiki/b.md"})));
    assert_eq!(w.page_reads, vec!["wiki/a.md", "wiki/b.md"]);

    let c = WikiClassifier::new(&[spec("alpha"), WikiSpec { pages: strs(&["docs"]), index: strs(&["HOME.md"]), ..spec("D:/x/beta") }]);
    let mut w = empty_wiki();
    for p in ["D:/alpha/wiki/a.md", "D:/x/beta/docs/a.md", "D:/x/beta/HOME.md"] {
        c.classify(&mut w, "view", Some(&json!({ "path": p })));
    }
    assert_eq!(w.index_reads, 1);
    assert_eq!(w.page_reads, vec!["alpha/wiki/a.md", "beta/docs/a.md"]);
}

// ---------- instructions ----------

fn wrap(s: &str) -> String {
    format!("<custom_instruction>\n{s}\n</custom_instruction>")
}

#[test]
fn instruction_blocks() {
    let body = "@AGENTS.md\n\n<imported_custom_instruction source=\"E:\\repo\\AGENTS.md\">\n# Repo rules\nabc\n</imported_custom_instruction>";
    let b = extract_instruction_blocks(&format!("head\n{}\ntail", wrap(body)));
    assert_eq!(b.len(), 2);
    assert_eq!((b[0].file, b[0].method, b[0].chars, b[0].source_path.as_deref()), (InstructionFile::AgentsMd, InstructionMethod::ImportedSource, char_count("# Repo rules\nabc"), Some("E:\\repo\\AGENTS.md")));
    assert_eq!((b[1].file, b[1].method), (InstructionFile::ClaudeMd, InstructionMethod::ImportStub));

    let content = [wrap("# Copilot Instructions\n本文"), wrap("# Claude project instructions\nx"), wrap("This instruction applies to files matching the pattern: **/*.ts\n\nuse strict"), wrap("# 共通の指示\n𠮷野家")].join("\n\n");
    let b = extract_instruction_blocks(&content);
    assert_eq!(
        b.iter().map(|x| (x.file, x.method)).collect::<Vec<_>>(),
        vec![
            (InstructionFile::CopilotInstructions, InstructionMethod::HeadingKeyword),
            (InstructionFile::ClaudeMd, InstructionMethod::HeadingKeyword),
            (InstructionFile::GithubInstructions, InstructionMethod::ApplyTo),
            (InstructionFile::Unknown, InstructionMethod::Unresolved),
        ]
    );
    assert_eq!(b[3].chars, "# 共通の指示\n".chars().count() as i64 + 3);
    assert_eq!(file_from_path("C:\\r\\.github\\instructions\\ts.instructions.md"), InstructionFile::GithubInstructions);
    assert_eq!(file_from_path("/x/.github/copilot-instructions.md"), InstructionFile::CopilotInstructions);
    assert_eq!(file_from_path("x/CLAUDE.md"), InstructionFile::ClaudeMd);
    assert_eq!(file_from_path("x/README.md"), InstructionFile::Unknown);
}

fn session_with(project: &str, contents: &[String]) -> SessionRecord {
    let mut c = InstructionCollector::new();
    for x in contents {
        c.add(x, Some("2026-01-01T00:00:00Z"));
    }
    let mut r = norm(Vec::new(), None);
    r.project = project.into();
    r.instructions = c.result();
    r
}

#[test]
fn collector_and_resolve() {
    let s = session_with("p", &[wrap("# A\nx"), wrap("# A\nx"), wrap("# B\ny")]);
    assert_eq!(s.instructions.iter().map(|i| i.injections).collect::<Vec<_>>(), vec![2, 1]);

    let imported = wrap("<imported_custom_instruction source=\"C:\\r\\AGENTS.md\">\n# Engine\nv1\n</imported_custom_instruction>");
    let global = wrap("# My global rules\nsame");
    let mut all = vec![session_with("r", &[imported]), session_with("r", &[wrap("# Engine\nv2 changed")])];
    for p in ["a", "b", "c"] {
        all.push(session_with(p, std::slice::from_ref(&global)));
    }
    all.push(session_with("z", &[wrap("# Lonely\nq")]));
    resolve_instructions(&mut all, 3);
    let i = &all[1].instructions[0];
    assert_eq!((i.file, i.method, i.scope), (InstructionFile::AgentsMd, InstructionMethod::LearnedHeading, InstructionScope::Repo));
    for s in &all[2..5] {
        let i = &s.instructions[0];
        assert_eq!((i.file, i.method, i.scope), (InstructionFile::CopilotInstructions, InstructionMethod::CrossProject, InstructionScope::User));
    }
    let i = &all[5].instructions[0];
    assert_eq!((i.file, i.method), (InstructionFile::Unknown, InstructionMethod::Unresolved));
}

// ---------- tool-failure ----------

#[test]
fn failure_causes() {
    let cases = [
        ("MCP server \"zz\": McpError: MCP error -32001: Request timed out", "timeout"),
        ("LSP server for X:\\zz\\a.sln: Request \"hover\" timed out after 30000ms.", "timeout"),
        ("timeout", "timeout"),
        ("CAPIError: 429 Sorry, you've exceeded your 5 hour session limits.", "quota"),
        ("402 You have exceeded your monthly quota", "quota"),
        ("Error: Failed to fetch https://example.invalid/a - status code 404", "network"),
        ("WebFetchRedirectError: web_fetch refused to follow redirect 301 from https://a.invalid to https://b.invalid", "network"),
        ("WebFetchBlockedUrlError: Error: そのようなホストは不明です。 (os error 11001)", "network"),
        ("web_fetch could not retrieve this URL: a transport-level failure (DNS, connection refused)", "network"),
        ("rg: X:\\zz\\secret: アクセスが拒否されました。 (os error 5)", "permission"),
        ("Blocked SQL statement: \"DROP\" is not allowed for security reasons.", "permission"),
        ("Failed to apply patch: Error: Failed to find expected lines in X:\\zz\\a.ts:", "no_match"),
        ("No match found", "no_match"),
        ("Path does not exist", "not_found"),
        ("Search paths do not exist: zz/src", "not_found"),
        ("rg: zz\\docs: 指定されたファイルが見つかりません。 (os error 2)", "not_found"),
        ("Failed to apply patch: Error: Failed to read file to update zz/a.ts: Error: ENOENT: no such file", "not_found"),
        ("Tool \"zz_tool\" does not exist.", "not_found"),
        ("Path already exists", "exists"),
        ("rg: regex parse error:", "invalid_input"),
        ("rg: unrecognized file type: zz", "invalid_input"),
        ("\"path\": Required", "invalid_input"),
        ("view_range out of bounds", "invalid_input"),
        ("rg: a;b: IO error for operation on a;b: ファイル名、ディレクトリ名、またはボリューム ラベルの構文が間違っています。 (os error 123)", "invalid_input"),
        ("Expected \",\" or \"}\" after property value in JSON at position 12 (line 1 column 13)", "invalid_input"),
        ("No LSP clients available", "unavailable"),
        ("Agent completed but produced no response.", "no_response"),
        ("MCP server \"zz\": KeyError: \"name\"", "tool_error"),
        ("MCP server \"zz\": {\"isError\":true,\"code\":\"zz\"}", "other"),
        ("", "other"),
    ];
    for (msg, cause) in cases {
        assert_eq!(classify_tool_failure(Some(&json!({"code": "failure", "message": msg}))), cause, "{msg}");
    }
    assert_eq!(classify_tool_failure(Some(&json!({"code": "failure", "message": "\n\nPath does not exist\nRequest timed out"}))), "not_found");
    assert_eq!(classify_tool_failure(Some(&json!("Request timed out"))), "timeout");
    assert_eq!(classify_tool_failure(Some(&json!({"code": "timeout"}))), "timeout");
    assert_eq!(classify_tool_failure(Some(&Value::Null)), "other");
    assert_eq!(classify_tool_failure(Some(&json!({"code": "failure"}))), "other");
    assert!(is_denied_error(Some(&json!({"code": "rejected", "message": "The user rejected this tool call."}))));
    assert!(!is_denied_error(None));
    for c in FAILURE_CAUSES {
        assert!(!failure_cause_label(c).is_empty() && !failure_cause_hint(c).is_empty());
    }
    let mut into: JsMap<i64> = JsMap::new();
    into.inc("timeout", 1);
    let mut from: JsMap<i64> = JsMap::new();
    from.inc("timeout", 2);
    from.inc("other", 1);
    add_causes(&mut into, Some(&from));
    assert_eq!(v(&into), json!({"timeout": 3, "other": 1}));
    let mut m: JsMap<i64> = JsMap::new();
    for (k, n) in [("other", 2), ("timeout", 2), ("not_found", 5), ("quota", 0)] {
        m.inc(k, n);
    }
    assert_eq!(sorted_causes(Some(&m)), vec![("not_found".to_string(), 5), ("timeout".to_string(), 2), ("other".to_string(), 2)]);
}

#[test]
fn failure_causes_in_sessions() {
    let mut n = 0;
    let mut evs = vec![ev("user.message", json!({"content": "a"}), "2026-10-01T00:00:00Z")];
    let mut call = |id: &str, tool: &str, error: Option<Value>, extra: Value| {
        let mut start = json!({"toolCallId": id, "toolName": tool, "arguments": {}});
        for (k, x) in extra.as_object().unwrap() {
            start[k] = x.clone();
        }
        n += 2;
        let ts = |k: i64| atlas_core::jsdate::to_iso(1_790_812_800_000 + k * 1000);
        evs.push(ev("tool.execution_start", start, &ts(n)));
        let done = match error {
            None => json!({"toolCallId": id, "success": true}),
            Some(e) => json!({"toolCallId": id, "success": false, "error": e}),
        };
        evs.push(ev("tool.execution_complete", done, &ts(n + 1)));
    };
    let fail = |m: &str| Some(json!({"code": "failure", "message": m}));
    let timed = "MCP server \"zz-srv\": McpError: MCP error -32001: Request timed out";
    call("1", "zz-srv-find", fail(timed), json!({"mcpServerName": "zz-srv"}));
    call("2", "zz-srv-find", fail(timed), json!({"mcpServerName": "zz-srv"}));
    call("3", "zz-srv-find", None, json!({"mcpServerName": "zz-srv"}));
    call("4", "view", fail("Path does not exist"), json!({}));
    call("5", "view", fail("view_range out of bounds"), json!({}));
    call("6", "powershell", Some(json!({"code": "rejected", "message": "The user rejected this tool call."})), json!({}));
    let r = norm(evs, Some(WorkspaceInfo { cwd: Some("X:\\zz".into()), created_at: Some("2026-10-01T00:00:00Z".into()), ..Default::default() }));
    assert_eq!(
        v(&r.tools.results),
        json!({
            "zz-srv-find": {"success": 1, "failure": 2, "denied": 0, "causes": {"timeout": 2}},
            "view": {"success": 0, "failure": 2, "denied": 0, "causes": {"not_found": 1, "invalid_input": 1}},
            "powershell": {"success": 0, "failure": 0, "denied": 1}
        })
    );
    assert!(!serde_json::to_string(&r.tools).unwrap().contains("Path does not exist"));
    let ts = &r.analysis.turn_stats.as_ref().unwrap()[0];
    assert_eq!((ts.tool_failures, ts.denied), (4, 1));
}
