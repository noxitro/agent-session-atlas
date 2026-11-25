// 管理ツールのタスクの画面(Playwright の Chromium)。テスト用の XML(e2e/fixtures/tasks/)と架空の fixture で atlas all → atlas serve を立て、実際に押して確かめる。
//  a. 概況の「管理ツールのタスク」: タスクの数・比べられる完了タスク・2 つの工数と AI の実働を別の欄に出し、比べられるタスクが下限に届かなければ比を出さない
//  a1. 比を出すときは、比の欄の下にタスクごとの比のばらつきと推定の幅で見た比を出す(埋め込みの値を書き換えた写しで、出し方を確かめる)
//  a2. 全体サマリの表紙: 比べられる完了タスクと同じ範囲の 3 つの時間(比は出さない)。絞り込みでは変わらず、狭い幅でも欄に収まる
//  b. タスクの行を押すとそのタスクのセッションに絞り込み、一覧の行にタスクの名前が出る。絞り込みの行の「タスク」でも選べる(タスクなしも)
//  c. 詳細ページの「タスク」の行: 手で選ぶ・どのタスクでもない・自動に戻すが task-links.json に残り、行が書き変わる
//  d. 「判定する…」の「タスクの紐づけ」: チャットに貼る手順で添付ファイルを作り、返答を取り込むと LLM の紐づけが出る(このツールの中で LLM を呼ぶボタンは無い)
//  e. プロジェクトを送った先を開いた読むだけの画面: タスクの節と絞り込みは出るが、詳細ページに変える操作は出ず、判定のダイアログに「タスクの紐づけ」は出ない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。環境変数 ATLAS_UI_SHOTS にフォルダを指すと、節と詳細ページの行の画面(ライト・ダーク・狭い幅)をそこに残す
import { spawnSync } from 'node:child_process';
import { copyFileSync, utimesSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serializeForScript } from '../packages/report/src/lib/embed.ts';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURE_WIKIS, FIXTURES, ROOT, cliCommand, startServer, uploadDirName, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-tasks');
const XML_DIR = join(ROOT, 'e2e', 'fixtures', 'tasks');
const S_FIX = '00000000-0000-4000-8000-000000000008';
const S_IMPROVE = '00000000-0000-4000-8000-000000000011';
/** 機械では決まらないセッション(依頼の文がどのタスクにも当たらない) */
const S_OTHER = '00000000-0000-4000-8000-000000000009';
const T_BEFORE = new Date('2026-10-14T00:00:00.000Z');
const T_AFTER = new Date('2026-10-23T12:00:00.000Z');
const SHOTS = process.env.ATLAS_UI_SHOTS || null;

type Links = { links: Record<string, { taskIds: string[]; source: string; reason: string }> };

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
  const env = (): NodeJS.ProcessEnv => ({ TZ: 'UTC', ATLAS_REPO_ROOT: repo, ATLAS_CONFIG: configPath, ATLAS_COPILOT_HOME: home });
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
    // そのタスクの比(推定 40 時間 ÷ 稼働時間帯の工数 57 時間)と推定の幅(比べるタスクだけ)。比を出さないうちは、ばらつきも出さない
    expect(await rows.nth(0).getByTestId('task-ratio').innerText()).toBe('比 0.7 倍');
    expect(await rows.nth(0).getByTestId('task-human-range').innerText()).toBe('幅 20〜80');
    expect(await rows.nth(1).getByTestId('task-ratio').count()).toBe(0);
    expect(await page.getByTestId('tasks-ratio-spread').count()).toBe(0);
    expect(await page.getByTestId('tasks-ratio-range').count()).toBe(0);
    expect(await rows.nth(1).innerText()).toContain('確度が低い');
    await page.getByTestId('tasks-show-all').click();
    expect(await rows.count()).toBe(6);
    // 列見出しで並べ替える(稼働時間帯の工数の多い順)
    await page.getByTestId('tasks-table').getByRole('button', { name: 'AI を使った場合' }).click();
    expect(await rows.first().getAttribute('data-task')).toBe('DEMO-101');
    expect(await page.getByTestId('tasks-table').locator('th[aria-sort="descending"]').innerText()).toContain('AI を使った場合');
    await shots('tasks-panel', panel, server.url + '#tasks');
  });

  it('a1. 比を出すときは、比の欄の下にタスクごとの比のばらつきと推定の幅で見た比を出し、推定の偏りが分からないことを書く(埋め込みの値をそのまま出す)', async () => {
    // fixture の比べられる完了タスクは 1 件で下限に届かないので、埋め込みの合計の値だけを書き換えた写しを file:// で開いて、出し方を確かめる
    // (値は Rust が決めるもので、数え方は crates/atlas-report/src/tasks/metrics.rs の単体テストで確かめる)
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const re = /(<script type="application\/json" id="atlas-data">)([\s\S]*?)(<\/script>)/;
    const m = re.exec(html)!;
    const data = JSON.parse(m[2]) as { tasks: { summary: Record<string, unknown> } };
    Object.assign(data.tasks.summary, { ratio: 1.5, ratioSpread: { tasks: 6, median: 1.25, p25: 0.8, p75: 2.345, belowOne: 2 }, ratioLow: 0.6, ratioHigh: 3 });
    const copy = join(out, 'atlas-spread.html');
    await writeFile(copy, html.replace(m[0], `${m[1]}${serializeForScript(data)}${m[3]}`));
    await page.goto(pathToFileURL(copy).href);
    await panel().waitFor({ state: 'visible' });
    expect(await page.getByTestId('tasks-ratio').innerText()).toBe('1.5 倍');
    expect(await page.getByTestId('tasks-ratio-spread').innerText()).toBe('タスクごとの比: 中央値 1.25 倍(25〜75 パーセンタイル 0.8〜2.35 倍、6 件)。1 倍より小さい(AI を使った場合の方が長い)タスク 2 件');
    expect(await page.getByTestId('tasks-ratio-range').innerText()).toBe('推定の幅で見た比: 0.6〜3 倍');
    const defs = await page.getByTestId('tasks-ratio-spread-defs').innerText();
    expect(defs).toContain('人が AI を使わずに作業した時間の実測が無い');
    expect(defs).toContain('LLM の推定そのものが大きめか小さめかは、ここからは分かりません');
    // 狭い幅でもページがはみ出さない
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('a2. 全体サマリの表紙に、比べられる完了タスクと同じ範囲の 3 つの時間が並び(比は出さない)、絞り込みでは変わらない。狭い幅でも崩れない', async () => {
    await page.goto(server.url);
    const cover = page.getByTestId('cover-tasks');
    await cover.waitFor({ state: 'visible' });
    // タスクの節の欄と同じ値(数え直さない)
    expect(await page.getByTestId('cover-tasks-included').innerText()).toBe(await page.getByTestId('tasks-included').innerText());
    expect(await page.getByTestId('cover-tasks-work').innerText()).toBe('57 時間');
    expect(await page.getByTestId('cover-tasks-human').innerText()).toBe('40 時間');
    expect(await page.getByTestId('cover-tasks-active').innerText()).toBe('0.01 時間');
    const text = await cover.innerText();
    expect(text).toContain('タスクの所要');
    expect(text).not.toContain('倍');
    expect(text).not.toContain('÷');
    const note = await page.getByTestId('cover-tasks-note').innerText();
    expect(note).toContain('上の絞り込みに従いません');
    expect(note).toContain('合計が実際の勤務時間を超えることがあります');
    expect(note).toContain('月〜金 9:00〜18:00');
    expect(await page.getByTestId('cover-tasks-why').count()).toBe(0);
    // 表紙のほかの欄は絞り込みに従うが、タスクの工数は集計したときの値のまま
    await page.getByTestId('task-filter').selectOption('DEMO-102');
    await expect.poll(shown).toBe(1);
    expect(await page.getByTestId('cover-tasks-work').innerText()).toBe('57 時間');
    expect(await page.getByTestId('cover-tasks-included').innerText()).toBe('1');
    await page.getByTestId('task-filter').selectOption('');
    // 欄は表紙の格子の幅いっぱい(4 欄の下に 1 行)。390px でも 3 つの時間が欄の中に収まり、ページが横にはみ出さない
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const box = (await cover.boundingBox())!;
      const grid = (await page.locator('#overview .fields').boundingBox())!;
      expect(Math.abs(box.width - grid.width)).toBeLessThan(3);
      for (const id of ['cover-tasks-work', 'cover-tasks-human', 'cover-tasks-active']) {
        const v = (await page.getByTestId(id).boundingBox())!;
        expect(v.x).toBeGreaterThanOrEqual(box.x);
        expect(v.x + v.width).toBeLessThanOrEqual(box.x + box.width + 1);
      }
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await shots('cover-tasks', () => page.locator('#overview'), server.url);
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
    expect(await page.getByTestId('session-task').allInnerTexts()).toEqual(['DEMO-101 fix the app\n紐づけ: 機械']);
    expect(await page.getByTestId('session-task').getAttribute('title')).toBe('紐づけの理由: タスク名が依頼にある');
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
    // 紐づけが無いので札は無く、保存は押せない
    expect(await page.getByTestId('detail-task-chip').count()).toBe(0);
    expect(await page.getByTestId('detail-task-save').getAttribute('aria-disabled')).toBe('true');
    // 探す文字で候補を絞る(ID か名前の一部)
    await page.getByTestId('detail-task-search').fill('帳票');
    expect(await page.getByTestId('detail-task-select').locator('option').allInnerTexts()).toEqual(['帳票の出力を速くする(DEMO-103)']);
    // 合った数は、打ち終えてから状態の行で知らせる
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toBe('合うタスク 1 件。');
    await page.getByTestId('detail-task-search').fill('');
    await page.getByTestId('detail-task-select').selectOption('DEMO-103');
    // 加えるのは下書き(まだ保存しない)。加えたタスクは選択から消える
    await page.getByTestId('detail-task-add').click();
    expect(await page.getByTestId('detail-task-chip').allInnerTexts()).toEqual(['帳票の出力を速くする(DEMO-103)\n外す']);
    expect(await page.getByTestId('detail-task-msg').innerText()).toContain('まだ保存していません');
    expect(await page.getByTestId('detail-task-select').locator('option[value="DEMO-103"]').count()).toBe(0);
    expect((await links())[S_OTHER]).toBeUndefined();
    await page.getByTestId('detail-task-save').click();
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toContain('このタスクに紐づけました。');
    // 保存しても焦点は押したボタンに残り(押せない状態は aria-disabled)、Esc で閉じて「変える…」に戻る
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-save');
    expect(await page.getByTestId('detail-task-save').getAttribute('aria-disabled')).toBe('true');
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
    expect((await links())[S_OTHER]).toMatchObject({ taskIds: ['DEMO-103'], source: 'manual' });
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
    expect((await links())[S_OTHER]).toMatchObject({ taskIds: [], source: 'manual' });
    expect(await page.getByTestId('detail-task-none').getAttribute('aria-disabled')).toBe('true');
    // 押せない状態で押しても何もしない
    await page.getByTestId('detail-task-none').click({ force: true });
    expect((await links())[S_OTHER]).toMatchObject({ taskIds: [], source: 'manual' });
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

  it('c2. 詳細ページで 2 つ目のタスクを加えて保存すると両方が残り、一覧の「タスク」の列に出て並べ替えられる', async () => {
    // 機械で DEMO-101 に紐づいたセッションに、DEMO-103 を加える(下書きは今の紐づけから始まる)
    await page.goto(detailUrl(server, S_FIX));
    await page.getByTestId('detail-task-open').click();
    expect(await page.getByTestId('detail-task-chip').allInnerTexts()).toEqual(['fix the app(DEMO-101)\n外す']);
    // 機械の紐づけと同じ並びなら、手動として保存できる(出所を手動にする)
    expect(await page.getByTestId('detail-task-save').getAttribute('aria-disabled')).toBe('false');
    await page.getByTestId('detail-task-select').selectOption('DEMO-103');
    await page.getByTestId('detail-task-add').click();
    await page.getByTestId('detail-task-select').selectOption('DEMO-102');
    await page.getByTestId('detail-task-add').click();
    expect(await page.getByTestId('detail-task-chip').count()).toBe(3);
    // 外すと、焦点は次の札の「外す」に移る(最後の札なら探す欄)
    await page.getByTestId('detail-task-remove').nth(2).click();
    expect(await page.getByTestId('detail-task-chip').count()).toBe(2);
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-remove');
    expect(await page.evaluate<string | null | undefined>('document.activeElement?.getAttribute("aria-label")')).toBe('帳票の出力を速くする(DEMO-103)を外す');
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 390]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.getByTestId('detail-task').screenshot({ path: join(SHOTS, `m2m-detail-editor-${scheme}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await page.getByTestId('detail-task-save').click();
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toContain('2 つのタスクに紐づけました。');
    expect((await links())[S_FIX]).toMatchObject({ taskIds: ['DEMO-101', 'DEMO-103'], source: 'manual' });
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('detail-task-save');
    // 開き直しても両方が出て、等分の 1 行がある
    await page.goto(detailUrl(server, S_FIX));
    await page.getByTestId('detail-task').waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('detail-task-name').allInnerTexts()).toEqual(['fix the app(DEMO-101)', '帳票の出力を速くする(DEMO-103)']);
    expect(await page.getByTestId('detail-task-status').allInnerTexts()).toEqual(['状態: Completed(完了)', '状態: In Progress(未完了)']);
    expect(await page.getByTestId('detail-task-split').innerText()).toBe('2 つのタスクに紐づいています。実働と推定人手工数は、2 つのタスクで等分して数えます');
    if (SHOTS) await page.getByTestId('detail-task').screenshot({ path: join(SHOTS, 'm2m-detail-two-tasks-light-1440.png') });
    // 3 つ目も API で足して、一覧の列は 2 つまで出して「+1 件」、全部は title
    const put = (id: string, body: unknown): Promise<Response> =>
      fetch(server.url.replace(/atlas\.html$/, `api/tasks/links/${id}`), { method: 'PUT', headers: { 'content-type': 'application/json', 'x-atlas-token': server.token }, body: JSON.stringify(body) });
    expect((await put(S_OTHER, { taskIds: ['DEMO-103', 'DEMO-102', 'DEMO-104'] })).status).toBe(200);
    await page.goto(`${server.url}#tab=list`);
    await page.locator('#sessions').waitFor({ state: 'visible' });
    const head = page.locator('#sessions thead th', { hasText: 'タスク' });
    expect(await head.count()).toBe(1);
    const cell = (id: string) => page.locator('#sessions tbody tr', { has: page.locator(`a[href$="${id}.html"]`) }).getByTestId('session-task');
    await expect.poll(() => cell(S_OTHER).innerText()).toBe('DEMO-103 帳票の出力を速くする\nDEMO-102 Improve the synthetic project\n+1 件\n紐づけ: 手動');
    expect(await cell(S_OTHER).getAttribute('title')).toBe('タスク:\n帳票の出力を速くする · DEMO-103\nImprove the synthetic project · DEMO-102\n初めから完了していたタスク · DEMO-104');
    expect(await cell(S_FIX).innerText()).toBe('DEMO-101 fix the app\nDEMO-103 帳票の出力を速くする\n紐づけ: 手動');
    // 紐づけの無いセッションは「紐づけなし」
    expect(await page.getByTestId('session-task').allInnerTexts()).toContain('紐づけなし');
    // 列見出しで並べ替える: 初めは名前の昇順(fix < Improve < 帳票)、もう一度押すと逆。タスクの無いセッションはどちらでも後ろ
    const order = (): Promise<string[]> => page.locator('#sessions tbody tr td.name a').evaluateAll((as) => as.map((a) => (a as unknown as { href: string }).href.replace(/^.*\/|\.html$/g, '')));
    await head.getByRole('button').click();
    expect(await head.getAttribute('aria-sort')).toBe('ascending');
    expect((await order()).slice(0, 3)).toEqual([S_FIX, S_IMPROVE, S_OTHER]);
    await head.getByRole('button').click();
    expect(await head.getAttribute('aria-sort')).toBe('descending');
    const desc = await order();
    expect(desc.slice(0, 3)).toEqual([S_OTHER, S_IMPROVE, S_FIX]);
    expect(desc.length).toBeGreaterThan(3);
    if (SHOTS) {
      for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 390]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.locator('#sessions').scrollIntoViewIfNeeded();
        // 狭い幅では表を横に流して「タスク」の列を見せる
        await page.evaluate("(() => { const s = document.querySelector('#sessions .table-scroll'); const th = [...document.querySelectorAll('#sessions thead th')].find((x) => x.textContent.includes('タスク')); if (s && th && innerWidth < 768) s.scrollLeft = th.offsetLeft - 40; })()");
        await page.locator('#sessions .table-scroll').screenshot({ path: join(SHOTS, `m2m-session-list-${scheme}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
    }
    // 390px でも、ページが横にはみ出さない(表は枠の中で横に流す)
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    // タスクの節: 共有のセッションと等分の説明
    await page.goto(server.url);
    await panel().waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('tasks-table').locator('tr[data-task="DEMO-103"]').getByTestId('task-shared').innerText()).toBe('共有 2');
    expect(await page.getByTestId('tasks-split').innerText()).toContain('複数のタスクに紐づくセッションの実働時間と推定人手工数は、タスクの数で等分して数えます');
    expect(await page.getByTestId('tasks-split').innerText()).toContain('今は 2 セッションを複数のタスクに分けて数えています。');
    // タスクで絞り込むと、ほかのタスクにも紐づいたセッションも入る
    await page.getByTestId('task-filter').selectOption('DEMO-103');
    await expect.poll(shown).toBe(2);
    await page.getByTestId('task-filter').selectOption('');
    // タスクの一覧に無い ID(tasks.json から無くなったもの)が紐づけに残っていると: 詳細ページで印を付け、工数に数えず、
    // そのままでは保存できない(サーバはどの ID が無いかを書いて断り、画面はその文を出す)
    const file = join(notes, 'task-links.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { links: Record<string, unknown> };
    saved.links[S_OTHER] = { taskIds: ['DEMO-103', 'GONE-9'], source: 'manual', reason: '', at: '2026-11-23T00:00:00.000Z' };
    await writeFile(file, JSON.stringify(saved));
    await page.goto(detailUrl(server, S_OTHER));
    await page.getByTestId('detail-task').waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('detail-task-skip').allInnerTexts()).toEqual(['一覧にないタスク(工数に数えない)']);
    expect(await page.getByTestId('detail-task-split').innerText()).toBe('2 つのタスクに紐づいています。実働と推定人手工数は、1 つのタスクにだけ数えます(一覧に無いタスクと、完了を確認した後に始めたセッションのタスクには数えません)');
    await page.getByTestId('detail-task-open').click();
    expect(await page.getByTestId('detail-task-unknown').allInnerTexts()).toEqual(['一覧にないタスク']);
    // 一覧にある札を入れ替えて保存すると、無い ID を名指しで断る
    await page.getByTestId('detail-task-remove').first().click();
    await page.getByTestId('detail-task-select').selectOption('DEMO-102');
    await page.getByTestId('detail-task-add').click();
    await page.getByTestId('detail-task-save').click();
    await expect.poll(() => page.getByTestId('detail-task-err').innerText()).toContain('「GONE-9」');
    // 無い ID の札を外すと保存できる
    await page.getByLabel('GONE-9(GONE-9)を外す').click();
    await page.getByTestId('detail-task-save').click();
    await expect.poll(() => page.getByTestId('detail-task-msg').innerText()).toContain('このタスクに紐づけました。');
    expect((await links())[S_OTHER]).toMatchObject({ taskIds: ['DEMO-102'], source: 'manual' });
    // わざと断らせた応答のコンソールのエラーは数えない
    for (let i = problems.length - 1; i >= 0; i--) if (/status of 400/.test(problems[i])) problems.splice(i, 1);
    // 元に戻す(次のタスクの紐づけのテストの件数を変えない)
    expect((await put(S_OTHER, { auto: true })).status).toBe(200);
    expect((await put(S_FIX, { auto: true })).status).toBe(200);
    expect((await links())[S_FIX]).toMatchObject({ taskIds: ['DEMO-101'], source: 'machine' });
    expect((await links())[S_OTHER]).toBeUndefined();
  });

  it('d. 「判定する…」の「タスクの紐づけ」: チャットに貼る手順で、紐づけの無いセッションの添付ファイルを作り、返答を取り込むと LLM の紐づけが出る', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin });
    await page.goto(server.url);
    // このツールの中で LLM を呼ぶボタンは無い
    expect(await page.getByTestId('job-task-link').count()).toBe(0);
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    // タスクの設定があるので「タスクの紐づけ」を選べる。方法はチャットと ZIP の 2 つだけ
    await page.getByTestId('judge-target-tasks').check();
    await page.getByTestId('judge-method-chat').check();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
    expect(await dialog.locator('input[name="judge-method"]').evaluateAll((xs) => xs.map((x) => (x as unknown as { value: string }).value))).toEqual(['chat', 'zip']);
    expect(await page.getByTestId('chat-target-note').innerText()).toContain('手で決めた紐づけと、前に LLM で決めた紐づけは変えません');
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toMatch(/^紐づけの無い (\d+) 件で作る$/);
    const n = Number(/(\d+) 件/.exec(await page.getByTestId('chat-bundle').innerText())![1]);
    expect(n).toBeGreaterThan(0);
    await page.getByTestId('chat-bundle').click();
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 }).toMatch(/紐づけの無いものだけ、\d+ ファイル/);
    // 候補の ID は manifest.json でなく candidates.json にある(manifest.json は件数とファイルの一覧だけ)
    const raw = JSON.parse(await readFile(join(out, 'task-bundle', 'manifest.json'), 'utf8')) as { count: number; sessions: { id: string; candidates?: string[] }[] };
    const cands = JSON.parse(await readFile(join(out, 'task-bundle', 'candidates.json'), 'utf8')) as { sessions: Record<string, string[]> };
    expect(raw.sessions.every((s) => s.candidates === undefined)).toBe(true);
    const m = { ...raw, sessions: raw.sessions.map((s) => ({ id: s.id, candidates: cands.sessions[s.id] })) };
    expect(m.count).toBe(n);
    // 機械で紐づいたセッションは入れない
    expect(m.sessions.map((s) => s.id)).not.toContain(S_FIX);
    expect(m.sessions.map((s) => s.id)).toContain(S_OTHER);
    const save = page.getByTestId('chat-save');
    expect(await save.getAttribute('download')).toBe('tasks-part-01.txt');
    expect(await save.getAttribute('href')).toBe('task-bundle/parts/part-01.md');
    await page.getByRole('button', { name: '本文をコピー' }).click();
    await expect.poll(() => page.getByText('tasks-part-01 の本文をコピーしました。').count()).toBe(1);
    const text = await page.evaluate<string>('navigator.clipboard.readText()');
    expect(text).toContain('# 管理ツールのタスクへの紐づけの指示(分割 1 /');
    expect(text).toContain(`- セッション ID: ${m.sessions[0].id}`);
    // 候補に無い ID だけの答えは取り込まず、直す点を出す
    const reply = page.getByTestId('chat-reply');
    const other = m.sessions.find((s) => s.id === S_OTHER)!;
    await reply.fill('```json\n' + JSON.stringify({ links: [{ sessionId: S_OTHER, taskIds: ['NOT-A-TASK'], confidence: 0.5 }] }) + '\n```');
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-error').innerText()).toContain('紐づけの形式に合いません');
    expect(await page.getByTestId('chat-import-error').innerText()).toContain('候補に無いタスクの ID です: NOT-A-TASK');
    expect(await page.getByRole('button', { name: '直す点をコピー' }).count()).toBe(1);
    for (let i = problems.length - 1; i >= 0; i--) if (/status of 400/.test(problems[i])) problems.splice(i, 1);
    // 束を作った後に、ほかのセッションの 1 つを手で紐づけた(取り込みで書き換えず、未判定の数にも入れない)
    const manual = m.sessions.find((s) => s.id !== S_OTHER);
    if (manual) {
      const put = await fetch(server.url.replace(/atlas\.html$/, `api/tasks/links/${manual.id}`), { method: 'PUT', headers: { 'content-type': 'application/json', 'x-atlas-token': server.token }, body: JSON.stringify({ taskIds: [manual.candidates[0]] }) });
      expect(put.status).toBe(200);
    }
    // 正しい答え: S_OTHER を候補の先頭に(候補に無い ID も混ぜる。除いて知らせる)、ほかは「どのタスクでもない」
    const links = m.sessions.map((s) => (s.id === S_OTHER ? { sessionId: s.id, taskIds: [other.candidates[0], 'NOT-A-TASK'], confidence: 0.7, reason: 'テスト用の答え' } : { sessionId: s.id, taskIds: [], confidence: 0.9, reason: 'どれでもない' }));
    await reply.fill(`決めました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, links })}\n\`\`\``);
    await page.getByTestId('chat-import').click();
    const kept = manual ? 1 : 0;
    await expect
      .poll(() => page.getByTestId('chat-import-result').innerText())
      .toBe(`${links.length - kept} セッションの紐づけを取り込みました${kept ? `(紐づけがもうあるので書かなかったセッション ${kept} 件。理由は下に出します)` : ''}。`);
    // 除いた ID と書かなかったセッションの知らせを、結果の下に出す
    const notices = await page.getByTestId('chat-import-notices').innerText();
    expect(notices).toContain(`セッション ${S_OTHER}: 候補に無いタスクの ID を除きました: NOT-A-TASK`);
    if (manual) expect(notices).toContain(`手動で紐づけてあるので書かなかったセッション 1 件: ${manual.id}`);
    // 未判定(紐づけの無い)の数は数え直す(手で紐づけたセッションも数えない)
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toBe('紐づけの無いセッションはありません');
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toMatch(/取り込み済み \d+ \/ \d+ ファイル/);
    expect((await (async () => (JSON.parse(await readFile(join(notes, 'task-links.json'), 'utf8')) as Links).links)())[S_OTHER]).toMatchObject({ taskIds: [other.candidates[0]], source: 'llm' });
    await page.getByTestId('chat-reflect').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await panel().waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('tasks-table').innerText()).toContain('LLM');
    // 頼むセッションが無くなったので、作るボタンは押せない
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('judge-target-tasks').check();
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toBe('紐づけの無いセッションはありません');
    expect(await page.getByTestId('chat-bundle').isDisabled()).toBe(true);
    // 後のテストのために工数に戻す
    await page.getByTestId('judge-target-effort').check();
    await page.getByTestId('judge-close').click();
    await dialog.waitFor({ state: 'hidden' });
  });

  it('d3. 「タスクの紐づけ」: 作ろうとしたときに頼むセッションが無くなっていたら、作り直さなかったことと、前のものを使えることを出す', async () => {
    // 作る処理の答えを差し替える(開いたときは 1 件あったが、作る処理が見たときには紐づいていた)
    const at = new Date().toISOString();
    const job = (st: 'running' | 'done') => ({ id: 'fake-none', kind: 'task-bundle', state: st, startedAt: at, endedAt: st === 'running' ? null : at, exitCode: st === 'running' ? null : 0, log: st === 'running' ? [] : ['tasks bundle: LLM に頼むセッションはありません(紐づけの無いセッションがありません)。前に作った束はそのまま残します'], target: {} });
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    let posted = false;
    await page.route(/\/api\/jobs\/judge-preview/, (r) => r.fulfill(json({ eligible: 1, judged: 0, pending: 1 })));
    await page.route(/\/api\/jobs$/, (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      posted = true;
      return r.fulfill(json(job('running')));
    });
    await page.route(/\/api\/jobs\/current$/, (r) => (posted ? r.fulfill(json(job('done'))) : r.continue()));
    try {
      await page.goto(server.url);
      await page.getByTestId('job-judge').click();
      await page.getByTestId('judge-dialog').waitFor({ state: 'visible' });
      await page.getByTestId('judge-target-tasks').check();
      await page.getByTestId('judge-method-chat').check();
      // d の束が残っているので「作り直す」
      await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toBe('作り直す(紐づけの無い 1 件。ファイルの番号が振り直されます)');
      expect(await page.getByTestId('chat-bundle-none').count()).toBe(0);
      await page.getByTestId('chat-bundle').click();
      await expect.poll(() => page.getByTestId('chat-bundle-none').innerText(), { timeout: 30_000 }).toBe('紐づけの無いセッションが無かったので、作り直していません。前に作った添付ファイルは、そのまま使えます。');
      expect(await page.getByTestId('chat-bundle-failed').count()).toBe(0);
      await page.getByTestId('judge-target-effort').check();
      await page.getByTestId('judge-close').click();
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  it('e. 送った先を開いた読むだけの画面: タスクの節と絞り込みは出るが、変える操作は出ず、判定のダイアログに「タスクの紐づけ」は出ない', async () => {
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
    // 表紙: 比べられる完了タスクが 0 件なので、時間は「—」で、件数 0 と理由(タスクの節の欄と同じ文)を出す
    expect(await page.getByTestId('cover-tasks-included').innerText()).toBe('0');
    for (const id of ['cover-tasks-work', 'cover-tasks-human', 'cover-tasks-active']) expect(await page.getByTestId(id).innerText()).toBe('—');
    const why = await page.getByTestId('cover-tasks-why').innerText();
    expect(why).toMatch(/^セッションが紐づいたタスク \d+ 件のうち。/);
    expect(await panel().innerText()).toContain(why);
    expect(await page.getByTestId('tasks-table').locator('tbody tr').evaluateAll((trs) => trs.map((tr) => (tr as unknown as { dataset: Record<string, string> }).dataset.task))).toEqual(['DEMO-101']);
    expect(await page.getByTestId('tasks-table').innerText()).toContain('57 時間');
    await page.getByTestId('task-filter').selectOption('DEMO-101');
    await expect.poll(shown).toBe(1);
    // 紐づけは送った人のもの: 判定のダイアログに「タスクの紐づけ」を出さない
    await page.getByTestId('job-judge').click();
    await page.getByTestId('judge-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('judge-target-effort').waitFor({ state: 'visible' });
    expect(await page.getByTestId('judge-target-tasks').count()).toBe(0);
    await page.getByTestId('judge-close').click();
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
