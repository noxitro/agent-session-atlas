//! セッションとタスクの紐づけ(<notes-dir>/task-links.json)。1 つのセッションは 1 つのタスクにだけ紐づく。
//! 紐づけの出所は 3 つ。手動(画面で選んだもの)> LLM(頼んだときだけ判定)> 機械(集計のたびに決め直す)の順に優先する。
//! 機械の紐づけ(決まった規則。LLM は使わない):
//! - セッションの題名と、依頼の文(最初の依頼と、記録した各依頼の先頭)から探す。VCS のコミットの文は見ない
//! - タスクの ID: 前後が英数字でない所に、ID がそのまま出てくる(日本語の文字は区切りとみなす。2 文字未満の ID は探さない)。
//!   数字だけの ID は、前に # を付けて書いたもの(#101)だけを探す(ただの数字は件数や番号に当たりすぎる)。
//!   # を付けた番号は、リポジトリの PR や課題の番号にも当たりうる(数字だけの ID を使う環境では、その分だけ誤って紐づくことがある)
//! - タスクの名前: 正規化(NFKC・小文字・空白をまとめる)した文の中に、正規化した名前が出てくる(4 文字未満の名前は探さない)
//! - 当たりが重なるときは長い方だけを使う(DEMO-102-1 の中の DEMO-102、長い名前の中の短い名前は数えない)
//! - 候補は、未完了のタスクと、セッションを始めた後に完了を確認したタスク(始める前に終わったタスクには紐づけない)
//! - 当たったタスクがちょうど 1 つなら紐づける。0 か 2 つ以上なら決めない(LLM に任せられる)
//! - 手動の紐づけと、LLM がタスクを選んだ紐づけは変えない。LLM が「どのタスクでもない」とした紐づけは、機械の当たりが 1 つに決まれば置き換える
//!
//! 書き込みは壊れたファイルを上書きしない(直してもらう)。書き手(画面・LLM で紐づけるジョブ・集計)は別のプロセスのこともあるので、
//! update_links でファイルのロックを取り、読み直してから自分の変更だけを足して書く。

use super::state::{TaskState, TasksFile};
use super::{read_json_file, write_atomic};
use aho_corasick::{AhoCorasick, MatchKind};
use anyhow::{bail, Result};
use atlas_core::types::SessionRecord;
use indexmap::IndexMap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

pub const LINKS_VERSION: u32 = 1;
/// 探す ID の短さの下限(文字)。これより短い ID は数字などに当たりすぎる
pub const ID_MIN_CHARS: usize = 2;
/// 探す名前の短さの下限(文字)
pub const NAME_MIN_CHARS: usize = 4;
/// LLM に渡す候補の上限
pub const LLM_CANDIDATES_MAX: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkSource {
    Machine,
    Llm,
    Manual,
}

impl LinkSource {
    pub fn label(self) -> &'static str {
        match self {
            LinkSource::Machine => "機械",
            LinkSource::Llm => "LLM",
            LinkSource::Manual => "手動",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LinkSource::Machine => "machine",
            LinkSource::Llm => "llm",
            LinkSource::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    /// 紐づけたタスク。null は「どのタスクでもない」(手動か LLM が決めたもの)
    pub task_id: Option<String>,
    pub source: LinkSource,
    /// 決めた理由(機械はどこに当たったか、LLM は LLM の答え、手動は空)
    #[serde(default)]
    pub reason: String,
    /// LLM の確信度(0〜1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// 決めた日時(ISO)
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksFile {
    pub version: u32,
    #[serde(default)]
    pub links: IndexMap<String, TaskLink>,
}

impl Default for LinksFile {
    fn default() -> Self {
        LinksFile { version: LINKS_VERSION, links: IndexMap::new() }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadedLinks {
    pub file: LinksFile,
    pub warnings: Vec<String>,
}

fn parse(path: &Path) -> std::result::Result<Option<LinksFile>, String> {
    let Some(v) = read_json_file(path)? else { return Ok(None) };
    let f: LinksFile = serde_json::from_value(v).map_err(|e| format!("{} の形が違います({e})", path.display()))?;
    if f.version != LINKS_VERSION {
        return Err(format!("{} の版 {} は読めません(この atlas が読めるのは {LINKS_VERSION})", path.display(), f.version));
    }
    Ok(Some(f))
}

pub fn load_links(path: &Path) -> LoadedLinks {
    match parse(path) {
        Ok(f) => LoadedLinks { file: f.unwrap_or_default(), warnings: vec![] },
        Err(e) => LoadedLinks { file: LinksFile::default(), warnings: vec![e] },
    }
}

pub fn load_links_for_write(path: &Path) -> Result<LinksFile> {
    match parse(path) {
        Ok(f) => Ok(f.unwrap_or_default()),
        Err(e) => bail!("{e}。壊れたファイルは書き換えません(直すか、消してから紐づけ直してください)"),
    }
}

pub fn save_links(path: &Path, f: &LinksFile) -> Result<()> {
    write_atomic(path, &format!("{}\n", atlas_core::json::to_js_string_pretty(f)?))
}

/// task-links.json を、ロックの中で読み直して f で直し、変わっていれば書く(別のプロセスの書き手の変更を消さない)。
/// 壊れたファイルは書き換えない。返すのは f の値と、直した後の中身
pub fn update_links<T>(path: &Path, f: impl FnOnce(&mut LinksFile) -> T) -> Result<(T, LinksFile)> {
    super::with_file_lock(path, || {
        let mut links = load_links_for_write(path).map_err(|e| super::BrokenFile(format!("{e:#}")))?;
        let before = links.clone();
        let r = f(&mut links);
        if links != before {
            save_links(path, &links)?;
        }
        Ok((r, links))
    })
}

/// 紐づけを探すセッションの文
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionText {
    pub id: String,
    /// 始めた時刻(ミリ秒)
    pub start_ms: Option<i64>,
    pub title: String,
    /// 最初の依頼と、記録した各依頼の先頭(改行でつなげたもの)
    pub prompts: String,
}

impl SessionText {
    pub fn of(r: &SessionRecord) -> SessionText {
        let mut prompts: Vec<&str> = Vec::new();
        if let Some(f) = r.first_user_message.as_deref() {
            prompts.push(f);
        }
        prompts.extend(r.analysis.requests.iter().map(String::as_str));
        SessionText {
            id: r.id.clone(),
            start_ms: r.created_at.as_deref().filter(|s| !s.is_empty()).and_then(atlas_core::jsdate::parse_ms),
            title: r.name.clone().unwrap_or_default(),
            prompts: prompts.join("\n"),
        }
    }
}

/// 正規化(NFKC・小文字・続いた空白を 1 つに)
pub fn normalize(s: &str) -> String {
    let n: String = s.nfkc().collect::<String>().to_lowercase();
    n.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// そのセッションの候補か: 未完了のタスクと、セッションを始めた後に完了を確認したタスク(始めた時刻か完了の時刻が分からなければ候補に入れる)
pub fn is_candidate(t: &TaskState, start_ms: Option<i64>) -> bool {
    if !t.done {
        return true;
    }
    match (t.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms), start_ms) {
        (Some(done), Some(start)) => done >= start,
        _ => true,
    }
}

/// どこに当たったか(小さいほど強い。理由の文に使う)
const REASONS: [&str; 4] = ["ID が題名にある", "ID が依頼にある", "タスク名が題名にある", "タスク名が依頼にある"];

/// 機械の紐づけの結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineMatch {
    One { task_id: String, reason: String },
    None,
    /// 2 つ以上に当たった(当たったタスクの ID)
    Many(Vec<String>),
}

/// すべてのタスクの ID と名前を一度に探す仕組み(タスクとセッションが多くても、文を 1 回なめるだけで済む)
pub struct Matcher<'a> {
    tasks: Vec<(&'a str, &'a TaskState)>,
    ids: Option<AhoCorasick>,
    id_task: Vec<usize>,
    names: Option<AhoCorasick>,
    name_task: Vec<usize>,
}

/// 重なった当たりのうち、もっと長い当たりの中に入るものを除く(位置 start..end とタスク)
fn longest_only(found: Vec<(usize, usize, usize)>) -> Vec<(usize, usize, usize)> {
    found.iter().filter(|(a, b, _)| !found.iter().any(|(c, d, _)| c <= a && b <= d && d - c > b - a)).copied().collect()
}

impl<'a> Matcher<'a> {
    pub fn new(state: &'a TasksFile) -> Matcher<'a> {
        let tasks: Vec<(&str, &TaskState)> = state.tasks.iter().map(|(k, v)| (k.as_str(), v)).collect();
        let (mut id_pats, mut id_task, mut name_pats, mut name_task) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for (i, (id, t)) in tasks.iter().enumerate() {
            let nid = normalize(id);
            if !nid.is_empty() && nid.bytes().all(|b| b.is_ascii_digit()) {
                // 数字だけの ID は #<数字> の形だけを探す(2 文字未満の ID は、ほかの ID と同じく探さない)
                if nid.len() >= ID_MIN_CHARS {
                    id_pats.push(format!("#{nid}"));
                    id_task.push(i);
                }
            } else if nid.chars().count() >= ID_MIN_CHARS {
                id_pats.push(nid);
                id_task.push(i);
            }
            let nname = normalize(&t.name);
            if nname.chars().count() >= NAME_MIN_CHARS {
                name_pats.push(nname);
                name_task.push(i);
            }
        }
        let build = |p: &[String]| (!p.is_empty()).then(|| AhoCorasick::builder().match_kind(MatchKind::Standard).build(p).ok()).flatten();
        Matcher { ids: build(&id_pats), id_task, names: build(&name_pats), name_task, tasks }
    }

    /// 正規化した文に当たるタスク(位置 → いちばん強い当たり方)。rank_base は題名 0・依頼 1
    fn scan(&self, text: &str, rank_base: usize, hits: &mut BTreeMap<usize, usize>) {
        if text.is_empty() {
            return;
        }
        let mut put = |task: usize, rank: usize| {
            let e = hits.entry(task).or_insert(rank);
            *e = (*e).min(rank);
        };
        if let Some(ac) = &self.ids {
            let mut found = Vec::new();
            for m in ac.find_overlapping_iter(text) {
                let before = text[..m.start()].chars().next_back();
                let after = text[m.end()..].chars().next();
                let edge = |c: Option<char>| c.is_none_or(|c| !c.is_ascii_alphanumeric());
                // #<数字> は # が区切りなので、前は見ない
                let hashed = text[m.start()..].starts_with('#');
                if (hashed || edge(before)) && edge(after) {
                    found.push((m.start(), m.end(), self.id_task[m.pattern().as_usize()]));
                }
            }
            for (_, _, t) in longest_only(found) {
                put(t, rank_base);
            }
        }
        if let Some(ac) = &self.names {
            let found: Vec<(usize, usize, usize)> = ac.find_overlapping_iter(text).map(|m| (m.start(), m.end(), self.name_task[m.pattern().as_usize()])).collect();
            for (_, _, t) in longest_only(found) {
                put(t, 2 + rank_base);
            }
        }
    }

    /// 1 つのセッションの機械の紐づけ
    pub fn match_session(&self, s: &SessionText) -> MachineMatch {
        let mut hits: BTreeMap<usize, usize> = BTreeMap::new();
        self.scan(&normalize(&s.title), 0, &mut hits);
        self.scan(&normalize(&s.prompts), 1, &mut hits);
        let found: Vec<(usize, usize)> = hits.into_iter().filter(|(i, _)| is_candidate(self.tasks[*i].1, s.start_ms)).collect();
        match found.as_slice() {
            [] => MachineMatch::None,
            [(i, rank)] => MachineMatch::One { task_id: self.tasks[*i].0.to_string(), reason: REASONS[*rank].to_string() },
            many => MachineMatch::Many(many.iter().map(|(i, _)| self.tasks[*i].0.to_string()).collect()),
        }
    }
}

/// 機械の紐づけをし直した結果
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachineSummary {
    /// 機械で紐づいているセッション(今回も同じもの・新しく決まったもの)
    pub linked: usize,
    /// 今回、新しく決まった・変わった
    pub updated: usize,
    /// 当たるタスクが無い
    pub unmatched: usize,
    /// 2 つ以上に当たって決めなかった
    pub ambiguous: usize,
    /// 手動か LLM の紐づけがあるので触らなかった
    pub kept: usize,
    /// 前の機械の紐づけを外した(当たらなくなった)
    pub removed: usize,
}

impl MachineSummary {
    pub fn changed(&self) -> bool {
        self.updated > 0 || self.removed > 0
    }
}

/// 機械が変えない紐づけ: 手動と、LLM がタスクを選んだもの(LLM が「どのタスクでもない」としたものは、機械の当たりが 1 つに決まれば置き換える)
pub fn is_fixed(l: &TaskLink) -> bool {
    l.source == LinkSource::Manual || (l.source == LinkSource::Llm && l.task_id.is_some())
}

/// sessions の機械の紐づけを決め直す。手動と、LLM がタスクを選んだ紐づけは変えない。sessions に無いセッションの紐づけも変えない
pub fn apply_machine(links: &mut LinksFile, sessions: &[SessionText], state: &TasksFile, now: &str) -> MachineSummary {
    let m = Matcher::new(state);
    let results: Vec<MachineMatch> = sessions.par_iter().map(|s| if links.links.get(&s.id).is_some_and(is_fixed) { MachineMatch::None } else { m.match_session(s) }).collect();
    let mut sum = MachineSummary::default();
    for (s, r) in sessions.iter().zip(results) {
        if links.links.get(&s.id).is_some_and(is_fixed) {
            sum.kept += 1;
            continue;
        }
        // LLM の「どのタスクでもない」は、機械の当たりが 1 つに決まったときだけ置き換え、決まらなければ残す
        let llm_none = links.links.get(&s.id).is_some_and(|l| l.source == LinkSource::Llm);
        if llm_none && !matches!(r, MachineMatch::One { .. }) {
            sum.kept += 1;
            continue;
        }
        match r {
            MachineMatch::One { task_id, reason } => {
                sum.linked += 1;
                let same = links.links.get(&s.id).is_some_and(|l| l.task_id.as_deref() == Some(task_id.as_str()) && l.reason == reason);
                if !same {
                    sum.updated += 1;
                    links.links.insert(s.id.clone(), TaskLink { task_id: Some(task_id), source: LinkSource::Machine, reason, confidence: None, at: now.to_string() });
                }
            }
            other => {
                if matches!(other, MachineMatch::Many(_)) {
                    sum.ambiguous += 1;
                } else {
                    sum.unmatched += 1;
                }
                if links.links.shift_remove(&s.id).is_some() {
                    sum.removed += 1;
                }
            }
        }
    }
    sum
}

/// LLM に聞くセッションか(`tasks link --llm` の対象と、画面の確認に出す件数が同じこの決め方を使う):
/// 紐づけが無く、開いただけのセッション(empty)ではなく、題名か依頼の文があり、候補のタスクが 1 つ以上ある
pub fn llm_eligible(links: &LinksFile, state: &TasksFile, id: &str, empty: bool, has_text: bool, start_ms: Option<i64>) -> bool {
    !links.links.contains_key(id) && !empty && has_text && state.tasks.values().any(|t| is_candidate(t, start_ms))
}

/// 題名か依頼の文があるか(llm_eligible の has_text)
pub fn has_text(title: &str, prompts: &str) -> bool {
    !(title.trim().is_empty() && prompts.trim().is_empty())
}

/// 紐づけの無いセッション(LLM に任せるもの)
pub fn unresolved<'a>(links: &LinksFile, sessions: &'a [SessionText]) -> Vec<&'a SessionText> {
    sessions.iter().filter(|s| !links.links.contains_key(&s.id)).collect()
}

/// LLM に渡す候補(ID と名前)。機械の紐づけで 2 つ以上に当たったタスク(first) → 未完了で XML にあるもの →
/// 完了を確認した時刻の早いもの → XML から消えたもの の順に、上限まで
pub fn llm_candidates(state: &TasksFile, start_ms: Option<i64>, first: &[String]) -> Vec<(String, String)> {
    let mut c: Vec<(u8, i64, usize, &str, &TaskState)> = state
        .tasks
        .iter()
        .enumerate()
        .filter(|(_, (_, t))| is_candidate(t, start_ms))
        .map(|(i, (id, t))| {
            let group = if first.iter().any(|f| f == id) {
                0
            } else if t.missing {
                3
            } else if t.done {
                2
            } else {
                1
            };
            (group, t.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms).unwrap_or(0), i, id.as_str(), t)
        })
        .collect();
    c.sort_by_key(|x| (x.0, x.1, x.2));
    c.into_iter().take(LLM_CANDIDATES_MAX).map(|x| (x.3.to_string(), x.4.name.clone())).collect()
}

/// セッション id → 紐づいたタスク(task_id が null のものは入れない)
pub fn linked_tasks(links: &LinksFile) -> HashMap<&str, (&str, LinkSource)> {
    links.links.iter().filter_map(|(sid, l)| l.task_id.as_deref().map(|t| (sid.as_str(), (t, l.source)))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(name: &str, done_at: Option<&str>) -> TaskState {
        TaskState { name: name.into(), status: if done_at.is_some() { "Done" } else { "Open" }.into(), done: done_at.is_some(), first_seen_at: "2026-11-01T00:00:00.000Z".into(), done_at: done_at.map(str::to_string), last_seen_at: "2026-11-01T00:00:00.000Z".into(), missing: false, done_observed: done_at.is_some() }
    }

    fn state(items: &[(&str, TaskState)]) -> TasksFile {
        TasksFile { tasks: items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), ..Default::default() }
    }

    fn sess(id: &str, title: &str, prompts: &str) -> SessionText {
        SessionText { id: id.into(), start_ms: atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z"), title: title.into(), prompts: prompts.into() }
    }

    fn st() -> TasksFile {
        state(&[("ABC-12", task("ログイン画面の不具合", None)), ("ABC-123", task("一覧の並び替え", None)), ("7", task("短いID", None)), ("XY-9", task("帳票の出力", None))])
    }

    #[test]
    fn id_token_boundaries() {
        let s = st();
        let m = Matcher::new(&s);
        let one = |t: &str, p: &str| m.match_session(&sess("s", t, p));
        assert_eq!(one("ABC-12 を直す", ""), MachineMatch::One { task_id: "ABC-12".into(), reason: "ID が題名にある".into() });
        // 日本語の文字は区切り。全角・小文字も同じ ID
        assert_eq!(one("", "これはabc-12の件"), MachineMatch::One { task_id: "ABC-12".into(), reason: "ID が依頼にある".into() });
        assert_eq!(one("ＡＢＣ－１２", ""), MachineMatch::One { task_id: "ABC-12".into(), reason: "ID が題名にある".into() });
        // ABC-123 の中の ABC-12 は当たらない(後ろが数字)。ABC-123 だけ
        assert_eq!(one("ABC-123", ""), MachineMatch::One { task_id: "ABC-123".into(), reason: "ID が題名にある".into() });
        // 前後が英数字なら当たらない
        assert_eq!(one("xABC-12", "ABC-12x"), MachineMatch::None);
        // 2 文字未満の ID は探さない
        assert_eq!(one("7 件の修正", ""), MachineMatch::None);
        // 区切りの記号の隣は当たる
        assert_eq!(one("[XY-9]", ""), MachineMatch::One { task_id: "XY-9".into(), reason: "ID が題名にある".into() });
    }

    /// 数字だけの ID は #<数字> の形だけを探す
    #[test]
    fn digit_ids_need_a_hash() {
        let s = state(&[("101", task("数字だけの番号", None)), ("7", task("一桁の番号", None))]);
        let m = Matcher::new(&s);
        let one = |t: &str| m.match_session(&sess("s", t, ""));
        assert_eq!(one("101 件を直す"), MachineMatch::None);
        assert_eq!(one("ID 101"), MachineMatch::None);
        assert_eq!(one("#101 を直す"), MachineMatch::One { task_id: "101".into(), reason: "ID が題名にある".into() });
        // # の前は見ない(区切りは # 自身)。後ろが数字や英字なら当たらない
        assert_eq!(one("PR#101"), MachineMatch::One { task_id: "101".into(), reason: "ID が題名にある".into() });
        assert_eq!(one("#1010"), MachineMatch::None);
        assert_eq!(one("#101a"), MachineMatch::None);
        // 全角の #・数字も同じ。2 文字未満の数字の ID は # を付けても探さない
        assert_eq!(one("＃１０１"), MachineMatch::One { task_id: "101".into(), reason: "ID が題名にある".into() });
        assert_eq!(one("#7 を直す"), MachineMatch::None);
    }

    /// 当たりが重なるときは長い方だけ(e2e の書き出しの DEMO-102 と DEMO-102-1 も)
    #[test]
    fn overlapping_matches_prefer_the_longest() {
        let s = state(&[("DEMO-102", task("Improve the synthetic project", None)), ("DEMO-102-1", task("入れ子のサブタスク", None))]);
        let m = Matcher::new(&s);
        assert_eq!(m.match_session(&sess("s", "DEMO-102-1 を直す", "")), MachineMatch::One { task_id: "DEMO-102-1".into(), reason: "ID が題名にある".into() });
        assert_eq!(m.match_session(&sess("s", "DEMO-102 を直す", "")), MachineMatch::One { task_id: "DEMO-102".into(), reason: "ID が題名にある".into() });
        // 別の場所に両方あれば 2 つに当たる
        assert!(matches!(m.match_session(&sess("s", "DEMO-102 と DEMO-102-1", "")), MachineMatch::Many(_)));
        // 名前も、長い名前の中の短い名前は数えない
        let s2 = state(&[("A", task("帳票の出力", None)), ("B", task("帳票の出力を速くする", None))]);
        let m2 = Matcher::new(&s2);
        assert_eq!(m2.match_session(&sess("s", "", "帳票の出力を速くする件")), MachineMatch::One { task_id: "B".into(), reason: "タスク名が依頼にある".into() });
        assert_eq!(m2.match_session(&sess("s", "", "帳票の出力の件")), MachineMatch::One { task_id: "A".into(), reason: "タスク名が依頼にある".into() });
        // 同じ名前の 2 つのタスクは決めない
        let s3 = state(&[("A", task("同じ名前のタスク", None)), ("B", task("同じ名前のタスク", None))]);
        assert!(matches!(Matcher::new(&s3).match_session(&sess("s", "同じ名前のタスク", "")), MachineMatch::Many(_)));
    }

    /// 書き手は、ロックの中で読み直して自分の変更だけを足す(別の書き手が書いた手動の紐づけを消さない)
    #[test]
    fn update_links_merges_with_other_writers() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(crate::tasks::TASK_LINKS_FILE_NAME);
        let manual = TaskLink { task_id: Some("A".into()), source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() };
        std::thread::scope(|sc| {
            for i in 0..10 {
                let manual = manual.clone();
                let p = &p;
                sc.spawn(move || {
                    update_links(p, |l| {
                        l.links.insert(format!("s{i}"), manual);
                    })
                    .unwrap();
                });
            }
        });
        let (_, got) = update_links(&p, |_| ()).unwrap();
        assert_eq!(got.links.len(), 10);
        // 何も変えなければ書かない
        let before = std::fs::metadata(&p).unwrap().modified().unwrap();
        update_links(&p, |_| ()).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().modified().unwrap(), before);
        std::fs::write(&p, "{").unwrap();
        assert!(update_links(&p, |_| ()).is_err());
        // ロックは外れている(すぐ取り直せる)
        crate::tasks::with_file_lock(&p, || Ok(())).unwrap();
    }

    #[test]
    fn names_are_normalized_substrings() {
        let s = st();
        let m = Matcher::new(&s);
        assert_eq!(m.match_session(&sess("s", "", "まず ログイン画面の不具合 を見て")), MachineMatch::One { task_id: "ABC-12".into(), reason: "タスク名が依頼にある".into() });
        // 空白の違い(改行・続いた空白)はまとめて比べる
        let s2 = state(&[("N-1", task("Export  the   Report", None))]);
        let m2 = Matcher::new(&s2);
        assert!(matches!(m2.match_session(&sess("s", "please export the\nreport now", "")), MachineMatch::One { .. }));
        // 4 文字未満の名前は探さない
        let s3 = state(&[("N-2", task("帳票", None))]);
        assert_eq!(Matcher::new(&s3).match_session(&sess("s", "帳票を直す", "")), MachineMatch::None);
        // ID と名前の両方で同じタスクに当たれば 1 つ。理由は強い方(ID・題名)
        assert_eq!(m.match_session(&sess("s", "ABC-12", "ログイン画面の不具合")), MachineMatch::One { task_id: "ABC-12".into(), reason: "ID が題名にある".into() });
    }

    #[test]
    fn ambiguity_and_candidates() {
        let s = st();
        let m = Matcher::new(&s);
        match m.match_session(&sess("s", "ABC-12 と XY-9", "")) {
            MachineMatch::Many(ids) => assert_eq!(ids, ["ABC-12", "XY-9"]),
            other => panic!("{other:?}"),
        }
        // セッションを始める前に完了を確認したタスクは候補にしない。始めた後に完了したものは候補
        let s2 = state(&[("OLD-1", task("前に終わった仕事", Some("2026-11-05T00:00:00.000Z"))), ("NEW-1", task("後で終わった仕事", Some("2026-11-12T00:00:00.000Z")))]);
        let m2 = Matcher::new(&s2);
        assert_eq!(m2.match_session(&sess("s", "OLD-1", "")), MachineMatch::None);
        assert_eq!(m2.match_session(&sess("s", "OLD-1 NEW-1", "")), MachineMatch::One { task_id: "NEW-1".into(), reason: "ID が題名にある".into() });
        // 始めた時刻が分からなければ候補に入れる
        let mut unknown = sess("s", "OLD-1", "");
        unknown.start_ms = None;
        assert!(matches!(m2.match_session(&unknown), MachineMatch::One { .. }));
        assert!(is_candidate(&task("x", None), None));
    }

    #[test]
    fn machine_never_overrides_llm_or_manual_and_is_recomputed() {
        let s = st();
        let mut links = LinksFile::default();
        links.links.insert("m".into(), TaskLink { task_id: Some("XY-9".into()), source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t0".into() });
        let llm = |t: Option<&str>| TaskLink { task_id: t.map(str::to_string), source: LinkSource::Llm, reason: "LLM".into(), confidence: Some(0.8), at: "t0".into() };
        // LLM がタスクを選んだもの(機械は変えない)と、「どのタスクでもない」としたもの(機械の当たりが 1 つに決まれば置き換える・決まらなければ残す)
        links.links.insert("lt".into(), llm(Some("XY-9")));
        links.links.insert("ln".into(), llm(None));
        links.links.insert("ln2".into(), llm(None));
        links.links.insert("old".into(), TaskLink { task_id: Some("ABC-123".into()), source: LinkSource::Machine, reason: "ID が題名にある".into(), confidence: None, at: "t0".into() });
        let sessions = vec![sess("m", "ABC-12", ""), sess("lt", "ABC-12", ""), sess("ln", "ABC-12", ""), sess("ln2", "当たらない", ""), sess("old", "もう当たらない", ""), sess("new", "ABC-12", ""), sess("two", "ABC-12 XY-9", "")];
        let sum = apply_machine(&mut links, &sessions, &s, "t1");
        assert_eq!(sum, MachineSummary { linked: 2, updated: 2, unmatched: 1, ambiguous: 1, kept: 3, removed: 1 });
        assert_eq!(links.links["m"].task_id.as_deref(), Some("XY-9"));
        assert_eq!(links.links["lt"].task_id.as_deref(), Some("XY-9"));
        assert_eq!((links.links["ln"].task_id.as_deref(), links.links["ln"].source), (Some("ABC-12"), LinkSource::Machine));
        assert_eq!((links.links["ln2"].task_id.as_deref(), links.links["ln2"].source), (None, LinkSource::Llm));
        assert!(!links.links.contains_key("old"));
        assert_eq!(links.links["new"].source, LinkSource::Machine);
        assert_eq!(links.links["new"].at, "t1");
        // もう一度: 同じ結果なら日時も変えない
        let sum = apply_machine(&mut links, &sessions, &s, "t2");
        assert!(!sum.changed());
        assert_eq!(links.links["new"].at, "t1");
        let un: Vec<&str> = unresolved(&links, &sessions).iter().map(|s| s.id.as_str()).collect();
        assert_eq!(un, ["old", "two"]);
        let lt = linked_tasks(&links);
        assert_eq!(lt.get("m"), Some(&("XY-9", LinkSource::Manual)));
        assert!(!lt.contains_key("ln2"));
    }

    /// LLM に聞くセッションの決め方(CLI の対象と画面の件数が同じ)
    #[test]
    fn llm_eligibility() {
        let s = state(&[("OLD", task("前に終わった仕事", Some("2026-11-05T00:00:00.000Z")))]);
        let start = atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z");
        let links = LinksFile::default();
        // 候補が無い(始める前に終わったタスクだけ)
        assert!(!llm_eligible(&links, &s, "a", false, true, start));
        let s2 = state(&[("OLD", task("前に終わった仕事", Some("2026-11-05T00:00:00.000Z"))), ("NEW", task("未完了", None))]);
        assert!(llm_eligible(&links, &s2, "a", false, true, start));
        assert!(!llm_eligible(&links, &s2, "a", true, true, start));
        assert!(!llm_eligible(&links, &s2, "a", false, false, start));
        let mut l = LinksFile::default();
        l.links.insert("a".into(), TaskLink { task_id: None, source: LinkSource::Llm, reason: String::new(), confidence: None, at: "t".into() });
        assert!(!llm_eligible(&l, &s2, "a", false, true, start));
        assert!(has_text("", " 依頼 ") && !has_text(" ", "\n"));
    }

    #[test]
    fn llm_candidate_order_and_cap() {
        let mut items: Vec<(String, TaskState)> = (0..LLM_CANDIDATES_MAX + 20).map(|i| (format!("T-{i}"), task(&format!("仕事 {i}"), None))).collect();
        items.insert(0, ("D-2".into(), task("後で完了", Some("2026-11-20T00:00:00.000Z"))));
        items.insert(0, ("D-1".into(), task("先に完了", Some("2026-11-15T00:00:00.000Z"))));
        items.insert(0, ("GONE".into(), TaskState { missing: true, ..task("消えた", None) }));
        let s = TasksFile { tasks: items.into_iter().collect(), ..Default::default() };
        let c = llm_candidates(&s, atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z"), &[]);
        assert_eq!(c.len(), LLM_CANDIDATES_MAX);
        assert_eq!(c[0].0, "T-0");
        // 機械の紐づけで 2 つ以上に当たったタスクを先に(上限で切られないように)
        let late = format!("T-{}", LLM_CANDIDATES_MAX + 10);
        let c = llm_candidates(&s, atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z"), &[late.clone(), "GONE".into()]);
        assert_eq!((c[0].0.as_str(), c[1].0.as_str(), c[2].0.as_str()), ("GONE", late.as_str(), "T-0"));
        assert_eq!(c.len(), LLM_CANDIDATES_MAX);
        let small = state(&[("GONE", TaskState { missing: true, ..task("消えた", None) }), ("D-2", task("b", Some("2026-11-20T00:00:00.000Z"))), ("D-1", task("a", Some("2026-11-15T00:00:00.000Z"))), ("O", task("o", None))]);
        let ids: Vec<String> = llm_candidates(&small, None, &[]).into_iter().map(|x| x.0).collect();
        assert_eq!(ids, ["O", "D-1", "D-2", "GONE"]);
    }

    #[test]
    fn files_round_trip_and_refuse_broken() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(crate::tasks::TASK_LINKS_FILE_NAME);
        assert!(load_links_for_write(&p).unwrap().links.is_empty());
        let mut f = LinksFile::default();
        f.links.insert("s".into(), TaskLink { task_id: Some("A".into()), source: LinkSource::Llm, reason: "r".into(), confidence: Some(0.5), at: "t".into() });
        save_links(&p, &f).unwrap();
        assert_eq!(load_links(&p).file, f);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"source\": \"llm\""), "{text}");
        std::fs::write(&p, "[]").unwrap();
        assert!(load_links_for_write(&p).unwrap_err().to_string().contains("書き換えません"));
        assert!(!load_links(&p).warnings.is_empty());
    }
}
