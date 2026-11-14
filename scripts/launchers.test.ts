// 利用者がダブルクリックで起動する *.bat と、その最初に動く scripts/ensure-atlas.ps1、TS 版で登録したタスクのための互換の入口の形式。
// LF だけの改行だと cmd が goto のラベルを読めずに失敗する(a3527a5 で atlas-export.bat に実際に起きた)。
// BOM があると先頭の @echo off がコマンド名として読まれる。.gitattributes の eol=crlf が外れたらここで止める。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeConsole } from './console-text.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BATS = readdirSync(ROOT).filter((f) => f.endsWith('.bat'));
const ENSURE = 'scripts/ensure-atlas.ps1';
const SHIM = 'packages/cli/src/upload-auto.ts';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** 各 bat が最後に動かす atlas のサブコマンド */
const FINAL: Record<string, RegExp> = {
  'atlas.bat': /^bin\\atlas\.exe serve$/,
  'open-folder.bat': /^bin\\atlas\.exe open %\*$/,
  'schedule-upload.bat': /^bin\\atlas\.exe upload-schedule$/,
  'setup.bat': /^bin\\atlas\.exe setup$/,
  'upload-project.bat': /^bin\\atlas\.exe upload-project$/,
};

const codeLines = (f: string): string[] =>
  readFileSync(join(ROOT, f), 'utf8')
    .split(/\r\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^rem\b/i.test(l));

describe('cmd の出力を読む(scripts/console-text.ts)', () => {
  it('cp932 の行(cmd の文言)と UTF-8 の行(中の atlas の出力)が混ざっていても、1 行ずつ合うほうで読む', () => {
    // 「) は予期されていません。」(cp932。「予」の 2 バイト目は 0x5C)
    const cmd = Buffer.from([0x29, 0x20, 0x82, 0xcd, 0x97, 0x5c, 0x8a, 0xfa, 0x82, 0xb3, 0x82, 0xea, 0x82, 0xc4, 0x82, 0xa2, 0x82, 0xdc, 0x82, 0xb9, 0x82, 0xf1, 0x81, 0x42]);
    const mixed = Buffer.concat([Buffer.from('== 集計 ==\r\n  最新のログを集計しています。\r\n'), cmd, Buffer.from('\r\n続行するには何かキーを押してください . . .')]);
    expect(decodeConsole(mixed)).toBe('== 集計 ==\r\n  最新のログを集計しています。\r\n) は予期されていません。\r\n続行するには何かキーを押してください . . .');
    // 丸ごと cp932 で読むと UTF-8 の行が化け、丸ごと UTF-8 で読むと cmd の文言が化ける(どちらも前の読み方で起きた)
    expect(new TextDecoder('shift_jis').decode(mixed)).not.toContain('集計');
    expect(mixed.toString('utf8')).not.toContain('予期されていません');
    expect(decodeConsole(Buffer.from('abc\n'))).toBe('abc\n');
    expect(decodeConsole(Buffer.alloc(0))).toBe('');
    expect(decodeConsole(null)).toBe('');
  });
});

describe('*.bat', () => {
  it('リポジトリ直下にあるのは atlas.bat(集計と画面)・open-folder.bat(選んだフォルダを集計して開く)・schedule-upload.bat(毎日自動で送る登録)・setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)だけ(他の操作は画面とコマンドから)', () => {
    expect(BATS).toEqual(Object.keys(FINAL));
  });

  it.each(BATS)('%s は改行がすべて CRLF で、BOM が無い', (f) => {
    const buf = readFileSync(join(ROOT, f));
    expect(buf.subarray(0, 3).equals(BOM)).toBe(false);
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

  // 日本語の説明の rem が冒頭(chcp 65001 の前)にあった upload-project.bat と setup.bat は、中のプログラムや pause から戻ったときに、
  // cmd が前の行の途中(「'r' is not recognized」「'pm' is not recognized」など)を毎回実行していた。
  // 実測で分かったこと: chcp 65001 の前の日本語を無くし、説明の rem を最後に実行する行より後ろに移すと起きない
  // (説明を chcp の後ろに移しただけでは、パイプで入力を渡したときにときどき起きた)。原因の細かい仕組みは確かめていない
  it.each(BATS)('%s は chcp 65001 より前に日本語を書かず、説明の rem は最後に実行する行(exit /b)より後ろにだけ置く', (f) => {
    const lines = readFileSync(join(ROOT, f), 'utf8').split(/\r\n/);
    const isRem = (l: string): boolean => /^rem\b/i.test(l.trim());
    const nonAscii = (l: string): boolean => /[^\x00-\x7f]/.test(l);
    const chcp = lines.findIndex((l) => /^chcp 65001\b/i.test(l.trim()));
    expect(chcp).toBeGreaterThan(-1);
    expect(lines.slice(0, chcp).filter(nonAscii)).toEqual([]);
    const lastCode = lines.findLastIndex((l) => l.trim() !== '' && !isRem(l));
    expect(lines[lastCode]).toMatch(/exit \/b( %\w+%)?$/i);
    const early = lines.flatMap((l, i) => (i < lastCode && isRem(l) && nonAscii(l) ? [`${i + 1}: ${l}`] : []));
    expect(early).toEqual([]);
  });

  // 実行ファイルを用意してから動かす。Node.js の確かめと npm install はもうしない(Node.js が無くても、リリースがあれば動く)
  it.each(BATS)('%s は最初に scripts\\ensure-atlas.ps1 を動かし、失敗したら止まる。node と npm は呼ばない', (f) => {
    const lines = codeLines(f);
    const i = lines.findIndex((l) => /ensure-atlas\.ps1/i.test(l));
    expect(lines[i]).toBe('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\ensure-atlas.ps1');
    expect(lines.slice(i + 1, i + 5)).toEqual(['if errorlevel 1 (', 'echo.', 'pause', 'exit /b 1']);
    expect(lines.findIndex((l) => /^bin\\atlas\.exe\b/i.test(l))).toBeGreaterThan(i);
    expect(lines.filter((l) => /^(where )?node\b|\bnpm\b|deps-fresh|packages\\cli/i.test(l))).toEqual([]);
  });

  // 最後に動かす atlas の終了コードを、bat の終了コードとして返す(「& exit /b」で終えると、cmd の終了コードは常に 0 になる)。
  // 同じ行に %errorlevel% を書くと行を読んだとき(atlas の前)の値になるので、次の行で調べるか取っておく
  it.each(BATS)('%s は最後に bin\\atlas.exe <サブコマンド> を動かし、その終了コードを次の行で調べるか取っておく', (f) => {
    const lines = codeLines(f);
    const last = lines.findLastIndex((l) => /^bin\\atlas\.exe\b/i.test(l));
    expect(lines[last]).toMatch(FINAL[f]);
    expect(lines[last]).not.toContain('&');
    expect(lines[last + 1]).toMatch(/^(if errorlevel 1 \(|set "code=%errorlevel%"|exit \/b %errorlevel%)$/i);
  });

  // git の無い場所(git archive で作ったフォルダなど)では git check-attr が使えないので見ない
  it.skipIf(!existsSync(join(ROOT, '.git'))).each([...BATS, ENSURE])('%s は .gitattributes で eol=crlf が効いている', (f) => {
    expect(execFileSync('git', ['check-attr', 'eol', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()).toBe(`${f.replaceAll('\\', '/')}: eol: crlf`);
  });
});

describe('scripts/ensure-atlas.ps1', () => {
  const buf = readFileSync(join(ROOT, ENSURE));
  const text = buf.subarray(3).toString('utf8');

  // Windows PowerShell 5.1 は BOM の無いファイルを ANSI(日本語の Windows では cp932)で読み、日本語の文言が化ける
  it('BOM 付きの UTF-8 で、改行はすべて CRLF', () => {
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
    expect(text.match(/(^|[^\r])\n/g)).toBeNull();
  });

  it('リリースを探すリポジトリは決め打ちせず、origin から決める。取ってきたものは sha256 と版を確かめてから置く', () => {
    expect(text).toContain('git -C $Repo remote get-url origin');
    expect(text).not.toMatch(/github\.com\/[A-Za-z0-9-]+\/agent-session-atlas/);
    expect(text).toContain('atlas.exe.sha256');
    expect(text).toContain('Get-FileHash -Algorithm SHA256');
    // 置く前に、取ってきたものの版を atlas --version で確かめる
    expect(text).toContain('Get-ExeInfo $file');
    // PowerShell の変数は大文字小文字を区別しない: 置き場所の $Exe を、取ってきた・作ったファイルの $exe で上書きしない(上書きして、置く前に消していた)
    expect(text.match(/\$exe\b/g) ?? []).toEqual([]);
  });

  it('管理者の権限が要る操作をしない', () => {
    expect(text).not.toMatch(/RunAs|Set-ExecutionPolicy|-Scope\s+(LocalMachine|AllUsers)|Program Files/i);
  });
});

describe('TS 版で登録したタスクのための互換の入口(packages/cli/src/upload-auto.ts)', () => {
  const text = readFileSync(join(ROOT, SHIM), 'utf8');
  it('node: の標準モジュールだけを読み込む(npm install していなくても動く)', () => {
    const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((m) => !m.startsWith('node:'))).toEqual([]);
  });
  it('ensure-atlas.ps1 で実行ファイルを用意してから bin の atlas upload-auto を同じ引数で動かし、登録し直すよう知らせる', () => {
    expect(text).toContain("join(ROOT, 'scripts', 'ensure-atlas.ps1')");
    expect(text).toContain("['upload-auto', ...process.argv.slice(2)]");
    expect(text).toContain('schedule-upload.bat を開くと');
  });
});
