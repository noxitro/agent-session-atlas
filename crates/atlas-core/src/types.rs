//! sessions.json / metrics.json のスキーマ(packages/core/src/types.ts の移植)。後続の工程(vcs・metrics・report・judge)はここを参照する。
//!
//! フィールドの並びは TS 版がオブジェクトを組み立てる順(= JSON に書く順)にしてある(型の宣言の順とは違うところがある)。
//! - TS の `undefined`(キーを書かない)は `skip_serializing_if = "Option::is_none"`。
//! - `?: T | null`(キーが無いことも null のこともある)は `Option<Option<T>>`(js::double_option)。
//! - `Record<string, …>` は js::JsMap(キーの順を JS と同じにする)。
//! - 数は、記録の値を足すもの(トークン・時間)は f64、数えるだけのものは i64。
//!
//! 版の履歴(SESSIONS_SCHEMA_VERSION・METRICS_SCHEMA_VERSION)は types.ts の先頭のコメントを参照。

use crate::atlas_version::{AtlasBuild, FolderUpload};
use crate::js::JsMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SESSIONS_SCHEMA_VERSION: i64 = 16;
pub const METRICS_SCHEMA_VERSION: i64 = 6;

// ---------- 入力(生データ) ----------

/// events.jsonl の 1 行(data は形が決まっていないので Value のまま)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseStats {
    pub lines: i64,
    pub parsed: i64,
    pub bad_lines: i64,
    pub blank_lines: i64,
}

/// workspace.yaml(必要なキーだけ。値は文字列にそろえたもの)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkspaceInfo {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub git_root: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub name: Option<String>,
    pub summary: Option<String>,
    pub client_name: Option<String>,
    pub host_type: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// session-store.db の sessions の行
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DbSessionRow {
    pub id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub host_type: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DbTurnRow {
    pub session_id: String,
    pub turn_index: f64,
    #[serde(default)]
    pub user_message: Option<String>,
    #[serde(default)]
    pub assistant_response: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DbUsageRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<f64>,
    pub session_id: String,
    #[serde(default)]
    pub turn_index: Option<f64>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub parent_tool_call_id: Option<String>,
    pub model: String,
    #[serde(default)]
    pub input_tokens: Option<f64>,
    #[serde(default)]
    pub output_tokens: Option<f64>,
    #[serde(default)]
    pub cache_read_tokens: Option<f64>,
    #[serde(default)]
    pub cache_write_tokens: Option<f64>,
    #[serde(default)]
    pub reasoning_tokens: Option<f64>,
    #[serde(default)]
    pub total_nano_aiu: Option<f64>,
    #[serde(default)]
    pub request_multiplier: Option<f64>,
    #[serde(default)]
    pub initiator: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub time_to_first_token_ms: Option<f64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DbFileRow {
    pub session_id: String,
    pub file_path: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub turn_index: Option<f64>,
    #[serde(default)]
    pub first_seen_at: Option<String>,
}

// ---------- 正規化セッションレコード(sessions.json の 1 要素) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionSource {
    Db,
    Dir,
}

/// トークンの出所(優先順位: db / events / db+events > shutdown > partial > none)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TokenSource {
    #[serde(rename = "db")]
    Db,
    #[serde(rename = "events")]
    Events,
    #[serde(rename = "db+events")]
    DbEvents,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "partial")]
    Partial,
    #[serde(rename = "none")]
    None,
}

impl TokenSource {
    pub const ALL: [TokenSource; 6] = [TokenSource::Db, TokenSource::Events, TokenSource::DbEvents, TokenSource::Shutdown, TokenSource::Partial, TokenSource::None];
    pub fn as_str(self) -> &'static str {
        match self {
            TokenSource::Db => "db",
            TokenSource::Events => "events",
            TokenSource::DbEvents => "db+events",
            TokenSource::Shutdown => "shutdown",
            TokenSource::Partial => "partial",
            TokenSource::None => "none",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    /// 入力トークン。記録が無ければ null(UI で「推計不可」)
    pub input: Option<f64>,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub reasoning: Option<f64>,
    /// premium request(ユーザー起点リクエストの倍率の和)。不明なら null
    pub premium_requests: Option<f64>,
    pub nano_aiu: Option<f64>,
    /// API リクエスト数。shutdown 由来で件数が無ければ null
    pub requests: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecords {
    pub db: i64,
    pub events: i64,
    pub duplicates_removed: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    pub input: Option<f64>,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub reasoning: Option<f64>,
    pub premium_requests: Option<f64>,
    pub nano_aiu: Option<f64>,
    pub requests: Option<f64>,
    pub source: TokenSource,
    pub by_model: JsMap<TokenCounts>,
    /// agent 名(main = 親セッション)
    pub by_agent: JsMap<TokenCounts>,
    /// 採用したレコード件数(DB 行 / usage_record で補った行)。shutdown 由来は全て 0
    pub records: TokenRecords,
    /// session.shutdown の最終値
    pub shutdown: Option<ShutdownTotals>,
    /// subagent.completed.totalTokens の合計(参考値)
    pub subagent_total_tokens: f64,
    /// compaction 直前のトークン数の最大値(参考値)
    pub max_pre_compaction_tokens: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownTotals {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
    pub premium_requests: Option<f64>,
    pub nano_aiu: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillVia {
    Tool,
    Event,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillTrigger {
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUse {
    pub name: String,
    pub at: Option<String>,
    /// tool: toolName "skill" / event: skill.invoked(_ref) / both: 同じ呼び出しを両方で観測
    pub via: SkillVia,
    /// user / agent / null(trigger を持たない古い skill.invoked だけ)
    pub trigger: Option<SkillTrigger>,
    /// Phase 12: 本文の文字数(skill.invoked の content。無ければ null。ツールだけのものはキーが無い)
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub chars: Option<Option<f64>>,
}

/// そのセッションで使えた skill(<available_skills> の 1 項目)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailableSkill {
    pub name: String,
    pub location: Option<String>,
}

/// Phase 12: 改善点の分析に使う、セッション内の並びから求める量
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAnalysis {
    pub files_reedited: i64,
    pub extra_edits: i64,
    pub max_consecutive_failures: i64,
    /// 本体のユーザーのターンごとのツール名の列(先頭 200 ターン、各 40 件まで)
    pub turn_tools: Vec<Vec<String>>,
    pub turn_ms: Vec<Option<f64>>,
    pub turn_active_ms: Vec<Option<f64>>,
    /// 依頼文の先頭 300 字(ターンごと、先頭 200 件)
    pub requests: Vec<String>,
    /// 段階 1: ターンごとの出来事(turnTools と同じ並び)。古い sessions.json には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_stats: Option<Vec<TurnStats>>,
}

/// ツールの種類(turns.rs の tool_kind)
pub const TOOL_KINDS: [&str; 9] = ["read", "edit", "verify", "git", "shell", "plan", "web", "delegate", "other"];

/// 1 ターン(利用者の 1 回の依頼から次の依頼の直前まで)の出来事
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStats {
    pub started_at: Option<String>,
    /// 作業のツール呼び出しの種類別の回数(キーは TOOL_KINDS。出た順)
    pub kinds: JsMap<i64>,
    pub tools: i64,
    pub tool_failures: i64,
    pub denied: i64,
    pub max_consecutive_failures: i64,
    pub edits: i64,
    pub re_edits: i64,
    /// 古い記録には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_edits: Option<i64>,
    pub aborts: i64,
    pub errors: i64,
    pub external_errors: i64,
    pub subagent_failures: i64,
    pub compactions: i64,
    pub ask_user: i64,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub nano_aiu: Option<f64>,
}

/// ツール 1 種類の結果
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: i64,
    pub failure: i64,
    pub denied: i64,
    /// failure の要因別の回数(tool_failure.rs)。失敗が無ければ無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causes: Option<JsMap<i64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineSource {
    Shutdown,
    Tools,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineNote {
    SubagentEdits,
    EmptyShutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineChanges {
    pub added: f64,
    pub removed: f64,
    pub source: LineSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<LineNote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectSource {
    Repository,
    GitRemote,
    Path,
    Home,
    Temp,
    AtlasJudge,
    Unknown,
}

impl ProjectSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectSource::Repository => "repository",
            ProjectSource::GitRemote => "git-remote",
            ProjectSource::Path => "path",
            ProjectSource::Home => "home",
            ProjectSource::Temp => "temp",
            ProjectSource::AtlasJudge => "atlas-judge",
            ProjectSource::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "repository" => ProjectSource::Repository,
            "git-remote" => ProjectSource::GitRemote,
            "path" => ProjectSource::Path,
            "home" => ProjectSource::Home,
            "temp" => ProjectSource::Temp,
            "atlas-judge" => ProjectSource::AtlasJudge,
            "unknown" => ProjectSource::Unknown,
            _ => return None,
        })
    }
}

/// snapshot 時に ~/.copilot から名前だけ記録したインストール済みのもの
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInventory {
    pub skills: Vec<String>,
    pub plugins: Vec<InstalledPlugin>,
    /// settings.json の disabledSkills(無ければ空、読めなければ null)
    pub disabled_skills: Option<Vec<String>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub marketplace: String,
    pub name: String,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub name: String,
    pub id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub status: AgentStatus,
    pub total_tokens: Option<f64>,
    pub total_tool_calls: Option<f64>,
    pub model: Option<String>,
    /// subagent.failed の error(先頭 200 字)。失敗以外は null
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InstructionFile {
    #[serde(rename = "AGENTS.md")]
    AgentsMd,
    #[serde(rename = "CLAUDE.md")]
    ClaudeMd,
    #[serde(rename = "GEMINI.md")]
    GeminiMd,
    #[serde(rename = "copilot-instructions.md")]
    CopilotInstructions,
    #[serde(rename = ".github/instructions")]
    GithubInstructions,
    #[serde(rename = "unknown")]
    Unknown,
}

impl InstructionFile {
    pub fn as_str(self) -> &'static str {
        match self {
            InstructionFile::AgentsMd => "AGENTS.md",
            InstructionFile::ClaudeMd => "CLAUDE.md",
            InstructionFile::GeminiMd => "GEMINI.md",
            InstructionFile::CopilotInstructions => "copilot-instructions.md",
            InstructionFile::GithubInstructions => ".github/instructions",
            InstructionFile::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstructionMethod {
    ImportedSource,
    HeadingKeyword,
    ApplyTo,
    ImportStub,
    LearnedHeading,
    CrossProject,
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstructionScope {
    Repo,
    User,
    Unknown,
}

impl InstructionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            InstructionScope::Repo => "repo",
            InstructionScope::User => "user",
            InstructionScope::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionInjection {
    pub file: InstructionFile,
    pub scope: InstructionScope,
    pub method: InstructionMethod,
    /// 文字数(コードポイント数)
    pub chars: i64,
    pub first_seen_at: Option<String>,
    /// 先頭の空でない行(80 字まで)
    pub heading: String,
    /// 内容のハッシュ(sha1 先頭 12 桁)
    pub content_hash: String,
    pub injections: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiUsage {
    pub index_reads: i64,
    pub page_reads: Vec<String>,
    pub skill_calls: Vec<String>,
    pub writes: i64,
    pub other_calls: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friction {
    pub compactions: i64,
    pub aborts: i64,
    pub errors: i64,
    pub permission_requests: i64,
    pub ask_user: i64,
    pub model_changes: i64,
    pub mode_changes: i64,
    pub tool_failures: i64,
    pub subagent_failures: i64,
}

/// 推論強度別の集計(リクエスト単位)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortStat {
    pub requests: f64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextSource {
    Shutdown,
    Compaction,
    Usage,
}

/// 文脈の内訳(トークン)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub system_tokens: Option<f64>,
    pub conversation_tokens: Option<f64>,
    pub tool_definitions_tokens: Option<f64>,
    pub available_tool_count: Option<f64>,
    pub source: Option<ContextSource>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeCounts {
    pub by_mode: JsMap<i64>,
    pub inferred: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Latency {
    pub ttft: Vec<f64>,
    pub duration: Vec<f64>,
}

/// Phase 7: 実行の性質(JSON の並びは modes・context・efforts・modelEfforts・initiators・latency)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecProfile {
    pub modes: ModeCounts,
    pub context: ContextBreakdown,
    pub efforts: JsMap<EffortStat>,
    /// schema 15 以前の sessions.json には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_efforts: Option<JsMap<JsMap<EffortStat>>>,
    pub initiators: JsMap<i64>,
    pub latency: JsMap<Latency>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionStats {
    pub recorded: i64,
    pub input: f64,
    pub output: f64,
    pub nano_aiu: f64,
    pub tokens_removed: f64,
    /// 古い記録には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_recorded: Option<i64>,
}

/// Phase 7: 摩擦の詳細
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionDetail {
    pub permissions: JsMap<i64>,
    pub error_types: JsMap<i64>,
    pub subagent_failures: JsMap<i64>,
    pub compaction: CompactionStats,
    /// 古い記録には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_model_changes: Option<i64>,
}

/// Phase 7: session.db の todos(状態別の件数)と todo_deps(依存の数)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSummary {
    pub total: f64,
    pub by_status: JsMap<f64>,
    pub deps: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    User,
    Tools,
    Agent,
    Skill,
    Compaction,
    Abort,
    Error,
    TaskComplete,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub at: String,
    pub kind: TimelineKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<JsMap<i64>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalTools {
    pub by_name: JsMap<i64>,
    pub total: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTools {
    pub by_name: JsMap<i64>,
    pub total: i64,
    pub internal: InternalTools,
    /// MCP サーバー別のツール呼び出し
    pub mcp: JsMap<JsMap<i64>>,
    /// ツール別の結果
    pub results: JsMap<ToolResult>,
    /// ツール別の所要時間(ミリ秒の整数)
    pub durations: JsMap<Vec<f64>>,
    /// 1 時間を超えて外した呼び出しの数
    pub duration_outliers: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCounts {
    pub by_type: JsMap<i64>,
    pub total: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFiles {
    pub changed: Vec<String>,
    pub created: Vec<String>,
    pub deleted: Vec<String>,
    pub session_state: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCounts {
    pub total: i64,
    pub bad_lines: i64,
    pub by_type: JsMap<i64>,
}

/// data.db(デスクトップアプリ)の 1 行(desktop-types.ts の DesktopRow)
pub type DesktopRow = serde_json::Map<String, Value>;

/// セッション id ごとに、desktop.json の sessions の行と関連表をまとめたもの(desktop-types.ts の DesktopSessionInfo)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionInfo {
    pub session: Option<DesktopRow>,
    pub context_usage: Vec<DesktopRow>,
    pub checkpoints: Vec<DesktopRow>,
    pub activity: Vec<DesktopRow>,
    pub workspace: Option<DesktopRow>,
    pub project: Option<DesktopRow>,
}

/// sessions.json の 1 要素。並びは normalize が作る順のあとに、extract が足す person・upload*・desktop が続く
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub sources: Vec<SessionSource>,
    pub client: Option<String>,
    pub cwd: Option<String>,
    pub git_root: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub name: Option<String>,
    /// 集計用のプロジェクトキー
    pub project: String,
    pub project_source: ProjectSource,
    pub copilot_version: Option<String>,
    pub schema_version: Option<f64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// 最初と最後のイベントの差(壁時計)
    pub duration_ms: Option<f64>,
    /// 5 分を超える無イベント区間を除いた時間
    pub active_ms: Option<f64>,
    pub turns: i64,
    pub autopilot_continuations: i64,
    pub assistant_messages: i64,
    /// 依頼 0・ツール 0・応答 0(開いただけのセッション)
    pub empty: bool,
    pub first_user_message: Option<String>,
    pub last_assistant_message: Option<String>,
    pub models: Vec<String>,
    pub tokens: SessionTokens,
    pub tools: SessionTools,
    pub exec: ExecProfile,
    pub friction_detail: FrictionDetail,
    pub todos: Option<TodoSummary>,
    pub lines: LineChanges,
    pub skills: Vec<SkillUse>,
    /// 使えた skill。一覧がシステムメッセージに無いセッションは null。古い sessions.json には無い
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub available_skills: Option<Option<Vec<AvailableSkill>>>,
    pub agents: Vec<AgentRun>,
    pub hooks: HookCounts,
    pub instructions: Vec<InstructionInjection>,
    pub wiki: WikiUsage,
    pub friction: Friction,
    pub files: SessionFiles,
    pub timeline: Vec<TimelineEntry>,
    pub analysis: SessionAnalysis,
    pub unknown_event_types: JsMap<i64>,
    pub events: EventCounts,
    /// 送り先をまとめて集計したときの、人のフォルダの名前
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub person: Option<Option<String>>,
    /// 送り先から集計したときの、そのセッションを数えた送り先のフォルダ
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub upload_folder: Option<Option<String>>,
    /// 送り先から集計したときの、送った人のタスクタグ
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_tags: Option<Vec<String>>,
    /// 送り先から集計したときの、そのセッションのフォルダを写した atlas の版
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub upload_atlas: Option<Option<AtlasBuild>>,
    /// Phase 11: デスクトップアプリの data.db の許可リストの列
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub desktop: Option<Option<DesktopSessionInfo>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadLayout {
    Flat,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSource {
    pub root: Option<String>,
    pub snapshot_dir: String,
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<UploadLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploads: Option<JsMap<FolderUpload>>,
}

/// Phase 11: data.db の読み取りの状態(wal・coverage は desktop.rs の DesktopData のもの)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsDesktop {
    pub read_at: String,
    pub wal: Option<crate::desktop::DesktopWal>,
    pub coverage: crate::desktop::DesktopCoverage,
    pub warnings: Vec<String>,
    pub sessions: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub sessions: i64,
    pub db_only: i64,
    pub dir_only: i64,
    pub both: i64,
    pub empty: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsWarnings {
    pub unknown_event_types: JsMap<i64>,
    pub bad_lines: i64,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsFile {
    pub schema_version: i64,
    pub generated_at: String,
    pub source: SessionsSource,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub desktop: Option<Option<SessionsDesktop>>,
    pub counts: SessionCounts,
    pub installed: Option<InstalledInventory>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub installed_by_person: Option<Option<JsMap<InstalledInventory>>>,
    pub warnings: SessionsWarnings,
    pub sessions: Vec<SessionRecord>,
}

// ---------- 集計(metrics.json) ----------
// 並びは metrics.ts の bucketOf などが組み立てる順。段 3(metrics の移植)で突き合わせて確かめること。

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Distribution {
    pub total: f64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DistributionWithMean {
    pub total: f64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
    pub mean: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketTokens {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
    pub premium_requests: f64,
    pub nano_aiu: f64,
    pub requests: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BucketTools {
    pub total: i64,
    #[serde(rename = "byName")]
    pub by_name: JsMap<i64>,
    pub internal: i64,
    pub mcp: JsMap<i64>,
    pub results: JsMap<ToolResult>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketLines {
    pub added: f64,
    pub removed: f64,
    pub sessions_with_record: i64,
    /// shutdown・tools・none の順
    pub by_source: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillTriggerCounts {
    pub user: i64,
    pub agent: i64,
    pub unknown: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketSkills {
    pub total: i64,
    pub by_name: JsMap<i64>,
    pub sessions_with_any: i64,
    pub by_trigger: SkillTriggerCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentDetail {
    pub runs: i64,
    pub failed: i64,
    pub tokens: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketAgents {
    pub total: i64,
    pub failed: i64,
    pub by_name: JsMap<i64>,
    pub by_name_detail: JsMap<AgentDetail>,
    pub sessions_with_any: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketHooks {
    pub total: i64,
    pub by_type: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FileStat {
    pub sessions: i64,
    pub chars: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInstructions {
    pub sessions_with_any: i64,
    pub by_file: JsMap<FileStat>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketWiki {
    pub sessions_with_any: i64,
    pub index_reads: i64,
    pub page_reads: i64,
    pub skill_calls: i64,
    pub writes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolCountMean {
    pub sessions: i64,
    pub mean: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketContext {
    pub sessions: i64,
    pub tool_definitions_tokens: DistributionWithMean,
    pub available_tool_count: ToolCountMean,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BucketExec {
    pub modes: ModeCounts,
    pub efforts: JsMap<EffortStat>,
    pub initiators: JsMap<i64>,
    pub context: BucketContext,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketTodos {
    pub sessions_with_db: i64,
    pub sessions_with_todos: i64,
    pub total: f64,
    pub by_status: JsMap<f64>,
    pub deps: f64,
    pub completion_rate: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsBucket {
    pub sessions: i64,
    pub sessions_with_input_tokens: i64,
    pub turns: i64,
    pub autopilot_continuations: i64,
    pub tokens: BucketTokens,
    pub tools: BucketTools,
    pub lines: BucketLines,
    /// トークンの出所別のセッション数(TokenSource::ALL の順)
    pub token_sources: JsMap<i64>,
    pub sessions_missing_tokens: i64,
    pub skills: BucketSkills,
    pub agents: BucketAgents,
    pub hooks: BucketHooks,
    pub instructions: BucketInstructions,
    pub wiki: BucketWiki,
    pub friction: Friction,
    pub duration_ms: Distribution,
    pub active_ms: Distribution,
    pub exec: BucketExec,
    pub friction_detail: FrictionDetail,
    pub todos: BucketTodos,
}

/// 中央値と p90(件数付き)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Quantiles {
    pub n: i64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QuantilesWithOutliers {
    pub n: i64,
    pub median: Option<f64>,
    pub p90: Option<f64>,
    pub outliers: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LatencyQuantiles {
    pub ttft: Quantiles,
    pub duration: Quantiles,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBucket {
    pub sessions: i64,
    pub requests: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub reasoning: f64,
    pub premium_requests: f64,
    pub nano_aiu: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InstalledSkillsSummary {
    pub installed: Vec<String>,
    pub disabled: Vec<String>,
    pub unused: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsFile {
    pub schema_version: i64,
    pub generated_at: String,
    /// 集計から外した空のセッションの数
    pub empty_sessions: i64,
    pub overall: MetricsBucket,
    pub by_project: JsMap<MetricsBucket>,
    pub by_client: JsMap<MetricsBucket>,
    /// 月は UTC の YYYY-MM(createdAt 基準)
    pub by_month: JsMap<MetricsBucket>,
    pub by_model: JsMap<ModelBucket>,
    pub installed_skills: Option<InstalledSkillsSummary>,
    pub latency: JsMap<LatencyQuantiles>,
    pub tool_durations: JsMap<QuantilesWithOutliers>,
    /// 依頼(ターン)単位の集計(段階 1)。古い metrics.json には無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<crate::turns::TurnMetrics>,
}
