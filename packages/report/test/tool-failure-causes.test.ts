// ツールの失敗の要因: 要約(summarize)・利用ランキングの要因別の行・要点欄・詳細ページ。文はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { aggregate, usageRanking } from '../src/lib/aggregate.ts';
import { identityAnonymizer } from '../src/lib/anonymize.ts';
import { emptyFilter } from '../src/lib/filter.ts';
import { highlights } from '../src/lib/highlights.ts';
import { packSummary, unpackSummary } from '../src/lib/pack.ts';
import { summarize } from '../src/lib/summarize.ts';

let n = 0;
const ev = (type: string, data: unknown): CopilotEvent => ({ type, data, id: `e${n++}`, timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString() });
const call = (id: string, toolName: string, message: string | null, extra: Record<string, unknown> = {}): CopilotEvent[] => [
  ev('tool.execution_start', { toolCallId: id, toolName, arguments: {}, ...extra }),
  ev('tool.execution_complete', message == null ? { toolCallId: id, success: true } : { toolCallId: id, success: false, error: { code: 'failure', message } }),
];
const TIMEOUT = 'MCP server "zz-srv": McpError: MCP error -32001: Request timed out';

async function records(): Promise<SessionRecord[]> {
  const a = await normalizeSession({
    id: 'a',
    workspace: { cwd: 'X:\\zz-a', created_at: '2026-10-01T00:00:00Z' },
    events: [
      ev('user.message', { content: 'a' }),
      ...call('1', 'zz-srv-find', TIMEOUT, { mcpServerName: 'zz-srv' }),
      ...call('2', 'zz-srv-find', TIMEOUT, { mcpServerName: 'zz-srv' }),
      ...call('3', 'zz-srv-read', 'Path does not exist', { mcpServerName: 'zz-srv' }),
      ...call('4', 'zz-srv-read', null, { mcpServerName: 'zz-srv' }),
      ...call('5', 'view', 'Path does not exist'),
      ...call('6', 'view', null),
    ],
  });
  const b = await normalizeSession({
    id: 'b',
    workspace: { cwd: 'X:\\zz-b', created_at: '2026-10-02T00:00:00Z' },
    events: [
      ev('user.message', { content: 'b' }),
      ...call('1', 'zz-srv-find', TIMEOUT, { mcpServerName: 'zz-srv' }),
      ...call('2', 'view', 'Path does not exist'),
      ...call('3', 'view', 'Path does not exist'),
      ...call('4', 'view', null),
      ...call('5', 'view', null),
      ...call('6', 'view', null),
    ],
  });
  return [a, b];
}

describe('失敗の要因', () => {
  it('要約は失敗のあったツールだけ要因を持ち、埋め込みの縮小と埋め戻しで変わらない', async () => {
    const [a] = await records();
    const s = summarize(a!, identityAnonymizer(), null);
    expect(s.tools.causes).toEqual({ 'zz-srv-find': { timeout: 2 }, 'zz-srv-read': { not_found: 1 }, view: { not_found: 1 } });
    expect(unpackSummary(packSummary(s)).tools.causes).toEqual(s.tools.causes);
    const ok = summarize(await normalizeSession({ id: 'c', workspace: { cwd: 'X:\\zz-c' }, events: [ev('user.message', { content: 'c' }), ...call('1', 'view', null)] }), identityAnonymizer(), null);
    expect(ok.tools.causes).toEqual({});
  });

  it('要因ごとの行は多い順で、その要因で失敗したツール(MCP はサーバーの中のツール)を持つ。ツールと MCP の行にも要因を足す', async () => {
    const u = usageRanking((await records()).map((r) => summarize(r, identityAnonymizer(), null)));
    expect(u.causes).toEqual([
      {
        cause: 'not_found',
        label: '対象が見つからない',
        count: 4,
        sessions: 2,
        tools: [
          { key: 'view', label: 'view', mcpServer: null, count: 3 },
          { key: 'zz-srv-read', label: 'read', mcpServer: 'zz-srv', count: 1 },
        ],
      },
      { cause: 'timeout', label: '時間切れ', count: 3, sessions: 2, tools: [{ key: 'zz-srv-find', label: 'find', mcpServer: 'zz-srv', count: 3 }] },
    ]);
    expect(u.causesUnrecorded).toBe(0);
    expect(u.tools.find((t) => t.key === 'mcp:zz-srv')).toMatchObject({ failure: 4, causes: { timeout: 3, not_found: 1 } });
    expect(u.tools.find((t) => t.key === 'view')).toMatchObject({ failure: 3, causes: { not_found: 3 } });
    expect(u.mcp[0]!.tools).toEqual([
      { name: 'zz-srv-find', calls: 3, failure: 3, causes: { timeout: 3 } },
      { name: 'zz-srv-read', calls: 2, failure: 1, causes: { not_found: 1 } },
    ]);
  });

  it('要因の記録が無い失敗(以前の版で集計したセッション)は、要因の行に入れずに数だけ残す', async () => {
    const summaries = (await records()).map((r) => summarize(r, identityAnonymizer(), null));
    const old = { ...summaries[0]!, tools: { ...summaries[0]!.tools, causes: undefined } };
    const u = usageRanking([old, summaries[1]!]);
    expect(u.causesUnrecorded).toBe(4);
    expect(u.causes.map((c) => [c.cause, c.count])).toEqual([
      ['not_found', 2],
      ['timeout', 1],
    ]);
  });

  it('要点欄の「失敗率の高いツール」に、いちばん多い要因を添える', async () => {
    const all = (await records()).map((r) => summarize(r, identityAnonymizer(), null));
    const g = highlights(all, aggregate(all).usage, { filter: emptyFilter(), anonymized: false, installed: null });
    const tf = g.find((x) => x.kind === 'tool-failure')!;
    expect(tf.items.map((i) => i.text)).toEqual([
      'MCP zz-srv: 失敗率 80%(失敗 4・拒否 0 / 5 回、2 セッション)。主な要因: 時間切れ 3 回',
      'view: 失敗率 43%(失敗 3・拒否 0 / 7 回、2 セッション)。主な要因: 対象が見つからない 3 回',
    ]);
  });
});
