// 絞り込んだ SessionSummary[] から画面の集計を作る純関数。
// core の computeMetrics と同じ定義(合計は記録のあるセッションだけの和、月は UTC の YYYY-MM)。
import { EFFORT_ORDER, execAggregate, orderBy, type ExecAggregate } from './exec.ts';
import { hasPeople, UNKNOWN } from './filter.ts';
import { addCauses, FAILURE_CAUSE_LABELS, type FailureCause, type FailureCauses } from '../../../core/src/tool-failure.ts';
import type { SessionSummary } from './types.ts';

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  premiumRequests: number;
  nanoAiu: number;
  requests: number;
}

/** 入力トークン記録の内訳(出所別) */
export interface CoverageBreakdown {
  /** DB / usage_record の明細から(リクエスト単位) */
  detailed: number;
  /** session.shutdown の累計値だけ */
  shutdown: number;
  /** 出力トークンだけ(入力は推計不可) */
  outputOnly: number;
  /** トークン記録なし(欠測): 空でないのに DB・usage_record・shutdown・outputTokens のいずれも無い */
  none: number;
  /** 空のセッション(「空のセッションを含める」のときだけ 0 以外) */
  empty: number;
}

export interface Bucket {
  key: string;
  label: string;
  sessions: number;
  sessionsWithInput: number;
  /** premium request の記録があるセッション数 */
  sessionsWithPremium: number;
  /** nano AIU の記録があるセッション数 */
  sessionsWithNanoAiu: number;
  turns: number;
  /** autopilot の自動継続(turns に含まない) */
  autopilotContinuations: number;
  /** 空のセッション数(sessions に含む。既定の絞り込みでは 0) */
  emptySessions: number;
  tokens: TokenTotals;
  tools: number;
  /** 内部ツール(report_intent 等)の呼び出し数。tools には含まない */
  toolsInternal: number;
  /** 変更行数(追加 / 削除)と、行数の記録があるセッション数 */
  linesAdded: number;
  linesRemoved: number;
  sessionsWithLines: number;
  skills: number;
  agents: number;
  agentFailures: number;
  hooks: number;
  sessionsWithInstructions: number;
  sessionsWithWiki: number;
  friction: number;
  frictionDetail: SessionSummary['friction'];
  activeMs: number;
  activeMedianMs: number | null;
  durationMs: number;
  firstAt: string | null;
  lastAt: string | null;
  /** 最終更新(セッションの更新日時のうち、いちばん後のもの。更新日時の無いセッションは開始日時で数える)。lastAt は開始日時のいちばん後 */
  updatedAt: string | null;
  /** judgments の推定人手工数(判定済みセッションだけの和) */
  judgedSessions: number;
  humanHours: number;
  /** 推定の幅(判定済みセッションの low / high の和) */
  humanLow: number;
  humanHigh: number;
  /** 判定済みセッションの推定人手工数の中央値(判定が無ければ null) */
  humanMedian: number | null;
  /** 推定人手工数の合計が少数のセッションに偏っているときの、その偏り(偏っていなければ null) */
  humanSkew: EffortSkew | null;
  /** 判定済みセッションの確信度の平均(判定が無ければ null) */
  judgedConfidence: number | null;
  /** 判定済みセッションに AI が使った量(AI 投入量 vs 推定人手工数の比較用) */
  judgedAi: { activeMs: number; activeKnown: number; output: number; input: number; inputKnown: number; premiumRequests: number };
}

/** モデルの推論強度別の行(key は推論強度。記録の無いものは (unknown)) */
export interface ModelEffortRow {
  key: string;
  /** そのモデルをその強度で使ったセッションの数 */
  sessions: number;
  requests: number;
  input: number;
  output: number;
  nanoAiu: number;
}

export interface ModelRow {
  model: string;
  sessions: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  premiumRequests: number;
  /** 推論強度別(強度の順。強度の記録の無い古い sessions.json から作ったセッションは数えない) */
  efforts: ModelEffortRow[];
}

/** 利用ランキングのツール行。MCP ツールはサーバーごとに 1 行(key は mcp:<サーバー>) */
export interface ToolRow {
  key: string;
  label: string;
  /** MCP サーバーの行ならサーバー名 */
  mcpServer: string | null;
  calls: number;
  /** 結果(complete)のあった回数 = success + failure + denied */
  completed: number;
  success: number;
  failure: number;
  denied: number;
  sessions: number;
  /** 失敗(failure)の要因別の回数。記録の無い古いセッションの失敗は入らない */
  causes: FailureCauses;
}

export interface McpRow {
  server: string;
  calls: number;
  completed: number;
  failure: number;
  denied: number;
  sessions: number;
  /** ツール名(byName のキー)と回数・失敗・失敗の要因。多い順 */
  tools: { name: string; calls: number; failure: number; causes: FailureCauses }[];
}

/** 失敗の要因ごとの行(ボトルネックを要因から見る) */
export interface CauseRow {
  cause: FailureCause;
  label: string;
  /** その要因の失敗の回数 */
  count: number;
  sessions: number;
  /** その要因で失敗したツール(MCP はサーバーの中のツール単位)。多い順 */
  tools: { key: string; label: string; mcpServer: string | null; count: number }[];
}

export interface SkillRow {
  name: string;
  uses: number;
  user: number;
  agent: number;
  unknown: number;
  sessions: number;
}

export interface AgentRow {
  name: string;
  runs: number;
  failed: number;
  tokens: number;
  sessions: number;
}

export interface CountRow {
  name: string;
  count: number;
  sessions: number;
}

export interface UsageRanking {
  tools: ToolRow[];
  mcp: McpRow[];
  skills: SkillRow[];
  agents: AgentRow[];
  hooks: CountRow[];
  /** 指示ファイル。count は注入されたセッション数(sessions と同じ) */
  instructions: CountRow[];
  /** 失敗の要因(多い順)。要因の記録がある失敗だけ */
  causes: CauseRow[];
  /** 失敗(failure)のうち、要因の記録が無いもの(古い記録から作ったセッションの失敗) */
  causesUnrecorded: number;
}

export interface Aggregate {
  overall: Bucket;
  coverage: CoverageBreakdown;
  byProject: Bucket[];
  /** 人ごと(送り先をまとめて集計したレポートだけ。人のフォルダの名前が 1 件も無ければ空)。key が UNKNOWN の行は、人のフォルダの下に無いセッション */
  byPerson: Bucket[];
  byMonth: Bucket[];
  byModel: ModelRow[];
  usage: UsageRanking;
  /** 実行の性質(モード・推論強度・起点・文脈・待ち時間・ツールの所要時間・摩擦の詳細・todo) */
  exec: ExecAggregate;
}

/** 失敗率 =(失敗 + 拒否)/ 結果のあった回数。結果が 0 件なら null */
export function failureRate(r: { completed: number; failure: number; denied: number }): number | null {
  return r.completed > 0 ? (r.failure + r.denied) / r.completed : null;
}

export function frictionTotal(f: SessionSummary['friction']): number {
  return f.compactions + f.aborts + f.errors + f.permissionRequests + f.askUser + f.toolFailures + f.subagentFailures;
}

function emptyFriction(): SessionSummary['friction'] {
  return { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.5 * s.length) - 1))];
}

/** 推定人手工数の合計の偏り: 推定の大きい上位 sessions 件(計 hours 時間)が、合計の share(0〜1)を占める */
export interface EffortSkew {
  sessions: number;
  hours: number;
  share: number;
}

/** 偏りを見る判定済みセッションの数の下限(これより少ないと、1 件が半分を超えるのは珍しくない) */
export const SKEW_MIN_SESSIONS = 5;
/** 上位として数える割合(判定済みセッションの 5%。1 件に満たなければ 1 件) */
export const SKEW_TOP_RATE = 0.05;
/** 上位がこの割合以上を占めたら「偏っている」とする */
export const SKEW_SHARE = 0.5;

/**
 * 推定人手工数(セッションごとの時間)の偏り。上位 5% のセッションが合計の半分以上を占めるときだけ返す。
 * 合計は和なので、AI が大量に生成したセッションの大きな推定が数件あるだけで、ほぼその値になる
 */
export function effortSkew(hours: number[]): EffortSkew | null {
  const total = hours.reduce((a, h) => a + h, 0);
  if (hours.length < SKEW_MIN_SESSIONS || total <= 0) return null;
  const n = Math.max(1, Math.round(hours.length * SKEW_TOP_RATE));
  const top = [...hours]
    .sort((a, b) => b - a)
    .slice(0, n)
    .reduce((a, h) => a + h, 0);
  const share = top / total;
  return share >= SKEW_SHARE ? { sessions: n, hours: Math.round(top * 100) / 100, share } : null;
}

export function bucket(key: string, label: string, sessions: SessionSummary[]): Bucket {
  const b: Bucket = {
    key,
    label,
    sessions: sessions.length,
    sessionsWithInput: 0,
    sessionsWithPremium: 0,
    sessionsWithNanoAiu: 0,
    turns: 0,
    autopilotContinuations: 0,
    emptySessions: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, premiumRequests: 0, nanoAiu: 0, requests: 0 },
    tools: 0,
    toolsInternal: 0,
    linesAdded: 0,
    linesRemoved: 0,
    sessionsWithLines: 0,
    skills: 0,
    agents: 0,
    agentFailures: 0,
    hooks: 0,
    sessionsWithInstructions: 0,
    sessionsWithWiki: 0,
    friction: 0,
    frictionDetail: emptyFriction(),
    activeMs: 0,
    activeMedianMs: null,
    durationMs: 0,
    firstAt: null,
    lastAt: null,
    updatedAt: null,
    judgedSessions: 0,
    humanHours: 0,
    humanLow: 0,
    humanHigh: 0,
    humanMedian: null,
    humanSkew: null,
    judgedConfidence: null,
    judgedAi: { activeMs: 0, activeKnown: 0, output: 0, input: 0, inputKnown: 0, premiumRequests: 0 },
  };
  let confSum = 0;
  let confN = 0;
  const actives: number[] = [];
  const humans: number[] = [];
  for (const s of sessions) {
    const t = s.tokens;
    if (t.input != null) b.sessionsWithInput++;
    if (t.premiumRequests != null) b.sessionsWithPremium++;
    if (t.nanoAiu != null) b.sessionsWithNanoAiu++;
    b.turns += s.turns;
    b.autopilotContinuations += s.autopilotContinuations;
    if (s.empty) b.emptySessions++;
    b.tokens.input += t.input ?? 0;
    b.tokens.output += t.output;
    b.tokens.cacheRead += t.cacheRead ?? 0;
    b.tokens.cacheWrite += t.cacheWrite ?? 0;
    b.tokens.reasoning += t.reasoning ?? 0;
    b.tokens.premiumRequests += t.premiumRequests ?? 0;
    b.tokens.nanoAiu += t.nanoAiu ?? 0;
    b.tokens.requests += t.requests ?? 0;
    b.tools += s.tools.total;
    b.toolsInternal += s.tools.internal;
    b.linesAdded += s.lines.added;
    b.linesRemoved += s.lines.removed;
    if (s.lines.source !== 'none') b.sessionsWithLines++;
    b.skills += Object.values(s.skills).reduce((a, t) => a + t[0] + t[1] + t[2], 0);
    b.agents += s.agents.total;
    b.agentFailures += s.agents.failed;
    b.hooks += s.hooks.total;
    if (Object.keys(s.instructions).length > 0) b.sessionsWithInstructions++;
    const w = s.wiki;
    if (w.indexReads + w.pageReads + w.skillCalls + w.writes > 0) b.sessionsWithWiki++;
    for (const k of Object.keys(b.frictionDetail) as (keyof SessionSummary['friction'])[]) b.frictionDetail[k] += s.friction[k];
    b.friction += frictionTotal(s.friction);
    if (s.activeMs != null) {
      b.activeMs += s.activeMs;
      actives.push(s.activeMs);
    }
    b.durationMs += s.durationMs ?? 0;
    const at = s.createdAt ?? s.updatedAt;
    if (at) {
      if (!b.firstAt || at < b.firstAt) b.firstAt = at;
      if (!b.lastAt || at > b.lastAt) b.lastAt = at;
    }
    const up = s.updatedAt ?? s.createdAt;
    if (up && (!b.updatedAt || Date.parse(up) > Date.parse(b.updatedAt))) b.updatedAt = up;
    const j = s.judgment;
    if (j?.hours != null) {
      b.judgedSessions++;
      humans.push(j.hours);
      b.humanHours += j.hours;
      b.humanLow += j.low ?? j.hours;
      b.humanHigh += j.high ?? j.hours;
      if (j.confidence != null) {
        confSum += j.confidence;
        confN++;
      }
      const ai = b.judgedAi;
      if (s.activeMs != null) {
        ai.activeMs += s.activeMs;
        ai.activeKnown++;
      }
      ai.output += t.output;
      if (t.input != null) {
        ai.input += t.input;
        ai.inputKnown++;
      }
      ai.premiumRequests += t.premiumRequests ?? 0;
    }
  }
  b.activeMedianMs = median(actives);
  b.judgedConfidence = confN ? confSum / confN : null;
  b.humanMedian = median(humans);
  b.humanSkew = effortSkew(humans);
  b.humanHours = Math.round(b.humanHours * 100) / 100;
  b.humanLow = Math.round(b.humanLow * 100) / 100;
  b.humanHigh = Math.round(b.humanHigh * 100) / 100;
  b.judgedAi.premiumRequests = Math.round(b.judgedAi.premiumRequests * 1000) / 1000;
  // 浮動小数の誤差(premium request は 0.33 倍などの和)を丸める
  b.tokens.premiumRequests = Math.round(b.tokens.premiumRequests * 1000) / 1000;
  return b;
}

/** 月キー(UTC の YYYY-MM)。core の monthKey と同じ定義 */
export function monthOf(s: Pick<SessionSummary, 'createdAt' | 'updatedAt'>): string {
  const t = s.createdAt ?? s.updatedAt;
  if (!t) return '(unknown)';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '(unknown)' : d.toISOString().slice(0, 7);
}

/** first〜last の間の月を欠けなく並べる(記録の無い月も 0 として出す) */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 600) break;
  }
  return out;
}

function groupBy(sessions: SessionSummary[], key: (s: SessionSummary) => string): Map<string, SessionSummary[]> {
  const g = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const k = key(s);
    const a = g.get(k);
    if (a) a.push(s);
    else g.set(k, [s]);
  }
  return g;
}

export function coverageBreakdown(sessions: SessionSummary[]): CoverageBreakdown {
  const c: CoverageBreakdown = { detailed: 0, shutdown: 0, outputOnly: 0, none: 0, empty: 0 };
  for (const s of sessions) {
    if (s.empty) c.empty++;
    else if (s.tokens.input != null) {
      if (s.tokens.source === 'shutdown') c.shutdown++;
      else c.detailed++;
    } else if (s.coverage === 'output-only') c.outputOnly++;
    else c.none++;
  }
  return c;
}

/**
 * people: 人ごとにもまとめるか。省くと、渡したセッションに人のフォルダの名前が 1 件でもあればまとめる。
 * 絞り込んだ後のセッションを渡すときは、レポート全体に人の軸があるかを渡す(「不明」だけに絞っても行を出すため)
 */
export function aggregate(sessions: SessionSummary[], people: boolean = hasPeople(sessions)): Aggregate {
  const labels = new Map(sessions.map((s) => [s.project, s.projectLabel]));
  const byProject = [...groupBy(sessions, (s) => s.project)].map(([k, v]) => bucket(k, labels.get(k) ?? k, v));
  const order = (a: Bucket, b: Bucket): number => b.tokens.output - a.tokens.output || b.sessions - a.sessions || a.key.localeCompare(b.key);
  byProject.sort(order);
  const byPerson = people ? [...groupBy(sessions, (s) => s.person ?? UNKNOWN)].map(([k, v]) => bucket(k, k === UNKNOWN ? '不明' : k, v)).sort(order) : [];

  const months = groupBy(sessions, monthOf);
  const known = [...months.keys()].filter((k) => k !== '(unknown)').sort();
  const monthKeys = known.length ? monthRange(known[0], known[known.length - 1]) : [];
  const byMonth = monthKeys.map((k) => bucket(k, k, months.get(k) ?? []));
  if (months.has('(unknown)')) byMonth.push(bucket('(unknown)', '日時不明', months.get('(unknown)')!));

  const models = new Map<string, ModelRow>();
  const modelEfforts = new Map<string, Map<string, ModelEffortRow>>();
  const modelRow = (m: string): ModelRow => {
    let r = models.get(m);
    if (!r) models.set(m, (r = { model: m, sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, premiumRequests: 0, efforts: [] }));
    return r;
  };
  for (const s of sessions) {
    for (const [m, byEffort] of Object.entries(s.exec.modelEfforts)) {
      modelRow(m);
      let es = modelEfforts.get(m);
      if (!es) modelEfforts.set(m, (es = new Map()));
      for (const [k, [requests, input, output, nanoAiu]] of Object.entries(byEffort)) {
        let e = es.get(k);
        if (!e) es.set(k, (e = { key: k, sessions: 0, requests: 0, input: 0, output: 0, nanoAiu: 0 }));
        e.sessions++;
        e.requests += requests;
        e.input += input;
        e.output += output;
        e.nanoAiu += nanoAiu;
      }
    }
    for (const [m, t] of Object.entries(s.byModel)) {
      const r = modelRow(m);
      r.sessions++;
      r.requests += t.requests ?? 0;
      r.input += t.input ?? 0;
      r.output += t.output;
      r.cacheRead += t.cacheRead ?? 0;
      r.premiumRequests += t.premiumRequests ?? 0;
    }
  }
  const byEffort = orderBy(EFFORT_ORDER);
  const byModel = [...models.values()].map((r) => ({
    ...r,
    premiumRequests: Math.round(r.premiumRequests * 1000) / 1000,
    efforts: [...(modelEfforts.get(r.model)?.values() ?? [])].sort((a, b) => byEffort(a.key, b.key)),
  }));
  byModel.sort((a, b) => b.output - a.output || b.sessions - a.sessions || a.model.localeCompare(b.model));

  return {
    overall: bucket('all', '全体', sessions),
    coverage: coverageBreakdown(sessions),
    byProject,
    byPerson,
    byMonth,
    byModel,
    usage: usageRanking(sessions),
    exec: execAggregate(sessions),
  };
}

function byCountThenName<T>(count: (x: T) => number, name: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => count(b) - count(a) || name(a).localeCompare(name(b));
}

/** 行を取り出す(無ければ作る)。同じセッションで 2 回目以降は sessions を数えない */
class Tally<T extends { sessions: number }> {
  private readonly rows = new Map<string, { row: T; last: number }>();
  private readonly make: (key: string) => T;
  constructor(make: (key: string) => T) {
    this.make = make;
  }
  get(key: string, sessionIndex: number): T {
    let e = this.rows.get(key);
    if (!e) this.rows.set(key, (e = { row: this.make(key), last: -1 }));
    if (e.last !== sessionIndex) {
      e.last = sessionIndex;
      e.row.sessions++;
    }
    return e.row;
  }
  values(): T[] {
    return [...this.rows.values()].map((e) => e.row);
  }
}

/** 絞り込んだセッションから利用ランキング(ツール・MCP・skill・agent・hook・指示ファイル)を作る */
export function usageRanking(sessions: SessionSummary[]): UsageRanking {
  const tools = new Tally<ToolRow>((key) => ({ key, label: key, mcpServer: null, calls: 0, completed: 0, success: 0, failure: 0, denied: 0, sessions: 0, causes: {} }));
  const mcp = new Tally<McpRow & { toolMap: Map<string, McpRow['tools'][number]> }>((server) => ({ server, calls: 0, completed: 0, failure: 0, denied: 0, sessions: 0, tools: [], toolMap: new Map() }));
  const causeRows = new Tally<CauseRow & { toolMap: Map<string, CauseRow['tools'][number]> }>((cause) => ({
    cause: cause as FailureCause,
    label: FAILURE_CAUSE_LABELS[cause as FailureCause] ?? cause,
    count: 0,
    sessions: 0,
    tools: [],
    toolMap: new Map(),
  }));
  let causesUnrecorded = 0;
  const skills = new Tally<SkillRow>((name) => ({ name, uses: 0, user: 0, agent: 0, unknown: 0, sessions: 0 }));
  const agents = new Tally<AgentRow>((name) => ({ name, runs: 0, failed: 0, tokens: 0, sessions: 0 }));
  const hooks = new Tally<CountRow>((name) => ({ name, count: 0, sessions: 0 }));
  const instructions = new Tally<CountRow>((name) => ({ name, count: 0, sessions: 0 }));

  sessions.forEach((s, i) => {
    const serverOf = new Map<string, string>();
    for (const [server, byTool] of Object.entries(s.tools.mcp)) for (const t of Object.keys(byTool)) serverOf.set(t, server);
    for (const [tool, calls] of Object.entries(s.tools.byName)) {
      const issue = s.tools.issues[tool];
      const failure = issue ? issue[0] : 0;
      const denied = issue ? issue[1] : 0;
      const completed = issue ? issue[2] : calls;
      const server = serverOf.get(tool) ?? null;
      const causes = s.tools.causes?.[tool];
      const recorded = Object.values(causes ?? {}).reduce((a, n) => a + n, 0);
      causesUnrecorded += Math.max(0, failure - recorded);
      for (const [cause, n] of Object.entries(causes ?? {})) {
        const c = causeRows.get(cause, i);
        c.count += n;
        const label = server && tool.startsWith(`${server}-`) ? tool.slice(server.length + 1) : tool;
        const t = c.toolMap.get(tool) ?? { key: tool, label, mcpServer: server, count: 0 };
        t.count += n;
        c.toolMap.set(tool, t);
      }
      const r = tools.get(server ? `mcp:${server}` : tool, i);
      r.label = server ?? tool;
      r.mcpServer = server;
      r.calls += calls;
      r.completed += completed;
      r.failure += failure;
      r.denied += denied;
      r.success += completed - failure - denied;
      addCauses(r.causes, causes);
      if (server) {
        const m = mcp.get(server, i);
        m.calls += calls;
        m.completed += completed;
        m.failure += failure;
        m.denied += denied;
        const mt = m.toolMap.get(tool) ?? { name: tool, calls: 0, failure: 0, causes: {} };
        mt.calls += calls;
        mt.failure += failure;
        addCauses(mt.causes, causes);
        m.toolMap.set(tool, mt);
      }
    }
    for (const [name, [user, agent, unknown]] of Object.entries(s.skills)) {
      const r = skills.get(name, i);
      r.uses += user + agent + unknown;
      r.user += user;
      r.agent += agent;
      r.unknown += unknown;
    }
    for (const [name, [runs, failed, tokens]] of Object.entries(s.agents.byName)) {
      const r = agents.get(name, i);
      r.runs += runs;
      r.failed += failed;
      r.tokens += tokens;
    }
    for (const [name, n] of Object.entries(s.hooks.byType)) hooks.get(name, i).count += n;
    for (const name of Object.keys(s.instructions)) instructions.get(name, i).count++;
  });

  return {
    tools: tools.values().sort(byCountThenName((x) => x.calls, (x) => x.key)),
    mcp: mcp
      .values()
      .map(({ toolMap, ...m }) => ({ ...m, tools: [...toolMap.values()].sort(byCountThenName((x) => x.calls, (x) => x.name)) }))
      .sort(byCountThenName((x) => x.calls, (x) => x.server)),
    skills: skills.values().sort(byCountThenName((x) => x.uses, (x) => x.name)),
    agents: agents.values().sort(byCountThenName((x) => x.runs, (x) => x.name)),
    hooks: hooks.values().sort(byCountThenName((x) => x.count, (x) => x.name)),
    instructions: instructions.values().sort(byCountThenName((x) => x.count, (x) => x.name)),
    causes: causeRows
      .values()
      .map(({ toolMap, ...c }) => ({ ...c, tools: [...toolMap.values()].sort(byCountThenName((x) => x.count, (x) => x.key)) }))
      .sort(byCountThenName((x) => x.count, (x) => x.cause)),
    causesUnrecorded,
  };
}

/**
 * インストール済みだが、絞り込んだセッションで一度も呼ばれなかった skill(大文字小文字を区別しない)。
 * core の unusedInstalledSkills と同じ定義。
 */
export function unusedSkills(installed: string[], used: Iterable<string>): string[] {
  const u = new Set([...used].map((n) => n.toLowerCase()));
  return installed.filter((n) => !u.has(n.toLowerCase()));
}
