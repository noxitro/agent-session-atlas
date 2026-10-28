import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshot } from '../src/snapshot.ts';
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

  it('元ディレクトリが無ければ例外', async () => {
    await expect(snapshot(join(tmpdir(), 'atlas-no-such-dir-xyz'), join(tmpdir(), 'atlas-x'))).rejects.toThrow(/元ディレクトリが無い/);
  });
});
