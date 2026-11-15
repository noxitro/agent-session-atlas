// 失敗の台帳(analysis.failures)の振る舞い。イベントはすべて架空のもの
use atlas_core::failure_ledger::{ARGS_LIMIT, ERROR_LIMIT, MAX_ROWS, PROMPT_LIMIT};
use atlas_core::js;
use atlas_core::normalize::*;
use atlas_core::types::*;
use serde_json::{json, Value};

fn ev_x(kind: &str, data: Value, s: i64, agent: Option<&str>) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(json!(atlas_core::jsdate::to_iso(1_790_812_800_000 + s * 1000))), parent_id: None, agent_id: agent.map(|a| json!(a)) }
}

fn ev(kind: &str, data: Value, s: i64) -> CopilotEvent {
    ev_x(kind, data, s, None)
}

fn start(id: &str, tool: &str, args: Value, s: i64) -> CopilotEvent {
    ev("tool.execution_start", json!({"toolCallId": id, "toolName": tool, "arguments": args}), s)
}

fn ok(id: &str, s: i64) -> CopilotEvent {
    ev("tool.execution_complete", json!({"toolCallId": id, "success": true}), s)
}

fn fail(id: &str, msg: &str, s: i64) -> CopilotEvent {
    ev("tool.execution_complete", json!({"toolCallId": id, "success": false, "error": {"code": "failure", "message": msg}}), s)
}

fn user(content: &str, s: i64) -> CopilotEvent {
    ev("user.message", json!({"content": content}), s)
}

fn run(events: Vec<CopilotEvent>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: "s".into(), has_dir: None, workspace: None, db: DbInput::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

fn failures(r: &SessionRecord) -> &[ToolFailure] {
    r.analysis.failures.as_deref().unwrap()
}

/// 台帳の行数 + 切った件数 = tools.results の failure + denied
fn assert_invariant(r: &SessionRecord) {
    let counted: i64 = r.tools.results.values().map(|x| x.failure + x.denied).sum();
    assert_eq!(failures(r).len() as i64 + r.analysis.failures_dropped.unwrap(), counted);
}

#[test]
fn rows_match_tool_results() {
    let r = run(vec![
        user("x", 0),
        start("a", "view", json!({"path": "a.ts"}), 1),
        fail("a", "Path does not exist", 2),
        start("b", "edit", json!({}), 3),
        ev("tool.execution_complete", json!({"toolCallId": "b", "success": false, "error": {"code": "denied"}}), 4),
        // start の無い complete・内部ツールの失敗・success が真偽値でないものは数えない
        fail("zzz", "orphan", 5),
        ev("tool.execution_start", json!({"toolCallId": "r", "toolName": "report_intent"}), 6),
        fail("r", "internal", 7),
        start("c", "view", json!({}), 8),
        ev("tool.execution_complete", json!({"toolCallId": "c", "success": "no"}), 9),
        // 同じ toolCallId の complete が 2 回来ると、tools.results は 2 回数える。台帳も 2 行にする(2 行目は開始の材料なし)
        start("d", "grep", json!({"pattern": "p"}), 10),
        fail("d", "boom", 11),
        fail("d", "boom again", 12),
    ]);
    assert_invariant(&r);
    let f = failures(&r);
    assert_eq!(f.iter().map(|x| (x.tool.as_str(), x.kind)).collect::<Vec<_>>(), [("view", FailureKind::Failure), ("edit", FailureKind::Denied), ("grep", FailureKind::Failure), ("grep", FailureKind::Failure)]);
    assert_eq!(f[0].cause.as_deref(), Some("not_found"));
    assert_eq!(f[0].error, "failure: Path does not exist");
    assert_eq!(f[0].args.as_deref(), Some(r#"{"path":"a.ts"}"#));
    assert_eq!(f[0].duration_ms, Some(1000.0));
    assert_eq!(f[0].turn, Some(0));
    assert_eq!(f[1].cause, None);
    assert_eq!((f[3].args.as_deref(), f[3].started_at.as_deref(), f[3].duration_ms), (None, None, None));
    assert_eq!(r.analysis.failures_dropped, Some(0));
}

#[test]
fn empty_ledger_is_written_and_old_records_still_load() {
    let r = run(vec![user("x", 0), start("a", "view", json!({}), 1), ok("a", 2)]);
    assert_eq!(r.analysis.failures.as_deref(), Some(&[][..]));
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["analysis"]["failures"], json!([]));
    assert_eq!(v["analysis"]["failuresDropped"], json!(0));
    // 古い記録(failures・failuresDropped・resultsByModel・agents[].prompt が無い)も読める
    let mut old = v.clone();
    old["analysis"].as_object_mut().unwrap().remove("failures");
    old["analysis"].as_object_mut().unwrap().remove("failuresDropped");
    old["tools"].as_object_mut().unwrap().remove("resultsByModel");
    let back: SessionRecord = serde_json::from_value(old).unwrap();
    assert_eq!((back.analysis.failures, back.analysis.failures_dropped), (None, None));
    assert!(back.tools.results_by_model.is_empty());
}

#[test]
fn turn_is_null_before_the_first_request_and_counts_past_the_analysis_limit() {
    let mut evs = vec![start("p", "view", json!({}), 0), fail("p", "x", 1)];
    for i in 0..205 {
        evs.push(user(&format!("q{i}"), 10 + i * 3));
    }
    evs.push(start("q", "view", json!({}), 1000));
    evs.push(fail("q", "x", 1001));
    let r = run(evs);
    let f = failures(&r);
    assert_eq!(f[0].turn, None);
    assert_eq!(f[1].turn, Some(204));
    // 依頼の前の失敗の後に依頼が来たので、next は user
    assert_eq!(f[0].next.kind, NextKind::User);
}

#[test]
fn next_skips_parallel_calls_and_other_agents() {
    let r = run(vec![
        user("x", 0),
        // 並列: b は a の失敗より前に始まったので数えない
        start("a", "view", json!({"path": "x"}), 1),
        start("b", "grep", json!({}), 2),
        fail("a", "not found", 3),
        // 別のエージェントの呼び出しも数えない
        ev_x("tool.execution_start", json!({"toolCallId": "s1", "toolName": "bash", "arguments": {}}), 4, Some("agent-1")),
        ok("b", 5),
        // 同じ引数で呼び直した
        start("c", "view", json!({"path": "x"}), 6),
        ok("c", 7),
    ]);
    let f = failures(&r);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].next, FailureNext { kind: NextKind::Tool, tool: Some("view".into()), outcome: Some(CallOutcome::Success), retry: Some(true) });
}

#[test]
fn next_skips_calls_requested_in_the_same_reply() {
    let r = run(vec![
        user("x", 0),
        ev("assistant.message", json!({"content": "", "toolRequests": [{"toolCallId": "a", "name": "view"}, {"toolCallId": "b", "name": "grep"}]}), 1),
        start("a", "view", json!({"path": "x"}), 2),
        fail("a", "not found", 3),
        // 同じ応答で要求された b は、a の失敗の後に動いても失敗への反応ではない
        start("b", "grep", json!({}), 4),
        ok("b", 5),
        ev("assistant.message", json!({"content": "", "toolRequests": [{"toolCallId": "c", "name": "view"}]}), 6),
        start("c", "view", json!({"path": "y"}), 7),
        fail("c", "not found", 8),
        user("next", 9),
    ]);
    let f = failures(&r);
    assert_eq!(f[0].next, FailureNext { kind: NextKind::Tool, tool: Some("view".into()), outcome: Some(CallOutcome::Failure), retry: Some(false) });
    assert_eq!(f[1].next.kind, NextKind::User);
}

#[test]
fn subagents_are_told_apart_by_the_parent_call() {
    let prompt = format!("調べて token=abcdef123 {}", "あ".repeat(800));
    let r = run(vec![
        user("x", 0),
        start("t1", "task", json!({"agent_type": "explore", "prompt": prompt}), 1),
        start("t2", "task", json!({"agent_type": "explore", "prompt": "もう一方"}), 1),
        // parentToolCallId だけを持つ形
        ev("subagent.started", json!({"toolCallId": "t1", "agentName": "explore"}), 2),
        ev("tool.execution_start", json!({"toolCallId": "x1", "toolName": "view", "arguments": {}, "parentToolCallId": "t1"}), 3),
        ev("tool.execution_complete", json!({"toolCallId": "x1", "success": false, "error": "boom", "parentToolCallId": "t1"}), 4),
        // agentId だけを持つ形(同じ名前の別のエージェント。agentId → 親の呼び出しは subagent.started から分かる)
        ev_x("subagent.started", json!({"toolCallId": "t2", "agentName": "explore", "parentToolCallId": "t2"}), 5, Some("ag-2")),
        ev_x("tool.execution_start", json!({"toolCallId": "y1", "toolName": "view", "arguments": {}}), 6, Some("ag-2")),
        // 別のエージェント(t2)の呼び出しは、t1 の失敗の next にならない
        ev("tool.execution_start", json!({"toolCallId": "x2", "toolName": "grep", "arguments": {}, "parentToolCallId": "t1"}), 7),
        ev("tool.execution_complete", json!({"toolCallId": "x2", "success": true, "parentToolCallId": "t1"}), 8),
        ev_x("tool.execution_complete", json!({"toolCallId": "y1", "success": false, "error": "boom"}), 9, Some("ag-2")),
        ev("subagent.completed", json!({"toolCallId": "t1", "agentName": "explore"}), 10),
        ok("t1", 11),
    ]);
    let f = failures(&r);
    assert_eq!(f.iter().map(|x| (x.agent.as_deref(), x.agent_call.as_deref())).collect::<Vec<_>>(), [(Some("explore"), Some("t1")), (Some("explore"), Some("t2"))]);
    assert_eq!(f[0].next.tool.as_deref(), Some("grep"));
    assert_eq!(f[1].next.kind, NextKind::End);
    // サブエージェントの依頼文は agents[] に 1 回だけ、伏せてから上限で切って持つ
    let p = r.agents.iter().find(|a| a.id.as_deref() == Some("t1")).and_then(|a| a.prompt.as_deref()).unwrap();
    assert!(p.starts_with("調べて token=[伏せました: 名前の付いた秘密の値]"), "{p}");
    assert_eq!(js::utf16_len(p), PROMPT_LIMIT);
    assert_eq!(r.agents.iter().find(|a| a.id.as_deref() == Some("t2")).and_then(|a| a.prompt.as_deref()), Some("もう一方"));
}

#[test]
fn rows_are_capped_and_the_rest_counted() {
    let mut evs = vec![user("x", 0)];
    for i in 0..(MAX_ROWS as i64 + 7) {
        evs.push(start(&format!("c{i}"), "view", json!({}), 1 + i * 2));
        evs.push(fail(&format!("c{i}"), "x", 2 + i * 2));
    }
    let r = run(evs);
    assert_eq!(failures(&r).len(), MAX_ROWS);
    assert_eq!(r.analysis.failures_dropped, Some(7));
    assert_invariant(&r);
}

#[test]
fn text_fields_are_capped() {
    let r = run(vec![
        user("x", 0),
        start("a", "create", json!({"path": "a", "file_text": "x".repeat(5000)}), 1),
        fail("a", &"e".repeat(5000), 2),
    ]);
    let f = &failures(&r)[0];
    assert_eq!(js::utf16_len(&f.error), ERROR_LIMIT);
    assert!(f.error.ends_with('…'));
    assert_eq!(js::utf16_len(f.args.as_deref().unwrap()), ARGS_LIMIT);
    assert!(js::utf16_len(&f.group) <= atlas_core::failure_ledger::GROUP_LIMIT);
}

#[test]
fn secrets_are_redacted_in_error_and_args() {
    let key = format!("ghp_{}", "a".repeat(36));
    let r = run(vec![
        user("x", 0),
        // 上限が鍵の途中に掛かる位置に置いても残らない
        start("a", "bash", json!({"command": format!("{} curl -H 'Authorization: token {key}'", "x".repeat(ARGS_LIMIT - 40))}), 1),
        fail("a", &format!("auth failed for {key} at https://bob:hunter2@example.invalid/"), 2),
    ]);
    let f = &failures(&r)[0];
    assert!(!f.error.contains("ghp_") && !f.error.contains("hunter2"), "{}", f.error);
    assert!(f.error.contains("[伏せました: GitHub トークン]"));
    assert!(!f.args.as_deref().unwrap().contains("ghp_"));
    assert!(!f.group.contains("ghp"));
}

#[test]
fn mcp_fields_model_and_results_by_model() {
    let r = run(vec![
        user("x", 0),
        ev("tool.execution_start", json!({"toolCallId": "a", "toolName": "srv-search", "mcpServerName": "srv", "mcpToolName": "search", "mcpConfigSource": "user", "model": "m-start", "arguments": {}}), 1),
        ev("tool.execution_complete", json!({"toolCallId": "a", "success": false, "error": {"code": "failure", "message": "timed out"}, "model": "m-done"}), 2),
        ev("tool.execution_start", json!({"toolCallId": "b", "toolName": "srv-search", "mcpServerName": "srv", "model": "m-start", "arguments": {}}), 3),
        ok("b", 4),
        start("c", "view", json!({}), 5),
        ok("c", 6),
    ]);
    let f = &failures(&r)[0];
    assert_eq!((f.mcp_server.as_deref(), f.mcp_tool.as_deref(), f.mcp_config_source.as_deref(), f.model.as_deref()), (Some("srv"), Some("search"), Some("user"), Some("m-done")));
    let by = serde_json::to_value(&r.tools.results_by_model).unwrap();
    assert_eq!(
        by,
        json!({
            "m-done": {"srv-search": {"success": 0, "failure": 1, "denied": 0, "causes": {"timeout": 1}}},
            "m-start": {"srv-search": {"success": 1, "failure": 0, "denied": 0}},
            "(unknown)": {"view": {"success": 1, "failure": 0, "denied": 0}}
        })
    );
    // モデル別の合計は tools.results と一致する
    for (tool, res) in r.tools.results.iter() {
        let sum = |f: fn(&ToolResult) -> i64| r.tools.results_by_model.values().filter_map(|m| m.get(tool)).map(f).sum::<i64>();
        assert_eq!((sum(|x| x.success), sum(|x| x.failure), sum(|x| x.denied)), (res.success, res.failure, res.denied));
    }
}
