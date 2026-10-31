import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../core/src/metrics.ts';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { SessionRecord } from '../../core/src/types.ts';
import { aggregate, coverageBreakdown, monthRange } from '../src/lib/aggregate.ts';
import { createAnonymizer, identityAnonymizer, shortProjectLabel } from '../src/lib/anonymize.ts';
import { embedData, extractEmbedded, serializeForScript } from '../src/lib/embed.ts';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter, filterOptions, isEmptyFilter, NO_JUDGMENT, UNKNOWN } from '../src/lib/filter.ts';
import { parseJudgments } from '../src/lib/judgments.ts';
import { niceTicks } from '../src/lib/scale.ts';
import { modelLabel } from '../src/lib/format.ts';
import { summarize } from '../src/lib/summarize.ts';
import type { JudgmentSummary, SessionSummary } from '../src/lib/types.ts';

function judgment(p: Partial<JudgmentSummary>): JudgmentSummary {
  return {
    taskCategory: null,
    hours: null,
    low: null,
    high: null,
    confidence: null,
    taskSummary: null,
    completed: null,
    quality: null,
    rework: null,
    effects: { instructions: null, wiki: null, skillsAgents: null },
    rationale: '根拠',
    backend: 'external',
    ...p,
  };
}
import { esc, renderDetailHtml } from '../src/detail.ts';

/** usage_record 付き(入力トークンあり) */
async function withInput(id: string, ws: Record<string, unknown>, model: string, input: number, output: number): Promise<SessionRecord> {
  return normalizeSession({
    id,
    workspace: ws,
    events: [
      { type: 'user.message', data: { content: `依頼 ${id} C:\\work\\secret-proj\\src を直して` }, timestamp: String(ws.created_at) },
      { type: 'tool.execution_start', data: { toolName: 'view' }, timestamp: String(ws.created_at) },
      { type: 'session.usage_record', data: { usage: { model, inputTokens: input, outputTokens: output, cost: 1, initiator: 'user' } }, timestamp: String(ws.created_at) },
    ],
  });
}

/** 出力トークンだけ(旧形式) */
async function outputOnly(id: string, ws: Record<string, unknown>, model: string, output: number): Promise<SessionRecord> {
  return normalizeSession({
    id,
    workspace: ws,
    events: [{ type: 'assistant.message', data: { model, outputTokens: output }, timestamp: String(ws.created_at) }],
  });
}

async function fixture(): Promise<SessionRecord[]> {
  return [
    await withInput('a', { client_name: 'github/cli', repository: 'acme/secret-proj', cwd: 'C:\\work\\secret-proj', branch: 'feature/x1', created_at: '2026-07-10T03:00:00Z', name: 'secret-proj の修正' }, 'gpt-5.5', 100, 10),
    await withInput('b', { client_name: 'github/autopilot', cwd: '/home/me/.copilot/chats/c1', created_at: '2026-09-02T03:00:00Z' }, 'claude-sonnet-5', 50, 5),
    await outputOnly('c', { client_name: 'github/cli', repository: 'acme/secret-proj', cwd: 'C:\\work\\secret-proj', branch: 'main', created_at: '2026-09-20T03:00:00Z' }, 'gpt-5.5', 7),
    // トークン記録なし(欠測)。Phase 5 で依頼 0・ツール 0・応答 0 は「空」として既定の集計から外すため、依頼を 1 件持たせて空でなくする
    await normalizeSession({
      id: 'd',
      workspace: { cwd: 'D:\\other', created_at: '2026-10-01T00:00:00Z' },
      events: [{ type: 'user.message', data: { content: 'x' }, timestamp: '2026-10-01T00:00:00Z' }],
    }),
  ];
}

const summaries = (rs: SessionRecord[]): SessionSummary[] => rs.map((r) => summarize(r, identityAnonymizer(), null));

describe('aggregate', () => {
  it('全体・プロジェクト・月・モデルが core の computeMetrics と一致する', async () => {
    const rs = await fixture();
    const m = computeMetrics(rs);
    const a = aggregate(summaries(rs));
    expect(a.overall.sessions).toBe(m.overall.sessions);
    expect(a.overall.sessionsWithInput).toBe(m.overall.sessionsWithInputTokens);
    expect(a.overall.tokens).toEqual(m.overall.tokens);
    expect(a.overall.tools).toBe(m.overall.tools.total);
    expect(a.overall.turns).toBe(m.overall.turns);
    expect(Object.fromEntries(a.byProject.map((b) => [b.key, b.tokens.output]))).toEqual(Object.fromEntries(Object.entries(m.byProject).map(([k, b]) => [k, b.tokens.output])));
    // 記録の無い月(2026-08)も 0 として並ぶ
    expect(a.byMonth.map((b) => [b.key, b.sessions])).toEqual([
      ['2026-07', 1],
      ['2026-08', 0],
      ['2026-09', 2],
      ['2026-10', 1],
    ]);
    for (const b of a.byMonth) if (b.sessions) expect(b.sessions).toBe(m.byMonth[b.key].sessions);
    expect(Object.fromEntries(a.byModel.map((r) => [r.model, [r.sessions, r.input, r.output]]))).toEqual(
      Object.fromEntries(Object.entries(m.byModel).map(([k, r]) => [k, [r.sessions, r.input, r.output]])),
    );
  });

  it('入力トークン記録の内訳を欠測込みで数える', async () => {
    const c = coverageBreakdown(summaries(await fixture()));
    expect(c).toEqual({ detailed: 2, shutdown: 0, outputOnly: 1, none: 1, empty: 0 });
  });

  it('monthRange は年をまたいで欠けなく並べる', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('filter', () => {
  it('プロジェクト・クライアント・モデル・ブランチ・期間・記録の有無で件数が変わる', async () => {
    const s = summaries(await fixture());
    const f = emptyFilter();
    expect(applyFilter(s, f)).toHaveLength(4);
    expect(applyFilter(s, { ...f, project: 'acme/secret-proj' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, client: 'github/cli' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, client: UNKNOWN }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, model: 'gpt-5.5' }).map((x) => x.id)).toEqual(['a', 'c']);
    expect(applyFilter(s, { ...f, model: UNKNOWN }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, branch: 'main' }).map((x) => x.id)).toEqual(['c']);
    expect(applyFilter(s, { ...f, coverage: 'input' }).map((x) => x.id)).toEqual(['a', 'b']);
    expect(applyFilter(s, { ...f, coverage: 'output-only' }).map((x) => x.id)).toEqual(['c']);
    expect(applyFilter(s, { ...f, coverage: 'none' }).map((x) => x.id)).toEqual(['d']);
    expect(applyFilter(s, { ...f, from: '2026-09-01', to: '2026-09-30' }).map((x) => x.id)).toEqual(['b', 'c']);
    expect(applyFilter(s, { ...f, project: 'acme/secret-proj', coverage: 'input' }).map((x) => x.id)).toEqual(['a']);
  });

  it('空のセッションは既定で除外し、「含める」(#empty=1)で含める。内訳では「空」として数える', async () => {
    const rs = [...(await fixture()), await normalizeSession({ id: 'z', workspace: { cwd: 'D:\\other', created_at: '2026-10-02T00:00:00Z' }, events: [] })];
    const s = summaries(rs);
    expect(s.find((x) => x.id === 'z')?.empty).toBe(true);
    expect(applyFilter(s, emptyFilter()).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    const inc = { ...emptyFilter(), empty: '1' as const };
    expect(applyFilter(s, inc)).toHaveLength(5);
    expect(encodeFilter(inc)).toBe('empty=1');
    expect(decodeFilter('#empty=1').empty).toBe('1');
    expect(decodeFilter('#empty=yes').empty).toBe('');
    expect(isEmptyFilter(inc)).toBe(false);
    const c = coverageBreakdown(applyFilter(s, inc));
    expect(c).toEqual({ detailed: 2, shutdown: 0, outputOnly: 1, none: 1, empty: 1 });
    // 既定の集計は core の metrics(空を除く)と一致する
    const m = computeMetrics(rs);
    expect(m.emptySessions).toBe(1);
    expect(aggregate(applyFilter(s, emptyFilter())).overall.sessions).toBe(m.overall.sessions);
    expect(aggregate(applyFilter(s, inc)).overall.emptySessions).toBe(1);
  });

  it('タスク分類は judgments の有無で絞れる(未判定は (none))', async () => {
    const rs = await fixture();
    const s = rs.map((r) => summarize(r, identityAnonymizer(), r.id === 'a' ? judgment({ taskCategory: 'bugfix', hours: 2, low: 1, high: 3, confidence: 0.5, taskSummary: '修正' }) : null));
    expect(applyFilter(s, { ...emptyFilter(), taskCategory: 'bugfix' }).map((x) => x.id)).toEqual(['a']);
    expect(applyFilter(s, { ...emptyFilter(), taskCategory: NO_JUDGMENT })).toHaveLength(3);
    const o = aggregate(s).overall;
    expect(o).toMatchObject({ judgedSessions: 1, humanHours: 2, humanLow: 1, humanHigh: 3, judgedConfidence: 0.5 });
    const a = s.find((x) => x.id === 'a')!;
    expect(o.judgedAi.output).toBe(a.tokens.output);
    expect(o.judgedAi.activeMs).toBe(a.activeMs ?? 0);
    // HTML 本体に埋め込む要約には根拠(自由記述)を入れない
    expect(a.judgment?.rationale).toBeNull();
  });

  it('選択肢は件数の多い順で、件数付き', async () => {
    const o = filterOptions(summaries(await fixture()));
    expect(o.project[0]).toEqual({ value: 'acme/secret-proj', label: 'acme/secret-proj', count: 2 });
    expect(o.client.map((x) => x.value)).toEqual(['github/cli', '(unknown)', 'github/autopilot']);
    expect(o.model.find((x) => x.value === 'gpt-5.5')?.count).toBe(2);
  });

  it('URL ハッシュと往復でき、不正な値は捨てる', () => {
    const f = { ...emptyFilter(), project: 'a/b c', coverage: 'none' as const, from: '2026-01-01' };
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    expect(isEmptyFilter(decodeFilter('#coverage=bogus&unknown=1&project=%E0%A4'))).toBe(true);
    expect(encodeFilter(emptyFilter())).toBe('');
  });
});

describe('anonymize', () => {
  it('プロジェクト・ブランチは辞書順で決定的な仮名、本文は出さない', async () => {
    const rs = await fixture();
    const anon = createAnonymizer(rs);
    const s = rs.map((r) => summarize(r, anon, null));
    // 辞書順: 'D:\other' < '/home/me/...' < 'acme/secret-proj'(localeCompare)
    expect(s.map((x) => x.project)).toEqual(['project-03', 'project-02', 'project-03', 'project-01']);
    expect(s.map((x) => x.branch)).toEqual(['branch-01', null, 'branch-02', null]);
    expect(s.every((x) => x.name === null && x.firstUserMessage === null)).toBe(true);
    const json = JSON.stringify(s);
    for (const secret of ['secret-proj', 'acme', 'feature/x1', 'C:\\\\work', '.copilot', 'D:\\\\other']) expect(json).not.toContain(secret);
    // 同じ入力からは同じ仮名
    expect(createAnonymizer(rs).project('acme/secret-proj')).toBe('project-03');
  });

  it('scrub はパスと既知の固有名を置き換える', async () => {
    const anon = createAnonymizer(await fixture());
    expect(anon.scrub('failed at C:\\work\\secret-proj\\src\\a.ts in secret-proj on feature/x1')).toBe('failed at <path> in project-03 on branch-01');
    expect(anon.scrub('domain main')).toBe('domain branch-02');
  });

  it('詳細ページの時系列: 伏せ字モードでは要約・中断理由・エラー本文・サブエージェント失敗の本文を出さず、種別名だけ出す', async () => {
    const t = '2026-10-01T00:00:00Z';
    const r = await normalizeSession({
      id: 'e',
      workspace: { cwd: 'C:\work\secret-proj', repository: 'acme/secret-proj', created_at: t },
      events: [
        { type: 'user.message', data: { content: '依頼 e' }, timestamp: t },
        { type: 'subagent.started', data: { agentName: 'helper', toolCallId: 'c1' }, timestamp: t },
        { type: 'subagent.failed', data: { agentName: 'helper', toolCallId: 'c1', error: 'ENOENT: notes/todo.md が無い' }, timestamp: t },
        { type: 'session.task_complete', data: { summary: 'README.md と normalize.ts を更新した' }, timestamp: t },
        { type: 'abort', data: { reason: 'user stopped while editing secret-notes.md' }, timestamp: t },
        { type: 'session.error', data: { errorType: 'rate_limit' }, timestamp: t },
        { type: 'session.error', data: { message: 'failed to read secret-notes.md' }, timestamp: t },
      ],
    });
    const anon = createAnonymizer([...(await fixture()), r]);
    const html = renderDetailHtml(r, { anon, css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const secret of ['README.md', 'normalize.ts', 'secret-notes.md', 'todo.md', 'user stopped', 'failed to read']) expect(html).not.toContain(secret);
    // 種別名(識別子)は出る
    expect(html).toContain('rate_limit');
    const plain = renderDetailHtml(r, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const text of ['README.md と normalize.ts を更新した', 'user stopped while editing secret-notes.md', 'failed to read secret-notes.md', 'notes/todo.md が無い']) expect(plain).toContain(text);
  });

  it('詳細ページも伏せ字(パス・本文・ブランチが出ない)', async () => {
    const rs = await fixture();
    const anon = createAnonymizer(rs);
    const html = renderDetailHtml(rs[0], { anon, css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    for (const secret of ['secret-proj', 'acme', 'feature/x1', 'work\\', '依頼 a']) expect(html).not.toContain(secret);
    expect(html).toContain('project-03');
    const plain = renderDetailHtml(rs[0], { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: '2026-10-28T00:00:00Z' });
    expect(plain).toContain('secret-proj');
  });

  it('ホームディレクトリは ~ に短縮して表示する', () => {
    // Windows 形式(C:\Users\<name>)は実データの E2E(ATLAS_LIVE)で検証する。ここでは POSIX 形式で ~ 短縮を確かめる
    expect(shortProjectLabel('/home/me/.copilot/chats/c1')).toBe('~/.copilot/chats/c1');
    expect(shortProjectLabel('acme/x')).toBe('acme/x');
  });
});

describe('embed', () => {
  it('</script> や URL・fetch( を含む本文でも安全に埋め込み、往復できる', () => {
    const data = { t: '</script><!-- https://example.com fetch(x) \u2028 & >' };
    const tpl = '<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>';
    const html = embedData(tpl, data);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('fetch(');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(extractEmbedded(html)).toEqual(data);
    expect(JSON.parse(serializeForScript(data))).toEqual(data);
    expect(() => embedData('<p></p>', data)).toThrow(/埋め込み位置/);
  });

  it('esc は HTML と URL の区切りをエスケープする', () => {
    expect(esc('<a href="https://x">fetch(1)</a>')).toBe('&lt;a href=&quot;https:&#47;&#47;x&quot;&gt;fetch&#40;1)&lt;/a&gt;');
  });
});

describe('judgments', () => {
  it('必要な項目だけ拾い、形が違えばエラーにする', () => {
    const j = parseJudgments({
      schemaVersion: 1,
      judge: { backend: 'external', model: 'm', ranAt: '2026-10-28T00:00:00Z' },
      items: [{ sessionId: 'a', taskCategory: 'docs', taskSummary: 's', humanEffort: { hours: 1.5, low: 1, high: 2, confidence: 0.7 } }],
    });
    expect(j.backend).toBe('external');
    expect(j.bySession.get('a')).toEqual({
      taskCategory: 'docs',
      hours: 1.5,
      low: 1,
      high: 2,
      confidence: 0.7,
      taskSummary: 's',
      completed: null,
      quality: null,
      rework: null,
      effects: { instructions: null, wiki: null, skillsAgents: null },
      rationale: null,
      backend: 'external',
    });
    expect(() => parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'x', humanEffort: {} }] })).toThrow(/hours/);
    expect(() => parseJudgments({ schemaVersion: 2, items: [] })).toThrow(/schemaVersion/);
    expect(() => parseJudgments({ schemaVersion: 1, items: [{}] })).toThrow(/sessionId/);
  });
});

describe('niceTicks', () => {
  it('きりのよい目盛りで最大値を覆う', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });
});

describe('modelLabel', () => {
  it('プレフィックス付きのモデル ID は最後の / 以降で表示する', () => {
    expect(modelLabel('11111111-2222-4333-8444-555555555555/claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(modelLabel('gpt-5.5')).toBe('gpt-5.5');
    expect(modelLabel('(unknown)')).toBe('不明');
    expect(modelLabel('odd/')).toBe('odd/');
  });
});
