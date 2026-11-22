// AI の変更がその後の VCS のファイルに残っているか(atlas vcs の vcs-retention.json)を、レポートに埋め込む形と、その集計。
// ブラウザ側(Svelte)と Node 側(build・詳細ページ)の両方から読むので、DOM や node: に依存しない。
// core の vcs-retention.ts は node: を読むので、型も読まずに同じ形をここで持つ(ブラウザ側の型検査は Node の型を持たないため)。
// 名前の並びは core と同じ(vcs-retention.ts の RETENTION_STATUSES・UNATTRIBUTABLE_REASONS、vcs.ts の VCS_KINDS)。
export type RetentionStatus = 'kept' | 'modified' | 'missing' | 'unattributable';
export type UnattributableReason = 'repo_not_found' | 'no_vcs' | 'baseline_missing' | 'outside_repo' | 'read_error' | 'concurrent_session' | 'later_session' | 'not_measured' | 'too_recent' | 'after_missing' | 'no_commits' | 'unknown';
export type VcsKind = 'git' | 'svn' | 'p4';

/** core の SessionRetention のうち、埋め込みに使う項目 */
export interface RetentionLike {
  outcome: 'measured' | 'no_ai_changes' | 'unattributable';
  reason?: UnattributableReason;
  vcs: VcsKind | null;
  baseline: { source: 'observed' | 'estimated' } | null;
  /** 照合に使ったリポジトリ(最初に使った順)。古い結果には無い */
  repos?: readonly { vcs: VcsKind; root: string; baseline: { source: 'observed' | 'estimated' } | null }[];
  counts: Record<RetentionStatus, number>;
  lines: Record<RetentionStatus, number>;
  pathMapped?: boolean;
  computedOn?: 'local' | 'sender';
  /** まとまりごとの状態と、作った編集の時刻(工程ごとの集計に使う)・照合に使ったリポジトリ(VCS 別の数えに使う) */
  hunks?: readonly { status: RetentionStatus; at?: string; vcs?: VcsKind; root?: string }[];
  /** 比べた時点(evaluated.at)と、セッションの終わり。間の日数を出す */
  evaluated?: { at: string } | null;
  sessionEnd?: string | null;
  /** ログから変更を取り出せなかった編集の数 */
  unreadEdits?: number;
}

/** 依頼の開始時刻と工程(PHASES の番号)。工程ごとの集計で、まとまりがどの依頼のものかを決めるのに使う */
export interface TurnStart {
  startedAt: string | null;
  phase: number;
}

/** 工程がわからないまとまり(最初の依頼より前の編集・時刻の記録が無いもの) */
export const UNKNOWN_PHASE = -1;

/**
 * 時刻 at のまとまりを作った依頼の工程(開始が at 以前の最後の依頼)。決まらなければ UNKNOWN_PHASE。
 * 開始時刻の記録が無い依頼をはさむと、その依頼のものかもしれないので決めない。
 * 依頼の記録が途中で打ち切られたセッションは、最後に UNKNOWN_PHASE の依頼(最後の依頼の終わりの時刻)を足して渡す
 */
export function phaseAt(at: string | undefined, turns: readonly TurnStart[]): number {
  if (!at) return UNKNOWN_PHASE;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return UNKNOWN_PHASE;
  let phase = UNKNOWN_PHASE;
  let unsure = false;
  for (const x of turns) {
    const s = x.startedAt ? Date.parse(x.startedAt) : NaN;
    if (Number.isNaN(s)) {
      unsure = true;
      continue;
    }
    if (s > t) break;
    phase = x.phase;
    unsure = false;
  }
  return unsure ? UNKNOWN_PHASE : phase;
}

export const STATUSES = ['kept', 'modified', 'missing', 'unattributable'] as const satisfies readonly RetentionStatus[];

export const STATUS_LABEL: Record<RetentionStatus, string> = {
  kept: 'そのまま残る',
  modified: '直されて残る',
  missing: '見つからない',
  unattributable: '照合不可',
};

export const REASONS = ['repo_not_found', 'no_vcs', 'baseline_missing', 'outside_repo', 'read_error', 'concurrent_session', 'later_session', 'not_measured', 'too_recent', 'after_missing', 'no_commits', 'unknown'] as const satisfies readonly UnattributableReason[];

export const REASON_LABEL: Record<UnattributableReason, string> = {
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

export const VCS_LABEL: Record<VcsKind, string> = { git: 'Git', svn: 'SVN', p4: 'Perforce' };

/** VCS の種類の並び(core の VCS_KINDS と同じ) */
export const VCS_KINDS = ['git', 'svn', 'p4'] as const satisfies readonly VcsKind[];

/**
 * 照合できたまとまり(そのまま残る・直されて残る・見つからない)が 1 つ以上あるリポジトリ(repos の順。まとまりの vcs・root で引く)。
 * 照合不可のまとまりだけのリポジトリ・どのまとまりも指していないリポジトリは入れない(core の measured_repos と同じ)
 */
export function measuredRepos(r: Pick<RetentionLike, 'repos' | 'hunks'>): NonNullable<RetentionLike['repos']>[number][] {
  // まとまりは、種類と根が同じ最初のリポジトリだけを指す(core の repo_of_hunk と同じ。重複があっても 2 つ目は数えない)
  const repos = r.repos ?? [];
  const pointed = new Set((r.hunks ?? []).filter((h) => h.status !== 'unattributable' && h.vcs != null && h.root != null).map((h) => repos.findIndex((x) => x.vcs === h.vcs && x.root === h.root)));
  return repos.filter((_, i) => pointed.has(i));
}

/**
 * 照合に使った VCS の種類(照合できたまとまりのあるリポジトリの種類。VCS_KINDS の順、同じ種類は 1 つ)。
 * そのようなリポジトリが無い(repos の無い古い結果・すべて照合不可)ならセッションの vcs
 */
export function vcsKindsOf(r: Pick<RetentionLike, 'vcs' | 'repos' | 'hunks'>): VcsKind[] {
  const repos = measuredRepos(r);
  if (!repos.length) return r.vcs ? [r.vcs] : [];
  return VCS_KINDS.filter((k) => repos.some((x) => x.vcs === k));
}

/**
 * 開始時の基準の出所。照合できたまとまりのあるリポジトリの基準で、どれかが推定なら推定、すべて記録なら記録(推定を混ぜて記録と言わない)。
 * そのようなリポジトリが無い(repos の無い古い結果・すべて照合不可)なら、セッションの baseline
 */
export function baselineSourceOf(r: Pick<RetentionLike, 'baseline' | 'repos' | 'hunks'>): 'observed' | 'estimated' | null {
  const sources = measuredRepos(r).flatMap((x) => (x.baseline ? [x.baseline.source] : []));
  if (sources.includes('estimated')) return 'estimated';
  if (sources.length) return 'observed';
  return r.baseline?.source ?? null;
}

/** [そのまま残る, 直されて残る, 見つからない, 照合不可] */
export type StatusTuple = [kept: number, modified: number, missing: number, unattributable: number];

/** セッション 1 件の照合の結果(埋め込み用。パスは持たない) */
export interface RetentionItem {
  /** measured = 照合できた(分母に入る)、none = 数える AI の変更が無い、unattributable = すべて照合不可 */
  outcome: 'measured' | 'none' | 'unattributable';
  reason: UnattributableReason | null;
  vcs: VcsKind | null;
  /** 照合に使ったリポジトリの種類(VCS_KINDS の順)。[vcs] と同じとき・古い結果(repos が無い)では省略 */
  vcsKinds?: VcsKind[];
  /** 開始時の基準。observed = ログの記録、estimated = 時刻から推定(照合に使ったリポジトリのどれかが推定なら推定) */
  baseline: 'observed' | 'estimated' | null;
  /** 照合した場所。sender = 送った側の PC */
  on: 'local' | 'sender';
  /** 設定のパスの読み替えを使った */
  mapped: boolean;
  /** まとまりの数(状態別) */
  hunks: StatusTuple;
  /** 行の数(状態別) */
  lines: StatusTuple;
  /** 工程(PHASES の番号。UNKNOWN_PHASE は不明)ごとのまとまりの数 [工程, ...状態別]。依頼の記録が無いセッション・古い埋め込みには無い */
  phases?: [phase: number, ...counts: StatusTuple][];
  /** セッションの終わりから、比べた時点までの日数(小数 1 桁)。どちらかの時刻が無ければ省略 */
  lag?: number;
  /** ログから変更を取り出せなかった編集の数(0 は省略) */
  unread?: number;
}

/** 照合の全体の条件(ReportData.retention) */
export interface RetentionMeta {
  generatedAt: string;
  /** local = この PC で照合した、sender = 送り先から集計し、送った側の結果を読んだ */
  computedOn: 'local' | 'sender';
  mode: 'worktree' | 'committed' | 'fixed';
  /** mode が fixed のときの日数(セッションの終わりから何日後の版と比べたか) */
  lagDays?: number;
  similarity: number;
  pathMap: number;
  /** 照合したセッションの数(vcs-retention.json の件数) */
  sessions: number;
  /**
   * computedOn が sender のとき、送った側が照合した日時の範囲と見方の内訳(generatedAt はこの PC で集計した日時なので、照合の時点はこちら)。
   * 送った側の結果が無い・古い埋め込みでは null / 省略
   */
  senders?: { sessions: number; from: string | null; to: string | null; modes: Partial<Record<RetentionMeta['mode'], number>> } | null;
  /** 設定(atlas.config.json の vcs.labels)で差し替えた状態の名前。無ければ STATUS_LABEL */
  labels?: Partial<Record<RetentionStatus, string>>;
  /** 設定(vcs.note)で足した、節の説明の一文。無ければ null / 省略 */
  note?: string | null;
}

/** 照合した場所の言葉(照合していない = どこでも照合していない。送った側の結果が添えられていなかったもの) */
export function placeLabel(computedOn: 'local' | 'sender' | undefined): string {
  return computedOn === 'sender' ? '送った側の PC' : computedOn === 'local' ? 'この PC' : '照合していない';
}

const tuple = (c: Record<RetentionStatus, number>): StatusTuple => [c.kept, c.modified, c.missing, c.unattributable];

export function retentionItem(r: RetentionLike, turns: readonly TurnStart[] = []): RetentionItem {
  // 工程ごとのまとまりの数(依頼の記録があり、まとまりがあるときだけ)
  let phases: RetentionItem['phases'];
  if (turns.length && r.hunks?.length) {
    const by = new Map<number, StatusTuple>();
    for (const h of r.hunks) {
      const p = phaseAt(h.at, turns);
      const t = by.get(p) ?? by.set(p, zero()).get(p)!;
      t[STATUSES.indexOf(h.status)]++;
    }
    phases = [...by].sort((a, b) => a[0] - b[0]).map(([p, t]) => [p, ...t]);
  }
  const endMs = r.sessionEnd ? Date.parse(r.sessionEnd) : NaN;
  const atMs = r.evaluated?.at ? Date.parse(r.evaluated.at) : NaN;
  const lag = Number.isNaN(endMs) || Number.isNaN(atMs) ? null : Math.max(0, Math.round(((atMs - endMs) / 86_400_000) * 10) / 10);
  // 照合に使ったリポジトリの種類。セッションの vcs だけと同じなら持たない(埋め込みを増やさない)
  const kinds = vcsKindsOf(r);
  const sameAsVcs = kinds.length === (r.vcs ? 1 : 0) && (!r.vcs || kinds[0] === r.vcs);
  return {
    ...(phases ? { phases } : {}),
    ...(lag != null ? { lag } : {}),
    ...(r.unreadEdits ? { unread: r.unreadEdits } : {}),
    outcome: r.outcome === 'no_ai_changes' ? 'none' : r.outcome,
    reason: r.reason ?? null,
    vcs: r.vcs,
    ...(r.repos?.length && !sameAsVcs ? { vcsKinds: kinds } : {}),
    baseline: baselineSourceOf(r),
    on: r.computedOn ?? 'local',
    mapped: !!r.pathMapped,
    hunks: tuple(r.counts),
    lines: tuple(r.lines),
  };
}

/** fixed の既定の日数(core の DEFAULT_LAG_DAYS と同じ。ブラウザ側は core を読めないので写している) */
export const DEFAULT_LAG_DAYS = 7;

export const MODE_LABEL: Record<RetentionMeta['mode'], string> = { worktree: '今の作業ツリー', committed: '最後に取り込んだ版', fixed: 'セッションの終わりから決まった日数後の版' };

/** 中央値(空なら null) */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const zero = (): StatusTuple => [0, 0, 0, 0];
const add = (a: StatusTuple, b: StatusTuple): void => {
  for (let i = 0; i < 4; i++) a[i] += b[i];
};

export interface RetentionAgg {
  /** 渡したセッション(照合の範囲の分母) */
  sessions: number;
  /** 照合していない(vcs-retention.json に無い)セッション */
  notChecked: number;
  /** 数える AI の変更が無いセッション */
  none: number;
  /** AI の変更があったセッション */
  withAi: number;
  /** 照合できたセッション(指標の分母) */
  measured: number;
  /** AI の変更はあるがすべて照合不可だったセッション(理由別) */
  unattributable: Partial<Record<UnattributableReason, number>>;
  unattributableTotal: number;
  /** 照合できたセッションの基準の内訳 */
  baseline: { observed: number; estimated: number };
  /** 照合できたセッションの VCS の内訳。複数の VCS にまたがるセッションはそれぞれに入る(合計が measured を超えうる) */
  byVcs: Partial<Record<VcsKind, number>>;
  /** 照合できたセッションのうち、複数の VCS にまたがるもの */
  multiVcs: number;
  /** 送った側の PC で照合したもの・パスを読み替えたもの(照合できたセッションのうち) */
  sender: number;
  mapped: number;
  /** 照合できたセッションのまとまりと行(状態別) */
  hunks: StatusTuple;
  lines: StatusTuple;
  /** 照合できたセッションの、セッションの終わりから比べた時点までの日数 */
  lags: number[];
  /** ログから変更を取り出せなかった編集(照合していないものも含む、渡したセッションの全部) */
  unread: number;
  unreadSessions: number;
}

/** 照合の結果を集計する(照合できたセッションだけを分母にし、照合の範囲を一緒に数える) */
export function aggregateRetention(sessions: readonly { retention?: RetentionItem | null }[]): RetentionAgg {
  const a: RetentionAgg = { sessions: sessions.length, notChecked: 0, none: 0, withAi: 0, measured: 0, unattributable: {}, unattributableTotal: 0, baseline: { observed: 0, estimated: 0 }, byVcs: {}, multiVcs: 0, sender: 0, mapped: 0, hunks: zero(), lines: zero(), lags: [], unread: 0, unreadSessions: 0 };
  for (const s of sessions) {
    const r = s.retention;
    if (r?.unread) ((a.unread += r.unread), a.unreadSessions++);
    if (!r) {
      a.notChecked++;
      continue;
    }
    if (r.outcome === 'none') {
      a.none++;
      continue;
    }
    a.withAi++;
    if (r.outcome === 'unattributable') {
      const k = r.reason ?? 'unknown';
      a.unattributable[k] = (a.unattributable[k] ?? 0) + 1;
      a.unattributableTotal++;
      continue;
    }
    a.measured++;
    if (r.baseline === 'estimated') a.baseline.estimated++;
    else if (r.baseline === 'observed') a.baseline.observed++;
    const kinds = r.vcsKinds ?? (r.vcs ? [r.vcs] : []);
    for (const k of kinds) a.byVcs[k] = (a.byVcs[k] ?? 0) + 1;
    if (kinds.length > 1) a.multiVcs++;
    if (r.on === 'sender') a.sender++;
    if (r.mapped) a.mapped++;
    if (r.lag != null) a.lags.push(r.lag);
    add(a.hunks, r.hunks);
    add(a.lines, r.lines);
  }
  return a;
}

/** 照合できたまとまり(未変更・変更後・未確認。照合不可は除く)の数 */
export const measuredOf = (t: StatusTuple): number => t[0] + t[1] + t[2];

/**
 * 残存の割合を出す最小の、照合できたセッションの数。残存の節・「比べる」・「モデルと推論強度の効果」が同じこの値を使う。
 * これより少ないと、1 つのセッションのまとまりだけで割合が大きく動く。件数はいつも出す
 */
export const RETENTION_MIN_SESSIONS = 5;

/** 照合できたセッションが、割合を出せる数だけあるか */
export const enoughMeasured = (measuredSessions: number): boolean => measuredSessions >= RETENTION_MIN_SESSIONS;

/**
 * 照合できたまとまりに対する割合。分母が 0 のときと、照合できたセッション(measuredSessions)が
 * RETENTION_MIN_SESSIONS に届かないときは null
 */
export function shareOf(t: StatusTuple, i: 0 | 1 | 2, measuredSessions: number): number | null {
  const d = measuredOf(t);
  return d > 0 && enoughMeasured(measuredSessions) ? t[i] / d : null;
}

/**
 * 照合できたセッションのまとまりを、工程(PHASES の番号。UNKNOWN_PHASE は不明)ごとに数える。
 * sessions は、その工程に照合できたまとまり(照合不可を除く)が 1 つ以上あるセッションの数(工程ごとの割合を出すかを決める)。
 * 工程の記録が無いセッション(古い埋め込み・依頼の記録が無いもの)は数えず、その数を返す
 */
export function retentionByPhase(sessions: readonly { retention?: RetentionItem | null }[]): { byPhase: Map<number, StatusTuple>; sessions: Map<number, number>; withoutPhases: number } {
  const byPhase = new Map<number, StatusTuple>();
  const perPhase = new Map<number, number>();
  let withoutPhases = 0;
  for (const s of sessions) {
    const r = s.retention;
    if (!r || r.outcome !== 'measured') continue;
    if (!r.phases?.length) {
      withoutPhases++;
      continue;
    }
    // phases は工程ごとに 1 行(retentionItem が工程でまとめて書く)なので、行の数がそのままセッションの数になる
    for (const [p, ...t] of r.phases) {
      add(byPhase.get(p) ?? byPhase.set(p, zero()).get(p)!, t as StatusTuple);
      if (measuredOf(t as StatusTuple) > 0) perPhase.set(p, (perPhase.get(p) ?? 0) + 1);
    }
  }
  return { byPhase, sessions: perPhase, withoutPhases };
}
