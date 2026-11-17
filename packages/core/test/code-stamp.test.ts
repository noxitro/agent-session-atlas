// 版の目印(code-stamp.ts): 画面とサーバの動きを決めるファイル(packages/*/src、各パッケージの設定と依存、リポジトリの直下の依存)の中身だけで決まり、
// それ以外(ビルドしたもの・テスト・説明書・エディタの作業ファイル・改行の違い)では変わらない
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeStamp, computeCodeStamp, PACKAGES_ROOT } from '../src/code-stamp.ts';

describe('版の目印', () => {
  /** リポジトリの直下にあたる場所 */
  let top: string;
  /** packages/ にあたる場所 */
  let root: string;
  beforeEach(async () => {
    top = await mkdtemp(join(tmpdir(), 'atlas-stamp-'));
    root = join(top, 'packages');
    await mkdir(join(root, 'cli', 'src', 'sub'), { recursive: true });
    await mkdir(join(root, 'report', 'src'), { recursive: true });
    await mkdir(join(root, 'report', 'dist'), { recursive: true });
    await mkdir(join(root, 'cli', 'test'), { recursive: true });
    await mkdir(join(top, 'scripts'), { recursive: true });
    await writeFile(join(root, 'cli', 'src', 'a.ts'), 'a');
    await writeFile(join(root, 'cli', 'src', 'sub', 'b.ts'), 'b');
    await writeFile(join(root, 'cli', 'package.json'), '{"name":"cli"}');
    await writeFile(join(root, 'report', 'src', 'c.ts'), 'c');
    await writeFile(join(root, 'report', 'template.html'), '<meta>');
    await writeFile(join(root, 'report', 'vite.config.ts'), 'vite');
    await writeFile(join(root, 'report', 'svelte.config.js'), 'svelte');
    await writeFile(join(root, 'report', 'tsconfig.json'), '{}');
    await writeFile(join(root, 'report', 'package.json'), '{"name":"report"}');
    await writeFile(join(root, 'report', 'dist', 'template.html'), 'built');
    await writeFile(join(root, 'cli', 'test', 'a.test.ts'), 't');
    await writeFile(join(root, 'README.md'), 'r');
    await writeFile(join(top, 'package.json'), '{"name":"atlas"}');
    await writeFile(join(top, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(join(top, 'tsconfig.json'), '{}');
    await writeFile(join(top, 'README.md'), 'r');
    await writeFile(join(top, 'scripts', 'deps.mjs'), 's');
  });
  afterEach(async () => {
    await rm(top, { recursive: true, force: true });
  });

  it('同じ中身なら同じ。src の下(入れ子も)と template.html が変われば変わる', async () => {
    const first = computeCodeStamp(root);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(computeCodeStamp(root)).toBe(first);
    await writeFile(join(root, 'cli', 'src', 'sub', 'b.ts'), 'b2');
    const second = computeCodeStamp(root);
    expect(second).not.toBe(first);
    await writeFile(join(root, 'report', 'template.html'), '<meta name="x">');
    expect(computeCodeStamp(root)).not.toBe(second);
  });

  it('ファイル名が変わっても変わる(中身が同じでも)。新しいファイルでも変わる', async () => {
    const first = computeCodeStamp(root);
    await rm(join(root, 'cli', 'src', 'a.ts'));
    await writeFile(join(root, 'cli', 'src', 'a2.ts'), 'a');
    const renamed = computeCodeStamp(root);
    expect(renamed).not.toBe(first);
    await writeFile(join(root, 'report', 'src', 'new.ts'), '');
    expect(computeCodeStamp(root)).not.toBe(renamed);
  });

  it('画面の作り方と依存を決めるファイル(各パッケージの設定と package.json、リポジトリの直下の package.json・package-lock.json・tsconfig.json)が変わっても変わる', async () => {
    let prev = computeCodeStamp(root);
    for (const path of [
      join(root, 'report', 'vite.config.ts'),
      join(root, 'report', 'svelte.config.js'),
      join(root, 'report', 'tsconfig.json'),
      join(root, 'report', 'package.json'),
      join(root, 'cli', 'package.json'),
      join(top, 'package.json'),
      join(top, 'package-lock.json'),
      join(top, 'tsconfig.json'),
    ]) {
      await writeFile(path, `changed ${path}`);
      const next = computeCodeStamp(root);
      expect(next, path).not.toBe(prev);
      prev = next;
    }
    // 無くても作れる(パッケージに設定が無い、リポジトリの直下に lock が無い)
    await rm(join(top, 'package-lock.json'));
    await rm(join(root, 'report', 'svelte.config.js'));
    expect(computeCodeStamp(root)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ビルドしたもの(dist)・テスト・説明書・scripts が変わっても変わらない', async () => {
    const first = computeCodeStamp(root);
    await writeFile(join(root, 'report', 'dist', 'template.html'), 'rebuilt');
    await writeFile(join(root, 'cli', 'test', 'a.test.ts'), 't2');
    await writeFile(join(root, 'README.md'), 'r2');
    await writeFile(join(top, 'README.md'), 'r2');
    await writeFile(join(top, 'scripts', 'deps.mjs'), 's2');
    expect(computeCodeStamp(root)).toBe(first);
  });

  it('エディタや OS が src の下に置く作業ファイル(. で始まるもの・バックアップ・パッチの残り・スワップ)では変わらない', async () => {
    const first = computeCodeStamp(root);
    await mkdir(join(root, 'cli', 'src', '.cache'), { recursive: true });
    for (const name of ['.DS_Store', '.a.ts.swp', 'a.ts~', 'a.ts.bak', 'a.ts.orig', 'a.ts.rej', 'x.tmp', 'Thumbs.db', 'desktop.ini', join('.cache', 'x.ts'), join('sub', '.b.ts.swp')]) {
      await writeFile(join(root, 'cli', 'src', name), 'junk');
      expect(computeCodeStamp(root), name).toBe(first);
    }
    // 作業ファイルに似ていても、ソースなら数える
    await writeFile(join(root, 'cli', 'src', 'tmp.ts'), '');
    expect(computeCodeStamp(root)).not.toBe(first);
  });

  it('改行が CRLF でも LF でも同じ(チェックアウトの設定で改行だけが変わっても変わらない)。中身が違えば変わる', async () => {
    await writeFile(join(root, 'cli', 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    await writeFile(join(top, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n');
    const lf = computeCodeStamp(root);
    await writeFile(join(root, 'cli', 'src', 'a.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
    await writeFile(join(top, 'package-lock.json'), '{\r\n  "lockfileVersion": 3\r\n}\r\n');
    expect(computeCodeStamp(root)).toBe(lf);
    // 日本語(UTF-8 の複数バイト)が入っていても、改行だけをそろえる
    await writeFile(join(root, 'cli', 'src', 'a.ts'), '// 目印\r\nconst a = 1;\r\n');
    const ja = computeCodeStamp(root);
    expect(ja).not.toBe(lf);
    await writeFile(join(root, 'cli', 'src', 'a.ts'), '// 目印\nconst a = 1;\n');
    expect(computeCodeStamp(root)).toBe(ja);
    await writeFile(join(root, 'cli', 'src', 'a.ts'), '// 目印\nconst a = 2;\n');
    expect(computeCodeStamp(root)).not.toBe(ja);
  });

  it('codeStamp は atlas 自身の packages/ から作り、同じプロセスでは同じ値を返す', () => {
    expect(codeStamp()).toBe(computeCodeStamp(PACKAGES_ROOT));
    expect(codeStamp()).toBe(codeStamp());
  });
});
