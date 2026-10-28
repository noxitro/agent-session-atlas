// Phase 2 E2E(docs/PLAN.md「Phase 2: cli + report」)
//  a. fixtures から `atlas all` で out/atlas.html を作り、5MB 未満で外部参照(http:// https:// fetch()が無い
//  b. 埋め込み JSON のセッション数が fixtures の件数(DB ∪ ディレクトリ)と一致し、詳細ページが揃う
//  c. --anonymize で fixture の cwd / git_root / repository / branch の文字列が HTML に出ない
//  d. ATLAS_LIVE=1 のとき実データで HTML を作り、サイズとプロジェクト数をログに出して 5MB 未満
// ブラウザでのフィルタ操作はオーケストレータが組み込みブラウザで確認する(ここでは静的検証のみ。
// フィルタのロジックは packages/report/test の単体テストで検証している)。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SessionsFile } from '../packages/core/src/index.ts';
import { buildReport, extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { computeMetrics, GROUPED_PROJECTS } from '../packages/core/src/index.ts';
import { buildFixtureHome, FIXTURES, readFixtureStore, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase2');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

/** 外部参照の静的検査 */
function externalRefs(html: string): string[] {
  const found: string[] = [];
  for (const needle of ['http://', 'https://', 'fetch(']) if (html.includes(needle)) found.push(needle);
  // 念のため構造的にも: 外部の src / href / @import / url() が無い
  if (/<link\b/i.test(html)) found.push('<link>');
  if (/\bsrc=["'](?!data:)[^"']+["']/i.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, ''))) found.push('src=');
  if (/@import|url\((?!["']?data:)/i.test(html)) found.push('@import/url()');
  return found;
}

async function readAllHtml(out: string): Promise<{ path: string; html: string }[]> {
  const files = [join(out, 'atlas.html'), ...(await readdir(join(out, 'sessions'))).map((f) => join(out, 'sessions', f))];
  return Promise.all(files.map(async (path) => ({ path, html: await readFile(path, 'utf8') })));
}

/** fixture の workspace.yaml と session-store から、伏せるべき固有の文字列を集める */
async function fixtureSecrets(): Promise<string[]> {
  const out = new Set<string>();
  const state = join(FIXTURES, 'copilot-home', 'session-state');
  for (const d of readdirSync(state)) {
    const p = join(state, d, 'workspace.yaml');
    if (!existsSync(p)) continue;
    const w = parseYaml(await readFile(p, 'utf8')) as Record<string, unknown>;
    for (const k of ['cwd', 'git_root', 'repository', 'branch']) if (typeof w[k] === 'string') out.add(w[k] as string);
  }
  const store = await readFixtureStore();
  for (const r of store.sessions) for (const k of ['cwd', 'repository', 'branch']) if (typeof r[k] === 'string') out.add(r[k] as string);
  return [...out];
}

/** HTML の中での現れ方(生の文字列、JSON 埋め込み、HTML エスケープ)をすべて調べる */
function appearances(html: string, s: string): boolean {
  const forms = new Set([s, JSON.stringify(s).slice(1, -1), JSON.stringify(s).slice(1, -1).replace(/\//g, '\\/'), s.replace(/'/g, '&#39;')]);
  return [...forms].some((f) => html.includes(f));
}

describe('Phase 2 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  let all: ReturnType<typeof atlas>;
  let data: ReportData;
  let html: string;
  const out = join(WORK, 'out');
  const outAnon = join(WORK, 'out-anon');

  beforeAll(async () => {
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    all = atlas(['all', '--home', home, '--out', out]);
    if (all.status !== 0) throw new Error(`atlas all が失敗: ${all.stderr}\n${all.stdout}`);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });
  afterAll(async () => close?.());

  it('a. atlas.html は 5MB 未満で、外部参照(http:// https:// fetch( / link / src / url())を含まない', async () => {
    console.log(`[fixtures] atlas all ${all.ms.toFixed(0)}ms, atlas.html ${html.length} bytes\n${all.stdout}`);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    expect(externalRefs(html)).toEqual([]);
    // 詳細ページも外部参照なし
    for (const f of await readAllHtml(out)) expect({ path: f.path, refs: externalRefs(f.html) }).toEqual({ path: f.path, refs: [] });
  });

  it('b. 埋め込み JSON のセッション数が fixtures の件数(DB ∪ ディレクトリ)と一致し、詳細ページが揃う', async () => {
    const store = await readFixtureStore();
    const ids = new Set([...store.sessions.map((r) => r.id as string), ...readdirSync(join(home, 'session-state'))]);
    expect(data.sessions.length).toBe(ids.size);
    expect(new Set(data.sessions.map((s) => s.id))).toEqual(ids);
    // Phase 5: metrics は空のセッション(006 / 007 / 010)を除いた集計
    const empties = data.sessions.filter((s) => s.empty).length;
    expect(empties).toBe(3);
    expect(data.metrics.emptySessions).toBe(empties);
    expect(data.metrics.overall.sessions).toBe(ids.size - empties);
    expect(data.totalSessionsInSource).toBe(ids.size);
    expect(data.anonymized).toBe(false);
    expect(data.judgments.available).toBe(false);
    // 要約だけ: 生イベント・timeline は埋め込まない。1 セッションあたり数 KB 以内
    for (const s of data.sessions) {
      expect(s).not.toHaveProperty('timeline');
      expect(s).not.toHaveProperty('events');
      expect(JSON.stringify(s).length).toBeLessThan(8 * 1024);
    }
    // 詳細ページ: 一覧からの相対リンク先が存在する
    for (const s of data.sessions) expect(existsSync(join(out, s.href))).toBe(true);
    expect((await readdir(join(out, 'sessions'))).length).toBe(ids.size);
    // 入力トークン記録の有無が欠測込みで入っている
    expect(data.sessions.filter((s) => s.coverage === 'input').length).toBe(data.metrics.overall.sessionsWithInputTokens);
  });

  it('c. --anonymize で fixture の cwd / git_root / repository / branch の文字列が HTML に出ない', async () => {
    const r = atlas(['all', '--home', home, '--out', outAnon, '--anonymize']);
    expect(r.status, r.stderr).toBe(0);
    const secrets = await fixtureSecrets();
    expect(secrets.length).toBeGreaterThan(5);
    // 伏せ字なしの HTML には実際に出ている(検査が空振りしていないことの確認)
    const plainFiles = await readAllHtml(out);
    expect(secrets.filter((s) => plainFiles.some((f) => appearances(f.html, s))).length).toBeGreaterThan(0);

    const files = await readAllHtml(outAnon);
    for (const f of files) {
      const leaked = secrets.filter((s) => appearances(f.html, s));
      expect({ path: f.path, leaked }).toEqual({ path: f.path, leaked: [] });
    }
    const anon = extractEmbedded<ReportData>(files[0].html);
    expect(anon.anonymized).toBe(true);
    expect(anon.sessions.length).toBe(data.sessions.length);
    // Phase 6: まとめたプロジェクト((一時フォルダ)・(atlas の判定) など)は固有名を含まないのでそのまま出る
    const anonKey = (k: string): boolean => /^project-\d+$/.test(k) || GROUPED_PROJECTS.has(k);
    expect(anon.sessions.every((s) => anonKey(s.project) && s.name === null && s.firstUserMessage === null)).toBe(true);
    expect(Object.keys(anon.metrics.byProject).every(anonKey)).toBe(true);
    expect(externalRefs(files[0].html)).toEqual([]);
  });

  it('CLI フィルタ(--client)で埋め込まれるセッションが絞られる', async () => {
    const r = atlas(['build', '--out', out, '--client', 'github/cli']);
    expect(r.status, r.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    const expected = data.sessions.filter((s) => s.client === 'github/cli').length;
    expect(expected).toBeGreaterThan(0);
    expect(d.sessions.length).toBe(expected);
    // Phase 5: metrics は空を除く
    expect(d.metrics.overall.sessions).toBe(data.sessions.filter((s) => s.client === 'github/cli' && !s.empty).length);
    expect(d.scope.client).toBe('github/cli');
    expect((await readdir(join(out, 'sessions'))).length).toBe(expected);
  });

  it('judgments.json があれば推定工数が埋め込まれる(Phase 3 の口)', async () => {
    const sid = data.sessions[0].id;
    const jpath = join(WORK, 'judgments.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        jpath,
        JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'test', ranAt: '2026-10-28T00:00:00Z' }, items: [{ sessionId: sid, taskCategory: 'docs', humanEffort: { hours: 1.5, low: 1, high: 2, confidence: 0.5 } }] }),
      ),
    );
    const r = atlas(['build', '--out', out, '--judgments', jpath]);
    expect(r.status, r.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    expect(d.judgments).toMatchObject({ available: true, backend: 'external', items: 1 });
    expect(d.sessions.find((s) => s.id === sid)?.judgment).toMatchObject({ taskCategory: 'docs', hours: 1.5 });
    expect(d.sessions.filter((s) => s.judgment).length).toBe(1);
    // 形の壊れた judgments は黙って無視せずに失敗する
    await import('node:fs/promises').then((fs) => fs.writeFile(jpath, JSON.stringify({ schemaVersion: 9, items: [] })));
    const bad = atlas(['build', '--out', out, '--judgments', jpath]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/schemaVersion/);
  });
});

describe.skipIf(!LIVE)('Phase 2 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let r: ReturnType<typeof atlas>;
  let html: string;
  let data: ReportData;

  beforeAll(async () => {
    r = atlas(['all', '--home', src, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });

  it('d. 実データの atlas.html が 5MB 未満で、プロジェクト別の集計が入る', async () => {
    const bytes = Buffer.byteLength(html);
    const projects = Object.keys(data.metrics.byProject).length;
    const details = (await readdir(join(out, 'sessions'))).length;
    console.log(
      `[live] atlas all ${r.ms.toFixed(0)}ms, atlas.html ${(bytes / 1024 / 1024).toFixed(2)}MB, sessions=${data.sessions.length}, projects=${projects}, detailPages=${details}\n${r.stdout}`,
    );
    expect(bytes).toBeLessThan(LIMIT);
    expect(projects).toBeGreaterThan(1);
    expect(details).toBe(data.sessions.length);
    expect(externalRefs(html)).toEqual([]);
  });

  it('実データの伏せ字版に cwd / リポジトリ名 / ブランチが出ない', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    const anonOut = join(ROOT, 'out', 'e2e-phase2-live-anon');
    await buildReport({
      sessions: s.sessions,
      metrics: computeMetrics(s.sessions),
      totalSessionsInSource: s.sessions.length,
      warnings: { unknownEventTypes: 0, badLines: 0 },
      judgments: null,
      outDir: anonOut,
      anonymize: true,
    });
    // 一般的な語と衝突しない程度に長い固有名だけを調べる(短いブランチ名 main 等は仮名の文脈では区別できない)
    const secrets = [...new Set(s.sessions.flatMap((x) => [x.cwd, x.gitRoot, x.repository, x.branch && x.branch.length >= 8 ? x.branch : null]))].filter(
      (v): v is string => !!v && v.length >= 8,
    );
    const anonHtml = await readFile(join(anonOut, 'atlas.html'), 'utf8');
    const leaked = secrets.filter((x) => appearances(anonHtml, x));
    console.log(`[live-anon] secrets=${secrets.length} leakedInIndex=${leaked.length}`);
    expect(leaked).toEqual([]);
    // 詳細ページは件数が多いので先頭 100 件を検査
    const pages = (await readdir(join(anonOut, 'sessions'))).slice(0, 100);
    for (const p of pages) {
      const h = await readFile(join(anonOut, 'sessions', p), 'utf8');
      const l = secrets.filter((x) => appearances(h, x));
      expect({ p, l }).toEqual({ p, l: [] });
    }
  });
});
