// 共有用の伏せ字(--anonymize)。プロジェクト・パス・リポジトリ名・ブランチを決定的な仮名に置き換える。
// 仮名はキーの辞書順で振るので、同じ入力からは常に同じ仮名になる。
// 伏せ字モードでは、依頼本文・セッション名・指示ファイルの見出しなどの自由記述は出さない
// (本文中にどんな固有名が含まれるかを機械的に保証できないため)。
// まとめたプロジェクト((ホーム)・(一時フォルダ)・(atlas の判定))は固有名を含まないので、そのまま出す。
import { GROUPED_PROJECTS } from '../../../core/src/project-keys.ts';

export interface AnonSource {
  project: string;
  cwd: string | null;
  gitRoot: string | null;
  repository: string | null;
  branch: string | null;
}

export interface Anonymizer {
  readonly enabled: boolean;
  project(key: string): string;
  projectLabel(key: string): string;
  branch(b: string | null): string | null;
  /** 自由記述。伏せ字モードでは null(表示しない) */
  freeText(s: string | null): string | null;
  /** エラー文やツール名など、短い機械的な文字列。伏せ字モードでは既知の固有名とパスを置き換える */
  scrub(s: string): string;
  /** ファイルパス。伏せ字モードでは null */
  path(p: string | null): string | null;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** パスらしい文字列(Windows のドライブ付き、UNC、/Users /home 以下) */
const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*|\/(?:Users|home|mnt|tmp|var|opt)\/[^\s"'<>|]*/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 表示用のプロジェクト名(伏せ字なし): ホームディレクトリを ~ に短縮 */
export function shortProjectLabel(key: string): string {
  return key.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~').replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function identityAnonymizer(): Anonymizer {
  return {
    enabled: false,
    project: (k) => k,
    projectLabel: shortProjectLabel,
    branch: (b) => b,
    freeText: (s) => s,
    scrub: (s) => s,
    path: (p) => p,
  };
}

export function createAnonymizer(sessions: AnonSource[]): Anonymizer {
  const projects = [...new Set(sessions.map((s) => s.project))].filter((p) => !GROUPED_PROJECTS.has(p)).sort();
  const branches = [...new Set(sessions.map((s) => s.branch).filter((b): b is string => !!b))].sort();
  const pw = Math.max(2, String(projects.length).length);
  const bw = Math.max(2, String(branches.length).length);
  const projectMap = new Map(projects.map((p, i) => [p, `project-${pad(i + 1, pw)}`]));
  const branchMap = new Map(branches.map((b, i) => [b, `branch-${pad(i + 1, bw)}`]));

  // scrub で置き換える既知の固有名(長いものから)。3 文字未満は誤置換が多いので除く
  const repl = new Map<string, string>();
  const add = (s: string | null | undefined, to: string): void => {
    if (s && s.length >= 3 && !repl.has(s)) repl.set(s, to);
  };
  for (const s of sessions) {
    // まとめたプロジェクトのパス(ホーム・一時フォルダ)は PATH_RE で <path> になる。最後のフォルダ名は伏せる
    const grouped = GROUPED_PROJECTS.has(s.project);
    const p = grouped ? '<path>' : projectMap.get(s.project)!;
    if (!grouped) add(s.project, p);
    // git の origin から決めた owner/repo(repository の記録が無い)も、所有者名とリポジトリ名を伏せる
    if (!grouped && !s.repository && /^[^\\/:]+\/[^\\/:]+$/.test(s.project)) for (const part of s.project.split('/')) add(part, p);
    add(s.cwd, p);
    add(s.gitRoot, p);
    add(s.repository, p);
    if (s.repository) for (const part of s.repository.split('/')) add(part, p);
    for (const path of [s.cwd, s.gitRoot]) if (path) add(lastSegment(path), p);
    if (s.branch) add(s.branch, branchMap.get(s.branch)!);
  }
  const keys = [...repl.keys()].sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(`(?<![\\w.-])(?:${keys.map(escapeRe).join('|')})(?![\\w-])`, 'g') : null;

  return {
    enabled: true,
    project: (k) => (GROUPED_PROJECTS.has(k) ? k : (projectMap.get(k) ?? 'project-??')),
    projectLabel: (k) => (GROUPED_PROJECTS.has(k) ? k : (projectMap.get(k) ?? 'project-??')),
    branch: (b) => (b == null ? null : (branchMap.get(b) ?? 'branch-??')),
    freeText: () => null,
    scrub: (s) => {
      let out = s.replace(PATH_RE, '<path>');
      if (re) out = out.replace(re, (m) => repl.get(m) ?? m);
      return out;
    },
    path: () => null,
  };
}
