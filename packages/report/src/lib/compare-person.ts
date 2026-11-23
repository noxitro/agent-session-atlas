// 「比べる」の人ごとの差: 同じ人の中での差(B − A)を人ごとに出し、その平均と、人を単位にした 95% の幅を出す。
// セッションを互いに独立とみなした「比べる」の幅とは別に、人の違い(人によって作業の中身や結果が似る)の影響を減らすための並べ方。
// 差は相関で、条件の違いが原因とは限らない。DOM や node: に依存しない。LLM は使わない。
import { COMPARE_MIN_SESSIONS, COMPARE_MIN_TURNS, comparePhaseRows, compareRows, compareSide, t975, type CompareRow, type CompareSession } from './compare.ts';
import type { Phase } from '../shared/turns.ts';

/**
 * 人ごとの差を出す行(セッションを単位にした割合と平均)。
 * 手戻りのないセッションの割合・同じファイルを編集し直したセッションの割合・ツールの失敗・拒否の率・テストの結果の 2 行・依頼 / セッション・実働 / セッション・リクエスト / セッション・AIU / セッション。
 * ツールの失敗・拒否の率は呼び出しの単位の割合だが、人ごとの値の差を人の単位で平均するので、幅を出せる。
 * AIU / リクエスト(合計の比)・件数・中央値の行と、AI の変更の残存(下の PERSON_RETENTION_KEY で別に出す)は入れない
 */
export const PERSON_ROW_KEYS = ['no-rework', 'rework', 'failure', 'tests-first-pass', 'tests-last-failing', 'turns', 'active', 'requests', 'aiu'] as const;
/** 工程どうし(依頼の単位)で人ごとの差を出す行 */
export const PERSON_PHASE_ROW_KEYS = ['active', 'failure', 'stuck', 'fix', 'aiu'] as const;
/** AI の変更の残存は、照合できたセッションの数を人ごとに並べ、ほかの行と混ぜずに別に出す */
export const PERSON_RETENTION_KEY = 'retention-kept';
const RETENTION_MEASURED_KEY = 'retention-measured';

/** 人の記録があるか(記録のある人が 2 人以上)。1 人だけなら、人をそろえても全体と同じなので出さない */
export function hasPersons(sessions: readonly Pick<CompareSession, 'person'>[]): boolean {
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.person) seen.add(s.person);
    if (seen.size >= 2) return true;
  }
  return false;
}

export interface PersonGroup {
  person: string;
  /** その人の A と B の件数(セッションの単位ではセッション、工程どうしでは依頼) */
  a: number;
  b: number;
  /** 両方の側にそれぞれ最小の件数(セッションは COMPARE_MIN_SESSIONS、依頼は COMPARE_MIN_TURNS)以上あるか */
  eligible: boolean;
  /** その人のセッションだけで作った「比べる」の行(eligible でない人も、表に並べるために作る) */
  rows: CompareRow[];
  /** 照合できたセッションの数(AI の変更の残存の分母になるセッション)。行が無い(工程どうし以外で照合していない)ときも 0 */
  measuredA: number;
  measuredB: number;
}

export interface PersonPairedRow {
  key: string;
  label: string;
  unit: CompareRow['unit'];
  note: string;
  /** 差を出せた人の数(その人の A と B の値がどちらも出ているもの) */
  persons: number;
  /** 人ごとの差(B − A)の平均。差を出せた人がいなければ null */
  mean: number | null;
  /** 人を単位にした 95% の幅(平均 ± t × 標準偏差 ÷ √人数。t は自由度 = 人数 − 1)。2 人未満なら null */
  ci: [lo: number, hi: number] | null;
  /** 人ごとの差(groups と同じ並び。使えない人・値の出ない人は null) */
  diffs: (number | null)[];
}

export interface PersonPaired {
  /** 人の名前の順 */
  groups: PersonGroup[];
  /** 両方の側に最小の件数以上ある人の数 */
  eligible: number;
  /** 人の記録が無いセッション(人ごとの差に入れていない)の A と B の件数 */
  unassigned: { a: number; b: number };
  /** 件数の単位(セッション・依頼) */
  unit: 'session' | 'turn';
  rows: PersonPairedRow[];
  /** AI の変更の残存の割合の行(照合していない、または工程どうしで残存の行が無いときは null) */
  retention: PersonPairedRow | null;
}

/** t 分布の 97.5% の点(自由度が整数)。自由度 1〜3 は表の値(近似の t975 はこの範囲で小さく出る)、4 以上は t975 */
export function t975Int(df: number): number {
  const table = [12.7062, 4.3027, 3.1824];
  return df >= 1 && df <= 3 ? table[df - 1] : t975(df);
}

/** 人を単位にした平均と 95% の幅。2 人未満なら幅は null。ばらつきが無ければ幅は平均そのもの */
export function pairedMean(diffs: readonly number[]): { mean: number | null; ci: [lo: number, hi: number] | null } {
  const k = diffs.length;
  if (k === 0) return { mean: null, ci: null };
  const m = diffs.reduce((a, b) => a + b, 0) / k;
  if (k < 2) return { mean: m, ci: null };
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (k - 1));
  const half = t975Int(k - 1) * (sd / Math.sqrt(k));
  return { mean: m, ci: [m - half, m + half] };
}

/** 「比べる」の表と数え方の文が違う行(上の表では幅を出さない理由を書いているが、人ごとの差では幅を出す) */
const PERSON_NOTES: Record<string, string> = {
  failure: 'その人の失敗・拒否 ÷ ツール呼び出し。呼び出しの単位の割合だが、人ごとの値の差を人の単位で平均するので幅を出す',
};

const byName = (a: string, b: string): number => a.localeCompare(b);
const valueOf = (rows: readonly CompareRow[], key: string): CompareRow | undefined => rows.find((r) => r.key === key);

function paired(groups: readonly PersonGroup[], key: string): PersonPairedRow | null {
  const first = groups.map((g) => valueOf(g.rows, key)).find((r) => r != null);
  if (!first) return null;
  const diffs = groups.map((g) => {
    const r = valueOf(g.rows, key);
    return g.eligible && r && r.a != null && r.b != null ? r.b - r.a : null;
  });
  const used = diffs.filter((d): d is number => d != null);
  const { mean, ci } = pairedMean(used);
  return { key, label: first.label, unit: first.unit, note: PERSON_NOTES[key] ?? first.note, persons: used.length, mean, ci, diffs };
}

function finish(groups: PersonGroup[], unassigned: { a: number; b: number }, unit: PersonPaired['unit'], keys: readonly string[]): PersonPaired {
  groups.sort((x, y) => byName(x.person, y.person));
  const rows = keys.map((k) => paired(groups, k)).filter((r): r is PersonPairedRow => r != null);
  return { groups, eligible: groups.filter((g) => g.eligible).length, unassigned, unit, rows, retention: paired(groups, PERSON_RETENTION_KEY) };
}

function measured(rows: readonly CompareRow[]): [a: number, b: number] {
  const r = valueOf(rows, RETENTION_MEASURED_KEY);
  return [r?.a ?? 0, r?.b ?? 0];
}

/**
 * セッションの単位の比較(期間・プロジェクト・推論強度・モデル・wiki の参照)の人ごとの差。
 * a と b は「比べる」の A と B の母集団そのもの(同じセッションが両側に入ることもある)。人の記録が無いセッションは入れない
 */
export function personSessionPaired(a: readonly CompareSession[], b: readonly CompareSession[]): PersonPaired {
  const by = new Map<string, { a: CompareSession[]; b: CompareSession[] }>();
  const unassigned = { a: 0, b: 0 };
  const add = (s: CompareSession, side: 'a' | 'b'): void => {
    if (!s.person) {
      unassigned[side]++;
      return;
    }
    (by.get(s.person) ?? by.set(s.person, { a: [], b: [] }).get(s.person)!)[side].push(s);
  };
  for (const s of a) add(s, 'a');
  for (const s of b) add(s, 'b');
  const groups = [...by].map(([person, g]): PersonGroup => {
    const rows = compareRows(compareSide(g.a), compareSide(g.b));
    const [measuredA, measuredB] = measured(rows);
    return { person, a: g.a.length, b: g.b.length, eligible: g.a.length >= COMPARE_MIN_SESSIONS && g.b.length >= COMPARE_MIN_SESSIONS, rows, measuredA, measuredB };
  });
  return finish(groups, unassigned, 'session', PERSON_ROW_KEYS);
}

/** 工程どうし(依頼の単位)の人ごとの差。その人のセッションの依頼のうち、工程が A のものと B のもの */
export function personPhasePaired(sessions: readonly CompareSession[], pa: Phase, pb: Phase): PersonPaired {
  const by = new Map<string, CompareSession[]>();
  const none: CompareSession[] = [];
  for (const s of sessions) {
    if (!s.person) none.push(s);
    else (by.get(s.person) ?? by.set(s.person, []).get(s.person)!).push(s);
  }
  const turnsOf = (rows: readonly CompareRow[]): [a: number, b: number] => {
    const r = valueOf(rows, 'turns');
    return [r?.a ?? 0, r?.b ?? 0];
  };
  const groups = [...by].map(([person, list]): PersonGroup => {
    const rows = comparePhaseRows(list, pa, pb);
    const [a, b] = turnsOf(rows);
    const [measuredA, measuredB] = measured(rows);
    return { person, a, b, eligible: a >= COMPARE_MIN_TURNS && b >= COMPARE_MIN_TURNS, rows, measuredA, measuredB };
  });
  const [ua, ub] = none.length > 0 ? turnsOf(comparePhaseRows(none, pa, pb)) : [0, 0];
  return finish(groups, { a: ua, b: ub }, 'turn', PERSON_PHASE_ROW_KEYS);
}
