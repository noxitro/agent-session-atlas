// Git / Perforce / SVN を読むだけの共通口(vcs-retention.ts が使う)。
// - 呼ぶのは、読む系の副コマンドだけ(許可リスト。ほかは呼ぶ前に例外にする)。作業ツリー・索引・サーバの状態を変えない
//   - VCS を呼ぶところ(VcsRepo と detect)はすべて readOnlyRunner を通る。既定の runner も起動の前に確かめる(差し替えた runner でも止まる)
//   - git は --no-optional-locks と GIT_OPTIONAL_LOCKS=0 で、索引の書き戻しもさせない
// - 照合した時点のファイルは、ディスクから直接読む(fs の読み取りだけ)
// - 開始時の基準は、git ではログの headCommit を使う(記録)。無いとき・p4 と svn では、開始時刻から履歴をたどって推定する(推定と印を付ける)
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { filePathKey, relativeInside, resolveFilePath } from './classify.ts';

export type VcsKind = 'git' | 'p4' | 'svn';
export const VCS_KINDS: readonly VcsKind[] = ['git', 'svn', 'p4'];

export interface RunResult {
  /** 終了コード。コマンドが無い(未インストール)ときは -1 */
  code: number;
  stdout: string;
  stderr: string;
}
export type VcsRunner = (cmd: VcsKind, args: string[], opts: { cwd: string }) => Promise<RunResult>;

/** 許可する副コマンド(読むものだけ) */
const READ_ONLY: Record<VcsKind, ReadonlySet<string>> = {
  git: new Set(['rev-parse', 'cat-file', 'show', 'rev-list']),
  svn: new Set(['info', 'cat']),
  p4: new Set(['info', 'where', 'changes', 'print']),
};
/** 副コマンドの前に置いてよいもの(値を取るものは次の 1 語も読み飛ばす) */
const GLOBAL_FLAGS: Record<VcsKind, Record<string, number>> = {
  git: { '--no-optional-locks': 0, '-C': 1, '-c': 1 },
  svn: { '--non-interactive': 0 },
  p4: { '-d': 1, '-ztag': 0, '-q': 0 },
};
/** どこにあっても許さない引数(ファイルへの書き出し。p4 print -o はファイルに書き出す) */
const forbiddenArg = (cmd: VcsKind, a: string): boolean => /^--output(?:=|$)/.test(a) || (cmd === 'p4' && a.startsWith('-o'));

/** 読む系の副コマンドか確かめる。違えば例外 */
export function assertReadOnly(cmd: VcsKind, args: readonly string[]): void {
  let i = 0;
  while (i < args.length && Object.hasOwn(GLOBAL_FLAGS[cmd], args[i])) i += 1 + GLOBAL_FLAGS[cmd][args[i]];
  const sub = args[i];
  if (sub == null || !READ_ONLY[cmd].has(sub)) throw new Error(`読み取り専用でない ${cmd} の呼び出しを止めました: ${sub ?? '(副コマンドなし)'}`);
  if (cmd === 'git' && args.some((a, j) => j < i && a === '-c' && !/^core\.quotepath=/.test(args[j + 1] ?? ''))) throw new Error('git -c は core.quotepath だけ許します');
  const bad = args.find((a) => forbiddenArg(cmd, a));
  if (bad) throw new Error(`書き出しの引数を止めました: ${bad}`);
}

/**
 * VCS に渡す環境変数。メッセージは英語にそろえる(見つからないことを英語の文で見分けるため)が、文字の扱い(LC_CTYPE)は利用者のものを残す。
 * LC_ALL=C にすると、POSIX の svn が ASCII 以外のパスを UTF-8 に直せず、日本語のファイル名などを読めなくなる
 */
export function vcsEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { LC_ALL, ...rest } = base;
  const ctype = rest.LC_CTYPE ?? LC_ALL ?? rest.LANG;
  return { ...rest, ...(ctype ? { LC_CTYPE: ctype } : {}), LC_MESSAGES: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * 既定の実行(シェルを通さない。30 秒で打ち切る)。実際にプロセスを起動するので、readOnlyRunner を通らずに直接呼ばれても
 * 書く系のコマンドは起動しない(readOnlyRunner と二重に確かめる。止めたときは終了コード 1 と理由)
 */
export const defaultRunner: VcsRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    try {
      assertReadOnly(cmd, args);
    } catch (e) {
      return resolve({ code: 1, stdout: '', stderr: (e as Error).message });
    }
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: vcsEnv(),
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ code: -1, stdout: '', stderr: `${cmd} が見つかりません` });
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** 許可リストを通してから呼ぶ */
export function readOnlyRunner(runner: VcsRunner): VcsRunner {
  return (cmd, args, opts) => {
    assertReadOnly(cmd, args);
    return runner(cmd, args, opts);
  };
}

export interface Revision {
  rev: string;
  /** observed = ログに記録された版、estimated = 時刻から推定した版 */
  source: 'observed' | 'estimated';
}

/**
 * 照合で比べる版の見方。worktree = 照合した時点の作業ツリー、committed = 照合した時点で最後に取り込んだ版、
 * fixed = セッションの終わりから決まった日数後の時点で取り込まれていた版(照合した時期で値が変わらない。取り込んでいない変更は見えない)
 */
export type EvalMode = 'worktree' | 'committed' | 'fixed';
export const EVAL_MODES: readonly EvalMode[] = ['worktree', 'committed', 'fixed'];

export interface VcsRepo {
  kind: VcsKind;
  /** 作業ツリーの根(絶対パス。Windows は \ 区切り) */
  root: string;
  /** p4 のサーバの UTC からのずれ(分。p4 info の serverDate から)。わからなければ null(日時を UTC として渡す)。git・svn は null */
  p4OffsetMin: number | null;
  /** root の中なら root からの相対パス(/ 区切り)、外なら null */
  relative(absPath: string): string | null;
  /**
   * 開始時の基準。headCommit は git のときだけ使う(別のリポジトリの値は渡さない)。
   * 決められなければ null(理由は reason に)。調べるコマンドが失敗したら例外(版が無いと取り違えない)
   */
  baseline(hint: { headCommit: string | null; start: string | null; branch?: string | null }): Promise<{ revision: Revision | null; reason?: 'baseline_missing' }>;
  /**
   * 照合時の版の印(git: HEAD、svn: 作業コピーの版、p4: have の最新の変更番号)。
   * まだ版が無い(コミットの無いリポジトリなど)は null。それ以外の失敗は例外
   */
  currentRevision(): Promise<string | null>;
  /** 時刻 at の時点で取り込まれていた最後の版(git はブランチの履歴、無ければ HEAD)。無ければ null。調べるコマンドが失敗したら例外 */
  revisionAt(at: string, branch?: string | null): Promise<string | null>;
  /** 版 rev のファイル。その版に無ければ null。読めないときは例外 */
  readAt(rev: string, absPath: string): Promise<string | null>;
  /** 照合した時点のファイル。worktree = ディスク、committed = 最後に取り込んだ版(fixed は readAt で読む) */
  readAfter(mode: 'worktree' | 'committed', absPath: string): Promise<string | null>;
}

/** 本文を比べられる形にする(BOM を落とし、改行を LF に) */
export function decodeText(s: string): string {
  return (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, '\n');
}

function isWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

const relativeTo = relativeInside;

async function readDisk(absPath: string): Promise<string | null> {
  try {
    return decodeText(await readFile(absPath, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

class VcsReadError extends Error {}

function failed(cmd: VcsKind, args: string[], r: RunResult): never {
  throw new VcsReadError(`${cmd} ${args.find((a) => READ_ONLY[cmd].has(a)) ?? ''} に失敗しました(${r.code}): ${r.stderr.trim().split('\n')[0] ?? ''}`);
}

// 版を調べるコマンド(rev-list・rev-parse・cat-file -e、svn info -r、p4 changes)が「その版が無い」と答えたときの文。
// ファイルを読むときの *_MISSING より狭くする(No such file or directory などの環境の失敗を、版が無いと取り違えない)
const GIT_NO_REV = /unknown revision|bad revision|invalid object name|not a valid object name/i;
const SVN_NO_REV = /E200009|E160013|E195012|W160013|W170000/;
const P4_NO_REV = /no such file\(s\)|no file\(s\) at that|file\(s\) not on client|not in client view/i;

/** 版を調べたコマンドの結果。成功なら value(stdout)、版が無いと答えたなら null、それ以外の失敗は例外(版が無いと取り違えない) */
function revisionOf(cmd: VcsKind, args: string[], r: RunResult, noRev: RegExp, value: (stdout: string) => string | null): string | null {
  if (r.code === 0) return value(r.stdout);
  if (noRev.test(r.stderr)) return null;
  failed(cmd, args, r);
}

/** 空でなければ前後の空白を除いた stdout */
const nonempty = (out: string): string | null => out.trim() || null;

// ---- git ----

const GIT_MISSING = /does not exist|exists on disk, but not in|not in '|path .* does not exist|bad revision|invalid object name|unknown revision/i;

function gitRepo(root: string, run: VcsRunner): VcsRepo {
  const git = (...args: string[]) => run('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false', ...args], { cwd: root });
  const show = async (spec: string): Promise<string | null> => {
    const args = ['show', spec];
    const r = await git(...args);
    if (r.code === 0) return decodeText(r.stdout);
    if (GIT_MISSING.test(r.stderr)) return null;
    failed('git', args, r);
  };
  // 時刻 at までの最後のコミット。セッションのブランチの履歴で探す(今の HEAD が別のブランチでも取り違えない)。ブランチが無い・読めなければ HEAD。
  // ブランチ名はログの値なので、ref の名前として素直なものだけを refs/heads/ の下で使う(引数として読まれないように)
  const revisionAt = async (at: string, branch?: string | null): Promise<string | null> => {
    const refs = branch && /^[\w.\/-]+$/.test(branch) && !branch.startsWith('-') && !branch.includes('..') ? [`refs/heads/${branch}`, 'HEAD'] : ['HEAD'];
    // ブランチで見つからなければ(失敗しても)HEAD で探す。結果は最後に試した HEAD のもの(版が無いのではなく失敗したなら例外)
    let last: { rev: string | null } | { error: unknown } = { rev: null };
    for (const ref of refs) {
      const args = ['rev-list', '-1', `--before=${at}`, ref];
      const r = await git(...args);
      try {
        const rev = revisionOf('git', args, r, GIT_NO_REV, nonempty);
        if (rev) return rev;
        last = { rev };
      } catch (error) {
        last = { error };
      }
    }
    if ('error' in last) throw last.error;
    return last.rev;
  };
  return {
    kind: 'git',
    root,
    p4OffsetMin: null,
    relative: (p) => relativeTo(root, p),
    async baseline({ headCommit, start, branch }) {
      if (headCommit) {
        const args = ['cat-file', '-e', `${headCommit}^{commit}`];
        // ログに記録された版がもう無い(履歴の書き換え・別の複製)なら、推定で置き換えない。
        // 調べるコマンドの失敗(打ち切り・読めないリポジトリなど)は例外(版が無いと取り違えない)
        const rev = revisionOf('git', args, await git(...args), GIT_NO_REV, () => headCommit);
        return rev ? { revision: { rev, source: 'observed' } } : { revision: null, reason: 'baseline_missing' };
      }
      if (!start) return { revision: null, reason: 'baseline_missing' };
      const rev = await revisionAt(start, branch);
      return rev ? { revision: { rev, source: 'estimated' } } : { revision: null, reason: 'baseline_missing' };
    },
    async currentRevision() {
      const args = ['rev-parse', 'HEAD'];
      return revisionOf('git', args, await git(...args), GIT_NO_REV, nonempty);
    },
    revisionAt: (at, branch) => revisionAt(at, branch),
    async readAt(rev, absPath) {
      const rel = relativeTo(root, absPath);
      if (rel == null) throw new VcsReadError('リポジトリの外のファイルです');
      return show(`${rev}:${rel}`);
    },
    async readAfter(mode, absPath) {
      if (mode === 'worktree') return readDisk(absPath);
      const rel = relativeTo(root, absPath);
      if (rel == null) throw new VcsReadError('リポジトリの外のファイルです');
      return show(`HEAD:${rel}`);
    },
  };
}

// ---- svn ----

const SVN_MISSING = /E200009|E160013|E195012|W160013|E155010|path not found|is not under version control|was not found|no such file/i;

/** svn の日付指定({2026-11-12T01:02:03Z}) */
function svnDate(iso: string): string {
  return `{${new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z')}}`;
}

function svnRepo(root: string, run: VcsRunner): VcsRepo {
  const svn = (...args: string[]) => run('svn', ['--non-interactive', ...args], { cwd: root });
  const cat = async (rev: string, absPath: string): Promise<string | null> => {
    // 末尾の @ は空の peg 版(既定)。付けないと、名前に @ を含むファイル(icon@2x.png など)の @ 以降を版の指定として読む
    const args = ['cat', '-r', rev, `${absPath}@`];
    const r = await svn(...args);
    if (r.code === 0) return decodeText(r.stdout);
    if (SVN_MISSING.test(r.stderr)) return null;
    failed('svn', args, r);
  };
  const revisionAt = async (at: string): Promise<string | null> => {
    const args = ['info', '--show-item', 'revision', '-r', svnDate(at), root];
    return revisionOf('svn', args, await svn(...args), SVN_NO_REV, (out) => (/^\d+$/.test(out.trim()) ? out.trim() : null));
  };
  return {
    kind: 'svn',
    root,
    p4OffsetMin: null,
    relative: (p) => relativeTo(root, p),
    async baseline({ start }) {
      // ログに svn の版は残らないので、開始時刻の版を推定する
      if (!start) return { revision: null, reason: 'baseline_missing' };
      const rev = await revisionAt(start);
      return rev ? { revision: { rev, source: 'estimated' } } : { revision: null, reason: 'baseline_missing' };
    },
    async currentRevision() {
      const args = ['info', '--show-item', 'revision', root];
      return revisionOf('svn', args, await svn(...args), SVN_NO_REV, nonempty);
    },
    revisionAt: (at) => revisionAt(at),
    async readAt(rev, absPath) {
      if (relativeTo(root, absPath) == null) throw new VcsReadError('作業コピーの外のファイルです');
      return cat(rev, absPath);
    },
    async readAfter(mode, absPath) {
      if (mode === 'worktree') return readDisk(absPath);
      return cat('BASE', absPath);
    },
  };
}

// ---- Perforce ----

const P4_MISSING = /no such file|no file\(s\) at that|file\(s\) not on client|not in client view|- delete change/i;

/** p4 -ztag info の serverDate(... serverDate 2026/11/12 10:02:03 +0900 JST)のずれ */
const P4_SERVER_DATE = /^\.\.\. serverDate [0-9/]+ [0-9:]+ ([+-])([0-9]{2})([0-9]{2})/m;

/** p4 のサーバの UTC からのずれ(分)。serverDate が無い・読めなければ null */
export function p4ServerOffset(info: string): number | null {
  const m = P4_SERVER_DATE.exec(info);
  if (!m) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  const off = h * 60 + mi;
  return m[1] === '-' ? -off : off;
}

/**
 * p4 の日時指定(@2026/11/12:01:02:03)。p4 はサーバの地方時で解釈するので、サーバの UTC からのずれ(分)で直す。
 * 読めない時刻は NaN のまま
 */
function p4Date(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `@${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** p4 -ztag changes の出力の (変更番号, 取り込んだ時刻(UTC の秒)) */
function p4ZtagChanges(out: string): { change: number; time: number | null }[] {
  const v: { change: number; time: number | null }[] = [];
  const after = (line: string, prefix: string): string | null => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : null);
  for (const line of out.split(/\r?\n/)) {
    const c = after(line, '... change ');
    const t = after(line, '... time ');
    if (c != null && /^\+?\d+$/.test(c)) v.push({ change: Number(c), time: null });
    else if (t != null && /^[+-]?\d+$/.test(t) && v.length) v[v.length - 1].time ??= Number(t);
  }
  return v;
}

/** サーバの時差が夏時間で変わっても版を取り違えないよう、前後に見る幅 */
const P4_DATE_SLACK_MS = 60 * 60 * 1000;

/** p4 のファイル指定で特別な意味を持つ文字(@ # % *)を逃がす(% を先に) */
export function p4Escape(path: string): string {
  return path.replace(/%/g, '%25').replace(/@/g, '%40').replace(/#/g, '%23').replace(/\*/g, '%2A');
}

function p4Repo(root: string, run: VcsRunner, offsetMin: number | null): VcsRepo {
  const p4 = (...args: string[]) => run('p4', ['-d', root, ...args], { cwd: root });
  const tree = `${p4Escape(root)}${isWin(root) ? '\\' : '/'}...`;
  const print = async (spec: string): Promise<string | null> => {
    const args = ['-q', 'print', spec];
    const r = await p4('-q', 'print', spec);
    if (r.code === 0 && !P4_MISSING.test(r.stderr)) return decodeText(r.stdout);
    // 本文に同じ語があっても取り違えないよう、stdout はエラーのときだけ見る
    if (P4_MISSING.test(r.stderr) || (r.code !== 0 && P4_MISSING.test(r.stdout))) return null;
    failed('p4', args, r);
  };
  /** spec に当てはまる最後の変更。当てはまる変更が無いだけなら null */
  const lastChange = async (spec: string): Promise<string | null> => {
    const args = ['changes', '-m1', '-s', 'submitted', spec];
    return revisionOf('p4', args, await p4(...args), P4_NO_REV, (out) => /^Change (\d+) /m.exec(out)?.[1] ?? null);
  };
  /**
   * 時刻 t(ミリ秒)までに取り込まれた最後の変更。p4 の日時はサーバの地方時で、今の時差で直しても、夏時間をまたぐ過去の日時は
   * 1 時間ずれうる。そこで前後 1 時間の変更を、取り込んだ時刻(UTC)で確かめる。窓に t 以前の変更が無ければ、窓の前の最後の変更
   */
  const changeAt = async (t: number, off: number): Promise<string | null> => {
    const args = ['-ztag', 'changes', '-s', 'submitted', `${tree}${p4Date(t - P4_DATE_SLACK_MS, off)},${p4Date(t + P4_DATE_SLACK_MS, off)}`];
    // 取り込んだ時刻を読めない変更があれば確かめられないので、時差だけで決めた日時で探す(推定。夏時間のずれは補えない)
    let timeless = false;
    const found = revisionOf('p4', args, await p4(...args), P4_NO_REV, (out) => {
      const changes = p4ZtagChanges(out);
      timeless = changes.some((c) => c.time == null);
      const before = changes.filter((c) => c.time != null && c.time * 1000 <= t).map((c) => c.change);
      return before.length ? String(Math.max(...before)) : null;
    });
    if (timeless) return lastChange(`${tree}${p4Date(t, off)}`);
    return found ?? lastChange(`${tree}${p4Date(t - P4_DATE_SLACK_MS, off)}`);
  };
  // サーバの時差がわかれば、取り込んだ時刻で確かめる。わからなければ UTC のまま渡す(推定)
  const revisionAt = (at: string): Promise<string | null> => {
    const t = Date.parse(at);
    return offsetMin != null && !Number.isNaN(t) ? changeAt(t, offsetMin) : lastChange(`${tree}${p4Date(t, offsetMin ?? 0)}`);
  };
  return {
    kind: 'p4',
    root,
    p4OffsetMin: offsetMin,
    relative: (p) => relativeTo(root, p),
    async baseline({ start }) {
      if (!start) return { revision: null, reason: 'baseline_missing' };
      const rev = await revisionAt(start);
      return rev ? { revision: { rev, source: 'estimated' } } : { revision: null, reason: 'baseline_missing' };
    },
    async currentRevision() {
      return lastChange(`${tree}#have`);
    },
    revisionAt: (at) => revisionAt(at),
    async readAt(rev, absPath) {
      if (relativeTo(root, absPath) == null) throw new VcsReadError('クライアントの外のファイルです');
      return print(`${p4Escape(absPath)}@${rev}`);
    },
    async readAfter(mode, absPath) {
      if (mode === 'worktree') return readDisk(absPath);
      return print(`${p4Escape(absPath)}#have`);
    },
  };
}

// ---- 見つける ----

export type OpenRepoResult = { repo: VcsRepo } | { repo: null; reason: 'repo_not_found' | 'no_vcs' };

/** いちばん近い、ディスクにあるフォルダ(ファイルが消えていても、その上のフォルダで VCS を探すため) */
export function nearestExistingDir(p: string): string | null {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(cur) && statSync(cur).isDirectory()) return cur;
    } catch {
      // 読めないものは上へ
    }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * dir を含む作業ツリーを探す(git → svn → p4 の順)。dir がディスクに無ければ repo_not_found。
 * 結果は cache に dir ごとに残す
 */
export async function openRepo(dir: string, runner: VcsRunner = defaultRunner, cache: Map<string, Promise<OpenRepoResult>> = new Map()): Promise<OpenRepoResult> {
  const key = filePathKey(resolveFilePath(dir, null));
  let p = cache.get(key);
  if (!p) cache.set(key, (p = detect(dir, readOnlyRunner(runner))));
  return p;
}

async function detect(dir: string, run: VcsRunner): Promise<OpenRepoResult> {
  if (!existsSync(dir)) return { repo: null, reason: 'repo_not_found' };
  const g = await run('git', ['--no-optional-locks', '-C', dir, 'rev-parse', '--show-toplevel'], { cwd: dir });
  if (g.code === 0 && g.stdout.trim()) return { repo: gitRepo(resolveFilePath(g.stdout.trim(), null), run) };
  const s = await run('svn', ['--non-interactive', 'info', '--show-item', 'wc-root', dir], { cwd: dir });
  if (s.code === 0 && s.stdout.trim()) return { repo: svnRepo(resolveFilePath(s.stdout.trim(), null), run) };
  const p = await run('p4', ['-d', dir, '-ztag', 'info'], { cwd: dir });
  if (p.code === 0) {
    const root = /^\.\.\. clientRoot (.+)$/m.exec(p.stdout)?.[1]?.trim();
    const client = /^\.\.\. clientName (.+)$/m.exec(p.stdout)?.[1]?.trim();
    if (root && client && client !== '*unknown*' && (relativeTo(root, dir) != null || filePathKey(resolveFilePath(root, null)) === filePathKey(resolveFilePath(dir, null)))) {
      return { repo: p4Repo(resolveFilePath(root, null), run, p4ServerOffset(p.stdout)) };
    }
  }
  return { repo: null, reason: 'no_vcs' };
}

export { VcsReadError };
