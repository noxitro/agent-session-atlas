// 失敗の台帳の集計(failure_stats)と、そのページ(failures.html)・JSON。イベントはすべて架空のもの
use atlas_core::js::JsMap;
use atlas_core::normalize::{normalize_session, DbInput, NormalizeInput};
use atlas_core::types::{CopilotEvent, InstructionFile, InstructionInjection, InstructionMethod, InstructionScope, SessionRecord};
use atlas_report::failure_stats::{failure_stats, thresholds as T};
use atlas_report::failures_page::{failures_json, render_failures_html, FailuresPageOptions};
use serde_json::{json, Value};

/// 2026-10-01T00:00:00Z から s 秒後
fn t(s: i64) -> String {
    atlas_core::jsdate::to_iso(1_790_812_800_000 + s * 1000)
}

fn ev(kind: &str, data: Value, s: i64) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(json!(t(s))), parent_id: None, agent_id: None }
}

fn call(id: &str, tool: &str, args: Value, s: i64, extra: Value) -> CopilotEvent {
    let mut d = json!({ "toolCallId": id, "toolName": tool, "arguments": args });
    for (k, v) in extra.as_object().into_iter().flatten() {
        d[k] = v.clone();
    }
    ev("tool.execution_start", d, s)
}

fn ok(id: &str, s: i64) -> CopilotEvent {
    ev("tool.execution_complete", json!({ "toolCallId": id, "success": true }), s)
}

fn fail(id: &str, msg: &str, s: i64) -> CopilotEvent {
    ev("tool.execution_complete", json!({ "toolCallId": id, "success": false, "error": { "code": "failure", "message": msg } }), s)
}

fn normalize(id: &str, events: Vec<CopilotEvent>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: None, db: DbInput::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

/// 同じ文で 3 回失敗して 4 回目に成功、MCP の失敗 1、拒否 1、成功 20。skill を途中で呼ぶ
fn busy(id: &str) -> SessionRecord {
    let mut e = vec![ev("user.message", json!({ "content": "直して" }), 0)];
    let mut s = 1;
    for i in 0..3 {
        e.push(call(&format!("v{i}"), "view", json!({ "path": "a.ts" }), s, json!({})));
        e.push(fail(&format!("v{i}"), &format!("Path 'X:\\synthetic\\a{i}.ts' does not exist"), s + 1));
        s += 2;
    }
    e.push(call("v3", "view", json!({ "path": "a.ts" }), s, json!({})));
    e.push(ok("v3", s + 1));
    s += 2;
    e.push(ev("skill.invoked", json!({ "name": "k1", "trigger": "agent-invoked" }), s));
    s += 1;
    e.push(call("m1", "srv-run", json!({}), s, json!({ "mcpServerName": "srv" })));
    e.push(fail("m1", "Request timed out <b>", s + 1));
    s += 2;
    e.push(call("d1", "edit", json!({ "path": "b.ts" }), s, json!({})));
    e.push(ev("tool.execution_complete", json!({ "toolCallId": "d1", "success": false, "error": { "code": "denied" } }), s + 1));
    s += 2;
    for i in 0..20 {
        e.push(call(&format!("g{i}"), "grep", json!({ "pattern": format!("p{i}") }), s, json!({})));
        e.push(ok(&format!("g{i}"), s + 1));
        s += 2;
    }
    let mut r = normalize(id, e);
    r.instructions = vec![InstructionInjection {
        file: InstructionFile::AgentsMd,
        scope: InstructionScope::Repo,
        method: InstructionMethod::HeadingKeyword,
        chars: 100,
        first_seen_at: Some(t(0)),
        heading: "# 合成の指示".into(),
        content_hash: "abcdef012345".into(),
        injections: 1,
        source_path: None,
    }];
    r
}

#[test]
fn stats_by_unit() {
    let a = busy("00000000-0000-4000-8000-0000000000a1");
    // 台帳の無い古い記録(失敗 5 件)と、空のセッション
    let mut old = busy("00000000-0000-4000-8000-0000000000a2");
    old.analysis.failures = None;
    old.analysis.failures_dropped = None;
    let empty = normalize("00000000-0000-4000-8000-0000000000a3", vec![]);
    assert!(empty.empty);
    let st = failure_stats(&[&a, &old, &empty]);

    // 対象: 台帳なしは別に数え、失敗 0 件とは扱わない(分母にも入れない)
    let c = &st.coverage;
    assert_eq!((c.sessions, c.with_ledger, c.without_ledger, c.without_ledger_failures), (2, 1, 1, 5));
    assert_eq!((c.completed, c.failures, c.denied, c.rows, c.dropped), (26, 4, 1, 5, 0));

    // ツール: 回数は結果から。結果のある呼び出しが MIN_CALLS 未満なら率は出さない
    let view = st.tools.iter().find(|u| u.key == "view").unwrap();
    assert_eq!((view.completed, view.failures, view.denied, view.rate, view.sessions), (4, 3, 0, None, 1));
    assert_eq!(view.causes.iter().map(|c| (c.key.as_str(), c.n)).collect::<Vec<_>>(), [("not_found", 3)]);
    // 同じ引数で呼び直した 3 回のうち、成功は最後の 1 回
    assert_eq!((view.retries, view.retries_ok), (3, 1));
    assert!(st.tools.iter().all(|u| u.key != "grep"), "失敗の無いツールは載せない");
    assert_eq!(st.tools_total, 3);
    assert!(T::MIN_CALLS > 4);

    // MCP サーバー
    assert_eq!(st.mcp.iter().map(|u| (u.key.as_str(), u.completed, u.failures)).collect::<Vec<_>>(), [("srv", 1, 1)]);

    // 繰り返している失敗: パスの違う同じ文は 1 つのまとまり。MIN_REPEAT 未満のものは挙げない
    assert_eq!(st.groups.len(), 1);
    let g = &st.groups[0];
    assert_eq!((g.n, g.sessions, g.denied, g.retries, g.retries_ok), (3, 1, 0, 3, 1));
    assert_eq!(g.example_sessions, ["00000000-0000-4000-8000-0000000000a1"]);
    assert!(g.example.contains("a0.ts"));

    // エージェント: 本体だけ
    assert_eq!(st.agents.iter().map(|x| (x.main, x.runs, x.failures, x.denied)).collect::<Vec<_>>(), [(true, None, 4, 1)]);

    // skill: セッションの単位。最初に呼んだ後の行は MCP の失敗と拒否の 2 行
    let k = &st.skills[0];
    assert_eq!((k.key.as_str(), k.sessions, k.failed, k.rows_after, k.rate, k.other_sessions), ("k1", 1, 5, Some(2), None, 0));
    // 指示文の版: 読み込んだセッションの単位
    let i = &st.instructions[0];
    assert_eq!((i.key.as_str(), i.sessions, i.completed, i.failed, i.rows_after), ("abcdef012345", 1, 26, 5, None));

    // 失敗の後
    let n = &st.next;
    assert_eq!((n.rows, n.retries, n.retries_ok, n.moved_on, n.moved_on_ok, n.user, n.end), (5, 3, 1, 2, 1, 0, 0));
}

#[test]
fn rates_need_enough_calls_and_sessions() {
    // 同じ形のセッションを MIN_SESSIONS 件: 結果のある呼び出しは 26 × 件数
    let recs: Vec<SessionRecord> = (0..T::MIN_SESSIONS).map(|i| busy(&format!("00000000-0000-4000-8000-0000000000b{i}"))).collect();
    let refs: Vec<&SessionRecord> = recs.iter().collect();
    let st = failure_stats(&refs);
    let n = T::MIN_SESSIONS;
    let view = st.tools.iter().find(|u| u.key == "view").unwrap();
    assert_eq!(view.completed, 4 * n);
    assert_eq!(view.rate, (4 * n >= T::MIN_CALLS).then(|| 3.0 / 4.0));
    // skill は全セッションで呼んでいるので、呼ばなかった側は 0 件で率を出さない
    let k = &st.skills[0];
    assert_eq!((k.sessions, k.other_sessions, k.other_rate), (n, 0, None));
    // 比べる相手の率が出せないので、呼んだ側の率も出さない
    assert_eq!(k.rate, None);
    assert_eq!(st.groups[0].sessions, n);
    assert_eq!(st.groups[0].example_sessions.len(), T::EXAMPLE_SESSIONS.min(n as usize));
}

#[test]
fn session_units_compare_with_the_rest() {
    // skill を呼んだセッションと、呼ばなかった(成功だけの)セッションが MIN_SESSIONS 件ずつ
    let n = T::MIN_SESSIONS;
    let with: Vec<SessionRecord> = (0..n).map(|i| busy(&format!("00000000-0000-4000-8000-0000000000c{i}"))).collect();
    let without: Vec<SessionRecord> = (0..n)
        .map(|i| {
            let mut e = vec![ev("user.message", json!({ "content": "見て" }), 0)];
            for j in 0..20 {
                e.push(call(&format!("g{j}"), "grep", json!({ "pattern": format!("p{j}") }), 1 + j * 2, json!({})));
                e.push(ok(&format!("g{j}"), 2 + j * 2));
            }
            normalize(&format!("00000000-0000-4000-8000-0000000000d{i}"), e)
        })
        .collect();
    let refs: Vec<&SessionRecord> = with.iter().chain(without.iter()).collect();
    let st = failure_stats(&refs);
    let k = &st.skills[0];
    assert_eq!((k.sessions, k.other_sessions, k.completed, k.failed), (n, n, 26 * n, 5 * n));
    assert_eq!((k.rate, k.other_rate), (Some(5.0 / 26.0), Some(0.0)));
}

fn page(recs: &[&SessionRecord]) -> String {
    let st = failure_stats(recs);
    render_failures_html(&FailuresPageOptions { css: "", generated_at: &t(0), code: "c0de", stats: &st, meta: &JsMap::new(), session_name: &|id: &str| format!("名前 {}", &id[id.len() - 2..]), library_href: Some("instructions.html") })
}

#[test]
fn page_sections_links_and_escaping() {
    let a = busy("00000000-0000-4000-8000-0000000000a1");
    let html = page(&[&a]);
    for id in ["f-overview", "f-groups", "f-tools", "f-mcp", "f-agents", "f-skills", "f-instructions", "f-next"] {
        assert!(html.contains(&format!("<section class=\"section ins\" id=\"{id}\"")), "{id}");
    }
    assert!(html.contains("<h1>失敗の台帳の集計</h1>"));
    // まとまりの例から詳細ページへ。指示文の版は閲覧ページへ
    assert!(html.contains("<a href=\"sessions/00000000-0000-4000-8000-0000000000a1.html\">名前 a1</a>"));
    assert!(html.contains("<a href=\"instructions.html#v-abcdef012345\">"));
    assert!(html.contains("href=\"atlas.html\""));
    // 率を出せないものは「—」。エラー文は HTML として解釈されない
    assert!(html.contains("<td class=\"num\"><span class=\"missing-value\">—</span></td>"));
    assert!(!html.contains("<b>"));
    assert!(!html.contains("<script src") && !html.contains("http://") && !html.contains("https://"));
}

#[test]
fn page_without_ledger_says_so() {
    let mut old = busy("00000000-0000-4000-8000-0000000000a2");
    old.analysis.failures = None;
    let html = page(&[&old]);
    assert!(html.contains("失敗の台帳のあるセッションがありません"));
    assert!(html.contains("失敗・拒否 5 件の中身は、この集計に入っていません"));
    assert!(!html.contains("id=\"f-tools\""));
}

#[test]
fn json_has_thresholds_and_stats() {
    let a = busy("00000000-0000-4000-8000-0000000000a1");
    let st = failure_stats(&[&a]);
    let v: Value = serde_json::to_value(failures_json(&st, &t(0))).unwrap();
    assert_eq!(v["version"], json!(1));
    assert_eq!(v["thresholds"], json!({ "minCalls": T::MIN_CALLS, "minSessions": T::MIN_SESSIONS, "minRepeat": T::MIN_REPEAT, "topRows": T::TOP_ROWS, "maxRowsPerSession": 500 }));
    assert_eq!(v["coverage"]["withLedger"], json!(1));
    assert_eq!(v["tools"][0]["key"], json!("view"));
    assert_eq!(v["groups"][0]["exampleSessions"][0], json!("00000000-0000-4000-8000-0000000000a1"));
    assert_eq!(v["next"]["retriesOk"], json!(1));
    // skill には呼んだ後の行があり、指示文の版には無い
    assert!(v["skills"][0].get("rowsAfter").is_some() && v["instructions"][0].get("rowsAfter").is_none());
}
