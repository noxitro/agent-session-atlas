// 「別のフォルダを開く」の置き場の場所(テストが出力を探すのに使う)。atlas の crates/atlas-cli/src/folders.rs と同じ決め方:
// <いつもの出力先>-folders/<フォルダ名(40 文字まで)>-<パスのハッシュの先頭 8 桁>/{out, folder.json, open.log, built.json}、
// メモは <メモの置き場>/folders/<同じキー>/
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

export interface FolderPaths {
  key: string;
  dir: string;
  out: string;
  notes: string;
  state: string;
  log: string;
  /** 前に集計したときの入力の印 */
  built: string;
}

/** フォルダごとの出力先の置き場(いつもの出力先の隣) */
export function foldersRootOf(localOut: string): string {
  return `${resolve(localOut)}-folders`;
}

/** 同じフォルダかを比べる形(Windows は大文字小文字を区別しない) */
function normalized(path: string): string {
  const p = resolve(path);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function folderKey(path: string): string {
  const slug =
    basename(resolve(path))
      .replace(/[^A-Za-z0-9぀-ヿ㐀-鿿_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'folder';
  return `${slug}-${createHash('sha256').update(normalized(path)).digest('hex').slice(0, 8)}`;
}

export function folderPaths(root: string, notesBase: string, path: string): FolderPaths {
  const key = folderKey(path);
  const dir = join(resolve(root), key);
  return { key, dir, out: join(dir, 'out'), notes: join(resolve(notesBase), 'folders', key), state: join(dir, 'folder.json'), log: join(dir, 'open.log'), built: join(dir, 'built.json') };
}
