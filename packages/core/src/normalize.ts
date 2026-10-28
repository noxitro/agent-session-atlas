import { FileTracker, isAutopilotContinuation, isInternalTool, isMainAssistantMessage, isUserTurn, normalizeModel, type FileOp } from './classify.ts';
import { KNOWN_EVENT_TYPES } from './event-types.ts';
import { InstructionCollector } from './instructions.ts';
import { classifyWikiToolCall, emptyWiki, isWikiSkill, WIKI_MARKER } from './wiki.ts';
import type {
  AgentRun,
  CopilotEvent,
  DbFileRow,
  DbSessionRow,
  DbTurnRow,
  DbUsageRow,
  EffortStat,
  ExecProfile,
  Friction,
  ParseStats,
  SessionRecord,
  SessionSource,
  SessionTokens,
  ShutdownTotals,
  SkillTrigger,
  SkillUse,
  TimelineEntry,
  TokenCounts,
  TokenSource,
  ToolResult,
  WorkspaceInfo,
} from './types.ts';

export interface NormalizeInput {
  id: string;
  /** session-state/<id>/ が存在したか */
  hasDir?: boolean;
  workspace?: WorkspaceInfo | null;
  db?: {
    session?: DbSessionRow | null;
    turns?: DbTurnRow[];
    usage?: DbUsageRow[];
    files?: DbFileRow[];
  };
  events?: AsyncIterable<CopilotEvent> | Iterable<CopilotEvent> | null;
  /** parseEvents に渡した stats(badLines を記録に載せる) */
  eventStats?: ParseStats;
}

const TEXT_LIMIT = 2000;
const TIMELINE_LIMIT = 400;
const IDLE_GAP_MS = 5 * 60 * 1000;
const DEDUPE_WINDOW_MS = 5000;
const SKILL_PAIR_WINDOW_MS = 120_000;

/** SQLite の datetime('now') 形式(UTC、タイムゾーン無し)を ISO に揃える */
export function normalizeTime(t: string | null | undefined): string | null {
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(t)) return t.replace(' ', 'T') + 'Z';
  return t;
}

function ms(t: string | null | undefined): number | null {
  if (!t) return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}

/** skill.invoked の trigger(user-invoked / agent-invoked)。それ以外・無しは null */
export function skillTrigger(t: unknown): SkillTrigger | null {
  if (t === 'user-invoked') return 'user';
  if (t === 'agent-invoked') return 'agent';
  return null;
}

/** ツールの toolTelemetry.metrics の行数(数値でなければ 0) */
function lineMetric(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function projectKey(repository: string | null, gitRoot: string | null, cwd: string | null): string {
  if (repository) return repository;
  const p = gitRoot ?? cwd;
  if (!p) return '(unknown)';
  const n = p.replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-z]:/i.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, premiumRequests: 0, nanoAiu: 0, requests: 0 };
}

function emptyFriction(): Friction {
  return {
    compactions: 0,
    aborts: 0,
    errors: 0,
    permissionRequests: 0,
    askUser: 0,
    modelChanges: 0,
    modeChanges: 0,
    toolFailures: 0,
    subagentFailures: 0,
  };
}

function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function head(s: string, n = TEXT_LIMIT): string {
  return s.length > n ? s.slice(0, n) : s;
}
function tail(s: string, n = TEXT_LIMIT): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

/** usage を一本化した 1 リクエスト */
interface UsageItem {
  origin: 'db' | 'events';
  model: string;
  at: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  nanoAiu: number | null;
  /** ユーザー起点なら倍率(=premium request)、それ以外 0、不明なら null */
  premium: number | null;
  agentId: string | null;
  /** 推論強度(DB の reasoning_effort / usage_record の reasoningEffort)。記録が無ければ null */
  effort: string | null;
  /** リクエストの起点(user / agent / sub-agent / compaction)。記録が無ければ null */
  initiator: string | null;
  /** 最初のトークンまでの時間(ミリ秒) */
  ttft: number | null;
  /** リクエスト全体の時間(ミリ秒) */
  duration: number | null;
}

/** 推論強度の表記をそろえる(小文字、空は null) */
export function normalizeEffort(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === '' ? null : s;
}

/** 0 以上の有限な数(ミリ秒)。それ以外は null */
function msValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function fromDbRow(r: DbUsageRow): UsageItem {
  return {
    origin: 'db',
    model: normalizeModel(r.model),
    at: ms(normalizeTime(r.created_at)),
    input: r.input_tokens ?? 0,
    output: r.output_tokens ?? 0,
    cacheRead: r.cache_read_tokens ?? 0,
    cacheWrite: r.cache_write_tokens ?? 0,
    reasoning: r.reasoning_tokens ?? 0,
    nanoAiu: r.total_nano_aiu ?? null,
    premium: r.initiator == null ? null : r.initiator === 'user' ? (r.request_multiplier ?? 1) : 0,
    agentId: r.agent_id ?? null,
    effort: normalizeEffort(r.reasoning_effort),
    initiator: typeof r.initiator === 'string' && r.initiator !== '' ? r.initiator : null,
    ttft: msValue(r.time_to_first_token_ms),
    duration: msValue(r.duration_ms),
  };
}

function fromUsageRecord(e: CopilotEvent): UsageItem | null {
  const u = e.data?.usage;
  if (!u || typeof u.model !== 'string') return null;
  return {
    origin: 'events',
    model: normalizeModel(u.model),
    at: ms(e.timestamp),
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
    nanoAiu: u.copilotUsage?.totalNanoAiu ?? null,
    premium: u.initiator == null ? null : u.initiator === 'user' ? (u.cost ?? 0) : 0,
    agentId: e.agentId ?? null,
    effort: normalizeEffort(u.reasoningEffort),
    initiator: typeof u.initiator === 'string' && u.initiator !== '' ? u.initiator : null,
    ttft: msValue(u.timeToFirstTokenMs),
    duration: msValue(u.duration),
  };
}

/**
 * subagent.failed の error を分類する(本文は詳細ページにだけ短く出す)。
 * quota: 402・月間上限 / rate_limit: 429・時間あたりの上限 / aborted: 中断 / no_response: 応答なし / other / unknown: 理由なし
 */
export function subagentFailureReason(err: unknown): string {
  const s = typeof err === 'string' ? err : err == null ? '' : typeof err === 'object' ? String((err as { message?: unknown }).message ?? JSON.stringify(err)) : String(err);
  if (s.trim() === '') return 'unknown';
  if (/\b402\b|quota/i.test(s)) return 'quota';
  if (/\b429\b|rate.?limit|session limit|exceeded your .*limit/i.test(s)) return 'rate_limit';
  if (/abort/i.test(s)) return 'aborted';
  if (/no response/i.test(s)) return 'no_response';
  return 'other';
}

/** 1 時間を超えるツールの所要時間は外れ値として除く(実データで 23 時間超の待ちがあった) */
export const TOOL_DURATION_OUTLIER_MS = 3_600_000;

/**
 * assistant_usage_events を優先し、usage_record は DB に無いものだけ足す。
 * 同一リクエストの判定: model・input・output が一致し、時刻差が 5 秒以内。
 */
export function mergeUsage(dbRows: DbUsageRow[], records: CopilotEvent[]): { items: UsageItem[]; duplicates: number } {
  const items = dbRows.map(fromDbRow);
  const used = new Set<number>();
  let duplicates = 0;
  for (const rec of records) {
    const u = fromUsageRecord(rec);
    if (!u) continue;
    let best = -1;
    let bestDt = Infinity;
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      if (d.origin !== 'db' || used.has(i)) continue;
      if (d.model !== u.model || d.output !== u.output || d.input !== u.input) continue;
      const dt = d.at != null && u.at != null ? Math.abs(d.at - u.at) : 0;
      if (dt <= DEDUPE_WINDOW_MS && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    }
    if (best >= 0) {
      used.add(best);
      duplicates++;
      // DB の行に無い項目(推論強度・起点・待ち時間)は同じリクエストの usage_record で補う
      const d = items[best];
      d.effort ??= u.effort;
      d.initiator ??= u.initiator;
      d.ttft ??= u.ttft;
      d.duration ??= u.duration;
    } else items.push(u);
  }
  return { items, duplicates };
}

function addItem(t: TokenCounts, u: UsageItem): void {
  t.input = (t.input ?? 0) + u.input;
  t.output += u.output;
  t.cacheRead = (t.cacheRead ?? 0) + u.cacheRead;
  t.cacheWrite = (t.cacheWrite ?? 0) + u.cacheWrite;
  t.reasoning = (t.reasoning ?? 0) + u.reasoning;
  if (u.nanoAiu != null) t.nanoAiu = (t.nanoAiu ?? 0) + u.nanoAiu;
  if (u.premium != null) t.premiumRequests = (t.premiumRequests ?? 0) + u.premium;
  t.requests = (t.requests ?? 0) + 1;
}

function shutdownTotals(e: CopilotEvent | null): ShutdownTotals | null {
  if (!e) return null;
  const mm = e.data?.modelMetrics;
  if (!mm || typeof mm !== 'object') return null;
  const t: ShutdownTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    premiumRequests: e.data.totalPremiumRequests ?? e.data.accountingSnapshot?.totalPremiumRequestCost ?? null,
    nanoAiu: e.data.totalNanoAiu ?? e.data.accountingSnapshot?.totalNanoAiu ?? null,
  };
  for (const v of Object.values<any>(mm)) {
    const u = v?.usage ?? {};
    t.input += u.inputTokens ?? 0;
    t.output += u.outputTokens ?? 0;
    t.cacheRead += u.cacheReadTokens ?? 0;
    t.cacheWrite += u.cacheWriteTokens ?? 0;
    t.reasoning += u.reasoningTokens ?? 0;
  }
  return t;
}

/** apply_patch の本文から対象ファイルと操作を拾う */
function patchFiles(patch: string): { op: FileOp; path: string }[] {
  const out: { op: FileOp; path: string }[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ op: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'edit', path: m[2].trim() });
  }
  return out;
}

function argsOf(e: CopilotEvent): any {
  const a = e.data?.arguments;
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  }
  return a;
}

async function* iterate<T>(src: AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
  for await (const x of src as AsyncIterable<T>) yield x;
}

/** PLAN.md「正規化セッションレコード」を 1 件作る。events はストリームで消費する */
export async function normalizeSession(input: NormalizeInput): Promise<SessionRecord> {
  const ws = input.workspace ?? null;
  const dbs = input.db?.session ?? null;
  const dbTurns = input.db?.turns ?? [];
  const dbUsage = input.db?.usage ?? [];
  const dbFiles = input.db?.files ?? [];

  const sources: SessionSource[] = [];
  if (dbs) sources.push('db');
  if (input.hasDir ?? (ws != null || input.events != null)) sources.push('dir');

  const byType: Record<string, number> = {};
  const unknown: Record<string, number> = {};
  let total = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let activeMs = 0;

  let copilotVersion: string | null = null;
  let schemaVersion: number | null = null;
  let ctx: { cwd?: string; gitRoot?: string; branch?: string; repository?: string } = {};

  let turns = 0;
  let autopilotContinuations = 0;
  let assistantMessages = 0;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  const models = new Set<string>();
  const legacyOutputByModel: Record<string, number> = {};
  let legacyOutput = 0;
  const usageRecords: CopilotEvent[] = [];
  let lastShutdown: CopilotEvent | null = null;
  /** codeChanges を持つ最後の session.shutdown の codeChanges(累計) */
  let lastCodeChanges: any = null;
  let subagentTotalTokens = 0;
  let maxPreCompaction: number | null = null;

  const tools: Record<string, number> = {};
  let toolsTotal = 0;
  const internalTools: Record<string, number> = {};
  let internalTotal = 0;
  /** 内部ツールの toolCallId(complete 側に toolName が無いので、失敗の計上から外すために覚える) */
  const internalCalls = new Set<string>();
  /** 作業としてのツールの toolCallId → ツール名(complete 側の結果をツール別に数えるため) */
  const toolNameByCall = new Map<string, string>();
  const mcp: Record<string, Record<string, number>> = {};
  const results: Record<string, ToolResult> = {};
  let toolLinesAdded = 0;
  let toolLinesRemoved = 0;
  let toolLinesSeen = false;
  /** 作業としてのツールの toolCallId → 開始時刻(所要時間用) */
  const toolStartMs = new Map<string, number>();
  const toolDurations: Record<string, number[]> = {};
  const toolDurationOutliers: Record<string, number> = {};
  // ---- Phase 7: モード・推論強度・文脈・摩擦の詳細 ----
  const modeCounts: Record<string, number> = {};
  let currentMode: string | null = null;
  let firstPreviousMode: string | null = null;
  /** モードの手掛かりがまだ無い時点のターン(最初の mode_changed の previousMode、無ければ既定の interactive にする) */
  let modePending = 0;
  /** 推論強度の設定の変化(session.start / session.model_change) */
  const effortChanges: { at: number | null; effort: string; from: 'start' | 'change' }[] = [];
  let lastCtx: { systemTokens: number | null; conversationTokens: number | null; toolDefinitionsTokens: number | null; source: 'shutdown' | 'compaction' } | null = null;
  let lastToolTokenCount: number | null = null;
  let lastAvailableToolCount: number | null = null;
  const permissions: Record<string, number> = {};
  const errorTypes: Record<string, number> = {};
  const subagentFailures: Record<string, number> = {};
  const compaction = { recorded: 0, input: 0, output: 0, nanoAiu: 0, tokensRemoved: 0 };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ctxOf = (x: any, source: 'shutdown' | 'compaction'): typeof lastCtx => {
    const s = num(x?.systemTokens);
    const c = num(x?.conversationTokens);
    const t = num(x?.toolDefinitionsTokens);
    return s == null && c == null && t == null ? null : { systemTokens: s, conversationTokens: c, toolDefinitionsTokens: t, source };
  };
  const skills: SkillUse[] = [];
  const agents = new Map<string, AgentRun>();
  const agentNameById = new Map<string, string>();
  const hooks: Record<string, number> = {};
  let hooksTotal = 0;
  const instr = new InstructionCollector();
  const wiki = emptyWiki();
  const friction = emptyFriction();
  const files = new FileTracker();
  let shutdownFiles: string[] = [];
  /** その時点の cwd(相対パスの解決に使う) */
  const curCwd = (): string | null => ctx.cwd ?? ws?.cwd ?? dbs?.cwd ?? null;
  const timeline: TimelineEntry[] = [];

  const pushTimeline = (e: TimelineEntry): void => {
    if (timeline.length < TIMELINE_LIMIT) timeline.push(e);
  };

  const agentFor = (e: CopilotEvent): AgentRun => {
    const id: string | null = e.data?.toolCallId ?? e.agentId ?? null;
    const key = id ?? `anon-${agents.size}`;
    let a = agents.get(key);
    if (!a) {
      a = {
        name: e.data?.agentName ?? '(unknown)',
        id,
        startedAt: null,
        completedAt: null,
        status: 'running',
        totalTokens: null,
        totalToolCalls: null,
        model: typeof e.data?.model === 'string' ? normalizeModel(e.data.model) : null,
        error: null,
      };
      agents.set(key, a);
    }
    if (id && e.data?.agentName) agentNameById.set(id, e.data.agentName);
    if (e.agentId && e.data?.agentName) agentNameById.set(e.agentId, e.data.agentName);
    return a;
  };

  if (input.events) {
    for await (const e of iterate(input.events)) {
      total++;
      inc(byType, e.type);
      if (!KNOWN_EVENT_TYPES.has(e.type)) inc(unknown, e.type);
      const t = ms(e.timestamp);
      const at = e.timestamp ?? null;
      if (t != null) {
        if (lastTs != null && t > lastTs) {
          const gap = t - lastTs;
          if (gap <= IDLE_GAP_MS) activeMs += gap;
        }
        if (firstTs == null || t < firstTs) firstTs = t;
        if (lastTs == null || t > lastTs) lastTs = t;
      }
      const d = e.data ?? {};

      switch (e.type) {
        case 'session.start':
          copilotVersion ??= d.copilotVersion ?? null;
          schemaVersion ??= typeof d.version === 'number' ? d.version : null;
          if (d.context) ctx = { ...d.context, ...pickDefined(ctx) };
          if (d.selectedModel) models.add(normalizeModel(d.selectedModel));
          {
            const eff = normalizeEffort(d.reasoningEffort);
            if (eff) effortChanges.push({ at: t, effort: eff, from: 'start' });
          }
          break;
        case 'session.resume':
        case 'session.context_changed': {
          const c = e.type === 'session.resume' ? d.context : d;
          if (c) ctx = { ...ctx, ...pickDefined({ cwd: c.cwd, gitRoot: c.gitRoot, branch: c.branch, repository: c.repository }) };
          break;
        }
        case 'user.message':
          if (isAutopilotContinuation(d)) autopilotContinuations++;
          else if (isUserTurn(d)) {
            turns++;
            if (typeof d.agentMode === 'string' && d.agentMode !== '') inc(modeCounts, d.agentMode);
            else if (currentMode) inc(modeCounts, currentMode);
            else modePending++;
            if (firstUserMessage == null && typeof d.content === 'string') firstUserMessage = head(d.content);
            pushTimeline({ at: at ?? '', kind: 'user', label: head(String(d.content ?? ''), 120) });
          }
          break;
        case 'assistant.message':
          if (d.model) models.add(normalizeModel(d.model));
          if (typeof d.outputTokens === 'number') {
            legacyOutput += d.outputTokens;
            inc(legacyOutputByModel, d.model ? normalizeModel(d.model) : '(unknown)', d.outputTokens);
          }
          if (isMainAssistantMessage(e)) {
            assistantMessages++;
            if (typeof d.content === 'string' && d.content.trim() !== '') lastAssistantMessage = tail(d.content);
          }
          break;
        case 'session.usage_record':
          usageRecords.push(e);
          if (d.usage?.model) models.add(normalizeModel(d.usage.model));
          if (num(d.usage?.toolTokenCount) != null) lastToolTokenCount = d.usage.toolTokenCount;
          if (num(d.usage?.availableToolCount) != null) lastAvailableToolCount = d.usage.availableToolCount;
          break;
        case 'session.shutdown':
          lastShutdown = e;
          lastCtx = ctxOf(d, 'shutdown') ?? lastCtx;
          if (d.codeChanges && typeof d.codeChanges === 'object') lastCodeChanges = d.codeChanges;
          if (Array.isArray(d.codeChanges?.filesModified)) shutdownFiles = d.codeChanges.filesModified;
          break;
        case 'tool.execution_start': {
          const name: string = d.toolName ?? '(unknown)';
          if (isInternalTool(name)) {
            inc(internalTools, name);
            internalTotal++;
            if (typeof d.toolCallId === 'string') internalCalls.add(d.toolCallId);
            break;
          }
          inc(tools, name);
          toolsTotal++;
          if (typeof d.toolCallId === 'string') {
            toolNameByCall.set(d.toolCallId, name);
            if (t != null) toolStartMs.set(d.toolCallId, t);
          }
          if (typeof d.mcpServerName === 'string' && d.mcpServerName !== '') inc((mcp[d.mcpServerName] ??= {}), name);
          const args = argsOf(e);
          if (name === 'skill') {
            const skill = typeof args?.skill === 'string' ? args.skill : '(unknown)';
            // skill ツールはモデルが呼ぶもの。skill.invoked と対になれば、その trigger で上書きする
            skills.push({ name: skill, at, via: 'tool', trigger: 'agent' });
            pushTimeline({ at: at ?? '', kind: 'skill', label: skill });
          } else {
            const last = timeline[timeline.length - 1];
            if (last && last.kind === 'tools' && last.tools) {
              last.count = (last.count ?? 0) + 1;
              inc(last.tools, name);
            } else pushTimeline({ at: at ?? '', kind: 'tools', label: 'tools', count: 1, tools: { [name]: 1 } });
          }
          if (name === 'ask_user') friction.askUser++;
          classifyWikiToolCall(wiki, name, args);
          if (name === 'create' && typeof args?.path === 'string') files.add('create', args.path, curCwd());
          if ((name === 'edit' || name === 'str_replace_editor') && typeof args?.path === 'string') files.add('edit', args.path, curCwd());
          if (name === 'apply_patch') {
            const p = typeof args === 'string' ? args : typeof args?.input === 'string' ? args.input : typeof args?.patch === 'string' ? args.patch : '';
            for (const f of patchFiles(p)) files.add(f.op, f.path, curCwd());
          }
          break;
        }
        case 'tool.execution_complete': {
          if (d.success === false && !(typeof d.toolCallId === 'string' && internalCalls.has(d.toolCallId))) friction.toolFailures++;
          const callName = typeof d.toolCallId === 'string' ? toolNameByCall.get(d.toolCallId) : undefined;
          if (callName != null && typeof d.success === 'boolean') {
            const r = (results[callName] ??= { success: 0, failure: 0, denied: 0 });
            if (d.success) r.success++;
            else if (d.error?.code === 'denied') r.denied++;
            else r.failure++;
          }
          if (callName != null && t != null) {
            const st = toolStartMs.get(d.toolCallId);
            if (st != null && t >= st) {
              const dt = t - st;
              if (dt > TOOL_DURATION_OUTLIER_MS) inc(toolDurationOutliers, callName);
              else (toolDurations[callName] ??= []).push(Math.round(dt));
              toolStartMs.delete(d.toolCallId);
            }
          }
          const lm = d.toolTelemetry?.metrics;
          if (lm && (typeof lm.linesAdded === 'number' || typeof lm.linesRemoved === 'number')) {
            toolLinesSeen = true;
            toolLinesAdded += lineMetric(lm.linesAdded);
            toolLinesRemoved += lineMetric(lm.linesRemoved);
          }
          // 2026-10 以降の形式: 変更したファイルを fileEdits[] に持つ(workspace_file_changed の後継)
          if (Array.isArray(d.fileEdits)) {
            for (const fe of d.fileEdits) {
              if (typeof fe?.path !== 'string') continue;
              files.add(fe.kind === 'create' ? 'create' : fe.kind === 'delete' ? 'delete' : 'edit', fe.path, curCwd());
            }
          }
          break;
        }
        case 'skill.invoked':
        case 'skill.invoked_ref': {
          const name: string = d.name ?? '(unknown)';
          // 直前の toolName:"skill" と同じ呼び出しなら 1 件にまとめる
          const pair = [...skills]
            .reverse()
            .find((s) => s.via === 'tool' && s.name === name && t != null && ms(s.at) != null && t - (ms(s.at) as number) <= SKILL_PAIR_WINDOW_MS && t >= (ms(s.at) as number));
          const trigger = skillTrigger(d.trigger);
          if (pair) {
            pair.via = 'both';
            if (trigger) pair.trigger = trigger;
          } else {
            skills.push({ name, at, via: 'event', trigger });
            pushTimeline({ at: at ?? '', kind: 'skill', label: name });
            if (isWikiSkill(name) || String(d.path ?? '').includes(WIKI_MARKER)) wiki.skillCalls.push(name);
          }
          break;
        }
        case 'subagent.started': {
          const a = agentFor(e);
          a.startedAt = at;
          a.name = d.agentName ?? a.name;
          a.model = typeof d.model === 'string' ? normalizeModel(d.model) : a.model;
          pushTimeline({ at: at ?? '', kind: 'agent', label: a.name });
          break;
        }
        case 'subagent.completed':
        case 'subagent.failed': {
          const a = agentFor(e);
          a.completedAt = at;
          a.status = e.type === 'subagent.completed' ? 'completed' : 'failed';
          if (typeof d.totalTokens === 'number') {
            a.totalTokens = d.totalTokens;
            subagentTotalTokens += d.totalTokens;
          }
          if (typeof d.totalToolCalls === 'number') a.totalToolCalls = d.totalToolCalls;
          if (e.type === 'subagent.failed') {
            friction.subagentFailures++;
            inc(subagentFailures, subagentFailureReason(d.error));
            if (d.error != null) a.error = head(typeof d.error === 'string' ? d.error : JSON.stringify(d.error), 200);
          }
          break;
        }
        case 'hook.start':
          inc(hooks, d.hookType ?? '(unknown)');
          hooksTotal++;
          break;
        case 'system.message':
          if (typeof d.content === 'string') instr.add(d.content, at);
          break;
        case 'session.compaction_complete':
          friction.compactions++;
          if (typeof d.preCompactionTokens === 'number') maxPreCompaction = Math.max(maxPreCompaction ?? 0, d.preCompactionTokens);
          lastCtx = ctxOf(d, 'compaction') ?? lastCtx;
          if (d.compactionTokensUsed && typeof d.compactionTokensUsed === 'object') {
            const cu = d.compactionTokensUsed;
            compaction.recorded++;
            compaction.input += num(cu.inputTokens) ?? 0;
            compaction.output += num(cu.outputTokens) ?? 0;
            compaction.nanoAiu += num(cu.copilotUsage?.totalNanoAiu) ?? num(cu.totalNanoAiu) ?? 0;
          }
          if (num(d.tokensRemoved) != null) compaction.tokensRemoved += d.tokensRemoved;
          pushTimeline({ at: at ?? '', kind: 'compaction', label: String(d.outcome ?? (d.success === false ? 'failed' : 'applied')) });
          break;
        case 'abort':
          friction.aborts++;
          pushTimeline({ at: at ?? '', kind: 'abort', label: String(d.reason ?? '') });
          break;
        case 'session.error':
          friction.errors++;
          inc(errorTypes, typeof d.errorType === 'string' && d.errorType !== '' ? d.errorType : '(unknown)');
          pushTimeline({ at: at ?? '', kind: 'error', label: String(d.errorType ?? d.message ?? '').slice(0, 120) });
          break;
        case 'permission.requested':
          friction.permissionRequests++;
          break;
        case 'permission.completed': {
          const kind = typeof d.result?.kind === 'string' ? d.result.kind : typeof d.result === 'string' ? d.result : '(unknown)';
          inc(permissions, kind);
          break;
        }
        case 'session.model_change': {
          friction.modelChanges++;
          if (d.newModel) models.add(normalizeModel(d.newModel));
          const eff = normalizeEffort(d.reasoningEffort);
          if (eff) effortChanges.push({ at: t, effort: eff, from: 'change' });
          break;
        }
        case 'session.mode_changed':
          friction.modeChanges++;
          if (firstPreviousMode == null && typeof d.previousMode === 'string' && d.previousMode !== '') firstPreviousMode = d.previousMode;
          if (typeof d.newMode === 'string' && d.newMode !== '') currentMode = d.newMode;
          break;
        case 'session.workspace_file_changed':
          if (typeof d.path === 'string') files.add(d.operation === 'create' ? 'create' : d.operation === 'delete' ? 'delete' : 'edit', d.path, curCwd());
          break;
        case 'session.task_complete':
          pushTimeline({ at: at ?? '', kind: 'task_complete', label: head(String(d.summary ?? ''), 120) });
          break;
        default:
          break;
      }
    }
  }
  // filesModified は順序の無い要約なので、セッション中の操作で載ったパス(途中で削除したものなど)は上書きしない
  for (const f of shutdownFiles) if (typeof f === 'string') files.addSummary(f, curCwd());

  // 変更行数: session.shutdown.codeChanges(最後の値 = セッション全体の累計)を優先し、無ければツール側の合計
  const cc = lastCodeChanges;
  const lines =
    cc && (typeof cc.linesAdded === 'number' || typeof cc.linesRemoved === 'number')
      ? { added: lineMetric(cc.linesAdded), removed: lineMetric(cc.linesRemoved), source: 'shutdown' as const }
      : toolLinesSeen
        ? { added: toolLinesAdded, removed: toolLinesRemoved, source: 'tools' as const }
        : { added: 0, removed: 0, source: 'none' as const };

  // DB しか無いセッションは turns テーブルから補う
  if (total === 0 && dbTurns.length > 0) {
    const sorted = [...dbTurns].sort((a, b) => a.turn_index - b.turn_index);
    turns = sorted.length;
    firstUserMessage = sorted[0].user_message ? head(sorted[0].user_message) : null;
    const lastResp = [...sorted].reverse().find((x) => x.assistant_response);
    lastAssistantMessage = lastResp?.assistant_response ? tail(lastResp.assistant_response) : null;
    assistantMessages = sorted.filter((x) => x.assistant_response).length;
  }
  if (files.size === 0) {
    for (const f of dbFiles) files.add(f.tool_name === 'create' ? 'create' : 'edit', f.file_path, curCwd());
  }

  // ---- トークン ----
  for (const a of agents.values()) if (a.id) agentNameById.set(a.id, a.name);
  const { items, duplicates } = mergeUsage(dbUsage, usageRecords);
  const tokens = buildTokens(items, duplicates, legacyOutput, legacyOutputByModel, agentNameById, lastShutdown);
  tokens.subagentTotalTokens = subagentTotalTokens;
  tokens.maxPreCompactionTokens = maxPreCompaction;
  for (const u of items) models.add(u.model);
  for (const m of Object.keys(tokens.byModel)) if (m !== '(unknown)') models.add(m);

  // ---- 実行の性質 ----
  if (modePending > 0) {
    // 最初の mode_changed の previousMode(記録)を使い、それも無ければ既定の interactive とみなす(推定として数える)
    inc(modeCounts, firstPreviousMode ?? 'interactive', modePending);
  }
  const modeInferred = modePending > 0 && firstPreviousMode == null ? modePending : 0;
  if (total === 0 && turns > 0) inc(modeCounts, '(unknown)', turns); // events.jsonl の無い(DB だけの)ターン
  const exec = buildExec(items, effortChanges, tokens, {
    modes: { byMode: modeCounts, inferred: modeInferred },
    context: {
      systemTokens: lastCtx?.systemTokens ?? null,
      conversationTokens: lastCtx?.conversationTokens ?? null,
      toolDefinitionsTokens: lastCtx?.toolDefinitionsTokens ?? lastToolTokenCount,
      availableToolCount: lastAvailableToolCount,
      source: lastCtx?.toolDefinitionsTokens != null ? lastCtx.source : lastToolTokenCount != null ? 'usage' : (lastCtx?.source ?? null),
    },
  });

  const cwd = ctx.cwd ?? ws?.cwd ?? dbs?.cwd ?? null;
  const gitRoot = ctx.gitRoot ?? ws?.git_root ?? null;
  const repository = ctx.repository ?? ws?.repository ?? dbs?.repository ?? null;
  const branch = ctx.branch ?? ws?.branch ?? dbs?.branch ?? null;
  const createdAt = normalizeTime(ws?.created_at ?? dbs?.created_at ?? null) ?? (firstTs != null ? new Date(firstTs).toISOString() : null);
  const updatedAt =
    latest(normalizeTime(ws?.updated_at ?? null), normalizeTime(dbs?.updated_at ?? null), lastTs != null ? new Date(lastTs).toISOString() : null);

  let durationMs: number | null = firstTs != null && lastTs != null ? lastTs - firstTs : null;
  let active: number | null = total > 0 ? activeMs : null;
  if (durationMs == null) {
    const c = ms(createdAt);
    const u = ms(updatedAt);
    durationMs = c != null && u != null && u >= c ? u - c : null;
  }

  return {
    id: input.id,
    sources,
    client: ws?.client_name ?? null,
    cwd,
    gitRoot,
    repository,
    branch,
    name: ws?.name ?? ws?.summary ?? dbs?.summary ?? null,
    project: projectKey(repository, gitRoot, cwd),
    projectSource: repository ? 'repository' : gitRoot || cwd ? 'path' : 'unknown',
    copilotVersion,
    schemaVersion,
    createdAt,
    updatedAt,
    durationMs,
    activeMs: active,
    turns,
    autopilotContinuations,
    assistantMessages,
    empty: turns === 0 && toolsTotal === 0 && assistantMessages === 0,
    firstUserMessage,
    lastAssistantMessage,
    models: [...models].sort(),
    tokens,
    tools: {
      byName: tools,
      total: toolsTotal,
      internal: { byName: internalTools, total: internalTotal },
      mcp,
      results,
      durations: toolDurations,
      durationOutliers: toolDurationOutliers,
    },
    exec,
    frictionDetail: { permissions, errorTypes, subagentFailures, compaction },
    todos: null,
    lines,
    skills,
    agents: [...agents.values()],
    hooks: { byType: hooks, total: hooksTotal },
    instructions: instr.result(),
    wiki,
    friction,
    files: files.result(),
    timeline,
    unknownEventTypes: unknown,
    events: { total, badLines: input.eventStats?.badLines ?? 0, byType },
  };
}

/**
 * その時刻の推論強度の設定(session.start / model_change の reasoningEffort)。
 * 時刻が無い・最初の設定より前のときは、最初の設定が session.start のものならそれ(時計のずれを吸収)、それ以外は null
 */
function effortAt(changes: { at: number | null; effort: string; from: 'start' | 'change' }[], at: number | null): string | null {
  if (changes.length === 0) return null;
  if (at != null) {
    let found: string | null = null;
    for (const c of changes) if (c.at != null && c.at <= at) found = c.effort;
    if (found) return found;
  } else if (new Set(changes.map((c) => c.effort)).size === 1) return changes[0].effort;
  return changes[0].from === 'start' ? changes[0].effort : null;
}

const UNKNOWN_KEY = '(unknown)';

/** リクエスト単位の明細から推論強度別・起点別・モデル別の待ち時間を作る */
function buildExec(
  items: UsageItem[],
  effortChanges: { at: number | null; effort: string; from: 'start' | 'change' }[],
  tokens: SessionTokens,
  rest: Pick<ExecProfile, 'modes' | 'context'>,
): ExecProfile {
  const efforts: Record<string, EffortStat> = {};
  const initiators: Record<string, number> = {};
  const latency: ExecProfile['latency'] = {};
  const add = (key: string, s: EffortStat): void => {
    const e = (efforts[key] ??= { requests: 0, input: 0, output: 0, nanoAiu: 0 });
    e.requests += s.requests;
    e.input += s.input;
    e.output += s.output;
    e.nanoAiu += s.nanoAiu;
  };
  for (const u of items) {
    add(u.effort ?? effortAt(effortChanges, u.at) ?? UNKNOWN_KEY, { requests: 1, input: u.input, output: u.output, nanoAiu: u.nanoAiu ?? 0 });
    inc(initiators, u.initiator ?? UNKNOWN_KEY);
    if (u.ttft != null || u.duration != null) {
      const l = (latency[u.model] ??= { ttft: [], duration: [] });
      if (u.ttft != null) l.ttft.push(Math.round(u.ttft));
      if (u.duration != null) l.duration.push(Math.round(u.duration));
    }
  }
  if (items.length === 0 && tokens.source === 'shutdown') {
    // 明細が無く終了時の累計だけ: セッション中の設定が 1 種類ならその強度、それ以外は不明
    const distinct = new Set(effortChanges.map((c) => c.effort));
    add(distinct.size === 1 ? [...distinct][0] : UNKNOWN_KEY, { requests: tokens.requests ?? 0, input: tokens.input ?? 0, output: tokens.output, nanoAiu: tokens.nanoAiu ?? 0 });
  }
  return { ...rest, efforts, initiators, latency };
}

/** null は「不明」を保つ(どちらかが null なら、もう一方の値) */
function sumCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const n = (x: number | null, y: number | null): number | null => (x == null ? y : y == null ? x : x + y);
  return {
    input: n(a.input, b.input),
    output: a.output + b.output,
    cacheRead: n(a.cacheRead, b.cacheRead),
    cacheWrite: n(a.cacheWrite, b.cacheWrite),
    reasoning: n(a.reasoning, b.reasoning),
    premiumRequests: n(a.premiumRequests, b.premiumRequests),
    nanoAiu: n(a.nanoAiu, b.nanoAiu),
    requests: a.requests == null || b.requests == null ? null : a.requests + b.requests,
  };
}

function pickDefined<T extends object>(o: T): Partial<T> {
  const r: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v != null) (r as any)[k] = v;
  return r;
}

function latest(...ts: (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const t of ts) {
    const v = ms(t);
    if (v != null && v > bestMs) {
      best = t;
      bestMs = v;
    }
  }
  return best;
}

function buildTokens(
  items: UsageItem[],
  duplicates: number,
  legacyOutput: number,
  legacyOutputByModel: Record<string, number>,
  agentNames: Map<string, string>,
  lastShutdown: CopilotEvent | null,
): SessionTokens {
  const nDb = items.filter((i) => i.origin === 'db').length;
  const nEv = items.length - nDb;
  const shutdown = shutdownTotals(lastShutdown);
  const base = {
    records: { db: nDb, events: nEv, duplicatesRemoved: duplicates },
    shutdown,
    subagentTotalTokens: 0,
    maxPreCompactionTokens: null,
  };

  // DB も usage_record も無いが shutdown にモデル別の累積値がある → それを正とする
  const mm = lastShutdown?.data?.modelMetrics;
  if (items.length === 0 && shutdown && mm && typeof mm === 'object' && Object.keys(mm).length > 0) {
    const byModel: Record<string, TokenCounts> = {};
    let requests: number | null = 0;
    for (const [m, v] of Object.entries<any>(mm)) {
      const u = v?.usage ?? {};
      const count = typeof v?.requests?.count === 'number' ? v.requests.count : null;
      if (count == null) requests = null;
      else if (requests != null) requests += count;
      const add: TokenCounts = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadTokens ?? 0,
        cacheWrite: u.cacheWriteTokens ?? 0,
        reasoning: u.reasoningTokens ?? 0,
        premiumRequests: typeof v?.requests?.cost === 'number' ? v.requests.cost : null,
        nanoAiu: typeof v?.totalNanoAiu === 'number' ? v.totalNanoAiu : null,
        requests: count,
      };
      // 表記揺れ(claude-x-5-5 と claude-x-5.5)は同じモデルとして足し合わせる
      const key = normalizeModel(m);
      byModel[key] = byModel[key] ? sumCounts(byModel[key], add) : add;
    }
    return {
      input: shutdown.input,
      output: shutdown.output,
      cacheRead: shutdown.cacheRead,
      cacheWrite: shutdown.cacheWrite,
      reasoning: shutdown.reasoning,
      premiumRequests: shutdown.premiumRequests,
      nanoAiu: shutdown.nanoAiu,
      requests,
      source: 'shutdown',
      byModel,
      byAgent: {},
      ...base,
    };
  }

  if (items.length === 0) {
    const byModel: Record<string, TokenCounts> = {};
    for (const [m, out] of Object.entries(legacyOutputByModel)) {
      byModel[m] = { input: null, output: out, cacheRead: null, cacheWrite: null, reasoning: null, premiumRequests: null, nanoAiu: null, requests: 0 };
    }
    const source: TokenSource = legacyOutput > 0 || Object.keys(legacyOutputByModel).length > 0 ? 'partial' : 'none';
    return {
      input: null,
      output: legacyOutput,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      premiumRequests: shutdown?.premiumRequests ?? null,
      nanoAiu: shutdown?.nanoAiu ?? null,
      requests: 0,
      source,
      byModel,
      byAgent: {},
      ...base,
    };
  }

  const tot = emptyTokenCounts();
  tot.premiumRequests = null;
  tot.nanoAiu = null;
  const byModel: Record<string, TokenCounts> = {};
  const byAgent: Record<string, TokenCounts> = {};
  const fresh = (): TokenCounts => ({ ...emptyTokenCounts(), premiumRequests: null, nanoAiu: null });
  for (const u of items) {
    addItem(tot, u);
    addItem((byModel[u.model] ??= fresh()), u);
    const agent = u.agentId ? (agentNames.get(u.agentId) ?? u.agentId) : 'main';
    addItem((byAgent[agent] ??= fresh()), u);
  }
  // initiator が一つも記録されていない古い行は premium を決められないので shutdown の最終値で補う
  if (tot.premiumRequests == null && shutdown?.premiumRequests != null) tot.premiumRequests = shutdown.premiumRequests;
  const source: TokenSource = nDb > 0 && nEv > 0 ? 'db+events' : nDb > 0 ? 'db' : 'events';
  return { ...tot, source, byModel, byAgent, ...base };
}
