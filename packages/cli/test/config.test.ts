import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../src/args.ts';
import { isByokModel, loadConfig, modifyConfig, NO_CHANGE, parseConfig, resolveJudgeModel, updateConfig } from '../src/config.ts';

describe('parseConfig', () => {
  it('文字列は path だけの指定、オブジェクトは形式も読む', () => {
    expect(parseConfig({ wikis: ['my-notes', { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }] })).toEqual({
      wikis: [{ path: 'my-notes' }, { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }],
      phases: null,
      uploadRoot: null,
      uploadProjects: null,
      judgeModel: null,
    });
  });

  it('phases: 依頼ごとの判定の普段の工程名(2 つ以上、重複なし、前後の空白は除く)', () => {
    expect(parseConfig({ phases: [' 要件定義', '実装 ', 'テスト'] })).toEqual({ wikis: null, phases: ['要件定義', '実装', 'テスト'], uploadRoot: null, uploadProjects: null, judgeModel: null });
    expect(() => parseConfig({ phases: ['実装'] })).toThrow(/2 つ以上/);
    expect(() => parseConfig({ phases: ['実装', '実装'] })).toThrow(/同じ名前/);
    expect(() => parseConfig({ phases: '実装' })).toThrow(/phases/);
  });

  it('vcs: パスの読み替え(フルパスだけ)と比べる版の見方。書き間違いは止める', () => {
    expect(parseConfig({ vcs: { pathMap: [{ from: ' D:\\old\\repo ', to: 'E:\\dev\\repo' }, { from: '/home/zz/a', to: '/srv/a' }], mode: 'committed' } }).vcs).toEqual({
      pathMap: [
        { from: 'D:\\old\\repo', to: 'E:\\dev\\repo' },
        { from: '/home/zz/a', to: '/srv/a' },
      ],
      mode: 'committed',
    });
    expect(parseConfig({ vcs: {} }).vcs).toEqual({ pathMap: [], mode: null });
    // セッションの終わりから決まった日数後の版
    expect(parseConfig({ vcs: { mode: 'fixed', lagDays: 14 } }).vcs).toEqual({ pathMap: [], mode: 'fixed', lagDays: 14 });
    expect(() => parseConfig({ vcs: { lagDays: 0 } })).toThrow(/vcs.lagDays/);
    expect(() => parseConfig({ vcs: { lagDays: 1.5 } })).toThrow(/vcs.lagDays/);
    // 状態の名前と節の一文の差し替え
    expect(parseConfig({ vcs: { labels: { kept: ' 残った ', unattributable: '不明' }, note: ' 一文。 ' } }).vcs).toEqual({ pathMap: [], mode: null, labels: { kept: '残った', unattributable: '不明' }, note: '一文。' });
    expect(() => parseConfig({ vcs: { labels: { gone: 'x' } } })).toThrow(/不明な状態/);
    expect(() => parseConfig({ vcs: { labels: { kept: '' } } })).toThrow(/vcs.labels.kept/);
    expect(() => parseConfig({ vcs: { labels: { kept: 'x'.repeat(41) } } })).toThrow(/40 文字/);
    expect(() => parseConfig({ vcs: { note: 1 } })).toThrow(/vcs.note/);
    expect(parseConfig({}).vcs).toBeUndefined();
    expect(() => parseConfig({ vcs: { pathMaps: [] } })).toThrow(/vcs の不明な項目/);
    expect(() => parseConfig({ vcs: { mode: 'head' } })).toThrow(/vcs.mode/);
    expect(() => parseConfig({ vcs: { pathMap: [{ from: 'old', to: 'E:\\x' }] } })).toThrow(/from はフルパス/);
    expect(() => parseConfig({ vcs: { pathMap: [{ from: 'D:\\x' }] } })).toThrow(/from と to/);
    expect(() => parseConfig({ vcs: { pathMap: [{ from: 'D:\\x', to: 'E:\\y', note: 1 }] } })).toThrow(/不明な項目/);
  });

  it('wikis が無ければ null、空配列は集計なしとしてそのまま', () => {
    expect(parseConfig({})).toEqual({ wikis: null, phases: null, uploadRoot: null, uploadProjects: null, judgeModel: null });
    expect(parseConfig({ wikis: [] })).toEqual({ wikis: [], phases: null, uploadRoot: null, uploadProjects: null, judgeModel: null });
  });

  it('uploadRoot: グループのアップロード先はフルパスだけ(~/ はホーム、前後の空白と引用符は除く)', () => {
    const abs = join(tmpdir(), 'atlas-logs');
    expect(parseConfig({ uploadRoot: ` "${abs}" ` }).uploadRoot).toBe(abs);
    expect(parseConfig({ uploadRoot: '~/atlas-logs' }).uploadRoot).toBe(join(homedir(), 'atlas-logs'));
    expect(() => parseConfig({ uploadRoot: 'atlas-logs' })).toThrow(/フルパス/);
    expect(() => parseConfig({ uploadRoot: '' })).toThrow(/uploadRoot/);
    expect(() => parseConfig({ uploadRoot: 1 })).toThrow(/uploadRoot/);
  });

  it('uploadProjects: upload-project.bat がまとめて送るプロジェクト名(同じ名前は 1 つに、空なら null。名前の空白はそのまま)', () => {
    expect(parseConfig({ uploadProjects: ['owner/app', ' 空白 ', 'owner/app'] }).uploadProjects).toEqual(['owner/app', ' 空白 ']);
    expect(parseConfig({ uploadProjects: [] }).uploadProjects).toBeNull();
    expect(() => parseConfig({ uploadProjects: 'owner/app' })).toThrow(/uploadProjects/);
    expect(() => parseConfig({ uploadProjects: ['  '] })).toThrow(/uploadProjects/);
    expect(() => parseConfig({ uploadProjects: [1] })).toThrow(/uploadProjects/);
  });

  it('judgeModel: 判定に使う Copilot CLI のモデル(前後の空白は除く。空・空白入り・文字列以外は止める)。BYOK は <プロバイダー名>/<モデル ID>', () => {
    expect(parseConfig({ judgeModel: ' anthropic/claude-sonnet-5-5 ' }).judgeModel).toBe('anthropic/claude-sonnet-5-5');
    expect(parseConfig({}).judgeModel).toBeNull();
    for (const bad of ['', '  ', 'a b', 1, null]) expect(() => parseConfig({ judgeModel: bad })).toThrow(/judgeModel/);
    expect(isByokModel('anthropic/claude-sonnet-5-5')).toBe(true);
    // Copilot が用意するモデルの名前には / が無い(AI クレジットを使う)
    for (const m of ['claude-sonnet-5.5', 'auto', null, '/x', 'a/', 'a/b/c']) expect(isByokModel(m)).toBe(false);
  });

  it('resolveJudgeModel: 指定(--model)> 設定の judgeModel > なし。どこから来たか、AI クレジットを使うかをログに書く', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-judge-model-'));
    const file = join(dir, 'atlas.config.json');
    const prev = process.env.ATLAS_CONFIG;
    process.env.ATLAS_CONFIG = file;
    try {
      const logs: string[] = [];
      writeFileSync(file, JSON.stringify({ judgeModel: 'anthropic/claude-sonnet-5-5' }));
      expect(await resolveJudgeModel('claude-haiku-5.5', 'judge', (m) => logs.push(m))).toBe('claude-haiku-5.5');
      expect(logs).toEqual([]);
      expect(await resolveJudgeModel(null, 'turns', (m) => logs.push(m))).toBe('anthropic/claude-sonnet-5-5');
      expect(logs.pop()).toMatch(/^turns: 判定に使うモデル anthropic\/claude-sonnet-5-5\(atlas\.config\.json の judgeModel。自分の API キーのモデル\(BYOK\)なので、Copilot の AI クレジットは使いません\)$/);
      writeFileSync(file, '{}');
      expect(await resolveJudgeModel(null, 'judge', (m) => logs.push(m))).toBeNull();
      expect(logs.pop()).toMatch(/^judge: 注意 モデルを指定していないので、Copilot の既定のモデルで判定します\(AI クレジットを使います\)/);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_CONFIG;
      else process.env.ATLAS_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('~/ はホームに展開する', () => {
    expect(parseConfig({ wikis: ['~/notes'] }).wikis).toEqual([{ path: join(homedir(), 'notes') }]);
  });

  it('書き間違いと型の違いは止める', () => {
    expect(() => parseConfig([])).toThrow(/オブジェクト/);
    expect(() => parseConfig({ wiki: [] })).toThrow(/不明な項目/);
    expect(() => parseConfig({ wikis: 'x' })).toThrow(/配列/);
    expect(() => parseConfig({ wikis: [1] })).toThrow(/wikis\[0\]/);
    expect(() => parseConfig({ wikis: [{ path: 'x', page: ['y'] }] })).toThrow(/不明な項目です: page/);
    expect(() => parseConfig({ wikis: [{ path: 'x', index: 'README.md' }] })).toThrow(/wikis\[0\]\.index/);
    expect(() => parseConfig({ wikis: [{ index: ['a'] }] })).toThrow(/path/);
    for (const path of ['', '.', '/', '~', '../']) expect(() => parseConfig({ wikis: [{ path }] })).toThrow(/path/);
  });
});

describe('loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('既定の場所に無ければ設定なし、明示したのに無ければ失敗', async () => {
    const missing = join(dir, 'none.json');
    await expect(loadConfig(missing, false)).resolves.toEqual({ path: null, wikis: null, phases: null, uploadRoot: null, uploadProjects: null, judgeModel: null });
    await expect(loadConfig(missing, true)).rejects.toThrow(/ありません/);
  });

  it('BOM 付きを読み、壊れた JSON はファイル名付きで失敗する', async () => {
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '\uFEFF{"wikis":["notes"]}');
    await expect(loadConfig(ok, true)).resolves.toEqual({ path: ok, wikis: [{ path: 'notes' }], phases: null, uploadRoot: null, uploadProjects: null, judgeModel: null });
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    await expect(loadConfig(bad, false)).rejects.toThrow(/bad\.json/);
  });
});

describe('updateConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-config-up-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('1 項目だけ書き換え、他の項目と書き方は残す。無ければ作り、壊れたファイルと検査に通らない値は書かない', async () => {
    const p = join(dir, 'c.json');
    writeFileSync(p, '﻿' + JSON.stringify({ wikis: ['notes'], phases: ['a', 'b'] }));
    const root = join(dir, 'logs');
    await updateConfig(p, 'uploadRoot', root);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ wikis: ['notes'], phases: ['a', 'b'], uploadRoot: root });
    await expect(updateConfig(p, 'uploadRoot', 'relative')).rejects.toThrow(/フルパス/);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadRoot).toBe(root);
    const fresh = join(dir, 'new.json');
    await updateConfig(fresh, 'uploadRoot', root);
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ uploadRoot: root });
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{');
    await expect(updateConfig(broken, 'uploadRoot', root)).rejects.toThrow(/書き換えません/);
    expect(readFileSync(broken, 'utf8')).toBe('{');
    // 一時ファイルを残さない
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('値の差し替えと末尾への追加では、手で詰めて書いた他の項目の書き方を変えない', async () => {
    const p = join(dir, 'hand.json');
    const hand = '{\n  "wikis": [\n    {\n      "path": "my-notes",\n      "index": ["README.md", "00-home.md"]\n    }\n  ]\n}\n';
    writeFileSync(p, hand);
    const a = join(dir, 'a "x"');
    await updateConfig(p, 'uploadRoot', a);
    expect(readFileSync(p, 'utf8')).toBe(`{\n  "wikis": [\n    {\n      "path": "my-notes",\n      "index": ["README.md", "00-home.md"]\n    }\n  ],\n  "uploadRoot": ${JSON.stringify(a)}\n}\n`);
    // 2 回目は値だけ差し替える(引用符を含む前の値も正しく置き換える)
    const b = join(dir, 'b$1');
    await updateConfig(p, 'uploadRoot', b);
    expect(readFileSync(p, 'utf8')).toBe(`{\n  "wikis": [\n    {\n      "path": "my-notes",\n      "index": ["README.md", "00-home.md"]\n    }\n  ],\n  "uploadRoot": ${JSON.stringify(b)}\n}\n`);
    // 空のオブジェクトにも足せる
    const e = join(dir, 'empty.json');
    writeFileSync(e, '{}');
    await updateConfig(e, 'uploadRoot', b);
    expect(JSON.parse(readFileSync(e, 'utf8'))).toEqual({ uploadRoot: b });
  });

  it('配列の値も、足す・差し替える・消すだけなら手で書いた他の項目の書き方を変えない(全部消えたら {})', async () => {
    const p = join(dir, 'arr.json');
    const head = '{\n  "wikis": [\n    {\n      "path": "my-notes",\n      "index": ["README.md", "00-home.md"]\n    }\n  ]';
    writeFileSync(p, `${head}\n}\n`);
    await updateConfig(p, 'uploadProjects', ['owner/app']);
    expect(readFileSync(p, 'utf8')).toBe(`${head},\n  "uploadProjects": [\n    "owner/app"\n  ]\n}\n`);
    // 差し替え(中に ] や " を含む名前でも、括弧と文字列の対応を見て値の範囲を読む)
    await updateConfig(p, 'uploadProjects', ['owner/app', 'a "]" b']);
    expect(readFileSync(p, 'utf8')).toBe(`${head},\n  "uploadProjects": [\n    "owner/app",\n    "a \\"]\\" b"\n  ]\n}\n`);
    // 消す(前の項目の , ごと)
    await updateConfig(p, 'uploadProjects', undefined);
    expect(readFileSync(p, 'utf8')).toBe(`${head}\n}\n`);
    // 先頭の項目を消すときは、後ろの , とその行の残りを消す
    const q = join(dir, 'first.json');
    writeFileSync(q, '{\n  "uploadProjects": ["x"],\n  "phases": ["a", "b"]\n}\n');
    await updateConfig(q, 'uploadProjects', undefined);
    expect(readFileSync(q, 'utf8')).toBe('{\n  "phases": ["a", "b"]\n}\n');
    // 最後の 1 つを消すと {}
    await updateConfig(q, 'phases', undefined);
    expect(readFileSync(q, 'utf8')).toBe('{}\n');
  });

  it('modifyConfig: 今の設定から次の値を決め、NO_CHANGE なら書かない。読めない設定は書き換えない', async () => {
    const p = join(dir, 'mod.json');
    const hand = '{ "uploadProjects": ["a"],   "phases": ["x", "y"] }\n';
    writeFileSync(p, hand);
    expect(await modifyConfig(p, 'uploadProjects', (c) => (c.uploadProjects?.includes('a') ? NO_CHANGE : ['a']))).toBe(NO_CHANGE);
    expect(readFileSync(p, 'utf8')).toBe(hand);
    expect(await modifyConfig(p, 'uploadProjects', (c) => [...(c.uploadProjects ?? []), 'b'])).toEqual(['a', 'b']);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ uploadProjects: ['a', 'b'], phases: ['x', 'y'] });
    writeFileSync(p, '{ 壊れた');
    await expect(modifyConfig(p, 'uploadProjects', () => ['c'])).rejects.toThrow(/書き換えません/);
    expect(readFileSync(p, 'utf8')).toBe('{ 壊れた');
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('書き換えはロック(<設定>.lock)で 1 つずつ行い、重なっても先に書いた分を消さない。残ったロックは、古ければ消して取り直し、新しければ消えるまで待つ', async () => {
    const p = join(dir, 'lock.json');
    writeFileSync(p, '{}');
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => modifyConfig(p, 'uploadProjects', (c) => [...(c.uploadProjects ?? []), n])));
    expect((JSON.parse(readFileSync(p, 'utf8')).uploadProjects as string[]).sort()).toEqual([...names].sort());
    expect(existsSync(`${p}.lock`)).toBe(false);
    // 落ちた処理が残した古いロック(10 秒より前)は消して取り直す
    writeFileSync(`${p}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${p}.lock`, old, old);
    await updateConfig(p, 'uploadRoot', dir);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadRoot).toBe(dir);
    expect(existsSync(`${p}.lock`)).toBe(false);
    // 新しいロック(別の処理が書いている最中)は、消えるまで待ってから書く
    writeFileSync(`${p}.lock`, '');
    let released = false;
    setTimeout(() => {
      released = true;
      rmSync(`${p}.lock`);
    }, 200);
    await updateConfig(p, 'uploadProjects', ['after']);
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).uploadProjects).toEqual(['after']);
  });
});

describe('--config', () => {
  it('extract・all・serve・group upload でだけ使える', () => {
    expect(parseCli(['--config', 'c.json'])).toMatchObject({ command: 'all', config: 'c.json' });
    expect(parseCli(['extract', '--config', 'c.json'])).toMatchObject({ command: 'extract', config: 'c.json' });
    expect(parseCli(['build'])).toMatchObject({ config: null });
    expect(() => parseCli(['build', '--config', 'c.json'])).toThrow(UsageError);
    expect(parseCli(['serve', '--config', 'c.json'])).toMatchObject({ command: 'serve', config: 'c.json' });
    expect(parseCli(['group', 'upload', 'g', '--config', 'c.json'])).toMatchObject({ config: 'c.json' });
    expect(() => parseCli(['group', 'list', '--config', 'c.json'])).toThrow(UsageError);
  });
});
