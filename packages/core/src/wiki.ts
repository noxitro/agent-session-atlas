// ナレッジ vault(llm-wiki)参照の分類。どの vault をどの形式で数えるかは WikiSpec で指定する
import type { WikiUsage } from './types.ts';

/** 参照を数える vault 1 つの指定。index / pages / extensions の省略時は DEFAULT_FORMAT */
export interface WikiSpec {
  /** vault のフォルダ名か、その末尾を含むパス(例: my-notes、D:/notes/my-notes) */
  path: string;
  /** 索引のファイル(vault からの相対パス) */
  index?: string[];
  /** 個別ページを置くフォルダ(vault からの相対パス)。'.' は vault 全体 */
  pages?: string[];
  /** 個別ページの拡張子 */
  extensions?: string[];
  /** wiki の skill 名。省略すると名前では数えない */
  skills?: string[];
}

/** 形式を省略したときの値(特定の vault の構成を前提にしない) */
const DEFAULT_FORMAT = { index: ['index.md'], pages: ['.'], extensions: ['.md'] };

const WRITE_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace_editor']);
/** パスの名前に使われる文字。vault 名の前後がこれだと別のフォルダとみなす(my-notes-app を my-notes に数えない) */
const NAME_CHAR = '[\\p{L}\\p{N}_-]';

interface CompiledWiki {
  label: string;
  /** vault の位置 */
  marker: RegExp;
  index: RegExp | null;
  page: RegExp | null;
}

export function emptyWiki(): WikiUsage {
  return { indexReads: 0, pageReads: [], skillCalls: [], writes: 0, otherCalls: 0 };
}

/** vault に書き込むツールか(書き込みは参照に数えない。判定のパケットの抜粋にも使わない) */
export const isWriteTool = (name: string): boolean => WRITE_TOOLS.has(name);

/** セッションの記録の wiki(ページと skill は呼び出しの一覧)を、回数の形にする */
export const wikiCountsOf = (w: WikiUsage): WikiCounts => ({ indexReads: w.indexReads, pageReads: w.pageReads.length, skillCalls: w.skillCalls.length, writes: w.writes, otherCalls: w.otherCalls });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 区切りを / にそろえて連続もまとめる */
const normPath = (s: string): string => s.replace(/[\\/]+/g, '/');
const trimPath = (s: string): string => normPath(s).replace(/^(\.\/)+/, '').replace(/\/$/, '');

/** ツール引数の文字列値だけをつなぐ(JSON にすると改行が \n のまま残り、パスの区切りと見分けられない) */
function argText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) return args.map(argText).join('\n');
  if (args && typeof args === 'object') return Object.values(args).map(argText).join('\n');
  return '';
}

function compile(spec: WikiSpec): CompiledWiki {
  const path = trimPath(spec.path);
  const vault = `(?<!${NAME_CHAR}|\\.)${escapeRe(path)}(?!${NAME_CHAR}|\\.[\\p{L}\\p{N}])`;
  const index = (spec.index ?? DEFAULT_FORMAT.index).map((f) => escapeRe(trimPath(f)));
  const dirs = (spec.pages ?? DEFAULT_FORMAT.pages).map(trimPath);
  const exts = (spec.extensions ?? DEFAULT_FORMAT.extensions).map((e) => escapeRe(e.replace(/^\./, '')));
  const prefix = dirs.some((d) => d === '' || d === '.') ? '' : `(?:${dirs.map((d) => `${escapeRe(d)}/`).join('|')})`;
  return {
    label: path.split('/').pop() ?? path,
    marker: new RegExp(vault, 'iu'),
    index: index.length ? new RegExp(`${vault}/(?:${index.join('|')})(?!${NAME_CHAR}|\\.)`, 'iu') : null,
    page: dirs.length && exts.length ? new RegExp(`${vault}/(${prefix}[^"'\`*?<>|:\\n]+?\\.(?:${exts.join('|')}))(?!${NAME_CHAR})`, 'giu') : null,
  };
}

/** 指定の vault に対してツール呼び出しと skill を分類する。指定が無ければ何も数えない */
export class WikiClassifier {
  private readonly wikis: CompiledWiki[];
  private readonly skills: Set<string>;

  constructor(specs: WikiSpec[] = []) {
    this.wikis = specs.map(compile);
    this.skills = new Set(specs.flatMap((s) => s.skills ?? []));
  }

  /** 名前か、skill のファイルの場所から wiki の skill か判定する */
  isSkill(name: string, path?: unknown): boolean {
    return this.skills.has(name) || this.find(normPath(String(path ?? ''))) != null;
  }

  private find(text: string): CompiledWiki | undefined {
    return this.wikis.find((w) => w.marker.test(text));
  }

  /**
   * ツール呼び出し 1 件を分類して w に加える。対象でなければ false。
   * - skill: 引数に vault を含むか、skill 名が指定のもの
   * - 書き込み系ツール: writes
   * - 索引を含む: indexReads
   * - ページのフォルダ配下: pageReads(vault からの相対パス。vault が複数なら先頭に vault 名)
   * - それ以外(log.md、glob 等): otherCalls
   */
  classify(w: WikiUsage, toolName: string, args: unknown): boolean {
    const text = normPath(argText(args));
    const vault = this.find(text);
    if (toolName === 'skill') {
      const skill = typeof (args as any)?.skill === 'string' ? (args as any).skill : '';
      if (!vault && !this.skills.has(skill)) return false;
      w.skillCalls.push(skill || '(unknown)');
      return true;
    }
    if (!vault) return false;
    if (WRITE_TOOLS.has(toolName)) {
      w.writes++;
      return true;
    }
    if (vault.index?.test(text)) {
      w.indexReads++;
      return true;
    }
    const pages = vault.page ? [...text.matchAll(vault.page)].map((m) => m[1]!) : [];
    if (pages.length > 0) {
      for (const p of new Set(pages)) w.pageReads.push(this.wikis.length > 1 ? `${vault.label}/${p}` : p);
      return true;
    }
    w.otherCalls++;
    return true;
  }
}

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

/** vault に触れたか(参照か書き込みが 1 回以上)。詳細ページの欄を出すか・判定パケットの「参照なし」・metrics.json の sessionsWithAny だけに使う */
export function wikiTouched(w: WikiCounts | null | undefined): boolean {
  return wikiReferenced(w) || n(w?.writes) > 0;
}

/** セッションの扱い: 参照した(書き込みもあってよい)/ 書き込みだけ / 参照なし(vault に触れていない) */
export type WikiKind = 'referenced' | 'write-only' | 'none';

export function wikiKind(w: WikiCounts | null | undefined): WikiKind {
  if (wikiReferenced(w)) return 'referenced';
  return n(w?.writes) > 0 ? 'write-only' : 'none';
}

/**
 * 集計の状態。counted = 数えた、not-counted = vault を指定せずに集計した(どのセッションも 0 だが「参照していない」の意味ではない)、
 * no-record = vault を指定していたかの記録が無い古い集計で、vault に触れた(参照か書き込みをした)セッションも無い(数えていないのか、使っていないのか分からない)。
 * 書き込みだけのセッションがあれば vault は指定されていた(数えた)と分かるので counted。
 */
export type WikiState = 'counted' | 'not-counted' | 'no-record';

/**
 * 集計の状態を決める。絞り込みで表示が変わらないよう、絞り込み前の全セッションで 1 度だけ決める。
 * wikiVaults: 参照を数えた vault の数(0 なら数えていない。古い集計では undefined)
 */
export function wikiState(sessions: readonly { wiki?: WikiCounts | null }[], wikiVaults: number | undefined): WikiState {
  if (wikiVaults === 0) return 'not-counted';
  if (wikiVaults === undefined && !sessions.some((s) => wikiTouched(s.wiki))) return 'no-record';
  return 'counted';
}

/** vault を指定せずに集計したときの理由 */
export const WIKI_NOT_COUNTED = 'この集計では llm-wiki の vault を指定していないので、wiki の参照は数えていません(0 件という意味ではありません)。atlas.config.json の wikis で vault を指定して集計し直すと数えます。';

/** vault を指定していたかの記録が無く、vault に触れたセッションも無いときの理由 */
export const WIKI_NO_RECORD = 'この集計には、llm-wiki の vault を指定していたかの記録がありません(集計し直すと記録されます)。wiki を参照・書き込みしたセッションが無いので、数えていないのか、使っていないのかは分かりません。';

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

/**
 * LLM にページごとの「役立ったか」を判定させるページの数の上限(1 セッション)。読んだ順に先頭からこの数だけ判定のパケットに載せ、
 * 残りは判定しない(未判定)。判定のパケット(packages/judge の packet.ts)と、判定を読むレポート(パケットに無いページの判定を捨てる)の両方がこの数で決める
 */
export const WIKI_JUDGED_PAGES_MAX = 10;

/** 読んだページの名前を、重複を除いて読んだ順に(pageReads は呼び出しごとに足すので、同じページが何度も入る) */
export function uniquePages(pageReads: readonly string[]): string[] {
  return [...new Set(pageReads)];
}

/** 判定のパケットに載せるページ(重複を除いて読んだ順の先頭 WIKI_JUDGED_PAGES_MAX 件) */
export function judgedWikiPages(pageReads: readonly string[]): string[] {
  return uniquePages(pageReads).slice(0, WIKI_JUDGED_PAGES_MAX);
}

/**
 * 埋め込みの llm-wiki のページの名前の辞書(ReportData.wikiPageNames)。全セッションの読んだページを、セッションの並び・読んだ順に重複なく並べる。
 * 要約は名前の代わりにこの番号を持つ
 */
export interface WikiPageIndex {
  names: string[];
  byName: ReadonlyMap<string, number>;
}

export function wikiPageIndex(records: readonly { wiki: { pageReads: readonly string[] } }[]): WikiPageIndex {
  const byName = new Map<string, number>();
  const names: string[] = [];
  for (const r of records)
    for (const p of uniquePages(r.wiki.pageReads))
      if (!byName.has(p)) {
        byName.set(p, names.length);
        names.push(p);
      }
  return { names, byName };
}

/** ページの番号。辞書は要約するセッションすべてから作るので、無いのは呼び方の誤り */
export function pageNumber(ix: WikiPageIndex, page: string): number {
  const n = ix.byName.get(page);
  if (n === undefined) throw new Error(`llm-wiki のページの辞書に ${page} がありません(辞書は要約するセッションすべてから作ること)`);
  return n;
}
