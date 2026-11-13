// atlas 自身の版(atlas-version.ts の形と集計、atlas-build.ts の git からの読み取り)。コミットと人の名前はすべて架空のもの
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAtlasBuild } from '../src/atlas-build.ts';
import { describeAtlasBuilds, parseAtlasBuild, summarizeAtlasBuilds, type AtlasBuild } from '../src/atlas-version.ts';

const b = (c: string, at: string | null, o: Partial<AtlasBuild> = {}): AtlasBuild => ({ commit: c.repeat(40), committedAt: at, dirty: false, code: `${c.repeat(8)}00000000`, ...o });

describe('atlas の版', () => {
  it('parseAtlasBuild: 形の合うものだけを使い、日時は UTC にそろえる。コミットが無ければ日時も使わない', () => {
    expect(parseAtlasBuild({ commit: 'a'.repeat(40), committedAt: '2026-11-01T09:00:00+09:00', dirty: true, code: '0123456789abcdef' })).toEqual({
      commit: 'a'.repeat(40),
      committedAt: '2026-11-01T00:00:00.000Z',
      dirty: true,
      code: '0123456789abcdef',
    });
    // git の無いフォルダから送ったもの(目印だけ)
    expect(parseAtlasBuild({ commit: null, committedAt: '2026-11-01T00:00:00Z', dirty: null, code: '0123456789abcdef' })).toEqual({ commit: null, committedAt: null, dirty: null, code: '0123456789abcdef' });
    // 目印が無い・形が違うものは使わない。コミットの形が違えばコミットだけ捨てる
    for (const v of [null, 'x', [], {}, { code: 'XYZ' }, { code: 1 }]) expect(parseAtlasBuild(v)).toBeNull();
    expect(parseAtlasBuild({ commit: 'abc', committedAt: '2026-11-01T00:00:00Z', code: '0123456789abcdef' })).toEqual({ commit: null, committedAt: null, dirty: null, code: '0123456789abcdef' });
    expect(parseAtlasBuild({ commit: 'a'.repeat(40), committedAt: 'きのう', code: '0123456789abcdef' })?.committedAt).toBeNull();
  });

  it('summarizeAtlasBuilds: いちばん新しい版より古い版・記録なし・新旧を決められない版・手で変えた版を、人ごとに数える', () => {
    const s = summarizeAtlasBuilds(
      [
        { person: 'person-a', uploadAtlas: b('b', '2026-11-10T00:00:00.000Z') },
        { person: 'person-a', uploadAtlas: b('b', '2026-11-10T00:00:00.000Z', { dirty: true }) },
        { person: 'person-b', uploadAtlas: b('a', '2026-11-01T00:00:00.000Z') },
        { person: 'person-c', uploadAtlas: null },
        { person: 'person-d', uploadAtlas: { commit: null, committedAt: null, dirty: null, code: 'dddddddd00000000' } },
        // この PC の記録(送り先から集計したものではない)は数えない
        { person: null },
      ],
      null,
    )!;
    expect(s).toMatchObject({ sessions: 5, unknown: 1, unknownPersons: ['person-c'], undated: 1, older: 1, olderPersons: ['person-b'], dirty: 1 });
    expect(s.latest).toEqual({ commit: 'b'.repeat(40), committedAt: '2026-11-10T00:00:00.000Z', local: false });
    expect(s.builds.map((g) => [g.commit?.[0] ?? g.code.slice(0, 1), g.sessions, g.dirty, g.persons])).toEqual([
      ['b', 2, 1, ['person-a']],
      ['a', 1, 0, ['person-b']],
      ['d', 1, 0, ['person-d']],
    ]);
    const d = describeAtlasBuilds(s);
    expect(d.ok).toBe(false);
    expect(d.short).toBe('古い版 1 件・版の記録なし 1 件・新旧を決められない版 1 件・手で変えた版 1 件');
    expect(d.lines).toContain('aaaaaaa(2026-11-01) 古い版: 1 件(person-b)');
    expect(d.lines).toContain('版の記録なし(この記録を書く前の版で送ったもの): 1 件(person-c)');
  });

  it('この PC の版が送った版より新しければ、それをいちばん新しい版にする。すべて最新なら ok', () => {
    const sent = [{ uploadAtlas: b('a', '2026-11-01T00:00:00.000Z') }];
    const s = summarizeAtlasBuilds(sent, b('b', '2026-11-10T00:00:00.000Z'))!;
    expect(s.latest).toMatchObject({ commit: 'b'.repeat(40), local: true });
    expect(s.older).toBe(1);
    const same = summarizeAtlasBuilds(sent, b('a', '2026-11-01T00:00:00.000Z'))!;
    expect(describeAtlasBuilds(same)).toMatchObject({ ok: true, short: 'すべて最新', headline: '送った atlas の版: すべて最新(aaaaaaa)' });
    // 送り先から集計したものが無ければ数えない
    expect(summarizeAtlasBuilds([{ person: null }, {}], null)).toBeNull();
  });
});

describe('readAtlasBuild', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=atlas-test', '-c', 'user.email=atlas-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };

  it('git のコミットと日時、手で変えたかを読む(package-lock.json だけの変更は数えない)。git で取得していなければ目印だけ', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-ver-'));
    expect(readAtlasBuild(dir, 'feedfacefeedface')).toEqual({ commit: null, committedAt: null, dirty: null, code: 'feedfacefeedface' });
    git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'package-lock.json'), '{}');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'x', '--date', '2026-11-01T00:00:00Z');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    const r = readAtlasBuild(dir, 'feedfacefeedface');
    expect(r).toMatchObject({ commit: sha, dirty: false, code: 'feedfacefeedface' });
    expect(Number.isFinite(Date.parse(r.committedAt!))).toBe(true);
    await writeFile(join(dir, 'package-lock.json'), '{"x":1}');
    expect(readAtlasBuild(dir, 'feedfacefeedface').dirty).toBe(false);
    await writeFile(join(dir, 'a.txt'), 'b');
    expect(readAtlasBuild(dir, 'feedfacefeedface').dirty).toBe(true);
  });
});
