// 一時ファイルを本来の名前に置き換える rename。Windows では、置き換え先を別のプロセス(ウイルス対策の検査や、同時に読んでいる側)が
// 開いている間、rename が EPERM / EACCES / EBUSY で一時的に失敗する。少し待ってやり直す(graceful-fs の polyfills.js と同じ考え方)
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

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

/**
 * 前に作ったもの(フォルダーやファイル)を消す。ほかのプログラム(ウイルス対策・検索の索引・開いたままのアプリ)がファイルを一時的に
 * 掴んでいると Windows では EBUSY / EPERM / ENOTEMPTY になるので、少し待ってやり直す。無ければ何もしない。
 * やり直しはフォルダーとその中のファイルの両方で数えられるので、待ちは掛け算で延びる:
 * この指定で、フォルダーの直下のファイルが掴まれ続けたときに諦めるまで約 3 秒(maxRetries 5 / retryDelay 200 だと約 21 秒で、画面が長く止まって見える)
 */
export function removeTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** 作りかけを置く場所と、入れ替えの間だけ前のものを退ける場所(どちらも dir の直下) */
const SWAP_STAGE = '.next';
const SWAP_PREV = '.prev';

/**
 * dir の直下の決まった名前(names)を作り直す。build に渡す作りかけの場所へ全部を作り終えてから、前のものと入れ替える。
 * names に無いものには触らない(dir は利用者が指定した既存のフォルダーかもしれないので、フォルダーごとは置き換えない)。
 * - build が失敗したり、途中でプロセスが止められたりしても、前のものはそのまま使える(作りかけは消す。残っても次に作るときに消す)
 * - 作りかけの場所に無い名前は、前のものを消すだけになる
 * - names の先頭は一覧(それがあれば「できている」と読まれるファイル)。最初に退けて最後に入れるので、入れ替えの途中でプロセスが
 *   止まっても「一覧はあるのに、それが指すファイルが無い・古い」にはならない
 * - 前のものを退けられない(ほかのアプリが中のファイルを開いている、書き込めない)ときは、退けた分を戻してから投げる
 */
export async function replaceEntries<T>(dir: string, names: readonly string[], build: (stage: string) => Promise<T>): Promise<T> {
  const stage = join(dir, SWAP_STAGE);
  const prev = join(dir, SWAP_PREV);
  await removeTree(stage);
  await removeTree(prev);
  await mkdir(stage, { recursive: true });
  try {
    const result = await build(stage);
    await swap(dir, stage, prev, names);
    return result;
  } finally {
    // 作りかけ(入れ替えで残った空のフォルダーも)は、成功でも失敗でも残さない
    await removeTree(stage).catch(() => {});
  }
}

async function swap(dir: string, stage: string, prev: string, names: readonly string[]): Promise<void> {
  await mkdir(prev, { recursive: true });
  const out: string[] = [];
  const moved: string[] = [];
  try {
    for (const n of names) {
      if (!existsSync(join(dir, n))) continue;
      await renameReplacing(join(dir, n), join(prev, n));
      out.push(n);
    }
    for (const n of [...names].reverse()) {
      if (!existsSync(join(stage, n))) continue;
      await renameReplacing(join(stage, n), join(dir, n));
      moved.push(n);
    }
  } catch (e) {
    // 元に戻す: 入れた新しいものを作りかけの場所へ返し、退けた前のものを戻す(一覧は最後)
    let restored = true;
    const back = (from: string, to: string): Promise<void> =>
      rename(from, to).catch(() => {
        restored = false;
      });
    for (const n of moved.reverse()) await back(join(dir, n), join(stage, n));
    for (const n of out.reverse()) await back(join(prev, n), join(dir, n));
    if (restored) await removeTree(prev).catch(() => {});
    const kept = restored ? '前の内容はそのまま残しています' : `前の内容を戻しきれませんでした(一部は ${prev} にあります)`;
    throw new Error(`${dir} の中身を置き換えられません(${(e as Error).message})。ほかのアプリがその中のファイルを開いたままにしていないか、書き込める場所かを確かめてください。${kept}`, { cause: e });
  }
  // 片付けは失敗しても入れ替えは済んでいる(残りは次に作るときに消す)
  await removeTree(prev).catch(() => {});
}
