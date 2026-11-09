// プロジェクトのセッションをまとめて送る(upload-project.bat → upload-project.ts)。
// 集計のプロジェクトを番号で選び、送り先(一度選ぶと atlas.config.json に覚える)を毎回確かめてから <送り先>/<プロジェクト名>/<id>/ に写す。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjects, projectTarget } from '../src/group-upload.ts';
import { runUploadProject, type UploadProjectIo } from '../src/upload-project.ts';

describe('プロジェクトのセッションをまとめて送る', () => {
  let dir: string;
  let out: string;
  let configPath: string;
  let rootA: string;
  let rootB: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-upp-'));
    out = join(dir, 'out');
    configPath = join(dir, 'atlas.config.json');
    rootA = join(dir, 'logs-a');
    rootB = join(dir, 'logs-b');
    await mkdir(rootA);
    await mkdir(rootB);
    const sessions = [
      { id: 's1', project: 'owner/app', empty: false, updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 's2', project: 'owner/app', empty: false, updatedAt: '2026-11-03T00:00:00.000Z' },
      { id: 's3', project: 'owner/app', empty: true, updatedAt: '2026-11-04T00:00:00.000Z' },
      { id: 's4', project: 'X:\\work\\tool', empty: false, updatedAt: '2026-10-01T00:00:00.000Z' },
    ];
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'sessions.json'), JSON.stringify({ sessions }));
    for (const s of sessions) {
      await mkdir(join(out, 'snapshot', 'session-state', s.id), { recursive: true });
      await writeFile(join(out, 'snapshot', 'session-state', s.id, 'events.jsonl'), `{"id":"${s.id}"}\n`);
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const paths = () => ({ snapshot: join(out, 'snapshot'), groups: join(dir, 'notes', 'groups.json'), sessions: join(out, 'sessions.json') });
  /** 答えを順に返し、選ぶ画面は picks を順に返す */
  const fakeIo = (answers: string[], picks: (string | null)[]) => {
    const printed: string[] = [];
    const asked: string[] = [];
    const pickedFrom: (string | null)[] = [];
    const io: UploadProjectIo = {
      ask: async (q) => (asked.push(q), answers.shift() ?? ''),
      print: (l) => printed.push(l),
      pick: async (initial) => (pickedFrom.push(initial), picks.shift() ?? null),
    };
    return { io, printed, asked, pickedFrom };
  };

  it('プロジェクトは空のセッションを数えず、多い順に並ぶ', async () => {
    expect(await listProjects(join(out, 'sessions.json'))).toEqual([
      { name: 'owner/app', sessions: 2, updatedAt: '2026-11-03T00:00:00.000Z' },
      { name: 'X:\\work\\tool', sessions: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    expect((await projectTarget(join(out, 'sessions.json'), 'owner/app')).ids).toEqual(['s1', 's2']);
    await expect(projectTarget(join(out, 'sessions.json'), '無い')).rejects.toThrow(/前回の集計にありません/);
  });

  it('何も選ばなければ何も送らず、送り先も尋ねない', async () => {
    const f = fakeIo([''], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(false);
    expect(f.pickedFrom).toEqual([]);
    expect(f.printed.join('\n')).toMatch(/1\. owner\/app {2}2 件/);
  });

  it('タグの無いセッションも送り、各セッションのタスクタグを README・索引・セッションのフォルダに書く(人と AI がタスクを見分けられる)', async () => {
    await mkdir(join(dir, 'notes'), { recursive: true });
    // s1 は 2 つのタスクタグ、s2 はタグなし。別のプロジェクトの s4 のタグは関係ない
    await writeFile(
      join(dir, 'notes', 'groups.json'),
      JSON.stringify({ version: 1, groups: [{ name: 'Player-Weapon', note: '', ids: ['s1', 's4'] }, { name: '調査', note: '', ids: ['s1'] }] }),
    );
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA }));
    expect(await runUploadProject(fakeIo(['1', 'y'], []).io, { paths: paths(), configPath })).toBe(true);
    const dest = join(rootA, 'owner_app');
    const index = JSON.parse(await readFile(join(dest, 'atlas-index.json'), 'utf8'));
    expect(index).toMatchObject({ version: 1, kind: 'project', name: 'owner/app', missing: [] });
    expect(index.sessions.map((s: { id: string; tags: string[] }) => [s.id, s.tags])).toEqual([
      ['s1', ['Player-Weapon', '調査']],
      ['s2', []],
    ]);
    expect(JSON.parse(await readFile(join(dest, 's1', 'atlas-session.json'), 'utf8'))).toMatchObject({ version: 1, id: 's1', project: 'owner/app', tags: ['Player-Weapon', '調査'] });
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('| [s1](s1/) | - | Player-Weapon、調査 |');
    expect(readme).toContain('| [s2](s2/) | - | タグなし |');
    expect(readme).toMatch(/## タスクタグごと\n\n### Player-Weapon.1 件.\n\n- \[s1\]\(s1\/\)[\s\S]*### 調査.1 件.[\s\S]*### タグなし.1 件.\n\n- \[s2\]\(s2\/\)/);
  });

  it('送り先が未定ならエクスプローラーで選んで覚え、確かめてから送る。2 回目は覚えた送り先を見せて確かめる', async () => {
    const f = fakeIo(['1', 'y'], [rootA]);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(f.pickedFrom).toEqual([null]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: rootA });
    const dest = join(rootA, 'owner_app');
    expect((await readdir(dest)).sort()).toEqual(['README.md', 'atlas-index.json', 's1', 's2']);
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toMatch(/^# owner\/app\n\n集計のプロジェクト「owner\/app」のセッション/);
    expect(f.printed.join('\n')).toContain(`送り先: ${dest}`);
    // 2 回目: 選ぶ画面は出さず、覚えた送り先で確かめる。やめれば送らない
    await rm(dest, { recursive: true });
    const g = fakeIo(['owner/app', ''], []);
    expect(await runUploadProject(g.io, { paths: paths(), configPath })).toBe(false);
    expect(g.pickedFrom).toEqual([]);
    expect(g.printed.join('\n')).toContain(`送り先: ${dest}`);
    expect(existsSync(dest)).toBe(false);
  });

  it('確認で c なら送り先を選び直して覚え、新しい送り先で確かめ直す。送り先を選ばなければ何も送らない', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA }));
    const f = fakeIo(['2', 'c', 'y'], [rootB]);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(f.pickedFrom).toEqual([rootA]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: rootB });
    expect(existsSync(join(rootB, 'X__work_tool', 's4', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
    // 送り先が未定で、選ぶ画面を取り消したら何も送らない
    await rm(configPath);
    const g = fakeIo(['1'], [null]);
    expect(await runUploadProject(g.io, { paths: paths(), configPath })).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    // 当たらない番号は止まる
    await expect(runUploadProject(fakeIo(['9'], []).io, { paths: paths(), configPath })).rejects.toThrow(/当たるプロジェクトがありません/);
  });
});
