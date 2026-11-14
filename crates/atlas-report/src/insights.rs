//! Phase 12: 改善点の分析(LLM を呼ばない規則の集計)。packages/report/src/lib/insights.ts の移植。
//! - 指示文の版・skill・時間の使われ方は SessionSummary から求める(ブラウザ側は同じ規則を TS で再計算する)
//! - スキル化の候補は依頼文とターンごとのツールの列(sessions.json の analysis)から build 時に求め、結果だけ埋め込む
//! - 分かるのは相関まで。閾値は定数にして docs/PLAN.md に根拠を書く

use crate::exec::{num_cmp, sort_nums};
use crate::types::SessionSummary;
use atlas_core::collate::locale_compare;
use atlas_core::js::{self, JsMap};
use atlas_core::project_keys::ATLAS_JUDGE_PROJECT;
use atlas_core::turns::js_re;
use atlas_core::types::{SessionAnalysis, SessionRecord};
use indexmap::{IndexMap, IndexSet};
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// 閾値(insights.ts の THRESHOLDS)
pub mod thresholds {
    /// 率を出す最小のセッション数
    pub const MIN_SESSIONS: usize = 5;
    /// 候補の最小の繰り返し
    pub const MIN_REPEAT: usize = 3;
    /// 依頼文の 3-gram の Jaccard 類似度
    pub const SIMILARITY: f64 = 0.6;
    /// 版の前後で「悪化」とみなす差(ポイント)
    pub const WORSE_POINTS: f64 = 10.0;
    /// 「長いのに注入が少ない」: 注入セッション数がこれ未満
    pub const RARE_SESSIONS: i64 = 3;
    /// 止まっている箇所
    pub const STUCK_TTFT_MS: f64 = 20_000.0;
    pub const STUCK_CONSECUTIVE_FAILURES: i64 = 3;
    pub const STUCK_EXTRA_EDITS: i64 = 3;
    pub const STUCK_PERMISSIONS: i64 = 10;
    pub const STUCK_COMPACTIONS: i64 = 3;
    /// 依頼文の正規化後の最小の長さ
    pub const MIN_REQUEST_CHARS: usize = 20;
    /// ツールの並びの長さ
    pub const SEQ_MIN: usize = 3;
    pub const SEQ_MAX: usize = 6;
    /// 並びに含まれる閲覧以外のツールの種類の下限
    pub const SEQ_MIN_WORK: usize = 2;
}
use thresholds as T;

/// 中央値(偶数個なら中の 2 つの平均を丸める)。空なら None
pub fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let s = sort_nums(xs);
    let m = s.len() / 2;
    Some(if s.len() % 2 == 1 { s[m] } else { js::round((s[m - 1] + s[m]) / 2.0) })
}

fn rate(num: f64, den: f64) -> Option<f64> {
    if den > 0.0 { Some(num / den) } else { None }
}

/// セッションのツール失敗(失敗 + 拒否)と呼び出し数
pub fn failures(s: &SessionSummary) -> (i64, i64) {
    let failed = s.tools.issues.js_entries().iter().fold(0, |a, (_, v)| a + v[0] + v[1]);
    (failed, s.tools.total)
}

/// 同じファイルを 2 回以上編集したセッションか
pub fn has_rework(s: &SessionSummary) -> bool {
    s.analysis.files_reedited > 0
}

// ---------- 指示文の版 ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionStat {
    pub hash: String,
    pub chars: i64,
    pub sessions: i64,
    pub injections_per_session: f64,
    pub failure_rate: Option<f64>,
    pub rework_rate: f64,
    pub compactions_per_session: f64,
    pub output_per_session: f64,
    pub enough: bool,
}

pub fn instruction_versions(sessions: &[&SessionSummary]) -> Vec<VersionStat> {
    struct V {
        chars: i64,
        ids: HashSet<String>,
        injections: i64,
        failed: i64,
        calls: i64,
        rework: i64,
        compactions: i64,
        output: f64,
    }
    let mut by: IndexMap<String, V> = IndexMap::new();
    for s in sessions {
        let (failed, calls) = failures(s);
        for (hash, chars, injections) in &s.instruction_versions {
            let v = by.entry(hash.clone()).or_insert_with(|| V { chars: *chars, ids: HashSet::new(), injections: 0, failed: 0, calls: 0, rework: 0, compactions: 0, output: 0.0 });
            if !v.ids.insert(s.id.clone()) {
                continue;
            }
            v.injections += injections;
            v.failed += failed;
            v.calls += calls;
            if has_rework(s) {
                v.rework += 1;
            }
            v.compactions += s.friction.compactions;
            v.output += s.tokens.output;
        }
    }
    let mut out: Vec<VersionStat> = by
        .into_iter()
        .map(|(hash, v)| {
            let n = v.ids.len() as f64;
            VersionStat {
                hash,
                chars: v.chars,
                sessions: v.ids.len() as i64,
                injections_per_session: v.injections as f64 / n,
                failure_rate: rate(v.failed as f64, v.calls as f64),
                rework_rate: v.rework as f64 / n,
                compactions_per_session: v.compactions as f64 / n,
                output_per_session: v.output / n,
                enough: v.ids.len() >= T::MIN_SESSIONS,
            }
        })
        .collect();
    out.sort_by(|a, b| b.sessions.cmp(&a.sessions).then(b.chars.cmp(&a.chars)));
    out
}

static HEAD_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^#+\s*")).unwrap());
static HEAD_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^<!--\s*|\s*-->$")).unwrap());
static MD_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap());
static MD_LINK_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*$").unwrap());

/// 指示文の見出しの表示名: 先頭の # や HTML コメントの印を外し、Markdown のリンクは文言だけにし、長ければ省略記号を付ける。
/// max は UTF-16 の単位の数(None は上限なし)
pub fn clean_heading(h: &str, max: Option<usize>) -> String {
    let a = HEAD_HASH.replace(h, "");
    let b = HEAD_COMMENT.replace_all(&a, "");
    let raw = js::trim(&b);
    // 見出しは記録の時点で 80 字に切られている。切られたものには省略記号を付ける(既に付いていれば足さない)
    let cut = (js::utf16_len(js::trim(h)) >= 80 || js::utf16_len(raw) >= 79) && !raw.ends_with('…');
    let c = MD_LINK.replace_all(raw, "${1}");
    let mut t = MD_LINK_TAIL.replace(&c, "${1}").into_owned();
    if cut {
        t.push('…');
    }
    match max {
        Some(max) if js::utf16_len(&t) > max => format!("{}…", js::utf16_slice(&t, 0, max.saturating_sub(1))),
        _ => t,
    }
}

/// 版の系列(1 つの項目にまとめる指示文)の鍵。整えた見出しだけで決める
pub fn series_key(heading: &str, file: &str) -> String {
    let k = clean_heading(heading, None);
    if k.is_empty() { format!("(見出しなし: {file})") } else { k }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub heading: String,
    pub file: String,
    /// 系列の識別子(伏せ字版でも見出しを漏らさない不透明な値)
    pub series: String,
    /// 同じ系列の中での順(初回の利用日の順)
    pub order: i64,
    pub first_at: Option<String>,
    /// その版を最後に読み込んだ日時。古いデータには無い(外の None)
    #[serde(default, skip_serializing_if = "Option::is_none", with = "atlas_core::js::double_option")]
    pub last_at: Option<Option<String>>,
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|x| !x.is_empty())
}

/// 改善点の版の情報(build.ts の insightMeta を作るところ)。系列は指示文のページと同じ鍵で束ね、同じ「版 N」になるようにする
pub fn insight_meta(records: &[&SessionRecord], anonymized: bool) -> JsMap<VersionMeta> {
    struct Item {
        hash: String,
        heading: String,
        file: &'static str,
        first_at: Option<String>,
        last_at: Option<String>,
    }
    let mut by_heading: IndexMap<String, Vec<Item>> = IndexMap::new();
    for r in records {
        for i in &r.instructions {
            let key = series_key(&i.heading, i.file.as_str());
            let list = by_heading.entry(key).or_default();
            if let Some(cur) = list.iter_mut().find(|x| x.hash == i.content_hash) {
                let f = i.first_seen_at.clone();
                cur.first_at = match (truthy(&cur.first_at), truthy(&f)) {
                    (Some(a), Some(b)) => Some(if js::cmp_utf16(a, b) == Ordering::Less { a } else { b }.to_string()),
                    _ => cur.first_at.clone().or(f.clone()),
                };
                // firstSeenAt はセッションごとの初回の注入。その最大が「最後にこの版を読み込んだ」日時
                cur.last_at = match (truthy(&cur.last_at), truthy(&f)) {
                    (Some(a), Some(b)) => Some(if js::cmp_utf16(a, b) == Ordering::Greater { a } else { b }.to_string()),
                    _ => cur.last_at.clone().or(f),
                };
            } else {
                list.push(Item { hash: i.content_hash.clone(), heading: i.heading.clone(), file: i.file.as_str(), first_at: i.first_seen_at.clone(), last_at: i.first_seen_at.clone() });
            }
        }
    }
    let mut meta: JsMap<VersionMeta> = JsMap::new();
    for (n, list) in by_heading.values_mut().enumerate() {
        let series = format!("s{n}");
        list.sort_by(|a, b| locale_compare(a.first_at.as_deref().unwrap_or(""), b.first_at.as_deref().unwrap_or("")).then_with(|| locale_compare(&a.hash, &b.hash)));
        for (order, v) in list.iter().enumerate() {
            meta.insert(
                v.hash.clone(),
                VersionMeta {
                    heading: if anonymized { String::new() } else { v.heading.clone() },
                    file: v.file.to_string(),
                    series: series.clone(),
                    order: order as i64,
                    first_at: v.first_at.clone(),
                    last_at: Some(v.last_at.clone()),
                },
            );
        }
    }
    meta
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worsened {
    pub heading: String,
    pub before: VersionStat,
    pub after: VersionStat,
    pub failure_delta: Option<f64>,
    pub rework_delta: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFindings {
    /// 長いのに注入されたセッションが少ない版
    pub long_rare: Vec<VersionStat>,
    /// 版を変えた前後で悪化(失敗率か手戻り率が WORSE_POINTS 以上上がった)
    pub worsened: Vec<Worsened>,
    /// 前後比較ができなかった組(どちらかが MIN_SESSIONS 未満)の数
    pub compared_insufficient: i64,
    /// 前後比較を判定できた組の数
    pub compared: i64,
    /// 長いのに注入が少ないとみなした字数(全版の上位 25% の下限)
    pub long_chars: i64,
}

/// total_sessions は stats の集計元のセッション数。MIN_SESSIONS 未満では longRare を出さない
pub fn instruction_findings(stats: &[VersionStat], meta: &JsMap<VersionMeta>, total_sessions: usize) -> InstructionFindings {
    let mut chars: Vec<i64> = stats.iter().map(|v| v.chars).collect();
    chars.sort();
    let q75 = if chars.is_empty() { 0 } else { chars[(chars.len() - 1).min((chars.len() as f64 * 0.75).floor() as usize)] };
    // 系列ごとに今の版だけ挙げる。今の版は最後に読み込まれた版。lastAt が無い古いデータは order で決める
    let newer = |a: Option<&VersionMeta>, b: Option<&VersionMeta>| -> bool {
        let la = a.and_then(|m| m.last_at.clone().flatten());
        let lb = b.and_then(|m| m.last_at.clone().flatten());
        match (la, lb) {
            (Some(x), Some(y)) if x != y => js::cmp_utf16(&x, &y) == Ordering::Greater,
            _ => a.map_or(0, |m| m.order) > b.map_or(0, |m| m.order),
        }
    };
    let mut latest: IndexMap<String, &VersionStat> = IndexMap::new();
    for v in stats {
        let m = meta.get(&v.hash);
        let k = m.map_or_else(|| v.hash.clone(), |m| m.series.clone());
        match latest.get(&k) {
            Some(cur) if !newer(m, meta.get(&cur.hash)) => {}
            _ => {
                latest.insert(k, v);
            }
        }
    }
    let mut long_rare: Vec<VersionStat> = latest
        .values()
        .filter(|v| total_sessions >= T::MIN_SESSIONS && chars.len() >= 4 && v.chars >= q75 && v.chars > 0 && v.sessions < T::RARE_SESSIONS)
        .map(|v| (*v).clone())
        .collect();
    long_rare.sort_by_key(|v| std::cmp::Reverse(v.chars));
    let mut by_heading: IndexMap<String, Vec<&VersionStat>> = IndexMap::new();
    for v in stats {
        if let Some(m) = meta.get(&v.hash) {
            by_heading.entry(m.series.clone()).or_default().push(v);
        }
    }
    let mut worsened = Vec::new();
    let (mut insufficient, mut compared) = (0, 0);
    for vs in by_heading.values_mut() {
        if vs.len() < 2 {
            continue;
        }
        vs.sort_by_key(|v| meta[&v.hash].order);
        for i in 1..vs.len() {
            let (before, after) = (vs[i - 1], vs[i]);
            if !before.enough || !after.enough {
                insufficient += 1;
                continue;
            }
            compared += 1;
            let failure_delta = match (before.failure_rate, after.failure_rate) {
                (Some(b), Some(a)) => Some((a - b) * 100.0),
                _ => None,
            };
            let rework_delta = (after.rework_rate - before.rework_rate) * 100.0;
            if failure_delta.is_some_and(|d| d >= T::WORSE_POINTS) || rework_delta >= T::WORSE_POINTS {
                worsened.push(Worsened { heading: meta[&after.hash].heading.clone(), before: before.clone(), after: after.clone(), failure_delta, rework_delta });
            }
        }
    }
    InstructionFindings { long_rare, worsened, compared_insufficient: insufficient, compared, long_chars: q75 }
}

// ---------- skill ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStat {
    pub name: String,
    pub calls: i64,
    pub by_user: i64,
    pub by_agent: i64,
    pub chars: Option<f64>,
    pub sessions: i64,
    /// 呼んだセッションの失敗率 / 呼ばなかったセッションの失敗率(MIN_SESSIONS 未満なら None)
    pub failure_with: Option<f64>,
    pub failure_without: Option<f64>,
    pub output_per_session: f64,
    pub enough: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillStats {
    pub stats: Vec<SkillStat>,
    pub unused: Vec<String>,
}

pub fn skill_stats(sessions: &[&SessionSummary], installed: Option<&[String]>) -> SkillStats {
    let mut names: IndexSet<&str> = IndexSet::new();
    for s in sessions {
        for n in s.skills.js_keys() {
            names.insert(n);
        }
    }
    let f = |xs: &[&&SessionSummary]| -> Option<f64> {
        if xs.len() < T::MIN_SESSIONS {
            return None;
        }
        let (failed, calls) = xs.iter().fold((0, 0), |a, s| {
            let x = failures(s);
            (a.0 + x.0, a.1 + x.1)
        });
        rate(failed as f64, calls as f64)
    };
    let mut stats: Vec<SkillStat> = Vec::new();
    for name in &names {
        let (with_s, without): (Vec<&&SessionSummary>, Vec<&&SessionSummary>) = sessions.iter().partition(|s| s.skills.contains_key(*name));
        let (mut calls, mut by_user, mut by_agent) = (0, 0, 0);
        let mut chars: Option<f64> = None;
        for s in &with_s {
            let t = s.skills[*name];
            calls += t[0] + t[1] + t[2];
            by_user += t[0];
            by_agent += t[1];
            if let Some(c) = s.skill_chars.get(*name).copied().flatten() {
                chars = Some(chars.unwrap_or(0.0).max(c));
            }
        }
        let out_sum = with_s.iter().fold(0.0, |a, s| a + s.tokens.output);
        stats.push(SkillStat {
            name: name.to_string(),
            calls,
            by_user,
            by_agent,
            chars,
            sessions: with_s.len() as i64,
            failure_with: f(&with_s),
            failure_without: f(&without),
            output_per_session: if with_s.is_empty() { 0.0 } else { out_sum / with_s.len() as f64 },
            enough: with_s.len() >= T::MIN_SESSIONS,
        });
    }
    stats.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| locale_compare(&a.name, &b.name)));
    let mut unused: Vec<String> = installed.map(|i| i.iter().filter(|n| !names.contains(n.as_str())).cloned().collect()).unwrap_or_default();
    unused.sort_by(|a, b| js::cmp_utf16(a, b));
    SkillStats { stats, unused }
}

// ---------- 時間の使われ方 ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckSession {
    pub id: String,
    pub href: String,
    pub project: String,
    pub project_label: String,
    pub ttft_median: Option<f64>,
    pub duration_median: Option<f64>,
    pub consecutive_failures: i64,
    pub extra_edits: i64,
    pub permissions: i64,
    pub compactions: i64,
    /// 閾値を超えた理由(無ければ止まっていない)
    pub reasons: Vec<&'static str>,
}

pub fn latency_medians(s: &SessionSummary) -> (Option<f64>, Option<f64>) {
    let mut ttft = Vec::new();
    let mut dur = Vec::new();
    for (_, (t, d)) in s.exec.latency.js_entries() {
        ttft.extend_from_slice(t);
        dur.extend_from_slice(d);
    }
    (median(&ttft), median(&dur))
}

pub fn stuck_sessions(sessions: &[&SessionSummary]) -> Vec<StuckSession> {
    let mut out: Vec<StuckSession> = Vec::new();
    for s in sessions {
        let (ttft, duration) = latency_medians(s);
        let mut reasons = Vec::new();
        if ttft.is_some_and(|x| x >= T::STUCK_TTFT_MS) {
            reasons.push("待ち時間");
        }
        if s.analysis.max_consecutive_failures >= T::STUCK_CONSECUTIVE_FAILURES {
            reasons.push("失敗の連続");
        }
        // extraEdits は全ファイルの「同じファイルの 2 回目以降の編集」の合計
        if s.analysis.extra_edits >= T::STUCK_EXTRA_EDITS {
            reasons.push("余分な編集の多さ");
        }
        if s.friction.permission_requests >= T::STUCK_PERMISSIONS {
            reasons.push("権限確認の多さ");
        }
        if s.friction.compactions >= T::STUCK_COMPACTIONS {
            reasons.push("compaction");
        }
        out.push(StuckSession {
            id: s.id.clone(),
            href: s.href.clone(),
            project: s.project.clone(),
            project_label: s.project_label.clone(),
            ttft_median: ttft,
            duration_median: duration,
            consecutive_failures: s.analysis.max_consecutive_failures,
            extra_edits: s.analysis.extra_edits,
            permissions: s.friction.permission_requests,
            compactions: s.friction.compactions,
            reasons,
        });
    }
    // 理由の数の多い順。同数なら閾値に効いた量の大きい順
    out.retain(|x| !x.reasons.is_empty());
    out.sort_by(|a, b| {
        b.reasons
            .len()
            .cmp(&a.reasons.len())
            .then(b.extra_edits.cmp(&a.extra_edits))
            .then(b.consecutive_failures.cmp(&a.consecutive_failures))
            .then(num_cmp(b.ttft_median.unwrap_or(0.0), a.ttft_median.unwrap_or(0.0)))
    });
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckProject {
    pub project: String,
    pub project_label: String,
    pub stuck: i64,
    pub total: i64,
    pub reasons: JsMap<i64>,
}

pub fn stuck_by_project(stuck: &[StuckSession], sessions: &[&SessionSummary]) -> Vec<StuckProject> {
    let mut total: HashMap<&str, (&str, i64)> = HashMap::new();
    for s in sessions {
        total.entry(&s.project).or_insert((&s.project_label, 0)).1 += 1;
    }
    let mut by: IndexMap<&str, (i64, JsMap<i64>)> = IndexMap::new();
    for x in stuck {
        let b = by.entry(&x.project).or_insert_with(|| (0, JsMap::new()));
        b.0 += 1;
        for r in &x.reasons {
            b.1.inc(r, 1);
        }
    }
    // 総数が MIN_SESSIONS 未満のプロジェクトは出さない
    let mut out: Vec<StuckProject> = by
        .into_iter()
        .map(|(project, (stuck, reasons))| {
            let t = total.get(project);
            StuckProject { project: project.into(), project_label: t.map_or(project, |t| t.0).to_string(), stuck, total: t.map_or(0, |t| t.1), reasons }
        })
        .filter(|p| p.total >= T::MIN_SESSIONS as i64)
        .collect();
    out.sort_by(|a, b| b.stuck.cmp(&a.stuck).then(num_cmp(b.stuck as f64 / b.total.max(1) as f64, a.stuck as f64 / a.total.max(1) as f64)));
    out
}

// ---------- スキル化の候補(build 時) ----------

static NR_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"https?:\/\/\S+")).unwrap());
static NR_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r#"(?:[a-z]:[\\/]|\\\\)[^\s"'<>|]*|(?:^|[\s(])(?:\/[\w.-]+){2,}"#)).unwrap());
static NR_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"\b[0-9a-f]{8,}\b")).unwrap());
static NR_NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+").unwrap());
static NR_SYMBOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^\p{{L}}\p{{N}}<>{}]", &js::RE_S[1..js::RE_S.len() - 1])).unwrap());
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// 依頼文の正規化: 小文字、URL・パス・数字・16 進 id を印に、記号を落とし、空白を詰める
pub fn normalize_request(text: &str) -> String {
    let t = js::to_lower(text);
    let t = NR_URL.replace_all(&t, " <url> ");
    let t = NR_PATH.replace_all(&t, " <path> ");
    let t = NR_ID.replace_all(&t, " <id> ");
    let t = NR_NUM.replace_all(&t, " <n> ");
    let t = NR_SYMBOL.replace_all(&t, " ");
    let t = WS_RUN.replace_all(&t, " ");
    js::trim(&t).to_string()
}

/// 3 文字(UTF-16 の単位)の組の集合。3 つの単位を 1 つの数にまとめ、昇順に重複なく持つ(共通部分を併合で数えるため)
pub type Trigrams = Vec<u64>;

/// u64 の鍵の速いハッシュ(3 文字の組の索引用。鍵は外から来る値ではないので衝突攻撃を気にしなくてよい)
#[derive(Default, Clone, Copy)]
pub struct U64Hasher(u64);

impl std::hash::Hasher for U64Hasher {
    fn finish(&self) -> u64 {
        // splitmix64 の仕上げ
        let mut z = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 << 8) ^ *b as u64;
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = n;
    }
}

type U64Build = std::hash::BuildHasherDefault<U64Hasher>;

fn utf16_units(s: &str) -> Vec<u16> {
    let mut v = Vec::with_capacity(s.len());
    for c in s.chars() {
        if let Some(u) = js::lone_surrogate_unit(c) {
            v.push(u);
        } else {
            let mut buf = [0u16; 2];
            v.extend_from_slice(c.encode_utf16(&mut buf));
        }
    }
    v
}

pub fn trigrams(s: &str) -> Trigrams {
    let t = WS_RUN.replace_all(s, " ");
    let u = utf16_units(&t);
    let mut v: Vec<u64> = u.windows(3).map(|w| ((w[0] as u64) << 32) | ((w[1] as u64) << 16) | w[2] as u64).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// 共通する組の数(どちらも昇順で重複なし)
fn intersection(a: &[u64], b: &[u64]) -> usize {
    let (mut i, mut j, mut n) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            Ordering::Less => i += 1,
            Ordering::Greater => j += 1,
            Ordering::Equal => {
                n += 1;
                i += 1;
                j += 1;
            }
        }
    }
    n
}

pub fn jaccard(a: &Trigrams, b: &Trigrams) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let inter = intersection(a, b);
    inter as f64 / (a.len() + b.len() - inter) as f64
}

/// 定型の相づち・コマンドなど、スキル化の対象にしない依頼文(TRIVIAL_REQUEST。/i は英字だけなので小文字にしてから比べる)
static TRIVIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&js_re(r"^(?:ok|okay|yes|no|y|n|reply ok|続けて|続行|はい|いいえ|次へ|go on|continue|done|thanks|ありがとう|了解|承知|\/\w+)\s*$")).unwrap()
});
/// 動作確認の定型文(PROBE_REQUEST)
static PROBE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^(?:reply with|respond with|say (?:ok|hello)|answer with)(?:\s|$)")).unwrap());

/// `TRIVIAL_REQUEST.test(s)`
pub fn is_trivial_request(s: &str) -> bool {
    TRIVIAL.is_match(&s.to_ascii_lowercase())
}

/// `PROBE_REQUEST.test(s)`
pub fn is_probe_request(s: &str) -> bool {
    PROBE.is_match(&s.to_ascii_lowercase())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// request / tools
    pub kind: &'static str,
    /// 並びの場合はツール名を → で繋いだもの。依頼文の場合は代表文の正規化形
    pub key: String,
    pub count: i64,
    pub sessions: Vec<String>,
    /// 1 回あたりの実働の中央値(ms)
    pub median_ms: Option<f64>,
    /// 回数 × 実働の中央値(分)
    pub score: f64,
    /// 代表の依頼文。伏せ字版では None
    pub representative: Option<String>,
    /// 代表以外の例(最大 3)。伏せ字版では空
    pub examples: Vec<String>,
    /// 並びの場合のツール名
    pub tools: Option<Vec<String>>,
}

/// 候補の元(セッションの id・プロジェクトと、依頼文・ターンごとのツール・実働)
#[derive(Debug, Clone, Copy)]
pub struct CandidateSource<'a> {
    pub id: &'a str,
    pub project: &'a str,
    pub analysis: &'a SessionAnalysis,
}

/// スコアに使う実働の上限(2 時間)
pub const SCORE_MS_CAP: f64 = 2.0 * 3_600_000.0;

fn score_of(count: usize, median_ms: Option<f64>) -> f64 {
    count as f64 * median_ms.map_or(1.0, |m| 1f64.max(m.min(SCORE_MS_CAP) / 60_000.0))
}

/// 閲覧だけのツール
pub const EXPLORE_TOOLS: [&str; 9] = ["view", "rg", "grep", "glob", "ls", "read", "read_file", "list_dir", "find"];

/// 周期 1〜max_period の繰り返し(a → b → a → b)は往復の探索なので並びとして数えない
pub fn is_periodic(seq: &[&str], max_period: usize) -> bool {
    (1..=max_period).any(|p| seq.len() > p && (p..seq.len()).all(|i| seq[i] == seq[i - p]))
}

/// 連続する同じツールを 1 つに潰す
pub fn collapse_runs(tools: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for t in tools {
        if out.last() != Some(&t.as_str()) {
            out.push(t);
        }
    }
    out
}

fn active_ms(a: &SessionAnalysis, i: usize) -> Option<f64> {
    a.turn_active_ms.get(i).copied().flatten()
}

fn uniq<'a>(it: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    it.into_iter().filter(|x| seen.insert(*x)).map(str::to_string).collect()
}

pub fn request_candidates(sources: &[CandidateSource<'_>], anonymized: bool) -> Vec<Candidate> {
    struct Item<'a> {
        id: &'a str,
        text: &'a str,
        norm: String,
        grams: Trigrams,
        ms: Option<f64>,
    }
    // 正規化と 3 文字の組はセッションごとに並列に求める(並びは元のまま)
    let items: Vec<Item> = sources
        .par_iter()
        .flat_map_iter(|s| {
            s.analysis.requests.iter().enumerate().filter_map(move |(i, text)| {
                let tr = js::trim(text);
                if text.is_empty() || is_trivial_request(tr) || is_probe_request(tr) {
                    return None;
                }
                let norm = normalize_request(text);
                if js::utf16_len(&norm) < T::MIN_REQUEST_CHARS {
                    return None;
                }
                let grams = trigrams(&norm);
                Some(Item { id: s.id, text, norm, grams, ms: active_ms(s.analysis, i) })
            })
        })
        .collect();
    // 先に作ったまとまりから順に、代表との類似度がしきい値以上の最初のまとまりに入れる。
    // 代表の 3 文字の組がどのまとまりにあるかの索引を持ち、共通する組の数を数えて類似度を出す(jaccard と同じ式)
    let mut reps: Vec<usize> = Vec::new();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut by_gram: HashMap<u64, Vec<u32>, U64Build> = HashMap::default();
    // まとまりごとの共通する組の数(触ったまとまりだけを覚えて戻す)
    let mut shared: Vec<u32> = Vec::new();
    let mut touched: Vec<u32> = Vec::new();
    for (ii, it) in items.iter().enumerate() {
        let mut found: Option<usize> = None;
        if it.grams.is_empty() {
            found = reps.iter().position(|&r| jaccard(&items[r].grams, &it.grams) >= T::SIMILARITY);
        } else {
            for g in &it.grams {
                if let Some(cs) = by_gram.get(g) {
                    for &ci in cs {
                        let c = &mut shared[ci as usize];
                        if *c == 0 {
                            touched.push(ci);
                        }
                        *c += 1;
                    }
                }
            }
            // 類似度がしきい値以上のまとまりのうち、いちばん先に作ったもの
            for &ci in &touched {
                let ci = ci as usize;
                let inter = std::mem::take(&mut shared[ci]) as usize;
                if found.is_some_and(|f| ci > f) {
                    continue;
                }
                let rep = &items[reps[ci]].grams;
                if inter as f64 / (rep.len() + it.grams.len() - inter) as f64 >= T::SIMILARITY {
                    found = Some(ci);
                }
            }
            touched.clear();
        }
        match found {
            Some(ci) => members[ci].push(ii),
            None => {
                let ci = reps.len();
                reps.push(ii);
                members.push(vec![ii]);
                shared.push(0);
                for g in &it.grams {
                    by_gram.entry(*g).or_default().push(ci as u32);
                }
            }
        }
    }
    // 代表は他の全員との類似度の和が最大のもの(和は TS と同じ順に足す)
    let picked: Vec<Option<(usize, Vec<String>)>> = members
        .par_iter()
        .map(|ms| {
            let sessions = uniq(ms.iter().map(|&m| items[m].id));
            if ms.len() < T::MIN_REPEAT || sessions.len() < 2 {
                return None;
            }
            let mut best = ms[0];
            let mut best_s = f64::NEG_INFINITY;
            for &m in ms {
                let s = ms.iter().fold(0.0, |a, &o| a + jaccard(&items[m].grams, &items[o].grams));
                if s > best_s {
                    best_s = s;
                    best = m;
                }
            }
            Some((best, sessions))
        })
        .collect();
    let mut out: Vec<Candidate> = Vec::new();
    for (ms, p) in members.iter().zip(picked) {
        let Some((rep, sessions)) = p else { continue };
        let times: Vec<f64> = ms.iter().filter_map(|&m| items[m].ms).collect();
        let median_ms = median(&times);
        out.push(Candidate {
            kind: "request",
            key: items[rep].norm.clone(),
            count: ms.len() as i64,
            sessions,
            median_ms,
            score: score_of(ms.len(), median_ms),
            representative: if anonymized { None } else { Some(items[rep].text.to_string()) },
            examples: if anonymized { vec![] } else { ms.iter().filter(|&&m| m != rep).take(3).map(|&m| items[m].text.to_string()).collect() },
            tools: None,
        });
    }
    out.sort_by(|a, b| num_cmp(b.score, a.score).then(b.count.cmp(&a.count)));
    // 伏せ字版では key(正規化した依頼文)も出さない
    if anonymized {
        for (i, c) in out.iter_mut().enumerate() {
            c.key = format!("request-{}", i + 1);
        }
    }
    out
}

pub fn tool_sequence_candidates(sources: &[CandidateSource<'_>], anonymized: bool) -> Vec<Candidate> {
    struct Turn<'a> {
        id: &'a str,
        tools: Vec<&'a str>,
        ms: Option<f64>,
        request: &'a str,
    }
    struct Occ {
        turn: usize,
        start: usize,
    }
    let mut turns: Vec<Turn> = Vec::new();
    for s in sources {
        for (i, tools) in s.analysis.turn_tools.iter().enumerate() {
            turns.push(Turn { id: s.id, tools: collapse_runs(tools), ms: active_ms(s.analysis, i), request: s.analysis.requests.get(i).map_or("", String::as_str) });
        }
    }
    let explore: HashSet<&str> = EXPLORE_TOOLS.into_iter().collect();
    let mut covered: HashSet<(usize, usize)> = HashSet::new();
    let mut out: Vec<Candidate> = Vec::new();
    for l in (T::SEQ_MIN..=T::SEQ_MAX).rev() {
        let mut occ: IndexMap<String, Vec<Occ>> = IndexMap::new();
        for (ti, t) in turns.iter().enumerate() {
            let mut i = 0;
            while i + l <= t.tools.len() {
                if (0..l).any(|k| covered.contains(&(ti, i + k))) {
                    i += 1;
                    continue;
                }
                let seq = &t.tools[i..i + l];
                // 2 種類以上のツールを含むものだけ。閲覧以外の種類が少ないもの・周期的なものは除く
                let kinds: HashSet<&str> = seq.iter().copied().collect();
                let work: HashSet<&str> = seq.iter().copied().filter(|x| !explore.contains(x)).collect();
                if kinds.len() < 2 || work.len() < T::SEQ_MIN_WORK || is_periodic(seq, 3) {
                    i += 1;
                    continue;
                }
                occ.entry(seq.join(" → ")).or_default().push(Occ { turn: ti, start: i });
                i += 1;
            }
        }
        let mut accepted: Vec<(String, Vec<Occ>)> = occ.into_iter().filter(|(_, xs)| xs.len() >= T::MIN_REPEAT && uniq(xs.iter().map(|x| turns[x.turn].id)).len() >= 2).collect();
        accepted.sort_by_key(|a| std::cmp::Reverse(a.1.len()));
        for (key, xs) in accepted {
            // 既に受け入れた並びと重なる出現は数えない(同じターンの同じ位置)
            let fresh: Vec<&Occ> = xs.iter().filter(|x| (0..l).all(|k| !covered.contains(&(x.turn, x.start + k)))).collect();
            let sessions = uniq(fresh.iter().map(|x| turns[x.turn].id));
            if fresh.len() < T::MIN_REPEAT || sessions.len() < 2 {
                continue;
            }
            for x in &fresh {
                for k in 0..l {
                    covered.insert((x.turn, x.start + k));
                }
            }
            let times: Vec<f64> = fresh.iter().filter_map(|x| turns[x.turn].ms).collect();
            let median_ms = median(&times);
            let reqs = uniq(fresh.iter().map(|x| turns[x.turn].request).filter(|r| !r.is_empty() && !is_trivial_request(js::trim(r)) && !is_probe_request(js::trim(r))));
            out.push(Candidate {
                kind: "tools",
                tools: Some(key.split(" → ").map(str::to_string).collect()),
                key,
                count: fresh.len() as i64,
                sessions,
                median_ms,
                score: score_of(fresh.len(), median_ms),
                representative: if anonymized { None } else { reqs.first().cloned() },
                examples: if anonymized { vec![] } else { reqs.iter().skip(1).take(3).cloned().collect() },
            });
        }
    }
    out.sort_by(|a, b| num_cmp(b.score, a.score).then(b.count.cmp(&a.count)));
    out
}

pub fn skill_candidates(sources: &[CandidateSource<'_>], anonymized: bool) -> Vec<Candidate> {
    // atlas 自身の判定セッションは定型の繰り返しなので除く
    let src: Vec<CandidateSource> = sources.iter().copied().filter(|s| s.project != ATLAS_JUDGE_PROJECT).collect();
    let (mut a, b) = rayon::join(|| request_candidates(&src, anonymized), || tool_sequence_candidates(&src, anonymized));
    a.extend(b);
    a.sort_by(|x, y| num_cmp(y.score, x.score).then(y.count.cmp(&x.count)));
    a
}

/// 埋め込む候補(build.ts: 上位 30 件、代表と例は 300 字まで、例は 3 件まで)
pub fn embedded_candidates(candidates: &[Candidate]) -> Vec<Candidate> {
    candidates
        .iter()
        .take(30)
        .map(|c| Candidate {
            representative: c.representative.as_deref().map(|r| js::head(r, 300).into_owned()),
            examples: c.examples.iter().take(3).map(|e| js::head(e, 300).into_owned()).collect(),
            ..c.clone()
        })
        .collect()
}
