// 「課題 × 条件」の節を、画面で確かめる(Playwright の Chromium)。
// 架空の fixture(scripts/synthetic-conditions.ts。課題 2 つ × 条件 3 つ × 3 回。タスクタグの名前は「課題__条件__番号」)を
// atlas all し、atlas serve で開く。期待値は fixture の表(PLAN・AIU_PER_REQUEST)から手で計算したもの。
//  a. 目次に項目が出て、条件ごと(課題をまとめた行)は 6 件ずつなので割合と中央値が出る。未達を最後に並べた中央値・通った後に不合格・テストの記録なし
//  b. 課題ごとの行は 3 件ずつなので、割合と中央値は「—」で、件数と割った数は出る
//  c. 表に入れなかったもの(決まりに合わないタグ・複数の条件のタグが付いたセッション)の件数と、数え方の説明
//  d. 375px の幅で横にはみ出さない
//  e. 利用の確認: 確かめるものを選び、使うはずの条件に印を付けると、使わなかったセッションとほかの条件で使ったセッションを並べる
//  e2. タスクタグの名前を画面で変えると、集計し直さなくても、読み込み直さなくても、表がその場で変わる
//  f. 送り先をまとめて集計した出力(タスクタグの表示名が「人 / タグ」)でも、元のタグから読んで同じ表になり、人をまたいでまとめる
//  g. テストの記録が無い古い集計でも開き、テストの結果の列を出さずに理由を書く
//  h. 全ページの網羅チェック(この節が出ている出力)に要修正の指摘が無い
//  i. llm-wiki の vault を指定しないで集計したときは、wiki の参照の件数を集計明細・プロジェクト別・人別・改善点・利用の確認・詳細ページの
//     どこにも出さず、数えていないと書く
//  i2. vault を指定したときは、改善点の「llm-wiki の利用」の箱に件数だけを出す(率は並べない)。書き込みだけのセッションは参照したに入れない
//  j. vault を指定していたかの記録が無い古い集計で、参照したセッションも無ければ、数えていないのか分からないと書く
// a〜e2 は atlas serve の画面、f 以降はファイルを直接開く(サーバは開いている画面が無くなると止まるので、サーバの画面を使うものを先に置く)。
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';
import { extractEmbedded } from '../packages/report/src/lib/embed.ts';
import { COMPARE_MIN_SESSIONS } from '../packages/report/src/lib/compare.ts';
import type { ReportData } from '../packages/report/src/lib/types.ts';
import { WIKI_NO_RECORD, WIKI_NO_RECORD_SHORT, WIKI_NOT_COUNTED, WIKI_NOT_COUNTED_SHORT } from '../packages/report/src/lib/wiki.ts';
import { emptyFilter, encodeFilter } from '../packages/report/src/lib/filter.ts';
import { audit, summarize } from '../scripts/ui-audit.ts';
import { COND_CONDITIONS, COND_MCP, COND_PEOPLE, COND_SOLO_TASK, COND_TASKS, conditionConfig, conditionGroups, condId, writeConditionStudy, writeConditionUpload } from '../scripts/synthetic-conditions.ts';

const WORK = join(ROOT, 'out', 'ui-conditions');

function atlas(args: string[]): void {
  const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

const fileUrl = (p: string): string => `file:///${p.replace(/\\/g, '/')}`;
/** 表に出る課題(名前の順)。最後の 1 つは、条件が 1 つしか無い課題 */
const TASKS = [...COND_TASKS, COND_SOLO_TASK];
/** セッションの無い課題がある条件の印(記号と、読み上げ用の文字) */
const PARTIAL = '※ (セッションの無い課題がある)';

describe('課題 × 条件', () => {
  const logs = join(WORK, 'logs');
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const config = join(WORK, 'atlas.config.json');
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await writeConditionStudy(logs);
    // タスクタグは build のときにレポートへ埋め込まれるので、集計の前に書いておく
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, 'groups.json'), JSON.stringify(conditionGroups()));
    // llm-wiki の参照は、設定の wikis で vault を指定したときだけ数える
    await writeFile(config, JSON.stringify(conditionConfig()));
    atlas(['all', '--home', logs, '--out', out, '--notes-dir', notes, '--config', config]);
    server = await startServer({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, configPath: join(WORK, 'atlas.config.json'), copilotHome: logs });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close('テスト終了');
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems).toEqual([]);
  });

  const section = () => page.locator('#conditions');
  /** セルの文字(値と、その下の割った数を 1 つの空白でつなぐ。読み上げ用の「、」は除く) */
  const texts = async (row: Locator): Promise<string[]> => (await row.locator('td').allInnerTexts()).map((t) => t.replace(/\s*、\s*/g, ' ').replace(/\s+/g, ' ').trim());
  const pooled = (condition: string) => section().locator(`[data-testid="conditions-pooled"] tr[data-condition="${condition}"]`);
  const taskRow = (task: string, condition: string) => section().locator(`[data-testid="conditions-table"] tr[data-task="${task}"][data-condition="${condition}"]`);

  // 列: 課題 / 件数 / テストの記録なし / 最後に全部通った / 通った後に不合格 / 未達 / テストの実行 / 実働 / AIU / 実働(中央値)/ AIU(中央値)/ ツールの失敗・拒否
  const POOLED: Record<string, string[]> = {
    // 6 件のうち 4 件が通った(2, 3, 3, 4 回目)。未達の 2 件を最後に並べた中央値は 3 番目と 4 番目の平均
    // ツールの呼び出しは、テストの実行 18 回と、wiki を読んだ 1 回(条件の漏れ)
    '0-plain': [`2 / 3${PARTIAL}`, '6', '0', '67% 4 / 6 件', '0', '2', '3.5 回 6 件', '3分 6 件', '3.5 6 件', '3分 6 件', '3.5 6 件', '74% 14 / 19 回'],
    // 印の無いセッションが 1 件(件数 7、テストの記録なし 1)。1 件は通った後にもう一度走らせて落ちた
    // ツールの呼び出しは、テストの実行 9 回と、MCP サーバーのツール 6 回
    coderef: [`2 / 3${PARTIAL}`, '7', '1', '83% 5 / 6 件', '1', '0', '1 回 6 件', '4秒 6 件', '2 6 件', '1分 7 件', '2.5 6 件', '20% 3 / 15 回'],
    // 条件が 1 つしか無い課題のセッション(印も AI 使用量の記録も無い)が 1 件入る
    // ツールの呼び出しは、テストの実行 12 回と、wiki を読んだ 5 回(1 件は読まない)
    wiki: ['3 / 3', '7', '1', '100% 6 / 6 件', '0', '0', '2 回 6 件', '1分 6 件', '3 6 件', '2分 7 件', '3.5 6 件', '35% 6 / 17 回'],
  };

  it('a. 目次に項目が出て、条件ごと(課題をまとめた行)に割合と中央値が出る', async () => {
    await page.goto(server.url);
    await expect.poll(() => page.locator('nav.toc a[href="#conditions"]').count()).toBe(1);
    expect(await page.locator('nav.toc a[href="#conditions"]').first().innerText()).toBe('課題 × 条件');
    await expect.poll(() => section().locator('[data-testid="conditions-pooled"] tbody tr').count()).toBe(COND_CONDITIONS.length);
    // 並びは名前の順(頭に数字を付けた条件が先頭)
    expect(await section().locator('[data-testid="conditions-pooled"] tbody th[scope="row"]').allInnerTexts()).toEqual([...COND_CONDITIONS]);
    for (const c of COND_CONDITIONS) expect(await texts(pooled(c)), c).toEqual(POOLED[c]);
    // 閾値は定数の値で説明に出る
    expect(await section().locator('.section-head p').innerText()).toContain(`もとになるセッションが ${COMPARE_MIN_SESSIONS} 件未満なら「—」`);
    // 印の意味は、色でなく文字で注記にも書く
    expect(await section().getByTestId('conditions-pooled-note').innerText()).toContain('※ は、セッションの無い課題がある条件です');
  });

  it('b. 課題ごとの行は件数が足りないので、割合と中央値は「—」で、件数と割った数は出る', async () => {
    await page.goto(server.url);
    await expect.poll(() => section().locator('[data-testid="conditions-table"] tbody').count()).toBe(TASKS.length);
    expect(await section().locator('[data-testid="conditions-table"] th[scope="rowgroup"]').allInnerTexts()).toEqual(TASKS.map((t) => `課題${t}`));
    // どの課題にも、全部の条件が同じ順で並ぶ
    expect(await section().locator('[data-testid="conditions-table"] tr[data-condition]').count()).toBe(TASKS.length * COND_CONDITIONS.length);
    // その課題に無い条件は、件数だけ 0 で、ほかは値が無い(列の数はほかの行と同じ)
    expect(await texts(taskRow(COND_SOLO_TASK, '0-plain'))).toEqual(['0', ...Array.from({ length: 10 }, () => '—')]);
    // テストの記録が無い行: テストの結果の列は 0 と書かず「—」。セッション全体の値は、割った数(1 件、AI 使用量の記録は 0 件)を出す
    expect(await texts(taskRow(COND_SOLO_TASK, 'wiki'))).toEqual(['1', '1', '—', '—', '—', '—', '—', '—', '— 1 件', '— 0 件', '—']);
    // 3 件のうち 2 件が通り、1 件は未達。落ちた実行は 8 回(テストの実行は 10 回)
    expect(await texts(taskRow('zz-render', '0-plain'))).toEqual(['3', '0', '— 2 / 3 件', '0', '1', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 8 / 11 回']);
    // 通った後に不合格の 1 件は、合格には数えない
    expect(await texts(taskRow('zz-render', 'coderef'))).toEqual(['3', '0', '— 2 / 3 件', '1', '0', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 2 / 8 回']);
    // 印の無いセッションは件数に入るが、テストの結果の分母には入らない。AI 使用量の記録も無いので、AIU の件数にも入らない
    expect(await texts(taskRow('zz-input', 'coderef'))).toEqual(['4', '1', '— 3 / 3 件', '0', '0', '— 3 件', '— 3 件', '— 3 件', '— 4 件', '— 3 件', '— 1 / 7 回']);
  });

  it('c. 表に入れなかったものの件数と、数え方の説明', async () => {
    await page.goto(server.url);
    await expect.poll(() => section().getByTestId('conditions-excluded').innerText()).toContain('名前の決まりに合わないタスクタグ 1 個(zz-a__b__x)・複数の課題や条件のタグが付いたセッション 1 件');
    expect(await section().getByTestId('conditions-pooled-note').innerText()).toContain('条件によってセッションの数が違う課題が 2 件あります');
    // この PC のレポートには人の記録が無いので、人をまたいでまとめた旨は出ない
    expect(await section().getByTestId('conditions-excluded').innerText()).not.toContain('同じ行にまとめています');
    expect(await section().getByTestId('conditions-note').innerText()).toContain('全部通ったことのあるセッションが半分以下の行は「未達」と出ます');
    // 表の読み方は畳んであり、キーボードで開ける
    const how = section().locator('#conditions-how');
    const isOpen = (): Promise<boolean> => how.evaluate((d) => (d as unknown as { open: boolean }).open);
    expect(await isOpen()).toBe(false);
    await how.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect.poll(isOpen).toBe(true);
    expect(await how.innerText()).toContain('課題__条件__番号');
    // 用語の説明へのリンクの行き先がある
    const glossary = await readFile(join(out, 'glossary.html'), 'utf8');
    expect(glossary).toContain('id="conditions"');
    expect(glossary).toContain('id="test-pass"');
  });

  it('d. 375px の幅で横にはみ出さない', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
      await page.goto(server.url);
      await section().getByTestId('conditions-table').scrollIntoViewIfNeeded();
      const over = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      expect(over).toBeLessThanOrEqual(0);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it('e. 利用の確認: 使うはずの条件に印を付けると、食い違ったセッションを並べる', async () => {
    await page.goto(server.url);
    const usage = (condition: string) => section().locator(`[data-testid="conditions-usage"] tr[data-condition="${condition}"]`);
    const item = section().getByTestId('conditions-usage-item');
    await expect.poll(() => item.inputValue()).toBe('wiki');
    // 選べるのは llm-wiki と、この表のセッションで使われた MCP サーバー・ツール
    expect(await item.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.getAttribute('label')))).toEqual(['llm-wiki', 'MCP サーバー', 'ツール']);
    expect(await item.locator('option').first().innerText()).toBe('llm-wiki の参照(6)');
    // vault を指定して集計したので、数えていないという注意は出ない
    expect(await section().getByTestId('conditions-usage-wiki-off').count()).toBe(0);
    // 条件ごとの、wiki を読んだセッション(列: 件数 / 使った / 使わなかった / 使った割合)
    const cells = async (c: string): Promise<string[]> => (await usage(c).locator('td').allInnerTexts()).slice(1).map((t) => t.trim());
    expect(await cells('wiki')).toEqual(['7', '5', '2', '71%']);
    expect(await cells('0-plain')).toEqual(['6', '1', '5', '17%']);
    expect(await cells('coderef')).toEqual(['7', '0', '7', '0%']);
    // 印が無いうちは、一覧の代わりに案内
    expect(await section().getByTestId('conditions-usage-hint').isVisible()).toBe(true);
    await section().getByRole('checkbox', { name: 'wiki で使うはず' }).check();
    const missing = section().getByTestId('conditions-usage-missing');
    const leaked = section().getByTestId('conditions-usage-leaked');
    // wiki の条件で読まなかった: zz-input の 2 回目と、条件が 1 つだけの課題のセッション
    await expect.poll(() => missing.locator('tbody tr').count()).toBe(2);
    expect(await missing.locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-session')))).toEqual([condId(8), condId(20)]);
    // ほかの条件で読んだ: 素の条件の zz-render の 1 回目
    expect(await leaked.locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-session')))).toEqual([condId(10)]);
    expect((await leaked.locator('tbody tr').innerText()).replace(/\s+/g, ' ')).toContain('zz-render 0-plain 1 回');
    // セッションの名前から詳細ページへ移れる
    expect(await missing.locator('tbody a').first().getAttribute('href')).toBe(`sessions/${condId(8)}.html`);
    // MCP サーバーに切り替えると、その印は別に持つ(コード参照の条件に印を付けると、使わなかったセッションは無い)
    await item.selectOption(`mcp:${COND_MCP}`);
    await expect.poll(() => cells('coderef')).toEqual(['7', '6', '1', '86%']);
    expect(await section().getByRole('checkbox', { name: 'wiki で使うはず' }).isChecked()).toBe(false);
    await section().getByRole('checkbox', { name: 'coderef で使うはず' }).check();
    // コード参照の条件で使わなかったのは、テストの印の無いセッション 1 件だけ
    await expect.poll(() => missing.locator('tbody tr').count()).toBe(1);
    expect(await leaked.innerText()).toBe('ありません。');
    // wiki に戻すと、wiki の印が残っている
    await item.selectOption('wiki');
    await expect.poll(() => section().getByRole('checkbox', { name: 'wiki で使うはず' }).isChecked()).toBe(true);
  });

  it('e2. タスクタグの名前を画面で変えると、集計し直さなくても表がその場で変わる', async () => {
    await page.goto(server.url);
    const count = async (row: Locator): Promise<string> => (await texts(row))[0];
    const pooledCount = async (condition: string): Promise<string> => (await texts(pooled(condition)))[1];
    await expect.poll(() => count(taskRow(COND_SOLO_TASK, 'wiki'))).toBe('1');
    expect(await count(taskRow(COND_SOLO_TASK, 'coderef'))).toBe('0');
    expect([await pooledCount('wiki'), await pooledCount('coderef')]).toEqual(['7', '7']);
    // 条件が 1 つしか無い課題のタグ(課題__条件)の条件を、wiki から coderef に変える
    const from = `${COND_SOLO_TASK}__wiki`;
    const to = `${COND_SOLO_TASK}__coderef`;
    const rail = page.locator('[data-testid="group-rail"]:visible');
    const head = page.getByTestId('group-head');
    const rename = async (before: string, after: string): Promise<void> => {
      await rail.getByRole('button', { name: new RegExp(before) }).click();
      await head.getByTestId('group-edit').click();
      // 開いた欄は少し遅れて名前へ焦点を移す。移る前に打つと、打つ途中で焦点が移って文字が欠ける
      await expect.poll(() => head.getByLabel('名前').evaluate((el) => el.matches(':focus'))).toBe(true);
      await head.getByLabel('名前').fill(after);
      await head.getByRole('button', { name: '保存' }).click();
      await expect.poll(async () => (JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8')) as { groups: { name: string }[] }).groups.map((g) => g.name)).toContain(after);
    };
    await rename(from, to);
    // 読み込み直していないのに、その課題の行が wiki から coderef に移り、条件ごとの件数も変わる
    await expect.poll(() => count(taskRow(COND_SOLO_TASK, 'coderef'))).toBe('1');
    expect(await count(taskRow(COND_SOLO_TASK, 'wiki'))).toBe('0');
    expect([await pooledCount('wiki'), await pooledCount('coderef')]).toEqual(['6', '8']);
    // 元に戻すと、表も元に戻る
    await rename(to, from);
    await expect.poll(() => count(taskRow(COND_SOLO_TASK, 'wiki'))).toBe('1');
    for (const c of COND_CONDITIONS) expect(await texts(pooled(c)), c).toEqual(POOLED[c]);
  });

  it('f. 送り先をまとめて集計した出力でも、元のタグから読んで同じ表になる', async () => {
    const upload = join(WORK, 'upload');
    const up = join(WORK, 'out-upload');
    await writeConditionUpload(upload);
    atlas(['all', '--home', upload, '--out', up, '--notes-dir', join(WORK, 'notes-upload'), '--config', config]);
    const data = extractEmbedded<ReportData>(await readFile(join(up, 'atlas.html'), 'utf8'));
    // タスクタグの表示名は「人 / タグ」で、元のタグを別に持つ
    const g = data.groups.find((x) => x.name === `${COND_PEOPLE[0]} / zz-input__0-plain__1`);
    expect(g?.tag).toBe('zz-input__0-plain__1');
    // 立てたサーバは別の出力先を見ているので、ファイルを直接開く
    await page.goto(fileUrl(join(up, 'atlas.html')));
    await expect.poll(() => section().locator('[data-testid="conditions-pooled"] tbody tr').count()).toBe(COND_CONDITIONS.length);
    // 課題の名前に人の名前が混ざらない
    expect(await section().locator('[data-testid="conditions-table"] th[scope="rowgroup"]').allInnerTexts()).toEqual(TASKS.map((t) => `課題${t}`));
    for (const c of COND_CONDITIONS) expect(await texts(pooled(c)), c).toEqual(POOLED[c]);
    expect(await section().getByTestId('conditions-excluded').innerText()).toContain(`同じ行にまとめています(${COND_PEOPLE.length} 人のセッション)`);
    // vault を指定して集計したので、人別の表にも wiki の列があり、理由の文は出ない
    expect(await page.locator('#people thead th').allInnerTexts()).toContain('wiki');
    expect(await page.getByTestId('people-wiki-off').count()).toBe(0);
  });

  it('g. テストの記録が無い古い集計でも開き、テストの結果の列を出さずに理由を書く', async () => {
    const old = join(WORK, 'out-old');
    atlas(['all', '--home', logs, '--out', old, '--notes-dir', notes, '--config', config]);
    const path = join(old, 'sessions.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { sessions: { tests?: unknown }[] };
    for (const s of file.sessions) delete s.tests;
    await writeFile(path, JSON.stringify(file));
    atlas(['build', '--out', old, '--notes-dir', notes]);
    await page.goto(fileUrl(join(old, 'atlas.html')));
    await expect.poll(() => section().getByTestId('conditions-note').innerText()).toContain('テストの記録があるセッションが無いので、テストの結果の列は出していません');
    // 件数と、セッション全体の 3 列だけ
    expect(await texts(pooled('wiki'))).toEqual(['3 / 3', '7', '2分 7 件', '3.5 6 件', '35% 6 / 17 回']);
    expect(await texts(taskRow(COND_SOLO_TASK, '0-plain'))).toEqual(['0', '—', '—', '—']);
    expect(await section().innerText()).not.toContain('最後に全部通った');
  });

  it('h. この節が出ている出力の全ページに、要修正の指摘が無い', async () => {
    const r = await audit(out, { layoutSessions: 0 });
    const errors = r.findings.filter((f) => f.severity === 'error');
    expect(errors, summarize({ pages: r.pages, findings: errors })).toEqual([]);
  });

  /** 表(プロジェクト別・人別)に wiki の列が無く(並べ替えもできない)、見出しの下に短い断りがあるか */
  const expectTableWikiOff = async (id: 'projects' | 'people', short: string): Promise<void> => {
    const table = page.locator(`#${id}`);
    expect(await page.getByTestId(`${id}-wiki-off`).innerText()).toBe(short);
    const cols = await table.locator('thead th').count();
    expect(cols).toBeGreaterThan(0);
    expect(await table.locator('thead th').allInnerTexts()).not.toContain('wiki');
    expect(await table.getByRole('button', { name: /^wiki/ }).count()).toBe(0);
    // 本文の行も、見出しと同じ数のセルだけ(wiki のセルだけが残っていない)
    const cells = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.querySelectorAll(':scope > th, :scope > td').length));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((n) => n === cols), `見出し ${cols} 列、行のセル ${cells.join(',')}`).toBe(true);
  };

  /**
   * 数えていない・記録なしの集計で、wiki の件数をどこにも出さず、理由の文(表では短い断り)を出すか。
   * label は利用の確認の選択肢に件数の代わりに添える語(数えていない: (数えていません)、記録なし: (記録なし))
   */
  const expectWikiOff = async (note: string, short: string, label: string): Promise<void> => {
    // 集計明細: wiki の欄は出さず、指示ファイルだけの欄と、見出しの下の理由
    await expect.poll(() => page.getByTestId('detail-wiki-off').innerText()).toBe(note);
    expect(await page.getByTestId('instructions-field').count()).toBe(1);
    expect(await page.getByTestId('instructions-wiki-field').count()).toBe(0);
    // プロジェクト別: wiki の列を出さず(並べ替えもできない)、見出しの下は短い断り
    await expectTableWikiOff('projects', short);
    // 改善点の箱: 件数は出さず理由だけ
    const box = page.getByTestId('insights-wiki');
    expect(await box.getByTestId('insights-wiki-off').innerText()).toBe(note);
    expect(await box.getByTestId('insights-wiki-counts').count()).toBe(0);
    // ページごとの箱も、表は出さず同じ理由だけ
    const pages = page.getByTestId('insights-wiki-pages');
    expect(await pages.getByTestId('insights-wiki-pages-off').innerText()).toBe(note);
    expect(await pages.locator('table').count()).toBe(0);
    // 課題 × 条件の利用の確認: 既定は表の出る MCP サーバー。llm-wiki は件数の代わりの語つきで選択肢に残る
    const item = section().getByTestId('conditions-usage-item');
    await expect.poll(() => item.inputValue()).toBe(`mcp:${COND_MCP}`);
    expect(await section().getByTestId('conditions-usage').count()).toBe(1);
    expect(await item.locator('option[value="wiki"]').innerText()).toBe(`llm-wiki の参照${label}`);
    // llm-wiki を選ぶと、使った・使わなかった・割合も食い違いの一覧も出さず、理由だけ
    await item.selectOption('wiki');
    await expect.poll(() => section().getByTestId('conditions-usage-wiki-off').innerText()).toBe(note);
    expect(await section().getByTestId('conditions-usage').count()).toBe(0);
    expect(await section().getByTestId('conditions-usage-hint').count()).toBe(0);
    // MCP サーバーに戻せば、表はいつもどおり出る
    await item.selectOption(`mcp:${COND_MCP}`);
    await expect.poll(() => section().getByTestId('conditions-usage').count()).toBe(1);
    expect(await section().getByTestId('conditions-usage-wiki-off').count()).toBe(0);
  };

  it('i. llm-wiki の vault を指定しないで集計したときは、wiki の参照の件数を出さずに、数えていないと書く', async () => {
    const plain = join(WORK, 'out-no-wiki');
    // vault を指定していない設定(wikis の無い空の設定)
    const empty = join(WORK, 'atlas.config.empty.json');
    await writeFile(empty, '{}');
    atlas(['all', '--home', logs, '--out', plain, '--notes-dir', notes, '--config', empty]);
    const data = extractEmbedded<ReportData>(await readFile(join(plain, 'atlas.html'), 'utf8'));
    expect(data.wikiVaults).toBe(0);
    await page.goto(fileUrl(join(plain, 'atlas.html')));
    await expectWikiOff(WIKI_NOT_COUNTED, WIKI_NOT_COUNTED_SHORT, '(数えていません)');
    // 詳細ページも「参照はありません」と言わずに、同じ理由を出す
    const detail = await readFile(join(plain, 'sessions', `${condId(1)}.html`), 'utf8');
    expect(detail).toContain(WIKI_NOT_COUNTED);
    expect(detail).not.toContain('llm-wiki の参照はありません。');
    // 設定したときは、数えた vault の数が入り、理由の文は出ない
    expect(extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8')).wikiVaults).toBe(1);

    // 送り先をまとめて集計したレポートの人別の表も、wiki の列を出さずに同じ理由を出す
    const upload = join(WORK, 'upload-no-wiki');
    const up = join(WORK, 'out-upload-no-wiki');
    await writeConditionUpload(upload);
    atlas(['all', '--home', upload, '--out', up, '--notes-dir', join(WORK, 'notes-upload-no-wiki'), '--config', empty]);
    await page.goto(fileUrl(join(up, 'atlas.html')));
    await expect.poll(() => page.locator('#people').count()).toBe(1);
    await expectTableWikiOff('people', WIKI_NOT_COUNTED_SHORT);
    await expectTableWikiOff('projects', WIKI_NOT_COUNTED_SHORT);
  });

  it('i2. vault を指定したときは、改善点の箱に件数だけを出す(率は並べない)', async () => {
    const data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    const shown = data.sessions.filter((s) => !s.empty).length;
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const box = page.getByTestId('insights-wiki');
    // 表の見出しと値(1 行)
    const table = async (id: string): Promise<[string[], string[]]> => [
      (await box.getByTestId(id).locator('thead th').allInnerTexts()).map((t) => t.trim()),
      (await box.getByTestId(id).locator('tbody td').allInnerTexts()).map((t) => t.trim()),
    ];
    // 索引を読むのは、wiki の条件の 6 件のうち 5 件と、素の条件の 1 件と、索引を読んでから書き込む手入れのセッション 1 件。
    // 書き込みだけの手入れのセッション 1 件は、参照したには入らない
    await expect.poll(() => table('insights-wiki-counts')).toEqual([['参照した', 'うち書き込みもあり', '書き込みだけ', '参照なし'], ['7', '1', '1', String(shown - 8)]]);
    expect(await box.getByTestId('insights-wiki-counts').locator('caption').innerText()).toBe('セッションの数');
    expect(await table('insights-wiki-breakdown')).toEqual([['索引', '個別ページ', 'wiki の skill', '検索・一覧など'], ['7', '0', '0', '0']]);
    expect(await box.getByTestId('insights-wiki-breakdown').locator('caption').innerText()).toMatch(/^参照の内訳\(回/);
    // 注は 1 段落で、数え方と比べ方は用語の説明へ
    const why = box.getByTestId('insights-wiki-why');
    expect(await why.innerText()).toContain('差が出ても wiki が原因とは分かりません');
    expect(await why.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['glossary.html#llm-wiki', 'glossary.html#conditions']);
    expect(await box.locator('p').count()).toBe(1);
    expect(await box.innerText()).not.toMatch(/%/);
    expect(await box.getByTestId('insights-wiki-off').count()).toBe(0);
    // 集計明細とプロジェクト別は、同じ数え方の件数を出す(書き込みだけのセッションは入れない)
    expect(await page.getByTestId('instructions-wiki-field').innerText()).toMatch(/\/ 7\b/);
    expect(await page.getByTestId('detail-wiki-off').count()).toBe(0);
    expect(await page.locator('#projects thead th').allInnerTexts()).toContain('wiki');
    // 詳細ページには、手入れのセッションの扱いが出る(fixture の最後の 2 件: 書き込みだけ / 索引を読んでから書き込む)
    const kind = async (n: number): Promise<string | undefined> => (await readFile(join(out, 'sessions', `${condId(n)}.html`), 'utf8')).match(/このセッションの扱い: ([^<]*)/)?.[1];
    expect(await kind(24)).toBe('書き込みだけ(参照したセッションには数えません)');
    expect(await kind(25)).toBe('参照した');
  });

  it('j. vault を指定していたかの記録が無い古い集計で、参照したセッションも無ければ、分からないと書く。決めるのは絞り込む前の全セッション', async () => {
    /** 集計して、sessions.json から vault の数の記録を消して作り直す(記録の版 18 以前の sessions.json には source.wikis が無い) */
    const oldBuild = async (dir: string, cfg: string): Promise<void> => {
      atlas(['all', '--home', logs, '--out', dir, '--notes-dir', notes, '--config', cfg]);
      const path = join(dir, 'sessions.json');
      const file = JSON.parse(await readFile(path, 'utf8')) as { source: { wikis?: number } };
      delete file.source.wikis;
      await writeFile(path, JSON.stringify(file));
      atlas(['build', '--out', dir, '--notes-dir', notes]);
      expect(extractEmbedded<ReportData>(await readFile(join(dir, 'atlas.html'), 'utf8')).wikiVaults).toBeUndefined();
    };
    const old = join(WORK, 'out-no-record');
    await oldBuild(old, join(WORK, 'atlas.config.empty.json'));
    await page.goto(fileUrl(join(old, 'atlas.html')));
    await expectWikiOff(WIKI_NO_RECORD, WIKI_NO_RECORD_SHORT, '(記録なし)');

    // 記録は無いが、参照したセッションがある集計は数えたとみなす。参照したセッションの無い絞り込み(MCP サーバーを使ったセッション)でも、
    // 理由に変わらずに 0 を出す(絞り込みで出し方が変わらない)
    const counted = join(WORK, 'out-old-counted');
    await oldBuild(counted, config);
    await page.goto(`${fileUrl(join(counted, 'atlas.html'))}#${encodeFilter({ ...emptyFilter(), tool: `mcp:${COND_MCP}` })}`);
    await expect.poll(() => page.getByTestId('instructions-wiki-field').innerText()).toMatch(/\/ 0\b/);
    expect(await page.getByTestId('detail-wiki-off').count()).toBe(0);
    expect((await page.getByTestId('insights-wiki-counts').locator('tbody td').allInnerTexts()).slice(0, 2)).toEqual(['0', '0']);
  });
});
