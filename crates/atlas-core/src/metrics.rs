//! sessions → metrics.json(packages/core/src/metrics.ts の移植)。
//! 全体 / プロジェクト / クライアント / モデル / 月別に集計する。
//! 浮動小数の和は TS 版と同じ順(セッションの並び順)に足す(結果をビット単位で同じにするため)。
//! 並列にするのは、互いに独立な集計(全体・プロジェクト別などの各バケツ、ターンの分類)だけ。

use crate::js::{self, JsMap};
use crate::jsdate;
use crate::tool_failure::add_causes;
use crate::turns::turn_metrics;
use crate::types::{
    AgentStatus, BucketContext, CompactionStats, Distribution, DistributionWithMean, InstalledInventory,
    InstalledSkillsSummary, InstructionScope, LatencyQuantiles, LineSource, MetricsBucket, MetricsFile, ModelBucket, Quantiles, QuantilesWithOutliers,
    SessionRecord, SkillTrigger, TokenSource, ToolCountMean, ToolResult, METRICS_SCHEMA_VERSION,
};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

/// 空のセッション(依頼 0・ツール 0・応答 0)
pub fn is_empty_session(s: &SessionRecord) -> bool {
    s.empty
}

/// 昇順に並べた ceil(p·n) 番目(total は並べた順の和)
pub fn distribution(values: &[f64]) -> Distribution {
    if values.is_empty() {
        return Distribution { total: 0.0, median: None, p90: None };
    }
    let mut s = values.to_vec();
    // (a, b) => a - b の安定ソート(NaN は記録に現れない)
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = s.len() as f64;
    let q = |p: f64| -> f64 {
        let i = ((p * n).ceil() - 1.0).max(0.0).min(n - 1.0);
        s[i as usize]
    };
    let total = s.iter().fold(0.0, |a, b| a + b);
    Distribution { total, median: Some(q(0.5)), p90: Some(q(0.9)) }
}

/// 中央値と p90(distribution と同じ定義: 昇順に並べた ceil(p·n) 番目)
pub fn quantiles(values: &[f64]) -> Quantiles {
    let d = distribution(values);
    Quantiles { n: values.len() as i64, median: d.median, p90: d.p90 }
}

fn add_to(map: &mut JsMap<i64>, from: &JsMap<i64>) {
    for (k, v) in from.js_entries() {
        map.inc(k, *v);
    }
}

fn add_to_f(map: &mut JsMap<f64>, from: &JsMap<f64>) {
    for (k, v) in from.js_entries() {
        map.add(k, *v);
    }
}

fn empty_bucket(sessions: usize) -> MetricsBucket {
    let mut b = MetricsBucket { sessions: sessions as i64, ..Default::default() };
    b.lines.by_source = JsMap(["shutdown", "tools", "none"].iter().map(|k| (k.to_string(), 0)).collect());
    b.token_sources = JsMap(TokenSource::ALL.iter().map(|k| (k.as_str().to_string(), 0)).collect());
    // 古い記録の removedRecorded が無くても、集計には 0 から足して必ず書く
    b.friction_detail.compaction = CompactionStats { removed_recorded: Some(0), ..Default::default() };
    b
}

pub fn bucket_of(sessions: &[&SessionRecord]) -> MetricsBucket {
    let mut b = empty_bucket(sessions.len());
    let mut durations: Vec<f64> = Vec::new();
    let mut actives: Vec<f64> = Vec::new();
    let mut tool_defs: Vec<f64> = Vec::new();
    let mut avail_tools: Vec<f64> = Vec::new();
    for s in sessions {
        let t = &s.tokens;
        if t.input.is_some() {
            b.sessions_with_input_tokens += 1;
        }
        b.turns += s.turns;
        b.autopilot_continuations += s.autopilot_continuations;
        b.token_sources.inc(t.source.as_str(), 1);
        if t.source == TokenSource::None {
            b.sessions_missing_tokens += 1;
        }
        b.tokens.input += t.input.unwrap_or(0.0);
        b.tokens.output += t.output;
        b.tokens.cache_read += t.cache_read.unwrap_or(0.0);
        b.tokens.cache_write += t.cache_write.unwrap_or(0.0);
        b.tokens.reasoning += t.reasoning.unwrap_or(0.0);
        b.tokens.premium_requests += t.premium_requests.unwrap_or(0.0);
        b.tokens.nano_aiu += t.nano_aiu.unwrap_or(0.0);
        b.tokens.requests += t.requests.unwrap_or(0.0);

        b.tools.total += s.tools.total;
        b.tools.internal += s.tools.internal.total;
        add_to(&mut b.tools.by_name, &s.tools.by_name);
        for (server, by_tool) in s.tools.mcp.js_entries() {
            for (_, v) in by_tool.js_entries() {
                b.tools.mcp.inc(server, *v);
            }
        }
        for (k, r) in s.tools.results.js_entries() {
            let t = b.tools.results.entry(k.clone()).or_insert_with(|| ToolResult { success: 0, failure: 0, denied: 0, causes: None });
            t.success += r.success;
            t.failure += r.failure;
            t.denied += r.denied;
            if let Some(c) = &r.causes {
                add_causes(t.causes.get_or_insert_with(JsMap::new), Some(c));
            }
        }
        let lines = &s.lines;
        b.lines.added += lines.added;
        b.lines.removed += lines.removed;
        let src = match lines.source {
            LineSource::Shutdown => "shutdown",
            LineSource::Tools => "tools",
            LineSource::None => "none",
        };
        b.lines.by_source.inc(src, 1);
        if lines.source != LineSource::None {
            b.lines.sessions_with_record += 1;
        }

        if !s.skills.is_empty() {
            b.skills.sessions_with_any += 1;
        }
        for sk in &s.skills {
            b.skills.total += 1;
            b.skills.by_name.inc(&sk.name, 1);
            match sk.trigger {
                Some(SkillTrigger::User) => b.skills.by_trigger.user += 1,
                Some(SkillTrigger::Agent) => b.skills.by_trigger.agent += 1,
                None => b.skills.by_trigger.unknown += 1,
            }
        }
        if !s.agents.is_empty() {
            b.agents.sessions_with_any += 1;
        }
        for a in &s.agents {
            let failed = a.status == AgentStatus::Failed;
            b.agents.total += 1;
            if failed {
                b.agents.failed += 1;
            }
            b.agents.by_name.inc(&a.name, 1);
            let d = b.agents.by_name_detail.entry(a.name.clone()).or_default();
            d.runs += 1;
            if failed {
                d.failed += 1;
            }
            d.tokens += a.total_tokens.unwrap_or(0.0);
        }
        b.hooks.total += s.hooks.total;
        add_to(&mut b.hooks.by_type, &s.hooks.by_type);

        if !s.instructions.is_empty() {
            b.instructions.sessions_with_any += 1;
        }
        let mut seen_files: HashSet<String> = HashSet::new();
        for i in &s.instructions {
            let key = if i.scope == InstructionScope::User { format!("{} (user)", i.file.as_str()) } else { i.file.as_str().to_string() };
            let e = b.instructions.by_file.entry(key.clone()).or_default();
            e.chars += i.chars;
            if seen_files.insert(key) {
                e.sessions += 1;
            }
        }
        let w = &s.wiki;
        if w.index_reads + w.page_reads.len() as i64 + w.skill_calls.len() as i64 + w.writes + w.other_calls > 0 {
            b.wiki.sessions_with_any += 1;
        }
        b.wiki.index_reads += w.index_reads;
        b.wiki.page_reads += w.page_reads.len() as i64;
        b.wiki.skill_calls += w.skill_calls.len() as i64;
        b.wiki.writes += w.writes;

        let f = &mut b.friction;
        let sf = &s.friction;
        f.compactions += sf.compactions;
        f.aborts += sf.aborts;
        f.errors += sf.errors;
        f.permission_requests += sf.permission_requests;
        f.ask_user += sf.ask_user;
        f.model_changes += sf.model_changes;
        f.mode_changes += sf.mode_changes;
        f.tool_failures += sf.tool_failures;
        f.subagent_failures += sf.subagent_failures;

        // Phase 7
        let ex = &s.exec;
        add_to(&mut b.exec.modes.by_mode, &ex.modes.by_mode);
        b.exec.modes.inferred += ex.modes.inferred;
        for (k, e) in ex.efforts.js_entries() {
            let t = b.exec.efforts.entry(k.clone()).or_default();
            t.requests += e.requests;
            t.input += e.input;
            t.output += e.output;
            t.nano_aiu += e.nano_aiu;
        }
        add_to(&mut b.exec.initiators, &ex.initiators);
        if let Some(v) = ex.context.tool_definitions_tokens {
            tool_defs.push(v);
        }
        if let Some(v) = ex.context.available_tool_count {
            avail_tools.push(v);
        }
        let fd = &s.friction_detail;
        add_to(&mut b.friction_detail.permissions, &fd.permissions);
        add_to(&mut b.friction_detail.error_types, &fd.error_types);
        add_to(&mut b.friction_detail.subagent_failures, &fd.subagent_failures);
        let c = &mut b.friction_detail.compaction;
        let sc = &fd.compaction;
        c.recorded += sc.recorded;
        c.input += sc.input;
        c.output += sc.output;
        c.nano_aiu += sc.nano_aiu;
        c.tokens_removed += sc.tokens_removed;
        c.removed_recorded = Some(c.removed_recorded.unwrap_or(0) + sc.removed_recorded.unwrap_or(0));
        if let Some(td) = &s.todos {
            b.todos.sessions_with_db += 1;
            if td.total > 0.0 {
                b.todos.sessions_with_todos += 1;
            }
            b.todos.total += td.total;
            b.todos.deps += td.deps;
            add_to_f(&mut b.todos.by_status, &td.by_status);
        }
        if let Some(d) = s.duration_ms {
            durations.push(d);
        }
        if let Some(a) = s.active_ms {
            actives.push(a);
        }
    }
    // premium request は 0.33 倍などの和なので浮動小数の誤差を丸める(report の aggregate と同じ桁)
    b.tokens.premium_requests = js::round(b.tokens.premium_requests * 1000.0) / 1000.0;
    b.duration_ms = distribution(&durations);
    b.active_ms = distribution(&actives);
    let td = distribution(&tool_defs);
    let mean = (!tool_defs.is_empty()).then(|| js::round(td.total / tool_defs.len() as f64));
    let avail_sum = avail_tools.iter().fold(0.0, |a, x| a + x);
    b.exec.context = BucketContext {
        sessions: tool_defs.len() as i64,
        tool_definitions_tokens: DistributionWithMean { total: td.total, median: td.median, p90: td.p90, mean },
        available_tool_count: ToolCountMean {
            sessions: avail_tools.len() as i64,
            mean: (!avail_tools.is_empty()).then(|| js::round((avail_sum / avail_tools.len() as f64) * 10.0) / 10.0),
        },
    };
    b.todos.completion_rate = (b.todos.total > 0.0).then(|| b.todos.by_status.get("done").copied().unwrap_or(0.0) / b.todos.total);
    b
}

/// `[...keys].sort()`(UTF-16 の単位の順)
fn sorted_keys<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let mut v: Vec<&String> = keys.collect();
    v.sort_by(|a, b| js::cmp_utf16(a, b));
    v
}

/// モデル別の待ち時間(全リクエストを 1 本にまとめた中央値と p90)
pub fn latency_by_model(sessions: &[&SessionRecord]) -> JsMap<LatencyQuantiles> {
    let mut g: indexmap::IndexMap<String, (Vec<f64>, Vec<f64>)> = indexmap::IndexMap::new();
    for s in sessions {
        for (m, l) in s.exec.latency.js_entries() {
            let a = g.entry(m.clone()).or_default();
            a.0.extend_from_slice(&l.ttft);
            a.1.extend_from_slice(&l.duration);
        }
    }
    JsMap(sorted_keys(g.keys()).into_iter().map(|m| (m.clone(), LatencyQuantiles { ttft: quantiles(&g[m].0), duration: quantiles(&g[m].1) })).collect())
}

/// ツール別の所要時間(中央値と p90)。1 時間超は外れ値として件数だけ
pub fn tool_duration_stats(sessions: &[&SessionRecord]) -> JsMap<QuantilesWithOutliers> {
    let mut g: indexmap::IndexMap<String, (Vec<f64>, i64)> = indexmap::IndexMap::new();
    for s in sessions {
        for (k, v) in s.tools.durations.js_entries() {
            g.entry(k.clone()).or_default().0.extend_from_slice(v);
        }
        for (k, n) in s.tools.duration_outliers.js_entries() {
            g.entry(k.clone()).or_default().1 += n;
        }
    }
    JsMap(
        sorted_keys(g.keys())
            .into_iter()
            .map(|k| {
                let q = quantiles(&g[k].0);
                (k.clone(), QuantilesWithOutliers { n: q.n, median: q.median, p90: q.p90, outliers: g[k].1 })
            })
            .collect(),
    )
}

fn group_by(sessions: &[&SessionRecord], key: impl Fn(&SessionRecord) -> String) -> JsMap<MetricsBucket> {
    let mut g: HashMap<String, Vec<&SessionRecord>> = HashMap::new();
    for s in sessions {
        g.entry(key(s)).or_default().push(s);
    }
    let keys = sorted_keys(g.keys());
    let buckets: Vec<MetricsBucket> = keys.par_iter().map(|k| bucket_of(&g[*k])).collect();
    JsMap(keys.into_iter().cloned().zip(buckets).collect())
}

/// 月(UTC の YYYY-MM。createdAt、無ければ updatedAt)
pub fn month_key(s: &SessionRecord) -> String {
    let t = s.created_at.as_deref().or(s.updated_at.as_deref());
    let Some(t) = t.filter(|x| !x.is_empty()) else {
        return "(unknown)".into();
    };
    match jsdate::parse_ms(t) {
        Some(ms) => js::utf16_slice(&jsdate::to_iso(ms), 0, 7).into_owned(),
        None => "(unknown)".into(),
    }
}

fn by_model(sessions: &[&SessionRecord]) -> JsMap<ModelBucket> {
    let mut out: JsMap<ModelBucket> = JsMap::new();
    for s in sessions {
        for (m, t) in s.tokens.by_model.js_entries() {
            let b = out.entry(m.clone()).or_default();
            b.sessions += 1;
            b.requests += t.requests.unwrap_or(0.0);
            b.input += t.input.unwrap_or(0.0);
            b.output += t.output;
            b.cache_read += t.cache_read.unwrap_or(0.0);
            b.cache_write += t.cache_write.unwrap_or(0.0);
            b.reasoning += t.reasoning.unwrap_or(0.0);
            b.premium_requests += t.premium_requests.unwrap_or(0.0);
            b.nano_aiu += t.nano_aiu.unwrap_or(0.0);
        }
    }
    JsMap(sorted_keys(out.keys()).into_iter().map(|k| (k.clone(), out[k].clone())).collect())
}

/// インストール済みの skill 名(~/.copilot/skills/ とプラグインの skills/)。重複を除いて辞書順
pub fn installed_skill_names(inv: &InstalledInventory) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut v: Vec<String> = Vec::new();
    for n in inv.skills.iter().chain(inv.plugins.iter().flat_map(|p| p.skills.iter())) {
        if seen.insert(n) {
            v.push(n.clone());
        }
    }
    v.sort_by(|a, b| js::cmp_utf16(a, b));
    v
}

/// インストール済みだが sessions で一度も呼ばれなかった skill(名前は大文字小文字を区別しない)
pub fn unused_installed_skills(inv: &InstalledInventory, sessions: &[&SessionRecord]) -> Vec<String> {
    let used: HashSet<String> = sessions.iter().flat_map(|s| s.skills.iter().map(|k| js::to_lower(&k.name))).collect();
    installed_skill_names(inv).into_iter().filter(|n| !used.contains(&js::to_lower(n))).collect()
}

/// sessions → metrics.json(全体 / プロジェクト / クライアント / モデル / 月別)。
/// 空のセッション(依頼 0・ツール 0・応答 0)は集計から外し、件数だけ emptySessions に持つ。
/// installed(snapshot のインベントリ)があれば、期間内に未使用の skill も出す。
pub fn compute_metrics(all: &[&SessionRecord], installed: Option<&InstalledInventory>) -> MetricsFile {
    let generated_at = jsdate::now_iso();
    let sessions: Vec<&SessionRecord> = all.iter().copied().filter(|s| !is_empty_session(s)).collect();
    let ss = &sessions[..];
    let ((overall, by_project), ((by_client, by_month), (turns, rest))) = rayon::join(
        || rayon::join(|| bucket_of(ss), || group_by(ss, |s| s.project.clone())),
        || {
            rayon::join(
                || rayon::join(|| group_by(ss, |s| s.client.clone().unwrap_or_else(|| "(unknown)".into())), || group_by(ss, month_key)),
                || rayon::join(|| turn_metrics(ss), || (by_model(ss), latency_by_model(ss), tool_duration_stats(ss))),
            )
        },
    );
    let (by_model, latency, tool_durations) = rest;
    let installed_skills = installed.map(|inv| {
        let mut disabled = inv.disabled_skills.clone().unwrap_or_default();
        disabled.sort_by(|a, b| js::cmp_utf16(a, b));
        InstalledSkillsSummary { installed: installed_skill_names(inv), disabled, unused: unused_installed_skills(inv, ss) }
    });
    MetricsFile {
        schema_version: METRICS_SCHEMA_VERSION,
        generated_at,
        empty_sessions: (all.len() - sessions.len()) as i64,
        overall,
        by_project,
        by_client,
        by_month,
        by_model,
        installed_skills,
        latency,
        tool_durations,
        turns: Some(turns),
    }
}

#[cfg(test)]
mod tests;
