// 画面の操作の検査(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
// e2e/ は生成した HTML の文字列と API を見る。ここは Svelte の画面と詳細ページの素の script が、ブラウザで動くかを見る。
//  a. 一覧でチェック → 「選んだ N 件だけ集計」で表示中の件数が変わり、「選択を解除」で戻る
//  a2. 一覧の検索(セッション ID・題名)で行が絞られ、上の集計は変わらない
//  c. 詳細ページでメモを書いて保存 → atlas-notes/memos に書かれ、再読み込みしても表示される
//  d. 用語ページへのリンクで移動でき、パンくずで戻れる
//  (a の中で)「工程と詰まり」は絞り込みに合わせて集計し直す
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { clickableFindings } from '../scripts/ui-audit.ts';
import { buildFixtureHome, ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui');
const MEMO = 'UI テストのメモ KESTREL-MEMO';

describe('画面の操作', () => {
  /** 架空の fixture の Copilot のデータの場所(設定の skill の候補もここから出す) */
  let home: string;
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const configPath = join(WORK, 'atlas.config.json');
  /** フォルダを選ぶ画面の代わりに返す答え(null は取り消し) */
  let pickAnswer: string | null = null;
  let close: () => Promise<void>;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const r = spawnSync(...cliCommand(['all', '--home', home, '--out', out, '--notes-dir', notes]), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    // テスト中に heartbeat が途切れても止まらないよう、猶予を長くとる
    // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を書き換えない)。フォルダを選ぶ画面は出さずに pickAnswer を返す
    server = await startServer({
      outDir: out,
      notesDir: notes,
      port: 0,
      open: false,
      idleMs: 600_000,
      firstHeartbeatMs: 600_000,
      configPath,
      folders: { canPick: true, pick: async () => pickAnswer },
      // 設定の skill の候補は架空の fixture から出す(手元の ~/.copilot に左右されないように)
      copilotHome: home,
    });
    browser = await chromium.launch();
    // 1440px: サイドバー(768px 以上)に目次が出る幅
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
  /** 本文のタブを開く(概況・内訳・一覧。ほかのタブの節は hidden で隠れていて押せない)。押すと履歴に積み、再読み込みしてもそのタブのまま */
  const openTab = async (t: 'overview' | 'breakdown' | 'list'): Promise<void> => {
    await page.getByTestId(`tab-${t}`).click();
    await expect.poll(() => page.locator(`[data-tab-panel="${t}"]`).isHidden()).toBe(false);
  };

  it('m. モデル別: 「推論強度で分ける」で モデル × 推論強度 の行になり、「モデルごと」で戻る。モデルごとの表には推論強度別のリクエストを出す', async () => {
    await page.goto(server.url);
    await openTab('breakdown');
    const sec = page.locator('#models');
    await sec.getByText('表で見る').click();
    const rows = sec.locator('table.ledger tbody tr');
    const heads = async (): Promise<string[]> => sec.locator('table.ledger thead th').allInnerTexts();
    expect(await heads()).toContain('推論強度別のリクエスト');
    const models = await rows.count();
    expect(models).toBeGreaterThan(0);
    // 推論強度の記録があるモデルは「high 3」のように強度と回数を出す
    const efforts = await rows.locator('td.efforts').allInnerTexts();
    expect(efforts.some((t) => /^\S+ [\d,]+(・\S+ [\d,]+)*$/.test(t)), efforts.join(' / ')).toBe(true);
    await sec.getByRole('button', { name: '推論強度で分ける' }).click();
    await expect.poll(heads).toContain('推論強度');
    expect(await heads()).not.toContain('推論強度別のリクエスト');
    expect(await rows.count()).toBeGreaterThanOrEqual(models);
    // 分けた行のリクエストの合計は、モデルごとの合計と同じ(強度の記録が無いリクエストは「不明」に入る)
    const sum = async (): Promise<number> => {
      const texts = await rows.locator('td.req').allInnerTexts();
      return texts.reduce((a, t) => a + Number(t.replace(/,/g, '')), 0);
    };
    const splitSum = await sum();
    await sec.getByRole('button', { name: 'モデルごと' }).click();
    await expect.poll(() => rows.count()).toBe(models);
    expect(await sum()).toBe(splitSum);
  });

  it('m2. モデルと推論強度の効果: 既定は モデル × 推論強度 の行で、「モデルごと」でモデルの数の行になる。リクエストの合計はどちらも同じ', async () => {
    await page.goto(server.url);
    await openTab('breakdown');
    const sec = page.locator('#model-value');
    const rows = sec.getByTestId('model-value-table').locator('tbody tr');
    const heads = async (): Promise<string[]> => sec.locator('thead th').allInnerTexts();
    expect(await heads()).toContain('推論強度');
    expect(await heads()).toContain('AIU / リクエスト');
    const reqSum = async (): Promise<number> => (await rows.locator('td.req').allInnerTexts()).reduce((a, t) => a + Number(t.replace(/,/g, '')), 0);
    const splitRows = await rows.count();
    const splitSum = await reqSum();
    expect(splitSum).toBeGreaterThan(0);
    await sec.getByRole('button', { name: 'モデルごと' }).click();
    await expect.poll(heads).not.toContain('推論強度');
    expect(await rows.count()).toBeLessThanOrEqual(splitRows);
    expect(await reqSum()).toBe(splitSum);
    // 目次から飛べる
    expect(await page.locator('a[href="#model-value"]').count()).toBeGreaterThan(0);
  });

  it('a. 一覧でチェックした件数だけで集計し、解除すると元に戻る', async () => {
    await page.goto(server.url);
    const all = await shown();
    expect(all).toBeGreaterThan(2);
    // 「工程と詰まり」の合計の依頼数(絞り込みに合わせて集計し直す)
    const turnsTotal = async (): Promise<number> => Number((await page.getByTestId('phase-table').locator('tfoot td').first().innerText()).replace(/[^0-9]/g, ''));
    const turnsAll = await turnsTotal();
    expect(turnsAll).toBeGreaterThan(0);
    // 一覧は一覧のタブ。「工程と詰まり」は概況のタブに隠れていても、絞り込みに合わせて数え直す
    await openTab('list');
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

  it('a2. 一覧の検索: ID・題名で行を絞り(上の集計は変えない)、合わなければ絞り込みの外の件数を出す。詳細から戻ると検索語も戻る', async () => {
    const records = (JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string; empty: boolean; name: string | null; firstUserMessage: string | null }[] }).sessions;
    const target = records.find((s) => !s.empty && s.name?.includes('wiki-query'));
    const empty = records.find((s) => s.empty);
    // 名前には無く、最初の依頼にだけある語(「直して」)
    const viaFirst = records.filter((s) => !s.empty && s.name && !s.name.includes('直して') && s.firstUserMessage?.includes('直して'));
    expect(target && empty && viaFirst.length === 1, 'fixture に wiki-query の題名・空のセッション・最初の依頼にだけ「直して」がある 1 件がある').toBeTruthy();
    await page.goto(server.url);
    await openTab('list');
    const all = await shown();
    const box = page.getByTestId('session-search');
    const result = page.getByTestId('session-search-result');
    const rows = page.locator('#sessions table.ledger tbody tr');
    expect(await result.innerText()).toBe('');
    // ID(丸ごと)で 1 件。行に ID を出す。上の集計(表示中の件数)は変えない
    await box.fill(target!.id);
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getByTestId('session-id').innerText()).toBe(`ID ${target!.id}`);
    expect(await result.innerText()).toContain('1 件が合います');
    expect(await shown()).toBe(all);
    // 題名の一部(大文字と小文字はそろえる)。ID では当たっていないので ID は出さない
    await box.fill('WIKI-QUERY');
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getByTestId('session-id').count()).toBe(0);
    // 名前に無く最初の依頼にだけある語は、行にその辺りの文を出す(題名だけでは、なぜ合ったか分からないため)
    await box.fill('直して');
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getByTestId('session-first-hit').innerText()).toContain('最初の依頼:');
    expect(await rows.first().getByTestId('session-first-hit').innerText()).toContain('直して');
    // Esc で検索語を消すと、全件に戻る。ブラウザの検索欄の Esc(中身を消す)に頼らず、欄の keydown の処理で消すことを確かめる
    // (合成した keydown には既定の動きが無い)。Esc はページの他の処理には渡さない
    await page.evaluate(`window.escSeen = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.escSeen++; });`);
    // IME の変換を取り消す Esc では消さない
    await box.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    expect(await box.inputValue()).toBe('直して');
    await box.dispatchEvent('keydown', { key: 'Escape' });
    await expect.poll(() => box.inputValue()).toBe('');
    await expect.poll(() => rows.count()).toBe(Math.min(all, 50));
    expect(await page.evaluate<number>('window.escSeen')).toBe(1);
    // 合わないときは表を出さず、そう知らせる。ID のつもりらしい短い語には、ID の探し方を添える
    await box.fill('合うものが無い語 zzzz');
    await expect.poll(() => result.innerText()).toBe('合うセッションはありません。');
    expect(await rows.count()).toBe(0);
    await box.fill(target!.id.slice(0, 3));
    await expect.poll(() => result.innerText()).toContain('ID は先頭から 4 文字以上で探します');
    // 空のセッション(既定で外している)は、「空のセッションを含める」で出ると知らせる(ほかの条件では外れていないので、絞り込みを外せとは言わない)
    await box.fill(empty!.id);
    await expect.poll(() => result.innerText()).toBe('合うセッションはありません。空のセッション 1 件は、「その他の条件」の「空のセッションを含める」で出ます。');
    // ID を含むパス(空白入り)を貼っても当たる
    await box.fill(`D:\\共有 フォルダ\\copilot logs\\${target!.id}\\events.jsonl`);
    await expect.poll(() => rows.count()).toBe(1);
    // 320px の幅でも、検索欄で横にはみ出さない
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(() => page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth')).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    // 詳細ページへ行って戻ると、検索語と絞った行が戻る
    await box.fill(target!.id);
    await expect.poll(() => rows.count()).toBe(1);
    await rows.first().locator('td.name a').click();
    await page.waitForURL((u) => u.pathname.includes(target!.id));
    await page.goBack();
    await expect.poll(() => page.getByTestId('session-search').inputValue()).toBe(target!.id);
    await expect.poll(() => rows.count()).toBe(1);
  });

  it('c. 詳細ページでメモを書いて保存すると memos に書かれ、再読み込みしても表示される', async () => {
    await page.goto(server.url);
    await openTab('list');
    const link = page.locator('#sessions table.ledger tbody td.name a').first();
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
    // 語の「リンクをコピー」で、その語の URL(#<id>)がクリップボードに入り、読み上げ欄とボタンの字で知らせる
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin });
    const copy = page.locator('button[data-copy-link]').first();
    const id = await copy.getAttribute('data-copy-link');
    await copy.click();
    await expect.poll(() => page.evaluate<string>('navigator.clipboard.readText()')).toBe(`${page.url().split('#')[0]}#${id}`);
    expect(await page.locator('#copy-status').innerText()).toMatch(/^リンクをコピーしました: /);
    expect(await copy.innerText()).toBe('コピーしました');
    await page.locator('a.crumb:visible').first().click();
    await page.waitForURL('**/atlas.html');
    await page.getByTestId('shown-count').waitFor({ state: 'visible' });
  });

  it('d2. 失敗の台帳の集計のページへ移動でき、用語の説明へのリンクとパンくずが効く', async () => {
    await page.goto(server.url);
    await page.locator('a[href="failures.html"]:visible').first().click();
    await page.waitForURL('**/failures.html');
    expect(await page.locator('h1').innerText()).toBe('失敗の台帳の集計');
    await page.locator('#f-overview .fields').waitFor({ state: 'visible' });
    // 用語の説明の、その語の位置へ
    await page.locator('a[href="glossary.html#failure-ledger"]').first().click();
    await page.waitForURL('**/glossary.html#failure-ledger');
    await page.locator('#failure-ledger').waitFor({ state: 'visible' });
    await page.goBack();
    await page.waitForURL('**/failures.html');
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

  it('i. 戻る・進む: 詳細ページから戻るとスクロール位置と一覧の並べ替えが戻る。要点のリンクで絞り込んでから戻ると絞り込みが外れ、進むとまた絞り込む', async () => {
    await page.goto('about:blank');
    await page.goto(server.url);
    await openTab('list');
    const all = await shown();
    // 一覧を「開始」の古い順に並べ替え、一覧の位置までスクロールしてから詳細ページへ
    const startHead = page.locator('#sessions table.ledger thead th', { has: page.getByRole('button', { name: /^開始/ }) });
    await startHead.getByRole('button').click();
    await expect.poll(() => startHead.getAttribute('aria-sort')).toBe('ascending');
    const firstName = async (): Promise<string> => page.locator('#sessions table.ledger tbody tr td.name a').first().innerText();
    const first = await firstName();
    await page.locator('#sessions').scrollIntoViewIfNeeded();
    // 字の読み込みなどで上の高さが変わり終わってから、整数の位置にスクロールし、位置が落ち着いてから覚える
    await page.evaluate('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
    await page.evaluate("window.scrollTo({ top: Math.round(document.getElementById('sessions').getBoundingClientRect().top + window.scrollY - 40), behavior: 'instant' })");
    const scrollY = (): Promise<number> => page.evaluate<number>('Math.round(window.scrollY)');
    await expect
      .poll(async () => {
        const a = await scrollY();
        await page.waitForTimeout(200);
        return a === (await scrollY());
      })
      .toBe(true);
    const y = await scrollY();
    // 一覧のタブでは一覧の節が帯のすぐ下にあるので、位置は小さい(0 でないことだけ確かめる)
    expect(y).toBeGreaterThan(100);
    await page.locator('#sessions table.ledger tbody tr td.name a').first().click();
    await page.waitForURL('**/sessions/*.html');
    await page.goBack();
    await page.waitForURL('**/atlas.html*');
    // 戻した位置は、画面が離れるときに覚えた位置(history.state)とぴったり同じ。覚えた位置は、テストがスクロールした位置と 1px まで違ってよい
    // (CI では、離れるまでの間に端数の高さの要素でブラウザがスクロール位置を 1px 動かすことがある。手元では起きない)
    const saved = (): Promise<number | null> => page.evaluate<number | null>('history.state && history.state.atlasView && typeof history.state.atlasView.y === "number" ? Math.round(history.state.atlasView.y) : null');
    await expect.poll(saved).not.toBeNull();
    const savedY = (await saved())!;
    expect(Math.abs(savedY - y), `覚えた位置 ${savedY}、スクロールした位置 ${y}`).toBeLessThanOrEqual(1);
    await expect.poll(scrollY).toBe(savedY);
    expect(await startHead.getAttribute('aria-sort')).toBe('ascending');
    expect(await firstName()).toBe(first);
    // 要点の「このツールを使ったセッションに絞り込む→」は履歴に残る移動で、一覧のタブへ移る。戻ると絞り込みが外れて概況に戻り、進むとまた絞り込む
    await openTab('overview');
    await page.getByRole('link', { name: /このツールを使ったセッションに絞り込む/ }).first().click();
    await expect.poll(shown).toBeLessThan(all);
    await expect.poll(() => page.locator('[data-tab-panel="list"]').isHidden()).toBe(false);
    expect(new URL(page.url()).hash).toMatch(/^#tool=[^&]+&tab=list$/);
    const narrowed = await shown();
    await page.goBack();
    await expect.poll(shown).toBe(all);
    await expect.poll(() => page.locator('[data-tab-panel="overview"]').isHidden()).toBe(false);
    await page.goForward();
    await expect.poll(shown).toBe(narrowed);
    await expect.poll(() => page.locator('[data-tab-panel="list"]').isHidden()).toBe(false);
  });

  it('t. 本文のタブ: 開いたときは概況。ページ内リンク(#phases・#exec-modes-h)は行き先のタブで開き、帯で切り替えると履歴に積み、戻る / 進む・再読み込みでタブと位置が戻る', async () => {
    const tabNow = (): Promise<string | null> => page.evaluate<string | null>(`document.querySelector('[data-tab-panel]:not([hidden])')?.getAttribute('data-tab-panel') ?? null`);
    const scrollY = (): Promise<number> => page.evaluate<number>('Math.round(window.scrollY)');
    const topOf = (id: string): Promise<number> => page.evaluate<number>(`Math.round(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top)`);
    await page.goto('about:blank');
    await page.goto(server.url);
    expect(await tabNow()).toBe('overview');
    // ほかのタブの節は描いてあるが隠れている(ページ内リンクの行き先を引ける)
    expect(await page.locator('#sessions').count()).toBe(1);
    expect(await page.locator('#sessions').isVisible()).toBe(false);
    // 詳細ページの「工程と詰まり」へのリンク(../atlas.html#phases)は概況の節。開くとその節が上端(サイドバーの幅では 12px の余白)に来る
    await page.goto('about:blank');
    await page.goto(`${server.url}#phases`);
    expect(await tabNow()).toBe('overview');
    await expect.poll(() => topOf('phases')).toBe(12);
    // 内訳の中の見出し(実行の性質の小見出し)は、内訳のタブを開いてから移る。URL には開いたタブが残る(再読み込みで同じタブ)
    await page.goto('about:blank');
    await page.goto(`${server.url}#exec-modes-h`);
    await expect.poll(tabNow).toBe('breakdown');
    await expect.poll(() => topOf('exec-modes-h')).toBeLessThan(40);
    expect(new URL(page.url()).hash).toBe('#tab=breakdown');
    // 絞り込みとタブを両方持つハッシュ。タブは絞り込みの条件に数えず、「解除」でも変わらない
    await page.goto('about:blank');
    await page.goto(`${server.url}#memo=1&tab=list`);
    expect(await tabNow()).toBe('list');
    await expect.poll(() => page.locator('.status .active .badge').innerText()).toBe('1');
    await page.locator('.status').getByRole('button', { name: '解除' }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#tab=list');
    expect(await tabNow()).toBe('list');
    // 帯で切り替える: 概況の途中から内訳を開くと、帯が上端に来る位置へ移る。戻ると概況のその位置、進むと内訳、再読み込みでも内訳
    await page.goto('about:blank');
    await page.goto(server.url);
    await page.evaluate("window.scrollTo({ top: 1200, behavior: 'instant' })");
    await expect.poll(scrollY).toBe(1200);
    // Playwright の click は押す前に要素を画面に入れる(スクロールする)ので、DOM の click で押す
    await page.evaluate(`document.querySelector('[data-testid="tab-breakdown"]').click()`);
    await expect.poll(tabNow).toBe('breakdown');
    expect(new URL(page.url()).hash).toBe('#tab=breakdown');
    expect(await page.evaluate<number>(`Math.round(document.querySelector('[data-testid="report-tabs"]').getBoundingClientRect().top)`)).toBe(0);
    expect(await page.getByTestId('tab-breakdown').getAttribute('aria-current')).toBe('page');
    // 目次の現在地は今のタブの節だけから選ぶ
    await expect.poll(() => page.locator('.toc a[aria-current="true"]').getAttribute('href')).toBe('#usage');
    await page.evaluate("window.scrollTo({ top: 500, behavior: 'instant' })");
    await page.waitForTimeout(400); // スクロールが止まってから位置を履歴の項目に書く
    await page.goBack();
    await expect.poll(tabNow).toBe('overview');
    await expect.poll(scrollY).toBe(1200);
    await page.goForward();
    await expect.poll(tabNow).toBe('breakdown');
    await expect.poll(scrollY).toBe(500);
    await page.reload();
    await expect.poll(tabNow).toBe('breakdown');
    await expect.poll(scrollY).toBe(500);
    // サイドバーの別のタブの節(セッション一覧)を押すと、一覧のタブを開いてその節へ移る。戻ると内訳の元の位置
    await page.locator('nav.toc a[href="#sessions"]').click();
    await expect.poll(tabNow).toBe('list');
    // 一覧のタブはページが短く、ちょうど 12px の位置まではスクロールできないことがある
    await expect.poll(async () => { const t = await topOf('sessions'); return t >= 0 && t < 40; }).toBe(true);
    await page.goBack();
    await expect.poll(tabNow).toBe('breakdown');
    await expect.poll(scrollY).toBe(500);
    // 群の題もタブへのリンク(今のタブに aria-current="page")
    await page.getByTestId('toc-tab-overview').click();
    await expect.poll(tabNow).toBe('overview');
    expect(await page.getByTestId('toc-tab-overview').getAttribute('aria-current')).toBe('page');
    expect(new URL(page.url()).hash).toBe('');
  });

  it('t2. 本文のタブ: 絞り込みのリンクから戻ると元の位置。隠れたタブに入った焦点は帯へ。「本文へ移動」はタブを保つ。view=unused-skills・本文の別のタブへのリンク・375px の行・印刷', async () => {
    const tabNow = (): Promise<string | null> => page.evaluate<string | null>(`document.querySelector('[data-tab-panel]:not([hidden])')?.getAttribute('data-tab-panel') ?? null`);
    const scrollY = (): Promise<number> => page.evaluate<number>('Math.round(window.scrollY)');
    const savedY = (): Promise<number | null> => page.evaluate<number | null>('history.state && history.state.atlasView && typeof history.state.atlasView.y === "number" ? Math.round(history.state.atlasView.y) : null');
    const focused = (): Promise<string | null> => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.id ?? null");
    const topOf = (id: string): Promise<number> => page.evaluate<number>(`Math.round(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top)`);
    try {
      // 概況の途中から要点の「このツールを使ったセッションに絞り込む」(一覧のタブへ移り、絞り込む)→ 戻ると、概況の同じ位置。
      // 絞り込みを外すと上の節(要点など)の高さが変わるので、タブと絞り込みを同時に当ててから位置を戻さないと、ブラウザが位置をずらす
      // ずれの大きさは幅と字の幅で変わる(この fixture では 1440px で 0、1280px で十数 px)ので、ずれの出る幅で見たうえで、
      // 原因(ブラウザが位置を戻す時点で、絞り込みがまだ前の項目のまま)も popstate の時点の件数で直接確かめる
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('about:blank');
      await page.goto(server.url);
      const allShown = await page.getByTestId('shown-count').innerText();
      await page.evaluate("window.scrollTo({ top: 1500, behavior: 'instant' })");
      await expect.poll(scrollY).toBe(1500);
      await page.waitForTimeout(400); // スクロールが止まってから位置を履歴の項目に書く
      await page.evaluate(`document.querySelector('[data-testid="highlights"] a[href*="tool="]').click()`);
      await expect.poll(tabNow).toBe('list');
      expect(new URL(page.url()).hash).toMatch(/^#tool=[^&]+&tab=list$/);
      expect(await page.getByTestId('shown-count').innerText()).not.toBe(allShown);
      // 画面の popstate の処理の後に動く(後から足したので)。この時点で絞り込みもタブも戻り終えている
      await page.evaluate(`window.__atPop = null; addEventListener('popstate', () => { window.__atPop = { shown: document.querySelector('[data-testid="shown-count"]').textContent, tab: document.querySelector('[data-tab-panel]:not([hidden])').getAttribute('data-tab-panel') }; }, { once: true })`);
      await page.goBack();
      await expect.poll(tabNow).toBe('overview');
      expect(await page.evaluate('window.__atPop')).toEqual({ shown: allShown, tab: 'overview' });
      await page.waitForTimeout(700); // ずれるなら、ずれて位置を書き終えるまで待つ
      expect(Math.abs((await scrollY()) - 1500), `戻った位置 ${await scrollY()}`).toBeLessThanOrEqual(3);
      expect(Math.abs(((await savedY()) ?? 0) - 1500), `残した位置 ${await savedY()}`).toBeLessThanOrEqual(3);
      await page.setViewportSize({ width: 1440, height: 900 });
      // 一覧のチェック欄に焦点があるまま戻ると、焦点は今のタブ(概況)の帯のリンクへ移る(body に落ちない)
      await page.goForward();
      await expect.poll(tabNow).toBe('list');
      await page.locator('#sessions table.ledger tbody input[type="checkbox"]').first().focus();
      await page.goBack();
      await expect.poll(tabNow).toBe('overview');
      await expect.poll(focused).toBe('tab-overview');

      // 「本文へ移動」(#main。どのタブにも入っていない行き先)は URL のタブを消さない。焦点は本文へ。再読み込みしても同じタブ
      await page.goto('about:blank');
      await page.goto(`${server.url}#tab=breakdown`);
      await page.locator('a.skip').focus();
      await page.keyboard.press('Enter');
      await expect.poll(focused).toBe('main');
      expect(new URL(page.url()).hash).toBe('#tab=breakdown');
      await page.reload();
      await expect.poll(tabNow).toBe('breakdown');

      // view=unused-skills(要点の「未使用の skill の一覧」)は内訳のタブを開き、利用ランキングを skill にして、その一覧に焦点を移す
      await page.goto('about:blank');
      await page.goto(`${server.url}#view=unused-skills`);
      await expect.poll(tabNow).toBe('breakdown');
      await expect.poll(focused).toBe('unused-skills');
      expect(await page.getByTestId('unused-skills').isVisible()).toBe(true);
      // 表示の指定は URL に残さず、タブだけを残す
      expect(new URL(page.url()).hash).toBe('#tab=breakdown');

      // 本文の中の別のタブへのリンク(集計明細の摩擦の「詳細は実行の性質」→ #exec)は、内訳のタブを開いてその節へ移る
      await page.goto('about:blank');
      await page.goto(server.url);
      await page.locator('#detail a[href="#exec"]').click();
      await expect.poll(tabNow).toBe('breakdown');
      // スムーズスクロールの途中(行き先がまだ上にあって負の位置)で通らないよう、上端の近くに着くまで待つ
      await expect.poll(async () => { const t = await topOf('exec'); return t >= 0 && t < 40; }).toBe(true);
      expect(new URL(page.url()).hash).toBe('#exec');

      // 印刷: どのタブの節も出し、タブの帯は出さない
      await page.emulateMedia({ media: 'print' });
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[data-tab-panel]')].map((e) => getComputedStyle(e).display)`)).toEqual(['block', 'block', 'block']);
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-testid="report-tabs"]')).display`)).toBe('none');
      await page.emulateMedia({ media: null });

      // 375px: 上部に固定した行は、タブ → 今のタブの節 → 付録(別ページ)の順で、高さは 37px のまま。タブを替えると節も替わる
      await page.setViewportSize({ width: 375, height: 812 });
      const row = (): Promise<string[]> =>
        page.evaluate<string[]>(`[...document.querySelectorAll('.rail nav.toc a')].filter((a) => a.checkVisibility()).map((a) => {
          if (a.closest('.toc-tabs')) return 'tab';
          const h = a.getAttribute('href');
          if (!h.startsWith('#')) return 'page';
          return 'section:' + (document.getElementById(h.slice(1))?.closest('[data-tab-panel]')?.getAttribute('data-tab-panel') ?? '?');
        })`);
      const shape = (kinds: string[]): string => kinds.filter((k, i) => i === 0 || kinds[i - 1] !== k).join(' > ');
      await page.goto('about:blank');
      await page.goto(server.url);
      expect(shape(await row())).toBe('tab > section:overview > page');
      expect((await row()).filter((k) => k === 'tab')).toHaveLength(3);
      expect(await page.evaluate<number>("document.querySelector('.rail').offsetHeight")).toBe(37);
      await page.locator('.rail .toc-tabs a', { hasText: '内訳' }).click();
      await expect.poll(tabNow).toBe('breakdown');
      await expect.poll(async () => shape(await row())).toBe('tab > section:breakdown > page');
      expect(await page.evaluate<number>("document.querySelector('.rail').offsetHeight")).toBe(37);
    } finally {
      await page.emulateMedia({ media: null });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it('t3. 本文のタブ: 表示の指定(view=)のページ内リンクは、絞り込みが変わらなくても URL に view を残さない。帯で切り替えてから戻ると、その項目の位置に戻る(view の場所へ飛び直さない)', async () => {
    const tabNow = (): Promise<string | null> => page.evaluate<string | null>(`document.querySelector('[data-tab-panel]:not([hidden])')?.getAttribute('data-tab-panel') ?? null`);
    const scrollY = (): Promise<number> => page.evaluate<number>('Math.round(window.scrollY)');
    const focused = (): Promise<string | null> => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.id ?? null");
    const hash = (): string => new URL(page.url()).hash;
    // Playwright の click は押す前に要素を画面に入れる(スクロールする)ので、DOM の click で押す
    const domClick = (sel: string): Promise<unknown> => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    // 絞り込みの無いときの要点の「未使用の skill の一覧」と同じリンク(filterHref(絞り込み無し, 'unused-skills'))。
    // この fixture にはインストール済みの記録が無く要点に出ないので、同じ href のリンクを概況に置いて押す
    await page.goto('about:blank');
    await page.goto(server.url);
    await page.evaluate(`(() => { const a = document.createElement('a'); a.href = '#view=unused-skills'; a.id = 'test-unused-link'; a.textContent = '未使用の skill の一覧'; document.querySelector('[data-tab-panel="overview"]').prepend(a); })()`);
    await domClick('#test-unused-link');
    await expect.poll(tabNow).toBe('breakdown');
    await expect.poll(focused).toBe('unused-skills');
    await expect.poll(hash).toBe('#tab=breakdown');
    // 未使用の一覧へのスムーズスクロールが止まるのを待つ(途中で動かすと、その後も動き続けることがある)
    await expect
      .poll(async () => {
        const a = await scrollY();
        await page.waitForTimeout(200);
        return a === (await scrollY());
      })
      .toBe(true);
    // 内訳の途中で帯から概況へ移り、戻ると内訳のその位置(未使用の一覧へ飛び直さない・焦点も移さない)
    await page.evaluate("window.scrollTo({ top: 300, behavior: 'instant' })");
    await expect.poll(scrollY).toBe(300);
    await page.waitForTimeout(400); // スクロールが止まってから位置を履歴の項目に書く
    await domClick('[data-testid="tab-overview"]');
    await expect.poll(tabNow).toBe('overview');
    await page.goBack();
    await expect.poll(tabNow).toBe('breakdown');
    await page.waitForTimeout(700);
    expect(await scrollY()).toBe(300);
    expect(await focused()).not.toBe('unused-skills');
    expect(hash()).toBe('#tab=breakdown');

    // 要点の「このツールを使ったセッションに絞り込む」を、もう同じツールで絞り込んでいるときに押しても、URL に view を残さない
    await page.goto('about:blank');
    await page.goto(server.url);
    const tool = page.locator('[data-testid="highlights"] a[href*="tool="]').first();
    const toolHref = (await tool.getAttribute('href'))!;
    expect(toolHref).toMatch(/&view=sessions$/);
    const filtered = toolHref.replace(/&view=sessions$/, '');
    await domClick('[data-testid="highlights"] a[href*="tool="]');
    await expect.poll(tabNow).toBe('list');
    await expect.poll(hash).toBe(`${filtered}&tab=list`);
    await domClick('[data-testid="tab-overview"]');
    await expect.poll(tabNow).toBe('overview');
    expect(hash()).toBe(filtered);
    // 同じ絞り込みのまま、もう一度押す(絞り込みは変わらない)
    await domClick('[data-testid="highlights"] a[href*="tool="]');
    await expect.poll(tabNow).toBe('list');
    await expect.poll(hash).toBe(`${filtered}&tab=list`);
  });

  it('h2. 押せそうで押せない要素と、押せるのに指のカーソルが出ない要素: 網羅チェック(file:// で開く)では開けない設定・別のフォルダのダイアログと、375px の画面にも無い', async () => {
    // 要修正に加えて、逆向きの「操作できるのに指のカーソルが出ない」も、ここで開く部品では起きないことを確かめる(ほかの要確認は目で見る種類なので数えない)
    const errorsNow = async (where: string): Promise<string[]> =>
      (await clickableFindings(page)).filter((f) => f.severity === 'error' || f.kind === '操作できるのに指のカーソルが出ない').map((f) => `${where}: ${f.kind} ${f.detail}`);
    const found: string[] = [];
    try {
      await page.goto(server.url);
      await page.getByTestId('settings-open').click();
      await expect.poll(() => page.getByTestId('settings-dialog').isVisible()).toBe(true);
      found.push(...(await errorsNow('設定')));
      await page.getByTestId('settings-dialog').getByTestId('settings-close').click();
      await page.getByTestId('folders-open').click();
      await expect.poll(() => page.getByTestId('folders-dialog').isVisible()).toBe(true);
      found.push(...(await errorsNow('別のフォルダを開く')));
      await page.getByTestId('folders-close').click();
      await page.setViewportSize({ width: 375, height: 812 });
      await expect.poll(() => page.locator('.toc-tabs').isVisible()).toBe(true);
      found.push(...(await errorsNow('375px')));
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    expect(found).toEqual([]);
  });

  it('j. プロジェクト別の「まとめて送る」: 印を付けると設定の uploadProjects に書き(ほかの設定は残す)、再読み込みしても残る。外すと消える。書けなければ理由を出して印を戻す', async () => {
    const before = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
    const root = join(WORK, 'atlas-logs');
    await mkdir(root, { recursive: true });
    await writeFile(configPath, JSON.stringify({ uploadRoot: root }));
    const readConfig = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configPath, 'utf8'));
    try {
      await page.goto(server.url);
      await openTab('breakdown');
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
      await openTab('breakdown');
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
    // 名前に wiki を含むインストール済みの skill(候補に出る)
    const skillDir = join(home, 'skills', 'wiki-k');
    await mkdir(skillDir, { recursive: true });
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
      // 候補の skill は初めから選んである。wiki-k だけを数える
      expect(await found.getByRole('checkbox', { name: 'wiki-k' }).isChecked()).toBe(true);
      for (const box of await found.getByRole('checkbox').all()) await box.uncheck();
      await found.getByRole('checkbox', { name: 'wiki-k' }).check();
      await found.getByTestId('settings-vault-add').click();
      await expect.poll(readConfig).toEqual({ wikis: [{ path: 'vault-k', index: ['README.md'], pages: ['wiki'], skills: ['wiki-k'] }] });
      // 足した後の焦点は、vault の入力欄(押したボタンが消えて本文の先頭に落ちないように)
      await expect.poll(() => page.evaluate<string | null>("document.activeElement?.getAttribute('data-testid') ?? null")).toBe('settings-vault-input');
      await expect.poll(() => wiki.getByTestId('settings-refresh').isVisible()).toBe(true);
      await expect.poll(() => wiki.locator('.items li').first().innerText()).toMatch(/vault-k[\s\S]*ページ: wiki・索引: README\.md/);
      // 入力したフォルダ名(見つからない)も足せる。path だけなら文字列で書く
      await wiki.getByTestId('settings-vault-input').fill('notes-k');
      await wiki.getByRole('button', { name: '調べる' }).click();
      await expect.poll(() => wiki.getByTestId('settings-vault-found').innerText()).toMatch(/「notes-k」で足します.*フォルダが見つからない/);
      await wiki.getByTestId('settings-vault-found').getByLabel(/個別ページを置くフォルダ/).fill('.');
      expect(await wiki.getByTestId('settings-vault-found').getByRole('checkbox', { name: 'wiki-k' }).isChecked()).toBe(false);
      for (const box of await wiki.getByTestId('settings-vault-found').getByRole('checkbox').all()) await box.uncheck();
      await wiki.getByTestId('settings-vault-add').click();
      // ほかの vault でもう数えている skill は、初めから選ばない
      await expect.poll(async () => (await readConfig()).wikis).toEqual([{ path: 'vault-k', index: ['README.md'], pages: ['wiki'], skills: ['wiki-k'] }, 'notes-k']);
      // 外す
      await wiki.getByRole('button', { name: 'vault「vault-k」を外す' }).click();
      await expect.poll(async () => (await readConfig()).wikis).toEqual(['notes-k']);
      // 普段の工程名: 保存 → 既定に戻す
      const phases = dlg.getByTestId('settings-phases');
      await phases.getByTestId('settings-phases-input').fill('設計 / 実装 / テスト');
      await phases.getByRole('button', { name: '保存' }).click();
      await expect.poll(async () => (await readConfig()).phases).toEqual(['設計', '実装', 'テスト']);
      // 設定ファイルに書かれてから、答えが画面に届いて書き換わるまでに間があるので、待って読む
      await expect.poll(() => phases.getByTestId('settings-phases-saved').innerText()).toBe('保存しました。');
      await expect.poll(() => dlg.getByTestId('settings-status').innerText()).toBe('普段の工程名を保存しました。');
      await phases.getByRole('button', { name: '既定に戻す' }).click();
      await expect.poll(async () => 'phases' in (await readConfig())).toBe(false);
      // アップロード先: エクスプローラーで選ぶ
      pickAnswer = root;
      const rootSec = dlg.getByTestId('settings-root');
      await rootSec.getByTestId('settings-root-pick').click();
      await expect.poll(async () => (await readConfig()).uploadRoot).toBe(root);
      await expect.poll(() => rootSec.getByTestId('settings-root-current').innerText()).toBe(root);
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
      await rm(skillDir, { recursive: true, force: true });
      if (before == null) await rm(configPath, { force: true });
      else await writeFile(configPath, before);
    }
  });

  it('l. 最終更新で並べ替え: セッションの一覧とプロジェクト別の表に「最終更新」の列があり、押すと新しい順、もう一度押すと古い順に並ぶ', async () => {
    await page.goto('about:blank');
    await page.goto(server.url);
    /** 表の「最終更新」の列の値(YYYY-MM-DD HH:mm。日時の無いものは除く) */
    const column = async (table: string): Promise<string[]> => {
      const heads = await page.locator(`${table} table.ledger thead th`).allInnerTexts();
      const at = heads.findIndex((h) => h.startsWith('最終更新'));
      expect(at, `${table} に最終更新の列がある`).toBeGreaterThanOrEqual(0);
      const cells = await page.locator(`${table} table.ledger tbody tr`).evaluateAll((rows, i) => rows.map((r) => (r.children[i as number] as { innerText?: string } | undefined)?.innerText?.trim() ?? ''), at);
      return cells.filter((c) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c));
    };
    for (const [table, tab] of [['#sessions', 'list'], ['#projects', 'breakdown']] as const) {
      await openTab(tab);
      const head = page.locator(`${table} table.ledger thead th`, { has: page.getByRole('button', { name: /^最終更新/ }) });
      await head.getByRole('button').click();
      await expect.poll(() => head.getAttribute('aria-sort')).toBe('descending');
      const desc = await column(table);
      expect(desc.length, `${table} に日時のある行がある`).toBeGreaterThan(1);
      expect(desc).toEqual([...desc].sort().reverse());
      await head.getByRole('button').click();
      await expect.poll(() => head.getAttribute('aria-sort')).toBe('ascending');
      const asc = await column(table);
      expect(asc).toEqual([...asc].sort());
    }
  });
});
