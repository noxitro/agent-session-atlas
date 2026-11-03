// 配布用のフォルダを作る: ソース一式(git archive HEAD)にビルド済みのレポートテンプレートを足す。
// release.yml がこれを zip にし、CI は同じものを scripts/release-smoke.ts で動かして確かめる。
// 使い方: node scripts/pack-release.ts <名前> <出力先>(先に npm run build:report を済ませておく。<出力先>/<名前> ができる)
// git archive なので .gitattributes の eol(*.bat は CRLF)が効き、コミットしていない変更は入らない。
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE = join(ROOT, 'packages', 'report', 'dist', 'template.html');

function waitExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((ok, ng) => {
    child.on('error', ng);
    child.on('close', (code) => (code === 0 ? ok() : ng(new Error(`${label} が終了コード ${code} で失敗しました`))));
  });
}

export async function packRelease(name: string, dest: string): Promise<string> {
  if (!existsSync(TEMPLATE)) throw new Error(`${TEMPLATE} がありません。先に npm run build:report を実行してください`);
  const dir = join(dest, name);
  if (existsSync(dir)) throw new Error(`${dir} はすでにあります(前回の残りを混ぜないため、消してから実行してください)`);
  mkdirSync(dest, { recursive: true });

  const git = spawn('git', ['archive', '--format=tar', `--prefix=${name}/`, 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const tar = spawn('tar', ['-x', '-f', '-'], { cwd: dest, stdio: ['pipe', 'inherit', 'inherit'] });
  git.stdout.pipe(tar.stdin);
  await Promise.all([waitExit(git, 'git archive'), waitExit(tar, 'tar')]);

  // テンプレートはソースより新しい mtime で入れる(atlas build がソースより古いと見て作り直さないように)
  const distDir = join(dir, 'packages', 'report', 'dist');
  mkdirSync(distDir, { recursive: true });
  const copied = join(distDir, 'template.html');
  copyFileSync(TEMPLATE, copied);
  const now = new Date();
  utimesSync(copied, now, now);
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [name, dest] = process.argv.slice(2);
  if (!name || !dest) {
    console.error('使い方: node scripts/pack-release.ts <名前> <出力先>');
    process.exit(2);
  }
  try {
    console.log(`配布用フォルダを作りました: ${await packRelease(name, resolve(dest))}`);
  } catch (e) {
    console.error(`pack-release: ${(e as Error).message}`);
    process.exit(1);
  }
}
