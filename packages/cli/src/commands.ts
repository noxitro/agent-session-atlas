// atlas の各コマンド。元データ(~/.copilot)は core の snapshot 経由でだけ読む(コピーしてから開く)。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeStamp, computeMetrics, extract, METRICS_SCHEMA_VERSION, snapshot, type MetricsFile, type SessionRecord, type SessionsFile, type SnapshotManifest } from '../../core/src/index.ts';
import {
  buildReport,
  DEFAULT_TRANSCRIPT_OPTIONS,
  ensureTemplate,
  GROUPS_FILE_NAME,
  HTML_SIZE_LIMIT,
  loadGroups,
  loadGroupsForWrite,
  loadMemoIndex,
  matchesBase,
  memosDir,
  memoSummary,
  NOTES_DIR_NAME,
  parseJudgments,
  parseVerdicts,
  type VerdictIndex,
  readMemo,
  resolveIdPrefixes,
  saveGroups,
  saveMemo,
  uniqueIds,
  type BuildResult,
  type JudgmentsIndex,
  type LoadedGroups,
  type ToolOutputMode,
} from '../../report/src/index.ts';
import {
  anthropicBackend,
  buildBundle,
  copilotCliBackend,
  draftSkill,
  type DraftCandidate,
  importJudgments,
  readJudgments,
  buildTurnBundle,
  importTurnJudgmentsText,
  readTurnJudgments,
  runTurnJudge,
  turnImportPhases,
  runJudge,
  type BundleManifest,
  type JudgeBackend,
  type RunSummary,
} from '../../judge/src/index.ts';
import type { CliOptions, GroupCliOptions, JudgeCliOptions, MemoCliOptions, TurnsCliOptions } from './args.ts';
import { findRunningServer, openInBrowser, startServe } from './serve.ts';
import { acquireOutLock } from './jobs.ts';
import { buildTables } from './tables.ts';
import { exportGroup } from './group-export.ts';
import { CONFIG_FILE, loadConfig, parseUploadRoot, phaseNames } from './config.ts';
import { checkUpload, uploadGroup } from './group-upload.ts';

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
  /** 依頼ごとの判定(段階 2)の結果と、判定に渡すファイル */
  turnJudgments: string;
  turnBundle: string;
  html: string;
  /** メモとグループの置き場(既定はリポジトリ直下の atlas-notes/。out/ ではなくユーザーが管理するもの) */
  notes: string;
  groups: string;
}

export function resolvePaths(o: Pick<CliOptions, 'home' | 'out' | 'judgments'> & { bundle?: string | null; notesDir?: string | null }): Paths {
  const home = resolve(o.home ?? process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot'));
  const out = resolve(o.out ?? join(REPO_ROOT, 'out'));
  const notes = resolve(o.notesDir ?? join(REPO_ROOT, NOTES_DIR_NAME));
  return {
    home,
    out,
    snapshot: join(out, 'snapshot'),
    sessions: join(out, 'sessions.json'),
    metrics: join(out, 'metrics.json'),
    judgments: o.judgments ? resolve(o.judgments) : join(out, 'judgments.json'),
    bundle: o.bundle ? resolve(o.bundle) : join(out, 'bundle'),
    turnJudgments: join(out, 'turn-judgments.json'),
    turnBundle: join(out, 'turn-bundle'),
    html: join(out, 'atlas.html'),
    notes,
    groups: join(notes, GROUPS_FILE_NAME),
  };
}

export interface SessionFilter {
  since: string | null;
  project: string | null;
  client: string | null;
  model: string | null;
  branch: string | null;
  /** 名前付きグループ(groups.json)の名前 */
  group?: string | null;
  /** 特定のセッション(id の先頭一致。解決前) */
  sessions?: string[] | null;
}

export function hasFilter(f: SessionFilter): boolean {
  return !!(f.since || f.project || f.client || f.model || f.branch || f.group || f.sessions?.length);
}

/**
 * CLI のフィルタ。--project は完全一致するキーがあればそれだけ、無ければ部分一致(大文字小文字を区別しない)。
 * --since は core の snapshot と同じく「その時刻以降に更新された」セッション。
 * ids は --group / --session を解決した後のセッション id の集合(null なら制限なし)。他の条件と AND。
 */
export function filterSessions(sessions: SessionRecord[], f: SessionFilter, ids: Set<string> | null = null): { sessions: SessionRecord[]; projects: string[] } {
  let projects: string[] = [];
  if (f.project) {
    const keys = [...new Set(sessions.map((s) => s.project))];
    const exact = keys.filter((k) => k === f.project);
    projects = exact.length ? exact : keys.filter((k) => k.toLowerCase().includes(f.project!.toLowerCase()));
  }
  const pset = new Set(projects);
  const sinceMs = f.since ? Date.parse(f.since) : null;
  const out = sessions.filter((s) => {
    if (ids && !ids.has(s.id)) return false;
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

export async function runSnapshot(p: Paths, since: string | null, log: Log, all = false, prune = false): Promise<SnapshotManifest> {
  if (!existsSync(p.home)) throw new Error(`Copilot のデータが見つかりません: ${p.home}(--home で場所を指定できます)`);
  const t = performance.now();
  log(`snapshot: ${p.home} → ${p.snapshot}${all ? '(--snapshot-all)' : ''}${prune ? '(--snapshot-prune)' : ''}`);
  const m = await snapshot(p.home, p.snapshot, { ...(since ? { since } : {}), all, prune });
  log(
    `snapshot: セッションディレクトリ ${m.sessions.dirs}(複製 ${m.sessions.copiedFiles} / 再利用 ${m.sessions.reusedFiles} ファイル、${mb(m.sessions.bytes)}、session.db 複製 ${m.sessions.dbCopied ?? 0} / 再利用 ${m.sessions.dbReused ?? 0})、${ms(performance.now() - t)}`,
  );
  for (const [name, d] of Object.entries(m.databases)) if (!d.copied && d.error) log(`snapshot: 注意 ${name} を今回は複製できませんでした(${d.bytes ? '前回の複製を使います' : '前回の複製も無いので、このファイルの内容は使いません'}): ${d.error}`);
  if (m.sessionDbErrors?.length) log(`snapshot: 注意 session.db を複製できなかったセッション ${m.sessionDbErrors.length} 件(${m.sessionDbErrors.slice(0, 3).join(' / ')})`);
  const x = m.extras;
  if (x) {
    const top = Object.entries(x.topLevel).map(([k, v]) => `${k} ${v.files}`).join(' / ');
    log(`snapshot: 付随物 セッションフォルダ ${x.sessionFiles} ファイル(${mb(x.sessionBytes)})${top ? `、直下 ${top}` : ''}、写さなかったもの ${x.skipped.length} 件(${mb(x.skipped.reduce((a, s) => a + s.bytes, 0))}。manifest の extras.skipped)`);
    if (x.desktop) log(`snapshot: data.db → desktop.json(許可リストの列だけ、${x.desktop.sessions} セッション${x.desktop.warnings.length ? `、注意 ${x.desktop.warnings.join(' / ')}` : ''})`);
    if (x.leftover.length) log(`snapshot: 前回 --snapshot-all で写したもの ${x.leftover.length} 件が残っています(最新 ${x.leftover.map((l) => l.mtime).sort().at(-1)}。消すには --snapshot-prune。manifest の extras.leftover)`);
  }
  return m;
}

export async function runExtract(p: Paths, since: string | null, log: Log, tempDirs: string[] | null = null, config: string | null = null): Promise<SessionsFile> {
  if (!existsSync(p.snapshot)) throw new Error(`スナップショットがありません: ${p.snapshot}。先に atlas snapshot を実行してください。`);
  const t = performance.now();
  const configPath = config ?? process.env.ATLAS_CONFIG ?? null;
  const cfg = await loadConfig(configPath ? resolve(configPath) : join(REPO_ROOT, CONFIG_FILE), configPath != null);
  const s = await extract(p.snapshot, {
    ...(since ? { since } : {}),
    ...(cfg.wikis ? { wikis: cfg.wikis } : {}),
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
  if (cfg.wikis?.length) {
    const used = s.sessions.filter(({ wiki: w }) => w.indexReads + w.pageReads.length + w.skillCalls.length + w.writes + w.otherCalls > 0).length;
    log(`extract: wiki の対象 ${cfg.wikis.map((w) => w.path).join('、')}(${cfg.path})、参照のあったセッション ${used} 件`);
  } else log(`extract: wiki は未設定のため集計しません(${CONFIG_FILE} の wikis で vault を指定できます)`);
  if (unknown > 0 || s.warnings.badLines > 0) log(`extract: 注意 未知のイベント種別 ${unknown} 件、読めなかった行 ${s.warnings.badLines} 行`);
  return s;
}

function describeFilter(f: SessionFilter, projects: string[], ids: ResolvedIds | null): string {
  const parts: string[] = [];
  if (f.since) parts.push(`since=${f.since}`);
  if (f.project) parts.push(`project=${f.project}(該当 ${projects.length} プロジェクト)`);
  if (f.client) parts.push(`client=${f.client}`);
  if (f.model) parts.push(`model=${f.model}`);
  if (f.branch) parts.push(`branch=${f.branch}`);
  if (f.group && ids) parts.push(`group=${f.group}(${ids.groupKnown} / ${ids.groupTotal} 件が記録にある)`);
  if (f.sessions?.length && ids) parts.push(`session=${ids.sessionIds.length} 件`);
  return parts.join(', ');
}

export interface ResolvedIds {
  /** 他の条件と AND する id の集合 */
  set: Set<string>;
  groupTotal: number;
  groupKnown: number;
  sessionIds: string[];
}

/**
 * --group と --session をセッション id の集合に解決する(どちらも無ければ null)。
 * グループが無い名前・曖昧な id・記録に無い id はエラー(黙って 0 件にしない)。グループの ids に記録に無い id があるのは許す(件数だけ知らせる)。
 */
export function resolveIdFilter(all: SessionRecord[], f: SessionFilter, groups: LoadedGroups): ResolvedIds | null {
  if (!f.group && !f.sessions?.length) return null;
  const known = all.map((s) => s.id);
  const knownSet = new Set(known);
  let set: Set<string> | null = null;
  let groupTotal = 0;
  let groupKnown = 0;
  if (f.group) {
    const g = groups.groups.find((x) => x.name === f.group);
    if (!g) {
      const names = groups.groups.map((x) => x.name);
      throw new Error(
        groups.exists
          ? `グループ「${f.group}」は ${groups.path} にありません${names.length ? `(あるのは: ${names.join(', ')})` : ''}${groups.warnings.length ? `。読めなかった箇所: ${groups.warnings.join(' / ')}` : ''}`
          : `グループ「${f.group}」を探す ${groups.path} がありません(atlas group add で作れます。場所は --notes-dir で変えられます)`,
      );
    }
    set = new Set(g.ids);
    groupTotal = g.ids.length;
    groupKnown = g.ids.filter((id) => knownSet.has(id)).length;
  }
  let sessionIds: string[] = [];
  if (f.sessions?.length) {
    sessionIds = resolveIdPrefixes(known, f.sessions);
    const s = new Set(sessionIds);
    set = set ? new Set([...set].filter((id) => s.has(id))) : s;
  }
  return { set: set!, groupTotal, groupKnown, sessionIds };
}

interface Selected {
  file: SessionsFile;
  sessions: SessionRecord[];
  groups: LoadedGroups;
}

/** sessions.json を読み、groups.json を読み(無ければ空)、CLI の絞り込みを掛ける。共通のログも出す */
async function selectSessions(p: Paths, f: SessionFilter, cmd: string, hint: string, log: Log): Promise<Selected> {
  const file = await readJson<SessionsFile>(p.sessions, hint);
  const groups = await loadGroups(p.groups);
  for (const w of groups.warnings) log(`${cmd}: 注意 ${w}`);
  const ids = resolveIdFilter(file.sessions, f, groups);
  const { sessions, projects } = filterSessions(file.sessions, f, ids?.set ?? null);
  if (hasFilter(f)) log(`${cmd}: 絞り込み ${describeFilter(f, projects, ids)} → ${sessions.length} / ${file.sessions.length} セッション`);
  return { file, sessions, groups };
}

/** tables: out/tables/ に表も書く(伏せ字版の all では書かない。依頼文とパスがそのまま入るため) */
export async function runMetrics(p: Paths, f: SessionFilter, log: Log, o: { tables?: boolean } = {}): Promise<MetricsFile> {
  const { file: s, sessions } = await selectSessions(p, f, 'metrics', '先に atlas extract を実行してください。', log);
  const m = computeMetrics(sessions, { installed: s.installed });
  await writeFile(p.metrics, JSON.stringify(m, null, 2));
  log(
    `metrics: ${m.overall.sessions} セッション(空のセッション ${m.emptySessions} 件を除外)、${Object.keys(m.byProject).length} プロジェクト、${Object.keys(m.byModel).length} モデル、トークン記録なし(欠測)${m.overall.sessionsMissingTokens} セッション → ${p.metrics}`,
  );
  if (m.installedSkills) log(`metrics: インストール済みで未使用の skill ${m.installedSkills.unused.length} / ${m.installedSkills.installed.length} 件`);
  if (o.tables ?? true) await writeTables(p, sessions, 'metrics', log);
  return m;
}

/**
 * 表計算ソフトで開く表(依頼ごと・セッションごと)を out/tables/ に書く。metrics・build・export が、それぞれの絞り込みのセッションで書く
 * (判定を取り込んだ後の export でも、判定の列が表に入るように)
 */
async function writeTables(p: Paths, sessions: SessionRecord[], cmd: string, log: Log): Promise<void> {
  const tables = join(p.out, 'tables');
  await mkdir(tables, { recursive: true });
  const t = await buildTables(sessions, p);
  for (const w of t.warnings) log(`${cmd}: 注意 ${w}`);
  await writeFile(join(tables, 'turns.csv'), t.turns);
  await writeFile(join(tables, 'sessions.csv'), t.sessions);
  log(`${cmd}: 表 → ${join(tables, 'turns.csv')}・sessions.csv${t.withVerdicts ? '(依頼ごとの判定の列つき)' : ''}`);
}

export interface BuildOptions extends SessionFilter {
  anonymize: boolean;
  /** export: セッション記録(Markdown)も書く */
  transcripts?: { toolOutput: ToolOutputMode; maxChars: number | null; full?: boolean } | null;
}

export async function runBuild(p: Paths, o: BuildOptions, log: Log): Promise<BuildResult> {
  const { file: s, sessions, groups } = await selectSessions(p, o, o.transcripts ? 'export' : 'build', '先に atlas extract を実行してください。', log);
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
  let verdicts: VerdictIndex | null = null;
  if (existsSync(p.turnJudgments)) {
    try {
      verdicts = parseVerdicts(await readJson(p.turnJudgments, ''));
    } catch (e) {
      log(`build: 注意 ${p.turnJudgments} を読めないため、依頼ごとの判定は合成しません(${(e as Error).message})`);
    }
    if (verdicts) log(`build: 依頼ごとの判定 ${[...verdicts.bySession.values()].reduce((a, m) => a + m.size, 0)} 件を合成(${p.turnJudgments})`);
  }

  // 伏せ字版では表を書かない(依頼文とパスがそのまま入るため)。前に書いた表も、共有用の out/ に残さないよう消す(out/full/ と同じ扱い)
  if (!o.anonymize) await writeTables(p, sessions, o.transcripts ? 'export' : 'build', log);
  else if (existsSync(join(p.out, 'tables'))) {
    await rm(join(p.out, 'tables'), { recursive: true, force: true });
    log('build: 伏せ字版なので、依頼文の入った表(out/tables/)を消しました');
  }

  await ensureTemplate(log);
  const unknown = Object.values(s.warnings.unknownEventTypes).reduce((a, n) => a + n, 0);
  const r = await buildReport({
    sessions,
    metrics,
    installed: s.installed ?? null,
    totalSessionsInSource: s.sessions.length,
    warnings: { unknownEventTypes: unknown, badLines: s.warnings.badLines, notes: groups.warnings },
    judgments,
    verdicts,
    groups: groups.groups,
    memosDir: memosDir(p.notes),
    outDir: p.out,
    anonymize: o.anonymize,
    scope: { since: o.since, project: o.project, client: o.client, model: o.model, branch: o.branch },
    transcripts: o.transcripts
      ? { ...DEFAULT_TRANSCRIPT_OPTIONS, toolOutput: o.transcripts.toolOutput, maxTextChars: o.transcripts.maxChars ?? DEFAULT_TRANSCRIPT_OPTIONS.maxTextChars, snapshotDir: p.snapshot }
      : undefined,
    full: !!o.transcripts?.full,
    desktopMeta: s.desktop ?? null,
  });
  if (r.stale.full) log(`build: 前回の --full の出力(out/full/ と coverage.json、生成 ${r.stale.full})が残っています。消すには --anonymize で作るか、フォルダを手で消してください`);
  if (r.stale.library) log(`build: 前回の export の閲覧ページ(instructions.html と library/、生成 ${r.stale.library})が残っています(前の版の atlas で作ったものなら、開くと「画面とサーバの版が違います」と出ます。atlas export か atlas all で作り直せます)`);
  if (r.library) log(`export: 指示文と skill の閲覧ページ ${r.library.path}(${r.library.groups} 項目・${r.library.versions} 版、本文 ${r.library.files} ファイル ${mb(r.library.bytes)})`);
  if (r.full) {
    const f = r.full;
    log(`export: 全文記録 ${f.files} 件(計 ${mb(f.bytes)}、イベント ${f.events} 件、画像など ${f.assets.files} ファイル ${mb(f.assets.bytes)}、除外 ${f.excluded.n} 箇所 ${mb(f.excluded.bytes)})→ ${join(p.out, 'full', '<id>.md')}`);
    log(`export: 網羅の検査 → ${f.coveragePath}。未分類のキー ${f.unclassified.length} 件${f.unclassified.length ? `: ${f.unclassified.slice(0, 10).join(', ')}${f.unclassified.length > 10 ? ' …' : ''}` : ''}`);
    if (f.secretHits) log(`export: 注意 全文記録で API キーやトークンらしい文字列を ${f.secretHits} 件伏せました`);
    log('export: 注意 全文記録(out/full/)は原本の文字列をそのまま含みます。共有しないでください');
  }
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

export async function runBundle(p: Paths, f: SessionFilter, o: { includeEmpty: boolean; perPart?: number | null; unjudged?: boolean }, log: Log): Promise<BundleManifest> {
  let { sessions } = await selectSessions(p, f, 'bundle', '先に atlas extract(または atlas all)を実行してください。', log);
  if (o.unjudged) {
    const judged = new Set((await readJudgments(p.judgments))?.items.map((i) => i.sessionId) ?? []);
    const before = sessions.length;
    sessions = sessions.filter((s) => !judged.has(s.id));
    log(`bundle: 判定済みの ${before - sessions.length} 件を除きました(--unjudged)`);
  }
  const t = performance.now();
  const m = await buildBundle(sessions, {
    bundleDir: p.bundle,
    snapshotDir: p.snapshot,
    includeEmpty: o.includeEmpty,
    perPart: o.perPart ?? undefined,
    scope: { since: f.since, project: f.project, client: f.client, model: f.model, branch: f.branch, group: f.group ?? null, session: f.sessions?.length ? f.sessions.join(',') : null, unjudged: o.unjudged ? 'yes' : null },
    log,
  });
  const excerpt = m.sessions.filter((e) => e.textSource === 'excerpt').length;
  const truncated = m.sessions.filter((e) => e.truncated > 0).length;
  log(
    `bundle: パケット ${m.count} 件(依頼の記録が無く対象外 ${m.skipped.length} 件)、合計 ${mb(m.totalBytes)}、最大 ${kb(m.maxBytes)}、本文を中略したもの ${truncated} 件${excerpt ? `、抜粋のみ ${excerpt} 件` : ''} → ${p.bundle}、${ms(performance.now() - t)}`,
  );
  log('bundle: 外部の LLM に渡すときは bundle フォルダごと ZIP にして、INSTRUCTIONS.md を最初に読ませてください');
  if (m.parts?.length) {
    const maxPart = m.parts.reduce((a, x) => Math.max(a, x.bytes), 0);
    log(`bundle: ZIP を渡せないときは parts/ の ${m.parts.length} ファイル(${m.perPart} 件ずつ、最大 ${kb(maxPart)})を 1 つずつ添付してください(指示と JSON Schema も中に入っています)`);
  }
  return m;
}

/** 依頼ごとの判定(段階 2): bundle / run(GitHub Copilot CLI)/ import */
export async function runTurns(p: Paths, f: SessionFilter, t: TurnsCliOptions, log: Log): Promise<void> {
  const phases = await phaseNames();
  if (t.action === 'bundle') {
    const { sessions } = await selectSessions(p, f, 'turns', '先に atlas extract(または atlas all)を実行してください。', log);
    const existing = t.unjudged ? await readTurnJudgments(p.turnJudgments) : null;
    const judged = existing ? new Map<string, Set<number>>() : null;
    for (const i of existing?.items ?? []) {
      let s = judged!.get(i.sessionId);
      if (!s) judged!.set(i.sessionId, (s = new Set()));
      s.add(i.turn);
    }
    const m = await buildTurnBundle(sessions, { bundleDir: p.turnBundle, snapshotDir: p.snapshot, phases, judged });
    log(
      `turns bundle: 依頼 ${m.count} 件${t.unjudged ? '(判定済みを除く)' : ''}を、M365 Copilot などに添付する ${m.parts.length} ファイル(parts/)と、GitHub Copilot CLI で 1 回ずつ渡す ${m.chunks.length} 個の塊にしました → ${p.turnBundle}${m.skipped.length ? `。本文が読めず外したセッション ${m.skipped.length} 件` : ''}`,
    );
    log(`turns bundle: 工程名 ${phases.join(' / ')}(atlas.config.json の phases で変えられます)`);
    return;
  }
  if (t.action === 'run') {
    const backend = copilotCliBackend({ model: t.model, timeoutMs: t.timeoutSec * 1000 });
    const r = await runTurnJudge({ bundleDir: p.turnBundle, path: p.turnJudgments, backend, limit: t.limit, log });
    if (r.failed.length) throw new Error(`判定できなかった塊が ${r.failed.length} 個あります(${p.turnJudgments} の failures。もう一度実行すると再試行します)`);
    return;
  }
  const known = existsSync(p.sessions) ? (await readJson<SessionsFile>(p.sessions, '')).sessions : [];
  const turnsBySession = new Map(known.map((s) => [s.id, s.analysis?.turnStats?.length ?? 0]));
  const r = await importTurnJudgmentsText(await readFile(resolve(t.file!), 'utf8'), p.turnJudgments, { phases: await turnImportPhases(p.turnBundle, phases), turnsBySession });
  log(`turns import: ${r.imported} 件を取り込みました(既存の上書き ${r.overwritten} 件)→ ${p.turnJudgments}(計 ${r.total} 件)`);
  if (r.unknown.length) log(`turns import: 注意 集計に無い依頼が ${r.unknown.length} 件あります(レポートには出ません): ${r.unknown.slice(0, 5).join(', ')}${r.unknown.length > 5 ? ' …' : ''}`);
}

export function makeBackend(j: JudgeCliOptions): JudgeBackend {
  const timeoutMs = j.timeoutSec * 1000;
  switch (j.backend) {
    case 'copilot-cli':
      return copilotCliBackend({ model: j.model, allowTools: j.allowTools, timeoutMs });
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

/**
 * atlas group list / add / remove。add の id は sessions.json があれば先頭一致で解決する(無ければそのまま書く)。
 * 壊れた groups.json は上書きしない(loadGroupsForWrite がエラーにする)。
 */
export async function runGroup(p: Paths, g: GroupCliOptions, log: Log, config: string | null = null): Promise<void> {
  if (g.action === 'list') {
    const loaded = await loadGroups(p.groups);
    for (const w of loaded.warnings) log(`group: 注意 ${w}`);
    if (!loaded.exists) {
      log(`group: ${p.groups} はまだありません(atlas group add <名前> <id...> で作れます)`);
      return;
    }
    const known = existsSync(p.sessions) ? new Set((await readJson<SessionsFile>(p.sessions, '')).sessions.map((s) => s.id)) : null;
    log(`group: ${loaded.groups.length} グループ(${p.groups})`);
    for (const x of loaded.groups) {
      const k = known ? x.ids.filter((id) => known.has(id)).length : null;
      log(`  ${x.name}: ${x.ids.length} 件${k != null && k !== x.ids.length ? `(うち記録にあるのは ${k} 件)` : ''}${x.note ? ` — ${x.note}` : ''}`);
    }
    return;
  }
  if (g.action === 'upload') {
    // 前回の集計の複製(out/snapshot/)を読むので、集計の途中と重ならないよう印を取る
    let root = g.to;
    if (root == null) {
      const configPath = config ?? process.env.ATLAS_CONFIG ?? null;
      const cfg = await loadConfig(configPath ? resolve(configPath) : join(REPO_ROOT, CONFIG_FILE), configPath != null);
      root = cfg.uploadRoot;
      if (!root) throw new Error('アップロード先が決まっていません。--to <フォルダ> で指定するか、setup.bat か画面のグループの見出しで既定の場所を決めてください');
    } else root = parseUploadRoot(root);
    const release = acquireOutLock(p.out, 'group upload', 'cli');
    try {
      // 写す前に大きさと秘密らしい文字列を調べる(画面の確認と同じ。秘密らしい文字列があれば --force が無い限り写さない)
      const c = await checkUpload(p, g.name!, root);
      log(`group upload: ${c.sessions} セッション・${mb(c.bytes)}${c.largest.length ? `(大きいもの: ${c.largest.slice(0, 3).map((x) => `${x.id.slice(0, 8)}/${x.path} ${mb(x.bytes)}`).join('、')})` : ''}`);
      if (c.secrets.count) {
        log(`group upload: 秘密らしい文字列が ${c.secrets.count} 件あります(${c.secrets.kinds.map((k) => `${k.label} ${k.count}`).join('・')}。偽陽性もありえます)`);
        for (const f of c.secrets.files) log(`  ${f.id}/${f.path}: ${f.count} 件`);
        if (!g.force) throw new Error('写していません。写した先で見られる人を確かめ、それでも写すなら --force を付けてください(本物の鍵なら作り直してください)');
      }
      const r = await uploadGroup(p, g.name!, root, log);
      if (r.missing.length) log(`group upload: 前回の集計に無いセッション: ${r.missing.join(', ')}`);
      if (r.snapshotAt) log(`group upload: 写したのは ${r.snapshotAt} の集計の時点のログです(新しくするには先に atlas all)`);
    } finally {
      release();
    }
    return;
  }
  if (g.action === 'export') {
    // 書き出しは out/ を読む(と out/groups/ に書く)ので、集計の途中と重ならないよう印を取る
    const release = acquireOutLock(p.out, 'group export', 'cli');
    try {
      await exportGroup(p, g.name!, log);
    } finally {
      release();
    }
    return;
  }
  const groups = await loadGroupsForWrite(p.groups);
  const name = g.name!;
  if (g.action === 'remove') {
    const i = groups.findIndex((x) => x.name === name);
    if (i < 0) throw new Error(`グループ「${name}」は ${p.groups} にありません${groups.length ? `(あるのは: ${groups.map((x) => x.name).join(', ')})` : ''}`);
    groups.splice(i, 1);
    await saveGroups(p.groups, groups);
    log(`group: 「${name}」を削除しました → ${p.groups}(残り ${groups.length} グループ)`);
    return;
  }
  let ids = uniqueIds(g.ids);
  if (existsSync(p.sessions)) {
    const known = (await readJson<SessionsFile>(p.sessions, '')).sessions.map((s) => s.id);
    ids = resolveIdPrefixes(known, ids);
  } else log(`group: 注意 ${p.sessions} が無いため id を先頭一致で解決せず、そのまま書きます`);
  const cur = groups.find((x) => x.name === name);
  if (cur) {
    const before = cur.ids.length;
    cur.ids = uniqueIds([...cur.ids, ...ids]);
    if (g.note != null) cur.note = g.note;
    await saveGroups(p.groups, groups);
    log(`group: 「${name}」に ${cur.ids.length - before} 件を追記しました(重複 ${ids.length - (cur.ids.length - before)} 件を除く、計 ${cur.ids.length} 件)→ ${p.groups}`);
  } else {
    groups.push({ name, note: g.note ?? '', ids });
    await saveGroups(p.groups, groups);
    log(`group: 「${name}」を作りました(${ids.length} 件)→ ${p.groups}`);
  }
}

/** atlas memo list / show / set / remove。id は sessions.json があれば先頭一致で解決する(無ければそのまま使う) */
export async function runMemo(p: Paths, m: MemoCliOptions, log: Log): Promise<void> {
  const dir = memosDir(p.notes);
  const known = existsSync(p.sessions) ? (await readJson<SessionsFile>(p.sessions, '')).sessions.map((s) => s.id) : null;
  if (m.action === 'list') {
    const index = await loadMemoIndex(dir);
    log(`memo: ${index.size} 件(${dir})`);
    for (const [id, x] of index) {
      const s = memoSummary(x.text, x.updatedAt);
      log(`  ${id}: ${s.excerpt || '(本文なし)'}${s.images ? `(画像 ${s.images} 枚)` : ''}${known && !known.includes(id) ? '(記録に無いセッション)' : ''}`);
    }
    return;
  }
  const id = known ? resolveIdPrefixes([...new Set([...known, ...(await loadMemoIndex(dir)).keys()])], [m.id!])[0] : m.id!;
  if (m.action === 'show') {
    const x = await readMemo(dir, id);
    if (!x) throw new Error(`セッション ${id} のメモはありません`);
    log(x.text);
    return;
  }
  if (m.action === 'remove') {
    if (!(await readMemo(dir, id))) throw new Error(`セッション ${id} のメモはありません`);
    await saveMemo(dir, id, '', null);
    log(`memo: ${id} のメモを削除しました(画像は ${join(dir, id)} に残ります)`);
    return;
  }
  const text = m.file != null ? await readFile(m.file, 'utf8') : (m.text ?? '');
  if (!text.trim()) throw new Error('本文が空です(削除は atlas memo remove で行います)');
  const r = await saveMemo(dir, id, text, null);
  log(`memo: ${id} のメモを保存しました(${r.memo!.text.length} 文字)→ ${join(dir, `${id}.md`)}`);
}

/**
 * atlas serve: 既に動いているサーバがあればブラウザを開くだけ。無ければ起動し、画面の heartbeat が途切れる(ブラウザを閉じる)まで待つ。
 */
export async function runServe(p: Paths, o: { port: number | null; open: boolean; config?: string | null }, log: Log): Promise<string> {
  if (!existsSync(p.html)) throw new Error(`${p.html} がありません。先に atlas build(または atlas all)を実行してください。`);
  const running = await findRunningServer(p.out);
  if (running) {
    const url = `http://127.0.0.1:${running.port}/atlas.html`;
    log(`serve: 既に動いているサーバがあります(${url})。ブラウザで開くだけにします`);
    if (running.code !== codeStamp())
      log('serve: 動いているサーバは、今の atlas と版が違います(atlas のコードが変わる前に起動したもの)。前に開いた atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行してください');
    if (o.open) openInBrowser(url, log);
    return '既存のサーバを使用';
  }
  const h = await startServe({ outDir: p.out, notesDir: p.notes, groupsPath: p.groups, port: o.port ?? 0, open: o.open, log, ...(o.config ? { configPath: resolve(o.config) } : {}) });
  const onSignal = (): void => void h.close('中断');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const reason = await h.done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  log(`serve: 終了(${reason})`);
  return reason;
}

/** skill-draft: out/insights.json の候補(番号)から SKILL.md の下書きを copilot -p で作る(クレジットを消費。明示したときだけ) */
export async function runSkillDraft(p: Paths, o: NonNullable<CliOptions['skillDraft']>, log: Log): Promise<string> {
  const path = join(p.out, 'insights.json');
  const j = await readJson<{ anonymized: boolean; candidates: DraftCandidate[] }>(path, '先に atlas build(または export)を実行してください。');
  if (j.anonymized) throw new Error('伏せ字版の out/ には候補の本文が無いので下書きを作れません(通常の build で作り直してください)');
  const c = j.candidates[o.index - 1];
  if (!c) throw new Error(`候補 ${o.index} はありません(候補は ${j.candidates.length} 件)`);
  log(`skill-draft: 候補 ${o.index}(${c.kind === 'tools' ? c.key : (c.representative ?? c.key).slice(0, 60)})を ${o.backend} で下書きします${o.backend === 'anthropic' ? '(Anthropic API の従量課金です)' : '(クレジットを消費する場合があります)'}`);
  const r = await draftSkill(c, o.index, { backend: o.backend, model: o.model, timeoutMs: o.timeoutSec * 1000 });
  const dir = join(p.out, 'skill-drafts');
  await mkdir(dir, { recursive: true });
  const slug = (c.tools ? c.tools.join('-') : (c.representative ?? c.key)).replace(/[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'draft';
  const file = join(dir, `${String(o.index).padStart(3, '0')}-${slug}.md`);
  const head = `<!-- atlas skill-draft: 候補 ${o.index}(${c.kind}、${c.count} 回、${c.sessions.length} セッション)。LLM の下書きなので内容を確かめてから skills/ に置くこと -->\n`;
  await writeFile(file, head + r.markdown + (r.markdown.endsWith('\n') ? '' : '\n'));
  log(`skill-draft: ${file}(${Buffer.byteLength(r.markdown)} バイト)${r.notes.length ? `、補足 ${r.notes.join(' / ')}` : ''}`);
  return file;
}

/** out/ に書くコマンド。実行中は out/.job.json に印を置き、他のプロセス(画面のジョブ・別の atlas)と並行して書かない */
const WRITES_OUT: ReadonlySet<CliOptions['command']> = new Set(['snapshot', 'extract', 'metrics', 'build', 'export', 'bundle', 'judge', 'turns', 'skill-draft', 'all']);

type RunResult = { paths: Paths; build?: BuildResult; judge?: RunSummary | null };

export async function run(o: CliOptions, log: Log): Promise<RunResult> {
  const p = resolvePaths(o);
  const release = WRITES_OUT.has(o.command) ? acquireOutLock(p.out, o.command, 'cli') : () => {};
  try {
    return await runCommand(o, p, log);
  } finally {
    release();
  }
}

async function runCommand(o: CliOptions, p: Paths, log: Log): Promise<RunResult> {
  const f: SessionFilter = { since: o.since, project: o.project, client: o.client, model: o.model, branch: o.branch, group: o.group, sessions: o.sessions };
  const t = performance.now();
  switch (o.command) {
    case 'snapshot':
      await runSnapshot(p, o.since, log, o.snapshotAll, o.snapshotPrune);
      return { paths: p };
    case 'extract':
      await runExtract(p, o.since, log, o.tempDirs, o.config);
      return { paths: p };
    case 'metrics':
      await runMetrics(p, f, log);
      return { paths: p };
    case 'build':
      return { paths: p, build: await runBuild(p, { ...f, anonymize: o.anonymize }, log) };
    case 'export':
      return { paths: p, build: await runBuild(p, { ...f, anonymize: o.anonymize, transcripts: { toolOutput: o.toolOutput, maxChars: o.maxChars, full: o.full } }, log) };
    case 'bundle':
      await runBundle(p, f, { includeEmpty: o.includeEmpty, perPart: o.perPart, unjudged: o.unjudged }, log);
      return { paths: p };
    case 'turns':
      await runTurns(p, { ...f, model: null }, o.turns!, log);
      return { paths: p };
    case 'judge':
      return { paths: p, judge: await runJudgeCommand(p, o.judge!, log) };
    case 'group':
      await runGroup(p, o.groupCmd!, log, o.config);
      return { paths: p };
    case 'memo':
      await runMemo(p, o.memoCmd!, log);
      return { paths: p };
    case 'serve':
      await runServe(p, { port: o.port, open: o.open, config: o.config }, log);
      return { paths: p };
    case 'skill-draft':
      await runSkillDraft(p, o.skillDraft!, log);
      return { paths: p };
    case 'all': {
      await runSnapshot(p, o.since, log, o.snapshotAll, o.snapshotPrune);
      await runExtract(p, o.since, log, o.tempDirs, o.config);
      await runMetrics(p, f, log, { tables: !o.anonymize });
      // セッション記録(.md)も作る(build と export で作るものが違うと、どちらで作ったかで経過が見えたり消えたりするため)。
      // 伏せ字版は作らない: 記録の伏せ字は自由記述を機械的に置き換えるだけで、共有する sessions/ に HTML より弱い保証のものが混ざる
      const build = await runBuild(p, { ...f, anonymize: o.anonymize, transcripts: o.anonymize ? null : { toolOutput: o.toolOutput, maxChars: o.maxChars } }, log);
      if (o.anonymize) log('all: 伏せ字版なのでセッション記録(.md)は作りません(必要なら atlas export --anonymize)');
      log(`all: 完了 ${ms(performance.now() - t)}`);
      return { paths: p, build };
    }
  }
}
