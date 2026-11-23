// 利用者がダブルクリックで起動する *.bat と、その最初に動く scripts/ensure-atlas.ps1、TS 版で登録したタスクのための互換の入口の形式。
// LF だけの改行だと cmd が goto のラベルを読めずに失敗する(a3527a5 で atlas-export.bat に実際に起きた)。
// BOM があると先頭の @echo off がコマンド名として読まれる。.gitattributes の eol=crlf が外れたらここで止める。
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // 実行ファイルを用意してから動かす。Node.js の確かめとビルド(npm ci など)は ensure-atlas.ps1 がするので、.bat では node と npm を呼ばない
  it.each(LAUNCHERS)('%s は最初に(atlas.bat は前に開いた画面のサーバを止めてから)scripts\\ensure-atlas.ps1 を動かし、失敗したら止まる。node と npm は呼ばない', (f) => {
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

  // atlas.exe は配っていない(GitHub のリリースで配るのは 2026-11-23 にやめた)。どこからも取ってこず、いつもこの PC でビルドする
  it('実行ファイルを取ってこない(リリース・ダウンロード・ハッシュや来歴の確かめが無い)。ビルドしたものだけを置く', () => {
    expect(text).not.toMatch(/Invoke-WebRequest|gh release|gh attestation|releases\/download|Get-FileHash|ATLAS_RELEASE_REPO|remote get-url/);
    // 前のリリースのタグで版を決めない(版は Cargo.toml の version と、作ったときのコミット)
    expect(text).not.toMatch(/git -C \$Repo tag\b|refs\/tags|Compare-SemVer/);
    // ATLAS_BUILD_LOCAL はもう読まない(付けたままでも害は無い。説明にだけ残す)
    expect(text.split(/\r\n/).filter((l) => !l.startsWith('#') && l.includes('ATLAS_BUILD_LOCAL'))).toEqual([]);
    expect(text).toContain("Install-Exe $got ('local ' + $head)");
    // PowerShell の変数は大文字小文字を区別しない: 置き場所の $Exe を、作ったファイルの $exe で上書きしない(上書きして、置く前に消していた)
    expect(text.match(/\$exe\b/g) ?? []).toEqual([]);
  });

  // 使えるのは、今のコミット(HEAD)から作った実行ファイルだけ。git で取得したフォルダでなければ、版で比べる
  it('bin\\atlas.exe は、atlas --version のコミットが HEAD と同じときだけ使い、違えばビルドし直す', () => {
    expect(text).toMatch(/if \(\$head\) \{\r\n(?: {4}#.*\r\n)? {4}if \(\$info\.Commit -ne \$head\) \{ return /);
    // -dirty も読む(読めないと、動く実行ファイルを「無い」と扱う)
    expect(text).toContain('commit ([0-9a-f]{40,64}(?:-dirty)?), ');
    expect(text).toContain("$want = Get-CargoVersion");
    expect(text).toContain('param([switch]$Check, [switch]$CheckTools, [switch]$KeepOlder)');
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

  // -CheckTools は自動の更新(crates/atlas-cli/src/self_update.rs)が、新しい版を取り込む前に読む(終了コード 1 と、足りないものの 1 行)
  it('-CheckTools は何も変えずに、ビルドに要るものがそろっているかを終了コードで返し、足りなければその並びを 1 行で出す', () => {
    expect(text).toMatch(/if \(\$CheckTools\) \{\r\n {4}\$missing = Get-MissingTools\r\n {4}if \(\$missing\.Count -eq 0\) \{ exit 0 \}\r\n {4}Say \(\$missing -join '、'\)\r\n {4}exit 1\r\n {2}\}/);
    const rust = readFileSync(join(ROOT, 'crates/atlas-cli/src/self_update.rs'), 'utf8');
    expect(rust).toContain('Ensure::Tools => args.push("-CheckTools")');
  });

  // 本当に ensure-atlas.ps1 を動かす。atlas.exe の代わりに、隣の fake-version.txt の中身を --version の答えとして出すだけの
  // 小さな実行ファイルを、Windows PowerShell の Add-Type(C# のコンパイラ)で作って bin\atlas.exe に置く(出すコミットを決められる)。
  // 一時フォルダに ensure-atlas.ps1・Cargo.toml・package.json だけを置き、git で取得したフォルダ(コミットで比べる)と、そうでないフォルダ(版で比べる)を作る。
  // Windows だけ(Add-Type で実行ファイルを作るのと、ensure-atlas.ps1 を Windows PowerShell 5.1 で動かすため。ほかの OS では飛ばす)
  describe.skipIf(process.platform !== 'win32')('実際に動かす(Windows PowerShell 5.1。atlas.exe の代わりの実行ファイルで)', () => {
    const sys = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const fullEnv: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: undefined };
    // ビルドに要るものが無い PC: PATH を Windows のフォルダと git だけにする(git は HEAD を読むのに要る)
    const bare: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
    // 飛ばすときも、vitest は describe の中身を読むので、Windows でなければ探さない
    const gitDir = process.platform === 'win32' ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].replace(/\\[^\\]+$/, '') : '';
    bare.PATH = `${join(sys, 'System32')};${sys};${join(sys, 'System32', 'WindowsPowerShell', 'v1.0')};${gitDir}`;
    let tmp = '';
    let fake = '';
    let n = 0;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'atlas-ensure-'));
      fake = join(tmp, 'fake-atlas.exe');
      const cs = join(tmp, 'fake-atlas.cs');
      writeFileSync(
        cs,
        'public static class P { public static int Main(string[] a) { var d = System.AppDomain.CurrentDomain.BaseDirectory; ' +
          'System.Console.Write(System.IO.File.ReadAllText(System.IO.Path.Combine(d, "fake-version.txt"))); return 0; } }\n',
      );
      const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path '${cs}' -OutputType ConsoleApplication -OutputAssembly '${fake}'`], { encoding: 'utf8' });
      expect(existsSync(fake), `代わりの実行ファイルを作れません: ${r.stdout}${r.stderr}`).toBe(true);
    }, 120_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

    /** 一時フォルダ(git なら 1 つコミットする)。bin\atlas.exe に代わりの実行ファイルを置き、出すコミットを書く(null なら置かない) */
    const makeRepo = (git: boolean): { dir: string; head: string; place: (line: string | null) => void } => {
      const dir = join(tmp, `repo-${n++}`);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      copyFileSync(join(ROOT, ENSURE), join(dir, ENSURE));
      writeFileSync(join(dir, 'Cargo.toml'), '[workspace.package]\nversion = "9.9.9"\n');
      // npm を動かすときに、上のフォルダの package.json を探しに行かないよう、ここに置く(依存の一覧は無いので npm ci はすぐに失敗する)
      writeFileSync(join(dir, 'package.json'), '{ "name": "atlas-ensure-test", "private": true, "engines": { "node": ">=24" } }\n');
      let head = '';
      if (git) {
        const g = (...args: string[]) =>
          execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
        g('init', '-q', '-b', 'main');
        writeFileSync(join(dir, '.gitignore'), '/bin/\n');
        g('add', '-A');
        g('commit', '-q', '-m', 'first');
        head = g('rev-parse', 'HEAD');
      }
      const place = (line: string | null) => {
        mkdirSync(join(dir, 'bin'), { recursive: true });
        if (line === null) return;
        copyFileSync(fake, join(dir, 'bin', 'atlas.exe'));
        writeFileSync(join(dir, 'bin', 'fake-version.txt'), `${line}\n`);
      };
      return { dir, head, place };
    };
    const ensure = (dir: string, args: string[], env: NodeJS.ProcessEnv = fullEnv) => {
      const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, ENSURE), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
      return { status: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const line = (commit: string) => `atlas 9.9.9 (commit ${commit}, code 0123456789abcdef)`;
    const exeText = (dir: string) => readFileSync(join(dir, 'bin', 'fake-version.txt'), 'utf8');

    it('git のフォルダで、atlas --version のコミットが HEAD と同じなら、何もしない(-Check も 0)', () => {
      const r = makeRepo(true);
      r.place(line(r.head));
      expect(ensure(r.dir, ['-Check']).status).toBe(0);
      const plain = ensure(r.dir, []);
      expect([plain.status, plain.text.trim()]).toEqual([0, '']);
    }, 120_000);

    it('コミットが違う・-dirty が付いている・実行ファイルが無いときは、そのまま使わない(-Check が 1)', () => {
      const r = makeRepo(true);
      r.place(line('0'.repeat(40)));
      expect(ensure(r.dir, ['-Check']).status).toBe(1);
      // git が管理しているファイルを変えたまま作ったもの(開発の手元)は、HEAD と同じとはみなさない
      r.place(line(`${r.head}-dirty`));
      expect(ensure(r.dir, ['-Check']).status).toBe(1);
      const empty = makeRepo(true);
      empty.place(null);
      expect(ensure(empty.dir, ['-Check']).status).toBe(1);
    }, 120_000);

    it('ビルドに要るものが無ければ、足りないものを出して 1 で終わる。-KeepOlder なら、前のソースから作った実行ファイルをそのまま残して 0 で続ける', () => {
      const r = makeRepo(true);
      const tools = ensure(r.dir, ['-CheckTools'], bare);
      expect(tools.status).toBe(1);
      expect(tools.text).toContain('Node.js、npm、Rust(cargo)');
      // 前のものが無ければ、-KeepOlder でも止まる
      r.place(null);
      const none = ensure(r.dir, ['-KeepOlder'], bare);
      expect(none.status).toBe(1);
      expect(none.text).toContain('atlas をビルドするのに要るものが足りません(足りないもの: Node.js、npm、Rust(cargo)');
      expect(none.text).toContain('https://rustup.rs/');
      expect(none.text).not.toContain('リリース');
      expect(existsSync(join(r.dir, 'bin', 'atlas.exe'))).toBe(false);
      // 前のコミットから作ったもの
      const old = line('1'.repeat(40));
      r.place(old);
      expect(ensure(r.dir, [], bare).status).toBe(1);
      const kept = ensure(r.dir, ['-KeepOlder'], bare);
      expect(kept.status).toBe(0);
      expect(kept.text).toContain('今回は、前のソースから作った bin\\atlas.exe(版 9.9.9、コミット 1111111)のまま続けます。今のソースの変更は入っていません。');
      expect(exeText(r.dir)).toBe(`${old}\n`);
    }, 120_000);

    it('git で取得したフォルダでなければ、版が Cargo.toml と同じなら、そのまま使う(ビルドに要るものが無くても、何も出さない)', () => {
      const r = makeRepo(false);
      r.place('atlas 9.9.9 (code 0123456789abcdef)');
      expect(ensure(r.dir, ['-Check'], bare).status).toBe(0);
      const same = ensure(r.dir, [], bare);
      expect([same.status, same.text.trim()]).toEqual([0, '']);
      r.place('atlas 9.9.8 (code 0123456789abcdef)');
      expect(ensure(r.dir, ['-Check'], bare).status).toBe(1);
    }, 120_000);

    // ビルドに要るものがそろっている PC(この PC・CI の Windows)では、コミットが違えばビルドしに行く。一時フォルダには依存の一覧が無いので
    // npm ci で失敗し、そのコミットを bin\build-failed.txt に残す(自動の更新が同じコミットを何度も試さないように)。
    // そろっていない PC では確かめられないので飛ばす。CI(環境変数 CI)ではそろっているはずなので、飛ばさずに落とす
    const toolsReady = process.platform === 'win32' && spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, ENSURE), '-CheckTools'], { encoding: 'utf8' }).status === 0;
    it.skipIf(!toolsReady && !process.env.CI)('ビルドに要るものがあれば、コミットが違うときにビルドしに行く。できなければ失敗したコミットを残し、-KeepOlder なら前のもので続ける', () => {
      expect(toolsReady, 'CI の Windows に、ビルドに要るものがそろっていません').toBe(true);
      const r = makeRepo(true);
      const old = line('2'.repeat(40));
      r.place(old);
      const built = ensure(r.dir, []);
      expect(built.status).toBe(1);
      expect(built.text).toContain('この PC でビルドします');
      expect(built.text).toContain('atlas をビルドできませんでした');
      expect(readFileSync(join(r.dir, 'bin', 'build-failed.txt'), 'utf8').trim()).toBe(r.head);
      const kept = ensure(r.dir, ['-KeepOlder']);
      expect(kept.status).toBe(0);
      expect(kept.text).toContain('今回は、前のソースから作った bin\\atlas.exe');
      expect(exeText(r.dir)).toBe(`${old}\n`);
    }, 300_000);

    // 自動で送るタスクがビルドしている間に .bat を開いたとき: 同じフォルダで 2 つ同時にビルドしない(bin\build.lock を開いたままにして印にする)。
    // ここでは印をテストが開いたままにして、ほかがビルドしている状態を作る
    it('ほかがビルドしている間は、-KeepOlder で前のものが動けば、少し待ってからそれで続ける(ビルドしない)', () => {
      const r = makeRepo(true);
      const old = line('3'.repeat(40));
      r.place(old);
      const fd = openSync(join(r.dir, 'bin', 'build.lock'), 'w');
      try {
        const t = performance.now();
        const busy = ensure(r.dir, ['-KeepOlder']);
        if (toolsReady) {
          expect(busy.text).toContain('ほかの atlas が、このフォルダで atlas.exe をビルドしています');
          expect(performance.now() - t).toBeGreaterThan(4_000);
        }
        expect(busy.status).toBe(0);
        expect(busy.text).not.toContain('この PC でビルドします');
        expect(busy.text).toContain('今回は、前のソースから作った bin\\atlas.exe');
        expect(exeText(r.dir)).toBe(`${old}\n`);
      } finally {
        closeSync(fd);
      }
    }, 120_000);
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

  // atlas.bat は開くたびに最初に、前に開いた画面のサーバだけを止める(残ったサーバがあると self-update が更新を飛ばし、serve が前のサーバを開き直すだけになる)。
  // ATLAS_NO_AUTO_UPDATE=1 なら止めない(更新もしない)。読み直した後(ATLAS_SELF_UPDATED)は、もう止めたので動かさない。
  // 結果は調べない(止められなくても・確かめられなくても続け、self-update が更新しない理由を出す)
  const VIEWERS_LINE = 'if not "%ATLAS_NO_AUTO_UPDATE%"=="1" if not defined ATLAS_SELF_UPDATED powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\stop-atlas.ps1 -ViewersOnly';
  it('atlas.bat は cd の直後(ensure-atlas.ps1 の前)に stop-atlas.ps1 -ViewersOnly を 1 行で動かし、結果を調べない。ほかの起動用の bat は動かさない', () => {
    const lines = codeLines('atlas.bat');
    expect(lines.slice(0, 6)).toEqual(['@echo off', 'setlocal', 'chcp 65001 >nul', 'cd /d "%~dp0"', VIEWERS_LINE, 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\ensure-atlas.ps1 -KeepOlder']);
    expect(lines.filter((l) => /stop-atlas/i.test(l))).toEqual([VIEWERS_LINE]);
    for (const f of LAUNCHERS.filter((f) => f !== 'atlas.bat')) expect(codeLines(f).filter((l) => /stop-atlas/i.test(l)), f).toEqual([]);
  });

  const buf = readFileSync(join(ROOT, STOP_PS1));
  const text = buf.subarray(3).toString('utf8');
  it('stop-atlas.ps1 は -Yes・-ViewersOnly・-Repo を受け取る', () => {
    expect(text).toContain("param([switch]$Yes, [switch]$ViewersOnly, [string]$Repo = '')");
  });
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
    // -ViewersOnly 用: quiet は子を持たない serve・open・all。spawn-all・spawn-open の serve は、自分と同じ実行ファイル(このフォルダの atlas)で
    // all・open(quiet のもの)を子として動かし、その pid を kid-<serve の pid> に書いてから待つ
    let quiet = '';
    let spawnAll = '';
    let spawnOpen = '';
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'atlas-stop-'));
      for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(join(tmp, name), body);
      quiet = join(tmp, 'quiet');
      spawnAll = join(tmp, 'spawn-all');
      spawnOpen = join(tmp, 'spawn-open');
      for (const d of [quiet, spawnAll, spawnOpen]) mkdirSync(d);
      for (const name of ['serve', 'open', 'all']) writeFileSync(join(quiet, name), SLEEP);
      const spawnAtlas = (sub: string) =>
        `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(sub)}], { cwd: ${JSON.stringify(quiet)}, stdio: 'ignore' }); ` +
        `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(tmp)}, 'kid-' + process.pid), String(c.pid)); ${SLEEP}`;
      writeFileSync(join(spawnAll, 'serve'), spawnAtlas('all'));
      writeFileSync(join(spawnOpen, 'serve'), spawnAtlas('open'));
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
    const start = (repo: string, sub: string, cwd = tmp): ChildProcess => {
      const c = spawn(join(repo, 'bin', 'atlas.exe'), [sub], { cwd, stdio: 'ignore' });
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

    // ここから -ViewersOnly(atlas.bat が開くたびに最初に呼ぶ)。入力は渡さない(尋ねれば Read-Host が入力の終わりを読む)
    const kidOf = async (c: ChildProcess): Promise<number> => {
      const f = join(tmp, `kid-${c.pid}`);
      await waitFor(() => existsSync(f), 'サーバの子');
      const kid = Number(readFileSync(f, 'utf8'));
      await waitFor(() => alive(kid), 'サーバの子の起動');
      return kid;
    };

    it('-ViewersOnly: 動いていなければ何も出さずに 0 で終わり、残った印は消す。続けて呼んでも同じ', () => {
      const repo = makeRepo('viewers-empty');
      mkdirSync(join(repo, 'out'), { recursive: true });
      writeFileSync(join(repo, 'out', '.serve.json'), JSON.stringify({ port: 1, pid: 4_000_000 }));
      for (let i = 0; i < 2; i++) {
        const r = stop(repo, ['-ViewersOnly']);
        expect([r.status, r.text.trim()]).toEqual([0, '']);
      }
      expect(existsSync(join(repo, 'out', '.serve.json'))).toBe(false);
    }, 60_000);

    it('-ViewersOnly: 画面のサーバだけ(サーバと、その画面から開いた別のフォルダの open)なら、尋ねずに止めて 1 行出す。別のフォルダの atlas は止めない', async () => {
      const v = makeRepo('viewers-only');
      const w = makeRepo('viewers-other');
      const serve = start(v, 'serve', spawnOpen);
      const open = await kidOf(serve);
      const other = start(w, 'serve', quiet);
      await waitFor(() => other.pid !== undefined && alive(other.pid), '別のフォルダのサーバの起動');
      mkdirSync(join(v, 'out'), { recursive: true });
      writeFileSync(join(v, 'out', '.serve.json'), JSON.stringify({ port: 1, pid: serve.pid }));

      const r = stop(v, ['-ViewersOnly']);
      expect(r.status).toBe(0);
      expect(r.text).toContain('前に開いた画面のサーバを止めました');
      expect(r.text).not.toContain('止めますか');
      expect(r.text.trim().split(/\r?\n/)).toHaveLength(1);
      await waitFor(() => !alive(serve.pid!) && !alive(open), 'サーバと open が止まる');
      expect(alive(other.pid!)).toBe(true);
      expect(existsSync(join(v, 'out', '.serve.json'))).toBe(false);
      // 止めた後にもう一度呼んでも(self-update で読み直した後など)、何もしない
      const again = stop(v, ['-ViewersOnly']);
      expect([again.status, again.text.trim()]).toEqual([0, '']);
    }, 120_000);

    it('-ViewersOnly: 集計が動いている・サーバの中で集計の子が動いている・サーバが集計の印を持っている・サーバに atlas でない子がいるときは、何も止めず尋ねずに 1 行出して 0 で終わる', async () => {
      const cases: { name: string; run: (repo: string) => Promise<number[]>; says: string }[] = [
        {
          name: 'viewers-busy-all',
          run: async (repo) => {
            const all = start(repo, 'all', quiet);
            const serve = start(repo, 'serve', quiet);
            await waitFor(() => alive(all.pid!) && alive(serve.pid!), '集計とサーバの起動');
            return [all.pid!, serve.pid!];
          },
          says: '集計',
        },
        {
          name: 'viewers-busy-kid',
          run: async (repo) => {
            const serve = start(repo, 'serve', spawnAll);
            return [serve.pid!, await kidOf(serve)];
          },
          says: '集計',
        },
        {
          name: 'viewers-busy-stamp',
          run: async (repo) => {
            const serve = start(repo, 'serve', quiet);
            await waitFor(() => alive(serve.pid!), 'サーバの起動');
            mkdirSync(join(repo, 'out-folders', 'k', 'out'), { recursive: true });
            writeFileSync(join(repo, 'out-folders', 'k', 'out', '.job.json'), JSON.stringify({ pid: serve.pid, kind: 'all', by: 'serve' }));
            return [serve.pid!];
          },
          says: '画面のサーバの中の集計',
        },
        {
          name: 'viewers-busy-other-child',
          run: async (repo) => {
            const serve = start(repo, 'serve');
            const f = join(tmp, `child-${serve.pid}`);
            await waitFor(() => existsSync(f), 'サーバの子');
            return [serve.pid!, Number(readFileSync(f, 'utf8'))];
          },
          says: '画面のサーバの中の処理',
        },
      ];
      for (const c of cases) {
        const repo = makeRepo(c.name);
        const pids = await c.run(repo);
        const r = stop(repo, ['-ViewersOnly']);
        expect(r.status, c.name).toBe(0);
        expect(r.text, c.name).toContain(c.says);
        expect(r.text, c.name).toContain('何も止めずに続けます');
        expect(r.text, c.name).not.toContain('止めますか');
        expect(r.text.trim().split(/\r?\n/), c.name).toHaveLength(1);
        expect(pids.map(alive), c.name).toEqual(pids.map(() => true));
        if (c.name === 'viewers-busy-stamp') expect(existsSync(join(repo, 'out-folders', 'k', 'out', '.job.json'))).toBe(true);
        // 次の場合に持ち越さない
        stop(repo, ['-Yes']);
        await waitFor(() => pids.every((p) => !alive(p)), '後片付け');
      }
    }, 180_000);
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
    // ビルドできなくても、前に作った atlas.exe で送る(-KeepOlder)
    expect(text).toContain("join(ROOT, 'scripts', 'ensure-atlas.ps1'), '-KeepOlder']");
    expect(text).toContain("['upload-auto', ...process.argv.slice(2)]");
    expect(text).toContain('schedule-upload.bat を開くと');
  });
});

// atlas.exe は配らない(2026-11-23 にやめた)ので、リリースを作るワークフローも、配る中身の一覧も置かない。
// 依存の検査は、PR の CI と毎週の検査が、devDependencies も含めて同じ基準で見る(画面のビルドの道具の出力は atlas.exe に埋め込まれる)
describe('ワークフロー(リリースは作らない。依存の検査)', () => {
  const WORKFLOWS = join(ROOT, '.github/workflows');
  it('リリースを作るワークフローと、配る中身の一覧が無い', () => {
    expect(existsSync(join(WORKFLOWS, 'release.yml'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/release-shipped.txt'))).toBe(false);
    for (const f of readdirSync(WORKFLOWS)) {
      const text = readFileSync(join(WORKFLOWS, f), 'utf8');
      expect(text, f).not.toMatch(/gh release|attest-build-provenance|softprops\/action-gh-release|tags:\s*\[?['"]?v/);
    }
    const rust = readFileSync(join(ROOT, 'crates/atlas-cli/src/self_update.rs'), 'utf8');
    expect(rust).not.toMatch(/release-shipped|SHIPPED_LIST|--tags/);
  });
  it('PR の CI と毎週の検査は、npm の依存を devDependencies も含めて scripts/npm-audit.mjs で見て、Rust の依存を cargo deny で見る', () => {
    for (const f of ['ci.yml', 'deny-schedule.yml']) {
      const text = readFileSync(join(WORKFLOWS, f), 'utf8');
      expect(text, f).toMatch(/run: node scripts\/npm-audit\.mjs$/m);
      // npm audit をそのまま回すと除外(npm-audit-ignore.json)を通らないので、npm-audit.mjs だけにする(署名の検査は別)
      expect(text, f).not.toMatch(/run: npm audit(?! signatures$)|--omit=dev/m);
      expect(text, f).toMatch(/run: cargo deny --locked check/);
    }
    // 入れたものの署名は、npm ci のあとに PR の CI で見る
    const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
    expect(ci).toMatch(/- run: npm ci\n[\s\S]*?run: npm audit signatures\n[\s\S]*?- run: npm run build:report\n/);
    // cargo-deny の版は 2 つのワークフローでそろえる
    const version = (f: string) => readFileSync(join(WORKFLOWS, f), 'utf8').match(/CARGO_DENY_VERSION: (\S+)/)?.[1];
    expect(version('ci.yml')).toBeDefined();
    expect(version('ci.yml')).toBe(version('deny-schedule.yml'));
  });
});
