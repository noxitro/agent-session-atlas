//! report の lib の振る舞い(packages/report/test の report-lib・phase6・phase7・tool-failure-causes・pack の lib の部分を移したもの)。
//! セッションは normalize_session で架空のイベントから作る。値はすべて架空のもの

use atlas_core::metrics::compute_metrics;
use atlas_core::normalize::{normalize_session, DbInput, NormalizeInput};
use atlas_core::types::{CopilotEvent, SessionRecord, TodoSummary, WorkspaceInfo};
use atlas_report::aggregate::*;
use atlas_report::anonymize::{create_anonymizer, identity_anonymizer, AnonSource};
use atlas_report::embed::{embed_data, extract_embedded};
use atlas_report::exec::{exec_aggregate, quantiles_of, tool_share, QuantileRow};
use atlas_report::filter::*;
use atlas_report::highlights::{highlights, HighlightOptions, InstalledView};
use atlas_report::pack::{pack_summary, unpack_data, unpack_summary};
use atlas_report::summarize::{permission_group, summarize};
use atlas_report::types::{JudgmentSummary, SessionSummary};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn ev(kind: &str, data: Value, ts: &str) -> CopilotEvent {
    let n = N.fetch_add(1, Ordering::SeqCst);
    CopilotEvent { kind: kind.into(), data: Some(data), id: Some(json!(format!("e{n}"))), timestamp: Some(json!(ts)), parent_id: None, agent_id: None }
}

/// base から ms 後の ISO
fn at(base: &str, ms: i64) -> String {
    atlas_core::jsdate::to_iso(atlas_core::jsdate::parse_ms(base).unwrap() + ms)
}

#[derive(Default)]
struct Ws<'a> {
    client: Option<&'a str>,
    repository: Option<&'a str>,
    cwd: Option<&'a str>,
    branch: Option<&'a str>,
    created_at: Option<&'a str>,
    name: Option<&'a str>,
}

fn norm(id: &str, ws: Option<Ws>, events: Vec<CopilotEvent>) -> SessionRecord {
    let w = ws.map(|w| WorkspaceInfo {
        client_name: w.client.map(Into::into),
        repository: w.repository.map(Into::into),
        cwd: w.cwd.map(Into::into),
        branch: w.branch.map(Into::into),
        created_at: w.created_at.map(Into::into),
        name: w.name.map(Into::into),
        ..Default::default()
    });
    let mut it = events.into_iter().map(Ok);
    normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: w.as_ref(), db: DbInput::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
}

fn summaries(rs: &[SessionRecord]) -> Vec<SessionSummary> {
    rs.iter().map(|r| summarize(r, &identity_anonymizer(), None)).collect()
}

fn ids(xs: &[&SessionSummary]) -> Vec<String> {
    xs.iter().map(|s| s.id.clone()).collect()
}

fn refs(xs: &[SessionSummary]) -> Vec<&SessionSummary> {
    xs.iter().collect()
}

// ---------- report-lib.test.ts ----------

fn with_input(id: &str, ws: Ws, model: &str, input: f64, output: f64) -> SessionRecord {
    let t = ws.created_at.unwrap().to_string();
    norm(
        id,
        Some(ws),
        vec![
            ev("user.message", json!({ "content": format!("依頼 {id} C:\\work\\secret-proj\\src を直して") }), &t),
            ev("tool.execution_start", json!({ "toolName": "view" }), &t),
            ev("session.usage_record", json!({ "usage": { "model": model, "inputTokens": input, "outputTokens": output, "cost": 1, "initiator": "user" } }), &t),
        ],
    )
}

fn output_only(id: &str, ws: Ws, model: &str, output: f64) -> SessionRecord {
    let t = ws.created_at.unwrap().to_string();
    norm(id, Some(ws), vec![ev("assistant.message", json!({ "model": model, "outputTokens": output }), &t)])
}

fn fixture() -> Vec<SessionRecord> {
    vec![
        with_input("a", Ws { client: Some("github/cli"), repository: Some("quokka/secret-proj"), cwd: Some("C:\\work\\secret-proj"), branch: Some("feature/x1"), created_at: Some("2026-07-10T03:00:00Z"), name: Some("secret-proj の修正") }, "gpt-5.5", 100.0, 10.0),
        with_input("b", Ws { client: Some("github/autopilot"), cwd: Some("/home/me/.copilot/chats/c1"), created_at: Some("2026-09-02T03:00:00Z"), ..Default::default() }, "claude-sonnet-5", 50.0, 5.0),
        output_only("c", Ws { client: Some("github/cli"), repository: Some("quokka/secret-proj"), cwd: Some("C:\\work\\secret-proj"), branch: Some("main"), created_at: Some("2026-09-20T03:00:00Z"), ..Default::default() }, "gpt-5.5", 7.0),
        norm("d", Some(Ws { cwd: Some("D:\\other"), created_at: Some("2026-10-01T00:00:00Z"), ..Default::default() }), vec![ev("user.message", json!({ "content": "x" }), "2026-10-01T00:00:00Z")]),
    ]
}

fn with_people(rs: &mut [SessionRecord]) {
    for r in rs {
        r.person = Some(match r.id.as_str() {
            "a" | "c" => Some("person-a".into()),
            "b" => Some("person-b".into()),
            _ => None,
        });
    }
}

#[test]
fn aggregate_updated_at_is_latest_update() {
    let base = summaries(&fixture()).remove(0);
    let s = |id: &str, project: &str, c: Option<&str>, u: Option<&str>| SessionSummary { id: id.into(), project: project.into(), project_label: project.into(), created_at: c.map(Into::into), updated_at: u.map(Into::into), ..base.clone() };
    let xs = vec![
        s("a1", "app", Some("2026-11-01T00:00:00.000Z"), Some("2026-11-12T09:00:00.000Z")),
        s("a2", "app", Some("2026-11-10T00:00:00.000Z"), Some("2026-11-10T01:00:00.000Z")),
        s("b1", "tool", Some("2026-11-05T00:00:00.000Z"), None),
        s("c1", "web", Some("2026-11-01T00:00:00.000Z"), Some("2026-11-13T08:00:00+09:00")),
        s("c2", "web", Some("2026-11-01T00:00:00.000Z"), Some("2026-11-12T23:30:00.000Z")),
    ];
    let a = aggregate(&refs(&xs), None);
    let by = |k: &str| a.by_project.iter().find(|b| b.key == k).map(|b| (b.updated_at.clone().unwrap(), b.last_at.clone().unwrap())).unwrap();
    assert_eq!(by("app"), ("2026-11-12T09:00:00.000Z".into(), "2026-11-10T00:00:00.000Z".into()));
    assert_eq!(by("tool"), ("2026-11-05T00:00:00.000Z".into(), "2026-11-05T00:00:00.000Z".into()));
    assert_eq!(by("web"), ("2026-11-12T23:30:00.000Z".into(), "2026-11-01T00:00:00.000Z".into()));
    assert_eq!(a.overall.updated_at.as_deref(), Some("2026-11-12T23:30:00.000Z"));
}

#[test]
fn aggregate_matches_core_metrics() {
    let rs = fixture();
    let m = compute_metrics(&rs.iter().collect::<Vec<_>>(), None);
    let ss = summaries(&rs);
    let a = aggregate(&refs(&ss), None);
    assert_eq!(a.overall.sessions, m.overall.sessions);
    assert_eq!(a.overall.sessions_with_input, m.overall.sessions_with_input_tokens);
    assert_eq!(serde_json::to_value(&a.overall.tokens).unwrap(), serde_json::to_value(&m.overall.tokens).unwrap());
    assert_eq!(a.overall.tools, m.overall.tools.total);
    assert_eq!(a.overall.turns, m.overall.turns);
    for b in &a.by_project {
        assert_eq!(b.tokens.output, m.by_project[&b.key].tokens.output);
    }
    // 記録の無い月(2026-08)も 0 として並ぶ
    assert_eq!(a.by_month.iter().map(|b| (b.key.as_str(), b.sessions)).collect::<Vec<_>>(), [("2026-07", 1), ("2026-08", 0), ("2026-09", 2), ("2026-10", 1)]);
    for r in &a.by_model {
        let x = &m.by_model[&r.model];
        assert_eq!((r.sessions, r.input, r.output), (x.sessions, x.input, x.output));
    }
}

#[test]
fn aggregate_by_person() {
    let mut rs = fixture();
    assert!(aggregate(&refs(&summaries(&rs)), None).by_person.is_empty());
    with_people(&mut rs);
    let ss = summaries(&rs);
    let a = aggregate(&refs(&ss), None);
    assert_eq!(
        a.by_person.iter().map(|b| (b.key.as_str(), b.label.as_str(), b.sessions, b.tokens.output)).collect::<Vec<_>>(),
        [("person-a", "person-a", 2, 17.0), ("person-b", "person-b", 1, 5.0), (UNKNOWN, "不明", 1, 0.0)]
    );
    let unknown_only = apply_filter(&ss, &FilterState { person: UNKNOWN.into(), ..empty_filter() });
    assert!(aggregate(&unknown_only, None).by_person.is_empty());
    assert_eq!(aggregate(&unknown_only, Some(true)).by_person.iter().map(|b| (b.key.as_str(), b.sessions)).collect::<Vec<_>>(), [(UNKNOWN, 1)]);
    assert!(aggregate(&refs(&ss), Some(false)).by_person.is_empty());
}

#[test]
fn coverage_and_month_range() {
    let ss = summaries(&fixture());
    let c = coverage_breakdown(&refs(&ss));
    assert_eq!((c.detailed, c.shutdown, c.output_only, c.none, c.empty), (2, 0, 1, 1, 0));
    assert_eq!(month_range("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
}

#[test]
fn filter_axes() {
    let s = summaries(&fixture());
    let f = empty_filter();
    let q = |g: FilterState| ids(&apply_filter(&s, &g));
    assert_eq!(apply_filter(&s, &f).len(), 4);
    assert_eq!(q(FilterState { project: "quokka/secret-proj".into(), ..f.clone() }), ["a", "c"]);
    assert_eq!(q(FilterState { client: "github/cli".into(), ..f.clone() }), ["a", "c"]);
    assert_eq!(q(FilterState { client: UNKNOWN.into(), ..f.clone() }), ["d"]);
    assert_eq!(q(FilterState { model: "gpt-5.5".into(), ..f.clone() }), ["a", "c"]);
    assert_eq!(q(FilterState { model: UNKNOWN.into(), ..f.clone() }), ["d"]);
    assert_eq!(q(FilterState { branch: "main".into(), ..f.clone() }), ["c"]);
    assert_eq!(q(FilterState { coverage: "input".into(), ..f.clone() }), ["a", "b"]);
    assert_eq!(q(FilterState { coverage: "output-only".into(), ..f.clone() }), ["c"]);
    assert_eq!(q(FilterState { coverage: "none".into(), ..f.clone() }), ["d"]);
    assert_eq!(q(FilterState { from: "2026-09-01".into(), to: "2026-09-30".into(), ..f.clone() }), ["b", "c"]);
    assert_eq!(q(FilterState { project: "quokka/secret-proj".into(), coverage: "input".into(), ..f.clone() }), ["a"]);
}

#[test]
fn filter_people_and_hash() {
    let mut rs = fixture();
    let plain = summaries(&rs);
    assert!(!has_people(&plain));
    assert!(filter_options(&plain).person.is_empty());
    assert!(apply_filter(&plain, &FilterState { person: "person-a".into(), ..empty_filter() }).is_empty());
    with_people(&mut rs);
    let s = summaries(&rs);
    let f = empty_filter();
    assert_eq!(ids(&apply_filter(&s, &FilterState { person: "person-a".into(), ..f.clone() })), ["a", "c"]);
    assert_eq!(ids(&apply_filter(&s, &FilterState { person: UNKNOWN.into(), ..f.clone() })), ["d"]);
    assert_eq!(ids(&apply_filter(&s, &FilterState { person: "person-a".into(), coverage: "input".into(), ..f.clone() })), ["a"]);
    assert_eq!(
        filter_options(&s).person.iter().map(|o| (o.value.as_str(), o.count)).collect::<Vec<_>>(),
        [("person-a", 2), (UNKNOWN, 1), ("person-b", 1)]
    );
    let g = FilterState { person: "架空 太郎".into(), project: "a/b".into(), ..f.clone() };
    assert!(encode_filter(&g).contains("person="));
    assert_eq!(decode_filter(&format!("#{}", encode_filter(&g))), g);
    assert!(!is_empty_filter(&FilterState { person: "person-a".into(), ..f }));
}

#[test]
fn empty_sessions_are_excluded_by_default() {
    let mut rs = fixture();
    rs.push(norm("z", Some(Ws { cwd: Some("D:\\other"), created_at: Some("2026-10-02T00:00:00Z"), ..Default::default() }), vec![]));
    let s = summaries(&rs);
    assert!(s.iter().find(|x| x.id == "z").unwrap().empty);
    assert_eq!(ids(&apply_filter(&s, &empty_filter())), ["a", "b", "c", "d"]);
    let inc = FilterState { empty: "1".into(), ..empty_filter() };
    assert_eq!(apply_filter(&s, &inc).len(), 5);
    assert_eq!(encode_filter(&inc), "empty=1");
    assert_eq!(decode_filter("#empty=1").empty, "1");
    assert_eq!(decode_filter("#empty=yes").empty, "");
    let c = coverage_breakdown(&apply_filter(&s, &inc));
    assert_eq!((c.detailed, c.output_only, c.none, c.empty), (2, 1, 1, 1));
    let m = compute_metrics(&rs.iter().collect::<Vec<_>>(), None);
    assert_eq!(m.empty_sessions, 1);
    assert_eq!(aggregate(&apply_filter(&s, &empty_filter()), None).overall.sessions, m.overall.sessions);
    assert_eq!(aggregate(&apply_filter(&s, &inc), None).overall.empty_sessions, 1);
}

#[test]
fn judgments_and_task_category() {
    let rs = fixture();
    let j = JudgmentSummary { task_category: Some("bugfix".into()), hours: Some(2.0), low: Some(1.0), high: Some(3.0), confidence: Some(0.5), task_summary: Some("修正".into()), rationale: Some("根拠".into()), backend: Some("external".into()), ..Default::default() };
    let s: Vec<SessionSummary> = rs.iter().map(|r| summarize(r, &identity_anonymizer(), (r.id == "a").then_some(&j))).collect();
    assert_eq!(ids(&apply_filter(&s, &FilterState { task_category: "bugfix".into(), ..empty_filter() })), ["a"]);
    assert_eq!(apply_filter(&s, &FilterState { task_category: NO_JUDGMENT.into(), ..empty_filter() }).len(), 3);
    let o = aggregate(&refs(&s), None).overall;
    assert_eq!((o.judged_sessions, o.human_hours, o.human_low, o.human_high, o.judged_confidence), (1, 2.0, 1.0, 3.0, Some(0.5)));
    let a = s.iter().find(|x| x.id == "a").unwrap();
    assert_eq!(o.judged_ai.output, a.tokens.output);
    assert_eq!(o.judged_ai.active_ms, a.active_ms.unwrap_or(0.0));
    // HTML 本体に埋め込む要約には根拠(自由記述)を入れない
    assert_eq!(a.judgment.as_ref().unwrap().rationale, None);
}

#[test]
fn filter_options_order() {
    let o = filter_options(&summaries(&fixture()));
    assert_eq!((o.project[0].value.as_str(), o.project[0].count), ("quokka/secret-proj", 2));
    assert_eq!(o.client.iter().map(|x| x.value.as_str()).collect::<Vec<_>>(), ["github/cli", "(unknown)", "github/autopilot"]);
    assert_eq!(o.model.iter().find(|x| x.value == "gpt-5.5").unwrap().count, 2);
}

#[test]
fn hash_round_trip_and_ids() {
    let f = FilterState { project: "a/b c".into(), coverage: "none".into(), from: "2026-01-01".into(), ..empty_filter() };
    assert_eq!(decode_filter(&format!("#{}", encode_filter(&f))), f);
    assert!(is_empty_filter(&decode_filter("#coverage=bogus&unknown=1&project=%E0%A4")));
    assert_eq!(encode_filter(&empty_filter()), "");

    let s = summaries(&fixture());
    let f = FilterState { ids: "a,c,zzz".into(), ..empty_filter() };
    assert_eq!(ids(&apply_filter(&s, &f)), ["a", "c"]);
    assert_eq!(ids(&apply_filter(&s, &FilterState { coverage: "input".into(), ..f.clone() })), ["a"]);
    assert!(apply_filter(&s, &FilterState { ids: "zzz".into(), ..empty_filter() }).is_empty());
    assert_eq!(encode_filter(&f), "ids=a,c,zzz");
    assert_eq!(decode_filter("#ids=a,c,zzz"), f);
    assert_eq!(decode_filter("#ids=c,%20a,,c&project=p").ids, "c,a");
    let many: Vec<String> = (0..200).map(|i| format!("00000000-0000-4000-8000-{i:012}")).collect();
    let h = encode_filter(&FilterState { ids: join_ids(many.iter().map(String::as_str)), ..empty_filter() });
    assert!(h.len() < 8 * 1024);
    assert_eq!(split_ids(&decode_filter(&format!("#{h}")).ids), many);
    assert!(same_ids("a,b", "b,a"));
    assert!(!same_ids("a,b", "a"));
}

#[test]
fn groups_in_filter() {
    use atlas_report::groups::SessionGroup;
    let s = summaries(&fixture());
    let known: HashSet<String> = s.iter().map(|x| x.id.clone()).collect();
    let f = FilterState { group: "調査 1".into(), ids: "a,b".into(), ..empty_filter() };
    assert_eq!(encode_filter(&f), "ids=a,b&group=%E8%AA%BF%E6%9F%BB%201");
    assert_eq!(decode_filter(&format!("#{}", encode_filter(&f))), f);
    assert_eq!(decode_filter("#group=%20x%20").group, "x");
    let g = |name: &str, ids: &[&str]| SessionGroup { name: name.into(), note: String::new(), ids: ids.iter().map(|x| x.to_string()).collect() };
    let groups = vec![g("調査 1", &["c", "zzz"]), g("空", &[]), g("無い", &["zzz"])];
    let e = effective_ids(&f.ids, &f.group, &groups, &known);
    assert_eq!((e.group.map(|x| x.name.as_str()), e.ids.as_str()), (Some("調査 1"), "c"));
    assert_eq!(ids(&apply_filter(&s, &FilterState { ids: e.ids.clone(), ..f.clone() })), ["c"]);
    let e = effective_ids("a,b", "相手に無い", &groups, &known);
    assert_eq!((e.group.is_none(), e.ids.as_str()), (true, "a,b"));
    assert_eq!(group_ids(&groups[1].ids, &known), NO_SESSION);
    assert_eq!(group_ids(&groups[2].ids, &known), "zzz");
    assert!(apply_filter(&s, &FilterState { ids: NO_SESSION.into(), ..empty_filter() }).is_empty());

    for name in ["a&b", "x=y", "100%", "#1", "p,q", "c+d", "& = % # , +"] {
        let f = FilterState { group: name.into(), ids: "a".into(), ..empty_filter() };
        let h = encode_filter(&f);
        assert_eq!(decode_filter(&format!("#{h}")), f);
        assert_eq!(decode_filter(&format!("#{h}&project=p")), FilterState { project: "p".into(), ..f });
    }
    assert_eq!(decode_filter(&format!("#ids=a,{NO_SESSION},zzz")).ids, format!("a,{NO_SESSION},zzz"));
    assert_eq!(known_selection(&format!("a,{NO_SESSION},zzz,b"), &known), ["a", "b"]);
    let groups = vec![g("A", &[]), g("B", &[]), g("C", &["a", "b"]), g("D", &["b", "a", "zzz"]), g("E", &["c"])];
    assert_eq!(current_group_name("c", "E", &groups, &known).as_deref(), Some("E"));
    assert_eq!(current_group_name("c", "", &groups, &known).as_deref(), Some("E"));
    assert_eq!(current_group_name("c", "相手に無い", &groups, &known).as_deref(), Some("E"));
    assert_eq!(current_group_name(NO_SESSION, "", &groups, &known), None);
    assert_eq!(current_group_name(NO_SESSION, "B", &groups, &known).as_deref(), Some("B"));
    assert_eq!(current_group_name("a,b", "", &groups, &known), None);
    assert_eq!(current_group_name("a,b", "D", &groups, &known).as_deref(), Some("D"));
    assert_eq!(current_group_name("", "", &groups, &known), None);
}

#[test]
fn anonymized_summaries() {
    let mut rs = fixture();
    let anon = create_anonymizer(&rs.iter().map(AnonSource::from).collect::<Vec<_>>());
    let s: Vec<SessionSummary> = rs.iter().map(|r| summarize(r, &anon, None)).collect();
    assert_eq!(s.iter().map(|x| x.project.as_str()).collect::<Vec<_>>(), ["project-03", "project-02", "project-03", "project-01"]);
    assert_eq!(s.iter().map(|x| x.branch.as_deref()).collect::<Vec<_>>(), [Some("branch-01"), None, Some("branch-02"), None]);
    assert!(s.iter().all(|x| x.name.is_none() && x.first_user_message.is_none()));
    let text = atlas_core::json::to_js_string(&s).unwrap();
    for secret in ["secret-proj", "quokka", "feature/x1", "C:\\\\work", ".copilot", "D:\\\\other"] {
        assert!(!text.contains(secret), "{secret}");
    }
    assert_eq!(anon.scrub("failed at C:\\work\\secret-proj\\src\\a.ts in secret-proj on feature/x1"), "failed at <path> in project-03 on branch-01");
    with_people(&mut rs);
    let anon = create_anonymizer(&rs.iter().map(AnonSource::from).collect::<Vec<_>>());
    assert_eq!(rs.iter().map(|r| summarize(r, &anon, None).person).collect::<Vec<_>>(), [Some("person-01".to_string()), Some("person-02".into()), Some("person-01".into()), None]);
}

#[test]
fn embed_round_trip_with_pack() {
    let pack_events = |at0: &str| {
        vec![
            ev("session.start", json!({ "context": { "cwd": "X:\\p" }, "selectedModel": "gpt-5.5" }), at0),
            ev("user.message", json!({ "content": "ボタンを足して" }), &at(at0, 1000)),
            ev("tool.execution_start", json!({ "toolCallId": "c1", "toolName": "view", "arguments": { "path": "a" } }), &at(at0, 1100)),
            ev("tool.execution_complete", json!({ "toolCallId": "c1", "success": false }), &at(at0, 1200)),
            ev("abort", json!({ "reason": "user" }), &at(at0, 1300)),
            ev("user.message", json!({ "content": "違う、右に" }), &at(at0, 2000)),
            ev("assistant.message", json!({ "content": "直しました", "outputTokens": 0 }), &at(at0, 2100)),
        ]
    };
    let t0 = "2026-11-08T00:00:00.000Z";
    let empty = norm("empty-1", None, vec![ev("session.start", json!({ "context": { "cwd": "X:\\p" } }), t0)]);
    let busy = norm("busy-1", None, pack_events(t0));
    let ss = summaries(&[empty, busy]);
    let round = |s: &SessionSummary| unpack_summary(&atlas_core::js::parse_json(&atlas_core::json::to_js_string(&pack_summary(s)).unwrap()).unwrap()).unwrap();
    for s in &ss {
        assert_eq!(&round(s), s);
    }
    let packed = pack_summary(&ss[0]);
    for k in ["href", "tools", "friction"] {
        assert!(packed.get(k).is_none(), "{k}");
    }
    assert!(atlas_core::json::to_js_string(&packed).unwrap().len() < atlas_core::json::to_js_string(&ss[0]).unwrap().len() / 3);

    // 既定値と違う値は 0 も null も残す
    let mut s = ss[1].clone();
    s.tokens.output = 0.0;
    s.tokens.input = Some(5.0);
    s.active_ms = Some(0.0);
    let p = pack_summary(&s);
    assert_eq!((p["tokens"]["output"].as_f64(), p["tokens"]["input"].as_f64(), p["activeMs"].as_f64()), (Some(0.0), Some(5.0), Some(0.0)));
    assert_eq!(round(&s), s);
    // 人のフォルダの名前は付いているときだけ残す
    assert!(pack_summary(&ss[1]).get("person").is_none());
    let s = SessionSummary { person: Some("person-a".into()), ..ss[1].clone() };
    assert_eq!(pack_summary(&s)["person"], "person-a");
    assert_eq!(round(&s), s);
    // 入れ子の一部だけ既定値と違えば、その項目だけ残す
    let f = pack_summary(&ss[1])["friction"].as_object().unwrap().clone();
    assert!(!f.is_empty() && f.values().all(|n| n.as_f64() != Some(0.0)));

    let data = json!({ "version": 9, "sessions": ss.iter().map(pack_summary).collect::<Vec<_>>() });
    let tpl = r#"<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>"#;
    let html = embed_data(tpl, &data).unwrap();
    let back = extract_embedded(&html).unwrap();
    assert_eq!(back["version"], 9);
    assert_eq!(serde_json::from_value::<Vec<SessionSummary>>(back["sessions"].clone()).unwrap(), ss);
    assert_eq!(unpack_data(json!({ "version": 9, "groups": [] })), json!({ "version": 9, "groups": [] }));
}

// ---------- phase6.test.ts ----------

fn call(id: &str, tool: &str, result: Option<&str>, extra: Value, ts: &mut i64) -> Vec<CopilotEvent> {
    let base = "2026-10-01T00:00:00Z";
    let mut data = json!({ "toolCallId": id, "toolName": tool, "arguments": {} });
    if let (Some(d), Some(e)) = (data.as_object_mut(), extra.as_object()) {
        d.extend(e.clone());
    }
    *ts += 1000;
    let start = ev("tool.execution_start", data, &at(base, *ts));
    let Some(r) = result else { return vec![start] };
    let done = match r {
        "ok" => json!({ "toolCallId": id, "success": true }),
        "deny" => json!({ "toolCallId": id, "success": false, "error": { "code": "denied" } }),
        msg => json!({ "toolCallId": id, "success": false, "error": { "code": "failure", "message": msg } }),
    };
    *ts += 1000;
    vec![start, ev("tool.execution_complete", done, &at(base, *ts))]
}

fn phase6() -> Vec<SessionRecord> {
    let base = "2026-10-01T00:00:00Z";
    let mut t = 0;
    let e = |kind: &str, data: Value, t: &mut i64| {
        *t += 1000;
        ev(kind, data, &at(base, *t))
    };
    let mut a = vec![e("user.message", json!({ "content": "a" }), &mut t)];
    a.extend(call("1", "gh-search", Some("ok"), json!({ "mcpServerName": "gh" }), &mut t));
    a.extend(call("2", "gh-get", Some("fail"), json!({ "mcpServerName": "gh" }), &mut t));
    a.extend(call("3", "view", Some("ok"), json!({}), &mut t));
    a.extend(call("4", "view", Some("deny"), json!({}), &mut t));
    a.extend(call("5", "view", None, json!({}), &mut t));
    a.push(e("skill.invoked", json!({ "name": "wiki-query", "trigger": "user-invoked" }), &mut t));
    a.push(e("subagent.started", json!({ "toolCallId": "s1", "agentName": "explore" }), &mut t));
    a.push(e("subagent.completed", json!({ "toolCallId": "s1", "agentName": "explore", "totalTokens": 500 }), &mut t));
    a.push(e("hook.start", json!({ "hookType": "preToolUse" }), &mut t));
    a.push(e("hook.start", json!({ "hookType": "preToolUse" }), &mut t));
    a.push(e("session.shutdown", json!({ "codeChanges": { "linesAdded": 12, "linesRemoved": 4, "filesModified": [] } }), &mut t));
    let mut b = vec![e("user.message", json!({ "content": "b" }), &mut t)];
    b.extend(call("1", "view", Some("ok"), json!({}), &mut t));
    b.extend(call("2", "gh-search", Some("ok"), json!({ "mcpServerName": "gh" }), &mut t));
    b.push(e("tool.execution_start", json!({ "toolCallId": "3", "toolName": "skill", "arguments": { "skill": "wiki-query" } }), &mut t));
    b.push(e("subagent.started", json!({ "toolCallId": "s1", "agentName": "explore" }), &mut t));
    b.push(e("subagent.failed", json!({ "toolCallId": "s1", "agentName": "explore" }), &mut t));
    b.push(e("hook.start", json!({ "hookType": "postToolUse" }), &mut t));
    vec![
        norm("a", Some(Ws { repository: Some("quokka/a"), client: Some("github/cli"), created_at: Some("2026-10-01T00:00:00Z"), ..Default::default() }), a),
        norm("b", Some(Ws { repository: Some("quokka/b"), client: Some("github/autopilot"), created_at: Some("2026-10-02T00:00:00Z"), ..Default::default() }), b),
    ]
}

#[test]
fn summarize_phase6_shape() {
    let s = summarize(&phase6()[0], &identity_anonymizer(), None);
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["tools"]["mcp"], json!({ "gh": { "gh-search": 1, "gh-get": 1 } }));
    assert_eq!(v["tools"]["issues"], json!({ "gh-get": [1, 0, 1], "view": [0, 1, 2] }));
    assert_eq!(v["skills"], json!({ "wiki-query": [1, 0, 0] }));
    assert_eq!(atlas_core::json::to_js_string(&s.agents.by_name).unwrap(), r#"{"explore":[1,0,500]}"#);
    assert_eq!(v["hooks"], json!({ "total": 2, "byType": { "preToolUse": 2 } }));
    assert_eq!(atlas_core::json::to_js_string(&s.lines).unwrap(), r#"{"added":12,"removed":4,"source":"shutdown"}"#);
    assert_eq!(v["projectSource"], "repository");
}

#[test]
fn usage_ranking_rows() {
    let ss = summaries(&phase6());
    let u = usage_ranking(&refs(&ss));
    assert_eq!(
        u.tools.iter().map(|t| (t.key.as_str(), t.calls, t.completed, t.success, t.failure, t.denied, t.sessions)).collect::<Vec<_>>(),
        [("view", 4, 3, 2, 0, 1, 2), ("mcp:gh", 3, 3, 2, 1, 0, 2), ("skill", 1, 0, 0, 0, 0, 1)]
    );
    assert_eq!((u.tools[1].label.as_str(), u.tools[1].mcp_server.as_deref()), ("gh", Some("gh")));
    assert!((failure_rate(u.tools[0].completed, u.tools[0].failure, u.tools[0].denied).unwrap() - 1.0 / 3.0).abs() < 1e-12);
    assert_eq!(failure_rate(u.tools[2].completed, u.tools[2].failure, u.tools[2].denied), None);
    assert_eq!(
        atlas_core::json::to_js_string(&u.mcp).unwrap(),
        r#"[{"server":"gh","calls":3,"completed":3,"failure":1,"denied":0,"sessions":2,"tools":[{"name":"gh-search","calls":2,"failure":0,"causes":{}},{"name":"gh-get","calls":1,"failure":1,"causes":{"other":1}}]}]"#
    );
    assert_eq!(atlas_core::json::to_js_string(&u.skills).unwrap(), r#"[{"name":"wiki-query","uses":2,"user":1,"agent":1,"unknown":0,"sessions":2}]"#);
    assert_eq!(atlas_core::json::to_js_string(&u.agents).unwrap(), r#"[{"name":"explore","runs":2,"failed":1,"tokens":500,"sessions":2}]"#);
    assert_eq!(atlas_core::json::to_js_string(&u.hooks).unwrap(), r#"[{"name":"preToolUse","count":2,"sessions":1},{"name":"postToolUse","count":1,"sessions":1}]"#);

    let only = aggregate(&apply_filter(&ss, &FilterState { project: "quokka/b".into(), ..empty_filter() }), None);
    assert_eq!(only.usage.tools.iter().map(|t| (t.key.as_str(), t.calls)).collect::<Vec<_>>(), [("mcp:gh", 1), ("skill", 1), ("view", 1)]);
    assert_eq!(atlas_core::json::to_js_string(&only.usage.agents).unwrap(), r#"[{"name":"explore","runs":1,"failed":1,"tokens":0,"sessions":1}]"#);
    assert_eq!((only.overall.lines_added, only.overall.lines_removed, only.overall.sessions_with_lines), (0.0, 0.0, 0));
    let all = aggregate(&refs(&ss), None);
    assert_eq!((all.overall.lines_added, all.overall.lines_removed, all.overall.sessions_with_lines), (12.0, 4.0, 1));
    let inst: Vec<String> = ["Wiki-Query", "impeccable", "pptx"].map(String::from).to_vec();
    assert_eq!(unused_skills(&inst, ["wiki-query", "other"]), ["impeccable", "pptx"]);
    assert!(unused_skills(&[], ["x"]).is_empty());
}

// ---------- phase7.test.ts ----------

fn calls(prefix: &str, tool: &str, n: i64, fail: i64, at0: i64, ms: i64, base: &str) -> Vec<CopilotEvent> {
    let mut out = Vec::new();
    for i in 0..n {
        out.push(ev("tool.execution_start", json!({ "toolCallId": format!("{prefix}{i}"), "toolName": tool }), &at(base, at0 + i * 1000)));
        let done = if i < fail { json!({ "toolCallId": format!("{prefix}{i}"), "success": false, "error": { "code": "failure" } }) } else { json!({ "toolCallId": format!("{prefix}{i}"), "success": true }) };
        out.push(ev("tool.execution_complete", done, &at(base, at0 + i * 1000 + ms)));
    }
    out
}

fn phase7() -> Vec<SessionRecord> {
    let t0 = "2026-10-01T00:00:00Z";
    let mut a = vec![ev("session.start", json!({ "reasoningEffort": "high" }), t0), ev("user.message", json!({ "content": "a", "agentMode": "autopilot" }), &at(t0, 1))];
    a.extend(calls("g", "grep", 6, 3, 10, 20, t0));
    a.extend([
        ev("session.usage_record", json!({ "usage": { "model": "gpt-5.5", "inputTokens": 100, "outputTokens": 10, "initiator": "user", "timeToFirstTokenMs": 900, "duration": 2000, "copilotUsage": { "totalNanoAiu": 3e9 } } }), &at(t0, 20000)),
        ev("session.compaction_complete", json!({ "success": true, "systemTokens": 10, "conversationTokens": 30, "toolDefinitionsTokens": 60, "tokensRemoved": 5 }), &at(t0, 21000)),
        ev("session.compaction_complete", json!({ "success": true }), &at(t0, 22000)),
        ev("permission.completed", json!({ "result": { "kind": "approved-for-location" } }), &at(t0, 23000)),
        ev("permission.completed", json!({ "result": { "kind": "denied-interactively" } }), &at(t0, 24000)),
    ]);
    let mut ra = norm("a", Some(Ws { repository: Some("quokka/a"), name: Some("session A"), created_at: Some("2026-10-01T00:00:00Z"), ..Default::default() }), a);
    ra.todos = Some(TodoSummary { total: 2.0, by_status: atlas_core::js::JsMap([("done".to_string(), 1.0), ("blocked".to_string(), 1.0)].into_iter().collect()), deps: 0.0 });
    let mut b = vec![ev("user.message", json!({ "content": "b" }), t0)];
    b.extend(calls("v", "view", 2, 0, 10, 100, t0));
    b.extend([
        ev("session.usage_record", json!({ "usage": { "model": "gpt-5.5", "inputTokens": 50, "outputTokens": 5, "initiator": "agent", "timeToFirstTokenMs": 300, "copilotUsage": { "totalNanoAiu": 1e9 } } }), &at(t0, 5000)),
        ev("session.compaction_complete", json!({ "success": true }), &at(t0, 6000)),
        ev("session.shutdown", json!({ "toolDefinitionsTokens": 20 }), &at(t0, 7000)),
    ]);
    let rb = norm("b", Some(Ws { repository: Some("quokka/b"), created_at: Some("2026-10-02T00:00:00Z"), ..Default::default() }), b);
    vec![ra, rb]
}

#[test]
fn exec_aggregate_phase7() {
    let all = summaries(&phase7());
    let x = exec_aggregate(&refs(&all));
    let js = |v: &dyn erased::Ser| v.json();
    assert_eq!(js(&x.modes), r#"{"rows":[{"key":"interactive","turns":1},{"key":"autopilot","turns":1}],"inferred":1,"total":2}"#);
    assert_eq!(x.efforts.iter().map(|e| (e.key.as_str(), e.requests)).collect::<Vec<_>>(), [("high", 1.0), ("(unknown)", 1.0)]);
    assert_eq!(js(&x.initiators), r#"{"rows":[{"key":"user","requests":1},{"key":"agent","requests":1}],"total":2}"#);
    let c = &x.context;
    assert_eq!((c.sessions, c.tool_def_avg, c.tool_def_median, c.share_avg, c.share_sessions, c.available_tools_avg), (2, Some(40.0), Some(20.0), Some(0.6), 1, None));
    assert_eq!(c.by_project.iter().map(|p| (p.key.as_str(), p.tool_def_avg)).collect::<Vec<_>>(), [("quokka/a", 60.0), ("quokka/b", 20.0)]);
    assert_eq!(js(&x.latency), r#"[{"model":"gpt-5.5","ttft":{"n":2,"median":300,"p90":900},"duration":{"n":1,"median":2000,"p90":2000}}]"#);
    assert_eq!(x.tool_durations.rows.iter().map(|r| (r.tool.as_str(), r.n, r.median, r.p90)).collect::<Vec<_>>(), [("view", 2, Some(100.0), Some(100.0)), ("grep", 6, Some(20.0), Some(20.0))]);
    assert_eq!(js(&x.friction.permissions), r#"{"approved":1,"denied":1,"other":0}"#);
    assert_eq!(js(&x.friction.compaction), r#"{"compactions":3,"recorded":0,"input":0,"output":0,"nanoAiu":0,"tokensRemoved":5}"#);
    assert_eq!(js(&x.todos), r#"{"sessionsWithDb":1,"sessionsWithTodos":1,"total":2,"byStatus":{"done":1,"blocked":1},"deps":0,"completionRate":0.5}"#);
    let only_b = exec_aggregate(&apply_filter(&all, &FilterState { project: "quokka/b".into(), ..empty_filter() }));
    assert_eq!(js(&only_b.modes.rows), r#"[{"key":"interactive","turns":1}]"#);
    assert_eq!(only_b.todos.sessions_with_db, 0);
    assert_eq!(aggregate(&refs(&all), None).exec, x);
}

#[test]
fn small_rules_phase7() {
    assert_eq!(quantiles_of(&[3.0, 1.0, 2.0]), QuantileRow { n: 3, median: Some(2.0), p90: Some(3.0) });
    assert_eq!(tool_share(Some(&[Some(1.0), Some(1.0), Some(2.0), None])), Some(0.5));
    assert_eq!(tool_share(Some(&[None, Some(1.0), Some(2.0), None])), None);
    assert_eq!(tool_share(None), None);
    assert_eq!(["approved", "approved-for-location", "denied-no-approval-rule-and-could-not-request-from-user", "cancelled", "Approved"].map(permission_group), [0, 0, 1, 2, 0]);
}

#[test]
fn highlights_phase7() {
    let all = summaries(&phase7());
    let filter = empty_filter();
    let inst = InstalledView { skills: vec!["grep-skill".into(), "zz".into()], disabled: vec![] };
    let agg = aggregate(&refs(&all), None);
    let g = highlights(&refs(&all), &agg.usage, &HighlightOptions { filter: &filter, anonymized: false, installed: Some(&inst) });
    assert_eq!(g.iter().map(|x| x.kind).collect::<Vec<_>>(), ["cost", "tool-failure", "compaction", "unused-skill"]);
    assert_eq!(
        g[0].items.iter().map(|i| (i.text.as_str(), i.href.as_str())).collect::<Vec<_>>(),
        [("session A: 3 AIU(この条件の合計の 75%)", "sessions/a.html"), ("b: 1 AIU(この条件の合計の 25%)", "sessions/b.html")]
    );
    assert_eq!(g[1].items.len(), 1);
    assert_eq!(g[1].items[0].text, "grep: 失敗率 50%(失敗 3・拒否 0 / 6 回、1 セッション)。主な要因: その他 3 回");
    assert_eq!(g[1].items[0].href, "#tool=grep");
    assert_eq!(g[2].items.iter().map(|i| i.href.as_str()).collect::<Vec<_>>(), ["sessions/a.html", "sessions/b.html"]);
    assert_eq!((g[3].items[0].text.as_str(), g[3].items[0].href.as_str()), ("2 / 2 件: grep-skill、zz", "#view=unused-skills"));
    assert_eq!(ids(&apply_filter(&all, &decode_filter("#tool=grep"))), ["a"]);
    assert!(apply_filter(&all, &decode_filter("#tool=mcp%3Anone")).is_empty());

    // AIU の記録が無ければ出力トークンで並べる。伏せ字モードでは本文を出さない
    let mut recs = phase7();
    for r in &mut recs {
        r.tokens.nano_aiu = None;
    }
    let anon = create_anonymizer(&recs.iter().map(AnonSource::from).collect::<Vec<_>>());
    let all: Vec<SessionSummary> = recs.iter().map(|r| summarize(r, &anon, None)).collect();
    let agg = aggregate(&refs(&all), None);
    let g = highlights(&refs(&all), &agg.usage, &HighlightOptions { filter: &filter, anonymized: true, installed: None });
    assert_eq!(g[0].title, "出力トークンの多いセッション");
    assert!(g[0].items[0].text.starts_with("project-01・2026-10-01"));
    assert!(!g[0].items[0].text.contains("session A"));
    assert!(g.iter().all(|x| x.kind != "unused-skill"));
}

#[test]
fn url_hash_view() {
    let f = FilterState { project: "quokka/a".into(), tool: "mcp:gh".into(), ..empty_filter() };
    assert_eq!(filter_href(&f, None), format!("#{}", encode_filter(&f)));
    assert_eq!(filter_href(&f, Some("unused-skills")), "#project=quokka%2Fa&tool=mcp%3Agh&view=unused-skills");
    assert_eq!(decode_filter(&filter_href(&f, Some("unused-skills"))), f);
    assert_eq!(decode_view("#project=x&view=unused-skills").as_deref(), Some("unused-skills"));
    assert_eq!(decode_view("#project=x"), None);
    assert!(!is_state_hash("#overview"));
    assert!(is_state_hash("#tool=grep"));
    assert_eq!(filter_href(&empty_filter(), Some("unused-skills")), "#view=unused-skills");
}

// ---------- tool-failure-causes.test.ts ----------

const TIMEOUT: &str = "MCP server \"zz-srv\": McpError: MCP error -32001: Request timed out";

fn cause_records() -> Vec<SessionRecord> {
    let mut t = 0;
    let srv = || json!({ "mcpServerName": "zz-srv" });
    let mut a = vec![ev("user.message", json!({ "content": "a" }), "2026-10-01T00:00:00Z")];
    a.extend(call("1", "zz-srv-find", Some(TIMEOUT), srv(), &mut t));
    a.extend(call("2", "zz-srv-find", Some(TIMEOUT), srv(), &mut t));
    a.extend(call("3", "zz-srv-read", Some("Path does not exist"), srv(), &mut t));
    a.extend(call("4", "zz-srv-read", Some("ok"), srv(), &mut t));
    a.extend(call("5", "view", Some("Path does not exist"), json!({}), &mut t));
    a.extend(call("6", "view", Some("ok"), json!({}), &mut t));
    let mut b = vec![ev("user.message", json!({ "content": "b" }), "2026-10-02T00:00:00Z")];
    b.extend(call("1", "zz-srv-find", Some(TIMEOUT), srv(), &mut t));
    b.extend(call("2", "view", Some("Path does not exist"), json!({}), &mut t));
    b.extend(call("3", "view", Some("Path does not exist"), json!({}), &mut t));
    for i in 4..7 {
        b.extend(call(&i.to_string(), "view", Some("ok"), json!({}), &mut t));
    }
    vec![
        norm("a", Some(Ws { cwd: Some("X:\\zz-a"), created_at: Some("2026-10-01T00:00:00Z"), ..Default::default() }), a),
        norm("b", Some(Ws { cwd: Some("X:\\zz-b"), created_at: Some("2026-10-02T00:00:00Z"), ..Default::default() }), b),
    ]
}

#[test]
fn failure_causes_in_summary_and_ranking() {
    let rs = cause_records();
    let s = summarize(&rs[0], &identity_anonymizer(), None);
    assert_eq!(atlas_core::json::to_js_string(&s.tools.causes).unwrap(), r#"{"zz-srv-find":{"timeout":2},"zz-srv-read":{"not_found":1},"view":{"not_found":1}}"#);
    assert_eq!(unpack_summary(&pack_summary(&s)).unwrap().tools.causes, s.tools.causes);

    let ss = summaries(&rs);
    let u = usage_ranking(&refs(&ss));
    assert_eq!(
        atlas_core::json::to_js_string(&u.causes).unwrap(),
        r#"[{"cause":"not_found","label":"対象が見つからない","count":4,"sessions":2,"tools":[{"key":"view","label":"view","mcpServer":null,"count":3},{"key":"zz-srv-read","label":"read","mcpServer":"zz-srv","count":1}]},{"cause":"timeout","label":"時間切れ","count":3,"sessions":2,"tools":[{"key":"zz-srv-find","label":"find","mcpServer":"zz-srv","count":3}]}]"#
    );
    assert_eq!(u.causes_unrecorded, 0);
    let m = u.tools.iter().find(|t| t.key == "mcp:zz-srv").unwrap();
    assert_eq!((m.failure, atlas_core::json::to_js_string(&m.causes).unwrap()), (4, r#"{"timeout":3,"not_found":1}"#.to_string()));

    // 要因の記録が無い失敗は、要因の行に入れずに数だけ残す
    let mut old = ss[0].clone();
    old.tools.causes = None;
    let u = usage_ranking(&[&old, &ss[1]]);
    assert_eq!(u.causes_unrecorded, 4);
    assert_eq!(u.causes.iter().map(|c| (c.cause.as_str(), c.count)).collect::<Vec<_>>(), [("not_found", 2), ("timeout", 1)]);

    let agg = aggregate(&refs(&ss), None);
    let f = empty_filter();
    let g = highlights(&refs(&ss), &agg.usage, &HighlightOptions { filter: &f, anonymized: false, installed: None });
    let tf = g.iter().find(|x| x.kind == "tool-failure").unwrap();
    assert_eq!(
        tf.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
        ["MCP zz-srv: 失敗率 80%(失敗 4・拒否 0 / 5 回、2 セッション)。主な要因: 時間切れ 3 回", "view: 失敗率 43%(失敗 3・拒否 0 / 7 回、2 セッション)。主な要因: 対象が見つからない 3 回"]
    );
}

/// JSON にして比べる(serde の Serialize を dyn で受けるための小さな道具)
mod erased {
    pub trait Ser {
        fn json(&self) -> String;
    }
    impl<T: serde::Serialize> Ser for T {
        fn json(&self) -> String {
            atlas_core::json::to_js_string(self).unwrap()
        }
    }
}
