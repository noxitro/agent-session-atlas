import type { FailureCauses } from './tool-failure.ts';
import type { DesktopData, DesktopSessionInfo } from './desktop-types.ts';
import type { TurnMetrics } from './turns.ts';
import type { AtlasBuild, FolderUpload } from './atlas-version.ts';
// sessions.json / metrics.json のスキーマ。後続フェーズ(cli / report / judge)はここだけを参照する。

// 2: Phase 5(empty / autopilotContinuations / tools.internal / files.deleted・sessionState、
//    metrics は空のセッションを除いた集計 + emptySessions / tokenSources)
// 3: Phase 6(tools.mcp・results / skills[].trigger / lines / projectSource / installed、
//    metrics は tools.results・mcp / skills.byTrigger / agents.byNameDetail / lines / installedSkills)
// 4: Phase 7(exec: モード・推論強度・起点・文脈の内訳・待ち時間 / tools.durations・durationOutliers /
//    frictionDetail / todos / agents[].error、metrics は exec / frictionDetail / todos と latency / toolDurations)
// 5: Phase 11(desktop / desktop.json)
// 6: Phase 12(analysis / skills[].chars)
// 7: availableSkills(システムメッセージの <available_skills> に並んだ、そのセッションで使えた skill)
// 8: 実データとの突き合わせの修正(lines.note / frictionDetail.compaction.removedRecorded・agentModelChanges /
//    timeline の shutdown 行。abort の 2 件目・サブエージェント失敗と対の session.error・source: agent のモデル切り替えは数えない)
// 9: analysis.turnActiveMs(ターンごとの実働。スキル化の候補のスコアに使う)
// 10: analysis.turnStats(依頼単位の分析の段階 1: ターンごとのツールの種類・失敗・拒否・中断・再編集・使用量)
// 11: person(送り先が人ごとに分けてあるときの、その人のフォルダの名前)
// 13: tools.results[].causes(ツールの失敗の要因別の回数)。error.code: rejected も拒否に数える
// 14: uploadAtlas(送り先から集計したときの、そのセッションのフォルダを写した atlas の版)
// 15: uploadFolder(送り先から集計したときの、そのセッションの送り先のフォルダ)・source.uploads(フォルダごとの最後に送った日時と版)
// 16: exec.modelEfforts(モデル別 × 推論強度別のリクエスト数・トークン)
export const SESSIONS_SCHEMA_VERSION = 16;
// 5: turns(依頼単位の工程 × 詰まり・依頼の種類の集計)
// 6: tools.results[].causes(ツールの失敗の要因別の回数)
export const METRICS_SCHEMA_VERSION = 6;

// ---------- 入力(生データ) ----------

/** events.jsonl の 1 行 */
export interface CopilotEvent {
  type: string;
  data?: any;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  agentId?: string;
}

export interface ParseStats {
  lines: number;
  parsed: number;
  badLines: number;
  blankLines: number;
}

/** workspace.yaml(必要なキーだけ) */
export interface WorkspaceInfo {
  id?: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  branch?: string;
  name?: string;
  summary?: string;
  client_name?: string;
  host_type?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** session-store.db の行 */
export interface DbSessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  host_type: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface DbTurnRow {
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

export interface DbUsageRow {
  id?: number;
  session_id: string;
  turn_index: number | null;
  agent_id: string | null;
  parent_tool_call_id: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_nano_aiu: number | null;
  request_multiplier: number | null;
  initiator: string | null;
  reasoning_effort?: string | null;
  finish_reason?: string | null;
  duration_ms?: number | null;
  time_to_first_token_ms?: number | null;
  created_at: string | null;
}

export interface DbFileRow {
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
  first_seen_at: string | null;
}

// ---------- 正規化セッションレコード(sessions.json の 1 要素) ----------

export type SessionSource = 'db' | 'dir';

/**
 * db: assistant_usage_events のみ / events: session.usage_record のみ /
 * db+events: 両方(DB 優先、usage_record で補完)/
 * shutdown: DB も usage_record も無く、最後の session.shutdown.modelMetrics の累積値で埋めた
 *   (実データで DB/events と両方あるセッション 63 件中 62 件で input/output が完全一致)/
 * partial: 入力トークン無し(assistant.message の outputTokens 等のみ)/ none: 何も無い
 * 優先順位: db / events / db+events > shutdown > partial > none
 */
export type TokenSource = 'db' | 'events' | 'db+events' | 'shutdown' | 'partial' | 'none';

export interface TokenCounts {
  /** 入力トークン。記録が無ければ null(UI で「推計不可」) */
  input: number | null;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** premium request(ユーザー起点リクエストの倍率の和)。不明なら null */
  premiumRequests: number | null;
  nanoAiu: number | null;
  /** API リクエスト数。shutdown 由来で件数が無ければ null */
  requests: number | null;
}

export interface SessionTokens extends TokenCounts {
  source: TokenSource;
  /** 採用したレコード件数(DB 行 / usage_record で補った行)。shutdown 由来は全て 0 */
  records: { db: number; events: number; duplicatesRemoved: number };
  byModel: Record<string, TokenCounts>;
  /** agent 名(main = 親セッション) */
  byAgent: Record<string, TokenCounts>;
  /** session.shutdown の最終値。source が shutdown のときは合計値の出所、それ以外では参考値 */
  shutdown: ShutdownTotals | null;
  /** subagent.completed.totalTokens の合計(参考値) */
  subagentTotalTokens: number;
  /** compaction 直前のトークン数の最大値(参考値) */
  maxPreCompactionTokens: number | null;
}

export interface ShutdownTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  premiumRequests: number | null;
  nanoAiu: number | null;
}

export interface SkillUse {
  name: string;
  at: string | null;
  /** tool: toolName "skill" / event: skill.invoked(_ref) / both: 同じ呼び出しを両方で観測 */
  via: 'tool' | 'event' | 'both';
  /**
   * user: 利用者が呼んだ(skill.invoked の trigger: user-invoked)/ agent: エージェントが呼んだ
   * (trigger: agent-invoked、または toolName "skill" のツール呼び出し。ツールはモデルが呼ぶため)/
   * null: trigger を持たない古い skill.invoked だけで、どちらか分からない
   */
  trigger: SkillTrigger | null;
  /** Phase 12: 本文の文字数(skill.invoked の content。無ければ null) */
  chars?: number | null;
}

/**
 * そのセッションで使えた skill(システムメッセージの <available_skills> の 1 項目)。
 * location はログのまま(実データでは user / project / custom / builtin)
 */
export interface AvailableSkill {
  name: string;
  location: string | null;
}

/** Phase 12: 改善点の分析に使う、セッション内の並びから求める量 */
export interface SessionAnalysis {
  /** 同じファイルを 2 回以上編集したファイル数(edit / str_replace_editor / apply_patch / fileEdits の edit で数える) */
  filesReedited: number;
  /** 2 回目以降の編集の回数の合計(手戻りの大きさ) */
  extraEdits: number;
  /** ツール失敗の最長の連続回数(内部ツールを除く) */
  maxConsecutiveFailures: number;
  /** 本体のユーザーのターンごとのツール名の列(先頭 200 ターン、各 40 件まで。サブエージェントのツールは含めない) */
  turnTools: string[][];
  /** ターンごとの所要(ms。次のターンまたは最後のイベントまで。分からなければ null) */
  turnMs: (number | null)[];
  /** ターンごとの実働(ms。ターンの中で 5 分を超えてイベントが無かった区間を除く。返答待ちや放置を含めない。分からなければ null) */
  turnActiveMs: (number | null)[];
  /** 依頼文の先頭 300 字(ターンごと、先頭 200 件。伏せ字版の HTML には埋め込まない) */
  requests: string[];
  /**
   * 段階 1(依頼単位の分析): ターンごとの出来事(turnTools と同じ並び・同じ件数)。
   * ターンの始まりから次の依頼までに起きたもの(サブエージェントの分も含む)。古い sessions.json には無い
   */
  turnStats?: TurnStats[];
}

/** ツールの種類(依頼単位の工程の推定に使う。turns.ts の toolKind) */
export const TOOL_KINDS = ['read', 'edit', 'verify', 'git', 'shell', 'plan', 'web', 'delegate', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** 1 ターン(利用者の 1 回の依頼から次の依頼の直前まで)の出来事 */
export interface TurnStats {
  startedAt: string | null;
  /** 作業のツール呼び出しの種類別の回数(内部ツールを除く。サブエージェントの分も含む) */
  kinds: Partial<Record<ToolKind, number>>;
  /** 作業のツール呼び出しの数(kinds の合計) */
  tools: number;
  /** 失敗(拒否を除く) */
  toolFailures: number;
  /** 拒否(error.code: denied) */
  denied: number;
  /** このターンの中での失敗の最長の連続 */
  maxConsecutiveFailures: number;
  /** ファイルの編集の回数 */
  edits: number;
  /** 前の依頼(同じセッション)で編集したファイルを、この依頼でもう一度編集した回数(手戻りの兆し) */
  reEdits: number;
  /** この依頼の中で同じファイルを重ねて編集した回数(普通の進め方。詰まりには数えない)。古い記録には無い */
  repeatEdits?: number;
  /** 中断(続けて出る 2 件目は数えない) */
  aborts: number;
  /** session.error(サブエージェントの失敗と対になるものは除く) */
  errors: number;
  /** errors のうち利用上限・速度制限(quota / rate_limit) */
  externalErrors: number;
  subagentFailures: number;
  compactions: number;
  askUser: number;
  /** このターンの間に始まったリクエストの使用量(リクエストの時刻で振り分け。記録が無ければ null) */
  input: number | null;
  output: number | null;
  nanoAiu: number | null;
}

export type SkillTrigger = 'user' | 'agent';

/** ツール 1 種類の結果(tool.execution_complete の success と error.code) */
export interface ToolResult {
  success: number;
  /** success: false で error.code が denied・rejected 以外(failure など) */
  failure: number;
  /** error.code: denied・rejected(利用者・権限設定による拒否) */
  denied: number;
  /**
   * failure の要因別の回数(error の種類と文の 1 行目から決まった規則で分けた種類。文そのものは残さない。
   * 規則は tool-failure.ts)。失敗が無ければ無い。古い記録(スキーマ 12 まで)にも無い
   */
  causes?: FailureCauses;
}

/**
 * 変更行数。shutdown: session.shutdown.codeChanges(最後の値。セッション全体の累計)/
 * tools: shutdown に無いので tool.execution_complete の toolTelemetry.metrics の合計 / none: どちらも無い
 */
export interface LineChanges {
  added: number;
  removed: number;
  source: 'shutdown' | 'tools' | 'none';
  /**
   * ファイルの変更が記録されているのに行数が欠けている・足りない理由(出所が tools / none のときだけ)。
   * subagent-edits: サブエージェントの編集に行数の記録が無い(数えられない)/
   * empty-shutdown: 終了時の codeChanges が 0 行・ファイル 0 件で当てにならない(再開の直前の空の shutdown など)
   */
  note?: 'subagent-edits' | 'empty-shutdown';
}

/**
 * プロジェクトキーの決め方。
 * repository: 記録の repository / git-remote: gitRoot(無ければ cwd から上へ探した .git)の origin /
 * path: gitRoot か cwd のパス / home: ホームディレクトリそのもの / temp: 一時フォルダ配下 /
 * atlas-judge: このツール自身の判定実行(cwd が atlas-judge-cwd-*)/ unknown: 手掛かりなし
 */
export type ProjectSource = 'repository' | 'git-remote' | 'path' | 'home' | 'temp' | 'atlas-judge' | 'unknown';

/** snapshot 時に ~/.copilot から名前だけ記録したインストール済みのもの(中身は読まない) */
export interface InstalledInventory {
  /** ~/.copilot/skills/ のディレクトリ名 */
  skills: string[];
  /** ~/.copilot/installed-plugins/<marketplace>/<plugin>/ と、その skills/ のディレクトリ名 */
  plugins: { marketplace: string; name: string; skills: string[] }[];
  /** settings.json の disabledSkills(無ければ空、読めなければ null) */
  disabledSkills: string[] | null;
  /** 読めなかったものの説明(黙って空にしない) */
  warnings: string[];
}

export interface AgentRun {
  name: string;
  id: string | null;
  startedAt: string | null;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  totalTokens: number | null;
  totalToolCalls: number | null;
  model: string | null;
  /** subagent.failed の error(先頭 200 字)。失敗以外は null */
  error: string | null;
}

export type InstructionFile =
  | 'AGENTS.md'
  | 'CLAUDE.md'
  | 'GEMINI.md'
  | 'copilot-instructions.md'
  | '.github/instructions'
  | 'unknown';

export type InstructionMethod =
  | 'imported-source' // <imported_custom_instruction source="...">
  | 'heading-keyword' // 先頭見出しに Copilot / Claude / AGENTS.md
  | 'apply-to' // .github/instructions/* の applyTo 前置文
  | 'import-stub' // @path だけの本文(CLAUDE.md の @import)
  | 'learned-heading' // 同じ見出しが他所で特定済み
  | 'cross-project' // 3 プロジェクト以上で同一内容 → ユーザー単位の指示
  | 'unresolved';

export interface InstructionInjection {
  file: InstructionFile;
  scope: 'repo' | 'user' | 'unknown';
  method: InstructionMethod;
  /** 文字数(コードポイント数) */
  chars: number;
  firstSeenAt: string | null;
  /** 先頭の空でない行(80 字まで) */
  heading: string;
  /** 内容のハッシュ(sha1 先頭 12 桁) */
  contentHash: string;
  /** 同じ内容が system.message に現れた回数 */
  injections: number;
  /** imported_custom_instruction の source(あれば) */
  sourcePath?: string;
}

export interface WikiUsage {
  indexReads: number;
  pageReads: string[];
  skillCalls: string[];
  writes: number;
  otherCalls: number;
}

export interface Friction {
  compactions: number;
  /** 中断(abort)。続けて出る 2 件目(parentId が直前の abort、2 秒以内)は数えない */
  aborts: number;
  /** session.error。サブエージェントの失敗と対になるもの(直後の subagent.failed の parentId)は subagentFailures だけに数える */
  errors: number;
  permissionRequests: number;
  askUser: number;
  /** 利用者・本体のモデル変更(session.model_change のうち source: agent を除く) */
  modelChanges: number;
  modeChanges: number;
  toolFailures: number;
  subagentFailures: number;
}

/** 推論強度別の集計(リクエスト単位) */
export interface EffortStat {
  requests: number;
  input: number;
  output: number;
  nanoAiu: number;
}

/**
 * 文脈の内訳(トークン)。source: shutdown(最後の session.shutdown)/ compaction(最後の compaction_complete)/
 * usage(usage_record の toolTokenCount だけ)/ null(記録なし)
 */
export interface ContextBreakdown {
  systemTokens: number | null;
  conversationTokens: number | null;
  /** ツール定義が占めるトークン(毎リクエストの文脈に常に入る) */
  toolDefinitionsTokens: number | null;
  /** 使えるツールの数(usage_record の availableToolCount の最後の値) */
  availableToolCount: number | null;
  source: 'shutdown' | 'compaction' | 'usage' | null;
}

/** Phase 7: 実行の性質 */
export interface ExecProfile {
  /**
   * モード別のユーザーターン数(interactive / plan / autopilot など)。
   * user.message の agentMode > 直前の session.mode_changed の newMode > 最初の mode_changed の previousMode の順で決め、
   * どれも無いターンは既定の interactive とみなして inferred にも数える(実データで最初の mode_changed の previousMode は全件 interactive)。
   * events.jsonl の無い(DB だけの)ターンは (unknown)
   */
  modes: { byMode: Record<string, number>; inferred: number };
  /**
   * 推論強度(reasoningEffort)別のリクエスト数・トークン・nano AIU。
   * リクエストの記録(DB の reasoning_effort / usage_record の reasoningEffort)> その時点の設定(session.start / model_change)。
   * 終了時の累計(shutdown)しか無いセッションは、セッション中の設定が 1 種類ならそれ、それ以外は (unknown) に入れる
   */
  efforts: Record<string, EffortStat>;
  /**
   * モデル → 推論強度 → リクエスト数・トークン・nano AIU(efforts をモデルごとに分けたもの。強度の決め方は efforts と同じ)。
   * 終了時の累計しか無いセッションは、モデル別の累計(tokens.byModel)を、セッション中の設定が 1 種類ならその強度、それ以外は (unknown) に入れる。
   * schema 15 以前の sessions.json には無い
   */
  modelEfforts?: Record<string, Record<string, EffortStat>>;
  /** リクエストの起点(DB / usage_record の initiator: user / agent / sub-agent / compaction / (unknown))。明細のあるリクエストだけ */
  initiators: Record<string, number>;
  context: ContextBreakdown;
  /** モデル別の待ち時間(ミリ秒の整数、リクエストごと)。ttft: 最初のトークンまで / duration: リクエスト全体 */
  latency: Record<string, { ttft: number[]; duration: number[] }>;
}

/** Phase 7: 摩擦の詳細 */
export interface FrictionDetail {
  /** permission.completed の result.kind(approved / approved-for-location / denied-… など)別の件数 */
  permissions: Record<string, number>;
  /** session.error の errorType(quota / rate_limit / query など)別の件数 */
  errorTypes: Record<string, number>;
  /** subagent.failed の理由の分類(quota / rate_limit / aborted / no_response / other)別の件数 */
  subagentFailures: Record<string, number>;
  /**
   * compaction 自体が使ったトークン(compactionTokensUsed の和。新旧 2 つの形を読む)と、compaction で減ったトークン(tokensRemoved の和)。
   * removedRecorded: tokensRemoved を持つ compaction の数(0 なら減ったトークンは記録なし。古い記録には無い)
   */
  compaction: { recorded: number; input: number; output: number; nanoAiu: number; tokensRemoved: number; removedRecorded?: number };
  /** session.model_change のうち source: agent(サブエージェントの起動に伴う切り替え)の数。friction.modelChanges には含めない。古い記録には無い */
  agentModelChanges?: number;
}

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

/** Phase 7: session-state/<id>/session.db の todos(状態別の件数)と todo_deps(依存の数)。タイトルは読まない */
export interface TodoSummary {
  total: number;
  byStatus: Record<string, number>;
  deps: number;
}

export interface TimelineEntry {
  at: string;
  /** shutdown: 所要時間の終わりになった session.shutdown(最後の行より後にあるときだけ、末尾に 1 行) */
  kind: 'user' | 'tools' | 'agent' | 'skill' | 'compaction' | 'abort' | 'error' | 'task_complete' | 'shutdown';
  label: string;
  count?: number;
  tools?: Record<string, number>;
}

export interface SessionRecord {
  id: string;
  sources: SessionSource[];
  client: string | null;
  cwd: string | null;
  gitRoot: string | null;
  repository: string | null;
  branch: string | null;
  name: string | null;
  /** 集計用のプロジェクトキー(repository > git の origin > (ホーム)・(一時フォルダ)・(atlas の判定) > gitRoot > cwd) */
  project: string;
  /** project の決め方 */
  projectSource: ProjectSource;
  /**
   * 送り先(<送り先>/<人>/<プロジェクト>/<セッション id>)をまとめて集計したときの、人のフォルダの名前。
   * この PC の記録・人のフォルダやプロジェクトのフォルダだけを集計したとき・古い sessions.json には無い(null か省略)
   */
  person?: string | null;
  /**
   * 送り先から集計したときの、送った人がそのセッションに付けていたタスクタグ(送った時点のもの。atlas-session.json の tags)。
   * 送り先から集計したセッションにだけある(タグが無ければ空)。この PC の記録・古い sessions.json には無い
   */
  uploadTags?: string[];
  /**
   * 送り先から集計したときの、そのセッションのフォルダを写した atlas の版(atlas-session.json の atlas)。
   * 記録が無い(前の版で送った)ものは null。この PC の記録・古い sessions.json には無い(省略)
   */
  uploadAtlas?: AtlasBuild | null;
  /**
   * 送り先から集計したときの、そのセッションを数えた送り先のフォルダ(元のルートからの相対パス。source.uploads のキーと同じ書き方。
   * 直下にセッションが並ぶ形は '.')。分からなければ null。送り先から集計したセッションにだけある
   */
  uploadFolder?: string | null;
  copilotVersion: string | null;
  schemaVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 最初と最後のイベントの差(壁時計) */
  durationMs: number | null;
  /** 5 分を超える無イベント区間を除いた時間 */
  activeMs: number | null;
  /** ユーザーの依頼の数(source 付き・autopilot の自動継続を除く) */
  turns: number;
  /** autopilot の自動継続(user.message の isAutopilotContinuation: true)。turns には数えない */
  autopilotContinuations: number;
  /** 本体の応答の数(サブエージェントの応答を除く) */
  assistantMessages: number;
  /** 依頼 0・ツール 0・応答 0(開いただけのセッション)。既定の集計から外す */
  empty: boolean;
  firstUserMessage: string | null;
  lastAssistantMessage: string | null;
  models: string[];
  tokens: SessionTokens;
  /** 作業としてのツール呼び出し。内部ツール(report_intent 等)は internal に別計上 */
  tools: {
    byName: Record<string, number>;
    total: number;
    internal: { byName: Record<string, number>; total: number };
    /** MCP サーバー別のツール呼び出し(tool.execution_start の mcpServerName)。キーは byName と同じツール名 */
    mcp: Record<string, Record<string, number>>;
    /** ツール別の結果(complete が start と toolCallId で対応したものだけ。内部ツールは除く) */
    results: Record<string, ToolResult>;
    /** ツール別の所要時間(start → complete を toolCallId で対応、ミリ秒の整数)。1 時間を超えるものは外れ値として除く */
    durations: Record<string, number[]>;
    /** 1 時間を超えて外した呼び出しの数(ツール別) */
    durationOutliers: Record<string, number>;
  };
  /** 実行の性質(モード・推論強度・起点・文脈の内訳・待ち時間) */
  exec: ExecProfile;
  /** 摩擦の詳細 */
  frictionDetail: FrictionDetail;
  /** todo(session.db が無ければ null) */
  todos: TodoSummary | null;
  /**
   * Phase 11: デスクトップアプリの data.db から許可リストの列だけを読んだもの(desktop.json)。
   * アプリで開いていないセッション・data.db が無いときは null
   */
  desktop?: DesktopSessionInfo | null;
  /** 変更行数(追加 / 削除) */
  lines: LineChanges;
  /** Phase 12: 改善点の分析用(手戻り・失敗の連続・ターンごとのツールの列・依頼文) */
  analysis: SessionAnalysis;
  skills: SkillUse[];
  /**
   * 使えた skill(<available_skills> の和集合、初めて出た順)。一覧がシステムメッセージに無いセッションは null
   * (Copilot CLI 1.0.77 より前の版、copilot -p など)。古い sessions.json には無い
   */
  availableSkills?: AvailableSkill[] | null;
  agents: AgentRun[];
  hooks: { byType: Record<string, number>; total: number };
  instructions: InstructionInjection[];
  wiki: WikiUsage;
  friction: Friction;
  /**
   * 変更したファイル(cwd 基準の絶対パス、Windows は大文字小文字を無視して重複除去)。
   * sessionState: ~/.copilot/session-state/ 配下(plan.md 等)で一覧から外したファイルの数
   */
  files: { changed: string[]; created: string[]; deleted: string[]; sessionState: number };
  timeline: TimelineEntry[];
  unknownEventTypes: Record<string, number>;
  events: { total: number; badLines: number; byType: Record<string, number> };
}

export interface SessionsFile {
  schemaVersion: number;
  generatedAt: string;
  /**
   * layout と folders は、アップロードしたフォルダから集計したときだけある('flat' はフォルダ 1 つ、'merged' は下のフォルダをまとめて読んだもの。
   * folders はまとめて読んだフォルダの名前)
   */
  source: {
    root: string | null;
    snapshotDir: string;
    since: string | null;
    layout?: 'flat' | 'merged';
    folders?: string[];
    /** フォルダごとの、最後に送ったときの日時と atlas の版(snapshot の manifest の uploads)。送り先から集計したときだけある */
    uploads?: Record<string, FolderUpload>;
  };
  /** Phase 11: data.db の読み取りの状態(WAL の注意、表ごとの列の扱い)。無ければ null */
  desktop?: { readAt: string; wal: DesktopData['wal']; coverage: DesktopData['coverage']; warnings: string[]; sessions: number } | null;
  /** empty: 依頼 0・ツール 0・応答 0 のセッション数(sessions には含む) */
  counts: { sessions: number; dbOnly: number; dirOnly: number; both: number; empty: number };
  /** インストール済みの skill / プラグイン(snapshot の記録。古いスナップショットでは null) */
  installed: InstalledInventory | null;
  /** 送り先の全体を集計したときの、人のフォルダの名前ごとのインストール済みの記録(送った人が添えたもの)。無ければ無い */
  installedByPerson?: Record<string, InstalledInventory> | null;
  warnings: { unknownEventTypes: Record<string, number>; badLines: number; messages: string[] };
  sessions: SessionRecord[];
}

// ---------- 集計(metrics.json) ----------

export interface Distribution {
  total: number;
  median: number | null;
  p90: number | null;
}

export interface MetricsBucket {
  sessions: number;
  sessionsWithInputTokens: number;
  turns: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    premiumRequests: number;
    nanoAiu: number;
    requests: number;
  };
  /** autopilot の自動継続(turns には含まない) */
  autopilotContinuations: number;
  /** total / byName は内部ツールを除く。internal は内部ツール(report_intent 等)の件数 */
  tools: {
    total: number;
    byName: Record<string, number>;
    internal: number;
    /** MCP サーバー別の呼び出し数 */
    mcp: Record<string, number>;
    /** ツール別の成功・失敗・拒否 */
    results: Record<string, ToolResult>;
  };
  /** 変更行数。sessionsWithRecord: 出所が shutdown / tools のセッション数 */
  lines: { added: number; removed: number; sessionsWithRecord: number; bySource: Record<LineChanges['source'], number> };
  /** トークンの出所別のセッション数(出力トークンの出所でもある) */
  tokenSources: Record<TokenSource, number>;
  /** DB・usage_record・shutdown・assistant.message の outputTokens のいずれも無い(トークンが欠測の)セッション数 */
  sessionsMissingTokens: number;
  skills: { total: number; byName: Record<string, number>; sessionsWithAny: number; byTrigger: { user: number; agent: number; unknown: number } };
  agents: {
    total: number;
    failed: number;
    byName: Record<string, number>;
    /** agent 別の回数・失敗・トークン(subagent.completed の totalTokens の和) */
    byNameDetail: Record<string, { runs: number; failed: number; tokens: number }>;
    sessionsWithAny: number;
  };
  hooks: { total: number; byType: Record<string, number> };
  instructions: {
    sessionsWithAny: number;
    byFile: Record<string, { sessions: number; chars: number }>;
  };
  wiki: { sessionsWithAny: number; indexReads: number; pageReads: number; skillCalls: number; writes: number };
  friction: Friction;
  durationMs: Distribution;
  activeMs: Distribution;
  /** Phase 7: モード別のターン・推論強度別・リクエストの起点・ツール定義の量 */
  exec: {
    modes: { byMode: Record<string, number>; inferred: number };
    efforts: Record<string, EffortStat>;
    initiators: Record<string, number>;
    /** ツール定義のトークン(セッションの最後の値)。sessions: 記録のあるセッション数 */
    context: { sessions: number; toolDefinitionsTokens: Distribution & { mean: number | null }; availableToolCount: { sessions: number; mean: number | null } };
  };
  frictionDetail: FrictionDetail;
  /** sessionsWithDb: session.db のあるセッション / sessionsWithTodos: todo が 1 件以上 / completionRate: done ÷ total(0 件なら null) */
  todos: { sessionsWithDb: number; sessionsWithTodos: number; total: number; byStatus: Record<string, number>; deps: number; completionRate: number | null };
}

/** 中央値と p90(件数付き)。値が無ければ null */
export interface Quantiles {
  n: number;
  median: number | null;
  p90: number | null;
}

export interface ModelBucket extends Omit<TokenCounts, 'input' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'premiumRequests' | 'nanoAiu' | 'requests'> {
  sessions: number;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  premiumRequests: number;
  nanoAiu: number;
}

export interface MetricsFile {
  schemaVersion: number;
  generatedAt: string;
  /** 集計から外した空のセッション(依頼 0・ツール 0・応答 0)の数。以下の集計はすべて空を除いた値 */
  emptySessions: number;
  overall: MetricsBucket;
  byProject: Record<string, MetricsBucket>;
  byClient: Record<string, MetricsBucket>;
  /** 月は UTC の YYYY-MM(createdAt 基準) */
  byMonth: Record<string, MetricsBucket>;
  /** モデル別はトークン系のみ(1 セッションが複数モデルを使うため) */
  byModel: Record<string, ModelBucket>;
  /** インストール済みの skill と、集計対象の期間に一度も使われなかったもの(インベントリが無ければ null) */
  installedSkills: { installed: string[]; disabled: string[]; unused: string[] } | null;
  /** Phase 7: モデル別の待ち時間(最初のトークンまで / リクエスト全体、ミリ秒) */
  latency: Record<string, { ttft: Quantiles; duration: Quantiles }>;
  /** Phase 7: ツール別の所要時間(ミリ秒。1 時間超は外れ値として除き outliers に数える) */
  toolDurations: Record<string, Quantiles & { outliers: number }>;
  /** 依頼(ターン)単位の工程別・依頼の種類別の集計(段階 1)。古い metrics.json には無い */
  turns?: TurnMetrics;
}
