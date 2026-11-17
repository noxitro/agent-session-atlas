// npm run atlas -- <コマンド> [オプション] の入口: atlas の実行ファイルを同じ引数で動かし、その終了コードで終わる(開発用)。
// 探す順は e2e と同じ: 環境変数 ATLAS_CLI → bin/atlas(.exe)(起動用の .bat が使うもの)→ target/release → target/debug。
// どれも無ければ、作り方を出して止まる(npm run build:report の後に cargo build --release -p atlas-cli)。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const candidates = [process.env.ATLAS_CLI, join(ROOT, 'bin', EXE), join(ROOT, 'target', 'release', EXE), join(ROOT, 'target', 'debug', EXE)].filter((p): p is string => !!p);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error(`atlas の実行ファイルがありません(探した場所: ${candidates.join('、')})。npm run build:report の後に cargo build --release -p atlas-cli を実行するか、atlas.bat を一度開いてください`);
  process.exit(1);
}
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' });
if (r.error) {
  console.error(`${exe} を動かせません: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
