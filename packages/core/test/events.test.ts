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
