// clone した直後と同じ中身のフォルダ(scripts/fresh-checkout.ts の出力)を atlas.bat と同じ順で動かして確かめる:
// *.bat が CRLF → 依存が無いと判定される → npm install → 揃ったと判定される → 架空の fixture で atlas all が通る
// (レポートのテンプレートは入っていないので、最初の atlas all が作る)→ プロジェクトを送る操作 → Windows では *.bat を実際に起動する。
// 使い方: node scripts/checkout-smoke.ts <フォルダ>(npm install するのでネットワークが要る)
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FIXTURES_DIR, writeFixtures } from './synthetic-fixtures.ts';

function fail(message: string): never {
  console.error(`checkout-smoke: 失敗: ${message}`);
  process.exit(1);
}

function depsFresh(dir: string): boolean {
  return spawnSync(process.execPath, [join('scripts', 'deps-fresh.mjs')], { cwd: dir, stdio: 'inherit' }).status === 0;
}

const pkg = process.argv[2] ? resolve(process.argv[2]) : fail('使い方: node scripts/checkout-smoke.ts <フォルダ>');
if (!existsSync(join(pkg, 'package.json'))) fail(`${pkg} に package.json がありません`);

const bats = readdirSync(pkg).filter((f) => f.endsWith('.bat'));
// 利用者が起動するのは atlas.bat(集計と画面)・setup.bat(初期設定)・upload-project.bat(プロジェクトのセッションを送る)だけ(他の操作は画面とコマンドから)
if (bats.sort().join(',') !== 'atlas.bat,setup.bat,upload-project.bat') fail(`*.bat は atlas.bat・setup.bat・upload-project.bat だけのはずです(入っているもの: ${bats.join(', ') || 'なし'})`);
for (const f of bats) {
  if (/(^|[^\r])\n/.test(readFileSync(join(pkg, f), 'utf8'))) fail(`${f} に CRLF でない改行があります(.gitattributes の eol を確認)`);
}
// *.bat 以外はリポジトリのまま LF(手元の core.autocrlf で変わっていない = Linux で作るリリースと同じ中身)
if (readFileSync(join(pkg, 'package.json'), 'utf8').includes('\r')) fail('package.json が CRLF になっています(core.autocrlf の影響)');

if (depsFresh(pkg)) fail('node_modules が無いのに deps-fresh が「揃っている」と判定しました');
execSync('npm install --no-audit --no-fund', { cwd: pkg, stdio: 'inherit' });
if (!depsFresh(pkg)) fail('npm install のあとも deps-fresh が「足りない」と判定しました');

// setup.bat が呼ぶ初期設定: vault なし・工程名は既定・アップロード先は決めない・最後に「n」で、書かずに正常に終わる
const setup = spawnSync(process.execPath, [join('packages', 'cli', 'src', 'setup.ts')], { cwd: pkg, input: '\n\n\nn\n', encoding: 'utf8' });
if (setup.status !== 0 || !setup.stdout.includes('書きませんでした')) fail(`初期設定(setup.ts)が通りません: ${setup.stderr}${setup.stdout}`);
if (existsSync(join(pkg, 'atlas.config.json'))) fail('初期設定で「n」と答えたのに atlas.config.json ができました');

// clone した直後にはレポートのテンプレートが無い(packages/report/dist は git に入れない)。最初の atlas all が Vite で作る
const template = join(pkg, 'packages', 'report', 'dist', 'template.html');
if (existsSync(template)) fail('clone した直後には無いはずのレポートのテンプレートが入っています');

await writeFixtures();
const out = join(pkg, 'out');
const r = spawnSync(process.execPath, [join('packages', 'cli', 'src', 'main.ts'), 'all', '--home', join(FIXTURES_DIR, 'copilot-home'), '--out', out], {
  cwd: pkg,
  stdio: 'inherit',
});
if (r.status !== 0) fail(`atlas all が終了コード ${r.status} で失敗しました`);
for (const f of ['atlas.html', 'insights.html', 'glossary.html']) {
  if (!existsSync(join(out, f)) || statSync(join(out, f)).size === 0) fail(`${f} ができていません`);
}
if (!readdirSync(join(out, 'sessions')).some((f) => f.endsWith('.md'))) fail('セッション記録(sessions/*.md)ができていません');
if (!existsSync(template)) fail('最初の atlas all がレポートのテンプレートを作りませんでした');
// upload-project.bat が呼ぶ送る操作: 集計し直してからプロジェクトの一覧を出し、何も選ばずに Enter で何も送らずに正常に終わる。
// 集計は中で動くので、読むのは架空の fixture にする(ATLAS_COPILOT_HOME。無いと手元の ~/.copilot を読む)
const up = spawnSync(process.execPath, [join('packages', 'cli', 'src', 'upload-project.ts')], {
  cwd: pkg,
  input: '\n',
  encoding: 'utf8',
  env: { ...process.env, ATLAS_CONFIG: join(pkg, 'atlas.config.json'), ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') },
});
if (up.status !== 0 || !up.stdout.includes('集計しました') || !/プロジェクト/.test(up.stdout) || !up.stdout.includes('やめました')) fail(`プロジェクトを送る操作(upload-project.ts)が通りません: ${up.stderr}${up.stdout}`);

// Windows では *.bat を cmd で実際に起動する(中のスクリプトを直接呼ぶだけでは、bat の書き方の誤りを見逃す。
// upload-project.bat は囲みの中の echo の括弧で、集計の後に必ず止まっていた)。集計は架空の fixture を読む(ATLAS_COPILOT_HOME)。
// 入力を流し込んでも bat の中の前のプログラムが先に読むことがあるので、答えて進むところまでは見ず、bat が止まらずに中のスクリプトまで進むことを見る。
// atlas.bat は最後にサーバを開いたまま待つので起動しない(中の集計とサーバは上と E2E で見ている)
if (process.platform === 'win32') {
  const { ATLAS_CONFIG: _ignored, ...env } = process.env;
  const runBat = (bat: string, input: string): string => {
    // 置き場所をはっきり書く(NoDefaultCurrentDirectoryInExePath が効いている環境では、名前だけだと今のフォルダの bat を探さない)
    const r = spawnSync('cmd.exe', ['/d', '/c', `.\\${bat}`], { cwd: pkg, input, encoding: 'utf8', env: { ...env, ATLAS_COPILOT_HOME: join(FIXTURES_DIR, 'copilot-home') }, timeout: 300_000 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // cmd が bat を読めなかったときの文言(英語版と日本語版)
    if (/was unexpected at this time|は予期されていません|is not recognized as an internal or external command|内部コマンドまたは外部コマンド/.test(text)) fail(`${bat} を cmd が読めずに止まりました:\n${text}`);
    return text;
  };
  const upBat = runBat('upload-project.bat', '\n\n');
  if (!/== 送るプロジェクト|送れるセッションがありません/.test(upBat)) fail(`upload-project.bat が、送る操作(プロジェクトの一覧)まで進みませんでした:\n${upBat}`);
  const setupBat = runBat('setup.bat', '\n\n\nn\n\n');
  if (!setupBat.includes('agent-session-atlas の初期設定')) fail(`setup.bat が、初期設定のスクリプトまで進みませんでした:\n${setupBat}`);
  if (existsSync(join(pkg, 'atlas.config.json'))) fail('setup.bat で書かない答えをしたのに atlas.config.json ができました');
}

console.log(`checkout-smoke: 通過(${bats.length} 本の *.bat、npm install、atlas all、プロジェクトを送る操作${process.platform === 'win32' ? '、upload-project.bat と setup.bat の起動' : ''})`);
