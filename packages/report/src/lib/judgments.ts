// judgments.json(Phase 3 の judge が出す判定結果)の読み取り口。
// スキーマ(docs/PLAN.md「judgments.json スキーマ」、正典は packages/judge/src/schema.ts の validateJudgments)の
// うちレポートに要る項目だけを拾う。report は judge に依存しないので、ここでは表示に必要な最低限を検査し、
// 形が合わない項目は捨てずにエラーにする(黙って欠損させない)。
// ただし llm-wiki のページごとの判定(wikiPages)だけは、壊れていても項目を捨てずに、そのページを未判定として読む(docs/judge.md)。
// 判定を書く側(packages/judge の schema.ts)の parseWikiPages と同じ決まりで読む。
import type { JudgmentSummary, WikiHelpful, WikiPageVerdict } from './types.ts';

/** 読める judgments.json のスキーマの版(1: wikiPages の無い版。2: llm-wiki のページごとの判定を足した版) */
export const JUDGMENTS_SCHEMA_VERSIONS: readonly number[] = [1, 2];

const HELPFUL: readonly string[] = ['yes', 'no', 'unknown'] satisfies WikiHelpful[];

/** wikiPages を読む。配列でなければ null(ページは未判定)。形の合わない要素と、同じページの 2 回目以降は捨てる。理由が無ければ空 */
export function parseWikiPages(v: unknown): WikiPageVerdict[] | null {
  if (!Array.isArray(v)) return null;
  const out: WikiPageVerdict[] = [];
  for (const x of v as unknown[]) {
    const o = obj(x);
    const page = typeof o.page === 'string' ? o.page.trim() : '';
    if (!page || typeof o.helpful !== 'string' || !HELPFUL.includes(o.helpful)) continue;
    if (out.some(([p]) => p === page)) continue;
    out.push([page, o.helpful as WikiHelpful, typeof o.reason === 'string' ? o.reason : '']);
  }
  return out;
}

export interface JudgmentsIndex {
  backend: string | null;
  model: string | null;
  ranAt: string | null;
  bySession: Map<string, JudgmentSummary>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function parseJudgments(raw: unknown): JudgmentsIndex {
  if (!raw || typeof raw !== 'object') throw new Error('judgments.json がオブジェクトではありません');
  const o = raw as Record<string, unknown>;
  if (typeof o.schemaVersion !== 'number' || !JUDGMENTS_SCHEMA_VERSIONS.includes(o.schemaVersion)) throw new Error(`judgments.json の schemaVersion が 1・2 のどちらでもありません(${String(o.schemaVersion)})`);
  if (!Array.isArray(o.items)) throw new Error('judgments.json に items 配列がありません');
  const judge = obj(o.judge);
  const bySession = new Map<string, JudgmentSummary>();
  o.items.forEach((it: unknown, i: number) => {
    const x = obj(it);
    const id = str(x.sessionId);
    if (!id) throw new Error(`judgments.json の items[${i}] に sessionId がありません`);
    const h = obj(x.humanEffort);
    const hours = num(h.hours);
    if (hours == null || hours < 0) throw new Error(`judgments.json の items[${i}](${id})の humanEffort.hours が数値ではありません`);
    const a = obj(x.aiOutcome);
    const wikiPageVerdicts = parseWikiPages(x.wikiPages);
    // 項目ごとの判定の出所(judge run と取り込みが付ける)。無い古い判定は、モデルだけファイル全体のものを使う
    const itemJudge = x.judge && typeof x.judge === 'object' && !Array.isArray(x.judge) ? (x.judge as Record<string, unknown>) : null;
    const model = itemJudge ? str(itemJudge.model) : str(judge.model);
    const ranAt = itemJudge ? str(itemJudge.ranAt) : null;
    bySession.set(id, {
      taskCategory: str(x.taskCategory),
      hours,
      low: num(h.low),
      high: num(h.high),
      confidence: num(h.confidence),
      taskSummary: str(x.taskSummary),
      completed: typeof a.completed === 'boolean' ? a.completed : null,
      quality: num(a.quality),
      rework: num(a.rework),
      effects: { instructions: num(obj(x.instructionsEffect).score), wiki: num(obj(x.wikiEffect).score), skillsAgents: num(obj(x.skillsAgentsEffect).score) },
      rationale: str(h.rationale),
      backend: str(obj(x.judge).backend) ?? str(judge.backend),
      ...(model ? { model } : {}),
      ...(ranAt ? { ranAt } : {}),
      ...(wikiPageVerdicts ? { wikiPageVerdicts } : {}),
    });
  });
  return { backend: str(judge.backend), model: str(judge.model), ranAt: str(judge.ranAt), bySession };
}
