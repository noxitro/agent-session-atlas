// セッションの本体(メインのエージェント)の (モデル, 推論強度) を決める(sessions.csv の「本体のモデル」「本体の推論強度」の列)。
// 画面の packages/report/src/lib/main-effort.ts と同じ決め方(画面はリクエスト数だけを埋め込んだ要約から決める)。
import type { EffortStat } from './types.ts';

/** 本体のリクエストのうち、同じ (モデル, 推論強度) がこの割合以上なら、その組をセッションの本体の強度とみなす */
export const MAIN_EFFORT_SHARE = 0.9;

/** 強度の記録が無いリクエストの印(normalize.ts の UNKNOWN_KEY と同じ) */
const UNKNOWN_EFFORT = '(unknown)';

/**
 * decided = 本体のリクエストの MAIN_EFFORT_SHARE 以上が同じ組、mixed = 本体のリクエストはあるがどの組も届かない、
 * none = 本体のリクエストの記録が無い(古い sessions.json・終了時の累計だけ)か、いちばん多い組の強度が不明
 */
export type MainEffort = { kind: 'decided'; model: string; effort: string } | { kind: 'mixed' } | { kind: 'none' };

/** exec.mainModelEfforts から本体の (モデル, 推論強度) を決める */
export function mainEffortOf(main: Record<string, Record<string, EffortStat>> | undefined | null): MainEffort {
  let total = 0;
  let best: { model: string; effort: string; n: number } | null = null;
  for (const [model, by] of Object.entries(main ?? {})) {
    for (const [effort, s] of Object.entries(by)) {
      total += s.requests;
      if (!best || s.requests > best.n) best = { model, effort, n: s.requests };
    }
  }
  if (best && total > 0 && best.n / total >= MAIN_EFFORT_SHARE) return best.effort === UNKNOWN_EFFORT ? { kind: 'none' } : { kind: 'decided', model: best.model, effort: best.effort };
  return total > 0 ? { kind: 'mixed' } : { kind: 'none' };
}

/** 表(sessions.csv)の「本体の推論強度」に書く言葉。決まったときは強度の名前 */
export function mainEffortCell(m: MainEffort): string {
  return m.kind === 'decided' ? m.effort : m.kind === 'mixed' ? '混在' : '記録なし';
}

/** 表(sessions.csv)の「本体のモデル」に書く言葉。決まらなければ空 */
export function mainModelCell(m: MainEffort): string {
  return m.kind === 'decided' ? m.model : '';
}
