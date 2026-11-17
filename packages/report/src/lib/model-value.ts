// モデル × 推論強度ごとの効果とコスト(画面の「モデルと推論強度の効果」)。
// 推論強度はリクエストごとに決まるが、効果の記録(セッションの判定・依頼の判定・残存・ツールの失敗)はセッションや依頼ごとにしか無い。
// そこで、セッションの効果を、そのセッションのリクエストに占める モデル × 強度 の割合で按分して足す(1 セッションの重みの合計は 1)。
// コスト(リクエスト・トークン・AIU)は按分せず、その モデル × 強度 のリクエストの実数を足す。
import { OUTCOMES, type Outcome } from '../shared/turns.ts';
import { isLowConfidence } from './aggregate.ts';
import { EFFORT_ORDER, orderBy } from './exec.ts';
import { modelLabel } from './format.ts';
import { enoughMeasured, measuredOf } from './retention.ts';
import type { SessionSummary } from './types.ts';

/** 採用した扱い(そのまま・修正して・役に立った) */
const ADOPTED: readonly Outcome[] = ['as_is', 'fix_content', 'fix_style', 'helpful'];
/** 手を入れずに使えた扱い */
const AS_IS: readonly Outcome[] = ['as_is', 'helpful'];
/** 使えなかった扱い */
const REJECTED: readonly Outcome[] = ['rejected', 'off_target'];

/** 按分した値の合計と、その分母(値の記録があるセッションの重み) */
export interface Weighted {
  sum: number;
  weight: number;
}

export interface ValueRow {
  /** 行の識別子(モデル、または モデル + 強度) */
  key: string;
  model: string;
  /** 推論強度。モデルごとの行は undefined、強度の記録が無いセッションの分は null */
  effort?: string | null;
  /** このモデル(× 強度)を使ったセッションの数 */
  sessions: number;
  /** 按分したセッションの数(リクエストの割合の合計) */
  weight: number;
  requests: number;
  input: number;
  output: number;
  nanoAiu: number;
  /** セッションの判定: 達成(1/0)・成果の質(1〜5)・手戻り(0〜5)・推定人手工数(時間) */
  completed: Weighted;
  quality: Weighted;
  rework: Weighted;
  hours: Weighted;
  /** 推定人手工数を数えた判定済みセッション(確信度の低い推定を除く)の、このモデル(× 強度)の AIU(nano)。人手工数あたりのコストの分母 */
  judgedNanoAiu: number;
  /** 依頼の判定(判定不能を除く依頼の数を按分): 採用・そのまま・使えなかった。weight は判定した依頼のあるセッションの重み */
  turns: { judged: number; adopted: number; asIs: number; rejected: number; weight: number };
  /**
   * AI の変更の残存(まとまりの単位。「比べる」の「残っている割合」と同じ数え方)。
   * measured = 照合できたまとまり(照合不可を除く)、kept = 残っている(そのまま + 直されて)まとまり。どちらも按分。
   * weight は照合できたセッションの重み。sessions は照合できたセッションの数、withAi は AI の変更があったセッションの数(どちらも按分しない)
   */
  retention: { measured: number; kept: number; weight: number; sessions: number; withAi: number };
  /** ツールの呼び出しと失敗(按分) */
  tools: { calls: number; failures: number };
}

const emptyRow = (key: string, model: string, effort?: string | null): ValueRow => ({
  key,
  model,
  ...(effort === undefined ? {} : { effort }),
  sessions: 0,
  weight: 0,
  requests: 0,
  input: 0,
  output: 0,
  nanoAiu: 0,
  completed: { sum: 0, weight: 0 },
  quality: { sum: 0, weight: 0 },
  rework: { sum: 0, weight: 0 },
  hours: { sum: 0, weight: 0 },
  judgedNanoAiu: 0,
  turns: { judged: 0, adopted: 0, asIs: 0, rejected: 0, weight: 0 },
  retention: { measured: 0, kept: 0, weight: 0, sessions: 0, withAi: 0 },
  tools: { calls: 0, failures: 0 },
});

interface Part {
  model: string;
  /** 強度の記録が無いセッション(古い集計から作ったもの)は null */
  effort: string | null;
  requests: number;
  input: number;
  output: number;
  nanoAiu: number;
}

/** セッションのリクエストを モデル × 強度 に分けたもの。強度の内訳が無ければモデル別の記録から作る(強度は null) */
function partsOf(s: SessionSummary): Part[] {
  const parts: Part[] = [];
  for (const [model, byEffort] of Object.entries(s.exec.modelEfforts ?? {}))
    for (const [effort, [requests, input, output, nanoAiu]] of Object.entries(byEffort)) parts.push({ model, effort, requests, input, output, nanoAiu });
  if (parts.length > 0) return parts;
  for (const [model, t] of Object.entries(s.byModel)) parts.push({ model, effort: null, requests: t.requests ?? 0, input: t.input ?? 0, output: t.output, nanoAiu: 0 });
  return parts;
}

const addW = (w: Weighted, value: number | null | undefined, weight: number): void => {
  if (value == null) return;
  w.sum += value * weight;
  w.weight += weight;
};

/**
 * モデル(split なら モデル × 推論強度)ごとの効果とコスト。並びはモデルのリクエストの多い順、同じモデルの中は強度の順。
 * リクエストの記録が無いセッション(モデル別の内訳が無い)は数えない
 */
export function modelValue(sessions: readonly SessionSummary[], split: boolean): ValueRow[] {
  const rows = new Map<string, ValueRow>();
  for (const s of sessions) {
    const parts = partsOf(s);
    const total = parts.reduce((a, p) => a + p.requests, 0);
    if (total <= 0) continue;
    // 1 セッションの中で同じ行になるもの(モデルごとの行では強度をまとめる)を先に足す
    const mine = new Map<string, { row: ValueRow; requests: number; nanoAiu: number }>();
    for (const p of parts) {
      const key = split ? `${p.model} ${p.effort ?? ''}` : p.model;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = emptyRow(key, p.model, split ? p.effort : undefined)));
      row.requests += p.requests;
      row.input += p.input;
      row.output += p.output;
      row.nanoAiu += p.nanoAiu;
      const m = mine.get(key) ?? mine.set(key, { row, requests: 0, nanoAiu: 0 }).get(key)!;
      m.requests += p.requests;
      m.nanoAiu += p.nanoAiu;
    }
    const j = s.judgment;
    const verdicts = s.turnVerdicts ?? [];
    const outcomes = verdicts.map((v) => OUTCOMES[v[2]]).filter((o) => o != null && o !== 'unknown');
    const count = (set: readonly Outcome[]): number => outcomes.filter((o) => set.includes(o)).length;
    const turns = { judged: outcomes.length, adopted: count(ADOPTED), asIs: count(AS_IS), rejected: count(REJECTED) };
    const ret = s.retention;
    const r = ret?.outcome === 'measured' ? ret.hunks : null;
    const withAi = ret != null && ret.outcome !== 'none';
    for (const { row, requests, nanoAiu } of mine.values()) {
      const w = requests / total;
      row.sessions++;
      row.weight += w;
      if (j) {
        addW(row.completed, j.completed == null ? null : j.completed ? 1 : 0, w);
        addW(row.quality, j.quality, w);
        addW(row.rework, j.rework, w);
        // 確信度の低い推定は、全体の合計と同じく人手工数に入れない(達成・品質・手戻りは時間の推定ではないので入れる)
        const hours = isLowConfidence(j) ? null : j.hours;
        addW(row.hours, hours, w);
        if (hours != null) row.judgedNanoAiu += nanoAiu;
      }
      row.turns.judged += turns.judged * w;
      row.turns.adopted += turns.adopted * w;
      row.turns.asIs += turns.asIs * w;
      row.turns.rejected += turns.rejected * w;
      if (turns.judged > 0) row.turns.weight += w;
      if (withAi) row.retention.withAi++;
      if (r) {
        row.retention.sessions++;
        row.retention.weight += w;
        row.retention.measured += measuredOf(r) * w;
        row.retention.kept += (r[0] + r[1]) * w;
      }
      row.tools.calls += s.tools.total * w;
      row.tools.failures += s.friction.toolFailures * w;
    }
  }
  const byModel = new Map<string, number>();
  for (const r of rows.values()) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.requests);
  const effortOrder = orderBy(EFFORT_ORDER);
  return [...rows.values()].sort(
    (a, b) =>
      byModel.get(b.model)! - byModel.get(a.model)! ||
      a.model.localeCompare(b.model) ||
      // 強度の記録なし(null)は最後
      (a.effort == null ? 1 : 0) - (b.effort == null ? 1 : 0) ||
      effortOrder(a.effort ?? '', b.effort ?? ''),
  );
}

/** 割合・平均(分母が 0 なら null) */
export const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
export const mean = (w: Weighted): number | null => ratio(w.sum, w.weight);
/** AIU(1 AIU = 10^9 nano AIU) */
export const aiu = (nano: number): number => nano / 1e9;

/** これより少ないセッションの行は、ばらつきが大きいので読み取り(effortFindings)に使わない */
export const MIN_SESSIONS = 3;
/** 読み取りで効果を比べるのは、その効果の記録があるセッションの重み(按分)がこれ以上のときだけ */
const MIN_EFFECT_WEIGHT = 1;
const enough = (weight: number, value: number | null): number | null => (weight >= MIN_EFFECT_WEIGHT ? value : null);

/** 残っている割合(照合できたまとまりのうち、そのまま + 直されて)。照合できたセッションが RETENTION_MIN_SESSIONS(残存の節・「比べる」と同じ値)未満なら null */
export const keptShare = (r: ValueRow): number | null => (enoughMeasured(r.retention.sessions) ? ratio(r.retention.kept, r.retention.measured) : null);

const pctText = (x: number): string => `${Math.round(x * 100)}%`;
const numText = (x: number): string => (Math.round(x * 100) / 100).toString();

/**
 * 読み取り: 同じモデルで推論強度を変えたときに、コストと効果がどう違うか(1 モデル 1 行)。
 * セッションが MIN_SESSIONS 以上ある強度が 2 つ以上あるモデルだけ。いちばん弱い強度を基準に、いちばん強い強度と比べる。
 * models(モデルごとの行)があれば、人手工数あたりのコストのいちばん良いモデルも足す
 */
export function effortFindings(split: readonly ValueRow[], models: readonly ValueRow[] = []): string[] {
  const out: string[] = [];
  const effortOrder = orderBy(EFFORT_ORDER);
  const byModel = new Map<string, ValueRow[]>();
  for (const r of split) {
    if (r.effort == null || r.effort === '(unknown)' || r.sessions < MIN_SESSIONS) continue;
    (byModel.get(r.model) ?? byModel.set(r.model, []).get(r.model)!).push(r);
  }
  for (const [model, rs] of byModel) {
    if (rs.length < 2) continue;
    rs.sort((a, b) => effortOrder(a.effort!, b.effort!));
    const lo = rs[0];
    const hi = rs[rs.length - 1];
    const parts: string[] = [];
    const cost = (r: ValueRow): number | null => (r.nanoAiu > 0 ? ratio(r.nanoAiu, r.requests) : null);
    const cl = cost(lo);
    const ch = cost(hi);
    if (cl != null && ch != null && cl > 0) parts.push(`1 リクエストの AIU が ${numText(ch / cl)} 倍`);
    const pairs: [string, number | null, number | null, (x: number) => string][] = [
      ['達成率', enough(lo.completed.weight, mean(lo.completed)), enough(hi.completed.weight, mean(hi.completed)), pctText],
      ['品質', enough(lo.quality.weight, mean(lo.quality)), enough(hi.quality.weight, mean(hi.quality)), numText],
      ['依頼の採用率', enough(lo.turns.weight, ratio(lo.turns.adopted, lo.turns.judged)), enough(hi.turns.weight, ratio(hi.turns.adopted, hi.turns.judged)), pctText],
      ['残っている割合', enough(lo.retention.weight, keptShare(lo)), enough(hi.retention.weight, keptShare(hi)), pctText],
      ['ツール失敗率', ratio(lo.tools.failures, lo.tools.calls), ratio(hi.tools.failures, hi.tools.calls), pctText],
    ];
    for (const [label, a, b, f] of pairs) if (a != null && b != null) parts.push(`${label} ${f(a)} → ${f(b)}`);
    if (parts.length > 0) out.push(`${modelLabel(model)}: ${hi.effort} は ${lo.effort} に比べて、${parts.join('、')}(セッション ${lo.sessions} 件 / ${hi.sessions} 件)。`);
  }
  const value = models
    .filter((r) => r.sessions >= MIN_SESSIONS && r.judgedNanoAiu > 0 && r.hours.weight > 0)
    .map((r) => ({ r, v: r.hours.sum / aiu(r.judgedNanoAiu) }))
    .sort((a, b) => b.v - a.v);
  if (value.length >= 2)
    out.push(`1 AIU あたりの推定人手工数がいちばん大きいのは ${modelLabel(value[0].r.model)}(${numText(value[0].v)} 時間)、いちばん小さいのは ${modelLabel(value[value.length - 1].r.model)}(${numText(value[value.length - 1].v)} 時間)。`);
  return out;
}
