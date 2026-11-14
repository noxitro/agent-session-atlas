// ページの描画の振る舞い(packages/report/test/{detail-fixes,phase11,transcript,code-embed}.test.ts の描画の部分を移したもの)。
// 値は架空のもの。秘密情報の形は実行時に組み立てる(ソースに直書きしない)

use atlas_core::instructions::content_hash;
use atlas_core::normalize::{normalize_session, DbInput, NormalizeInput};
use atlas_core::types::{CopilotEvent, DbUsageRow, SessionRecord, WorkspaceInfo};
use atlas_core::wiki::{WikiClassifier, WikiSpec};
use atlas_report::anonymize::{create_anonymizer, identity_anonymizer, AnonSource};
use atlas_report::build::embed_code_stamp;
use atlas_report::coverage::{coverage_file, desktop_coverage, rule_for, CoverageCounter, Treatment};
use atlas_report::detail::{merge_instruction_rows, render_detail_html, DetailOptions};
use atlas_report::full::{full_tail, looks_opaque, render_full_body, FullOptions};
use atlas_report::library::{line_diff, render_instructions_html, skill_anchor, write_library, InstructionsPageOptions, LibraryCollector, LibraryKind, ResolvedInstruction};
use atlas_report::raw_events::{read_raw_events, RawEvent};
use atlas_report::transcript::{redact_secrets, rel, render_transcript, summarize_args, transcript_file_name, ToolOutputMode, TranscriptOptions, TranscriptSource};
use regex::Regex;
use serde_json::{json, Value};

/// 2026-10-01T00:00:00Z から s 秒後
fn t(s: i64) -> String {
    atlas_core::jsdate::to_iso(1_790_812_800_000 + s * 1000)
}

fn ev(kind: &str, data: Value, ts: &str, extra: Value) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: extra.get("id").cloned(), timestamp: Some(json!(ts)), parent_id: None, agent_id: extra.get("agentId").cloned() }
}

fn normalize(id: &str, events: Vec<CopilotEvent>, workspace: Option<WorkspaceInfo>, usage: &[DbUsageRow], wiki: Option<&WikiClassifier>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput {
        id: id.into(),
        has_dir: None,
        workspace: workspace.as_ref(),
        db: DbInput { usage, ..DbInput::default() },
        events: Some(&mut it),
        wiki_classifier: wiki,
    })
    .unwrap()
}

fn html(r: &SessionRecord) -> String {
    let anon = identity_anonymizer();
    render_detail_html(
        r,
        &DetailOptions {
            anon: &anon,
            css: "",
            code: "c0de",
            judgment: None,
            verdicts: None,
            generated_at: &t(0),
            transcript_href: None,
            library_href: None,
            skill_has_page: &|_| true,
            library_has_session: true,
            full_href: None,
            memo: None,
            retention: None,
            retention_meta: None,
        },
    )
}

/// 概要などの 1 項目(見出し・値・注記)をタグを外した文字列で取り出す
fn field_of(page: &str, key: &str) -> Option<(String, String)> {
    let re = Regex::new(&format!(r#"<div class="field"><span class="k">{}</span><span class="v">((?s:.)*?)</span>(?:<span class="n">((?s:.)*?)</span>)?</div>"#, regex::escape(key))).unwrap();
    let tags = Regex::new("<[^>]+>").unwrap();
    let m = re.captures(page)?;
    let strip = |s: Option<regex::Match>| tags.replace_all(s.map_or("", |x| x.as_str()), "").into_owned();
    Some((strip(m.get(1)), strip(m.get(2))))
}

fn pair(v: &str, n: &str) -> Option<(String, String)> {
    Some((v.into(), n.into()))
}

// ---------- detail-fixes.test.ts ----------

#[test]
fn detail_missing_vs_zero() {
    // (1) compaction のトークンは古い形も出し、減ったトークンが無ければ記録なし
    let r = normalize("c", vec![ev("session.compaction_complete", json!({ "compactionTokensUsed": { "input": 2000, "output": 300, "cachedInput": 1500 } }), &t(1), json!({}))], None, &[], None);
    assert_eq!(field_of(&html(&r), "compaction 自体のトークン"), pair("入力 2,000・出力 300", "減ったトークン 記録なし"));

    // (2) サブエージェントだけが編集した変更行数は記録なしと理由
    let r = normalize(
        "l",
        vec![
            ev("session.start", json!({ "context": { "cwd": "C:\\w" } }), &t(0), json!({})),
            ev("tool.execution_start", json!({ "toolName": "create", "toolCallId": "c1", "arguments": { "path": "C:\\w\\a.ts" } }), &t(1), json!({ "agentId": "sub" })),
            ev("tool.execution_complete", json!({ "toolCallId": "c1", "success": true }), &t(2), json!({ "agentId": "sub" })),
            ev("session.shutdown", json!({ "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModified": [] } }), &t(3), json!({})),
        ],
        None,
        &[],
        None,
    );
    assert_eq!(field_of(&html(&r), "変更行数"), pair("記録なし", "サブエージェントの変更は数えられない"));

    // (4)(6) トークンの記録が何も無ければ入力・出力・API リクエストとも記録なし
    let r = normalize("e", vec![ev("user.message", json!({ "content": "a" }), &t(0), json!({}))], None, &[], None);
    let page = html(&r);
    assert_eq!(field_of(&page, "入力トークン").unwrap().0, "記録なし");
    assert_eq!(field_of(&page, "出力トークン").unwrap().0, "記録なし");
    assert_eq!(field_of(&page, "API リクエスト"), pair("記録なし", "リクエスト単位の明細も終了時の累計も無い"));
    assert_eq!(field_of(&page, "premium request").unwrap().0, "記録なし");
    let partial = normalize("p", vec![ev("assistant.message", json!({ "content": "x", "outputTokens": 50, "model": "m" }), &t(1), json!({}))], None, &[], None);
    assert_eq!(field_of(&html(&partial), "入力トークン").unwrap().0, "推計不可");
    assert_eq!(field_of(&html(&partial), "出力トークン").unwrap().0, "50");

    // (4)(7) 終了時の累計だけのセッション
    let r = normalize(
        "s",
        vec![ev(
            "session.shutdown",
            json!({ "totalPremiumRequests": 82.5, "modelMetrics": { "m1": { "requests": { "count": 1962, "cost": 82.5 }, "usage": { "inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": 0 } } } }),
            &t(1),
            json!({}),
        )],
        None,
        &[],
        None,
    );
    let page = html(&r);
    assert_eq!(field_of(&page, "API リクエスト"), pair("1,962", "終了時の累計(shutdown)の件数"));
    assert_eq!(field_of(&page, "premium request"), pair("82.5", "終了時の累計(shutdown)"));

    // (5) system・会話が 0 の空の終了記録では、ツール定義の割合は出せないと書く
    let mut r = normalize("x", vec![ev("session.shutdown", json!({ "systemTokens": 0, "conversationTokens": 0, "toolDefinitionsTokens": 19837 }), &t(1), json!({}))], None, &[], None);
    let f = field_of(&html(&r), "ツール定義のトークン").unwrap();
    assert_eq!(f.0, "19,837");
    assert!(f.1.contains("文脈に占める割合は出せない") && !f.1.contains("100%"), "{}", f.1);
    r.exec.context.system_tokens = Some(0.0);
    r.exec.context.conversation_tokens = Some(0.0);
    assert!(!field_of(&html(&r), "ツール定義のトークン").unwrap().1.contains("100%"));
}

#[test]
fn detail_merges_duplicate_rows() {
    // (8) 同じ内容の指示文は 1 行にまとめ、ソースのパスのある行を残す
    let row = |file: &str, method: &str, chars: i64, hash: &str, source: Option<&str>, first: &str| -> atlas_core::types::InstructionInjection {
        serde_json::from_value(json!({ "file": file, "scope": "repo", "method": method, "chars": chars, "firstSeenAt": first, "heading": "# AGENTS", "contentHash": hash, "injections": 2, "sourcePath": source })).unwrap()
    };
    let merged = merge_instruction_rows(&[
        row("unknown", "learned-heading", 11405, "h1", None, "2026-10-01T00:00:02Z"),
        row("AGENTS.md", "imported-source", 11404, "h1", Some("C:\\w\\AGENTS.md"), "2026-10-01T00:00:01Z"),
        row("CLAUDE.md", "import-stub", 12, "h2", None, "2026-10-01T00:00:02Z"),
    ]);
    let got: Vec<(&str, i64, i64, Option<&str>)> = merged.iter().map(|i| (i.file.as_str(), i.chars, i.injections, i.first_seen_at.as_deref())).collect();
    assert_eq!(got, vec![("AGENTS.md", 11404, 4, Some("2026-10-01T00:00:01Z")), ("CLAUDE.md", 12, 2, Some("2026-10-01T00:00:02Z"))]);

    // (10) 同じ wiki ページを何度読んでも 1 行にまとめ ×N を添える
    let wiki = WikiClassifier::new(&[WikiSpec { path: "my-wiki".into(), pages: Some(vec!["wiki".into()]), ..Default::default() }]);
    let r = normalize(
        "w",
        vec![
            ev("tool.execution_start", json!({ "toolName": "view", "toolCallId": "v1", "arguments": { "path": "E:\\v\\my-wiki\\wiki\\a.md" } }), &t(1), json!({})),
            ev("tool.execution_start", json!({ "toolName": "view", "toolCallId": "v2", "arguments": { "path": "E:\\v\\my-wiki\\wiki\\a.md" } }), &t(2), json!({})),
            ev("tool.execution_start", json!({ "toolName": "view", "toolCallId": "v3", "arguments": { "path": "E:\\v\\my-wiki\\wiki\\b.md" } }), &t(3), json!({})),
        ],
        None,
        &[],
        Some(&wiki),
    );
    let page = html(&r);
    assert_eq!(page.matches("<li>wiki/a.md").count(), 1);
    assert!(page.contains("<li>wiki/a.md <span class=\"tag\">×2</span></li>"));
    assert_eq!(field_of(&page, "個別ページ"), pair("3", "2 ページ"));

    // (11) 同じ理由で失敗したサブエージェントは ×N でまとめ、結果の無いツール呼び出しは「結果なし」に数える
    let mut events = Vec::new();
    for i in 0..3 {
        events.push(ev("subagent.started", json!({ "agentName": "implementer", "toolCallId": format!("a{i}") }), &t(i), json!({})));
        events.push(ev("subagent.failed", json!({ "agentName": "implementer", "toolCallId": format!("a{i}"), "error": "402 You have exceeded your monthly quota" }), &t(i), json!({})));
    }
    events.push(ev("tool.execution_start", json!({ "toolName": "task", "toolCallId": "t1" }), &t(10), json!({})));
    events.push(ev("tool.execution_complete", json!({ "toolCallId": "t1", "success": true }), &t(11), json!({})));
    events.push(ev("tool.execution_start", json!({ "toolName": "task", "toolCallId": "t2" }), &t(12), json!({})));
    let page = html(&normalize("f", events, None, &[], None));
    assert_eq!(page.matches("402 You have exceeded your monthly quota").count(), 1);
    assert!(page.contains("×3</span></li>"));
    assert!(page.contains("<th scope=\"col\" class=\"num\">結果なし</th>"));
    assert!(page.contains("<th scope=\"row\">task</th><td class=\"num\">2</td><td class=\"num\">1</td><td class=\"num\">0</td><td class=\"num\">0</td><td class=\"num\">1</td>"));
    let ok = normalize(
        "ok",
        vec![ev("tool.execution_start", json!({ "toolName": "view", "toolCallId": "v1" }), &t(1), json!({})), ev("tool.execution_complete", json!({ "toolCallId": "v1", "success": true }), &t(2), json!({}))],
        None,
        &[],
        None,
    );
    assert!(!html(&ok).contains("結果なし"));
}

#[test]
fn detail_timeline() {
    // (12) 本文の空の依頼は「(本文なし)」、最後の行より後の shutdown は「終了(shutdown)」の行
    let r = normalize(
        "t",
        vec![
            ev("user.message", json!({ "content": "" }), &t(0), json!({})),
            ev("tool.execution_start", json!({ "toolName": "view", "toolCallId": "v1" }), &t(1), json!({})),
            ev("session.shutdown", json!({ "shutdownType": "routine" }), "2026-10-12T00:00:00.000Z", json!({})),
        ],
        None,
        &[],
        None,
    );
    let page = html(&r);
    assert!(page.contains("<tr class=\"k-user\"><td class=\"num\">"));
    assert!(Regex::new(r#"<tr class="k-user">(?s:.)*?<span class="missing-value">\(本文なし\)</span>"#).unwrap().is_match(&page));
    assert!(Regex::new(r#"<tr class="k-shutdown">(?s:.)*?<span class="kind">終了\(shutdown\)</span>"#).unwrap().is_match(&page));
    // 外部参照の静的検査に掛からない(http:// と fetch( を本文に出さない)
    assert!(!page.contains("http://") && !page.contains("https://"));
    assert!(page.contains("<meta name=\"atlas-code\" content=\"c0de\">"));
}

// ---------- code-embed.test.ts ----------

#[test]
fn code_stamp_embedding() {
    let tpl = "<meta name=\"atlas-code\" content=\"__ATLAS_CODE__\"><script>__ATLAS_DATA__</script>";
    assert_eq!(embed_code_stamp(tpl, "0123456789abcdef").unwrap(), "<meta name=\"atlas-code\" content=\"0123456789abcdef\"><script>__ATLAS_DATA__</script>");
    assert!(embed_code_stamp(tpl, "$&$'").unwrap().contains("content=\"$&$'\""));
    let e = embed_code_stamp("<script>__ATLAS_DATA__</script>", "x").unwrap_err().to_string();
    assert!(e.contains("版の目印の位置 __ATLAS_CODE__ がありません") && e.contains("packages/report/dist を消してから"), "{e}");
}

// ---------- phase11.test.ts ----------

const T: &str = "2026-10-01T00:00:00.000Z";

fn secret() -> String {
    ["ghp", "FULLFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE02"].join("_")
}
fn opaque() -> String {
    format!("{}{}==", "A".repeat(60), "b".repeat(60))
}
fn long_alnum() -> String {
    "deadbeef0123456789".repeat(8)
}

fn raw(kind: &str, data: Value) -> Value {
    json!({ "type": kind, "data": data, "timestamp": T, "id": format!("id-{kind}"), "parentId": null })
}

fn phase11_events() -> Vec<Value> {
    let (secret, opaque, long) = (secret(), opaque(), long_alnum());
    vec![
        raw("session.start", json!({ "sessionId": "s", "copilotVersion": "1.0.0", "context": { "cwd": "X:\\p" } })),
        raw("system.message", json!({ "role": "system", "content": "<custom_instruction>\n# AGENTS.md\n\nルール 1\n</custom_instruction>" })),
        raw("user.message", json!({ "content": "依頼の本文 UNIQUE-REQUEST-TEXT", "transformedContent": "依頼の本文 UNIQUE-REQUEST-TEXT", "supportedNativeDocumentMimeTypes": ["a", "b"] })),
        raw(
            "assistant.message",
            json!({ "content": "応答の本文", "reasoningText": "考えた内容 UNIQUE-REASONING", "reasoningBlocks": [{ "type": "text", "text": "読める推論" }, { "type": "enc", "data": opaque }], "encryptedContent": opaque, "reasoningOpaque": opaque, "toolRequests": [{ "toolCallId": "c1", "name": "bash", "arguments": { "command": "ls" } }], "outputTokens": 10 }),
        ),
        raw("tool.execution_start", json!({ "toolName": "bash", "toolCallId": "c1", "arguments": { "command": "ls", "hexdump": long } })),
        raw("tool.execution_complete", json!({ "toolCallId": "c1", "success": true, "result": { "content": format!("結果の本文 UNIQUE-RESULT {secret}"), "detailedContent": format!("詳細の本文 UNIQUE-DETAILED {long}") }, "toolTelemetry": { "ms": 5 } })),
        raw("tool.execution_start", json!({ "toolName": "view", "toolCallId": "c2", "arguments": { "path": "x" } })),
        raw("tool.execution_complete", json!({ "toolCallId": "c2", "success": true, "result": { "content": "同じ本文 UNIQUE-SAME", "detailedContent": "同じ本文 UNIQUE-SAME" } })),
        raw("assistant.message", json!({ "content": ["配列の content", { "nested": "UNIQUE-NONSTRING" }], "reasoningText": 42, "toolRequests": [] })),
        raw("hook.start", json!({ "hookType": "postToolUse", "hookInvocationId": "h1", "input": { "sessionId": "s", "toolName": "bash", "toolResult": { "textResultForLlm": format!("結果の本文 UNIQUE-RESULT {secret}"), "resultType": "text" } } })),
        raw("hook.end", json!({ "hookType": "postToolUse", "hookInvocationId": "h1", "success": true })),
        raw("skill.invoked", json!({ "name": "my-skill", "path": "skills/my-skill/SKILL.md", "content": "# my-skill\n\nskill の本文 UNIQUE-SKILL", "trigger": "user-invoked" })),
        raw("session.binary_asset", json!({ "assetId": "asset-1", "type": "image", "mimeType": "image/png", "byteLength": 8, "data": "iVBORw0KGgo=", "description": "画像" })),
        raw("session.compaction_complete", json!({ "success": true, "summaryContent": "要約 UNIQUE-SUMMARY", "checkpointNumber": 1, "checkpointPath": "X:\\cp\\001.md" })),
        raw("session.shutdown", json!({ "shutdownType": "exit", "currentTokens": 1 })),
        raw("brand.new_type", json!({ "mystery": "x" })),
    ]
}

fn to_raw(v: &[Value]) -> Vec<RawEvent> {
    v.iter().map(|x| RawEvent { obj: x.as_object().unwrap().clone() }).collect()
}

fn to_events(v: &[Value]) -> Vec<CopilotEvent> {
    v.iter().map(|x| serde_json::from_value(x.clone()).unwrap()).collect()
}

#[test]
fn coverage_rules_and_file() {
    assert_eq!(rule_for("assistant.message", "encryptedContent").unwrap().treatment, Treatment::Excluded);
    assert_eq!(rule_for("assistant.message", "reasoningBlocks").unwrap().treatment, Treatment::Partial);
    assert_eq!(rule_for("assistant.message", "^id").unwrap().treatment, Treatment::Ref);
    assert_eq!(rule_for("session.start", "anything").unwrap().treatment, Treatment::Full);
    assert!(rule_for("assistant.message", "brandNewKey").is_none());
    assert!(rule_for("brand.new_type", "mystery").is_none());
    for t in atlas_core::event_types::KNOWN_EVENT_TYPES {
        assert!(rule_for(t, "^timestamp").is_some() && (rule_for(t, "*").is_some() || rule_for(t, "content").is_some() || rule_for(t, "turnId").is_some() || rule_for(t, "usage").is_some() || rule_for(t, "hookType").is_some() || rule_for(t, "toolName").is_some() || rule_for(t, "result").is_some() || rule_for(t, "role").is_some() || rule_for(t, "kind").is_some() || rule_for(t, "data").is_some()), "{t}");
    }
    let events = phase11_events();
    let mut c = CoverageCounter::new();
    for e in to_raw(&events) {
        c.add(&e);
    }
    let desktop: atlas_core::desktop::DesktopCoverage = serde_json::from_value(json!({ "tables": { "sessions": { "allowed": ["id"], "unlisted": ["secret_col"], "rows": 1 } }, "forbidden": { "accounts": "token" }, "otherTables": ["other"] })).unwrap();
    let f = coverage_file(&c, 1, Some(desktop_coverage(Some(&desktop))), T);
    assert_eq!(f.events, events.len() as i64);
    let enc = f.keys.iter().find(|k| k.kind == "assistant.message" && k.key == "encryptedContent").unwrap();
    assert_eq!((enc.treatment, enc.n, enc.bytes), (Treatment::Excluded, 1, opaque().len() as i64 + 2));
    assert_eq!(c.unclassified_keys(), ["brand.new_type|mystery"]);
    assert_eq!(f.summary.unclassified.keys, 1);
    let d = f.desktop.unwrap();
    assert_eq!(d.unclassified, 1);
    assert!(d.columns.iter().any(|x| x.table == "accounts" && x.column == "*" && x.treatment == Treatment::Excluded && x.reason.as_deref() == Some("token")));
}

#[test]
fn full_record() {
    let dir = tempfile::tempdir().unwrap();
    let events = phase11_events();
    let ws = WorkspaceInfo { cwd: Some("X:\\p".into()), created_at: Some(T.into()), ..Default::default() };
    let rec = normalize("full-1", to_events(&events), Some(ws), &[], None);
    let mut c = CoverageCounter::new();
    let body = render_full_body(
        &rec,
        &to_raw(&events),
        &[],
        &FullOptions { generated_at: T, assets_dir: dir.path().join("assets"), assets_href: "assets".into(), session_dir: None, session_dir_href: None, wal_note: Some("WAL の注意") },
        &mut c,
    );
    let uc = c.unclassified_keys();
    let md = format!("{}{}", body.text, full_tail(body.secret_hits, body.excluded, body.assets, &uc));
    for s in ["UNIQUE-REQUEST-TEXT", "応答の本文", "UNIQUE-REASONING", "読める推論", "UNIQUE-RESULT", "UNIQUE-SUMMARY", "UNIQUE-SKILL", "\"command\": \"ls\"", "postToolUse", "brand.new_type"] {
        assert!(md.contains(s), "{s}");
    }
    // 引数や結果の中の 100 字以上の英数字列は除外しない
    assert_eq!(md.matches(&long_alnum()).count(), 2);
    assert!(md.contains("result.content:") && md.contains("result.detailedContent:") && md.contains("UNIQUE-DETAILED"));
    assert!(md.contains("result(content と detailedContent は同一):"));
    assert_eq!(md.matches("UNIQUE-SAME").count(), 1);
    assert!(md.contains("UNIQUE-NONSTRING") && md.contains("reasoningText:"));
    let rb = c.entries().into_iter().find(|k| k.kind == "assistant.message" && k.key == "reasoningBlocks").unwrap();
    assert_eq!((rb.treatment, rb.excluded_n, rb.excluded_bytes), (Treatment::Partial, Some(1), Some(opaque().len() as i64)));
    assert!(!md.contains(&opaque()));
    assert!(md.contains("除外: encryptedContent") && md.contains("除外: reasoningOpaque") && md.contains("不透明データ"));
    assert!(!md.contains(&secret()));
    assert!(md.contains("[伏せました: GitHub トークン]"));
    // ツール結果で 1 回。hook の入力は同一なので参照に置き換わり、重ねて数えない
    assert_eq!(body.secret_hits, 1);
    assert!(md.contains("ツールの結果と同一") && md.contains("transformedContent は content と同じ") && md.contains("supportedNativeDocumentMimeTypes: 2 種"));
    assert_eq!(body.assets.files, 1);
    assert!(md.contains("](assets/asset-1.png)"));
    assert_eq!(std::fs::read(dir.path().join("assets").join("asset-1.png")).unwrap(), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert_eq!(body.unclassified.iter().cloned().collect::<Vec<_>>(), ["brand.new_type|mystery"]);
    assert!(md.contains("`brand.new_type|mystery`"));
    assert!(body.excluded.n >= 4);
    assert!(looks_opaque(&opaque()) && !looks_opaque("短い"));
}

#[test]
fn library_versions_and_page() {
    let mut lib = LibraryCollector::new();
    let v1 = "# AGENTS.md\n\nルール 1\n";
    let v2 = "# AGENTS.md\n\nルール 1\nルール 2\n";
    lib.add_system_message("s1", &format!("<custom_instruction>\n{v1}</custom_instruction>"), Some("2026-10-01T00:00:00Z"));
    lib.add_system_message("s2", &format!("<custom_instruction>\n{v2}</custom_instruction>"), Some("2026-10-02T00:00:00Z"));
    lib.add_system_message("s3", &format!("<custom_instruction>\n{v2}</custom_instruction>"), Some("2026-10-03T00:00:00Z"));
    lib.add_skill("s1", "my-skill", "# my-skill\n\n本文", &content_hash("# my-skill\n\n本文"), Some("2026-10-01T00:00:00Z"), Some("skills/my-skill/SKILL.md"));
    let groups = lib.result();
    let shape: Vec<(LibraryKind, &str, usize)> = groups.iter().map(|g| (g.kind, g.key.as_str(), g.versions.len())).collect();
    assert_eq!(shape, vec![(LibraryKind::Instruction, "AGENTS.md", 2), (LibraryKind::Skill, "my-skill", 1)]);
    let ins = &groups[0];
    assert_eq!((ins.versions[0].sessions.len(), ins.versions[1].sessions.len()), (1, 2));
    assert_eq!((ins.versions[1].first_at.as_deref(), ins.versions[1].last_at.as_deref(), ins.versions[1].injections), (Some("2026-10-02T00:00:00Z"), Some("2026-10-03T00:00:00Z"), 2));
    let diff = line_diff(v1, v2, 2);
    assert!(diff.contains(&"+ルール 2".to_string()));
    assert!(diff.iter().all(|l| !l.starts_with('-')));
    let dir = tempfile::tempdir().unwrap();
    let w = write_library(dir.path(), &groups).unwrap();
    assert_eq!(w.files, 3);
    assert!(std::fs::read_to_string(dir.path().join(format!("{}.md", ins.versions[1].hash))).unwrap().contains("ルール 2"));
    let html = render_instructions_html(&InstructionsPageOptions {
        css: "",
        generated_at: "2026-10-03T00:00:00Z",
        code: "c0de",
        groups: &groups,
        session_name: &|id: &str| format!("name of {id}"),
        session_project: &|_: &str| None,
        resolve_instruction: &|_: &str| None,
    });
    let h1 = &ins.versions[1].hash;
    assert!(html.contains(&format!("id=\"{}\"", skill_anchor("my-skill"))));
    assert_ne!(skill_anchor("日本語"), skill_anchor("日本語 2"));
    assert!(html.contains("<span class=\"add\"><span class=\"sign\">+</span>ルール 2</span>"));
    assert!(html.contains("sessions/s2.html") && html.contains("name of s3"));
    assert!(html.contains(&format!("id=\"v-{h1}\" data-n=\"2\" data-sessions=\"s2 s3\" open data-latest")));
    assert!(html.contains(&format!("id=\"v-{}\" data-n=\"1\" data-sessions=\"s1\">", ins.versions[0].hash)));
    let json_re = Regex::new(r#"id="lib-sessions">([^<]*)</script>"#).unwrap();
    let j: Value = serde_json::from_str(&json_re.captures(&html).unwrap()[1]).unwrap();
    assert_eq!(j, json!({ "s1": ["name of s1", "s1.html"], "s2": ["name of s2", "s2.html"], "s3": ["name of s3", "s3.html"] }));
    assert!(html.contains("data-testid=\"lib-filter\" hidden") && html.contains("addEventListener('hashchange',apply)") && html.contains("<nav class=\"toc\"") && html.contains("content=\"__ATLAS_TOKEN__\""));
    assert!(!Regex::new("https?://").unwrap().is_match(&html));

    // 全セッションで特定したファイルと範囲(ユーザー単位ならプロジェクトごとの最後の版を出さない)
    let resolved = render_instructions_html(&InstructionsPageOptions {
        css: "",
        generated_at: T,
        code: "c0de",
        groups: &groups,
        session_name: &|id: &str| id.to_string(),
        session_project: &|id: &str| Some(if id == "s1" { "X:\\repo-a".into() } else { "X:\\repo-b".into() }),
        resolve_instruction: &|_: &str| Some(ResolvedInstruction { file: "copilot-instructions.md".into(), scope: "user".into() }),
    });
    assert!(resolved.contains("<p>copilot-instructions.md(ユーザー) · 2 つの版"));
    assert!(!resolved.contains("プロジェクトごとの最後の版"));
}

#[test]
fn library_parallel_versions_and_same_project_diff() {
    let mut lib = LibraryCollector::new();
    let a1 = "# 共通ルール\n\nA の 1\n";
    let b1 = "# 共通ルール\n\nB の 1\n";
    let a2 = "# 共通ルール\n\nA の 1\nA の 2\n";
    let ci = |b: &str| format!("<custom_instruction>\n{b}</custom_instruction>");
    lib.add_system_message("a-1", &ci(a1), Some("2026-10-01T00:00:00Z"));
    lib.add_system_message("b-1", &ci(b1), Some("2026-10-02T00:00:00Z"));
    lib.add_system_message("b-2", &format!("<custom_instruction>\n<imported_custom_instruction source=\"X:\\b\\AGENTS.md\">\n{b1}</imported_custom_instruction>\n</custom_instruction>"), Some("2026-10-06T00:00:00Z"));
    lib.add_system_message("a-2", &ci(a1), Some("2026-10-03T00:00:00Z"));
    lib.add_system_message("a-3", &ci(a2), Some("2026-10-05T00:00:00Z"));
    let groups = lib.result();
    assert_eq!(groups.iter().map(|g| (g.key.as_str(), g.file.as_str(), g.versions.len())).collect::<Vec<_>>(), vec![("共通ルール", "AGENTS.md", 3)]);
    assert_eq!(groups[0].versions[1].source_paths, ["X:\\b\\AGENTS.md"]);
    let project = |id: &str| Some(if id.starts_with("a-") { "X:\\repo-a".to_string() } else { "X:\\repo-b".to_string() });
    let html = render_instructions_html(&InstructionsPageOptions { css: "", generated_at: "2026-10-06T00:00:00Z", code: "c", groups: &groups, session_name: &|id: &str| id.to_string(), session_project: &project, resolve_instruction: &|_: &str| None });
    let ids: Vec<String> = Regex::new(r#" id="(v-[0-9a-f]+)""#).unwrap().captures_iter(&html).map(|m| m[1].to_string()).collect();
    assert_eq!(ids.len(), 3);
    assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    assert!(html.contains("<b>版 1</b> <span class=\"tag\">版 2 と並行して使用</span>"));
    assert!(html.contains("<b>版 2</b> <span class=\"tag latest\">最後に使われた版</span> <span class=\"tag\">版 1・3 と並行して使用</span>"));
    let (v2, v3) = (&groups[0].versions[1], &groups[0].versions[2]);
    assert!(html.contains(&format!("プロジェクトごとの最後の版: <a href=\"#v-{}\">版 2</a> は <span title=\"X:\\repo-b\">repo-b</span>、<a href=\"#v-{}\">版 3</a> は <span title=\"X:\\repo-a\">repo-a</span>", v2.hash, v3.hash)));
    assert!(html.contains("版 1 → 版 3 の差分(repo-a で前に使われた版 1 との行の比較)"));
    assert!(!html.contains("版 2 → 版 3 の差分"));
    assert!(html.contains("版 1 → 版 2 の差分(初回日の順で 1 つ前の版との行の比較。同じプロジェクトで前に使われた版が無いので、別のプロジェクトの版と比べています)"));
    assert!(html.contains("出所 <code>X:\\b\\AGENTS.md</code>"));
    let one = render_instructions_html(&InstructionsPageOptions { css: "", generated_at: "2026-10-06T00:00:00Z", code: "c", groups: &groups, session_name: &|id: &str| id.to_string(), session_project: &|_: &str| Some("X:\\repo-a".into()), resolve_instruction: &|_: &str| None });
    assert!(one.contains(&format!("最後に使われた版: <a href=\"#v-{}\">版 2</a>", v2.hash)));

    // hasSession: 指示文か skill の本文を集めたセッションだけ
    let mut lib = LibraryCollector::new();
    lib.add_system_message("with-inst", "<custom_instruction>\n# A\n</custom_instruction>", Some(T));
    lib.add_system_message("no-inst", "ただのシステムメッセージ", Some(T));
    lib.add_skill("with-skill", "k", "body", &content_hash("body"), Some(T), None);
    assert!(lib.has_session("with-inst") && lib.has_session("with-skill") && !lib.has_session("no-inst") && !lib.has_session("never"));
}

// ---------- transcript.test.ts ----------

fn at(s: i64) -> String {
    t(s)
}

fn transcript_events() -> Vec<Value> {
    let key = format!("ghp_{}", "a".repeat(36));
    vec![
        json!({ "type": "session.start", "timestamp": at(0), "data": { "sessionId": "tr1", "copilotVersion": "1.0.100" } }),
        json!({ "type": "user.message", "timestamp": at(1), "data": { "content": format!("C:\\work\\secret-proj の README.md を直して。鍵は {key} です"), "agentMode": "interactive" } }),
        json!({ "type": "assistant.turn_start", "timestamp": at(2), "data": { "turnId": "0" } }),
        json!({ "type": "assistant.message", "timestamp": at(3), "data": { "messageId": "m1", "model": "claude-sonnet-5-5", "content": "見ます。", "toolRequests": [{ "toolCallId": "c1", "name": "view" }] } }),
        json!({ "type": "tool.execution_start", "timestamp": at(4), "data": { "toolCallId": "c1", "toolName": "view", "arguments": { "path": "C:\\work\\secret-proj\\README.md" }, "turnId": "0" } }),
        json!({ "type": "tool.execution_complete", "timestamp": at(6), "data": { "toolCallId": "c1", "success": true, "result": { "content": "SUCCESS_RESULT_BODY ```inner``` ok" } } }),
        json!({ "type": "tool.execution_start", "timestamp": at(7), "data": { "toolCallId": "c2", "toolName": "powershell", "arguments": { "command": "git push origin main" }, "turnId": "0" } }),
        json!({ "type": "tool.execution_complete", "timestamp": at(9), "data": { "toolCallId": "c2", "success": false, "error": { "code": "failure", "message": "exit 128" }, "result": { "content": "FAILED_RESULT_BODY fatal: not a repo" } } }),
        json!({ "type": "tool.execution_start", "timestamp": at(10), "data": { "toolCallId": "c3", "toolName": "report_intent", "arguments": { "intent": "x" }, "turnId": "0" } }),
        json!({ "type": "tool.execution_complete", "timestamp": at(10), "data": { "toolCallId": "c3", "success": true, "result": { "content": "Intent logged" } } }),
        json!({ "type": "subagent.started", "timestamp": at(11), "data": { "agentName": "explore", "toolCallId": "c4" } }),
        json!({ "type": "assistant.message", "timestamp": at(12), "data": { "messageId": "m2", "model": "gpt-5.5", "content": "サブの応答", "parentToolCallId": "c4" } }),
        json!({ "type": "subagent.completed", "timestamp": at(13), "data": { "agentName": "explore", "toolCallId": "c4", "durationMs": 2000, "totalTokens": 900 } }),
        json!({ "type": "assistant.message", "timestamp": at(14), "data": { "messageId": "m3", "model": "claude-sonnet-5-5", "content": "直しました。" } }),
        json!({ "type": "assistant.turn_end", "timestamp": at(15), "data": { "turnId": "0" } }),
        json!({ "type": "user.message", "timestamp": at(615), "data": { "content": "次の依頼", "agentMode": "plan" } }),
        json!({ "type": "session.compaction_start", "timestamp": at(616), "data": { "conversationTokens": 100000, "systemTokens": 5000, "toolDefinitionsTokens": 12000 } }),
        json!({ "type": "session.compaction_complete", "timestamp": at(620), "data": { "success": true, "preCompactionTokens": 117000, "compactionTokensUsed": 3000, "summaryContent": "COMPACTION_SUMMARY" } }),
        json!({ "type": "session.shutdown", "timestamp": at(630), "data": { "codeChanges": { "linesAdded": 3, "linesRemoved": 1, "filesModified": ["C:\\work\\secret-proj\\README.md"] } } }),
    ]
}

fn usage_rows() -> Vec<DbUsageRow> {
    let row = |turn: i64, agent: Option<&str>, parent: Option<&str>, model: &str, i: i64, o: i64, c: i64, aiu: i64, mult: i64, init: &str, ttft: i64, dur: i64, sec: i64| -> DbUsageRow {
        serde_json::from_value(json!({
            "session_id": "tr1", "turn_index": turn, "agent_id": agent, "parent_tool_call_id": parent, "model": model, "input_tokens": i, "output_tokens": o, "cache_read_tokens": c,
            "cache_write_tokens": 0, "reasoning_tokens": 0, "total_nano_aiu": aiu, "request_multiplier": mult, "initiator": init, "time_to_first_token_ms": ttft, "duration_ms": dur, "created_at": at(sec)
        }))
        .unwrap()
    };
    vec![
        row(0, None, None, "claude-sonnet-5-5", 1000, 50, 800, 2_000_000_000, 1, "user", 1200, 3000, 3),
        row(0, Some("ag1"), Some("c4"), "gpt-5.5", 400, 20, 0, 500_000_000, 0, "sub-agent", 700, 900, 12),
        row(0, None, None, "claude-sonnet-5-5", 1500, 60, 1400, 3_000_000_000, 1, "agent", 900, 2500, 14),
        row(1, None, None, "claude-sonnet-5-5", 2000, 10, 0, 1_000_000_000, 1, "user", 1000, 1500, 617),
    ]
}

fn transcript_setup() -> (SessionRecord, Vec<RawEvent>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let events = transcript_events();
    let path = dir.path().join("events.jsonl");
    std::fs::write(&path, events.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    let ws = WorkspaceInfo {
        cwd: Some("C:\\work\\secret-proj".into()),
        repository: Some("quokka/secret-proj".into()),
        branch: Some("feature/x1".into()),
        created_at: Some(at(0)),
        client_name: Some("github/cli".into()),
        name: Some("secret-proj の修正".into()),
        ..Default::default()
    };
    let usage = usage_rows();
    let rec = normalize("tr1", to_events(&events), Some(ws), &usage, None);
    let raw = read_raw_events(&path).unwrap();
    (rec, raw, dir)
}

fn topts<'a>(anon: &'a atlas_report::anonymize::Anonymizer, gen_at: &'a str, tool: ToolOutputMode, max_text: usize, max_tool: usize) -> TranscriptOptions<'a> {
    TranscriptOptions { anon, generated_at: gen_at, tool_output: tool, max_text_chars: max_text, max_tool_chars: max_tool, gap_ms: 5 * 60_000 }
}

#[test]
fn transcript_helpers() {
    let (text, hits) = redact_secrets(&format!("token ghp_{} and sk-{} and AKIA{} and plain text", "a".repeat(36), "b".repeat(24), "C".repeat(16)));
    assert_eq!(hits, 3);
    assert!(!Regex::new("ghp_a|sk-b|AKIAC").unwrap().is_match(&text));
    assert!(text.contains("[伏せました: GitHub トークン]"));
    assert_eq!(redact_secrets("nothing here").1, 0);
    assert_eq!(rel(Some(0), Some(3_661_000)), "+1:01:01");
    assert_eq!(rel(None, Some(0)), "+?:??:??");
    assert_eq!(summarize_args("powershell", Some(&json!({ "command": "git  status", "mode": "sync" }))), "git status");
    assert_eq!(summarize_args("view", Some(&json!({ "path": "a.ts" }))), "a.ts");
    assert!(summarize_args("x", Some(&json!({ "k": "v".repeat(200) }))).chars().count() <= 161);
    assert_eq!(transcript_file_name("a/b:c"), "a_b_c.md");
}

#[test]
fn transcript_body() {
    let (rec, raw, _dir) = transcript_setup();
    let usage = usage_rows();
    let anon = identity_anonymizer();
    let gen_at = at(1000);
    let r = render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::Fail, 20_000, 4_000));
    let md = &r.markdown;
    assert_eq!(r.source, TranscriptSource::Events);
    assert_eq!(r.events, transcript_events().len());
    assert!(md.contains("# セッション記録: secret-proj の修正"));
    assert!(md.contains("| 本体 | claude-sonnet-5.5 | 3 | 4,500 | 120 | 2,200 | 6 |"), "{md}");
    assert!(md.contains("| explore | gpt-5.5 | 1 | 400 | 20 | 0 | 0.5 |"));
    assert!(md.contains("### 依頼 1(+0:00:01、モード interactive)"));
    assert!(md.contains("### 依頼 2(+0:10:15、モード plan)"));
    assert!(md.contains("_(待ち 10分)_"));
    assert!(md.contains("✔ `view` C:\\work\\secret-proj\\README.md(2秒)"));
    assert!(md.contains("✖ `powershell` git push origin main(2秒) — 失敗: failure: exit 128"));
    assert!(md.contains("FAILED_RESULT_BODY") && !md.contains("SUCCESS_RESULT_BODY") && !md.contains("report_intent"));
    assert!(md.contains("[agent:explore] **応答**(gpt-5.5)"));
    assert!(md.contains("サブエージェント完了 `explore`(2秒、トークン 900)"));
    assert!(md.contains("compaction 完了、圧縮前 117,000 トークン、compaction 自体の消費 3,000"));
    assert!(md.contains("COMPACTION_SUMMARY"));
    assert!(md.contains("**セッション終了**: 変更 +3 / −1 行、ファイル 1 件"));
    assert_eq!(md.matches("_依頼 1 の本体の消費: リクエスト 2、入力 2,500、出力 110").count(), 1);
    assert_eq!(md.matches("_依頼 2 の本体の消費: リクエスト 1、入力 2,000、出力 10").count(), 1);
    assert!(!md.contains(&format!("ghp_{}", "a".repeat(36))));
    assert_eq!(r.secret_hits, 1);
    assert!(md.contains("1 件伏せました") && md.contains("### 変更(1)") && md.contains("## 分析の観点(LLM に渡すとき)"));
}

#[test]
fn transcript_tool_output_and_limits() {
    let (rec, raw, _dir) = transcript_setup();
    let usage = usage_rows();
    let anon = identity_anonymizer();
    let gen_at = at(1000);
    let all = render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::All, 20_000, 4_000)).markdown;
    assert!(all.contains("SUCCESS_RESULT_BODY"));
    // 本文に ``` があっても囲みが壊れない(4 つ以上のバッククォートで囲む)
    assert!(all.contains("````\nSUCCESS_RESULT_BODY ```inner``` ok\n````"));
    let none = render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::None, 20_000, 4_000)).markdown;
    assert!(!none.contains("FAILED_RESULT_BODY") && none.contains("✖ `powershell`"));
    assert_eq!(render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::All, 200, 4_000)).truncated, 0);
    let tiny = render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::All, 200, 10));
    assert!(tiny.truncated > 0);
    assert!(Regex::new(r"…\(中略 \d+ 字\)…").unwrap().is_match(&tiny.markdown));
}

#[test]
fn transcript_anonymized_and_record_only() {
    let (rec, raw, _dir) = transcript_setup();
    let usage = usage_rows();
    let anon = create_anonymizer(&[AnonSource::from(&rec)]);
    let gen_at = at(1000);
    let md = render_transcript(&rec, Some(&raw), &usage, &topts(&anon, &gen_at, ToolOutputMode::Fail, 20_000, 4_000)).markdown;
    assert!(md.contains("伏せ字モード"));
    for s in ["secret-proj", "quokka", "feature/x1", "C:\\work"] {
        assert!(!md.contains(s), "{s}");
    }
    assert!(md.contains("project-01") && md.contains("branch-01") && md.contains("<path>") && md.contains("伏せ字モードのためパスは出しません") && md.contains("を直して"));
    // スナップショットに events.jsonl が無ければ sessions.json の抜粋だけで組む
    let id = identity_anonymizer();
    let r = render_transcript(&rec, None, &[], &topts(&id, &gen_at, ToolOutputMode::Fail, 20_000, 4_000));
    assert_eq!((r.source, r.events), (TranscriptSource::Record, 0));
    assert!(r.markdown.contains("### 最初の依頼") && r.markdown.contains("### 最後の応答") && r.markdown.contains("リクエスト単位の明細はありません"));
}
