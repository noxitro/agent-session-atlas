// atlas-notes/groups.json の読み書き(Node 側)。読み取りは壊れていてもエラーにせず警告にする。
// 書き込み(atlas group add / remove)は、壊れたファイルを上書きしない(直してもらう)。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseGroups, serializeGroups, type SessionGroup } from './lib/groups.ts';

export interface LoadedGroups {
  path: string;
  /** ファイルがあったか(無ければ groups は空で警告も無い) */
  exists: boolean;
  groups: SessionGroup[];
  warnings: string[];
}

export async function loadGroups(path: string): Promise<LoadedGroups> {
  if (!existsSync(path)) return { path, exists: false, groups: [], warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return { path, exists: true, groups: [], warnings: [`${path}: JSON として読めないため無視しました(${(e as Error).message})`] };
  }
  const parsed = parseGroups(raw, path);
  return { path, exists: true, ...parsed };
}

/** 読めない・形が違う箇所があるファイルは書き換えない(ユーザーの手書きを壊さない) */
export async function loadGroupsForWrite(path: string): Promise<SessionGroup[]> {
  const g = await loadGroups(path);
  if (g.warnings.length) throw new Error(`${path} に直す必要のある箇所があるため書き換えません:\n  ${g.warnings.join('\n  ')}`);
  return g.groups;
}

/** 一時ファイルに書いてから rename する(途中で止まっても groups.json が欠けない。同時に読む側も書きかけを見ない) */
export async function saveGroups(path: string, groups: SessionGroup[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, serializeGroups(groups));
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
