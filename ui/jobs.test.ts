// Phase 14 の画面の操作(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
//  e. 「集計し直す」→ 帯が実行中から完了に変わり、「再読み込み」で新しい集計(埋め込みの生成日時)が出て帯は消える
//  f. 「工数を判定する…」の確認ダイアログ: 「やめる」なら API を呼ばない。件数を決めて実行すると偽 copilot で判定が増える
//  g. 詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ、記録に混ぜた script やイベント属性は実行されない
//  h. file:// で開いた atlas.html と詳細ページには操作が出ない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServe, type ServeHandle } from '../packages/cli/src/serve.ts';
import { buildFixtureHome, FIXTURE_CODE, ROOT } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-jobs');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');
const EVIL = '\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 2">\n\n[危ない](javascript:window.__pwned=3)\n';

describe('画面からの操作(Phase 14)', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const fakeLog = join(WORK, 'fake-copilot.log');
  let close: () => Promise<void>;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];
  const jobPosts: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), { phase11: true }));
    const r = spawnSync(process.execPath, [CLI, 'all', '--home', home, '--out', out, '--notes-dir', notes], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    server = await startServe({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      idleMs: 600_000,
      firstHeartbeatMs: 600_000,
      jobs: { env: { ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: fakeLog } },
    });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('request', (q) => {
      if (q.method() === 'POST' && /\/api\/jobs$/.test(q.url())) jobPosts.push(q.postData() ?? '');
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close('テスト終了');
    await close?.();
  });
  afterEach(() => {
    expect(problems).toEqual([]);
  });

  const generatedAt = (): Promise<string> => page.evaluate<string>("JSON.parse(document.getElementById('atlas-data').textContent).generatedAt");
  const band = () => page.getByTestId('job-band');

  it('e. 「集計し直す」で帯が完了に変わり、「再読み込み」で新しい集計が出る(自動では読み直さない)', async () => {
    await page.goto(server.url);
    const before = await generatedAt();
    await page.getByTestId('job-refresh').click();
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    await expect.poll(() => band().innerText()).toContain('新しい集計ができました');
    // 自動では読み直さない(埋め込みは古いまま)
    expect(await generatedAt()).toBe(before);
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await expect.poll(async () => Date.parse(await generatedAt())).toBeGreaterThan(Date.parse(before));
    // 読み直した後は、この画面のデータより前の処理なので帯を出さない
    await page.waitForTimeout(300);
    expect(await band().getAttribute('data-state')).toBe('');
    expect(await band().isVisible()).toBe(false);
  });

  it('f. 判定の確認ダイアログ: 「やめる」なら API を呼ばず、件数を決めて実行すると偽 copilot で判定が増える', async () => {
    jobPosts.length = 0; // e. の集計し直しの分を数えない
    await page.goto(server.url);
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(/未判定 \d+ 件のうち 10 件を判定します/);
    expect(await dialog.innerText()).toContain('AI クレジットを消費します');
    // 初期フォーカスは「やめる」
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('judge-cancel');
    await page.getByTestId('judge-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(jobPosts).toEqual([]);
    expect(existsSync(join(out, 'judgments.json'))).toBe(false);
    // Esc でも閉じて何も呼ばない
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(jobPosts).toEqual([]);

    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('judge-limit').fill('2');
    await expect.poll(() => page.getByTestId('judge-run').innerText()).toBe('2 件を判定する');
    await page.getByTestId('judge-run').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'judge', limit: 2, backend: 'copilot-cli' }]);
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    const j = JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: unknown[] };
    expect(j.items).toHaveLength(2);
    expect((await readFile(fakeLog, 'utf8')).trim().split('\n')).toHaveLength(2);
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await expect.poll(() => page.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).judgments.items")).toBe(2);
  });

  it('g. 詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ、記録に混ぜた script は実行されない', async () => {
    await page.goto(server.url);
    const link = page.locator('table.ledger tbody td.name a').first();
    const href = (await link.getAttribute('href'))!;
    const id = /sessions\/([^/]+)\.html$/.exec(href)![1];
    await appendFile(join(out, 'sessions', `${id}.md`), EVIL);
    await link.click();
    await page.waitForURL(`**/${href}`);

    // 記録は別のウィンドウで開き、詳細ページは残る(.md を直接開くリンクも同じ。保存のリンクはそのまま)
    expect(await page.locator('.rail-links a[href$=".md"]:not([download])').first().getAttribute('target')).toBe('_blank');
    expect(await page.locator('.rail-links a[download]').getAttribute('target')).toBeNull();
    const watch = (p: Page): Page => {
      p.on('pageerror', (e) => problems.push(`pageerror(別ウィンドウ): ${e.message}`));
      p.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console(別ウィンドウ): ${m.text()}`);
      });
      return p;
    };
    const [view] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: '記録を読む' }).click()]);
    watch(view);
    await view.waitForURL(`**/view/${id}?kind=transcript`);
    const body = view.locator('#view-body');
    await body.waitFor({ state: 'visible' });
    expect(await view.locator('h1').innerText()).toMatch(/^セッション記録/);
    expect(await body.innerText()).toContain('<script>window.__pwned = 1</script>');
    expect(await body.locator('script, img').count()).toBe(0);
    expect(await body.locator('a[href^="javascript"]').count()).toBe(0);
    expect(await view.locator('.rail .toc a').count()).toBeGreaterThan(1);
    expect(await view.evaluate<number | undefined>('window.__pwned')).toBeUndefined();
    expect(await view.evaluate<boolean>('window.opener === null')).toBe(true);
    expect(page.url()).toContain(href);
    await view.close();

    // 全文: 押した時点で開いた空のウィンドウが、作り終わると全文記録の表示に移る
    const [fullView] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: '全文を作って読む' }).click()]);
    watch(fullView);
    await fullView.waitForURL(`**/view/${id}?kind=full`, { timeout: 60_000 });
    const fullBody = fullView.locator('#view-body');
    await fullBody.waitFor({ state: 'visible' });
    expect(await fullView.locator('h1').innerText()).toMatch(/全文記録/);
    expect(await fullBody.locator('script').count()).toBe(0);
    expect(await fullView.evaluate<boolean>('window.opener === null')).toBe(true);
    expect(existsSync(join(out, 'full', `${id}.md`))).toBe(true);
    expect(existsSync(join(out, 'coverage.json'))).toBe(false);
    expect(await fullView.evaluate<number | undefined>('window.__pwned')).toBeUndefined();
    // 元の詳細ページはそのままで、もう一度開くためのリンクが出る
    expect(page.url()).toContain(href);
    expect(await page.getByRole('link', { name: '全文記録を開く' }).getAttribute('target')).toBe('_blank');
    await fullView.close();
  });

  it('h. file:// で開いた atlas.html と詳細ページには操作が出ない', async () => {
    await page.goto(pathToFileURL(join(out, 'atlas.html')).href);
    await page.getByTestId('shown-count').waitFor({ state: 'visible' });
    expect(await page.getByTestId('job-refresh').count()).toBe(0);
    expect(await page.getByTestId('job-band').count()).toBe(0);
    const href = (await page.locator('table.ledger tbody td.name a').first().getAttribute('href'))!;
    await page.goto(pathToFileURL(join(out, href)).href);
    await page.locator('h1').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    expect(await page.locator('.session-ops').count()).toBe(0);
    expect(await page.getByText('全文を作って読む').count()).toBe(0);
  });
});
