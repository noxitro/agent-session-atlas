//! 失敗の台帳(analysis.failures)を作る補助。normalize.rs がイベントを読みながら行の材料を集め、
//! 読み終えた後に finish で next(失敗の後に何をしたか)とエージェントを埋める。
//!
//! - 行は tools.results の failure・denied と同じ条件で作る(開始イベントで名前が分かり、success が真偽値。内部ツールは除く)。
//! - 文の項目(エラー文・引数・サブエージェントの prompt)は、全文の秘密らしい文字列を伏せてから上限で切る
//!   (先に切ると、途中で切れた鍵が形に当たらず残る)。group は伏せた後の文から作る。
//! - エージェントは、親の呼び出しの toolCallId(data.parentToolCallId。無ければ agentId から引いた親の呼び出し、
//!   それも無ければ agentId)で見分ける。どちらも無ければ本体。

use crate::js;
use crate::secrets::redact_secrets;
use crate::text::normalize_request;
use crate::types::{CallOutcome, FailureKind, FailureNext, NextKind, ToolFailure};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;

/// 1 セッションで残す行の数(時刻の早い順。超えた分は failuresDropped に数だけ)
pub const MAX_ROWS: usize = 500;
/// エラー文の上限(UTF-16 の単位。切ったときの末尾の … を含む)
pub const ERROR_LIMIT: usize = 1000;
/// 引数の上限
pub const ARGS_LIMIT: usize = 1000;
/// サブエージェントの prompt の上限
pub const PROMPT_LIMIT: usize = 500;
/// group の上限
pub const GROUP_LIMIT: usize = 200;

/// 上限(UTF-16 の単位。末尾の … を含む)で切る
pub fn cap(s: &str, limit: usize) -> String {
    if js::utf16_len(s) <= limit {
        return s.to_string();
    }
    format!("{}…", js::utf16_slice(s, 0, limit.saturating_sub(1)))
}

/// 秘密らしい文字列を全文で伏せてから、上限で切る
pub fn redact_cap(s: &str, limit: usize) -> String {
    cap(&redact_secrets(s).0, limit)
}

/// error の文(文字列はそのまま。オブジェクトは message、無ければ JSON。code があれば「code: message」)
pub fn error_message(error: Option<&Value>) -> String {
    match error {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v @ (Value::Object(_) | Value::Array(_))) => {
            let o = v.as_object();
            let code = o.and_then(|o| o.get("code")).and_then(Value::as_str).unwrap_or("");
            let msg = match o.and_then(|o| o.get("message")).and_then(Value::as_str) {
                Some(m) => m.to_string(),
                None => crate::json::to_js_string(v).unwrap_or_default(),
            };
            if code.is_empty() { msg } else { format!("{code}: {msg}") }
        }
        Some(v) => js::to_js_string(v),
    }
}

/// 引数の文(文字列はそのまま、それ以外は 1 行の JSON)
pub fn args_text(args: &Value) -> String {
    match args {
        Value::String(s) => s.clone(),
        v => crate::json::to_js_string(v).unwrap_or_default(),
    }
}

/// 呼び直しの判定に使う引数の指紋(同じ処理の中で比べるだけなので、版をまたいで同じである必要は無い)
pub fn hash_text(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(^|[^\p{L}\p{N}_])(?:'[^'\n]*'|"[^"\n]*"|‘[^’\n]*’|“[^”\n]*”)"#).unwrap());
static BACKTICKED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").unwrap());

/// 似たエラー文をまとめる鍵: 伏せた後の文の、空でない最初の行の引用を <q> にし、依頼文と同じ正規化
/// (URL・パス・16 進 id・数字を印に、記号を落とす)をして上限で切る
pub fn group_of(redacted_error: &str) -> String {
    let first = redacted_error.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).find(|l| !js::trim(l).is_empty()).unwrap_or("");
    let t = BACKTICKED.replace_all(first, " <q> ");
    let t = QUOTED.replace_all(&t, "${1} <q> ");
    cap(&normalize_request(&t), GROUP_LIMIT)
}

/// 作業のツール呼び出し 1 件(開始イベントの順)。next を探すのに使う
pub struct CallRec {
    /// data.parentToolCallId
    pub parent: Option<String>,
    /// 上位の agentId
    pub aid: Option<String>,
    /// 開始イベントの番号(イベントの並びの何件目か)
    pub start_idx: usize,
    /// その呼び出しを要求した assistant.message の通し番号(toolRequests の toolCallId から)。分からなければ None
    pub batch: Option<usize>,
    pub tool: String,
    pub outcome: CallOutcome,
    pub arg_hash: u64,
}

/// 読み終える前の台帳の 1 行
pub struct PendingRow {
    pub row: ToolFailure,
    pub parent: Option<String>,
    pub aid: Option<String>,
    /// 完了イベントの番号
    pub complete_idx: usize,
    pub batch: Option<usize>,
    /// 失敗した呼び出しの引数の指紋(開始イベントが無ければ None)
    pub arg_hash: Option<u64>,
}

/// エージェントの鍵(親の呼び出しの toolCallId。分からなければ agentId)。本体は None
pub fn agent_key(parent: Option<&str>, aid: Option<&str>, call_by_agent_id: &HashMap<String, String>) -> Option<String> {
    if let Some(p) = parent.filter(|p| !p.is_empty()) {
        return Some(p.to_string());
    }
    let aid = aid.filter(|a| !a.is_empty())?;
    Some(call_by_agent_id.get(aid).cloned().unwrap_or_else(|| aid.to_string()))
}

/// 読み終えた後に、エージェントと next を埋めて台帳を仕上げる。
/// next は、同じエージェントの呼び出しのうち、失敗の完了イベントより後に始まり、失敗と同じ応答で要求されたものでない最初の呼び出し。
/// それより前に始まった呼び出しは並列なので数えない。本体は、その呼び出しより先に利用者の新しい依頼が来たら user
pub fn finish(rows: Vec<PendingRow>, calls: &[CallRec], user_turn_idx: &[usize], call_by_agent_id: &HashMap<String, String>, agent_name: impl Fn(&str) -> Option<String>) -> Vec<ToolFailure> {
    let call_keys: Vec<Option<String>> = calls.iter().map(|c| agent_key(c.parent.as_deref(), c.aid.as_deref(), call_by_agent_id)).collect();
    rows.into_iter()
        .map(|p| {
            let key = agent_key(p.parent.as_deref(), p.aid.as_deref(), call_by_agent_id);
            let mut row = p.row;
            let from = calls.partition_point(|c| c.start_idx <= p.complete_idx);
            let found = (from..calls.len()).find(|&i| {
                let c = &calls[i];
                call_keys[i] == key && !matches!((p.batch, c.batch), (Some(b), Some(cb)) if cb <= b)
            });
            // 失敗の完了より後、until より前に始まった利用者の依頼があるか
            let user_before = |until: usize| {
                let i = user_turn_idx.partition_point(|&u| u <= p.complete_idx);
                user_turn_idx.get(i).is_some_and(|&u| u < until)
            };
            let main = key.is_none();
            row.next = match found {
                Some(i) if !(main && user_before(calls[i].start_idx)) => {
                    let c = &calls[i];
                    FailureNext { kind: NextKind::Tool, tool: Some(c.tool.clone()), outcome: Some(c.outcome), retry: Some(c.tool == row.tool && Some(c.arg_hash) == p.arg_hash) }
                }
                _ if main && user_before(usize::MAX) => FailureNext { kind: NextKind::User, tool: None, outcome: None, retry: None },
                _ => FailureNext { kind: NextKind::End, tool: None, outcome: None, retry: None },
            };
            if let Some(k) = &key {
                row.agent = Some(agent_name(k).unwrap_or_else(|| "(unknown)".into()));
                row.agent_call = Some(k.clone());
            }
            row
        })
        .collect()
}

/// 行の材料(normalize.rs から)
pub struct RowInput<'a> {
    pub tool: &'a str,
    pub error: Option<&'a Value>,
    pub denied: bool,
    pub cause: Option<&'static str>,
    pub args: Option<&'a str>,
    pub mcp_server: Option<String>,
    pub mcp_tool: Option<String>,
    pub mcp_config_source: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub duration_ms: Option<f64>,
    pub turn: Option<i64>,
}

/// 1 行を作る(エージェントと next は finish で埋める)
pub fn build_row(i: RowInput<'_>) -> ToolFailure {
    let err = redact_secrets(&error_message(i.error)).0;
    ToolFailure {
        tool: i.tool.to_string(),
        kind: if i.denied { FailureKind::Denied } else { FailureKind::Failure },
        cause: if i.denied { None } else { i.cause.map(str::to_string) },
        group: group_of(&err),
        error: cap(&err, ERROR_LIMIT),
        args: i.args.map(|a| redact_cap(a, ARGS_LIMIT)),
        mcp_server: i.mcp_server,
        mcp_tool: i.mcp_tool,
        mcp_config_source: i.mcp_config_source,
        model: i.model,
        started_at: i.started_at,
        duration_ms: i.duration_ms,
        turn: i.turn,
        agent: None,
        agent_call: None,
        next: FailureNext { kind: NextKind::End, tool: None, outcome: None, retry: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caps_count_utf16_and_include_ellipsis() {
        assert_eq!(cap("abc", 3), "abc");
        assert_eq!(cap("abcd", 3), "ab…");
        assert_eq!(js::utf16_len(&cap(&"あ".repeat(2000), ERROR_LIMIT)), ERROR_LIMIT);
    }

    #[test]
    fn redacts_before_cutting() {
        // 上限が鍵の途中に掛かっても、先に伏せるので鍵の一部が残らない
        let key = format!("ghp_{}", "a".repeat(36));
        let s = format!("{} {key}", "x".repeat(ARGS_LIMIT - 10));
        let out = redact_cap(&s, ARGS_LIMIT);
        assert!(!out.contains("ghp_"), "{out}");
    }

    #[test]
    fn error_message_forms() {
        assert_eq!(error_message(Some(&json!({"code": "failure", "message": "boom"}))), "failure: boom");
        assert_eq!(error_message(Some(&json!({"message": "boom"}))), "boom");
        assert_eq!(error_message(Some(&json!("plain"))), "plain");
        assert_eq!(error_message(Some(&json!({"code": "denied"}))), r#"denied: {"code":"denied"}"#);
        assert_eq!(error_message(None), "");
    }

    #[test]
    fn groups_similar_errors() {
        let a = group_of("failure: Path 'C:\\w\\a.ts' does not exist (line 12)\nmore");
        let b = group_of("failure: Path 'D:\\other\\b.rs' does not exist (line 7)");
        assert_eq!(a, b);
        assert_eq!(a, "failure path <q> does not exist line <n>");
        // 語の中のアポストロフィは引用にしない
        assert_eq!(group_of("file doesn't exist"), "file doesn t exist");
        assert_eq!(group_of("\n\n"), "");
    }
}
