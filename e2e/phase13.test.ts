// Phase 13 の E2E: メモが詳細ページと atlas.html に出る、伏せ字版に出ない、CLI で往復できる、~/.copilot を書き換えない
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { buildFixtureHome, ROOT, cliCommand } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-phase13');
const MEMO_TEXT = '# 調べた理由\n\n固有のメモ本文 ZEBRA-MEMO を残す\n\n![図](__ID__/one.png)\n\n[外部](https://example.test/page)';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(...cliCommand(args), { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
}

function mtimes(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${join(e.parentPath, e.name)}:${statSync(join(e.parentPath, e.name)).mtimeMs}`)
    .sort()
    .join('\n');
}

function externalRefs(html: string): string[] {
  const found: string[] = [];
  for (const needle of ['http://', 'https://']) if (html.includes(needle)) found.push(needle);
  if (/\bsrc=["'](?!data:)[^"']+["']/i.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, ''))) found.push('src=');
  return found;
}

describe('Phase 13: メモ', () => {
  const dir = WORK;
  const out = join(WORK, 'out');
  const notes = join(WORK, 'notes');
  let home: string;
  let close: () => Promise<void>;
  let id: string;
  let other: string;
  let before: string;
  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    before = mtimes(home);
    expect(atlas(['all', '--home', home, '--out', out, '--notes-dir', notes]).status).toBe(0);
    const ids = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8')).sessions.map((s) => s.id);
    [id, other] = ids;
    await mkdir(join(notes, 'memos', id), { recursive: true });
    await writeFile(join(notes, 'memos', `${id}.md`), MEMO_TEXT.replace('__ID__', id));
    await writeFile(join(notes, 'memos', id, 'one.png'), PNG);
  }, 120_000);
  afterAll(async () => close?.());

  it('a. 詳細ページの先頭に節が出て、目次に載り、画像は埋め込まれ、外部参照が無い', async () => {
    expect(atlas(['build', '--out', out, '--notes-dir', notes]).status).toBe(0);
    const html = await readFile(join(out, 'sessions', `${id}.html`), 'utf8');
    expect(html).toContain('ZEBRA-MEMO');
    expect(html).toContain('<h3>調べた理由</h3>');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html.indexOf('id="memo"')).toBeLessThan(html.indexOf('>概要</h2>'));
    expect(html).toContain('<a href="#memo">メモ');
    expect(html).toContain('.memo-body');
    expect(externalRefs(html)).toEqual([]);
    // メモの無いページは空の節だけで、CSS も足さない
    const plain = await readFile(join(out, 'sessions', `${other}.html`), 'utf8');
    expect(plain).toMatch(/<section class="section" id="memo"[^>]*hidden/);
    expect(plain).not.toContain('.memo-body');
    expect(plain).not.toContain('href="#memo"');
  });

  it('b. atlas.html には抜粋だけを埋め込み、全文は入れない', async () => {
    const raw = await readFile(join(out, 'atlas.html'), 'utf8');
    const data = extractEmbedded<ReportData>(raw);
    expect(data.version).toBe(13);
    const s = data.sessions.find((x) => x.id === id)!;
    expect(s.memo).toMatchObject({ excerpt: '調べた理由', images: 1 });
    expect(data.sessions.find((x) => x.id === other)?.memo ?? null).toBeNull();
    expect(raw).not.toContain('ZEBRA-MEMO');
  });

  it('c. 伏せ字版にはメモを一切出さない', async () => {
    const anonOut = join(dir, 'anon');
    expect(atlas(['all', '--home', home, '--out', anonOut, '--notes-dir', notes, '--anonymize']).status).toBe(0);
    const data = extractEmbedded<ReportData>(await readFile(join(anonOut, 'atlas.html'), 'utf8'));
    expect(data.sessions.every((s) => !s.memo)).toBe(true);
    for (const f of await readdir(join(anonOut, 'sessions'))) {
      const html = await readFile(join(anonOut, 'sessions', f), 'utf8');
      expect(html).not.toContain('ZEBRA-MEMO');
      expect(html).not.toContain('id="memo"');
      expect(html).not.toContain('data:image/png');
    }
  }, 120_000);

  it('d. CLI で保存・一覧・表示・削除ができ、曖昧な id はエラーにする', async () => {
    const p = ['--out', out, '--notes-dir', notes];
    const prefix = other; // fixture の id は先頭が共通なので、先頭一致は曖昧なときのエラーを見る
    const ambiguous = atlas(['memo', 'set', other.slice(0, 8), 'x', ...p]);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain('曖昧');
    expect(atlas(['memo', 'set', prefix, 'CLI', 'のメモ', ...p]).status).toBe(0);
    expect(await readFile(join(notes, 'memos', `${other}.md`), 'utf8')).toBe('CLI のメモ');
    const list = atlas(['memo', 'list', ...p]);
    expect(list.stdout).toContain('2 件');
    expect(list.stdout).toContain(`${other}: CLI のメモ`);
    expect(list.stdout).toContain('(画像 1 枚)');
    expect(atlas(['memo', 'show', prefix, ...p]).stdout).toContain('CLI のメモ');
    const file = join(dir, 'memo.md');
    await writeFile(file, 'ファイルから');
    expect(atlas(['memo', 'set', other, '--file', file, ...p]).status).toBe(0);
    expect(await readFile(join(notes, 'memos', `${other}.md`), 'utf8')).toBe('ファイルから');
    expect(atlas(['memo', 'remove', prefix, ...p]).status).toBe(0);
    expect(existsSync(join(notes, 'memos', `${other}.md`))).toBe(false);
    const missing = atlas(['memo', 'show', other, ...p]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('メモはありません');
  }, 60_000);

  it('e. 元データを書き換えない', () => {
    expect(mtimes(home)).toBe(before);
  });
});
