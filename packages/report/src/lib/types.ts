// HTML に埋め込むデータ(atlas.html の <script type="application/json" id="atlas-data">)。
// sessions.json の SessionRecord から生イベント・timeline・長文を落とした要約だけを持つ。
// ここはブラウザ側(Svelte)と Node 側(build)の両方から読むので、DOM や node: に依存しない。
import type { LineChanges, MetricsFile, ProjectSource, TodoSummary, TokenSource } from '../../../core/src/types.ts';

// 3: Phase 6(tools.mcp・issues / skills を trigger 別に / agents.byName に失敗とトークン / hooks.byType /
//    lines / projectSource / installed)
// 4: Phase 7(exec / tools.durations・outliers / frictionDetail / todos)
export const REPORT_DATA_VERSION = 4;

/** 推論強度別の [リクエスト, 入力, 出力, nano AIU] */
export type EffortTuple = [requests: number, input: number, output: number, nanoAiu: number];
/** 文脈の内訳 [system, conversation, ツール定義, 使えるツールの数](記録の無い項目は null) */
export type ContextTuple = [system: number | null, conversation: number | null, toolDefinitions: number | null, availableTools: number | null];

/** Phase 7: 実行の性質(埋め込み用の短い形) */
export interface ExecSummary {
  /** モード → ユーザーターン数(既定の interactive とみなしたものを含む) */
  modes: Record<string, number>;
  /** 記録が無く既定の interactive とみなしたターン数(modes の interactive に含む) */
  modesInferred: number;
  efforts: Record<string, EffortTuple>;
  /** リクエストの起点 → 回数 */
  initiators: Record<string, number>;
  /** 記録が全く無ければ null */
  context: ContextTuple | null;
  /** モデル → [最初のトークンまで(ms)[], リクエスト全体(ms)[]] */
  latency: Record<string, [ttft: number[], duration: number[]]>;
}

/** Phase 7: 摩擦の詳細(埋め込み用) */
export interface FrictionDetailSummary {
  /** permission.completed の結果 [承認, 拒否, その他] */
  permissions: [approved: number, denied: number, other: number];
  errorTypes: Record<string, number>;
  subagentFailures: Record<string, number>;
  /** compaction 自体のトークン [記録のある回数, 入力, 出力, nano AIU, 減ったトークン] */
  compaction: [recorded: number, input: number, output: number, nanoAiu: number, tokensRemoved: number];
}

/** [失敗, 拒否, 結果のあった回数]。失敗・拒否が無く、全呼び出しに結果があるツールは持たない(サイズ節約) */
export type ToolIssue = [failure: number, denied: number, completed: number];
/** skill の [利用者が呼んだ, エージェントが呼んだ, 不明] の回数 */
export type SkillTriggers = [user: number, agent: number, unknown: number];
/** agent の [回数, 失敗, トークン(subagent.completed の totalTokens の和)] */
export type AgentStat = [runs: number, failed: number, tokens: number];

/** 入力トークン記録の有無を UI 向けに 3 区分にしたもの */
export type InputCoverage = 'input' | 'output-only' | 'none';

export interface TokenSummary {
  input: number | null;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  premiumRequests: number | null;
  nanoAiu: number | null;
  requests: number | null;
  source: TokenSource;
}

export interface ModelTokenSummary {
  input: number | null;
  output: number;
  cacheRead: number | null;
  premiumRequests: number | null;
  requests: number | null;
}

export interface JudgmentSummary {
  taskCategory: string | null;
  /** 推定人手工数(時間) */
  hours: number | null;
  low: number | null;
  high: number | null;
  /** 推定の確信度(0〜1) */
  confidence: number | null;
  /** 伏せ字モードでは null */
  taskSummary: string | null;
  /** AI が依頼を達成したか */
  completed: boolean | null;
  /** 成果の質(1〜5) */
  quality: number | null;
  /** 手戻りの多さ(0〜5) */
  rework: number | null;
  /** 指示ファイル / llm-wiki / skill・agent の効果(-2〜+2) */
  effects: { instructions: number | null; wiki: number | null; skillsAgents: number | null };
  /** 工数推定の根拠(自由記述)。HTML 本体には埋め込まず詳細ページだけに出す。伏せ字モードでは null */
  rationale: string | null;
  /** この判定を出したバックエンド(external / copilot-cli など) */
  backend: string | null;
}

export interface SessionSummary {
  id: string;
  client: string | null;
  /** 集計キー(伏せ字モードでは project-01 など) */
  project: string;
  /** 表示用の短い名前 */
  projectLabel: string;
  /** プロジェクトの決め方(git の origin・(ホーム)・(一時フォルダ) など) */
  projectSource: ProjectSource;
  branch: string | null;
  /** セッション名(伏せ字モードでは null) */
  name: string | null;
  /** 最初の依頼の先頭(伏せ字モードでは null) */
  firstUserMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  activeMs: number | null;
  turns: number;
  /** autopilot の自動継続(turns に含まない) */
  autopilotContinuations: number;
  /** 依頼 0・ツール 0・応答 0。既定の絞り込みでは除外する */
  empty: boolean;
  models: string[];
  tokens: TokenSummary;
  coverage: InputCoverage;
  byModel: Record<string, ModelTokenSummary>;
  /**
   * total / byName は内部ツールを除く。internal は内部ツール(report_intent 等)の件数。
   * mcp: MCP サーバー → そのサーバーのツール名(byName のキー)→ 回数。issues: 失敗・拒否・結果なしがあったツールだけ
   */
  tools: {
    total: number;
    byName: Record<string, number>;
    internal: number;
    mcp: Record<string, Record<string, number>>;
    issues: Record<string, ToolIssue>;
    /** ツール別の所要時間(ms、1 時間超を除く) */
    durations: Record<string, number[]>;
    /** 1 時間を超えて外した回数(ツール別) */
    outliers: Record<string, number>;
  };
  /** 実行の性質(モード・推論強度・起点・文脈の内訳・待ち時間) */
  exec: ExecSummary;
  frictionDetail: FrictionDetailSummary;
  /** todo の状態別件数(session.db が無ければ null) */
  todos: TodoSummary | null;
  /** skill 名 → 呼んだ側別の回数 */
  skills: Record<string, SkillTriggers>;
  agents: { total: number; failed: number; byName: Record<string, AgentStat> };
  hooks: { total: number; byType: Record<string, number> };
  /** 注入された指示ファイル(ファイル種別ごとの文字数。ユーザー単位のものは「AGENTS.md (user)」) */
  instructions: Record<string, number>;
  /** 変更行数(shutdown の累計、無ければツールの合計) */
  lines: LineChanges;
  wiki: { indexReads: number; pageReads: number; skillCalls: number; writes: number };
  friction: {
    compactions: number;
    aborts: number;
    errors: number;
    permissionRequests: number;
    askUser: number;
    modelChanges: number;
    modeChanges: number;
    toolFailures: number;
    subagentFailures: number;
  };
  /** sessionState: ~/.copilot/session-state/ 配下で一覧から外したファイル数 */
  files: { changed: number; created: number; deleted: number; sessionState: number };
  /** 詳細ページへの相対リンク */
  href: string;
  judgment: JudgmentSummary | null;
}

export interface ReportData {
  version: number;
  generatedAt: string;
  anonymized: boolean;
  /** CLI で絞った条件(画面に表示するだけ) */
  scope: { since: string | null; project: string | null; client: string | null; model: string | null; branch: string | null };
  /** sessions.json の総件数(CLI フィルタ前) */
  totalSessionsInSource: number;
  metrics: MetricsFile;
  sessions: SessionSummary[];
  judgments: { available: boolean; backend: string | null; model: string | null; ranAt: string | null; items: number };
  /** インストール済みの skill(snapshot で名前だけ記録)。記録が無ければ null */
  installed: { skills: string[]; disabled: string[] } | null;
  warnings: { unknownEventTypes: number; badLines: number };
}
