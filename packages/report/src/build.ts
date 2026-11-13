// Node 側: テンプレート(dist/template.html)にデータを埋め込んで out/atlas.html と out/sessions/<id>.html を書く。
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CopilotEvent, InstalledInventory, InstructionFile, InstructionInjection, MetricsBucket, MetricsFile, SessionRecord } from '../../core/src/types.ts';
import { codeStamp, contentHash, parseEvents, removeTree } from '../../core/src/index.ts';
import { CoverageCounter, coverageFile, desktopCoverage } from './coverage.ts';
import { createFileSink, fullFileName, renderFullTo } from './full.ts';
import { INSTRUCTIONS_FILE, LIBRARY_DIR, LibraryCollector, renderInstructionsHtml, writeLibrary } from './library.ts';
import { instructionFindings, instructionVersions, seriesKey, skillCandidates, skillStats, stuckByProject, stuckSessions, type VersionMeta } from './lib/insights.ts';
import { INSIGHTS_FILE, INSIGHTS_JSON, renderInsightsHtml } from './insights-page.ts';
import { createAnonymizer, identityAnonymizer, type Anonymizer } from './lib/anonymize.ts';
import { renderDetailHtml } from './detail.ts';
import { GLOSSARY_FILE, renderGlossaryHtml } from './glossary-page.ts';
import { embedData } from './lib/embed.ts';
import { packSummary } from './lib/pack.ts';
import type { JudgmentsIndex } from './lib/judgments.ts';
import { verdictTuples, type VerdictIndex } from './lib/verdicts.ts';
import { retentionItem, UNKNOWN_PHASE, type TurnStart } from './lib/retention.ts';
import { PHASES, sessionTurns } from '../../core/src/turns.ts';
import type { VcsRetentionFile } from '../../core/src/vcs-step.ts';
import type { SessionGroup } from './lib/groups.ts';
import { memoSummary } from './lib/memo.ts';
import { loadMemberMemos, loadMemoIndex, renderMemberMemo, renderMemo, type MemoFile } from './memo-io.ts';
import { detailFileName, summarize } from './lib/summarize.ts';
import { renderTranscript, transcriptFileName, type TranscriptOptions } from './transcript.ts';
import { loadStore, type StoreData } from '../../core/src/index.ts';
import { REPORT_DATA_VERSION, type ReportData } from './lib/types.ts';

export const REPORT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_PATH = join(REPORT_ROOT, 'dist', 'template.html');
/** template.html の版の目印のプレースホルダ(集計が codeStamp() に置き換える) */
export const CODE_PLACEHOLDER = '__ATLAS_CODE__';
/**
 * テンプレートの版の目印の位置(CODE_PLACEHOLDER)を目印に置き換える。
 * 位置が無ければ止める(黙って進むと、ページは版を比べられず、サーバとずれていても知らせが出ない。目印の meta を足す前に作った dist が残っているときなど)
 */
export function embedCodeStamp(template: string, stamp: string): string {
  const i = template.indexOf(CODE_PLACEHOLDER);
  if (i < 0) throw new Error(`テンプレートに版の目印の位置 ${CODE_PLACEHOLDER} がありません(report のビルドが古いか壊れています。packages/report/dist を消してから、もう一度実行してください)`);
  return template.slice(0, i) + stamp + template.slice(i + CODE_PLACEHOLDER.length);
}
const BASE_CSS_PATH = join(REPORT_ROOT, 'src', 'styles', 'base.css');

/** 静的ページ(詳細 797 件・用語)に埋め込む CSS からコメントと余分な空白を落とす(1 件あたり約 4KB の節約。atlas.html は Vite が同じことをする) */
export function compactCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

/** 静的ページ(詳細・用語・Phase 14 の記録の表示)に埋め込む CSS(base.css を詰めたもの) */
export async function readPageCss(): Promise<string> {
  return compactCss(await readFile(BASE_CSS_PATH, 'utf8'));
}

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
  /** 人のフォルダの名前ごとのインストール済みの skill(sessions.json の installedByPerson。無ければ null) */
  installedByPerson?: Record<string, InstalledInventory> | null;
  /** sessions.json の総件数(フィルタ前) */
  totalSessionsInSource: number;
  /** アップロードしたフォルダを集計したときの、そのフォルダ(画面の見出しに出す。伏せ字版には入れない) */
  source?: ReportData['source'];
  warnings: { unknownEventTypes: number; badLines: number; notes?: string[] };
  judgments: JudgmentsIndex | null;
  /** 段階 2: 依頼ごとの LLM 判定(turn-judgments.json)。無ければ null / 省略 */
  verdicts?: VerdictIndex | null;
  /** AI の変更がその後の VCS のファイルに残っているか(vcs-retention.json)。無ければ null / 省略 */
  retention?: VcsRetentionFile | null;
  /** 名前付きグループ(atlas-notes/groups.json)。無ければ省略 */
  groups?: SessionGroup[];
  /** Phase 13: メモの置き場(<notes-dir>/memos)。無ければメモなし */
  memosDir?: string;
  /** 送り先から集計したとき: 送った人のメモを読む、写したセッションのフォルダ(<snapshot>/session-state)。あれば memosDir より優先する */
  memberMemosDir?: string;
  /** 読むだけの画面として作る(画面の文言を変える。タスクタグとメモは groups・memberMemosDir で渡す) */
  readOnly?: boolean;
  outDir: string;
  anonymize: boolean;
  scope?: Partial<ReportData['scope']>;
  /** テンプレートのパス(省略時は ensureTemplate の結果) */
  templatePath?: string;
  /** セッション記録(Markdown)も書く(atlas export)。snapshotDir の events.jsonl と session-store.db から本文と明細を読む */
  transcripts?: Omit<TranscriptOptions, 'anon' | 'generatedAt'> & { snapshotDir: string; store?: StoreData };
  /** Phase 11: 全文記録(out/full/)と coverage.json も書く(atlas export --full。伏せ字とは併用しない) */
  full?: boolean;
  /** Phase 11: 指示文・skill の閲覧ページ(out/library/ と instructions.html)。transcripts のときの既定は true(伏せ字版では作らない) */
  library?: boolean;
  /** sessions.json の desktop(data.db の読み取りの状態。WAL の注意を全文記録に書く) */
  desktopMeta?: { wal: { note: string } | null } | null;
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
  /** Phase 11: 全文記録の集計 */
  full: { files: number; bytes: number; assets: { files: number; bytes: number }; secretHits: number; excluded: { n: number; bytes: number }; unclassified: string[]; coveragePath: string; events: number } | null;
  /** Phase 11: 閲覧ページの集計 */
  library: { groups: number; versions: number; files: number; bytes: number; secretHits: number; path: string } | null;
  /** Phase 11: 今回は作らなかったが前回の出力が残っているもの(生成日時)。伏せ字モードでは消す */
  stale: { full: string | null; library: string | null };
  ms: number;
}

/** 画面に出すインストール済みの skill(~/.copilot/skills/ とプラグインの skill の名前を合わせたもの)と、無効にしたもの */
function installedView(inv: InstalledInventory): { skills: string[]; disabled: string[] } {
  return { skills: [...new Set([...inv.skills, ...inv.plugins.flatMap((p) => p.skills)])].sort(), disabled: [...(inv.disabledSkills ?? [])].sort() };
}

function remapBuckets(b: Record<string, MetricsBucket>, map: (k: string) => string): Record<string, MetricsBucket> {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [map(k), v]));
}

export function anonymizeMetrics(m: MetricsFile, anon: Anonymizer): MetricsFile {
  if (!anon.enabled) return m;
  return { ...m, byProject: remapBuckets(m.byProject, (k) => anon.project(k)) };
}

/**
 * 工程ごとの集計に使う、依頼の開始時刻と工程。依頼の記録が先頭 200 依頼で打ち切られたセッションは、最後の依頼の終わり
 * (時間の記録が無ければ始まり)に「不明」を足し、それより後のまとまりを最後の依頼の工程に入れないようにする
 */
function turnStarts(r: SessionRecord): TurnStart[] {
  const rows = sessionTurns(r);
  const out: TurnStart[] = rows.map((t) => ({ startedAt: t.startedAt, phase: PHASES.indexOf(t.phase) }));
  const last = rows[rows.length - 1];
  if (last && r.turns > rows.length) {
    const end = last.startedAt && last.ms != null ? new Date(Date.parse(last.startedAt) + last.ms).toISOString() : last.startedAt;
    out.push({ startedAt: end, phase: UNKNOWN_PHASE });
  }
  return out;
}

export async function buildReport(input: BuildInput): Promise<BuildResult> {
  const t0 = performance.now();
  const templatePath = input.templatePath ?? (await ensureTemplate());
  const [template, rawCss] = await Promise.all([readFile(templatePath, 'utf8'), readFile(BASE_CSS_PATH, 'utf8')]);
  const css = compactCss(rawCss);
  const anon = input.anonymize ? createAnonymizer(input.sessions) : identityAnonymizer();
  const generatedAt = new Date().toISOString();
  const j = input.judgments;

  // 伏せ字版にはメモを一切出さない(自由記述のため。抜粋も件数も持たない)
  const memberDir = input.memberMemosDir ?? null;
  const memos = anon.enabled
    ? new Map<string, MemoFile>()
    : memberDir
      ? await loadMemberMemos(memberDir, input.sessions.map((s) => s.id))
      : input.memosDir
        ? await loadMemoIndex(input.memosDir)
        : new Map<string, MemoFile>();
  const memoHtml = (id: string, text: string): string => (memberDir ? renderMemberMemo(memberDir, id, text) : renderMemo(input.memosDir!, id, text));
  const vx = input.verdicts ?? null;
  const rx = input.retention ?? null;
  const retentionById = new Map((rx?.sessions ?? []).map((r) => [r.sessionId, r]));
  const sessions = input.sessions.map((r) => {
    const base = summarize(r, anon, j?.bySession.get(r.id) ?? null);
    const vt = vx ? verdictTuples(vx.bySession.get(r.id), vx.phases) : [];
    const rt = retentionById.get(r.id);
    const s = { ...base, ...(vt.length ? { turnVerdicts: vt } : {}), ...(rt ? { retention: retentionItem(rt, turnStarts(r)) } : {}) };
    const m = memos.get(r.id);
    return m ? { ...s, memo: memoSummary(m.text, m.updatedAt) } : s;
  });
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
    ...(input.source && !anon.enabled ? { source: input.source } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    metrics: anonymizeMetrics(input.metrics, anon),
    sessions,
    judgments: {
      available: !!j,
      backend: j?.backend ?? null,
      model: j?.model ?? null,
      ranAt: j?.ranAt ?? null,
      items: j ? input.sessions.filter((s) => j.bySession.has(s.id)).length : 0,
    },
    turnJudgments: {
      available: !!vx,
      model: vx?.model ?? null,
      ranAt: vx?.ranAt ?? null,
      items: vx ? input.sessions.reduce((a, s) => a + (vx.bySession.get(s.id)?.size ?? 0), 0) : 0,
      phases: vx?.phases ?? [],
    },
    retention: rx ? { generatedAt: rx.generatedAt, computedOn: rx.computedOn, mode: rx.mode, similarity: rx.similarity, pathMap: rx.pathMap, sessions: rx.sessions.length, senders: rx.senders ?? null, ...(rx.labels ? { labels: rx.labels } : {}), ...(rx.note ? { note: rx.note } : {}) } : null,
    installed: input.installed ? installedView(input.installed) : null,
    // 人に絞ったときに、その人のインストール済みの skill で「未使用」を出す。伏せ字版では人の名前を仮名にするので入れない(全員分を使う)
    ...(input.installedByPerson && !anon.enabled
      ? { installedByPerson: Object.fromEntries(Object.entries(input.installedByPerson).map(([person, inv]) => [person, installedView(inv)])) }
      : {}),
    // 伏せ字モードではグループ名と note(自由記述)は出さず、ファイルの順で「グループ 1, 2, …」にする。ids は不透明なのでそのまま
    groups: (input.groups ?? []).map((g, i) => (anon.enabled ? { name: `タスクタグ ${i + 1}`, note: '', ids: [...g.ids] } : { name: g.name, note: g.note, ids: [...g.ids] })),
    library: !!(input.transcripts && (input.library ?? true) && !anon.enabled),
    insights: { meta: {}, candidates: [], computedOver: input.sessions.length },
    // 警告文には groups.json の絶対パスが入るので、伏せ字モードでは <path> に置き換える(scrub)
    warnings: { unknownEventTypes: input.warnings.unknownEventTypes, badLines: input.warnings.badLines, notes: (input.warnings.notes ?? []).map((n) => anon.scrub(n)) },
  };

  // Phase 12: 改善点。候補は本文(依頼文・ツールの列)から build 時に求め、結果だけ埋め込む(上位 30 件、例は 3 件まで)
  const insightMeta: Record<string, VersionMeta> = {};
  {
    const byHeading = new Map<string, { hash: string; heading: string; file: string; firstAt: string | null; lastAt: string | null }[]>();
    for (const r of input.sessions)
      for (const i of r.instructions) {
        // 系列は指示文のページ(library.ts)と同じ鍵で束ね、同じ「版 N」になるようにする
        const key = seriesKey(i.heading, i.file);
        const list = byHeading.get(key) ?? byHeading.set(key, []).get(key)!;
        const cur = list.find((x) => x.hash === i.contentHash);
        if (cur) {
          cur.firstAt = cur.firstAt && i.firstSeenAt ? (cur.firstAt < i.firstSeenAt ? cur.firstAt : i.firstSeenAt) : (cur.firstAt ?? i.firstSeenAt);
          // firstSeenAt はセッションごとの初回の注入。その最大が「最後にこの版を読み込んだ」日時
          cur.lastAt = cur.lastAt && i.firstSeenAt ? (cur.lastAt > i.firstSeenAt ? cur.lastAt : i.firstSeenAt) : (cur.lastAt ?? i.firstSeenAt);
        } else list.push({ hash: i.contentHash, heading: i.heading, file: i.file, firstAt: i.firstSeenAt, lastAt: i.firstSeenAt });
      }
    let n = 0;
    for (const list of byHeading.values()) {
      const series = `s${n++}`;
      list.sort((a, b) => (a.firstAt ?? '').localeCompare(b.firstAt ?? '') || a.hash.localeCompare(b.hash));
      list.forEach((v, order) => (insightMeta[v.hash] = { heading: anon.enabled ? '' : v.heading, file: v.file, series, order, firstAt: v.firstAt, lastAt: v.lastAt }));
    }
  }
  const candidates = skillCandidates(
    input.sessions.map((r) => ({ id: r.id, project: r.project, analysis: r.analysis ?? { requests: [], turnTools: [], turnActiveMs: [] } })),
    anon.enabled,
  );
  data.insights = {
    meta: anon.enabled ? {} : insightMeta,
    candidates: candidates.slice(0, 30).map((c) => ({ ...c, representative: c.representative?.slice(0, 300) ?? null, examples: c.examples.slice(0, 3).map((e) => e.slice(0, 300)) })),
    candidateTotal: candidates.length,
    computedOver: input.sessions.length,
  };

  await mkdir(input.outDir, { recursive: true });
  // セッションの要約は既定値と同じ項目を落として埋め込む(読むときに埋め戻す。lib/pack.ts)
  // 版の目印はデータを埋める前に置き換える(記録の本文に同じ文字列があっても触れない)
  const html = embedData(embedCodeStamp(template, codeStamp()), { ...data, sessions: data.sessions.map(packSummary) });
  const htmlPath = join(input.outDir, 'atlas.html');
  await writeFile(htmlPath, html);
  // 用語の説明は 1 枚だけ別ページ(atlas.html と詳細ページからリンク)
  await writeFile(join(input.outDir, GLOSSARY_FILE), renderGlossaryHtml({ css, generatedAt }));
  // Phase 12: 改善点の全件(insights.html)と候補の JSON(skill-draft が読む)
  {
    const versions = instructionVersions(sessions);
    const names = new Map(sessions.map((s) => [s.id, anon.enabled ? `セッション ${s.id.slice(0, 8)}` : (s.name || s.firstUserMessage || s.id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 60)]));
    await writeFile(
      join(input.outDir, INSIGHTS_FILE),
      renderInsightsHtml({
        css,
        generatedAt,
        anonymized: anon.enabled,
        sessions: sessions.length,
        emptySessions: sessions.filter((s) => s.empty).length,
        versions,
        meta: anon.enabled ? {} : insightMeta,
        findings: instructionFindings(versions, anon.enabled ? {} : insightMeta, sessions.length),
        skills: skillStats(sessions, data.installed?.skills ?? null),
        disabledSkills: data.installed?.disabled ?? [],
        stuck: stuckSessions(sessions),
        stuckProjects: stuckByProject(stuckSessions(sessions), sessions),
        candidates,
        sessionName: (id) => names.get(id) ?? id,
        libraryHref: data.library ? INSTRUCTIONS_FILE : null,
      }),
    );
    await writeFile(join(input.outDir, INSIGHTS_JSON), JSON.stringify({ version: 1, generatedAt, anonymized: anon.enabled, sessions: sessions.length, candidates }, null, 1));
  }

  // 詳細ページ: 前回の生成物を消してから書く(フィルタで減ったセッションのページを残さない)
  const detailDir = join(input.outDir, 'sessions');
  await removeTree(detailDir);
  await mkdir(detailDir, { recursive: true });
  let detailBytes = 0;
  const tr = input.transcripts;
  const store = tr ? (tr.store ?? (await loadStore(join(tr.snapshotDir, 'session-store.db')))) : null;
  const trStat = tr ? { files: 0, bytes: 0, secretHits: 0, truncated: 0, fromRecordOnly: 0 } : null;
  // Phase 11: 全文記録と閲覧ページ(どちらも events.jsonl を読み直す)
  const wantFull = !!(tr && input.full);
  if (wantFull && anon.enabled) throw new Error('--full(全文記録)は --anonymize と併用できません(解析用の完全出力は共有しない前提のため)');
  const wantLibrary = data.library;
  const fullDir = join(input.outDir, 'full');
  const coveragePath = join(input.outDir, 'coverage.json');
  const instructionsPath = join(input.outDir, INSTRUCTIONS_FILE);
  // ユーザーの生成物を黙って消さない: 作り直すときと伏せ字モード(共有用の out/ に残さない)だけ消す。それ以外は残して日時を返す
  const stale: BuildResult['stale'] = { full: null, library: null };
  if (wantFull || anon.enabled) {
    await removeTree(fullDir);
    await rm(coveragePath, { force: true });
  } else if (existsSync(coveragePath)) stale.full = (await stat(coveragePath)).mtime.toISOString();
  else if (existsSync(fullDir)) stale.full = (await stat(fullDir)).mtime.toISOString(); // coverage.json が無くても full/ が残っていれば報告する
  if (wantLibrary || anon.enabled) {
    await removeTree(join(input.outDir, LIBRARY_DIR));
    await rm(instructionsPath, { force: true });
  } else if (existsSync(instructionsPath)) stale.library = (await stat(instructionsPath)).mtime.toISOString();
  if (wantFull) await mkdir(fullDir, { recursive: true });
  const coverage = new CoverageCounter();
  const fullStat = wantFull ? { files: 0, bytes: 0, assets: { files: 0, bytes: 0 }, secretHits: 0, excluded: { n: 0, bytes: 0 }, unclassified: new Set<string>(), events: 0 } : null;
  const lib = wantLibrary ? new LibraryCollector() : null;
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
    let fullHref: string | null = null;
    if (tr && store && (wantFull || lib)) {
      const sessionDir = join(tr.snapshotDir, 'session-state', r.id);
      const eventsPath = join(sessionDir, 'events.jsonl');
      // events.jsonl は 1 行ずつ読み、閲覧ページの収集と全文記録の書き出しを 1 回の走査で済ませる(セッション全体をメモリに載せない)
      const source: AsyncIterable<CopilotEvent> | CopilotEvent[] = existsSync(eventsPath) ? parseEvents(eventsPath) : [];
      async function* tee(): AsyncGenerator<CopilotEvent> {
        for await (const e of source) {
          if (lib) {
            const d = (e.data ?? {}) as Record<string, unknown>;
            if (e.type === 'system.message' && typeof d.content === 'string') lib.addSystemMessage(r.id, d.content, e.timestamp ?? null);
            if (e.type === 'skill.invoked' && typeof d.content === 'string' && typeof d.name === 'string') lib.addSkill(r.id, d.name, d.content, contentHash(d.content), e.timestamp ?? null, typeof d.path === 'string' ? d.path : null);
          }
          yield e;
        }
      }
      if (wantFull && fullStat) {
        const file = fullFileName(r.id);
        const path = join(fullDir, file);
        // <id>.md.tmp に書いて成功時に rename する(途中で失敗した壊れた記録を残さない)
        const sink = createFileSink(path);
        let res;
        try {
          res = await renderFullTo(r, tee(), store.usage.get(r.id) ?? [], {
            generatedAt,
            assetsDir: join(fullDir, 'assets', r.id.replace(/[^A-Za-z0-9._-]/g, '_')),
            assetsHref: `assets/${r.id.replace(/[^A-Za-z0-9._-]/g, '_')}`,
            sessionDir: existsSync(sessionDir) ? sessionDir : null,
            sessionDirHref: existsSync(sessionDir) ? `../snapshot/session-state/${encodeURIComponent(r.id)}` : null,
            coverage,
            walNote: input.desktopMeta?.wal?.note ?? null,
          }, sink);
          await sink.finish();
        } catch (e) {
          await sink.abort();
          throw new Error(`全文記録を書けませんでした (${r.id}): ${(e as Error).message}`);
        }
        fullHref = `../full/${file}`;
        fullStat.files++;
        fullStat.bytes += (await stat(path)).size;
        fullStat.assets.files += res.assets.files;
        fullStat.assets.bytes += res.assets.bytes;
        fullStat.secretHits += res.secretHits;
        fullStat.excluded.n += res.excluded.n;
        fullStat.excluded.bytes += res.excluded.bytes;
        fullStat.events += res.events;
        for (const k of res.unclassified) fullStat.unclassified.add(k);
      } else {
        for await (const _e of tee()) {
          /* 閲覧ページの収集だけ */
        }
      }
    }
    const m = memos.get(r.id);
    const memo = m ? { html: memoHtml(r.id, m.text), updatedAt: m.updatedAt } : null;
    const page = renderDetailHtml(r, { anon, css, judgment, verdicts: vx?.bySession.get(r.id) ?? null, retention: retentionById.get(r.id) ?? null, retentionMeta: data.retention ?? null, generatedAt, transcriptHref, libraryHref: data.library ? `../${INSTRUCTIONS_FILE}` : null, skillHasPage: (name) => !!lib?.hasSkill(name), libraryHasSession: !!lib?.hasSession(r.id), fullHref, memo });
    detailBytes += Buffer.byteLength(page);
    await writeFile(join(detailDir, detailFileName(r.id)), page);
  }

  let fullOut: BuildResult['full'] = null;
  if (wantFull && fullStat) {
    await writeFile(coveragePath, JSON.stringify(coverageFile(coverage, input.sessions.length, input.desktopMeta ? desktopCoverage((input.desktopMeta as { coverage?: Parameters<typeof desktopCoverage>[0] }).coverage) : null, generatedAt), null, 1));
    fullOut = { ...fullStat, unclassified: [...fullStat.unclassified].sort(), coveragePath };
  }
  let libOut: BuildResult['library'] = null;
  if (lib) {
    const groups = lib.result();
    const w = await writeLibrary(join(input.outDir, LIBRARY_DIR), groups);
    const names = new Map(sessions.map((s) => [s.id, s.name || s.firstUserMessage || s.id.slice(0, 8)]));
    const projects = new Map(sessions.map((s) => [s.id, s.projectLabel]));
    // 版ごとのファイルと範囲は、全セッションを見て特定した値(resolveInstructions の結果。詳細ページの表と同じ)を多い順に採る
    const votes = new Map<string, Map<string, { file: InstructionFile; scope: InstructionInjection['scope']; n: number }>>();
    for (const r of input.sessions)
      for (const i of r.instructions) {
        if (i.file === 'unknown') continue;
        const m = votes.get(i.contentHash) ?? votes.set(i.contentHash, new Map()).get(i.contentHash)!;
        const k = `${i.file}|${i.scope}`;
        const cur = m.get(k);
        if (cur) cur.n++;
        else m.set(k, { file: i.file, scope: i.scope, n: 1 });
      }
    const resolveInstruction = (hash: string): { file: InstructionFile; scope: InstructionInjection['scope'] } | null => {
      const best = [...(votes.get(hash)?.values() ?? [])].sort((a, b) => b.n - a.n)[0];
      return best ? { file: best.file, scope: best.scope } : null;
    };
    await writeFile(
      join(input.outDir, INSTRUCTIONS_FILE),
      renderInstructionsHtml({ css, generatedAt, groups, sessionName: (id) => (names.get(id) ?? id).replace(/\s+/g, ' ').slice(0, 60), sessionProject: (id) => projects.get(id) ?? null, resolveInstruction }),
    );
    libOut = { groups: groups.length, versions: groups.reduce((n, g) => n + g.versions.length, 0), files: w.files, bytes: w.bytes, secretHits: w.secretHits, path: join(input.outDir, INSTRUCTIONS_FILE) };
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
    full: fullOut,
    library: libOut,
    stale,
    ms: performance.now() - t0,
  };
}
