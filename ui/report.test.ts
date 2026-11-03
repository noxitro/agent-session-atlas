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

  it('b. グループを作成して選ぶと絞り込まれ、本文の見出しで名前と説明を直せて、削除すると groups.json からも消える', async () => {
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
    // サイドバーは切り替えだけ(選んでも行の間に操作が差し込まれず、下の行の位置が変わらない)
    const below = async (): Promise<number> => (await rail().boundingBox())!.height;
    const y0 = await below();
    await rail().getByRole('button', { name: /画面のテスト/ }).click();
    await expect.poll(shown).toBe(2);
    expect(await below()).toBe(y0);
    expect(await rail().getByRole('button', { name: /削除|改名|編集/ }).count()).toBe(0);
    // 現在のグループを押し直しても外れない(外すのは本文の見出しの「絞り込みを外す」か「すべて」)
    await rail().getByRole('button', { name: /画面のテスト/ }).click();
    await expect.poll(shown).toBe(2);

    // 管理は本文の見出しで: 名前と説明を 1 回で直す → 削除は編集欄の奥で確認つき
    const head = page.getByTestId('group-head');
    expect(await head.getByRole('heading').innerText()).toMatch(/画面のテスト\s*2 件/);
    await head.getByTestId('group-edit').click();
    await head.getByLabel('名前').fill('画面のテスト2');
    await head.getByLabel('説明(任意)').fill('見出しから直した');
    await head.getByRole('button', { name: '保存' }).click();
    await expect.poll(async () => (await readGroups()).map((g) => [g.name, (g as { note?: string }).note])).toEqual([['画面のテスト2', '見出しから直した']]);
    await expect.poll(() => head.getByRole('heading').innerText()).toMatch(/画面のテスト2/);
    expect(new URL(page.url()).hash).toContain('group=' + encodeURIComponent('画面のテスト2'));
    expect(await shown()).toBe(2);
    // Esc は 1 段ずつ戻る(確認 → 編集 → 表示)。削除せずに戻れる
    await head.getByTestId('group-edit').click();
    await head.getByTestId('group-delete').click();
    // 確認では焦点が「やめる」にある(Enter で消さない)
    const focused = (): Promise<string | null> => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent ?? null");
    await expect.poll(focused).toBe('やめる');
    await page.keyboard.press('Escape');
    await expect.poll(focused).toBe('group-delete');
    await page.keyboard.press('Escape');
    await expect.poll(focused).toBe('group-edit');
    expect((await readGroups()).length).toBe(1);

    await head.getByTestId('group-edit').click();
    await head.getByTestId('group-delete').click();
    await head.getByRole('button', { name: '削除する' }).click();
    await expect.poll(readGroups).toEqual([]);
    await expect.poll(() => head.count()).toBe(0);
    await expect.poll(() => rail().getByRole('button', { name: /画面のテスト/ }).count()).toBe(0);
    await expect.poll(shown).toBe(all);
  });

  it('b2. 作成・追加の後と「すべて」に戻った後はチェックが外れ、次のグループに前の分が混ざらない。所属は一覧と詳細ページに出る', async () => {
    await page.goto(server.url);
    const idOf = async (i: number): Promise<string> => /sessions\/([^/]+)\.html$/.exec((await page.locator('table.ledger tbody td.name a').nth(i).getAttribute('href'))!)![1];
    const [id0, id1, id2] = [await idOf(0), await idOf(1), await idOf(2)];
    const create = async (name: string): Promise<void> => {
      await page.getByTestId('add-to-group').click();
      await page.getByTestId('create-group').click();
      const form = page.getByTestId('create-form');
      await form.getByPlaceholder('例: 11 月の調査').fill(name);
      await form.getByRole('button', { name: '作成' }).click();
      await expect.poll(async () => (await readGroups()).some((g) => g.name === name)).toBe(true);
    };
    const toAll = async (): Promise<void> => {
      await rail().getByRole('button', { name: 'すべて', exact: true }).click();
      await expect.poll(() => page.getByTestId('selected-count').innerText()).toBe('0');
    };
    await rowChecks().nth(0).check();
    await rowChecks().nth(1).check();
    await create('甲');
    await toAll();
    // 「すべて」に戻った後に 1 件だけ選んで作ると、その 1 件だけが入る(前の 2 件が混ざらない)
    await rowChecks().nth(2).check();
    await create('乙');
    // ids の順はグループに入れた順(一覧の並びとは限らない)なので、並べ替えて比べる
    const sorted = async (): Promise<Record<string, string[]>> => Object.fromEntries((await readGroups()).map((g) => [g.name, [...g.ids].sort()]));
    expect(await sorted()).toEqual({ 甲: [id0, id1].sort(), 乙: [id2] });
    await toAll();

    // 既存のグループに足すと、絞り込みは変えずにチェックを外す
    await rowChecks().nth(2).check();
    await page.getByTestId('add-to-group').click();
    const menu = page.getByTestId('add-menu');
    // メニューは画面の右にはみ出さない(ページが横に流れない)
    const box = (await menu.boundingBox())!;
    const vw = await page.evaluate<number>('innerWidth');
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(vw);
    await menu.getByRole('button', { name: /甲/ }).click();
    await expect.poll(() => page.getByTestId('group-status').innerText()).toContain('チェックは外しました');
    expect(await page.getByTestId('selected-count').innerText()).toBe('0');
    expect((await sorted())['甲']).toEqual([id0, id1, id2].sort());

    // 一覧の行に所属が出る
    const groupsLine = (i: number) => page.locator('#sessions table.ledger tbody tr').nth(i).getByTestId('session-groups');
    await expect.poll(() => groupsLine(2).innerText()).toBe('グループ: 甲、乙');
    expect(await groupsLine(0).innerText()).toBe('グループ: 甲');

    // 詳細ページにも所属が出て、名前からそのグループで絞り込んだレポートに移れる
    await page.goto(new URL(`sessions/${id2}.html`, server.url).href);
    const line = page.getByTestId('detail-groups');
    await line.waitFor({ state: 'visible' });
    expect(await line.innerText()).toMatch(/グループ\s*甲、乙/);
    await line.getByRole('link', { name: '乙' }).click();
    await page.waitForURL('**/atlas.html#group=*');
    await expect.poll(shown).toBe(1);

    // 後片付け(後のテストに残さない)
    for (const name of ['甲', '乙']) {
      await page.goto(server.url);
      await rail().getByRole('button', { name: new RegExp(name) }).click();
      const head = page.getByTestId('group-head');
      await head.getByTestId('group-edit').click();
      await head.getByTestId('group-delete').click();
      await head.getByRole('button', { name: '削除する' }).click();
      await expect.poll(async () => (await readGroups()).some((g) => g.name === name)).toBe(false);
    }
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
