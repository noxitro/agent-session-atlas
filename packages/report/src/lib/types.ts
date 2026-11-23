// HTML に埋め込むデータ(atlas.html の <script type="application/json" id="atlas-data">)。
// sessions.json の SessionRecord から生イベント・timeline・長文を落とした要約だけを持つ。
// ここはブラウザ側(Svelte)と Node 側(build)の両方から読むので、DOM や node: に依存しない。
import type { FailureCauses } from '../shared/tool-failure.ts';
import type { LineChanges, MetricsFile, ProjectSource, TodoSummary, TokenSource } from '../shared/types.ts';
import type { MemoSummary } from './memo.ts';
import type { RetentionItem, RetentionMeta } from './retention.ts';
import type { TurnTuple } from './turns.ts';
import type { VerdictTuple } from './verdicts.ts';

// 3: Phase 6(tools.mcp・issues / skills を trigger 別に / agents.byName に失敗とトークン / hooks.byType /
//    lines / projectSource / installed)
// 4: Phase 7(exec / tools.durations・outliers / frictionDetail / todos)
// 5: Phase 10(groups / warnings.notes)
// 6: Phase 11(library)
// 7: Phase 12(skillChars / instructionVersions / analysis / insights)
// 8: Phase 13(memo)
// 9: turnRows(依頼単位の分析の段階 1)
// 10: person(送り先が人ごとに分けてあるときの、人ごとの内訳)
// 11: tools.causes(ツールの失敗の要因別の回数)
// 12: retention(AI の変更がその後の VCS のファイルに残っているか。atlas vcs の結果)
// 13: exec.modelEfforts(モデル別 × 推論強度別)
// 14: exec.mainModelEfforts(本体のリクエストだけの モデル別 × 推論強度別)
// 15: exec.mainModelEfforts をリクエスト数だけにした(トークンと AIU は modelEfforts にある)
// 16: failures(失敗の台帳の集計のページ failures.html を書いたか)
// 17: tests(テストの結果の要約。テストの実行があるセッションだけ)・groups[].tag(送り先の元のタグ)・wikiVaults(参照を数えた vault の数)・wiki.otherCalls(vault の検索・一覧など)
// 18: wikiPageNames(読んだ llm-wiki のページの名前の辞書)・wiki.pages(読んだページの番号。重複を除く)・judgment.wikiPages(ページごとの LLM の見立て)
// 19: groups(タスクタグ)をやめた
// 20: tasks(管理ツールのタスク。紐づけ・タスクごとの工数。値は Rust が決め、画面は出すだけ)
// 21: tasks.links の taskId(1 つ)を taskIds(いくつかのタスク)に。tasks.links[].countedTaskIds(工数を等分するタスク)・tasks.items[].sharedSessions・tasks.summary.sharedSessions(いくつかのタスクに数えたセッション)
export const REPORT_DATA_VERSION = 21;

/** wiki.pages を埋め込んだ最初の版(これより前の埋め込みでは、llm-wiki のページごとの表を出さない) */
export const WIKI_PAGES_DATA_VERSION = 18;

/** llm-wiki のページごとの「役立ったか」(LLM の見立て) */
export type WikiHelpful = 'yes' | 'no' | 'unknown';
/** [ページの名前, 役立ったか, 理由]。judgments.json から読んだ形(埋め込みには入れない) */
export type WikiPageVerdict = [page: string, helpful: WikiHelpful, reason: string];
/** [ページの番号(ReportData.wikiPageNames の添字), 役立ったか]。埋め込みの形。判定のパケットに載せたページだけ */
export type WikiPageMark = [page: number, helpful: WikiHelpful];

/**
 * テストの結果の要約(テストの実行ファイルが書いた印つきの行から。crates/atlas-core/src/test_results.rs)。
 * テストの実行(結果を出したツールの呼び出し)が 1 回以上あるセッションだけ。実行ごとの結果やテストの名前は埋め込まない
 */
export interface TestsSummary {
  /** テストの実行の数 */
  runs: number;
  /** 最初に全部通った実行の番号(1 から)。一度も通っていなければ null(未達) */
  firstPass: number | null;
  /** 最後の実行の後で、まだ通っていないテストの数(0 なら最後は全部通っている) */
  lastFailing: number;
  /** 最初に全部通った実行までの実働(ミリ秒)。未達なら null */
  passActiveMs: number | null;
  /** 最初に全部通った実行までの AI 使用量(nano AIU)。未達か、リクエストごとの記録が無ければ null */
  passNanoAiu: number | null;
  /** 最後の実行までの AI 使用量(nano AIU)。リクエストごとの記録が無ければ null(未達のセッションに、AI 使用量の記録があるかを見分けるのに使う) */
  lastNanoAiu: number | null;
}

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
  /** モデル → 推論強度 → [リクエスト, 入力, 出力, nano AIU](記録の無い古い sessions.json からは空) */
  modelEfforts: Record<string, Record<string, EffortTuple>>;
  /**
   * 本体(サブエージェントでない)のリクエスト数だけの モデル → 推論強度 → リクエスト数(記録の無いセッション・古い sessions.json からは空)。
   * 本体の推論強度を決めるのに使うのはリクエスト数だけなので、トークンと AIU は埋め込まない
   */
  mainModelEfforts: Record<string, Record<string, number>>;
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
  /** 作業の要約。無ければ null */
  taskSummary: string | null;
  /** AI が依頼を達成したか */
  completed: boolean | null;
  /** 成果の質(1〜5) */
  quality: number | null;
  /** 手戻りの多さ(0〜5) */
  rework: number | null;
  /** 指示ファイル / llm-wiki / skill・agent の効果(-2〜+2) */
  effects: { instructions: number | null; wiki: number | null; skillsAgents: number | null };
  /** 工数推定の根拠(自由記述)。HTML 本体には埋め込まず詳細ページだけに出す(埋め込みでは null) */
  rationale: string | null;
  /** この判定を出したバックエンド(external / copilot-cli など) */
  backend: string | null;
  /** この判定を出したモデル(項目の judge.model。項目に judge が無い古い判定は、ファイル全体の judge.model)。分からなければ無い */
  model?: string;
  /**
   * この判定をした日時(項目の judge.ranAt。ISO)。項目に judge が無い古い判定では無い
   * (ファイル全体の judge.ranAt は最後に書き込んだ回のもので、そのセッションを判定した日時とは限らない)
   */
  ranAt?: string;
  /**
   * llm-wiki のページごとの「役立ったか」と理由(judgments.json から読んだ形。名前で持つ)。
   * 版 1 の判定・項目の無い判定・配列でない項目では無い(そのセッションのページは未判定)。埋め込みの要約では落とし、wikiPages に置き換える
   */
  wikiPageVerdicts?: WikiPageVerdict[];
  /** 埋め込みの要約だけ: 判定のパケットに載せたページの見立て(ページは ReportData.wikiPageNames の番号。理由は入れない) */
  wikiPages?: WikiPageMark[];
}

export interface SessionSummary {
  id: string;
  /** Phase 13: メモの概要(全文は埋め込まない)。無ければ省略 */
  memo?: MemoSummary | null;
  client: string | null;
  /** 集計キー */
  project: string;
  /** 表示用の短い名前 */
  projectLabel: string;
  /** プロジェクトの決め方(git の origin・(ホーム)・(一時フォルダ) など) */
  projectSource: ProjectSource;
  branch: string | null;
  /**
   * 送り先(<送り先>/<人>/<プロジェクト>)をまとめて集計したときの、人のフォルダの名前。
   * それ以外の集計・古い埋め込みでは null か省略
   */
  person?: string | null;
  /** セッション名(無ければ null) */
  name: string | null;
  /** 最初の依頼の先頭(無ければ null) */
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
    /** 失敗のあったツールだけ: ツール名 → 失敗の要因別の回数(古い記録から作ったものには無い) */
    causes?: Record<string, FailureCauses>;
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
  /** Phase 12: skill 名 → 本文の文字数(記録が無ければ null) */
  skillChars: Record<string, number | null>;
  /** Phase 12: 注入された指示文の版 [contentHash, 文字数, 注入回数] */
  instructionVersions: [hash: string, chars: number, injections: number][];
  /** Phase 12: 手戻り・失敗の連続(改善点の分析。ターンごとの列と依頼文は埋め込まない) */
  analysis: { filesReedited: number; extraEdits: number; maxConsecutiveFailures: number; turns: number };
  /** 依頼(ターン)ごとの工程・種類・詰まり(lib/turns.ts の TurnTuple)。ターンの記録が無いセッション・古い埋め込みには無い */
  turnRows?: TurnTuple[];
  /** テストの結果の要約。テストの実行が無いセッション・古い埋め込みには無い */
  tests?: TestsSummary;
  /** 段階 2: 依頼ごとの LLM 判定(lib/verdicts.ts の VerdictTuple)。判定済みの依頼があるセッションだけ */
  turnVerdicts?: VerdictTuple[];
  agents: { total: number; failed: number; byName: Record<string, AgentStat> };
  hooks: { total: number; byType: Record<string, number> };
  /** 注入された指示ファイル(ファイル種別ごとの文字数。ユーザー単位のものは「AGENTS.md (user)」) */
  instructions: Record<string, number>;
  /** 変更行数(shutdown の累計、無ければツールの合計) */
  lines: LineChanges;
  /**
   * otherCalls: vault に触れたそのほかの呼び出し(検索・一覧など。版 15 以前の埋め込みでは 0 で埋め戻す)。
   * pages: 読んだページ(重複を除いて読んだ順)の番号。名前は ReportData.wikiPageNames に 1 回だけ置く(本文は入れない)。
   * 版 17 以前の埋め込みには無く [] で埋め戻すので、ページごとの表を出すかは ReportData.version で見分ける
   */
  wiki: { indexReads: number; pageReads: number; skillCalls: number; writes: number; otherCalls: number; pages: number[] };
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
  /** AI の変更がその後の VCS のファイルに残っているか(atlas vcs の結果)。照合していないセッション・古い埋め込みには無い */
  retention?: RetentionItem;
}

export interface ReportData {
  version: number;
  generatedAt: string;
  /** CLI で絞った条件(画面に表示するだけ) */
  scope: { since: string | null; project: string | null; client: string | null; model: string | null; branch: string | null };
  /** sessions.json の総件数(CLI フィルタ前) */
  totalSessionsInSource: number;
  /**
   * アップロードしたフォルダを集計したときの、そのフォルダ(この PC の Copilot のデータを集計したときには無い)。
   * layout: flat はセッションのフォルダが並ぶ 1 つのフォルダ、merged は下のフォルダをまとめたもの(folders はその数)
   */
  source?: { name: string; path: string; layout: 'flat' | 'merged'; folders: number } | null;
  /** 参照を数えた llm-wiki の vault の数。0 なら wiki の参照は数えていない(どのセッションも 0 件)。古い集計では無い */
  wikiVaults?: number;
  /** 読んだ llm-wiki のページの名前の辞書(セッションの wiki.pages と judgment.wikiPages はこの番号)。版 17 以前の埋め込みには無い */
  wikiPageNames?: string[];
  /** 読むだけの画面として作った(送り先から集計した・別のフォルダを開いた)。メモは送った人のもの。古い埋め込みには無い */
  readOnly?: boolean;
  /**
   * 送り先から集計したときの、送った atlas の版(crates/atlas-core/src/atlas_version.rs の describe_atlas_builds)。送った人ごとにまとめる。ok = 対応が要る人がいない。
   * short は見出しのタグ、headline は 1 行、lines は人ごとの内訳と頼むこと。
   * この PC の記録だけを集計したとき・古い埋め込みには無い
   */
  atlasBuilds?: { ok: boolean; short: string; headline: string; lines: string[] } | null;
  metrics: MetricsFile;
  sessions: SessionSummary[];
  judgments: { available: boolean; backend: string | null; model: string | null; ranAt: string | null; items: number };
  /** 段階 2: 依頼ごとの LLM 判定(turn-judgments.json)。phases は判定に使った普段の工程名(VerdictTuple の工程の番号の先)。古い埋め込みには無い */
  turnJudgments?: { available: boolean; model: string | null; ranAt: string | null; items: number; phases: string[] };
  /** AI の変更がその後の VCS のファイルに残っているかを照合した条件(atlas vcs)。照合していなければ null。古い埋め込みには無い */
  retention?: RetentionMeta | null;
  /** インストール済みの skill(snapshot で名前だけ記録)。記録が無ければ null */
  installed: { skills: string[]; disabled: string[] } | null;
  /** 人のフォルダの名前ごとのインストール済みの skill(送り先の全体を集計したとき。古い埋め込みには無い) */
  installedByPerson?: Record<string, { skills: string[]; disabled: string[] }>;
  /** Phase 11: 指示文と skill の閲覧ページ(instructions.html)を作ったか(export のとき) */
  library: boolean;
  /** 失敗の台帳の集計のページ(failures.html)を作ったか(古い版で作った atlas.html には無い) */
  failures?: boolean;
  /** Phase 12: 改善点(build 時に全セッションで計算したもの) */
  insights: {
    meta: Record<string, { heading: string; file: string; series: string; order: number; firstAt: string | null; lastAt?: string | null }>;
    /** 上位 30 件(全件は insights.html と insights.json) */
    candidates: InsightCandidate[];
    /** 候補の全件数(埋め込みは上位 30 件だけ。古いデータには無い) */
    candidateTotal?: number;
    computedOver: number;
  };
  /** notes: 集計のときの注意(無ければ空) */
  warnings: { unknownEventTypes: number; badLines: number; notes: string[] };
  /** 管理ツールのタスク(crates/atlas-report/src/tasks/view.rs の TasksView)。設定もタスクの記録も無ければ無い。版 19 以前の埋め込みにも無い */
  tasks?: TasksReport | null;
}

/** 紐づけの出所(機械・LLM・手動) */
export type TaskLinkSource = 'machine' | 'llm' | 'manual';

/** 完了の時刻の出所(記録: XML の完了日時・観測: 完了を最初に見た書き出しの時刻) */
export type TaskDoneAtSource = 'recorded' | 'observed';
export interface TaskDoneAtCounts {
  recorded: number;
  observed: number;
}

/** 比べられるタスクから外した理由 */
export type TaskExcluded = 'notDone' | 'doneUnobserved' | 'afterDone' | 'noStart' | 'noWorkHours' | 'unjudged' | 'lowConfidence';

/** タスク 1 件の値(Rust の tasks::metrics::TaskRow。画面は出すだけ) */
export interface TaskRow {
  id: string;
  name: string;
  status: string;
  done: boolean;
  /** 完了を確認した時刻(完了を最初に見た XML の更新時刻) */
  doneAt: string | null;
  /** 完了の時刻が分かる(未完了から完了に変わるのを見たか、XML に完了日時の記録があった。分からなければ工数を数えない) */
  doneObserved: boolean;
  /** 完了の時刻の出所(recorded: XML の完了日時。observed: 完了を最初に見た書き出しの時刻)。未完了なら null。古い埋め込みには無い */
  doneAtSource?: TaskDoneAtSource | null;
  /** 記録の完了日時が日付だけのときの、暦の日付の文字("2026-11-20"。画面はこれをそのまま出す)。doneAt は、集計した PC の時間帯でのその日の稼働時間帯の終わり。そうでなければ無い */
  doneDate?: string;
  /** 最後に読んだ XML に無かった */
  missing: boolean;
  /** 紐づいたセッションのうち最も早い開始(完了を確認した時刻より後に始まったセッションは使わない) */
  start: string | null;
  /** AI を使った場合の工数(稼働時間帯のミリ秒)。完了に変わるのを見ていなければ null */
  workMs: number | null;
  /** AI の実働(ミリ秒。いくつかのタスクに紐づいたセッションは、タスクの数で等分した分) */
  aiActiveMs: number;
  /** AI を使わなかった場合の工数(推定人手工数の時間。確信度の低い推定は入れない。いくつかのタスクに紐づいたセッションは等分した分) */
  humanHours: number;
  sessions: number;
  /** 紐づいたセッションのうち、ほかのタスクにも紐づいているもの(実働と推定人手工数はタスクの数で等分した) */
  sharedSessions: number;
  judgedSessions: number;
  lowConfidenceSessions: number;
  unjudgedSessions: number;
  /** 完了を確認した時刻より後に始まったセッションの数(手動か LLM の紐づけ) */
  afterDoneSessions: number;
  links: { machine: number; llm: number; manual: number };
  comparable: boolean;
  excluded: TaskExcluded | null;
  /**
   * 詰まりを見る列(Rust の tasks::extras。紐づいたセッションすべてを 1 つずつ数え、等分しない)。古い埋め込みには無い。
   * people: 人の記録のあるセッションの人の数(どのセッションにも人の記録が無ければ null)
   */
  people?: number | null;
  /** 主なモデル(紐づいたセッションの本体のリクエストがいちばん多いモデル)と、その割合(0〜1)。記録が無ければ null */
  mainModel?: string | null;
  mainModelShare?: number | null;
  /** ツールの失敗・拒否・中断・文脈圧縮の数 */
  friction?: TaskFriction;
  /** 依頼ごとの判定(LLM の推定)。判定した依頼が無ければ null */
  verdicts?: TaskVerdicts | null;
}

export interface TaskFriction {
  toolFailures: number;
  aborts: number;
  compactions: number;
}

/** タスクの依頼ごとの判定。割合(0〜1)は分母(直しと不採用は判定できた作業の依頼、的外れは判定できた質問)が TaskSummary.verdictMin に届かなければ null */
export interface TaskVerdicts {
  judged: number;
  workDecided: number;
  questionDecided: number;
  fix: number;
  rejected: number;
  offTarget: number;
  fixRate: number | null;
  rejectedRate: number | null;
  offTargetRate: number | null;
}

/** タスクの合計(比べられるタスクだけ) */
export interface TaskSummary {
  tasks: number;
  doneTasks: number;
  /** 完了したタスク(doneTasks)の、完了の時刻の出所ごとの数。古い埋め込みには無い */
  doneSources?: TaskDoneAtCounts;
  included: number;
  /** 比べられるタスク(included)の、完了の時刻の出所ごとの数。古い埋め込みには無い */
  includedSources?: TaskDoneAtCounts;
  /** noWorkHours は古い埋め込みには無い(0 として読む) */
  excluded: { notDone: number; doneUnobserved: number; afterDone: number; noStart: number; noWorkHours?: number; unjudged: number; lowConfidence: number };
  workMs: number;
  humanHours: number;
  aiActiveMs: number;
  aiActiveMsAll: number;
  /** いくつかのタスクに紐づいたセッションの数(重ねて数えない) */
  sharedSessions: number;
  /** AI を使わなかった場合 ÷ AI を使った場合。比べられるタスクが ratioMin に届かなければ null */
  ratio: number | null;
  ratioMin: number;
  /** タスクごとの依頼ごとの判定の割合を出す、分母の依頼の数の下限(lib/compare.ts の COMPARE_MIN_TURNS と同じ数)。古い埋め込みには無い */
  verdictMin?: number;
}

export interface TaskLinkView {
  /** 紐づいたタスク(並びは決めた順)。空は「どのタスクでもない」 */
  taskIds: string[];
  /** 実働と推定人手工数を数えるタスク(Rust の tasks::metrics::counted_tasks。一覧にあり、完了を確認した後に始めたのではないもの)。それぞれに 1/(この数) ずつ */
  countedTaskIds?: string[];
  source: TaskLinkSource;
  reason: string;
  confidence?: number;
}

export interface TasksReport {
  configured: boolean;
  /** local: この PC の記録から。sender: 送った人がセッションごとに添えた記録から(読むだけの画面) */
  origin: 'local' | 'sender';
  file: string | null;
  observedAt: string | null;
  workHours: { days: number[]; start: string; end: string };
  warnings: string[];
  items: TaskRow[];
  /** セッション id → 紐づけ */
  links: Record<string, TaskLinkView>;
  summary: TaskSummary;
  /** 絞り込んだセッション(--task など)だけで作った。serve の画面は、絞り込まない GET /api/tasks の値で置き換えない */
  scoped?: boolean;
}

/** Phase 12: スキル化の候補(埋め込み用。lib/insights.ts の Candidate と同じ形) */
export interface InsightCandidate {
  kind: 'request' | 'tools';
  key: string;
  count: number;
  sessions: string[];
  medianMs: number | null;
  score: number;
  representative: string | null;
  examples: string[];
  tools: string[] | null;
}
