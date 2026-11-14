//! ツールの失敗(tool.execution_complete の success: false)を、error の種類と文の 1 行目から要因に分ける
//! (packages/core/src/tool-failure.ts の移植)。文そのものは残さない。規則は上から順に見て、最初に当たったものにする。

use crate::js::{self, JsMap};
use crate::turns::js_re;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// 要因(表示の順)
pub const FAILURE_CAUSES: [&str; 12] = ["timeout", "quota", "network", "permission", "no_match", "not_found", "exists", "invalid_input", "unavailable", "no_response", "tool_error", "other"];

/// 画面に出す名前
pub fn failure_cause_label(cause: &str) -> &'static str {
    match cause {
        "timeout" => "時間切れ",
        "quota" => "上限・回数制限",
        "network" => "通信・取得の失敗",
        "permission" => "アクセス権・禁止",
        "no_match" => "一致なし",
        "not_found" => "対象が見つからない",
        "exists" => "既にある",
        "invalid_input" => "引数・書式の誤り",
        "unavailable" => "道具が使えない",
        "no_response" => "応答なし",
        "tool_error" => "ツール内部のエラー",
        _ => "その他",
    }
}

/// 何に当たると、その要因とみなすか(画面の用語集でも同じ説明を使う)
pub fn failure_cause_hint(cause: &str) -> &'static str {
    match cause {
        "timeout" => "timed out・timeout・タイムアウト",
        "quota" => "quota・rate limit・too many requests・exceeded your … limit",
        "network" => "取得の失敗(status code)・リダイレクト・DNS・接続の拒否や切断",
        "permission" => "アクセスが拒否・permission denied・EACCES・not allowed・blocked・unauthorized・forbidden",
        "no_match" => "no match・置換や差分の対象の行が見つからない",
        "not_found" => "does not exist・not found・no such file・ENOENT・見つかりません",
        "exists" => "already exists・既に存在",
        "invalid_input" => "parse error・unrecognized・invalid・required・expected・validation・out of bounds・構文",
        "unavailable" => "… available が無い・not running・not connected・unavailable",
        "no_response" => "no response(応答が返らなかった)",
        "tool_error" => "exception・KeyError や TypeError などの例外・internal error・traceback・panic",
        _ => "上のどれにも当たらないもの(文が無いものを含む)",
    }
}

static RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    let r = |s: &str| Regex::new(&format!("(?i){}", js_re(s))).unwrap();
    vec![
        ("timeout", r(r"timed?[ -]?out|timeout|タイムアウト|ETIMEDOUT")),
        ("quota", r(r"quota|rate[ _-]?limit|too many requests|exceeded your\b.*\blimit|使用量の上限")),
        (
            "network",
            r(r"failed to fetch|fetch failed|status code \d|redirect|transport-level|ホストは不明|unknown host|ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up|network error|could not retrieve"),
        ),
        ("permission", r(r"access (?:is )?denied|permission denied|EACCES|EPERM|アクセスが拒否|アクセス許可|not allowed|\bblocked\b|unauthori[sz]ed|forbidden")),
        ("no_match", r(r"no match|failed to find expected|did not match|does not match|no occurrences?|一致しません|一致する.*ありません")),
        ("not_found", r(r"does not exist|doesn't exist|not exist|not found|no such|ENOENT|could not find|cannot find|can't find|見つかりません|存在しません")),
        ("exists", r(r"already exists?|既に存在")),
        (
            "invalid_input",
            r(r"parse error|error parsing|unrecognized|invalid|\brequired\b|\bexpected\b|validation|out of (?:bounds|range)|must (?:specify|be|provide)|syntax|構文|不正な|JSON at position|unknown (?:option|flag|argument)|missing (?:argument|parameter)"),
        ),
        ("unavailable", r(r"\bavailable\b|not running|not connected|disconnected|not started|unavailable|not initiali[sz]ed")),
        ("no_response", r(r"no response|empty response|produced no output")),
        ("tool_error", r(r"exception|KeyError|TypeError|ValueError|AttributeError|ReferenceError|RangeError|internal (?:server )?error|traceback|panic|stack trace|-32603")),
    ]
});

fn error_text(error: Option<&Value>) -> &str {
    match error {
        Some(Value::String(s)) => s,
        Some(Value::Object(o)) => match o.get("message") {
            Some(Value::String(m)) => m,
            _ => "",
        },
        _ => "",
    }
}

fn error_code(error: Option<&Value>) -> Option<&Value> {
    match error {
        Some(Value::Object(o)) => o.get("code"),
        _ => None,
    }
}

/// 利用者・権限設定による拒否か(error.code が denied か rejected)
pub fn is_denied_error(error: Option<&Value>) -> bool {
    matches!(error_code(error), Some(Value::String(c)) if c == "denied" || c == "rejected")
}

/// ツールの失敗の要因(拒否は呼ぶ前に is_denied_error で分ける)。文の空でない最初の行と、failure 以外の error.code を見る
pub fn classify_tool_failure(error: Option<&Value>) -> &'static str {
    let text = error_text(error);
    // split(/\r?\n/) の最初の空でない行
    let first = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).find(|l| !js::trim(l).is_empty()).unwrap_or("");
    let t = match error_code(error) {
        Some(Value::String(code)) if code != "failure" => format!("{code} {first}"),
        _ => first.to_string(),
    };
    if js::trim(&t).is_empty() {
        return "other";
    }
    for (cause, re) in RULES.iter() {
        if re.is_match(&t) {
            return cause;
        }
    }
    "other"
}

/// 要因の回数を足す(into に、from の分を)
pub fn add_causes(into: &mut JsMap<i64>, from: Option<&JsMap<i64>>) {
    if let Some(from) = from {
        for (k, n) in from.js_entries() {
            into.inc(k, *n);
        }
    }
}

/// 要因を回数の多い順に(同じ回数なら表示の順)
pub fn sorted_causes(causes: Option<&JsMap<i64>>) -> Vec<(String, i64)> {
    let mut v: Vec<(String, i64)> = causes.map(|c| c.js_entries().into_iter().filter(|(_, n)| **n > 0).map(|(k, n)| (k.clone(), *n)).collect()).unwrap_or_default();
    let idx = |k: &str| FAILURE_CAUSES.iter().position(|c| *c == k).map_or(-1, |i| i as i64);
    v.sort_by(|a, b| b.1.cmp(&a.1).then(idx(&a.0).cmp(&idx(&b.0))));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(v: Value) -> &'static str {
        classify_tool_failure(Some(&v))
    }

    #[test]
    fn rules() {
        assert_eq!(c(json!("MCP error: Request timed out")), "timeout");
        assert_eq!(c(json!({"message": "You have exceeded your monthly limit"})), "quota");
        assert_eq!(c(json!({"message": "Failed to fetch https://x: status code 404"})), "network");
        assert_eq!(c(json!({"message": "Permission denied and could not request permission from user", "code": "failure"})), "permission");
        assert_eq!(c(json!({"message": "No match found for the old_str"})), "no_match");
        assert_eq!(c(json!({"message": "\n\nPath does not exist\nmore"})), "not_found");
        assert_eq!(c(json!({"message": "File already exists"})), "exists");
        assert_eq!(c(json!({"message": "Invalid input"})), "invalid_input");
        assert_eq!(c(json!({"message": "shell not available"})), "unavailable");
        assert_eq!(c(json!({"message": "unavailableX"})), "unavailable");
        assert_eq!(c(json!({"message": "Tool produced no output"})), "no_response");
        assert_eq!(c(json!({"message": "KeyError: 'x'"})), "tool_error");
        assert_eq!(c(json!({"message": "something odd"})), "other");
        assert_eq!(c(json!({})), "other");
        assert_eq!(c(json!({"code": "timeout"})), "timeout");
        // \b は ASCII の単語境界(日本語の直後でも境界になる)
        assert_eq!(c(json!("日本available")), "unavailable");
        assert_eq!(c(json!("navailable")), "other");
    }

    #[test]
    fn denied() {
        assert!(is_denied_error(Some(&json!({"code": "denied"}))));
        assert!(is_denied_error(Some(&json!({"code": "rejected"}))));
        assert!(!is_denied_error(Some(&json!({"code": "failure"}))));
        assert!(!is_denied_error(Some(&json!("denied"))));
    }

    #[test]
    fn sorting() {
        let mut m: JsMap<i64> = JsMap::new();
        m.inc("other", 2);
        m.inc("timeout", 2);
        m.inc("quota", 5);
        let s = sorted_causes(Some(&m));
        assert_eq!(s.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["quota", "timeout", "other"]);
    }
}
