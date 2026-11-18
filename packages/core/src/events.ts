import { createReadStream } from 'node:fs';
import type { CopilotEvent, ParseStats } from './types.ts';

export function newParseStats(): ParseStats {
  return { lines: 0, parsed: 0, badLines: 0, blankLines: 0 };
}

/**
 * events.jsonl を 1 行ずつ読む(72MB 級のファイルを一括 parse しない)。
 * 壊れた行・type の無い行は stats.badLines に数えて飛ばす。
 * 行は \n(と \r\n)だけで区切る。readline は U+2028 / U+2029 と単独の \r でも区切るため、それを生のまま含む JSON の行
 * (JSON の文字列には書ける)を壊れた行にしてしまううえ、区切りの正規表現の分だけ遅い
 */
export async function* parseEvents(path: string, stats: ParseStats = newParseStats()): AsyncGenerator<CopilotEvent> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  /** 前の塊の、まだ改行の来ていない残り(長い行が塊をまたぐときは、つなぐのを改行が来るまで待つ) */
  let pending: string[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let start = 0;
      let nl = chunk.indexOf('\n');
      while (nl !== -1) {
        let raw = chunk.slice(start, nl);
        if (pending.length) {
          pending.push(raw);
          raw = pending.join('');
          pending = [];
        }
        const ev = parseLine(raw, stats);
        if (ev) yield ev;
        start = nl + 1;
        nl = chunk.indexOf('\n', start);
      }
      if (start < chunk.length) pending.push(chunk.slice(start));
    }
    // 最後の行に改行が無いとき
    if (pending.length) {
      const ev = parseLine(pending.join(''), stats);
      if (ev) yield ev;
    }
  } finally {
    stream.destroy();
  }
}

function parseLine(text: string, stats: ParseStats): CopilotEvent | null {
  stats.lines++;
  let line = text.charCodeAt(text.length - 1) === 0x0d ? text.slice(0, -1) : text;
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  if (line.trim() === '') {
    stats.blankLines++;
    return null;
  }
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    stats.badLines++;
    return null;
  }
  if (!ev || typeof ev !== 'object' || typeof (ev as CopilotEvent).type !== 'string') {
    stats.badLines++;
    return null;
  }
  stats.parsed++;
  return ev as CopilotEvent;
}

/** テスト・小さいファイル用: 全件を配列で返す */
export async function readEvents(path: string): Promise<{ events: CopilotEvent[]; stats: ParseStats }> {
  const stats = newParseStats();
  const events: CopilotEvent[] = [];
  for await (const e of parseEvents(path, stats)) events.push(e);
  return { events, stats };
}
