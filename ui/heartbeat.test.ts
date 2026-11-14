// サーバの止まり方(画面の heartbeat と bye)を実際のブラウザで確かめる(serve.ts の先頭の説明)。
//  - 一覧 → 詳細ページ → ブラウザの「戻る」→「進む」と移っても止まらない(移る間に bye が来ても、次のページの heartbeat が猶予の間に届く)
//  - 画面がすべて閉じられたら、猶予(byeGraceMs)の後に止まる
// 以前は heartbeat が 8 秒途切れると止まり、隠れたタブ(ブラウザがタイマーを間引く)や、1 回の送信の失敗で止まっていた。
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureHome, ROOT, cliCommand, startServer, type ServeHandle } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-heartbeat');

describe('サーバの止まり方', () => {
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let close: () => Promise<void>;
  let browser: Browser;

  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const r = spawnSync(...cliCommand(['all', '--home', home, '--out', out, '--notes-dir', notes]), { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    browser = await chromium.launch();
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await close?.();
  });

  it('一覧 → 詳細 → 戻る → 進むと移っても止まらず、すべて閉じたら猶予の後に止まる', async () => {
    const logs: string[] = [];
    const server: ServeHandle = await startServer({
      outDir: out,
      notesDir: notes,
      groupsPath: join(notes, 'groups.json'),
      port: 0,
      open: false,
      idleMs: 600_000,
      byeGraceMs: 1500,
      firstHeartbeatMs: 600_000,
      log: (m) => logs.push(m),
    });
    let reason: string | null = null;
    void server.done.then((r) => (reason = r));
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    const beats: string[] = [];
    page.on('request', (q) => {
      if (/\/api\/(heartbeat|bye)$/.test(q.url())) beats.push(`${q.url().split('/api/')[1]} ${q.headers()['x-atlas-client'] ?? '(なし)'}`);
    });
    try {
      await page.goto(server.url);
      await expect.poll(() => beats.some((b) => b.startsWith('heartbeat '))).toBe(true);
      // 画面ごとに id を付けて送る
      expect(beats.every((b) => !b.endsWith('(なし)'))).toBe(true);
      const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
      const id = s.sessions[0].id;
      // 詳細ページへ移る(一覧は閉じるので bye を送る)。猶予(1.5 秒)より長く居ても止まらない
      await page.goto(new URL(`sessions/${id}.html`, server.url).href);
      await page.waitForTimeout(2500);
      expect(reason).toBeNull();
      await page.goBack();
      await page.waitForTimeout(2500);
      expect(reason).toBeNull();
      await page.goForward();
      await page.waitForTimeout(2500);
      expect(reason).toBeNull();
      // 移るたびに前のページは bye を送るが(戻る / 進むのために残されるページは送らない)、次のページの heartbeat で止まらない
      // (閉じかけのページが送る要求は Playwright の request に出ないので、サーバの記録で見る)
      expect(logs.filter((l) => /開いている画面がすべて閉じられました/.test(l)).length).toBeGreaterThanOrEqual(1);
      // 止まっていないので「サーバが止まっています」の帯は出ない
      expect(await page.locator('.down-band').count()).toBe(0);
      expect(problems).toEqual([]);
      // atlas の外へ移ると(タブを閉じたときと同じ pagehide で bye を送る)、猶予の後に止まる。
      // Playwright の page.close() では閉じかけのページの要求が送られないので、外へ移って確かめる
      await page.goto('about:blank');
      await expect.poll(() => reason, { timeout: 10_000 }).toBe('画面がすべて閉じられた');
      await page.close();
    } finally {
      await server.close();
    }
  }, 60_000);

  it('版のずれ: サーバが画面と違う版なら(目印を返さない古いサーバも)、一覧と詳細ページに「画面とサーバの版が違います」を出す。同じ版なら出さない', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as { sessions: { id: string }[] };
    const detail = `sessions/${s.sessions[0].id}.html`;
    // undefined: 同じコードで起動した(既定) / 'old-version': 違う版 / null: 目印を返さない古いサーバ
    for (const [stamp, stale] of [
      [undefined, false],
      ['old-version', true],
      [null, true],
    ] as const) {
      const server = await startServer({
        outDir: out,
        notesDir: notes,
        groupsPath: join(notes, 'groups.json'),
        port: 0,
        open: false,
        idleMs: 600_000,
        firstHeartbeatMs: 600_000,
        ...(stamp === undefined ? {} : { codeStamp: stamp }),
      });
      const page = await browser.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      try {
        for (const path of ['atlas.html', detail]) {
          const label = `${String(stamp)} ${path}`;
          const answered = page.waitForResponse((r) => /\/api\/heartbeat$/.test(r.url()));
          await page.goto(new URL(path, server.url).href);
          await answered;
          const band = page.locator('.stale-band');
          if (stale) {
            await expect.poll(() => band.count(), { message: label }).toBe(1);
            expect(await band.textContent(), label).toContain('画面とサーバの版が違います');
            expect(await band.getAttribute('role'), label).toBe('alert');
            // 止まった帯とは別(サーバは動いている)
            expect(await page.locator('.down-band:not(.stale-band)').count(), label).toBe(0);
          } else {
            await page.waitForTimeout(500);
            expect(await band.count(), label).toBe(0);
          }
        }
        expect(problems).toEqual([]);
      } finally {
        await page.close();
        await server.close();
      }
    }
  }, 60_000);
});
