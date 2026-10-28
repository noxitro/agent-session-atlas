import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extract } from './extract.ts';
import { computeMetrics } from './metrics.ts';
import { snapshot, type SnapshotManifest } from './snapshot.ts';
import type { MetricsFile, SessionsFile } from './types.ts';

export interface PipelineResult {
  manifest: SnapshotManifest;
  sessions: SessionsFile;
  metrics: MetricsFile;
  paths: { snapshot: string; sessions: string; metrics: string };
  timingsMs: { snapshot: number; extract: number; metrics: number };
}

/** snapshot → extract → metrics を通しで実行し、outDir に sessions.json / metrics.json を書く */
export async function runPipeline(src: string, outDir: string, opts: { since?: string } = {}): Promise<PipelineResult> {
  await mkdir(outDir, { recursive: true });
  const snapDir = join(outDir, 'snapshot');
  let t = performance.now();
  const manifest = await snapshot(src, snapDir, opts.since ? { since: opts.since } : {});
  const tSnap = performance.now() - t;
  t = performance.now();
  const sessions = await extract(snapDir);
  const tExt = performance.now() - t;
  t = performance.now();
  const metrics = computeMetrics(sessions.sessions);
  const tMet = performance.now() - t;
  const paths = { snapshot: snapDir, sessions: join(outDir, 'sessions.json'), metrics: join(outDir, 'metrics.json') };
  await writeFile(paths.sessions, JSON.stringify(sessions));
  await writeFile(paths.metrics, JSON.stringify(metrics, null, 2));
  return { manifest, sessions, metrics, paths, timingsMs: { snapshot: tSnap, extract: tExt, metrics: tMet } };
}
