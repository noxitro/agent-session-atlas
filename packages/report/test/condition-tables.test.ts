// 表(out/tables/)の課題 × 条件とテストの結果(condition-tables.ts)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionTests, TestRun } from '../../core/src/types.ts';
import { CONDITIONS_HEADER, conditionAssignments, conditionsCsvTable, conditionTableOf, SESSION_CONDITION_COLUMNS, sessionConditionCells, testTables } from '../src/condition-tables.ts';

const run = (o: Partial<TestRun>): TestRun => ({ at: null, turn: 1, tool: 'powershell', toolCallId: null, activeMs: 0, nanoAiu: null, failing: 0, results: [], ...o });
const tests = (runs: TestRun[], firstPass: number | null, o: Partial<SessionTests> = {}): SessionTests => ({ runs, invalid: 0, duplicates: 0, dropped: 0, firstPass, ...o });
/** 2 回目で全部通った(そこまで 2 分・2 AIU) */
const pass2 = (): SessionTests =>
  tests(
    [run({ activeMs: 60_000, nanoAiu: 1e9, failing: 1 }), run({ activeMs: 120_000, nanoAiu: 2e9, failing: 0 })],
    2,
  );
/** 3 回走らせて一度も通らなかった(AI 使用量の記録なし) */
const unreached = (): SessionTests => tests([1, 2, 3].map((i) => run({ activeMs: i * 60_000, failing: 1 })), null);

const rec = (id: string, t?: SessionTests, o: Partial<SessionRecord> = {}): SessionRecord =>
  ({ id, name: `名前 ${id}`, activeMs: 600_000, tools: { total: 10 }, friction: { toolFailures: 1 }, tokens: { nanoAiu: 4e9 }, person: null, empty: false, ...(t ? { tests: t } : {}), ...o }) as unknown as SessionRecord;

const col = (name: string): number => CONDITIONS_HEADER.indexOf(name);

describe('conditionsCsvTable: 画面の課題 × 条件と同じ行', () => {
  const list = [...['a', 'b', 'c', 'd', 'e'].map((id) => rec(id, pass2())), rec('f', unreached())];

  it('課題ごとの行のあとに、条件ごとの行。割合は小数 4 桁、中央値は数だけで母数を並べる', () => {
    const t = conditionTableOf(list, [{ raw: 'x__wiki', ids: ['a', 'b', 'c', 'd', 'e', 'f'] }]);
    const csv = conditionsCsvTable(t);
    expect(csv.rows.length).toBe(2);
    const row = csv.rows[1];
    expect(row.length).toBe(CONDITIONS_HEADER.length);
    expect(row[col('行')]).toBe('条件ごと');
    expect(row[col('課題')]).toBe('');
    expect(row[col('件数')]).toBe(6);
    expect(row[col('最後に全部通った割合')]).toBe(0.8333);
    // 6 件のうち 5 件が通った(どれも 2 回目): 未達を最後に並べた中央値は 2
    expect(row[col('通るまでの実行(中央値)')]).toBe(2);
    expect(row[col('通るまでの実行の母数')]).toBe(6);
    expect(row[col('通るまでの実行が未達')]).toBe(false);
    // AI 使用量は、未達のセッションに記録が無いので 5 件
    expect(row[col('通るまでの AIU の母数')]).toBe(5);
    expect(row[col('通るまでの AIU(中央値)')]).toBe(2);
    expect(row[col('通るまでの実働(秒、中央値)')]).toBe(120);
  });

  it('件数が足りない行は中央値も未達かどうかも空、半分以下しか通っていない行は中央値が空で未達が 1', () => {
    const few = conditionTableOf(list.slice(3), [{ raw: 'y__plain', ids: ['d', 'e', 'f'] }]);
    expect(conditionsCsvTable(few).rows[0][col('通るまでの実行(中央値)')]).toBeNull();
    expect(conditionsCsvTable(few).rows[0][col('通るまでの実行が未達')]).toBeNull();
    const many = Array.from({ length: 6 }, (_, i) => rec(`u${i}`, i < 2 ? tests([run({ activeMs: 1, failing: 0 })], 1) : tests([run({ failing: 1 })], null)));
    const un = conditionsCsvTable(conditionTableOf(many, [{ raw: 'z__wiki', ids: many.map((s) => s.id) }])).rows[0];
    expect(un[col('通るまでの実行(中央値)')]).toBeNull();
    expect(un[col('通るまでの実行が未達')]).toBe(true);
  });
});

describe('sessions.csv の列とテストの表', () => {
  const s1 = rec('s1', tests([run({ at: '2026-11-03T09:02:00.000Z', activeMs: 120_000, nanoAiu: 2e9, failing: 1, results: [{ name: '描画', passed: false, counts: { assertFailures: 2, diffRate: 0.25 }, at: '2026-11-03T09:02:00.000Z' }, { name: null, passed: true, counts: {} }] }), run({ subagent: true, activeMs: 300_000, nanoAiu: 5e9, failing: 0, results: [{ name: '描画', passed: true, counts: {} }] })], 2, { invalid: 1 }));
  const s2 = rec('s2');
  const t = conditionTableOf([s1, s2], [{ raw: 'task__plain__1', ids: ['s1'] }, { raw: 'misc', ids: ['s2'] }]);
  const assign = conditionAssignments(t);

  it('課題・条件は表の行に入ったセッションだけ、テストの列はテストの実行があるセッションだけ', () => {
    expect(SESSION_CONDITION_COLUMNS.length).toBe(9);
    expect(sessionConditionCells(s1, assign)).toEqual(['task', 'plain', 2, 2, 0, 300, 5, 1, 0]);
    expect(sessionConditionCells(s2, assign)).toEqual(['', '', null, null, null, null, null, null, null]);
  });

  it('実行 1 回 1 行・結果 1 件 1 行・件数 1 つ 1 行。テストの実行が無ければ null', () => {
    const x = testTables([s1, s2], assign)!;
    expect(x.runs.rows).toEqual([
      ['s1', '名前 s1', 'task', 'plain', 1, '2026-11-03T09:02:00.000Z', 1, 'powershell', false, 2, 1, 1, 120, 2],
      ['s1', '名前 s1', 'task', 'plain', 2, null, 1, 'powershell', true, 1, 1, 0, 300, 5],
    ]);
    expect(x.results.rows).toEqual([
      ['s1', 1, 1, '描画', false, '2026-11-03T09:02:00.000Z'],
      ['s1', 1, 2, '', true, null],
      ['s1', 2, 1, '描画', true, null],
    ]);
    expect(x.counts.rows).toEqual([
      ['s1', 1, 1, '描画', 'assertFailures', 2],
      ['s1', 1, 1, '描画', 'diffRate', 0.25],
    ]);
    expect(testTables([s2], assign)).toBeNull();
  });
});
