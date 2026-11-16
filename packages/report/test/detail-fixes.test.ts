// 詳細ページの表示: 実データとの突き合わせで見つかった「0 と記録なしの取り違え」「同じ行の重複」を、合成したイベントで確かめる
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { WikiClassifier } from '../../core/src/wiki.ts';
import { mergeInstructionRows, renderDetailHtml } from '../src/detail.ts';
import { identityAnonymizer } from '../src/lib/anonymize.ts';

let n = 0;
const ev = (type: string, data: unknown, timestamp: string, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({ type, data, timestamp, id: `d${n++}`, ...extra });
const T = (s: number): string => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
const html = (r: SessionRecord): string => renderDetailHtml(r, { anon: identityAnonymizer(), css: '', judgment: null, generatedAt: T(0) });
/** 概要などの 1 項目(見出し・値・注記)をタグを外した文字列で取り出す */
function fieldOf(page: string, key: string): { v: string; n: string } | null {
  const re = new RegExp(`<div class="field"><span class="k">${key.replace(/[()]/g, '\\$&')}</span><span class="v">([\\s\\S]*?)</span>(?:<span class="n">([\\s\\S]*?)</span>)?</div>`);
  const m = re.exec(page);
  const strip = (s: string | undefined): string => (s ?? '').replace(/<[^>]+>/g, '');
  return m ? { v: strip(m[1]), n: strip(m[2]) } : null;
}

describe('詳細ページ: 記録なしと 0 の区別', () => {
  it('(1) compaction のトークンは古い形も出し、減ったトークンが無ければ記録なし', async () => {
    const r = await normalizeSession({ id: 'c', events: [ev('session.compaction_complete', { compactionTokensUsed: { input: 2000, output: 300, cachedInput: 1500 } }, T(1))] });
    const f = fieldOf(html(r), 'compaction 自体のトークン');
    expect(f?.v).toBe('入力 2,000・出力 300');
    expect(f?.n).toBe('減ったトークン 記録なし');
  });

  it('(2) サブエージェントだけが編集した変更行数は「+0 / −0」ではなく記録なしと理由', async () => {
    const r = await normalizeSession({
      id: 'l',
      events: [
        ev('session.start', { context: { cwd: 'C:\\w' } }, T(0)),
        ev('tool.execution_start', { toolName: 'create', toolCallId: 'c1', arguments: { path: 'C:\\w\\a.ts' } }, T(1), { agentId: 'sub' }),
        ev('tool.execution_complete', { toolCallId: 'c1', success: true }, T(2), { agentId: 'sub' }),
        ev('session.shutdown', { codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } }, T(3)),
      ],
    });
    expect(fieldOf(html(r), '変更行数')).toEqual({ v: '記録なし', n: 'サブエージェントの変更は数えられない' });
  });

  it('(4)(6) トークンの記録が何も無ければ入力・出力・API リクエストとも記録なし(推計不可・0 と出さない)', async () => {
    const r = await normalizeSession({ id: 'e', events: [ev('user.message', { content: 'a' }, T(0))] });
    const page = html(r);
    expect(fieldOf(page, '入力トークン')?.v).toBe('記録なし');
    expect(fieldOf(page, '出力トークン')?.v).toBe('記録なし');
    expect(fieldOf(page, 'API リクエスト')).toEqual({ v: '記録なし', n: 'リクエスト単位の明細も終了時の累計も無い' });
    // 出力トークンだけ記録があるときは、従来どおり入力は推計不可
    const partial = await normalizeSession({ id: 'p', events: [ev('assistant.message', { content: 'x', outputTokens: 50, model: 'm' }, T(1))] });
    expect(fieldOf(html(partial), '入力トークン')?.v).toBe('推計不可');
    expect(fieldOf(html(partial), '出力トークン')?.v).toBe('50');
  });

  it('(4)(7) 終了時の累計だけのセッションは API リクエストの出所を「終了時の累計」と書き、premium request を出す', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        ev(
          'session.shutdown',
          {
            totalPremiumRequests: 82.5,
            modelMetrics: { m1: { requests: { count: 1962, cost: 82.5 }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } },
          },
          T(1),
        ),
      ],
    });
    const page = html(r);
    expect(fieldOf(page, 'API リクエスト')).toEqual({ v: '1,962', n: '終了時の累計(shutdown)の件数' });
    expect(fieldOf(page, 'premium request')).toEqual({ v: '82.5', n: '終了時の累計(shutdown)' });
    const none = await normalizeSession({ id: 'n', events: [ev('user.message', { content: 'a' }, T(0))] });
    expect(fieldOf(html(none), 'premium request')?.v).toBe('記録なし');
  });

  it('(5) system・会話が 0 の空の終了記録では、ツール定義の割合は出せないと書く(100% と出さない)', async () => {
    const r = await normalizeSession({ id: 'x', events: [ev('session.shutdown', { systemTokens: 0, conversationTokens: 0, toolDefinitionsTokens: 19837 }, T(1))] });
    const f = fieldOf(html(r), 'ツール定義のトークン');
    expect(f?.v).toBe('19,837');
    expect(f?.n).toContain('文脈に占める割合は出せない');
    expect(f?.n).not.toContain('100%');
    // 古い sessions.json(system 0・会話 0 が残っている)でも同じ
    r.exec.context = { ...r.exec.context, systemTokens: 0, conversationTokens: 0 };
    expect(fieldOf(html(r), 'ツール定義のトークン')?.n).not.toContain('100%');
  });
});

describe('詳細ページ: 同じ行の重複', () => {
  it('(8) 同じ内容(contentHash)の指示文は 1 行にまとめ、ソースのパスのある行を残す', () => {
    const base = { scope: 'repo' as const, heading: '# AGENTS', firstSeenAt: '2026-10-01T00:00:02Z', injections: 2 };
    const merged = mergeInstructionRows([
      { ...base, file: 'unknown', method: 'learned-heading', chars: 11405, contentHash: 'h1' },
      { ...base, file: 'AGENTS.md', method: 'imported-source', chars: 11404, contentHash: 'h1', sourcePath: 'C:\\w\\AGENTS.md', firstSeenAt: '2026-10-01T00:00:01Z' },
      { ...base, file: 'CLAUDE.md', method: 'import-stub', chars: 12, contentHash: 'h2' },
    ]);
    expect(merged.map((i) => [i.file, i.chars, i.injections, i.firstSeenAt])).toEqual([
      ['AGENTS.md', 11404, 4, '2026-10-01T00:00:01Z'],
      ['CLAUDE.md', 12, 2, '2026-10-01T00:00:02Z'],
    ]);
  });

  it('(10) 同じ wiki ページを何度読んでも 1 行にまとめ ×N を添える', async () => {
    const r = await normalizeSession({
      id: 'w',
      wikiClassifier: new WikiClassifier([{ path: 'my-wiki', pages: ['wiki'] }]),
      events: [
        ev('tool.execution_start', { toolName: 'view', toolCallId: 'v1', arguments: { path: 'E:\\v\\my-wiki\\wiki\\a.md' } }, T(1)),
        ev('tool.execution_start', { toolName: 'view', toolCallId: 'v2', arguments: { path: 'E:\\v\\my-wiki\\wiki\\a.md' } }, T(2)),
        ev('tool.execution_start', { toolName: 'view', toolCallId: 'v3', arguments: { path: 'E:\\v\\my-wiki\\wiki\\b.md' } }, T(3)),
      ],
    });
    const page = html(r);
    expect(page.match(/<li>wiki\/a\.md/g)).toHaveLength(1);
    expect(page).toContain('<li>wiki/a.md <span class="tag">×2</span></li>');
    expect(fieldOf(page, '個別ページ')).toEqual({ v: '3', n: '2 ページ' });
  });

  it('(11) 同じ理由で失敗したサブエージェントは ×N でまとめ、結果の無いツール呼び出しは「結果なし」に数える', async () => {
    const events: CopilotEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(ev('subagent.started', { agentName: 'implementer', toolCallId: `a${i}` }, T(i)));
      events.push(ev('subagent.failed', { agentName: 'implementer', toolCallId: `a${i}`, error: '402 You have exceeded your monthly quota' }, T(i)));
    }
    events.push(ev('tool.execution_start', { toolName: 'task', toolCallId: 't1' }, T(10)));
    events.push(ev('tool.execution_complete', { toolCallId: 't1', success: true }, T(11)));
    events.push(ev('tool.execution_start', { toolName: 'task', toolCallId: 't2' }, T(12)));
    const page = html(await normalizeSession({ id: 'f', events }));
    expect(page.match(/402 You have exceeded your monthly quota/g)).toHaveLength(1);
    expect(page).toContain('×3</span></li>');
    expect(page).toContain('<th scope="col" class="num">結果なし</th>');
    expect(page).toMatch(/<th scope="row">task<\/th><td class="num">2<\/td><td class="num">1<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">1<\/td>/);
  });

  it('(11) 結果がすべて揃っていれば「結果なし」の列は出さない', async () => {
    const page = html(
      await normalizeSession({
        id: 'ok',
        events: [ev('tool.execution_start', { toolName: 'view', toolCallId: 'v1' }, T(1)), ev('tool.execution_complete', { toolCallId: 'v1', success: true }, T(2))],
      }),
    );
    expect(page).not.toContain('結果なし');
  });
});

describe('詳細ページ: 時系列(12)', () => {
  it('本文の空の依頼は「(本文なし)」、最後の行より後の shutdown は「終了(shutdown)」の行', async () => {
    const r = await normalizeSession({
      id: 't',
      events: [ev('user.message', { content: '' }, T(0)), ev('tool.execution_start', { toolName: 'view', toolCallId: 'v1' }, T(1)), ev('session.shutdown', { shutdownType: 'routine' }, '2026-10-12T00:00:00.000Z')],
    });
    const page = html(r);
    expect(page).toContain('<tr class="k-user"><td class="num">');
    expect(page).toMatch(/<tr class="k-user">[\s\S]*?<span class="missing-value">\(本文なし\)<\/span>/);
    expect(page).toMatch(/<tr class="k-shutdown">[\s\S]*?<span class="kind">終了\(shutdown\)<\/span>/);
  });
});
