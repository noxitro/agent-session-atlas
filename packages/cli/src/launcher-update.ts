// 起動用の .bat(atlas.bat・open-folder.bat・schedule-upload.bat・setup.bat・upload-project.bat)が開くたびに、最初に動かす自動の更新。
// マージした変更が、git pull しなくても利用者に届くように、自動で送るタスクと同じ確かめ(self-update.ts の selfUpdate)をして、
// できるときだけ新しい版にする(git の早送り。依存が変わっていれば npm ci。入れられなければ前の版に戻す)。
//
// - 出すのは、したこと・しなかった理由の 1 行だけ(最新なら何も出さない)
// - git fetch は 20 秒まで(つながらない環境で、開くたびに長く待たせない)
// - atlas がこのチェックアウトで動いていれば更新しない(自動で送るタスクと同じ判定。動いている処理のコードと依存を入れ替えないため)
// - 前にこの PC で動かなかった版(自動で送るタスクが覚えたもの)は使わない
// - 出力先は ATLAS_OUT、無ければ <リポジトリ>/out(自動で送るタスクと同じ)
// - 終了コード: コミットが変わったら 10。それ以外(最新・しなかった・失敗した)はいつも 0(開くのを止めない)。
//   git が .bat を書き換えたかもしれないので、.bat は 10 なら 1 行の中で自分を最初から動かし直す
//   (cmd は .bat を、読んだところまでの位置で読み進めるので、書き換えた後の行を、ずれた位置から読まないように)
// - 環境変数 ATLAS_NO_AUTO_UPDATE=1 なら何もしない(.bat も呼ばないが、手で動かしたときのため)
//
// 依存が欠けていても(npm install の前など)動くよう、読むのは node: の標準モジュールと self-update.ts・upload-auto-files.ts だけにする
// (main.ts は読まない)。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd, selfUpdate, type CmdRunner, type UpdateOptions } from './self-update.ts';
import { atlasRunning, autoOutDir, readAvoid } from './upload-auto-files.ts';

/** コミットが変わったときの終了コード(起動用の .bat は、自分を動かし直す) */
export const UPDATED_EXIT = 10;
/** 1 なら、起動用の .bat を開いたときに更新しない */
export const NO_AUTO_UPDATE_ENV = 'ATLAS_NO_AUTO_UPDATE';
/** 起動用の .bat から開いたときの git fetch の長さ */
export const LAUNCHER_FETCH_TIMEOUT_MS = 20_000;
/** 新しい版にできなかったときの続け方(結果の文に入れる) */
export const CARRY_ON_OPEN = '今の版のまま開きます';

const GIT_TIMEOUT_MS = 60_000;

/** リポジトリの直下 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 終了コード: コミットが変わったら UPDATED_EXIT、それ以外はいつも 0 */
export function exitCode(fromSha: string | null | undefined, headAfter: string | null | undefined): number {
  return fromSha && headAfter && fromSha !== headAfter ? UPDATED_EXIT : 0;
}

export interface LauncherUpdateOptions {
  /** リポジトリの直下 */
  repo: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  run?: CmdRunner;
  /** 依存の確かめと入れ方(テストでは偽物を渡す。既定は self-update.ts の deps-fresh.mjs と npm ci) */
  depsFresh?: UpdateOptions['depsFresh'];
  installDeps?: UpdateOptions['installDeps'];
}

/** 開くたびの更新をして、終了コードを返す。例外は投げない(何があっても開くのを止めない) */
export function launcherUpdate(o: LauncherUpdateOptions): number {
  if (o.env[NO_AUTO_UPDATE_ENV] === '1') return 0;
  try {
    const run = o.run ?? runCmd;
    const outDir = autoOutDir(o.repo, o.env);
    const r = selfUpdate({
      repo: o.repo,
      log: o.log,
      run,
      depsFresh: o.depsFresh,
      installDeps: o.installDeps,
      busy: () => atlasRunning(outDir),
      avoid: readAvoid(outDir),
      carryOn: CARRY_ON_OPEN,
      quietLatest: true,
      fetchTimeoutMs: LAUNCHER_FETCH_TIMEOUT_MS,
    });
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: o.repo, timeoutMs: GIT_TIMEOUT_MS });
    return exitCode(r.fromSha, head.code === 0 ? head.stdout.trim() : null);
  } catch (e) {
    o.log(`atlas の更新: 確かめられなかったので、${CARRY_ON_OPEN}(${(e as Error).message.replace(/\s+/g, ' ').trim()})`);
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = launcherUpdate({ repo: REPO_ROOT, env: process.env, log: (line) => process.stdout.write(`${line}\n`) });
}
