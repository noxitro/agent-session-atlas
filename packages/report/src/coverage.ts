// Phase 11: 網羅の検査。元データ(events.jsonl)の event type × data のキーごとに「全文に出した / 参照にした / 理由付きで除外」を決める表と、
// 件数・バイト数の集計(out/coverage.json)。表に無いキーは「未分類」として数え、export のログと全文記録の末尾に出す。
// data.db の列は core の desktop.ts の許可リストで同じ扱いにする(許可 = full、許可外 = unclassified、開かない表 = excluded)。

/** partial: 全文に出すが、その中の不透明な値(base64 らしい文字列)だけ除外する(reasoningBlocks) */
export type Treatment = 'full' | 'ref' | 'excluded' | 'partial';

export interface Rule {
  treatment: Treatment;
  /** 除外・参照の理由(full は省略可) */
  reason?: string;
}

/** 全イベントに共通のトップレベルのキー(`^` 付き)。id / parentId は参照、timestamp と agentId は本文の行に出す */
const COMMON_TOP: Record<string, Rule> = {
  '^id': { treatment: 'ref', reason: 'イベント id(行の参照に使う)' },
  '^parentId': { treatment: 'ref', reason: '親イベント id' },
  '^timestamp': { treatment: 'full' },
  '^agentId': { treatment: 'full' },
};

const full: Rule = { treatment: 'full' };
const ref = (reason: string): Rule => ({ treatment: 'ref', reason });
const excluded = (reason: string): Rule => ({ treatment: 'excluded', reason });
const ENC = excluded('暗号化・不透明データ(復号できない。種別とサイズだけ書く)');
const IDS = ref('対応付けの id(本文の行に短く出す)');

/**
 * event type → data のキー → 扱い。`*` はその type の未知のキーの既定(無ければ未分類)。
 * ここに無い type のキーは未分類になる(新しい種別に対応したらここに足す)。
 */
export const COVERAGE_RULES: Record<string, Record<string, Rule>> = {
  'user.message': {
    content: full,
    transformedContent: ref('content に添付等を展開した版。content と同じなら省き、違えば全文'),
    attachments: full,
    agentMode: full,
    source: full,
    delivery: full,
    isAutopilotContinuation: full,
    parentAgentTaskId: IDS,
    interactionId: IDS,
    messageId: IDS,
    turnId: IDS,
    responsesReasoning: full,
    supportedNativeDocumentMimeTypes: ref('対応 MIME の一覧(種類の数だけ書く)'),
  },
  'assistant.message': {
    content: full,
    reasoningText: full,
    reasoningBlocks: { treatment: 'partial', reason: '要素の中の base64 らしい値(不透明データ)だけ除外し、読める値は出す' },
    toolRequests: full,
    encryptedContent: ENC,
    reasoningOpaque: ENC,
    model: full,
    outputTokens: full,
    phase: full,
    serverTools: full,
    providerId: full,
    rte: full,
    chunkCount: full,
    chunkIndex: full,
    messageId: IDS,
    interactionId: IDS,
    requestId: IDS,
    apiCallId: IDS,
    serviceRequestId: IDS,
    clientRequestId: IDS,
    originatingMessageId: IDS,
    parentToolCallId: IDS,
    turnId: IDS,
  },
  'assistant.turn_start': { interactionId: IDS, turnId: IDS, model: full, parentToolCallId: IDS },
  'assistant.turn_end': { turnId: IDS, model: full, parentToolCallId: IDS },
  'tool.execution_start': {
    toolName: full,
    arguments: full,
    toolCallId: IDS,
    parentToolCallId: IDS,
    turnId: IDS,
    model: full,
    toolTitle: full,
    shellToolInfo: full,
    rte: full,
    mcpServerName: full,
    mcpToolName: full,
    mcpConfigServerName: full,
    mcpConfigSource: full,
    mcpTransport: full,
  },
  'tool.execution_complete': {
    result: full,
    success: full,
    error: full,
    toolTelemetry: full,
    fileEdits: full,
    shellExecution: full,
    sandboxed: full,
    model: full,
    rte: full,
    toolCallId: IDS,
    parentToolCallId: IDS,
    interactionId: IDS,
    turnId: IDS,
  },
  'hook.start': { hookType: full, input: full, hookInvocationId: IDS, parentToolCallId: IDS },
  'hook.end': { hookType: full, success: full, output: full, hookInvocationId: IDS, parentToolCallId: IDS },
  'system.message': { role: full, content: full, contentBlocks: full, metadata: full, interactionId: IDS },
  'system.notification': { kind: full, content: full, message: full, responsesReasoning: full },
  'session.start': { '*': full },
  'session.resume': { '*': full },
  'session.info': { '*': full },
  'session.shutdown': { '*': full },
  'session.usage_record': { usage: full },
  'session.usage_checkpoint': { '*': full },
  'session.compaction_start': { '*': full },
  'session.compaction_complete': { summaryContent: full, checkpointPath: ref('チェックポイントのパス(番号で節を参照)'), '*': full },
  'session.error': { '*': full },
  'session.task_complete': { '*': full },
  'session.mode_changed': { '*': full },
  'session.mode_notice_delivered': { '*': full },
  'session.model_change': { '*': full },
  'session.permissions_changed': { '*': full },
  'session.plan_changed': { '*': full },
  'session.workspace_file_changed': { '*': full },
  'session.context_changed': { '*': full },
  'session.auto_mode_resolved': { '*': full },
  'session.canvas.recorded': { '*': full },
  'session.canvas.removed': { '*': full },
  'session.binary_asset': {
    data: excluded('base64 の本体(out/full/assets/ にファイルとして書き出し、リンクにする)'),
    assetId: full,
    type: full,
    mimeType: full,
    byteLength: full,
    description: full,
  },
  abort: { '*': full },
  'permission.requested': { '*': full },
  'permission.completed': { '*': full },
  'external_tool.requested': { '*': full },
  'external_tool.completed': { '*': full },
  'subagent.started': { '*': full },
  'subagent.completed': { '*': full },
  'subagent.failed': { '*': full },
  'subagent.selected': { '*': full },
  'subagent.configured': { '*': full },
  'skill.invoked': { content: full, '*': full },
  'skill.invoked_ref': { '*': full },
  'skill.context_delivered_ref': { '*': full },
  'model.captured_assignment_context': { '*': full },
  'model.message': { '*': full },
  'model.messages_snapshot': { '*': full },
  'model.model_call_started': { '*': full },
  'model.model_call_success': { '*': full },
  'model.response': { '*': full },
  'model.turn_ended': { '*': full },
  'model.turn_started': { '*': full },
};

/** キーの扱い。無ければ null(未分類) */
export function ruleFor(type: string, key: string): Rule | null {
  if (key.startsWith('^')) return COMMON_TOP[key] ?? null;
  const t = COVERAGE_RULES[type];
  if (!t) return null;
  return t[key] ?? t['*'] ?? null;
}

export interface CoverageEntry {
  type: string;
  key: string;
  n: number;
  bytes: number;
  treatment: Treatment | 'unclassified';
  reason?: string;
  /** partial で実際に除外した箇所の数とバイト数(全文記録が数える) */
  excludedN?: number;
  excludedBytes?: number;
}

/** 集計器。1 イベントずつ add する(値は数えるだけ) */
export class CoverageCounter {
  private map = new Map<string, CoverageEntry>();
  types = new Map<string, { n: number; bytes: number }>();
  events = 0;

  add(ev: { type: string; data?: unknown } & Record<string, unknown>): void {
    this.events++;
    const line = JSON.stringify(ev).length;
    const t = this.types.get(ev.type) ?? { n: 0, bytes: 0 };
    t.n++;
    t.bytes += line;
    this.types.set(ev.type, t);
    for (const k of Object.keys(ev)) if (k !== 'type' && k !== 'data') this.bump(ev.type, `^${k}`, JSON.stringify(ev[k] ?? null).length);
    if (ev.data && typeof ev.data === 'object') for (const [k, v] of Object.entries(ev.data as Record<string, unknown>)) this.bump(ev.type, k, JSON.stringify(v ?? null).length);
  }

  private bump(type: string, key: string, bytes: number): void {
    const id = `${type}|${key}`;
    let e = this.map.get(id);
    if (!e) {
      const r = ruleFor(type, key);
      e = { type, key, n: 0, bytes: 0, treatment: r?.treatment ?? 'unclassified', ...(r?.reason ? { reason: r.reason } : {}) };
      this.map.set(id, e);
    }
    e.n++;
    e.bytes += bytes;
  }

  /** 全文記録が partial のキーの中で除外した箇所を数える */
  addExcluded(type: string, key: string, bytes: number): void {
    const e = this.map.get(`${type}|${key}`);
    if (!e) return;
    e.excludedN = (e.excludedN ?? 0) + 1;
    e.excludedBytes = (e.excludedBytes ?? 0) + bytes;
  }

  entries(): CoverageEntry[] {
    return [...this.map.values()].sort((a, b) => b.bytes - a.bytes);
  }
  unclassified(): CoverageEntry[] {
    return this.entries().filter((e) => e.treatment === 'unclassified');
  }
}

export interface DesktopColumnCoverage {
  table: string;
  column: string;
  treatment: Treatment | 'unclassified';
  reason?: string;
}

/** data.db の列の扱い(core の desktop.ts の許可リスト。値は読まない) */
export function desktopCoverage(c: { tables: Record<string, { allowed: string[]; unlisted: string[]; rows: number }>; forbidden: Record<string, string>; otherTables: string[] } | null | undefined): DesktopColumnCoverage[] {
  if (!c) return [];
  const out: DesktopColumnCoverage[] = [];
  for (const [table, t] of Object.entries(c.tables)) {
    for (const column of t.allowed) out.push({ table, column, treatment: 'full' });
    for (const column of t.unlisted) out.push({ table, column, treatment: 'unclassified', reason: '許可リストに無い列(値は読んでいない)' });
  }
  for (const [table, reason] of Object.entries(c.forbidden)) out.push({ table, column: '*', treatment: 'excluded', reason });
  for (const table of c.otherTables) out.push({ table, column: '*', treatment: 'excluded', reason: 'セッションの解析に使わない表(開いていない)' });
  return out;
}

export interface CoverageFile {
  version: 1;
  generatedAt: string;
  sessions: number;
  events: number;
  types: Record<string, { n: number; bytes: number }>;
  keys: CoverageEntry[];
  summary: Record<Treatment | 'unclassified', { keys: number; n: number; bytes: number }>;
  desktop: { columns: DesktopColumnCoverage[]; unclassified: number } | null;
}

export function coverageFile(counter: CoverageCounter, sessions: number, desktop: DesktopColumnCoverage[] | null, generatedAt: string): CoverageFile {
  const keys = counter.entries();
  const summary: CoverageFile['summary'] = { full: { keys: 0, n: 0, bytes: 0 }, ref: { keys: 0, n: 0, bytes: 0 }, excluded: { keys: 0, n: 0, bytes: 0 }, partial: { keys: 0, n: 0, bytes: 0 }, unclassified: { keys: 0, n: 0, bytes: 0 } };
  for (const e of keys) {
    const s = summary[e.treatment];
    s.keys++;
    s.n += e.n;
    s.bytes += e.bytes;
  }
  return {
    version: 1,
    generatedAt,
    sessions,
    events: counter.events,
    types: Object.fromEntries(counter.types),
    keys,
    summary,
    desktop: desktop ? { columns: desktop, unclassified: desktop.filter((c) => c.treatment === 'unclassified').length } : null,
  };
}
