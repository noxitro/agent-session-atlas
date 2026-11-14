//! Markdown を HTML にする(packages/report/src/memo-render.ts の移植)。
//! TS 版は marked(gfm・breaks)の renderer を差し替えていた。Rust 版は comrak で構文木を作り、HTML は ここで書く
//! (marked の既定の renderer と同じ形: `<p>…</p>\n`・`<ul>\n<li>…</li>\n</ul>\n`・`<br>`・表の改行の位置など)。出力する属性と文字は全て esc する。
//! メモの本文は共有する HTML にも載るので、生の HTML は文字として出し、リンクは http(s) と mailto だけ、画像は呼び元が解決したものだけにする。
//! Phase 14: 同じ規則で、atlas serve がセッション記録・全文記録(.md)を画面に描く(viewer.rs)。見出しの段・相対リンクの扱い・見出しの id だけを呼び元が選ぶ。
//!
//! marked との違いを小さくするための手当て(scripts/parity-markdown.ts で突き合わせる):
//! - 文字参照(`&amp;` `&copy;` `&#39;` など)は comrak に展開させない(comrak に渡す前に `&` を目印の文字に替え、書くときに戻す)。
//!   marked は名前の文字参照を展開せず文字のまま出し、数値の文字参照は、それを含む文字の塊(marked の inline text の 1 回の一致)でだけ展開して、
//!   その塊の裸の `&` を `&amp;` にする(marked の inlineText が呼ぶ関数と同じ)。塊の切れ目は marked の text の規則に近い位置で切る(marked_segments)
//! - 引用・段落の改行は `<br>`(breaks)、コードの囲みは info を出さず `<pre><code>…</code></pre>`

use crate::html::esc;
use atlas_core::js;
use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};
use regex::Regex;
use std::sync::LazyLock;

/// 節の h2 の下に入るので見出しは 2 段下げる(メモの既定)
const MEMO_HEADING_SHIFT: i32 = 2;
static SAFE_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(https?:|mailto:)").unwrap());
static HAS_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^([a-z][a-z0-9+.-]*:|//)").unwrap());
/// comrak に展開させない文字参照(名前と数値)
static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&([A-Za-z][A-Za-z0-9]*;|#(?:[0-9]{1,7}|[Xx][A-Fa-f0-9]{1,6});)").unwrap());
static NUMERIC_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#(?:([0-9]{1,7})|[Xx]([A-Fa-f0-9]{1,6}));").unwrap());
static NUMERIC_OR_AMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#(?:([0-9]{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&").unwrap());
/// marked の `&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)` の先読みの部分(JS の \w は ASCII だけ)
static AMP_KEEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:#[0-9]{1,7}|#[Xx][a-fA-F0-9]{1,6}|[A-Za-z0-9_]+);").unwrap());

/// marked の inline text の 1 回の一致に近い切れ目で分ける(次の `\ < ! [ ` * ~ _` と、http:// https:// ftp:// www. の前)
fn marked_segments(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if i == start {
            continue;
        }
        let rest = &s[i..];
        let cut = matches!(c, '\\' | '<' | '!' | '[' | '`' | '*' | '~' | '_') || rest.starts_with("http://") || rest.starts_with("https://") || rest.starts_with("ftp://") || rest.starts_with("www.");
        if cut {
            out.push(&s[start..i]);
            start = i;
        }
    }
    out.push(&s[start..]);
    out
}

/// marked の数値の文字参照の展開(0・範囲外・サロゲートは U+FFFD、38 は「&amp;」の文字列)
fn numeric_char(code: Option<u32>) -> String {
    match code {
        Some(0) | None => "\u{fffd}".to_string(),
        Some(38) => "&amp;".to_string(),
        Some(n) if n > 0x10FFFF || (0xD800..=0xDFFF).contains(&n) => "\u{fffd}".to_string(),
        Some(n) => char::from_u32(n).map(String::from).unwrap_or_else(|| "\u{fffd}".to_string()),
    }
}

/// メモの本文の見た目(メモのあるページにだけ入れる。編集の script も同じものを入れる)
pub const MEMO_CSS: &str = include_str!("../assets/memo.css");

pub struct SafeMarkdownOptions<'a> {
    /// 本文の画像の参照(スキームの無いもの)を src にする。無い・大きすぎる・置き場の外なら None
    pub image: &'a dyn Fn(&str) -> Option<String>,
    /// 見出しを何段下げるか(既定 2: メモは節の h2 の下に入る)
    pub heading_shift: i32,
    /// 下げた後の見出しの最小の段(既定 1)。ページの h1 を表題に取っておくときは 2
    pub heading_min: i32,
    /// スキームの無いリンク(相対パス)を href にする。None なら文字だけ(既定は全て文字だけ)
    pub relative_link: Option<&'a dyn Fn(&str) -> Option<String>>,
    /// この段(下げた後)の見出しに id(h-1, h-2, …)を付け、目次用に返す
    pub heading_id_level: Option<i32>,
    /// 生の HTML のうち、属性の無いこの名前のタグ(<small> と </small> の形そのもの)だけはタグとして残す。他は全て文字のまま
    pub allow_tags: &'a [&'a str],
}

impl<'a> SafeMarkdownOptions<'a> {
    pub fn new(image: &'a dyn Fn(&str) -> Option<String>) -> Self {
        SafeMarkdownOptions { image, heading_shift: MEMO_HEADING_SHIFT, heading_min: 1, relative_link: None, heading_id_level: None, allow_tags: &[] }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HeadingRef {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SafeMarkdown {
    pub html: String,
    /// heading_id_level の見出し(id と本文の文字)
    pub headings: Vec<HeadingRef>,
}

fn comrak_options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.render.hardbreaks = true;
    o
}

/// 本文に無い私用領域の文字(名前の文字参照の & の目印)
fn pick_sentinel(text: &str) -> char {
    ('\u{E000}'..='\u{F8FF}').find(|c| !text.contains(*c)).unwrap_or('\u{E000}')
}

struct Renderer<'o, 'a> {
    o: &'o SafeMarkdownOptions<'a>,
    shift: i32,
    sentinel: char,
    headings: Vec<HeadingRef>,
    /// comrak に渡した本文と、行の始まりの位置(行頭の空白を戻すのに使う)
    src: &'o str,
    line_starts: Vec<usize>,
}

impl Renderer<'_, '_> {
    /// 目印を & に戻す
    fn restore(&self, s: &str) -> String {
        if s.contains(self.sentinel) { s.replace(self.sentinel, "&") } else { s.to_string() }
    }

    fn esc(&self, s: &str) -> String {
        esc(&self.restore(s))
    }

    /// 節の始まりの前にある、同じ行の空白とタブ
    fn leading_ws<'n>(&self, node: &'n AstNode<'n>) -> &str {
        let pos = node.data.borrow().sourcepos.start;
        let (Some(&start), true) = (self.line_starts.get(pos.line.wrapping_sub(1)), pos.column >= 1) else { return "" };
        let end = (start + pos.column - 1).min(self.src.len());
        let Some(prefix) = self.src.get(start..end) else { return "" };
        let ws = prefix.len() - prefix.trim_end_matches([' ', '\t']).len();
        &prefix[prefix.len() - ws..]
    }

    /// 節の終わりの後にある、同じ行の行末までの空白とタブ(行末まで空白だけのときだけ)
    fn trailing_ws<'n>(&self, node: &'n AstNode<'n>) -> &str {
        let pos = node.data.borrow().sourcepos.end;
        let Some(&start) = self.line_starts.get(pos.line.wrapping_sub(1)) else { return "" };
        let line_end = self.src[start..].find('\n').map_or(self.src.len(), |i| start + i);
        let from = start + pos.column;
        match self.src.get(from.min(line_end)..line_end) {
            Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b == b' ' || b == b'\t') => rest,
            _ => "",
        }
    }

    /// 文字の並び(comrak の Text が続いたもの)を、marked の inline text の token の text と同じ形にする
    fn marked_text(&self, run: &str) -> String {
        if !run.contains(self.sentinel) {
            return run.to_string();
        }
        marked_segments(run).into_iter().map(|seg| self.decode_segment(seg)).collect()
    }

    /// 数値の文字参照を含む塊だけ、参照を展開して裸の & を &amp; にする
    fn decode_segment(&self, seg: &str) -> String {
        let raw = self.restore(seg);
        if !NUMERIC_REF.is_match(&raw) {
            return raw;
        }
        NUMERIC_OR_AMP
            .replace_all(&raw, |c: &regex::Captures| match (c.get(1), c.get(2)) {
                (Some(d), _) => numeric_char(d.as_str().parse::<u32>().ok()),
                (None, Some(h)) => numeric_char(u32::from_str_radix(h.as_str(), 16).ok()),
                (None, None) => {
                    if AMP_KEEP.is_match(&raw[c.get(0).unwrap().end()..]) { "&".to_string() } else { "&amp;".to_string() }
                }
            })
            .into_owned()
    }

    fn block<'n>(&mut self, node: &'n AstNode<'n>, out: &mut String, tight: bool) {
        let value = node.data.borrow().value.clone();
        match value {
            NodeValue::Document => self.blocks(node, out, false),
            NodeValue::Paragraph => {
                // 段落の最後の行の行末の空白は、marked と同じく文字として残す(CommonMark は落とす)
                // (リストの最後の項目は marked が末尾の空白を落とすので除く)
                let last_item = node.parent().is_some_and(|p| matches!(p.data.borrow().value, NodeValue::Item(_) | NodeValue::TaskItem(_)) && p.next_sibling().is_none());
                let trailing = if last_item { String::new() } else { node.last_child().map_or(String::new(), |c| self.trailing_ws(c).to_string()) };
                if tight {
                    self.inlines(node, out);
                    out.push_str(&trailing);
                } else {
                    // 文書の直下の段落の 1 行目の行頭の空白は、marked と同じく文字として残す(CommonMark は落とす。2 行目からは marked も落とす)
                    let top = node.parent().is_some_and(|p| matches!(p.data.borrow().value, NodeValue::Document));
                    out.push_str("<p>");
                    if top {
                        out.push_str(self.leading_ws(node));
                    }
                    self.inlines(node, out);
                    out.push_str(&trailing);
                    out.push_str("</p>\n");
                }
            }
            NodeValue::Heading(h) => {
                let n = (h.level as i32 + self.shift).max(self.o.heading_min).min(6);
                let mut id = String::new();
                if self.o.heading_id_level == Some(n) {
                    let hid = format!("h-{}", self.headings.len() + 1);
                    let mut plain = String::new();
                    self.plain_text(node, &mut plain);
                    self.headings.push(HeadingRef { id: hid.clone(), text: js::trim(&self.restore(&plain)).to_string() });
                    id = format!(" id=\"{hid}\"");
                }
                out.push_str(&format!("<h{n}{id}>"));
                self.inlines(node, out);
                out.push_str(&format!("</h{n}>\n"));
            }
            NodeValue::ThematicBreak => out.push_str("<hr>\n"),
            NodeValue::BlockQuote => {
                out.push_str("<blockquote>\n");
                self.blocks(node, out, false);
                out.push_str("</blockquote>\n");
            }
            NodeValue::List(l) => {
                let (tag, start) = match l.list_type {
                    ListType::Ordered => ("ol", if l.start != 1 { format!(" start=\"{}\"", l.start) } else { String::new() }),
                    ListType::Bullet => ("ul", String::new()),
                };
                out.push_str(&format!("<{tag}{start}>\n"));
                for item in node.children() {
                    self.list_item(item, out, l.tight);
                }
                out.push_str(&format!("</{tag}>\n"));
            }
            NodeValue::Item(_) | NodeValue::TaskItem(_) => self.list_item(node, out, tight),
            NodeValue::CodeBlock(c) => {
                let text = if c.fenced { c.literal.strip_suffix('\n').unwrap_or(&c.literal).to_string() } else { c.literal.trim_end_matches('\n').to_string() };
                out.push_str("<pre><code>");
                out.push_str(&self.esc(&text));
                out.push_str("</code></pre>\n");
            }
            NodeValue::HtmlBlock(h) => {
                let s = self.html_text(h.literal.trim_end_matches('\n'));
                // details の開始・終了の塊は段落で包まない(<p><details> は入れ子として成り立たない)
                if starts_with_details(&s) {
                    out.push_str(&s);
                    out.push('\n');
                } else {
                    out.push_str("<p>");
                    out.push_str(&s);
                    out.push_str("</p>\n");
                }
            }
            NodeValue::Table(t) => {
                let aligns = t.alignments.clone();
                let mut rows = node.children();
                out.push_str("<table>\n<thead>\n");
                if let Some(head) = rows.next() {
                    self.table_row(head, out, &aligns, "th");
                }
                out.push_str("</thead>\n");
                let mut body = String::new();
                for r in rows {
                    self.table_row(r, &mut body, &aligns, "td");
                }
                if !body.is_empty() {
                    out.push_str("<tbody>");
                    out.push_str(&body);
                    out.push_str("</tbody>");
                }
                out.push_str("</table>\n");
            }
            // 他の拡張は有効にしていない。念のため子を描く(黙って落とさない)
            _ => self.blocks(node, out, tight),
        }
    }

    fn blocks<'n>(&mut self, node: &'n AstNode<'n>, out: &mut String, tight: bool) {
        for c in node.children() {
            self.block(c, out, tight);
        }
    }

    fn list_item<'n>(&mut self, item: &'n AstNode<'n>, out: &mut String, tight: bool) {
        let task = match &item.data.borrow().value {
            NodeValue::TaskItem(t) => Some(t.symbol.is_some()),
            _ => None,
        };
        out.push_str("<li>");
        let checkbox = |checked: bool| format!("<input {}disabled=\"\" type=\"checkbox\">", if checked { "checked=\"\" " } else { "" });
        let mut first = true;
        for c in item.children() {
            let is_para = matches!(c.data.borrow().value, NodeValue::Paragraph);
            if first && let Some(checked) = task {
                if tight || !is_para {
                    out.push_str(&checkbox(checked));
                    out.push(' ');
                    self.block(c, out, tight);
                } else {
                    out.push_str("<p>");
                    out.push_str(&checkbox(checked));
                    out.push(' ');
                    self.inlines(c, out);
                    out.push_str("</p>\n");
                }
            } else {
                self.block(c, out, tight);
            }
            first = false;
        }
        if first && let Some(checked) = task {
            out.push_str(&checkbox(checked));
            out.push(' ');
        }
        out.push_str("</li>\n");
    }

    fn table_row<'n>(&mut self, row: &'n AstNode<'n>, out: &mut String, aligns: &[TableAlignment], tag: &str) {
        out.push_str("<tr>\n");
        for (i, cell) in row.children().enumerate() {
            let align = match aligns.get(i) {
                Some(TableAlignment::Left) => " align=\"left\"",
                Some(TableAlignment::Right) => " align=\"right\"",
                Some(TableAlignment::Center) => " align=\"center\"",
                _ => "",
            };
            out.push_str(&format!("<{tag}{align}>"));
            self.inlines(cell, out);
            out.push_str(&format!("</{tag}>\n"));
        }
        out.push_str("</tr>\n");
    }

    /// 生の HTML: esc したうえで、許したタグの形だけを戻す
    fn html_text(&self, raw: &str) -> String {
        let mut s = self.esc(raw);
        for tag in self.o.allow_tags {
            s = s.replace(&format!("&lt;{tag}&gt;"), &format!("<{tag}>")).replace(&format!("&lt;/{tag}&gt;"), &format!("</{tag}>"));
        }
        s
    }

    fn inlines<'n>(&mut self, node: &'n AstNode<'n>, out: &mut String) {
        // 続く文字はまとめて esc する(「://」「fetch(」が節の境目で分かれても同じ結果にする)
        let mut text = String::new();
        for c in node.children() {
            let value = c.data.borrow().value.clone();
            if let NodeValue::Text(t) = &value {
                text.push_str(t);
                continue;
            }
            if !text.is_empty() {
                out.push_str(&esc(&self.marked_text(&text)));
                text.clear();
            }
            self.inline(c, value, out);
        }
        if !text.is_empty() {
            out.push_str(&esc(&self.marked_text(&text)));
        }
    }

    fn inline<'n>(&mut self, node: &'n AstNode<'n>, value: NodeValue, out: &mut String) {
        match value {
            NodeValue::Text(t) => out.push_str(&esc(&self.marked_text(&t))),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push_str("<br>"),
            NodeValue::Code(c) => {
                out.push_str("<code>");
                out.push_str(&self.esc(&c.literal));
                out.push_str("</code>");
            }
            NodeValue::HtmlInline(h) => out.push_str(&self.html_text(&h)),
            NodeValue::Emph => self.wrap(node, out, "em"),
            NodeValue::Strong => self.wrap(node, out, "strong"),
            NodeValue::Strikethrough => self.wrap(node, out, "del"),
            NodeValue::Link(l) => {
                let href = self.restore(&l.url);
                let mut label = String::new();
                self.inlines(node, &mut label);
                if SAFE_LINK.is_match(&href) {
                    out.push_str(&format!("<a href=\"{}\" rel=\"noreferrer noopener\">{label}</a>", esc(&href)));
                    return;
                }
                if !HAS_SCHEME.is_match(&href)
                    && let Some(rel) = self.o.relative_link
                    && let Some(h) = rel(&href)
                {
                    out.push_str(&format!("<a href=\"{}\">{label}</a>", esc(&h)));
                    return;
                }
                out.push_str(&label);
            }
            NodeValue::Image(l) => {
                let href = self.restore(&l.url);
                let mut alt = String::new();
                self.plain_text(node, &mut alt);
                let alt = self.restore(&alt);
                let alt = if alt.is_empty() { "メモの画像".to_string() } else { alt };
                if HAS_SCHEME.is_match(&href) {
                    let label = format!("外部の画像(読み込みません): {alt}");
                    if SAFE_LINK.is_match(&href) {
                        out.push_str(&format!("<a href=\"{}\" rel=\"noreferrer noopener\">{}</a>", esc(&href), esc(&label)));
                    } else {
                        out.push_str(&esc(&label));
                    }
                    return;
                }
                match (self.o.image)(&href) {
                    Some(src) => out.push_str(&format!("<img src=\"{}\" alt=\"{}\">", esc(&src), esc(&alt))),
                    None => out.push_str(&format!("<span class=\"missing-value\">画像を表示できません: {}</span>", esc(&href))),
                }
            }
            _ => self.inlines(node, out),
        }
    }

    fn wrap<'n>(&mut self, node: &'n AstNode<'n>, out: &mut String, tag: &str) {
        out.push_str(&format!("<{tag}>"));
        self.inlines(node, out);
        out.push_str(&format!("</{tag}>"));
    }

    /// 見出しの文字(目次用)・画像の alt: inline の印を落とした素の文字
    fn plain_text<'n>(&self, node: &'n AstNode<'n>, out: &mut String) {
        for c in node.children() {
            match &c.data.borrow().value {
                NodeValue::Text(t) => out.push_str(&self.marked_text(t)),
                NodeValue::Code(x) => out.push_str(&x.literal),
                NodeValue::HtmlInline(h) => out.push_str(h),
                NodeValue::SoftBreak => out.push('\n'),
                NodeValue::LineBreak => out.push('\n'),
                _ => self.plain_text(c, out),
            }
        }
    }
}

/// `/^\s*<\/?details>/`
fn starts_with_details(s: &str) -> bool {
    let rest = s.trim_start_matches(js::is_js_whitespace);
    rest.starts_with("<details>") || rest.starts_with("</details>")
}

pub fn render_safe_markdown(text: &str, o: &SafeMarkdownOptions<'_>) -> SafeMarkdown {
    let sentinel = pick_sentinel(text);
    // marked と同じく改行は LF にそろえる
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let src = ENTITY.replace_all(&normalized, |c: &regex::Captures| format!("{sentinel}{}", &c[1]));
    let arena = Arena::new();
    let options = comrak_options();
    let root = parse_document(&arena, &src, &options);
    let line_starts: Vec<usize> = std::iter::once(0).chain(src.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let mut r = Renderer { o, shift: o.heading_shift, sentinel, headings: Vec::new(), src: &src, line_starts };
    let mut html = String::new();
    r.block(root, &mut html, false);
    SafeMarkdown { html, headings: r.headings }
}

/// メモの本文(見出しは h3 から)。image は本文の画像の参照を data: URI にする。無い・大きすぎる・置き場の外なら None
pub fn render_memo_html(text: &str, image: &dyn Fn(&str) -> Option<String>) -> String {
    render_safe_markdown(text, &SafeMarkdownOptions::new(image)).html
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(md: &str) -> String {
        render_memo_html(md, &|_| None)
    }

    #[test]
    fn raw_html_is_text() {
        let html = render("<script>alert(1)</script>\n\n本文 <img src=x onerror=alert(2)> と <b>太字</b>");
        assert!(!html.contains("<script") && !html.contains("<img") && !html.contains("<b>"), "{html}");
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&lt;img src=x onerror=alert(2)&gt;"));
    }

    #[test]
    fn links_only_http_and_mailto() {
        assert!(render("[a](https://example.test/x)").contains("<a href=\"https:&#47;&#47;example.test/x\" rel=\"noreferrer noopener\">a</a>"));
        assert!(render("[m](mailto:a@example.test)").contains("href=\"mailto:a@example.test\""));
        for md in ["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html,<b>)", "[x](vbscript:x)"] {
            let html = render(md);
            assert!(!html.contains("<a "), "{md} {html}");
            assert!(html.contains('x'));
        }
    }

    #[test]
    fn no_raw_scheme_in_output() {
        let html = render("見る http://example.test/a と `https://example.test/b` と foo://bar\n\n```\nfetch(\"http://example.test\")\n```");
        assert!(!html.contains("http://") && !html.contains("https://"), "{html}");
        assert!(!html.contains("fetch("));
    }

    #[test]
    fn headings_shift() {
        assert!(render("# a").contains("<h3>a</h3>"));
        assert!(render("###### a").contains("<h6>a</h6>"));
    }

    #[test]
    fn images() {
        let remote = render("![図](https://example.test/a.png)");
        assert!(!remote.contains("<img"));
        assert!(remote.contains("外部の画像(読み込みません): 図"));
        assert!(!render("![図](javascript:alert(1))").contains("<img"));
        assert!(!render("![図](javascript:alert(1))").contains("<a "));
        assert!(!render("![図](//example.test/a.png)").contains("<img"));
        assert!(render_memo_html("![a\"b](x/y.png)", &|_| Some("data:image/png;base64,AA==".into())).contains("<img src=\"data:image/png;base64,AA==\" alt=\"a&quot;b\">"));
        assert!(render("![a](x/y.png)").contains("画像を表示できません: x/y.png"));
    }

    #[test]
    fn gfm_marked_shapes() {
        assert_eq!(render("- [ ] 未\n- [x] 済"), "<ul>\n<li><input disabled=\"\" type=\"checkbox\"> 未</li>\n<li><input checked=\"\" disabled=\"\" type=\"checkbox\"> 済</li>\n</ul>\n");
        assert_eq!(
            render("| a | b |\n|:-|-:|\n| 1 | 2 |"),
            "<table>\n<thead>\n<tr>\n<th align=\"left\">a</th>\n<th align=\"right\">b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align=\"left\">1</td>\n<td align=\"right\">2</td>\n</tr>\n</tbody></table>\n"
        );
        assert_eq!(render("1 行目\n2 行目"), "<p>1 行目<br>2 行目</p>\n");
        assert_eq!(render("- a\n  - b\n- c"), "<ul>\n<li>a<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>\n");
        assert_eq!(render("- a\n\n  b\n- c"), "<ul>\n<li><p>a</p>\n<p>b</p>\n</li>\n<li><p>c</p>\n</li>\n</ul>\n");
        assert_eq!(render("3. a\n4. b"), "<ol start=\"3\">\n<li>a</li>\n<li>b</li>\n</ol>\n");
        assert_eq!(render("&amp; &#39; &copy;"), "<p>&amp;amp; &#39; &amp;copy;</p>\n");
        assert_eq!(render("<div>\nhi\n</div>\n\npara"), "<p>&lt;div&gt;\nhi\n&lt;/div&gt;</p>\n<p>para</p>\n");
    }
}
