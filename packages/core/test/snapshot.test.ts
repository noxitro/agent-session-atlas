import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshot, SNAPSHOT_CONCURRENCY } from '../src/snapshot.ts';
import { openReadOnly, openWritable } from '../src/sqlite.ts';

async function mtimes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name)] = (await stat(join(e.parentPath, e.name))).mtimeMs;
  }
  return out;
}

describe('snapshot', () => {
  it('WAL にだけある行も複製し、元のファイルの mtime を変えない。since で古いセッションを除く', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atlas-snap-'));
    const src = join(base, 'src');
    const dest = join(base, 'dest');
    await mkdir(join(src, 'session-state', 'new'), { recursive: true });
    await mkdir(join(src, 'session-state', 'old'), { recursive: true });
    await mkdir(join(src, 'session-state', 'empty', 'files'), { recursive: true });
    await writeFile(join(src, 'session-state', 'new', 'events.jsonl'), '{"type":"x"}\n');
    await writeFile(join(src, 'session-state', 'new', 'workspace.yaml'), 'id: new\n');
    await writeFile(join(src, 'session-state', 'old', 'events.jsonl'), '{"type":"x"}\n');
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(join(src, 'session-state', 'old', 'events.jsonl'), past, past);

    const w = await openWritable(join(src, 'session-store.db'));
    w.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('a'),('b');");
    try {
      expect(existsSync(join(src, 'session-store.db-wal'))).toBe(true);
      const before = await mtimes(src);
      const m = await snapshot(src, dest, { since: '2025-01-01T00:00:00Z' });
      const after = await mtimes(src);
      expect(after).toEqual(before);

      expect(m.sessions).toMatchObject({ dirs: 1, skippedBySince: 1, copiedFiles: 2 });
      expect(existsSync(join(dest, 'session-state', 'old'))).toBe(false);
      expect(existsSync(join(dest, 'session-state', 'empty'))).toBe(false);
      const r = await openReadOnly(join(dest, 'session-store.db'));
      expect((r.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(2);
      expect((r.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
      r.close();

      // 2 回目は変わっていないファイルを再利用する
      const m2 = await snapshot(src, dest, { since: '2025-01-01T00:00:00Z' });
      expect(m2.sessions).toMatchObject({ copiedFiles: 0, reusedFiles: 2 });
    } finally {
      w.close();
    }
  });

  it('data.db(資格情報列を含む)は複製せず、以前のバージョンが残した複製は消す', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atlas-snap-'));
    const src = join(base, 'src');
    const dest = join(base, 'dest');
    await mkdir(join(src, 'session-state'), { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(join(src, 'data.db'), 'not read');
    await writeFile(join(dest, 'data.db'), 'stale copy');
    const before = await mtimes(src);
    const m = await snapshot(src, dest);
    expect(await mtimes(src)).toEqual(before);
    expect(existsSync(join(dest, 'data.db'))).toBe(false);
    expect(Object.keys(m.databases)).not.toContain('data.db');
  });

  it('session-store.db を複製できなくても全体は止めず、前回の複製を残して理由を manifest に書く', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atlas-snap-'));
    const src = join(base, 'src');
    const dest = join(base, 'dest');
    await mkdir(join(src, 'session-state', 's1'), { recursive: true });
    await writeFile(join(src, 'session-state', 's1', 'events.jsonl'), '{"type":"x"}\n');
    const w = await openWritable(join(src, 'session-store.db'));
    w.exec("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('a');");
    w.close();
    expect((await snapshot(src, dest)).databases['session-store.db']).toMatchObject({ copied: true });
    // 元が SQLite として読めなくなった(書きかけ・壊れた)
    await writeFile(join(src, 'session-store.db'), 'x'.repeat(4096));
    const m = await snapshot(src, dest);
    expect(m.databases['session-store.db']).toMatchObject({ copied: false });
    expect(m.databases['session-store.db'].error).toBeTruthy();
    expect(m.databases['session-store.db'].bytes).toBeGreaterThan(0);
    expect(m.sessions.dirs).toBe(1);
    const r = await openReadOnly(join(dest, 'session-store.db'));
    expect((r.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    r.close();
    expect(existsSync(join(dest, '.tmp-sqlite'))).toBe(false);
  });

  it('並べて写しても、件数・session.db・写さなかったものの順は 1 件ずつ写したときと同じで、一時フォルダを残さない', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atlas-snap-'));
    const src = join(base, 'src');
    const dest = join(base, 'dest');
    // 並べる数(SNAPSHOT_CONCURRENCY)より多いセッション。3 件おきに session.db、5 件おきに写さない名前のフォルダを置く
    const ids = Array.from({ length: SNAPSHOT_CONCURRENCY * 3 + 5 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    for (const [i, id] of ids.entries()) {
      const dir = join(src, 'session-state', id);
      await mkdir(join(dir, 'files'), { recursive: true });
      await writeFile(join(dir, 'events.jsonl'), `{"type":"x","i":${i}}\n`);
      await writeFile(join(dir, 'files', 'a.txt'), id);
      if (i % 3 === 0) {
        const db = await openWritable(join(dir, 'session.db'));
        db.exec(`CREATE TABLE todos(id TEXT); INSERT INTO todos VALUES ('${id}');`);
        db.close();
      }
      if (i % 5 === 0) await mkdir(join(dir, 'unknown-dir'));
    }
    const m = await snapshot(src, dest);
    expect(m.sessions).toMatchObject({ dirs: ids.length, copiedFiles: ids.length, dbCopied: ids.filter((_, i) => i % 3 === 0).length });
    expect(m.extras?.sessionFiles).toBe(ids.length);
    expect(m.extras?.skipped.map((s) => s.path)).toEqual(ids.filter((_, i) => i % 5 === 0).map((id) => `session-state/${id}/unknown-dir`));
    expect((await readdir(dest)).filter((n) => n.startsWith('.tmp-sqlite'))).toEqual([]);
    const r = await openReadOnly(join(dest, 'session-state', ids[3], 'session.db'));
    expect((r.prepare('SELECT id FROM todos').get() as { id: string }).id).toBe(ids[3]);
    r.close();
    const again = await snapshot(src, dest);
    expect(again.sessions).toMatchObject({ copiedFiles: 0, reusedFiles: ids.length, dbCopied: 0, dbReused: ids.filter((_, i) => i % 3 === 0).length });
  });

  it('元ディレクトリが無ければ例外', async () => {
    await expect(snapshot(join(tmpdir(), 'atlas-no-such-dir-xyz'), join(tmpdir(), 'atlas-x'))).rejects.toThrow(/元ディレクトリが無い/);
  });
});
