// 段階 2: 依頼ごとの LLM 判定(turn-judgments.json)をレポートに載せる形。
// 読みは軽い検証だけ(形の合わない項目は捨てる。正しい形にして書くのは judge の取り込み側)。
// 埋め込みは 1 依頼 1 つの数値の組(VerdictTuple)。判定の理由(note)は HTML 本体に入れず、詳細ページにだけ出す。
import {
  addTurn,
  emptyTurnBucket,
  MISMATCHES,
  OUTCOMES,
  PHASES,
  REQUEST_KINDS,
  type Mismatch,
  type Outcome,
  type Phase,
  type RequestKind,
  type TurnBucket,
} from '../../../core/src/turns.ts';
import { fromTuple, type TurnTuple } from './turns.ts';

export interface TurnVerdict {
  turn: number;
  kind: RequestKind;
  outcome: Outcome;
  mismatch: Mismatch | null;
  phase: string;
  confidence: number;
  note: string;
}

export interface VerdictIndex {
  phases: string[];
  model: string | null;
  ranAt: string | null;
  /** セッション ID → 依頼番号 → 判定 */
  bySession: Map<string, Map<number, TurnVerdict>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** turn-judgments.json を読む(形の合わない項目は捨てる) */
export function parseVerdicts(raw: unknown): VerdictIndex | null {
  if (!isObj(raw) || !Array.isArray(raw.phases) || !Array.isArray(raw.items)) return null;
  const phases = raw.phases.filter((x): x is string => typeof x === 'string');
  const bySession = new Map<string, Map<number, TurnVerdict>>();
  for (const it of raw.items) {
    if (!isObj(it) || typeof it.sessionId !== 'string' || typeof it.turn !== 'number') continue;
    if (!(REQUEST_KINDS as readonly unknown[]).includes(it.kind) || !(OUTCOMES as readonly unknown[]).includes(it.outcome) || typeof it.phase !== 'string') continue;
    const v: TurnVerdict = {
      turn: it.turn,
      kind: it.kind as RequestKind,
      outcome: it.outcome as Outcome,
      mismatch: (MISMATCHES as readonly unknown[]).includes(it.mismatch) ? (it.mismatch as Mismatch) : null,
      phase: it.phase,
      confidence: typeof it.confidence === 'number' ? it.confidence : 0,
      note: typeof it.note === 'string' ? it.note : '',
    };
    const m = bySession.get(it.sessionId) ?? bySession.set(it.sessionId, new Map()).get(it.sessionId)!;
    m.set(v.turn, v);
  }
  const j = isObj(raw.judge) ? raw.judge : {};
  return { phases, model: typeof j.model === 'string' ? j.model : null, ranAt: typeof j.ranAt === 'string' ? j.ranAt : null, bySession };
}

/** [依頼番号, 種類, 扱い, 合わなかった点(無ければ null), 普段の工程(phases の番号。無ければ -1), 確信度(0〜100)] */
export type VerdictTuple = [turn: number, kind: number, outcome: number, mismatch: number | null, phase: number, confidence: number];

export function verdictTuples(m: Map<number, TurnVerdict> | undefined, phases: readonly string[]): VerdictTuple[] {
  if (!m) return [];
  return [...m.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((v) => [v.turn, REQUEST_KINDS.indexOf(v.kind), OUTCOMES.indexOf(v.outcome), v.mismatch == null ? null : MISMATCHES.indexOf(v.mismatch), phases.indexOf(v.phase), Math.round(v.confidence * 100)]);
}

/** 扱いの数え方(1 つの工程・種類ごと) */
export interface OutcomeCounts {
  judged: number;
  byOutcome: Record<Outcome, number>;
  byMismatch: Record<Mismatch, number>;
  /** 同じ依頼の規則の集計(詰まり・失敗など) */
  turns: TurnBucket;
}

const emptyCounts = (): OutcomeCounts => ({
  judged: 0,
  byOutcome: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>,
  byMismatch: Object.fromEntries(MISMATCHES.map((m) => [m, 0])) as Record<Mismatch, number>,
  turns: emptyTurnBucket(),
});

export interface VerdictAggregate {
  judged: number;
  /** 判定済みの依頼があるセッション */
  sessions: number;
  /** 普段の工程名(判定に使ったもの) */
  phases: string[];
  total: OutcomeCounts;
  /** 普段の工程別(phases の並び) */
  byPhase: OutcomeCounts[];
  /** 規則の工程別 */
  byRulePhase: Record<Phase, OutcomeCounts>;
}

/** 絞り込み後のセッションの判定を集計する(規則の行と同じ依頼番号で結ぶ) */
export function verdictAggregate(sessions: { turnRows?: TurnTuple[]; turnVerdicts?: VerdictTuple[] }[], phases: readonly string[]): VerdictAggregate {
  const total = emptyCounts();
  const byPhase = phases.map(() => emptyCounts());
  const byRulePhase = Object.fromEntries(PHASES.map((p) => [p, emptyCounts()])) as Record<Phase, OutcomeCounts>;
  let judged = 0;
  let withAny = 0;
  for (const s of sessions) {
    const vs = s.turnVerdicts ?? [];
    if (!vs.length) continue;
    withAny++;
    for (const v of vs) {
      const outcome = OUTCOMES[v[2]];
      if (!outcome) continue;
      const mismatch = v[3] == null ? null : (MISMATCHES[v[3]] ?? null);
      const row = s.turnRows?.[v[0] - 1];
      const facts = row ? fromTuple(row) : null;
      const add = (c: OutcomeCounts): void => {
        c.judged++;
        c.byOutcome[outcome]++;
        if (mismatch) c.byMismatch[mismatch]++;
        if (facts) addTurn(c.turns, facts);
      };
      judged++;
      add(total);
      if (v[4] >= 0 && byPhase[v[4]]) add(byPhase[v[4]]);
      if (facts) add(byRulePhase[facts.phase]);
    }
  }
  return { judged, sessions: withAny, phases: [...phases], total, byPhase, byRulePhase };
}

/** 作業の依頼のうち判定できたもの(判定不能・質問の扱いを除く)と、そのまま採用の割合の分母 */
export const workDecided = (c: OutcomeCounts): number => c.byOutcome.as_is + c.byOutcome.fix_content + c.byOutcome.fix_style + c.byOutcome.rejected;
export const questionDecided = (c: OutcomeCounts): number => c.byOutcome.helpful + c.byOutcome.follow_up + c.byOutcome.off_target;
