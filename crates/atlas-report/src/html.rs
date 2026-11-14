//! ページを書くときの共通の道具: HTML エスケープ(packages/report/src/detail.ts の esc)と、Node と同じバイト列でのファイルの書き出し。

use std::borrow::Cow;
use std::path::Path;

/// HTML エスケープ。外部参照の静的検査(http:// / fetch( の不在)を本文中の文字列で誤検出しないよう、:// と fetch( も実体参照にする
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 8);
    esc_into(s, &mut out);
    out
}

/// esc の結果を out に足す
pub fn esc_into(s: &str, out: &mut String) {
    let b = s.as_bytes();
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        let rep: Option<(&str, usize)> = match b[i] {
            b'&' => Some(("&amp;", 1)),
            b'<' => Some(("&lt;", 1)),
            b'>' => Some(("&gt;", 1)),
            b'"' => Some(("&quot;", 1)),
            b'\'' => Some(("&#39;", 1)),
            b':' if b[i + 1..].starts_with(b"//") => Some((":&#47;&#47;", 3)),
            b'f' if b[i..].starts_with(b"fetch(") => Some(("fetch&#40;", 6)),
            _ => None,
        };
        match rep {
            Some((r, n)) => {
                out.push_str(&s[last..i]);
                out.push_str(r);
                i += n;
                last = i;
            }
            None => i += 1,
        }
    }
    out.push_str(&s[last..]);
}

/// `esc(x ?? '')` の Option 版
pub fn esc_opt(s: Option<&str>) -> String {
    esc(s.unwrap_or(""))
}

/// Node が文字列を UTF-8 にするときと同じバイト列(サロゲートの片割れ(js.rs の私用領域の文字)は U+FFFD)
pub fn node_utf8(s: &str) -> Cow<'_, str> {
    // U+10F800〜U+10FFFF は UTF-8 で F4 8F から始まる
    if !s.as_bytes().contains(&0xF4) || !s.chars().any(|c| atlas_core::js::lone_surrogate_unit(c).is_some()) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(s.chars().map(|c| if atlas_core::js::lone_surrogate_unit(c).is_some() { '\u{fffd}' } else { c }).collect())
}

/// Node の `Buffer.byteLength(s)`
pub fn byte_length(s: &str) -> u64 {
    node_utf8(s).len() as u64
}

/// `writeFile(path, s)`(UTF-8。片割れは U+FFFD)
pub fn write_text(path: &Path, s: &str) -> std::io::Result<()> {
    std::fs::write(path, node_utf8(s).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_detail_ts() {
        assert_eq!(esc(r#"<a href="x">'&'</a>"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
        assert_eq!(esc("see http://x.test/ and fetch(1) :///"), "see http:&#47;&#47;x.test/ and fetch&#40;1) :&#47;&#47;/");
        assert_eq!(esc("fetc fetch fetch("), "fetc fetch fetch&#40;");
        assert_eq!(esc("日本語"), "日本語");
    }
}
