//! Phase 14: セッション記録(out/sessions/<id>.md)と全文記録(out/full/<id>.md)を atlas serve の画面で読む(packages/report/src/viewer.ts の移植。
//! サーバの部分は段 5 で移す。ここは描く関数だけ)。
//! - 描き方はメモと同じ規則(memo_render.rs の render_safe_markdown): 生の HTML は文字のまま、リンクは http / https / mailto だけ、外部の画像は読まない。
//!   全文記録だけは out/full/assets/<id>/ への相対参照(画像と書き出したファイル)を通す(サーバが配る ../full/assets/<id>/<名前>)。
//! - ページ(殻)は本文を持たない。本文は殻の script が token を付けて GET /api/view/<id>?kind=… で取り、描いた HTML を差し込む。

use crate::html::esc;
use crate::memo::is_safe_file_name;
use crate::memo_render::{render_safe_markdown, HeadingRef, SafeMarkdownOptions};
use crate::page_nav::{render_rail, render_top, NavLink, PageNavOptions, NAV_JS};
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewKind {
    Transcript,
    Full,
}

impl ViewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewKind::Transcript => "transcript",
            ViewKind::Full => "full",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "transcript" => Some(ViewKind::Transcript),
            "full" => Some(ViewKind::Full),
            _ => None,
        }
    }
}

pub const VIEW_KINDS: [ViewKind; 2] = [ViewKind::Transcript, ViewKind::Full];
/// これより大きい .md は描かない(.md を直接開くリンクと大きさを出す)
pub const VIEW_LIMIT: u64 = 20 * 1024 * 1024;
/// 記録・全文記録の中で atlas 自身が書く、属性の無いタグ(これだけはタグとして描く。他の生の HTML は文字のまま)
pub const VIEW_ALLOWED_TAGS: [&str; 3] = ["small", "details", "summary"];

const IMAGE_EXT: [&str; 5] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
/// リンクにしてよい形式(開いても script が動かないもの)
const PASSIVE_EXT: [&str; 11] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".log", ".json", ".csv", ".pdf", ".bin"];

static NOT_SAFE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]").unwrap());

/// 全文記録の画像などの置き場の名前(full.rs / build と同じ置き換え)
pub fn asset_folder(id: &str) -> String {
    // JS の正規表現は UTF-16 の単位ごとに置き換える(サロゲートペアは 2 つの _ になる)
    NOT_SAFE_ID.replace_all(id, |c: &regex::Captures| "_".repeat(c[0].encode_utf16().count())).into_owned()
}

/// JS の encodeURIComponent
pub fn encode_uri_component(s: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || (c.is_ascii() && KEEP.contains(&(c as u8))) {
            out.push(c);
        } else {
            let c = if atlas_core::js::lone_surrogate_unit(c).is_some() { '\u{fffd}' } else { c };
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// JS の decodeURI(読めない % の並びは Err)。予約文字(; / ? : @ & = + $ , #)の % 表記はそのまま残す
pub fn decode_uri(s: &str) -> Result<String, ()> {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |i: usize| -> Option<u8> { s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).filter(|_| b[i].is_ascii_hexdigit() && b[i + 1].is_ascii_hexdigit()) };
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i + 1).ok_or(())?;
        if first < 0x80 {
            if RESERVED.contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let n = if first & 0xE0 == 0xC0 {
            2
        } else if first & 0xF0 == 0xE0 {
            3
        } else if first & 0xF8 == 0xF0 {
            4
        } else {
            return Err(());
        };
        let mut bytes = vec![first];
        let mut j = i + 3;
        for _ in 1..n {
            if b.get(j) != Some(&b'%') {
                return Err(());
            }
            let x = hex(j + 1).ok_or(())?;
            if x & 0xC0 != 0x80 {
                return Err(());
            }
            bytes.push(x);
            j += 3;
        }
        std::str::from_utf8(&bytes).map_err(|_| ())?;
        out.extend_from_slice(&bytes);
        i = j;
    }
    String::from_utf8(out).map_err(|_| ())
}

/// path.extname(ファイル名だけに使う)を小文字にしたもの
pub fn ext_lower(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && name[..i].chars().any(|c| c != '.') => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// 相対参照が out/full/assets/<id>/ の直下の実在するファイルなら、/view/<id> から見たパスを返す
fn asset_path(full_dir: &Path, id: &str, href: &str) -> Option<(String, bool)> {
    let p = decode_uri(href).ok()?;
    let p = p.strip_prefix("./").unwrap_or(&p);
    let folder = asset_folder(id);
    let parts: Vec<&str> = p.split('/').collect();
    if parts.len() != 3 || parts[0] != "assets" || parts[1] != folder || !is_safe_file_name(parts[2]) {
        return None;
    }
    let ext = ext_lower(parts[2]);
    if !PASSIVE_EXT.contains(&ext.as_str()) {
        return None;
    }
    let file = full_dir.join("assets").join(&folder).join(parts[2]);
    if !file.is_file() {
        return None;
    }
    Some((format!("../full/assets/{}/{}", encode_uri_component(&folder), encode_uri_component(parts[2])), IMAGE_EXT.contains(&ext.as_str())))
}

/// renderViewDocument の結果
#[derive(Debug, Clone, PartialEq)]
pub struct ViewDocument {
    pub html: String,
    pub headings: Vec<HeadingRef>,
    pub title: Option<String>,
}

/// `/^\s*# +([^\n]+?)\s*#*[ \t]*(?:\r?\n|$)/`
static HEAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    let s = atlas_core::js::RE_S;
    Regex::new(&format!(r"^{s}*# +([^\n]+?){s}*#*[ \t]*(?:\r?\n|$)")).unwrap()
});

/// .md の本文を画面用の HTML にする。先頭の「# 表題」はページの h1 にするので本文から外して title で返し、## を h2 にして id を付け目次にする
/// (他の # も h2 より上にはしない)。full_dir は全文記録のときだけ(out/full)。記録には相対の画像もリンクも無いので、どちらも文字だけにする
pub fn render_view_document(markdown: &str, kind: ViewKind, id: &str, full_dir: Option<&Path>) -> ViewDocument {
    let full_dir = if kind == ViewKind::Full { full_dir } else { None };
    let head = HEAD_RE.captures(markdown);
    let body = match &head {
        Some(c) => &markdown[c.get(0).unwrap().end()..],
        None => markdown,
    };
    let image = |href: &str| -> Option<String> {
        let dir = full_dir?;
        let (p, img) = asset_path(dir, id, href)?;
        img.then_some(p)
    };
    let rel = |href: &str| -> Option<String> { full_dir.and_then(|dir| asset_path(dir, id, href).map(|x| x.0)) };
    let opts = SafeMarkdownOptions { image: &image, heading_shift: 0, heading_min: 2, relative_link: Some(&rel), heading_id_level: Some(2), allow_tags: &VIEW_ALLOWED_TAGS };
    let doc = render_safe_markdown(body, &opts);
    ViewDocument { html: doc.html, headings: doc.headings, title: head.map(|c| c[1].to_string()) }
}

pub const VIEW_CSS: &str = include_str!("../assets/view.css");
const VIEWER_JS: &str = include_str!("../assets/viewer.js");

pub fn view_label(kind: ViewKind) -> &'static str {
    match kind {
        ViewKind::Transcript => "セッション記録",
        ViewKind::Full => "全文記録(解析用)",
    }
}

pub struct ViewerShellOptions<'a> {
    pub css: &'a str,
    pub id: &'a str,
    pub kind: ViewKind,
    /// 詳細ページ(sessions/<id>.html)・.md の場所(/view/<id> から見た相対パス)
    pub detail_href: &'a str,
    pub md_href: &'a str,
}

/// /view/<id> の殻。本文と表題は持たない(token の要る API から取る)
pub fn render_viewer_shell(o: &ViewerShellOptions<'_>) -> String {
    let label = view_label(o.kind);
    let nav = PageNavOptions {
        crumb_href: o.detail_href.to_string(),
        crumb_label: "← 詳細ページに戻る".into(),
        toc_label: format!("{label}の見出し"),
        groups: vec![],
        links: vec![NavLink { href: o.md_href.to_string(), label: ".md を開く".into(), download: false, new_window: true }, NavLink { href: "../glossary.html".into(), label: "用語の説明".into(), download: false, new_window: false }],
    };
    format!(
        r##"<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="atlas-token" content="__ATLAS_TOKEN__">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>{title} | Copilot Session Atlas</title>
<script>try{{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}}catch(e){{}}</script>
<style>{css}{view_css}</style>
</head>
<body>
{top}
<div class="shell">
{rail}
<div class="content">
<main class="wrap" data-session="{id}" data-kind="{kind}">
<div class="title"><h1>{title}</h1><p class="note view-status" id="view-status" role="status" aria-live="polite"></p></div>
<article class="doc" id="view-body" aria-label="{title}の本文" hidden></article>
</main>
<footer class="wrap page-foot">atlas serve が .md を描いた表示です(生の HTML は文字のまま、外部の画像は読み込みません)。</footer>
</div>
</div>
<script>{nav_js}</script>
<script>{viewer_js}</script>
</body>
</html>
"##,
        title = esc(label),
        css = o.css,
        view_css = VIEW_CSS,
        top = render_top(&nav),
        rail = render_rail(&nav),
        id = esc(o.id),
        kind = esc(o.kind.as_str()),
        nav_js = NAV_JS,
        viewer_js = VIEWER_JS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_helpers() {
        assert_eq!(encode_uri_component("a b/画"), "a%20b%2F%E7%94%BB");
        assert_eq!(decode_uri("s1/Pasted%20image%201.png").unwrap(), "s1/Pasted image 1.png");
        assert_eq!(decode_uri("s1/..%2F..%2Fx").unwrap(), "s1/..%2F..%2Fx");
        assert!(decode_uri("%E7%94").is_err());
        assert!(decode_uri("%zz").is_err());
        assert_eq!(asset_folder("a/b c"), "a_b_c");
    }

    #[test]
    fn view_document_takes_the_title() {
        let d = render_view_document("# セッション記録: x\n\n## 概要\n\n本文 <small>id</small>\n", ViewKind::Transcript, "s", None);
        assert_eq!(d.title.as_deref(), Some("セッション記録: x"));
        assert_eq!(d.headings, vec![HeadingRef { id: "h-1".into(), text: "概要".into() }]);
        assert!(d.html.contains("<h2 id=\"h-1\">概要</h2>"), "{}", d.html);
        assert!(d.html.contains("<small>id</small>"));
    }
}
