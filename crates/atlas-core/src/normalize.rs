//! 正規化セッションレコードを 1 件作る(packages/core/src/normalize.ts の移植)。events はストリームで消費する。
//!
//! イベントの data は形が決まっていないので serde_json::Value のまま読み、TS 版と同じ判定(typeof・?? ・真偽)で値を取り出す。
//! 文字列であるはずの項目に文字列以外が入っていたとき、TS 版はその値をそのまま書くが、Rust 版は `String(v)` にそろえる
//! (実データには現れない)。

use crate::classify::{is_autopilot_continuation, is_internal_tool, is_main_assistant_message, is_user_turn, normalize_model, FileOp, FileTracker};
use crate::event_types::is_known_event_type;
use crate::instructions::InstructionCollector;
use crate::js::{self, cmp_utf16, head, num, present, str_of, string_or_null, tail, truthy, JsMap};
use crate::jsdate;
use crate::tool_failure::{classify_tool_failure, is_denied_error};
use crate::turns::tool_kind;
use crate::types::*;
use crate::wiki::{empty_wiki, WikiClassifier};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// DB から読んだそのセッションの行
#[derive(Default, Clone, Copy)]
pub struct DbInput<'a> {
    pub session: Option<&'a DbSessionRow>,
    pub turns: &'a [DbTurnRow],
    pub usage: &'a [DbUsageRow],
    pub files: &'a [DbFileRow],
}

pub struct NormalizeInput<'a> {
    pub id: String,
    /// session-state/<id>/ が存在したか
    pub has_dir: Option<bool>,
    pub workspace: Option<&'a WorkspaceInfo>,
    pub db: DbInput<'a>,
    /// イベントの列(読み込みの失敗は Err で止める)
    pub events: Option<&'a mut dyn Iterator<Item = std::io::Result<CopilotEvent>>>,
    /// wiki 参照の分類(未指定なら数えない)
    pub wiki_classifier: Option<&'a WikiClassifier>,
}

const TEXT_LIMIT: usize = 2000;
const TIMELINE_LIMIT: usize = 400;
const IDLE_GAP_MS: i64 = 5 * 60 * 1000;
const DEDUPE_WINDOW_MS: i64 = 5000;
const SKILL_PAIR_WINDOW_MS: i64 = 120_000;
/// 続けて出る abort を 1 回の中断とみなす時間差
const ABORT_PAIR_WINDOW_MS: i64 = 2000;
/// ファイルを書き換えるツール(変更行数の手掛かり)
const FILE_EDIT_TOOLS: &[&str] = &["create", "edit", "str_replace_editor", "apply_patch"];
const ANALYSIS_TURNS: usize = 200;
const ANALYSIS_TOOLS_PER_TURN: usize = 40;
const UNKNOWN_KEY: &str = "(unknown)";
/// 1 時間を超えるツールの所要時間は外れ値として除く
pub const TOOL_DURATION_OUTLIER_MS: i64 = 3_600_000;

static SQLITE_TIME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?$").unwrap());

/// SQLite の datetime('now') 形式(UTC、タイムゾーン無し)を ISO に揃える
pub fn normalize_time(t: Option<&str>) -> Option<String> {
    let t = t.filter(|s| !s.is_empty())?;
    if SQLITE_TIME_RE.is_match(t) {
        return Some(format!("{}Z", t.replacen(' ', "T", 1)));
    }
    Some(t.to_string())
}

fn ms(t: Option<&str>) -> Option<i64> {
    let t = t.filter(|s| !s.is_empty())?;
    jsdate::parse_ms(t)
}

/// skill.invoked の trigger(user-invoked / agent-invoked)。それ以外・無しは None
pub fn skill_trigger(t: Option<&Value>) -> Option<SkillTrigger> {
    match str_of(t) {
        Some("user-invoked") => Some(SkillTrigger::User),
        Some("agent-invoked") => Some(SkillTrigger::Agent),
        _ => None,
    }
}

/// ツールの toolTelemetry.metrics の行数(数値でなければ 0)
fn line_metric(v: Option<&Value>) -> f64 {
    num(v).filter(|x| *x > 0.0).unwrap_or(0.0)
}

static TRAILING_BACKSLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\+$").unwrap());

pub fn project_key(repository: Option<&str>, git_root: Option<&str>, cwd: Option<&str>) -> String {
    if let Some(r) = repository.filter(|r| !r.is_empty()) {
        return r.to_string();
    }
    let p = match git_root.or(cwd) {
        Some(p) if !p.is_empty() => p,
        _ => return "(unknown)".into(),
    };
    let n = p.replace('/', "\\");
    let n = TRAILING_BACKSLASHES.replace(&n, "");
    let b = n.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return format!("{}{}", (b[0] as char).to_ascii_uppercase(), &n[1..]);
    }
    n.into_owned()
}

pub fn empty_token_counts() -> TokenCounts {
    TokenCounts { input: Some(0.0), output: 0.0, cache_read: Some(0.0), cache_write: Some(0.0), reasoning: Some(0.0), premium_requests: Some(0.0), nano_aiu: Some(0.0), requests: Some(0.0) }
}

static SKILL_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<skill>((?s:.)*?)</skill>").unwrap());
static SKILL_NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<name>((?s:.)*?)</name>").unwrap());
static SKILL_LOCATION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<location>((?s:.)*?)</location>").unwrap());

/// システムメッセージの <available_skills> から skill の名前と置き場所を取り出す(無ければ None)。
/// 閉じタグが無い(途中で切れた)ときは、そこまでの項目を取る
pub fn available_skills_of(content: &str) -> Option<Vec<AvailableSkill>> {
    const OPEN: &str = "<available_skills>";
    const CLOSE: &str = "</available_skills>";
    let mut start = content.find(OPEN)?;
    let mut out = Vec::new();
    loop {
        let end = content[start..].find(CLOSE).map(|e| e + start);
        let block = &content[start..end.unwrap_or(content.len())];
        for m in SKILL_BLOCK_RE.captures_iter(block) {
            let inner = &m[1];
            let Some(name) = SKILL_NAME_RE.captures(inner).map(|c| js::trim(c.get(1).unwrap().as_str()).to_string()) else { continue };
            if name.is_empty() {
                continue;
            }
            let location = SKILL_LOCATION_RE.captures(inner).map(|c| js::trim(c.get(1).unwrap().as_str()).to_string()).filter(|s| !s.is_empty());
            out.push(AvailableSkill { name, location });
        }
        let Some(e) = end else { break };
        match content[e..].find(OPEN) {
            Some(s) => start = s + e,
            None => break,
        }
    }
    Some(out)
}

/// usage を一本化した 1 リクエスト
#[derive(Debug, Clone, PartialEq)]
pub struct UsageItem {
    pub from_db: bool,
    pub model: String,
    pub at: Option<i64>,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
    pub nano_aiu: Option<f64>,
    /// ユーザー起点なら倍率(=premium request)、それ以外 0、不明なら None
    pub premium: Option<f64>,
    pub agent_id: Option<String>,
    pub effort: Option<String>,
    pub initiator: Option<String>,
    pub ttft: Option<f64>,
    pub duration: Option<f64>,
}

/// 推論強度の表記をそろえる(小文字、空は None)
pub fn normalize_effort(v: Option<&Value>) -> Option<String> {
    let s = js::to_lower(js::trim(str_of(v)?));
    (!s.is_empty()).then_some(s)
}

fn normalize_effort_str(v: Option<&str>) -> Option<String> {
    let s = js::to_lower(js::trim(v?));
    (!s.is_empty()).then_some(s)
}

/// 0 以上の有限な数(ミリ秒)。それ以外は None
fn ms_value(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x >= 0.0)
}

fn from_db_row(r: &DbUsageRow) -> UsageItem {
    UsageItem {
        from_db: true,
        model: normalize_model(&r.model),
        at: ms(normalize_time(r.created_at.as_deref()).as_deref()),
        input: r.input_tokens.unwrap_or(0.0),
        output: r.output_tokens.unwrap_or(0.0),
        cache_read: r.cache_read_tokens.unwrap_or(0.0),
        cache_write: r.cache_write_tokens.unwrap_or(0.0),
        reasoning: r.reasoning_tokens.unwrap_or(0.0),
        nano_aiu: r.total_nano_aiu,
        premium: match r.initiator.as_deref() {
            None => None,
            Some("user") => Some(r.request_multiplier.unwrap_or(1.0)),
            Some(_) => Some(0.0),
        },
        agent_id: r.agent_id.clone(),
        effort: normalize_effort_str(r.reasoning_effort.as_deref()),
        initiator: r.initiator.clone().filter(|s| !s.is_empty()),
        ttft: ms_value(r.time_to_first_token_ms),
        duration: ms_value(r.duration_ms),
    }
}

/// `v ?? 0`(数値として使うもの)
fn num_or0(v: Option<&Value>) -> f64 {
    present(v).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `v ?? null`(数値として使うもの)
fn num_or_null(v: Option<&Value>) -> Option<f64> {
    present(v).and_then(Value::as_f64)
}

fn from_usage_record(e: &CopilotEvent) -> Option<UsageItem> {
    let u = e.data.as_ref()?.get("usage").filter(|u| truthy(Some(u)))?;
    let model = str_of(u.get("model"))?;
    let initiator = present(u.get("initiator"));
    Some(UsageItem {
        from_db: false,
        model: normalize_model(model),
        at: ms(event_at(e).as_deref()),
        input: num_or0(u.get("inputTokens")),
        output: num_or0(u.get("outputTokens")),
        cache_read: num_or0(u.get("cacheReadTokens")),
        cache_write: num_or0(u.get("cacheWriteTokens")),
        reasoning: num_or0(u.get("reasoningTokens")),
        nano_aiu: num_or_null(u.get("copilotUsage").and_then(|c| c.get("totalNanoAiu"))),
        premium: match initiator {
            None => None,
            Some(Value::String(s)) if s == "user" => Some(num_or0(u.get("cost"))),
            Some(_) => Some(0.0),
        },
        agent_id: string_or_null(e.agent_id.as_ref()),
        effort: normalize_effort(u.get("reasoningEffort")),
        initiator: str_of(u.get("initiator")).filter(|s| !s.is_empty()).map(str::to_string),
        ttft: ms_value(js::num(u.get("timeToFirstTokenMs"))),
        duration: ms_value(js::num(u.get("duration"))),
    })
}

static QUOTA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)402(?-u:\b)|quota").unwrap());
static RATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)429(?-u:\b)|rate[^\n\r\x{2028}\x{2029}]?limit|session limit|exceeded your [^\n\r\x{2028}\x{2029}]*limit").unwrap());
static ABORT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)abort").unwrap());
static NO_RESPONSE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)no response").unwrap());

/// subagent.failed の error を分類する(quota / rate_limit / aborted / no_response / other / unknown)
pub fn subagent_failure_reason(err: Option<&Value>) -> &'static str {
    let s = match err {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(v @ (Value::Object(_) | Value::Array(_))) => match present(v.get("message")) {
            Some(m) => js::to_js_string(m),
            None => crate::json::to_js_string(v).unwrap_or_default(),
        },
        Some(v) => js::to_js_string(v),
    };
    if js::trim(&s).is_empty() {
        return "unknown";
    }
    if QUOTA_RE.is_match(&s) {
        return "quota";
    }
    if RATE_RE.is_match(&s) {
        return "rate_limit";
    }
    if ABORT_RE.is_match(&s) {
        return "aborted";
    }
    if NO_RESPONSE_RE.is_match(&s) {
        return "no_response";
    }
    "other"
}

fn num_key(x: f64) -> u64 {
    if x == 0.0 { 0 } else { x.to_bits() }
}

/// assistant_usage_events を優先し、usage_record は DB に無いものだけ足す。
/// 同一リクエストの判定: model・input・output が一致し、時刻差が 5 秒以内
pub fn merge_usage(db_rows: &[DbUsageRow], records: Vec<UsageItem>) -> (Vec<UsageItem>, i64) {
    let mut items: Vec<UsageItem> = db_rows.iter().map(from_db_row).collect();
    let n_db = items.len();
    // 同じ model・input・output の DB の行(元の順)。TS 版は全行を順に見て最も近いものを選ぶ(同じ近さなら先の行)。結果は同じ
    let mut by_key: HashMap<(String, u64, u64), Vec<usize>> = HashMap::new();
    for (i, d) in items.iter().enumerate() {
        by_key.entry((d.model.clone(), num_key(d.input), num_key(d.output))).or_default().push(i);
    }
    let mut used = vec![false; n_db];
    let mut duplicates = 0;
    for u in records {
        let mut best: Option<usize> = None;
        let mut best_dt = i64::MAX;
        if let Some(cands) = by_key.get(&(u.model.clone(), num_key(u.input), num_key(u.output))) {
            for &i in cands {
                if used[i] {
                    continue;
                }
                let d = &items[i];
                let dt = match (d.at, u.at) {
                    (Some(a), Some(b)) => (a - b).abs(),
                    _ => 0,
                };
                if dt <= DEDUPE_WINDOW_MS && dt < best_dt {
                    best = Some(i);
                    best_dt = dt;
                }
            }
        }
        match best {
            Some(i) => {
                used[i] = true;
                duplicates += 1;
                // DB の行に無い項目(推論強度・起点・待ち時間)は同じリクエストの usage_record で補う
                let d = &mut items[i];
                if d.effort.is_none() {
                    d.effort = u.effort;
                }
                if d.initiator.is_none() {
                    d.initiator = u.initiator;
                }
                if d.ttft.is_none() {
                    d.ttft = u.ttft;
                }
                if d.duration.is_none() {
                    d.duration = u.duration;
                }
            }
            None => items.push(u),
        }
    }
    (items, duplicates)
}

fn add_item(t: &mut TokenCounts, u: &UsageItem) {
    t.input = Some(t.input.unwrap_or(0.0) + u.input);
    t.output += u.output;
    t.cache_read = Some(t.cache_read.unwrap_or(0.0) + u.cache_read);
    t.cache_write = Some(t.cache_write.unwrap_or(0.0) + u.cache_write);
    t.reasoning = Some(t.reasoning.unwrap_or(0.0) + u.reasoning);
    if let Some(n) = u.nano_aiu {
        t.nano_aiu = Some(t.nano_aiu.unwrap_or(0.0) + n);
    }
    if let Some(p) = u.premium {
        t.premium_requests = Some(t.premium_requests.unwrap_or(0.0) + p);
    }
    t.requests = Some(t.requests.unwrap_or(0.0) + 1.0);
}

/// `Object.entries(v)`(オブジェクトは JS のキーの順、配列は添字)
fn js_entries(v: &Value) -> Vec<(String, &Value)> {
    match v {
        Value::Object(o) => {
            if !o.keys().any(|k| js::array_index(k).is_some()) {
                return o.iter().map(|(k, v)| (k.clone(), v)).collect();
            }
            let mut idx: Vec<(u32, (String, &Value))> = Vec::new();
            let mut rest: Vec<(String, &Value)> = Vec::new();
            for (k, v) in o {
                match js::array_index(k) {
                    Some(n) => idx.push((n, (k.clone(), v))),
                    None => rest.push((k.clone(), v)),
                }
            }
            idx.sort_by_key(|x| x.0);
            idx.into_iter().map(|x| x.1).chain(rest).collect()
        }
        Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect(),
        _ => Vec::new(),
    }
}

fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)) | Some(Value::Array(_)))
}

fn shutdown_totals(e: Option<&CopilotEvent>) -> Option<ShutdownTotals> {
    let data = e?.data.as_ref();
    let mm = data.and_then(|d| d.get("modelMetrics"));
    if !truthy(mm) || !is_object(mm) {
        return None;
    }
    let d = data.unwrap();
    let acc = d.get("accountingSnapshot");
    let mut t = ShutdownTotals {
        premium_requests: num_or_null(d.get("totalPremiumRequests")).or_else(|| num_or_null(acc.and_then(|a| a.get("totalPremiumRequestCost")))),
        nano_aiu: num_or_null(d.get("totalNanoAiu")).or_else(|| num_or_null(acc.and_then(|a| a.get("totalNanoAiu")))),
        ..Default::default()
    };
    if present(d.get("totalPremiumRequests")).is_some() {
        t.premium_requests = num_or_null(d.get("totalPremiumRequests"));
    }
    if present(d.get("totalNanoAiu")).is_some() {
        t.nano_aiu = num_or_null(d.get("totalNanoAiu"));
    }
    for (_, v) in js_entries(mm.unwrap()) {
        let u = present(v.get("usage"));
        let g = |k: &str| num_or0(u.and_then(|u| u.get(k)));
        t.input += g("inputTokens");
        t.output += g("outputTokens");
        t.cache_read += g("cacheReadTokens");
        t.cache_write += g("cacheWriteTokens");
        t.reasoning += g("reasoningTokens");
    }
    Some(t)
}

static PATCH_FILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(?:^|[\r\x{2028}\x{2029}])\*\*\* (Add|Update|Delete) File: ([^\n\r\x{2028}\x{2029}]+)").unwrap());

/// apply_patch の本文から対象ファイルと操作を拾う
fn patch_files(patch: &str) -> Vec<(FileOp, String)> {
    if !patch.contains("*** ") {
        return Vec::new();
    }
    PATCH_FILE_RE
        .captures_iter(patch)
        .map(|m| {
            let op = match &m[1] {
                "Add" => FileOp::Create,
                "Delete" => FileOp::Delete,
                _ => FileOp::Edit,
            };
            (op, js::trim(&m[2]).to_string())
        })
        .collect()
}

fn args_of(d: Option<&Value>) -> Option<Value> {
    let a = d?.get("arguments")?;
    if let Value::String(s) = a {
        return Some(js::parse_json(s).unwrap_or_else(|_| Value::String(s.clone())));
    }
    Some(a.clone())
}

/// イベントの timestamp(`e.timestamp ?? null`)
fn event_at(e: &CopilotEvent) -> Option<String> {
    string_or_null(e.timestamp.as_ref())
}

#[derive(Clone, Copy, PartialEq)]
enum EffortFrom {
    Start,
    Change,
}

struct EffortChange {
    at: Option<i64>,
    effort: String,
    from: EffortFrom,
}

#[derive(Clone)]
struct LastCtx {
    system_tokens: Option<f64>,
    conversation_tokens: Option<f64>,
    tool_definitions_tokens: Option<f64>,
    source: ContextSource,
}

fn ctx_of(x: &Value, source: ContextSource) -> Option<LastCtx> {
    let mut s = num(x.get("systemTokens"));
    let mut c = num(x.get("conversationTokens"));
    let t = num(x.get("toolDefinitionsTokens"));
    // 再開の直前などに出る空の shutdown は system・会話とも 0。0 のままだと割合が 100% になるので記録なしとみなす
    if s == Some(0.0) && c == Some(0.0) {
        s = None;
        c = None;
    }
    if s.is_none() && c.is_none() && t.is_none() {
        return None;
    }
    Some(LastCtx { system_tokens: s, conversation_tokens: c, tool_definitions_tokens: t, source })
}

#[derive(Default, Clone)]
struct Ctx {
    cwd: Option<String>,
    git_root: Option<String>,
    branch: Option<String>,
    repository: Option<String>,
}

struct AgentErr {
    agent_id: String,
    error_type: String,
    turn: Option<usize>,
}

fn empty_turn_stats(at: Option<String>) -> TurnStats {
    TurnStats { started_at: at, repeat_edits: Some(0), ..Default::default() }
}

static EXTERNAL_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)quota|rate[_-]?limit").unwrap());

/// 利用上限・速度制限(外の事情で止まったもの)
fn is_external_error(error_type: &str) -> bool {
    EXTERNAL_ERROR_RE.is_match(error_type)
}

fn js_round(x: f64) -> f64 {
    js::round(x)
}

/// PLAN.md「正規化セッションレコード」を 1 件作る
pub fn normalize_session(input: NormalizeInput<'_>) -> std::io::Result<SessionRecord> {
    let ws = input.workspace;
    let dbs = input.db.session;
    let db_turns = input.db.turns;
    let db_usage = input.db.usage;
    let db_files = input.db.files;
    let has_events = input.events.is_some();

    let mut sources = Vec::new();
    if dbs.is_some() {
        sources.push(SessionSource::Db);
    }
    if input.has_dir.unwrap_or(ws.is_some() || has_events) {
        sources.push(SessionSource::Dir);
    }

    let mut by_type: JsMap<i64> = JsMap::new();
    let mut unknown: JsMap<i64> = JsMap::new();
    let mut total: i64 = 0;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;
    let mut active_ms: i64 = 0;

    let mut copilot_version: Option<String> = None;
    let mut schema_version: Option<f64> = None;
    let mut ctx = Ctx::default();

    let mut turns: i64 = 0;
    let mut autopilot_continuations: i64 = 0;
    let mut assistant_messages: i64 = 0;
    let mut first_user_message: Option<String> = None;
    let mut last_assistant_message: Option<String> = None;
    let mut models: IndexSet<String> = IndexSet::new();
    let mut legacy_output_by_model: JsMap<f64> = JsMap::new();
    let mut legacy_output: f64 = 0.0;
    let mut usage_records: Vec<UsageItem> = Vec::new();
    let mut last_shutdown: Option<CopilotEvent> = None;
    // codeChanges を持つ最後の session.shutdown の codeChanges(累計)
    let mut last_code_changes: Option<Value> = None;
    let mut subagent_total_tokens: f64 = 0.0;
    let mut max_pre_compaction: Option<f64> = None;

    let mut tools: JsMap<i64> = JsMap::new();
    let mut tools_total: i64 = 0;
    let mut internal_tools: JsMap<i64> = JsMap::new();
    let mut internal_total: i64 = 0;
    let mut internal_calls: HashSet<String> = HashSet::new();
    let mut tool_name_by_call: HashMap<String, String> = HashMap::new();
    let mut mcp: JsMap<JsMap<i64>> = JsMap::new();
    let mut results: JsMap<ToolResult> = JsMap::new();
    let mut tool_lines_added: f64 = 0.0;
    let mut tool_lines_removed: f64 = 0.0;
    let mut tool_lines_seen = false;
    let mut tool_start_ms: HashMap<String, i64> = HashMap::new();
    let mut tool_durations: JsMap<Vec<f64>> = JsMap::new();
    let mut tool_duration_outliers: JsMap<i64> = JsMap::new();
    // ---- Phase 7 ----
    let mut mode_counts: JsMap<i64> = JsMap::new();
    let mut current_mode: Option<String> = None;
    let mut first_previous_mode: Option<String> = None;
    let mut mode_pending: i64 = 0;
    let mut effort_changes: Vec<EffortChange> = Vec::new();
    let mut last_ctx: Option<LastCtx> = None;
    let mut last_tool_token_count: Option<f64> = None;
    let mut last_available_tool_count: Option<f64> = None;
    let mut permissions: JsMap<i64> = JsMap::new();
    let mut error_types: JsMap<i64> = JsMap::new();
    let mut subagent_failures: JsMap<i64> = JsMap::new();
    let mut agent_errors: HashMap<String, AgentErr> = HashMap::new();
    let mut abort_ms: HashMap<String, Option<i64>> = HashMap::new();
    let mut file_edit_calls: HashMap<String, bool> = HashMap::new(); // true = サブエージェント
    let mut edits_without_lines_main: i64 = 0;
    let mut edits_without_lines_sub: i64 = 0;
    let mut compaction = CompactionStats { removed_recorded: Some(0), ..Default::default() };
    let mut agent_model_changes: i64 = 0;
    let mut skills: Vec<SkillUse> = Vec::new();
    let mut skill_at_ms: Vec<Option<i64>> = Vec::new();
    let mut available_skills: Option<IndexMap<String, AvailableSkill>> = None;
    let mut agents: IndexMap<String, AgentRun> = IndexMap::new();
    let mut agent_name_by_id: HashMap<String, String> = HashMap::new();
    let mut hooks: JsMap<i64> = JsMap::new();
    let mut hooks_total: i64 = 0;
    let mut instr = InstructionCollector::new();
    let mut wiki = empty_wiki();
    let default_wiki;
    let wiki_classifier = match input.wiki_classifier {
        Some(w) => w,
        None => {
            default_wiki = WikiClassifier::default();
            &default_wiki
        }
    };
    let mut friction = Friction::default();
    let mut files = FileTracker::new();
    let mut shutdown_files: Vec<Value> = Vec::new();
    let mut timeline: Vec<TimelineEntry> = Vec::new();
    // Phase 12
    let mut edit_counts: IndexMap<String, i64> = IndexMap::new();
    let mut consecutive_failures: i64 = 0;
    let mut max_consecutive_failures: i64 = 0;
    let mut turn_tools: Vec<Vec<String>> = Vec::new();
    let mut turn_start_ms: Vec<Option<i64>> = Vec::new();
    let mut turn_last_ms: Vec<Option<i64>> = Vec::new();
    let mut turn_active: Vec<i64> = Vec::new();
    let mut cur_turn: Option<usize> = None;
    let mut requests: Vec<String> = Vec::new();
    let mut turn_stats: Vec<TurnStats> = Vec::new();
    let mut turn_consecutive: i64 = 0;
    let mut turn_edited: HashSet<String> = HashSet::new();
    let mut overflow_ms: Option<i64> = None;

    macro_rules! cur {
        () => {
            cur_turn.and_then(|i| turn_stats.get_mut(i))
        };
    }
    macro_rules! cur_cwd {
        () => {
            ctx.cwd.clone().or_else(|| ws.and_then(|w| w.cwd.clone())).or_else(|| dbs.and_then(|d| d.cwd.clone()))
        };
    }
    macro_rules! push_timeline {
        ($e:expr) => {
            if timeline.len() < TIMELINE_LIMIT {
                timeline.push($e);
            }
        };
    }

    let empty_obj = Value::Object(Map::new());

    if let Some(events) = input.events {
        for e in events {
            let e = e?;
            total += 1;
            by_type.inc(&e.kind, 1);
            if !is_known_event_type(&e.kind) {
                unknown.inc(&e.kind, 1);
            }
            let at: Option<String> = event_at(&e);
            let t = ms(at.as_deref());
            let at_or_empty = || at.clone().unwrap_or_default();
            let d: &Value = match &e.data {
                Some(v) if !v.is_null() => v,
                _ => &empty_obj,
            };
            let g = |k: &str| d.get(k);
            let agent_truthy = truthy(e.agent_id.as_ref());
            // 新しいユーザーのターンの始まり(その前の空白はどのターンにも入れない)
            let starts_turn = e.kind == "user.message" && !agent_truthy && !is_autopilot_continuation(Some(d)) && is_user_turn(Some(d));
            if let Some(t) = t {
                if let Some(lt) = last_ts {
                    if t > lt {
                        let gap = t - lt;
                        if gap <= IDLE_GAP_MS {
                            active_ms += gap;
                            if let (Some(c), false) = (cur_turn, starts_turn) {
                                turn_active[c] += gap;
                            }
                        }
                    }
                }
                if first_ts.is_none_or(|f| t < f) {
                    first_ts = Some(t);
                }
                if last_ts.is_none_or(|l| t > l) {
                    last_ts = Some(t);
                }
            }
            if let (Some(t), Some(c), false) = (t, cur_turn, starts_turn) {
                turn_last_ms[c] = Some(t);
            }
            match e.kind.as_str() {
                "session.start" => {
                    if copilot_version.is_none() {
                        copilot_version = string_or_null(g("copilotVersion"));
                    }
                    if schema_version.is_none() {
                        schema_version = match g("version") {
                            Some(Value::Number(n)) => n.as_f64(),
                            _ => None,
                        };
                    }
                    if truthy(g("context")) {
                        let c = g("context").unwrap();
                        let pick = |old: &Option<String>, k: &str| old.clone().or_else(|| string_or_null(c.get(k)));
                        ctx = Ctx { cwd: pick(&ctx.cwd, "cwd"), git_root: pick(&ctx.git_root, "gitRoot"), branch: pick(&ctx.branch, "branch"), repository: pick(&ctx.repository, "repository") };
                    }
                    if truthy(g("selectedModel")) {
                        models.insert(normalize_model(&js::to_js_string(g("selectedModel").unwrap())));
                    }
                    if let Some(eff) = normalize_effort(g("reasoningEffort")) {
                        effort_changes.push(EffortChange { at: t, effort: eff, from: EffortFrom::Start });
                    }
                }
                "session.resume" | "session.context_changed" => {
                    let c = if e.kind == "session.resume" { g("context") } else { Some(d) };
                    if truthy(c) {
                        let c = c.unwrap();
                        let set = |cur: &mut Option<String>, k: &str| {
                            if let Some(v) = string_or_null(c.get(k)) {
                                *cur = Some(v);
                            }
                        };
                        set(&mut ctx.cwd, "cwd");
                        set(&mut ctx.git_root, "gitRoot");
                        set(&mut ctx.branch, "branch");
                        set(&mut ctx.repository, "repository");
                    }
                }
                "user.message" => {
                    if is_autopilot_continuation(Some(d)) {
                        autopilot_continuations += 1;
                    } else if is_user_turn(Some(d)) {
                        turns += 1;
                        match str_of(g("agentMode")).filter(|s| !s.is_empty()) {
                            Some(m) => mode_counts.inc(m, 1),
                            None => match &current_mode {
                                Some(m) => mode_counts.inc(m, 1),
                                None => mode_pending += 1,
                            },
                        }
                        let content = str_of(g("content"));
                        if first_user_message.is_none() {
                            if let Some(c) = content {
                                first_user_message = Some(head(c, TEXT_LIMIT).into_owned());
                            }
                        }
                        let label = present(g("content")).map(js::to_js_string).unwrap_or_default();
                        push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::User, label: head(&label, 120).into_owned(), count: None, tools: None });
                        if !agent_truthy && turn_tools.len() < ANALYSIS_TURNS {
                            turn_tools.push(Vec::new());
                            turn_start_ms.push(t);
                            turn_last_ms.push(t);
                            turn_active.push(0);
                            cur_turn = Some(turn_tools.len() - 1);
                            requests.push(content.map(|c| head(c, 300).into_owned()).unwrap_or_default());
                            turn_stats.push(empty_turn_stats(at.clone()));
                            turn_consecutive = 0;
                            turn_edited.clear();
                        } else if !agent_truthy {
                            cur_turn = None;
                            if overflow_ms.is_none() {
                                overflow_ms = t;
                            }
                        }
                    }
                }
                "assistant.message" => {
                    let model = present(g("model")).filter(|m| truthy(Some(m))).map(|m| normalize_model(&js::to_js_string(m)));
                    if let Some(m) = &model {
                        models.insert(m.clone());
                    }
                    if let Some(Value::Number(n)) = g("outputTokens") {
                        let v = n.as_f64().unwrap_or(0.0);
                        legacy_output += v;
                        legacy_output_by_model.add(model.as_deref().unwrap_or(UNKNOWN_KEY), v);
                    }
                    if is_main_assistant_message(e.agent_id.as_ref(), e.data.as_ref()) {
                        assistant_messages += 1;
                        if let Some(c) = str_of(g("content")) {
                            if !js::trim(c).is_empty() {
                                last_assistant_message = Some(tail(c, TEXT_LIMIT).into_owned());
                            }
                        }
                    }
                }
                "session.usage_record" => {
                    let u = g("usage");
                    if let Some(item) = from_usage_record(&e) {
                        usage_records.push(item);
                    }
                    if let Some(m) = u.and_then(|u| u.get("model")).filter(|m| truthy(Some(m))) {
                        models.insert(normalize_model(&js::to_js_string(m)));
                    }
                    if let Some(v) = num(u.and_then(|u| u.get("toolTokenCount"))) {
                        last_tool_token_count = Some(v);
                    }
                    if let Some(v) = num(u.and_then(|u| u.get("availableToolCount"))) {
                        last_available_tool_count = Some(v);
                    }
                }
                "session.shutdown" => {
                    if let Some(c) = ctx_of(d, ContextSource::Shutdown) {
                        last_ctx = Some(c);
                    }
                    let cc = g("codeChanges");
                    if truthy(cc) && is_object(cc) {
                        last_code_changes = cc.cloned();
                    }
                    if let Some(Value::Array(fm)) = cc.and_then(|c| c.get("filesModified")) {
                        shutdown_files = fm.clone();
                    }
                    last_shutdown = Some(e.clone());
                }
                "tool.execution_start" => {
                    let name = js::key_or(g("toolName"), "(unknown)");
                    let call_id = str_of(g("toolCallId"));
                    if is_internal_tool(&name) {
                        internal_tools.inc(&name, 1);
                        internal_total += 1;
                        if let Some(id) = call_id {
                            internal_calls.insert(id.to_string());
                        }
                        continue;
                    }
                    tools.inc(&name, 1);
                    tools_total += 1;
                    if let Some(id) = call_id {
                        tool_name_by_call.insert(id.to_string(), name.clone());
                        if let Some(t) = t {
                            tool_start_ms.insert(id.to_string(), t);
                        }
                        if FILE_EDIT_TOOLS.contains(&name.as_str()) {
                            file_edit_calls.insert(id.to_string(), agent_truthy);
                        }
                    }
                    if !agent_truthy {
                        if let Some(tt) = turn_tools.last_mut() {
                            if tt.len() < ANALYSIS_TOOLS_PER_TURN {
                                tt.push(name.clone());
                            }
                        }
                    }
                    if let Some(server) = str_of(g("mcpServerName")).filter(|s| !s.is_empty()) {
                        mcp.entry(server.to_string()).or_default().inc(&name, 1);
                    }
                    let args = args_of(Some(d));
                    let args_ref = args.as_ref();
                    if let Some(ts) = cur!() {
                        if let Some(k) = tool_kind(&name, args_ref) {
                            ts.kinds.inc(k, 1);
                            ts.tools += 1;
                            if k == "edit" {
                                ts.edits += 1;
                            }
                        }
                    }
                    let arg = |k: &str| match args_ref {
                        Some(Value::Object(o)) => str_of(o.get(k)),
                        _ => None,
                    };
                    if name == "skill" {
                        let skill = arg("skill").unwrap_or("(unknown)").to_string();
                        skills.push(SkillUse { name: skill.clone(), at: at.clone(), via: SkillVia::Tool, trigger: Some(SkillTrigger::Agent), chars: None });
                        skill_at_ms.push(t);
                        push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Skill, label: skill, count: None, tools: None });
                    } else {
                        match timeline.last_mut() {
                            Some(last) if last.kind == TimelineKind::Tools && last.tools.is_some() => {
                                last.count = Some(last.count.unwrap_or(0) + 1);
                                last.tools.as_mut().unwrap().inc(&name, 1);
                            }
                            _ => {
                                let mut m = JsMap::new();
                                m.inc(&name, 1);
                                push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Tools, label: "tools".into(), count: Some(1), tools: Some(m) });
                            }
                        }
                    }
                    if name == "ask_user" {
                        friction.ask_user += 1;
                        if let Some(ts) = cur!() {
                            ts.ask_user += 1;
                        }
                    }
                    wiki_classifier.classify(&mut wiki, &name, args_ref);
                    let cwd = cur_cwd!();
                    let mut note_edit = |path: &str, turn_stats: &mut Vec<TurnStats>| {
                        if js::trim(path).is_empty() {
                            return;
                        }
                        let key = js::to_lower(&path.replace('\\', "/"));
                        let before = *edit_counts.get(&key).unwrap_or(&0);
                        edit_counts.insert(key.clone(), before + 1);
                        if let Some(ts) = cur_turn.and_then(|i| turn_stats.get_mut(i)) {
                            if before > 0 {
                                // 同じ依頼の中で 2 回目以降なら重ね編集、前の依頼で触ったファイルなら再編集
                                if turn_edited.contains(&key) {
                                    ts.repeat_edits = Some(ts.repeat_edits.unwrap_or(0) + 1);
                                } else {
                                    ts.re_edits += 1;
                                }
                            }
                        }
                        turn_edited.insert(key);
                    };
                    if name == "create" {
                        if let Some(p) = arg("path") {
                            files.add(FileOp::Create, p, cwd.as_deref());
                        }
                    }
                    if name == "edit" || name == "str_replace_editor" {
                        if let Some(p) = arg("path") {
                            files.add(FileOp::Edit, p, cwd.as_deref());
                            note_edit(p, &mut turn_stats);
                        }
                    }
                    if name == "apply_patch" {
                        let p = match args_ref {
                            Some(Value::String(s)) => s.as_str(),
                            _ => arg("input").or_else(|| arg("patch")).unwrap_or(""),
                        };
                        for (op, path) in patch_files(p) {
                            files.add(op, &path, cwd.as_deref());
                            if op == FileOp::Edit {
                                note_edit(&path, &mut turn_stats);
                            }
                        }
                    }
                }
                "tool.execution_complete" => {
                    let call_id = str_of(g("toolCallId"));
                    let is_internal_call = call_id.is_some_and(|id| internal_calls.contains(id));
                    let success = match g("success") {
                        Some(Value::Bool(b)) => Some(*b),
                        _ => None,
                    };
                    let error = g("error");
                    if success == Some(false) && !is_internal_call {
                        friction.tool_failures += 1;
                    }
                    if let (false, Some(ok)) = (is_internal_call, success) {
                        consecutive_failures = if ok { 0 } else { consecutive_failures + 1 };
                        if consecutive_failures > max_consecutive_failures {
                            max_consecutive_failures = consecutive_failures;
                        }
                        if let Some(ts) = cur!() {
                            if ok {
                                turn_consecutive = 0;
                            } else {
                                if is_denied_error(error) {
                                    ts.denied += 1;
                                } else {
                                    ts.tool_failures += 1;
                                }
                                turn_consecutive += 1;
                                if turn_consecutive > ts.max_consecutive_failures {
                                    ts.max_consecutive_failures = turn_consecutive;
                                }
                            }
                        }
                    }
                    let call_name = call_id.and_then(|id| tool_name_by_call.get(id)).cloned();
                    if let (Some(cn), Some(ok)) = (&call_name, success) {
                        let r = results.entry(cn.clone()).or_default();
                        if ok {
                            r.success += 1;
                        } else if is_denied_error(error) {
                            r.denied += 1;
                        } else {
                            r.failure += 1;
                            // 失敗の要因(文は残さず、決まった規則で分けた種類だけ)
                            let cause = classify_tool_failure(error);
                            r.causes.get_or_insert_with(JsMap::new).inc(cause, 1);
                        }
                    }
                    if let (Some(cn), Some(t), Some(id)) = (&call_name, t, call_id) {
                        if let Some(&st) = tool_start_ms.get(id) {
                            if t >= st {
                                let dt = t - st;
                                if dt > TOOL_DURATION_OUTLIER_MS {
                                    tool_duration_outliers.inc(cn, 1);
                                } else {
                                    tool_durations.entry(cn.clone()).or_default().push(dt as f64);
                                }
                                tool_start_ms.remove(id);
                            }
                        }
                    }
                    let lm = g("toolTelemetry").and_then(|x| x.get("metrics"));
                    let has_lines = truthy(lm) && (js::is_num(lm.and_then(|m| m.get("linesAdded"))) || js::is_num(lm.and_then(|m| m.get("linesRemoved"))));
                    if has_lines {
                        tool_lines_seen = true;
                        tool_lines_added += line_metric(lm.and_then(|m| m.get("linesAdded")));
                        tool_lines_removed += line_metric(lm.and_then(|m| m.get("linesRemoved")));
                    }
                    if let Some(id) = call_id {
                        if let Some(sub) = file_edit_calls.remove(id) {
                            if !has_lines && success != Some(false) {
                                if sub {
                                    edits_without_lines_sub += 1;
                                } else {
                                    edits_without_lines_main += 1;
                                }
                            }
                        }
                    }
                    // 2026-10 以降の形式: 変更したファイルを fileEdits[] に持つ
                    if let Some(Value::Array(fe)) = g("fileEdits") {
                        let cwd = cur_cwd!();
                        for f in fe {
                            let Some(p) = str_of(f.get("path")) else { continue };
                            let op = match str_of(f.get("kind")) {
                                Some("create") => FileOp::Create,
                                Some("delete") => FileOp::Delete,
                                _ => FileOp::Edit,
                            };
                            files.add(op, p, cwd.as_deref());
                        }
                    }
                }
                "skill.invoked" | "skill.invoked_ref" => {
                    let name = js::key_or(g("name"), "(unknown)");
                    // 直前の toolName:"skill" と同じ呼び出しなら 1 件にまとめる
                    let pair = (0..skills.len()).rev().find(|&i| {
                        let s = &skills[i];
                        s.via == SkillVia::Tool
                            && s.name == name
                            && match (t, skill_at_ms[i]) {
                                (Some(t), Some(sa)) => t - sa <= SKILL_PAIR_WINDOW_MS && t >= sa,
                                _ => false,
                            }
                    });
                    let trigger = skill_trigger(g("trigger"));
                    let chars = match g("content") {
                        Some(Value::String(c)) => Some(js::utf16_len(c) as f64),
                        _ => match g("contentLength") {
                            Some(Value::Number(n)) => n.as_f64(),
                            _ => None,
                        },
                    };
                    match pair {
                        Some(i) => {
                            let p = &mut skills[i];
                            p.via = SkillVia::Both;
                            if trigger.is_some() {
                                p.trigger = trigger;
                            }
                            if chars.is_some() {
                                p.chars = Some(chars);
                            }
                        }
                        None => {
                            skills.push(SkillUse { name: name.clone(), at: at.clone(), via: SkillVia::Event, trigger, chars: Some(chars) });
                            skill_at_ms.push(t);
                            push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Skill, label: name.clone(), count: None, tools: None });
                            if wiki_classifier.is_skill(&name, g("path")) {
                                wiki.skill_calls.push(name);
                            }
                        }
                    }
                }
                "subagent.started" | "subagent.completed" | "subagent.failed" => {
                    // agentFor
                    let id_val = e.data.as_ref().and_then(|x| present(x.get("toolCallId"))).or_else(|| present(e.agent_id.as_ref()));
                    let id = id_val.map(js::key_of);
                    let key = id.clone().unwrap_or_else(|| format!("anon-{}", agents.len()));
                    let agent_name = present(g("agentName"));
                    let a = agents.entry(key).or_insert_with(|| AgentRun {
                        name: agent_name.map(js::key_of).unwrap_or_else(|| "(unknown)".into()),
                        id: id.clone(),
                        started_at: None,
                        completed_at: None,
                        status: AgentStatus::Running,
                        total_tokens: None,
                        total_tool_calls: None,
                        model: str_of(g("model")).map(normalize_model),
                        error: None,
                    });
                    if truthy(agent_name) {
                        let n = js::key_of(agent_name.unwrap());
                        if truthy(id_val) {
                            agent_name_by_id.insert(id.clone().unwrap(), n.clone());
                        }
                        if agent_truthy {
                            agent_name_by_id.insert(js::key_of(e.agent_id.as_ref().unwrap()), n);
                        }
                    }
                    if e.kind == "subagent.started" {
                        a.started_at = at.clone();
                        if let Some(n) = agent_name {
                            a.name = js::key_of(n);
                        }
                        if let Some(m) = str_of(g("model")) {
                            a.model = Some(normalize_model(m));
                        }
                        let label = a.name.clone();
                        push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Agent, label, count: None, tools: None });
                    } else {
                        a.completed_at = at.clone();
                        a.status = if e.kind == "subagent.completed" { AgentStatus::Completed } else { AgentStatus::Failed };
                        if let Some(Value::Number(n)) = g("totalTokens") {
                            let v = n.as_f64().unwrap_or(0.0);
                            a.total_tokens = Some(v);
                            subagent_total_tokens += v;
                        }
                        if let Some(Value::Number(n)) = g("totalToolCalls") {
                            a.total_tool_calls = n.as_f64();
                        }
                        if e.kind == "subagent.failed" {
                            // サブエージェントの失敗は、同じ agentId の session.error の直後(parentId がその error)にも出る。
                            // 1 回の失敗を二重に数えないよう、対になる error は「エラー」から外して「agent 失敗」だけに数える
                            if let Some(pid) = str_of(e.parent_id.as_ref()) {
                                let same_agent = agent_errors.get(pid).is_some_and(|p| present(e.agent_id.as_ref()).map(js::key_of).as_deref() == Some(p.agent_id.as_str()));
                                if same_agent {
                                    let p = agent_errors.remove(pid).unwrap();
                                    friction.errors -= 1;
                                    let n = error_types.get(&p.error_type).copied().unwrap_or(0) - 1;
                                    if n <= 0 {
                                        error_types.shift_remove(&p.error_type);
                                    } else {
                                        error_types.insert(p.error_type.clone(), n);
                                    }
                                    if let Some(pt) = p.turn.and_then(|i| turn_stats.get_mut(i)) {
                                        pt.errors -= 1;
                                        if is_external_error(&p.error_type) {
                                            pt.external_errors -= 1;
                                        }
                                    }
                                }
                            }
                            friction.subagent_failures += 1;
                            if let Some(ts) = cur!() {
                                ts.subagent_failures += 1;
                            }
                            subagent_failures.inc(subagent_failure_reason(g("error")), 1);
                            if let Some(err) = present(g("error")) {
                                let s = match err {
                                    Value::String(s) => s.clone(),
                                    other => crate::json::to_js_string(other).unwrap_or_default(),
                                };
                                a.error = Some(head(&s, 200).into_owned());
                            }
                        }
                    }
                }
                "hook.start" => {
                    hooks.inc(&js::key_or(g("hookType"), "(unknown)"), 1);
                    hooks_total += 1;
                }
                "system.message" => {
                    if let Some(c) = str_of(g("content")) {
                        instr.add(c, at.as_deref());
                        if let Some(avail) = available_skills_of(c) {
                            let m = available_skills.get_or_insert_with(IndexMap::new);
                            for s in avail {
                                if !m.contains_key(&s.name) {
                                    m.insert(s.name.clone(), s);
                                }
                            }
                        }
                    }
                }
                "session.compaction_complete" => {
                    friction.compactions += 1;
                    if let Some(ts) = cur!() {
                        ts.compactions += 1;
                    }
                    if let Some(Value::Number(n)) = g("preCompactionTokens") {
                        let v = n.as_f64().unwrap_or(0.0);
                        max_pre_compaction = Some(max_pre_compaction.unwrap_or(0.0).max(v));
                    }
                    if let Some(c) = ctx_of(d, ContextSource::Compaction) {
                        last_ctx = Some(c);
                    }
                    let cu = g("compactionTokensUsed");
                    if truthy(cu) && is_object(cu) {
                        // 新しい形式は { inputTokens, outputTokens, ... }、古い形式は { input, output, cachedInput }
                        let cu = cu.unwrap();
                        compaction.recorded += 1;
                        compaction.input += num(cu.get("inputTokens")).or_else(|| num(cu.get("input"))).unwrap_or(0.0);
                        compaction.output += num(cu.get("outputTokens")).or_else(|| num(cu.get("output"))).unwrap_or(0.0);
                        compaction.nano_aiu += num(cu.get("copilotUsage").and_then(|x| x.get("totalNanoAiu"))).or_else(|| num(cu.get("totalNanoAiu"))).unwrap_or(0.0);
                    }
                    if let Some(v) = num(g("tokensRemoved")) {
                        compaction.tokens_removed += v;
                        compaction.removed_recorded = Some(compaction.removed_recorded.unwrap_or(0) + 1);
                    }
                    let label = match present(g("outcome")) {
                        Some(v) => js::to_js_string(v),
                        None => (if matches!(g("success"), Some(Value::Bool(false))) { "failed" } else { "applied" }).to_string(),
                    };
                    push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Compaction, label, count: None, tools: None });
                }
                "abort" => {
                    // 1 回の中断で abort が 2 件続くことがある(2 件目の parentId が 1 件目、数 ms 差)。2 件目は数えない
                    let prev = str_of(e.parent_id.as_ref()).and_then(|p| abort_ms.get(p).copied());
                    if let Some(id) = str_of(e.id.as_ref()) {
                        abort_ms.insert(id.to_string(), t);
                    }
                    if let Some(prev) = prev {
                        let pair = match (prev, t) {
                            (Some(p), Some(t)) => (t - p).abs() <= ABORT_PAIR_WINDOW_MS,
                            _ => true,
                        };
                        if pair {
                            continue;
                        }
                    }
                    friction.aborts += 1;
                    if let Some(ts) = cur!() {
                        ts.aborts += 1;
                    }
                    let label = present(g("reason")).map(js::to_js_string).unwrap_or_default();
                    push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Abort, label, count: None, tools: None });
                }
                "session.error" => {
                    friction.errors += 1;
                    let error_type = str_of(g("errorType")).filter(|s| !s.is_empty()).unwrap_or("(unknown)").to_string();
                    error_types.inc(&error_type, 1);
                    if agent_truthy {
                        if let Some(id) = str_of(e.id.as_ref()) {
                            agent_errors.insert(id.to_string(), AgentErr { agent_id: js::key_of(e.agent_id.as_ref().unwrap()), error_type: error_type.clone(), turn: cur_turn });
                        }
                    }
                    if let Some(ts) = cur!() {
                        ts.errors += 1;
                        if is_external_error(&error_type) {
                            ts.external_errors += 1;
                        }
                    }
                    let label = present(g("errorType")).or_else(|| present(g("message"))).map(js::to_js_string).unwrap_or_default();
                    push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::Error, label: js::utf16_slice(&label, 0, 120).into_owned(), count: None, tools: None });
                }
                "permission.requested" => friction.permission_requests += 1,
                "permission.completed" => {
                    let r = g("result");
                    let kind = match r.and_then(|r| r.get("kind")) {
                        Some(Value::String(k)) => k.clone(),
                        _ => match r {
                            Some(Value::String(s)) => s.clone(),
                            _ => "(unknown)".into(),
                        },
                    };
                    permissions.inc(&kind, 1);
                }
                "session.model_change" => {
                    if let Some(m) = present(g("newModel")).filter(|m| truthy(Some(m))) {
                        models.insert(normalize_model(&js::to_js_string(m)));
                    }
                    // source: agent はサブエージェントの起動に伴う切り替え。モデル変更にも、本体の推論強度の変化にも数えない
                    if str_of(g("source")) == Some("agent") {
                        agent_model_changes += 1;
                        continue;
                    }
                    friction.model_changes += 1;
                    if let Some(eff) = normalize_effort(g("reasoningEffort")) {
                        effort_changes.push(EffortChange { at: t, effort: eff, from: EffortFrom::Change });
                    }
                }
                "session.mode_changed" => {
                    friction.mode_changes += 1;
                    if first_previous_mode.is_none() {
                        if let Some(p) = str_of(g("previousMode")).filter(|s| !s.is_empty()) {
                            first_previous_mode = Some(p.to_string());
                        }
                    }
                    if let Some(m) = str_of(g("newMode")).filter(|s| !s.is_empty()) {
                        current_mode = Some(m.to_string());
                    }
                }
                "session.workspace_file_changed" => {
                    if let Some(p) = str_of(g("path")) {
                        let op = match str_of(g("operation")) {
                            Some("create") => FileOp::Create,
                            Some("delete") => FileOp::Delete,
                            _ => FileOp::Edit,
                        };
                        let cwd = cur_cwd!();
                        files.add(op, p, cwd.as_deref());
                    }
                }
                "session.task_complete" => {
                    let s = present(g("summary")).map(js::to_js_string).unwrap_or_default();
                    push_timeline!(TimelineEntry { at: at_or_empty(), kind: TimelineKind::TaskComplete, label: head(&s, 120).into_owned(), count: None, tools: None });
                }
                _ => {}
            }
        }
    }
    // 所要時間の終わりが最後の時系列の行より後の session.shutdown なら、終了の行を足す
    if let Some(ls) = &last_shutdown {
        let ts_str = event_at(ls).filter(|s| !s.is_empty());
        let shut_ms = ms(ts_str.as_deref());
        let last_row_ms = timeline.last().and_then(|r| ms(Some(&r.at)));
        if let (Some(ts), Some(sm), Some(lr)) = (ts_str, shut_ms, last_row_ms) {
            if Some(sm) == last_ts && sm > lr {
                let label = ls.data.as_ref().and_then(|d| str_of(d.get("shutdownType"))).unwrap_or("").to_string();
                push_timeline!(TimelineEntry { at: ts, kind: TimelineKind::Shutdown, label, count: None, tools: None });
            }
        }
    }
    // filesModified は順序の無い要約なので、セッション中の操作で載ったパスは上書きしない
    {
        let cwd = cur_cwd!();
        for f in &shutdown_files {
            if let Value::String(s) = f {
                files.add_summary(s, cwd.as_deref());
            }
        }
    }

    // DB しか無いセッションは turns テーブルから補う
    if total == 0 && !db_turns.is_empty() {
        let mut sorted: Vec<&DbTurnRow> = db_turns.iter().collect();
        sorted.sort_by(|a, b| a.turn_index.partial_cmp(&b.turn_index).unwrap_or(std::cmp::Ordering::Equal));
        turns = sorted.len() as i64;
        first_user_message = sorted[0].user_message.as_deref().filter(|s| !s.is_empty()).map(|s| head(s, TEXT_LIMIT).into_owned());
        let last_resp = sorted.iter().rev().find_map(|x| x.assistant_response.as_deref().filter(|s| !s.is_empty()));
        last_assistant_message = last_resp.map(|s| tail(s, TEXT_LIMIT).into_owned());
        assistant_messages = sorted.iter().filter(|x| x.assistant_response.as_deref().is_some_and(|s| !s.is_empty())).count() as i64;
    }
    if files.size() == 0 {
        let cwd = cur_cwd!();
        for f in db_files {
            files.add(if f.tool_name.as_deref() == Some("create") { FileOp::Create } else { FileOp::Edit }, &f.file_path, cwd.as_deref());
        }
    }

    // 変更行数: session.shutdown.codeChanges を優先し、無ければツール側の合計
    let cc = last_code_changes.as_ref();
    let files_result = files.result();
    let any_files = files_result.changed.len() + files_result.created.len() + files_result.deleted.len() > 0;
    let cc_has_lines = cc.is_some_and(|c| js::is_num(c.get("linesAdded")) || js::is_num(c.get("linesRemoved")));
    let cc_empty = cc_has_lines && {
        let c = cc.unwrap();
        line_metric(c.get("linesAdded")) == 0.0 && line_metric(c.get("linesRemoved")) == 0.0 && !matches!(c.get("filesModified"), Some(Value::Array(a)) if !a.is_empty())
    };
    let lines_note = if !any_files {
        None
    } else if edits_without_lines_sub > 0 {
        Some(LineNote::SubagentEdits)
    } else if cc_empty {
        Some(LineNote::EmptyShutdown)
    } else {
        None
    };
    let _ = edits_without_lines_main;
    let lines = if cc_has_lines && !(cc_empty && any_files) {
        let c = cc.unwrap();
        LineChanges { added: line_metric(c.get("linesAdded")), removed: line_metric(c.get("linesRemoved")), source: LineSource::Shutdown, note: None }
    } else if tool_lines_seen {
        LineChanges { added: tool_lines_added, removed: tool_lines_removed, source: LineSource::Tools, note: lines_note }
    } else {
        LineChanges { added: 0.0, removed: 0.0, source: LineSource::None, note: lines_note }
    };

    // ---- トークン ----
    for a in agents.values() {
        if let Some(id) = a.id.as_ref().filter(|s| !s.is_empty()) {
            agent_name_by_id.insert(id.clone(), a.name.clone());
        }
    }
    let (items, duplicates) = merge_usage(db_usage, usage_records);
    let mut tokens = build_tokens(&items, duplicates, legacy_output, &legacy_output_by_model, &agent_name_by_id, last_shutdown.as_ref());
    tokens.subagent_total_tokens = subagent_total_tokens;
    attribute_usage(&items, &turn_start_ms, overflow_ms, &mut turn_stats);
    tokens.max_pre_compaction_tokens = max_pre_compaction;
    for u in &items {
        models.insert(u.model.clone());
    }
    for m in tokens.by_model.js_keys() {
        if m != UNKNOWN_KEY {
            models.insert(m.clone());
        }
    }

    // ---- 実行の性質 ----
    if mode_pending > 0 {
        mode_counts.inc(first_previous_mode.as_deref().unwrap_or("interactive"), mode_pending);
    }
    let mode_inferred = if mode_pending > 0 && first_previous_mode.is_none() { mode_pending } else { 0 };
    if total == 0 && turns > 0 {
        mode_counts.inc("(unknown)", turns);
    }
    let lc = last_ctx.as_ref();
    let context = ContextBreakdown {
        system_tokens: lc.and_then(|c| c.system_tokens),
        conversation_tokens: lc.and_then(|c| c.conversation_tokens),
        tool_definitions_tokens: lc.and_then(|c| c.tool_definitions_tokens).or(last_tool_token_count),
        available_tool_count: last_available_tool_count,
        source: match lc {
            Some(c) if c.tool_definitions_tokens.is_some() => Some(c.source),
            _ if last_tool_token_count.is_some() => Some(ContextSource::Usage),
            _ => lc.map(|c| c.source),
        },
    };
    let exec = build_exec(&items, &effort_changes, &tokens, ModeCounts { by_mode: mode_counts, inferred: mode_inferred }, context);

    let cwd = cur_cwd!();
    let git_root = ctx.git_root.clone().or_else(|| ws.and_then(|w| w.git_root.clone()));
    let repository = ctx.repository.clone().or_else(|| ws.and_then(|w| w.repository.clone())).or_else(|| dbs.and_then(|d| d.repository.clone()));
    let branch = ctx.branch.clone().or_else(|| ws.and_then(|w| w.branch.clone())).or_else(|| dbs.and_then(|d| d.branch.clone()));
    let created_src = ws.and_then(|w| w.created_at.clone()).or_else(|| dbs.and_then(|d| d.created_at.clone()));
    let created_at = normalize_time(created_src.as_deref()).or_else(|| first_ts.map(jsdate::to_iso));
    let updated_at = latest(&[normalize_time(ws.and_then(|w| w.updated_at.as_deref())), normalize_time(dbs.and_then(|d| d.updated_at.as_deref())), last_ts.map(jsdate::to_iso)]);

    let mut duration_ms: Option<f64> = match (first_ts, last_ts) {
        (Some(f), Some(l)) => Some((l - f) as f64),
        _ => None,
    };
    let active: Option<f64> = (total > 0).then_some(active_ms as f64);
    if duration_ms.is_none() {
        let c = ms(created_at.as_deref());
        let u = ms(updated_at.as_deref());
        duration_ms = match (c, u) {
            (Some(c), Some(u)) if u >= c => Some((u - c) as f64),
            _ => None,
        };
    }

    let name = ws.and_then(|w| w.name.clone()).or_else(|| ws.and_then(|w| w.summary.clone())).or_else(|| dbs.and_then(|d| d.summary.clone()));
    let project = project_key(repository.as_deref(), git_root.as_deref(), cwd.as_deref());
    let project_source = if repository.as_deref().is_some_and(|r| !r.is_empty()) {
        ProjectSource::Repository
    } else if git_root.as_deref().is_some_and(|r| !r.is_empty()) || cwd.as_deref().is_some_and(|r| !r.is_empty()) {
        ProjectSource::Path
    } else {
        ProjectSource::Unknown
    };
    let mut models: Vec<String> = models.into_iter().collect();
    models.sort_by(|a, b| cmp_utf16(a, b));

    let counts: Vec<i64> = edit_counts.values().copied().collect();
    let analysis = SessionAnalysis {
        files_reedited: counts.iter().filter(|n| **n >= 2).count() as i64,
        extra_edits: counts.iter().map(|n| (n - 1).max(0)).sum(),
        max_consecutive_failures,
        turn_ms: turn_start_ms
            .iter()
            .enumerate()
            .map(|(i, st)| match (st, turn_last_ms[i]) {
                (Some(st), Some(end)) if end >= *st => Some((end - st) as f64),
                _ => None,
            })
            .collect(),
        turn_active_ms: turn_start_ms.iter().enumerate().map(|(i, st)| st.map(|_| turn_active[i] as f64)).collect(),
        turn_tools,
        requests,
        turn_stats: Some(turn_stats),
    };

    Ok(SessionRecord {
        id: input.id,
        sources,
        client: ws.and_then(|w| w.client_name.clone()),
        cwd,
        git_root,
        repository,
        branch,
        name,
        project,
        project_source,
        copilot_version,
        schema_version,
        created_at,
        updated_at,
        duration_ms,
        active_ms: active,
        turns,
        autopilot_continuations,
        assistant_messages,
        empty: turns == 0 && tools_total == 0 && assistant_messages == 0,
        first_user_message,
        last_assistant_message,
        models,
        tokens,
        tools: SessionTools {
            by_name: tools,
            total: tools_total,
            internal: InternalTools { by_name: internal_tools, total: internal_total },
            mcp,
            results,
            durations: tool_durations,
            duration_outliers: tool_duration_outliers,
        },
        exec,
        friction_detail: FrictionDetail { permissions, error_types, subagent_failures, compaction, agent_model_changes: Some(agent_model_changes) },
        todos: None,
        lines,
        skills,
        available_skills: Some(available_skills.map(|m| m.into_values().collect())),
        agents: agents.into_values().collect(),
        hooks: HookCounts { by_type: hooks, total: hooks_total },
        instructions: instr.result(),
        wiki,
        friction,
        files: SessionFiles { changed: files_result.changed, created: files_result.created, deleted: files_result.deleted, session_state: files_result.session_state },
        timeline,
        analysis,
        unknown_event_types: unknown,
        events: EventCounts { total, bad_lines: 0, by_type },
        person: None,
        upload_folder: None,
        upload_tags: None,
        upload_atlas: None,
        desktop: None,
    })
}

/// リクエストの使用量を、始まった時刻でターンに振り分ける
fn attribute_usage(items: &[UsageItem], starts: &[Option<i64>], overflow_ms: Option<i64>, stats: &mut [TurnStats]) {
    if stats.is_empty() {
        return;
    }
    let mut at: Vec<usize> = Vec::new();
    let mut max_up_to: Vec<i64> = Vec::new();
    for (i, st) in starts.iter().enumerate() {
        let Some(st) = st else { continue };
        at.push(i);
        let prev = max_up_to.last().copied().unwrap_or(i64::MIN);
        max_up_to.push(prev.max(*st));
    }
    for u in items {
        let Some(uat) = u.at else { continue };
        if overflow_ms.is_some_and(|o| uat >= o) {
            continue;
        }
        let (mut lo, mut hi) = (0usize, max_up_to.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if max_up_to[mid] > uat {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        if lo == 0 {
            continue;
        }
        let Some(ts) = stats.get_mut(at[lo - 1]) else { continue };
        ts.input = Some(ts.input.unwrap_or(0.0) + u.input);
        ts.output = Some(ts.output.unwrap_or(0.0) + u.output);
        if let Some(n) = u.nano_aiu {
            ts.nano_aiu = Some(ts.nano_aiu.unwrap_or(0.0) + n);
        }
    }
}

/// その時刻の推論強度の設定。時刻が無い・最初の設定より前のときは、最初の設定が session.start のものならそれ、それ以外は None
fn effort_at(changes: &[EffortChange], at: Option<i64>) -> Option<String> {
    let first = changes.first()?;
    match at {
        Some(at) => {
            let mut found: Option<&str> = None;
            for c in changes {
                if c.at.is_some_and(|ca| ca <= at) {
                    found = Some(&c.effort);
                }
            }
            if let Some(f) = found {
                return Some(f.to_string());
            }
        }
        None => {
            let distinct: HashSet<&str> = changes.iter().map(|c| c.effort.as_str()).collect();
            if distinct.len() == 1 {
                return Some(first.effort.clone());
            }
        }
    }
    (first.from == EffortFrom::Start).then(|| first.effort.clone())
}

fn add_effort(to: &mut JsMap<EffortStat>, key: &str, s: &EffortStat) {
    let e = to.entry(key.to_string()).or_default();
    e.requests += s.requests;
    e.input += s.input;
    e.output += s.output;
    e.nano_aiu += s.nano_aiu;
}

/// リクエスト単位の明細から推論強度別・起点別・モデル別の待ち時間を作る
fn build_exec(items: &[UsageItem], effort_changes: &[EffortChange], tokens: &SessionTokens, modes: ModeCounts, context: ContextBreakdown) -> ExecProfile {
    let mut efforts: JsMap<EffortStat> = JsMap::new();
    let mut model_efforts: JsMap<JsMap<EffortStat>> = JsMap::new();
    let mut initiators: JsMap<i64> = JsMap::new();
    let mut latency: JsMap<Latency> = JsMap::new();
    for u in items {
        let key = u.effort.clone().or_else(|| effort_at(effort_changes, u.at)).unwrap_or_else(|| UNKNOWN_KEY.into());
        let s = EffortStat { requests: 1.0, input: u.input, output: u.output, nano_aiu: u.nano_aiu.unwrap_or(0.0) };
        add_effort(&mut efforts, &key, &s);
        add_effort(model_efforts.entry(u.model.clone()).or_default(), &key, &s);
        initiators.inc(u.initiator.as_deref().unwrap_or(UNKNOWN_KEY), 1);
        if u.ttft.is_some() || u.duration.is_some() {
            let l = latency.entry(u.model.clone()).or_default();
            if let Some(v) = u.ttft {
                l.ttft.push(js_round(v));
            }
            if let Some(v) = u.duration {
                l.duration.push(js_round(v));
            }
        }
    }
    if items.is_empty() && tokens.source == TokenSource::Shutdown {
        // 明細が無く終了時の累計だけ: セッション中の設定が 1 種類ならその強度、それ以外は不明
        let distinct: IndexSet<&str> = effort_changes.iter().map(|c| c.effort.as_str()).collect();
        let key = if distinct.len() == 1 { distinct[0].to_string() } else { UNKNOWN_KEY.to_string() };
        let stat = |t: &TokenCounts| EffortStat { requests: t.requests.unwrap_or(0.0), input: t.input.unwrap_or(0.0), output: t.output, nano_aiu: t.nano_aiu.unwrap_or(0.0) };
        let total = TokenCounts {
            input: tokens.input,
            output: tokens.output,
            cache_read: tokens.cache_read,
            cache_write: tokens.cache_write,
            reasoning: tokens.reasoning,
            premium_requests: tokens.premium_requests,
            nano_aiu: tokens.nano_aiu,
            requests: tokens.requests,
        };
        add_effort(&mut efforts, &key, &stat(&total));
        for (m, t) in tokens.by_model.js_entries() {
            add_effort(model_efforts.entry(m.clone()).or_default(), &key, &stat(t));
        }
    }
    ExecProfile { modes, context, efforts, model_efforts: Some(model_efforts), initiators, latency }
}

/// null は「不明」を保つ(どちらかが null なら、もう一方の値)
fn sum_counts(a: &TokenCounts, b: &TokenCounts) -> TokenCounts {
    let n = |x: Option<f64>, y: Option<f64>| match (x, y) {
        (None, y) => y,
        (x, None) => x,
        (Some(x), Some(y)) => Some(x + y),
    };
    TokenCounts {
        input: n(a.input, b.input),
        output: a.output + b.output,
        cache_read: n(a.cache_read, b.cache_read),
        cache_write: n(a.cache_write, b.cache_write),
        reasoning: n(a.reasoning, b.reasoning),
        premium_requests: n(a.premium_requests, b.premium_requests),
        nano_aiu: n(a.nano_aiu, b.nano_aiu),
        requests: match (a.requests, b.requests) {
            (Some(x), Some(y)) => Some(x + y),
            _ => None,
        },
    }
}

fn latest(ts: &[Option<String>]) -> Option<String> {
    let mut best: Option<&String> = None;
    let mut best_ms = i64::MIN;
    for t in ts.iter().flatten() {
        if let Some(v) = ms(Some(t)) {
            if v > best_ms || best.is_none() {
                best = Some(t);
                best_ms = v;
            }
        }
    }
    best.cloned()
}

fn build_tokens(items: &[UsageItem], duplicates: i64, legacy_output: f64, legacy_output_by_model: &JsMap<f64>, agent_names: &HashMap<String, String>, last_shutdown: Option<&CopilotEvent>) -> SessionTokens {
    let n_db = items.iter().filter(|i| i.from_db).count() as i64;
    let n_ev = items.len() as i64 - n_db;
    let shutdown = shutdown_totals(last_shutdown);
    let records = TokenRecords { db: n_db, events: n_ev, duplicates_removed: duplicates };

    // DB も usage_record も無いが shutdown にモデル別の累積値がある → それを正とする
    let mm = last_shutdown.and_then(|e| e.data.as_ref()).and_then(|d| d.get("modelMetrics"));
    if items.is_empty() {
        if let (Some(sd), Some(mm)) = (&shutdown, mm) {
            let entries = js_entries(mm);
            if truthy(Some(mm)) && is_object(Some(mm)) && !entries.is_empty() {
                let mut by_model: JsMap<TokenCounts> = JsMap::new();
                let mut requests: Option<f64> = Some(0.0);
                for (m, v) in entries {
                    let u = present(v.get("usage"));
                    let gu = |k: &str| num_or0(u.and_then(|u| u.get(k)));
                    let rq = v.get("requests");
                    let count = match rq.and_then(|r| r.get("count")) {
                        Some(Value::Number(n)) => n.as_f64(),
                        _ => None,
                    };
                    match count {
                        None => requests = None,
                        Some(c) => {
                            if let Some(r) = requests.as_mut() {
                                *r += c;
                            }
                        }
                    }
                    let add = TokenCounts {
                        input: Some(gu("inputTokens")),
                        output: gu("outputTokens"),
                        cache_read: Some(gu("cacheReadTokens")),
                        cache_write: Some(gu("cacheWriteTokens")),
                        reasoning: Some(gu("reasoningTokens")),
                        premium_requests: match rq.and_then(|r| r.get("cost")) {
                            Some(Value::Number(n)) => n.as_f64(),
                            _ => None,
                        },
                        nano_aiu: match v.get("totalNanoAiu") {
                            Some(Value::Number(n)) => n.as_f64(),
                            _ => None,
                        },
                        requests: count,
                    };
                    // 表記揺れ(claude-x-5-5 と claude-x-5.5)は同じモデルとして足し合わせる
                    let key = normalize_model(&m);
                    let merged = match by_model.get(&key) {
                        Some(cur) => sum_counts(cur, &add),
                        None => add,
                    };
                    by_model.insert(key, merged);
                }
                return SessionTokens {
                    input: Some(sd.input),
                    output: sd.output,
                    cache_read: Some(sd.cache_read),
                    cache_write: Some(sd.cache_write),
                    reasoning: Some(sd.reasoning),
                    premium_requests: sd.premium_requests,
                    nano_aiu: sd.nano_aiu,
                    requests,
                    source: TokenSource::Shutdown,
                    by_model,
                    by_agent: JsMap::new(),
                    records,
                    shutdown: shutdown.clone(),
                    subagent_total_tokens: 0.0,
                    max_pre_compaction_tokens: None,
                };
            }
        }
    }

    if items.is_empty() {
        let mut by_model: JsMap<TokenCounts> = JsMap::new();
        for (m, out) in legacy_output_by_model.js_entries() {
            by_model.insert(m.clone(), TokenCounts { input: None, output: *out, cache_read: None, cache_write: None, reasoning: None, premium_requests: None, nano_aiu: None, requests: Some(0.0) });
        }
        let source = if legacy_output > 0.0 || !legacy_output_by_model.is_empty() { TokenSource::Partial } else { TokenSource::None };
        return SessionTokens {
            input: None,
            output: legacy_output,
            cache_read: None,
            cache_write: None,
            reasoning: None,
            premium_requests: shutdown.as_ref().and_then(|s| s.premium_requests),
            nano_aiu: shutdown.as_ref().and_then(|s| s.nano_aiu),
            requests: Some(0.0),
            source,
            by_model,
            by_agent: JsMap::new(),
            records,
            shutdown,
            subagent_total_tokens: 0.0,
            max_pre_compaction_tokens: None,
        };
    }

    let fresh = || TokenCounts { premium_requests: None, nano_aiu: None, ..empty_token_counts() };
    let mut tot = fresh();
    let mut by_model: JsMap<TokenCounts> = JsMap::new();
    let mut by_agent: JsMap<TokenCounts> = JsMap::new();
    for u in items {
        add_item(&mut tot, u);
        add_item(by_model.entry(u.model.clone()).or_insert_with(fresh), u);
        let agent = match u.agent_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => agent_names.get(id).cloned().unwrap_or_else(|| id.to_string()),
            None => "main".to_string(),
        };
        add_item(by_agent.entry(agent).or_insert_with(fresh), u);
    }
    // initiator が一つも記録されていない古い行は premium を決められないので shutdown の最終値で補う
    if tot.premium_requests.is_none() {
        if let Some(p) = shutdown.as_ref().and_then(|s| s.premium_requests) {
            tot.premium_requests = Some(p);
        }
    }
    let source = if n_db > 0 && n_ev > 0 {
        TokenSource::DbEvents
    } else if n_db > 0 {
        TokenSource::Db
    } else {
        TokenSource::Events
    };
    SessionTokens {
        input: tot.input,
        output: tot.output,
        cache_read: tot.cache_read,
        cache_write: tot.cache_write,
        reasoning: tot.reasoning,
        premium_requests: tot.premium_requests,
        nano_aiu: tot.nano_aiu,
        requests: tot.requests,
        source,
        by_model,
        by_agent,
        records,
        shutdown,
        subagent_total_tokens: 0.0,
        max_pre_compaction_tokens: None,
    }
}
