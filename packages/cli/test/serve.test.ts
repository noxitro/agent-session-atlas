// atlas serve(Phase 10 第 2 段): 静的配信・API・token・パスの正規化・heartbeat による終了
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRunningServer, SERVE_STATE_FILE, startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

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
    expect(await findRunningServer(out)).toEqual({ port: h!.port, pid: process.pid });
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
});
