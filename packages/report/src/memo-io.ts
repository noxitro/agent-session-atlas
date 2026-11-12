// セッションごとのメモの読み書き(Node 側)。1 セッション 1 ファイルの素の Markdown で、索引は持たない。
// 画像は <id>/ の下に内容のハッシュの名前で置き、本文からは相対パスで参照する(他の Markdown ビューアでもそのまま読める)。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { renameReplacing, UPLOAD_MEMO_FILE, UPLOAD_MEMO_IMAGES } from '../../core/src/index.ts';
import { extname, join } from 'node:path';
import { isSafeFileName, isSafeMemoId, MEMOS_DIR_NAME } from './lib/memo.ts';
import { renderMemoHtml } from './memo-render.ts';

export interface MemoFile {
  id: string;
  text: string;
  /** 本文の sha256 の先頭 16 桁(同時編集の検出に使う) */
  rev: string;
  updatedAt: string;
}

/** 画像 1 枚の上限(data: URI で詳細ページに埋め込むので大きくしない) */
export const MEMO_IMAGE_LIMIT = 10 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export const memosDir = (notesDir: string): string => join(notesDir, MEMOS_DIR_NAME);
export const memoRev = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function memoPath(dir: string, id: string): string {
  if (!isSafeMemoId(id)) throw new Error(`メモに使えないセッション id です: ${id}`);
  return join(dir, `${id}.md`);
}

async function readAt(path: string, id: string): Promise<MemoFile> {
  const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  return { id, text, rev: memoRev(text), updatedAt: (await stat(path)).mtime.toISOString() };
}

export async function readMemo(dir: string, id: string): Promise<MemoFile | null> {
  const path = memoPath(dir, id);
  return existsSync(path) ? readAt(path, id) : null;
}

/** 置き場のメモを全部読む(読めないファイルと、id に使えない名前は飛ばす) */
export async function loadMemoIndex(dir: string): Promise<Map<string, MemoFile>> {
  const out = new Map<string, MemoFile>();
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const id = e.name.slice(0, -3);
    if (!isSafeMemoId(id)) continue;
    try {
      out.set(id, await readAt(join(dir, e.name), id));
    } catch {
      /* 読めないファイルがあっても他のメモと build を止めない */
    }
  }
  return out;
}

/**
 * 保存する。空の本文はメモの削除(画像は残す)。baseRev が今の rev と違えば書かずに conflict を返す(null なら確かめない = CLI)。
 * 一時ファイルに書いてから rename する(途中で止まっても本文が欠けない)
 */
export async function saveMemo(dir: string, id: string, text: string, baseRev: string | null): Promise<{ memo: MemoFile | null; conflict: MemoFile | null }> {
  const path = memoPath(dir, id);
  const cur = await readMemo(dir, id);
  if (baseRev != null && baseRev !== (cur?.rev ?? '')) return { memo: cur, conflict: cur ?? { id, text: '', rev: '', updatedAt: '' } };
  if (!text.trim()) {
    await rm(path, { force: true });
    return { memo: null, conflict: null };
  }
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  try {
    await renameReplacing(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { memo: await readAt(path, id), conflict: null };
}

/** 先頭のバイトで画像の形式を判定する(Content-Type は信じない。svg は script を持てるので通さない) */
export function imageExt(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return '.gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

/** 画像を置いて、本文に挿入する Markdown を返す。同じ内容は同じ名前になる */
export async function saveMemoImage(dir: string, id: string, data: Buffer): Promise<{ name: string; markdown: string }> {
  memoPath(dir, id);
  const ext = imageExt(data);
  if (!ext) throw new Error('png / jpeg / gif / webp の画像だけ追加できます');
  const name = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}${ext}`;
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, name), data);
  return { name, markdown: `![画像](${id}/${name})` };
}

/**
 * 本文の画像の参照を data: URI にする。参照は <folder>/<名前> の形だけを受け、base/<folder>/ の直下の画像だけを読む
 * (.. や別のセッションのフォルダは読まない)。置き場のメモは base = 置き場・folder = id、送った人のメモは base = セッションのフォルダ・folder = atlas-memo
 */
function imageDataUri(base: string, folderName: string, href: string): string | null {
  let path: string;
  try {
    path = decodeURI(href).replace(/^\.\//, '');
  } catch {
    return null;
  }
  const [folder, name, ...rest] = path.split('/');
  if (folder !== folderName || !name || rest.length || !isSafeFileName(name)) return null;
  const mime = IMAGE_MIME[extname(name).toLowerCase()];
  const file = join(base, folderName, name);
  if (!mime || !existsSync(file)) return null;
  try {
    if (statSync(file).size > MEMO_IMAGE_LIMIT) return null; // 手で置いた画像にも同じ上限(詳細ページに埋め込むため)
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

export function renderMemo(dir: string, id: string, text: string): string {
  return renderMemoHtml(text, (href) => imageDataUri(dir, id, href));
}

/**
 * 送り先から集計したときの、送った人のメモ(写したセッションのフォルダ <stateDir>/<id>/atlas-memo.md)を読む。
 * 読むだけで、書き換えない(別のフォルダを開いた画面は読むだけ)。読めないもの・id に使えない名前・空のものは飛ばす
 */
export async function loadMemberMemos(stateDir: string, ids: Iterable<string>): Promise<Map<string, MemoFile>> {
  const out = new Map<string, MemoFile>();
  for (const id of ids) {
    if (!isSafeMemoId(id)) continue;
    const path = join(stateDir, id, UPLOAD_MEMO_FILE);
    if (!existsSync(path)) continue;
    try {
      const m = await readAt(path, id);
      if (m.text.trim()) out.set(id, m);
    } catch {
      /* 読めないファイルがあっても他のメモと build を止めない */
    }
  }
  return out;
}

/** 送った人のメモを HTML にする(画像は <stateDir>/<id>/atlas-memo/ の直下だけ) */
export function renderMemberMemo(stateDir: string, id: string, text: string): string {
  return renderMemoHtml(text, (href) => imageDataUri(join(stateDir, id), UPLOAD_MEMO_IMAGES, href));
}
