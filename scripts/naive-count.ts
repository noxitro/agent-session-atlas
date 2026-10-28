// fixture の期待値の根拠になる素朴カウント(core を使わずに JSONL を 1 行ずつ数える)。
// synthetic-fixtures.ts が生成時に .fixtures/fixture-counts.json へ書く(実データは読まない)。
import type { CopilotEvent } from '../packages/core/src/index.ts';

/** core を使わずに数える(期待値の根拠。テストはこの値を定数として持つ) */
export function naiveCount(lines: string[]) {
  const c = {
    events: 0, tools: {} as Record<string, number>, toolTotal: 0, skillTool: 0, skillInvoked: 0, subagentStarted: 0,
    hookStart: 0, compactionComplete: 0, usageRecord: 0, systemMessages: 0, abort: 0, askUser: 0,
    userTurns: 0, wikiToolCalls: 0, hookTypes: {} as Record<string, number>,
    // 最後の session.shutdown.modelMetrics の合計(DB も usage_record も無いセッションのトークンの出所)
    lastShutdown: null as null | { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; requests: number; models: string[]; premiumRequests: unknown; nanoAiu: unknown },
  };
  for (const l of lines) {
    let e: CopilotEvent;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    c.events++;
    if (e.type === 'tool.execution_start') {
      c.toolTotal++;
      c.tools[e.data.toolName] = (c.tools[e.data.toolName] ?? 0) + 1;
      if (e.data.toolName === 'skill') c.skillTool++;
      if (e.data.toolName === 'ask_user') c.askUser++;
    }
    if (e.type === 'skill.invoked' || e.type === 'skill.invoked_ref') c.skillInvoked++;
    if (e.type === 'subagent.started') c.subagentStarted++;
    if (e.type === 'hook.start') c.hookStart++;
    if (e.type === 'session.compaction_complete') c.compactionComplete++;
    if (e.type === 'session.usage_record') c.usageRecord++;
    if (e.type === 'system.message') c.systemMessages++;
    if (e.type === 'abort') c.abort++;
    if (e.type === 'session.shutdown' && e.data?.modelMetrics && Object.keys(e.data.modelMetrics).length > 0) {
      const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, models: Object.keys(e.data.modelMetrics).sort(), premiumRequests: e.data.totalPremiumRequests ?? null, nanoAiu: e.data.totalNanoAiu ?? null };
      for (const v of Object.values<any>(e.data.modelMetrics)) {
        t.input += v.usage?.inputTokens ?? 0;
        t.output += v.usage?.outputTokens ?? 0;
        t.cacheRead += v.usage?.cacheReadTokens ?? 0;
        t.cacheWrite += v.usage?.cacheWriteTokens ?? 0;
        t.reasoning += v.usage?.reasoningTokens ?? 0;
        t.requests += v.requests?.count ?? 0;
      }
      c.lastShutdown = t;
    }
    if (e.type === 'user.message' && e.data?.source == null) c.userTurns++;
    if (e.type === 'hook.start') c.hookTypes[e.data.hookType] = (c.hookTypes[e.data.hookType] ?? 0) + 1;
    if (e.type === 'tool.execution_start' && e.data.toolName !== 'skill' && JSON.stringify(e.data.arguments ?? {}).includes('global-llm-wiki')) c.wikiToolCalls++;
  }
  return c;
}
