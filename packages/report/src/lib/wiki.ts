// llm-wiki の参照の数え方。画面のどこ(集計明細・プロジェクト別・人別・課題 × 条件の利用の確認・改善点)でも、この関数で数える。
// 「参照した」= 索引の読み取り + 個別ページの読み取り + wiki の skill の呼び出し + そのほかの呼び出し(vault の検索・一覧など)が 1 回以上。
// 書き込みは入れない(書き込みだけのセッションは「書き込みだけ」で、参照したには入れない)。
// 数え方そのものは packages/core/src/wiki.ts にあり(extract のログ・詳細ページ・判定パケットも同じ関数で数える)、ここから再エクスポートする。
// DOM や node: に依存しない。LLM は使わない。
import { wikiKind, wikiReferenced, type WikiCounts, type WikiUsageSummary } from '../../../core/src/wiki.ts';

export { wikiReferenceCount, wikiReferenced, wikiTouched, wikiKind, wikiState, WIKI_NOT_COUNTED, WIKI_NO_RECORD, WIKI_NOT_COUNTED_SHORT, WIKI_NO_RECORD_SHORT, wikiStateNote, wikiStateShortNote, WIKI_JUDGED_PAGES_MAX, uniquePages, judgedWikiPages, wikiPageIndex, pageNumber } from '../../../core/src/wiki.ts';
export type { WikiCounts, WikiKind, WikiState, WikiUsageSummary, WikiPageIndex } from '../../../core/src/wiki.ts';

const n = (v: number | undefined): number => v ?? 0;

/** ページごとの表の 1 行 */
export interface WikiPageRow {
  page: string;
  /** そのページを読んだセッション */
  sessions: number;
  /** 参照率(読んだセッション ÷ wiki を参照したセッション)。分母が閾値に届かなければ null */
  share: number | null;
  /** LLM の見立ての件数(セッションの数) */
  yes: number;
  no: number;
  unknown: number;
  /** 判定が無い(判定していない・版 1 の判定・判定のパケットに載らなかった・項目が壊れていた) */
  unjudged: number;
  /** 役立った率(yes ÷ (yes + no))。yes + no が閾値に届かなければ null */
  helpfulRate: number | null;
  /** そのページを読んだセッション(渡したセッションの並びでの位置と、LLM の見立て。null は未判定)。渡した順 */
  readers: { index: number; verdict: WikiPageVerdictValue | null }[];
}

/** LLM の見立ての値(役立った・役立たなかった・分からない) */
export type WikiPageVerdictValue = 'yes' | 'no' | 'unknown';

/** ページごとの表 */
export interface WikiPageTable {
  /** wiki を参照したセッション(参照率の分母。wikiReferenced で数える) */
  referenced: number;
  /** 読んだセッションの多い順(同じならページの名前の順) */
  rows: WikiPageRow[];
}

/** ページごとの表で、wiki と判定の欄だけを使うセッションの形(ページは辞書の番号) */
export interface WikiPageSession {
  wiki?: (WikiCounts & { pages?: readonly number[] }) | null;
  judgment?: { wikiPages?: readonly (readonly [number, string])[] } | null;
}

/**
 * 渡したセッション(絞り込み後)で、ページごとの参照率と役立った率を数える。names はページの名前の辞書(ReportData.wikiPageNames)。
 * 参照率の分母は wiki を参照したセッション、役立った率の分母は役立った + 役立たなかった(分からない・未判定は入れない)。
 * どちらも分母が minSessions に届かなければ率を null にする(閾値は呼ぶ側が既存の定数で渡す)。
 * ログで数えた参照率と、LLM の見立ての役立った率は別の列のまま返す(1 つの点数にしない)
 */
export function wikiPageTable(sessions: readonly WikiPageSession[], names: readonly string[], minSessions: number): WikiPageTable {
  const referenced = sessions.filter((s) => wikiReferenced(s.wiki)).length;
  const rows = new Map<string, WikiPageRow>();
  const nameOf = (n: number): string => names[n] ?? `(ページ ${n})`;
  sessions.forEach((s, index) => {
    const pages = s.wiki?.pages ?? [];
    if (!pages.length) return;
    const verdicts = new Map((s.judgment?.wikiPages ?? []).map(([p, h]) => [nameOf(p), h] as const));
    for (const page of new Set(pages.map(nameOf))) {
      const r = rows.get(page) ?? rows.set(page, { page, sessions: 0, share: null, yes: 0, no: 0, unknown: 0, unjudged: 0, helpfulRate: null, readers: [] }).get(page)!;
      r.sessions++;
      const h = verdicts.get(page);
      const verdict = h === 'yes' || h === 'no' || h === 'unknown' ? h : null;
      if (verdict) r[verdict]++;
      else r.unjudged++;
      r.readers.push({ index, verdict });
    }
  });
  const list = [...rows.values()];
  for (const r of list) {
    r.share = referenced >= minSessions ? r.sessions / referenced : null;
    r.helpfulRate = r.yes + r.no >= minSessions ? r.yes / (r.yes + r.no) : null;
  }
  list.sort(bySessions);
  return { referenced, rows: list };
}

const byPage = (a: WikiPageRow, b: WikiPageRow): number => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0);
const bySessions = (a: WikiPageRow, b: WikiPageRow): number => b.sessions - a.sessions || byPage(a, b);

/** ページごとの表で並べ替えられる列 */
export type WikiPageSortKey = 'page' | 'sessions' | 'share' | 'yes' | 'no' | 'unknown' | 'unjudged' | 'helpfulRate';

/** ページごとの表を並べ替える(元は変えない)。率の null は向きにかかわらず最後。同じ値は読んだセッションの多い順、ページの名前の順 */
export function sortWikiPageRows(rows: readonly WikiPageRow[], key: WikiPageSortKey, asc: boolean): WikiPageRow[] {
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'page') return dir * byPage(a, b);
    const x = a[key];
    const y = b[key];
    if (x === null || y === null) return x === y ? bySessions(a, b) : x === null ? 1 : -1;
    return dir * (x - y) || bySessions(a, b);
  });
}

/**
 * ページの名前を表で短く出す: すべての名前に共通するフォルダ(/ 区切り)と、末尾の .md を除く。
 * 除くと同じ名前になるものがあれば .md は残す。prefix は除いたフォルダ(末尾の / を含む。無ければ '')
 */
export function shortPageNames(names: readonly string[]): { prefix: string; dropMd: boolean; short: Map<string, string> } {
  const dirs = names.map((n) => n.split('/').slice(0, -1));
  let common = dirs[0] ?? [];
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const prefix = common.length ? `${common.join('/')}/` : '';
  const rest = names.map((n) => n.slice(prefix.length));
  const stripped = rest.map((n) => n.replace(/\.md$/i, ''));
  const dropMd = new Set(stripped).size === new Set(rest).size && stripped.some((n, i) => n !== rest[i]);
  return { prefix, dropMd, short: new Map(names.map((n, i) => [n, dropMd ? stripped[i]! : rest[i]!])) };
}

/** 埋め込みの版が古く(ページの名前が無い)、ページごとの表を出さないときの理由 */
export const WIKI_PAGES_OLD_DATA = 'この画面のデータは、ページの名前を記録する前の版で作ったので、ページごとの表は出せません。集計し直すと出ます。';

/** 渡したセッション(絞り込み後)の件数と参照の内訳 */
export function wikiUsageSummary(sessions: readonly { wiki?: WikiCounts | null }[]): WikiUsageSummary {
  const r: WikiUsageSummary = { sessions: sessions.length, referenced: 0, referencedWithWrites: 0, writeOnly: 0, none: 0, indexReads: 0, pageReads: 0, skillCalls: 0, otherCalls: 0 };
  for (const { wiki: w } of sessions) {
    const kind = wikiKind(w);
    if (kind === 'referenced') {
      r.referenced++;
      if (n(w?.writes) > 0) r.referencedWithWrites++;
    } else if (kind === 'write-only') r.writeOnly++;
    else r.none++;
    r.indexReads += n(w?.indexReads);
    r.pageReads += n(w?.pageReads);
    r.skillCalls += n(w?.skillCalls);
    r.otherCalls += n(w?.otherCalls);
  }
  return r;
}
