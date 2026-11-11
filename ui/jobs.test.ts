// Phase 14 の画面の操作(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
//  e. 「集計し直す」→ 帯が実行中から完了に変わり、「再読み込み」で新しい集計(埋め込みの生成日時)が出て帯は消える
//  f. 「判定する…」の確認ダイアログ: 「やめる」なら API を呼ばない。件数を決めて実行すると偽 copilot で判定が増える
//  f2. 「チャットに貼る」: 添付ファイルを作り、保存のリンクと本文のコピーが働き、形の違う返答は理由を出して取り込まず、正しい返答を取り込んで反映できる
//  g. 詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ、記録に混ぜた script やイベント属性は実行されない
//  h. file:// で開いた atlas.html と詳細ページには操作が出ない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
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
  // 落ちたらその時点の画面を out/ui-failures/ に残す(CI は成果物として上げる)
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    // 次のテストに持ち越さない(1 つの失敗が後のテストを全部落とさないように)
    expect(problems.splice(0)).toEqual([]);
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
    await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(/未判定のセッション \d+ 件のうち 10 件を判定します/);
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
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'judge', limit: 2 }]);
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    const j = JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: unknown[] };
    expect(j.items).toHaveLength(2);
    expect((await readFile(fakeLog, 'utf8')).trim().split('\n')).toHaveLength(2);
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await expect.poll(() => page.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).judgments.items")).toBe(2);
  });

  it('f2. 「チャットに貼る」: 添付ファイルを作り、返答を貼って取り込み、レポートに反映する', async () => {
    jobPosts.length = 0;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin });
    await page.goto(server.url);
    const judgedBefore = await page.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).judgments.items");
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('judge-method-chat').check();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
    // チャットではクレジットの注意を出さない
    expect(await dialog.innerText()).not.toContain('AI クレジットを消費します');
    // f. の判定で全件の添付ファイルができているので「作り直す」になる
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toMatch(/^作り直す\(未判定 \d+ 件。ファイルの番号が振り直されます\)$/);
    await page.getByTestId('chat-bundle').click();
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 }).toMatch(/未判定だけ、\d+ ファイル/);
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'bundle' }]);
    // 終わったことはダイアログの手順 1 が示すので、裏の帯には出さない(レポートは変わっていないので「再読み込み」も出さない)
    await expect.poll(() => band().getAttribute('data-state')).toBe('');
    expect(await page.getByTestId('job-reload').count()).toBe(0);

    const save = page.getByTestId('chat-save');
    expect(await save.getAttribute('download')).toBe('part-01.txt');
    expect(await save.getAttribute('href')).toBe('bundle/parts/part-01.md');
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    expect(download.suggestedFilename()).toBe('part-01.txt');
    await page.getByRole('button', { name: '本文をコピー' }).click();
    await expect.poll(() => page.getByText('part-01 の本文をコピーしました。').count()).toBe(1);
    const text = await page.evaluate<string>('navigator.clipboard.readText()');
    const ids = [...text.matchAll(/^# 評価パケット: セッション (\S+)$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);

    // 形の違う返答は何も取り込まず、どこが違うかを出す
    const reply = page.getByTestId('chat-reply');
    await reply.fill('```json\n{"items":[{"sessionId":"' + ids[0] + '","taskCategory":"nope"}]}\n```');
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-error').innerText()).toContain('何も取り込んでいません');
    // 何件目のどのセッションの、どの欄かを出す
    expect(await page.getByTestId('chat-import-error').locator('li').first().innerText()).toContain(`1 件目(セッション ${ids[0]})の `);
    expect(await reply.getAttribute('aria-invalid')).toBe('true');
    // 取り込めなかった要求(400)はブラウザがコンソールに出す。想定どおりの 1 件だけ除く
    const expected = problems.findIndex((p) => /status of 400/.test(p));
    expect(expected).toBeGreaterThanOrEqual(0);
    problems.splice(expected, 1);

    const item = (id: string) => ({
      sessionId: id,
      taskCategory: 'bugfix',
      taskSummary: 'チャットで判定',
      humanEffort: { hours: 1.5, low: 1, high: 3, confidence: 0.4, rationale: '根拠' },
      aiOutcome: { completed: true, quality: 3, rework: 1, rationale: '成果' },
      instructionsEffect: { score: 0, evidence: '参照なし' },
      wikiEffect: { score: 0, evidence: '参照なし' },
      skillsAgentsEffect: { score: 0, evidence: '参照なし' },
    });
    await reply.fill(`判定しました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: null, ranAt: null }, items: ids.map(item) })}\n\`\`\``);
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-result').innerText()).toBe(`${ids.length} 件を取り込みました。`);
    expect(await reply.inputValue()).toBe('');
    // 送信ボタンが無効になっても焦点は消えず、結果の文に移る
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('chat-import-result');
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toMatch(/取り込み済み 1 \//);

    await page.getByTestId('chat-reflect').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'bundle' }, { kind: 'export' }]);
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await expect.poll(() => page.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).judgments.items")).toBe(judgedBefore + ids.length);
    // 選んだ方法はこのブラウザに覚える
    await page.getByTestId('job-judge').click();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
    // 初期フォーカスは表題の横の「閉じる」で、開いたときは表題から見える
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('judge-close');
    expect(await dialog.evaluate((d) => d.scrollTop)).toBe(0);
    await page.getByTestId('chat-close').click();
    await dialog.waitFor({ state: 'hidden' });
  });

  it('f3. 「依頼ごとの採用」: GitHub Copilot CLI(偽)で依頼を判定し、「工程と詰まり」に採用の表が出る。詳細ページにも判定の列が出る', async () => {
    jobPosts.length = 0;
    await page.goto(server.url);
    expect(await page.getByTestId('verdicts-none').count()).toBe(1);
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('judge-target-turns').check();
    // f2 でチャットを選んだので、このツールの判定に戻す
    await page.getByTestId('judge-method-tool').check();
    await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(/未判定の依頼 \d+ 件のうち \d+ 件を判定します\(約 \d+ 回以上の判定。/);
    // 判定に使うものは copilot -p だけ(選ぶ欄は無い)
    expect(await dialog.locator('input[name="judge-backend"]').count()).toBe(0);
    expect(await dialog.getByText('判定に使うもの: GitHub Copilot CLI(copilot -p)').count()).toBe(1);
    await page.getByTestId('judge-limit').fill('3');
    await page.getByTestId('judge-run').click();
    await dialog.waitFor({ state: 'hidden' });
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'turn-judge', limit: 3 }]);
    await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    const table = page.getByTestId('verdict-table');
    await table.waitFor({ state: 'visible' });
    expect(await table.locator('tbody th').first().innerText()).toBe('実装');
    expect(await page.getByTestId('mismatch-table').innerText()).toContain('意図・要件の取り違え');
    // 判定した依頼のあるセッションの詳細ページに、採用・合わなかった点・工程(普段)の列
    // 埋め込みの要約は href を持たない(id から作る。report の lib/pack.ts)
    const id = await page.evaluate<string>("JSON.parse(document.getElementById('atlas-data').textContent).sessions.find((s) => s.turnVerdicts && s.turnVerdicts.length).id");
    await page.goto(new URL(`sessions/${id}.html`, server.url).href);
    const turns = page.locator('table.turns');
    await turns.waitFor({ state: 'visible' });
    expect(await turns.locator('thead').innerText()).toMatch(/採用\(LLM\)\s*合わなかった点\s*工程\(普段\)/);
    expect(await turns.locator('tbody').innerText()).toMatch(/そのまま採用|中身を修正して採用/);
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
