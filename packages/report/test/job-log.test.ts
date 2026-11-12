// failureReason: 失敗した処理のログから、画面に出す理由を取り出す
import { describe, expect, it } from 'vitest';
import { failureReason, REASON_MAX } from '../src/lib/job-log.ts';

describe('failureReason', () => {
  it('最後の「atlas: 失敗しました: 」の後ろを返す(途中の行や、前の失敗は拾わない)', () => {
    expect(failureReason(['bundle: 判定済みの 2 件を除きました', 'atlas: 失敗しました: 前の失敗', 'やり直し', 'atlas: 失敗しました: sessions.json がありません'])).toBe('sessions.json がありません');
  });

  it('理由が複数行でも全部返す', () => {
    expect(failureReason(['atlas: 失敗しました: 置き換えられません(EBUSY)。', 'ほかのアプリが開いていないか確かめてください'])).toBe('置き換えられません(EBUSY)。\nほかのアプリが開いていないか確かめてください');
  });

  it('ATLAS_DEBUG で続くスタックは入れない。最後の行が空でも理由は取れる', () => {
    const log = ['atlas: 失敗しました: 読めません', 'Error: 読めません', '    at run (file:///x/main.ts:1:1)', '    at main (file:///x/main.ts:2:2)', ''];
    expect(failureReason(log)).toBe('読めません');
    expect(failureReason(['atlas: 失敗しました: 1 行目', '2 行目', 'TypeError: 1 行目', '2 行目', '    at f (x.ts:1:1)'])).toBe('1 行目\n2 行目');
  });

  it('その行が無いログ(捕まえられなかった例外・起動の失敗・空)では空を返す', () => {
    expect(failureReason([])).toBe('');
    expect(failureReason(['node:internal/process/promises:394', '      triggerUncaughtException(err, true);', 'Error: boom', '    at x (y.ts:1:1)', '', 'Node.js v24.0.0'])).toBe('');
    expect(failureReason(['起動できませんでした: spawn ENOENT'])).toBe('');
  });

  it('長すぎる理由は上限で切る', () => {
    const r = failureReason([`atlas: 失敗しました: ${'あ'.repeat(REASON_MAX + 50)}`]);
    expect(r).toHaveLength(REASON_MAX + 1);
    expect(r.endsWith('…')).toBe(true);
  });
});
