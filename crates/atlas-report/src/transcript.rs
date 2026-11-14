//! セッション記録(Markdown。packages/report/src/transcript.ts の移植)。1 セッションの経過を、人が読んで共有でき、LLM に渡して分析できる形に書き出す。
//! - 本文はスナップショットの events.jsonl から読み直す(呼び元が読んだイベントを渡す。sessions.json には先頭・末尾 2000 字しか無い)
//! - トークン・AIU・待ち時間は session-store.db の明細(assistant_usage_events)と usage_record を core の merge_usage で合わせる
//! - 既定では成功したツールの結果は入れない(--tool-output all で入れる)
//! - API キーらしい文字列は伏せて件数を出す。伏せ字モードでは本文にも scrub を掛ける

use crate::anonymize::Anonymizer;
use crate::format::{date_time_n, dec_n, duration, int_n};
use crate::jssort::js_sort_by;
use crate::raw_events::RawEvent;
use atlas_core::classify::{is_internal_tool, is_user_turn, normalize_model};
use atlas_core::collate::locale_compare;
use atlas_core::js;
use atlas_core::jsdate;
use atlas_core::jsnum::to_fixed;
use atlas_core::normalize::{from_usage_record, merge_usage, UsageItem};
use atlas_core::types::{DbUsageRow, LineSource, SessionRecord};
use regex::Regex;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutputMode {
    Fail,
    All,
    None,
}

pub struct TranscriptOptions<'a> {
    pub anon: &'a Anonymizer,
    pub generated_at: &'a str,
    /// ツールの結果を入れる条件(既定 fail = 失敗したときだけ)
    pub tool_output: ToolOutputMode,
    /// 依頼・応答・要約 1 件の上限(文字。UTF-16 の単位)。超えた分は中略して字数を書く
    pub max_text_chars: usize,
    /// ツールの結果 1 件の上限(文字)
    pub max_tool_chars: usize,
    /// これ以上の空白を「待ち」として書く(ミリ秒)
    pub gap_ms: i64,
}

pub const DEFAULT_MAX_TEXT_CHARS: usize = 20_000;
pub const DEFAULT_MAX_TOOL_CHARS: usize = 4_000;
pub const DEFAULT_GAP_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptSource {
    Events,
    Record,
}

#[derive(Debug, Clone)]
pub struct TranscriptResult {
    pub markdown: String,
    /// 読んだイベント数
    pub events: usize,
    /// 中略した本文の数
    pub truncated: u64,
    /// 伏せた秘密情報らしい文字列の数
    pub secret_hits: u64,
    pub source: TranscriptSource,
}

static NOT_SAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]").unwrap());

/// `id.replace(/[^A-Za-z0-9._-]/g, '_')`(UTF-16 の単位ごとに _)
pub fn safe_name(id: &str) -> String {
    NOT_SAFE.replace_all(id, |c: &regex::Captures| "_".repeat(c[0].encode_utf16().count())).into_owned()
}

pub fn transcript_file_name(id: &str) -> String {
    format!("{}.md", safe_name(id))
}

pub fn transcript_href(id: &str) -> String {
    format!("sessions/{}", transcript_file_name(id))
}

// ---------- 秘密情報 ----------

/// API キー・トークンらしい形(種類名, 正規表現)。JS の \b は ASCII の語の境目なので (?-u:\b) にする
pub static SECRET_PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    let b = r"(?-u:\b)";
    let s = js::RE_S;
    vec![
        ("GitHub トークン", format!(r"{b}(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{{36,}}{b}|{b}github_pat_[A-Za-z0-9_]{{22,}}{b}")),
        ("OpenAI / Anthropic 系キー", format!(r"{b}sk-(?:ant-)?[A-Za-z0-9_-]{{20,}}{b}")),
        ("AWS アクセスキー", format!(r"{b}(?:AKIA|ASIA)[0-9A-Z]{{16}}{b}")),
        ("Slack トークン", format!(r"{b}xox[abprs]-[A-Za-z0-9-]{{10,}}{b}")),
        ("Google API キー", format!(r"{b}AIza[0-9A-Za-z_-]{{35}}{b}")),
        ("秘密鍵", r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.)*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]*PRIVATE KEY-----".to_string()),
        ("JWT", format!(r"{b}eyJ[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}{b}")),
        ("Bearer トークン", format!(r"{b}Bearer{s}+[A-Za-z0-9._~+/=-]{{24,}}")),
    ]
    .into_iter()
    .map(|(l, re)| (l, Regex::new(&re).unwrap()))
    .collect()
});

/// 秘密情報らしい文字列を [伏せました: 種類] に置き換え、件数を返す
pub fn redact_secrets(text: &str) -> (String, u64) {
    let mut hits = 0u64;
    let mut out: Option<String> = None;
    for (label, re) in SECRET_PATTERNS.iter() {
        let cur = out.as_deref().unwrap_or(text);
        if !re.is_match(cur) {
            continue;
        }
        let rep = format!("[伏せました: {label}]");
        let replaced = re
            .replace_all(cur, |_: &regex::Captures| {
                hits += 1;
                rep.clone()
            })
            .into_owned();
        out = Some(replaced);
    }
    (out.unwrap_or_else(|| text.to_string()), hits)
}

// ---------- 補助 ----------

fn ms(iso: Option<&str>) -> Option<i64> {
    iso.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

/// 開始からの相対時刻 +h:mm:ss
pub fn rel(from_ms: Option<i64>, at_ms: Option<i64>) -> String {
    let (Some(from), Some(at)) = (from_ms, at_ms) else {
        return "+?:??:??".into();
    };
    let s = js::round((at - from) as f64 / 1000.0).max(0.0) as i64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    format!("+{h}:{m:02}:{sec:02}")
}

static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new("`{3,}").unwrap());
static TRAIL_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+$", js::RE_S)).unwrap());
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// `s.replace(/\s+$/, '')`
pub fn trim_end_ws(s: &str) -> &str {
    match TRAIL_WS.find(s) {
        Some(m) => &s[..m.start()],
        None => s,
    }
}

/// 本文に ``` が含まれていても壊れないよう、含まれる最長のバッククォート列より 1 つ長くした囲み
pub fn fence(text: &str, lang: &str) -> String {
    let n = TICKS.find_iter(text).map(|m| m.len() + 1).max().unwrap_or(0).max(3);
    let f = "`".repeat(n);
    format!("{f}{lang}\n{}\n{f}", trim_end_ws(text))
}

fn quote(text: &str) -> String {
    trim_end_ws(text).split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
}

/// `JSON.stringify(v)`
pub fn json_string(v: &Value) -> String {
    atlas_core::json::to_js_string(v).unwrap_or_default()
}

/// ツール引数の 1 行要約
pub fn summarize_args(_name: &str, args: Option<&Value>) -> String {
    let a = match args {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v,
        _ => return String::new(),
    };
    const KEYS: [&str; 13] = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "skill", "agent_type", "agentType", "description", "prompt", "intent"];
    let one = a.as_object().and_then(|o| KEYS.iter().find_map(|k| o.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())));
    let s = match one {
        Some(x) => x.to_string(),
        None => json_string(a),
    };
    let squashed = WS_RUN.replace_all(&s, " ");
    format!("{}{}", js::utf16_slice(&squashed, 0, 160), if js::utf16_len(&s) > 160 { "…" } else { "" })
}

fn result_text(result: Option<&Value>) -> String {
    match result {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v @ Value::Object(o)) => {
            if let Some(d) = o.get("detailedContent").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return d.to_string();
            }
            if let Some(c) = o.get("content").and_then(Value::as_str) {
                return c.to_string();
            }
            json_string(v)
        }
        Some(v @ Value::Array(_)) => json_string(v),
        Some(v) => js::to_js_string(v),
    }
}

fn error_text(error: Option<&Value>) -> String {
    match error {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v @ (Value::Object(_) | Value::Array(_))) => {
            let o = v.as_object();
            let code = o.and_then(|o| o.get("code")).and_then(Value::as_str).unwrap_or("");
            let msg = match o.and_then(|o| o.get("message")).and_then(Value::as_str) {
                Some(m) => m.to_string(),
                None => json_string(v),
            };
            if code.is_empty() { msg } else { format!("{code}: {msg}") }
        }
        Some(v) => js::to_js_string(v),
    }
}

fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let mid = s.len() / 2;
    Some(if s.len() % 2 == 1 { s[mid] } else { js::round((s[mid - 1] + s[mid]) / 2.0) })
}

fn p90(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let i = ((s.len() as f64 * 0.9).ceil() as usize).saturating_sub(1).min(s.len() - 1);
    Some(s[i])
}

fn sec(v: Option<f64>) -> String {
    match v {
        None => "—".into(),
        Some(v) => format!("{} 秒", to_fixed(v / 1000.0, 1)),
    }
}

/// `Number(v)`(記録の数値の欄)
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => *b as i64 as f64,
        Some(Value::String(s)) => {
            let t = js::trim(s);
            if t.is_empty() { 0.0 } else { t.parse::<f64>().ok().filter(|x| x.is_finite() || t.contains("Infinity")).unwrap_or(f64::NAN) }
        }
        _ => f64::NAN,
    }
}

/// `String(v ?? fallback)`
fn str_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.to_string(),
        Some(x) => js::to_js_string(x),
    }
}

struct Writer<'a> {
    o: &'a TranscriptOptions<'a>,
    truncated: u64,
    secret_hits: u64,
}

impl Writer<'_> {
    /// 本文(自由記述)の整形: 上限で中略 → 秘密情報を伏せる → 伏せ字モードなら scrub
    fn text(&mut self, s: &str, limit: usize) -> String {
        let len = js::utf16_len(s);
        let cut;
        let t: &str = if len > limit {
            let head = (limit as f64 * 0.7).floor() as usize;
            let tail = limit - head;
            cut = format!("{}\n\n…(中略 {} 字)…\n\n{}", js::utf16_slice(s, 0, head), int_n((len - limit) as f64), js::utf16_slice(s, len - tail, len));
            self.truncated += 1;
            &cut
        } else {
            s
        };
        let (red, hits) = redact_secrets(t);
        self.secret_hits += hits;
        if self.o.anon.enabled { self.o.anon.scrub(&red) } else { red }
    }

    fn short(&self, s: &str) -> String {
        if self.o.anon.enabled { self.o.anon.scrub(s) } else { s.to_string() }
    }
}

/// セッション記録を Markdown にする。events が None(スナップショットに無い)・空のときは sessions.json の抜粋だけで組む。
/// db_usage は session-store.db の assistant_usage_events のうちこのセッションの行
pub fn render_transcript(r: &SessionRecord, events: Option<&[RawEvent]>, db_usage: &[DbUsageRow], o: &TranscriptOptions<'_>) -> TranscriptResult {
    let anon = o.anon;
    let mut w = Writer { o, truncated: 0, secret_hits: 0 };
    let events: &[RawEvent] = events.unwrap_or(&[]);
    let source = if events.is_empty() { TranscriptSource::Record } else { TranscriptSource::Events };

    // サブエージェントの対応表: toolCallId → 名前、agentId → toolCallId
    let mut agent_name_by_call: HashMap<String, String> = HashMap::new();
    let mut call_by_agent_id: HashMap<String, String> = HashMap::new();
    for row in db_usage {
        if let (Some(a), Some(c)) = (row.agent_id.as_deref().filter(|s| !s.is_empty()), row.parent_tool_call_id.as_deref().filter(|s| !s.is_empty())) {
            call_by_agent_id.insert(a.to_string(), c.to_string());
        }
    }
    for e in events {
        if e.kind() == "subagent.started"
            && let Some(call) = e.d_str("toolCallId")
        {
            let name = match e.d("agentName").filter(|v| !v.is_null()).or_else(|| e.d("agentDisplayName").filter(|v| !v.is_null())) {
                Some(v) => js::to_js_string(v),
                None => "agent".into(),
            };
            agent_name_by_call.insert(call.to_string(), name);
        }
        if let (Some(a), Some(p)) = (e.agent_id(), e.d_str("parentToolCallId")) {
            call_by_agent_id.insert(a, p.to_string());
        }
    }
    let agent_of = |e: &RawEvent| -> Option<String> {
        let aid = e.agent_id();
        let call: Option<String> = match e.d_str("parentToolCallId") {
            Some(c) => Some(c.to_string()),
            None => aid.as_ref().and_then(|a| call_by_agent_id.get(a).cloned()),
        };
        if let Some(c) = call.filter(|c| !c.is_empty()) {
            return Some(agent_name_by_call.get(&c).cloned().unwrap_or_else(|| format!("agent({})", js::utf16_slice(&c, 0, 8))));
        }
        aid.map(|a| format!("agent({})", js::utf16_slice(&a, 0, 8)))
    };
    let role_of_usage = |u: &UsageItem| -> String {
        let Some(a) = u.agent_id.as_deref().filter(|s| !s.is_empty()) else {
            return "本体".into();
        };
        call_by_agent_id.get(a).and_then(|c| agent_name_by_call.get(c)).cloned().unwrap_or_else(|| format!("agent({})", js::utf16_slice(a, 0, 8)))
    };

    let records: Vec<UsageItem> = events.iter().filter(|e| e.kind() == "session.usage_record").filter_map(|e| from_usage_record(&e.to_copilot_event())).collect();
    let (usage, _) = merge_usage(db_usage, records);
    let start_ms = ms(r.created_at.as_deref()).or_else(|| events.first().and_then(|e| ms(e.timestamp())));

    // ---------- 見出し・概要 ----------
    let (failure, denied) = r.tools.results.values().fold((0i64, 0i64), |a, x| (a.0 + x.failure, a.1 + x.denied));
    let name = anon.free_text(r.name.as_deref()).filter(|s| !s.is_empty());
    let title = match &name {
        Some(n) => js::utf16_slice(&WS_RUN.replace_all(n, " "), 0, 120).into_owned(),
        None => {
            if anon.enabled {
                "セッション(伏せ字)".into()
            } else {
                r.id.clone()
            }
        }
    };
    let mut l: Vec<String> = Vec::new();
    macro_rules! push {
        ($($e:expr),* $(,)?) => { $( l.push($e.to_string()); )* };
    }
    push!(format!("# セッション記録: {}", w.short(&title)), "");
    push!(format!(
        "生成 {} · agent-session-atlas `atlas export` · 本文の出所: {}",
        date_time_n(Some(o.generated_at)),
        if source == TranscriptSource::Events { "events.jsonl(スナップショット)" } else { "sessions.json の抜粋のみ(スナップショットに記録が無い)" }
    ));
    if anon.enabled {
        push!("", "> **伏せ字モード。** プロジェクト名・パス・リポジトリ名・ブランチは仮名に、絶対パスは `<path>` に置き換えてあります。依頼文や応答などの自由記述は機械的に置き換えただけで、本文中の固有名(相対パス、ファイル名、人名など)が残っている可能性があります。共有する前に中身を確認してください。");
    }
    push!("");

    push!("## 概要", "");
    let opt_i = |v: Option<f64>, miss: &str| v.map(int_n).unwrap_or_else(|| miss.to_string());
    let meta: Vec<(&str, String)> = vec![
        ("セッション ID", r.id.clone()),
        ("プロジェクト", anon.project_label(&r.project)),
        ("クライアント", r.client.clone().unwrap_or_else(|| "不明".into())),
        (
            "リポジトリ / ブランチ",
            format!(
                "{} / {}",
                if anon.enabled {
                    if r.repository.as_deref().is_some_and(|s| !s.is_empty()) { anon.project(&r.project) } else { "—".into() }
                } else {
                    r.repository.clone().unwrap_or_else(|| "—".into())
                },
                anon.branch(r.branch.as_deref()).unwrap_or_else(|| "—".into())
            ),
        ),
        ("作業フォルダ", anon.path(r.cwd.as_deref()).unwrap_or_else(|| if anon.enabled { "(伏せ字)".into() } else { "—".into() })),
        ("Copilot", r.copilot_version.clone().unwrap_or_else(|| "不明".into())),
        ("開始 / 更新", format!("{} / {}", date_time_n(r.created_at.as_deref()), date_time_n(r.updated_at.as_deref()))),
        ("所要時間 / 実働", format!("{} / {}", duration(r.duration_ms, "不明"), duration(r.active_ms, "不明"))),
        (
            "依頼 / 応答",
            format!(
                "{} / {}{}",
                int_n(r.turns as f64),
                int_n(r.assistant_messages as f64),
                if r.autopilot_continuations != 0 { format!("(autopilot の自動継続 {} 回は依頼に含めない)", int_n(r.autopilot_continuations as f64)) } else { String::new() }
            ),
        ),
        ("モデル", if r.models.is_empty() { "不明".into() } else { r.models.join("、") }),
        ("トークン", format!("入力 {} / 出力 {} / キャッシュ読取 {}(出所: {})", opt_i(r.tokens.input, "記録なし"), int_n(r.tokens.output), opt_i(r.tokens.cache_read, "—"), r.tokens.source.as_str())),
        ("AI 使用量(AIU)", r.tokens.nano_aiu.map(|v| dec_n(v / 1e9)).unwrap_or_else(|| "記録なし".into())),
        (
            "ツール呼び出し",
            format!(
                "{}(失敗 {}・拒否 {}){}",
                int_n(r.tools.total as f64),
                int_n(failure as f64),
                int_n(denied as f64),
                if r.tools.internal.total != 0 { format!("、内部ツール {} 回は除外", int_n(r.tools.internal.total as f64)) } else { String::new() }
            ),
        ),
        ("skill / agent / hook", format!("{} / {} / {}", int_n(r.skills.len() as f64), int_n(r.agents.len() as f64), int_n(r.hooks.total as f64))),
        (
            "摩擦",
            format!(
                "compaction {}・中断 {}・エラー {}・ツール失敗 {}・権限確認 {}・ask_user {}",
                int_n(r.friction.compactions as f64),
                int_n(r.friction.aborts as f64),
                int_n(r.friction.errors as f64),
                int_n(r.friction.tool_failures as f64),
                int_n(r.friction.permission_requests as f64),
                int_n(r.friction.ask_user as f64)
            ),
        ),
        ("変更行数", if r.lines.source != LineSource::None { format!("+{} / −{}", int_n(r.lines.added), int_n(r.lines.removed)) } else { "記録なし".into() }),
    ];
    push!("| 項目 | 値 |", "|---|---|");
    for (k, v) in meta {
        push!(format!("| {k} | {} |", v.replace('|', "\\|")));
    }
    push!("");

    // 役 × モデルの消費
    if !usage.is_empty() {
        push!("### 役 × モデルの消費", "");
        push!("リクエスト単位の明細(session-store.db と usage_record)から。待ち時間は最初のトークンまで(TTFT)とリクエスト全体の中央値 / p90。", "");
        push!("| 役 | モデル | リクエスト | 入力 | 出力 | キャッシュ読取 | AIU | TTFT 中央値 / p90 | 全体 中央値 / p90 |", "|---|---|---|---|---|---|---|---|---|");
        struct G {
            role: String,
            model: String,
            n: i64,
            input: f64,
            output: f64,
            cache: f64,
            aiu: Option<f64>,
            ttft: Vec<f64>,
            dur: Vec<f64>,
        }
        let mut groups: indexmap::IndexMap<(String, String), G> = indexmap::IndexMap::new();
        for u in &usage {
            let role = role_of_usage(u);
            let model = normalize_model(&u.model);
            let g = groups.entry((role.clone(), model.clone())).or_insert_with(|| G { role, model, n: 0, input: 0.0, output: 0.0, cache: 0.0, aiu: None, ttft: vec![], dur: vec![] });
            g.n += 1;
            g.input += u.input;
            g.output += u.output;
            g.cache += u.cache_read;
            if let Some(a) = u.nano_aiu {
                g.aiu = Some(g.aiu.unwrap_or(0.0) + a);
            }
            if let Some(t) = u.ttft {
                g.ttft.push(t);
            }
            if let Some(d) = u.duration {
                g.dur.push(d);
            }
        }
        let mut rows: Vec<G> = groups.into_values().collect();
        // 本体どうしは常に -1 を返す(一貫しない)比較なので、V8 と同じ並べ方を使う
        js_sort_by(&mut rows, |a, b| {
            if a.role == "本体" {
                Ordering::Less
            } else if b.role == "本体" {
                Ordering::Greater
            } else {
                locale_compare(&a.role, &b.role).then(b.n.cmp(&a.n))
            }
        });
        for g in &rows {
            push!(format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} / {} | {} / {} |",
                g.role,
                g.model,
                int_n(g.n as f64),
                int_n(g.input),
                int_n(g.output),
                int_n(g.cache),
                g.aiu.map(|a| dec_n(a / 1e9)).unwrap_or_else(|| "—".into()),
                sec(median(&g.ttft)),
                sec(p90(&g.ttft)),
                sec(median(&g.dur)),
                sec(p90(&g.dur))
            ));
        }
        push!("");
    } else {
        push!("### 役 × モデルの消費", "", "リクエスト単位の明細はありません(このセッションのトークンは終了時の累計か出力のみ、または記録なし)。", "");
    }

    // ツールの内訳(回数の多い順、失敗つき)
    let mut tool_rows: Vec<(&String, &i64)> = r.tools.by_name.js_entries();
    tool_rows.sort_by(|a, b| b.1.cmp(a.1));
    if !tool_rows.is_empty() {
        push!("### ツールの内訳", "");
        push!("| ツール | 回数 | 失敗 | 拒否 |", "|---|---|---|---|");
        for (tool, n) in tool_rows.iter().take(25) {
            let x = r.tools.results.get(tool.as_str());
            push!(format!(
                "| {tool} | {} | {} | {} |",
                int_n(**n as f64),
                x.map(|x| int_n(x.failure as f64)).unwrap_or_else(|| "—".into()),
                x.map(|x| int_n(x.denied as f64)).unwrap_or_else(|| "—".into())
            ));
        }
        if tool_rows.len() > 25 {
            push!(format!("| …他 {} 種 | | | |", int_n((tool_rows.len() - 25) as f64)));
        }
        push!("");
    }

    // ---------- 経過 ----------
    push!("## 経過", "");
    if source == TranscriptSource::Record {
        push!("スナップショットに events.jsonl が無いため、sessions.json に残る最初の依頼と最後の応答だけです。", "");
        let first = anon.free_text(r.first_user_message.as_deref()).filter(|s| !s.is_empty());
        let last = anon.free_text(r.last_assistant_message.as_deref()).filter(|s| !s.is_empty());
        if let Some(f) = &first {
            let t = w.text(f, o.max_text_chars);
            push!("### 最初の依頼", "", quote(&t), "");
        }
        if let Some(x) = &last {
            let t = w.text(x, o.max_text_chars);
            push!("### 最後の応答", "", quote(&t), "");
        }
        if first.is_none() && last.is_none() {
            push!("(本文の記録がありません)", "");
        }
    } else {
        push!(
            format!(
                "時刻は開始からの相対(+時:分:秒)。{}以上の空白は「待ち」として書きます。ツールの結果は{}。サブエージェントの発言とツールは `[agent:名前]` を付けて書きます。",
                duration(Some(o.gap_ms as f64), "不明"),
                match o.tool_output {
                    ToolOutputMode::All => "全件",
                    ToolOutputMode::Fail => "失敗したときだけ",
                    ToolOutputMode::None => "入れていません",
                }
            ),
            ""
        );
        // tool.execution_start の最初のもの(toolCallId ごと。TS 版の events.find と同じ)
        let mut start_event: HashMap<&str, &RawEvent> = HashMap::new();
        for e in events {
            if e.kind() == "tool.execution_start"
                && let Some(c) = e.d_str("toolCallId")
            {
                start_event.entry(c).or_insert(e);
            }
        }
        struct Start {
            name: String,
            at: Option<i64>,
            agent: Option<String>,
        }
        let mut tool_start: HashMap<String, Start> = HashMap::new();
        let mut internal_calls: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut prev_at: Option<i64> = None;
        let mut turn_no = 0i64;
        let mut turn_start_ms: Option<i64> = None;
        let line = |l: &mut Vec<String>, at: Option<&str>, body: &str| l.push(format!("- {} {body}", rel(start_ms, ms(at))));
        // 直前の依頼の本体の消費(その依頼から end_ms までに記録されたリクエスト)を 1 回だけ書く
        let flush_turn = |l: &mut Vec<String>, turn_no: i64, turn_start_ms: Option<i64>, end_ms: Option<i64>| {
            let Some(ts) = turn_start_ms else { return };
            if turn_no == 0 {
                return;
            }
            let from = ts - 1000;
            let in_turn: Vec<&UsageItem> = usage.iter().filter(|u| u.agent_id.as_deref().is_none_or(str::is_empty) && u.at.is_some_and(|at| at >= from && end_ms.is_none_or(|e| at < e + 1000))).collect();
            if in_turn.is_empty() {
                return;
            }
            let sum = |f: &dyn Fn(&UsageItem) -> f64| in_turn.iter().fold(0.0, |a, u| a + f(u));
            let aiu = if in_turn.iter().any(|u| u.nano_aiu.is_some()) { dec_n(sum(&|u| u.nano_aiu.unwrap_or(0.0)) / 1e9) } else { "—".into() };
            let took = end_ms.map(|e| format!("、所要 {}", duration(Some((e - ts) as f64), "不明"))).unwrap_or_default();
            l.push(String::new());
            l.push(format!(
                "_依頼 {turn_no} の本体の消費: リクエスト {}、入力 {}、出力 {}、キャッシュ読取 {}、AIU {aiu}{took}_",
                int_n(in_turn.len() as f64),
                int_n(sum(&|u| u.input)),
                int_n(sum(&|u| u.output)),
                int_n(sum(&|u| u.cache_read))
            ));
            l.push(String::new());
        };
        for e in events {
            let at = ms(e.timestamp());
            if let (Some(p), Some(a)) = (prev_at, at)
                && a - p >= o.gap_ms
            {
                push!("", format!("_(待ち {})_", duration(Some((a - p) as f64), "不明")), "");
            }
            if at.is_some() {
                prev_at = at;
            }
            let agent = agent_of(e);
            let tag = agent.as_ref().map(|a| format!("[agent:{}] ", w.short(a))).unwrap_or_default();
            let ts = e.timestamp();
            match e.kind() {
                "user.message" => {
                    if agent.is_none() && is_user_turn(e.get("data")) {
                        flush_turn(&mut l, turn_no, turn_start_ms, at);
                        turn_no += 1;
                        turn_start_ms = at;
                        let mode = e.d_str("agentMode").map(|m| format!("、モード {m}")).unwrap_or_default();
                        push!("", format!("### 依頼 {turn_no}({}{mode})", rel(start_ms, at)), "");
                        let content = str_or(e.d("content"), "");
                        let t = w.text(&content, o.max_text_chars);
                        push!(quote(&t), "");
                    } else if agent.is_none() {
                        line(&mut l, ts, "autopilot の自動継続(ユーザーの依頼には数えない)");
                    } else if let Some(c) = e.d_str("content").filter(|c| !js::trim(c).is_empty()) {
                        line(&mut l, ts, &format!("{tag}委譲の指示:"));
                        let t = w.text(c, o.max_text_chars);
                        push!("", quote(&t), "");
                    }
                }
                "assistant.message" => {
                    let content = e.d_str("content").map(js::trim).unwrap_or("");
                    let model = e.d_str("model").map(normalize_model);
                    let reqs = e.d("toolRequests").and_then(Value::as_array).map_or(0, Vec::len);
                    let model_s = model.filter(|m| !m.is_empty()).map(|m| format!("({m})")).unwrap_or_default();
                    if !content.is_empty() {
                        line(&mut l, ts, &format!("{tag}**応答**{model_s}{}", if reqs > 0 { format!("、続けてツール {reqs} 件を要求") } else { String::new() }));
                        let t = w.text(content, o.max_text_chars);
                        push!("", quote(&t), "");
                    } else if reqs > 0 && agent.is_none() {
                        line(&mut l, ts, &format!("{model_s}ツール {reqs} 件を要求(本文なし)"));
                    }
                }
                "tool.execution_start" => {
                    let nm = str_or(e.d("toolName"), "(unknown)");
                    if is_internal_tool(&nm) {
                        if let Some(c) = e.d_str("toolCallId") {
                            internal_calls.insert(c.to_string());
                        }
                    } else if let Some(c) = e.d_str("toolCallId") {
                        tool_start.insert(c.to_string(), Start { name: nm, at, agent: agent.clone() });
                    }
                }
                "tool.execution_complete" => {
                    let call = e.d_str("toolCallId");
                    if call.is_some_and(|c| internal_calls.contains(c)) {
                        continue;
                    }
                    let st = call.and_then(|c| tool_start.get(c));
                    let nm = st.map(|s| s.name.clone()).unwrap_or_else(|| str_or(e.d("toolName"), "(unknown)"));
                    if is_internal_tool(&nm) {
                        continue;
                    }
                    let start_ev = call.and_then(|c| start_event.get(c).copied());
                    let args = summarize_args(&nm, start_ev.and_then(|s| s.d("arguments")));
                    let dur = match (st.and_then(|s| s.at), at) {
                        (Some(a), Some(b)) => Some(duration(Some((b - a) as f64), "不明")),
                        _ => None,
                    };
                    let ok = e.d("success") != Some(&Value::Bool(false));
                    let err = if ok { String::new() } else { error_text(e.d("error")) };
                    let mcp = start_ev.and_then(|s| s.d_str("mcpServerName")).filter(|s| !s.is_empty()).map(|s| format!(" (MCP {s})")).unwrap_or_default();
                    let who = match st.and_then(|s| s.agent.as_ref()) {
                        Some(a) => format!("[agent:{}] ", w.short(a)),
                        None => tag.clone(),
                    };
                    let body = format!(
                        "{who}{} `{nm}`{mcp}{}{}{}",
                        if ok { "✔" } else { "✖" },
                        if args.is_empty() { String::new() } else { format!(" {}", w.short(&redact_secrets(&args).0)) },
                        dur.map(|d| format!("({d})")).unwrap_or_default(),
                        if err.is_empty() { String::new() } else { format!(" — 失敗: {}", w.short(&redact_secrets(&err).0)) }
                    );
                    line(&mut l, ts, &body);
                    let show = o.tool_output == ToolOutputMode::All || (o.tool_output == ToolOutputMode::Fail && !ok);
                    if show {
                        let rt = result_text(e.d("result"));
                        if !js::trim(&rt).is_empty() {
                            let t = w.text(&rt, o.max_tool_chars);
                            push!("", fence(&t, ""), "");
                        }
                    }
                    if let Some(c) = call {
                        tool_start.remove(c);
                    }
                }
                "subagent.started" => {
                    let nm = match e.d("agentName").filter(|v| !v.is_null()).or_else(|| e.d("agentDisplayName").filter(|v| !v.is_null())) {
                        Some(v) => js::to_js_string(v),
                        None => "agent".into(),
                    };
                    line(&mut l, ts, &format!("**サブエージェント開始** `{}`", w.short(&nm)));
                }
                "subagent.completed" => {
                    let mut parts: Vec<String> = Vec::new();
                    if e.d("durationMs").is_some_and(|v| !v.is_null()) {
                        parts.push(duration(Some(number(e.d("durationMs"))), "不明"));
                    }
                    if e.d("totalTokens").is_some_and(|v| !v.is_null()) {
                        parts.push(format!("トークン {}", int_n(number(e.d("totalTokens")))));
                    }
                    if e.d("totalToolCalls").is_some_and(|v| !v.is_null()) {
                        parts.push(format!("ツール {} 回", int_n(number(e.d("totalToolCalls")))));
                    }
                    line(&mut l, ts, &format!("サブエージェント完了 `{}`{}", w.short(&str_or(e.d("agentName"), "agent")), if parts.is_empty() { String::new() } else { format!("({})", parts.join("、")) }));
                }
                "subagent.failed" => {
                    let msg = match e.d("error").filter(|v| !v.is_null()).or_else(|| e.d("message").filter(|v| !v.is_null())) {
                        Some(v) => js::to_js_string(v),
                        None => String::new(),
                    };
                    let s = w.short(&redact_secrets(&msg).0);
                    line(&mut l, ts, &format!("**サブエージェント失敗** `{}`: {}", w.short(&str_or(e.d("agentName"), "agent")), js::utf16_slice(&s, 0, 300)));
                }
                "session.compaction_start" => {
                    let num0 = |k: &str| int_n(number(Some(e.d(k).filter(|v| !v.is_null()).unwrap_or(&Value::from(0)))));
                    line(&mut l, ts, &format!("compaction 開始(文脈 {} + system {} + ツール定義 {} トークン)", num0("conversationTokens"), num0("systemTokens"), num0("toolDefinitionsTokens")));
                }
                "session.compaction_complete" => {
                    line(
                        &mut l,
                        ts,
                        &format!(
                            "compaction 完了{}{}{}",
                            if e.d("success") == Some(&Value::Bool(false)) { "(失敗)" } else { "" },
                            if e.d("preCompactionTokens").is_some_and(|v| !v.is_null()) { format!("、圧縮前 {} トークン", int_n(number(e.d("preCompactionTokens")))) } else { String::new() },
                            if e.d("compactionTokensUsed").is_some_and(|v| !v.is_null()) { format!("、compaction 自体の消費 {}", int_n(number(e.d("compactionTokensUsed")))) } else { String::new() }
                        ),
                    );
                    if let Some(s) = e.d_str("summaryContent").filter(|s| !js::trim(s).is_empty()) {
                        let t = w.text(s, o.max_text_chars);
                        push!("", "<details><summary>compaction の要約</summary>", "", quote(&t), "", "</details>", "");
                    }
                }
                "permission.requested" => {
                    line(
                        &mut l,
                        ts,
                        &format!("権限の確認を要求{}{}", e.d_str("toolName").map(|t| format!(" `{t}`")).unwrap_or_default(), e.d_str("kind").map(|k| format!("({k})")).unwrap_or_default()),
                    );
                }
                "permission.completed" => {
                    let res = e.d("result");
                    let kind = match res {
                        Some(Value::Object(o)) if o.get("kind").is_some_and(Value::is_string) => o["kind"].as_str().unwrap().to_string(),
                        Some(Value::String(s)) => s.clone(),
                        _ => "(unknown)".into(),
                    };
                    line(&mut l, ts, &format!("権限の確認の結果: {kind}"));
                }
                "session.error" => {
                    let msg = e.d_str("message").map(|m| format!(": {}", js::utf16_slice(&w.short(&redact_secrets(m).0), 0, 300))).unwrap_or_default();
                    line(
                        &mut l,
                        ts,
                        &format!("**エラー** {}{}{msg}", str_or(e.d("errorType"), ""), if e.d("statusCode").is_some_and(|v| !v.is_null()) { format!(" (HTTP {})", js::to_js_string(e.d("statusCode").unwrap())) } else { String::new() }),
                    );
                }
                "abort" => {
                    let reason = e.d_str("reason").map(|r| js::utf16_slice(&w.short(r), 0, 300).into_owned()).unwrap_or_default();
                    line(&mut l, ts, &format!("**中断** {reason}"));
                }
                "session.mode_changed" => line(&mut l, ts, &format!("モード変更 {} → {}", str_or(e.d("previousMode"), "?"), str_or(e.d("newMode"), "?"))),
                "session.model_change" => {
                    let effort = e.d("reasoningEffort").filter(|v| crate::raw_events::truthy_string(Some(v)).is_some()).map(|v| format!("(推論強度 {})", js::to_js_string(v))).unwrap_or_default();
                    line(&mut l, ts, &format!("モデル変更 {} → {}{effort}", str_or(e.d("previousModel"), "?"), str_or(e.d("newModel"), "?")));
                }
                "session.task_complete" => {
                    line(&mut l, ts, &format!("**タスク完了**{}", if e.d("success") == Some(&Value::Bool(false)) { "(失敗)" } else { "" }));
                    if let Some(s) = e.d_str("summary").filter(|s| !js::trim(s).is_empty()) {
                        let t = w.text(s, o.max_text_chars);
                        push!("", quote(&t), "");
                    }
                }
                "session.resume" => line(&mut l, ts, "セッション再開"),
                "session.shutdown" => {
                    flush_turn(&mut l, turn_no, turn_start_ms, at);
                    turn_no = 0;
                    let cc = match e.d("codeChanges") {
                        Some(v @ (Value::Object(_) | Value::Array(_))) => {
                            let lines_added = int_n(number(Some(v.get("linesAdded").filter(|x| !x.is_null()).unwrap_or(&Value::from(0)))));
                            let lines_removed = int_n(number(Some(v.get("linesRemoved").filter(|x| !x.is_null()).unwrap_or(&Value::from(0)))));
                            let files = v.get("filesModified").and_then(Value::as_array).map(|a| format!("、ファイル {} 件", int_n(a.len() as f64))).unwrap_or_default();
                            format!(": 変更 +{lines_added} / −{lines_removed} 行{files}")
                        }
                        _ => String::new(),
                    };
                    let premium = if e.d("totalPremiumRequestCost").is_some_and(|v| !v.is_null()) { format!("、premium request {}", dec_n(number(e.d("totalPremiumRequestCost")))) } else { String::new() };
                    line(&mut l, ts, &format!("**セッション終了**{cc}{premium}"));
                }
                _ => {}
            }
        }
        flush_turn(&mut l, turn_no, turn_start_ms, prev_at);
        push!("");
    }

    // ---------- 変更ファイル ----------
    let files = &r.files;
    if !files.changed.is_empty() || !files.created.is_empty() || !files.deleted.is_empty() {
        push!("## 変更したファイル", "");
        if anon.enabled {
            push!(format!("変更 {} / 作成 {} / 削除 {} 件(伏せ字モードのためパスは出しません)", int_n(files.changed.len() as f64), int_n(files.created.len() as f64), int_n(files.deleted.len() as f64)), "");
        } else {
            for (label, xs) in [("変更", &files.changed), ("作成", &files.created), ("削除", &files.deleted)] {
                if xs.is_empty() {
                    continue;
                }
                push!(format!("### {label}({})", int_n(xs.len() as f64)), "");
                for f in xs.iter().take(200) {
                    push!(format!("- `{f}`"));
                }
                if xs.len() > 200 {
                    push!(format!("- …他 {} 件", int_n((xs.len() - 200) as f64)));
                }
                push!("");
            }
        }
    }

    // ---------- 秘密情報・分析の観点 ----------
    push!("## 秘密情報の検査", "");
    push!(
        if w.secret_hits > 0 {
            format!("API キーやトークンらしい文字列を {} 件伏せました(`[伏せました: 種類]`)。偽陽性もありえますが、本物なら元の記録(~/.copilot)にも残っているので、鍵を作り直してください。", int_n(w.secret_hits as f64))
        } else {
            "API キーやトークンらしい文字列(GitHub / OpenAI / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)は見つかりませんでした。形式で探しているだけなので、共有する前に中身は確認してください。".to_string()
        },
        ""
    );
    if w.truncated > 0 {
        push!(format!("本文 {} 件を上限(本文 {} 字、ツール結果 {} 字)で中略しました。中略した箇所には字数を書いています。", int_n(w.truncated as f64), int_n(o.max_text_chars as f64), int_n(o.max_tool_chars as f64)), "");
    }

    push!("## 分析の観点(LLM に渡すとき)", "");
    push!(
        "この記録を LLM に渡して振り返るときの観点です。「概要」と「経過」の数値・時刻だけを根拠にし、推測は推測と書くように指示してください。",
        "",
        "1. **時間の内訳**: 「待ち」(人の応答待ち・放置)、モデルの待ち時間(TTFT と全体)、ツールの所要時間のどれが所要時間の大半か。",
        "2. **トークンの内訳**: 役 × モデルで、どの役が入力トークンと AIU を使ったか。キャッシュ読取の比率が低いリクエストはどこか。",
        "3. **手戻り**: 同じファイルへの繰り返しの編集、同じコマンドの再実行、失敗したツールの直後に何をしたか。",
        "4. **失敗と摩擦**: ツール失敗・拒否・エラー・中断の原因(引数の誤り、権限、quota、タイムアウト)と、その後の回復にかかった時間。",
        "5. **compaction**: 前後で何が要約され、要約の後に同じ調査をやり直していないか。",
        "6. **委譲**: サブエージェントに渡した指示と戻った報告の質。本体がその報告を使ったか、やり直したか。",
        "7. **依頼の質**: 依頼文の曖昧さがどの往復を生んだか。指示ファイル(AGENTS.md 等)で防げた往復はあるか。",
        "",
    );

    TranscriptResult { markdown: l.join("\n"), events: events.len(), truncated: w.truncated, secret_hits: w.secret_hits, source }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_like_ts() {
        let (t, n) = redact_secrets(&format!("key ghp_{} and sk-{} x", "a".repeat(36), "b".repeat(24)));
        assert_eq!(n, 2);
        assert_eq!(t, "key [伏せました: GitHub トークン] and [伏せました: OpenAI / Anthropic 系キー] x");
        // 語の境目は ASCII だけで見る(日本語に続いていても当たる)
        let (t, n) = redact_secrets(&format!("鍵はAKIA{}です", "A".repeat(16)));
        assert_eq!((t.as_str(), n), ("鍵は[伏せました: AWS アクセスキー]です", 1));
        let (t, n) = redact_secrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123");
        assert_eq!((t.as_str(), n), ("Authorization: [伏せました: Bearer トークン]", 1));
        // 鍵の形の見本はソースに直書きしない(公開リポジトリの秘密情報検査が反応するため)。実行時に組み立てる
        let pem = |kind: &str| format!("-----{kind} RSA {}-----", ["PRIVATE", "KEY"].join(" "));
        assert_eq!(redact_secrets(&format!("{}\nx\n{}", pem("BEGIN"), pem("END"))).0, "[伏せました: 秘密鍵]");
    }

    #[test]
    fn rel_and_fence() {
        assert_eq!(rel(Some(0), Some(3_723_400)), "+1:02:03");
        assert_eq!(rel(None, Some(1)), "+?:??:??");
        assert_eq!(rel(Some(5000), Some(0)), "+0:00:00");
        assert_eq!(fence("a ```` b\n\n", "json"), "`````json\na ```` b\n`````");
        assert_eq!(fence("x", ""), "```\nx\n```");
    }

    #[test]
    fn args_summary() {
        let v: Value = serde_json::from_str(r#"{"command":"ls   -la\n x"}"#).unwrap();
        assert_eq!(summarize_args("bash", Some(&v)), "ls -la x");
        let v: Value = serde_json::from_str(r#"{"x":1}"#).unwrap();
        assert_eq!(summarize_args("t", Some(&v)), r#"{"x":1}"#);
        assert_eq!(summarize_args("t", None), "");
        let long = format!(r#"{{"prompt":"{}"}}"#, "あ".repeat(200));
        let v: Value = serde_json::from_str(&long).unwrap();
        assert_eq!(summarize_args("t", Some(&v)), format!("{}…", "あ".repeat(160)));
    }
}
