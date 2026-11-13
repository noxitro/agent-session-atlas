// 「別のフォルダを開く」: いつもの集計(この PC の Copilot のデータ → out/)とは別に、選んだフォルダを集計して別のタブで開く。
// 選べるのは、アップロード先(全員の分)・その下の人ごとのフォルダ・プロジェクトやタスクタグのフォルダ・~/.copilot の形のフォルダ。
// フォルダごとの出力先と状態は <いつもの out>-folders/<キー>/ に置き、いつもの out/ には混ぜない(1 つの出力先に 1 つのサーバ)。
//   <キー>/folder.json … 開いたフォルダと、今の状態(集計中・表示中・失敗)。画面の一覧はこれを読む
//   <キー>/open.log    … 画面から開いたときの、集計の出力(進み具合と失敗の理由)
//   <キー>/out/        … 集計の出力先(atlas.html など)
//   <キー>/built.json  … 前に集計したときの入力の印(何も変わっていなければ、作り直さずに使い回す。open-reuse.ts)
// メモとタスクタグは <notes-dir>/folders/<キー>/ に分ける。
// 設定ファイル(atlas.config.json)には書かない: 知らない項目があると前の版の atlas が設定を読めなくなる。
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { describeSource, UPLOAD_PROBE_HINT, type SourceShape } from '../../core/src/index.ts';
import { alive, JOB_ENV, JOB_LOCK_FILE, MAIN_TS, withThreadPool } from './jobs.ts';
import { BUILT_FILE } from './open-reuse.ts';

export const FOLDER_STATE_FILE = 'folder.json';
export const FOLDER_LOG_FILE = 'open.log';
/** 画面の一覧に出す数の上限(新しく開いた順) */
export const FOLDER_LIST_MAX = 30;

/** フォルダごとの出力先の置き場(いつもの出力先の隣。既定は <リポジトリ>/out-folders) */
export function foldersRootOf(localOut: string): string {
  return `${resolve(localOut)}-folders`;
}

/** 同じフォルダかを比べる形(Windows は大文字小文字を区別しない) */
function normalized(path: string): string {
  const p = resolve(path);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** フォルダの名前(画面に出す)。ドライブや共有の直下など、名前が取れないときはパスそのもの */
export function folderName(path: string): string {
  return basename(resolve(path)) || resolve(path);
}

/** フォルダごとの置き場の名前: <フォルダ名(40 文字まで)>-<パスのハッシュの先頭 8 桁>。同じ名前の別のフォルダを混ぜない */
export function folderKey(path: string): string {
  const slug =
    basename(resolve(path))
      .replace(/[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'folder';
  return `${slug}-${createHash('sha256').update(normalized(path)).digest('hex').slice(0, 8)}`;
}

/** キーの形(画面から受け取ったものを、置き場の下のパスに使う前に確かめる) */
export function isFolderKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff_-]{1,60}$/.test(key);
}

export interface FolderPaths {
  key: string;
  dir: string;
  out: string;
  notes: string;
  state: string;
  log: string;
  /** 前に集計したときの入力の印(open-reuse.ts) */
  built: string;
}

/** 別のフォルダを開いた(atlas open)ときの出力先か。<置き場>/<キー>/out で、隣に folder.json がある */
export function isOpenedFolderOut(outDir: string): boolean {
  const dir = resolve(outDir);
  return basename(dir) === 'out' && existsSync(join(dirname(dir), FOLDER_STATE_FILE));
}

/**
 * 読むだけの画面にするか。build(埋め込むタスクタグとメモ)とサーバ(書き換えを断るか)で同じ判定を使う。
 * 送り先から集計した(layout が flat / merged。--home でも atlas open でも)か、別のフォルダを開いた出力先なら読むだけ。
 * 読むだけのときは、タスクタグとメモは送った人が付けたものだけを出し、この PC の置き場のものは混ぜない
 */
export function isReadOnlyView(outDir: string, source: { layout?: string | null } | null | undefined): boolean {
  return source?.layout === 'flat' || source?.layout === 'merged' || isOpenedFolderOut(outDir);
}

export function folderPaths(root: string, notesBase: string, path: string): FolderPaths {
  const key = folderKey(path);
  const dir = join(resolve(root), key);
  return { key, dir, out: join(dir, 'out'), notes: join(resolve(notesBase), 'folders', key), state: join(dir, FOLDER_STATE_FILE), log: join(dir, FOLDER_LOG_FILE), built: join(dir, BUILT_FILE) };
}

export interface FolderRun {
  /** aggregating: 集計している / serving: 集計が済み、サーバが動いている / failed: 失敗した(error に理由) */
  state: 'aggregating' | 'serving' | 'failed';
  pid: number;
  at: string;
  error?: string;
}

export interface FolderState {
  version: 1;
  path: string;
  name: string;
  addedAt: string;
  openedAt: string;
  /** 画面の一覧に出すか(「一覧から外す」で false。出力は消さない) */
  listed: boolean;
  run: FolderRun | null;
}

export function readFolderState(file: string): FolderState | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<FolderState>;
    if (typeof j.path !== 'string' || !j.path) return null;
    const run = j.run && typeof j.run === 'object' && ['aggregating', 'serving', 'failed'].includes(j.run.state) && typeof j.run.pid === 'number' ? j.run : null;
    return {
      version: 1,
      path: j.path,
      name: typeof j.name === 'string' && j.name ? j.name : folderName(j.path),
      addedAt: typeof j.addedAt === 'string' ? j.addedAt : '',
      openedAt: typeof j.openedAt === 'string' ? j.openedAt : '',
      listed: j.listed !== false,
      run,
    };
  } catch {
    return null;
  }
}

export function writeFolderState(file: string, s: FolderState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}

/** 開いたことのあるフォルダ(置き場の下の folder.json)。新しく開いた順 */
export function listFolderStates(root: string): { key: string; state: FolderState }[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: { key: string; state: FolderState }[] = [];
  for (const key of names) {
    const state = readFolderState(join(root, key, FOLDER_STATE_FILE));
    if (state) out.push({ key, state });
  }
  return out.sort((a, b) => (a.state.openedAt < b.state.openedAt ? 1 : a.state.openedAt > b.state.openedAt ? -1 : a.key.localeCompare(b.key)));
}

/** 入力の誤り(フォルダが無い・集計できるものが無いなど)。画面には 400 で理由を返す */
export class FolderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface FolderInfo {
  /** 絶対パスにしたもの */
  path: string;
  name: string;
  shape: Exclude<SourceShape, { kind: 'none' }>;
  /** 何を読むか(画面と CLI に出す一文) */
  summary: string;
}

/** 名前を先頭から max 個まで並べ、残りは数で出す */
function headOf(names: string[], max: number, unit: string): string {
  return names.slice(0, max).join('、') + (names.length > max ? ` ほか ${names.length - max} ${unit}` : '');
}

/** 読むものの説明。merged は下のフォルダの数(2 段下まで読むときは、人ごとのフォルダの名前。誰の分が入るかを開く前に確かめられるように) */
export function describeShape(shape: Exclude<SourceShape, { kind: 'none' }>): string {
  if (shape.kind === 'copilot') return 'Copilot のデータの形のフォルダです(この中のセッションを集計します)';
  if (shape.kind === 'flat') return 'セッションのフォルダが並んでいます(このフォルダ 1 つを集計します)';
  const nested = shape.folders.filter((f) => f.includes('/'));
  if (nested.length === 0) return `下のフォルダ ${shape.folders.length} 件をまとめて集計します(${headOf(shape.folders, 3, '件')})`;
  const people = [...new Set(nested.map((f) => f.slice(0, f.indexOf('/'))))];
  const direct = shape.folders.length - nested.length;
  const under = `2 段下まで読み、${people.length} 個のフォルダ(${headOf(people, 5, '個')})の下にある`;
  if (direct === 0) return `${under} ${nested.length} 件のフォルダをまとめて集計します`;
  return `${under} ${nested.length} 件と、直下の ${direct} 件を合わせて、${shape.folders.length} 件のフォルダをまとめて集計します`;
}

/** 開くフォルダを確かめる(絶対パス・実在するフォルダ・集計できる形)。だめなら FolderError */
export async function checkFolder(input: unknown): Promise<FolderInfo> {
  if (typeof input !== 'string') throw new FolderError('フォルダのパスを指定してください');
  // エクスプローラーの「パスのコピー」は "…" で囲む
  const raw = input.trim().replace(/^"(.*)"$/, '$1').trim();
  if (!raw) throw new FolderError('フォルダのパスを指定してください');
  if (raw.length > 2000) throw new FolderError('パスが長すぎます');
  if (!isAbsolute(raw)) throw new FolderError(`フルパスで指定してください(例: \\\\server\\share\\logs や D:\\logs): ${raw}`);
  const path = resolve(raw);
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new FolderError(`フォルダが見つかりません(つながっていないドライブや共有フォルダかもしれません): ${path}`);
  }
  if (!isDir) throw new FolderError(`フォルダではありません: ${path}`);
  const shape = await describeSource(path);
  if (shape.kind === 'none')
    throw new FolderError(
      `このフォルダには、集計できるセッションが見つかりません: ${path}(アップロード先のフォルダ・その下の人ごとのフォルダ・プロジェクトのフォルダのどれかを指定してください。読むのは 2 段下までです。${UPLOAD_PROBE_HINT})`,
    );
  return { path, name: folderName(path), shape, summary: describeShape(shape) };
}

/** ログの最後の、空でない行(進み具合に出す)。大きくても末尾だけ読む */
export function lastLogLine(file: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    if (!size) return null;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // 末尾だけ読んだときの先頭の行は、途中で切れていることがある
    if (size > len) lines.shift();
    return lines.at(-1)?.slice(0, 300) ?? null;
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** 別のプロセスで `atlas open <フォルダ>` を始める。返すのは pid(起動できなければ null) */
export type LaunchFn = (args: string[], logFile: string) => number | null;

/** 既定の起動: process.execPath を shell なしで、このサーバから切り離して動かす(このサーバが止まっても、開いたフォルダのサーバは残る)。出力は open.log へ */
export const launchDetached: LaunchFn = (args, logFile) => {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'w');
  try {
    const env = { ...process.env };
    delete env[JOB_ENV];
    const c = nodeSpawn(process.execPath, args, { shell: false, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: withThreadPool(env) });
    c.on('error', () => {});
    c.unref();
    return c.pid ?? null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
};

export type FolderStatus = 'current' | 'open' | 'starting' | 'failed' | 'idle';

export interface FolderEntry {
  key: string;
  path: string;
  name: string;
  openedAt: string;
  /** current: この画面が出しているフォルダ / open: 別のタブで開いている / starting: 集計している / failed: 失敗した / idle: 開いていない */
  status: FolderStatus;
  /** 開いているレポートの URL(open のとき) */
  url: string | null;
  error: string | null;
  /** 集計の進み具合(starting のとき。ログの最後の行) */
  progress: string | null;
}

export interface FolderList {
  canPick: boolean;
  /** この画面が出しているフォルダ(いつもの集計なら null) */
  current: { path: string; name: string } | null;
  /** いつもの集計(この PC のセッション)。current: この画面 / open: 別のタブで開いている / idle: 開いていない(atlas.bat で開く) */
  local: { status: 'current' | 'open' | 'idle'; url: string | null };
  folders: FolderEntry[];
}

export interface FolderContext {
  /** フォルダごとの出力先の置き場 */
  root: string;
  /** いつものメモとタスクタグの置き場(フォルダごとの分は、この下の folders/<キー>/) */
  notesBase: string;
  /** いつもの出力先 */
  localOut: string;
  /** このサーバが出しているフォルダ(いつもの集計なら null) */
  current: string | null;
  canPick: boolean;
  /** その出力先でサーバが動いていれば、ポート */
  findRunning: (outDir: string) => Promise<{ port: number } | null>;
  launch: LaunchFn;
  /** `atlas open` に足す引数(--config・--no-open) */
  extraArgs: string[];
  /** 起動の途中のキー(続けて押しても 2 つ起動しない) */
  pending: Set<string>;
}

/** 起動してからこの時間は、プロセスがあれば動いているとみなす(集計の印を置く前・サーバが応え始める前) */
const RUN_GRACE_MS = 60_000;

/**
 * 記録にある処理(集計・配信)が、まだ動いているか。プロセスの番号は使い回されるので、番号があるだけでは動いているとみなさない:
 * 集計は、出力先の印(.job.json)が同じ番号のものであること。配信は、サーバが応えないまま RUN_GRACE_MS を過ぎたら止まったとみなす
 * (黒い窓を閉じて止めた後に、同じ番号の別のプロセスがあっても、開き直せるように)
 */
export function runLive(run: FolderRun | null, outDir: string, now = Date.now()): boolean {
  if (!run || run.state === 'failed' || !alive(run.pid)) return false;
  const age = now - Date.parse(run.at);
  if (Number.isFinite(age) && age >= 0 && age < RUN_GRACE_MS) return true;
  if (run.state !== 'aggregating') return false;
  try {
    return (JSON.parse(readFileSync(join(outDir, JOB_LOCK_FILE), 'utf8')) as { pid?: number }).pid === run.pid;
  } catch {
    return false;
  }
}

const reportUrl = (port: number): string => `http://127.0.0.1:${port}/atlas.html`;

async function entryOf(ctx: FolderContext, key: string, state: FolderState): Promise<FolderEntry> {
  const dir = join(ctx.root, key);
  const base = { key, path: state.path, name: state.name, openedAt: state.openedAt, url: null, error: null, progress: null };
  if (ctx.current && folderKey(ctx.current) === key) return { ...base, status: 'current' };
  const running = await ctx.findRunning(join(dir, 'out'));
  if (running) return { ...base, status: 'open', url: reportUrl(running.port) };
  const run = state.run;
  if (ctx.pending.has(key)) return { ...base, status: 'starting' };
  if (!run) return { ...base, status: 'idle' };
  if (run.state === 'failed') return { ...base, status: 'failed', error: run.error ?? '失敗しました' };
  if (runLive(run, join(dir, 'out'))) return { ...base, status: 'starting', progress: run.state === 'aggregating' ? lastLogLine(join(dir, FOLDER_LOG_FILE)) : null };
  if (run.state === 'aggregating') return { ...base, status: 'failed', error: `集計が途中で止まりました(記録: ${join(dir, FOLDER_LOG_FILE)})` };
  return { ...base, status: 'idle' };
}

/** 画面の一覧: 開いたことのあるフォルダと、今の状態 */
export async function listFolders(ctx: FolderContext): Promise<FolderList> {
  const states = listFolderStates(ctx.root)
    .filter((x) => x.state.listed || (ctx.current != null && folderKey(ctx.current) === x.key))
    .slice(0, FOLDER_LIST_MAX);
  const folders = await Promise.all(states.map((x) => entryOf(ctx, x.key, x.state)));
  let local: FolderList['local'] = { status: 'current', url: null };
  if (ctx.current) {
    const running = await ctx.findRunning(ctx.localOut);
    local = running ? { status: 'open', url: reportUrl(running.port) } : { status: 'idle', url: null };
  }
  return { canPick: ctx.canPick, current: ctx.current ? { path: ctx.current, name: folderName(ctx.current) } : null, local, folders };
}

/** `atlas open <フォルダ>` の引数(process.execPath の後ろ)。画面からの文字列はフォルダのパスだけで、確かめた後の絶対パスを 1 つの引数として渡す */
export function openArgs(ctx: Pick<FolderContext, 'localOut' | 'notesBase' | 'extraArgs'>, path: string, main = MAIN_TS): string[] {
  return [main, 'open', path, '--out', ctx.localOut, '--notes-dir', ctx.notesBase, ...ctx.extraArgs];
}

/** 画面の「開く」: 開いていればその URL を返し、開いていなければ別のプロセスで集計を始める */
export async function openFolderReport(ctx: FolderContext, input: unknown): Promise<FolderEntry> {
  const info = await checkFolder(input);
  const fp = folderPaths(ctx.root, ctx.notesBase, info.path);
  const prev = readFolderState(fp.state);
  const now = new Date().toISOString();
  const base: Omit<FolderState, 'run'> = { version: 1, path: info.path, name: info.name, addedAt: prev?.addedAt || now, openedAt: now, listed: true };
  if (ctx.current && folderKey(ctx.current) === fp.key) return entryOf(ctx, fp.key, { ...base, run: prev?.run ?? null });
  if (ctx.pending.has(fp.key)) return entryOf(ctx, fp.key, { ...base, run: prev?.run ?? null });
  ctx.pending.add(fp.key);
  try {
    const running = await ctx.findRunning(fp.out);
    const busy = !running && runLive(prev?.run ?? null, fp.out);
    if (running || busy) {
      // 開いている・集計しているものは、そのまま使う(一覧に戻し、開いた日時だけ新しくする)
      writeFolderState(fp.state, { ...base, run: prev?.run ?? null });
    } else {
      const pid = ctx.launch(openArgs(ctx, info.path), fp.log);
      writeFolderState(fp.state, { ...base, run: pid ? { state: 'aggregating', pid, at: now } : { state: 'failed', pid: 0, at: now, error: '集計を始められませんでした(node を起動できません)' } });
    }
  } finally {
    ctx.pending.delete(fp.key);
  }
  return entryOf(ctx, fp.key, readFolderState(fp.state) ?? { ...base, run: null });
}

/** 画面の「一覧から外す」: 一覧に出さなくする(出力先とメモは消さない。同じフォルダを開けば戻る) */
export function forgetFolder(ctx: Pick<FolderContext, 'root'>, key: unknown): void {
  if (!isFolderKey(key)) throw new FolderError('フォルダの指定が正しくありません');
  const file = join(ctx.root, key, FOLDER_STATE_FILE);
  const state = existsSync(file) ? readFolderState(file) : null;
  if (!state) throw new FolderError('そのフォルダは一覧にありません', 404);
  writeFolderState(file, { ...state, listed: false });
}
