// package-lock.json の中身の検査(サプライチェーン)。npm audit は既知の advisory しか見ないので、
// lockfile に紛れ込んだ取得元の差し替え・整合性の欠け・インストール時のスクリプトをここで止める。
// ネットワークは使わない(package-lock.json と package.json だけを読む)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  optional?: boolean;
  os?: string[];
};
const lock = readJson('package-lock.json') as { lockfileVersion: number; packages: Record<string, LockEntry> };
const rootPkg = readJson('package.json') as { workspaces: string[] };

// ワークスペース(packages/report)は lockfile にリンクと本体の 2 行で載る。取得元も整合性も持たない
const workspaces = new Set(rootPkg.workspaces);
const isWorkspace = (key: string, e: LockEntry) =>
  workspaces.has(key) || (e.link === true && workspaces.has(e.resolved ?? ''));
const installed = Object.entries(lock.packages).filter(([key, e]) => key !== '' && !isWorkspace(key, e));

// インストール時にスクリプトを動かしてよいパッケージ(理由つき)。足すときは中身を確かめてから
const INSTALL_SCRIPT_ALLOWED: Record<string, string> = {
  // macOS だけの任意の依存(vite・rollup 経由)。Linux / Windows では入らない
  fsevents: 'macOS だけの任意の依存',
};
const nameOf = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

describe('package-lock.json', () => {
  it('lockfileVersion 3 で、入るパッケージがある', () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(installed.length).toBeGreaterThan(0);
  });

  it('どのパッケージも npm の公式レジストリから HTTPS で取る(git・tarball の URL・ほかのレジストリは入れない)', () => {
    const bad = installed
      .filter(([, e]) => !e.resolved?.startsWith('https://registry.npmjs.org/'))
      .map(([key, e]) => `${key}: ${e.resolved}`);
    expect(bad).toEqual([]);
  });

  it('取得元の URL はパッケージの名前と版に合う(別のパッケージに差し替えられていない)', () => {
    const bad = installed
      .filter(([key, e]) => {
        const name = nameOf(key);
        const base = name.includes('/') ? name.split('/')[1] : name;
        return e.resolved !== `https://registry.npmjs.org/${name}/-/${base}-${e.version}.tgz`;
      })
      .map(([key, e]) => `${key}@${e.version}: ${e.resolved}`);
    expect(bad).toEqual([]);
  });

  it('どのパッケージも sha512 の整合性ハッシュを持つ', () => {
    const bad = installed
      .filter(([, e]) => !/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity ?? ''))
      .map(([key, e]) => `${key}: ${e.integrity}`);
    expect(bad).toEqual([]);
  });

  it('インストール時のスクリプトを持つのは許したものだけ', () => {
    const withScripts = installed.filter(([, e]) => e.hasInstallScript).map(([key]) => nameOf(key));
    expect(withScripts.filter((n) => !(n in INSTALL_SCRIPT_ALLOWED))).toEqual([]);
  });

  it('許したスクリプトのパッケージは任意の依存のまま(必ず入るものになったら見直す)', () => {
    for (const [key, e] of installed) {
      if (e.hasInstallScript && nameOf(key) in INSTALL_SCRIPT_ALLOWED) expect(e.optional, key).toBe(true);
    }
  });

  it('ワークスペースのほかにリンク(手元のフォルダ)は入れない', () => {
    expect(installed.filter(([, e]) => e.link).map(([key]) => key)).toEqual([]);
  });
});
