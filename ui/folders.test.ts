// 「別のフォルダを開く…」の画面の操作(Playwright の Chromium)。
// 架空の fixture をアップロード先の形(logs/<人>/<プロジェクト>/<セッション>)に並べ、いつもの集計のサーバ(atlas serve)から、人のフォルダを選んで開く。
//  a. 集計できないフォルダは理由を出す。人のフォルダを調べると何を読むかが出て、「集計して開く」で一覧が「集計しています…」から「開いています」に変わる
//  b. 開いた先(別のサーバ)は、対象のフォルダの名前を出し、いつもの集計へのリンクを持つ。メモとタスクタグはフォルダごとの場所に書く
//  c. 開いた先のサーバが止まると「前に開いた日時」に戻り、一覧から外せる(集計の出力は残る)
// 開くのは別のプロセス(atlas open)なので、終わったら止める。どの画面でもページ内の例外とコンソールのエラーが無いこと。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { folderPaths, foldersRootOf, type FolderPaths } from '../packages/cli/src/folders.ts';
import { startServe, type ServeHandle } from '../packages/cli/src/serve.ts';
import { buildFixtureHome, ROOT } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-folders');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');

describe('別のフォルダを開く', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const logs = join(WORK, 'logs');
  const person = join(logs, 'person-a');
  const root = foldersRootOf(out);
  let fp: FolderPaths;
  let close: () => Promise<void>;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  let other: Page | undefined;
  const problems: string[] = [];

  const watch = (p: Page): void => {
    p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  };
  /** フォルダごとに立ったサーバ(別のプロセス)を止める */
  const stopChildren = (): void => {
    if (!existsSync(root)) return;
    for (const key of readdirSync(root)) {
      try {
        process.kill((JSON.parse(readFileSync(join(root, key, 'out', '.serve.json'), 'utf8')) as { pid: number }).pid);
      } catch {
        /* 立っていない・もう止まっている */
      }
    }
  };

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const atlas = (args: string[]): void => {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    };
    atlas(['all', '--home', home, '--out', out, '--notes-dir', notes]);
    // タスクタグ 2 つをアップロードして、人のフォルダの下に置く(logs/person-a/<タグ>/<セッション>)
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const ids = s.sessions.map((x) => x.id).filter((id) => existsSync(join(out, 'snapshot', 'session-state', id, 'events.jsonl')));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'proj-a', note: '', ids: ids.slice(0, 2) }, { name: 'proj-b', note: '', ids: ids.slice(2, 3) }] }));
    const upload = join(WORK, 'upload');
    await mkdir(upload, { recursive: true });
    for (const g of ['proj-a', 'proj-b']) atlas(['group', 'upload', g, '--to', upload, '--out', out, '--notes-dir', notes]);
    await cp(upload, person, { recursive: true });
    await cp(join(upload, 'proj-a'), join(logs, 'person-b', 'proj-a'), { recursive: true });
    fp = folderPaths(root, notes, person);

    server = await startServe({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000 });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page);
  }, 240_000);
  afterAll(async () => {
    stopChildren();
    await browser?.close();
    await server?.close('テスト終了');
    await close?.();
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => (other && !other.isClosed() ? other : page)));
  afterEach(() => {
    expect(problems.splice(0)).toEqual([]);
  });

  const dialog = (p: Page) => p.getByTestId('folders-dialog');
  /** 焦点のある要素の data-testid */
  const focused = (p: Page): Promise<string | null> => p.evaluate<string | null>("document.activeElement && document.activeElement.getAttribute('data-testid')");
  const row = (p: Page) => dialog(p).locator(`[data-folder-row="${fp.key}"]`);

  it('a. 人のフォルダを調べて「集計して開く」と、一覧が「集計しています…」から「開いています」に変わる', async () => {
    await page.goto(server.url);
    // いつもの集計(この PC のセッション)には、対象のフォルダの印を出さない
    expect(await page.getByTestId('source-tag').count()).toBe(0);
    await page.getByTestId('folders-open').click();
    await expect.poll(() => dialog(page).isVisible()).toBe(true);
    expect(await dialog(page).getByTestId('folders-current').count()).toBe(0);
    await expect.poll(() => dialog(page).innerText()).toContain('まだありません');

    // 集計できないもの: 入れずに押す・無いフォルダ
    await dialog(page).getByTestId('folders-check').click();
    await expect.poll(() => dialog(page).getByTestId('folders-error').innerText()).toContain('フルパス');
    await dialog(page).getByTestId('folders-path').fill(join(WORK, 'nope'));
    await dialog(page).getByTestId('folders-check').click();
    await expect.poll(() => dialog(page).getByTestId('folders-error').innerText()).toContain('見つかりません');
    // 調べられなかったときは、入力欄に焦点が戻る(直してすぐ押し直せる)
    await expect.poll(() => focused(page)).toBe('folders-path');
    expect(await dialog(page).getByTestId('folders-found').count()).toBe(0);

    // 全員の分(2 段下まで)と、人のフォルダ
    await dialog(page).getByTestId('folders-path').fill(logs);
    await dialog(page).getByTestId('folders-check').click();
    await expect.poll(() => dialog(page).getByTestId('folders-found').innerText()).toContain('3 件のフォルダをまとめて集計します');
    await dialog(page).getByTestId('folders-path').fill(person);
    await dialog(page).getByTestId('folders-check').click();
    await expect.poll(() => dialog(page).getByTestId('folders-found').innerText()).toContain('下のフォルダ 2 件をまとめて集計します(proj-a、proj-b)');
    expect(await dialog(page).getByTestId('folders-error').count()).toBe(0);
    // 調べた後は「集計して開く」に焦点が移る(Enter で進める)
    await expect.poll(() => focused(page)).toBe('folders-go');

    await dialog(page).getByTestId('folders-go').click();
    await expect.poll(() => row(page).getAttribute('data-status')).toBe('starting');
    expect(await row(page).innerText()).toContain('集計しています');
    await expect.poll(() => row(page).getAttribute('data-status'), { timeout: 100_000 }).toBe('open');
    expect(await row(page).innerText()).toContain('開いています');
    await expect.poll(() => dialog(page).locator('[role="status"]').innerText()).toContain('person-a を開きました');
    const link = row(page).getByRole('link', { name: /person-a を表示する/ });
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    expect(await link.getAttribute('href')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/atlas\.html$/);
    expect(await link.getAttribute('href')).not.toBe(server.url);
    // 集計はフォルダごとの置き場に出る(いつもの出力先の隣)
    expect(existsSync(join(fp.out, 'atlas.html'))).toBe(true);
    // もう一度「集計して開く」を押しても、二重には立てない(開いていることを伝える)
    await dialog(page).getByTestId('folders-path').fill(person);
    await dialog(page).getByTestId('folders-check').click();
    await dialog(page).getByTestId('folders-go').click();
    await expect.poll(() => dialog(page).locator('[role="status"]').innerText()).toContain('もう開いています');
    // 知らせは読み上げだけでなく、目にも見える
    expect(await dialog(page).getByTestId('folders-status').isVisible()).toBe(true);
    expect(await dialog(page).locator('[data-folder-row]').count()).toBe(1);
  });

  it('b. 開いた先は対象のフォルダの名前を出し、いつもの集計へのリンクを持つ。メモとタスクタグはフォルダごとの場所に書く', async () => {
    const href = (await row(page).getByRole('link', { name: /person-a を表示する/ }).getAttribute('href'))!;
    other = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(other);
    await other.goto(href);
    await expect.poll(() => other!.getByTestId('source-tag').innerText()).toBe('対象: person-a');
    expect(await other.getByTestId('source-tag').getAttribute('title')).toBe(person);
    await expect.poll(() => other!.title()).toBe('person-a | Copilot Session Atlas');
    // 集計したのは、そのフォルダの下の 3 件だけ
    const count = await other.evaluate<number>("JSON.parse(document.getElementById('atlas-data').textContent).sessions.length");
    expect(count).toBe(3);

    await other.getByTestId('folders-open').click();
    await expect.poll(() => dialog(other!).getByTestId('folders-current').innerText()).toContain('person-a');
    const local = dialog(other).getByTestId('folders-local');
    expect(await local.getAttribute('href')).toBe(server.url);
    expect(await row(other).getAttribute('data-status')).toBe('current');
    expect(await row(other).innerText()).toContain('この画面で表示中');
    // この画面のフォルダは、一覧から外せない
    expect(await row(other).getByRole('button').count()).toBe(0);
    await dialog(other).getByTestId('folders-close').click();
    await expect.poll(() => focused(other!)).toBe('folders-open');

    // タスクタグ: いつもの集計の proj-a / proj-b は、このフォルダの画面には無い(置き場が別)
    const token = await other.evaluate<string>("document.querySelector('meta[name=\"atlas-token\"]').content");
    const state = (await (await fetch(new URL('api/state', href), { headers: { 'x-atlas-token': token } })).json()) as { groups: unknown[]; notesDir: string };
    expect(state.groups).toEqual([]);
    expect(state.notesDir).toBe(fp.notes);
    await other.close();
  });

  it('c. 開いた先のサーバが止まると「前に開いた日時」に戻り、一覧から外せる(集計の出力は残る)', async () => {
    // ダイアログは開いたまま: 一覧は自分で読み直して、止まったことを出す(「表示する」が止まったサーバを指したままにならない)
    stopChildren();
    await expect.poll(() => row(page).getAttribute('data-status'), { timeout: 30_000, interval: 500 }).toBe('idle');
    expect(await row(page).innerText()).toContain('前に開いた日時');
    expect(await row(page).getByRole('link').count()).toBe(0);
    // 「表示する」を押してください、の知らせも一緒に消える(もう押せないので)
    expect(await dialog(page).getByTestId('folders-status').innerText()).toBe('');
    await row(page).getByRole('button', { name: 'person-a を一覧から外す' }).click();
    await expect.poll(() => dialog(page).innerText()).toContain('まだありません');
    await expect.poll(() => dialog(page).locator('[role="status"]').innerText()).toContain('一覧から外しました');
    expect(existsSync(join(fp.out, 'atlas.html'))).toBe(true);
    expect(existsSync(fp.state)).toBe(true);
  });
});
