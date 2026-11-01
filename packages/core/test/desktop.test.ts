// Phase 11: data.db を資格情報に触れずに読む(許可リストの列だけ。開かない表。immutable で開き -shm を作らない)
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_ALLOWLIST, DESKTOP_FORBIDDEN_TABLES, desktopForSession, readDesktopDb } from '../src/desktop.ts';
import { openWritable } from '../src/sqlite.ts';

const SECRET = ['ghp', 'UNITFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01'].join('_'); // トークンの形をソースに直書きしない
const SID = '00000000-0000-4000-8000-000000000001';

describe('readDesktopDb', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-desktop-'));
    path = join(dir, 'data.db');
    const db = await openWritable(path);
    db.exec(`
CREATE TABLE accounts (id TEXT, access_token TEXT);
CREATE TABLE settings (id INTEGER, github_access_token TEXT);
CREATE TABLE sessions (id TEXT, title TEXT, model TEXT, remote_connect_target TEXT, created_at TEXT);
CREATE TABLE session_context_usage (id INTEGER, session_id TEXT, ts_ms INTEGER, current_tokens INTEGER, token_limit INTEGER);
CREATE TABLE workspaces (id TEXT, project_id TEXT, session_id TEXT, name TEXT, session_bootstrap_config TEXT);
CREATE TABLE projects (id TEXT, name TEXT, setup_script TEXT);
CREATE TABLE unrelated_table (x TEXT);
`);
    db.prepare('INSERT INTO accounts VALUES (?,?)').run('a', SECRET);
    db.prepare('INSERT INTO settings VALUES (?,?)').run(1, SECRET);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(SID, 'title 1', 'claude-opus-5.5', `ssh://${SECRET}`, '2026-10-01T00:00:00Z');
    db.prepare('INSERT INTO session_context_usage VALUES (?,?,?,?,?)').run(1, SID, 1, 100, 1000);
    db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run('ws', 'p', SID, 'ws name', SECRET);
    db.prepare('INSERT INTO projects VALUES (?,?,?)').run('p', 'proj', SECRET);
    db.prepare('INSERT INTO unrelated_table VALUES (?)').run(SECRET);
    db.close();
    await rm(`${path}-shm`, { force: true });
    await rm(`${path}-wal`, { force: true });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('許可リストの列だけを読み、資格情報の表と列は値を読まない。許可リストに無い列が無くても落ちない。-shm / -wal を作らない', async () => {
    const before = await stat(path);
    const d = await readDesktopDb(path);
    expect(d).not.toBeNull();
    const json = JSON.stringify(d);
    expect(json).not.toContain(SECRET);
    expect(d!.tables.accounts).toBeUndefined();
    expect(d!.tables.settings).toBeUndefined();
    expect(d!.coverage.forbidden).toMatchObject({ accounts: expect.any(String), settings: expect.any(String) });
    expect(d!.coverage.forbidden.app_state).toBeUndefined(); // 無い表は出さない
    expect(d!.coverage.otherTables).toEqual(['unrelated_table']);
    // sessions: 許可列(title / model / created_at)は読み、無い列は null、許可外(remote_connect_target)は名前だけ
    const s = d!.tables.sessions[0];
    expect(s).toMatchObject({ id: SID, title: 'title 1', model: 'claude-opus-5.5', created_at: '2026-10-01T00:00:00Z', mode: null, total_input_tokens: null });
    expect(Object.keys(s).sort()).toEqual([...DESKTOP_ALLOWLIST.sessions].sort());
    expect(d!.coverage.tables.sessions).toEqual({ allowed: ['id', 'title', 'model', 'created_at'], unlisted: ['remote_connect_target'], rows: 1 });
    expect(d!.coverage.tables.workspaces.unlisted).toEqual(['session_bootstrap_config']);
    expect(d!.coverage.tables.projects.unlisted).toEqual(['setup_script']);
    expect(d!.wal).toMatchObject({ bytes: 0, mtime: null });
    // 元に触れない(mtime、-shm / -wal を作らない)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(dir)).sort()).toEqual(['data.db']);
    expect(existsSync(`${path}-shm`)).toBe(false);
    // セッション単位の束ね
    const info = desktopForSession(d!, SID)!;
    expect(info.session?.title).toBe('title 1');
    expect(info.contextUsage).toHaveLength(1);
    expect(info.workspace?.name).toBe('ws name');
    expect(info.project?.name).toBe('proj');
    expect(desktopForSession(d!, 'nope')).toBeNull();
    expect(JSON.stringify(info)).not.toContain(SECRET);
  });

  it('無ければ null、壊れていれば warnings(落とさない)', async () => {
    expect(await readDesktopDb(join(dir, 'none.db'))).toBeNull();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not a database');
    const d = await readDesktopDb(path);
    expect(d!.warnings.length).toBeGreaterThan(0);
    expect(Object.keys(DESKTOP_FORBIDDEN_TABLES)).toContain('accounts');
  });
});
