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

  // 囲み「if … (」〜「)」の中の echo と rem に半角の括弧があると、cmd がそれを囲みの終わりと読み、条件に関わらずその行で止まる
  // (upload-project.bat の「集計に失敗しました…(…)。」で、集計が成功しても「。 was unexpected at this time.」で止まっていた)
  it.each(BATS)('%s は囲みの中の echo と rem に半角の括弧を書かない(書くなら ^( ^) にする)', (f) => {
    const bad: string[] = [];
    let depth = 0;
    readFileSync(join(ROOT, f), 'utf8')
      .split(/\r\n/)
      .forEach((raw, i) => {
        const line = raw.trim();
        if (/^\)/.test(line)) depth--;
        if (depth > 0 && /^(echo|rem)\b/i.test(line) && /(^|[^^])[()]/.test(line.replace(/^(echo|rem)\b/i, ''))) bad.push(`${i + 1}: ${line}`);
        if (/\($/.test(line)) depth++;
      });
    expect(bad).toEqual([]);
  });

  // 配布 zip を展開した先(.git が無い)では git check-attr が使えないので見ない
  it.skipIf(!existsSync(join(ROOT, '.git'))).each(BATS)('%s は .gitattributes で eol=crlf が効いている', (f) => {
    expect(execFileSync('git', ['check-attr', 'eol', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()).toBe(`${f}: eol: crlf`);
  });
});
