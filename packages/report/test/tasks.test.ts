// 管理ツールのタスクの絞り込み(filter.ts の task)と、表示の言葉・一覧の「タスク」の欄(lib/tasks.ts)
import { describe, expect, it } from 'vitest';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter, matchesTask, NO_TASK, taskOf, taskOptions } from '../src/lib/filter.ts';
import { hours, linkCounts, linkTaskIds, msHours, sortByTask, TASK_CELL_SHOWN, taskCell, taskExcludedText, taskIncludedNote, workHoursText } from '../src/lib/tasks.ts';
import type { SessionSummary, TaskLinkView } from '../src/lib/types.ts';

describe('タスクの絞り込み', () => {
  // d は 2 つのタスクに紐づく。c と e は「どのタスクでもない」(版 20 の null と、今の空の並び)
  const links = { a: { taskIds: ['T-1'] }, b: { taskIds: ['T-2'] }, c: { taskId: null }, d: { taskIds: ['T-2', 'T-1'] }, e: { taskIds: [] } };
  const tasks = taskOf(links);

  it('taskOf は「どのタスクでもない」(空の並び・前の版の null)を入れず、前の版の taskId も読む', () => {
    expect([...tasks]).toEqual([
      ['a', ['T-1']],
      ['b', ['T-2']],
      ['d', ['T-2', 'T-1']],
    ]);
    expect([...taskOf({ x: { taskId: 'OLD' } })]).toEqual([['x', ['OLD']]]);
    expect(taskOf(null).size).toBe(0);
  });

  it('task はそのタスクに紐づいたセッション(ほかのタスクにも紐づいたものも)、NO_TASK はどれにも紐づいていないセッションだけ', () => {
    expect(matchesTask('a', '', tasks)).toBe(true);
    expect(matchesTask('a', 'T-1', tasks)).toBe(true);
    expect(matchesTask('b', 'T-1', tasks)).toBe(false);
    expect(matchesTask('d', 'T-1', tasks)).toBe(true);
    expect(matchesTask('d', 'T-2', tasks)).toBe(true);
    expect(matchesTask('d', NO_TASK, tasks)).toBe(false);
    expect(matchesTask('c', NO_TASK, tasks)).toBe(true);
    expect(matchesTask('e', NO_TASK, tasks)).toBe(true);
    expect(matchesTask('z', NO_TASK, tasks)).toBe(true);
    expect(matchesTask('a', NO_TASK, tasks)).toBe(false);
    // 空の並びを持つ TaskOf を直接渡しても、タスクなしとして扱う
    expect(matchesTask('q', NO_TASK, new Map([['q', []]]))).toBe(true);
    expect(matchesTask('q', 'T-1', new Map([['q', []]]))).toBe(false);
    // 紐づけを渡さなければ、どのセッションもタスクなし
    const s = [{ id: 'a', empty: false, project: 'p', client: null, branch: null, models: [], createdAt: null, updatedAt: null }] as unknown as SessionSummary[];
    expect(applyFilter(s, { ...emptyFilter(), task: 'T-1' }).length).toBe(0);
    expect(applyFilter(s, { ...emptyFilter(), task: 'T-1' }, tasks).length).toBe(1);
  });

  it('URL ハッシュに task として書き、読み戻す(キーの順は Rust の FILTER_KEYS と同じ末尾)', () => {
    expect(encodeFilter({ ...emptyFilter(), task: NO_TASK, wiki: '1' })).toBe('wiki=1&task=(none)');
    expect(decodeFilter('#task=T%201').task).toBe('T 1');
  });

  it('選択肢は紐づいたセッションの多い順(いくつかのタスクに紐づいたセッションは、それぞれに数える)、名前が無ければ ID', () => {
    const o = taskOptions([{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'c' }, { id: 'd' }, { id: 'e' }], new Map([...tasks, ['x', ['T-2', 'T-2']]]), new Map([['T-1', '一つ目']]));
    expect(o).toEqual({
      tasks: [
        { value: 'T-2', label: 'T-2', count: 3 },
        { value: 'T-1', label: '一つ目', count: 2 },
      ],
      none: 2,
    });
  });
});

describe('一覧の「タスク」の欄', () => {
  const names = new Map([
    ['T-1', 'ログイン画面'],
    ['T-2', '帳票'],
    ['T-3', 'T-3'],
    ['T-9', 'あとの仕事'],
  ]);
  const link = (taskIds: string[], extra: Partial<TaskLinkView> = {}): TaskLinkView => ({ taskIds, source: 'machine', reason: 'ID が題名にある', ...extra });

  it('2 つまで出し、残りは +N。全部と理由は title。紐づけが無ければ null、空の並びは「どのタスクでもない」', () => {
    expect(TASK_CELL_SHOWN).toBe(2);
    const one = taskCell(link(['T-1']), names)!;
    expect(one).toEqual({ tasks: [{ name: 'ログイン画面', id: 'T-1' }], more: 0, source: '機械', title: '紐づけの理由: ID が題名にある' });
    const many = taskCell(link(['T-2', 'T-3', 'T-1', 'T-404'], { source: 'manual', reason: '' }), names)!;
    expect(many.tasks).toEqual([
      { name: '帳票', id: 'T-2' },
      { name: '', id: 'T-3' },
    ]);
    expect(many.more).toBe(2);
    expect(many.source).toBe('手動');
    expect(many.title).toBe('タスク:\n帳票 · T-2\nT-3\nログイン画面 · T-1\nT-404');
    expect(taskCell(link([], { source: 'llm' }), names)).toMatchObject({ tasks: [], more: 0, source: 'LLM' });
    expect(taskCell(undefined, names)).toBeNull();
    // 版 20 の埋め込み(taskId)も読む
    expect(linkTaskIds({ taskId: 'T-1' })).toEqual(['T-1']);
    expect(linkTaskIds({ taskId: null })).toEqual([]);
  });

  it('並べ替えは最初のタスクの名前、同じなら ID の順。タスクの無いセッションはどちらの向きでも後ろ', () => {
    const rows = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id }));
    const links: Record<string, TaskLinkView> = {
      s1: link(['T-9']),
      s2: link(['T-1', 'T-9']),
      s3: link([]),
      s5: link(['T-2']),
      s6: link(['T-1']),
    };
    // 名前の順(ja): あとの仕事 < ログイン画面 < 帳票。ログイン画面どうしは ID、同じなら セッション id
    expect(sortByTask(rows, links, names, true).map((r) => r.id)).toEqual(['s1', 's2', 's6', 's5', 's3', 's4']);
    expect(sortByTask(rows, links, names, false).map((r) => r.id)).toEqual(['s5', 's2', 's6', 's1', 's3', 's4']);
    // 紐づけが無ければ セッション id の順のまま
    expect(sortByTask(rows, null, names, false).map((r) => r.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    // 同じ順位の行とタスクの無い行は、渡した並び(一覧の既定: 開始の新しい順)にする
    const at: Record<string, number> = { s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, s6: 6 };
    const newest = (a: { id: string }, b: { id: string }): number => at[b.id] - at[a.id];
    expect(sortByTask(rows, links, names, true, newest).map((r) => r.id)).toEqual(['s1', 's6', 's2', 's5', 's4', 's3']);
    expect(sortByTask(rows, links, names, false, newest).map((r) => r.id)).toEqual(['s5', 's6', 's2', 's1', 's4', 's3']);
    // 名前の無いタスクは ID で並べる
    expect(sortByTask([{ id: 'a' }, { id: 'b' }], { a: link(['Z-1']), b: link(['A-1']) }, new Map(), true).map((r) => r.id)).toEqual(['b', 'a']);
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
  it('比べられる完了タスクの注記(タスクの節と表紙で同じ文): 紐づいたタスクの数と、比べないものを理由の順に(0 のものは出さない)', () => {
    const none = { notDone: 0, doneUnobserved: 0, afterDone: 0, noStart: 0, unjudged: 0, lowConfidence: 0 };
    expect(taskIncludedNote({ tasks: 3, excluded: { ...none, lowConfidence: 1, notDone: 2 } })).toBe('セッションが紐づいたタスク 3 件のうち。比べないもの: 未完了 2・確度が低い 1');
    expect(taskIncludedNote({ tasks: 0, excluded: none })).toBe('セッションが紐づいたタスク 0 件のうち。比べないものはありません');
    expect(taskExcludedText({ ...none, unjudged: 1200 })).toBe('判定なし 1,200');
  });
});
