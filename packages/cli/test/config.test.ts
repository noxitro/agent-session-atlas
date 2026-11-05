import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../src/args.ts';
import { loadConfig, parseConfig } from '../src/config.ts';

describe('parseConfig', () => {
  it('文字列は path だけの指定、オブジェクトは形式も読む', () => {
    expect(parseConfig({ wikis: ['my-notes', { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }] })).toEqual({
      wikis: [{ path: 'my-notes' }, { path: 'D:/brain', index: ['README.md'], pages: ['.'], extensions: ['.org'], skills: [] }],
      phases: null,
    });
  });

  it('phases: 依頼ごとの判定の普段の工程名(2 つ以上、重複なし、前後の空白は除く)', () => {
    expect(parseConfig({ phases: [' 要件定義', '実装 ', 'テスト'] })).toEqual({ wikis: null, phases: ['要件定義', '実装', 'テスト'] });
    expect(() => parseConfig({ phases: ['実装'] })).toThrow(/2 つ以上/);
    expect(() => parseConfig({ phases: ['実装', '実装'] })).toThrow(/同じ名前/);
    expect(() => parseConfig({ phases: '実装' })).toThrow(/phases/);
  });

  it('wikis が無ければ null、空配列は集計なしとしてそのまま', () => {
    expect(parseConfig({})).toEqual({ wikis: null, phases: null });
    expect(parseConfig({ wikis: [] })).toEqual({ wikis: [], phases: null });
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
    await expect(loadConfig(missing, false)).resolves.toEqual({ path: null, wikis: null, phases: null });
    await expect(loadConfig(missing, true)).rejects.toThrow(/ありません/);
  });

  it('BOM 付きを読み、壊れた JSON はファイル名付きで失敗する', async () => {
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, '\uFEFF{"wikis":["notes"]}');
    await expect(loadConfig(ok, true)).resolves.toEqual({ path: ok, wikis: [{ path: 'notes' }], phases: null });
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    await expect(loadConfig(bad, false)).rejects.toThrow(/bad\.json/);
  });
});

describe('--config', () => {
  it('extract と all でだけ使える', () => {
    expect(parseCli(['--config', 'c.json'])).toMatchObject({ command: 'all', config: 'c.json' });
    expect(parseCli(['extract', '--config', 'c.json'])).toMatchObject({ command: 'extract', config: 'c.json' });
    expect(parseCli(['build'])).toMatchObject({ config: null });
    expect(() => parseCli(['build', '--config', 'c.json'])).toThrow(UsageError);
  });
});
