// sessions.json / metrics.json のスキーマ。後続フェーズ(cli / report / judge)はここだけを参照する。

// 2: Phase 5(empty / autopilotContinuations / tools.internal / files.deleted・sessionState、
//    metrics は空のセッションを除いた集計 + emptySessions / tokenSources)
// 3: Phase 6(tools.mcp・results / skills[].trigger / lines / projectSource / installed、
//    metrics は tools.results・mcp / skills.byTrigger / agents.byNameDetail / lines / installedSkills)
// 4: Phase 7(exec: モード・推論強度・起点・文脈の内訳・待ち時間 / tools.durations・durationOutliers /
//    frictionDetail / todos / agents[].error、metrics は exec / frictionDetail / todos と latency / toolDurations)
export const SESSIONS_SCHEMA_VERSION = 4;
export const METRICS_SCHEMA_VERSION = 4;

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
}

export type SkillTrigger = 'user' | 'agent';

/** ツール 1 種類の結果(tool.execution_complete の success と error.code) */
export interface ToolResult {
  success: number;
  /** success: false で error.code が denied 以外(failure など) */
  failure: number;
  /** error.code: denied(利用者・権限設定による拒否) */
  denied: number;
}

/**
 * 変更行数。shutdown: session.shutdown.codeChanges(最後の値。セッション全体の累計)/
 * tools: shutdown に無いので tool.execution_complete の toolTelemetry.metrics の合計 / none: どちらも無い
 */
export interface LineChanges {
  added: number;
  removed: number;
  source: 'shutdown' | 'tools' | 'none';
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
  aborts: number;
  errors: number;
  permissionRequests: number;
  askUser: number;
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
  /** compaction 自体が使ったトークン(compactionTokensUsed の和)と、compaction で減ったトークン(tokensRemoved の和) */
  compaction: { recorded: number; input: number; output: number; nanoAiu: number; tokensRemoved: number };
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
  kind: 'user' | 'tools' | 'agent' | 'skill' | 'compaction' | 'abort' | 'error' | 'task_complete';
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
  /** 変更行数(追加 / 削除) */
  lines: LineChanges;
  skills: SkillUse[];
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
  source: { root: string | null; snapshotDir: string; since: string | null };
  /** empty: 依頼 0・ツール 0・応答 0 のセッション数(sessions には含む) */
  counts: { sessions: number; dbOnly: number; dirOnly: number; both: number; empty: number };
  /** インストール済みの skill / プラグイン(snapshot の記録。古いスナップショットでは null) */
  installed: InstalledInventory | null;
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
}
