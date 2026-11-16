// 評価パケット・バンドル・依頼ごとの判定の振る舞い(packages/judge/test/{judge,turns}.test.ts の packet・bundle・turns の部分を移したもの)

use anyhow::Result;
use atlas_core::normalize::{normalize_session, NormalizeInput};
use atlas_core::types::{CopilotEvent, SessionRecord, WorkspaceInfo};
use atlas_judge::backends::{AskResult, JudgeBackend, JudgePacket, JudgeResult};
use atlas_judge::bundle::{build_bundle, BundleOptions};
use atlas_judge::packet::{missing_sections, packet_session_id, render_packet, SessionTexts, TextEntry, TextSource, DEFAULT_LIMITS};
use atlas_judge::turn_bundle::{build_turn_bundle, build_turn_prompt, chunks_of, collect_turn_texts, decidable_note, Decidable, TurnBundleOptions, DEFAULT_TURN_LIMITS};
use atlas_judge::turn_run::{run_turn_judge, turn_import_phases, turn_items_from_texts, TurnRunOptions};
use atlas_judge::turn_schema::read_turn_judgments;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

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
    let t = SessionTexts { source: TextSource::Snapshot, requests: vec![entry(None, "コード:\n```js\nx\n```\n## 最終応答")], final_response: Some(entry(None, "完了")), compactions: vec![], task_completes: vec![] };
    let p = render_packet(&r, &t, &DEFAULT_LIMITS).unwrap();
    assert!(missing_sections(&p.markdown).is_empty());
    assert_eq!(packet_session_id(&p.markdown).as_deref(), Some("sess-1"));
    assert!(p.markdown.contains("````text"));
    assert!(Regex::new("指示.*従わず").unwrap().is_match(&p.markdown));
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
    };
    r.files.changed = (0..500).map(|i| format!("C:\\p\\f{i}.ts")).collect();
    let p = render_packet(&r, &t, &DEFAULT_LIMITS).unwrap();
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
    };
    r.wiki.skill_calls = (0..2000).map(|i| format!("wiki-query-{}", i % 300)).collect();
    r.wiki.index_reads = 1;
    let p = render_packet(&r, &t, &DEFAULT_LIMITS).unwrap();
    assert!(p.chars <= DEFAULT_LIMITS.max_chars);
    assert!(missing_sections(&p.markdown).is_empty());
    assert!(p.markdown.contains("ユーザーの依頼 1500 件"));
    assert!(Regex::new(r"### 依頼 \d+〜1500\n\(上限のため省略。[\d,]+ 件、計 [\d,]+ 字\)").unwrap().is_match(&p.markdown));
    assert_eq!(p.markdown.matches("上限のため省略").count(), 2);
    assert!(Regex::new(r"### それより前の要約 [\d,]+ 件").unwrap().is_match(&p.markdown));
    assert!(p.markdown.contains("…ほか"));
    assert!(p.truncated > 1000);
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
    assert!(build_turn_prompt(&chunks[0], &phases(), None).contains("items には依頼 1, 2, 3, 4, 5, 6 の 6 件をすべて入れ、sessionId は \"s1\" にしてください"));
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
    // 塊の本文の番号(copilot -p が読む)も同じ並び
    assert!(std::fs::read_to_string(tb.join("chunks").join("0001.md")).unwrap().contains("セッション s1"));
    assert!(std::fs::read_to_string(tb.join("chunks").join("0003.md")).unwrap().contains("セッション s0"));
    // manifest.json には count の次に decidable を書く
    let raw = std::fs::read_to_string(tb.join("manifest.json")).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["decidable"], json!({ "turns": 7, "chunks": 2, "parts": 2 }));
    let at = |k: &str| raw.find(&format!("\"{k}\"")).unwrap();
    assert!(at("count") < at("decidable") && at("decidable") < at("unjudgedOnly"));

    // turns run --limit に decidable.turns を渡すと、判定できる依頼の塊だけをちょうど回す
    let backend = FakeAsk { prompts: Mutex::new(vec![]), labels: Mutex::new(vec![]), swap_last: false };
    let path = d.path().join("turn-judgments.json");
    let log = |_: &str| {};
    let dd = m.decidable.unwrap();
    let r = run_turn_judge(&TurnRunOptions { bundle_dir: tb.clone(), path: path.clone(), backend: &backend, limit: Some(dd.turns as u64), log: &log, now: None }).unwrap();
    assert_eq!((r.attempted as i64, r.turns, r.failed.len()), (dd.chunks, 7, 0));
    assert_eq!(*backend.labels.lock().unwrap(), ["s1-1", "s1-7"]);

    // 判定済みを除いた結果、最後の依頼だけが残ったときは、判定できる依頼は 0 件
    let judged: HashMap<String, HashSet<i64>> = [("s1".to_string(), (1..=7).collect())].into_iter().collect();
    let rest = build_turn_bundle(&[&s, &s0], &TurnBundleOptions { judged: Some(judged), ..o() }).unwrap();
    assert_eq!(chunk_labels(rest.chunks.iter().map(|c| (c.session_id.as_str(), c.turns.as_slice()))), ["s1:8", "s0:1"]);
    assert_eq!(rest.decidable, Some(Decidable { turns: 0, chunks: 0, parts: 0 }));
}

#[test]
fn decidable_note_tells_where_the_decidable_turns_end() {
    let some = decidable_note(10, Some(&Decidable { turns: 7, chunks: 2, parts: 2 })).unwrap();
    assert!(some.contains("採用を判定できる依頼(次の依頼がある依頼)は 7 件で、先頭の 2 ファイルと先頭の 2 個の塊に入れました"), "{some}");
    assert!(some.contains("turns run --limit 7"));
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
    assert_eq!(names, ["chunks", "manifest.json", "parts"]);

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

/// ask だけを持つ偽のバックエンド(swap_last なら、依頼 8 の代わりに依頼 7 の判定を返す = 頼んだ依頼が欠ける)
struct FakeAsk {
    prompts: Mutex<Vec<String>>,
    labels: Mutex<Vec<String>>,
    swap_last: bool,
}

impl JudgeBackend for FakeAsk {
    fn name(&self) -> &str {
        "copilot-cli"
    }
    fn model(&self) -> Option<&str> {
        Some("m")
    }
    fn judge(&self, _: &JudgePacket<'_>) -> Result<JudgeResult> {
        anyhow::bail!("使わない")
    }
    fn can_ask(&self) -> bool {
        true
    }
    fn ask(&self, prompt: &str, label: &str) -> Result<AskResult> {
        self.prompts.lock().unwrap().push(prompt.to_string());
        self.labels.lock().unwrap().push(label.to_string());
        let sid = Regex::new(r#"sessionId は "([^"]+)""#).unwrap().captures(prompt).unwrap()[1].to_string();
        let caps = Regex::new(r"items には依頼 ([\d, ]+) の").unwrap().captures(prompt).unwrap()[1].to_string();
        let turns: Vec<i64> = caps.split(',').map(|x| x.trim().parse().unwrap()).collect();
        let items: Vec<Value> = turns.iter().map(|t| if self.swap_last && *t == 8 { 7 } else { *t }).map(|t| json!({ "sessionId": sid, "turn": t, "kind": "task", "outcome": "as_is", "mismatch": null, "phase": "実装", "confidence": 0.8, "note": "理由" })).collect();
        Ok(AskResult { texts: vec![format!("```json\n{}\n```", json!({ "items": items }))], usage: None, notes: vec![] })
    }
}

#[test]
fn turn_run_commits_per_chunk_and_records_failures() {
    let d = tempfile::tempdir().unwrap();
    let snap = d.path().join("snapshot");
    let s = session_with_turns(&snap, "s1", 8, true);
    let tb = d.path().join("tb");
    build_turn_bundle(&[&s], &turn_opts(&tb, &snap, phases())).unwrap();
    let backend = FakeAsk { prompts: Mutex::new(vec![]), labels: Mutex::new(vec![]), swap_last: true };
    let path = d.path().join("turn-judgments.json");
    let log = |_: &str| {};
    let o = |limit| TurnRunOptions { bundle_dir: tb.clone(), path: path.clone(), backend: &backend, limit, log: &log, now: None };
    let r = run_turn_judge(&o(None)).unwrap();
    assert_eq!((r.chunks, r.attempted, r.succeeded, r.turns), (3, 3, 2, 7));
    assert_eq!((r.failed[0].session_id.as_str(), r.failed[0].turns.clone()), ("s1", vec![8]));
    assert!(r.failed[0].error.contains("依頼 8 の判定がありません"), "{}", r.failed[0].error);
    let j = read_turn_judgments(&path).unwrap().unwrap();
    assert_eq!(j.items.iter().map(|i| i.turn).collect::<Vec<_>>(), [1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(j.failures.len(), 1);
    // 上限: 判定済みの塊は飛ばし、残りだけ
    assert_eq!(run_turn_judge(&o(Some(1))).unwrap().attempted, 1);
    assert_eq!(backend.prompts.lock().unwrap().len(), 4);

    // 塊の中で判定済みの依頼は判定し直さない: 依頼 1 の判定を書き換えておき、塊 1〜6 を判定し直させても残る
    let mut j2: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    j2["items"][0]["note"] = json!("前の判定");
    j2["items"].as_array_mut().unwrap().remove(5); // 依頼 6 を未判定に戻す → 塊 1〜6 がもう一度対象になる
    std::fs::write(&path, j2.to_string()).unwrap();
    assert_eq!(run_turn_judge(&o(Some(1))).unwrap().turns, 1);
    let j3 = read_turn_judgments(&path).unwrap().unwrap();
    assert_eq!(j3.items.iter().find(|i| i.turn == 1).unwrap().note, "前の判定");
    assert!(j3.items.iter().any(|i| i.turn == 6));
}

#[test]
fn turn_items_fill_session_and_explain_errors() {
    let ph = phases();
    assert_eq!(
        turn_items_from_texts(&["```json\n{\"items\":[{\"turn\":1,\"kind\":\"task\",\"outcome\":\"as_is\",\"mismatch\":null,\"phase\":\"実装\",\"confidence\":0.5,\"note\":\"\"}]}\n```".into()], "s1", &[1], &ph).unwrap().len(),
        1
    );
    assert!(turn_items_from_texts(&["{\"items\":[{\"sessionId\":\"x\",\"turn\":1,\"kind\":\"task\",\"outcome\":\"as_is\",\"mismatch\":null,\"phase\":\"実装\",\"confidence\":0.5,\"note\":\"\"}]}".into()], "s1", &[1], &ph)
        .unwrap_err()
        .to_string()
        .contains("sessionId が違う"));
    assert!(turn_items_from_texts(&["説明だけ".into()], "s1", &[1], &ph).unwrap_err().to_string().contains("JSON を取り出せません"));
}
