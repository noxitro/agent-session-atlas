// Phase 7: 絞り込んだ SessionSummary[] から「実行の性質」の集計を作る純関数。
// 中央値・p90 は core の distribution と同じ定義(昇順に並べた ceil(p·n) 番目)。
import type { SessionSummary } from './types.ts';

/** 推論強度の並び(弱い → 強い)。ここに無い値は後ろに名前順 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** モードの並び */
export const MODE_ORDER = ['interactive', 'plan', 'autopilot'];
/** リクエストの起点の並び */
export const INITIATOR_ORDER = ['user', 'agent', 'sub-agent', 'compaction'];
/** ツールの所要時間の表で上位に出す下限(回数)。少ない回数の遅い値が上位を占めないように */
export const DURATION_MIN_CALLS = 5;

export const UNKNOWN_KEY = '(unknown)';

/** 昇順に並べた配列の p 分位(core の distribution と同じ定義) */
export function quantileSorted(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export interface QuantileRow {
  n: number;
  median: number | null;
  p90: number | null;
}

export function quantilesOf(values: number[]): QuantileRow {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantileSorted(s, 0.5), p90: quantileSorted(s, 0.9) };
}

function orderBy(order: string[]): (a: string, b: string) => number {
  const rank = (k: string): number => {
    if (k === UNKNOWN_KEY) return order.length + 1;
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

export interface EffortRow {
  key: string;
  requests: number;
  input: number;
  output: number;
  nanoAiu: number;
}

export interface LatencyRow {
  model: string;
  ttft: QuantileRow;
  duration: QuantileRow;
}

export interface ToolDurationRow extends QuantileRow {
  tool: string;
  /** 1 時間を超えて外した回数 */
  outliers: number;
}

export interface ContextProjectRow {
  key: string;
  label: string;
  /** ツール定義の記録があるセッション数 */
  sessions: number;
  toolDefAvg: number;
  /** 文脈(system + 会話 + ツール定義)に占めるツール定義の割合の平均(3 つ揃ったセッションだけ) */
  shareAvg: number | null;
}

export interface ExecAggregate {
  modes: { rows: { key: string; turns: number }[]; inferred: number; total: number };
  efforts: EffortRow[];
  initiators: { rows: { key: string; requests: number }[]; total: number };
  context: {
    /** ツール定義のトークンが分かるセッション数 */
    sessions: number;
    toolDefAvg: number | null;
    toolDefMedian: number | null;
    shareAvg: number | null;
    shareSessions: number;
    availableToolsAvg: number | null;
    availableToolsSessions: number;
    byProject: ContextProjectRow[];
  };
  latency: LatencyRow[];
  toolDurations: { rows: ToolDurationRow[]; measured: number; outliers: number };
  friction: {
    permissions: { approved: number; denied: number; other: number };
    errorTypes: { name: string; count: number }[];
    subagentFailures: { name: string; count: number }[];
    compaction: { compactions: number; recorded: number; input: number; output: number; nanoAiu: number; tokensRemoved: number };
  };
  todos: { sessionsWithDb: number; sessionsWithTodos: number; total: number; byStatus: Record<string, number>; deps: number; completionRate: number | null };
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

function addInto(map: Map<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) map.set(k, (map.get(k) ?? 0) + v);
}

const byCount = (m: Map<string, number>): { name: string; count: number }[] =>
  [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

/** 文脈に占めるツール定義の割合(3 つ揃っていて合計が正のときだけ) */
export function toolShare(c: SessionSummary['exec']['context']): number | null {
  if (!c) return null;
  const [sys, conv, tool] = c;
  if (sys == null || conv == null || tool == null) return null;
  const sum = sys + conv + tool;
  return sum > 0 ? tool / sum : null;
}

export function execAggregate(sessions: SessionSummary[]): ExecAggregate {
  const modes = new Map<string, number>();
  let inferred = 0;
  const efforts = new Map<string, EffortRow>();
  const initiators = new Map<string, number>();
  const toolDefs: number[] = [];
  const shares: number[] = [];
  const avail: number[] = [];
  const byProject = new Map<string, { label: string; defs: number[]; shares: number[] }>();
  const latency = new Map<string, { ttft: number[]; duration: number[] }>();
  const durations = new Map<string, number[]>();
  const outliers = new Map<string, number>();
  const permissions = { approved: 0, denied: 0, other: 0 };
  const errorTypes = new Map<string, number>();
  const subFailures = new Map<string, number>();
  const compaction = { compactions: 0, recorded: 0, input: 0, output: 0, nanoAiu: 0, tokensRemoved: 0 };
  const todos = { sessionsWithDb: 0, sessionsWithTodos: 0, total: 0, byStatus: {} as Record<string, number>, deps: 0, completionRate: null as number | null };

  for (const s of sessions) {
    const e = s.exec;
    addInto(modes, e.modes);
    inferred += e.modesInferred;
    for (const [k, [requests, input, output, nanoAiu]] of Object.entries(e.efforts)) {
      let r = efforts.get(k);
      if (!r) efforts.set(k, (r = { key: k, requests: 0, input: 0, output: 0, nanoAiu: 0 }));
      r.requests += requests;
      r.input += input;
      r.output += output;
      r.nanoAiu += nanoAiu;
    }
    addInto(initiators, e.initiators);
    const def = e.context?.[2] ?? null;
    if (def != null) {
      toolDefs.push(def);
      const share = toolShare(e.context);
      if (share != null) shares.push(share);
      let p = byProject.get(s.project);
      if (!p) byProject.set(s.project, (p = { label: s.projectLabel, defs: [], shares: [] }));
      p.defs.push(def);
      if (share != null) p.shares.push(share);
    }
    if (e.context?.[3] != null) avail.push(e.context[3]);
    for (const [m, [ttft, duration]] of Object.entries(e.latency)) {
      let l = latency.get(m);
      if (!l) latency.set(m, (l = { ttft: [], duration: [] }));
      l.ttft.push(...ttft);
      l.duration.push(...duration);
    }
    for (const [t, v] of Object.entries(s.tools.durations)) {
      const a = durations.get(t);
      if (a) a.push(...v);
      else durations.set(t, [...v]);
    }
    addInto(outliers, s.tools.outliers);

    const f = s.frictionDetail;
    permissions.approved += f.permissions[0];
    permissions.denied += f.permissions[1];
    permissions.other += f.permissions[2];
    addInto(errorTypes, f.errorTypes);
    addInto(subFailures, f.subagentFailures);
    compaction.compactions += s.friction.compactions;
    compaction.recorded += f.compaction[0];
    compaction.input += f.compaction[1];
    compaction.output += f.compaction[2];
    compaction.nanoAiu += f.compaction[3];
    compaction.tokensRemoved += f.compaction[4];

    if (s.todos) {
      todos.sessionsWithDb++;
      if (s.todos.total > 0) todos.sessionsWithTodos++;
      todos.total += s.todos.total;
      todos.deps += s.todos.deps;
      for (const [k, n] of Object.entries(s.todos.byStatus)) todos.byStatus[k] = (todos.byStatus[k] ?? 0) + n;
    }
  }
  todos.completionRate = todos.total > 0 ? (todos.byStatus.done ?? 0) / todos.total : null;

  const modeRows = [...modes].map(([key, turns]) => ({ key, turns })).sort((a, b) => orderBy(MODE_ORDER)(a.key, b.key));
  const initRows = [...initiators].map(([key, requests]) => ({ key, requests })).sort((a, b) => orderBy(INITIATOR_ORDER)(a.key, b.key));
  const latencyRows = [...latency]
    .map(([model, l]) => ({ model, ttft: quantilesOf(l.ttft), duration: quantilesOf(l.duration) }))
    .sort((a, b) => Math.max(b.ttft.n, b.duration.n) - Math.max(a.ttft.n, a.duration.n) || a.model.localeCompare(b.model));
  const tools = new Set([...durations.keys(), ...outliers.keys()]);
  const durationRows = [...tools]
    .map((tool) => ({ tool, ...quantilesOf(durations.get(tool) ?? []), outliers: outliers.get(tool) ?? 0 }))
    .sort((a, b) => (b.p90 ?? -1) - (a.p90 ?? -1) || b.n - a.n || a.tool.localeCompare(b.tool));
  const sortedDefs = [...toolDefs].sort((a, b) => a - b);
  const r1 = (x: number | null): number | null => (x == null ? null : Math.round(x * 10) / 10);

  return {
    modes: { rows: modeRows, inferred, total: modeRows.reduce((a, r) => a + r.turns, 0) },
    efforts: [...efforts.values()].sort((a, b) => orderBy(EFFORT_ORDER)(a.key, b.key)),
    initiators: { rows: initRows, total: initRows.reduce((a, r) => a + r.requests, 0) },
    context: {
      sessions: toolDefs.length,
      toolDefAvg: toolDefs.length ? Math.round(avg(toolDefs)!) : null,
      toolDefMedian: quantileSorted(sortedDefs, 0.5),
      shareAvg: avg(shares),
      shareSessions: shares.length,
      availableToolsAvg: r1(avg(avail)),
      availableToolsSessions: avail.length,
      byProject: [...byProject]
        .map(([key, p]) => ({ key, label: p.label, sessions: p.defs.length, toolDefAvg: Math.round(avg(p.defs)!), shareAvg: avg(p.shares) }))
        .sort((a, b) => b.toolDefAvg - a.toolDefAvg || b.sessions - a.sessions || a.key.localeCompare(b.key)),
    },
    latency: latencyRows,
    toolDurations: {
      rows: durationRows,
      measured: [...durations.values()].reduce((a, v) => a + v.length, 0),
      outliers: [...outliers.values()].reduce((a, n) => a + n, 0),
    },
    friction: { permissions, errorTypes: byCount(errorTypes), subagentFailures: byCount(subFailures), compaction },
    todos,
  };
}
