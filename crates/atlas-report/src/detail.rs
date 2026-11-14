//! セッション詳細ページ(out/sessions/<id>.html。packages/report/src/detail.ts の移植)。軽量な静的 HTML(スクリプトは配色の選択を読む数行だけ)。
//! atlas.html と同じ base.css を埋め込み、同じ「様式」の見た目にする。

use crate::aggregate::friction_total;
use crate::anonymize::Anonymizer;
use crate::exec::{quantiles_of, EFFORT_ORDER, INITIATOR_ORDER, MODE_ORDER, UNKNOWN_KEY};
use crate::exec_labels::{effort_label, error_type_label, initiator_label, mode_label, subagent_failure_label, todo_status_label, TODO_STATUS_ORDER};
use crate::filter::{coverage_of, encode_uri_component};
use crate::format::{date_time_n, dec_n, duration, int_n, model_label, ms_label, percent, truncate};
use crate::html::esc;
use crate::insights::clean_heading;
use crate::judgment_labels::{backend_label, category_label, confidence_label, effect_label};
use crate::library::skill_anchor;
use crate::memo_render::MEMO_CSS;
use crate::page_nav::{page_head, render_rail, render_top, NavGroup, NavItem, NavLink, PageNavOptions, NAV_JS};
use crate::retention::{mode_label as eval_mode_label, place_label, reason_label, status_label, vcs_label, RetentionMeta, STATUSES};
use crate::types::JudgmentSummary;
use atlas_core::classify::relative_inside;
use atlas_core::collate::locale_compare;
use atlas_core::js::{self, JsMap};
use atlas_core::jsdate;
use atlas_core::jsnum::to_fixed;
use atlas_core::tables::TurnVerdicts;
use atlas_core::tool_failure::{failure_cause_label, sorted_causes};
use atlas_core::turns::{mismatch_label, outcome_label, phase_label, request_kind_label, session_turns};
use atlas_core::types::{AgentStatus, InstructionFile, InstructionInjection, InstructionScope, LineChanges, LineNote, LineSource, ProjectSource, SessionRecord, SessionTokens, SkillTrigger, SkillVia, TimelineEntry, TimelineKind, TokenCounts, TokenSource};
use atlas_core::vcs_retention::{Outcome, SessionRetention};
use regex::Regex;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

pub fn source_label(s: TokenSource) -> &'static str {
    match s {
        TokenSource::Db => "session-store.db の明細",
        TokenSource::Events => "events.jsonl の usage_record",
        TokenSource::DbEvents => "DB の明細 + usage_record で補完",
        TokenSource::Shutdown => "セッション終了時の累計(shutdown)",
        TokenSource::Partial => "出力トークンのみ(入力は推計不可)",
        TokenSource::None => "トークン記録なし",
    }
}

pub fn project_source_label(s: ProjectSource) -> &'static str {
    match s {
        ProjectSource::Repository => "記録の repository",
        ProjectSource::GitRemote => "git の origin から",
        ProjectSource::Path => "作業フォルダのパス",
        ProjectSource::Home => "ホームディレクトリ",
        ProjectSource::Temp => "一時フォルダ",
        ProjectSource::AtlasJudge => "atlas の判定実行",
        ProjectSource::Unknown => "手掛かりなし",
    }
}

fn lines_source_label(s: LineSource) -> &'static str {
    match s {
        LineSource::Shutdown => "終了時の累計(codeChanges)",
        LineSource::Tools => "ツールごとの行数の合計",
        LineSource::None => "記録なし",
    }
}

/// 変更行数の欄の注記(出所と、記録が欠けている理由 lines.note)
pub fn lines_note_text(lines: &LineChanges) -> String {
    let none = lines.source == LineSource::None;
    match lines.note {
        Some(LineNote::SubagentEdits) => {
            if none { "サブエージェントの変更は数えられない".into() } else { format!("{}(サブエージェントの変更は数えられない)", lines_source_label(lines.source)) }
        }
        Some(LineNote::EmptyShutdown) => {
            if none { "終了時の codeChanges が空(0 行・ファイル 0 件)で、ツールの行数も無い".into() } else { format!("{}(終了時の codeChanges が空のため)", lines_source_label(lines.source)) }
        }
        None => {
            if none { "codeChanges もツールの行数も無い".into() } else { lines_source_label(lines.source).into() }
        }
    }
}

fn kind_name(k: TimelineKind) -> &'static str {
    match k {
        TimelineKind::User => "user",
        TimelineKind::Tools => "tools",
        TimelineKind::Agent => "agent",
        TimelineKind::Skill => "skill",
        TimelineKind::Compaction => "compaction",
        TimelineKind::Abort => "abort",
        TimelineKind::Error => "error",
        TimelineKind::TaskComplete => "task_complete",
        TimelineKind::Shutdown => "shutdown",
    }
}

fn kind_label(k: TimelineKind) -> &'static str {
    match k {
        TimelineKind::User => "依頼",
        TimelineKind::Tools => "ツール",
        TimelineKind::Agent => "エージェント",
        TimelineKind::Skill => "skill",
        TimelineKind::Compaction => "文脈圧縮",
        TimelineKind::Abort => "中断",
        TimelineKind::Error => "エラー",
        TimelineKind::TaskComplete => "完了",
        TimelineKind::Shutdown => "終了(shutdown)",
    }
}

fn missing(text: &str) -> String {
    format!("<span class=\"missing-value\">{}</span>", esc(text))
}

/// 種別名のような短い識別子だけが入る欄。伏せ字モードでは識別子の形のときだけ出す
static IDENTIFIER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:-]{1,64}$").unwrap());
fn identifier_or_hidden(text: &str, anon: &Anonymizer) -> String {
    if !anon.enabled {
        return esc(&truncate(Some(text), 400));
    }
    if IDENTIFIER_RE.is_match(text) { esc(text) } else { missing("伏せ字モードのため本文を表示しません") }
}

fn n(v: Option<f64>) -> String {
    match v {
        None => missing("記録なし"),
        Some(v) => esc(&int_n(v)),
    }
}

fn int_i(v: i64) -> String {
    esc(&int_n(v as f64))
}

fn field(k: &str, v: &str, note: &str) -> String {
    format!("<div class=\"field\"><span class=\"k\">{}</span><span class=\"v\">{v}</span>{}</div>", esc(k), if note.is_empty() { String::new() } else { format!("<span class=\"n\">{note}</span>") })
}

/// 描いた節の見出し(表題の下の「ページ内の移動」に使う)
#[derive(Default)]
struct Sections {
    seq: usize,
    index: Vec<(String, String)>,
}

impl Sections {
    fn section(&mut self, title: &str, body: &str, lead: &str) -> String {
        self.seq += 1;
        let id = format!("sec-{}", self.seq);
        self.index.push((id.clone(), title.to_string()));
        format!(
            "<section class=\"section\" id=\"{id}\" aria-labelledby=\"{id}-h\"><div class=\"section-head\"><h2 id=\"{id}-h\">{}</h2>{}</div>{body}</section>",
            esc(title),
            if lead.is_empty() { String::new() } else { format!("<p>{lead}</p>") }
        )
    }
}

fn skill_location(l: &str) -> &str {
    match l {
        "user" => "ユーザー",
        "project" => "プロジェクト",
        "builtin" => "組み込み",
        other => other,
    }
}

/// このセッションの skill の表: 使えたもの(<available_skills>)と、一覧に無いが呼んだもの。呼んだものを先に、回数の多い順。
/// 一覧が記録に無い版では呼んだものだけ。伏せ字版では使えた skill の名前を出さず件数だけ
fn skills_in_session(r: &SessionRecord, anon: &Anonymizer, library_href: Option<&str>, has_page: &dyn Fn(&str) -> bool) -> String {
    let mut calls: JsMap<i64> = JsMap::new();
    for s in &r.skills {
        calls.inc(&s.name, 1);
    }
    let avail = r.available_skills.as_ref().and_then(|x| x.as_ref());
    let listed: HashSet<&str> = avail.map(|a| a.iter().map(|s| s.name.as_str()).collect()).unwrap_or_default();
    struct Row<'a> {
        name: &'a str,
        place: String,
        n: i64,
    }
    let mut rows: Vec<Row> = Vec::new();
    for s in avail.into_iter().flatten() {
        let place = match s.location.as_deref() {
            Some(l) if !l.is_empty() => skill_location(l).to_string(),
            _ => "不明".into(),
        };
        rows.push(Row { name: &s.name, place, n: calls.get(&s.name).copied().unwrap_or(0) });
    }
    for (name, n) in calls.js_entries() {
        if !listed.contains(name.as_str()) {
            rows.push(Row { name, place: if avail.is_some() { "一覧に無し".into() } else { "—".into() }, n: *n });
        }
    }
    rows.sort_by(|a, b| b.n.cmp(&a.n));
    let used = avail.map(|a| a.iter().filter(|s| calls.contains_key(&s.name)).count()).unwrap_or(0);
    let outside = calls.keys().filter(|k| !listed.contains(k.as_str())).count();
    let head = match avail {
        Some(a) => format!(
            "<p class=\"note\">使えた skill {} 件(システムメッセージの一覧)、うち呼んだもの {} 件。{}</p>",
            int_i(a.len() as i64),
            int_i(used as i64),
            if outside > 0 { format!("一覧に無い skill を {} 件呼んでいます。", int_i(outside as i64)) } else { String::new() }
        ),
        None => format!(
            "<p class=\"note\">使えた skill の一覧はこのセッションの記録にありません(Copilot CLI 1.0.77 より前の版や copilot -p では残りません)。{}</p>",
            if calls.is_empty() { "skill の呼び出しもありません。" } else { "呼んだ skill だけを載せます。" }
        ),
    };
    if rows.is_empty() || anon.enabled {
        return head;
    }
    let link = |name: &str, n: i64| -> String {
        match library_href {
            Some(h) if n > 0 && has_page(name) => format!("<a href=\"{}#{}\">{}</a>", esc(h), esc(&skill_anchor(name)), esc(name)),
            _ => esc(name),
        }
    };
    let body: String = rows
        .iter()
        .map(|x| {
            format!(
                "<tr{}><td>{}</td><td>{}</td><td class=\"num\">{}</td></tr>",
                if x.n > 0 { " class=\"called\"" } else { "" },
                link(x.name, x.n),
                esc(&x.place),
                if x.n > 0 { int_i(x.n) } else { "<span class=\"missing-value\">—</span>".into() }
            )
        })
        .collect();
    format!("{head}<div class=\"table-scroll\"><table class=\"ledger\" data-testid=\"session-skills\"><thead><tr><th scope=\"col\">skill</th><th scope=\"col\">置き場所</th><th scope=\"col\" class=\"num\">呼んだ回数</th></tr></thead><tbody>{body}</tbody></table></div>")
}

fn bar(v: f64, max: f64) -> String {
    format!("<span class=\"bar\" style=\"width:{}%\"></span>", to_fixed((v / max) * 100.0, 1))
}

fn count_table(rows: &[(String, i64)], key_label: &str, value_label: &str, empty: &str) -> String {
    if rows.is_empty() {
        return format!("<p class=\"note\">{}</p>", esc(empty));
    }
    let max = rows.iter().map(|r| r.1).max().unwrap_or(1).max(1) as f64;
    let body: String = rows.iter().map(|(k, v)| format!("<tr><th scope=\"row\">{}</th><td class=\"num\">{}</td><td class=\"barcol\">{}</td></tr>", esc(k), int_i(*v), bar(*v as f64, max))).collect();
    format!(
        "<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">{}</th><th scope=\"col\" class=\"num\">{}</th><th scope=\"col\" class=\"barcol\"><span class=\"sr-only\">割合</span></th></tr></thead><tbody>{body}</tbody></table></div>",
        esc(key_label),
        esc(value_label)
    )
}

/// `entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))`
fn by_count_then_name(m: &JsMap<i64>) -> Vec<(String, i64)> {
    let mut rows: Vec<(String, i64)> = m.js_entries().into_iter().map(|(k, v)| (k.clone(), *v)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(&a.0, &b.0)));
    rows
}

/// ツール別の回数と結果(成功・失敗・拒否)。MCP ツールはサーバー名を添える
fn tool_table(r: &SessionRecord) -> String {
    let rows = by_count_then_name(&r.tools.by_name);
    if rows.is_empty() {
        return "<p class=\"note\">ツール呼び出しはありません。</p>".into();
    }
    let mut server_of: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for (server, by_tool) in r.tools.mcp.js_entries() {
        for tool in by_tool.js_keys() {
            server_of.insert(tool, server);
        }
    }
    let max = rows.iter().map(|x| x.1).max().unwrap_or(1).max(1) as f64;
    let results = &r.tools.results;
    let no_result = |k: &str, calls: i64| -> i64 { results.get(k).map_or(0, |res| (calls - res.success - res.failure - res.denied).max(0)) };
    let any_no_result = rows.iter().any(|(k, v)| no_result(k, *v) > 0);
    let cause_text = |k: &str| -> String { sorted_causes(results.get(k).and_then(|x| x.causes.as_ref())).iter().map(|(c, n)| format!("{} {}", failure_cause_label(c), int_n(*n as f64))).collect::<Vec<_>>().join("・") };
    let any_cause = rows.iter().any(|(k, _)| !cause_text(k).is_empty());
    let body: String = rows
        .iter()
        .map(|(k, v)| {
            let res = results.get(k);
            let nr = no_result(k, *v);
            let ct = if any_cause { cause_text(k) } else { String::new() };
            format!(
                "<tr><th scope=\"row\">{}{}</th><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>{}{}<td class=\"barcol\">{}</td></tr>",
                esc(k),
                server_of.get(k.as_str()).map(|s| format!(" <span class=\"tag\">MCP: {}</span>", esc(s))).unwrap_or_default(),
                int_i(*v),
                res.map_or_else(|| missing("—"), |x| int_i(x.success)),
                res.map_or_else(|| missing("—"), |x| int_i(x.failure)),
                res.map_or_else(|| missing("—"), |x| int_i(x.denied)),
                if any_no_result { format!("<td class=\"num\">{}</td>", if nr != 0 { int_i(nr) } else { missing("—") }) } else { String::new() },
                if any_cause { format!("<td>{}</td>", if ct.is_empty() { missing("—") } else { esc(&ct) }) } else { String::new() },
                bar(*v as f64, max)
            )
        })
        .collect();
    format!(
        "<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">ツール</th><th scope=\"col\" class=\"num\">回数</th><th scope=\"col\" class=\"num\">成功</th><th scope=\"col\" class=\"num\">失敗</th><th scope=\"col\" class=\"num\">拒否</th>{}{}<th scope=\"col\" class=\"barcol\"><span class=\"sr-only\">割合</span></th></tr></thead><tbody>{body}</tbody></table></div>{}",
        if any_no_result { "<th scope=\"col\" class=\"num\">結果なし</th>" } else { "" },
        if any_cause { "<th scope=\"col\">失敗の要因</th>" } else { "" },
        if any_no_result { "<p class=\"note\">結果なし: 呼び出しの開始はあるが、終わり(成功・失敗・拒否)の記録が無いもの(中断など)。</p>" } else { "" }
    )
}

/// 明細のある出所(リクエスト単位の記録)
fn per_request(s: TokenSource) -> bool {
    matches!(s, TokenSource::Db | TokenSource::Events | TokenSource::DbEvents)
}

/// API リクエストの値。明細も終了時の累計の件数も無ければ 0 ではなく記録なし
fn requests_value(t: &SessionTokens) -> String {
    match t.requests {
        Some(v) if per_request(t.source) || t.source == TokenSource::Shutdown => esc(&int_n(v)),
        _ => missing("記録なし"),
    }
}

/// API リクエストの出所(明細 / 終了時の累計 / 無し)
pub fn requests_note(t: &SessionTokens) -> &'static str {
    if per_request(t.source) {
        return "リクエスト単位の明細の件数";
    }
    if t.source == TokenSource::Shutdown {
        return if t.requests.is_none() { "終了時の累計(shutdown)に件数が無い" } else { "終了時の累計(shutdown)の件数" };
    }
    "リクエスト単位の明細も終了時の累計も無い"
}

/// premium request の出所。明細の行に 1 つも値が無ければ終了時の累計で補っている
fn premium_note(t: &SessionTokens) -> &'static str {
    let from_rows = per_request(t.source) && t.by_model.values().any(|m| m.premium_requests.is_some());
    if from_rows { "ユーザー起点のリクエストの倍率の和(明細)" } else { "終了時の累計(shutdown)" }
}

/// 同じ内容(contentHash)の指示文を 1 行にまとめる(ソースのパスがある行 > ファイルを特定できた行 > 先の行 を残し、注入回数は足し、初出は早い方)
pub fn merge_instruction_rows(rows: &[InstructionInjection]) -> Vec<InstructionInjection> {
    let rank = |i: &InstructionInjection| -> i32 {
        if i.source_path.as_deref().is_some_and(|s| !s.is_empty()) {
            2
        } else if i.file != InstructionFile::Unknown {
            1
        } else {
            0
        }
    };
    let mut by_hash: indexmap::IndexMap<&str, InstructionInjection> = indexmap::IndexMap::new();
    for i in rows {
        let Some(cur) = by_hash.get(i.content_hash.as_str()) else {
            by_hash.insert(&i.content_hash, i.clone());
            continue;
        };
        let mut keep = if rank(i) > rank(cur) { i.clone() } else { cur.clone() };
        keep.injections = cur.injections + i.injections;
        let mut firsts: Vec<&String> = [cur.first_seen_at.as_ref(), i.first_seen_at.as_ref()].into_iter().flatten().collect();
        // Date.parse の差で並べる(読めない値は NaN で順が変わらない)
        firsts.sort_by(|a, b| match (jsdate::parse_ms(a), jsdate::parse_ms(b)) {
            (Some(x), Some(y)) => x.cmp(&y),
            _ => Ordering::Equal,
        });
        keep.first_seen_at = firsts.first().map(|s| (*s).clone());
        by_hash.insert(&i.content_hash, keep);
    }
    by_hash.into_values().collect()
}

fn token_row(label: &str, t: &TokenCounts) -> String {
    format!(
        "<tr><th scope=\"row\">{}</th><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
        esc(label),
        n(t.input),
        n(Some(t.output)),
        n(t.cache_read),
        n(t.reasoning),
        n(t.requests)
    )
}

fn token_table(rows: &[(String, &TokenCounts)], key_label: &str) -> String {
    let body: String = rows.iter().map(|(k, t)| token_row(k, t)).collect();
    format!(
        "<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">{}</th><th scope=\"col\" class=\"num\">入力</th><th scope=\"col\" class=\"num\">出力</th><th scope=\"col\" class=\"num\">キャッシュ読取</th><th scope=\"col\" class=\"num\">推論</th><th scope=\"col\" class=\"num\">リクエスト</th></tr></thead><tbody>{body}</tbody></table></div>",
        esc(key_label)
    )
}

/// 依頼ごとの経過の説明(工程・依頼の種類の決め方と、200 依頼を超えたときの断り)
fn turn_lead(r: &SessionRecord, judged: bool) -> String {
    let n = r.analysis.turn_stats.as_ref().map_or(0, Vec::len) as i64;
    let cut = if n > 0 && r.turns > n { format!("先頭 {} 依頼だけを載せています(全 {} 依頼)。", int_i(n), int_i(r.turns)) } else { String::new() };
    let llm = if judged {
        "「採用」「合わなかった点」「工程(普段)」は LLM の判定で、次の依頼の文から決めたものです(推定)。「工程(普段)」は、設定した普段の工程名に LLM が当てはめたもので、「工程」(使ったツールから決めたもの)とは別です。"
    } else {
        ""
    };
    format!("{cut}工程はその依頼で使ったツール、依頼の種類は依頼文の語からの推定です(レポートの<a href=\"../atlas.html#phases\">「工程と詰まり」</a>と同じ規則。<a href=\"../glossary.html#turn-phase\">用語の説明</a>)。{llm}詰まりのあった依頼に印を付けています。")
}

/// 依頼(ターン)ごとの工程・種類・詰まり・使用量の表
fn turn_table(r: &SessionRecord, anon: &Anonymizer, verdicts: Option<&TurnVerdicts>) -> String {
    let rows = session_turns(r);
    let judged = verdicts.is_some_and(|v| !v.is_empty());
    if rows.is_empty() {
        return "<p class=\"note\">依頼ごとの記録がありません(イベントログが無いか、古い集計です。atlas.bat で集計し直すと入ります)。</p>".into();
    }
    let day0 = match rows[0].stats.started_at.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => js::utf16_slice(&date_time_n(Some(s)), 0, 10).into_owned(),
        None => String::new(),
    };
    let verdict_cells = |n: usize| -> String {
        if !judged {
            return String::new();
        }
        let Some(v) = verdicts.and_then(|m| m.get(&atlas_core::tables::turn_key(n as f64))) else {
            return format!("<td>{}</td><td>{}</td><td>{}</td>", missing("未判定"), missing("—"), missing("—"));
        };
        let note = anon.free_text(Some(&v.note));
        // 判定の理由は全文を出す
        let why = match note.as_deref().filter(|s| !s.is_empty()) {
            Some(t) => format!(" <span class=\"why\">{}</span>", esc(t)),
            None => String::new(),
        };
        format!(
            "<td><span class=\"tag{}\">{}</span>{why}</td><td>{}</td><td>{}</td>",
            if v.outcome == "rejected" || v.outcome == "off_target" { " warn" } else { "" },
            esc(outcome_label(v.outcome)),
            v.mismatch.map(|m| esc(mismatch_label(m))).unwrap_or_default(),
            esc(&v.phase)
        )
    };
    let mut body = String::new();
    for t in &rows {
        let s = t.stats;
        let text = anon.free_text(Some(t.text));
        let req = if js::trim(t.text).is_empty() {
            missing("(本文なし)")
        } else {
            match text {
                None => missing("伏せ字"),
                Some(x) => esc(&truncate(Some(&x), 80)),
            }
        };
        let stuck = t.is_stuck();
        let next = if t.followed_by_fix() { format!(" <span class=\"tag warn\">次で{}</span>", esc(request_kind_label(t.next_kind.unwrap_or("")))) } else { String::new() };
        // 時刻だけ(最初の依頼と日付が違うときは月日も)
        let dt = match s.started_at.as_deref().filter(|x| !x.is_empty()) {
            Some(x) => date_time_n(Some(x)),
            None => String::new(),
        };
        let time = if dt.is_empty() {
            missing("—")
        } else {
            esc(&if js::utf16_slice(&dt, 0, 10) == day0 { js::utf16_slice(&dt, 11, usize::MAX).into_owned() } else { js::utf16_slice(&dt, 5, usize::MAX).into_owned() })
        };
        let num = |v: i64| -> String { if v != 0 { int_i(v) } else { "<span class=\"zero\">0</span>".into() } };
        body.push_str(&format!(
            "<tr{}><th scope=\"row\" class=\"num\">{}</th><td>{time}</td><td class=\"req\">{req}{next}</td><td>{}</td><td>{}{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>{}</tr>",
            if stuck { " class=\"stuck\"" } else { "" },
            esc(&t.index.to_string()),
            esc(request_kind_label(t.kind)),
            esc(phase_label(t.phase)),
            if stuck { " <span class=\"tag warn\">詰まり</span>" } else { "" },
            match t.active_ms {
                None => missing("—"),
                Some(v) => esc(&duration(Some(v), "不明")),
            },
            num(s.tools),
            num(s.tool_failures),
            num(s.denied),
            num(s.aborts),
            num(s.errors),
            num(s.re_edits),
            num(s.compactions),
            match s.nano_aiu {
                Some(v) if v != 0.0 && !v.is_nan() => esc(&dec_n(v / 1e9)),
                _ => missing("—"),
            },
            verdict_cells(t.index)
        ));
    }
    format!(
        "<div class=\"table-scroll\"><table class=\"ledger small turns\"><thead><tr><th scope=\"col\" class=\"num\">#</th><th scope=\"col\">開始</th><th scope=\"col\">依頼</th><th scope=\"col\">種類</th><th scope=\"col\">工程</th><th scope=\"col\" class=\"num\">実働</th><th scope=\"col\" class=\"num\">ツール呼び出し</th><th scope=\"col\" class=\"num\">ツールの失敗</th><th scope=\"col\" class=\"num\">拒否</th><th scope=\"col\" class=\"num\">中断</th><th scope=\"col\" class=\"num\">エラー</th><th scope=\"col\" class=\"num\">再編集</th><th scope=\"col\" class=\"num\">文脈圧縮</th><th scope=\"col\" class=\"num\">AIU</th>{}</tr></thead><tbody>{body}</tbody></table></div>",
        if judged { "<th scope=\"col\">採用(LLM)</th><th scope=\"col\">合わなかった点</th><th scope=\"col\">工程(普段)</th>" } else { "" }
    )
}

fn timeline_row(e: &TimelineEntry, anon: &Anonymizer) -> String {
    let hidden = || missing("伏せ字モードのため本文を表示しません");
    let label = match e.kind {
        TimelineKind::User if js::trim(&e.label).is_empty() => missing("(本文なし)"),
        TimelineKind::User | TimelineKind::TaskComplete | TimelineKind::Abort => match anon.free_text(Some(&e.label)) {
            None => hidden(),
            Some(t) => esc(&truncate(Some(&t), 400)),
        },
        TimelineKind::Tools => {
            let mut tools: Vec<(&String, &i64)> = e.tools.as_ref().map(|t| t.js_entries()).unwrap_or_default();
            tools.sort_by(|a, b| b.1.cmp(a.1));
            let s: Vec<String> = tools.iter().map(|(k, v)| format!("{k} ×{v}")).collect();
            format!("{} 回: {}", esc(&int_n(e.count.unwrap_or(0) as f64)), esc(&s.join("、")))
        }
        TimelineKind::Error => identifier_or_hidden(&e.label, anon),
        _ => esc(&anon.scrub(&truncate(Some(&e.label), 400))),
    };
    format!("<tr class=\"k-{}\"><td class=\"num\">{}</td><td><span class=\"kind\">{}</span></td><td>{label}</td></tr>", kind_name(e.kind), esc(&date_time_n(Some(&e.at))), esc(kind_label(e.kind)))
}

fn num_str(v: Option<f64>) -> String {
    match v {
        None => "—".into(),
        Some(v) => esc(&js::num_to_string(v)),
    }
}

fn judgment_section(sec: &mut Sections, j: &JudgmentSummary, active_ms: Option<f64>) -> String {
    let ratio = match (j.hours, active_ms) {
        (Some(h), Some(a)) if a > 0.0 => Some(h / (a / 3_600_000.0)),
        _ => None,
    };
    let range = match (j.low, j.high) {
        (Some(l), Some(h)) => format!("幅 {}〜{} 時間、", esc(&dec_n(l)), esc(&dec_n(h))),
        _ => String::new(),
    };
    let fields = [
        field("タスク分類", &esc(&category_label(j.task_category.as_deref())), ""),
        field("推定人手工数", &j.hours.map_or_else(|| missing("記録なし"), |h| format!("{} 時間", esc(&dec_n(h)))), &format!("{range}{}", esc(&confidence_label(j.confidence)))),
        field("AI の実働時間", &esc(&duration(active_ms, "不明")), &ratio.map(|r| format!("推定人手工数はその {} 倍", esc(&dec_n(js::round(r * 10.0) / 10.0)))).unwrap_or_default()),
        field(
            "AI の成果",
            &match j.completed {
                None => missing("記録なし"),
                Some(true) => "達成".into(),
                Some(false) => "未達成".into(),
            },
            &format!("質 {} / 5・手戻り {} / 5", num_str(j.quality), num_str(j.rework)),
        ),
        field("指示ファイルの効果", &esc(&effect_label(j.effects.instructions)), ""),
        field("llm-wiki の効果", &esc(&effect_label(j.effects.wiki)), ""),
        field("skill・agent の効果", &esc(&effect_label(j.effects.skills_agents)), ""),
        field("判定", &esc(&backend_label(j.backend.as_deref())), ""),
    ]
    .join("");
    let summary = match j.task_summary.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!("<h3>タスクの要約</h3><blockquote class=\"msg\">{}</blockquote>", esc(s)),
        None => String::new(),
    };
    let rationale = match j.rationale.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => format!("<h3>工数推定の根拠</h3><blockquote class=\"msg\">{}</blockquote>", esc(s)),
        None => String::new(),
    };
    sec.section("LLM による判定(推定)", &format!("<div class=\"fields\" style=\"--cols:4\">{fields}</div>{summary}{rationale}"), "人が AI なしで同じ成果を出す場合の工数を LLM に推定させた値です。実測ではありません。")
}

/// セッションの終わりから比べた時点までの日数(「・終わりから 3.5 日後」)。どちらかが無ければ空
fn lag_text(end: Option<&str>, at: Option<&str>) -> String {
    let e = end.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms);
    let t = at.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms);
    let (Some(e), Some(t)) = (e, t) else {
        return String::new();
    };
    let d = (js::round(((t - e) as f64 / 86_400_000.0) * 10.0) / 10.0).max(0.0);
    format!("・セッションの終わりから {} 日後", esc(&dec_n(d)))
}

/// AI の変更がその後の VCS のファイルに残っているか(atlas vcs の結果)。伏せ字版ではパスを出さない
fn retention_section(sec: &mut Sections, r: &SessionRetention, meta: Option<&RetentionMeta>, anon: &Anonymizer) -> String {
    // 状態の名前は、設定(vcs.labels)で差し替えたものがあればそれ
    let label = |k: &str| -> String { meta.and_then(|m| m.labels.as_ref()).and_then(|l| l.get(k)).cloned().unwrap_or_else(|| status_label(k).to_string()) };
    let lead = esc(&format!("AI が足した行が、その後の VCS のファイルに残っているかを数えます。{}", meta.and_then(|m| m.note.as_deref()).unwrap_or("")));
    let unread = match r.unread_edits {
        Some(n) if n != 0 => format!("<p class=\"note\">ログから変更を取り出せなかった AI の編集 {} 件は数えていません(diff も編集の引数も読めなかったもの)。</p>", int_i(n)),
        _ => String::new(),
    };
    if r.outcome == Outcome::NoAiChanges {
        return sec.section("AI の変更の残存(VCS)", &format!("<p class=\"note\">このセッションには、数える AI の変更(編集・作成で足した行)がありません。</p>{unread}"), &lead);
    }
    let measured_hunks = r.counts.kept + r.counts.modified + r.counts.missing;
    let computed_on = r.computed_on.map(|c| c.as_str());
    let place = if computed_on.is_some() { format!("{}で照合", place_label(computed_on)) } else { place_label(computed_on).to_string() };
    let baseline = r.baseline.as_ref().map(|b| if b.source.as_str() == "observed" { "記録(ログに残った開始時の版)" } else { "推定(開始時刻から VCS の履歴で探した版)" }).unwrap_or("");
    let evaluated_note = match &r.evaluated {
        Some(ev) => {
            let at: Option<&str> = Some(ev.at.as_str()).filter(|s| !s.is_empty()).or_else(|| if computed_on == Some("local") { meta.map(|m| m.generated_at.as_str()).filter(|s| !s.is_empty()) } else { None });
            format!(
                "{} {}{}",
                if ev.mode.as_str() == "fixed" { "比べた時点" } else { "照合" },
                esc(&date_time_n(at)),
                lag_text(r.session_end.as_ref().and_then(|x| x.as_deref()), Some(&ev.at))
            )
        }
        None => String::new(),
    };
    let fields = [
        field(
            "照合の結果",
            &if r.outcome == Outcome::Measured { "照合できた".into() } else { esc(&label("unattributable")) },
            &match (r.outcome, r.reason) {
                (Outcome::Unattributable, Some(reason)) => esc(reason_label(reason.as_str())),
                _ => format!("照合できたまとまり {} / {}", int_i(measured_hunks), int_i(r.hunks.len() as i64)),
            },
        ),
        field("VCS", &r.vcs.map_or_else(|| missing("不明"), |v| esc(vcs_label(v.as_str()))), &format!("{}{}", esc(&place), if r.path_mapped == Some(true) { "・パスを設定で読み替え" } else { "" })),
        field(
            "開始時の基準",
            &r.baseline.as_ref().map_or_else(|| missing("なし"), |b| esc(if b.source.as_str() == "observed" { "記録" } else { "推定" })),
            &if baseline.is_empty() { String::new() } else { esc(baseline) },
        ),
        field("比べる版", &r.evaluated.as_ref().map_or_else(|| missing("なし"), |ev| esc(eval_mode_label(ev.mode))), &evaluated_note),
    ]
    .join("");
    let counts: String = STATUSES.iter().map(|k| format!("<tr><th scope=\"row\">{}</th><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>", esc(&label(k)), int_i(count_of(&r.counts, k)), int_i(count_of(&r.lines, k)))).collect();
    let counts = format!("<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">状態</th><th scope=\"col\" class=\"num\">まとまり</th><th scope=\"col\" class=\"num\">行</th></tr></thead><tbody>{counts}</tbody></table></div>");
    // リポジトリの中のファイルは、リポジトリからの相対パスで出す。照合と同じ relativeInside で決める
    let rel = |p: &str| -> String { r.root.as_deref().filter(|s| !s.is_empty()).and_then(|root| relative_inside(root, p)).unwrap_or_else(|| p.to_string()) };
    let rows: String = r
        .hunks
        .iter()
        .map(|h| {
            let path = anon.path(Some(&rel(&h.path)));
            format!(
                "<tr><td class=\"num\">{}</td><td>{}</td><td class=\"st\">{}{}</td>{}</tr>",
                int_i(h.id),
                path.map_or_else(|| missing("伏せ字"), |p| format!("<code>{}</code>", esc(&p))),
                esc(&label(h.status.as_str())),
                h.reason.map(|x| format!("<span class=\"why\">{}</span>", esc(reason_label(x.as_str())))).unwrap_or_default(),
                STATUSES.iter().map(|k| format!("<td class=\"num\">{}</td>", int_i(count_of(&h.lines, k)))).collect::<String>()
            )
        })
        .collect();
    let table = if r.hunks.is_empty() {
        String::new()
    } else {
        format!(
            "<h3 class=\"gap\">まとまりごと</h3><div class=\"table-scroll\"><table class=\"ledger turns\"><thead><tr><th scope=\"col\" class=\"num\">番号</th><th scope=\"col\">ファイル</th><th scope=\"col\">状態</th>{}</tr></thead><tbody>{rows}</tbody></table></div>",
            STATUSES.iter().map(|k| format!("<th scope=\"col\" class=\"num\">{}(行)</th>", esc(&label(k)))).collect::<String>()
        )
    };
    let excluded = if r.excluded_hunks != 0 { format!("<p class=\"note\">開始時の基準のファイルにもともとあった行だけでできたまとまり {} 件は数えていません。</p>", int_i(r.excluded_hunks)) } else { String::new() };
    sec.section("AI の変更の残存(VCS)", &format!("<div class=\"fields\" style=\"--cols:4\">{fields}</div>{counts}{table}{excluded}{unread}"), &lead)
}

fn count_of(c: &atlas_core::vcs_retention::LineCounts, k: &str) -> i64 {
    match k {
        "kept" => c.kept,
        "modified" => c.modified,
        "missing" => c.missing,
        _ => c.unattributable,
    }
}

/// 決まった並び(order)→ 残りは名前順、(unknown) は最後
fn ordered<'a>(keys: Vec<&'a String>, order: &[&str]) -> Vec<&'a String> {
    let rank = |k: &str| -> usize {
        if k == UNKNOWN_KEY {
            order.len() + 1
        } else {
            order.iter().position(|x| *x == k).unwrap_or(order.len())
        }
    };
    let mut keys = keys;
    keys.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| locale_compare(a, b)));
    keys
}

/// Phase 7: 実行の性質(モード・推論強度・起点・文脈・待ち時間・ツールの所要時間・摩擦の詳細・todo)
fn exec_section(sec: &mut Sections, r: &SessionRecord, anon: &Anonymizer) -> String {
    let e = &r.exec;
    let modes = ordered(e.modes.by_mode.js_keys(), &MODE_ORDER);
    let mode_text = modes.iter().map(|k| format!("{} {}", mode_label(k), int_n(e.modes.by_mode[k.as_str()] as f64))).collect::<Vec<_>>().join("・");
    let eff_keys = ordered(e.efforts.js_keys(), &EFFORT_ORDER);
    let eff_text = eff_keys.iter().map(|k| format!("{} {} 回", effort_label(k), int_n(e.efforts[k.as_str()].requests))).collect::<Vec<_>>().join("・");
    let init_keys = ordered(e.initiators.js_keys(), &INITIATOR_ORDER);
    let init_total: i64 = init_keys.iter().map(|k| e.initiators[k.as_str()]).sum();
    let init_text = init_keys.iter().map(|k| format!("{} {}({})", initiator_label(k), int_n(e.initiators[k.as_str()] as f64), percent(e.initiators[k.as_str()] as f64, init_total as f64))).collect::<Vec<_>>().join("・");
    let c = &e.context;
    // system・会話がともに 0 なのは空の終了記録。割合が 100% にならないよう記録なしとみなす
    let ctx_empty = c.system_tokens == Some(0.0) && c.conversation_tokens == Some(0.0);
    let sys_tok = if ctx_empty { None } else { c.system_tokens };
    let conv_tok = if ctx_empty { None } else { c.conversation_tokens };
    let ctx_sum = match (sys_tok, conv_tok, c.tool_definitions_tokens) {
        (Some(a), Some(b), Some(t)) => Some(a + b + t),
        _ => None,
    };
    let ctx_sum_truthy = ctx_sum.is_some_and(|v| v != 0.0 && !v.is_nan());
    let ctx_note = [
        sys_tok.map(|v| format!("system {}", int_n(v))).unwrap_or_default(),
        conv_tok.map(|v| format!("会話 {}", int_n(v))).unwrap_or_default(),
        if c.tool_definitions_tokens.is_some() && !ctx_sum_truthy { "文脈に占める割合は出せない(system・会話の記録なし)".into() } else { String::new() },
        c.available_tool_count.map(|v| format!("使えるツール {} 個", int_n(v))).unwrap_or_default(),
        c.source
            .map(|s| {
                format!(
                    "出所: {}",
                    match s {
                        atlas_core::types::ContextSource::Shutdown => "終了時",
                        atlas_core::types::ContextSource::Compaction => "compaction",
                        atlas_core::types::ContextSource::Usage => "リクエストごとの利用記録",
                    }
                )
            })
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("・");
    let small = |t: &str| format!("<span class=\"small\">{}</span>", esc(t));
    let fields = [
        field("モード別の依頼", &if mode_text.is_empty() { missing("記録なし") } else { esc(&mode_text) }, &if e.modes.inferred != 0 { format!("うち {} 回は記録が無く既定の interactive とみなした", int_i(e.modes.inferred)) } else { String::new() }),
        field("推論強度", &if eff_text.is_empty() { missing("記録なし") } else { small(&eff_text) }, ""),
        field("リクエストの起点", &if init_text.is_empty() { missing("記録なし") } else { small(&init_text) }, "明細のあるリクエストだけ"),
        field(
            "ツール定義のトークン",
            &c.tool_definitions_tokens.map_or_else(|| missing("記録なし"), |v| esc(&int_n(v))),
            &format!("{}{}", if ctx_sum_truthy { format!("文脈の {}・", esc(&percent(c.tool_definitions_tokens.unwrap_or(0.0), ctx_sum.unwrap_or(0.0)))) } else { String::new() }, esc(&ctx_note)),
        ),
    ]
    .join("");
    let fields = format!("<div class=\"fields\" style=\"--cols:4\">{fields}</div>");

    let mut lat = e.latency.js_entries();
    lat.sort_by(|a, b| ((b.1.ttft.len() + b.1.duration.len()) as i64).cmp(&((a.1.ttft.len() + a.1.duration.len()) as i64)).then_with(|| locale_compare(a.0, b.0)));
    let lat_table = if lat.is_empty() {
        String::new()
    } else {
        let rows: String = lat
            .iter()
            .map(|(m, l)| {
                let t = quantiles_of(&l.ttft);
                let d = quantiles_of(&l.duration);
                format!(
                    "<tr><th scope=\"row\" title=\"{}\">{}</th><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                    esc(m),
                    esc(&model_label(m)),
                    int_i(t.n.max(d.n)),
                    esc(&ms_label(t.median, "—")),
                    esc(&ms_label(t.p90, "—")),
                    esc(&ms_label(d.median, "—")),
                    esc(&ms_label(d.p90, "—"))
                )
            })
            .collect();
        format!("<h3>モデル別の待ち時間</h3><div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">モデル</th><th scope=\"col\" class=\"num\">件数</th><th scope=\"col\" class=\"num\">最初のトークンまで(中央値)</th><th scope=\"col\" class=\"num\">同(p90)</th><th scope=\"col\" class=\"num\">全体(中央値)</th><th scope=\"col\" class=\"num\">全体(p90)</th></tr></thead><tbody>{rows}</tbody></table></div>")
    };

    let mut keys: Vec<&String> = Vec::new();
    for k in r.tools.durations.js_keys().into_iter().chain(r.tools.duration_outliers.js_keys()) {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let empty: Vec<f64> = Vec::new();
    let mut dur_tools: Vec<(&String, crate::exec::QuantileRow, i64)> = keys.into_iter().map(|k| (k, quantiles_of(r.tools.durations.get(k.as_str()).unwrap_or(&empty)), r.tools.duration_outliers.get(k.as_str()).copied().unwrap_or(0))).collect();
    dur_tools.sort_by(|a, b| {
        let (pa, pb) = (a.1.p90.unwrap_or(-1.0), b.1.p90.unwrap_or(-1.0));
        (pb - pa).partial_cmp(&0.0).unwrap_or(Ordering::Equal).then_with(|| locale_compare(a.0, b.0))
    });
    let out_total: i64 = dur_tools.iter().map(|x| x.2).sum();
    let dur_table = if dur_tools.is_empty() {
        String::new()
    } else {
        let rows: String = dur_tools
            .iter()
            .map(|(k, q, out)| format!("<tr><th scope=\"row\">{}</th><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>", esc(k), int_i(q.n), esc(&ms_label(q.median, "—")), esc(&ms_label(q.p90, "—")), if *out != 0 { int_i(*out) } else { "—".into() }))
            .collect();
        format!(
            "<h3>ツールの所要時間</h3><div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">ツール</th><th scope=\"col\" class=\"num\">回数</th><th scope=\"col\" class=\"num\">中央値</th><th scope=\"col\" class=\"num\">p90</th><th scope=\"col\" class=\"num\">外れ値(1 時間超)</th></tr></thead><tbody>{rows}</tbody></table></div>{}",
            if out_total != 0 { format!("<p class=\"note\">1 時間を超えた {} 回は外れ値として中央値・p90 から除いています。</p>", int_i(out_total)) } else { String::new() }
        )
    };

    let f = &r.friction_detail;
    let kv = |m: &JsMap<i64>, label: &dyn Fn(&str) -> String| -> String { by_count_then_name(m).iter().map(|(k, n)| format!("{} {}", label(k), int_n(*n as f64))).collect::<Vec<_>>().join("・") };
    let ident = |k: &str| k.to_string();
    let comp = &f.compaction;
    let fd = format!(
        "<h3>摩擦の詳細</h3><div class=\"fields\" style=\"--cols:4\">{}</div>",
        [
            field("権限の確認の結果", &if f.permissions.is_empty() { missing("なし") } else { small(&kv(&f.permissions, &ident)) }, &format!("確認 {} 回", int_i(r.friction.permission_requests))),
            field("エラーの種別", &if f.error_types.is_empty() { missing("なし") } else { small(&kv(&f.error_types, &error_type_label)) }, ""),
            field("サブエージェント失敗の理由", &if f.subagent_failures.is_empty() { missing("なし") } else { small(&kv(&f.subagent_failures, &subagent_failure_label)) }, ""),
            field(
                "compaction 自体のトークン",
                &if comp.recorded != 0 {
                    format!("<span class=\"small\">入力 {}・出力 {}</span>", esc(&int_n(comp.input)), esc(&int_n(comp.output)))
                } else {
                    missing(if r.friction.compactions != 0 { "記録なし" } else { "なし" })
                },
                &if comp.recorded != 0 {
                    // tokensRemoved を持つ compaction が無ければ 0 ではなく記録なし(古い記録は removedRecorded が無いので値で判断)
                    let recorded = comp.removed_recorded.unwrap_or(if comp.tokens_removed > 0.0 { 1 } else { 0 });
                    format!(
                        "{}減ったトークン {}",
                        if comp.nano_aiu != 0.0 && !comp.nano_aiu.is_nan() { format!("{} AIU・", esc(&dec_n(comp.nano_aiu / 1e9))) } else { String::new() },
                        if recorded > 0 { esc(&int_n(comp.tokens_removed)) } else { "記録なし".into() }
                    )
                } else {
                    String::new()
                },
            ),
        ]
        .join("")
    );

    let todo = match &r.todos {
        None => String::new(),
        Some(td) => {
            let truthy = |k: &str| td.by_status.get(k).is_some_and(|v| *v != 0.0 && !v.is_nan());
            let mut extra: Vec<&String> = td.by_status.js_keys().into_iter().filter(|k| !TODO_STATUS_ORDER.contains(&k.as_str())).collect();
            extra.sort_by(|a, b| js::cmp_utf16(a, b));
            let keys: Vec<String> = TODO_STATUS_ORDER.iter().map(|s| s.to_string()).chain(extra.into_iter().cloned()).filter(|k| truthy(k)).collect();
            let text = if td.total != 0.0 && !td.total.is_nan() {
                esc(&format!(
                    "{} 件(完了率 {}): {}・依存関係 {} 件",
                    int_n(td.total),
                    percent(td.by_status.get("done").copied().unwrap_or(0.0), td.total),
                    keys.iter().map(|k| format!("{} {}", todo_status_label(k), int_n(td.by_status[k.as_str()]))).collect::<Vec<_>>().join("・"),
                    int_n(td.deps)
                ))
            } else {
                "session.db はありますが todo はありません。".into()
            };
            format!("<h3>todo</h3><p class=\"note\">{text}</p>")
        }
    };

    // 失敗したサブエージェントの理由(同じ名前・同じ理由は 1 行にまとめて ×N を添える)
    let mut failed: indexmap::IndexMap<(&str, &str), i64> = indexmap::IndexMap::new();
    for a in &r.agents {
        if a.status != AgentStatus::Failed {
            continue;
        }
        let Some(err) = a.error.as_deref().filter(|s| !s.is_empty()) else { continue };
        *failed.entry((a.name.as_str(), err)).or_insert(0) += 1;
    }
    let reasons = if failed.is_empty() {
        String::new()
    } else {
        let items: String = failed
            .iter()
            .map(|((name, err), count)| {
                format!(
                    "<li>{}: {}{}</li>",
                    esc(name),
                    if anon.enabled { identifier_or_hidden(err, anon) } else { esc(&truncate(Some(err), 160)) },
                    if *count > 1 { format!(" <span class=\"tag\">×{}</span>", int_i(*count)) } else { String::new() }
                )
            })
            .collect();
        format!("<h3>失敗したサブエージェント</h3><ul class=\"note\">{items}</ul>")
    };

    sec.section("実行の性質", &format!("{fields}{lat_table}{dur_table}{fd}{reasons}{todo}"), "モード・推論強度・リクエストの起点・文脈の内訳・待ち時間・ツールの所要時間・摩擦の詳細・todo")
}

pub struct DetailMemo {
    /// 描画済みの HTML
    pub html: String,
    pub updated_at: String,
}

pub struct DetailOptions<'a> {
    pub anon: &'a Anonymizer,
    pub css: &'a str,
    pub code: &'a str,
    pub judgment: Option<&'a JudgmentSummary>,
    /// 段階 2: このセッションの依頼ごとの LLM 判定(依頼番号 → 判定)
    pub verdicts: Option<&'a TurnVerdicts>,
    pub generated_at: &'a str,
    /// セッション記録(Markdown)のファイル名(同じフォルダ)。atlas export で作ったときだけ
    pub transcript_href: Option<&'a str>,
    /// Phase 11: 指示文・skill の閲覧ページ(../instructions.html)を作ったときだけ
    pub library_href: Option<&'a str>,
    /// 指示文と skill のページにその skill の節(本文)があるか
    pub skill_has_page: &'a dyn Fn(&str) -> bool,
    /// 指示文と skill のページにこのセッションの版が 1 つでもあるか
    pub library_has_session: bool,
    /// Phase 11: 全文記録(../full/<id>.md)を作ったときだけ
    pub full_href: Option<&'a str>,
    /// Phase 13: メモ。無ければ None
    pub memo: Option<&'a DetailMemo>,
    pub retention: Option<&'a SessionRetention>,
    pub retention_meta: Option<&'a RetentionMeta>,
}

const DETAIL_CSS: &str = include_str!("../assets/detail.css");

/// Phase 13: メモの節。無ければ hidden の空の節を置く(atlas serve では編集の script がここに描く)。伏せ字版では節ごと出さない
fn memo_section(id: &str, memo: Option<&DetailMemo>) -> String {
    let body = memo.map(|m| format!("<div class=\"memo-body\">{}</div>", m.html)).unwrap_or_default();
    let when = memo.map(|m| format!("<p>更新 {}</p>", esc(&date_time_n(Some(&m.updated_at))))).unwrap_or_default();
    format!(
        "<section class=\"section\" id=\"memo\" aria-labelledby=\"memo-h\" data-session=\"{}\"{}><div class=\"section-head\"><h2 id=\"memo-h\">メモ</h2>{when}</div>{body}</section>",
        esc(id),
        if memo.is_some() { "" } else { " hidden" }
    )
}

fn opt_str<'a>(v: &'a Option<String>) -> Option<&'a str> {
    v.as_deref().filter(|s| !s.is_empty())
}

pub fn render_detail_html(r: &SessionRecord, o: &DetailOptions<'_>) -> String {
    let mut sec = Sections::default();
    let anon = o.anon;
    let has_page = o.skill_has_page;
    let t = &r.tokens;
    let lines = &r.lines;
    let name = anon.free_text(r.name.as_deref()).filter(|s| !s.is_empty());
    let title = match &name {
        Some(n) => truncate(Some(n), 120),
        None => if anon.enabled { "セッション(伏せ字)" } else { "(名前なし)" }.to_string(),
    };
    let project = anon.project_label(&r.project);
    let branch = anon.branch(r.branch.as_deref()).filter(|s| !s.is_empty());
    let person = anon.person(r.person.as_ref().and_then(|p| p.as_deref())).filter(|s| !s.is_empty());

    let record_source = |s: &atlas_core::types::SessionSource| match s {
        atlas_core::types::SessionSource::Db => ("db", "データベース"),
        atlas_core::types::SessionSource::Dir => ("dir", "ログのフォルダ"),
    };
    let coverage = coverage_of(t.input, t.output, t.source.as_str());
    let meta = [
        person.map(|p| format!("<span class=\"tag\" title=\"送り先の、人のフォルダの名前\">人: {}</span>", esc(&p))).unwrap_or_default(),
        format!("<span class=\"tag\" title=\"{}\">プロジェクト: {}</span>", esc(project_source_label(r.project_source)), esc(&project)),
        format!("<span class=\"tag\">クライアント: {}</span>", esc(r.client.as_deref().unwrap_or("不明"))),
        branch.map(|b| format!("<span class=\"tag\">ブランチ: {}</span>", esc(&b))).unwrap_or_default(),
        opt_str(&r.copilot_version).map(|v| format!("<span class=\"tag\">Copilot {}</span>", esc(v))).unwrap_or_default(),
        format!(
            "<span class=\"tag\" title=\"{}\">記録の出所: {}</span>",
            esc(&format!("読んだ記録: {}", r.sources.iter().map(|s| record_source(s).0).collect::<Vec<_>>().join(" + "))),
            esc(&r.sources.iter().map(|s| record_source(s).1).collect::<Vec<_>>().join(" + "))
        ),
        if t.input.is_none() { "<span class=\"tag warn\">入力トークン記録なし</span>".into() } else { String::new() },
        if r.empty { "<span class=\"tag\">空のセッション(依頼・ツール・応答なし)</span>".into() } else { String::new() },
        format!("<span class=\"tag id\"><span class=\"sr-only\">セッション ID </span>{}</span>", esc(&r.id)),
    ]
    .join("");

    let judgment_hours = o.judgment.and_then(|j| j.hours);
    let overview = [
        field("開始", &esc(&date_time_n(r.created_at.as_deref())), ""),
        field("所要時間", &esc(&duration(r.duration_ms, "不明")), &format!("実働 {}", esc(&duration(r.active_ms, "不明")))),
        field("依頼(ターン)", &int_i(r.turns), &if r.autopilot_continuations != 0 { format!("autopilot の自動継続 {} 回は含めない", int_i(r.autopilot_continuations)) } else { String::new() }),
        field("応答", &int_i(r.assistant_messages), "サブエージェントの応答は含めない"),
        field(
            "モデル",
            &if r.models.is_empty() { missing("不明") } else { format!("<span class=\"small\" title=\"{}\">{}</span>", esc(&r.models.join("、")), esc(&r.models.iter().map(|m| model_label(m)).collect::<Vec<_>>().join("、"))) },
            "",
        ),
        // トークンの記録が何も無いセッションは入力・出力とも「記録なし」
        field("入力トークン", &t.input.map_or_else(|| missing(if coverage == "none" { "記録なし" } else { "推計不可" }), |v| esc(&int_n(v))), &esc(source_label(t.source))),
        field("出力トークン", &if coverage == "none" { missing("記録なし") } else { esc(&int_n(t.output)) }, &esc(source_label(t.source))),
        field("うち推論トークン", &n(t.reasoning), ""),
        field("キャッシュ読取", &n(t.cache_read), &t.cache_write.map(|v| format!("書込 {}", esc(&int_n(v)))).unwrap_or_default()),
        field("AI 使用量(AIU)", &t.nano_aiu.map_or_else(|| missing("記録なし"), |v| esc(&dec_n(v / 1e9))), &t.nano_aiu.map(|v| format!("nano AIU {}", esc(&int_n(v)))).unwrap_or_default()),
        field("premium request", &t.premium_requests.map_or_else(|| missing("記録なし"), |v| esc(&dec_n(v))), &if t.premium_requests.is_none() { String::new() } else { esc(premium_note(t)) }),
        field("API リクエスト", &requests_value(t), &esc(requests_note(t))),
        field("ツール呼び出し", &int_i(r.tools.total), &if r.tools.internal.total != 0 { format!("内部ツール {} 回は除外", int_i(r.tools.internal.total)) } else { String::new() }),
        field("変更行数", &if lines.source == LineSource::None { missing("記録なし") } else { format!("+{} / −{}", esc(&int_n(lines.added)), esc(&int_n(lines.removed))) }, &esc(&lines_note_text(lines))),
        field("skill / agent / hook", &format!("{} / {} / {}", int_i(r.skills.len() as i64), int_i(r.agents.len() as i64), int_i(r.hooks.total)), ""),
        field("摩擦", &int_i(friction_total(&r.friction)), ""),
        field(
            "推定人手工数",
            &judgment_hours.map_or_else(|| missing("未判定"), |h| format!("{} 時間", esc(&dec_n(h)))),
            &match (o.judgment, judgment_hours) {
                (Some(j), Some(_)) => format!(
                    "{}{}、LLM による推定",
                    match (j.low, j.high) {
                        (Some(l), Some(h)) => format!("幅 {}〜{} 時間、", esc(&dec_n(l)), esc(&dec_n(h))),
                        _ => String::new(),
                    },
                    esc(&confidence_label(j.confidence))
                ),
                _ => "判定(judge)を回すと表示されます".into(),
            },
        ),
    ]
    .join("");
    let overview = format!("<div class=\"fields\" style=\"--cols:4\">{overview}</div>");

    let mut parts: Vec<String> = Vec::new();
    if !anon.enabled {
        parts.push(memo_section(&r.id, o.memo));
        if o.memo.is_some() {
            sec.index.push(("memo".into(), "メモ".into()));
        }
    }
    parts.push(sec.section("概要", &overview, ""));
    if let Some(j) = o.judgment {
        parts.push(judgment_section(&mut sec, j, r.active_ms));
    }
    if let Some(rt) = o.retention {
        parts.push(retention_section(&mut sec, rt, o.retention_meta, anon));
    }

    let first = anon.free_text(r.first_user_message.as_deref()).filter(|s| !s.is_empty());
    let last = anon.free_text(r.last_assistant_message.as_deref()).filter(|s| !s.is_empty());
    if first.is_some() || last.is_some() {
        let msg = |x: &Option<String>| match x {
            Some(t) => format!("<blockquote class=\"msg\">{}</blockquote>", esc(t)),
            None => format!("<p class=\"note\">{}</p>", missing("記録なし")),
        };
        parts.push(sec.section("最初の依頼と最後の応答", &format!("<div class=\"two\"><div><h3>最初の依頼</h3>{}</div><div><h3>最後の応答</h3>{}</div></div>", msg(&first), msg(&last)), ""));
    }

    let models: Vec<(String, &TokenCounts)> = t.by_model.js_entries().into_iter().map(|(k, v)| (model_label(k), v)).collect();
    let agents_tok: Vec<(String, &TokenCounts)> = t.by_agent.js_entries().into_iter().map(|(k, v)| (k.clone(), v)).collect();
    parts.push(sec.section(
        "トークン内訳",
        &format!(
            "{}{}",
            if models.is_empty() { "<p class=\"note\">モデル別の記録はありません。</p>".into() } else { token_table(&models, "モデル") },
            if agents_tok.len() > 1 { format!("<h3 class=\"gap\">エージェント別</h3>{}", token_table(&agents_tok, "エージェント(main は親)")) } else { String::new() }
        ),
        &esc(source_label(t.source)),
    ));

    let internal = r.tools.internal.by_name.js_entries();
    parts.push(sec.section(
        "ツール内訳",
        &format!(
            "{}{}",
            tool_table(r),
            if internal.is_empty() { String::new() } else { format!("<p class=\"note\">内部ツール(作業としては数えないもの): {}</p>", esc(&internal.iter().map(|(k, v)| format!("{k} ×{v}")).collect::<Vec<_>>().join("、"))) }
        ),
        "",
    ));

    let skills = if r.skills.is_empty() {
        "<p class=\"note\">skill の呼び出しはありません。</p>".to_string()
    } else {
        let rows: String = r
            .skills
            .iter()
            .map(|s| {
                format!(
                    "<tr><td>{}</td><td class=\"num\">{}</td><td>{}</td><td>{}</td></tr>",
                    match o.library_href {
                        Some(h) if !anon.enabled && has_page(&s.name) => format!("<a href=\"{}#{}\">{}</a>", esc(h), esc(&skill_anchor(&s.name)), esc(&s.name)),
                        _ => esc(&s.name),
                    },
                    esc(&date_time_n(s.at.as_deref())),
                    esc(match s.trigger {
                        Some(SkillTrigger::User) => "利用者",
                        Some(SkillTrigger::Agent) => "エージェント",
                        None => "不明",
                    }),
                    esc(match s.via {
                        SkillVia::Both => "ツール + イベント",
                        SkillVia::Tool => "ツール",
                        SkillVia::Event => "イベント",
                    })
                )
            })
            .collect();
        format!("<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">skill</th><th scope=\"col\">時刻</th><th scope=\"col\">呼んだ側</th><th scope=\"col\">記録の形</th></tr></thead><tbody>{rows}</tbody></table></div>")
    };
    let agents = if r.agents.is_empty() {
        "<p class=\"note\">サブエージェントの起動はありません。</p>".to_string()
    } else {
        let rows: String = r
            .agents
            .iter()
            .map(|a| {
                format!(
                    "<tr><td>{}</td><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                    esc(&a.name),
                    match a.status {
                        AgentStatus::Failed => "<span class=\"tag warn\">失敗</span>",
                        AgentStatus::Running => "未完了",
                        AgentStatus::Completed => "完了",
                    },
                    esc(&date_time_n(a.started_at.as_deref())),
                    n(a.total_tokens),
                    n(a.total_tool_calls)
                )
            })
            .collect();
        format!("<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">agent</th><th scope=\"col\">状態</th><th scope=\"col\">開始</th><th scope=\"col\" class=\"num\">トークン</th><th scope=\"col\" class=\"num\">ツール</th></tr></thead><tbody>{rows}</tbody></table></div>")
    };
    let mut hook_rows: Vec<(String, i64)> = r.hooks.by_type.js_entries().into_iter().map(|(k, v)| (k.clone(), *v)).collect();
    hook_rows.sort_by(|a, b| b.1.cmp(&a.1));
    let hooks = count_table(&hook_rows, "hook の種類", "実行回数", "hook の実行はありません。");
    parts.push(exec_section(&mut sec, r, anon));

    parts.push(sec.section("skills / agents / hooks", &format!("<div class=\"two\"><div><h3>skills</h3>{skills}</div><div><h3>agents</h3>{agents}</div></div><h3 class=\"gap\">hooks</h3>{hooks}"), ""));

    let inst_rows = merge_instruction_rows(&r.instructions);
    let inst = if inst_rows.is_empty() {
        "<p class=\"note\">指示ファイルの注入は見つかりませんでした。</p>".to_string()
    } else {
        let rows: String = inst_rows
            .iter()
            .map(|i| {
                let heading = clean_heading(&i.heading, Some(80));
                let heading = if heading.is_empty() { "(見出しなし)".to_string() } else { heading };
                format!(
                    "<tr><td>{}</td><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td>{}</tr>",
                    esc(if i.file == InstructionFile::Unknown { "不明(特定できず)" } else { i.file.as_str() }),
                    esc(match i.scope {
                        InstructionScope::Repo => "リポジトリ",
                        InstructionScope::User => "ユーザー",
                        InstructionScope::Unknown => "不明",
                    }),
                    int_i(i.chars),
                    int_i(i.injections),
                    esc(&date_time_n(i.first_seen_at.as_deref())),
                    if anon.enabled {
                        String::new()
                    } else {
                        format!(
                            "<td>{}</td>",
                            match o.library_href {
                                Some(h) => format!("<a href=\"{}#v-{}\">{}</a>", esc(h), esc(&i.content_hash), esc(&heading)),
                                None => esc(&heading),
                            }
                        )
                    }
                )
            })
            .collect();
        format!(
            "<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">ファイル</th><th scope=\"col\">範囲</th><th scope=\"col\" class=\"num\">文字数</th><th scope=\"col\" class=\"num\">注入回数</th><th scope=\"col\">初出</th>{}</tr></thead><tbody>{rows}</tbody></table></div>",
            if anon.enabled { "" } else { "<th scope=\"col\">先頭の見出し</th>" }
        )
    };
    // このセッションの指示文と skill を 1 か所に
    let lib_session = match o.library_href {
        Some(h) if !anon.enabled && o.library_has_session => Some(format!("{h}#session={}", encode_uri_component(&r.id))),
        _ => None,
    };
    parts.push(sec.section(
        "指示文と skill",
        &format!("<h3>指示文</h3>{inst}<h3 class=\"gap\">skill</h3>{}", skills_in_session(r, anon, o.library_href, has_page)),
        &lib_session.as_ref().map(|l| format!("<a href=\"{}\">このセッションの分だけを「指示文と skill」のページで開く</a>(本文と版の差分)", esc(l))).unwrap_or_default(),
    ));

    // Phase 11: data.db(デスクトップアプリ)の許可リストの列
    if let Some(dk) = r.desktop.as_ref().and_then(|d| d.as_ref())
        && (dk.session.is_some() || dk.workspace.is_some())
    {
        let empty = serde_json::Map::new();
        let s = dk.session.as_ref().unwrap_or(&empty);
        let w = dk.workspace.as_ref().unwrap_or(&empty);
        let v = |x: Option<&Value>| -> String {
            match x {
                None | Some(Value::Null) => "—".into(),
                Some(Value::String(t)) if t.is_empty() => "—".into(),
                Some(x) => esc(&js::to_js_string(x)),
            }
        };
        let numv = |x: Option<&Value>| -> Option<String> {
            match x {
                None | Some(Value::Null) => None,
                Some(x) => Some(esc(&int_n(crate::transcript::number(Some(x))))),
            }
        };
        let fields = [
            field("モード / エージェント", &v(s.get("mode")), &v(s.get("agent"))),
            field("モデル / 推論強度", &v(s.get("model")), &v(s.get("reasoning_effort"))),
            field("文脈の層 / 現在のトークン", &v(s.get("context_tier")), &numv(s.get("context_current_tokens")).unwrap_or_default()),
            field("権限 / 自動承認 / sandbox", &v(s.get("permission_mode")), &format!("自動承認 {}・sandbox {}", v(s.get("auto_approve")), v(s.get("sandbox_enabled")))),
            field("入力 / 出力トークン(アプリの累計)", &numv(s.get("total_input_tokens")).unwrap_or_else(|| "—".into()), &numv(s.get("total_output_tokens")).map(|x| format!("出力 {x}")).unwrap_or_default()),
            field("fork 元", &v(s.get("forked_from_session_id")), ""),
            field("workspace / ブランチ", &if anon.enabled { "(伏せ字)".into() } else { v(w.get("name")) }, &if anon.enabled { String::new() } else { v(w.get("branch")) }),
            field("コミット(checkpoints)/ 文脈の計測点", &int_i(dk.checkpoints.len() as i64), &format!("文脈 {} 点・activity {}", int_i(dk.context_usage.len() as i64), int_i(dk.activity.len() as i64))),
        ]
        .join("");
        parts.push(sec.section(
            "デスクトップアプリの記録(data.db)",
            &format!("<div class=\"fields\" style=\"--cols:4\">{fields}</div>"),
            "デスクトップアプリ(data.db)から許可リストの列だけを読んだもの。資格情報の列と表は開いていません。-wal の未反映分は読めないので、最近の更新は欠けることがあります。",
        ));
    }

    let w = &r.wiki;
    let wiki_used = w.index_reads + w.page_reads.len() as i64 + w.skill_calls.len() as i64 + w.writes + w.other_calls > 0;
    // 同じページを何度も読むことがあるので、1 行にまとめて ×N を添える(読んだ順)
    let mut page_counts: indexmap::IndexMap<&str, i64> = indexmap::IndexMap::new();
    for p in &w.page_reads {
        *page_counts.entry(p.as_str()).or_insert(0) += 1;
    }
    let pages = if !anon.enabled && !page_counts.is_empty() {
        format!("<ul class=\"note\">{}</ul>", page_counts.iter().map(|(p, c)| format!("<li>{}{}</li>", esc(p), if *c > 1 { format!(" <span class=\"tag\">×{}</span>", int_i(*c)) } else { String::new() })).collect::<String>())
    } else {
        String::new()
    };
    parts.push(sec.section(
        "llm-wiki の参照",
        &if wiki_used {
            format!(
                "<div class=\"fields\" style=\"--cols:5\">{}</div>{pages}",
                [
                    field("索引", &int_i(w.index_reads), ""),
                    field("個別ページ", &int_i(w.page_reads.len() as i64), &if page_counts.len() != w.page_reads.len() { format!("{} ページ", int_i(page_counts.len() as i64)) } else { String::new() }),
                    field("wiki skill", &int_i(w.skill_calls.len() as i64), &esc(&w.skill_calls.join("、"))),
                    field("書き込み", &int_i(w.writes), ""),
                    field("その他", &int_i(w.other_calls), ""),
                ]
                .join("")
            )
        } else {
            "<p class=\"note\">llm-wiki の参照はありません。</p>".into()
        },
        "",
    ));

    let judged = o.verdicts.is_some_and(|v| !v.is_empty());
    let turns = turn_table(r, anon, o.verdicts);
    parts.push(sec.section("依頼ごとの経過", &turns, &turn_lead(r, judged)));

    let f = &r.friction;
    parts.push(sec.section(
        "摩擦",
        &format!(
            "<div class=\"fields\" style=\"--cols:3\">{}</div>",
            [
                field("compaction", &int_i(f.compactions), ""),
                field("中断(abort)", &int_i(f.aborts), ""),
                field("エラー", &int_i(f.errors), "session.error(ツール失敗・サブエージェントの失敗は別)"),
                field("権限の確認", &int_i(f.permission_requests), ""),
                field("ask_user", &int_i(f.ask_user), ""),
                field("ツール失敗", &int_i(f.tool_failures), ""),
                field("agent 失敗", &int_i(f.subagent_failures), ""),
                field(
                    "モデル変更",
                    &int_i(f.model_changes),
                    &format!(
                        "摩擦の合計には含めない{}",
                        match r.friction_detail.agent_model_changes {
                            Some(n) if n != 0 => format!("。サブエージェントの起動に伴う切り替え {} 回は含めない", int_i(n)),
                            _ => String::new(),
                        }
                    ),
                ),
                field("モード変更", &int_i(f.mode_changes), "摩擦の合計には含めない"),
            ]
            .join("")
        ),
        "",
    ));

    let files = &r.files;
    let file_list = |xs: &[String]| -> String {
        if anon.enabled {
            format!("<p class=\"note\">{} 件(伏せ字モードのためパスは表示しません)</p>", int_i(xs.len() as i64))
        } else if xs.is_empty() {
            "<p class=\"note\">なし</p>".into()
        } else {
            format!("<ul class=\"note\">{}</ul>", xs.iter().map(|p| format!("<li>{}</li>", esc(p))).collect::<String>())
        }
    };
    parts.push(sec.section(
        "変更したファイル",
        &format!(
            "<div class=\"three\"><div><h3>変更 {} 件</h3>{}</div><div><h3>作成 {} 件</h3>{}</div><div><h3>削除 {} 件</h3>{}</div></div>{}",
            int_i(files.changed.len() as i64),
            file_list(&files.changed),
            int_i(files.created.len() as i64),
            file_list(&files.created),
            int_i(files.deleted.len() as i64),
            file_list(&files.deleted),
            if files.session_state != 0 { format!("<p class=\"note\">Copilot のセッション用ファイル(~/.copilot/session-state/ 配下の plan.md など){} 件は一覧から外しています。</p>", int_i(files.session_state)) } else { String::new() }
        ),
        "パスは作業フォルダ基準の絶対パスにそろえ、同じファイルは 1 回だけ載せています(Windows は大文字小文字を区別しない)",
    ));

    parts.push(sec.section(
        "時系列",
        &if r.timeline.is_empty() {
            "<p class=\"note\">イベントログ(events.jsonl)が無いため時系列はありません。</p>".into()
        } else {
            format!("<div class=\"table-scroll\"><table class=\"ledger\"><thead><tr><th scope=\"col\">時刻</th><th scope=\"col\">種類</th><th scope=\"col\">内容</th></tr></thead><tbody>{}</tbody></table></div>", r.timeline.iter().map(|e| timeline_row(e, anon)).collect::<String>())
        },
        "依頼の区切り・ツール群・エージェント・文脈圧縮などを粗くまとめたもの",
    ));

    let unknown = r.unknown_event_types.js_entries();
    parts.push(sec.section(
        "ログの状態",
        &format!(
            "<p class=\"note\">イベント {} 件、読めなかった行 {} 行。{}</p>",
            int_i(r.events.total),
            int_i(r.events.bad_lines),
            if unknown.is_empty() { "未知のイベント種別はありません。".to_string() } else { format!("未知のイベント種別: {}", esc(&unknown.iter().map(|(k, v)| format!("{k} ×{v}")).collect::<Vec<_>>().join("、"))) }
        ),
        "",
    ));

    // 目次の帯(768px 以上はサイドバー、未満は上部の固定行)。節は parts を描いた後に揃う
    let mut links: Vec<NavLink> = Vec::new();
    if let Some(h) = o.transcript_href {
        links.push(NavLink { href: h.into(), label: "記録の .md をそのまま開く".into(), download: false, new_window: true });
        links.push(NavLink { href: h.into(), label: "記録を .md で保存".into(), download: true, new_window: false });
    }
    if let Some(h) = o.full_href {
        links.push(NavLink { href: h.into(), label: "全文記録(解析用)を開く".into(), download: false, new_window: true });
    }
    if let Some(l) = &lib_session {
        links.push(NavLink::new(l.clone(), "このセッションの指示文と skill"));
    }
    links.push(NavLink::new("../glossary.html", "用語の説明"));
    let nav = PageNavOptions {
        crumb_href: "../atlas.html".into(),
        crumb_label: "← レポート(セッション一覧)に戻る".into(),
        toc_label: "ページ内の移動".into(),
        groups: vec![NavGroup { title: None, items: sec.index.iter().map(|(id, title)| NavItem { href: format!("#{id}"), label: title.clone(), ..Default::default() }).collect() }],
        links,
    };
    let style = format!("{}{DETAIL_CSS}{}", o.css, if o.memo.is_some() && !anon.enabled { MEMO_CSS } else { "" });
    let page_title = format!("{} | Copilot Session Atlas", esc(&truncate(Some(&title), 60)));
    let mut out = page_head(o.code, &page_title, &style);
    out.push_str(&format!(
        "<body>\n{}\n<div class=\"shell\">\n{}\n<div class=\"content\">\n<main class=\"wrap\">\n<div class=\"title\"><h1>{}</h1><div class=\"meta\">{meta}</div></div>\n{}\n</main>\n<footer class=\"wrap page-foot\">Copilot Session Atlas が {} に生成。{}</footer>\n</div>\n</div>\n<script>{NAV_JS}</script>\n</body>\n</html>\n",
        render_top(&nav),
        render_rail(&nav),
        esc(&title),
        parts.join("\n"),
        esc(&date_time_n(Some(o.generated_at))),
        if anon.enabled { "伏せ字モード(プロジェクト・パス・ブランチ・本文を伏せています)。" } else { "" }
    ));
    out
}
