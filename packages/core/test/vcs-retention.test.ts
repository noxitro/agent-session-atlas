// AI の変更がその後の VCS のファイルに残っているか(vcs.ts / vcs-retention.ts)。
// git は一時フォルダに実際のリポジトリを作る。Perforce と SVN は偽の CLI(架空の版の履歴)で応答する。中身はすべて架空のもの
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractAiChanges } from '../src/ai-changes.ts';
import type { CopilotEvent } from '../src/types.ts';
import { assertReadOnly, type RunResult, type VcsRunner } from '../src/vcs.ts';
import { measureRetention, summarizeRetention } from '../src/vcs-retention.ts';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 1, h, m)).toISOString();
let callSeq = 0;

function diffOf(path: string, added: string[], removed: string[]): string {
  const p = path.replace(/\\/g, '/');
  return [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1,1 +1,1 @@', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ''].join('\n');
}

interface EditSpec {
  path: string;
  added: string[];
  removed?: string[];
  /** 時:分 */
  t?: [number, number];
}

/** セッションのイベントを作る(開始 → 編集 → 最後のイベント) */
function session(o: { cwd: string; gitRoot?: string | null; headCommit?: string | null; start: [number, number]; end: [number, number]; edits: EditSpec[] }): CopilotEvent[] {
  const ev: CopilotEvent[] = [
    { type: 'session.start', timestamp: at(...o.start), data: { context: { cwd: o.cwd, gitRoot: o.gitRoot ?? undefined, headCommit: o.headCommit ?? undefined } } },
  ];
  for (const e of o.edits) {
    const id = `c${++callSeq}`;
    const t = at(...(e.t ?? o.start));
    ev.push({ type: 'tool.execution_start', timestamp: t, data: { toolCallId: id, toolName: 'edit', arguments: { path: e.path, old_str: '', new_str: '' } } });
    ev.push({ type: 'tool.execution_complete', timestamp: t, data: { toolCallId: id, success: true, result: { content: 'ok', detailedContent: diffOf(e.path, e.added, e.removed ?? []) } } });
  }
  ev.push({ type: 'assistant.turn_end', timestamp: at(...o.end), data: {} });
  return ev;
}

let dirs: string[] = [];
function tmp(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'atlas-vcs-')));
  dirs.push(d);
  return d;
}
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const write = (path: string, lines: string[]) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
};

describe('assertReadOnly', () => {
  it.each([
    ['git', ['--no-optional-locks', '-C', 'x', 'show', 'HEAD:a']],
    ['git', ['-C', 'x', '-c', 'core.quotepath=false', 'rev-list', '-1', 'HEAD']],
    ['svn', ['--non-interactive', 'cat', '-r', '3', 'x']],
    ['p4', ['-d', 'x', '-q', 'print', 'x@3']],
    ['p4', ['-d', 'x', '-ztag', 'info']],
  ] as const)('読む系は通す: %s %j', (cmd, args) => {
    expect(() => assertReadOnly(cmd, [...args])).not.toThrow();
  });
  it.each([
    ['git', ['commit', '-m', 'x']],
    ['git', ['-C', 'x', 'checkout', 'HEAD']],
    ['git', ['-c', 'user.name=x', 'show', 'HEAD']],
    ['git', ['show', '--output=x', 'HEAD']],
    ['git', ['status']],
    ['svn', ['update']],
    ['svn', ['--non-interactive', 'revert', 'x']],
    ['p4', ['-d', 'x', 'sync']],
    ['p4', ['edit', 'x']],
    ['p4', []],
  ] as const)('書く系・知らないものは止める: %s %j', (cmd, args) => {
    expect(() => assertReadOnly(cmd, [...args])).toThrow();
  });
});

// ---- git(実際のリポジトリ) ----

function git(root: string, args: string[], date = at(9)): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'zz', GIT_AUTHOR_EMAIL: 'zz@example.invalid', GIT_COMMITTER_NAME: 'zz', GIT_COMMITTER_EMAIL: 'zz@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function gitRepo(files: Record<string, string[]>): { root: string; head: string } {
  const root = tmp();
  git(root, ['init', '-q', '-b', 'main']);
  for (const [rel, lines] of Object.entries(files)) write(join(root, rel), lines);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

describe('measureRetention(git)', () => {
  it('そのまま残る・直されて残る・未確認を分け、基準にあった行は数えない', async () => {
    const { root, head } = gitRepo({ 'src/a.ts': ['export const base = 1;', 'export const moved = 2;'] });
    const f = join(root, 'src', 'a.ts');
    const ev = session({
      cwd: root,
      gitRoot: root,
      headCommit: head,
      start: [10, 0],
      end: [11, 0],
      edits: [
        { path: f, added: ['export const keptA = 10;', 'export const keptB = 11;'], t: [10, 1] },
        { path: f, added: ['export function similar(value: number) { return value * 2; }'], t: [10, 2] },
        { path: f, added: ['export const goneAway = 99;'], t: [10, 3] },
        // 基準にもともとある行(移動しただけ)は数えない
        { path: f, added: ['export const moved = 2;'], t: [10, 4] },
      ],
    });
    // 照合時: 1 つ目はそのまま、2 つ目は少し直した、3 つ目は消した
    write(f, ['export const base = 1;', 'export const moved = 2;', 'export const keptA = 10;', 'export const keptB = 11;', 'export function similar(value: number) { return value * 3; }']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { now: () => new Date(at(12)) });
    expect(r).toMatchObject({ outcome: 'measured', vcs: 'git', baseline: { rev: head, source: 'observed' }, evaluated: { mode: 'worktree', rev: head, at: at(12) }, excludedHunks: 1 });
    expect(r.hunks.map((h) => h.status)).toEqual(['kept', 'modified', 'missing']);
    expect(r.counts).toEqual({ kept: 1, modified: 1, missing: 1, unattributable: 0 });
    expect(r.lines).toEqual({ kept: 2, modified: 1, missing: 1, unattributable: 0 });
    expect(r.provenance).toMatchObject({ aiChanges: 'events', baseline: 'observed' });
  });

  it('一部の行だけ残ったまとまりは「直されて残る」', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['first line kept', 'second line removed'] }] });
    write(f, ['base', 'first line kept']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.hunks[0]).toMatchObject({ status: 'modified', lines: { kept: 1, modified: 0, missing: 1 } });
  });

  it('同じ本文の行を 2 回足しても、照合時に 1 回しかなければ 1 行だけ残存', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['dup line'], t: [10, 1] }, { path: f, added: ['dup line'], t: [10, 2] }] });
    write(f, ['base', 'dup line']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.hunks.map((h) => h.status)).toEqual(['kept', 'missing']);
  });

  it('照合時にファイルが消えていれば未確認(照合はできている)', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai line'] }] });
    unlinkSync(f);
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r).toMatchObject({ outcome: 'measured', counts: { missing: 1 } });
  });

  it('AI が作った新しいファイル(基準に無い)も照合する', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'new', 'b.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['brand new'] }] });
    write(f, ['brand new']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.counts.kept).toBe(1);
  });

  it('committed では、コミットしていない変更を照合時に含めない', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['uncommitted'] }] });
    write(f, ['base', 'uncommitted']);
    const sets = [extractAiChanges('s1', ev)];
    expect((await measureRetention(sets, { mode: 'worktree' }))[0].counts.kept).toBe(1);
    const [c] = await measureRetention(sets, { mode: 'committed' });
    expect(c).toMatchObject({ counts: { missing: 1 }, evaluated: { mode: 'committed' } });
  });

  it('headCommit が無ければ、開始時刻から基準を推定し、推定と印を付ける', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    write(join(root, 'a.txt'), ['base', 'after session']);
    git(root, ['commit', '-q', '-am', 'later'], at(13));
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['after session'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r).toMatchObject({ baseline: { rev: head, source: 'estimated' }, provenance: { baseline: 'estimated' }, counts: { kept: 1 } });
    expect(summarizeRetention([r]).baselineEstimated).toBe(1);
  });

  it('記録された headCommit がもう無ければ、推定で置き換えず照合不可', async () => {
    const { root } = gitRepo({ 'a.txt': ['base'] });
    const ev = session({ cwd: root, gitRoot: root, headCommit: 'f'.repeat(40), start: [10, 0], end: [11, 0], edits: [{ path: join(root, 'a.txt'), added: ['x line'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r).toMatchObject({ outcome: 'unattributable', reason: 'baseline_missing', counts: { unattributable: 1 } });
  });

  it('作業フォルダがこの PC に無ければ照合不可(repo_not_found)', async () => {
    const gone = join(tmp(), 'gone', 'repo');
    const ev = session({ cwd: gone, gitRoot: gone, headCommit: 'abc', start: [10, 0], end: [11, 0], edits: [{ path: join(gone, 'a.txt'), added: ['x line'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r).toMatchObject({ outcome: 'unattributable', reason: 'repo_not_found', vcs: null });
  });

  it('VCS の管理下でなければ照合不可(no_vcs)', async () => {
    const plain = tmp();
    const ev = session({ cwd: plain, start: [10, 0], end: [11, 0], edits: [{ path: join(plain, 'a.txt'), added: ['x line'] }] });
    write(join(plain, 'a.txt'), ['x line']);
    const runner: VcsRunner = async (cmd) => ({ code: cmd === 'git' ? 128 : -1, stdout: '', stderr: 'not a repository' });
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect(r).toMatchObject({ outcome: 'unattributable', reason: 'no_vcs' });
  });

  it('リポジトリの外のファイルは、そのまとまりだけ照合不可(outside_repo)', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const plain = tmp();
    const ev = session({
      cwd: root,
      gitRoot: root,
      headCommit: head,
      start: [10, 0],
      end: [11, 0],
      edits: [
        { path: join(root, 'a.txt'), added: ['in repo'] },
        { path: join(plain, 'notes.txt'), added: ['outside'] },
      ],
    });
    write(join(root, 'a.txt'), ['base', 'in repo']);
    const runner: VcsRunner = async (cmd, args, opts) => (cmd === 'git' ? realGit(args, opts.cwd) : { code: -1, stdout: '', stderr: '' });
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect(r.outcome).toBe('measured');
    expect(r.hunks.map((h) => [h.status, h.reason])).toEqual([
      ['kept', undefined],
      ['unattributable', 'outside_repo'],
    ]);
  });

  it('二重計上を防ぐ: 後のセッションも同じ行を足したら後のセッションの分にし、時間が重なれば両方とも照合不可', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const s1 = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [10, 30], edits: [{ path: f, added: ['shared line', 'only s1'] }] });
    const s2 = session({ cwd: root, gitRoot: root, headCommit: head, start: [11, 0], end: [11, 30], edits: [{ path: f, added: ['shared line'], t: [11, 1] }] });
    write(f, ['base', 'shared line', 'only s1']);
    const [r1, r2] = await measureRetention([extractAiChanges('s1', s1), extractAiChanges('s2', s2)]);
    // s1 のまとまりは only s1 だけで判定する(shared line は後の s2 の分なので、s1 では照合不可の行に数える)
    expect(r1.hunks[0]).toMatchObject({ status: 'kept', lines: { kept: 1, unattributable: 1 } });
    expect(r2.hunks[0]).toMatchObject({ status: 'kept', lines: { kept: 1 } });
    const total = summarizeRetention([r1, r2]).lines;
    expect(total.kept).toBe(2); // shared line は 1 回だけ数える

    const s3 = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 10], end: [10, 40], edits: [{ path: f, added: ['shared line'], t: [10, 11] }] });
    const [a, , c] = await measureRetention([extractAiChanges('s1', s1), extractAiChanges('s2', s2), extractAiChanges('s3', s3)]);
    expect(a.hunks[0]).toMatchObject({ status: 'unattributable', reason: 'concurrent_session' });
    expect(c).toMatchObject({ outcome: 'unattributable', reason: 'concurrent_session' });
  });

  it('照合の範囲: 分母は照合できたセッションだけで、照合不可と AI の変更なしを分けて数える', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    write(f, ['base', 'kept line']);
    const gone = join(tmp(), 'gone');
    const sets = [
      extractAiChanges('ok', session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['kept line'] }] })),
      extractAiChanges('gone', session({ cwd: gone, start: [10, 0], end: [11, 0], edits: [{ path: join(gone, 'x.txt'), added: ['zz'] }] })),
      extractAiChanges('none', session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [] })),
    ];
    const s = summarizeRetention(await measureRetention(sets));
    expect(s).toMatchObject({ sessions: 3, withAiChanges: 2, measured: 1, unattributable: { repo_not_found: 1 }, hunks: { kept: 1, modified: 0, missing: 0, unattributable: 0 }, byVcs: { git: 1 } });
  });
});

function realGit(args: string[], cwd: string): RunResult {
  try {
    return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

// ---- SVN と Perforce(偽の CLI) ----

interface FakeRev {
  rev: number;
  at: string;
  /** root からの相対パス(/ 区切り) → 本文 */
  files: Record<string, string[]>;
}

/** 架空の版の履歴に、svn / p4 の読む系のコマンドだけで答える。呼ばれたコマンドは calls に残す */
function fakeVcs(kind: 'svn' | 'p4', root: string, revs: FakeRev[]) {
  const calls: { cmd: string; args: string[] }[] = [];
  const rel = (p: string) => relative(root, p).replace(/\\/g, '/');
  const revAt = (iso: string) => [...revs].reverse().find((r) => r.at <= iso);
  const content = (r: FakeRev | undefined, p: string): RunResult => {
    const lines = r?.files[rel(p)];
    if (lines) return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
    return kind === 'svn' ? { code: 1, stdout: '', stderr: `svn: E200009: '${p}' path not found` } : { code: 0, stdout: '', stderr: `${p} - no such file(s).` };
  };
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
  const runner: VcsRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git') return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    if (cmd !== kind) return { code: -1, stdout: '', stderr: `${cmd} が見つかりません` };
    const a = args.filter((x) => !['--non-interactive', '-q', '-ztag'].includes(x));
    if (a[0] === '-d') a.splice(0, 2);
    if (kind === 'svn') {
      if (a[0] === 'info' && a[2] === 'wc-root') return ok(root + '\n');
      if (a[0] === 'info' && a[2] === 'revision' && a[3] === '-r') {
        const r = revAt(a[4].slice(1, -1));
        return r ? ok(`${r.rev}\n`) : { code: 1, stdout: '', stderr: 'svn: E195012: no revision' };
      }
      if (a[0] === 'info' && a[2] === 'revision') return ok(`${revs[revs.length - 1].rev}\n`);
      if (a[0] === 'cat') return content(a[2] === 'BASE' ? revs[revs.length - 1] : revs.find((r) => String(r.rev) === a[2]), a[3]);
    } else {
      if (a[0] === 'info') return ok(`... clientName zz-ws\n... clientRoot ${root}\n`);
      if (a[0] === 'changes') {
        const spec = a[a.length - 1];
        let r: FakeRev | undefined;
        if (spec.endsWith('#have')) r = revs[revs.length - 1];
        else {
          const m = /@(\d+)\/(\d+)\/(\d+):(\d+):(\d+):(\d+)$/.exec(spec)!;
          r = revAt(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString());
        }
        return ok(r ? `Change ${r.rev} on 2026/11/01 by zz@zz-ws 'x'\n` : '');
      }
      if (a[0] === 'print') {
        const spec = a[1];
        const m = /^(.*)(?:@(\d+)|#have)$/.exec(spec)!;
        return content(m[2] ? revs.find((r) => String(r.rev) === m[2]) : revs[revs.length - 1], m[1]);
      }
    }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` };
  };
  return { runner, calls };
}

describe.each(['svn', 'p4'] as const)('measureRetention(%s。偽の CLI)', (kind) => {
  it('開始時刻から基準を推定し、残存・直されて残る・未確認を分ける', async () => {
    const root = tmp();
    const f = join(root, 'src', 'a.c');
    const { runner, calls } = fakeVcs(kind, root, [
      { rev: 7, at: at(8), files: { 'src/a.c': ['int base = 0;'] } },
      { rev: 9, at: at(12), files: { 'src/a.c': ['int base = 0;', 'int kept = 1;'] } },
    ]);
    const ev = session({
      cwd: root,
      start: [10, 0],
      end: [11, 0],
      edits: [
        { path: f, added: ['int kept = 1;'], t: [10, 1] },
        { path: f, added: ['int computeTotal(int a, int b) { return a + b; }'], t: [10, 2] },
        { path: f, added: ['int removedLater = 3;'], t: [10, 3] },
      ],
    });
    write(f, ['int base = 0;', 'int kept = 1;', 'int computeTotal(int a, int b) { return a + b + 1; }']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect(r).toMatchObject({ outcome: 'measured', vcs: kind, baseline: { rev: '7', source: 'estimated' }, evaluated: { rev: '9' } });
    expect(r.hunks.map((h) => h.status)).toEqual(['kept', 'modified', 'missing']);
    // 呼んだのは読む系だけ
    for (const c of calls) expect(() => assertReadOnly(c.cmd as 'svn', c.args)).not.toThrow();
  });

  it('committed では最後に取り込んだ版と比べる', async () => {
    const root = tmp();
    const f = join(root, 'a.c');
    const { runner } = fakeVcs(kind, root, [
      { rev: 1, at: at(8), files: { 'a.c': ['base'] } },
      { rev: 2, at: at(12), files: { 'a.c': ['base', 'submitted line'] } },
    ]);
    const ev = session({ cwd: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['submitted line', 'local only'] }] });
    write(f, ['base', 'local only']);
    const [w] = await measureRetention([extractAiChanges('s1', ev)], { runner, mode: 'worktree' });
    const [c] = await measureRetention([extractAiChanges('s1', ev)], { runner, mode: 'committed' });
    expect(w.hunks[0].lines).toMatchObject({ kept: 1, missing: 1 });
    expect(c.hunks[0].lines).toMatchObject({ kept: 1, missing: 1 });
    expect(c.hunks[0]).toMatchObject({ status: 'modified' });
  });

  it('開始時刻より前の版が無ければ照合不可(baseline_missing)。欠測として数え、未確認にはしない', async () => {
    const root = tmp();
    const f = join(root, 'a.c');
    const { runner } = fakeVcs(kind, root, [{ rev: 5, at: at(12), files: { 'a.c': ['x'] } }]);
    write(f, ['x']);
    const ev = session({ cwd: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai'] }] });
    const r = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect(r[0]).toMatchObject({ outcome: 'unattributable', reason: 'baseline_missing' });
    expect(summarizeRetention(r)).toMatchObject({ measured: 0, withAiChanges: 1, unattributable: { baseline_missing: 1 }, hunks: { missing: 0 } });
  });

  it('セッションをまたいで同じ版のファイルは 1 回だけ読む(結果は各セッションに同じように付く)', async () => {
    const root = tmp();
    const f = join(root, 'a.c');
    const { runner, calls } = fakeVcs(kind, root, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    write(f, ['base', 'line one', 'line two']);
    const s1 = session({ cwd: root, start: [10, 0], end: [10, 20], edits: [{ path: f, added: ['line one'] }] });
    const s2 = session({ cwd: root, start: [11, 0], end: [11, 20], edits: [{ path: f, added: ['line two'], t: [11, 1] }] });
    const rs = await measureRetention([extractAiChanges('a', s1), extractAiChanges('b', s2)], { runner });
    expect(rs.map((r) => [r.sessionId, r.outcome, r.counts.kept, r.baseline?.rev])).toEqual([
      ['a', 'measured', 1, '1'],
      ['b', 'measured', 1, '1'],
    ]);
    const reads = calls.filter((c) => c.args.includes(kind === 'svn' ? 'cat' : 'print'));
    expect(reads).toHaveLength(1);
  });

  it('二重計上を防ぎ、時間が重なるセッションの同じ行は照合不可にする', async () => {
    const root = tmp();
    const f = join(root, 'a.c');
    const { runner } = fakeVcs(kind, root, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    write(f, ['base', 'same line']);
    const early = session({ cwd: root, start: [10, 0], end: [10, 20], edits: [{ path: f, added: ['same line'] }] });
    const late = session({ cwd: root, start: [11, 0], end: [11, 20], edits: [{ path: f, added: ['same line'], t: [11, 1] }] });
    const [e, l] = await measureRetention([extractAiChanges('e', early), extractAiChanges('l', late)], { runner });
    expect(e).toMatchObject({ outcome: 'unattributable', reason: 'later_session' });
    expect(l).toMatchObject({ outcome: 'measured', counts: { kept: 1 } });

    const overlap = session({ cwd: root, start: [10, 10], end: [10, 30], edits: [{ path: f, added: ['same line'], t: [10, 11] }] });
    const rs = await measureRetention([extractAiChanges('e', early), extractAiChanges('o', overlap)], { runner });
    expect(rs.map((x) => x.reason)).toEqual(['concurrent_session', 'concurrent_session']);
    expect(summarizeRetention(rs).lines.kept).toBe(0);
  });
});
