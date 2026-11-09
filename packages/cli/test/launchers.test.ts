// 利用者がダブルクリックで起動する *.bat の形式。
// LF だけの改行だと cmd が goto のラベルを読めずに失敗する(a3527a5 で atlas-export.bat に実際に起きた)。
// BOM があると先頭の @echo off がコマンド名として読まれる。.gitattributes の eol=crlf が外れたらここで止める。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const BATS = readdirSync(ROOT).filter((f) => f.endsWith('.bat'));

describe('*.bat', () => {
  it('リポジトリ直下にあるのは atlas.bat(集計と画面)・setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)だけ(他の操作は画面とコマンドから)', () => {
    expect(BATS).toEqual(['atlas.bat', 'setup.bat', 'upload-project.bat']);
  });

  it.each(BATS)('%s は改行がすべて CRLF で、BOM が無い', (f) => {
    const buf = readFileSync(join(ROOT, f));
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const text = buf.toString('utf8');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.match(/(^|[^\r])\n/g)).toBeNull();
  });

  // 配布 zip を展開した先(.git が無い)では git check-attr が使えないので見ない
  it.skipIf(!existsSync(join(ROOT, '.git'))).each(BATS)('%s は .gitattributes で eol=crlf が効いている', (f) => {
    expect(execFileSync('git', ['check-attr', 'eol', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()).toBe(`${f}: eol: crlf`);
  });
});
