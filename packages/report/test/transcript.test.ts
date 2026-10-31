// セッション記録(Markdown)の単体テスト。events.jsonl は一時フォルダに架空の値で作る
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, DbUsageRow } from '../../core/src/types.ts';
import { createAnonymizer, identityAnonymizer } from '../src/lib/anonymize.ts';
import { DEFAULT_TRANSCRIPT_OPTIONS, redactSecrets, rel, renderTranscript, summarizeArgs, transcriptFileName } from '../src/transcript.ts';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

// 架空のイベント列: 依頼 → 応答 → ツール成功 → ツール失敗 → サブエージェント → 10 分の空白 → 依頼 2 → compaction → 終了
const EVENTS: CopilotEvent[] = [
  { type: 'session.start', timestamp: at(0), data: { sessionId: 'tr1', copilotVersion: '1.0.100' } },
  { type: 'user.message', timestamp: at(1), data: { content: 'C:\\work\\secret-proj の README.md を直して。鍵は ghp_' + 'a'.repeat(36) + ' です', agentMode: 'interactive' } },
  { type: 'assistant.turn_start', timestamp: at(2), data: { turnId: '0' } },
  { type: 'assistant.message', timestamp: at(3), data: { messageId: 'm1', model: 'claude-sonnet-5-5', content: '見ます。', toolRequests: [{ toolCallId: 'c1', name: 'view' }] } },
  { type: 'tool.execution_start', timestamp: at(4), data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'C:\\work\\secret-proj\\README.md' }, turnId: '0' } },
  { type: 'tool.execution_complete', timestamp: at(6), data: { toolCallId: 'c1', success: true, result: { content: 'SUCCESS_RESULT_BODY ```inner``` ok' } } },
  { type: 'tool.execution_start', timestamp: at(7), data: { toolCallId: 'c2', toolName: 'powershell', arguments: { command: 'git push origin main' }, turnId: '0' } },
  { type: 'tool.execution_complete', timestamp: at(9), data: { toolCallId: 'c2', success: false, error: { code: 'failure', message: 'exit 128' }, result: { content: 'FAILED_RESULT_BODY fatal: not a repo' } } },
  { type: 'tool.execution_start', timestamp: at(10), data: { toolCallId: 'c3', toolName: 'report_intent', arguments: { intent: 'x' }, turnId: '0' } },
  { type: 'tool.execution_complete', timestamp: at(10), data: { toolCallId: 'c3', success: true, result: { content: 'Intent logged' } } },
  { type: 'subagent.started', timestamp: at(11), data: { agentName: 'explore', toolCallId: 'c4' } },
  { type: 'assistant.message', timestamp: at(12), data: { messageId: 'm2', model: 'gpt-5.5', content: 'サブの応答', parentToolCallId: 'c4' } },
  { type: 'subagent.completed', timestamp: at(13), data: { agentName: 'explore', toolCallId: 'c4', durationMs: 2000, totalTokens: 900 } },
  { type: 'assistant.message', timestamp: at(14), data: { messageId: 'm3', model: 'claude-sonnet-5-5', content: '直しました。' } },
  { type: 'assistant.turn_end', timestamp: at(15), data: { turnId: '0' } },
  { type: 'user.message', timestamp: at(615), data: { content: '次の依頼', agentMode: 'plan' } },
  { type: 'session.compaction_start', timestamp: at(616), data: { conversationTokens: 100000, systemTokens: 5000, toolDefinitionsTokens: 12000 } },
  { type: 'session.compaction_complete', timestamp: at(620), data: { success: true, preCompactionTokens: 117000, compactionTokensUsed: 3000, summaryContent: 'COMPACTION_SUMMARY' } },
  { type: 'session.shutdown', timestamp: at(630), data: { codeChanges: { linesAdded: 3, linesRemoved: 1, filesModified: ['C:\\work\\secret-proj\\README.md'] } } },
];

const USAGE: DbUsageRow[] = [
  { session_id: 'tr1', turn_index: 0, agent_id: null, parent_tool_call_id: null, model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 50, cache_read_tokens: 800, cache_write_tokens: 0, reasoning_tokens: 0, total_nano_aiu: 2_000_000_000, request_multiplier: 1, initiator: 'user', time_to_first_token_ms: 1200, duration_ms: 3000, created_at: at(3) },
  { session_id: 'tr1', turn_index: 0, agent_id: 'ag1', parent_tool_call_id: 'c4', model: 'gpt-5.5', input_tokens: 400, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, total_nano_aiu: 500_000_000, request_multiplier: 0, initiator: 'sub-agent', time_to_first_token_ms: 700, duration_ms: 900, created_at: at(12) },
  { session_id: 'tr1', turn_index: 0, agent_id: null, parent_tool_call_id: null, model: 'claude-sonnet-5-5', input_tokens: 1500, output_tokens: 60, cache_read_tokens: 1400, cache_write_tokens: 0, reasoning_tokens: 0, total_nano_aiu: 3_000_000_000, request_multiplier: 1, initiator: 'agent', time_to_first_token_ms: 900, duration_ms: 2500, created_at: at(14) },
  { session_id: 'tr1', turn_index: 1, agent_id: null, parent_tool_call_id: null, model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, total_nano_aiu: 1_000_000_000, request_multiplier: 1, initiator: 'user', time_to_first_token_ms: 1000, duration_ms: 1500, created_at: at(617) },
];

async function setup(): Promise<{ record: Awaited<ReturnType<typeof normalizeSession>>; eventsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-transcript-'));
  const eventsPath = join(dir, 'events.jsonl');
  await writeFile(eventsPath, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const record = await normalizeSession({
    id: 'tr1',
    workspace: { cwd: 'C:\\work\\secret-proj', repository: 'acme/secret-proj', branch: 'feature/x1', created_at: at(0), client_name: 'github/cli', name: 'secret-proj の修正' },
    events: EVENTS,
    db: { usage: USAGE },
  });
  return { record, eventsPath };
}

const opts = (over: Partial<typeof DEFAULT_TRANSCRIPT_OPTIONS> = {}) => ({ ...DEFAULT_TRANSCRIPT_OPTIONS, ...over, anon: identityAnonymizer(), generatedAt: at(1000) });

describe('transcript', () => {
  it('redactSecrets はキーらしい文字列を伏せて数える(偽陽性は許容)', () => {
    const r = redactSecrets(`token ghp_${'a'.repeat(36)} and sk-${'b'.repeat(24)} and AKIA${'C'.repeat(16)} and plain text`);
    expect(r.hits).toBe(3);
    expect(r.text).not.toMatch(/ghp_a|sk-b|AKIAC/);
    expect(r.text).toContain('[伏せました: GitHub トークン]');
    expect(redactSecrets('nothing here').hits).toBe(0);
  });

  it('rel / summarizeArgs / transcriptFileName', () => {
    expect(rel(T0, T0 + 3661_000)).toBe('+1:01:01');
    expect(rel(null, T0)).toBe('+?:??:??');
    expect(summarizeArgs('powershell', { command: 'git  status', mode: 'sync' })).toBe('git status');
    expect(summarizeArgs('view', { path: 'a.ts' })).toBe('a.ts');
    expect(summarizeArgs('x', { k: 'v'.repeat(200) }).length).toBeLessThanOrEqual(161);
    expect(transcriptFileName('a/b:c')).toBe('a_b_c.md');
  });

  it('経過・役 × モデル・依頼ごとの消費・待ち・秘密情報の伏せ字が入り、内部ツールと成功したツールの結果は入らない(既定 fail)', async () => {
    const { record, eventsPath } = await setup();
    const r = await renderTranscript(record, eventsPath, USAGE, opts());
    const md = r.markdown;
    expect(r.source).toBe('events');
    expect(r.events).toBe(EVENTS.length);
    expect(md).toContain('# セッション記録: secret-proj の修正');
    // 概要と役 × モデル
    expect(md).toContain('| 本体 | claude-sonnet-5.5 | 3 | 4,500 | 120 | 2,200 | 6 |');
    expect(md).toContain('| explore | gpt-5.5 | 1 | 400 | 20 | 0 | 0.5 |');
    // 経過
    expect(md).toContain('### 依頼 1(+0:00:01、モード interactive)');
    expect(md).toContain('### 依頼 2(+0:10:15、モード plan)');
    expect(md).toMatch(/_\(待ち 10分\)_/);
    expect(md).toContain('✔ `view` C:\\work\\secret-proj\\README.md(2秒)');
    expect(md).toContain('✖ `powershell` git push origin main(2秒) — 失敗: failure: exit 128');
    expect(md).toContain('FAILED_RESULT_BODY');
    expect(md).not.toContain('SUCCESS_RESULT_BODY');
    expect(md).not.toContain('report_intent');
    expect(md).toContain('[agent:explore] **応答**(gpt-5.5)');
    expect(md).toContain('サブエージェント完了 `explore`(2秒、トークン 900)');
    expect(md).toContain('compaction 完了、圧縮前 117,000 トークン、compaction 自体の消費 3,000');
    expect(md).toContain('COMPACTION_SUMMARY');
    expect(md).toContain('**セッション終了**: 変更 +3 / −1 行、ファイル 1 件');
    // 依頼ごとの消費は依頼の切れ目で 1 回ずつ(依頼 1 = 2 リクエスト、依頼 2 = 1 リクエスト)
    expect(md.match(/_依頼 1 の本体の消費: リクエスト 2、入力 2,500、出力 110/g)).toHaveLength(1);
    expect(md.match(/_依頼 2 の本体の消費: リクエスト 1、入力 2,000、出力 10/g)).toHaveLength(1);
    // 秘密情報
    expect(md).not.toContain('ghp_' + 'a'.repeat(36));
    expect(r.secretHits).toBe(1);
    expect(md).toContain('1 件伏せました');
    // 変更ファイルと分析の観点
    expect(md).toContain('### 変更(1)');
    expect(md).toContain('## 分析の観点(LLM に渡すとき)');
  });

  it('--tool-output all / none と本文の上限', async () => {
    const { record, eventsPath } = await setup();
    const all = (await renderTranscript(record, eventsPath, USAGE, opts({ toolOutput: 'all' }))).markdown;
    expect(all).toContain('SUCCESS_RESULT_BODY');
    // 本文に ``` があっても囲みが壊れない(4 つ以上のバッククォートで囲む)
    expect(all).toMatch(/````\nSUCCESS_RESULT_BODY ```inner``` ok\n````/);
    const none = (await renderTranscript(record, eventsPath, USAGE, opts({ toolOutput: 'none' }))).markdown;
    expect(none).not.toContain('FAILED_RESULT_BODY');
    expect(none).toContain('✖ `powershell`');
    const small = await renderTranscript(record, eventsPath, USAGE, opts({ maxTextChars: 200, toolOutput: 'all' }));
    // 依頼 1 の本文(約 90 字)は上限内。長い本文は無いので中略は 0
    expect(small.truncated).toBe(0);
    const tiny = await renderTranscript(record, eventsPath, USAGE, opts({ maxTextChars: 200, maxToolChars: 10, toolOutput: 'all' }));
    expect(tiny.truncated).toBeGreaterThan(0);
    expect(tiny.markdown).toMatch(/…\(中略 \d+ 字\)…/);
  });

  it('伏せ字モード: 仮名とパスの置換、ファイル一覧とパスを出さない、先頭に注意', async () => {
    const { record, eventsPath } = await setup();
    const anon = createAnonymizer([record]);
    const r = await renderTranscript(record, eventsPath, USAGE, { ...opts(), anon });
    const md = r.markdown;
    expect(md).toContain('伏せ字モード');
    for (const secret of ['secret-proj', 'acme', 'feature/x1', 'C:\\work']) expect(md).not.toContain(secret);
    expect(md).toContain('project-01');
    expect(md).toContain('branch-01');
    expect(md).toContain('<path>');
    expect(md).toContain('伏せ字モードのためパスは出しません');
    // 本文自体は(置換のうえで)残る
    expect(md).toContain('を直して');
  });

  it('スナップショットに events.jsonl が無ければ sessions.json の抜粋だけで組む', async () => {
    const { record } = await setup();
    const r = await renderTranscript(record, join(tmpdir(), 'atlas-no-such-dir', 'events.jsonl'), [], opts());
    expect(r.source).toBe('record');
    expect(r.events).toBe(0);
    expect(r.markdown).toContain('### 最初の依頼');
    expect(r.markdown).toContain('### 最後の応答');
    expect(r.markdown).toContain('リクエスト単位の明細はありません');
  });
});
