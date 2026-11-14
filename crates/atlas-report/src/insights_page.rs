//! Phase 12: 改善点の別ページ(out/insights.html。packages/report/src/insights-page.ts の移植)。atlas.html の「改善点」の節に載せきれない全件
//! (指示文の版、skill、止まっているセッション、スキル化の候補の全文)を、用語ページと同じ作法で置く。伏せ字版では依頼文と見出しを出さない。

use crate::format::{date_n, date_time_n, dec_n, duration, int_n};
use crate::html::esc;
use crate::insights::{clean_heading, thresholds as T, Candidate, InstructionFindings, SkillStats, StuckProject, StuckSession, VersionMeta, VersionStat};
use crate::page_nav::{page_head, render_rail, render_top, NavGroup, NavItem, NavLink, PageNavOptions, NAV_JS};
use crate::viewer::asset_folder;
use atlas_core::js::{self, JsMap};
use atlas_core::jsnum::to_fixed;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const INSIGHTS_FILE: &str = "insights.html";
pub const INSIGHTS_JSON: &str = "insights.json";

const CSS: &str = include_str!("../assets/insights.css");

pub struct InsightsPageOptions<'a> {
    pub css: &'a str,
    pub generated_at: &'a str,
    pub code: &'a str,
    pub anonymized: bool,
    pub sessions: usize,
    /// sessions のうち空のセッションの数
    pub empty_sessions: usize,
    pub versions: &'a [VersionStat],
    pub meta: &'a JsMap<VersionMeta>,
    pub findings: &'a InstructionFindings,
    pub skills: &'a SkillStats,
    /// 設定で無効にしてある skill(今の設定)
    pub disabled_skills: &'a [String],
    pub stuck: &'a [StuckSession],
    /// プロジェクト別の止まっているセッション数(MIN_SESSIONS 以上のプロジェクト)
    pub stuck_projects: &'a [StuckProject],
    pub candidates: &'a [Candidate],
    /// セッション名(詳細ページへのリンクの文言)
    pub session_name: &'a (dyn Fn(&str) -> String + Sync),
    /// 指示文の閲覧ページがあるとき(instructions.html#v-<hash> へ)
    pub library_href: Option<&'a str>,
}

// 率は小数 1 桁にそろえる(2.41% と 2.4% が並ぶと別の値に見える)
fn percent(v: f64) -> String {
    format!("{}%", to_fixed(v * 100.0, 1))
}
fn clip(t: &str, n: usize) -> String {
    if js::utf16_len(t) > n { format!("{}…", js::utf16_slice(t, 0, n - 1)) } else { t.to_string() }
}
fn pct(v: Option<f64>, enough: bool) -> String {
    match v {
        Some(v) if enough => percent(v),
        _ => "—".into(),
    }
}
fn ms(v: Option<f64>) -> String {
    match v {
        None => "<span class=\"missing-value\">記録なし</span>".into(),
        Some(v) => esc(&duration(Some(v), "不明")),
    }
}
fn signed(v: f64) -> String {
    format!("{}{}", if v >= 0.0 { "+" } else { "" }, esc(&dec_n(v)))
}

static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

pub fn render_insights_html(o: &InsightsPageOptions<'_>) -> String {
    let anon = o.anonymized;
    let num = js::num_to_string;
    let mut links = Vec::new();
    if let Some(h) = o.library_href {
        links.push(NavLink::new(h, "指示文と skill"));
    }
    links.push(NavLink::new("glossary.html", "用語の説明"));
    let item = |href: &str, label: &str, count: usize, unit: &str| NavItem { href: href.into(), label: label.into(), count: Some(count as i64), count_label: Some(unit.into()), ..Default::default() };
    let nav = PageNavOptions {
        crumb_href: "atlas.html".into(),
        crumb_label: "← レポートに戻る".into(),
        toc_label: "改善点の節".into(),
        groups: vec![NavGroup {
            title: None,
            items: vec![
                item("#i-instructions", "指示文の傾向", o.versions.len(), "版"),
                item("#i-skills", "skill の傾向", o.skills.stats.len(), "件"),
                item("#i-stuck", "止まっている箇所", o.stuck.len(), "セッション"),
                item("#i-candidates", "スキル化の候補", o.candidates.len(), "件"),
            ],
        }],
        links,
    };
    let sess = |id: &str| format!("<a href=\"sessions/{}.html\">{}</a>", esc(&asset_folder(id)), esc(&(o.session_name)(id)));
    let vlabel = |v: &VersionStat| -> String {
        let m = o.meta.get(&v.hash);
        let name = match m {
            Some(m) if !anon => {
                let h = clean_heading(&m.heading, Some(60));
                format!("{} <span class=\"weak\">版 {}</span>", esc(if h.is_empty() { "(見出しなし)" } else { &h }), m.order + 1)
            }
            _ => esc(&v.hash),
        };
        match o.library_href {
            Some(h) if !anon => format!("<a href=\"{}#v-{}\">{name}</a>", esc(h), esc(&v.hash)),
            _ => name,
        }
    };

    // 指示文
    let v_rows: String = o
        .versions
        .iter()
        .map(|v| {
            format!(
                "<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                vlabel(v),
                esc(&int_n(v.chars as f64)),
                esc(&int_n(v.sessions as f64)),
                esc(&dec_n(v.injections_per_session)),
                pct(v.failure_rate, v.enough),
                pct(Some(v.rework_rate), v.enough),
                esc(&dec_n(v.compactions_per_session)),
                esc(&int_n(js::round(v.output_per_session)))
            )
        })
        .collect();
    let mut findings: Vec<String> = Vec::new();
    for v in &o.findings.long_rare {
        let last = o.meta.get(&v.hash).and_then(|m| m.last_at.clone().flatten()).filter(|s| !s.is_empty());
        findings.push(format!(
            "<li>長いのに注入が少ない: {}({} 字、{} セッション{})</li>",
            vlabel(v),
            esc(&int_n(v.chars as f64)),
            esc(&int_n(v.sessions as f64)),
            match &last {
                Some(l) => format!("、最後に読み込んだのは {}", esc(&date_n(Some(l)))),
                None => String::new(),
            }
        ));
    }
    for w in &o.findings.worsened {
        let h = clean_heading(&w.heading, Some(60));
        findings.push(format!(
            "<li>版を変えた前後で悪化: {}({} → {}。失敗率 {}、手戻り率 {} pt)</li>",
            if anon { w.after.hash.clone() } else { esc(if h.is_empty() { "(見出しなし)" } else { &h }) },
            vlabel(&w.before),
            vlabel(&w.after),
            match w.failure_delta {
                None => "—".into(),
                Some(d) => format!("{} pt", signed(d)),
            },
            signed(w.rework_delta)
        ));
    }
    let instructions = format!(
        "<section class=\"section ins\" id=\"i-instructions\" aria-labelledby=\"h-i-instructions\"><div class=\"section-head\"><h2 id=\"h-i-instructions\">指示文の傾向</h2><p>版(内容のハッシュ)ごとの、注入されたセッションでの傾向。指示文の効果は直接測れない(同じ版でも依頼が違う)ので、相関として読む。率は {min} セッション以上のものだけ結論に使う。「長いのに注入が少ない」は字数が全版の上位 25%({long} 字以上)で注入 {rare} セッション未満の、系列ごとの今の版(最後に読み込まれた版)。「悪化」は失敗率か手戻り率が {worse} ポイント以上上がったもの。</p></div><p class=\"note\">版を変えた前後の比較: {compared} 組を判定、悪化 {nworse}{insuff}。</p>{findings}<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">版</th><th scope=\"col\" class=\"num\">文字数</th><th scope=\"col\" class=\"num\">セッション</th><th scope=\"col\" class=\"num\">注入回数 / セッション</th><th scope=\"col\" class=\"num\">失敗率</th><th scope=\"col\" class=\"num\">手戻り率</th><th scope=\"col\" class=\"num\">compaction / セッション</th><th scope=\"col\" class=\"num\">出力トークン / セッション</th></tr></thead><tbody>{rows}</tbody></table></div><p class=\"note\">注入回数 / セッション: 1 セッションあたりにその版が注入された回数。失敗率: ツールの失敗・拒否 / 呼び出し。手戻り率: 同じファイルを 2 回以上編集したセッションの割合。— は {min} セッション未満。</p></section>",
        min = T::MIN_SESSIONS,
        long = esc(&int_n(o.findings.long_chars as f64)),
        rare = T::RARE_SESSIONS,
        worse = num(T::WORSE_POINTS),
        compared = esc(&int_n(o.findings.compared as f64)),
        nworse = esc(&int_n(o.findings.worsened.len() as f64)),
        insuff = if o.findings.compared_insufficient != 0 {
            format!("。{} 組はどちらかが {} セッション未満で判定できません", esc(&int_n(o.findings.compared_insufficient as f64)), T::MIN_SESSIONS)
        } else {
            String::new()
        },
        findings = if findings.is_empty() { String::new() } else { format!("<ul class=\"note\">{}</ul>", findings.join("")) },
        rows = if v_rows.is_empty() { "<tr><td colspan=\"8\">指示文の注入はありません。</td></tr>".to_string() } else { v_rows },
    );

    // skill
    // 呼んだときの失敗率が出せる skill が無ければ、失敗率の 2 列は比べられないので出さない
    let rates = o.skills.stats.iter().any(|s| s.failure_with.is_some());
    let s_rows: String = o
        .skills
        .stats
        .iter()
        .map(|s| {
            format!(
                "<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{} / {}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>{}<td class=\"num\">{}</td></tr>",
                esc(&s.name),
                esc(&int_n(s.calls as f64)),
                esc(&int_n(s.by_user as f64)),
                esc(&int_n(s.by_agent as f64)),
                match s.chars {
                    None => "<span class=\"missing-value\">記録なし</span>".into(),
                    Some(c) => esc(&int_n(c)),
                },
                esc(&int_n(s.sessions as f64)),
                if rates { format!("<td class=\"num\">{}</td><td class=\"num\">{}</td>", pct(s.failure_with, true), pct(s.failure_without, true)) } else { String::new() },
                esc(&int_n(js::round(s.output_per_session)))
            )
        })
        .collect();
    let off: HashSet<String> = o.disabled_skills.iter().map(|n| js::to_lower(n)).collect();
    let unused = if o.skills.unused.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = o.skills.unused.iter().map(|n| if off.contains(&js::to_lower(n)) { format!("{n}(無効)") } else { n.clone() }).collect();
        format!(
            "<p class=\"note\">インストール済みで未使用: {}{}</p>",
            esc(&names.join("、")),
            if o.skills.unused.iter().any(|n| off.contains(&js::to_lower(n))) { "(無効は今の設定で無効にしてあるもの)" } else { "" }
        )
    };
    let skills = format!(
        "<section class=\"section ins\" id=\"i-skills\" aria-labelledby=\"h-i-skills\"><div class=\"section-head\"><h2 id=\"h-i-skills\">skill の傾向</h2><p>呼び出し回数(利用者 / エージェント)、本文の大きさ、呼んだセッションと呼ばなかったセッションの失敗率(それぞれ {min} セッション未満なら —)。</p></div>{norate}<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">skill</th><th scope=\"col\" class=\"num\">呼び出し</th><th scope=\"col\" class=\"num\">利用者 / エージェント</th><th scope=\"col\" class=\"num\">本文の字数</th><th scope=\"col\" class=\"num\">セッション</th>{rate_head}<th scope=\"col\" class=\"num\">出力トークン / セッション</th></tr></thead><tbody>{rows}</tbody></table></div>{unused}</section>",
        min = T::MIN_SESSIONS,
        norate = if rates || o.skills.stats.is_empty() {
            String::new()
        } else {
            format!("<p class=\"note\">{} セッション以上で呼ばれた skill が無いので、呼んだときと呼ばないときの失敗率は比べられません(列を省きました)。</p>", T::MIN_SESSIONS)
        },
        rate_head = if rates { "<th scope=\"col\" class=\"num\">失敗率(呼んだ)</th><th scope=\"col\" class=\"num\">失敗率(呼ばない)</th>" } else { "" },
        rows = if s_rows.is_empty() { format!("<tr><td colspan=\"{}\">skill の呼び出しはありません。</td></tr>", if rates { 8 } else { 6 }) } else { s_rows },
    );

    // 止まっている箇所
    let st_rows: String = o
        .stuck
        .iter()
        .map(|x| {
            format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                sess(&x.id),
                if anon { esc(&x.project) } else { esc(&x.project_label) },
                esc(&x.reasons.join("、")),
                ms(x.ttft_median),
                ms(x.duration_median),
                esc(&int_n(x.consecutive_failures as f64)),
                esc(&int_n(x.extra_edits as f64)),
                esc(&int_n(x.permissions as f64)),
                esc(&int_n(x.compactions as f64))
            )
        })
        .collect();
    let projects = if o.stuck_projects.is_empty() {
        String::new()
    } else {
        let rows: String = o
            .stuck_projects
            .iter()
            .map(|p| {
                let reasons: Vec<String> = p.reasons.js_entries().iter().map(|(k, n)| format!("{k} {}", int_n(**n as f64))).collect();
                format!(
                    "<tr><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td>{}</td></tr>",
                    if anon { esc(&p.project) } else { esc(&p.project_label) },
                    esc(&int_n(p.stuck as f64)),
                    esc(&int_n(p.total as f64)),
                    esc(&reasons.join("、"))
                )
            })
            .collect();
        format!(
            "<h3 class=\"gap\">プロジェクト別({} セッション以上のプロジェクト)</h3><div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">プロジェクト</th><th scope=\"col\" class=\"num\">該当</th><th scope=\"col\" class=\"num\">全セッション</th><th scope=\"col\">理由の内訳</th></tr></thead><tbody>{rows}</tbody></table></div>",
            T::MIN_SESSIONS
        )
    };
    let stuck = format!(
        "<section class=\"section ins\" id=\"i-stuck\" aria-labelledby=\"h-i-stuck\"><div class=\"section-head\"><h2 id=\"h-i-stuck\">止まっている箇所</h2><p>閾値(最初のトークンまでの待ち(TTFT)の中央値 {ttft} 以上、ツールの失敗の連続 {cf} 回以上、余分な編集 {ee} 回以上、権限確認 {perm} 回以上、compaction {comp} 回以上)を超えたセッション。理由の数の多い順、同数なら余分な編集・失敗の連続の多い順。待ち時間はリクエスト単位の記録があるセッションだけ判定できます(無ければ「記録なし」)。</p></div><p class=\"note\">待ち(TTFT): 最初のトークンまでの時間、全体: リクエストの開始から応答の終わりまでの時間(どちらもセッション内の中央値)。失敗の連続: ツールの失敗・拒否が続いた最長の回数。余分な編集: 同じファイルの 2 回目以降の編集を全ファイルで合計した数。</p><div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">セッション</th><th scope=\"col\">プロジェクト</th><th scope=\"col\">理由</th><th scope=\"col\" class=\"num\">待ち(TTFT)中央値</th><th scope=\"col\" class=\"num\">全体 中央値</th><th scope=\"col\" class=\"num\">失敗の連続</th><th scope=\"col\" class=\"num\">余分な編集</th><th scope=\"col\" class=\"num\">権限確認</th><th scope=\"col\" class=\"num\">compaction</th></tr></thead><tbody>{rows}</tbody></table></div>{projects}</section>",
        ttft = esc(&duration(Some(T::STUCK_TTFT_MS), "不明")),
        cf = T::STUCK_CONSECUTIVE_FAILURES,
        ee = T::STUCK_EXTRA_EDITS,
        perm = T::STUCK_PERMISSIONS,
        comp = T::STUCK_COMPACTIONS,
        rows = if st_rows.is_empty() { "<tr><td colspan=\"9\">閾値を超えたセッションはありません。</td></tr>".to_string() } else { st_rows },
    );

    // 候補
    let cands: String = o
        .candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let head = if c.kind == "tools" {
                format!("<span class=\"seq\">{}</span>", esc(&c.key))
            } else if anon {
                "依頼文の繰り返し(本文は伏せ字版では出しません)".to_string()
            } else {
                esc(&clip(&WS.replace_all(c.representative.as_deref().unwrap_or(&c.key), " "), 80))
            };
            let body = if anon {
                String::new()
            } else {
                let mut b = String::new();
                if let Some(r) = c.representative.as_deref().filter(|r| !r.is_empty()) {
                    b.push_str(&format!(
                        "<p class=\"cap\">{}</p><pre class=\"body\" tabindex=\"0\">{}</pre>",
                        if c.kind == "tools" { "この並びが最初に出たターンの依頼文(例)" } else { "代表の依頼文" },
                        esc(r)
                    ));
                }
                if !c.examples.is_empty() {
                    b.push_str(&format!("<p class=\"cap\">他の例({})</p><pre class=\"body\" tabindex=\"0\">{}</pre>", c.examples.len(), esc(&c.examples.join("\n— — —\n"))));
                }
                b
            };
            let uses: String = c.sessions.iter().take(30).map(|id| format!("<li>{}</li>", sess(id))).collect();
            format!(
                "<details class=\"cand\" id=\"c-{n}\"{open}><summary><b>{n}.</b> {head} <span>{kind}</span> <span>{count} 回</span> <span>{ns} セッション</span> <span>実働 中央値 {med}</span> <span>スコア {score}</span></summary>{body}<div class=\"uses\">関係セッション: <ul>{uses}</ul>{more}</div></details>",
                n = i + 1,
                open = if i < 3 { " open" } else { "" },
                kind = if c.kind == "tools" { "ツールの並び" } else { "似た依頼文" },
                count = esc(&int_n(c.count as f64)),
                ns = esc(&int_n(c.sessions.len() as f64)),
                med = ms(c.median_ms),
                score = esc(&dec_n(c.score)),
                more = if c.sessions.len() > 30 { format!(" …他 {}", esc(&int_n((c.sessions.len() - 30) as f64))) } else { String::new() },
            )
        })
        .collect();
    let candidates = format!(
        "<section class=\"section ins\" id=\"i-candidates\" aria-labelledby=\"h-i-candidates\"><div class=\"section-head\"><h2 id=\"h-i-candidates\">スキル化の候補</h2><p>似た依頼文の繰り返し(正規化した文の 3-gram の Jaccard 類似度 {sim} 以上)と、同じツールの並びの繰り返し(本体のターンごとの列から長さ {smin}〜{smax})。{rep} 回以上・2 セッション以上のもの。スコアは回数 × 1 回の実働の中央値(分。1 分未満は 1 分、2 時間で頭打ち)。実働はターンの中で 5 分を超えて出来事が無かった区間(返答待ちや放置)を除いた時間です。全記録(絞り込み前、空のセッションを含む)で計算。LLM は使っていない。下書きは <code>bin\\atlas.exe skill-draft &lt;番号&gt;</code>(クレジットを消費。明示したときだけ)。</p></div>{cands}</section>",
        sim = num(T::SIMILARITY),
        smin = T::SEQ_MIN,
        smax = T::SEQ_MAX,
        rep = T::MIN_REPEAT,
        cands = if cands.is_empty() { "<p class=\"note\">候補はありません(繰り返しが閾値に届かない)。</p>".to_string() } else { cands },
    );

    format!(
        "{head}<body>\n{top}\n<div class=\"shell\">\n{rail}\n<div class=\"content\">\n<main class=\"wrap\">\n<div class=\"title\"><h1>改善点(全件)</h1><p class=\"lead\">LLM を呼ばない規則の集計。分かるのは相関までで、「傾向」として読んでください。全記録 {n} 件(絞り込み前。空のセッション {empty} 件を含みますが、空のセッションは結果に影響しません)で計算。生成 {at}。{anon}</p></div>\n{instructions}\n{skills}\n{stuck}\n{candidates}\n</main>\n<footer class=\"wrap page-foot\"><p>atlas.html の「改善点」の節は、絞り込みに従って同じ規則で再計算したもの(スキル化の候補だけは全セッションで計算)。</p></footer>\n</div>\n</div>\n<script>{NAV_JS}</script>\n</body>\n</html>\n",
        head = page_head(o.code, "改善点 | Copilot Session Atlas", &format!("{}{CSS}", o.css)),
        top = render_top(&nav),
        rail = render_rail(&nav),
        n = esc(&int_n(o.sessions as f64)),
        empty = esc(&int_n(o.empty_sessions as f64)),
        at = esc(&date_time_n(Some(o.generated_at))),
        anon = if anon { "伏せ字版: 依頼文の本文と指示文の見出しは出さず、件数とスコアだけ。" } else { "" },
    )
}
