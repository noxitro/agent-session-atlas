// テスト用 fixture の生成器(実データは読まない。値はすべて架空)。
//   node scripts/synthetic-fixtures.ts     .fixtures/ を作り直す(何度実行しても同じ結果)
// E2E(vitest の e2e プロジェクト)は e2e/global-setup.ts から毎回これを呼ぶので、手で実行する必要は無い。
// 生成物(.fixtures/)は git に入れない。サンプルデータはリポジトリに置かず、テストのたびにここから作る。
//
// 00…001〜006・099: scripts/synthetic-base.ts(旧形式・usage_record・DB の重複除去・skill と wiki・サブエージェント・
//                   DB だけのセッション・未知種別と壊れた行)
// --- Phase 5 ---
// 00…007 empty:    依頼・ツール・応答が無い(session.start / shutdown だけ)ディレクトリのセッション
// 00…008 new:      <UUID>/claude-haiku-5-5 形式のモデル名、report_intent、相対・絶対・大文字小文字違いの重複パス、
//                  fileEdits[](edit / create / delete)、apply_patch の Delete File、session-state 配下の plan.md、
//                  isAutopilotContinuation、agentId だけを持つサブエージェントの応答、session.error とツール失敗
// 00…009 missing:  依頼・ツール・応答はあるが、トークンの記録(DB / usage_record / shutdown / outputTokens)が何も無い
// 00…010 db-empty: session-store.db にだけあり、turns も無いセッション(client は記録上決められない)
// --- Phase 6 ---
// 00…011 usage:    MCP ツール(mcpServerName)、ツールの成功・失敗(failure)・拒否(denied)・結果なし、
//                  toolTelemetry の行数と shutdown.codeChanges の行数(shutdown を優先)、skill.invoked の trigger
//                  (agent / user / 無し)、agent の失敗とトークン、hook の種類、
//                  途中で削除したファイルが shutdown.codeChanges.filesModified に残る形(「削除」のまま)
// 00…012 temp:     一時フォルダ(…\AppData\Local\Temp\claude\…\scratchpad)の試行。shutdown が無く行数はツール側の合計
// 00…013 judge:    このツール自身の判定実行(cwd が %TEMP%\atlas-judge-cwd-XXXXXX)
// Phase 7 の 014・015 と session.db(todo)は e2e/phase7.test.ts が実行時に足す。
//
// 書き出すもの(<dir> は既定で .fixtures/):
//   <dir>/copilot-home/session-state/<id>/{workspace.yaml,events.jsonl}
//   <dir>/copilot-home/session-store.json   session-store.db の中身(e2e/fixture-home.ts が WAL の DB に組み立てる)
//   <dir>/manifest.json                     各セッションの役割
//   <dir>/fixture-counts.json               core を使わない素朴カウント(テストの期待値の根拠)
//   <dir>/judgments-sample.json             手書きの judgments サンプル(架空の判定)
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { naiveCount } from './naive-count.ts';
import { baseSessions, baseStore, BASE_IDS, DB_ONLY_ROLE, judgmentsSample } from './synthetic-base.ts';
import { fakeId, lines, PROVIDER, type Ev, type SyntheticSession, type SyntheticStore } from './synthetic-lib.ts';

const THIS_FILE = fileURLToPath(import.meta.url);
/** 生成先の既定(git に入れない。.gitignore 済み) */
export const FIXTURES_DIR = join(dirname(THIS_FILE), '..', '.fixtures');

export const SYNTHETIC_IDS = {
  empty: fakeId(7),
  newFormat: fakeId(8),
  missing: fakeId(9),
  dbEmpty: fakeId(10),
  usage: fakeId(11),
  temp: fakeId(12),
  judge: fakeId(13),
} as const;

function phaseSessions(): SyntheticSession[] {
  const { empty, newFormat, missing, usage, temp, judge } = SYNTHETIC_IDS;
  const cwdUsage = 'X:\\synthetic-p6';
  const cwdTemp = 'X:\\home\\someone\\AppData\\Local\\Temp\\claude\\X--synthetic\\0000\\scratchpad\\probe';
  const cwdJudge = 'X:\\home\\someone\\AppData\\Local\\Temp\\atlas-judge-cwd-AbC123';
  const ur = (model: string, input: number, output: number, cost: number, initiator: string, nanoAiu: number): Ev => ({
    type: 'session.usage_record',
    data: { usage: { model, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost, initiator, copilotUsage: { totalNanoAiu: nanoAiu } } },
  });
  const cwdNew = 'X:\\synthetic-new';
  const planMd = `X:\\home\\someone\\.copilot\\session-state\\${newFormat}\\plan.md`;
  return [
    {
      id: empty,
      role: 'synthetic-empty: 依頼・ツール・応答が無い(開いただけ)',
      workspace: { id: empty, cwd: 'X:\\synthetic-empty', client_name: 'github/autopilot', created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:01.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: empty, version: 1, copilotVersion: '1.0.103', context: { cwd: 'X:\\synthetic-empty' } } },
          { type: 'session.shutdown', data: { shutdownType: 'routine' } },
        ],
        '2026-10-02T00:00:00.000Z',
      ),
    },
    {
      id: newFormat,
      role: 'synthetic-new: 2026-10 以降の形式(fileEdits / isAutopilotContinuation / agentId だけの応答 / -5-5 のモデル名 / report_intent / 重複パス)',
      workspace: { id: newFormat, cwd: cwdNew, git_root: cwdNew, client_name: 'github/cli', created_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-15T00:00:30.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: newFormat, version: 1, copilotVersion: '1.0.103', selectedModel: `${PROVIDER}/claude-haiku-5-5`, context: { cwd: cwdNew, gitRoot: cwdNew } } },
          { type: 'user.message', data: { content: 'fix the app', agentMode: 'autopilot' } },
          { type: 'tool.execution_start', data: { toolCallId: 'r1', toolName: 'report_intent', arguments: { intent: 'Fixing' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'r1', success: true } },
          // 相対パスの編集 → fileEdits は同じファイルを絶対パスで
          { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'edit', arguments: { path: 'src\\app.ts' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, fileEdits: [{ path: `${cwdNew}\\src\\app.ts`, kind: 'edit' }] } },
          // 作成 → fileEdits は大文字小文字違いの同じパス
          { type: 'tool.execution_start', data: { toolCallId: 't2', toolName: 'create', arguments: { path: `${cwdNew}\\docs\\new.md` } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't2', success: true, fileEdits: [{ path: 'x:\\SYNTHETIC-NEW\\docs\\new.md', kind: 'create' }] } },
          // シェルでの削除は fileEdits にだけ出る
          { type: 'tool.execution_start', data: { toolCallId: 't3', toolName: 'powershell', arguments: { command: 'Remove-Item old.txt' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't3', success: true, fileEdits: [{ path: `${cwdNew}\\old.txt`, kind: 'delete' }] } },
          // Copilot 自身のセッション用ファイル(一覧から外して件数だけ数える)
          { type: 'tool.execution_start', data: { toolCallId: 't4', toolName: 'create', arguments: { path: planMd } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't4', success: true, fileEdits: [{ path: planMd, kind: 'create' }] } },
          { type: 'assistant.message', data: { messageId: 'm1', content: 'working on it', model: 'claude-haiku-5.5' } },
          // サブエージェントの応答: parentToolCallId が無く、トップレベルの agentId だけ
          { type: 'assistant.message', data: { messageId: 'm2', content: 'sub-agent reply 1', model: 'claude-haiku-5-5' }, agentId: 'call_sub1' },
          { type: 'assistant.message', data: { messageId: 'm3', content: 'sub-agent reply 2', model: 'claude-haiku-5-5' }, agentId: 'call_sub1' },
          // autopilot の自動継続(source 無しと source: autopilot)
          { type: 'user.message', data: { content: '', isAutopilotContinuation: true, agentMode: 'autopilot' } },
          { type: 'user.message', data: { content: '', isAutopilotContinuation: true, source: 'autopilot', agentMode: 'autopilot' } },
          // 内部ツールの失敗はツール失敗に数えない
          { type: 'tool.execution_start', data: { toolCallId: 'r2', toolName: 'report_intent', arguments: { intent: 'Patching' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'r2', success: false } },
          // apply_patch(/ 区切りの相対パス)。app.ts は重複、tmp/a.txt は削除。このツールは失敗
          {
            type: 'tool.execution_start',
            data: { toolCallId: 't5', toolName: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Delete File: tmp/a.txt\n*** End Patch' },
          },
          { type: 'tool.execution_complete', data: { toolCallId: 't5', success: false } },
          { type: 'session.error', data: { errorType: 'rate_limit', message: 'rate limited' } },
          {
            type: 'session.usage_record',
            data: { usage: { model: 'claude-haiku-5-5', modelDisplayName: `${PROVIDER}/claude-haiku-5-5`, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 1, initiator: 'user' } },
          },
          {
            type: 'session.usage_record',
            data: { usage: { model: 'claude-haiku-5.5', inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, initiator: 'agent' } },
          },
          { type: 'assistant.message', data: { messageId: 'm4', content: 'done', model: 'claude-haiku-5.5' } },
          { type: 'session.shutdown', data: { shutdownType: 'routine', codeChanges: { filesModified: [`${cwdNew}\\src\\app.ts`, `${cwdNew}\\README.md`] } } },
        ],
        '2026-10-15T00:00:00.000Z',
      ),
    },
    {
      id: missing,
      role: 'synthetic-missing: 依頼・ツール・応答はあるがトークン記録が何も無い(2026-09 以降の欠測)',
      workspace: { id: missing, cwd: 'X:\\synthetic-missing', client_name: 'github/autopilot', created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:05.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: missing, version: 1, copilotVersion: '1.0.103', context: { cwd: 'X:\\synthetic-missing' } } },
          { type: 'user.message', data: { content: 'question' } },
          { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'view', arguments: { path: 'X:\\synthetic-missing\\a.txt' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true } },
          { type: 'assistant.message', data: { messageId: 'm1', content: 'answer', model: 'gpt-5.6-terra' } },
        ],
        '2026-10-20T00:00:00.000Z',
      ),
    },
    {
      id: usage,
      role: 'synthetic-usage: Phase 6 の利用の内訳(MCP・ツールの成否・行数・skill の trigger・agent の失敗とトークン・hook の種類・削除後の filesModified)',
      workspace: { id: usage, cwd: cwdUsage, client_name: 'github/cli', created_at: '2026-10-22T00:00:00.000Z', updated_at: '2026-10-22T00:01:00.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: usage, version: 1, copilotVersion: '1.0.103', selectedModel: 'gpt-5.5', context: { cwd: cwdUsage } } },
          { type: 'user.message', data: { content: 'improve the synthetic project' } },
          { type: 'hook.start', data: { hookType: 'preToolUse', input: { toolName: 'github-mcp-server-search_code' } } },
          // MCP ツール: toolName は <サーバー>-<ツール>、mcpServerName でサーバーが分かる
          { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'github-mcp-server-search_code', mcpServerName: 'github-mcp-server', mcpToolName: 'search_code', arguments: { query: 'x' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true } },
          { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'github-mcp-server-get_file_contents', mcpServerName: 'github-mcp-server', mcpToolName: 'get_file_contents', arguments: {} } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c2', success: false, error: { code: 'failure', message: 'not found' } } },
          { type: 'tool.execution_start', data: { toolCallId: 'c3', toolName: 'ide-get_diagnostics', mcpServerName: 'ide', mcpToolName: 'get_diagnostics', arguments: {} } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c3', success: true } },
          // view: 成功 1・拒否 1・結果なし 1(complete が無い)
          { type: 'tool.execution_start', data: { toolCallId: 'c4', toolName: 'view', arguments: { path: `${cwdUsage}\\a.ts` } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c4', success: true } },
          { type: 'tool.execution_start', data: { toolCallId: 'c5', toolName: 'view', arguments: { path: `${cwdUsage}\\secret.env` } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c5', success: false, error: { code: 'denied', message: 'denied by user' } } },
          { type: 'tool.execution_start', data: { toolCallId: 'c6', toolName: 'view', arguments: { path: `${cwdUsage}\\b.ts` } } },
          // 行数はツール側にもあるが、shutdown.codeChanges を優先する(ここの 15 / 2 は使わない)
          { type: 'tool.execution_start', data: { toolCallId: 'c7', toolName: 'edit', arguments: { path: 'src\\main.ts' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c7', success: true, toolTelemetry: { metrics: { linesAdded: 5, linesRemoved: 2 } } } },
          { type: 'tool.execution_start', data: { toolCallId: 'c8', toolName: 'create', arguments: { path: `${cwdUsage}\\src\\new.ts` } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c8', success: true, toolTelemetry: { metrics: { linesAdded: 10, linesRemoved: 0 } } } },
          // シェルで削除 → shutdown の filesModified にも残るが「削除」のまま
          { type: 'tool.execution_start', data: { toolCallId: 'c9', toolName: 'powershell', arguments: { command: 'Remove-Item gone.txt' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c9', success: true, fileEdits: [{ path: `${cwdUsage}\\gone.txt`, kind: 'delete' }] } },
          { type: 'hook.start', data: { hookType: 'postToolUse', input: { toolName: 'powershell' } } },
          // skill: ツール + イベント(agent-invoked)/ イベントだけ(user-invoked)/ trigger の無い古い形
          { type: 'tool.execution_start', data: { toolCallId: 'c10', toolName: 'skill', arguments: { skill: 'wiki-query' } } },
          { type: 'skill.invoked', data: { name: 'wiki-query', trigger: 'agent-invoked', source: 'user' } },
          { type: 'tool.execution_complete', data: { toolCallId: 'c10', success: true } },
          { type: 'skill.invoked', data: { name: 'impeccable', trigger: 'user-invoked', source: 'user' } },
          { type: 'skill.invoked', data: { name: 'legacy-skill' } },
          // agent: explore は 2 回(1 回失敗)、task は 1 回
          { type: 'subagent.started', data: { toolCallId: 'a1', agentName: 'explore' } },
          { type: 'subagent.completed', data: { toolCallId: 'a1', agentName: 'explore', totalTokens: 1200, totalToolCalls: 3 } },
          { type: 'subagent.started', data: { toolCallId: 'a2', agentName: 'explore' } },
          { type: 'subagent.failed', data: { toolCallId: 'a2', agentName: 'explore', error: 'boom' } },
          { type: 'subagent.started', data: { toolCallId: 'a3', agentName: 'task' } },
          { type: 'subagent.completed', data: { toolCallId: 'a3', agentName: 'task', totalTokens: 300, totalToolCalls: 1 } },
          { type: 'hook.start', data: { hookType: 'preToolUse', input: { toolName: 'view' } } },
          { type: 'assistant.message', data: { messageId: 'm1', content: 'done p6', model: 'gpt-5.5' } },
          ur('gpt-5.5', 2000, 100, 1, 'user', 2_500_000_000),
          ur('gpt-5.5', 1000, 50, 0, 'agent', 500_000_000),
          {
            type: 'session.shutdown',
            data: { shutdownType: 'routine', codeChanges: { linesAdded: 40, linesRemoved: 7, filesModified: [`${cwdUsage}\\gone.txt`, `${cwdUsage}\\src\\main.ts`] } },
          },
        ],
        '2026-10-22T00:00:00.000Z',
      ),
    },
    {
      id: temp,
      role: 'synthetic-temp: 一時フォルダ(scratchpad)での試行。shutdown が無く、行数はツールの toolTelemetry の合計',
      workspace: { id: temp, cwd: cwdTemp, git_root: cwdTemp, client_name: 'github/cli', created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:10.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: temp, version: 1, copilotVersion: '1.0.103', context: { cwd: cwdTemp, gitRoot: cwdTemp } } },
          { type: 'user.message', data: { content: 'probe' } },
          { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'edit', arguments: { path: 'a.txt' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't1', success: true, toolTelemetry: { metrics: { linesAdded: 3, linesRemoved: 1 } } } },
          { type: 'tool.execution_start', data: { toolCallId: 't2', toolName: 'edit', arguments: { path: 'b.txt' } } },
          { type: 'tool.execution_complete', data: { toolCallId: 't2', success: true, toolTelemetry: { metrics: { linesAdded: 4, linesRemoved: 0 } } } },
          { type: 'assistant.message', data: { messageId: 'm1', content: 'probed', model: 'gpt-5.5' } },
          ur('gpt-5.5', 300, 30, 1, 'user', 100_000_000),
        ],
        '2026-10-23T00:00:00.000Z',
      ),
    },
    {
      id: judge,
      role: 'synthetic-judge: このツール自身の判定実行(cwd が %TEMP% の atlas-judge-cwd-XXXXXX)',
      workspace: { id: judge, cwd: cwdJudge, client_name: 'github/cli', created_at: '2026-10-24T00:00:00.000Z', updated_at: '2026-10-24T00:00:05.000Z' },
      events: lines(
        [
          { type: 'session.start', data: { sessionId: judge, version: 1, copilotVersion: '1.0.103', context: { cwd: cwdJudge } } },
          { type: 'user.message', data: { content: 'あなたはソフトウェア開発の工数見積もりの専門家です。(合成)' } },
          { type: 'assistant.message', data: { messageId: 'm1', content: '{"items":[]}', model: 'gpt-5.5' } },
          ur('gpt-5.5', 5000, 200, 1, 'user', 1_000_000_000),
        ],
        '2026-10-24T00:00:00.000Z',
      ),
    },
  ];
}

/** session-store.db の行(DB にだけある空のセッション) */
function phaseStoreRows(): Record<string, unknown>[] {
  return [
    { id: SYNTHETIC_IDS.dbEmpty, cwd: 'X:\\synthetic-dbonly', repository: null, host_type: 'github', branch: null, summary: null, created_at: '2026-09-15 00:00:00', updated_at: '2026-09-15 00:00:00' },
  ];
}

export interface Fixtures {
  sessions: SyntheticSession[];
  store: SyntheticStore;
  manifest: { sessions: { id: string; role: string; events: number }[] };
  counts: Record<string, ReturnType<typeof naiveCount>>;
  judgmentsSample: Record<string, unknown>;
}

/** すべての合成データをメモリ上に作る(ファイルには書かない。単体テストからも使う) */
export function buildFixtures(): Fixtures {
  const sessions = [...baseSessions(), ...phaseSessions()];
  const store = baseStore();
  store.sessions.push(...phaseStoreRows());
  const counts: Fixtures['counts'] = {};
  const manifest: Fixtures['manifest'] = { sessions: [] };
  for (const s of sessions) {
    counts[s.id] = naiveCount(s.events);
    manifest.sessions.push({ id: s.id, role: s.role, events: s.events.length });
  }
  manifest.sessions.push({ id: BASE_IDS.dbOnly, role: DB_ONLY_ROLE, events: 0 });
  manifest.sessions.push({ id: SYNTHETIC_IDS.dbEmpty, role: 'synthetic-db-empty: session-store.db にだけあり turns も無い(client は決められない)', events: 0 });
  return { sessions, store, manifest, counts, judgmentsSample: judgmentsSample() };
}

/** dir を消して作り直す */
export async function writeFixtures(dir: string = FIXTURES_DIR): Promise<Fixtures> {
  const f = buildFixtures();
  const home = join(dir, 'copilot-home');
  await rm(dir, { recursive: true, force: true });
  for (const s of f.sessions) {
    const d = join(home, 'session-state', s.id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'workspace.yaml'), toYaml(s.workspace));
    await writeFile(join(d, 'events.jsonl'), s.events.join('\n') + '\n');
  }
  await writeFile(join(home, 'session-store.json'), JSON.stringify(f.store, null, 1) + '\n');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(f.manifest, null, 2) + '\n');
  await writeFile(join(dir, 'fixture-counts.json'), JSON.stringify(f.counts, null, 2) + '\n');
  await writeFile(join(dir, 'judgments-sample.json'), JSON.stringify(f.judgmentsSample, null, 2) + '\n');
  return f;
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  const f = await writeFixtures();
  console.log(`合成 fixture を書きました: ${FIXTURES_DIR}(セッション ${f.sessions.length} 件 + DB だけ 2 件)`);
}
