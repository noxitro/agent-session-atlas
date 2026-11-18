// judge run: バンドルの各パケットをバックエンドで判定し、judgments.json に 1 件ずつ追記する。
// 失敗したセッションは failures に記録して次へ進む(黙って捨てない)。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JudgeBackend } from './backends/types.ts';
import { readBundleManifest } from './bundle.ts';
import { readJudgments, writeJudgments } from './judgments-io.ts';
import { missingSections, packetSessionId } from './packet.ts';
import { addUsage, emptyJudgments, mergeJudgments, type JudgeUsage, type JudgmentFailure, type JudgmentsFile } from './schema.ts';

export interface RunOptions {
  bundleDir: string;
  judgmentsPath: string;
  backend: JudgeBackend;
  /** 判定する最大件数(未判定のものから) */
  limit?: number | null;
  /** このセッションだけ */
  only?: string[] | null;
  /** 判定済みでも判定し直す */
  force?: boolean;
  concurrency?: number;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface RunSummary {
  /** バンドルのパケット数 */
  packets: number;
  /** 判定済みのためスキップ */
  alreadyJudged: number;
  attempted: number;
  succeeded: number;
  failed: { sessionId: string; error: string }[];
  usage: JudgeUsage;
  notes: string[];
  /** llm-wiki のページごとの判定の一部を捨てたセッション(そのページは未判定。補足の先頭 5 件に埋もれないよう、件数の 1 行で出す) */
  wikiPageDrops: string[];
}

/**
 * 判定するセッションの ID(--only / --session)を、添付(バンドル)の ID に読み替える。完全に同じ ID を優先し、無ければ先頭一致で
 * 1 つに決まるもの。複数に当たる・どれにも当たらないものがあれば止める
 */
export function resolveOnly(only: readonly string[], ids: readonly string[]): Set<string> {
  const want = new Set<string>();
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const q of only) {
    if (ids.includes(q)) {
      want.add(q);
      continue;
    }
    const hits = ids.filter((id) => id.startsWith(q));
    if (hits.length === 1) want.add(hits[0]!);
    else if (!hits.length) unknown.push(q);
    else ambiguous.push(`${q}(${hits.length} 件)`);
  }
  if (ambiguous.length) throw new Error(`セッション ID の先頭が、添付(バンドル)の複数のセッションに当たります: ${ambiguous.join(', ')}。もっと長く指定してください`);
  if (unknown.length) {
    throw new Error(
      `バンドルに無いセッション ID です: ${unknown.join(', ')}。判定済みのセッションは、未判定だけで作った添付(bundle --unjudged・画面の「添付ファイルを作る」)には入りません。判定し直すときは npm run atlas:judge -- --session <ID の先頭> --force を使ってください`,
    );
  }
  return want;
}

export async function runJudge(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? (() => {});
  const now = () => (o.now?.() ?? new Date()).toISOString();
  const manifest = await readBundleManifest(o.bundleDir);
  let entries = manifest.sessions;
  if (o.only && o.only.length) {
    const want = resolveOnly(o.only, manifest.sessions.map((s) => s.id));
    entries = entries.filter((e) => want.has(e.id));
  }
  let judgments: JudgmentsFile = (await readJudgments(o.judgmentsPath)) ?? emptyJudgments(o.backend.name, o.backend.model, now());
  const judged = new Set(judgments.items.map((i) => i.sessionId));
  const todo = o.force ? entries : entries.filter((e) => !judged.has(e.id));
  const alreadyJudged = entries.length - todo.length;
  const targets = o.limit != null ? todo.slice(0, Math.max(0, o.limit)) : todo;
  log(`judge: バックエンド ${o.backend.name}${o.backend.model ? `(${o.backend.model})` : ''}、対象 ${targets.length} 件(パケット ${manifest.sessions.length}、判定済みでスキップ ${alreadyJudged})`);

  const ranAt = now();
  const summary: RunSummary = { packets: manifest.sessions.length, alreadyJudged, attempted: targets.length, succeeded: 0, failed: [], usage: { runs: 0, missing: 0, totals: {} }, notes: [], wikiPageDrops: [] };

  // judgments.json への書き込みは直列にする(並列判定でも 1 件ずつ確定させる)
  let chain: Promise<void> = Promise.resolve();
  const commit = (fn: (j: JudgmentsFile) => JudgmentsFile): Promise<void> => {
    chain = chain.then(async () => {
      judgments = fn(judgments);
      await writeJudgments(o.judgmentsPath, judgments);
    });
    return chain;
  };
  const meta = (): JudgmentsFile['judge'] => ({ backend: o.backend.name, model: o.backend.model, ranAt, usage: summary.usage });

  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const e = targets[next++];
      const t0 = performance.now();
      try {
        const md = await readFile(join(o.bundleDir, e.path), 'utf8');
        const id = packetSessionId(md);
        if (id !== e.id) throw new Error(`パケット ${e.path} のセッション ID(${id ?? 'なし'})が manifest(${e.id})と一致しません`);
        const miss = missingSections(md);
        if (miss.length) throw new Error(`パケット ${e.path} に必須の見出しがありません: ${miss.join('、')}`);
        const r = await o.backend.judge({ sessionId: e.id, markdown: md });
        r.item.judge = { backend: o.backend.name, model: o.backend.model, ranAt: now() };
        summary.usage = addUsage(summary.usage, r.usage);
        for (const n of r.notes) summary.notes.push(`${e.id}: ${n}`);
        if (r.wikiNotes?.length) summary.wikiPageDrops.push(e.id);
        summary.succeeded++;
        await commit((j) => mergeJudgments(j, [r.item], meta()));
        log(`judge: [${++done}/${targets.length}] ${e.id} → ${r.item.taskCategory} ${r.item.humanEffort.hours} 時間(確信度 ${r.item.humanEffort.confidence})、${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
      } catch (err) {
        const msg = (err as Error).message;
        summary.failed.push({ sessionId: e.id, error: msg });
        const f: JudgmentFailure = { sessionId: e.id, backend: o.backend.name, model: o.backend.model, at: now(), error: msg };
        await commit((j) => ({ ...j, judge: meta(), failures: [...(j.failures ?? []).filter((x) => x.sessionId !== e.id), f] }));
        log(`judge: [${++done}/${targets.length}] ${e.id} 失敗: ${msg}`);
      }
    }
  };
  const n = Math.max(1, Math.min(o.concurrency ?? 1, targets.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  await chain;
  return summary;
}
