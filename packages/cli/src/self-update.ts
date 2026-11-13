// 自動で送る前に、atlas 自身を新しい版にする(schedule-upload.bat で登録したタスクが、upload-auto.ts から呼ぶ)。
// 作業メンバーは定期の自動送信しか使わず、atlas.bat を開かないので、git pull しないままだと古い版で送り続けてしまうため。
//
// 新しい版にするのは、次をすべて満たすときだけ(手で触っているチェックアウトを壊さない):
//  - git で取得したフォルダ(.git がある)で、git が使える
//  - atlas の処理(画面のサーバ・集計など)が、このチェックアウトで動いていない(動いている処理のコードと依存を入れ替えないため)
//  - 今のブランチが、origin の既定のブランチ(origin/HEAD。分からなければ origin/main)を追っている
//  - git が管理しているファイルを手で変えていない(git status に出る変更が無い。git が管理していないファイルは見ない)。
//    ただし package-lock.json だけが変わっているときは、npm が書き換えたものとして元に戻してから進める
//    (npm install は、npm の版によって package-lock.json を書き直す。そのままだと、次の回から更新できなくなる)
//  - 早送り(fast-forward)だけで新しい版になる(手元にだけあるコミットがあれば、何もしない)
//  - 新しい版が、前にこの PC で動かなかった版(avoid)ではない
// 依存(package-lock.json)が変わっていれば npm ci で入れる(package-lock.json を書き換えない)。入れられなければ、前の版に戻して
// 前の版の依存を入れ直す(rollback)。どれかで止まっても、送ることは止めない(今の版のまま送る)。何をしたか・しなかった理由と、
// どうすれば新しい版になるかは、記録と結果に残す。
// 依存が欠けていても動くよう、ここで読むのは node: の標準モジュールだけにする
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AutoUpdateResult } from './upload-auto-files.ts';

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** コマンドを動かす口(テストでは偽物を渡せる)。動かせなかったときは code を -1 にして、理由を stderr に入れる */
export type CmdRunner = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => CmdResult;

export const runCmd: CmdRunner = (cmd, args, o) => {
  const r = spawnSync(cmd, args, {
    cwd: o.cwd,
    encoding: 'utf8',
    timeout: o.timeoutMs,
    windowsHide: true,
    // 窓が無いので、資格情報を尋ねられたら止まってしまう。尋ねずに失敗させる
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (r.error) return { code: -1, stdout: r.stdout ?? '', stderr: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `${Math.round(o.timeoutMs / 1000)} 秒で終わらなかった` : r.error.message };
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** 新しい版にしたときの結果(out/auto-upload.json の update にも残す) */
export type UpdateResult = AutoUpdateResult;

export interface UpdateOptions {
  /** リポジトリの直下 */
  repo: string;
  log: (line: string) => void;
  run?: CmdRunner;
  /** 依存が package-lock.json と揃っているか(既定は scripts/deps-fresh.mjs) */
  depsFresh?: () => boolean;
  /** 依存を入れる。入れられたら true(既定は npm ci) */
  installDeps?: () => boolean;
  /** このチェックアウトで atlas の処理が動いていれば、その説明(動いていれば更新しない) */
  busy?: () => string | null;
  /** 使わない版(前にこの PC で動かなかった版。コミットの全桁) */
  avoid?: string | null;
}

const FETCH_TIMEOUT_MS = 2 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 15 * 60_000;
/** npm が書き換えることのある、git が管理しているファイル(これだけが変わっているときは、元に戻してから進める) */
const LOCK_FILE = 'package-lock.json';

/** 失敗したコマンドの理由(エラー出力の最初の行) */
function reasonOf(r: CmdResult): string {
  return (
    r.stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 200) ?? `終了コード ${r.code}`
  );
}

const short = (sha: string | null): string | null => (sha ? sha.trim().slice(0, 7) : null);

/** 依存が揃っているかと、依存を入れる(npm ci)の既定 */
function depsOf(o: UpdateOptions): { fresh: () => boolean; install: () => boolean } {
  const run = o.run ?? runCmd;
  return {
    fresh: o.depsFresh ?? (() => run(process.execPath, [join(o.repo, 'scripts', 'deps-fresh.mjs'), o.repo], { cwd: o.repo, timeoutMs: GIT_TIMEOUT_MS }).code === 0),
    install:
      o.installDeps ??
      ((): boolean => {
        // npm ci は package-lock.json のとおりに入れ、書き換えない。Windows の npm は npm.cmd なので、cmd.exe から動かす
        // (Node.js は .cmd を shell なしで動かせない)
        const r =
          process.platform === 'win32'
            ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], { cwd: o.repo, timeoutMs: NPM_TIMEOUT_MS })
            : run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: o.repo, timeoutMs: NPM_TIMEOUT_MS });
        if (r.code !== 0) o.log(`atlas の更新: 依存を入れられませんでした(${reasonOf(r)})`);
        return r.code === 0;
      }),
  };
}

/**
 * 前の版(fromSha)に戻し、依存が前の版と揃っていなければ入れ直す。新しい版の依存を入れられなかったときと、
 * 新しい版がこの PC で動かなかったとき(upload-auto.ts)に使う。手で変えたファイルが無いことは確かめてあるので、--keep で戻せる
 */
export function rollback(o: UpdateOptions, fromSha: string): { ok: boolean; reverted: boolean; note: string } {
  const run = o.run ?? runCmd;
  const back = run('git', ['reset', '--keep', fromSha], { cwd: o.repo, timeoutMs: GIT_TIMEOUT_MS });
  if (back.code !== 0) return { ok: false, reverted: false, note: `前の版(${short(fromSha)})に戻せませんでした(${reasonOf(back)})。atlas.bat を開いて確かめてください` };
  o.log(`atlas の更新: 前の版(${short(fromSha)})に戻しました`);
  const deps = depsOf(o);
  if (deps.fresh()) return { ok: true, reverted: true, note: `前の版(${short(fromSha)})に戻しました` };
  o.log('atlas の更新: 前の版の依存を入れ直します');
  if (deps.install()) return { ok: true, reverted: true, note: `前の版(${short(fromSha)})に戻し、依存も入れ直しました` };
  return { ok: false, reverted: true, note: `前の版(${short(fromSha)})に戻しましたが、依存を入れ直せませんでした。atlas.bat を開くと入れ直します` };
}

/** atlas 自身を新しい版にする(できるときだけ)。例外は投げない */
export function selfUpdate(o: UpdateOptions): UpdateResult {
  const run = o.run ?? runCmd;
  const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS): CmdResult => run('git', args, { cwd: o.repo, timeoutMs });
  const done = (r: UpdateResult): UpdateResult => {
    o.log(`atlas の更新: ${r.note}`);
    return r;
  };
  const result = (outcome: UpdateResult['outcome'], fromSha: string | null, toSha: string | null, note: string): UpdateResult =>
    done({ outcome, from: short(fromSha), to: short(toSha), fromSha, toSha, note });
  if (!existsSync(join(o.repo, '.git'))) return result('skipped', null, null, 'git で取得したフォルダではないので、更新しません(git clone し直すと、自動で新しい版にできます)');
  const head = git(['rev-parse', 'HEAD']);
  if (head.code !== 0) return result('skipped', null, null, `git を使えないので、更新しません(${reasonOf(head)})`);
  const from = head.stdout.trim();
  const busy = o.busy?.() ?? null;
  if (busy) return result('skipped', from, null, `atlas が動いている(${busy})ので、今回は更新しません(次の回に新しい版にします)`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const main = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).stdout.trim() || 'origin/main';
  if (upstream.code !== 0 || upstream.stdout.trim() !== main)
    return result('skipped', from, null, `${main} を追っていないブランチ(${branch || '不明'})なので、更新しません(git switch ${main.replace(/^origin\//, '')} で戻すと、次の回から新しい版にします)`);
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return result('skipped', from, null, `git の状態を読めないので、更新しません(${reasonOf(status)})`);
  const changed = status.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
  if (changed.length && changed.every((f) => f === LOCK_FILE)) {
    // npm install が書き直した package-lock.json(ほかに変えたファイルは無い)。元に戻してから進める
    const restore = git(['checkout', '--', LOCK_FILE]);
    if (restore.code !== 0) return result('skipped', from, null, `npm が書き換えた ${LOCK_FILE} を元に戻せないので、更新しません(${reasonOf(restore)})`);
    o.log(`atlas の更新: npm が書き換えた ${LOCK_FILE} を元に戻しました`);
  } else if (changed.length) {
    return result('skipped', from, null, `atlas のファイルを手で変えているので、更新しません(git status で確かめ、元に戻すと、次の回から新しい版にします)`);
  }
  const fetch = git(['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
  if (fetch.code !== 0) return result('failed', from, null, `新しい版を取りに行けなかったので、今の版のまま送ります(${reasonOf(fetch)}。次の回にもう一度試します)`);
  const target = git(['rev-parse', '@{u}']);
  if (target.code !== 0) return result('failed', from, null, `新しい版を確かめられなかったので、今の版のまま送ります(${reasonOf(target)})`);
  const to = target.stdout.trim();
  if (to === from) return result('latest', from, from, `最新です(${short(from)})`);
  if (o.avoid && to === o.avoid) return result('skipped', from, null, `新しい版(${short(to)})は前にこの PC で動かなかったので、使いません(もっと新しい版が出たら、それにします)`);
  const merge = git(['merge', '--ff-only', '--quiet', to]);
  if (merge.code !== 0)
    return result('skipped', from, null, `早送りだけでは新しい版にできないので、更新しません(手元にだけあるコミットがあるなど。git log ${main}..HEAD で確かめられます。${reasonOf(merge)})`);
  o.log(`atlas の更新: 新しい版(${short(to)})を取り込みました`);
  const deps = depsOf(o);
  if (!deps.fresh()) {
    o.log('atlas の更新: 依存が変わったので、npm ci で入れます');
    if (!deps.install()) {
      // 新しい版を、その版の依存なしで動かさない
      const back = rollback(o, from);
      return result(
        'failed',
        from,
        back.reverted ? from : to,
        back.ok
          ? `新しい版(${short(to)})の依存を入れられなかったので、${back.note}。今の版のまま送ります(次の回にもう一度試します)`
          : `新しい版(${short(to)})の依存を入れられず、${back.note}`,
      );
    }
  }
  return result('updated', from, to, `${short(from)} から ${short(to)} に更新しました`);
}
