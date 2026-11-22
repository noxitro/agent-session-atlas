// Phase 14 の画面の操作(Playwright の Chromium)。架空の fixture で atlas all → atlas serve(port 0)を立て、実際に押して確かめる。
//  e. 「集計し直す」→ 帯が実行中から完了に変わり、「再読み込み」で新しい集計(埋め込みの生成日時)が出て帯は消える
//  f. 「判定する…」の確認ダイアログ: 「やめる」なら API を呼ばない。件数を決めて実行すると偽 copilot で判定が増える。タスクタグを選んでいなければ、対象は「すべて」だけ
//  f1. 「チャットに貼る」: 作り直しに失敗したら、ダイアログに失敗・理由・ログが出て、前に作った添付ファイルはそのまま使える。閉じたらもう出ない
//  f1b. 「チャットに貼る」: 作るのを止めたら、止めたことと、使える添付ファイルがあるかが出る。この画面で動くのを見ていない処理は出ない
//  f2. 「チャットに貼る」: 添付ファイルを作り、保存のリンクと本文のコピーが働き、形の違う返答は理由を出して取り込まず、正しい返答を取り込んで反映できる
//  f2b. 「チャットに貼る」(依頼ごとの採用): 採用を判定できる依頼が先頭の何ファイルまでかが出て、一覧の最後の依頼だけのファイルに印が付く
//  f2c. 「ZIP にまとめてエージェントに渡す」: 依頼ごとの判定では選べない。工数では ZIP を作って保存でき、結果のファイルを選んで取り込める。添付ファイルを作り直すと ZIP は消える
//  f3. 「依頼ごとの採用」を偽 copilot で判定すると、一覧の依頼の欄に判定の済み・未判定が出る。詳細ページに判定したかの札と判定のボタンが出て、そのセッションの残りの依頼だけを判定できる
//  f4. タスクタグを選んで開くと、対象がそのタグのセッションだけになり、判定もそのタグのセッションだけにする
//  f5. 詳細ページの判定: 進み具合の確認が途中で失敗(通信の失敗・5xx)しても、待ち続けて終わりまで出す
//  f6. 詳細ページの判定: 押したら件数を数え直す。開いた後に判定済みになっていれば判定し直す(force)、対象が無くなっていれば送らない
//  f7. 詳細ページの判定: 数え直しで依頼ごとの件数だけ読めなければ失敗と出す。確かめで取りやめても「読み込み直す」は残る
//  g. 詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ、記録に混ぜた script やイベント属性は実行されない
//  h. file:// で開いた atlas.html と詳細ページには操作が出ない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Dialog, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURE_CODE, ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-jobs');
const FAKE = join(FIXTURE_CODE, 'fake-copilot.mjs');
const EVIL = '\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 2">\n\n[危ない](javascript:window.__pwned=3)\n';

describe('画面からの操作(Phase 14)', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const fakeLog = join(WORK, 'fake-copilot.log');
  const configPath = join(WORK, 'atlas.config.json');
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
    const r = spawnSync(...cliCommand(['all', '--home', home, '--out', out, '--notes-dir', notes]), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    // 設定ファイルはテスト用の場所(リポジトリの atlas.config.json を読まない)。判定には自分の API キーのモデル(BYOK)を使う設定にする
    await writeFile(configPath, JSON.stringify({ judgeModel: 'anthropic/claude-sonnet-5-5' }));
    server = await startServer({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      configPath,
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
    // 設定の judgeModel が BYOK なので、Copilot の AI クレジットではなく API の利用料だと出す
    await expect.poll(() => page.getByTestId('judge-model').innerText()).toBe('モデル: anthropic/claude-sonnet-5-5(自分の API キー・BYOK)(atlas.config.json の judgeModel)');
    expect(await dialog.innerText()).toContain('API の利用料がかかります');
    expect(await dialog.innerText()).toContain('GitHub Copilot の AI クレジットは使いません');
    expect(await dialog.innerText()).not.toContain('AI クレジットを消費します');
    // タスクタグを選ばずに開いたので、対象は「すべて」。タグに絞る選択肢は押せず、押せない理由を文で出す
    expect(await page.getByTestId('judge-scope-all').isChecked()).toBe(true);
    expect(await page.getByTestId('judge-scope-group').isDisabled()).toBe(true);
    expect(await page.getByTestId('judge-scope-group').getAttribute('aria-describedby')).toBe('judge-scope-off');
    expect(await page.getByTestId('judge-scope-off').innerText()).toContain('詳細ページから判定できます');
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
    const calls = (await readFile(fakeLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[] });
    expect(calls).toHaveLength(2);
    // 画面からの判定にも、設定のモデルを渡す(渡さないと Copilot の既定のモデルで AI クレジットを使う)
    for (const c of calls) expect(c.argv[c.argv.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-5-5');
    await page.getByTestId('job-reload').click();
    await page.waitForLoadState('load');
    await expect.poll(() => page.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).judgments.items")).toBe(2);
  });

  const openChat = async (): Promise<void> => {
    await page.getByTestId('job-judge').click();
    await page.getByTestId('judge-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('judge-method-chat').check();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
  };

  it('f1. 「チャットに貼る」: 作り直しに失敗したら、ダイアログに失敗と理由とログを出す(裏の帯には出ない)。前に作った添付ファイルはそのまま使え、閉じたらもう出さない', async () => {
    const dialog = page.getByTestId('judge-dialog');
    const state = page.getByTestId('chat-bundle-state');
    const failed = page.getByTestId('chat-bundle-failed');
    await page.goto(server.url);
    await openChat();
    // 先に 1 度作る(ほかのテストが作ったものに頼らない)
    await expect.poll(() => page.getByTestId('chat-bundle').isEnabled()).toBe(true);
    await page.getByTestId('chat-bundle').click();
    await expect.poll(() => state.innerText(), { timeout: 60_000 }).toMatch(/未判定だけ、\d+ ファイル/);
    const before = await state.innerText();
    const save = await page.getByTestId('chat-save').getAttribute('href');
    expect(await failed.count()).toBe(0);

    // 作る処理(子プロセス)だけが読むスナップショットの DB を壊して、失敗させる(画面とサーバは読まない。OS によらず失敗する)
    const db = join(out, 'snapshot', 'session-store.db');
    const aside = `${db}.aside`;
    let moved = false;
    try {
      if (existsSync(db)) {
        await rename(db, aside);
        moved = true;
      }
      await writeFile(db, 'データベースではない');
      await page.getByTestId('chat-bundle').click();
      await failed.waitFor({ state: 'visible', timeout: 60_000 });
      expect(await failed.getAttribute('role')).toBe('alert');
      const text = await failed.innerText();
      expect(text).toMatch(/添付ファイルを作れませんでした\(終了コード 1\)。/);
      expect(text).toContain('前に作った添付ファイルは、そのまま使えます');
      // 理由は処理が書いた文(先頭の「atlas: 失敗しました: 」は除く)
      const reason = await page.getByTestId('chat-bundle-reason').innerText();
      expect(reason).toMatch(/^理由: \S/);
      expect(reason).not.toContain('atlas: 失敗しました');
      // ログは 1 行でも開ける
      await failed.locator('summary').click();
      expect(await failed.locator('pre').innerText()).toContain('atlas: 失敗しました: ');
      // 前に作ったものが残っていて、作りかけは残らない。もう一度押せる
      await expect.poll(() => state.innerText()).toBe(before);
      expect(await page.getByTestId('chat-save').getAttribute('href')).toBe(save);
      expect(existsSync(join(out, 'bundle', save!.replace(/^bundle\//, '')))).toBe(true);
      expect(existsSync(join(out, 'bundle', '.next'))).toBe(false);
      expect(await page.getByTestId('chat-bundle').isEnabled()).toBe(true);
      await expect.poll(() => band().getAttribute('data-state')).toBe('');

      // 閉じて開き直したら、もう出さない(サーバの最後の処理は失敗のまま)
      await page.getByTestId('judge-close').click();
      await dialog.waitFor({ state: 'hidden' });
      await openChat();
      await expect.poll(() => state.innerText()).toBe(before);
      expect(await failed.count()).toBe(0);
      // 読み込み直した画面でも出さない(この画面で動くのを見ていない処理)
      await page.goto(server.url);
      await openChat();
      await expect.poll(() => state.innerText()).toBe(before);
      expect(await failed.count()).toBe(0);
    } finally {
      await rm(db, { force: true });
      if (moved) await rename(aside, db);
    }
  });

  it('f1b. 「チャットに貼る」: 作るのを止めたら、止めたことと、使える添付ファイルがあるかを出す', async () => {
    // 作る処理はすぐ終わって止める間が無いので、サーバの返事を差し替える(始めたら動いていて、次に読むと止められている。添付ファイルはまだ無い)
    const at = new Date().toISOString();
    const job = (st: 'running' | 'canceled') => ({ id: 'fake-canceled', kind: 'bundle', state: st, startedAt: at, endedAt: st === 'running' ? null : at, exitCode: null, log: st === 'running' ? [] : ['止めています…'], target: {} });
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route(/\/api\/jobs$/, (r) => (r.request().method() === 'POST' ? r.fulfill(json(job('running'))) : r.continue()));
    await page.route(/\/api\/jobs\/current$/, (r) => r.fulfill(json(job('canceled'))));
    await page.route(/\/api\/judge\/parts(\?|$)/, (r) => r.fulfill(json({ exists: false })));
    try {
      await page.goto(server.url);
      await openChat();
      const failed = page.getByTestId('chat-bundle-failed');
      await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toContain('まだ作っていません');
      // サーバの最後の処理は「止められた」だが、この画面で動くのを見ていないので出さない
      await page.waitForTimeout(300);
      expect(await failed.count()).toBe(0);
      await page.getByTestId('chat-bundle').click();
      await failed.waitFor({ state: 'visible', timeout: 30_000 });
      const text = await failed.innerText();
      expect(text).toContain('添付ファイルの作成を止めました。使える添付ファイルはまだありません。もう一度作ってください。');
      expect(text).not.toContain('そのまま使えます');
      await failed.locator('summary').click();
      expect(await failed.locator('pre').innerText()).toBe('止めています…');
      expect(await page.getByTestId('chat-bundle').isEnabled()).toBe(true);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
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
    // 添付ファイルがもうある(f. の判定が全件で作る)ので「作り直す」になる
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toMatch(/^作り直す\(未判定 \d+ 件。ファイルの番号が振り直されます\)$/);
    await page.getByTestId('chat-bundle').click();
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 }).toMatch(/未判定だけ、\d+ ファイル/);
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'bundle' }]);
    // 失敗の表示は出ていない
    expect(await page.getByTestId('chat-bundle-failed').count()).toBe(0);
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
    // 返答を保存したファイルを選ぶと、中身が欄に入る(取り込むのは「取り込む」を押してから)
    const saved = JSON.stringify({ items: [item(ids[0])] });
    await page.getByTestId('chat-reply-file').setInputFiles({ name: 'judgments.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect.poll(() => reply.inputValue()).toBe(saved);
    expect(await page.getByTestId('chat-reply-file-note').innerText()).toContain('judgments.json を読み込みました');
    expect(await page.getByTestId('chat-import-error').count()).toBe(0);
    await page.getByTestId('chat-reply-file').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('  ') });
    await expect.poll(() => page.getByTestId('chat-reply-file-error').innerText()).toBe('empty.txt を読み込めませんでした: 中身が空です');
    expect(await reply.inputValue()).toBe(saved);

    await reply.fill(`判定しました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: null, ranAt: null }, items: ids.map(item) })}\n\`\`\``);
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-result').innerText()).toBe(`${ids.length} 件を取り込みました。`);
    expect(await reply.inputValue()).toBe('');
    // 送信ボタンが無効になっても焦点は消えず、結果の文に移る
    expect(await page.evaluate<string | undefined>('document.activeElement?.dataset.testid')).toBe('chat-import-result');
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toMatch(/取り込み済み 1 \//);
    // 取り込んだ後も、M365 Copilot の自動の判定の欄は残る(サーバが Windows で、まだ渡すファイルがあるとき)
    if (process.platform === 'win32' && (await page.getByTestId('chat-save').count()) > 0) expect(await page.getByTestId('chat-m365').count()).toBe(1);

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

  it('f2b. 「チャットに貼る」(依頼ごとの採用): 採用を判定できる依頼が先頭の何ファイルまでかを出し、一覧で最後の依頼だけのファイルに印を付ける', async () => {
    await page.goto(server.url);
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByTestId('judge-target-turns').check();
    await page.getByTestId('judge-method-chat').check();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
    await expect.poll(() => page.getByTestId('chat-bundle').isEnabled()).toBe(true);
    await page.getByTestId('chat-bundle').click();
    // 依頼の判定がまだ 1 件も無いので、未判定だけで作っても「全件」と出る
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 }).toMatch(/全件、\d+ ファイル/);
    const m = JSON.parse(await readFile(join(out, 'turn-bundle', 'manifest.json'), 'utf8')) as { count: number; parts: unknown[]; decidable: { turns: number; parts: number } };
    // fixture には、依頼が 2 件以上のセッション(判定できる依頼)と、どのセッションにもある最後の依頼の両方がある
    expect(m.decidable.turns).toBeGreaterThan(0);
    expect(m.parts.length).toBeGreaterThan(m.decidable.parts);
    const note = await page.getByTestId('chat-decidable').innerText();
    expect(note).toContain(`採用を判定できる依頼(次の依頼がある依頼)は ${m.decidable.turns} 件で、先頭の ${m.decidable.parts} ファイルに入っています`);
    expect(note).toContain(`その後ろの ${m.parts.length - m.decidable.parts} ファイルはセッションの最後の依頼だけ`);
    // 次に渡すのは先頭のファイル(判定できる依頼)なので、「ここで止められる」の案内はまだ出ない
    expect(await page.getByTestId('chat-save').getAttribute('href')).toBe('turn-bundle/parts/part-01.md');
    expect(await page.getByTestId('chat-next-last-only').count()).toBe(0);
    // 一覧では、先頭のファイルの後ろに「最後の依頼だけ」の印
    await dialog.locator('details.list summary').click();
    const rows = dialog.locator('details.list tbody tr');
    expect(await rows.count()).toBe(m.parts.length);
    const marked = (await rows.allInnerTexts()).map((t) => t.includes('最後の依頼だけ'));
    expect(marked).toEqual(m.parts.map((_, i) => i >= m.decidable.parts));
    await page.getByTestId('chat-close').click();
    await dialog.waitFor({ state: 'hidden' });
  });

  it('f2c. 「ZIP にまとめてエージェントに渡す」: 依頼ごとの判定では選べない。工数では ZIP を作って保存でき、結果のファイルを取り込める', async () => {
    jobPosts.length = 0;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(server.url).origin });
    await page.goto(server.url);
    const dialog = page.getByTestId('judge-dialog');
    await page.getByTestId('job-judge').click();
    await dialog.waitFor({ state: 'visible' });
    // 依頼ごとの判定には ZIP が無い: 選べず、理由をすぐ下に出す
    await page.getByTestId('judge-target-turns').check();
    const zipMethod = page.getByTestId('judge-method-zip');
    expect(await zipMethod.isDisabled()).toBe(true);
    expect(await zipMethod.getAttribute('aria-describedby')).toBe('judge-zip-off');
    expect(await page.getByTestId('judge-zip-off').innerText()).toContain('どの LLM にもそのまま渡せます');
    await page.getByTestId('judge-target-effort').check();
    expect(await page.getByTestId('judge-zip-off').count()).toBe(0);
    await zipMethod.check();
    await page.getByTestId('chat-judge').waitFor({ state: 'visible' });
    // 注意: 渡してよい相手かと、エージェントに許可しないもの。クレジットの注意は出さない
    expect(await page.getByTestId('chat-zip-caution').innerText()).toContain('シェルの実行と Web へのアクセスを許可せず');
    expect(await page.getByTestId('chat-zip-caution').innerText()).toContain('ファイルの書き込みを許可するのは、結果を書く judgments.json だけ');
    expect(await dialog.innerText()).not.toContain('AI クレジットを消費します');
    // 添付ファイルはあっても(f2)、ZIP はまだ作っていない。M365 の自動の判定とファイルの一覧は出さない
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toBe('まだ作っていません。');
    expect(await page.getByTestId('chat-next').innerText()).toBe('先に ZIP を作ってください。');
    expect(await page.getByTestId('chat-zip-save').count()).toBe(0);
    expect(await page.getByTestId('chat-m365').count()).toBe(0);
    await expect.poll(() => page.getByTestId('chat-bundle').innerText()).toMatch(/^未判定 \d+ 件で ZIP を作る$/);
    expect(await page.getByTestId('chat-zip-side').innerText()).toContain('添付ファイルも、同じ未判定のセッションで作り直されます');
    await page.getByTestId('chat-bundle').click();
    await expect
      .poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 })
      .toMatch(/^作成済み: .+\(未判定だけ、\d+ 件、[\d.]+\s(KB|MB)\)。取り込み済み 0 \/ \d+ 件。次の手順 2 へ進んでください。$/);
    expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'bundle-zip' }]);
    expect(await page.getByTestId('chat-bundle-failed').count()).toBe(0);
    // 終わったことは手順 1 が示すので、裏の帯には出さない
    await expect.poll(() => band().getAttribute('data-state')).toBe('');

    // 保存のリンク。保存したものは ZIP。出力先の中の場所(フルパス)は出さない
    const save = page.getByTestId('chat-zip-save');
    expect([await save.getAttribute('href'), await save.getAttribute('download')]).toEqual(['bundle.zip', 'bundle.zip']);
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    expect(download.suggestedFilename()).toBe('bundle.zip');
    const zipBytes = await readFile(await download.path());
    expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipBytes.equals(await readFile(join(out, 'bundle.zip')))).toBe(true);
    expect(await page.getByTestId('chat-judge').innerText()).not.toContain(join('ui-jobs', 'out'));
    // 依頼文は、結果を展開したフォルダの中のファイルに書かせる(ターミナルの返答を写すと、行の折り返しで JSON が壊れる)。書けない相手への頼み方は補足に出す
    const request = 'bundle フォルダの INSTRUCTIONS.md に従って判定し、結果を bundle フォルダの中の judgments.json に書いてください。';
    expect(await page.getByTestId('chat-request').innerText()).toBe(request);
    await page.getByRole('button', { name: '依頼文をコピー' }).click();
    await expect.poll(() => page.getByText('依頼文をコピーしました。').count()).toBe(1);
    expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(request);
    expect(await page.getByTestId('chat-zip-file-hint').innerText()).toContain('「JSON を返してください」に変えて頼み');

    // 結果のファイルを選ぶ欄は、貼り付けの欄より先にある
    expect(await page.evaluate<boolean>("!!(document.getElementById('chat-reply-file').compareDocumentPosition(document.getElementById('chat-reply')) & Node.DOCUMENT_POSITION_FOLLOWING)")).toBe(true);
    const m = JSON.parse(await readFile(join(out, 'bundle', 'manifest.json'), 'utf8')) as { count: number; sessions: { id: string }[] };
    expect(m.count).toBeGreaterThan(0);
    const saved = JSON.stringify({
      items: [
        {
          sessionId: m.sessions[0]!.id,
          taskCategory: 'docs',
          taskSummary: 'エージェントが判定',
          humanEffort: { hours: 1, low: 0.5, high: 2, confidence: 0.4, rationale: '根拠' },
          aiOutcome: { completed: true, quality: 3, rework: 1, rationale: '成果' },
          instructionsEffect: { score: 0, evidence: '参照なし' },
          wikiEffect: { score: 0, evidence: '参照なし' },
          skillsAgentsEffect: { score: 0, evidence: '参照なし' },
        },
      ],
    });
    const reply = page.getByTestId('chat-reply');
    await page.getByTestId('chat-reply-file').setInputFiles({ name: 'judgments.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect.poll(() => reply.inputValue()).toBe(saved);
    await page.getByTestId('chat-import').click();
    await expect.poll(() => page.getByTestId('chat-import-result').innerText()).toBe('1 件を取り込みました。');
    // 取り込んだ後も、保存のリンクと進み具合が出ている
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText()).toContain(`取り込み済み 1 / ${m.count} 件。`);
    expect(await page.getByTestId('chat-zip-save').count()).toBe(1);

    // チャットの方法に切り替えると、作り直すと ZIP が消えることを知らせる。作り直すと ZIP は消える
    await page.getByTestId('judge-method-chat').check();
    await expect.poll(() => page.getByTestId('chat-zip-stale').count()).toBe(1);
    await expect.poll(() => page.getByTestId('chat-bundle').isEnabled()).toBe(true);
    await page.getByTestId('chat-bundle').click();
    // 作り直している間に ZIP の方法へ切り替えても、終わったら一覧を読み直して、消えた ZIP を出したままにしない
    await zipMethod.check();
    await expect.poll(() => existsSync(join(out, 'bundle.zip')), { timeout: 60_000 }).toBe(false);
    await expect.poll(() => page.getByTestId('chat-bundle-state').innerText(), { timeout: 60_000 }).toBe('まだ作っていません。');
    expect(await page.getByTestId('chat-zip-save').count()).toBe(0);
    // この画面で取り込んだ件数は、方法を切り替えても残る
    expect(await page.getByTestId('chat-reflect').innerText()).toBe('レポートに反映する(この画面で 1 件)');
    await page.getByTestId('judge-method-chat').check();
    await expect.poll(() => page.getByTestId('chat-zip-stale').count()).toBe(0);
    // 後のテストのために、方法をチャットに戻しておく
    await page.getByTestId('judge-method-chat').check();
    await page.getByTestId('judge-close').click();
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
    // 一覧の依頼の欄に、依頼ごとの判定の済み・未判定を文字で出す(色だけに頼らない)
    const marks = page.locator('table.ledger [data-testid="turn-judge-state"]');
    await expect.poll(() => marks.count()).toBeGreaterThan(0);
    const texts = await marks.allInnerTexts();
    for (const t of texts) expect(t).toMatch(/^(未判定|✓ 判定済み|判定 \d+ \/ \d+)$/);
    expect(texts).toContain('未判定');
    expect(texts.some((t) => t !== '未判定')).toBe(true);
    // 判定した依頼のあるセッションの詳細ページに、採用・合わなかった点・工程(普段)の列
    // 埋め込みの要約は href を持たない(id から作る。report の lib/pack.ts)
    const id = await page.evaluate<string>("JSON.parse(document.getElementById('atlas-data').textContent).sessions.find((s) => s.turnVerdicts && s.turnVerdicts.length).id");
    await page.goto(new URL(`sessions/${id}.html`, server.url).href);
    const turns = page.locator('table.turns');
    await turns.waitFor({ state: 'visible' });
    expect(await turns.locator('thead').innerText()).toMatch(/採用\(LLM\)\s*合わなかった点\s*工程\(普段\)/);
    expect(await turns.locator('tbody').innerText()).toMatch(/そのまま採用|中身を修正して採用/);

    // 判定したかの札: 工数は済み・未判定、依頼ごとは判定した数 / 依頼の数(件数の上限 3 では、最後の依頼は判定しない)
    const effortTag = await page.getByTestId('judge-state-effort').innerText();
    expect(effortTag).toMatch(/LLM 判定\(工数\)\s*(✓ 済み|未判定)/);
    const turnTag = /(\d+) \/ (\d+) 件/.exec(await page.getByTestId('judge-state-turns').innerText())!;
    const [judged, all] = [Number(turnTag[1]), Number(turnTag[2])];
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBeLessThan(all);
    // 判定のボタン: 工数は済みなら「判定し直す」。依頼ごとは未判定の数を出し、札の数と合う
    const group = page.getByTestId('detail-judge');
    await group.waitFor({ state: 'visible' });
    expect(await page.getByTestId('detail-judge-effort').innerText()).toBe(effortTag.includes('✓') ? '工数を判定し直す' : '工数を判定する');
    const turnBtn = page.getByTestId('detail-judge-turns');
    expect(await turnBtn.innerText()).toBe(`依頼ごとに判定する(未判定 ${all - judged} 件)`);
    // 確認で「キャンセル」なら何も始めない
    jobPosts.length = 0;
    page.once('dialog', (d) => void d.dismiss());
    await page.getByTestId('detail-judge-effort').click();
    await page.waitForTimeout(300);
    expect(jobPosts).toEqual([]);
    // 依頼ごと: このセッションの未判定の依頼だけを判定する。確認に件数と費用を出す
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await turnBtn.click();
    await expect.poll(() => jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'turn-judge', limit: all - judged, session: id }]);
    expect(asked).toContain(`このセッションの未判定の依頼 ${all - judged} 件を LLM で判定します`);
    expect(asked).toContain('API の利用料がかかります');
    // 終わっても自動では読み直さない。「読み込み直す」で札が全部済みになり、ボタンは押せなくなる
    const reload = page.getByTestId('detail-judge-reload');
    await reload.waitFor({ state: 'visible', timeout: 60_000 });
    expect(await group.locator('p.judge-msg').innerText()).toContain('依頼ごとの判定が終わり、レポートを作り直しました');
    await reload.click();
    await page.waitForLoadState('load');
    await expect.poll(() => page.getByTestId('judge-state-turns').innerText()).toMatch(new RegExp(`✓ ${all} / ${all} 件`));
    await group.waitFor({ state: 'visible' });
    expect(await turnBtn.isDisabled()).toBe(true);
    expect(await group.locator('p.judge-note').innerText()).toContain(`依頼ごと: ${all} 件とも判定済みです。`);
  });

  it('f4. タスクタグを選んで開くと、対象はそのタグのセッションだけになり、判定もそのタグのセッションだけにする', async () => {
    type TurnItems = { items: { sessionId: string; turn: number }[] };
    const readTurns = async (): Promise<TurnItems['items']> => (JSON.parse(await readFile(join(out, 'turn-judgments.json'), 'utf8')) as TurnItems).items;
    const before = await readTurns();
    // 依頼ごとの記録があって、まだどの依頼も判定していないセッションを 2 つ(依頼の多い順)
    const sessions = (JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string; analysis?: { turnStats?: unknown[] } }[] }).sessions;
    const picked = sessions
      .map((s) => ({ id: s.id, n: s.analysis?.turnStats?.length ?? 0 }))
      .filter((s) => s.n > 0 && !before.some((t) => t.sessionId === s.id))
      .sort((a, b) => b.n - a.n)
      .slice(0, 2);
    expect(picked).toHaveLength(2);
    const ids = picked.map((s) => s.id);
    const pending = picked.reduce((a, s) => a + s.n, 0);
    // 元の groups.json(無ければ null)を覚えておき、終わったら戻す(無かったなら消す)
    const groupsFile = join(notes, 'groups.json');
    const original = await readFile(groupsFile).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    await mkdir(notes, { recursive: true });
    await writeFile(groupsFile, JSON.stringify({ version: 1, groups: [{ name: 'scope-tag', note: '', ids }] }));
    try {
      jobPosts.length = 0;
      await page.goto(server.url);
      await page.locator('[data-testid="group-rail"]:visible').getByRole('button', { name: /scope-tag/ }).click();
      const dialog = page.getByTestId('judge-dialog');
      await page.getByTestId('job-judge').click();
      await dialog.waitFor({ state: 'visible' });
      await page.getByTestId('judge-target-turns').check();
      await page.getByTestId('judge-method-tool').check();
      // 選んでいるタグが対象に選ばれている
      expect(await page.getByTestId('judge-scope-group').isChecked()).toBe(true);
      expect(await page.getByTestId('judge-scope-group').isDisabled()).toBe(false);
      expect(await dialog.locator('label', { has: page.getByTestId('judge-scope-group') }).innerText()).toBe('タスクタグ「scope-tag」のセッションだけ');
      expect(await page.getByTestId('judge-scope-off').count()).toBe(0);
      // 判定の回数の目安は、サーバが返す 1 回にまとめる依頼の数(chunk。今は 6)で割る
      await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(new RegExp(`^タスクタグ「scope-tag」の未判定の依頼 ${pending} 件のうち ${pending} 件を判定します\\(約 ${Math.ceil(pending / 6)} 回以上の判定。`));
      // 「すべて」に戻すと、全体の未判定の数になる
      await page.getByTestId('judge-scope-all').check();
      await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(/^未判定の依頼 \d+ 件のうち/);
      await page.getByTestId('judge-scope-group').check();
      await expect.poll(() => page.getByTestId('judge-count').innerText()).toMatch(/^タスクタグ「scope-tag」の/);
      await page.getByTestId('judge-limit').fill('2');
      await page.getByTestId('judge-run').click();
      await dialog.waitFor({ state: 'hidden' });
      expect(jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'turn-judge', limit: 2, group: 'scope-tag' }]);
      await page.getByTestId('job-reload').waitFor({ state: 'visible', timeout: 60_000 });
      // 増えた判定は、どれもタグのセッションの依頼
      const added = (await readTurns()).filter((t) => !before.some((b) => b.sessionId === t.sessionId && b.turn === t.turn));
      expect(added.length).toBeGreaterThan(0);
      for (const t of added) expect(ids).toContain(t.sessionId);
    } finally {
      // 後のテストにタグを持ち越さない(元の中身に戻す。無かったなら消す)
      if (original === null) await rm(groupsFile, { force: true });
      else await writeFile(groupsFile, original);
    }
  });

  // 詳細ページの判定を、サーバの返事を差し替えて確かめる(f5・f6)
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const detailUrl = async (): Promise<string> => {
    const sessions = (JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] }).sessions;
    return new URL(`sessions/${sessions[0].id}.html`, server.url).href;
  };
  const fakeJob = (st: 'running' | 'done', target: Record<string, unknown>) => ({ id: 'fake-detail', kind: 'judge', state: st, startedAt: new Date().toISOString(), endedAt: st === 'running' ? null : new Date().toISOString(), exitCode: st === 'running' ? null : 0, log: [], target });
  // 差し替えで失敗させた通信は、ブラウザがコンソールに「Failed to load resource」と出す。わざと起こしたものだけを除く
  const dropFailedLoads = (): void => {
    const rest = problems.splice(0).filter((p) => !/Failed to load resource/.test(p));
    problems.push(...rest);
  };

  it('f5. 詳細ページ: 判定の進み具合の確認が途中で失敗しても、待ち続けて終わりまで出す', async () => {
    let posted = false;
    let polls = 0;
    const seen: string[] = [];
    await page.route(/\/api\/jobs\/judge-preview/, (r) => r.fulfill(json({ eligible: 1, judged: 0, pending: 1, withoutTurns: 0, chunk: 6, model: null, byok: false, modelError: null })));
    await page.route(/\/api\/jobs$/, (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      posted = true;
      return r.fulfill(json(fakeJob('running', { limit: 1, backend: 'copilot-cli', session: 'x' }), 202));
    });
    await page.route(/\/api\/jobs\/current$/, (r) => {
      if (!posted) return r.fulfill(json(null));
      polls++;
      // 1 回目は動いている、2 回目は通信の失敗、3 回目はサーバの 503、4 回目は動いている、その後は終わり
      if (polls === 2) return r.abort('failed');
      if (polls === 3) return r.fulfill(json({ error: '一時的に答えられません' }, 503));
      return r.fulfill(json(fakeJob(polls <= 4 ? 'running' : 'done', { limit: 1, backend: 'copilot-cli', session: 'x' })));
    });
    try {
      await page.goto(await detailUrl());
      const group = page.getByTestId('detail-judge');
      await group.waitFor({ state: 'visible' });
      const msg = group.locator('p.judge-msg');
      const watch = setInterval(() => {
        void msg.innerText({ timeout: 200 }).then((t) => seen.push(t), () => {});
      }, 100);
      page.once('dialog', (d) => void d.accept());
      await page.getByTestId('detail-judge-effort').click();
      try {
        await expect.poll(() => msg.innerText(), { timeout: 30_000 }).toContain('工数の判定が終わり、レポートを作り直しました');
      } finally {
        clearInterval(watch);
      }
      expect(polls).toBeGreaterThanOrEqual(5);
      // 失敗の間は諦めずに待っていることを出し、失敗とはしない
      expect(seen.some((t) => t.includes('サーバの応答を待っています'))).toBe(true);
      expect(await group.locator('p.judge-err').isVisible()).toBe(false);
      expect(await page.getByTestId('detail-judge-reload').isVisible()).toBe(true);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      dropFailedLoads();
    }
  });

  it('f6. 詳細ページ: 押したら件数を数え直し、開いた後に判定済みになっていれば判定し直す。対象が無くなっていれば送らない', async () => {
    // 開いたときは工数も依頼ごとも未判定。開いた後にほかの所で判定された
    let judgedElsewhere = false;
    let delay = 0;
    await page.route(/\/api\/jobs\/judge-preview/, async (r) => {
      const turns = r.request().url().includes('target=turns');
      if (delay) await new Promise((ok) => setTimeout(ok, delay));
      if (turns) return r.fulfill(json(judgedElsewhere ? { eligible: 2, judged: 2, pending: 0, withoutTurns: 0, chunk: 6, model: null, byok: false, modelError: null } : { eligible: 2, judged: 0, pending: 2, withoutTurns: 0, chunk: 6, model: null, byok: false, modelError: null }));
      return r.fulfill(json(judgedElsewhere ? { eligible: 1, judged: 1, pending: 0, model: null, byok: false, modelError: null } : { eligible: 1, judged: 0, pending: 1, model: null, byok: false, modelError: null }));
    });
    let body: Record<string, unknown> = {};
    await page.route(/\/api\/jobs$/, (r) => {
      body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      return r.fulfill(json(fakeJob('running', body), 202));
    });
    const dialogs: string[] = [];
    const onDialog = (d: Dialog): void => {
      dialogs.push(d.message());
      void d.accept();
    };
    await page.route(/\/api\/jobs\/current$/, (r) => r.fulfill(json(Object.keys(body).length ? fakeJob('done', body) : null)));
    try {
      jobPosts.length = 0;
      await page.goto(await detailUrl());
      const group = page.getByTestId('detail-judge');
      await group.waitFor({ state: 'visible' });
      const effort = page.getByTestId('detail-judge-effort');
      const turnBtn = page.getByTestId('detail-judge-turns');
      expect(await effort.innerText()).toBe('工数を判定する');
      expect(await turnBtn.innerText()).toBe('依頼ごとに判定する(未判定 2 件)');
      judgedElsewhere = true;
      // 依頼ごと: 数え直したら未判定が無いので、確認を出さず、送らずに理由を出す。数え直す間はどちらのボタンも押せない
      page.on('dialog', onDialog);
      delay = 500;
      await turnBtn.click();
      expect(await effort.isDisabled()).toBe(true);
      expect(await turnBtn.isDisabled()).toBe(true);
      await expect.poll(() => group.locator('p.judge-msg').innerText()).toContain('判定済みになっていたので、判定しませんでした');
      delay = 0;
      expect(dialogs).toEqual([]);
      expect(jobPosts).toEqual([]);
      // 工数: 数え直したら判定済みなので、判定し直す(force)として確かめてから送る
      await effort.click();
      const sid = /sessions\/(.+)\.html$/.exec(await detailUrl())![1];
      await expect.poll(() => jobPosts.map((b) => JSON.parse(b))).toEqual([{ kind: 'judge', limit: 1, session: sid, force: true }]);
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]).toContain('このセッションの工数を LLM で判定し直します');
      await expect.poll(() => group.locator('p.judge-msg').innerText()).toContain('工数の判定が終わり');
    } finally {
      page.off('dialog', onDialog);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  it('f7. 詳細ページ: 数え直しで依頼ごとの件数だけ読めなければ失敗と出す。確かめで取りやめても「読み込み直す」は残る', async () => {
    let turnsFail = false;
    await page.route(/\/api\/jobs\/judge-preview/, (r) => {
      if (r.request().url().includes('target=turns')) return turnsFail ? r.fulfill(json({ error: '数えられません' }, 500)) : r.fulfill(json({ eligible: 2, judged: 0, pending: 2, withoutTurns: 0, chunk: 6, model: null, byok: false, modelError: null }));
      return r.fulfill(json({ eligible: 1, judged: 0, pending: 1, model: null, byok: false, modelError: null }));
    });
    let body: Record<string, unknown> = {};
    await page.route(/\/api\/jobs$/, (r) => {
      body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      return r.fulfill(json(fakeJob('running', body), 202));
    });
    await page.route(/\/api\/jobs\/current$/, (r) => r.fulfill(json(Object.keys(body).length ? fakeJob('done', body) : null)));
    let accept = true;
    const dialogs: string[] = [];
    const onDialog = (d: Dialog): void => {
      dialogs.push(d.message());
      void (accept ? d.accept() : d.dismiss());
    };
    try {
      await page.goto(await detailUrl());
      const group = page.getByTestId('detail-judge');
      await group.waitFor({ state: 'visible' });
      const msg = group.locator('p.judge-msg');
      const err = group.locator('p.judge-err');
      const reload = page.getByTestId('detail-judge-reload');
      page.on('dialog', onDialog);
      // 工数を 1 回判定して「読み込み直す」を出す
      await page.getByTestId('detail-judge-effort').click();
      await expect.poll(() => msg.innerText()).toContain('工数の判定が終わり');
      expect(await reload.isVisible()).toBe(true);
      const done = await msg.innerText();
      // 依頼ごと: 依頼ごとの件数だけ読めない → 「判定できる依頼が無くなっていた」ではなく、数え直せなかったと出す
      turnsFail = true;
      jobPosts.length = 0;
      await page.getByTestId('detail-judge-turns').click();
      await expect.poll(() => err.innerText()).toContain('判定の件数を数え直せませんでした');
      expect(await msg.innerText()).not.toContain('判定できる依頼が無くなっていた');
      expect(await reload.isVisible()).toBe(true);
      expect(dialogs).toHaveLength(1);
      // 工数: 確かめで取りやめても、前の判定の知らせと「読み込み直す」は残る
      turnsFail = false;
      accept = false;
      await page.getByTestId('detail-judge-effort').click();
      await expect.poll(() => dialogs.length).toBe(2);
      expect(await msg.innerText()).toBe(done);
      expect(await reload.isVisible()).toBe(true);
      expect(jobPosts).toEqual([]);
    } finally {
      page.off('dialog', onDialog);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      dropFailedLoads();
    }
  });

  it('g. 詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ、記録に混ぜた script は実行されない', async () => {
    // セッション一覧は一覧のタブ(ほかのタブの節は hidden で隠れていて押せない)
    await page.goto(`${server.url}#tab=list`);
    const link = page.locator('#sessions table.ledger tbody td.name a').first();
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
