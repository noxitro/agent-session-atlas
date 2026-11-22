// 管理ツールのタスクの画面(Playwright の Chromium)。テスト用の XML(e2e/fixtures/tasks/)と架空の fixture で atlas all → atlas serve を立て、実際に押して確かめる。
//  a. 概況の「管理ツールのタスク」: タスクの数・比べられる完了タスク・2 つの工数と AI の実働を別の欄に出し、比べられるタスクが下限に届かなければ比を出さない
//  b. タスクの行を押すとそのタスクのセッションに絞り込み、一覧の行にタスクの名前が出る。絞り込みの行の「タスク」でも選べる(タスクなしも)
//  c. 詳細ページの「タスク」の行: 手で選ぶ・どのタスクでもない・自動に戻すが task-links.json に残り、行が書き変わる
//  d. 「タスクを LLM で紐づける…」: 確かめてから始め、帯で進み具合を出し、終わったら LLM の紐づけが出る
//  e. プロジェクトを送った先を開いた読むだけの画面: タスクの節と絞り込みは出るが、詳細ページに変える操作は出ず、LLM のボタンは押せない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。環境変数 ATLAS_UI_SHOTS にフォルダを指すと、節と詳細ページの行の画面(ライト・ダーク・狭い幅)をそこに残す
import { spawnSync } from 'node:child_process';
import { copyFileSync, utimesSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURE_CODE, FIXTURE_WIKIS, FIXTURES, ROOT, cliCommand, startServer, uploadDirName, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-tasks');
const XML_DIR = join(ROOT, 'e2e', 'fixtures', 'tasks');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');
const S_FIX = '00000000-0000-4000-8000-000000000008';
const S_IMPROVE = '00000000-0000-4000-8000-000000000011';
/** 機械では決まらないセッション(依頼の文がどのタスクにも当たらない) */
const S_OTHER = '00000000-0000-4000-8000-000000000009';
const T_BEFORE = new Date('2026-10-14T00:00:00.000Z');
const T_AFTER = new Date('2026-10-23T12:00:00.000Z');
const SHOTS = process.env.ATLAS_UI_SHOTS || null;

type Links = { links: Record<string, { taskId: string | null; source: string; reason: string }> };

describe('管理ツールのタスクの画面', () => {
  /** ATLAS_REPO_ROOT(プロジェクトを送る操作が既定のメモの置き場 atlas-notes/ をこの下に見る) */
  const repo = join(WORK, 'repo');
  const out = join(WORK, 'out');
  const notes = join(repo, 'atlas-notes');
  const xml = join(WORK, 'export.xml');
  const configPath = join(WORK, 'atlas.config.json');
  const root = join(WORK, 'atlas-logs');
  const out2 = join(WORK, 'out-received');
  let close: () => Promise<void>;
  let home: string;
  let server: ServeHandle;
  let received: ServeHandle;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const problems: string[] = [];
  const env = (): NodeJS.ProcessEnv => ({ TZ: 'UTC', ATLAS_REPO_ROOT: repo, ATLAS_CONFIG: configPath, ATLAS_COPILOT_HOME: home, ATLAS_COPILOT_BIN: FAKE, FAKE_COPILOT_LOG: join(WORK, 'fake-copilot.log') });
  function atlas(args: string[], extra: NodeJS.ProcessEnv = {}): void {
    const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, env: { ...process.env, ...env(), ...extra } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  function putXml(name: string, at: Date): void {
    copyFileSync(join(XML_DIR, name), xml);
    utimesSync(xml, at, at);
  }
  const links = async (): Promise<Links['links']> => (JSON.parse(await readFile(join(notes, 'task-links.json'), 'utf8')) as Links).links;
  const detailUrl = (s: ServeHandle, id: string): string => s.url.replace(/atlas\.html$/, `sessions/${id}.html`);

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home'), {}));
    await writeFile(configPath, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: xml } }));
    // 最初の書き出しで集計し、後の書き出し(2 つのタスクが完了)を読み、推定人手工数を取り込んでから作り直す(e2e/tasks.test.ts と同じ流れ)
    putXml('export-before.xml', T_BEFORE);
    atlas(['all', '--home', home, '--out', out, '--notes-dir', notes]);
    putXml('export-after.xml', T_AFTER);
    atlas(['tasks', 'sync', '--out', out, '--notes-dir', notes]);
    const sample = JSON.parse(await readFile(join(FIXTURES, 'judgments-sample.json'), 'utf8')) as { items: Record<string, unknown>[] };
    const item = (sessionId: string, hours: number, confidence: number) => ({ ...sample.items[0], sessionId, humanEffort: { hours, low: hours / 2, high: hours * 2, confidence, rationale: 'テスト用の架空の推定' } });
    const jfile = join(WORK, 'judgments-tasks.json');
    await writeFile(jfile, JSON.stringify({ ...sample, items: [item(S_FIX, 40, 0.8), item(S_IMPROVE, 10, 0.2)] }));
    atlas(['judge', 'import', jfile, '--out', out]);
    atlas(['build', '--out', out, '--notes-dir', notes]);
    server = await startServer({ outDir: out, notesDir: notes, configPath, port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, jobs: { env: env() } });
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close('テスト終了');
    await received?.close('テスト終了');
    await close?.();
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems.splice(0)).toEqual([]);
  });

  const panel = () => page.getByTestId('tasks-panel');
  const shown = async (): Promise<number> => Number((await page.getByTestId('shown-count').innerText()).replace(/,/g, ''));
  /** 画面の節と詳細ページの行を、ライト・ダーク・狭い幅で残す(ATLAS_UI_SHOTS のときだけ) */
  async function shots(name: string, target: () => ReturnType<Page['getByTestId']>, url: string): Promise<void> {
    if (!SHOTS) return;
    await mkdir(SHOTS, { recursive: true });
    for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(url);
      await target().waitFor({ state: 'visible' });
      await target().screenshot({ path: join(SHOTS, `${name}-${scheme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  it('a. 概況の「管理ツールのタスク」に、タスクの数・比べられる完了タスク・2 つの工数と AI の実働が並ぶ', async () => {
    await page.goto(server.url);
    await panel().waitFor({ state: 'visible' });
    // 目次にも出る
    expect(await page.locator('.toc a[href="#tasks"]').count()).toBe(1);
    expect(await page.getByTestId('tasks-count').innerText()).toBe('6');
    expect(await page.getByTestId('tasks-included').innerText()).toBe('1');
    expect(await panel().innerText()).toContain('比べないもの: 確度が低い 1');
    expect(await page.getByTestId('tasks-human').innerText()).toBe('40 時間');
    // 木 10/15 0:00 開始 → 金 10/23 12:00 完了を確認。月〜金 9:00〜18:00 で 57 時間
    expect(await page.getByTestId('tasks-work').innerText()).toBe('57 時間');
    expect(await page.getByTestId('tasks-active').innerText()).toBe('0.01 時間');
    // 比べられる完了タスクが下限に届かないので比は出さない
    expect(await page.getByTestId('tasks-ratio').innerText()).toBe('—');
    expect(await page.getByTestId('tasks-ratio-why').innerText()).toMatch(/^比べられる完了タスクが \d+ 件から出します\(今 1 件\)$/);
    const defs = await page.getByTestId('tasks-defs').innerText();
    expect(defs).toContain('月〜金 9:00〜18:00');
    expect(defs).toContain('祝日は区別しません');
    expect(defs).toContain('書き出しのファイルの更新時刻');
    expect(await page.getByTestId('tasks-warning').count()).toBe(0);
    // 表はセッションの紐づいたタスクだけ。紐づいていないタスクは押すと出る
    const rows = page.getByTestId('tasks-table').locator('tbody tr');
    expect(await rows.evaluateAll((trs) => trs.map((tr) => (tr as unknown as { dataset: Record<string, string> }).dataset.task))).toEqual(['DEMO-101', 'DEMO-102']);
    const r101 = await rows.nth(0).innerText();
    expect(r101).toContain('fix the app');
    expect(r101).toContain('Completed');
    expect(r101).toContain('2026-10-23 12:00');
    expect(r101).toContain('57 時間');
    expect(r101).toContain('機械 1');
    expect(await rows.nth(1).innerText()).toContain('確度が低い');
    await page.getByTestId('tasks-show-all').click();
    expect(await rows.count()).toBe(6);
    // 列見出しで並べ替える(稼働時間帯の工数の多い順)
    await page.getByTestId('tasks-table').getByRole('button', { name: 'AI を使った場合' }).click();
    expect(await rows.first().getAttribute('data-task')).toBe('DEMO-101');
    expect(await page.getByTestId('tasks-table').locator('th[aria-sort="descending"]').innerText()).toContain('AI を使った場合');
    await shots('tasks-panel', panel, server.url + '#tasks');
  });

  it('b. タスクの行を押すとそのタスクのセッションに絞り込み、一覧の行にタスクの名前が出る。絞り込みの行の「タスク」でも選べる', async () => {
    await page.goto(server.url);
    const all = await shown();
    await page.getByTestId('tasks-table').locator('tr[data-task="DEMO-101"]').getByTestId('task-pick').click();
    await expect.poll(shown).toBe(1);
    expect(decodeURIComponent(new URL(page.url()).hash)).toContain('task=DEMO-101');
    expect(await page.locator('tr[data-task="DEMO-101"]').innerText()).toContain('絞り込み中');
    expect(await page.getByTestId('task-filter').inputValue()).toBe('DEMO-101');
    // 一覧へ移ると、そのタスクのセッションだけが出て、行にタスクの名前がある
    await page.locator('tr[data-task="DEMO-101"]').getByRole('link', { name: 'セッション一覧へ' }).click();
    await page.locator('#sessions').waitFor({ state: 'visible' });
    expect(await page.getByTestId('session-task').allInnerTexts()).toEqual(['タスク: fix the app · DEMO-101(紐づけ: 機械)']);
    // もう一度押すと外れる(概況に戻って)
    await page.getByTestId('tab-overview').click();
    await page.getByTestId('tasks-table').locator('tr[data-task="DEMO-101"]').getByTestId('task-pick').click();
    await expect.poll(shown).toBe(all);
    // 絞り込みの行: タスクなし(どのタスクにも紐づいていない)と、ほかのタスク
    await page.getByTestId('task-filter').selectOption('(none)');
    await expect.poll(shown).toBe(all - 2);
    expect(await page.getByTestId('tasks-none').innerText()).toContain(`どのタスクにも紐づいていないセッション: ${all - 2} 件`);
    await page.getByTestId('task-filter').selectOption('DEMO-102');
    await expect.poll(shown).toBe(1);
    const opts = await page.getByTestId('task-filter').locator('option').allInnerTexts();
    // 「名前 · ID(件数)」。長い名前は縮め、全文は title に持つ(狭い幅でも件数まで見えるように)
    expect(opts).toEqual(['すべて', `タスクなし(${all - 2})`, 'fix the app · DEMO-101(1)', 'Improve the synthetic pr… · DEMO-102(1)']);
    expect(await page.getByTestId('task-filter').locator('option[value="DEMO-102"]').getAttribute('title')).toBe('Improve the synthetic project · DEMO-102');
    await page.getByTestId('task-filter').selectOption('');
    await expect.poll(shown).toBe(all);
  });

  it('c. 詳細ページの「タスク」の行で、手で選ぶ・どのタスクでもない・自動に戻すが残り、行が書き変わる', async () => {
    await page.goto(detailUrl(server, S_OTHER));
    const rowEl = page.getByTestId('detail-task');
    await rowEl.waitFor({ state: 'visible' });
    expect(await page.getByTestId('detail-task-name').innerText()).toBe('紐づけなし');
    await page.getByTestId('detail-task-open').click();
    await page.getByTestId('detail-task-edit').waitFor({ state: 'visible' });
    // 探す文字で候補を絞る(ID か名前の一部)
    await page.getByTestId('detail-task-search').fill('帳票');
    expect(await page.getByTestId('detail-task-select').locator('option').allInnerTexts()).toEqual(['帳票の出力を速くする(DEMO-103)']);
    // 合った数は、打ち終えてから状態の行で知らせる
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toBe('合うタスク 1 件。');
    await page.getByTestId('detail-task-search').fill('');
    await page.getByTestId('detail-task-select').selectOption('DEMO-103');
    await page.getByTestId('detail-task-set').click();
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toContain('このタスクに紐づけました。');
    // 保存しても焦点は押したボタンに残り(押せない状態は aria-disabled)、Esc で閉じて「変える…」に戻る
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-set');
    expect(await page.getByTestId('detail-task-set').getAttribute('aria-disabled')).toBe('true');
    await page.keyboard.press('Escape');
    await page.getByTestId('detail-task-edit').waitFor({ state: 'hidden' });
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-open');
    // サーバが止まった知らせで閉じるときも、焦点を「変える…」へ移す(body に落とさない)
    await page.getByTestId('detail-task-open').click();
    await page.getByTestId('detail-task-search').focus();
    await page.evaluate("document.dispatchEvent(new Event('atlas-down'))");
    await page.getByTestId('detail-task-edit').waitFor({ state: 'hidden' });
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-open');
    expect(await page.getByTestId('detail-task-open').getAttribute('aria-disabled')).toBe('true');
    expect(await page.getByTestId('detail-task-name').innerText()).toBe('帳票の出力を速くする(DEMO-103)');
    expect(await page.getByTestId('detail-task-source').innerText()).toBe('紐づけ: 手動');
    expect((await links())[S_OTHER]).toMatchObject({ taskId: 'DEMO-103', source: 'manual' });
    // レポートを開き直すと(サーバの今の紐づけを読む)、一覧とタスクの節に出る
    await page.goto(server.url);
    await panel().waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('tasks-table').locator('tr[data-task="DEMO-103"]').count()).toBe(1);
    expect(await page.getByTestId('tasks-table').locator('tr[data-task="DEMO-103"]').innerText()).toContain('手動 1');
    // どのタスクでもない → 自動に戻す(機械でも当たらないので紐づけなし)
    await page.goto(detailUrl(server, S_OTHER));
    await page.getByTestId('detail-task-open').click();
    await page.getByTestId('detail-task-none').click();
    await expect.poll(() => page.getByTestId('detail-task-name').innerText()).toBe('どのタスクでもない');
    expect((await links())[S_OTHER]).toMatchObject({ taskId: null, source: 'manual' });
    expect(await page.getByTestId('detail-task-none').getAttribute('aria-disabled')).toBe('true');
    // 押せない状態で押しても何もしない
    await page.getByTestId('detail-task-none').click({ force: true });
    expect((await links())[S_OTHER]).toMatchObject({ taskId: null, source: 'manual' });
    await page.getByTestId('detail-task-auto').click();
    await expect.poll(() => page.getByTestId('detail-task-name').innerText()).toBe('紐づけなし');
    expect((await links())[S_OTHER]).toBeUndefined();
    expect(await page.getByTestId('detail-task-auto').getAttribute('aria-disabled')).toBe('true');
    // 機械で紐づいたセッションを自動に戻しても、機械の紐づけはすぐ決め直す
    await page.goto(detailUrl(server, S_FIX));
    expect(await page.getByTestId('detail-task-name').innerText()).toBe('fix the app(DEMO-101)');
    expect(await page.getByTestId('detail-task-status').innerText()).toBe('状態: Completed(完了)');
    await shots('detail-task', () => page.getByTestId('detail-task'), detailUrl(server, S_FIX));
    // 開いた行(変える操作)も残す
    if (SHOTS) {
      await page.goto(detailUrl(server, S_FIX));
      await page.getByTestId('detail-task-open').click();
      await page.getByTestId('detail-task').screenshot({ path: join(SHOTS, 'detail-task-open-light-1440.png') });
    }
  });

  it('d. 「タスクを LLM で紐づける…」は確かめてから始め、終わると LLM の紐づけが出る', async () => {
    await page.goto(server.url);
    const btn = page.getByTestId('job-task-link');
    await expect.poll(() => btn.innerText()).toMatch(/^タスクを LLM で紐づける…\((\d+)\)$/);
    const n = Number(/\((\d+)\)/.exec(await btn.innerText())![1]);
    expect(n).toBeGreaterThan(0);
    expect(await btn.getAttribute('aria-disabled')).toBeNull();
    const dialog = page.getByTestId('task-link-dialog');
    // 使うモデル(費用の出所)が分かるまでは「消費します」と書かず、始められない。分からなかったときも始められない
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/jobs/judge-preview*', async (route) => {
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'テスト用の失敗' }) });
    });
    await btn.click();
    await dialog.waitFor({ state: 'visible' });
    expect(await page.getByTestId('task-link-cost').innerText()).toBe('費用を確かめています…');
    expect(await page.getByTestId('task-link-model').innerText()).toBe('使うモデルを確かめています…');
    expect(await page.getByTestId('task-link-run').isDisabled()).toBe(true);
    release();
    await expect.poll(() => page.getByTestId('task-link-model').innerText()).toBe('使うモデルを確かめられませんでした: テスト用の失敗');
    expect(await page.getByTestId('task-link-cost').innerText()).toContain('費用を確かめられないので、始められません。');
    expect(await page.getByTestId('task-link-run').isDisabled()).toBe(true);
    await page.getByTestId('task-link-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.unroute('**/api/jobs/judge-preview*');
    // 開き直したら、前に開いたときの遅れた答え(失敗)で書き換えない
    let releaseOld: () => void = () => {};
    const heldOld = new Promise<void>((r) => (releaseOld = r));
    let calls = 0;
    await page.route('**/api/jobs/judge-preview*', async (route) => {
      calls++;
      if (calls === 1) {
        await heldOld;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '遅れた失敗' }) });
      } else await route.continue();
    });
    await btn.click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('task-link-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    await btn.click();
    await dialog.waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('task-link-cost').innerText()).toContain('AI クレジットを消費します。');
    releaseOld();
    await expect.poll(() => calls).toBe(2);
    await page.waitForTimeout(200);
    expect(await page.getByTestId('task-link-model').innerText()).not.toContain('遅れた失敗');
    expect(await page.getByTestId('task-link-run').isDisabled()).toBe(false);
    await page.getByTestId('task-link-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.unroute('**/api/jobs/judge-preview*');
    // わざと失敗させた応答のコンソールのエラーだけは数えない
    for (let i = problems.length - 1; i >= 0; i--) if (/status of 503/.test(problems[i])) problems.splice(i, 1);
    // サーバが答えないときは、待ち続けずに 20 秒で理由を出す(時計を進めて確かめる)
    {
      const p2 = await context.newPage();
      await p2.clock.install();
      await p2.route('**/api/jobs/judge-preview*', () => new Promise<void>(() => {}));
      await p2.goto(server.url);
      const b2 = p2.getByTestId('job-task-link');
      await expect.poll(() => b2.getAttribute('aria-disabled')).toBeNull();
      await expect.poll(() => b2.innerText()).toMatch(/\(\d+\)$/);
      await b2.click();
      await p2.getByTestId('task-link-dialog').waitFor({ state: 'visible' });
      expect(await p2.getByTestId('task-link-model').innerText()).toBe('使うモデルを確かめています…');
      await p2.clock.fastForward(21_000);
      await expect.poll(() => p2.getByTestId('task-link-model').innerText()).toContain('20 秒以内に答えませんでした');
      expect(await p2.getByTestId('task-link-run').isDisabled()).toBe(true);
      await p2.close();
    }
    await btn.click();
    await dialog.waitFor({ state: 'visible' });
    expect(await page.getByTestId('task-link-count').innerText()).toBe(`紐づけの無いセッション ${n} 件を 1 件ずつ聞きます。`);
    await expect.poll(() => page.getByTestId('task-link-cost').innerText()).toContain('AI クレジットを消費します。');
    expect(await page.getByTestId('task-link-run').isDisabled()).toBe(false);
    // 初期フォーカスは「やめる」。やめれば何も始めない
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('task-link-cancel');
    await page.getByTestId('task-link-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(Object.values(await links()).some((l) => l.source === 'llm')).toBe(false);
    await btn.click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('task-link-run').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    expect(await page.getByTestId('job-band').innerText()).toContain('新しい集計ができました');
    const llm = Object.values(await links()).filter((l) => l.source === 'llm');
    expect(llm.length).toBe(n);
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await panel().waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('tasks-table').innerText()).toContain('LLM');
    // 聞くセッションが無くなったので押せない(理由は読み上げで分かる)
    await expect.poll(() => btn.getAttribute('aria-disabled')).toBe('true');
    expect(await page.getByTestId('job-task-link-why').innerText()).toContain('紐づけの無いセッションはありません');
  });

  it('e. 送った先を開いた読むだけの画面: タスクの節と絞り込みは出るが、変える操作は出ず、LLM のボタンは押せない', async () => {
    await mkdir(root, { recursive: true });
    const sessions = (JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string; project: string }[] }).sessions;
    const project = sessions.find((s) => s.id === S_FIX)!.project;
    const upCfg = join(WORK, 'atlas.config.upload.json');
    await writeFile(upCfg, JSON.stringify({ wikis: FIXTURE_WIKIS, tasks: { file: xml }, uploadRoot: root, uploadProjects: [project] }));
    const r = spawnSync(...cliCommand([], 'upload-project'), { encoding: 'utf8', cwd: ROOT, timeout: 600_000, input: 'y\n', env: { ...process.env, ...env(), ATLAS_OUT: out, ATLAS_CONFIG: upCfg } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const recvCfg = join(WORK, 'atlas.config.received.json');
    await writeFile(recvCfg, JSON.stringify({ wikis: FIXTURE_WIKIS }));
    const recvNotes = join(WORK, 'notes-received');
    atlas(['all', '--home', join(root, uploadDirName(project)), '--out', out2, '--notes-dir', recvNotes], { ATLAS_CONFIG: recvCfg });
    received = await startServer({ outDir: out2, notesDir: recvNotes, configPath: recvCfg, port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, jobs: { env: { TZ: 'UTC' } } });
    await page.goto(received.url);
    await page.getByTestId('readonly-tag').waitFor({ state: 'visible' });
    await panel().waitFor({ state: 'visible' });
    expect(await panel().innerText()).toContain('送った人がセッションごとに添えた記録から数えています');
    expect(await page.getByTestId('tasks-work').innerText()).toBe('—');
    expect(await page.getByTestId('tasks-table').locator('tbody tr').evaluateAll((trs) => trs.map((tr) => (tr as unknown as { dataset: Record<string, string> }).dataset.task))).toEqual(['DEMO-101']);
    expect(await page.getByTestId('tasks-table').innerText()).toContain('57 時間');
    await page.getByTestId('task-filter').selectOption('DEMO-101');
    await expect.poll(shown).toBe(1);
    // LLM のボタンは押せず、理由がある
    const btn = page.getByTestId('job-task-link');
    await expect.poll(() => btn.getAttribute('aria-disabled')).toBe('true');
    expect(await page.getByTestId('job-task-link-why').innerText()).toContain('読むだけの画面');
    // 押しても(aria-disabled は焦点を受けるので、Playwright の待ちを外して押す)ダイアログを開かない
    await btn.click({ force: true });
    expect(await page.getByTestId('task-link-dialog').isVisible()).toBe(false);
    // 詳細ページには行だけが出て、変える操作は出ない
    await page.goto(detailUrl(received, S_FIX));
    await page.getByTestId('detail-task').waitFor({ state: 'visible' });
    expect(await page.getByTestId('detail-task-name').innerText()).toBe('fix the app(DEMO-101)');
    // 操作を足す script を読み終えるまで待つ(記録の表示の操作が出たら読み終えている)
    await page.locator('.session-ops').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    expect(await page.getByTestId('detail-task-open').count()).toBe(0);
    // 書き換えの API も断る
    const put = await fetch(received.url.replace(/atlas\.html$/, `api/tasks/links/${S_FIX}`), { method: 'PUT', headers: { 'content-type': 'application/json', 'x-atlas-token': received.token }, body: JSON.stringify({ taskId: null }) });
    expect(put.status).toBe(403);
  });
});
