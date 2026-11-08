// 操作への案内の文(lib/hints.ts)と、判定ダイアログの回数の目安が judge の塊の大きさとそろっていること
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_LIMITS } from '../../judge/src/index.ts';
import { judgeHint, refreshHint } from '../src/lib/hints.ts';

describe('操作への案内', () => {
  it('serve の通常版はボタンの場所、共有用の file:// は atlas.bat、伏せ字版は何も出さない', () => {
    expect(judgeHint('工数', { editable: true, anonymized: false })).toBe('右上の「判定する…」で「工数」を選ぶと実行できます。');
    expect(judgeHint('依頼ごとの採用', { editable: false, anonymized: false })).toMatch(/atlas\.bat で開いた画面/);
    expect(judgeHint('工数', { editable: false, anonymized: true })).toBe('');
    expect(refreshHint({ editable: true, anonymized: false })).toMatch(/右上の「集計し直す」/);
    expect(refreshHint({ editable: false, anonymized: false })).toMatch(/atlas\.bat で集計し直す/);
    expect(refreshHint({ editable: false, anonymized: true })).toBe('');
  });

  it('判定ダイアログの「約 N 回以上の判定」に使う塊の大きさは judge の chunkTurns と同じ', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/app/components/JobActions.svelte'), 'utf8');
    expect(Number(/const TURN_CHUNK = (\d+);/.exec(src)?.[1])).toBe(DEFAULT_TURN_LIMITS.chunkTurns);
  });
});
