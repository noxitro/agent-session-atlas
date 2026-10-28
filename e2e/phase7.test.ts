// Phase 7 E2E(docs/PLAN.md「改善フェーズ → Phase 7: 実行の性質と要点」)
// fixture の ~/.copilot に、このテストで合成セッション 014・015 と session.db(todo)と session-store.db の明細行を足し、
//  1. モード別のターン・推論強度別のリクエスト / トークン / AIU が手計算と一致する
//  2. リクエストの起点(initiator)の比率
//  3. 文脈の内訳(ツール定義のトークン)がセッション・プロジェクト別に出る
//  4. モデル別の待ち時間(中央値・p90)
//  5. ツールの所要時間(1 時間超は外れ値として除き件数を出す)
//  6. 摩擦の詳細(権限の結果・エラーの種別・サブエージェント失敗の理由・compaction 自体のトークン)
//  7. todo が snapshot(session.db の VACUUM INTO)から読め、状態別件数と完了率が出る
//  8. 要点欄が機械的に出て、各項目が詳細ページか絞り込み(#...)へのリンクを持つ
//  ほか: 元ファイルの mtime 不変、HTML 5MB 未満、HTML と詳細ページに欄が出る、--anonymize で固有名が出ない
// ATLAS_LIVE=1 のときは実データで out/live を作り直し、モード別・推論強度別・起点の比率・ツール定義の平均・
// モデル別の TTFT・遅いツール・todo の完了率・要点・atlas.html のサイズをログに出す。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latencyByModel, openReadOnly, openWritable, toolDurationStats, type MetricsFile, type SessionRecord, type SessionsFile } from '../packages/core/src/index.ts';
import { aggregate, applyFilter, emptyFilter, extractEmbedded, highlights, type ReportData } from '../packages/report/src/index.ts';
import { decodeFilter, decodeView, usedTool } from '../packages/report/src/lib/filter.ts';
import { buildFixtureHome, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase7');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P7 = 'X:\\synthetic-p7';
const P7B = 'X:\\synthetic-p7b';
const TEMP_DIR = 'X:\\home\\someone\\AppData\\Local\\Temp';
const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const HOUR = 3_600_000;

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

async function mtimes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name)] = (await stat(join(e.parentPath, e.name))).mtimeMs;
  }
  return out;
}

type Ev = [offsetMs: number, type: string, data: Record<string, unknown>];

async function writeSession(home: string, sid: string, cwd: string, events: Ev[]): Promise<void> {
  const dir = join(home, 'session-state', sid);
  await mkdir(dir, { recursive: true });
  const last = events[events.length - 1][0];
  const ws = [`id: ${sid}`, `cwd: '${cwd}'`, 'client_name: github/cli', `created_at: ${new Date(T0).toISOString()}`, `updated_at: ${new Date(T0 + last).toISOString()}`].join('\n');
  await writeFile(join(dir, 'workspace.yaml'), `${ws}\n`);
  const lines = events.map(([dt, type, data], i) => JSON.stringify({ type, data, id: `e${i + 1}`, timestamp: new Date(T0 + dt).toISOString(), parentId: i === 0 ? null : `e${i}` }));
  await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

const usage = (model: string, input: number, output: number, initiator: string, nanoAiu: number, extra: Record<string, unknown>): Record<string, unknown> => ({
  usage: { model, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: initiator === 'user' ? 1 : 0, initiator, copilotUsage: { totalNanoAiu: nanoAiu }, ...extra },
});

/**
 * 014: Phase 7 の各形式(値はすべて架空)。
 * - モード: 最初の依頼はモードの記録なし → 後の mode_changed の previousMode(interactive)/ plan に変更後の依頼 / agentMode: autopilot の依頼 / 自動継続(数えない)
 * - 推論強度: session.start は medium → model_change で high。usage_record は記録なし(→ medium)・xhigh(記録を優先)・記録なし(→ high)
 * - DB の明細: usage_record と同じリクエスト(待ち時間・推論強度が空 → usage_record で補う)と、initiator: compaction・low の行
 * - ツール: view 500ms・100ms、powershell 3 秒と 2 時間(外れ値)、grep 5 回(うち 2 回失敗)
 * - 摩擦: 権限 approved / denied-… / approved-for-location、session.error quota / rate_limit、subagent.failed 402 / 429 / Abort
 * - 文脈: compaction_complete と、より後の shutdown の systemTokens / conversationTokens / toolDefinitionsTokens
 */
function session14(): Ev[] {
  const ev: Ev[] = [
    [0, 'session.start', { sessionId: id(14), version: 1, copilotVersion: '1.0.103', selectedModel: 'gpt-5.5', reasoningEffort: 'medium', context: { cwd: P7 } }],
    [1000, 'user.message', { content: 'first request' }],
    [2000, 'tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: `${P7}\\a.ts` } }],
    [2500, 'tool.execution_complete', { toolCallId: 'c1', success: true }],
    [3000, 'session.usage_record', usage('gpt-5.5', 1000, 100, 'user', 1_000_000_000, { duration: 2000, timeToFirstTokenMs: 800, availableToolCount: 30, toolTokenCount: 9000 })],
    [4000, 'session.mode_changed', { previousMode: 'interactive', newMode: 'plan' }],
    [5000, 'user.message', { content: 'make a plan' }],
    [6000, 'session.model_change', { previousModel: 'gpt-5.5', newModel: 'claude-sonnet-5.5', previousReasoningEffort: 'medium', reasoningEffort: 'high' }],
    [7000, 'user.message', { content: 'go', agentMode: 'autopilot' }],
    [8000, 'user.message', { content: '', isAutopilotContinuation: true, agentMode: 'autopilot' }],
    [9000, 'tool.execution_start', { toolCallId: 'c2', toolName: 'powershell', arguments: { command: 'npm test' } }],
    [12000, 'tool.execution_complete', { toolCallId: 'c2', success: true }],
    [13000, 'tool.execution_start', { toolCallId: 'c3', toolName: 'powershell', arguments: { command: 'npm run watch' } }],
    [13000 + 2 * HOUR, 'tool.execution_complete', { toolCallId: 'c3', success: true }],
  ];
  let t = 13000 + 2 * HOUR + 1000;
  ev.push([t, 'tool.execution_start', { toolCallId: 'c4', toolName: 'view', arguments: { path: `${P7}\\b.ts` } }]);
  ev.push([t + 100, 'tool.execution_complete', { toolCallId: 'c4', success: true }]);
  t += 1000;
  for (let i = 1; i <= 5; i++) {
    ev.push([t, 'tool.execution_start', { toolCallId: `g${i}`, toolName: 'grep', arguments: { pattern: 'x' } }]);
    ev.push([t + 10, 'tool.execution_complete', i <= 2 ? { toolCallId: `g${i}`, success: false, error: { code: 'failure', message: 'bad pattern' } } : { toolCallId: `g${i}`, success: true }]);
    t += 100;
  }
  const after: [string, Record<string, unknown>][] = [
    ['permission.requested', { requestId: 'p1', permissionRequest: { kind: 'url' } }],
    ['permission.completed', { requestId: 'p1', toolCallId: 'x1', result: { kind: 'approved' } }],
    ['permission.requested', { requestId: 'p2', permissionRequest: { kind: 'read' } }],
    ['permission.completed', { requestId: 'p2', toolCallId: 'x2', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } }],
    ['permission.completed', { requestId: 'p3', toolCallId: 'x3', result: { kind: 'approved-for-location' } }],
    ['session.error', { errorType: 'quota', statusCode: 402, message: 'You have exceeded your monthly quota' }],
    ['session.error', { errorType: 'rate_limit', statusCode: 429, message: 'rate limited' }],
    ['subagent.started', { toolCallId: 'a1', agentName: 'explore' }],
    ['subagent.failed', { toolCallId: 'a1', agentName: 'explore', error: '402 You have exceeded your monthly quota' }],
    ['subagent.started', { toolCallId: 'a2', agentName: 'explore' }],
    ['subagent.failed', { toolCallId: 'a2', agentName: 'explore', error: "CAPIError: 429 Sorry, you've exceeded your 5 hour session limit" }],
    ['subagent.started', { toolCallId: 'a3', agentName: 'task' }],
    ['subagent.failed', { toolCallId: 'a3', agentName: 'task', error: 'AbortError: This operation was aborted' }],
    [
      'session.compaction_complete',
      {
        success: true,
        preCompactionTokens: 50000,
        tokensRemoved: 20000,
        systemTokens: 5000,
        conversationTokens: 30000,
        toolDefinitionsTokens: 9500,
        compactionTokensUsed: { inputTokens: 40000, outputTokens: 2000, cacheReadTokens: 0, copilotUsage: { totalNanoAiu: 300_000_000 } },
      },
    ],
    ['session.usage_record', usage('claude-sonnet-5.5', 2000, 300, 'agent', 2_000_000_000, { reasoningEffort: 'xhigh', duration: 4000, timeToFirstTokenMs: 1500, availableToolCount: 32, toolTokenCount: 9800 })],
    ['session.usage_record', usage('claude-sonnet-5.5', 500, 50, 'sub-agent', 500_000_000, { duration: 1000, timeToFirstTokenMs: 600 })],
    ['assistant.message', { messageId: 'm1', content: 'done p7', model: 'claude-sonnet-5.5' }],
    ['session.shutdown', { shutdownType: 'routine', systemTokens: 5200, conversationTokens: 12000, toolDefinitionsTokens: 9800, codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: [] } }],
  ];
  for (const [type, data] of after) {
    t += 1000;
    ev.push([t, type, data]);
  }
  return ev;
}

/** 015: モードの記録が一つも無い(既定の interactive とみなす)・明細が無く終了時の累計だけ(推論強度は設定の high に入る) */
function session15(): Ev[] {
  return [
    [0, 'session.start', { sessionId: id(15), version: 1, copilotVersion: '1.0.103', selectedModel: 'gpt-5.5', reasoningEffort: 'high', context: { cwd: P7B } }],
    [1000, 'user.message', { content: 'hello' }],
    [2000, 'assistant.message', { messageId: 'm1', content: 'hi', model: 'gpt-5.5' }],
    [
      3000,
      'session.shutdown',
      {
        shutdownType: 'routine',
        totalNanoAiu: 400_000_000,
        systemTokens: 3000,
        conversationTokens: 1000,
        toolDefinitionsTokens: 7000,
        modelMetrics: { 'gpt-5.5': { requests: { count: 3, cost: 1 }, usage: { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, totalNanoAiu: 400_000_000 } },
      },
    ],
  ];
}

/** session-state/<id>/session.db(todos と todo_deps。Copilot と同じスキーマ) */
async function writeSessionDb(path: string): Promise<void> {
  const db = await openWritable(path);
  try {
    db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE todo_deps (todo_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (todo_id, depends_on));
      INSERT INTO todos (id, title, status) VALUES ('t1', 'secret-todo-title-1', 'done'), ('t2', 'secret-todo-title-2', 'done'),
        ('t3', 'secret-todo-title-3', 'in_progress'), ('t4', 'secret-todo-title-4', 'pending'), ('t5', 'secret-todo-title-5', 'blocked');
      INSERT INTO todo_deps VALUES ('t3', 't1'), ('t4', 't3');`);
  } finally {
    db.close();
  }
}

/** session-store.db に 014 の明細を足す(1 行目は usage_record と同じリクエストで、待ち時間・推論強度が空) */
async function addStoreRows(dbPath: string): Promise<void> {
  const db = await openWritable(dbPath);
  try {
    const ins = db.prepare(
      `INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_nano_aiu, request_multiplier, duration_ms, time_to_first_token_ms, initiator, reasoning_effort, created_at) VALUES (?,?,?,?,0,0,0,?,1,?,?,?,?,?)`,
    );
    ins.run(id(14), 'gpt-5.5', 1000, 100, 1_000_000_000, null, null, 'user', null, '2026-10-26 00:00:03');
    ins.run(id(14), 'gpt-5.5', 700, 70, 700_000_000, 3000, 1200, 'compaction', 'low', '2026-10-26 02:00:30');
  } finally {
    db.close();
  }
}

describe('Phase 7 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  const out = join(WORK, 'out');
  let s: SessionsFile;
  let m: MetricsFile;
  let html: string;
  let data: ReportData;
  let before: Record<string, number>;
  let after: Record<string, number>;
  const rec = (n: number): SessionRecord => {
    const r = s.sessions.find((x) => x.id === id(n));
    if (!r) throw new Error(`fixture ${id(n)} が sessions.json に無い`);
    return r;
  };
  const p7 = (): ReturnType<typeof aggregate> => aggregate(applyFilter(data.sessions, { ...emptyFilter(), project: P7 }));

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'copilot')));
    await writeSession(home, id(14), P7, session14());
    await writeSession(home, id(15), P7B, session15());
    await writeSessionDb(join(home, 'session-state', id(14), 'session.db'));
    await addStoreRows(join(home, 'session-store.db'));
    await mkdir(join(home, 'skills', 'zz-unused-skill'), { recursive: true });
    before = await mtimes(home);
    const r = atlas(['all', '--home', home, '--out', out, '--temp-dir', TEMP_DIR]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    console.log(`[fixtures] ${r.stdout}`);
    after = await mtimes(home);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });
  afterAll(async () => close?.());

  it('元ファイルの mtime が実行前後で変わらない(session.db も開かずに複製する)', () => {
    expect(Object.keys(before)).toContain(join(home, 'session-state', id(14), 'session.db'));
    expect(after).toEqual(before);
  });

  it('1. モード別のターンと推論強度別のリクエスト・トークン・AIU', () => {
    const e = rec(14).exec;
    expect(rec(14).turns).toBe(3);
    // 最初の依頼は後の mode_changed の previousMode(記録)で interactive。agentMode が直前のモードより優先。自動継続は数えない
    expect(e.modes).toEqual({ byMode: { interactive: 1, plan: 1, autopilot: 1 }, inferred: 0 });
    expect(rec(15).exec.modes).toEqual({ byMode: { interactive: 1 }, inferred: 1 });
    // DB 行(推論強度が空 → その時点の設定 medium)/ DB 行 low / usage_record xhigh(記録を優先)/ usage_record 記録なし → model_change 後の high
    expect(e.efforts).toEqual({
      medium: { requests: 1, input: 1000, output: 100, nanoAiu: 1_000_000_000 },
      low: { requests: 1, input: 700, output: 70, nanoAiu: 700_000_000 },
      xhigh: { requests: 1, input: 2000, output: 300, nanoAiu: 2_000_000_000 },
      high: { requests: 1, input: 500, output: 50, nanoAiu: 500_000_000 },
    });
    expect(rec(14).tokens).toMatchObject({ source: 'db+events', requests: 4, records: { db: 2, events: 2, duplicatesRemoved: 1 } });
    // 明細が無く終了時の累計だけ: セッション中の設定が high だけなので high
    expect(rec(15).exec.efforts).toEqual({ high: { requests: 3, input: 3000, output: 300, nanoAiu: 400_000_000 } });
    expect(m.byProject[P7].exec.modes).toEqual({ byMode: { interactive: 1, plan: 1, autopilot: 1 }, inferred: 0 });
    expect(m.byProject[P7].exec.efforts.xhigh).toEqual({ requests: 1, input: 2000, output: 300, nanoAiu: 2_000_000_000 });
    // 画面の集計(絞り込み後)
    const x = p7().exec;
    expect(x.modes).toEqual({ rows: [{ key: 'interactive', turns: 1 }, { key: 'plan', turns: 1 }, { key: 'autopilot', turns: 1 }], inferred: 0, total: 3 });
    expect(x.efforts.map((r) => [r.key, r.requests, r.input, r.output, r.nanoAiu])).toEqual([
      ['low', 1, 700, 70, 700_000_000],
      ['medium', 1, 1000, 100, 1_000_000_000],
      ['high', 1, 500, 50, 500_000_000],
      ['xhigh', 1, 2000, 300, 2_000_000_000],
    ]);
    const both = aggregate(applyFilter(data.sessions, emptyFilter())).exec;
    expect(both.modes.inferred).toBe(m.overall.exec.modes.inferred);
    expect(both.modes.total).toBe(Object.values(m.overall.exec.modes.byMode).reduce((a, n) => a + n, 0));
  });

  it('2. リクエストの起点(initiator)の比率', () => {
    expect(rec(14).exec.initiators).toEqual({ user: 1, compaction: 1, agent: 1, 'sub-agent': 1 });
    expect(rec(15).exec.initiators).toEqual({}); // 明細が無いセッションは数えない
    const x = p7().exec.initiators;
    expect(x).toEqual({ rows: [{ key: 'user', requests: 1 }, { key: 'agent', requests: 1 }, { key: 'sub-agent', requests: 1 }, { key: 'compaction', requests: 1 }], total: 4 });
    const all = aggregate(applyFilter(data.sessions, emptyFilter())).exec.initiators;
    expect(all.total).toBe(Object.values(m.overall.exec.initiators).reduce((a, n) => a + n, 0));
  });

  it('3. 文脈の内訳: ツール定義のトークン(最後の値)をセッション・プロジェクト別に', () => {
    // compaction(9500)より後の shutdown(9800)が最後の値。使えるツールの数は usage_record の最後の値
    expect(rec(14).exec.context).toEqual({ systemTokens: 5200, conversationTokens: 12000, toolDefinitionsTokens: 9800, availableToolCount: 32, source: 'shutdown' });
    expect(rec(15).exec.context).toEqual({ systemTokens: 3000, conversationTokens: 1000, toolDefinitionsTokens: 7000, availableToolCount: null, source: 'shutdown' });
    expect(m.byProject[P7].exec.context).toEqual({ sessions: 1, toolDefinitionsTokens: { total: 9800, median: 9800, p90: 9800, mean: 9800 }, availableToolCount: { sessions: 1, mean: 32 } });
    const c = p7().exec.context;
    expect(c).toMatchObject({ sessions: 1, toolDefAvg: 9800, toolDefMedian: 9800, shareSessions: 1, availableToolsAvg: 32 });
    expect(c.shareAvg).toBeCloseTo(9800 / (5200 + 12000 + 9800), 10);
    // 2 プロジェクトに絞らず全体: P7(9800)と P7B(7000)がプロジェクト別に並ぶ
    const all = aggregate(applyFilter(data.sessions, emptyFilter())).exec.context.byProject;
    expect(all.find((r) => r.key === P7)).toMatchObject({ sessions: 1, toolDefAvg: 9800 });
    expect(all.find((r) => r.key === P7B)).toMatchObject({ sessions: 1, toolDefAvg: 7000, shareAvg: 7000 / 11000 });
  });

  it('4. モデル別の待ち時間(中央値・p90)。DB の空の値は同じリクエストの usage_record で補う', () => {
    expect(rec(14).exec.latency).toEqual({
      'gpt-5.5': { ttft: [800, 1200], duration: [2000, 3000] },
      'claude-sonnet-5.5': { ttft: [1500, 600], duration: [4000, 1000] },
    });
    const l = p7().exec.latency;
    expect(l.map((r) => [r.model, r.ttft, r.duration])).toEqual([
      ['claude-sonnet-5.5', { n: 2, median: 600, p90: 1500 }, { n: 2, median: 1000, p90: 4000 }],
      ['gpt-5.5', { n: 2, median: 800, p90: 1200 }, { n: 2, median: 2000, p90: 3000 }],
    ]);
    // metrics.json の全体の値は、全セッションの明細を 1 本にした中央値・p90
    expect(m.latency).toEqual(latencyByModel(s.sessions.filter((x) => !x.empty)));
  });

  it('5. ツールの所要時間: 1 時間超は外れ値として除き件数を出す', () => {
    expect(rec(14).tools.durations).toEqual({ view: [500, 100], powershell: [3000], grep: [10, 10, 10, 10, 10] });
    expect(rec(14).tools.durationOutliers).toEqual({ powershell: 1 });
    const d = p7().exec.toolDurations;
    expect(d.rows.map((r) => [r.tool, r.n, r.median, r.p90, r.outliers])).toEqual([
      ['powershell', 1, 3000, 3000, 1],
      ['view', 2, 100, 500, 0],
      ['grep', 5, 10, 10, 0],
    ]);
    expect(d).toMatchObject({ measured: 8, outliers: 1 });
    expect(m.toolDurations).toEqual(toolDurationStats(s.sessions.filter((x) => !x.empty)));
    expect(m.toolDurations.powershell.outliers).toBeGreaterThanOrEqual(1);
  });

  it('6. 摩擦の詳細: 権限の結果・エラーの種別・サブエージェント失敗の理由・compaction 自体のトークン', () => {
    expect(rec(14).frictionDetail).toEqual({
      permissions: { approved: 1, 'denied-no-approval-rule-and-could-not-request-from-user': 1, 'approved-for-location': 1 },
      errorTypes: { quota: 1, rate_limit: 1 },
      subagentFailures: { quota: 1, rate_limit: 1, aborted: 1 },
      compaction: { recorded: 1, input: 40000, output: 2000, nanoAiu: 300_000_000, tokensRemoved: 20000 },
    });
    expect(rec(14).agents.filter((a) => a.status === 'failed').map((a) => a.error)).toEqual([
      '402 You have exceeded your monthly quota',
      "CAPIError: 429 Sorry, you've exceeded your 5 hour session limit",
      'AbortError: This operation was aborted',
    ]);
    const f = p7().exec.friction;
    expect(f.permissions).toEqual({ approved: 2, denied: 1, other: 0 });
    expect(f.errorTypes).toEqual([{ name: 'quota', count: 1 }, { name: 'rate_limit', count: 1 }]);
    expect(f.subagentFailures).toEqual([{ name: 'aborted', count: 1 }, { name: 'quota', count: 1 }, { name: 'rate_limit', count: 1 }]);
    expect(f.compaction).toEqual({ compactions: 1, recorded: 1, input: 40000, output: 2000, nanoAiu: 300_000_000, tokensRemoved: 20000 });
    expect(m.byProject[P7].frictionDetail.subagentFailures).toEqual({ quota: 1, rate_limit: 1, aborted: 1 });
  });

  it('7. todo: session.db を snapshot に複製(VACUUM INTO)し、状態別件数と完了率を出す。タイトルは埋め込まない', async () => {
    const copy = join(out, 'snapshot', 'session-state', id(14), 'session.db');
    expect(existsSync(copy)).toBe(true);
    const db = await openReadOnly(copy);
    try {
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
      expect((db.prepare('SELECT count(*) AS n FROM todos').get() as { n: number }).n).toBe(5);
    } finally {
      db.close();
    }
    expect(rec(14).todos).toEqual({ total: 5, byStatus: { done: 2, in_progress: 1, pending: 1, blocked: 1 }, deps: 2 });
    expect(rec(15).todos).toBeNull();
    expect(m.byProject[P7].todos).toEqual({ sessionsWithDb: 1, sessionsWithTodos: 1, total: 5, byStatus: { done: 2, in_progress: 1, pending: 1, blocked: 1 }, deps: 2, completionRate: 0.4 });
    expect(p7().exec.todos).toEqual(m.byProject[P7].todos);
    expect(html).not.toContain('secret-todo-title');
    // 2 回目の snapshot は変わっていない session.db を複製し直さない
    const again = atlas(['snapshot', '--home', home, '--out', out]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/session\.db 複製 0 \/ 再利用 1/);
  });

  it('8. 要点欄: 機械的に選び、各項目は詳細ページか絞り込み(#...)へのリンクを持つ', () => {
    const filter = { ...emptyFilter(), project: P7 };
    const sessions = applyFilter(data.sessions, filter);
    const g = highlights(sessions, aggregate(sessions).usage, { filter, anonymized: false, installed: data.installed });
    expect(g.map((x) => x.kind)).toEqual(['cost', 'tool-failure', 'compaction', 'unused-skill']);
    const [cost, tool, comp, unused] = g;
    expect(cost.items).toEqual([{ text: expect.stringContaining('first request: 4.2 AIU(この条件の合計の 100%)'), href: `sessions/${id(14)}.html`, linkLabel: 'セッションの詳細' }]);
    expect(tool.items).toHaveLength(1);
    expect(tool.items[0].text).toContain('grep: 失敗率 40%(失敗 2・拒否 0 / 5 回、1 セッション)');
    // 絞り込みのリンク: 今の条件(プロジェクト)にツールを足したもの。開くとそのツールを使ったセッションだけになる
    expect(tool.items[0].href.startsWith('#')).toBe(true);
    const f = decodeFilter(tool.items[0].href);
    expect(f).toEqual({ ...filter, tool: 'grep' });
    expect(applyFilter(data.sessions, f).map((x) => x.id)).toEqual([id(14)]);
    expect(data.sessions.filter((x) => usedTool(x, 'grep')).length).toBeGreaterThanOrEqual(1);
    expect(comp.items).toEqual([{ text: expect.stringContaining('compaction 1 回(減ったトークン 20,000)'), href: `sessions/${id(14)}.html`, linkLabel: 'セッションの詳細' }]);
    expect(unused.items[0].text).toContain('zz-unused-skill');
    expect(decodeView(unused.items[0].href)).toBe('unused-skills');
    expect(decodeFilter(unused.items[0].href)).toEqual(filter);
    // 詳細ページのリンク先が実在する
    for (const it of [...cost.items, ...comp.items]) expect(existsSync(join(out, it.href))).toBe(true);
  });

  it('HTML と詳細ページに新しい欄が出る、5MB 未満', async () => {
    for (const t of ['要点', '実行の性質', 'モード別の依頼', '推論強度別', 'リクエストの起点', '文脈の内訳(ツール定義)', 'モデル別の待ち時間', 'ツールの所要時間', '摩擦の詳細', '完了率', '推論強度(reasoningEffort)'])
      expect(html).toContain(t);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    const detail = await readFile(join(out, 'sessions', `${id(14)}.html`), 'utf8');
    for (const t of ['実行の性質', 'モード別の依頼', '対話(interactive) 1・計画(plan) 1・autopilot 1', 'ツール定義のトークン', '9,800', 'モデル別の待ち時間', 'ツールの所要時間', '1 時間を超えた 1 回は外れ値', '権限の確認の結果', '利用上限(402・quota) 1', '5 件(完了率 40%)', '失敗したサブエージェント'])
      expect(detail).toContain(t);
    expect(detail).not.toContain('secret-todo-title');
  });

  it('--anonymize で固有名(パス・プロジェクト名)が出ない', async () => {
    const anonOut = join(WORK, 'out-anon');
    const r = atlas(['all', '--home', home, '--out', anonOut, '--anonymize', '--temp-dir', TEMP_DIR]);
    expect(r.status, r.stderr).toBe(0);
    const files = [join(anonOut, 'atlas.html'), join(anonOut, 'sessions', `${id(14)}.html`), join(anonOut, 'sessions', `${id(15)}.html`)];
    for (const f of files) {
      const h = await readFile(f, 'utf8');
      const leaked = ['synthetic-p7', 'secret-todo-title', 'first request', 'make a plan'].filter((x) => h.includes(x));
      expect({ f, leaked }).toEqual({ f, leaked: [] });
    }
    const d = extractEmbedded<ReportData>(await readFile(files[0], 'utf8'));
    const x = d.sessions.find((y) => y.id === id(14))!;
    expect(x.exec.modes).toEqual({ interactive: 1, plan: 1, autopilot: 1 });
    expect(x.todos?.total).toBe(5);
  });
});

describe.skipIf(!LIVE)('Phase 7 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let s: SessionsFile;
  let m: MetricsFile;
  let r: ReturnType<typeof atlas>;

  beforeAll(async () => {
    r = atlas(['all', '--home', src, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
  });

  it('モード別・推論強度別・起点の比率・ツール定義・待ち時間・遅いツール・todo・要点・サイズをログに出す', async () => {
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const data = extractEmbedded<ReportData>(html);
    const filter = emptyFilter();
    const sessions = applyFilter(data.sessions, filter);
    const agg = aggregate(sessions);
    const x = agg.exec;
    const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
    const g = highlights(sessions, agg.usage, { filter, anonymized: false, installed: data.installed });
    const embedded = Buffer.byteLength(JSON.stringify(data));
    const slow = x.toolDurations.rows.filter((t) => t.n >= 5).slice(0, 8);
    console.log(
      `[live] atlas all ${r.ms.toFixed(0)}ms, sessions=${s.sessions.length}, nonEmpty=${sessions.length}, session.db あり ${x.todos.sessionsWithDb}\n` +
        `[live] モード別の依頼: ${x.modes.rows.map((k) => `${k.key} ${k.turns}(${pct(k.turns, x.modes.total)})`).join(' / ')}、うち既定の interactive とみなした ${x.modes.inferred}\n` +
        `[live] 推論強度別: ${x.efforts.map((e) => `${e.key} ${e.requests} 回・出力 ${e.output}・${(e.nanoAiu / 1e9).toFixed(2)} AIU`).join(' / ')}\n` +
        `[live] 起点: ${x.initiators.rows.map((k) => `${k.key} ${k.requests}(${pct(k.requests, x.initiators.total)})`).join(' / ')}(計 ${x.initiators.total})\n` +
        `[live] ツール定義: 平均 ${x.context.toolDefAvg}・中央値 ${x.context.toolDefMedian} トークン(${x.context.sessions} セッション)、文脈に占める割合の平均 ${x.context.shareAvg == null ? '—' : (x.context.shareAvg * 100).toFixed(1) + '%'}(${x.context.shareSessions} セッション)、使えるツール平均 ${x.context.availableToolsAvg}\n` +
        `[live] 上位プロジェクト(ツール定義の平均): ${x.context.byProject.slice(0, 5).map((p) => `${p.label} ${p.toolDefAvg}`).join(' / ')}\n` +
        `[live] モデル別 TTFT 中央値/p90: ${x.latency.slice(0, 8).map((l) => `${l.model} ${l.ttft.median}/${l.ttft.p90}ms(n=${l.ttft.n})`).join(' / ')}\n` +
        `[live] 遅いツール(5 回以上、p90 順): ${slow.map((t) => `${t.tool} 中央値 ${t.median}ms・p90 ${t.p90}ms(n=${t.n}、外れ値 ${t.outliers})`).join(' / ')}、外れ値の合計 ${x.toolDurations.outliers} / 計測 ${x.toolDurations.measured}\n` +
        `[live] 摩擦の詳細: 権限 ${JSON.stringify(x.friction.permissions)}、エラー ${x.friction.errorTypes.map((e) => `${e.name} ${e.count}`).join(' / ')}、サブエージェント失敗 ${x.friction.subagentFailures.map((e) => `${e.name} ${e.count}`).join(' / ')}、compaction 入力 ${x.friction.compaction.input}・出力 ${x.friction.compaction.output}(記録 ${x.friction.compaction.recorded} / ${x.friction.compaction.compactions})\n` +
        `[live] todo: ${x.todos.total} 件、完了率 ${x.todos.completionRate == null ? '—' : (x.todos.completionRate * 100).toFixed(1) + '%'}、状態別 ${JSON.stringify(x.todos.byStatus)}、依存 ${x.todos.deps}、todo のあるセッション ${x.todos.sessionsWithTodos}\n` +
        `[live] 要点:\n${g.map((k) => `  - ${k.title}: ${k.items.map((i) => `${i.text} → ${i.href}`).join(' | ')}`).join('\n')}\n` +
        `[live] atlas.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)}MB(埋め込みデータ ${(embedded / 1024 / 1024).toFixed(2)}MB)`,
    );
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    expect(x.todos.total).toBe(m.overall.todos.total);
    expect(x.initiators.total).toBe(Object.values(m.overall.exec.initiators).reduce((a, n) => a + n, 0));
    // 1 時間超の外れ値は中央値・p90 に入っていない
    for (const t of x.toolDurations.rows) if (t.p90 != null) expect(t.p90).toBeLessThanOrEqual(HOUR);
    // 要点のリンクはすべて詳細ページ(実在)か #... の絞り込み
    for (const k of g) for (const i of k.items) expect(i.href.startsWith('#') || existsSync(join(out, i.href))).toBe(true);
  });
});
