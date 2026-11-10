// プロジェクトのセッションをまとめて送る(upload-project.bat → upload-project.ts)。
// 集計のプロジェクトを番号で選び、送り先(一度選ぶと atlas.config.json に覚える)を毎回確かめてから <送り先>/<プロジェクト名>/<id>/ に写す。
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTarget, listProjects, openUploadContext, projectTarget, uploadGroup, uploadTarget } from '../src/group-upload.ts';
import { fit, parseNumbers, runUploadProject, UploadIncompleteError, width, type UploadProjectIo } from '../src/upload-project.ts';

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
});
