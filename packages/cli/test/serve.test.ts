// atlas serve(Phase 10 第 2 段): 静的配信・API・token・パスの正規化・heartbeat による終了
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeStamp } from '../../core/src/code-stamp.ts';
import { BYE_GRACE_MS, DEFAULT_IDLE_MS, findRunningServer, SERVE_STATE_FILE, startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

const ATLAS = (anonymized: boolean): string =>
  `<!doctype html><html><head><meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"></head><body><script type="application/json" id="atlas-data">{"version":5,"anonymized":${anonymized},"groups":[]}</script></body></html>`;

describe('serve', () => {
  let dir: string;
  let out: string;
  let notes: string;
  let h: ServeHandle | null = null;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-serve-'));
    out = join(dir, 'out');
    notes = join(dir, 'atlas-notes');
    await mkdir(join(out, 'sessions'), { recursive: true });
    await writeFile(join(out, 'atlas.html'), ATLAS(false));
    await writeFile(join(out, 'sessions', 'a.html'), '<p>a</p>');
    await writeFile(join(dir, 'secret.txt'), 'x');
  });
  afterEach(async () => {
    await h?.close();
    h = null;
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (extra: Partial<Parameters<typeof startServe>[0]> = {}): Promise<ServeHandle> => {
    h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, ...extra });
    return h;
  };
  const base = (): string => `http://127.0.0.1:${h!.port}`;
  const json = async (path: string, init: RequestInit = {}, token: string | null = h!.token): Promise<{ status: number; body: any }> => {
    const r = await fetch(base() + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-atlas-token': token } : {}), ...(init.headers ?? {}) },
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };

  it('127.0.0.1 に bind し、out/ を配信して HTML には token を差し込む。out/ の外・ディレクトリ・.serve.json は 404', async () => {
    await start();
    expect(h!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/atlas\.html$/);
    const r = await fetch(h!.url);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`content="${h!.token}"`);
    expect(html).not.toContain(TOKEN_PLACEHOLDER);
    expect((await fetch(`${base()}/sessions/a.html`)).status).toBe(200);
    expect((await fetch(`${base()}/`, { redirect: 'manual' })).status).toBe(302);
    for (const p of ['/sessions/', '/sessions', '/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/nope.html', `/${SERVE_STATE_FILE}`]) {
      expect({ p, status: (await fetch(base() + p)).status }).toEqual({ p, status: 404 });
    }
    // .serve.json には port と pid があり token は無い
    const st = JSON.parse(await readFile(join(out, SERVE_STATE_FILE), 'utf8'));
    expect(st).toMatchObject({ port: h!.port, pid: process.pid });
    expect(JSON.stringify(st)).not.toContain(h!.token);
    expect(await findRunningServer(out)).toEqual({ port: h!.port, pid: process.pid, code: codeStamp() });
  });

  it('版の目印: どの応答にも起動したときの目印(x-atlas-code)を付ける。目印を返さない古いサーバの代わり(null)では付けない', async () => {
    await start();
    const beat = await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } });
    expect(beat.headers.get('x-atlas-code')).toBe(codeStamp());
    expect((await fetch(h!.url)).headers.get('x-atlas-code')).toBe(codeStamp());
    expect((await fetch(`${base()}/api/nothing`)).headers.get('x-atlas-code')).toBe(codeStamp());
    await h!.close();
    await start({ codeStamp: 'old' });
    expect(await findRunningServer(out)).toMatchObject({ code: 'old' });
    await h!.close();
    await start({ codeStamp: null });
    expect((await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } })).headers.has('x-atlas-code')).toBe(false);
    expect(await findRunningServer(out)).toMatchObject({ code: null });
  });

  it('メモの API: 読みは token 無し、書きは token が要る。rev の競合は 409 で書かない。/api/state に概要が出る', async () => {
    await start();
    const put = (id: string, text: string, rev: string, token: string | null = h!.token) => json(`/api/memos/${id}`, { method: 'PUT', body: JSON.stringify({ text, rev }) }, token);
    expect((await json('/api/memos/s1', {}, null)).body).toEqual({ text: '', rev: '', html: '', updatedAt: null });
    expect((await put('s1', '# 見出し', '', null)).status).toBe(403);
    const saved = await put('s1', '# 見出し', '');
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ text: '# 見出し', html: expect.stringContaining('<h3>見出し</h3>') });
    expect(await readFile(join(notes, 'memos', 's1.md'), 'utf8')).toBe('# 見出し');
    expect((await json('/api/state', {}, null)).body.memos.s1).toMatchObject({ excerpt: '見出し', images: 0 });

    await writeFile(join(notes, 'memos', 's1.md'), '手で更新');
    const stale = await put('s1', '上書き', saved.body.rev);
    expect(stale.status).toBe(409);
    expect(await readFile(join(notes, 'memos', 's1.md'), 'utf8')).toBe('手で更新');
    expect((await put('s1', '上書き', stale.body.rev)).status).toBe(200);

    const del = await put('s1', '', (await json('/api/memos/s1')).body.rev);
    expect(del.body).toEqual({ text: '', rev: '', html: '', updatedAt: null });
    expect(existsSync(join(notes, 'memos', 's1.md'))).toBe(false);
    expect((await json('/api/memos/s1', { method: 'PUT', body: JSON.stringify({ text: 1, rev: '' }) })).status).toBe(400);
    expect((await json('/api/memos/s1', { method: 'DELETE' })).status).toBe(405);
  });

  it('メモの API: 同じ rev の同時保存は片方だけ通り、もう片方は 409(後の書き込みが前を消さない)', async () => {
    await start();
    const first = await json('/api/memos/s1', { method: 'PUT', body: JSON.stringify({ text: '元', rev: '' }) });
    const put = (text: string) => json('/api/memos/s1', { method: 'PUT', body: JSON.stringify({ text, rev: first.body.rev }) });
    const rs = await Promise.all(['A', 'B', 'C', 'D'].map(put));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const won = rs.find((r) => r.status === 200)!;
    expect(await readFile(join(notes, 'memos', 's1.md'), 'utf8')).toBe(won.body.text);
    expect(await readdir(join(notes, 'memos'))).toEqual(['s1.md']);
  });

  it('Host が自分でない要求には静的ページも API も応えない(DNS rebinding)', async () => {
    await start();
    const status = (path: string, host: string): Promise<number> =>
      new Promise((ok, ng) => {
        const r = request({ port: h!.port, host: '127.0.0.1', path, headers: { host } }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        });
        r.on('error', ng);
        r.end();
      });
    expect(await status('/atlas.html', 'evil.example')).toBe(403);
    expect(await status('/api/memos/s1', `evil.example:${h!.port}`)).toBe(403);
    expect(await status('/api/memos/s1', `localhost:${h!.port}`)).toBe(200);
    expect(await status('/atlas.html', `127.0.0.1:${h!.port}`)).toBe(200);
  });

  it('メモの API: 置き場の外に出る id は 400。画像は token・形式・上限を見る', async () => {
    // 同じプロセスの fetch で数 MB を送ると Windows で止まるので、上限を小さくして境界だけ見る(実際の 10MB は別プロセスで実測、docs/PLAN.md)
    await start({ memoImageLimit: 64 });
    // .. と %2e%2e は URL の正規化で /api/ になる(404)。どちらでも置き場の外には出ない
    for (const id of ['..', '%2e%2e']) expect({ id, status: (await json(`/api/memos/${id}`)).status }).toEqual({ id, status: 404 });
    for (const id of ['..%2Fsecret', 'a%2Fb', '%E0%A4%A', '.hidden']) expect({ id, status: (await json(`/api/memos/${id}`)).status }).toEqual({ id, status: 400 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const post = (body: Buffer, token: string | null = h!.token) => fetch(`${base()}/api/memos/s1/images`, { method: 'POST', body, headers: { 'content-type': 'image/png', ...(token ? { 'x-atlas-token': token } : {}) } });
    expect((await post(png, null)).status).toBe(403);
    expect((await post(Buffer.from('<svg/>'))).status).toBe(415);
    expect((await post(Buffer.alloc(65))).status).toBe(413);
    const ok = await post(png);
    expect(ok.status).toBe(201);
    const { name, markdown } = (await ok.json()) as { name: string; markdown: string };
    expect(markdown).toBe(`![画像](s1/${name})`);
    const saved = await json('/api/memos/s1', { method: 'PUT', body: JSON.stringify({ text: markdown, rev: '' }) });
    expect(saved.body.html).toContain('src="data:image/png;base64,');
  });

  it('編集の script は serve だけが配り、伏せ字版ではメモの API も script も 403', async () => {
    await start();
    const js = await fetch(`${base()}/api/memo-editor.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toContain('../api/memos/');
    await h!.close();
    await writeFile(join(out, 'atlas.html'), ATLAS(true));
    await start();
    expect((await fetch(`${base()}/api/memo-editor.js`)).status).toBe(403);
    expect((await json('/api/memos/s1')).status).toBe(403);
    expect((await json('/api/memos/s1', { method: 'PUT', body: JSON.stringify({ text: 'x', rev: '' }) })).status).toBe(403);
  });

  it('API: 読みは token 無しで可、書きは token が要る。作成 / 改名 / 削除が groups.json に反映され、同名は 409、壊れたファイルは上書きしない', async () => {
    await start();
    const s0 = await json('/api/state', {}, null);
    expect(s0.status).toBe(200);
    expect(s0.body).toMatchObject({ version: 1, groups: [], exists: false, warnings: [], notesDir: notes });
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'a', note: '', ids: ['1'] }) }, null)).status).toBe(403);
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'a', note: '', ids: ['1'] }) }, 'wrong')).status).toBe(403);
    const c = await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: ' a ', note: 'n', ids: ['1', '2', '1'] }) });
    expect(c.status).toBe(201);
    expect(c.body.group).toEqual({ name: 'a', note: 'n', ids: ['1', '2'] });
    expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8'))).toEqual({ version: 1, groups: [{ name: 'a', note: 'n', ids: ['1', '2'] }] });
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'a', ids: [] }) })).status).toBe(409);
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: '', ids: [] }) })).status).toBe(400);
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'b', ids: 'x' }) })).status).toBe(400);
    expect((await json('/api/groups', { method: 'POST', body: '{oops' })).status).toBe(400);
    const c2 = await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'b', ids: ['3'] }) });
    expect(c2.status).toBe(201);
    expect((await json('/api/groups/a', { method: 'PUT', body: JSON.stringify({ name: 'b' }) })).status).toBe(409);
    const u = await json(`/api/groups/${encodeURIComponent('a')}`, { method: 'PUT', body: JSON.stringify({ name: 'A', note: 'nn' }) });
    expect(u.status).toBe(200);
    expect(u.body.group).toEqual({ name: 'A', note: 'nn', ids: ['1', '2'] });
    // ids だけの更新(追加・除外は画面側の純関数で決めて PUT する)。空にしても消えない
    const u2 = await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ ids: ['1', '2', '9', '9'] }) });
    expect(u2.body.group).toEqual({ name: 'A', note: 'nn', ids: ['1', '2', '9'] });
    const u3 = await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ ids: [] }) });
    expect(u3.status).toBe(200);
    expect(u3.body.group).toEqual({ name: 'A', note: 'nn', ids: [] });
    expect((await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ ids: ['1', '2'] }) })).status).toBe(200);
    // 差分(add / remove)はサーバが読み直した最新の ids に適用する: 画面を開いたまま CLI で足した x が、画面からの add で消えない
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'A', note: 'nn', ids: ['1', '2', 'x'] }, { name: 'b', note: '', ids: ['3'] }] }));
    const d1 = await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ add: ['y', '2', 'y'] }) });
    expect(d1.status).toBe(200);
    expect(d1.body).toMatchObject({ added: 1, dup: 1, removed: 0, group: { name: 'A', ids: ['1', '2', 'x', 'y'] } });
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'A', note: 'nn', ids: ['1', '2', 'x', 'y', 'z'] }, { name: 'b', note: '', ids: ['3'] }] }));
    const d2 = await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ remove: ['y', 'nope'] }) });
    expect(d2.body).toMatchObject({ added: 0, dup: 0, removed: 1, group: { name: 'A', ids: ['1', '2', 'x', 'z'] } });
    expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8')).groups[0].ids).toEqual(['1', '2', 'x', 'z']);
    expect((await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ add: ['q'], ids: ['1'] }) })).status).toBe(400);
    expect((await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ add: 'q' }) })).status).toBe(400);
    // 全置換に戻す(以降の検査の前提)
    expect((await json(`/api/groups/A`, { method: 'PUT', body: JSON.stringify({ ids: ['1', '2'] }) })).status).toBe(200);
    expect((await json('/api/groups/zzz', { method: 'PUT', body: JSON.stringify({ note: '' }) })).status).toBe(404);
    expect((await json('/api/groups/zzz', { method: 'DELETE' })).status).toBe(404);
    const d = await json('/api/groups/b', { method: 'DELETE' });
    expect(d.status).toBe(200);
    expect(d.body.groups).toEqual([{ name: 'A', note: 'nn', ids: ['1', '2'] }]);
    expect((await json('/api/state', {}, null)).body.groups).toEqual([{ name: 'A', note: 'nn', ids: ['1', '2'] }]);
    // 壊れたファイルは読みでは警告、書きでは 409 で上書きしない
    await writeFile(join(notes, 'groups.json'), '{ broken');
    expect((await json('/api/state', {}, null)).body.warnings).toHaveLength(1);
    const broken = await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'c', ids: [] }) });
    expect(broken.status).toBe(409);
    expect(broken.body.error).toMatch(/書き換えません/);
    expect(await readFile(join(notes, 'groups.json'), 'utf8')).toBe('{ broken');
    expect((await json('/api/nope', {}, null)).status).toBe(404);
    expect((await json('/api/groups', { method: 'PATCH' })).status).toBe(405);
  });

  it('API: 同時に来た変更は順番に適用し、どれも消えない(一時ファイルも残さない)', async () => {
    await start();
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'g', ids: [] }) })).status).toBe(201);
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const rs = await Promise.all([
      ...ids.map((id) => json('/api/groups/g', { method: 'PUT', body: JSON.stringify({ add: [id] }) })),
      ...['h1', 'h2', 'h3'].map((name) => json('/api/groups', { method: 'POST', body: JSON.stringify({ name, ids: [] }) })),
    ]);
    expect(rs.map((r) => r.status)).toEqual([...ids.map(() => 200), 201, 201, 201]);
    const saved = JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8')).groups as { name: string; ids: string[] }[];
    expect(saved.map((g) => g.name).sort()).toEqual(['g', 'h1', 'h2', 'h3']);
    expect([...saved.find((g) => g.name === 'g')!.ids].sort()).toEqual([...ids].sort());
    expect((await readdir(notes)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('同一オリジン以外(Sec-Fetch-Site / Origin)は 403。伏せ字版では heartbeat 以外の API が 403', async () => {
    await start();
    expect((await json('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } }, null)).status).toBe(403);
    expect((await json('/api/state', { headers: { 'sec-fetch-site': 'same-site' } }, null)).status).toBe(403);
    expect((await json('/api/state', { headers: { 'sec-fetch-site': 'same-origin' } }, null)).status).toBe(200);
    expect((await json('/api/state', { headers: { origin: 'http://evil.example' } }, null)).status).toBe(403);
    expect((await json('/api/state', { headers: { origin: `http://127.0.0.1:${h!.port}` } }, null)).status).toBe(200);
    expect((await fetch(`${base()}/api/heartbeat`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } })).status).toBe(204);
    // 伏せ字版に差し替える(mtime で読み直す)
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(out, 'atlas.html'), ATLAS(true));
    expect((await json('/api/state', {}, null)).status).toBe(403);
    expect((await json('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'a', ids: [] }) })).status).toBe(403);
    expect((await fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } })).status).toBe(204);
  });

  it('heartbeat: 最初が来なければ firstHeartbeatMs で、来た後は最後から idleMs で終了し、.serve.json を消す', async () => {
    await start({ firstHeartbeatMs: 300, idleMs: 400 });
    const t0 = performance.now();
    const beat = (): Promise<Response> => fetch(`${base()}/api/heartbeat`, { method: 'POST', headers: { 'x-atlas-token': h!.token } });
    await beat();
    await new Promise((r) => setTimeout(r, 250));
    await beat();
    await new Promise((r) => setTimeout(r, 250));
    await beat();
    // 最初の 300ms は越えているが heartbeat が続いているので生きている
    expect((await fetch(`${base()}/api/state`)).status).toBe(200);
    const reason = await h!.done;
    expect(performance.now() - t0).toBeGreaterThan(500 + 400 - 50);
    expect(reason).toMatch(/heartbeat が途切れた/);
    expect(existsSync(join(out, SERVE_STATE_FILE))).toBe(false);
    expect(await findRunningServer(out)).toBeNull();
    await expect(fetch(`${base()}/api/state`)).rejects.toThrow();
    h = null;
    // 最初の heartbeat が来ないとき
    await start({ firstHeartbeatMs: 200, idleMs: 400 });
    expect(await h!.done).toMatch(/最初の heartbeat/);
    h = null;
  });

  it('bye: 開いている画面がすべて閉じたら byeGraceMs で止まる。ほかの画面が開いていれば止まらず、猶予の間に heartbeat が来れば(ページの移動)止まらない', async () => {
    // 猶予(idleMs)は長く、bye の後だけ短く待つ
    await start({ idleMs: 600_000, byeGraceMs: 300 });
    const post = (p: string, client: string): Promise<Response> => fetch(`${base()}/api/${p}`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'x-atlas-client': client } });
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let reason: string | null = null;
    void h!.done.then((r) => (reason = r));
    expect((await fetch(`${base()}/api/bye`, { method: 'POST' })).status).toBe(403);
    await post('heartbeat', 'a');
    await post('heartbeat', 'b');
    // a を閉じても b が開いているので止まらない
    expect((await post('bye', 'a')).status).toBe(204);
    await wait(500);
    expect(reason).toBeNull();
    // b も閉じたが、猶予の間に次のページ(c)の heartbeat が来たので止まらない
    await post('bye', 'b');
    await wait(100);
    await post('heartbeat', 'c');
    await wait(500);
    expect(reason).toBeNull();
    // c を閉じて誰も来なければ止まる
    const t0 = performance.now();
    await post('bye', 'c');
    expect(await h!.done).toBe('画面がすべて閉じられた');
    expect(performance.now() - t0).toBeGreaterThan(250);
    h = null;
  });

  it('止めるときは、まだ何も送っていない接続(ブラウザが次の要求のために先に開けておくもの)や送りかけの要求が残っていても、待たずに止まる', async () => {
    await start({ idleMs: 600_000, byeGraceMs: 200 });
    const open = async (): Promise<Socket> => {
      const s = connect(h!.port, '127.0.0.1');
      s.on('error', () => {});
      await new Promise((r) => s.once('connect', r));
      return s;
    };
    const quiet = await open();
    const partial = await open();
    partial.write('GET /atlas.html HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const cut = Promise.all([quiet, partial].map((s) => new Promise<void>((r) => s.once('close', () => r()))));
    try {
      const post = (p: string): Promise<Response> => fetch(`${base()}/api/${p}`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'x-atlas-client': 'a', 'x-atlas-seq': p === 'bye' ? '2' : '1' } });
      await post('heartbeat');
      await post('bye');
      const t0 = performance.now();
      // 以前は close() がこの 2 本の接続が閉じるのを待ち続け、done が返らなかった
      expect(await Promise.race([h!.done, new Promise((r) => setTimeout(() => r('5 秒たっても止まらない'), 5000))])).toBe('画面がすべて閉じられた');
      expect(performance.now() - t0).toBeLessThan(3000);
      await cut;
    } finally {
      quiet.destroy();
      partial.destroy();
    }
    h = null;
  });

  it('自分から止まる前に、応えている途中の要求(フォルダ選び・アップロードなど)が終わるのを待つ。相手が先に切っても処理が済むまで待ち、済んだら猶予を測り直して止まる', async () => {
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    // aborted: 画面が応答を待たずに閉じた(接続は切れたが、サーバの処理は続いている)
    for (const aborted of [false, true]) {
      const logs: string[] = [];
      let answer!: (v: string | null) => void;
      let asked!: () => void;
      const picking = new Promise<void>((r) => (asked = r));
      await start({
        idleMs: 600_000,
        byeGraceMs: 200,
        configPath: join(dir, 'config.json'),
        log: (m) => logs.push(m),
        folders: { canPick: true, pick: () => (asked(), new Promise<string | null>((r) => (answer = r))) },
      });
      let reason: string | null = null;
      void h!.done.then((r) => (reason = r));
      const post = (p: string, seq: number): Promise<Response> => fetch(`${base()}/api/${p}`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'x-atlas-client': 'a', 'x-atlas-seq': String(seq) } });
      await post('heartbeat', 1);
      // フォルダを選ぶ画面が出ている間、応答は返らない
      const ac = new AbortController();
      const slow = fetch(`${base()}/api/upload-root`, { method: 'POST', headers: { 'x-atlas-token': h!.token }, signal: ac.signal }).catch((e: unknown) => e as Error);
      await picking;
      if (aborted) {
        ac.abort();
        await wait(100);
      }
      await post('bye', 2);
      // 猶予(200ms)は過ぎたが、応えている途中なので止まらない(以前は接続ごと切って止まった)
      await wait(600);
      expect({ aborted, reason }).toEqual({ aborted, reason: null });
      expect(logs.filter((l) => l.includes('画面がすべて閉じられた。処理が終わるまで止めずに待ちます'))).toHaveLength(1);
      const t0 = performance.now();
      answer(null);
      const r = await slow;
      if (aborted) expect(r).toBeInstanceOf(Error);
      else {
        // 応答は切られずに最後まで届く
        expect((r as Response).status).toBe(200);
        expect(await (r as Response).json()).toEqual({ root: null });
      }
      // 終わったら、猶予を測り直してから止まる
      expect(await h!.done).toBe('画面がすべて閉じられた');
      expect(performance.now() - t0).toBeGreaterThan(150);
      h = null;
    }
  });

  it('bye の番号(x-atlas-seq): 閉じる前に出た heartbeat が bye の後に届いても数え直さない。番号が新しければ(bfcache から戻った画面)数え直す', async () => {
    await start({ idleMs: 600_000, byeGraceMs: 300 });
    const post = (p: string, client: string, seq: number): Promise<Response> =>
      fetch(`${base()}/api/${p}`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'x-atlas-client': client, 'x-atlas-seq': String(seq) } });
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let reason: string | null = null;
    void h!.done.then((r) => (reason = r));
    await post('heartbeat', 'a', 1);
    // bfcache に入った(bye 3)。戻ってきた(heartbeat 4)ので数え直され、止まらない
    await post('bye', 'a', 3);
    await post('heartbeat', 'a', 4);
    await wait(500);
    expect(reason).toBeNull();
    // 閉じた(bye 6)後に、閉じる前の heartbeat(5)が遅れて届いても、開いている画面に数えないので止まる
    await post('bye', 'a', 6);
    await post('heartbeat', 'a', 5);
    expect(await h!.done).toBe('画面がすべて閉じられた');
    h = null;
  });

  it('番号の無い bye(番号を送らない古いページ)は覚えないので、そのページが戻って heartbeat を送れば数え直す', async () => {
    await start({ idleMs: 600_000, byeGraceMs: 300 });
    const post = (p: string): Promise<Response> => fetch(`${base()}/api/${p}`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'x-atlas-client': 'old' } });
    let reason: string | null = null;
    void h!.done.then((r) => (reason = r));
    await post('heartbeat');
    await post('bye');
    await post('heartbeat');
    await new Promise((r) => setTimeout(r, 600));
    expect(reason).toBeNull();
    await h!.close();
    h = null;
  });

  it('別のフォルダを開く(/api/folders): token が要り、調べる・開く・一覧・外すが働く。開くのは別のプロセス(このサーバの出力先には触れない)', async () => {
    // logs/<人>/<プロジェクト>/<セッション>
    const logs = join(dir, 'logs');
    for (const p of ['person-a/proj-a/s1', 'person-a/proj-b/s2', 'person-b/proj-a/s3']) {
      await mkdir(join(logs, p), { recursive: true });
      await writeFile(join(logs, p, 'events.jsonl'), '{"type":"session.start","data":{"sessionId":"x","version":1},"id":"e1","timestamp":"2026-07-02T09:00:00.000Z","parentId":null}\n');
    }
    const launched: string[][] = [];
    await start({
      configPath: join(dir, 'atlas.config.json'),
      reports: {
        launch: (args) => {
          launched.push(args);
          return process.pid;
        },
      },
    });
    const post = (path: string, body: unknown, token: string | null = h!.token) => json(`/api/folders/${path}`, { method: 'POST', body: JSON.stringify(body) }, token);
    expect((await json('/api/folders', {}, null)).status).toBe(403);
    expect((await post('open', { path: logs }, null)).status).toBe(403);
    expect((await json('/api/folders', { method: 'PUT', body: '{}' })).status).toBe(405);
    expect((await post('nope', {})).status).toBe(404);
    const empty = await json('/api/folders');
    expect(empty).toMatchObject({ status: 200, body: { current: null, local: { status: 'current', url: null }, folders: [] } });
    expect(typeof empty.body.canPick).toBe('boolean');
    // 調べる: 何を読むかを返す。集計できないものは、理由を答えとして返す(ok: false)
    expect(await post('check', { path: logs })).toMatchObject({ status: 200, body: { path: logs, ok: true, name: 'logs', summary: expect.stringContaining('3 件のフォルダをまとめて集計します') } });
    expect(await post('check', { path: join(logs, 'person-a') })).toMatchObject({ status: 200, body: { name: 'person-a', summary: '下のフォルダ 2 件をまとめて集計します(proj-a、proj-b)' } });
    expect(await post('check', { path: join(dir, 'nope') })).toMatchObject({ status: 200, body: { path: join(dir, 'nope'), ok: false, error: expect.stringContaining('見つかりません') } });
    expect(await post('check', { path: 'logs' })).toMatchObject({ status: 200, body: { path: 'logs', ok: false, error: expect.stringContaining('フルパス') } });
    expect(await post('check', {})).toMatchObject({ status: 200, body: { path: '', ok: false } });
    // 開く: 別のプロセスに、フォルダと、いつもの出力先・メモの場所・設定ファイルを渡す(ブラウザを開かない指定も引き継ぐ)
    const opened = await post('open', { path: join(logs, 'person-a') });
    expect(opened).toMatchObject({ status: 200, body: { name: 'person-a', status: 'starting' } });
    expect(launched).toHaveLength(1);
    expect(launched[0].slice(1)).toEqual(['open', join(logs, 'person-a'), '--out', out, '--notes-dir', notes, '--config', join(dir, 'atlas.config.json'), '--no-open']);
    expect((await post('open', { path: join(logs, 'person-a') })).body.status).toBe('starting');
    expect(launched).toHaveLength(1);
    expect((await post('open', { path: join(dir, 'nope') })).status).toBe(400);
    const key = opened.body.key as string;
    expect(existsSync(join(`${out}-folders`, key, 'folder.json'))).toBe(true);
    expect(existsSync(join(out, 'folder.json'))).toBe(false);
    expect((await json('/api/folders')).body.folders).toMatchObject([{ key, path: join(logs, 'person-a'), status: 'starting' }]);
    // 外す: 一覧から消える(置き場は残る)。キーの形が違うもの・無いものは理由を返す
    expect((await post('forget', { key: '../x' })).status).toBe(400);
    expect((await post('forget', { key: 'none-00000000' })).status).toBe(404);
    expect(await post('forget', { key })).toMatchObject({ status: 200, body: { folders: [] } });
    expect(existsSync(join(`${out}-folders`, key, 'folder.json'))).toBe(true);
  });

  it('別のフォルダを開いたサーバ(reports.current): 一覧はそのフォルダを「この画面」とし、この PC の集計は開いていなければ idle', async () => {
    const logs = join(dir, 'logs');
    await mkdir(join(logs, 'proj', 's1'), { recursive: true });
    await writeFile(join(logs, 'proj', 's1', 'events.jsonl'), '{}\n');
    await start({ home: logs, reports: { root: join(dir, 'reports'), notesBase: notes, localOut: join(dir, 'local-out'), current: logs, launch: () => null } });
    expect((await json('/api/folders')).body).toMatchObject({ current: { path: logs, name: 'logs' }, local: { status: 'idle', url: null }, folders: [] });
  });

  it('猶予の既定は、隠れたタブの間引かれた heartbeat(1 分に 1 回)より十分長い', () => {
    expect(DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(BYE_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });
});
