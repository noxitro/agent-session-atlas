// node_modules が package-lock.json と揃っているかを調べる(*.bat が npm install するかの判定に使う)。
// 揃っていれば 0、足りない・版が違えば 1 で終わる。node: の標準モジュールだけを使う(依存が欠けていても動く)。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
const lockPath = join(root, 'package-lock.json');
const installedPath = join(root, 'node_modules', '.package-lock.json');

function fresh() {
  if (!existsSync(lockPath) || !existsSync(installedPath)) return false;
  const want = JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {};
  const have = JSON.parse(readFileSync(installedPath, 'utf8')).packages ?? {};
  return Object.entries(want).every(([path, p]) => !path.startsWith('node_modules/') || p.link || p.optional || p.devOptional || p.peer || have[path]?.version === p.version);
}

process.exit(fresh() ? 0 : 1);
