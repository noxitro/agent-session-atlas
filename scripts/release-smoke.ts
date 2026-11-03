// 配布用フォルダ(scripts/pack-release.ts の出力)を atlas.bat と同じ順で動かして確かめる:
// *.bat が CRLF → 依存が無いと判定される → npm install → 揃ったと判定される → 架空の fixture で atlas all が通る
// → 同梱のテンプレートを作り直していない。
// 使い方: node scripts/release-smoke.ts <配布用フォルダ>(npm install するのでネットワークが要る)
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FIXTURES_DIR, writeFixtures } from './synthetic-fixtures.ts';

function fail(message: string): never {
  console.error(`release-smoke: 失敗: ${message}`);
  process.exit(1);
}

function depsFresh(dir: string): boolean {
  return spawnSync(process.execPath, [join('scripts', 'deps-fresh.mjs')], { cwd: dir, stdio: 'inherit' }).status === 0;
}

const pkg = process.argv[2] ? resolve(process.argv[2]) : fail('使い方: node scripts/release-smoke.ts <配布用フォルダ>');
if (!existsSync(join(pkg, 'package.json'))) fail(`${pkg} に package.json がありません`);

const bats = readdirSync(pkg).filter((f) => f.endsWith('.bat'));
if (!bats.length) fail('*.bat が入っていません');
for (const f of bats) {
  if (/(^|[^\r])\n/.test(readFileSync(join(pkg, f), 'utf8'))) fail(`${f} に CRLF でない改行があります(.gitattributes の eol を確認)`);
}

if (depsFresh(pkg)) fail('node_modules が無いのに deps-fresh が「揃っている」と判定しました');
execSync('npm install --no-audit --no-fund', { cwd: pkg, stdio: 'inherit' });
if (!depsFresh(pkg)) fail('npm install のあとも deps-fresh が「足りない」と判定しました');

const template = join(pkg, 'packages', 'report', 'dist', 'template.html');
if (!existsSync(template)) fail('ビルド済みのテンプレートが入っていません');
const before = statSync(template).mtimeMs;

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
if (statSync(template).mtimeMs !== before) fail('同梱のテンプレートを作り直しました(mtime がソースより新しくなっていない)');

console.log(`release-smoke: 通過(${bats.length} 本の *.bat、npm install、atlas all)`);
