// llm-wiki の参照の数え方。画面のどこ(集計明細・プロジェクト別・人別・課題 × 条件の利用の確認・改善点)でも、この関数で数える。
// 「参照した」= 索引の読み取り + 個別ページの読み取り + wiki の skill の呼び出し + そのほかの呼び出し(vault の検索・一覧など)が 1 回以上。
// 書き込みは入れない(書き込みだけのセッションは「書き込みだけ」で、参照したには入れない)。
// Rust の同じ判定は crates/atlas-core/src/wiki.rs の wiki_referenced(並びをそろえる。npm run parity:fixture の wiki で突き合わせる)。
// DOM や node: に依存しない。LLM は使わない。

/** セッションの wiki の回数。版 15 以前の埋め込みには otherCalls が無く、作りかけの値では wiki ごと無いことがある(どちらも 0 として読む) */
export interface WikiCounts {
  indexReads?: number;
  pageReads?: number;
  skillCalls?: number;
  writes?: number;
  otherCalls?: number;
}

const n = (v: number | undefined): number => v ?? 0;

/** 参照の回数(索引・個別ページ・wiki の skill・そのほかの呼び出しの和。書き込みは入れない) */
export function wikiReferenceCount(w: WikiCounts | null | undefined): number {
  return w ? n(w.indexReads) + n(w.pageReads) + n(w.skillCalls) + n(w.otherCalls) : 0;
}

/** wiki を参照したか */
export function wikiReferenced(w: WikiCounts | null | undefined): boolean {
  return wikiReferenceCount(w) > 0;
}

/** セッションの扱い: 参照した(書き込みもあってよい)/ 書き込みだけ / 参照なし(vault に触れていない) */
export type WikiKind = 'referenced' | 'write-only' | 'none';

export function wikiKind(w: WikiCounts | null | undefined): WikiKind {
  if (wikiReferenced(w)) return 'referenced';
  return n(w?.writes) > 0 ? 'write-only' : 'none';
}

/**
 * 集計の状態。counted = 数えた、not-counted = vault を指定せずに集計した(どのセッションも 0 だが「参照していない」の意味ではない)、
 * no-record = vault を指定していたかの記録が無い古い集計で、参照したセッションも無い(数えていないのか、参照していないのか分からない)
 */
export type WikiState = 'counted' | 'not-counted' | 'no-record';

/**
 * 集計の状態を決める。絞り込みで表示が変わらないよう、絞り込み前の全セッションで 1 度だけ決める。
 * wikiVaults: 参照を数えた vault の数(0 なら数えていない。古い集計では undefined)
 */
export function wikiState(sessions: readonly { wiki?: WikiCounts | null }[], wikiVaults: number | undefined): WikiState {
  if (wikiVaults === 0) return 'not-counted';
  if (wikiVaults === undefined && !sessions.some((s) => wikiReferenced(s.wiki))) return 'no-record';
  return 'counted';
}

/** vault を指定せずに集計したときの理由(crates/atlas-core/src/wiki.rs の WIKI_NOT_COUNTED と同じ文) */
export const WIKI_NOT_COUNTED = 'この集計では llm-wiki の vault を指定していないので、wiki の参照は数えていません(0 件という意味ではありません)。atlas.config.json の wikis で vault を指定して集計し直すと数えます。';

/** vault を指定していたかの記録が無く、参照したセッションも無いときの理由 */
export const WIKI_NO_RECORD = 'この集計には、llm-wiki の vault を指定していたかの記録がありません(集計し直すと記録されます)。wiki を参照したセッションが無いので、数えていないのか、参照していないのかは分かりません。';

/** 表(プロジェクト別・人別)で wiki の列を出さないときの短い断り。全文は集計明細などに出す */
export const WIKI_NOT_COUNTED_SHORT = 'wiki の列は出していません(この集計では wiki の参照を数えていません。理由は集計明細)。';
export const WIKI_NO_RECORD_SHORT = 'wiki の列は出していません(この集計では wiki の参照を数えたかどうかが分かりません。理由は集計明細)。';

/** 件数の代わりに出す理由の文。数えた集計では null */
export function wikiStateNote(state: WikiState): string | null {
  return state === 'not-counted' ? WIKI_NOT_COUNTED : state === 'no-record' ? WIKI_NO_RECORD : null;
}

/** 表で wiki の列を出さないときの短い断り。数えた集計では null */
export function wikiStateShortNote(state: WikiState): string | null {
  return state === 'not-counted' ? WIKI_NOT_COUNTED_SHORT : state === 'no-record' ? WIKI_NO_RECORD_SHORT : null;
}

/** 改善点の「llm-wiki の利用」の箱の件数(率は出さない) */
export interface WikiUsageSummary {
  /** セッションの数 */
  sessions: number;
  /** 参照したセッション(書き込みもあったものを含む) */
  referenced: number;
  /** そのうち書き込みもあったもの */
  referencedWithWrites: number;
  /** 書き込みだけのセッション */
  writeOnly: number;
  /** vault に触れていないセッション */
  none: number;
  /** 参照の内訳(全セッションの延べ)。索引の読み取り・個別ページの読み取り・wiki の skill の呼び出し・そのほかの呼び出し */
  indexReads: number;
  pageReads: number;
  skillCalls: number;
  otherCalls: number;
}

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
