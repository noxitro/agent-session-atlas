// 「AI の変更の残存」の節で、照合できたセッションが少ないときに割合を出さないことを、画面で確かめる(Playwright の Chromium)。
// 架空の ~/.copilot と一時フォルダの git リポジトリ 2 つ(repo-a に 5 セッション、repo-b に 1 セッション)を atlas all し、atlas serve で開く。
//  a. 全体(照合できた 6 セッション)は割合と帯を出す。プロジェクトごとの表は、5 セッションの行に割合、1 セッションの行は件数だけ
//  b. 1 セッションのプロジェクトに絞ると、割合と帯を出さずに件数だけ出し、そのことを書く
//  c. 「比べる」の工程どうしで、その工程に照合できたまとまりのあるセッションの数の行が出て、足りる側だけ残存の割合が出る
// repo-b のセッションは、最初の依頼より前に編集している(工程が決まらないまとまり)。工程ごとの表に、照合できたセッションが 1 件だけの行ができる
// どの画面でもページ内の例外とコンソールのエラーが無いこと。ログ・パス・本文はすべて架空のもの
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shotOnFailure } from './failure-shot.ts';
import { ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';
import { extractEmbedded } from '../packages/report/src/lib/embed.ts';
import { emptyFilter, filterHref } from '../packages/report/src/lib/filter.ts';
import { percent } from '../packages/report/src/lib/format.ts';
import { RETENTION_MIN_SESSIONS } from '../packages/report/src/lib/retention.ts';
import type { ReportData } from '../packages/report/src/lib/types.ts';

const WORK = join(ROOT, 'out', 'ui-retention');
const HOME = join(WORK, 'copilot-home');
const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 9, m)).toISOString();

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'zz', GIT_AUTHOR_EMAIL: 'zz@example.invalid', GIT_COMMITTER_NAME: 'zz', GIT_COMMITTER_EMAIL: 'zz@example.invalid', GIT_AUTHOR_DATE: at(0), GIT_COMMITTER_DATE: at(0) },
  }).trim();
}

/** 1 セッション分のログ(依頼 → 編集 1 回 → 応答)。start は開始の分(セッションどうしの時間を重ねない)。editFirst なら、編集を最初の依頼より前に置く */
async function writeSession(id: string, repo: string, head: string, name: string, line: string, start: number, editFirst = false): Promise<void> {
  const dir = join(HOME, 'session-state', id);
  await mkdir(dir, { recursive: true });
  const file = join(repo, name);
  const p = file.replace(/\\/g, '/');
  const diff = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1,1 +1,2 @@', ' base', `+${line}`, ''].join('\n');
  const ask = { type: 'user.message', timestamp: at(start + (editFirst ? 3 : 1)), data: { content: '関数を足して' } };
  const edit = [
    { type: 'tool.execution_start', timestamp: at(start + (editFirst ? 1 : 2)), data: { toolCallId: 'c1', toolName: 'edit', arguments: { path: file, old_str: 'base', new_str: `base\n${line}` } } },
    { type: 'tool.execution_complete', timestamp: at(start + (editFirst ? 1 : 2)), data: { toolCallId: 'c1', success: true, result: { content: 'ok', detailedContent: diff } } },
  ];
  const ev = [
    { type: 'session.start', timestamp: at(start), data: { sessionId: id, context: { cwd: repo, gitRoot: repo, branch: 'main', headCommit: head } } },
    ...(editFirst ? [...edit, ask] : [ask, ...edit]),
    { type: 'assistant.message', timestamp: at(start + 4), data: { content: '足しました' } },
    { type: 'assistant.turn_end', timestamp: at(start + 5), data: {} },
  ];
  await writeFile(join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${JSON.stringify(repo)}\n`);
}

/** files の名前のファイルを base の 1 行でコミットしたリポジトリを作り、開始時のコミットを返す */
async function makeRepo(repo: string, files: string[]): Promise<string> {
  await mkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  for (const f of files) await writeFile(join(repo, f), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return git(repo, ['rev-parse', 'HEAD']);
}

describe('AI の変更の残存: 割合を出す条件', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  const repoA = join(WORK, 'repo-a');
  const repoB = join(WORK, 'repo-b');
  // repo-a は閾値ちょうどのセッション数(うち 1 つは AI の行が残っていない)、repo-b は 1 セッション
  const N = RETENTION_MIN_SESSIONS;
  let server: ServeHandle;
  let browser: Browser;
  let page: Page;
  let projectB = '';
  const problems: string[] = [];

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    const names = Array.from({ length: N }, (_, i) => `f${i + 1}.ts`);
    const headA = await makeRepo(repoA, names);
    const headB = await makeRepo(repoB, ['g.ts']);
    for (const [i, name] of names.entries()) {
      const line = `export const a${i + 1} = ${i + 1};`;
      await writeSession(`00000000-0000-4000-8000-0000001900${String(i + 1).padStart(2, '0')}`, repoA, headA, name, line, 10 + i * 10);
      // 最後の 1 つだけ、照合時のファイルに AI の行が無い
      await writeFile(join(repoA, name), i === N - 1 ? 'base\nsomething else\n' : `base\n${line}\n`);
    }
    const lineB = 'export const b1 = 1;';
    const idB = '00000000-0000-4000-8000-000000190099';
    await writeSession(idB, repoB, headB, 'g.ts', lineB, 10 + N * 10, true);
    await writeFile(join(repoB, 'g.ts'), `base\n${lineB}\n`);

    const r = spawnSync(...cliCommand(['all', '--home', HOME, '--out', out, '--notes-dir', notes]), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const data = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    projectB = data.sessions.find((s) => s.id === idB)!.project;

    server = await startServer({ outDir: out, notesDir: notes, groupsPath: join(notes, 'groups.json'), port: 0, open: false, idleMs: 600_000, firstHeartbeatMs: 600_000, configPath: join(WORK, 'atlas.config.json'), copilotHome: HOME });
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
    // 止めたサーバや git がファイルを掴んだままのことがあるので、少し待ってもう一度試す
    await rm(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  beforeEach((ctx) => shotOnFailure(ctx, () => page));
  afterEach(() => {
    expect(problems).toEqual([]);
  });

  const section = () => page.locator('#retention');
  const field = (i: number) => section().locator('.fields .field').nth(i).locator('.v');
  const cells = (table: string, row: string) => section().locator(`table[aria-labelledby="${table}"] tbody tr`).filter({ hasText: row }).locator('td');

  it('a. 照合できたセッションが足りれば割合と帯を出す。プロジェクトごとの表は、足りない行だけ件数にする', async () => {
    await page.goto(server.url);
    await expect.poll(() => field(0).textContent()).toBe(String(N + 1));
    // AI の変更があったセッションが足りるので、照合できた割合も出す
    expect(await section().locator('.fields .field').nth(0).locator('.n').textContent()).toContain(`${N + 1} セッションのうち ${percent(N + 1, N + 1)}。`);
    expect(await field(1).textContent()).toBe(percent(N, N + 1));
    expect(await field(3).textContent()).toBe(percent(1, N + 1));
    expect(await section().locator('.stack').count()).toBe(1);
    expect(await section().locator('#ret-legend li').first().textContent()).toContain(`(${percent(N, N + 1)})`);
    expect(await section().textContent()).not.toContain('件未満なので');
    // 工程ごと: 照合できたセッションの数を並べ、足りる行は割合を出す
    const phase = cells('ret-phase-h', '実装');
    expect(await phase.nth(0).textContent()).toBe(String(N));
    expect(await phase.nth(1).textContent()).toBe(`${N - 1}(${percent(N - 1, N)})`);
    expect(await phase.nth(3).textContent()).toBe(`1(${percent(1, N)})`);
    // 全体では割合を出していても、照合できたセッションが足りない工程の行(最初の依頼より前の編集。1 セッション)は件数だけ
    const early = cells('ret-phase-h', '不明');
    expect(await early.nth(0).textContent()).toBe('1');
    expect(await early.nth(1).textContent()).toBe('1');
    expect(await early.nth(3).textContent()).toBe('0');
    // プロジェクトごと: repo-a は割合つき、repo-b(1 セッション)は件数だけ
    expect(await cells('ret-proj-h', 'repo-a').nth(1).textContent()).toBe(`${N - 1}(${percent(N - 1, N)})`);
    expect(await cells('ret-proj-h', 'repo-b').nth(1).textContent()).toBe('1');
  });

  it('b. 照合できたセッションが足りなければ、割合と帯を出さずに件数だけ出す', async () => {
    await page.goto(`${server.url}${filterHref({ ...emptyFilter(), project: projectB })}`);
    await expect.poll(() => field(0).textContent()).toBe('1');
    for (const i of [1, 2, 3]) expect(await field(i).textContent()).toBe('—');
    // 照合できた割合も出さず、件数で書く
    const note = await section().locator('.fields .field').nth(0).locator('.n').textContent();
    expect(note).toContain('1 セッションのうち 1 件。');
    expect(note).not.toContain('%');
    expect(await section().locator('.fields .field').nth(1).locator('.n').textContent()).toContain('1 / 1 まとまり');
    expect(await section().locator('.stack').count()).toBe(0);
    expect(await section().locator('#ret-legend').textContent()).not.toContain('%');
    expect(await section().textContent()).toContain(`照合できたセッションが ${RETENTION_MIN_SESSIONS} 件未満なので`);
    const phase = cells('ret-phase-h', '不明');
    expect(await phase.nth(0).textContent()).toBe('1');
    expect(await phase.nth(1).textContent()).toBe('1');
    expect(await cells('ret-phase-h', '実装').count()).toBe(0);
    expect(await cells('ret-proj-h', 'repo-b').nth(1).textContent()).toBe('1');
  });

  it('c. 「比べる」の工程どうし: 照合できたセッションの数を並べ、足りる側だけ残存の割合を出す', async () => {
    await page.goto(server.url);
    const compare = page.locator('#compare');
    await compare.getByRole('button', { name: '工程', exact: true }).click();
    // 既定は A: 実装、B: 調査。repo-a の編集はどれも実装の依頼(repo-b の編集は依頼の前なので、どの工程にも入らない)。調査の側にはまとまりが無い
    const cell = (key: string, col: number) => compare.locator(`[data-testid="compare-table"] tr[data-key="${key}"] td`).nth(col);
    await expect.poll(() => cell('retention-measured', 0).textContent()).toBe(String(N));
    expect(await cell('retention-measured', 1).textContent()).toBe('0');
    // 件数の行に差は出さない
    expect(await cell('retention-measured', 2).textContent()).toBe('');
    expect(await cell('retention-hunks', 0).textContent()).toBe(String(N));
    expect(await cell('retention-kept', 0).textContent()).toBe(percent(N - 1, N));
    expect(await cell('retention-kept', 1).textContent()).toBe('—');
    expect(await cell('retention-missing', 0).textContent()).toBe(percent(1, N));
  });
});
