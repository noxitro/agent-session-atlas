// セッション一覧の検索(セッション ID の先頭か、題名の一部)。一覧の行を絞るだけで、集計の絞り込み(filter.ts)とは別。
// 題名は、一覧に出す名前(セッション名)と最初の依頼の文。
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

/** 語が ID に当たるか: ID の先頭(ID_PREFIX_MIN 文字以上)か、貼ったパスや URL のように語の中に ID が丸ごと入っている */
function hitsId(id: string, term: string): boolean {
  return (term.length >= ID_PREFIX_MIN && id.startsWith(term)) || (id.length >= 8 && term.includes(id));
}

/** 合ったときの理由。id = どれかの語が ID に当たった(一覧の行に ID を出す) */
export type SearchHit = 'id' | 'title';

type Searchable = Pick<SessionSummary, 'id' | 'name' | 'firstUserMessage'>;

/** セッションがすべての語に当たるか。語ごとに、ID か題名(名前・最初の依頼)のどちらかに当たればよい。合わなければ null */
export function matchSession(s: Searchable, terms: readonly string[]): SearchHit | null {
  const id = s.id.toLowerCase();
  const name = foldText(s.name ?? '');
  const first = foldText(s.firstUserMessage ?? '');
  let byId = false;
  for (const t of terms) {
    if (hitsId(id, t)) byId = true;
    else if (!name.includes(t) && !first.includes(t)) return null;
  }
  return byId ? 'id' : 'title';
}

/** 一覧の行を検索語で絞る。語が無ければ null(絞らない)。byId は ID で当たった行の id */
export function searchSessions<S extends Searchable>(sessions: readonly S[], query: string): { rows: S[]; byId: Set<string> } | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  const rows: S[] = [];
  const byId = new Set<string>();
  for (const s of sessions) {
    const hit = matchSession(s, terms);
    if (!hit) continue;
    rows.push(s);
    if (hit === 'id') byId.add(s.id);
  }
  return { rows, byId };
}
