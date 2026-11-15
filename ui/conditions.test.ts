// 「課題 × 条件」の節を、画面で確かめる(Playwright の Chromium)。
// 架空の fixture(scripts/synthetic-conditions.ts。課題 2 つ × 条件 3 つ × 3 回。タスクタグの名前は「課題__条件__番号」)を
// atlas all し、atlas serve で開く。期待値は fixture の表(PLAN・AIU_PER_REQUEST)から手で計算したもの。
//  a. 目次に項目が出て、条件ごと(課題をまとめた行)は 6 件ずつなので割合と中央値が出る。未達を最後に並べた中央値・通った後に不合格・テストの記録なし
//  b. 課題ごとの行は 3 件ずつなので、割合と中央値は「—」で、件数と割った数は出る
//  c. 表に入れなかったもの(決まりに合わないタグ・複数の条件のタグが付いたセッション)の件数と、数え方の説明
//  d. 375px の幅で横にはみ出さない
//  e. 送り先をまとめて集計した出力(タスクタグの表示名が「人 / タグ」)でも、元のタグから読んで同じ表になり、人をまたいでまとめる
//  f. テストの記録が無い古い集計でも開き、テストの結果の列を出さずに理由を書く
//  g. 伏せ字版には節を出さず、課題と条件の名前も出さない
//  h. 全ページの網羅チェック(この節が出ている出力)に要修正の指摘が無い
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
import { audit, summarize } from '../scripts/ui-audit.ts';
import { COND_CONDITIONS, COND_PEOPLE, COND_SOLO_TASK, COND_TASKS, conditionGroups, writeConditionStudy, writeConditionUpload } from '../scripts/synthetic-conditions.ts';

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
    atlas(['all', '--home', logs, '--out', out, '--notes-dir', notes]);
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
    '0-plain': [`2 / 3${PARTIAL}`, '6', '0', '67% 4 / 6 件', '0', '2', '3.5 回 6 件', '3分 6 件', '3.5 6 件', '3分 6 件', '3.5 6 件', '78% 14 / 18 回'],
    // 印の無いセッションが 1 件(件数 7、テストの記録なし 1)。1 件は通った後にもう一度走らせて落ちた
    coderef: [`2 / 3${PARTIAL}`, '7', '1', '83% 5 / 6 件', '1', '0', '1 回 6 件', '4秒 6 件', '2 6 件', '1分 7 件', '2.5 6 件', '33% 3 / 9 回'],
    // 条件が 1 つしか無い課題のセッション(印も AI 使用量の記録も無い)が 1 件入る
    wiki: ['3 / 3', '7', '1', '100% 6 / 6 件', '0', '0', '2 回 6 件', '1分 6 件', '3 6 件', '2分 7 件', '3.5 6 件', '50% 6 / 12 回'],
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
    expect(await texts(taskRow('zz-render', '0-plain'))).toEqual(['3', '0', '— 2 / 3 件', '0', '1', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 8 / 10 回']);
    // 通った後に不合格の 1 件は、合格には数えない
    expect(await texts(taskRow('zz-render', 'coderef'))).toEqual(['3', '0', '— 2 / 3 件', '1', '0', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 3 件', '— 2 / 5 回']);
    // 印の無いセッションは件数に入るが、テストの結果の分母には入らない。AI 使用量の記録も無いので、AIU の件数にも入らない
    expect(await texts(taskRow('zz-input', 'coderef'))).toEqual(['4', '1', '— 3 / 3 件', '0', '0', '— 3 件', '— 3 件', '— 3 件', '— 4 件', '— 3 件', '— 1 / 4 回']);
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

  it('e. 送り先をまとめて集計した出力でも、元のタグから読んで同じ表になる', async () => {
    const upload = join(WORK, 'upload');
    const up = join(WORK, 'out-upload');
    await writeConditionUpload(upload);
    atlas(['all', '--home', upload, '--out', up, '--notes-dir', join(WORK, 'notes-upload')]);
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
  });

  it('f. テストの記録が無い古い集計でも開き、テストの結果の列を出さずに理由を書く', async () => {
    const old = join(WORK, 'out-old');
    atlas(['all', '--home', logs, '--out', old, '--notes-dir', notes]);
    const path = join(old, 'sessions.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { sessions: { tests?: unknown }[] };
    for (const s of file.sessions) delete s.tests;
    await writeFile(path, JSON.stringify(file));
    atlas(['build', '--out', old, '--notes-dir', notes]);
    await page.goto(fileUrl(join(old, 'atlas.html')));
    await expect.poll(() => section().getByTestId('conditions-note').innerText()).toContain('テストの記録があるセッションが無いので、テストの結果の列は出していません');
    // 件数と、セッション全体の 3 列だけ
    expect(await texts(pooled('wiki'))).toEqual(['3 / 3', '7', '2分 7 件', '3.5 6 件', '50% 6 / 12 回']);
    expect(await texts(taskRow(COND_SOLO_TASK, '0-plain'))).toEqual(['0', '—', '—', '—']);
    expect(await section().innerText()).not.toContain('最後に全部通った');
  });

  it('g. 伏せ字版には節を出さず、課題と条件の名前も出さない', async () => {
    const anon = join(WORK, 'out-anon');
    atlas(['all', '--anonymize', '--home', logs, '--out', anon, '--notes-dir', notes]);
    // 埋め込んだデータに、課題と条件の名前(タスクタグの名前)が残っていない(画面のコードには例示の名前があるので、データだけを見る)
    const data = JSON.stringify(extractEmbedded<ReportData>(await readFile(join(anon, 'atlas.html'), 'utf8')));
    for (const name of [...TASKS, 'coderef', '0-plain', '__']) expect(data.includes(name), name).toBe(false);
    await page.goto(fileUrl(join(anon, 'atlas.html')));
    await expect.poll(() => page.locator('#compare').count()).toBe(1);
    expect(await section().count()).toBe(0);
    expect(await page.locator('nav.toc a[href="#conditions"]').count()).toBe(0);
  });

  it('h. この節が出ている出力の全ページに、要修正の指摘が無い', async () => {
    const r = await audit(out, { layoutSessions: 0 });
    const errors = r.findings.filter((f) => f.severity === 'error');
    expect(errors, summarize({ pages: r.pages, findings: errors })).toEqual([]);
  });
});
