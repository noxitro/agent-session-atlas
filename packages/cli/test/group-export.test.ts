// グループの書き出し(atlas group export と serve の POST /api/groups/<名前>/export): そのグループのセッションだけの表・集計・記録を
// out/groups/<名前>/ に書き、いつものレポートは触らない。前回の書き出しは消してから書く
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionsFile } from '../../core/src/types.ts';
import { parseCli } from '../src/args.ts';
import { run } from '../src/commands.ts';
import { exportGroup, safeDirName } from '../src/group-export.ts';
import { startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

const T0 = Date.parse('2026-11-06T00:00:00.000Z');
const ev = (dt: number, type: string, data: Record<string, unknown>): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString() });

async function session(id: string, requests: string[]) {
  const events: CopilotEvent[] = [ev(0, 'session.start', { context: { cwd: 'X:\\p' } })];
  requests.forEach((q, i) => {
    events.push(ev(1000 * (i + 1), 'user.message', { content: q }));
    events.push(ev(1000 * (i + 1) + 100, 'tool.execution_start', { toolCallId: `${id}-${i}`, toolName: 'view', arguments: { path: 'a' } }));
    events.push(ev(1000 * (i + 1) + 200, 'tool.execution_complete', { toolCallId: `${id}-${i}`, success: true }));
  });
  return normalizeSession({ id, events });
}

describe('グループの書き出し', () => {
  let dir: string;
  let out: string;
  let notes: string;
  let h: ServeHandle | null = null;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-gexp-'));
    out = join(dir, 'out');
    notes = join(dir, 'notes');
    await mkdir(join(out, 'sessions'), { recursive: true });
    await mkdir(notes, { recursive: true });
    const file: SessionsFile = { schemaVersion: 10, generatedAt: new Date(T0).toISOString(), home: 'x', sessions: [await session('s1', ['ボタンを足して', '違う、右に']), await session('s2', ['これは何？']), await session('s3', ['無関係'])], installed: null } as unknown as SessionsFile;
    await writeFile(join(out, 'sessions.json'), JSON.stringify(file));
    await writeFile(join(out, 'sessions', 's1.md'), '# 記録 s1');
    await writeFile(join(out, 'metrics.json'), 'いつもの集計');
    await writeFile(join(out, 'atlas.html'), `<!doctype html><meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"><script type="application/json" id="atlas-data">{"version":9,"anonymized":false,"groups":[]}</script>`);
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: '調査: A/B', note: '比べる', ids: ['s1', 's2', 'gone'] }] }));
  });
  afterEach(async () => {
    await h?.close();
    h = null;
    await rm(dir, { recursive: true, force: true });
  });
  const paths = () => ({ out, sessions: join(out, 'sessions.json'), judgments: join(out, 'judgments.json'), groups: join(notes, 'groups.json') });

  it('そのグループのセッションだけを表・集計・記録にして書き、いつものレポートは触らない', async () => {
    const r = await exportGroup(paths(), '調査: A/B');
    expect(r).toMatchObject({ sessions: 2, turns: 3, records: 1, missing: 1 });
    expect(r.dir).toBe(join(out, 'groups', '調査_ A_B'));
    expect((await readdir(r.dir)).sort()).toEqual(['README.md', 'atlas.sqlite', 'metrics.json', 'records', 'sessions.csv', 'turns.csv']);
    const turns = (await readFile(join(r.dir, 'turns.csv'), 'utf8')).trimEnd().split('\r\n');
    expect(turns).toHaveLength(4);
    expect(turns.slice(1).map((l) => l.split(',')[0])).toEqual(['s1', 's1', 's2']);
    expect(JSON.parse(await readFile(join(r.dir, 'metrics.json'), 'utf8')).turns.byKind.fix.turns).toBe(1);
    expect(await readdir(join(r.dir, 'records'))).toEqual(['s1.md']);
    expect(await readFile(join(r.dir, 'README.md'), 'utf8')).toContain('無かった 1 件は入っていません');
    expect(await readFile(join(out, 'metrics.json'), 'utf8')).toBe('いつもの集計');
    // 前回の書き出しは消してから書く(グループから外したセッションの記録を残さない)
    await writeFile(join(r.dir, 'records', 'old.md'), 'x');
    await exportGroup(paths(), '調査: A/B');
    expect(existsSync(join(r.dir, 'records', 'old.md'))).toBe(false);
    await expect(exportGroup(paths(), '無い')).rejects.toThrow(/はありません/);
  });

  it('CLI の group export と、serve の POST /api/groups/<名前>/export(token が要る)', async () => {
    const logs: string[] = [];
    await run(parseCli(['group', 'export', '調査: A/B', '--out', out, '--notes-dir', notes]), (m) => logs.push(m));
    expect(logs.join('\n')).toMatch(/2 セッション・3 依頼・記録 1 件/);
    expect(() => parseCli(['group', 'export'])).toThrow(/グループ名/);

    h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false });
    const post = (name: string, token: string | null = h!.token) =>
      fetch(`http://127.0.0.1:${h!.port}/api/groups/${encodeURIComponent(name)}/export`, { method: 'POST', headers: token ? { 'x-atlas-token': token } : {} });
    expect((await post('調査: A/B', null)).status).toBe(403);
    const ok = await post('調査: A/B');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: '調査: A/B', sessions: 2, turns: 3 });
    expect((await post('無い')).status).toBe(404);
    // 書き出しの間だけ out/ の印を取り、終わったら外す(残ると次の集計が始められない)
    expect(existsSync(join(out, '.job.json'))).toBe(false);
  });

  it('依頼ごとの判定のファイルが壊れていても、判定の列なしで書き出して注意を出す', async () => {
    await writeFile(join(out, 'turn-judgments.json'), '{ 壊れた');
    const logs: string[] = [];
    const r = await exportGroup(paths(), '調査: A/B', (m) => logs.push(m));
    expect(r.sessions).toBe(2);
    expect(await readFile(join(r.dir, 'turns.csv'), 'utf8')).not.toMatch(/判定:/);
    expect(logs.join('\n')).toMatch(/注意 .*turn-judgments\.json を読めないため/);
  });

  it('同じフォルダ名になる別のグループ(「A/B」と「A_B」)は、名前の短いハッシュを足して分ける', async () => {
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'A/B', note: '', ids: ['s1'] }, { name: 'A_B', note: '', ids: ['s2'] }] }));
    const x = await exportGroup(paths(), 'A/B');
    const y = await exportGroup(paths(), 'A_B');
    expect(x.dir).not.toBe(y.dir);
    expect(x.dir).toMatch(/A_B-[0-9a-f]{6}$/);
    expect(existsSync(join(x.dir, 'turns.csv')) && existsSync(join(y.dir, 'turns.csv'))).toBe(true);
  });

  it('フォルダ名に使えない文字と予約名を避ける', () => {
    expect(safeDirName('a/b\\c:d*e?')).toBe('a_b_c_d_e_');
    expect(safeDirName('con')).toBe('_con');
    expect(safeDirName('名前. ')).toBe('名前');
    expect(safeDirName('...')).toBe('group');
  });
});
