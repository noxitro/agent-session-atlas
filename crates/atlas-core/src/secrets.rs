//! 秘密情報らしい文字列(API キー・トークンなど)を伏せる。
//! もとは atlas-report の transcript.rs にあり、失敗の台帳(normalize.rs)でも使うためここへ移した。
//! atlas_report::transcript::{redact_secrets, SECRET_PATTERNS} の名前でも使える。

use crate::js;
use regex::Regex;
use std::sync::LazyLock;

/// API キー・トークンらしい形(種類名, 正規表現)。JS の \b は ASCII の語の境目なので (?-u:\b) にする。
/// 送り先のフォルダの検査(group_upload の scan_secrets)も、この並びで数える
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

/// 形の決まらない秘密(伏せるときだけ使う。送り先の検査には数えない)。名前付きの組 keep は残し、その後ろを伏せる。
/// - URL の認証情報: scheme://user:pass@ の user:pass
/// - 名前の付いた値: password=… / "api_key": "…" / GITHUB_TOKEN=… の値(既に伏せた [伏せました: …] は除く)
static CONTEXT_PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("URL の認証情報", r"(?i)(?P<keep>(?-u:\b)[a-z][a-z0-9+.-]*://)[^\s/:@'`<>]+:[^\s/@'`<>]+@"),
        ("名前の付いた秘密の値", r#"(?i)(?P<keep>[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?[ \t]*[:=][ \t]*["']?)[^\s"'`&,;\[\]{}()<>][^\s"'`&,;\]{}()<>]{2,}"#),
    ]
    .into_iter()
    .map(|(l, re)| (l, Regex::new(re).unwrap()))
    .collect()
});

/// 秘密情報らしい文字列を [伏せました: 種類] に置き換え、件数を返す。
/// 上限で切る前の全文に掛けること(途中で切れた鍵は形に当たらず残る)
pub fn redact_secrets(text: &str) -> (String, u64) {
    let mut hits = 0u64;
    let mut out: Option<String> = None;
    for (label, re) in SECRET_PATTERNS.iter().chain(CONTEXT_PATTERNS.iter()) {
        let cur = out.as_deref().unwrap_or(text);
        if !re.is_match(cur) {
            continue;
        }
        let rep = format!("[伏せました: {label}]");
        let replaced = re
            .replace_all(cur, |c: &regex::Captures| {
                hits += 1;
                format!("{}{rep}", c.name("keep").map_or("", |m| m.as_str()))
            })
            .into_owned();
        out = Some(replaced);
    }
    (out.unwrap_or_else(|| text.to_string()), hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_shapes() {
        let (t, n) = redact_secrets(&format!("key ghp_{} and sk-{} x", "a".repeat(36), "b".repeat(24)));
        assert_eq!(t, "key [伏せました: GitHub トークン] and [伏せました: OpenAI / Anthropic 系キー] x");
        assert_eq!(n, 2);
        assert_eq!(redact_secrets("nothing here"), ("nothing here".to_string(), 0));
    }

    #[test]
    fn url_userinfo() {
        let (t, n) = redact_secrets("git clone https://bob:hunter2@example.invalid/r.git");
        assert_eq!(t, "git clone https://[伏せました: URL の認証情報]example.invalid/r.git");
        assert_eq!(n, 1);
        // 認証情報の無い URL はそのまま
        assert_eq!(redact_secrets("https://example.invalid/a@b").1, 0);
    }

    #[test]
    fn named_values() {
        assert_eq!(redact_secrets("mysql -u root --password=hunter22").0, "mysql -u root --password=[伏せました: 名前の付いた秘密の値]");
        assert_eq!(redact_secrets(r#"{"api_key": "abc123xyz"}"#).0, r#"{"api_key": "[伏せました: 名前の付いた秘密の値]"}"#);
        assert_eq!(redact_secrets("GITHUB_TOKEN=abcdef").0, "GITHUB_TOKEN=[伏せました: 名前の付いた秘密の値]");
        // 形の決まった鍵を先に伏せたものは、もう一度伏せない
        let (t, n) = redact_secrets(&format!("token=ghp_{}", "a".repeat(36)));
        assert_eq!((t.as_str(), n), ("token=[伏せました: GitHub トークン]", 1));
        // 名前の後ろが値でないもの(max_tokens: 10 など)は伏せない
        assert_eq!(redact_secrets("max_tokens: 1000, secrets found").1, 0);
    }
}
