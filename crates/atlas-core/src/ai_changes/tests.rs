//! AI の変更の取り出し(packages/core/test/ai-changes.test.ts の移植)。イベントと差分はすべて架空のもの

use super::*;
use serde_json::json;
use std::cell::Cell;

const ROOT: &str = r"X:\zz\repo";

thread_local! {
    static N: Cell<u32> = const { Cell::new(0) };
}

fn ts(min: u32) -> String {
    format!("2026-11-01T10:{min:02}:00.000Z")
}

fn diff_of(path: &str, added: &[&str], removed: &[&str], created: bool) -> String {
    let p = path.replace('\\', "/");
    let mut v = vec![String::new(), format!("diff --git a/{p} b/{p}"), "index 0000000..1111111 100644".into(), format!("--- {}", if created { "a/dev/null".to_string() } else { format!("a/{p}") }), format!("+++ b/{p}"), "@@ -1,2 +1,3 @@".into(), " context".into()];
    v.extend(removed.iter().map(|l| format!("-{l}")));
    v.extend(added.iter().map(|l| format!("+{l}")));
    v.push(" tail".into());
    v.push(String::new());
    v.join("\n")
}

fn ev(kind: &str, timestamp: &str, data: Value) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(Value::String(timestamp.into())), parent_id: None, agent_id: None }
}

#[derive(Default)]
struct E {
    min: Option<u32>,
    tool: Option<&'static str>,
    args: Option<Value>,
    success: Option<bool>,
    no_diff: bool,
    created: bool,
}

/// 編集 1 回分(開始と完了)のイベント
fn edit(path: &str, added: &[&str], removed: &[&str], o: E) -> Vec<CopilotEvent> {
    let id = format!("call-{}", N.with(|n| {
        n.set(n.get() + 1);
        n.get()
    }));
    let tool = o.tool.unwrap_or(if o.created { "create" } else { "edit" });
    let args = o.args.clone().unwrap_or_else(|| json!({"path": path, "old_str": removed.join("\n"), "new_str": added.join("\n")}));
    let t = ts(o.min.unwrap_or(1));
    let result = if o.no_diff { json!({"content": "ok"}) } else { json!({"content": "ok", "detailedContent": diff_of(path, added, removed, o.created)}) };
    vec![
        ev("tool.execution_start", &t, json!({"toolCallId": id, "toolName": tool, "arguments": args})),
        ev("tool.execution_complete", &t, json!({"toolCallId": id, "success": o.success.unwrap_or(true), "result": result})),
    ]
}

fn start_with(ctx: Value) -> CopilotEvent {
    ev("session.start", &ts(0), json!({ "context": ctx }))
}

fn start() -> CopilotEvent {
    start_with(json!({"cwd": ROOT, "gitRoot": ROOT, "branch": "main", "headCommit": "abc123"}))
}

fn f() -> String {
    format!(r"{ROOT}\src\a.ts")
}

fn all(parts: Vec<Vec<CopilotEvent>>) -> Vec<CopilotEvent> {
    parts.into_iter().flatten().collect()
}

fn lines_of(s: &AiChangeSet) -> Vec<Vec<String>> {
    s.hunks.iter().map(|h| h.lines.clone()).collect()
}

fn block(added: &[&str], removed: &[&str]) -> Block {
    Block { added: added.iter().map(|s| s.to_string()).collect(), removed: removed.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn unified_diff_headers_and_blocks() {
    let d = parse_unified_diff(&diff_of("X:/zz/repo/a.ts", &["n1", "n2"], &["o1"], false));
    assert_eq!(d, vec![DiffFile { old_path: Some("X:/zz/repo/a.ts".into()), new_path: Some("X:/zz/repo/a.ts".into()), blocks: vec![block(&["n1", "n2"], &["o1"])] }]);
    // 新しいファイルは old_path が None
    assert_eq!(parse_unified_diff(&diff_of("X:/zz/a.ts", &["x"], &[], true))[0].old_path, None);
    // 塊の中の "--- " で始まる行は、消した行として読む(見出しと取り違えない)
    let text = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "--- old dashes", "+++ new pluses", ""].join("\n");
    assert_eq!(parse_unified_diff(&text)[0].blocks, vec![block(&["++ new pluses"], &["-- old dashes"])]);
    // 複数ファイルの diff を分ける
    let d = parse_unified_diff(&(diff_of("X:/a", &["1"], &[], false) + &diff_of("X:/b", &["2"], &[], false)));
    assert_eq!(d.iter().map(|x| x.new_path.clone().unwrap()).collect::<Vec<_>>(), ["X:/a", "X:/b"]);
}

#[test]
fn unified_diff_without_git_headers() {
    // diff --git の無い複数ファイルの diff でも、--- / +++ のすぐ後に @@ が続くものは次のファイルとして読む
    let text = ["--- a/one.ts", "+++ b/one.ts", "@@ -1,1 +1,2 @@", " x", "+in one", "--- a/two.ts", "+++ b/two.ts", "@@ -1,1 +1,2 @@", " y", "+in two", ""].join("\n");
    let d = parse_unified_diff(&text);
    assert_eq!(d.iter().map(|x| (x.new_path.clone().unwrap(), x.blocks.clone())).collect::<Vec<_>>(), vec![("one.ts".to_string(), vec![block(&["in one"], &[])]), ("two.ts".to_string(), vec![block(&["in two"], &[])])]);
}

#[test]
fn apply_patch_ops() {
    let p = parse_apply_patch(&["*** Begin Patch", r"*** Add File: X:\a.ts", "+one", r"*** Update File: X:\b.ts", "@@", " ctx", "-old", "+new", r"*** Delete File: X:\c.ts", "*** End Patch"].join("\n"));
    assert_eq!(
        p,
        vec![
            PatchFile { path: r"X:\a.ts".into(), op: PatchOp::Add, blocks: vec![block(&["one"], &[])] },
            PatchFile { path: r"X:\b.ts".into(), op: PatchOp::Update, blocks: vec![block(&["new"], &["old"])] },
            PatchFile { path: r"X:\c.ts".into(), op: PatchOp::Delete, blocks: vec![] },
        ]
    );
}

#[test]
fn context_with_sources() {
    let s = extract_ai_changes("s1", &all(vec![vec![start()], edit(&f(), &["const a = 1;"], &[], E::default())]), None);
    let c = &s.context;
    assert_eq!((c.cwd.as_deref(), c.git_root.as_deref(), c.branch.as_deref(), c.head_commit.as_deref()), (Some(ROOT), Some(ROOT), Some("main"), Some("abc123")));
    assert_eq!((c.start.clone(), c.end.clone()), (Some(ts(0)), Some(ts(1))));
    assert_eq!(serde_json::to_value(&c.sources).unwrap(), json!({"cwd": "events", "gitRoot": "events", "branch": "events", "headCommit": "events"}));
    assert_eq!(s.hunks.len(), 1);
    let h = &s.hunks[0];
    assert_eq!((h.id, h.path.as_str(), h.at.clone(), h.lines.clone(), h.from), (1, f().as_str(), Some(ts(1)), vec!["const a = 1;".to_string()], HunkFrom::Diff));
    assert!(h.tool_call_id.is_some());
}

#[test]
fn resume_does_not_override_head_commit() {
    let s = extract_ai_changes("s1", &[start(), ev("session.resume", &ts(5), json!({"context": {"cwd": ROOT, "headCommit": "later"}}))], None);
    assert_eq!(s.context.head_commit.as_deref(), Some("abc123"));
}

#[test]
fn rewritten_own_lines_are_not_counted() {
    let s = extract_ai_changes("s1", &all(vec![vec![start()], edit(&f(), &["v1 line", "keep line"], &[], E { min: Some(1), ..Default::default() }), edit(&f(), &["v2 line"], &["v1 line"], E { min: Some(2), ..Default::default() })]), None);
    assert_eq!(lines_of(&s), vec![vec!["keep line"], vec!["v2 line"]]);
    // AI が足していない行を消しても、何も起きない
    let s = extract_ai_changes("s1", &all(vec![vec![start()], edit(&f(), &["new"], &["pre-existing"], E::default())]), None);
    assert_eq!(lines_of(&s), vec![vec!["new"]]);
}

#[test]
fn failed_session_state_and_blank_lines_are_skipped() {
    let s = extract_ai_changes(
        "s1",
        &all(vec![
            vec![start()],
            edit(&f(), &["failed"], &[], E { success: Some(false), ..Default::default() }),
            edit(r"X:\home\zz\.copilot\session-state\x\plan.md", &["plan"], &[], E::default()),
            edit(&f(), &["   ", "real"], &[], E::default()),
        ]),
        None,
    );
    assert_eq!(lines_of(&s), vec![vec!["real"]]);
    assert_eq!(s.skipped, Skipped { failed: 1, session_state: 1, no_material: 0 });
}

#[test]
fn from_args_when_no_diff() {
    let new_ts = format!(r"{ROOT}\new.ts");
    let s = extract_ai_changes(
        "s1",
        &all(vec![
            vec![start()],
            edit(&f(), &[], &[], E { no_diff: true, args: Some(json!({"path": f(), "old_str": "a\nb", "new_str": "a\nb2\nc"})), ..Default::default() }),
            edit(&new_ts, &[], &[], E { no_diff: true, tool: Some("create"), args: Some(json!({"path": new_ts, "file_text": "x\n\ny"})), ..Default::default() }),
        ]),
        None,
    );
    assert_eq!(s.hunks.iter().map(|h| (h.lines.clone(), h.from)).collect::<Vec<_>>(), vec![(vec!["b2".to_string(), "c".into()], HunkFrom::Args), (vec!["x".to_string(), "y".into()], HunkFrom::Args)]);
    assert!(s.files.iter().find(|f| f.path.ends_with("new.ts")).unwrap().created);
}

#[test]
fn apply_patch_from_string_args() {
    let patch = ["*** Begin Patch".to_string(), format!(r"*** Add File: {ROOT}\p.ts"), "+p1".into(), r"*** Update File: src\a.ts".into(), "+u1".into(), "*** End Patch".into()].join("\n");
    let del = ["*** Begin Patch".to_string(), format!(r"*** Delete File: {ROOT}\p.ts"), "*** End Patch".into()].join("\n");
    let s = extract_ai_changes(
        "s1",
        &all(vec![
            vec![start()],
            edit("", &[], &[], E { no_diff: true, tool: Some("apply_patch"), args: Some(json!(patch)), min: Some(1), ..Default::default() }),
            edit("", &[], &[], E { no_diff: true, tool: Some("apply_patch"), args: Some(json!(del)), min: Some(2), ..Default::default() }),
        ]),
        None,
    );
    assert_eq!(s.hunks.iter().map(|h| (h.path.clone(), h.lines.clone())).collect::<Vec<_>>(), vec![(f(), vec!["u1".to_string()])]);
    let p = s.files.iter().find(|f| f.path.ends_with("p.ts")).unwrap();
    assert!(p.created && p.deleted);
}

#[test]
fn no_material() {
    let s = extract_ai_changes(
        "s1",
        &all(vec![
            vec![start()],
            edit(&f(), &[], &[], E { no_diff: true, args: Some(json!({"path": f()})), ..Default::default() }),
            edit("", &[], &[], E { no_diff: true, tool: Some("apply_patch"), args: Some(json!({"unknown": 1})), ..Default::default() }),
        ]),
        None,
    );
    assert!(s.hunks.is_empty());
    assert_eq!(s.skipped.no_material, 1);
}

#[test]
fn workspace_fills_missing_context() {
    let ws = WorkspaceHints { cwd: Some(r"X:\other".into()), git_root: Some(ROOT.into()), branch: Some("dev".into()) };
    let s = extract_ai_changes("s1", &[start_with(json!({"cwd": ROOT}))], Some(&ws));
    let c = &s.context;
    assert_eq!((c.cwd.as_deref(), c.git_root.as_deref(), c.branch.as_deref(), c.head_commit.as_deref()), (Some(ROOT), Some(ROOT), Some("dev"), None));
    assert_eq!(serde_json::to_value(&c.sources).unwrap(), json!({"cwd": "events", "gitRoot": "workspace", "branch": "workspace"}));
}

#[test]
fn recreated_file_drops_earlier_lines() {
    // create でファイルを作り直したら、前に足した行は数えない(diff が無い引数だけのときも)
    let c = format!(r"{ROOT}\c.ts");
    let s = extract_ai_changes(
        "s1",
        &all(vec![
            vec![start()],
            edit(&c, &[], &[], E { no_diff: true, tool: Some("create"), args: Some(json!({"path": c, "file_text": "old one\nold two"})), min: Some(1), ..Default::default() }),
            edit(&c, &[], &[], E { no_diff: true, tool: Some("create"), args: Some(json!({"path": c, "file_text": "new one"})), min: Some(2), ..Default::default() }),
        ]),
        None,
    );
    assert_eq!(lines_of(&s), vec![vec!["new one"]]);
}

#[test]
fn header_path_restores_posix_root() {
    assert_eq!(header_path("home/zz/x.ts", Some("/home/zz/repo")), "/home/zz/x.ts");
    assert_eq!(header_path("src/x.ts", Some("/home/zz/repo")), "src/x.ts");
    assert_eq!(header_path("E:/x/y", None), "E:/x/y");
}
