// テストの結果の取り込み: テストの実行ファイルが標準出力に書いた印つきの 1 行 JSON(ATLAS_TEST_RESULT {...})を、
// ツールの結果(events.jsonl)から拾ってセッションの記録(sessions.json の tests)に持つことを、架空の ~/.copilot で通しで確かめる。
//  a. 依頼の番号・ツール・呼び出しの ID つきで、呼び出しごとに持つ。印の行が無いセッションにはキーを置かない
//  b. タスクタグのセッションを送り(group upload)、送り先から集計し直しても同じ結果になる(生ログから読むので、別のファイルを添えない)
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
    ...shell('c1', 2, ['build ok', mark({ name: '描画', passed: false, counts: { assertFailures: 2, shaderErrors: 1, diffRate: 0.25 }, at: at(2) }), mark({ name: '入力', passed: true, counts: { assertFailures: 0 } })].join('\n'), false),
    { type: 'assistant.message', timestamp: at(3), data: { content: '1 件落ちました' } },
    { type: 'user.message', timestamp: at(4), data: { content: '直して' } },
    ...shell('c2', 5, [mark({ name: '描画', passed: true, counts: { assertFailures: 0, shaderErrors: 0, diffRate: 0 }, at: at(5) }), mark({ name: '入力', passed: true, counts: { assertFailures: 0 } })].join('\r\n')),
    { type: 'assistant.message', timestamp: at(6), data: { content: '通りました' } },
    { type: 'assistant.turn_end', timestamp: at(7), data: {} },
  ]);
  await writeSession(S_PLAIN, [
    { type: 'session.start', timestamp: at(10), data: { sessionId: S_PLAIN, context: { cwd: CWD } } },
    { type: 'user.message', timestamp: at(11), data: { content: '説明して' } },
    ...shell('c1', 12, 'no markers here'),
    { type: 'assistant.message', timestamp: at(13), data: { content: 'はい' } },
  ]);
});

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

const testsOf = (f: SessionsFile, id: string) => f.sessions.find((s) => s.id === id)?.tests;

describe('Phase 18: テストの結果の取り込み', () => {
  let original: SessionsFile;

  it('a. ツールの結果の印つきの行を、呼び出しごと・依頼の番号つきで sessions.json に持つ', async () => {
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', HOME, '--out', OUT]);
      expect(r.status, r.out).toBe(0);
    }
    original = JSON.parse(await readFile(join(OUT, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(original.schemaVersion).toBe(18);
    expect(testsOf(original, S_TESTS)).toEqual({
      runs: [
        {
          at: at(2),
          turn: 1,
          tool: 'powershell',
          toolCallId: 'c1',
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
          results: [
            { name: '描画', passed: true, counts: { assertFailures: 0, shaderErrors: 0, diffRate: 0 }, at: at(5) },
            { name: '入力', passed: true, counts: { assertFailures: 0 } },
          ],
        },
      ],
      invalid: 0,
      duplicates: 0,
      dropped: 0,
    });
    const plain = original.sessions.find((s) => s.id === S_PLAIN)!;
    expect(plain).toBeDefined();
    expect('tests' in plain).toBe(false);
  });

  it('b. 送り先から集計し直しても、同じテストの結果になる', async () => {
    await mkdir(NOTES, { recursive: true });
    // 送り先の基底のフォルダは、思わぬ場所に作らないよう atlas は作らない(先に作っておく)
    await mkdir(UPLOAD, { recursive: true });
    await writeFile(join(NOTES, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: TAG, note: '', ids: [S_TESTS, S_PLAIN] }] }));
    const up = atlas(['group', 'upload', TAG, '--to', UPLOAD, '--out', OUT, '--notes-dir', NOTES]);
    expect(up.status, up.out).toBe(0);
    for (const cmd of ['snapshot', 'extract']) {
      const r = atlas([cmd, '--home', join(UPLOAD, TAG), '--out', OUT2]);
      expect(r.status, r.out).toBe(0);
    }
    const again = JSON.parse(await readFile(join(OUT2, 'sessions.json'), 'utf8')) as SessionsFile;
    expect(testsOf(again, S_TESTS)).toEqual(testsOf(original, S_TESTS));
    expect(testsOf(again, S_PLAIN)).toBeUndefined();
  });
});
