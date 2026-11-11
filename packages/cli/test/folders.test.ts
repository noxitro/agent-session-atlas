// 「別のフォルダを開く」の、フォルダごとの置き場・状態・起動の判断(folders.ts)。
//  - 置き場の名前は、同じ名前の別のフォルダを混ぜず、画面から受け取ったキーで置き場の外を指せない
//  - 開く前に、絶対パス・実在・集計できる形を確かめ、何を読むかを一文で返す(全員の分・人ごと・プロジェクト)
//  - プロセスの番号だけでは「動いている」とみなさない(番号の使い回し)
//  - 開いている・集計しているフォルダは、もう 1 つ起動しない
// 通しの確認は e2e/phase16.test.ts(atlas open)と ui/folders.test.ts(画面)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkFolder,
  describeShape,
  FOLDER_LOG_FILE,
  FOLDER_STATE_FILE,
  FolderError,
  folderKey,
  folderPaths,
  foldersRootOf,
  forgetFolder,
  isFolderKey,
  lastLogLine,
  listFolders,
  listFolderStates,
  openFolderReport,
  readFolderState,
  runLive,
  writeFolderState,
  type FolderContext,
  type FolderState,
} from '../src/folders.ts';
import { JOB_LOCK_FILE, MAIN_TS } from '../src/jobs.ts';

const EVENT = '{"type":"session.start","data":{"sessionId":"x","version":1},"id":"e1","timestamp":"2026-07-02T09:00:00.000Z","parentId":null}\n';

/** もう終わったプロセスの番号 */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

describe('別のフォルダを開く: 置き場と状態', () => {
  let dir: string;
  let logs: string;
  let ctx: FolderContext;
  let launched: { args: string[]; log: string }[];
  let running: Map<string, number>;

  /** セッションのフォルダを 1 つ作る */
  async function session(at: string): Promise<void> {
    await mkdir(at, { recursive: true });
    await writeFile(join(at, 'events.jsonl'), EVENT);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-folders-'));
    // logs/<人>/<プロジェクト>/<セッション>
    logs = join(dir, 'logs');
    await session(join(logs, 'person-a', 'proj-a', 's1'));
    await session(join(logs, 'person-a', 'proj-b', 's2'));
    await session(join(logs, 'person-b', 'proj-a', 's3'));
    launched = [];
    running = new Map();
    ctx = {
      root: foldersRootOf(join(dir, 'out')),
      notesBase: join(dir, 'notes'),
      localOut: join(dir, 'out'),
      current: null,
      canPick: false,
      findRunning: async (outDir) => (running.has(outDir) ? { port: running.get(outDir)! } : null),
      launch: (args, log) => {
        launched.push({ args, log });
        return process.pid;
      },
      extraArgs: ['--no-open'],
      pending: new Set(),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('置き場の名前: 同じフォルダは同じ名前、同じ名前の別のフォルダは別の名前。置き場の外を指すキーは通さない', () => {
    const a = join(logs, 'person-a');
    expect(folderKey(a)).toBe(folderKey(join(logs, 'person-b', '..', 'person-a')));
    expect(folderKey(a)).toMatch(/^person-a-[0-9a-f]{8}$/);
    expect(folderKey(join(dir, 'other', 'person-a'))).not.toBe(folderKey(a));
    expect(folderKey(join(dir, '田中 太郎'))).toMatch(/^田中-太郎-[0-9a-f]{8}$/);
    expect(folderKey(join(dir, '!!!'))).toMatch(/^folder-[0-9a-f]{8}$/);
    for (const k of [folderKey(a), folderKey(join(dir, '田中 太郎'))]) expect(isFolderKey(k)).toBe(true);
    for (const k of ['..', '../x', 'a/b', 'a\\b', '', 'a.b', 'x'.repeat(61), 1, null]) expect(isFolderKey(k)).toBe(false);
    const fp = folderPaths(ctx.root, ctx.notesBase, a);
    expect(fp.out).toBe(join(dir, 'out-folders', fp.key, 'out'));
    expect(fp.notes).toBe(join(dir, 'notes', 'folders', fp.key));
  });

  it('開く前の確かめ: 全員の分・人ごと・プロジェクトのどれも通し、何を読むかを返す。だめなものは理由を返す', async () => {
    const all = await checkFolder(logs);
    expect(all).toMatchObject({ path: logs, name: 'logs', shape: { kind: 'merged' } });
    expect(all.summary).toBe('2 段下まで読み、2 個のフォルダ(person-a、person-b)の下にある 3 件のフォルダをまとめて集計します');
    // 人ごとのフォルダと、直下のアップロードしたフォルダが混ざっているとき・人が多いとき
    expect(describeShape({ kind: 'merged', folders: ['p1/a', 'p2/a', 'p3/a', 'p4/a', 'p5/a', 'p6/a', 'p7/b', 'solo'] })).toBe(
      '2 段下まで読み、7 個のフォルダ(p1、p2、p3、p4、p5 ほか 2 個)の下にある 7 件と、直下の 1 件を合わせて、8 件のフォルダをまとめて集計します',
    );
    const person = await checkFolder(`  "${join(logs, 'person-a')}"  `);
    expect(person).toMatchObject({ path: join(logs, 'person-a'), name: 'person-a' });
    expect(person.summary).toBe('下のフォルダ 2 件をまとめて集計します(proj-a、proj-b)');
    expect((await checkFolder(join(logs, 'person-a', 'proj-a'))).summary).toContain('このフォルダ 1 つを集計します');
    await mkdir(join(dir, 'empty'));
    await writeFile(join(dir, 'file.txt'), 'x');
    const bad: [unknown, RegExp][] = [
      [undefined, /パスを指定/],
      ['   ', /パスを指定/],
      ['logs', /フルパスで指定/],
      [join(dir, 'nope'), /見つかりません/],
      [join(dir, 'file.txt'), /フォルダではありません/],
      [join(dir, 'empty'), /集計できるセッションが見つかりません/],
      [`${dir}${'x'.repeat(2000)}`, /長すぎます/],
    ];
    for (const [input, re] of bad) {
      const e = await checkFolder(input).then(
        () => null,
        (x: Error) => x,
      );
      expect(e, String(input)).toBeInstanceOf(FolderError);
      expect((e as FolderError).status).toBe(400);
      expect(e!.message).toMatch(re);
    }
  });

  it('動いているかの判断: 番号があるだけでは動いているとみなさない(集計は出力先の印が同じ番号、配信は始めてすぐの間だけ)', async () => {
    const out = join(dir, 'x', 'out');
    await mkdir(out, { recursive: true });
    const now = Date.parse('2026-07-02T10:00:00.000Z');
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    expect(runLive(null, out, now)).toBe(false);
    expect(runLive({ state: 'failed', pid: process.pid, at: at(0) }, out, now)).toBe(false);
    expect(runLive({ state: 'aggregating', pid: deadPid(), at: at(0) }, out, now)).toBe(false);
    // 始めてすぐ(印を置く前・サーバが応える前)は、プロセスがあれば動いている
    expect(runLive({ state: 'aggregating', pid: process.pid, at: at(1000) }, out, now)).toBe(true);
    expect(runLive({ state: 'serving', pid: process.pid, at: at(1000) }, out, now)).toBe(true);
    // 時間が経ったら、集計は出力先の印が同じ番号のときだけ
    expect(runLive({ state: 'aggregating', pid: process.pid, at: at(120_000) }, out, now)).toBe(false);
    await writeFile(join(out, JOB_LOCK_FILE), JSON.stringify({ pid: process.pid + 1 }));
    expect(runLive({ state: 'aggregating', pid: process.pid, at: at(120_000) }, out, now)).toBe(false);
    await writeFile(join(out, JOB_LOCK_FILE), JSON.stringify({ pid: process.pid }));
    expect(runLive({ state: 'aggregating', pid: process.pid, at: at(120_000) }, out, now)).toBe(true);
    // 配信は、応えるサーバが無いまま時間が経ったら止まっている(呼ぶ側が先にサーバを探す)
    expect(runLive({ state: 'serving', pid: process.pid, at: at(120_000) }, out, now)).toBe(false);
  });

  it('開く: 別のプロセスで atlas open を始めて状態を書く。集計中・表示中のフォルダは、もう 1 つ起動しない', async () => {
    const person = join(logs, 'person-a');
    const fp = folderPaths(ctx.root, ctx.notesBase, person);
    const first = await openFolderReport(ctx, person);
    expect(first).toMatchObject({ key: fp.key, path: person, name: 'person-a', status: 'starting', url: null, error: null });
    expect(launched).toEqual([{ args: [MAIN_TS, 'open', person, '--out', ctx.localOut, '--notes-dir', ctx.notesBase, '--no-open'], log: fp.log }]);
    expect(readFolderState(fp.state)).toMatchObject({ version: 1, path: person, name: 'person-a', listed: true, run: { state: 'aggregating', pid: process.pid } });
    // 続けて押しても、もう 1 つは起動しない。進み具合は記録の最後の行
    await writeFile(fp.log, 'open: 始めます\n\nextract: 2 件\n');
    expect(await openFolderReport(ctx, person)).toMatchObject({ status: 'starting', progress: 'extract: 2 件' });
    expect(launched).toHaveLength(1);
    // サーバが応えるようになったら、その場所を返す(起動しない)
    running.set(fp.out, 51234);
    expect(await openFolderReport(ctx, person)).toMatchObject({ status: 'open', url: 'http://127.0.0.1:51234/atlas.html' });
    expect(launched).toHaveLength(1);
    // サーバが止まった後(番号は別のプロセスが使っているかもしれない)は、開き直せる
    running.clear();
    writeFolderState(fp.state, { ...readFolderState(fp.state)!, run: { state: 'serving', pid: process.pid, at: '2026-01-01T00:00:00.000Z' } });
    expect((await listFolders(ctx)).folders).toMatchObject([{ key: fp.key, status: 'idle' }]);
    expect(await openFolderReport(ctx, person)).toMatchObject({ status: 'starting' });
    expect(launched).toHaveLength(2);
    // このサーバが出しているフォルダは、開き直さない
    ctx.current = person;
    expect(await openFolderReport(ctx, person)).toMatchObject({ status: 'current' });
    expect(launched).toHaveLength(2);
    // 集計できないフォルダは、起動せずに理由を返す
    await expect(openFolderReport(ctx, join(dir, 'nope'))).rejects.toThrow(/見つかりません/);
    expect(launched).toHaveLength(2);
  });

  it('開く: 起動できなければ失敗を記録する。集計が途中で止まったもの(印が無い)は、記録の場所を添えて失敗にする', async () => {
    ctx.launch = () => null;
    const person = join(logs, 'person-b');
    const fp = folderPaths(ctx.root, ctx.notesBase, person);
    expect(await openFolderReport(ctx, person)).toMatchObject({ status: 'failed', error: expect.stringMatching(/始められませんでした/) });
    writeFolderState(fp.state, { ...readFolderState(fp.state)!, run: { state: 'aggregating', pid: deadPid(), at: new Date().toISOString() } });
    const [entry] = (await listFolders(ctx)).folders;
    expect(entry).toMatchObject({ status: 'failed' });
    expect(entry.error).toContain(join(fp.dir, FOLDER_LOG_FILE));
    // 失敗の理由は、開いた側のプロセスが書いたものを出す
    writeFolderState(fp.state, { ...readFolderState(fp.state)!, run: { state: 'failed', pid: 1, at: new Date().toISOString(), error: '出力先を別の処理が使っています' } });
    expect((await listFolders(ctx)).folders[0]).toMatchObject({ status: 'failed', error: '出力先を別の処理が使っています' });
  });

  it('一覧: 新しく開いた順に並べ、外したものは出さない(出力は残す)。この PC の集計の画面が開いていれば、その場所を返す', async () => {
    const state = (path: string, openedAt: string, listed = true): FolderState => ({ version: 1, path, name: path.split(/[\\/]/).at(-1)!, addedAt: openedAt, openedAt, listed, run: null });
    const a = folderPaths(ctx.root, ctx.notesBase, join(logs, 'person-a'));
    const b = folderPaths(ctx.root, ctx.notesBase, join(logs, 'person-b'));
    const all = folderPaths(ctx.root, ctx.notesBase, logs);
    writeFolderState(a.state, state(join(logs, 'person-a'), '2026-07-01T00:00:00.000Z'));
    writeFolderState(b.state, state(join(logs, 'person-b'), '2026-07-03T00:00:00.000Z'));
    writeFolderState(all.state, state(logs, '2026-07-02T00:00:00.000Z'));
    await mkdir(join(ctx.root, 'broken'), { recursive: true });
    await writeFile(join(ctx.root, 'broken', FOLDER_STATE_FILE), '{');
    expect(listFolderStates(ctx.root).map((x) => x.key)).toEqual([b.key, all.key, a.key]);
    let list = await listFolders(ctx);
    expect(list).toMatchObject({ canPick: false, current: null, local: { status: 'current', url: null } });
    expect(list.folders.map((f) => [f.name, f.status])).toEqual([
      ['person-b', 'idle'],
      ['logs', 'idle'],
      ['person-a', 'idle'],
    ]);
    // 外す: 一覧から消えるが、置き場は残る。同じフォルダを開けば戻る
    for (const k of ['../x', 'a/b', 5]) expect(() => forgetFolder(ctx, k)).toThrow(/正しくありません/);
    expect(() => forgetFolder(ctx, 'none-00000000')).toThrow(expect.objectContaining({ status: 404 }));
    forgetFolder(ctx, b.key);
    expect((await listFolders(ctx)).folders.map((f) => f.name)).toEqual(['logs', 'person-a']);
    expect(existsSync(b.state)).toBe(true);
    await openFolderReport(ctx, join(logs, 'person-b'));
    expect((await listFolders(ctx)).folders.map((f) => f.name)).toEqual(['person-b', 'logs', 'person-a']);
    // フォルダの画面から見たとき: そのフォルダは「この画面」、この PC の集計は、開いていればその場所
    ctx.current = logs;
    list = await listFolders(ctx);
    expect(list).toMatchObject({ current: { path: logs, name: 'logs' }, local: { status: 'idle', url: null } });
    expect(list.folders.find((f) => f.key === all.key)).toMatchObject({ status: 'current' });
    running.set(ctx.localOut, 50001);
    expect((await listFolders(ctx)).local).toEqual({ status: 'open', url: 'http://127.0.0.1:50001/atlas.html' });
    // 外してあっても、この画面が出しているフォルダは出す
    forgetFolder(ctx, all.key);
    expect((await listFolders(ctx)).folders.map((f) => f.name)).toContain('logs');
  });

  it('記録の最後の行: 空の行を飛ばし、大きな記録は末尾だけ読む', async () => {
    const log = join(dir, 'open.log');
    expect(lastLogLine(log)).toBeNull();
    await writeFile(log, '');
    expect(lastLogLine(log)).toBeNull();
    await writeFile(log, `${'x'.repeat(9000)}\n途中\n  最後の行  \n\n`);
    expect(lastLogLine(log)).toBe('最後の行');
    await writeFile(log, 'y'.repeat(9000));
    expect(lastLogLine(log)).toBeNull();
  });
});
