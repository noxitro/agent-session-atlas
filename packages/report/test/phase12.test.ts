// Phase 12: 改善点の規則(閾値の境界、版の前後比較、類似度、部分列、スコア順)
import { describe, expect, it } from 'vitest';
import {
  collapseRuns,
  instructionFindings,
  instructionVersions,
  isPeriodic,
  jaccard,
  normalizeRequest,
  requestCandidates,
  skillCandidates,
  skillStats,
  stuckByProject,
  stuckSessions,
  THRESHOLDS,
  toolSequenceCandidates,
  trigrams,
  type CandidateSource,
} from '../src/lib/insights.ts';
import type { SessionSummary } from '../src/lib/types.ts';

/** 必要な欄だけ持つ SessionSummary(他は既定) */
function sess(p: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    client: 'github/cli',
    project: 'p',
    projectLabel: 'p',
    projectSource: 'repository',
    branch: null,
    name: null,
    firstUserMessage: null,
    createdAt: null,
    updatedAt: null,
    durationMs: null,
    activeMs: null,
    turns: 1,
    autopilotContinuations: 0,
    empty: false,
    models: [],
    tokens: { input: null, output: 100, cacheRead: null, cacheWrite: null, reasoning: null, premiumRequests: null, nanoAiu: null, requests: null, source: 'none' },
    coverage: 'none',
    byModel: {},
    tools: { total: 10, byName: {}, internal: 0, mcp: {}, issues: {}, durations: {}, outliers: {} },
    exec: { modes: {}, modesInferred: 0, efforts: {}, initiators: {}, context: null, latency: {} },
    frictionDetail: { permissions: [0, 0, 0], errorTypes: {}, subagentFailures: {}, compaction: [0, 0, 0, 0, 0] },
    todos: null,
    skills: {},
    skillChars: {},
    instructionVersions: [],
    analysis: { filesReedited: 0, extraEdits: 0, maxConsecutiveFailures: 0, turns: 1 },
    agents: { total: 0, failed: 0, byName: {} },
    hooks: { total: 0, byType: {} },
    instructions: {},
    lines: { added: 0, removed: 0, source: 'none' },
    wiki: { indexReads: 0, pageReads: 0, skillCalls: 0, writes: 0 },
    friction: { compactions: 0, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 },
    files: { changed: 0, created: 0, deleted: 0, sessionState: 0 },
    href: `sessions/${p.id}.html`,
    judgment: null,
    ...p,
  } as SessionSummary;
}
const failing = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => sess({ id, tools: { total: 10, byName: { bash: 10 }, internal: 0, mcp: {}, issues: { bash: [4, 0, 10] }, durations: {}, outliers: {} }, ...extra });

describe('指示文の版', () => {
  it('版ごとの率は MIN_SESSIONS 以上で結論に使い、同じ見出しの前後で WORSE_POINTS 以上悪化したものを挙げる。件数不足は数える', () => {
    const v1 = Array.from({ length: 5 }, (_, i) => sess({ id: `a${i}`, instructionVersions: [['h1', 500, 1]] }));
    const v2 = Array.from({ length: 5 }, (_, i) => (i < 3 ? failing(`b${i}`, { instructionVersions: [['h2', 520, 1]] }) : sess({ id: `b${i}`, instructionVersions: [['h2', 520, 1]] })));
    const v3 = [sess({ id: 'c0', instructionVersions: [['h3', 9000, 2]] })];
    const stats = instructionVersions([...v1, ...v2, ...v3]);
    const h1 = stats.find((v) => v.hash === 'h1')!;
    const h2 = stats.find((v) => v.hash === 'h2')!;
    const h3 = stats.find((v) => v.hash === 'h3')!;
    expect(h1).toMatchObject({ sessions: 5, enough: true, failureRate: 0, reworkRate: 0 });
    expect(h2.failureRate).toBeCloseTo(12 / 50);
    expect(h3).toMatchObject({ sessions: 1, enough: false, injectionsPerSession: 2 });
    const meta = { h1: { heading: '# A', file: 'AGENTS.md', series: 's0', order: 0, firstAt: '2026-10-01' }, h2: { heading: '# A', file: 'AGENTS.md', series: 's0', order: 1, firstAt: '2026-10-02' }, h3: { heading: '# A', file: 'AGENTS.md', series: 's0', order: 2, firstAt: '2026-10-03' } };
    const f = instructionFindings(stats, meta, 100);
    expect(f.worsened).toHaveLength(1);
    expect(f.worsened[0]).toMatchObject({ heading: '# A', before: { hash: 'h1' }, after: { hash: 'h2' } });
    expect(f.worsened[0].failureDelta).toBeCloseTo(24);
    expect(f.comparedInsufficient).toBe(1); // h2 → h3 は h3 が 1 件
    // 9 ポイントの悪化は挙げない
    const v2b = Array.from({ length: 10 }, (_, i) => (i < 1 ? failing(`d${i}`, { instructionVersions: [['h2', 520, 1]] }) : sess({ id: `d${i}`, instructionVersions: [['h2', 520, 1]] })));
    const s2 = instructionVersions([...v1, ...v2b]);
    expect(instructionFindings(s2, meta, 100).worsened).toHaveLength(0);
    // 長いのに注入が少ない: 上位 25% の字数で RARE_SESSIONS 未満(版が 4 つ以上あるとき)
    const many = [...v1, ...v2, ...v3, sess({ id: 'e0', instructionVersions: [['h4', 100, 1]] })];
    const allMeta = { ...meta, h4: { heading: '# B', file: 'AGENTS.md', series: 's1', order: 0, firstAt: null } };
    const lr = instructionFindings(instructionVersions(many), allMeta, many.length).longRare;
    // 母集団が MIN_SESSIONS 未満(絞り込みなど)では「注入が少ない」と結論しない
    expect(instructionFindings(instructionVersions(many), allMeta, THRESHOLDS.MIN_SESSIONS - 1).longRare).toEqual([]);
    expect(lr.map((v) => v.hash)).toEqual(['h3']);
    // 判定できた組の数と、字数の下限を返す(画面に「N 組を判定」「M 字以上」と出す)
    expect(f.compared).toBe(1);
    expect(instructionFindings(instructionVersions(many), allMeta, many.length).longChars).toBeGreaterThan(0);
    // 今の版は番号が最大の版ではなく、最後に読み込まれた版(別のリポジトリで古い番号の版を使い続けている)
    const byLast = { ...allMeta, h1: { ...meta.h1, lastAt: '2026-10-09' }, h2: { ...meta.h2, lastAt: '2026-10-02' }, h3: { ...meta.h3, lastAt: '2026-10-03' } };
    const lr2 = instructionFindings(instructionVersions(many), byLast, many.length).longRare;
    expect(lr2.map((v) => v.hash)).toEqual([]); // 今の版 h1 は 5 セッションで「少ない」に当たらない
  });

  it('止まっている箇所は理由の数が同じなら余分な編集・失敗の連続の多い順(待ち時間の記録の有無で順位を決めない)', () => {
    const T = THRESHOLDS.STUCK;
    const withTtft = sess({ id: 'w', exec: { modes: {}, modesInferred: 0, efforts: {}, initiators: {}, context: null, latency: { m: [[5_000], [9_000]] } }, analysis: { filesReedited: 1, extraEdits: T.extraEdits, maxConsecutiveFailures: 0, turns: 1 } });
    const manyEdits = sess({ id: 'e', analysis: { filesReedited: 5, extraEdits: T.extraEdits * 40, maxConsecutiveFailures: 0, turns: 1 } });
    expect(stuckSessions([withTtft, manyEdits]).map((x) => x.id)).toEqual(['e', 'w']);
  });
});

describe('skill と止まっている箇所', () => {
  it('skill の失敗率は呼んだ / 呼ばないの両方を MIN_SESSIONS で区切り、未使用はインストール済みから引く', () => {
    const withS = Array.from({ length: 5 }, (_, i) => failing(`s${i}`, { skills: { 'my-skill': [1, 0, 0] }, skillChars: { 'my-skill': 1200 } }));
    const without = Array.from({ length: 3 }, (_, i) => sess({ id: `n${i}` }));
    const r = skillStats([...withS, ...without], ['my-skill', 'unused-skill']);
    expect(r.stats[0]).toMatchObject({ name: 'my-skill', calls: 5, byUser: 5, byAgent: 0, chars: 1200, sessions: 5, enough: true });
    expect(r.stats[0].failureWith).toBeCloseTo(0.4);
    expect(r.stats[0].failureWithout).toBeNull(); // 3 件は不足
    expect(r.unused).toEqual(['unused-skill']);
  });

  it('閾値を超えた理由だけを挙げ、理由の数の順に並べ、プロジェクト別に数える', () => {
    const T = THRESHOLDS.STUCK;
    const a = sess({ id: 'a', exec: { modes: {}, modesInferred: 0, efforts: {}, initiators: {}, context: null, latency: { m: [[T.ttftMs, T.ttftMs + 1], [1, 2]] } }, analysis: { filesReedited: 1, extraEdits: T.extraEdits, maxConsecutiveFailures: T.consecutiveFailures, turns: 1 } });
    const b = sess({ id: 'b', project: 'q', projectLabel: 'q', friction: { compactions: T.compactions - 1, aborts: 0, errors: 0, permissionRequests: T.permissions - 1, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 } });
    const c = sess({ id: 'c', friction: { compactions: T.compactions, aborts: 0, errors: 0, permissionRequests: 0, askUser: 0, modelChanges: 0, modeChanges: 0, toolFailures: 0, subagentFailures: 0 } });
    const st = stuckSessions([a, b, c]);
    expect(st.map((x) => x.id)).toEqual(['a', 'c']);
    expect(st[0].reasons).toEqual(['待ち時間', '失敗の連続', '余分な編集の多さ']);
    expect(st[1].reasons).toEqual(['compaction']);
    // 総数が MIN_SESSIONS 未満のプロジェクトは出さない(1 / 1 が結論に見えるため)
    expect(stuckByProject(st, [a, b, c])).toEqual([]);
    const fill = Array.from({ length: THRESHOLDS.MIN_SESSIONS - 2 }, (_, i) => sess({ id: `f${i}` }));
    expect(stuckByProject(st, [a, b, c, ...fill])).toEqual([{ project: 'p', projectLabel: 'p', stuck: 2, total: THRESHOLDS.MIN_SESSIONS, reasons: { 待ち時間: 1, 失敗の連続: 1, 余分な編集の多さ: 1, compaction: 1 } }]);
  });
});

describe('スキル化の候補', () => {
  it('正規化は URL・パス・数字・id を印にし、3-gram の Jaccard が閾値以上なら束ねる', () => {
    expect(normalizeRequest('C:\\\\work\\\\x\\\\y.txt を 3 回読んで https://example.invalid/a にまとめて')).toBe('<path> を <n> 回読んで <url> にまとめて');
    expect(normalizeRequest('/home/me/proj/src/main.ts の 7f3a2b1c9d の件')).toBe('<path> の <id> の件');
    const a = trigrams(normalizeRequest('リポジトリの README を更新して'));
    const b = trigrams(normalizeRequest('リポジトリの README を更新して!'));
    const c = trigrams(normalizeRequest('ビルドが失敗する原因を調べて'));
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(THRESHOLDS.SIMILARITY);
    expect(jaccard(a, c)).toBeLessThan(THRESHOLDS.SIMILARITY);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('似た依頼文は MIN_REPEAT 回以上・2 セッション以上で候補になり、定型文と短い文は除く。代表は中央のもの', () => {
    const src: CandidateSource[] = [
      { id: 's1', project: 'p', analysis: { requests: ['リポジトリの README を更新してください。章立ては変えない', 'OK', 'Reply with exactly: OK'], turnTools: [[], [], []], turnMs: [60_000, 1000, 1000] } },
      { id: 's2', project: 'p', analysis: { requests: ['リポジトリの README を更新してください。章立ては変えないで'], turnTools: [[]], turnMs: [120_000] } },
      { id: 's3', project: 'p', analysis: { requests: ['リポジトリの README を更新して下さい。章立ては変えない', '短い'], turnTools: [[], []], turnMs: [180_000, null] } },
      { id: 's4', project: 'p', analysis: { requests: ['OK', 'OK', 'OK'], turnTools: [[], [], []], turnMs: [1, 1, 1] } },
    ];
    const r = requestCandidates(src, false);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'request', count: 3, sessions: ['s1', 's2', 's3'], medianMs: 120_000, score: 6 });
    expect(r[0].representative).toContain('README');
    expect(r[0].examples).toHaveLength(2);
    // 1 セッションだけの繰り返しは候補にしない
    const one: CandidateSource[] = [{ id: 'x', project: 'p', analysis: { requests: Array(4).fill('リポジトリの README を更新してください。章立ては変えない'), turnTools: [[], [], [], []], turnMs: [1, 1, 1, 1] } }];
    expect(requestCandidates(one, false)).toHaveLength(0);
    // 伏せ字では本文を出さない
    const an = requestCandidates(src, true)[0];
    expect(an.representative).toBeNull();
    expect(an.examples).toEqual([]);
  });

  it('ツールの並びは連続の重複を潰し、2 種類以上で閲覧だけでなく周期的でないものを、長い方から重なりなく数える', () => {
    expect(collapseRuns(['view', 'view', 'rg', 'rg', 'view'])).toEqual(['view', 'rg', 'view']);
    expect(isPeriodic(['rg', 'view', 'rg', 'view'])).toBe(true);
    expect(isPeriodic(['rg', 'view', 'powershell'])).toBe(false);
    const seq = ['view', 'apply_patch', 'powershell', 'apply_patch', 'powershell'];
    const src: CandidateSource[] = [
      { id: 'a', project: 'p', analysis: { requests: ['依頼 A の本文です(十分な長さ)'], turnTools: [seq], turnMs: [300_000] } },
      { id: 'b', project: 'p', analysis: { requests: ['依頼 B の本文です(十分な長さ)'], turnTools: [seq], turnMs: [600_000] } },
      { id: 'c', project: 'p', analysis: { requests: ['依頼 C の本文です(十分な長さ)'], turnTools: [[...seq, 'rg', 'view', 'rg', 'view']], turnMs: [900_000] } },
      { id: 'd', project: 'p', analysis: { requests: ['閲覧だけ'], turnTools: [['view', 'rg', 'view', 'glob', 'rg', 'view', 'rg', 'view', 'glob']], turnMs: [100] } },
    ];
    const r = toolSequenceCandidates(src, false);
    expect(r[0]).toMatchObject({ kind: 'tools', key: seq.join(' → '), count: 3, sessions: ['a', 'b', 'c'], medianMs: 600_000, score: 30 });
    // 長い並びに含まれる短い並び(apply_patch → powershell → apply_patch)は重なるので別に数えない。閲覧だけの並びは出ない
    expect(r.filter((x) => x.key.includes('apply_patch'))).toHaveLength(1);
    expect(r.every((x) => x.tools!.some((t) => !['view', 'rg', 'glob'].includes(t)))).toBe(true);
    // 全体はスコア順。判定セッションは除く
    const all = skillCandidates([...src, { id: 'j', project: '(atlas の判定)', analysis: { requests: Array(5).fill('判定の依頼文です。十分な長さ'), turnTools: [[], [], [], [], []], turnMs: [1, 1, 1, 1, 1] } }], false);
    expect(all.map((c) => c.score)).toEqual([...all.map((c) => c.score)].sort((x, y) => y - x));
    expect(all.some((c) => c.representative?.includes('判定の依頼文'))).toBe(false);
  });
});
