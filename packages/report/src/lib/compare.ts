// 「比べる」の節: 2 つの条件(タスクタグ・期間・プロジェクト)のセッションの指標を並べる。工程は依頼(ターン)の単位で並べる。
// 差は相関で、条件の違いが原因とは限らない。
import { localDayStart, sessionTime } from './filter.ts';
import { PHASES, type Phase, type TurnBucket } from '../../../core/src/turns.ts';
import { aggregateRetention, measuredOf, median, retentionByPhase, type RetentionAgg, type StatusTuple } from './retention.ts';
import { turnAggregate } from './turns.ts';
import type { SessionSummary } from './types.ts';

/** 割合を出す最小のセッション数(改善点の率と同じ 5) */
export const COMPARE_MIN_SESSIONS = 5;

export const COMPARE_KINDS = ['tag', 'period', 'project', 'phase'] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];
export const COMPARE_KIND_LABEL: Record<CompareKind, string> = { tag: 'タスクタグ', period: '期間', project: 'プロジェクト', phase: '工程' };

export type CompareSession = Pick<SessionSummary, 'id' | 'turns' | 'activeMs' | 'tools' | 'friction' | 'analysis' | 'tokens' | 'retention' | 'createdAt' | 'updatedAt' | 'project' | 'turnRows'>;

export interface CompareSide {
  sessions: number;
  turns: number;
  /** 実働の合計と、記録のあったセッション数 */
  activeMs: number;
  activeKnown: number;
  tools: number;
  toolFailures: number;
  /** 同じファイルを依頼をまたいで編集し直したセッション(手戻り) */
  reworkSessions: number;
  nanoAiu: number;
  aiuKnown: number;
  retention: RetentionAgg;
}

export function compareSide(list: readonly CompareSession[]): CompareSide {
  const s: CompareSide = { sessions: list.length, turns: 0, activeMs: 0, activeKnown: 0, tools: 0, toolFailures: 0, reworkSessions: 0, nanoAiu: 0, aiuKnown: 0, retention: aggregateRetention(list) };
  for (const x of list) {
    s.turns += x.turns;
    if (x.activeMs != null) {
      s.activeMs += x.activeMs;
      s.activeKnown++;
    }
    s.tools += x.tools.total;
    s.toolFailures += x.friction.toolFailures;
    if ((x.analysis?.filesReedited ?? 0) > 0) s.reworkSessions++;
    if (x.tokens.nanoAiu != null) {
      s.nanoAiu += x.tokens.nanoAiu;
      s.aiuKnown++;
    }
  }
  return s;
}

/** 割合(分母が 0 か、セッションが少なすぎるときは null) */
export function rate(part: number, whole: number, sessions: number): number | null {
  if (sessions < COMPARE_MIN_SESSIONS || whole <= 0) return null;
  return part / whole;
}

/** 比べる指標の行。value は表示する値(null は「—」)。note は数え方 */
export interface CompareRow {
  key: string;
  label: string;
  /** 'count' は件数・合計、'rate' は割合(0〜1)、'mean' は 1 セッションあたり */
  unit: 'count' | 'rate' | 'mean' | 'minutes' | 'aiu' | 'days';
  a: number | null;
  b: number | null;
  note: string;
}

/** 平均。分母(記録のあったセッションの数)が少なすぎるときは null(全セッションの数ではなく、実際に割る数で決める) */
const perSession = (v: number, n: number): number | null => (n < COMPARE_MIN_SESSIONS ? null : v / n);

export function compareRows(a: CompareSide, b: CompareSide): CompareRow[] {
  const row = (key: string, label: string, unit: CompareRow['unit'], f: (s: CompareSide) => number | null, note: string): CompareRow => ({ key, label, unit, a: f(a), b: f(b), note });
  const keptShare = (s: CompareSide): number | null => (s.retention.measured < COMPARE_MIN_SESSIONS ? null : measuredOf(s.retention.hunks) ? (s.retention.hunks[0] + s.retention.hunks[1]) / measuredOf(s.retention.hunks) : null);
  const missingShare = (s: CompareSide): number | null => (s.retention.measured < COMPARE_MIN_SESSIONS ? null : measuredOf(s.retention.hunks) ? s.retention.hunks[2] / measuredOf(s.retention.hunks) : null);
  return [
    row('sessions', 'セッション', 'count', (s) => s.sessions, ''),
    row('turns', '依頼 / セッション', 'mean', (s) => perSession(s.turns, s.sessions), '平均'),
    row('active', '実働 / セッション', 'minutes', (s) => perSession(s.activeMs, s.activeKnown), '実働の記録があるセッションの平均(5 件未満なら —)'),
    row('failure', 'ツールの失敗・拒否の率', 'rate', (s) => rate(s.toolFailures, s.tools, s.sessions), '失敗・拒否 ÷ ツール呼び出し'),
    row('rework', '手戻りのあったセッションの割合', 'rate', (s) => rate(s.reworkSessions, s.sessions, s.sessions), '依頼をまたいで同じファイルを編集し直した'),
    row('aiu', 'AIU / セッション', 'aiu', (s) => perSession(s.nanoAiu / 1e9, s.aiuKnown), '記録があるセッションの平均(5 件未満なら —)'),
    row('retention-measured', '照合できたセッション(AI の変更の残存の分母)', 'count', (s) => s.retention.measured, 'AI の変更があったセッションのうち'),
    row('retention-kept', '残っている(そのまま + 直されて)割合', 'rate', keptShare, '照合できたまとまりに対する割合。照合できたセッションが 5 未満なら —'),
    row('retention-missing', '見つからない割合', 'rate', missingShare, '照合できたまとまりに対する割合'),
    row('retention-lag', 'セッションの終わりから比べた時点まで(中央値)', 'days', (s) => (s.retention.measured < COMPARE_MIN_SESSIONS ? null : median(s.retention.lags)), '照合できたセッション。両側で大きく違うと、後から人が手を入れた時間が違うので残存の割合を比べにくい'),
  ];
}

/**
 * 期間(YYYY-MM-DD の両端を含む。空はその側を限らない)に開始したセッションか。
 * 日付はローカルの日付で、基準の時刻は上の絞り込みと同じ(作成日時、無ければ更新日時。filter.ts の matchesBase と同じ決め方)
 */
export function inPeriod(s: Pick<SessionSummary, 'createdAt' | 'updatedAt'>, from: string, to: string): boolean {
  const t = sessionTime(s);
  if (t == null) return false;
  const start = from ? localDayStart(from) : null;
  const end = to ? localDayStart(to) : null;
  return (start == null || t >= start) && (end == null || t < end + 24 * 3600 * 1000);
}

/** ローカルの日付の YYYY-MM-DD(日付の入力欄と同じ形) */
const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 最後の日から n 日前までと、その前の n 日(既定の期間の組)。日付はローカルの YYYY-MM-DD */
export function defaultPeriods(lastAt: string | null, days = 30): { a: { from: string; to: string }; b: { from: string; to: string } } {
  const end = lastAt ? new Date(lastAt) : new Date();
  const day = (offset: number): string => localDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - offset));
  // A が前の期間、B が後の期間(左から右へ時間が進む)
  return { a: { from: day(days * 2 - 1), to: day(days) }, b: { from: day(days - 1), to: day(0) } };
}

/** 割合や平均を出す最小の依頼の数(セッションの 5 と同じ考え方) */
export const COMPARE_MIN_TURNS = 5;

/**
 * 工程どうしを、依頼(ターン)の単位で比べる。母集団は渡したセッションの依頼のうち、その工程のもの。
 * AI の変更の残存は、照合できたセッションのまとまりを、作った依頼の工程で分けたもの
 */
export function comparePhaseRows(sessions: readonly CompareSession[], a: Phase, b: Phase): CompareRow[] {
  const agg = turnAggregate(sessions);
  const ret = retentionByPhase(sessions).byPhase;
  const bucket = (p: Phase): TurnBucket => agg.byPhase[p];
  const hunks = (p: Phase): StatusTuple => ret.get(PHASES.indexOf(p)) ?? [0, 0, 0, 0];
  const perTurn = (v: number, n: number): number | null => (n < COMPARE_MIN_TURNS ? null : v / n);
  const share = (part: number, whole: number, n: number): number | null => (n < COMPARE_MIN_TURNS || whole <= 0 ? null : part / whole);
  const row = (key: string, label: string, unit: CompareRow['unit'], f: (p: Phase) => number | null, note: string): CompareRow => ({ key, label, unit, a: f(a), b: f(b), note });
  const retShare = (p: Phase, i: 'kept' | 'missing'): number | null => {
    const t = hunks(p);
    const m = measuredOf(t);
    if (m < COMPARE_MIN_TURNS) return null;
    return i === 'kept' ? (t[0] + t[1]) / m : t[2] / m;
  };
  return [
    row('turns', '依頼', 'count', (p) => bucket(p).turns, '依頼(ターン)の数'),
    row('active', '実働 / 依頼', 'minutes', (p) => perTurn(bucket(p).activeMs, bucket(p).turns), '平均(記録の無い依頼は 0 として足す。5 件未満なら —)'),
    row('failure', 'ツールの失敗・拒否の率', 'rate', (p) => share(bucket(p).toolFailures + bucket(p).denied, bucket(p).tools, bucket(p).turns), '失敗・拒否 ÷ ツール呼び出し'),
    row('stuck', '詰まりのあった依頼の割合', 'rate', (p) => share(bucket(p).stuck, bucket(p).turns, bucket(p).turns), '失敗・拒否・中断・エラー・再編集・文脈圧縮のどれかがあった'),
    row('fix', '次の依頼で直し・差し戻しの割合', 'rate', (p) => share(bucket(p).followedByFix, bucket(p).withNext, bucket(p).turns), '次の依頼があった依頼に対する割合'),
    row('aiu', 'AIU / 依頼', 'aiu', (p) => perTurn(bucket(p).nanoAiu / 1e9, bucket(p).turns), '平均(5 件未満なら —)'),
    row('retention-hunks', '照合できたまとまり', 'count', (p) => measuredOf(hunks(p)), '照合できたセッションの、その工程の依頼で AI が足したまとまり'),
    row('retention-kept', '残っている(そのまま + 直されて)割合', 'rate', (p) => retShare(p, 'kept'), '照合できたまとまりに対する割合(5 件未満なら —)'),
    row('retention-missing', '見つからない割合', 'rate', (p) => retShare(p, 'missing'), '照合できたまとまりに対する割合'),
  ];
}
