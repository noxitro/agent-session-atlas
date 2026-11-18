// 失敗の台帳(analysis.failures)を作る補助。normalize.ts がイベントを読みながら行の材料を集め、
// 読み終えた後に finishLedger で next(失敗の後に何をしたか)とエージェントを埋める。
//
// - 行は tools.results の failure・denied と同じ条件で作る(開始イベントで名前が分かり、success が真偽値。内部ツールは除く)。
// - 文の項目(エラー文・引数・サブエージェントの prompt)は、全文の秘密らしい文字列を伏せてから上限で切る
//   (先に切ると、途中で切れた鍵が形に当たらず残る)。group は伏せた後の文から作る。
// - エージェントは、親の呼び出しの toolCallId(data.parentToolCallId。無ければ agentId から引いた親の呼び出し、
//   それも無ければ agentId)で見分ける。どちらも無ければ本体。
import { redactSecrets } from './secrets.ts';
import { normalizeRequest } from './text.ts';
import type { FailureCause } from './tool-failure.ts';
import type { CallOutcome, FailureNext, ToolFailure } from './types.ts';

/** 1 セッションで残す行の数(時刻の早い順。超えた分は failuresDropped に数だけ) */
export const MAX_ROWS = 500;
/** エラー文の上限(UTF-16 の単位。切ったときの末尾の … を含む) */
export const ERROR_LIMIT = 1000;
/** 引数の上限 */
export const ARGS_LIMIT = 1000;
/** サブエージェントの prompt の上限 */
export const PROMPT_LIMIT = 500;
/** group の上限 */
export const GROUP_LIMIT = 200;

/** 上限(UTF-16 の単位。末尾の … を含む)で切る */
export function cap(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, Math.max(0, limit - 1))}…`;
}

/** 秘密らしい文字列を全文で伏せてから、上限で切る */
export function redactCap(s: string, limit: number): string {
  return cap(redactSecrets(s).text, limit);
}

/** error の文(文字列はそのまま。オブジェクトは message、無ければ JSON。code があれば「code: message」) */
export function errorMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const o = Array.isArray(error) ? null : (error as Record<string, unknown>);
    const code = typeof o?.code === 'string' ? o.code : '';
    const msg = typeof o?.message === 'string' ? o.message : JSON.stringify(error);
    return code ? `${code}: ${msg}` : msg;
  }
  return String(error);
}

/** 引数の文(文字列はそのまま、それ以外は 1 行の JSON) */
export function argsText(args: unknown): string {
  return typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
}

const QUOTED = /(^|[^\p{L}\p{N}_])(?:'[^'\n]*'|"[^"\n]*"|‘[^’\n]*’|“[^”\n]*”)/gu;
const BACKTICKED = /`[^`\n]*`/g;

/**
 * 似たエラー文をまとめる鍵: 伏せた後の文の、空でない最初の行の引用を <q> にし、依頼文と同じ正規化
 * (URL・パス・16 進 id・数字を印に、記号を落とす)をして上限で切る
 */
export function groupOf(redactedError: string): string {
  const first =
    redactedError
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .find((l) => l.trim() !== '') ?? '';
  const t = first.replace(BACKTICKED, ' <q> ').replace(QUOTED, '$1 <q> ');
  return cap(normalizeRequest(t), GROUP_LIMIT);
}

/** 作業のツール呼び出し 1 件(開始イベントの順)。next を探すのに使う */
export interface CallRec {
  /** data.parentToolCallId */
  parent: string | null;
  /** 上位の agentId */
  aid: string | null;
  /** 開始イベントの番号(イベントの並びの何件目か) */
  startIdx: number;
  /** その呼び出しを要求した assistant.message の通し番号(toolRequests の toolCallId から)。分からなければ null */
  batch: number | null;
  tool: string;
  outcome: CallOutcome;
  /** 呼び直しの判定に使う引数の文(引数が無ければ空) */
  argKey: string;
}

/** 読み終える前の台帳の 1 行 */
export interface PendingRow {
  row: ToolFailure;
  parent: string | null;
  aid: string | null;
  /** 完了イベントの番号 */
  completeIdx: number;
  batch: number | null;
  /** 失敗した呼び出しの引数の文(開始イベントが無ければ null) */
  argKey: string | null;
}

/** エージェントの鍵(親の呼び出しの toolCallId。分からなければ agentId)。本体は null */
export function agentKey(parent: string | null, aid: string | null, callByAgentId: ReadonlyMap<string, string>): string | null {
  if (parent) return parent;
  if (!aid) return null;
  return callByAgentId.get(aid) ?? aid;
}

/** 昇順の並びで、pred が初めて真になる位置(無ければ長さ) */
function firstIndex(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 読み終えた後に、エージェントと next を埋めて台帳を仕上げる。
 * next は、同じエージェントの呼び出しのうち、失敗の完了イベントより後に始まり、失敗と同じ応答で要求されたものでない最初の呼び出し。
 * それより前に始まった呼び出しは並列なので数えない。本体は、その呼び出しより先に利用者の新しい依頼が来たら user
 */
export function finishLedger(
  rows: PendingRow[],
  calls: readonly CallRec[],
  userTurnIdx: readonly number[],
  callByAgentId: ReadonlyMap<string, string>,
  agentName: (key: string) => string | undefined,
): ToolFailure[] {
  const callKeys = calls.map((c) => agentKey(c.parent, c.aid, callByAgentId));
  return rows.map((p) => {
    const key = agentKey(p.parent, p.aid, callByAgentId);
    const row = p.row;
    const from = firstIndex(calls.length, (i) => calls[i].startIdx > p.completeIdx);
    let found = -1;
    for (let i = from; i < calls.length; i++) {
      const c = calls[i];
      if (callKeys[i] === key && !(p.batch != null && c.batch != null && c.batch <= p.batch)) {
        found = i;
        break;
      }
    }
    // 失敗の完了より後、until より前に始まった利用者の依頼があるか
    const userBefore = (until: number): boolean => {
      const i = firstIndex(userTurnIdx.length, (j) => userTurnIdx[j] > p.completeIdx);
      return i < userTurnIdx.length && userTurnIdx[i] < until;
    };
    const main = key == null;
    let next: FailureNext;
    if (found >= 0 && !(main && userBefore(calls[found].startIdx))) {
      const c = calls[found];
      next = { kind: 'tool', tool: c.tool, outcome: c.outcome, retry: c.tool === row.tool && p.argKey != null && c.argKey === p.argKey };
    } else if (main && userBefore(Infinity)) next = { kind: 'user' };
    else next = { kind: 'end' };
    row.next = next;
    if (key != null) {
      row.agent = agentName(key) ?? '(unknown)';
      row.agentCall = key;
    }
    return row;
  });
}

/** 行の材料(normalize.ts から) */
export interface RowInput {
  tool: string;
  error: unknown;
  denied: boolean;
  cause: FailureCause | null;
  args: string | null;
  mcpServer: string | null;
  mcpTool: string | null;
  mcpConfigSource: string | null;
  model: string | null;
  startedAt: string | null;
  durationMs: number | null;
  turn: number | null;
}

/** 1 行を作る(エージェントと next は finishLedger で埋める) */
export function buildRow(i: RowInput): ToolFailure {
  const err = redactSecrets(errorMessage(i.error)).text;
  return {
    tool: i.tool,
    kind: i.denied ? 'denied' : 'failure',
    cause: i.denied ? null : i.cause,
    error: cap(err, ERROR_LIMIT),
    args: i.args == null ? null : redactCap(i.args, ARGS_LIMIT),
    mcpServer: i.mcpServer,
    mcpTool: i.mcpTool,
    mcpConfigSource: i.mcpConfigSource,
    model: i.model,
    startedAt: i.startedAt,
    durationMs: i.durationMs,
    turn: i.turn,
    agent: null,
    agentCall: null,
    next: { kind: 'end' },
    group: groupOf(err),
  };
}
