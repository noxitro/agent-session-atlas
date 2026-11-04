// 実データとの突き合わせで見つかったログの形(新旧の形・空の終了記録・二重に出るイベント)を、合成したイベントで確かめる
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../src/normalize.ts';
import type { CopilotEvent } from '../src/types.ts';

let n = 0;
const ev = (type: string, data: unknown, timestamp: string, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({ type, data, timestamp, id: `x${n++}`, ...extra });
const T = (s: number): string => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
const run = (events: CopilotEvent[]) => normalizeSession({ id: 's', events });

describe('compaction のトークン(1)', () => {
  it('新しい形 { inputTokens, outputTokens } と古い形 { input, output, cachedInput } の両方を読む', async () => {
    const r = await run([
      ev('session.compaction_complete', { success: true, compactionTokensUsed: { input: 2000, output: 300, cachedInput: 1500 } }, T(1)),
      ev('session.compaction_complete', { success: true, compactionTokensUsed: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, copilotUsage: { totalNanoAiu: 5 } } }, T(2)),
    ]);
    expect(r.frictionDetail.compaction).toMatchObject({ recorded: 2, input: 3000, output: 400, nanoAiu: 5 });
  });

  it('tokensRemoved が無ければ 0 ではなく記録なし(removedRecorded 0)、あれば足す', async () => {
    const none = await run([ev('session.compaction_complete', { compactionTokensUsed: { inputTokens: 1, outputTokens: 1 } }, T(1))]);
    expect(none.frictionDetail.compaction).toMatchObject({ tokensRemoved: 0, removedRecorded: 0 });
    const some = await run([
      ev('session.compaction_complete', { tokensRemoved: 700 }, T(1)),
      ev('session.compaction_complete', {}, T(2)),
    ]);
    expect(some.frictionDetail.compaction).toMatchObject({ tokensRemoved: 700, removedRecorded: 1 });
  });
});

describe('変更行数(2)', () => {
  const emptyShutdown = (s: number): CopilotEvent =>
    ev('session.shutdown', { totalNanoAiu: 0, modelMetrics: {}, systemTokens: 0, conversationTokens: 0, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } }, T(s));

  it('codeChanges が 0 行・0 件なのにファイルの変更があれば、ツールごとの行数に切り替える', async () => {
    const r = await run([
      ev('session.start', { context: { cwd: 'C:\\w' } }, T(0)),
      ev('tool.execution_start', { toolName: 'edit', toolCallId: 'e1', arguments: { path: 'C:\\w\\a.ts' } }, T(1)),
      ev('tool.execution_complete', { toolCallId: 'e1', success: true, toolTelemetry: { metrics: { linesAdded: 4, linesRemoved: 2 } } }, T(2)),
      emptyShutdown(3),
    ]);
    expect(r.lines).toEqual({ added: 4, removed: 2, source: 'tools', note: 'empty-shutdown' });
  });

  it('サブエージェントだけが編集し行数の記録が無ければ、0 ではなく記録なし(理由: サブエージェントの編集)', async () => {
    const r = await run([
      ev('session.start', { context: { cwd: 'C:\\w' } }, T(0)),
      ev('tool.execution_start', { toolName: 'create', toolCallId: 'c1', arguments: { path: 'C:\\w\\new.ts' } }, T(1), { agentId: 'agent-1' }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true }, T(2), { agentId: 'agent-1' }),
      ev('session.shutdown', { codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } }, T(3)),
    ]);
    expect(r.files.created).toHaveLength(1);
    expect(r.lines).toEqual({ added: 0, removed: 0, source: 'none', note: 'subagent-edits' });
  });

  it('ファイルの変更が無ければ codeChanges の 0 行をそのまま使う', async () => {
    const r = await run([emptyShutdown(1)]);
    expect(r.lines).toEqual({ added: 0, removed: 0, source: 'shutdown' });
  });
});

describe('摩擦の二重計上(3)', () => {
  it('サブエージェントの session.error と直後の subagent.failed(parentId がその error)は agent 失敗の 1 件だけに数える', async () => {
    const err = ev('session.error', { errorType: 'quota', message: '402' }, T(1), { agentId: 'call-1' });
    const r = await run([
      ev('subagent.started', { agentName: 'implementer', toolCallId: 'call-1' }, T(0)),
      err,
      ev('subagent.failed', { agentName: 'implementer', toolCallId: 'call-1', error: '402 quota' }, T(1), { agentId: 'call-1', parentId: err.id }),
      // 対にならない(subagent.failed の続かない)サブエージェントのエラーと本体のエラーはそのまま数える
      ev('session.error', { errorType: 'rate_limit' }, T(5), { agentId: 'call-2' }),
      ev('session.error', { errorType: 'query' }, T(6)),
    ]);
    expect(r.friction.subagentFailures).toBe(1);
    expect(r.friction.errors).toBe(2);
    expect(r.frictionDetail.errorTypes).toEqual({ rate_limit: 1, query: 1 });
    expect(r.frictionDetail.subagentFailures).toEqual({ quota: 1 });
  });

  it('続けて出る abort(2 件目の parentId が 1 件目、数 ms 差)は 1 回の中断。別々の中断は別に数える', async () => {
    const a1 = ev('abort', { reason: 'user initiated' }, '2026-10-01T00:00:10.000Z');
    const r = await run([
      a1,
      ev('abort', { reason: 'user initiated' }, '2026-10-01T00:00:10.003Z', { parentId: a1.id }),
      ev('abort', { reason: 'user initiated' }, '2026-10-01T00:05:00.000Z', { parentId: 'other' }),
    ]);
    expect(r.friction.aborts).toBe(2);
    expect(r.timeline.filter((x) => x.kind === 'abort')).toHaveLength(2);
  });
});

describe('文脈の内訳(5)', () => {
  it('空の終了記録(system 0・会話 0)は記録なしとみなし、ツール定義のトークンだけ残す', async () => {
    const r = await run([ev('session.shutdown', { systemTokens: 0, conversationTokens: 0, toolDefinitionsTokens: 19000 }, T(1))]);
    expect(r.exec.context).toMatchObject({ systemTokens: null, conversationTokens: null, toolDefinitionsTokens: 19000, source: 'shutdown' });
  });
});

describe('モデル変更(9)', () => {
  it('source: agent(サブエージェントの起動)はモデル変更に数えず、推論強度の設定の変化にもしない', async () => {
    const r = await run([
      ev('session.start', { selectedModel: 'm-main', reasoningEffort: 'medium' }, T(0)),
      ev('session.model_change', { source: 'agent', newModel: 'm-sub', reasoningEffort: 'xhigh' }, T(1), { agentId: 'call-1' }),
      ev('session.model_change', { newModel: 'm-main2', previousModel: 'm-main' }, T(2)),
      ev('session.usage_record', { usage: { model: 'm-main2', inputTokens: 10, outputTokens: 1, initiator: 'user', cost: 1 } }, T(3)),
    ]);
    expect(r.friction.modelChanges).toBe(1);
    expect(r.frictionDetail.agentModelChanges).toBe(1);
    expect(Object.keys(r.exec.efforts)).toEqual(['medium']);
  });
});

describe('時系列の終了の行(12)', () => {
  it('所要時間の終わりが最後の行より後の session.shutdown なら、末尾に終了の行を足す', async () => {
    const r = await run([
      ev('user.message', { content: '依頼' }, T(0)),
      ev('session.shutdown', { shutdownType: 'routine' }, '2026-10-12T00:00:00.000Z'),
    ]);
    expect(r.timeline.map((x) => x.kind)).toEqual(['user', 'shutdown']);
    expect(r.timeline.at(-1)).toMatchObject({ at: '2026-10-12T00:00:00.000Z', label: 'routine' });
  });

  it('shutdown の後にもイベントが続く(再開した)ときは足さない', async () => {
    const r = await run([
      ev('user.message', { content: '依頼' }, T(0)),
      ev('session.shutdown', {}, T(10)),
      ev('session.resume', {}, T(11)),
      ev('user.message', { content: '続き' }, T(12)),
    ]);
    expect(r.timeline.map((x) => x.kind)).toEqual(['user', 'user']);
  });
});

describe('ターンの実働(スキル化の候補のスコア)', () => {
  it('ターンの中の 5 分を超える空白(返答待ち・放置)を除き、次の依頼までの空白はどのターンにも入れない', async () => {
    const r = await run([
      ev('user.message', { content: '一つ目' }, T(0)),
      ev('assistant.message', { content: 'a' }, T(60)),
      // 権限の返事を 10 分待った(実働に入れない)
      ev('permission.requested', {}, T(120)),
      ev('permission.completed', {}, T(720)),
      ev('assistant.message', { content: 'b' }, T(780)),
      // 次の依頼まで 3 分(どちらのターンにも入れない)
      ev('user.message', { content: '二つ目' }, T(960)),
      ev('assistant.message', { content: 'c' }, T(990)),
    ]);
    expect(r.analysis.turnMs).toEqual([780_000, 30_000]);
    expect(r.analysis.turnActiveMs).toEqual([180_000, 30_000]);
  });
});
