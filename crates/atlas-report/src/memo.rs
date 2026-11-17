//! セッションごとのメモ(<notes-dir>/memos/<id>.md)の形と抜粋(純関数)。packages/report/src/lib/memo.ts の移植。

use crate::format::truncate;
use atlas_core::js;
use atlas_core::turns::js_re;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// <notes-dir> の下のメモの置き場
pub const MEMOS_DIR_NAME: &str = "memos";
/// 一覧に出す抜粋の字数(全文は atlas.html に埋め込まない)
pub const MEMO_EXCERPT_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoSummary {
    /// 本文の先頭の読める 1 行(Markdown の印を除く)
    pub excerpt: String,
    pub chars: i64,
    /// 本文が参照している画像の数
    pub images: i64,
    pub updated_at: Option<String>,
}

static SAFE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$").unwrap());
/// Windows の予約名(拡張子が付いても同じ扱いになる)。/i は英字だけなので小文字にしてから比べる
static RESERVED_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)").unwrap());
/// Windows で使えない文字、制御文字、先頭の .、末尾の . と空白
static BAD_FILE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|\x00-\x1f]|^\.|[. ]$"#).unwrap());

/// `RESERVED_NAME.test(name)`
pub fn is_reserved_name(name: &str) -> bool {
    RESERVED_NAME.is_match(&name.to_ascii_lowercase())
}

/// 手で置いたファイルの名前として使えるか(日本語や空白は通す。.. は先頭の . で落ちる)
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty() && !BAD_FILE_NAME.is_match(name) && !is_reserved_name(name)
}

/// ファイル名に使える id か
pub fn is_safe_memo_id(id: &str) -> bool {
    SAFE_ID.is_match(id) && is_safe_file_name(id)
}

static IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap());
static LINK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static RULE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^\s*([-*_]\s*){3,}$")).unwrap());
static FENCE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^\s*(```|~~~)")).unwrap());
static MARK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)")).unwrap());
static EMPH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*|__|~~|`").unwrap());

/// 本文の先頭の読める 1 行。画像だけの行は [画像] とする
pub fn memo_excerpt(text: &str) -> String {
    let mut fenced = false;
    // split(/\r?\n/)
    let parts: Vec<&str> = text.split('\n').collect();
    let n = parts.len();
    let lines: Vec<&str> = parts.iter().enumerate().map(|(i, l)| if i + 1 < n { l.strip_suffix('\r').unwrap_or(l) } else { l }).collect();
    // 先頭の YAML front matter は本文ではない
    let close = if lines.first().map(|l| js::trim(l)) == Some("---") { lines.iter().enumerate().position(|(i, l)| i > 0 && js::trim(l) == "---") } else { None };
    let start = close.map_or(0, |c| c + 1);
    for raw in &lines[start..] {
        if RULE_RE.is_match(raw) {
            continue; // 区切り線
        }
        if FENCE_RE.is_match(raw) {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let a = IMAGE_RE.replace_all(raw, "[画像]");
        let b = LINK_RE.replace_all(&a, "${1}");
        let c = MARK_RE.replace(&b, "");
        let d = EMPH_RE.replace_all(&c, ""); // 語の中の _ や * は残す(session_id、2*3)
        let line = js::trim(&d);
        if !line.is_empty() {
            return truncate(Some(line), MEMO_EXCERPT_CHARS);
        }
    }
    String::new()
}

pub fn memo_summary(text: &str, updated_at: Option<&str>) -> MemoSummary {
    MemoSummary { excerpt: memo_excerpt(text), chars: js::code_points(text) as i64, images: IMAGE_RE.find_iter(text).count() as i64, updated_at: updated_at.map(str::to_string) }
}

#[cfg(test)]
mod tests {
    use super::*;

    // memo.test.ts の「memoExcerpt / memoSummary」と「isSafeFileName」
    #[test]
    fn excerpts() {
        assert_eq!(memo_excerpt("\n\n# 見出し\n本文"), "見出し");
        assert_eq!(memo_excerpt("- [ ] **やること** と [リンク](x)"), "やること と リンク");
        assert_eq!(memo_excerpt("```\ncode\n```\n\nあと"), "あと");
        assert_eq!(memo_excerpt("![図](a/b.png)"), "[画像]");
        assert_eq!(memo_excerpt("   \n\n"), "");
        assert_eq!(memo_excerpt("session_id の調査、2*3、~/.copilot"), "session_id の調査、2*3、~/.copilot");
        assert_eq!(memo_excerpt("---\ntitle: x\n---\n\n本文"), "本文");
        assert_eq!(memo_excerpt("---\n\n本文"), "本文");
        let s = memo_summary(&format!("{}\n![a](x/1.png) ![b](x/2.png)", "あ".repeat(100)), Some("2026-11-03T00:00:00.000Z"));
        assert_eq!(s.excerpt, format!("{}…", "あ".repeat(80)));
        assert_eq!(s.images, 2);
        assert_eq!(s.chars, 100 + 1 + 27);
    }

    #[test]
    fn safe_names() {
        for ok in ["メモ.md", "a b.txt", "x"] {
            assert!(is_safe_file_name(ok), "{ok}");
        }
        for bad in ["", ".x", "..", "a/b", "a\\b", "x.", "x ", "CON", "nul.log", "Com1", "a:b", "a\u{1}"] {
            assert!(!is_safe_file_name(bad), "{bad}");
        }
        assert!(is_safe_memo_id("abc-1_2.x"));
        assert!(!is_safe_memo_id(".abc"));
        assert!(!is_safe_memo_id("あ"));
    }
}
