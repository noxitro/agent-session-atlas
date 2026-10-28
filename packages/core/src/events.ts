import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CopilotEvent, ParseStats } from './types.ts';

export function newParseStats(): ParseStats {
  return { lines: 0, parsed: 0, badLines: 0, blankLines: 0 };
}

/**
 * events.jsonl を 1 行ずつ読む(72MB 級のファイルを一括 parse しない)。
 * 壊れた行・type の無い行は stats.badLines に数えて飛ばす。
 */
export async function* parseEvents(path: string, stats: ParseStats = newParseStats()): AsyncGenerator<CopilotEvent> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      stats.lines++;
      const line = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      if (line.trim() === '') {
        stats.blankLines++;
        continue;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        stats.badLines++;
        continue;
      }
      if (!ev || typeof ev !== 'object' || typeof (ev as CopilotEvent).type !== 'string') {
        stats.badLines++;
        continue;
      }
      stats.parsed++;
      yield ev as CopilotEvent;
    }
  } finally {
    rl.close();
  }
}

/** テスト・小さいファイル用: 全件を配列で返す */
export async function readEvents(path: string): Promise<{ events: CopilotEvent[]; stats: ParseStats }> {
  const stats = newParseStats();
  const events: CopilotEvent[] = [];
  for await (const e of parseEvents(path, stats)) events.push(e);
  return { events, stats };
}
