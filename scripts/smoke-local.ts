#!/usr/bin/env node
// clone した直後と同じ中身での動作確認を手元で回す(npm run smoke。CI の「clone した状態での動作確認」と同じ fresh-checkout.ts → checkout-smoke.ts)。
// 置き場はリポジトリの外の一時フォルダ(CI は RUNNER_TEMP、手元は OS の一時フォルダの atlas-ci-pkg-XXXXXX/。回すたびに別の名前で、通ったら消す)。
// リポジトリの中に作ると、package.json に入れ忘れた依存も上の階層の node_modules から読めてしまい、見逃すため。
// git archive HEAD なので、コミットしていない変更は入らない(あれば注意を出す)。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 回すたびに別の名前(同じ PC で 2 つ同時に回しても、互いの配布物を消さない)。通ったら消し、落ちたら中を見られるよう残す
const BASE = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'atlas-ci-pkg-'));
const NAME = 'agent-session-atlas-smoke';

try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) console.log('smoke: 注意: コミットしていない変更があります。確かめるのはコミット済みの内容(HEAD)だけです。');
} catch {
  /* git が無い(配布 zip を展開した先)なら何も言わない */
}
for (const [script, args] of [
  ['fresh-checkout.ts', [NAME, BASE]],
  ['checkout-smoke.ts', [join(BASE, NAME)]],
] as const) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.log(`smoke: 確かめたフォルダは ${BASE} に残しました`);
    process.exit(r.status ?? 1);
  }
}
rmSync(BASE, { recursive: true, force: true });
