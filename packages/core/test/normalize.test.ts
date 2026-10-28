import { describe, expect, it } from 'vitest';
import { mergeUsage, normalizeSession, normalizeTime, projectKey } from '../src/normalize.ts';
import type { CopilotEvent, DbUsageRow } from '../src/types.ts';

let n = 0;
const ev = (type: string, data: unknown, timestamp: string, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({
  type,
  data,
  timestamp,
  id: `e${n++}`,
  ...extra,
});

const dbRow = (p: Partial<DbUsageRow>): DbUsageRow => ({
  session_id: 's',
  turn_index: 0,
  agent_id: null,
  parent_tool_call_id: null,
  model: 'm1',
  input_tokens: 100,
  output_tokens: 10,
  cache_read_tokens: 50,
  cache_write_tokens: 5,
  reasoning_tokens: 1,
  total_nano_aiu: 1000,
  request_multiplier: 1,
  initiator: 'user',
  created_at: '2026-10-01T00:00:01.000Z',
  ...p,
});

const ur = (p: Record<string, unknown>, ts: string, extra: Partial<CopilotEvent> = {}): CopilotEvent =>
  ev(
    'session.usage_record',
    {
      usage: {
        model: 'm1',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        reasoningTokens: 1,
        cost: 1,
        initiator: 'user',
        copilotUsage: { totalNanoAiu: 1000 },
        ...p,
      },
    },
    ts,
    extra,
  );

describe('mergeUsage', () => {
  it('DB を優先し、同一リクエスト(model・input・output 一致、5 秒以内)の usage_record は捨てる', () => {
    const rows = [dbRow({}), dbRow({ output_tokens: 20, created_at: '2026-10-01T00:00:02.000Z', initiator: 'agent' })];
    const recs = [
      ur({}, '2026-10-01T00:00:01.002Z'), // rows[0] と重複
      ur({ outputTokens: 20, initiator: 'agent' }, '2026-10-01T00:00:09.000Z'), // 7 秒ずれ → 別物
      ur({ outputTokens: 30, initiator: 'agent' }, '2026-10-01T00:00:03.000Z'), // DB に無い
    ];
    const { items, duplicates } = mergeUsage(rows, recs);
    expect(duplicates).toBe(1);
    expect(items.map((i) => [i.origin, i.output])).toEqual([
      ['db', 10],
      ['db', 20],
      ['events', 20],
      ['events', 30],
    ]);
  });
});

describe('normalizeSession', () => {
  it('トークン・skills・agents・hooks・摩擦・未知種別をまとめる', async () => {
    const events: CopilotEvent[] = [
      ev('session.start', { version: 1, copilotVersion: '1.0.103', context: { cwd: 'C:\\r', gitRoot: 'C:\\r', repository: 'o/r', branch: 'main' } }, '2026-10-01T00:00:00.000Z'),
      ev('system.message', { role: 'system', content: '<custom_instruction>\n# Copilot Instructions\nabc\n</custom_instruction>' }, '2026-10-01T00:00:00.100Z'),
      ev('user.message', { content: 'do it' }, '2026-10-01T00:00:00.500Z'),
      ev('user.message', { content: 'skill body', source: 'skill-wiki-query' }, '2026-10-01T00:00:00.600Z'),
      ev('hook.start', { hookType: 'preToolUse' }, '2026-10-01T00:00:00.700Z'),
      ev('tool.execution_start', { toolName: 'skill', toolCallId: 't1', arguments: { skill: 'wiki-query' } }, '2026-10-01T00:00:01.000Z'),
      ev('skill.invoked', { name: 'wiki-query' }, '2026-10-01T00:00:01.100Z'),
      ev('skill.invoked', { name: 'impeccable' }, '2026-10-01T00:00:01.200Z'),
      ev('tool.execution_start', { toolName: 'view', toolCallId: 't2', arguments: { path: 'D:\\global-llm-wiki\\index.md' } }, '2026-10-01T00:00:01.300Z'),
      ev('tool.execution_complete', { toolCallId: 't2', success: false }, '2026-10-01T00:00:01.400Z'),
      ev('tool.execution_start', { toolName: 'ask_user', toolCallId: 't3', arguments: {} }, '2026-10-01T00:00:01.500Z'),
      ev('tool.execution_start', { toolName: 'create', toolCallId: 't4', arguments: { path: 'C:\\r\\new.txt' } }, '2026-10-01T00:00:01.550Z'),
      ev('subagent.started', { toolCallId: 'a1', agentName: 'explore', model: 'm2' }, '2026-10-01T00:00:01.600Z', { agentId: 'a1' }),
      ev('assistant.message', { content: 'sub', parentToolCallId: 'a1', model: 'm2', outputTokens: 7 }, '2026-10-01T00:00:01.650Z', { agentId: 'a1' }),
      ev('subagent.completed', { toolCallId: 'a1', agentName: 'explore', totalTokens: 999, totalToolCalls: 3 }, '2026-10-01T00:00:02.000Z', { agentId: 'a1' }),
      ev('subagent.failed', { toolCallId: 'a2', agentName: 'general-purpose', error: 'x' }, '2026-10-01T00:00:02.100Z'),
      ur({ model: 'm2', inputTokens: 40, outputTokens: 4, initiator: 'sub-agent', cost: 1 }, '2026-10-01T00:00:02.200Z', { agentId: 'a1' }),
      ev('session.compaction_complete', { success: true, preCompactionTokens: 1234 }, '2026-10-01T00:00:03.000Z'),
      ev('abort', { reason: 'user_initiated' }, '2026-10-01T00:00:04.000Z'),
      ev('session.error', { errorType: 'quota' }, '2026-10-01T00:00:05.000Z'),
      ev('permission.requested', {}, '2026-10-01T00:00:06.000Z'),
      ev('session.model_change', { newModel: 'm3' }, '2026-10-01T00:00:07.000Z'),
      ev('session.mode_changed', { newMode: 'plan' }, '2026-10-01T00:00:08.000Z'),
      ev('brand.new_event', {}, '2026-10-01T00:00:09.000Z'),
      ev('assistant.message', { content: 'done!', model: 'm1', outputTokens: 10 }, '2026-10-01T00:20:00.000Z'),
    ];
    const r = await normalizeSession({
      id: 's',
      hasDir: true,
      workspace: { client_name: 'github/cli', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:20:00.000Z' },
      db: {
        session: { id: 's', cwd: 'C:\\r', repository: 'o/r', host_type: 'github', branch: 'main', summary: 'sum', created_at: '2026-10-01 00:00:00', updated_at: '2026-10-01 00:20:00' },
        usage: [dbRow({})],
      },
      events,
    });
    expect(r.sources).toEqual(['db', 'dir']);
    expect(r.project).toBe('o/r');
    expect(r.client).toBe('github/cli');
    expect(r.turns).toBe(1);
    expect(r.firstUserMessage).toBe('do it');
    expect(r.lastAssistantMessage).toBe('done!');
    expect(r.copilotVersion).toBe('1.0.103');
    expect(r.durationMs).toBe(20 * 60 * 1000);
    expect(r.activeMs).toBe(9000); // 9 秒以降は 20 分空くので除外
    expect(r.tokens.source).toBe('db+events');
    expect(r.tokens.input).toBe(140);
    expect(r.tokens.output).toBe(14);
    expect(r.tokens.premiumRequests).toBe(1); // ユーザー起点のみ
    expect(r.tokens.byAgent.explore.input).toBe(40);
    expect(r.tokens.byAgent.main.input).toBe(100);
    expect(r.tokens.subagentTotalTokens).toBe(999);
    expect(r.tokens.maxPreCompactionTokens).toBe(1234);
    // Phase 6: MCP サーバー別(この fixture には無い)と、ツール別の結果(view の失敗 1。他は complete が無い)
    expect(r.tools).toEqual({
      byName: { skill: 1, view: 1, ask_user: 1, create: 1 },
      total: 4,
      internal: { byName: {}, total: 0 },
      mcp: {},
      results: { view: { success: 0, failure: 1, denied: 0 } },
      // Phase 7: 所要時間(complete があるのは view だけ)
      durations: { view: [100] },
      durationOutliers: {},
    });
    expect(r.skills.map((s) => [s.name, s.via])).toEqual([
      ['wiki-query', 'both'],
      ['impeccable', 'event'],
    ]);
    expect(r.agents.map((a) => [a.name, a.status, a.totalTokens])).toEqual([
      ['explore', 'completed', 999],
      ['general-purpose', 'failed', null],
    ]);
    expect(r.hooks).toEqual({ byType: { preToolUse: 1 }, total: 1 });
    expect(r.wiki).toMatchObject({ indexReads: 1, skillCalls: ['wiki-query'] });
    expect(r.friction).toEqual({
      compactions: 1,
      aborts: 1,
      errors: 1,
      permissionRequests: 1,
      askUser: 1,
      modelChanges: 1,
      modeChanges: 1,
      toolFailures: 1,
      subagentFailures: 1,
    });
    expect(r.instructions.map((i) => i.file)).toEqual(['copilot-instructions.md']);
    expect(r.files.created).toEqual(['C:\\r\\new.txt']);
    expect(r.unknownEventTypes).toEqual({ 'brand.new_event': 1 });
    expect(r.models).toEqual(['m1', 'm2', 'm3']);
  });

  it('旧形式(usage が無い)は入力トークン null・partial、DB のみは turns から補う', async () => {
    const legacy = await normalizeSession({
      id: 'old',
      events: [ev('assistant.message', { content: 'a', model: 'm', outputTokens: 5 }, '2026-01-01T00:00:00Z')],
    });
    expect(legacy.tokens).toMatchObject({ input: null, output: 5, source: 'partial' });
    expect(legacy.tokens.byModel.m.input).toBeNull();

    const dbOnly = await normalizeSession({
      id: 'd',
      db: {
        session: { id: 'd', cwd: 'C:/x/', repository: null, host_type: null, branch: null, summary: 's', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:10:00' },
        turns: [
          { session_id: 'd', turn_index: 1, user_message: 'second', assistant_response: 'r2', timestamp: null },
          { session_id: 'd', turn_index: 0, user_message: 'first', assistant_response: 'r1', timestamp: null },
        ],
      },
    });
    expect(dbOnly.sources).toEqual(['db']);
    expect(dbOnly.turns).toBe(2);
    expect(dbOnly.firstUserMessage).toBe('first');
    expect(dbOnly.lastAssistantMessage).toBe('r2');
    expect(dbOnly.tokens.source).toBe('none');
    expect(dbOnly.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(dbOnly.durationMs).toBe(600_000);
    expect(dbOnly.project).toBe('C:\\x');
  });
});

describe('helpers', () => {
  it('normalizeTime / projectKey', () => {
    expect(normalizeTime('2026-07-08 01:02:03')).toBe('2026-07-08T01:02:03Z');
    expect(normalizeTime('2026-07-08T01:02:03.000Z')).toBe('2026-07-08T01:02:03.000Z');
    expect(projectKey(null, 'e:\\dev\\r\\', null)).toBe('E:\\dev\\r');
    expect(projectKey(null, null, null)).toBe('(unknown)');
  });
});
