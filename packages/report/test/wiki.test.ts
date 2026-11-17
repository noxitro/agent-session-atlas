// llm-wiki の参照の数え方(lib/wiki.ts)と、それを使う集計(lib/aggregate.ts の sessionsWithWiki)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { bucket } from '../src/lib/aggregate.ts';
import { usageCount } from '../src/lib/condition-usage.ts';
import type { ConditionSession } from '../src/lib/conditions.ts';
import type { SessionSummary } from '../src/lib/types.ts';
import { WIKI_NO_RECORD, WIKI_NOT_COUNTED, wikiKind, wikiReferenceCount, wikiReferenced, wikiState, wikiStateNote, wikiUsageSummary, type WikiCounts } from '../src/lib/wiki.ts';

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
  it('vault の数の記録が無い古い集計: 参照したセッションが無ければ記録なし、あれば数えた', () => {
    expect(wikiState([none, writeOnly], undefined)).toBe('no-record');
    expect(wikiState([], undefined)).toBe('no-record');
    expect(wikiState([none, read], undefined)).toBe('counted');
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
  const cases = [w({ indexReads: 1 }), w({ otherCalls: 1 }), w({ writes: 1 }), w(), w({ skillCalls: 1 })];
  it('集計の sessionsWithWiki と、課題 × 条件の利用の確認は、wikiReferenced と同じ', () => {
    const b = bucket('all', '全体', cases.map(summary));
    expect(b.sessionsWithWiki).toBe(cases.filter(wikiReferenced).length);
    expect(b.sessionsWithWiki).toBe(3);
    for (const c of cases) expect(usageCount({ id: 'x', wiki: c } as unknown as ConditionSession, 'wiki') > 0).toBe(wikiReferenced(c));
  });
});
