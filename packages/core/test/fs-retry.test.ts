// renameReplacing: Windows で置き換え先が一時的に開かれているときの EPERM / EACCES / EBUSY は、少し待ってやり直す
// replaceEntries: 作りかけの場所に作り終えてから入れ替える。作れなかったとき・入れ替えられなかったときは前のものを残す
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rename } = vi.hoisted(() => ({ rename: vi.fn<(from: string, to: string) => Promise<void>>() }));
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<typeof import('node:fs/promises')>()), rename }));
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const { removeTree, renameReplacing, replaceEntries } = await import('../src/fs-retry.ts');

const fail = (code: string): Error => Object.assign(new Error(code), { code });
const platform = process.platform;
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

describe('renameReplacing', () => {
  afterEach(() => {
    setPlatform(platform);
    rename.mockReset();
  });

  it('Windows では一時的な EPERM / EACCES / EBUSY をやり直して置き換える', async () => {
    setPlatform('win32');
    rename.mockRejectedValueOnce(fail('EPERM')).mockRejectedValueOnce(fail('EACCES')).mockRejectedValueOnce(fail('EBUSY')).mockResolvedValueOnce();
    await renameReplacing('a.tmp', 'a');
    expect(rename).toHaveBeenCalledTimes(4);
  });

  it('やり直しても直らない種類のエラー(ENOENT など)はすぐに投げる', async () => {
    setPlatform('win32');
    rename.mockRejectedValue(fail('ENOENT'));
    await expect(renameReplacing('a.tmp', 'a')).rejects.toThrow('ENOENT');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('Windows 以外ではやり直さない(置き換え先が開かれていても rename は失敗しない)', async () => {
    setPlatform('linux');
    rename.mockRejectedValue(fail('EPERM'));
    await expect(renameReplacing('a.tmp', 'a')).rejects.toThrow('EPERM');
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe('replaceEntries', () => {
  const NAMES = ['manifest.json', 'parts', 'extra.md'];
  let d: string;
  const write = async (stage: string, tag: string): Promise<string> => {
    await mkdir(join(stage, 'parts'));
    await writeFile(join(stage, 'parts', `${tag}.md`), tag);
    await writeFile(join(stage, 'manifest.json'), tag);
    return tag;
  };
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'atlas-swap-'));
    rename.mockImplementation(real.rename);
  });
  afterEach(async () => {
    setPlatform(platform);
    rename.mockReset();
    await rm(d, { recursive: true, force: true });
  });

  it('作り終えたものへ入れ替える。作らなかった名前は前のものを消し、決まった名前のほかには触らない', async () => {
    await writeFile(join(d, 'memo.txt'), '利用者のファイル');
    await writeFile(join(d, 'extra.md'), '前の版だけにある');
    expect(await replaceEntries(d, NAMES, (stage) => write(stage, 'v1'))).toBe('v1');
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'memo.txt', 'parts']);
    await replaceEntries(d, NAMES, (stage) => write(stage, 'v2'));
    expect(await readFile(join(d, 'manifest.json'), 'utf8')).toBe('v2');
    expect(await readdir(join(d, 'parts'))).toEqual(['v2.md']);
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'memo.txt', 'parts']);
  });

  it('作る途中で失敗したら、前のものをそのまま残し、作りかけは消す', async () => {
    await replaceEntries(d, NAMES, (stage) => write(stage, 'v1'));
    const failing = async (stage: string): Promise<string> => {
      await write(stage, 'v2');
      throw new Error('途中で止まった');
    };
    await expect(replaceEntries(d, NAMES, failing)).rejects.toThrow('途中で止まった');
    expect(await readFile(join(d, 'manifest.json'), 'utf8')).toBe('v1');
    expect(await readdir(join(d, 'parts'))).toEqual(['v1.md']);
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'parts']);
  });

  it('前のものを退けられない(ほかのアプリが開いている)ときは、退けた分を戻して、理由と確かめることを添えて投げる', async () => {
    setPlatform('linux'); // やり直しの待ちを挟まない
    await replaceEntries(d, NAMES, (stage) => write(stage, 'v1'));
    // 一覧は退けられるが、parts を退けるところで失敗する
    rename.mockImplementation((from, to) => (from === join(d, 'parts') && basename(to) === 'parts' ? Promise.reject(fail('EBUSY')) : real.rename(from, to)));
    await expect(replaceEntries(d, NAMES, (stage) => write(stage, 'v2'))).rejects.toThrow(/の中身を置き換えられません\(EBUSY\)。ほかのアプリが.*前の内容はそのまま残しています$/);
    expect(await readFile(join(d, 'manifest.json'), 'utf8')).toBe('v1');
    expect(await readdir(join(d, 'parts'))).toEqual(['v1.md']);
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'parts']);
  });

  it('新しいものを入れられないときも、入れた分を返して前のものを戻す', async () => {
    setPlatform('linux');
    await replaceEntries(d, NAMES, (stage) => write(stage, 'v1'));
    // 作りかけの場所から入れるのは parts → manifest.json の順。2 つ目(一覧)で失敗させる
    rename.mockImplementation((from, to) => (from === join(d, '.next', 'manifest.json') ? Promise.reject(fail('EACCES')) : real.rename(from, to)));
    await expect(replaceEntries(d, NAMES, (stage) => write(stage, 'v2'))).rejects.toThrow(/前の内容はそのまま残しています$/);
    expect(await readFile(join(d, 'manifest.json'), 'utf8')).toBe('v1');
    expect(await readdir(join(d, 'parts'))).toEqual(['v1.md']);
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'parts']);
  });

  it('前に途中で止まった残り(作りかけ・退けたもの)は、次に作るときに消す', async () => {
    await mkdir(join(d, '.next', 'parts'), { recursive: true });
    await writeFile(join(d, '.next', 'parts', 'old.md'), '残り');
    await mkdir(join(d, '.prev'));
    await writeFile(join(d, '.prev', 'manifest.json'), '残り');
    await replaceEntries(d, NAMES, (stage) => write(stage, 'v1'));
    expect((await readdir(d)).sort()).toEqual(['manifest.json', 'parts']);
    expect(await readdir(join(d, 'parts'))).toEqual(['v1.md']);
  });
});

describe('removeTree', () => {
  it('中身ごと消す。無ければ何もしない', async () => {
    const d = await mkdtemp(join(tmpdir(), 'atlas-rmtree-'));
    await mkdir(join(d, 'a', 'b'), { recursive: true });
    await writeFile(join(d, 'a', 'b', 'c.txt'), '');
    await removeTree(join(d, 'a'));
    await removeTree(join(d, 'a'));
    expect(existsSync(join(d, 'a'))).toBe(false);
    await rm(d, { recursive: true, force: true });
  });
});
