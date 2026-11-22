// 管理ツールのタスクの絞り込み(filter.ts の task)と、表示の言葉(lib/tasks.ts)
import { describe, expect, it } from 'vitest';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter, matchesTask, NO_TASK, taskOf, taskOptions } from '../src/lib/filter.ts';
import { hours, linkCounts, msHours, workHoursText } from '../src/lib/tasks.ts';
import type { SessionSummary } from '../src/lib/types.ts';

describe('タスクの絞り込み', () => {
  const links = { a: { taskId: 'T-1' }, b: { taskId: 'T-2' }, c: { taskId: null } };
  const tasks = taskOf(links);

  it('taskOf は「どのタスクでもない」(taskId が null)を入れない', () => {
    expect([...tasks]).toEqual([
      ['a', 'T-1'],
      ['b', 'T-2'],
    ]);
    expect(taskOf(null).size).toBe(0);
  });

  it('task はそのタスクのセッションだけ、NO_TASK は紐づいていないセッションだけ', () => {
    expect(matchesTask('a', '', tasks)).toBe(true);
    expect(matchesTask('a', 'T-1', tasks)).toBe(true);
    expect(matchesTask('b', 'T-1', tasks)).toBe(false);
    expect(matchesTask('c', NO_TASK, tasks)).toBe(true);
    expect(matchesTask('d', NO_TASK, tasks)).toBe(true);
    expect(matchesTask('a', NO_TASK, tasks)).toBe(false);
    // 紐づけを渡さなければ、どのセッションもタスクなし
    const s = [{ id: 'a', empty: false, project: 'p', client: null, branch: null, models: [], createdAt: null, updatedAt: null }] as unknown as SessionSummary[];
    expect(applyFilter(s, { ...emptyFilter(), task: 'T-1' }).length).toBe(0);
    expect(applyFilter(s, { ...emptyFilter(), task: 'T-1' }, tasks).length).toBe(1);
  });

  it('URL ハッシュに task として書き、読み戻す(キーの順は Rust の FILTER_KEYS と同じ末尾)', () => {
    expect(encodeFilter({ ...emptyFilter(), task: NO_TASK, wiki: '1' })).toBe('wiki=1&task=(none)');
    expect(decodeFilter('#task=T%201').task).toBe('T 1');
  });

  it('選択肢は紐づいたセッションの多い順、名前が無ければ ID', () => {
    const o = taskOptions([{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'c' }], new Map([...tasks, ['x', 'T-2']]), new Map([['T-1', '一つ目']]));
    expect(o).toEqual({
      tasks: [
        { value: 'T-2', label: 'T-2', count: 2 },
        { value: 'T-1', label: '一つ目', count: 1 },
      ],
      none: 1,
    });
  });
});

describe('タスクの表示の言葉', () => {
  it('稼働時間帯は続いた曜日を「〜」でつなぎ、時の先頭の 0 を落とす', () => {
    expect(workHoursText({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' })).toBe('月〜金 9:00〜18:00');
    expect(workHoursText({ days: [1, 3, 5], start: '10:30', end: '19:00' })).toBe('月・水・金 10:30〜19:00');
    expect(workHoursText({ days: [7, 6], start: '08:00', end: '12:00' })).toBe('土・日 8:00〜12:00');
    expect(workHoursText({ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' })).toBe('毎日 0:00〜23:59');
  });
  it('時間は小数 2 桁まで(tasks.csv と同じ丸め)', () => {
    expect(msHours(3 * 3_600_000 + 30 * 60_000)).toBe('3.5 時間');
    expect(msHours(1000)).toBe('0 時間');
    expect(hours(12.345)).toBe('12.35 時間');
  });
  it('紐づけの出所は 0 のものを出さない', () => {
    expect(linkCounts({ machine: 2, llm: 0, manual: 1 })).toBe('機械 2・手動 1');
    expect(linkCounts({ machine: 0, llm: 0, manual: 0 })).toBe('');
  });
});
