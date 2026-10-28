// 基本の合成セッション 001〜006・099 と session-store.db の行(実データは読まない。値はすべて架空)。
// 以前は実セッションを匿名化して作っていた役割を、同じ記録形式の合成データで置き換えたもの。
//
// 00…001 old:        usage_record も DB usage も無い旧形式。トークンは session.shutdown.modelMetrics(2 モデル)だけ。
//                    compaction(要約つき)・postToolUse hook・5 分超のアイドル・source 付きの user.message・
//                    system.message の指示ファイル(imported の AGENTS.md・applyTo・複数プロジェクト共通のブロック)
// 00…002 new-events: usage_record だけ(DB に行が無い)。<UUID>/claude-sonnet-5-5 の表記揺れ、7 種類の hook、
//                    compaction、binary_asset、待ち時間とツール定義のトークン
// 00…003 new-db:     usage_record と assistant_usage_events の両方(同じリクエスト 4 件 → 重複除去)、
//                    サブエージェント(agentId で DB の行と結び付く)、DB の session_files だけにある変更ファイル
// 00…004 skill:      toolName "skill" と skill.invoked の組(agent-invoked)、llm-wiki の index / ページ / その他の読み、
//                    権限で拒否されたツール失敗、DB の usage だけ(initiator の記録なし)
// 00…005 agents:     旧形式(assistant.message の outputTokens だけ)、サブエージェント 3 回(1 回は完了前に記録が切れる)、
//                    abort、ask_user、apply_patch の行数、shutdown が無い(途中で切れたログ)
// 00…006 db-only:    session-store.db にだけあるセッション(turns も無い → 空)
// 00…099 unknown:    未知種別 future.event_kind×2 / another.unknown×1 と壊れた行 1 行
import { fakeId, lines, PROVIDER, timeOf, type Ev, type Gap, type SyntheticSession, type SyntheticStore } from './synthetic-lib.ts';

export const BASE_IDS = {
  old: fakeId(1),
  newEvents: fakeId(2),
  newDb: fakeId(3),
  skill: fakeId(4),
  agents: fakeId(5),
  dbOnly: fakeId(6),
  unknown: fakeId(99),
} as const;

/** 003 のサブエージェントの agentId(DB の agent_id と同じ値。架空) */
const SUB_AGENT_003 = '00000000-0000-4000-8000-00000000a003';

/** 4 プロジェクト(001〜004)で同じ内容 → 「ユーザー単位の指示」と推定される(cross-project) */
const SHARED_INSTRUCTION = '<custom_instruction>\n# 共通の作業ルール(合成)\n- 回答は日本語で書く\n- 変更したらテストを回す\n</custom_instruction>';

interface ToolOpts {
  success?: boolean;
  error?: Record<string, unknown>;
  /** complete を書かない(結果の記録が無い・途中で切れた) */
  noComplete?: boolean;
  /** start と complete の間に入れる hook(preToolUse は start の前、postToolUse は complete の後) */
  pre?: boolean;
  post?: boolean;
  telemetry?: { linesAdded: number; linesRemoved: number };
  parentToolCallId?: string;
  agentId?: string;
  between?: Ev[];
}

function tool(id: string, name: string, args: unknown, o: ToolOpts = {}): Ev[] {
  const sub = o.parentToolCallId ? { parentToolCallId: o.parentToolCallId } : {};
  const ag = o.agentId ? { agentId: o.agentId } : {};
  const out: Ev[] = [];
  if (o.pre) out.push(hook('preToolUse', { toolName: name }), { type: 'hook.end', data: { hookType: 'preToolUse' } });
  out.push({ type: 'tool.execution_start', data: { toolCallId: id, toolName: name, arguments: args, ...sub }, ...ag });
  out.push(...(o.between ?? []));
  if (!o.noComplete) {
    const ok = o.success ?? true;
    out.push({
      type: 'tool.execution_complete',
      data: {
        toolCallId: id,
        success: ok,
        ...(ok ? { result: { content: '(合成の結果)' } } : { error: o.error ?? { code: 'failure', message: '(合成の失敗)' } }),
        ...(o.telemetry ? { toolTelemetry: { metrics: o.telemetry } } : {}),
        ...sub,
      },
      ...ag,
    });
  }
  if (o.post) out.push(hook('postToolUse', { toolName: name }), { type: 'hook.end', data: { hookType: 'postToolUse' } });
  return out;
}

function hook(hookType: string, input: Record<string, unknown> = {}): Ev {
  return { type: 'hook.start', data: { hookType, input } };
}
function hookPair(hookType: string): Ev[] {
  return [hook(hookType), { type: 'hook.end', data: { hookType } }];
}
const user = (content: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'user.message', data: { content, ...extra } });
const reply = (messageId: string, content: string, model: string, extra: Record<string, unknown> = {}, agentId?: string): Ev => ({
  type: 'assistant.message',
  data: { messageId, content, model, ...extra },
  ...(agentId ? { agentId } : {}),
});
const turnStart = (turnId: string): Ev => ({ type: 'assistant.turn_start', data: { turnId } });
const turnEnd = (turnId: string): Ev => ({ type: 'assistant.turn_end', data: { turnId } });
const usageRecord = (u: Record<string, unknown>, agentId?: string): Ev => ({
  type: 'session.usage_record',
  data: { usage: { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...u } },
  ...(agentId ? { agentId } : {}),
});

// ---------------------------------------------------------------------------------------------
// 001 old
// ---------------------------------------------------------------------------------------------
const OLD_CWD = 'X:\\synthetic-old\\app';
const OLD_START = '2026-07-01T09:00:00.000Z';
/** 001 の shutdown.modelMetrics(テストの期待値の根拠。fixture-counts.json の lastShutdown と同じ合計になる) */
export const OLD_MODEL_METRICS = {
  'gpt-5.5-mini': {
    requests: { count: 10, cost: 1.5 },
    usage: { inputTokens: 200_000, outputTokens: 8_000, cacheReadTokens: 150_000, cacheWriteTokens: 0, reasoningTokens: 5_000 },
    totalNanoAiu: 8_000_000_000,
  },
  'gpt-5.5': {
    requests: { count: 3, cost: 3 },
    usage: { inputTokens: 50_000, outputTokens: 4_000, cacheReadTokens: 20_000, cacheWriteTokens: 0, reasoningTokens: 1_500 },
    totalNanoAiu: 12_000_000_000,
  },
};

function oldEvents(): (Ev | Gap)[] {
  const agentsMd = `<custom_instruction>\n<imported_custom_instruction source="${OLD_CWD}\\AGENTS.md">\n# 合成リポジトリの規約\n- 小さく直す\n- 直したら記録する\n</imported_custom_instruction>\n</custom_instruction>`;
  const applyTo = '<custom_instruction>\nThis instruction applies to files matching the pattern: src/**/*.ts\n型を厳密に書く(合成)。\n</custom_instruction>';
  const sys = (extra = ''): Ev => ({ type: 'system.message', data: { role: 'system', content: `${SHARED_INSTRUCTION}\n${agentsMd}${extra}` } });
  const t = (n: number, name: string, args: unknown): Ev[] => tool(`call_synth_001_${String(n).padStart(2, '0')}`, name, args, { post: true });
  const v = (n: number, file: string): Ev[] => t(n, 'view', { path: `${OLD_CWD}\\${file}` });
  return [
    { type: 'session.start', data: { sessionId: BASE_IDS.old, version: 1, copilotVersion: '1.0.50', selectedModel: 'gpt-5.5-mini', reasoningEffort: 'high', context: { cwd: OLD_CWD, gitRoot: OLD_CWD } } },
    { type: 'session.info', data: { infoType: 'synthetic', message: '(合成の情報)' } },
    sys(),
    // 1
    user('旧形式のログの読み方を調べて'),
    turnStart('t1'),
    ...t(1, 'web_fetch', { url: 'about:blank#synthetic' }),
    reply('m1', '調べました(合成)', 'gpt-5.5-mini'),
    turnEnd('t1'),
    // 2
    user('このリポジトリでの使われ方を探して'),
    turnStart('t2'),
    ...t(2, 'rg', { pattern: 'session' }),
    ...t(3, 'rg', { pattern: 'shutdown' }),
    ...v(4, 'src\\index.ts'),
    ...v(5, 'src\\reader.ts'),
    ...v(6, 'README.md'),
    reply('m2', '3 か所で使われています(合成)', 'gpt-5.5-mini'),
    turnEnd('t2'),
    // source 付き(依頼に数えない)
    user('(合成のコマンド出力)', { source: 'system' }),
    { type: 'system.message', data: { role: 'system', content: '<reminder>合成の注意書き(指示ファイルではない)</reminder>' } },
    sys(),
    // 3
    user('テストも見て'),
    turnStart('t3'),
    ...v(7, 'test\\reader.test.ts'),
    ...v(8, 'test\\index.test.ts'),
    ...t(9, 'glob', { pattern: 'test/**/*.ts' }),
    reply('m3', 'テストは 2 本です(合成)', 'gpt-5.5-mini'),
    turnEnd('t3'),
    { type: 'session.model_change', data: { previousModel: 'gpt-5.5-mini', newModel: 'gpt-5.5' } },
    // 10 分あける(アイドル時間は activeMs に入らない)
    { gapMs: 10 * 60 * 1000 },
    // 4
    user('分かったことを覚えておいて'),
    turnStart('t4'),
    ...v(10, 'docs\\notes.md'),
    ...v(11, 'docs\\design.md'),
    ...t(12, 'store_memory', { fact: '(合成の記憶)' }),
    reply('m4', '覚えました(合成)', 'gpt-5.5'),
    turnEnd('t4'),
    { type: 'system.notification', data: { message: '(合成の通知)' } },
    { type: 'session.compaction_start', data: {} },
    {
      type: 'session.compaction_complete',
      data: {
        success: true,
        preCompactionTokens: 30_000,
        tokensRemoved: 18_000,
        summaryContent: '合成の要約: 旧形式のログの読み方を調べ、テストの場所を確認した。',
        compactionTokensUsed: { inputTokens: 25_000, outputTokens: 1_200, cacheReadTokens: 0, copilotUsage: { totalNanoAiu: 1_500_000_000 } },
      },
    },
    sys(`\n${applyTo}`),
    // 5
    user('最後にもう一度確認して'),
    turnStart('t5'),
    ...v(13, 'src\\reader.ts'),
    reply('m5', '問題ありません(合成)', 'gpt-5.5'),
    turnEnd('t5'),
    user('(合成のスキル本文)', { source: 'skill' }),
    // 6
    user('ありがとう'),
    turnStart('t6'),
    reply('m6', 'どういたしまして(合成)', 'gpt-5.5'),
    turnEnd('t6'),
    {
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        totalPremiumRequests: 4.5,
        totalNanoAiu: 20_000_000_000,
        systemTokens: 9_000,
        conversationTokens: 6_000,
        toolDefinitionsTokens: 8_000,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        modelMetrics: OLD_MODEL_METRICS,
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// 002 new-events
// ---------------------------------------------------------------------------------------------
const EV_CWD = 'X:\\synthetic-events';
const EV_START = '2026-10-10T01:00:00.000Z';
const EV_USAGE = [
  // [input, output, cacheRead, cacheWrite, reasoning, ttft, duration]
  [20_000, 300, 15_000, 5_000, 50, 1_500, 2_500],
  [24_000, 250, 20_000, 4_000, 0, 900, 1_800],
  [28_000, 400, 24_000, 4_000, 40, 1_100, 2_100],
  [32_000, 200, 28_000, 4_000, 0, 2_000, 3_000],
  [18_000, 350, 12_000, 6_000, 30, 1_300, 2_200],
  [21_000, 500, 18_000, 3_000, 20, 1_800, 4_000],
] as const;

function newEventsEvents(): Ev[] {
  const sum = (k: number): number => EV_USAGE.reduce((a, r) => a + r[k], 0);
  const ur = (i: number): Ev => {
    const [input, output, cacheRead, cacheWrite, reasoning, ttft, duration] = EV_USAGE[i];
    return usageRecord({
      model: 'claude-sonnet-5-5',
      modelDisplayName: `${PROVIDER}/claude-sonnet-5-5`,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      cost: i === 0 ? 1 : 0,
      initiator: i === 0 ? 'user' : 'agent',
      timeToFirstTokenMs: ttft,
      duration,
      availableToolCount: 40,
      toolTokenCount: 20_000,
    });
  };
  const round = (i: number, tools: Ev[]): Ev[] => [turnStart(`t${i + 1}`), ur(i), reply(`m${i + 1}`, `作業 ${i + 1}(合成)`, 'claude-sonnet-5.5'), ...tools, turnEnd(`t${i + 1}`)];
  const ps = (n: number, pre: boolean): Ev[] => tool(`call_synth_002_${n}`, 'powershell', { command: `Write-Output synthetic-${n}` }, { pre, post: true });
  const view = (n: number, pre: boolean): Ev[] => tool(`call_synth_002_${n}`, 'view', { path: `${EV_CWD}\\file-${n}.txt` }, { pre, post: true });
  return [
    { type: 'session.start', data: { sessionId: BASE_IDS.newEvents, version: 1, copilotVersion: '1.0.101', selectedModel: `${PROVIDER}/claude-sonnet-5-5`, reasoningEffort: 'medium', context: { cwd: EV_CWD } } },
    { type: 'session.permissions_changed', data: {} },
    { type: 'session.info', data: { infoType: 'synthetic', message: '(合成の情報)' } },
    ...hookPair('sessionStart'),
    user('合成イベントの集計を直して'),
    ...hookPair('userPromptSubmitted'),
    ...hookPair('userPromptTransformed'),
    { type: 'system.message', data: { role: 'system', content: `${SHARED_INSTRUCTION}\n<custom_instruction>\n# Copilot instructions(合成のイベント用)\n- ログは消さない\n</custom_instruction>` } },
    ...round(0, [...ps(1, true), ...view(2, true)]),
    ...round(1, [...view(3, true), ...view(4, false)]),
    { type: 'session.binary_asset', data: { assetId: 'asset_synth_1', mimeType: 'image/png', data: '' } },
    { type: 'session.binary_asset', data: { assetId: 'asset_synth_2', mimeType: 'image/png', data: '' } },
    ...round(2, ps(5, true)),
    ...round(3, view(6, false)),
    { type: 'session.compaction_start', data: {} },
    {
      type: 'session.compaction_complete',
      data: {
        success: true,
        preCompactionTokens: 60_000,
        tokensRemoved: 30_000,
        summaryContent: '合成の要約: イベントの集計を 4 回に分けて直した。',
        compactionTokensUsed: { inputTokens: 50_000, outputTokens: 2_500, cacheReadTokens: 0 },
      },
    },
    ...round(4, ps(7, true)),
    ...round(5, []),
    ...hookPair('agentStop'),
    { type: 'session.usage_checkpoint', data: {} },
    ...hookPair('sessionEnd'),
    {
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        totalPremiumRequests: 1,
        systemTokens: 12_000,
        conversationTokens: 6_000,
        toolDefinitionsTokens: 20_000,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        modelMetrics: {
          'claude-sonnet-5-5': {
            requests: { count: EV_USAGE.length, cost: 1 },
            usage: { inputTokens: sum(0), outputTokens: sum(1), cacheReadTokens: sum(2), cacheWriteTokens: sum(3), reasoningTokens: sum(4) },
          },
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// 003 new-db
// ---------------------------------------------------------------------------------------------
const DB_CWD = 'X:\\synthetic-db\\work';
const DB_START = '2026-10-12T02:00:00.000Z';
/** 003 の 1 リクエスト(usage_record と DB の行で同じ値) */
interface Req {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  nanoAiu: number;
  initiator: string;
  effort: string;
  ttft: number;
  duration: number;
  agentId: string | null;
}
const DB_REQS: Req[] = [
  { model: 'gpt-5.5', input: 12_000, output: 80, cacheRead: 9_000, cacheWrite: 3_000, reasoning: 20, nanoAiu: 60_000_000, initiator: 'user', effort: 'medium', ttft: 1_200, duration: 2_000, agentId: null },
  { model: 'gpt-5.6-terra', input: 4_000, output: 40, cacheRead: 2_000, cacheWrite: 2_000, reasoning: 10, nanoAiu: 50_000_000, initiator: 'sub-agent', effort: 'low', ttft: 700, duration: 900, agentId: SUB_AGENT_003 },
  { model: 'gpt-5.6-terra', input: 4_500, output: 50, cacheRead: 2_200, cacheWrite: 2_100, reasoning: 15, nanoAiu: 55_000_000, initiator: 'sub-agent', effort: 'low', ttft: 650, duration: 800, agentId: SUB_AGENT_003 },
  { model: 'gpt-5.5', input: 13_000, output: 120, cacheRead: 10_000, cacheWrite: 2_500, reasoning: 30, nanoAiu: 70_000_000, initiator: 'agent', effort: 'medium', ttft: 900, duration: 1_500, agentId: null },
];

function newDbEvents(): Ev[] {
  const ur = (i: number): Ev => {
    const r = DB_REQS[i];
    return usageRecord(
      {
        model: r.model,
        inputTokens: r.input,
        outputTokens: r.output,
        cacheReadTokens: r.cacheRead,
        cacheWriteTokens: r.cacheWrite,
        reasoningTokens: r.reasoning,
        cost: r.initiator === 'user' ? 1 : 0,
        initiator: r.initiator,
        copilotUsage: { totalNanoAiu: r.nanoAiu },
        availableToolCount: 25,
        toolTokenCount: 9_000,
      },
      r.agentId ?? undefined,
    );
  };
  const task = 'call_synth_003_task';
  const sub = { parentToolCallId: task, agentId: SUB_AGENT_003 };
  const mm = (model: string): Record<string, unknown> => {
    const rs = DB_REQS.filter((r) => r.model === model);
    const s = (f: (r: Req) => number): number => rs.reduce((a, r) => a + f(r), 0);
    return {
      requests: { count: rs.length, cost: rs.filter((r) => r.initiator === 'user').length },
      usage: { inputTokens: s((r) => r.input), outputTokens: s((r) => r.output), cacheReadTokens: s((r) => r.cacheRead), cacheWriteTokens: s((r) => r.cacheWrite), reasoningTokens: s((r) => r.reasoning) },
      totalNanoAiu: s((r) => r.nanoAiu),
    };
  };
  return [
    { type: 'session.start', data: { sessionId: BASE_IDS.newDb, version: 1, copilotVersion: '1.0.100', selectedModel: 'gpt-5.6-terra', reasoningEffort: 'medium', context: { cwd: DB_CWD, gitRoot: DB_CWD, branch: 'zz-db-branch' } } },
    { type: 'session.model_change', data: { previousModel: 'gpt-5.6-terra', newModel: 'gpt-5.5' } },
    ...hookPair('sessionStart'),
    user('合成の DB と記録の重複を確かめて'),
    ...hookPair('userPromptSubmitted'),
    { type: 'system.message', data: { role: 'system', content: `${SHARED_INSTRUCTION}\n<custom_instruction>\n# 調査メモ(合成)\n- 見たものを書き残す\n</custom_instruction>` } },
    turnStart('t1'),
    ur(0),
    reply('m1', 'サブエージェントに調べさせます(合成)', 'gpt-5.5'),
    ...tool(task, 'task', { agent_type: 'explore', prompt: '合成の DB を調べる' }, {
      between: [
        { type: 'subagent.started', data: { toolCallId: task, agentName: 'explore', agentDisplayName: 'Explore', model: 'gpt-5.6-terra' }, agentId: SUB_AGENT_003 },
        { type: 'subagent.configured', data: { toolCallId: task, agentName: 'explore' }, agentId: SUB_AGENT_003 },
        { type: 'subagent.selected', data: { toolCallId: task, agentName: 'explore' }, agentId: SUB_AGENT_003 },
        user('(サブエージェントへの指示: 合成)', { source: 'system' }),
        ...hookPair('userPromptSubmitted'),
        ur(1),
        reply('s1', '調べます(合成)', 'gpt-5.6-terra', { parentToolCallId: task }, SUB_AGENT_003),
        ...tool('call_synth_003_ps', 'powershell', { command: 'Get-ChildItem' }, sub),
        ur(2),
        reply('s2', '4 行ありました(合成)', 'gpt-5.6-terra', { parentToolCallId: task }, SUB_AGENT_003),
        ...hookPair('subagentStop'),
        { type: 'subagent.completed', data: { toolCallId: task, agentName: 'explore', totalTokens: 9_000, totalToolCalls: 1, model: 'gpt-5.6-terra' }, agentId: SUB_AGENT_003 },
      ],
    }),
    ur(3),
    reply('m2', '重複は 4 件で、DB の行だけを数えます(合成)', 'gpt-5.5'),
    turnEnd('t1'),
    ...hookPair('agentStop'),
    { type: 'session.usage_checkpoint', data: {} },
    ...hookPair('sessionEnd'),
    {
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        totalPremiumRequests: 1,
        totalNanoAiu: DB_REQS.reduce((a, r) => a + r.nanoAiu, 0),
        systemTokens: 9_000,
        conversationTokens: 300,
        toolDefinitionsTokens: 9_000,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        modelMetrics: { 'gpt-5.5': mm('gpt-5.5'), 'gpt-5.6-terra': mm('gpt-5.6-terra') },
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// 004 skill
// ---------------------------------------------------------------------------------------------
const SKILL_CWD = 'X:\\synthetic-skill\\repo';
const SKILL_START = '2026-08-20T03:00:00.000Z';
const WIKI = 'X:\\synthetic-home\\global-llm-wiki';
/** 004 の DB の明細(usage_record は無い。initiator の記録が無い古い形) */
const SKILL_DB = [
  { input: 20_000, output: 300, cacheRead: 15_000, reasoning: 100, nanoAiu: 700_000_000, ttft: 2_500, duration: 2_700, at: '2026-08-20 03:00:06' },
  { input: 22_000, output: 250, cacheRead: 16_000, reasoning: 80, nanoAiu: 750_000_000, ttft: 2_400, duration: 2_600, at: '2026-08-20 03:00:12' },
  { input: 25_000, output: 450, cacheRead: 18_000, reasoning: 150, nanoAiu: 800_000_000, ttft: 2_700, duration: 4_000, at: '2026-08-20 03:00:21' },
];

function skillEvents(): Ev[] {
  const s = (f: (r: (typeof SKILL_DB)[number]) => number): number => SKILL_DB.reduce((a, r) => a + f(r), 0);
  const view = (n: number, path: string, o: ToolOpts = {}): Ev[] => tool(`call_synth_004_${n}`, 'view', { path }, o);
  const skillCall = 'call_synth_004_skill';
  return [
    { type: 'session.start', data: { sessionId: BASE_IDS.skill, version: 1, copilotVersion: '1.0.80', selectedModel: 'gpt-5.5', context: { cwd: SKILL_CWD, gitRoot: SKILL_CWD, repository: 'zz-owner/zz-skill-repo', branch: 'zz-skill-branch' } } },
    { type: 'session.model_change', data: { previousModel: 'gpt-5.5', newModel: 'gpt-5.5-mini' } },
    // CLAUDE.md の取り込み用の中身(@ で始まる行だけ)
    { type: 'system.message', data: { role: 'system', content: `${SHARED_INSTRUCTION}\n<custom_instruction>\n@AGENTS.md\n@docs/RULES.md\n</custom_instruction>` } },
    user('wiki-query 合成の知見を探して'),
    turnStart('t1'),
    reply('m1', 'wiki を引きます(合成)', 'gpt-5.5-mini'),
    ...tool(skillCall, 'skill', { skill: 'wiki-query' }, {
      between: [{ type: 'skill.invoked', data: { name: 'wiki-query', trigger: 'agent-invoked', path: 'X:\\synthetic-home\\.copilot\\skills\\wiki-query\\SKILL.md', content: '(合成の skill 本文)' } }],
    }),
    user('(skill の本文: 合成)', { source: 'skill-wiki-query' }),
    turnEnd('t1'),
    turnStart('t2'),
    reply('m2', '索引から読みます(合成)', 'gpt-5.5-mini'),
    ...view(1, `${WIKI}\\index.md`),
    ...view(2, `${WIKI}\\wiki\\topics\\synthetic-page-a.md`),
    ...view(3, `${WIKI}\\wiki\\topics\\synthetic-page-b.md`),
    ...view(4, `${WIKI}\\log.md`),
    // 権限で拒否された読み(ツールの失敗として数える。error.code は denied ではない)
    ...view(5, 'X:\\synthetic-home\\private-notes.md', {
      success: false,
      error: { message: '(合成)許可が得られなかった' },
      between: [
        { type: 'permission.requested', data: { requestId: 'perm_synth_004', permissionRequest: { kind: 'read' } } },
        { type: 'permission.completed', data: { requestId: 'perm_synth_004', toolCallId: 'call_synth_004_5', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } } },
      ],
    }),
    turnEnd('t2'),
    turnStart('t3'),
    reply('m3', '2 ページが該当しました(合成)', 'gpt-5.5-mini'),
    turnEnd('t3'),
    { type: 'session.usage_checkpoint', data: {} },
    {
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        totalPremiumRequests: 0,
        totalNanoAiu: s((r) => r.nanoAiu),
        systemTokens: 8_000,
        conversationTokens: 10_000,
        toolDefinitionsTokens: 8_500,
        codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        modelMetrics: {
          'gpt-5.5-mini': {
            requests: { count: SKILL_DB.length, cost: 0 },
            usage: { inputTokens: s((r) => r.input), outputTokens: s((r) => r.output), cacheReadTokens: s((r) => r.cacheRead), cacheWriteTokens: 0, reasoningTokens: s((r) => r.reasoning) },
            totalNanoAiu: s((r) => r.nanoAiu),
          },
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// 005 agents
// ---------------------------------------------------------------------------------------------
const AG_CWD = 'X:\\synthetic-agents';
const AG_START = '2026-07-05T04:00:00.000Z';

function agentsEvents(): (Ev | Gap)[] {
  let n = 0;
  const id = (): string => `call_synth_005_${String(++n).padStart(2, '0')}`;
  const main = (content: string, out: number): Ev => reply(`m${n}-${out}`, content, 'gpt-5.5', { outputTokens: out });
  const view = (file: string, o: ToolOpts = {}): Ev[] => tool(id(), 'view', { path: `${AG_CWD}\\${file}` }, o);
  const patch = (body: string, telemetry: { linesAdded: number; linesRemoved: number }): Ev[] =>
    tool(id(), 'apply_patch', `*** Begin Patch\n${body}\n*** End Patch`, { telemetry });
  /** サブエージェント 1 回(rubber-duck)。done: false なら完了の記録が無い */
  const duck = (done: boolean): Ev[] => {
    const call = id();
    const sub = { parentToolCallId: call };
    const inner: Ev[] = [
      { type: 'subagent.started', data: { toolCallId: call, agentName: 'rubber-duck', agentDisplayName: 'Rubber Duck', model: 'claude-sonnet-5.5' } },
      reply(`s-${call}`, '(合成のレビュー)', 'claude-sonnet-5.5', { outputTokens: 800, parentToolCallId: call }),
      ...view('src\\core.ts', sub),
    ];
    if (!done) return tool(call, 'task', { agent_type: 'rubber-duck', prompt: '合成のレビュー' }, { noComplete: true, between: inner });
    inner.push(...tool(id(), 'grep', { pattern: 'TODO' }, sub));
    inner.push({ type: 'subagent.completed', data: { toolCallId: call, agentName: 'rubber-duck' } });
    return tool(call, 'task', { agent_type: 'rubber-duck', prompt: '合成のレビュー' }, { between: inner });
  };
  return [
    { type: 'session.start', data: { sessionId: BASE_IDS.agents, version: 1, copilotVersion: '1.0.68', selectedModel: 'claude-sonnet-5.5', context: { cwd: AG_CWD } } },
    { type: 'session.model_change', data: { previousModel: 'claude-sonnet-5.5', newModel: 'gpt-5.5' } },
    { type: 'system.message', data: { role: 'system', content: '<environment>合成の環境情報(指示ファイルは無い)</environment>' } },
    { type: 'session.permissions_changed', data: {} },
    // 1
    user('@PLAN.md を読んで計画を立てて'),
    turnStart('t1'),
    ...view('PLAN.md'),
    ...view('src\\core.ts'),
    ...view('src\\util.ts'),
    main('計画を立てました(合成)', 400),
    turnEnd('t1'),
    { type: 'session.plan_changed', data: {} },
    // 2
    user('この計画で実装して'),
    turnStart('t2'),
    ...patch('*** Update File: PLAN.md\n@@\n-a\n+b', { linesAdded: 30, linesRemoved: 5 }),
    ...patch('*** Add File: src/new-module.ts\n+export const x = 1;', { linesAdded: 50, linesRemoved: 0 }),
    ...view('src\\new-module.ts'),
    ...tool(id(), 'rg', { pattern: 'new-module' }),
    ...tool(id(), 'store_memory', { fact: '(合成の記憶)' }),
    ...tool(id(), 'powershell', { command: 'npm test' }, {
      between: [
        { type: 'permission.requested', data: { requestId: 'perm_synth_005_1', permissionRequest: { kind: 'shell' } } },
        { type: 'permission.completed', data: { requestId: 'perm_synth_005_1', result: { kind: 'approved-for-location' } } },
      ],
    }),
    ...tool(id(), 'powershell', { command: 'npm run lint' }, {
      between: [
        { type: 'permission.requested', data: { requestId: 'perm_synth_005_2', permissionRequest: { kind: 'shell' } } },
        { type: 'permission.completed', data: { requestId: 'perm_synth_005_2', result: { kind: 'approved-for-location' } } },
      ],
    }),
    main('実装しました(合成)', 1_200),
    turnEnd('t2'),
    { type: 'session.plan_changed', data: {} },
    // 3(すぐに中断)
    user('Claude にレビューさせて'),
    { type: 'abort', data: { reason: 'user_initiated' } },
    // 4
    user('もう一度 Claude にレビューさせて'),
    turnStart('t4'),
    ...duck(true),
    ...tool(id(), 'ask_user', { question: 'どちらの案にしますか(合成)' }),
    main('レビューを反映します(合成)', 600),
    turnEnd('t4'),
    { gapMs: 3 * 60 * 1000 },
    // 5(途中で記録が切れる: 3 回目のサブエージェントと最後の powershell に完了が無く、shutdown も無い)
    user('直したらもう一度レビューして'),
    turnStart('t5'),
    ...patch('*** Update File: src/new-module.ts\n@@\n-export const x = 1;\n+export const x = 2;', { linesAdded: 10, linesRemoved: 4 }),
    ...tool(id(), 'powershell', { command: 'npm test' }),
    ...duck(true),
    { type: 'session.plan_changed', data: {} },
    ...duck(false),
    ...tool(id(), 'powershell', { command: 'npm run build' }, { noComplete: true }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 099 unknown(壊れた行を含むので lines() を使わずに書く)
// ---------------------------------------------------------------------------------------------
function unknownLines(): string[] {
  const sid = BASE_IDS.unknown;
  return [
    { type: 'session.start', data: { sessionId: sid, version: 1, copilotVersion: '9.9.9', context: { cwd: 'X:\\synthetic', gitRoot: 'X:\\synthetic' } }, id: 's1', timestamp: '2026-10-01T00:00:00.000Z', parentId: null },
    { type: 'user.message', data: { content: 'hello' }, id: 's2', timestamp: '2026-10-01T00:00:01.000Z', parentId: 's1' },
    { type: 'future.event_kind', data: { anything: true }, id: 's3', timestamp: '2026-10-01T00:00:02.000Z', parentId: 's2' },
    '{"type":"tool.execution_start","data":{"toolName":"view"', // 壊れた行
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'X:\\synthetic\\a.txt' } }, id: 's4', timestamp: '2026-10-01T00:00:03.000Z', parentId: 's2' },
    { type: 'future.event_kind', data: {}, id: 's5', timestamp: '2026-10-01T00:00:04.000Z', parentId: 's4' },
    { type: 'another.unknown', data: {}, id: 's6', timestamp: '2026-10-01T00:00:05.000Z', parentId: 's5' },
    { type: 'session.shutdown', data: {}, id: 's7', timestamp: '2026-10-01T00:00:06.000Z', parentId: 's6' },
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
}

/** 099 で意図して入れている未知種別(KNOWN_EVENT_TYPES に入れてはいけない) */
export const INTENTIONAL_UNKNOWN_TYPES = ['future.event_kind', 'another.unknown'] as const;

function lastTime(evs: (Ev | Gap)[], start: string): string {
  return timeOf(evs, start, evs.filter((e) => !('gapMs' in e)).length - 1);
}

export function baseSessions(): SyntheticSession[] {
  const old = oldEvents();
  const ev = newEventsEvents();
  const db = newDbEvents();
  const sk = skillEvents();
  const ag = agentsEvents();
  return [
    {
      id: BASE_IDS.old,
      role: 'old: usage_record も DB usage も無い旧形式(トークンは shutdown の modelMetrics。compaction・hooks・指示ファイルあり)',
      workspace: {
        id: BASE_IDS.old,
        cwd: OLD_CWD,
        git_root: OLD_CWD,
        repository: 'zz-owner/zz-old-app',
        host_type: 'github',
        branch: 'zz-old-branch',
        client_name: 'github/cli',
        name: '合成: 旧形式のログを調べる',
        user_named: false,
        created_at: OLD_START,
        updated_at: lastTime(old, OLD_START),
      },
      events: lines(old, OLD_START),
    },
    {
      id: BASE_IDS.newEvents,
      role: 'new-events: usage_record のみ(DB に無い)、compaction・7 種類の hook あり',
      workspace: { id: BASE_IDS.newEvents, cwd: EV_CWD, client_name: 'github/autopilot', name: '合成: イベントの集計', user_named: true, created_at: EV_START, updated_at: lastTime(ev, EV_START) },
      events: lines(ev, EV_START),
    },
    {
      id: BASE_IDS.newDb,
      role: 'new-db: usage_record と assistant_usage_events の両方(重複除去)、subagent あり',
      workspace: { id: BASE_IDS.newDb, cwd: DB_CWD, git_root: DB_CWD, branch: 'zz-db-branch', client_name: 'github/cli', name: '合成: DB と記録の重複', created_at: DB_START, updated_at: lastTime(db, DB_START) },
      events: lines(db, DB_START),
    },
    {
      id: BASE_IDS.skill,
      role: 'skill: toolName "skill" と skill.invoked の両方、wiki 参照、DB usage のみ',
      workspace: {
        id: BASE_IDS.skill,
        cwd: SKILL_CWD,
        git_root: SKILL_CWD,
        repository: 'zz-owner/zz-skill-repo',
        host_type: 'github',
        branch: 'zz-skill-branch',
        client_name: 'github/cli',
        name: '合成: wiki-query で知見を探す',
        created_at: SKILL_START,
        updated_at: lastTime(sk, SKILL_START),
      },
      events: lines(sk, SKILL_START),
    },
    {
      id: BASE_IDS.agents,
      role: 'agents: 旧形式で subagent 3 回・abort・ask_user あり(shutdown の無い、途中で切れたログ)',
      workspace: { id: BASE_IDS.agents, cwd: AG_CWD, client_name: 'github/cli', name: '合成: 計画と実装とレビュー', created_at: AG_START, updated_at: lastTime(ag, AG_START) },
      events: lines(ag, AG_START),
    },
    {
      id: BASE_IDS.unknown,
      role: 'synthetic: 未知種別 future.event_kind×2 / another.unknown×1 と壊れた行 1 行',
      workspace: { id: BASE_IDS.unknown, cwd: 'X:\\synthetic', client_name: 'github/cli', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:06.000Z' },
      events: unknownLines(),
    },
  ];
}

export const DB_ONLY_ROLE = 'db-only: session-store.db にだけあるセッション(turns も無い → 空)';

/** session-store.db の行(001・003・004・005・006。002 は DB に無い) */
export function baseStore(): SyntheticStore {
  const db = newDbEvents();
  const usageAt = db.flatMap((e, i) => (e.type === 'session.usage_record' ? [i] : [])).map((i) => timeOf(db, DB_START, i));
  // usage_record から 0.4 秒後に DB に書かれた(5 秒以内なので同じリクエストとみなされる)
  const dbAt = (i: number): string => new Date(Date.parse(usageAt[i]) + 400).toISOString();
  const usageRow = (session_id: string, r: Record<string, unknown>): Record<string, unknown> => ({
    session_id,
    turn_index: 0,
    agent_id: null,
    parent_tool_call_id: null,
    cache_write_tokens: 0,
    request_multiplier: null,
    initiator: null,
    reasoning_effort: null,
    finish_reason: 'stop',
    api_endpoint: '/chat/completions',
    content_filter_triggered: 0,
    token_details_json: null,
    ...r,
  });
  const turns = (sid: string, start: string, rows: [string, string][]): Record<string, unknown>[] =>
    rows.map(([u, a], i) => ({ session_id: sid, turn_index: i, user_message: u, assistant_response: a, timestamp: new Date(Date.parse(start) + (i + 1) * 60_000).toISOString() }));
  return {
    sessions: [
      { id: BASE_IDS.old, cwd: OLD_CWD, repository: 'zz-owner/zz-old-app', host_type: 'github', branch: 'zz-old-branch', summary: '合成: 旧形式のログを調べる', created_at: OLD_START, updated_at: lastTime(oldEvents(), OLD_START) },
      { id: BASE_IDS.newDb, cwd: DB_CWD, repository: null, host_type: null, branch: 'zz-db-branch', summary: '合成: DB と記録の重複', created_at: DB_START, updated_at: lastTime(db, DB_START) },
      { id: BASE_IDS.skill, cwd: SKILL_CWD, repository: 'zz-owner/zz-skill-repo', host_type: 'github', branch: 'zz-skill-branch', summary: '合成: wiki-query で知見を探す', created_at: SKILL_START, updated_at: lastTime(skillEvents(), SKILL_START) },
      { id: BASE_IDS.agents, cwd: AG_CWD, repository: null, host_type: null, branch: null, summary: '合成: 計画と実装とレビュー', created_at: AG_START, updated_at: lastTime(agentsEvents(), AG_START) },
      { id: BASE_IDS.dbOnly, cwd: 'X:\\synthetic-dbonly-old', repository: null, host_type: null, branch: null, summary: null, created_at: '2026-09-20T03:00:00.000Z', updated_at: '2026-09-20T03:00:00.000Z' },
    ],
    turns: [
      ...turns(BASE_IDS.old, OLD_START, [
        ['旧形式のログの読み方を調べて', '調べました(合成)'],
        ['このリポジトリでの使われ方を探して', '3 か所で使われています(合成)'],
        ['テストも見て', 'テストは 2 本です(合成)'],
        ['分かったことを覚えておいて', '覚えました(合成)'],
        ['最後にもう一度確認して', '問題ありません(合成)'],
        ['ありがとう', 'どういたしまして(合成)'],
      ]),
      ...turns(BASE_IDS.newDb, DB_START, [['合成の DB と記録の重複を確かめて', '重複は 4 件で、DB の行だけを数えます(合成)']]),
      ...turns(BASE_IDS.skill, SKILL_START, [['wiki-query 合成の知見を探して', '2 ページが該当しました(合成)']]),
      ...turns(BASE_IDS.agents, AG_START, [
        ['@PLAN.md を読んで計画を立てて', '計画を立てました(合成)'],
        ['この計画で実装して', '実装しました(合成)'],
        ['Claude にレビューさせて', ''],
        ['もう一度 Claude にレビューさせて', 'レビューを反映します(合成)'],
        ['直したらもう一度レビューして', ''],
      ]),
    ],
    assistant_usage_events: [
      ...DB_REQS.map((r, i) =>
        usageRow(BASE_IDS.newDb, {
          agent_id: r.agentId,
          model: r.model,
          input_tokens: r.input,
          output_tokens: r.output,
          cache_read_tokens: r.cacheRead,
          cache_write_tokens: r.cacheWrite,
          reasoning_tokens: r.reasoning,
          total_nano_aiu: r.nanoAiu,
          request_multiplier: 1,
          initiator: r.initiator,
          // 推論強度と待ち時間は DB の行に入っている(usage_record 側には無い)
          reasoning_effort: r.effort,
          duration_ms: r.duration,
          time_to_first_token_ms: r.ttft,
          created_at: dbAt(i),
          copilot_usage_model: r.model,
        }),
      ),
      ...SKILL_DB.map((r) =>
        usageRow(BASE_IDS.skill, {
          model: 'gpt-5.5-mini',
          input_tokens: r.input,
          output_tokens: r.output,
          cache_read_tokens: r.cacheRead,
          reasoning_tokens: r.reasoning,
          total_nano_aiu: r.nanoAiu,
          duration_ms: r.duration,
          time_to_first_token_ms: r.ttft,
          created_at: r.at,
        }),
      ),
    ],
    session_files: [{ session_id: BASE_IDS.newDb, file_path: `${DB_CWD}\\notes.md`, tool_name: 'edit', turn_index: 0, first_seen_at: dbAt(3) }],
  };
}

/** 手書きの judgments サンプル(001〜005 の架空の判定。phase3 の import → build の確認用) */
export function judgmentsSample(): Record<string, unknown> {
  const item = (n: number, taskCategory: string, effort: [number, number, number, number], outcome: [boolean, number, number], scores: [number, number, number], wikiEvidence = '参照なし') => ({
    sessionId: fakeId(n),
    taskCategory,
    taskSummary: `手書きサンプル ${n}(fixture 用の架空の判定)`,
    humanEffort: { hours: effort[0], low: effort[1], high: effort[2], confidence: effort[3], rationale: 'fixture 用の手書き値' },
    aiOutcome: { completed: outcome[0], quality: outcome[1], rework: outcome[2], rationale: 'fixture 用' },
    instructionsEffect: { score: scores[0], evidence: 'fixture 用' },
    wikiEffect: { score: scores[1], evidence: wikiEvidence },
    skillsAgentsEffect: { score: scores[2], evidence: 'fixture 用' },
    notes: 'E2E 用のサンプル',
  });
  return {
    schemaVersion: 1,
    judge: { backend: 'external', model: 'hand-written-sample', ranAt: '2026-10-28T00:00:00Z' },
    items: [
      item(1, 'bugfix', [3, 2, 5, 0.6], [true, 4, 1], [1, 0, 0]),
      item(2, 'feature', [6, 4, 10, 0.4], [true, 3, 2], [0, 0, 0]),
      item(3, 'investigation', [1.5, 1, 3, 0.7], [true, 5, 0], [1, 0, 1]),
      item(4, 'docs', [0.5, 0.25, 1, 0.8], [true, 4, 0], [0, 2, 1], 'index.md を読んでから該当ページを参照'),
      item(5, 'refactor', [8, 5, 12, 0.3], [false, 2, 3], [-1, 0, -1]),
    ],
  };
}

