//! 自由記述の文を比べやすい形にそろえる(依頼文のまとまり・失敗の台帳の group で使う)。
//! normalize_request はもと atlas-report の insights.rs にあり(TS は packages/report/src/lib/insights.ts の normalizeRequest)、
//! 失敗の台帳でも使うためここへ移した。atlas_report::insights::normalize_request の名前でも使える。

use crate::js;
use crate::turns::js_re;
use regex::Regex;
use std::sync::LazyLock;

static NR_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"https?:\/\/\S+")).unwrap());
static NR_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r#"(?:[a-z]:[\\/]|\\\\)[^\s"'<>|]*|(?:^|[\s(])(?:\/[\w.-]+){2,}"#)).unwrap());
static NR_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"\b[0-9a-f]{8,}\b")).unwrap());
static NR_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+").unwrap());
static NR_SYMBOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^\p{{L}}\p{{N}}<>{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// 依頼文の正規化: 小文字、URL・パス・数字・16 進 id を印に、記号を落とし、空白を詰める
pub fn normalize_request(text: &str) -> String {
    let t = js::to_lower(text);
    let t = NR_URL.replace_all(&t, " <url> ");
    let t = NR_PATH.replace_all(&t, " <path> ");
    let t = NR_ID.replace_all(&t, " <id> ");
    let t = NR_NUM.replace_all(&t, " <n> ");
    let t = NR_SYMBOL.replace_all(&t, " ");
    let t = WS_RUN.replace_all(&t, " ");
    js::trim(&t).to_string()
}
