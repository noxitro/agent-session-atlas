// Phase 14: atlas serve の画面からの操作(jobs)と記録の表示(/view/)。子プロセスは差し替えて速く回す(本物の起動は e2e/phase14)。
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from '../src/args.ts';
import { run } from '../src/commands.ts';
import { jobArgs, acquireOutLock, JOB_ENV, JOB_LOCK_FILE, JUDGE_FLOW_TS, MAIN_TS, OutBusyError, parseJobRequest, runningJobIn, type ChildLike, type RunFullFn } from '../src/jobs.ts';
import { startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

const ATLAS = (anonymized: boolean): string =>
  `<!doctype html><html><head><meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"></head><body><script type="application/json" id="atlas-data">{"version":8,"anonymized":${anonymized},"groups":[]}</script></body></html>`;

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.exit(null);
  }
  exit(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('serve の jobs と記録の表示(Phase 14)', () => {
  let dir: string;
  let out: string;
  let notes: string;
  let h: ServeHandle | null = null;
  let calls: { args: string[]; env: NodeJS.ProcessEnv }[];
  let children: FakeChild[];
  let fulls: { id: string; signal: AbortSignal }[];
  let fullImpl: RunFullFn;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-jobs-'));
    out = join(dir, 'out');
    notes = join(dir, 'atlas-notes');
    await mkdir(join(out, 'sessions'), { recursive: true });
    await mkdir(join(out, 'full', 'assets', 's1'), { recursive: true });
    await mkdir(join(out, 'full', 'assets', 's2'), { recursive: true });
    await writeFile(join(out, 'atlas.html'), ATLAS(false));
    await writeFile(
      join(out, 'sessions.json'),
      JSON.stringify({
        sessions: [
          { id: 's1', name: '調べもの <b>', turns: 2, firstUserMessage: 'x' },
          { id: 's2', name: null, turns: 1, firstUserMessage: 'y' },
          { id: 's3', name: '空', turns: 0, firstUserMessage: null },
        ],
      }),
    );
    calls = [];
    children = [];
    fulls = [];
    fullImpl = async (id, ctx) => {
      fulls.push({ id, signal: ctx.signal });
      ctx.log(`全文 ${id}`);
    };
  });
  afterEach(async () => {
    for (const c of children) if (!c.killed) c.exit(0);
    await h?.close();
    h = null;
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (extra: Partial<Parameters<typeof startServe>[0]> = {}): Promise<ServeHandle> => {
    h = await startServe({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を読まない。無ければ設定なし)
      configPath: join(dir, 'atlas.config.json'),
      port: 0,
      open: false,
      jobs: {
        spawn: (args, env) => {
          calls.push({ args, env });
          const c = new FakeChild();
          children.push(c);
          return c;
        },
        env: { ATLAS_TEST_MARK: '1' },
        runFull: (id, ctx) => fullImpl(id, ctx),
      },
      ...extra,
    });
    return h;
  };
  const base = (): string => `http://127.0.0.1:${h!.port}`;
  const json = async (path: string, init: RequestInit = {}, token: string | null = h!.token): Promise<{ status: number; body: any }> => {
    const r = await fetch(base() + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { 'x-atlas-token': token } : {}), ...(init.headers ?? {}) } });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const post = (body: unknown, token: string | null = h!.token, headers: Record<string, string> = {}) => json('/api/jobs', { method: 'POST', body: JSON.stringify(body), headers }, token);
  const current = async (): Promise<any> => (await json('/api/jobs/current')).body;
  const until = async (pred: () => Promise<boolean>, ms = 3000): Promise<void> => {
    const t = Date.now();
    while (!(await pred())) {
      if (Date.now() - t > ms) throw new Error('待ちきれませんでした');
      await sleep(20);
    }
  };

  it('refresh / judge の子プロセスは固定の引数で起動し、同時に 2 つ目は 409。出力は末尾の行としてログに残る', async () => {
    await start();
    expect(await current()).toBeNull();
    const r = await post({ kind: 'refresh' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ kind: 'refresh', state: 'running', exitCode: null, endedAt: null });
    expect(calls.map((c) => c.args)).toEqual([[MAIN_TS, 'all', '--out', out, '--notes-dir', notes]]);
    expect(calls[0].env.ATLAS_TEST_MARK).toBe('1');
    // 実行中の印: 子プロセスには JOB_ENV を渡し(自分の印で止まらない)、out/.job.json に serve の pid を置く
    expect(calls[0].env[JOB_ENV]).toBe('1');
    expect(JSON.parse(await readFile(join(out, JOB_LOCK_FILE), 'utf8'))).toMatchObject({ pid: process.pid, kind: 'refresh' });
    expect((await post({ kind: 'judge', limit: 1, backend: 'copilot-cli' })).status).toBe(409);
    expect((await post({ kind: 'full', id: 's1' })).status).toBe(409);
    expect(calls).toHaveLength(1);
    children[0].stdout.write('一行目\r\n二行');
    children[0].stdout.write('目の続き\n');
    children[0].stderr.write('警告\n');
    children[0].exit(0);
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ state: 'done', exitCode: 0, log: ['一行目', '二行目の続き', '警告'] });
    expect(existsSync(join(out, JOB_LOCK_FILE))).toBe(false);

    expect((await post({ kind: 'judge', limit: 3, backend: 'copilot-cli' })).status).toBe(202);
    expect(calls[1].args).toEqual([JUDGE_FLOW_TS, '--limit', '3', '--backend', 'copilot-cli', '--out', out, '--notes-dir', notes]);
    children[1].exit(1);
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ kind: 'judge', state: 'failed', exitCode: 1, target: { limit: 3, backend: 'copilot-cli' } });
  });

  it('実行中の印: 他のプロセスの印があれば all が止まる。プロセスが無い古い印・自分の印・ジョブの子プロセスでは止まらない', async () => {
    const lock = join(out, JOB_LOCK_FILE);
    expect(runningJobIn(out)).toBeNull();
    await writeFile(lock, JSON.stringify({ pid: process.ppid, kind: 'judge' }));
    expect(runningJobIn(out)).toBe('judge');
    await expect(run({ ...parseCli(['all', '--out', out, '--notes-dir', notes, '--home', join(dir, 'no-home')]) }, () => {})).rejects.toThrow(/画面から実行した処理\(judge\)/);
    process.env[JOB_ENV] = '1';
    try {
      expect(runningJobIn(out)).toBeNull();
    } finally {
      delete process.env[JOB_ENV];
    }
    await writeFile(lock, JSON.stringify({ pid: process.pid, kind: 'judge' }));
    expect(runningJobIn(out)).toBeNull();
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, kind: 'judge' }));
    expect(runningJobIn(out)).toBeNull();
  });

  it('実行中の印は CLI の書き込むコマンドも置く: 別の atlas が持っていれば画面のジョブは 409、CLI も止まる。終われば外し、古い印は取り直す', async () => {
    const lock = join(out, JOB_LOCK_FILE);
    // 別のプロセス(ここでは親プロセスの pid)の CLI が持っている
    await writeFile(lock, JSON.stringify({ pid: process.ppid, kind: 'judge', by: 'cli' }));
    expect(() => acquireOutLock(out, 'all', 'cli')).toThrow(/別の atlas の処理\(judge\)/);
    await expect(run(parseCli(['bundle', '--out', out, '--notes-dir', notes]), () => {})).rejects.toThrow(/別の atlas の処理\(judge\)/);
    await start();
    const r = await post({ kind: 'refresh' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/別の atlas の処理\(judge\)/);
    expect(calls).toHaveLength(0);
    // 読めない印は、書いた直後なら書きかけとみなして止まる
    await writeFile(lock, '');
    expect(() => acquireOutLock(out, 'all', 'cli')).toThrow(OutBusyError);
    // プロセスが無い古い印は消して取り、外すと消える。同じプロセスの入れ子は何もしない
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, kind: 'judge', by: 'cli' }));
    const release = acquireOutLock(out, 'judge', 'cli');
    expect(JSON.parse(await readFile(lock, 'utf8'))).toMatchObject({ pid: process.pid, kind: 'judge', by: 'cli' });
    acquireOutLock(out, 'bundle', 'cli')();
    expect(existsSync(lock)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
    // CLI のコマンドは終われば(失敗しても)印を外す
    await expect(run(parseCli(['judge', 'import', join(dir, 'missing.json'), '--out', out, '--notes-dir', notes]), () => {})).rejects.toThrow();
    expect(existsSync(lock)).toBe(false);
  });

  it('ログは末尾 200 行だけ残す', async () => {
    await start();
    await post({ kind: 'refresh' });
    children[0].stdout.write(Array.from({ length: 250 }, (_, i) => `行 ${i}`).join('\n') + '\n');
    children[0].exit(0);
    await until(async () => (await current()).state === 'done');
    const log = (await current()).log as string[];
    expect(log).toHaveLength(200);
    expect(log[0]).toBe('行 50');
    expect(log.at(-1)).toBe('行 249');
  });

  it('引数の検証: kind・limit・backend・id の不正は 400(知らない id は 404)で、何も起動しない', async () => {
    await start();
    const bad: [unknown, number][] = [
      [{}, 400],
      [{ kind: 'nope' }, 400],
      [{ kind: 'refresh', out: 'C:\\x' }, 400],
      [{ kind: 'judge', backend: 'copilot-cli' }, 400],
      [{ kind: 'judge', limit: -1, backend: 'copilot-cli' }, 400],
      [{ kind: 'judge', limit: 501, backend: 'copilot-cli' }, 400],
      [{ kind: 'judge', limit: 1.5, backend: 'copilot-cli' }, 400],
      [{ kind: 'judge', limit: '10', backend: 'copilot-cli' }, 400],
      [{ kind: 'judge', limit: 10, backend: null }, 400],
      [{ kind: 'judge', limit: 10, backend: '' }, 400],
      [{ kind: 'judge', limit: 10, backend: 'anthropic' }, 400],
      [{ kind: 'judge', limit: 10, backend: 'copilot-cli; calc' }, 400],
      [{ kind: 'judge', limit: 10, backend: 'copilot-cli', only: 's1' }, 400],
      [{ kind: 'full' }, 400],
      [{ kind: 'bundle', perPart: 2 }, 400],
      [{ kind: 'export', id: 's1' }, 400],
      [{ kind: 'full', id: '..' }, 400],
      [{ kind: 'full', id: 'a/b' }, 400],
      [{ kind: 'full', id: 's1 & calc' }, 400],
      [{ kind: 'full', id: 'nope' }, 404],
    ];
    for (const [body, status] of bad) expect({ body, status: (await post(body)).status }).toEqual({ body, status });
    expect((await json('/api/jobs', { method: 'POST', body: '[1]' })).status).toBe(400);
    expect(calls).toEqual([]);
    expect(fulls).toEqual([]);
    // 0 件(画面から 0 は送らないが、CLI の --limit 0 と同じく受ける)と上限ちょうど
    expect(parseJobRequest({ kind: 'judge', limit: 0, backend: 'copilot-cli' }, () => true)).toEqual({ kind: 'judge', limit: 0, backend: 'copilot-cli' });
    // backend は省ける(画面は送らない)。無ければ copilot-cli
    expect(parseJobRequest({ kind: 'judge', limit: 10 }, () => true)).toEqual({ kind: 'judge', limit: 10, backend: 'copilot-cli' });
    expect(parseJobRequest({ kind: 'judge', limit: 500, backend: 'copilot-cli' }, () => true)).toEqual({ kind: 'judge', limit: 500, backend: 'copilot-cli' });
  });

  it('チャットでの判定: 添付ファイルの作成と反映は固定の引数で起動し、一覧・本文・取り込みは manifest と judgments.json に従う', async () => {
    await start();
    expect((await post({ kind: 'bundle' })).status).toBe(202);
    expect(calls[0].args).toEqual([MAIN_TS, 'bundle', '--unjudged', '--out', out, '--notes-dir', notes]);
    // 実行中は取り込めない(judgments.json に書くので)
    expect((await json('/api/judge/import', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(409);
    children[0].exit(0);
    await until(async () => (await current()).state !== 'running');
    expect((await post({ kind: 'export' })).status).toBe(202);
    expect(calls[1].args).toEqual([MAIN_TS, 'export', '--out', out, '--notes-dir', notes]);
    children[1].exit(0);
    await until(async () => (await current()).state !== 'running');

    // canAutomate: M365 Copilot の自動操作を出すか(サーバが Windows のとき)
    expect((await json('/api/judge/parts')).body).toEqual({ exists: false, canAutomate: process.platform === 'win32' });
    await mkdir(join(out, 'bundle', 'parts'), { recursive: true });
    await writeFile(join(out, 'bundle', 'parts', 'part-01.md'), '# 指示\nパケット s1 s2');
    await writeFile(join(out, 'bundle', 'secret.md'), '出さない');
    await writeFile(
      join(out, 'bundle', 'manifest.json'),
      JSON.stringify({ version: 1, generatedAt: '2026-11-05T00:00:00.000Z', scope: { unjudged: 'yes' }, count: 2, sessions: [], parts: [{ path: 'parts/part-01.md', sessions: ['s1', 's2'], bytes: 30 }, { path: 'parts/part-02.md', sessions: ['s3'], bytes: 9 }] }),
    );
    // 消えたファイル(part-02)は一覧に出さない
    expect((await json('/api/judge/parts')).body).toEqual({
      exists: true,
      generatedAt: '2026-11-05T00:00:00.000Z',
      unjudgedOnly: true,
      count: 2,
      parts: [{ path: 'bundle/parts/part-01.md', name: 'part-01.md', sessions: 2, judged: 0, bytes: 30 }],
      canAutomate: process.platform === 'win32',
    });
    expect((await json('/api/judge/parts/part-01.md')).body).toEqual({ name: 'part-01.md', text: '# 指示\nパケット s1 s2' });
    for (const bad of ['part-02.md', '..%2Fsecret.md', 'secret.md']) expect({ bad, status: (await json(`/api/judge/parts/${bad}`)).status }).toEqual({ bad, status: 404 });

    const importText = (text: unknown, token: string | null = h!.token) => json('/api/judge/import', { method: 'POST', body: JSON.stringify({ text }) }, token);
    expect((await importText('')).status).toBe(400);
    expect((await importText('JSON の無い返答')).body.error).toMatch(/JSON を取り出せません/);
    const bad = await importText('```json\n{"items":[{"sessionId":"s1"}]}\n```');
    expect(bad.status).toBe(400);
    expect(bad.body.problems.length).toBeGreaterThan(0);
    expect(existsSync(join(out, 'judgments.json'))).toBe(false);

    const item = {
      sessionId: 's1',
      taskCategory: 'feature',
      taskSummary: '要約',
      humanEffort: { hours: 2, low: 1, high: 4, confidence: 0.5, rationale: '根拠' },
      aiOutcome: { completed: true, quality: 4, rework: 1, rationale: '成果' },
      instructionsEffect: { score: 1, evidence: 'e' },
      wikiEffect: { score: 0, evidence: '参照なし' },
      skillsAgentsEffect: { score: 0, evidence: '参照なし' },
    };
    const reply = `判定しました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'm365', ranAt: null }, items: [item, { ...item, sessionId: 'zz' }] })}\n\`\`\``;
    expect((await importText(reply, null)).status).toBe(403);
    const ok = await importText(reply);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ imported: 2, overwritten: 0, unknownIds: ['zz'], total: 2 });
    expect(ok.body.parts.parts[0]).toMatchObject({ name: 'part-01.md', judged: 1 });
    expect((await json('/api/jobs/judge-preview')).body).toMatchObject({ eligible: 2, judged: 1, pending: 1 });
    expect((await json('/api/judge/parts', {}, null)).status).toBe(403);
  });

  it('403: token なし・違う token・他オリジン・別の Host。伏せ字版では jobs も表示も 403', async () => {
    await start();
    expect((await post({ kind: 'refresh' }, null)).status).toBe(403);
    expect((await post({ kind: 'refresh' }, 'wrong')).status).toBe(403);
    expect((await post({ kind: 'refresh' }, h!.token, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ kind: 'refresh' }, h!.token, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await json('/api/jobs/current', {}, null)).status).toBe(403);
    expect((await json('/api/jobs/current/cancel', { method: 'POST' }, null)).status).toBe(403);
    expect((await json('/api/jobs/judge-preview', {}, null)).status).toBe(403);
    expect((await json('/api/view/s1?kind=transcript', {}, null)).status).toBe(403);
    expect((await fetch(`${base()}/view/s1?kind=transcript`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const hostStatus = (path: string, method = 'GET'): Promise<number> =>
      new Promise((ok, ng) => {
        const r = request({ port: h!.port, host: '127.0.0.1', path, method, headers: { host: `evil.example:${h!.port}`, 'x-atlas-token': h!.token, 'content-type': 'application/json' } }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        });
        r.on('error', ng);
        r.end(method === 'POST' ? JSON.stringify({ kind: 'refresh' }) : undefined);
      });
    expect(await hostStatus('/api/jobs', 'POST')).toBe(403);
    expect(await hostStatus('/view/s1')).toBe(403);
    expect(calls).toEqual([]);

    await h!.close();
    await writeFile(join(out, 'atlas.html'), ATLAS(true));
    await start();
    expect((await post({ kind: 'refresh' })).status).toBe(403);
    expect((await json('/api/jobs/current')).status).toBe(403);
    expect((await json('/api/view/s1?kind=transcript')).status).toBe(403);
    expect((await fetch(`${base()}/view/s1?kind=transcript`)).status).toBe(403);
    expect((await fetch(`${base()}/api/session-tools.js`)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('cancel: 子プロセスを止めて canceled。動いていなければ 409。全文は signal で止める', async () => {
    await start();
    expect((await json('/api/jobs/current/cancel', { method: 'POST' })).status).toBe(409);
    await post({ kind: 'refresh' });
    const c = await json('/api/jobs/current/cancel', { method: 'POST' });
    expect(c.status).toBe(200);
    expect(children[0].killed).toBe(true);
    await until(async () => (await current()).state !== 'running');
    expect((await current()).state).toBe('canceled');

    // 止める操作が間に合わず、最後まで終わった(終了コード 0)ものは完了のまま(結果は書かれている)
    await post({ kind: 'bundle' });
    children[1].kill = () => {};
    expect((await json('/api/jobs/current/cancel', { method: 'POST' })).status).toBe(200);
    children[1].exit(0);
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ kind: 'bundle', state: 'done', exitCode: 0 });

    let release!: () => void;
    fullImpl = (id, ctx) =>
      new Promise((ok, ng) => {
        fulls.push({ id, signal: ctx.signal });
        ctx.signal.addEventListener('abort', () => ng(new Error('取り消しました')));
        release = ok;
      });
    expect((await post({ kind: 'full', id: 's2' })).status).toBe(202);
    expect(calls).toHaveLength(2); // 全文はサーバ内(子プロセスを起動しない)
    expect(fulls.map((f) => f.id)).toEqual(['s2']);
    await json('/api/jobs/current/cancel', { method: 'POST' });
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ kind: 'full', state: 'canceled', target: { id: 's2' } });
    void release;
  });

  it('full: runFull が成功すれば done、失敗すれば failed で理由がログに出る', async () => {
    await start();
    expect((await post({ kind: 'full', id: 's1' })).status).toBe(202);
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ kind: 'full', state: 'done', log: ['全文 s1'] });
    fullImpl = async () => {
      throw new Error('スナップショットがありません');
    };
    await post({ kind: 'full', id: 's1' });
    await until(async () => (await current()).state !== 'running');
    expect(await current()).toMatchObject({ state: 'failed', log: ['失敗しました: スナップショットがありません'] });
  });

  it('judge-preview: 依頼の記録があるセッションのうち judgments.json に無いもの', async () => {
    await start();
    // 設定ファイルが無ければ、判定に使うモデルは Copilot の既定(AI クレジットを使う)
    expect((await json('/api/jobs/judge-preview')).body).toEqual({ eligible: 2, judged: 0, pending: 2, model: null, byok: false, modelError: null });
    await writeFile(join(dir, 'atlas.config.json'), JSON.stringify({ judgeModel: 'anthropic/claude-sonnet-5-5' }));
    expect((await json('/api/jobs/judge-preview')).body).toMatchObject({ pending: 2, model: 'anthropic/claude-sonnet-5-5', byok: true, modelError: null });
    await writeFile(join(dir, 'atlas.config.json'), '{ broken');
    expect((await json('/api/jobs/judge-preview')).body).toMatchObject({ pending: 2, model: null, byok: false, modelError: expect.stringMatching(/atlas\.config\.json を読めません/) });
    // 画面から動かす処理(子プロセス)にも、サーバと同じ設定ファイルを渡す
    await post({ kind: 'judge', limit: 1, backend: 'copilot-cli' });
    expect(calls.at(-1)!.env.ATLAS_CONFIG).toBe(join(dir, 'atlas.config.json'));
    children.at(-1)!.exit(0);
    await writeFile(join(dir, 'atlas.config.json'), '{}');
    await writeFile(join(out, 'judgments.json'), JSON.stringify({ schemaVersion: 1, items: [{ sessionId: 's1' }, { sessionId: 'zzz' }] }));
    expect((await json('/api/jobs/judge-preview')).body).toMatchObject({ eligible: 2, judged: 1, pending: 1 });
  });

  it('ジョブの実行中は heartbeat が途切れても止まらず、終わってから idleMs で止まる', async () => {
    // ジョブを始めてから heartbeat を送る。先に heartbeat を送ると、ジョブの依頼が 150ms のうちに届かなければ
    // サーバが先に止まる(負荷の高いときに時々落ちた)。最初の heartbeat を待つ時間も、同じ理由で短くしない
    await start({ idleMs: 150, firstHeartbeatMs: 600_000 });
    await post({ kind: 'refresh' });
    await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } });
    await sleep(500);
    // 猶予(150ms)の 3 倍待っても動いている
    expect((await json('/api/jobs/current')).body.state).toBe('running');
    const t = performance.now();
    children[0].exit(0);
    const reason = await h!.done;
    expect(reason).toMatch(/heartbeat が途切れた/);
    expect(performance.now() - t).toBeGreaterThan(100);
    h = null;
  });

  it('ジョブの実行中に画面がすべて閉じられたら、終わってからは短い猶予(byeGraceMs)で止まる(30 分の保険を張り直さない)', async () => {
    await start({ idleMs: 600_000, byeGraceMs: 150, firstHeartbeatMs: 600_000 });
    const hdr = (seq: number) => ({ 'x-atlas-token': h!.token, 'x-atlas-client': 'p1', 'x-atlas-seq': String(seq) });
    await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: hdr(1) });
    await post({ kind: 'refresh' });
    await fetch(`${base()}/api/bye`, { method: 'POST', headers: hdr(2) });
    await sleep(500);
    // 猶予(150ms)を過ぎてもジョブの間は止まらない
    expect((await json('/api/jobs/current')).body.state).toBe('running');
    const t = performance.now();
    children[0].exit(0);
    expect(await h!.done).toBe('画面がすべて閉じられた');
    expect(performance.now() - t).toBeLessThan(5_000);
    h = null;
  });

  it('集計し直している間の 404 は「集計し直している最中」の文面', async () => {
    await start();
    expect(await (await fetch(`${base()}/sessions/nope.html`)).text()).toBe('ありません');
    await post({ kind: 'refresh' });
    const r = await fetch(`${base()}/sessions/nope.html`);
    expect(r.status).toBe(404);
    expect(await r.text()).toMatch(/集計し直している最中/);
    expect((await json('/api/view/s1?kind=transcript')).body.error).toMatch(/集計し直している最中/);
  });

  describe('記録の表示', () => {
    const MD = [
      '# セッション記録: テスト',
      '',
      '## 経過',
      '',
      '<script>window.__pwned = 1</script>',
      '',
      '<img src=x onerror="window.__pwned=2">',
      '',
      '[危ない](javascript:alert(1)) と [外](https://example.com/a) と [相対](../../secret.txt)',
      '',
      '![外部の画像](https://example.com/x.png)',
      '',
      '```',
      '<b>コードの中</b>',
      '```',
      '',
      '## 変更したファイル',
    ].join('\n');
    beforeEach(async () => {
      await writeFile(join(out, 'sessions', 's1.md'), MD);
      await writeFile(join(out, 'full', 'assets', 's1', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(join(out, 'full', 'assets', 's1', 'data.bin'), 'x');
      await writeFile(join(out, 'full', 'assets', 's1', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>');
      await writeFile(join(out, 'full', 'assets', 's1', 'page.html'), '<script>bad()</script>');
      await writeFile(join(out, 'full', 'assets', 's2', 'b.png'), 'x');
      await writeFile(join(out, 'secret.png'), 'x');
      await writeFile(
        join(out, 'full', 's1.md'),
        ['# 全文記録', '', '![画像](assets/s1/a.png)', '', '[書き出したファイル](assets/s1/data.bin)', '', '[svg の画像](assets/s1/icon.svg) と ![svg](assets/s1/icon.svg) と [html](assets/s1/page.html)', '', '![別のセッション](assets/s2/b.png)', '', '![外へ](../secret.png)', '', '![無い](assets/s1/none.png)', '', '<script>bad()</script>', '', '- **session.start** <small>id e1</small> と <small onclick="bad()">属性つき</small> と <SMALL>大文字</SMALL>', '', '<details><summary>要約</summary>', '', '> 要約の本文', '', '</details>'].join('\n'),
      );
    });

    it('殻は本文を持たず token を埋める。本文は token 付きの API から', async () => {
      await start();
      const shell = await fetch(`${base()}/view/s1?kind=transcript`);
      expect(shell.status).toBe(200);
      const html = await shell.text();
      expect(html).toContain(`content="${h!.token}"`);
      expect(html).not.toContain('__pwned');
      expect(html).toContain('../sessions/s1.html');
      expect(html).toContain('../sessions/s1.md');
      expect((await fetch(`${base()}/view/s1?kind=nope`)).status).toBe(400);
      expect((await fetch(`${base()}/view/..%2Fx`)).status).toBe(400);
      expect((await fetch(`${base()}/api/session-tools.js`)).status).toBe(200);
    });

    it('セッション記録: 生の HTML は文字のまま、javascript: と相対のリンクは文字だけ、外部の画像は読まない', async () => {
      await start();
      const r = await json('/api/view/s1?kind=transcript');
      expect(r.status).toBe(200);
      const { html, headings, title, docTitle, tooLarge, size } = r.body;
      expect({ title, docTitle, tooLarge }).toEqual({ title: '調べもの <b>', docTitle: 'セッション記録: テスト', tooLarge: false });
      expect(size).toBe(Buffer.byteLength(MD));
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('&lt;script&gt;window.__pwned = 1&lt;/script&gt;');
      expect(html).not.toMatch(/<img/i);
      expect(html).toContain('&lt;img src=x onerror=');
      expect(html).not.toMatch(/href="javascript/i);
      expect(html).toContain('href="https:&#47;&#47;example.com/a"');
      expect(html).not.toContain('secret.txt"');
      expect(html).toContain('外部の画像(読み込みません)');
      expect(html).toContain('&lt;b&gt;コードの中&lt;/b&gt;');
      // 先頭の # はページの表題に回し(本文に h1 を出さない)、## を h2 にして id を付け目次にする
      expect(html).not.toMatch(/<h1/);
      expect(html).not.toContain('セッション記録: テスト');
      expect(html).toContain('<h2 id="h-1">経過</h2>');
      expect(headings).toEqual([
        { id: 'h-1', text: '経過' },
        { id: 'h-2', text: '変更したファイル' },
      ]);
    });

    it('全文記録: そのセッションの assets/ の実在するファイルだけを通す(画像は img、他はリンク)', async () => {
      await start();
      const { html } = (await json('/api/view/s1?kind=full')).body;
      expect(html).toContain('<img src="../full/assets/s1/a.png" alt="画像">');
      expect(html).toContain('<a href="../full/assets/s1/data.bin">書き出したファイル</a>');
      expect(html.match(/<img/g)).toHaveLength(1);
      // svg・html はサーバのオリジンで script が動きうるので、リンクにも画像にもしない
      expect(html).not.toMatch(/href="[^"]*icon\.svg"|src="[^"]*icon\.svg"|href="[^"]*page\.html"/);
      // 静的ファイルとして直接開かれても script を動かさない(CSP sandbox)。HTML は他のサイトの枠に入れさせない
      // (AdGuard などの手元の通信フィルタは 127.0.0.1 の応答の CSP にも書き足すことがあるので、先頭の指示だけを見る)
      const svg = await fetch(`${base()}/full/assets/s1/icon.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-security-policy')).toMatch(/^sandbox\b/);
      expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
      const shell = await fetch(`${base()}/view/s1?kind=full`);
      expect(shell.headers.get('x-frame-options')).toBe('DENY');
      expect(shell.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
      const app = await fetch(`${base()}/atlas.html`);
      expect(app.headers.get('x-frame-options')).toBe('DENY');
      expect(await app.text()).toContain(`content="${h!.token}"`);
      // atlas の画面以外の .html(snapshot の写しなど、セッション由来でありうる)には token を入れず、sandbox で返す
      await mkdir(join(out, 'snapshot', 'session-state', 's1', 'files'), { recursive: true });
      await writeFile(join(out, 'snapshot', 'session-state', 's1', 'files', 'page.html'), `<meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"><script>bad()</script>`);
      const copied = await fetch(`${base()}/snapshot/session-state/s1/files/page.html`);
      expect(copied.headers.get('content-security-policy')).toMatch(/^sandbox\b/);
      expect(await copied.text()).not.toContain(h!.token);
      expect(html).not.toContain('assets/s2/b.png"');
      expect(html).not.toContain('secret.png"');
      expect(html).toContain('画像を表示できません: ../secret.png');
      expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
      // atlas 自身が書く属性の無い small / details / summary だけはタグとして描き、属性つきや他の形は文字のまま
      expect(html).toContain('<small>id e1</small>');
      expect(html).toContain('&lt;small onclick=&quot;bad()&quot;&gt;属性つき</small>');
      expect(html).toContain('&lt;SMALL&gt;大文字&lt;/SMALL&gt;');
      expect(html).not.toMatch(/<small [^>]*>/);
      expect(html).toMatch(/<details><summary>要約<\/summary>\s*<blockquote>\s*<p>要約の本文<\/p>\s*<\/blockquote>\s*<\/details>/);
      expect((await json('/api/view/s2?kind=full')).status).toBe(404);
      expect((await json('/api/view/nope?kind=full')).status).toBe(404);
      expect((await json('/api/view/s1?kind=raw')).status).toBe(400);
    });

    it('上限を超える .md は描かず、大きさと .md の場所だけ返す', async () => {
      await start({ viewLimit: 64 });
      const r = await json('/api/view/s1?kind=transcript');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ tooLarge: true, limit: 64, size: Buffer.byteLength(MD), mdHref: '../sessions/s1.md' });
      expect(r.body.html).toBeUndefined();
    });
  });

  it('集計し直すときの引数: 別のフォルダを開いたサーバ(home)は、同じフォルダを --home にして読み直す', () => {
    const p = { outDir: 'o', notesDir: 'n', main: 'main.ts' };
    expect(jobArgs({ kind: 'refresh' }, p)).toEqual(['main.ts', 'all', '--out', 'o', '--notes-dir', 'n']);
    expect(jobArgs({ kind: 'refresh' }, { ...p, home: '/srv/logs/person-a' })).toEqual(['main.ts', 'all', '--home', '/srv/logs/person-a', '--out', 'o', '--notes-dir', 'n']);
    // 集計し直す以外は、出力先にあるものだけを使う
    expect(jobArgs({ kind: 'export' }, { ...p, home: '/srv/logs' })).toEqual(['main.ts', 'export', '--out', 'o', '--notes-dir', 'n']);
  });
});
