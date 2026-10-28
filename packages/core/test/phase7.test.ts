// Phase 7(実行の性質): 推論強度・モード・起点・文脈・待ち時間・ツールの所要時間・摩擦の詳細・todo の単体テスト
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTodos } from '../src/extract.ts';
import { computeMetrics, quantiles } from '../src/metrics.ts';
import { normalizeEffort, normalizeSession, subagentFailureReason } from '../src/normalize.ts';
import { snapshot } from '../src/snapshot.ts';
import { openWritable } from '../src/sqlite.ts';
import type { CopilotEvent } from '../src/types.ts';

const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const ev = (dt: number, type: string, data: Record<string, unknown>): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString() });

async function mtimes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name)] = (await stat(join(e.parentPath, e.name))).mtimeMs;
  }
  return out;
}

describe('Phase 7: 分類の小さな規則', () => {
  it('推論強度の表記をそろえる', () => {
    expect(normalizeEffort(' XHigh ')).toBe('xhigh');
    expect(normalizeEffort('')).toBeNull();
    expect(normalizeEffort(null)).toBeNull();
    expect(normalizeEffort(3)).toBeNull();
  });

  it('サブエージェント失敗の理由を分類する(実データの文面の形)', () => {
    expect(subagentFailureReason('402 You have exceeded your monthly quota')).toBe('quota');
    expect(subagentFailureReason("CAPIError: 429 Sorry, you've exceeded your 5 hour session limit")).toBe('rate_limit');
    expect(subagentFailureReason('AbortError: This operation was aborted')).toBe('aborted');
    expect(subagentFailureReason('No response generated')).toBe('no_response');
    expect(subagentFailureReason('boom')).toBe('other');
    expect(subagentFailureReason(undefined)).toBe('unknown');
    expect(subagentFailureReason({ message: 'rate limit hit' })).toBe('rate_limit');
  });

  it('quantiles は distribution と同じ定義(ceil(p·n) 番目)', () => {
    expect(quantiles([])).toEqual({ n: 0, median: null, p90: null });
    expect(quantiles([5, 1, 3, 2, 4])).toEqual({ n: 5, median: 3, p90: 5 });
    expect(quantiles([10, 20])).toEqual({ n: 2, median: 10, p90: 20 });
  });
});

describe('Phase 7: normalizeSession の実行の性質', () => {
  it('モード・推論強度(設定で補う)・起点・待ち時間・文脈・所要時間・摩擦の詳細', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        ev(0, 'session.start', { reasoningEffort: 'medium', context: { cwd: 'X:\\p' } }),
        ev(1000, 'user.message', { content: 'a' }), // モードの記録なし → mode_changed も無いので既定の interactive(推定)
        ev(2000, 'tool.execution_start', { toolCallId: 'r', toolName: 'report_intent' }),
        ev(2100, 'tool.execution_complete', { toolCallId: 'r', success: true }), // 内部ツールは所要時間に入れない
        ev(3000, 'tool.execution_start', { toolCallId: 'c', toolName: 'view' }),
        ev(3250, 'tool.execution_complete', { toolCallId: 'c', success: true }),
        ev(4000, 'session.usage_record', { usage: { model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 1, initiator: 'user', duration: 1500.4, timeToFirstTokenMs: 700.6, toolTokenCount: 4000, availableToolCount: 12 } }),
        ev(5000, 'session.model_change', { newModel: 'gpt-5.5', reasoningEffort: null }), // null は設定の変化として扱わない
        ev(6000, 'session.usage_record', { usage: { model: 'gpt-5.5', inputTokens: 20, outputTokens: 2, initiator: 'agent' } }),
        ev(7000, 'permission.completed', { result: { kind: 'approved' } }),
        ev(8000, 'session.error', { message: 'x' }),
        ev(9000, 'session.compaction_complete', { success: true, systemTokens: 100, conversationTokens: 200, toolDefinitionsTokens: 300 }),
      ],
    });
    expect(r.exec.modes).toEqual({ byMode: { interactive: 1 }, inferred: 1 });
    expect(r.exec.efforts).toEqual({ medium: { requests: 2, input: 30, output: 3, nanoAiu: 0 } });
    expect(r.exec.initiators).toEqual({ user: 1, agent: 1 });
    expect(r.exec.latency).toEqual({ 'claude-haiku-5.5': { ttft: [701], duration: [1500] } });
    // compaction の内訳(ツール定義 300)が usage の toolTokenCount(4000)より優先。使えるツールの数は usage の値
    expect(r.exec.context).toEqual({ systemTokens: 100, conversationTokens: 200, toolDefinitionsTokens: 300, availableToolCount: 12, source: 'compaction' });
    expect(r.tools.durations).toEqual({ view: [250] });
    expect(r.frictionDetail).toEqual({ permissions: { approved: 1 }, errorTypes: { '(unknown)': 1 }, subagentFailures: {}, compaction: { recorded: 0, input: 0, output: 0, nanoAiu: 0, tokensRemoved: 0 } });
    expect(r.todos).toBeNull();
  });

  it('文脈の内訳が usage_record の toolTokenCount しか無いときは source: usage。DB だけのターンのモードは (unknown)', async () => {
    const u = await normalizeSession({
      id: 'u',
      events: [ev(0, 'user.message', { content: 'a', agentMode: 'plan' }), ev(1000, 'session.usage_record', { usage: { model: 'm', inputTokens: 1, outputTokens: 1, toolTokenCount: 5000 } })],
    });
    expect(u.exec.context).toEqual({ systemTokens: null, conversationTokens: null, toolDefinitionsTokens: 5000, availableToolCount: null, source: 'usage' });
    expect(u.exec.modes).toEqual({ byMode: { plan: 1 }, inferred: 0 });
    expect(u.exec.initiators).toEqual({ '(unknown)': 1 });
    expect(u.exec.efforts).toEqual({ '(unknown)': { requests: 1, input: 1, output: 1, nanoAiu: 0 } });

    const d = await normalizeSession({
      id: 'd',
      db: { session: { id: 'd', cwd: null, repository: null, host_type: null, branch: null, summary: null, created_at: null, updated_at: null }, turns: [{ session_id: 'd', turn_index: 0, user_message: 'q', assistant_response: 'a', timestamp: null }] },
    });
    expect(d.exec.modes).toEqual({ byMode: { '(unknown)': 1 }, inferred: 0 });
  });

  it('metrics: exec / frictionDetail / todos を足し合わせ、todo の完了率を出す', async () => {
    const a = await normalizeSession({ id: 'a', events: [ev(0, 'user.message', { content: 'a', agentMode: 'autopilot' }), ev(1000, 'session.shutdown', { toolDefinitionsTokens: 1000 })] });
    const b = await normalizeSession({ id: 'b', events: [ev(0, 'user.message', { content: 'b' }), ev(1000, 'session.shutdown', { toolDefinitionsTokens: 3000 })] });
    a.todos = { total: 4, byStatus: { done: 3, pending: 1 }, deps: 1 };
    b.todos = { total: 0, byStatus: {}, deps: 0 };
    const m = computeMetrics([a, b]);
    expect(m.overall.exec.modes).toEqual({ byMode: { autopilot: 1, interactive: 1 }, inferred: 1 });
    expect(m.overall.exec.context).toEqual({ sessions: 2, toolDefinitionsTokens: { total: 4000, median: 1000, p90: 3000, mean: 2000 }, availableToolCount: { sessions: 0, mean: null } });
    expect(m.overall.todos).toEqual({ sessionsWithDb: 2, sessionsWithTodos: 1, total: 4, byStatus: { done: 3, pending: 1 }, deps: 1, completionRate: 0.75 });
    expect(m.latency).toEqual({});
    expect(m.toolDurations).toEqual({});
  });
});

describe('Phase 7: session.db の複製と todo の読み取り', () => {
  it('session.db を元を開かずに複製(本体は journal_mode=delete)、mtime 不変、変わらなければ再利用、todo を状態別に読む', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atlas-p7-'));
    const src = join(base, 'src');
    const dest = join(base, 'dest');
    const dir = join(src, 'session-state', 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'events.jsonl'), '{"type":"x"}\n');
    // 書き手が開いたまま(WAL にだけ行がある)の session.db
    const w = await openWritable(join(dir, 'session.db'));
    w.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT);
      CREATE TABLE todo_deps (todo_id TEXT, depends_on TEXT);
      INSERT INTO todos VALUES ('1','t','done'),('2','t','pending'),('3','t',NULL);
      INSERT INTO todo_deps VALUES ('2','1');`);
    try {
      const before = await mtimes(src);
      const m = await snapshot(src, dest);
      expect(await mtimes(src)).toEqual(before);
      expect(m.sessions).toMatchObject({ dbCopied: 1, dbReused: 0 });
      const copy = join(dest, 'session-state', 'a', 'session.db');
      expect(await readTodos(copy)).toEqual({ total: 3, byStatus: { done: 1, pending: 1, '(unknown)': 1 }, deps: 1 });
      const m2 = await snapshot(src, dest);
      expect(m2.sessions).toMatchObject({ dbCopied: 0, dbReused: 1 });
    } finally {
      w.close();
    }
    // todos テーブルの無い session.db は 0 件、ファイルが無ければ null
    const empty = join(base, 'empty.db');
    const e = await openWritable(empty);
    e.exec('CREATE TABLE inbox_entries (id TEXT)');
    e.close();
    expect(await readTodos(empty)).toEqual({ total: 0, byStatus: {}, deps: 0 });
    expect(await readTodos(join(base, 'none.db'))).toBeNull();
    expect(existsSync(join(dest, 'session-state', 'a', '.session.db.src'))).toBe(true);
  });
});
