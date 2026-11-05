import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import { parseCli, UsageError } from '../src/args.ts';
import { filterSessions, hasFilter, REPO_ROOT as REPO, resolveIdFilter, resolvePaths } from '../src/commands.ts';

describe('deps-fresh(bat が npm install するかの判定)', () => {
  const run = (root: string): number | null => spawnSync(process.execPath, [join(REPO, 'scripts', 'deps-fresh.mjs'), root]).status;
  const lock = (packages: object): string => JSON.stringify({ packages });
  it('lock と node_modules が揃っていれば 0、足りない・版が違えば 1。optional と link は見ない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-deps-'));
    try {
      expect(run(root)).toBe(1);
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'package-lock.json'), lock({ '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0', optional: true }, 'node_modules/@x/y': { resolved: 'packages/y', link: true } }));
      expect(run(root)).toBe(1); // node_modules/.package-lock.json が無い
      await writeFile(join(root, 'node_modules', '.package-lock.json'), lock({ 'node_modules/a': { version: '1.0.0' } }));
      expect(run(root)).toBe(0);
      await writeFile(join(root, 'node_modules', '.package-lock.json'), lock({ 'node_modules/a': { version: '0.9.0' } }));
      expect(run(root)).toBe(1);
      await writeFile(join(root, 'node_modules', '.package-lock.json'), lock({}));
      expect(run(root)).toBe(1); // 依存を足した直後(既存の node_modules に無い)
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('このリポジトリの node_modules は揃っている', () => {
    expect(run(REPO)).toBe(0);
  });
});

describe('parseCli', () => {
  it('コマンド省略時は all、オプションを読む', () => {
    expect(parseCli([])).toMatchObject({ command: 'all', anonymize: false, home: null });
    expect(parseCli(['build', '--anonymize', '--out', 'o', '--project', 'p', '--client', 'github/cli', '--model', 'm', '--branch', 'b', '--since', '2026-07-01'])).toMatchObject({
      command: 'build',
      anonymize: true,
      out: 'o',
      project: 'p',
      client: 'github/cli',
      model: 'm',
      branch: 'b',
      since: '2026-07-01',
    });
  });

  it('不明なコマンド・オプション・日時は UsageError', () => {
    expect(() => parseCli(['nope'])).toThrow(UsageError);
    expect(() => parseCli(['build', '--bogus'])).toThrow(UsageError);
    expect(() => parseCli(['--since', 'not-a-date'])).toThrow(/since/);
    expect(() => parseCli(['build', 'extra'])).toThrow(/1 つだけ/);
  });

  it('export と --tool-output / --max-chars を読む(export 以外では UsageError)', () => {
    expect(parseCli(['export'])).toMatchObject({ command: 'export', toolOutput: 'fail', maxChars: null });
    expect(parseCli(['export', '--tool-output', 'all', '--max-chars', '500', '--anonymize'])).toMatchObject({ command: 'export', toolOutput: 'all', maxChars: 500, anonymize: true });
    expect(() => parseCli(['export', '--tool-output', 'maybe'])).toThrow(/tool-output/);
    expect(() => parseCli(['export', '--max-chars', '10'])).toThrow(/max-chars/);
    expect(() => parseCli(['build', '--tool-output', 'all'])).toThrow(/export でだけ/);
  });

  it('bundle と judge run / import を読む', () => {
    expect(parseCli(['bundle', '--client', 'github/cli', '--include-empty'])).toMatchObject({ command: 'bundle', client: 'github/cli', includeEmpty: true, perPart: null, judge: null });
    expect(parseCli(['bundle', '--per-part', '3'])).toMatchObject({ command: 'bundle', perPart: 3, unjudged: false });
    expect(parseCli(['bundle', '--unjudged'])).toMatchObject({ command: 'bundle', unjudged: true });
    expect(() => parseCli(['export', '--unjudged'])).toThrow(/bundle でだけ/);
    expect(() => parseCli(['bundle', '--per-part', '0'])).toThrow(/per-part/);
    expect(() => parseCli(['export', '--per-part', '3'])).toThrow(/bundle でだけ/);
    // 伏せ字に対応しないコマンドでは黙って無視せずエラー(評価バンドルを伏せたつもりで外部へ渡さないように)
    for (const argv of [['bundle'], ['judge', 'run'], ['judge', 'import', 'x.json'], ['serve'], ['skill-draft', '1']]) expect(() => parseCli([...argv, '--anonymize'])).toThrow(/build \/ export \/ all でだけ/);
    expect(parseCli(['all', '--anonymize'])).toMatchObject({ command: 'all', anonymize: true });
    expect(parseCli(['--anonymize'])).toMatchObject({ command: 'all', anonymize: true });
    expect(parseCli(['judge', 'run'])).toMatchObject({
      command: 'judge',
      judge: { action: 'run', backend: 'copilot-cli', model: null, limit: null, only: null, concurrency: 1, force: false, allowTools: true, timeoutSec: 600 },
    });
    expect(
      parseCli(['judge', 'run', '--backend', 'opencode', '--model', 'x/y', '--limit', '3', '--only', 'a, b', '--concurrency', '2', '--force', '--no-allow-tools', '--timeout', '30']).judge,
    ).toMatchObject({ backend: 'opencode', model: 'x/y', limit: 3, only: ['a', 'b'], concurrency: 2, force: true, allowTools: false, timeoutSec: 30 });
    expect(parseCli(['judge', 'import', 'r.md']).judge).toMatchObject({ action: 'import', file: 'r.md' });
    expect(() => parseCli(['judge'])).toThrow(/run か import/);
    expect(() => parseCli(['judge', 'import'])).toThrow(/ファイル/);
    expect(() => parseCli(['judge', 'run', '--backend', 'gpt'])).toThrow(/バックエンド/);
    expect(() => parseCli(['judge', 'run', '--limit', '-1'])).toThrow(/--limit/);
    expect(() => parseCli(['build', '--limit', '3'])).toThrow(/judge run/);
  });

  it('出力先と judgments の既定パス', () => {
    const p = resolvePaths({ home: 'h', out: 'o', judgments: null });
    expect(p.html.endsWith('atlas.html')).toBe(true);
    expect(p.judgments.endsWith('judgments.json')).toBe(true);
    expect(p.snapshot.endsWith('snapshot')).toBe(true);
    // Phase 10: グループは out/ ではなくリポジトリ直下の atlas-notes/(--notes-dir で変更)
    expect(p.groups.replace(/\\/g, '/').endsWith('/atlas-notes/groups.json')).toBe(true);
    expect(p.groups.replace(/\\/g, '/')).not.toContain('/o/');
    expect(resolvePaths({ home: 'h', out: 'o', judgments: null, notesDir: 'n' }).groups.replace(/\\/g, '/').endsWith('/n/groups.json')).toBe(true);
  });

  it('Phase 10: --group / --session / --notes-dir と group list / add / remove を読む', () => {
    expect(parseCli(['build', '--group', ' 調査 ', '--session', 'a, b', '--session', 'c', '--notes-dir', 'n'])).toMatchObject({
      command: 'build',
      group: '調査',
      sessions: ['a', 'b', 'c'],
      notesDir: 'n',
      groupCmd: null,
      memoCmd: null,
    });
    expect(parseCli(['bundle', '--group', 'g'])).toMatchObject({ command: 'bundle', group: 'g', sessions: null });
    expect(parseCli(['memo', 'list']).memoCmd).toEqual({ action: 'list', id: null, text: null, file: null });
    expect(parseCli(['memo', 'set', 'abc', '本文', 'の続き']).memoCmd).toEqual({ action: 'set', id: 'abc', text: '本文 の続き', file: null });
    expect(parseCli(['memo', 'set', 'abc', '--file', 'a.md']).memoCmd).toEqual({ action: 'set', id: 'abc', text: null, file: 'a.md' });
    expect(() => parseCli(['memo'])).toThrow('list / show / set / remove');
    expect(() => parseCli(['memo', 'edit'])).toThrow('不明な操作');
    expect(() => parseCli(['memo', 'show'])).toThrow('セッション id');
    expect(() => parseCli(['memo', 'set', 'abc'])).toThrow('--file');
    expect(() => parseCli(['memo', 'set', 'abc', 'x', '--file', 'a.md'])).toThrow('同時に');
    expect(() => parseCli(['memo', 'remove', 'abc', 'x'])).toThrow('余分な引数');
    expect(() => parseCli(['build', '--file', 'a.md'])).toThrow('--file は memo set');
    expect(parseCli(['group', 'list'])).toMatchObject({ command: 'group', groupCmd: { action: 'list', name: null, ids: [], note: null } });
    expect(parseCli(['group', 'add', 'g', 'a,b', 'c', '--note', 'メモ']).groupCmd).toEqual({ action: 'add', name: 'g', ids: ['a', 'b', 'c'], note: 'メモ' });
    expect(parseCli(['group', 'remove', 'g']).groupCmd).toMatchObject({ action: 'remove', name: 'g' });
    expect(() => parseCli(['group'])).toThrow(/list \/ add \/ remove/);
    expect(() => parseCli(['group', 'rename', 'g'])).toThrow(/不明な操作/);
    expect(() => parseCli(['group', 'add', 'g'])).toThrow(/id を 1 つ以上/);
    expect(() => parseCli(['group', 'remove'])).toThrow(/グループ名/);
    expect(() => parseCli(['group', 'remove', 'g', 'x'])).toThrow(/余分/);
    expect(() => parseCli(['group', 'list', 'x'])).toThrow(/余分/);
    expect(() => parseCli(['build', '--note', 'x'])).toThrow(/group add/);
    expect(() => parseCli(['build', '--session', ' , '])).toThrow(/--session/);
    expect(() => parseCli(['build', '--group', ' '])).toThrow(/--group/);
  });
});

describe('filterSessions', () => {
  it('--project は完全一致を優先し、無ければ部分一致。--since は更新日時で絞る', async () => {
    const mk = (id: string, repository: string, client: string, at: string) =>
      normalizeSession({ id, workspace: { repository, client_name: client, created_at: at, updated_at: at }, events: [] });
    const rs = [await mk('1', 'acme/app', 'github/cli', '2026-07-01T00:00:00Z'), await mk('2', 'acme/app-docs', 'github/autopilot', '2026-09-01T00:00:00Z'), await mk('3', 'other/x', 'github/cli', '2026-10-01T00:00:00Z')];
    const none = { since: null, project: null, client: null, model: null, branch: null };
    expect(hasFilter(none)).toBe(false);
    expect(hasFilter({ ...none, group: 'g' })).toBe(true);
    expect(hasFilter({ ...none, sessions: ['1'] })).toBe(true);
    expect(hasFilter({ ...none, sessions: [] })).toBe(false);
    // Phase 10: 解決済みの id の集合は他の条件と AND
    expect(filterSessions(rs, { ...none, client: 'github/cli' }, new Set(['1', '2'])).sessions.map((s) => s.id)).toEqual(['1']);
    // --group は groups.json の名前で解決し、記録に無い id は件数だけ知らせる。無い名前はエラー。--session は先頭一致で、両方あれば AND
    const groups = { path: 'g.json', exists: true, groups: [{ name: 'g', note: '', ids: ['1', '3', 'x'] }], warnings: [] };
    const r = resolveIdFilter(rs, { ...none, group: 'g' }, groups)!;
    expect([...r.set].sort()).toEqual(['1', '3', 'x']);
    expect(r).toMatchObject({ groupTotal: 3, groupKnown: 2 });
    expect(filterSessions(rs, { ...none, group: 'g' }, r.set).sessions.map((s) => s.id)).toEqual(['1', '3']);
    expect(() => resolveIdFilter(rs, { ...none, group: 'nope' }, groups)).toThrow(/「nope」.*あるのは: g/);
    expect(() => resolveIdFilter(rs, { ...none, group: 'g' }, { ...groups, exists: false, groups: [] })).toThrow(/がありません/);
    expect([...resolveIdFilter(rs, { ...none, sessions: ['2'] }, groups)!.set]).toEqual(['2']);
    expect([...resolveIdFilter(rs, { ...none, group: 'g', sessions: ['1', '2'] }, groups)!.set]).toEqual(['1']);
    expect(resolveIdFilter(rs, none, groups)).toBeNull();
    expect(filterSessions(rs, { ...none, project: 'acme/app' }).sessions.map((s) => s.id)).toEqual(['1']);
    const partial = filterSessions(rs, { ...none, project: 'ACME' });
    expect(partial.sessions.map((s) => s.id)).toEqual(['1', '2']);
    expect(partial.projects.sort()).toEqual(['acme/app', 'acme/app-docs']);
    expect(filterSessions(rs, { ...none, client: 'github/cli' }).sessions.map((s) => s.id)).toEqual(['1', '3']);
    expect(filterSessions(rs, { ...none, since: '2026-08-15' }).sessions.map((s) => s.id)).toEqual(['2', '3']);
  });
});
