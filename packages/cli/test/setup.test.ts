// 初期設定(setup.bat → packages/cli/src/setup.ts): 対話の答えから atlas.config.json を書き、集計と同じ検査を通す
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { describeVault, runSetup, type SetupIo } from '../src/setup.ts';

/** 答えを順に返す io(尋ねた文と表示した行を残す) */
function scripted(answers: string[]): SetupIo & { asked: string[]; printed: string[] } {
  const asked: string[] = [];
  const printed: string[] = [];
  return {
    asked,
    printed,
    ask: async (q) => {
      asked.push(q);
      if (!answers.length) throw new Error(`答えが足りません: ${q}`);
      return answers.shift()!;
    },
    print: (l) => printed.push(l),
  };
}

describe('初期設定', () => {
  let d: string;
  let configPath: string;
  let home: string;
  let vault: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'atlas-setup-'));
    configPath = join(d, 'atlas.config.json');
    home = join(d, '.copilot');
    await mkdir(join(home, 'skills', 'wiki-query'), { recursive: true });
    await mkdir(join(home, 'skills', 'other'), { recursive: true });
    vault = join(d, 'my vault');
    await mkdir(join(vault, 'wiki'), { recursive: true });
    await writeFile(join(vault, 'index.md'), '# index');
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('ドラッグしたフォルダはフォルダ名だけにし、中の wiki/ と index.md を見る。無いフォルダは入力のまま', () => {
    expect(describeVault(`"${vault}\\"`)).toMatchObject({ name: 'my vault', hasIndex: true, pagesDir: 'wiki' });
    expect(describeVault('work/notes')).toEqual({ name: 'work/notes', dir: null, hasIndex: false, pagesDir: null });
  });

  it('vault・ページのフォルダ・wiki の skill・工程名を尋ねて書き、集計と同じ形で読める', async () => {
    // 1 つ目: フォルダ・ページ(既定の wiki)・候補の skill・追加の skill。2 つ目: 名前だけ(候補の skill は 1 度しか尋ねない)
    // 3 つ目: アップロード先。無いフォルダと相対パスは尋ね直す
    const logs = join(d, 'atlas logs');
    await mkdir(logs);
    const io = scripted([`"${vault}"`, '', 'y', 'my-wiki-skill', 'second', '', '', '', '設計 / 実装 / テスト', join(d, 'none'), 'relative', `"${logs}\\"`, '']);
    const r = await runSetup(io, { configPath, copilotHome: home });
    expect(r.written).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      wikis: [{ path: 'my vault', pages: ['wiki'], skills: ['wiki-query', 'my-wiki-skill'] }, 'second'],
      phases: ['設計', '実装', 'テスト'],
      uploadRoot: logs,
    });
    expect(io.printed.join('\n')).toMatch(/フォルダが見つかりません/);
    expect(io.printed.join('\n')).toMatch(/フルパスで指定してください/);
    const c = await loadConfig(configPath, true);
    expect(c.uploadRoot).toBe(logs);
    expect(c.wikis?.map((w) => w.path)).toEqual(['my vault', 'second']);
    expect(c.phases).toEqual(['設計', '実装', 'テスト']);
  });

  it('既存の設定はそのままにでき(まとめて送るプロジェクトも残す)、書く前に .bak に退避する。工程名の誤りは尋ね直す', async () => {
    await writeFile(configPath, JSON.stringify({ wikis: [{ path: 'old', pages: ['wiki'] }], phases: ['a', 'b'], uploadRoot: d, uploadProjects: ['owner/app'] }));
    const io = scripted(['', '1つだけ', 'x / x', 'x / y', '', '']);
    await runSetup(io, { configPath, copilotHome: home });
    // まとめて送るプロジェクトは尋ねずに残す(画面の「プロジェクト別」で選ぶもの)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ wikis: [{ path: 'old', pages: ['wiki'] }], phases: ['x', 'y'], uploadRoot: d, uploadProjects: ['owner/app'] });
    expect(io.printed.join('\n')).toMatch(/まとめて送るプロジェクト.1 件.は、今の設定のまま残します/);
    expect(JSON.parse(await readFile(`${configPath}.bak`, 'utf8')).phases).toEqual(['a', 'b']);
    expect(io.printed.join('\n')).toMatch(/phases は 2 つ以上指定してください/);
    expect(io.printed.join('\n')).toMatch(/phases に同じ名前が 2 回あります/);
  });

  it('何も指定しなければ空の設定、最後に断れば書かない', async () => {
    const io = scripted(['', '', '', 'n']);
    const r = await runSetup(io, { configPath, copilotHome: join(d, 'none') });
    expect(r).toEqual({ written: false, config: {} });
    expect(existsSync(configPath)).toBe(false);
  });
});
