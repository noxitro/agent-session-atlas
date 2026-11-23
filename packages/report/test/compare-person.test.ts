// 「比べる」のモデルどうし・wiki の参照と、人ごとの差(lib/compare.ts・lib/compare-person.ts)。値・名前はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { COMPARE_MIN_SESSIONS, defaultModels, modelChoices, modelEffortChoices, modelSplit, wikiSplit, type CompareSession } from '../src/lib/compare.ts';
import { hasPersons, pairedMean, PERSON_ROW_KEYS, personPhasePaired, personSessionPaired, t975Int } from '../src/lib/compare-person.ts';
import { PHASES, REQUEST_KINDS } from '../src/shared/turns.ts';
import type { TurnTuple } from '../src/lib/turns.ts';

/** 依頼の行(工程・種類だけを決める。ほかは 0。実働は 1 秒) */
const turn = (kind: (typeof REQUEST_KINDS)[number], phase: (typeof PHASES)[number] = 'implement'): TurnTuple => [PHASES.indexOf(phase), REQUEST_KINDS.indexOf(kind), null, 1000, 1, 0, 0, 0, 0, 0, 0, 0, null, 0, 1];
const clean = [turn('task'), turn('task')];
const fixed = [turn('task'), turn('fix')];

const s = (id: string, o: Partial<CompareSession> = {}): CompareSession =>
  ({
    id,
    turns: 2,
    activeMs: 60_000,
    tools: { total: 10 },
    friction: { toolFailures: 1 },
    analysis: { filesReedited: 0, extraEdits: 0, maxConsecutiveFailures: 0, turns: 2 },
    tokens: { nanoAiu: 2e9, requests: 4 },
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: null,
    project: 'p',
    person: null,
    models: ['m'],
    turnRows: clean,
    ...o,
  }) as unknown as CompareSession;

const main = (rows: Record<string, Record<string, number>>) => ({ mainModelEfforts: rows });

describe('モデルどうし', () => {
  const list = [
    s('a1', { exec: main({ ma: { medium: 10 } }) }),
    s('a2', { exec: main({ ma: { xhigh: 9, medium: 1 } }) }),
    s('b1', { exec: main({ mb: { medium: 10 } }) }),
    // 同じモデルでも強度が半々なら混在(本体のモデルは (モデル, 強度) の組で決める)
    s('mix', { exec: main({ ma: { medium: 5, xhigh: 5 } }) }),
    // 強度が不明なら記録なし。本体のリクエストの記録が無いセッションは、モデルの一覧で A・B のモデルのものだけ数える
    s('unknown', { exec: main({ mb: { '(unknown)': 4 } }) }),
    s('none-a', { models: ['ma'] }),
    s('none-other', { models: ['mc'] }),
    s('other', { exec: main({ mc: { medium: 10 } }) }),
    s('late', { exec: main({ ma: { medium: 10 } }), createdAt: '2026-12-20T10:00:00.000Z' }),
  ];

  it('modelChoices と defaultModels: 本体と決まったセッションの多い順', () => {
    expect(modelChoices(list)).toEqual([
      { model: 'ma', sessions: 3 },
      { model: 'mb', sessions: 1 },
      { model: 'mc', sessions: 1 },
    ]);
    expect(defaultModels(modelChoices(list))).toEqual(['ma', 'mb']);
    expect(defaultModels([{ model: 'only' }])).toEqual(['only', 'only']);
    expect(defaultModels([])).toEqual(['', '']);
  });

  it('modelSplit: 強度がすべてなら決まった強度を問わず、混在・記録なしは A か B のモデルのものだけ数える', () => {
    const r = modelSplit(list, 'ma', 'mb', '', '', '');
    expect(r.a.map((x) => x.id)).toEqual(['a1', 'a2', 'late']);
    expect(r.b.map((x) => x.id)).toEqual(['b1']);
    expect(r.mixed).toBe(1);
    expect(r.none).toBe(2);
    // 期間は両側に同じ期間
    expect(modelSplit(list, 'ma', 'mb', '', '2026-11-01', '2026-11-30').a.map((x) => x.id)).toEqual(['a1', 'a2']);
    // 強度をそろえると、その強度と決まったセッションだけ
    const m = modelSplit(list, 'ma', 'mb', 'medium', '', '');
    expect(m.a.map((x) => x.id)).toEqual(['a1', 'late']);
    expect(m.b.map((x) => x.id)).toEqual(['b1']);
    // 同じモデルなら両側に同じセッション
    const same = modelSplit(list, 'ma', 'ma', '', '', '');
    expect(same.a).toEqual(same.b);
  });

  it('modelEffortChoices: A と B のモデルの、本体がその強度と決まったセッションの数(強度の順)', () => {
    expect(modelEffortChoices(list, 'ma', 'mb')).toEqual([
      { effort: 'medium', a: 2, b: 1 },
      { effort: 'xhigh', a: 1, b: 0 },
    ]);
  });
});

describe('wiki の参照', () => {
  it('wikiSplit: A は参照したセッション(索引・ページ・skill・そのほかの呼び出し)、B はそれ以外(書き込みだけも B)', () => {
    const w = (o: Partial<NonNullable<CompareSession['wiki']>>) => ({ indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0, otherCalls: 0, pages: [], ...o });
    const list = [
      s('idx', { wiki: w({ indexReads: 1 }) }),
      s('other', { wiki: w({ otherCalls: 2 }) }),
      s('write', { wiki: w({ writes: 3 }) }),
      s('none'),
      s('old', { wiki: w({ pageReads: 1 }), createdAt: '2026-10-01T10:00:00.000Z' }),
    ];
    const r = wikiSplit(list, '', '');
    expect(r.a.map((x) => x.id)).toEqual(['idx', 'other', 'old']);
    expect(r.b.map((x) => x.id)).toEqual(['write', 'none']);
    expect(wikiSplit(list, '2026-11-01', '').a.map((x) => x.id)).toEqual(['idx', 'other']);
  });
});

describe('人ごとの差', () => {
  it('t975Int: 自由度 1〜3 は表の値、4 以上は近似(どちらも t 分布の表と 0.002 以内)', () => {
    expect(t975Int(1)).toBeCloseTo(12.706, 3);
    expect(t975Int(2)).toBeCloseTo(4.303, 3);
    expect(t975Int(3)).toBeCloseTo(3.182, 3);
    expect(Math.abs(t975Int(4) - 2.776)).toBeLessThan(0.002);
  });

  it('pairedMean: 平均 ± t × 標準偏差 ÷ √人数(手計算: 差 0.1・0.3 は平均 0.2、標準偏差 √0.02、t は自由度 1 の 12.706)', () => {
    const r = pairedMean([0.1, 0.3]);
    expect(r.mean).toBeCloseTo(0.2, 10);
    const half = 12.7062 * (Math.sqrt(0.02) / Math.sqrt(2));
    expect(r.ci![0]).toBeCloseTo(0.2 - half, 6);
    expect(r.ci![1]).toBeCloseTo(0.2 + half, 6);
    // 1 人だけなら平均だけ、幅は出さない。0 人なら平均も出さない
    expect(pairedMean([0.4])).toEqual({ mean: 0.4, ci: null });
    expect(pairedMean([])).toEqual({ mean: null, ci: null });
    // ばらつきが無ければ、幅は平均そのもの
    expect(pairedMean([0.5, 0.5, 0.5]).ci).toEqual([0.5, 0.5]);
  });

  it('hasPersons: 記録のある人が 2 人以上', () => {
    expect(hasPersons([s('1', { person: 'zz-a' }), s('2', { person: 'zz-a' }), s('3')])).toBe(false);
    expect(hasPersons([s('1', { person: 'zz-a' }), s('2', { person: 'zz-b' })])).toBe(true);
  });

  /** その人の A と B: 手戻りのないセッションを A に ca 件 / na 件、B に cb 件 / nb 件 */
  function sides(person: string | null, na: number, ca: number, nb: number, cb: number): { a: CompareSession[]; b: CompareSession[] } {
    const mk = (side: string, n: number, c: number) => Array.from({ length: n }, (_, i) => s(`${person}-${side}${i}`, { person, turnRows: i < c ? clean : fixed }));
    return { a: mk('a', na, ca), b: mk('b', nb, cb) };
  }

  it('personSessionPaired: 両方の側に 5 件以上ある人だけで、人ごとの差を平均し、人を単位にした幅を出す', () => {
    // zz-a: 5/10 → 8/10(+0.3)、zz-b: 2/5 → 3/5(+0.2)、zz-c は B が 4 件で使えない、人の記録なしは入れない
    const pa = sides('zz-a', 10, 5, 10, 8);
    const pb = sides('zz-b', 5, 2, 5, 3);
    const pc = sides('zz-c', 6, 6, 4, 0);
    const pn = sides(null, 3, 0, 2, 2);
    const r = personSessionPaired([...pa.a, ...pb.a, ...pc.a, ...pn.a], [...pa.b, ...pb.b, ...pc.b, ...pn.b]);
    expect(r.groups.map((g) => [g.person, g.a, g.b, g.eligible])).toEqual([
      ['zz-a', 10, 10, true],
      ['zz-b', 5, 5, true],
      ['zz-c', 6, 4, false],
    ]);
    expect(r.eligible).toBe(2);
    expect(r.unassigned).toEqual({ a: 3, b: 2 });
    expect(r.unit).toBe('session');
    expect(r.rows.map((x) => x.key)).toEqual([...PERSON_ROW_KEYS]);
    const nr = r.rows.find((x) => x.key === 'no-rework')!;
    expect(nr.persons).toBe(2);
    expect(nr.diffs[0]).toBeCloseTo(0.3, 10);
    expect(nr.diffs[1]).toBeCloseTo(0.2, 10);
    expect(nr.diffs[2]).toBeNull();
    expect(nr.mean).toBeCloseTo(0.25, 10);
    const half = t975Int(1) * (Math.sqrt(0.005) / Math.sqrt(2));
    expect(nr.ci![0]).toBeCloseTo(0.25 - half, 6);
    expect(nr.ci![1]).toBeCloseTo(0.25 + half, 6);
    // テストの記録が無いので、テストの行は誰も値が出ない(差を出せた人 0)
    expect(r.rows.find((x) => x.key === 'tests-first-pass')).toMatchObject({ persons: 0, mean: null, ci: null });
    // 残存は別に出す(照合していないので誰も値が出ない)
    expect(r.retention).toMatchObject({ key: 'retention-kept', persons: 0, mean: null });
  });

  it('使える人が 2 人未満なら幅を出さない', () => {
    const pa = sides('zz-a', COMPARE_MIN_SESSIONS, 2, COMPARE_MIN_SESSIONS, 4);
    const pb = sides('zz-b', COMPARE_MIN_SESSIONS - 1, 0, COMPARE_MIN_SESSIONS, 5);
    const r = personSessionPaired([...pa.a, ...pb.a], [...pa.b, ...pb.b]);
    expect(r.eligible).toBe(1);
    const nr = r.rows.find((x) => x.key === 'no-rework')!;
    expect(nr.persons).toBe(1);
    expect(nr.mean).toBeCloseTo(0.4, 10);
    expect(nr.ci).toBeNull();
  });

  it('残存は照合できたセッションを人ごとに数え、照合できたセッションが両側に 5 件以上の人だけで差を出す', () => {
    const ret = (kept: number, missing: number) => ({ outcome: 'measured', hunks: [kept, 0, missing, 0], lines: [kept, 0, missing, 0], lag: 1 });
    const mk = (person: string, side: string, n: number, kept: number) => Array.from({ length: n }, (_, i) => s(`${person}-${side}${i}`, { person, retention: ret(kept, 4 - kept) as unknown as CompareSession['retention'] }));
    const r = personSessionPaired([...mk('zz-a', 'a', 5, 1), ...mk('zz-b', 'a', 5, 2)], [...mk('zz-a', 'b', 5, 3), ...mk('zz-b', 'b', 5, 2)]);
    expect(r.groups.map((g) => [g.measuredA, g.measuredB])).toEqual([
      [5, 5],
      [5, 5],
    ]);
    expect(r.retention!.persons).toBe(2);
    expect(r.retention!.diffs[0]).toBeCloseTo(0.5, 10);
    expect(r.retention!.diffs[1]).toBeCloseTo(0, 10);
    expect(r.retention!.mean).toBeCloseTo(0.25, 10);
    // ほかの行には混ぜない
    expect(r.rows.some((x) => x.key.startsWith('retention'))).toBe(false);
  });

  it('personPhasePaired: 工程どうしは依頼の単位で、両方の工程に依頼が 5 件以上ある人だけ', () => {
    const rows = (impl: number, research: number, fixAfterImpl: boolean) => [
      ...Array.from({ length: impl }, () => turn('task', 'implement')),
      ...Array.from({ length: research }, () => turn('task', 'research')),
      ...(fixAfterImpl ? [turn('fix', 'implement')] : []),
    ];
    const list = [s('a', { person: 'zz-a', turnRows: rows(5, 5, false) }), s('b', { person: 'zz-b', turnRows: rows(5, 3, false) }), s('n', { turnRows: rows(2, 2, false) })];
    const r = personPhasePaired(list, 'implement', 'research');
    expect(r.unit).toBe('turn');
    expect(r.groups.map((g) => [g.person, g.a, g.b, g.eligible])).toEqual([
      ['zz-a', 5, 5, true],
      ['zz-b', 5, 3, false],
    ]);
    expect(r.unassigned).toEqual({ a: 2, b: 2 });
    expect(r.rows.map((x) => x.key)).toEqual(['active', 'failure', 'stuck', 'fix', 'aiu']);
  });
});
