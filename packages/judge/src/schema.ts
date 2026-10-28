// judgments.json のスキーマ(docs/PLAN.md「judgments.json スキーマ」、schemaVersion 1)と検証。
// 外部 LLM の出力も内部バックエンドの出力も、ここを通ったものだけを judgments.json に入れる。
// 形が合わないものは黙って直さず、どこが違うかを列挙して落とす。

export const JUDGMENTS_SCHEMA_VERSION = 1;

export const TASK_CATEGORIES = ['feature', 'bugfix', 'investigation', 'refactor', 'docs', 'ops', 'other'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const BACKENDS = ['copilot-cli', 'opencode', 'anthropic', 'external'] as const;
export type BackendName = (typeof BACKENDS)[number];

export interface EffectScore {
  /** -2(逆効果)〜 +2(大いに役立った)。使われていなければ 0 */
  score: number;
  evidence: string;
}

export interface JudgmentItem {
  sessionId: string;
  taskCategory: TaskCategory;
  taskSummary: string;
  humanEffort: { hours: number; low: number; high: number; confidence: number; rationale: string };
  aiOutcome: { completed: boolean; quality: number; rework: number; rationale: string };
  instructionsEffect: EffectScore;
  wikiEffect: EffectScore;
  skillsAgentsEffect: EffectScore;
  notes?: string;
  /** この項目を誰が判定したか(ツールが付ける。LLM の出力には不要) */
  judge?: JudgeMeta;
}

export interface JudgeMeta {
  backend: BackendName;
  model: string | null;
  ranAt: string;
}

export interface JudgmentFailure {
  sessionId: string;
  backend: BackendName;
  model: string | null;
  at: string;
  error: string;
}

/** 判定自体のトークン消費(バックエンドの usage を数値の葉ごとに合計したもの) */
export interface JudgeUsage {
  /** usage を取れた判定の回数 */
  runs: number;
  /** usage が取れなかった判定の回数 */
  missing: number;
  /** "a.b.c" 形式の経路 → 合計値 */
  totals: Record<string, number>;
}

export interface JudgmentsFile {
  schemaVersion: 1;
  /** 最後に書き込んだ判定の実行情報(項目ごとの出所は items[].judge) */
  judge: { backend: BackendName; model: string | null; ranAt: string; usage?: JudgeUsage };
  items: JudgmentItem[];
  /** 判定に失敗したセッション(成功したら消える) */
  failures?: JudgmentFailure[];
}

export class JudgmentValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[], prefix = 'judgments の形が正しくありません') {
    super(`${prefix}:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkEffect(v: unknown, path: string, p: string[]): void {
  if (!isObj(v)) {
    p.push(`${path} がオブジェクトではありません`);
    return;
  }
  if (!isNum(v.score) || !Number.isInteger(v.score) || v.score < -2 || v.score > 2) p.push(`${path}.score は -2〜2 の整数です(${JSON.stringify(v.score)})`);
  if (!isStr(v.evidence)) p.push(`${path}.evidence は文字列です`);
}

/** 1 項目を検証して問題点を返す(空なら妥当) */
export function itemProblems(v: unknown, path = 'item'): string[] {
  const p: string[] = [];
  if (!isObj(v)) return [`${path} がオブジェクトではありません`];
  if (!isStr(v.sessionId) || v.sessionId.trim() === '') p.push(`${path}.sessionId がありません`);
  if (!(TASK_CATEGORIES as readonly unknown[]).includes(v.taskCategory)) p.push(`${path}.taskCategory は ${TASK_CATEGORIES.join(' / ')} のいずれかです(${JSON.stringify(v.taskCategory)})`);
  if (!isStr(v.taskSummary) || v.taskSummary.trim() === '') p.push(`${path}.taskSummary がありません`);

  const h = v.humanEffort;
  if (!isObj(h)) p.push(`${path}.humanEffort がオブジェクトではありません`);
  else {
    for (const k of ['hours', 'low', 'high'] as const) if (!isNum(h[k]) || h[k] < 0) p.push(`${path}.humanEffort.${k} は 0 以上の数値です(${JSON.stringify(h[k])})`);
    if (isNum(h.hours) && isNum(h.low) && isNum(h.high) && !(h.low <= h.hours && h.hours <= h.high)) p.push(`${path}.humanEffort は low ≤ hours ≤ high を満たす必要があります(${h.low} / ${h.hours} / ${h.high})`);
    if (!isNum(h.confidence) || h.confidence < 0 || h.confidence > 1) p.push(`${path}.humanEffort.confidence は 0〜1 の数値です(${JSON.stringify(h.confidence)})`);
    if (!isStr(h.rationale)) p.push(`${path}.humanEffort.rationale は文字列です`);
  }

  const a = v.aiOutcome;
  if (!isObj(a)) p.push(`${path}.aiOutcome がオブジェクトではありません`);
  else {
    if (typeof a.completed !== 'boolean') p.push(`${path}.aiOutcome.completed は true / false です`);
    if (!isNum(a.quality) || !Number.isInteger(a.quality) || a.quality < 1 || a.quality > 5) p.push(`${path}.aiOutcome.quality は 1〜5 の整数です(${JSON.stringify(a.quality)})`);
    if (!isNum(a.rework) || !Number.isInteger(a.rework) || a.rework < 0 || a.rework > 5) p.push(`${path}.aiOutcome.rework は 0〜5 の整数です(${JSON.stringify(a.rework)})`);
    if (!isStr(a.rationale)) p.push(`${path}.aiOutcome.rationale は文字列です`);
  }
  checkEffect(v.instructionsEffect, `${path}.instructionsEffect`, p);
  checkEffect(v.wikiEffect, `${path}.wikiEffect`, p);
  checkEffect(v.skillsAgentsEffect, `${path}.skillsAgentsEffect`, p);
  if (v.notes !== undefined && v.notes !== null && !isStr(v.notes)) p.push(`${path}.notes は文字列です`);
  if (v.judge !== undefined) {
    const j = v.judge;
    if (!isObj(j) || !(BACKENDS as readonly unknown[]).includes(j.backend) || !isStr(j.ranAt)) p.push(`${path}.judge は {backend, model, ranAt} です`);
  }
  return p;
}

/** 1 項目を検証し、余分なキーを落とした正規形を返す。不正なら JudgmentValidationError */
export function validateJudgmentItem(v: unknown, path = 'item'): JudgmentItem {
  const p = itemProblems(v, path);
  if (p.length) throw new JudgmentValidationError(p);
  const x = v as JudgmentItem;
  const out: JudgmentItem = {
    sessionId: x.sessionId.trim(),
    taskCategory: x.taskCategory,
    taskSummary: x.taskSummary,
    humanEffort: { hours: x.humanEffort.hours, low: x.humanEffort.low, high: x.humanEffort.high, confidence: x.humanEffort.confidence, rationale: x.humanEffort.rationale },
    aiOutcome: { completed: x.aiOutcome.completed, quality: x.aiOutcome.quality, rework: x.aiOutcome.rework, rationale: x.aiOutcome.rationale },
    instructionsEffect: { score: x.instructionsEffect.score, evidence: x.instructionsEffect.evidence },
    wikiEffect: { score: x.wikiEffect.score, evidence: x.wikiEffect.evidence },
    skillsAgentsEffect: { score: x.skillsAgentsEffect.score, evidence: x.skillsAgentsEffect.evidence },
  };
  if (typeof x.notes === 'string' && x.notes !== '') out.notes = x.notes;
  if (x.judge) out.judge = { backend: x.judge.backend, model: x.judge.model ?? null, ranAt: x.judge.ranAt };
  return out;
}

/** judgments.json 全体を検証する。問題はまとめて報告する */
export function validateJudgments(v: unknown): JudgmentsFile {
  const p: string[] = [];
  if (!isObj(v)) throw new JudgmentValidationError(['ルートがオブジェクトではありません']);
  if (v.schemaVersion !== JUDGMENTS_SCHEMA_VERSION) p.push(`schemaVersion が 1 ではありません(${JSON.stringify(v.schemaVersion)})`);
  const j = v.judge;
  if (!isObj(j) || !(BACKENDS as readonly unknown[]).includes(j.backend) || !isStr(j.ranAt)) p.push(`judge は {backend: ${BACKENDS.join('|')}, model, ranAt} です`);
  if (!Array.isArray(v.items)) p.push('items が配列ではありません');
  else v.items.forEach((it, i) => p.push(...itemProblems(it, `items[${i}]`)));
  if (Array.isArray(v.items)) {
    const seen = new Set<string>();
    for (const it of v.items as { sessionId?: unknown }[]) {
      if (typeof it?.sessionId !== 'string') continue;
      if (seen.has(it.sessionId)) p.push(`sessionId ${it.sessionId} が重複しています`);
      seen.add(it.sessionId);
    }
  }
  if (v.failures !== undefined && !Array.isArray(v.failures)) p.push('failures が配列ではありません');
  if (p.length) throw new JudgmentValidationError(p);
  const jj = j as Record<string, unknown>;
  const out: JudgmentsFile = {
    schemaVersion: 1,
    judge: { backend: jj.backend as BackendName, model: isStr(jj.model) ? jj.model : null, ranAt: jj.ranAt as string },
    items: (v.items as unknown[]).map((it, i) => validateJudgmentItem(it, `items[${i}]`)),
  };
  if (isObj(jj.usage)) out.judge.usage = jj.usage as unknown as JudgeUsage;
  if (Array.isArray(v.failures) && v.failures.length) out.failures = v.failures as JudgmentFailure[];
  return out;
}

export function emptyJudgments(backend: BackendName, model: string | null, ranAt = new Date().toISOString()): JudgmentsFile {
  return { schemaVersion: 1, judge: { backend, model, ranAt }, items: [] };
}

/** sessionId 単位で上書きマージ(新しい方が勝つ)。成功した項目の failures は消す */
export function mergeJudgments(base: JudgmentsFile, add: JudgmentItem[], judge: JudgmentsFile['judge']): JudgmentsFile {
  const by = new Map(base.items.map((i) => [i.sessionId, i]));
  for (const it of add) by.set(it.sessionId, it);
  const done = new Set(add.map((i) => i.sessionId));
  const failures = (base.failures ?? []).filter((f) => !done.has(f.sessionId));
  const out: JudgmentsFile = { schemaVersion: 1, judge: { ...judge }, items: [...by.values()] };
  if (failures.length) out.failures = failures;
  return out;
}

/** usage の JSON(形は問わない)から数値の葉を "a.b" 経路で集める */
export function numericLeaves(v: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (isNum(v)) {
    out[prefix || 'value'] = (out[prefix || 'value'] ?? 0) + v;
  } else if (Array.isArray(v)) {
    for (const x of v) numericLeaves(x, prefix, out);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) numericLeaves(x, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

export function addUsage(u: JudgeUsage | undefined, raw: unknown | null): JudgeUsage {
  const out: JudgeUsage = u ? { runs: u.runs, missing: u.missing, totals: { ...u.totals } } : { runs: 0, missing: 0, totals: {} };
  if (raw == null) {
    out.missing++;
    return out;
  }
  out.runs++;
  for (const [k, n] of Object.entries(numericLeaves(raw))) out.totals[k] = (out.totals[k] ?? 0) + n;
  return out;
}

// ---------- LLM 出力から JSON を取り出す ----------

/** テキスト中の JSON 候補(```json フェンス → 全体 → 最外の {…} / […])を順に返す */
export function jsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string): boolean => {
    try {
      out.push(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  };
  const fence = /(`{3,}|~{3,})[ \t]*(json|jsonc|javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1/gi;
  let m: RegExpExecArray | null;
  let fenced = 0;
  while ((m = fence.exec(text))) {
    const lang = (m[2] ?? '').toLowerCase();
    const body = m[3].trim();
    if (lang === '' && !/^[[{]/.test(body)) continue;
    if (tryParse(body)) fenced++;
  }
  if (fenced > 0) return out;
  const t = text.trim();
  if (tryParse(t)) return out;
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a && tryParse(t.slice(a, b + 1))) return out;
  }
  return out;
}

/** JSON 候補を項目の配列に平らにする({items:[…]} / […] / 単一項目のいずれも受ける) */
export function itemsFromCandidates(cands: unknown[]): unknown[] {
  const items: unknown[] = [];
  for (const c of cands) {
    if (Array.isArray(c)) items.push(...c);
    else if (isObj(c) && Array.isArray(c.items)) items.push(...c.items);
    else if (isObj(c)) items.push(c);
  }
  return items;
}

// ---------- JSON Schema(外部 LLM と人が読む用。検証の正典は上の関数) ----------

const effectSchema = {
  type: 'object',
  required: ['score', 'evidence'],
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: -2, maximum: 2, description: '-2: 逆効果 / 0: 影響なし・使われていない / +2: 大いに役立った' },
    evidence: { type: 'string', description: 'パケット内の根拠(使われていなければ「参照なし」など)' },
  },
} as const;

export const ITEM_JSON_SCHEMA = {
  type: 'object',
  required: ['sessionId', 'taskCategory', 'taskSummary', 'humanEffort', 'aiOutcome', 'instructionsEffect', 'wikiEffect', 'skillsAgentsEffect'],
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', description: 'パケット冒頭の「セッション ID」をそのまま' },
    taskCategory: { type: 'string', enum: [...TASK_CATEGORIES] },
    taskSummary: { type: 'string', description: 'タスクの要約(日本語 1〜2 文)' },
    humanEffort: {
      type: 'object',
      required: ['hours', 'low', 'high', 'confidence', 'rationale'],
      additionalProperties: false,
      description: '同じ成果を熟練した人が AI なしで出す場合の作業時間(low ≤ hours ≤ high)',
      properties: {
        hours: { type: 'number', minimum: 0 },
        low: { type: 'number', minimum: 0 },
        high: { type: 'number', minimum: 0 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string' },
      },
    },
    aiOutcome: {
      type: 'object',
      required: ['completed', 'quality', 'rework', 'rationale'],
      additionalProperties: false,
      properties: {
        completed: { type: 'boolean' },
        quality: { type: 'integer', minimum: 1, maximum: 5 },
        rework: { type: 'integer', minimum: 0, maximum: 5, description: '手戻り・やり直しの多さ(0: なし〜5: 大半がやり直し)' },
        rationale: { type: 'string' },
      },
    },
    instructionsEffect: effectSchema,
    wikiEffect: effectSchema,
    skillsAgentsEffect: effectSchema,
    notes: { type: 'string' },
    judge: {
      type: 'object',
      description: 'ツールが付ける出所情報(LLM は出力しない)',
      properties: { backend: { type: 'string', enum: [...BACKENDS] }, model: { type: ['string', 'null'] }, ranAt: { type: 'string' } },
    },
  },
} as const;

export const JUDGMENTS_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'agent-session-atlas judgments.json (schemaVersion 1)',
  type: 'object',
  required: ['schemaVersion', 'judge', 'items'],
  properties: {
    schemaVersion: { const: 1 },
    judge: {
      type: 'object',
      required: ['backend', 'ranAt'],
      properties: {
        backend: { type: 'string', enum: [...BACKENDS] },
        model: { type: ['string', 'null'] },
        ranAt: { type: 'string', description: 'ISO 8601' },
        usage: { type: 'object' },
      },
    },
    items: { type: 'array', items: ITEM_JSON_SCHEMA },
    failures: { type: 'array' },
  },
} as const;
