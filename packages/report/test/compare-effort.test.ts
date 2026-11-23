// 「比べる」の推論強度どうしの比較・手戻りのないセッション・差の幅(lib/compare.ts・lib/main-effort.ts)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import {
  compareRows,
  compareSide,
  defaultEfforts,
  effortChoices,
  effortModels,
  effortSplit,
  newcombeDiff,
  reworkOfTurns,
  t975,
  weekStart,
  welchDiff,
  wilson,
  type CompareSession,
} from '../src/lib/compare.ts';
import { MAIN_EFFORT_SHARE, mainEffortOf } from '../src/lib/main-effort.ts';
import { PHASES, REQUEST_KINDS } from '../src/shared/turns.ts';
import type { TurnTuple } from '../src/lib/turns.ts';

/** 依頼の行(種類と中断だけを決める。ほかは 0) */
const turn = (kind: (typeof REQUEST_KINDS)[number], aborts = 0): TurnTuple => [PHASES.indexOf('implement'), REQUEST_KINDS.indexOf(kind), null, 1000, 1, 0, 0, aborts, 0, 0, 0, 0, null, 0, 1];

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
    expect(mainEffortOf({ m: { xhigh: 9, medium: 1 } })).toEqual({ kind: 'decided', model: 'm', effort: 'xhigh' });
    // モデルが違う組も分母に入る(8 / 10 は届かない)
    expect(mainEffortOf({ m: { xhigh: 8 }, n: { xhigh: 2 } })).toEqual({ kind: 'mixed' });
    expect(mainEffortOf({ m: { '(unknown)': 10 } })).toEqual({ kind: 'none' });
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

  it('t975: t 分布の 97.5% の点(表の値: 自由度 4 は 2.776、10 は 2.228、30 は 2.042。大きい自由度では 1.96 に近づく)', () => {
    expect(Math.abs(t975(4) - 2.776)).toBeLessThan(0.002);
    expect(Math.abs(t975(10) - 2.228)).toBeLessThan(0.001);
    expect(Math.abs(t975(30) - 2.042)).toBeLessThan(0.001);
    expect(Math.abs(t975(1e6) - 1.96)).toBeLessThan(0.001);
  });

  it('welchDiff: 平均の差 ± t × 標準誤差(手計算: [1,2,3] と [2,4,6] は標準誤差 √(1/3 + 4/3)、自由度 (5/3)² ÷ ((1/3)²/2 + (4/3)²/2) = 50/17)', () => {
    const [lo, hi] = welchDiff([1, 2, 3], [2, 4, 6])!;
    const se = Math.sqrt(1 / 3 + 4 / 3);
    const t = t975(50 / 17);
    expect(lo).toBeCloseTo(2 - t * se, 10);
    expect(hi).toBeCloseTo(2 + t * se, 10);
    // 件数が少ないので、1.96 で作る幅より広い
    expect(t).toBeGreaterThan(2.5);
    // 5 件ずつで同じばらつきなら自由度は 8(t は 2.306)
    const [l5, h5] = welchDiff([1, 2, 3, 4, 5], [3, 4, 5, 6, 7])!;
    expect((h5 - l5) / 2 / Math.sqrt(2.5 / 5 + 2.5 / 5)).toBeCloseTo(2.306, 2);
    // どちらもばらつきが無ければ、幅は差そのもの
    expect(welchDiff([2, 2], [5, 5])).toEqual([3, 3]);
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
    const rows = compareRows(compareSide(A), compareSide(B), { byTurnCount: true });
    const r = (k: string) => rows.find((x) => x.key === k)!;
    // 依頼の数で分けた 2 行は、頼んだとき(推論強度どうしの比較)だけ出す
    expect(compareRows(compareSide(A), compareSide(B)).map((x) => x.key).filter((k) => k.startsWith('no-rework'))).toEqual(['no-rework']);
    expect(rows.map((x) => x.key).filter((k) => k.startsWith('no-rework'))).toEqual(['no-rework', 'no-rework-short', 'no-rework-long']);
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
    // AIU / リクエストは、両方の記録があるセッションが 5 件未満なら —(AIU の記録だけが 5 件あっても出さない)
    const noReq = A.map((x, i) => (i === 0 ? x : { ...x, tokens: { ...x.tokens, requests: null } }));
    const one = compareRows(compareSide(noReq), compareSide(B));
    expect(one.find((x) => x.key === 'aiu')!.a).toBe(3);
    expect(one.find((x) => x.key === 'aiu-per-request')).toMatchObject({ a: null, b: 30 / 20 });
  });

  it('テストの結果: テストを実行したセッションを分母に、最初の実行で全部通った割合と、最後に通っていないテストが残った割合。幅は Newcombe', () => {
    const tests = (firstPass: number | null, lastFailing: number): Partial<CompareSession> => ({ tests: { runs: 3, firstPass, lastFailing, passActiveMs: null, passNanoAiu: null, lastNanoAiu: null } });
    // A: 実行したセッション 6 件(最初に通った 3・2 回目で通った 1・未達 2)と、記録なし 4 件(分母に入れない)
    const A = [
      ...[1, 1, 1].map((f, i) => s(`a-first${i}`, tests(f, 0))),
      s('a-second', tests(2, 0)),
      s('a-never0', tests(null, 2)),
      s('a-never1', tests(null, 1)),
      ...Array.from({ length: 4 }, (_, i) => s(`a-none${i}`)),
    ];
    // B: 実行したセッション 5 件(最初に通った 4・通った後に不合格 1)
    const B = [...Array.from({ length: 4 }, (_, i) => s(`b-first${i}`, tests(1, 0))), s('b-regress', tests(1, 3))];
    const rows = compareRows(compareSide(A), compareSide(B));
    const r = (k: string) => rows.find((x) => x.key === k)!;
    expect(r('tests-first-pass')).toMatchObject({ unit: 'rate', a: 3 / 6, b: 5 / 5 });
    expect(r('tests-last-failing')).toMatchObject({ unit: 'rate', a: 2 / 6, b: 1 / 5 });
    expect(r('tests-first-pass').ci).toEqual(newcombeDiff(3, 6, 5, 5));
    expect(r('tests-last-failing').ci).toEqual(newcombeDiff(2, 6, 1, 5));
    // テストを実行したセッションが 5 件未満の側は —(幅も —)。セッション自体は 5 件以上あっても、割る数で決める
    const few = compareRows(compareSide(A), compareSide(B.slice(0, 4).concat(s('b-none'))));
    expect(few.find((x) => x.key === 'tests-first-pass')).toMatchObject({ a: 0.5, b: null, ci: null });
    expect(few.find((x) => x.key === 'tests-last-failing')).toMatchObject({ a: 2 / 6, b: null, ci: null });
  });
});

describe('推論強度どうしの母集団と、利用者 × 週', () => {
  const main = (rows: Record<string, Record<string, number>>) => ({ mainModelEfforts: rows });
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
    // A と B に同じ強度を選ぶと、両側に同じセッションが入る(B だけ空にしない)
    const same = effortSplit(list, 'm', 'xhigh', 'xhigh', '', '');
    expect([same.a.map((x) => x.id), same.b.map((x) => x.id)]).toEqual([['x1', 'x2'], ['x1', 'x2']]);
    expect(same.weeks.filter((w) => w.person === 'zz-b').map((w) => [w.a, w.b])).toEqual([[1, 1], [1, 1]]);
  });

  it('effortSplit の weeks: 利用者 × 週(月曜始まり)。利用者の記録が無ければ週だけ。件数は母集団と同じ分類から', () => {
    expect(weekStart(Date.parse(local(8, 23)))).toBe('2026-11-02');
    expect(weekStart(Date.parse(local(9, 0)))).toBe('2026-11-09');
    const w = effortSplit(list, 'm', 'medium', 'xhigh', '', '');
    expect(w.byPerson).toBe(true);
    const sum = (k: 'a' | 'b' | 'mixed' | 'none'): number => w.weeks.reduce((n, r) => n + r[k], 0);
    expect([sum('a'), sum('b'), sum('mixed'), sum('none')]).toEqual([w.a.length, w.b.length, w.mixed, w.none]);
    expect(w.weeks).toEqual([
      { person: 'zz-a', week: '2026-11-02', a: 2, b: 0, mixed: 0, none: 0 },
      { person: 'zz-a', week: '2026-11-09', a: 0, b: 0, mixed: 1, none: 0 },
      // high のセッション(zz-b の 11-02 の週)は A・B・混在・記録なしのどれにも数えない
      { person: 'zz-b', week: '2026-11-02', a: 0, b: 1, mixed: 0, none: 0 },
      { person: 'zz-b', week: '2026-11-09', a: 0, b: 1, mixed: 0, none: 0 },
      { person: null, week: '2026-11-02', a: 0, b: 0, mixed: 0, none: 1 },
    ]);
    const anon = effortSplit(
      list.map((x) => ({ ...x, person: null })),
      'm',
      'medium',
      'xhigh',
      '',
      '',
    );
    expect(anon.byPerson).toBe(false);
    expect(anon.weeks).toEqual([
      { person: null, week: '2026-11-02', a: 2, b: 1, mixed: 0, none: 1 },
      { person: null, week: '2026-11-09', a: 0, b: 1, mixed: 1, none: 0 },
    ]);
  });
});
