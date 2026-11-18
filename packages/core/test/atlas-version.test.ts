// atlas 自身の版(atlas-version.ts の形と集計、atlas-build.ts の git からの読み取り)。コミットと人の名前はすべて架空のもの
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAtlasBuild } from '../src/atlas-build.ts';
import { describeAtlasBuilds, folderOwner, parseAtlasBuild, summarizeAtlasBuilds, type AtlasBuild, type FolderUpload } from '../src/atlas-version.ts';

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

  const bn = b('b', '2026-07-02T00:00:00.000Z');
  const bo = b('a', '2026-07-01T00:00:00.000Z');
  const up = (at: string, atlas: AtlasBuild | null): FolderUpload => ({ uploadedAt: at, atlas });

  it('summarizeAtlasBuilds: 送った人ごとに数え、対応を頼む人を先に並べる。この PC の記録は数えない', () => {
    const ss = [
      { person: 'p1', uploadFolder: 'p1/a', uploadAtlas: bn },
      { person: 'p2', uploadFolder: 'p2/a', uploadAtlas: bo },
      { person: 'p2', uploadFolder: 'p2/a', uploadAtlas: bo },
      { person: 'p3', uploadFolder: 'p3/a', uploadAtlas: null },
      // この PC の記録(送り先から集計したものではない)は数えない
      { person: null, uploadFolder: null },
    ];
    const s = summarizeAtlasBuilds(ss, null)!;
    expect(s.sessions).toBe(4);
    expect(s.byPeople).toBe(true);
    expect(s.latest?.commit).toBe('b'.repeat(40));
    expect(s.senders.map((x) => x.name)).toEqual(['p2', 'p3', 'p1']);
    expect(s.senders[0]!.problems).toEqual([{ reason: 'older', sessions: 2, folders: 0 }]);
    const d = describeAtlasBuilds(s);
    expect(d.ok).toBe(false);
    expect(d.short).toBe('対応が要る人 2 人');
    expect(d.headline).toBe('送った atlas: 3 人のうち 対応が要る人 2 人(古い atlas で送った人 1 人・版の記録が無い人 1 人)');
    expect(d.lines).toEqual([
      '最新の atlas: bbbbbbb(2026-07-02 のコミット)',
      '対応が要る人(2 人):',
      '  p2: 古い atlas で送った(2 セッション)。フォルダは a。使った atlas は aaaaaaa',
      '  p3: 版の記録が無い(1 セッション)。フォルダは a',
      '頼むこと:',
      '  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう',
      '  版の記録が無い → 版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、そのフォルダを送り直してもらう',
      '最新の atlas で送った人(1 人): p1',
    ]);
    // 送り先から集計したものが無ければ数えない
    expect(summarizeAtlasBuilds([{ person: null }, {}], null)).toBeNull();
  });

  it('人ごと: 理由が重なれば 1 行にまとめ、当てはまるフォルダと送った日を出す。セッションを数えなかったフォルダの人も数え、日時の分からないフォルダのある人を前に並べる', () => {
    const dirty = { ...bn, dirty: true };
    const nogit: AtlasBuild = { commit: null, committedAt: null, dirty: false, code: '33333333' };
    const folders: Record<string, FolderUpload> = {
      'tanaka/x': up('2026-07-03T01:00:00.000Z', bo),
      'tanaka/y': up('2026-07-05T01:00:00.000Z', dirty),
      'sato/x': up('2026-07-06T01:00:00.000Z', bn),
      'suzuki/x': up('2026-07-01T01:00:00.000Z', nogit),
      'tanaka/z': up('2026-07-09T01:00:00.000Z', bn),
      'ito/x': { uploadedAt: null, atlas: null, unreadable: true },
      'ito/y': up('2026-07-08T01:00:00.000Z', bo),
      'kato/x': up('2026-07-04T01:00:00.000Z', dirty),
    };
    const ss = [
      { person: 'tanaka', uploadFolder: 'tanaka/x', uploadAtlas: bo },
      { person: 'tanaka', uploadFolder: 'tanaka/y', uploadAtlas: dirty },
      { person: 'sato', uploadFolder: 'sato/x', uploadAtlas: bn },
      { person: 'suzuki', uploadFolder: 'suzuki/x', uploadAtlas: nogit },
    ];
    const d = describeAtlasBuilds(summarizeAtlasBuilds(ss, { ...bo, dirty: true }, folders)!);
    expect(d.headline).toBe('送った atlas: 5 人のうち 対応が要る人 4 人(古い atlas で送った人 2 人・書き換えた atlas で送った人 2 人・版の新旧が分からない人 1 人・送った記録を読めない人 1 人)');
    expect(d.lines).toEqual([
      '最新の atlas: bbbbbbb(2026-07-02 のコミット)',
      '対応が要る人(4 人):',
      '  ito: 古い atlas で送った(1 フォルダ)、送った記録を読めない(1 フォルダ)。フォルダは x、y。使った atlas は aaaaaaa。送ったのは 2026-07-08',
      '  suzuki: 版の新旧が分からない(1 セッション)。フォルダは x。使った atlas は 目印 33333333。送ったのは 2026-07-01',
      '  tanaka: 古い atlas で送った(1 セッション)、書き換えた atlas で送った(1 セッション)。フォルダは x、y。使った atlas は aaaaaaa、bbbbbbb。送ったのは 2026-07-03〜2026-07-05',
      '  kato: 書き換えた atlas で送った(1 フォルダ)。フォルダは x。使った atlas は bbbbbbb。送ったのは 2026-07-04',
      '頼むこと:',
      '  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう',
      '  書き換えた atlas で送った → atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて、そのフォルダを送り直してもらう',
      '  版の新旧が分からない → git で取得していない atlas で送ったものです。git で取得した atlas から、そのフォルダを送り直してもらう',
      '  送った記録を読めない → 送っている最中だったのかもしれません。集計し直すと読めることがあります',
      '最新の atlas で送った人(1 人): sato',
      'この PC の atlas: aaaaaaa(2026-07-01)。ファイルを書き換えています',
    ]);
  });

  it('人のフォルダの下に無いものは、見出しをセッションの数で、内訳をフォルダごとに出す。すべて最新なら、その 1 行', () => {
    const folders = { '.': up('2026-07-03T01:00:00.000Z', bo) };
    const ss = [{ person: null, uploadFolder: '.', uploadAtlas: bo }];
    const s = summarizeAtlasBuilds(ss, bn, folders)!;
    expect(s.byPeople).toBe(false);
    let d = describeAtlasBuilds(s);
    expect(d.short).toBe('古い atlas で送ったセッション 1 件');
    expect(d.headline).toBe('送った atlas: 1 セッションのうち 古い atlas で送ったセッション 1 件');
    expect(d.lines.slice(0, 3)).toEqual(['最新の atlas: bbbbbbb(2026-07-02 のコミット。この PC の atlas)', '対応が要るフォルダ(1 件):', '  (このフォルダ): 古い atlas で送った(1 セッション)。使った atlas は aaaaaaa。送ったのは 2026-07-03']);

    // 人のフォルダを開いたとき(プロジェクトのフォルダが並ぶ): セッションの無いフォルダも、見出しに数える
    d = describeAtlasBuilds(summarizeAtlasBuilds([{ person: null, uploadFolder: 'x', uploadAtlas: bo }], bn, { x: up('2026-07-03T01:00:00.000Z', bo), y: up('2026-07-04T01:00:00.000Z', bo) })!);
    expect(d.headline).toBe('送った atlas: 1 セッションのうち 古い atlas で送ったセッション 1 件とフォルダ 1 件');
    expect(d.lines[1]).toBe('対応が要るフォルダ(2 件):');

    d = describeAtlasBuilds(summarizeAtlasBuilds(ss, bo, folders)!);
    expect(d).toEqual({ ok: true, short: 'すべて最新', headline: '送った atlas: すべて最新(aaaaaaa)', lines: ['最新の atlas: aaaaaaa(2026-07-01 のコミット)', '最新の atlas で送ったフォルダ(1 件): (このフォルダ)', 'この PC の atlas: aaaaaaa(2026-07-01)'] });
    // 持ち主: <人>/<プロジェクト> なら人、人のフォルダの下に無いものはフォルダそのもの
    expect([folderOwner('person-a/app'), folderOwner('app'), folderOwner('.')]).toEqual(['person-a', 'app', '(このフォルダ)']);
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
