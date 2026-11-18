// 操作への案内の文(lib/hints.ts)と、判定ダイアログの回数の目安が judge の塊の大きさとそろっていること
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeHint, refreshHint } from '../src/lib/hints.ts';

describe('操作への案内', () => {
  it('serve から開いた画面はボタンの場所、file:// で開いたファイルは atlas.bat', () => {
    expect(judgeHint('工数', { editable: true })).toBe('右上の「判定する…」で「工数」を選ぶと実行できます。');
    expect(judgeHint('依頼ごとの採用', { editable: false })).toMatch(/atlas\.bat で開いた画面/);
    expect(refreshHint({ editable: true })).toMatch(/右上の「集計し直す」/);
    expect(refreshHint({ editable: false })).toMatch(/atlas\.bat で集計し直す/);
  });

  it('判定ダイアログの「約 N 回以上の判定」は、サーバが返す塊の大きさ(chunk)で割り、返さない古いサーバのときだけ judge の chunkTurns と同じ値にする', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/app/components/JobActions.svelte'), 'utf8');
    const detail = readFileSync(join(import.meta.dirname, '../../../crates/atlas-report/assets/session-tools.js'), 'utf8');
    // 判定の本体は Rust(crates/atlas-judge/src/turn_bundle.rs の DEFAULT_TURN_LIMITS。serve が judge-preview の chunk で返す)
    const rust = readFileSync(join(import.meta.dirname, '../../../crates/atlas-judge/src/turn_bundle.rs'), 'utf8');
    const chunkTurns = Number(/pub const DEFAULT_TURN_LIMITS: TurnLimits = TurnLimits \{[^}]*chunk_turns: (\d+)/.exec(rust)?.[1]);
    expect(chunkTurns).toBeGreaterThan(0);
    expect(Number(/const turnChunk = \$derived\(preview\?\.chunk && preview\.chunk > 0 \? preview\.chunk : (\d+)\);/.exec(src)?.[1])).toBe(chunkTurns);
    expect(Number(/function jchunk\(p\)\{return p\.chunk>0\?p\.chunk:(\d+)\}/.exec(detail)?.[1])).toBe(chunkTurns);
  });
});
