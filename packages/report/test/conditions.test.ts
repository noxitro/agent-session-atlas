// 「課題 × 条件」の表(lib/conditions.ts)と、テストの結果の要約(lib/summarize.ts の testsSummary)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { COMPARE_MIN_SESSIONS } from '../src/lib/compare.ts';
import { compareNames, conditionCell, conditionTable, parseConditionTag, untilPass, type ConditionGroup, type ConditionSession } from '../src/lib/conditions.ts';
import { usageCount, usageItems, usageMismatches, usageRows } from '../src/lib/condition-usage.ts';
import { testsSummary } from '../src/lib/summarize.ts';
import type { TestsSummary } from '../src/lib/types.ts';
import type { SessionTests, TestRun } from '../../core/src/types.ts';

const MIN = COMPARE_MIN_SESSIONS;

/** テストの要約: n 回目で通って、最後も通っている */
const pass = (n: number, o: Partial<TestsSummary> = {}): TestsSummary => ({ runs: n, firstPass: n, lastFailing: 0, passActiveMs: n * 60_000, passNanoAiu: n * 1e9, lastNanoAiu: n * 1e9, ...o });
/** 一度も全部通らなかった */
const unreached = (o: Partial<TestsSummary> = {}): TestsSummary => ({ runs: 2, firstPass: null, lastFailing: 1, passActiveMs: null, passNanoAiu: null, lastNanoAiu: 5e9, ...o });

const s = (id: string, tests?: TestsSummary, o: Partial<ConditionSession> = {}): ConditionSession =>
  ({ id, activeMs: 600_000, tools: { total: 10 }, friction: { toolFailures: 1 }, tokens: { nanoAiu: 4e9 }, person: null, ...(tests ? { tests } : {}), ...o }) as unknown as ConditionSession;

const g = (name: string, ids: string[], tag?: string): ConditionGroup => ({ name, presentIds: ids, ...(tag ? { tag } : {}) });

describe('parseConditionTag: タスクタグの名前を課題・条件・番号に分ける', () => {
  it('「課題__条件」と「課題__条件__番号」を受ける(番号は半角の数字だけ。前後の空白は落とす)', () => {
    expect(parseConditionTag('render__wiki')).toEqual({ task: 'render', condition: 'wiki', rep: null });
    expect(parseConditionTag('render__wiki__1')).toEqual({ task: 'render', condition: 'wiki', rep: '1' });
    expect(parseConditionTag(' 描画 の 実装 __ wiki あり __ 007 ')).toEqual({ task: '描画 の 実装', condition: 'wiki あり', rep: '007' });
    // 区切りでない _ と - は名前の一部
    expect(parseConditionTag('Player-Weapon__code_ref__12')).toEqual({ task: 'Player-Weapon', condition: 'code_ref', rep: '12' });
  });
  it('決まりに合わない名前は null(推測で切らない)', () => {
    for (const name of ['render', 'Player-Weapon', 'render__', '__wiki', 'render____1', 'a__b__c__1', 'render__wiki__v2', 'render__wiki__１', 'render__wiki__', 'a___b', 'a__b_', '', '  ']) {
      expect(parseConditionTag(name), name).toBeNull();
    }
  });
  it('大文字小文字・全角半角はそろえない(別の名前)', () => {
    expect(parseConditionTag('Render__Wiki')).toEqual({ task: 'Render', condition: 'Wiki', rep: null });
  });
});

describe('untilPass: 未達を最後に並べた中央値', () => {
  it(`母数が ${MIN} 件未満なら null(件数は返す)`, () => {
    expect(untilPass([1, 2, 3, 4], MIN - 1)).toEqual({ value: null, n: MIN - 1 });
  });
  it('通ったセッションが半分を超えるときだけ数になり、半分以下なら未達', () => {
    // 5 件のうち 3 件が通った: 真ん中(3 番目)は通ったセッションのいちばん大きい値
    expect(untilPass([1, 2, 4], 5)).toEqual({ value: 4, n: 5 });
    // 6 件のうち 4 件: 3 番目と 4 番目の平均(丸めない)
    expect(untilPass([3, 1, 2, 4], 6)).toEqual({ value: 3.5, n: 6 });
    // 全部通った: ふつうの中央値
    expect(untilPass([5, 1, 3, 2, 4], 5)).toEqual({ value: 3, n: 5 });
    // ちょうど半分・半分未満・1 件も通っていない
    expect(untilPass([1, 2, 3], 6).value).toBe('unreached');
    expect(untilPass([1, 2], 5).value).toBe('unreached');
    expect(untilPass([], 5).value).toBe('unreached');
  });
});

describe('conditionCell: 1 行の数え方', () => {
  it(`${MIN} 件未満では割合と中央値が null で、件数は出る`, () => {
    const few = conditionCell('t', 'c', Array.from({ length: MIN - 1 }, (_, i) => s(`s${i}`, pass(1))), 1);
    expect(few).toMatchObject({ sessions: MIN - 1, withTests: MIN - 1, passed: MIN - 1, regressed: 0, unreached: 0, passRate: null, failureRate: null });
    expect(few.runsToPass).toEqual({ value: null, n: MIN - 1 });
    expect(few.active).toEqual({ value: null, n: MIN - 1 });
    const enough = conditionCell('t', 'c', Array.from({ length: MIN }, (_, i) => s(`s${i}`, pass(i + 1))), 1);
    expect(enough).toMatchObject({ sessions: MIN, passRate: 1, failureRate: 0.1 });
    expect(enough.runsToPass).toEqual({ value: 3, n: MIN });
    expect(enough.activeToPass).toEqual({ value: 180_000, n: MIN });
    expect(enough.aiuToPass).toEqual({ value: 3, n: MIN });
    expect(enough.active).toEqual({ value: 600_000, n: MIN });
    expect(enough.aiu).toEqual({ value: 4, n: MIN });
  });
  it('テストの記録が無いセッションは、件数には入るが、テストの結果の分母にも未達にも入らない', () => {
    const c = conditionCell('t', 'c', [...Array.from({ length: MIN }, (_, i) => s(`p${i}`, pass(2))), s('n1'), s('n2')], 1);
    expect(c).toMatchObject({ sessions: MIN + 2, withTests: MIN, passed: MIN, unreached: 0, passRate: 1 });
    expect(c.runsToPass.n).toBe(MIN);
    // セッション全体の値は、テストの記録が無いセッションも入る
    expect(c.active.n).toBe(MIN + 2);
  });
  it('最後に全部通った・通った後に不合格・未達を分けて数え、合格に数えるのは最後に全部通ったものだけ', () => {
    const list = [s('a', pass(1)), s('b', pass(2)), s('c', pass(3)), s('d', pass(1, { runs: 3, lastFailing: 2 })), s('e', unreached()), s('f', unreached())];
    const c = conditionCell('t', 'c', list, 1);
    expect(c).toMatchObject({ withTests: 6, passed: 3, regressed: 1, unreached: 2, passRate: 0.5 });
    // 通ったことがあるのは 4 / 6 件(通った後に不合格も、最初に通った回は数える): 1, 1, 2, 3, 未達, 未達 の 3・4 番目の平均
    expect(c.runsToPass).toEqual({ value: 2.5, n: 6 });
  });
  it('通ったセッションが半分以下の行は、通るまでの値が未達になる(通ったセッションだけで取らない)', () => {
    const list = [s('a', pass(1)), s('b', pass(1)), s('c', unreached()), s('d', unreached()), s('e', unreached())];
    const c = conditionCell('t', 'c', list, 1);
    expect(c.passRate).toBe(0.4);
    expect(c.runsToPass).toEqual({ value: 'unreached', n: 5 });
    expect(c.activeToPass).toEqual({ value: 'unreached', n: 5 });
    expect(c.aiuToPass).toEqual({ value: 'unreached', n: 5 });
  });
  it('AI 使用量の記録が無いセッションは 0 として足さず、通るまでの AIU の母数に入れない', () => {
    const noAiu = { passNanoAiu: null, lastNanoAiu: null };
    const list = [...Array.from({ length: MIN }, (_, i) => s(`p${i}`, pass(i + 1))), s('x', pass(1, noAiu), { tokens: { nanoAiu: null } } as Partial<ConditionSession>), s('y', unreached({ lastNanoAiu: null }))];
    const c = conditionCell('t', 'c', list, 1);
    // 実行と実働は全部(7 件)、AIU は記録のある 5 件だけ
    expect(c.runsToPass.n).toBe(MIN + 2);
    expect(c.activeToPass.n).toBe(MIN + 2);
    expect(c.aiuToPass).toEqual({ value: 3, n: MIN });
    expect(c.aiu).toEqual({ value: 4, n: MIN + 1 });
    // 通ったが、そこまでの AI 使用量が分からないセッション(最後の実行までの量はある)は、通った側にも未達の側にも入れない
    const unknown = conditionCell('t', 'c', [...Array.from({ length: MIN }, (_, i) => s(`p${i}`, pass(i + 1))), s('z', pass(1, { passNanoAiu: null }))], 1);
    expect(unknown.aiuToPass).toEqual({ value: 3, n: MIN });
    expect(unknown.runsToPass.n).toBe(MIN + 1);
    // AI 使用量の記録があるセッションが足りなければ「—」(未達より先に決まる)
    const few = conditionCell('t', 'c', [s('a', pass(1, noAiu)), ...Array.from({ length: MIN - 1 }, (_, i) => s(`u${i}`, unreached()))], 1);
    expect(few.aiuToPass).toEqual({ value: null, n: MIN - 1 });
    expect(few.runsToPass).toEqual({ value: 'unreached', n: MIN });
  });
  it('ツールの失敗・拒否は 失敗・拒否 ÷ 呼び出し(呼び出しが無ければ null)', () => {
    const list = Array.from({ length: MIN }, (_, i) => s(`s${i}`, undefined, { tools: { total: i }, friction: { toolFailures: i === 4 ? 2 : 0 } } as Partial<ConditionSession>));
    expect(conditionCell('t', 'c', list, 1)).toMatchObject({ tools: 10, toolFailures: 2, failureRate: 0.2 });
    const idle = Array.from({ length: MIN }, (_, i) => s(`s${i}`, undefined, { tools: { total: 0 }, friction: { toolFailures: 0 } } as Partial<ConditionSession>));
    expect(conditionCell('t', 'c', idle, 1).failureRate).toBeNull();
  });
});

describe('conditionTable: 課題 × 条件の行と、課題をまとめた行', () => {
  const sessions = ['r-p1', 'r-p2', 'r-w1', 'r-w2', 'r-c1', 'i-p1', 'i-w1', 'i-w2', 'i-w3'].map((id) => s(id, pass(1)));
  const groups = [
    g('render__plain__1', ['r-p1']),
    g('render__plain__2', ['r-p2']),
    g('render__wiki', ['r-w1', 'r-w2']),
    g('render__coderef__1', ['r-c1']),
    g('input__plain__1', ['i-p1']),
    g('input__wiki__1', ['i-w1', 'i-w2', 'i-w3', 'not-in-records']),
  ];
  it('条件が 3 つ以上でも 1 つの表になり、どの課題にも同じ条件が同じ順で並ぶ(無い条件は 0 件の行)', () => {
    const t = conditionTable(sessions, groups);
    expect(t.tasks).toEqual(['input', 'render']);
    expect(t.conditions).toEqual(['coderef', 'plain', 'wiki']);
    expect(t.rows.map((r) => r.map((c) => [c.task, c.condition, c.sessions, c.tasks]))).toEqual([
      [['input', 'coderef', 0, 0], ['input', 'plain', 1, 1], ['input', 'wiki', 3, 1]],
      [['render', 'coderef', 1, 1], ['render', 'plain', 2, 1], ['render', 'wiki', 2, 1]],
    ]);
    expect(t).toMatchObject({ matchedTags: 6, counted: 9, ambiguous: 0, unmatched: [], people: 0, sharedRows: 0, hasTests: true });
    // 条件によってセッションの数が違う課題
    expect(t.unevenTasks).toBe(2);
  });
  it('課題をまとめた行は、同じ条件のセッションを全部の課題から集め、セッションのある課題の数を持つ', () => {
    const t = conditionTable(sessions, groups);
    expect(t.pooled.map((c) => [c.task, c.condition, c.sessions, c.tasks])).toEqual([[null, 'coderef', 1, 1], [null, 'plain', 3, 2], [null, 'wiki', 5, 2]]);
    // まとめた行にも同じ閾値: 5 件ある wiki だけ割合が出る
    expect(t.pooled.map((c) => c.passRate)).toEqual([null, null, 1]);
    // まとめた行の件数は、課題ごとの行の合計と合う(同じセッションを 2 回数えない)
    for (const [i, c] of t.pooled.entries()) expect(c.sessions).toBe(t.rows.reduce((n, r) => n + r[i].sessions, 0));
  });
  it('番号だけ違うタグに重ねて入っているセッションは 1 回だけ数える', () => {
    const t = conditionTable([s('a', pass(1))], [g('x__plain__1', ['a']), g('x__plain__2', ['a']), g('x__plain', ['a'])]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][0]).toMatchObject({ sessions: 1, withTests: 1 });
    expect(t).toMatchObject({ matchedTags: 3, counted: 1, ambiguous: 0 });
  });
  it('課題か条件の違うタグが 2 つ以上付いたセッションは、どの行にも入れず件数だけ返す', () => {
    const t = conditionTable([s('a'), s('b'), s('c')], [g('x__plain', ['a', 'b']), g('x__wiki', ['b']), g('y__plain', ['c', 'a'])]);
    expect(t.ambiguous).toBe(2);
    expect(t.counted).toBe(1);
    expect(t.tasks).toEqual(['y']);
    expect(t.pooled.map((c) => [c.condition, c.sessions])).toEqual([['plain', 1]]);
    // 全部が外れたら行は無いが、合うタグの数は残る(節は出して理由を書く)
    const none = conditionTable([s('a')], [g('x__plain', ['a']), g('x__wiki', ['a'])]);
    expect(none).toMatchObject({ matchedTags: 2, counted: 0, ambiguous: 1, tasks: [], conditions: [], rows: [], pooled: [], hasTests: false });
  });
  it('決まりに合わないタグは入れず、区切りを含むものだけ名前を返す。セッションの無いタグは数えない', () => {
    const t = conditionTable([s('a'), s('b'), s('c')], [g('x__plain', ['a']), g('Player-Weapon', ['a', 'b']), g('x__wiki__v2', ['b']), g('x____1', ['c']), g('y__plain', []), g('z__plain', ['gone'])]);
    expect(t.unmatched).toEqual(['x____1', 'x__wiki__v2']);
    expect(t.matchedTags).toBe(1);
    expect(t.tasks).toEqual(['x']);
  });
  it('送り先から集計したグループは、表示名「人 / タグ」ではなく元のタグから読み、人が違っても同じ行にまとめる', () => {
    const list = [s('a', pass(1), { person: 'zz-taro' }), s('b', pass(2), { person: 'zz-hanako' }), s('c', undefined, { person: 'zz-hanako' })];
    const t = conditionTable(list, [g('zz-taro / x__plain__1', ['a'], 'x__plain__1'), g('zz-hanako / x__plain__1', ['b'], 'x__plain__1'), g('zz-hanako / x__plain__1 (2)', ['c'], 'x__plain__2')]);
    expect(t.tasks).toEqual(['x']);
    expect(t.rows[0][0]).toMatchObject({ condition: 'plain', sessions: 3, withTests: 2 });
    expect(t).toMatchObject({ people: 2, sharedRows: 1 });
    // 人ごとに別の課題・条件を実行しただけなら、人をまたいでまとめた行は無い
    const apart = conditionTable([s('a', undefined, { person: 'zz-taro' }), s('b', undefined, { person: 'zz-hanako' })], [g('zz-taro / x__plain', ['a'], 'x__plain'), g('zz-hanako / y__wiki', ['b'], 'y__wiki')]);
    expect(apart).toMatchObject({ people: 2, sharedRows: 0 });
  });
  it('並びは名前の順で、数字は数として比べる', () => {
    expect(['c10', 'c2', 'B', 'a', 'c1'].sort(compareNames)).toEqual(['a', 'B', 'c1', 'c2', 'c10']);
    const t = conditionTable([s('a'), s('b'), s('c')], [g('t10__0-plain', ['a']), g('t2__wiki', ['b']), g('t2__0-plain', ['c'])]);
    expect(t.tasks).toEqual(['t2', 't10']);
    expect(t.conditions).toEqual(['0-plain', 'wiki']);
  });
  it('大文字小文字・全角半角だけが違う名前は、まとめずに組を知らせる', () => {
    // 3 つ目は全角の wiki
    const wide = 'ｗｉｋｉ';
    const t = conditionTable([s('a'), s('b'), s('c')], [g('x__wiki', ['a']), g('x__Wiki', ['b']), g(`x__${wide}`, ['c'])]);
    expect(t.conditions).toHaveLength(3);
    expect(t.lookalikes).toHaveLength(2);
    expect(new Set(t.lookalikes.flat())).toEqual(new Set(['wiki', 'Wiki', wide]));
  });
  it('テストの記録が 1 件も無ければ hasTests が false(古い埋め込みの tests の無いセッション)', () => {
    const t = conditionTable([s('a'), s('b')], [g('x__plain', ['a']), g('x__wiki', ['b'])]);
    expect(t.hasTests).toBe(false);
    expect(t.pooled.every((c) => c.withTests === 0 && c.passRate === null)).toBe(true);
  });
});

describe('testsSummary: 埋め込むテストの結果の要約', () => {
  const run = (failing: number, activeMs: number, nanoAiu: number | null): TestRun => ({ at: null, turn: 1, tool: 'powershell', toolCallId: null, activeMs, nanoAiu, failing, results: [] });
  const tests = (runs: TestRun[], firstPass: number | null): SessionTests => ({ runs, invalid: 0, duplicates: 0, dropped: 0, firstPass });
  it('最初に通った実行の累計と、最後の実行の状態を持つ', () => {
    expect(testsSummary(tests([run(2, 1000, 1e9), run(0, 5000, 3e9), run(1, 9000, 7e9)], 2))).toEqual({ runs: 3, firstPass: 2, lastFailing: 1, passActiveMs: 5000, passNanoAiu: 3e9, lastNanoAiu: 7e9 });
  });
  it('未達は通るまでの値が null、AI 使用量の記録が無ければ null のまま(0 にしない)', () => {
    expect(testsSummary(tests([run(1, 1000, null), run(1, 2000, null)], null))).toEqual({ runs: 2, firstPass: null, lastFailing: 1, passActiveMs: null, passNanoAiu: null, lastNanoAiu: null });
  });
  it('テストの実行が無ければ null(読めなかった行だけのセッションを分母に入れない)', () => {
    expect(testsSummary({ runs: [], invalid: 3, duplicates: 0, dropped: 0, firstPass: null })).toBeNull();
  });
  it('番号が実行の数を外れていれば、通っていないものとして扱う', () => {
    for (const n of [0, 5, -1, 1.5]) expect(testsSummary(tests([run(0, 1000, 1)], n))).toMatchObject({ firstPass: null, passActiveMs: null, passNanoAiu: null });
  });
});

describe('利用の確認: 条件ごとに、選んだものを使ったセッションと、食い違ったセッション', () => {
  /** wiki の参照の回数・skill・MCP サーバー・ツールを決めたセッション */
  const u = (id: string, o: { wiki?: number; writes?: number; other?: number; skills?: Record<string, number>; mcp?: Record<string, Record<string, number>>; tools?: Record<string, number> } = {}): ConditionSession =>
    s(id, undefined, {
      name: `合成 ${id}`,
      href: `sessions/${id}.html`,
      wiki: { indexReads: o.wiki ?? 0, pageReads: 0, skillCalls: 0, writes: o.writes ?? 0, otherCalls: o.other ?? 0 },
      skills: Object.fromEntries(Object.entries(o.skills ?? {}).map(([k, n]) => [k, [n, 0, 0]])),
      tools: { total: 1, byName: { ...(o.tools ?? {}), ...Object.fromEntries(Object.values(o.mcp ?? {}).flatMap((t) => Object.entries(t))) }, mcp: o.mcp ?? {} },
    } as unknown as Partial<ConditionSession>);
  const list = [
    u('p1'),
    u('p2', { wiki: 2 }),
    u('w1', { wiki: 3, skills: { 'zz-notes': 1 } }),
    u('w2', { writes: 1 }),
    u('w3', { wiki: 1 }),
    u('c1', { mcp: { 'zz-code': { 'zz-code-find': 2 } }, tools: { view: 4 } }),
    u('c2', { mcp: { 'zz-code': { 'zz-code-find': 1 } } }),
  ];
  const table = conditionTable(list, [g('t__plain', ['p1', 'p2']), g('t__wiki', ['w1', 'w2', 'w3']), g('t__coderef', ['c1', 'c2'])]);

  it('選べるものは llm-wiki が先頭で、続けて使われた skill・MCP サーバー・ツール(MCP のツールはサーバーにまとめる)', () => {
    expect(usageItems(table.members).map((i) => [i.key, i.sessions])).toEqual([
      ['wiki', 3],
      ['skill:zz-notes', 1],
      ['mcp:zz-code', 2],
      ['tool:view', 1],
    ]);
    // 使われていなくても llm-wiki は選べる
    expect(usageItems(conditionTable([u('a')], [g('t__x', ['a'])]).members)).toEqual([{ key: 'wiki', kind: 'wiki', name: 'llm-wiki', sessions: 0 }]);
  });
  it('wiki の参照は読んだ回数と skill の呼び出しで、書き込みだけのセッションは使わなかったに入る', () => {
    expect(list.map((x) => usageCount(x, 'wiki'))).toEqual([0, 2, 3, 0, 1, 0, 0]);
    expect(usageCount(list[5], 'mcp:zz-code')).toBe(2);
    expect(usageCount(list[5], 'tool:view')).toBe(4);
    expect(usageCount(list[2], 'skill:zz-notes')).toBe(1);
    expect(usageCount(list[0], 'skill:zz-none')).toBe(0);
    // vault の検索・一覧だけでも使ったに入る(詳細ページの「llm-wiki の参照」と同じ)
    expect(usageCount(u('x', { other: 2 }), 'wiki')).toBe(2);
    // 古い埋め込み(otherCalls が無い)でも数えられる
    expect(usageCount(s('old', undefined, { wiki: { indexReads: 1, pageReads: 0, skillCalls: 0, writes: 0 } } as unknown as Partial<ConditionSession>), 'wiki')).toBe(1);
    // 組み込みの名前を、記録と取り違えない
    for (const k of ['tool:constructor', 'skill:toString', 'mcp:__proto__']) expect(usageCount(list[0], k), k).toBe(0);
  });
  it(`条件ごとの使ったセッションの数。割合は ${MIN} 件未満なら null`, () => {
    expect(usageRows(table, 'wiki')).toEqual([
      { condition: 'coderef', sessions: 2, used: 0, share: null },
      { condition: 'plain', sessions: 2, used: 1, share: null },
      { condition: 'wiki', sessions: 3, used: 2, share: null },
    ]);
    const many = conditionTable(Array.from({ length: MIN }, (_, i) => u(`m${i}`, { wiki: i % 2 })), [g('t__wiki', Array.from({ length: MIN }, (_, i) => `m${i}`))]);
    expect(usageRows(many, 'wiki')[0].share).toBe(2 / MIN);
  });
  it('使うはずの条件で使わなかったセッションと、ほかの条件で使ったセッション(使うはずの条件が無ければ、使ったものは全部ほか)', () => {
    const r = usageMismatches(table, 'wiki', new Set(['wiki']));
    expect(r.missing.map((m) => [m.member.session.id, m.member.condition, m.count])).toEqual([['w2', 'wiki', 0]]);
    expect(r.leaked.map((m) => [m.member.session.id, m.member.condition, m.count])).toEqual([['p2', 'plain', 2]]);
    // 使うはずの条件を 2 つ選べる
    const two = usageMismatches(table, 'mcp:zz-code', new Set(['coderef', 'wiki']));
    expect(two.missing.map((m) => m.member.session.id)).toEqual(['w1', 'w2', 'w3']);
    expect(two.leaked).toEqual([]);
    expect(usageMismatches(table, 'wiki', new Set()).leaked.map((m) => m.member.session.id)).toEqual(['p2', 'w1', 'w3']);
  });
  it('行に入らなかったセッション(複数の条件のタグ)は、利用の確認にも入れない', () => {
    const t = conditionTable([u('a', { wiki: 1 }), u('b')], [g('t__wiki', ['a', 'b']), g('t__plain', ['a'])]);
    expect(t.members.map((m) => m.session.id)).toEqual(['b']);
    expect(usageMismatches(t, 'wiki', new Set(['plain'])).leaked).toEqual([]);
  });
});
