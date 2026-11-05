// 段階 2: 依頼(ターン)ごとの LLM 判定の形(turn-judgments.json)と、検証・読み書き・取り込み。
// 1 項目 = 1 依頼。依頼の種類・成果の扱い(採用)・合わなかった点・普段の工程名・確信度・理由。
// 判定の対象と並びは core の sessionTurns と同じ(依頼番号は 1 から、セッションの先頭 200 依頼まで)。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MISMATCHES,
  NEEDS_MISMATCH,
  OUTCOMES,
  QUESTION_OUTCOMES,
  REQUEST_KINDS,
  renameReplacing,
  WORK_OUTCOMES,
  type Mismatch,
  type Outcome,
  type RequestKind,
} from '../../core/src/index.ts';
import { BACKENDS, itemsFromCandidates, jsonCandidates, JudgmentValidationError, type BackendName } from './schema.ts';

export const TURN_JUDGMENTS_VERSION = 1;

export interface TurnJudgment {
  sessionId: string;
  /** セッションの中の依頼番号(1 から) */
  turn: number;
  kind: RequestKind;
  outcome: Outcome;
  /** 合わなかった点(中身・体裁の修正、不採用、的外れのときだけ。それ以外は null) */
  mismatch: Mismatch | null;
  /** 普段の工程名(turn-judgments.json の phases のどれか) */
  phase: string;
  /** 0〜1 */
  confidence: number;
  /** 判定の理由(短く) */
  note: string;
  judge?: { backend: BackendName; model: string | null; ranAt: string };
}

export interface TurnJudgmentsFile {
  schemaVersion: number;
  /** 判定に使った普段の工程名の一覧(判定の指示に載せたもの) */
  phases: string[];
  judge: { backend: BackendName; model: string | null; ranAt: string };
  items: TurnJudgment[];
  /** 判定できなかった塊(セッションと依頼番号) */
  failures: { sessionId: string; turns: number[]; error: string; at: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (sessionId: string, turn: number): string => `${sessionId}#${turn}`;

/** 1 項目の問題点(空なら妥当)。phases は判定の指示に載せた工程名 */
export function turnItemProblems(v: unknown, path: string, phases: readonly string[]): string[] {
  if (!isObj(v)) return [`${path}が無いか、{ … } の形ではありません`];
  const p: string[] = [];
  const at = (field: string): string => `${path}の ${field}`;
  if (typeof v.sessionId !== 'string' || v.sessionId.trim() === '') p.push(`${at('sessionId')} がありません`);
  if (typeof v.turn !== 'number' || !Number.isInteger(v.turn) || v.turn < 1) p.push(`${at('turn')} は 1 以上の整数です(${JSON.stringify(v.turn)})`);
  const kindOk = (REQUEST_KINDS as readonly unknown[]).includes(v.kind);
  if (!kindOk) p.push(`${at('kind')} は ${REQUEST_KINDS.join(' / ')} のどれかです(${JSON.stringify(v.kind)})`);
  if (!(OUTCOMES as readonly unknown[]).includes(v.outcome)) p.push(`${at('outcome')} は ${OUTCOMES.join(' / ')} のどれかです(${JSON.stringify(v.outcome)})`);
  else if (kindOk) {
    const allowed: readonly unknown[] = v.kind === 'question' ? QUESTION_OUTCOMES : WORK_OUTCOMES;
    if (!allowed.includes(v.outcome)) p.push(`${at('outcome')} は kind が ${String(v.kind)} のとき ${allowed.join(' / ')} のどれかです(${JSON.stringify(v.outcome)})`);
  }
  const needs = (NEEDS_MISMATCH as readonly unknown[]).includes(v.outcome);
  if (needs && !(MISMATCHES as readonly unknown[]).includes(v.mismatch)) p.push(`${at('mismatch')} は outcome が ${String(v.outcome)} のとき ${MISMATCHES.join(' / ')} のどれかです(${JSON.stringify(v.mismatch)})`);
  if (!needs && v.mismatch != null) p.push(`${at('mismatch')} は outcome が ${String(v.outcome)} のときは null です(${JSON.stringify(v.mismatch)})`);
  if (typeof v.phase !== 'string' || !phases.includes(v.phase)) p.push(`${at('phase')} は ${phases.join(' / ')} のどれかです(${JSON.stringify(v.phase)})`);
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) p.push(`${at('confidence')} は 0〜1 の数値です(${JSON.stringify(v.confidence)})`);
  if (v.note != null && typeof v.note !== 'string') p.push(`${at('note')} は文字列です`);
  return p;
}

function normalizeItem(v: Record<string, unknown>): TurnJudgment {
  return {
    sessionId: v.sessionId as string,
    turn: v.turn as number,
    kind: v.kind as RequestKind,
    outcome: v.outcome as Outcome,
    mismatch: (NEEDS_MISMATCH as readonly unknown[]).includes(v.outcome) ? (v.mismatch as Mismatch) : null,
    phase: v.phase as string,
    confidence: v.confidence as number,
    note: typeof v.note === 'string' ? v.note.trim() : '',
  };
}

export function emptyTurnJudgments(phases: readonly string[], backend: BackendName, model: string | null, ranAt = new Date().toISOString()): TurnJudgmentsFile {
  return { schemaVersion: TURN_JUDGMENTS_VERSION, phases: [...phases], judge: { backend, model, ranAt }, items: [], failures: [] };
}

export function validateTurnJudgments(v: unknown): TurnJudgmentsFile {
  if (!isObj(v)) throw new Error('turn-judgments が { … } の形ではありません');
  if (v.schemaVersion !== TURN_JUDGMENTS_VERSION) throw new Error(`turn-judgments の版が違います(${String(v.schemaVersion)})`);
  if (!Array.isArray(v.phases) || !v.phases.every((x) => typeof x === 'string' && x !== '')) throw new Error('turn-judgments の phases は文字列の配列です');
  const phases = v.phases as string[];
  const items = Array.isArray(v.items) ? v.items : [];
  const problems = items.flatMap((it, i) => turnItemProblems(it, `項目 ${i + 1}`, phases));
  if (problems.length) throw new JudgmentValidationError(problems, 'turn-judgments の形が正しくありません');
  const j = isObj(v.judge) ? v.judge : {};
  return {
    schemaVersion: TURN_JUDGMENTS_VERSION,
    phases,
    judge: { backend: (BACKENDS as readonly unknown[]).includes(j.backend) ? (j.backend as BackendName) : 'external', model: typeof j.model === 'string' ? j.model : null, ranAt: typeof j.ranAt === 'string' ? j.ranAt : '' },
    items: items.map((it) => {
      const x = normalizeItem(it as Record<string, unknown>);
      const jj = (it as { judge?: unknown }).judge;
      return isObj(jj) && typeof jj.ranAt === 'string' ? { ...x, judge: { backend: (BACKENDS as readonly unknown[]).includes(jj.backend) ? (jj.backend as BackendName) : 'external', model: typeof jj.model === 'string' ? jj.model : null, ranAt: jj.ranAt } } : x;
    }),
    failures: Array.isArray(v.failures) ? (v.failures as TurnJudgmentsFile['failures']) : [],
  };
}

export async function readTurnJudgments(path: string): Promise<TurnJudgmentsFile | null> {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} を JSON として読めません: ${(e as Error).message}`);
  }
  return validateTurnJudgments(raw);
}

export async function writeTurnJudgments(path: string, j: TurnJudgmentsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`);
  await renameReplacing(tmp, path);
}

/** 判定を足す(同じセッション・依頼番号は新しいもので置き換える)。工程名の一覧は今の設定に合わせる */
export function mergeTurnJudgments(base: TurnJudgmentsFile, items: TurnJudgment[], phases: readonly string[], judge: TurnJudgmentsFile['judge']): TurnJudgmentsFile {
  const by = new Map(base.items.map((i) => [key(i.sessionId, i.turn), i]));
  for (const i of items) by.set(key(i.sessionId, i.turn), i);
  const done = new Set(items.map((i) => key(i.sessionId, i.turn)));
  const failures = base.failures.filter((f) => !f.turns.every((t) => done.has(key(f.sessionId, t))));
  const merged = [...by.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.turn - b.turn);
  return { schemaVersion: TURN_JUDGMENTS_VERSION, phases: [...phases], judge, items: merged, failures };
}

export interface TurnImportResult {
  imported: number;
  overwritten: number;
  /** 集計に無いセッション、またはその依頼番号が無いもの(取り込むがレポートには出ない) */
  unknown: string[];
  total: number;
}

/**
 * 外部で作った依頼の判定(JSON か、JSON のコードブロックを含む返答)を検証して turn-judgments.json に足す。
 * 1 件でも形が合わなければ何も書かない。turnsBySession は セッション ID → 依頼の数(分かるときだけ。範囲外の依頼番号を知らせる)
 */
export async function importTurnJudgmentsText(
  input: string,
  path: string,
  o: { phases: readonly string[]; turnsBySession?: Map<string, number>; now?: () => Date; backend?: BackendName; model?: string | null },
): Promise<TurnImportResult> {
  const text = input.replace(/^\uFEFF/, '');
  const cands = jsonCandidates(text);
  if (cands.length === 0) throw new Error('貼り付けた返答から JSON を取り出せません(```json のコードブロックを含む返答を貼ってください)');
  const raw = itemsFromCandidates(cands);
  if (raw.length === 0) throw new Error('貼り付けた返答に判定の項目(items)がありません');
  let model: string | null = o.model ?? null;
  for (const c of cands) {
    const j = (c as { judge?: { model?: unknown } } | null)?.judge;
    if (model == null && j && typeof j.model === 'string' && j.model) model = j.model;
  }
  const problems: string[] = [];
  raw.forEach((it, i) => {
    const sid = isObj(it) && typeof it.sessionId === 'string' ? it.sessionId : '';
    const t = isObj(it) && typeof it.turn === 'number' ? it.turn : null;
    const head = `${i + 1} 件目${sid ? `(セッション ${sid}${t != null ? ` の依頼 ${t}` : ''})` : ''}`;
    problems.push(...turnItemProblems(it, head, o.phases));
  });
  if (problems.length) throw new JudgmentValidationError(problems, '返答の形が判定の形式に合いません(何も取り込んでいません)');
  const ranAt = (o.now?.() ?? new Date()).toISOString();
  const judge = { backend: o.backend ?? ('external' as BackendName), model, ranAt };
  const items = raw.map((it) => ({ ...normalizeItem(it as Record<string, unknown>), judge }));
  const base = (await readTurnJudgments(path)) ?? emptyTurnJudgments(o.phases, judge.backend, model, ranAt);
  const existing = new Set(base.items.map((i) => key(i.sessionId, i.turn)));
  const merged = mergeTurnJudgments(base, items, o.phases, judge);
  await writeTurnJudgments(path, merged);
  const unknown = o.turnsBySession
    ? items.filter((i) => !o.turnsBySession!.has(i.sessionId) || i.turn > (o.turnsBySession!.get(i.sessionId) ?? 0)).map((i) => `${i.sessionId} の依頼 ${i.turn}`)
    : [];
  return { imported: items.length, overwritten: items.filter((i) => existing.has(key(i.sessionId, i.turn))).length, unknown, total: merged.items.length };
}

/** 判定の返答の JSON Schema(判定の指示に載せる) */
export function turnJsonSchema(phases: readonly string[]): unknown {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['items'],
    properties: {
      schemaVersion: { const: TURN_JUDGMENTS_VERSION },
      judge: { type: 'object', properties: { model: { type: ['string', 'null'] } } },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sessionId', 'turn', 'kind', 'outcome', 'mismatch', 'phase', 'confidence', 'note'],
          properties: {
            sessionId: { type: 'string' },
            turn: { type: 'integer', minimum: 1 },
            kind: { enum: [...REQUEST_KINDS] },
            outcome: { enum: [...OUTCOMES], description: 'kind が question のときは helpful / follow_up / off_target / unknown、それ以外は as_is / fix_content / fix_style / rejected / unknown' },
            mismatch: { enum: [...MISMATCHES, null], description: 'outcome が fix_content / fix_style / rejected / off_target のときだけ値を入れ、それ以外は null' },
            phase: { enum: [...phases] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            note: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
  };
}
