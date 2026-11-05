// 段階 2: 依頼ごとの判定を GitHub Copilot CLI(copilot -p)で回す。塊(数件の依頼)ごとに 1 回呼び、
// 返った JSON を検証して turn-judgments.json に 1 塊ずつ確定させる。失敗した塊は failures に残して次へ進む。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JudgeBackend } from './backends/types.ts';
import { itemsFromCandidates, jsonCandidates } from './schema.ts';
import { buildTurnPrompt, TURN_BUNDLE_VERSION, type TurnBundleManifest } from './turn-bundle.ts';
import { emptyTurnJudgments, mergeTurnJudgments, readTurnJudgments, turnItemProblems, writeTurnJudgments, type TurnJudgment } from './turn-schema.ts';

export interface TurnRunOptions {
  bundleDir: string;
  path: string;
  backend: JudgeBackend;
  /** 判定する依頼の数の上限(塊の途中では切らないので、少し超えることがある) */
  limit?: number | null;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface TurnRunSummary {
  chunks: number;
  attempted: number;
  succeeded: number;
  turns: number;
  failed: { sessionId: string; turns: number[]; error: string }[];
}

export async function readTurnBundleManifest(bundleDir: string): Promise<TurnBundleManifest> {
  const p = join(bundleDir, 'manifest.json');
  let m: TurnBundleManifest;
  try {
    m = JSON.parse(await readFile(p, 'utf8')) as TurnBundleManifest;
  } catch (e) {
    throw new Error(`${p} を読めません。先に atlas turns bundle を実行してください(${(e as Error).message})`);
  }
  if (m.version !== TURN_BUNDLE_VERSION || !Array.isArray(m.chunks)) throw new Error(`${p} の形式が想定と違います(version ${String(m.version)})`);
  return m;
}

/** 返った本文から、塊の依頼の判定を取り出して検証する(全部そろっていなければエラー) */
export function turnItemsFromTexts(texts: string[], sessionId: string, turns: number[], phases: readonly string[]): TurnJudgment[] {
  const problems: string[] = [];
  for (let i = texts.length - 1; i >= 0; i--) {
    const raw = itemsFromCandidates(jsonCandidates(texts[i]));
    if (!raw.length) continue;
    const items = raw.map((it) => (it && typeof it === 'object' ? { sessionId, ...(it as Record<string, unknown>) } : it));
    const p = items.flatMap((it, k) => turnItemProblems(it, `${k + 1} 件目`, phases));
    const got = new Set(items.map((it) => (it as { turn?: unknown }).turn));
    const missing = turns.filter((t) => !got.has(t));
    const wrong = items.filter((it) => (it as { sessionId?: unknown }).sessionId !== sessionId).length;
    if (missing.length) p.push(`依頼 ${missing.join(', ')} の判定がありません`);
    if (wrong) p.push(`sessionId が違う項目が ${wrong} 件あります`);
    if (p.length) {
      problems.push(...p);
      continue;
    }
    return items
      .filter((it) => turns.includes((it as { turn: number }).turn))
      .map((it) => {
        const x = it as Record<string, unknown>;
        return {
          sessionId,
          turn: x.turn as number,
          kind: x.kind as TurnJudgment['kind'],
          outcome: x.outcome as TurnJudgment['outcome'],
          mismatch: (x.mismatch ?? null) as TurnJudgment['mismatch'],
          phase: x.phase as string,
          confidence: x.confidence as number,
          note: typeof x.note === 'string' ? x.note.trim() : '',
        };
      });
  }
  if (texts.length === 0) throw new Error('応答に assistant の本文がありません');
  if (!problems.length) throw new Error(`応答から JSON を取り出せません(本文の末尾: ${texts[texts.length - 1].slice(-300)})`);
  throw new Error(`応答の JSON が形式に合いません: ${problems.slice(0, 8).join(' / ')}`);
}

export async function runTurnJudge(o: TurnRunOptions): Promise<TurnRunSummary> {
  const log = o.log ?? (() => {});
  const now = () => (o.now?.() ?? new Date()).toISOString();
  if (!o.backend.ask) throw new Error(`${o.backend.name} では依頼ごとの判定を回せません(GitHub Copilot CLI か、チャットに貼る方法を使ってください)`);
  const m = await readTurnBundleManifest(o.bundleDir);
  let file = (await readTurnJudgments(o.path)) ?? emptyTurnJudgments(m.phases, o.backend.name, o.backend.model, now());
  const done = new Set(file.items.map((i) => `${i.sessionId}#${i.turn}`));
  const todo = m.chunks.map((c, i) => ({ ...c, no: i + 1 })).filter((c) => c.turns.some((t) => !done.has(`${c.sessionId}#${t}`)));
  const targets: typeof todo = [];
  let planned = 0;
  for (const c of todo) {
    if (o.limit != null && planned >= o.limit) break;
    targets.push(c);
    planned += c.turns.length;
  }
  log(`turns: バックエンド ${o.backend.name}${o.backend.model ? `(${o.backend.model})` : ''}、対象 ${planned} 依頼・${targets.length} 回(未判定 ${todo.reduce((a, c) => a + c.turns.length, 0)} 依頼)`);
  const summary: TurnRunSummary = { chunks: m.chunks.length, attempted: targets.length, succeeded: 0, turns: 0, failed: [] };
  for (const c of targets) {
    const md = await readFile(join(o.bundleDir, 'chunks', `${String(c.no).padStart(4, '0')}.md`), 'utf8');
    const label = `${c.sessionId}-${c.turns[0]}`;
    try {
      const r = await o.backend.ask(buildTurnPrompt({ sessionId: c.sessionId, turns: c.turns, markdown: md }, m.phases), label);
      // 塊の中で判定済みの依頼は判定し直さない(画面の「判定済みは判定し直しません」と揃える)
      const items = turnItemsFromTexts(r.texts, c.sessionId, c.turns, m.phases).filter((i) => !done.has(`${i.sessionId}#${i.turn}`));
      const judge = { backend: o.backend.name, model: o.backend.model, ranAt: now() };
      file = mergeTurnJudgments(file, items.map((i) => ({ ...i, judge })), m.phases, judge);
      await writeTurnJudgments(o.path, file);
      summary.succeeded++;
      summary.turns += items.length;
      log(`turns: ${c.sessionId} の依頼 ${c.turns[0]}〜${c.turns[c.turns.length - 1]} を判定しました`);
    } catch (e) {
      const error = (e as Error).message;
      summary.failed.push({ sessionId: c.sessionId, turns: c.turns, error });
      file = { ...file, failures: [...file.failures.filter((f) => !(f.sessionId === c.sessionId && f.turns.join() === c.turns.join())), { sessionId: c.sessionId, turns: c.turns, error, at: now() }] };
      await writeTurnJudgments(o.path, file);
      log(`turns: ${c.sessionId} の依頼 ${c.turns[0]}〜${c.turns[c.turns.length - 1]} を判定できませんでした: ${error}`);
    }
  }
  log(`turns: ${summary.turns} 依頼を判定(成功 ${summary.succeeded} 回、失敗 ${summary.failed.length} 回)→ ${o.path}`);
  return summary;
}
