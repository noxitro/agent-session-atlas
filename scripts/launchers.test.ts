// 利用者がダブルクリックで起動する *.bat と、そこから動く入口(開くたびの更新 packages/cli/src/launcher-update.ts)、
// 止める stop.bat と scripts/stop-atlas.ps1、前の版(bin\atlas.exe で動いていた版)から移るときに呼ばれる scripts/ensure-atlas.ps1 の形式と動き。
// LF だけの改行だと cmd が goto のラベルを読めずに失敗する(a3527a5 で atlas-export.bat に実際に起きた)。
// BOM があると先頭の @echo off がコマンド名として読まれる。.gitattributes の eol=crlf が外れたらここで止める。
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS } from '../packages/cli/src/args.ts';
import { decodeConsole } from './console-text.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_SRC = join(ROOT, 'packages', 'cli', 'src');
const BATS = readdirSync(ROOT).filter((f) => f.endsWith('.bat'));
const ENSURE = 'scripts/ensure-atlas.ps1';
/** atlas を止める bat(更新も依存の用意も atlas の実行もしない。scripts/stop-atlas.ps1 だけを動かす) */
const STOP = 'stop.bat';
const STOP_PS1 = 'scripts/stop-atlas.ps1';
/** node で atlas を動かす bat */
const LAUNCHERS = BATS.filter((f) => f !== STOP);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** 各 bat が最後に node で動かすもの(packages\cli\src の .ts と、main.ts ならそのサブコマンド) */
const FINAL: Record<string, { entry: string; args: string }> = {
  'atlas.bat': { entry: 'main.ts', args: 'serve' },
  'open-folder.bat': { entry: 'main.ts', args: 'open %*' },
  'schedule-upload.bat': { entry: 'upload-schedule.ts', args: '' },
  'setup.bat': { entry: 'setup.ts', args: '' },
  'upload-project.bat': { entry: 'upload-project.ts', args: '' },
};
/** packages\cli\src の .ts を node で動かす行(stop-atlas.ps1 が、このフォルダの atlas と見分けられるよう、%~dp0 から始まる絶対パスで書く) */
const NODE_LINE = /^node "%~dp0packages\\cli\\src\\([\w-]+\.ts)"(?: (.*))?$/;

const codeLines = (f: string): string[] =>
  readFileSync(join(ROOT, f), 'utf8')
    .split(/\r\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^rem\b/i.test(l));

/** 静的な import だけ(動かすときに読む import('…') は含まない) */
const staticImports = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from '([^']+)'/gm)].map((m) => m[1]!);

describe('cmd の出力を読む(scripts/console-text.ts)', () => {
  it('cp932 の行(cmd の文言)と UTF-8 の行(中の node の出力)が混ざっていても、1 行ずつ合うほうで読む', () => {
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
  it('リポジトリ直下にあるのは atlas.bat(集計と画面)・open-folder.bat(選んだフォルダを集計して開く)・schedule-upload.bat(毎日自動で送る登録)・setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)と、止める stop.bat だけ(他の操作は画面とコマンドから)', () => {
    expect([...BATS].sort()).toEqual([...Object.keys(FINAL), STOP].sort());
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

  // 日本語の説明の rem が冒頭(chcp 65001 の前)にあった upload-project.bat と setup.bat は、node や pause から戻ったときに、
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

  // 起動の順: Node.js の確かめ → 開くたびの更新 → 依存の確かめ(足りなければ npm install)→ atlas。前の版の atlas.exe と ensure-atlas.ps1 は使わない
  it.each(LAUNCHERS)('%s は setlocal で始め、Node.js が無ければ入れ方を出して止まる。bin\\atlas.exe・ensure-atlas.ps1 は使わない', (f) => {
    const lines = codeLines(f);
    expect(lines.slice(0, 4)).toEqual(['@echo off', 'setlocal', 'chcp 65001 >nul', 'cd /d "%~dp0"']);
    const node = lines.indexOf('where node >nul 2>nul');
    expect(node).toBeGreaterThan(-1);
    expect(lines.slice(node + 1, node + 6)).toEqual(['if errorlevel 1 (', 'echo Node.js が見つかりません。Node.js 24 以上をインストールしてください。', 'pause', 'exit /b 1', ')']);
    expect(lines.filter((l) => /atlas\.exe|ensure-atlas|self-update|cargo/i.test(l))).toEqual([]);
  });

  // 開くたびに atlas を新しい版にする(launcher-update.ts。git fetch と早送り)。git が .bat を書き換えると、
  // cmd は読んだところまでの位置(バイト数)から続きを読むので、ずれた位置から読んでしまう。コミットが変わったら(終了コード 10)、
  // 同じ 1 行の中で書き換わった後の自分を最初から動かし直して終わる(cmd は 1 行を読み切ってから動かす)。動かし直した側は ATLAS_SELF_UPDATED で
  // 更新を飛ばす(繰り返さない)。終わり方は「& exit /b」ではなく call exit /b %%errorlevel%%(番号の無い exit /b だと、cmd /c で開いたときの
  // 終了コードが 0 になる。実測)。ATLAS_NO_AUTO_UPDATE=1 なら更新しない。ATLAS_SELF_UPDATED が開いた窓に残らないよう、setlocal で始める。
  // 依存の確かめより前に動かす(更新で package-lock.json が変わったら、動かし直した側が入れ直す)
  const UPDATE_LINE =
    'if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED node "%~dp0packages\\cli\\src\\launcher-update.ts" & if errorlevel 10 if not errorlevel 11 set "ATLAS_SELF_UPDATED=1" & cmd /d /c call "%~f0" %* & call exit /b %%errorlevel%%';
  it.each(LAUNCHERS)('%s は Node.js の確かめの直後に launcher-update.ts を 1 行で動かし、コミットが変わったら同じ行の中で自分を動かし直す', (f) => {
    const lines = codeLines(f);
    const node = lines.indexOf('where node >nul 2>nul');
    expect(lines.filter((l) => /launcher-update/.test(l))).toEqual([UPDATE_LINE]);
    expect(lines.indexOf(UPDATE_LINE)).toBe(node + 6);
    expect(lines.indexOf(UPDATE_LINE)).toBeLessThan(lines.indexOf('node scripts\\deps-fresh.mjs'));
  });

  it.each(LAUNCHERS)('%s は依存が package-lock.json とそろっていなければ npm install し、失敗したら止まる', (f) => {
    const lines = codeLines(f);
    const deps = lines.indexOf('node scripts\\deps-fresh.mjs');
    expect(deps).toBeGreaterThan(-1);
    expect(lines.slice(deps + 1, deps + 10)).toEqual([
      'if errorlevel 1 (',
      'echo 依存を入れます: npm install を実行します...',
      'call npm install',
      'if errorlevel 1 (',
      'echo npm install に失敗しました。',
      'pause',
      'exit /b 1',
      ')',
      ')',
    ]);
    // atlas を動かすのは、依存をそろえた後
    expect(lines.findIndex((l) => NODE_LINE.test(l) && !l.includes('launcher-update'))).toBeGreaterThan(deps);
  });

  // 最後に動かす node の終了コードを、bat の終了コードとして返す(「& exit /b」で終えると、cmd の終了コードは常に 0 になる)。
  // 同じ行に %errorlevel% を書くと行を読んだとき(node の前)の値になるので、次の行で調べるか取っておく
  it.each(LAUNCHERS)('%s は最後に packages\\cli\\src の入口を動かし、その終了コードを次の行で調べるか取っておく', (f) => {
    const lines = codeLines(f);
    const last = lines.findLastIndex((l) => NODE_LINE.test(l));
    const m = NODE_LINE.exec(lines[last]!)!;
    expect({ entry: m[1], args: m[2] ?? '' }).toEqual(FINAL[f]);
    expect(lines[last]).not.toContain('&');
    expect(lines[last + 1]).toMatch(/^(if errorlevel 1 \(|set "code=%errorlevel%"|exit \/b %errorlevel%)$/i);
  });

  // main.ts が知らないサブコマンドを渡すと、使い方を出して止まる(setup・upload-project・upload-schedule は main.ts のコマンドではなく、それぞれの .ts が入口)
  it.each(LAUNCHERS)('%s が node で動かす入口はどれもあり、main.ts に渡すのは main.ts のコマンド、ほかの .ts は直接動かしたときに動く入口を持つ', (f) => {
    for (const line of codeLines(f)) {
      const m = NODE_LINE.exec(line.split(' & ')[0]!.replace(/^if not .*? if not defined ATLAS_SELF_UPDATED /, ''));
      if (!m) continue;
      const file = join(CLI_SRC, m[1]!);
      expect(existsSync(file), file).toBe(true);
      if (m[1] === 'main.ts') expect(COMMANDS as readonly string[]).toContain(m[2]!.split(' ')[0]);
      else expect(readFileSync(file, 'utf8')).toMatch(/if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/);
    }
  });

  // git の無い場所(git archive で作ったフォルダなど)では git check-attr が使えないので見ない
  it.skipIf(!existsSync(join(ROOT, '.git'))).each([...BATS, ENSURE, STOP_PS1])('%s は .gitattributes で eol=crlf が効いている', (f) => {
    expect(execFileSync('git', ['check-attr', 'eol', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()).toBe(`${f.replaceAll('\\', '/')}: eol: crlf`);
  });
});

// 起動用の .bat は、依存を確かめる前に launcher-update.ts を動かし、自動で送るタスクは npm install の前でも upload-auto.ts で記録を残す。
// どちらも依存が欠けていても読めるよう、静的に読むのは node: の標準モジュールと、同じく標準モジュールだけを読むファイルだけにする
describe('依存が欠けていても動く入口', () => {
  it('launcher-update.ts が読むのは node: と self-update.ts・upload-auto-files.ts だけ(main.ts を読まない)', () => {
    expect(staticImports(join(CLI_SRC, 'launcher-update.ts')).filter((m) => !m.startsWith('node:'))).toEqual(['./self-update.ts', './upload-auto-files.ts']);
  });
  it('upload-auto.ts は node: と upload-auto-files.ts だけ、self-update.ts と upload-auto-files.ts は node: だけを読む(型だけの import は除く)', () => {
    expect(staticImports(join(CLI_SRC, 'upload-auto.ts')).filter((m) => !m.startsWith('node:'))).toEqual(['./upload-auto-files.ts']);
    const valueImports = (f: string) => [...readFileSync(join(CLI_SRC, f), 'utf8').matchAll(/^import\s(?!type\s)[^;]*?from '([^']+)'/gm)].map((m) => m[1]!);
    expect(valueImports('self-update.ts').filter((m) => !m.startsWith('node:'))).toEqual([]);
    expect(valueImports('upload-auto-files.ts').filter((m) => !m.startsWith('node:'))).toEqual([]);
  });
  it('ATLAS_NO_AUTO_UPDATE=1 なら、launcher-update.ts は何も出さずに 0 で終わる', () => {
    const r = spawnSync(process.execPath, [join(CLI_SRC, 'launcher-update.ts')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ATLAS_NO_AUTO_UPDATE: '1' }, timeout: 60_000 });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});

describe('scripts/ensure-atlas.ps1(前の版の atlas.exe から移るための入口)', () => {
  const buf = readFileSync(join(ROOT, ENSURE));
  const text = buf.subarray(3).toString('utf8');

  // Windows PowerShell 5.1 は BOM の無いファイルを ANSI(日本語の Windows では cp932)で読み、日本語の文言が化ける
  it('BOM 付きの UTF-8 で、改行はすべて CRLF', () => {
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
    expect(text.match(/(^|[^\r])\n/g)).toBeNull();
  });

  it('管理者の権限が要る操作をしない。この版の .bat と atlas は呼ばない。依存は package-lock.json を書き換えない npm ci で入れる', () => {
    expect(text).not.toMatch(/RunAs|Set-ExecutionPolicy|-Scope\s+(LocalMachine|AllUsers)|Program Files/i);
    // 文言で .bat の名前を案内するのはよい。動かすのは node(deps-fresh.mjs)と npm と、タスクの操作だけ
    expect(text).not.toMatch(/main\.ts|launcher-update|^\s*&[^\r\n]*\.bat\b|cmd(\.exe)?\s+\/[cd]/im);
    expect(text).toContain('ci --no-audit --no-fund');
    expect(text).not.toMatch(/npm install/);
  });

  // 偽の Get-ScheduledTask・Set-ScheduledTask・New-ScheduledTaskAction(PowerShell は関数を同じ名前のコマンドより先に使う)で、
  // 一時フォルダに写したスクリプトを動かす(この PC のタスク スケジューラは読みも書きもしない)。依存の確かめ(deps-fresh.mjs)も偽物
  describe.skipIf(process.platform !== 'win32')('Windows で、自動で送るタスクを Node の形に登録し直す', () => {
    let tmp = '';
    let wrapper = '';
    beforeAll(() => {
      // TEMP が 8.3 の短い名前(RUNNER~1 のような形)でも、スクリプトは自分の場所を長い名前で見るので、長い名前にそろえる
      tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'atlas-ensure-')));
      wrapper = join(tmp, 'wrapper.ps1');
      writeFileSync(
        wrapper,
        [
          'param([string]$Script, [string]$TaskArgs, [switch]$Check)',
          '$global:Calls = @()',
          'function Get-ScheduledTask { [CmdletBinding()] param($TaskName, $TaskPath) if (-not $TaskArgs) { return $null }; [pscustomobject]@{ TaskName = $TaskName; Actions = @([pscustomobject]@{ Execute = "conhost.exe"; Arguments = $TaskArgs }) } }',
          'function New-ScheduledTaskAction { [CmdletBinding()] param($Execute, $Argument, $WorkingDirectory) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }',
          'function Set-ScheduledTask { [CmdletBinding()] param($TaskName, $TaskPath, $Action) $global:Calls += [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath; Execute = $Action.Execute; Arguments = $Action.Arguments; WorkingDirectory = $Action.WorkingDirectory } }',
          'if ($Check) { & $Script -Check } else { & $Script }',
          '$code = $LASTEXITCODE',
          "[Console]::Out.WriteLine('@@' + (ConvertTo-Json -Compress -Depth 4 -InputObject @{ code = $code; calls = @($global:Calls) }))",
          '',
        ].join('\r\n'),
      );
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    let n = 0;
    /** 一時フォルダに、スクリプトと偽の deps-fresh.mjs だけのリポジトリを作る */
    const makeRepo = (depsOk: boolean): string => {
      const repo = join(tmp, `repo${n++}`);
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      copyFileSync(join(ROOT, ENSURE), join(repo, ENSURE));
      writeFileSync(join(repo, 'scripts', 'deps-fresh.mjs'), `process.exit(${depsOk ? 0 : 1});\n`);
      return repo;
    };
    const ensure = (repo: string, taskArgs: string, check: boolean) => {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-Script', join(repo, ENSURE)];
      // 空の引数は powershell.exe -File が落とすことがあるので、タスクが無いときは渡さない
      if (taskArgs) args.push('-TaskArgs', taskArgs);
      if (check) args.push('-Check');
      const r = spawnSync('powershell.exe', args, { cwd: repo, timeout: 60_000 });
      const out = decodeConsole(r.stdout);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('@@'));
      expect(line, `${out}${decodeConsole(r.stderr)}`).toBeDefined();
      const j = JSON.parse(line!.slice(2)) as { code: number; calls: Record<string, string>[] | Record<string, string> | null };
      return { code: j.code, calls: j.calls == null ? [] : Array.isArray(j.calls) ? j.calls : [j.calls], text: out };
    };

    it('前の版の形(conhost --headless "<このフォルダ>\\bin\\atlas.exe" upload-auto)なら、-Check は 1。引数なしで、自動更新の設定はそのままで node と upload-auto.ts に差し替える', () => {
      const repo = makeRepo(true);
      for (const [old, tail] of [
        [`--headless "${repo}\\bin\\atlas.exe" upload-auto --no-update`, ' --no-update'],
        [`--headless "${repo}\\bin\\atlas.old-0123abcd.exe" upload-auto`, ''],
      ] as const) {
        expect(ensure(repo, old, true)).toMatchObject({ code: 1, calls: [] });
        const r = ensure(repo, old, false);
        expect(r.code).toBe(0);
        expect(r.calls).toHaveLength(1);
        const call = r.calls[0]!;
        expect(call).toMatchObject({ TaskName: 'agent-session-atlas-upload', TaskPath: '\\', Execute: 'conhost.exe', WorkingDirectory: repo });
        const entry = join(repo, 'packages', 'cli', 'src', 'upload-auto.ts').replaceAll('\\', '\\\\');
        expect(call.Arguments).toMatch(new RegExp(`^--headless "[^"]*node(\\.exe)?" "${entry}"${tail}$`, 'i'));
        expect(r.text).toContain('自動で送るタスクを、Node.js で動かす形に登録し直しました');
      }
    }, 120_000);

    it('もう Node の形のタスク・別のフォルダの atlas.exe のタスク・タスクが無いときは変えない。依存がそろっていれば -Check は 0', () => {
      const repo = makeRepo(true);
      for (const args of [
        `--headless "C:\\node\\node.exe" "${repo}\\packages\\cli\\src\\upload-auto.ts"`,
        `--headless "${join(tmp, 'other')}\\bin\\atlas.exe" upload-auto`,
        '',
      ]) {
        expect(ensure(repo, args, true)).toMatchObject({ code: 0, calls: [] });
        expect(ensure(repo, args, false)).toMatchObject({ code: 0, calls: [] });
      }
    }, 120_000);

    it('依存がそろっていなければ -Check は 1(何も入れない・変えない)', () => {
      const repo = makeRepo(false);
      const r = ensure(repo, `--headless "${repo}\\bin\\atlas.exe" upload-auto`, true);
      expect(r).toMatchObject({ code: 1, calls: [] });
      expect(existsSync(join(repo, 'node_modules'))).toBe(false);
    }, 60_000);
  });
});

// stop.bat は、どこかのタブが開いたままのサーバや、窓の無い別のフォルダのサーバを止める。node や依存が壊れていても止められるよう、
// atlas を動かさず(launcher-update.ts も npm install も通らない)、PowerShell の scripts/stop-atlas.ps1 だけを動かす
describe('stop.bat と scripts/stop-atlas.ps1', () => {
  it('stop.bat は stop-atlas.ps1 に引数を渡して動かし、結果を読めるよう pause してから、その終了コードで終わる。node・更新は動かさない', () => {
    const lines = codeLines(STOP);
    expect(lines.slice(0, 4)).toEqual(['@echo off', 'setlocal', 'chcp 65001 >nul', 'cd /d "%~dp0"']);
    expect(lines.slice(4)).toEqual(['powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\stop-atlas.ps1 %*', 'set "code=%errorlevel%"', 'echo.', 'pause', 'exit /b %code%']);
  });

  const buf = readFileSync(join(ROOT, STOP_PS1));
  const text = buf.subarray(3).toString('utf8');
  it('stop-atlas.ps1 は BOM 付きの UTF-8 で、改行はすべて CRLF。管理者の権限が要る操作をしない', () => {
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
    expect(text.match(/(^|[^\r])\n/g)).toBeNull();
    expect(text).not.toMatch(/RunAs|Set-ExecutionPolicy|-Scope\s+(LocalMachine|AllUsers)|Program Files/i);
    // 止める相手は実行ファイル・スクリプトの場所で決める(印の pid は使い回されるので、止める相手を決めるのに使わない)。taskkill /T は親子を pid だけで辿るので使わない
    expect(text).not.toMatch(/taskkill/i);
  });

  it('stop-atlas.ps1 は、起動用の .bat が動かす入口(main.ts のコマンドと、直接動かす .ts)に名前を付けている', () => {
    for (const f of LAUNCHERS) {
      for (const line of codeLines(f)) {
        const m = NODE_LINE.exec(line.replace(/^if not .*? if not defined ATLAS_SELF_UPDATED /, '').split(' & ')[0]!);
        if (!m) continue;
        const sub = m[1] === 'main.ts' ? m[2]!.split(' ')[0]! : m[1]!.replace(/\.ts$/, '');
        expect(text, `${f}: ${sub}`).toMatch(new RegExp(`'${sub}'\\s+=`));
      }
    }
  });

  // 実際に止める。このフォルダの packages\cli\src の .ts を node で動かしたもの(今の版)と、node の実行ファイルを
  // <フォルダ>\bin\atlas.exe に写して動かしたもの(前の版。node は、サブコマンドと同じ名前のファイル serve・all を、今のフォルダのスクリプトとして動かす)
  describe.skipIf(process.platform !== 'win32')('Windows で実際に止める', () => {
    const SLEEP = 'setTimeout(() => {}, 120000);';
    // serve は子(cmd → ping)を動かし、その pid を書いてから待つ。all は待つだけ
    const SERVE = `const c = require('node:child_process').spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 >nul'], { stdio: 'ignore' }); require('node:fs').writeFileSync('child-' + process.pid, String(c.pid)); ${SLEEP}`;
    const MAIN_TS = `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'serve') {\n  const c = spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 >nul'], { stdio: 'ignore' });\n  writeFileSync('child-' + process.pid, String(c.pid));\n}\n${SLEEP}\n`;
    const started: ChildProcess[] = [];
    let tmp = '';
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'atlas-stop-'));
      writeFileSync(join(tmp, 'serve'), SERVE);
      writeFileSync(join(tmp, 'all'), SLEEP);
    });
    const repos: string[] = [];
    // フォルダごとに powershell.exe を起動するので、既定の 10 秒では足りないことがある(下のテストの上限と同じ理由)
    afterAll(() => {
      // 止めずに残したもの(別のフォルダのサーバとその子)も、子孫ごと止める(子の cmd と ping が一時フォルダを今のフォルダにしている)
      for (const repo of repos) stop(repo, ['-Yes']);
      for (const c of started) c.kill();
      // 止めたプロセスが実行ファイルを掴んだままのことがあるので、少し待ってもう一度試す
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }, 120_000);

    const makeRepo = (name: string): string => {
      const repo = join(tmp, name);
      mkdirSync(join(repo, 'bin'), { recursive: true });
      mkdirSync(join(repo, 'packages', 'cli', 'src'), { recursive: true });
      copyFileSync(process.execPath, join(repo, 'bin', 'atlas.exe'));
      writeFileSync(join(repo, 'packages', 'cli', 'src', 'main.ts'), MAIN_TS);
      repos.push(repo);
      return repo;
    };
    /** 今の版: node "<フォルダ>\packages\cli\src\main.ts" <sub>。legacy なら前の版: <フォルダ>\bin\atlas.exe <sub> */
    const start = (repo: string, sub: string, legacy = false): ChildProcess => {
      const c = legacy
        ? spawn(join(repo, 'bin', 'atlas.exe'), [sub], { cwd: tmp, stdio: 'ignore' })
        : spawn(process.execPath, [join(repo, 'packages', 'cli', 'src', 'main.ts'), sub], { cwd: tmp, stdio: 'ignore' });
      started.push(c);
      return c;
    };
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (ok: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
      if (!ok()) throw new Error(`${what} を待ちきれませんでした`);
    };
    const { ATLAS_OUT: _out, ...env } = process.env;
    const stop = (repo: string, args: string[], input = '') => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, STOP_PS1), '-Repo', repo, ...args], { input, env, timeout: 60_000 });
      return { status: r.status, text: `${decodeConsole(r.stdout)}${decodeConsole(r.stderr)}` };
    };

    // powershell.exe の起動だけで、CI の Windows では既定の 5 秒を超えることがある(下の 2 つと同じ上限にする)
    it('動いていなければ、そう出して 0 で終わる', () => {
      const r = stop(makeRepo('empty'), []);
      expect(r.text).toContain('動いている atlas はありません');
      expect(r.status).toBe(0);
    }, 60_000);

    it('画面のサーバ(node で main.ts serve)だけなら尋ねずに、子孫ごと止める。別のフォルダの atlas は止めない。残った印と前の実行ファイルを消す', async () => {
      const a = makeRepo('a');
      const b = makeRepo('b');
      const serveA = start(a, 'serve');
      const serveB = start(b, 'serve');
      const childFile = join(tmp, `child-${serveA.pid}`);
      await waitFor(() => existsSync(childFile) && existsSync(join(tmp, `child-${serveB.pid}`)), 'サーバの子');
      const child = Number(readFileSync(childFile, 'utf8'));
      expect(alive(child)).toBe(true);
      // 印: 止めるサーバのもの・もう無い pid のもの・別のフォルダで動いている pid のもの(このフォルダの atlas ではないので残さない)
      mkdirSync(join(a, 'out'), { recursive: true });
      mkdirSync(join(a, 'out-folders', 'k', 'out'), { recursive: true });
      writeFileSync(join(a, 'out', '.serve.json'), JSON.stringify({ port: 1, pid: serveA.pid }));
      writeFileSync(join(a, 'out', '.job.json'), JSON.stringify({ pid: serveB.pid }));
      writeFileSync(join(a, 'out-folders', 'k', 'out', '.serve.json'), JSON.stringify({ port: 1, pid: 4_000_000 }));
      writeFileSync(join(a, 'bin', 'atlas.old-0123abcd.exe'), '');

      const r = stop(a, []);
      expect(r.text).toContain('画面のサーバ');
      expect(r.text).toContain('止めました');
      expect(r.text).not.toContain('止めますか');
      expect(r.status).toBe(0);
      await waitFor(() => !alive(serveA.pid!) && !alive(child), 'サーバと子が止まる');
      expect(alive(serveB.pid!)).toBe(true);
      expect(existsSync(join(a, 'out', '.serve.json'))).toBe(false);
      expect(existsSync(join(a, 'out', '.job.json'))).toBe(false);
      expect(existsSync(join(a, 'out-folders', 'k', 'out', '.serve.json'))).toBe(false);
      // 前の版の実行ファイル(bin\atlas*.exe)は、この版は使わないので消す
      expect(existsSync(join(a, 'bin', 'atlas.old-0123abcd.exe'))).toBe(false);
      expect(existsSync(join(a, 'bin', 'atlas.exe'))).toBe(false);
    }, 60_000);

    it('前の版の bin\\atlas.exe の集計も止める。動いていれば尋ね、y でなければ止めない。y なら止める。-Yes なら尋ねない', async () => {
      const c = makeRepo('c');
      const all = start(c, 'all', true);
      await waitFor(() => all.pid !== undefined && alive(all.pid), '集計の起動');
      const no = stop(c, [], 'n\r\n');
      expect(no.text).toContain('集計');
      expect(no.text).toContain('止めませんでした');
      expect(no.status).toBe(0);
      expect(alive(all.pid!)).toBe(true);
      const yes = stop(c, [], 'y\r\n');
      expect(yes.text).toContain('止めました');
      await waitFor(() => !alive(all.pid!), '集計が止まる');

      // 今の版の集計(node で main.ts all)も同じ
      const again = start(c, 'all');
      await waitFor(() => again.pid !== undefined && alive(again.pid), '集計の起動');
      const forced = stop(c, ['-Yes']);
      expect(forced.text).toContain('集計');
      expect(forced.text).not.toContain('止めますか');
      expect(forced.text).toContain('止めました');
      await waitFor(() => !alive(again.pid!), '集計が止まる');
    }, 60_000);
  });
});
