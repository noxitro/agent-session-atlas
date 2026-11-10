// 版の目印(code-stamp.ts): packages/*/src と template.html の中身だけで決まり、それ以外(ビルドしたもの・テスト・説明書)では変わらない
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeStamp, computeCodeStamp, PACKAGES_ROOT } from '../src/code-stamp.ts';

describe('版の目印', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atlas-stamp-'));
    await mkdir(join(root, 'cli', 'src', 'sub'), { recursive: true });
    await mkdir(join(root, 'report', 'src'), { recursive: true });
    await mkdir(join(root, 'report', 'dist'), { recursive: true });
    await mkdir(join(root, 'cli', 'test'), { recursive: true });
    await writeFile(join(root, 'cli', 'src', 'a.ts'), 'a');
    await writeFile(join(root, 'cli', 'src', 'sub', 'b.ts'), 'b');
    await writeFile(join(root, 'report', 'src', 'c.ts'), 'c');
    await writeFile(join(root, 'report', 'template.html'), '<meta>');
    await writeFile(join(root, 'report', 'dist', 'template.html'), 'built');
    await writeFile(join(root, 'cli', 'test', 'a.test.ts'), 't');
    await writeFile(join(root, 'README.md'), 'r');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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

  it('ビルドしたもの(dist)・テスト・説明書が変わっても変わらない', async () => {
    const first = computeCodeStamp(root);
    await writeFile(join(root, 'report', 'dist', 'template.html'), 'rebuilt');
    await writeFile(join(root, 'cli', 'test', 'a.test.ts'), 't2');
    await writeFile(join(root, 'README.md'), 'r2');
    expect(computeCodeStamp(root)).toBe(first);
  });

  it('codeStamp は atlas 自身の packages/ から作り、同じプロセスでは同じ値を返す', () => {
    expect(codeStamp()).toBe(computeCodeStamp(PACKAGES_ROOT));
    expect(codeStamp()).toBe(codeStamp());
  });
});
