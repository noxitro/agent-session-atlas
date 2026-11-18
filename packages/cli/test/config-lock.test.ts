// 設定ファイルのロックが、Windows で一時的に出る失敗(消したばかりのロックをほかのプログラムが開いている間の EPERM・EBUSY)で
// 書き換えを失敗にしないこと。ファイルの操作のうち、ロックを作る・消す操作だけを、決まった回数だけ失敗させる
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fail = vi.hoisted(() => ({ open: 0, rm: 0, code: 'EPERM' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const err = (op: string): NodeJS.ErrnoException => Object.assign(new Error(`${fail.code}: operation not permitted, ${op}`), { code: fail.code });
  return {
    ...real,
    open: (async (p: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
      if (String(p).endsWith('.lock') && fail.open > 0) {
        fail.open--;
        throw err('open');
      }
      return (real.open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.open,
    rm: (async (p: Parameters<typeof real.rm>[0], o?: Parameters<typeof real.rm>[1]) => {
      if (String(p).endsWith('.lock') && fail.rm > 0) {
        fail.rm--;
        throw err('unlink');
      }
      return real.rm(p, o);
    }) as typeof real.rm,
  };
});

const { updateConfig } = await import('../src/config.ts');

let dir = '';
const platform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => void Object.defineProperty(process, 'platform', { value: p });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-config-lock-'));
  Object.assign(fail, { open: 0, rm: 0, code: 'EPERM' });
});
afterEach(() => {
  setPlatform(platform);
  rmSync(dir, { recursive: true, force: true });
});

describe('設定ファイルのロック(Windows の一時的な失敗)', () => {
  it('ロックを作るのが一時的に EPERM(削除待ち)になっても、待って取り直し、書き換えを済ませる', async () => {
    setPlatform('win32');
    const p = join(dir, 'c.json');
    writeFileSync(p, '{}');
    fail.open = 5;
    await updateConfig(p, 'uploadProjects', ['a']);
    expect(fail.open).toBe(0);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadProjects).toEqual(['a']);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('書き終えた後にロックを消せなくても、書き換えは失敗にしない。残ったロックは、古くなれば次の書き換えが消して取り直す', async () => {
    setPlatform('win32');
    const p = join(dir, 'c.json');
    writeFileSync(p, '{}');
    fail.code = 'EBUSY';
    fail.rm = 1;
    await updateConfig(p, 'uploadProjects', ['a']);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadProjects).toEqual(['a']);
    expect(existsSync(`${p}.lock`)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${p}.lock`, old, old);
    await updateConfig(p, 'uploadProjects', ['b']);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadProjects).toEqual(['b']);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('Windows でなければ、EPERM は本当に書けないものとして、すぐに失敗にする', async () => {
    setPlatform('linux');
    const p = join(dir, 'c.json');
    writeFileSync(p, '{}');
    fail.open = 1;
    await expect(updateConfig(p, 'uploadProjects', ['a'])).rejects.toMatchObject({ code: 'EPERM' });
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadProjects).toBeUndefined();
  });
});
