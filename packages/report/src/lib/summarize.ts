// SessionRecord → SessionSummary(HTML に埋め込む要約)。生イベント・timeline・長文は落とす。
import type { FailureCauses } from '../../../core/src/tool-failure.ts';
import type { SessionRecord } from '../../../core/src/types.ts';
import type { Anonymizer } from './anonymize.ts';
import { coverageOf } from './filter.ts';
import { truncate } from './format.ts';
import { turnTuples } from './turns.ts';
import type { AgentStat, EffortTuple, ExecSummary, FrictionDetailSummary, JudgmentSummary, ModelTokenSummary, SessionSummary, SkillTriggers, ToolIssue } from './types.ts';

/** permission.completed の result.kind を承認・拒否・その他にまとめる(approved-for-location などは承認) */
export function permissionGroup(kind: string): 0 | 1 | 2 {
  if (/^approved/i.test(kind)) return 0;
  if (/^denied|^rejected/i.test(kind)) return 1;
  return 2;
}

function execSummary(r: SessionRecord): ExecSummary {
  const e = r.exec;
  if (!e) return { modes: {}, modesInferred: 0, efforts: {}, modelEfforts: {}, initiators: {}, context: null, latency: {} };
  const efforts: Record<string, EffortTuple> = {};
  for (const [k, v] of Object.entries(e.efforts)) efforts[k] = [v.requests, v.input, v.output, v.nanoAiu];
  const modelEfforts: Record<string, Record<string, EffortTuple>> = {};
  for (const [m, byEffort] of Object.entries(e.modelEfforts ?? {})) {
    const to: Record<string, EffortTuple> = (modelEfforts[m] = {});
    for (const [k, v] of Object.entries(byEffort)) to[k] = [v.requests, v.input, v.output, v.nanoAiu];
  }
  const c = e.context;
  const anyCtx = c.systemTokens != null || c.conversationTokens != null || c.toolDefinitionsTokens != null || c.availableToolCount != null;
  const latency: ExecSummary['latency'] = {};
  for (const [m, l] of Object.entries(e.latency)) latency[m] = [l.ttft, l.duration];
  return {
    modes: e.modes.byMode,
    modesInferred: e.modes.inferred,
    efforts,
    modelEfforts,
    initiators: e.initiators,
    context: anyCtx ? [c.systemTokens, c.conversationTokens, c.toolDefinitionsTokens, c.availableToolCount] : null,
    latency,
  };
}

function frictionDetailSummary(r: SessionRecord): FrictionDetailSummary {
  const f = r.frictionDetail;
  if (!f) return { permissions: [0, 0, 0], errorTypes: {}, subagentFailures: {}, compaction: [0, 0, 0, 0, 0] };
  const permissions: FrictionDetailSummary['permissions'] = [0, 0, 0];
  for (const [k, n] of Object.entries(f.permissions)) permissions[permissionGroup(k)] += n;
  const c = f.compaction;
  return { permissions, errorTypes: f.errorTypes, subagentFailures: f.subagentFailures, compaction: [c.recorded, c.input, c.output, c.nanoAiu, c.tokensRemoved] };
}

/** 一覧に出す本文の長さ(文字) */
export const SUMMARY_TEXT_CHARS = 160;

/** 詳細ページのファイル名(セッション ID は通常 UUID。念のためファイル名に使えない文字を置き換える) */
export function detailFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.html`;
}

export function detailHref(id: string): string {
  return `sessions/${detailFileName(id)}`;
}

export function summarize(r: SessionRecord, anon: Anonymizer, judgment: JudgmentSummary | null): SessionSummary {
  const byModel: Record<string, ModelTokenSummary> = {};
  for (const [m, t] of Object.entries(r.tokens.byModel)) {
    byModel[m] = { input: t.input, output: t.output, cacheRead: t.cacheRead, premiumRequests: t.premiumRequests, requests: t.requests };
  }
  const skills: Record<string, SkillTriggers> = {};
  const skillChars: Record<string, number | null> = {};
  for (const s of r.skills) {
    const t = (skills[s.name] ??= [0, 0, 0]);
    t[s.trigger === 'user' ? 0 : s.trigger === 'agent' ? 1 : 2]++;
    if (s.chars != null) skillChars[s.name] = Math.max(skillChars[s.name] ?? 0, s.chars);
    else skillChars[s.name] ??= null;
  }
  const agentsByName: Record<string, AgentStat> = {};
  for (const a of r.agents) {
    const t = (agentsByName[a.name] ??= [0, 0, 0]);
    t[0]++;
    if (a.status === 'failed') t[1]++;
    t[2] += a.totalTokens ?? 0;
  }
  // metrics の instructions.byFile と同じキー(ユーザー単位は「(user)」付き)
  const instructions: Record<string, number> = {};
  for (const i of r.instructions) {
    const key = i.scope === 'user' ? `${i.file} (user)` : i.file;
    instructions[key] = (instructions[key] ?? 0) + i.chars;
  }
  const issues: Record<string, ToolIssue> = {};
  const causes: Record<string, FailureCauses> = {};
  for (const [tool, calls] of Object.entries(r.tools.byName)) {
    const res = r.tools.results?.[tool];
    const completed = res ? res.success + res.failure + res.denied : 0;
    if (!res || res.failure > 0 || res.denied > 0 || completed !== calls) issues[tool] = [res?.failure ?? 0, res?.denied ?? 0, completed];
    if (res?.causes && Object.keys(res.causes).length) causes[tool] = res.causes;
  }
  const name = anon.freeText(r.name);
  const first = anon.freeText(r.firstUserMessage);
  const t = r.tokens;
  return {
    id: r.id,
    client: r.client,
    project: anon.project(r.project),
    projectLabel: anon.projectLabel(r.project),
    projectSource: r.projectSource ?? 'path',
    branch: anon.branch(r.branch),
    person: anon.person(r.person ?? null),
    name: name ? truncate(name, SUMMARY_TEXT_CHARS) : null,
    firstUserMessage: first ? truncate(first, SUMMARY_TEXT_CHARS) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    durationMs: r.durationMs,
    activeMs: r.activeMs,
    turns: r.turns,
    autopilotContinuations: r.autopilotContinuations ?? 0,
    empty: r.empty === true,
    models: r.models,
    tokens: {
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      reasoning: t.reasoning,
      premiumRequests: t.premiumRequests,
      nanoAiu: t.nanoAiu,
      requests: t.requests,
      source: t.source,
    },
    coverage: coverageOf(t),
    byModel,
    tools: {
      total: r.tools.total,
      byName: r.tools.byName,
      internal: r.tools.internal?.total ?? 0,
      mcp: r.tools.mcp ?? {},
      issues,
      causes,
      durations: r.tools.durations ?? {},
      outliers: r.tools.durationOutliers ?? {},
    },
    exec: execSummary(r),
    frictionDetail: frictionDetailSummary(r),
    todos: r.todos ?? null,
    skills,
    agents: { total: r.agents.length, failed: r.agents.filter((a) => a.status === 'failed').length, byName: agentsByName },
    hooks: { total: r.hooks.total, byType: r.hooks.byType },
    instructions,
    lines: r.lines ?? { added: 0, removed: 0, source: 'none' },
    wiki: { indexReads: r.wiki.indexReads, pageReads: r.wiki.pageReads.length, skillCalls: r.wiki.skillCalls.length, writes: r.wiki.writes },
    friction: { ...r.friction },
    skillChars,
    instructionVersions: r.instructions.map((i) => [i.contentHash, i.chars, i.injections]),
    analysis: {
      filesReedited: r.analysis?.filesReedited ?? 0,
      extraEdits: r.analysis?.extraEdits ?? 0,
      maxConsecutiveFailures: r.analysis?.maxConsecutiveFailures ?? 0,
      turns: r.analysis?.turnTools.length ?? 0,
    },
    ...(r.analysis?.turnStats?.length ? { turnRows: turnTuples(r) } : {}),
    files: { changed: r.files.changed.length, created: r.files.created.length, deleted: r.files.deleted?.length ?? 0, sessionState: r.files.sessionState ?? 0 },
    href: detailHref(r.id),
    // 根拠の自由記述は HTML 本体に埋め込まない(詳細ページだけ)。伏せ字モードでは要約も出さない
    judgment: judgment ? { ...judgment, rationale: null, taskSummary: anon.enabled ? null : judgment.taskSummary } : null,
  };
}
