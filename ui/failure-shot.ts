// 画面テストが落ちたとき、その時点の画面を out/ui-failures/<テスト名>.png に残す(CI は成果物として上げる。.github/workflows/ci.yml)。
// CI でだけ落ちる競合は、ログの 1 行だけでは何が出ていたか分からないため。
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { TestContext } from 'vitest';
import { ROOT } from '../e2e/fixture-home.ts';

export const FAILURE_DIR = join(ROOT, 'out', 'ui-failures');

/** beforeEach から呼ぶ: このテストが落ちたら、page の全体のスクリーンショットと URL を残す */
export function shotOnFailure(ctx: TestContext, page: () => Page | undefined): void {
  ctx.onTestFailed(async () => {
    const p = page();
    if (!p || p.isClosed()) return;
    const name = ctx.task.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80);
    try {
      await mkdir(FAILURE_DIR, { recursive: true });
      await p.screenshot({ path: join(FAILURE_DIR, `${name}.png`), fullPage: true, timeout: 10_000 });
      console.log(`ui: 落ちたときの画面を ${join(FAILURE_DIR, `${name}.png`)} に残しました(${p.url()})`);
    } catch {
      /* 残せなくてもテストの結果は変えない */
    }
  });
}
