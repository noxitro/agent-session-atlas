// 段階 2: 依頼ごとの判定のレポートでの集計(一覧に無い工程名も合計と行が食い違わないこと)
import { describe, expect, it } from 'vitest';
import { verdictAggregate, UNLISTED_PHASE, type VerdictTuple } from '../src/lib/verdicts.ts';
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
});
