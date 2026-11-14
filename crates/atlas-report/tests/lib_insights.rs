//! 改善点の規則(packages/report/test/phase12.test.ts と request-clusters.test.ts)と、照合の結果の埋め込み(retention.test.ts の lib の部分)
#![recursion_limit = "256"]

use atlas_core::js::JsMap;
use atlas_core::types::SessionAnalysis;
use atlas_core::vcs_retention::SessionRetention;
use atlas_report::insights::thresholds as T;
use atlas_report::insights::*;
use atlas_report::retention::retention_item;
use atlas_report::types::SessionSummary;
use serde_json::{json, Value};

/// 必要な欄だけ持つ SessionSummary(他は既定)
fn sess(id: &str, patch: Value) -> SessionSummary {
    let mut v = json!({
        "id": id, "client": "github/cli", "project": "p", "projectLabel": "p", "projectSource": "repository", "branch": null, "name": null,
        "firstUserMessage": null, "createdAt": null, "updatedAt": null, "durationMs": null, "activeMs": null, "turns": 1, "autopilotContinuations": 0,
        "empty": false, "models": [],
        "tokens": { "input": null, "output": 100, "cacheRead": null, "cacheWrite": null, "reasoning": null, "premiumRequests": null, "nanoAiu": null, "requests": null, "source": "none" },
        "coverage": "none", "byModel": {},
        "tools": { "total": 10, "byName": {}, "internal": 0, "mcp": {}, "issues": {}, "durations": {}, "outliers": {} },
        "exec": { "modes": {}, "modesInferred": 0, "efforts": {}, "initiators": {}, "context": null, "latency": {} },
        "frictionDetail": { "permissions": [0, 0, 0], "errorTypes": {}, "subagentFailures": {}, "compaction": [0, 0, 0, 0, 0] },
        "todos": null, "skills": {}, "skillChars": {}, "instructionVersions": [],
        "analysis": { "filesReedited": 0, "extraEdits": 0, "maxConsecutiveFailures": 0, "turns": 1 },
        "agents": { "total": 0, "failed": 0, "byName": {} }, "hooks": { "total": 0, "byType": {} }, "instructions": {},
        "lines": { "added": 0, "removed": 0, "source": "none" }, "wiki": { "indexReads": 0, "pageReads": 0, "skillCalls": 0, "writes": 0 },
        "friction": { "compactions": 0, "aborts": 0, "errors": 0, "permissionRequests": 0, "askUser": 0, "modelChanges": 0, "modeChanges": 0, "toolFailures": 0, "subagentFailures": 0 },
        "files": { "changed": 0, "created": 0, "deleted": 0, "sessionState": 0 }, "href": format!("sessions/{id}.html"), "judgment": null,
    });
    for (k, x) in patch.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn failing(id: &str, patch: Value) -> SessionSummary {
    let mut p = json!({ "tools": { "total": 10, "byName": { "bash": 10 }, "internal": 0, "mcp": {}, "issues": { "bash": [4, 0, 10] }, "durations": {}, "outliers": {} } });
    for (k, x) in patch.as_object().unwrap() {
        p[k] = x.clone();
    }
    sess(id, p)
}

fn refs(xs: &[SessionSummary]) -> Vec<&SessionSummary> {
    xs.iter().collect()
}

fn meta(heading: &str, series: &str, order: i64, first: Option<&str>, last: Option<Option<&str>>) -> VersionMeta {
    VersionMeta { heading: heading.into(), file: "AGENTS.md".into(), series: series.into(), order, first_at: first.map(Into::into), last_at: last.map(|x| x.map(Into::into)) }
}

#[test]
fn instruction_versions_and_findings() {
    let iv = |h: &str, c: i64, n: i64| json!({ "instructionVersions": [[h, c, n]] });
    let v1: Vec<SessionSummary> = (0..5).map(|i| sess(&format!("a{i}"), iv("h1", 500, 1))).collect();
    let v2: Vec<SessionSummary> = (0..5).map(|i| if i < 3 { failing(&format!("b{i}"), iv("h2", 520, 1)) } else { sess(&format!("b{i}"), iv("h2", 520, 1)) }).collect();
    let v3 = vec![sess("c0", iv("h3", 9000, 2))];
    let all: Vec<SessionSummary> = [v1.clone(), v2.clone(), v3.clone()].concat();
    let stats = instruction_versions(&refs(&all));
    let get = |h: &str| stats.iter().find(|v| v.hash == h).unwrap().clone();
    let (h1, h2, h3) = (get("h1"), get("h2"), get("h3"));
    assert_eq!((h1.sessions, h1.enough, h1.failure_rate, h1.rework_rate), (5, true, Some(0.0), 0.0));
    assert!((h2.failure_rate.unwrap() - 12.0 / 50.0).abs() < 1e-12);
    assert_eq!((h3.sessions, h3.enough, h3.injections_per_session), (1, false, 2.0));
    let mut m: JsMap<VersionMeta> = JsMap::new();
    m.insert("h1".into(), meta("# A", "s0", 0, Some("2026-10-01"), None));
    m.insert("h2".into(), meta("# A", "s0", 1, Some("2026-10-02"), None));
    m.insert("h3".into(), meta("# A", "s0", 2, Some("2026-10-03"), None));
    let f = instruction_findings(&stats, &m, 100);
    assert_eq!(f.worsened.len(), 1);
    assert_eq!((f.worsened[0].heading.as_str(), f.worsened[0].before.hash.as_str(), f.worsened[0].after.hash.as_str()), ("# A", "h1", "h2"));
    assert!((f.worsened[0].failure_delta.unwrap() - 24.0).abs() < 1e-9);
    assert_eq!(f.compared_insufficient, 1);
    assert_eq!(f.compared, 1);
    // 9 ポイントの悪化は挙げない
    let v2b: Vec<SessionSummary> = (0..10).map(|i| if i < 1 { failing(&format!("d{i}"), iv("h2", 520, 1)) } else { sess(&format!("d{i}"), iv("h2", 520, 1)) }).collect();
    let s2 = instruction_versions(&refs(&[v1.clone(), v2b].concat()));
    assert!(instruction_findings(&s2, &m, 100).worsened.is_empty());
    // 長いのに注入が少ない(版が 4 つ以上あるとき)
    let many: Vec<SessionSummary> = [all.clone(), vec![sess("e0", iv("h4", 100, 1))]].concat();
    let mut all_meta = m.clone();
    all_meta.insert("h4".into(), meta("# B", "s1", 0, None, None));
    let st = instruction_versions(&refs(&many));
    assert!(instruction_findings(&st, &all_meta, T::MIN_SESSIONS - 1).long_rare.is_empty());
    let lr = instruction_findings(&st, &all_meta, many.len());
    assert_eq!(lr.long_rare.iter().map(|v| v.hash.as_str()).collect::<Vec<_>>(), ["h3"]);
    assert!(lr.long_chars > 0);
    // 今の版は最後に読み込まれた版
    let mut by_last = all_meta.clone();
    by_last.insert("h1".into(), meta("# A", "s0", 0, Some("2026-10-01"), Some(Some("2026-10-09"))));
    by_last.insert("h2".into(), meta("# A", "s0", 1, Some("2026-10-02"), Some(Some("2026-10-02"))));
    by_last.insert("h3".into(), meta("# A", "s0", 2, Some("2026-10-03"), Some(Some("2026-10-03"))));
    assert!(instruction_findings(&st, &by_last, many.len()).long_rare.is_empty());
}

#[test]
fn stuck_ordering_and_reasons() {
    let lat = |t: Value| json!({ "modes": {}, "modesInferred": 0, "efforts": {}, "modelEfforts": {}, "initiators": {}, "context": null, "latency": { "m": t } });
    let with_ttft = sess("w", json!({ "exec": lat(json!([[5000], [9000]])), "analysis": { "filesReedited": 1, "extraEdits": T::STUCK_EXTRA_EDITS, "maxConsecutiveFailures": 0, "turns": 1 } }));
    let many_edits = sess("e", json!({ "analysis": { "filesReedited": 5, "extraEdits": T::STUCK_EXTRA_EDITS * 40, "maxConsecutiveFailures": 0, "turns": 1 } }));
    assert_eq!(stuck_sessions(&[&with_ttft, &many_edits]).iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["e", "w"]);

    let fr = |c: i64, p: i64| json!({ "compactions": c, "aborts": 0, "errors": 0, "permissionRequests": p, "askUser": 0, "modelChanges": 0, "modeChanges": 0, "toolFailures": 0, "subagentFailures": 0 });
    let a = sess("a", json!({ "exec": lat(json!([[T::STUCK_TTFT_MS, T::STUCK_TTFT_MS + 1.0], [1, 2]])), "analysis": { "filesReedited": 1, "extraEdits": T::STUCK_EXTRA_EDITS, "maxConsecutiveFailures": T::STUCK_CONSECUTIVE_FAILURES, "turns": 1 } }));
    let b = sess("b", json!({ "project": "q", "projectLabel": "q", "friction": fr(T::STUCK_COMPACTIONS - 1, T::STUCK_PERMISSIONS - 1) }));
    let c = sess("c", json!({ "friction": fr(T::STUCK_COMPACTIONS, 0) }));
    let st = stuck_sessions(&[&a, &b, &c]);
    assert_eq!(st.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
    assert_eq!(st[0].reasons, ["待ち時間", "失敗の連続", "余分な編集の多さ"]);
    assert_eq!(st[1].reasons, ["compaction"]);
    assert!(stuck_by_project(&st, &[&a, &b, &c]).is_empty());
    let fill: Vec<SessionSummary> = (0..T::MIN_SESSIONS - 2).map(|i| sess(&format!("f{i}"), json!({}))).collect();
    let mut xs = vec![&a, &b, &c];
    xs.extend(fill.iter());
    assert_eq!(
        atlas_core::json::to_js_string(&stuck_by_project(&st, &xs)).unwrap(),
        format!(r#"[{{"project":"p","projectLabel":"p","stuck":2,"total":{},"reasons":{{"待ち時間":1,"失敗の連続":1,"余分な編集の多さ":1,"compaction":1}}}}]"#, T::MIN_SESSIONS)
    );
}

#[test]
fn skill_stats_split_by_min_sessions() {
    let with_s: Vec<SessionSummary> = (0..5).map(|i| failing(&format!("s{i}"), json!({ "skills": { "my-skill": [1, 0, 0] }, "skillChars": { "my-skill": 1200 } }))).collect();
    let without: Vec<SessionSummary> = (0..3).map(|i| sess(&format!("n{i}"), json!({}))).collect();
    let installed = vec!["my-skill".to_string(), "unused-skill".to_string()];
    let r = skill_stats(&refs(&[with_s, without].concat()), Some(&installed));
    let s = &r.stats[0];
    assert_eq!((s.name.as_str(), s.calls, s.by_user, s.by_agent, s.chars, s.sessions, s.enough), ("my-skill", 5, 5, 0, Some(1200.0), 5, true));
    assert!((s.failure_with.unwrap() - 0.4).abs() < 1e-12);
    assert_eq!(s.failure_without, None);
    assert_eq!(r.unused, ["unused-skill"]);
}

fn analysis(requests: &[&str], tools: Vec<Vec<&str>>, ms: &[Option<f64>]) -> SessionAnalysis {
    SessionAnalysis {
        requests: requests.iter().map(|x| x.to_string()).collect(),
        turn_tools: tools.into_iter().map(|t| t.into_iter().map(String::from).collect()).collect(),
        turn_active_ms: ms.to_vec(),
        ..Default::default()
    }
}

#[test]
fn normalize_and_similarity() {
    assert_eq!(normalize_request("C:\\\\work\\\\x\\\\y.txt を 3 回読んで https://example.invalid/a にまとめて"), "<path> を <n> 回読んで <url> にまとめて");
    assert_eq!(normalize_request("/home/me/proj/src/main.ts の 7f3a2b1c9d の件"), "<path> の <id> の件");
    let a = trigrams(&normalize_request("リポジトリの README を更新して"));
    let b = trigrams(&normalize_request("リポジトリの README を更新して!"));
    let c = trigrams(&normalize_request("ビルドが失敗する原因を調べて"));
    assert!(jaccard(&a, &b) >= T::SIMILARITY);
    assert!(jaccard(&a, &c) < T::SIMILARITY);
    assert_eq!(jaccard(&vec![], &vec![]), 1.0);
    assert!(is_trivial_request("OK") && is_trivial_request("/clear") && is_probe_request("Reply with exactly: OK"));
    // u なしの i は ASCII の英字だけを同一視する(ſ は s ではない)
    assert!(!is_trivial_request("yeſ"));
}

#[test]
fn request_candidates_rules() {
    let s1 = analysis(&["リポジトリの README を更新してください。章立ては変えない", "OK", "Reply with exactly: OK"], vec![vec![], vec![], vec![]], &[Some(60_000.0), Some(1000.0), Some(1000.0)]);
    let s2 = analysis(&["リポジトリの README を更新してください。章立ては変えないで"], vec![vec![]], &[Some(120_000.0)]);
    let s3 = analysis(&["リポジトリの README を更新して下さい。章立ては変えない", "短い"], vec![vec![], vec![]], &[Some(180_000.0), None]);
    let s4 = analysis(&["OK", "OK", "OK"], vec![vec![], vec![], vec![]], &[Some(1.0), Some(1.0), Some(1.0)]);
    let src = [("s1", &s1), ("s2", &s2), ("s3", &s3), ("s4", &s4)].map(|(id, a)| CandidateSource { id, project: "p", analysis: a });
    let r = request_candidates(&src, false);
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].kind, r[0].count, r[0].sessions.clone(), r[0].median_ms, r[0].score), ("request", 3, vec!["s1".to_string(), "s2".into(), "s3".into()], Some(120_000.0), 6.0));
    assert!(r[0].representative.as_deref().unwrap().contains("README"));
    assert_eq!(r[0].examples.len(), 2);
    let one = analysis(&["リポジトリの README を更新してください。章立ては変えない"; 4], vec![vec![]; 4], &[Some(1.0); 4]);
    assert!(request_candidates(&[CandidateSource { id: "x", project: "p", analysis: &one }], false).is_empty());
    let an = &request_candidates(&src, true)[0];
    assert_eq!((an.representative.clone(), an.examples.len(), an.key.as_str()), (None, 0, "request-1"));
}

#[test]
fn tool_sequence_candidates_rules() {
    assert_eq!(collapse_runs(&["view", "view", "rg", "rg", "view"].map(String::from)), ["view", "rg", "view"]);
    assert!(is_periodic(&["rg", "view", "rg", "view"], 3));
    assert!(!is_periodic(&["rg", "view", "powershell"], 3));
    let seq = vec!["view", "apply_patch", "powershell", "apply_patch", "powershell"];
    let a = analysis(&["依頼 A の本文です(十分な長さ)"], vec![seq.clone()], &[Some(300_000.0)]);
    let b = analysis(&["依頼 B の本文です(十分な長さ)"], vec![seq.clone()], &[Some(600_000.0)]);
    let c = analysis(&["依頼 C の本文です(十分な長さ)"], vec![[seq.clone(), vec!["rg", "view", "rg", "view"]].concat()], &[Some(900_000.0)]);
    let d = analysis(&["閲覧だけ"], vec![vec!["view", "rg", "view", "glob", "rg", "view", "rg", "view", "glob"]], &[Some(100.0)]);
    let src = [("a", &a), ("b", &b), ("c", &c), ("d", &d)].map(|(id, a)| CandidateSource { id, project: "p", analysis: a });
    let r = tool_sequence_candidates(&src, false);
    assert_eq!((r[0].kind, r[0].key.clone(), r[0].count, r[0].median_ms, r[0].score), ("tools", seq.join(" → "), 3, Some(600_000.0), 30.0));
    assert_eq!(r[0].sessions, ["a", "b", "c"]);
    assert_eq!(r.iter().filter(|x| x.key.contains("apply_patch")).count(), 1);
    assert!(r.iter().all(|x| x.tools.as_ref().unwrap().iter().any(|t| !["view", "rg", "glob"].contains(&t.as_str()))));
    let j = analysis(&["判定の依頼文です。十分な長さ"; 5], vec![vec![]; 5], &[Some(1.0); 5]);
    let mut with_judge = src.to_vec();
    with_judge.push(CandidateSource { id: "j", project: atlas_core::project_keys::ATLAS_JUDGE_PROJECT, analysis: &j });
    let all = skill_candidates(&with_judge, false);
    let mut sorted: Vec<f64> = all.iter().map(|c| c.score).collect();
    sorted.sort_by(|x, y| y.partial_cmp(x).unwrap());
    assert_eq!(all.iter().map(|c| c.score).collect::<Vec<_>>(), sorted);
    assert!(!all.iter().any(|c| c.representative.as_deref().is_some_and(|r| r.contains("判定の依頼文"))));
}

// ---------- request-clusters.test.ts: 索引で数えても、1 件ずつ全部のまとまりと比べたときと同じ候補になる ----------

/// 変える前の requestCandidates(先に作ったまとまりから順に、代表との類似度がしきい値以上の最初のまとまりに入れる)
fn naive(sources: &[CandidateSource], anonymized: bool) -> Vec<Candidate> {
    struct Item<'a> {
        id: &'a str,
        text: &'a str,
        norm: String,
        grams: Trigrams,
        ms: Option<f64>,
    }
    let mut items = Vec::new();
    for s in sources {
        for (i, text) in s.analysis.requests.iter().enumerate() {
            let t = atlas_core::js::trim(text);
            if text.is_empty() || is_trivial_request(t) || is_probe_request(t) {
                continue;
            }
            let norm = normalize_request(text);
            if atlas_core::js::utf16_len(&norm) < T::MIN_REQUEST_CHARS {
                continue;
            }
            items.push(Item { id: s.id, text, grams: trigrams(&norm), norm, ms: s.analysis.turn_active_ms.get(i).copied().flatten() });
        }
    }
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for (ii, it) in items.iter().enumerate() {
        match clusters.iter_mut().find(|c| jaccard(&items[c[0]].grams, &it.grams) >= T::SIMILARITY) {
            Some(c) => c.push(ii),
            None => clusters.push(vec![ii]),
        }
    }
    let mut out = Vec::new();
    for c in &clusters {
        let mut sessions: Vec<String> = Vec::new();
        for &m in c {
            if !sessions.iter().any(|s| s == items[m].id) {
                sessions.push(items[m].id.into());
            }
        }
        if c.len() < T::MIN_REPEAT || sessions.len() < 2 {
            continue;
        }
        let sums: Vec<f64> = c.iter().map(|&m| c.iter().fold(0.0, |a, &o| a + jaccard(&items[m].grams, &items[o].grams))).collect();
        let mut best = 0;
        for k in 1..c.len() {
            if sums[k] > sums[best] {
                best = k;
            }
        }
        let rep = c[best];
        let med = median(&c.iter().filter_map(|&m| items[m].ms).collect::<Vec<_>>());
        out.push(Candidate {
            kind: "request",
            key: items[rep].norm.clone(),
            count: c.len() as i64,
            sessions,
            median_ms: med,
            score: c.len() as f64 * med.map_or(1.0, |m| 1f64.max(m.min(SCORE_MS_CAP) / 60_000.0)),
            representative: (!anonymized).then(|| items[rep].text.to_string()),
            examples: if anonymized { vec![] } else { c.iter().filter(|&&m| m != rep).take(3).map(|&m| items[m].text.to_string()).collect() },
            tools: None,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap().then(b.count.cmp(&a.count)));
    if anonymized {
        for (i, c) in out.iter_mut().enumerate() {
            c.key = format!("request-{}", i + 1);
        }
    }
    out
}

/// 決まった種から作る、似たもの(0〜1 語の差し替え)と似ていないものが混ざった依頼文(mulberry32)
fn random_sources(n: usize, seed0: u32) -> Vec<(String, SessionAnalysis)> {
    let mut seed = seed0;
    let mut rnd = |k: usize| -> usize {
        seed = seed.wrapping_add(0x6d2b79f5);
        let mut t = seed;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (((t ^ (t >> 14)) as f64 / 4294967296.0) * k as f64).floor() as usize
    };
    let words = ["テスト", "を", "直して", "ビルド", "エラー", "の", "原因", "調べて", "README", "に", "追記", "して", "レビュー", "お願い", "します", "ログ", "確認", "設定", "画面", "追加", "src/app.ts", "12", "fix"];
    let make = |rnd: &mut dyn FnMut(usize) -> usize| -> String {
        let len = 12 + rnd(8);
        (0..len).map(|_| words[rnd(words.len())]).collect::<Vec<_>>().join(" ")
    };
    let bases: Vec<String> = (0..15).map(|_| make(&mut rnd)).collect();
    (0..n)
        .map(|i| {
            let requests: Vec<String> = (0..3)
                .map(|_| {
                    if rnd(4) == 0 {
                        return make(&mut rnd);
                    }
                    let mut b: Vec<String> = bases[rnd(bases.len())].split(' ').map(String::from).collect();
                    let mut k = rnd(2);
                    while k > 0 {
                        let at = rnd(b.len());
                        b[at] = words[rnd(words.len())].to_string();
                        k -= 1;
                    }
                    b.join(" ")
                })
                .collect();
            let ms: Vec<Option<f64>> = (0..3).map(|_| if rnd(3) == 0 { None } else { Some(rnd(600_000) as f64) }).collect();
            (format!("s{}", i % 50), SessionAnalysis { requests, turn_active_ms: ms, ..Default::default() })
        })
        .collect()
}

#[test]
fn indexed_clustering_matches_naive() {
    for seed in [1u32, 42, 12345, 987654] {
        let data = random_sources(300, seed);
        let src: Vec<CandidateSource> = data.iter().map(|(id, a)| CandidateSource { id, project: "p", analysis: a }).collect();
        let got = request_candidates(&src, false);
        assert!(got.len() > 3);
        assert_eq!(got, naive(&src, false));
        assert_eq!(request_candidates(&src, true), naive(&src, true));
    }
}

// ---------- retention.test.ts: retentionItem ----------

#[test]
fn retention_item_shape() {
    let r: SessionRetention = serde_json::from_value(json!({
        "sessionId": "s", "outcome": "unattributable", "reason": "repo_not_found", "vcs": null, "root": null, "baseline": null, "evaluated": null,
        "hunks": [], "excludedHunks": 0,
        "counts": { "kept": 0, "modified": 0, "missing": 0, "unattributable": 2 },
        "lines": { "kept": 0, "modified": 0, "missing": 0, "unattributable": 5 },
        "provenance": { "aiChanges": "events", "baseline": null, "context": {} },
    }))
    .unwrap();
    assert_eq!(
        atlas_core::json::to_js_string(&retention_item(&r, &[])).unwrap(),
        r#"{"outcome":"unattributable","reason":"repo_not_found","vcs":null,"baseline":null,"on":"local","mapped":false,"hunks":[0,0,0,2],"lines":[0,0,0,5]}"#
    );
    let mut none = r.clone();
    none.outcome = atlas_core::vcs_retention::Outcome::NoAiChanges;
    none.computed_on = Some(atlas_core::vcs_retention::ComputedOn::Sender);
    none.path_mapped = Some(true);
    let it = retention_item(&none, &[]);
    assert_eq!((it.outcome.as_str(), it.on.as_str(), it.mapped), ("none", "sender", true));
}
