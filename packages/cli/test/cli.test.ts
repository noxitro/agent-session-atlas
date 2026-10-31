import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import { parseCli, UsageError } from '../src/args.ts';
import { filterSessions, hasFilter, resolvePaths } from '../src/commands.ts';

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
    expect(parseCli(['bundle', '--client', 'github/cli', '--include-empty'])).toMatchObject({ command: 'bundle', client: 'github/cli', includeEmpty: true, judge: null });
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
  });
});

describe('filterSessions', () => {
  it('--project は完全一致を優先し、無ければ部分一致。--since は更新日時で絞る', async () => {
    const mk = (id: string, repository: string, client: string, at: string) =>
      normalizeSession({ id, workspace: { repository, client_name: client, created_at: at, updated_at: at }, events: [] });
    const rs = [await mk('1', 'acme/app', 'github/cli', '2026-07-01T00:00:00Z'), await mk('2', 'acme/app-docs', 'github/autopilot', '2026-09-01T00:00:00Z'), await mk('3', 'other/x', 'github/cli', '2026-10-01T00:00:00Z')];
    const none = { since: null, project: null, client: null, model: null, branch: null };
    expect(hasFilter(none)).toBe(false);
    expect(filterSessions(rs, { ...none, project: 'acme/app' }).sessions.map((s) => s.id)).toEqual(['1']);
    const partial = filterSessions(rs, { ...none, project: 'ACME' });
    expect(partial.sessions.map((s) => s.id)).toEqual(['1', '2']);
    expect(partial.projects.sort()).toEqual(['acme/app', 'acme/app-docs']);
    expect(filterSessions(rs, { ...none, client: 'github/cli' }).sessions.map((s) => s.id)).toEqual(['1', '3']);
    expect(filterSessions(rs, { ...none, since: '2026-08-15' }).sessions.map((s) => s.id)).toEqual(['2', '3']);
  });
});
