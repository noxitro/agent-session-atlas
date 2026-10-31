// Node 側: テンプレート(dist/template.html)にデータを埋め込んで out/atlas.html と out/sessions/<id>.html を書く。
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstalledInventory, MetricsBucket, MetricsFile, SessionRecord } from '../../core/src/types.ts';
import { createAnonymizer, identityAnonymizer, type Anonymizer } from './lib/anonymize.ts';
import { renderDetailHtml } from './detail.ts';
import { GLOSSARY_FILE, renderGlossaryHtml } from './glossary-page.ts';
import { embedData } from './lib/embed.ts';
import type { JudgmentsIndex } from './lib/judgments.ts';
import { detailFileName, summarize } from './lib/summarize.ts';
import { renderTranscript, transcriptFileName, type TranscriptOptions } from './transcript.ts';
import { loadStore, type StoreData } from '../../core/src/index.ts';
import { REPORT_DATA_VERSION, type ReportData } from './lib/types.ts';

export const REPORT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_PATH = join(REPORT_ROOT, 'dist', 'template.html');
const BASE_CSS_PATH = join(REPORT_ROOT, 'src', 'styles', 'base.css');

async function newestMtime(paths: string[]): Promise<number> {
  let max = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = await stat(p);
    if (st.isDirectory()) {
      for (const e of await readdir(p, { withFileTypes: true, recursive: true })) {
        if (e.isFile()) max = Math.max(max, (await stat(join(e.parentPath, e.name))).mtimeMs);
      }
    } else max = Math.max(max, st.mtimeMs);
  }
  return max;
}

/** dist/template.html が無いか、report のソースより古ければ Vite でビルドする */
export async function ensureTemplate(log: (msg: string) => void = () => {}): Promise<string> {
  const sources = [join(REPORT_ROOT, 'src'), join(REPORT_ROOT, 'template.html'), join(REPORT_ROOT, 'vite.config.ts'), join(REPORT_ROOT, 'svelte.config.js')];
  const fresh = existsSync(TEMPLATE_PATH) && (await stat(TEMPLATE_PATH)).mtimeMs >= (await newestMtime(sources));
  if (!fresh) {
    log('レポートのテンプレートをビルドしています(初回またはソース更新時のみ)…');
    const { build } = await import('vite');
    await build({ configFile: join(REPORT_ROOT, 'vite.config.ts'), root: REPORT_ROOT, logLevel: 'warn' });
    if (!existsSync(TEMPLATE_PATH)) throw new Error(`テンプレートのビルドに失敗しました: ${TEMPLATE_PATH} がありません`);
  }
  return TEMPLATE_PATH;
}

export interface BuildInput {
  /** CLI のフィルタを適用済みのセッション */
  sessions: SessionRecord[];
  /** 同じセッション集合に対する metrics */
  metrics: MetricsFile;
  /** インストール済みの skill(sessions.json の installed。無ければ null) */
  installed?: InstalledInventory | null;
  /** sessions.json の総件数(フィルタ前) */
  totalSessionsInSource: number;
  warnings: { unknownEventTypes: number; badLines: number };
  judgments: JudgmentsIndex | null;
  outDir: string;
  anonymize: boolean;
  scope?: Partial<ReportData['scope']>;
  /** テンプレートのパス(省略時は ensureTemplate の結果) */
  templatePath?: string;
  /** セッション記録(Markdown)も書く(atlas export)。snapshotDir の events.jsonl と session-store.db から本文と明細を読む */
  transcripts?: Omit<TranscriptOptions, 'anon' | 'generatedAt'> & { snapshotDir: string; store?: StoreData };
}

/** atlas.html の大きさの上限(docs/PLAN.md「HTML の方針」。超えても出力はするが、CLI が注意を出す) */
export const HTML_SIZE_LIMIT = 5 * 1024 * 1024;

export interface BuildResult {
  htmlPath: string;
  htmlBytes: number;
  /** htmlBytes が HTML_SIZE_LIMIT 以上 */
  oversized: boolean;
  embeddedBytes: number;
  detailDir: string;
  detailPages: number;
  detailBytes: number;
  /** セッション記録(Markdown)を書いたときの集計 */
  transcripts: { files: number; bytes: number; secretHits: number; truncated: number; fromRecordOnly: number } | null;
  ms: number;
}

function remapBuckets(b: Record<string, MetricsBucket>, map: (k: string) => string): Record<string, MetricsBucket> {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [map(k), v]));
}

export function anonymizeMetrics(m: MetricsFile, anon: Anonymizer): MetricsFile {
  if (!anon.enabled) return m;
  return { ...m, byProject: remapBuckets(m.byProject, (k) => anon.project(k)) };
}

export async function buildReport(input: BuildInput): Promise<BuildResult> {
  const t0 = performance.now();
  const templatePath = input.templatePath ?? (await ensureTemplate());
  const [template, css] = await Promise.all([readFile(templatePath, 'utf8'), readFile(BASE_CSS_PATH, 'utf8')]);
  const anon = input.anonymize ? createAnonymizer(input.sessions) : identityAnonymizer();
  const generatedAt = new Date().toISOString();
  const j = input.judgments;

  const sessions = input.sessions.map((r) => summarize(r, anon, j?.bySession.get(r.id) ?? null));
  const data: ReportData = {
    version: REPORT_DATA_VERSION,
    generatedAt,
    anonymized: anon.enabled,
    scope: {
      since: input.scope?.since ?? null,
      project: input.scope?.project ? (anon.enabled ? '(伏せ字)' : input.scope.project) : null,
      client: input.scope?.client ?? null,
      model: input.scope?.model ?? null,
      branch: input.scope?.branch ? (anon.enabled ? '(伏せ字)' : input.scope.branch) : null,
    },
    totalSessionsInSource: input.totalSessionsInSource,
    metrics: anonymizeMetrics(input.metrics, anon),
    sessions,
    judgments: {
      available: !!j,
      backend: j?.backend ?? null,
      model: j?.model ?? null,
      ranAt: j?.ranAt ?? null,
      items: j ? input.sessions.filter((s) => j.bySession.has(s.id)).length : 0,
    },
    installed: input.installed
      ? {
          skills: [...new Set([...input.installed.skills, ...input.installed.plugins.flatMap((p) => p.skills)])].sort(),
          disabled: [...(input.installed.disabledSkills ?? [])].sort(),
        }
      : null,
    warnings: input.warnings,
  };

  await mkdir(input.outDir, { recursive: true });
  const html = embedData(template, data);
  const htmlPath = join(input.outDir, 'atlas.html');
  await writeFile(htmlPath, html);
  // 用語の説明は 1 枚だけ別ページ(atlas.html と詳細ページからリンク)
  await writeFile(join(input.outDir, GLOSSARY_FILE), renderGlossaryHtml({ css, generatedAt }));

  // 詳細ページ: 前回の生成物を消してから書く(フィルタで減ったセッションのページを残さない)
  const detailDir = join(input.outDir, 'sessions');
  await rm(detailDir, { recursive: true, force: true });
  await mkdir(detailDir, { recursive: true });
  let detailBytes = 0;
  const tr = input.transcripts;
  const store = tr ? (tr.store ?? (await loadStore(join(tr.snapshotDir, 'session-store.db')))) : null;
  const trStat = tr ? { files: 0, bytes: 0, secretHits: 0, truncated: 0, fromRecordOnly: 0 } : null;
  for (const r of input.sessions) {
    const full = j?.bySession.get(r.id) ?? null;
    // 詳細ページには根拠も出す(伏せ字モードでは自由記述を出さない)
    const judgment = full ? { ...full, taskSummary: anon.freeText(full.taskSummary), rationale: anon.freeText(full.rationale) } : null;
    let transcriptHref: string | null = null;
    if (tr && store && trStat) {
      const eventsPath = join(tr.snapshotDir, 'session-state', r.id, 'events.jsonl');
      const t = await renderTranscript(r, eventsPath, store.usage.get(r.id) ?? [], { ...tr, anon, generatedAt });
      const file = transcriptFileName(r.id);
      await writeFile(join(detailDir, file), t.markdown);
      transcriptHref = file;
      trStat.files++;
      trStat.bytes += Buffer.byteLength(t.markdown);
      trStat.secretHits += t.secretHits;
      trStat.truncated += t.truncated;
      if (t.source === 'record') trStat.fromRecordOnly++;
    }
    const page = renderDetailHtml(r, { anon, css, judgment, generatedAt, transcriptHref });
    detailBytes += Buffer.byteLength(page);
    await writeFile(join(detailDir, detailFileName(r.id)), page);
  }

  return {
    htmlPath,
    htmlBytes: Buffer.byteLength(html),
    oversized: Buffer.byteLength(html) >= HTML_SIZE_LIMIT,
    embeddedBytes: Buffer.byteLength(html) - Buffer.byteLength(template),
    detailDir,
    detailPages: input.sessions.length,
    detailBytes,
    transcripts: trStat,
    ms: performance.now() - t0,
  };
}
