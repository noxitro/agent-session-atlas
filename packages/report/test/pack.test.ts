// 埋め込むセッションの要約の圧縮(lib/pack.ts): 既定値と同じ項目を落とし、読むときに埋め戻すと元と同じになる
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent } from '../../core/src/types.ts';
import { identityAnonymizer } from '../src/lib/anonymize.ts';
import { embedData, extractEmbedded } from '../src/lib/embed.ts';
import { packSummary, unpackData, unpackSummary } from '../src/lib/pack.ts';
import { summarize } from '../src/lib/summarize.ts';
import type { SessionSummary } from '../src/lib/types.ts';

const T0 = Date.parse('2026-11-08T00:00:00.000Z');
const ev = (dt: number, type: string, data: Record<string, unknown>): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString() });

async function summaries(): Promise<SessionSummary[]> {
  const empty = await normalizeSession({ id: 'empty-1', events: [ev(0, 'session.start', { context: { cwd: 'X:\\p' } })] });
  const busy = await normalizeSession({
    id: 'busy-1',
    events: [
      ev(0, 'session.start', { context: { cwd: 'X:\\p' }, selectedModel: 'gpt-5.5' }),
      ev(1000, 'user.message', { content: 'ボタンを足して' }),
      ev(1100, 'tool.execution_start', { toolCallId: 'c1', toolName: 'view', arguments: { path: 'a' } }),
      ev(1200, 'tool.execution_complete', { toolCallId: 'c1', success: false }),
      ev(1300, 'abort', { reason: 'user' }),
      ev(2000, 'user.message', { content: '違う、右に' }),
      ev(2100, 'assistant.message', { content: '直しました', outputTokens: 0 }),
    ],
  });
  return [empty, busy].map((r) => summarize(r, identityAnonymizer(), null));
}

/** JSON を通した往復(埋め込みと同じ) */
const roundTrip = (s: SessionSummary): SessionSummary => unpackSummary(JSON.parse(JSON.stringify(packSummary(s))));

describe('埋め込む要約の圧縮', () => {
  it('落として埋め戻すと元と同じ。空のセッションは id と時刻などだけになり、href も id から作り直す', async () => {
    for (const s of await summaries()) expect(roundTrip(s)).toEqual(s);
    const [empty] = await summaries();
    const packed = packSummary(empty);
    expect(packed).not.toHaveProperty('href');
    expect(packed).not.toHaveProperty('tools');
    expect(packed).not.toHaveProperty('friction');
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(empty).length / 3);
  });

  it('既定値と違う値は 0 も null も残す(欠測の null と記録された 0 を区別したまま)', async () => {
    const [, busy] = await summaries();
    const s: SessionSummary = { ...busy, tokens: { ...busy.tokens, output: 0, input: 5 }, activeMs: 0, judgment: null };
    const packed = packSummary(s) as { tokens: Record<string, unknown>; activeMs?: number };
    // tokens.output の既定値は null(欠測)なので、記録された 0 は残る
    expect(packed.tokens.output).toBe(0);
    expect(packed.tokens.input).toBe(5);
    expect(packed.activeMs).toBe(0);
    expect(roundTrip(s)).toEqual(s);
  });

  it('人のフォルダの名前は、付いているときだけ残す(無いレポートでは 1 件ぶんも増えない)', async () => {
    const [, busy] = await summaries();
    expect(packSummary(busy)).not.toHaveProperty('person');
    const s: SessionSummary = { ...busy, person: 'person-a' };
    expect(packSummary(s)).toHaveProperty('person', 'person-a');
    expect(roundTrip(s)).toEqual(s);
    // 古い埋め込み(person が無い)を読んでも、人なしになる
    expect(roundTrip(busy).person).toBeNull();
  });

  it('入れ子の一部だけ既定値と違えば、その項目だけ残す', async () => {
    const [, busy] = await summaries();
    const packed = packSummary(busy) as { friction?: Record<string, number> };
    expect(packed.friction).toBeDefined();
    expect(Object.values(packed.friction!).every((n) => n !== 0)).toBe(true);
  });

  it('embedData と extractEmbedded の往復でも元に戻る。sessions の無いデータはそのまま', async () => {
    const data = { version: 9, sessions: await summaries() };
    const tpl = '<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>';
    const html = embedData(tpl, { ...data, sessions: data.sessions.map(packSummary) });
    expect(extractEmbedded(html)).toEqual(data);
    expect(unpackData({ version: 9, groups: [] })).toEqual({ version: 9, groups: [] });
  });
});
