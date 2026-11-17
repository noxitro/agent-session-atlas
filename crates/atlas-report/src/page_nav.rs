//! 静的ページ(詳細・用語)の目次の帯と上部(packages/report/src/page-nav.ts の移植)。atlas.html(App.svelte)と同じ作法:
//! 768px 以上は左に固定したサイドバー(戻る → 目次 → 別ページへのリンク → 配色)、768px 未満は上部に固定した細い目次行(横に流れる)と、
//! その上の帯(戻る・リンク・配色)。見た目は base.css の .rail / .toc / .top が持ち、動きは NAV_JS(外部参照なし、file:// で動く)。
//!
//! NAV_JS などページに埋め込む JS は、TS の定数の値をそのまま assets/ に書き出したもの(scripts/gen-report-assets.ts。
//! 中の SCROLLERS(lib/scroll-focus.ts)と STALE_MESSAGE(lib/code-check.ts)も TS が埋めた値のまま)。ずれは cargo test が検出する。

use crate::html::esc;

#[derive(Debug, Clone, Default)]
pub struct NavItem {
    pub href: String,
    pub label: String,
    /// 項目数などの小さな数字(用語ページの分類)
    pub count: Option<i64>,
    /// 件数の読み上げの単位(既定は「項目」)
    pub count_label: Option<String>,
    /// 単位を数字の後ろに見せる(数字だけだと番号に読めるもの。既定は読み上げだけ)
    pub show_count_label: bool,
    /// 1 行の説明(サイドバーでだけ出す)
    pub lead: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NavGroup {
    /// 群の題(サイドバーでだけ出す。無ければ区切りだけ)
    pub title: Option<String>,
    pub items: Vec<NavItem>,
}

#[derive(Debug, Clone, Default)]
pub struct NavLink {
    pub href: String,
    pub label: String,
    pub download: bool,
    /// 別のウィンドウ(タブ)で開く。記録の .md など、今のページを残したまま読むもの
    pub new_window: bool,
}

impl NavLink {
    pub fn new(href: impl Into<String>, label: impl Into<String>) -> Self {
        NavLink { href: href.into(), label: label.into(), download: false, new_window: false }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PageNavOptions {
    pub crumb_href: String,
    pub crumb_label: String,
    pub toc_label: String,
    pub groups: Vec<NavGroup>,
    pub links: Vec<NavLink>,
}

const THEME_SEG: &str = include_str!("../assets/theme-seg.html");

/// 別ウィンドウで開くリンクの印(見た目は ↗、読み上げは文で)
pub const NEW_WINDOW_MARK: &str = include_str!("../assets/new-window-mark.html");

/// 静的ページの動き(1 本にまとめて各ページに埋め込む)。中身の説明は page-nav.ts の NAV_JS のコメント
pub const NAV_JS: &str = include_str!("../assets/nav.js");

fn links(ls: &[NavLink]) -> String {
    let mut out = String::new();
    for l in ls {
        out.push_str(&format!("<li><a href=\"{}\"{}", esc(&l.href), if l.download { " download" } else { "" }));
        if l.new_window {
            out.push_str(&format!(" target=\"_blank\" rel=\"noopener\">{}{NEW_WINDOW_MARK}", esc(&l.label)));
        } else {
            out.push_str(&format!(">{}", esc(&l.label)));
        }
        out.push_str("</a></li>");
    }
    out
}

fn toc(o: &PageNavOptions) -> String {
    let mut groups = String::new();
    for g in &o.groups {
        match &g.title {
            Some(t) => groups.push_str(&format!("<div class=\"toc-group\" role=\"group\" aria-label=\"{}\"><span class=\"toc-title\" aria-hidden=\"true\">{}</span><ol>", esc(t), esc(t))),
            None => groups.push_str("<div class=\"toc-group\"><ol>"),
        }
        for it in &g.items {
            groups.push_str(&format!("<li><a href=\"{}\">{}", esc(&it.href), esc(&it.label)));
            if let Some(n) = it.count {
                let unit = esc(it.count_label.as_deref().unwrap_or("項目"));
                if it.show_count_label {
                    groups.push_str(&format!("<span class=\"cnt\">{n} {unit}</span>"));
                } else {
                    groups.push_str(&format!("<span class=\"cnt\" aria-label=\"{n} {unit}\">{n}</span>"));
                }
            }
            if let Some(lead) = it.lead.as_deref().filter(|s| !s.is_empty()) {
                groups.push_str(&format!("<span class=\"lead\">{}</span>", esc(lead)));
            }
            groups.push_str("</a></li>");
        }
        groups.push_str("</ol></div>");
    }
    format!("<nav class=\"toc\" aria-label=\"{}\">{groups}</nav>", esc(&o.toc_label))
}

/// 768px 未満で見せる上部の帯(戻る・別ページへのリンク・配色)。768px 以上では CSS で隠し、同じ物をサイドバーに出す
pub fn render_top(o: &PageNavOptions) -> String {
    format!(
        "<header class=\"top\"><nav class=\"wrap\" aria-label=\"ページの移動\"><a class=\"crumb\" href=\"{}\">{}</a><div class=\"top-right\">{}{THEME_SEG}</div></nav></header>",
        esc(&o.crumb_href),
        esc(&o.crumb_label),
        if o.links.is_empty() { String::new() } else { format!("<ul class=\"top-links\">{}</ul>", links(&o.links)) }
    )
}

/// 目次の帯。768px 以上はサイドバー(戻る・目次・リンク・配色)、未満は目次行だけ(戻る等は CSS で隠す)
pub fn render_rail(o: &PageNavOptions) -> String {
    format!(
        "<div class=\"rail\"><div class=\"rail-in wrap\"><a class=\"crumb rail-crumb\" href=\"{}\">{}</a>{}{}<div class=\"rail-tools\">{THEME_SEG}</div></div></div>",
        esc(&o.crumb_href),
        esc(&o.crumb_label),
        toc(o),
        if o.links.is_empty() { String::new() } else { format!("<div class=\"rail-links\"><ul>{}</ul></div>", links(&o.links)) }
    )
}

/// 版の目印(core の code-stamp.ts)。serve から開いたとき、NAV_JS が heartbeat の x-atlas-code と比べる
pub fn code_meta(stamp: &str) -> String {
    format!("<meta name=\"atlas-code\" content=\"{stamp}\">")
}

/// 静的ページの <head> の共通部分の前半(charset から code の meta まで)と後半(theme-color から配色の script まで)の間に title と style を挟む。
/// 詳細・用語・改善点・指示文のページで同じ形
pub fn page_head(stamp: &str, title: &str, style: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<meta name=\"atlas-token\" content=\"__ATLAS_TOKEN__\">\n{}\n<meta name=\"theme-color\" content=\"#f3f5f3\" media=\"(prefers-color-scheme: light)\">\n<meta name=\"theme-color\" content=\"#0e1110\" media=\"(prefers-color-scheme: dark)\">\n<title>{title}</title>\n<script>try{{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}}catch(e){{}}</script>\n<style>{style}</style>\n</head>\n",
        code_meta(stamp)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nav_shapes() {
        let o = PageNavOptions {
            crumb_href: "a.html".into(),
            crumb_label: "← 戻る".into(),
            toc_label: "目次".into(),
            groups: vec![NavGroup { title: Some("t".into()), items: vec![NavItem { href: "#x".into(), label: "X".into(), count: Some(3), count_label: Some("つの版".into()), show_count_label: true, lead: None }] }],
            links: vec![NavLink { href: "b.md".into(), label: "md".into(), download: false, new_window: true }],
        };
        let rail = render_rail(&o);
        assert!(rail.contains("<span class=\"cnt\">3 つの版</span>"));
        assert!(rail.contains("target=\"_blank\" rel=\"noopener\">md<span class=\"ext\""));
        assert!(render_top(&o).starts_with("<header class=\"top\">"));
        assert!(NAV_JS.contains("var SCROLLERS=\".table-scroll, blockquote.msg\""));
    }
}
