//! AI が作った変更(ai_changes.rs)が、開始時の基準と照合した時点のファイルの差に残っているかを、変更のまとまりごとに分ける
//! (packages/core/src/vcs-retention.ts の移植)。
//!
//! 分け方(まとまり = AI の diff の連続した追加行):
//! - kept(そのまま残る): 数えた行がすべて、照合した時点のファイルに同じ本文である
//! - modified(直されて残る): 一部の行が残っている、または空白の違い・似た本文(文字の 2 字組の重なり)で残っている
//! - missing(見つからない): ファイルは照合できたが、どの行も照合した時点のファイルに見つからない
//! - unattributable(照合不可): リポジトリが無い・基準が決まらない・読めない・ほかのセッションと行が重なる
//!
//! 数える行: 空白だけの行と、開始時の基準のファイルにもともとあった行は除く(多重集合で数える)。
//! 比べる相手: 照合した時点のファイルから基準のファイルの行を除いた「差分で増えた行」(多重集合)。1 つの行は 1 回しか使わない。
//! 二重計上を防ぐ:
//! - 同じファイルの同じ本文の行を、時間の重なる別のセッションの AI も足していたら、そのまとまりは照合不可(concurrent_session)
//! - 後のセッションの AI も同じ本文の行を足していたら、その行は後のセッションの分として数え、前のセッションでは照合不可(later_session)にする

use crate::ai_changes::{AiChangeSet, AiHunk};
use crate::classify::file_path_key;
use crate::js::{self, lone_surrogate_unit, JsMap};
use crate::jsdate;
use crate::nodepath::platform;
use crate::vcs::{default_runner, nearest_existing_dir, open_repo, EvalMode, Memo, NoRepo, OpenRepoResult, RepoCache, Revision, RevisionSource, VcsKind, VcsRepo, VcsRunner};
use indexmap::IndexMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

// ---------- 型 ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionStatus {
    Kept,
    Modified,
    Missing,
    Unattributable,
}

pub const RETENTION_STATUSES: [RetentionStatus; 4] = [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing, RetentionStatus::Unattributable];
/// RETENTION_STATUSES の名前(設定の vcs.labels のキー)
pub const RETENTION_STATUS_NAMES: [&str; 4] = ["kept", "modified", "missing", "unattributable"];

impl RetentionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RetentionStatus::Kept => "kept",
            RetentionStatus::Modified => "modified",
            RetentionStatus::Missing => "missing",
            RetentionStatus::Unattributable => "unattributable",
        }
    }

    pub fn parse(s: &str) -> Option<RetentionStatus> {
        RETENTION_STATUSES.into_iter().find(|k| k.as_str() == s)
    }

    /// RETENTION_STATUS_LABEL
    pub fn label(self) -> &'static str {
        match self {
            RetentionStatus::Kept => "そのまま残る",
            RetentionStatus::Modified => "直されて残る",
            RetentionStatus::Missing => "見つからない",
            RetentionStatus::Unattributable => "照合不可",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnattributableReason {
    RepoNotFound,
    NoVcs,
    BaselineMissing,
    OutsideRepo,
    ReadError,
    ConcurrentSession,
    LaterSession,
    NotMeasured,
    TooRecent,
    AfterMissing,
}

pub const UNATTRIBUTABLE_REASONS: [UnattributableReason; 10] = [
    UnattributableReason::RepoNotFound,
    UnattributableReason::NoVcs,
    UnattributableReason::BaselineMissing,
    UnattributableReason::OutsideRepo,
    UnattributableReason::ReadError,
    UnattributableReason::ConcurrentSession,
    UnattributableReason::LaterSession,
    UnattributableReason::NotMeasured,
    UnattributableReason::TooRecent,
    UnattributableReason::AfterMissing,
];

impl UnattributableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnattributableReason::RepoNotFound => "repo_not_found",
            UnattributableReason::NoVcs => "no_vcs",
            UnattributableReason::BaselineMissing => "baseline_missing",
            UnattributableReason::OutsideRepo => "outside_repo",
            UnattributableReason::ReadError => "read_error",
            UnattributableReason::ConcurrentSession => "concurrent_session",
            UnattributableReason::LaterSession => "later_session",
            UnattributableReason::NotMeasured => "not_measured",
            UnattributableReason::TooRecent => "too_recent",
            UnattributableReason::AfterMissing => "after_missing",
        }
    }

    pub fn parse(s: &str) -> Option<UnattributableReason> {
        UNATTRIBUTABLE_REASONS.into_iter().find(|k| k.as_str() == s)
    }

    /// UNATTRIBUTABLE_REASON_LABEL
    pub fn label(self) -> &'static str {
        match self {
            UnattributableReason::RepoNotFound => "作業フォルダがこの PC に無い",
            UnattributableReason::NoVcs => "VCS の管理下でない",
            UnattributableReason::BaselineMissing => "開始時の基準を決められない",
            UnattributableReason::OutsideRepo => "リポジトリの外のファイル",
            UnattributableReason::ReadError => "VCS かファイルを読めなかった",
            UnattributableReason::ConcurrentSession => "時間の重なる別のセッションと同じ行",
            UnattributableReason::LaterSession => "後のセッションも同じ行を足した",
            UnattributableReason::NotMeasured => "送った側で照合していない",
            UnattributableReason::TooRecent => "決まった日数がまだ経っていない",
            UnattributableReason::AfterMissing => "比べる版を決められない",
        }
    }
}

/// 行の内訳(状態ごとの数)。まとまりの数(counts)も同じ形
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineCounts {
    pub kept: i64,
    pub modified: i64,
    pub missing: i64,
    pub unattributable: i64,
}

impl LineCounts {
    pub fn get(&self, k: RetentionStatus) -> i64 {
        match k {
            RetentionStatus::Kept => self.kept,
            RetentionStatus::Modified => self.modified,
            RetentionStatus::Missing => self.missing,
            RetentionStatus::Unattributable => self.unattributable,
        }
    }

    pub fn get_mut(&mut self, k: RetentionStatus) -> &mut i64 {
        match k {
            RetentionStatus::Kept => &mut self.kept,
            RetentionStatus::Modified => &mut self.modified,
            RetentionStatus::Missing => &mut self.missing,
            RetentionStatus::Unattributable => &mut self.unattributable,
        }
    }

    pub fn add(&mut self, o: &LineCounts) {
        for k in RETENTION_STATUSES {
            *self.get_mut(k) += o.get(k);
        }
    }
}

/// 変更のまとまり 1 つの結果
#[derive(Debug, Clone, PartialEq)]
pub struct HunkRetention {
    pub id: i64,
    pub path: String,
    pub status: RetentionStatus,
    pub reason: Option<UnattributableReason>,
    /// 数えた行の内訳(基準にあった行・空白行は含めない)
    pub lines: LineCounts,
    /// そのまとまりを作った編集の時刻(ISO。工程ごとの集計で、どの依頼のものかを決めるのに使う)。記録が無ければ省略
    pub at: Option<String>,
    /// キーの順(TS がオブジェクトを組み立てた順)。true = id, path, status, lines, at, reason(送った側の結果を読み直したもの)
    pub reason_last: bool,
}

impl Serialize for HunkRetention {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("id", &self.id)?;
        m.serialize_entry("path", &self.path)?;
        m.serialize_entry("status", &self.status)?;
        if !self.reason_last {
            if let Some(r) = &self.reason {
                m.serialize_entry("reason", r)?;
            }
        }
        m.serialize_entry("lines", &self.lines)?;
        if let Some(a) = &self.at {
            m.serialize_entry("at", a)?;
        }
        if self.reason_last {
            if let Some(r) = &self.reason {
                m.serialize_entry("reason", r)?;
            }
        }
        m.end()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// 照合できたまとまりが 1 つ以上ある(分母に入る)
    Measured,
    /// 数える AI の変更が無い
    NoAiChanges,
    /// すべて照合不可
    Unattributable,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Measured => "measured",
            Outcome::NoAiChanges => "no_ai_changes",
            Outcome::Unattributable => "unattributable",
        }
    }
}

/// 照合した場所。local = この PC、sender = 送った側の PC(アップロードに添えられた結果を読んだ)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputedOn {
    Local,
    Sender,
}

impl ComputedOn {
    pub fn as_str(self) -> &'static str {
        match self {
            ComputedOn::Local => "local",
            ComputedOn::Sender => "sender",
        }
    }
}

/// 値の出所。events = events.jsonl(一次)、workspace = workspace.yaml(補完)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueSource {
    Events,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evaluated {
    pub mode: EvalMode,
    pub rev: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// いつも "events"
    pub ai_changes: String,
    pub baseline: Option<RevisionSource>,
    pub context: JsMap<ValueSource>,
}

/// セッション 1 つの結果(読み書きのキーの順は、下の Serialize・Deserialize の実装を参照)
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRetention {
    pub session_id: String,
    pub outcome: Outcome,
    /// outcome が unattributable のとき、いちばん多い理由
    pub reason: Option<UnattributableReason>,
    pub vcs: Option<VcsKind>,
    pub root: Option<String>,
    /// 開始時の基準(observed = ログの記録、estimated = 時刻から推定)
    pub baseline: Option<Revision>,
    pub evaluated: Option<Evaluated>,
    pub hunks: Vec<HunkRetention>,
    /// 基準にあった行だけでできていて、数えなかったまとまり
    pub excluded_hunks: i64,
    pub counts: LineCounts,
    pub lines: LineCounts,
    /// 値の出所
    pub provenance: Provenance,
    /// 作業フォルダとファイルのパスを、設定の対応づけ(vcs.pathMap)で読み替えたか(vcs_step.rs が付ける。付けるときは true)
    pub path_mapped: Option<bool>,
    /// 照合した場所(vcs_step.rs が付ける)
    pub computed_on: Option<ComputedOn>,
    /// セッションの終わり(最後のイベントの時刻)。照合した時点までの日数を出すのに使う。外の None はキーが無い
    pub session_end: Option<Option<String>>,
    /// AI の編集のうち、ログから変更を取り出せなかったもの(diff も引数も読めなかった)。ログの形が変わると増える
    pub unread_edits: Option<i64>,
    /// キーの順(TS がオブジェクトを組み立てた順)。true = 送った側の結果を読み直したもの
    /// (provenance の後に computedOn, pathMapped, sessionEnd, unreadEdits, reason)。
    /// false = この PC で照合したもの(provenance の後に sessionEnd, unreadEdits, reason, computedOn, pathMapped)
    pub sender_order: bool,
}

impl Serialize for SessionRetention {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("sessionId", &self.session_id)?;
        m.serialize_entry("outcome", &self.outcome)?;
        m.serialize_entry("vcs", &self.vcs)?;
        m.serialize_entry("root", &self.root)?;
        m.serialize_entry("baseline", &self.baseline)?;
        m.serialize_entry("evaluated", &self.evaluated)?;
        m.serialize_entry("hunks", &self.hunks)?;
        m.serialize_entry("excludedHunks", &self.excluded_hunks)?;
        m.serialize_entry("counts", &self.counts)?;
        m.serialize_entry("lines", &self.lines)?;
        m.serialize_entry("provenance", &self.provenance)?;
        let place = |m: &mut S::SerializeMap| -> Result<(), S::Error> {
            if let Some(c) = &self.computed_on {
                m.serialize_entry("computedOn", c)?;
            }
            if let Some(p) = &self.path_mapped {
                m.serialize_entry("pathMapped", p)?;
            }
            Ok(())
        };
        if self.sender_order {
            place(&mut m)?;
        }
        if let Some(e) = &self.session_end {
            m.serialize_entry("sessionEnd", e)?;
        }
        if let Some(n) = &self.unread_edits {
            m.serialize_entry("unreadEdits", n)?;
        }
        if let Some(r) = &self.reason {
            m.serialize_entry("reason", r)?;
        }
        if !self.sender_order {
            place(&mut m)?;
        }
        m.end()
    }
}

/// 読んだファイルのキーの順を、書き直すときにも保つための読み方(serde の derive は順を覚えない)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRetentionRaw {
    session_id: String,
    outcome: Outcome,
    #[serde(default)]
    reason: Option<UnattributableReason>,
    vcs: Option<VcsKind>,
    root: Option<String>,
    baseline: Option<Revision>,
    evaluated: Option<Evaluated>,
    hunks: Vec<Value>,
    excluded_hunks: i64,
    counts: LineCounts,
    lines: LineCounts,
    provenance: Provenance,
    #[serde(default)]
    path_mapped: Option<bool>,
    #[serde(default)]
    computed_on: Option<ComputedOn>,
    #[serde(default, with = "crate::js::double_option")]
    session_end: Option<Option<String>>,
    #[serde(default)]
    unread_edits: Option<i64>,
}

/// キーの位置(無ければ None)
fn key_pos(m: &Map<String, Value>, k: &str) -> Option<usize> {
    m.keys().position(|x| x == k)
}

impl HunkRetention {
    fn from_value(v: Value) -> Result<HunkRetention, serde_json::Error> {
        let reason_last = match &v {
            Value::Object(m) => matches!((key_pos(m, "reason"), key_pos(m, "lines")), (Some(r), Some(l)) if r > l),
            _ => false,
        };
        #[derive(Deserialize)]
        struct Raw {
            id: i64,
            path: String,
            status: RetentionStatus,
            #[serde(default)]
            reason: Option<UnattributableReason>,
            lines: LineCounts,
            #[serde(default)]
            at: Option<String>,
        }
        let r: Raw = serde_json::from_value(v)?;
        Ok(HunkRetention { id: r.id, path: r.path, status: r.status, reason: r.reason, lines: r.lines, at: r.at, reason_last })
    }
}

impl<'de> Deserialize<'de> for HunkRetention {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        HunkRetention::from_value(Value::deserialize(d)?).map_err(D::Error::custom)
    }
}

impl<'de> Deserialize<'de> for SessionRetention {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m = Map::<String, Value>::deserialize(d)?;
        // 送った側の結果を読み直したものは、provenance のすぐ後に computedOn がある
        let sender_order = matches!((key_pos(&m, "provenance"), key_pos(&m, "computedOn")), (Some(p), Some(c)) if c == p + 1);
        let r: SessionRetentionRaw = serde_json::from_value(Value::Object(m)).map_err(D::Error::custom)?;
        let hunks = r.hunks.into_iter().map(HunkRetention::from_value).collect::<Result<Vec<_>, _>>().map_err(D::Error::custom)?;
        Ok(SessionRetention {
            session_id: r.session_id,
            outcome: r.outcome,
            reason: r.reason,
            vcs: r.vcs,
            root: r.root,
            baseline: r.baseline,
            evaluated: r.evaluated,
            hunks,
            excluded_hunks: r.excluded_hunks,
            counts: r.counts,
            lines: r.lines,
            provenance: r.provenance,
            path_mapped: r.path_mapped,
            computed_on: r.computed_on,
            session_end: r.session_end,
            unread_edits: r.unread_edits,
            sender_order,
        })
    }
}

/// 照合の範囲と、照合できたセッションでの内訳
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSummary {
    /// 渡したセッションの数(照合の範囲の分母)
    pub sessions: i64,
    /// 数える AI の変更があったセッション
    pub with_ai_changes: i64,
    /// 照合できたセッション(指標の分母)
    pub measured: i64,
    /// AI の変更はあるが、すべて照合不可だったセッションの数(理由別。キーは UnattributableReason の名前)
    pub unattributable: JsMap<i64>,
    /// 照合できたセッションのうち、基準を時刻から推定したもの
    pub baseline_estimated: i64,
    /// まとまりの数(照合できたセッションのものだけ。照合不可のまとまりも含む)
    pub hunks: LineCounts,
    pub lines: LineCounts,
    /// VCS ごとの照合できたセッションの数(キーは VcsKind の名前)
    pub by_vcs: JsMap<i64>,
}

/// fixed の既定の日数
pub const DEFAULT_LAG_DAYS: i64 = 7;

// ---------- 照合 ----------

/// 照合の設定(TS の RetentionOptions。既定は Default)
#[derive(Clone)]
pub struct RetentionOptions {
    pub runner: VcsRunner,
    /// 比べる版。worktree = 今の作業ツリー(既定)、committed = 最後に取り込んだ版、fixed = セッションの終わりから lag_days 日後の版
    pub mode: EvalMode,
    /// fixed のときの日数(既定 7)
    pub lag_days: i64,
    /// 照合した時刻(ミリ秒)。None なら今
    pub now_ms: Option<i64>,
    /// 似た本文とみなす 2 字組の重なり(Dice 係数)の下限
    pub similarity: f64,
    /// 同時に照合するセッションの数(VCS のコマンドを並べて起動しすぎないように)
    pub concurrency: usize,
}

impl Default for RetentionOptions {
    fn default() -> Self {
        RetentionOptions { runner: default_runner(), mode: EvalMode::Worktree, lag_days: DEFAULT_LAG_DAYS, now_ms: None, similarity: 0.75, concurrency: SESSION_CONCURRENCY }
    }
}

/// 同時に照合するセッションの数の既定(git の起動を待つ時間が大半なので、TS 版の 4 より多くする)
pub const SESSION_CONCURRENCY: usize = 16;
const DAY_MS: i64 = 24 * 3600 * 1000;

/// JS の文字列の UTF-16 の単位(片割れは私用領域の文字から戻す)
fn units(s: &str) -> Vec<u16> {
    let mut v = Vec::with_capacity(s.len());
    for c in s.chars() {
        match lone_surrogate_unit(c) {
            Some(u) => v.push(u),
            None => {
                let mut buf = [0u16; 2];
                v.extend_from_slice(c.encode_utf16(&mut buf));
            }
        }
    }
    v
}

/// 空白の違いを無視した本文
fn squash(s: &str) -> String {
    s.chars().filter(|c| !js::is_js_whitespace(*c)).collect()
}

type Grams = HashMap<u32, u32>;

/// 2 字組(UTF-16 の単位 2 つ)の数
fn bigrams(s: &[u16]) -> Grams {
    let mut m = Grams::with_capacity(s.len());
    for w in s.windows(2) {
        *m.entry(((w[0] as u32) << 16) | w[1] as u32).or_insert(0) += 1;
    }
    m
}

/// 似た本文の判定と、ほかのセッションとの重なりの判定をする行の最小の長さ(空白を除いた文字数)
const MIN_SIMILAR_CHARS: usize = 6;

/// 作っておいた 2 字組どうしの重なり(la・lb はそれぞれの 2 字組の数)
fn dice_grams(a: &Grams, la: usize, b: &Grams, lb: usize) -> f64 {
    let mut common: u64 = 0;
    for (g, n) in a {
        common += (*n).min(b.get(g).copied().unwrap_or(0)) as u64;
    }
    (2 * common) as f64 / (la + lb) as f64
}

/// 文字の 2 字組の重なり(0〜1)
pub fn dice(a: &str, b: &str) -> f64 {
    let (ua, ub) = (units(a), units(b));
    if ua.len() < 2 || ub.len() < 2 {
        return if ua == ub { 1.0 } else { 0.0 };
    }
    dice_grams(&bigrams(&ua), ua.len() - 1, &bigrams(&ub), ub.len() - 1)
}

/// 本文の行(行末の空白を落とす)
fn file_lines(text: Option<&str>) -> Vec<&str> {
    match text {
        None => Vec::new(),
        Some(t) => t.split('\n').map(js::trim_end).collect(),
    }
}

fn multiset<'a>(lines: &[&'a str]) -> HashMap<&'a str, i64> {
    let mut m = HashMap::new();
    for l in lines {
        if !js::trim(l).is_empty() {
            *m.entry(*l).or_insert(0) += 1;
        }
    }
    m
}

/// 多重集合から 1 つ取る。取れたら true
fn take(m: &mut HashMap<&str, i64>, k: &str) -> bool {
    match m.get_mut(k) {
        Some(n) if *n > 0 => {
            *n -= 1;
            true
        }
        _ => false,
    }
}

struct Owner {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
}

fn to_ms(s: Option<&str>) -> Option<i64> {
    s.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

/// 時間が重なるか(どちらかの時刻が無ければ、重なるかもしれないので true)
fn overlaps(a: &Owner, b: &Owner) -> bool {
    match (a.start_ms, a.end_ms, b.start_ms, b.end_ms) {
        (Some(as_), Some(ae), Some(bs), Some(be)) => as_ <= be && bs <= ae,
        _ => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    Mine,
    ConcurrentSession,
    LaterSession,
}

/// 行 → それを足したセッション(ファイルごと。値は sets の添字)。二重計上を防ぐための索引
type LineIndex = HashMap<String, HashMap<String, Vec<usize>>>;

fn build_index(sets: &[AiChangeSet]) -> (LineIndex, Vec<Owner>) {
    let mut index: LineIndex = HashMap::new();
    let mut owners = Vec::with_capacity(sets.len());
    for (i, set) in sets.iter().enumerate() {
        owners.push(Owner { start_ms: to_ms(set.context.start.as_deref()), end_ms: to_ms(set.context.end.as_deref()) });
        for h in &set.hunks {
            let by_line = index.entry(file_path_key(&h.path)).or_default();
            for l in &h.lines {
                let list = by_line.entry(l.clone()).or_default();
                if !list.contains(&i) {
                    list.push(i);
                }
            }
        }
    }
    (index, owners)
}

/// その行を、ほかのセッションとの関係でこのセッションの分として数えられるか
fn line_claim(index: &LineIndex, owners: &[Owner], me: usize, file_key: &str, line: &str) -> Claim {
    // 短い行(} や return; など)は、別のセッションが同じ本文を足していても同じ変更とは言えないので、重なりを判定しない
    // (判定すると、ありふれた 1 行のためにまとまりごと照合不可になる)
    if js::utf16_len(&squash(line)) < MIN_SIMILAR_CHARS {
        return Claim::Mine;
    }
    let Some(list) = index.get(file_key).and_then(|m| m.get(line)) else { return Claim::Mine };
    let others: Vec<&Owner> = list.iter().filter(|&&o| o != me).map(|&o| &owners[o]).collect();
    let m = &owners[me];
    if others.iter().any(|o| overlaps(m, o)) {
        return Claim::ConcurrentSession;
    }
    if others.iter().any(|o| matches!((o.start_ms, m.end_ms), (Some(s), Some(e)) if s > e)) {
        return Claim::LaterSession;
    }
    Claim::Mine
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineState {
    Pending,
    Kept,
    Modified,
    Missing,
    Excluded,
    Reason(UnattributableReason),
}

/// 1 セッションのファイル 1 つ分(同じファイルのまとまりをまとめて照合する。1 つの行を二度使わないため)
fn classify_file(hunks: &[&AiHunk], base: Option<&str>, after: Option<&str>, claim: impl Fn(&str) -> Claim, similarity: f64) -> (Vec<HunkRetention>, i64) {
    let base_lines = file_lines(base);
    let mut base_left = multiset(&base_lines);
    // 照合した時点のファイルで増えた行(照合時 − 基準、多重集合)
    let mut added: Vec<&str> = Vec::new();
    {
        let mut b = multiset(&base_lines);
        for l in file_lines(after) {
            if !js::trim(l).is_empty() && !take(&mut b, l) {
                added.push(l);
            }
        }
    }
    struct Per<'a> {
        h: &'a AiHunk,
        lines: Vec<(&'a str, LineState)>,
    }
    let mut per: Vec<Per<'_>> = Vec::with_capacity(hunks.len());
    for h in hunks {
        let mut lines = Vec::with_capacity(h.lines.len());
        let mut concurrent = false;
        for text in &h.lines {
            let state = match claim(text) {
                Claim::Mine => LineState::Pending,
                Claim::ConcurrentSession => {
                    concurrent = true;
                    LineState::Reason(UnattributableReason::ConcurrentSession)
                }
                Claim::LaterSession => LineState::Reason(UnattributableReason::LaterSession),
            };
            lines.push((text.as_str(), state));
        }
        // 時間の重なる別のセッションと同じ行を含むまとまりは、まとまりごと照合不可
        if concurrent {
            for l in &mut lines {
                l.1 = LineState::Reason(UnattributableReason::ConcurrentSession);
            }
        }
        per.push(Per { h, lines });
    }
    // 1) 同じ本文 2) 空白の違いだけ 3) 似た本文、の順に、照合した時点のファイルの行を 1 つずつ使う
    let mut exact: HashMap<&str, i64> = HashMap::new();
    for l in &added {
        *exact.entry(l).or_insert(0) += 1;
    }
    let for_pending = |per: &mut Vec<Per<'_>>, f: &mut dyn FnMut(&str) -> Option<LineState>| {
        for p in per.iter_mut() {
            for l in p.lines.iter_mut() {
                if l.1 == LineState::Pending {
                    if let Some(s) = f(l.0) {
                        l.1 = s;
                    }
                }
            }
        }
    };
    for_pending(&mut per, &mut |t| take(&mut exact, t).then_some(LineState::Kept));
    // 増えた行に当たらず、基準のファイルにもともとある本文の行(動かしただけの行・同じ本文の書き直し)は数えない。
    // 同じ本文が増えた分(} を 3 つ足したなど)は先に当てたので、ありふれた行でも新しく足した分は数える
    for_pending(&mut per, &mut |t| take(&mut base_left, t).then_some(LineState::Excluded));
    // exact で使わなかった分を残す
    let rest: Vec<&str> = added.iter().copied().filter(|l| take(&mut exact, l)).collect();
    let mut used = vec![false; rest.len()];
    let rest_sq: Vec<String> = rest.iter().map(|r| squash(r)).collect();
    {
        // 空白の違いだけ: 同じ形の行のうち、まだ使っていない最初のもの
        let mut by_sq: HashMap<&str, std::collections::VecDeque<usize>> = HashMap::new();
        for (j, s) in rest_sq.iter().enumerate() {
            by_sq.entry(s.as_str()).or_default().push_back(j);
        }
        for_pending(&mut per, &mut |t| {
            let j = by_sq.get_mut(squash(t).as_str())?.pop_front()?;
            used[j] = true;
            Some(LineState::Modified)
        });
    }
    // 似た本文: 照合した時点の行の 2 字組は 1 度だけ作る(行ごと・組ごとに作り直すと、大きなファイルで遅くなる)
    let rest_units: Vec<Vec<u16>> = rest_sq.iter().map(|r| units(r)).collect();
    let rest_grams: Vec<Option<Grams>> = rest_units.iter().map(|u| (u.len() >= MIN_SIMILAR_CHARS).then(|| bigrams(u))).collect();
    for_pending(&mut per, &mut |t| {
        let s = units(&squash(t));
        if s.len() < MIN_SIMILAR_CHARS {
            return None; // 短い行(} や end など)は似ていても当てにならない
        }
        let grams = bigrams(&s);
        let mut best: Option<usize> = None;
        let mut best_score = similarity;
        for j in 0..rest_units.len() {
            let Some(g) = &rest_grams[j] else { continue };
            if used[j] {
                continue;
            }
            // 長さの差だけで下限に届かないものは、数えずに飛ばす(重なりは短いほうの 2 字組の数を超えない)
            let la = s.len() - 1;
            let lb = rest_units[j].len() - 1;
            if ((2 * la.min(lb)) as f64 / (la + lb) as f64) < best_score {
                continue;
            }
            let score = dice_grams(&grams, la, g, lb);
            if score >= best_score {
                best = Some(j);
                best_score = score;
            }
        }
        let j = best?;
        used[j] = true;
        Some(LineState::Modified)
    });
    for_pending(&mut per, &mut |_| Some(LineState::Missing));

    let mut results = Vec::new();
    let mut excluded = 0;
    for p in &per {
        let counted: Vec<&LineState> = p.lines.iter().map(|l| &l.1).filter(|s| **s != LineState::Excluded).collect();
        if counted.is_empty() {
            excluded += 1;
            continue;
        }
        let mut lines = LineCounts::default();
        let mut reason: Option<UnattributableReason> = None;
        for s in counted {
            match s {
                LineState::Kept => lines.kept += 1,
                LineState::Modified => lines.modified += 1,
                LineState::Missing => lines.missing += 1,
                LineState::Reason(r) => {
                    lines.unattributable += 1;
                    reason.get_or_insert(*r);
                }
                LineState::Pending | LineState::Excluded => unreachable!("決まっていない行"),
            }
        }
        let status = status_of_lines(&lines);
        results.push(HunkRetention {
            id: p.h.id,
            path: p.h.path.clone(),
            status,
            reason: if status == RetentionStatus::Unattributable { reason } else { None },
            lines,
            at: p.h.at.clone().filter(|a| !a.is_empty()),
            reason_last: false,
        });
    }
    (results, excluded)
}

/// 行の内訳から決まる状態
pub fn status_of_lines(l: &LineCounts) -> RetentionStatus {
    let counted = l.kept + l.modified + l.missing;
    if counted == 0 {
        RetentionStatus::Unattributable
    } else if l.kept == counted {
        RetentionStatus::Kept
    } else if l.kept + l.modified > 0 {
        RetentionStatus::Modified
    } else {
        RetentionStatus::Missing
    }
}

fn unattributed(h: &AiHunk, reason: UnattributableReason) -> HunkRetention {
    HunkRetention {
        id: h.id,
        path: h.path.clone(),
        status: RetentionStatus::Unattributable,
        reason: Some(reason),
        lines: LineCounts { unattributable: h.lines.len() as i64, ..Default::default() },
        at: h.at.clone().filter(|a| !a.is_empty()),
        reason_last: false,
    }
}

/// まとまりから件数・行数・結果を数え直す(いちばん多い理由。同じ数なら先に出たもの)
pub(crate) fn tally(r: &mut SessionRetention) {
    r.counts = LineCounts::default();
    r.lines = LineCounts::default();
    for h in &r.hunks {
        *r.counts.get_mut(h.status) += 1;
        r.lines.add(&h.lines);
    }
}

pub(crate) fn top_reason(hunks: &[HunkRetention]) -> Option<UnattributableReason> {
    let mut by: Vec<(UnattributableReason, i64)> = Vec::new();
    for h in hunks {
        if let Some(r) = h.reason {
            match by.iter_mut().find(|x| x.0 == r) {
                Some(x) => x.1 += 1,
                None => by.push((r, 1)),
            }
        }
    }
    // 安定な並べ替えで数の多い順(JS の sort と同じく、同じ数なら先に出たもの)
    by.sort_by(|a, b| b.1.cmp(&a.1));
    by.first().map(|x| x.0)
}

/// 照合 1 回の中で使い回す読み取り
struct Caches {
    repos: RepoCache,
    baselines: Memo<Result<Option<Revision>, String>>,
    reads: Memo<Result<Option<Arc<String>>, String>>,
    revs: Memo<Option<String>>,
}

fn repo_key(repo: &VcsRepo) -> String {
    format!("{}\0{}", repo.kind.as_str(), file_path_key(&repo.root))
}

fn same(a: &Arc<VcsRepo>, b: Option<&Arc<VcsRepo>>) -> bool {
    b.is_some_and(|b| Arc::ptr_eq(a, b))
}

struct Shared<'a> {
    sets: &'a [AiChangeSet],
    index: LineIndex,
    owners: Vec<Owner>,
    caches: Caches,
    opts: &'a RetentionOptions,
    now: String,
    now_ms: i64,
}

fn measure_one(sh: &Shared<'_>, me: usize) -> SessionRetention {
    let set = &sh.sets[me];
    let opts = sh.opts;
    let mode = opts.mode;
    let ctx = &set.context;
    let mut result = SessionRetention {
        session_id: set.session_id.clone(),
        outcome: Outcome::NoAiChanges,
        reason: None,
        vcs: None,
        root: None,
        baseline: None,
        evaluated: None,
        hunks: Vec::new(),
        excluded_hunks: 0,
        counts: LineCounts::default(),
        lines: LineCounts::default(),
        provenance: Provenance { ai_changes: "events".into(), baseline: None, context: ctx.sources.clone() },
        path_mapped: None,
        computed_on: None,
        session_end: Some(ctx.end.clone()),
        unread_edits: (set.skipped.no_material != 0).then_some(set.skipped.no_material),
        sender_order: false,
    };
    if set.hunks.is_empty() {
        return result;
    }

    // fixed: セッションの終わりから lag_days 日後の時点の版と比べる。その日がまだ来ていなければ照合しない(後で照合し直すと測れる)
    let end_ms = to_ms(ctx.end.as_deref());
    let fixed_at = match (mode, end_ms) {
        (EvalMode::Fixed, Some(e)) => Some(jsdate::to_iso(e + opts.lag_days * DAY_MS)),
        _ => None,
    };
    let too_recent = mode == EvalMode::Fixed && end_ms.is_none_or(|e| e + opts.lag_days * DAY_MS > sh.now_ms);

    // セッションの作業フォルダの VCS(ファイルが別のリポジトリにあれば、そのファイルの場所で探し直す)
    let session_dir = ctx.git_root.as_deref().or(ctx.cwd.as_deref()).filter(|d| !d.is_empty());
    let session_repo: Option<OpenRepoResult> = session_dir.map(|d| open_repo(d, &opts.runner, &sh.caches.repos));
    let s_repo: Option<&Arc<VcsRepo>> = session_repo.as_ref().and_then(|r| r.as_ref().ok());
    if let Some(r) = s_repo {
        result.vcs = Some(r.kind);
        result.root = Some(r.root.clone());
    }

    let after_rev_of = |repo: &Arc<VcsRepo>| -> Option<String> {
        let branch = if repo.kind == VcsKind::Git && same(repo, s_repo) { ctx.branch.as_deref() } else { None };
        let at = fixed_at.as_deref().unwrap_or("null");
        sh.caches.revs.get_or_init(format!("{}\0at\0{at}\0{}", repo_key(repo), branch.unwrap_or("")), || repo.revision_at(at, branch).unwrap_or(None))
    };
    // リポジトリごとの基準(同じものは 1 度だけ調べる)
    let baseline_of = |repo: &Arc<VcsRepo>| -> Result<Option<Revision>, String> {
        // headCommit はそのセッションの git のリポジトリのものなので、同じリポジトリのときだけ使う
        let same_repo = repo.kind == VcsKind::Git && same(repo, s_repo);
        let head = if same_repo { ctx.head_commit.as_deref() } else { None };
        let start = ctx.start.as_deref();
        // 推定するときは、セッションのブランチの履歴で探す(同じリポジトリのときだけ)
        let branch = if same_repo { ctx.branch.as_deref() } else { None };
        let tail = if head.is_some_and(|h| !h.is_empty()) { String::new() } else { format!("{}\0{}", start.unwrap_or(""), branch.unwrap_or("")) };
        let key = format!("{}\0{}\0{tail}", repo_key(repo), head.unwrap_or(""));
        sh.caches.baselines.get_or_init(key, || repo.baseline(head, start, branch))
    };
    let read = |key: String, load: &dyn Fn() -> Result<Option<String>, String>| -> Result<Option<Arc<String>>, String> { sh.caches.reads.get_or_init(key, || load().map(|o| o.map(Arc::new))) };

    let mut by_file: IndexMap<String, Vec<&AiHunk>> = IndexMap::new();
    for h in &set.hunks {
        by_file.entry(file_path_key(&h.path)).or_default().push(h);
    }

    for (fk, hunks) in &by_file {
        let path = hunks[0].path.as_str();
        let mut repo: Option<Arc<VcsRepo>> = None;
        let mut reason = UnattributableReason::RepoNotFound;
        match (&session_repo, s_repo) {
            (_, Some(r)) if r.relative(path).is_some() => repo = Some(r.clone()),
            // 作業フォルダがこの PC に無い。上のフォルダをたどると別のリポジトリに当たりうるので、探さない
            (Some(Err(NoRepo::RepoNotFound)), _) => reason = UnattributableReason::RepoNotFound,
            _ => {
                // セッションの作業フォルダの外のファイル。ファイルのある場所(消えていれば、ディスクにある上のフォルダ)で VCS を探す
                let opened = nearest_existing_dir(&platform::dirname(path)).map(|d| open_repo(&d, &opts.runner, &sh.caches.repos));
                match &opened {
                    Some(Ok(o)) if o.relative(path).is_some() => repo = Some(o.clone()),
                    _ if s_repo.is_some() || matches!(opened, Some(Ok(_))) => reason = UnattributableReason::OutsideRepo,
                    _ => {
                        let no = match (&opened, &session_repo) {
                            (Some(Err(n)), _) | (_, Some(Err(n))) => *n,
                            _ => NoRepo::RepoNotFound,
                        };
                        reason = match no {
                            NoRepo::RepoNotFound => UnattributableReason::RepoNotFound,
                            NoRepo::NoVcs => UnattributableReason::NoVcs,
                        };
                    }
                }
            }
        }
        let Some(repo) = repo else {
            result.hunks.extend(hunks.iter().map(|h| unattributed(h, reason)));
            continue;
        };
        if too_recent {
            result.hunks.extend(hunks.iter().map(|h| unattributed(h, UnattributableReason::TooRecent)));
            continue;
        }
        let outcome = (|| -> Result<(), String> {
            let Some(b) = baseline_of(&repo)? else {
                result.hunks.extend(hunks.iter().map(|h| unattributed(h, UnattributableReason::BaselineMissing)));
                return Ok(());
            };
            if same(&repo, s_repo) || result.baseline.is_none() {
                result.provenance.baseline = Some(b.source);
                result.baseline = Some(b.clone());
            }
            let rk = repo_key(&repo);
            let base = read(format!("{rk}\0at\0{}\0{fk}", b.rev), &|| repo.read_at(&b.rev, path))?;
            let after = if mode == EvalMode::Fixed {
                let Some(after_rev) = after_rev_of(&repo) else {
                    result.hunks.extend(hunks.iter().map(|h| unattributed(h, UnattributableReason::AfterMissing)));
                    return Ok(());
                };
                read(format!("{rk}\0at\0{after_rev}\0{fk}"), &|| repo.read_at(&after_rev, path))?
            } else {
                read(format!("{rk}\0after\0{}\0{fk}", mode.as_str()), &|| repo.read_after(mode, path))?
            };
            let (results, excluded) = classify_file(hunks, base.as_deref().map(String::as_str), after.as_deref().map(String::as_str), |line| line_claim(&sh.index, &sh.owners, me, fk, line), opts.similarity);
            result.hunks.extend(results);
            result.excluded_hunks += excluded;
            Ok(())
        })();
        if outcome.is_err() {
            result.hunks.extend(hunks.iter().map(|h| unattributed(h, UnattributableReason::ReadError)));
        }
    }

    if let Some(repo) = s_repo {
        if mode == EvalMode::Fixed {
            // 比べた時点は、セッションの終わりから決まった日数後(照合した日ではない)
            if let (Some(at), false) = (&fixed_at, too_recent) {
                result.evaluated = Some(Evaluated { mode, rev: after_rev_of(repo), at: at.clone() });
            }
        } else {
            let rev = sh.caches.revs.get_or_init(repo_key(repo), || repo.current_revision().unwrap_or(None));
            result.evaluated = Some(Evaluated { mode, rev, at: sh.now.clone() });
        }
    }
    result.hunks.sort_by_key(|h| h.id);
    tally(&mut result);
    let measured = result.counts.kept + result.counts.modified + result.counts.missing;
    if measured > 0 {
        result.outcome = Outcome::Measured;
    } else if result.counts.unattributable > 0 {
        result.outcome = Outcome::Unattributable;
        result.reason = top_reason(&result.hunks);
    }
    result
}

/// セッションごとに、AI の変更が照合した時点のファイルに残っているかを調べる。
/// sets には、二重計上の判定のため、照合の対象になりうるセッションをまとめて渡す。結果は sets の順
pub fn measure_retention(sets: &[AiChangeSet], opts: &RetentionOptions) -> Vec<SessionRetention> {
    let now_ms = opts.now_ms.unwrap_or_else(jsdate::now_ms);
    let now = jsdate::to_iso(now_ms);
    let (index, owners) = build_index(sets);
    let sh = Shared {
        sets,
        index,
        owners,
        caches: Caches { repos: RepoCache::new(), baselines: Memo::new(), reads: Memo::new(), revs: Memo::new() },
        opts,
        now_ms: jsdate::parse_ms(&now).unwrap_or(now_ms),
        now,
    };
    // 決まった数だけ同時に進める(VCS の呼び出しを待つ時間が大半なので、スレッドで並べる。結果は sets の順)
    let workers = opts.concurrency.max(1).min(sets.len().max(1));
    let next = AtomicUsize::new(0);
    let out: Vec<Mutex<Option<SessionRetention>>> = (0..sets.len()).map(|_| Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= sets.len() {
                    break;
                }
                let r = measure_one(&sh, i);
                *out[i].lock().expect("結果") = Some(r);
            });
        }
    });
    out.into_iter().map(|m| m.into_inner().expect("結果").expect("すべてのセッションを照合した")).collect()
}

/// 照合の範囲と、照合できたセッションでの内訳
pub fn summarize_retention(results: &[SessionRetention]) -> RetentionSummary {
    let mut s = RetentionSummary { sessions: results.len() as i64, ..Default::default() };
    for r in results {
        if r.outcome == Outcome::NoAiChanges {
            continue;
        }
        s.with_ai_changes += 1;
        if r.outcome == Outcome::Unattributable {
            let k = r.reason.unwrap_or(UnattributableReason::ReadError);
            s.unattributable.inc(k.as_str(), 1);
            continue;
        }
        s.measured += 1;
        if r.baseline.as_ref().is_some_and(|b| b.source == RevisionSource::Estimated) {
            s.baseline_estimated += 1;
        }
        if let Some(v) = r.vcs {
            s.by_vcs.inc(v.as_str(), 1);
        }
        s.hunks.add(&r.counts);
        s.lines.add(&r.lines);
    }
    s
}

#[cfg(test)]
pub(crate) mod tests;
