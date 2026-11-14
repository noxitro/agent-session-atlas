//! HTML に埋め込むデータの形(packages/report/src/lib/types.ts の移植)。
//! sessions.json の SessionRecord から生イベント・timeline・長文を落とした要約だけを持つ。
//!
//! フィールドの並びは TS が組み立てる順(summarize が作る順のあとに、build が足す turnVerdicts・retention・memo)。
//! 埋め込みを読み直す(古い埋め込み・pack の埋め戻し)ときに無いことがある項目は `#[serde(default)]`。
//! ReportData 全体は build(段 4-2)が組み立てる順で書くので、ここでは版の番号と、要約の形だけを持つ。

use crate::memo::MemoSummary;
use crate::retention::RetentionItem;
use crate::turns::TurnTuple;
use crate::verdicts::VerdictTuple;
use atlas_core::js::JsMap;
use atlas_core::types::{Friction, LineChanges, ProjectSource, TodoSummary, TokenSource};
use serde::{Deserialize, Serialize};

/// 埋め込みデータの版(lib/types.ts の REPORT_DATA_VERSION。版の履歴はそちらの先頭のコメントを参照)
pub const REPORT_DATA_VERSION: i64 = 13;

/// 推論強度別の [リクエスト, 入力, 出力, nano AIU]
pub type EffortTuple = [f64; 4];
/// 文脈の内訳 [system, conversation, ツール定義, 使えるツールの数](記録の無い項目は null)
pub type ContextTuple = [Option<f64>; 4];
/// [失敗, 拒否, 結果のあった回数]
pub type ToolIssue = [i64; 3];
/// skill の [利用者が呼んだ, エージェントが呼んだ, 不明] の回数
pub type SkillTriggers = [i64; 3];
/// agent の [回数, 失敗, トークン]
pub type AgentStat = (i64, i64, f64);

/// Phase 7: 実行の性質(埋め込み用の短い形)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecSummary {
    /// モード → ユーザーターン数(既定の interactive とみなしたものを含む)
    pub modes: JsMap<i64>,
    /// 記録が無く既定の interactive とみなしたターン数
    pub modes_inferred: i64,
    pub efforts: JsMap<EffortTuple>,
    /// モデル → 推論強度 → [リクエスト, 入力, 出力, nano AIU](記録の無い古い sessions.json からは空)
    #[serde(default)]
    pub model_efforts: JsMap<JsMap<EffortTuple>>,
    pub initiators: JsMap<i64>,
    /// 記録が全く無ければ null
    pub context: Option<ContextTuple>,
    /// モデル → [最初のトークンまで(ms)[], リクエスト全体(ms)[]]
    pub latency: JsMap<(Vec<f64>, Vec<f64>)>,
}

/// Phase 7: 摩擦の詳細(埋め込み用)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionDetailSummary {
    /// permission.completed の結果 [承認, 拒否, その他]
    pub permissions: [i64; 3],
    pub error_types: JsMap<i64>,
    pub subagent_failures: JsMap<i64>,
    /// compaction 自体のトークン [記録のある回数, 入力, 出力, nano AIU, 減ったトークン]
    pub compaction: [f64; 5],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSummary {
    pub input: Option<f64>,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub reasoning: Option<f64>,
    pub premium_requests: Option<f64>,
    pub nano_aiu: Option<f64>,
    pub requests: Option<f64>,
    pub source: TokenSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokenSummary {
    pub input: Option<f64>,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub premium_requests: Option<f64>,
    pub requests: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentEffects {
    pub instructions: Option<f64>,
    pub wiki: Option<f64>,
    pub skills_agents: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentSummary {
    pub task_category: Option<String>,
    /// 推定人手工数(時間)
    pub hours: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
    /// 推定の確信度(0〜1)
    pub confidence: Option<f64>,
    /// 伏せ字モードでは null
    pub task_summary: Option<String>,
    /// AI が依頼を達成したか
    pub completed: Option<bool>,
    /// 成果の質(1〜5)
    pub quality: Option<f64>,
    /// 手戻りの多さ(0〜5)
    pub rework: Option<f64>,
    /// 指示ファイル / llm-wiki / skill・agent の効果(-2〜+2)
    pub effects: JudgmentEffects,
    /// 工数推定の根拠。HTML 本体には埋め込まず詳細ページだけに出す。伏せ字モードでは null
    pub rationale: Option<String>,
    /// この判定を出したバックエンド
    pub backend: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsSummary {
    pub total: i64,
    pub by_name: JsMap<i64>,
    pub internal: i64,
    /// MCP サーバー → そのサーバーのツール名(byName のキー)→ 回数
    pub mcp: JsMap<JsMap<i64>>,
    /// 失敗・拒否・結果なしがあったツールだけ
    pub issues: JsMap<ToolIssue>,
    /// 失敗のあったツールだけ: ツール名 → 失敗の要因別の回数(古い記録から作ったものには無い)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causes: Option<JsMap<JsMap<i64>>>,
    /// ツール別の所要時間(ms、1 時間超を除く)
    pub durations: JsMap<Vec<f64>>,
    /// 1 時間を超えて外した回数(ツール別)
    pub outliers: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSummary {
    pub total: i64,
    pub failed: i64,
    pub by_name: JsMap<AgentStat>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksSummary {
    pub total: i64,
    pub by_type: JsMap<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSummary {
    pub index_reads: i64,
    pub page_reads: i64,
    pub skill_calls: i64,
    pub writes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesSummary {
    pub changed: i64,
    pub created: i64,
    pub deleted: i64,
    pub session_state: i64,
}

/// Phase 12: 手戻り・失敗の連続(改善点の分析)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSummary {
    pub files_reedited: i64,
    pub extra_edits: i64,
    pub max_consecutive_failures: i64,
    pub turns: i64,
}

/// 入力トークン記録の有無を UI 向けに 3 区分にしたもの(input / output-only / none)
pub type InputCoverage = &'static str;

/// 埋め込むセッションの要約(lib/types.ts の SessionSummary)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub client: Option<String>,
    /// 集計キー(伏せ字モードでは project-01 など)
    pub project: String,
    /// 表示用の短い名前
    pub project_label: String,
    pub project_source: ProjectSource,
    pub branch: Option<String>,
    /// 送り先をまとめて集計したときの、人のフォルダの名前(伏せ字モードでは person-01 など)。それ以外は null
    #[serde(default)]
    pub person: Option<String>,
    /// セッション名(伏せ字モードでは null)
    pub name: Option<String>,
    /// 最初の依頼の先頭(伏せ字モードでは null)
    pub first_user_message: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub duration_ms: Option<f64>,
    pub active_ms: Option<f64>,
    pub turns: i64,
    /// autopilot の自動継続(turns に含まない)
    pub autopilot_continuations: i64,
    /// 依頼 0・ツール 0・応答 0。既定の絞り込みでは除外する
    pub empty: bool,
    pub models: Vec<String>,
    pub tokens: TokenSummary,
    /// input / output-only / none
    pub coverage: String,
    pub by_model: JsMap<ModelTokenSummary>,
    pub tools: ToolsSummary,
    pub exec: ExecSummary,
    pub friction_detail: FrictionDetailSummary,
    /// todo の状態別件数(session.db が無ければ null)
    pub todos: Option<TodoSummary>,
    pub skills: JsMap<SkillTriggers>,
    pub agents: AgentsSummary,
    pub hooks: HooksSummary,
    /// 注入された指示ファイル(ファイル種別ごとの文字数。ユーザー単位のものは「AGENTS.md (user)」)
    pub instructions: JsMap<i64>,
    /// 変更行数(shutdown の累計、無ければツールの合計)
    pub lines: LineChanges,
    pub wiki: WikiSummary,
    pub friction: Friction,
    /// Phase 12: skill 名 → 本文の文字数(記録が無ければ null)
    pub skill_chars: JsMap<Option<f64>>,
    /// Phase 12: 注入された指示文の版 [contentHash, 文字数, 注入回数]
    pub instruction_versions: Vec<(String, i64, i64)>,
    pub analysis: AnalysisSummary,
    /// 依頼(ターン)ごとの工程・種類・詰まり。ターンの記録が無いセッション・古い埋め込みには無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_rows: Option<Vec<TurnTuple>>,
    /// sessionState: ~/.copilot/session-state/ 配下で一覧から外したファイル数
    pub files: FilesSummary,
    /// 詳細ページへの相対リンク
    pub href: String,
    pub judgment: Option<JudgmentSummary>,
    /// 段階 2: 依頼ごとの LLM 判定。判定済みの依頼があるセッションだけ(build が足す)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_verdicts: Option<Vec<VerdictTuple>>,
    /// AI の変更がその後の VCS のファイルに残っているか(build が足す)。照合していないセッション・古い埋め込みには無い
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<RetentionItem>,
    /// Phase 13: メモの概要(build が足す)。無ければ省略。伏せ字版では常に無し
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<MemoSummary>,
}

/// Phase 12: スキル化の候補(埋め込み用。insights の Candidate と同じ形)
pub type InsightCandidate = crate::insights::Candidate;

/// 名前付きグループ(ReportData.groups)
pub type ReportGroup = crate::groups::SessionGroup;
