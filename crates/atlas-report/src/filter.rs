//! セッションの絞り込み(packages/report/src/lib/filter.ts の移植。画面のフィルタ行と CLI の --project 等で共用する純関数)。

use crate::types::SessionSummary;
use atlas_core::collate::locale_compare;
use atlas_core::types::SessionRecord;
use atlas_core::{js, jsdate};
use std::collections::{HashMap, HashSet};
use chrono::{Local, LocalResult, NaiveDate, TimeZone};

pub const ALL: &str = "";
pub const UNKNOWN: &str = "(unknown)";

/// 絞り込みに使う最小限の形(SessionRecord と画面の SessionSummary の両方が満たす)
pub trait Filterable {
    fn project(&self) -> &str;
    fn client(&self) -> Option<&str>;
    fn branch(&self) -> Option<&str>;
    fn models(&self) -> &[String];
    fn created_at(&self) -> Option<&str>;
    fn updated_at(&self) -> Option<&str>;
}

impl Filterable for SessionRecord {
    fn project(&self) -> &str {
        &self.project
    }
    fn client(&self) -> Option<&str> {
        self.client.as_deref()
    }
    fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }
    fn models(&self) -> &[String] {
        &self.models
    }
    fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

/// 期間・プロジェクト・クライアント・モデル・ブランチ(FilterState の一部。空文字は制限なし)
#[derive(Debug, Clone, Copy, Default)]
pub struct BaseFilter<'a> {
    /// YYYY-MM-DD(ローカル日付、含む)
    pub from: &'a str,
    pub to: &'a str,
    pub project: &'a str,
    pub client: &'a str,
    pub model: &'a str,
    pub branch: &'a str,
}

/// セッションの基準時刻(作成日時、無ければ更新日時)。ミリ秒
pub fn session_time(s: &impl Filterable) -> Option<i64> {
    let t = s.created_at().or(s.updated_at())?;
    if t.is_empty() {
        return None;
    }
    jsdate::parse_ms(t)
}

/// セッションの最終更新の時刻(ミリ秒)。更新日時が無ければ開始日時、どちらも無ければ None
pub fn session_updated(s: &impl Filterable) -> Option<i64> {
    let t = s.updated_at().or(s.created_at())?;
    if t.is_empty() {
        return None;
    }
    jsdate::parse_ms(t)
}

/// YYYY-MM-DD をローカル日付の 0 時(ミリ秒)に。不正なら None
/// (JS の new Date(y, m - 1, d) と同じく、月日の繰り上がりを許す)
pub fn local_day_start(day: &str) -> Option<i64> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let (y, m, d): (i32, i64, i64) = (day[0..4].parse().ok()?, day[5..7].parse().ok()?, day[8..10].parse().ok()?);
    // new Date(y, …) は 0〜99 年を 1900 年代とみなす
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    // 月・日の繰り上がり(13 月 → 翌年 1 月、0 日 → 前月末)
    let months = y as i64 * 12 + (m - 1);
    let first = NaiveDate::from_ymd_opt(months.div_euclid(12) as i32, (months.rem_euclid(12) + 1) as u32, 1)?;
    let date = first.checked_add_signed(chrono::Duration::days(d - 1))?;
    let dt = date.and_hms_opt(0, 0, 0)?;
    match Local.from_local_datetime(&dt) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis()),
        LocalResult::None => Local.from_local_datetime(&(dt + chrono::Duration::hours(1))).earliest().map(|t| t.timestamp_millis()),
    }
}

fn eq_or_unknown(value: Option<&str>, want: &str) -> bool {
    if want == UNKNOWN { value.is_none() || value == Some(UNKNOWN) } else { value == Some(want) }
}

/// 期間・プロジェクト・クライアント・モデル・ブランチの共通述語
pub fn matches_base(s: &impl Filterable, f: &BaseFilter<'_>) -> bool {
    if !f.project.is_empty() && s.project() != f.project {
        return false;
    }
    if !f.client.is_empty() && !eq_or_unknown(s.client(), f.client) {
        return false;
    }
    if !f.branch.is_empty() && !eq_or_unknown(s.branch(), f.branch) {
        return false;
    }
    if !f.model.is_empty() {
        let ok = if f.model == UNKNOWN { s.models().is_empty() } else { s.models().iter().any(|m| m == f.model) };
        if !ok {
            return false;
        }
    }
    if !f.from.is_empty() || !f.to.is_empty() {
        // 日時不明は期間指定時に除外
        let Some(t) = session_time(s) else {
            return false;
        };
        let from = if f.from.is_empty() { None } else { local_day_start(f.from) };
        let to = if f.to.is_empty() { None } else { local_day_start(f.to) };
        if from.is_some_and(|x| t < x) {
            return false;
        }
        if to.is_some_and(|x| t >= x + 24 * 3600 * 1000) {
            return false;
        }
    }
    true
}

// ---------- 画面の絞り込み(FilterState) ----------

impl Filterable for SessionSummary {
    fn project(&self) -> &str {
        &self.project
    }
    fn client(&self) -> Option<&str> {
        self.client.as_deref()
    }
    fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }
    fn models(&self) -> &[String] {
        &self.models
    }
    fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

/// 画面の絞り込みの状態(URL ハッシュ #f=… と往復する)。空文字は制限なし
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterState {
    /// YYYY-MM-DD(ローカル日付、含む)
    pub from: String,
    pub to: String,
    pub project: String,
    /// 人のフォルダの名前(送り先をまとめて集計したレポートだけ)。UNKNOWN は人のフォルダの下に無いセッション
    pub person: String,
    pub client: String,
    pub model: String,
    pub branch: String,
    /// '' / input / output-only / none
    pub coverage: String,
    /// judgments の taskCategory。'(none)' は未判定
    pub task_category: String,
    /// '1' なら空のセッションも含める。既定('')は除外
    pub empty: String,
    /// そのツールを呼んだセッションだけ(ツール名、MCP サーバーは mcp:<サーバー>)
    pub tool: String,
    /// セッションの選択(id をカンマ区切り。'' は制限なし)
    pub ids: String,
    /// 選んだグループの名前('' は無し)
    pub group: String,
    /// '1' ならメモのあるセッションだけ
    pub memo: String,
}

pub const NO_JUDGMENT: &str = "(none)";
/// どのセッションにも当たらない id(0 件のグループを「制限なし」('')と区別する)
pub const NO_SESSION: &str = "(none)";

/// FilterState のキー(emptyFilter のキーの順。URL ハッシュの書き出しの順)
pub const FILTER_KEYS: [&str; 14] = ["from", "to", "project", "person", "client", "model", "branch", "coverage", "taskCategory", "empty", "tool", "ids", "group", "memo"];

impl FilterState {
    pub fn get(&self, k: &str) -> &str {
        match k {
            "from" => &self.from,
            "to" => &self.to,
            "project" => &self.project,
            "person" => &self.person,
            "client" => &self.client,
            "model" => &self.model,
            "branch" => &self.branch,
            "coverage" => &self.coverage,
            "taskCategory" => &self.task_category,
            "empty" => &self.empty,
            "tool" => &self.tool,
            "ids" => &self.ids,
            "group" => &self.group,
            "memo" => &self.memo,
            _ => "",
        }
    }

    fn get_mut(&mut self, k: &str) -> Option<&mut String> {
        Some(match k {
            "from" => &mut self.from,
            "to" => &mut self.to,
            "project" => &mut self.project,
            "person" => &mut self.person,
            "client" => &mut self.client,
            "model" => &mut self.model,
            "branch" => &mut self.branch,
            "coverage" => &mut self.coverage,
            "taskCategory" => &mut self.task_category,
            "empty" => &mut self.empty,
            "tool" => &mut self.tool,
            "ids" => &mut self.ids,
            "group" => &mut self.group,
            "memo" => &mut self.memo,
            _ => return None,
        })
    }

    pub fn base(&self) -> BaseFilter<'_> {
        BaseFilter { from: &self.from, to: &self.to, project: &self.project, client: &self.client, model: &self.model, branch: &self.branch }
    }
}

pub fn empty_filter() -> FilterState {
    FilterState::default()
}

/// グループの名前と id(SessionGroup・ReportGroup)
pub trait NamedIds {
    fn name(&self) -> &str;
    fn ids(&self) -> &[String];
}

impl NamedIds for crate::groups::SessionGroup {
    fn name(&self) -> &str {
        &self.name
    }
    fn ids(&self) -> &[String] {
        &self.ids
    }
}

/// effectiveIds の戻り
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveIds<'g, G> {
    pub group: Option<&'g G>,
    pub ids: String,
}

/// 集計に使う id の集合を決める: group の名前が groups にあればその今の ids、無ければ ids
pub fn effective_ids<'g, G: NamedIds>(ids: &str, group: &str, groups: &'g [G], known: &HashSet<String>) -> EffectiveIds<'g, G> {
    let g = if group.is_empty() { None } else { groups.iter().find(|x| x.name() == group) };
    match g {
        None => EffectiveIds { group: None, ids: ids.to_string() },
        Some(g) => EffectiveIds { group: Some(g), ids: group_ids(g.ids(), known) },
    }
}

/// 現在のグループ名(名前で決まればそれ。決まらないときは ids の一致で探す。0 件・重複は決めない)
pub fn current_group_name<G: NamedIds>(ids: &str, group: &str, groups: &[G], known: &HashSet<String>) -> Option<String> {
    let e = effective_ids(ids, group, groups, known);
    if let Some(g) = e.group {
        return Some(g.name().to_string());
    }
    if ids.is_empty() || ids == NO_SESSION {
        return None;
    }
    let hits: Vec<&G> = groups.iter().filter(|g| same_ids(ids, &group_ids(g.ids(), known))).collect();
    if hits.len() == 1 { Some(hits[0].name().to_string()) } else { None }
}

/// 一覧のチェックに写す選択: ids のうち記録にあるものだけ
pub fn known_selection(ids: &str, known: &HashSet<String>) -> Vec<String> {
    split_ids(ids).into_iter().filter(|id| known.contains(id)).collect()
}

/// グループの絞り込みに使う ids: 記録にある id、無ければ元の ids、それも無ければ NO_SESSION(= 0 件)
pub fn group_ids(ids: &[String], known: &HashSet<String>) -> String {
    let present: Vec<&str> = ids.iter().filter(|id| known.contains(*id)).map(String::as_str).collect();
    if !present.is_empty() {
        join_ids(present)
    } else if !ids.is_empty() {
        join_ids(ids.iter().map(String::as_str))
    } else {
        join_ids([NO_SESSION])
    }
}

/// ids(カンマ区切り)を配列に(空要素と重複は除く)
pub fn split_ids(ids: &str) -> Vec<String> {
    crate::groups::unique_ids(ids.split(','))
}

pub fn join_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> String {
    crate::groups::unique_ids(ids).join(",")
}

/// 2 つの ids が同じ集合か(順序は無視)
pub fn same_ids(a: &str, b: &str) -> bool {
    let x = split_ids(a);
    let y: HashSet<String> = split_ids(b).into_iter().collect();
    x.len() == y.len() && x.iter().all(|id| y.contains(id))
}

pub fn is_empty_filter(f: &FilterState) -> bool {
    *f == empty_filter()
}

/// 空のセッションを除外するか(既定)
pub fn in_scope(s: &SessionSummary, f: &FilterState) -> bool {
    f.empty == "1" || !s.empty
}

/// そのツール(MCP サーバーは mcp:<サーバー>)を呼んだセッションか
pub fn used_tool(s: &SessionSummary, tool: &str) -> bool {
    if let Some(server) = tool.strip_prefix("mcp:") {
        return s.tools.mcp.get(server).is_some_and(|m| !m.is_empty());
    }
    s.tools.by_name.get(tool).copied().unwrap_or(0) > 0
}

pub fn matches(s: &SessionSummary, f: &FilterState, ids: Option<&HashSet<String>>) -> bool {
    if !in_scope(s, f) {
        return false;
    }
    if ids.is_some_and(|ids| !ids.contains(&s.id)) {
        return false;
    }
    if !matches_base(s, &f.base()) {
        return false;
    }
    if !f.person.is_empty() && !eq_or_unknown(s.person.as_deref(), &f.person) {
        return false;
    }
    if !f.tool.is_empty() && !used_tool(s, &f.tool) {
        return false;
    }
    if !f.coverage.is_empty() && s.coverage != f.coverage {
        return false;
    }
    if !f.memo.is_empty() && s.memo.is_none() {
        return false;
    }
    if !f.task_category.is_empty() {
        let c = s.judgment.as_ref().and_then(|j| j.task_category.as_deref()).unwrap_or(NO_JUDGMENT);
        if c != f.task_category {
            return false;
        }
    }
    true
}

pub fn apply_filter<'a>(sessions: &'a [SessionSummary], f: &FilterState) -> Vec<&'a SessionSummary> {
    let ids: Option<HashSet<String>> = if f.ids.is_empty() { None } else { Some(split_ids(&f.ids).into_iter().collect()) };
    sessions.iter().filter(|s| matches(s, f, ids.as_ref())).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FilterOption {
    pub value: String,
    pub label: String,
    pub count: i64,
}

fn count_options(values: impl IntoIterator<Item = String>, label: impl Fn(&str) -> String) -> Vec<FilterOption> {
    let mut m: indexmap::IndexMap<String, i64> = indexmap::IndexMap::new();
    for v in values {
        *m.entry(v).or_insert(0) += 1;
    }
    let mut v: Vec<(String, i64)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(&a.0, &b.0)));
    v.into_iter().map(|(value, count)| FilterOption { label: label(&value), value, count }).collect()
}

/// 人のフォルダの名前が 1 件でも付いているか(送り先をまとめて集計したレポートか)
pub fn has_people<'a>(sessions: impl IntoIterator<Item = &'a SessionSummary>) -> bool {
    sessions.into_iter().any(|s| s.person.is_some())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub project: Vec<FilterOption>,
    pub person: Vec<FilterOption>,
    pub client: Vec<FilterOption>,
    pub model: Vec<FilterOption>,
    pub branch: Vec<FilterOption>,
    pub task_category: Vec<FilterOption>,
}

/// フィルタの選択肢(全セッションに対する件数付き)。person は、人のフォルダの名前が 1 件も無ければ空
pub fn filter_options(sessions: &[SessionSummary]) -> FilterOptions {
    // new Map(sessions.map(...)) は同じキーなら後のもので上書きする
    let labels: HashMap<&str, &str> = sessions.iter().map(|s| (s.project.as_str(), s.project_label.as_str())).collect();
    let own = |v: &str| v.to_string();
    FilterOptions {
        project: count_options(sessions.iter().map(|s| s.project.clone()), |v| labels.get(v).map_or(v, |l| l).to_string()),
        person: if has_people(sessions) { count_options(sessions.iter().map(|s| s.person.clone().unwrap_or_else(|| UNKNOWN.into())), own) } else { vec![] },
        client: count_options(sessions.iter().map(|s| s.client.clone().unwrap_or_else(|| UNKNOWN.into())), own),
        model: count_options(sessions.iter().flat_map(|s| if s.models.is_empty() { vec![UNKNOWN.to_string()] } else { s.models.clone() }), own),
        branch: count_options(sessions.iter().map(|s| s.branch.clone().unwrap_or_else(|| UNKNOWN.into())), own),
        task_category: count_options(sessions.iter().map(|s| s.judgment.as_ref().and_then(|j| j.task_category.clone()).unwrap_or_else(|| NO_JUDGMENT.into())), own),
    }
}

/// 入力トークン記録の 3 区分
pub fn coverage_of(input: Option<f64>, output: f64, source: &str) -> &'static str {
    if input.is_some() {
        return "input";
    }
    if output > 0.0 || source == "partial" {
        return "output-only";
    }
    "none"
}

/// `encodeURIComponent`(英数と - _ . ! ~ * ' ( ) 以外を UTF-8 の %XX に)
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`。不正な %XX・UTF-8 は None(JS の URIError)
pub fn decode_uri_component(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(h).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok().filter(|_| h.iter().all(u8::is_ascii_hexdigit))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// URL ハッシュ(#f=...)との相互変換。file:// でも状態を共有できるように
pub fn encode_filter(f: &FilterState) -> String {
    let e = empty_filter();
    let mut parts: Vec<String> = Vec::new();
    for k in FILTER_KEYS {
        let v = f.get(k);
        if v != e.get(k) {
            let enc = encode_uri_component(v);
            // ids のカンマはハッシュの中でそのまま使える文字なので符号化しない
            let enc = if k == "ids" { enc.replace("%2C", ",") } else { enc };
            parts.push(format!("{k}={enc}"));
        }
    }
    parts.join("&")
}

fn strip_hash(s: &str) -> &str {
    s.strip_prefix('#').unwrap_or(s)
}

/// URL ハッシュの表示の指定(view=unused-skills など。無ければ None)
pub fn decode_view(s: &str) -> Option<String> {
    for part in strip_hash(s).split('&') {
        let Some(v) = part.strip_prefix("view=") else { continue };
        return decode_uri_component(v).filter(|x| !x.is_empty());
    }
    None
}

/// 絞り込みと表示の指定から URL ハッシュ(先頭の # 付き)を作る
pub fn filter_href(f: &FilterState, view: Option<&str>) -> String {
    let a = encode_filter(f);
    let b = match view {
        Some(v) if !v.is_empty() => format!("view={}", encode_uri_component(v)),
        _ => String::new(),
    };
    let parts: Vec<&str> = [a.as_str(), b.as_str()].into_iter().filter(|x| !x.is_empty()).collect();
    format!("#{}", parts.join("&"))
}

/// ハッシュが絞り込みか表示の指定を含むか(#overview のようなページ内リンクは含まない)
pub fn is_state_hash(s: &str) -> bool {
    strip_hash(s).split('&').any(|p| p.find('=').is_some_and(|i| i > 0))
}

pub fn decode_filter(s: &str) -> FilterState {
    let mut f = empty_filter();
    for part in strip_hash(s).split('&') {
        let Some(i) = part.find('=').filter(|i| *i > 0) else { continue };
        let k = &part[..i];
        if f.get_mut(k).is_none() {
            continue;
        }
        let Some(mut v) = decode_uri_component(&part[i + 1..]) else { continue };
        if k == "coverage" && !["", "input", "output-only", "none"].contains(&v.as_str()) {
            continue;
        }
        if (k == "empty" || k == "memo") && !["", "1"].contains(&v.as_str()) {
            continue;
        }
        if k == "ids" {
            v = join_ids(split_ids(&v).iter().map(String::as_str));
        }
        if k == "group" {
            v = js::trim(&v).to_string();
        }
        *f.get_mut(k).expect("FILTER_KEYS のキー") = v;
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_days() {
        let a = local_day_start("2026-01-31").unwrap();
        assert_eq!(local_day_start("2026-02-01").unwrap() - a, 24 * 3600 * 1000);
        // 月日の繰り上がりは JS の new Date と同じ
        assert_eq!(local_day_start("2026-01-32"), local_day_start("2026-02-01"));
        assert_eq!(local_day_start("2026-13-01"), local_day_start("2027-01-01"));
        assert_eq!(local_day_start("2026-1-01"), None);
    }
}
