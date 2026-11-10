// 初期設定(setup.bat から呼ぶ): llm-wiki の vault と普段の工程名、グループのアップロード先を対話で尋ね、リポジトリ直下の atlas.config.json を書く。
// 書く前に parseConfig で検査し、既存の設定は atlas.config.json.bak に退避する。集計はしない(atlas.bat で行う)。
import { existsSync, statSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PHASE_NAMES, readInventory, type WikiSpec } from '../../core/src/index.ts';
import { CONFIG_FILE, loadConfig, parseConfig, parseUploadRoot } from './config.ts';

export interface SetupIo {
  /** 1 行を尋ねる(前後の空白は取り除いて返す) */
  ask(question: string): Promise<string>;
  print(line: string): void;
}

export interface SetupOptions {
  /** 書く設定ファイル */
  configPath: string;
  /** Copilot のデータの場所(インストール済み skill の候補を出すのに使う) */
  copilotHome: string;
}

/** 書く設定の中身(atlas.config.json と同じ形) */
export interface ConfigJson {
  wikis?: (string | WikiSpec)[];
  phases?: string[];
  uploadRoot?: string;
  /** upload-project.bat がまとめて送るプロジェクト(画面の「プロジェクト別」で選ぶ。setup.bat では尋ねず、今の設定を残す) */
  uploadProjects?: string[];
}

const yes = (a: string, def: boolean): boolean => (a === '' ? def : /^(?:y|yes|はい|ｙ)$/i.test(a));
const list = (a: string): string[] =>
  a
    .split(/[,、/／\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
/** ドラッグで入る引用符と、末尾の区切りを取る */
const unquote = (a: string): string => a.replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');

/**
 * 入力された vault を、設定に書く指定にする。実在するフォルダならフォルダ名だけにし(docs/cli.md「path はフォルダ名だけの指定が確実」)、
 * 中を見て索引(index.md)と個別ページのフォルダ(wiki/)の有無を返す。実在しなければ入力をそのまま名前として使う
 */
export function describeVault(input: string): { name: string; dir: string | null; hasIndex: boolean; pagesDir: string | null } {
  const raw = unquote(input.trim());
  const full = /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(2)) : raw;
  let dir: string | null = null;
  try {
    if (/[\\/:]/.test(full) && statSync(full).isDirectory()) dir = resolve(full);
  } catch {
    dir = null;
  }
  if (!dir) return { name: raw.replace(/\\/g, '/'), dir: null, hasIndex: false, pagesDir: null };
  const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
  return { name: basename(dir), dir, hasIndex: existsSync(join(dir, 'index.md')), pagesDir: isDir(join(dir, 'wiki')) ? 'wiki' : null };
}

/** インストール済みの skill のうち、名前に wiki を含むもの(wiki の skill として数える候補) */
export async function wikiSkillCandidates(copilotHome: string): Promise<string[]> {
  const inv = await readInventory(copilotHome);
  const names = new Set([...inv.skills, ...inv.plugins.flatMap((p) => p.skills)]);
  return [...names].filter((n) => /wiki/i.test(n)).sort();
}

/** skills はまだ尋ねていない skill の候補(尋ねたら空にする。skill は vault をまたいで数えるので、同じ候補を何度も尋ねない) */
async function askVault(io: SetupIo, skills: string[]): Promise<WikiSpec | null> {
  const a = await io.ask('vault のフォルダをこの窓にドラッグするか、フォルダ名を入力して Enter(終わるときは何も入れずに Enter): ');
  if (a === '') return null;
  const v = describeVault(a);
  if (!/[^./\\~\s]/.test(v.name)) {
    io.print('  フォルダ名を読めませんでした。もう一度入力してください。');
    return askVault(io, skills);
  }
  const spec: WikiSpec = { path: v.name };
  if (v.dir) io.print(`  → フォルダ名「${v.name}」で登録します(フルパスより、エージェントの書き方の違いに強いため)`);
  else io.print(`  → 「${v.name}」で登録します(フォルダが見つからないので、中の確認はしません)`);
  if (v.dir && !v.hasIndex) {
    const idx = await io.ask('  index.md がありません。索引のファイル名を入力してください(vault からの相対。無ければ Enter): ');
    if (idx) spec.index = list(idx);
  }
  const pagesDefault = v.pagesDir ?? '.';
  const pages = await io.ask(`  個別ページを置くフォルダ(vault からの相対。. は vault 全体。Enter で ${pagesDefault}): `);
  const p = pages === '' ? [pagesDefault] : list(pages);
  if (!(p.length === 1 && p[0] === '.')) spec.pages = p;
  if (skills.length) {
    io.print(`  インストール済みの skill に、名前に wiki を含むものがあります: ${skills.join(', ')}`);
    if (yes(await io.ask('  これらを wiki の skill として数えますか？ [Y/n]: '), true)) spec.skills = [...skills];
    skills.length = 0;
  }
  const more = await io.ask('  ほかに wiki の skill として数える名前があれば入力してください(, 区切り。無ければ Enter): ');
  if (more) spec.skills = [...new Set([...(spec.skills ?? []), ...list(more)])];
  return spec;
}

/** 指定を設定ファイルに書く形にする(path だけなら文字列) */
const compact = (s: WikiSpec): string | WikiSpec => (Object.keys(s).length === 1 ? s.path : s);

export async function runSetup(io: SetupIo, o: SetupOptions): Promise<{ written: boolean; config: ConfigJson }> {
  io.print('');
  io.print('== agent-session-atlas の初期設定 ==');
  io.print(`設定ファイル: ${o.configPath}`);
  let current: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    current = await loadConfig(o.configPath, false);
  } catch (e) {
    io.print(`今の設定ファイルを読めません(${(e as Error).message})。作り直します。`);
  }
  const config: ConfigJson = {};

  io.print('');
  io.print('[1/3] llm-wiki の vault(参照を数える wiki のフォルダ。指定しないと wiki の参照は 0 件のままです)');
  let keepWikis = false;
  if (current?.wikis?.length) {
    io.print(`  今の設定: ${current.wikis.map((w) => w.path).join(', ')}`);
    keepWikis = yes(await io.ask('  このままにしますか？ [Y/n]: '), true);
    if (keepWikis) config.wikis = current.wikis.map(compact);
  }
  if (!keepWikis) {
    const skills = await wikiSkillCandidates(o.copilotHome).catch(() => []);
    const wikis: WikiSpec[] = [];
    for (;;) {
      const w = await askVault(io, skills);
      if (!w) break;
      wikis.push(w);
      io.print('  別の vault も数えるなら続けて入力してください。');
    }
    if (wikis.length) config.wikis = wikis.map(compact);
    else io.print('  vault は指定しません(wiki の参照は数えません)。');
  }

  io.print('');
  io.print('[2/3] 普段の工程名(依頼ごとの採用の判定で、LLM に選ばせる工程)');
  const def = current?.phases ?? [...DEFAULT_PHASE_NAMES];
  io.print(`  ${current?.phases ? '今の設定' : '既定'}: ${def.join(' / ')}`);
  for (;;) {
    const a = await io.ask('  このままなら Enter。変えるときは工程名を / か , 区切りで入力(2 つ以上): ');
    if (a === '') {
      if (current?.phases) config.phases = current.phases;
      break;
    }
    const phases = list(a);
    try {
      parseConfig({ phases });
      config.phases = phases;
      break;
    } catch (e) {
      io.print(`  ${(e as Error).message}。もう一度入力してください。`);
    }
  }

  io.print('');
  io.print('[3/3] グループのアップロード先(画面のグループの「アップロード」で、<この場所>\\<グループ名>\\<セッション ID>\\ に写します)');
  if (current?.uploadRoot) io.print(`  今の設定: ${current.uploadRoot}`);
  for (;;) {
    const a = unquote(await io.ask(`  フォルダをこの窓にドラッグするか、フルパスを入力して Enter(${current?.uploadRoot ? 'このままなら' : '決めないなら'}何も入れずに Enter。画面からも決められます): `));
    if (a === '') {
      if (current?.uploadRoot) config.uploadRoot = current.uploadRoot;
      break;
    }
    try {
      const root = parseUploadRoot(a);
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        io.print(`  フォルダが見つかりません: ${root}(先にフォルダを作ってから入力してください)`);
        continue;
      }
      config.uploadRoot = root;
      break;
    } catch (e) {
      io.print(`  ${(e as Error).message}。もう一度入力してください。`);
    }
  }

  // まとめて送るプロジェクトは画面で選ぶものなので尋ねず、今の設定をそのまま残す
  if (current?.uploadProjects) {
    config.uploadProjects = current.uploadProjects;
    io.print('');
    io.print(`upload-project.bat でまとめて送るプロジェクト(${current.uploadProjects.length} 件)は、今の設定のまま残します(変えるときは atlas.bat の画面の「プロジェクト別」で)。`);
  }

  parseConfig(config); // 書く前に、集計が読むのと同じ検査を通す
  const text = `${JSON.stringify(config, null, 2)}\n`;
  io.print('');
  io.print('書き込む内容:');
  for (const l of text.trimEnd().split('\n')) io.print(`  ${l}`);
  if (!yes(await io.ask(`${CONFIG_FILE} に書きますか？ [Y/n]: `), true)) {
    io.print('書きませんでした。');
    return { written: false, config };
  }
  if (existsSync(o.configPath)) {
    await copyFile(o.configPath, `${o.configPath}.bak`);
    io.print(`前の設定を ${o.configPath}.bak に退避しました。`);
  }
  await writeFile(o.configPath, text);
  io.print(`${o.configPath} を書きました。atlas.bat をダブルクリックすると、この設定で集計します。`);
  return { written: true, config };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // rl.question は入力を流し込んだとき(パイプ)に、尋ねる前に届いた行を落とすので、行の反復子から 1 行ずつ読む
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const io: SetupIo = {
    ask: async (q) => {
      process.stdout.write(q);
      const r = await lines.next();
      if (r.done) throw new Error('入力が途中で終わりました(何も書いていません)');
      return r.value.trim();
    },
    print: (l) => process.stdout.write(`${l}\n`),
  };
  const configPath = join(ROOT, CONFIG_FILE);
  if (process.env.ATLAS_CONFIG) io.print(`注意: 環境変数 ATLAS_CONFIG(${process.env.ATLAS_CONFIG})が設定されています。集計はそちらを読むので、ここで書く ${configPath} は使われません。`);
  try {
    await runSetup(io, { configPath, copilotHome: resolve(process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot')) });
    process.exitCode = 0;
  } catch (e) {
    process.stderr.write(`setup: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
