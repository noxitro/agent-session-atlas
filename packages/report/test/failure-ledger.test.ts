// 失敗の台帳を読む側: 詳細ページの欄と節、集計(failure-stats.ts)とそのページ・JSON、セッション記録で伏せた件数。
// イベントと鍵らしい文字列はすべて架空のもの(鍵は実行時に組み立てる)
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { renderDetailHtml } from '../src/detail.ts';
import { FAILURE_THRESHOLDS as T, failureStats } from '../src/failure-stats.ts';
import { failuresJson, renderFailuresHtml } from '../src/failures-page.ts';
import { DEFAULT_TRANSCRIPT_OPTIONS, renderTranscript, summarizeArgs, summarizeArgsCounted } from '../src/transcript.ts';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const ev = (type: string, data: unknown, s: number): CopilotEvent => ({ type, data, timestamp: at(s) });
const call = (id: string, tool: string, args: unknown, s: number, extra: Record<string, unknown> = {}): CopilotEvent => ev('tool.execution_start', { toolCallId: id, toolName: tool, arguments: args, ...extra }, s);
const ok = (id: string, s: number): CopilotEvent => ev('tool.execution_complete', { toolCallId: id, success: true }, s);
const fail = (id: string, msg: string, s: number): CopilotEvent => ev('tool.execution_complete', { toolCallId: id, success: false, error: { code: 'failure', message: msg } }, s);
const html = (r: SessionRecord): string => renderDetailHtml(r, { css: '', judgment: null, generatedAt: at(0) });
const withoutLedger = (r: SessionRecord): SessionRecord => {
  const { failures: _f, failuresDropped: _d, ...analysis } = r.analysis;
  return { ...r, analysis };
};

// ---------- 詳細ページ(依頼ごとの表の欄と、1 件ごとの節) ----------

const ledgerEvents = (): CopilotEvent[] => [
  // 最初の依頼より前の失敗(依頼は「—」)
  call('p', 'view', { path: 'x' }, 0),
  ev('tool.execution_complete', { toolCallId: 'p', success: false, error: { code: 'failure', message: '<script>alert(1)</script> & does not exist' } }, 1),
  ev('user.message', { content: '直して' }, 2),
  call('a', 'view', { path: 'a.ts' }, 3),
  fail('a', 'Path does not exist', 4),
  // 同じ引数で呼び直して、また失敗
  call('b', 'view', { path: 'a.ts' }, 5),
  fail('b', 'Path does not exist', 6),
  call('c', 'srv-run', {}, 7, { mcpServerName: 'srv' }),
  ev('tool.execution_complete', { toolCallId: 'c', success: false, error: { code: 'denied' } }, 8),
  // サブエージェントの失敗(親の呼び出しの prompt は agents[] に 1 回だけ)
  call('t1', 'task', { agent_type: 'explore', prompt: '合成の依頼 <b>' }, 9),
  ev('subagent.started', { toolCallId: 't1', agentName: 'explore' }, 10),
  call('s1', 'grep', { pattern: 'x' }, 11, { parentToolCallId: 't1' }),
  ev('tool.execution_complete', { toolCallId: 's1', success: false, error: 'timed out', parentToolCallId: 't1' }, 12),
  ev('subagent.completed', { toolCallId: 't1', agentName: 'explore' }, 13),
  ok('t1', 14),
];

describe('詳細ページ: 失敗の台帳', () => {
  it('依頼ごとの表に内訳の欄、1 件ごとの節を出す', async () => {
    const page = html(await normalizeSession({ id: 'l', events: ledgerEvents() }));
    // 依頼ごとの表: 失敗の内訳の欄(ツール・要因か拒否・回数。多い順)
    expect(page).toContain('<th scope="col">失敗・拒否の内訳</th>');
    expect(page).toContain('<td><span class="fb">view 対象が見つからない ×2</span><span class="fb">srv-run 拒否 ×1</span><span class="fb">grep 時間切れ ×1</span></td>');
    // 1 件ごとの節: 台帳の順に 5 行
    expect(page).toContain('>失敗と拒否(1 件ごと)</h2>');
    const rows = /<table class="ledger small fails">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(page)![1];
    expect(rows.match(/<tr>/g)).toHaveLength(5);
    // 最初の依頼より前の失敗は依頼が「—」。エラー文は HTML として解釈されない
    expect(rows.startsWith('<tr><td class="num"><span class="missing-value">—</span></td>')).toBe(true);
    expect(rows).toContain('failure: &lt;script&gt;alert(1)&lt;/script&gt; &amp; does not exist');
    expect(page).not.toContain('<script>alert(1)');
    // その後: 同じ引数で呼び直して失敗 / 拒否 / サブエージェントは続きなし
    expect(rows).toContain('<td class="next">view → 失敗 <span class="tag">同じ引数で呼び直し</span></td>');
    expect(rows).toContain('<td>srv-run <span class="tag">MCP: srv</span></td><td class="fkind">拒否</td>');
    expect(rows).toContain('<td>grep <span class="tag">サブエージェント: explore</span></td><td class="fkind">失敗: 時間切れ</td>');
    expect(rows).toContain('<span class="missing-value">続きなし</span>');
    expect(rows).toContain('<td class="args">{&quot;path&quot;:&quot;a.ts&quot;}</td>');
    // サブエージェントへの依頼文は 1 回だけ
    expect(page.split('<li>explore: 合成の依頼 &lt;b&gt;</li>')).toHaveLength(2);
    expect(page).not.toContain('「失敗と拒否(1 件ごと)」がありません');
    expect(page).not.toContain('件は載っていません');
  });

  it('台帳の無い古い記録・0 件の台帳・上限で落ちた行', async () => {
    // 古い記録(台帳なし): 欄も節も出さず、失敗があるときだけ断りを出す
    const old = withoutLedger(await normalizeSession({ id: 'o', events: ledgerEvents() }));
    const page = html(old);
    expect(page).not.toContain('失敗・拒否の内訳');
    expect(page).not.toContain('>失敗と拒否(1 件ごと)</h2>');
    expect(page).toContain('「失敗と拒否(1 件ごと)」がありません');
    // 失敗の無い古い記録には断りも出さない
    const quiet = withoutLedger(await normalizeSession({ id: 'q', events: [ev('user.message', { content: 'x' }, 0)] }));
    expect(html(quiet)).not.toContain('「失敗と拒否(1 件ごと)」がありません');
    // 台帳が 0 件: 欄は出す(どの依頼も「—」)、節は出さない
    const empty = html(await normalizeSession({ id: 'e', events: [ev('user.message', { content: 'x' }, 0)] }));
    expect(empty).toContain('失敗・拒否の内訳');
    expect(empty).not.toContain('>失敗と拒否(1 件ごと)</h2>');
    // 失敗の数はあるのに台帳の行が無い依頼(上限で落ちた分など)は「—」ではなく「記録なし」
    const lost = await normalizeSession({ id: 'n', events: ledgerEvents() });
    lost.analysis.failures = [];
    expect(html(lost)).toContain('<td><span class="missing-value">記録なし</span></td><td class="num">');
    // 上限で載せなかった件数
    const cut = await normalizeSession({ id: 'c', events: ledgerEvents() });
    cut.analysis.failuresDropped = 3;
    expect(html(cut)).toContain('1 セッション 500 行の上限を超えた 3 件は載っていません。');
  });
});

// ---------- 集計(failures.html・failures.json) ----------

/** 同じ文で 3 回失敗して 4 回目に成功、MCP の失敗 1、拒否 1、成功 20。skill を途中で呼ぶ */
async function busy(id: string): Promise<SessionRecord> {
  const e: CopilotEvent[] = [ev('user.message', { content: '直して' }, 0)];
  let s = 1;
  for (let i = 0; i < 3; i++) {
    e.push(call(`v${i}`, 'view', { path: 'a.ts' }, s), fail(`v${i}`, `Path 'X:\\synthetic\\a${i}.ts' does not exist`, s + 1));
    s += 2;
  }
  e.push(call('v3', 'view', { path: 'a.ts' }, s), ok('v3', s + 1));
  s += 2;
  e.push(ev('skill.invoked', { name: 'k1', trigger: 'agent-invoked' }, s));
  s += 1;
  e.push(call('m1', 'srv-run', {}, s, { mcpServerName: 'srv' }), fail('m1', 'Request timed out <b>', s + 1));
  s += 2;
  e.push(call('d1', 'edit', { path: 'b.ts' }, s), ev('tool.execution_complete', { toolCallId: 'd1', success: false, error: { code: 'denied' } }, s + 1));
  s += 2;
  for (let i = 0; i < 20; i++) {
    e.push(call(`g${i}`, 'grep', { pattern: `p${i}` }, s), ok(`g${i}`, s + 1));
    s += 2;
  }
  const r = await normalizeSession({ id, events: e });
  r.instructions = [{ file: 'AGENTS.md', scope: 'repo', method: 'heading-keyword', chars: 100, firstSeenAt: at(0), heading: '# 合成の指示', contentHash: 'abcdef012345', injections: 1 }];
  return r;
}

describe('失敗の台帳の集計', () => {
  it('単位ごとに数える', async () => {
    const a = await busy('00000000-0000-4000-8000-0000000000a1');
    // 台帳の無い古い記録(失敗 5 件)と、空のセッション
    const old = withoutLedger(await busy('00000000-0000-4000-8000-0000000000a2'));
    const empty = await normalizeSession({ id: '00000000-0000-4000-8000-0000000000a3', events: [] });
    expect(empty.empty).toBe(true);
    const st = failureStats([a, old, empty]);

    // 対象: 台帳なしは別に数え、失敗 0 件とは扱わない(分母にも入れない)
    const c = st.coverage;
    expect([c.sessions, c.withLedger, c.withoutLedger, c.withoutLedgerFailures]).toEqual([2, 1, 1, 5]);
    expect([c.completed, c.failures, c.denied, c.rows, c.dropped]).toEqual([26, 4, 1, 5, 0]);

    // ツール: 回数は結果から。結果のある呼び出しが MIN_CALLS 未満なら率は出さない
    const view = st.tools.find((u) => u.key === 'view')!;
    expect([view.completed, view.failures, view.denied, view.rate, view.sessions]).toEqual([4, 3, 0, null, 1]);
    expect(view.causes).toEqual([{ key: 'not_found', n: 3 }]);
    // 同じ引数で呼び直した 3 回のうち、成功は最後の 1 回
    expect([view.retries, view.retriesOk]).toEqual([3, 1]);
    expect(st.tools.some((u) => u.key === 'grep')).toBe(false);
    expect(st.toolsTotal).toBe(3);
    expect(T.MIN_CALLS).toBeGreaterThan(4);

    // MCP サーバー
    expect(st.mcp.map((u) => [u.key, u.completed, u.failures])).toEqual([['srv', 1, 1]]);

    // 繰り返している失敗: パスの違う同じ文は 1 つのまとまり。MIN_REPEAT 未満のものは挙げない
    expect(st.groups).toHaveLength(1);
    const g = st.groups[0];
    expect([g.n, g.sessions, g.denied, g.retries, g.retriesOk]).toEqual([3, 1, 0, 3, 1]);
    expect(g.exampleSessions).toEqual(['00000000-0000-4000-8000-0000000000a1']);
    expect(g.example).toContain('a0.ts');

    // エージェント: 本体だけ
    expect(st.agents.map((x) => [x.main, x.runs, x.failures, x.denied])).toEqual([[true, null, 4, 1]]);

    // skill: セッションの単位。最初に呼んだ後の行は MCP の失敗と拒否の 2 行
    const k = st.skills[0];
    expect([k.key, k.sessions, k.failed, k.rowsAfter, k.rate, k.otherSessions]).toEqual(['k1', 1, 5, 2, null, 0]);
    // 指示文の版: 読み込んだセッションの単位
    const i = st.instructions[0];
    expect([i.key, i.sessions, i.completed, i.failed, i.rowsAfter]).toEqual(['abcdef012345', 1, 26, 5, undefined]);

    // 失敗の後
    const n = st.next;
    expect([n.rows, n.retries, n.retriesOk, n.movedOn, n.movedOnOk, n.user, n.end]).toEqual([5, 3, 1, 2, 1, 0, 0]);
  });

  it('率には十分な呼び出しとセッションが要る', async () => {
    const n = T.MIN_SESSIONS;
    const recs = await Promise.all(Array.from({ length: n }, (_, i) => busy(`00000000-0000-4000-8000-0000000000b${i}`)));
    const st = failureStats(recs);
    const view = st.tools.find((u) => u.key === 'view')!;
    expect(view.completed).toBe(4 * n);
    expect(view.rate).toBe(4 * n >= T.MIN_CALLS ? 3 / 4 : null);
    // skill は全セッションで呼んでいるので、呼ばなかった側は 0 件で率を出さない
    const k = st.skills[0];
    expect([k.sessions, k.otherSessions, k.otherRate]).toEqual([n, 0, null]);
    // 比べる相手の率が出せないので、呼んだ側の率も出さない
    expect(k.rate).toBeNull();
    expect(st.groups[0].sessions).toBe(n);
    expect(st.groups[0].exampleSessions).toHaveLength(Math.min(T.EXAMPLE_SESSIONS, n));
  });

  it('セッションの単位のものは、使わなかったセッションと比べる', async () => {
    const n = T.MIN_SESSIONS;
    const withSkill = await Promise.all(Array.from({ length: n }, (_, i) => busy(`00000000-0000-4000-8000-0000000000c${i}`)));
    const without = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const e: CopilotEvent[] = [ev('user.message', { content: '見て' }, 0)];
        for (let j = 0; j < 20; j++) e.push(call(`g${j}`, 'grep', { pattern: `p${j}` }, 1 + j * 2), ok(`g${j}`, 2 + j * 2));
        return normalizeSession({ id: `00000000-0000-4000-8000-0000000000d${i}`, events: e });
      }),
    );
    const k = failureStats([...withSkill, ...without]).skills[0];
    expect([k.sessions, k.otherSessions, k.completed, k.failed]).toEqual([n, n, 26 * n, 5 * n]);
    expect([k.rate, k.otherRate]).toEqual([5 / 26, 0]);
  });
});

const page = (recs: SessionRecord[]): string =>
  renderFailuresHtml({ css: '', generatedAt: at(0), stats: failureStats(recs), meta: {}, sessionName: (id) => `名前 ${id.slice(-2)}`, libraryHref: 'instructions.html' });

describe('失敗の台帳の集計のページ', () => {
  it('節・リンク・エスケープ', async () => {
    const out = page([await busy('00000000-0000-4000-8000-0000000000a1')]);
    for (const id of ['f-overview', 'f-groups', 'f-tools', 'f-mcp', 'f-agents', 'f-skills', 'f-instructions', 'f-next']) expect(out).toContain(`<section class="section ins" id="${id}"`);
    expect(out).toContain('<h1>失敗の台帳の集計</h1>');
    // まとまりの例から詳細ページへ。指示文の版は閲覧ページへ
    expect(out).toContain('<a href="sessions/00000000-0000-4000-8000-0000000000a1.html">名前 a1</a>');
    expect(out).toContain('<a href="instructions.html#v-abcdef012345">');
    expect(out).toContain('href="atlas.html"');
    // 用語の説明へのリンク
    expect(out).toContain('href="glossary.html#failure-group"');
    // 率を出せないものは「—」。エラー文は HTML として解釈されない
    expect(out).toContain('<td class="num"><span class="missing-value">—</span></td>');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<script src');
    expect(out).not.toContain('http://');
    expect(out).not.toContain('https://');
  });

  it('台帳が無ければそう書く', async () => {
    const out = page([withoutLedger(await busy('00000000-0000-4000-8000-0000000000a2'))]);
    expect(out).toContain('失敗の台帳のあるセッションがありません');
    expect(out).toContain('失敗・拒否 5 件の中身は、この集計に入っていません');
    expect(out).not.toContain('id="f-tools"');
  });

  it('JSON には閾値と集計を書く', async () => {
    const st = failureStats([await busy('00000000-0000-4000-8000-0000000000a1')]);
    const v = JSON.parse(JSON.stringify(failuresJson(st, at(0))));
    expect(v.version).toBe(1);
    expect(v.thresholds).toEqual({ minCalls: T.MIN_CALLS, minSessions: T.MIN_SESSIONS, minRepeat: T.MIN_REPEAT, topRows: T.TOP_ROWS, maxRowsPerSession: 500 });
    expect(Object.keys(v)).toEqual(['version', 'generatedAt', 'thresholds', 'coverage', 'groups', 'groupsTotal', 'tools', 'toolsTotal', 'mcp', 'mcpTotal', 'agents', 'agentsTotal', 'skills', 'skillsTotal', 'instructions', 'instructionsTotal', 'next']);
    expect(v.coverage.withLedger).toBe(1);
    expect(v.tools[0].key).toBe('view');
    expect(v.groups[0].exampleSessions[0]).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(v.next.retriesOk).toBe(1);
    // skill には呼んだ後の行があり、指示文の版には無い
    expect('rowsAfter' in v.skills[0]).toBe(true);
    expect('rowsAfter' in v.instructions[0]).toBe(false);
  });
});

// ---------- セッション記録: 切る前の全文で伏せ、伏せた数をすべて数える ----------

const opts = (over: Partial<typeof DEFAULT_TRANSCRIPT_OPTIONS> = {}) => ({ ...DEFAULT_TRANSCRIPT_OPTIONS, ...over, generatedAt: at(1000) });

/** イベントの並びから記録を作る */
async function render(id: string, events: CopilotEvent[], over: Partial<typeof DEFAULT_TRANSCRIPT_OPTIONS> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-ledger-'));
  const eventsPath = join(dir, 'events.jsonl');
  await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const record = await normalizeSession({ id, workspace: { created_at: at(0) }, events });
  return renderTranscript(record, eventsPath, [], opts(over));
}

const key = (c: string): string => `ghp_${c.repeat(40)}`;

describe('セッション記録の秘密情報', () => {
  it('上限の位置に鍵が掛かっても、鍵の一部が残らない(全文を伏せてから切る)', async () => {
    // 上限 100 字なら頭 70 字・尻 30 字を残す。頭の切れ目(70 字目)と尻の切れ目に鍵が掛かる
    const r = await render(
      'tr5',
      [
        ev('session.start', { sessionId: 'tr5', copilotVersion: '1.0.100' }, 0),
        ev('user.message', { content: `${'x'.repeat(40)} ${key('a')} ${'y'.repeat(200)}`, agentMode: 'interactive' }, 1),
        ev('user.message', { content: `${'y'.repeat(200)} ${key('b')} ${'z'.repeat(10)}`, agentMode: 'interactive' }, 2),
        ev('user.message', { content: `鍵 ${key('c')}`, agentMode: 'interactive' }, 3),
      ],
      { maxTextChars: 100 },
    );
    const md = r.markdown;
    expect(md).not.toContain('ghp_');
    expect(md).not.toContain('aaaa');
    expect(md).not.toContain('bbbb');
    expect(md).toContain('[伏せました: GitHub トークン]');
    expect(md).toContain('(中略');
    // 上限に届かない本文は切らない
    expect(md).toContain('鍵 [伏せました: GitHub トークン]');
    // 伏せた数・中略した本文の数は 1 件ずつ数える
    expect([r.secretHits, r.truncated]).toEqual([3, 2]);
  });

  it('ツール引数の要約(160 字で切る)の切れ目に鍵が掛かっても残らず、切る前の全文で数える', () => {
    const v = { command: `${'x'.repeat(150)} ${key('d')}` };
    const s = summarizeArgs('bash', v);
    expect(s).not.toContain('ghp_');
    expect(s).not.toContain('dddd');
    expect(s.startsWith(`${'x'.repeat(150)} [伏せました`)).toBe(true);
    // 伏せた数は切る前の全文で数える(160 字より後ろの鍵も入る)
    expect(summarizeArgsCounted('bash', v).hits).toBe(1);
    expect(summarizeArgsCounted('bash', { command: `${key('e')} ${'x'.repeat(200)} ${key('f')}` }).hits).toBe(2);
    expect(summarizeArgsCounted('bash', null)).toEqual({ text: '', hits: 0 });
  });

  it('ツールの引数・ツールの失敗の文・サブエージェントの失敗・エラーの文で伏せた数も、記録の末尾の件数に入れる', async () => {
    const bearer = `${'Bearer'} ${'r'.repeat(32)}`;
    const token = `ghp_${'t'.repeat(36)}`;
    const sk = `sk-${'k'.repeat(24)}`;
    const aws = `AKIA${'W'.repeat(16)}`;
    const r = await render(
      'tr3',
      [
        ev('session.start', { sessionId: 'tr3', copilotVersion: '1.0.100' }, 0),
        ev('user.message', { content: '鍵の無い依頼', agentMode: 'interactive' }, 1),
        ev('tool.execution_start', { toolCallId: 'c1', toolName: 'powershell', arguments: { command: `curl -H "Authorization: ${bearer}" https://example.invalid/` } }, 2),
        ev('tool.execution_complete', { toolCallId: 'c1', success: false, error: { code: 'failure', message: `remote rejected ${token}` }, result: { content: 'RESULT_BODY' } }, 4),
        ev('subagent.failed', { agentName: 'explore', error: `auth failed with ${sk}` }, 5),
        ev('session.error', { errorType: 'auth', message: `credential ${aws} was rejected` }, 6),
      ],
      { toolOutput: 'none' },
    );
    const md = r.markdown;
    expect(md).toContain('✖ `powershell` curl -H "Authorization: [伏せました: Bearer トークン]" https://example.invalid/(2秒) — 失敗: failure: remote rejected [伏せました: GitHub トークン]');
    expect(md).toContain('**サブエージェント失敗** `explore`: auth failed with [伏せました: OpenAI / Anthropic 系キー]');
    expect(md).toContain('**エラー** auth: credential [伏せました: AWS アクセスキー] was rejected');
    for (const secret of [bearer, token, sk, aws]) expect(md).not.toContain(secret);
    expect(md).not.toContain('RESULT_BODY');
    expect(r.secretHits).toBe(4);
    expect(md).toContain('4 件伏せました');
    expect(md).not.toContain('見つかりませんでした');
  });

  it('引数の 160 字より後ろの鍵も数え、鍵の無い同じ形は 0 件', async () => {
    const token = `ghp_${'f'.repeat(36)}`;
    const events = (command: string): CopilotEvent[] => [
      ev('session.start', { sessionId: 'tr4', copilotVersion: '1.0.100' }, 0),
      ev('user.message', { content: '鍵の無い依頼', agentMode: 'interactive' }, 1),
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'powershell', arguments: { command } }, 2),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'ok' } }, 3),
    ];
    const r = await render('tr4', events(`echo ${'x'.repeat(200)} ${token}`), { toolOutput: 'none' });
    expect(r.markdown).toContain(`✔ \`powershell\` echo ${'x'.repeat(155)}…`);
    expect(r.markdown).not.toContain(token);
    expect(r.markdown).not.toContain('ffff');
    expect(r.secretHits).toBe(1);
    expect(r.markdown).toContain('1 件伏せました');
    expect(r.markdown).not.toContain('見つかりませんでした');
    const clean = await render('tr4', events(`echo ${'x'.repeat(200)}`), { toolOutput: 'none' });
    expect(clean.secretHits).toBe(0);
    expect(clean.markdown).toContain('見つかりませんでした');
    expect(clean.markdown).not.toContain('件伏せました');
  });
});
