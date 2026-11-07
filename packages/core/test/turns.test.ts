// 依頼単位の分析(段階 1): ツールの種類・工程・依頼の種類の規則、normalize のターンごとの出来事、工程別の集計、CSV
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../src/normalize.ts';
import { computeMetrics } from '../src/metrics.ts';
import { csvCell, sessionsCsv, turnsCsv } from '../src/tables.ts';
import { commandKind, phaseOf, requestKindOf, sessionTurns, toolKind } from '../src/turns.ts';
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

  it('シェルは段ごとの先頭で判定する(cd・環境変数は読み飛ばす、引用符の中の語は見ない、git のオプションを許す)', () => {
    expect(commandKind('cd E:\\dev\\x; cmake --build build --config Debug')).toBe('verify');
    expect(commandKind('.\\build\\Debug\\game.exe --smoke')).toBe('verify');
    expect(commandKind('Set-Location X:\\p; git --no-pager diff --stat')).toBe('read');
    expect(commandKind('git -C repo status --short && git log -1')).toBe('read');
    expect(commandKind('git worktree list; git branch --list; git status')).toBe('read');
    expect(commandKind('git commit -m "make the build pass; deploy"')).toBe('git');
    expect(commandKind('cat docs/deploy.md')).toBe('read');
    expect(commandKind('gh pr view 12 --json state')).toBe('read');
    expect(commandKind('gh pr create --fill')).toBe('git');
    expect(commandKind('git status; npm test')).toBe('verify');
    expect(commandKind('node scripts/x.mjs | Select-Object -Last 5')).toBe('shell');
    expect(commandKind('$env:CI = 1; npx vitest run')).toBe('verify');
    expect(commandKind('& "E:\\dev\\out\\build\\Debug\\runtime.exe" --headless')).toBe('verify');
    expect(commandKind('cmd /c "call vcvars64.bat && cmake --build build"')).toBe('verify');
    expect(commandKind('$vswhere = "C:\\vswhere.exe"; $ErrorActionPreference = "Stop"; Get-ChildItem src')).toBe('read');
    expect(commandKind('# 確認\nGet-Content a.txt')).toBe('read');
    // 引用符の中の ; && | 改行では分けない(閉じない引用符は見ずに分ける)
    expect(commandKind('git commit -m "fix; npm test"')).toBe('git');
    expect(commandKind("git commit -m 'a && npm test'")).toBe('git');
    expect(commandKind('git commit -m "first\nnpm test"')).toBe('git');
    expect(commandKind('git commit -m "say \\"x; npm test\\""')).toBe('git');
    expect(commandKind("echo don't; npm test")).toBe('verify');
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
    // 原因を尋ねるだけなら質問、直しを頼んでいれば修正
    expect(requestKindOf('なぜ動かないの？')).toBe('question');
    expect(requestKindOf('エラーが出ます。原因は何ですか？')).toBe('question');
    expect(requestKindOf('なぜ動かないの？直して')).toBe('fix');
    expect(requestKindOf('動かない。なぜ？直してもらえますか？')).toBe('fix');
    expect(requestKindOf('グループを保存する機能はある？')).toBe('question');
    expect(requestKindOf('なぜ 2 回呼ばれるのか教えて')).toBe('question');
    expect(requestKindOf('設定画面を作って')).toBe('task');
    expect(requestKindOf('')).toBe('task');
    // 問いは最後の文で見る。「〜してもらえますか」は依頼、「X ではなく Y」だけでは修正にしない
    expect(requestKindOf('下記アドバイスに基づいて設定してもらえますか？')).toBe('task');
    expect(requestKindOf('テーマ設定は適用されていますか？ また、手順を README に追記して')).toBe('task');
    expect(requestKindOf('白飛びしています。テーマ設定は適用されていますか？')).toBe('question');
    expect(requestKindOf('grep ではなく LSP を使って、次を調べて')).toBe('task');
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
    // 同じ依頼の中の 2 回目の編集は重ね編集(詰まりには数えない)
    expect(ts[0]).toMatchObject({ tools: 5, kinds: { read: 1, edit: 2, verify: 2 }, toolFailures: 2, denied: 0, maxConsecutiveFailures: 2, edits: 2, reEdits: 0, repeatEdits: 1, compactions: 1, aborts: 0, errors: 0 });
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
    expect(m.turns!.byPhase.implement).toMatchObject({ turns: 1, stuck: 1, toolFailures: 2, reEdits: 0, followedByFix: 1, withNext: 1, kinds: { task: 1 } });
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

  it('前の依頼で編集したファイルをもう一度編集したら再編集(詰まり)、同じ依頼の中なら重ね編集', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        ev(0, 'user.message', { content: '作って' }),
        tool(100, 'a', 'edit', { path: 'X:\\p\\a.ts' }),
        tool(200, 'b', 'edit', { path: 'X:\\p\\a.ts' }),
        ev(1000, 'user.message', { content: '右に寄せて' }),
        tool(1100, 'c', 'edit', { path: 'X:\\p\\a.ts' }),
        tool(1200, 'd', 'create', { path: 'X:\\p\\b.ts' }),
      ],
    });
    expect(r.analysis.turnStats!.map((t) => [t.edits, t.reEdits, t.repeatEdits])).toEqual([
      [2, 0, 1],
      [2, 1, 0],
    ]);
    expect(sessionTurns(r).map((t) => t.kind)).toEqual(['task', 'task']);
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
    // 表計算ソフトが式として読まないよう、= + - @ 始まりの文字列には ' を足す(数値はそのまま)
    expect(csvCell('@plan.md を見て')).toBe("'@plan.md を見て");
    expect(csvCell('--foo=bar は?')).toBe("'--foo=bar は?");
    expect(csvCell('=1+1,2')).toBe('"\'=1+1,2"');
    expect(csvCell(-3)).toBe('-3');
  });
});
