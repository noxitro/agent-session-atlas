// judgments.json の読み書き・外部判定の取り込み
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  emptyJudgments,
  itemProblems,
  itemsFromCandidates,
  jsonCandidates,
  JudgmentValidationError,
  mergeJudgments,
  validateJudgmentItem,
  validateJudgments,
  type JudgmentItem,
  type JudgmentsFile,
} from './schema.ts';

export async function readJudgments(path: string): Promise<JudgmentsFile | null> {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} を JSON として読めません: ${(e as Error).message}`);
  }
  try {
    return validateJudgments(raw);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** 一時ファイルに書いてから置き換える(途中で落ちても壊れたファイルを残さない) */
export async function writeJudgments(path: string, j: JudgmentsFile): Promise<void> {
  validateJudgments(j);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(j, null, 2)}\n`);
  await rename(tmp, path);
}

export interface ImportResult {
  imported: number;
  /** 取り込み元で同じ sessionId が複数回出た件数(後の方を採用) */
  duplicates: number;
  /** 既存の判定を上書きした件数 */
  overwritten: number;
  /** knownIds に無い sessionId(レポートには出ない) */
  unknownIds: string[];
  total: number;
}

/**
 * 外部で作った判定(JSON、または JSON コードブロックを含む Markdown)を検証して judgments.json にマージする。
 * 1 件でも形が合わなければ何も書かずにエラー(部分的に取り込まない)。
 */
export async function importJudgments(
  file: string,
  judgmentsPath: string,
  o: { knownIds?: Set<string>; now?: () => Date } = {},
): Promise<ImportResult> {
  if (!existsSync(file)) throw new Error(`取り込むファイルがありません: ${file}`);
  const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
  const cands = jsonCandidates(text);
  if (cands.length === 0) throw new Error(`${file} から JSON を取り出せません(JSON ファイルか、\`\`\`json のコードブロックを含む Markdown を指定してください)`);
  const raw = itemsFromCandidates(cands);
  if (raw.length === 0) throw new Error(`${file} に判定項目(items)がありません`);

  let model: string | null = null;
  let ranAt: string | null = null;
  for (const c of cands) {
    const j = (c as { judge?: { model?: unknown; ranAt?: unknown } } | null)?.judge;
    if (j && typeof j.model === 'string' && j.model && model == null) model = j.model;
    if (j && typeof j.ranAt === 'string' && !Number.isNaN(Date.parse(j.ranAt)) && ranAt == null) ranAt = j.ranAt;
  }
  const now = (o.now?.() ?? new Date()).toISOString();
  ranAt ??= now;

  const problems: string[] = [];
  raw.forEach((it, i) => {
    const x = it && typeof it === 'object' ? { ...(it as Record<string, unknown>) } : it;
    if (x && typeof x === 'object') delete (x as Record<string, unknown>).judge;
    problems.push(...itemProblems(x, `項目 ${i + 1}`));
  });
  if (problems.length) throw new JudgmentValidationError(problems, `${file} の判定が judgments のスキーマに合いません(何も取り込んでいません)`);

  const by = new Map<string, JudgmentItem>();
  let duplicates = 0;
  for (const it of raw) {
    const x = { ...(it as Record<string, unknown>) };
    delete x.judge;
    const v = validateJudgmentItem(x);
    if (by.has(v.sessionId)) duplicates++;
    v.judge = { backend: 'external', model, ranAt };
    by.set(v.sessionId, v);
  }
  const base = (await readJudgments(judgmentsPath)) ?? emptyJudgments('external', model, now);
  const existing = new Set(base.items.map((i) => i.sessionId));
  const items = [...by.values()];
  const merged = mergeJudgments(base, items, { backend: 'external', model, ranAt: now });
  await writeJudgments(judgmentsPath, merged);
  return {
    imported: items.length,
    duplicates,
    overwritten: items.filter((i) => existing.has(i.sessionId)).length,
    unknownIds: o.knownIds ? items.map((i) => i.sessionId).filter((id) => !o.knownIds!.has(id)) : [],
    total: merged.items.length,
  };
}
