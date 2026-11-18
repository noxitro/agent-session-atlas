// AI の変更がその後の VCS のファイルに残っているか(vcs.ts / vcs-retention.ts)。
// git は一時フォルダに実際のリポジトリを作る。Perforce と SVN は偽の CLI(架空の版の履歴)で応答する。中身はすべて架空のもの
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractAiChanges } from '../src/ai-changes.ts';
import type { CopilotEvent } from '../src/types.ts';
import { assertReadOnly, defaultRunner, p4Escape, p4ServerOffset, readOnlyRunner, vcsEnv, type RunResult, type VcsRunner } from '../src/vcs.ts';
import { measureRetention, sameRevision, summarizeRetention } from '../src/vcs-retention.ts';

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
    // ファイルに書き出す(-o)
    ['p4', ['-d', 'x', '-q', 'print', '-o', 'out.txt', 'x@3']],
    ['p4', ['-d', 'x', '-q', 'print', '-oout.txt', 'x@3']],
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
    // JSON のキーの順(画面の lib/retention.ts が読む形)。照合したときに VCS で見た版には source を付けない
    const v = JSON.parse(JSON.stringify(r));
    expect(Object.keys(v)).toEqual(['sessionId', 'outcome', 'vcs', 'root', 'baseline', 'evaluated', 'hunks', 'excludedHunks', 'counts', 'lines', 'provenance', 'sessionEnd']);
    expect(Object.keys(v.evaluated)).toEqual(['mode', 'rev', 'at']);
    // 出所(どのツールの呼び出しの、ログのどこから取った変更か)を添える。似た本文で当てた行は推定として別に数える
    expect(Object.keys(v.hunks[0])).toEqual(['id', 'path', 'status', 'lines', 'at', 'toolCallId', 'from']);
    expect([v.hunks[0].from, typeof v.hunks[0].toolCallId]).toEqual(['diff', 'string']);
    expect(Object.keys(v.hunks[1])).toEqual(['id', 'path', 'status', 'lines', 'at', 'similarLines', 'toolCallId', 'from']);
    expect([r.hunks[0].similarLines, r.hunks[1].similarLines]).toEqual([undefined, 1]);
    const s = summarizeRetention([r]);
    expect([s.similarLines, s.excludedHunks, s.evaluatedEstimated, s.unreadEdits]).toEqual([1, 1, undefined, undefined]);
    expect(Object.keys(s)).toEqual(['sessions', 'withAiChanges', 'measured', 'unattributable', 'baselineEstimated', 'hunks', 'lines', 'byVcs', 'excludedHunks', 'similarLines']);
  });

  it('基準にもある本文でも、新しく足した分(増えた分)は数える。消されていれば未確認', async () => {
    const { root, head } = gitRepo({ 'a.ts': ['function a() {', '  return null;', '}'] });
    const f = join(root, 'a.ts');
    const ev = session({
      cwd: root,
      gitRoot: root,
      headCommit: head,
      start: [10, 0],
      end: [11, 0],
      edits: [
        { path: f, added: ['function b() {', '  return null;', '}'], t: [10, 1] },
        { path: f, added: ['function c() {', '  return null;', '}'], t: [10, 2] },
      ],
    });
    // b は残し、c は消した。return null; と } は基準にもあるが、b の分だけ増えている
    write(f, ['function a() {', '  return null;', '}', 'function b() {', '  return null;', '}']);
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.hunks.map((h) => [h.status, h.lines.kept, h.lines.missing])).toEqual([
      ['kept', 3, 0],
      ['missing', 0, 1],
    ]);
    // c の return null; と } は、照合時に増えた行に当たらず、基準にある本文なので数えない
    expect(r.lines).toMatchObject({ kept: 3, missing: 1 });
  });

  it('推定の基準は、セッションのブランチの履歴で探す(今の HEAD が別のブランチでも)', async () => {
    const { root } = gitRepo({ 'a.txt': ['base'] });
    git(root, ['checkout', '-q', '-b', 'feat/x']);
    write(join(root, 'a.txt'), ['base', 'on feature branch']);
    git(root, ['commit', '-q', '-am', 'feature'], at(9, 30));
    const feat = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-q', 'main']);
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai line here'] }] });
    ev[0].data.context.branch = 'feat/x';
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.baseline).toEqual({ rev: feat, source: 'estimated' });
    // 名前が素直でないブランチ(引数として読まれうるもの)は使わず、HEAD で探す
    const ev2 = session({ cwd: root, gitRoot: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai line here'] }] });
    ev2[0].data.context.branch = '--output=x';
    const [r2] = await measureRetention([extractAiChanges('s2', ev2)]);
    expect(r2.baseline?.rev).toBe(git(root, ['rev-parse', 'main']));
  });

  it('時間の重なる別のセッションと、短いありふれた行だけが同じなら、照合不可にしない', async () => {
    const { root, head } = gitRepo({ 'a.ts': ['base'] });
    const f = join(root, 'a.ts');
    const a = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['export const fromA = 1;', '}'] }] });
    const b = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 30], end: [11, 30], edits: [{ path: f, added: ['export const fromB = 2;', '}'] }] });
    write(f, ['base', 'export const fromA = 1;', '}', 'export const fromB = 2;', '}']);
    const [ra, rb] = await measureRetention([extractAiChanges('a', a), extractAiChanges('b', b)]);
    expect(ra.hunks[0]).toMatchObject({ status: 'kept', lines: { kept: 2, unattributable: 0 } });
    expect(rb.hunks[0]).toMatchObject({ status: 'kept', lines: { kept: 2, unattributable: 0 } });
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
    // 開始時から何も取り込んでいなければ、比べる版が基準と同じなので照合不可(見つからないに数えない)
    expect(c).toMatchObject({ outcome: 'unattributable', reason: 'no_commits', counts: { missing: 0, unattributable: 1 }, evaluated: { mode: 'committed' } });
    expect(summarizeRetention([c]).unattributable).toEqual({ no_commits: 1 });
    // 別のファイルだけを取り込んだ後なら、取り込まれていない AI の行は見つからない
    write(join(root, 'other.txt'), ['other']);
    git(root, ['add', 'other.txt'], at(12));
    git(root, ['commit', '-q', '-m', 'other'], at(12));
    const [c2] = await measureRetention(sets, { mode: 'committed' });
    expect(c2).toMatchObject({ outcome: 'measured', counts: { missing: 1 }, evaluated: { mode: 'committed' } });
  });

  it('fixed でも、比べる版が開始時の基準と同じなら照合不可(no_commits)。推定の基準でも同じで、worktree はディスクと比べる', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['never committed'] }] });
    write(f, ['base', 'never committed']);
    const sets = [extractAiChanges('s1', ev)];
    const now = () => new Date(at(24 * 20));
    const [r] = await measureRetention(sets, { mode: 'fixed', lagDays: 7, now });
    expect(r).toMatchObject({ outcome: 'unattributable', reason: 'no_commits' });
    expect(r.hunks[0].reason).toBe('no_commits');
    // 推定の基準(headCommit の記録が無い)でも同じ
    const ev2 = session({ cwd: root, gitRoot: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['never committed'] }] });
    const [r2] = await measureRetention([extractAiChanges('s2', ev2)], { mode: 'fixed', lagDays: 7, now });
    expect(r2).toMatchObject({ outcome: 'unattributable', reason: 'no_commits' });
    // worktree は今のまま(ディスクのファイルと比べる)
    const [w] = await measureRetention(sets, { now });
    expect(w).toMatchObject({ outcome: 'measured', counts: { kept: 1 } });
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

/**
 * 架空の版の履歴に、svn / p4 の読む系のコマンドだけで答える。呼ばれたコマンドは calls に残す。
 * tzMin: p4 の日時指定(@2026/11/01:19:00:00)を、UTC から tzMin 分ずれた地方時として読む(サーバの地方時を真似る)
 */
function fakeVcs(kind: 'svn' | 'p4', root: string, revs: FakeRev[], tzMin = 0) {
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
    const ztag = args.includes('-ztag');
    const a = args.filter((x) => !['--non-interactive', '-q', '-ztag'].includes(x));
    if (a[0] === '-d') a.splice(0, 2);
    if (kind === 'svn') {
      if (a[0] === 'info' && a[2] === 'wc-root') return ok(root + '\n');
      if (a[0] === 'info' && a[2] === 'revision' && a[3] === '-r') {
        const r = revAt(a[4].slice(1, -1));
        return r ? ok(`${r.rev}\n`) : { code: 1, stdout: '', stderr: 'svn: E195012: no revision' };
      }
      if (a[0] === 'info' && a[2] === 'revision') return ok(`${revs[revs.length - 1].rev}\n`);
      // 実物の svn と同じく、パスの末尾の @(空の peg 版)は外して読む
      if (a[0] === 'cat') {
        expect(a[3].endsWith('@')).toBe(true);
        return content(a[2] === 'BASE' ? revs[revs.length - 1] : revs.find((r) => String(r.rev) === a[2]), a[3].slice(0, -1));
      }
    } else {
      if (a[0] === 'info') return ok(`... clientName zz-ws\n... clientRoot ${root}\n`);
      if (a[0] === 'changes') {
        const spec = a[a.length - 1];
        const change = (r: FakeRev | undefined) => ok(r ? `Change ${r.rev} on 2026/11/01 by zz@zz-ws 'x'\n` : '');
        if (spec.endsWith('#have')) return change(revs[revs.length - 1]);
        // 地方時の日時を UTC の ISO に
        const dates = [...spec.matchAll(/@(\d+)\/(\d+)\/(\d+):(\d+):(\d+):(\d+)/g)].map((m) => new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tzMin * 60_000).toISOString());
        if (dates.length === 2) {
          // 範囲(@a,@b)は -ztag で、取り込んだ時刻(UTC の秒)つき。新しい順
          expect(ztag).toBe(true);
          const [from, to] = dates;
          return ok(
            [...revs]
              .reverse()
              .filter((r) => r.at >= from && r.at <= to)
              .map((r) => `... change ${r.rev}\n... time ${Date.parse(r.at) / 1000}\n... user zz\n\n`)
              .join(''),
          );
        }
        return change(revAt(dates[0]));
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

    // committed で、今の版の印が基準と同じとき。p4 は取り込みが無いので照合不可(no_commits)。
    // svn の印は作業コピーのルートの版で、ファイルを取り込んでも進まないので、この判定をせず BASE を読んで照合する
    const root2 = tmp();
    const f2 = join(root2, 'a.c');
    const { runner: r2 } = fakeVcs(kind, root2, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    const ev2 = session({ cwd: root2, start: [10, 0], end: [11, 0], edits: [{ path: f2, added: ['local only'] }] });
    write(f2, ['base', 'local only']);
    const [same] = await measureRetention([extractAiChanges('s1', ev2)], { runner: r2, mode: 'committed' });
    if (kind === 'svn') expect(same).toMatchObject({ outcome: 'measured', counts: { missing: 1 } });
    else expect(same).toMatchObject({ outcome: 'unattributable', reason: 'no_commits', counts: { missing: 0 } });
    if (kind === 'svn') expect(same.reason).toBeUndefined();
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

describe('VCS に渡すもの', () => {
  it('p4Escape: p4 のファイル指定で特別な文字を逃がす(% を先に)', () => {
    expect(p4Escape('/w/img@2x.png')).toBe('/w/img%402x.png');
    expect(p4Escape('/w/C#notes 100%*.md')).toBe('/w/C%23notes 100%25%2A.md');
  });
  it('vcsEnv: メッセージだけ英語にし、文字の扱いは利用者のものを残す(LC_ALL を外して LC_CTYPE に移す)', () => {
    const e = vcsEnv({ LC_ALL: 'ja_JP.UTF-8', PATH: '/bin' });
    expect(e.LC_ALL).toBeUndefined();
    expect(e).toMatchObject({ LC_CTYPE: 'ja_JP.UTF-8', LC_MESSAGES: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', PATH: '/bin' });
    expect(vcsEnv({ LANG: 'en_US.UTF-8' }).LC_CTYPE).toBe('en_US.UTF-8');
    expect(vcsEnv({}).LC_CTYPE).toBeUndefined();
  });
});

describe('比べる版: セッションの終わりから決まった日数後(fixed)', () => {
  it('その時点で取り込まれていた版と比べる(後から消されても、その時点で残っていれば残る)。日数が経っていなければ照合しない', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai line that stays a while'] }] });
    // 翌日に取り込み、10 日後に消した
    write(f, ['base', 'ai line that stays a while']);
    git(root, ['commit', '-q', '-am', 'take ai line'], at(24 + 10));
    write(f, ['base']);
    git(root, ['commit', '-q', '-am', 'remove ai line'], at(24 * 10 + 10));
    const set = extractAiChanges('s1', ev);
    const [worktree] = await measureRetention([set], { now: () => new Date(at(24 * 20)) });
    expect(worktree.hunks[0].status).toBe('missing');
    const [fixed] = await measureRetention([set], { mode: 'fixed', lagDays: 7, now: () => new Date(at(24 * 20)) });
    expect(fixed).toMatchObject({ outcome: 'measured', evaluated: { mode: 'fixed', at: at(11 + 24 * 7) }, sessionEnd: at(11, 0) });
    expect(fixed.hunks[0].status).toBe('kept');
    // fixed の版は日時から推定したもの。今の版を見る worktree には印を付けない
    expect(fixed.evaluated?.source).toBe('estimated');
    expect(summarizeRetention([fixed]).evaluatedEstimated).toBe(1);
    expect(worktree.evaluated?.source).toBeUndefined();
    expect('source' in JSON.parse(JSON.stringify(worktree)).evaluated).toBe(false);
    // セッションの終わりから 3 日しか経っていなければ、照合しない
    const [early] = await measureRetention([set], { mode: 'fixed', lagDays: 7, now: () => new Date(at(24 * 3)) });
    expect(early).toMatchObject({ outcome: 'unattributable', reason: 'too_recent', evaluated: null });
  });

  it('ログから変更を取り出せなかった編集の数を残す', async () => {
    const { root, head } = gitRepo({ 'a.txt': ['base'] });
    const ev = session({ cwd: root, gitRoot: root, headCommit: head, start: [10, 0], end: [11, 0], edits: [] });
    ev.push({ type: 'tool.execution_start', timestamp: at(10, 5), data: { toolCallId: 'odd', toolName: 'apply_patch', arguments: { unknown: 1 } } });
    ev.push({ type: 'tool.execution_complete', timestamp: at(10, 5), data: { toolCallId: 'odd', success: true, result: { content: 'ok' } } });
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r).toMatchObject({ outcome: 'no_ai_changes', unreadEdits: 1 });
    // AI の変更を取り出せなかったセッションの読めない編集も、集計に残す(記録の欠けを隠さない)
    expect(summarizeRetention([r])).toMatchObject({ withAiChanges: 0, unreadEdits: 1, unreadSessions: 1 });
  });

  it('作業フォルダに VCS が無く、ファイルの場所のリポジトリだけで照合したときも、比べた時点と見方を残す(版の印は付けない)', async () => {
    const plain = tmp();
    const { root } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    write(f, ['base', 'ai line']);
    git(root, ['commit', '-q', '-am', 'take ai line'], at(24));
    const ev = session({ cwd: plain, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai line'] }] });
    const sets = [extractAiChanges('s1', ev)];
    const now = () => new Date(at(24 * 20));
    const [w] = await measureRetention(sets, { now });
    expect([w.outcome, w.vcs, w.evaluated]).toEqual(['measured', null, { mode: 'worktree', rev: null, at: at(24 * 20) }]);
    const [fx] = await measureRetention(sets, { mode: 'fixed', lagDays: 7, now });
    expect([fx.outcome, fx.hunks[0].status]).toEqual(['measured', 'kept']);
    expect(fx.evaluated).toEqual({ mode: 'fixed', rev: null, at: at(11 + 24 * 7), source: 'estimated' });
    expect(summarizeRetention([fx]).evaluatedEstimated).toBe(1);
  });
});

describe('版の印と、版を調べるコマンドの失敗', () => {
  it('sameRevision: git は短い印(7 字以上)でも前方が一致すれば同じ。svn・p4 は同じ文字列だけ', () => {
    const full = '0123456789abcdef0123456789abcdef01234567';
    expect(sameRevision('git', full, full)).toBe(true);
    expect(sameRevision('git', '0123456', full)).toBe(true);
    expect(sameRevision('git', full.toUpperCase(), full)).toBe(true);
    expect(sameRevision('git', '012345', full)).toBe(false); // 短すぎる印は同じとみなさない
    expect(sameRevision('git', '', full)).toBe(false);
    expect(sameRevision('svn', '7', ' 7')).toBe(true);
    expect(sameRevision('p4', '7', '70')).toBe(false);
  });

  it('理由の無い照合不可は unknown として数える(読めなかったとは決めつけない)', async () => {
    const gone = join(tmp(), 'gone');
    const ev = session({ cwd: gone, start: [10, 0], end: [11, 0], edits: [{ path: join(gone, 'x.txt'), added: ['zz'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)]);
    expect(r.outcome).toBe('unattributable');
    delete r.reason;
    expect(summarizeRetention([r]).unattributable).toEqual({ unknown: 1 });
  });

  it('今の版・開始時の版を調べるコマンドが失敗したら、版が無いではなく読めなかった(read_error)', async () => {
    // committed で今の版を調べる p4 changes が失敗
    const root = tmp();
    const f = join(root, 'a.c');
    const p4 = fakeVcs('p4', root, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    const failHave: VcsRunner = async (cmd, args, opts) =>
      args.includes('changes') && args[args.length - 1].endsWith('#have') ? { code: 1, stdout: '', stderr: 'Perforce client error: connect failed' } : p4.runner(cmd, args, opts);
    write(f, ['base', 'ai']);
    const ev = session({ cwd: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner: failHave, mode: 'committed' });
    expect(r).toMatchObject({ outcome: 'unattributable', reason: 'read_error' });

    // 開始時の版の推定(svn info -r {日時})が失敗
    const root2 = tmp();
    const f2 = join(root2, 'a.c');
    const svn = fakeVcs('svn', root2, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    const failDate: VcsRunner = async (cmd, args, opts) =>
      args.includes('-r') && args.some((a) => a.startsWith('{')) ? { code: 1, stdout: '', stderr: 'svn: E170013: Unable to connect to a repository' } : svn.runner(cmd, args, opts);
    write(f2, ['base', 'ai']);
    const ev2 = session({ cwd: root2, start: [10, 0], end: [11, 0], edits: [{ path: f2, added: ['ai'] }] });
    const [r2] = await measureRetention([extractAiChanges('s1', ev2)], { runner: failDate });
    expect(r2).toMatchObject({ outcome: 'unattributable', reason: 'read_error' });
  });

  it.each([
    ['open for read: zz.p4tickets: No such file or directory', 'read_error'],
    ['//zz/... - no such file(s).', 'baseline_missing'],
  ] as const)('環境の失敗を版が無いと取り違えない。「その版・変更が無い」と答えたときだけ baseline_missing: %s', async (stderr, want) => {
    const root = tmp();
    const f = join(root, 'a.c');
    const p4 = fakeVcs('p4', root, [{ rev: 1, at: at(8), files: { 'a.c': ['base'] } }]);
    const runner: VcsRunner = async (cmd, args, opts) => (args.includes('changes') && !args[args.length - 1].endsWith('#have') ? { code: 1, stdout: '', stderr } : p4.runner(cmd, args, opts));
    write(f, ['base', 'ai']);
    const ev = session({ cwd: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect(r).toMatchObject({ outcome: 'unattributable', reason: want });
  });

  it('git: ログの開始時のコミットが無ければ baseline_missing、確かめるコマンドが失敗したら読めなかった', async () => {
    const { root } = gitRepo({ 'a.txt': ['base'] });
    const f = join(root, 'a.txt');
    write(f, ['base', 'ai']);
    const ev = session({ cwd: root, gitRoot: root, headCommit: '0123456789abcdef0123456789abcdef01234567', start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai'] }] });
    const sets = [extractAiChanges('s1', ev)];
    expect((await measureRetention(sets))[0].reason).toBe('baseline_missing');
    const timeout: VcsRunner = async (cmd, args, opts) => (args.includes('cat-file') ? { code: 1, stdout: '', stderr: 'git が時間内に終わりませんでした' } : defaultRunner(cmd, args, opts));
    expect((await measureRetention(sets, { runner: timeout }))[0].reason).toBe('read_error');
  });
});

describe('読み取り専用の確認と、p4 のサーバの時差', () => {
  it('書く系のコマンドは呼ぶ前に止める。readOnlyRunner は差し替えた runner を呼ばず、既定の runner は直接呼ばれても起動しない', async () => {
    // 止まらなかったときに備えて、空の一時フォルダで呼ぶ
    const empty = tmp();
    let called = 0;
    const counting: VcsRunner = async () => (called++, { code: 0, stdout: '', stderr: '' });
    for (const [kind, args] of [
      ['git', ['commit', '-m', 'x']],
      ['svn', ['update']],
      ['p4', ['print', '-o', 'out.txt', '//d/a.c']],
    ] as const) {
      expect(() => readOnlyRunner(counting)(kind, [...args], { cwd: empty })).toThrow();
      const r = await defaultRunner(kind, [...args], { cwd: empty });
      expect([r.code, r.stdout]).toEqual([1, '']);
      expect(r.stderr).toContain('止めました');
    }
    expect(called).toBe(0);
  });

  it('p4ServerOffset: p4 info の serverDate から UTC からのずれ(分)を読む', () => {
    expect(p4ServerOffset('... serverDate 2026/11/01 19:00:00 +0900 JST\n')).toBe(540);
    expect(p4ServerOffset('... clientName zz\n... serverDate 2026/11/01 05:00:00 -0500 EST\n')).toBe(-300);
    expect(p4ServerOffset('... clientName zz\n')).toBeNull();
  });

  // サーバの時差(p4 info の serverDate)で日時を直し、取り込んだ時刻で確かめる。
  // 照合したときの時差と、セッションのころの時差(夏時間)が 1 時間違っても、開始時刻 10:00(UTC)の直前の版 2 を基準にする
  async function baseOf(nowMin: number, thenMin: number, timeless: boolean): Promise<{ rev: string | undefined; specs: string[] }> {
    const root = tmp();
    const f = join(root, 'a.c');
    const revs: FakeRev[] = [
      { rev: 1, at: at(8), files: { 'a.c': ['old'] } },
      { rev: 2, at: at(9, 30), files: { 'a.c': ['base'] } },
      { rev: 3, at: at(10, 30), files: { 'a.c': ['base', 'later'] } },
    ];
    const { runner: inner, calls } = fakeVcs('p4', root, revs, thenMin);
    const abs = Math.abs(nowMin);
    const date = `... serverDate 2026/11/01 19:00:00 ${nowMin < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')} ZZ\n`;
    const runner: VcsRunner = async (cmd, args, opts) => {
      const r = await inner(cmd, args, opts);
      if (cmd === 'p4' && args[args.length - 1] === 'info') r.stdout += date;
      // 取り込んだ時刻を出さないサーバを真似る
      if (timeless) r.stdout = r.stdout.split('\n').filter((l) => !l.startsWith('... time ')).join('\n');
      return r;
    };
    write(f, ['base', 'ai']);
    const ev = session({ cwd: root, start: [10, 0], end: [11, 0], edits: [{ path: f, added: ['ai'] }] });
    const [r] = await measureRetention([extractAiChanges('s1', ev)], { runner });
    expect([r.outcome, r.counts.kept]).toEqual(['measured', 1]);
    return { rev: r.baseline?.rev, specs: calls.filter((c) => c.args.includes('changes')).map((c) => c.args[c.args.length - 1]) };
  }

  it('p4 の日時はサーバの時差で直し、前後 1 時間の変更を取り込んだ時刻で確かめる(夏時間で時差が変わっても版を取り違えない)', async () => {
    const same = await baseOf(540, 540, false);
    expect(same.rev).toBe('2');
    // UTC の 10:00 はサーバの 19:00。前後 1 時間を範囲で読む
    expect(same.specs.some((s) => s.endsWith('@2026/11/01:18:00:00,@2026/11/01:20:00:00'))).toBe(true);
    // 時差だけで決めると、+0900 → +1000 では 9:00 の版 1、+1000 → +0900 では 11:00 の版 3 になる
    expect((await baseOf(540, 600, false)).rev).toBe('2');
    expect((await baseOf(600, 540, false)).rev).toBe('2');
    // 取り込んだ時刻を読めなければ確かめず、時差だけで決めた日時(サーバの 19:00)で探す。窓の前(18:00)の版 1 にはしない
    const timeless = await baseOf(540, 540, true);
    expect(timeless.rev).toBe('2');
    expect(timeless.specs.some((s) => s.endsWith('...@2026/11/01:19:00:00'))).toBe(true);
  });
});

// ---- 実物の svn(ローカルのリポジトリ。svn が無ければ飛ばす) ----

const hasSvn = (() => {
  try {
    execFileSync('svn', ['--version', '--quiet'], { stdio: 'ignore' });
    execFileSync('svnadmin', ['--version', '--quiet'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSvn)('measureRetention(実物の svn。ローカルのリポジトリ)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('開始時刻から基準を推定し、出所を残す。取り込んだ後の committed は作業コピーの BASE と比べる', async () => {
    const repo = tmp();
    const wc = tmp();
    execFileSync('svnadmin', ['create', repo]);
    const p = repo.replace(/\\/g, '/');
    const url = p.startsWith('/') ? `file://${p}` : `file:///${p}`;
    // 準備の書き込みは svn を直接呼ぶ(atlas の実行経路は書く系を止める)
    const svn = (...args: string[]) => execFileSync('svn', ['--non-interactive', '-q', ...args], { encoding: 'utf8' });
    svn('checkout', url, wc);
    const f = join(wc, 'src', 'a.c');
    write(f, ['int base = 0;']);
    svn('add', join(wc, 'src'));
    svn('commit', '-m', 'base', wc);
    // 取り込んだだけでは作業コピーの根の版は 0 のまま(版の混ざった作業コピー)なので、普段どおり更新しておく
    svn('update', wc);
    await sleep(1100);

    const start = new Date().toISOString();
    const ev: CopilotEvent[] = [{ type: 'session.start', timestamp: start, data: { context: { cwd: wc } } }];
    for (const [id, added] of [
      ['k', 'int kept = 1;'],
      ['m', 'int computeTotal(int a, int b) { return a + b; }'],
      ['x', 'int removedLater = 3;'],
    ]) {
      const t = new Date().toISOString();
      ev.push({ type: 'tool.execution_start', timestamp: t, data: { toolCallId: id, toolName: 'edit', arguments: { path: f, old_str: '', new_str: '' } } });
      ev.push({ type: 'tool.execution_complete', timestamp: t, data: { toolCallId: id, success: true, result: { content: 'ok', detailedContent: diffOf(f, [added], []) } } });
    }
    await sleep(50);
    ev.push({ type: 'assistant.turn_end', timestamp: new Date().toISOString(), data: {} });
    write(f, ['int base = 0;', 'int kept = 1;', 'int computeTotal(int a, int b) { return a + b + 1; }']);
    const sets = [extractAiChanges('s1', ev)];

    const [r] = await measureRetention(sets);
    expect(r).toMatchObject({ outcome: 'measured', vcs: 'svn', baseline: { rev: '1', source: 'estimated' } });
    expect(r.reason).toBeUndefined();
    expect(r.hunks.map((h) => h.status)).toEqual(['kept', 'modified', 'missing']);
    expect(r.hunks.map((h) => [h.similarLines ?? 0, h.toolCallId, h.from])).toEqual([
      [0, 'k', 'diff'],
      [1, 'm', 'diff'],
      [0, 'x', 'diff'],
    ]);
    expect([r.evaluated?.rev, r.evaluated?.source]).toEqual(['1', undefined]);

    // 取り込んだ後の committed は、作業コピーの BASE(取り込んだ本文)と比べる
    await sleep(1100);
    svn('commit', '-m', 'take', wc);
    write(f, ['int base = 0;']);
    const [c] = await measureRetention(sets, { mode: 'committed' });
    expect(c.outcome).toBe('measured');
    expect(c.reason).toBeUndefined();
    expect(c.hunks.map((h) => h.status)).toEqual(['kept', 'modified', 'missing']);
    // 作業コピーの今の本文(AI の行を消した)では見つからない
    const [w] = await measureRetention(sets);
    expect(w.hunks.map((h) => h.status)).toEqual(['missing', 'missing', 'missing']);
  }, 60_000);
});
