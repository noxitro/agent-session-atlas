// 互換の入口: TS 版の schedule-upload.bat で登録した自動送信のタスクは `node packages\cli\src\upload-auto.ts [--no-update]` を動かす。
// TS 版のサーバー側は Rust の実行ファイル(bin\atlas.exe)に置き換えたので、ここでは bin\atlas.exe を用意して(scripts\ensure-atlas.ps1)
// `bin\atlas.exe upload-auto` を同じ引数で動かし、その終了コードで終わるだけにする。
// 依存を読み込まない(npm install していなくても Node だけで動く)。型の注記は Node が読むときに外す。
// schedule-upload.bat を開くと、タスクは bin\atlas.exe を直接動かす形に登録し直される(crates/atlas-cli/src/upload_schedule.rs)。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WINDOWS: boolean = process.platform === 'win32';
const EXE: string = join(ROOT, 'bin', WINDOWS ? 'atlas.exe' : 'atlas');

console.log('このタスクは前の版(Node.js で動かす版)で登録したものです。schedule-upload.bat を開くと、atlas.exe で動くように登録し直します。');
const ensure = spawnSync(WINDOWS ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'ensure-atlas.ps1')], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (ensure.status !== 0 || !existsSync(EXE)) {
  console.error('atlas.exe を用意できませんでした。atlas.bat を開いて確かめてください。');
  process.exit(1);
}
// ATLAS_TS_TASK: atlas が記録(out\auto-upload.log)に、登録し直すよう書き添える
const r = spawnSync(EXE, ['upload-auto', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', windowsHide: true, env: { ...process.env, ATLAS_TS_TASK: '1' } });
process.exit(r.status ?? 1);
