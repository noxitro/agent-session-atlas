// チャットで判定する添付ファイルの一覧(serve の /api/judge/parts と M365 Copilot の自動操作が使う)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listChatParts } from '../src/chat-parts.ts';

/** 依頼ごとの判定の添付ファイルの一覧(manifest と、残すファイルの番号)を書く */
async function writeTurnParts(out: string, extra: Record<string, unknown>, files: number[]): Promise<void> {
  const dir = join(out, 'turn-bundle');
  await mkdir(join(dir, 'parts'), { recursive: true });
  const part = (n: number, sid: string, turns: number[]) => ({ path: `parts/part-0${n}.md`, chunks: [{ sessionId: sid, turns }], turns: turns.length, bytes: 10 * n });
  const m = {
    version: 1,
    generatedAt: '2026-11-14T00:00:00.000Z',
    phases: ['実装'],
    count: 5,
    unjudgedOnly: true,
    chunks: [],
    parts: [part(1, 's1', [1, 2]), part(2, 's2', [1]), part(3, 's1', [3]), part(4, 's2', [2])],
    skipped: [],
    ...extra,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
  for (const n of files) await writeFile(join(dir, 'parts', `part-0${n}.md`), '# 指示');
}

describe('依頼ごとの判定の添付ファイルの一覧', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'atlas-chatparts-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('採用を判定できる依頼の数と先頭のファイル数を返し、その後ろのファイルに「最後の依頼だけ」の印を付ける(消えたファイルがあっても番号はずれない)', async () => {
    // 先頭の 2 ファイルが判定できる依頼。part-02 は消えている
    await writeTurnParts(d, { decidable: { turns: 3, chunks: 2, parts: 2 } }, [1, 3, 4]);
    const r = await listChatParts(d, 'turns');
    expect([r.exists, r.unjudgedOnly, r.count, r.decidable]).toEqual([true, true, 5, { turns: 3, parts: 2 }]);
    expect(r.parts!.map((p) => [p.name, p.lastOnly])).toEqual([
      ['part-01.md', false],
      ['part-03.md', true],
      ['part-04.md', true],
    ]);
    // 画面に渡す形(lastOnly と decidable)
    const v = JSON.parse(JSON.stringify(r));
    expect(v.decidable).toEqual({ turns: 3, parts: 2 });
    expect(v.parts[1].lastOnly).toBe(true);
  });

  it('古い添付(decidable が無い)では、数も印も返さない', async () => {
    await writeTurnParts(d, {}, [1, 2, 3, 4]);
    const r = await listChatParts(d, 'turns');
    expect(r.decidable).toBeUndefined();
    expect(r.parts).toHaveLength(4);
    const v = JSON.parse(JSON.stringify(r));
    expect('decidable' in v).toBe(false);
    expect(v.parts.every((p: object) => !('lastOnly' in p))).toBe(true);
  });
});
