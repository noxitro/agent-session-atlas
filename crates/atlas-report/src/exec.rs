//! Phase 7: 絞り込んだ SessionSummary[] から「実行の性質」の集計を作る純関数(packages/report/src/lib/exec.ts の移植)。
//! 中央値・p90 は core の distribution と同じ定義(昇順に並べた ceil(p·n) 番目)。

use crate::types::{ContextTuple, SessionSummary};
use atlas_core::collate::locale_compare;
use atlas_core::js::{self, JsMap};
use indexmap::IndexMap;
use serde::Serialize;
use std::cmp::Ordering;

/// 推論強度の並び(弱い → 強い)。ここに無い値は後ろに名前順
pub const EFFORT_ORDER: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/// モードの並び
pub const MODE_ORDER: [&str; 3] = ["interactive", "plan", "autopilot"];
/// リクエストの起点の並び
pub const INITIATOR_ORDER: [&str; 4] = ["user", "agent", "sub-agent", "compaction"];
/// ツールの所要時間の表で上位に出す下限(回数)
pub const DURATION_MIN_CALLS: i64 = 5;

pub const UNKNOWN_KEY: &str = "(unknown)";

/// 昇順に並べた配列の p 分位
pub fn quantile_sorted(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let i = ((p * n as f64).ceil() as i64 - 1).max(0).min(n as i64 - 1);
    Some(sorted[i as usize])
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct QuantileRow {
    pub n: i64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
}

/// 数を昇順に並べる(`[...xs].sort((a, b) => a - b)`)
pub fn sort_nums(xs: &[f64]) -> Vec<f64> {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    s
}

pub fn quantiles_of(values: &[f64]) -> QuantileRow {
    let s = sort_nums(values);
    QuantileRow { n: s.len() as i64, median: quantile_sorted(&s, 0.5), p90: quantile_sorted(&s, 0.9) }
}

/// 並びの順(order に無いものは後ろ、UNKNOWN_KEY は最後)。同じ順位なら名前の順
pub fn order_by(order: &[&str], a: &str, b: &str) -> Ordering {
    let rank = |k: &str| -> usize {
        if k == UNKNOWN_KEY {
            return order.len() + 1;
        }
        order.iter().position(|x| *x == k).unwrap_or(order.len())
    };
    rank(a).cmp(&rank(b)).then_with(|| locale_compare(a, b))
}

/// 数の比べ方(JS の比較関数 `a - b` の符号。NaN は等しいとみなす)
pub fn num_cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortRow {
    pub key: String,
    pub requests: f64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LatencyRow {
    pub model: String,
    pub ttft: QuantileRow,
    pub duration: QuantileRow,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolDurationRow {
    pub tool: String,
    pub n: i64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
    /// 1 時間を超えて外した回数
    pub outliers: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextProjectRow {
    pub key: String,
    pub label: String,
    /// ツール定義の記録があるセッション数
    pub sessions: i64,
    pub tool_def_avg: f64,
    /// 文脈に占めるツール定義の割合の平均(3 つ揃ったセッションだけ)
    pub share_avg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModeRow {
    pub key: String,
    pub turns: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InitiatorRow {
    pub key: String,
    pub requests: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Modes {
    pub rows: Vec<ModeRow>,
    pub inferred: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Initiators {
    pub rows: Vec<InitiatorRow>,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAgg {
    /// ツール定義のトークンが分かるセッション数
    pub sessions: i64,
    pub tool_def_avg: Option<f64>,
    pub tool_def_median: Option<f64>,
    pub share_avg: Option<f64>,
    pub share_sessions: i64,
    pub available_tools_avg: Option<f64>,
    pub available_tools_sessions: i64,
    pub by_project: Vec<ContextProjectRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolDurations {
    pub rows: Vec<ToolDurationRow>,
    pub measured: i64,
    pub outliers: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Permissions {
    pub approved: i64,
    pub denied: i64,
    pub other: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NameCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionAgg {
    pub compactions: i64,
    pub recorded: f64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
    pub tokens_removed: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionAgg {
    pub permissions: Permissions,
    pub error_types: Vec<NameCount>,
    pub subagent_failures: Vec<NameCount>,
    pub compaction: CompactionAgg,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodosAgg {
    pub sessions_with_db: i64,
    pub sessions_with_todos: i64,
    pub total: f64,
    pub by_status: JsMap<f64>,
    pub deps: f64,
    pub completion_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecAggregate {
    pub modes: Modes,
    pub efforts: Vec<EffortRow>,
    pub initiators: Initiators,
    pub context: ContextAgg,
    pub latency: Vec<LatencyRow>,
    pub tool_durations: ToolDurations,
    pub friction: FrictionAgg,
    pub todos: TodosAgg,
}

/// `xs.reduce((a, x) => a + x, 0) / xs.length`
pub fn avg(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() { None } else { Some(xs.iter().fold(0.0, |a, x| a + x) / xs.len() as f64) }
}

fn add_into(map: &mut IndexMap<String, i64>, from: &JsMap<i64>) {
    for (k, v) in from.js_entries() {
        *map.entry(k.clone()).or_insert(0) += v;
    }
}

fn by_count(m: IndexMap<String, i64>) -> Vec<NameCount> {
    let mut v: Vec<NameCount> = m.into_iter().map(|(name, count)| NameCount { name, count }).collect();
    v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| locale_compare(&a.name, &b.name)));
    v
}

/// 文脈に占めるツール定義の割合(3 つ揃っていて合計が正のときだけ)
pub fn tool_share(c: Option<&ContextTuple>) -> Option<f64> {
    let c = c?;
    let (sys, conv, tool) = (c[0]?, c[1]?, c[2]?);
    let sum = sys + conv + tool;
    if sum > 0.0 { Some(tool / sum) } else { None }
}

pub fn exec_aggregate(sessions: &[&SessionSummary]) -> ExecAggregate {
    let mut modes: IndexMap<String, i64> = IndexMap::new();
    let mut inferred = 0;
    let mut efforts: IndexMap<String, EffortRow> = IndexMap::new();
    let mut initiators: IndexMap<String, i64> = IndexMap::new();
    let mut tool_defs: Vec<f64> = Vec::new();
    let mut shares: Vec<f64> = Vec::new();
    let mut avail: Vec<f64> = Vec::new();
    struct Proj {
        label: String,
        defs: Vec<f64>,
        shares: Vec<f64>,
    }
    let mut by_project: IndexMap<String, Proj> = IndexMap::new();
    let mut latency: IndexMap<String, (Vec<f64>, Vec<f64>)> = IndexMap::new();
    let mut durations: IndexMap<String, Vec<f64>> = IndexMap::new();
    let mut outliers: IndexMap<String, i64> = IndexMap::new();
    let mut permissions = Permissions { approved: 0, denied: 0, other: 0 };
    let mut error_types: IndexMap<String, i64> = IndexMap::new();
    let mut sub_failures: IndexMap<String, i64> = IndexMap::new();
    let mut compaction = CompactionAgg { compactions: 0, recorded: 0.0, input: 0.0, output: 0.0, nano_aiu: 0.0, tokens_removed: 0.0 };
    let mut todos = TodosAgg { sessions_with_db: 0, sessions_with_todos: 0, total: 0.0, by_status: JsMap::new(), deps: 0.0, completion_rate: None };

    for s in sessions {
        let e = &s.exec;
        add_into(&mut modes, &e.modes);
        inferred += e.modes_inferred;
        for (k, [requests, input, output, nano_aiu]) in e.efforts.js_entries() {
            let r = efforts.entry(k.clone()).or_insert_with(|| EffortRow { key: k.clone(), requests: 0.0, input: 0.0, output: 0.0, nano_aiu: 0.0 });
            r.requests += requests;
            r.input += input;
            r.output += output;
            r.nano_aiu += nano_aiu;
        }
        add_into(&mut initiators, &e.initiators);
        if let Some(def) = e.context.as_ref().and_then(|c| c[2]) {
            tool_defs.push(def);
            let share = tool_share(e.context.as_ref());
            if let Some(x) = share {
                shares.push(x);
            }
            let p = by_project.entry(s.project.clone()).or_insert_with(|| Proj { label: s.project_label.clone(), defs: vec![], shares: vec![] });
            p.defs.push(def);
            if let Some(x) = share {
                p.shares.push(x);
            }
        }
        if let Some(a) = e.context.as_ref().and_then(|c| c[3]) {
            avail.push(a);
        }
        for (m, (ttft, duration)) in e.latency.js_entries() {
            let l = latency.entry(m.clone()).or_default();
            l.0.extend_from_slice(ttft);
            l.1.extend_from_slice(duration);
        }
        for (t, v) in s.tools.durations.js_entries() {
            durations.entry(t.clone()).or_default().extend_from_slice(v);
        }
        add_into(&mut outliers, &s.tools.outliers);

        let f = &s.friction_detail;
        permissions.approved += f.permissions[0];
        permissions.denied += f.permissions[1];
        permissions.other += f.permissions[2];
        add_into(&mut error_types, &f.error_types);
        add_into(&mut sub_failures, &f.subagent_failures);
        compaction.compactions += s.friction.compactions;
        compaction.recorded += f.compaction[0];
        compaction.input += f.compaction[1];
        compaction.output += f.compaction[2];
        compaction.nano_aiu += f.compaction[3];
        compaction.tokens_removed += f.compaction[4];

        if let Some(t) = &s.todos {
            todos.sessions_with_db += 1;
            if t.total > 0.0 {
                todos.sessions_with_todos += 1;
            }
            todos.total += t.total;
            todos.deps += t.deps;
            for (k, n) in t.by_status.js_entries() {
                todos.by_status.add(k, *n);
            }
        }
    }
    todos.completion_rate = if todos.total > 0.0 { Some(todos.by_status.get("done").copied().unwrap_or(0.0) / todos.total) } else { None };

    let mut mode_rows: Vec<ModeRow> = modes.into_iter().map(|(key, turns)| ModeRow { key, turns }).collect();
    mode_rows.sort_by(|a, b| order_by(&MODE_ORDER, &a.key, &b.key));
    let mut init_rows: Vec<InitiatorRow> = initiators.into_iter().map(|(key, requests)| InitiatorRow { key, requests }).collect();
    init_rows.sort_by(|a, b| order_by(&INITIATOR_ORDER, &a.key, &b.key));
    let mut latency_rows: Vec<LatencyRow> = latency.into_iter().map(|(model, (t, d))| LatencyRow { model, ttft: quantiles_of(&t), duration: quantiles_of(&d) }).collect();
    // 表に出す件数(最初のトークンまでの件数)の多い順
    latency_rows.sort_by(|a, b| b.ttft.n.cmp(&a.ttft.n).then(b.duration.n.cmp(&a.duration.n)).then_with(|| locale_compare(&a.model, &b.model)));
    let mut tools: Vec<String> = durations.keys().cloned().collect();
    for k in outliers.keys() {
        if !durations.contains_key(k) {
            tools.push(k.clone());
        }
    }
    let mut duration_rows: Vec<ToolDurationRow> = tools
        .into_iter()
        .map(|tool| {
            let q = quantiles_of(durations.get(&tool).map_or(&[][..], |v| v.as_slice()));
            let o = outliers.get(&tool).copied().unwrap_or(0);
            ToolDurationRow { tool, n: q.n, median: q.median, p90: q.p90, outliers: o }
        })
        .collect();
    duration_rows.sort_by(|a, b| num_cmp(b.p90.unwrap_or(-1.0), a.p90.unwrap_or(-1.0)).then(b.n.cmp(&a.n)).then_with(|| locale_compare(&a.tool, &b.tool)));
    let sorted_defs = sort_nums(&tool_defs);
    let r1 = |x: Option<f64>| x.map(|x| js::round(x * 10.0) / 10.0);
    let mut efforts: Vec<EffortRow> = efforts.into_values().collect();
    efforts.sort_by(|a, b| order_by(&EFFORT_ORDER, &a.key, &b.key));
    let mut ctx_rows: Vec<ContextProjectRow> = by_project
        .into_iter()
        .map(|(key, p)| ContextProjectRow { key, label: p.label, sessions: p.defs.len() as i64, tool_def_avg: js::round(avg(&p.defs).unwrap_or(f64::NAN)), share_avg: avg(&p.shares) })
        .collect();
    ctx_rows.sort_by(|a, b| num_cmp(b.tool_def_avg, a.tool_def_avg).then(b.sessions.cmp(&a.sessions)).then_with(|| locale_compare(&a.key, &b.key)));

    let modes_total = mode_rows.iter().map(|r| r.turns).sum();
    let init_total = init_rows.iter().map(|r| r.requests).sum();
    ExecAggregate {
        modes: Modes { rows: mode_rows, inferred, total: modes_total },
        efforts,
        initiators: Initiators { rows: init_rows, total: init_total },
        context: ContextAgg {
            sessions: tool_defs.len() as i64,
            tool_def_avg: avg(&tool_defs).map(js::round),
            tool_def_median: quantile_sorted(&sorted_defs, 0.5),
            share_avg: avg(&shares),
            share_sessions: shares.len() as i64,
            available_tools_avg: r1(avg(&avail)),
            available_tools_sessions: avail.len() as i64,
            by_project: ctx_rows,
        },
        latency: latency_rows,
        tool_durations: ToolDurations { rows: duration_rows, measured: durations.values().map(|v| v.len() as i64).sum(), outliers: outliers.values().sum() },
        friction: FrictionAgg { permissions, error_types: by_count(error_types), subagent_failures: by_count(sub_failures), compaction },
        todos,
    }
}
