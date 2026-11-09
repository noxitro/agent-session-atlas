#!/usr/bin/env node
// 配布物の動作確認を手元で回す(npm run smoke。CI の「配布物の動作確認」と同じ pack-release.ts → release-smoke.ts)。
// 置き場は out/ci-pkg/(前回の残りは消してから作る)。git archive HEAD なので、コミットしていない変更は入らない(入っていなければ注意を出す)。
// 先に npm run build:report が要る(npm run ci は順に回す)。
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'out', 'ci-pkg');
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
