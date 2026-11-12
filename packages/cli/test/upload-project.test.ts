// プロジェクトのセッションをまとめて送る(upload-project.bat → upload-project.ts)。
// 集計のプロジェクトを番号で選び、送り先(一度選ぶと atlas.config.json に覚える)を毎回確かめてから <送り先>/<プロジェクト名>/<id>/ に写す。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTarget, listProjects, openUploadContext, projectTarget, uploadGroup, uploadTarget } from '../src/group-upload.ts';
import {
  AutoUploadBlockedError,
  consoleIo,
  fit,
  parseNumbers,
  refreshAggregate,
  runUploadProject,
  UploadIncompleteError,
  width,
  type UploadProjectIo,
  type UploadSummary,
} from '../src/upload-project.ts';

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
      { id: 's1', project: 'owner/app', projectSource: 'git-remote', empty: false, updatedAt: '2026-11-01T00:00:00.000Z' },
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

  it('プロジェクトは空のセッションを数えず、多い順に並ぶ。ログのフォルダが無いもの(DB にだけ記録)は送れない件数として分ける', async () => {
    expect(await listProjects(join(out, 'sessions.json'))).toEqual([
      { name: 'owner/app', sessions: 2, noLog: 0, updatedAt: '2026-11-03T00:00:00.000Z' },
      { name: 'X:\\work\\tool', sessions: 1, noLog: 0, updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    expect((await projectTarget(paths(), 'owner/app')).ids).toEqual(['s1', 's2']);
    await expect(projectTarget(paths(), '無い')).rejects.toThrow(/前回の集計にありません/);
    // s2 のログのフォルダが無いとき: 一覧の件数と送るものが揃い、送れない件数を出す
    await rm(join(out, 'snapshot', 'session-state', 's2'), { recursive: true });
    expect((await listProjects(join(out, 'sessions.json'), join(out, 'snapshot')))[0]).toMatchObject({ name: 'owner/app', sessions: 1, noLog: 1, updatedAt: '2026-11-01T00:00:00.000Z' });
    expect((await projectTarget(paths(), 'owner/app')).ids).toEqual(['s1']);
    const f = fakeIo([''], []);
    await runUploadProject(f.io, { paths: paths(), configPath });
    expect(f.printed.join('\n')).toMatch(/1\. owner\/app +1 セッション +最終更新 2026-11-01\(ほかに、ログが無くて送れないもの 1 件\)/);
  });

  it('フォルダ名が同じになるタスクタグがあっても、まだ送っていなければ送れる。送り先にそのタグがすでに送られていれば送らない(README と索引が上書きし合うため)', async () => {
    await mkdir(join(dir, 'notes'), { recursive: true });
    // フォルダ名が owner_app になるタスクタグ(0 件のときも、まだ送っていないときも、プロジェクトを止めない)
    await writeFile(join(dir, 'notes', 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'owner_app', note: '', ids: ['s4'] }] }));
    const target = await projectTarget(paths(), 'owner/app');
    expect(await checkTarget(paths(), target, rootA)).toMatchObject({ sessions: 2 });
    // そのタグを先に送っておくと、同じフォルダにプロジェクトは送らない
    await uploadGroup(paths(), 'owner_app', rootA);
    await expect(checkTarget(paths(), target, rootA)).rejects.toThrow(/タスクタグ「owner_app」がすでに送られています/);
    await expect(uploadTarget(paths(), target, rootA)).rejects.toThrow(/混ざるので写しません/);
    expect((await readdir(join(rootA, 'owner_app'))).sort()).toEqual(['README.md', 'atlas-index.json', 's4']);
    // 同じプロジェクトを送り直すのは止めない
    await rm(join(rootA, 'owner_app'), { recursive: true });
    await uploadTarget(paths(), target, rootA);
    expect((await uploadTarget(paths(), target, rootA)).replaced).toBe(2);
  });

  it('確かめてから送るまでの間にログが変わったら(集計し直したなど)、写さずにもう一度確かめる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA }));
    const answers = ['1', 'y', ''];
    let changed = false;
    const printed: string[] = [];
    const io: UploadProjectIo = {
      ask: async (q) => {
        // 1 回目の「y = 送る…」を待っている間に、ログに鍵が書き足される
        if (/y = 送る/.test(q) && !changed) {
          changed = true;
          const token = ['ghp', 'CHANGEDFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'].join('_');
          await writeFile(join(out, 'snapshot', 'session-state', 's1', 'events.jsonl'), JSON.stringify({ data: token }) + '\n');
        }
        return answers.shift() ?? '';
      },
      print: (l) => printed.push(l),
      pick: async () => null,
    };
    expect(await runUploadProject(io, { paths: paths(), configPath })).toBe(false);
    const text = printed.join('\n');
    expect(text).toContain('確かめた後に、写すログが変わりました');
    // 確かめ直したときには、書き足された鍵が出る
    expect(text).toMatch(/秘密らしい文字列が 1 件あります/);
    expect(existsSync(join(rootA, 'owner_app'))).toBe(false);
  });

  it('覚えた送り先が無くなっていたら、選び直して送れる(選ばなければ何も送らない)', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: join(dir, 'gone') }));
    const f = fakeIo(['1', 'y'], [rootB]);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(f.printed.join('\n')).toContain('覚えている送り先が見つかりません');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: rootB });
    expect(existsSync(join(rootB, 'owner_app', 's1'))).toBe(true);
  });

  it('集計し直している最中(out/.job.json を別の生きている処理が持つ)は送らずに止まる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA }));
    // 生きている別の処理として、このテストを動かしている親のプロセス
    await writeFile(join(out, '.job.json'), JSON.stringify({ pid: process.ppid, kind: 'refresh', by: 'serve', startedAt: new Date().toISOString() }));
    await expect(runUploadProject(fakeIo(['1', 'y'], []).io, { paths: paths(), configPath })).rejects.toThrow(/動いています.*何も送っていません/);
    expect(existsSync(join(rootA, 'owner_app'))).toBe(false);
  });

  it('何も選ばなければ何も送らず、送り先も尋ねない', async () => {
    const f = fakeIo([''], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(false);
    expect(f.pickedFrom).toEqual([]);
    expect(f.printed.join('\n')).toMatch(/1\. owner\/app +2 セッション/);
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
    expect(JSON.parse(await readFile(join(dest, 's1', 'atlas-session.json'), 'utf8'))).toMatchObject({ version: 1, id: 's1', project: 'owner/app', projectSource: 'git-remote', tags: ['Player-Weapon', '調査'] });
    // プロジェクト名の決め方も添える(集計し直す側が、名前とこれをそのまま使う)。集計の記録に無ければ null
    expect(JSON.parse(await readFile(join(dest, 's2', 'atlas-session.json'), 'utf8'))).toMatchObject({ id: 's2', project: 'owner/app', projectSource: null });
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
    // 当たらない番号は、集計からやり直しにならないよう尋ね直す(何も入れなければやめる)
    const h = fakeIo(['9', '3-1', ''], []);
    expect(await runUploadProject(h.io, { paths: paths(), configPath })).toBe(false);
    expect(h.printed.join('\n')).toContain('「9」に当たるプロジェクトがありません。一覧の番号(1〜2)か名前を入れ直してください。');
    expect(h.printed.join('\n')).toContain('「3-1」に当たるプロジェクトがありません');
    expect(h.asked.filter((q) => /番号を入れて Enter/.test(q))).toHaveLength(3);
  });

  it('番号は「1 3 5-8」「1,3」のように複数選べる(全角も可。入力の順・重複なし)。読めない・範囲の外は null', () => {
    expect(parseNumbers('1 3 5-8', 9)).toEqual([1, 3, 5, 6, 7, 8]);
    expect(parseNumbers('3,1、3', 3)).toEqual([3, 1]);
    expect(parseNumbers('２ １－２', 2)).toEqual([2, 1]);
    // 区切りの前後の空白は許す
    expect(parseNumbers('1, 2 - 3', 3)).toEqual([1, 2, 3]);
    expect(parseNumbers('3 〜 3', 3)).toEqual([3]);
    for (const bad of ['0', '4', '2-1', '1-4', 'a', '1 x', '', '-1']) expect(parseNumbers(bad, 3)).toBeNull();
  });

  it('番号を複数選ぶと、まとめて確かめてから(プロジェクトごとの行と合計)すべて送る。毎回選ばずに済む方法を知らせる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA }));
    const f = fakeIo(['1 2', 'y'], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(existsSync(join(rootA, 'owner_app', 's2', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(rootA, 'X__work_tool', 's4', 'events.jsonl'))).toBe(true);
    const text = f.printed.join('\n');
    expect(text).toContain('毎回同じものを送るなら');
    expect(text).toContain('== 送る前の確認 ==');
    expect(text).toContain(`送り先: ${rootA}(この中にプロジェクトごとのフォルダを作ります)`);
    expect(text).toMatch(/1\. owner\/app +2 セッション/);
    expect(text).toMatch(/2\. X:\\work\\tool +1 セッション/);
    expect(text).toMatch(/合計 +3 セッション/);
    expect(text).toMatch(/\[1\/2\] owner\/app +2 セッションを送りました/);
    expect(text).toMatch(/\[2\/2\] X:\\work\\tool +1 セッションを送りました/);
    expect(text).toContain('== 終わりました ==');
    expect(text).toContain('2 プロジェクト・3 セッションを送りました。');
    expect(text).toContain('それぞれのフォルダの README.md');
    // 写している途中の様子は、行を増やして出さない(io.status が無い = 端末でないときは出さない)
    expect(text).not.toMatch(/ \/ \d+ セッション/);
    // 2 回目は置き換えの件数を合計に出す
    const g = fakeIo(['1-2', ''], []);
    expect(await runUploadProject(g.io, { paths: paths(), configPath })).toBe(false);
    expect(g.printed.join('\n')).toMatch(/合計 +3 セッション[\s\S]*うち 3 セッションは、前に送ったものを置き換えます。/);
  });

  it('画面で印を付けたプロジェクト(uploadProjects)は番号を聞かずに送る。印の無いものは送らずに名前を出し、今の集計に無いものも知らせる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['X:\\work\\tool', '消えたプロジェクト'] }));
    const f = fakeIo(['y'], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(f.asked.some((q) => /番号を入れて Enter/.test(q))).toBe(false);
    expect(existsSync(join(rootA, 'X__work_tool', 's4'))).toBe(true);
    expect(existsSync(join(rootA, 'owner_app'))).toBe(false);
    const text = f.printed.join('\n');
    expect(text).toContain('画面で印を付けた 1 プロジェクトを送ります。');
    expect(text).toContain('印はあるが、送れるセッションが無いもの: 消えたプロジェクト');
    expect(text).toContain('印の無い 1 プロジェクトは送りません(最近更新: owner/app)。');
    // 1 プロジェクトだけなら、送り先はそのプロジェクトのフォルダで見せる
    expect(text).toContain(`送り先: ${join(rootA, 'X__work_tool')}`);
    expect(text).not.toContain('毎回同じものを送るなら');
  });

  it('自動で送る(auto): 印のあるプロジェクトを、覚えた送り先へ、何も尋ねずに送る。送ったものと秘密らしい文字列の数を summary に書く', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const token = ['ghp', 'AUTOFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'].join('_');
    await writeFile(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), JSON.stringify({ data: token }) + '\n');
    const f = fakeIo([], []);
    const summary: UploadSummary = { sent: [], secrets: 0, root: null };
    expect(await runUploadProject(f.io, { paths: paths(), configPath, auto: true, summary })).toBe(true);
    expect(f.asked).toEqual([]);
    expect(f.pickedFrom).toEqual([]);
    expect(summary).toEqual({ sent: [{ name: 'owner/app', sessions: 2 }, { name: 'X:\\work\\tool', sessions: 1 }], secrets: 1, root: rootA });
    expect(existsSync(join(rootA, 'owner_app', 's2'))).toBe(true);
    expect(existsSync(join(rootA, 'X__work_tool', 's4'))).toBe(true);
    const text = f.printed.join('\n');
    expect(text).toContain('印を付けた 2 プロジェクトを送ります: owner/app、X:\\work\\tool');
    // 記録には確認と同じ中身(秘密らしい文字列の注意も)を残す
    expect(text).toMatch(/秘密らしい文字列が 1 件あります/);
    expect(text).toContain('== 終わりました ==');
    expect(text).not.toContain('毎回同じものを送るなら');
  });

  it('自動で送る(auto): 印の無い新しいプロジェクトは送らずに、最近更新したものの名前を記録に残す', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['X:\\work\\tool'] }));
    const f = fakeIo([], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath, auto: true })).toBe(true);
    expect(f.printed.join('\n')).toContain('印の無い 1 プロジェクトは送りません(最近更新: owner/app)。');
    expect(existsSync(join(rootA, 'owner_app'))).toBe(false);
  });

  it.each([
    ['印が無い', { uploadRoot: 'ROOT' }, /印がありません/],
    ['印を付けたものが今の集計に無い', { uploadRoot: 'ROOT', uploadProjects: ['消えたプロジェクト'] }, /今送れるセッションがありません/],
    ['送り先が決まっていない', { uploadProjects: ['owner/app'] }, /送り先がまだ決まっていません/],
    ['覚えた送り先が見つからない', { uploadRoot: 'GONE', uploadProjects: ['owner/app'] }, /覚えている送り先が見つかりません/],
  ])('自動で送る(auto): %s ときは、尋ねずに AutoUploadBlockedError で止まり、何も送らない', async (_, cfg, message) => {
    const c = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v === 'ROOT' ? rootA : v === 'GONE' ? join(dir, 'gone') : v]));
    await writeFile(configPath, JSON.stringify(c));
    const f = fakeIo([], []);
    const run = runUploadProject(f.io, { paths: paths(), configPath, auto: true });
    await expect(run).rejects.toThrow(AutoUploadBlockedError);
    await expect(run).rejects.toThrow(message);
    expect(f.asked).toEqual([]);
    expect(f.pickedFrom).toEqual([]);
    expect(await readdir(rootA)).toEqual([]);
  });

  it('印のあるときは一覧を出さないので、ログが無くて送れないセッションの数を知らせる', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: unknown[] };
    s.sessions.push({ id: 's6', project: 'X:\\work\\tool', empty: false, updatedAt: '2026-09-01T00:00:00.000Z' });
    await writeFile(join(out, 'sessions.json'), JSON.stringify(s));
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['X:\\work\\tool'] }));
    const f = fakeIo([''], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(false);
    expect(f.printed.join('\n')).toContain('このほかに、ログが無くて送れないセッションが 1 件あります(送りません)。');
  });

  it('印を付けたものが今 1 件も送れなければ、番号で選んで送れる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['消えたプロジェクト'] }));
    const f = fakeIo(['1', 'y'], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(f.printed.join('\n')).toContain('印を付けたプロジェクトに、今送れるものがありません。番号で選んでください。');
    expect(existsSync(join(rootA, 'owner_app', 's1'))).toBe(true);
  });

  it('フォルダ名が同じになるプロジェクトを一度に選ぶと、何も送らずに止まる', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: unknown[] };
    s.sessions.push({ id: 's5', project: 'owner_app', empty: false, updatedAt: '2026-09-01T00:00:00.000Z' });
    await writeFile(join(out, 'sessions.json'), JSON.stringify(s));
    await mkdir(join(out, 'snapshot', 'session-state', 's5'), { recursive: true });
    await writeFile(join(out, 'snapshot', 'session-state', 's5', 'events.jsonl'), '{}\n');
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'owner_app'] }));
    await expect(runUploadProject(fakeIo(['y'], []).io, { paths: paths(), configPath })).rejects.toThrow(/「owner\/app」と「owner_app」は、送り先のフォルダ名が同じ「owner_app」.*何も送っていません/);
    expect(await readdir(rootA)).toEqual([]);
  });

  it('1 つ送れなくても残りは送り、送れなかったものを知らせて止まる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    // owner/app の送り先にフォルダを作れない(同じ名前のファイルがある)
    await writeFile(join(rootA, 'owner_app'), 'ファイル');
    const f = fakeIo(['y'], []);
    await expect(runUploadProject(f.io, { paths: paths(), configPath })).rejects.toThrow(/1 プロジェクトを送れませんでした.*送れたのは 1 プロジェクト/);
    const text = f.printed.join('\n');
    expect(text).toMatch(/\[1\/2\] owner\/app +送れませんでした: /);
    expect(text).toContain('== 送れなかったものがあります ==');
    expect(text).toMatch(/送れなかったプロジェクト.1 件.: owner\/app/);
    expect(existsSync(join(rootA, 'X__work_tool', 's4', 'events.jsonl'))).toBe(true);
  });

  it('確認で n なら、印は変えずに今回送るものだけを番号で選び直せる(何も選ばなければやめる)', async () => {
    const config = { uploadRoot: rootA, uploadProjects: ['X:\\work\\tool'] };
    await writeFile(configPath, JSON.stringify(config));
    const f = fakeIo(['n', '1', 'y'], []);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(existsSync(join(rootA, 'owner_app', 's1'))).toBe(true);
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(config);
    const text = f.printed.join('\n');
    // 1 プロジェクトなら、確認にそのプロジェクトの名前を出す(選び直した後は、選び直したもの)
    const [, first, second] = text.split('== 送る前の確認 ==');
    expect(first).toContain('X:\\work\\tool: 1 セッション');
    expect(second).toContain('owner/app: 2 セッション');
    const g = fakeIo(['n', ''], []);
    expect(await runUploadProject(g.io, { paths: paths(), configPath })).toBe(false);
    expect(g.printed.join('\n')).toContain('やめました(何も送っていません)。');
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
  });

  it('まとめて送る途中で中身が変わったら、送ったものは除いて残りだけを確かめ直す', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const f = fakeIo(['y', 'y'], []);
    const print = f.io.print;
    f.io.print = (l) => {
      print(l);
      // 1 つ目を送り終えたところで、2 つ目のログが書き足される
      if (/owner\/app +2 セッションを送りました/.test(l)) writeFileSync(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), '{"id":"s4"}\n{"more":1}\n');
    };
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    const text = f.printed.join('\n');
    expect(text).toContain('確かめた後に、写すログが変わりました');
    // 確かめ直すのは残りの 1 つだけ(送ったものは送り直さない)
    const [, first, second] = text.split('== 送る前の確認 ==');
    expect(first).toMatch(/1\. owner\/app +2 セッション[\s\S]*2\. X:\\work\\tool +1 セッション/);
    expect(second).toContain('X:\\work\\tool: 1 セッション');
    expect(second).not.toContain('owner/app');
    expect(f.printed.filter((l) => /セッションを送りました(\(.*\))?$/.test(l))).toHaveLength(2);
    expect(f.asked.filter((q) => /y = 送る/.test(q))).toHaveLength(2);
    expect(await readFile(join(rootA, 'X__work_tool', 's4', 'events.jsonl'), 'utf8')).toContain('more');
  });

  it('送る途中で確かめ直しになり、そこでやめたら「途中でやめました」と残りを出す(「終わりました」とは出さない)', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const f = fakeIo(['y', ''], []);
    const print = f.io.print;
    f.io.print = (l) => {
      print(l);
      if (/owner\/app +2 セッションを送りました/.test(l)) writeFileSync(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), '{"id":"s4"}\n{"more":1}\n');
    };
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(false);
    const text = f.printed.join('\n');
    expect(text).toContain('== 途中でやめました ==');
    // 残りはまとめにだけ出す(やめたときの行と 2 度書かない)
    expect(text.match(/送っていません/g)).toHaveLength(1);
    expect(text).not.toContain('== 終わりました ==');
    expect(text).toContain('1 プロジェクト・2 セッションを送りました。');
    expect(text).toContain('残りの 1 プロジェクト(X:\\work\\tool)は送っていません。');
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
  });

  it('送る途中で確かめ直しになり、n で選び直してから何も選ばずにやめても、残りはまとめに 1 度だけ出す', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const f = fakeIo(['y', 'n', ''], []);
    const print = f.io.print;
    f.io.print = (l) => {
      print(l);
      if (/owner\/app +2 セッションを送りました/.test(l)) writeFileSync(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), '{"id":"s4"}\n{"more":1}\n');
    };
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(false);
    const text = f.printed.join('\n');
    expect(text).toContain('== 途中でやめました ==');
    expect(text).toContain('  やめました。');
    expect(text.match(/送っていません/g)).toHaveLength(1);
    expect(text).toContain('残りの 1 プロジェクト(X:\\work\\tool)は送っていません。');
  });

  it('送れなかったものがあるときも、確かめ直しでやめた残りを「送っていません」と出す(送れなかったものと取り違えない)', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    // owner/app は送れない(送り先に同じ名前のファイルがある)。その後で 2 つ目のログが変わり、確かめ直しでやめる
    await writeFile(join(rootA, 'owner_app'), 'ファイル');
    const f = fakeIo(['y', ''], []);
    const print = f.io.print;
    f.io.print = (l) => {
      print(l);
      if (/owner\/app +送れませんでした/.test(l)) writeFileSync(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), '{"id":"s4"}\n{"more":1}\n');
    };
    await expect(runUploadProject(f.io, { paths: paths(), configPath })).rejects.toBeInstanceOf(UploadIncompleteError);
    const text = f.printed.join('\n');
    expect(text).toContain('== 送れなかったものがあります ==');
    expect(text).toContain('  やめました。');
    expect(text).toContain('残りの 1 プロジェクト(X:\\work\\tool)は送っていません。');
    expect(text).toMatch(/送れなかったプロジェクト.1 件.: owner\/app/);
    expect(text.match(/送っていません/g)).toHaveLength(1);
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
  });

  it('途中で止まっても(確かめ直すときに、画面で集計し直している最中など)、ここまでに送ったものを知らせる', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const f = fakeIo(['y'], []);
    const print = f.io.print;
    f.io.print = (l) => {
      print(l);
      if (/owner\/app +2 セッションを送りました/.test(l)) {
        // 2 つ目のログが変わり(確かめ直しになる)、その間に画面の「集計し直す」が始まる(生きている別の処理がロックを持つ)
        writeFileSync(join(out, 'snapshot', 'session-state', 's4', 'events.jsonl'), '{"changed":1}\n');
        writeFileSync(join(out, '.job.json'), JSON.stringify({ pid: process.ppid, kind: 'refresh', by: 'serve', startedAt: new Date().toISOString() }));
      }
    };
    await expect(runUploadProject(f.io, { paths: paths(), configPath })).rejects.toThrow(/動いています.*ここまでに 1 プロジェクトを送りました\(owner\/app\)。残りは送っていません/);
    expect(f.printed.join('\n')).toContain('そのフォルダの README.md にあります');
    expect(existsSync(join(rootA, 'owner_app', 's1'))).toBe(true);
    expect(existsSync(join(rootA, 'X__work_tool'))).toBe(false);
  });

  it('調べている・写している途中の様子は io.status に出し(行を増やさない)、送った結果は 1 プロジェクト 1 行で print に出す', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app', 'X:\\work\\tool'] }));
    const f = fakeIo(['y'], []);
    const statuses: string[] = [];
    f.io.status = (t) => statuses.push(t);
    expect(await runUploadProject(f.io, { paths: paths(), configPath })).toBe(true);
    expect(statuses[0]).toContain('調べています');
    expect(statuses.some((s) => /\[1\/2\] owner\/app +\d \/ 2 セッション/.test(s))).toBe(true);
    expect(statuses.some((s) => /\[2\/2\] X:\\work\\tool +\d \/ 1 セッション/.test(s))).toBe(true);
    expect(f.printed.join('\n')).not.toMatch(/調べています| \/ \d+ セッション/);
    expect(f.printed.filter((l) => /セッションを送りました(\(.*\))?$/.test(l))).toHaveLength(2);
  });

  it('送れなかったものがあれば、画面に出した上で UploadIncompleteError で止まる(bat で同じことを 2 度出さない)', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: rootA, uploadProjects: ['owner/app'] }));
    await writeFile(join(rootA, 'owner_app'), 'ファイル');
    await expect(runUploadProject(fakeIo(['y'], []).io, { paths: paths(), configPath })).rejects.toBeInstanceOf(UploadIncompleteError);
  });

  it('画面での幅は全角を 2 と数え、1 行に収めるときは全角の途中で切らない', () => {
    expect(width('owner/app')).toBe(9);
    expect(width('送り先(abc)')).toBe(11);
    expect(width('ＡＢ')).toBe(4);
    expect(fit('写しています abc', 7)).toBe('写して');
    expect(fit('abc', 10)).toBe('abc');
    // 絵文字は全角の範囲の外でも 2、結合する記号・ZWJ は 0、U+FE0F が付くと 2
    expect(width('☕a')).toBe(3);
    expect(width('✅')).toBe(2);
    expect(width('✔️')).toBe(2);
    expect(width('é')).toBe(1);
    expect(width('a‍b')).toBe(2);
    expect(fit('☕☕', 3)).toBe('☕');
    expect(width(fit('✔️✔️✔️', 5))).toBeLessThanOrEqual(5);
    // 1 つの絵文字として出るもの(国旗・ZWJ でつないだもの)は全体で 2
    expect(width('🇯🇵')).toBe(2);
    expect(width('🇯🇵🇺🇸')).toBe(4);
    expect(width('👨‍👩‍👧')).toBe(2);
    expect(width('a👨‍👩b')).toBe(4);
    // 肌の色の修飾は前の絵文字に重なる(前に絵文字が無ければ、それだけで 2)。ソフトハイフン(U+00AD)は端末では 1 桁
    expect(width('👍🏽')).toBe(2);
    expect(width('👋🏻a')).toBe(3);
    expect(width('🏽')).toBe(2);
    expect(width('a­b')).toBe(3);
    expect(width(fit('👍🏽👍🏽👍🏽', 5))).toBe(4);
    // 修飾を受けない文字(漢字・英字)の後ろの修飾は、重ならずにそれだけで 2。修飾を受ける 1 桁の記号(☝)の後ろなら、合わせて 2
    expect(width('漢🏽')).toBe(4);
    expect(width('a🏽')).toBe(3);
    expect(width('☝🏽')).toBe(2);
    expect(width('👍🏽🏽')).toBe(4);
  });

  it('集計し直すとき: 段階の頭が無い行はその文のまま status に出し、console の警告は窓に出さずに経過のファイルに書いて、あったことを 1 行で知らせる', async () => {
    const logPath = join(dir, 'upload.log');
    const statuses: string[] = [];
    const f = fakeIo([], []);
    f.io.status = (t) => statuses.push(t);
    const warn = console.warn;
    const ok = await refreshAggregate(f.io, {
      logPath,
      run: async (log) => {
        log('レポートのテンプレートをビルドしています(初回またはソース更新時のみ)…');
        console.warn('\x1b[33m(!) Some chunks are larger than 500 kB\x1b[39m');
        console.log('vite v7 building for production...');
      },
    });
    expect(ok).toBe(true);
    expect(console.warn).toBe(warn);
    expect(statuses).toContain('  レポートのテンプレートをビルドしています(初回またはソース更新時のみ)…');
    expect(f.printed.join('\n')).not.toContain('Some chunks');
    // 知らせるのは「集計しました」の前
    expect(f.printed.slice(-2)).toEqual([`  集計の途中で警告が出ました(経過のファイルに書きました): ${logPath}`, '  集計しました。']);
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('警告: (!) Some chunks are larger than 500 kB\n');
    expect(text).toContain('vite v7 building for production...');
  });

  it('集計し直すとき: 窓に出す注意は、ログを写す段階のもの(行の頭が「snapshot: 注意」)だけ。ほかの段階の注意や、文の途中の「注意」は経過のファイルにだけ書く', async () => {
    const logPath = join(dir, 'upload.log');
    const f = fakeIo([], []);
    const ok = await refreshAggregate(f.io, {
      logPath,
      run: async (log) => {
        log('snapshot: 3 セッションを複製(注意 1 件は前回の複製)');
        log('extract: 注意 読めない行が 2 行ありました');
        log('export: 注意 記録の中の秘密らしい文字列を 5 件伏せました');
        log('snapshot: 注意 session-store.db を\n今回は複製できませんでした');
      },
    });
    expect(ok).toBe(true);
    // 改行のある文は 1 行にして出す
    expect(f.printed.filter((l) => l.includes('注意'))).toEqual(['  注意: session-store.db を 今回は複製できませんでした']);
    expect(f.printed.join('\n')).not.toContain('警告');
    const text = readFileSync(logPath, 'utf8');
    for (const kept of ['複製(注意 1 件は前回の複製)', 'extract: 注意 読めない行が 2 行ありました', 'export: 注意 記録の中の秘密らしい文字列を 5 件伏せました']) expect(text).toContain(kept);
  });

  it('集計し直すとき: 標準出力・エラー出力に直に書かれたものと console.debug も、窓に出さずに経過のファイルに書く(終わったら書く口を元に戻す)', async () => {
    const logPath = join(dir, 'upload.log');
    const f = fakeIo([], []);
    const saved = { out: process.stdout.write, err: process.stderr.write, debug: console.debug };
    let called = 0;
    const ok = await refreshAggregate(f.io, {
      logPath,
      run: async () => {
        process.stderr.write('(node:1234) ExperimentalWarning: SQLite is an experimental feature\n', () => called++);
        process.stdout.write(Buffer.from('直に書いた行\n'));
        console.debug('細かい記録 %d', 7);
      },
    });
    expect(ok).toBe(true);
    expect(called).toBe(1);
    expect(process.stdout.write).toBe(saved.out);
    expect(process.stderr.write).toBe(saved.err);
    expect(console.debug).toBe(saved.debug);
    expect(f.printed.join('\n')).not.toMatch(/ExperimentalWarning|直に書いた行|細かい記録/);
    expect(f.printed).toContain(`  集計の途中で警告が出ました(経過のファイルに書きました): ${logPath}`);
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('警告: (node:1234) ExperimentalWarning: SQLite is an experimental feature\n');
    expect(text).toContain('直に書いた行\n');
    expect(text).toContain('細かい記録 7\n');
  });

  it('集計し直すとき: 経過は 1 行ごとにその場でファイルに書く(途中で窓を閉じても残る)。段階の頭が無い文に改行があっても status は 1 行', async () => {
    const logPath = join(dir, 'upload.log');
    const statuses: string[] = [];
    const f = fakeIo([], []);
    f.io.status = (t) => statuses.push(t);
    let during = '';
    await refreshAggregate(f.io, {
      logPath,
      run: async (log) => {
        log('snapshot: 始めます');
        log('レポートを\r\n作って\tいます');
        during = readFileSync(logPath, 'utf8');
      },
    });
    expect(during).toBe('snapshot: 始めます\nレポートを\r\n作って\tいます\n');
    expect(statuses).toEqual(['  ログを写しています...', '  レポートを 作って います']);
  });

  it('集計し直すとき: 経過の行はファイルに書いて窓には出さず、段階は status に、注意は窓に出す', async () => {
    const logPath = join(dir, 'upload.log');
    const statuses: string[] = [];
    const f = fakeIo([], []);
    f.io.status = (t) => statuses.push(t);
    const ok = await refreshAggregate(f.io, {
      logPath,
      run: async (log) => {
        log(`snapshot: ${join(dir, 'very', 'long', 'path')} に 3 セッションを複製`);
        log('snapshot: 注意 session-store.db を今回は複製できませんでした(前回の複製を使います)');
        log('build: atlas.html を書きました');
      },
    });
    expect(ok).toBe(true);
    const text = f.printed.join('\n');
    expect(text).toContain('  注意: session-store.db を今回は複製できませんでした(前回の複製を使います)');
    expect(text).toContain('集計しました。');
    expect(text).not.toContain('very');
    expect(statuses).toEqual(['  ログを写しています...', '  レポートを作っています...']);
    expect(readFileSync(logPath, 'utf8')).toContain('3 セッションを複製');
  });

  it('集計に失敗したら、理由と経過のファイルの場所を出して false(送る操作には進まない)', async () => {
    const logPath = join(dir, 'upload.log');
    const f = fakeIo([], []);
    const ok = await refreshAggregate(f.io, {
      logPath,
      run: async (log) => {
        log('snapshot: 始めます');
        throw new Error('画面から実行した集計が動いています');
      },
    });
    expect(ok).toBe(false);
    const text = f.printed.join('\n');
    expect(text).toContain('集計に失敗しました: 画面から実行した集計が動いています');
    expect(text).toContain(`集計の経過: ${logPath}`);
    // 経過のファイルには、どこで失敗したか(スタック)も残す。窓には出さない
    expect(readFileSync(logPath, 'utf8')).toMatch(/snapshot: 始めます\n失敗しました: 画面から実行した集計が動いています\n[\s\S]*\n\s+at /);
    expect(text).not.toMatch(/\n\s+at /);
    // 理由に改行があっても、窓には 1 行で出す
    const g = fakeIo([], []);
    await refreshAggregate(g.io, {
      logPath,
      run: async () => {
        throw new Error('1 行目\n2 行目');
      },
    });
    expect(g.printed).toContain('  集計に失敗しました: 1 行目 2 行目');
  });

  const tick = () => new Promise((r) => setImmediate(r));
  const fakeOut = (tty: boolean) => {
    const written: string[] = [];
    return { written, out: { isTTY: tty, columns: 20, write: (t: string) => (written.push(t), true) } };
  };

  it('黒い窓: 端末なら status で 1 行を窓の幅に収めて書き、次の print の前に消す。端末でなければ status を持たない', () => {
    const o = fakeOut(true);
    const c = consoleIo(async () => null, { input: new PassThrough(), output: o.out });
    c.io.status!(`  ${'あ'.repeat(30)}`);
    c.io.print('結果');
    c.close();
    const all = o.written.join('');
    // 20 桁の窓なら 19 桁まで(2 + 全角 8 文字 = 18)
    expect(o.written[0]).toBe(`  ${'あ'.repeat(8)}`);
    expect(all.indexOf('\x1b[2K')).toBeGreaterThan(all.indexOf('あ'));
    expect(all.endsWith('結果\n')).toBe(true);
    // 書き換える行が無ければ、消す制御文字は書かない
    const p = fakeOut(true);
    const d = consoleIo(async () => null, { input: new PassThrough(), output: p.out });
    d.io.print('a');
    d.close();
    expect(p.written).toEqual(['a\n']);
    const q = consoleIo(async () => null, { input: new PassThrough(), output: fakeOut(false).out });
    expect(q.io.status).toBeUndefined();
    q.close();
  });

  it('黒い窓: 入力が端末なら、尋ねる前に入った行(集計を待つ間の Enter)は捨てる。流し込んだ入力では順に答えに使う', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const c = consoleIo(async () => null, { input: tty, output: fakeOut(false).out });
    tty.write('\n');
    await tick();
    const a = c.io.ask('> ');
    tty.write('y\n');
    expect(await a).toBe('y');
    c.close();
    const pipe = new PassThrough();
    const d = consoleIo(async () => null, { input: pipe, output: fakeOut(false).out });
    pipe.write('1\ny\n');
    pipe.end();
    await tick();
    expect(await d.io.ask('> ')).toBe('1');
    expect(await d.io.ask('> ')).toBe('y');
    expect(await d.io.ask('> ')).toBe('');
    d.close();
  });

  it('黒い窓: 端末で、尋ねていない間に Enter が押されたら、写った行を消して書き換えていた 1 行を書き直す(進み具合の行が増えない)', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const o = fakeOut(true);
    const c = consoleIo(async () => null, { input: tty, output: o.out });
    c.io.status!('  ログを読んでいます...');
    o.written.length = 0;
    tty.write('\n');
    await tick();
    // 1 行上に戻り(CSI 1A)、その行を消して(CSI 2K)、行の頭から書き直す(20 桁の窓に収めた同じ文)
    expect(o.written.join('')).toBe(`\x1b[1A\x1b[2K\x1b[1G${fit('  ログを読んでいます...', 19)}`);
    c.close();
  });

  /** 1 文字ずつ受け取る状態(raw)に切り替えられる端末の偽物。modes は切り替えの履歴 */
  const fakeTty = () => {
    const modes: boolean[] = [];
    const tty = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (m: boolean) => (modes.push(m), tty) });
    return { tty, modes };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('黒い窓: 1 文字ずつ受け取れる端末では、尋ねていない間に打ったキーを Enter の有無に関わらず捨てる(次の答えの頭に付かない)。尋ねている間だけ行で受け取る', async () => {
    const { tty, modes } = fakeTty();
    const o = fakeOut(true);
    const c = consoleIo(async () => null, { input: tty, output: o.out, settleMs: 0 });
    expect(modes).toEqual([true]);
    c.io.status!('  ログを読んでいます...');
    o.written.length = 0;
    // 集計を待つ間: Enter を押していない文字と、Enter まで打った行
    tty.write('y');
    tty.write('z\r');
    await tick();
    // 端末は打った文字を写さないので、書き直すものは無い
    expect(o.written).toEqual([]);
    const a = c.io.ask('> ');
    // 尋ねた直後に届いた分(手が離せなかった間に打たれていたキー)も捨ててから、行で受け取る状態に戻す
    tty.write('x');
    await wait(20);
    expect(modes).toEqual([true, false]);
    tty.write('n\r\n');
    expect(await a).toBe('n');
    // 答えを受け取ったら、また捨てる状態に戻す
    expect(modes).toEqual([true, false, true]);
    tty.write('q\r');
    await tick();
    const b = c.io.ask('> ');
    await wait(20);
    tty.write('\r\n');
    expect(await b).toBe('');
    c.close();
    // 閉じるときは、端末を元の状態(行で受け取る)に戻す
    expect(modes.at(-1)).toBe(false);
  });

  it('黒い窓: 1 文字ずつ受け取る間の Ctrl+C は文字として届くので、端末を元に戻して終了コード 130 で終わる', async () => {
    const { tty, modes } = fakeTty();
    const exits: number[] = [];
    const o = fakeOut(true);
    const c = consoleIo(async () => null, { input: tty, output: o.out, settleMs: 0, exit: (code) => exits.push(code) });
    c.io.status!('  写しています...');
    tty.write('a');
    await tick();
    expect(exits).toEqual([]);
    o.written.length = 0;
    // SIGINT を聞いているものがあっても、そちらには回さずに自分で終わる(止まらないままにならない)
    let signaled = 0;
    const onSigint = (): void => void signaled++;
    process.on('SIGINT', onSigint);
    try {
      tty.write('\x03');
      await tick();
    } finally {
      process.off('SIGINT', onSigint);
    }
    expect(signaled).toBe(0);
    expect(exits).toEqual([130]);
    expect(modes).toEqual([true, false]);
    // 書き換えていた 1 行を消してから、中断したことを 1 行で出す
    expect(o.written.join('')).toMatch(/\x1b\[2K[^]*  中断しました。\n$/);
    expect(o.written.join('')).not.toContain('写しています');
    c.close();
  });

  it('黒い窓: 書く口は作ったときのものを使う(集計の間に差し替えられても、質問や結果は窓に出る)。status は改行を空白にして 1 行にする', () => {
    const o = fakeOut(true);
    const c = consoleIo(async () => null, { input: new PassThrough(), output: o.out });
    const stolen: string[] = [];
    o.out.write = (t: string) => (stolen.push(t), true);
    c.io.print('結果');
    c.io.status!('  1 行目\n2 行目');
    c.close();
    expect(stolen).toEqual([]);
    expect(o.written).toEqual(['結果\n', '  1 行目 2 行目']);
  });

  it('点検とアップロードは、渡した読む口を閉じずに使い回す(まとめて送るときに DB を開き直さない)', async () => {
    const ctx = await openUploadContext(paths());
    let closed = 0;
    const shared = { ...ctx, close: () => (closed++, ctx.close()) };
    const target = await projectTarget(paths(), 'owner/app');
    const c = await checkTarget(paths(), target, rootA, shared);
    await uploadTarget(paths(), target, rootA, () => {}, { context: shared, expect: c.fingerprint });
    expect(closed).toBe(0);
    shared.close();
    expect(closed).toBe(1);
    expect(existsSync(join(rootA, 'owner_app', 's2'))).toBe(true);
  });

  it('この PC で照合した VCS の結果(out/vcs-retention.json)を、セッションのフォルダに atlas-vcs.json として添える。送り先から集計したものは添えない', async () => {
    const result = (id: string) => ({
      sessionId: id,
      outcome: 'measured',
      vcs: 'git',
      root: 'X:\\zz',
      baseline: { rev: 'abc', source: 'observed' },
      evaluated: null,
      hunks: [{ id: 1, path: 'X:\\zz\\a.ts', status: 'kept', lines: { kept: 1, modified: 0, missing: 0, unattributable: 0 } }],
      excludedHunks: 0,
      counts: { kept: 1, modified: 0, missing: 0, unattributable: 0 },
      lines: { kept: 1, modified: 0, missing: 0, unattributable: 0 },
      provenance: { aiChanges: 'events', baseline: 'observed', context: {} },
    });
    const file = (computedOn: string) => ({ schemaVersion: 1, generatedAt: '2026-11-05T00:00:00.000Z', computedOn, mode: 'worktree', similarity: 0.75, pathMap: 0, summary: {}, sessions: [result('s1')] });
    await writeFile(join(out, 'vcs-retention.json'), JSON.stringify(file('local')));
    const target = await projectTarget(paths(), 'owner/app');
    const c = await checkTarget(paths(), target, rootA);
    await uploadTarget(paths(), target, rootA, () => {}, { expect: c.fingerprint });
    const sent = JSON.parse(await readFile(join(rootA, 'owner_app', 's1', 'atlas-vcs.json'), 'utf8'));
    expect(sent).toMatchObject({ version: 1, sessionId: 's1', computedAt: '2026-11-05T00:00:00.000Z', mode: 'worktree', result: { sessionId: 's1', outcome: 'measured' } });
    // 照合の結果に無いセッションには添えない
    expect(existsSync(join(rootA, 'owner_app', 's2', 'atlas-vcs.json'))).toBe(false);
    // 送り先から集計し直した out/ の結果(送った側のもの)は、この PC の結果ではないので添えない
    await writeFile(join(out, 'vcs-retention.json'), JSON.stringify(file('sender')));
    await uploadTarget(paths(), target, rootB);
    expect(existsSync(join(rootB, 'owner_app', 's1', 'atlas-vcs.json'))).toBe(false);
  });
});
