// 集計する人が見る列と行(タスクの詰まりの列・人別の依頼ごとの判定・「比べる」の残存の内訳・依頼の上限)を、画面で確かめる(Playwright の Chromium)。
// 架空の fixture(scripts/synthetic-effort.ts。利用者 3 人 × 4 週)を送り先をまとめて集計する形で atlas all し、
// 埋め込みのデータを差し替えて file:// で開く。値・名前はすべて架空のもの。
//  a. タスクの表に、人数・主なモデル・摩擦・判定した依頼・直しの割合の列が出て、並べ替えられる。下限に届かない割合は —
//  b. タスクの表は、狭い幅(390px)では表の中で横に流れ、ページは横にはみ出さない。広い幅でも同じ列が出る
//  c. 人別の表に、判定した依頼・採用率・直しの割合・合わなかった点(最多)の列が出る。判定できた作業の依頼が下限に届かない人は —
//  d. 「比べる」の残存: 開始時の基準の記録・推定、比べた版の内訳、照合不可の理由別の件数が並び、版が混ざった側の割合は — で理由を出す
//  e. 「採用(LLM の判定)」の節に、依頼の上限を超えて判定の束に入らなかった依頼の数が出る
// どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { ROOT, cliCommand } from '../e2e/fixture-home.ts';
import { extractEmbedded, serializeForScript } from '../packages/report/src/lib/embed.ts';
import type { ReportData, TaskRow, TasksReport } from '../packages/report/src/lib/types.ts';
import type { RetentionItem } from '../packages/report/src/lib/retention.ts';
import type { VerdictTuple } from '../packages/report/src/lib/verdicts.ts';
import { EFFORT_MODEL, EFFORT_PEOPLE, writeEffortStudy } from '../scripts/synthetic-effort.ts';

const WORK = join(ROOT, 'out', 'ui-central-eval');

function atlas(args: string[]): void {
  const r = spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

const fileUrl = (p: string): string => `file:///${p.replace(/\\/g, '/')}`;
const RE = /(<script type="application\/json" id="atlas-data">)[\s\S]*?(<\/script>)/;

/** タスクの行(架空)。詰まりの列だけを変える */
function task(id: string, o: Partial<TaskRow>): TaskRow {
  return {
    id,
    name: `${id} の作業`,
    status: 'Done',
    done: true,
    doneAt: '2026-10-20T09:00:00.000Z',
    doneObserved: true,
    doneAtSource: 'observed',
    missing: false,
    start: '2026-10-19T09:00:00.000Z',
    workMs: 8 * 3_600_000,
    aiActiveMs: 3_600_000,
    humanHours: 4,
    sessions: 3,
    sharedSessions: 0,
    judgedSessions: 3,
    lowConfidenceSessions: 0,
    unjudgedSessions: 0,
    afterDoneSessions: 0,
    links: { machine: 3, llm: 0, manual: 0 },
    comparable: true,
    excluded: null,
    people: 2,
    mainModel: EFFORT_MODEL,
    mainModelShare: 0.8,
    friction: { toolFailures: 1, aborts: 0, compactions: 0 },
    verdicts: null,
    ...o,
  };
}

const verdicts = (judged: number, workDecided: number, fix: number, fixRate: number | null): TaskRow['verdicts'] => ({ judged, workDecided, questionDecided: 0, fix, rejected: 0, offTarget: 0, fixRate, rejectedRate: fixRate == null ? null : 0, offTargetRate: null });

function tasksReport(): TasksReport {
  const items = [
    task('ZZ-1', { friction: { toolFailures: 5, aborts: 2, compactions: 1 }, verdicts: verdicts(12, 10, 4, 0.4) }),
    task('ZZ-2', { people: 1, mainModel: 'zz-model-b', mainModelShare: 1, friction: { toolFailures: 0, aborts: 0, compactions: 0 }, verdicts: verdicts(3, 3, 2, null) }),
    task('ZZ-3', { people: 3, friction: { toolFailures: 2, aborts: 0, compactions: 3 }, verdicts: verdicts(8, 6, 1, 1 / 6), excluded: 'noWorkHours', comparable: false, workMs: null }),
  ];
  const excluded = { notDone: 0, doneUnobserved: 0, afterDone: 0, noStart: 0, noWorkHours: 1, unjudged: 0, lowConfidence: 0 };
  return {
    configured: true,
    origin: 'local',
    file: 'zz-export.xml',
    observedAt: '2026-10-21T00:00:00.000Z',
    workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
    warnings: [],
    items,
    links: {},
    summary: { tasks: 3, doneTasks: 3, included: 2, excluded, workMs: 16 * 3_600_000, humanHours: 8, aiActiveMs: 2 * 3_600_000, aiActiveMsAll: 3 * 3_600_000, sharedSessions: 0, ratio: null, ratioMin: 5, verdictMin: 5 },
  };
}

describe('集計する人が見る列と行', () => {
  const logs = join(WORK, 'logs');
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let browser: Browser;
  let page: Page;
  let html: string;
  let path = '';
  /** wiki を参照したことにした(A の側の)セッションの数と、そのうち fixed で比べたことにした数 */
  let referenced = 0;
  let fixedA = 0;
  const problems: string[] = [];

  /** 埋め込みのデータを変えた atlas.html を書き、そのパスを返す */
  async function variant(name: string, edit: (d: ReportData) => void): Promise<string> {
    const d = extractEmbedded<ReportData>(html);
    edit(d);
    const p = join(out, `${name}.html`);
    await writeFile(p, html.replace(RE, (_m, a: string, b: string) => `${a}${serializeForScript(d)}${b}`));
    return p;
  }

  /**
   * タスクの節・依頼ごとの判定・残存の照合を足す。
   * 判定: 1 人目は全セッションに 2 件(そのまま・中身の直し(誤り))、2 人目は 1 セッションだけ 2 件、3 人目は無し。
   * 残存: 3 件に 1 件を wiki を参照したことにし(A の側)、その側だけ比べた版を worktree と fixed で交互にする(B はすべて worktree)。
   * 最初のセッションの依頼の数を上限より 30 多くする
   */
  function edit(d: ReportData): void {
    d.tasks = tasksReport();
    d.turnJudgments = { available: true, model: null, ranAt: null, items: 0, phases: ['実装'] };
    d.retention = { generatedAt: '2026-10-28T00:00:00.000Z', computedOn: 'local', mode: 'worktree', similarity: 0.75, pathMap: 0, sessions: d.sessions.length };
    d.wikiVaults = 1;
    const list = [...d.sessions].sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
    const secondSeen = new Set<string>();
    referenced = 0;
    fixedA = 0;
    let judged = 0;
    list.forEach((s, i) => {
      const v: VerdictTuple[] = [
        [1, 0, 0, null, 0, 80],
        [2, 0, 1, 1, 0, 70],
      ];
      if (s.person === EFFORT_PEOPLE[0] || (s.person === EFFORT_PEOPLE[1] && !secondSeen.has(s.id) && secondSeen.size === 0)) {
        if (s.person === EFFORT_PEOPLE[1]) secondSeen.add(s.id);
        s.turnVerdicts = v;
        judged += v.length;
      }
      const a = i % 3 === 0;
      if (a) {
        s.wiki = { ...s.wiki, indexReads: 1 };
        referenced++;
      }
      const mode: RetentionItem['mode'] = a && referenced % 2 === 0 ? 'fixed' : 'worktree';
      if (a && mode === 'fixed') fixedA++;
      s.retention = { outcome: 'measured', reason: null, vcs: 'git', baseline: i % 4 === 0 ? 'estimated' : 'observed', on: 'local', mapped: false, hunks: [2, 0, 1, 0], lines: [4, 0, 2, 0], lag: 7, mode };
    });
    // B の側(参照していない)に照合不可を 2 件
    const b = list.filter((_, i) => i % 3 !== 0);
    b[0].retention = { outcome: 'unattributable', reason: 'too_recent', vcs: 'git', baseline: null, on: 'local', mapped: false, hunks: [0, 0, 0, 2], lines: [0, 0, 0, 4] };
    b[1].retention = { outcome: 'unattributable', reason: 'outside_repo', vcs: 'git', baseline: null, on: 'local', mapped: false, hunks: [0, 0, 0, 1], lines: [0, 0, 0, 1] };
    d.turnJudgments.items = judged;
    list[0].turns = 230;
  }

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    await writeEffortStudy(logs);
    atlas(['all', '--home', logs, '--out', out, '--notes-dir', notes]);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    expect(RE.test(html)).toBe(true);
    path = await variant('central', edit);
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

  const table = () => page.getByTestId('tasks-table');
  const order = () => table().locator('tbody tr').evaluateAll((trs) => trs.map((tr) => (tr as unknown as { dataset: Record<string, string> }).dataset.task));

  it('a. タスクの表に詰まりの列が出て、並べ替えられる。下限に届かない割合は —', async () => {
    await page.goto(fileUrl(path) + '#tasks');
    await table().waitFor({ state: 'visible' });
    const head = await table().locator('thead').innerText();
    for (const h of ['人数', '主なモデル', '摩擦', '判定した依頼', '直しの割合']) expect(head).toContain(h);
    const row = (id: string) => table().locator(`tr[data-task="${id}"]`);
    expect(await row('ZZ-1').getByTestId('task-people').innerText()).toBe('2');
    expect(await row('ZZ-1').getByTestId('task-friction').innerText()).toContain('失敗・拒否 5・中断 2・圧縮 1');
    expect((await row('ZZ-1').getByTestId('task-friction').innerText()).split('\n')[0]).toBe('8');
    expect(await row('ZZ-1').getByTestId('task-model').innerText()).toContain('本体のリクエストの 80%');
    expect(await row('ZZ-1').getByTestId('task-judged').innerText()).toContain('直し 4(40%)');
    expect((await row('ZZ-1').getByTestId('task-fix-rate').innerText()).split('\n')[0]).toBe('40%');
    // 判定できた作業の依頼が 3 件(下限 5 未満)なら割合は —
    expect((await row('ZZ-2').getByTestId('task-fix-rate').innerText()).split('\n')[0]).toBe('—');
    expect(await row('ZZ-2').getByTestId('task-fix-rate').getAttribute('title')).toContain('5 件に届かない');
    // 稼働時間帯に重ならないタスクは理由を出す
    expect(await row('ZZ-3').innerText()).toContain('稼働時間帯に重ならない');
    expect(await page.getByTestId('tasks-panel').innerText()).toContain('比べないもの: 稼働時間帯に重ならない 1');
    expect(await page.getByTestId('tasks-friction-defs').innerText()).toContain('分母が 5 件に届かない割合は「—」');
    // 並べ替え: 摩擦の多い順 → 直しの割合の多い順(— は最後)→ 人数の多い順
    await table().getByRole('button', { name: '摩擦' }).click();
    expect(await order()).toEqual(['ZZ-1', 'ZZ-3', 'ZZ-2']);
    await table().getByRole('button', { name: '直しの割合' }).click();
    expect(await order()).toEqual(['ZZ-1', 'ZZ-3', 'ZZ-2']);
    await table().getByRole('button', { name: '直しの割合' }).click();
    expect(await order()).toEqual(['ZZ-2', 'ZZ-3', 'ZZ-1']);
    await table().getByRole('button', { name: '人数' }).click();
    expect(await order()).toEqual(['ZZ-3', 'ZZ-1', 'ZZ-2']);
    expect(await table().locator('th[aria-sort="descending"]').innerText()).toContain('人数');
  });

  it('b. タスクの表は、狭い幅では表の中で横に流れ、ページは横にはみ出さない', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fileUrl(path) + '#tasks');
      await table().waitFor({ state: 'visible' });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${width}px`).toBe(true);
      const scroll = await table().evaluate((t) => {
        const box = (t as unknown as { parentElement: { className: string; scrollWidth: number; clientWidth: number } }).parentElement;
        return { cls: box.className, scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
      });
      expect(scroll.cls).toContain('table-scroll');
      // 狭い幅では、表は枠より広く、枠の中で横に流れる
      if (width === 390) expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
      expect(await table().locator('thead').innerText()).toContain('直しの割合');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('c. 人別の表に、判定した依頼・採用率・直しの割合・合わなかった点(最多)の列が出る。下限に届かない人は —', async () => {
    await page.goto(fileUrl(path) + '#people');
    const people = page.locator('#people');
    await people.waitFor({ state: 'visible' });
    const head = await people.locator('thead').innerText();
    for (const h of ['判定した依頼', '採用率', '直しの割合', '合わなかった点(最多)']) expect(head).toContain(h);
    expect(await people.getByTestId('people-verdict-note').innerText()).toContain('5 件未満なら「—」');
    const row = (person: string) => people.locator('tbody tr', { has: page.getByRole('link', { name: person, exact: true }) });
    const a = row(EFFORT_PEOPLE[0]);
    const judgedA = Number(await a.getByTestId('person-verdict-judged').innerText());
    expect(judgedA).toBeGreaterThanOrEqual(10);
    expect((await a.getByTestId('person-verdict-adopt').innerText()).split('\n')[0]).toBe('50%');
    expect((await a.getByTestId('person-verdict-fix').innerText()).split('\n')[0]).toBe('50%');
    expect(await a.getByTestId('person-verdict-mismatch').innerText()).toContain('誤り');
    // 2 人目は判定した依頼が 2 件だけ、3 人目は無い
    const b = row(EFFORT_PEOPLE[1]);
    expect(await b.getByTestId('person-verdict-judged').innerText()).toBe('2');
    expect((await b.getByTestId('person-verdict-adopt').innerText()).split('\n')[0]).toBe('—');
    expect(await b.getByTestId('person-verdict-mismatch').innerText()).toBe('—');
    expect(await row(EFFORT_PEOPLE[2]).getByTestId('person-verdict-judged').innerText()).toBe('0');
    // 採用率で並べ替えられる(— は最後)
    await people.getByRole('button', { name: '採用率' }).click();
    expect(await people.locator('tbody tr th a').first().innerText()).toBe(EFFORT_PEOPLE[0]);
    // プロジェクト別の表には出さない(列が多いため)
    expect(await page.locator('#projects thead').innerText()).not.toContain('採用率');
    for (const width of [390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('d. 「比べる」の残存: 基準の記録・推定、比べた版の内訳、照合不可の理由別が並び、版が混ざった側の割合は — で理由を出す', async () => {
    await page.goto(fileUrl(path) + '#compare');
    const section = page.locator('#compare');
    await section.getByRole('button', { name: 'wiki の参照', exact: true }).click();
    const cell = (key: string, col: number) => section.locator(`[data-testid="compare-table"] tr[data-key="${key}"] td`).nth(col);
    await expect.poll(() => cell('sessions', 0).innerText()).toBe(String(referenced));
    // A(参照した)は worktree と fixed が混ざっているので割合と日数は —、B は出す
    expect(fixedA).toBeGreaterThan(0);
    expect(await cell('retention-kept', 0).innerText()).toBe('—');
    expect(await cell('retention-kept', 1).innerText()).toMatch(/%$/);
    expect(await cell('retention-lag', 0).innerText()).toBe('—');
    const mixed = await section.getByTestId('compare-retention-mixed').innerText();
    expect(mixed).toContain(`A: 比べる版が混ざっています(worktree ${referenced - fixedA}・fixed ${fixedA})`);
    expect(mixed).not.toContain('B: 比べる版');
    expect(await cell('retention-mode-fixed', 0).innerText()).toBe(String(fixedA));
    expect(await cell('retention-mode-fixed', 1).innerText()).toBe('0');
    expect(Number(await cell('retention-baseline-estimated', 0).innerText()) + Number(await cell('retention-baseline-estimated', 1).innerText())).toBeGreaterThan(0);
    expect(await cell('retention-baseline-observed', 2).innerText()).toBe('');
    expect(await cell('retention-unattributable', 1).innerText()).toBe('2');
    expect(await cell('retention-unattributable-too_recent', 1).innerText()).toBe('1');
    expect(await cell('retention-unattributable-outside_repo', 1).innerText()).toBe('1');
    expect(await section.locator('[data-testid="compare-table"] tr[data-key="retention-kept"] .how').innerText()).toContain('単位はまとまり');    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('e. 「採用(LLM の判定)」の節に、依頼の上限を超えて判定の束に入らなかった依頼の数が出る', async () => {
    await page.goto(fileUrl(path) + '#phases');
    const note = page.getByTestId('verdicts-over-limit');
    await note.waitFor({ state: 'visible' });
    expect(await note.innerText()).toBe('1 セッションの先頭 200 依頼までを判定の束に入れます。この条件では、上限を超えて束に入らなかった依頼が 30 件(1 セッション)あり、判定しません。');
  });
});
