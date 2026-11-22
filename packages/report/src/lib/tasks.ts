// 管理ツールのタスクの表示(値は Rust の tasks::view が決めたもの。ここは言葉と単位にするだけで、数え直さない)
import { dec } from './format.ts';
import type { TaskExcluded, TaskLinkSource, TasksReport } from './types.ts';

/** 紐づけの出所(Rust の LinkSource::label と同じ言葉) */
export const LINK_SOURCE_LABEL: Record<TaskLinkSource, string> = { machine: '機械', llm: 'LLM', manual: '手動' };

/** 比べられるタスクから外した理由(Rust の Excluded::label と同じ言葉。並びは理由を決める順) */
export const TASK_EXCLUDED: TaskExcluded[] = ['notDone', 'noStart', 'unjudged', 'lowConfidence'];
export const TASK_EXCLUDED_LABEL: Record<TaskExcluded, string> = { notDone: '未完了', noStart: '開始が分からない', unjudged: '判定なし', lowConfidence: '確度が低い' };

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

/** 紐づけの出所ごとの数(0 のものは出さない)。例: 機械 2・手動 1 */
export function linkCounts(c: Record<TaskLinkSource, number>): string {
  return (Object.keys(LINK_SOURCE_LABEL) as TaskLinkSource[])
    .filter((k) => c[k] > 0)
    .map((k) => `${LINK_SOURCE_LABEL[k]} ${c[k]}`)
    .join('・');
}
