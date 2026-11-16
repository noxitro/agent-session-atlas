// clone した直後と同じ中身のフォルダ(scripts/fresh-checkout.ts の出力)を、atlas.bat と同じ順で動かして確かめる:
// *.bat と *.ps1 が CRLF → 開くたびの更新(launcher-update.ts)が、git で取得したフォルダではないので何もせずに 0 で終わる
// → 依存が無いと判定される → npm install → 揃ったと判定される → 架空の fixture で atlas all が通る
// (レポートのテンプレートは入っていないので、最初の atlas all が作る)→ atlas serve が画面を配る → 初期設定・プロジェクトを送る操作
// → Windows では *.bat を実際に起動する。
// 使い方: node scripts/checkout-smoke.ts <フォルダ>(npm install するのでネットワークが要る)
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeConsole } from './console-text.ts';
import { FIXTURES_DIR, writeFixtures } from './synthetic-fixtures.ts';

function fail(message: string): never {
  console.error(`checkout-smoke: 失敗: ${message}`);
  process.exit(1);
}

const WINDOWS = process.platform === 'win32';

function depsFresh(dir: string): boolean {
  return spawnSync(process.execPath, [join('scripts', 'deps-fresh.mjs')], { cwd: dir, stdio: 'inherit' }).status === 0;
}

const pkg = process.argv[2] ? resolve(process.argv[2]) : fail('使い方: node scripts/checkout-smoke.ts <フォルダ>');
if (!existsSync(join(pkg, 'package.json'))) fail(`${pkg} に package.json がありません`);
const cli = (f: string): string => join(pkg, 'packages', 'cli', 'src', f);
/** 起動用の .bat から動かすときと同じ環境(開くたびの更新を止める・済ませた印を外す。設定は既定の場所) */
const { ATLAS_CONFIG: _config, ATLAS_NO_AUTO_UPDATE: _noUpdate, ATLAS_SELF_UPDATED: _updated, ATLAS_OUT: _out, ...baseEnv } = process.env;

const bats = readdirSync(pkg).filter((f) => f.endsWith('.bat'));
// 利用者が起動するのは atlas.bat(集計と画面)・open-folder.bat(選んだフォルダを集計して開く)・schedule-upload.bat(毎日自動で送る登録)・
// setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)と、止める stop.bat だけ(他の操作は画面とコマンドから)
const BATS = 'atlas.bat,open-folder.bat,schedule-upload.bat,setup.bat,stop.bat,upload-project.bat';
if (bats.sort().join(',') !== BATS) fail(`*.bat は ${BATS.split(',').join('・')} だけのはずです(入っているもの: ${bats.join(', ') || 'なし'})`);
for (const f of [...bats, join('scripts', 'ensure-atlas.ps1'), join('scripts', 'stop-atlas.ps1')]) {
  if (/(^|[^\r])\n/.test(readFileSync(join(pkg, f), 'utf8'))) fail(`${f} に CRLF でない改行があります(.gitattributes の eol を確認)`);
}
// *.bat と *.ps1 以外はリポジトリのまま LF(手元の core.autocrlf で変わっていない = Linux で clone した中身と同じ)
if (readFileSync(join(pkg, 'package.json'), 'utf8').includes('\r')) fail('package.json が CRLF になっています(core.autocrlf の影響)');
// 前の版(Rust で作った atlas.exe)の名残りが無い
if (existsSync(join(pkg, 'bin'))) fail('clone した直後には無いはずの bin/ が入っています');

// 1. 開くたびの更新(atlas.bat が依存の確かめより前に動かす。依存が無くても動く)。git で取得したフォルダではないので、
//    理由を 1 行出して 0 で終わる(10 なら .bat が動かし直してしまう)
const lu = spawnSync(process.execPath, [cli('launcher-update.ts')], { cwd: pkg, encoding: 'utf8', env: baseEnv, timeout: 120_000 });
if (lu.status !== 0 || lu.stdout.trim() !== 'atlas の更新: git で取得したフォルダではないので、更新しません(git clone し直すと、自動で新しい版にできます)' || lu.stderr.trim())
  fail(`launcher-update.ts が、依存の無いフォルダで 1 行出して 0 で終わりませんでした(終了コード ${lu.status}):\n${lu.stdout}${lu.stderr}`);
console.log('checkout-smoke: 開くたびの更新(launcher-update.ts)は、依存が無くても動きました');

// 前の版の atlas.exe がこの版を取り込んだときに呼ぶ ensure-atlas.ps1 -Check: 依存が無いので「用意が要る」(1)。
// Windows PowerShell で動かす(ほかの OS は pwsh があれば。タスクの確かめは Windows だけ)
const ps = WINDOWS ? 'powershell.exe' : spawnSync('pwsh', ['-v'], { stdio: 'ignore' }).status === 0 ? 'pwsh' : null;
const ensureCheck = (): number | null =>
  ps ? spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join('scripts', 'ensure-atlas.ps1'), '-Check'], { cwd: pkg, stdio: 'ignore', timeout: 120_000 }).status : null;
if (ps && ensureCheck() !== 1) fail('依存が無いのに ensure-atlas.ps1 -Check が「そのまま動ける」と答えました');

// 2. 依存の確かめと npm install(atlas.bat と同じ)
if (depsFresh(pkg)) fail('node_modules が無いのに deps-fresh が「揃っている」と判定しました');
execSync('npm install --no-audit --no-fund', { cwd: pkg, stdio: 'inherit' });
if (!depsFresh(pkg)) fail('npm install のあとも deps-fresh が「足りない」と判定しました');
// 依存がそろい、このフォルダの atlas.exe で登録したタスクも無いので、前の版から移る用意は要らない
if (ps && ensureCheck() !== 0) fail('npm install の後も ensure-atlas.ps1 -Check が「用意が要る」と答えました');

// setup.bat が呼ぶ初期設定: vault なし・工程名は既定・アップロード先は決めない・最後に「n」で、書かずに正常に終わる
const setup = spawnSync(process.execPath, [cli('setup.ts')], { cwd: pkg, input: '\n\n\nn\n', encoding: 'utf8', env: baseEnv });
if (setup.status !== 0 || !setup.stdout.includes('書きませんでした')) fail(`初期設定(setup.ts)が通りません: ${setup.stderr}${setup.stdout}`);
if (existsSync(join(pkg, 'atlas.config.json'))) fail('初期設定で「n」と答えたのに atlas.config.json ができました');

// clone した直後にはレポートのテンプレートが無い(packages/report/dist は git に入れない)。最初の atlas all が Vite で作る
const template = join(pkg, 'packages', 'report', 'dist', 'template.html');
if (existsSync(template)) fail('clone した直後には無いはずのレポートのテンプレートが入っています');

// 3. atlas.bat の集計(main.ts all)。読むのは架空の fixture、出力先は atlas.bat と同じ既定の out/
await writeFixtures();
const out = join(pkg, 'out');
const r = spawnSync(process.execPath, [cli('main.ts'), 'all', '--home', join(FIXTURES_DIR, 'copilot-home')], { cwd: pkg, stdio: 'inherit', env: baseEnv });
if (r.status !== 0) fail(`atlas all が終了コード ${r.status} で失敗しました`);
for (const f of ['atlas.html', 'insights.html', 'glossary.html']) {
  if (!existsSync(join(out, f)) || statSync(join(out, f)).size === 0) fail(`${f} ができていません`);
}
if (!readdirSync(join(out, 'sessions')).some((f) => f.endsWith('.md'))) fail('セッション記録(sessions/*.md)ができていません');
if (!existsSync(template)) fail('最初の atlas all がレポートのテンプレートを作りませんでした');

// 4. atlas.bat の画面(main.ts serve)。ブラウザは開かず、配った atlas.html に token が入っていて、.serve.json ができることを見る
{
  const child = spawn(process.execPath, [cli('main.ts'), 'serve', '--no-open'], { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv });
  let text = '';
  child.stdout.on('data', (d) => (text += String(d)));
  child.stderr.on('data', (d) => (text += String(d)));
  const exited = new Promise<number | null>((ok) => child.on('close', ok));
  /** 失敗の理由(サーバを止めてから fail する) */
  let problem: string | null = null;
  try {
    const url = await new Promise<string>((ok, ng) => {
      const t = setTimeout(() => ng(new Error(`atlas serve が 60 秒のうちに起動しませんでした:\n${text}`)), 60_000);
      const tick = (): void => {
        const m = /serve: (http:\/\/127\.0\.0\.1:\d+\/atlas\.html)/.exec(text);
        if (m) {
          clearTimeout(t);
          ok(m[1]!);
        } else if (child.exitCode != null) {
          clearTimeout(t);
          ng(new Error(`atlas serve が終了コード ${child.exitCode} で止まりました:\n${text}`));
        } else setTimeout(tick, 100);
      };
      tick();
    });
    const res = await fetch(url);
    const html = await res.text();
    // atlas.bat が 2 回目に開いたとき、動いているサーバを見つけて使い回す目印(findRunningServer が見るもの)
    const state = await fetch(url.replace(/atlas\.html$/, 'api/state'));
    await state.arrayBuffer();
    if (res.status !== 200) problem = `atlas serve が atlas.html を配りませんでした(${res.status}): ${url}`;
    else if (!/<meta name="atlas-token" content="(?!__ATLAS_TOKEN__)[^"]+"/.test(html)) problem = 'atlas serve が配った atlas.html に token が入っていません';
    else if (state.headers.get('x-atlas-serve') !== '1') problem = `atlas serve の api/state に目印(x-atlas-serve)がありません(${state.status})`;
    else if (!existsSync(join(out, '.serve.json'))) problem = 'atlas serve が out/.serve.json を書いていません';
    else console.log(`checkout-smoke: atlas serve が画面を配りました(${url})`);
  } catch (e) {
    problem = (e as Error).message;
  } finally {
    child.kill();
    await exited;
  }
  if (problem) fail(problem);
}

// upload-project.bat が呼ぶ送る操作: 集計し直してからプロジェクトの一覧を出し、何も選ばずに Enter で何も送らずに正常に終わる。
// 集計は中で動くので、読むのは架空の fixture にする(ATLAS_COPILOT_HOME。無いと手元の ~/.copilot を読む)。
// 設定は bat と同じく既定の場所(フォルダの atlas.config.json。まだ無い)を使う。ATLAS_CONFIG を指すと、無い設定ファイルとして集計が止まる
const up = spawnSync(process.execPath, [cli('upload-project.ts')], {
  cwd: pkg,
  input: '\n',
  encoding: 'utf8',
  env: { ...baseEnv, ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') },
});
if (up.status !== 0 || !up.stdout.includes('集計しました') || !/プロジェクト/.test(up.stdout) || !up.stdout.includes('やめました')) fail(`プロジェクトを送る操作(upload-project.ts)が通りません: ${up.stderr}${up.stdout}`);

// Windows では *.bat を cmd で実際に起動する(中のスクリプトを直接呼ぶだけでは、bat の書き方の誤りを見逃す。
// upload-project.bat は囲みの中の echo の括弧で、集計の後に必ず止まっていた)。集計は架空の fixture を読む(ATLAS_COPILOT_HOME)。
// 入力を流し込んでも bat の中の前のプログラムが先に読むことがあるので、答えて進むところまでは見ず、bat が止まらずに中のスクリプトまで進むことを見る。
// atlas.bat は最後にサーバを開いたまま待つので起動しない(中の集計とサーバは上と E2E で見ている)
if (WINDOWS) {
  const launchBat = (bat: string, args: string[], input: string) => {
    // 置き場所をはっきり書く(NoDefaultCurrentDirectoryInExePath が効いている環境では、名前だけだと今のフォルダの bat を探さない)
    const r = spawnSync('cmd.exe', ['/d', '/c', `.\\${bat}`, ...args], { cwd: pkg, input, env: { ...baseEnv, ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') }, timeout: 300_000 });
    // cmd の文言は cp932 で、中の node の出力は UTF-8 で出る(1 つの出力に混ざる)ので、1 行ずつ合うほうで読む
    const stdout = decodeConsole(r.stdout);
    const stderr = decodeConsole(r.stderr);
    const text = `${stdout}${stderr}`;
    // cmd が bat を読めなかった・読み違えた(chcp 65001 の後に、前の行の途中を実行した)ときの文言(英語版と日本語版)
    if (/was unexpected at this time|は予期されていません|is not recognized as an internal or external command|内部コマンドまたは外部コマンド/.test(text)) fail(`${bat} を cmd が読めずに止まりました:\n${text}`);
    // main.ts が知らないサブコマンドを渡された(入口を間違えた)
    if (/不明なコマンドです/.test(text)) fail(`${bat} が main.ts に知らないコマンドを渡しました:\n${text}`);
    return { status: r.status, stdout, stderr, text };
  };
  const runBat = (bat: string, input: string): string => {
    const { status: code, stdout, stderr, text } = launchBat(bat, [], input);
    // 架空の fixture で正しく動けば、エラー出力には何も出ない(出たのは cmd の読み違えとは限らない: node の警告や、中のスクリプトのエラーのこともある)
    if (stderr.trim()) fail(`${bat} がエラー出力に何かを書きました(正しく動けば何も出ません):\n${stderr}\n--- 標準出力 ---\n${stdout}`);
    // 中の node が正常に終われば、bat も 0 で終わる(node の終了コードを bat の終了コードとして返す)
    if (code !== 0) fail(`${bat} が終了コード ${code} で終わりました:\n${text}`);
    // 開くたびの更新(launcher-update.ts)まで進み、git で取得したフォルダではないので何もせずに続ける
    if (!stdout.includes('atlas の更新: git で取得したフォルダではないので、更新しません')) fail(`${bat} が、開くたびの更新(launcher-update.ts)を通りませんでした:\n${stdout}`);
    // 依存はもうそろっているので、npm install はしない
    if (stdout.includes('npm install を実行します')) fail(`${bat} が、そろっている依存を入れ直しました:\n${stdout}`);
    return stdout;
  };
  // open-folder.bat: 引数(エクスプローラーで bat に重ねたフォルダ)を open にそのまま渡す。無いフォルダは理由を出し、
  // 何も書かずに終了コード 1 で止まる(選ぶ画面は人の操作が要るので、ここでは出さない。--pick の動きは単体テスト)
  const missing = join(pkg, 'no-such-folder');
  const openBat = launchBat('open-folder.bat', [missing], '\n');
  if (openBat.status !== 1 || !openBat.text.includes('フォルダが見つかりません') || !openBat.text.includes(missing) || !openBat.text.includes('フォルダを開けませんでした'))
    fail(`open-folder.bat が、渡したフォルダを open に渡して理由を出すところまで進みませんでした(終了コード ${openBat.status}):\n${openBat.text}`);
  if (existsSync(join(pkg, 'out-folders'))) fail('open-folder.bat で無いフォルダを渡したのに out-folders ができました');
  const upBat = runBat('upload-project.bat', '\n\n');
  if (!/== 送るプロジェクト|送れるセッションがありません/.test(upBat)) fail(`upload-project.bat が、送る操作(プロジェクトの一覧)まで進みませんでした:\n${upBat}`);
  // schedule-upload.bat: 送り先も印もまだ無いので、先に決めることを出して何も登録せずに終わる(タスク スケジューラは読むだけ。
  // 登録してある PC でも、Enter だけなら何も変えない。前の版の atlas.exe の形で登録したタスクだけは、Node の形に登録し直す)
  const schedBat = runBat('schedule-upload.bat', '\n\n');
  if (!schedBat.includes('== 毎日自動で送る ==')) fail(`schedule-upload.bat が、登録の画面まで進みませんでした:\n${schedBat}`);
  const setupBat = runBat('setup.bat', '\n\n\nn\n\n');
  if (!setupBat.includes('agent-session-atlas の初期設定')) fail(`setup.bat が、初期設定のスクリプトまで進みませんでした:\n${setupBat}`);
  if (existsSync(join(pkg, 'atlas.config.json'))) fail('setup.bat で書かない答えをしたのに atlas.config.json ができました');
  // stop.bat: このフォルダの atlas は何も動いていない(上の serve は止めた)ので、そう出して 0 で終わる(止める動きは scripts/launchers.test.ts)。
  // 開くたびの更新は通らない
  const stopBat = launchBat('stop.bat', [], '\n');
  if (stopBat.status !== 0 || !stopBat.text.includes('動いている atlas はありません') || stopBat.text.includes('atlas の更新'))
    fail(`stop.bat が、動いていないことを出して終わりませんでした(終了コード ${stopBat.status}):\n${stopBat.text}`);
}

console.log(
  `checkout-smoke: 通過(${bats.length} 本の *.bat、開くたびの更新、npm install、atlas all、atlas serve、初期設定とプロジェクトを送る操作${WINDOWS ? '、upload-project.bat と schedule-upload.bat と setup.bat と open-folder.bat と stop.bat の起動' : ''})`,
);
