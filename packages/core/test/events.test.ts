import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.ts';

describe('parseEvents', () => {
  it('壊れた行・type の無い行を数えて飛ばし、空行は別に数える', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-ev-'));
    const p = join(dir, 'events.jsonl');
    await writeFile(
      p,
      ['\ufeff{"type":"a","data":{}}', '', '{"type":"b"', '{"data":1}', '[1,2]', '{"type":"c","data":{"x":"日本語"}}', ''].join('\r\n'),
    );
    const { events, stats } = await readEvents(p);
    expect(events.map((e) => e.type)).toEqual(['a', 'c']);
    expect(stats).toEqual({ lines: 6, parsed: 2, badLines: 3, blankLines: 1 });
  });
});

describe('parseEvents の行の区切り', () => {
  it('U+2028 / U+2029 を生のまま含む行を区切らない(JSON の文字列には書ける)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-ev-'));
    const p = join(dir, 'events.jsonl');
    await writeFile(p, `{"type":"a","data":{"t":"x y z"}}\n{"type":"b"}\n`);
    const { events, stats } = await readEvents(p);
    expect(events.map((e) => e.type)).toEqual(['a', 'b']);
    expect((events[0].data as { t: string }).t).toBe('x y z');
    expect(stats).toEqual({ lines: 2, parsed: 2, badLines: 0, blankLines: 0 });
  });

  it('読む塊(1 MB)をまたぐ長い行・塊の境目で分かれた \r\n・最後の改行の無い行も 1 行として読む', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-ev-'));
    const p = join(dir, 'events.jsonl');
    const long = '日本語'.repeat(800_000); // 1 文字 3 バイト。塊をいくつもまたぐ
    const first = `{"type":"a","data":{"t":"${long}"}}`;
    // 1 行目の \r\n の \r が塊の最後のバイトになる長さの行を 2 行目に置く
    const pad = 1024 * 1024 - (Buffer.byteLength(first) + 2) % (1024 * 1024) - '{"type":"b","data":{"t":""}}'.length - 1;
    const second = `{"type":"b","data":{"t":"${'x'.repeat(Math.max(0, pad))}"}}`;
    await writeFile(p, `${first}\r\n${second}\r\n{"type":"c"}`);
    const { events, stats } = await readEvents(p);
    expect(events.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    expect((events[0].data as { t: string }).t).toBe(long);
    expect(stats).toEqual({ lines: 3, parsed: 3, badLines: 0, blankLines: 0 });
  });
});
