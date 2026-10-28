// judgments.json(Phase 3 の judge が出す判定結果)の読み取り口。
// スキーマ(docs/PLAN.md「judgments.json スキーマ」、正典は packages/judge/src/schema.ts の validateJudgments)の
// うちレポートに要る項目だけを拾う。report は judge に依存しないので、ここでは表示に必要な最低限を検査し、
// 形が合わない項目は捨てずにエラーにする(黙って欠損させない)。
import type { JudgmentSummary } from './types.ts';

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
  if (o.schemaVersion !== 1) throw new Error(`judgments.json の schemaVersion が 1 ではありません(${String(o.schemaVersion)})`);
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
    });
  });
  return { backend: str(judge.backend), model: str(judge.model), ranAt: str(judge.ranAt), bySession };
}
