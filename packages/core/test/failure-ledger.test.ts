// 失敗の台帳(analysis.failures)・秘密を伏せる処理・失敗と拒否ごとの表。イベントはすべて架空のもの
import { describe, expect, it } from 'vitest';
import { ARGS_LIMIT, cap, ERROR_LIMIT, errorMessage, GROUP_LIMIT, groupOf, MAX_ROWS, PROMPT_LIMIT, redactCap } from '../src/failure-ledger.ts';
import { normalizeSession } from '../src/normalize.ts';
import { redactSecrets } from '../src/secrets.ts';
import { failuresCsv, failuresTable, turnsTable, type Cell } from '../src/tables.ts';
import type { CopilotEvent, SessionRecord, ToolFailure } from '../src/types.ts';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const evx = (type: string, data: unknown, s: number, agentId?: string): CopilotEvent => ({ type, data, timestamp: at(s), ...(agentId ? { agentId } : {}) });
const ev = (type: string, data: unknown, s: number): CopilotEvent => evx(type, data, s);
const start = (id: string, tool: string, args: unknown, s: number): CopilotEvent => ev('tool.execution_start', { toolCallId: id, toolName: tool, arguments: args }, s);
const ok = (id: string, s: number): CopilotEvent => ev('tool.execution_complete', { toolCallId: id, success: true }, s);
const fail = (id: string, msg: string, s: number): CopilotEvent => ev('tool.execution_complete', { toolCallId: id, success: false, error: { code: 'failure', message: msg } }, s);
const user = (content: string, s: number): CopilotEvent => ev('user.message', { content }, s);
const run = (events: CopilotEvent[], id = 's'): Promise<SessionRecord> => normalizeSession({ id, events });
const failures = (r: SessionRecord): ToolFailure[] => r.analysis.failures!;

/** 台帳の行数 + 切った件数 = tools.results の failure + denied */
function expectInvariant(r: SessionRecord): void {
  const counted = Object.values(r.tools.results).reduce((a, x) => a + x.failure + x.denied, 0);
  expect(failures(r).length + r.analysis.failuresDropped!).toBe(counted);
}

describe('失敗の台帳の補助', () => {
  it('上限は UTF-16 の単位で数え、末尾の … を含む', () => {
    expect(cap('abc', 3)).toBe('abc');
    expect(cap('abcd', 3)).toBe('ab…');
    expect(cap('あ'.repeat(2000), ERROR_LIMIT).length).toBe(ERROR_LIMIT);
  });

  it('伏せてから切る(上限が鍵の途中に掛かっても、鍵の一部が残らない)', () => {
    const key = `ghp_${'a'.repeat(36)}`;
    const out = redactCap(`${'x'.repeat(ARGS_LIMIT - 10)} ${key}`, ARGS_LIMIT);
    expect(out).not.toContain('ghp_');
  });

  it('error の文の形', () => {
    expect(errorMessage({ code: 'failure', message: 'boom' })).toBe('failure: boom');
    expect(errorMessage({ message: 'boom' })).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ code: 'denied' })).toBe('denied: {"code":"denied"}');
    expect(errorMessage(undefined)).toBe('');
    expect(errorMessage(null)).toBe('');
  });

  it('似たエラー文を同じ鍵にまとめる', () => {
    const a = groupOf("failure: Path 'C:\\w\\a.ts' does not exist (line 12)\nmore");
    const b = groupOf("failure: Path 'D:\\other\\b.rs' does not exist (line 7)");
    expect(a).toBe(b);
    expect(a).toBe('failure path <q> does not exist line <n>');
    // 語の中のアポストロフィは引用にしない
    expect(groupOf("file doesn't exist")).toBe('file doesn t exist');
    expect(groupOf('\n\n')).toBe('');
  });
});

describe('秘密を伏せる処理', () => {
  it('形の決まった鍵', () => {
    const r = redactSecrets(`key ghp_${'a'.repeat(36)} and sk-${'b'.repeat(24)} x`);
    expect(r.text).toBe('key [伏せました: GitHub トークン] and [伏せました: OpenAI / Anthropic 系キー] x');
    expect(r.hits).toBe(2);
    expect(redactSecrets('nothing here')).toEqual({ text: 'nothing here', hits: 0 });
  });

  it('URL の認証情報', () => {
    const r = redactSecrets('git clone https://bob:hunter2@example.invalid/r.git');
    expect(r.text).toBe('git clone https://[伏せました: URL の認証情報]example.invalid/r.git');
    expect(r.hits).toBe(1);
    // 認証情報の無い URL はそのまま
    expect(redactSecrets('https://example.invalid/a@b').hits).toBe(0);
  });

  it('名前の付いた値', () => {
    expect(redactSecrets('mysql -u root --password=hunter22').text).toBe('mysql -u root --password=[伏せました: 名前の付いた秘密の値]');
    expect(redactSecrets('{"api_key": "abc123xyz"}').text).toBe('{"api_key": "[伏せました: 名前の付いた秘密の値]"}');
    expect(redactSecrets('GITHUB_TOKEN=abcdef').text).toBe('GITHUB_TOKEN=[伏せました: 名前の付いた秘密の値]');
    // 形の決まった鍵を先に伏せたものは、もう一度伏せない
    expect(redactSecrets(`token=ghp_${'a'.repeat(36)}`)).toEqual({ text: 'token=[伏せました: GitHub トークン]', hits: 1 });
    // 名前の後ろが値でないもの(max_tokens: 10 など)は伏せない
    expect(redactSecrets('max_tokens: 1000, secrets found').hits).toBe(0);
  });
});

describe('失敗の台帳(normalizeSession)', () => {
  it('行は tools.results の失敗・拒否と同じ条件で作る', async () => {
    const r = await run([
      user('x', 0),
      start('a', 'view', { path: 'a.ts' }, 1),
      fail('a', 'Path does not exist', 2),
      start('b', 'edit', {}, 3),
      ev('tool.execution_complete', { toolCallId: 'b', success: false, error: { code: 'denied' } }, 4),
      // start の無い complete・内部ツールの失敗・success が真偽値でないものは数えない
      fail('zzz', 'orphan', 5),
      ev('tool.execution_start', { toolCallId: 'r', toolName: 'report_intent' }, 6),
      fail('r', 'internal', 7),
      start('c', 'view', {}, 8),
      ev('tool.execution_complete', { toolCallId: 'c', success: 'no' }, 9),
      // 同じ toolCallId の complete が 2 回来ると、tools.results は 2 回数える。台帳も 2 行にする(2 行目は開始の材料なし)
      start('d', 'grep', { pattern: 'p' }, 10),
      fail('d', 'boom', 11),
      fail('d', 'boom again', 12),
    ]);
    expectInvariant(r);
    const f = failures(r);
    expect(f.map((x) => [x.tool, x.kind])).toEqual([
      ['view', 'failure'],
      ['edit', 'denied'],
      ['grep', 'failure'],
      ['grep', 'failure'],
    ]);
    expect(f[0].cause).toBe('not_found');
    expect(f[0].error).toBe('failure: Path does not exist');
    expect(f[0].args).toBe('{"path":"a.ts"}');
    expect(f[0].durationMs).toBe(1000);
    expect(f[0].turn).toBe(0);
    expect(f[1].cause).toBeNull();
    expect([f[3].args, f[3].startedAt, f[3].durationMs]).toEqual([null, null, null]);
    expect(r.analysis.failuresDropped).toBe(0);
    // 1 行の項目の並び(sessions.json のキーの順)
    expect(Object.keys(f[0])).toEqual(['tool', 'kind', 'cause', 'error', 'args', 'mcpServer', 'mcpTool', 'mcpConfigSource', 'model', 'startedAt', 'durationMs', 'turn', 'agent', 'agentCall', 'next', 'group']);
  });

  it('失敗が無くても空の台帳を書き、項目の並びは turnStats の後', async () => {
    const r = await run([user('x', 0), start('a', 'view', {}, 1), ok('a', 2)]);
    expect(r.analysis.failures).toEqual([]);
    expect(r.analysis.failuresDropped).toBe(0);
    const keys = Object.keys(r.analysis);
    expect(keys.slice(keys.indexOf('turnStats'))).toEqual(['turnStats', 'failures', 'failuresDropped']);
    const tk = Object.keys(r.tools);
    expect(tk.slice(tk.indexOf('results'), tk.indexOf('results') + 2)).toEqual(['results', 'resultsByModel']);
  });

  it('最初の依頼より前は turn が null、200 件を超えても数える', async () => {
    const evs = [start('p', 'view', {}, 0), fail('p', 'x', 1)];
    for (let i = 0; i < 205; i++) evs.push(user(`q${i}`, 10 + i * 3));
    evs.push(start('q', 'view', {}, 1000), fail('q', 'x', 1001));
    const f = failures(await run(evs));
    expect(f[0].turn).toBeNull();
    expect(f[1].turn).toBe(204);
    // 依頼の前の失敗の後に依頼が来たので、next は user
    expect(f[0].next.kind).toBe('user');
  });

  it('next は並列の呼び出しと別のエージェントの呼び出しを数えない', async () => {
    const r = await run([
      user('x', 0),
      // 並列: b は a の失敗より前に始まったので数えない
      start('a', 'view', { path: 'x' }, 1),
      start('b', 'grep', {}, 2),
      fail('a', 'not found', 3),
      // 別のエージェントの呼び出しも数えない
      evx('tool.execution_start', { toolCallId: 's1', toolName: 'bash', arguments: {} }, 4, 'agent-1'),
      ok('b', 5),
      // 同じ引数で呼び直した
      start('c', 'view', { path: 'x' }, 6),
      ok('c', 7),
    ]);
    const f = failures(r);
    expect(f).toHaveLength(1);
    expect(f[0].next).toEqual({ kind: 'tool', tool: 'view', outcome: 'success', retry: true });
  });

  it('next は失敗と同じ応答で要求された呼び出しを数えない', async () => {
    const r = await run([
      user('x', 0),
      ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'a', name: 'view' }, { toolCallId: 'b', name: 'grep' }] }, 1),
      start('a', 'view', { path: 'x' }, 2),
      fail('a', 'not found', 3),
      // 同じ応答で要求された b は、a の失敗の後に動いても失敗への反応ではない
      start('b', 'grep', {}, 4),
      ok('b', 5),
      ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c', name: 'view' }] }, 6),
      start('c', 'view', { path: 'y' }, 7),
      fail('c', 'not found', 8),
      user('next', 9),
    ]);
    const f = failures(r);
    expect(f[0].next).toEqual({ kind: 'tool', tool: 'view', outcome: 'failure', retry: false });
    expect(f[1].next).toEqual({ kind: 'user' });
  });

  it('サブエージェントは親の呼び出しで見分け、依頼文は agents[] に 1 回だけ持つ', async () => {
    const prompt = `調べて token=abcdef123 ${'あ'.repeat(800)}`;
    const r = await run([
      user('x', 0),
      start('t1', 'task', { agent_type: 'explore', prompt }, 1),
      start('t2', 'task', { agent_type: 'explore', prompt: 'もう一方' }, 1),
      // parentToolCallId だけを持つ形
      ev('subagent.started', { toolCallId: 't1', agentName: 'explore' }, 2),
      ev('tool.execution_start', { toolCallId: 'x1', toolName: 'view', arguments: {}, parentToolCallId: 't1' }, 3),
      ev('tool.execution_complete', { toolCallId: 'x1', success: false, error: 'boom', parentToolCallId: 't1' }, 4),
      // agentId だけを持つ形(同じ名前の別のエージェント。agentId → 親の呼び出しは subagent.started から分かる)
      evx('subagent.started', { toolCallId: 't2', agentName: 'explore', parentToolCallId: 't2' }, 5, 'ag-2'),
      evx('tool.execution_start', { toolCallId: 'y1', toolName: 'view', arguments: {} }, 6, 'ag-2'),
      // 別のエージェント(t2)の呼び出しは、t1 の失敗の next にならない
      ev('tool.execution_start', { toolCallId: 'x2', toolName: 'grep', arguments: {}, parentToolCallId: 't1' }, 7),
      ev('tool.execution_complete', { toolCallId: 'x2', success: true, parentToolCallId: 't1' }, 8),
      evx('tool.execution_complete', { toolCallId: 'y1', success: false, error: 'boom' }, 9, 'ag-2'),
      ev('subagent.completed', { toolCallId: 't1', agentName: 'explore' }, 10),
      ok('t1', 11),
    ]);
    const f = failures(r);
    expect(f.map((x) => [x.agent, x.agentCall])).toEqual([
      ['explore', 't1'],
      ['explore', 't2'],
    ]);
    expect(f[0].next.tool).toBe('grep');
    expect(f[1].next.kind).toBe('end');
    // サブエージェントの依頼文は agents[] に 1 回だけ、伏せてから上限で切って持つ
    const p = r.agents.find((a) => a.id === 't1')?.prompt ?? '';
    expect(p.startsWith('調べて token=[伏せました: 名前の付いた秘密の値]')).toBe(true);
    expect(p.length).toBe(PROMPT_LIMIT);
    expect(r.agents.find((a) => a.id === 't2')?.prompt).toBe('もう一方');
    // prompt は agents[] の項目の最後
    expect(Object.keys(r.agents.find((a) => a.id === 't1')!).at(-1)).toBe('prompt');
  });

  it('行は上限まで、超えた分は数だけ', async () => {
    const evs = [user('x', 0)];
    for (let i = 0; i < MAX_ROWS + 7; i++) evs.push(start(`c${i}`, 'view', {}, 1 + i * 2), fail(`c${i}`, 'x', 2 + i * 2));
    const r = await run(evs);
    expect(failures(r)).toHaveLength(MAX_ROWS);
    expect(r.analysis.failuresDropped).toBe(7);
    expectInvariant(r);
  });

  it('文の項目は上限で切る', async () => {
    const r = await run([user('x', 0), start('a', 'create', { path: 'a', file_text: 'x'.repeat(5000) }, 1), fail('a', 'e'.repeat(5000), 2)]);
    const f = failures(r)[0];
    expect(f.error.length).toBe(ERROR_LIMIT);
    expect(f.error.endsWith('…')).toBe(true);
    expect(f.args!.length).toBe(ARGS_LIMIT);
    expect(f.group.length).toBeLessThanOrEqual(GROUP_LIMIT);
  });

  it('エラー文と引数の秘密を伏せる', async () => {
    const key = `ghp_${'a'.repeat(36)}`;
    const r = await run([
      user('x', 0),
      // 上限が鍵の途中に掛かる位置に置いても残らない
      start('a', 'bash', { command: `${'x'.repeat(ARGS_LIMIT - 40)} curl -H 'Authorization: token ${key}'` }, 1),
      fail('a', `auth failed for ${key} at https://bob:hunter2@example.invalid/`, 2),
    ]);
    const f = failures(r)[0];
    expect(f.error).not.toContain('ghp_');
    expect(f.error).not.toContain('hunter2');
    expect(f.error).toContain('[伏せました: GitHub トークン]');
    expect(f.args).not.toContain('ghp_');
    expect(f.group).not.toContain('ghp');
  });

  it('MCP の 3 項目・モデル・モデル別の結果', async () => {
    const r = await run([
      user('x', 0),
      ev('tool.execution_start', { toolCallId: 'a', toolName: 'srv-search', mcpServerName: 'srv', mcpToolName: 'search', mcpConfigSource: 'user', model: 'm-start', arguments: {} }, 1),
      ev('tool.execution_complete', { toolCallId: 'a', success: false, error: { code: 'failure', message: 'timed out' }, model: 'm-done' }, 2),
      ev('tool.execution_start', { toolCallId: 'b', toolName: 'srv-search', mcpServerName: 'srv', model: 'm-start', arguments: {} }, 3),
      ok('b', 4),
      start('c', 'view', {}, 5),
      ok('c', 6),
    ]);
    const f = failures(r)[0];
    expect([f.mcpServer, f.mcpTool, f.mcpConfigSource, f.model]).toEqual(['srv', 'search', 'user', 'm-done']);
    expect(r.tools.resultsByModel).toEqual({
      'm-done': { 'srv-search': { success: 0, failure: 1, denied: 0, causes: { timeout: 1 } } },
      'm-start': { 'srv-search': { success: 1, failure: 0, denied: 0 } },
      '(unknown)': { view: { success: 1, failure: 0, denied: 0 } },
    });
    expect(Object.keys(r.tools.resultsByModel!)).toEqual(['m-done', 'm-start', '(unknown)']);
    // モデル別の合計は tools.results と一致する
    for (const [tool, res] of Object.entries(r.tools.results)) {
      const sum = (k: 'success' | 'failure' | 'denied'): number => Object.values(r.tools.resultsByModel!).reduce((a, m) => a + (m[tool]?.[k] ?? 0), 0);
      expect([sum('success'), sum('failure'), sum('denied')]).toEqual([res.success, res.failure, res.denied]);
    }
  });
});

const LEDGER_HEADER = [
  'セッションID',
  'セッション名',
  'プロジェクト',
  '依頼番号',
  '開始',
  '種類',
  '要因',
  'ツール',
  'MCP サーバー',
  'MCP のツール',
  'MCP の設定元',
  'モデル',
  'エージェント',
  'エージェントの呼び出し',
  'エージェントへの依頼',
  '所要(ミリ秒)',
  'エラー文',
  '引数',
  'その後',
  '次のツール',
  '次の結果',
  '呼び直し',
  'そろえたエラー文',
];

/** 台帳の無い古い記録(sessions.json に failures・failuresDropped が無い) */
function withoutLedger(r: SessionRecord, id: string): SessionRecord {
  const { failures: _f, failuresDropped: _d, ...analysis } = r.analysis;
  return { ...r, id, analysis };
}

describe('失敗と拒否ごとの表(failures.csv)', () => {
  it('1 件 1 行、依頼番号は turns.csv と同じ 1 からの番号、サブエージェントへの依頼は agents[] から引く', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const r = await run(
      [
        // 最初の依頼より前の失敗(依頼番号は空。その後は利用者の次の依頼)
        start('p', 'view', { path: 'X:\\synthetic-p\\none.ts' }, 0),
        ev('tool.execution_complete', { toolCallId: 'p', success: false, error: 'boom' }, 1),
        user('直して', 10),
        start('a', 'view', { path: 'X:\\synthetic-p\\a.ts' }, 11),
        ev('tool.execution_complete', { toolCallId: 'a', success: false, error: { code: 'failure', message: 'Path does not exist' }, model: 'synthetic-model' }, 12),
        start('b', 'edit', { path: 'X:\\synthetic-p\\b.ts' }, 13),
        ev('tool.execution_complete', { toolCallId: 'b', success: false, error: { code: 'denied', message: 'denied by user' } }, 14),
        // サブエージェントの中の失敗と、同じ引数での呼び直し
        start('t1', 'task', { agent_type: 'explore', prompt: '呼び出し元を調べて' }, 15),
        ev('subagent.started', { toolCallId: 't1', agentName: 'explore' }, 16),
        ev('tool.execution_start', { toolCallId: 'x1', toolName: 'grep', arguments: { pattern: 'foo' }, parentToolCallId: 't1' }, 17),
        ev('tool.execution_complete', { toolCallId: 'x1', success: false, error: 'timed out', parentToolCallId: 't1' }, 18),
        ev('tool.execution_start', { toolCallId: 'x2', toolName: 'grep', arguments: { pattern: 'foo' }, parentToolCallId: 't1' }, 19),
        ev('tool.execution_complete', { toolCallId: 'x2', success: true, parentToolCallId: 't1' }, 20),
        ev('subagent.completed', { toolCallId: 't1', agentName: 'explore' }, 21),
        ev('tool.execution_complete', { toolCallId: 't1', success: true }, 22),
        user('次は検索', 30),
        // MCP のツールの失敗(その後の呼び出しなし)
        ev('tool.execution_start', { toolCallId: 'm', toolName: 'srv-search', mcpServerName: 'srv', mcpToolName: 'search', mcpConfigSource: 'user', arguments: { q: 'x' } }, 31),
        ev('tool.execution_complete', { toolCallId: 'm', success: false, error: { code: 'failure', message: 'rate limit' } }, 32),
      ],
      id,
    );
    const t = failuresTable([r])!;
    expect(t.header).toEqual(LEDGER_HEADER);
    expect(t.rows.every((row) => row.length === t.header.length)).toBe(true);
    // 行の数は tools.results の failure + denied と同じ(上限で切っていないとき)
    expect(t.rows.length).toBe(Object.values(r.tools.results).reduce((a, x) => a + x.failure + x.denied, 0));
    const column = (name: string): Cell[] => t.rows.map((row) => row[t.header.indexOf(name)]);
    expect(column('セッションID')).toEqual(Array(5).fill(id));
    expect(column('プロジェクト')).toEqual(Array(5).fill(r.project));
    // analysis.turnStats の添字(0 から)に 1 を足して、turns.csv の依頼番号に合わせる
    expect(column('依頼番号')).toEqual([null, 1, 1, 1, 2]);
    expect(turnsTable([r]).rows.map((row) => row[3])).toEqual([1, 2]);
    expect(column('開始')[1]).toBe(at(11));
    expect(column('種類')).toEqual(['失敗', '失敗', '拒否', '失敗', '失敗']);
    expect(column('要因')).toEqual(['その他', '対象が見つからない', '', '時間切れ', '上限・回数制限']);
    expect(column('ツール')).toEqual(['view', 'view', 'edit', 'grep', 'srv-search']);
    expect([column('MCP サーバー')[4], column('MCP のツール')[4], column('MCP の設定元')[4], column('MCP サーバー')[0]]).toEqual(['srv', 'search', 'user', '']);
    expect(column('モデル')[1]).toBe('synthetic-model');
    expect(column('エージェント')).toEqual(['', '', '', 'explore', '']);
    expect(column('エージェントの呼び出し')).toEqual(['', '', '', 't1', '']);
    expect(column('エージェントへの依頼')).toEqual(['', '', '', '呼び出し元を調べて', '']);
    expect(column('所要(ミリ秒)')).toEqual(Array(5).fill(1000));
    expect(column('エラー文')).toEqual(['boom', 'failure: Path does not exist', 'denied: denied by user', 'timed out', 'failure: rate limit']);
    expect(column('引数')[1]).toBe('{"path":"X:\\\\synthetic-p\\\\a.ts"}');
    expect(column('その後')).toEqual(['利用者の次の依頼', 'ツール', 'ツール', 'ツール', '続きなし']);
    expect(column('次のツール')).toEqual(['', 'edit', 'task', 'grep', '']);
    expect(column('次の結果')).toEqual(['', '拒否', '成功', '成功', '']);
    // 呼び直しは、その後がツールのときだけ値を持つ
    expect(column('呼び直し')).toEqual([null, false, false, true, null]);
    expect(column('そろえたエラー文')).toEqual(failures(r).map((f) => f.group));
    // agents[] に同じ id が無ければ、依頼文は空
    expect(failuresTable([{ ...r, agents: [] }])!.rows[3][t.header.indexOf('エージェントへの依頼')]).toBe('');
  });

  it('台帳の無い古い記録だけなら表を作らない。混ざっていれば、台帳のある記録の行だけの表', async () => {
    const failing = (id: string): Promise<SessionRecord> => run([user('x', 0), start('a', 'view', {}, 1), ev('tool.execution_complete', { toolCallId: 'a', success: false, error: 'boom' }, 2)], id);
    const created = await failing('00000000-0000-4000-8000-000000000011');
    const old = withoutLedger(await failing('x'), '00000000-0000-4000-8000-000000000012');
    const clean = await run([user('x', 0)], '00000000-0000-4000-8000-000000000013');
    expect(clean.analysis.failures).toEqual([]);
    expect(failuresTable([])).toBeNull();
    expect(failuresTable([old])).toBeNull();
    expect(failuresCsv([old])).toBeNull();
    // 失敗が 0 件でも、台帳があれば見出しだけの表にする
    const zero = failuresTable([clean])!;
    expect([zero.header.length, zero.rows.length]).toEqual([LEDGER_HEADER.length, 0]);
    // 渡した順。古い記録は行にならない
    expect(failuresTable([old, created, clean, created])!.rows.map((row) => row[0])).toEqual([created.id, created.id]);
    // 空のセッションは turns.csv・sessions.csv と同じく除く(台帳があっても数に入れない)
    const empty = { ...created, empty: true };
    expect(failuresTable([empty])).toBeNull();
    expect(failuresTable([empty, clean])!.rows).toHaveLength(0);
  });

  it("エラー文は切らず、改行もそのまま CSV に入れる。= や - で始まる文には ' が付く", async () => {
    const failEv = (call: string, error: string, s: number): CopilotEvent[] => [
      ev('tool.execution_start', { toolCallId: call, toolName: 'bash', arguments: '-rf X:\\synthetic-tmp' }, s),
      ev('tool.execution_complete', { toolCallId: call, success: false, error }, s + 1),
    ];
    const r = await run([user('x', 0), ...failEv('a', '=1+1 を評価できません\r\n2 行目, "引用" つき\n3 行目', 1), ...failEv('b', '-n は使えません', 3)], '00000000-0000-4000-8000-000000000021');
    const t = failuresTable([r])!;
    const col = (name: string): number => t.header.indexOf(name);
    // 表の値は記録のまま(' を足すのは CSV にするときだけ。SQLite には足さない)
    expect(t.rows[0][col('エラー文')]).toBe('=1+1 を評価できません\r\n2 行目, "引用" つき\n3 行目');
    expect(t.rows[0][col('引数')]).toBe('-rf X:\\synthetic-tmp');
    const csv = failuresCsv([r])!;
    expect(csv.startsWith('\ufeffセッションID,セッション名,プロジェクト,依頼番号,')).toBe(true);
    expect(csv).toContain(`,"'=1+1 を評価できません\r\n2 行目, ""引用"" つき\n3 行目",'-rf X:\\synthetic-tmp,`);
    expect(csv).toContain(",'-n は使えません,'-rf X:\\synthetic-tmp,");
    // 引用符の外の行の区切りは、見出し + 2 行 + 末尾の分だけ(エラー文の中の改行は引用符の中に残る)
    let quoted = false;
    let records = 0;
    for (let i = 0; i < csv.length; i++) {
      if (csv[i] === '"') quoted = !quoted;
      else if (csv[i] === '\n' && !quoted && i > 0 && csv[i - 1] === '\r') records++;
    }
    expect(records).toBe(3);
  });
});
