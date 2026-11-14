// normalize の振る舞い(packages/core/test/{normalize,log-shapes,phase6,phase7}.test.ts の normalize の部分を移したもの)

use atlas_core::normalize::*;
use atlas_core::types::*;
use atlas_core::wiki::{WikiClassifier, WikiSpec};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn ev(kind: &str, data: Value, ts: &str) -> CopilotEvent {
    ev_x(kind, data, ts, json!({}))
}

/// extra: agentId / parentId / id の上書き
fn ev_x(kind: &str, data: Value, ts: &str, extra: Value) -> CopilotEvent {
    let n = N.fetch_add(1, Ordering::SeqCst);
    CopilotEvent {
        kind: kind.into(),
        data: Some(data),
        id: Some(extra.get("id").cloned().unwrap_or_else(|| json!(format!("e{n}")))),
        timestamp: Some(json!(ts)),
        parent_id: extra.get("parentId").cloned(),
        agent_id: extra.get("agentId").cloned(),
    }
}

fn id_of(e: &CopilotEvent) -> Value {
    e.id.clone().unwrap()
}

/// 2026-10-01T00:00:00Z から s 秒後
fn t(s: i64) -> String {
    atlas_core::jsdate::to_iso(1_790_812_800_000 + s * 1000)
}

struct Input<'a> {
    workspace: Option<WorkspaceInfo>,
    db: DbInput<'a>,
    wiki: Option<WikiClassifier>,
    has_dir: Option<bool>,
}

impl Default for Input<'_> {
    fn default() -> Self {
        Input { workspace: None, db: DbInput::default(), wiki: None, has_dir: None }
    }
}

fn norm_with(events: Option<Vec<CopilotEvent>>, i: Input<'_>) -> SessionRecord {
    let mut it = events.map(|v| v.into_iter().map(Ok));
    normalize_session(NormalizeInput {
        id: "s".into(),
        has_dir: i.has_dir,
        workspace: i.workspace.as_ref(),
        db: i.db,
        events: it.as_mut().map(|x| x as &mut dyn Iterator<Item = std::io::Result<CopilotEvent>>),
        wiki_classifier: i.wiki.as_ref(),
    })
    .unwrap()
}

fn run(events: Vec<CopilotEvent>) -> SessionRecord {
    norm_with(Some(events), Input::default())
}

fn v<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap()
}

fn db_row(p: Value) -> DbUsageRow {
    let mut base = json!({
        "session_id": "s", "turn_index": 0, "agent_id": null, "parent_tool_call_id": null, "model": "m1",
        "input_tokens": 100, "output_tokens": 10, "cache_read_tokens": 50, "cache_write_tokens": 5, "reasoning_tokens": 1,
        "total_nano_aiu": 1000, "request_multiplier": 1, "initiator": "user", "created_at": "2026-10-01T00:00:01.000Z"
    });
    for (k, x) in p.as_object().unwrap() {
        base[k] = x.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn ur(p: Value, ts: &str, extra: Value) -> CopilotEvent {
    let mut u = json!({"model": "m1", "inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 50, "cacheWriteTokens": 5, "reasoningTokens": 1, "cost": 1, "initiator": "user", "copilotUsage": {"totalNanoAiu": 1000}});
    for (k, x) in p.as_object().unwrap() {
        u[k] = x.clone();
    }
    ev_x("session.usage_record", json!({ "usage": u }), ts, extra)
}

#[test]
fn merge_usage_prefers_db_and_drops_duplicates() {
    let rows = vec![db_row(json!({})), db_row(json!({"output_tokens": 20, "created_at": "2026-10-01T00:00:02.000Z", "initiator": "agent"}))];
    // usage_record を UsageItem にする(normalize と同じ読み方)
    let recs = vec![
        ur(json!({}), "2026-10-01T00:00:01.002Z", json!({})),
        ur(json!({"outputTokens": 20, "initiator": "agent"}), "2026-10-01T00:00:09.000Z", json!({})),
        ur(json!({"outputTokens": 30, "initiator": "agent"}), "2026-10-01T00:00:03.000Z", json!({})),
    ];
    // normalize_session を通して確かめる(DB 2 行 + 重複でない usage_record 2 行)
    let r = norm_with(Some(recs), Input { db: DbInput { usage: &rows, ..Default::default() }, ..Default::default() });
    assert_eq!(r.tokens.records, TokenRecords { db: 2, events: 2, duplicates_removed: 1 });
    assert_eq!(r.tokens.output, 10.0 + 20.0 + 20.0 + 30.0);
    assert_eq!(r.tokens.source, TokenSource::DbEvents);
}

#[test]
fn summarizes_tokens_skills_agents_hooks_friction_unknown() {
    let events = vec![
        ev("session.start", json!({"version": 1, "copilotVersion": "1.0.103", "context": {"cwd": "C:\\r", "gitRoot": "C:\\r", "repository": "o/r", "branch": "main"}}), "2026-10-01T00:00:00.000Z"),
        ev("system.message", json!({"role": "system", "content": "<custom_instruction>\n# Copilot Instructions\nabc\n</custom_instruction>"}), "2026-10-01T00:00:00.100Z"),
        ev("user.message", json!({"content": "do it"}), "2026-10-01T00:00:00.500Z"),
        ev("user.message", json!({"content": "skill body", "source": "skill-wiki-query"}), "2026-10-01T00:00:00.600Z"),
        ev("hook.start", json!({"hookType": "preToolUse"}), "2026-10-01T00:00:00.700Z"),
        ev("tool.execution_start", json!({"toolName": "skill", "toolCallId": "t1", "arguments": {"skill": "wiki-query"}}), "2026-10-01T00:00:01.000Z"),
        ev("skill.invoked", json!({"name": "wiki-query"}), "2026-10-01T00:00:01.100Z"),
        ev("skill.invoked", json!({"name": "impeccable"}), "2026-10-01T00:00:01.200Z"),
        ev("tool.execution_start", json!({"toolName": "view", "toolCallId": "t2", "arguments": {"path": "D:\\my-wiki\\index.md"}}), "2026-10-01T00:00:01.300Z"),
        ev("tool.execution_complete", json!({"toolCallId": "t2", "success": false}), "2026-10-01T00:00:01.400Z"),
        ev("tool.execution_start", json!({"toolName": "ask_user", "toolCallId": "t3", "arguments": {}}), "2026-10-01T00:00:01.500Z"),
        ev("tool.execution_start", json!({"toolName": "create", "toolCallId": "t4", "arguments": {"path": "C:\\r\\new.txt"}}), "2026-10-01T00:00:01.550Z"),
        ev_x("subagent.started", json!({"toolCallId": "a1", "agentName": "explore", "model": "m2"}), "2026-10-01T00:00:01.600Z", json!({"agentId": "a1"})),
        ev_x("assistant.message", json!({"content": "sub", "parentToolCallId": "a1", "model": "m2", "outputTokens": 7}), "2026-10-01T00:00:01.650Z", json!({"agentId": "a1"})),
        ev_x("subagent.completed", json!({"toolCallId": "a1", "agentName": "explore", "totalTokens": 999, "totalToolCalls": 3}), "2026-10-01T00:00:02.000Z", json!({"agentId": "a1"})),
        ev("subagent.failed", json!({"toolCallId": "a2", "agentName": "general-purpose", "error": "x"}), "2026-10-01T00:00:02.100Z"),
        ur(json!({"model": "m2", "inputTokens": 40, "outputTokens": 4, "initiator": "sub-agent", "cost": 1}), "2026-10-01T00:00:02.200Z", json!({"agentId": "a1"})),
        ev("session.compaction_complete", json!({"success": true, "preCompactionTokens": 1234}), "2026-10-01T00:00:03.000Z"),
        ev("abort", json!({"reason": "user_initiated"}), "2026-10-01T00:00:04.000Z"),
        ev("session.error", json!({"errorType": "quota"}), "2026-10-01T00:00:05.000Z"),
        ev("permission.requested", json!({}), "2026-10-01T00:00:06.000Z"),
        ev("session.model_change", json!({"newModel": "m3"}), "2026-10-01T00:00:07.000Z"),
        ev("session.mode_changed", json!({"newMode": "plan"}), "2026-10-01T00:00:08.000Z"),
        ev("brand.new_event", json!({}), "2026-10-01T00:00:09.000Z"),
        ev("assistant.message", json!({"content": "done!", "model": "m1", "outputTokens": 10}), "2026-10-01T00:20:00.000Z"),
    ];
    let session = DbSessionRow {
        id: "s".into(),
        cwd: Some("C:\\r".into()),
        repository: Some("o/r".into()),
        host_type: Some("github".into()),
        branch: Some("main".into()),
        summary: Some("sum".into()),
        created_at: Some("2026-10-01 00:00:00".into()),
        updated_at: Some("2026-10-01 00:20:00".into()),
    };
    let usage = vec![db_row(json!({}))];
    let r = norm_with(
        Some(events),
        Input {
            has_dir: Some(true),
            wiki: Some(WikiClassifier::new(&[WikiSpec { path: "my-wiki".into(), skills: Some(vec!["wiki-query".into()]), ..Default::default() }])),
            workspace: Some(WorkspaceInfo { client_name: Some("github/cli".into()), created_at: Some("2026-10-01T00:00:00.000Z".into()), updated_at: Some("2026-10-01T00:20:00.000Z".into()), ..Default::default() }),
            db: DbInput { session: Some(&session), usage: &usage, ..Default::default() },
        },
    );
    assert_eq!(r.sources, vec![SessionSource::Db, SessionSource::Dir]);
    assert_eq!(r.project, "o/r");
    assert_eq!(r.client.as_deref(), Some("github/cli"));
    assert_eq!(r.turns, 1);
    assert_eq!(r.first_user_message.as_deref(), Some("do it"));
    assert_eq!(r.last_assistant_message.as_deref(), Some("done!"));
    assert_eq!(r.copilot_version.as_deref(), Some("1.0.103"));
    assert_eq!(r.duration_ms, Some(20.0 * 60.0 * 1000.0));
    assert_eq!(r.active_ms, Some(9000.0));
    assert_eq!(r.tokens.source, TokenSource::DbEvents);
    assert_eq!(r.tokens.input, Some(140.0));
    assert_eq!(r.tokens.output, 14.0);
    assert_eq!(r.tokens.premium_requests, Some(1.0));
    assert_eq!(r.tokens.by_agent["explore"].input, Some(40.0));
    assert_eq!(r.tokens.by_agent["main"].input, Some(100.0));
    assert_eq!(r.tokens.subagent_total_tokens, 999.0);
    assert_eq!(r.tokens.max_pre_compaction_tokens, Some(1234.0));
    assert_eq!(
        v(&r.tools),
        json!({
            "byName": {"skill": 1, "view": 1, "ask_user": 1, "create": 1},
            "total": 4,
            "internal": {"byName": {}, "total": 0},
            "mcp": {},
            "results": {"view": {"success": 0, "failure": 1, "denied": 0, "causes": {"other": 1}}},
            "durations": {"view": [100.0]},
            "durationOutliers": {}
        })
    );
    assert_eq!(r.skills.iter().map(|s| (s.name.as_str(), s.via)).collect::<Vec<_>>(), vec![("wiki-query", SkillVia::Both), ("impeccable", SkillVia::Event)]);
    assert_eq!(r.agents.iter().map(|a| (a.name.as_str(), a.status, a.total_tokens)).collect::<Vec<_>>(), vec![("explore", AgentStatus::Completed, Some(999.0)), ("general-purpose", AgentStatus::Failed, None)]);
    assert_eq!(v(&r.hooks), json!({"byType": {"preToolUse": 1}, "total": 1}));
    assert_eq!(r.wiki.index_reads, 1);
    assert_eq!(r.wiki.skill_calls, vec!["wiki-query"]);
    assert_eq!(
        v(&r.friction),
        json!({"compactions": 1, "aborts": 1, "errors": 1, "permissionRequests": 1, "askUser": 1, "modelChanges": 1, "modeChanges": 1, "toolFailures": 1, "subagentFailures": 1})
    );
    assert_eq!(r.instructions.iter().map(|i| i.file).collect::<Vec<_>>(), vec![InstructionFile::CopilotInstructions]);
    assert_eq!(r.files.created, vec!["C:\\r\\new.txt"]);
    assert_eq!(v(&r.unknown_event_types), json!({"brand.new_event": 1}));
    assert_eq!(r.models, vec!["m1", "m2", "m3"]);
    // JSON に書く並び(TS 版のオブジェクトの組み立て順)
    let keys: Vec<String> = v(&r).as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys[..5], ["id", "sources", "client", "cwd", "gitRoot"]);
    let exec_keys: Vec<String> = v(&r.exec).as_object().unwrap().keys().cloned().collect();
    assert_eq!(exec_keys, ["modes", "context", "efforts", "modelEfforts", "initiators", "latency"]);
}

#[test]
fn legacy_and_db_only() {
    let legacy = run(vec![ev("assistant.message", json!({"content": "a", "model": "m", "outputTokens": 5}), "2026-01-01T00:00:00Z")]);
    assert_eq!((legacy.tokens.input, legacy.tokens.output, legacy.tokens.source), (None, 5.0, TokenSource::Partial));
    assert_eq!(legacy.tokens.by_model["m"].input, None);

    let session = DbSessionRow { id: "d".into(), cwd: Some("C:/x/".into()), summary: Some("s".into()), created_at: Some("2026-01-01 00:00:00".into()), updated_at: Some("2026-01-01 00:10:00".into()), ..Default::default() };
    let turns = vec![
        DbTurnRow { session_id: "d".into(), turn_index: 1.0, user_message: Some("second".into()), assistant_response: Some("r2".into()), timestamp: None },
        DbTurnRow { session_id: "d".into(), turn_index: 0.0, user_message: Some("first".into()), assistant_response: Some("r1".into()), timestamp: None },
    ];
    let d = norm_with(None, Input { db: DbInput { session: Some(&session), turns: &turns, ..Default::default() }, ..Default::default() });
    assert_eq!(d.sources, vec![SessionSource::Db]);
    assert_eq!(d.turns, 2);
    assert_eq!(d.first_user_message.as_deref(), Some("first"));
    assert_eq!(d.last_assistant_message.as_deref(), Some("r2"));
    assert_eq!(d.tokens.source, TokenSource::None);
    assert_eq!(d.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));
    assert_eq!(d.duration_ms, Some(600_000.0));
    assert_eq!(d.project, "C:\\x");
    // DB だけのターンのモードは (unknown)
    assert_eq!(v(&d.exec.modes), json!({"byMode": {"(unknown)": 2}, "inferred": 0}));
}

fn skill_list(xs: &[(&str, Option<&str>)]) -> String {
    let item = |(n, l): &(&str, Option<&str>)| {
        let mut v = vec!["<skill>".to_string(), format!("  <name>{n}</name>"), format!("  <description>説明 &quot;{n}&quot;</description>")];
        if let Some(l) = l {
            v.push(format!("  <location>{l}</location>"));
        }
        v.push("</skill>".into());
        v.join("\n")
    };
    let mut v = vec!["<skill>".to_string(), "<available_skills>".to_string()];
    v.extend(xs.iter().map(item));
    v.push("</available_skills>".into());
    v.push("</skill>".into());
    v.join("\n")
}

#[test]
fn available_skills() {
    let a = |n: &str, l: Option<&str>| AvailableSkill { name: n.into(), location: l.map(str::to_string) };
    assert_eq!(
        available_skills_of(&format!("前置き\n{}\n<sql>…</sql>", skill_list(&[("wiki-query", Some("user")), ("github-pr-media", Some("builtin")), ("no-loc", None)]))),
        Some(vec![a("wiki-query", Some("user")), a("github-pr-media", Some("builtin")), a("no-loc", None)])
    );
    assert_eq!(available_skills_of("<custom_instruction># x</custom_instruction> a skilled engineer"), None);
    let full = skill_list(&[("a", Some("project")), ("b", Some("custom"))]);
    let cut_at = full.find("</available_skills>").unwrap();
    let cut = &full[..cut_at - 20];
    assert_eq!(available_skills_of(cut), Some(vec![a("a", Some("project"))]));
    assert_eq!(
        available_skills_of(&format!("{}\n間の文\n{}\n{cut}", skill_list(&[("a", Some("user"))]), skill_list(&[("b", Some("builtin"))]))),
        Some(vec![a("a", Some("user")), a("b", Some("builtin")), a("a", Some("project"))])
    );
    let r = run(vec![
        ev("system.message", json!({"role": "system", "content": skill_list(&[("a", Some("user")), ("b", Some("project"))])}), "2026-10-01T00:00:00Z"),
        ev("system.message", json!({"role": "system", "content": skill_list(&[("b", Some("project")), ("c", Some("builtin"))])}), "2026-10-01T00:01:00Z"),
    ]);
    assert_eq!(r.available_skills, Some(Some(vec![a("a", Some("user")), a("b", Some("project")), a("c", Some("builtin"))])));
    let none = run(vec![ev("system.message", json!({"role": "system", "content": "You are a skilled engineer."}), "2026-10-01T00:00:00Z")]);
    assert_eq!(none.available_skills, Some(None));
}

#[test]
fn helpers() {
    assert_eq!(normalize_time(Some("2026-07-08 01:02:03")).as_deref(), Some("2026-07-08T01:02:03Z"));
    assert_eq!(normalize_time(Some("2026-07-08T01:02:03.000Z")).as_deref(), Some("2026-07-08T01:02:03.000Z"));
    assert_eq!(project_key(None, Some("e:\\dev\\r\\"), None), "E:\\dev\\r");
    assert_eq!(project_key(None, None, None), "(unknown)");
    assert_eq!(normalize_effort(Some(&json!(" XHigh "))).as_deref(), Some("xhigh"));
    assert_eq!(normalize_effort(Some(&json!(""))), None);
    assert_eq!(normalize_effort(Some(&json!(3))), None);
    assert_eq!(subagent_failure_reason(Some(&json!("402 You have exceeded your monthly quota"))), "quota");
    assert_eq!(subagent_failure_reason(Some(&json!("CAPIError: 429 Sorry, you've exceeded your 5 hour session limit"))), "rate_limit");
    assert_eq!(subagent_failure_reason(Some(&json!("AbortError: This operation was aborted"))), "aborted");
    assert_eq!(subagent_failure_reason(Some(&json!("No response generated"))), "no_response");
    assert_eq!(subagent_failure_reason(Some(&json!("boom"))), "other");
    assert_eq!(subagent_failure_reason(None), "unknown");
    assert_eq!(subagent_failure_reason(Some(&json!({"message": "rate limit hit"}))), "rate_limit");
}

// ---------- log-shapes ----------

#[test]
fn compaction_tokens_old_and_new_shapes() {
    let r = run(vec![
        ev("session.compaction_complete", json!({"success": true, "compactionTokensUsed": {"input": 2000, "output": 300, "cachedInput": 1500}}), &t(1)),
        ev("session.compaction_complete", json!({"success": true, "compactionTokensUsed": {"inputTokens": 1000, "outputTokens": 100, "cacheReadTokens": 900, "copilotUsage": {"totalNanoAiu": 5}}}), &t(2)),
    ]);
    let c = &r.friction_detail.compaction;
    assert_eq!((c.recorded, c.input, c.output, c.nano_aiu), (2, 3000.0, 400.0, 5.0));
    let none = run(vec![ev("session.compaction_complete", json!({"compactionTokensUsed": {"inputTokens": 1, "outputTokens": 1}}), &t(1))]);
    assert_eq!((none.friction_detail.compaction.tokens_removed, none.friction_detail.compaction.removed_recorded), (0.0, Some(0)));
    let some = run(vec![ev("session.compaction_complete", json!({"tokensRemoved": 700}), &t(1)), ev("session.compaction_complete", json!({}), &t(2))]);
    assert_eq!((some.friction_detail.compaction.tokens_removed, some.friction_detail.compaction.removed_recorded), (700.0, Some(1)));
}

fn empty_shutdown(s: i64) -> CopilotEvent {
    ev("session.shutdown", json!({"totalNanoAiu": 0, "modelMetrics": {}, "systemTokens": 0, "conversationTokens": 0, "codeChanges": {"linesAdded": 0, "linesRemoved": 0, "filesModified": []}}), &t(s))
}

#[test]
fn line_changes() {
    let r = run(vec![
        ev("session.start", json!({"context": {"cwd": "C:\\w"}}), &t(0)),
        ev("tool.execution_start", json!({"toolName": "edit", "toolCallId": "e1", "arguments": {"path": "C:\\w\\a.ts"}}), &t(1)),
        ev("tool.execution_complete", json!({"toolCallId": "e1", "success": true, "toolTelemetry": {"metrics": {"linesAdded": 4, "linesRemoved": 2}}}), &t(2)),
        empty_shutdown(3),
    ]);
    assert_eq!(v(&r.lines), json!({"added": 4.0, "removed": 2.0, "source": "tools", "note": "empty-shutdown"}));
    let r = run(vec![
        ev("session.start", json!({"context": {"cwd": "C:\\w"}}), &t(0)),
        ev_x("tool.execution_start", json!({"toolName": "create", "toolCallId": "c1", "arguments": {"path": "C:\\w\\new.ts"}}), &t(1), json!({"agentId": "agent-1"})),
        ev_x("tool.execution_complete", json!({"toolCallId": "c1", "success": true}), &t(2), json!({"agentId": "agent-1"})),
        ev("session.shutdown", json!({"codeChanges": {"linesAdded": 0, "linesRemoved": 0, "filesModified": []}}), &t(3)),
    ]);
    assert_eq!(r.files.created.len(), 1);
    assert_eq!(v(&r.lines), json!({"added": 0.0, "removed": 0.0, "source": "none", "note": "subagent-edits"}));
    let r = run(vec![empty_shutdown(1)]);
    assert_eq!(v(&r.lines), json!({"added": 0.0, "removed": 0.0, "source": "shutdown"}));

    // phase6: 最後に codeChanges を持つ shutdown を優先、無ければツールの合計、どちらも無ければ none
    let tools = || {
        vec![
            ev("tool.execution_start", json!({"toolCallId": "a", "toolName": "edit", "arguments": {"path": "X:\\p\\a.ts"}}), &t(10)),
            ev("tool.execution_complete", json!({"toolCallId": "a", "success": true, "toolTelemetry": {"metrics": {"linesAdded": 5, "linesRemoved": 2}}}), &t(11)),
            ev("tool.execution_start", json!({"toolCallId": "b", "toolName": "edit", "arguments": {"path": "X:\\p\\b.ts"}}), &t(12)),
            ev("tool.execution_complete", json!({"toolCallId": "b", "success": true, "toolTelemetry": {"metrics": {"linesAdded": 1}}}), &t(13)),
        ]
    };
    let mut evs = tools();
    evs.push(ev("session.shutdown", json!({"codeChanges": {"linesAdded": 3, "linesRemoved": 0, "filesModified": []}}), &t(14)));
    evs.push(ev("session.resume", json!({}), &t(15)));
    evs.push(ev("session.shutdown", json!({"codeChanges": {"linesAdded": 9, "linesRemoved": 4, "filesModified": []}}), &t(16)));
    evs.push(ev("session.shutdown", json!({"shutdownType": "routine"}), &t(17)));
    assert_eq!(v(&run(evs).lines), json!({"added": 9.0, "removed": 4.0, "source": "shutdown"}));
    assert_eq!(v(&run(tools()).lines), json!({"added": 6.0, "removed": 2.0, "source": "tools"}));
    assert_eq!(v(&run(vec![ev("user.message", json!({"content": "x"}), &t(1))]).lines), json!({"added": 0.0, "removed": 0.0, "source": "none"}));
}

#[test]
fn deleted_file_stays_deleted_after_summary() {
    let r = norm_with(
        Some(vec![
            ev("tool.execution_start", json!({"toolCallId": "a", "toolName": "edit", "arguments": {"path": "a.ts"}}), &t(1)),
            ev("tool.execution_complete", json!({"toolCallId": "a", "success": true, "fileEdits": [{"path": "X:\\p\\gone.txt", "kind": "delete"}]}), &t(2)),
            ev("session.shutdown", json!({"codeChanges": {"linesAdded": 1, "linesRemoved": 1, "filesModified": ["X:\\p\\gone.txt", "X:\\p\\a.ts", "X:\\p\\only-summary.ts"]}}), &t(3)),
        ]),
        Input { workspace: Some(WorkspaceInfo { cwd: Some("X:\\p".into()), ..Default::default() }), ..Default::default() },
    );
    assert_eq!(v(&r.files), json!({"changed": ["X:\\p\\a.ts", "X:\\p\\only-summary.ts"], "created": [], "deleted": ["X:\\p\\gone.txt"], "sessionState": 0}));
}

#[test]
fn friction_pairs_are_counted_once() {
    let err = ev_x("session.error", json!({"errorType": "quota", "message": "402"}), &t(1), json!({"agentId": "call-1"}));
    let err_id = id_of(&err);
    let r = run(vec![
        ev("subagent.started", json!({"agentName": "implementer", "toolCallId": "call-1"}), &t(0)),
        err,
        ev_x("subagent.failed", json!({"agentName": "implementer", "toolCallId": "call-1", "error": "402 quota"}), &t(1), json!({"agentId": "call-1", "parentId": err_id})),
        ev_x("session.error", json!({"errorType": "rate_limit"}), &t(5), json!({"agentId": "call-2"})),
        ev("session.error", json!({"errorType": "query"}), &t(6)),
    ]);
    assert_eq!(r.friction.subagent_failures, 1);
    assert_eq!(r.friction.errors, 2);
    assert_eq!(v(&r.friction_detail.error_types), json!({"rate_limit": 1, "query": 1}));
    assert_eq!(v(&r.friction_detail.subagent_failures), json!({"quota": 1}));

    let a1 = ev("abort", json!({"reason": "user initiated"}), "2026-10-01T00:00:10.000Z");
    let a1_id = id_of(&a1);
    let r = run(vec![
        a1,
        ev_x("abort", json!({"reason": "user initiated"}), "2026-10-01T00:00:10.003Z", json!({"parentId": a1_id})),
        ev_x("abort", json!({"reason": "user initiated"}), "2026-10-01T00:05:00.000Z", json!({"parentId": "other"})),
    ]);
    assert_eq!(r.friction.aborts, 2);
    assert_eq!(r.timeline.iter().filter(|x| x.kind == TimelineKind::Abort).count(), 2);
}

#[test]
fn context_model_change_and_timeline() {
    let r = run(vec![ev("session.shutdown", json!({"systemTokens": 0, "conversationTokens": 0, "toolDefinitionsTokens": 19000}), &t(1))]);
    assert_eq!(v(&r.exec.context), json!({"systemTokens": null, "conversationTokens": null, "toolDefinitionsTokens": 19000.0, "availableToolCount": null, "source": "shutdown"}));

    let r = run(vec![
        ev("session.start", json!({"selectedModel": "m-main", "reasoningEffort": "medium"}), &t(0)),
        ev_x("session.model_change", json!({"source": "agent", "newModel": "m-sub", "reasoningEffort": "xhigh"}), &t(1), json!({"agentId": "call-1"})),
        ev("session.model_change", json!({"newModel": "m-main2", "previousModel": "m-main"}), &t(2)),
        ev("session.usage_record", json!({"usage": {"model": "m-main2", "inputTokens": 10, "outputTokens": 1, "initiator": "user", "cost": 1}}), &t(3)),
    ]);
    assert_eq!(r.friction.model_changes, 1);
    assert_eq!(r.friction_detail.agent_model_changes, Some(1));
    assert_eq!(r.exec.efforts.keys().collect::<Vec<_>>(), vec!["medium"]);

    let r = run(vec![ev("user.message", json!({"content": "依頼"}), &t(0)), ev("session.shutdown", json!({"shutdownType": "routine"}), "2026-10-12T00:00:00.000Z")]);
    assert_eq!(r.timeline.iter().map(|x| x.kind).collect::<Vec<_>>(), vec![TimelineKind::User, TimelineKind::Shutdown]);
    assert_eq!((r.timeline[1].at.as_str(), r.timeline[1].label.as_str()), ("2026-10-12T00:00:00.000Z", "routine"));
    let r = run(vec![
        ev("user.message", json!({"content": "依頼"}), &t(0)),
        ev("session.shutdown", json!({}), &t(10)),
        ev("session.resume", json!({}), &t(11)),
        ev("user.message", json!({"content": "続き"}), &t(12)),
    ]);
    assert_eq!(r.timeline.iter().map(|x| x.kind).collect::<Vec<_>>(), vec![TimelineKind::User, TimelineKind::User]);
}

#[test]
fn turn_active_time() {
    let r = run(vec![
        ev("user.message", json!({"content": "一つ目"}), &t(0)),
        ev("assistant.message", json!({"content": "a"}), &t(60)),
        ev("permission.requested", json!({}), &t(120)),
        ev("permission.completed", json!({}), &t(720)),
        ev("assistant.message", json!({"content": "b"}), &t(780)),
        ev("user.message", json!({"content": "二つ目"}), &t(960)),
        ev("assistant.message", json!({"content": "c"}), &t(990)),
    ]);
    assert_eq!(r.analysis.turn_ms, vec![Some(780_000.0), Some(30_000.0)]);
    assert_eq!(r.analysis.turn_active_ms, vec![Some(180_000.0), Some(30_000.0)]);
}

// ---------- phase6 ----------

#[test]
fn tool_results_mcp_and_skill_triggers() {
    let r = run(vec![
        ev("user.message", json!({"content": "x"}), &t(0)),
        ev("tool.execution_start", json!({"toolCallId": "a", "toolName": "srv-search", "mcpServerName": "srv", "arguments": {}}), &t(1)),
        ev("tool.execution_complete", json!({"toolCallId": "a", "success": false, "error": {"code": "failure"}}), &t(2)),
        ev("tool.execution_start", json!({"toolCallId": "b", "toolName": "srv-search", "mcpServerName": "srv", "arguments": {}}), &t(3)),
        ev("tool.execution_complete", json!({"toolCallId": "b", "success": true}), &t(4)),
        ev("tool.execution_start", json!({"toolCallId": "c", "toolName": "view", "arguments": {}}), &t(5)),
        ev("tool.execution_complete", json!({"toolCallId": "c", "success": false, "error": {"code": "denied"}}), &t(6)),
        ev("tool.execution_complete", json!({"toolCallId": "zzz", "success": false}), &t(7)),
        ev("tool.execution_start", json!({"toolCallId": "d", "toolName": "skill", "arguments": {"skill": "k1"}}), &t(8)),
        ev("skill.invoked", json!({"name": "k1", "trigger": "user-invoked"}), &t(9)),
        ev("skill.invoked", json!({"name": "k2", "trigger": "agent-invoked"}), &t(10)),
        ev("skill.invoked_ref", json!({"name": "k3"}), &t(11)),
        ev("tool.execution_start", json!({"toolCallId": "e", "toolName": "skill", "arguments": {"skill": "k4"}}), &t(12)),
    ]);
    assert_eq!(v(&r.tools.mcp), json!({"srv": {"srv-search": 2}}));
    assert_eq!(v(&r.tools.results), json!({"srv-search": {"success": 1, "failure": 1, "denied": 0, "causes": {"other": 1}}, "view": {"success": 0, "failure": 0, "denied": 1}}));
    assert_eq!(r.friction.tool_failures, 3);
    assert_eq!(
        r.skills.iter().map(|s| (s.name.as_str(), s.via, s.trigger)).collect::<Vec<_>>(),
        vec![
            ("k1", SkillVia::Both, Some(SkillTrigger::User)),
            ("k2", SkillVia::Event, Some(SkillTrigger::Agent)),
            ("k3", SkillVia::Event, None),
            ("k4", SkillVia::Tool, Some(SkillTrigger::Agent)),
        ]
    );
    // ツールだけの skill には chars のキーが無く、イベントの skill には(無ければ null で)ある
    let skills = v(&r.skills);
    assert!(skills[3].get("chars").is_none());
    assert_eq!(skills[2]["chars"], Value::Null);
}

// ---------- phase7 ----------

fn p7(dt: i64, kind: &str, data: Value) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(json!(atlas_core::jsdate::to_iso(1_792_972_800_000 + dt))), parent_id: None, agent_id: None }
}

#[test]
fn exec_profile() {
    let r = run(vec![
        p7(0, "session.start", json!({"reasoningEffort": "medium", "context": {"cwd": "X:\\p"}})),
        p7(1000, "user.message", json!({"content": "a"})),
        p7(2000, "tool.execution_start", json!({"toolCallId": "r", "toolName": "report_intent"})),
        p7(2100, "tool.execution_complete", json!({"toolCallId": "r", "success": true})),
        p7(3000, "tool.execution_start", json!({"toolCallId": "c", "toolName": "view"})),
        p7(3250, "tool.execution_complete", json!({"toolCallId": "c", "success": true})),
        p7(4000, "session.usage_record", json!({"usage": {"model": "claude-haiku-5-5", "inputTokens": 10, "outputTokens": 1, "initiator": "user", "duration": 1500.4, "timeToFirstTokenMs": 700.6, "toolTokenCount": 4000, "availableToolCount": 12}})),
        p7(5000, "session.model_change", json!({"newModel": "gpt-5.5", "reasoningEffort": null})),
        p7(6000, "session.usage_record", json!({"usage": {"model": "gpt-5.5", "inputTokens": 20, "outputTokens": 2, "initiator": "agent"}})),
        p7(7000, "permission.completed", json!({"result": {"kind": "approved"}})),
        p7(8000, "session.error", json!({"message": "x"})),
        p7(9000, "session.compaction_complete", json!({"success": true, "systemTokens": 100, "conversationTokens": 200, "toolDefinitionsTokens": 300})),
    ]);
    assert_eq!(v(&r.exec.modes), json!({"byMode": {"interactive": 1}, "inferred": 1}));
    assert_eq!(v(&r.exec.efforts), json!({"medium": {"requests": 2.0, "input": 30.0, "output": 3.0, "nanoAiu": 0.0}}));
    assert_eq!(
        v(&r.exec.model_efforts),
        json!({"claude-haiku-5.5": {"medium": {"requests": 1.0, "input": 10.0, "output": 1.0, "nanoAiu": 0.0}}, "gpt-5.5": {"medium": {"requests": 1.0, "input": 20.0, "output": 2.0, "nanoAiu": 0.0}}})
    );
    assert_eq!(v(&r.exec.initiators), json!({"user": 1, "agent": 1}));
    assert_eq!(v(&r.exec.latency), json!({"claude-haiku-5.5": {"ttft": [701.0], "duration": [1500.0]}}));
    assert_eq!(v(&r.exec.context), json!({"systemTokens": 100.0, "conversationTokens": 200.0, "toolDefinitionsTokens": 300.0, "availableToolCount": 12.0, "source": "compaction"}));
    assert_eq!(v(&r.tools.durations), json!({"view": [250.0]}));
    assert_eq!(
        v(&r.friction_detail),
        json!({"permissions": {"approved": 1}, "errorTypes": {"(unknown)": 1}, "subagentFailures": {}, "compaction": {"recorded": 0, "input": 0.0, "output": 0.0, "nanoAiu": 0.0, "tokensRemoved": 0.0, "removedRecorded": 0}, "agentModelChanges": 0})
    );
    assert_eq!(r.todos, None);

    let u = run(vec![p7(0, "user.message", json!({"content": "a", "agentMode": "plan"})), p7(1000, "session.usage_record", json!({"usage": {"model": "m", "inputTokens": 1, "outputTokens": 1, "toolTokenCount": 5000}}))]);
    assert_eq!(v(&u.exec.context), json!({"systemTokens": null, "conversationTokens": null, "toolDefinitionsTokens": 5000.0, "availableToolCount": null, "source": "usage"}));
    assert_eq!(v(&u.exec.modes), json!({"byMode": {"plan": 1}, "inferred": 0}));
    assert_eq!(v(&u.exec.initiators), json!({"(unknown)": 1}));
    assert_eq!(v(&u.exec.efforts), json!({"(unknown)": {"requests": 1.0, "input": 1.0, "output": 1.0, "nanoAiu": 0.0}}));
}

#[test]
fn lone_surrogates_survive_truncation() {
    // 2000 字目でサロゲートペアが切れると、JS と同じく片割れを \udXXX と書く
    let content = format!("{}😀tail", "a".repeat(1999));
    let r = run(vec![ev("user.message", json!({"content": content}), &t(0))]);
    let json = atlas_core::json::to_js_string(&r.first_user_message).unwrap();
    assert!(json.ends_with("a\\ud83d\""), "{}", &json[json.len() - 20..]);
}
