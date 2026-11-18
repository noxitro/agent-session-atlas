import { describe, expect, it } from 'vitest';
import { computeMetrics, distribution } from '../src/metrics.ts';
import { normalizeSession } from '../src/normalize.ts';

describe('computeMetrics', () => {
  it('全体・プロジェクト・クライアント・月・モデル別に集計する', async () => {
    const a = await normalizeSession({
      id: 'a',
      workspace: { client_name: 'github/cli', repository: 'o/a', created_at: '2026-09-30T23:00:00Z' },
      events: [
        { type: 'tool.execution_start', data: { toolName: 'view' }, timestamp: '2026-09-30T23:00:00Z' },
        {
          type: 'session.usage_record',
          data: { usage: { model: 'm1', inputTokens: 10, outputTokens: 1, cost: 1, initiator: 'user' } },
          timestamp: '2026-09-30T23:00:01Z',
        },
      ],
    });
    const b = await normalizeSession({
      id: 'b',
      workspace: { client_name: 'github/autopilot', repository: 'o/a', created_at: '2026-10-01T01:00:00Z' },
      events: [{ type: 'assistant.message', data: { model: 'm2', outputTokens: 3 }, timestamp: '2026-10-01T01:00:00Z' }],
    });
    const m = computeMetrics([a, b]);
    expect(m.overall.sessions).toBe(2);
    expect(m.overall.sessionsWithInputTokens).toBe(1);
    expect(m.overall.tokens).toMatchObject({ input: 10, output: 4, premiumRequests: 1 });
    // Phase 6: mcp・results を足した(この入力には complete が無いので results は空)
    expect(m.overall.tools).toEqual({ total: 1, byName: { view: 1 }, internal: 0, mcp: {}, results: {} });
    expect(Object.keys(m.byProject)).toEqual(['o/a']);
    expect(Object.keys(m.byClient)).toEqual(['github/autopilot', 'github/cli']);
    expect(Object.keys(m.byMonth)).toEqual(['2026-09', '2026-10']);
    expect(m.byModel.m1).toMatchObject({ sessions: 1, input: 10, output: 1 });
    expect(m.byModel.m2).toMatchObject({ sessions: 1, input: 0, output: 3 });
  });

  it('distribution', () => {
    expect(distribution([])).toEqual({ total: 0, median: null, p90: null });
    expect(distribution([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ total: 55, median: 5, p90: 9 });
  });
});
