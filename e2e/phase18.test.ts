// テストの結果の取り込み: テストの実行ファイルが標準出力に書いた印つきの 1 行 JSON(ATLAS_TEST_RESULT {...})を、
// ツールの結果(events.jsonl)から拾ってセッションの記録(sessions.json の tests)に持つことを、架空の ~/.copilot で通しで確かめる。
//  a. 依頼の番号・ツール・呼び出しの ID つきで、呼び出しごとに持つ。印の行が無いセッションにはキーを置かない。
//     実行ごとに、そこまでの実働と AI 使用量の累計・まだ通っていないテストの数を持ち、最初に全部通った実行の番号を残す
//  b. タスクタグのセッションを送り(group upload)、送り先から集計し直しても同じ結果になる(生ログから読むので、別のファイルを添えない)
//  c. 詳細ページに「テストの推移」の節が出る(印の行が無いセッションには出ない)。最後まで通らなかったセッションは「未達」
// ログ・パス・本文はすべて架空のもの
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionsFile } from '../packages/report/src/shared/types.ts';
import { ROOT, cliCommand } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase18');
const HOME = join(WORK, 'copilot-home');
const OUT = join(WORK, 'out');
const OUT2 = join(WORK, 'out-uploaded');
const NOTES = join(WORK, 'notes');
const UPLOAD = join(WORK, 'atlas-logs');
const TAG = 'cond-a';
const S_TESTS = '00000000-0000-4000-8000-000000180001';
const S_PLAIN = '00000000-0000-4000-8000-000000180002';
const S_UNREACHED = '00000000-0000-4000-8000-000000180003';
const CWD = 'X:\\synthetic-phase18';
const at = (m: number) => new Date(Date.UTC(2026, 10, 3, 9, m)).toISOString();

function atlas(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

const mark = (o: Record<string, unknown>) => `ATLAS_TEST_RESULT ${JSON.stringify(o)}`;

async function writeSession(id: string, ev: Record<string, unknown>[]): Promise<void> {
  const dir = join(HOME, 'session-state', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${JSON.stringify(CWD)}\n`);
}

/** リクエスト 1 回の使用量の記録(AIU は aiu) */
const usage = (m: number, aiu: number) => ({ type: 'session.usage_record', timestamp: at(m), data: { usage: { model: 'm1', inputTokens: 100, outputTokens: 10, initiator: 'user', copilotUsage: { totalNanoAiu: aiu * 1e9 } } } });

const shell = (id: string, m: number, output: string, success = true) => [
  { type: 'tool.execution_start', timestamp: at(m), data: { toolCallId: id, toolName: 'powershell', arguments: { command: '.\\run-tests.exe' } } },
  { type: 'tool.execution_complete', timestamp: at(m), data: { toolCallId: id, success, ...(success ? { result: { content: output } } : { error: { code: 'failure', message: output } }) } },
];

beforeAll(async () => {
  await rm(WORK, { recursive: true, force: true });
  // 実装 → テスト(1 件落ちる)→ 直して → テスト(通る)
  await writeSession(S_TESTS, [
    { type: 'session.start', timestamp: at(0), data: { sessionId: S_TESTS, context: { cwd: CWD } } },
    { type: 'user.message', timestamp: at(1), data: { content: '描画を実装して' } },
    usage(2, 2),
    ...shell('c1', 2, ['build ok', mark({ name: '描画', passed: false, counts: { assertFailures: 2, shaderErrors: 1, diffRate: 0.25 }, at: at(2) }), mark({ name: '入力', passed: true, counts: { assertFailures: 0 } })].join('\n'), false),
    { type: 'assistant.message', timestamp: at(3), data: { content: '1 件落ちました' } },
    { type: 'user.message', timestamp: at(4), data: { content: '直して' } },
    usage(5, 3),
    ...shell('c2', 5, [mark({ name: '描画', passed: true, counts: { assertFailures: 0, shaderErrors: 0, diffRate: 0 }, at: at(5) }), mark({ name: '入力', passed: true, counts: { assertFailures: 0 } })].join('\r\n')),
    // 通った後のリクエストは、通るまでの累計に入らない
    usage(6, 7),
    { type: 'assistant.message', timestamp: at(6), data: { content: '通りました' } },
    { type: 'assistant.turn_end', timestamp: at(7), data: {} },
  ]);
  await writeSession(S_PLAIN, [
    { type: 'session.start', timestamp: at(10), data: { sessionId: S_PLAIN, context: { cwd: CWD } } },
    { type: 'user.message', timestamp: at(11), data: { content: '説明して' } },
    ...shell('c1', 12, 'no markers here'),
    { type: 'assistant.message', timestamp: at(13), data: { content: 'はい' } },
  ]);
  // 2 回走らせて、最後まで 1 件が落ちたまま(リクエストごとの使用量の記録は無い)
  await writeSession(S_UNREACHED, [
    { type: 'session.start', timestamp: at(20), data: { sessionId: S_UNREACHED, context: { cwd: CWD } } },
    { type: 'user.message', timestamp: at(21), data: { content: '入力を実装して' } },
    ...shell('c1', 22, [mark({ name: '描画', passed: true }), mark({ name: '入力', passed: false, counts: { assertFailures: 3 } })].join('\n'), false),
    ...shell('c2', 23, mark({ name: '入力', passed: false, counts: { assertFailures: 1 } }), false),
    { type: 'assistant.message', timestamp: at(24), data: { content: 'まだ 1 件落ちます' } },
  ]);
});

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

const testsOf = (f: SessionsFile, id: string) => f.sessions.find((s) => s.id === id)?.tests;

describe('Phase 18: テストの結果の取り込み', () => {
  let original: SessionsFile;

  it('a. ツールの結果の印つきの行を、呼び出しごと・依頼の番号つきで sessions.json に持つ', async () => {
    const r = atlas(['all', '--home', HOME, '--out', OUT, '--notes-dir', NOTES]);
    expect(r.status, r.out).toBe(0);
    original = JSON.parse(await readFile(join(OUT, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(original.schemaVersion).toBe(18);
    expect(testsOf(original, S_TESTS)).toEqual({
      runs: [
        {
          at: at(2),
          turn: 1,
          tool: 'powershell',
          toolCallId: 'c1',
          // 開始から 2 分。そこまでのリクエストは 2 AIU。描画が落ちている
          activeMs: 120_000,
          nanoAiu: 2e9,
          failing: 1,
          results: [
            { name: '描画', passed: false, counts: { assertFailures: 2, shaderErrors: 1, diffRate: 0.25 }, at: at(2) },
            { name: '入力', passed: true, counts: { assertFailures: 0 } },
          ],
        },
        {
          at: at(5),
          turn: 2,
          tool: 'powershell',
          toolCallId: 'c2',
          activeMs: 300_000,
          nanoAiu: 5e9,
          failing: 0,
          results: [
            { name: '描画', passed: true, counts: { assertFailures: 0, shaderErrors: 0, diffRate: 0 }, at: at(5) },
            { name: '入力', passed: true, counts: { assertFailures: 0 } },
          ],
        },
      ],
      invalid: 0,
      duplicates: 0,
      dropped: 0,
      firstPass: 2,
    });
    // 最後まで通らなかったセッション: firstPass が null。2 回目は入力だけを走らせ直したので、通っていないのは入力の 1 件。
    // リクエストごとの使用量の記録が無いので、AIU の累計は null(0 にしない)
    const un = testsOf(original, S_UNREACHED)!;
    expect(un.firstPass).toBeNull();
    expect(un.runs.map((x) => [x.failing, x.nanoAiu, x.activeMs])).toEqual([
      [1, null, 120_000],
      [1, null, 180_000],
    ]);
    const plain = original.sessions.find((s) => s.id === S_PLAIN)!;
    expect(plain).toBeDefined();
    expect('tests' in plain).toBe(false);
  });

  it('b. 送り先から集計し直しても、同じテストの結果になる', async () => {
    await mkdir(NOTES, { recursive: true });
    // 送り先の基底のフォルダは、思わぬ場所に作らないよう atlas は作らない(先に作っておく)
    await mkdir(UPLOAD, { recursive: true });
    await writeFile(join(NOTES, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: TAG, note: '', ids: [S_TESTS, S_PLAIN, S_UNREACHED] }] }));
    const up = atlas(['group', 'upload', TAG, '--to', UPLOAD, '--out', OUT, '--notes-dir', NOTES]);
    expect(up.status, up.out).toBe(0);
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', join(UPLOAD, TAG), '--out', OUT2]);
      expect(r.status, r.out).toBe(0);
    }
    const again = JSON.parse(await readFile(join(OUT2, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(testsOf(again, S_TESTS)).toEqual(testsOf(original, S_TESTS));
    expect(testsOf(again, S_UNREACHED)).toEqual(testsOf(original, S_UNREACHED));
    expect(testsOf(again, S_PLAIN)).toBeUndefined();
  });

  it('c. 詳細ページに「テストの推移」の節が出る', async () => {
    /** 詳細ページの「テストの推移」の節の文字(節が無ければ空) */
    const page = async (id: string) => {
      const html = await readFile(join(OUT, 'sessions', `${id}.html`), 'utf8');
      const sec = /<section[^>]*>(?:(?!<section)[\s\S])*?<h2[^>]*>テストの推移<\/h2>[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      return sec.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    };
    const done = await page(S_TESTS);
    expect(done).toContain('テストの推移');
    // 2 回目で全部通った。そこまでの実働は 5 分、AIU は 5(通った後の 7 は入らない)
    expect(done).toMatch(/結果 全部通った/);
    expect(done).toMatch(/最初に全部通るまで 2 回目 依頼 2 件目/);
    expect(done).toMatch(/通るまでの実働 5分/);
    expect(done).toMatch(/通るまでの AIU 5 /);
    // 1 回目の行: 合格 1 / 2、落ちたテストは描画、件数の合計
    expect(done).toMatch(/1 \/ 2 描画 1 2 1 0\.25 2分 2 /);
    expect(done).toMatch(/2 \/ 2 — 全部通った 0 0 0 5分 5 /);
    const un = await page(S_UNREACHED);
    expect(un).toMatch(/結果 未達/);
    expect(un).toMatch(/最初に全部通るまで — 通るまでの実働 — 通るまでの AIU —/);
    // 2 回目は入力だけを走らせ直した。通っていないテストは 1 件のまま、AIU は記録なし
    expect(un).toMatch(/0 \/ 1 入力 1 1 3分 記録なし/);
    expect(await page(S_PLAIN)).toBe('');
  });
});
