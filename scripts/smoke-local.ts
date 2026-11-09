#!/usr/bin/env node
// 配布物の動作確認を手元で回す(npm run smoke。CI の「配布物の動作確認」と同じ pack-release.ts → release-smoke.ts)。
// 置き場はリポジトリの外の一時フォルダ(CI は RUNNER_TEMP、手元は OS の一時フォルダの atlas-ci-pkg/。前回の残りは消してから作る)。
// リポジトリの中に作ると、配布物に入れ忘れた依存も上の階層の node_modules から読めてしまい、見逃すため。
// git archive HEAD なので、コミットしていない変更は入らない(入っていなければ注意を出す)。
// 先に npm run build:report が要る(npm run ci は順に回す)。
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(process.env.RUNNER_TEMP ?? tmpdir(), 'atlas-ci-pkg');
const NAME = 'agent-session-atlas-smoke';

try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) console.log('smoke: 注意: コミットしていない変更があります。配布物はコミット済みの内容(HEAD)だけで作るので、変更は確かめられません。');
} catch {
  /* git が無い(配布 zip を展開した先)なら何も言わない */
}
rmSync(BASE, { recursive: true, force: true });
for (const [script, args] of [
  ['pack-release.ts', [NAME, BASE]],
  ['release-smoke.ts', [join(BASE, NAME)]],
] as const) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
