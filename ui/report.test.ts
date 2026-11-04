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
  const readGroups = async (): Promise<{ name: string; note?: string; ids: string[] }[]> => (existsSync(groupsPath) ? JSON.parse(await readFile(groupsPath, 'utf8')).groups : []);

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

  it('b3. 見出しの編集: 一覧からの追加で打ちかけが消えない・同名への改名は理由を出して名前を変えない・説明だけ空にできる・外すと焦点は本文へ', async () => {
    await page.goto(server.url);
    const create = async (rows: number[], name: string): Promise<void> => {
      for (const i of rows) await rowChecks().nth(i).check();
      await page.getByTestId('add-to-group').click();
      await page.getByTestId('create-group').click();
      const form = page.getByTestId('create-form');
      await form.getByPlaceholder('例: 11 月の調査').fill(name);
      await form.getByLabel('説明(任意)').fill(`${name}の説明`);
      await form.getByRole('button', { name: '作成' }).click();
      await expect.poll(async () => (await readGroups()).some((g) => g.name === name)).toBe(true);
    };
    await create([0], '丙');
    await rail().getByRole('button', { name: 'すべて', exact: true }).click();
    await create([1], '丁');
    const head = page.getByTestId('group-head');

    // 編集を開いたまま一覧から別のグループに足しても(グループの一覧が作り直されても)、打ちかけた名前は残る
    await head.getByTestId('group-edit').click();
    await head.getByLabel('名前').fill('打ちかけ');
    await page.getByTestId('add-to-group').click();
    await page.getByTestId('add-menu').getByRole('button', { name: /丙/ }).click();
    await expect.poll(async () => (await readGroups()).find((g) => g.name === '丙')?.ids.length).toBe(2);
    expect(await head.getByLabel('名前').inputValue()).toBe('打ちかけ');

    // 既にある名前への改名は 409 の理由を出し、名前も URL も変えない
    await head.getByLabel('名前').fill('丙');
    await head.getByRole('button', { name: '保存' }).click();
    await expect.poll(() => head.getByRole('alert').count()).toBe(1);
    expect((await readGroups()).map((g) => g.name).sort()).toEqual(['丙', '丁'].sort());
    // 409 の応答はブラウザが「Failed to load resource」をコンソールに出す(画面は理由を表示して扱えている)。この 1 件だけ想定どおりとして外す
    const conflict = problems.findIndex((p) => p.includes('status of 409'));
    expect(conflict).toBeGreaterThanOrEqual(0);
    problems.splice(conflict, 1);
    expect(new URL(page.url()).hash).toContain('group=' + encodeURIComponent('丁'));

    // 説明だけを空にできる
    await head.getByLabel('名前').fill('丁');
    await head.getByLabel('説明(任意)').fill('');
    await head.getByRole('button', { name: '保存' }).click();
    await expect.poll(async () => (await readGroups()).find((g) => g.name === '丁')?.note).toBe('');
    await expect.poll(() => head.getByText('説明はまだありません').count()).toBe(1);

    // 「絞り込みを外す」で見出しが消えても、焦点は body に落ちず本文の先頭へ
    await head.getByRole('button', { name: '絞り込みを外す' }).click();
    await expect.poll(() => head.count()).toBe(0);
    await expect.poll(() => page.evaluate<string | undefined>('document.activeElement?.id')).toBe('main');

    // 後片付け
    for (const name of ['丙', '丁']) {
      await rail().getByRole('button', { name: new RegExp(name) }).click();
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

  it('e. 詳細ページの「このセッションの指示文と skill」から、そのセッションで使われた版だけに絞った指示文のページを開き、「すべて表示」で戻せる', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string; instructions: unknown[]; availableSkills?: unknown[] | null }[] };
    const id = s.sessions.find((x) => x.instructions.length > 0 && x.availableSkills)!.id;
    await page.goto(new URL(`sessions/${id}.html`, server.url).href);
    // 使えた skill の表(呼んでいない unused-skill も出る)
    expect(await page.getByTestId('session-skills').innerText()).toContain('unused-skill');
    await page.locator('a:visible', { hasText: 'このセッションの指示文と skill' }).first().click();
    await page.waitForURL(`**/instructions.html#session=${id}`);
    const banner = page.getByTestId('lib-filter');
    await expect.poll(() => banner.isVisible()).toBe(true);
    const visible = (): Promise<number> => page.locator('.lib-group:visible').count();
    const all = await page.locator('.lib-group').count();
    const shown = await visible();
    expect(shown).toBeGreaterThan(0);
    // 他のセッションだけで使われた版(fixture の他の指示文・skill)は隠れる
    expect(shown).toBeLessThan(all);
    for (const v of await page.locator('details.ver:visible').all()) expect((await v.getAttribute('data-sessions'))!.split(' ')).toContain(id);
    // 同じ項目の中でも、このセッションが使っていない版は隠れる(fixture の「Synthetic Instructions」は 2 版、このセッションは 1 版目だけ)
    const synth = page.locator('.lib-group', { has: page.getByRole('heading', { name: 'Synthetic Instructions' }) });
    expect(await synth.locator('details.ver').count()).toBe(2);
    expect(await synth.locator('details.ver:visible').count()).toBe(1);
    expect(await banner.innerText()).toContain('だけを表示しています');
    await banner.getByRole('link', { name: 'すべて表示' }).click();
    await expect.poll(visible).toBe(all);
    expect(await banner.isVisible()).toBe(false);
    expect(new URL(page.url()).hash).toBe('');
    // 戻る先の詳細ページへのリンク
    await page.goto(new URL(`instructions.html#session=${id}`, server.url).href);
    await banner.getByRole('link', { name: 'セッションの詳細に戻る' }).click();
    await page.waitForURL(`**/sessions/${id}.html`);
  });

  it('f. 絞り込み中に隠れた版へのリンクを押すと、絞り込みを外してその版を開いて見せる。版の無いセッションにはリンクを出さず、開いても説明を出す', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string; instructions: unknown[]; availableSkills?: unknown[] | null }[] };
    const id = s.sessions.find((x) => x.instructions.length > 0 && x.availableSkills)!.id;
    await page.goto(new URL(`instructions.html#session=${id}`, server.url).href);
    const banner = page.getByTestId('lib-filter');
    await expect.poll(() => banner.isVisible()).toBe(true);
    const synth = page.locator('.lib-group', { has: page.getByRole('heading', { name: 'Synthetic Instructions' }) });
    // 絞り込み中だけ、このセッションで使った版を見出しに出す(このセッションは 1 版目だけ)
    expect(await synth.locator('.in-session').innerText()).toBe('このセッションで使った版: 版 1');
    // 隠れている版 2 へ: 見出しの「最後の版」の行にリンクがあれば押し、無ければページ内のリンクと同じく hash を変える
    const hidden = synth.locator('details.ver[hidden]');
    expect(await hidden.count()).toBe(1);
    const target = (await hidden.getAttribute('id'))!;
    const link = synth.locator(`.latest a[href="#${target}"]`);
    if (await link.count()) await link.first().click();
    else await page.evaluate(`location.hash = ${JSON.stringify(`#${target}`)}`);
    await expect.poll(() => banner.isVisible()).toBe(false);
    // tsconfig に DOM の型が無いので、ブラウザ側の式は文字列で渡す
    await expect.poll(() => page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(target)}); return e.open && !e.hidden; })()`)).toBe(true);
    await expect.poll(() => page.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(target)}).getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()`)).toBe(true);
    expect(await synth.locator('.in-session').isVisible()).toBe(false);

    // 指示文も skill の本文も無いセッション: 詳細ページに絞り込みのリンクを出さず、直接開いても説明を出す
    const names = JSON.parse((await page.locator('#lib-sessions').textContent())!) as Record<string, unknown>;
    const none = s.sessions.find((x) => !(x.id in names));
    expect(none, 'fixture に指示文も skill の本文も無いセッションがある').toBeTruthy();
    await page.goto(new URL(`sessions/${none!.id}.html`, server.url).href);
    expect(await page.locator(`a[href*="#session="]`).count()).toBe(0);
    await page.goto(new URL(`instructions.html#session=${none!.id}`, server.url).href);
    await expect.poll(() => banner.innerText()).toContain('表示するものがありません');
    expect(await page.locator('.lib-group:visible').count()).toBe(0);
    await banner.getByRole('link', { name: 'セッションの詳細に戻る' }).click();
    await page.waitForURL(`**/sessions/${none!.id}.html`);
  });
});
