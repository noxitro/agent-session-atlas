// 「比べる」のモデルどうし・wiki の参照と人ごとの差、「モデルと推論強度の効果」の人の選択を、画面で実際に押して確かめる(Playwright の Chromium)。
// 架空の fixture(scripts/synthetic-effort.ts。利用者 3 人 × 4 週)を送り先をまとめて集計する形で atlas all し、
// 埋め込みのデータを差し替えて(人ごとにセッションを交互に別のモデルにし、一部を wiki を参照したことにする)file:// で開く。値・名前はすべて架空のもの。
//  a. 種類に「モデル」と「wiki の参照」が出る。モデルどうしは既定で多い順の 2 つを並べ、混在・記録なしの件数を出す
//  b. 人の記録があるときだけ「人ごとの差」が出て、使えた人・平均・人を単位にした幅と、畳んだ人ごとの表が出る
//  c. wiki の参照で比べると、A が参照したセッションの数になる。wiki を数えていない集計では押せず、理由を出す
//  d. 人の記録が無い集計では、人ごとの差も「モデルと推論強度の効果」の人の選択も出ない
//  e. 「モデルと推論強度の効果」で人を選ぶと、その人のセッションだけで表を作る
//  f. 375px の幅で横にはみ出さない
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { ROOT, cliCommand } from '../e2e/fixture-home.ts';
import { extractEmbedded, serializeForScript } from '../packages/report/src/lib/embed.ts';
import type { ReportData } from '../packages/report/src/lib/types.ts';
import { EFFORT_MODEL, EFFORT_PEOPLE, writeEffortStudy } from '../scripts/synthetic-effort.ts';

const WORK = join(ROOT, 'out', 'ui-compare-person');
const OTHER_MODEL = 'zz-model-b';

function atlas(args: string[]): void {
  const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

const fileUrl = (p: string): string => `file:///${p.replace(/\\/g, '/')}`;
const RE = /(<script type="application\/json" id="atlas-data">)[\s\S]*?(<\/script>)/;

describe('比べる: モデル・wiki の参照・人ごとの差', () => {
  const logs = join(WORK, 'logs');
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let browser: Browser;
  let page: Page;
  let html: string;
  /** wiki を参照したことにしたセッションの数 */
  let referenced = 0;
  const problems: string[] = [];

  /** 埋め込みのデータを変えた atlas.html を書き、そのパスを返す */
  async function variant(name: string, edit: (d: ReportData) => void): Promise<string> {
    const d = extractEmbedded<ReportData>(html);
    edit(d);
    const p = join(out, `${name}.html`);
    await writeFile(p, html.replace(RE, (_m, a: string, b: string) => `${a}${serializeForScript(d)}${b}`));
    return p;
  }

  /** 人ごとに、開始の順で交互に別のモデルにする(本体のリクエストのモデルの名前だけを変える)。3 件に 1 件を wiki を参照したことにする */
  function study(d: ReportData): void {
    const seen = new Map<string, number>();
    const list = [...d.sessions].sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
    referenced = 0;
    list.forEach((s, i) => {
      const k = seen.get(s.person ?? '') ?? 0;
      seen.set(s.person ?? '', k + 1);
      const main = s.exec.mainModelEfforts;
      if (k % 2 === 1 && main[EFFORT_MODEL]) {
        main[OTHER_MODEL] = main[EFFORT_MODEL];
        delete main[EFFORT_MODEL];
      }
      if (i % 3 === 0) {
        s.wiki = { ...s.wiki, indexReads: 1 };
        referenced++;
      }
    });
    d.wikiVaults = 1;
  }

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await writeEffortStudy(logs);
    atlas(['all', '--home', logs, '--out', out, '--notes-dir', notes]);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    expect(RE.test(html)).toBe(true);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems.splice(0)).toEqual([]);
  });

  const section = () => page.locator('#compare');
  const cell = (key: string, col: number) => section().locator(`[data-testid="compare-table"] tr[data-key="${key}"] td`).nth(col);
  const kindButton = (name: string) => section().getByRole('button', { name, exact: true });

  it('a. 種類に「モデル」と「wiki の参照」が出て、モデルどうしは多い順の 2 つを並べ、混在・記録なしの件数を出す', async () => {
    await page.goto(fileUrl(await variant('study', study)));
    await expect.poll(() => kindButton('モデル').count()).toBe(1);
    expect(await kindButton('wiki の参照').count()).toBe(1);
    await kindButton('モデル').click();
    const ma = await section().getByTestId('compare-model-a').inputValue();
    const mb = await section().getByTestId('compare-model-b').inputValue();
    expect([ma, mb].sort()).toEqual([EFFORT_MODEL, OTHER_MODEL].sort());
    // 利用者 3 人 × 12 件 を交互に(混在・記録なしの 2 件は数えない)
    expect(Number(await cell('sessions', 0).innerText()) + Number(await cell('sessions', 1).innerText())).toBe(EFFORT_PEOPLE.length * 12);
    expect(await cell('no-rework', 3).innerText()).toMatch(/^([+−]?[\d.]+〜[+−]?[\d.]+ ポイント|—)/);
    const note = section().getByTestId('compare-model-excluded');
    expect(await note.innerText()).toContain('混在のセッション 1 件・記録なし 1 件');
    // 強度をそろえると、その強度と決まったセッションだけになる
    const selected = (id: string) => section().getByTestId(id).locator('option:checked').textContent().then((t) => t ?? '');
    await section().getByTestId('compare-model-effort').selectOption('medium');
    await expect.poll(async () => Number(await cell('sessions', 0).innerText()) + Number(await cell('sessions', 1).innerText())).toBeLessThan(EFFORT_PEOPLE.length * 12);
    expect(await section().locator('[data-testid="compare-table"] th.num').first().innerText()).toContain('medium');
    // モデルの選択肢の「期間内 N」も、選んだ強度で数える(表の A・B のセッション数と同じ)
    expect(await selected('compare-model-a')).toContain(`(期間内 ${await cell('sessions', 0).innerText()})`);
    expect(await selected('compare-model-b')).toContain(`(期間内 ${await cell('sessions', 1).innerText()})`);
  });

  it('b. 人の記録があるときだけ、人ごとの差(使えた人・平均・人を単位にした幅)と、畳んだ人ごとの表が出る', async () => {
    await page.goto(fileUrl(join(out, 'study.html')));
    await kindButton('モデル').click();
    const box = section().getByTestId('compare-person');
    await expect.poll(() => box.count()).toBe(1);
    // 説明は最初の 2 文だけを見せ、残り(数え方と注意)は畳む
    expect(await box.getByTestId('compare-person-lead').innerText()).toBe('同じ人の中での差を平均したもので、人の違いの影響を減らします。差は相関で、条件の違いが原因とは限りません。');
    const notesBox = box.getByTestId('compare-person-notes');
    expect(await notesBox.getAttribute('open')).toBeNull();
    expect(await notesBox.locator('summary').innerText()).toBe('数え方と注意');
    expect(await box.innerText()).not.toContain('人の数が少ないと幅は広くなります');
    await notesBox.locator('summary').click();
    expect(await notesBox.innerText()).toContain('人の数が少ないと幅は広くなります');
    await notesBox.locator('summary').click();
    const row = box.locator('[data-testid="compare-person-table"] tr[data-key="no-rework"] td');
    expect(await row.nth(0).innerText()).toBe(String(EFFORT_PEOPLE.length));
    expect(await row.nth(1).innerText()).toMatch(/^[+−]?[\d.]+ ポイント$|^0 ポイント$/);
    expect(await row.nth(2).innerText()).toMatch(/^[+−]?[\d.]+〜[+−]?[\d.]+ ポイント/);
    // 件数・比の行は入れない
    expect(await box.locator('[data-testid="compare-person-table"] tr[data-key="sessions"]').count()).toBe(0);
    expect(await box.locator('[data-testid="compare-person-table"] tr[data-key="aiu-per-request"]').count()).toBe(0);
    // 側の名前を添える
    expect(await box.getByTestId('compare-person-sides').innerText()).toMatch(/^A: .+ \/ B: .+/);
    // 3 人とも使えるので、理由の文は出さない
    expect(await box.getByTestId('compare-person-reason').count()).toBe(0);
    // 畳んだ人ごとの表
    const detail = box.getByTestId('compare-person-detail');
    expect(await detail.getAttribute('open')).toBeNull();
    await detail.locator('summary').click();
    const groups = detail.getByTestId('compare-person-groups');
    expect(await groups.locator('tbody tr').count()).toBe(EFFORT_PEOPLE.length);
    expect(await groups.locator('tbody tr th').first().innerText()).toBe(EFFORT_PEOPLE[0]);
    // 既定の期間の比べ方(期間)では、人ごとに足りる件数が無いので、理由を出して幅を出さない
    await kindButton('期間').click();
    await section().locator('input[type="date"]').nth(0).fill('2026-10-05');
    await section().locator('input[type="date"]').nth(1).fill('2026-10-11');
    await section().locator('input[type="date"]').nth(2).fill('2026-10-12');
    await section().locator('input[type="date"]').nth(3).fill('2026-10-18');
    await expect.poll(() => box.getByTestId('compare-person-reason').count()).toBe(1);
    expect(await box.getByTestId('compare-person-reason').innerText()).toContain('人を単位にした幅は出しません');
  });

  it('c. wiki の参照で比べると A が参照したセッションの数。wiki を数えていない集計では押せず、理由を出す', async () => {
    await page.goto(fileUrl(join(out, 'study.html')));
    await kindButton('wiki の参照').click();
    await expect.poll(() => cell('sessions', 0).innerText()).toBe(String(referenced));
    expect(Number(await cell('sessions', 1).innerText())).toBeGreaterThan(0);
    expect(await section().locator('[data-testid="compare-table"] th.num').first().innerText()).toContain('wiki を参照した');
    expect(await section().getByTestId('compare-wiki-off').count()).toBe(0);
    // 人ごとの差では、差の向きが「参照していない − 参照した」と読めるようにする
    expect(await section().getByTestId('compare-person-sides').innerText()).toContain('差(B − A)は「wiki を参照していない − 参照した」です');
    // 数えていない集計
    await page.goto(fileUrl(await variant('no-wiki', (d) => (study(d), (d.wikiVaults = 0)))));
    await expect.poll(() => kindButton('wiki の参照').isDisabled()).toBe(true);
    expect(await section().getByTestId('compare-wiki-off').innerText()).toContain('wiki の参照は数えていません');
  });

  it('d. 人の記録が無い集計では、人ごとの差も、モデルと推論強度の効果の人の選択も出ない', async () => {
    await page.goto(fileUrl(await variant('no-person', (d) => (study(d), d.sessions.forEach((s) => (s.person = null))))));
    await kindButton('モデル').click();
    await expect.poll(() => cell('sessions', 0).innerText()).not.toBe('0');
    expect(await section().getByTestId('compare-person').count()).toBe(0);
    expect(await page.getByTestId('model-value-person').count()).toBe(0);
  });

  it('e. モデルと推論強度の効果で人を選ぶと、その人のセッションだけで表を作る', async () => {
    await page.goto(`${fileUrl(join(out, 'study.html'))}#tab=breakdown`);
    const pick = page.getByTestId('model-value-person');
    await expect.poll(() => pick.count()).toBe(1);
    const total = async (): Promise<number> => {
      const cells = await page.locator('[data-testid="model-value-table"] tbody tr td:nth-child(3)').allInnerTexts();
      return cells.reduce((a, t) => a + Number(t.replace(/[^\d]/g, '')), 0);
    };
    const all = await total();
    // 選択肢は「すべて」・人の名前の順。値は名前でなく位置なので、位置で選ぶ
    await pick.selectOption({ index: 2 });
    await expect.poll(() => page.getByTestId('model-value-person-note').innerText()).toContain(`${EFFORT_PEOPLE[1]} のセッション`);
    await expect.poll(total).toBeLessThan(all);
    expect(await total()).toBeGreaterThan(0);
    // 上の絞り込みで人が 1 人になると選択欄が消え、人の選択は「すべて」に戻る(絞り込みを外しても、選んでいた人に戻らない)
    await page.evaluate(`location.hash = 'person=${EFFORT_PEOPLE[1]}&tab=breakdown'`);
    await expect.poll(() => pick.count()).toBe(0);
    expect(await page.getByTestId('model-value-person-note').count()).toBe(0);
    await page.evaluate(`location.hash = 'tab=breakdown'`);
    await expect.poll(() => pick.count()).toBe(1);
    expect(await pick.inputValue()).toBe('all');
    expect(await total()).toBe(all);
  });

  it('f. 375px の幅で横にはみ出さない', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
      await page.goto(fileUrl(join(out, 'study.html')));
      await kindButton('モデル').click();
      const detail = section().getByTestId('compare-person-detail');
      await detail.locator('summary').click();
      await detail.scrollIntoViewIfNeeded();
      const over = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      expect(over).toBeLessThanOrEqual(0);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
});
