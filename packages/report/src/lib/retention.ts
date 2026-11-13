// AI の変更がその後の VCS のファイルに残っているか(atlas vcs の vcs-retention.json)を、レポートに埋め込む形と、その集計。
// ブラウザ側(Svelte)と Node 側(build・詳細ページ)の両方から読むので、DOM や node: に依存しない。
// core の vcs-retention.ts は node: を読むので、型も読まずに同じ形をここで持つ(ブラウザ側の型検査は Node の型を持たないため)。
// 名前の並びは core と同じ(vcs-retention.ts の RETENTION_STATUSES・UNATTRIBUTABLE_REASONS、vcs.ts の VCS_KINDS)。
export type RetentionStatus = 'kept' | 'modified' | 'missing' | 'unattributable';
export type UnattributableReason = 'repo_not_found' | 'no_vcs' | 'baseline_missing' | 'outside_repo' | 'read_error' | 'concurrent_session' | 'later_session' | 'not_measured';
export type VcsKind = 'git' | 'svn' | 'p4';

/** core の SessionRetention のうち、埋め込みに使う項目 */
export interface RetentionLike {
  outcome: 'measured' | 'no_ai_changes' | 'unattributable';
  reason?: UnattributableReason;
  vcs: VcsKind | null;
  baseline: { source: 'observed' | 'estimated' } | null;
  counts: Record<RetentionStatus, number>;
  lines: Record<RetentionStatus, number>;
  pathMapped?: boolean;
  computedOn?: 'local' | 'sender';
}

export const STATUSES = ['kept', 'modified', 'missing', 'unattributable'] as const satisfies readonly RetentionStatus[];

export const STATUS_LABEL: Record<RetentionStatus, string> = {
  kept: 'そのまま残る',
  modified: '直されて残る',
  missing: '見つからない',
  unattributable: '照合不可',
};

export const REASONS = ['repo_not_found', 'no_vcs', 'baseline_missing', 'outside_repo', 'read_error', 'concurrent_session', 'later_session', 'not_measured'] as const satisfies readonly UnattributableReason[];

export const REASON_LABEL: Record<UnattributableReason, string> = {
  repo_not_found: '作業フォルダがこの PC に無い',
  no_vcs: 'VCS の管理下でない',
  baseline_missing: '開始時の基準を決められない',
  outside_repo: 'リポジトリの外のファイル',
  read_error: 'VCS かファイルを読めなかった',
  concurrent_session: '時間の重なる別のセッションと同じ行',
  later_session: '後のセッションも同じ行を足した',
  not_measured: '送った側で照合していない',
};

export const VCS_LABEL: Record<VcsKind, string> = { git: 'Git', svn: 'SVN', p4: 'Perforce' };

/** [そのまま残る, 直されて残る, 見つからない, 照合不可] */
export type StatusTuple = [kept: number, modified: number, missing: number, unattributable: number];

/** セッション 1 件の照合の結果(埋め込み用。パスは持たない) */
export interface RetentionItem {
  /** measured = 照合できた(分母に入る)、none = 数える AI の変更が無い、unattributable = すべて照合不可 */
  outcome: 'measured' | 'none' | 'unattributable';
  reason: UnattributableReason | null;
  vcs: VcsKind | null;
  /** 開始時の基準。observed = ログの記録、estimated = 時刻から推定 */
  baseline: 'observed' | 'estimated' | null;
  /** 照合した場所。sender = 送った側の PC */
  on: 'local' | 'sender';
  /** 設定のパスの読み替えを使った */
  mapped: boolean;
  /** まとまりの数(状態別) */
  hunks: StatusTuple;
  /** 行の数(状態別) */
  lines: StatusTuple;
}

/** 照合の全体の条件(ReportData.retention) */
export interface RetentionMeta {
  generatedAt: string;
  /** local = この PC で照合した、sender = 送り先から集計し、送った側の結果を読んだ */
  computedOn: 'local' | 'sender';
  mode: 'worktree' | 'committed';
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

export function retentionItem(r: RetentionLike): RetentionItem {
  return {
    outcome: r.outcome === 'no_ai_changes' ? 'none' : r.outcome,
    reason: r.reason ?? null,
    vcs: r.vcs,
    baseline: r.baseline?.source ?? null,
    on: r.computedOn ?? 'local',
    mapped: !!r.pathMapped,
    hunks: tuple(r.counts),
    lines: tuple(r.lines),
  };
}

export const MODE_LABEL: Record<RetentionMeta['mode'], string> = { worktree: '今の作業ツリー', committed: '最後に取り込んだ版' };

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
  /** 照合できたセッションの VCS の内訳 */
  byVcs: Partial<Record<VcsKind, number>>;
  /** 送った側の PC で照合したもの・パスを読み替えたもの(照合できたセッションのうち) */
  sender: number;
  mapped: number;
  /** 照合できたセッションのまとまりと行(状態別) */
  hunks: StatusTuple;
  lines: StatusTuple;
}

/** 照合の結果を集計する(照合できたセッションだけを分母にし、照合の範囲を一緒に数える) */
export function aggregateRetention(sessions: readonly { retention?: RetentionItem | null }[]): RetentionAgg {
  const a: RetentionAgg = { sessions: sessions.length, notChecked: 0, none: 0, withAi: 0, measured: 0, unattributable: {}, unattributableTotal: 0, baseline: { observed: 0, estimated: 0 }, byVcs: {}, sender: 0, mapped: 0, hunks: zero(), lines: zero() };
  for (const s of sessions) {
    const r = s.retention;
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
      const k = r.reason ?? 'read_error';
      a.unattributable[k] = (a.unattributable[k] ?? 0) + 1;
      a.unattributableTotal++;
      continue;
    }
    a.measured++;
    if (r.baseline === 'estimated') a.baseline.estimated++;
    else if (r.baseline === 'observed') a.baseline.observed++;
    if (r.vcs) a.byVcs[r.vcs] = (a.byVcs[r.vcs] ?? 0) + 1;
    if (r.on === 'sender') a.sender++;
    if (r.mapped) a.mapped++;
    add(a.hunks, r.hunks);
    add(a.lines, r.lines);
  }
  return a;
}

/** 照合できたまとまり(未変更・変更後・未確認。照合不可は除く)の数 */
export const measuredOf = (t: StatusTuple): number => t[0] + t[1] + t[2];

/** 照合できたまとまりに対する割合(分母が 0 なら null) */
export function shareOf(t: StatusTuple, i: 0 | 1 | 2): number | null {
  const d = measuredOf(t);
  return d > 0 ? t[i] / d : null;
}
