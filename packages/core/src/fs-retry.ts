// 一時ファイルを本来の名前に置き換える rename。Windows では、置き換え先を別のプロセス(ウイルス対策の検査や、同時に読んでいる側)が
// 開いている間、rename が EPERM / EACCES / EBUSY で一時的に失敗する。少し待ってやり直す(graceful-fs の polyfills.js と同じ考え方)
import { rename } from 'node:fs/promises';

/** やり直しをあきらめるまでの合計の待ち時間(ms) */
const RENAME_RETRY_MS = 3000;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameReplacing(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(from, to);
    return;
  }
  const start = Date.now();
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '') || Date.now() - start + wait > RENAME_RETRY_MS) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
