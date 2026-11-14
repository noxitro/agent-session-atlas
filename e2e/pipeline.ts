// snapshot → extract → metrics を atlas の実行ファイルで通しで動かし、出力(sessions.json・metrics.json)を読み戻す(e2e の phase1 が使う)。
// wiki などの設定は、globalSetup が ATLAS_CONFIG に指した fixture 用の設定(または実データでは手元の設定)から atlas が読む。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricsFile, SessionsFile } from '../packages/report/src/shared/types.ts';
import { ROOT, cliCommand } from './fixture-home.ts';

export interface PipelineResult {
  sessions: SessionsFile;
  metrics: MetricsFile;
  paths: { snapshot: string; sessions: string; metrics: string };
  timingsMs: { snapshot: number; extract: number; metrics: number };
}

function step(args: string[]): number {
  const t = performance.now();
  const [cmd, a] = cliCommand(args);
  const r = spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`atlas ${args.join(' ')} が失敗しました(終了コード ${r.status}): ${r.stderr || r.error?.message}`);
  return performance.now() - t;
}

/** src(~/.copilot と同じ形)を outDir に集計する。元は書き換えない(atlas snapshot が複製してから読む) */
export function runPipeline(src: string, outDir: string): PipelineResult {
  mkdirSync(outDir, { recursive: true });
  const snapshot = step(['snapshot', '--home', src, '--out', outDir]);
  const extract = step(['extract', '--home', src, '--out', outDir]);
  const metrics = step(['metrics', '--home', src, '--out', outDir]);
  const paths = { snapshot: join(outDir, 'snapshot'), sessions: join(outDir, 'sessions.json'), metrics: join(outDir, 'metrics.json') };
  return {
    sessions: JSON.parse(readFileSync(paths.sessions, 'utf8')) as SessionsFile,
    metrics: JSON.parse(readFileSync(paths.metrics, 'utf8')) as MetricsFile,
    paths,
    timingsMs: { snapshot, extract, metrics },
  };
}
