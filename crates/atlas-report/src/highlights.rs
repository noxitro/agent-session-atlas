//! Phase 7: 要点欄(packages/report/src/lib/highlights.ts の移植)。絞り込んだ集計から機械的に短い一覧を作る(LLM は使わない)。
//! 各項目は根拠のリンクを持つ: セッション詳細ページ(sessions/<id>.html)か、絞り込み状態の URL(#...)。

use crate::aggregate::{failure_rate, unused_skills, ToolRow, UsageRanking};
use crate::exec::num_cmp;
use crate::filter::{filter_href, FilterState};
use crate::format::{date_n, dec_n, int_n, percent, truncate};
use crate::types::SessionSummary;
use atlas_core::collate::locale_compare;
use atlas_core::js;
use atlas_core::tool_failure::{failure_cause_label, sorted_causes, FAILURE_CAUSES};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightItem {
    /// 項目の本文(何がどれだけか)
    pub text: String,
    /// 根拠へのリンク(詳細ページの相対パスか #... の絞り込み)
    pub href: String,
    /// リンクの文言
    pub link_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HighlightGroup {
    /// cost / tool-failure / compaction / unused-skill
    pub kind: &'static str,
    pub title: String,
    /// 並べ方・条件の説明
    pub basis: String,
    pub items: Vec<HighlightItem>,
}

/// 各グループの最大件数
pub const HIGHLIGHT_TOP: usize = 3;
/// 失敗率の高いツールに挙げる下限(結果の記録がある回数)
pub const HIGHLIGHT_RATE_MIN: i64 = 5;

/// インストール済みの skill(画面に出す形)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct InstalledView {
    pub skills: Vec<String>,
    pub disabled: Vec<String>,
}

pub struct HighlightOptions<'a> {
    pub filter: &'a FilterState,
    pub anonymized: bool,
    pub installed: Option<&'a InstalledView>,
}

/// 一覧での呼び名(伏せ字モードでは本文を使わない)
pub fn session_label(s: &SessionSummary, anonymized: bool) -> String {
    let name = s.name.as_deref().filter(|x| !x.is_empty());
    let first = s.first_user_message.as_deref().filter(|x| !x.is_empty());
    if anonymized || (name.is_none() && first.is_none()) {
        return format!("{}・{}({})", s.project_label, date_n(s.created_at.as_deref()), js::head(&s.id, 8));
    }
    truncate(name.or(first), 48)
}

/// `FAILURE_CAUSE_LABELS[c]`(表に無い要因は undefined と書かれる)
fn cause_label(c: &str) -> &'static str {
    if FAILURE_CAUSES.contains(&c) { failure_cause_label(c) } else { "undefined" }
}

fn nano(s: &SessionSummary) -> f64 {
    s.tokens.nano_aiu.unwrap_or(0.0)
}

fn rate(t: &ToolRow) -> f64 {
    failure_rate(t.completed, t.failure, t.denied).unwrap_or(0.0)
}

pub fn highlights(sessions: &[&SessionSummary], usage: &UsageRanking, opts: &HighlightOptions<'_>) -> Vec<HighlightGroup> {
    let mut out = Vec::new();
    let label = |s: &SessionSummary| session_label(s, opts.anonymized);
    let detail = |s: &SessionSummary, text: String| HighlightItem { text, href: s.href.clone(), link_label: "セッションの詳細".into() };

    // 1. コストの大きいセッション: AIU、無ければ出力トークン
    let aiu_total = sessions.iter().fold(0.0, |a, s| a + nano(s));
    if aiu_total > 0.0 {
        let mut top: Vec<&&SessionSummary> = sessions.iter().filter(|s| nano(s) > 0.0).collect();
        top.sort_by(|a, b| num_cmp(nano(b), nano(a)).then_with(|| locale_compare(&a.id, &b.id)));
        out.push(HighlightGroup {
            kind: "cost",
            title: "AI 使用量(AIU)の大きいセッション".into(),
            basis: format!("AIU の記録があるセッションを多い順に上位 {HIGHLIGHT_TOP} 件"),
            items: top.iter().take(HIGHLIGHT_TOP).map(|s| detail(s, format!("{}: {} AIU(この条件の合計の {})", label(s), dec_n(nano(s) / 1e9), percent(nano(s), aiu_total)))).collect(),
        });
    } else {
        let out_total = sessions.iter().fold(0.0, |a, s| a + s.tokens.output);
        let mut top: Vec<&&SessionSummary> = sessions.iter().filter(|s| s.tokens.output > 0.0).collect();
        top.sort_by(|a, b| num_cmp(b.tokens.output, a.tokens.output).then_with(|| locale_compare(&a.id, &b.id)));
        if !top.is_empty() {
            out.push(HighlightGroup {
                kind: "cost",
                title: "出力トークンの多いセッション".into(),
                basis: format!("この条件に AIU の記録が無いため、出力トークンの多い順に上位 {HIGHLIGHT_TOP} 件"),
                items: top.iter().take(HIGHLIGHT_TOP).map(|s| detail(s, format!("{}: 出力 {} トークン(この条件の合計の {})", label(s), int_n(s.tokens.output), percent(s.tokens.output, out_total)))).collect(),
            });
        }
    }

    // 2. 失敗率の高いツール(結果の記録が下限以上)。いちばん多い要因を添える
    let main_cause = |t: &ToolRow| match sorted_causes(Some(&t.causes)).first() {
        Some((c, n)) => format!("。主な要因: {} {} 回", cause_label(c), int_n(*n as f64)),
        None => String::new(),
    };
    let mut rates: Vec<&ToolRow> = usage.tools.iter().filter(|t| t.completed >= HIGHLIGHT_RATE_MIN && rate(t) > 0.0).collect();
    rates.sort_by(|a, b| num_cmp(rate(b), rate(a)).then(b.calls.cmp(&a.calls)).then_with(|| locale_compare(&a.key, &b.key)));
    if !rates.is_empty() {
        out.push(HighlightGroup {
            kind: "tool-failure",
            title: "失敗率の高いツール".into(),
            basis: format!("結果の記録が {HIGHLIGHT_RATE_MIN} 回以上で失敗・拒否のあったツールを失敗率の高い順に"),
            items: rates
                .iter()
                .take(HIGHLIGHT_TOP)
                .map(|t| {
                    let name = if t.mcp_server.as_deref().is_some_and(|x| !x.is_empty()) { format!("MCP {}", t.label) } else { t.label.clone() };
                    HighlightItem {
                        text: format!(
                            "{name}: 失敗率 {}(失敗 {}・拒否 {} / {} 回、{} セッション){}",
                            percent((t.failure + t.denied) as f64, t.completed as f64),
                            int_n(t.failure as f64),
                            int_n(t.denied as f64),
                            int_n(t.completed as f64),
                            int_n(t.sessions as f64),
                            main_cause(t)
                        ),
                        href: filter_href(&FilterState { tool: t.key.clone(), ..opts.filter.clone() }, None),
                        link_label: "このツールを使ったセッションに絞り込む".into(),
                    }
                })
                .collect(),
        });
    }

    // 3. compaction の多いセッション
    let mut comp: Vec<&&SessionSummary> = sessions.iter().filter(|s| s.friction.compactions > 0).collect();
    comp.sort_by(|a, b| b.friction.compactions.cmp(&a.friction.compactions).then(num_cmp(b.tokens.output, a.tokens.output)).then_with(|| locale_compare(&a.id, &b.id)));
    if !comp.is_empty() {
        out.push(HighlightGroup {
            kind: "compaction",
            title: "compaction(文脈圧縮)の多いセッション".into(),
            basis: format!("compaction の回数が多い順に上位 {HIGHLIGHT_TOP} 件"),
            items: comp
                .iter()
                .take(HIGHLIGHT_TOP)
                .map(|s| {
                    let removed = s.friction_detail.compaction[4];
                    let extra = if removed > 0.0 { format!("(減ったトークン {})", int_n(removed)) } else { String::new() };
                    detail(s, format!("{}: compaction {} 回{extra}", label(s), int_n(s.friction.compactions as f64)))
                })
                .collect(),
        });
    }

    // 4. インストール済みで未使用の skill(絞り込みを保ったまま未使用一覧へ)
    if let Some(inst) = opts.installed.filter(|i| !i.skills.is_empty()) {
        let unused = unused_skills(&inst.skills, usage.skills.iter().map(|s| s.name.as_str()));
        // 設定で無効にしてあるものは、入れたのに使っていないのではないので印を付ける
        let off: HashSet<String> = inst.disabled.iter().map(|n| js::to_lower(n)).collect();
        let mark = |n: &String| if off.contains(&js::to_lower(n)) { format!("{n}(無効)") } else { n.clone() };
        let n_off = unused.iter().filter(|n| off.contains(&js::to_lower(n))).count();
        if !unused.is_empty() {
            let more = if unused.len() > 6 { format!(" ほか {} 件", int_n((unused.len() - 6) as f64)) } else { String::new() };
            out.push(HighlightGroup {
                kind: "unused-skill",
                title: "インストール済みで未使用の skill".into(),
                basis: format!("この条件のセッションで一度も呼ばれなかったもの{}", if n_off > 0 { format!("。うち {} 件は今の設定で無効", int_n(n_off as f64)) } else { String::new() }),
                items: vec![HighlightItem {
                    text: format!("{} / {} 件: {}{more}", int_n(unused.len() as f64), int_n(inst.skills.len() as f64), unused.iter().take(6).map(mark).collect::<Vec<_>>().join("、")),
                    href: filter_href(opts.filter, Some("unused-skills")),
                    link_label: "未使用の skill の一覧".into(),
                }],
            });
        }
    }
    out
}

/// 画面に出すインストール済みの skill(~/.copilot/skills/ とプラグインの skill の名前を合わせたもの)と、無効にしたもの。
/// build.ts の installedView
pub fn installed_view(inv: &atlas_core::types::InstalledInventory) -> InstalledView {
    let mut seen = HashSet::new();
    let mut skills: Vec<String> = inv.skills.iter().chain(inv.plugins.iter().flat_map(|p| p.skills.iter())).filter(|s| seen.insert(s.as_str())).cloned().collect();
    skills.sort_by(|a, b| js::cmp_utf16(a, b));
    let mut disabled: Vec<String> = inv.disabled_skills.clone().unwrap_or_default();
    disabled.sort_by(|a, b| js::cmp_utf16(a, b));
    InstalledView { skills, disabled }
}
