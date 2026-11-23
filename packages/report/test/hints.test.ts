// 操作への案内の文(lib/hints.ts)と、画面にこのツールの中で判定する操作が残っていないこと
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

  it('判定ダイアログと詳細ページは、このツールの中で判定する操作を出さない(判定は外部の LLM に頼む)', () => {
    const actions = readFileSync(join(import.meta.dirname, '../src/app/components/JobActions.svelte'), 'utf8');
    const detail = readFileSync(join(import.meta.dirname, '../../../crates/atlas-report/assets/session-tools.js'), 'utf8');
    for (const gone of ['judge-method-tool', 'このツールが判定する', "kind: 'judge'", "kind: 'turn-judge'", "kind: 'task-link'"]) expect(actions).not.toContain(gone);
    for (const gone of ['detail-judge', 'judge-preview', "kind:'judge'", 'turn-judge']) expect(detail).not.toContain(gone);
  });
});
