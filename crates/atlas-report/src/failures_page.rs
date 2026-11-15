//! 失敗の台帳の集計のページ(out/failures.html)と、同じ中身の機械可読版(out/failures.json)。
//! 改善点のページ(insights_page.rs)と同じ作法(共通の頭・目次・table.ledger)で置く。集計は failure_stats.rs。

use crate::failure_stats::{thresholds as T, AgentStat, Count, FailureStats, GroupStat, SessionUnitStat, UnitStat};
use crate::format::{date_time_n, int_n, truncate};
use crate::html::esc;
use crate::insights::{clean_heading, VersionMeta};
use crate::page_nav::{page_head, render_rail, render_top, NavGroup, NavItem, NavLink, PageNavOptions, NAV_JS};
use crate::viewer::asset_folder;
use atlas_core::failure_ledger::MAX_ROWS;
use atlas_core::js::{self, JsMap};
use atlas_core::jsnum::to_fixed;
use atlas_core::tool_failure::failure_cause_label;
use serde::Serialize;

pub const FAILURES_FILE: &str = "failures.html";
pub const FAILURES_JSON: &str = "failures.json";

const CSS: &str = include_str!("../assets/failures.css");

/// 表に載せる「そろえたエラー文」(group)と、例のエラー文の長さ(字数。全文は sessions.json と failures.csv にある)
const GROUP_CHARS: usize = 80;
const EXAMPLE_CHARS: usize = 200;

pub struct FailuresPageOptions<'a> {
    pub css: &'a str,
    pub generated_at: &'a str,
    pub code: &'a str,
    pub stats: &'a FailureStats,
    /// 指示文の版の見出しと順(insights::insight_meta)
    pub meta: &'a JsMap<VersionMeta>,
    /// セッション名(詳細ページへのリンクの文言)
    pub session_name: &'a (dyn Fn(&str) -> String + Sync),
    /// 指示文の閲覧ページがあるとき(instructions.html#v-<hash> へ)
    pub library_href: Option<&'a str>,
}

/// failures.json の中身(閾値と集計)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailuresJson<'a> {
    pub version: i64,
    pub generated_at: &'a str,
    pub thresholds: Thresholds,
    #[serde(flatten)]
    pub stats: &'a FailureStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub min_calls: i64,
    pub min_sessions: i64,
    pub min_repeat: i64,
    pub top_rows: usize,
    pub max_rows_per_session: usize,
}

pub fn failures_json<'a>(stats: &'a FailureStats, generated_at: &'a str) -> FailuresJson<'a> {
    FailuresJson { version: 1, generated_at, thresholds: Thresholds { min_calls: T::MIN_CALLS, min_sessions: T::MIN_SESSIONS, min_repeat: T::MIN_REPEAT, top_rows: T::TOP_ROWS, max_rows_per_session: MAX_ROWS }, stats }
}

fn missing(text: &str) -> String {
    format!("<span class=\"missing-value\">{}</span>", esc(text))
}
fn int(v: i64) -> String {
    esc(&int_n(v as f64))
}
// 率は小数 1 桁にそろえる(改善点のページと同じ)。出せないときは「—」
fn pct(v: Option<f64>) -> String {
    match v {
        Some(v) => format!("{}%", to_fixed(v * 100.0, 1)),
        None => missing("—"),
    }
}
fn field(k: &str, v: &str, note: &str) -> String {
    format!("<div class=\"field\"><span class=\"k\">{}</span><span class=\"v\">{v}</span>{}</div>", esc(k), if note.is_empty() { String::new() } else { format!("<span class=\"n\">{note}</span>") })
}
/// そろえたエラー文(エラー文の 1 行目を正規化したもの)。空は、エラー文が無かったもの
fn group_label(g: &str) -> String {
    if g.is_empty() {
        missing("(エラー文なし)")
    } else if js::utf16_len(g) > GROUP_CHARS {
        esc(&format!("{}…", js::utf16_slice(g, 0, GROUP_CHARS - 1)))
    } else {
        esc(g)
    }
}
/// 内訳(名前 ×回数)を「・」でつなぐ。無ければ「—」。名前と回数の間では折り返さない
fn counts(list: &[Count], label: impl Fn(&str) -> String) -> String {
    if list.is_empty() {
        return missing("—");
    }
    list.iter().map(|c| format!("{}\u{a0}×{}", label(&c.key), int(c.n))).collect::<Vec<_>>().join("・")
}
fn causes(list: &[Count]) -> String {
    counts(list, |c| esc(failure_cause_label(c)))
}
/// そろえたエラー文の内訳は 1 つずつ行を分ける(長い文が並ぶため)
fn groups_cell(list: &[Count]) -> String {
    if list.is_empty() {
        return missing("—");
    }
    list.iter().map(|c| format!("<span class=\"gl\">{}\u{a0}×{}</span>", group_label(&c.key), int(c.n))).collect()
}
/// 呼び直しの 2 つの欄(回数と、うち成功)
fn retry_cells(n: i64, ok: i64) -> String {
    format!("<td class=\"num\">{}</td><td class=\"num\">{}</td>", int(n), int(ok))
}
/// 表に載せなかった行の断り
fn more(total: i64, unit: &str) -> String {
    if total > T::TOP_ROWS as i64 {
        format!("<p class=\"note\">多い順に {} {unit}を載せています(全 {} {unit})。全件は <a href=\"{FAILURES_JSON}\">{FAILURES_JSON}</a> で確かめられます。</p>", int(T::TOP_ROWS as i64), int(total))
    } else {
        String::new()
    }
}
fn section(id: &str, title: &str, lead: &str, body: &str) -> String {
    format!("<section class=\"section ins\" id=\"{id}\" aria-labelledby=\"h-{id}\"><div class=\"section-head\"><h2 id=\"h-{id}\">{}</h2><p>{lead}</p></div>{body}</section>", esc(title))
}
fn table(head: &[(&str, bool)], rows: &str) -> String {
    let th: String = head.iter().map(|(label, num)| format!("<th scope=\"col\"{}>{}</th>", if *num { " class=\"num\"" } else { "" }, esc(label))).collect();
    format!("<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr>{th}</tr></thead><tbody>{rows}</tbody></table></div>")
}
/// 行の見出し(1 列目。名前は折り返す)
fn row_head(html: &str) -> String {
    format!("<th scope=\"row\" class=\"name\">{html}</th>")
}

const GROUP_NOTE: &str = "「そろえた形」は、エラー文の 1 行目のパス・URL・数字・引用した部分を印に置き換え、記号を落としたものです(同じ文の失敗をまとめるため)。";

fn unit_rows(units: &[UnitStat]) -> String {
    units
        .iter()
        .take(T::TOP_ROWS)
        .map(|u| {
            format!(
                "<tr>{}<td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"txt\">{}</td><td class=\"txt\">{}</td>{}</tr>",
                row_head(&esc(&u.key)),
                int(u.completed),
                int(u.failures),
                int(u.denied),
                pct(u.rate),
                int(u.sessions),
                causes(&u.causes),
                groups_cell(&u.groups),
                retry_cells(u.retries, u.retries_ok)
            )
        })
        .collect()
}
const UNIT_HEAD: [(&str, bool); 9] = [("呼び出し", true), ("失敗", true), ("拒否", true), ("失敗率", true), ("セッション", true), ("主な要因", false), ("主なエラー文(そろえた形)", false), ("呼び直し", true), ("うち成功", true)];

pub fn render_failures_html(o: &FailuresPageOptions<'_>) -> String {
    let s = o.stats;
    let c = &s.coverage;
    let any = c.with_ledger > 0;
    let mut links = Vec::new();
    if let Some(h) = o.library_href {
        links.push(NavLink::new(h, "指示文と skill"));
    }
    links.push(NavLink::new("insights.html", "改善点"));
    links.push(NavLink::new("glossary.html", "用語の説明"));
    let item = |href: &str, label: &str, count: i64, unit: &str| NavItem { href: href.into(), label: label.into(), count: Some(count), count_label: Some(unit.into()), show_count_label: true, ..Default::default() };
    let plain = |href: &str, label: &str| NavItem { href: href.into(), label: label.into(), ..Default::default() };
    // 台帳のあるセッションが無いときは「対象」だけ(ほかの節は出さない)
    let items = if any {
        vec![
            plain("#f-overview", "対象"),
            plain("#f-next", "失敗の後"),
            item("#f-groups", "繰り返している失敗", s.groups_total, "件"),
            item("#f-tools", "ツール", s.tools_total, "件"),
            item("#f-mcp", "MCP サーバー", s.mcp_total, "件"),
            item("#f-agents", "エージェント", s.agents_total, "件"),
            item("#f-skills", "skill", s.skills_total, "件"),
            item("#f-instructions", "指示文の版", s.instructions_total, "版"),
        ]
    } else {
        vec![plain("#f-overview", "対象")]
    };
    let nav = PageNavOptions { crumb_href: "atlas.html".into(), crumb_label: "← レポートに戻る".into(), toc_label: "失敗の台帳の集計の節".into(), groups: vec![NavGroup { title: None, items }], links };
    let sess = |id: &str| format!("<a href=\"sessions/{}.html\">{}</a>", esc(&asset_folder(id)), esc(&(o.session_name)(id)));

    // 対象
    let all_failed = c.failures + c.denied;
    let overall = if c.completed >= T::MIN_CALLS && c.completed > 0 { Some(all_failed as f64 / c.completed as f64) } else { None };
    let overview = section(
        "f-overview",
        "対象",
        "空でないセッションのうち、失敗の台帳(失敗と拒否を 1 件ずつ残した記録)のあるものを集計しています。台帳の無い記録は以前の版で集計したもので、失敗が 0 件という意味ではありません(集計し直すと付きます)。",
        &format!(
            "<div class=\"fields\" style=\"--cols:3\">{}{}{}{}{}{}</div>",
            field("台帳のあるセッション", &int(c.with_ledger), &format!("空でないセッション {} 件のうち", int(c.sessions))),
            field("失敗", &int(c.failures), &format!("結果の記録がある呼び出し {} 回のうち", int(c.completed))),
            field("拒否", &int(c.denied), "利用者・権限設定による拒否"),
            field("失敗率", &pct(overall), &format!("(失敗 + 拒否) ÷ 結果の記録がある呼び出し。— は {} 回未満", T::MIN_CALLS)),
            field("台帳の無いセッション", &int(c.without_ledger), &if c.without_ledger > 0 { format!("失敗・拒否 {} 件の中身は、この集計に入っていません", int(c.without_ledger_failures)) } else { String::new() }),
            field("台帳に残していない失敗・拒否", &int(c.dropped), &format!("1 セッション {} 行の上限を超えた分(回数には入り、内訳には入りません)", int(MAX_ROWS as i64))),
        ),
    );

    // 失敗の後
    let n = &s.next;
    let next = section(
        "f-next",
        "失敗の後",
        "台帳の行ごとに、同じエージェントが失敗の後に最初に呼んだツールを見ています。並行して動いていた呼び出しと、同じ応答でまとめて要求された呼び出しは数えません。",
        &if n.rows == 0 {
            "<p class=\"note\">台帳の行がありません。</p>".to_string()
        } else {
            format!(
                "<div class=\"fields\" style=\"--cols:4\">{}{}{}{}</div><p class=\"note\">呼び直し: 失敗の後に、同じツールを同じ引数で呼んだもの。下の表の「呼び直し」「うち成功」も同じ数え方です。</p>",
                field("同じ引数で呼び直した", &int(n.retries), &format!("うち成功 {}", int(n.retries_ok))),
                field("別の呼び出しで続けた", &int(n.moved_on), &format!("次の呼び出しが成功 {}", int(n.moved_on_ok))),
                field("利用者の次の依頼", &int(n.user), "次のツールより先に依頼が来た"),
                field("続きなし", &int(n.end), "同じエージェントの呼び出しがその後に無い"),
            )
        },
    );

    // 繰り返している失敗
    let g_rows: String = s
        .groups
        .iter()
        .take(T::TOP_ROWS)
        .map(|g: &GroupStat| {
            let ex = if js::trim(&g.example).is_empty() { missing("—") } else { esc(&truncate(Some(&g.example), EXAMPLE_CHARS)) };
            let ids = g.example_sessions.iter().map(|id| sess(id)).collect::<Vec<_>>().join("、");
            format!(
                "<tr><th scope=\"row\" class=\"name\"><span class=\"gl\">{}</span></th><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"txt\">{}</td><td class=\"txt\">{}</td>{}<td class=\"txt\">{ex}<span class=\"ex\">{ids}</span></td></tr>",
                group_label(&g.group),
                int(g.n),
                int(g.sessions),
                counts(&g.tools, esc),
                if g.denied == g.n { "拒否".to_string() } else if g.denied > 0 { format!("{}・拒否\u{a0}×{}", causes(&g.causes), int(g.denied)) } else { causes(&g.causes) },
                retry_cells(g.retries, g.retries_ok)
            )
        })
        .collect();
    let groups = section(
        "f-groups",
        "繰り返している失敗",
        &format!("同じエラー文で {} 回以上失敗しているものを、多い順に載せています。繰り返している所を探すための表で、原因までは分かりません。", T::MIN_REPEAT),
        &if g_rows.is_empty() {
            format!("<p class=\"note\">{} 回以上繰り返した失敗はありません。</p>", T::MIN_REPEAT)
        } else {
            format!(
                "{}<p class=\"note\">{GROUP_NOTE}例は、最初に出たエラー文と、出たセッション({} 件まで)です。</p>{}",
                table(&[("エラー文(そろえた形)", false), ("回数", true), ("セッション", true), ("ツール", false), ("要因", false), ("呼び直し", true), ("うち成功", true), ("例", false)], &g_rows),
                T::EXAMPLE_SESSIONS,
                more(s.groups_total, "件")
            )
        },
    );

    // ツール・MCP
    let unit_note = format!("<p class=\"note\">失敗率: (失敗 + 拒否) ÷ 呼び出し(結果の記録があるもの)。— は呼び出しが {} 回未満。セッション: 失敗か拒否のあったセッションの数。主な要因は失敗だけ(拒否は入りません)。{GROUP_NOTE}</p>", T::MIN_CALLS);
    let unit_section = |id: &str, title: &str, first: &str, lead: &str, units: &[UnitStat], total: i64, empty: &str| {
        let head: Vec<(&str, bool)> = std::iter::once((first, false)).chain(UNIT_HEAD).collect();
        section(id, title, lead, &if units.is_empty() { format!("<p class=\"note\">{empty}</p>") } else { format!("{}{unit_note}{}", table(&head, &unit_rows(units)), more(total, "件")) })
    };
    let tools = unit_section("f-tools", "ツール", "ツール", "失敗か拒否のあったツールです。回数は記録の結果(成功・失敗・拒否)から、要因・エラー文・呼び直しは台帳の行から数えています。", &s.tools, s.tools_total, "失敗か拒否のあったツールはありません。");
    let mcp = unit_section("f-mcp", "MCP サーバー", "サーバー", "失敗か拒否のあった MCP サーバーです。そのサーバーのツールの結果を足しています。", &s.mcp, s.mcp_total, "失敗か拒否のあった MCP サーバーはありません。");

    // エージェント
    let a_rows: String = s
        .agents
        .iter()
        .take(T::TOP_ROWS)
        .map(|a: &AgentStat| {
            let opt = |v: Option<i64>| v.map_or_else(|| missing("—"), int);
            format!(
                "<tr>{}<td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"txt\">{}</td><td class=\"txt\">{}</td>{}</tr>",
                row_head(&if a.main { "本体".to_string() } else { esc(&a.name) }),
                opt(a.runs),
                opt(a.runs_with_failures),
                int(a.failures),
                int(a.denied),
                int(a.sessions),
                causes(&a.causes),
                groups_cell(&a.groups),
                retry_cells(a.retries, a.retries_ok)
            )
        })
        .collect();
    let agents = section(
        "f-agents",
        "エージェント",
        "失敗か拒否のあったエージェント(本体と、サブエージェントの名前ごと)です。結果の記録がある呼び出しの数はエージェントごとには分からないので、率は出していません。",
        &if a_rows.is_empty() {
            "<p class=\"note\">失敗か拒否のあったエージェントはありません。</p>".to_string()
        } else {
            format!(
                "{}<p class=\"note\">台帳の行から数えているので、行数の上限で残していない分は入りません。起動: そのサブエージェントを起動した回数(本体は —)。{GROUP_NOTE}</p>{}",
                table(&[("エージェント", false), ("起動", true), ("失敗・拒否のあった起動", true), ("失敗", true), ("拒否", true), ("セッション", true), ("主な要因", false), ("主なエラー文(そろえた形)", false), ("呼び直し", true), ("うち成功", true)], &a_rows),
                more(s.agents_total, "件")
            )
        },
    );

    // skill・指示文の版(セッションの単位)
    let session_rows = |units: &[SessionUnitStat], label: &dyn Fn(&str) -> String, after: bool| -> String {
        units
            .iter()
            .take(T::TOP_ROWS)
            .map(|u| {
                format!(
                    "<tr>{}<td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>{}<td class=\"txt\">{}</td></tr>",
                    row_head(&label(&u.key)),
                    int(u.sessions),
                    int(u.completed),
                    int(u.failed),
                    pct(u.rate),
                    int(u.other_sessions),
                    pct(u.other_rate),
                    if after { format!("<td class=\"num\">{}</td>", u.rows_after.map_or_else(|| missing("—"), int)) } else { String::new() },
                    groups_cell(&u.groups)
                )
            })
            .collect()
    };
    let per_session_note = format!(
        "失敗率: セッション内の失敗・拒否 ÷ 呼び出し(結果の記録があるもの)。{} セッション以上・呼び出し {} 回以上のときだけ出し、片方が出せないときは両方 — にします。1 つのセッションの失敗は、そこで使ったものすべてに数えます。",
        T::MIN_SESSIONS,
        T::MIN_CALLS
    );
    let sk_rows = session_rows(&s.skills, &|k| esc(k), true);
    let skills = section(
        "f-skills",
        "skill(呼んだセッションの単位)",
        "その skill を呼んだセッションの失敗と拒否を数えています。失敗を skill に結び付ける記録は無いので、分かるのは相関までです。",
        &if sk_rows.is_empty() {
            "<p class=\"note\">skill を呼んだセッションに、失敗か拒否はありません。</p>".to_string()
        } else {
            format!(
                "{}<p class=\"note\">{per_session_note}呼んだ後の失敗・拒否: そのセッションで最初に呼んだ時刻より後の、台帳の行の数。主なエラー文もその行から数えています。{GROUP_NOTE}</p>{}",
                table(&[("skill", false), ("呼んだセッション", true), ("呼び出し", true), ("セッション内の失敗・拒否", true), ("失敗率", true), ("それ以外のセッション", true), ("失敗率(それ以外)", true), ("呼んだ後の失敗・拒否", true), ("主なエラー文(そろえた形)", false)], &sk_rows),
                more(s.skills_total, "件")
            )
        },
    );
    let vlabel = |hash: &str| -> String {
        let name = match o.meta.get(hash) {
            Some(m) => {
                let h = clean_heading(&m.heading, Some(60));
                format!("{} <span class=\"weak\">版 {}</span>", esc(if h.is_empty() { "(見出しなし)" } else { &h }), m.order + 1)
            }
            None => esc(hash),
        };
        match o.library_href {
            Some(h) => format!("<a href=\"{}#v-{}\">{name}</a>", esc(h), esc(hash)),
            None => name,
        }
    };
    let in_rows = session_rows(&s.instructions, &vlabel, false);
    let instructions = section(
        "f-instructions",
        "指示文の版(読み込んだセッションの単位)",
        "その版(内容のハッシュ)を読み込んだセッションの失敗と拒否を数えています。失敗を指示文に結び付ける記録は無いので、分かるのは相関までです。",
        &if in_rows.is_empty() {
            "<p class=\"note\">指示文を読み込んだセッションに、失敗か拒否はありません。</p>".to_string()
        } else {
            format!(
                "{}<p class=\"note\">{per_session_note}主なエラー文は、そのセッションの台帳の行から数えています。{GROUP_NOTE}</p>{}",
                table(&[("版", false), ("読み込んだセッション", true), ("呼び出し", true), ("セッション内の失敗・拒否", true), ("失敗率", true), ("それ以外のセッション", true), ("失敗率(それ以外)", true), ("主なエラー文(そろえた形)", false)], &in_rows),
                more(s.instructions_total, "版")
            )
        },
    );

    let body = if any { format!("{overview}\n{next}\n{groups}\n{tools}\n{mcp}\n{agents}\n{skills}\n{instructions}") } else { format!("{overview}\n<p class=\"note\">失敗の台帳のあるセッションがありません。atlas.bat で集計し直すと、失敗と拒否が 1 件ずつ記録されます。</p>") };
    format!(
        "{head}<body>\n{top}\n<div class=\"shell\">\n{rail}\n<div class=\"content\">\n<main class=\"wrap\">\n<div class=\"title\"><h1>失敗の台帳の集計</h1><p class=\"lead\">ツールの失敗と拒否を 1 件ずつ残した記録(失敗の台帳)を、ツール・MCP サーバー・エージェント・skill・指示文の版ごとに数えています。LLM は使わず、決まった規則で集計しています。レポートに入れた記録のうち、失敗の台帳のあるセッション {n} 件で計算しています(レポートの画面の絞り込みは掛かりません)。生成 {at}。</p></div>\n{body}\n</main>\n<footer class=\"wrap page-foot\"><p>1 件ごとの中身は、セッションの詳細ページの「失敗と拒否(1 件ごと)」と、<code>out/tables/failures.csv</code>(SQLite の <code>failures</code> 表)にあります。このページと同じ集計は <a href=\"{FAILURES_JSON}\">{FAILURES_JSON}</a> に書いています。</p></footer>\n</div>\n</div>\n<script>{NAV_JS}</script>\n</body>\n</html>\n",
        head = page_head(o.code, "失敗の台帳の集計 | Copilot Session Atlas", &format!("{}{CSS}", o.css)),
        top = render_top(&nav),
        rail = render_rail(&nav),
        n = int(c.with_ledger),
        at = esc(&date_time_n(Some(o.generated_at))),
    )
}
