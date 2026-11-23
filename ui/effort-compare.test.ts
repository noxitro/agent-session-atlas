// 「比べる」の推論強度どうしの比較を、画面で実際に押して確かめる(Playwright の Chromium)。
// 架空の fixture(scripts/synthetic-effort.ts。利用者 3 人 × 4 週、週ごとに medium と xhigh を入れ替える)を、
// 送り先をまとめて集計する形で atlas all し、atlas serve で開く。
//  a. 推論強度を選ぶと、既定で medium と xhigh を並べ、手戻りのないセッションの割合と差の幅(95%)が出る。0 をまたぐ幅は文字で書く
//  b. 混在・記録なしの件数の 1 行と、利用者 × 週の表が出る。期間を絞ると両方に効く
//  c. 375px の幅で横にはみ出さない
//  d. 本体の推論強度の記録が無い古い集計(sessions.json に mainModelEfforts が無い)でも画面が開き、記録が無いと出す
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';
import { EFFORT_PEOPLE, EFFORT_WEEKS, writeEffortStudy } from '../scripts/synthetic-effort.ts';

const WORK = join(ROOT, 'out', 'ui-effort');

function atlas(args: string[]): void {
  const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

describe('比べる: 推論強度どうし', () => {
  const logs = join(WORK, 'logs');
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await writeEffortStudy(logs);
    atlas(['all', '--home', logs, '--out', out, '--notes-dir', notes]);
    server = await startServer({ outDir: out, notesDir: notes, port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, configPath: join(WORK, 'atlas.config.json'), copilotHome: logs });
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

  const section = () => page.locator('#compare');
  const cell = (key: string, col: number) => section().locator(`[data-testid="compare-table"] tr[data-key="${key}"] td`).nth(col);
  async function openEffort(): Promise<void> {
    await page.goto(server.url);
    await section().getByRole('button', { name: '推論強度', exact: true }).click();
  }

  it('a. 既定で medium と xhigh を並べ、手戻りのないセッションの割合と差の幅が出る', async () => {
    await openEffort();
    await expect.poll(() => section().getByTestId('compare-effort-a').inputValue()).toBe('medium');
    expect(await section().getByTestId('compare-effort-b').inputValue()).toBe('xhigh');
    expect(await section().getByTestId('compare-effort-model').inputValue()).toBe('claude-sonnet-5.5');
    // 利用者 3 人 × 4 週 × 3 件 を半々に
    expect(await cell('sessions', 0).innerText()).toBe('18');
    expect(await cell('sessions', 1).innerText()).toBe('18');
    // 主な指標は割合と差、差の幅が出る(値は fixture の決まった並びから)
    expect(await cell('no-rework', 0).innerText()).toMatch(/%$/);
    expect(await cell('no-rework', 2).innerText()).toMatch(/^[+−]?[\d.]+ ポイント$/);
    expect(await cell('no-rework', 3).innerText()).toMatch(/^[+−]?[\d.]+〜[+−]?[\d.]+ ポイント/);
    // 0 をまたぐ幅は色や印でなく文字で書く
    const widths = await section().locator('[data-testid="compare-table"] td.ci').allInnerTexts();
    expect(widths.some((t) => t.endsWith('(0 をまたぐ)'))).toBe(true);
    // 件数と比の行には幅を出さない
    expect(await cell('scored', 3).innerText()).toBe('');
    expect(await cell('aiu-per-request', 3).innerText()).toBe('');
    expect(await cell('aiu-per-request', 0).innerText()).not.toBe('—');
    // この fixture にはテストの結果の記録が無いので、テストの行は出さない
    expect(await section().locator('[data-testid="compare-table"] tr[data-key^="tests"]').count()).toBe(0);
  });

  it('b. 混在・記録なしの件数と、利用者 × 週の表。期間を絞ると両方に効く', async () => {
    await openEffort();
    const note = section().getByTestId('compare-effort-excluded');
    await expect.poll(() => note.innerText()).toContain('混在のセッション 1 件・記録なし 1 件');
    const weeks = section().getByTestId('compare-effort-weeks');
    expect(await weeks.locator('caption').innerText()).toContain('利用者 × 週');
    expect(await weeks.locator('tbody tr').count()).toBe(EFFORT_PEOPLE.length * EFFORT_WEEKS);
    expect((await weeks.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ')).toBe('zz-user-a 2026-10-05〜 3 0 0 0');
    // 最初の週だけに絞る(混在・記録なしは 2 週目なので 0 件になる)
    await section().getByLabel('推論強度を比べる期間の開始日').fill('2026-10-05');
    await section().getByLabel('推論強度を比べる期間の終了日').fill('2026-10-11');
    await expect.poll(() => note.innerText()).toContain('混在のセッション 0 件・記録なし 0 件');
    await expect.poll(() => weeks.locator('tbody tr').count()).toBe(EFFORT_PEOPLE.length);
    expect(Number(await cell('sessions', 0).innerText()) + Number(await cell('sessions', 1).innerText())).toBe(EFFORT_PEOPLE.length * 3);
  });

  it('c. 375px の幅で横にはみ出さない', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
      await openEffort();
      await section().getByTestId('compare-effort-weeks').scrollIntoViewIfNeeded();
      const over = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      expect(over).toBeLessThanOrEqual(0);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it('d. 本体の推論強度の記録が無い古い集計でも開き、記録が無いと出す', async () => {
    const old = join(WORK, 'out-old');
    atlas(['all', '--home', logs, '--out', old, '--notes-dir', notes]);
    const path = join(old, 'sessions.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { sessions: { exec?: { mainModelEfforts?: unknown } }[] };
    for (const s of file.sessions) delete s.exec?.mainModelEfforts;
    await writeFile(path, JSON.stringify(file));
    atlas(['build', '--out', old]);
    const html = await readFile(join(old, 'atlas.html'), 'utf8');
    expect(html).not.toContain('mainModelEfforts":{"');
    // 立てたサーバは別の出力先を見ているので、古い集計はファイルを直接開く
    await page.goto(`file:///${join(old, 'atlas.html').replace(/\\/g, '/')}`);
    await section().getByRole('button', { name: '推論強度', exact: true }).click();
    await expect.poll(() => section().innerText()).toContain('本体の推論強度の記録があるセッションがありません');
    // 表は空の母集団で開く(例外を出さない)
    expect(await cell('sessions', 0).innerText()).toBe('0');
  });
});
