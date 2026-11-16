// AI が作った変更(ai-changes.ts)が、開始時の基準と照合した時点のファイルの差に残っているかを、変更のまとまりごとに分ける。
//
// 分け方(まとまり = AI の diff の連続した追加行):
// - kept(そのまま残る): 数えた行がすべて、照合した時点のファイルに同じ本文である
// - modified(直されて残る): 一部の行が残っている、または空白の違い・似た本文(文字の 2 字組の重なり)で残っている
// - missing(見つからない): ファイルは照合できたが、どの行も照合した時点のファイルに見つからない
// - unattributable(照合不可): リポジトリが無い・基準が決まらない・読めない・ほかのセッションと行が重なる・
//   比べる版が開始時の基準と同じ(開始時から取り込まれた変更が無い。fixed・committed)
// 似た本文で当てた行は推定なので、まとまりごとに similarLines として分けて残す。まとまりには出所(toolCallId・from)も添える
// 数える行: 空白だけの行と、開始時の基準のファイルにもともとあった行は除く(多重集合で数える)。
// 比べる相手: 照合した時点のファイルから基準のファイルの行を除いた「差分で増えた行」(多重集合)。1 つの行は 1 回しか使わない。
// 二重計上を防ぐ:
// - 同じファイルの同じ本文の行を、時間の重なる別のセッションの AI も足していたら、そのまとまりは照合不可(concurrent_session)
// - 後のセッションの AI も同じ本文の行を足していたら、その行は後のセッションの分として数え、前のセッションでは照合不可(later_session)にする
import { dirname } from 'node:path';
import type { AiChangeSet, AiHunk, ValueSource } from './ai-changes.ts';
import { filePathKey } from './classify.ts';
import { defaultRunner, type EvalMode, nearestExistingDir, openRepo, type OpenRepoResult, type Revision, type VcsKind, type VcsRepo, type VcsRunner } from './vcs.ts';

export const RETENTION_STATUSES = ['kept', 'modified', 'missing', 'unattributable'] as const;
export type RetentionStatus = (typeof RETENTION_STATUSES)[number];
export const RETENTION_STATUS_LABEL: Record<RetentionStatus, string> = {
  kept: 'そのまま残る',
  modified: '直されて残る',
  missing: '見つからない',
  unattributable: '照合不可',
};

/**
 * 照合不可の理由(並びは画面の packages/report/src/lib/retention.ts の REASONS と同じ)。
 * - no_commits: 比べる版(fixed・committed)が開始時の基準と同じ(その間に取り込まれた変更が無い)。worktree と、svn の committed では使わない
 * - unknown: 照合不可だが理由が記録されていない(送った側の結果に理由が無い・読めない)。読めなかった(read_error)とは決めない
 */
export const UNATTRIBUTABLE_REASONS = [
  'repo_not_found',
  'no_vcs',
  'baseline_missing',
  'outside_repo',
  'read_error',
  'concurrent_session',
  'later_session',
  'not_measured',
  'too_recent',
  'after_missing',
  'no_commits',
  'unknown',
] as const;
export type UnattributableReason = (typeof UNATTRIBUTABLE_REASONS)[number];
export const UNATTRIBUTABLE_REASON_LABEL: Record<UnattributableReason, string> = {
  repo_not_found: '作業フォルダがこの PC に無い',
  no_vcs: 'VCS の管理下でない',
  baseline_missing: '開始時の基準を決められない',
  outside_repo: 'リポジトリの外のファイル',
  read_error: 'VCS かファイルを読めなかった',
  concurrent_session: '時間の重なる別のセッションと同じ行',
  later_session: '後のセッションも同じ行を足した',
  not_measured: '送った側で照合していない',
  too_recent: '決まった日数がまだ経っていない',
  after_missing: '比べる版を決められない',
  no_commits: '開始時から取り込まれた変更が無い',
  unknown: '理由が記録されていない',
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
  /** そのまとまりを作った編集の時刻(ISO。工程ごとの集計で、どの依頼のものかを決めるのに使う)。記録が無ければ省略 */
  at?: string;
  /** lines.modified のうち、空白の違いでなく「似た本文」(2 字組の重なりが下限以上)で当てた行(推定。0 なら省略) */
  similarLines?: number;
  /** そのまとまりを作ったツールの呼び出しの ID(ログの toolCallId。どの編集の変更かをたどる)。記録が無ければ省略 */
  toolCallId?: string;
  /** 変更をログのどこから取り出したか(diff = 完了イベントの diff、args = 開始イベントの引数)。記録が無ければ省略 */
  from?: AiHunk['from'];
}

/** 比べた版。source は比べた版をどう決めたか(estimated = 日時から推定した。fixed)。無ければ、照合したときに VCS で見た版 */
export interface Evaluated {
  mode: EvalMode;
  rev: string | null;
  at: string;
  source?: Revision['source'];
}

export interface SessionRetention {
  sessionId: string;
  /** measured = 照合できたまとまりが 1 つ以上ある(分母に入る)。no_ai_changes = 数える AI の変更が無い。unattributable = すべて照合不可 */
  outcome: 'measured' | 'no_ai_changes' | 'unattributable';
  /** outcome が unattributable のとき、いちばん多い理由 */
  reason?: UnattributableReason;
  vcs: VcsKind | null;
  root: string | null;
  /** 開始時の基準(observed = ログの記録、estimated = 時刻から推定) */
  baseline: Revision | null;
  evaluated: Evaluated | null;
  hunks: HunkRetention[];
  /** 基準にあった行だけでできていて、数えなかったまとまり */
  excludedHunks: number;
  counts: Record<RetentionStatus, number>;
  lines: LineCounts;
  /** 値の出所 */
  provenance: { aiChanges: 'events'; baseline: Revision['source'] | null; context: Partial<Record<string, ValueSource>> };
  /** 作業フォルダとファイルのパスを、設定の対応づけ(vcs.pathMap)で読み替えたか(vcs-step.ts が付ける) */
  pathMapped?: boolean;
  /** 照合した場所。local = この PC、sender = 送った側の PC(アップロードに添えられた結果を読んだ)。vcs-step.ts が付ける */
  computedOn?: 'local' | 'sender';
  /** セッションの終わり(最後のイベントの時刻)。照合した時点までの日数を出すのに使う */
  sessionEnd?: string | null;
  /** AI の編集のうち、ログから変更を取り出せなかったもの(diff も引数も読めなかった)。ログの形が変わると増える */
  unreadEdits?: number;
}

export interface RetentionOptions {
  runner?: VcsRunner;
  /** 比べる版。worktree = 今の作業ツリー(既定)、committed = 最後に取り込んだ版、fixed = セッションの終わりから lagDays 日後の版 */
  mode?: EvalMode;
  /** fixed のときの日数(既定 7) */
  lagDays?: number;
  now?: () => Date;
  /** 似た本文とみなす 2 字組の重なり(Dice 係数)の下限 */
  similarity?: number;
}

/** fixed の既定の日数 */
export const DEFAULT_LAG_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;

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

/** 似た本文の判定と、ほかのセッションとの重なりの判定をする行の最小の長さ(空白を除いた文字数) */
const MIN_SIMILAR_CHARS = 6;

/** 作っておいた 2 字組どうしの重なり(la・lb はそれぞれの 2 字組の数) */
function diceGrams(A: Map<string, number>, la: number, B: Map<string, number>, lb: number): number {
  let common = 0;
  for (const [g, n] of A) common += Math.min(n, B.get(g) ?? 0);
  return (2 * common) / (la + lb);
}

/** 文字の 2 字組の重なり(0〜1) */
export function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  return diceGrams(bigrams(a), a.length - 1, bigrams(b), b.length - 1);
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

/** その行を、ほかのセッションとの関係でこのセッションの分として数えられるか */
function lineClaim(index: LineIndex, me: Owner, path: string, line: string): 'mine' | 'concurrent_session' | 'later_session' {
  // 短い行(} や return; など)は、別のセッションが同じ本文を足していても同じ変更とは言えないので、重なりを判定しない
  // (判定すると、ありふれた 1 行のためにまとまりごと照合不可になる)
  if (squash(line).length < MIN_SIMILAR_CHARS) return 'mine';
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
  // 照合した時点のファイルで増えた行(照合時 − 基準、多重集合)
  const added: string[] = [];
  {
    const b = multiset(fileLines(base));
    for (const l of fileLines(after)) if (l.trim() !== '' && !take(b, l)) added.push(l);
  }
  // similar = 似た本文で当てた行(書き換えたとみなす。数えるのは modified と同じで、推定した行として別にも数える)
  type Line = { text: string; state: 'pending' | 'kept' | 'modified' | 'similar' | 'missing' | 'excluded' | UnattributableReason };
  const per: { h: AiHunk; lines: Line[]; concurrent: boolean }[] = [];
  for (const h of hunks) {
    const lines: Line[] = [];
    let concurrent = false;
    for (const text of h.lines) {
      const c = claim(text);
      if (c === 'concurrent_session') concurrent = true;
      lines.push({ text, state: c === 'mine' ? 'pending' : c });
    }
    per.push({ h, lines, concurrent });
  }
  // 時間の重なる別のセッションと同じ行を含むまとまりは、まとまりごと照合不可
  for (const p of per) if (p.concurrent) for (const l of p.lines) l.state = 'concurrent_session';
  const pending = () => per.flatMap((p) => p.lines.filter((l) => l.state === 'pending'));
  // 1) 同じ本文 2) 空白の違いだけ 3) 似た本文、の順に、照合した時点のファイルの行を 1 つずつ使う
  const exact = new Map<string, number>();
  for (const l of added) exact.set(l, (exact.get(l) ?? 0) + 1);
  for (const l of pending()) if (take(exact, l.text)) l.state = 'kept';
  // 増えた行に当たらず、基準のファイルにもともとある本文の行(動かしただけの行・同じ本文の書き直し)は数えない。
  // 同じ本文が増えた分(} を 3 つ足したなど)は先に当てたので、ありふれた行でも新しく足した分は数える
  for (const l of pending()) if (take(baseLeft, l.text)) l.state = 'excluded';
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
  // 似た本文: 照合した時点の行の 2 字組は 1 度だけ作る(行ごと・組ごとに作り直すと、大きなファイルで遅くなる)
  const restSq = rest.map(squash);
  const restGrams = restSq.map((r) => (r.length >= MIN_SIMILAR_CHARS ? bigrams(r) : null));
  for (const l of pending()) {
    const s = squash(l.text);
    if (s.length < MIN_SIMILAR_CHARS) continue; // 短い行(} や end など)は似ていても当てにならない
    const grams = bigrams(s);
    let best = -1;
    let bestScore = similarity;
    for (let j = 0; j < rest.length; j++) {
      const g = restGrams[j];
      if (used[j] || !g) continue;
      // 長さの差だけで下限に届かないものは、数えずに飛ばす(重なりは短いほうの 2 字組の数を超えない)
      const la = s.length - 1;
      const lb = restSq[j].length - 1;
      if ((2 * Math.min(la, lb)) / (la + lb) < bestScore) continue;
      const score = diceGrams(grams, la, g, lb);
      if (score >= bestScore) ((best = j), (bestScore = score));
    }
    if (best >= 0) ((used[best] = true), (l.state = 'similar'));
  }
  for (const l of pending()) l.state = 'missing';

  const results: HunkRetention[] = [];
  let excluded = 0;
  for (const p of per) {
    const countedLines = p.lines.filter((l) => l.state !== 'excluded');
    if (countedLines.length === 0) {
      excluded++;
      continue;
    }
    const lines = emptyLines();
    let similarLines = 0;
    let reason: UnattributableReason | undefined;
    for (const l of countedLines) {
      if (l.state === 'kept' || l.state === 'modified' || l.state === 'missing') lines[l.state]++;
      else if (l.state === 'similar') ((lines.modified += 1), (similarLines += 1));
      else ((lines.unattributable += 1), (reason ??= l.state as UnattributableReason));
    }
    const status = statusOfLines(lines);
    results.push({ id: p.h.id, path: p.h.path, status, ...(status === 'unattributable' ? { reason } : {}), lines, ...(p.h.at ? { at: p.h.at } : {}), ...(similarLines ? { similarLines } : {}), ...evidence(p.h) });
  }
  return { results, excluded };
}

/** 行の内訳から決まる状態 */
export function statusOfLines(l: LineCounts): RetentionStatus {
  const counted = l.kept + l.modified + l.missing;
  return counted === 0 ? 'unattributable' : l.kept === counted ? 'kept' : l.kept + l.modified > 0 ? 'modified' : 'missing';
}

/** まとまりの出所(どのツールの呼び出しの、ログのどこから取った変更か) */
export function evidence(h: AiHunk): Pick<HunkRetention, 'toolCallId' | 'from'> {
  return { ...(h.toolCallId ? { toolCallId: h.toolCallId } : {}), from: h.from };
}

/** 決まった数だけ同時に進める(結果は items の順) */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** 同時に照合するセッションの数(VCS のコマンドを並べて起動しすぎないように) */
const SESSION_CONCURRENCY = 4;

/** 同じ鍵の読み取りは 1 回だけ行い、結果(失敗も)を使い回す */
function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) cache.set(key, (p = load()));
  return p;
}

/** まとまりを丸ごと照合不可にしたもの(vcs-step.ts の照合していないセッションも同じ形) */
export function unattributed(h: AiHunk, reason: UnattributableReason): HunkRetention {
  return { id: h.id, path: h.path, status: 'unattributable', reason, lines: { ...emptyLines(), unattributable: h.lines.length }, ...(h.at ? { at: h.at } : {}), ...evidence(h) };
}

/** 2 つの版の印が同じ版か。git はログの短い印(7 字以上)でも、前方が一致すれば同じとみなす(大文字小文字は区別しない) */
export function sameRevision(kind: VcsKind, a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (kind !== 'git') return x === y;
  const [short, long] = x.length <= y.length ? [x.toLowerCase(), y.toLowerCase()] : [y.toLowerCase(), x.toLowerCase()];
  return short.length >= 7 && long.startsWith(short);
}

/** まとまりから件数・行数を数え直し、結果(measured / unattributable / no_ai_changes)と理由を決める。理由はいちばん多いもの(同じ数なら先に出たもの) */
export function tallyRetention(r: SessionRetention, fallback?: UnattributableReason): void {
  r.counts = emptyCounts();
  r.lines = emptyLines();
  for (const h of r.hunks) {
    r.counts[h.status]++;
    for (const k of RETENTION_STATUSES) r.lines[k] += h.lines[k];
  }
  delete r.reason;
  if (r.counts.kept + r.counts.modified + r.counts.missing > 0) r.outcome = 'measured';
  else if (r.counts.unattributable > 0) {
    r.outcome = 'unattributable';
    const byReason = new Map<UnattributableReason, number>();
    for (const h of r.hunks) if (h.reason) byReason.set(h.reason, (byReason.get(h.reason) ?? 0) + 1);
    const top = [...byReason].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
    if (top) r.reason = top;
  } else r.outcome = 'no_ai_changes';
}

/**
 * セッションごとに、AI の変更が照合した時点のファイルに残っているかを調べる。
 * sets には、二重計上の判定のため、照合の対象になりうるセッションをまとめて渡す
 */
export async function measureRetention(sets: readonly AiChangeSet[], opts: RetentionOptions = {}): Promise<SessionRetention[]> {
  const runner = opts.runner ?? defaultRunner;
  const mode = opts.mode ?? 'worktree';
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const similarity = opts.similarity ?? 0.75;
  const lagDays = opts.lagDays ?? DEFAULT_LAG_DAYS;
  const nowMs = Date.parse(now);
  const repoCache = new Map<string, Promise<OpenRepoResult>>();
  // セッションをまたいで同じもの(同じ版のファイル・照合した時点のファイル・記録された開始時の版・今の版)を読むことが多いので、照合 1 回の中で使い回す
  const baselineCache = new Map<string, Promise<{ revision: Revision | null; reason?: 'baseline_missing' }>>();
  const readCache = new Map<string, Promise<string | null>>();
  const revCache = new Map<string, Promise<string | null>>();
  const repoKey = (repo: VcsRepo): string => `${repo.kind}\0${filePathKey(repo.root)}`;
  const { index, owners } = buildIndex(sets);

  return mapLimit(sets, SESSION_CONCURRENCY, async (set): Promise<SessionRetention> => {
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
      sessionEnd: ctx.end,
      ...(set.skipped.noMaterial ? { unreadEdits: set.skipped.noMaterial } : {}),
    };
    if (set.hunks.length === 0) return result;

    // fixed: セッションの終わりから lagDays 日後の時点の版と比べる。その日がまだ来ていなければ照合しない(後で照合し直すと測れる)
    const endMs = toMs(ctx.end);
    const fixedAt = mode === 'fixed' && endMs != null ? new Date(endMs + lagDays * DAY_MS).toISOString() : null;
    const tooRecent = mode === 'fixed' && (endMs == null || endMs + lagDays * DAY_MS > nowMs);
    // 版を調べるコマンドが失敗したら例外(読めなかった)。版が無い(null)とは分ける
    const afters = new Map<VcsRepo, Promise<string | null>>();
    const afterRevOf = (repo: VcsRepo): Promise<string | null> => {
      let r = afters.get(repo);
      if (!r) {
        const branch = repo.kind === 'git' && sessionRepo?.repo === repo ? ctx.branch : null;
        r = memo(revCache, `${repoKey(repo)}\0at\0${fixedAt}\0${branch ?? ''}`, () => repo.revisionAt(fixedAt!, branch));
        afters.set(repo, r);
      }
      return r;
    };
    // 照合した時点の版(committed の比べる版と、evaluated の印)
    const currentRevOf = (repo: VcsRepo): Promise<string | null> => memo(revCache, repoKey(repo), () => repo.currentRevision());

    // セッションの作業フォルダの VCS(ファイルが別のリポジトリにあれば、そのファイルの場所で探し直す)
    const sessionDir = ctx.gitRoot ?? ctx.cwd;
    const sessionRepo = sessionDir ? await openRepo(sessionDir, runner, repoCache) : null;
    if (sessionRepo?.repo) ((result.vcs = sessionRepo.repo.kind), (result.root = sessionRepo.repo.root));

    // リポジトリごとの基準と照合時の版(同じセッションの中では 1 度だけ調べる)
    const baselines = new Map<VcsRepo, Promise<{ revision: Revision | null; reason?: 'baseline_missing' }>>();
    const baselineOf = (repo: VcsRepo) => {
      let b = baselines.get(repo);
      if (!b) {
        // headCommit はそのセッションの git のリポジトリのものなので、同じリポジトリのときだけ使う
        const sameRepo = repo.kind === 'git' && sessionRepo?.repo === repo;
        const headCommit = sameRepo ? ctx.headCommit : null;
        const start = ctx.start;
        // 推定するときは、セッションのブランチの履歴で探す(同じリポジトリのときだけ)
        const branch = sameRepo ? ctx.branch : null;
        b = memo(baselineCache, `${repoKey(repo)}\0${headCommit ?? ''}\0${headCommit ? '' : `${start ?? ''}\0${branch ?? ''}`}`, () => repo.baseline({ headCommit, start, branch }));
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
      if (tooRecent) {
        result.hunks.push(...hunks.map((h) => unattributed(h, 'too_recent')));
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
        const rev = b.revision.rev;
        const fk = filePathKey(path);
        // 比べる版(fixed: 終わりから決まった日数後の版、committed: 最後に取り込んだ版。worktree はディスクなので無い)
        let afterRev: string | null = null;
        if (mode === 'fixed') {
          afterRev = await afterRevOf(repo);
          if (!afterRev) {
            result.hunks.push(...hunks.map((h) => unattributed(h, 'after_missing')));
            continue;
          }
        } else if (mode === 'committed' && repo.kind !== 'svn') {
          // svn の「今の版」は作業コピーのルートの版で、ファイルを取り込んだだけでは進まない(update するまで古いまま)。
          // 基準と同じに見えても取り込みが無いとは言えないので、svn の committed ではこの判定をしない(BASE を読んで照合する)
          afterRev = await currentRevOf(repo);
        }
        // 比べる版が開始時の基準と同じなら、その間に取り込まれた変更が無い(AI の行は必ず見つからない)ので、照合不可にする
        if (afterRev != null && sameRevision(repo.kind, afterRev, rev)) {
          result.hunks.push(...hunks.map((h) => unattributed(h, 'no_commits')));
          continue;
        }
        const base = await memo(readCache, `${repoKey(repo)}\0at\0${rev}\0${fk}`, () => repo.readAt(rev, path));
        let after: string | null;
        if (mode === 'fixed') {
          const r = afterRev!;
          after = await memo(readCache, `${repoKey(repo)}\0at\0${r}\0${fk}`, () => repo.readAt(r, path));
        } else {
          const m = mode;
          after = await memo(readCache, `${repoKey(repo)}\0after\0${m}\0${fk}`, () => repo.readAfter(m, path));
        }
        const { results, excluded } = classifyFile(hunks, base, after, (line) => lineClaim(index, me, path, line), similarity);
        result.hunks.push(...results);
        result.excludedHunks += excluded;
      } catch {
        result.hunks.push(...hunks.map((h) => unattributed(h, 'read_error')));
      }
    }

    if (sessionRepo?.repo) {
      const repo = sessionRepo.repo;
      if (mode === 'fixed') {
        // 比べた時点は、セッションの終わりから決まった日数後(照合した日ではない)
        // その時点の版は、取り込みの日時から推定したもの(日時の後に取り込みが遅れて記録された版などは外れうる)
        if (fixedAt && !tooRecent) result.evaluated = { mode, rev: await afterRevOf(repo).catch(() => null), at: fixedAt, source: 'estimated' };
      } else {
        result.evaluated = { mode, rev: await currentRevOf(repo).catch(() => null), at: now };
      }
    }
    result.hunks.sort((a, b) => a.id - b.id);
    tallyRetention(result);
    // 作業フォルダに VCS が無く、ファイルの場所のリポジトリだけで照合できたときも、比べた時点と見方は残す
    // (版はリポジトリごとに違いうるので印は付けない)。無いと、日数や推定した版の数から外れる
    if (!result.evaluated && result.outcome === 'measured') {
      result.evaluated = mode === 'fixed' && fixedAt ? { mode, rev: null, at: fixedAt, source: 'estimated' } : { mode, rev: null, at: now };
    }
    return result;
  });
}

export interface RetentionSummary {
  /** 渡したセッションの数(照合の範囲の分母) */
  sessions: number;
  /** 数える AI の変更があったセッション */
  withAiChanges: number;
  /** 照合できたセッション(指標の分母) */
  measured: number;
  /** AI の変更はあるが、すべて照合不可だったセッションの数(理由別) */
  unattributable: Partial<Record<UnattributableReason, number>>;
  /** 照合できたセッションのうち、基準を時刻から推定したもの */
  baselineEstimated: number;
  /** まとまりの数(照合できたセッションのものだけ。照合不可のまとまりも含む) */
  hunks: Record<RetentionStatus, number>;
  lines: LineCounts;
  byVcs: Partial<Record<VcsKind, number>>;
  // 以下は記録の欠け・推定の範囲(0 なら省略。古い結果には無い)
  /** 編集はあったが、変更の中身がログに無く取り出せなかった数(渡したすべてのセッション。分母に入らない欠測) */
  unreadEdits?: number;
  /** unreadEdits のあるセッションの数 */
  unreadSessions?: number;
  /** 照合できたセッションで、基準のファイルにもともとある行だけだったので数えなかったまとまり */
  excludedHunks?: number;
  /** 照合できたセッションの lines.modified のうち、似た本文で当てた(推定した)行 */
  similarLines?: number;
  /** 照合できたセッションのうち、比べた版を日時から推定したもの(fixed) */
  evaluatedEstimated?: number;
}

/** 照合の範囲と、照合できたセッションでの内訳 */
export function summarizeRetention(results: readonly SessionRetention[]): RetentionSummary {
  const s: RetentionSummary = { sessions: results.length, withAiChanges: 0, measured: 0, unattributable: {}, baselineEstimated: 0, hunks: emptyCounts(), lines: emptyLines(), byVcs: {} };
  const extra = { unreadEdits: 0, unreadSessions: 0, excludedHunks: 0, similarLines: 0, evaluatedEstimated: 0 };
  for (const r of results) {
    // 中身を取り出せなかった編集は、ほかに AI の変更が無いセッションでも数える(欠測の範囲)
    if (r.unreadEdits && r.unreadEdits > 0) ((extra.unreadEdits += r.unreadEdits), (extra.unreadSessions += 1));
    if (r.outcome === 'no_ai_changes') continue;
    s.withAiChanges++;
    if (r.outcome === 'unattributable') {
      // 理由が無いときは「読めなかった」と決めつけない
      const k = r.reason ?? 'unknown';
      s.unattributable[k] = (s.unattributable[k] ?? 0) + 1;
      continue;
    }
    s.measured++;
    if (r.baseline?.source === 'estimated') s.baselineEstimated++;
    // fixed の版はいつも日時から決めた推定(source の無い古い送った側の結果も、見方で数える)
    if (r.evaluated && (r.evaluated.mode === 'fixed' || r.evaluated.source === 'estimated')) extra.evaluatedEstimated++;
    extra.excludedHunks += r.excludedHunks;
    for (const h of r.hunks) extra.similarLines += h.similarLines ?? 0;
    if (r.vcs) s.byVcs[r.vcs] = (s.byVcs[r.vcs] ?? 0) + 1;
    for (const k of RETENTION_STATUSES) {
      s.hunks[k] += r.counts[k];
      s.lines[k] += r.lines[k];
    }
  }
  for (const [k, v] of Object.entries(extra) as [keyof typeof extra, number][]) if (v) s[k] = v;
  return s;
}
