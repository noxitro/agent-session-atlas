//! packages/core/test/metrics.test.ts と turns.test.ts(工程・依頼の種類の規則、ターンごとの集計、CSV)の移植

use super::*;
use crate::jsdate;
use crate::normalize::{normalize_session, DbInput, NormalizeInput};
use crate::tables::{sessions_csv, turns_csv};
use crate::turns::{command_kind, phase_of, request_kind_of, session_turns, tool_kind, CommandKind};
use crate::types::{CopilotEvent, WorkspaceInfo};
use serde_json::{json, Value};

fn normalize(id: &str, workspace: Option<&WorkspaceInfo>, events: Vec<CopilotEvent>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace, db: DbInput::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

const T0: &str = "2026-11-06T00:00:00.000Z";

fn ev_x(dt: i64, kind: &str, data: Value, id: Option<&str>, parent: Option<&str>) -> CopilotEvent {
    let t0 = jsdate::parse_ms(T0).unwrap();
    CopilotEvent {
        kind: kind.into(),
        data: Some(data),
        timestamp: Some(Value::String(jsdate::to_iso(t0 + dt))),
        id: id.map(|x| Value::String(x.into())),
        parent_id: parent.map(|x| Value::String(x.into())),
        agent_id: None,
    }
}

fn ev(dt: i64, kind: &str, data: Value) -> CopilotEvent {
    ev_x(dt, kind, data, None, None)
}

fn tool(dt: i64, id: &str, name: &str, args: Value) -> CopilotEvent {
    ev(dt, "tool.execution_start", json!({ "toolCallId": id, "toolName": name, "arguments": args }))
}

fn done(dt: i64, id: &str, success: bool, code: Option<&str>) -> CopilotEvent {
    let mut d = json!({ "toolCallId": id, "success": success });
    if let Some(c) = code {
        d["error"] = json!({ "code": c });
    }
    ev(dt, "tool.execution_complete", d)
}

fn kinds(pairs: &[(&str, i64)]) -> JsMap<i64> {
    JsMap(pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect())
}

#[test]
fn tool_kinds_and_shell_commands() {
    let sh = |c: &str| json!({ "command": c });
    assert_eq!(tool_kind("powershell", Some(&sh("npm run typecheck 2>&1 | Select-Object -Last 5"))), Some("verify"));
    assert_eq!(tool_kind("bash", Some(&sh("npx vitest run"))), Some("verify"));
    assert_eq!(tool_kind("powershell", Some(&sh("git commit -m \"x\""))), Some("git"));
    assert_eq!(tool_kind("powershell", Some(&sh("git status --short"))), Some("read"));
    assert_eq!(tool_kind("powershell", Some(&sh("node scripts/x.mjs"))), Some("shell"));
    assert_eq!(tool_kind("apply_patch", Some(&json!("patch"))), Some("edit"));
    assert_eq!(tool_kind("rg", Some(&json!({}))), Some("read"));
    assert_eq!(tool_kind("sql", None), Some("plan"));
    assert_eq!(tool_kind("web_fetch", None), Some("web"));
    assert_eq!(tool_kind("task", None), Some("delegate"));
    assert_eq!(tool_kind("read_powershell", None), None);
    assert_eq!(tool_kind("task_complete", None), None);
    assert_eq!(tool_kind("something_new", None), Some("other"));

    use CommandKind::*;
    for (cmd, want) in [
        ("cd E:\\dev\\x; cmake --build build --config Debug", Verify),
        (".\\build\\Debug\\game.exe --smoke", Verify),
        ("Set-Location X:\\p; git --no-pager diff --stat", Read),
        ("git -C repo status --short && git log -1", Read),
        ("git worktree list; git branch --list; git status", Read),
        ("git commit -m \"make the build pass; deploy\"", Git),
        ("cat docs/deploy.md", Read),
        ("gh pr view 12 --json state", Read),
        ("gh pr create --fill", Git),
        ("git status; npm test", Verify),
        ("node scripts/x.mjs | Select-Object -Last 5", Shell),
        ("$env:CI = 1; npx vitest run", Verify),
        ("& \"E:\\dev\\out\\build\\Debug\\runtime.exe\" --headless", Verify),
        ("cmd /c \"call vcvars64.bat && cmake --build build\"", Verify),
        ("$vswhere = \"C:\\vswhere.exe\"; $ErrorActionPreference = \"Stop\"; Get-ChildItem src", Read),
        ("# 確認\nGet-Content a.txt", Read),
        ("git commit -m \"fix; npm test\"", Git),
        ("git commit -m 'a && npm test'", Git),
        ("git commit -m \"first\nnpm test\"", Git),
        ("git commit -m \"say \\\"x; npm test\\\"\"", Git),
        ("echo don't; npm test", Verify),
    ] {
        assert_eq!(command_kind(cmd), want, "{cmd}");
    }
}

#[test]
fn phases() {
    assert_eq!(phase_of(&kinds(&[])), "answer");
    assert_eq!(phase_of(&kinds(&[("read", 3), ("edit", 1), ("verify", 2)])), "implement");
    assert_eq!(phase_of(&kinds(&[("read", 3), ("verify", 1), ("git", 1)])), "verify");
    assert_eq!(phase_of(&kinds(&[("read", 1), ("git", 2)])), "ops");
    assert_eq!(phase_of(&kinds(&[("plan", 2)])), "plan");
    assert_eq!(phase_of(&kinds(&[("plan", 1), ("read", 1)])), "research");
    assert_eq!(phase_of(&kinds(&[("web", 2), ("shell", 1)])), "research");
}

#[test]
fn request_kinds() {
    for (text, want) in [
        ("進めて", "continue"),
        ("C", "continue"),
        ("OK", "continue"),
        ("はい。", "continue"),
        ("さっきの変更を元に戻して", "revert"),
        ("Revert that", "revert"),
        ("そうじゃなくて、ボタンは右に置いて", "fix"),
        ("CI が失敗してる？", "fix"),
        // 原因を尋ねるだけなら質問、直しを頼んでいれば修正
        ("なぜ動かないの？", "question"),
        ("エラーが出ます。原因は何ですか？", "question"),
        ("なぜ動かないの？直して", "fix"),
        ("動かない。なぜ？直してもらえますか？", "fix"),
        ("グループを保存する機能はある？", "question"),
        ("なぜ 2 回呼ばれるのか教えて", "question"),
        ("設定画面を作って", "task"),
        ("", "task"),
        // 問いは最後の文で見る。「〜してもらえますか」は依頼、「X ではなく Y」だけでは修正にしない
        ("下記アドバイスに基づいて設定してもらえますか？", "task"),
        ("テーマ設定は適用されていますか？ また、手順を README に追記して", "task"),
        ("白飛びしています。テーマ設定は適用されていますか？", "question"),
        ("grep ではなく LSP を使って、次を調べて", "task"),
        // 閉じ括弧・空白は最後の文の末尾から外す
        ("これで合っている？）", "question"),
        // JS の /i(u なし)は ASCII だけを畳む: K(ケルビン記号)は k ではない
        ("\u{212a}", "task"),
    ] {
        assert_eq!(request_kind_of(text), want, "{text}");
    }
}

#[test]
fn turn_stats_metrics_and_csv() {
    let r = normalize(
        "s",
        None,
        vec![
            ev(0, "session.start", json!({ "context": { "cwd": "X:\\p" } })),
            // ターン 1: 調べて編集し、テストが 2 回続けて失敗。同じファイルをもう一度編集
            ev(1000, "user.message", json!({ "content": "ボタンを足して" })),
            tool(1100, "r1", "report_intent", json!({})),
            done(1150, "r1", true, None),
            tool(1200, "v1", "view", json!({ "path": "a.ts" })),
            done(1300, "v1", true, None),
            tool(1400, "e1", "edit", json!({ "path": "X:\\p\\a.ts" })),
            done(1500, "e1", true, None),
            tool(1600, "t1", "powershell", json!({ "command": "npm test" })),
            done(1700, "t1", false, None),
            tool(1800, "t2", "powershell", json!({ "command": "npm test" })),
            done(1900, "t2", false, None),
            tool(2000, "e2", "edit", json!({ "path": "X:\\p\\a.ts" })),
            done(2100, "e2", true, None),
            ev(2200, "session.compaction_complete", json!({ "success": true })),
            // ターン 2: 修正の依頼。git push を拒否、中断、利用上限のエラー
            ev(5000, "user.message", json!({ "content": "違う、右に置いて" })),
            tool(5100, "g1", "powershell", json!({ "command": "git push" })),
            done(5200, "g1", false, Some("denied")),
            ev_x(5300, "abort", json!({ "reason": "user" }), Some("a1"), None),
            ev_x(5301, "abort", json!({ "reason": "user" }), Some("a2"), Some("a1")),
            ev(5400, "session.error", json!({ "errorType": "quota", "message": "x" })),
            // ターン 3: ツールなしで答えた
            ev(9000, "user.message", json!({ "content": "これで終わり？" })),
            ev(9100, "assistant.message", json!({ "content": "はい" })),
            ev(1500, "session.usage_record", json!({ "usage": { "model": "gpt-5", "inputTokens": 100, "outputTokens": 10, "copilotUsage": { "totalNanoAiu": 2e9 } } })),
            ev(5150, "session.usage_record", json!({ "usage": { "model": "gpt-5", "inputTokens": 50, "outputTokens": 5 } })),
        ],
    );
    let ts = r.analysis.turn_stats.as_ref().unwrap();
    assert_eq!(ts.len(), 3);
    let t0 = &ts[0];
    assert_eq!((t0.tools, t0.tool_failures, t0.denied, t0.max_consecutive_failures, t0.edits, t0.re_edits, t0.repeat_edits, t0.compactions), (5, 2, 0, 2, 2, 0, Some(1), 1));
    assert_eq!(t0.kinds, kinds(&[("read", 1), ("edit", 2), ("verify", 2)]));
    assert_eq!((t0.input, t0.output, t0.nano_aiu), (Some(100.0), Some(10.0), Some(2e9)));
    let t1 = &ts[1];
    assert_eq!((t1.tools, t1.denied, t1.aborts, t1.errors, t1.external_errors, t1.edits), (1, 1, 1, 1, 1, 0));
    assert_eq!((t1.input, t1.output), (Some(50.0), Some(5.0)));
    assert_eq!((ts[2].tools, ts[2].input), (0, None));

    let rows = session_turns(&r);
    let got: Vec<(&str, &str, Option<&str>)> = rows.iter().map(|t| (t.phase, t.kind, t.next_kind)).collect();
    assert_eq!(got, vec![("implement", "task", Some("fix")), ("ops", "fix", Some("question")), ("answer", "question", None)]);

    let m = compute_metrics(&[&r], None);
    let tm = m.turns.as_ref().unwrap();
    assert_eq!((tm.turns, tm.sessions, tm.sessions_without_turns, tm.truncated_sessions), (3, 1, 0, 0));
    let imp = &tm.by_phase["implement"];
    assert_eq!((imp.turns, imp.stuck, imp.tool_failures, imp.re_edits, imp.followed_by_fix, imp.with_next, imp.kinds["task"]), (1, 1, 2, 0, 1, 1, 1));
    let ans = &tm.by_phase["answer"];
    assert_eq!((ans.turns, ans.stuck, ans.with_next), (1, 0, 0));
    let fix = &tm.by_kind["fix"];
    assert_eq!((fix.turns, fix.denied, fix.aborts), (1, 1, 1));
    // 工程・種類の並びは定義の順
    assert_eq!(tm.by_phase.keys().map(String::as_str).collect::<Vec<_>>(), crate::turns::PHASES);

    // CSV: BOM 付き・CRLF、1 ターン 1 行
    let csv = turns_csv(&[&r], None);
    assert!(csv.starts_with("\u{feff}セッションID,"));
    let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
    assert_eq!(lines.len(), 4);
    assert!(lines[1].contains(",1,"));
    assert!(lines[1].contains("作業,実装,修正,1,1,"));
    assert!(lines[3].ends_with(",これで終わり？"));
    let hh: HashMap<String, f64> = [("s".to_string(), 2.5)].into_iter().collect();
    let scsv = sessions_csv(&[&r], &hh, None, None);
    let slines: Vec<&str> = scsv.trim_end().split("\r\n").collect();
    assert_eq!(slines.len(), 2);
    assert!(slines[1].contains(",2.5,"));
}

#[test]
fn re_edits_across_turns() {
    let r = normalize(
        "s",
        None,
        vec![
            ev(0, "user.message", json!({ "content": "作って" })),
            tool(100, "a", "edit", json!({ "path": "X:\\p\\a.ts" })),
            tool(200, "b", "edit", json!({ "path": "X:\\p\\a.ts" })),
            ev(1000, "user.message", json!({ "content": "右に寄せて" })),
            tool(1100, "c", "edit", json!({ "path": "X:\\p\\a.ts" })),
            tool(1200, "d", "create", json!({ "path": "X:\\p\\b.ts" })),
        ],
    );
    let got: Vec<(i64, i64, Option<i64>)> = r.analysis.turn_stats.as_ref().unwrap().iter().map(|t| (t.edits, t.re_edits, t.repeat_edits)).collect();
    assert_eq!(got, vec![(2, 0, Some(1)), (2, 1, Some(0))]);
    assert_eq!(session_turns(&r).iter().map(|t| t.kind).collect::<Vec<_>>(), vec!["task", "task"]);
}

#[test]
fn turns_after_200_are_not_analyzed() {
    let mut events: Vec<CopilotEvent> = (0..201).map(|i| ev(i * 1000, "user.message", json!({ "content": format!("q{i}") }))).collect();
    events.push(ev(200_500, "session.usage_record", json!({ "usage": { "model": "gpt-5", "inputTokens": 9, "outputTokens": 9 } })));
    let r = normalize("s", None, events);
    let ts = r.analysis.turn_stats.as_ref().unwrap();
    assert_eq!(ts.len(), 200);
    assert_eq!(ts.last().unwrap().input, None);
    let tm = compute_metrics(&[&r], None).turns.unwrap();
    assert_eq!((tm.turns, tm.truncated_sessions), (200, 1));
}

#[test]
fn metrics_by_project_client_month_model() {
    let wa = WorkspaceInfo { client_name: Some("github/cli".into()), repository: Some("o/a".into()), created_at: Some("2026-09-30T23:00:00Z".into()), ..Default::default() };
    let a = normalize(
        "a",
        Some(&wa),
        vec![
            CopilotEvent { kind: "tool.execution_start".into(), data: Some(json!({ "toolName": "view" })), timestamp: Some(json!("2026-09-30T23:00:00Z")), ..Default::default() },
            CopilotEvent {
                kind: "session.usage_record".into(),
                data: Some(json!({ "usage": { "model": "m1", "inputTokens": 10, "outputTokens": 1, "cost": 1, "initiator": "user" } })),
                timestamp: Some(json!("2026-09-30T23:00:01Z")),
                ..Default::default()
            },
        ],
    );
    let wb = WorkspaceInfo { client_name: Some("github/autopilot".into()), repository: Some("o/a".into()), created_at: Some("2026-10-01T01:00:00Z".into()), ..Default::default() };
    let b = normalize(
        "b",
        Some(&wb),
        vec![CopilotEvent { kind: "assistant.message".into(), data: Some(json!({ "model": "m2", "outputTokens": 3 })), timestamp: Some(json!("2026-10-01T01:00:00Z")), ..Default::default() }],
    );
    let m = compute_metrics(&[&a, &b], None);
    assert_eq!(m.overall.sessions, 2);
    assert_eq!(m.overall.sessions_with_input_tokens, 1);
    assert_eq!((m.overall.tokens.input, m.overall.tokens.output, m.overall.tokens.premium_requests), (10.0, 4.0, 1.0));
    let tools = crate::json::to_js_string(&m.overall.tools).unwrap();
    assert_eq!(tools, r#"{"total":1,"byName":{"view":1},"internal":0,"mcp":{},"results":{}}"#);
    assert_eq!(m.by_project.keys().collect::<Vec<_>>(), ["o/a"]);
    assert_eq!(m.by_client.keys().collect::<Vec<_>>(), ["github/autopilot", "github/cli"]);
    assert_eq!(m.by_month.keys().collect::<Vec<_>>(), ["2026-09", "2026-10"]);
    assert_eq!((m.by_model["m1"].sessions, m.by_model["m1"].input, m.by_model["m1"].output), (1, 10.0, 1.0));
    assert_eq!((m.by_model["m2"].sessions, m.by_model["m2"].input, m.by_model["m2"].output), (1, 0.0, 3.0));
    // 集計のバケツは JSON のキーの順も TS 版と同じ(removedRecorded は 0 から足して必ず書く)
    let j = crate::json::to_js_string(&m.overall.friction_detail.compaction).unwrap();
    assert_eq!(j, r#"{"recorded":0,"input":0,"output":0,"nanoAiu":0,"tokensRemoved":0,"removedRecorded":0}"#);
}

#[test]
fn distributions() {
    let d = distribution(&[]);
    assert_eq!((d.total, d.median, d.p90), (0.0, None, None));
    let d = distribution(&[5.0, 1.0, 3.0, 2.0, 4.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
    assert_eq!((d.total, d.median, d.p90), (55.0, Some(5.0), Some(9.0)));
}

#[test]
fn month_keys() {
    let mut r = normalize("x", None, vec![]);
    r.created_at = None;
    r.updated_at = Some("2026-01-31T23:59:59Z".into());
    assert_eq!(month_key(&r), "2026-01");
    r.created_at = Some(String::new());
    assert_eq!(month_key(&r), "(unknown)");
    r.created_at = Some("not a date".into());
    assert_eq!(month_key(&r), "(unknown)");
}

#[test]
fn installed_skills() {
    let inv = InstalledInventory {
        skills: vec!["b".into(), "A".into()],
        plugins: vec![crate::types::InstalledPlugin { marketplace: "m".into(), name: "p".into(), skills: vec!["a".into(), "b".into()] }],
        disabled_skills: None,
        warnings: vec![],
    };
    assert_eq!(installed_skill_names(&inv), ["A", "a", "b"]);
    let mut s = normalize("x", None, vec![]);
    s.skills = vec![crate::types::SkillUse { name: "B".into(), at: None, via: crate::types::SkillVia::Tool, trigger: None, chars: None }];
    assert_eq!(unused_installed_skills(&inv, &[&s]), ["A", "a"]);
}
