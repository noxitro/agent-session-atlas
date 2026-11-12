// 自動で送る前に、atlas 自身を新しい版にする(schedule-upload.bat で登録したタスクが、upload-auto.ts から呼ぶ)。
// 作業メンバーは定期の自動送信しか使わず、atlas.bat を開かないので、git pull しないままだと古い版で送り続けてしまうため。
//
// 新しい版にするのは、次をすべて満たすときだけ(手で触っているチェックアウトを壊さない):
//  - git で取得したフォルダ(.git がある)で、git が使える
//  - 今のブランチが、origin の既定のブランチ(origin/HEAD。分からなければ origin/main)を追っている
//  - git が管理しているファイルを手で変えていない(git status に出る変更が無い。git が管理していないファイルは見ない)
//  - 早送り(fast-forward)だけで新しい版になる(手元にだけあるコミットがあれば、何もしない)
// 依存(package-lock.json)が変わっていれば npm install する。npm install に失敗したら、前の版に戻す(git reset --keep)。
// どれかで止まっても、送ることは止めない(今の版のまま送る)。何をしたか・しなかった理由は、記録と結果に残す。
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
  /** 依存を入れる。入れられたら true(既定は npm install) */
  installDeps?: () => boolean;
}

const FETCH_TIMEOUT_MS = 2 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 15 * 60_000;

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

/** atlas 自身を新しい版にする(できるときだけ)。例外は投げない */
export function selfUpdate(o: UpdateOptions): UpdateResult {
  const run = o.run ?? runCmd;
  const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS): CmdResult => run('git', args, { cwd: o.repo, timeoutMs });
  const done = (r: UpdateResult): UpdateResult => {
    o.log(`atlas の更新: ${r.note}`);
    return r;
  };
  const short = (sha: string): string => sha.trim().slice(0, 7);
  if (!existsSync(join(o.repo, '.git'))) return done({ outcome: 'skipped', from: null, to: null, note: 'git で取得したフォルダではないので、更新しません' });
  const head = git(['rev-parse', 'HEAD']);
  if (head.code !== 0) return done({ outcome: 'skipped', from: null, to: null, note: `git を使えないので、更新しません(${reasonOf(head)})` });
  const from = head.stdout.trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const main = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).stdout.trim() || 'origin/main';
  if (upstream.code !== 0 || upstream.stdout.trim() !== main)
    return done({ outcome: 'skipped', from: short(from), to: null, note: `${main} を追っていないブランチ(${branch || '不明'})なので、更新しません` });
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return done({ outcome: 'skipped', from: short(from), to: null, note: `git の状態を読めないので、更新しません(${reasonOf(status)})` });
  if (status.stdout.trim()) return done({ outcome: 'skipped', from: short(from), to: null, note: 'atlas のファイルを手で変えているので、更新しません(git status で確かめられます)' });
  const fetch = git(['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
  if (fetch.code !== 0) return done({ outcome: 'failed', from: short(from), to: null, note: `新しい版を取りに行けなかったので、今の版のまま送ります(${reasonOf(fetch)})` });
  const ahead = git(['rev-list', '--count', 'HEAD..@{u}']);
  if (ahead.code === 0 && ahead.stdout.trim() === '0') return done({ outcome: 'latest', from: short(from), to: short(from), note: `最新です(${short(from)})` });
  const merge = git(['merge', '--ff-only', '--quiet', '@{u}']);
  if (merge.code !== 0) return done({ outcome: 'skipped', from: short(from), to: null, note: `早送りだけでは新しい版にできないので、更新しません(手元にだけあるコミットがあるなど。${reasonOf(merge)})` });
  const to = git(['rev-parse', 'HEAD']).stdout.trim() || from;
  o.log(`atlas の更新: 新しい版(${short(to)})を取り込みました`);
  const fresh = o.depsFresh ?? (() => run(process.execPath, [join(o.repo, 'scripts', 'deps-fresh.mjs'), o.repo], { cwd: o.repo, timeoutMs: GIT_TIMEOUT_MS }).code === 0);
  if (!fresh()) {
    o.log('atlas の更新: 依存が変わったので、npm install を実行します');
    const install =
      o.installDeps ??
      ((): boolean => {
        // Windows の npm は npm.cmd なので、cmd.exe から動かす(Node.js は .cmd を shell なしで動かせない)
        const r =
          process.platform === 'win32'
            ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm install --no-audit --no-fund'], { cwd: o.repo, timeoutMs: NPM_TIMEOUT_MS })
            : run('npm', ['install', '--no-audit', '--no-fund'], { cwd: o.repo, timeoutMs: NPM_TIMEOUT_MS });
        if (r.code !== 0) o.log(`atlas の更新: npm install に失敗しました(${reasonOf(r)})`);
        return r.code === 0;
      });
    if (!install()) {
      // 新しい版を、その版の依存なしで動かさない。手で変えたファイルは無いことを確かめてあるので、--keep で戻せる
      const back = git(['reset', '--keep', from]);
      const note =
        back.code === 0
          ? `新しい版(${short(to)})の依存を入れられなかったので、前の版(${short(from)})に戻して送ります。atlas.bat を開くと、依存を入れ直します`
          : `新しい版(${short(to)})の依存を入れられず、前の版にも戻せませんでした(${reasonOf(back)})。atlas.bat を開いて、依存を入れ直してください`;
      return done({ outcome: 'failed', from: short(from), to: back.code === 0 ? short(from) : short(to), note });
    }
  }
  return done({ outcome: 'updated', from: short(from), to: short(to), note: `${short(from)} から ${short(to)} に更新しました` });
}
