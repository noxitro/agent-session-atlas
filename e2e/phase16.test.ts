// アップロード先のフォルダを --home にして集計し直す側(読む側)を、架空の fixture で通しで確かめる。
// (送る側と、元と同じ集計になることは e2e/phase15.test.ts)
//  a. プロジェクト名は送った側の記録から取る(読む側の PC に作業フォルダが無くても、同じパスに別のリポジトリがあっても変わらない)
//  b. 置き換えの途中・消し残しのフォルダ(.<id>.uploading / .<id>.old)があっても、セッションもトークンも二重に数えない
//  c. 出力先を別のフォルダで使い回すと止まり、前の集計はそのまま残る
//  d. 添えた行(atlas-session-store.json)の形が違っても止まらず、警告を出して続ける
//  e. アップロードしたフォルダが並ぶ場所(人ごとのフォルダ)を指すと、下のフォルダをまとめて集計する。もう 1 段上(全員の分)も、まとめて集計する
//  f. リンクのファイルは辿らない(フォルダの外のファイルを写さない)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionStoreRows, type SessionRecord, type SessionsFile, type SessionStoreJson } from '../packages/core/src/index.ts';
import { folderPaths, foldersRootOf } from '../packages/cli/src/folders.ts';
import { extractEmbedded } from '../packages/report/src/index.ts';
import { buildFixtureHome, ROOT } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase16');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const GROUP_A = 'Read-Side-A';
const GROUP_B = 'Read-Side-B';
/** 作業フォルダの .git/config からプロジェクト名が決まるセッション(ログに repository の記録が無い) */
const GIT_SESSION = '00000000-0000-4000-8000-000000160001';

function atlas(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** フォルダを集計して(snapshot → extract)、sessions.json を読む */
async function aggregate(home: string, out: string): Promise<SessionsFile> {
  for (const cmd of ['snapshot', 'extract']) {
    const r = atlas([cmd, '--home', home, '--out', out]);
    expect(r.status, r.out).toBe(0);
  }
  return JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
}

const tokens = (ss: SessionRecord[]): number => ss.reduce((n, s) => n + (s.tokens.input ?? 0) + (s.tokens.output ?? 0), 0);

/** atlas open を起動し、サーバが応え始めるまで待つ。返すのは、それまでの出力と、止める関数 */
async function openUntilServing(args: string[]): Promise<{ url: string; output: () => string; pid: number | undefined; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [CLI, 'open', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += String(d)));
  child.stderr.on('data', (d) => (output += String(d)));
  const stop = async (): Promise<void> => {
    child.kill();
    if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  };
  try {
    const url = await new Promise<string>((ok, ng) => {
      const t = setTimeout(() => ng(new Error(`open が起動しない: ${output}`)), 150_000);
      child.once('exit', (code) => {
        clearTimeout(t);
        ng(new Error(`open が終わった(${code}): ${output}`));
      });
      const tick = (): void => {
        const m = /serve: (http:\/\/127\.0\.0\.1:\d+\/atlas\.html)/.exec(output);
        if (m) {
          clearTimeout(t);
          ok(m[1]);
        } else setTimeout(tick, 100);
      };
      tick();
    });
    return { url, output: () => output, pid: child.pid, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

describe('Phase 16 E2E: アップロード先から集計し直す(読む側)', () => {
  let close: () => Promise<void>;
  let home: string;
  const out1 = join(WORK, 'out-src');
  const notes = join(WORK, 'notes');
  const root = join(WORK, 'atlas-logs');
  const destA = join(root, GROUP_A);
  const destB = join(root, GROUP_B);
  const repo = join(WORK, 'pc-a', 'my-app');
  let original: SessionsFile;
  /** DB とフォルダの両方があり、トークンが記録されているセッション */
  let ids: string[];
  /** グループ B に入れる、別のセッション */
  let other: string;
  /** グループ A を集計し直したもの(消し残しや壊れたファイルが無いときの基準) */
  let clean: SessionsFile;

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/zz-owner/zz-from-disk.git\n');
    const gdir = join(home, 'session-state', GIT_SESSION);
    await mkdir(gdir);
    await writeFile(
      join(gdir, 'workspace.yaml'),
      `id: ${GIT_SESSION}\ncwd: ${JSON.stringify(repo)}\ngit_root: ${JSON.stringify(repo)}\nclient_name: github/cli\nname: "合成: ディスクから名前が決まる"\nuser_named: false\ncreated_at: 2026-07-02T09:00:00.000Z\nupdated_at: 2026-07-02T09:05:00.000Z\n`,
    );
    const events = [
      { type: 'session.start', data: { sessionId: GIT_SESSION, version: 1, copilotVersion: '1.0.50', selectedModel: 'gpt-5.5-mini', context: { cwd: repo, gitRoot: repo } }, id: 'e1', timestamp: '2026-07-02T09:00:00.000Z', parentId: null },
      { type: 'user.message', data: { content: '合成の依頼' }, id: 'e2', timestamp: '2026-07-02T09:00:05.000Z', parentId: 'e1' },
      { type: 'assistant.message', data: { content: '合成の応答' }, id: 'e3', timestamp: '2026-07-02T09:00:20.000Z', parentId: 'e2' },
    ];
    await writeFile(join(gdir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    original = await aggregate(home, out1);
    ids = [];
    for (const x of original.sessions) {
      if (ids.length === 2) break;
      if (x.sources.length !== 2 || !existsSync(join(out1, 'snapshot', 'session-state', x.id, 'events.jsonl'))) continue;
      const rows = await sessionStoreRows(join(out1, 'snapshot', 'session-store.db'), x.id);
      if (rows?.usage.length) ids.push(x.id);
    }
    expect(ids).toHaveLength(2);
    other = original.sessions.find((x) => !ids.includes(x.id) && x.id !== GIT_SESSION && existsSync(join(out1, 'snapshot', 'session-state', x.id, 'events.jsonl')))!.id;
    await mkdir(notes, { recursive: true });
    await writeFile(
      join(notes, 'groups.json'),
      JSON.stringify({ version: 1, groups: [{ name: GROUP_A, note: '', ids: [...ids, GIT_SESSION] }, { name: GROUP_B, note: '', ids: [other] }] }),
    );
    await mkdir(root, { recursive: true });
    for (const g of [GROUP_A, GROUP_B]) {
      const r = atlas(['group', 'upload', g, '--to', root, '--out', out1, '--notes-dir', notes]);
      expect(r.status, r.out).toBe(0);
    }
    clean = await aggregate(destA, join(WORK, 'out-clean'));
    expect(clean.sessions.map((s) => s.id).sort()).toEqual([...ids, GIT_SESSION].sort());
    expect(tokens(clean.sessions)).toBeGreaterThan(0);
  }, 180_000);
  afterAll(async () => close?.());

  it('a. プロジェクト名は送った側の記録から取る(作業フォルダが無くても、同じパスに別のリポジトリがあっても同じ)', async () => {
    // 対照: 元の PC では、作業フォルダの .git/config から決まっている
    const first = original.sessions.find((s) => s.id === GIT_SESSION)!;
    expect([first.project, first.projectSource]).toEqual(['zz-owner/zz-from-disk', 'git-remote']);
    // その名前と決め方を、セッションのフォルダに添えてある
    expect(JSON.parse(await readFile(join(destA, GIT_SESSION, 'atlas-session.json'), 'utf8'))).toMatchObject({ version: 1, id: GIT_SESSION, project: 'zz-owner/zz-from-disk', projectSource: 'git-remote' });
    const projectOf = (f: SessionsFile) => {
      const s = f.sessions.find((x) => x.id === GIT_SESSION)!;
      return [s.project, s.projectSource];
    };
    expect(projectOf(clean)).toEqual(['zz-owner/zz-from-disk', 'git-remote']);
    // 読む側の PC に、送った人の作業フォルダが無い
    await rename(join(WORK, 'pc-a'), join(WORK, 'pc-a-gone'));
    expect(projectOf(await aggregate(destA, join(WORK, 'out-no-folder')))).toEqual(['zz-owner/zz-from-disk', 'git-remote']);
    // 読む側の PC の同じパスに、別のリポジトリがある
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/zz-other/zz-unrelated.git\n');
    const there = await aggregate(destA, join(WORK, 'out-other-repo'));
    expect(projectOf(there)).toEqual(['zz-owner/zz-from-disk', 'git-remote']);
    // ほかのセッションも、元の集計と同じプロジェクトのまま
    for (const id of ids) {
      const a = original.sessions.find((s) => s.id === id)!;
      const b = there.sessions.find((s) => s.id === id)!;
      expect([b.project, b.projectSource]).toEqual([a.project, a.projectSource]);
    }
  });

  it('b. 置き換えの途中・消し残しのフォルダがあっても、二重に数えない', async () => {
    const dest = join(WORK, 'dest-leftover');
    await cp(destA, dest, { recursive: true });
    await cp(join(dest, ids[0]), join(dest, `.${ids[0]}.old`), { recursive: true });
    await cp(join(dest, ids[0]), join(dest, `.${ids[0]}.uploading`), { recursive: true });
    const out = join(WORK, 'out-leftover');
    const again = await aggregate(dest, out);
    expect(again.sessions.map((s) => s.id).sort()).toEqual(clean.sessions.map((s) => s.id).sort());
    expect(tokens(again.sessions)).toBe(tokens(clean.sessions));
    expect(again.warnings.messages.join('\n')).toMatch(/消し残しのフォルダ 2 件は、セッションとして数えていない/);
    expect(existsSync(join(out, 'snapshot', 'session-state', `.${ids[0]}.old`))).toBe(false);
  });

  it('c. 出力先を別のフォルダで使い回すと止まり、前の集計はそのまま残る', async () => {
    const out = join(WORK, 'out-reuse');
    const before = await aggregate(destA, out);
    const text = await readFile(join(out, 'sessions.json'), 'utf8');
    for (const from of [destB, home]) {
      for (const cmd of ['snapshot', 'all']) {
        const r = atlas([cmd, '--home', from, '--out', out]);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/別の場所.*から集計したものです/);
        expect(r.out).toContain('--out');
      }
    }
    expect(await readFile(join(out, 'sessions.json'), 'utf8')).toBe(text);
    expect(existsSync(join(out, 'snapshot', 'session-state', other))).toBe(false);
    // 同じフォルダなら、何度でも同じ出力先に集計し直せる
    expect((await aggregate(destA, out)).sessions.map((s) => s.id)).toEqual(before.sessions.map((s) => s.id));
    // 別の出力先なら、別のフォルダを集計できる
    expect((await aggregate(destB, join(WORK, 'out-b'))).sessions.map((s) => s.id)).toEqual([other]);
  });

  it('d. 添えた行の形が違っても止まらず、警告を出して続ける', async () => {
    const id = ids[0];
    const base = JSON.parse(await readFile(join(destA, id, 'atlas-session-store.json'), 'utf8')) as SessionStoreJson;
    expect(base.usage.length).toBeGreaterThan(0);
    const cases: [string, unknown][] = [
      ['sessions-null', { ...base, sessions: [null] }],
      ['usage-null', { ...base, usage: [null] }],
      ['turns-null', { ...base, turns: [null] }],
      ['session-types', { ...base, sessions: [{ id, cwd: 123, repository: ['a'], summary: {}, branch: 7, created_at: 5, updated_at: {} }] }],
      ['usage-strings', { ...base, usage: [Object.fromEntries(Object.keys(base.usage[0]).map((k) => [k, k === 'session_id' ? id : 'x']))] }],
      ['not-json', 'not json'],
    ];
    for (const [name, v] of cases) {
      const dest = join(WORK, `dest-bad-${name}`);
      await cp(destA, dest, { recursive: true });
      await writeFile(join(dest, id, 'atlas-session-store.json'), typeof v === 'string' ? v : JSON.stringify(v));
      const again = await aggregate(dest, join(WORK, `out-bad-${name}`));
      expect(again.warnings.messages.filter((m) => m.includes('atlas-session-store.json')), name).toHaveLength(1);
      expect(again.warnings.messages.join('\n'), name).toContain(`${id}: atlas-session-store.json を読めない`);
      // そのセッションはイベントのログだけで集計に残り、ほかのセッションは基準と同じ
      expect(again.sessions.map((s) => s.id).sort(), name).toEqual(clean.sessions.map((s) => s.id).sort());
      const rest = (f: SessionsFile) => f.sessions.filter((s) => s.id !== id).map(({ instructions: _i, ...r }) => r);
      expect(rest(again), name).toEqual(rest(clean));
    }
  });

  it('e. アップロードしたフォルダが並ぶ場所を指すと、下のフォルダをまとめて集計する。もう 1 段上(全員の分)も、まとめて集計する', async () => {
    const out = join(WORK, 'out-base');
    const r = atlas(['all', '--home', root, '--out', out]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`下のフォルダ 2 件をまとめて読みました(${GROUP_A}、${GROUP_B})`);
    const merged = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(merged.source).toMatchObject({ layout: 'merged', folders: [GROUP_A, GROUP_B] });
    expect(merged.sessions.map((x) => x.id).sort()).toEqual([...ids, GIT_SESSION, other].sort());
    // フォルダ 1 つずつ集計したときと、セッションごとの中身が同じ(トークンも、送った側の記録から取るプロジェクト名も)
    const strip = (f: SessionsFile) => f.sessions.filter((x) => x.id !== other).map(({ instructions: _i, ...rest }) => rest);
    expect(strip(merged)).toEqual(strip(clean));
    expect(existsSync(join(out, 'atlas.html'))).toBe(true);
    // 同じセッションを 2 つのフォルダに送ってあっても、1 度だけ数える
    const twice = join(WORK, 'atlas-logs-twice');
    await cp(root, twice, { recursive: true });
    await cp(join(twice, GROUP_A, ids[0]), join(twice, GROUP_B, ids[0]), { recursive: true });
    const again = await aggregate(twice, join(WORK, 'out-twice'));
    expect(again.sessions.map((x) => x.id).sort()).toEqual([...ids, GIT_SESSION, other].sort());
    expect(tokens(again.sessions)).toBe(tokens(merged.sessions));
    // もう 1 段上(人ごとのフォルダが並ぶ場所。全員の分)は、2 段下のフォルダまでまとめて集計する。2 人が同じセッションを送ってあっても 1 度だけ数える
    const everyone = join(WORK, 'everyone');
    await cp(root, join(everyone, 'person-a'), { recursive: true });
    await cp(root, join(everyone, 'person-b'), { recursive: true });
    // 送った人のインストール済みの記録: 人ごとに、新しいほうの記録だけを使う(person-a の GROUP_B は古い記録)
    const inventory = (sentAt: string, skills: string[]) => JSON.stringify({ version: 1, sentAt, skills, plugins: [], disabledSkills: [], warnings: [] });
    await writeFile(join(everyone, 'person-a', GROUP_A, 'atlas-installed.json'), inventory('2026-11-10T00:00:00.000Z', ['zz-skill-a']));
    await writeFile(join(everyone, 'person-a', GROUP_B, 'atlas-installed.json'), inventory('2026-11-01T00:00:00.000Z', ['zz-removed']));
    await writeFile(join(everyone, 'person-b', GROUP_A, 'atlas-installed.json'), inventory('2026-11-10T00:00:00.000Z', ['zz-skill-b']));
    await writeFile(join(everyone, 'person-b', GROUP_B, 'atlas-installed.json'), inventory('2026-11-09T00:00:00.000Z', ['zz-skill-b']));
    const out2 = join(WORK, 'out-everyone');
    const r2 = atlas(['all', '--home', everyone, '--out', out2]);
    expect(r2.status, r2.out).toBe(0);
    expect(r2.out).toContain('下のフォルダ 4 件をまとめて読みました(');
    const all = JSON.parse(await readFile(join(out2, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(all.source).toMatchObject({ layout: 'merged', folders: [`person-a/${GROUP_A}`, `person-a/${GROUP_B}`, `person-b/${GROUP_A}`, `person-b/${GROUP_B}`] });
    expect(all.sessions.map((x) => x.id).sort()).toEqual([...ids, GIT_SESSION, other].sort());
    expect(tokens(all.sessions)).toBe(tokens(merged.sessions));
    expect(existsSync(join(out2, 'atlas.html'))).toBe(true);
    // 全員分は、人ごとの新しい記録を合わせたもの。人ごとの記録は、画面で人に絞ったときに使う
    expect(all.installed?.skills).toEqual(['zz-skill-a', 'zz-skill-b']);
    expect(Object.fromEntries(Object.entries(all.installedByPerson ?? {}).map(([p, inv]) => [p, inv.skills]))).toEqual({ 'person-a': ['zz-skill-a'], 'person-b': ['zz-skill-b'] });
    expect(await readFile(join(out2, 'atlas.html'), 'utf8')).toContain('"installedByPerson":{"person-a":{"skills":["zz-skill-a"]');
    // 送った atlas の版を画面の見出しに出す(送ったのも集計したのもこのチェックアウトなので、古い版は無い)
    expect(await readFile(join(out2, 'atlas.html'), 'utf8')).toMatch(/"atlasBuilds":\{"ok":(true|false),"short":"[^"]*"/);
    expect(r2.out).not.toMatch(/古い版 \d+ 件/);
    // 人のフォルダ 1 つを指すと、その人の分だけ
    const one = await aggregate(join(everyone, 'person-b'), join(WORK, 'out-person-b'));
    expect(one.source).toMatchObject({ layout: 'merged', folders: [GROUP_A, GROUP_B] });
    expect(one.sessions.map((x) => x.id).sort()).toEqual([...ids, GIT_SESSION, other].sort());
  }, 180_000);

  it('f. リンクのファイルは辿らない(フォルダの外のファイルを写さない)', async (ctx) => {
    const dest = join(WORK, 'dest-link');
    await cp(destA, dest, { recursive: true });
    const outside = join(WORK, 'outside.txt');
    await writeFile(outside, 'OUTSIDE-FILE-CONTENT\n');
    await rm(join(dest, ids[0], 'plan.md'), { force: true });
    try {
      await symlink(outside, join(dest, ids[0], 'plan.md'), 'file');
    } catch (e) {
      // リンクを作れない環境(Windows で権限が無い)では確かめられない
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((e as NodeJS.ErrnoException).code ?? '')) return ctx.skip();
      throw e;
    }
    const out = join(WORK, 'out-link');
    const again = await aggregate(dest, out);
    expect(again.sessions.map((s) => s.id).sort()).toEqual(clean.sessions.map((s) => s.id).sort());
    expect(existsSync(join(out, 'snapshot', 'session-state', ids[0], 'plan.md'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(out, 'snapshot', 'snapshot-manifest.json'), 'utf8')) as { extras?: { skipped: { path: string; reason: string }[] } };
    expect((manifest.extras?.skipped ?? []).filter((s) => s.path === `${ids[0]}/plan.md`).map((s) => s.reason)).toEqual([expect.stringMatching(/リンク/)]);
  });

  it('g. atlas open <フォルダ>: いつもの出力先とは別の場所に集計して、そのフォルダのサーバを立てる(全員の分)', async () => {
    const everyone = join(WORK, 'everyone-open');
    await cp(root, join(everyone, 'person-a'), { recursive: true });
    await cp(root, join(everyone, 'person-b'), { recursive: true });
    const localOut = join(WORK, 'out-local');
    const localNotes = join(WORK, 'notes-local');
    const fp = folderPaths(foldersRootOf(localOut), localNotes, everyone);
    const opened = await openUntilServing([everyone, '--out', localOut, '--notes-dir', localNotes, '--no-open', '--port', '0']);
    const { url } = opened;
    const output = opened.output();
    const child = { pid: opened.pid };
    try {
      expect(output).toContain('2 段下まで読み');
      // 集計はフォルダごとの置き場に出る。いつもの出力先には何も作らない
      const all = JSON.parse(await readFile(join(fp.out, 'sessions.json'), 'utf8')) as SessionsFile;
      expect(all.source).toMatchObject({ layout: 'merged', folders: [`person-a/${GROUP_A}`, `person-a/${GROUP_B}`, `person-b/${GROUP_A}`, `person-b/${GROUP_B}`] });
      expect(all.sessions.map((x) => x.id).sort()).toEqual([...ids, GIT_SESSION, other].sort());
      expect(existsSync(localOut)).toBe(false);
      expect(JSON.parse(await readFile(fp.state, 'utf8'))).toMatchObject({ path: everyone, name: 'everyone-open', listed: true, run: { state: 'serving', pid: child.pid } });
      expect(JSON.parse(await readFile(join(fp.out, '.serve.json'), 'utf8'))).toMatchObject({ pid: child.pid });
      // 画面: 埋め込みのデータに対象のフォルダが入り、一覧の API はこのフォルダを「この画面」として返す
      const served = await (await fetch(url)).text();
      const data = extractEmbedded<{ source?: { name: string; path: string } }>(served);
      expect(data.source).toMatchObject({ name: 'everyone-open', path: everyone });
      const token = /<meta name="atlas-token" content="([^"]+)"/.exec(served)![1];
      const list = (await (await fetch(new URL('api/folders', url), { headers: { 'x-atlas-token': token } })).json()) as { current: unknown; local: unknown; folders: { key: string; status: string }[] };
      expect(list).toMatchObject({ current: { path: everyone, name: 'everyone-open' }, local: { status: 'idle', url: null } });
      expect(list.folders).toMatchObject([{ key: fp.key, status: 'current' }]);
      // 同じフォルダをもう一度開くと、集計し直さずに、動いているサーバを使う
      const again = atlas(['open', everyone, '--out', localOut, '--notes-dir', localNotes, '--no-open']);
      expect(again.status, again.out).toBe(0);
      expect(again.out).toMatch(/既に動いているサーバがあります/);
      // 開いた画面は読むだけ: タスクタグは作れず、どちらの置き場にも書かない
      const made = await fetch(new URL('api/groups', url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-token': token }, body: JSON.stringify({ name: '全員の分のタグ', note: '', ids: [ids[0]] }) });
      expect(made.status).toBe(403);
      expect(((await made.json()) as { error: string }).error).toMatch(/読むだけ/);
      expect(existsSync(join(fp.notes, 'groups.json'))).toBe(false);
      expect(existsSync(join(localNotes, 'groups.json'))).toBe(false);
      const st = (await (await fetch(new URL('api/state', url), { headers: { 'x-atlas-token': token } })).json()) as { readOnly: boolean };
      expect(st.readOnly).toBe(true);
    } finally {
      await opened.stop();
    }
  }, 240_000);

  it('h. atlas open: 前に集計したときから何も変わっていなければ、作り直さずにそのときのレポートを開く。変わっていれば作り直す', async () => {
    const everyone = join(WORK, 'everyone-open');
    const localOut = join(WORK, 'out-local');
    const localNotes = join(WORK, 'notes-local');
    const fp = folderPaths(foldersRootOf(localOut), localNotes, everyone);
    const args = [everyone, '--out', localOut, '--notes-dir', localNotes, '--no-open', '--port', '0'];
    const REUSED = /そのときのレポートを使います/;
    /** 開いて、サーバが応えるところまでの出力を返す(レポートが開けることも確かめる) */
    const open = async (extra: string[] = []): Promise<string> => {
      const o = await openUntilServing([...args, ...extra]);
      try {
        const data = extractEmbedded<{ source?: { path: string } }>(await (await fetch(o.url)).text());
        expect(data.source).toMatchObject({ path: everyone });
        return o.output();
      } finally {
        await o.stop();
      }
    };
    // g. で集計したまま(サーバは止めてある): 共有から写すところまでは行い、その後は作り直さない
    expect(existsSync(fp.built)).toBe(true);
    const htmlBefore = await readFile(join(fp.out, 'atlas.html'), 'utf8');
    const same = await open();
    expect(same).toMatch(/snapshot: /);
    expect(same).toMatch(REUSED);
    expect(same).not.toMatch(/extract: |build: /);
    expect(await readFile(join(fp.out, 'atlas.html'), 'utf8')).toBe(htmlBefore);
    // 元のフォルダのログが増えた: 作り直す
    const events = join(everyone, 'person-a', GROUP_A, ids[0], 'events.jsonl');
    await writeFile(events, `${await readFile(events, 'utf8')}
`);
    const grown = await open();
    expect(grown).not.toMatch(REUSED);
    expect(grown).toMatch(/extract: /);
    expect(grown).toMatch(/build: /);
    // --rebuild: 変わっていなくても作り直す
    const forced = await open(['--rebuild']);
    expect(forced).not.toMatch(REUSED);
    expect(forced).toMatch(/build: /);
    // 別の処理(画面の「集計し直す」・判定など)がレポートを書き換えていたら、作り直す
    await writeFile(join(fp.out, 'atlas.html'), `${await readFile(join(fp.out, 'atlas.html'), 'utf8')}<!-- 別の処理が書いた -->`);
    const touched = await open();
    expect(touched).not.toMatch(REUSED);
    expect(touched).toMatch(/build: /);
    // 作り直した後は、また使い回す
    expect(await open()).toMatch(REUSED);
  }, 480_000);
});
