// セッション一覧の検索(セッション ID の先頭か、題名の一部)。一覧の行を絞るだけで、集計の絞り込み(filter.ts)とは別。
// 題名は、一覧に出す名前(セッション名)と最初の依頼の文。どちらもレポートのデータには先頭 160 字までしか入っていない
// (crates/atlas-report/src/summarize.rs の SUMMARY_TEXT_CHARS)ので、その先の文では当たらない。
import type { SessionSummary } from './types.ts';

/** 比べるときの形: 全角と半角・大文字と小文字をそろえ、続く空白を 1 つにする */
export const foldText = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** 検索語(空白で区切った語。重複は除く)。すべての語に当たる行が合う */
export function searchTerms(query: string): string[] {
  return [...new Set(foldText(query).split(' ').filter(Boolean))];
}

/**
 * ID の先頭として比べる語の最短の長さ。ID は 16 進の文字が並ぶので、短い語(「11」「add」など)だと題名に無い行まで偶然当たる。
 * 4 文字なら、偶然当たるのは 6 万分の 1 ほど
 */
export const ID_PREFIX_MIN = 4;

/** 合ったときの中身。id = ID で当たった(一覧の行に ID を出す)。firstTerm = 名前に無く、最初の依頼にだけあった語(行にその辺りの文を出す) */
export interface SearchHit {
  id: boolean;
  firstTerm: string | null;
}

type Searchable = Pick<SessionSummary, 'id' | 'name' | 'firstUserMessage'>;

/**
 * セッションが検索に合うか。合わなければ null。
 * - 検索の文の中に ID が丸ごと入っていれば合う(貼ったパスや URL。パスに空白があっても、語に分ける前の文で探す)
 * - そうでなければ、空白で区切った語ごとに、ID の先頭(ID_PREFIX_MIN 文字以上)か、題名(名前・最初の依頼)の一部に当たればよい
 * folded は foldText(検索の文)、terms は searchTerms(検索の文)
 */
export function matchSession(s: Searchable, terms: readonly string[], folded: string): SearchHit | null {
  const id = s.id.toLowerCase();
  if (id.length >= 8 && folded.includes(id)) return { id: true, firstTerm: null };
  const name = foldText(s.name ?? '');
  const first = foldText(s.firstUserMessage ?? '');
  let byId = false;
  let firstTerm: string | null = null;
  for (const t of terms) {
    if (t.length >= ID_PREFIX_MIN && id.startsWith(t)) byId = true;
    else if (name.includes(t)) continue;
    else if (first.includes(t)) firstTerm ??= t;
    else return null;
  }
  // 名前が無い行は、最初の依頼がそのまま題名として出ているので、改めて出さない
  return { id: byId, firstTerm: name ? firstTerm : null };
}

/** 一覧の行を検索で絞る。語が無ければ null(絞らない)。byId は ID で当たった行、viaFirst は最初の依頼にだけあった語(行の id → 語) */
export function searchSessions<S extends Searchable>(sessions: readonly S[], query: string): { rows: S[]; byId: Set<string>; viaFirst: Map<string, string> } | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  const folded = foldText(query);
  const rows: S[] = [];
  const byId = new Set<string>();
  const viaFirst = new Map<string, string>();
  for (const s of sessions) {
    const hit = matchSession(s, terms, folded);
    if (!hit) continue;
    rows.push(s);
    if (hit.id) byId.add(s.id);
    if (hit.firstTerm) viaFirst.set(s.id, hit.firstTerm);
  }
  return { rows, byId, viaFirst };
}

/** 検索語が ID の一部のつもりらしいか(16 進の数字とハイフンだけ)。合わなかったときに、ID の探し方を添えるのに使う */
export const looksLikeId = (term: string): boolean => /^[0-9a-f-]+$/.test(term);

/**
 * 文の中の、語のある辺りを width 文字で切り出す(前後を切ったら「…」)。語は foldText した形で、文は全角半角をそろえて空白を詰めた形で出す。
 * 語が見つからなければ先頭から
 */
export function excerptAround(text: string, term: string, width = 60): string {
  const cps = [...text.normalize('NFKC').replace(/\s+/g, ' ').trim()];
  const lower = cps.map((c) => c.toLowerCase());
  let at = 0;
  for (let i = 0; i < lower.length; i++) {
    if (lower.slice(i, i + term.length).join('').startsWith(term)) {
      at = i;
      break;
    }
  }
  const start = Math.max(0, Math.min(at - 15, cps.length - width));
  const end = Math.min(cps.length, start + width);
  return `${start > 0 ? '…' : ''}${cps.slice(start, end).join('')}${end < cps.length ? '…' : ''}`;
}
