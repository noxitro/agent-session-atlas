// atlas open --pick(open-folder.bat): フォルダを選ぶ画面で選んだフォルダを開く。取り消したら何も書かない
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCli } from '../src/args.ts';
import { runOpen } from '../src/commands.ts';
import { FolderError, folderPaths, foldersRootOf, writeFolderState } from '../src/folders.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'atlas-open-pick-'));
  const out = join(dir, 'out');
  const notes = join(dir, 'notes');
  const o = parseCli(['open', '--pick', '--out', out, '--notes-dir', notes, '--no-open']);
  return { out, notes, o };
}

describe('open --pick', () => {
  it('取り消したら、何も書かずに終わる。選ぶ画面は、前に開いたフォルダの場所で出す', async () => {
    const { out, notes, o } = setup();
    const root = foldersRootOf(out);
    const before = join(dir, 'logs', 'person-a');
    mkdirSync(before, { recursive: true });
    const at = '2026-11-01T00:00:00.000Z';
    writeFolderState(folderPaths(root, notes, before).state, { version: 1, path: before, name: 'person-a', addedAt: at, openedAt: at, listed: true, run: null });
    const asked: (string | null)[] = [];
    const logs: string[] = [];
    const r = await runOpen(o, (m) => logs.push(m), {
      pick: async (_title, initial) => {
        asked.push(initial);
        return null;
      },
    });
    expect(asked).toEqual([before]);
    expect(logs.join('\n')).toContain('フォルダを選ばなかったので、何もしません');
    expect(r.build).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });

  it('初めて開くときは、選ぶ画面を既定の場所で出す。集計できないフォルダを選んだら、理由を出して止まる', async () => {
    const { out, o } = setup();
    const asked: (string | null)[] = [];
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    await expect(
      runOpen(o, () => {}, {
        pick: async (_title, initial) => {
          asked.push(initial);
          return empty;
        },
      }),
    ).rejects.toBeInstanceOf(FolderError);
    expect(asked).toEqual([null]);
    expect(existsSync(foldersRootOf(out))).toBe(false);
  });
});
