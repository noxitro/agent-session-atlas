// AI が作った変更(ai-changes.ts)が、作業後の VCS の差分(開始時の基準 → 作業後)に残っているかを、変更のまとまりごとに分ける。
// これは「残っているか」の記録であって、採用の意図や良し悪しではない。照合できなかったもの・見つからなかったものを、不採用とはみなさない。
//
// 分け方(まとまり = AI の diff の連続した追加行):
// - kept(未変更で残存): 数えた行がすべて、作業後の差分に同じ本文である
// - modified(変更後に残存): 一部の行が残っている、または空白の違い・似た本文(文字の 2 字組の重なり)で残っている
// - missing(終了時の差分で未確認): ファイルは照合できたが、どの行も作業後の差分に見つからない
// - unattributable(帰属・照合不能): リポジトリが無い・基準が決まらない・読めない・ほかのセッションと帰属が重なる
// 数える行: 空白だけの行と、開始時の基準のファイルにもともとあった行は除く(多重集合で数える)。
// 比べる相手: 作業後のファイルから基準のファイルの行を除いた「差分で増えた行」(多重集合)。1 つの行は 1 回しか使わない。
// 二重計上を防ぐ:
// - 同じファイルの同じ本文の行を、時間の重なる別のセッションの AI も足していたら、そのまとまりは帰属不能(concurrent_session)
// - 後のセッションの AI も同じ本文の行を足していたら、その行は後のセッションの分として数え、前のセッションでは帰属不能(later_session)にする
import { dirname } from 'node:path';
import type { AiChangeSet, AiHunk, ValueSource } from './ai-changes.ts';
import { filePathKey } from './classify.ts';
import { defaultRunner, type EvalMode, nearestExistingDir, openRepo, type OpenRepoResult, type Revision, type VcsKind, type VcsRepo, type VcsRunner } from './vcs.ts';

export const RETENTION_STATUSES = ['kept', 'modified', 'missing', 'unattributable'] as const;
export type RetentionStatus = (typeof RETENTION_STATUSES)[number];
export const RETENTION_STATUS_LABEL: Record<RetentionStatus, string> = {
  kept: '未変更で残存',
  modified: '変更後に残存',
  missing: '終了時の差分で未確認',
  unattributable: '帰属・照合不能',
};

export const UNATTRIBUTABLE_REASONS = ['repo_not_found', 'no_vcs', 'baseline_missing', 'outside_repo', 'read_error', 'concurrent_session', 'later_session'] as const;
export type UnattributableReason = (typeof UNATTRIBUTABLE_REASONS)[number];
export const UNATTRIBUTABLE_REASON_LABEL: Record<UnattributableReason, string> = {
  repo_not_found: '作業フォルダがこの PC に無い',
  no_vcs: 'VCS の管理下でない',
  baseline_missing: '開始時の基準を決められない',
  outside_repo: 'リポジトリの外のファイル',
  read_error: 'VCS かファイルを読めなかった',
  concurrent_session: '時間の重なる別のセッションと同じ行',
  later_session: '後のセッションも同じ行を足した',
};

export interface LineCounts {
  kept: number;
  modified: number;
  missing: number;
  unattributable: number;
}

export interface HunkRetention {
  id: number;
  path: string;
  status: RetentionStatus;
  reason?: UnattributableReason;
  /** 数えた行の内訳(基準にあった行・空白行は含めない) */
  lines: LineCounts;
}

export interface SessionRetention {
  sessionId: string;
  /** measured = 照合できたまとまりが 1 つ以上ある(分母に入る)。no_ai_changes = 数える AI の変更が無い。unattributable = すべて照合不能 */
  outcome: 'measured' | 'no_ai_changes' | 'unattributable';
  /** outcome が unattributable のとき、いちばん多い理由 */
  reason?: UnattributableReason;
  vcs: VcsKind | null;
  root: string | null;
  /** 開始時の基準(observed = ログの記録、estimated = 時刻から推定) */
  baseline: Revision | null;
  evaluated: { mode: EvalMode; rev: string | null; at: string } | null;
  hunks: HunkRetention[];
  /** 基準にあった行だけでできていて、数えなかったまとまり */
  excludedHunks: number;
  counts: Record<RetentionStatus, number>;
  lines: LineCounts;
  /** 値の出所 */
  provenance: { aiChanges: 'events'; baseline: Revision['source'] | null; context: Partial<Record<string, ValueSource>> };
}

export interface RetentionOptions {
  runner?: VcsRunner;
  /** 作業後の状態。worktree = 今の作業ツリー(既定)、committed = 最後に取り込んだ版 */
  mode?: EvalMode;
  now?: () => Date;
  /** 似た本文とみなす 2 字組の重なり(Dice 係数)の下限 */
  similarity?: number;
}

const emptyLines = (): LineCounts => ({ kept: 0, modified: 0, missing: 0, unattributable: 0 });
const emptyCounts = (): Record<RetentionStatus, number> => ({ kept: 0, modified: 0, missing: 0, unattributable: 0 });

/** 空白の違いを無視した本文 */
const squash = (s: string): string => s.replace(/\s+/g, '');

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 文字の 2 字組の重なり(0〜1) */
export function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let common = 0;
  for (const [g, n] of A) common += Math.min(n, B.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

/** 本文の行(行末の空白を落とす) */
const fileLines = (text: string | null): string[] => (text == null ? [] : text.split('\n').map((l) => l.replace(/[\s\r]+$/, '')));

function multiset(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) if (l.trim() !== '') m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/** 多重集合から 1 つ取る。取れたら true */
function take(m: Map<string, number>, k: string): boolean {
  const n = m.get(k) ?? 0;
  if (n <= 0) return false;
  m.set(k, n - 1);
  return true;
}

interface Owner {
  set: AiChangeSet;
  startMs: number | null;
  endMs: number | null;
}

const toMs = (s: string | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** 時間が重なるか(どちらかの時刻が無ければ、重なるかもしれないので true) */
function overlaps(a: Owner, b: Owner): boolean {
  if (a.startMs == null || a.endMs == null || b.startMs == null || b.endMs == null) return true;
  return a.startMs <= b.endMs && b.startMs <= a.endMs;
}

/** 行 → それを足したセッション(ファイルごと)。二重計上を防ぐための索引 */
type LineIndex = Map<string, Map<string, Owner[]>>;

function buildIndex(sets: readonly AiChangeSet[]): { index: LineIndex; owners: Map<string, Owner> } {
  const index: LineIndex = new Map();
  const owners = new Map<string, Owner>();
  for (const set of sets) {
    const o: Owner = { set, startMs: toMs(set.context.start), endMs: toMs(set.context.end) };
    owners.set(set.sessionId, o);
    for (const h of set.hunks) {
      const fk = filePathKey(h.path);
      let byLine = index.get(fk);
      if (!byLine) index.set(fk, (byLine = new Map()));
      for (const l of new Set(h.lines)) {
        const list = byLine.get(l) ?? [];
        if (!list.includes(o)) list.push(o);
        byLine.set(l, list);
      }
    }
  }
  return { index, owners };
}

/** その行が、ほかのセッションとの関係でこのセッションに帰属できるか */
function lineClaim(index: LineIndex, me: Owner, path: string, line: string): 'mine' | 'concurrent_session' | 'later_session' {
  const others = index.get(filePathKey(path))?.get(line)?.filter((o) => o !== me) ?? [];
  if (others.some((o) => overlaps(me, o))) return 'concurrent_session';
  if (others.some((o) => o.startMs != null && me.endMs != null && o.startMs > me.endMs)) return 'later_session';
  return 'mine';
}

/** 1 セッションのファイル 1 つ分(同じファイルのまとまりをまとめて照合する。1 つの行を二度使わないため) */
function classifyFile(
  hunks: AiHunk[],
  base: string | null,
  after: string | null,
  claim: (line: string) => 'mine' | 'concurrent_session' | 'later_session',
  similarity: number,
): { results: HunkRetention[]; excluded: number } {
  const baseLeft = multiset(fileLines(base));
  // 作業後の差分で増えた行(作業後 − 基準、多重集合)
  const added: string[] = [];
  {
    const b = multiset(fileLines(base));
    for (const l of fileLines(after)) if (l.trim() !== '' && !take(b, l)) added.push(l);
  }
  type Line = { text: string; state: 'pending' | 'kept' | 'modified' | 'missing' | UnattributableReason };
  const per: { h: AiHunk; lines: Line[]; concurrent: boolean }[] = [];
  for (const h of hunks) {
    const lines: Line[] = [];
    let concurrent = false;
    for (const text of h.lines) {
      if (take(baseLeft, text)) continue; // 基準にもともとあった行
      const c = claim(text);
      if (c === 'concurrent_session') concurrent = true;
      lines.push({ text, state: c === 'mine' ? 'pending' : c });
    }
    per.push({ h, lines, concurrent });
  }
  // 時間の重なる別のセッションと同じ行を含むまとまりは、まとまりごと帰属不能
  for (const p of per) if (p.concurrent) for (const l of p.lines) l.state = 'concurrent_session';
  const pending = () => per.flatMap((p) => p.lines.filter((l) => l.state === 'pending'));
  // 1) 同じ本文 2) 空白の違いだけ 3) 似た本文、の順に、作業後の差分の行を 1 つずつ使う
  const exact = new Map<string, number>();
  for (const l of added) exact.set(l, (exact.get(l) ?? 0) + 1);
  for (const l of pending()) if (take(exact, l.text)) l.state = 'kept';
  const rest = added.filter((l) => {
    // exact で使わなかった分を残す
    const n = exact.get(l) ?? 0;
    if (n > 0) {
      exact.set(l, n - 1);
      return true;
    }
    return false;
  });
  const used = new Array(rest.length).fill(false);
  for (const l of pending()) {
    const i = rest.findIndex((r, j) => !used[j] && squash(r) === squash(l.text));
    if (i >= 0) ((used[i] = true), (l.state = 'modified'));
  }
  for (const l of pending()) {
    const s = squash(l.text);
    if (s.length < 6) continue; // 短い行(} や end など)は似ていても当てにならない
    let best = -1;
    let bestScore = similarity;
    for (let j = 0; j < rest.length; j++) {
      if (used[j]) continue;
      const score = dice(s, squash(rest[j]));
      if (score >= bestScore) ((best = j), (bestScore = score));
    }
    if (best >= 0) ((used[best] = true), (l.state = 'modified'));
  }
  for (const l of pending()) l.state = 'missing';

  const results: HunkRetention[] = [];
  let excluded = 0;
  for (const p of per) {
    if (p.lines.length === 0) {
      excluded++;
      continue;
    }
    const lines = emptyLines();
    let reason: UnattributableReason | undefined;
    for (const l of p.lines) {
      if (l.state === 'kept' || l.state === 'modified' || l.state === 'missing') lines[l.state]++;
      else ((lines.unattributable += 1), (reason ??= l.state as UnattributableReason));
    }
    const counted = lines.kept + lines.modified + lines.missing;
    const status: RetentionStatus = counted === 0 ? 'unattributable' : lines.kept === counted ? 'kept' : lines.kept + lines.modified > 0 ? 'modified' : 'missing';
    results.push({ id: p.h.id, path: p.h.path, status, ...(status === 'unattributable' ? { reason } : {}), lines });
  }
  return { results, excluded };
}

function unattributed(h: AiHunk, reason: UnattributableReason): HunkRetention {
  return { id: h.id, path: h.path, status: 'unattributable', reason, lines: { ...emptyLines(), unattributable: h.lines.length } };
}

/**
 * セッションごとに、AI の変更が作業後の差分に残っているかを調べる。
 * sets には、二重計上の判定のため、照合の対象になりうるセッションをまとめて渡す
 */
export async function measureRetention(sets: readonly AiChangeSet[], opts: RetentionOptions = {}): Promise<SessionRetention[]> {
  const runner = opts.runner ?? defaultRunner;
  const mode = opts.mode ?? 'worktree';
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const similarity = opts.similarity ?? 0.75;
  const repoCache = new Map<string, Promise<OpenRepoResult>>();
  const { index, owners } = buildIndex(sets);
  const out: SessionRetention[] = [];

  for (const set of sets) {
    const me = owners.get(set.sessionId)!;
    const ctx = set.context;
    const result: SessionRetention = {
      sessionId: set.sessionId,
      outcome: 'no_ai_changes',
      vcs: null,
      root: null,
      baseline: null,
      evaluated: null,
      hunks: [],
      excludedHunks: 0,
      counts: emptyCounts(),
      lines: emptyLines(),
      provenance: { aiChanges: 'events', baseline: null, context: { ...ctx.sources } },
    };
    out.push(result);
    if (set.hunks.length === 0) continue;

    // セッションの作業フォルダの VCS(ファイルが別のリポジトリにあれば、そのファイルの場所で探し直す)
    const sessionDir = ctx.gitRoot ?? ctx.cwd;
    const sessionRepo = sessionDir ? await openRepo(sessionDir, runner, repoCache) : null;
    if (sessionRepo?.repo) ((result.vcs = sessionRepo.repo.kind), (result.root = sessionRepo.repo.root));

    // リポジトリごとの基準と作業後の版(同じセッションの中では 1 度だけ調べる)
    const baselines = new Map<VcsRepo, Promise<{ revision: Revision | null; reason?: 'baseline_missing' }>>();
    const baselineOf = (repo: VcsRepo) => {
      let b = baselines.get(repo);
      if (!b) {
        // headCommit はそのセッションの git のリポジトリのものなので、同じリポジトリのときだけ使う
        const sameRepo = repo.kind === 'git' && sessionRepo?.repo === repo;
        b = repo.baseline({ headCommit: sameRepo ? ctx.headCommit : null, start: ctx.start });
        baselines.set(repo, b);
      }
      return b;
    };

    const byFile = new Map<string, AiHunk[]>();
    for (const h of set.hunks) {
      const k = filePathKey(h.path);
      const list = byFile.get(k) ?? [];
      list.push(h);
      byFile.set(k, list);
    }

    for (const hunks of byFile.values()) {
      const path = hunks[0].path;
      let repo: VcsRepo | null = null;
      let reason: UnattributableReason = 'repo_not_found';
      if (sessionRepo?.repo && sessionRepo.repo.relative(path) != null) repo = sessionRepo.repo;
      else if (sessionRepo && !sessionRepo.repo && sessionRepo.reason === 'repo_not_found') {
        // 作業フォルダがこの PC に無い。上のフォルダをたどると別のリポジトリに当たりうるので、探さない
        reason = 'repo_not_found';
      } else {
        // セッションの作業フォルダの外のファイル。ファイルのある場所(消えていれば、ディスクにある上のフォルダ)で VCS を探す
        const fileDir = nearestExistingDir(dirname(path));
        const opened = fileDir ? await openRepo(fileDir, runner, repoCache) : null;
        if (opened?.repo && opened.repo.relative(path) != null) repo = opened.repo;
        else if (sessionRepo?.repo || opened?.repo) reason = 'outside_repo';
        else reason = (opened && !opened.repo ? opened.reason : null) ?? (sessionRepo && !sessionRepo.repo ? sessionRepo.reason : 'repo_not_found');
      }
      if (!repo) {
        result.hunks.push(...hunks.map((h) => unattributed(h, reason)));
        continue;
      }
      try {
        const b = await baselineOf(repo);
        if (!b.revision) {
          result.hunks.push(...hunks.map((h) => unattributed(h, 'baseline_missing')));
          continue;
        }
        if (repo === sessionRepo?.repo || !result.baseline) {
          result.baseline = b.revision;
          result.provenance.baseline = b.revision.source;
        }
        const base = await repo.readAt(b.revision.rev, path);
        const after = await repo.readAfter(mode, path);
        const { results, excluded } = classifyFile(hunks, base, after, (line) => lineClaim(index, me, path, line), similarity);
        result.hunks.push(...results);
        result.excludedHunks += excluded;
      } catch {
        result.hunks.push(...hunks.map((h) => unattributed(h, 'read_error')));
      }
    }

    if (sessionRepo?.repo) {
      let rev: string | null = null;
      try {
        rev = await sessionRepo.repo.currentRevision();
      } catch {
        rev = null;
      }
      result.evaluated = { mode, rev, at: now };
    }
    result.hunks.sort((a, b) => a.id - b.id);
    for (const h of result.hunks) {
      result.counts[h.status]++;
      for (const k of RETENTION_STATUSES) result.lines[k] += h.lines[k];
    }
    const measured = result.counts.kept + result.counts.modified + result.counts.missing;
    if (measured > 0) result.outcome = 'measured';
    else if (result.counts.unattributable > 0) {
      result.outcome = 'unattributable';
      const byReason = new Map<UnattributableReason, number>();
      for (const h of result.hunks) if (h.reason) byReason.set(h.reason, (byReason.get(h.reason) ?? 0) + 1);
      result.reason = [...byReason].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
  }
  return out;
}

export interface RetentionSummary {
  /** 渡したセッションの数(記録範囲の分母) */
  sessions: number;
  /** 数える AI の変更があったセッション */
  withAiChanges: number;
  /** 照合できたセッション(指標の分母) */
  measured: number;
  /** AI の変更はあるが、すべて照合不能だったセッションの数(理由別) */
  unattributable: Partial<Record<UnattributableReason, number>>;
  /** 照合できたセッションのうち、基準を時刻から推定したもの */
  baselineEstimated: number;
  /** まとまりの数(照合できたセッションのものだけ。照合不能のまとまりも含む) */
  hunks: Record<RetentionStatus, number>;
  lines: LineCounts;
  byVcs: Partial<Record<VcsKind, number>>;
}

/** 記録範囲と、照合できたセッションでの内訳。照合不能・未確認を不採用には数えない */
export function summarizeRetention(results: readonly SessionRetention[]): RetentionSummary {
  const s: RetentionSummary = { sessions: results.length, withAiChanges: 0, measured: 0, unattributable: {}, baselineEstimated: 0, hunks: emptyCounts(), lines: emptyLines(), byVcs: {} };
  for (const r of results) {
    if (r.outcome === 'no_ai_changes') continue;
    s.withAiChanges++;
    if (r.outcome === 'unattributable') {
      const k = r.reason ?? 'read_error';
      s.unattributable[k] = (s.unattributable[k] ?? 0) + 1;
      continue;
    }
    s.measured++;
    if (r.baseline?.source === 'estimated') s.baselineEstimated++;
    if (r.vcs) s.byVcs[r.vcs] = (s.byVcs[r.vcs] ?? 0) + 1;
    for (const k of RETENTION_STATUSES) {
      s.hunks[k] += r.counts[k];
      s.lines[k] += r.lines[k];
    }
  }
  return s;
}
