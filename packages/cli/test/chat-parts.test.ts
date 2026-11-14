// チャットで判定する添付ファイルの一覧(依頼ごとの判定): 採用を判定できる依頼が先頭の何ファイルまでかを返す。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listChatParts } from '../src/chat-parts.ts';

describe('添付ファイルの一覧(依頼ごとの判定)', () => {
  let out: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'atlas-chatparts-'));
    await mkdir(join(out, 'turn-bundle', 'parts'), { recursive: true });
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const part = (n: number, sessionId: string, turns: number[]) => ({ path: `parts/part-0${n}.md`, chunks: [{ sessionId, turns }], turns: turns.length, bytes: 10 * n });
  const manifest = (extra: Record<string, unknown>) => ({
    version: 1,
    generatedAt: '2026-11-14T00:00:00.000Z',
    phases: ['実装'],
    count: 5,
    unjudgedOnly: true,
    chunks: [],
    parts: [part(1, 's1', [1, 2]), part(2, 's2', [1]), part(3, 's1', [3]), part(4, 's2', [2])],
    skipped: [],
    ...extra,
  });
  const write = async (m: unknown, files: number[]): Promise<void> => {
    await writeFile(join(out, 'turn-bundle', 'manifest.json'), JSON.stringify(m));
    for (const n of files) await writeFile(join(out, 'turn-bundle', 'parts', `part-0${n}.md`), '# 指示');
  };

  it('採用を判定できる依頼の数と先頭のファイル数を返し、その後ろのファイルに「最後の依頼だけ」の印を付ける(消えたファイルがあっても番号はずれない)', async () => {
    // 先頭の 2 ファイルが判定できる依頼。part-02 は消えている
    await write(manifest({ decidable: { turns: 3, chunks: 2, parts: 2 } }), [1, 3, 4]);
    const r = await listChatParts(out, 'turns');
    expect(r).toMatchObject({ exists: true, unjudgedOnly: true, count: 5, decidable: { turns: 3, parts: 2 } });
    expect(r.parts!.map((p) => [p.name, p.lastOnly])).toEqual([
      ['part-01.md', false],
      ['part-03.md', true],
      ['part-04.md', true],
    ]);
  });

  it('古い添付(decidable が無い)では、数も印も返さない', async () => {
    await write(manifest({}), [1, 2, 3, 4]);
    const r = await listChatParts(out, 'turns');
    expect(r.decidable).toBeUndefined();
    expect(r.parts!.every((p) => !('lastOnly' in p))).toBe(true);
    expect(r.parts).toHaveLength(4);
  });
});
