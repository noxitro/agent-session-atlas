//! 「課題 × 条件」の表(packages/report/src/lib/conditions.ts の写し)。
//! atlas.html の節は画面(TS)がその場で計算する。ここは表(out/tables/ の conditions.csv と SQLite の conditions)を書くために、同じ計算をする。
//! 計算を変えたら両方を直す(npm run parity:fixture の conditions で突き合わせる)。
//! 大文字小文字・全角半角だけが違う名前の知らせ(lookalikes)は画面だけのものなので、ここには無い。

use crate::summarize::tests_summary;
use crate::types::TestsSummary;
use atlas_core::collate::locale_compare_numeric;
use atlas_core::js;
use atlas_core::types::SessionRecord;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// タスクタグの名前の、課題・条件・番号の区切り(lib/conditions.ts の CONDITION_SEP)
pub const CONDITION_SEP: &str = "__";
/// 割合と中央値を出す最小の件数(lib/compare.ts の COMPARE_MIN_SESSIONS)
pub const MIN_SESSIONS: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConditionKey {
    pub task: String,
    pub condition: String,
    /// 番号(半角の数字)。付いていなければ None。集計には使わない
    pub rep: Option<String>,
}

/// タスクタグの名前を、課題・条件(・番号)に分ける。決まりに合わなければ None(lib/conditions.ts の parseConditionTag)
pub fn parse_condition_tag(raw: &str) -> Option<ConditionKey> {
    let parts: Vec<&str> = raw.split(CONDITION_SEP).map(js::trim).collect();
    if parts.len() != 2 && parts.len() != 3 {
        return None;
    }
    if parts.iter().any(|p| p.is_empty() || p.starts_with('_') || p.ends_with('_')) {
        return None;
    }
    if let Some(rep) = parts.get(2) {
        if !rep.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    Some(ConditionKey { task: parts[0].to_string(), condition: parts[1].to_string(), rep: parts.get(2).map(|r| r.to_string()) })
}

/// 名前の順(数字は数として比べる)。同じとされたら符号単位の順(lib/conditions.ts の compareNames)
pub fn compare_names(a: &str, b: &str) -> Ordering {
    locale_compare_numeric(a, b).then_with(|| js::cmp_utf16(a, b))
}

/// 表に使うセッションの値(lib/conditions.ts の ConditionSession のうち、計算に使うもの)
#[derive(Debug, Clone, PartialEq)]
pub struct CondSession {
    pub id: String,
    pub active_ms: Option<f64>,
    pub tools: i64,
    pub tool_failures: i64,
    pub nano_aiu: Option<f64>,
    pub tests: Option<TestsSummary>,
    pub person: Option<String>,
}

impl CondSession {
    pub fn from_record(r: &SessionRecord) -> Self {
        CondSession {
            id: r.id.clone(),
            active_ms: r.active_ms,
            tools: r.tools.total,
            tool_failures: r.friction.tool_failures,
            nano_aiu: r.tokens.nano_aiu,
            tests: r.tests.as_ref().and_then(tests_summary),
            person: r.person.clone().flatten().filter(|p| !p.is_empty()),
        }
    }
}

/// タスクタグ 1 つ。raw は名前の決まりを読む名前(送り先から集計したときは元のタグ、手元のタスクタグは名前)
#[derive(Debug, Clone, PartialEq)]
pub struct CondGroup {
    pub raw: String,
    pub ids: Vec<String>,
}

/// 中央値と、それを取ったセッションの数。value が None なら件数が足りない
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Median {
    pub value: Option<f64>,
    pub n: usize,
}

/// 最初に全部通るまでの中央値の値。未達のセッションを最後に並べて取るので、通ったセッションが半分以下なら Unreached
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UntilValue {
    Num(f64),
    Unreached,
}

impl Serialize for UntilValue {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            UntilValue::Num(v) => s.serialize_f64(*v),
            UntilValue::Unreached => s.serialize_str("unreached"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct UntilPass {
    pub value: Option<UntilValue>,
    pub n: usize,
}

/// 1 行(lib/conditions.ts の ConditionCell と同じ項目・同じ並び)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionCell {
    pub task: Option<String>,
    pub condition: String,
    pub sessions: usize,
    pub tasks: usize,
    pub with_tests: usize,
    pub passed: usize,
    pub regressed: usize,
    pub unreached: usize,
    pub pass_rate: Option<f64>,
    pub runs_to_pass: UntilPass,
    pub active_to_pass: UntilPass,
    pub aiu_to_pass: UntilPass,
    pub active: Median,
    pub aiu: Median,
    pub tools: i64,
    pub tool_failures: i64,
    pub failure_rate: Option<f64>,
}

/// 行に入ったセッション 1 つと、その課題・条件
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Member {
    pub id: String,
    pub task: String,
    pub condition: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionTable {
    pub tasks: Vec<String>,
    pub conditions: Vec<String>,
    /// 課題ごと(tasks の順)の、条件ごと(conditions の順)の行。その課題に無い条件はセッション 0 件の行
    pub rows: Vec<Vec<ConditionCell>>,
    /// 条件ごとの、課題をまとめた行
    pub pooled: Vec<ConditionCell>,
    pub matched_tags: usize,
    pub counted: usize,
    /// 行に入ったセッション(母集団の並び)
    pub members: Vec<Member>,
    pub unmatched: Vec<String>,
    pub ambiguous: usize,
    pub people: usize,
    pub shared_rows: usize,
    pub uneven_tasks: usize,
    pub has_tests: bool,
}

const fn enough(n: usize) -> bool {
    n >= MIN_SESSIONS
}

fn median(xs: &[f64]) -> Option<f64> {
    crate::retention::median(xs)
}

fn median_of(values: &[f64]) -> Median {
    Median { value: if enough(values.len()) { median(values) } else { None }, n: values.len() }
}

/// 最初に全部通るまでの中央値(lib/conditions.ts の untilPass)。reached は通ったセッションの値、total は母数
pub fn until_pass(reached: &[f64], total: usize) -> UntilPass {
    if !enough(total) {
        return UntilPass { value: None, n: total };
    }
    if reached.len() * 2 <= total {
        return UntilPass { value: Some(UntilValue::Unreached), n: total };
    }
    let mut s = reached.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    UntilPass { value: Some(UntilValue::Num((s[(total - 1) / 2] + s[total / 2]) / 2.0)), n: total }
}

/// 失敗・拒否 ÷ 呼び出し(lib/compare.ts の rate。セッションが足りないか、呼び出しが無ければ None)
fn rate(part: i64, whole: i64, sessions: usize) -> Option<f64> {
    if sessions < MIN_SESSIONS || whole <= 0 {
        return None;
    }
    Some(part as f64 / whole as f64)
}

/// セッションの集まり 1 つ分の行(lib/conditions.ts の conditionCell)
pub fn condition_cell(task: Option<&str>, condition: &str, list: &[&CondSession], tasks: usize) -> ConditionCell {
    let (mut with_tests, mut passed, mut regressed, mut unreached) = (0usize, 0usize, 0usize, 0usize);
    let (mut tools, mut tool_failures) = (0i64, 0i64);
    let mut runs: Vec<f64> = Vec::new();
    let mut pass_active: Vec<f64> = Vec::new();
    let mut active_total = 0usize;
    let mut pass_aiu: Vec<f64> = Vec::new();
    let mut aiu_total = 0usize;
    let mut active: Vec<f64> = Vec::new();
    let mut aiu: Vec<f64> = Vec::new();
    for s in list {
        tools += s.tools;
        tool_failures += s.tool_failures;
        if let Some(a) = s.active_ms {
            active.push(a);
        }
        if let Some(n) = s.nano_aiu {
            aiu.push(n / 1e9);
        }
        let Some(t) = &s.tests else { continue };
        with_tests += 1;
        let Some(first) = t.first_pass else {
            unreached += 1;
            active_total += 1;
            if t.last_nano_aiu.is_some() {
                aiu_total += 1;
            }
            continue;
        };
        if t.last_failing == 0 {
            passed += 1;
        } else {
            regressed += 1;
        }
        runs.push(first as f64);
        if let Some(a) = t.pass_active_ms {
            pass_active.push(a);
            active_total += 1;
        }
        if let Some(n) = t.pass_nano_aiu {
            pass_aiu.push(n / 1e9);
            aiu_total += 1;
        }
    }
    ConditionCell {
        task: task.map(str::to_string),
        condition: condition.to_string(),
        sessions: list.len(),
        tasks,
        with_tests,
        passed,
        regressed,
        unreached,
        pass_rate: if enough(with_tests) { Some(passed as f64 / with_tests as f64) } else { None },
        runs_to_pass: until_pass(&runs, with_tests),
        active_to_pass: until_pass(&pass_active, active_total),
        aiu_to_pass: until_pass(&pass_aiu, aiu_total),
        active: median_of(&active),
        aiu: median_of(&aiu),
        tools,
        tool_failures,
        failure_rate: rate(tool_failures, tools, list.len()),
    }
}

/// 課題 × 条件の表(lib/conditions.ts の conditionTable)。sessions は母集団、groups はタスクタグ
pub fn condition_table(sessions: &[CondSession], groups: &[CondGroup]) -> ConditionTable {
    let known: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    // セッション id → (課題, 条件) → 鍵
    let mut keys_of: HashMap<&str, IndexMap<(String, String), ConditionKey>> = HashMap::new();
    let mut unmatched: Vec<String> = Vec::new();
    let mut matched_tags = 0usize;
    for g in groups {
        let ids: Vec<&str> = g.ids.iter().map(String::as_str).filter(|id| known.contains(id)).collect();
        if ids.is_empty() {
            continue;
        }
        let Some(key) = parse_condition_tag(&g.raw) else {
            if g.raw.contains(CONDITION_SEP) {
                unmatched.push(g.raw.clone());
            }
            continue;
        };
        matched_tags += 1;
        for id in ids {
            keys_of.entry(known.get(id).copied().unwrap_or(id)).or_default().insert((key.task.clone(), key.condition.clone()), key.clone());
        }
    }
    let mut cells: IndexMap<String, IndexMap<String, Vec<&CondSession>>> = IndexMap::new();
    let mut condition_set: IndexSet<String> = IndexSet::new();
    let mut people: HashSet<&str> = HashSet::new();
    let mut ambiguous = 0usize;
    let mut members: Vec<Member> = Vec::new();
    for s in sessions {
        let Some(m) = keys_of.get(s.id.as_str()) else { continue };
        if m.len() > 1 {
            ambiguous += 1;
            continue;
        }
        let key = m.values().next().expect("鍵が 1 つ");
        cells.entry(key.task.clone()).or_default().entry(key.condition.clone()).or_default().push(s);
        condition_set.insert(key.condition.clone());
        if let Some(p) = s.person.as_deref() {
            people.insert(p);
        }
        members.push(Member { id: s.id.clone(), task: key.task.clone(), condition: key.condition.clone() });
    }
    let mut tasks: Vec<String> = cells.keys().cloned().collect();
    tasks.sort_by(|a, b| compare_names(a, b));
    let mut conditions: Vec<String> = condition_set.into_iter().collect();
    conditions.sort_by(|a, b| compare_names(a, b));
    let empty: Vec<&CondSession> = Vec::new();
    let list_of = |t: &str, c: &str| -> &Vec<&CondSession> { cells.get(t).and_then(|m| m.get(c)).unwrap_or(&empty) };
    let rows: Vec<Vec<ConditionCell>> = tasks
        .iter()
        .map(|t| {
            conditions
                .iter()
                .map(|c| {
                    let list = list_of(t, c);
                    condition_cell(Some(t), c, list, usize::from(!list.is_empty()))
                })
                .collect()
        })
        .collect();
    let pooled: Vec<ConditionCell> = conditions
        .iter()
        .map(|c| {
            let lists: Vec<&Vec<&CondSession>> = tasks.iter().map(|t| list_of(t, c)).collect();
            let all: Vec<&CondSession> = lists.iter().flat_map(|l| l.iter().copied()).collect();
            condition_cell(None, c, &all, lists.iter().filter(|l| !l.is_empty()).count())
        })
        .collect();
    let shared_rows = cells
        .values()
        .flat_map(|m| m.values())
        .filter(|list| list.iter().filter_map(|s| s.person.as_deref()).collect::<HashSet<_>>().len() > 1)
        .count();
    let uneven_tasks = rows.iter().filter(|r| r.iter().map(|c| c.sessions).collect::<HashSet<_>>().len() > 1).count();
    let has_tests = pooled.iter().any(|c| c.with_tests > 0);
    let mut unmatched: Vec<String> = unmatched.into_iter().collect::<IndexSet<_>>().into_iter().collect();
    unmatched.sort_by(|a, b| compare_names(a, b));
    ConditionTable {
        tasks,
        conditions,
        rows,
        pooled,
        matched_tags,
        counted: members.len(),
        members,
        unmatched,
        ambiguous,
        people: people.len(),
        shared_rows,
        uneven_tasks,
        has_tests,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass(n: i64) -> TestsSummary {
        TestsSummary { runs: n, first_pass: Some(n), last_failing: 0, pass_active_ms: Some(n as f64 * 60_000.0), pass_nano_aiu: Some(n as f64 * 1e9), last_nano_aiu: Some(n as f64 * 1e9) }
    }
    fn s(id: &str, tests: Option<TestsSummary>) -> CondSession {
        CondSession { id: id.into(), active_ms: Some(600_000.0), tools: 10, tool_failures: 1, nano_aiu: Some(4e9), tests, person: None }
    }
    fn g(raw: &str, ids: &[&str]) -> CondGroup {
        CondGroup { raw: raw.into(), ids: ids.iter().map(|x| x.to_string()).collect() }
    }

    #[test]
    fn parses_tag_names() {
        assert_eq!(parse_condition_tag(" 描画 __ wiki __ 007 "), Some(ConditionKey { task: "描画".into(), condition: "wiki".into(), rep: Some("007".into()) }));
        assert_eq!(parse_condition_tag("render__wiki").map(|k| k.rep), Some(None));
        for name in ["render", "render__", "__wiki", "render____1", "a__b__c__1", "render__wiki__v2", "render__wiki__\u{ff11}", "a___b", "a__b_", ""] {
            assert_eq!(parse_condition_tag(name), None, "{name}");
        }
    }

    #[test]
    fn orders_names_numerically() {
        let mut v = vec!["c10", "c2", "B", "a", "c1"];
        v.sort_by(|a, b| compare_names(a, b));
        assert_eq!(v, ["a", "B", "c1", "c2", "c10"]);
    }

    #[test]
    fn until_pass_places_unreached_last() {
        assert_eq!(until_pass(&[1.0, 2.0, 4.0], 5), UntilPass { value: Some(UntilValue::Num(4.0)), n: 5 });
        assert_eq!(until_pass(&[3.0, 1.0, 2.0, 4.0], 6).value, Some(UntilValue::Num(3.5)));
        assert_eq!(until_pass(&[1.0, 2.0, 3.0], 6).value, Some(UntilValue::Unreached));
        assert_eq!(until_pass(&[1.0, 2.0, 3.0, 4.0], 4), UntilPass { value: None, n: 4 });
    }

    #[test]
    fn table_counts_each_session_once() {
        let list: Vec<CondSession> = ["a", "b", "c", "d", "e", "f"].iter().map(|id| s(id, Some(pass(1)))).collect();
        let t = condition_table(&list, &[g("x__wiki__1", &["a", "b"]), g("x__wiki__2", &["b", "c"]), g("y__wiki", &["d", "e"]), g("x__plain", &["e", "f"]), g("x__b__z", &["f"]), g("gone__plain", &["zz"])]);
        assert_eq!(t.tasks, ["x", "y"]);
        assert_eq!(t.conditions, ["plain", "wiki"]);
        // e は課題の違う 2 つの組に入るので、どの行にも入らない
        assert_eq!((t.ambiguous, t.counted, t.matched_tags), (1, 5, 4));
        assert_eq!(t.rows[0].iter().map(|c| c.sessions).collect::<Vec<_>>(), [1, 3]);
        assert_eq!(t.pooled.iter().map(|c| (c.sessions, c.tasks)).collect::<Vec<_>>(), [(1, 1), (4, 2)]);
        assert_eq!(t.unmatched, ["x__b__z"]);
        assert!(t.has_tests);
    }
}
