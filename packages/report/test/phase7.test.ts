// Phase 7: 実行の性質の集計(絞り込み後)・要点欄・ツールの絞り込みと URL ハッシュ・表示の書式
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { aggregate } from '../src/lib/aggregate.ts';
import { identityAnonymizer, createAnonymizer } from '../src/lib/anonymize.ts';
import { execAggregate, quantilesOf, toolShare } from '../src/lib/exec.ts';
import { applyFilter, decodeFilter, decodeView, emptyFilter, encodeFilter, filterHref, isStateHash } from '../src/lib/filter.ts';
import { msLabel } from '../src/lib/format.ts';
import { highlights } from '../src/lib/highlights.ts';
import { permissionGroup, summarize } from '../src/lib/summarize.ts';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const ev = (dt: number, type: string, data: unknown): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString() });

function calls(prefix: string, tool: string, n: number, fail: number, at: number, ms: number): CopilotEvent[] {
  const out: CopilotEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(ev(at + i * 1000, 'tool.execution_start', { toolCallId: `${prefix}${i}`, toolName: tool }));
    out.push(ev(at + i * 1000 + ms, 'tool.execution_complete', i < fail ? { toolCallId: `${prefix}${i}`, success: false, error: { code: 'failure' } } : { toolCallId: `${prefix}${i}`, success: true }));
  }
  return out;
}

async function records(): Promise<SessionRecord[]> {
  const a = await normalizeSession({
    id: 'a',
    workspace: { repository: 'acme/a', name: 'session A', created_at: '2026-10-01T00:00:00Z' },
    events: [
      ev(0, 'session.start', { reasoningEffort: 'high' }),
      ev(1, 'user.message', { content: 'a', agentMode: 'autopilot' }),
      ...calls('g', 'grep', 6, 3, 10, 20),
      ev(20000, 'session.usage_record', { usage: { model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, initiator: 'user', timeToFirstTokenMs: 900, duration: 2000, copilotUsage: { totalNanoAiu: 3e9 } } }),
      ev(21000, 'session.compaction_complete', { success: true, systemTokens: 10, conversationTokens: 30, toolDefinitionsTokens: 60, tokensRemoved: 5 }),
      ev(22000, 'session.compaction_complete', { success: true }),
      ev(23000, 'permission.completed', { result: { kind: 'approved-for-location' } }),
      ev(24000, 'permission.completed', { result: { kind: 'denied-interactively' } }),
    ],
  });
  a.todos = { total: 2, byStatus: { done: 1, blocked: 1 }, deps: 0 };
  const b = await normalizeSession({
    id: 'b',
    workspace: { repository: 'acme/b', created_at: '2026-10-02T00:00:00Z' },
    events: [
      ev(0, 'user.message', { content: 'b' }),
      ...calls('v', 'view', 2, 0, 10, 100),
      ev(5000, 'session.usage_record', { usage: { model: 'gpt-5.5', inputTokens: 50, outputTokens: 5, initiator: 'agent', timeToFirstTokenMs: 300, copilotUsage: { totalNanoAiu: 1e9 } } }),
      ev(6000, 'session.compaction_complete', { success: true }),
      ev(7000, 'session.shutdown', { toolDefinitionsTokens: 20 }),
    ],
  });
  return [a, b];
}

describe('Phase 7: 実行の性質の集計', () => {
  it('絞り込み後のセッションから、モード・推論強度・起点・文脈・待ち時間・所要時間・摩擦の詳細・todo を出す', async () => {
    const all = (await records()).map((r) => summarize(r, identityAnonymizer(), null));
    const x = execAggregate(all);
    expect(x.modes).toEqual({ rows: [{ key: 'interactive', turns: 1 }, { key: 'autopilot', turns: 1 }], inferred: 1, total: 2 });
    expect(x.efforts.map((e) => [e.key, e.requests])).toEqual([
      ['high', 1],
      ['(unknown)', 1],
    ]);
    expect(x.initiators).toEqual({ rows: [{ key: 'user', requests: 1 }, { key: 'agent', requests: 1 }], total: 2 });
    expect(x.context).toMatchObject({ sessions: 2, toolDefAvg: 40, toolDefMedian: 20, shareAvg: 0.6, shareSessions: 1, availableToolsAvg: null });
    expect(x.context.byProject.map((p) => [p.key, p.toolDefAvg])).toEqual([
      ['acme/a', 60],
      ['acme/b', 20],
    ]);
    expect(x.latency).toEqual([{ model: 'gpt-5.5', ttft: { n: 2, median: 300, p90: 900 }, duration: { n: 1, median: 2000, p90: 2000 } }]);
    expect(x.toolDurations.rows.map((r) => [r.tool, r.n, r.median, r.p90])).toEqual([
      ['view', 2, 100, 100],
      ['grep', 6, 20, 20],
    ]);
    expect(x.friction.permissions).toEqual({ approved: 1, denied: 1, other: 0 });
    expect(x.friction.compaction).toEqual({ compactions: 3, recorded: 0, input: 0, output: 0, nanoAiu: 0, tokensRemoved: 5 });
    expect(x.todos).toEqual({ sessionsWithDb: 1, sessionsWithTodos: 1, total: 2, byStatus: { done: 1, blocked: 1 }, deps: 0, completionRate: 0.5 });
    // 絞り込みに追従する
    const onlyB = execAggregate(applyFilter(all, { ...emptyFilter(), project: 'acme/b' }));
    expect(onlyB.modes.rows).toEqual([{ key: 'interactive', turns: 1 }]);
    expect(onlyB.todos.sessionsWithDb).toBe(0);
    expect(aggregate(all).exec).toEqual(x);
  });

  it('小さな規則: 分位・割合・権限の分類・時間の書式', () => {
    expect(quantilesOf([3, 1, 2])).toEqual({ n: 3, median: 2, p90: 3 });
    expect(toolShare([1, 1, 2, null])).toBe(0.5);
    expect(toolShare([null, 1, 2, null])).toBeNull();
    expect(toolShare(null)).toBeNull();
    expect([permissionGroup('approved'), permissionGroup('approved-for-location'), permissionGroup('denied-no-approval-rule-and-could-not-request-from-user'), permissionGroup('cancelled')]).toEqual([0, 0, 1, 2]);
    expect([msLabel(850), msLabel(1234), msLabel(125_000), msLabel(null)]).toEqual(['850ms', '1.2秒', '2分', '—']);
  });
});

describe('Phase 7: 要点欄とツールの絞り込み', () => {
  it('AIU 上位・失敗率の高いツール・compaction の多いセッション・未使用の skill。リンクは詳細ページか #…', async () => {
    const all = (await records()).map((r) => summarize(r, identityAnonymizer(), null));
    const filter = emptyFilter();
    const g = highlights(all, aggregate(all).usage, { filter, anonymized: false, installed: { skills: ['grep-skill', 'zz'], disabled: [] } });
    expect(g.map((x) => x.kind)).toEqual(['cost', 'tool-failure', 'compaction', 'unused-skill']);
    expect(g[0].items.map((i) => [i.text, i.href])).toEqual([
      ['session A: 3 AIU(この条件の合計の 75%)', 'sessions/a.html'],
      ['b: 1 AIU(この条件の合計の 25%)', 'sessions/b.html'],
    ]);
    expect(g[1].items).toEqual([{ text: 'grep: 失敗率 50%(失敗 3・拒否 0 / 6 回、1 セッション)', href: '#tool=grep', linkLabel: 'このツールを使ったセッションに絞り込む' }]);
    expect(g[2].items.map((i) => i.href)).toEqual(['sessions/a.html', 'sessions/b.html']);
    expect(g[3].items[0]).toMatchObject({ text: '2 / 2 件: grep-skill、zz', href: '#view=unused-skills' });
    // ツールの絞り込み
    expect(applyFilter(all, decodeFilter('#tool=grep')).map((s) => s.id)).toEqual(['a']);
    expect(applyFilter(all, decodeFilter('#tool=mcp%3Anone')).map((s) => s.id)).toEqual([]);
  });

  it('AIU の記録が無ければ出力トークンで並べる。伏せ字モードでは本文を出さない', async () => {
    const recs = await records();
    for (const r of recs) r.tokens.nanoAiu = null;
    const anon = createAnonymizer(recs);
    const all = recs.map((r) => summarize(r, anon, null));
    const g = highlights(all, aggregate(all).usage, { filter: emptyFilter(), anonymized: true, installed: null });
    expect(g[0].title).toBe('出力トークンの多いセッション');
    expect(g[0].items[0].text.startsWith('project-01・2026-10-01')).toBe(true);
    expect(g[0].items[0].text).not.toContain('session A');
    expect(g.map((x) => x.kind)).not.toContain('unused-skill');
  });

  it('URL ハッシュ: 絞り込みと表示の指定(view)を分けて読み書きし、#overview のようなページ内リンクは状態とみなさない', () => {
    const f = { ...emptyFilter(), project: 'acme/a', tool: 'mcp:gh' };
    expect(filterHref(f)).toBe(`#${encodeFilter(f)}`);
    expect(filterHref(f, 'unused-skills')).toBe('#project=acme%2Fa&tool=mcp%3Agh&view=unused-skills');
    expect(decodeFilter(filterHref(f, 'unused-skills'))).toEqual(f);
    expect(decodeView('#project=x&view=unused-skills')).toBe('unused-skills');
    expect(decodeView('#project=x')).toBeNull();
    expect(isStateHash('#overview')).toBe(false);
    expect(isStateHash('#tool=grep')).toBe(true);
    expect(filterHref(emptyFilter(), 'unused-skills')).toBe('#view=unused-skills');
  });
});
