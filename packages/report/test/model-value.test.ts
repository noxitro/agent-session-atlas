import { describe, expect, it } from 'vitest';
import { OUTCOMES } from '../../core/src/turns.ts';
import { effortFindings, keptShare, mean, modelValue, ratio } from '../src/lib/model-value.ts';
import { RETENTION_MIN_SESSIONS } from '../src/lib/retention.ts';
import type { EffortTuple, JudgmentSummary, SessionSummary } from '../src/lib/types.ts';

/** 効果の集計に使う欄だけ持つ SessionSummary */
function sess(id: string, modelEfforts: Record<string, Record<string, EffortTuple>>, p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    byModel: {},
    exec: { modes: {}, modesInferred: 0, efforts: {}, modelEfforts, mainModelEfforts: {}, initiators: {}, context: null, latency: {} },
    tools: { total: 10, byName: {}, internal: 0, mcp: {}, issues: {}, durations: {}, outliers: {} },
    friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 },
    judgment: null,
    ...p,
  } as SessionSummary;
}
const judged = (j: Partial<JudgmentSummary>): JudgmentSummary =>
  ({ taskCategory: null, hours: null, low: null, high: null, confidence: null, taskSummary: null, completed: null, quality: null, rework: null, effects: { instructions: null, wiki: null, skillsAgents: null }, rationale: null, backend: null, ...j }) as JudgmentSummary;
/** 依頼の判定(扱いだけ意味を持つ) */
const verdict = (turn: number, outcome: (typeof OUTCOMES)[number]): [number, number, number, null, number, number] => [turn, 0, OUTCOMES.indexOf(outcome), null, -1, 90];

describe('モデルと推論強度の効果', () => {
  it('セッションの効果はリクエストの割合で按分し、コストは実数を足す', () => {
    // 1 セッションで m の low を 1 回、high を 3 回。達成・品質 4・人手工数 2 時間
    const s = sess(
      's1',
      { m: { low: [1, 100, 10, 1e9], high: [3, 300, 30, 6e9] } },
      {
        judgment: judged({ completed: true, quality: 4, rework: 1, hours: 2 }),
        turnVerdicts: [verdict(0, 'as_is'), verdict(1, 'rejected'), verdict(2, 'fix_content'), verdict(3, 'unknown')],
        tools: { total: 8, byName: {}, internal: 0, mcp: {}, issues: {}, durations: {}, outliers: {} },
        friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 2, subagentFailures: 0 },
      },
    );
    const [high, low] = modelValue([s], true).filter((r) => r.model === 'm').sort((a, b) => b.requests - a.requests);
    expect([low.effort, high.effort]).toEqual(['low', 'high']);
    expect(low.weight).toBeCloseTo(0.25);
    expect(high.weight).toBeCloseTo(0.75);
    expect([high.requests, high.nanoAiu, high.judgedNanoAiu]).toEqual([3, 6e9, 6e9]);
    expect(high.hours.sum).toBeCloseTo(1.5);
    // 割合・平均は按分しても元の値のまま
    expect(mean(high.quality)).toBeCloseTo(4);
    expect(mean(low.completed)).toBeCloseTo(1);
    // 依頼の判定: 判定不能を除く 3 件のうち採用 2・そのまま 1・使えなかった 1
    expect(ratio(high.turns.adopted, high.turns.judged)).toBeCloseTo(2 / 3);
    expect(ratio(high.turns.asIs, high.turns.judged)).toBeCloseTo(1 / 3);
    expect(ratio(high.tools.failures, high.tools.calls)).toBeCloseTo(0.25);
    // モデルごとにまとめると 1 行(重み 1)
    const [m] = modelValue([s], false);
    expect(m).toMatchObject({ model: 'm', sessions: 1, requests: 4, nanoAiu: 7e9 });
    expect(m.effort).toBeUndefined();
    expect(m.weight).toBeCloseTo(1);
  });

  it('確信度の低い推定(0.3 以下)は人手工数とその分母の AIU に入れない(達成・品質は入れる)', () => {
    const sure = sess('sure', { m: { high: [2, 0, 0, 4e9] } }, { judgment: judged({ completed: true, quality: 4, hours: 3, confidence: 0.8 }) });
    const unsure = sess('unsure', { m: { high: [2, 0, 0, 6e9] } }, { judgment: judged({ completed: true, quality: 2, hours: 2500, confidence: 0.2 }) });
    const [m] = modelValue([sure, unsure], false);
    expect(m.hours).toEqual({ sum: 3, weight: 1 });
    expect(m.judgedNanoAiu).toBe(4e9);
    expect(m.nanoAiu).toBe(10e9);
    expect(mean(m.quality)).toBeCloseTo(3);
    expect(m.completed.weight).toBe(2);
  });

  it('並びはリクエストの多いモデルから、同じモデルは強度の順(記録なしは最後)。強度の内訳が無いセッションはモデル別の記録から「強度の記録なし」にする', () => {
    const old = sess('old', {}, { byModel: { a: { input: 10, output: 1, cacheRead: null, premiumRequests: null, requests: 2 } } });
    const rows = modelValue([sess('x', { a: { high: [1, 0, 0, 0], low: [1, 0, 0, 0] }, b: { medium: [9, 0, 0, 0] } }), old], true);
    expect(rows.map((r) => [r.model, r.effort])).toEqual([
      ['b', 'medium'],
      ['a', 'low'],
      ['a', 'high'],
      ['a', null],
    ]);
    // リクエストの記録が無いセッションは数えない
    expect(modelValue([sess('none', {})], true)).toEqual([]);
  });

  it('読み取り: 件数の足りる強度が 2 つ以上あるモデルだけ、弱い強度と強い強度を比べる', () => {
    const kept = (n: number) => ({ retention: { outcome: 'measured', hunks: [n, 0, 10 - n, 0] } }) as Partial<SessionSummary>;
    const lows = Array.from({ length: 3 }, (_, i) => sess(`l${i}`, { m: { low: [2, 0, 0, 2e9] } }, { judgment: judged({ completed: i < 2, hours: 1 }), ...kept(10) }));
    const highs = Array.from({ length: 3 }, (_, i) => sess(`h${i}`, { m: { high: [2, 0, 0, 6e9] } }, { judgment: judged({ completed: true, hours: 3 }) }));
    // high の残存は、ほかのモデルが 9 割のセッション 1 件だけ(按分して 0.1 件分)なので、残っている割合は比べない
    highs.push(sess('mix', { m: { high: [1, 0, 0, 1e9] }, z: { medium: [9, 0, 0, 0] } }, kept(0)));
    // n は 2 件しか無いので比べない
    const few = Array.from({ length: 2 }, (_, i) => sess(`n${i}`, { n: { low: [1, 0, 0, 1e9], high: [1, 0, 0, 1e9] } }));
    const all = [...lows, ...highs, ...few];
    const f = effortFindings(modelValue(all, true), modelValue(all, false));
    expect(f[0]).toBe('m: high は low に比べて、1 リクエストの AIU が 2.71 倍、達成率 67% → 100%、ツール失敗率 0% → 0%(セッション 3 件 / 4 件)。');
    expect(f).toHaveLength(1);
  });

  it('残存: まとまりの単位で、残っている(そのまま + 直されて)÷ 照合できたまとまり(照合不可を除く)。照合できたセッションの数と AI の変更があったセッションの数も持つ', () => {
    const ret = (outcome: string, hunks: number[]) => ({ retention: { outcome, hunks, lines: [100, 100, 100, 100] } }) as Partial<SessionSummary>;
    const all = [
      sess('a', { m: { low: [1, 0, 0, 0] } }, ret('measured', [2, 1, 1, 6])),
      sess('b', { m: { low: [1, 0, 0, 0] } }, ret('measured', [0, 0, 4, 0])),
      sess('c', { m: { low: [1, 0, 0, 0] } }, ret('unattributable', [0, 0, 0, 5])),
      sess('d', { m: { low: [1, 0, 0, 0] } }, ret('none', [0, 0, 0, 0])),
      sess('e', { m: { low: [1, 0, 0, 0] } }),
    ];
    const [r] = modelValue(all, true);
    // 照合不可(6)は分母に入れず、行の数(lines)ではなくまとまりの数を使う
    expect(r.retention).toEqual({ measured: 8, kept: 3, weight: 2, sessions: 2, withAi: 3 });
    // 照合できたセッションが 2 件(RETENTION_MIN_SESSIONS 未満)なので割合は出さない
    expect(keptShare(r)).toBeNull();
    // 残存の節・「比べる」と同じ閾値。1 件足りなければ出さず、届けば出す
    const more = (n: number) => Array.from({ length: n }, (_, i) => sess(`f${i}`, { m: { low: [1, 0, 0, 0] } }, ret('measured', [1, 1, 0, 0])));
    const [r4] = modelValue([...all, ...more(RETENTION_MIN_SESSIONS - 3)], true);
    expect(r4.retention.sessions).toBe(RETENTION_MIN_SESSIONS - 1);
    expect(keptShare(r4)).toBeNull();
    const [r5] = modelValue([...all, ...more(RETENTION_MIN_SESSIONS - 2)], true);
    expect(r5.retention.sessions).toBe(RETENTION_MIN_SESSIONS);
    expect(keptShare(r5)).toBeCloseTo(9 / 14);
  });

  it('読み取り: 照合できたセッションが両方の強度で足りれば、残っている割合を比べる', () => {
    const ret = (hunks: number[]) => ({ retention: { outcome: 'measured', hunks } }) as Partial<SessionSummary>;
    const N = RETENTION_MIN_SESSIONS;
    const lows = Array.from({ length: N }, (_, i) => sess(`l${i}`, { m: { low: [1, 0, 0, 0] } }, ret([1, 0, 1, 0])));
    const highs = Array.from({ length: N }, (_, i) => sess(`h${i}`, { m: { high: [1, 0, 0, 0] } }, ret([1, 1, 0, 3])));
    const f = effortFindings(modelValue([...lows, ...highs], true));
    expect(f).toEqual([`m: high は low に比べて、残っている割合 50% → 100%、ツール失敗率 0% → 0%(セッション ${N} 件 / ${N} 件)。`]);
    // 片方の強度で照合できたセッションが足りなければ、残っている割合は比べない
    const few = effortFindings(modelValue([...lows, ...highs.slice(0, N - 1)], true));
    expect(few.join('')).not.toContain('残っている割合');
  });
});
