// atlas 自身の版を、このチェックアウトの git から読む(送るときに atlas-index.json・atlas-session.json へ添える)。
// 形と集計は atlas-version.ts(画面からも読むので node: に依存しない)。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codeStamp, PACKAGES_ROOT } from './code-stamp.ts';
import { COMMIT_RE, type AtlasBuild } from './atlas-version.ts';

const GIT_TIMEOUT_MS = 10_000;
/** npm が書き換えることのある、git が管理しているファイル(self-update.ts と同じ扱い) */
const LOCK_FILE = 'package-lock.json';

/** リポジトリ(packages/ の 1 つ上)で git を動かし、版を読む。例外は投げない */
export function readAtlasBuild(repo: string = dirname(PACKAGES_ROOT), code: string = codeStamp()): AtlasBuild {
  const none: AtlasBuild = { commit: null, committedAt: null, dirty: null, code };
  if (!existsSync(join(repo, '.git'))) return none;
  const git = (args: string[]): string | null => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    return r.error || r.status !== 0 ? null : (r.stdout ?? '');
  };
  // コミットと日時を 1 回で読む(%H = 全桁、%cI = コミットの日時)
  const [sha, at] = git(['log', '-1', '--format=%H %cI', 'HEAD'])?.trim().split(' ') ?? [];
  const commit = sha && COMMIT_RE.test(sha) ? sha : null;
  if (!commit) return none;
  const t = at ? Date.parse(at) : NaN;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const changed = status == null ? null : status.split(/\r?\n/).filter((l) => l.trim() && l.slice(3).trim() !== LOCK_FILE);
  return { commit, committedAt: Number.isFinite(t) ? new Date(t).toISOString() : null, dirty: changed == null ? null : changed.length > 0, code };
}

let cached: AtlasBuild | null = null;
/** このプロセスが動かしている atlas の版(最初に呼んだときのもの) */
export function currentAtlasBuild(): AtlasBuild {
  return (cached ??= readAtlasBuild());
}
