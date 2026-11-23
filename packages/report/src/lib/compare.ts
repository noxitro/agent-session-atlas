// 「比べる」の節: 2 つの条件(期間・プロジェクト・推論強度・モデル・wiki の参照)のセッションの指標を並べる。工程は依頼(ターン)の単位で並べる。
// 差は相関で、条件の違いが原因とは限らない。差の幅(95%)は、セッションを互いに独立とみなした近似(同じ人のセッションの似かたは入れていない)。
// 人の違いを減らした比べ方(人ごとの差の平均と、人を単位にした幅)は lib/compare-person.ts。
import { EFFORT_ORDER, orderBy } from './exec.ts';
import { localDayStart, sessionTime } from './filter.ts';
import { mainEffortOf, mainModelsOf } from './main-effort.ts';
import { PHASES, REQUEST_KINDS, type Phase, type TurnBucket } from '../shared/turns.ts';
import { aggregateRetention, enoughMeasured, measuredOf, median, MODE_LABEL, modeDiffer, modeMix, REASON_LABEL, RETENTION_MIN_SESSIONS, RETENTION_MODES, retentionByPhase, shareOf, unattributableByCount, type RetentionAgg, type StatusTuple } from './retention.ts';
import { turnAggregate, type TurnTuple } from './turns.ts';
import type { SessionSummary } from './types.ts';
import { wikiReferenced } from './wiki.ts';

/** 割合を出す最小のセッション数(改善点の率と同じ 5) */
export const COMPARE_MIN_SESSIONS = 5;

export const COMPARE_KINDS = ['period', 'project', 'phase', 'effort', 'model', 'wiki'] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];
export const COMPARE_KIND_LABEL: Record<CompareKind, string> = { period: '期間', project: 'プロジェクト', phase: '工程', effort: '推論強度', model: 'モデル', wiki: 'wiki の参照' };

export type CompareSession = Pick<
  SessionSummary,
  'id' | 'turns' | 'activeMs' | 'tools' | 'friction' | 'analysis' | 'tokens' | 'retention' | 'createdAt' | 'updatedAt' | 'project' | 'turnRows' | 'person' | 'models' | 'tests'
> & {
  /** wiki の参照で比べるときに使う(作りかけの値では無いことがある。無ければ参照していないとして読む) */
  wiki?: SessionSummary['wiki'] | null;
  /** 推論強度の比較に使う(古い埋め込み・テストの作りかけの値では無いことがある) */
  exec?: Pick<SessionSummary['exec'], 'mainModelEfforts'>;
};

/** 依頼の数で分けるときの境目(この数以上を「多い」側に入れる) */
export const COMPARE_LONG_TURNS = 5;

const FIX_KIND = REQUEST_KINDS.indexOf('fix');
const REVERT_KIND = REQUEST_KINDS.indexOf('revert');

/**
 * 依頼の行からの手戻りの有無。null は採点できない(依頼の行が 2 件未満)。
 * 手戻りあり = 2 件目以降の依頼の種類が直し(fix)か差し戻し(revert)、または、どれかの依頼に中断がある
 */
export function reworkOfTurns(rows: readonly TurnTuple[] | undefined): boolean | null {
  if (!rows || rows.length < 2) return null;
  return rows.some((x, i) => (i > 0 && (x[1] === FIX_KIND || x[1] === REVERT_KIND)) || x[7] > 0);
}

/** 採点できたセッションの数(割合の分母)と、そのうち当たったものの数(手戻りの行では手戻りの無かった数) */
export interface ScoredCount {
  scored: number;
  clean: number;
}

export interface CompareSide {
  sessions: number;
  tools: number;
  toolFailures: number;
  /** 同じファイルを依頼をまたいで編集し直したセッション */
  reworkSessions: number;
  /** AIU とリクエストの両方の記録があるセッションの数と、その AIU とリクエストの合計(AIU / リクエストの分子と分母) */
  aiuRequestSessions: number;
  aiuForRequests: number;
  requestsWithAiu: number;
  /** 手戻りのないセッション(依頼の行が 2 件以上のもの。全体・2〜4 件・5 件以上) */
  noRework: ScoredCount;
  noReworkShort: ScoredCount;
  noReworkLong: ScoredCount;
  /**
   * テストの結果(テストを実行したセッションだけ。scored はテストを実行したセッションの数)。
   * firstPass の clean は最初の実行で全部通ったもの、lastFailing の clean は最後の実行の後に通っていないテストが残ったもの
   */
  testsFirstPass: ScoredCount;
  testsLastFailing: ScoredCount;
  /** セッションごとの値(平均と、その差の幅に使う。記録の無いセッションは入れない) */
  values: { turns: number[]; activeMs: number[]; aiu: number[]; requests: number[] };
  retention: RetentionAgg;
}

export function compareSide(list: readonly CompareSession[]): CompareSide {
  const s: CompareSide = {
    sessions: list.length,
    tools: 0,
    toolFailures: 0,
    reworkSessions: 0,
    aiuRequestSessions: 0,
    aiuForRequests: 0,
    requestsWithAiu: 0,
    noRework: { scored: 0, clean: 0 },
    noReworkShort: { scored: 0, clean: 0 },
    noReworkLong: { scored: 0, clean: 0 },
    testsFirstPass: { scored: 0, clean: 0 },
    testsLastFailing: { scored: 0, clean: 0 },
    values: { turns: [], activeMs: [], aiu: [], requests: [] },
    retention: aggregateRetention(list),
  };
  for (const x of list) {
    s.values.turns.push(x.turns);
    if (x.activeMs != null) s.values.activeMs.push(x.activeMs);
    s.tools += x.tools.total;
    s.toolFailures += x.friction.toolFailures;
    if ((x.analysis?.filesReedited ?? 0) > 0) s.reworkSessions++;
    const aiu = x.tokens.nanoAiu;
    const req = x.tokens.requests;
    if (aiu != null) s.values.aiu.push(aiu / 1e9);
    if (req != null) s.values.requests.push(req);
    if (aiu != null && req != null) {
      s.aiuRequestSessions++;
      s.aiuForRequests += aiu;
      s.requestsWithAiu += req;
    }
    // テストの記録が無いセッション(実行 0 回)は、どちらの割合の分母にも入れない
    if (x.tests) {
      s.testsFirstPass.scored++;
      s.testsLastFailing.scored++;
      if (x.tests.firstPass === 1) s.testsFirstPass.clean++;
      if (x.tests.lastFailing > 0) s.testsLastFailing.clean++;
    }
    const rework = reworkOfTurns(x.turnRows);
    if (rework != null) {
      const n = x.turnRows!.length;
      for (const c of [s.noRework, n >= COMPARE_LONG_TURNS ? s.noReworkLong : s.noReworkShort]) {
        c.scored++;
        if (!rework) c.clean++;
      }
    }
  }
  return s;
}

/** 割合(分母が 0 か、セッションが少なすぎるときは null) */
export function rate(part: number, whole: number, sessions: number): number | null {
  if (sessions < COMPARE_MIN_SESSIONS || whole <= 0) return null;
  return part / whole;
}

/** 正規分布の 97.5% の点(両側 95%。画面と用語の説明に書いている 1.96) */
const Z95 = 1.96;

/** 割合 x / n の Wilson の区間(95%。n が 0 なら null) */
export function wilson(x: number, n: number): [lo: number, hi: number] | null {
  if (n <= 0) return null;
  const p = x / n;
  const z2 = Z95 * Z95;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * 2 つの割合の差(B − A = xb / nb − xa / na)の 95% の幅。Newcombe の方法(それぞれの Wilson の区間から作る。Newcombe 1998 の method 10)。
 * どちらかの分母が 0 なら null
 */
export function newcombeDiff(xa: number, na: number, xb: number, nb: number): [lo: number, hi: number] | null {
  const wa = wilson(xa, na);
  const wb = wilson(xb, nb);
  if (!wa || !wb) return null;
  const pa = xa / na;
  const pb = xb / nb;
  const d = pb - pa;
  return [d - Math.sqrt((pb - wb[0]) ** 2 + (wa[1] - pa) ** 2), d + Math.sqrt((wb[1] - pb) ** 2 + (pa - wa[0]) ** 2)];
}

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
/** 標本分散(n − 1 で割る) */
const variance = (v: readonly number[]): number => {
  const m = mean(v);
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
};

/**
 * t 分布の 97.5% の点(両側 95%)。自由度が小さいほど 1.96 より大きい(自由度 4 で 2.78、10 で 2.23、30 で 2.04)。
 * 正規分布の点からの展開(Cornish–Fisher)で、自由度 4 以上なら誤差は 0.001 ほど。それより小さい自由度では実際より小さく出る
 */
export function t975(df: number): number {
  const z = Z95;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  const z9 = z ** 9;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3) +
    (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4)
  );
}

/**
 * 平均の差(B − A)の 95% の幅。Welch の方法(差 ± t × 標準誤差。等分散を仮定せず、t は Welch–Satterthwaite の自由度での 97.5% の点。
 * 件数が少ないほど 1.96 より大きい)。どちらかが 2 件未満なら null。どちらもばらつきが無ければ、幅は差そのもの
 */
export function welchDiff(a: readonly number[], b: readonly number[]): [lo: number, hi: number] | null {
  if (a.length < 2 || b.length < 2) return null;
  const d = mean(b) - mean(a);
  const ea = variance(a) / a.length;
  const eb = variance(b) / b.length;
  const se = Math.sqrt(ea + eb);
  if (!Number.isFinite(se)) return null;
  if (se === 0) return [d, d];
  const df = (ea + eb) ** 2 / (ea ** 2 / (a.length - 1) + eb ** 2 / (b.length - 1));
  const half = t975(df) * se;
  return [d - half, d + half];
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
  /** 差(B − A)の 95% の幅(値の単位は a・b と同じ)。null は件数が足りない(「—」)、無いのはその行には出さない */
  ci?: [lo: number, hi: number] | null;
}

/** 残っている(そのまま + 直されて)割合。分母が 0 のときと、照合できたセッションが足りないときは null */
function keptOf(t: StatusTuple, measuredSessions: number): number | null {
  const m = measuredOf(t);
  return m > 0 && enoughMeasured(measuredSessions) ? (t[0] + t[1]) / m : null;
}

/** 両側の分母が足りるときだけ幅を出す */
const enough = (na: number, nb: number): boolean => na >= COMPARE_MIN_SESSIONS && nb >= COMPARE_MIN_SESSIONS;

/**
 * セッションの単位の行。byTurnCount を付けると、手戻りのないセッションの割合を依頼の数で分けた 2 行も出す
 * (推論強度どうしの比較で使う。依頼の数が違うだけで割合が動くのを見分ける)
 */
export function compareRows(a: CompareSide, b: CompareSide, o: { byTurnCount?: boolean } = {}): CompareRow[] {
  const row = (key: string, label: string, unit: CompareRow['unit'], f: (s: CompareSide) => number | null, note: string): CompareRow => ({ key, label, unit, a: f(a), b: f(b), note });
  /** 割合の行(分母がセッション)。値と、Newcombe の幅 */
  const share = (key: string, label: string, c: (s: CompareSide) => ScoredCount, note: string): CompareRow => {
    const ca = c(a);
    const cb = c(b);
    const v = (x: ScoredCount): number | null => (x.scored < COMPARE_MIN_SESSIONS ? null : x.clean / x.scored);
    return { key, label, unit: 'rate', a: v(ca), b: v(cb), note, ci: enough(ca.scored, cb.scored) ? newcombeDiff(ca.clean, ca.scored, cb.clean, cb.scored) : null };
  };
  /** 平均の行。値と、Welch の幅。記録のあったセッションが少なすぎるときは null(全セッションの数ではなく、実際に割る数で決める) */
  const avg = (key: string, label: string, unit: CompareRow['unit'], v: (s: CompareSide) => number[], note: string): CompareRow => {
    const va = v(a);
    const vb = v(b);
    const m = (x: number[]): number | null => (x.length < COMPARE_MIN_SESSIONS ? null : mean(x));
    return { key, label, unit, a: m(va), b: m(vb), note, ci: enough(va.length, vb.length) ? welchDiff(va, vb) : null };
  };
  // 残存の割合を出すかは、残存の節と同じ決まり(照合できたセッションが RETENTION_MIN_SESSIONS 以上)。
  // 側の中で比べた版(worktree・committed・fixed)が混ざっていれば、違う時点との比べを足すことになるので、その側は出さない(modeMix)。
  // A と B の版がそれぞれ 1 つに決まっていても互いに違えば、違う時点の版と比べたもの同士になるので、両側とも出さない(modeDiffer。版の記録の無い古い結果は違うとみなさない)
  const differ = modeDiffer(a.retention, b.retention) != null;
  const mixed = (s: CompareSide): boolean => differ || modeMix(s.retention) != null;
  const keptShare = (s: CompareSide): number | null => (mixed(s) ? null : keptOf(s.retention.hunks, s.retention.measured));
  const missingShare = (s: CompareSide): number | null => (mixed(s) ? null : shareOf(s.retention.hunks, 2, s.retention.measured));
  // 日数は、側の中で版が混ざっていなければ出す(A と B で版が違っても、それぞれの側の日数には意味があるので並べる)
  const lagMedian = (s: CompareSide): number | null => (modeMix(s.retention) != null || !enoughMeasured(s.retention.measured) ? null : median(s.retention.lags));
  const base: CompareRow[] = [
    row('sessions', 'セッション', 'count', (s) => s.sessions, ''),
    share('no-rework', '手戻りのないセッションの割合', (s) => s.noRework, '採点できたセッションのうち、2 件目以降の依頼に直し・差し戻しが無く、どの依頼にも中断が無かったもの'),
    ...(o.byTurnCount
      ? [
          share('no-rework-short', `手戻りのないセッションの割合(依頼 2〜${COMPARE_LONG_TURNS - 1} 件)`, (s) => s.noReworkShort, '依頼の数が違うだけで割合が動くため、依頼の数で分けたもの'),
          share('no-rework-long', `手戻りのないセッションの割合(依頼 ${COMPARE_LONG_TURNS} 件以上)`, (s) => s.noReworkLong, '同上'),
        ]
      : []),
    row('scored', '採点できたセッション', 'count', (s) => s.noRework.scored, '依頼の記録が 2 件以上あるセッション(手戻りのないセッションの割合の分母)。1 件だけのセッションは採点できない'),
    avg('turns', '依頼 / セッション', 'mean', (s) => s.values.turns, '平均'),
    avg('active', '実働 / セッション', 'minutes', (s) => s.values.activeMs, '実働の記録があるセッションの平均(5 件未満なら —)'),
    avg('requests', 'リクエスト / セッション', 'mean', (s) => s.values.requests, 'リクエストの記録があるセッションの平均'),
    avg('aiu', 'AIU / セッション', 'aiu', (s) => s.values.aiu, '記録があるセッションの平均(5 件未満なら —)。ばらつきが大きいので、AIU / リクエストとリクエスト / セッションに分けて読む'),
    row('aiu-per-request', 'AIU / リクエスト', 'aiu', (s) => (s.aiuRequestSessions < COMPARE_MIN_SESSIONS || s.requestsWithAiu <= 0 ? null : s.aiuForRequests / 1e9 / s.requestsWithAiu), 'AIU とリクエストの両方の記録があるセッションの、AIU の合計 ÷ リクエストの合計(5 件未満なら —)'),
    row('failure', 'ツールの失敗・拒否の率', 'rate', (s) => rate(s.toolFailures, s.tools, s.sessions), '失敗・拒否 ÷ ツール呼び出し(呼び出しの単位なので差の幅は出さない)'),
    {
      ...row('rework', '同じファイルを編集し直したセッションの割合', 'rate', (s) => rate(s.reworkSessions, s.sessions, s.sessions), '依頼をまたいで同じファイルを編集し直した(手戻りのないセッションとは別の数え方)'),
      ci: enough(a.sessions, b.sessions) ? newcombeDiff(a.reworkSessions, a.sessions, b.reworkSessions, b.sessions) : null,
    },
    row('tests-scored', 'テストを実行したセッション', 'count', (s) => s.testsFirstPass.scored, 'テストの結果の記録が 1 回以上あるセッション(テストの結果の 2 行の分母)'),
    share('tests-first-pass', '最初のテストの実行で全部通ったセッションの割合', (s) => s.testsFirstPass, 'テストを実行したセッション(テストの結果の記録が 1 回以上あるもの)のうち、最初の実行で全部通ったもの。最初の実行は、そのとき走らせたテストだけの結果。テストを走らせるか・いつ走らせるかは条件で変わりうるので、テストを実行したセッションの数も見比べる'),
    share('tests-last-failing', '最後に通っていないテストが残ったセッションの割合', (s) => s.testsLastFailing, 'テストを実行したセッションのうち、最後の実行の後に通っていないテストがあるもの(未達と、通った後に不合格)。小さいほど良い'),
    row('retention-measured', '照合できたセッション(AI の変更の残存の分母)', 'count', (s) => s.retention.measured, 'AI の変更があったセッションのうち'),
    row('retention-kept', '残っている(そのまま + 直されて)割合', 'rate', keptShare, `単位はまとまり。照合できたまとまり(照合不可を除く)に対する、そのまま残る + 直されて残るの割合。照合できたセッションが ${RETENTION_MIN_SESSIONS} 件未満か、比べた版が側の中で混ざっているか、A と B で違えば —`),
    row('retention-missing', '見つからない割合', 'rate', missingShare, '単位はまとまり。照合できたまとまりに対する、見つからないの割合(比べた版が側の中で混ざっているか、A と B で違えば —)'),
    row('retention-lag', 'セッションの終わりから比べた時点まで(中央値)', 'days', lagMedian, '照合できたセッション。両側で大きく違うと、後から人が手を入れた時間が違うので残存の割合を比べにくい(比べた版が側の中で混ざっていれば —。A と B で版が違っても、それぞれの側の日数は出す)'),
  ];
  return [...base, ...retentionDetailRows(a.retention, b.retention)];
}

/** 照合不可の理由を、両側を合わせて多い順にこの数だけ行にする(残りは「その他の理由」の 1 行) */
export const RETENTION_REASON_ROWS = 3;

/**
 * AI の変更の残存の、割合のほかに並べる行(AGENTS.md の決まり): 開始時の基準の記録・推定の件数、比べた版の内訳、
 * 照合不可の理由別の件数(両側を合わせて多い順に RETENTION_REASON_ROWS 件と、その他)。どれも件数の行で、差は出さない。
 * pool は工程どうし: 両側を同じセッションの母集団から作るので、a と b に同じ母集団の集計を渡し、見出しに「母集団」と書く
 */
export function retentionDetailRows(a: RetentionAgg, b: RetentionAgg, o: { pool?: boolean } = {}): CompareRow[] {
  const pool = o.pool ?? false;
  const label = (s: string): string => (pool ? `${s}(母集団)` : s);
  const where = pool ? '母集団(A と B の両方を作るセッション)の照合できたセッションのうち' : '照合できたセッションのうち';
  const count = (key: string, l: string, f: (r: RetentionAgg) => number, note: string): CompareRow => ({ key, label: label(l), unit: 'count', a: f(a), b: f(b), note: pool ? `${note}。工程どうしは同じセッションから両側を作るので、A と B に同じ数を並べる` : note });
  const rows: CompareRow[] = [
    count('retention-baseline-observed', '開始時の基準: 記録', (r) => r.baseline.observed, `${where}、開始時の基準がログに残った開始時のコミット(記録)のもの`),
    count('retention-baseline-estimated', '開始時の基準: 推定', (r) => r.baseline.estimated, `${where}、開始時の基準を開始時刻から探した版(推定)のもの。記録と推定は分けて読む`),
  ];
  for (const m of RETENTION_MODES) {
    if ((a.modes?.[m] ?? 0) + (b.modes?.[m] ?? 0) === 0) continue;
    rows.push(count(`retention-mode-${m}`, `比べた版: ${MODE_LABEL[m]}`, (r) => r.modes?.[m] ?? 0, pool ? `${where}、${m} で比べたもの。混ざっていれば残存の割合は出さない` : `${where}、${m} で比べたもの。側の中で混ざっているか、A と B で違えば残存の割合は出さない`));
  }
  rows.push(count('retention-unattributable', '照合不可のセッション', (r) => r.unattributableTotal, 'AI の変更はあるが、どのまとまりも照合できなかったセッション(残存の割合の分母に入れない)'));
  // 理由は両側を合わせて多い順(同じ数なら REASONS の順)
  const both: RetentionAgg['unattributable'] = {};
  for (const r of pool ? [a] : [a, b]) for (const [k, n] of unattributableByCount(r)) both[k] = (both[k] ?? 0) + n;
  const order = unattributableByCount({ unattributable: both }).map(([k]) => k);
  const top = order.slice(0, RETENTION_REASON_ROWS);
  for (const k of top) rows.push(count(`retention-unattributable-${k}`, `照合不可: ${REASON_LABEL[k]}`, (r) => r.unattributable[k] ?? 0, '照合不可のセッションの理由別の件数'));
  const rest = order.slice(RETENTION_REASON_ROWS);
  if (rest.length) rows.push(count('retention-unattributable-other', '照合不可: その他の理由', (r) => rest.reduce((n, k) => n + (r.unattributable[k] ?? 0), 0), `上の ${RETENTION_REASON_ROWS} つのほかの理由(${rest.map((k) => REASON_LABEL[k]).join('・')})`));
  return rows;
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

// ---------- 推論強度どうし ----------

type EffortSource = Pick<CompareSession, 'exec' | 'models' | 'createdAt' | 'updatedAt' | 'person'>;

/** 本体のリクエストがあるモデルと、そのセッションの数(多い順。同数は名前の順) */
export function effortModels(sessions: readonly EffortSource[]): { model: string; sessions: number }[] {
  const n = new Map<string, number>();
  for (const s of sessions) for (const m of mainModelsOf(s.exec?.mainModelEfforts)) n.set(m, (n.get(m) ?? 0) + 1);
  return [...n].map(([model, c]) => ({ model, sessions: c })).sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model));
}

/** モデルの本体が、その強度と決まったセッションの数(強度の並び: none → max) */
export function effortChoices(sessions: readonly EffortSource[], model: string): { effort: string; sessions: number }[] {
  const n = new Map<string, number>();
  for (const s of sessions) {
    const m = mainEffortOf(s.exec?.mainModelEfforts);
    if (m.kind === 'decided' && m.model === model) n.set(m.effort, (n.get(m.effort) ?? 0) + 1);
  }
  const order = orderBy(EFFORT_ORDER);
  return [...n].map(([effort, c]) => ({ effort, sessions: c })).sort((a, b) => order(a.effort, b.effort));
}

/** 既定の A と B: medium と xhigh があればそれ、無ければセッションの多い順の 2 つ(並びは弱い順) */
export function defaultEfforts(choices: readonly { effort: string; sessions: number }[]): [a: string, b: string] {
  const has = (e: string): boolean => choices.some((c) => c.effort === e);
  if (has('medium') && has('xhigh')) return ['medium', 'xhigh'];
  const top = [...choices].sort((x, y) => y.sessions - x.sessions).slice(0, 2).map((c) => c.effort);
  const order = orderBy(EFFORT_ORDER);
  top.sort(order);
  return [top[0] ?? '', top[1] ?? top[0] ?? ''];
}

/** 本体の強度の決まり方(選んだモデルの中での)。null はそのモデルのセッションでない */
type EffortClass = { kind: 'decided'; effort: string } | { kind: 'mixed' } | { kind: 'none' };

/**
 * 選んだモデルのセッションか、どの強度と決まったか。
 * そのモデルのセッション = 本体のリクエストにそのモデルがある(記録が無ければ、セッションのモデルの一覧にある)
 */
function effortClass(s: EffortSource, model: string): EffortClass | null {
  const main = s.exec?.mainModelEfforts;
  const m = mainEffortOf(main);
  if (m.kind === 'decided') return m.model === model ? { kind: 'decided', effort: m.effort } : null;
  const models = mainModelsOf(main);
  const inModel = models.length > 0 ? models.includes(model) : (s.models ?? []).includes(model);
  return inModel ? m : null;
}

/** その日を含む週の月曜(ローカルの日付の YYYY-MM-DD) */
export function weekStart(ms: number): string {
  const d = new Date(ms);
  const back = (d.getDay() + 6) % 7;
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

export interface EffortWeekRow {
  /** 利用者(byPerson のときだけ。記録の無いセッションは null) */
  person: string | null;
  /** 週の月曜(YYYY-MM-DD) */
  week: string;
  a: number;
  b: number;
  mixed: number;
  none: number;
}

export interface EffortSplit<T> {
  a: T[];
  b: T[];
  /** 選んだモデル・期間の中で、本体の強度が混在のセッションと、記録の無いセッションの数 */
  mixed: number;
  none: number;
  /** 利用者の記録が 1 件でもあるか(無ければ weeks は週ごとの行だけ) */
  byPerson: boolean;
  /** 利用者 × 週ごとの、A・B・混在・記録なしのセッション数(割り当てどおりに使われたかを見る)。利用者の名前の順(記録の無いものは最後)、同じ人は週の順 */
  weeks: EffortWeekRow[];
}

/**
 * 推論強度どうしの母集団: 期間に開始し、本体が (model, a) と決まったセッションと (model, b) と決まったセッション。
 * 同じ分類から、混在・記録なしの件数と、利用者 × 週の表も作る(A・B のどちらでもない強度のセッションは、どれにも数えない)。
 * a と b が同じなら、両側に同じセッションが入る(プロジェクトで同じものを選んだときと同じ)
 */
export function effortSplit<T extends EffortSource>(sessions: readonly T[], model: string, a: string, b: string, from: string, to: string): EffortSplit<T> {
  const byPerson = sessions.some((s) => s.person != null && s.person !== '');
  const out: EffortSplit<T> = { a: [], b: [], mixed: 0, none: 0, byPerson, weeks: [] };
  const weeks = new Map<string, EffortWeekRow>();
  for (const s of sessions) {
    // 期間に入るセッションには、開始の時刻が必ずある
    const t = sessionTime(s);
    if (t == null || !inPeriod(s, from, to)) continue;
    const c = effortClass(s, model);
    if (!c) continue;
    const isA = c.kind === 'decided' && c.effort === a;
    const isB = c.kind === 'decided' && c.effort === b;
    if (c.kind === 'decided' && !isA && !isB) continue;
    const person = byPerson ? (s.person || null) : null;
    const week = weekStart(t);
    const key = `${person ?? ''}\0${week}`;
    let r = weeks.get(key);
    if (!r) weeks.set(key, (r = { person, week, a: 0, b: 0, mixed: 0, none: 0 }));
    if (c.kind === 'mixed') {
      out.mixed++;
      r.mixed++;
    } else if (c.kind === 'none') {
      out.none++;
      r.none++;
    }
    if (isA) {
      out.a.push(s);
      r.a++;
    }
    if (isB) {
      out.b.push(s);
      r.b++;
    }
  }
  out.weeks = [...weeks.values()].sort((x, y) => (x.person == null ? 1 : 0) - (y.person == null ? 1 : 0) || (x.person ?? '').localeCompare(y.person ?? '') || x.week.localeCompare(y.week));
  return out;
}

// ---------- モデルどうし ----------

/**
 * 本体のモデルは、推論強度どうしと同じ決め方(mainEffortOf。本体のリクエストの MAIN_EFFORT_SHARE 以上が同じ (モデル, 強度) の組)で決める。
 * モデルだけの割合では決めない: sessions.csv の「本体のモデル」の列(Rust の main_effort_of)と同じセッションを同じモデルにするため。
 * そのため、同じモデルでも強度が混ざったセッションは「混在」に入る(強度を「すべて」にしても)
 */

/** 本体がそのモデルと決まったセッションの数(強度は問わない。多い順、同数は名前の順) */
export function modelChoices(sessions: readonly EffortSource[], effort = ''): { model: string; sessions: number }[] {
  const n = new Map<string, number>();
  for (const s of sessions) {
    const m = mainEffortOf(s.exec?.mainModelEfforts);
    // 強度を 1 つ選んだときは、その強度と決まったセッションだけを数える(modelSplit の母集団と同じ)
    if (m.kind === 'decided' && (!effort || m.effort === effort)) n.set(m.model, (n.get(m.model) ?? 0) + 1);
  }
  return [...n].map(([model, c]) => ({ model, sessions: c })).sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model));
}

/** 既定の A と B: 本体と決まったセッションの多い順の 2 つ(1 つしか無ければ両方に同じモデル) */
export function defaultModels(choices: readonly { model: string }[]): [a: string, b: string] {
  return [choices[0]?.model ?? '', choices[1]?.model ?? choices[0]?.model ?? ''];
}

/** モデルどうしで選べる強度: A か B のモデルの本体がその強度と決まったセッションの数(強度の並び: none → max) */
export function modelEffortChoices(sessions: readonly EffortSource[], ma: string, mb: string): { effort: string; a: number; b: number }[] {
  const n = new Map<string, { a: number; b: number }>();
  for (const s of sessions) {
    const m = mainEffortOf(s.exec?.mainModelEfforts);
    if (m.kind !== 'decided' || (m.model !== ma && m.model !== mb)) continue;
    const c = n.get(m.effort) ?? n.set(m.effort, { a: 0, b: 0 }).get(m.effort)!;
    if (m.model === ma) c.a++;
    if (m.model === mb) c.b++;
  }
  const order = orderBy(EFFORT_ORDER);
  return [...n].map(([effort, c]) => ({ effort, ...c })).sort((a, b) => order(a.effort, b.effort));
}

export interface ModelSplit<T> {
  a: T[];
  b: T[];
  /** 期間の中で、A か B のモデルのセッションのうち、本体が混在のものと記録の無いもの */
  mixed: number;
  none: number;
}

/**
 * モデルどうしの母集団: 期間に開始し、本体が (ma, effort) と決まったセッションと (mb, effort) と決まったセッション。effort が空なら強度は問わない。
 * 混在・記録なしは、A か B のモデルのセッション(本体のリクエストにそのモデルがある。記録が無ければ、セッションのモデルの一覧にある)のうち、
 * 本体が決まらなかったもの(推論強度どうしの effortClass と同じ)。A・B のモデルと決まったが強度が違うセッションは、どれにも数えない。
 * ma と mb が同じなら、両側に同じセッションが入る
 */
export function modelSplit<T extends EffortSource>(sessions: readonly T[], ma: string, mb: string, effort: string, from: string, to: string): ModelSplit<T> {
  const out: ModelSplit<T> = { a: [], b: [], mixed: 0, none: 0 };
  for (const s of sessions) {
    if (!inPeriod(s, from, to)) continue;
    const m = mainEffortOf(s.exec?.mainModelEfforts);
    if (m.kind === 'decided') {
      if (effort && m.effort !== effort) continue;
      if (m.model === ma) out.a.push(s);
      if (m.model === mb) out.b.push(s);
      continue;
    }
    const c = effortClass(s, ma) ?? effortClass(s, mb);
    if (c?.kind === 'mixed') out.mixed++;
    else if (c?.kind === 'none') out.none++;
  }
  return out;
}

// ---------- wiki の参照 ----------

/**
 * wiki の参照で比べる母集団: 期間に開始したセッションのうち、A = llm-wiki を参照したもの、B = 参照していないもの。
 * 参照したかは、改善点の llm-wiki の箱と絞り込みと同じ wikiReferenced(書き込みだけのセッションは B に入る)。
 * wiki の参照を数えていない集計(wikiState が counted でない)では、画面で選べないようにする(B が「数えていない」セッションになるため)
 */
export function wikiSplit<T extends Pick<CompareSession, 'wiki' | 'createdAt' | 'updatedAt'>>(sessions: readonly T[], from: string, to: string): { a: T[]; b: T[] } {
  const out: { a: T[]; b: T[] } = { a: [], b: [] };
  for (const s of sessions) {
    if (!inPeriod(s, from, to)) continue;
    (wikiReferenced(s.wiki) ? out.a : out.b).push(s);
  }
  return out;
}

/** 割合や平均を出す最小の依頼の数(セッションの 5 と同じ考え方) */
export const COMPARE_MIN_TURNS = 5;

/**
 * 工程どうしを、依頼(ターン)の単位で比べる。母集団は渡したセッションの依頼のうち、その工程のもの。
 * AI の変更の残存は、照合できたセッションのまとまりを、作った依頼の工程で分けたもの
 */
export function comparePhaseRows(sessions: readonly CompareSession[], a: Phase, b: Phase): CompareRow[] {
  const agg = turnAggregate(sessions);
  const byPhase = retentionByPhase(sessions);
  const ret = byPhase.byPhase;
  const bucket = (p: Phase): TurnBucket => agg.byPhase[p];
  const hunks = (p: Phase): StatusTuple => ret.get(PHASES.indexOf(p)) ?? [0, 0, 0, 0];
  /** その工程に照合できたまとまりがあるセッションの数(残存の割合を出すかは、まとまりの数でなくこの数で決める) */
  const retSessions = (p: Phase): number => byPhase.sessions.get(PHASES.indexOf(p)) ?? 0;
  const perTurn = (v: number, n: number): number | null => (n < COMPARE_MIN_TURNS ? null : v / n);
  const share = (part: number, whole: number, n: number): number | null => (n < COMPARE_MIN_TURNS || whole <= 0 ? null : part / whole);
  const row = (key: string, label: string, unit: CompareRow['unit'], f: (p: Phase) => number | null, note: string): CompareRow => ({ key, label, unit, a: f(a), b: f(b), note });
  // 工程どうしは同じセッションから両側を作るので、比べた版が混ざっているかは母集団の照合できたセッションで見る(混ざっていれば割合と日数を出さない)
  const pool = aggregateRetention(sessions);
  const mixed = modeMix(pool) != null;
  const retShare = (p: Phase, i: 'kept' | 'missing'): number | null => (mixed ? null : i === 'kept' ? keptOf(hunks(p), retSessions(p)) : shareOf(hunks(p), 2, retSessions(p)));
  const lag = (p: Phase): number | null => (mixed ? null : phaseLag(sessions, p));
  return [
    row('turns', '依頼', 'count', (p) => bucket(p).turns, '依頼(ターン)の数'),
    row('active', '実働 / 依頼', 'minutes', (p) => perTurn(bucket(p).activeMs, bucket(p).turns), '平均(記録の無い依頼は 0 として足す。5 件未満なら —)'),
    row('failure', 'ツールの失敗・拒否の率', 'rate', (p) => share(bucket(p).toolFailures + bucket(p).denied, bucket(p).tools, bucket(p).turns), '失敗・拒否 ÷ ツール呼び出し'),
    row('stuck', '詰まりのあった依頼の割合', 'rate', (p) => share(bucket(p).stuck, bucket(p).turns, bucket(p).turns), '失敗・拒否・中断・エラー・再編集・文脈圧縮のどれかがあった'),
    row('fix', '次の依頼で直し・差し戻しの割合', 'rate', (p) => share(bucket(p).followedByFix, bucket(p).withNext, bucket(p).turns), '次の依頼があった依頼に対する割合'),
    row('aiu', 'AIU / 依頼', 'aiu', (p) => perTurn(bucket(p).nanoAiu / 1e9, bucket(p).turns), '平均(5 件未満なら —)'),
    row('retention-measured', '照合できたセッション(その工程にまとまりがあるもの)', 'count', retSessions, `AI の変更の残存の割合を出すかを決める数(${RETENTION_MIN_SESSIONS} 件未満なら割合は —)`),
    row('retention-hunks', '照合できたまとまり', 'count', (p) => measuredOf(hunks(p)), '照合できたセッションの、その工程の依頼で AI が足したまとまり'),
    row('retention-kept', '残っている(そのまま + 直されて)割合', 'rate', (p) => retShare(p, 'kept'), `単位はまとまり。照合できたまとまり(照合不可を除く)に対する、そのまま残る + 直されて残るの割合(照合できたセッションが ${RETENTION_MIN_SESSIONS} 件未満か、母集団の比べた版が混ざっていれば —)`),
    row('retention-missing', '見つからない割合', 'rate', (p) => retShare(p, 'missing'), '単位はまとまり。照合できたまとまりに対する、見つからないの割合(母集団の比べた版が混ざっていれば —)'),
    row('retention-lag', 'セッションの終わりから比べた時点まで(中央値)', 'days', lag, `その工程にまとまりのある照合できたセッション(${RETENTION_MIN_SESSIONS} 件未満か、母集団の比べた版が混ざっていれば —)。両側で大きく違うと、後から人が手を入れた時間が違うので残存の割合を比べにくい`),
    ...retentionDetailRows(pool, pool, { pool: true }),
  ];
}

/** その工程にまとまり(照合不可を除く)がある照合できたセッションの、比べた時点までの日数の中央値(そのセッションが RETENTION_MIN_SESSIONS 件未満なら null) */
export function phaseLag(list: readonly Pick<CompareSession, 'retention'>[], p: Phase): number | null {
  const i = PHASES.indexOf(p);
  const lags: number[] = [];
  let n = 0;
  for (const s of list) {
    const r = s.retention;
    if (!r || r.outcome !== 'measured' || !r.phases?.some(([q, ...t]) => q === i && measuredOf(t as StatusTuple) > 0)) continue;
    n++;
    if (r.lag != null) lags.push(r.lag);
  }
  return enoughMeasured(n) ? median(lags) : null;
}
