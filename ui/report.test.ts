// 画面の操作の検査(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
// e2e/ は生成した HTML の文字列と API を見る。ここは Svelte の画面と詳細ページの素の script が、ブラウザで動くかを見る。
//  a. 一覧でチェック → 「選んだ N 件だけ集計」で表示中の件数が変わり、「選択を解除」で戻る
//  b. グループを作成 → groups.json に書かれる → サイドバーで選ぶと絞り込まれる → 削除で消える
//  c. 詳細ページでメモを書いて保存 → atlas-notes/memos に書かれ、再読み込みしても表示される
//  d. 用語ページへのリンクで移動でき、パンくずで戻れる
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServe, type ServeHandle } from '../packages/cli/src/serve.ts';
import { buildFixtureHome, ROOT } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const MEMO = 'UI テストのメモ KESTREL-MEMO';

describe('画面の操作', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const groupsPath = join(notes, 'groups.json');
  let close: () => Promise<void>;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const r = spawnSync(process.execPath, [CLI, 'all', '--home', home, '--out', out, '--notes-dir', notes], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    // テスト中に heartbeat が途切れても止まらないよう、猶予を長くとる
    server = await startServe({ outDir: out, notesDir: notes, groupsPath, port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000 });
    browser = await chromium.launch();
    // 1440px: サイドバー(1280px 以上)にグループの一覧が出る幅
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
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

  const shown = async (): Promise<number> => Number((await page.getByTestId('shown-count').innerText()).replace(/,/g, ''));
  const rowChecks = () => page.locator('table.ledger tbody input[type="checkbox"]');
  // グループの一覧はサイドバーと狭い幅の一覧の 2 か所にあるので、見えている方を使う
  const rail = () => page.locator('[data-testid="group-rail"]:visible');
  const readGroups = async (): Promise<{ name: string; ids: string[] }[]> => (existsSync(groupsPath) ? JSON.parse(await readFile(groupsPath, 'utf8')).groups : []);

  it('a. 一覧でチェックした件数だけで集計し、解除すると元に戻る', async () => {
    await page.goto(server.url);
    const all = await shown();
    expect(all).toBeGreaterThan(2);
    await rowChecks().nth(0).check();
    await rowChecks().nth(1).check();
    await expect.poll(() => page.getByTestId('selected-count').innerText()).toBe('2');
    await page.getByTestId('apply-selection').click();
    await expect.poll(shown).toBe(2);
    await page.getByRole('button', { name: '選択を解除' }).click();
    await expect.poll(shown).toBe(all);
    await expect.poll(() => page.getByTestId('selected-count').innerText()).toBe('0');
  });

  it('b. グループを作成して選ぶと絞り込まれ、削除すると groups.json からも消える', async () => {
    await page.goto(server.url);
    await rowChecks().nth(0).check();
    await rowChecks().nth(2).check();
    await page.getByTestId('add-to-group').click();
    await page.getByTestId('create-group').click();
    const form = page.getByTestId('create-form');
    await form.getByPlaceholder('例: 11 月の調査').fill('画面のテスト');
    await form.getByRole('button', { name: '作成' }).click();
    await expect.poll(async () => (await readGroups()).map((g) => [g.name, g.ids.length])).toEqual([['画面のテスト', 2]]);
    // 作成するとそのグループで絞り込んだ状態になる(App.svelte の createGroup)
    await expect.poll(shown).toBe(2);

    // サイドバーで「すべて」→ 全件、グループを選び直す → 2 件
    const all = await (async () => {
      await rail().getByRole('button', { name: 'すべて', exact: true }).click();
      await expect.poll(shown).toBeGreaterThan(2);
      return shown();
    })();
    await rail().getByRole('button', { name: /画面のテスト/ }).click();
    await expect.poll(shown).toBe(2);

    const tools = rail().getByTestId('group-tools');
    await tools.getByRole('button', { name: '削除', exact: true }).click();
    await tools.getByRole('button', { name: '削除する' }).click();
    await expect.poll(readGroups).toEqual([]);
    await expect.poll(() => rail().getByRole('button', { name: /画面のテスト/ }).count()).toBe(0);
    await expect.poll(shown).toBe(all);
  });

  it('c. 詳細ページでメモを書いて保存すると memos に書かれ、再読み込みしても表示される', async () => {
    await page.goto(server.url);
    const link = page.locator('table.ledger tbody td.name a').first();
    const href = (await link.getAttribute('href'))!;
    const id = /sessions\/([^/]+)\.html$/.exec(href)![1];
    await link.click();
    await page.waitForURL(`**/${href}`);

    await page.getByRole('button', { name: 'メモを書く' }).click();
    await page.getByTestId('memo-text').fill(`# 見出し\n\n${MEMO}`);
    await page.getByRole('form', { name: 'メモの編集' }).getByRole('button', { name: '保存' }).click();
    await expect.poll(() => page.locator('#memo .memo-body').innerText()).toContain(MEMO);
    expect(await readFile(join(notes, 'memos', `${id}.md`), 'utf8')).toContain(MEMO);

    await page.reload();
    await expect.poll(() => page.locator('#memo .memo-body').innerText()).toContain(MEMO);
    await page.getByRole('button', { name: '編集', exact: true }).waitFor({ state: 'visible' });
  });

  it('d. 用語ページへのリンクで移動でき、パンくずでトップページに戻れる', async () => {
    await page.goto(server.url);
    await page.locator('a[href="glossary.html"]:visible').first().click();
    await page.waitForURL('**/glossary.html');
    await page.locator('h1').waitFor({ state: 'visible' });
    await page.locator('a.crumb:visible').first().click();
    await page.waitForURL('**/atlas.html');
    await page.getByTestId('shown-count').waitFor({ state: 'visible' });
  });
});
