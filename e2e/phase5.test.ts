// Phase 5 E2E(docs/PLAN.md「改善フェーズ → Phase 5: 正しさとノイズ」)
// fixture に合成した新しい記録形式(scripts/synthetic-fixtures.ts)で、件数が手計算値と一致することを確かめる。
//  1. 空のセッション(006 DB のみ / 007 開いただけ / 010 DB のみ。いずれも合成)を empty にし、metrics から外して件数を持つ
//  2. モデル名の表記揺れ(<UUID>/claude-haiku-5-5、claude-haiku-5-5、claude-haiku-5.5、claude-sonnet-5-5)を 1 つにする
//  3. 内部ツール report_intent を tools から外して tools.internal に数える
//  4. 「ツール失敗」と「エラー(session.error)」を分けて表示する
//  5. 変更ファイルを cwd 基準の絶対パスで重複除去し、session-state 配下を外して件数だけ持つ
//  6. fileEdits[] の削除、isAutopilotContinuation、agentId だけのサブエージェント応答、トークン欠測の件数
//  7. クライアント不明(fixture では DB だけのセッション。どちらも空)
// ATLAS_LIVE=1 のときは実データで同じ集計を出し、空のセッション数・正規化後のモデル数・除去した内部ツール件数・
// 欠測の件数・クライアント不明の残数をログに出す(out/live に atlas.html を作り直す)。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetricsFile, SessionRecord, SessionsFile } from '../packages/core/src/index.ts';
import { aggregate, applyFilter, emptyFilter, extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { modelLabel } from '../packages/report/src/lib/format.ts';
import { buildFixtureHome, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase5');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

/** 正規化前の表記揺れが残っていないか(claude-x-5-5 形式・<UUID>/ 付き) */
const UNNORMALIZED = /^claude-[a-z]+-\d+-\d$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

describe('Phase 5 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  const out = join(WORK, 'out');
  let s: SessionsFile;
  let m: MetricsFile;
  let html: string;
  let data: ReportData;
  const rec = (n: number): SessionRecord => {
    const r = s.sessions.find((x) => x.id === id(n));
    if (!r) throw new Error(`fixture ${id(n)} が sessions.json に無い`);
    return r;
  };

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const r = atlas(['all', '--home', home, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    console.log(`[fixtures] ${r.stdout}`);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });
  afterAll(async () => close?.());

  it('1. 空のセッションは empty で、metrics・既定の画面集計から外し、件数を持つ', () => {
    const empties = s.sessions.filter((x) => x.empty).map((x) => x.id);
    // 006: DB だけのセッション(turns 0)/ 007: 開いただけ / 010: DB だけ(いずれも合成)
    expect(empties.sort()).toEqual([id(6), id(7), id(10)]);
    expect(s.counts.empty).toBe(3);
    expect(m.emptySessions).toBe(3);
    expect(m.overall.sessions).toBe(s.sessions.length - 3);
    // 空のセッションしか無いプロジェクトはプロジェクト表に出ない
    expect(Object.keys(m.byProject)).not.toContain('X:\\synthetic-empty');
    expect(Object.keys(m.byProject)).not.toContain('X:\\synthetic-dbonly');
    // 画面: 既定の絞り込み(空を除外)の集計が metrics と一致し、「含める」で全件
    expect(data.sessions.filter((x) => x.empty).length).toBe(3);
    const def = applyFilter(data.sessions, emptyFilter());
    expect(aggregate(def).overall.sessions).toBe(m.overall.sessions);
    expect(aggregate(def).byProject.length).toBe(Object.keys(m.byProject).length);
    expect(applyFilter(data.sessions, { ...emptyFilter(), empty: '1' }).length).toBe(s.sessions.length);
    // 画面の文言(Svelte のテンプレートに含まれる)
    for (const t of ['空のセッションを含める', '件を除外']) expect(html).toContain(t);
  });

  it('2. モデル名の表記揺れを 1 つにし、models を重複除去する', () => {
    // 008: selectedModel <UUID>/claude-haiku-5-5、assistant.message claude-haiku-5.5 / claude-haiku-5-5、usage_record claude-haiku-5-5 と 5.5
    expect(rec(8).models).toEqual(['claude-haiku-5.5']);
    expect(Object.keys(rec(8).tokens.byModel)).toEqual(['claude-haiku-5.5']);
    expect(rec(8).tokens.byModel['claude-haiku-5.5']).toMatchObject({ input: 1500, output: 70, requests: 2 });
    // 002: usage_record の claude-sonnet-5-5(modelDisplayName は <UUID>/claude-sonnet-5-5)、selectedModel の <UUID>/claude-sonnet-5-5、
    // assistant.message の claude-sonnet-5.5、shutdown.modelMetrics の claude-sonnet-5-5
    expect(Object.keys(rec(2).tokens.byModel)).toEqual(['claude-sonnet-5.5']);
    expect(rec(2).models).toEqual(['claude-sonnet-5.5']);
    for (const x of s.sessions) {
      expect(x.models.filter((mm) => UNNORMALIZED.test(mm))).toEqual([]);
      // 表示名(modelLabel)でも重複しない
      expect(new Set(x.models.map(modelLabel)).size).toBe(x.models.length);
    }
    expect(Object.keys(m.byModel).filter((k) => UNNORMALIZED.test(k))).toEqual([]);
    expect(m.byModel['claude-haiku-5.5']).toMatchObject({ sessions: 1, input: 1500 });
  });

  it('3. 内部ツール report_intent を tools から外して internal に数える', () => {
    // Phase 6 で mcp・results を足した(apply_patch の失敗 1。report_intent の結果は数えない)
    expect(rec(8).tools).toEqual({
      byName: { edit: 1, create: 2, powershell: 1, apply_patch: 1 },
      total: 5,
      internal: { byName: { report_intent: 2 }, total: 2 },
      mcp: {},
      results: { edit: { success: 1, failure: 0, denied: 0 }, create: { success: 2, failure: 0, denied: 0 }, powershell: { success: 1, failure: 0, denied: 0 }, apply_patch: { success: 0, failure: 1, denied: 0 } },
      // Phase 7 で所要時間を足した(合成 fixture はイベントが 1 秒間隔。内部ツールは除く)
      durations: { edit: [1000], create: [1000, 1000], powershell: [1000], apply_patch: [1000] },
      durationOutliers: {},
    });
    expect(m.overall.tools.internal).toBe(2);
    expect(m.overall.tools.byName).not.toHaveProperty('report_intent');
    expect(data.sessions.find((x) => x.id === id(8))?.tools).toMatchObject({ total: 5, internal: 2 });
    expect(html).toContain('内部ツール(report_intent)');
  });

  it('4. ツール失敗とエラー(session.error)を分けて数え、表示も分ける', async () => {
    // 008: apply_patch の失敗 1(report_intent の失敗は数えない)、session.error 1
    expect(rec(8).friction).toMatchObject({ toolFailures: 1, errors: 1 });
    expect(html).toContain('エラー(session.error)');
    expect(html).not.toMatch(/frictionDetail\.errors\s*\+\s*\w+\.frictionDetail\.toolFailures/);
    const detail = await readFile(join(out, 'sessions', `${id(8)}.html`), 'utf8');
    expect(detail).toContain('session.error(ツール失敗は別)');
  });

  it('5. 変更ファイルを絶対パスにそろえて重複除去し、session-state 配下は件数だけ持つ', async () => {
    // edit(相対 src\\app.ts)+ fileEdits(絶対)+ apply_patch(src/app.ts)+ shutdown(絶対)→ 1 件
    // create(絶対)+ fileEdits(大文字小文字違い)→ 1 件、plan.md(session-state 配下)→ 一覧から外して 1 件
    expect(rec(8).files).toEqual({
      changed: ['X:\\synthetic-new\\src\\app.ts', 'X:\\synthetic-new\\README.md'],
      created: ['X:\\synthetic-new\\docs\\new.md'],
      deleted: ['X:\\synthetic-new\\old.txt', 'X:\\synthetic-new\\tmp\\a.txt'],
      sessionState: 1,
    });
    for (const x of s.sessions) {
      const all = [...x.files.changed, ...x.files.created, ...x.files.deleted];
      expect(new Set(all.map((p) => p.toLowerCase())).size).toBe(all.length);
      expect(all.filter((p) => /[\\/]\.copilot[\\/]session-state[\\/]/i.test(p))).toEqual([]);
    }
    const detail = await readFile(join(out, 'sessions', `${id(8)}.html`), 'utf8');
    expect(detail).toContain('削除 2 件');
    expect(detail).toContain('session-state/ 配下の plan.md など)1 件は一覧から外しています');
    expect(detail).not.toContain('plan.md</li>');
    expect(data.sessions.find((x) => x.id === id(8))?.files).toEqual({ changed: 2, created: 1, deleted: 2, sessionState: 1 });
  });

  it('6. autopilot の自動継続・agentId だけの応答・トークン欠測を数える', async () => {
    const r = rec(8);
    // user.message 3 件のうち isAutopilotContinuation 2 件(source 無し 1・source autopilot 1)は依頼に数えない
    expect(r.turns).toBe(1);
    expect(r.autopilotContinuations).toBe(2);
    // assistant.message 4 件のうち agentId だけを持つサブエージェントの 2 件は本体の応答に数えない
    expect(r.assistantMessages).toBe(2);
    expect(r.lastAssistantMessage).toBe('done');
    expect(m.overall.autopilotContinuations).toBe(2);
    // 欠測: 009(合成)と 099(合成、Phase 1 から)が、依頼があるのにトークン記録が何も無い
    expect(rec(9).tokens.source).toBe('none');
    expect(rec(9).empty).toBe(false);
    expect(m.overall.sessionsMissingTokens).toBe(2);
    // Phase 6 で足した合成 011〜013 は usage_record を持つので events が 2 → 5
    expect(m.overall.tokenSources).toEqual({ db: 2, events: 5, 'db+events': 0, shutdown: 1, partial: 1, none: 2 });
    expect(m.byMonth['2026-10'].sessionsMissingTokens).toBe(2);
    expect(html).toContain('記録なし(欠測)');
    // 評価バンドルの依頼文も同じ規則(自動継続を含めない)で、削除したファイルも載る
    const b = atlas(['bundle', '--out', out]);
    expect(b.status, b.stderr).toBe(0);
    const md = await readFile(join(out, 'bundle', 'sessions', `${id(8)}.md`), 'utf8');
    expect(md).toContain('ユーザーの依頼 1 件');
    expect(md).toContain('作成 1 件 / 変更 2 件 / 削除 2 件');
    expect(md).toContain('削除: X:\\synthetic-new\\tmp\\a.txt');
    expect(md).not.toContain('sub-agent reply');
  });

  it('7. クライアント不明は DB だけのセッション(記録上 client を持たない)で、fixture ではどちらも空', () => {
    const unknown = s.sessions.filter((x) => x.client == null);
    expect(unknown.map((x) => x.id).sort()).toEqual([id(6), id(10)]);
    expect(unknown.every((x) => x.sources.join() === 'db' && x.empty)).toBe(true);
    expect(m.byClient).not.toHaveProperty('(unknown)');
  });

  it('HTML は 5MB 未満で、--anonymize では新しく出したファイルパスも出ない', async () => {
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    const anonOut = join(WORK, 'out-anon');
    const r2 = atlas(['all', '--home', home, '--out', anonOut, '--anonymize']);
    expect(r2.status, r2.stderr).toBe(0);
    const files = [join(anonOut, 'atlas.html'), ...(await readdir(join(anonOut, 'sessions'))).map((f) => join(anonOut, 'sessions', f))];
    for (const f of files) {
      const h = await readFile(f, 'utf8');
      for (const secret of ['synthetic-new', 'synthetic-missing', 'synthetic-empty', 'synthetic-dbonly', 'app.ts', 'old.txt', 'someone']) {
        expect({ f, secret, found: h.includes(secret) }).toEqual({ f, secret, found: false });
      }
    }
  });
});

describe.skipIf(!LIVE)('Phase 5 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let s: SessionsFile;
  let m: MetricsFile;
  let r: ReturnType<typeof atlas>;

  beforeAll(async () => {
    r = atlas(['all', '--home', src, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    s = await readJson<SessionsFile>(join(out, 'sessions.json'));
    m = await readJson<MetricsFile>(join(out, 'metrics.json'));
  });

  it('空のセッション数・正規化後のモデル数・除去した内部ツール・欠測・クライアント不明をログに出す', async () => {
    const all = s.sessions;
    const nonEmpty = all.filter((x) => !x.empty);
    const models = new Set(all.flatMap((x) => x.models));
    const internal = all.reduce((a, x) => a + x.tools.internal.total, 0);
    const internalByName: Record<string, number> = {};
    for (const x of all) for (const [k, v] of Object.entries(x.tools.internal.byName)) internalByName[k] = (internalByName[k] ?? 0) + v;
    const unknownClient = nonEmpty.filter((x) => x.client == null);
    const reasons: Record<string, number> = {};
    for (const x of unknownClient) {
      const k = x.sources.join('+') === 'db' ? 'DB のみ(client の列が無い)' : `workspace.yaml に client_name なし(Copilot ${x.copilotVersion ?? '不明'})`;
      reasons[k] = (reasons[k] ?? 0) + 1;
    }
    const autopilot = all.reduce((a, x) => a + x.autopilotContinuations, 0);
    const files = all.reduce(
      (a, x) => ({ changed: a.changed + x.files.changed.length, created: a.created + x.files.created.length, deleted: a.deleted + x.files.deleted.length, sessionState: a.sessionState + x.files.sessionState }),
      { changed: 0, created: 0, deleted: 0, sessionState: 0 },
    );
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    console.log(
      `[live] atlas all ${r.ms.toFixed(0)}ms, sessions=${all.length}, empty=${s.counts.empty} (metrics.emptySessions=${m.emptySessions}), nonEmpty=${nonEmpty.length}\n` +
        `[live] models(正規化後)=${models.size}: ${[...models].sort().join(', ')}\n` +
        `[live] 内部ツール除去=${internal} ${JSON.stringify(internalByName)}、autopilot 自動継続=${autopilot}\n` +
        `[live] トークン欠測(非空で記録なし)=${m.overall.sessionsMissingTokens}、出所別=${JSON.stringify(m.overall.tokenSources)}\n` +
        `[live] 月別の欠測=${JSON.stringify(Object.fromEntries(Object.entries(m.byMonth).map(([k, b]) => [k, b.sessionsMissingTokens])))}\n` +
        `[live] クライアント不明(非空)=${unknownClient.length} / 全体 ${all.filter((x) => x.client == null).length}: ${JSON.stringify(reasons)}\n` +
        `[live] ファイル: 変更 ${files.changed} / 作成 ${files.created} / 削除 ${files.deleted} / session-state 除外 ${files.sessionState}\n` +
        `[live] atlas.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)}MB`,
    );
    expect(m.emptySessions).toBe(s.counts.empty);
    expect(m.overall.sessions).toBe(nonEmpty.length);
    expect([...models].filter((x) => UNNORMALIZED.test(x))).toEqual([]);
    expect(all.some((x) => 'report_intent' in x.tools.byName)).toBe(false);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    for (const x of all) {
      const paths = [...x.files.changed, ...x.files.created, ...x.files.deleted];
      expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
      expect(paths.filter((p) => /[\\/]\.copilot[\\/]session-state[\\/]/i.test(p))).toEqual([]);
    }
    expect(existsSync(join(out, 'atlas.html')) && statSync(join(out, 'atlas.html')).size > 0).toBe(true);
  });
});
