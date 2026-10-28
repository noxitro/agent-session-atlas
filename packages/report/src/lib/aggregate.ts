// 絞り込んだ SessionSummary[] から画面の集計を作る純関数。
// core の computeMetrics と同じ定義(合計は記録のあるセッションだけの和、月は UTC の YYYY-MM)。
import { execAggregate, type ExecAggregate } from './exec.ts';
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
  /** judgments の推定人手工数(判定済みセッションだけの和) */
  judgedSessions: number;
  humanHours: number;
  /** 推定の幅(判定済みセッションの low / high の和) */
  humanLow: number;
  humanHigh: number;
  /** 判定済みセッションの確信度の平均(判定が無ければ null) */
  judgedConfidence: number | null;
  /** 判定済みセッションに AI が使った量(AI 投入量 vs 推定人手工数の比較用) */
  judgedAi: { activeMs: number; activeKnown: number; output: number; input: number; inputKnown: number; premiumRequests: number };
}

export interface ModelRow {
  model: string;
  sessions: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  premiumRequests: number;
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
}

export interface McpRow {
  server: string;
  calls: number;
  completed: number;
  failure: number;
  denied: number;
  sessions: number;
  /** ツール名(byName のキー)と回数。多い順 */
  tools: { name: string; calls: number }[];
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
}

export interface Aggregate {
  overall: Bucket;
  coverage: CoverageBreakdown;
  byProject: Bucket[];
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
    judgedSessions: 0,
    humanHours: 0,
    humanLow: 0,
    humanHigh: 0,
    judgedConfidence: null,
    judgedAi: { activeMs: 0, activeKnown: 0, output: 0, input: 0, inputKnown: 0, premiumRequests: 0 },
  };
  let confSum = 0;
  let confN = 0;
  const actives: number[] = [];
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
    const j = s.judgment;
    if (j?.hours != null) {
      b.judgedSessions++;
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

export function aggregate(sessions: SessionSummary[]): Aggregate {
  const labels = new Map(sessions.map((s) => [s.project, s.projectLabel]));
  const byProject = [...groupBy(sessions, (s) => s.project)].map(([k, v]) => bucket(k, labels.get(k) ?? k, v));
  byProject.sort((a, b) => b.tokens.output - a.tokens.output || b.sessions - a.sessions || a.key.localeCompare(b.key));

  const months = groupBy(sessions, monthOf);
  const known = [...months.keys()].filter((k) => k !== '(unknown)').sort();
  const monthKeys = known.length ? monthRange(known[0], known[known.length - 1]) : [];
  const byMonth = monthKeys.map((k) => bucket(k, k, months.get(k) ?? []));
  if (months.has('(unknown)')) byMonth.push(bucket('(unknown)', '日時不明', months.get('(unknown)')!));

  const models = new Map<string, ModelRow>();
  for (const s of sessions) {
    for (const [m, t] of Object.entries(s.byModel)) {
      let r = models.get(m);
      if (!r) models.set(m, (r = { model: m, sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, premiumRequests: 0 }));
      r.sessions++;
      r.requests += t.requests ?? 0;
      r.input += t.input ?? 0;
      r.output += t.output;
      r.cacheRead += t.cacheRead ?? 0;
      r.premiumRequests += t.premiumRequests ?? 0;
    }
  }
  const byModel = [...models.values()].map((r) => ({ ...r, premiumRequests: Math.round(r.premiumRequests * 1000) / 1000 }));
  byModel.sort((a, b) => b.output - a.output || b.sessions - a.sessions || a.model.localeCompare(b.model));

  return {
    overall: bucket('all', '全体', sessions),
    coverage: coverageBreakdown(sessions),
    byProject,
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
  const tools = new Tally<ToolRow>((key) => ({ key, label: key, mcpServer: null, calls: 0, completed: 0, success: 0, failure: 0, denied: 0, sessions: 0 }));
  const mcp = new Tally<McpRow & { toolMap: Map<string, number> }>((server) => ({ server, calls: 0, completed: 0, failure: 0, denied: 0, sessions: 0, tools: [], toolMap: new Map() }));
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
      const r = tools.get(server ? `mcp:${server}` : tool, i);
      r.label = server ?? tool;
      r.mcpServer = server;
      r.calls += calls;
      r.completed += completed;
      r.failure += failure;
      r.denied += denied;
      r.success += completed - failure - denied;
      if (server) {
        const m = mcp.get(server, i);
        m.calls += calls;
        m.completed += completed;
        m.failure += failure;
        m.denied += denied;
        m.toolMap.set(tool, (m.toolMap.get(tool) ?? 0) + calls);
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
      .map(({ toolMap, ...m }) => ({ ...m, tools: [...toolMap].map(([name, calls]) => ({ name, calls })).sort(byCountThenName((x) => x.calls, (x) => x.name)) }))
      .sort(byCountThenName((x) => x.calls, (x) => x.server)),
    skills: skills.values().sort(byCountThenName((x) => x.uses, (x) => x.name)),
    agents: agents.values().sort(byCountThenName((x) => x.runs, (x) => x.name)),
    hooks: hooks.values().sort(byCountThenName((x) => x.count, (x) => x.name)),
    instructions: instructions.values().sort(byCountThenName((x) => x.count, (x) => x.name)),
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
