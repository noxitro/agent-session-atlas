// 段階 2: 依頼ごとの判定のレポートでの集計(一覧に無い工程名も合計と行が食い違わないこと)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucketVerdictView, TURN_LIMIT, turnsOverLimit, VERDICT_RATE_MIN_TURNS, verdictAggregate, verdictRate, UNLISTED_PHASE, type VerdictTuple } from '../src/lib/verdicts.ts';
import { COMPARE_MIN_TURNS } from '../src/lib/compare.ts';
import { bucket } from '../src/lib/aggregate.ts';
import type { SessionSummary } from '../src/lib/types.ts';
import type { TurnTuple } from '../src/lib/turns.ts';

const row = (phase: number): TurnTuple => [phase, 0, null, 1000, 1, 0, 0, 0, 0, 0, 0, 0, null, 0, 0];

describe('依頼ごとの判定の集計', () => {
  it('採用率の分母は判定できた作業の依頼、一覧に無い工程名は「(一覧に無い工程)」の行に入る', () => {
    // [依頼番号, 種類, 扱い, 合わなかった点, 工程の番号, 確信度]。扱いの番号は OUTCOMES の並び(as_is=0, fix_content=1, rejected=3, helpful=4, unknown=7)
    const v: VerdictTuple[] = [
      [1, 0, 0, null, 0, 80],
      [2, 0, 1, 0, 0, 70],
      [3, 0, 7, null, 1, 50],
      [4, 1, 4, null, -1, 60],
    ];
    const a = verdictAggregate([{ turnRows: [row(2), row(2), row(0), row(5)], turnVerdicts: v }], ['実装', 'テスト']);
    expect(a.judged).toBe(4);
    expect(a.phases).toEqual(['実装', 'テスト', UNLISTED_PHASE]);
    expect(a.byPhase.map((c) => c.judged)).toEqual([2, 1, 1]);
    expect(a.byPhase.reduce((x, c) => x + c.judged, 0)).toBe(a.total.judged);
    expect(a.total.byOutcome).toMatchObject({ as_is: 1, fix_content: 1, unknown: 1, helpful: 1 });
    expect(a.total.byMismatch.requirement).toBe(1);
    // 規則の工程(implement = 2)にも結ぶ
    expect(a.byRulePhase.implement.judged).toBe(2);
  });

  it('人別の表: 集計の判定の数から採用率・直しの割合・合わなかった点のいちばん多いものを出す(下限に届かなければ —)', () => {
    // [依頼番号, 種類, 扱い, 合わなかった点, 工程, 確信度]。扱い 0 = as_is・1 = fix_content・2 = fix_style・99 は形の合わないもの
    const v: VerdictTuple[] = [
      [1, 0, 0, null, 0, 80],
      [2, 0, 1, 1, 0, 70],
      [3, 0, 2, 2, 0, 70],
      [4, 0, 0, null, 0, 70],
      [5, 0, 1, 1, 0, 70],
      [6, 0, 99, null, 0, 70],
    ];
    const b = bucket('p', 'p', [{ ...minimalSession('s1'), turnVerdicts: v } as unknown as SessionSummary]).turnVerdicts;
    expect(b).toEqual({ judged: 5, workDecided: 5, asIs: 2, fix: 3, byMismatch: { requirement: 0, defect: 2, quality: 1, scope: 0, environment: 0, other: 0 } });
    const view = bucketVerdictView(b, 5);
    expect(view).toEqual({ judged: 5, adoptRate: 2 / 5, fixRate: 3 / 5, topMismatch: { key: 'defect', count: 2 } });
    // 判定できた作業の依頼が下限に届かなければ割合も合わなかった点も出さない
    expect(bucketVerdictView(b, 6)).toEqual({ judged: 5, adoptRate: null, fixRate: null, topMismatch: null });
    // 同じ数なら MISMATCHES の順
    expect(bucketVerdictView({ ...b, byMismatch: { ...b.byMismatch, requirement: 2 } }, 5).topMismatch).toEqual({ key: 'requirement', count: 2 });
  });

  it('依頼の上限を超えて判定の束に入らなかった依頼を数える(集計のときに本体の依頼として数えた数。上限は Rust の判定の束と同じ)', () => {
    const over = (n?: number) => ({ analysis: n == null ? {} : { turnsOverLimit: n } });
    expect(turnsOverLimit([over(30), over(), over(0), over(1)])).toEqual({ turns: 31, sessions: 2 });
    // 依頼の数(turns)からは数えない: サブエージェントの依頼も入る・DB だけのセッション(依頼ごとの記録が無い)の依頼も入るため
    expect(turnsOverLimit([{ turns: TURN_LIMIT + 300, analysis: {} }] as { turns: number; analysis: {} }[])).toEqual({ turns: 0, sessions: 0 });
    expect(turnsOverLimit([])).toEqual({ turns: 0, sessions: 0 });
    const rs = readFileSync(join(import.meta.dirname, '..', '..', '..', 'crates', 'atlas-judge', 'src', 'turn_bundle.rs'), 'utf8');
    expect(rs).toContain(`const MAX_TURNS: usize = ${TURN_LIMIT};`);
    const core = readFileSync(join(import.meta.dirname, '..', '..', '..', 'crates', 'atlas-core', 'src', 'normalize.rs'), 'utf8');
    expect(core).toContain(`const ANALYSIS_TURNS: usize = ${TURN_LIMIT};`);
  });

  it('依頼ごとの判定の割合の下限は、Rust のタスクの表と「比べる」の工程どうしと同じ', () => {
    const rs = readFileSync(join(import.meta.dirname, '..', '..', '..', 'crates', 'atlas-report', 'src', 'tasks', 'extras.rs'), 'utf8');
    expect(rs).toContain(`pub const VERDICT_RATE_MIN_TURNS: usize = ${VERDICT_RATE_MIN_TURNS};`);
    expect(VERDICT_RATE_MIN_TURNS).toBe(COMPARE_MIN_TURNS);
    expect(verdictRate(2, VERDICT_RATE_MIN_TURNS)).toBe(2 / VERDICT_RATE_MIN_TURNS);
    expect(verdictRate(1, VERDICT_RATE_MIN_TURNS - 1)).toBeNull();
    expect(verdictRate(0, 0)).toBeNull();
  });
});

/** bucket に渡す最小のセッション(数える項目だけ) */
function minimalSession(id: string): Partial<SessionSummary> {
  return {
    id,
    turns: 0,
    autopilotContinuations: 0,
    empty: false,
    tokens: { input: null, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, premiumRequests: null, nanoAiu: null, requests: null } as unknown as SessionSummary['tokens'],
    tools: { total: 0, internal: 0 } as SessionSummary['tools'],
    lines: { added: 0, removed: 0, source: 'none' } as SessionSummary['lines'],
    skills: {},
    agents: { total: 0, failed: 0 } as SessionSummary['agents'],
    hooks: { total: 0 } as SessionSummary['hooks'],
    instructions: {},
    wiki: { indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0, otherCalls: 0, pages: [] } as unknown as SessionSummary['wiki'],
    friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 },
    judgment: null,
  };
}
