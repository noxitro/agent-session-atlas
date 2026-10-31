// atlas の各コマンド。元データ(~/.copilot)は core の snapshot 経由でだけ読む(コピーしてから開く)。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics, extract, METRICS_SCHEMA_VERSION, snapshot, type MetricsFile, type SessionRecord, type SessionsFile, type SnapshotManifest } from '../../core/src/index.ts';
import { buildReport, DEFAULT_TRANSCRIPT_OPTIONS, ensureTemplate, HTML_SIZE_LIMIT, matchesBase, parseJudgments, type BuildResult, type JudgmentsIndex, type ToolOutputMode } from '../../report/src/index.ts';
import {
  anthropicBackend,
  buildBundle,
  copilotCliBackend,
  importJudgments,
  opencodeBackend,
  runJudge,
  type BundleManifest,
  type JudgeBackend,
  type RunSummary,
} from '../../judge/src/index.ts';
import type { CliOptions, JudgeCliOptions } from './args.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type Log = (msg: string) => void;

export interface Paths {
  home: string;
  out: string;
  snapshot: string;
  sessions: string;
  metrics: string;
  judgments: string;
  bundle: string;
  html: string;
}

export function resolvePaths(o: Pick<CliOptions, 'home' | 'out' | 'judgments'> & { bundle?: string | null }): Paths {
  const home = resolve(o.home ?? process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot'));
  const out = resolve(o.out ?? join(REPO_ROOT, 'out'));
  return {
    home,
    out,
    snapshot: join(out, 'snapshot'),
    sessions: join(out, 'sessions.json'),
    metrics: join(out, 'metrics.json'),
    judgments: o.judgments ? resolve(o.judgments) : join(out, 'judgments.json'),
    bundle: o.bundle ? resolve(o.bundle) : join(out, 'bundle'),
    html: join(out, 'atlas.html'),
  };
}

export interface SessionFilter {
  since: string | null;
  project: string | null;
  client: string | null;
  model: string | null;
  branch: string | null;
}

export function hasFilter(f: SessionFilter): boolean {
  return !!(f.since || f.project || f.client || f.model || f.branch);
}

/**
 * CLI のフィルタ。--project は完全一致するキーがあればそれだけ、無ければ部分一致(大文字小文字を区別しない)。
 * --since は core の snapshot と同じく「その時刻以降に更新された」セッション。
 */
export function filterSessions(sessions: SessionRecord[], f: SessionFilter): { sessions: SessionRecord[]; projects: string[] } {
  let projects: string[] = [];
  if (f.project) {
    const keys = [...new Set(sessions.map((s) => s.project))];
    const exact = keys.filter((k) => k === f.project);
    projects = exact.length ? exact : keys.filter((k) => k.toLowerCase().includes(f.project!.toLowerCase()));
  }
  const pset = new Set(projects);
  const sinceMs = f.since ? Date.parse(f.since) : null;
  const out = sessions.filter((s) => {
    if (f.project && !pset.has(s.project)) return false;
    if (!matchesBase(s, { from: '', to: '', project: '', client: f.client ?? '', model: f.model ?? '', branch: f.branch ?? '' })) return false;
    if (sinceMs != null) {
      const t = Date.parse(s.updatedAt ?? s.createdAt ?? '');
      if (Number.isNaN(t) || t < sinceMs) return false;
    }
    return true;
  });
  return { sessions: out, projects };
}

async function readJson<T>(path: string, hint: string): Promise<T> {
  if (!existsSync(path)) throw new Error(`${path} がありません。${hint}`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    throw new Error(`${path} を読めません: ${(e as Error).message}`);
  }
}

const ms = (t: number): string => `${(t / 1000).toFixed(1)} 秒`;

const PROJECT_SOURCE_LABEL: Record<string, string> = {
  repository: '記録の repository',
  'git-remote': 'git の origin',
  path: 'パス',
  home: '(ホーム)',
  temp: '(一時フォルダ)',
  'atlas-judge': '(atlas の判定)',
  unknown: '不明',
};
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(2)} MB`;

export async function runSnapshot(p: Paths, since: string | null, log: Log): Promise<SnapshotManifest> {
  if (!existsSync(p.home)) throw new Error(`Copilot のデータが見つかりません: ${p.home}(--home で場所を指定できます)`);
  const t = performance.now();
  log(`snapshot: ${p.home} → ${p.snapshot}`);
  const m = await snapshot(p.home, p.snapshot, since ? { since } : {});
  log(
    `snapshot: セッションディレクトリ ${m.sessions.dirs}(複製 ${m.sessions.copiedFiles} / 再利用 ${m.sessions.reusedFiles} ファイル、${mb(m.sessions.bytes)}、session.db 複製 ${m.sessions.dbCopied ?? 0} / 再利用 ${m.sessions.dbReused ?? 0})、${ms(performance.now() - t)}`,
  );
  if (m.sessionDbErrors?.length) log(`snapshot: 注意 session.db を複製できなかったセッション ${m.sessionDbErrors.length} 件(${m.sessionDbErrors.slice(0, 3).join(' / ')})`);
  return m;
}

export async function runExtract(p: Paths, since: string | null, log: Log, tempDirs: string[] | null = null): Promise<SessionsFile> {
  if (!existsSync(p.snapshot)) throw new Error(`スナップショットがありません: ${p.snapshot}。先に atlas snapshot を実行してください。`);
  const t = performance.now();
  const s = await extract(p.snapshot, {
    ...(since ? { since } : {}),
    // --temp-dir: 挙げたフォルダだけを一時フォルダとみなす(既定のパターンは使わない)
    // (Windows 形式の絶対パスは POSIX でもそのまま。ログの記録は元のマシンのパスのため)
    ...(tempDirs ? { projects: { temps: tempDirs.map((d) => (win32.isAbsolute(d) || posix.isAbsolute(d) ? d : resolve(d))), tempPatterns: false } } : {}),
  });
  await mkdir(p.out, { recursive: true });
  await writeFile(p.sessions, JSON.stringify(s));
  const unknown = Object.values(s.warnings.unknownEventTypes).reduce((a, n) => a + n, 0);
  log(
    `extract: ${s.counts.sessions} セッション(DB のみ ${s.counts.dbOnly} / ディレクトリのみ ${s.counts.dirOnly} / 両方 ${s.counts.both}、うち空のセッション ${s.counts.empty})→ ${p.sessions}、${ms(performance.now() - t)}`,
  );
  const bySource: Record<string, number> = {};
  for (const x of s.sessions) bySource[x.projectSource] = (bySource[x.projectSource] ?? 0) + 1;
  log(
    `extract: プロジェクト ${new Set(s.sessions.map((x) => x.project)).size} 件(決め方: ${Object.entries(bySource)
      .map(([k, v]) => `${PROJECT_SOURCE_LABEL[k] ?? k} ${v}`)
      .join(' / ')})`,
  );
  if (s.installed) {
    const skills = new Set([...s.installed.skills, ...s.installed.plugins.flatMap((x) => x.skills)]).size;
    log(`extract: インストール済み skill ${skills} 件・プラグイン ${s.installed.plugins.length} 件を記録(名前だけ)${s.installed.warnings.length ? `、注意 ${s.installed.warnings.join(' / ')}` : ''}`);
  }
  if (unknown > 0 || s.warnings.badLines > 0) log(`extract: 注意 未知のイベント種別 ${unknown} 件、読めなかった行 ${s.warnings.badLines} 行`);
  return s;
}

function describeFilter(f: SessionFilter, projects: string[]): string {
  const parts: string[] = [];
  if (f.since) parts.push(`since=${f.since}`);
  if (f.project) parts.push(`project=${f.project}(該当 ${projects.length} プロジェクト)`);
  if (f.client) parts.push(`client=${f.client}`);
  if (f.model) parts.push(`model=${f.model}`);
  if (f.branch) parts.push(`branch=${f.branch}`);
  return parts.join(', ');
}

export async function runMetrics(p: Paths, f: SessionFilter, log: Log): Promise<MetricsFile> {
  const s = await readJson<SessionsFile>(p.sessions, '先に atlas extract を実行してください。');
  const { sessions, projects } = filterSessions(s.sessions, f);
  if (hasFilter(f)) log(`metrics: 絞り込み ${describeFilter(f, projects)} → ${sessions.length} / ${s.sessions.length} セッション`);
  const m = computeMetrics(sessions, { installed: s.installed });
  await writeFile(p.metrics, JSON.stringify(m, null, 2));
  log(
    `metrics: ${m.overall.sessions} セッション(空のセッション ${m.emptySessions} 件を除外)、${Object.keys(m.byProject).length} プロジェクト、${Object.keys(m.byModel).length} モデル、トークン記録なし(欠測)${m.overall.sessionsMissingTokens} セッション → ${p.metrics}`,
  );
  if (m.installedSkills) log(`metrics: インストール済みで未使用の skill ${m.installedSkills.unused.length} / ${m.installedSkills.installed.length} 件`);
  return m;
}

export interface BuildOptions extends SessionFilter {
  anonymize: boolean;
  /** export: セッション記録(Markdown)も書く */
  transcripts?: { toolOutput: ToolOutputMode; maxChars: number | null } | null;
}

export async function runBuild(p: Paths, o: BuildOptions, log: Log): Promise<BuildResult> {
  const s = await readJson<SessionsFile>(p.sessions, '先に atlas extract を実行してください。');
  const { sessions, projects } = filterSessions(s.sessions, o);
  if (hasFilter(o)) log(`build: 絞り込み ${describeFilter(o, projects)} → ${sessions.length} / ${s.sessions.length} セッション`);
  if (sessions.length === 0) log('build: 注意 条件に合うセッションが 0 件です(空のレポートを出します)');

  // metrics.json が同じセッション集合のものなら使い、違えば(フィルタ違い・古い)作り直す
  let metrics: MetricsFile | null = null;
  if (existsSync(p.metrics)) {
    const m = await readJson<MetricsFile>(p.metrics, '');
    const fresh = Date.parse(m.generatedAt) >= Date.parse(s.generatedAt);
    const sameSet = m.schemaVersion === METRICS_SCHEMA_VERSION && (m.overall?.sessions ?? -1) + (m.emptySessions ?? 0) === sessions.length;
    if (!hasFilter(o) && fresh && sameSet) metrics = m;
  }
  if (!metrics) {
    if (existsSync(p.metrics)) log('build: metrics.json がこの絞り込みと一致しないため、集計し直して埋め込みます');
    metrics = computeMetrics(sessions, { installed: s.installed });
  }

  let judgments: JudgmentsIndex | null = null;
  if (existsSync(p.judgments)) {
    judgments = parseJudgments(await readJson(p.judgments, ''));
    log(`build: judgments ${judgments.bySession.size} 件を合成(${p.judgments})`);
  }

  await ensureTemplate(log);
  const unknown = Object.values(s.warnings.unknownEventTypes).reduce((a, n) => a + n, 0);
  const r = await buildReport({
    sessions,
    metrics,
    installed: s.installed ?? null,
    totalSessionsInSource: s.sessions.length,
    warnings: { unknownEventTypes: unknown, badLines: s.warnings.badLines },
    judgments,
    outDir: p.out,
    anonymize: o.anonymize,
    scope: { since: o.since, project: o.project, client: o.client, model: o.model, branch: o.branch },
    transcripts: o.transcripts
      ? { ...DEFAULT_TRANSCRIPT_OPTIONS, toolOutput: o.transcripts.toolOutput, maxTextChars: o.transcripts.maxChars ?? DEFAULT_TRANSCRIPT_OPTIONS.maxTextChars, snapshotDir: p.snapshot }
      : undefined,
  });
  if (r.transcripts) {
    const t = r.transcripts;
    log(
      `export: セッション記録 ${t.files} 件(計 ${mb(t.bytes)})→ ${join(r.detailDir, '<id>.md')}${t.fromRecordOnly ? `、うちスナップショットに本文が無く抜粋のみ ${t.fromRecordOnly} 件` : ''}${t.truncated ? `、中略した本文 ${t.truncated} 件` : ''}`,
    );
    if (t.secretHits) log(`export: 注意 API キーやトークンらしい文字列を ${t.secretHits} 件伏せました。本物なら元の記録にも残っているので鍵を作り直してください`);
    if (o.anonymize) log('export: 注意 伏せ字モードの記録は自由記述を機械的に置き換えただけです。共有する前に中身を確認してください');
  }
  log(
    `build: ${r.htmlPath}(${mb(r.htmlBytes)}、うち埋め込みデータ ${mb(r.embeddedBytes)})、詳細ページ ${r.detailPages} 件(計 ${mb(r.detailBytes)})${o.anonymize ? '、伏せ字モード' : ''}、${ms(r.ms)}`,
  );
  if (r.oversized)
    log(
      `build: 注意 atlas.html が上限 ${mb(HTML_SIZE_LIMIT)} 以上です(${mb(r.htmlBytes)})。ブラウザで開くのが遅くなります。--since で期間を、--project などで対象を絞って作り直してください`,
    );
  return r;
}

const kb = (b: number): string => `${(b / 1024).toFixed(1)} KB`;

export async function runBundle(p: Paths, f: SessionFilter, o: { includeEmpty: boolean }, log: Log): Promise<BundleManifest> {
  const s = await readJson<SessionsFile>(p.sessions, '先に atlas extract(または atlas all)を実行してください。');
  const { sessions, projects } = filterSessions(s.sessions, f);
  if (hasFilter(f)) log(`bundle: 絞り込み ${describeFilter(f, projects)} → ${sessions.length} / ${s.sessions.length} セッション`);
  const t = performance.now();
  const m = await buildBundle(sessions, {
    bundleDir: p.bundle,
    snapshotDir: p.snapshot,
    includeEmpty: o.includeEmpty,
    scope: { since: f.since, project: f.project, client: f.client, model: f.model, branch: f.branch },
    log,
  });
  const excerpt = m.sessions.filter((e) => e.textSource === 'excerpt').length;
  const truncated = m.sessions.filter((e) => e.truncated > 0).length;
  log(
    `bundle: パケット ${m.count} 件(依頼の記録が無く対象外 ${m.skipped.length} 件)、合計 ${mb(m.totalBytes)}、最大 ${kb(m.maxBytes)}、本文を中略したもの ${truncated} 件${excerpt ? `、抜粋のみ ${excerpt} 件` : ''} → ${p.bundle}、${ms(performance.now() - t)}`,
  );
  log('bundle: 外部の LLM に渡すときは bundle フォルダごと ZIP にして、INSTRUCTIONS.md を最初に読ませてください');
  return m;
}

export function makeBackend(j: JudgeCliOptions): JudgeBackend {
  const timeoutMs = j.timeoutSec * 1000;
  switch (j.backend) {
    case 'copilot-cli':
      return copilotCliBackend({ model: j.model, allowTools: j.allowTools, timeoutMs });
    case 'opencode':
      return opencodeBackend({ model: j.model, timeoutMs });
    case 'anthropic':
      return anthropicBackend({ model: j.model, timeoutMs });
  }
}

export async function runJudgeCommand(p: Paths, j: JudgeCliOptions, log: Log, backend?: JudgeBackend): Promise<RunSummary | null> {
  if (j.action === 'import') {
    let known: Set<string> | undefined;
    if (existsSync(p.sessions)) known = new Set((await readJson<SessionsFile>(p.sessions, '')).sessions.map((s) => s.id));
    const r = await importJudgments(resolve(j.file!), p.judgments, { knownIds: known });
    log(`judge import: ${r.imported} 件を取り込みました(既存の上書き ${r.overwritten} 件、取り込み元の重複 ${r.duplicates} 件)→ ${p.judgments}(計 ${r.total} 件)`);
    if (r.unknownIds.length) log(`judge import: 注意 sessions.json に無いセッション ID が ${r.unknownIds.length} 件あります(レポートには出ません): ${r.unknownIds.slice(0, 5).join(', ')}${r.unknownIds.length > 5 ? ' …' : ''}`);
    return null;
  }
  if (j.backend === 'anthropic') log('judge: 注意 anthropic バックエンドは Anthropic API の従量課金です');
  const s = await runJudge({
    bundleDir: p.bundle,
    judgmentsPath: p.judgments,
    backend: backend ?? makeBackend(j),
    limit: j.limit,
    only: j.only,
    force: j.force,
    concurrency: j.concurrency,
    log,
  });
  const usage = Object.entries(s.usage.totals)
    .slice(0, 8)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  log(`judge: 完了 成功 ${s.succeeded} / 失敗 ${s.failed.length} / 対象 ${s.attempted}(判定済みでスキップ ${s.alreadyJudged})→ ${p.judgments}`);
  log(`judge: 判定自体の使用量 ${s.usage.runs} 回分${usage ? `(${usage})` : ''}${s.usage.missing ? `、取得できなかった ${s.usage.missing} 回` : ''}`);
  for (const n of s.notes.slice(0, 5)) log(`judge: 補足 ${n}`);
  return s;
}

export async function run(o: CliOptions, log: Log): Promise<{ paths: Paths; build?: BuildResult; judge?: RunSummary | null }> {
  const p = resolvePaths(o);
  const f: SessionFilter = { since: o.since, project: o.project, client: o.client, model: o.model, branch: o.branch };
  const t = performance.now();
  switch (o.command) {
    case 'snapshot':
      await runSnapshot(p, o.since, log);
      return { paths: p };
    case 'extract':
      await runExtract(p, o.since, log, o.tempDirs);
      return { paths: p };
    case 'metrics':
      await runMetrics(p, f, log);
      return { paths: p };
    case 'build':
      return { paths: p, build: await runBuild(p, { ...f, anonymize: o.anonymize }, log) };
    case 'export':
      return { paths: p, build: await runBuild(p, { ...f, anonymize: o.anonymize, transcripts: { toolOutput: o.toolOutput, maxChars: o.maxChars } }, log) };
    case 'bundle':
      await runBundle(p, f, { includeEmpty: o.includeEmpty }, log);
      return { paths: p };
    case 'judge':
      return { paths: p, judge: await runJudgeCommand(p, o.judge!, log) };
    case 'all': {
      await runSnapshot(p, o.since, log);
      await runExtract(p, o.since, log, o.tempDirs);
      await runMetrics(p, f, log);
      const build = await runBuild(p, { ...f, anonymize: o.anonymize }, log);
      log(`all: 完了 ${ms(performance.now() - t)}`);
      return { paths: p, build };
    }
  }
}
