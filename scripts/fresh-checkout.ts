// clone した直後と同じ中身のフォルダを作る: ソース一式(git archive HEAD)だけ。ビルド済みのレポートテンプレートと実行ファイルは入れない
// (リリースが無いときの利用者と同じく、起動用の .bat が最初に動かす scripts/ensure-atlas.ps1 が作る)。CI と npm run smoke は、これを scripts/checkout-smoke.ts で動かして確かめる。
// 使い方: node scripts/fresh-checkout.ts <名前> <出力先>(<出力先>/<名前> ができる)
// git archive なので .gitattributes の eol(*.bat は CRLF)が効き、コミットしていない変更は入らない。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function waitExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((ok, ng) => {
    child.on('error', ng);
    child.on('close', (code) => (code === 0 ? ok() : ng(new Error(`${label} が終了コード ${code} で失敗しました`))));
  });
}

export async function freshCheckout(name: string, dest: string): Promise<string> {
  const dir = join(dest, name);
  if (existsSync(dir)) throw new Error(`${dir} はすでにあります(前回の残りを混ぜないため、消してから実行してください)`);
  mkdirSync(dest, { recursive: true });
  // core.autocrlf=true の環境(Windows の Git の既定)だと全ファイルが CRLF になり、Linux で clone した中身と変わるので切る
  const git = spawn('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--prefix=${name}/`, 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const tar = spawn('tar', ['-x', '-f', '-'], { cwd: dest, stdio: ['pipe', 'inherit', 'inherit'] });
  git.stdout.pipe(tar.stdin);
  await Promise.all([waitExit(git, 'git archive'), waitExit(tar, 'tar')]);
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [name, dest] = process.argv.slice(2);
  if (!name || !dest) {
    console.error('使い方: node scripts/fresh-checkout.ts <名前> <出力先>');
    process.exit(2);
  }
  try {
    console.log(`clone した直後と同じ中身のフォルダを作りました: ${await freshCheckout(name, resolve(dest))}`);
  } catch (e) {
    console.error(`fresh-checkout: ${(e as Error).message}`);
    process.exit(1);
  }
}
