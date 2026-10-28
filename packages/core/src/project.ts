// プロジェクトの統合(Phase 6)。repository の記録が無いセッションを、git の origin・ホーム・一時フォルダで束ねる。
// git は .git/config(worktree は .git ファイル → gitdir → commondir)を読むだけで、git コマンドは使わない。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { projectKey } from './normalize.ts';
import { ATLAS_JUDGE_PROJECT, HOME_PROJECT, TEMP_PROJECT } from './project-keys.ts';
import type { ProjectSource, SessionRecord } from './types.ts';

export { ATLAS_JUDGE_PROJECT, GROUPED_PROJECTS, HOME_PROJECT, TEMP_PROJECT } from './project-keys.ts';

/** このツールの判定(judge)が copilot / opencode を起動する作業フォルダ(mkdtemp の atlas-judge-cwd-XXXXXX) */
const ATLAS_JUDGE_RE = /(?:^|[\\/])atlas-judge-cwd-[^\\/]+[\\/]*$/;
/** ホームディレクトリそのもの(Windows の <ドライブ>:\Users\<名前>、/home/<名前>、/Users/<名前>) */
const HOME_RE = /^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+)[\\/]*$/i;
/** 一時フォルダ(Windows の %TEMP% = ...\AppData\Local\Temp、/tmp、macOS の /var/folders/.../T) */
const TEMP_RE = /^(?:[A-Za-z]:[\\/].*?[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)|\/tmp(?:\/|$)|\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$))/i;

export interface ProjectResolverOptions {
  /** ホームディレクトリ(既定: os.homedir())。パターンに当てはまらない場所のときに足す */
  homes?: string[];
  /** 一時フォルダ(既定: os.tmpdir()) */
  temps?: string[];
  /**
   * 一時フォルダの既定のパターン(...\AppData\Local\Temp、/tmp、/var/folders/.../T)も使うか(既定 true)。
   * false なら temps に挙げたフォルダだけを一時フォルダとみなす(リポジトリ自体を一時フォルダ配下に置いて試すとき用。
   * CLI の --temp-dir はこれを false にして temps を差し替える)
   */
  tempPatterns?: boolean;
  /** .git/config を読むか(既定 true)。false なら git の origin は使わない */
  readGit?: boolean;
}

/** 比較用にパスをそろえる(区切りを /、末尾の区切りを落とし、Windows のパスは小文字) */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) || p.includes('\\') ? s.toLowerCase() : s;
}

function under(p: string, root: string): boolean {
  const a = norm(p);
  const r = norm(root);
  return r !== '' && (a === r || a.startsWith(`${r}/`));
}

/**
 * git の remote URL から owner/repo を得る。
 * https://host/owner/repo(.git)、git@host:owner/repo.git、ssh://git@host[:port]/owner/repo.git を受ける。
 * ローカルのパス(file:// や C:\…、../x)は null。
 */
export function ownerRepoFromUrl(url: string): string | null {
  const u = url.trim();
  let path: string | null = null;
  const scp = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(u);
  if (scp) path = scp[1];
  else {
    const m = /^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/i.exec(u);
    if (m) path = m[1];
  }
  if (!path) return null;
  const parts = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** .git/config の本文から [remote "origin"] の url を取り出す */
export function originUrlFromConfig(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([^\s\]]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (sec) {
      inOrigin = sec[1].toLowerCase() === 'remote' && sec[2] === 'origin';
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv) return kv[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/**
 * 作業フォルダ(git の作業ツリーの根)から、共有の config ファイルの場所を得る。
 * - <dir>/.git がディレクトリ → <dir>/.git/config
 * - <dir>/.git がファイル(worktree・submodule)→ gitdir: <path> → <gitdir>/commondir があればそこ、無ければ gitdir の config
 */
export function gitConfigPath(workTree: string): string | null {
  const dotGit = join(workTree, '.git');
  if (!existsSync(dotGit)) return null;
  const st = statSync(dotGit);
  if (st.isDirectory()) return join(dotGit, 'config');
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const gitdir = resolve(workTree, m[1]);
  const commondirFile = join(gitdir, 'commondir');
  const common = existsSync(commondirFile) ? resolve(gitdir, readFileSync(commondirFile, 'utf8').trim()) : gitdir;
  return join(common, 'config');
}

export interface ResolvedProject {
  project: string;
  source: ProjectSource;
}

/**
 * セッションのプロジェクトキーを決める。優先順:
 * 1. cwd が atlas-judge-cwd-*(このツール自身の判定実行)→ (atlas の判定)
 * 2. repository の記録 → そのまま
 * 3. cwd か gitRoot が一時フォルダ配下(scratchpad の試行など)→ (一時フォルダ)
 * 4. gitRoot(無ければ cwd から上へ探した作業ツリー。ホームと一時フォルダには上らない)の origin → owner/repo
 * 5. cwd がホームディレクトリそのもの → (ホーム)
 * 6. gitRoot か cwd のパス
 * .git が読めない・origin が無い・URL から owner/repo が取れないときはパスのまま(読めない理由は warnings に残す)。
 */
export class ProjectResolver {
  private readonly homes: string[];
  private readonly temps: string[];
  private readonly tempPatterns: boolean;
  private readonly readGit: boolean;
  private readonly cache = new Map<string, string | null>();
  readonly warnings: string[] = [];

  constructor(opts: ProjectResolverOptions = {}) {
    this.homes = (opts.homes ?? [homedir()]).filter(Boolean);
    this.temps = (opts.temps ?? [tmpdir()]).filter(Boolean);
    this.tempPatterns = opts.tempPatterns ?? true;
    this.readGit = opts.readGit ?? true;
  }

  isAtlasJudge(cwd: string | null): boolean {
    return !!cwd && ATLAS_JUDGE_RE.test(cwd);
  }

  isTemp(p: string | null): boolean {
    return !!p && ((this.tempPatterns && TEMP_RE.test(p)) || this.temps.some((t) => under(p, t)));
  }

  isHome(p: string | null): boolean {
    return !!p && (HOME_RE.test(p) || this.homes.some((h) => norm(p) === norm(h)));
  }

  /** 作業ツリーの根から origin の owner/repo(読めなければ null。結果は根ごとにキャッシュ) */
  remoteOf(workTree: string): string | null {
    const key = norm(workTree);
    if (this.cache.has(key)) return this.cache.get(key)!;
    let out: string | null = null;
    try {
      const cfg = gitConfigPath(workTree);
      if (cfg && existsSync(cfg)) {
        const url = originUrlFromConfig(readFileSync(cfg, 'utf8'));
        out = url ? ownerRepoFromUrl(url) : null;
      }
    } catch (e) {
      this.warnings.push(`${workTree}: git の設定を読めない (${(e as Error).message})`);
      out = null;
    }
    this.cache.set(key, out);
    return out;
  }

  /** cwd から上へ .git を探す(ホーム・一時フォルダ・ドライブの根には上らない) */
  private findWorkTree(cwd: string): string | null {
    let dir = cwd;
    for (let i = 0; i < 64; i++) {
      if (this.isHome(dir) || this.isTemp(dir)) return null;
      try {
        if (existsSync(join(dir, '.git'))) return dir;
      } catch {
        return null;
      }
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return null;
  }

  resolve(s: Pick<SessionRecord, 'repository' | 'gitRoot' | 'cwd'>): ResolvedProject {
    if (this.isAtlasJudge(s.cwd)) return { project: ATLAS_JUDGE_PROJECT, source: 'atlas-judge' };
    if (s.repository) return { project: s.repository, source: 'repository' };
    if (this.isTemp(s.cwd) || this.isTemp(s.gitRoot)) return { project: TEMP_PROJECT, source: 'temp' };
    if (this.readGit) {
      const root = s.gitRoot && isAbsolute(s.gitRoot) ? s.gitRoot : s.cwd && isAbsolute(s.cwd) ? this.findWorkTree(s.cwd) : null;
      const repo = root ? this.remoteOf(root) : null;
      if (repo) return { project: repo, source: 'git-remote' };
    }
    if (this.isHome(s.cwd) && (!s.gitRoot || this.isHome(s.gitRoot))) return { project: HOME_PROJECT, source: 'home' };
    const p = s.gitRoot ?? s.cwd;
    if (!p) return { project: projectKey(null, null, null), source: 'unknown' };
    return { project: projectKey(null, s.gitRoot, s.cwd), source: 'path' };
  }
}
