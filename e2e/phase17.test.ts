// AI の変更がその後の VCS のファイルに残っているか(atlas vcs)を、架空の ~/.copilot と一時フォルダの git リポジトリで通しで確かめる。
//  a. all が vcs を通し、out/vcs-retention.json・sessions.csv の列・vcs-hunks.csv・atlas.sqlite・レポートの埋め込みと詳細ページの節ができる
//  b. 作業フォルダを移したセッションは照合不可(作業フォルダがこの PC に無い)になり、設定の vcs.pathMap で読み替えると照合できる
//  c. VCS は読むだけ(照合の前後でリポジトリの状態が変わらない)
// ログ・パス・本文はすべて架空のもの
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEmbedded } from '../packages/report/src/lib/embed.ts';
import type { ReportData } from '../packages/report/src/lib/types.ts';
import { ROOT, cliCommand } from './fixture-home.ts';
import type { VcsRetentionFile } from './output-types.ts';
import { openReadOnly } from './sqlite.ts';

const WORK = join(ROOT, 'out', 'e2e-phase17');
const HOME = join(WORK, 'copilot-home');
const OUT = join(WORK, 'out');
const NOTES = join(WORK, 'notes');
const REPO = join(WORK, 'repo');
const MOVED_FROM = join(WORK, 'old-place', 'repo');
const S_HERE = '00000000-0000-4000-8000-000000170001';
const S_MOVED = '00000000-0000-4000-8000-000000170002';
const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 9, m)).toISOString();

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'zz', GIT_AUTHOR_EMAIL: 'zz@example.invalid', GIT_COMMITTER_NAME: 'zz', GIT_COMMITTER_EMAIL: 'zz@example.invalid', GIT_AUTHOR_DATE: at(0), GIT_COMMITTER_DATE: at(0) },
  }).trim();
}

function atlas(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(...cliCommand(args), { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** 1 セッション分のログ(依頼 → 編集 1 回 → 応答) */
async function writeSession(id: string, cwd: string, head: string, file: string, added: string[]): Promise<void> {
  const dir = join(HOME, 'session-state', id);
  await mkdir(dir, { recursive: true });
  const p = file.replace(/\\/g, '/');
  const diff = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1,1 +1,3 @@', ' base', ...added.map((l) => `+${l}`), ''].join('\n');
  const ev = [
    { type: 'session.start', timestamp: at(10), data: { sessionId: id, context: { cwd, gitRoot: cwd, branch: 'main', headCommit: head } } },
    { type: 'user.message', timestamp: at(11), data: { content: '関数を足して' } },
    { type: 'tool.execution_start', timestamp: at(12), data: { toolCallId: 'c1', toolName: 'edit', arguments: { path: file, old_str: 'base', new_str: ['base', ...added].join('\n') } } },
    { type: 'tool.execution_complete', timestamp: at(12), data: { toolCallId: 'c1', success: true, result: { content: 'ok', detailedContent: diff } } },
    { type: 'assistant.message', timestamp: at(13), data: { content: '足しました' } },
    { type: 'assistant.turn_end', timestamp: at(14), data: {} },
  ];
  await writeFile(join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${JSON.stringify(cwd)}\n`);
}

let head = '';
beforeAll(async () => {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  await writeFile(join(REPO, 'a.ts'), 'base\n');
  await writeFile(join(REPO, 'b.ts'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  head = git(['rev-parse', 'HEAD']);
  // 照合時: a.ts は AI の 2 行のうち 1 行が残り、1 行は直されている。b.ts は AI の行が残っていない
  await writeFile(join(REPO, 'a.ts'), 'base\nexport const kept = 1;\nexport const tuned = 20;\n');
  await writeFile(join(REPO, 'b.ts'), 'base\nsomething else\n');
  await writeSession(S_HERE, REPO, head, join(REPO, 'a.ts'), ['export const kept = 1;', 'export const tuned = 2;']);
  // ログには前の置き場所が残っている(今は無い)
  await writeSession(S_MOVED, MOVED_FROM, head, join(MOVED_FROM, 'b.ts'), ['export function gone() {}']);
});

afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

describe('Phase 17: AI の変更の残存(VCS)', () => {
  it('a. all が照合し、JSON・表・SQLite・レポートに出す。c. リポジトリの状態は変えない', async () => {
    const before = { status: git(['status', '--porcelain']), index: await readFile(join(REPO, '.git', 'index')) };
    const r = atlas(['all', '--home', HOME, '--out', OUT, '--notes-dir', NOTES]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/vcs: AI の変更があったセッション 2 \/ 2 件、照合できた 1 件/);
    expect(git(['status', '--porcelain'])).toBe(before.status);
    expect((await readFile(join(REPO, '.git', 'index'))).equals(before.index)).toBe(true);

    const v = JSON.parse(await readFile(join(OUT, 'vcs-retention.json'), 'utf8')) as VcsRetentionFile;
    expect(v).toMatchObject({ schemaVersion: 1, computedOn: 'local', mode: 'worktree', summary: { sessions: 2, withAiChanges: 2, measured: 1, unattributable: { repo_not_found: 1 } } });
    const here = v.sessions.find((s) => s.sessionId === S_HERE)!;
    expect(here).toMatchObject({ outcome: 'measured', vcs: 'git', baseline: { rev: head, source: 'observed' } });
    expect(here.hunks.map((h) => [h.status, h.lines])).toEqual([['modified', { kept: 1, modified: 1, missing: 0, unattributable: 0 }]]);

    const csv = (await readFile(join(OUT, 'tables', 'sessions.csv'), 'utf8')).replace(/^﻿/, '').split('\r\n');
    const header = csv[0].split(',');
    const row = csv.find((l) => l.startsWith(S_HERE))!.split(',');
    expect(row[header.indexOf('VCS の照合')]).toBe('照合できた');
    expect(row[header.indexOf('開始時の基準')]).toBe('記録');
    expect(row[header.indexOf('直されて残る(まとまり)')]).toBe('1');
    expect(existsSync(join(OUT, 'tables', 'vcs-hunks.csv'))).toBe(true);
    const db = await openReadOnly(join(OUT, 'tables', 'atlas.sqlite'));
    try {
      expect(db.prepare('select "セッションID" id, "状態" st from vcs_hunks order by 1').all().map((x) => ({ ...x }))).toEqual([
        { id: S_HERE, st: '直されて残る' },
        { id: S_MOVED, st: '照合不可' },
      ]);
    } finally {
      db.close();
    }

    const data = extractEmbedded<ReportData>(await readFile(join(OUT, 'atlas.html'), 'utf8'));
    expect(data.retention).toMatchObject({ computedOn: 'local', mode: 'worktree', sessions: 2 });
    expect(data.sessions.find((s) => s.id === S_HERE)?.retention).toMatchObject({ outcome: 'measured', baseline: 'observed', hunks: [0, 1, 0, 0] });
    expect(data.sessions.find((s) => s.id === S_MOVED)?.retention).toMatchObject({ outcome: 'unattributable', reason: 'repo_not_found' });
    const detail = await readFile(join(OUT, 'sessions', `${S_HERE}.html`), 'utf8');
    expect(detail).toContain('AI の変更の残存(VCS)');
    expect(detail).toContain('a.ts');
  });

  it('b. 設定の vcs.pathMap で前の置き場所を読み替えると照合できる', async () => {
    const config = join(WORK, 'atlas.config.json');
    await writeFile(config, JSON.stringify({ vcs: { pathMap: [{ from: MOVED_FROM, to: REPO }] } }));
    const r = atlas(['vcs', '--out', OUT, '--config', config]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/照合できた 2 件/);
    expect(r.out).toMatch(/パスの読み替え 1 件/);
    const v = JSON.parse(await readFile(join(OUT, 'vcs-retention.json'), 'utf8')) as VcsRetentionFile;
    expect(v.sessions.find((s) => s.sessionId === S_MOVED)).toMatchObject({ outcome: 'measured', pathMapped: true, counts: { missing: 1 } });
  });
});
