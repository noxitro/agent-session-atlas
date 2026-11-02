// セッションごとのメモ(<notes-dir>/memos/<id>.md)の形と抜粋(純関数)。
// ブラウザ側(一覧の抜粋)と Node 側(build / serve / CLI)の両方から使うので、DOM や node: に依存しない。
import { truncate } from './format.ts';

/** <notes-dir> の下のメモの置き場 */
export const MEMOS_DIR_NAME = 'memos';
/** 一覧に出す抜粋の字数(全文は atlas.html に埋め込まない) */
export const MEMO_EXCERPT_CHARS = 80;

export interface MemoSummary {
  /** 本文の先頭の読める 1 行(Markdown の印を除く) */
  excerpt: string;
  chars: number;
  /** 本文が参照している画像の数 */
  images: number;
  updatedAt: string | null;
}

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
/** Windows の予約名(拡張子が付いても同じ扱いになる) */
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
/** Windows で使えない文字、制御文字、先頭の .、末尾の . と空白 */
const BAD_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]|^\.|[. ]$/;
/** 手で置いたファイルの名前として使えるか(日本語や空白は通す。.. は先頭の . で落ちる) */
export const isSafeFileName = (name: string): boolean => !!name && !BAD_FILE_NAME.test(name) && !RESERVED_NAME.test(name);
/** ファイル名に使える id か */
export const isSafeMemoId = (id: string): boolean => SAFE_ID.test(id) && isSafeFileName(id);

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

/** 本文の先頭の読める 1 行。画像だけの行は [画像] とする */
export function memoExcerpt(text: string): string {
  let fenced = false;
  const lines = text.split(/\r?\n/);
  // 先頭の YAML front matter は本文ではない
  const close = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  for (const raw of lines.slice(close + 1)) {
    if (/^\s*([-*_]\s*){3,}$/.test(raw)) continue; // 区切り線
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw
      .replace(IMAGE_RE, '[画像]')
      .replace(LINK_RE, '$1')
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/\*\*|__|~~|`/g, '') // 語の中の _ や * は残す(session_id、2*3)
      .trim();
    if (line) return truncate(line, MEMO_EXCERPT_CHARS);
  }
  return '';
}

export function memoSummary(text: string, updatedAt: string | null): MemoSummary {
  return { excerpt: memoExcerpt(text), chars: [...text].length, images: [...text.matchAll(IMAGE_RE)].length, updatedAt };
}
