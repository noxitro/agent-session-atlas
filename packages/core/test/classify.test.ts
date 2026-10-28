import { describe, expect, it } from 'vitest';
import { FileTracker, isMainAssistantMessage, isUserTurn, normalizeModel, resolveFilePath } from '../src/classify.ts';
import { computeMetrics } from '../src/metrics.ts';
import { normalizeSession } from '../src/normalize.ts';

describe('normalizeModel', () => {
  it('claude-<family>-<major>-<minor> を <major>.<minor> に、先頭の <UUID>/ を外す', () => {
    expect(normalizeModel('claude-haiku-5-5')).toBe('claude-haiku-5.5');
    expect(normalizeModel('claude-haiku-5.5')).toBe('claude-haiku-5.5');
    // <UUID> はプロバイダ設定の ID の形をした架空の値
    expect(normalizeModel('11111111-2222-4333-8444-555555555555/claude-sonnet-5-5')).toBe('claude-sonnet-5.5');
    expect(normalizeModel('22222222-3333-4444-8555-666666666666/thinkingmachines/inkling:free')).toBe('thinkingmachines/inkling:free');
    // 変えないもの: 日付付き・minor が 2 桁・claude 以外・major だけ
    expect(normalizeModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(normalizeModel('claude-opus-4-10')).toBe('claude-opus-4-10');
    expect(normalizeModel('gpt-5-4')).toBe('gpt-5-4');
    expect(normalizeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });
});

describe('メッセージの判定', () => {
  it('autopilot の自動継続と source 付きは依頼に数えない / agentId だけの応答は本体に数えない', () => {
    expect(isUserTurn({})).toBe(true);
    expect(isUserTurn({ source: 'skill-x' })).toBe(false);
    expect(isUserTurn({ isAutopilotContinuation: true })).toBe(false);
    expect(isMainAssistantMessage({ data: {} })).toBe(true);
    expect(isMainAssistantMessage({ data: { parentToolCallId: 'p' } })).toBe(false);
    expect(isMainAssistantMessage({ agentId: 'call_1', data: {} })).toBe(false);
  });
});

describe('ファイルパス', () => {
  it('cwd 基準で絶対パスにし、Windows は大文字小文字を無視して重複除去、session-state は外して数える', () => {
    expect(resolveFilePath('src/a.ts', 'C:\\w\\r')).toBe('C:\\w\\r\\src\\a.ts');
    expect(resolveFilePath('c:/w/r/src/../src/a.ts', null)).toBe('C:\\w\\r\\src\\a.ts');
    expect(resolveFilePath('src/a.ts', '/home/u/r')).toBe('/home/u/r/src/a.ts');
    expect(resolveFilePath('src/a.ts', null)).toBe('src/a.ts');

    const t = new FileTracker();
    t.add('edit', 'src\\a.ts', 'C:\\w\\r');
    t.add('edit', 'C:\\W\\R\\SRC\\A.TS', 'C:\\w\\r');
    t.add('create', 'docs/new.md', 'C:\\w\\r');
    t.add('edit', 'C:\\w\\r\\docs\\new.md', 'C:\\w\\r'); // 作成後の編集は「作成」のまま
    t.add('edit', 'old.txt', 'C:\\w\\r');
    t.add('delete', 'C:\\w\\r\\old.txt', 'C:\\w\\r');
    t.add('create', 'X:\\Home\\u\\.copilot\\session-state\\abc\\plan.md', 'C:\\w\\r');
    t.add('edit', 'x:\\home\\u\\.copilot\\session-state\\abc\\plan.md', 'C:\\w\\r');
    expect(t.result()).toEqual({ changed: ['C:\\w\\r\\src\\a.ts'], created: ['C:\\w\\r\\docs\\new.md'], deleted: ['C:\\w\\r\\old.txt'], sessionState: 1 });
  });
});

describe('normalizeSession(Phase 5 の形式)', () => {
  it('空のセッション・内部ツール・autopilot の自動継続・agentId だけの応答・fileEdits', async () => {
    const empty = await normalizeSession({ id: 'e', workspace: { cwd: 'C:\\w' }, events: [{ type: 'session.start', data: {}, timestamp: '2026-10-01T00:00:00Z' }] });
    expect(empty.empty).toBe(true);

    const r = await normalizeSession({
      id: 'n',
      workspace: { cwd: 'C:\\w' },
      events: [
        { type: 'session.start', data: { selectedModel: '11111111-2222-4333-8444-555555555555/claude-haiku-5-5', context: { cwd: 'C:\\w' } }, timestamp: '2026-10-01T00:00:00Z' },
        { type: 'user.message', data: { content: 'go' }, timestamp: '2026-10-01T00:00:01Z' },
        { type: 'user.message', data: { content: '', isAutopilotContinuation: true }, timestamp: '2026-10-01T00:00:02Z' },
        { type: 'tool.execution_start', data: { toolName: 'report_intent', toolCallId: 'r1' }, timestamp: '2026-10-01T00:00:03Z' },
        { type: 'tool.execution_complete', data: { toolCallId: 'r1', success: false }, timestamp: '2026-10-01T00:00:03Z' },
        { type: 'tool.execution_start', data: { toolName: 'powershell', toolCallId: 't1' }, timestamp: '2026-10-01T00:00:04Z' },
        { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, fileEdits: [{ path: 'C:\\w\\gone.txt', kind: 'delete' }] }, timestamp: '2026-10-01T00:00:05Z' },
        { type: 'assistant.message', data: { content: 'sub', model: 'claude-haiku-5-5' }, agentId: 'call_x', timestamp: '2026-10-01T00:00:06Z' },
        { type: 'assistant.message', data: { content: 'main', model: 'claude-haiku-5.5' }, timestamp: '2026-10-01T00:00:07Z' },
      ],
    });
    expect(r).toMatchObject({ empty: false, turns: 1, autopilotContinuations: 1, assistantMessages: 1, lastAssistantMessage: 'main', models: ['claude-haiku-5.5'] });
    // Phase 6: 内部ツールの結果は results に入れない(powershell の成功 1 だけ)
    expect(r.tools).toEqual({
      byName: { powershell: 1 },
      total: 1,
      internal: { byName: { report_intent: 1 }, total: 1 },
      mcp: {},
      results: { powershell: { success: 1, failure: 0, denied: 0 } },
      // Phase 7: 所要時間(内部ツールは除く。start → complete が 1 秒)
      durations: { powershell: [1000] },
      durationOutliers: {},
    });
    expect(r.friction.toolFailures).toBe(0); // 内部ツールの失敗は数えない
    expect(r.files).toEqual({ changed: [], created: [], deleted: ['C:\\w\\gone.txt'], sessionState: 0 });
    expect(r.tokens.source).toBe('none');

    const m = computeMetrics([empty, r]);
    expect(m.emptySessions).toBe(1);
    expect(m.overall.sessions).toBe(1);
    expect(m.overall.sessionsMissingTokens).toBe(1);
    expect(m.overall.tokenSources.none).toBe(1);
    expect(m.overall.tools).toEqual({ total: 1, byName: { powershell: 1 }, internal: 1, mcp: {}, results: { powershell: { success: 1, failure: 0, denied: 0 } } });
    expect(m.overall.autopilotContinuations).toBe(1);
  });

  it('shutdown の modelMetrics は表記揺れを 1 つのモデルに足し合わせる', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        { type: 'user.message', data: { content: 'x' }, timestamp: '2026-05-01T00:00:00Z' },
        {
          type: 'session.shutdown',
          data: {
            modelMetrics: {
              'claude-sonnet-5-5': { usage: { inputTokens: 10, outputTokens: 1 }, requests: { count: 1, cost: 1 } },
              'claude-sonnet-5.5': { usage: { inputTokens: 5, outputTokens: 2 }, requests: { count: 2, cost: 0 } },
            },
          },
          timestamp: '2026-05-01T00:01:00Z',
        },
      ],
    });
    expect(r.tokens.source).toBe('shutdown');
    expect(Object.keys(r.tokens.byModel)).toEqual(['claude-sonnet-5.5']);
    expect(r.tokens.byModel['claude-sonnet-5.5']).toMatchObject({ input: 15, output: 3, requests: 3, premiumRequests: 1 });
    expect(r.models).toEqual(['claude-sonnet-5.5']);
  });
});
