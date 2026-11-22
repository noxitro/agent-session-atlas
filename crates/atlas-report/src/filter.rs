//! セッションの絞り込み(packages/report/src/lib/filter.ts の移植。画面のフィルタ行と CLI の --project 等で共用する純関数)。

use crate::types::SessionSummary;
use atlas_core::collate::locale_compare;
use atlas_core::types::SessionRecord;
use atlas_core::jsdate;
use std::collections::{HashMap, HashSet};

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
    let first = jsdate::Civil::date(months.div_euclid(12) as i32, (months.rem_euclid(12) + 1) as u32, 1)?;
    jsdate::local_ms(first.add_days(d - 1)?)
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
    /// '1' ならメモのあるセッションだけ
    pub memo: String,
    /// '1' なら llm-wiki を参照したセッションだけ(WikiSummary::referenced。書き込みだけは入れない)
    pub wiki: String,
    /// 管理ツールのタスクの ID(そのタスクに紐づいたセッションだけ)。NO_TASK はどのタスクにも紐づいていないセッション
    pub task: String,
}

pub const NO_JUDGMENT: &str = "(none)";
/// タスクの絞り込みで「タスクなし」(どのタスクにも紐づいていない。「どのタスクでもない」と決めたものも入る)
pub const NO_TASK: &str = "(none)";

/// セッション id → 紐づいたタスクの ID(画面の TaskOf。ReportData.tasks.links のうち taskId のあるもの)
pub type TaskOf = HashMap<String, String>;

/// セッションがタスクの絞り込み(task)に合うか。空なら制限なし
pub fn matches_task(id: &str, task: &str, tasks: &TaskOf) -> bool {
    if task.is_empty() {
        return true;
    }
    let t = tasks.get(id);
    if task == NO_TASK { t.is_none() } else { t.is_some_and(|t| t == task) }
}

/// FilterState のキー(emptyFilter のキーの順。URL ハッシュの書き出しの順)
pub const FILTER_KEYS: [&str; 15] = ["from", "to", "project", "person", "client", "model", "branch", "coverage", "taskCategory", "empty", "tool", "ids", "memo", "wiki", "task"];

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
            "memo" => &self.memo,
            "wiki" => &self.wiki,
            "task" => &self.task,
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
            "memo" => &mut self.memo,
            "wiki" => &mut self.wiki,
            "task" => &mut self.task,
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

/// 一覧のチェックに写す選択: ids のうち記録にあるものだけ
pub fn known_selection(ids: &str, known: &HashSet<String>) -> Vec<String> {
    split_ids(ids).into_iter().filter(|id| known.contains(id)).collect()
}

/// ids(カンマ区切り)を配列に(空要素と重複は除く)
pub fn split_ids(ids: &str) -> Vec<String> {
    crate::ids::unique_ids(ids.split(','))
}

pub fn join_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> String {
    crate::ids::unique_ids(ids).join(",")
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
    matches_with(s, f, ids, &TaskOf::new())
}

/// tasks はタスクの絞り込み(f.task)に使う紐づけ(画面の matches の 4 つ目の引数)
pub fn matches_with(s: &SessionSummary, f: &FilterState, ids: Option<&HashSet<String>>, tasks: &TaskOf) -> bool {
    if !in_scope(s, f) {
        return false;
    }
    if ids.is_some_and(|ids| !ids.contains(&s.id)) {
        return false;
    }
    if !matches_task(&s.id, &f.task, tasks) {
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
    if !f.wiki.is_empty() && !s.wiki.referenced() {
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
    apply_filter_with(sessions, f, &TaskOf::new())
}

/// tasks はタスクの絞り込み(f.task)に使う紐づけ(画面の applyFilter の 3 つ目の引数)
pub fn apply_filter_with<'a>(sessions: &'a [SessionSummary], f: &FilterState, tasks: &TaskOf) -> Vec<&'a SessionSummary> {
    let ids: Option<HashSet<String>> = if f.ids.is_empty() { None } else { Some(split_ids(&f.ids).into_iter().collect()) };
    sessions.iter().filter(|s| matches_with(s, f, ids.as_ref(), tasks)).collect()
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

/// タスクの絞り込みの選択肢と、どのタスクにも紐づいていないセッションの数(画面の taskOptions)
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TaskOptions {
    pub tasks: Vec<FilterOption>,
    pub none: i64,
}

/// タスクの絞り込みの選択肢(紐づいたセッションの多い順、同じなら ID の順)。label はタスクの名前(names に無ければ ID)
pub fn task_options<'a>(session_ids: impl IntoIterator<Item = &'a str>, tasks: &TaskOf, names: &HashMap<String, String>) -> TaskOptions {
    let mut ids: Vec<String> = Vec::new();
    let mut none = 0;
    for sid in session_ids {
        match tasks.get(sid) {
            Some(t) => ids.push(t.clone()),
            None => none += 1,
        }
    }
    TaskOptions { tasks: count_options(ids, |v| names.get(v).cloned().unwrap_or_else(|| v.to_string())), none }
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
        if (k == "empty" || k == "memo" || k == "wiki") && !["", "1"].contains(&v.as_str()) {
            continue;
        }
        if k == "ids" {
            v = join_ids(split_ids(&v).iter().map(String::as_str));
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

    /// 前の実装の出力(時間帯は Asia/Tokyo)
    #[test]
    fn local_days_match_previous_output() {
        let cases: &[(&str, Option<i64>)] = &[
            ("2026-01-31", Some(1769785200000)),
            ("2026-02-01", Some(1769871600000)),
            ("2026-01-32", Some(1769871600000)),
            ("2026-13-01", Some(1798729200000)),
            ("2026-00-00", Some(1764428400000)),
            ("2026-00-01", Some(1764514800000)),
            ("2026-01-00", Some(1767106800000)),
            ("0026-07-01", Some(-1372928400000)),
            ("0099-12-31", Some(946566000000)),
            ("0100-01-01", Some(-59011491600000)),
            ("9999-12-31", Some(253402182000000)),
            ("2026-99-99", Some(2033218800000)),
            ("2026-1-01", None),
            ("abcd-ef-gh", None),
            ("2026-03-08", Some(1772895600000)),
            ("2026-11-01", Some(1793458800000)),
        ];
        jsdate::with_zone(&jsdate::TimeZone::fixed(jsdate::Offset::constant(9)), || {
            for &(day, ms) in cases {
                assert_eq!(local_day_start(day), ms, "{day}");
            }
        });
    }

    /// 0 時が夏時間の飛びに入る日は 1 時(jsdate::local_ms と同じ扱い)
    #[test]
    fn local_day_start_in_gap() {
        let tz = jsdate::TimeZone::posix("BRT3BRST,M10.3.0/0,M2.3.0/0").unwrap();
        jsdate::with_zone(&tz, || {
            assert_eq!(local_day_start("2026-10-18").map(jsdate::to_iso).as_deref(), Some("2026-10-18T03:00:00.000Z"));
            assert_eq!(local_day_start("2026-10-17").map(jsdate::to_iso).as_deref(), Some("2026-10-17T03:00:00.000Z"));
            assert_eq!(local_day_start("2026-10-19").map(jsdate::to_iso).as_deref(), Some("2026-10-19T02:00:00.000Z"));
        });
    }
}
