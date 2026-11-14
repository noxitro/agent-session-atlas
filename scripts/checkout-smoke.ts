// clone した直後と同じ中身のフォルダ(scripts/fresh-checkout.ts の出力)を、起動用の .bat と同じ順で動かして確かめる:
// *.bat と ensure-atlas.ps1 が CRLF → 実行ファイル(bin/atlas.exe)もテンプレートも無い → scripts/ensure-atlas.ps1 が、
// リリースを探せない(git archive なので origin が無い)ので、この PC でビルドする(npm ci → npm run build:report → cargo build --release)
// → もう一度動かすとビルドせずに使い回す → 架空の fixture で初期設定・atlas all・プロジェクトを送る操作が通る → Windows では *.bat を実際に起動する。
// 使い方: node scripts/checkout-smoke.ts <フォルダ>(npm ci と cargo build をするのでネットワークが要る。
// 環境変数 CARGO_TARGET_DIR を渡すと、そこでビルドする。npm run smoke はリポジトリの target/ を渡し、依存のビルドを使い回す)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeConsole } from './console-text.ts';
import { FIXTURES_DIR, writeFixtures } from './synthetic-fixtures.ts';

function fail(message: string): never {
  console.error(`checkout-smoke: 失敗: ${message}`);
  process.exit(1);
}

const WINDOWS = process.platform === 'win32';
const pkg = process.argv[2] ? resolve(process.argv[2]) : fail('使い方: node scripts/checkout-smoke.ts <フォルダ>');
if (!existsSync(join(pkg, 'package.json'))) fail(`${pkg} に package.json がありません`);
const exe = join(pkg, 'bin', WINDOWS ? 'atlas.exe' : 'atlas');

const bats = readdirSync(pkg).filter((f) => f.endsWith('.bat'));
// 利用者が起動するのは atlas.bat(集計と画面)・open-folder.bat(選んだフォルダを集計して開く)・schedule-upload.bat(毎日自動で送る登録)・
// setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)だけ(他の操作は画面とコマンドから)
const BATS = 'atlas.bat,open-folder.bat,schedule-upload.bat,setup.bat,upload-project.bat';
if (bats.sort().join(',') !== BATS) fail(`*.bat は ${BATS.split(',').join('・')} だけのはずです(入っているもの: ${bats.join(', ') || 'なし'})`);
for (const f of [...bats, join('scripts', 'ensure-atlas.ps1')]) {
  if (/(^|[^\r])\n/.test(readFileSync(join(pkg, f), 'utf8'))) fail(`${f} に CRLF でない改行があります(.gitattributes の eol を確認)`);
}
// *.bat と *.ps1 以外はリポジトリのまま LF(手元の core.autocrlf で変わっていない = Linux で作るリリースと同じ中身)
if (readFileSync(join(pkg, 'package.json'), 'utf8').includes('\r')) fail('package.json が CRLF になっています(core.autocrlf の影響)');

// clone した直後には、実行ファイルもレポートのテンプレートも無い(bin/ と packages/report/dist は git に入れない)
const template = join(pkg, 'packages', 'report', 'dist', 'template.html');
if (existsSync(exe)) fail('clone した直後には無いはずの bin の実行ファイルが入っています');
if (existsSync(template)) fail('clone した直後には無いはずのレポートのテンプレートが入っています');

// 起動用の .bat と同じく ensure-atlas.ps1 を動かす(Windows は Windows PowerShell、ほかは pwsh)
const ensure = (args: string[] = []) => {
  const t = performance.now();
  const r = spawnSync(WINDOWS ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('scripts', 'ensure-atlas.ps1'), ...args], { cwd: pkg, encoding: 'utf8', timeout: 40 * 60_000 });
  return { status: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}`, seconds: (performance.now() - t) / 1000 };
};
if (ensure(['-Check']).status !== 1) fail('実行ファイルが無いのに ensure-atlas.ps1 -Check が「そのまま使える」と答えました');
const first = ensure();
if (first.status !== 0 || !existsSync(exe)) fail(`ensure-atlas.ps1 がこの PC でのビルドで実行ファイルを用意できませんでした(終了コード ${first.status}):\n${first.text}`);
if (!first.text.includes('この PC でビルドします')) fail(`ensure-atlas.ps1 がビルドの道を通りませんでした:\n${first.text}`);
console.log(`checkout-smoke: ensure-atlas.ps1 がビルドしました(${first.seconds.toFixed(0)} 秒)`);
const want = /^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(pkg, 'Cargo.toml'), 'utf8'))?.[1];
const version = spawnSync(exe, ['--version'], { encoding: 'utf8' }).stdout.trim();
if (!want || !version.startsWith(`atlas ${want} (`)) fail(`bin の実行ファイルの版(${version})が Cargo.toml の版(${want})と違います`);
if (!readFileSync(join(pkg, 'bin', 'atlas-source.txt'), 'utf8').startsWith('local')) fail('bin/atlas-source.txt が、この PC でビルドしたことを示していません');
const again = ensure();
if (again.status !== 0 || again.text.trim()) fail(`2 回目の ensure-atlas.ps1 が、置いた実行ファイルを使い回しませんでした:\n${again.text}`);
if (ensure(['-Check']).status !== 0) fail('実行ファイルを置いた後の ensure-atlas.ps1 -Check が「用意し直す」と答えました');
console.log(`checkout-smoke: 2 回目の ensure-atlas.ps1 は使い回しました(${again.seconds.toFixed(1)} 秒)`);

// setup.bat が呼ぶ初期設定: vault なし・工程名は既定・アップロード先は決めない・最後に「n」で、書かずに正常に終わる
const setup = spawnSync(exe, ['setup'], { cwd: pkg, input: '\n\n\nn\n', encoding: 'utf8' });
if (setup.status !== 0 || !setup.stdout.includes('書きませんでした')) fail(`初期設定(atlas setup)が通りません: ${setup.stderr}${setup.stdout}`);
if (existsSync(join(pkg, 'atlas.config.json'))) fail('初期設定で「n」と答えたのに atlas.config.json ができました');

await writeFixtures();
const out = join(pkg, 'out');
const r = spawnSync(exe, ['all', '--home', join(FIXTURES_DIR, 'copilot-home'), '--out', out], { cwd: pkg, stdio: 'inherit' });
if (r.status !== 0) fail(`atlas all が終了コード ${r.status} で失敗しました`);
for (const f of ['atlas.html', 'insights.html', 'glossary.html']) {
  if (!existsSync(join(out, f)) || statSync(join(out, f)).size === 0) fail(`${f} ができていません`);
}
if (!readdirSync(join(out, 'sessions')).some((f) => f.endsWith('.md'))) fail('セッション記録(sessions/*.md)ができていません');
// upload-project.bat が呼ぶ送る操作: 集計し直してからプロジェクトの一覧を出し、何も選ばずに Enter で何も送らずに正常に終わる。
// 集計は中で動くので、読むのは架空の fixture にする(ATLAS_COPILOT_HOME。無いと手元の ~/.copilot を読む)。
// 設定は bat と同じく既定の場所(フォルダの atlas.config.json。まだ無い)を使う。ATLAS_CONFIG を指すと、無い設定ファイルとして集計が止まる
const { ATLAS_CONFIG: _config, ...upEnv } = process.env;
const up = spawnSync(exe, ['upload-project'], { cwd: pkg, input: '\n', encoding: 'utf8', env: { ...upEnv, ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') } });
if (up.status !== 0 || !up.stdout.includes('集計しました') || !/プロジェクト/.test(up.stdout) || !up.stdout.includes('やめました')) fail(`プロジェクトを送る操作(atlas upload-project)が通りません: ${up.stderr}${up.stdout}`);

// Windows では *.bat を cmd で実際に起動する(中のコマンドを直接呼ぶだけでは、bat の書き方の誤りを見逃す。
// upload-project.bat は囲みの中の echo の括弧で、集計の後に必ず止まっていた)。集計は架空の fixture を読む(ATLAS_COPILOT_HOME)。
// 入力を流し込んでも bat の中の前のプログラムが先に読むことがあるので、答えて進むところまでは見ず、bat が止まらずに中のコマンドまで進むことを見る。
// atlas.bat は最後にサーバを開いたまま待つので起動しない(中の集計とサーバは上と E2E で見ている)
if (WINDOWS) {
  const { ATLAS_CONFIG: _ignored, ...env } = process.env;
  const launchBat = (bat: string, args: string[], input: string) => {
    // 置き場所をはっきり書く(NoDefaultCurrentDirectoryInExePath が効いている環境では、名前だけだと今のフォルダの bat を探さない)
    const r = spawnSync('cmd.exe', ['/d', '/c', `.\\${bat}`, ...args], { cwd: pkg, input, env: { ...env, ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') }, timeout: 300_000 });
    // cmd の文言は cp932 で、中の atlas の出力は UTF-8 で出る(1 つの出力に混ざる)ので、1 行ずつ合うほうで読む
    const stdout = decodeConsole(r.stdout);
    const stderr = decodeConsole(r.stderr);
    const text = `${stdout}${stderr}`;
    // cmd が bat を読めなかった・読み違えた(chcp 65001 の後に、前の行の途中を実行した)ときの文言(英語版と日本語版)
    if (/was unexpected at this time|は予期されていません|is not recognized as an internal or external command|内部コマンドまたは外部コマンド/.test(text)) fail(`${bat} を cmd が読めずに止まりました:\n${text}`);
    return { status: r.status, stdout, stderr, text };
  };
  const runBat = (bat: string, input: string): string => {
    const { status: code, stdout, stderr, text } = launchBat(bat, [], input);
    // 架空の fixture で正しく動けば、エラー出力には何も出ない(出たのは cmd の読み違えとは限らない: 中のコマンドのエラーのこともある)
    if (stderr.trim()) fail(`${bat} がエラー出力に何かを書きました(正しく動けば何も出ません):\n${stderr}\n--- 標準出力 ---\n${stdout}`);
    // 中の atlas が正常に終われば、bat も 0 で終わる(atlas の終了コードを bat の終了コードとして返す)
    if (code !== 0) fail(`${bat} が終了コード ${code} で終わりました:\n${text}`);
    // 実行ファイルはもう置いてあるので、ensure-atlas.ps1 は何も出さない
    if (stdout.includes('atlas を用意します')) fail(`${bat} が、置いてある実行ファイルを使い回しませんでした:\n${stdout}`);
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
  // 登録してある PC でも、Enter だけなら何も変えない)
  const schedBat = runBat('schedule-upload.bat', '\n\n');
  if (!schedBat.includes('== 毎日自動で送る ==')) fail(`schedule-upload.bat が、登録の画面まで進みませんでした:\n${schedBat}`);
  const setupBat = runBat('setup.bat', '\n\n\nn\n\n');
  if (!setupBat.includes('agent-session-atlas の初期設定')) fail(`setup.bat が、初期設定まで進みませんでした:\n${setupBat}`);
  if (existsSync(join(pkg, 'atlas.config.json'))) fail('setup.bat で書かない答えをしたのに atlas.config.json ができました');
}

console.log(
  `checkout-smoke: 通過(${bats.length} 本の *.bat、ensure-atlas.ps1 のビルドと使い回し、atlas all、プロジェクトを送る操作${WINDOWS ? '、upload-project.bat と schedule-upload.bat と setup.bat と open-folder.bat の起動' : ''})`,
);
