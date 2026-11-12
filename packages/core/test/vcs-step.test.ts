// 照合の段(vcs-step.ts): パスの読み替え・スナップショットからの照合・アップロード先での送った側の結果の読み込み。
// git は一時フォルダに実際のリポジトリを作る。イベントとパスはすべて架空のもの
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_MANIFEST, UPLOAD_VCS_META } from '../src/snapshot.ts';
import { sessionsTable, retentionHunksTable } from '../src/tables.ts';
import { applyPathMap, mapPath, parseSenderVcs, runVcsStep, senderVcsJson } from '../src/vcs-step.ts';
import { extractAiChanges } from '../src/ai-changes.ts';
import type { SessionRecord } from '../src/types.ts';

const B = '\\';
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 1, h, m)).toISOString();

let dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'atlas-vcsstep-')));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function git(root: string, args: string[]): string {
  const date = at(9);
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'zz', GIT_AUTHOR_EMAIL: 'zz@example.invalid', GIT_COMMITTER_NAME: 'zz', GIT_COMMITTER_EMAIL: 'zz@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

/** 1 セッション分の events.jsonl(開始 → 編集 1 回 → 終わり) */
function eventsJsonl(o: { cwd: string; headCommit?: string; path: string; added: string[] }): string {
  const p = o.path.replace(/\\/g, '/');
  const diff = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1,1 +1,2 @@', ...o.added.map((l) => `+${l}`), ''].join('\n');
  const ev = [
    { type: 'session.start', timestamp: at(10), data: { context: { cwd: o.cwd, gitRoot: o.cwd, ...(o.headCommit ? { headCommit: o.headCommit } : {}) } } },
    { type: 'tool.execution_start', timestamp: at(10, 5), data: { toolCallId: 'c1', toolName: 'edit', arguments: { path: o.path, old_str: '', new_str: o.added.join('\n') } } },
    { type: 'tool.execution_complete', timestamp: at(10, 5), data: { toolCallId: 'c1', success: true, result: { content: 'ok', detailedContent: diff } } },
    { type: 'assistant.turn_end', timestamp: at(10, 30), data: {} },
  ];
  return ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function writeSession(snap: string, id: string, jsonl: string, extra: Record<string, string> = {}): void {
  const dir = join(snap, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), jsonl);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
}

describe('mapPath / applyPathMap', () => {
  const map = [
    { from: `X:${B}old`, to: `Y:${B}new` },
    { from: `X:${B}old${B}deep`, to: `Z:${B}deep` },
    { from: '/home/zz/old', to: '/srv/new' },
  ];
  it('前方一致で読み替える。Windows のパスは大文字小文字と区切りの違いを無視し、長い from を優先する', () => {
    expect(mapPath(`x:/OLD/src/a.ts`, map)).toBe(`Y:${B}new${B}src${B}a.ts`);
    expect(mapPath(`X:${B}old${B}deep${B}b.ts`, map)).toBe(`Z:${B}deep${B}b.ts`);
    expect(mapPath(`X:${B}old`, map)).toBe(`Y:${B}new`);
    expect(mapPath('/home/zz/old/x/y.ts', map)).toBe('/srv/new/x/y.ts');
  });
  it('読み替え先を / で書いても、ログのパスと同じ形(\\ 区切り)にそろえる(同じファイルの鍵が一致するように)', () => {
    const slash = [{ from: `X:${B}old`, to: 'y:/new/' }];
    expect(mapPath(`X:${B}old${B}src${B}a.ts`, slash)).toBe(`Y:${B}new${B}src${B}a.ts`);
    expect(mapPath(`X:${B}old`, slash)).toBe(`Y:${B}new`);
    expect(mapPath('/home/zz/old/x/../y.ts', [{ from: '/home/zz/old', to: '/srv/new//' }])).toBe('/srv/new/y.ts');
  });
  it('名前の途中で切れる一致や、当たらないものは読み替えない', () => {
    expect(mapPath(`X:${B}older${B}a.ts`, map)).toBeNull();
    expect(mapPath('/home/zz/OLD/a.ts', map)).toBeNull(); // POSIX は大文字小文字を区別する
    expect(mapPath(`W:${B}a.ts`, map)).toBeNull();
  });
  it('作業フォルダ・ファイル・まとまりのパスを読み替え、読み替えたかを返す', () => {
    const set = extractAiChanges('s', [
      { type: 'session.start', timestamp: at(10), data: { context: { cwd: `X:${B}old`, gitRoot: `X:${B}old` } } },
      { type: 'tool.execution_start', timestamp: at(10), data: { toolCallId: 'c', toolName: 'create', arguments: { path: `X:${B}old${B}a.ts`, file_text: 'x' } } },
      { type: 'tool.execution_complete', timestamp: at(10), data: { toolCallId: 'c', success: true, result: { content: 'ok' } } },
    ]);
    const { set: m, mapped } = applyPathMap(set, map);
    expect(mapped).toBe(true);
    expect([m.context.cwd, m.context.gitRoot, m.files[0].path, m.hunks[0].path]).toEqual([`Y:${B}new`, `Y:${B}new`, `Y:${B}new${B}a.ts`, `Y:${B}new${B}a.ts`]);
    expect(applyPathMap(set, []).mapped).toBe(false);
  });
});

describe('runVcsStep(この PC の記録)', () => {
  it('ログのパスのリポジトリを照合する。移したリポジトリは pathMap で読み替えると照合できる', async () => {
    const repo = tmp();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.ts'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.ts'), 'base\nconst kept = 1;\n');
    const snap = tmp();
    // ログには前の場所(今は無い)が残っている
    const old = join(tmp(), 'moved-away');
    writeSession(snap, 'sess-a', eventsJsonl({ cwd: old, headCommit: head, path: join(old, 'a.ts'), added: ['const kept = 1;', 'const gone = 2;'] }));
    writeSession(snap, 'sess-b', [JSON.stringify({ type: 'session.start', timestamp: at(8), data: { context: { cwd: repo } } })].join('\n') + '\n');

    const before = await runVcsStep(snap, { now: () => new Date(at(12)) });
    expect(before).toMatchObject({ schemaVersion: 1, computedOn: 'local', mode: 'worktree', pathMap: 0, generatedAt: at(12) });
    expect(before.sessions.map((s) => [s.sessionId, s.outcome, s.reason ?? null])).toEqual([
      ['sess-a', 'unattributable', 'repo_not_found'],
      ['sess-b', 'no_ai_changes', null],
    ]);

    const after = await runVcsStep(snap, { pathMap: [{ from: old, to: repo }] });
    const a = after.sessions.find((s) => s.sessionId === 'sess-a')!;
    expect(a).toMatchObject({ outcome: 'measured', vcs: 'git', baseline: { rev: head, source: 'observed' }, pathMapped: true, computedOn: 'local' });
    expect(a.hunks.map((h) => [h.status, h.lines])).toEqual([['modified', { kept: 1, modified: 0, missing: 1, unattributable: 0 }]]);
    expect(after.summary).toMatchObject({ sessions: 2, withAiChanges: 1, measured: 1 });
  });

  it('ids を渡したらそのセッションだけ', async () => {
    const snap = tmp();
    writeSession(snap, 'x1', eventsJsonl({ cwd: join(tmp(), 'nope'), path: join(tmp(), 'nope', 'a.ts'), added: ['a'] }));
    writeSession(snap, 'x2', eventsJsonl({ cwd: join(tmp(), 'nope'), path: join(tmp(), 'nope', 'a.ts'), added: ['a'] }));
    const r = await runVcsStep(snap, { ids: new Set(['x2']) });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['x2']);
  });
});

describe('runVcsStep(アップロード先から集計し直したとき)', () => {
  const resultOf = (id: string) => ({
    sessionId: id,
    outcome: 'measured',
    vcs: 'p4',
    root: '//depot/zz',
    baseline: { rev: '41', source: 'estimated' },
    evaluated: { mode: 'worktree', rev: '42', at: at(11) },
    hunks: [
      { id: 1, path: `X:${B}zz${B}a.cpp`, status: 'kept', lines: { kept: 3, modified: 0, missing: 0, unattributable: 0 } },
      { id: 2, path: `X:${B}zz${B}b.cpp`, status: 'missing', lines: { kept: 0, modified: 0, missing: 2, unattributable: 0 } },
    ],
    excludedHunks: 0,
    // 書いてある件数は信じない(まとまりから数え直す)
    counts: { kept: 99, modified: 0, missing: 0, unattributable: 0 },
    lines: { kept: 99, modified: 0, missing: 0, unattributable: 0 },
    provenance: { aiChanges: 'events', baseline: 'estimated', context: {} },
  });

  it('ディスクは読まず、送った側の結果を読む。無いセッションは「送った側で照合していない」', async () => {
    const snap = tmp();
    writeFileSync(join(snap, SNAPSHOT_MANIFEST), JSON.stringify({ layout: 'flat' }));
    // 送り先の PC に、ログと同じパスのリポジトリがあっても読まない(sess-2 は送った側の結果が無い)
    const local = tmp();
    git(local, ['init', '-q', '-b', 'main']);
    writeSession(snap, 'sess-1', eventsJsonl({ cwd: local, path: join(local, 'a.ts'), added: ['x'] }), {
      [UPLOAD_VCS_META]: JSON.stringify({ version: 1, sessionId: 'sess-1', computedAt: at(11), mode: 'worktree', result: resultOf('sess-1') }),
    });
    writeSession(snap, 'sess-2', eventsJsonl({ cwd: local, path: join(local, 'a.ts'), added: ['x', 'y'] }));
    writeSession(snap, 'sess-3', [JSON.stringify({ type: 'session.start', timestamp: at(8), data: {} })].join('\n') + '\n');
    const r = await runVcsStep(snap);
    expect(r.computedOn).toBe('sender');
    const [s1, s2, s3] = r.sessions;
    expect(s1).toMatchObject({ outcome: 'measured', vcs: 'p4', baseline: { source: 'estimated' }, computedOn: 'sender', counts: { kept: 1, missing: 1 }, lines: { kept: 3, missing: 2 } });
    expect(s2).toMatchObject({ outcome: 'unattributable', reason: 'not_measured', vcs: null, counts: { unattributable: 1 }, lines: { unattributable: 2 } });
    // どこでも照合していないので、照合した場所は付けない(「送った側の PC で照合」と読めないように)
    expect(s2.computedOn).toBeUndefined();
    expect(s3.outcome).toBe('no_ai_changes');
    expect(r.summary).toMatchObject({ withAiChanges: 2, measured: 1, unattributable: { not_measured: 1 }, baselineEstimated: 1, byVcs: { p4: 1 } });
  });

  it('照合した日時と見方は送った側のもの(この PC で集計した日時・既定の見方で上書きしない)', async () => {
    const snap = tmp();
    writeFileSync(join(snap, SNAPSHOT_MANIFEST), JSON.stringify({ layout: 'flat' }));
    const committed = { ...resultOf('c1'), evaluated: { mode: 'committed', rev: '42', at: at(7) } };
    // セッションの記録に作業後の状態が無いものは、添えたファイルの日時と見方を使う
    const bare = { ...resultOf('c2'), evaluated: null };
    writeSession(snap, 'c1', eventsJsonl({ cwd: tmp(), path: 'X:/zz/a.cpp', added: ['x'] }), { [UPLOAD_VCS_META]: JSON.stringify({ version: 1, sessionId: 'c1', computedAt: at(7), mode: 'committed', result: committed }) });
    writeSession(snap, 'c2', eventsJsonl({ cwd: tmp(), path: 'X:/zz/a.cpp', added: ['x'] }), { [UPLOAD_VCS_META]: JSON.stringify({ version: 1, sessionId: 'c2', computedAt: at(9), mode: 'committed', result: bare }) });
    writeSession(snap, 'c3', eventsJsonl({ cwd: tmp(), path: 'X:/zz/a.cpp', added: ['x'] }));
    const r = await runVcsStep(snap, { now: () => new Date(at(20)), mode: 'worktree' });
    expect(r).toMatchObject({ computedOn: 'sender', generatedAt: at(20), mode: 'committed', senders: { sessions: 2, from: at(7), to: at(9), modes: { committed: 2 } } });
    expect(r.sessions.find((s) => s.sessionId === 'c2')!.evaluated).toEqual({ mode: 'committed', rev: null, at: at(9) });
    // 送った側の結果が 1 つも無ければ senders は null、見方は指定のまま
    const none = tmp();
    writeFileSync(join(none, SNAPSHOT_MANIFEST), JSON.stringify({ layout: 'flat' }));
    writeSession(none, 'n1', eventsJsonl({ cwd: tmp(), path: 'X:/zz/a.cpp', added: ['x'] }));
    expect(await runVcsStep(none, { mode: 'worktree' })).toMatchObject({ senders: null, mode: 'worktree' });
    // この PC で照合したときは senders を付けない
    const localSnap = tmp();
    writeSession(localSnap, 'l1', eventsJsonl({ cwd: join(tmp(), 'gone'), path: join(tmp(), 'gone', 'a.ts'), added: ['x'] }));
    expect((await runVcsStep(localSnap)).senders).toBeUndefined();
  });

  it('まとまりの状態と行の内訳が食い違うもの・同じ番号のまとまりが 2 つあるものは使わない', () => {
    const ok = { version: 1, sessionId: 's', computedAt: at(11), mode: 'worktree', result: resultOf('s') };
    const h0 = resultOf('s').hunks[0];
    const withHunks = (hunks: unknown[]) => ({ ...ok, result: { ...resultOf('s'), hunks } });
    // 「未変更で残存」なのに行は未確認だけ
    expect(parseSenderVcs(withHunks([{ ...h0, lines: { kept: 0, modified: 0, missing: 5, unattributable: 0 } }]), 's')).toBeNull();
    // 「照合不能」なのに残った行がある
    expect(parseSenderVcs(withHunks([{ ...h0, status: 'unattributable', reason: 'no_vcs' }]), 's')).toBeNull();
    // 行が 1 つも無い
    expect(parseSenderVcs(withHunks([{ ...h0, lines: { kept: 0, modified: 0, missing: 0, unattributable: 0 } }]), 's')).toBeNull();
    expect(parseSenderVcs(withHunks([h0, { ...h0, path: 'X:/zz/c.cpp' }]), 's')).toBeNull();
    // 一部だけ残ったものは「変更後に残存」
    expect(parseSenderVcs(withHunks([{ ...h0, status: 'modified', lines: { kept: 1, modified: 0, missing: 1, unattributable: 0 } }]), 's')?.counts.modified).toBe(1);
  });

  it('送った側の結果は形を確かめる(ほかのセッションのもの・知らない状態・制御文字を含むパスは使わない)', () => {
    const ok = { version: 1, sessionId: 's', computedAt: at(11), mode: 'worktree', result: resultOf('s') };
    expect(parseSenderVcs(ok, 's')?.outcome).toBe('measured');
    expect(parseSenderVcs(ok, 'other')).toBeNull();
    expect(parseSenderVcs({ ...ok, version: 2 }, 's')).toBeNull();
    expect(parseSenderVcs({ ...ok, result: { ...resultOf('s'), hunks: [{ ...resultOf('s').hunks[0], status: 'rejected' }] } }, 's')).toBeNull();
    expect(parseSenderVcs({ ...ok, result: { ...resultOf('s'), hunks: [{ ...resultOf('s').hunks[0], path: 'a\u202eb' }] } }, 's')).toBeNull();
    expect(parseSenderVcs({ ...ok, result: { ...resultOf('s'), hunks: [{ ...resultOf('s').hunks[0], lines: { kept: -1, modified: 0, missing: 0, unattributable: 0 } }] } }, 's')).toBeNull();
    // 知らない VCS の名前は null にして使う
    expect(parseSenderVcs({ ...ok, result: { ...resultOf('s'), vcs: 'cvs' } }, 's')?.vcs).toBeNull();
  });

  it('送る側の中身(senderVcsJson)は、そのまま読み戻せる', async () => {
    const snap = tmp();
    const repo = tmp();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.ts'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.ts'), 'base\nnew line here\n');
    writeSession(snap, 'sx', eventsJsonl({ cwd: repo, headCommit: head, path: join(repo, 'a.ts'), added: ['new line here'] }));
    const local = await runVcsStep(snap);
    const back = parseSenderVcs(JSON.parse(senderVcsJson(local.sessions[0], local)), 'sx');
    expect(back).toMatchObject({ outcome: 'measured', vcs: 'git', baseline: { rev: head, source: 'observed' }, counts: local.sessions[0].counts, lines: local.sessions[0].lines, computedOn: 'sender' });
  });
});

describe('表(sessions の照合の列・まとまりの表)', () => {
  const rec = (id: string): SessionRecord =>
    ({
      id,
      name: null,
      project: 'p',
      client: null,
      branch: null,
      createdAt: at(10),
      updatedAt: at(11),
      durationMs: 0,
      activeMs: 0,
      turns: 1,
      assistantMessages: 1,
      models: [],
      tokens: { input: 0, output: 0, nanoAiu: 0, premiumRequests: 0 },
      tools: { total: 1, byName: { edit: 1 } },
      friction: { toolFailures: 0, aborts: 0, errors: 0, subagentFailures: 0, compactions: 0 },
      firstUserMessage: 'x',
      empty: false,
    }) as unknown as SessionRecord;

  it('照合の結果を渡したときだけ列を足し、照合していないセッションは空、AI の変更なしは件数を空にする', () => {
    const measured = parseSenderVcs({ version: 1, sessionId: 'a', computedAt: at(11), mode: 'worktree', result: { sessionId: 'a', outcome: 'measured', vcs: 'git', root: 'r', baseline: { rev: 'h', source: 'observed' }, evaluated: null, hunks: [{ id: 1, path: 'f', status: 'kept', lines: { kept: 2, modified: 0, missing: 0, unattributable: 0 } }], excludedHunks: 0 } }, 'a')!;
    const none = { ...measured, sessionId: 'b', outcome: 'no_ai_changes' as const, hunks: [], counts: { kept: 0, modified: 0, missing: 0, unattributable: 0 } };
    const without = sessionsTable([rec('a')]);
    expect(without.header).not.toContain('VCS の照合');
    const t = sessionsTable([rec('a'), rec('b'), rec('c')], new Map(), new Map([['a', measured], ['b', none]]));
    const col = (name: string) => t.header.indexOf(name);
    expect(t.header[t.header.length - 1]).toBe('最初の依頼(先頭)');
    expect(t.rows.map((r) => r[col('VCS の照合')])).toEqual(['照合できた', 'AI の変更なし', null]);
    expect(t.rows.map((r) => r[col('未変更で残存(まとまり)')])).toEqual([1, null, null]);
    expect(t.rows.map((r) => r[col('未変更で残存(行)')])).toEqual([2, null, null]);
    expect(t.rows[0][col('開始時の基準')]).toBe('観測');
    expect(t.rows[0][col('照合した場所')]).toBe('送った側の PC');
    const h = retentionHunksTable([measured]);
    expect(h.rows).toEqual([['a', 1, 'f', '未変更で残存', '', 'git', '観測', 2, 0, 0, 0]]);
    // 照合した場所の無いもの(送った側の結果が無かった)は「照合していない」
    const { computedOn: _c, ...notMeasured } = { ...measured, sessionId: 'c', outcome: 'unattributable' as const, reason: 'not_measured' as const };
    const t2 = sessionsTable([rec('c')], new Map(), new Map([['c', notMeasured]]));
    expect(t2.rows[0][t2.header.indexOf('照合した場所')]).toBe('照合していない');
  });
});
