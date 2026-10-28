// Phase 6: 利用ランキング(絞り込み後のセッションから)・未使用の skill・要約の形・伏せ字
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import { HOME_PROJECT, TEMP_PROJECT } from '../../core/src/project-keys.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { aggregate, failureRate, unusedSkills, usageRanking } from '../src/lib/aggregate.ts';
import { createAnonymizer, identityAnonymizer } from '../src/lib/anonymize.ts';
import { applyFilter, emptyFilter } from '../src/lib/filter.ts';
import { summarize } from '../src/lib/summarize.ts';

let n = 0;
const ev = (type: string, data: unknown, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({
  type,
  data,
  timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString(),
  id: `e${n++}`,
  ...extra,
});

/** ツール呼び出し 1 回(結果つき) */
function call(id: string, toolName: string, result: 'ok' | 'fail' | 'deny' | null, extra: Record<string, unknown> = {}): CopilotEvent[] {
  const start = ev('tool.execution_start', { toolCallId: id, toolName, arguments: {}, ...extra });
  if (result == null) return [start];
  const done =
    result === 'ok'
      ? { toolCallId: id, success: true }
      : { toolCallId: id, success: false, error: { code: result === 'deny' ? 'denied' : 'failure' } };
  return [start, ev('tool.execution_complete', done)];
}

async function sessions(): Promise<SessionRecord[]> {
  const a = await normalizeSession({
    id: 'a',
    workspace: { repository: 'acme/a', client_name: 'github/cli', created_at: '2026-10-01T00:00:00Z' },
    events: [
      ev('user.message', { content: 'a' }),
      ...call('1', 'gh-search', 'ok', { mcpServerName: 'gh' }),
      ...call('2', 'gh-get', 'fail', { mcpServerName: 'gh' }),
      ...call('3', 'view', 'ok'),
      ...call('4', 'view', 'deny'),
      ...call('5', 'view', null),
      ev('skill.invoked', { name: 'wiki-query', trigger: 'user-invoked' }),
      ev('subagent.started', { toolCallId: 's1', agentName: 'explore' }),
      ev('subagent.completed', { toolCallId: 's1', agentName: 'explore', totalTokens: 500 }),
      ev('hook.start', { hookType: 'preToolUse' }),
      ev('hook.start', { hookType: 'preToolUse' }),
      ev('session.shutdown', { codeChanges: { linesAdded: 12, linesRemoved: 4, filesModified: [] } }),
    ],
  });
  const b = await normalizeSession({
    id: 'b',
    workspace: { repository: 'acme/b', client_name: 'github/autopilot', created_at: '2026-10-02T00:00:00Z' },
    events: [
      ev('user.message', { content: 'b' }),
      ...call('1', 'view', 'ok'),
      ...call('2', 'gh-search', 'ok', { mcpServerName: 'gh' }),
      ev('tool.execution_start', { toolCallId: '3', toolName: 'skill', arguments: { skill: 'wiki-query' } }),
      ev('subagent.started', { toolCallId: 's1', agentName: 'explore' }),
      ev('subagent.failed', { toolCallId: 's1', agentName: 'explore' }),
      ev('hook.start', { hookType: 'postToolUse' }),
    ],
  });
  return [a, b];
}

describe('summarize(Phase 6 の形)', () => {
  it('失敗・拒否・結果なしのあったツールだけ issues に持ち、skill / agent は内訳つき', async () => {
    const [a] = await sessions();
    const s = summarize(a, identityAnonymizer(), null);
    expect(s.tools.mcp).toEqual({ gh: { 'gh-search': 1, 'gh-get': 1 } });
    // view: 3 回のうち結果 2(成功 1・拒否 1)。gh-search は全部成功なので持たない
    expect(s.tools.issues).toEqual({ 'gh-get': [1, 0, 1], view: [0, 1, 2] });
    expect(s.skills).toEqual({ 'wiki-query': [1, 0, 0] });
    expect(s.agents.byName).toEqual({ explore: [1, 0, 500] });
    expect(s.hooks).toEqual({ total: 2, byType: { preToolUse: 2 } });
    expect(s.lines).toEqual({ added: 12, removed: 4, source: 'shutdown' });
    expect(s.projectSource).toBe('repository');
  });
});

describe('usageRanking', () => {
  it('MCP ツールはサーバーごとに 1 行、失敗率は(失敗 + 拒否)÷ 結果のあった回数', async () => {
    const summaries = (await sessions()).map((r) => summarize(r, identityAnonymizer(), null));
    const u = usageRanking(summaries);
    expect(u.tools.map((t) => [t.key, t.calls, t.completed, t.success, t.failure, t.denied, t.sessions])).toEqual([
      ['view', 4, 3, 2, 0, 1, 2],
      ['mcp:gh', 3, 3, 2, 1, 0, 2],
      ['skill', 1, 0, 0, 0, 0, 1],
    ]);
    expect(u.tools[1]).toMatchObject({ label: 'gh', mcpServer: 'gh' });
    expect(failureRate(u.tools[0])).toBeCloseTo(1 / 3);
    expect(failureRate(u.tools[2])).toBeNull();
    expect(u.mcp).toEqual([
      { server: 'gh', calls: 3, completed: 3, failure: 1, denied: 0, sessions: 2, tools: [{ name: 'gh-search', calls: 2 }, { name: 'gh-get', calls: 1 }] },
    ]);
    // b の skill ツール呼び出しはエージェントが呼んだもの
    expect(u.skills).toEqual([{ name: 'wiki-query', uses: 2, user: 1, agent: 1, unknown: 0, sessions: 2 }]);
    expect(u.agents).toEqual([{ name: 'explore', runs: 2, failed: 1, tokens: 500, sessions: 2 }]);
    expect(u.hooks).toEqual([
      { name: 'preToolUse', count: 2, sessions: 1 },
      { name: 'postToolUse', count: 1, sessions: 1 },
    ]);
  });

  it('絞り込みに追従する(プロジェクトで絞ると、そのセッションの分だけになる)', async () => {
    const summaries = (await sessions()).map((r) => summarize(r, identityAnonymizer(), null));
    const only = aggregate(applyFilter(summaries, { ...emptyFilter(), project: 'acme/b' }));
    expect(only.usage.tools.map((t) => [t.key, t.calls])).toEqual([
      ['mcp:gh', 1],
      ['skill', 1],
      ['view', 1],
    ]);
    expect(only.usage.agents).toEqual([{ name: 'explore', runs: 1, failed: 1, tokens: 0, sessions: 1 }]);
    expect(only.overall).toMatchObject({ linesAdded: 0, linesRemoved: 0, sessionsWithLines: 0 });
    const all = aggregate(summaries);
    expect(all.overall).toMatchObject({ linesAdded: 12, linesRemoved: 4, sessionsWithLines: 1 });
  });

  it('未使用の skill は大文字小文字を区別せずに突き合わせる', () => {
    expect(unusedSkills(['Wiki-Query', 'impeccable', 'pptx'], ['wiki-query', 'other'])).toEqual(['impeccable', 'pptx']);
    expect(unusedSkills([], ['x'])).toEqual([]);
  });
});

describe('伏せ字(Phase 6)', () => {
  it('まとめたプロジェクト名はそのまま、git の origin で決めた owner/repo は伏せる', () => {
    const anon = createAnonymizer([
      { project: HOME_PROJECT, cwd: 'X:\\home\\someone', gitRoot: null, repository: null, branch: null },
      { project: TEMP_PROJECT, cwd: 'X:\\home\\someone\\AppData\\Local\\Temp\\probe', gitRoot: null, repository: null, branch: null },
      { project: 'secret-owner/secret-repo', cwd: 'X:\\code\\secret-repo', gitRoot: 'X:\\code\\secret-repo', repository: null, branch: 'main' },
    ]);
    expect(anon.project(HOME_PROJECT)).toBe(HOME_PROJECT);
    expect(anon.projectLabel(TEMP_PROJECT)).toBe(TEMP_PROJECT);
    expect(anon.project('secret-owner/secret-repo')).toBe('project-01');
    const scrubbed = anon.scrub('cloned secret-owner/secret-repo into X:\\code\\secret-repo; secret-owner wrote it');
    expect(scrubbed).not.toContain('secret-owner');
    expect(scrubbed).not.toContain('secret-repo');
  });
});
