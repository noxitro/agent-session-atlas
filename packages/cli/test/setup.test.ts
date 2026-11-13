// 初期設定(setup.bat → packages/cli/src/setup.ts): 対話の答えから atlas.config.json を書き、集計と同じ検査を通す
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { describeVault, runSetup, unquote, type SetupIo } from '../src/setup.ts';

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

  it('引用符と末尾の区切りを取る。Windows ではドライブの直下の区切りを残し(「C:」は今のフォルダの意味になるため)、ほかの OS では「x:」もそのまま', () => {
    for (const input of ['C:\\', 'C:', '"C:\\"', 'c:/']) expect(unquote(input, 'win32'), input).toBe(input.replace(/"/g, '').slice(0, 2) + '\\');
    expect(unquote('"D:\\logs\\"', 'win32')).toBe('D:\\logs');
    expect(unquote('x:', 'linux')).toBe('x:');
    expect(unquote('/home/me/notes/', 'linux')).toBe('/home/me/notes');
  });

  // 今のフォルダがドライブ文字の上にあるときだけ(ネットワーク上のフォルダ \\server\share では「X:」の形を作れない)
  const cwdDrive = parse(process.cwd()).root;
  const onDriveLetter = process.platform === 'win32' && /^[A-Za-z]:\\$/.test(cwdDrive);

  it.runIf(onDriveLetter)('vault: ドライブの直下は、今のフォルダと同じドライブでもフォルダ名の無い直下のまま(今のフォルダを指さない)', () => {
    for (const input of [cwdDrive, cwdDrive.slice(0, 2), `"${cwdDrive}"`]) expect(describeVault(input), input).toMatchObject({ name: '', dir: cwdDrive });
  });

  it.runIf(onDriveLetter)('アップロード先: ドライブの直下(「X:」と入れても)は、画面の設定と同じくドライブの直下として受け付ける(今のフォルダにしない)', async () => {
    // vault は終わる・工程名はそのまま・アップロード先にドライブ文字だけを入れる・書く
    const io = scripted(['', '', cwdDrive.slice(0, 2), '']);
    await runSetup(io, { configPath, copilotHome: home });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: cwdDrive });
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

  it('エクスプローラーを出せるとき: アップロード先は、まだ決めていなければ Enter で選ぶ画面を開き、取り消したら尋ね直す。vault は y で開く', async () => {
    const logs = join(d, 'atlas logs');
    await mkdir(logs);
    const picks: (string | null)[] = [vault, null, logs];
    const pickedFrom: [string, string | null][] = [];
    // vault: y で選ぶ → ページは既定 → 候補の skill は数えない → 追加なし → 終わる。工程名はそのまま。
    // アップロード先: Enter で開いて取り消す → もう一度 Enter で開いて選ぶ。最後に書く
    const io = { ...scripted(['y', '', 'n', '', '', '', '', '', '']), pick: async (title: string, initial: string | null) => (pickedFrom.push([title, initial]), picks.shift() ?? null) };
    const r = await runSetup(io, { configPath, copilotHome: home });
    expect(r.written).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ wikis: [{ path: 'my vault', pages: ['wiki'] }], uploadRoot: logs });
    expect(pickedFrom.map(([t, i]) => [t.slice(0, 6), i])).toEqual([
      ['llm-wi', null],
      ['アップロード', null],
      ['アップロード', null],
    ]);
    const text = io.printed.join('\n');
    expect(text).toContain('フォルダを選ぶ画面(エクスプローラー)を開きます');
    expect(text).toContain('選びませんでした。');
    expect(io.asked.some((q) => q.includes('Enter でエクスプローラーが開きます'))).toBe(true);
    expect(io.asked.some((q) => q.startsWith('vault を数えるなら y でエクスプローラーが開きます'))).toBe(true);
  });

  it('vault の選ぶ画面を取り消したら尋ね直す。選ぶ画面を出せなかったら、以後はドラッグかパスの入力で尋ねる(押し直しても同じ理由で出せないため)', async () => {
    const logs = join(d, 'logs');
    await mkdir(logs);
    let calls = 0;
    // vault: y → 取り消す → 尋ね直されて Enter で終わる。工程名はそのまま。
    // アップロード先: Enter → 画面を出せない → 以後は入力で尋ねるので、パスを入力。最後に書く
    const io = {
      ...scripted(['y', '', '', '', logs, '']),
      pick: async (): Promise<string | null> => {
        if (++calls === 1) return null;
        throw new Error('フォルダを選ぶ画面を出せませんでした(テスト)');
      },
    };
    await runSetup(io, { configPath, copilotHome: home });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: logs });
    expect(calls).toBe(2);
    expect(io.asked.filter((q) => q.startsWith('vault を数えるなら y'))).toHaveLength(2);
    expect(io.printed.join('\n')).toContain('フォルダを選ぶ画面を出せませんでした(テスト)。以後は、フォルダをこの窓にドラッグするか、パスを入力して決めてください。');
    // 出せなかった後は、Enter で開く案内をやめ、入力で尋ねる
    expect(io.asked.at(-2)).toMatch(/^ {2}フォルダをこの窓にドラッグするか、フルパスを入力して Enter/);
  });

  it('決めてあるアップロード先は Enter か n でそのまま、y で今の場所から選ぶ画面を開く', async () => {
    const a = join(d, 'a');
    const b = join(d, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(configPath, JSON.stringify({ uploadRoot: a }));
    const never = async (): Promise<string | null> => {
      throw new Error('開かないはず');
    };
    // vault は終わる・工程名はそのまま・アップロード先は Enter でそのまま・書く
    const keep = { ...scripted(['', '', '', '']), pick: never };
    await runSetup(keep, { configPath, copilotHome: home });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: a });
    expect(keep.asked.some((q) => q.includes('このままなら Enter。変えるなら y でエクスプローラーが開きます'))).toBe(true);
    // y → 今の場所から開いて b を選ぶ
    const initials: (string | null)[] = [];
    const change = {
      ...scripted(['', '', 'y', '']),
      pick: async (_t: string, initial: string | null): Promise<string | null> => (initials.push(initial), b),
    };
    await runSetup(change, { configPath, copilotHome: home });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: b });
    expect(initials).toEqual([a]);
    // n でもそのまま
    const no = { ...scripted(['', '', 'n', '']), pick: never };
    await runSetup(no, { configPath, copilotHome: home });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ uploadRoot: b });
  });

  it('何も指定しなければ空の設定、最後に断れば書かない', async () => {
    const io = scripted(['', '', '', 'n']);
    const r = await runSetup(io, { configPath, copilotHome: join(d, 'none') });
    expect(r).toEqual({ written: false, config: {} });
    expect(existsSync(configPath)).toBe(false);
  });
});
