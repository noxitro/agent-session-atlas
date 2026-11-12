// 「比べる」の節: 2 つの条件(タスクタグ・期間・プロジェクト)のセッションの指標を並べる。
// 人ごとの比較はしない(集計の粒度は glossary の「集計の粒度」)。差は相関で、条件の違いが原因とは限らない。
import { localDayStart, sessionTime } from './filter.ts';
import { aggregateRetention, measuredOf, type RetentionAgg } from './retention.ts';
import type { SessionSummary } from './types.ts';

/** 割合を出す最小のセッション数(改善点の率と同じ 5) */
export const COMPARE_MIN_SESSIONS = 5;

export const COMPARE_KINDS = ['tag', 'period', 'project'] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];
export const COMPARE_KIND_LABEL: Record<CompareKind, string> = { tag: 'タスクタグ', period: '期間', project: 'プロジェクト' };

export type CompareSession = Pick<SessionSummary, 'id' | 'turns' | 'activeMs' | 'tools' | 'friction' | 'analysis' | 'tokens' | 'retention' | 'createdAt' | 'updatedAt' | 'project'>;

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

/** 比べる指標の行。value は表示する値(null は「—」)。kind は値の種類(観測・推定) */
export interface CompareRow {
  key: string;
  label: string;
  /** 'count' は件数・合計、'rate' は割合(0〜1)、'mean' は 1 セッションあたり */
  unit: 'count' | 'rate' | 'mean' | 'minutes' | 'aiu';
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
    row('sessions', 'セッション', 'count', (s) => s.sessions, '観測'),
    row('turns', '依頼 / セッション', 'mean', (s) => perSession(s.turns, s.sessions), '観測。平均'),
    row('active', '実働 / セッション', 'minutes', (s) => perSession(s.activeMs, s.activeKnown), '観測。実働の記録があるセッションの平均(5 件未満なら —)'),
    row('failure', 'ツールの失敗・拒否の率', 'rate', (s) => rate(s.toolFailures, s.tools, s.sessions), '観測。失敗・拒否 ÷ ツール呼び出し'),
    row('rework', '手戻りのあったセッションの割合', 'rate', (s) => rate(s.reworkSessions, s.sessions, s.sessions), '観測。依頼をまたいで同じファイルを編集し直した'),
    row('aiu', 'AIU / セッション', 'aiu', (s) => perSession(s.nanoAiu / 1e9, s.aiuKnown), '観測。記録があるセッションの平均(5 件未満なら —)'),
    row('retention-measured', '照合できたセッション(AI の変更の残存の分母)', 'count', (s) => s.retention.measured, '観測。AI の変更があったセッションのうち'),
    row('retention-kept', '残存(未変更 + 変更後)の割合', 'rate', keptShare, '観測。照合できたまとまりに対する割合。照合できたセッションが 5 未満なら —'),
    row('retention-missing', '終了時の差分で未確認の割合', 'rate', missingShare, '観測。不採用の意味ではない'),
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
