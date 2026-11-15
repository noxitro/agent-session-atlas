// セッションの本体(メインのエージェント)の (モデル, 推論強度) を決める。
// Rust の crates/atlas-core/src/main_effort.rs(sessions.csv の列)と同じ決め方(npm run parity:fixture で突き合わせる)。
import { UNKNOWN_KEY } from './exec.ts';

/** 本体のリクエストのうち、同じ (モデル, 推論強度) がこの割合以上なら、その組をセッションの本体の強度とみなす */
export const MAIN_EFFORT_SHARE = 0.9;

/** 本体のリクエスト数: モデル → 推論強度 → リクエスト数(要約の exec.mainModelEfforts) */
export type MainRequests = Record<string, Record<string, number>>;

/**
 * decided = 本体のリクエストの MAIN_EFFORT_SHARE 以上が同じ組、mixed = 本体のリクエストはあるがどの組も届かない、
 * none = 本体のリクエストの記録が無い(古い sessions.json・終了時の累計だけ)か、いちばん多い組の強度が不明
 */
export type MainEffort = { kind: 'decided'; model: string; effort: string } | { kind: 'mixed' } | { kind: 'none' };

/** exec.mainModelEfforts から本体の (モデル, 推論強度) を決める */
export function mainEffortOf(main: MainRequests | undefined | null): MainEffort {
  let total = 0;
  let best: { model: string; effort: string; n: number } | null = null;
  for (const [model, by] of Object.entries(main ?? {})) {
    for (const [effort, n] of Object.entries(by)) {
      total += n;
      if (!best || n > best.n) best = { model, effort, n };
    }
  }
  if (best && total > 0 && best.n / total >= MAIN_EFFORT_SHARE) return best.effort === UNKNOWN_KEY ? { kind: 'none' } : { kind: 'decided', model: best.model, effort: best.effort };
  return total > 0 ? { kind: 'mixed' } : { kind: 'none' };
}

/** 本体のリクエストがあるモデル(セッションの判定とは別に、そのモデルのリクエストが 1 件でもあるか) */
export function mainModelsOf(main: MainRequests | undefined | null): string[] {
  return Object.entries(main ?? {})
    .filter(([, by]) => Object.values(by).some((n) => n > 0))
    .map(([m]) => m);
}
