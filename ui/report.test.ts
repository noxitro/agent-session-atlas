// 画面の操作の検査(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
// e2e/ は生成した HTML の文字列と API を見る。ここは Svelte の画面と詳細ページの素の script が、ブラウザで動くかを見る。
//  a. 一覧でチェック → 「選んだ N 件だけ集計」で表示中の件数が変わり、「選択を解除」で戻る
//  b. グループを作成 → groups.json に書かれる → サイドバーで選ぶと絞り込まれる → 削除で消える
//  c. 詳細ページでメモを書いて保存 → atlas-notes/memos に書かれ、再読み込みしても表示される
//  d. 用語ページへのリンクで移動でき、パンくずで戻れる
//  (a・b の中で)「工程と詰まり」は絞り込みに合わせて集計し直す。グループの「書き出す」で out/groups/<名前>/ に表ができる
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { startServe, type ServeHandle } from '../packages/cli/src/serve.ts';
import { buildFixtureHome, ROOT } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const MEMO = 'UI テストのメモ KESTREL-MEMO';

describe('画面の操作', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const groupsPath = join(notes, 'groups.json');
  const configPath = join(WORK, 'atlas.config.json');
  /** フォルダを選ぶ画面の代わりに返す答え(null は取り消し) */
  let pickAnswer: string | null = null;
  const opened: string[] = [];
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
    // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を書き換えない)。フォルダを選ぶ画面は出さずに pickAnswer を返す
    server = await startServe({
      outDir: out,
      notesDir: notes,
      groupsPath,
      port: 0,
      open: false,
      idleMs: 600_000,
      firstHeartbeatMs: 600_000,
      configPath,
      folders: { canPick: true, pick: async () => pickAnswer, open: (d) => opened.push(d) },
      // 設定の skill の候補は架空の fixture から出す(手元の ~/.copilot に左右されないように)
      copilotHome: home,
    });
    browser = await chromium.launch();
    // 1440px: サイドバー(768px 以上)にグループの一覧が出る幅
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // CI の遅い機械を手元でまねる(例: ATLAS_UI_CPU_SLOWDOWN=20 npm run ui。docs/development.md)
    const slow = Number(process.env.ATLAS_UI_CPU_SLOWDOWN ?? 0);
    if (slow > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: slow });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    // サーバの内部エラーは本文(原因の文言)も残す。console の「500」だけでは何が失敗したか分からない
    page.on('response', async (r) => {
      if (r.status() >= 500) problems.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}: ${await r.text().catch(() => '(本文を読めず)')}`);
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close('テスト終了');
    await close?.();
  });
  // 落ちたらその時点の画面を out/ui-failures/ に残す(CI は成果物として上げる)
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    // 次のテストに持ち越さない(1 件の失敗で後のテストがすべて落ちて、どこで起きたか分からなくならないように)
    expect(problems.splice(0)).toEqual([]);
  });

  const shown = async (): Promise<number> => Number((await page.getByTestId('shown-count').innerText()).replace(/,/g, ''));
  const rowChecks = () => page.locator('#sessions table.ledger tbody input[type="checkbox"]');
  // グループの一覧はサイドバーと狭い幅の一覧の 2 か所にあるので、見えている方を使う
  const rail = () => page.locator('[data-testid="group-rail"]:visible');
  /** 開いた欄は requestAnimationFrame で焦点を移す(作成欄は名前へ、見出しの編集は名前を選ぶ)。移る前に打つと、遅い CI では打つ途中で焦点が移り、別の欄の文字が名前に入る */
  const focusLands = (l: Locator): Promise<void> => expect.poll(() => l.evaluate((el) => el.matches(':focus'))).toBe(true);
  const readGroups = async (): Promise<{ name: string; note?: string; ids: string[] }[]> => (existsSync(groupsPath) ? JSON.parse(await readFile(groupsPath, 'utf8')).groups : []);

  it('a. 一覧でチェックした件数だけで集計し、解除すると元に戻る', async () => {
    await page.goto(server.url);
    const all = await shown();
    expect(all).toBeGreaterThan(2);
    // 「工程と詰まり」の合計の依頼数(絞り込みに合わせて集計し直す)
    const turnsTotal = async (): Promise<number> => Number((await page.getByTestId('phase-table').locator('tfoot td').first().innerText()).replace(/[^0-9]/g, ''));
    const turnsAll = await turnsTotal();
    expect(turnsAll).toBeGreaterThan(0);
    await rowChecks().nth(0).check();
    await rowChecks().nth(1).check();
    await expect.poll(() => page.getByTestId('selected-count').innerText()).toBe('2');
    await page.getByTestId('apply-selection').click();
    await expect.poll(shown).toBe(2);
    await expect.poll(turnsTotal).toBeLessThan(turnsAll);
    await page.getByRole('button', { name: '選択を解除' }).click();
    await expect.poll(shown).toBe(all);
    await expect.poll(turnsTotal).toBe(turnsAll);
    await expect.poll(() => page.getByTestId('selected-count').innerText()).toBe('0');
  });

  it('b. グループを作成して選ぶと絞り込まれ、本文の見出しで名前と説明を直せて、削除すると groups.json からも消える', async () => {
    await page.goto(server.url);
    await rowChecks().nth(0).check();
    await rowChecks().nth(2).check();
    await page.getByTestId('add-to-group').click();
    await page.getByTestId('create-group').click();
    const form = page.getByTestId('create-form');
    await focusLands(form.getByPlaceholder('例: 11 月の調査'));
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
    await focusLands(head.getByLabel('名前'));
    await head.getByLabel('名前').fill('画面のテスト2');
    await head.getByLabel('説明(任意)').fill('見出しから直した');
    await head.getByRole('button', { name: '保存' }).click();
    await expect.poll(async () => (await readGroups()).map((g) => [g.name, (g as { note?: string }).note])).toEqual([['画面のテスト2', '見出しから直した']]);
    await expect.poll(() => head.getByRole('heading').innerText()).toMatch(/画面のテスト2/);
    expect(new URL(page.url()).hash).toContain('group=' + encodeURIComponent('画面のテスト2'));
    expect(await shown()).toBe(2);
    // 書き出す: そのグループの表・集計・記録が out/groups/<名前>/ にでき、場所が出る
    await head.getByTestId('group-export').click();
    await expect.poll(() => head.getByTestId('group-exported').innerText()).toMatch(/2 セッション・\d+ 依頼/);
    expect(existsSync(join(out, 'groups', '画面のテスト2', 'turns.csv'))).toBe(true);
    expect(await head.getByTestId('group-exported').locator('code').innerText()).toBe(join(out, 'groups', '画面のテスト2'));
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
      await focusLands(form.getByPlaceholder('例: 11 月の調査'));
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
    await expect.poll(() => groupsLine(2).innerText()).toBe('タスクタグ: 甲、乙');
    expect(await groupsLine(0).innerText()).toBe('タスクタグ: 甲');

    // 詳細ページにもタスクタグが出て、ここで付け外しできる(今あるタグに足す・新しく作る・外す)
    await page.goto(new URL(`sessions/${id2}.html`, server.url).href);
    const line = page.getByTestId('detail-groups');
    await line.waitFor({ state: 'visible' });
    const tagNames = async (): Promise<string[]> => line.locator('.tag a').allInnerTexts();
    expect(await tagNames()).toEqual(['甲', '乙']);
    // 候補の一覧(datalist)付きの入力欄なので役割は combobox。ラベルで探す
    const tagInput = line.getByLabel('付けるタスクタグ');
    // 新しいタグを作って付ける
    await tagInput.fill('丙タグ');
    await line.getByRole('button', { name: '付ける' }).click();
    await expect.poll(tagNames).toEqual(['甲', '乙', '丙タグ']);
    expect((await readGroups()).find((g) => g.name === '丙タグ')?.ids).toEqual([id2]);
    await expect.poll(() => line.locator('.tag-msg').innerText()).toBe('「丙タグ」を付けました');
    // 外す(タグは 0 件で残る)。焦点は入力欄へ
    await line.getByRole('button', { name: 'タスクタグ「丙タグ」を外す' }).click();
    await expect.poll(tagNames).toEqual(['甲', '乙']);
    expect((await readGroups()).find((g) => g.name === '丙タグ')?.ids).toEqual([]);
    await focusLands(tagInput);
    // 今あるタグ(甲)を別のセッションに付けると、ids に足す(作り直さない)
    await page.goto(new URL(`sessions/${id1}.html`, server.url).href);
    await line.waitFor({ state: 'visible' });
    await expect.poll(tagNames).toEqual(['甲']);
    await tagInput.fill('乙');
    await line.getByRole('button', { name: '付ける' }).click();
    await expect.poll(tagNames).toEqual(['甲', '乙']);
    expect((await sorted())['乙']).toEqual([id1, id2].sort());
    await line.getByRole('button', { name: 'タスクタグ「乙」を外す' }).click();
    await expect.poll(tagNames).toEqual(['甲']);
    // 名前からそのタグで絞り込んだレポートに移れる
    await page.goto(new URL(`sessions/${id2}.html`, server.url).href);
    await line.waitFor({ state: 'visible' });
    await line.getByRole('link', { name: '乙' }).click();
    await page.waitForURL('**/atlas.html#group=*');
    await expect.poll(shown).toBe(1);

    // 後片付け(後のテストに残さない)
    for (const name of ['甲', '乙', '丙タグ']) {
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
      const nameBox = form.getByPlaceholder('例: 11 月の調査');
      await focusLands(nameBox);
      await nameBox.fill(name);
      await form.getByLabel('説明(任意)').fill(`${name}の説明`);
      // 押す前に入力が残っていることを確かめる(CI で 1 度、作成されずに待ちが切れた。原因を絞れるよう、どこで止まったかを出す)
      expect(await nameBox.inputValue(), '作成を押す前に名前の入力が消えた').toBe(name);
      await form.getByRole('button', { name: '作成' }).click();
      await expect
        .poll(async () => {
          if ((await readGroups()).some((g) => g.name === name)) return 'created';
          const err = (await form.locator('#create-error').count()) ? await form.locator('#create-error').innerText() : '';
          return err ? `作成の失敗: ${err}` : (await form.count()) ? '入力欄が開いたまま' : '入力欄が閉じたのに groups.json に無い';
        })
        .toBe('created');
    };
    await create([0], '丙');
    await rail().getByRole('button', { name: 'すべて', exact: true }).click();
    await create([1], '丁');
    const head = page.getByTestId('group-head');

    // 編集を開いたまま一覧から別のグループに足しても(グループの一覧が作り直されても)、打ちかけた名前は残る
    await head.getByTestId('group-edit').click();
    await focusLands(head.getByLabel('名前'));
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
    // 画面内かは 1px の余裕を持たせる(動きを減らす設定ではすぐに飛び、上端が -0.08px のような端数になる。CI の Windows がそれ)
    await expect.poll(() => page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(target)}); return e.open && !e.hidden; })()`)).toBe(true);
    await expect.poll(() => page.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(target)}).getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight; })()`)).toBe(true);
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

  it('g. グループのアップロード: 先が未定なら記入欄が開き、選ぶと設定に書いてそのまま写す。2 回目は置き換え、写した先を開ける', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const ids = s.sessions.map((x) => x.id).filter((id) => existsSync(join(out, 'snapshot', 'session-state', id))).slice(0, 2);
    expect(ids).toHaveLength(2);
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const name = 'アップ/テスト';
    await mkdir(notes, { recursive: true });
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name, note: '画面から写す', ids }] }));
    const root = join(WORK, 'atlas-logs');
    await mkdir(root, { recursive: true });
    const dest = join(root, 'アップ_テスト');
    try {
      await page.goto(`${server.url}#group=${encodeURIComponent(name)}`);
      const head = page.getByTestId('group-head');
      await expect.poll(() => head.getByTestId('group-upload-dest').innerText()).toMatch(/まだ決まっていません/);
      // 先が未定のまま「アップロード」→ 記入欄が開き、焦点は「エクスプローラーで選ぶ…」
      await head.getByTestId('group-upload').click();
      const form = head.getByRole('form', { name: 'アップロード先' });
      await expect.poll(() => form.isVisible()).toBe(true);
      const focused = (): Promise<string | null> => page.evaluate<string | null>('document.activeElement?.textContent ?? null');
      await expect.poll(focused).toBe('エクスプローラーで選ぶ…');
      // 取り消したら何も変えず、記入欄に残る
      pickAnswer = null;
      await form.getByRole('button', { name: 'エクスプローラーで選ぶ…' }).click();
      await expect.poll(() => form.getByRole('button', { name: 'エクスプローラーで選ぶ…' }).isVisible()).toBe(true);
      expect(existsSync(configPath)).toBe(false);
      // 無いフォルダを入力すると理由が出て、設定は書かない
      await form.getByLabel('フォルダ(フルパス)').fill(join(WORK, 'no-such-dir'));
      await form.getByRole('button', { name: '入力したパスにする' }).click();
      await expect.poll(() => head.getByRole('alert').innerText()).toMatch(/フォルダが見つかりません/);
      expect(existsSync(configPath)).toBe(false);
      // この 400 は想定どおり(ブラウザがコンソールに出す分は問題から外す)
      const bad = problems.findIndex((p) => p.includes('status of 400'));
      expect(bad).toBeGreaterThanOrEqual(0);
      problems.splice(bad, 1);
      // 選ぶと設定に書き、写す前の確認が出る(送り先を見せる。焦点は「写す」)。写すと結果が出る
      pickAnswer = root;
      await form.getByRole('button', { name: 'エクスプローラーで選ぶ…' }).click();
      const confirm = head.getByTestId('group-upload-confirm');
      await expect.poll(() => confirm.isVisible()).toBe(true);
      expect(await head.getByTestId('group-upload-confirm-dest').locator('code').innerText()).toBe(`${dest}${sep}`);
      await focusLands(confirm.getByRole('button', { name: '写す', exact: true }));
      await page.keyboard.press('Enter');
      await expect.poll(() => head.getByTestId('group-uploaded').innerText(), { timeout: 15_000 }).toMatch(/アップロードしました.2 セッション.*README\.md/);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: root });
      expect(await head.getByTestId('group-upload-dest').locator('code').innerText()).toBe(`${dest}${sep}`);
      expect(await head.getByTestId('group-uploaded').locator('code').innerText()).toBe(dest);
      for (const id of ids) expect(existsSync(join(dest, id, 'events.jsonl'))).toBe(true);
      expect(await readFile(join(dest, 'README.md'), 'utf8')).toMatch(/^# アップ\/テスト\n\n画面から写す\n/);
      // 2 回目も確かめてから写す(置き換えの件数を見せる)
      await head.getByTestId('group-upload').click();
      await expect.poll(() => confirm.innerText()).toMatch(/うち 2 件は前に写したものを置き換えます/);
      await confirm.getByRole('button', { name: '写す', exact: true }).click();
      await expect.poll(() => head.getByTestId('group-uploaded').innerText()).toMatch(/うち 2 件は前に写したものを置き換え/);
      // 写した先を開く(エクスプローラーの代わりに記録)
      await head.getByTestId('group-upload-open').click();
      await expect.poll(() => opened).toEqual([dest]);
      // 「場所を変える…」の記入欄は Esc で閉じ、焦点は「アップロード」に戻る(何も変えない)
      await head.getByTestId('group-upload-root').click();
      await expect.poll(focused).toBe('エクスプローラーで選ぶ…');
      await page.keyboard.press('Escape');
      await expect.poll(() => form.count()).toBe(0);
      await expect.poll(() => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null")).toBe('group-upload');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: root });
    } finally {
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
    }
  });

  it('g2. 写す前の確認: 秘密らしい文字列があれば確認を出し(焦点は「やめる」)、Esc でやめると何も写さない。「それでも写す」で写す', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const id = s.sessions.map((x) => x.id).find((x) => existsSync(join(out, 'snapshot', 'session-state', x)))!;
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const beforeConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const name = '秘密の確認';
    const root = join(WORK, 'atlas-logs-secret');
    const secret = join(out, 'snapshot', 'session-state', id, 'files', 'ui-secret.txt');
    await mkdir(root, { recursive: true });
    await mkdir(notes, { recursive: true });
    await mkdir(join(out, 'snapshot', 'session-state', id, 'files'), { recursive: true });
    // トークンの形をソースに直書きしない
    await writeFile(secret, `token=${['ghp', 'UITESTFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'].join('_')}\n`);
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name, note: '', ids: [id] }] }));
    try {
      // # だけが違う URL への goto はページ内の移動になり、前のテストのグループの一覧で読まれる(無いグループとして # が消える)。いったん外へ移ってから開く
      await page.goto('about:blank');
      await page.goto(`${server.url}#group=${encodeURIComponent(name)}`);
      const head = page.getByTestId('group-head');
      await expect.poll(() => head.getByTestId('group-upload-dest').innerText()).toContain(root);
      await head.getByTestId('group-upload').click();
      const confirm = head.getByTestId('group-upload-confirm');
      await expect.poll(() => confirm.isVisible()).toBe(true);
      expect(await head.getByTestId('group-upload-secrets').innerText()).toMatch(/秘密らしい文字列が 1 件あります.GitHub トークン 1.[\s\S]*files\/ui-secret\.txt 1 件/);
      await focusLands(confirm.getByRole('button', { name: 'やめる' }));
      await page.keyboard.press('Escape');
      await expect.poll(() => confirm.count()).toBe(0);
      await expect.poll(() => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null")).toBe('group-upload');
      expect(existsSync(join(root, name))).toBe(false);
      // もう一度押して「それでも写す」
      await head.getByTestId('group-upload').click();
      await confirm.getByRole('button', { name: 'それでも写す' }).click();
      await expect.poll(() => head.getByTestId('group-uploaded').innerText(), { timeout: 15_000 }).toMatch(/アップロードしました.1 セッション/);
      expect(existsSync(join(root, name, id, 'files', 'ui-secret.txt'))).toBe(true);
    } finally {
      await rm(secret, { force: true });
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
      if (beforeConfig == null) await rm(configPath, { force: true });
      else await writeFile(configPath, beforeConfig);
    }
  });

  it('g3. ほかのページにいる間に終わったアップロードは、戻った見出しに結果を出す(失敗なら理由)', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const id = s.sessions.map((x) => x.id).find((x) => existsSync(join(out, 'snapshot', 'session-state', x)))!;
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const beforeConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const name = '戻った見出し';
    const root = join(WORK, 'atlas-logs-resume');
    await mkdir(root, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name, note: '', ids: [id] }] }));
    try {
      // 一覧(このタグを選んでいない)から写し始め、終わってからそのタグを開く = 写している間はほかのページにいた
      await page.goto('about:blank');
      await page.goto(server.url);
      const status = await page.evaluate<number>(
        `fetch('api/groups/' + encodeURIComponent(${JSON.stringify(name)}) + '/upload', { method: 'POST', headers: { 'x-atlas-token': document.querySelector('meta[name="atlas-token"]').content } }).then((r) => r.status)`,
      );
      expect(status).toBe(200);
      await page.goto('about:blank');
      await page.goto(`${server.url}#group=${encodeURIComponent(name)}`);
      const head = page.getByTestId('group-head');
      await expect.poll(() => head.getByTestId('group-uploaded').innerText()).toMatch(/アップロードしました.1 セッション/);
    } finally {
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
      if (beforeConfig == null) await rm(configPath, { force: true });
      else await writeFile(configPath, beforeConfig);
    }
  });

  it('g4. 写している途中にタスクタグを切り替える: 切り替えた先では写しているタグの名前を出して写せなくし、写し終えた後に戻ると結果を出す(「すべて」へ外して戻っても同じ)', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const ids = s.sessions.map((x) => x.id).filter((x) => existsSync(join(out, 'snapshot', 'session-state', x)));
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const beforeConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const [a, b] = ['切り替え元', '切り替え先'];
    const root = join(WORK, 'atlas-logs-switch');
    // 前の実行の残りを持ち込まない(2 回目以降が置き換えの結果になる)
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name: a, note: '', ids: [ids[0]] }, { name: b, note: '', ids: [ids[1]] }] }));
    // 写す要求の答えを、合図があるまで画面に返さない(サーバは写し終えているが、画面はまだ写している途中 = 大きなログを写している間と同じ)
    let release: () => void = () => {};
    const held = (): Promise<void> => new Promise((r) => (release = r));
    const uploadUrl = `**/api/groups/${encodeURIComponent(a)}/upload`;
    try {
      for (const away of ['tag', 'all'] as const) {
        const gate = held();
        await page.route(uploadUrl, async (route) => {
          const response = await route.fetch();
          await gate;
          await route.fulfill({ response });
        });
        await page.goto('about:blank');
        await page.goto(`${server.url}#group=${encodeURIComponent(a)}`);
        const head = page.getByTestId('group-head');
        await head.getByTestId('group-upload').click();
        const confirm = head.getByTestId('group-upload-confirm');
        await expect.poll(() => confirm.isVisible()).toBe(true);
        await confirm.getByRole('button', { name: '写す', exact: true }).click();
        await expect.poll(() => head.getByTestId('group-upload').innerText()).toBe('アップロード中…');
        if (away === 'tag') {
          // 別のタグへ: 写しているタグの名前を出し、このタグは写せない
          await rail().getByRole('button', { name: new RegExp(b) }).click();
          await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
          expect(await head.getByTestId('group-upload-elsewhere').innerText()).toContain(`「${a}」をアップロードしています`);
          expect(await head.getByTestId('group-upload').getAttribute('aria-disabled')).toBe('true');
          expect(await head.getByTestId('group-uploaded').count()).toBe(0);
        } else {
          // 「すべて」へ外す(見出しが消える)
          await rail().getByRole('button', { name: 'すべて', exact: true }).click();
          await expect.poll(() => page.getByTestId('group-head').count()).toBe(0);
        }
        // 写し終える(画面に答えが届く)。切り替えた先に結果は出さない
        release();
        if (away === 'tag') {
          // 終わったことだけを知らせ、結果の中身は写したタグを開くと出す
          await expect.poll(() => head.getByTestId('group-upload-elsewhere-done').innerText()).toMatch(new RegExp(`「${a}」のアップロードが終わりました.1 セッション.。詳しくは「${a}」を開くと出ます`));
          expect(await head.getByTestId('group-upload-elsewhere').count()).toBe(0);
          expect(await head.getByTestId('group-uploaded').count()).toBe(0);
          expect(await head.getByTestId('group-upload').getAttribute('aria-disabled')).toBe('false');
        } else await page.waitForTimeout(300);
        // 戻ると、写したタグの見出しに結果を出す
        await rail().getByRole('button', { name: new RegExp(a) }).click();
        await expect.poll(() => page.getByTestId('group-head').locator('h2 .name').innerText()).toBe(a);
        await expect.poll(() => page.getByTestId('group-head').getByTestId('group-uploaded').innerText(), { timeout: 5000 }).toMatch(/アップロードしました.1 セッション/);
        if (away === 'tag') {
          // 同じ結果は 1 回だけ: もう一度切り替えて戻っても出さない
          await rail().getByRole('button', { name: new RegExp(b) }).click();
          await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
          await rail().getByRole('button', { name: new RegExp(a) }).click();
          await expect.poll(() => head.locator('h2 .name').innerText()).toBe(a);
          await page.waitForTimeout(300);
          expect(await head.getByTestId('group-uploaded').count()).toBe(0);
        }
        await page.unroute(uploadUrl);
      }
    } finally {
      release();
      await page.unroute(uploadUrl);
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
      if (beforeConfig == null) await rm(configPath, { force: true });
      else await writeFile(configPath, beforeConfig);
    }
  });

  it('g5. 切り替えた先で失敗の知らせを出し、そのタグ自身の直近の結果も出す。知らせの後にそのタグで写すと、知らせを消して進み具合を出す。戻ると失敗の理由を出す', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const ids = s.sessions.map((x) => x.id).filter((x) => existsSync(join(out, 'snapshot', 'session-state', x)));
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const beforeConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const [a, b] = ['失敗する側', '見ている側'];
    const root = join(WORK, 'atlas-logs-switch-fail');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name: a, note: '', ids: [ids[0]] }, { name: b, note: '', ids: [ids[1]] }] }));
    /** 写す要求の答えを、合図があるまで画面に返さない */
    const hold = async (name: string): Promise<{ url: string; release: () => void }> => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const url = `**/api/groups/${encodeURIComponent(name)}/upload`;
      await page.route(url, async (route) => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      });
      return { url, release: () => release() };
    };
    const held: { url: string; release: () => void }[] = [];
    try {
      // 見ている側のタグは、ほかのページで写してあり、まだ結果を見ていない
      await page.goto('about:blank');
      await page.goto(server.url);
      const status = await page.evaluate<number>(
        `fetch('api/groups/' + encodeURIComponent(${JSON.stringify(b)}) + '/upload', { method: 'POST', headers: { 'x-atlas-token': document.querySelector('meta[name="atlas-token"]').content } }).then((r) => r.status)`,
      );
      expect(status).toBe(200);
      await page.goto('about:blank');
      await page.goto(`${server.url}#group=${encodeURIComponent(a)}`);
      const head = page.getByTestId('group-head');
      await head.getByTestId('group-upload').click();
      const confirm = head.getByTestId('group-upload-confirm');
      await expect.poll(() => confirm.isVisible()).toBe(true);
      // 確かめた後に、送り先のタグのフォルダの場所にファイルを置いて、写すのを失敗させる
      await writeFile(join(root, a), 'ふさぐ');
      held.push(await hold(a));
      await confirm.getByRole('button', { name: '写す', exact: true }).click();
      await expect.poll(() => head.getByTestId('group-upload').innerText()).toBe('アップロード中…');
      await rail().getByRole('button', { name: new RegExp(b) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
      expect(await head.getByTestId('group-upload-elsewhere').innerText()).toContain(`「${a}」をアップロードしています`);
      // 失敗が届くと、失敗の知らせ(読み上げにも入る)と、見ている側のタグ自身の直近の結果を出す
      held[0]!.release();
      // 失敗のときは「開くと出ます」と言わない(サーバが覚えない失敗もある)。理由は知らせに入れる
      await expect.poll(() => head.getByTestId('group-upload-elsewhere-done').innerText()).toMatch(new RegExp(`^「${a}」をアップロードできませんでした(.+)。$`));
      expect(await head.getByTestId('group-upload-elsewhere-done').innerText()).not.toContain('詳しくは');
      expect(await head.getByTestId('group-upload-elsewhere-done').getAttribute('class')).toContain('bad');
      await expect.poll(() => head.getByTestId('group-upload-elsewhere-status').innerText()).toContain(`「${a}」をアップロードできませんでした`);
      await expect.poll(() => head.getByTestId('group-uploaded').innerText()).toMatch(/アップロードしました.1 セッション/);
      const bad = problems.findIndex((p) => p.includes('status of 409'));
      expect(bad).toBeGreaterThanOrEqual(0);
      problems.splice(bad, 1);
      // 知らせが出たまま、このタグで写す: 知らせを消して、このタグの進み具合を出す
      held.push(await hold(b));
      await head.getByTestId('group-upload').click();
      await expect.poll(() => confirm.isVisible()).toBe(true);
      await confirm.getByRole('button', { name: '写す', exact: true }).click();
      await expect.poll(() => head.getByTestId('group-upload-progress').isVisible()).toBe(true);
      expect(await head.getByTestId('group-upload-elsewhere-done').count()).toBe(0);
      held[1]!.release();
      await expect.poll(() => head.getByTestId('group-uploaded').innerText()).toMatch(/うち 1 件は前に写したものを置き換え/);
      expect(await head.getByTestId('group-upload-elsewhere-done').count()).toBe(0);
      // 失敗した側へ戻ると、失敗の理由を出す
      await rail().getByRole('button', { name: new RegExp(a) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(a);
      await expect.poll(() => head.getByRole('alert').innerText()).toMatch(/アップロードできませんでした/);
    } finally {
      for (const h of held) {
        h.release();
        await page.unroute(h.url);
      }
      await rm(join(root, a), { force: true });
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
      if (beforeConfig == null) await rm(configPath, { force: true });
      else await writeFile(configPath, beforeConfig);
    }
  });

  it('g6. 戻って続きを待っているアップロードも切り替えた先に知らせ、戻ると結果を出す。確かめている間に切り替えても前のタグの確認を出さず、編集している間に終わっても欄の誤りにしない', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const ids = s.sessions.map((x) => x.id).filter((x) => existsSync(join(out, 'snapshot', 'session-state', x)));
    const before = existsSync(groupsPath) ? await readFile(groupsPath, 'utf8') : null;
    const beforeConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const [a, b] = ['続きを待つ側', '切り替えた側'];
    const enc = encodeURIComponent;
    const root = join(WORK, 'atlas-logs-switch-resume');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    await writeFile(groupsPath, JSON.stringify({ version: 1, groups: [{ name: a, note: '', ids: [ids[0]] }, { name: b, note: '', ids: [ids[1]] }] }));
    const routes: string[] = [];
    const gates: (() => void)[] = [];
    /** その要求の答えを、合図があるまで画面に返さない */
    const hold = async (url: string): Promise<() => void> => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      routes.push(url);
      gates.push(() => release());
      await page.route(url, async (route) => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      });
      return () => release();
    };
    const post = (name: string): Promise<number> =>
      page.evaluate<number>(`fetch('api/groups/' + encodeURIComponent(${JSON.stringify(name)}) + '/upload', { method: 'POST', headers: { 'x-atlas-token': document.querySelector('meta[name="atlas-token"]').content } }).then((r) => r.status)`);
    try {
      const head = page.getByTestId('group-head');
      // 1. ほかのページで写し始めたアップロードの続きを待っている(進み具合の答えを、合図があるまで「写している途中」にする)
      await page.goto('about:blank');
      await page.goto(server.url);
      expect(await post(a)).toBe(200);
      let writing = true;
      const progressUrl = `**/api/groups/${enc(a)}/upload/progress`;
      routes.push(progressUrl);
      await page.route(progressUrl, (route) =>
        writing ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: 1, done: 0, bytes: 100, copied: 40, current: null }) }) : route.continue(),
      );
      await page.goto('about:blank');
      await page.goto(`${server.url}#group=${enc(a)}`);
      await expect.poll(() => head.getByTestId('group-upload-progress').isVisible()).toBe(true);
      await rail().getByRole('button', { name: new RegExp(b) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
      expect(await head.getByTestId('group-upload-elsewhere').innerText()).toContain(`「${a}」をアップロードしています`);
      writing = false;
      await expect.poll(() => head.getByTestId('group-upload-elsewhere-done').innerText()).toBe(`「${a}」のアップロードが終わりました(1 セッション)。詳しくは「${a}」を開くと出ます。`);
      await rail().getByRole('button', { name: new RegExp(a) }).click();
      await expect.poll(() => head.getByTestId('group-uploaded').innerText()).toMatch(/アップロードしました.1 セッション/);
      // 2. 確かめている間に切り替える: 切り替えた先に、前のタグの確認を出さない
      const releaseCheck = await hold(`**/api/groups/${enc(a)}/upload/check`);
      await head.getByTestId('group-upload').click();
      await expect.poll(() => head.getByTestId('group-upload').innerText()).toBe('確かめています…');
      await rail().getByRole('button', { name: new RegExp(b) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
      releaseCheck();
      await expect.poll(() => head.getByTestId('group-upload').innerText()).toBe('アップロード');
      await page.waitForTimeout(300);
      expect(await head.getByTestId('group-upload-confirm').count()).toBe(0);
      expect(await head.locator('h2 .name').innerText()).toBe(b);
      // 3. 切り替えた側には、まだ見ていない失敗の結果がある(ほかのページで写して失敗した)
      await writeFile(join(root, b), 'ふさぐ');
      expect(await post(b)).toBe(409);
      const bad = problems.findIndex((p) => p.includes('status of 409'));
      expect(bad).toBeGreaterThanOrEqual(0);
      problems.splice(bad, 1);
      // A を写している間に B で「編集」を開き、その間に A が終わる: B の失敗を編集の欄の誤りとして出さない
      await rail().getByRole('button', { name: new RegExp(a) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(a);
      const releaseUpload = await hold(`**/api/groups/${enc(a)}/upload`);
      await head.getByTestId('group-upload').click();
      const confirm = head.getByTestId('group-upload-confirm');
      await expect.poll(() => confirm.isVisible()).toBe(true);
      await confirm.getByRole('button', { name: '写す', exact: true }).click();
      await expect.poll(() => head.getByTestId('group-upload').innerText()).toBe('アップロード中…');
      await rail().getByRole('button', { name: new RegExp(b) }).click();
      await expect.poll(() => head.locator('h2 .name').innerText()).toBe(b);
      await head.getByTestId('group-edit').click();
      const form = head.getByRole('form', { name: 'タスクタグの編集' });
      await expect.poll(() => form.isVisible()).toBe(true);
      releaseUpload();
      await expect.poll(() => head.getAttribute('aria-busy')).toBe('false');
      await page.waitForTimeout(300);
      expect(await head.getByRole('alert').count()).toBe(0);
      expect(await form.getByRole('textbox').first().getAttribute('aria-invalid')).toBeNull();
    } finally {
      for (const g of gates) g();
      for (const u of routes) await page.unroute(u);
      await rm(join(root, b), { force: true });
      if (before == null) await rm(groupsPath, { force: true });
      else await writeFile(groupsPath, before);
      if (beforeConfig == null) await rm(configPath, { force: true });
      else await writeFile(configPath, beforeConfig);
    }
  });

  it('i. 戻る・進む: 詳細ページから戻るとスクロール位置と一覧の並べ替えが戻る。要点のリンクで絞り込んでから戻ると絞り込みが外れ、進むとまた絞り込む', async () => {
    await page.goto('about:blank');
    await page.goto(server.url);
    const all = await shown();
    // 一覧を「開始」の古い順に並べ替え、一覧の位置までスクロールしてから詳細ページへ
    const startHead = page.locator('#sessions table.ledger thead th', { has: page.getByRole('button', { name: /^開始/ }) });
    await startHead.getByRole('button').click();
    await expect.poll(() => startHead.getAttribute('aria-sort')).toBe('ascending');
    const firstName = async (): Promise<string> => page.locator('#sessions table.ledger tbody tr td.name a').first().innerText();
    const first = await firstName();
    await page.locator('#sessions').scrollIntoViewIfNeeded();
    await page.evaluate("window.scrollTo({ top: document.getElementById('sessions').getBoundingClientRect().top + window.scrollY - 40, behavior: 'instant' })");
    const y = await page.evaluate<number>('Math.round(window.scrollY)');
    expect(y).toBeGreaterThan(1000);
    await page.locator('#sessions table.ledger tbody tr td.name a').first().click();
    await page.waitForURL('**/sessions/*.html');
    await page.goBack();
    await page.waitForURL('**/atlas.html*');
    await expect.poll(() => page.evaluate<number>('Math.round(window.scrollY)')).toBe(y);
    expect(await startHead.getAttribute('aria-sort')).toBe('ascending');
    expect(await firstName()).toBe(first);
    // 要点の「このツールを使ったセッションに絞り込む→」は履歴に残る移動。戻ると絞り込みが外れ、進むとまた絞り込む
    await page.getByRole('link', { name: /このツールを使ったセッションに絞り込む/ }).first().click();
    await expect.poll(shown).toBeLessThan(all);
    const narrowed = await shown();
    await page.goBack();
    await expect.poll(shown).toBe(all);
    await page.goForward();
    await expect.poll(shown).toBe(narrowed);
  });

  it('h. サイドバーを出す幅: 1024px でもサイドバーにグループの一覧が出て、768px 未満(375px)は上部の 1 行の「グループ」から開く', async () => {
    try {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(server.url);
      await expect.poll(() => page.locator('.rail-groups').isVisible()).toBe(true);
      expect(await page.getByTestId('groups-toggle').isVisible()).toBe(false);
      await page.setViewportSize({ width: 375, height: 812 });
      await expect.poll(() => page.getByTestId('groups-toggle').isVisible()).toBe(true);
      expect(await page.locator('.rail-groups').isVisible()).toBe(false);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it('j. プロジェクト別の「まとめて送る」: 印を付けると設定の uploadProjects に書き(ほかの設定は残す)、再読み込みしても残る。外すと消える。書けなければ理由を出して印を戻す', async () => {
    const before = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const root = join(WORK, 'atlas-logs');
    await mkdir(root, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, 'utf8'));
    try {
      await page.goto(server.url);
      const section = page.locator('#projects');
      const note = section.locator('.send-note');
      await expect.poll(() => note.innerText()).toMatch(/今 0 件/);
      const row = section.locator('tbody tr').first();
      const key = decodeURIComponent((await row.locator('a.link').getAttribute('href'))!.replace(/^#project=/, ''));
      const box = row.getByRole('checkbox');
      expect(await box.getAttribute('aria-label')).toMatch(/を upload-project\.bat でまとめて送る$/);
      expect(await box.isChecked()).toBe(false);
      await box.check();
      await expect.poll(readConfig).toEqual({ uploadRoot: root, uploadProjects: [key] });
      await expect.poll(() => note.innerText()).toMatch(/今 1 件/);
      // 再読み込みしても印は残る(設定から読む)
      await page.reload();
      await expect.poll(() => section.locator('tbody tr').first().getByRole('checkbox').isChecked()).toBe(true);
      // 外すと設定から消える(空なら項目ごと消し、bat は番号で選ぶ)
      await section.locator('tbody tr').first().getByRole('checkbox').uncheck();
      await expect.poll(readConfig).toEqual({ uploadRoot: root });
      await expect.poll(() => note.innerText()).toMatch(/今 0 件/);
      // 設定ファイルが壊れていれば書き換えず、理由を出して印を戻す
      await writeFile(configPath, '{ 壊れた設定');
      const again = section.locator('tbody tr').first().getByRole('checkbox');
      await again.click();
      await expect.poll(() => section.getByRole('alert').innerText()).toMatch(/印を付けられませんでした.*読めないので書き換えません/);
      await expect.poll(() => again.isChecked()).toBe(false);
      expect(await readFile(configPath, 'utf8')).toBe('{ 壊れた設定');
      // この 409 は想定どおり(ブラウザがコンソールに出す分は問題から外す)
      const bad = problems.findIndex((p) => p.includes('status of 409'));
      expect(bad).toBeGreaterThanOrEqual(0);
      problems.splice(bad, 1);
      // 壊れたまま開き直すと、印を 0 件と見せずに理由を出し、押せないようにする
      await page.reload();
      await expect.poll(() => section.getByTestId('project-send-config-error').innerText()).toMatch(/設定ファイルを読めないので.*読めません/);
      expect(await section.locator('.send-note').count()).toBe(0);
      expect(await section.locator('tbody tr').first().getByRole('checkbox').isDisabled()).toBe(true);
    } finally {
      if (before == null) await rm(configPath, { force: true });
      else await writeFile(configPath, before);
    }
  });

  it('j2. 続けて印を付けたとき、先の答えが後から届いても、後の印を古い一覧で消さない', async () => {
    const before = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    await writeFile(configPath, '{}');
    let first = true;
    // 1 つ目の答えだけを遅らせる(サーバは先に書き終えているが、画面には 2 つ目の答えより後に届く)
    await page.route('**/api/upload-projects', async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ response });
    });
    try {
      await page.goto(server.url);
      const section = page.locator('#projects');
      await expect.poll(() => section.locator('.send-note').innerText()).toMatch(/今 0 件/);
      const rows = section.locator('tbody tr');
      const keyOf = async (i: number): Promise<string> => decodeURIComponent((await rows.nth(i).locator('a.link').getAttribute('href'))!.replace(/^#project=/, ''));
      const [a, b] = [await keyOf(0), await keyOf(1)];
      await rows.nth(0).getByRole('checkbox').click();
      await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).uploadProjects).toEqual([a]);
      await rows.nth(1).getByRole('checkbox').click();
      await expect.poll(async () => JSON.parse(await readFile(configPath, 'utf8')).uploadProjects).toEqual([a, b]);
      // 遅れた 1 つ目の答え([a])が届いた後も、両方に印が付いたまま
      await expect.poll(() => rows.nth(0).getByRole('checkbox').isEnabled()).toBe(true);
      await page.waitForTimeout(200);
      expect(await rows.nth(0).getByRole('checkbox').isChecked()).toBe(true);
      expect(await rows.nth(1).getByRole('checkbox').isChecked()).toBe(true);
      expect(await section.locator('.send-note').innerText()).toMatch(/今 2 件/);
    } finally {
      await page.unroute('**/api/upload-projects');
      if (before == null) await rm(configPath, { force: true });
      else await writeFile(configPath, before);
    }
  });

  it('k. 設定…: setup.bat を使わずに、vault(エクスプローラー・入力)・普段の工程名・アップロード先・まとめて送るプロジェクトを決められ、設定ファイルに書く。読めない設定では変えさせない', async () => {
    const before = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const vaultDir = join(WORK, 'vault-k');
    await mkdir(join(vaultDir, 'wiki'), { recursive: true });
    const root = join(WORK, 'atlas-logs-settings');
    await mkdir(root, { recursive: true });
    await writeFile(configPath, '{}');
    const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, 'utf8'));
    try {
      await page.goto('about:blank');
      await page.goto(server.url);
      const open = page.getByTestId('settings-open');
      await expect.poll(() => open.isVisible()).toBe(true);
      await open.click();
      const dlg = page.getByTestId('settings-dialog');
      const wiki = dlg.getByTestId('settings-wiki');
      await expect.poll(() => wiki.innerText()).toMatch(/まだありません/);
      // vault: エクスプローラーで選ぶ → 中を見て、ページは wiki/、index.md が無いので索引を尋ねる → 足す
      pickAnswer = vaultDir;
      await wiki.getByTestId('settings-vault-pick').click();
      const found = wiki.getByTestId('settings-vault-found');
      await expect.poll(() => found.innerText()).toMatch(/フォルダ名「vault-k」で足します/);
      expect(await found.getByLabel(/個別ページを置くフォルダ/).inputValue()).toBe('wiki');
      await found.getByLabel(/索引のファイル名/).fill('README.md');
      for (const box of await found.getByRole('checkbox').all()) await box.uncheck();
      await found.getByTestId('settings-vault-add').click();
      await expect.poll(readConfig).toEqual({ wikis: [{ path: 'vault-k', index: ['README.md'], pages: ['wiki'] }] });
      await expect.poll(() => wiki.getByTestId('settings-refresh').isVisible()).toBe(true);
      expect(await wiki.locator('.items li').first().innerText()).toMatch(/vault-k[\s\S]*ページ: wiki・索引: README\.md/);
      // 入力したフォルダ名(見つからない)も足せる。path だけなら文字列で書く
      await wiki.getByTestId('settings-vault-input').fill('notes-k');
      await wiki.getByRole('button', { name: '調べる' }).click();
      await expect.poll(() => wiki.getByTestId('settings-vault-found').innerText()).toMatch(/「notes-k」で足します.*フォルダが見つからない/);
      await wiki.getByTestId('settings-vault-found').getByLabel(/個別ページを置くフォルダ/).fill('.');
      for (const box of await wiki.getByTestId('settings-vault-found').getByRole('checkbox').all()) await box.uncheck();
      await wiki.getByTestId('settings-vault-add').click();
      await expect.poll(async () => (await readConfig()).wikis).toEqual([{ path: 'vault-k', index: ['README.md'], pages: ['wiki'] }, 'notes-k']);
      // 外す
      await wiki.getByRole('button', { name: 'vault「vault-k」を外す' }).click();
      await expect.poll(async () => (await readConfig()).wikis).toEqual(['notes-k']);
      // 普段の工程名: 保存 → 既定に戻す
      const phases = dlg.getByTestId('settings-phases');
      await phases.getByTestId('settings-phases-input').fill('設計 / 実装 / テスト');
      await phases.getByRole('button', { name: '保存' }).click();
      await expect.poll(async () => (await readConfig()).phases).toEqual(['設計', '実装', 'テスト']);
      expect(await phases.getByTestId('settings-phases-saved').innerText()).toBe('保存しました。');
      expect(await dlg.getByTestId('settings-status').innerText()).toBe('普段の工程名を保存しました。');
      await phases.getByRole('button', { name: '既定に戻す' }).click();
      await expect.poll(async () => 'phases' in (await readConfig())).toBe(false);
      // アップロード先: エクスプローラーで選ぶ
      pickAnswer = root;
      const rootSec = dlg.getByTestId('settings-root');
      await rootSec.getByTestId('settings-root-pick').click();
      await expect.poll(async () => (await readConfig()).uploadRoot).toBe(root);
      expect(await rootSec.getByTestId('settings-root-current').innerText()).toBe(root);
      // まとめて送るプロジェクト: 絞り込んで印を付ける・外す(プロジェクト別の表と同じ設定)
      const proj = dlg.getByTestId('settings-projects');
      const first = proj.locator('.checks li').first();
      const label = await first.locator('.pname').innerText();
      await proj.getByTestId('settings-projects-filter').fill(label.slice(0, Math.max(2, Math.floor(label.length / 2))));
      await expect.poll(() => proj.locator('.checks li').first().locator('.pname').innerText()).toBe(label);
      await proj.locator('.checks li').first().getByRole('checkbox').check();
      await expect.poll(async () => ((await readConfig()).uploadProjects as string[] | undefined)?.length ?? 0).toBe(1);
      await expect.poll(() => proj.locator('.note').first().innerText()).toMatch(/今 1 件/);
      await proj.locator('.checks li').first().getByRole('checkbox').uncheck();
      await expect.poll(async () => 'uploadProjects' in (await readConfig())).toBe(false);
      expect(await readConfig()).toEqual({ wikis: ['notes-k'], uploadRoot: root });
      // 閉じると焦点は「設定…」に戻る
      await dlg.getByTestId('settings-close').click();
      await expect.poll(() => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null")).toBe('settings-open');
      // 読めない設定では、理由を出して変えさせない
      await writeFile(configPath, '{ 壊れた');
      await open.click();
      await expect.poll(() => dlg.getByTestId('settings-config-error').innerText()).toMatch(/設定ファイルを読めないので/);
      expect(await dlg.getByTestId('settings-vault-input').isDisabled()).toBe(true);
      expect(await dlg.getByTestId('settings-phases-input').isDisabled()).toBe(true);
      await dlg.getByTestId('settings-close').click();
    } finally {
      if (before == null) await rm(configPath, { force: true });
      else await writeFile(configPath, before);
    }
  });
});
