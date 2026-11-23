// llm-wiki の参照の数え方(lib/wiki.ts)と、それを使う集計(lib/aggregate.ts の sessionsWithWiki)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { bucket } from '../src/lib/aggregate.ts';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter } from '../src/lib/filter.ts';
import type { SessionSummary } from '../src/lib/types.ts';
import {
  WIKI_NO_RECORD,
  WIKI_NO_RECORD_SHORT,
  WIKI_NOT_COUNTED,
  WIKI_NOT_COUNTED_SHORT,
  wikiKind,
  wikiReferenceCount,
  wikiReferenced,
  wikiState,
  wikiStateNote,
  wikiStateShortNote,
  wikiUsageSummary,
  judgedWikiPages,
  uniquePages,
  WIKI_JUDGED_PAGES_MAX,
  wikiPageTable,
  wikiPageIndex,
  pageNumber,
  shortPageNames,
  sortWikiPageRows,
  type WikiCounts,
  type WikiPageRow,
  type WikiPageSession,
  type WikiPageTable,
} from '../src/lib/wiki.ts';

const w = (o: WikiCounts = {}): Required<WikiCounts> => ({ indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0, otherCalls: 0, ...o });

describe('wiki を参照したか', () => {
  it('索引・個別ページ・wiki の skill・そのほかの呼び出しのどれか 1 回で参照した。書き込みは入れない', () => {
    expect(wikiReferenced(w())).toBe(false);
    for (const k of ['indexReads', 'pageReads', 'skillCalls', 'otherCalls'] as const) expect(wikiReferenced(w({ [k]: 1 })), k).toBe(true);
    expect(wikiReferenced(w({ writes: 3 }))).toBe(false);
    expect(wikiReferenceCount(w({ indexReads: 1, pageReads: 2, skillCalls: 3, otherCalls: 4, writes: 5 }))).toBe(10);
  });
  it('wiki が無い入力と otherCalls の無い古い形は 0 として読む', () => {
    expect(wikiReferenceCount(undefined)).toBe(0);
    expect(wikiReferenceCount(null)).toBe(0);
    expect(wikiReferenceCount({ indexReads: 1, pageReads: 0, skillCalls: 0, writes: 0 })).toBe(1);
    expect(wikiReferenced({ writes: 1 })).toBe(false);
  });
  it('扱い: 参照した / 書き込みだけ / 参照なし', () => {
    expect(wikiKind(w({ otherCalls: 1 }))).toBe('referenced');
    expect(wikiKind(w({ pageReads: 1, writes: 2 }))).toBe('referenced');
    expect(wikiKind(w({ writes: 2 }))).toBe('write-only');
    expect(wikiKind(w())).toBe('none');
    expect(wikiKind(undefined)).toBe('none');
  });
});

describe('集計の状態', () => {
  const read = { wiki: w({ indexReads: 1 }) };
  const writeOnly = { wiki: w({ writes: 1 }) };
  const none = { wiki: w() };
  it('vault の数が 0 なら、参照したセッションがあっても数えていない', () => {
    expect(wikiState([read, none], 0)).toBe('not-counted');
    expect(wikiState([], 0)).toBe('not-counted');
  });
  it('vault の数の記録が無い古い集計: vault に触れたセッションが無ければ記録なし、あれば数えた', () => {
    expect(wikiState([none], undefined)).toBe('no-record');
    expect(wikiState([], undefined)).toBe('no-record');
    expect(wikiState([none, read], undefined)).toBe('counted');
    // 書き込みだけのセッションがあれば vault は指定されていた
    expect(wikiState([none, writeOnly], undefined)).toBe('counted');
  });
  it('vault を指定した集計は、参照したセッションが無くても数えた', () => {
    expect(wikiState([none], 1)).toBe('counted');
    expect(wikiState([], 2)).toBe('counted');
  });
  it('理由の文は数えていない・記録なしのときだけ', () => {
    expect(wikiStateNote('not-counted')).toBe(WIKI_NOT_COUNTED);
    expect(wikiStateNote('no-record')).toBe(WIKI_NO_RECORD);
    expect(wikiStateNote('counted')).toBeNull();
    // 0 件と読まれないように書く
    expect(WIKI_NOT_COUNTED).toMatch(/0 件という意味ではありません/);
  });
  it('表で wiki の列を出さないときの短い断りも、数えていない・記録なしで分ける', () => {
    expect(wikiStateShortNote('not-counted')).toBe(WIKI_NOT_COUNTED_SHORT);
    expect(wikiStateShortNote('no-record')).toBe(WIKI_NO_RECORD_SHORT);
    expect(wikiStateShortNote('counted')).toBeNull();
    // 記録なしでは、数えていないと言い切らない
    expect(WIKI_NO_RECORD_SHORT).not.toMatch(/数えていません/);
  });
});

describe('改善点の llm-wiki の利用の件数', () => {
  it('参照した(うち書き込みもあり)/ 書き込みだけ / 参照なし と、参照の内訳の延べ', () => {
    const r = wikiUsageSummary([
      { wiki: w({ indexReads: 1, pageReads: 2 }) },
      { wiki: w({ skillCalls: 1, writes: 3 }) },
      { wiki: w({ otherCalls: 2 }) },
      { wiki: w({ writes: 1 }) },
      { wiki: w() },
      {},
    ]);
    expect(r).toEqual({ sessions: 6, referenced: 3, referencedWithWrites: 1, writeOnly: 1, none: 2, indexReads: 1, pageReads: 2, skillCalls: 1, otherCalls: 2 });
    expect(r.referenced + r.writeOnly + r.none).toBe(r.sessions);
  });
  it('セッションが無ければ全部 0', () => {
    expect(wikiUsageSummary([])).toEqual({ sessions: 0, referenced: 0, referencedWithWrites: 0, writeOnly: 0, none: 0, indexReads: 0, pageReads: 0, skillCalls: 0, otherCalls: 0 });
  });
});

describe('llm-wiki のページごとの参照率と役立った率', () => {
  const MIN = 3;
  /** ページの名前の辞書(埋め込みの ReportData.wikiPageNames。要約は番号で持つ) */
  const NAMES = ['a.md', 'b.md', 'z.md', 'other.md'];
  const num = (p: string): number => NAMES.indexOf(p);
  /** 読んだページと、その判定(無ければ未判定。judgment: null は判定していないセッション) */
  const s = (pages: string[], verdicts?: [string, 'yes' | 'no' | 'unknown'][] | null): WikiPageSession => ({
    wiki: w({ pageReads: pages.length, indexReads: pages.length ? 0 : 1 }),
    judgment: verdicts === null ? null : { wikiPages: verdicts?.map(([p, h]) => [num(p), h] as const) },
  });
  const withPages = (x: WikiPageSession, pages: string[]): WikiPageSession => ({ ...x, wiki: { ...x.wiki, pages: pages.map(num) } });
  const row = (t: WikiPageTable, page: string) => t.rows.find((r) => r.page === page)!;

  it('参照率の分母は wiki を参照したセッション(ページを読んでいない参照も入る)。書き込みだけは入れない', () => {
    const t = wikiPageTable(
      [
        withPages(s(['a.md']), ['a.md']),
        withPages(s(['a.md', 'b.md']), ['a.md', 'b.md']),
        s([]), // 索引だけ
        { wiki: w({ writes: 1 }) }, // 書き込みだけ
        withPages(s(['b.md']), ['b.md']),
        { wiki: w() },
      ],
      NAMES,
      MIN,
    );
    expect(t.referenced).toBe(4);
    expect(t.rows.map((r) => [r.page, r.sessions, r.share])).toEqual([
      ['a.md', 2, 0.5],
      ['b.md', 2, 0.5],
    ]);
  });
  it('分母が閾値に届かなければ率は null(—)', () => {
    const t = wikiPageTable([withPages(s(['a.md'], [['a.md', 'yes']]), ['a.md']), withPages(s(['a.md'], [['a.md', 'yes']]), ['a.md'])], NAMES, MIN);
    expect(t.referenced).toBe(2);
    expect(row(t, 'a.md')).toMatchObject({ sessions: 2, share: null, yes: 2, helpfulRate: null });
  });
  it('役立った率 = 役立った ÷ (役立った + 役立たなかった)。分からない・未判定は分母に入れず、件数を並べる', () => {
    const a = (v?: [string, 'yes' | 'no' | 'unknown'][] | null): WikiPageSession => withPages(s(['a.md'], v), ['a.md']);
    const t = wikiPageTable(
      [
        a([['a.md', 'yes']]),
        a([['a.md', 'yes']]),
        a([['a.md', 'no']]),
        a([['a.md', 'unknown']]),
        a(null), // 判定していない
        a(undefined), // 版 1 の判定(wikiPages なし)
        a([['other.md', 'yes']]), // そのページの判定が無い(パケットに載らなかった等)
      ],
      NAMES,
      MIN,
    );
    expect(row(t, 'a.md')).toEqual({
      page: 'a.md',
      sessions: 7,
      share: 1,
      yes: 2,
      no: 1,
      unknown: 1,
      unjudged: 3,
      helpfulRate: 2 / 3,
      readers: [
        { index: 0, verdict: 'yes' },
        { index: 1, verdict: 'yes' },
        { index: 2, verdict: 'no' },
        { index: 3, verdict: 'unknown' },
        { index: 4, verdict: null },
        { index: 5, verdict: null },
        { index: 6, verdict: null },
      ],
    });
    // 役立った + 役立たなかった が閾値未満なら —(分からないが多くても数えない)
    const u = wikiPageTable([a([['a.md', 'yes']]), a([['a.md', 'unknown']]), a([['a.md', 'unknown']]), a([['a.md', 'no']])], NAMES, MIN);
    expect(row(u, 'a.md').helpfulRate).toBeNull();
  });
  it('古い埋め込み(ページの名前が無い)では行が無い。並びは読んだセッションの多い順、同じなら名前の順', () => {
    expect(wikiPageTable([s(['a.md']), s(['b.md'])], NAMES, MIN).rows).toEqual([]);
    const t = wikiPageTable([withPages(s(['z.md', 'b.md']), ['z.md', 'b.md']), withPages(s(['b.md']), ['b.md']), withPages(s(['a.md']), ['a.md'])], NAMES, 1);
    expect(t.rows.map((r) => r.page)).toEqual(['b.md', 'a.md', 'z.md']);
    // 読んだセッションは、渡したセッションの並びでの位置(読んでいないセッションは入らない)
    const u = wikiPageTable([s([]), withPages(s(['b.md']), ['b.md']), { wiki: w() }, withPages(s(['b.md']), ['b.md'])], NAMES, 1);
    expect(row(u, 'b.md').readers.map((r) => r.index)).toEqual([1, 3]);
  });
  it('並べ替え: 率の — は向きにかかわらず最後、同じ値は読んだセッションの多い順', () => {
    const r = (page: string, sessions: number, helpfulRate: number | null, yes = 0): WikiPageRow => ({ page, sessions, share: null, yes, no: 0, unknown: 0, unjudged: 0, helpfulRate, readers: [] });
    const rows = [r('a.md', 1, 0.5), r('b.md', 5, null), r('c.md', 3, 1), r('d.md', 2, 0.5)];
    expect(sortWikiPageRows(rows, 'helpfulRate', false).map((x) => x.page)).toEqual(['c.md', 'd.md', 'a.md', 'b.md']);
    expect(sortWikiPageRows(rows, 'helpfulRate', true).map((x) => x.page)).toEqual(['d.md', 'a.md', 'c.md', 'b.md']);
    expect(sortWikiPageRows(rows, 'sessions', true).map((x) => x.page)).toEqual(['a.md', 'd.md', 'c.md', 'b.md']);
    expect(sortWikiPageRows(rows, 'page', false).map((x) => x.page)).toEqual(['d.md', 'c.md', 'b.md', 'a.md']);
    expect(sortWikiPageRows(rows, 'yes', false).map((x) => x.page)).toEqual(['b.md', 'c.md', 'd.md', 'a.md']);
    expect(rows.map((x) => x.page)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });
  it('短い名前: 共通のフォルダと .md を除く。除くと重なるなら .md は残す', () => {
    const a = shortPageNames(['wiki/topics/x.md', 'wiki/topics/sub/y.md', 'wiki/topics/z.MD']);
    expect([a.prefix, a.dropMd, [...a.short.values()]]).toEqual(['wiki/topics/', true, ['x', 'sub/y', 'z']]);
    const b = shortPageNames(['wiki/a.md', 'notes/a.md']);
    expect([b.prefix, [...b.short.values()]]).toEqual(['', ['wiki/a', 'notes/a']]);
    const c = shortPageNames(['w/a.md', 'w/a']);
    expect([c.prefix, c.dropMd, [...c.short.values()]]).toEqual(['w/', false, ['a.md', 'a']]);
    expect(shortPageNames([]).prefix).toBe('');
  });
  it('ページの名前の辞書: セッションの並び・読んだ順に重複なく並べ、番号を引く', () => {
    const ix = wikiPageIndex([{ wiki: { pageReads: ['b.md', 'a.md', 'b.md'] } }, { wiki: { pageReads: [] } }, { wiki: { pageReads: ['a.md', 'c.md'] } }]);
    expect(ix.names).toEqual(['b.md', 'a.md', 'c.md']);
    expect(pageNumber(ix, 'c.md')).toBe(2);
    expect(() => pageNumber(ix, 'x.md')).toThrow(/辞書に x.md がありません/);
  });
  it('判定に載せるページは重複を除いて読んだ順の先頭から上限まで', () => {
    expect(uniquePages(['a', 'b', 'a'])).toEqual(['a', 'b']);
    const many = Array.from({ length: WIKI_JUDGED_PAGES_MAX + 2 }, (_, i) => `p${i}`);
    expect(judgedWikiPages([...many, 'p0'])).toEqual(many.slice(0, WIKI_JUDGED_PAGES_MAX));
  });
});

describe('どこでも同じ数え方', () => {
  /** wiki だけを決めた要約(集計に要る項目は空のセッションの値) */
  const summary = (wiki: Required<WikiCounts>): SessionSummary =>
    ({
      id: 'x',
      tokens: { input: null, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, premiumRequests: null, nanoAiu: null, requests: 0 },
      turns: 0,
      autopilotContinuations: 0,
      empty: false,
      tools: { total: 0, internal: 0 },
      lines: { added: 0, removed: 0, source: 'none' },
      skills: {},
      agents: { total: 0, failed: 0 },
      hooks: { total: 0 },
      instructions: {},
      wiki,
      friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 },
      activeMs: null,
      durationMs: null,
      createdAt: null,
      updatedAt: null,
      judgment: null,
    }) as unknown as SessionSummary;
  /** 名前・wiki の回数・参照したか(1 件ずつ集計する。まとめて数えると、書き込みだけと検索だけが打ち消し合って前の数え方でも通る) */
  const cases: [string, Required<WikiCounts>, boolean][] = [
    ['索引だけ', w({ indexReads: 1 }), true],
    ['検索だけ', w({ otherCalls: 1 }), true],
    ['書き込みだけ', w({ writes: 1 }), false],
    ['触れていない', w(), false],
    ['skill だけ', w({ skillCalls: 1 }), true],
    ['参照と書き込み', w({ pageReads: 1, writes: 2 }), true],
  ];
  it.each(cases)('%s: 集計の sessionsWithWiki は、wikiReferenced と同じ', (_name, c, referenced) => {
    expect(wikiReferenced(c)).toBe(referenced);
    expect(bucket('all', '全体', [summary(c)]).sessionsWithWiki).toBe(referenced ? 1 : 0);
  });
  it('絞り込みの wiki=1 も同じ数え方で残す。ハッシュで往復し、不正な値は捨てる', () => {
    const ss = cases.map(([name, c]) => ({ ...summary(c), id: name, project: 'p', client: null, branch: null, models: [] }));
    expect(applyFilter(ss, { ...emptyFilter(), wiki: '1' }).map((s) => s.id)).toEqual(cases.filter(([, c]) => wikiReferenced(c)).map(([name]) => name));
    expect(applyFilter(ss, emptyFilter())).toHaveLength(cases.length);
    expect(encodeFilter({ ...emptyFilter(), wiki: '1' })).toBe('wiki=1');
    expect(decodeFilter('#wiki=1').wiki).toBe('1');
    expect(decodeFilter('#wiki=x').wiki).toBe('');
  });
});
