//! 絞り込んだ SessionSummary[] から画面の集計を作る純関数(packages/report/src/lib/aggregate.ts の移植)。
//! core の computeMetrics と同じ定義(合計は記録のあるセッションだけの和、月は UTC の YYYY-MM)。

use crate::exec::{exec_aggregate, num_cmp, order_by, ExecAggregate, EFFORT_ORDER};
use crate::filter::{has_people, UNKNOWN};
use crate::types::SessionSummary;
use atlas_core::collate::locale_compare;
use atlas_core::js::{self, JsMap};
use atlas_core::jsdate;
use atlas_core::tool_failure::{add_causes, failure_cause_label, FAILURE_CAUSES};
use atlas_core::types::{Friction, LineSource};
use indexmap::IndexMap;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
    pub premium_requests: f64,
    pub nano_aiu: f64,
    pub requests: f64,
}

/// 入力トークン記録の内訳(出所別)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageBreakdown {
    pub detailed: i64,
    pub shutdown: i64,
    pub output_only: i64,
    pub none: i64,
    pub empty: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgedAi {
    pub active_ms: f64,
    pub active_known: i64,
    pub output: f64,
    pub input: f64,
    pub input_known: i64,
    pub premium_requests: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub label: String,
    pub sessions: i64,
    pub sessions_with_input: i64,
    /// premium request の記録があるセッション数
    pub sessions_with_premium: i64,
    /// nano AIU の記録があるセッション数
    pub sessions_with_nano_aiu: i64,
    pub turns: i64,
    pub autopilot_continuations: i64,
    /// 空のセッション数(sessions に含む)
    pub empty_sessions: i64,
    pub tokens: TokenTotals,
    pub tools: i64,
    /// 内部ツールの呼び出し数。tools には含まない
    pub tools_internal: i64,
    pub lines_added: f64,
    pub lines_removed: f64,
    pub sessions_with_lines: i64,
    pub skills: i64,
    pub agents: i64,
    pub agent_failures: i64,
    pub hooks: i64,
    pub sessions_with_instructions: i64,
    pub sessions_with_wiki: i64,
    pub friction: i64,
    pub friction_detail: Friction,
    pub active_ms: f64,
    pub active_median_ms: Option<f64>,
    pub duration_ms: f64,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    /// 最終更新(更新日時のいちばん後。更新日時の無いセッションは開始日時で数える)
    pub updated_at: Option<String>,
    /// judgments の推定人手工数(判定済みセッションだけの和)
    pub judged_sessions: i64,
    pub human_hours: f64,
    pub human_low: f64,
    pub human_high: f64,
    pub judged_confidence: Option<f64>,
    pub judged_ai: JudgedAi,
}

/// モデルの推論強度別の行
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEffortRow {
    pub key: String,
    pub sessions: i64,
    pub requests: f64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub sessions: i64,
    pub requests: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub premium_requests: f64,
    pub efforts: Vec<ModelEffortRow>,
}

/// 利用ランキングのツール行。MCP ツールはサーバーごとに 1 行(key は mcp:<サーバー>)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRow {
    pub key: String,
    pub label: String,
    pub mcp_server: Option<String>,
    pub calls: i64,
    pub completed: i64,
    pub success: i64,
    pub failure: i64,
    pub denied: i64,
    pub sessions: i64,
    pub causes: JsMap<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpToolRow {
    pub name: String,
    pub calls: i64,
    pub failure: i64,
    pub causes: JsMap<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpRow {
    pub server: String,
    pub calls: i64,
    pub completed: i64,
    pub failure: i64,
    pub denied: i64,
    pub sessions: i64,
    pub tools: Vec<McpToolRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CauseToolRow {
    pub key: String,
    pub label: String,
    pub mcp_server: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CauseRow {
    pub cause: String,
    pub label: String,
    pub count: i64,
    pub sessions: i64,
    pub tools: Vec<CauseToolRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillRow {
    pub name: String,
    pub uses: i64,
    pub user: i64,
    pub agent: i64,
    pub unknown: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentRow {
    pub name: String,
    pub runs: i64,
    pub failed: i64,
    pub tokens: f64,
    pub sessions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CountRow {
    pub name: String,
    pub count: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRanking {
    pub tools: Vec<ToolRow>,
    pub mcp: Vec<McpRow>,
    pub skills: Vec<SkillRow>,
    pub agents: Vec<AgentRow>,
    pub hooks: Vec<CountRow>,
    /// 指示ファイル。count は注入されたセッション数
    pub instructions: Vec<CountRow>,
    /// 失敗の要因(多い順)。要因の記録がある失敗だけ
    pub causes: Vec<CauseRow>,
    /// 失敗のうち、要因の記録が無いもの
    pub causes_unrecorded: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub overall: Bucket,
    pub coverage: CoverageBreakdown,
    pub by_project: Vec<Bucket>,
    /// 人ごと(人のフォルダの名前が 1 件も無ければ空)。key が UNKNOWN の行は人のフォルダの下に無いセッション
    pub by_person: Vec<Bucket>,
    pub by_month: Vec<Bucket>,
    pub by_model: Vec<ModelRow>,
    pub usage: UsageRanking,
    pub exec: ExecAggregate,
}

/// 失敗率 =(失敗 + 拒否)/ 結果のあった回数。結果が 0 件なら None
pub fn failure_rate(completed: i64, failure: i64, denied: i64) -> Option<f64> {
    if completed > 0 { Some((failure + denied) as f64 / completed as f64) } else { None }
}

pub fn friction_total(f: &Friction) -> i64 {
    f.compactions + f.aborts + f.errors + f.permission_requests + f.ask_user + f.tool_failures + f.subagent_failures
}

fn median(values: &[f64]) -> Option<f64> {
    crate::exec::quantile_sorted(&crate::exec::sort_nums(values), 0.5)
}

fn round_to(x: f64, k: f64) -> f64 {
    js::round(x * k) / k
}

/// 空でない文字列(JS の真偽)
fn nonempty(s: Option<&str>) -> Option<&str> {
    s.filter(|x| !x.is_empty())
}

pub fn bucket(key: &str, label: &str, sessions: &[&SessionSummary]) -> Bucket {
    let mut b = Bucket { key: key.into(), label: label.into(), sessions: sessions.len() as i64, ..Default::default() };
    let (mut conf_sum, mut conf_n) = (0.0, 0);
    let mut actives: Vec<f64> = Vec::new();
    for s in sessions {
        let t = &s.tokens;
        if t.input.is_some() {
            b.sessions_with_input += 1;
        }
        if t.premium_requests.is_some() {
            b.sessions_with_premium += 1;
        }
        if t.nano_aiu.is_some() {
            b.sessions_with_nano_aiu += 1;
        }
        b.turns += s.turns;
        b.autopilot_continuations += s.autopilot_continuations;
        if s.empty {
            b.empty_sessions += 1;
        }
        b.tokens.input += t.input.unwrap_or(0.0);
        b.tokens.output += t.output;
        b.tokens.cache_read += t.cache_read.unwrap_or(0.0);
        b.tokens.cache_write += t.cache_write.unwrap_or(0.0);
        b.tokens.reasoning += t.reasoning.unwrap_or(0.0);
        b.tokens.premium_requests += t.premium_requests.unwrap_or(0.0);
        b.tokens.nano_aiu += t.nano_aiu.unwrap_or(0.0);
        b.tokens.requests += t.requests.unwrap_or(0.0);
        b.tools += s.tools.total;
        b.tools_internal += s.tools.internal;
        b.lines_added += s.lines.added;
        b.lines_removed += s.lines.removed;
        if s.lines.source != LineSource::None {
            b.sessions_with_lines += 1;
        }
        b.skills += s.skills.js_entries().iter().fold(0, |a, (_, t)| a + t[0] + t[1] + t[2]);
        b.agents += s.agents.total;
        b.agent_failures += s.agents.failed;
        b.hooks += s.hooks.total;
        if !s.instructions.is_empty() {
            b.sessions_with_instructions += 1;
        }
        let w = &s.wiki;
        if w.index_reads + w.page_reads + w.skill_calls + w.writes > 0 {
            b.sessions_with_wiki += 1;
        }
        let (fd, f) = (&mut b.friction_detail, &s.friction);
        fd.compactions += f.compactions;
        fd.aborts += f.aborts;
        fd.errors += f.errors;
        fd.permission_requests += f.permission_requests;
        fd.ask_user += f.ask_user;
        fd.model_changes += f.model_changes;
        fd.mode_changes += f.mode_changes;
        fd.tool_failures += f.tool_failures;
        fd.subagent_failures += f.subagent_failures;
        b.friction += friction_total(f);
        if let Some(a) = s.active_ms {
            b.active_ms += a;
            actives.push(a);
        }
        b.duration_ms += s.duration_ms.unwrap_or(0.0);
        // createdAt ?? updatedAt(null だけを飛ばす。'' はそのまま偽として扱う)
        let at = s.created_at.as_deref().or(s.updated_at.as_deref());
        if let Some(at) = nonempty(at) {
            if b.first_at.as_deref().is_none_or(|f| f.is_empty() || js::cmp_utf16(at, f) == Ordering::Less) {
                b.first_at = Some(at.to_string());
            }
            if b.last_at.as_deref().is_none_or(|l| l.is_empty() || js::cmp_utf16(at, l) == Ordering::Greater) {
                b.last_at = Some(at.to_string());
            }
        }
        let up = s.updated_at.as_deref().or(s.created_at.as_deref());
        if let Some(up) = nonempty(up) {
            let newer = match nonempty(b.updated_at.as_deref()) {
                None => true,
                Some(cur) => matches!((jsdate::parse_ms(up), jsdate::parse_ms(cur)), (Some(x), Some(y)) if x > y),
            };
            if newer {
                b.updated_at = Some(up.to_string());
            }
        }
        if let Some(j) = s.judgment.as_ref()
            && let Some(hours) = j.hours {
                b.judged_sessions += 1;
                b.human_hours += hours;
                b.human_low += j.low.unwrap_or(hours);
                b.human_high += j.high.unwrap_or(hours);
                if let Some(c) = j.confidence {
                    conf_sum += c;
                    conf_n += 1;
                }
                let ai = &mut b.judged_ai;
                if let Some(a) = s.active_ms {
                    ai.active_ms += a;
                    ai.active_known += 1;
                }
                ai.output += t.output;
                if let Some(i) = t.input {
                    ai.input += i;
                    ai.input_known += 1;
                }
                ai.premium_requests += t.premium_requests.unwrap_or(0.0);
            }
    }
    b.active_median_ms = median(&actives);
    b.judged_confidence = if conf_n > 0 { Some(conf_sum / conf_n as f64) } else { None };
    b.human_hours = round_to(b.human_hours, 100.0);
    b.human_low = round_to(b.human_low, 100.0);
    b.human_high = round_to(b.human_high, 100.0);
    b.judged_ai.premium_requests = round_to(b.judged_ai.premium_requests, 1000.0);
    // 浮動小数の誤差(premium request は 0.33 倍などの和)を丸める
    b.tokens.premium_requests = round_to(b.tokens.premium_requests, 1000.0);
    b
}

/// 月キー(UTC の YYYY-MM)。core の monthKey と同じ定義
pub fn month_of(s: &SessionSummary) -> String {
    let t = s.created_at.as_deref().or(s.updated_at.as_deref());
    let Some(t) = nonempty(t) else {
        return "(unknown)".into();
    };
    match jsdate::parse_ms(t) {
        Some(ms) => js::utf16_slice(&jsdate::to_iso(ms), 0, 7).into_owned(),
        None => "(unknown)".into(),
    }
}

/// JS の `Number(s)`(10 進の数だけ。空文字は 0、読めなければ NaN)
fn js_number(s: &str) -> f64 {
    let t = js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().ok().filter(|_| !t.contains(['i', 'I', 'n', 'N'])).unwrap_or(f64::NAN)
}

/// first〜last の間の月を欠けなく並べる(記録の無い月も 0 として出す)
pub fn month_range(first: &str, last: &str) -> Vec<String> {
    let num = |s: &str, i: usize| s.split('-').nth(i).map_or(f64::NAN, js_number);
    let (mut y, mut m) = (num(first, 0), num(first, 1));
    let (ly, lm) = (num(last, 0), num(last, 1));
    let mut out = Vec::new();
    while y < ly || (y == ly && m <= lm) {
        let ms = js::num_to_string(m);
        out.push(format!("{}-{}", js::num_to_string(y), if js::utf16_len(&ms) < 2 { format!("0{ms}") } else { ms }));
        m += 1.0;
        if m > 12.0 {
            m = 1.0;
            y += 1.0;
        }
        if out.len() > 600 {
            break;
        }
    }
    out
}

fn group_by<'a>(sessions: &[&'a SessionSummary], key: impl Fn(&SessionSummary) -> String) -> IndexMap<String, Vec<&'a SessionSummary>> {
    let mut g: IndexMap<String, Vec<&SessionSummary>> = IndexMap::new();
    for s in sessions {
        g.entry(key(s)).or_default().push(s);
    }
    g
}

pub fn coverage_breakdown(sessions: &[&SessionSummary]) -> CoverageBreakdown {
    let mut c = CoverageBreakdown::default();
    for s in sessions {
        if s.empty {
            c.empty += 1;
        } else if s.tokens.input.is_some() {
            if s.tokens.source == atlas_core::types::TokenSource::Shutdown {
                c.shutdown += 1;
            } else {
                c.detailed += 1;
            }
        } else if s.coverage == "output-only" {
            c.output_only += 1;
        } else {
            c.none += 1;
        }
    }
    c
}

fn bucket_order(a: &Bucket, b: &Bucket) -> Ordering {
    num_cmp(b.tokens.output, a.tokens.output).then(b.sessions.cmp(&a.sessions)).then_with(|| locale_compare(&a.key, &b.key))
}

/// people: 人ごとにもまとめるか。None なら、渡したセッションに人のフォルダの名前が 1 件でもあればまとめる
pub fn aggregate(sessions: &[&SessionSummary], people: Option<bool>) -> Aggregate {
    let people = people.unwrap_or_else(|| has_people(sessions.iter().copied()));
    // new Map(sessions.map(...)) は同じキーなら後のもので上書きする
    let labels: HashMap<&str, &str> = sessions.iter().map(|s| (s.project.as_str(), s.project_label.as_str())).collect();
    let mut by_project: Vec<Bucket> = group_by(sessions, |s| s.project.clone()).iter().map(|(k, v)| bucket(k, labels.get(k.as_str()).copied().unwrap_or(k), v)).collect();
    by_project.sort_by(bucket_order);
    let mut by_person: Vec<Bucket> = if people {
        group_by(sessions, |s| s.person.clone().unwrap_or_else(|| UNKNOWN.into())).iter().map(|(k, v)| bucket(k, if k == UNKNOWN { "不明" } else { k }, v)).collect()
    } else {
        vec![]
    };
    by_person.sort_by(bucket_order);

    let months = group_by(sessions, month_of);
    let mut known: Vec<&String> = months.keys().filter(|k| *k != "(unknown)").collect();
    known.sort_by(|a, b| js::cmp_utf16(a, b));
    let month_keys = if known.is_empty() { vec![] } else { month_range(known[0], known[known.len() - 1]) };
    let mut by_month: Vec<Bucket> = month_keys.iter().map(|k| bucket(k, k, months.get(k).map_or(&[][..], |v| v.as_slice()))).collect();
    if let Some(v) = months.get("(unknown)") {
        by_month.push(bucket("(unknown)", "日時不明", v));
    }

    let mut models: IndexMap<String, ModelRow> = IndexMap::new();
    let mut model_efforts: IndexMap<String, IndexMap<String, ModelEffortRow>> = IndexMap::new();
    fn model_row<'m>(models: &'m mut IndexMap<String, ModelRow>, m: &str) -> &'m mut ModelRow {
        models.entry(m.to_string()).or_insert_with(|| ModelRow { model: m.into(), sessions: 0, requests: 0.0, input: 0.0, output: 0.0, cache_read: 0.0, premium_requests: 0.0, efforts: vec![] })
    }
    for s in sessions {
        for (m, by_effort) in s.exec.model_efforts.js_entries() {
            model_row(&mut models, m);
            let es = model_efforts.entry(m.clone()).or_default();
            for (k, [requests, input, output, nano_aiu]) in by_effort.js_entries() {
                let e = es.entry(k.clone()).or_insert_with(|| ModelEffortRow { key: k.clone(), sessions: 0, requests: 0.0, input: 0.0, output: 0.0, nano_aiu: 0.0 });
                e.sessions += 1;
                e.requests += requests;
                e.input += input;
                e.output += output;
                e.nano_aiu += nano_aiu;
            }
        }
        for (m, t) in s.by_model.js_entries() {
            let r = model_row(&mut models, m);
            r.sessions += 1;
            r.requests += t.requests.unwrap_or(0.0);
            r.input += t.input.unwrap_or(0.0);
            r.output += t.output;
            r.cache_read += t.cache_read.unwrap_or(0.0);
            r.premium_requests += t.premium_requests.unwrap_or(0.0);
        }
    }
    let mut by_model: Vec<ModelRow> = models
        .into_values()
        .map(|mut r| {
            r.premium_requests = round_to(r.premium_requests, 1000.0);
            let mut efforts: Vec<ModelEffortRow> = model_efforts.get(&r.model).map(|m| m.values().cloned().collect()).unwrap_or_default();
            efforts.sort_by(|a, b| order_by(&EFFORT_ORDER, &a.key, &b.key));
            r.efforts = efforts;
            r
        })
        .collect();
    by_model.sort_by(|a, b| num_cmp(b.output, a.output).then(b.sessions.cmp(&a.sessions)).then_with(|| locale_compare(&a.model, &b.model)));

    Aggregate {
        overall: bucket("all", "全体", sessions),
        coverage: coverage_breakdown(sessions),
        by_project,
        by_person,
        by_month,
        by_model,
        usage: usage_ranking(sessions),
        exec: exec_aggregate(sessions),
    }
}

/// 行を取り出す(無ければ作る)。同じセッションで 2 回目以降は sessions を数えない
struct Tally<T> {
    rows: IndexMap<String, (T, isize)>,
}

impl<T> Tally<T> {
    fn new() -> Self {
        Tally { rows: IndexMap::new() }
    }
    fn get(&mut self, key: &str, session_index: usize, make: impl FnOnce(&str) -> T, sessions: impl FnOnce(&mut T)) -> &mut T {
        let e = self.rows.entry(key.to_string()).or_insert_with(|| (make(key), -1));
        if e.1 != session_index as isize {
            e.1 = session_index as isize;
            sessions(&mut e.0);
        }
        &mut e.0
    }
    fn values(self) -> Vec<T> {
        self.rows.into_values().map(|e| e.0).collect()
    }
}

fn by_count_then_name<T>(count: impl Fn(&T) -> i64, name: impl Fn(&T) -> &str) -> impl Fn(&T, &T) -> Ordering {
    move |a, b| count(b).cmp(&count(a)).then_with(|| locale_compare(name(a), name(b)))
}

/// 絞り込んだセッションから利用ランキング(ツール・MCP・skill・agent・hook・指示ファイル)を作る
pub fn usage_ranking(sessions: &[&SessionSummary]) -> UsageRanking {
    let mut tools: Tally<ToolRow> = Tally::new();
    let mut mcp: Tally<(McpRow, IndexMap<String, McpToolRow>)> = Tally::new();
    let mut cause_rows: Tally<(CauseRow, IndexMap<String, CauseToolRow>)> = Tally::new();
    let mut causes_unrecorded = 0;
    let mut skills: Tally<SkillRow> = Tally::new();
    let mut agents: Tally<AgentRow> = Tally::new();
    let mut hooks: Tally<CountRow> = Tally::new();
    let mut instructions: Tally<CountRow> = Tally::new();
    let count_row = |name: &str| CountRow { name: name.into(), count: 0, sessions: 0 };

    for (i, s) in sessions.iter().enumerate() {
        let mut server_of: HashMap<&str, &str> = HashMap::new();
        for (server, by_tool) in s.tools.mcp.js_entries() {
            for t in by_tool.js_keys() {
                server_of.insert(t.as_str(), server.as_str());
            }
        }
        for (tool, calls) in s.tools.by_name.js_entries() {
            let issue = s.tools.issues.get(tool);
            let failure = issue.map_or(0, |x| x[0]);
            let denied = issue.map_or(0, |x| x[1]);
            let completed = issue.map_or(*calls, |x| x[2]);
            let server = server_of.get(tool.as_str()).copied();
            // JS では '' のサーバー名は偽(キーとラベルはツール名のまま)
            let server_t = server.filter(|x| !x.is_empty());
            let causes = s.tools.causes.as_ref().and_then(|c| c.get(tool));
            let recorded: i64 = causes.map_or(0, |c| c.values().sum());
            causes_unrecorded += (failure - recorded).max(0);
            if let Some(c) = causes {
                for (cause, n) in c.js_entries() {
                    let (row, tool_map) = cause_rows.get(
                        cause,
                        i,
                        |k| (CauseRow { cause: k.into(), label: failure_cause_label_or(k), count: 0, sessions: 0, tools: vec![] }, IndexMap::new()),
                        |r| r.0.sessions += 1,
                    );
                    row.count += n;
                    let label = match server_t {
                        Some(sv) if tool.starts_with(&format!("{sv}-")) => tool[sv.len() + 1..].to_string(),
                        _ => tool.clone(),
                    };
                    let t = tool_map.entry(tool.clone()).or_insert_with(|| CauseToolRow { key: tool.clone(), label, mcp_server: server.map(str::to_string), count: 0 });
                    t.count += n;
                }
            }
            let key = match server_t {
                Some(sv) => format!("mcp:{sv}"),
                None => tool.clone(),
            };
            let r = tools.get(
                &key,
                i,
                |k| ToolRow { key: k.into(), label: k.into(), mcp_server: None, calls: 0, completed: 0, success: 0, failure: 0, denied: 0, sessions: 0, causes: JsMap::new() },
                |r| r.sessions += 1,
            );
            r.label = server.unwrap_or(tool).to_string();
            r.mcp_server = server.map(str::to_string);
            r.calls += calls;
            r.completed += completed;
            r.failure += failure;
            r.denied += denied;
            r.success += completed - failure - denied;
            add_causes(&mut r.causes, causes);
            if let Some(sv) = server_t {
                let (m, tool_map) = mcp.get(
                    sv,
                    i,
                    |k| (McpRow { server: k.into(), calls: 0, completed: 0, failure: 0, denied: 0, sessions: 0, tools: vec![] }, IndexMap::new()),
                    |r| r.0.sessions += 1,
                );
                m.calls += calls;
                m.completed += completed;
                m.failure += failure;
                m.denied += denied;
                let mt = tool_map.entry(tool.clone()).or_insert_with(|| McpToolRow { name: tool.clone(), calls: 0, failure: 0, causes: JsMap::new() });
                mt.calls += calls;
                mt.failure += failure;
                add_causes(&mut mt.causes, causes);
            }
        }
        for (name, [user, agent, unknown]) in s.skills.js_entries() {
            let r = skills.get(name, i, |k| SkillRow { name: k.into(), uses: 0, user: 0, agent: 0, unknown: 0, sessions: 0 }, |r| r.sessions += 1);
            r.uses += user + agent + unknown;
            r.user += user;
            r.agent += agent;
            r.unknown += unknown;
        }
        for (name, (runs, failed, tokens)) in s.agents.by_name.js_entries() {
            let r = agents.get(name, i, |k| AgentRow { name: k.into(), runs: 0, failed: 0, tokens: 0.0, sessions: 0 }, |r| r.sessions += 1);
            r.runs += runs;
            r.failed += failed;
            r.tokens += tokens;
        }
        for (name, n) in s.hooks.by_type.js_entries() {
            hooks.get(name, i, count_row, |r| r.sessions += 1).count += n;
        }
        for name in s.instructions.js_keys() {
            instructions.get(name, i, count_row, |r| r.sessions += 1).count += 1;
        }
    }

    let mut tools = tools.values();
    tools.sort_by(by_count_then_name(|x: &ToolRow| x.calls, |x| &x.key));
    let mut mcp: Vec<McpRow> = mcp
        .values()
        .into_iter()
        .map(|(mut m, tool_map)| {
            let mut t: Vec<McpToolRow> = tool_map.into_values().collect();
            t.sort_by(by_count_then_name(|x: &McpToolRow| x.calls, |x| &x.name));
            m.tools = t;
            m
        })
        .collect();
    mcp.sort_by(by_count_then_name(|x: &McpRow| x.calls, |x| &x.server));
    let mut skills = skills.values();
    skills.sort_by(by_count_then_name(|x: &SkillRow| x.uses, |x| &x.name));
    let mut agents = agents.values();
    agents.sort_by(by_count_then_name(|x: &AgentRow| x.runs, |x| &x.name));
    let mut hooks = hooks.values();
    hooks.sort_by(by_count_then_name(|x: &CountRow| x.count, |x| &x.name));
    let mut instructions = instructions.values();
    instructions.sort_by(by_count_then_name(|x: &CountRow| x.count, |x| &x.name));
    let mut causes: Vec<CauseRow> = cause_rows
        .values()
        .into_iter()
        .map(|(mut c, tool_map)| {
            let mut t: Vec<CauseToolRow> = tool_map.into_values().collect();
            t.sort_by(by_count_then_name(|x: &CauseToolRow| x.count, |x| &x.key));
            c.tools = t;
            c
        })
        .collect();
    causes.sort_by(by_count_then_name(|x: &CauseRow| x.count, |x| &x.cause));
    UsageRanking { tools, mcp, skills, agents, hooks, instructions, causes, causes_unrecorded }
}

/// `FAILURE_CAUSE_LABELS[cause] ?? cause`
fn failure_cause_label_or(cause: &str) -> String {
    if FAILURE_CAUSES.contains(&cause) { failure_cause_label(cause).to_string() } else { cause.to_string() }
}

/// インストール済みだが、絞り込んだセッションで一度も呼ばれなかった skill(大文字小文字を区別しない)
pub fn unused_skills<'a>(installed: &[String], used: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let u: std::collections::HashSet<String> = used.into_iter().map(js::to_lower).collect();
    installed.iter().filter(|n| !u.contains(&js::to_lower(n))).cloned().collect()
}
