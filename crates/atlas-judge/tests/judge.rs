// 評価パケット・バンドル・依頼ごとの判定の振る舞い(packages/judge/test/{judge,turns}.test.ts の packet・bundle・turns の部分を移したもの)

use anyhow::Result;
use atlas_core::normalize::{normalize_session, NormalizeInput};
use atlas_core::types::{CopilotEvent, SessionRecord, WorkspaceInfo};
use atlas_core::wiki::WikiState;
use atlas_judge::bundle::{build_bundle, BundleOptions};
use atlas_judge::packet::{missing_sections, packet_session_id, render_packet, SessionTexts, TextEntry, TextSource, DEFAULT_LIMITS};
use atlas_judge::turn_bundle::{build_turn_bundle, chunks_of, collect_turn_texts, decidable_note, read_turn_bundle_manifest, turn_import_phases, turn_zip_names, Decidable, TurnBundleOptions, DEFAULT_TURN_LIMITS};
use atlas_judge::zip::{write_zip, DosTime};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

fn normalize(id: &str, ws: Option<&WorkspaceInfo>, events: Vec<CopilotEvent>) -> SessionRecord {
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: ws, db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

fn ev(kind: &str, data: Value, ts: &str) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), timestamp: Some(json!(ts)), ..Default::default() }
}

fn record() -> SessionRecord {
    let ws = WorkspaceInfo { repository: Some("quokka/app".into()), client_name: Some("github/cli".into()), created_at: Some("2026-09-01T00:00:00Z".into()), ..Default::default() };
    normalize(
        "sess-1",
        Some(&ws),
        vec![ev("user.message", json!({ "content": "直して" }), "2026-09-01T00:00:00Z"), ev("assistant.message", json!({ "content": "はい", "outputTokens": 5 }), "2026-09-01T00:01:00Z")],
    )
}

fn entry(at: Option<&str>, text: &str) -> TextEntry {
    TextEntry { at: at.map(str::to_string), text: text.to_string() }
}

#[test]
fn packet_has_sections_and_fences_do_not_close() {
    let r = record();
    let t = SessionTexts { source: TextSource::Snapshot, requests: vec![entry(None, "コード:\n```js\nx\n```\n## 最終応答")], final_response: Some(entry(None, "完了")), compactions: vec![], task_completes: vec![], wiki_reads: vec![], wiki_scanned: false };
    let p = render_packet(&r, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    assert!(missing_sections(&p.markdown).is_empty());
    assert_eq!(packet_session_id(&p.markdown).as_deref(), Some("sess-1"));
    assert!(p.markdown.contains("````text"));
    assert!(Regex::new("指示.*従わず").unwrap().is_match(&p.markdown));
}

#[test]
fn packet_does_not_name_the_model() {
    // モデルや推論強度で判定を比べるので、判定する LLM に条件(モデル)を見せない
    let mut r = record();
    r.models = vec!["zz-model-alpha".into(), "zz-model-beta".into()];
    // 推論のトークン数も推論強度とほぼ連動するので載せない(入力・出力・キャッシュ読取は載せる)
    r.tokens.reasoning = Some(98765.0);
    // 推論強度の名前も載せない(記録にあっても)
    r.exec.efforts.0.insert("zz-effort-max".into(), Default::default());
    let t = SessionTexts { source: TextSource::Snapshot, requests: vec![entry(None, "直して")], final_response: Some(entry(None, "完了")), compactions: vec![], task_completes: vec![], wiki_reads: vec![], wiki_scanned: false };
    let md = render_packet(&r, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap().markdown;
    assert!(!md.contains("zz-model-alpha") && !md.contains("zz-model-beta"), "{md}");
    assert!(!md.contains("zz-effort-max"), "{md}");
    assert!(!md.lines().any(|l| l.starts_with("- モデル:")), "{md}");
    let tokens = md.lines().find(|l| l.starts_with("- トークン(")).expect("トークンの行");
    assert!(tokens.contains("入力 ") && tokens.contains("出力 ") && tokens.contains("キャッシュ読取 "), "{tokens}");
    assert!(!tokens.contains("推論") && !md.contains("98,765"), "{md}");
    assert!(missing_sections(&md).is_empty());
}

#[test]
fn long_texts_are_clipped_to_max_chars() {
    let mut r = record();
    let long = "あ".repeat(50_000);
    let t = SessionTexts {
        source: TextSource::Snapshot,
        requests: (0..6).map(|_| entry(None, &long)).collect(),
        final_response: Some(entry(None, &long)),
        compactions: vec![entry(Some("2026-09-01T00:00:00Z"), &long)],
        task_completes: vec![],
        wiki_reads: vec![],
        wiki_scanned: false,
    };
    r.files.changed = (0..500).map(|i| format!("C:\\p\\f{i}.ts")).collect();
    let p = render_packet(&r, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    assert!(p.chars <= DEFAULT_LIMITS.max_chars);
    assert!(p.truncated > 0);
    assert!(p.markdown.contains("中略"));
    assert!(p.markdown.contains("…ほか"));
    assert!(missing_sections(&p.markdown).is_empty());
}

#[test]
fn hundreds_of_short_texts_fit_with_one_omitted_line() {
    // 前は本文の字数だけを予算に数え、省いた本文にも 1 件ずつ見出しを付けていたため、
    // 依頼が数百件あるセッションは上限を下げても縮まず「パケットが上限に収まりません」で添付ファイルを作れなかった
    let mut r = record();
    let at = |i: usize| format!("2026-09-01T{:02}:{:02}:00.000Z", (i / 60) % 24, i % 60);
    let t = SessionTexts {
        source: TextSource::Snapshot,
        requests: (0..1500).map(|i| entry(Some(&at(i)), &format!("はい {i}"))).collect(),
        final_response: Some(entry(None, "完了")),
        compactions: (0..400).map(|i| entry(Some(&at(i)), &format!("要約 {i}"))).collect(),
        task_completes: (0..400).map(|i| entry(Some(&at(i)), &format!("完了 {i}"))).collect(),
        wiki_reads: vec![],
        wiki_scanned: false,
    };
    r.wiki.skill_calls = (0..2000).map(|i| format!("wiki-query-{}", i % 300)).collect();
    r.wiki.index_reads = 1;
    let p = render_packet(&r, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    assert!(p.chars <= DEFAULT_LIMITS.max_chars);
    assert!(missing_sections(&p.markdown).is_empty());
    assert!(p.markdown.contains("ユーザーの依頼 1500 件"));
    assert!(Regex::new(r"### 依頼 \d+〜1500\n\(上限のため省略。[\d,]+ 件、計 [\d,]+ 字\)").unwrap().is_match(&p.markdown));
    assert_eq!(p.markdown.matches("上限のため省略").count(), 2);
    assert!(Regex::new(r"### それより前の要約 [\d,]+ 件").unwrap().is_match(&p.markdown));
    assert!(p.markdown.contains("…ほか"));
    assert!(p.truncated > 1000);
}

/// パケットの llm-wiki の行: そのほかの呼び出し(vault の検索・一覧など)だけのセッションも参照として回数を出し、
/// vault に触れていなければ「参照なし」、vault を指定せずに集計したときは「数えていません」
#[test]
fn packet_wiki_line_counts_other_calls_and_not_counted() {
    let t = SessionTexts { source: TextSource::Snapshot, requests: vec![entry(None, "調べて")], final_response: None, compactions: vec![], task_completes: vec![], wiki_reads: vec![], wiki_scanned: false };
    let wiki_line = |md: &str| md.lines().find(|l| l.starts_with("- llm-wiki: ")).map(str::to_string);
    let mut r = record();
    r.wiki.other_calls = 2;
    let p = render_packet(&r, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    assert_eq!(wiki_line(&p.markdown).as_deref(), Some("- llm-wiki: 索引の読み取り 0 回 / ページ読み取り 0 件 / wiki skill 0 回 / そのほかの呼び出し 2 回 / 書き込み 0 回"));
    // 書き込みだけでも vault に触れたので回数を出す(「参照なし」にしない)
    let mut wo = record();
    wo.wiki.writes = 1;
    assert_eq!(wiki_line(&render_packet(&wo, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap().markdown).as_deref(), Some("- llm-wiki: 索引の読み取り 0 回 / ページ読み取り 0 件 / wiki skill 0 回 / そのほかの呼び出し 0 回 / 書き込み 1 回"));
    // 触れていない
    let plain = record();
    assert_eq!(wiki_line(&render_packet(&plain, &t, &DEFAULT_LIMITS, WikiState::Counted).unwrap().markdown).as_deref(), Some("- llm-wiki: 参照なし"));
    // 古い集計(vault の数の記録なし)で、どのセッションも vault に触れていない: 「参照なし」と言い切らない
    let unknown = render_packet(&plain, &t, &DEFAULT_LIMITS, WikiState::NoRecord).unwrap();
    assert_eq!(wiki_line(&unknown.markdown).as_deref(), Some("- llm-wiki: この集計では数えたか分かりません(vault の指定の記録なし)"));
    assert!(missing_sections(&unknown.markdown).is_empty());
    // vault を指定せずに集計した
    let off = render_packet(&plain, &t, &DEFAULT_LIMITS, WikiState::NotCounted).unwrap();
    assert_eq!(wiki_line(&off.markdown).as_deref(), Some("- llm-wiki: この集計では数えていません(vault の指定なし)"));
    assert!(missing_sections(&off.markdown).is_empty());
}

/// 架空の vault のページを読むセッション(events.jsonl をスナップショットに書く)。ページの名前は集計の分類の代わりに直接入れる
fn wiki_session(snap: &Path, pages: usize) -> SessionRecord {
    let vault = "X:\\zz-notes\\zz-vault";
    let mut events = vec![ev("session.start", json!({ "context": { "cwd": "X:\\p" } }), &ts(0)), ev("user.message", json!({ "content": "知見を探して直して" }), &ts(1000))];
    for i in 0..pages {
        let call = format!("c{i}");
        let path = format!("{vault}\\wiki\\p{i}.md");
        events.push(ev("tool.execution_start", json!({ "toolCallId": call, "toolName": "view", "arguments": { "path": path } }), &ts(2000 + i as i64 * 10)));
        let body = match i {
            // 秘密らしい文字列が抜粋の上限(400 字)の境目をまたぐ形と、上限を超える長さ
            0 => format!("{}ghp_{} を使う\n{}", "い".repeat(390), "A".repeat(36), "う".repeat(1000)),
            // 結果の本文が無い形
            1 => String::new(),
            _ => format!("ページ {i} の中身"),
        };
        let result = if body.is_empty() { json!({}) } else { json!({ "content": body }) };
        events.push(ev("tool.execution_complete", json!({ "toolCallId": call, "success": true, "result": result }), &ts(2001 + i as i64 * 10)));
    }
    // 読んだ後の編集(読み取りとしては数えない)と、内部ツール(並べない)
    events.push(ev("tool.execution_start", json!({ "toolCallId": "r", "toolName": "report_intent", "arguments": { "intent": "x" } }), &ts(5000)));
    events.push(ev("tool.execution_start", json!({ "toolCallId": "e", "toolName": "edit", "arguments": { "path": format!("{vault}\\wiki\\p0.md") } }), &ts(5001)));
    events.push(ev("assistant.message", json!({ "content": "直しました" }), &ts(6000)));
    // 次の依頼の中のツールは「読んだ後のツール」に入れない
    events.push(ev("user.message", json!({ "content": "ありがとう" }), &ts(7000)));
    events.push(ev("tool.execution_start", json!({ "toolCallId": "n", "toolName": "grep", "arguments": { "pattern": "x" } }), &ts(7001)));
    let dir = snap.join("session-state").join("w1");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("events.jsonl"), events.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n")).unwrap();
    let mut r = normalize("w1", None, events);
    // 集計の分類が出す形(vault からの相対。同じページを 2 回読んだ記録を含む)
    r.wiki.page_reads = (0..pages).map(|i| format!("wiki/p{i}.md")).chain(["wiki/p0.md".to_string()]).collect();
    r.wiki.index_reads = 1;
    r
}

/// 判定のパケットの「llm-wiki のページごとの判定」: 抜粋は秘密を伏せてから切り、ページ数と字数に上限があり、抜粋が無い形はそう書く
#[test]
fn packet_lists_wiki_pages_with_excerpts_and_limits() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let max = atlas_core::wiki::WIKI_JUDGED_PAGES_MAX;
    let r = wiki_session(&snap, max + 2);
    let texts = atlas_judge::packet::collect_texts(&snap, &[&r], None, None).unwrap();
    let t = &texts["w1"];
    assert!(t.wiki_scanned);
    // 読んだ呼び出しはページごとに最初の 1 回。上限を超えたページは探さない
    assert_eq!(t.wiki_reads.len(), max);
    let p0 = &t.wiki_reads[0];
    assert_eq!((p0.page.as_str(), p0.request), ("wiki/p0.md", Some(1)));
    // 読んだ後のツール: 同じ依頼の中の、内部ツールを除いたもの(上限 5 件)
    assert_eq!(p0.after_tools, ["view", "view", "view", "view", "view"]);
    assert_eq!(t.wiki_reads[max - 1].after_tools, ["view", "view", "edit"]);
    assert!(!p0.excerpt.as_ref().unwrap().contains("ghp_"), "秘密は伏せる");
    // 結果の本文が無い呼び出しは抜粋にしない(読んだ時刻と依頼は残す)
    assert_eq!((t.wiki_reads[1].excerpt.as_deref(), t.wiki_reads[1].request), (None, Some(1)));

    let p = render_packet(&r, t, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    let md = &p.markdown;
    assert!(missing_sections(md).is_empty());
    assert!(md.contains(&format!("判定するページ {max} 件(重複を除いて読んだ順の先頭から。残り 2 件は上限のため判定しません)")), "{md}");
    assert!(md.contains("#### ページ 1: wiki/p0.md"));
    assert!(!md.contains(&format!("wiki/p{max}.md")), "上限を超えたページは載せない");
    // 伏せてから切る: 境目をまたいだ鍵が、切れた形で残らない
    assert!(!md.contains("ghp_") && !md.contains("AAAAAAAA"), "{md}");
    assert!(md.contains(&format!("{}[伏せました", "い".repeat(10))));
    assert!(md.contains(&format!("- 抜粋(先頭 {} 字 / 全 ", DEFAULT_LIMITS.wiki_excerpt_chars)));
    assert!(md.contains("- 抜粋なし(成功して結果の本文がある読み取りがログにありません。"));
    assert!(md.contains("- 読んだ時刻: 2026-11-06T00:00:02.000Z(依頼 1 の中)"));
    assert!(p.truncated >= 1);

    // ログの全文が無い(抜粋で代用した)ときは、名前だけで判定させる
    let ex = atlas_judge::packet::excerpt_texts(&r);
    let pe = render_packet(&r, &ex, &DEFAULT_LIMITS, WikiState::Counted).unwrap();
    assert!(pe.markdown.contains("- 抜粋なし(ログの全文が無く、読んだ呼び出しを確かめられません。"));
    // ログが無く session-store.db から本文を取ったとき(呼び出しを探していない)も同じ文
    let db = SessionTexts { source: TextSource::Snapshot, wiki_reads: vec![], wiki_scanned: false, ..t.clone() };
    let pd = render_packet(&r, &db, &DEFAULT_LIMITS, WikiState::Counted).unwrap().markdown;
    assert!(pd.contains("- 抜粋なし(ログの全文が無く、読んだ呼び出しを確かめられません。"));
    assert!(!pd.contains("特定できませんでした"));
    // 数えていない集計ではページの節を出さない
    assert!(!render_packet(&r, t, &DEFAULT_LIMITS, WikiState::NotCounted).unwrap().markdown.contains("ページごとの判定"));
    // 上限に収まらないときは、抜粋の字数も下げる(ページの並びは変えない)
    let tight = atlas_judge::packet::PacketLimits { max_chars: p.chars - 50, ..DEFAULT_LIMITS };
    let pt = render_packet(&r, t, &tight, WikiState::Counted).unwrap();
    assert!(pt.chars <= p.chars - 50);
    assert!(pt.limits.wiki_excerpt_chars < DEFAULT_LIMITS.wiki_excerpt_chars);
    assert!(pt.markdown.contains(&format!("#### ページ {max}: wiki/p{}.md", max - 1)));
    // 前の版の manifest(抜粋の字数の無い limits)も読める
    let old: atlas_judge::packet::PacketLimits = serde_json::from_value(json!({ "maxChars": 24000, "requestChars": 6000, "requestsTotalChars": 12000, "finalResponseChars": 5000, "summaryChars": 5000, "listItems": 40 })).unwrap();
    assert_eq!(old.wiki_excerpt_chars, DEFAULT_LIMITS.wiki_excerpt_chars);
}

/// events.jsonl だけを書いたセッション(ページの名前は集計の分類の代わりに直接入れる)
fn session_with_events(snap: &Path, id: &str, events: Vec<CopilotEvent>, page_reads: &[&str]) -> SessionRecord {
    let dir = snap.join("session-state").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("events.jsonl"), events.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n")).unwrap();
    let mut r = normalize(id, None, events);
    r.wiki.page_reads = page_reads.iter().map(|s| s.to_string()).collect();
    r
}

/// ツールの呼び出しの開始と完了(result が None なら結果の本文なし)
fn call(id: &str, name: &str, args: Value, ok: bool, result: Option<&str>, at: i64) -> [CopilotEvent; 2] {
    let mut done = json!({ "toolCallId": id, "success": ok });
    if let Some(r) = result {
        done["result"] = json!({ "content": r });
    }
    [ev("tool.execution_start", json!({ "toolCallId": id, "toolName": name, "arguments": args }), &ts(at)), ev("tool.execution_complete", done, &ts(at + 1))]
}

/// 抜粋を取る呼び出しが、そのページを読んだ呼び出しと違わないか。vault の指定(集計と同じ分類器)があるときと、無いとき(名前で探す)
#[test]
fn wiki_excerpt_comes_from_the_call_that_read_the_page() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let vault = "X:\\zz-notes\\zz-vault";
    let mut events = vec![ev("user.message", json!({ "content": "調べて" }), &ts(0))];
    // a. vault の直下のページ(AGENTS.md)と、プロジェクトの同じ名前のファイル
    events.extend(call("a1", "view", json!({ "path": "X:\\p\\AGENTS.md" }), true, Some("プロジェクトの AGENTS"), 100));
    events.extend(call("a2", "view", json!({ "path": format!("{vault}\\AGENTS.md") }), true, Some("vault の AGENTS"), 110));
    // b. 区切りが二重(\\)の形
    events.extend(call("b1", "view", json!({ "path": "X:\\\\zz-notes\\\\zz-vault\\\\wiki\\\\b.md" }), true, Some("b の中身"), 200));
    // c. サブエージェントへの依頼文にページの場所がある・最初の読み取りは失敗 → 後の成功した読み取りから取る
    events.extend(call("c0", "task", json!({ "prompt": format!("{vault}\\wiki\\c.md を読んで要約して") }), true, Some("サブエージェントの要約"), 300));
    events.extend(call("c1", "view", json!({ "path": format!("{vault}\\wiki\\c.md") }), false, None, 310));
    events.extend(call("c2", "view", json!({ "path": format!("{vault}\\wiki\\c.md") }), true, Some("c の中身"), 320));
    // d. 名前の続きがあるファイル(d.md.bak)は d.md の読み取りではない
    events.extend(call("d1", "view", json!({ "path": format!("{vault}\\wiki\\d.md.bak") }), true, Some("古い控え"), 400));
    events.extend(call("d2", "view", json!({ "path": format!("{vault}\\wiki\\d.md") }), true, Some("d の中身"), 410));
    // e. 1 回の呼び出しで 2 つのページを読む
    events.extend(call("e1", "rg", json!({ "pattern": "x", "paths": [format!("{vault}\\wiki\\e1.md"), format!("{vault}\\wiki\\e2.md")] }), true, Some("e の検索結果"), 500));
    let pages = ["AGENTS.md", "wiki/b.md", "wiki/c.md", "wiki/d.md", "wiki/e1.md", "wiki/e2.md"];
    let r = session_with_events(&snap, "m1", events, &pages);
    let c = atlas_core::wiki::WikiClassifier::new(&[atlas_core::wiki::WikiSpec { path: "zz-vault".into(), ..Default::default() }]);
    let excerpts = |classifier: Option<&atlas_core::wiki::WikiClassifier>| -> HashMap<String, Option<String>> {
        let t = &atlas_judge::packet::collect_texts(&snap, &[&r], None, classifier).unwrap()["m1"];
        t.wiki_reads.iter().map(|w| (w.page.clone(), w.excerpt.clone())).collect()
    };
    let with = excerpts(Some(&c));
    let without = excerpts(None);
    let ex = |m: &HashMap<String, Option<String>>, p: &str| m.get(p).cloned().flatten();
    // a: 分類器は vault の中のファイルだけを読み取りにする(名前で探すときは見分けられない。docs/judge.md に書いた限界)
    assert_eq!(ex(&with, "AGENTS.md").as_deref(), Some("vault の AGENTS"));
    assert_eq!(ex(&without, "AGENTS.md").as_deref(), Some("プロジェクトの AGENTS"));
    for m in [&with, &without] {
        assert_eq!(ex(m, "wiki/b.md").as_deref(), Some("b の中身"));
        assert_eq!(ex(m, "wiki/c.md").as_deref(), Some("c の中身"));
        assert_eq!(ex(m, "wiki/d.md").as_deref(), Some("d の中身"));
        assert_eq!(ex(m, "wiki/e1.md").as_deref(), Some("e の検索結果"));
    }
    // 1 回の呼び出しで読んだページは、ほかのページと同じ抜粋だと書く
    let t = &atlas_judge::packet::collect_texts(&snap, &[&r], None, Some(&c)).unwrap()["m1"];
    let md = render_packet(&r, t, &DEFAULT_LIMITS, WikiState::Counted).unwrap().markdown;
    assert_eq!(md.matches("ほかのページと同じ結果の抜粋").count(), 2, "{md}");
    assert!(!md.contains("サブエージェントの要約") && !md.contains("古い控え") && !md.contains("プロジェクトの AGENTS"));
}

const PHASES: [&str; 4] = ["要件定義", "設計", "実装", "テスト"];

fn phases() -> Vec<String> {
    PHASES.iter().map(|s| s.to_string()).collect()
}

fn ts(ms: i64) -> String {
    atlas_core::jsdate::to_iso(atlas_core::jsdate::parse_ms("2026-11-06T00:00:00.000Z").unwrap() + ms)
}

/// 依頼 n 件のセッション(依頼 3 の後に autopilot の自動継続、各依頼にサブエージェントの発言)をスナップショットに書く
fn session_with_turns(snap: &Path, id: &str, n: usize, extras: bool) -> SessionRecord {
    let mut events = vec![ev("session.start", json!({ "context": { "cwd": "X:\\p" } }), &ts(0))];
    for i in 1..=n {
        let b = (i * 1000) as i64;
        events.push(ev("user.message", json!({ "content": format!("依頼 {i} の本文") }), &ts(b)));
        if extras && i == 3 {
            events.push(ev("user.message", json!({ "content": "(自動継続)", "isAutopilotContinuation": true }), &ts(b + 50)));
        }
        events.push(ev("assistant.message", json!({ "content": format!("応答 {i}") }), &ts(b + 100)));
        if extras {
            events.push(ev("assistant.message", json!({ "content": "サブエージェントの発言", "parentToolCallId": "x" }), &ts(b + 200)));
        }
    }
    let dir = snap.join("session-state").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("events.jsonl"), events.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n")).unwrap();
    normalize(id, None, events)
}

#[test]
fn turn_chunks_follow_normalize_and_attach_next_request() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 8, true);
    let t = collect_turn_texts(&snap, "s1").unwrap().unwrap();
    assert_eq!(t.requests.len(), 8);
    assert_eq!(t.responses[0].as_deref(), Some("応答 1"));
    assert_eq!(s.analysis.turn_stats.as_ref().unwrap().len(), 8);
    let chunks = chunks_of(&s, &t, None, &DEFAULT_TURN_LIMITS);
    // 最後の依頼 8 は、前の依頼 7 と同じ塊に入れない(どのセッションでも、最後の依頼は 1 件だけの塊)
    assert_eq!(chunks.iter().map(|c| c.turns.clone()).collect::<Vec<_>>(), vec![vec![1, 2, 3, 4, 5, 6], vec![7], vec![8]]);
    assert!(chunks[0].markdown.contains("## 依頼 7(判定しない。依頼 6 の成果の扱いを読むための参考)"));
    assert!(chunks[1].markdown.contains("## 依頼 8(判定しない。依頼 7 の成果の扱いを読むための参考)"));
    assert!(!chunks[1].markdown.contains("次の依頼はありません"));
    assert!(chunks[2].markdown.contains("次の依頼はありません(セッションの最後)。依頼 8 の outcome は unknown(判定不能)にしてください。"));
    // 塊の先頭の依頼が何への反応かを読めるよう、前の依頼文を参考に添える(最後の依頼だけの塊にも)
    assert!(chunks[1].markdown.contains("## 依頼 6(判定しない。依頼 7 が何への反応かを読むための参考)"));
    assert!(chunks[2].markdown.contains("## 依頼 7(判定しない。依頼 8 が何への反応かを読むための参考)"));
    assert!(!chunks[0].markdown.contains("何への反応か"));
    // 未判定だけ: 続いた番号ごとに区切る。最後の依頼は、続いていても分ける
    let turns_of = |only: &[usize]| chunks_of(&s, &t, Some(&only.iter().copied().collect::<HashSet<usize>>()), &DEFAULT_TURN_LIMITS).iter().map(|c| c.turns.clone()).collect::<Vec<_>>();
    assert_eq!(turns_of(&[2, 3, 6]), vec![vec![2, 3], vec![6]]);
    assert_eq!(turns_of(&[6, 7, 8]), vec![vec![6, 7], vec![8]]);
}

#[test]
fn over_200_requests_attach_201st_as_reference() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let big = session_with_turns(&snap, "s2", 203, false);
    let t = collect_turn_texts(&snap, "s2").unwrap().unwrap();
    assert_eq!(t.requests.len(), 201);
    assert_eq!(t.responses[200], None);
    let chunks = chunks_of(&big, &t, None, &DEFAULT_TURN_LIMITS);
    assert_eq!(chunks.iter().map(|c| c.turns.len()).sum::<usize>(), 200);
    let last = &chunks[chunks.len() - 1].markdown;
    assert!(last.contains("## 依頼 201(判定しない。依頼 200 の成果の扱いを読むための参考)"));
    assert!(!last.contains("次の依頼はありません"));
}

fn turn_opts<'a>(dir: &Path, snap: &Path, phases: Vec<String>) -> TurnBundleOptions<'a> {
    TurnBundleOptions { bundle_dir: dir.to_path_buf(), snapshot_dir: snap.to_path_buf(), phases, judged: None, limits: None, boundary: None, now: None }
}

#[test]
fn turn_bundle_parts_and_import_phases() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 8, true);
    let tb = d.path().join("tb");
    build_turn_bundle(&[&s], &turn_opts(&tb, &snap, phases())).unwrap();
    let cfg = vec!["調査".to_string(), "実装".to_string()];
    let mut want = phases();
    want.push("調査".into());
    assert_eq!(turn_import_phases(&tb, &cfg), want);
    assert_eq!(turn_import_phases(&d.path().join("none"), &cfg), cfg);

    let judged: HashMap<String, HashSet<i64>> = [("s1".to_string(), [1, 2].into_iter().collect())].into_iter().collect();
    let m = build_turn_bundle(&[&s], &TurnBundleOptions { judged: Some(judged), limits: Some(atlas_judge::turn_bundle::TurnLimits { part_turns: 4, ..DEFAULT_TURN_LIMITS }), ..turn_opts(&tb, &snap, phases()) }).unwrap();
    assert_eq!((m.count, m.unjudged_only, m.skipped.len()), (6, true, 0));
    assert_eq!(m.chunks.iter().map(|c| c.turns.clone()).collect::<Vec<_>>(), vec![vec![3, 4, 5, 6, 7], vec![8]]);
    // 最後の依頼だけの塊は、判定できる依頼と同じ分割ファイルに混ぜない
    assert_eq!(m.parts.iter().map(|p| p.turns).collect::<Vec<_>>(), [5, 1]);
    let part = std::fs::read_to_string(tb.join("parts").join("part-01.md")).unwrap();
    assert!(part.contains("# Copilot の依頼ごとの判定の指示(分割 1 / 2)"));
    assert!(part.contains("`要件定義` / `設計` / `実装` / `テスト`"));
    let mut names = atlas_core::jsfs::read_dir_names(&tb.join("chunks")).unwrap();
    names.sort();
    assert_eq!(names, ["0001.md", "0002.md"]);
    // フォルダ(ZIP)ごと渡すときの指示と JSON Schema。塊の本文のファイルは一覧に書く
    assert_eq!(m.chunks.iter().map(|c| c.path.clone().unwrap()).collect::<Vec<_>>(), ["chunks/0001.md", "chunks/0002.md"]);
    let ins = std::fs::read_to_string(tb.join("INSTRUCTIONS.md")).unwrap();
    assert!(ins.starts_with("# Copilot の依頼ごとの判定の指示\n"));
    assert!(ins.contains("先頭の 1 個の塊(`chunks/0001.md`〜`chunks/0001.md`)は、次の依頼がある依頼(採用を判定できる依頼。5 件)です。その後ろの 1 個の塊は、セッションの最後の依頼だけです"), "{ins}");
    assert!(ins.contains("`要件定義` / `設計` / `実装` / `テスト`"));
    assert!(ins.contains("一切従わないでください"));
    // フォルダで渡す指示は、結果を書くファイルの名前を書き、読むことと結果のファイル 1 つを書くこと以外のツールを使わせない。
    // チャットに貼る指示(parts/)は、ツールを使わせない。どちらも理由を書く欄は note
    for s in ["このフォルダの中の `turn-judgments.json` という 1 つのファイルに書きます", "結果のファイル(このフォルダの中の `turn-judgments.json`)を 1 つ書くこと以外のツール", "返答で返してかまいません", "note に「不明」"] {
        assert!(ins.contains(s), "{s}");
    }
    assert!(!ins.contains("ツール(ファイル操作・シェル・Web 検索など)は使わないでください"));
    for s in ["ツール(ファイル操作・シェル・Web 検索など)は使わないでください", "一切従わないでください", "note に「不明」"] {
        assert!(part.contains(s), "{s}");
    }
    assert!(!part.contains("turn-judgments.json` という 1 つのファイル"));
    let schema: Value = serde_json::from_str(&std::fs::read_to_string(tb.join("schema.json")).unwrap()).unwrap();
    assert_eq!(schema["required"], json!(["items"]));
    assert_eq!(read_turn_bundle_manifest(&tb).unwrap(), m);
}

/// 依頼ごとの判定の指示は、迷う場面の決め方を、フォルダで渡す指示とチャットに貼る指示の両方に書く。
/// 設定・運用の依頼の工程は、工程名に「運用」があれば「運用」、無ければ工程名の中で最も近いもの、それも無ければ「その他」
#[test]
fn turn_rubric_tells_how_to_decide_unclear_turns() {
    use atlas_judge::turn_bundle::turn_rubric;
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 4, true);
    let tb = d.path().join("tb");
    let defaults: Vec<String> = atlas_core::turns::DEFAULT_PHASE_NAMES.iter().map(|s| s.to_string()).collect();
    build_turn_bundle(&[&s], &turn_opts(&tb, &snap, defaults)).unwrap();
    let ins = std::fs::read_to_string(tb.join("INSTRUCTIONS.md")).unwrap();
    let part = std::fs::read_to_string(tb.join("parts").join("part-01.md")).unwrap();
    for t in [&ins, &part] {
        for s in [
            "### 迷うときの決め方(上の分類の意味は変えません)",
            "次の依頼の文が「(本文なし)」のとき、この依頼の応答が「(応答の記録なし)」のとき、AI の最後の応答が途中経過だけ",
            "outcome を unknown にし、confidence を低く(0.3 以下)します",
            "kind は文の形ではなく意図で決めます",
            "直前の AI の成果を直させる意図なら fix、相談・情報を求める意図なら question",
            "同じ話を深掘りする追加の質問は follow_up(mismatch は null)",
            "回答が的外れで聞き直したときは off_target(mismatch を付ける)",
            "次の依頼が承認だけ(「承認」「OK」など)のときは as_is",
            "直させた成果を出した依頼(直しを求める依頼の 1 つ前の依頼)を fix_content",
            "次の依頼が「再開」「続けて」だけのときは、この依頼の outcome は unknown",
            "ツールや環境の設定・運用(エージェントやエディタの設定、ビルドや実行の環境、権限、認証など)の依頼は `運用`(`その他` にはしません)",
            "`要件定義` は、作るものの要件・仕様を決める依頼だけにします",
        ] {
            assert!(t.contains(s), "{s}");
        }
    }
    // 結果のファイルは手で書いてよい(フォルダで渡すときだけ。チャットに貼る指示はファイルを書かない)
    assert!(ins.contains("`turn-judgments.json` は、判定しながら手で書いてかまいません"));
    assert!(!part.contains("手で書いてかまいません"));
    // 工程名を変えたとき: 「運用」が無ければ、いちばん近い工程名(その名前を文に入れる)。それも無ければ「その他」
    use atlas_judge::turn_bundle::{ops_phase_of, OpsPhase};
    let names = |xs: &[&str]| -> Vec<String> { xs.iter().map(|s| s.to_string()).collect() };
    let near = names(&["設計", "実装", "環境構築", "その他"]);
    assert_eq!(ops_phase_of(&near), OpsPhase::Near("環境構築".into()));
    let r = turn_rubric(&near);
    assert!(r.contains("の依頼は `環境構築`(工程名に「運用」が無いため、いちばん近い工程名にします。`その他` にはしません)"), "{r}");
    // 近さは語の順(保守が環境より近い)。英字は大文字・小文字を区別しない
    assert_eq!(ops_phase_of(&names(&["環境", "保守・改善"])), OpsPhase::Near("保守・改善".into()));
    assert_eq!(ops_phase_of(&names(&["Design", "DevOps"])), OpsPhase::Near("DevOps".into()));
    assert_eq!(ops_phase_of(&names(&["運用", "保守"])), OpsPhase::Ops);
    let other = names(&["設計", "実装", "その他"]);
    assert_eq!(ops_phase_of(&other), OpsPhase::Other);
    let r = turn_rubric(&other);
    assert!(r.contains("の依頼は `その他`(工程名に「運用」も、それに近い工程名も無いため)"), "{r}");
    assert!(r.contains("要件・仕様を決める工程には、設定・運用の話を入れません"));
    assert_eq!(ops_phase_of(&phases()), OpsPhase::Undecided);
    let r = turn_rubric(&phases());
    assert!(r.contains("の依頼は 上の工程名のうち最も近いもの(工程名に「運用」も「その他」も、それに近い工程名も無いため)"), "{r}");
}

/// ZIP の中の名前と中身(末尾のレコードから中央ディレクトリをたどる)
fn zip_entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]) as usize;
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
    let end = bytes.len() - 22;
    let mut at = u32_at(end + 16);
    let mut out = Vec::new();
    for _ in 0..u16_at(end + 10) {
        let (size, name_len, local) = (u32_at(at + 24), u16_at(at + 28), u32_at(at + 42));
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        out.push((name, bytes[local + 30 + name_len..local + 30 + name_len + size].to_vec()));
        at += 46 + name_len;
    }
    out
}

#[test]
fn turn_zip_has_instructions_manifest_schema_and_chunks() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 8, true);
    let tb = d.path().join("turn-bundle");
    let m = build_turn_bundle(&[&s], &turn_opts(&tb, &snap, phases())).unwrap();
    let names = turn_zip_names(&m);
    assert_eq!(names, ["INSTRUCTIONS.md", "manifest.json", "schema.json", "chunks/0001.md", "chunks/0002.md", "chunks/0003.md"]);
    let zip = d.path().join("turn-bundle.zip");
    let z = write_zip(&tb, &names, &zip, "turn-bundle", DosTime::now(), "絞って").unwrap();
    assert_eq!(z.files, 6);
    let got = zip_entries(&std::fs::read(&zip).unwrap());
    assert_eq!(got.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), names.iter().map(|n| format!("turn-bundle/{n}")).collect::<Vec<_>>());
    // 中身は束のファイルと同じ(parts/ は入れない)
    assert_eq!(got[3].1, std::fs::read(tb.join("chunks").join("0001.md")).unwrap());
    assert!(!got.iter().any(|(n, _)| n.contains("parts/")));
    // 前の版で作った一覧(塊のファイルの場所が無い)でも、並びの番号から決まる
    let mut old = m.clone();
    for c in &mut old.chunks {
        c.path = None;
    }
    assert_eq!(turn_zip_names(&old), names);
}

/// 塊の並び(「セッション ID:依頼番号,…」)
fn chunk_labels<'a>(xs: impl IntoIterator<Item = (&'a str, &'a [i64])>) -> Vec<String> {
    xs.into_iter().map(|(id, turns)| format!("{id}:{}", turns.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(","))).collect()
}

#[test]
fn decidable_turns_come_first_and_last_requests_go_to_the_back() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    // 1 依頼だけのセッション 2 つ(s0・s9)で、8 依頼のセッション s1 を挟む
    let s0 = session_with_turns(&snap, "s0", 1, false);
    let s = session_with_turns(&snap, "s1", 8, true);
    let s9 = session_with_turns(&snap, "s9", 1, false);
    let tb = d.path().join("tb");
    let o = || TurnBundleOptions { limits: Some(atlas_judge::turn_bundle::TurnLimits { part_turns: 6, ..DEFAULT_TURN_LIMITS }), ..turn_opts(&tb, &snap, phases()) };
    let m = build_turn_bundle(&[&s0, &s, &s9], &o()).unwrap();
    // 判定できるのは s1 の依頼 1〜7。最後の依頼(s0 の 1、s1 の 8、s9 の 1)は、渡したセッションの順のまま後ろに並ぶ
    assert_eq!(chunk_labels(m.chunks.iter().map(|c| (c.session_id.as_str(), c.turns.as_slice()))), ["s1:1,2,3,4,5,6", "s1:7", "s0:1", "s1:8", "s9:1"]);
    assert_eq!((m.count, m.decidable), (10, Some(Decidable { turns: 7, chunks: 2, parts: 2 })));
    // 分割ファイルは [s1 の 1〜6] [s1 の 7] と、最後の依頼だけの [s0、s1 の 8、s9]。先頭の 2 ファイルには判定できる依頼だけが入る
    let parts: Vec<String> = m.parts.iter().map(|p| chunk_labels(p.chunks.iter().map(|c| (c.session_id.as_str(), c.turns.as_slice()))).join(" ")).collect();
    assert_eq!(parts, ["s1:1,2,3,4,5,6", "s1:7", "s0:1 s1:8 s9:1"]);
    // 塊の本文の番号(ZIP で渡すときに読ませる)も同じ並び
    assert!(std::fs::read_to_string(tb.join("chunks").join("0001.md")).unwrap().contains("セッション s1"));
    assert!(std::fs::read_to_string(tb.join("chunks").join("0003.md")).unwrap().contains("セッション s0"));
    // manifest.json には count の次に decidable を書く
    let raw = std::fs::read_to_string(tb.join("manifest.json")).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["decidable"], json!({ "turns": 7, "chunks": 2, "parts": 2 }));
    let at = |k: &str| raw.find(&format!("\"{k}\"")).unwrap();
    assert!(at("count") < at("decidable") && at("decidable") < at("unjudgedOnly"));
    // フォルダ(ZIP)ごと渡すときの指示にも、判定できる依頼が先頭のどの塊までかを書く
    let ins = std::fs::read_to_string(tb.join("INSTRUCTIONS.md")).unwrap();
    assert!(ins.contains("先頭の 2 個の塊(`chunks/0001.md`〜`chunks/0002.md`)は、次の依頼がある依頼(採用を判定できる依頼。7 件)です。その後ろの 3 個の塊は、セッションの最後の依頼だけです"), "{ins}");

    // 判定済みを除いた結果、最後の依頼だけが残ったときは、判定できる依頼は 0 件
    let judged: HashMap<String, HashSet<i64>> = [("s1".to_string(), (1..=7).collect())].into_iter().collect();
    let rest = build_turn_bundle(&[&s, &s0], &TurnBundleOptions { judged: Some(judged), ..o() }).unwrap();
    assert_eq!(chunk_labels(rest.chunks.iter().map(|c| (c.session_id.as_str(), c.turns.as_slice()))), ["s1:8", "s0:1"]);
    assert_eq!(rest.decidable, Some(Decidable { turns: 0, chunks: 0, parts: 0 }));
}

#[test]
fn decidable_note_tells_where_the_decidable_turns_end() {
    let some = decidable_note(10, Some(&Decidable { turns: 7, chunks: 2, parts: 2 })).unwrap();
    assert!(some.contains("採用を判定できる依頼(次の依頼がある依頼)は 7 件で、添付ファイル(parts/)の先頭の 2 ファイルと、先頭の 2 個の塊(chunks/0001.md〜chunks/0002.md。ZIP で渡すときの単位)に入れました"), "{some}");
    assert!(some.contains("残りの 3 件はセッションの最後の依頼"));
    assert_eq!(decidable_note(2, Some(&Decidable { turns: 0, chunks: 0, parts: 0 })).as_deref(), Some("2 件はどれもセッションの最後の依頼で、種類と工程だけが決まります(採用は判定不能)"));
    // 全部が判定できる(最後の依頼が判定済みで除かれた、など)・判定する依頼が無い・古い一覧(decidable が無い)
    assert_eq!(decidable_note(7, Some(&Decidable { turns: 7, chunks: 2, parts: 1 })), None);
    assert_eq!(decidable_note(0, Some(&Decidable { turns: 0, chunks: 0, parts: 0 })), None);
    assert_eq!(decidable_note(5, None), None);
}

#[test]
fn rebuild_failure_keeps_previous_bundle() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 8, true);
    let stop = || -> Result<String> { anyhow::bail!("途中で止まった") };
    // 依頼ごとの判定: 一覧の phases(貼った返答の取り込みが工程の名前に使う)も残る
    let tb = d.path().join("tb");
    let first = build_turn_bundle(&[&s], &turn_opts(&tb, &snap, phases())).unwrap();
    let part = std::fs::read_to_string(tb.join("parts").join("part-01.md")).unwrap();
    let e = build_turn_bundle(&[&s], &TurnBundleOptions { boundary: Some(&stop), ..turn_opts(&tb, &snap, vec!["別の工程".into(), "x".into()]) }).unwrap_err();
    assert!(e.to_string().contains("途中で止まった"));
    let m: Value = serde_json::from_str(&std::fs::read_to_string(tb.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(m, serde_json::to_value(&first).unwrap());
    assert_eq!(std::fs::read_to_string(tb.join("parts").join("part-01.md")).unwrap(), part);
    let mut names = atlas_core::jsfs::read_dir_names(&tb).unwrap();
    names.sort();
    assert_eq!(names, ["INSTRUCTIONS.md", "chunks", "manifest.json", "parts", "schema.json"]);

    // 工数の判定: 指定の誤りは何も触る前に止める
    let b = d.path().join("b");
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(b.join("memo.txt"), "利用者が置いたファイル").unwrap();
    let log = |_: &str| {};
    let opts = |boundary: Option<&'static dyn Fn() -> Result<String>>, per_part: Option<usize>| BundleOptions {
        bundle_dir: b.clone(),
        snapshot_dir: Some(snap.clone()),
        limits: None,
        include_empty: false,
        per_part,
        boundary,
        scope: IndexMap::new(),
        log: &log,
        now: None,
        wiki_state: WikiState::Counted,
        wiki_specs: vec![],
    };
    let m = build_bundle(&[&s], &opts(None, None)).unwrap();
    assert!(build_bundle(&[&s], &opts(None, Some(0))).unwrap_err().to_string().contains("perPart"));
    static STOP: fn() -> Result<String> = || anyhow::bail!("途中で止まった");
    assert!(build_bundle(&[&s], &opts(Some(&STOP), None)).unwrap_err().to_string().contains("途中で止まった"));
    let mm: Value = serde_json::from_str(&std::fs::read_to_string(b.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(mm, serde_json::to_value(&m).unwrap());
    assert!(atlas_core::jsfs::join_slash(&b, &m.sessions[0].path).exists());
    assert!(atlas_core::jsfs::join_slash(&b, &m.parts.as_ref().unwrap()[0].path).exists());
    // 作り直せば新しいものに入れ替わる(減ったパケットと分割ファイルは残らない)。出力先にあった別のファイルには触らない
    let again = build_bundle(&[], &opts(None, None)).unwrap();
    assert_eq!(again.count, 0);
    let mut names = atlas_core::jsfs::read_dir_names(&b).unwrap();
    names.sort();
    assert_eq!(names, ["INSTRUCTIONS.md", "manifest.json", "memo.txt", "schema.json", "sessions"]);
    assert!(atlas_core::jsfs::read_dir_names(&b.join("sessions")).unwrap().is_empty());
}
