// 改善点の「llm-wiki のページごとの参照率と役立った率」の表(Playwright の Chromium。生成した atlas.html を file:// で開く)。
//  a. 架空の fixture を集計し、手書きの判定(llm-wiki のページごとの判定つき)を取り込むと、読んだページが 1 行ずつ出る。
//     読んだセッション・LLM の見立ての件数・未判定を列に並べ、分母が閾値に届かない率は「—」。参照率の分母と注を出す
//  b. 絞り込みに従う(ページを読んだセッションを外すと表が消え、理由の文を出す)
//  c. ページの名前を埋め込む前の版(17)の atlas.html では、表を出さずに理由を出す
//  d. 11 ページ以上を読んだときは上位 10 行と「全件を表で見る」(埋め込みのデータを差し替えて確かめる)
//  e. ページの名前を押すと、そのページを読んだセッションの一覧(詳細へのリンクと見立て)が開き、もう一度押すと閉じる
//  f. 列の見出しを押すと並べ替え、aria-sort と表の題が変わる
//  g. 目次の「llm-wiki」から llm-wiki の利用の箱へ飛べる。絞り込みの「wiki を参照したセッションだけ」で、参照したセッションに絞れる
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { buildFixtureHome, FIXTURES, ROOT, cliCommand } from '../e2e/fixture-home.ts';
import { extractEmbedded, serializeForScript } from '../packages/report/src/lib/embed.ts';
import { emptyFilter, encodeFilter } from '../packages/report/src/lib/filter.ts';
import { THRESHOLDS } from '../packages/report/src/lib/insights.ts';
import { detailHref } from '../packages/report/src/lib/summarize.ts';
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
  const id4 = '00000000-0000-4000-8000-000000000004';
  /** 表に出す名前(共通のフォルダと .md を除いたもの) */
  const shortName = (p: string): string => p.split('/').pop()!.replace(/\.md$/, '');
  const referencedCount = (): number => data.sessions.filter((s) => !s.empty && wikiReferenced(s.wiki)).length;

  it('a. 読んだページが 1 行ずつ出て、見立ての件数と未判定を並べ、分母が閾値に届かない率は列ごと出さずに理由を書く', async () => {
    expect(data.version).toBe(REPORT_DATA_VERSION);
    const referenced = referencedCount();
    // fixture で wiki を参照したセッションは閾値より少ない(参照率も役立った率も、どのページも出せない)
    expect(referenced).toBeLessThan(THRESHOLDS.MIN_SESSIONS);
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const table = box().getByTestId('insights-wiki-pages-table');
    await expect.poll(() => table.locator('tbody tr').count()).toBe(SAMPLE_WIKI_PAGES.length);
    expect(await cells('[data-testid="insights-wiki-pages-table"] thead th')).toEqual(['ページ', '読んだセッション', '役立った', '役立たなかった', '分からない', '未判定']);
    // 行: 004 が読んだ 2 ページ。1 つ目は「役立った」、2 つ目は「分からない」(パケットに無いページの判定は出さない)
    const row = async (i: number): Promise<string[]> => (await table.locator('tbody tr').nth(i).locator('th, td').allInnerTexts()).map((t) => t.trim());
    expect(await row(0)).toEqual([shortName(SAMPLE_WIKI_PAGES[0]!), '1', '1', '0', '0', '0']);
    expect(await row(1)).toEqual([shortName(SAMPLE_WIKI_PAGES[1]!), '1', '0', '0', '1', '0']);
    // 元の名前は名前に重ねると出る
    expect(await table.locator('tbody th button').first().getAttribute('title')).toBe(SAMPLE_WIKI_PAGES[0]);
    expect(await box().innerText()).not.toContain('synthetic-page-unread');
    // wiki を参照したセッションの数を題に出す(参照率の列が無いときは「分母」と書かない)
    const caption = await table.locator('caption').innerText();
    expect(caption).toContain(`読んだセッションの多い順(上位 ${SAMPLE_WIKI_PAGES.length} / 全 ${SAMPLE_WIKI_PAGES.length} ページ)。wiki を参照したセッション ${referenced} 件`);
    expect(caption).not.toContain('分母');
    // 注: 名前の短くし方・引用は見ていない・LLM の見立て・出さない列の理由・1 つの点数にしない
    expect(await box().getByTestId('insights-wiki-pages-names').innerText()).toContain('ページは wiki/topics/ からの相対、.md を省いて出しています');
    expect(await box().getByTestId('insights-wiki-pages-why').innerText()).toContain('回答の中で引用したかは見ていません');
    expect(await box().getByTestId('insights-wiki-pages-llm').innerText()).toContain('役立ったかは LLM の見立てで、判定役は読んだページの名前と、ログにあれば抜粋を見たうえで答えています。測った値ではありません');
    expect(await box().getByTestId('insights-wiki-pages-no-share').innerText()).toBe(`参照率の列は出していません。wiki を参照したセッションが ${referenced} 件で、${THRESHOLDS.MIN_SESSIONS} セッションに届きません。`);
    expect(await box().getByTestId('insights-wiki-pages-no-helpful').innerText()).toContain(`役立った + 役立たなかったが ${THRESHOLDS.MIN_SESSIONS} セッションに届くページがありません`);
    expect(await box().innerText()).not.toContain('— は分母が');
    expect(await box().innerText()).toContain('参照率(ログ)と役立った率(LLM の見立て)は別の数で、1 つの点数にはまとめていません');
  });

  it('b. 絞り込みに従う: ページを読んだセッションを外すと表が消え、理由を出す', async () => {
    const others = data.sessions.filter((s) => s.id !== id4 && !s.empty).map((s) => s.id);
    await page.goto(`${fileUrl(join(out, 'atlas.html'))}#${encodeFilter({ ...emptyFilter(), ids: others.join(',') })}`);
    await expect.poll(() => box().getByTestId('insights-wiki-pages-empty').count()).toBe(1);
    expect(await box().locator('table').count()).toBe(0);
    expect(await box().getByTestId('insights-wiki-pages-empty').innerText()).toMatch(/^この条件で、llm-wiki のページを読んだセッションはありません/);
  });

  it('d. 11 ページ以上を読んだときは上位 10 行を出し、「全件を表で見る」で全ページの表を開ける', async () => {
    // 埋め込みのデータの 004 だけを、12 ページを読んだ形に差し替える(名前は辞書に、要約は番号)
    const html = await readFile(join(out, 'atlas.html'), 'utf8');
    const d = extractEmbedded<ReportData>(html);
    const names = Array.from({ length: 12 }, (_, i) => `wiki/topics/zz-page-${String(i).padStart(2, '0')}.md`);
    d.wikiPageNames = names;
    const s4 = d.sessions.find((s) => s.id === id4)!;
    s4.wiki.pages = names.map((_, i) => i);
    s4.judgment!.wikiPages = [[0, 'yes']];
    const re = /(<script type="application\/json" id="atlas-data">)[\s\S]*?(<\/script>)/;
    expect(re.test(html)).toBe(true);
    const many = join(out, 'atlas-many.html');
    await writeFile(many, html.replace(re, (_m, a: string, b: string) => `${a}${serializeForScript(d)}${b}`));
    await page.goto(fileUrl(many));
    const table = box().getByTestId('insights-wiki-pages-table');
    await expect.poll(() => table.locator('tbody tr').count()).toBe(10);
    expect(await table.locator('caption').innerText()).toContain('上位 10 / 全 12 ページ');
    const all = box().locator('details.tableview');
    expect(await all.locator('summary').innerText()).toBe('全件を表で見る(12 ページ)');
    await all.locator('summary').click();
    const full = box().getByTestId('insights-wiki-pages-all');
    await expect.poll(() => full.locator('tbody tr').count()).toBe(12);
    // 読んだセッションが同じなら名前の順。番号から名前に戻し、共通のフォルダと .md を除いて並べる
    expect((await full.locator('tbody th').allInnerTexts()).map((t) => t.trim())).toEqual(names.map(shortName));
    expect((await full.locator('tbody tr').first().locator('td').allInnerTexts()).map((t) => t.trim())).toEqual(['1', '1', '0', '0', '0']);
  });

  it('e. ページの名前を押すと、読んだセッションの一覧と見立てが開き、もう一度押すと閉じる', async () => {
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const table = box().getByTestId('insights-wiki-pages-table');
    const open = (i: number) => table.locator('tbody th button.open').nth(i);
    await expect.poll(() => open(0).count()).toBe(1);
    expect(await open(0).getAttribute('aria-expanded')).toBe('false');
    expect(await open(0).getAttribute('aria-controls')).toBeNull();
    await open(0).click();
    const readers = table.getByTestId('insights-wiki-pages-readers');
    await expect.poll(() => readers.count()).toBe(1);
    expect(await open(0).getAttribute('aria-expanded')).toBe('true');
    expect(await open(0).getAttribute('aria-controls')).toBe(await readers.getAttribute('id'));
    // 開いた行はページの行のすぐ下。元の名前・読んだセッションの数・詳細へのリンク・見立て
    expect(await table.locator('tbody tr').nth(1).getAttribute('data-testid')).toBe('insights-wiki-pages-readers');
    expect(await readers.innerText()).toContain(`${SAMPLE_WIKI_PAGES[0]} を読んだセッション 1 件(新しい順)`);
    const links = readers.locator('li a');
    expect(await links.count()).toBe(1);
    expect(await links.first().getAttribute('href')).toBe(detailHref(id4));
    expect((await readers.locator('li .meta').innerText()).trim()).toMatch(/ · 役立った$/);
    // 2 つ目のページも開ける(見立ては「分からない」)。1 つ目とは別に開閉する
    await open(1).click();
    await expect.poll(() => readers.count()).toBe(2);
    expect((await readers.nth(1).locator('li .meta').innerText()).trim()).toMatch(/ · 分からない$/);
    await open(0).click();
    await expect.poll(() => readers.count()).toBe(1);
    expect(await open(0).getAttribute('aria-expanded')).toBe('false');
    expect(await readers.innerText()).toContain(SAMPLE_WIKI_PAGES[1]);
    // キーボードでも開ける
    await open(0).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => readers.count()).toBe(2);
  });

  it('f. 列の見出しを押すと並べ替え、aria-sort と表の題が変わる', async () => {
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const table = box().getByTestId('insights-wiki-pages-table');
    const head = (label: string) => table.locator('thead th', { hasText: new RegExp(`^${label}$`) });
    const names = async (): Promise<string[]> => (await table.locator('tbody th').allInnerTexts()).map((t) => t.trim());
    const [a, b] = SAMPLE_WIKI_PAGES.map(shortName);
    await expect.poll(names).toEqual([a, b]);
    expect(await head('読んだセッション').getAttribute('aria-sort')).toBe('descending');
    expect(await head('ページ').getAttribute('aria-sort')).toBe('none');
    // 分からない: はじめは多い順(b が上)、もう一度押すと少ない順
    await head('分からない').locator('button').click();
    await expect.poll(names).toEqual([b, a]);
    expect(await head('分からない').getAttribute('aria-sort')).toBe('descending');
    expect(await head('読んだセッション').getAttribute('aria-sort')).toBe('none');
    expect(await table.locator('caption').innerText()).toMatch(/^分からないの多い順/);
    await head('分からない').locator('button').click();
    await expect.poll(names).toEqual([a, b]);
    expect(await head('分からない').getAttribute('aria-sort')).toBe('ascending');
    expect(await table.locator('caption').innerText()).toMatch(/^分からないの少ない順/);
    // ページ: はじめは名前の順、もう一度押すと逆順
    await head('ページ').locator('button').click();
    await expect.poll(() => head('ページ').getAttribute('aria-sort')).toBe('ascending');
    expect(await names()).toEqual([a, b]);
    await head('ページ').locator('button').click();
    await expect.poll(names).toEqual([b, a]);
    expect(await table.locator('caption').innerText()).toMatch(/^ページの名前の逆順/);
  });

  it('g. 目次の「llm-wiki」から利用の箱へ飛べ、「wiki を参照したセッションだけ」で絞り込める', async () => {
    await page.goto(fileUrl(join(out, 'atlas.html')));
    const toc = page.locator('nav.toc a', { hasText: /^llm-wiki$/ });
    await expect.poll(() => toc.count()).toBe(1);
    expect(await toc.getAttribute('href')).toBe('#insights-wiki');
    expect(await page.locator('#insights-wiki').getAttribute('data-testid')).toBe('insights-wiki');
    await toc.click();
    await expect.poll(() => page.locator('#insights-wiki').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThan(400);
    // 絞り込み: 「その他の条件」を開くと出る。件数は wiki を参照したセッション
    const referenced = referencedCount();
    await page.locator('.more-toggle').click();
    const check = page.getByTestId('wiki-filter');
    await expect.poll(() => check.isVisible()).toBe(true);
    expect(await check.locator('xpath=..').innerText()).toContain(`wiki を参照したセッションだけ(${referenced})`);
    await check.check();
    await expect.poll(() => page.evaluate<string>('location.hash')).toContain('wiki=1');
    await expect.poll(async () => Number((await page.getByTestId('shown-count').innerText()).replace(/,/g, ''))).toBe(referenced);
    // 絞り込みで参照なしが 0 になる。ページの表はそのまま
    expect(await box().getByTestId('insights-wiki-pages-table').locator('tbody tr').count()).toBe(SAMPLE_WIKI_PAGES.length);
    // ハッシュから開き直しても効いている(チェックが付き、閉じられない「その他の条件」が開いている)
    await page.reload();
    await expect.poll(() => page.getByTestId('wiki-filter').isChecked()).toBe(true);
    expect(await page.getByTestId('wiki-filter').isVisible()).toBe(true);
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
