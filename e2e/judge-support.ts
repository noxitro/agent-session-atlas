// 判定の評価バンドル(atlas bundle)と judgments.json を確かめるための道具(e2e の phase3 が使う)。
// 本体(packages/judge)の定数と検査をそのまま使う(テストと本体で値を二重に持たない)。
import { DEFAULT_LIMITS } from '../packages/judge/src/index.ts';

export { DEFAULT_PER_PART, missingSections, packetFileName, packetSessionId, PACKET_SECTIONS, validateJudgments } from '../packages/judge/src/index.ts';
export type { BundleManifest, JudgmentItem, JudgmentsFile } from '../packages/judge/src/index.ts';

/** 1 パケットの文字数の上限の既定(packet.ts の DEFAULT_LIMITS.maxChars) */
export const DEFAULT_MAX_CHARS = DEFAULT_LIMITS.maxChars;
