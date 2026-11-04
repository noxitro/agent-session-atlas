// renameReplacing: Windows で置き換え先が一時的に開かれているときの EPERM / EACCES / EBUSY は、少し待ってやり直す
import { afterEach, describe, expect, it, vi } from 'vitest';

const rename = vi.fn<(from: string, to: string) => Promise<void>>();
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<typeof import('node:fs/promises')>()), rename }));
const { renameReplacing } = await import('../src/fs-retry.ts');

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
