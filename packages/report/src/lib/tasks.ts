// 管理ツールのタスクの表示(値は Rust の tasks::view が決めたもの。ここは言葉と単位にするだけで、数え直さない)
import { dateTime, dec, int, percent } from './format.ts';
import type { TaskDoneAtCounts, TaskDoneAtSource, TaskExcluded, TaskFriction, TaskLinkSource, TaskLinkView, TaskRow, TaskSummary, TasksReport, TaskVerdicts } from './types.ts';

/** 紐づけのタスクの ID の並び(版 20 の埋め込みの taskId(1 つか null)も 0 か 1 件の並びとして読む) */
export function linkTaskIds(l: Pick<TaskLinkView, 'taskIds'> | { taskId?: string | null; taskIds?: readonly string[] | null }): readonly string[] {
  const x = l as { taskId?: string | null; taskIds?: readonly string[] | null };
  return x.taskIds ?? (x.taskId != null ? [x.taskId] : []);
}

/** セッション一覧の「タスク」の欄に出すタスクの数(超えた分は「+N」にまとめ、全部は title に出す) */
export const TASK_CELL_SHOWN = 2;

export interface TaskCell {
  /** 欄に出すタスク(先頭から TASK_CELL_SHOWN 件)。name は ID と同じなら空。空の並びは「どのタスクでもない」 */
  tasks: { name: string; id: string }[];
  /** 欄に出さなかったタスクの数 */
  more: number;
  /** 紐づけの出所の言葉 */
  source: string;
  /** title に出す文(紐づけの理由と、出しきれなかったときは全部のタスク。1 行ずつ) */
  title: string;
}

/** セッション一覧の「タスク」の欄の中身。紐づけが無ければ null */
export function taskCell(l: TaskLinkView | null | undefined, names: ReadonlyMap<string, string>): TaskCell | null {
  if (!l) return null;
  const all = linkTaskIds(l).map((t) => {
    const name = names.get(t) ?? t;
    return { name: name === t ? '' : name, id: t };
  });
  const lines = [l.reason ? `紐づけの理由: ${l.reason}` : '', ...(all.length > TASK_CELL_SHOWN ? ['タスク:', ...all.map((t) => (t.name ? `${t.name} · ${t.id}` : t.id))] : [])];
  return { tasks: all.slice(0, TASK_CELL_SHOWN), more: Math.max(0, all.length - TASK_CELL_SHOWN), source: LINK_SOURCE_LABEL[l.source] ?? l.source, title: lines.filter(Boolean).join('\n') };
}

/**
 * セッションを「タスク」の欄で並べる: 最初のタスクの名前(無ければ ID)、同じなら ID の順。asc が false なら逆。
 * 同じタスクどうしと、タスクの無いセッション(紐づけなし・どのタスクでもない。どちらの向きでも後ろ)は、
 * tie の順(一覧の既定の並び。渡さなければセッション id の順)
 */
export function sortByTask<T extends { id: string }>(
  rows: readonly T[],
  links: Readonly<Record<string, TaskLinkView>> | null | undefined,
  names: ReadonlyMap<string, string>,
  asc: boolean,
  tie: (a: T, b: T) => number = (a, b) => a.id.localeCompare(b.id),
): T[] {
  const dir = asc ? 1 : -1;
  const keys = new Map<string, [string, string] | null>(
    rows.map((s) => {
      const first = links?.[s.id] ? linkTaskIds(links[s.id])[0] : undefined;
      return [s.id, first == null ? null : [names.get(first) || first, first]];
    }),
  );
  return [...rows].sort((a, b) => {
    const x = keys.get(a.id) ?? null;
    const y = keys.get(b.id) ?? null;
    if (!x || !y) return (x ? -1 : y ? 1 : 0) || tie(a, b);
    return (x[0].localeCompare(y[0], 'ja') || x[1].localeCompare(y[1], 'ja')) * dir || tie(a, b);
  });
}

/** 紐づけの出所(Rust の LinkSource::label と同じ言葉) */
export const LINK_SOURCE_LABEL: Record<TaskLinkSource, string> = { machine: '機械', llm: 'LLM', manual: '手動' };

/** 比べられるタスクから外した理由(Rust の Excluded::label と同じ言葉。並びは理由を決める順) */
export const TASK_EXCLUDED: TaskExcluded[] = ['notDone', 'doneUnobserved', 'afterDone', 'noStart', 'noWorkHours', 'unjudged', 'lowConfidence'];
export const TASK_EXCLUDED_LABEL: Record<TaskExcluded, string> = {
  notDone: '未完了',
  doneUnobserved: '完了の時刻が分からない',
  afterDone: '完了の後に始まったセッション',
  noStart: '開始が分からない',
  noWorkHours: '稼働時間帯に重ならない',
  unjudged: '判定なし',
  lowConfidence: '確度が低い',
};

/** 比べないタスクの理由ごとの数(0 のものは出さない)。例: 未完了 3・判定なし 1。どれも 0 なら空 */
export function taskExcludedText(excluded: Partial<Record<TaskExcluded, number>>): string {
  return TASK_EXCLUDED.filter((k) => (excluded[k] ?? 0) > 0)
    .map((k) => `${TASK_EXCLUDED_LABEL[k]} ${int(excluded[k] ?? 0)}`)
    .join('・');
}

/** 完了の時刻の出所(Rust の DoneAtSource::label と同じ言葉) */
export const DONE_AT_SOURCE_LABEL: Record<TaskDoneAtSource, string> = { recorded: '記録', observed: '観測' };

/**
 * 完了を確認した時刻の表示。日付だけの完了日は、Rust が読んだときの暦の日付の文字(doneDate。"2026-11-20")をそのまま出す
 * (doneAt から日付に戻すと、見る PC の時間帯で 1 日ずれるため)
 */
export function doneAtText(t: Pick<TaskRow, 'doneAt' | 'doneDate'>): string {
  if (t.doneDate) return t.doneDate;
  return dateTime(t.doneAt, '—');
}

/** 完了の時刻の出所ごとの数。例: 完了の時刻は記録 3・観測 1。数が無い(古い埋め込み)か、どちらも 0 なら空 */
export function doneAtSourceText(c: TaskDoneAtCounts | undefined): string {
  if (!c || c.recorded + c.observed === 0) return '';
  return `完了の時刻は記録 ${int(c.recorded)}・観測 ${int(c.observed)}`;
}

/** 「比べられる完了タスク」の欄の注記(セッションが紐づいたタスクの数と、比べないものの理由、比べるものの完了の時刻の出所)。タスクの節と全体サマリの表紙で同じ言い方にする */
export function taskIncludedNote(s: Pick<TaskSummary, 'tasks' | 'excluded' | 'includedSources'>): string {
  const ex = taskExcludedText(s.excluded);
  const src = doneAtSourceText(s.includedSources);
  return `セッションが紐づいたタスク ${int(s.tasks)} 件のうち。${ex ? `比べないもの: ${ex}` : '比べないものはありません'}${src ? `。比べるもののうち、${src}` : ''}`;
}

const DAY = ['', '月', '火', '水', '木', '金', '土', '日'];

/** 稼働時間帯の曜日と時刻(例: 月〜金 9:00〜18:00)。曜日が続いていれば「〜」でつなぐ */
export function workHoursText(w: TasksReport['workHours']): string {
  const days = [...new Set(w.days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? '毎日' : run ? `${DAY[days[0]]}〜${DAY[days[days.length - 1]]}` : days.map((d) => DAY[d]).join('・');
  const hm = (s: string): string => s.replace(/^0(\d):/, '$1:');
  return `${dayText} ${hm(w.start)}〜${hm(w.end)}`;
}

/** ミリ秒を時間(小数 2 桁まで)に。tasks.csv の時間の列と同じ丸め */
export function msHours(ms: number): string {
  return `${dec(Math.round(ms / 36_000) / 100)} 時間`;
}

/** 時間(小数 2 桁まで) */
export function hours(h: number): string {
  return `${dec(Math.round(h * 100) / 100)} 時間`;
}

/** 摩擦の合計(ツールの失敗・拒否 + 中断 + 文脈圧縮)。記録の無い古い埋め込みは null */
export function frictionTotal(t: Pick<TaskRow, 'friction'>): number | null {
  const f = t.friction;
  return f ? f.toolFailures + f.aborts + f.compactions : null;
}

/** 摩擦の内訳。例: 失敗・拒否 3・中断 1・圧縮 0 */
export function frictionText(f: TaskFriction): string {
  return `失敗・拒否 ${int(f.toolFailures)}・中断 ${int(f.aborts)}・圧縮 ${int(f.compactions)}`;
}

/** 割合(0〜1)を 1 桁の % に。null(分母が下限に届かない)は — */
export function rateText(x: number | null | undefined): string {
  return x == null ? '—' : percent(x, 1);
}

/** 依頼ごとの判定の内訳(数と割合)。例: 直し 2(33.3%)・不採用 1(16.7%)・的外れ 0(—) */
export function verdictBreakdown(v: TaskVerdicts): string {
  return `直し ${int(v.fix)}(${rateText(v.fixRate)})・不採用 ${int(v.rejected)}(${rateText(v.rejectedRate)})・的外れ ${int(v.offTarget)}(${rateText(v.offTargetRate)})`;
}

/** 紐づけの出所ごとの数(0 のものは出さない)。例: 機械 2・手動 1 */
export function linkCounts(c: Record<TaskLinkSource, number>): string {
  return (Object.keys(LINK_SOURCE_LABEL) as TaskLinkSource[])
    .filter((k) => c[k] > 0)
    .map((k) => `${LINK_SOURCE_LABEL[k]} ${c[k]}`)
    .join('・');
}
