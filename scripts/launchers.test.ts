// 利用者がダブルクリックで起動する *.bat と、その最初に動く scripts/ensure-atlas.ps1、TS 版で登録したタスクのための互換の入口の形式。
// LF だけの改行だと cmd が goto のラベルを読めずに失敗する(a3527a5 で atlas-export.bat に実際に起きた)。
// BOM があると先頭の @echo off がコマンド名として読まれる。.gitattributes の eol=crlf が外れたらここで止める。
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeConsole } from './console-text.ts';

const ROOT = resolve(import.meta.dirname, '..');
const BATS = readdirSync(ROOT).filter((f) => f.endsWith('.bat'));
const ENSURE = 'scripts/ensure-atlas.ps1';
/** atlas を止める bat(実行ファイルの用意・更新も atlas の実行もしない。scripts/stop-atlas.ps1 だけを動かす) */
const STOP = 'stop.bat';
const STOP_PS1 = 'scripts/stop-atlas.ps1';
/** 実行ファイルを用意して atlas を動かす bat */
const LAUNCHERS = BATS.filter((f) => f !== STOP);
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
  it.each(LAUNCHERS)('%s は最初に scripts\\ensure-atlas.ps1 を動かし、失敗したら止まる。node と npm は呼ばない', (f) => {
    const lines = codeLines(f);
    const i = lines.findIndex((l) => /ensure-atlas\.ps1/i.test(l));
    expect(lines[i]).toBe('powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\ensure-atlas.ps1 -KeepOlder');
    expect(lines.slice(i + 1, i + 5)).toEqual(['if errorlevel 1 (', 'echo.', 'pause', 'exit /b 1']);
    expect(lines.findIndex((l) => /^bin\\atlas\.exe\b/i.test(l))).toBeGreaterThan(i);
    expect(lines.filter((l) => /^(where )?node\b|\bnpm\b|deps-fresh|packages\\cli/i.test(l))).toEqual([]);
  });

  // 開くたびに atlas を新しい版にする(atlas self-update。git fetch と早送り。crates/atlas-cli/src/self_update.rs)。git が .bat を書き換えると、
  // cmd は読んだところまでの位置(バイト数)から続きを読むので、ずれた位置から読んでしまう。コミットが変わったら(終了コード 10)、
  // 同じ 1 行の中で書き換わった後の自分を最初から動かし直して終わる(cmd は 1 行を読み切ってから動かす)。動かし直した側は ATLAS_SELF_UPDATED で
  // 更新を飛ばす(繰り返さない)。終わり方は「& exit /b」ではなく call exit /b %%errorlevel%%(番号の無い exit /b だと、cmd /c で開いたときの
  // 終了コードが 0 になる。実測)。atlas の出力のエラーは捨てる(self-update を知らない前の版の atlas.exe が、使い方を出さないように)。
  // ATLAS_NO_AUTO_UPDATE=1 なら更新しない。ATLAS_SELF_UPDATED が開いた窓に残らないよう、setlocal で始める
  const UPDATE_LINE =
    'if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED bin\\atlas.exe self-update 2>nul & if errorlevel 10 if not errorlevel 11 set "ATLAS_SELF_UPDATED=1" & cmd /d /c call "%~f0" %* & call exit /b %%errorlevel%%';
  it.each(LAUNCHERS)('%s は setlocal で始め、ensure-atlas.ps1 の後に atlas self-update を 1 行で動かし、コミットが変わったら同じ行の中で自分を動かし直す', (f) => {
    const lines = codeLines(f);
    expect(lines.slice(0, 2)).toEqual(['@echo off', 'setlocal']);
    const ensure = lines.findIndex((l) => /ensure-atlas\.ps1/i.test(l));
    expect(lines.filter((l) => /self-update/.test(l))).toEqual([UPDATE_LINE]);
    // ensure-atlas の失敗の囲みの直後(実行ファイルがある状態で動かす)で、atlas の本来のサブコマンドより前
    expect(lines.indexOf(UPDATE_LINE)).toBe(ensure + 6);
    expect(lines.indexOf(UPDATE_LINE)).toBeLessThan(lines.findIndex((l) => /^bin\\atlas\.exe\b/i.test(l)));
  });

  // 最後に動かす atlas の終了コードを、bat の終了コードとして返す(「& exit /b」で終えると、cmd の終了コードは常に 0 になる)。
  // 同じ行に %errorlevel% を書くと行を読んだとき(atlas の前)の値になるので、次の行で調べるか取っておく
  it.each(LAUNCHERS)('%s は最後に bin\\atlas.exe <サブコマンド> を動かし、その終了コードを次の行で調べるか取っておく', (f) => {
    const lines = codeLines(f);
    const last = lines.findLastIndex((l) => /^bin\\atlas\.exe\b/i.test(l));
    expect(lines[last]).toMatch(FINAL[f]);
    expect(lines[last]).not.toContain('&');
    expect(lines[last + 1]).toMatch(/^(if errorlevel 1 \(|set "code=%errorlevel%"|exit \/b %errorlevel%)$/i);
  });

  // git の無い場所(git archive で作ったフォルダなど)では git check-attr が使えないので見ない
  it.skipIf(!existsSync(join(ROOT, '.git'))).each([...BATS, ENSURE, STOP_PS1])('%s は .gitattributes で eol=crlf が効いている', (f) => {
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

  // sha256 はリリースと同じ場所から取るので、リリースを差し替えられると一緒に差し替わる。来歴(attestation)は GitHub の署名で、
  // このリポジトリのリリースのワークフローが作ったものかを確かめる。gh が無いときは sha256 だけで続け、そのことを出す
  it('gh があってログインしていれば、取ってきたものを動かす前にビルドの来歴を gh attestation verify で確かめ、合わなければ使わない', () => {
    expect(text).toContain('gh attestation verify $file --repo $slug --signer-workflow "$slug/.github/workflows/release.yml"');
    expect(text).toContain('& gh auth status');
    expect(text.indexOf('Test-Attestation $file $slug')).toBeGreaterThan(text.indexOf('Get-FileHash -Algorithm SHA256'));
    expect(text.indexOf('Test-Attestation $file $slug')).toBeLessThan(text.indexOf('Get-ExeInfo $file'));
    expect(text).toContain("if ($script:Attestation -eq 'fail') { return $null }");
    expect(text).toContain('gh(GitHub CLI)が無いので、ビルドの来歴(attestation)は確かめず、sha256 だけで確かめました');
  });

  // Windows の Rust(MSVC 向け)はリンカーと、同梱の SQLite のコンパイルに Visual Studio の C++ のビルドツールを使う。
  // 無いまま cargo build に進むと、分かりにくいリンクのエラーで止まるので、先に足りないものとして案内する
  it('Windows でビルドする前に、Visual Studio の C++ のビルドツールを vswhere(無ければ PATH の cl.exe と link.exe)で確かめ、無ければ入れるよう案内する', () => {
    expect(text).toContain("'Microsoft Visual Studio\\Installer\\vswhere.exe'");
    expect(text).toContain('-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
    expect(text).toContain("(Test-Tool 'cl.exe') -and (Test-Tool 'link.exe')");
    expect(text).toContain("if (-not (Test-MsvcTools)) { $missing += 'Visual Studio の C++ のビルドツール(MSVC)' }");
    expect(text).toContain('https://visualstudio.microsoft.com/visual-cpp-build-tools/');
  });

  // リリースのワークフローは、配る中身が変わったマージごとにパッチ版のタグを付ける(Cargo.toml の version は上げない)。
  // 取ってくる版は、HEAD から辿れるいちばん新しいタグ(semver で比べる。git の --sort=-v:refname はプレリリースを後ろに並べるので使わない)
  it('取ってくる版は HEAD から辿れるいちばん新しいタグ v<x.y.z> で決め、タグが無ければ Cargo.toml の version にする', () => {
    expect(text).toContain("& git -C $Repo tag --list 'v*' --merged HEAD");
    expect(text).not.toMatch(/& git [^\r\n]*--sort=/);
    expect(text).toContain('function Compare-SemVer');
    expect(text).toMatch(/function Get-WantVersion \{\r\n {2}\$tag = Get-TagVersion\r\n {2}if \(\$tag\) \{ return \$tag \}\r\n {2}return Get-CargoVersion\r\n\}/);
  });

  // タグを取らずに取得したフォルダ(git clone --no-tags)は、上げなくなった Cargo.toml の version に固定されないよう、一度タグを取ってくる。
  // 待つのは 20 秒まで。-Check は何も変えないので取りに行かない
  it('HEAD から辿れるタグが無ければ、-Check でないときだけ、時間を区切って origin からタグを取ってくる', () => {
    expect(text).toContain("if (-not $best -and -not $Check -and (Invoke-TagFetch)) { $best = Find-NewestTag }");
    expect(text).toMatch(/Start-Process -FilePath 'git' -ArgumentList @\('fetch', '--quiet', '--tags', 'origin'\)/);
    expect(text).toContain('$p.WaitForExit(20000)');
    expect(text).toContain("$env:GIT_TERMINAL_PROMPT = '0'");
  });

  // 取り下げた版の番号で別のコミットからリリースを作り直したら、前のものを使い続けない
  it('リリースの実行ファイルは、版に加えて、作ったコミットがタグのコミットと同じかも見る(置いてあるものと、取ってきたもの)', () => {
    expect(text).toContain('& git -C $Repo rev-list -n 1 "refs/tags/v$best"');
    expect(text.match(/\$script:WantCommit -and \$info\.Commit -and \$info\.Commit -ne \$script:WantCommit/g)).toHaveLength(2);
  });

  it('管理者の権限が要る操作をしない', () => {
    expect(text).not.toMatch(/RunAs|Set-ExecutionPolicy|-Scope\s+(LocalMachine|AllUsers)|Program Files/i);
  });
});

// stop.bat は、どこかのタブが開いたままのサーバや、窓の無い別のフォルダのサーバを止める。実行ファイルが壊れていても・前の版でも止められるよう、
// atlas.exe を動かさず(ensure-atlas.ps1 と self-update も通らない)、PowerShell の scripts/stop-atlas.ps1 だけを動かす
describe('stop.bat と scripts/stop-atlas.ps1', () => {
  it('stop.bat は stop-atlas.ps1 に引数を渡して動かし、結果を読めるよう pause してから、その終了コードで終わる。atlas.exe・ensure-atlas.ps1・self-update は動かさない', () => {
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
    // 止める相手は実行ファイルの場所で決める(印の pid は使い回されるので、止める相手を決めるのに使わない)。taskkill /T は親子を pid だけで辿るので使わない
    expect(text).not.toMatch(/taskkill/i);
  });

  // 実際に止める。atlas.exe の代わりに、node の実行ファイルを <フォルダ>\bin\atlas.exe に写して動かす
  // (node は、サブコマンドと同じ名前のファイル serve・all を、今のフォルダのスクリプトとして動かす)
  describe.skipIf(process.platform !== 'win32')('Windows で実際に止める', () => {
    const SLEEP = 'setTimeout(() => {}, 120000);';
    // serve は子(cmd → ping)を動かし、その pid を書いてから待つ。all は待つだけ
    const SCRIPTS = {
      serve: `const c = require('node:child_process').spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 >nul'], { stdio: 'ignore' }); require('node:fs').writeFileSync('child-' + process.pid, String(c.pid)); ${SLEEP}`,
      all: SLEEP,
    };
    const started: ChildProcess[] = [];
    let tmp = '';
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'atlas-stop-'));
      for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(join(tmp, name), body);
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
      copyFileSync(process.execPath, join(repo, 'bin', 'atlas.exe'));
      repos.push(repo);
      return repo;
    };
    const start = (repo: string, sub: string): ChildProcess => {
      const c = spawn(join(repo, 'bin', 'atlas.exe'), [sub], { cwd: tmp, stdio: 'ignore' });
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

    it('画面のサーバだけなら尋ねずに、子孫ごと止める。別のフォルダの atlas は止めない。残った印と前の実行ファイルを消す', async () => {
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
      expect(existsSync(join(a, 'bin', 'atlas.old-0123abcd.exe'))).toBe(false);
    }, 60_000);

    it('集計などが動いていれば尋ね、y でなければ止めない。y なら止める。-Yes なら尋ねない', async () => {
      const c = makeRepo('c');
      const all = start(c, 'all');
      await waitFor(() => all.pid !== undefined && alive(all.pid), '集計の起動');
      const no = stop(c, [], 'n\r\n');
      expect(no.text).toContain('集計');
      expect(no.text).toContain('止めませんでした');
      expect(no.status).toBe(0);
      expect(alive(all.pid!)).toBe(true);
      const yes = stop(c, [], 'y\r\n');
      expect(yes.text).toContain('止めました');
      await waitFor(() => !alive(all.pid!), '集計が止まる');

      const again = start(c, 'all');
      await waitFor(() => again.pid !== undefined && alive(again.pid), '集計の起動');
      const forced = stop(c, ['-Yes']);
      expect(forced.text).not.toContain('止めますか');
      expect(forced.text).toContain('止めました');
      await waitFor(() => !alive(again.pid!), '集計が止まる');
    }, 60_000);
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

// 配る atlas.exe に入るものの一覧は 1 つのファイルにだけ書く。リリースのワークフロー(リリースを作るか)と自動の更新(リリースを待つか)が
// 同じ一覧で決めないと、リリースの出ないコミットを待ち続けたり、リリースより先に進んだりする
describe('配る中身の一覧(scripts/release-shipped.txt)', () => {
  const LIST = 'scripts/release-shipped.txt';
  const specs = readFileSync(join(ROOT, LIST), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  it('リリースのワークフローと自動の更新が、同じファイルを読む(ワークフローに一覧を書かない)', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain(`< ${LIST} |`);
    expect(workflow).not.toMatch(/shipped=\(/);
    const rust = readFileSync(join(ROOT, 'crates/atlas-cli/src/self_update.rs'), 'utf8');
    expect(rust).toContain(`pub const SHIPPED_LIST: &str = "${LIST}";`);
  });
  it('リリースは、依存の脆弱性の検査を通ってからビルドする(devDependencies も含めて見る)', () => {
    // Windows のランナーは core.autocrlf=true で取り出すので、改行をそろえてからジョブを切り出す
    const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
    const job = (name: string) => {
      const m = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|$)`));
      expect(m, `ジョブ ${name}`).not.toBeNull();
      return m![1];
    };
    expect(job('windows')).toMatch(/needs: \[plan, audit\]/);
    const audit = job('audit');
    expect(audit).toContain('ref: ${{ needs.plan.outputs.ref }}');
    expect(audit).toContain('cargo deny --locked check');
    expect(audit).toMatch(/^ +node scripts\/npm-audit\.mjs$/m);
    expect(audit).not.toContain('--omit=dev');
    // PR の CI と毎週の検査も同じ基準で見る(PR が通ったのにリリースだけが止まる、を起こさない)
    for (const f of ['ci.yml', 'deny-schedule.yml']) {
      const text = readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
      expect(text, f).toMatch(/run: node scripts\/npm-audit\.mjs$/m);
      expect(text, f).not.toMatch(/run: npm audit|--omit=dev/);
    }
    // cargo-deny の版は 3 つのワークフローでそろえる
    const version = (f: string) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8').match(/CARGO_DENY_VERSION: (\S+)/)?.[1];
    expect(version('release.yml')).toBeDefined();
    expect(version('release.yml')).toBe(version('ci.yml'));
    expect(version('release.yml')).toBe(version('deny-schedule.yml'));
  });
  it('実行ファイルを作る入力を入れ、テストは除く', () => {
    expect(specs).toEqual(expect.arrayContaining(['crates', 'Cargo.toml', 'Cargo.lock', 'packages/report', 'package-lock.json', ':(exclude)crates/*/tests/*']));
    // 一覧そのものと、説明書・スクリプトは入れない(変えてもリリースを作らない)
    expect(specs.filter((s) => /^(scripts|docs|README)/.test(s))).toEqual([]);
  });
});
