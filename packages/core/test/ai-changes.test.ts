// AI の変更の取り出し(ai-changes.ts)。イベントと差分はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { extractAiChanges, parseApplyPatch, parseUnifiedDiff } from '../src/ai-changes.ts';
import type { CopilotEvent } from '../src/types.ts';

const ROOT = 'X:\\zz\\repo';
let n = 0;
const ts = (min: number) => new Date(Date.UTC(2026, 10, 1, 10, min)).toISOString();

function diffOf(path: string, added: string[], removed: string[] = [], created = false): string {
  const p = path.replace(/\\/g, '/');
  return [
    '',
    `diff --git a/${p} b/${p}`,
    'index 0000000..1111111 100644',
    `--- ${created ? 'a/dev/null' : `a/${p}`}`,
    `+++ b/${p}`,
    '@@ -1,2 +1,3 @@',
    ' context',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ' tail',
    '',
  ].join('\n');
}

/** 編集 1 回分(開始と完了)のイベント */
function edit(path: string, added: string[], removed: string[] = [], o: { min?: number; tool?: string; args?: unknown; success?: boolean; noDiff?: boolean; created?: boolean } = {}): CopilotEvent[] {
  const id = `call-${++n}`;
  const tool = o.tool ?? (o.created ? 'create' : 'edit');
  const args = o.args ?? { path, old_str: removed.join('\n'), new_str: added.join('\n') };
  return [
    { type: 'tool.execution_start', timestamp: ts(o.min ?? 1), data: { toolCallId: id, toolName: tool, arguments: args } },
    {
      type: 'tool.execution_complete',
      timestamp: ts(o.min ?? 1),
      data: { toolCallId: id, success: o.success ?? true, result: o.noDiff ? { content: 'ok' } : { content: 'ok', detailedContent: diffOf(path, added, removed, o.created) } },
    },
  ];
}

const start = (ctx: Record<string, unknown> = { cwd: ROOT, gitRoot: ROOT, branch: 'main', headCommit: 'abc123' }): CopilotEvent => ({ type: 'session.start', timestamp: ts(0), data: { context: ctx } });
const F = `${ROOT}\\src\\a.ts`;

describe('parseUnifiedDiff', () => {
  it('ファイルの見出しと、連続した +/- の塊を読む', () => {
    const d = parseUnifiedDiff(diffOf('X:/zz/repo/a.ts', ['n1', 'n2'], ['o1']));
    expect(d).toEqual([{ oldPath: 'X:/zz/repo/a.ts', newPath: 'X:/zz/repo/a.ts', blocks: [{ added: ['n1', 'n2'], removed: ['o1'] }] }]);
  });
  it('新しいファイルは oldPath が null', () => {
    expect(parseUnifiedDiff(diffOf('X:/zz/a.ts', ['x'], [], true))[0].oldPath).toBeNull();
  });
  it('塊の中の "--- " で始まる行は、消した行として読む(見出しと取り違えない)', () => {
    const text = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', '--- old dashes', '+++ new pluses', ''].join('\n');
    expect(parseUnifiedDiff(text)[0].blocks).toEqual([{ added: ['++ new pluses'], removed: ['-- old dashes'] }]);
  });
  it('複数ファイルの diff を分ける', () => {
    const d = parseUnifiedDiff(diffOf('X:/a', ['1']) + diffOf('X:/b', ['2']));
    expect(d.map((x) => x.newPath)).toEqual(['X:/a', 'X:/b']);
  });
});

describe('parseApplyPatch', () => {
  it('Add / Update / Delete を読む', () => {
    const p = parseApplyPatch(['*** Begin Patch', '*** Add File: X:\\a.ts', '+one', '*** Update File: X:\\b.ts', '@@', ' ctx', '-old', '+new', '*** Delete File: X:\\c.ts', '*** End Patch'].join('\n'));
    expect(p).toEqual([
      { path: 'X:\\a.ts', op: 'add', blocks: [{ added: ['one'], removed: [] }] },
      { path: 'X:\\b.ts', op: 'update', blocks: [{ added: ['new'], removed: ['old'] }] },
      { path: 'X:\\c.ts', op: 'delete', blocks: [] },
    ]);
  });
});

describe('extractAiChanges', () => {
  it('開始時の文脈(headCommit など)を、出所つきで取る', () => {
    const s = extractAiChanges('s1', [start(), ...edit(F, ['const a = 1;'])]);
    expect(s.context).toMatchObject({ cwd: ROOT, gitRoot: ROOT, branch: 'main', headCommit: 'abc123', start: ts(0), end: ts(1) });
    expect(s.context.sources).toEqual({ cwd: 'events', gitRoot: 'events', branch: 'events', headCommit: 'events' });
    expect(s.hunks).toEqual([{ id: 1, path: F, at: ts(1), toolCallId: expect.any(String), lines: ['const a = 1;'], from: 'diff' }]);
  });

  it('再開のあとの headCommit では上書きしない(最初の基準を使う)', () => {
    const s = extractAiChanges('s1', [start(), { type: 'session.resume', timestamp: ts(5), data: { context: { cwd: ROOT, headCommit: 'later' } } }]);
    expect(s.context.headCommit).toBe('abc123');
  });

  it('AI が後で書き直した自分の行は数えず、最後に残した形だけを数える', () => {
    const s = extractAiChanges('s1', [start(), ...edit(F, ['v1 line', 'keep line'], [], { min: 1 }), ...edit(F, ['v2 line'], ['v1 line'], { min: 2 })]);
    expect(s.hunks.map((h) => h.lines)).toEqual([['keep line'], ['v2 line']]);
  });

  it('AI が足していない行を消しても、何も起きない', () => {
    const s = extractAiChanges('s1', [start(), ...edit(F, ['new'], ['pre-existing'])]);
    expect(s.hunks.map((h) => h.lines)).toEqual([['new']]);
  });

  it('失敗した編集・session-state の中・空白だけの行は数えない', () => {
    const s = extractAiChanges('s1', [
      start(),
      ...edit(F, ['failed'], [], { success: false }),
      ...edit('X:\\home\\zz\\.copilot\\session-state\\x\\plan.md', ['plan']),
      ...edit(F, ['   ', 'real']),
    ]);
    expect(s.hunks.map((h) => h.lines)).toEqual([['real']]);
    expect(s.skipped).toEqual({ failed: 1, sessionState: 1, noMaterial: 0 });
  });

  it('diff が無ければ引数から作る(edit は old/new の差、create は全文)', () => {
    const s = extractAiChanges('s1', [
      start(),
      ...edit(F, [], [], { noDiff: true, args: { path: F, old_str: 'a\nb', new_str: 'a\nb2\nc' } }),
      ...edit(`${ROOT}\\new.ts`, [], [], { noDiff: true, tool: 'create', args: { path: `${ROOT}\\new.ts`, file_text: 'x\n\ny' } }),
    ]);
    expect(s.hunks.map((h) => [h.lines, h.from])).toEqual([
      [['b2', 'c'], 'args'],
      [['x', 'y'], 'args'],
    ]);
    expect(s.files.find((f) => f.path.endsWith('new.ts'))?.created).toBe(true);
  });

  it('apply_patch の本文(文字列の引数)から作る。消したファイルの行は数えない', () => {
    const patch = ['*** Begin Patch', `*** Add File: ${ROOT}\\p.ts`, '+p1', '*** Update File: src\\a.ts', '+u1', '*** End Patch'].join('\n');
    const del = ['*** Begin Patch', `*** Delete File: ${ROOT}\\p.ts`, '*** End Patch'].join('\n');
    const s = extractAiChanges('s1', [start(), ...edit('', [], [], { noDiff: true, tool: 'apply_patch', args: patch, min: 1 }), ...edit('', [], [], { noDiff: true, tool: 'apply_patch', args: del, min: 2 })]);
    expect(s.hunks.map((h) => [h.path, h.lines])).toEqual([[F, ['u1']]]);
    expect(s.files.find((f) => f.path.endsWith('p.ts'))).toMatchObject({ created: true, deleted: true });
  });

  it('材料の無い編集はまとまりを作らず、読めない引数は noMaterial に数える', () => {
    const s = extractAiChanges('s1', [start(), ...edit(F, [], [], { noDiff: true, args: { path: F } }), ...edit('', [], [], { noDiff: true, tool: 'apply_patch', args: { unknown: 1 } })]);
    expect(s.hunks).toEqual([]);
    expect(s.skipped.noMaterial).toBe(1);
  });

  it('イベントに無い作業フォルダは workspace.yaml から補い、出所を workspace にする', () => {
    const s = extractAiChanges('s1', [start({ cwd: ROOT })], { cwd: 'X:\\other', git_root: ROOT, branch: 'dev' });
    expect(s.context).toMatchObject({ cwd: ROOT, gitRoot: ROOT, branch: 'dev', headCommit: null });
    expect(s.context.sources).toEqual({ cwd: 'events', gitRoot: 'workspace', branch: 'workspace' });
  });
});

describe('レビューの指摘', () => {
  it('diff --git の無い複数ファイルの diff でも、--- / +++ のすぐ後に @@ が続くものは次のファイルとして読む', () => {
    const text = ['--- a/one.ts', '+++ b/one.ts', '@@ -1,1 +1,2 @@', ' x', '+in one', '--- a/two.ts', '+++ b/two.ts', '@@ -1,1 +1,2 @@', ' y', '+in two', ''].join('\n');
    const d = parseUnifiedDiff(text);
    expect(d.map((x) => [x.newPath, x.blocks])).toEqual([
      ['one.ts', [{ added: ['in one'], removed: [] }]],
      ['two.ts', [{ added: ['in two'], removed: [] }]],
    ]);
  });

  it('create でファイルを作り直したら、前に足した行は数えない(diff が無い引数だけのときも)', () => {
    const s = extractAiChanges('s1', [
      start(),
      ...edit(`${ROOT}\c.ts`, [], [], { noDiff: true, tool: 'create', args: { path: `${ROOT}\c.ts`, file_text: 'old one\nold two' }, min: 1 }),
      ...edit(`${ROOT}\c.ts`, [], [], { noDiff: true, tool: 'create', args: { path: `${ROOT}\c.ts`, file_text: 'new one' }, min: 2 }),
    ]);
    expect(s.hunks.map((h) => h.lines)).toEqual([['new one']]);
  });
});
