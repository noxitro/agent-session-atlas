// 画面の「設定」の API(serve): setup.bat と同じ項目(llm-wiki の vault・普段の工程名)を画面から読み書きする。
// アップロード先とまとめて送るプロジェクトは、既存の API(upload-root・upload-projects)を使う(group-upload.test.ts と upload-project.test.ts)
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

describe('画面の設定(serve の API)', () => {
  let dir: string;
  let out: string;
  let notes: string;
  let configPath: string;
  let home: string;
  let vault: string;
  let h: ServeHandle | null = null;
  let picks: (string | null)[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-settings-'));
    out = join(dir, 'out');
    notes = join(dir, 'notes');
    configPath = join(dir, 'atlas.config.json');
    home = join(dir, '.copilot');
    await mkdir(join(home, 'skills', 'wiki-query'), { recursive: true });
    await mkdir(join(home, 'skills', 'other'), { recursive: true });
    vault = join(dir, 'my vault');
    await mkdir(join(vault, 'wiki'), { recursive: true });
    await writeFile(join(vault, 'index.md'), '# index');
    await mkdir(out, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(out, 'atlas.html'), `<!doctype html><meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"><script type="application/json" id="atlas-data">{"version":9,"anonymized":false,"groups":[]}</script>`);
    picks = [];
  });
  afterEach(async () => {
    await h?.close();
    h = null;
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (canPick = true): Promise<ServeHandle> =>
    (h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, configPath, copilotHome: home, folders: { canPick, pick: async () => picks.shift() ?? null } }));
  const call = (p: string, method: string, body?: unknown, token: string | null = h!.token) =>
    fetch(`http://127.0.0.1:${h!.port}/${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-atlas-token': token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
  const config = async (): Promise<unknown> => JSON.parse(await readFile(configPath, 'utf8'));

  it('今の設定を返す(token が要る)。名前に wiki を含むインストール済みの skill を候補に出す', async () => {
    await start();
    expect((await call('api/settings', 'GET', undefined, null)).status).toBe(403);
    const s = await json(await call('api/settings', 'GET'));
    expect(s).toMatchObject({ configPath, error: null, canPick: true, wikis: [], phases: null, uploadRoot: null, uploadProjects: [], skillCandidates: ['wiki-query'] });
    expect((s.defaultPhases as string[]).length).toBeGreaterThan(1);
    expect((await call('api/settings/nothing', 'POST', {})).status).toBe(404);
    expect((await call('api/settings/wikis', 'DELETE')).status).toBe(405);
  });

  it('vault を調べる(入力・エクスプローラー)。実在すればフォルダ名だけにし、中の index.md と wiki/ を見る', async () => {
    await start();
    expect(await json(await call('api/settings/vault/describe', 'POST', { input: `"${vault}\\"` }))).toEqual({ name: 'my vault', dir: vault, hasIndex: true, pagesDir: 'wiki' });
    expect(await json(await call('api/settings/vault/describe', 'POST', { input: 'notes/brain' }))).toEqual({ name: 'notes/brain', dir: null, hasIndex: false, pagesDir: null });
    expect((await call('api/settings/vault/describe', 'POST', { input: '  ' })).status).toBe(400);
    expect((await call('api/settings/vault/describe', 'POST', { input: '..' })).status).toBe(400);
    picks = [vault, null];
    expect(await json(await call('api/settings/vault/pick', 'POST'))).toMatchObject({ name: 'my vault', hasIndex: true });
    // 取り消したら null
    expect(await (await call('api/settings/vault/pick', 'POST')).json()).toBeNull();
  });

  it('選ぶ画面を出せない OS では 501', async () => {
    await start(false);
    expect((await call('api/settings/vault/pick', 'POST')).status).toBe(501);
  });

  it('vault を足す・外す(setup.bat と同じ形で書く。同じ名前は足さず、外すときは書いてあるとおりの値から外す)', async () => {
    // 手で書いた ~/ の指定は、ほかを外しても展開せずに残す
    await writeFile(configPath, JSON.stringify({ wikis: ['~/notes'], uploadRoot: dir }));
    await start();
    const add = await call('api/settings/wikis', 'POST', { vault: { path: 'my vault', pages: ['wiki'], index: [], skills: ['wiki-query', 'wiki-query', ' '] } });
    expect(add.status).toBe(200);
    expect(((await json(add)).wikis as { path: string }[]).map((w) => w.path)).toEqual([join(homedir(), 'notes'), 'my vault']);
    // ページが vault 全体(.)だけなら書かない。path だけなら文字列
    await call('api/settings/wikis', 'POST', { vault: { path: 'second', pages: ['.'] } });
    expect(await config()).toEqual({ wikis: ['~/notes', { path: 'my vault', pages: ['wiki'], skills: ['wiki-query'] }, 'second'], uploadRoot: dir });
    const dup = await call('api/settings/wikis', 'POST', { vault: { path: 'second' } });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toMatch(/もう入っています/);
    expect((await call('api/settings/wikis', 'POST', { vault: { path: '' } })).status).toBe(400);
    expect((await call('api/settings/wikis', 'POST', { vault: { path: 'x', pages: 'wiki' } })).status).toBe(400);
    // 外す: 番号と名前が合わなければ(ほかで書き換えた)外さない
    const stale = await call('api/settings/wikis/remove', 'POST', { index: 1, path: 'second' });
    expect(stale.status).toBe(409);
    expect((await call('api/settings/wikis/remove', 'POST', { index: 1, path: 'my vault' })).status).toBe(200);
    expect(await config()).toEqual({ wikis: ['~/notes', 'second'], uploadRoot: dir });
    await call('api/settings/wikis/remove', 'POST', { index: 1, path: 'second' });
    const home2 = join(homedir(), 'notes');
    await call('api/settings/wikis/remove', 'POST', { index: 0, path: home2 });
    // 全部外すと項目ごと消す(ほかの項目は残す)
    expect(await config()).toEqual({ uploadRoot: dir });
  });

  it('普段の工程名を決める・既定に戻す。1 つだけ・重複は断る', async () => {
    await start();
    const r = await call('api/settings/phases', 'PUT', { phases: [' 設計', '実装 ', ''] });
    expect(r.status).toBe(200);
    expect((await json(r)).phases).toEqual(['設計', '実装']);
    expect(await config()).toEqual({ phases: ['設計', '実装'] });
    expect((await call('api/settings/phases', 'PUT', { phases: ['設計'] })).status).toBe(400);
    expect((await call('api/settings/phases', 'PUT', { phases: ['設計', '設計'] })).status).toBe(400);
    expect((await call('api/settings/phases', 'PUT', { phases: [] })).status).toBe(400);
    expect((await call('api/settings/phases', 'PUT', { phases: null })).status).toBe(200);
    expect(await config()).toEqual({});
  });

  it('設定ファイルが壊れていれば、理由を返して書き換えない', async () => {
    await writeFile(configPath, '{ 壊れた');
    await start();
    const s = await json(await call('api/settings', 'GET'));
    expect(s.error).toMatch(/atlas\.config\.json/);
    expect((await call('api/settings/wikis', 'POST', { vault: { path: 'x' } })).status).toBe(409);
    expect((await call('api/settings/phases', 'PUT', { phases: ['a', 'b'] })).status).toBe(409);
    expect(await readFile(configPath, 'utf8')).toBe('{ 壊れた');
  });
});
