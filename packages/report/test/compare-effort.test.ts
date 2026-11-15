// 「比べる」の推論強度どうしの比較・手戻りのないセッション・差の幅(lib/compare.ts・lib/main-effort.ts)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import {
  compareRows,
  compareSide,
  defaultEfforts,
  effortChoices,
  effortModels,
  effortSplit,
  effortWeeks,
  newcombeDiff,
  reworkOfTurns,
  weekStart,
  welchDiff,
  wilson,
  type CompareSession,
} from '../src/lib/compare.ts';
import { MAIN_EFFORT_SHARE, mainEffortOf } from '../src/lib/main-effort.ts';
import { PHASES, REQUEST_KINDS } from '../src/shared/turns.ts';
import type { TurnTuple } from '../src/lib/turns.ts';
import type { EffortTuple } from '../src/lib/types.ts';

/** 依頼の行(種類と中断だけを決める。ほかは 0) */
const turn = (kind: (typeof REQUEST_KINDS)[number], aborts = 0): TurnTuple => [PHASES.indexOf('implement'), REQUEST_KINDS.indexOf(kind), null, 1000, 1, 0, 0, aborts, 0, 0, 0, 0, null, 0, 1];
const eff = (n: number): EffortTuple => [n, 0, 0, 0];

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
    ...o,
  }) as unknown as CompareSession;

describe('mainEffortOf: 本体の (モデル, 推論強度)', () => {
  it(`本体のリクエストの ${MAIN_EFFORT_SHARE * 100}% 以上が同じ組ならその組、届かなければ混在、記録が無ければ記録なし`, () => {
    expect(MAIN_EFFORT_SHARE).toBe(0.9);
    expect(mainEffortOf({ m: { xhigh: eff(9), medium: eff(1) } })).toEqual({ kind: 'decided', model: 'm', effort: 'xhigh' });
    // モデルが違う組も分母に入る(8 / 10 は届かない)
    expect(mainEffortOf({ m: { xhigh: eff(8) }, n: { xhigh: eff(2) } })).toEqual({ kind: 'mixed' });
    expect(mainEffortOf({ m: { '(unknown)': eff(10) } })).toEqual({ kind: 'none' });
    expect(mainEffortOf({})).toEqual({ kind: 'none' });
    expect(mainEffortOf(undefined)).toEqual({ kind: 'none' });
  });
});

describe('差の幅(95%)', () => {
  it('wilson: 手計算できる例(0 / 4 の上端は z² / (n + z²))と、既知の値(8 / 10)', () => {
    const [lo, hi] = wilson(0, 4)!;
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(3.8416 / 7.8416, 10);
    const w = wilson(8, 10)!;
    expect(w[0]).toBeCloseTo(0.4902, 4);
    expect(w[1]).toBeCloseTo(0.9433, 4);
    expect(wilson(1, 0)).toBeNull();
  });

  it('newcombeDiff: 既知の値(Newcombe 1998 の例 56/70 − 48/80 は 0.0524〜0.3339)と、10 件中 8 件 対 10 件中 5 件', () => {
    const [lo, hi] = newcombeDiff(48, 80, 56, 70)!;
    expect(lo).toBeCloseTo(0.0524, 4);
    expect(hi).toBeCloseTo(0.3339, 4);
    // B − A = 0.8 − 0.5 = 0.3。幅は Wilson の区間(5/10: 0.2366〜0.7634、8/10: 0.4902〜0.9433)から作る
    const [l2, h2] = newcombeDiff(5, 10, 8, 10)!;
    expect(l2).toBeCloseTo(0.3 - Math.sqrt((0.8 - 0.490157) ** 2 + (0.763410 - 0.5) ** 2), 5);
    expect(h2).toBeCloseTo(0.3 + Math.sqrt((0.943319 - 0.8) ** 2 + (0.5 - 0.236590) ** 2), 5);
    expect(l2).toBeCloseTo(-0.1067, 4);
    expect(h2).toBeCloseTo(0.5999, 4);
    // 0 をまたぐ(この件数では差があるとは言えない)
    expect(l2 < 0 && h2 > 0).toBe(true);
    expect(newcombeDiff(1, 0, 1, 1)).toBeNull();
  });

  it('welchDiff: 平均の差 ± 1.96 × 標準誤差(手計算: [1,2,3] と [2,4,6] は 2 ± 1.96 × √(1/3 + 4/3))', () => {
    const [lo, hi] = welchDiff([1, 2, 3], [2, 4, 6])!;
    const se = Math.sqrt(1 / 3 + 4 / 3);
    expect(lo).toBeCloseTo(2 - 1.96 * se, 10);
    expect(hi).toBeCloseTo(2 + 1.96 * se, 10);
    expect(welchDiff([1], [1, 2])).toBeNull();
  });
});

describe('手戻りのないセッション', () => {
  it('reworkOfTurns: 2 件目以降の直し・差し戻し、どこかの中断があれば手戻りあり。1 件だけは採点できない', () => {
    expect(reworkOfTurns([turn('task'), turn('question')])).toBe(false);
    expect(reworkOfTurns([turn('task'), turn('fix')])).toBe(true);
    expect(reworkOfTurns([turn('task'), turn('continue'), turn('revert')])).toBe(true);
    // 最初の依頼の種類は数えない(前の依頼が無いので直しではない)
    expect(reworkOfTurns([turn('fix'), turn('task')])).toBe(false);
    expect(reworkOfTurns([turn('task', 1), turn('task')])).toBe(true);
    expect(reworkOfTurns([turn('task')])).toBeNull();
    expect(reworkOfTurns(undefined)).toBeNull();
  });

  it('compareRows: 割合は採点できたセッションが 5 件以上のときだけ。依頼 2〜4 件と 5 件以上に分け、幅は Newcombe', () => {
    const clean2 = [turn('task'), turn('task')];
    const fix2 = [turn('task'), turn('fix')];
    const clean5 = Array.from({ length: 5 }, () => turn('task'));
    // A: 10 件中 5 件が手戻りなし(依頼 2 件)、B: 10 件中 8 件(依頼 5 件が 4 件、2 件が 6 件)。1 件だけのセッションは分母に入らない
    const A = [...Array.from({ length: 10 }, (_, i) => s(`a${i}`, { turnRows: i < 5 ? clean2 : fix2 })), s('a-one', { turnRows: [turn('task')] })];
    const B = Array.from({ length: 10 }, (_, i) => s(`b${i}`, { turnRows: i < 4 ? clean5 : i < 8 ? clean2 : fix2 }));
    const rows = compareRows(compareSide(A), compareSide(B));
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('scored')).toMatchObject({ a: 10, b: 10 });
    expect(r('no-rework')).toMatchObject({ a: 0.5, b: 0.8 });
    expect(r('no-rework').ci![0]).toBeCloseTo(-0.1067, 4);
    expect(r('no-rework').ci![1]).toBeCloseTo(0.5999, 4);
    expect(r('no-rework-short')).toMatchObject({ a: 0.5, b: 4 / 6 });
    // B の依頼 5 件以上は 4 件だけなので出さない(幅も —)
    expect(r('no-rework-long')).toMatchObject({ a: null, b: null, ci: null });
    // 件数・比の行には幅を出さない
    expect('ci' in r('scored')).toBe(false);
    expect('ci' in r('aiu-per-request')).toBe(false);
    expect('ci' in r('failure')).toBe(false);
    // 既存の「同じファイルを編集し直した」は別の行のまま
    expect(r('rework').label).toBe('同じファイルを編集し直したセッションの割合');
  });

  it('AIU / リクエスト・リクエスト / セッションと、平均の幅(Welch)', () => {
    const A = Array.from({ length: 5 }, (_, i) => s(`a${i}`, { tokens: { nanoAiu: (i + 1) * 1e9, requests: 2 } as CompareSession['tokens'] }));
    const B = Array.from({ length: 5 }, (_, i) => s(`b${i}`, { tokens: { nanoAiu: (i + 1) * 2e9, requests: 4 } as CompareSession['tokens'] }));
    const rows = compareRows(compareSide(A), compareSide(B));
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('aiu-per-request')).toMatchObject({ a: 15 / 10, b: 30 / 20 });
    expect(r('requests')).toMatchObject({ a: 2, b: 4 });
    // リクエストはどちらもばらつきが無いので、幅は差そのもの
    expect(r('requests').ci).toEqual([2, 2]);
    const w = welchDiff([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])!;
    expect(r('aiu').ci![0]).toBeCloseTo(w[0], 10);
    // 片側が 5 件未満なら —
    const few = compareRows(compareSide(A.slice(0, 4)), compareSide(B));
    expect(few.find((x) => x.key === 'aiu')!.ci).toBeNull();
  });
});

describe('推論強度どうしの母集団と、利用者 × 週', () => {
  const main = (rows: Record<string, Record<string, number>>) => ({ mainModelEfforts: Object.fromEntries(Object.entries(rows).map(([m, by]) => [m, Object.fromEntries(Object.entries(by).map(([e, n]) => [e, eff(n)]))])) });
  // 2026-11-02 は月曜、2026-11-08 は日曜(ローカルの日付で作る)
  const local = (d: number, h = 10) => new Date(2026, 10, d, h).toISOString();
  const list = [
    s('m1', { exec: main({ m: { medium: 10 } }), person: 'zz-a', createdAt: local(2) }),
    s('m2', { exec: main({ m: { medium: 9, xhigh: 1 } }), person: 'zz-a', createdAt: local(8) }),
    s('x1', { exec: main({ m: { xhigh: 5 } }), person: 'zz-b', createdAt: local(3) }),
    s('x2', { exec: main({ m: { xhigh: 5 } }), person: 'zz-b', createdAt: local(10) }),
    s('mix', { exec: main({ m: { medium: 5, xhigh: 5 } }), person: 'zz-a', createdAt: local(9) }),
    // 記録なし: 本体の記録が無く、モデルの一覧に m がある
    s('none', { exec: main({}), person: null, createdAt: local(4) }),
    // 別のモデルのセッションは入れない
    s('other', { exec: main({ n: { xhigh: 3 } }), models: ['n'], person: 'zz-b', createdAt: local(4) }),
    s('high', { exec: main({ m: { high: 3 } }), person: 'zz-b', createdAt: local(4) }),
  ];

  it('effortModels・effortChoices・defaultEfforts', () => {
    expect(effortModels(list)).toEqual([
      { model: 'm', sessions: 6 },
      { model: 'n', sessions: 1 },
    ]);
    expect(effortChoices(list, 'm')).toEqual([
      { effort: 'medium', sessions: 2 },
      { effort: 'high', sessions: 1 },
      { effort: 'xhigh', sessions: 2 },
    ]);
    expect(defaultEfforts(effortChoices(list, 'm'))).toEqual(['medium', 'xhigh']);
    // medium と xhigh が揃わなければ、多い順の 2 つを弱い順に
    expect(defaultEfforts([{ effort: 'xhigh', sessions: 1 }, { effort: 'low', sessions: 3 }, { effort: 'high', sessions: 2 }])).toEqual(['low', 'high']);
    expect(defaultEfforts([])).toEqual(['', '']);
  });

  it('effortSplit: 本体が (モデル, 強度) と決まったセッションだけ。混在と記録なしは数だけ。期間は両方に掛ける', () => {
    const all = effortSplit(list, 'm', 'medium', 'xhigh', '', '');
    expect([all.a.map((x) => x.id), all.b.map((x) => x.id), all.mixed, all.none]).toEqual([['m1', 'm2'], ['x1', 'x2'], 1, 1]);
    const firstWeek = effortSplit(list, 'm', 'medium', 'xhigh', '2026-11-02', '2026-11-08');
    expect([firstWeek.a.map((x) => x.id), firstWeek.b.map((x) => x.id), firstWeek.mixed, firstWeek.none]).toEqual([['m1', 'm2'], ['x1'], 0, 1]);
  });

  it('effortWeeks: 利用者 × 週(月曜始まり)。利用者の記録が無ければ週だけ', () => {
    expect(weekStart(Date.parse(local(8, 23)))).toBe('2026-11-02');
    expect(weekStart(Date.parse(local(9, 0)))).toBe('2026-11-09');
    const w = effortWeeks(list, 'm', 'medium', 'xhigh', '', '');
    expect(w.byPerson).toBe(true);
    expect(w.rows).toEqual([
      { person: 'zz-a', week: '2026-11-02', a: 2, b: 0, mixed: 0, none: 0 },
      { person: 'zz-a', week: '2026-11-09', a: 0, b: 0, mixed: 1, none: 0 },
      // high のセッション(zz-b の 11-02 の週)は A・B・混在・記録なしのどれにも数えない
      { person: 'zz-b', week: '2026-11-02', a: 0, b: 1, mixed: 0, none: 0 },
      { person: 'zz-b', week: '2026-11-09', a: 0, b: 1, mixed: 0, none: 0 },
      { person: null, week: '2026-11-02', a: 0, b: 0, mixed: 0, none: 1 },
    ]);
    const anon = effortWeeks(
      list.map((x) => ({ ...x, person: null })),
      'm',
      'medium',
      'xhigh',
      '',
      '',
    );
    expect(anon.byPerson).toBe(false);
    expect(anon.rows).toEqual([
      { person: null, week: '2026-11-02', a: 2, b: 1, mixed: 0, none: 1 },
      { person: null, week: '2026-11-09', a: 0, b: 1, mixed: 1, none: 0 },
    ]);
  });
});
