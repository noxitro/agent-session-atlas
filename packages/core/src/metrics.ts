import {
  METRICS_SCHEMA_VERSION,
  type Distribution,
  type InstalledInventory,
  type MetricsBucket,
  type MetricsFile,
  type ModelBucket,
  type Quantiles,
  type SessionRecord,
  type TokenSource,
} from './types.ts';

const TOKEN_SOURCES: TokenSource[] = ['db', 'events', 'db+events', 'shutdown', 'partial', 'none'];

/** 空のセッション(依頼 0・ツール 0・応答 0)。古い sessions.json(empty を持たない)は空でないとみなす */
export function isEmptySession(s: Pick<SessionRecord, 'empty'>): boolean {
  return s.empty === true;
}

function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { total: 0, median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { total: s.reduce((a, b) => a + b, 0), median: q(0.5), p90: q(0.9) };
}

/** 中央値と p90(distribution と同じ定義: 昇順に並べた ceil(p·n) 番目) */
export function quantiles(values: number[]): Quantiles {
  const d = distribution(values);
  return { n: values.length, median: d.median, p90: d.p90 };
}

function addTo(map: Record<string, number>, from: Record<string, number> | undefined): void {
  for (const [k, v] of Object.entries(from ?? {})) inc(map, k, v);
}

export function bucketOf(sessions: SessionRecord[]): MetricsBucket {
  const b: MetricsBucket = {
    sessions: sessions.length,
    sessionsWithInputTokens: 0,
    turns: 0,
    autopilotContinuations: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, premiumRequests: 0, nanoAiu: 0, requests: 0 },
    tools: { total: 0, byName: {}, internal: 0, mcp: {}, results: {} },
    lines: { added: 0, removed: 0, sessionsWithRecord: 0, bySource: { shutdown: 0, tools: 0, none: 0 } },
    tokenSources: Object.fromEntries(TOKEN_SOURCES.map((k) => [k, 0])) as Record<TokenSource, number>,
    sessionsMissingTokens: 0,
    skills: { total: 0, byName: {}, sessionsWithAny: 0, byTrigger: { user: 0, agent: 0, unknown: 0 } },
    agents: { total: 0, failed: 0, byName: {}, byNameDetail: {}, sessionsWithAny: 0 },
    hooks: { total: 0, byType: {} },
    instructions: { sessionsWithAny: 0, byFile: {} },
    wiki: { sessionsWithAny: 0, indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0 },
    friction: {
      compactions: 0,
      aborts: 0,
      errors: 0,
      permissionRequests: 0,
      askUser: 0,
      modelChanges: 0,
      modeChanges: 0,
      toolFailures: 0,
      subagentFailures: 0,
    },
    durationMs: { total: 0, median: null, p90: null },
    activeMs: { total: 0, median: null, p90: null },
    exec: {
      modes: { byMode: {}, inferred: 0 },
      efforts: {},
      initiators: {},
      context: { sessions: 0, toolDefinitionsTokens: { total: 0, median: null, p90: null, mean: null }, availableToolCount: { sessions: 0, mean: null } },
    },
    frictionDetail: { permissions: {}, errorTypes: {}, subagentFailures: {}, compaction: { recorded: 0, input: 0, output: 0, nanoAiu: 0, tokensRemoved: 0 } },
    todos: { sessionsWithDb: 0, sessionsWithTodos: 0, total: 0, byStatus: {}, deps: 0, completionRate: null },
  };
  const durations: number[] = [];
  const actives: number[] = [];
  const toolDefs: number[] = [];
  const availTools: number[] = [];
  for (const s of sessions) {
    const t = s.tokens;
    if (t.input != null) b.sessionsWithInputTokens++;
    b.turns += s.turns;
    b.autopilotContinuations += s.autopilotContinuations ?? 0;
    b.tokenSources[t.source] = (b.tokenSources[t.source] ?? 0) + 1;
    if (t.source === 'none') b.sessionsMissingTokens++;
    b.tokens.input += t.input ?? 0;
    b.tokens.output += t.output;
    b.tokens.cacheRead += t.cacheRead ?? 0;
    b.tokens.cacheWrite += t.cacheWrite ?? 0;
    b.tokens.reasoning += t.reasoning ?? 0;
    b.tokens.premiumRequests += t.premiumRequests ?? 0;
    b.tokens.nanoAiu += t.nanoAiu ?? 0;
    b.tokens.requests += t.requests ?? 0;

    b.tools.total += s.tools.total;
    b.tools.internal += s.tools.internal?.total ?? 0;
    for (const [k, v] of Object.entries(s.tools.byName)) inc(b.tools.byName, k, v);
    for (const [server, byTool] of Object.entries(s.tools.mcp ?? {})) for (const v of Object.values(byTool)) inc(b.tools.mcp, server, v);
    for (const [k, r] of Object.entries(s.tools.results ?? {})) {
      const t = (b.tools.results[k] ??= { success: 0, failure: 0, denied: 0 });
      t.success += r.success;
      t.failure += r.failure;
      t.denied += r.denied;
    }
    const lines = s.lines ?? { added: 0, removed: 0, source: 'none' as const };
    b.lines.added += lines.added;
    b.lines.removed += lines.removed;
    b.lines.bySource[lines.source]++;
    if (lines.source !== 'none') b.lines.sessionsWithRecord++;

    if (s.skills.length > 0) b.skills.sessionsWithAny++;
    for (const sk of s.skills) {
      b.skills.total++;
      inc(b.skills.byName, sk.name);
      b.skills.byTrigger[sk.trigger ?? 'unknown']++;
    }
    if (s.agents.length > 0) b.agents.sessionsWithAny++;
    for (const a of s.agents) {
      b.agents.total++;
      if (a.status === 'failed') b.agents.failed++;
      inc(b.agents.byName, a.name);
      const d = (b.agents.byNameDetail[a.name] ??= { runs: 0, failed: 0, tokens: 0 });
      d.runs++;
      if (a.status === 'failed') d.failed++;
      d.tokens += a.totalTokens ?? 0;
    }
    b.hooks.total += s.hooks.total;
    for (const [k, v] of Object.entries(s.hooks.byType)) inc(b.hooks.byType, k, v);

    if (s.instructions.length > 0) b.instructions.sessionsWithAny++;
    const seenFiles = new Set<string>();
    for (const i of s.instructions) {
      const key = i.scope === 'user' ? `${i.file} (user)` : i.file;
      const e = (b.instructions.byFile[key] ??= { sessions: 0, chars: 0 });
      e.chars += i.chars;
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        e.sessions++;
      }
    }
    const w = s.wiki;
    if (w.indexReads + w.pageReads.length + w.skillCalls.length + w.writes + w.otherCalls > 0) b.wiki.sessionsWithAny++;
    b.wiki.indexReads += w.indexReads;
    b.wiki.pageReads += w.pageReads.length;
    b.wiki.skillCalls += w.skillCalls.length;
    b.wiki.writes += w.writes;

    for (const k of Object.keys(b.friction) as (keyof typeof b.friction)[]) b.friction[k] += s.friction[k];

    // Phase 7(古い sessions.json には無い)
    const ex = s.exec;
    if (ex) {
      addTo(b.exec.modes.byMode, ex.modes.byMode);
      b.exec.modes.inferred += ex.modes.inferred;
      for (const [k, e] of Object.entries(ex.efforts)) {
        const t = (b.exec.efforts[k] ??= { requests: 0, input: 0, output: 0, nanoAiu: 0 });
        t.requests += e.requests;
        t.input += e.input;
        t.output += e.output;
        t.nanoAiu += e.nanoAiu;
      }
      addTo(b.exec.initiators, ex.initiators);
      if (ex.context.toolDefinitionsTokens != null) toolDefs.push(ex.context.toolDefinitionsTokens);
      if (ex.context.availableToolCount != null) availTools.push(ex.context.availableToolCount);
    }
    const fd = s.frictionDetail;
    if (fd) {
      addTo(b.frictionDetail.permissions, fd.permissions);
      addTo(b.frictionDetail.errorTypes, fd.errorTypes);
      addTo(b.frictionDetail.subagentFailures, fd.subagentFailures);
      for (const k of Object.keys(b.frictionDetail.compaction) as (keyof typeof fd.compaction)[]) b.frictionDetail.compaction[k] += fd.compaction[k];
    }
    if (s.todos) {
      b.todos.sessionsWithDb++;
      if (s.todos.total > 0) b.todos.sessionsWithTodos++;
      b.todos.total += s.todos.total;
      b.todos.deps += s.todos.deps;
      addTo(b.todos.byStatus, s.todos.byStatus);
    }
    if (s.durationMs != null) durations.push(s.durationMs);
    if (s.activeMs != null) actives.push(s.activeMs);
  }
  // premium request は 0.33 倍などの和なので浮動小数の誤差を丸める(report の aggregate と同じ桁)
  b.tokens.premiumRequests = Math.round(b.tokens.premiumRequests * 1000) / 1000;
  b.durationMs = distribution(durations);
  b.activeMs = distribution(actives);
  const td = distribution(toolDefs);
  b.exec.context = {
    sessions: toolDefs.length,
    toolDefinitionsTokens: { ...td, mean: toolDefs.length ? Math.round(td.total / toolDefs.length) : null },
    availableToolCount: { sessions: availTools.length, mean: availTools.length ? Math.round((availTools.reduce((a, x) => a + x, 0) / availTools.length) * 10) / 10 : null },
  };
  b.todos.completionRate = b.todos.total > 0 ? (b.todos.byStatus.done ?? 0) / b.todos.total : null;
  return b;
}

/** モデル別の待ち時間(全リクエストを 1 本にまとめた中央値と p90) */
export function latencyByModel(sessions: SessionRecord[]): MetricsFile['latency'] {
  const g = new Map<string, { ttft: number[]; duration: number[] }>();
  for (const s of sessions) {
    for (const [m, l] of Object.entries(s.exec?.latency ?? {})) {
      let a = g.get(m);
      if (!a) g.set(m, (a = { ttft: [], duration: [] }));
      a.ttft.push(...l.ttft);
      a.duration.push(...l.duration);
    }
  }
  return Object.fromEntries([...g.keys()].sort().map((m) => [m, { ttft: quantiles(g.get(m)!.ttft), duration: quantiles(g.get(m)!.duration) }]));
}

/** ツール別の所要時間(中央値と p90)。1 時間超は外れ値として件数だけ */
export function toolDurationStats(sessions: SessionRecord[]): MetricsFile['toolDurations'] {
  const g = new Map<string, { values: number[]; outliers: number }>();
  const get = (k: string): { values: number[]; outliers: number } => {
    let a = g.get(k);
    if (!a) g.set(k, (a = { values: [], outliers: 0 }));
    return a;
  };
  for (const s of sessions) {
    for (const [k, v] of Object.entries(s.tools.durations ?? {})) get(k).values.push(...v);
    for (const [k, n] of Object.entries(s.tools.durationOutliers ?? {})) get(k).outliers += n;
  }
  return Object.fromEntries([...g.keys()].sort().map((k) => [k, { ...quantiles(g.get(k)!.values), outliers: g.get(k)!.outliers }]));
}

function groupBy(sessions: SessionRecord[], key: (s: SessionRecord) => string): Record<string, MetricsBucket> {
  const g = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const k = key(s);
    let a = g.get(k);
    if (!a) g.set(k, (a = []));
    a.push(s);
  }
  const out: Record<string, MetricsBucket> = {};
  for (const k of [...g.keys()].sort()) out[k] = bucketOf(g.get(k)!);
  return out;
}

export function monthKey(s: SessionRecord): string {
  const t = s.createdAt ?? s.updatedAt;
  if (!t) return '(unknown)';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '(unknown)' : d.toISOString().slice(0, 7);
}

function byModel(sessions: SessionRecord[]): Record<string, ModelBucket> {
  const out: Record<string, ModelBucket> = {};
  for (const s of sessions) {
    for (const [m, t] of Object.entries(s.tokens.byModel)) {
      const b = (out[m] ??= {
        sessions: 0,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        premiumRequests: 0,
        nanoAiu: 0,
      });
      b.sessions++;
      b.requests += t.requests ?? 0;
      b.input += t.input ?? 0;
      b.output += t.output;
      b.cacheRead += t.cacheRead ?? 0;
      b.cacheWrite += t.cacheWrite ?? 0;
      b.reasoning += t.reasoning ?? 0;
      b.premiumRequests += t.premiumRequests ?? 0;
      b.nanoAiu += t.nanoAiu ?? 0;
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** インストール済みの skill 名(~/.copilot/skills/ とプラグインの skills/)。重複を除いて辞書順 */
export function installedSkillNames(inv: InstalledInventory): string[] {
  return [...new Set([...inv.skills, ...inv.plugins.flatMap((p) => p.skills)])].sort();
}

/**
 * インストール済みだが sessions で一度も呼ばれなかった skill。
 * 名前の比較は大文字小文字を区別しない(ディレクトリ名と呼び出し時の名前の書き方の差を吸収する)。
 */
export function unusedInstalledSkills(inv: InstalledInventory, sessions: Pick<SessionRecord, 'skills'>[]): string[] {
  const used = new Set(sessions.flatMap((s) => s.skills.map((k) => k.name.toLowerCase())));
  return installedSkillNames(inv).filter((n) => !used.has(n.toLowerCase()));
}

/**
 * sessions → metrics.json(全体 / プロジェクト / クライアント / モデル / 月別)。
 * 空のセッション(依頼 0・ツール 0・応答 0)は集計から外し、件数だけ emptySessions に持つ。
 * installed(snapshot のインベントリ)があれば、期間内に未使用の skill も出す。
 */
export function computeMetrics(all: SessionRecord[], opts: { installed?: InstalledInventory | null } = {}): MetricsFile {
  const sessions = all.filter((s) => !isEmptySession(s));
  const inv = opts.installed ?? null;
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    emptySessions: all.length - sessions.length,
    overall: bucketOf(sessions),
    byProject: groupBy(sessions, (s) => s.project),
    byClient: groupBy(sessions, (s) => s.client ?? '(unknown)'),
    byMonth: groupBy(sessions, monthKey),
    byModel: byModel(sessions),
    installedSkills: inv
      ? { installed: installedSkillNames(inv), disabled: [...(inv.disabledSkills ?? [])].sort(), unused: unusedInstalledSkills(inv, sessions) }
      : null,
    latency: latencyByModel(sessions),
    toolDurations: toolDurationStats(sessions),
  };
}
