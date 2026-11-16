//! report の lib の Rust 版の結果を、入口ごとに 1 つの JSON に書く(scripts/parity-lib.ts の Rust 側。TS 版と同じ呼び方・同じ並び)。
//!
//!   cargo run --release -p atlas-report --example libdump -- <out> <dump> <notes>
//!
//! scripts/parity-lib.ts --compare は、atlas-cli と一緒に作る(cargo build --release -p atlas-cli -p atlas-report --example libdump)。
//! 上の cargo run は atlas-report だけで依存の features を決めるので、atlas-cli のビルドを使い回せず release を作り直す。
//!
//! <out> は atlas の出力先(sessions.json。あれば judgments.json・turn-judgments.json・vcs-retention.json)、<notes> は groups.json の置き場。

use anyhow::{Context, Result};
use atlas_core::js::{self, JsMap};
use atlas_core::types::{SessionRecord, SessionsFile};
use atlas_core::vcs_step::read_vcs_retention;
use atlas_report::aggregate::{aggregate, coverage_breakdown, month_range, unused_skills};
use atlas_report::embed::{embed_data, extract_embedded, serialize_for_script};
use atlas_report::exec::{exec_aggregate, quantiles_of};
use atlas_report::exec_labels::*;
use atlas_report::filter::*;
use atlas_report::format::*;
use atlas_report::glossary::{terms_by_group, GLOSSARY, GLOSSARY_GROUPS};
use atlas_report::groups::{member_groups, parse_groups, safe_dir_name, serialize_groups, MemberSource, ParsedGroups};
use atlas_report::highlights::{highlights, installed_view, HighlightOptions};
use atlas_report::insights::*;
use atlas_report::judgment_labels::*;
use atlas_report::judgments::parse_judgments;
use atlas_report::memo::{is_safe_file_name, is_safe_memo_id, memo_excerpt, memo_summary};
use atlas_report::pack::pack_summary;
use atlas_report::project_label::short_project_label;
use atlas_report::retention::{aggregate_retention, retention_by_phase, retention_item, retention_meta, turn_starts};
use atlas_report::summarize::{detail_file_name, summarize, tests_summary};
use atlas_report::turns::turn_aggregate;
use atlas_report::types::{SessionSummary, REPORT_DATA_VERSION};
use atlas_report::verdicts::{parse_verdicts, verdict_aggregate, verdict_tuples};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 数の表示の確かめに使う値(TS 側と同じ並び)
const NUMBERS: [f64; 31] = [
    0.0,
    -0.0,
    0.5,
    1.005,
    0.125,
    2.5,
    -2.5,
    1.45,
    0.015,
    8.345,
    1234567.891,
    1e21,
    1180591620717411303424.0,
    999.995,
    1e-7,
    12345.0,
    99999.0,
    1e8 + 5.0,
    -123456789.0,
    59_499.0,
    59_500.0,
    3_599_000.0,
    172_800_000.0,
    86_399_999.0,
    850.0,
    1234.0,
    125_000.0,
    7_200_000.0,
    f64::INFINITY,
    f64::NEG_INFINITY,
    f64::NAN,
];
const FILE_NAMES: [&str; 15] = ["メモ.md", "a b.txt", "x", "", ".x", "..", "a/b", "x.", "x ", "CON", "nul.log", "Com1", "a:b", "abc-1_2.x", "あ"];

/// テストの結果の要約を確かめる形(実行なし / 未達 / 1 回目で通る / 通った後に不合格で AI 使用量の記録なし / 番号が実行の数を外れている / 番号が 0 / 番号が負)。
/// scripts/parity-lib.ts の TESTS_CASES と同じ中身
const TESTS_CASES: &str = r#"[
  { "runs": [], "invalid": 1, "duplicates": 0, "dropped": 0, "firstPass": null },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1500000000, "failing": 1, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 2000, "nanoAiu": 2500000000, "failing": 1, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": null },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1500, "nanoAiu": 2500000000, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 1 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": null, "failing": 1, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 60000.5, "nanoAiu": null, "failing": 0, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 90000, "nanoAiu": null, "failing": 2, "results": [] }], "invalid": 0, "duplicates": 2, "dropped": 0, "firstPass": 2 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 5 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 0 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": -1 }
]"#;

/// 課題 × 条件の表を確かめる形(scripts/parity-lib.ts の CONDITION_CASES と同じ中身)
const CONDITION_CASES: &str = r#"{"sessions":[{"id":"s01","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s02","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s03","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":3,"lastFailing":0,"passActiveMs":180001.5,"passNanoAiu":4500000000.0,"lastNanoAiu":6000000000.0},"person":null},{"id":"s04","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":1,"lastFailing":1,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s05","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":null},{"id":"s06","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":null},"person":null},{"id":"s07","activeMs":null,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":null},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s08","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":4,"firstPass":4,"lastFailing":0,"passActiveMs":240002.0,"passNanoAiu":null,"lastNanoAiu":null},"person":null},{"id":"s09","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"person":null},{"id":"s10","activeMs":600000,"tools":{"total":0},"friction":{"toolFailures":0},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s11","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":"zz-a"},{"id":"s12","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":3,"lastFailing":0,"passActiveMs":180001.5,"passNanoAiu":4500000000.0,"lastNanoAiu":6000000000.0},"person":"zz-b"},{"id":"s13","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":"zz-b"},{"id":"s14","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s15","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s16","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":null},{"id":"s17","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s18","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null}],"groups":[{"name":"t10__wiki__1","presentIds":["s01","s02","s03"]},{"name":"t10__wiki__2","presentIds":["s03","s04","s05","s06"]},{"name":"t2__wiki","presentIds":["s07","s08","s09"]},{"name":"t2__0-plain","presentIds":["s10","s14","s15","s16","s17"]},{"name":"zz-a / t2__coderef__1","tag":"t2__coderef__1","presentIds":["s11"]},{"name":"zz-b / t2__coderef__1","tag":"t2__coderef__1","presentIds":["s12","s13"]},{"name":"描画__wiki","presentIds":["s18"]},{"name":"描画__0-plain","presentIds":["s18"]},{"name":"zz-misc","presentIds":["s09"]},{"name":"x__y__v2","presentIds":["s09"]},{"name":"gone__wiki","presentIds":["not-in-records"]}],"names":["render__wiki","render__wiki__1"," 描画 __ wiki あり __ 007 ","Player-Weapon__code_ref__12","render","render__","__wiki","render____1","a__b__c__1","render__wiki__v2","render__wiki__１","a___b","a__b_",""],"order":["c10","c2","B","a","c1","0-plain","wiki","Wiki","描画","あ","ア","t10","t2","x_1","x-1","c01","c001","c1","c１０","v1.10","v1.9","v1.9a","Z","z"]}"#;

/// CONDITION_CASES のセッションとタスクタグを、表の計算の形にする(画面の ConditionSession・ConditionGroup と同じ項目を読む)
fn condition_cases() -> Result<(Vec<atlas_report::conditions::CondSession>, Vec<atlas_report::conditions::CondGroup>, Vec<String>, Vec<String>)> {
    use atlas_report::conditions::{CondGroup, CondSession};
    let v: Value = serde_json::from_str(CONDITION_CASES)?;
    let num = |x: &Value, path: &[&str]| path.iter().fold(Some(x), |a, k| a.and_then(|a| a.get(*k))).and_then(Value::as_f64);
    let sessions = v["sessions"]
        .as_array()
        .context("sessions")?
        .iter()
        .map(|s| -> Result<CondSession> {
            Ok(CondSession {
                id: s["id"].as_str().context("id")?.to_string(),
                active_ms: num(s, &["activeMs"]),
                tools: num(s, &["tools", "total"]).unwrap_or(0.0) as i64,
                tool_failures: num(s, &["friction", "toolFailures"]).unwrap_or(0.0) as i64,
                nano_aiu: num(s, &["tokens", "nanoAiu"]),
                tests: match s.get("tests") {
                    Some(t) if !t.is_null() => Some(serde_json::from_value(t.clone())?),
                    _ => None,
                },
                person: s["person"].as_str().map(str::to_string),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let groups = v["groups"]
        .as_array()
        .context("groups")?
        .iter()
        .map(|g| CondGroup {
            raw: g.get("tag").and_then(Value::as_str).or(g["name"].as_str()).unwrap_or("").to_string(),
            ids: g["presentIds"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
        })
        .collect();
    let strs = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    Ok((sessions, groups, strs("names"), strs("order")))
}

struct Dump {
    dir: PathBuf,
    timings: JsMap<f64>,
}

impl Dump {
    fn write<T: Serialize + ?Sized>(&self, name: &str, v: &T) -> Result<()> {
        let p = self.dir.join(format!("{name}.json"));
        std::fs::write(&p, atlas_core::json::to_js_string(v)?).with_context(|| format!("{} に書けません", p.display()))
    }
    fn timed<T>(&mut self, name: &str, f: impl FnOnce() -> T) -> T {
        let t = Instant::now();
        let r = f();
        self.timings.add(name, t.elapsed().as_secs_f64() * 1000.0);
        r
    }
}

fn read_json(p: &Path) -> Result<Option<Value>> {
    if !p.exists() {
        return Ok(None);
    }
    let text = std::fs::read(p)?;
    Ok(Some(js::parse_json(&String::from_utf8_lossy(&text)).with_context(|| format!("{} を読めません", p.display()))?))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (in_dir, out_dir, notes) = (PathBuf::from(&args[0]), PathBuf::from(&args[1]), PathBuf::from(&args[2]));
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&out_dir)?;
    let mut d = Dump { dir: out_dir, timings: JsMap::new() };

    let text = std::fs::read(in_dir.join("sessions.json"))?;
    let file: SessionsFile = js::parse_json_as(&String::from_utf8_lossy(&text))?;
    let records: Vec<&SessionRecord> = file.sessions.iter().collect();
    let judgments = read_json(&in_dir.join("judgments.json"))?.map(|v| parse_judgments(&v)).transpose()?;
    let verdicts = read_json(&in_dir.join("turn-judgments.json"))?.and_then(|v| parse_verdicts(&v));
    let groups: ParsedGroups = read_json(&notes.join("groups.json"))?.map_or_else(ParsedGroups::default, |v| parse_groups(&v, "groups.json"));
    let rx = read_vcs_retention(&in_dir.join("vcs-retention.json"));
    let installed = file.installed.as_ref().map(installed_view);
    d.write(
        "judgments",
        &judgments.as_ref().map(|j| json!({ "backend": j.backend, "model": j.model, "ranAt": j.ran_at, "bySession": JsMap(j.by_session.clone()) })),
    )?;

    // 要約(build.ts と同じ: summarize に判定・依頼ごとの判定・照合の結果を足す)
    let retention_by_id: HashMap<&str, &atlas_core::vcs_retention::SessionRetention> = rx.iter().flat_map(|x| x.sessions.iter()).map(|r| (r.session_id.as_str(), r)).collect();
    let plain = d.timed("summarize", || -> Vec<SessionSummary> {
        records
            .iter()
            .map(|r| {
                let mut s = summarize(r, judgments.as_ref().and_then(|j| j.by_session.get(&r.id)));
                if let Some(v) = &verdicts {
                    let vt = verdict_tuples(v.by_session.get(&r.id), &v.phases);
                    if !vt.is_empty() {
                        s.turn_verdicts = Some(vt);
                    }
                }
                if let Some(rt) = retention_by_id.get(r.id.as_str()) {
                    s.retention = Some(retention_item(rt, &turn_starts(r)));
                }
                s
            })
            .collect()
    });
    d.write("summaries", &plain)?;
    let packed: Vec<Value> = d.timed("pack", || plain.iter().map(pack_summary).collect());
    d.write("packed", &packed)?;
    let tpl = r#"<!doctype html><script type="application/json" id="atlas-data">__ATLAS_DATA__</script>"#;
    let html = d.timed("embed", || embed_data(tpl, &json!({ "version": REPORT_DATA_VERSION, "sessions": plain.iter().map(pack_summary).collect::<Vec<_>>() })))?;
    d.write("embed", &json!({ "html": html, "extracted": extract_embedded(&html)?, "script": serialize_for_script(&json!({ "t": "</script><!-- https://x fetch(1) \u{2028} & >" }))? }))?;
    d.write(
        "retention",
        &json!({
            "meta": rx.as_ref().map(retention_meta),
            "starts": records.iter().filter(|r| retention_by_id.contains_key(r.id.as_str())).map(|r| turn_starts(r)).collect::<Vec<_>>(),
        }),
    )?;

    // 絞り込みの条件ごとの集計と要点欄
    let plain_refs: Vec<&SessionSummary> = plain.iter().collect();
    let people = has_people(plain_refs.iter().copied());
    let opts = filter_options(&plain);
    d.write("filter-options", &opts)?;
    let mut dates: Vec<&str> = plain.iter().filter_map(|s| s.created_at.as_deref()).filter(|x| !x.is_empty()).collect();
    dates.sort_by(|a, b| js::cmp_utf16(a, b));
    let all = aggregate(&plain_refs, None);
    let mcp_tool = all.usage.tools.iter().find(|t| t.mcp_server.as_deref().is_some_and(|x| !x.is_empty()));
    let known: HashSet<String> = plain.iter().map(|s| s.id.clone()).collect();
    let g0 = groups.groups.first();
    let day = |i: usize| dates.get(i).map_or(String::new(), |x| js::head(x, 10).into_owned());
    let f = |m: &dyn Fn(&mut FilterState)| {
        let mut x = empty_filter();
        m(&mut x);
        x
    };
    let filters: Vec<(&str, FilterState)> = vec![
        ("all", empty_filter()),
        ("withEmpty", f(&|x| x.empty = "1".into())),
        ("project", f(&|x| x.project = opts.project.first().map_or(String::new(), |o| o.value.clone()))),
        ("model", f(&|x| x.model = opts.model.first().map_or(String::new(), |o| o.value.clone()))),
        ("unknownModel", f(&|x| x.model = UNKNOWN.into())),
        ("range", f(&|x| (x.from, x.to) = (day(dates.len() / 4), day(dates.len() * 3 / 4)))),
        ("tool", f(&|x| x.tool = all.usage.tools.first().map_or(String::new(), |t| t.key.clone()))),
        ("mcp", f(&|x| x.tool = mcp_tool.map_or("mcp:none".into(), |t| t.key.clone()))),
        ("input", f(&|x| x.coverage = "input".into())),
        ("outputOnly", f(&|x| x.coverage = "output-only".into())),
        ("person", f(&|x| x.person = UNKNOWN.into())),
        ("unjudged", f(&|x| x.task_category = NO_JUDGMENT.into())),
        ("ids", f(&|x| x.ids = plain.iter().take(5).map(|s| s.id.as_str()).chain(["zzz"]).collect::<Vec<_>>().join(","))),
        (
            "group",
            f(&|x| {
                x.group = g0.map_or(String::new(), |g| g.name.clone());
                x.ids = g0.map_or(String::new(), |g| effective_ids("", &g.name, &groups.groups, &known).ids);
            }),
        ),
    ];
    let phases: Vec<String> = verdicts.as_ref().map(|v| v.phases.clone()).unwrap_or_default();
    for (name, flt) in &filters {
        let xs = apply_filter(&plain, flt);
        let agg = d.timed("aggregate", || aggregate(&xs, Some(people)));
        d.write(&format!("aggregate-{name}"), &agg)?;
        let hl = d.timed("highlights", || highlights(&xs, &agg.usage, &HighlightOptions { filter: flt, installed: installed.as_ref() }));
        d.write(&format!("highlights-{name}"), &hl)?;
        let (by_phase, without) = retention_by_phase(xs.iter().map(|s| s.retention.as_ref()));
        d.write(
            &format!("turns-{name}"),
            &json!({
                "turns": turn_aggregate(xs.iter().map(|s| (s.turns, s.turn_rows.as_deref()))),
                "verdicts": verdict_aggregate(xs.iter().map(|s| (s.turn_rows.as_deref(), s.turn_verdicts.as_deref())), &phases),
                "retention": aggregate_retention(xs.iter().map(|s| s.retention.as_ref())),
                "byPhase": by_phase.into_iter().collect::<Vec<_>>(),
                "withoutPhases": without,
                "coverage": coverage_breakdown(&xs),
            }),
        )?;
        let enc = encode_filter(flt);
        let href = filter_href(flt, Some("unused-skills"));
        d.write(
            &format!("filter-{name}"),
            &json!({ "encoded": enc, "href": href, "decoded": decode_filter(&enc), "view": decode_view(&href), "state": is_state_hash(&filter_href(flt, None)), "ids": xs.iter().map(|s| &s.id).collect::<Vec<_>>() }),
        )?;
    }
    d.write("exec", &exec_aggregate(&plain_refs))?;
    d.write(
        "misc",
        &json!({
            "monthRange": month_range("2025-11", "2026-02"),
            "unused": installed.as_ref().map(|i| unused_skills(&i.skills, all.usage.skills.iter().map(|s| s.name.as_str()))),
            "quantiles": quantiles_of(&plain.iter().map(|s| s.active_ms.unwrap_or(0.0)).collect::<Vec<_>>()),
        }),
    )?;

    // 改善点(build.ts と同じ)
    let meta = insight_meta(&records);
    d.write("insights-meta", &meta)?;
    let versions = instruction_versions(&plain_refs);
    d.write("insights-versions", &versions)?;
    d.write("insights-findings", &instruction_findings(&versions, &meta, plain.len()))?;
    d.write("insights-skills", &skill_stats(&plain_refs, installed.as_ref().map(|i| i.skills.as_slice())))?;
    let stuck = stuck_sessions(&plain_refs);
    d.write("insights-stuck", &stuck)?;
    d.write("insights-stuck-projects", &stuck_by_project(&stuck, &plain_refs))?;
    let cs: Vec<CandidateSource> = records.iter().map(|r| CandidateSource { id: &r.id, project: &r.project, analysis: &r.analysis }).collect();
    let cands = d.timed("skillCandidates", || skill_candidates(&cs));
    d.write("insights-candidates", &cands)?;
    d.write("insights-candidates-embedded", &embedded_candidates(&cands))?;
    let rc = d.timed("requestCandidates", || request_candidates(&cs));
    d.write("insights-requests", &rc)?;
    let tc = d.timed("toolSequenceCandidates", || tool_sequence_candidates(&cs));
    d.write("insights-tools", &tc)?;
    let reqs: Vec<&String> = records.iter().flat_map(|r| r.analysis.requests.iter()).collect();
    let norm: Vec<Value> = reqs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let n = normalize_request(t);
            let g = trigrams(&n);
            let j = if i > 0 { Some(jaccard(&g, &trigrams(&normalize_request(reqs[i - 1])))) } else { None };
            json!([n, g.len(), j])
        })
        .collect();
    d.write("insights-normalize", &norm)?;
    let headings: Vec<Value> = records.iter().flat_map(|r| r.instructions.iter().map(|i| json!([clean_heading(&i.heading, Some(60)), clean_heading(&i.heading, Some(20)), series_key(&i.heading, i.file.as_str())]))).collect();
    d.write("insights-headings", &headings)?;

    // 表示の書式
    let mut nums: Vec<f64> = NUMBERS.to_vec();
    for s in &plain {
        nums.extend([s.tokens.output, s.active_ms.unwrap_or(0.0), s.duration_ms.unwrap_or(0.0), s.tokens.nano_aiu.unwrap_or(0.0) / 1e9]);
    }
    d.write(
        "format-numbers",
        &nums.iter().map(|&n| [int(Some(n), "記録なし"), dec(Some(n), "記録なし"), compact(n), duration(Some(n), "不明"), ms_label(Some(n), "—")]).collect::<Vec<_>>(),
    )?;
    d.write("format-percent", &nums.iter().take(40).map(|&n| [percent(n, 7.0), percent(1.0, n), percent(n, 1000.0)]).collect::<Vec<_>>())?;
    let mut ds: Vec<Option<&str>> = plain.iter().flat_map(|s| [s.created_at.as_deref(), s.updated_at.as_deref()]).collect();
    ds.extend([Some(""), Some("x"), Some("2026-11-01T00:00:00+09:00"), None]);
    d.write("format-dates", &ds.iter().map(|x| [date_time(*x, "日時不明"), date(*x, "日時不明")]).collect::<Vec<_>>())?;
    let months: Vec<String> = all.by_month.iter().map(|b| b.key.as_str()).chain(["2026-1", "x"]).map(month).collect();
    d.write("format-months", &months)?;
    let titles: Vec<&str> = plain.iter().map(|s| s.name.as_deref().filter(|x| !x.is_empty()).or(s.first_user_message.as_deref().filter(|x| !x.is_empty())).unwrap_or("")).collect();
    let leads = shared_leads(&titles);
    d.write("format-leads", &json!({ "leads": leads, "split": titles.iter().zip(&leads).map(|(t, l)| split_lead(t, l.cut, 70)).collect::<Vec<_>>() }))?;
    let text: Vec<Value> = records
        .iter()
        .map(|r| json!([truncate(r.first_user_message.as_deref(), 48), r.cwd.as_deref().filter(|x| !x.is_empty()).map(path_parts), detail_file_name(&r.id), r.models.iter().map(|m| model_label(m)).collect::<Vec<_>>(), short_project_label(&r.project)]))
        .collect();
    d.write("format-text", &text)?;

    // 表示名・メモ・グループ・用語
    // 本体の (モデル, 推論強度)。画面は要約から、Rust(sessions.csv)は sessions.json の記録から決める
    let by_id: std::collections::HashMap<&str, &SessionRecord> = records.iter().map(|r| (r.id.as_str(), *r)).collect();
    let main: Vec<Value> = plain
        .iter()
        .map(|s| {
            let m = atlas_core::main_effort::main_effort_of(by_id.get(s.id.as_str()).and_then(|r| r.exec.main_model_efforts.as_ref()));
            let kind = match m {
                atlas_core::main_effort::MainEffort::Decided { .. } => "decided",
                atlas_core::main_effort::MainEffort::Mixed => "mixed",
                atlas_core::main_effort::MainEffort::None => "none",
            };
            let effort = if kind == "decided" { m.effort_cell() } else { "" };
            json!([s.id, kind, m.model_cell(), effort])
        })
        .collect();
    d.write("main-effort", &main)?;
    // テストの結果の要約(scripts/parity-lib.ts の TESTS_CASES と同じ並び)
    let cases: Vec<atlas_core::types::SessionTests> = serde_json::from_str(TESTS_CASES)?;
    d.write("tests-summary", &cases.iter().map(tests_summary).collect::<Vec<_>>())?;
    // 課題 × 条件の表(scripts/parity-lib.ts と同じ形で書く)
    {
        use atlas_report::conditions::{compare_names, condition_table, parse_condition_tag};
        let (cs, cg, names, mut order) = condition_cases()?;
        let t = condition_table(&cs, &cg);
        order.sort_by(|a, b| compare_names(a, b));
        d.write(
            "conditions",
            &json!({
                "names": names.iter().map(|n| parse_condition_tag(n)).collect::<Vec<_>>(),
                "order": order,
                "table": {
                    "tasks": t.tasks,
                    "conditions": t.conditions,
                    "rows": t.rows,
                    "pooled": t.pooled,
                    "matchedTags": t.matched_tags,
                    "counted": t.counted,
                    "members": t.members.iter().map(|m| json!([m.id, m.task, m.condition])).collect::<Vec<_>>(),
                    "unmatched": t.unmatched,
                    "ambiguous": t.ambiguous,
                    "people": t.people,
                    "sharedRows": t.shared_rows,
                    "unevenTasks": t.uneven_tasks,
                    "hasTests": t.has_tests,
                },
            }),
        )?;
    }
    let x = exec_aggregate(&plain_refs);
    let with = |a: Vec<String>, extra: &[&str]| -> Vec<String> { a.into_iter().chain(extra.iter().map(|s| s.to_string())).collect() };
    let cats: Vec<Option<&str>> = [None, Some(""), Some("feature"), Some("docs"), Some("x")].into_iter().chain(plain.iter().map(|s| s.judgment.as_ref().and_then(|j| j.task_category.as_deref()))).collect();
    d.write(
        "labels",
        &json!({
            "modes": with(x.modes.rows.iter().map(|r| r.key.clone()).collect(), &["(unknown)", "x"]).iter().map(|k| mode_label(k)).collect::<Vec<_>>(),
            "initiators": with(x.initiators.rows.iter().map(|r| r.key.clone()).collect(), &["(unknown)", "x"]).iter().map(|k| initiator_label(k)).collect::<Vec<_>>(),
            "efforts": with(x.efforts.iter().map(|r| r.key.clone()).collect(), &["(unknown)"]).iter().map(|k| effort_label(k)).collect::<Vec<_>>(),
            "subagent": with(x.friction.subagent_failures.iter().map(|r| r.name.clone()).collect(), &["quota", "unknown", "x"]).iter().map(|k| subagent_failure_label(k)).collect::<Vec<_>>(),
            "errors": with(x.friction.error_types.iter().map(|r| r.name.clone()).collect(), &["(unknown)"]).iter().map(|k| error_type_label(k)).collect::<Vec<_>>(),
            "todos": with(x.todos.by_status.js_keys().into_iter().cloned().collect(), &["pending", "x"]).iter().map(|k| todo_status_label(k)).collect::<Vec<_>>(),
            "categories": cats.iter().map(|c| category_label(*c)).collect::<Vec<_>>(),
            "effects": ([None, Some(-2.0), Some(-1.0), Some(0.0), Some(1.0), Some(2.0), Some(3.0), Some(0.5)].map(effect_label)),
            "confidence": ([None, Some(0.0), Some(0.555), Some(0.6), Some(1.0)].map(confidence_label)),
            "backends": ([None, Some(""), Some("external"), Some("copilot-cli"), Some("x")].map(backend_label)),
        }),
    )?;
    let memo_texts: Vec<String> = [
        "\n\n# 見出し\n本文",
        "- [ ] **やること** と [リンク](x)",
        "```\ncode\n```\n\nあと",
        "![図](a/b.png)",
        "   \n\n",
        "session_id の調査、2*3、~/.copilot",
        "---\ntitle: x\n---\n\n本文",
        "---\n\n本文",
        "> 引用 `code` ~~消し~~ __強調__",
        "1. 番号付き\n2. 次",
        "***\n\n___\n本文\r\n次",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([format!("{}\n![a](x/1.png) ![b](x/2.png)", "あ".repeat(100))])
    .chain(records.iter().take(200).map(|r| r.first_user_message.clone().unwrap_or_default()))
    .collect();
    d.write(
        "memo",
        &json!({
            "texts": memo_texts.iter().map(|t| json!([memo_excerpt(t), memo_summary(t, Some("2026-11-03T00:00:00.000Z"))])).collect::<Vec<_>>(),
            "names": (FILE_NAMES.map(|n| [is_safe_file_name(n), is_safe_memo_id(n)])),
        }),
    )?;
    let members: Vec<MemberSource> = records.iter().map(|r| MemberSource::from(*r)).collect();
    let effective: Vec<Value> = groups
        .groups
        .iter()
        .map(|g| {
            let e = effective_ids("", &g.name, &groups.groups, &known);
            let ids = group_ids(&g.ids, &known);
            json!([{ "group": e.group, "ids": e.ids }, current_group_name(&ids, "", &groups.groups, &known), ids])
        })
        .collect();
    d.write(
        "groups",
        &json!({
            "parsed": { "groups": groups.groups, "warnings": groups.warnings },
            "serialized": serialize_groups(&groups.groups),
            "member": member_groups(&members),
            "dirs": groups.groups.iter().map(|g| g.name.as_str()).chain(["a/b:c", "nul.log", "x. . ", "..."]).map(safe_dir_name).collect::<Vec<_>>(),
            "effective": effective,
        }),
    )?;
    d.write("glossary", &json!({ "groups": GLOSSARY_GROUPS, "terms": *GLOSSARY, "counts": GLOSSARY_GROUPS.iter().map(|g| terms_by_group(g.id).len()).collect::<Vec<_>>() }))?;
    std::fs::write(d.dir.join("timings.txt"), atlas_core::json::to_js_string(&d.timings)?)?;
    Ok(())
}
