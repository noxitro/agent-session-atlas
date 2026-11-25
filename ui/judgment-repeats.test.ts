// 判定のぶれの画面(Playwright の Chromium)。架空の fixture で atlas all → 手書きの判定を取り込み → atlas serve を立て、実際に押して確かめる
//  a. 「判定する…」→ 工数の「判定済みから判定し直して、ぶれを測る」で、判定し直す添付ファイルを作り(bundle --rejudge)、返答を取り込んで反映すると、
//     概況に「判定のぶれ」の節が出る。組が下限に届かないうちは割合を出さず、数と下限を出す
//  b. 組が下限に届けば達成の一致率などを出し、数えた組が下限に届かない値(確信度の低い推定を外した推定人手工数の比)は「—」のまま
// どの画面でもページ内の例外とコンソールのエラーが無いこと
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURES, ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-judgment-repeats');
const SAMPLE = join(FIXTURES, 'judgments-sample.json');

type Item = { sessionId: string; humanEffort: { hours: number; low: number; high: number; confidence: number; rationale: string }; aiOutcome: { completed: boolean; quality: number; rework: number; rationale: string } };

describe('判定のぶれ', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const configPath = join(WORK, 'atlas.config.json');
  let close: () => Promise<void>;
  let home: string;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  let sample: { items: Item[] };
  const problems: string[] = [];
  const jobPosts: unknown[] = [];

  function atlas(args: string[]): void {
    const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, ATLAS_CONFIG: configPath, ATLAS_COPILOT_HOME: home } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  /** 時間を変えた判定し直し(達成は first だけ変える) */
  const redo = (it: Item, first: boolean): Item => ({
    ...it,
    humanEffort: { ...it.humanEffort, hours: it.humanEffort.hours * 2, low: it.humanEffort.low * 2, high: it.humanEffort.high * 2 },
    aiOutcome: { ...it.aiOutcome, completed: first ? !it.aiOutcome.completed : it.aiOutcome.completed },
  });

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), {}));
    await writeFile(configPath, JSON.stringify({}));
    atlas(['all', '--home', home, '--out', out, '--notes-dir', notes]);
    sample = JSON.parse(await readFile(SAMPLE, 'utf8')) as { items: Item[] };
    // 手書きの判定(判定の日時はどのセッションの終わりより後)
    atlas(['judge', 'import', SAMPLE, '--out', out, '--notes-dir', notes]);
    server = await startServer({ outDir: out, notesDir: notes, configPath, port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, jobs: { env: { ATLAS_COPILOT_HOME: home, ATLAS_CONFIG: configPath } } });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('request', (q) => {
      if (q.method() === 'POST' && /\/api\/jobs$/.test(q.url())) jobPosts.push(JSON.parse(q.postData() ?? 'null'));
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close('テスト終了');
    await close?.();
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems.splice(0)).toEqual([]);
  });

  const section = () => page.getByTestId('judgment-repeats');

  it('a. 判定済みから判定し直す添付ファイルを作り、取り込んで反映すると「判定のぶれ」が出る(下限に届くまでは数だけ)', async () => {
    await page.goto(server.url);
    // 履歴が無いうちは節を出さない
    expect(await section().count()).toBe(0);
    await page.getByTestId('job-judge').click();
    await page.getByTestId('judge-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('judge-target-effort').check();
    await page.getByTestId('judge-method-chat').check();
    const box = page.getByTestId('chat-rejudge');
    await box.waitFor({ state: 'visible' });
    await box.locator('summary').click();
    expect(await box.innerText()).toContain(`判定済みのセッション ${sample.items.length} 件から`);
    expect(await box.innerText()).toContain('前の判定は添付ファイルに入れません');
    await page.getByTestId('chat-rejudge-n').fill('2');
    expect(await page.getByTestId('chat-rejudge-make').innerText()).toBe('判定済みから 2 件を選んで作る');
    await page.getByTestId('chat-rejudge-make').click();
    const state = page.getByTestId('chat-bundle-state');
    await expect.poll(() => state.innerText(), { timeout: 60_000 }).toMatch(/判定し直し、1 ファイル\)。取り込み済み 0 \/ 1 ファイル/);
    expect(jobPosts).toEqual([{ kind: 'bundle', rejudge: 2 }]);
    const manifest = JSON.parse(await readFile(join(out, 'bundle', 'manifest.json'), 'utf8')) as { scope: Record<string, string | null>; sessions: { id: string }[] };
    expect(manifest.scope.rejudge).toBe('2');
    const ids = manifest.sessions.map((s) => s.id);
    expect(ids.length).toBe(2);
    // 判定し直した返答を貼って取り込む → 判定し直した分が「済み」になる
    const items = sample.items.filter((i) => ids.includes(i.sessionId)).map((i) => redo(i, false));
    await page.getByTestId('chat-reply').fill(`\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'second', ranAt: new Date().toISOString() }, items })}\n\`\`\``);
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-result').innerText()).toBe('2 件を取り込みました(判定し直し 2 件)。');
    await expect.poll(() => state.innerText()).toMatch(/取り込み済み 1 \/ 1 ファイル/);
    await page.getByTestId('chat-reflect').click();
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await section().waitFor({ state: 'visible' });
    expect(await page.locator('.toc a[href="#judgment-repeats"]').count()).toBe(1);
    expect(await page.getByTestId('repeats-pairs').innerText()).toBe('2');
    expect(await page.getByTestId('repeats-models').innerText()).toBe('モデルが同じ 0・違う 2');
    expect(await page.getByTestId('repeats-completed').innerText()).toBe('—');
    expect(await page.getByTestId('repeats-few').innerText()).toContain('判定し直した組が 2 組で、下限の 5 組に届かないので');
    const head = await section().locator('.section-head p').innerText();
    expect(head).toContain('同じセッションを、入力が変わらないまま判定し直したときの一致です');
    expect(head).toContain('上の絞り込みは掛かりません');
  });

  it('b. 組が下限に届けば割合と中央値を出し、数えた組が下限に届かない値は「—」のまま(file:// で開いても同じ)', async () => {
    const file = join(WORK, 'again.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'third', ranAt: new Date(Date.now() + 60_000).toISOString() }, items: sample.items.map((i, k) => redo(i, k === 0)) }));
    atlas(['judge', 'import', file, '--out', out, '--notes-dir', notes]);
    await page.goto(pathToFileURL(join(out, 'atlas.html')).href);
    await section().waitFor({ state: 'visible' });
    expect(await page.getByTestId('repeats-pairs').innerText()).toBe(String(sample.items.length));
    expect(await page.getByTestId('repeats-few').count()).toBe(0);
    // 達成: 5 組のうち 1 組だけ変えた(判定し直した 2 件は、前の判定し直しと比べる)
    expect(await page.getByTestId('repeats-completed').innerText()).toBe('80%');
    // 確信度 30% 以下の推定を含む組は推定人手工数の比に入れないので、4 組で下限に届かない
    expect(await page.getByTestId('repeats-hours').innerText()).toBe('—');
    expect(await page.getByTestId('repeats-hours-note').innerText()).toContain('4 組。5 組から出します');
    expect(await page.getByTestId('repeats-quality').innerText()).toBe('質 0・手戻り 0');
    const defs = await page.getByTestId('repeats-defs').innerText();
    expect(defs).toContain('確信度 30% 以下の推定を含む組を入れません(今は 1 組)');
    expect(defs).toContain('依頼ごとの判定のぶれは、ここでは数えていません');
    // 狭い幅でもページがはみ出さない
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});
