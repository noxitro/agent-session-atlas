//! 用語の説明ページ(out/glossary.html。packages/report/src/glossary-page.ts の移植)。atlas.html と詳細ページから本文を外し、1 枚だけ別に置く。
//! 本文は分類(h2、id は g-<分類>)で区切り、目次は分類だけを載せる。語の下に「リンクをコピー」のボタンを置く。

use crate::format::date_time_n;
use crate::glossary::{terms_by_group, GLOSSARY, GLOSSARY_GROUPS};
use crate::html::esc;
use crate::page_nav::{page_head, render_rail, render_top, NavGroup, NavItem, PageNavOptions, NAV_JS};

pub const GLOSSARY_FILE: &str = "glossary.html";

const GLOSSARY_CSS: &str = include_str!("../assets/glossary.css");
/// 「リンクをコピー」: そのページの URL(# より前)+ #<id> を写す
const COPY_JS: &str = include_str!("../assets/glossary-copy.js");
const MISSING_LEGEND: &str = include_str!("../assets/missing-legend.html");

pub struct GlossaryPageOptions<'a> {
    pub css: &'a str,
    pub generated_at: &'a str,
    /// 版の目印(code_stamp)
    pub code: &'a str,
}

pub fn render_glossary_html(o: &GlossaryPageOptions<'_>) -> String {
    let nav = PageNavOptions {
        crumb_href: "atlas.html".into(),
        crumb_label: "← レポートに戻る".into(),
        toc_label: "用語の分類".into(),
        groups: vec![NavGroup {
            title: None,
            items: GLOSSARY_GROUPS
                .iter()
                .map(|g| NavItem { href: format!("#g-{}", g.id), label: g.title.into(), count: Some(terms_by_group(g.id).len() as i64), lead: Some(g.lead.into()), ..Default::default() })
                .collect(),
        }],
        links: vec![],
    };
    let mut groups = String::new();
    for g in GLOSSARY_GROUPS.iter() {
        let dl: String = terms_by_group(g.id)
            .iter()
            .map(|t| {
                format!(
                    "<dt id=\"{id}\">{term}<button type=\"button\" class=\"copy-link\" data-copy-link=\"{id}\" aria-label=\"「{term}」へのリンクをコピー\">リンクをコピー</button></dt><dd>{body}</dd>",
                    id = esc(t.id),
                    term = esc(t.term),
                    body = esc(&t.body)
                )
            })
            .collect();
        groups.push_str(&format!(
            "<section class=\"section group\" id=\"g-{id}\" aria-labelledby=\"h-{id}\"><div class=\"section-head\"><h2 id=\"h-{id}\">{title}</h2><p>{lead}</p></div>{legend}<dl class=\"glossary\">{dl}</dl></section>",
            id = g.id,
            title = esc(g.title),
            lead = esc(g.lead),
            legend = if g.id == "records" { MISSING_LEGEND } else { "" }
        ));
    }
    format!(
        "{head}<body>\n{top}\n<div class=\"shell\">\n{rail}\n<div class=\"content\">\n<main class=\"wrap\">\n<div class=\"title\"><h1>用語の説明</h1><p class=\"note\">このレポートを初めて読む人向けです。{n} 語を {g} つに分けて、各欄の数値がどの記録から来ていて、何を含み何を含まないかを書いています。</p></div>\n<div class=\"gbody\">{groups}</div>\n</main>\n<p class=\"sr-only\" role=\"status\" id=\"copy-status\"></p>\n<footer class=\"wrap page-foot\">Copilot Session Atlas が {at} に生成。</footer>\n</div>\n</div>\n<script>{NAV_JS}</script>\n<script>{COPY_JS}</script>\n</body>\n</html>\n",
        head = page_head(o.code, "用語の説明 | Copilot Session Atlas", &format!("{}{GLOSSARY_CSS}", o.css)),
        top = render_top(&nav),
        rail = render_rail(&nav),
        n = GLOSSARY.len(),
        g = GLOSSARY_GROUPS.len(),
        at = esc(&date_time_n(Some(o.generated_at))),
    )
}
