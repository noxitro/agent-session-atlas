// 改善点の「llm-wiki のページごとの参照率と役立った率」の表(Playwright の Chromium。生成した atlas.html を file:// で開く)。
//  a. 架空の fixture を集計し、手書きの判定(llm-wiki のページごとの判定つき)を取り込むと、読んだページが 1 行ずつ出る。
//     読んだセッション・LLM の見立ての件数・未判定を列に並べ、分母が閾値に届かない率は「—」。参照率の分母と注を出す
//  b. 絞り込みに従う(ページを読んだセッションを外すと表が消え、理由の文を出す)
//  c. ページの名前を埋め込む前の版(17)の atlas.html では、表を出さずに理由を出す
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURES, ROOT, cliCommand } from '../e2e/fixture-home.ts';
import { extractEmbedded } from '../packages/report/src/lib/embed.ts';
import { emptyFilter, encodeFilter } from '../packages/report/src/lib/filter.ts';
import { THRESHOLDS } from '../packages/report/src/lib/insights.ts';
import { REPORT_DATA_VERSION, type ReportData } from '../packages/report/src/lib/types.ts';
import { WIKI_PAGES_OLD_DATA, wikiReferenced } from '../packages/report/src/lib/wiki.ts';
import { SAMPLE_WIKI_PAGES } from '../scripts/synthetic-base.ts';

const WORK = join(ROOT, 'out', 'ui-wiki-pages');

function atlas(args: string[]): void {
  const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

const fileUrl = (p: string): string => `file:///${p.replace(/\\/g, '/')}`;

describe('llm-wiki のページごとの表', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let close: () => Promise<void>;
  let browser: Browser;
  let page: Page;
  let data: ReportData;
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    // vault は e2e/global-setup.ts の fixture 用の設定(ATLAS_CONFIG)で指定してある
    atlas(['all', '--home', home, '--out', out, '--notes-dir', notes]);
    atlas(['judge', 'import', join(FIXTURES, 'judgments-sample.json'), '--out', out]);
    atlas(['export', '--home', home, '--out', out, '--notes-dir', notes]);
    data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  });
  afterAll(async () => {
    await browser?.close();
    await close?.();
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems.splice(0)).toEqual([]);
  });

  const box = () => page.getByTestId('insights-wiki-pages');
  const cells = async (sel: string): Promise<string[]> => (await box().locator(sel).allInnerTexts()).map((t) => t.trim());

  it('a. 読んだページが 1 行ずつ出て、見立ての件数と未判定を並べ、分母が閾値に届かない率は —', async () => {
    expect(data.version).toBe(REPORT_DATA_VERSION);
    const referenced = data.sessions.filter((s) => !s.empty && wikiReferenced(s.wiki)).length;
    // fixture で wiki を参照したセッションは閾値より少ない(参照率も —)
    expect(referenced).toBeLessThan(THRESHOLDS.MIN_SESSIONS);
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const table = box().getByTestId('insights-wiki-pages-table');
    await expect.poll(() => table.locator('tbody tr').count()).toBe(SAMPLE_WIKI_PAGES.length);
    expect(await cells('[data-testid="insights-wiki-pages-table"] thead th')).toEqual(['ページ', '読んだセッション', '参照率', '役立った', '役立たなかった', '分からない', '未判定', '役立った率']);
    // 行: 004 が読んだ 2 ページ。1 つ目は「役立った」、2 つ目は「分からない」(パケットに無いページの判定は出さない)
    const row = async (i: number): Promise<string[]> => (await table.locator('tbody tr').nth(i).locator('th, td').allInnerTexts()).map((t) => t.trim());
    expect(await row(0)).toEqual([SAMPLE_WIKI_PAGES[0], '1', '—', '1', '0', '0', '0', '—']);
    expect(await row(1)).toEqual([SAMPLE_WIKI_PAGES[1], '1', '—', '0', '0', '1', '0', '—']);
    expect(await box().innerText()).not.toContain('synthetic-page-unread');
    // 参照率の分母(wiki を参照したセッション)を題に出す
    expect(await table.locator('caption').innerText()).toContain(`参照率の分母は wiki を参照したセッション ${referenced} 件`);
    // 注: 引用は見ていない・LLM の見立て・1 つの点数にしない
    expect(await box().getByTestId('insights-wiki-pages-why').innerText()).toContain('回答の中で引用したかは見ていません');
    expect(await box().getByTestId('insights-wiki-pages-llm').innerText()).toContain('役立ったかは LLM の見立てで、判定役は読んだページの名前と抜粋を見たうえで答えています。測った値ではありません');
    expect(await box().innerText()).toContain(`— は分母が ${THRESHOLDS.MIN_SESSIONS} セッション未満`);
  });

  it('b. 絞り込みに従う: ページを読んだセッションを外すと表が消え、理由を出す', async () => {
    const id4 = '00000000-0000-4000-8000-000000000004';
    const others = data.sessions.filter((s) => s.id !== id4 && !s.empty).map((s) => s.id);
    await page.goto(`${fileUrl(join(out, 'atlas.html'))}#${encodeFilter({ ...emptyFilter(), ids: others.join(',') })}`);
    await expect.poll(() => box().getByTestId('insights-wiki-pages-empty').count()).toBe(1);
    expect(await box().locator('table').count()).toBe(0);
    expect(await box().getByTestId('insights-wiki-pages-empty').innerText()).toMatch(/^この条件で、llm-wiki のページを読んだセッションはありません/);
  });

  it('c. ページの名前を埋め込む前の版の atlas.html では表を出さず、理由を出す', async () => {
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const head = `{"version":${REPORT_DATA_VERSION},`;
    expect(html).toContain(head);
    const old = join(out, 'atlas-old.html');
    await writeFile(old, html.replace(head, '{"version":17,'));
    await page.goto(fileUrl(old));
    await expect.poll(() => box().getByTestId('insights-wiki-pages-old').count()).toBe(1);
    expect(await box().getByTestId('insights-wiki-pages-old').innerText()).toBe(WIKI_PAGES_OLD_DATA);
    expect(await box().locator('table').count()).toBe(0);
  });
});
