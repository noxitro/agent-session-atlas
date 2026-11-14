// 画面の TS の lib と、build が使う Rust の lib がずれていないかを、架空の fixture で確かめる(npm run parity:fixture。npm run ci の 1 つ)。
// fixture(.fixtures/。e2e と同じもの)を作り直し、atlas all で out/parity-fixture/ に集計してから、
// scripts/parity-lib.ts --compare で TS の lib と Rust の lib(crates/atlas-report/examples/libdump.rs)の結果を比べる。違いがあれば終了コード 1。
// atlas の実行ファイルは npm run atlas と同じ順で探す(ATLAS_CLI → bin/ → target/release → target/debug)。
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_DIR, writeFixtures } from './synthetic-fixtures.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const exe = [process.env.ATLAS_CLI, join(ROOT, 'bin', EXE), join(ROOT, 'target', 'release', EXE), join(ROOT, 'target', 'debug', EXE)].find((p): p is string => !!p && existsSync(p));
if (!exe) {
  console.error('parity-fixture: atlas の実行ファイルがありません(npm run build:report の後に cargo build --release -p atlas-cli)');
  process.exit(1);
}

await writeFixtures();
// 利用者の atlas.config.json が効かないよう、e2e と同じ fixture 用の設定を使う(e2e/global-setup.ts と同じ中身)
const config = join(FIXTURES_DIR, 'atlas.config.json');
writeFileSync(config, JSON.stringify({ wikis: [{ path: 'synthetic-wiki', pages: ['wiki'], skills: ['wiki-query'] }] }));
const out = join(ROOT, 'out', 'parity-fixture');
const notes = join(ROOT, 'out', 'parity-fixture-notes');
rmSync(out, { recursive: true, force: true });
const all = spawnSync(exe, ['all', '--home', join(FIXTURES_DIR, 'copilot-home'), '--out', out, '--notes-dir', notes, '--config', config], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
if (all.status !== 0) {
  console.error(`parity-fixture: atlas all が終了コード ${all.status} で失敗しました`);
  process.exit(1);
}
const cmp = spawnSync(process.execPath, [join(ROOT, 'scripts', 'parity-lib.ts'), out, '--compare', '--notes', notes, '--work', join(ROOT, 'out', 'parity-fixture-dump')], { cwd: ROOT, stdio: 'inherit' });
process.exit(cmp.status ?? 1);
