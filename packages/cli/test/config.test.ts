import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../src/args.ts';
import { loadConfig, parseConfig, updateConfig } from '../src/config.ts';

describe('parseConfig', () => {
  it('文字列は path だけの指定、オブジェクトは形式も読む', () => {
    expect(parseConfig({ wikis: ['my-notes', { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }] })).toEqual({
      wikis: [{ path: 'my-notes' }, { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }],
      phases: null,
      uploadRoot: null,
    });
  });

  it('phases: 依頼ごとの判定の普段の工程名(2 つ以上、重複なし、前後の空白は除く)', () => {
    expect(parseConfig({ phases: [' 要件定義', '実装 ', 'テスト'] })).toEqual({ wikis: null, phases: ['要件定義', '実装', 'テスト'], uploadRoot: null });
    expect(() => parseConfig({ phases: ['実装'] })).toThrow(/2 つ以上/);
    expect(() => parseConfig({ phases: ['実装', '実装'] })).toThrow(/同じ名前/);
    expect(() => parseConfig({ phases: '実装' })).toThrow(/phases/);
  });

  it('wikis が無ければ null、空配列は集計なしとしてそのまま', () => {
    expect(parseConfig({})).toEqual({ wikis: null, phases: null, uploadRoot: null });
    expect(parseConfig({ wikis: [] })).toEqual({ wikis: [], phases: null, uploadRoot: null });
  });

  it('uploadRoot: グループのアップロード先はフルパスだけ(~/ はホーム、前後の空白と引用符は除く)', () => {
    const abs = join(tmpdir(), 'atlas-logs');
    expect(parseConfig({ uploadRoot: ` "${abs}" ` }).uploadRoot).toBe(abs);
    expect(parseConfig({ uploadRoot: '~/atlas-logs' }).uploadRoot).toBe(join(homedir(), 'atlas-logs'));
    expect(() => parseConfig({ uploadRoot: 'atlas-logs' })).toThrow(/フルパス/);
    expect(() => parseConfig({ uploadRoot: '' })).toThrow(/uploadRoot/);
    expect(() => parseConfig({ uploadRoot: 1 })).toThrow(/uploadRoot/);
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
    await expect(loadConfig(missing, false)).resolves.toEqual({ path: null, wikis: null, phases: null, uploadRoot: null });
    await expect(loadConfig(missing, true)).rejects.toThrow(/ありません/);
  });

  it('BOM 付きを読み、壊れた JSON はファイル名付きで失敗する', async () => {
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '\uFEFF{"wikis":["notes"]}');
    await expect(loadConfig(ok, true)).resolves.toEqual({ path: ok, wikis: [{ path: 'notes' }], phases: null, uploadRoot: null });
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
