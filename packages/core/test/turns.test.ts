// 依頼単位の分析(段階 1): ツールの種類・工程・依頼の種類の規則、normalize のターンごとの出来事、工程別の集計、CSV
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../src/normalize.ts';
import { computeMetrics } from '../src/metrics.ts';
import { csvCell, sessionsCsv, turnsCsv } from '../src/tables.ts';
import { phaseOf, requestKindOf, sessionTurns, toolKind } from '../src/turns.ts';
import type { CopilotEvent } from '../src/types.ts';

const T0 = Date.parse('2026-11-06T00:00:00.000Z');
const ev = (dt: number, type: string, data: Record<string, unknown>, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({ type, data, timestamp: new Date(T0 + dt).toISOString(), ...extra });
const tool = (dt: number, id: string, name: string, args: unknown = {}, extra: Partial<CopilotEvent> = {}): CopilotEvent =>
  ev(dt, 'tool.execution_start', { toolCallId: id, toolName: name, arguments: args }, extra);
const done = (dt: number, id: string, success: boolean, code?: string): CopilotEvent => ev(dt, 'tool.execution_complete', { toolCallId: id, success, ...(code ? { error: { code } } : {}) });

describe('ツールの種類と工程の規則', () => {
  it('シェルはコマンドで検証 / git / 読む / その他に分ける。工程を決めないツールは null', () => {
    expect(toolKind('powershell', { command: 'npm run typecheck 2>&1 | Select-Object -Last 5' })).toBe('verify');
    expect(toolKind('bash', { command: 'npx vitest run' })).toBe('verify');
    expect(toolKind('powershell', { command: 'git commit -m "x"' })).toBe('git');
    expect(toolKind('powershell', { command: 'git status --short' })).toBe('read');
    expect(toolKind('powershell', { command: 'node scripts/x.mjs' })).toBe('shell');
    expect(toolKind('apply_patch', 'patch')).toBe('edit');
    expect(toolKind('rg', {})).toBe('read');
    expect(toolKind('github-mcp-server-get_file_contents', {})).toBe('read');
    expect(toolKind('sql', {})).toBe('plan');
    expect(toolKind('web_fetch', {})).toBe('web');
    expect(toolKind('task', {})).toBe('delegate');
    expect(toolKind('read_powershell', {})).toBeNull();
    expect(toolKind('task_complete', {})).toBeNull();
    expect(toolKind('something_new', {})).toBe('other');
  });

  it('工程: 編集 > 検証 > 運用 > 計画だけ > 回答のみ > 調査', () => {
    expect(phaseOf({ kinds: {} })).toBe('answer');
    expect(phaseOf({ kinds: { read: 3, edit: 1, verify: 2 } })).toBe('implement');
    expect(phaseOf({ kinds: { read: 3, verify: 1, git: 1 } })).toBe('verify');
    expect(phaseOf({ kinds: { read: 1, git: 2 } })).toBe('ops');
    expect(phaseOf({ kinds: { plan: 2 } })).toBe('plan');
    expect(phaseOf({ kinds: { plan: 1, read: 1 } })).toBe('research');
    expect(phaseOf({ kinds: { web: 2, shell: 1 } })).toBe('research');
  });

  it('依頼の種類: 短い返事は続行、戻しは差し戻し、直しは修正、問いは質問、それ以外は作業', () => {
    expect(requestKindOf('進めて')).toBe('continue');
    expect(requestKindOf('C')).toBe('continue');
    expect(requestKindOf('はい。')).toBe('continue');
    expect(requestKindOf('さっきの変更を元に戻して')).toBe('revert');
    expect(requestKindOf('そうじゃなくて、ボタンは右に置いて')).toBe('fix');
    expect(requestKindOf('CI が失敗してる？')).toBe('fix');
    expect(requestKindOf('グループを保存する機能はある？')).toBe('question');
    expect(requestKindOf('なぜ 2 回呼ばれるのか教えて')).toBe('question');
    expect(requestKindOf('設定画面を作って')).toBe('task');
    expect(requestKindOf('')).toBe('task');
  });
});

describe('normalizeSession のターンごとの出来事', () => {
  it('ツールの種類・失敗と拒否・再編集・中断・エラー・文脈圧縮・使用量を、起きたターンに数える', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        ev(0, 'session.start', { context: { cwd: 'X:\\p' } }),
        // ターン 1: 調べて編集し、テストが 2 回続けて失敗。同じファイルをもう一度編集
        ev(1000, 'user.message', { content: 'ボタンを足して' }),
        tool(1100, 'r1', 'report_intent'), // 内部ツールは数えない
        done(1150, 'r1', true),
        tool(1200, 'v1', 'view', { path: 'a.ts' }),
        done(1300, 'v1', true),
        tool(1400, 'e1', 'edit', { path: 'X:\\p\\a.ts' }),
        done(1500, 'e1', true),
        tool(1600, 't1', 'powershell', { command: 'npm test' }),
        done(1700, 't1', false),
        tool(1800, 't2', 'powershell', { command: 'npm test' }),
        done(1900, 't2', false),
        tool(2000, 'e2', 'edit', { path: 'X:\\p\\a.ts' }),
        done(2100, 'e2', true),
        ev(2200, 'session.compaction_complete', { success: true }),
        // ターン 2: 修正の依頼。git push を拒否、中断、利用上限のエラー
        ev(5000, 'user.message', { content: '違う、右に置いて' }),
        tool(5100, 'g1', 'powershell', { command: 'git push' }),
        done(5200, 'g1', false, 'denied'),
        ev(5300, 'abort', { reason: 'user' }, { id: 'a1' }),
        ev(5301, 'abort', { reason: 'user' }, { id: 'a2', parentId: 'a1' }), // 続けて出る 2 件目は数えない
        ev(5400, 'session.error', { errorType: 'quota', message: 'x' }),
        // ターン 3: ツールなしで答えた
        ev(9000, 'user.message', { content: 'これで終わり？' }),
        ev(9100, 'assistant.message', { content: 'はい' }),
        ev(1500, 'session.usage_record', { usage: { model: 'gpt-5', inputTokens: 100, outputTokens: 10, copilotUsage: { totalNanoAiu: 2e9 } } }),
        ev(5150, 'session.usage_record', { usage: { model: 'gpt-5', inputTokens: 50, outputTokens: 5 } }),
      ],
    });
    const ts = r.analysis.turnStats!;
    expect(ts).toHaveLength(3);
    expect(ts[0]).toMatchObject({ tools: 5, kinds: { read: 1, edit: 2, verify: 2 }, toolFailures: 2, denied: 0, maxConsecutiveFailures: 2, edits: 2, reEdits: 1, compactions: 1, aborts: 0, errors: 0 });
    expect(ts[1]).toMatchObject({ tools: 1, kinds: { git: 1 }, toolFailures: 0, denied: 1, aborts: 1, errors: 1, externalErrors: 1, edits: 0 });
    expect(ts[2]).toMatchObject({ tools: 0, kinds: {}, input: null });
    // 使用量はリクエストの時刻で振り分ける
    expect(ts[0]).toMatchObject({ input: 100, output: 10, nanoAiu: 2e9 });
    expect(ts[1]).toMatchObject({ input: 50, output: 5 });

    const rows = sessionTurns(r);
    expect(rows.map((t) => [t.phase, t.kind, t.nextKind])).toEqual([
      ['implement', 'task', 'fix'],
      ['ops', 'fix', 'question'],
      ['answer', 'question', null],
    ]);

    const m = computeMetrics([r]);
    expect(m.turns).toMatchObject({ turns: 3, sessions: 1, sessionsWithoutTurns: 0, truncatedSessions: 0 });
    expect(m.turns!.byPhase.implement).toMatchObject({ turns: 1, stuck: 1, toolFailures: 2, reEdits: 1, followedByFix: 1, withNext: 1, kinds: { task: 1 } });
    expect(m.turns!.byPhase.answer).toMatchObject({ turns: 1, stuck: 0, withNext: 0 });
    expect(m.turns!.byKind.fix).toMatchObject({ turns: 1, denied: 1, aborts: 1 });

    // CSV: BOM 付き・CRLF、1 ターン 1 行
    const csv = turnsCsv([r]);
    expect(csv.startsWith('\uFEFFセッションID,')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(',1,');
    expect(lines[1]).toContain('作業,実装,修正,1,1,');
    expect(lines[3].endsWith(',これで終わり？')).toBe(true);
    const scsv = sessionsCsv([r], new Map([['s', 2.5]])).trimEnd().split('\r\n');
    expect(scsv).toHaveLength(2);
    expect(scsv[1]).toContain(',2.5,');
  });

  it('201 ターン目以降は分析しない(使用量も振り分けない)', async () => {
    const events: CopilotEvent[] = [];
    for (let i = 0; i < 201; i++) events.push(ev(i * 1000, 'user.message', { content: `q${i}` }));
    events.push(ev(200_500, 'session.usage_record', { usage: { model: 'gpt-5', inputTokens: 9, outputTokens: 9 } }));
    const r = await normalizeSession({ id: 's', events });
    expect(r.analysis.turnStats).toHaveLength(200);
    expect(r.analysis.turnStats!.at(-1)!.input).toBeNull();
    expect(computeMetrics([r]).turns).toMatchObject({ turns: 200, truncatedSessions: 1 });
  });
});

describe('CSV のセル', () => {
  it('カンマ・引用符・改行を含むものだけ囲む', () => {
    expect(csvCell('a')).toBe('a');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('1\n2')).toBe('"1\n2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('1');
  });
});
