// 依頼(ターン)単位の分析をレポートに載せる形(段階 1)。
// 埋め込みは 1 ターン 1 つの数値の組(TurnTuple)にして小さくし、画面で絞り込みに合わせて工程別・依頼の種類別に集計し直す。
// 分類の規則(工程・依頼の種類)と集計の足し方は core/src/turns.ts と同じものを使う。
import {
  addTurn,
  emptyTurnBucket,
  PHASES,
  REQUEST_KINDS,
  sessionTurns,
  type Phase,
  type RequestKind,
  type TurnBucket,
  type TurnRow,
} from '../../../core/src/turns.ts';
import type { SessionRecord } from '../../../core/src/types.ts';

/**
 * [工程, 依頼の種類, 次の依頼の種類(無ければ null), 実働 ms, ツール, 失敗, 拒否, 中断, エラー, うち利用上限, 文脈圧縮, 再編集, nano AIU, サブエージェント失敗, 編集]。
 * 工程と依頼の種類は PHASES / REQUEST_KINDS の番号
 */
export type TurnTuple = [
  phase: number,
  kind: number,
  next: number | null,
  activeMs: number | null,
  tools: number,
  toolFailures: number,
  denied: number,
  aborts: number,
  errors: number,
  externalErrors: number,
  compactions: number,
  reEdits: number,
  nanoAiu: number | null,
  subagentFailures: number,
  edits: number,
];

export function turnTuples(r: Pick<SessionRecord, 'id' | 'analysis'>): TurnTuple[] {
  return sessionTurns(r).map((t) => [
    PHASES.indexOf(t.phase),
    REQUEST_KINDS.indexOf(t.kind),
    t.nextKind == null ? null : REQUEST_KINDS.indexOf(t.nextKind),
    t.activeMs,
    t.tools,
    t.toolFailures,
    t.denied,
    t.aborts,
    t.errors,
    t.externalErrors,
    t.compactions,
    t.reEdits,
    t.nanoAiu,
    t.subagentFailures,
    t.edits,
  ]);
}

/** 埋め込みの組を集計に使う形に戻す(依頼文・時刻・使用量の入力 / 出力は持たない) */
export function fromTuple(x: TurnTuple): Omit<TurnRow, 'sessionId' | 'index' | 'text' | 'startedAt' | 'kinds' | 'ms' | 'maxConsecutiveFailures'> {
  return {
    phase: PHASES[x[0]] ?? 'research',
    kind: REQUEST_KINDS[x[1]] ?? 'task',
    nextKind: x[2] == null ? null : (REQUEST_KINDS[x[2]] ?? null),
    activeMs: x[3],
    tools: x[4],
    toolFailures: x[5],
    denied: x[6],
    aborts: x[7],
    errors: x[8],
    externalErrors: x[9],
    compactions: x[10],
    reEdits: x[11],
    nanoAiu: x[12],
    subagentFailures: x[13],
    edits: x[14],
    askUser: 0,
    input: null,
    output: null,
  };
}

export interface TurnAggregate {
  turns: number;
  /** ターンの記録があるセッション */
  sessions: number;
  /** 依頼があるのにターンの記録が無いセッション(古い記録・DB だけ) */
  sessionsWithoutTurns: number;
  total: TurnBucket;
  byPhase: Record<Phase, TurnBucket>;
  byKind: Record<RequestKind, TurnBucket>;
}

/** 絞り込み後のセッションのターンを集計する */
export function turnAggregate(sessions: { turns: number; turnRows?: TurnTuple[] }[]): TurnAggregate {
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, emptyTurnBucket()])) as Record<Phase, TurnBucket>;
  const byKind = Object.fromEntries(REQUEST_KINDS.map((k) => [k, emptyTurnBucket()])) as Record<RequestKind, TurnBucket>;
  const total = emptyTurnBucket();
  let turns = 0;
  let withTurns = 0;
  let without = 0;
  for (const s of sessions) {
    const rows = s.turnRows ?? [];
    if (!rows.length) {
      if (s.turns > 0) without++;
      continue;
    }
    withTurns++;
    for (const x of rows) {
      const t = fromTuple(x);
      turns++;
      addTurn(total, t);
      addTurn(byPhase[t.phase], t);
      addTurn(byKind[t.kind], t);
    }
  }
  return { turns, sessions: withTurns, sessionsWithoutTurns: without, total, byPhase, byKind };
}
