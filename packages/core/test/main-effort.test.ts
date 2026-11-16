// セッションの本体の (モデル, 推論強度) の決め方(main-effort.ts)と、sessions.csv の「利用者」「本体のモデル」「本体の推論強度」の列。中身はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { mainEffortCell, mainEffortOf, mainModelCell } from '../src/main-effort.ts';
import { normalizeSession } from '../src/normalize.ts';
import { sessionsTable } from '../src/tables.ts';
import type { CopilotEvent, EffortStat } from '../src/types.ts';

const stat = (n: number): EffortStat => ({ requests: n, input: 0, output: 0, nanoAiu: 0 });
const map = (rows: [string, string, number][]): Record<string, Record<string, EffortStat>> => {
  const m: Record<string, Record<string, EffortStat>> = {};
  for (const [model, e, n] of rows) (m[model] ??= {})[e] = stat(n);
  return m;
};

describe('mainEffortOf', () => {
  it('本体のリクエストの 90% 以上が同じ組なら、その組に決める', () => {
    // 9 / 10 = 90% はちょうど届く
    expect(
      mainEffortOf(
        map([
          ['m', 'xhigh', 9],
          ['m', 'medium', 1],
        ]),
      ),
    ).toEqual({ kind: 'decided', model: 'm', effort: 'xhigh' });
    // 8 / 10 は届かない(モデルが違う組も分母に入る)
    expect(
      mainEffortOf(
        map([
          ['m', 'xhigh', 8],
          ['n', 'xhigh', 2],
        ]),
      ),
    ).toEqual({ kind: 'mixed' });
    // いちばん多い組の強度が不明なら、記録なし
    expect(mainEffortOf(map([['m', '(unknown)', 10]]))).toEqual({ kind: 'none' });
    expect(mainEffortOf(map([]))).toEqual({ kind: 'none' });
    expect(mainEffortOf(map([['m', 'low', 0]]))).toEqual({ kind: 'none' });
    expect(mainEffortOf(undefined)).toEqual({ kind: 'none' });
    expect(mainEffortCell({ kind: 'mixed' })).toBe('混在');
    expect(mainEffortCell({ kind: 'none' })).toBe('記録なし');
    expect(mainModelCell({ kind: 'none' })).toBe('');
  });
});

describe('sessions.csv の本体の推論強度の列', () => {
  const T0 = Date.parse('2026-11-06T00:00:00.000Z');
  const ev = (dt: number, type: string, data: Record<string, unknown>, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString(), ...extra });
  const ur = (dt: number, model: string, effort: string, agentId?: string): CopilotEvent =>
    ev(dt, 'session.usage_record', { usage: { model, reasoningEffort: effort, inputTokens: 10, outputTokens: 1 } }, agentId ? { agentId } : {});

  it('利用者はブランチの後、本体のモデルと本体の推論強度はモデルの後。サブエージェントの強度は数えない', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [ev(0, 'user.message', { content: '作って' }), ur(1000, 'm1', 'medium'), ur(2000, 'm1', 'low', 'a1'), ur(3000, 'm1', 'low', 'a1'), ur(4000, 'm1', 'low', 'a1')],
    });
    r.person = 'zz';
    const t = sessionsTable([r]);
    const col = (h: string) => t.rows[0][t.header.indexOf(h)];
    expect(t.header.slice(t.header.indexOf('ブランチ'), t.header.indexOf('ブランチ') + 2)).toEqual(['ブランチ', '利用者']);
    expect(t.header.slice(t.header.indexOf('モデル'), t.header.indexOf('モデル') + 3)).toEqual(['モデル', '本体のモデル', '本体の推論強度']);
    expect([col('利用者'), col('本体のモデル'), col('本体の推論強度')]).toEqual(['zz', 'm1', 'medium']);

    // 本体のリクエストが割れていれば混在、記録が無ければ(古い sessions.json)記録なし。利用者が無ければ空
    const mixed = await normalizeSession({ id: 'x', events: [ev(0, 'user.message', { content: 'a' }), ur(1000, 'm1', 'medium'), ur(2000, 'm1', 'high')] });
    delete r.exec.mainModelEfforts;
    const t2 = sessionsTable([mixed, r]);
    const cells = t2.rows.map((row) => [row[t2.header.indexOf('利用者')], row[t2.header.indexOf('本体のモデル')], row[t2.header.indexOf('本体の推論強度')]]);
    expect(cells).toEqual([
      ['', '', '混在'],
      ['zz', '', '記録なし'],
    ]);
  });
});
