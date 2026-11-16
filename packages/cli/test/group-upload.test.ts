// グループのアップロード(uploadGroup と serve の API): 前回の集計の複製(out/snapshot/session-state/<id>/)を <基底>/<グループ名>/<id>/ に写す。
// 画面からはアップロード先を決め(エクスプローラーで選ぶ / パスを入力)、写し、写した先をエクスプローラーで開く。
// 通しの確認(集計し直して元と一致する)は e2e/phase15.test.ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStore, mergeSessionStoreJson, readSentInventory, snapshot } from '../../core/src/index.ts';
import { parseCli } from '../src/args.ts';
import { resolvePaths, runGroup } from '../src/commands.ts';
import { checkUpload, scanSecrets, storeKeyText, UploadChangedError, uploadDir, uploadGroup } from '../src/group-upload.ts';
import { startServe, TOKEN_PLACEHOLDER, type ServeHandle } from '../src/serve.ts';

describe('グループのアップロード', () => {
  let dir: string;
  let out: string;
  let notes: string;
  let root: string;
  let configPath: string;
  let h: ServeHandle | null = null;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-gup-'));
    out = join(dir, 'out');
    notes = join(dir, 'notes');
    root = join(dir, 'logs');
    configPath = join(dir, 'atlas.config.json');
    for (const id of ['s1', 's2']) {
      await mkdir(join(out, 'snapshot', 'session-state', id), { recursive: true });
      await writeFile(join(out, 'snapshot', 'session-state', id, 'events.jsonl'), `{"type":"session.start","id":"${id}"}\n`);
      await writeFile(join(out, 'snapshot', 'session-state', id, '.session.db.src'), '1:2');
    }
    await mkdir(join(out, 'snapshot', 'session-state', 's1', 'files'), { recursive: true });
    await writeFile(join(out, 'snapshot', 'session-state', 's1', 'files', 'a.txt'), 'a');
    await writeFile(join(out, 'snapshot', 'snapshot-manifest.json'), JSON.stringify({ createdAt: '2026-11-08T01:02:03.000Z' }));
    await writeFile(join(out, 'atlas.html'), `<!doctype html><meta name="atlas-token" content="${TOKEN_PLACEHOLDER}"><script type="application/json" id="atlas-data">{"version":9,"anonymized":false,"groups":[]}</script>`);
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'Player/Weapon', note: '', ids: ['s1', 's2', 'gone', '../s1'] }, { name: '空', note: '', ids: [] }] }));
    await mkdir(root);
  });
  afterEach(async () => {
    await h?.close();
    h = null;
    await rm(dir, { recursive: true, force: true });
  });
  const paths = () => ({ snapshot: join(out, 'snapshot'), groups: join(notes, 'groups.json') });

  it('セッションごとのフォルダに写し、作業用のファイルは入れない。外を指す id と無い id は写さない', async () => {
    const r = await uploadGroup(paths(), 'Player/Weapon', root);
    expect(r).toEqual({ name: 'Player/Weapon', dir: join(root, 'Player_Weapon'), uploaded: 2, replaced: 0, unchanged: 0, staleMeta: [], missing: ['gone', '../s1'], snapshotAt: '2026-11-08T01:02:03.000Z', memos: 0, leftovers: [] });
    expect((await readdir(r.dir)).sort()).toEqual(['README.md', 'atlas-index.json', 's1', 's2']);
    expect((await readdir(join(r.dir, 's1'))).sort()).toEqual(['atlas-session.json', 'events.jsonl', 'files']);
    expect(await readFile(join(r.dir, 's1', 'files', 'a.txt'), 'utf8')).toBe('a');
    // session-store.db が無ければ DB の行は添えない
    expect(existsSync(join(r.dir, 's1', 'atlas-session-store.json'))).toBe(false);
    // 2 回目: 送り先で足されたファイルがあるセッションは置き換え(前のフォルダの中身は残さない)、変わっていないものは写さない
    await writeFile(join(r.dir, 's2', 'old.txt'), 'x');
    expect(await uploadGroup(paths(), 'Player/Weapon', root)).toMatchObject({ uploaded: 1, replaced: 1, unchanged: 1 });
    expect(existsSync(join(r.dir, 's2', 'old.txt'))).toBe(false);
    // 前の回が置き換えの途中で止まって残したもの(本体のフォルダが無く、退けた前のフォルダだけがある)も、新しいフォルダを置けたら消す
    await rename(join(r.dir, 's2'), join(r.dir, '.s2.old'));
    expect(await uploadGroup(paths(), 'Player/Weapon', root)).toMatchObject({ uploaded: 1, replaced: 0, unchanged: 1, leftovers: [] });
    // full なら、変わっていないものも写し直す
    expect(await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { full: true })).toMatchObject({ uploaded: 2, replaced: 2, unchanged: 0 });
    expect((await readdir(r.dir)).sort()).toEqual(['README.md', 'atlas-index.json', 's1', 's2']);
    expect(uploadDir(root, 'con')).toBe(join(root, '_con'));
  });

  it('2 回目からは、前に送ったときから変わったセッションだけを写す(更新時刻・メモ・送り先での欠け)。タグだけの変更は添えた記録を書き直す', async () => {
    const state = join(out, 'snapshot', 'session-state');
    const r = await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root);
    const sent = join(r.dir, 's1', 'events.jsonl');
    // 送り先のファイルに印を付けておく(写し直されれば消える)
    const mark = async (id: string) => writeFile(join(r.dir, id, 'files-mark.txt'), 'x').then(() => rm(join(r.dir, id, 'files-mark.txt')));
    expect(JSON.parse(await readFile(join(r.dir, 's1', 'atlas-session.json'), 'utf8')).contents).toMatch(/^[0-9a-f]{64}$/);
    const before = (await stat(sent)).mtimeMs;
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2 });
    expect((await stat(sent)).mtimeMs).toBe(before);
    // 送り先のフォルダを開いただけで OS が作るもの(Thumbs.db・desktop.ini・.DS_Store)は、変わったことにしない
    await writeFile(join(r.dir, 's1', 'files', 'Thumbs.db'), 'thumb');
    await writeFile(join(r.dir, 's1', 'desktop.ini'), '[.ShellClassInfo]');
    await writeFile(join(r.dir, 's2', '.DS_Store'), 'mac');
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2 });
    // 似た名前でも、ほかのファイルが足されていれば写し直す
    await writeFile(join(r.dir, 's2', 'Thumbs.db.txt'), 'x');
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, unchanged: 1 });
    expect(existsSync(join(r.dir, 's2', 'Thumbs.db.txt'))).toBe(false);
    // Mac が SMB の共有に作る ._<名前>・NAS のサムネイルのフォルダ(@eaDir)・空のフォルダの中の .DS_Store も、変わったことにしない
    await mkdir(join(state, 's2', 'empty'));
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, unchanged: 1 });
    await writeFile(join(r.dir, 's1', '._events.jsonl'), 'apple');
    await mkdir(join(r.dir, 's1', '@eaDir', 'events.jsonl'), { recursive: true });
    await writeFile(join(r.dir, 's1', '@eaDir', 'events.jsonl', 'SYNOFILE_THUMB_M.jpg'), 'thumb');
    await writeFile(join(r.dir, 's2', 'empty', '.DS_Store'), 'mac');
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2 });
    await mark('s1');
    // 同じ大きさでも、更新時刻が変われば写し直す
    await writeFile(join(state, 's1', 'events.jsonl'), '{"type":"session.start","id":"S1"}\n');
    await utimes(join(state, 's1', 'events.jsonl'), new Date('2026-11-09T00:00:00Z'), new Date('2026-11-09T00:00:00Z'));
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, replaced: 1, unchanged: 1 });
    expect(await readFile(sent, 'utf8')).toContain('"S1"');
    // メモを書けば、そのセッションを写し直す
    await mkdir(join(notes, 'memos'), { recursive: true });
    await writeFile(join(notes, 'memos', 's2.md'), '# メモ');
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, unchanged: 1, memos: 1 });
    expect(await readFile(join(r.dir, 's2', 'atlas-memo.md'), 'utf8')).toBe('# メモ');
    // 送り先でファイルが消されていれば、写し直す
    await rm(join(r.dir, 's1', 'files', 'a.txt'));
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, unchanged: 1 });
    expect(await readFile(join(r.dir, 's1', 'files', 'a.txt'), 'utf8')).toBe('a');
    // タスクタグを変えただけなら写し直さず、添えた記録と README を書き直す
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'Player/Weapon', note: '', ids: ['s1', 's2'] }, { name: '調査', note: '', ids: ['s1'] }] }));
    const at = (await stat(sent)).mtimeMs;
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2 });
    expect((await stat(sent)).mtimeMs).toBe(at);
    expect(JSON.parse(await readFile(join(r.dir, 's1', 'atlas-session.json'), 'utf8')).tags).toEqual(['Player/Weapon', '調査']);
    expect(await readFile(join(r.dir, 'README.md'), 'utf8')).toContain('セッション: 2 件');
    expect((await readdir(r.dir)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('atlas の版を索引とセッションの記録に添える。写し直さないセッションの記録も、送った版に書き直す', async () => {
    const v1 = { commit: 'a'.repeat(40), committedAt: '2026-11-01T00:00:00.000Z', dirty: false, code: '0123456789abcdef' };
    const v2 = { commit: 'b'.repeat(40), committedAt: '2026-11-10T00:00:00.000Z', dirty: true, code: 'fedcba9876543210' };
    const sessionMeta = (id: string) => join(root, 'Player_Weapon', id, 'atlas-session.json');
    const meta = async (id: string) => JSON.parse(await readFile(sessionMeta(id), 'utf8'));
    const index = async () => JSON.parse(await readFile(join(root, 'Player_Weapon', 'atlas-index.json'), 'utf8'));
    await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { atlas: v1 });
    expect((await meta('s1')).atlas).toEqual(v1);
    expect((await index()).atlas).toEqual(v1);
    // s1 だけ変えて新しい版で送る: 写した s1 も、写し直さない s2 も新しい版(s2 は、新しい版が作る中身が前に送ったものと同じだった)
    const ev = join(out, 'snapshot', 'session-state', 's1', 'events.jsonl');
    await writeFile(ev, '{"type":"session.start","id":"S1"}\n');
    await utimes(ev, new Date('2026-11-09T00:00:00Z'), new Date('2026-11-09T00:00:00Z'));
    const sent = join(root, 'Player_Weapon', 's2', 'events.jsonl');
    const before = (await stat(sent)).mtimeMs;
    expect(await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { atlas: v2 })).toMatchObject({ uploaded: 1, unchanged: 1 });
    expect((await meta('s1')).atlas).toEqual(v2);
    expect((await meta('s2')).atlas).toEqual(v2);
    expect((await stat(sent)).mtimeMs).toBe(before);
    expect((await index()).atlas).toEqual(v2);
    // 版を記録する前の atlas で送ったもの(記録が無い)も、次に送れば記録が付く(ログは写し直さない)
    const { atlas: _, ...old } = await meta('s2');
    await writeFile(sessionMeta('s2'), `${JSON.stringify(old, null, 2)}\n`);
    expect(await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { atlas: v2 })).toMatchObject({ uploaded: 0, unchanged: 2 });
    expect((await meta('s2')).atlas).toEqual(v2);
    // 既定は、このチェックアウトの版(目印は必ずある)
    await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { full: true });
    expect((await meta('s1')).atlas.code).toMatch(/^[0-9a-f]{16}$/);
  });

  it('点検は、前に送ったときから変わっていないセッションを読まずに数える(写すものだけの大きさと秘密らしい文字列)', async () => {
    await uploadGroup(paths(), 'Player/Weapon', root);
    const token = ['ghp', 'DIFFFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'].join('_');
    expect(await checkUpload(paths(), 'Player/Weapon', root)).toMatchObject({ sessions: 0, unchanged: 2, bytes: 0, files: 0, replace: 0, secrets: { count: 0 } });
    await writeFile(join(out, 'snapshot', 'session-state', 's2', 'events.jsonl'), JSON.stringify({ data: token }) + '\n');
    const c = await checkUpload(paths(), 'Player/Weapon', root);
    expect(c).toMatchObject({ sessions: 1, unchanged: 1, replace: 1, files: 1, secrets: { count: 1 } });
    expect(c.secrets.files).toEqual([{ id: 's2', path: 'events.jsonl', count: 1 }]);
  });

  it('メモの画像のフォルダに空のフォルダがあっても、2 回目は写し直さない(画像は丸ごと写すので、送り先にも空のフォルダがある)', async () => {
    const memos = join(notes, 'memos');
    await mkdir(join(memos, 's1', 'sub'), { recursive: true });
    await writeFile(join(memos, 's1.md'), '# m\n\n![a](s1/a.png)\n');
    await writeFile(join(memos, 's1', 'a.png'), 'png');
    const r = await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root);
    expect(existsSync(join(r.dir, 's1', 'atlas-memo', 'sub'))).toBe(true);
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2, memos: 1 });
    // 画像を足せば写し直す
    await writeFile(join(memos, 's1', 'b.png'), 'png2');
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 1, unchanged: 1 });
    expect(existsSync(join(r.dir, 's1', 'atlas-memo', 'b.png'))).toBe(true);
  });

  it('要約に入れる DB の行は、デスクトップアプリの行のうちセッションの中身と関係なく変わる列(プロジェクトを開いた日時・既読など)を除く', () => {
    const row = (o: { opened: string; read: number; title: string; diff: number }) =>
      JSON.stringify({
        version: 1,
        sessions: [],
        desktop: {
          session: { id: 's1', title: o.title },
          project: { id: 'p', name: 'app', last_opened_at: o.opened, show_in_sidebar: 1 },
          workspace: { id: 'w', branch: 'main', updated_at: o.opened, last_diff_files_changed: o.diff },
          activity: [{ id: 'a', preview: 'x', is_read: o.read, updated_at: o.opened }],
          checkpoints: [],
          contextUsage: [],
        },
      });
    const a = storeKeyText(row({ opened: '2026-11-01', read: 0, title: 't', diff: 1 }));
    expect(storeKeyText(row({ opened: '2026-11-12', read: 1, title: 't', diff: 5 }))).toBe(a);
    // セッションの中身(題名など)が変われば違う
    expect(storeKeyText(row({ opened: '2026-11-01', read: 0, title: '別の題名', diff: 1 }))).not.toBe(a);
    // 読めないものはそのまま
    expect(storeKeyText('{壊れた')).toBe('{壊れた');
  });

  it('写すときに点検を渡すと、点検で前に送ったときのままと確かめたものは、送り先の一覧を読み直さない', async () => {
    const r = await uploadGroup(paths(), 'Player/Weapon', root);
    const c = await checkUpload(paths(), 'Player/Weapon', root);
    expect(c).toMatchObject({ sessions: 0, unchanged: 2 });
    // 点検の後に送り先のファイルが消えた: 点検を渡さなければ読み直して気づき、確かめた中身と違うので写さない
    await rm(join(r.dir, 's1', 'files', 'a.txt'));
    await expect(uploadGroup(paths(), 'Player/Weapon', root, () => {}, { expect: c.fingerprint })).rejects.toThrow(UploadChangedError);
    // 点検を渡すと、そのとき確かめた結果を使う(送り先は変えない前提。次の点検で気づいて写し直す)
    expect(await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { expect: c.fingerprint, check: c })).toMatchObject({ uploaded: 0, unchanged: 2 });
    expect(await checkUpload(paths(), 'Player/Weapon', root)).toMatchObject({ sessions: 1, unchanged: 1 });
  });

  it.skipIf(process.platform !== 'win32')('写さないセッションの記録を書き直せなくても止めずに知らせ、消せない前のフォルダも知らせる', async () => {
    const r = await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root);
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'Player/Weapon', note: '', ids: ['s1', 's2'] }, { name: '調査', note: '', ids: ['s1'] }] }));
    // s1 の記録は読み取り専用で書き直せない。s2 の前の回の消し残し(.s2.old)は、中のファイルをほかのプロセスが
    // ほかに開かせない形で開いていて消せない(node の open は消すことを許す形で開くので、PowerShell で開く)
    await chmod(join(r.dir, 's1', 'atlas-session.json'), 0o444);
    await mkdir(join(r.dir, '.s2.old'), { recursive: true });
    const lockedFile = join(r.dir, '.s2.old', 'x.txt');
    await writeFile(lockedFile, 'x');
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open($env:ATLAS_LOCK, 'Open', 'Read', 'None'); 'locked'; Start-Sleep -Seconds 60`], {
      env: { ...process.env, ATLAS_LOCK: lockedFile },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((ok, ng) => {
        holder.stdout.on('data', (b: Buffer) => b.toString().includes('locked') && ok());
        holder.on('exit', () => ng(new Error('PowerShell がファイルを開けませんでした')));
      });
      expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2, staleMeta: ['s1'], leftovers: [join(r.dir, '.s2.old')] });
    } finally {
      holder.kill();
      await new Promise((ok) => (holder.exitCode != null ? ok(null) : holder.once('exit', ok)));
      await chmod(join(r.dir, 's1', 'atlas-session.json'), 0o666);
    }
    // 直れば、次の回に書き直して片付ける
    expect(await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root)).toMatchObject({ uploaded: 0, unchanged: 2, staleMeta: [], leftovers: [] });
    expect(JSON.parse(await readFile(join(r.dir, 's1', 'atlas-session.json'), 'utf8')).tags).toEqual(['Player/Weapon', '調査']);
    expect(existsSync(join(r.dir, '.s2.old'))).toBe(false);
  }, 20_000);

  it('送った人のインストール済みの skill・プラグインの名前を atlas-installed.json に添え、集計し直す側が読む(送り先から集計したものは添えない)', async () => {
    const installed = { skills: ['alpha'], plugins: [{ marketplace: 'm', name: 'p', skills: ['beta'] }], disabledSkills: ['alpha'], warnings: [] };
    await writeFile(join(out, 'snapshot', 'snapshot-manifest.json'), JSON.stringify({ createdAt: '2026-11-08T01:02:03.000Z', installed }));
    const r = await uploadGroup(paths(), 'Player/Weapon', root);
    expect(JSON.parse(await readFile(join(r.dir, 'atlas-installed.json'), 'utf8'))).toMatchObject({ version: 1, ...installed });
    // 送り先のフォルダから集計し直すと、インストール済みの記録として使う
    const m = await snapshot(r.dir, join(dir, 'reread'));
    expect(m.installed).toEqual(installed);
    // 人のフォルダの下ではないので、人ごとの記録は無い
    expect(m.installedByPerson).toBeUndefined();
    // 送り先から集計した出力先から写すときは、ほかの人のものなので添えない
    await rm(join(r.dir, 'atlas-installed.json'));
    await writeFile(join(out, 'snapshot', 'snapshot-manifest.json'), JSON.stringify({ createdAt: '2026-11-08T01:02:03.000Z', layout: 'merged', installed }));
    await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { full: true });
    expect(existsSync(join(r.dir, 'atlas-installed.json'))).toBe(false);
    // 添えた記録が無いフォルダから集計すると、0 件ではなく「記録なし」
    expect((await snapshot(r.dir, join(dir, 'reread2'))).installed).toBeUndefined();
  });

  it('readSentInventory: 人ごとに新しい記録だけを使って全員分を合わせ、人ごとの記録も返す。おかしな名前・形の違う・大きすぎるファイルは使わない', async () => {
    const base = join(dir, 'sent');
    const put = async (folder: string, body: unknown) => {
      await mkdir(join(base, ...folder.split('/')), { recursive: true });
      await writeFile(join(base, ...folder.split('/'), 'atlas-installed.json'), typeof body === 'string' ? body : JSON.stringify(body));
    };
    // a は 2 プロジェクト分。古いほう(p1)にだけある skill は、もう入れていないものとして使わない
    await put('a/p1', { version: 1, sentAt: '2026-11-01T00:00:00.000Z', skills: ['old-skill'], plugins: [], disabledSkills: [], warnings: [] });
    await put('a/p2', { version: 1, sentAt: '2026-11-10T00:00:00.000Z', skills: ['x', 'y', 'bad\u202ename', 7], plugins: [{ marketplace: 'm', name: 'p', skills: ['s1'] }], disabledSkills: ['y'], warnings: [] });
    await put('b/p3', { version: 1, sentAt: '2026-11-05T00:00:00.000Z', skills: ['y', 'z'], plugins: [{ marketplace: 'm', name: 'p', skills: ['s2'] }, { marketplace: '', name: 'q' }], disabledSkills: null, warnings: ['skills/ を読めない'] });
    await put('c/p4', '{壊れた');
    await put('c/p5', `{"version":1,"skills":["${'x'.repeat(1024 * 1024)}"]}`);
    await mkdir(join(base, 'd', 'p6'), { recursive: true });
    // 人のフォルダの下に無いもの(送り先の直下に置いたプロジェクト)は、全員分にだけ入れる
    await put('loose', { version: 1, sentAt: '2026-11-02T00:00:00.000Z', skills: ['loose-skill'], plugins: [], disabledSkills: [], warnings: [] });
    const r = await readSentInventory(base, ['a/p1', 'a/p2', 'b/p3', 'c/p4', 'c/p5', 'd/p6', 'loose']);
    expect(r.installed).toMatchObject({ skills: ['loose-skill', 'x', 'y', 'z'], plugins: [{ marketplace: 'm', name: 'p', skills: ['s1', 's2'] }], disabledSkills: ['y'] });
    expect(Object.keys(r.byPerson ?? {}).sort()).toEqual(['a', 'b']);
    expect(r.byPerson!.a).toMatchObject({ skills: ['x', 'y'], disabledSkills: ['y'] });
    expect(r.byPerson!.b).toMatchObject({ skills: ['y', 'z'], disabledSkills: null });
    expect(r.installed!.warnings).toEqual([
      expect.stringMatching(/^c\/p4 の atlas-installed\.json を読めない/),
      expect.stringMatching(/^c\/p5 の atlas-installed\.json を読めない \(大きすぎる/),
      'b/p3: skills/ を読めない',
      '送った人のインストール済みの記録が無いフォルダが 1 件あります(この版より前の atlas で送ったもの。送り直すと付きます)',
    ]);
    expect(await readSentInventory(base, ['d/p6'])).toEqual({});
  });

  it('メモと画像をセッションのフォルダに添え、グループの説明と一覧を README.md に書く', async () => {
    const memos = join(notes, 'memos');
    await mkdir(join(memos, 's1'), { recursive: true });
    await writeFile(join(memos, 's1.md'), '# 武器の当たり判定\n\n![画像](s1/abc.png) と ![別](./s1/def.png)。[外の](https://example.invalid/s1/x)\n');
    await writeFile(join(memos, 's1', 'abc.png'), 'png');
    await writeFile(join(memos, 's1', 'def.png'), 'png2');
    // 空白だけのメモは無いのと同じ
    await writeFile(join(memos, 's2.md'), '  \n');
    await writeFile(
      join(notes, 'groups.json'),
      JSON.stringify({ version: 1, groups: [{ name: 'Player/Weapon', note: '武器 | 当たり判定の\n直し', ids: ['s1', 's2', 'gone'] }] }),
    );
    const sessions = join(out, 'sessions.json');
    await writeFile(sessions, JSON.stringify({ sessions: [{ id: 's1', name: null, firstUserMessage: '当たり判定を | 直して', updatedAt: '2026-11-07T03:04:00.000Z' }] }));
    const r = await uploadGroup({ ...paths(), notes, sessions }, 'Player/Weapon', root);
    expect(r.memos).toBe(1);
    expect(await readFile(join(r.dir, 's1', 'atlas-memo.md'), 'utf8')).toBe(
      '# 武器の当たり判定\n\n![画像](atlas-memo/abc.png) と ![別](atlas-memo/def.png)。[外の](https://example.invalid/s1/x)\n',
    );
    expect((await readdir(join(r.dir, 's1', 'atlas-memo'))).sort()).toEqual(['abc.png', 'def.png']);
    expect(existsSync(join(r.dir, 's2', 'atlas-memo.md'))).toBe(false);
    const readme = await readFile(join(r.dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# Player\/Weapon\n\n武器 \| 当たり判定の\n直し\n/);
    expect(readme).toContain('セッション: 2 件(うちメモあり 1 件)');
    expect(readme).toContain('| [s1](s1/) | 当たり判定を \\| 直して | Player/Weapon | ');
    expect(readme).toContain('| [あり](s1/atlas-memo.md) |');
    expect(readme).toContain('| [s2](s2/) | - | Player/Weapon | - | - |');
    expect(readme).toContain('写していないもの: `gone`');
    expect(readme).toContain(`--home "${r.dir}"`);
    // メモを消してからもう一度写すと、前に添えたメモも消える(フォルダごと置き換えるため)
    await rm(join(memos, 's1.md'));
    expect((await uploadGroup({ ...paths(), notes, sessions }, 'Player/Weapon', root)).memos).toBe(0);
    expect(existsSync(join(r.dir, 's1', 'atlas-memo.md'))).toBe(false);
  });

  it('送り先から集計した出力先から写しても、送った人のメモと画像・添えた記録は写さない(メモはこの PC の置き場のものだけ)', async () => {
    const s1 = join(out, 'snapshot', 'session-state', 's1');
    const s2 = join(out, 'snapshot', 'session-state', 's2');
    await writeFile(join(s1, 'atlas-memo.md'), '# 送った人のメモ');
    await mkdir(join(s1, 'atlas-memo'));
    await writeFile(join(s1, 'atlas-memo', 'member.png'), 'm');
    await writeFile(join(s2, 'atlas-memo.md'), '# 送った人のメモ 2');
    await writeFile(join(s2, 'atlas-session.json'), JSON.stringify({ version: 1, id: 's2', tags: ['他人の'] }));
    const memos = join(notes, 'memos');
    await mkdir(join(memos, 's1'), { recursive: true });
    await writeFile(join(memos, 's1.md'), '# 自分のメモ ![](s1/mine.png)');
    await writeFile(join(memos, 's1', 'mine.png'), 'pp');
    const c = await checkUpload({ ...paths(), notes }, 'Player/Weapon', root);
    expect(c.largest.find((x) => x.id === 's1' && x.path === 'atlas-memo')?.bytes).toBe(2);
    const r = await uploadGroup({ ...paths(), notes }, 'Player/Weapon', root);
    expect(await readFile(join(r.dir, 's1', 'atlas-memo.md'), 'utf8')).toBe('# 自分のメモ ![](atlas-memo/mine.png)');
    expect(await readdir(join(r.dir, 's1', 'atlas-memo'))).toEqual(['mine.png']);
    expect(existsSync(join(r.dir, 's2', 'atlas-memo.md'))).toBe(false);
    expect(JSON.parse(await readFile(join(r.dir, 's2', 'atlas-session.json'), 'utf8')).tags).not.toContain('他人の');
  });

  it('基底のフォルダが無い・グループが無い・空・集計前なら止まる(何も作らない)', async () => {
    await expect(uploadGroup(paths(), 'Player/Weapon', join(dir, 'none'))).rejects.toThrow(/アップロード先のフォルダが見つかりません/);
    expect(existsSync(join(dir, 'none'))).toBe(false);
    await expect(uploadGroup(paths(), '無い', root)).rejects.toThrow(/タスクタグ「無い」はありません/);
    await expect(uploadGroup(paths(), '空', root)).rejects.toThrow(/セッションがありません/);
    await expect(uploadGroup({ ...paths(), snapshot: join(dir, 'nosnap') }, 'Player/Weapon', root)).rejects.toThrow(/先に集計してください/);
  });

  it('フォルダ名が同じになる別のグループ・前回の集計に 1 件も無いグループは写さない(フォルダも README も作らない)。予約名は拡張子付きも避ける', async () => {
    await writeFile(
      join(notes, 'groups.json'),
      JSON.stringify({
        version: 1,
        groups: [
          { name: 'Player/Weapon', note: '', ids: ['s1'] },
          { name: 'player_weapon', note: '', ids: ['s2'] },
          { name: '古い', note: '', ids: ['gone', 'gone2'] },
        ],
      }),
    );
    await expect(uploadGroup(paths(), 'Player/Weapon', root)).rejects.toThrow(/「Player\/Weapon」と「player_weapon」は、アップロード先のフォルダ名が同じ「Player_Weapon」/);
    await expect(uploadGroup(paths(), '古い', root)).rejects.toThrow(/2 件.は、前回の集計に 1 件もありません/);
    expect(await readdir(root)).toEqual([]);
    expect(uploadDir(root, 'nul.log')).toBe(join(root, '_nul.log'));
    expect(uploadDir(root, 'COM1.txt')).toBe(join(root, '_COM1.txt'));
    expect(uploadDir(root, 'console')).toBe(join(root, 'console'));
  });

  it.skipIf(process.platform !== 'win32')('前に写したフォルダのファイルが開かれていて置き換えられないときは、前のフォルダをそのまま残して止まる', async () => {
    const r = await uploadGroup(paths(), 'Player/Weapon', root);
    const locked = join(r.dir, 's2', 'events.jsonl');
    const before = await readFile(locked, 'utf8');
    const fh = await open(locked, 'r');
    try {
      // 変わっていないと写さないので、写し直す(full)
      await expect(uploadGroup(paths(), 'Player/Weapon', root, () => {}, { full: true })).rejects.toThrow(/セッション s\d を写せませんでした.*前に写したフォルダはそのままです/);
    } finally {
      await fh.close();
    }
    expect(await readFile(locked, 'utf8')).toBe(before);
    expect((await readdir(r.dir)).filter((n) => n.startsWith('.'))).toEqual([]);
    // 閉じれば写せる
    expect(await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { full: true })).toMatchObject({ uploaded: 2, replaced: 2 });
  }, 20_000);

  it('添えたファイルの desktop の形が違えば使わず、理由を返す(集計は止めない)', async () => {
    const f = join(dir, 'store.json');
    const store = await loadStore(join(dir, 'no.db'));
    const desktops = new Map();
    const base = { version: 1, schemaVersion: null, sessions: [{ id: 's1' }], turns: [], usage: [], files: [] };
    await writeFile(f, JSON.stringify({ ...base, desktop: { session: { title: 't' } } }));
    expect(await mergeSessionStoreJson(store, 's1', f, desktops)).toMatch(/desktop の形が違う/);
    expect(desktops.size).toBe(0);
    expect(store.sessions.has('s1')).toBe(true);
    const ok = { session: { title: 't' }, contextUsage: [], checkpoints: [], activity: [{ id: 'a' }], workspace: null, project: null };
    await writeFile(f, JSON.stringify({ ...base, desktop: ok }));
    expect(await mergeSessionStoreJson(store, 's1', f, desktops)).toBeNull();
    expect(desktops.get('s1')).toEqual(ok);
  });

  it('CLI: group upload は --to か設定の uploadRoot を使う。--to は upload でだけ', () => {
    expect(parseCli(['group', 'upload', 'g', '--to', 'D:\\x']).groupCmd).toMatchObject({ action: 'upload', name: 'g', to: 'D:\\x' });
    expect(() => parseCli(['group', 'export', 'g', '--to', 'D:\\x'])).toThrow(/--to は group upload/);
    expect(() => parseCli(['build', '--to', 'D:\\x'])).toThrow(/--to は group upload/);
    expect(() => parseCli(['group', 'upload'])).toThrow(/グループ名/);
  });

  it('serve: アップロード先を決め(選ぶ / 入力)、写し、写した先を開く。token が要り、先が未定なら写さない', async () => {
    const picked: (string | null)[] = [];
    const opened: string[] = [];
    let answer: string | null = null;
    h = await startServe({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      configPath,
      folders: { canPick: true, pick: async (_t, initial) => (picked.push(initial), answer), open: (d) => opened.push(d) },
    });
    const url = (p: string) => `http://127.0.0.1:${h!.port}/${p}`;
    const call = (p: string, method: string, body?: unknown, token: string | null = h!.token) =>
      fetch(url(p), { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-atlas-token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const state = async () => ((await (await fetch(url('api/state'))).json()) as { upload: unknown }).upload;
    expect(await state()).toEqual({ root: null, projects: [], error: null, canPick: true });
    // 先が未定なら写さない
    const g = encodeURIComponent('Player/Weapon');
    const none = await call(`api/groups/${g}/upload`, 'POST');
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/決まっていません/);
    // token が無ければ何もしない
    expect((await call('api/upload-root', 'PUT', { root }, null)).status).toBe(403);
    // 入力: 相対パス・無いフォルダは断る。あるフォルダは設定に書く
    expect((await call('api/upload-root', 'PUT', { root: 'logs' })).status).toBe(400);
    expect((await call('api/upload-root', 'PUT', { root: join(dir, 'none') })).status).toBe(400);
    expect(await (await call('api/upload-root', 'PUT', { root })).json()).toEqual({ root });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: root });
    // 選ぶ: 取り消したら変えない。選んだら今の場所から開いて、選んだ場所を書く
    expect(await (await call('api/upload-root', 'POST')).json()).toEqual({ root: null });
    expect(picked).toEqual([root]);
    const other = join(dir, 'other');
    await mkdir(other);
    answer = other;
    expect(await (await call('api/upload-root', 'POST')).json()).toEqual({ root: other });
    expect(await state()).toEqual({ root: other, projects: [], error: null, canPick: true });
    // 写す前に開くと 404、写したら開ける(開けるのは設定の先の、そのグループのフォルダだけ)
    expect((await call(`api/groups/${g}/upload/open`, 'POST')).status).toBe(404);
    const up = await call(`api/groups/${g}/upload`, 'POST');
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ dir: join(other, 'Player_Weapon'), uploaded: 2, missing: ['gone', '../s1'] });
    expect(existsSync(join(out, '.job.json'))).toBe(false);
    expect(await (await call(`api/groups/${g}/upload/open`, 'POST')).json()).toEqual({ dir: join(other, 'Player_Weapon') });
    expect(opened).toEqual([join(other, 'Player_Weapon')]);
    expect((await call(`api/groups/${encodeURIComponent('無い')}/upload`, 'POST')).status).toBe(404);
  });

  it('serve: 選ぶ画面を出せない OS では 501。設定ファイルが壊れていれば書き換えず理由を返す', async () => {
    await writeFile(configPath, '{ 壊れた');
    h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, configPath, folders: { canPick: false } });
    const call = (p: string, method: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${h!.port}/${p}`, { method, headers: { 'content-type': 'application/json', 'x-atlas-token': h!.token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const s = (await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()) as { upload: { root: string | null; error: string | null; canPick: boolean } };
    expect(s.upload.root).toBeNull();
    expect(s.upload.error).toMatch(/atlas\.config\.json/);
    expect(s.upload.canPick).toBe(false);
    expect((await call('api/upload-root', 'POST')).status).toBe(501);
    const put = await call('api/upload-root', 'PUT', { root });
    expect(put.status).toBe(409);
    expect((await call('api/upload-projects', 'PUT', { project: 'owner/app', on: true })).status).toBe(409);
    expect(await readFile(configPath, 'utf8')).toBe('{ 壊れた');
  });

  it('serve: upload-project.bat がまとめて送るプロジェクトの印を足す・外す。ほかの設定は残し、空になれば項目ごと消す。token が要る', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, configPath, folders: { canPick: false } });
    const call = (body: unknown, token: string | null = h!.token, method = 'PUT') =>
      fetch(`http://127.0.0.1:${h!.port}/api/upload-projects`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-atlas-token': token } : {}) }, body: JSON.stringify(body) });
    const state = async () => ((await (await fetch(`http://127.0.0.1:${h!.port}/api/state`)).json()) as { upload: { projects: string[] } }).upload.projects;
    const config = async () => JSON.parse(await readFile(configPath, 'utf8'));
    expect(await state()).toEqual([]);
    expect((await call({ project: 'owner/app', on: true }, null)).status).toBe(403);
    expect((await call({ project: 'owner/app', on: true }, h.token, 'POST')).status).toBe(405);
    expect((await call({ project: '', on: true })).status).toBe(400);
    expect((await call({ project: 'owner/app', on: 'yes' })).status).toBe(400);
    expect(await config()).toEqual({ uploadRoot: root });
    expect(await (await call({ project: 'owner/app', on: true })).json()).toEqual({ projects: ['owner/app'] });
    // 同じものをもう一度足しても 1 つのまま。足した順に並ぶ
    expect(await (await call({ project: 'owner/app', on: true })).json()).toEqual({ projects: ['owner/app'] });
    expect(await (await call({ project: 'X:\\work\\tool', on: true })).json()).toEqual({ projects: ['owner/app', 'X:\\work\\tool'] });
    expect(await config()).toEqual({ uploadRoot: root, uploadProjects: ['owner/app', 'X:\\work\\tool'] });
    expect(await state()).toEqual(['owner/app', 'X:\\work\\tool']);
    // 設定を書き換えたあと(bat や手で)も、読み直してから足す・外す
    await writeFile(configPath, JSON.stringify({ uploadRoot: root, uploadProjects: ['手で足した'] }));
    expect(await (await call({ project: 'owner/app', on: false })).json()).toEqual({ projects: ['手で足した'] });
    expect(await (await call({ project: '手で足した', on: false })).json()).toEqual({ projects: [] });
    expect(await config()).toEqual({ uploadRoot: root });
    // 続けて押しても(要求が重なっても)、先に足した分を消さない
    const many = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const rs = await Promise.all(many.map((project) => call({ project, on: true })));
    expect(rs.map((r) => r.status)).toEqual(many.map(() => 200));
    expect(((await config()).uploadProjects as string[]).sort()).toEqual(many);
  });
  // トークンの形をソースに直書きしない(秘密の検査に引っかからないように)
  const TOKEN = ['ghp', 'UPLOADFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK1'].join('_');

  it('checkUpload: 大きさ・大きいもの・秘密らしい文字列を数え、バイナリは中身を調べない。塊の境目をまたいでも 1 回だけ数える', async () => {
    const s1 = join(out, 'snapshot', 'session-state', 's1');
    await writeFile(join(s1, 'events.jsonl'), `{"data":"token ${TOKEN}"}\n{"data":"Bearer ${'a'.repeat(30)}"}\n`);
    // 読む塊(4 MB)の境目をまたぐ位置と、重ねて読む部分の中に 1 つずつ
    const big = Buffer.alloc(9 * 1024 * 1024, 'x');
    big.write(` ${TOKEN} `, 4 * 1024 * 1024 - 20);
    big.write(` ${TOKEN} `, 8 * 1024 * 1024 - 8 * 1024);
    await writeFile(join(s1, 'files', 'big.log'), big);
    // NUL を含むファイルは調べない(SQLite・画像など)
    await writeFile(join(out, 'snapshot', 'session-state', 's2', 'session.db'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TOKEN)]));
    const c = await checkUpload(paths(), 'Player/Weapon', root);
    expect(c).toMatchObject({ name: 'Player/Weapon', dir: join(root, 'Player_Weapon'), sessions: 2, missing: ['gone', '../s1'], replace: 0, files: 5, snapshotAt: '2026-11-08T01:02:03.000Z' });
    expect(c.bytes).toBeGreaterThan(9 * 1024 * 1024);
    expect(c.largest[0]).toEqual({ id: 's1', path: 'files', bytes: 9 * 1024 * 1024 + 1 });
    expect(c.secrets.kinds).toEqual([
      { label: 'GitHub トークン', count: 3 },
      { label: 'Bearer トークン', count: 1 },
    ]);
    expect(c.secrets.count).toBe(4);
    expect(c.secrets.files).toEqual([
      { id: 's1', path: 'events.jsonl', count: 2 },
      { id: 's1', path: 'files/big.log', count: 2 },
    ]);
    expect(c.secrets.skipped).toBe(1);
    // 点検は何も写さない
    expect(existsSync(join(root, 'Player_Weapon'))).toBe(false);
  });

  it('点検は atlas が足して写すもの(メモの本文)も調べ、大きさに入れる。空のフォルダも写す', async () => {
    const memos = join(notes, 'memos');
    await mkdir(memos, { recursive: true });
    await writeFile(join(memos, 's2.md'), `メモに貼った鍵 ${TOKEN}\n`);
    await mkdir(join(out, 'snapshot', 'session-state', 's1', 'checkpoints'), { recursive: true });
    const p = { ...paths(), notes };
    const c = await checkUpload(p, 'Player/Weapon', root);
    expect(c.secrets.files).toEqual([{ id: 's2', path: 'atlas-memo.md', count: 1 }]);
    expect(c.largest.some((x) => x.id === 's2' && x.path === 'atlas-memo.md')).toBe(true);
    // 空のフォルダ(checkpoints/)も写し、点検の件数には入れない
    expect(c.files).toBe(4);
    const r = await uploadGroup(p, 'Player/Weapon', root);
    expect(existsSync(join(r.dir, 's1', 'checkpoints'))).toBe(true);
  });

  it('scanSecrets: 読む塊の境目の直前が英数字でも、続く文字列を秘密らしい文字列と誤って数えない(\\b が先頭として成り立たない)', async () => {
    const f = join(dir, 'edge.log');
    // 重ねて読む部分(16 KB)の始まりにちょうど「x + トークンの形」が来るようにする: 英数字に続くので語の始まりではない
    const big = Buffer.alloc(8 * 1024 * 1024, 'y');
    const at = 4 * 1024 * 1024 - 16 * 1024 - 1;
    big.write(`x${TOKEN} `, at);
    await writeFile(f, big);
    expect((await scanSecrets(f))?.get('GitHub トークン') ?? 0).toBe(0);
    // 同じ位置でも前が空白なら 1 件
    big.write(` ${TOKEN} `, at);
    await writeFile(f, big);
    expect((await scanSecrets(f))?.get('GitHub トークン')).toBe(1);
  });

  it('uploadGroup の進み具合: 写したバイト数が増えていき、最後は合計に揃う', async () => {
    await writeFile(join(out, 'snapshot', 'session-state', 's2', 'events.jsonl'), 'y'.repeat(5000));
    const seen: { done: number; copied: number; bytes: number; current: string | null }[] = [];
    await uploadGroup(paths(), 'Player/Weapon', root, () => {}, { onProgress: (p) => seen.push(p) });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ sessions: 2, done: 2, current: 's2' });
    expect(last.copied).toBe(last.bytes);
    for (let i = 1; i < seen.length; i++) expect(seen[i].copied).toBeGreaterThanOrEqual(seen[i - 1].copied);
    expect(seen.some((p) => p.copied > 0 && p.copied < last.bytes)).toBe(true);
  });

  it('確認の合計と進み具合の合計は同じ(atlas が足して写すメモの本文と画像も入れる)', async () => {
    const memos = join(notes, 'memos');
    await mkdir(join(memos, 's1'), { recursive: true });
    await writeFile(join(memos, 's1.md'), '![図](s1/a.png)\n');
    await writeFile(join(memos, 's1', 'a.png'), Buffer.alloc(3000, 1));
    const p = { ...paths(), notes };
    const c = await checkUpload(p, 'Player/Weapon', root);
    expect(c.largest.some((x) => x.id === 's1' && x.path === 'atlas-memo' && x.bytes === 3000)).toBe(true);
    const seen: { bytes: number; copied: number }[] = [];
    await uploadGroup(p, 'Player/Weapon', root, () => {}, { onProgress: (q) => seen.push(q) });
    expect(seen.at(-1)!.bytes).toBe(c.bytes);
    expect(seen.at(-1)!.copied).toBe(c.bytes);
  });

  it('CLI: 秘密らしい文字列があれば --force が無い限り写さない', async () => {
    expect(parseCli(['group', 'upload', 'g', '--force']).groupCmd).toMatchObject({ action: 'upload', force: true });
    expect(() => parseCli(['group', 'export', 'g', '--force'])).toThrow(/--force は judge run と group upload/);
    await writeFile(join(out, 'snapshot', 'session-state', 's1', 'events.jsonl'), `{"data":"${TOKEN}"}\n`);
    const p = { ...resolvePaths({ home: dir, out, judgments: null, notesDir: notes }) };
    const lines: string[] = [];
    const g = { action: 'upload' as const, name: 'Player/Weapon', ids: [], note: null, to: root, force: false };
    await expect(runGroup(p, g, (m) => lines.push(m))).rejects.toThrow(/--force/);
    expect(lines.join('\n')).toMatch(/秘密らしい文字列が 1 件あります.GitHub トークン 1/);
    expect(existsSync(join(root, 'Player_Weapon'))).toBe(false);
    await runGroup(p, { ...g, force: true }, (m) => lines.push(m));
    expect(existsSync(join(root, 'Player_Weapon', 's1', 'events.jsonl'))).toBe(true);
  });

  it('serve: 写す前の点検と、写している途中の進み具合(このグループを写していなければ null)', async () => {
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    h = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, configPath, folders: { canPick: false } });
    const call = (p: string, method: string, token: string | null = h!.token) => fetch(`http://127.0.0.1:${h!.port}/${p}`, { method, headers: token ? { 'x-atlas-token': token } : {} });
    const g = encodeURIComponent('Player/Weapon');
    expect((await call(`api/groups/${g}/upload/check`, 'POST', null)).status).toBe(403);
    expect((await call(`api/groups/${g}/upload/check`, 'GET')).status).toBe(405);
    const c = (await (await call(`api/groups/${g}/upload/check`, 'POST')).json()) as { sessions: number; secrets: { count: number } };
    expect(c).toMatchObject({ sessions: 2, secrets: { count: 0 } });
    expect(existsSync(join(root, 'Player_Weapon'))).toBe(false);
    expect(await (await call(`api/groups/${g}/upload/progress`, 'GET')).json()).toBeNull();
    expect((await call(`api/groups/${g}/upload/progress`, 'POST')).status).toBe(405);
    // 写すときに確かめた指紋を渡す。確かめた後にログが変わっていたら(指紋が違えば)写さない
    const post = (body: unknown) => fetch(`http://127.0.0.1:${h!.port}/api/groups/${g}/upload`, { method: 'POST', headers: { 'x-atlas-token': h!.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const fp = (c as unknown as { fingerprint: string }).fingerprint;
    await writeFile(join(out, 'snapshot', 'session-state', 's1', 'events.jsonl'), `{"data":"${TOKEN}"}\n`);
    const stale = await post({ expect: fp });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/確かめた後に、写すログが変わりました/);
    expect(existsSync(join(root, 'Player_Weapon'))).toBe(false);
    // 中身が変わって写さなかったことは「直近の失敗」として覚えない
    expect(await (await call(`api/groups/${g}/upload/progress`, 'GET')).json()).toBeNull();
    const again = (await (await call(`api/groups/${g}/upload/check`, 'POST')).json()) as { fingerprint: string; secrets: { count: number } };
    expect(again.secrets.count).toBe(1);
    expect((await post({ expect: again.fingerprint })).status).toBe(200);
    // 終わった後は直近の結果(時刻つき)を返す
    expect(await (await call(`api/groups/${g}/upload/progress`, 'GET')).json()).toMatchObject({ finished: true, ok: true, result: { uploaded: 2 } });
    // サーバの起動を含むので、全体を同時に流したときの遅れで 5 秒を越えることがある
  }, 20_000);
});
