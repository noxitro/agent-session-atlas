//! セッションとタスクの紐づけ(<notes-dir>/task-links.json)。1 つのセッションは、いくつかのタスクに紐づくことがある
//! (1 つのタスクにも、いくつものセッションが紐づく)。紐づくタスクの数には上限(MAX_TASKS_PER_SESSION)を置く。
//! 紐づけの出所は 3 つで、セッションごとに 1 つ。手動(画面で選んだもの)> LLM(頼んだときだけ。外部の LLM の返答を取り込んだもの)> 機械(集計のたびに決め直す)の順に優先する。
//! 機械の紐づけ(決まった規則。LLM は使わない):
//! - セッションの題名と、依頼の文(最初の依頼と、記録した各依頼の先頭)から探す。VCS のコミットの文は見ない
//! - タスクの ID: 前後が英数字でない所に、ID がそのまま出てくる(日本語の文字は区切りとみなす。2 文字未満の ID は探さない)。
//!   数字だけの ID は、前に # を付けて書いたもの(#101)だけを探す(ただの数字は件数や番号に当たりすぎる)。
//!   # を付けた番号は、リポジトリの PR や課題の番号にも当たりうる(数字だけの ID を使う環境では、その分だけ誤って紐づくことがある)
//! - タスクの名前: 正規化(NFKC・小文字・空白をまとめる)した文の中に、正規化した名前が出てくる(4 文字未満の名前は探さない)
//! - 当たりが重なるときは長い方だけを使う(DEMO-102-1 の中の DEMO-102、長い名前の中の短い名前は数えない)
//! - 候補は、未完了のタスクと、セッションを始めた後に完了を確認したタスク(始める前に終わったタスクには紐づけない)
//! - ID で当たったタスクだけなら、そのすべてに紐づける(ID をはっきり書いたもの)。
//!   ID の当たりが無く、名前で当たったタスクがちょうど 1 つなら、そのタスクに紐づける。
//!   当たりが無ければ決めない。名前だけの当たりがあって、当たったタスクが 2 つ以上なら決めない(LLM に任せられる)。上限を超えたときも決めない
//! - 手動の紐づけと、LLM がタスクを選んだ紐づけは変えない。LLM が「どのタスクでもない」とした紐づけは、機械の当たりが決まれば置き換える
//!
//! 書き込みは壊れたファイルを上書きしない(直してもらう)。書き手(画面・LLM の返答の取り込み・集計)は別のプロセスのこともあるので、
//! update_links でファイルのロックを取り、読み直してから自分の変更だけを足して書く。

use super::state::{TaskState, TasksFile};
use super::{read_json_file, write_atomic};
use aho_corasick::{AhoCorasick, MatchKind};
use anyhow::{bail, Result};
use atlas_core::types::SessionRecord;
use indexmap::IndexMap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// task-links.json の版。2 で紐づけを taskIds(いくつかのタスク)にした。1 の taskId(1 つか null)も読み、書くのは 2 の形だけ
pub const LINKS_VERSION: u32 = 2;
/// 読める前の版
const LINKS_VERSION_OLD: u32 = 1;
/// 1 つのセッションに紐づけるタスクの数の上限。誤った当たりや壊れた記録で並びが長くならないための安全のための上限で、
/// どこかの環境の件数に合わせたものではない(機械の紐づけはこれを超えたら決めず、LLM の答え・画面・送った人の記録も超えた分を受け付けない)
pub const MAX_TASKS_PER_SESSION: usize = 10;
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
#[serde(rename_all = "camelCase", from = "RawTaskLink")]
pub struct TaskLink {
    /// 紐づけたタスク(並びは決めた順。重なりなし、上限まで)。空は「どのタスクでもない」(手動か LLM が決めたもの)
    pub task_ids: Vec<String>,
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

/// 読むときの形: 版 2 の taskIds か、版 1 の taskId(1 つか null。0 か 1 件の並びとして読む)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTaskLink {
    #[serde(default)]
    task_ids: Option<Vec<String>>,
    #[serde(default)]
    task_id: Option<String>,
    source: LinkSource,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    confidence: Option<f64>,
    at: String,
}

impl From<RawTaskLink> for TaskLink {
    fn from(r: RawTaskLink) -> Self {
        let ids = r.task_ids.unwrap_or_else(|| r.task_id.into_iter().collect());
        TaskLink { task_ids: tidy_ids(ids), source: r.source, reason: r.reason, confidence: r.confidence, at: r.at }
    }
}

/// タスクの ID の並びを整える: 前後の空白を除き、空のものと重なりを除いて、並びを保ったまま上限(MAX_TASKS_PER_SESSION)まで
pub fn tidy_ids<S: AsRef<str>>(ids: impl IntoIterator<Item = S>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let t = atlas_core::js::trim(id.as_ref());
        if t.is_empty() || out.iter().any(|x| x == t) {
            continue;
        }
        if out.len() == MAX_TASKS_PER_SESSION {
            break;
        }
        out.push(t.to_string());
    }
    out
}

impl TaskLink {
    /// 「どのタスクでもない」(手動か LLM が決めた、タスクの無い紐づけ)
    pub fn is_none(&self) -> bool {
        self.task_ids.is_empty()
    }
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
    let mut f: LinksFile = serde_json::from_value(v).map_err(|e| format!("{} の形が違います({e})", path.display()))?;
    if f.version != LINKS_VERSION && f.version != LINKS_VERSION_OLD {
        return Err(format!("{} の版 {} は読めません(この atlas が読めるのは {LINKS_VERSION_OLD} と {LINKS_VERSION})", path.display(), f.version));
    }
    // 前の版の形で読んだものも、書くときは今の版の形にする
    f.version = LINKS_VERSION;
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
    /// 最後の活動の時刻(ミリ秒。sessions.json の updatedAt)。LLM に渡す候補の並びに使う
    pub end_ms: Option<i64>,
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
            end_ms: r.updated_at.as_deref().filter(|s| !s.is_empty()).and_then(atlas_core::jsdate::parse_ms),
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

/// どこに当たったか(小さいほど強い。理由の文に使う)。0・1 は ID、2・3 は名前
const REASONS: [&str; 4] = ["ID が題名にある", "ID が依頼にある", "タスク名が題名にある", "タスク名が依頼にある"];
/// ID でいくつかのタスクに当たり、題名にも依頼にも ID があったとき
const REASON_IDS_BOTH: &str = "ID が題名と依頼にある";

/// 機械の紐づけの結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineMatch {
    /// 紐づける(ID で当たったタスクのすべてか、名前だけで当たった 1 つのタスク。並びは XML の順)
    Linked { task_ids: Vec<String>, reason: String },
    None,
    /// 決めない(名前だけの当たりがあって 2 つ以上のタスクに当たった・上限を超えた。当たったタスクの ID)
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
        let id_of = |i: usize| self.tasks[i].0.to_string();
        if found.is_empty() {
            return MachineMatch::None;
        }
        if found.len() > MAX_TASKS_PER_SESSION {
            return MachineMatch::Many(found.iter().map(|(i, _)| id_of(*i)).collect());
        }
        // ID で当たったタスク(題名 0・依頼 1)と、名前だけで当たったタスク(2・3)
        let (by_id, name_only): (Vec<_>, Vec<_>) = found.iter().copied().partition(|(_, rank)| *rank < 2);
        match (by_id.as_slice(), name_only.as_slice()) {
            ([(i, rank)], []) | ([], [(i, rank)]) => MachineMatch::Linked { task_ids: vec![id_of(*i)], reason: REASONS[*rank].to_string() },
            (ids, []) => {
                let reason = if ids.iter().all(|(_, r)| *r == 0) {
                    REASONS[0]
                } else if ids.iter().all(|(_, r)| *r == 1) {
                    REASONS[1]
                } else {
                    REASON_IDS_BOTH
                };
                MachineMatch::Linked { task_ids: ids.iter().map(|(i, _)| id_of(*i)).collect(), reason: reason.to_string() }
            }
            _ => MachineMatch::Many(found.iter().map(|(i, _)| id_of(*i)).collect()),
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
    /// 名前だけの当たりがあって 2 つ以上のタスクに当たった(か上限を超えた)ので決めなかった
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

/// 機械が変えない紐づけ: 手動と、LLM がタスクを選んだもの(LLM が「どのタスクでもない」としたものは、機械の当たりが決まれば置き換える)
pub fn is_fixed(l: &TaskLink) -> bool {
    l.source == LinkSource::Manual || (l.source == LinkSource::Llm && !l.is_none())
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
        // LLM の「どのタスクでもない」は、機械の当たりが決まったときだけ置き換え、決まらなければ残す
        let llm_none = links.links.get(&s.id).is_some_and(|l| l.source == LinkSource::Llm);
        if llm_none && !matches!(r, MachineMatch::Linked { .. }) {
            sum.kept += 1;
            continue;
        }
        match r {
            MachineMatch::Linked { task_ids, reason } => {
                sum.linked += 1;
                let same = links.links.get(&s.id).is_some_and(|l| l.source == LinkSource::Machine && l.task_ids == task_ids && l.reason == reason);
                if !same {
                    sum.updated += 1;
                    links.links.insert(s.id.clone(), TaskLink { task_ids, source: LinkSource::Machine, reason, confidence: None, at: now.to_string() });
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

/// LLM に頼むセッションか(`tasks bundle` が束に入れるものと、画面に出す件数が同じこの決め方を使う):
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

/// LLM に渡す候補を決める材料
#[derive(Debug, Clone, Copy, Default)]
pub struct CandidateQuery<'a> {
    /// セッションを始めた時刻(始める前に完了したタスクは候補にしない)
    pub start_ms: Option<i64>,
    /// セッションの最後の活動の時刻(完了したタスクの並びに使う。無ければ start_ms)
    pub end_ms: Option<i64>,
    /// セッションの題名と依頼の文(パケットに書くのと同じ文)。タスクの名前との文字の重なりを数える
    pub text: &'a str,
    /// 機械の紐づけで決めなかったときに当たったタスク(先頭に置く)
    pub first: &'a [String],
}

/// LLM に渡す候補(ID と名前。上限まで)と、切る前の候補の数
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LlmCandidates {
    pub items: Vec<(String, String)>,
    /// 候補になるタスクの数(上限で切る前)。items より多ければ切った
    pub total: usize,
}

/// 文字 bigram: 正規化(normalize)した文の、隣り合う 2 文字の組。どちらも文字か数字の組だけ(空白・記号をまたがない)。
/// 分かち書きの無い日本語でも、単語で区切る英語でも同じ決め方で働く
pub fn char_bigrams(s: &str) -> HashSet<(char, char)> {
    let n: Vec<char> = normalize(s).chars().collect();
    n.windows(2).filter(|w| w[0].is_alphanumeric() && w[1].is_alphanumeric()).map(|w| (w[0], w[1])).collect()
}

/// タスクの名前の文字 bigram のうち、セッションの文(text の bigram)にもあるものの数(重なり)
pub fn bigram_overlap(name: &str, text: &HashSet<(char, char)>) -> usize {
    char_bigrams(name).iter().filter(|g| text.contains(g)).count()
}

/// 並べるときの鍵: (機械の当たりなら 0, 重なりの多い順, 未完了 1・完了 2・XML から消えた 3, 完了の隔たり, XML の順)
type CandidateKey = (u8, std::cmp::Reverse<usize>, u8, i64, usize);

/// LLM に渡す候補。候補になるタスク(is_candidate)を次の順に並べ、上限(LLM_CANDIDATES_MAX)で切る(決まった規則。LLM は使わない)。
/// 1. 機械の紐づけで決めなかったときに当たったタスク(first。XML の順)
/// 2. 残りは、セッションの題名と依頼の文と、タスクの名前の文字 bigram の重なり(bigram_overlap)の多い順。
///    重なりが同じものは、未完了で XML にあるもの → 完了を確認した時刻がセッションの最後の活動(end_ms。無ければ start_ms)に近いもの →
///    XML から消えたもの。それでも同じものは XML の順
///
/// 完了の早い順にしないのは、何日もかけて終えたタスク(完了の確認がセッションの開始から遠いもの)が、
/// 開始の後に完了した多くのタスクの後ろに回って、上限で漏れないようにするため
pub fn llm_candidates(state: &TasksFile, q: &CandidateQuery<'_>) -> LlmCandidates {
    let text = char_bigrams(q.text);
    let reference = q.end_ms.or(q.start_ms);
    let mut c: Vec<(CandidateKey, &str, &TaskState)> = state
        .tasks
        .iter()
        .enumerate()
        .filter(|(_, (_, t))| is_candidate(t, q.start_ms))
        .map(|(i, (id, t))| {
            if q.first.iter().any(|f| f == id) {
                return ((0, std::cmp::Reverse(0), 0, 0, i), id.as_str(), t);
            }
            let group = if t.missing {
                3
            } else if t.done {
                2
            } else {
                1
            };
            // 完了したものは、最後の活動からの隔たり。セッションの時刻が分からなければ完了の早い順、完了の時刻が分からないものは後ろ
            let dist = match (group, t.done_at.as_deref().and_then(atlas_core::jsdate::parse_ms), reference) {
                (2, Some(d), Some(r)) => (d - r).abs(),
                (2, Some(d), None) => d,
                (2, None, _) => i64::MAX,
                _ => 0,
            };
            ((1, std::cmp::Reverse(bigram_overlap(&t.name, &text)), group, dist, i), id.as_str(), t)
        })
        .collect();
    let total = c.len();
    c.sort_by_key(|x| x.0);
    LlmCandidates { items: c.into_iter().take(LLM_CANDIDATES_MAX).map(|x| (x.1.to_string(), x.2.name.clone())).collect(), total }
}

/// セッション id → 紐づいたタスク(「どのタスクでもない」は入れない)
pub fn linked_tasks(links: &LinksFile) -> HashMap<&str, (&[String], LinkSource)> {
    links.links.iter().filter(|(_, l)| !l.is_none()).map(|(sid, l)| (sid.as_str(), (l.task_ids.as_slice(), l.source))).collect()
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
        SessionText { id: id.into(), start_ms: atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z"), title: title.into(), prompts: prompts.into(), ..Default::default() }
    }

    fn st() -> TasksFile {
        state(&[("ABC-12", task("ログイン画面の不具合", None)), ("ABC-123", task("一覧の並び替え", None)), ("7", task("短いID", None)), ("XY-9", task("帳票の出力", None))])
    }

    #[test]
    fn id_token_boundaries() {
        let s = st();
        let m = Matcher::new(&s);
        let one = |t: &str, p: &str| m.match_session(&sess("s", t, p));
        assert_eq!(one("ABC-12 を直す", ""), MachineMatch::Linked { task_ids: vec!["ABC-12".into()], reason: "ID が題名にある".into() });
        // 日本語の文字は区切り。全角・小文字も同じ ID
        assert_eq!(one("", "これはabc-12の件"), MachineMatch::Linked { task_ids: vec!["ABC-12".into()], reason: "ID が依頼にある".into() });
        assert_eq!(one("ＡＢＣ－１２", ""), MachineMatch::Linked { task_ids: vec!["ABC-12".into()], reason: "ID が題名にある".into() });
        // ABC-123 の中の ABC-12 は当たらない(後ろが数字)。ABC-123 だけ
        assert_eq!(one("ABC-123", ""), MachineMatch::Linked { task_ids: vec!["ABC-123".into()], reason: "ID が題名にある".into() });
        // 前後が英数字なら当たらない
        assert_eq!(one("xABC-12", "ABC-12x"), MachineMatch::None);
        // 2 文字未満の ID は探さない
        assert_eq!(one("7 件の修正", ""), MachineMatch::None);
        // 区切りの記号の隣は当たる
        assert_eq!(one("[XY-9]", ""), MachineMatch::Linked { task_ids: vec!["XY-9".into()], reason: "ID が題名にある".into() });
    }

    /// 数字だけの ID は #<数字> の形だけを探す
    #[test]
    fn digit_ids_need_a_hash() {
        let s = state(&[("101", task("数字だけの番号", None)), ("7", task("一桁の番号", None))]);
        let m = Matcher::new(&s);
        let one = |t: &str| m.match_session(&sess("s", t, ""));
        assert_eq!(one("101 件を直す"), MachineMatch::None);
        assert_eq!(one("ID 101"), MachineMatch::None);
        assert_eq!(one("#101 を直す"), MachineMatch::Linked { task_ids: vec!["101".into()], reason: "ID が題名にある".into() });
        // # の前は見ない(区切りは # 自身)。後ろが数字や英字なら当たらない
        assert_eq!(one("PR#101"), MachineMatch::Linked { task_ids: vec!["101".into()], reason: "ID が題名にある".into() });
        assert_eq!(one("#1010"), MachineMatch::None);
        assert_eq!(one("#101a"), MachineMatch::None);
        // 全角の #・数字も同じ。2 文字未満の数字の ID は # を付けても探さない
        assert_eq!(one("＃１０１"), MachineMatch::Linked { task_ids: vec!["101".into()], reason: "ID が題名にある".into() });
        assert_eq!(one("#7 を直す"), MachineMatch::None);
    }

    /// 当たりが重なるときは長い方だけ(e2e の書き出しの DEMO-102 と DEMO-102-1 も)
    #[test]
    fn overlapping_matches_prefer_the_longest() {
        let s = state(&[("DEMO-102", task("Improve the synthetic project", None)), ("DEMO-102-1", task("入れ子のサブタスク", None))]);
        let m = Matcher::new(&s);
        assert_eq!(m.match_session(&sess("s", "DEMO-102-1 を直す", "")), MachineMatch::Linked { task_ids: vec!["DEMO-102-1".into()], reason: "ID が題名にある".into() });
        assert_eq!(m.match_session(&sess("s", "DEMO-102 を直す", "")), MachineMatch::Linked { task_ids: vec!["DEMO-102".into()], reason: "ID が題名にある".into() });
        // 別の場所に両方の ID があれば、2 つに紐づける(並びは XML の順)
        assert_eq!(m.match_session(&sess("s", "DEMO-102-1 と DEMO-102", "")), MachineMatch::Linked { task_ids: vec!["DEMO-102".into(), "DEMO-102-1".into()], reason: "ID が題名にある".into() });
        // 名前も、長い名前の中の短い名前は数えない
        let s2 = state(&[("A", task("帳票の出力", None)), ("B", task("帳票の出力を速くする", None))]);
        let m2 = Matcher::new(&s2);
        assert_eq!(m2.match_session(&sess("s", "", "帳票の出力を速くする件")), MachineMatch::Linked { task_ids: vec!["B".into()], reason: "タスク名が依頼にある".into() });
        assert_eq!(m2.match_session(&sess("s", "", "帳票の出力の件")), MachineMatch::Linked { task_ids: vec!["A".into()], reason: "タスク名が依頼にある".into() });
        // 同じ名前の 2 つのタスクは決めない
        let s3 = state(&[("A", task("同じ名前のタスク", None)), ("B", task("同じ名前のタスク", None))]);
        assert!(matches!(Matcher::new(&s3).match_session(&sess("s", "同じ名前のタスク", "")), MachineMatch::Many(_)));
    }

    /// 書き手は、ロックの中で読み直して自分の変更だけを足す(別の書き手が書いた手動の紐づけを消さない)
    #[test]
    fn update_links_merges_with_other_writers() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(crate::tasks::TASK_LINKS_FILE_NAME);
        let manual = TaskLink { task_ids: vec!["A".into()], source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t".into() };
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
        assert_eq!(m.match_session(&sess("s", "", "まず ログイン画面の不具合 を見て")), MachineMatch::Linked { task_ids: vec!["ABC-12".into()], reason: "タスク名が依頼にある".into() });
        // 空白の違い(改行・続いた空白)はまとめて比べる
        let s2 = state(&[("N-1", task("Export  the   Report", None))]);
        let m2 = Matcher::new(&s2);
        assert!(matches!(m2.match_session(&sess("s", "please export the\nreport now", "")), MachineMatch::Linked { .. }));
        // 4 文字未満の名前は探さない
        let s3 = state(&[("N-2", task("帳票", None))]);
        assert_eq!(Matcher::new(&s3).match_session(&sess("s", "帳票を直す", "")), MachineMatch::None);
        // ID と名前の両方で同じタスクに当たれば 1 つ。理由は強い方(ID・題名)
        assert_eq!(m.match_session(&sess("s", "ABC-12", "ログイン画面の不具合")), MachineMatch::Linked { task_ids: vec!["ABC-12".into()], reason: "ID が題名にある".into() });
    }

    /// ID だけで当たればすべてに紐づける。名前だけの当たりが混じって 2 つ以上なら決めない。上限を超えても決めない
    #[test]
    fn several_ids_link_all_and_names_stay_ambiguous() {
        let s = st();
        let m = Matcher::new(&s);
        let linked = |ids: &[&str], reason: &str| MachineMatch::Linked { task_ids: ids.iter().map(|x| x.to_string()).collect(), reason: reason.into() };
        assert_eq!(m.match_session(&sess("s", "XY-9 と ABC-12", "")), linked(&["ABC-12", "XY-9"], "ID が題名にある"));
        assert_eq!(m.match_session(&sess("s", "", "ABC-12 と XY-9 をまとめて")), linked(&["ABC-12", "XY-9"], "ID が依頼にある"));
        assert_eq!(m.match_session(&sess("s", "ABC-12", "XY-9 も")), linked(&["ABC-12", "XY-9"], "ID が題名と依頼にある"));
        // 同じタスクの ID と名前は 1 つの当たり(ID の当たり)
        assert_eq!(m.match_session(&sess("s", "ABC-12 XY-9", "ログイン画面の不具合")), linked(&["ABC-12", "XY-9"], "ID が題名にある"));
        // 名前だけで 1 つなら紐づける。ID の当たりに、ほかのタスクの名前の当たりが混じれば決めない
        assert_eq!(m.match_session(&sess("s", "", "帳票の出力")), linked(&["XY-9"], "タスク名が依頼にある"));
        match m.match_session(&sess("s", "ABC-12", "帳票の出力")) {
            MachineMatch::Many(ids) => assert_eq!(ids, ["ABC-12", "XY-9"]),
            other => panic!("{other:?}"),
        }
        // 名前だけで 2 つ
        assert!(matches!(m.match_session(&sess("s", "ログイン画面の不具合と帳票の出力", "")), MachineMatch::Many(_)));
        // 上限を超えた ID の当たりは決めない(上限ちょうどなら紐づける)
        let many: Vec<(String, TaskState)> = (0..=MAX_TASKS_PER_SESSION).map(|i| (format!("T-{i}"), task(&format!("仕事の名前 {i}"), None))).collect();
        let big = TasksFile { tasks: many.into_iter().collect(), ..Default::default() };
        let mb = Matcher::new(&big);
        let all: Vec<String> = (0..=MAX_TASKS_PER_SESSION).map(|i| format!("T-{i}")).collect();
        assert!(matches!(mb.match_session(&sess("s", &all.join(" "), "")), MachineMatch::Many(ids) if ids.len() == MAX_TASKS_PER_SESSION + 1));
        assert!(matches!(mb.match_session(&sess("s", &all[..MAX_TASKS_PER_SESSION].join(" "), "")), MachineMatch::Linked { task_ids, .. } if task_ids.len() == MAX_TASKS_PER_SESSION));
    }

    #[test]
    fn ambiguity_and_candidates() {
        let s = st();
        let m = Matcher::new(&s);
        match m.match_session(&sess("s", "ログイン画面の不具合 と XY-9", "")) {
            MachineMatch::Many(ids) => assert_eq!(ids, ["ABC-12", "XY-9"]),
            other => panic!("{other:?}"),
        }
        // セッションを始める前に完了を確認したタスクは候補にしない。始めた後に完了したものは候補
        let s2 = state(&[("OLD-1", task("前に終わった仕事", Some("2026-11-05T00:00:00.000Z"))), ("NEW-1", task("後で終わった仕事", Some("2026-11-12T00:00:00.000Z")))]);
        let m2 = Matcher::new(&s2);
        assert_eq!(m2.match_session(&sess("s", "OLD-1", "")), MachineMatch::None);
        assert_eq!(m2.match_session(&sess("s", "OLD-1 NEW-1", "")), MachineMatch::Linked { task_ids: vec!["NEW-1".into()], reason: "ID が題名にある".into() });
        // 始めた時刻が分からなければ候補に入れる
        let mut unknown = sess("s", "OLD-1", "");
        unknown.start_ms = None;
        assert!(matches!(m2.match_session(&unknown), MachineMatch::Linked { .. }));
        assert!(is_candidate(&task("x", None), None));
    }

    #[test]
    fn machine_never_overrides_llm_or_manual_and_is_recomputed() {
        let s = st();
        let mut links = LinksFile::default();
        links.links.insert("m".into(), TaskLink { task_ids: vec!["XY-9".into()], source: LinkSource::Manual, reason: String::new(), confidence: None, at: "t0".into() });
        let llm = |t: Option<&str>| TaskLink { task_ids: t.map(str::to_string).into_iter().collect(), source: LinkSource::Llm, reason: "LLM".into(), confidence: Some(0.8), at: "t0".into() };
        // LLM がタスクを選んだもの(機械は変えない)と、「どのタスクでもない」としたもの(機械の当たりが 1 つに決まれば置き換える・決まらなければ残す)
        links.links.insert("lt".into(), llm(Some("XY-9")));
        links.links.insert("ln".into(), llm(None));
        links.links.insert("ln2".into(), llm(None));
        links.links.insert("old".into(), TaskLink { task_ids: vec!["ABC-123".into()], source: LinkSource::Machine, reason: "ID が題名にある".into(), confidence: None, at: "t0".into() });
        let sessions = vec![
            sess("m", "ABC-12", ""),
            sess("lt", "ABC-12", ""),
            sess("ln", "ABC-12", ""),
            sess("ln2", "当たらない", ""),
            sess("old", "もう当たらない", ""),
            sess("new", "ABC-12", ""),
            sess("both", "ABC-12 XY-9", ""),
            sess("two", "ログイン画面の不具合 XY-9", ""),
        ];
        let sum = apply_machine(&mut links, &sessions, &s, "t1");
        assert_eq!(sum, MachineSummary { linked: 3, updated: 3, unmatched: 1, ambiguous: 1, kept: 3, removed: 1 });
        assert_eq!(links.links["both"].task_ids, ["ABC-12", "XY-9"]);
        assert_eq!(links.links["both"].reason, "ID が題名にある");
        assert_eq!(links.links["m"].task_ids.first().map(String::as_str), Some("XY-9"));
        assert_eq!(links.links["lt"].task_ids.first().map(String::as_str), Some("XY-9"));
        assert_eq!((links.links["ln"].task_ids.first().map(String::as_str), links.links["ln"].source), (Some("ABC-12"), LinkSource::Machine));
        assert_eq!((links.links["ln2"].task_ids.first().map(String::as_str), links.links["ln2"].source), (None, LinkSource::Llm));
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
        assert_eq!(lt.get("m"), Some(&(&["XY-9".to_string()][..], LinkSource::Manual)));
        assert_eq!(lt["both"].0.len(), 2);
        assert!(!lt.contains_key("ln2"));
    }

    /// LLM に頼むセッションの決め方(tasks bundle の対象と画面の件数が同じ)
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
        l.links.insert("a".into(), TaskLink { task_ids: vec![], source: LinkSource::Llm, reason: String::new(), confidence: None, at: "t".into() });
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
        let start = atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z");
        let c = llm_candidates(&s, &CandidateQuery { start_ms: start, ..Default::default() });
        assert_eq!((c.items.len(), c.total), (LLM_CANDIDATES_MAX, LLM_CANDIDATES_MAX + 23));
        assert_eq!(c.items[0].0, "T-0");
        // 機械の紐づけで 2 つ以上に当たったタスクを先に(上限で切られないように)
        let late = format!("T-{}", LLM_CANDIDATES_MAX + 10);
        let first = [late.clone(), "GONE".into()];
        let c = llm_candidates(&s, &CandidateQuery { start_ms: start, first: &first, ..Default::default() }).items;
        assert_eq!((c[0].0.as_str(), c[1].0.as_str(), c[2].0.as_str()), ("GONE", late.as_str(), "T-0"));
        assert_eq!(c.len(), LLM_CANDIDATES_MAX);
        // セッションの時刻が分からなければ、重なりが同じ完了は早い順
        let small = state(&[("GONE", TaskState { missing: true, ..task("消えた", None) }), ("D-2", task("b", Some("2026-11-20T00:00:00.000Z"))), ("D-1", task("a", Some("2026-11-15T00:00:00.000Z"))), ("O", task("o", None))]);
        let ids = |s: &TasksFile, q: &CandidateQuery<'_>| llm_candidates(s, q).items.into_iter().map(|x| x.0).collect::<Vec<_>>();
        assert_eq!(ids(&small, &CandidateQuery::default()), ["O", "D-1", "D-2", "GONE"]);
        // 重なりが同じ完了は、セッションの最後の活動に近い順(完了の早い順ではない)。最後の活動が無ければ開始に近い順
        let end = atlas_core::jsdate::parse_ms("2026-11-19T00:00:00Z");
        assert_eq!(ids(&small, &CandidateQuery { start_ms: start, end_ms: end, ..Default::default() }), ["O", "D-2", "D-1", "GONE"]);
        assert_eq!(ids(&small, &CandidateQuery { start_ms: start, ..Default::default() }), ["O", "D-1", "D-2", "GONE"]);
    }

    /// 完了の遅いタスクも、題名と依頼の文との文字の重なりで上限の中に入る。機械の当たりは重なりより前
    #[test]
    fn llm_candidates_rank_by_text_overlap() {
        let start = atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z");
        // 開始の後に完了した多くのタスク(完了の早いもの)と、何日もかけて終えたタスク(完了が遅い)
        let mut items: Vec<(String, TaskState)> = (0..LLM_CANDIDATES_MAX + 30).map(|i| (format!("E-{i}"), task(&format!("定例の作業 {i}"), Some("2026-11-11T00:00:00.000Z")))).collect();
        items.push(("SLOW".into(), task("帳票の出力を速くする", Some("2026-11-28T00:00:00.000Z"))));
        items.push(("SLOW-EN".into(), task("Speed up the report export", Some("2026-11-29T00:00:00.000Z"))));
        let s = TasksFile { tasks: items.into_iter().collect(), ..Default::default() };
        // 重なりが無ければ、完了の遅いタスクは上限の外
        let none = llm_candidates(&s, &CandidateQuery { start_ms: start, end_ms: start, text: "関係のない話", ..Default::default() });
        assert!(!none.items.iter().any(|x| x.0 == "SLOW" || x.0 == "SLOW-EN"));
        assert_eq!(none.total, LLM_CANDIDATES_MAX + 32);
        // 日本語の題名・英語の依頼との重なりで先頭へ
        let text = "題名: 帳票の出力が遅い\n依頼 1: export of the report is slow";
        let c = llm_candidates(&s, &CandidateQuery { start_ms: start, end_ms: start, text, ..Default::default() }).items;
        // 英語の名前は 9 組(th・he・re・ep・po・or・rt・ex・xp)、日本語の名前は 4 組(帳票・票の・の出・出力)が重なる
        assert_eq!((c[0].0.as_str(), c[1].0.as_str()), ("SLOW-EN", "SLOW"), "{:?}", &c[..3]);
        // 機械の当たり(first)は重なりより前
        let first = ["E-5".to_string()];
        let c = llm_candidates(&s, &CandidateQuery { start_ms: start, end_ms: start, text, first: &first }).items;
        assert_eq!((c[0].0.as_str(), c[1].0.as_str(), c[2].0.as_str()), ("E-5", "SLOW-EN", "SLOW"));
        assert_eq!(c.len(), LLM_CANDIDATES_MAX);
        // 重なりが同じなら、未完了 → 完了(最後の活動に近い順)→ XML から消えたもの
        let tie = state(&[
            ("GONE", TaskState { missing: true, ..task("帳票の修正", None) }),
            ("FAR", task("帳票の確認", Some("2026-11-12T00:00:00.000Z"))),
            ("NEAR", task("帳票の追加", Some("2026-11-25T00:00:00.000Z"))),
            ("OPEN", task("帳票の整理", None)),
            ("ZERO", task("別の仕事", None)),
        ]);
        let ids: Vec<String> = llm_candidates(&tie, &CandidateQuery { start_ms: start, end_ms: atlas_core::jsdate::parse_ms("2026-11-24T00:00:00Z"), text: "帳票", ..Default::default() }).items.into_iter().map(|x| x.0).collect();
        assert_eq!(ids, ["OPEN", "NEAR", "FAR", "GONE", "ZERO"]);
        // bigram は空白と記号をまたがない
        assert_eq!(char_bigrams("ab c-d"), HashSet::from([('a', 'b')]));
        assert_eq!(bigram_overlap("Ｒｅｐｏｒｔ", &char_bigrams("report")), 5);
    }

    #[test]
    fn files_round_trip_and_refuse_broken() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(crate::tasks::TASK_LINKS_FILE_NAME);
        assert!(load_links_for_write(&p).unwrap().links.is_empty());
        let mut f = LinksFile::default();
        f.links.insert("s".into(), TaskLink { task_ids: vec!["A".into()], source: LinkSource::Llm, reason: "r".into(), confidence: Some(0.5), at: "t".into() });
        save_links(&p, &f).unwrap();
        assert_eq!(load_links(&p).file, f);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"source\": \"llm\""), "{text}");
        assert!(text.contains("\"taskIds\": [\n        \"A\"\n      ]") && !text.contains("\"taskId\""), "{text}");
        assert!(text.contains(&format!("\"version\": {LINKS_VERSION}")));
        std::fs::write(&p, "[]").unwrap();
        assert!(load_links_for_write(&p).unwrap_err().to_string().contains("書き換えません"));
        assert!(!load_links(&p).warnings.is_empty());
        // 知らない版は読まない
        std::fs::write(&p, serde_json::json!({ "version": 99, "links": {} }).to_string()).unwrap();
        assert!(load_links_for_write(&p).is_err());
    }

    /// 前の版(taskId が 1 つか null)のファイルも読み、0 か 1 件の並びにする。書くのは今の版の形だけ。
    /// 並びは整える(空白・空・重なりを除き、上限まで)
    #[test]
    fn reads_old_single_task_files_and_writes_the_new_form() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(crate::tasks::TASK_LINKS_FILE_NAME);
        let many: Vec<String> = (0..MAX_TASKS_PER_SESSION + 3).map(|i| format!("T-{i}")).collect();
        std::fs::write(
            &p,
            serde_json::json!({ "version": 1, "links": {
                "a": { "taskId": "T-1", "source": "machine", "reason": "ID が題名にある", "at": "t" },
                "b": { "taskId": null, "source": "manual", "reason": "", "at": "t" },
                "c": { "taskIds": [" T-2 ", "", "T-3", "T-2"], "source": "llm", "reason": "r", "confidence": 0.5, "at": "t" },
                "d": { "taskIds": many, "source": "manual", "at": "t" }
            } })
            .to_string(),
        )
        .unwrap();
        let f = load_links(&p);
        assert!(f.warnings.is_empty(), "{:?}", f.warnings);
        let l = &f.file.links;
        assert_eq!(l["a"].task_ids, ["T-1"]);
        assert!(l["b"].is_none() && l["b"].source == LinkSource::Manual);
        assert_eq!(l["c"].task_ids, ["T-2", "T-3"]);
        assert_eq!(l["d"].task_ids.len(), MAX_TASKS_PER_SESSION);
        assert_eq!(f.file.version, LINKS_VERSION);
        // 何かを直して書けば、今の版の形になる
        update_links(&p, |x| {
            x.links.shift_remove("d");
        })
        .unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("\"taskId\"") && text.contains("\"taskIds\": []"), "{text}");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap()["version"], LINKS_VERSION);
        assert_eq!(tidy_ids(["a", " a", "b", ""]), ["a", "b"]);
    }
}
