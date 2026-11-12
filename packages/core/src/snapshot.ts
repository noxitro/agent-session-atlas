import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readDesktopDb } from './desktop.ts';
import { openWritable, sqlString } from './sqlite.ts';
import { renameReplacing } from './fs-retry.ts';
import type { InstalledInventory } from './types.ts';

/** 複製する SQLite(ルート直下)。data.db(デスクトップアプリ)は資格情報列を含むので複製せず、Phase 11 から許可リストの列だけを desktop.json に書く */
export const SNAPSHOT_DBS = ['session-store.db'] as const;
/** 以前のバージョンが複製していたが今は複製しないファイル。snapshot 時に残っていれば消す */
export const SNAPSHOT_STALE_FILES = ['data.db'] as const;
export const SNAPSHOT_SESSION_FILES = ['workspace.yaml', 'events.jsonl'] as const;
/**
 * アップロードしたセッションのフォルダに添える、session-store.db のそのセッションの行(atlas が書く。Copilot のファイルではない)。
 * 生ログ(events.jsonl など)だけだと、DB にしか無いトークン数・依頼の記録が欠けるため。extract はこれも読む
 */
export const SESSION_STORE_JSON = 'atlas-session-store.json';
/**
 * アップロードしたセッションのフォルダに添える、送った側の記録(題名・プロジェクト名とその決め方・タスクタグ・日時)。
 * アップロード先から集計し直すとき、extract はプロジェクト名をここから取る(読む側の PC のディスクからは決めない)
 */
export const UPLOAD_SESSION_META = 'atlas-session.json';
/** アップロード先のフォルダ(グループ・プロジェクト)の索引。写すたびに書き直す */
export const UPLOAD_INDEX = 'atlas-index.json';
/**
 * アップロード先のフォルダ(グループ・プロジェクト)に添える、送った人がインストールしている skill・プラグインの名前
 * (readInventory と同じ形。中身は読まず名前だけ)。送るたびに書き直す。集計し直すときは「インストール済みで未使用の skill」に使う
 */
export const UPLOAD_INSTALLED = 'atlas-installed.json';
/** アップロードがセッションのフォルダを置き換えるときの作業用のフォルダ(写している途中のもの) */
export const uploadTmpName = (id: string): string => `.${id}.uploading`;
/** アップロードがセッションのフォルダを置き換えるときに退けた、前のフォルダ(消せなかったときに残る) */
export const uploadOldName = (id: string): string => `.${id}.old`;
/** アップロードの作業用のフォルダの名前から、セッションの id を取る(作業用のフォルダの名前でなければ null) */
export const uploadWorkDirId = (name: string): string | null => /^\.(.+)\.(?:uploading|old)$/.exec(name)?.[1] ?? null;
/** アップロードの作業用のフォルダの名前か(uploadTmpName / uploadOldName)。中身はセッションの複製だが、セッションとして数えない */
export const isUploadWorkDir = (name: string): boolean => uploadWorkDirId(name) != null;
/** アップロードで、送った人のメモを入れるファイル(セッションのフォルダの直下)と、その画像のフォルダ。本文の画像は atlas-memo/<名前> で参照する */
export const UPLOAD_MEMO_FILE = 'atlas-memo.md';
export const UPLOAD_MEMO_IMAGES = 'atlas-memo';
/**
 * 送った人のメモの上限(共有フォルダに置かれたものなので、大きすぎるものは写さず、読まない)。
 * 本文はこの PC でメモを保存できる大きさ(要求の本文 1 MB)と同じ。画像のフォルダは 1 セッションの合計
 */
export const UPLOAD_MEMO_TEXT_LIMIT = 1024 * 1024;
export const UPLOAD_MEMO_IMAGES_LIMIT = 100 * 1024 * 1024;
/**
 * Phase 11: セッションフォルダの追加のファイル(あれば写す)。SESSION_STORE_JSON・UPLOAD_SESSION_META・UPLOAD_MEMO_FILE はアップロード先から集計し直すときだけある
 * (送った人のメモは、別のフォルダを開いた画面で読むだけで出す)
 */
export const SNAPSHOT_SESSION_EXTRA_FILES = ['plan.md', 'vscode.metadata.json', SESSION_STORE_JSON, UPLOAD_SESSION_META, UPLOAD_MEMO_FILE] as const;
/** Phase 11: セッションフォルダの追加のサブフォルダ(あれば再帰的に写す)。UPLOAD_MEMO_IMAGES はアップロード先から集計し直すときだけある */
export const SNAPSHOT_SESSION_EXTRA_DIRS = ['checkpoints', 'files', 'rewind-file-snapshots', 'policies', 'research', 'sandbox-denials', UPLOAD_MEMO_IMAGES] as const;
/** Phase 11: 既定では写さず --snapshot-all で写すサブフォルダ(大きい。rewind-snapshots は 1 セッションで数十 MB) */
export const SNAPSHOT_SESSION_HEAVY_DIRS = ['rewind-snapshots'] as const;
/** Phase 11: ~/.copilot 直下で写すフォルダ */
export const SNAPSHOT_TOP_DIRS = ['plans', 'attachments'] as const;
/** Phase 11: ~/.copilot 直下で既定では写さないフォルダ(--snapshot-all で写す)と理由 */
export const SNAPSHOT_TOP_HEAVY_DIRS: Record<string, string> = { logs: 'アプリのログ(資格情報を含みうる。セッションの解析には使わない)' };
/** Phase 11: 写さないフォルダ(名前と容量だけ残す)と理由 */
export const SNAPSHOT_TOP_SKIP_DIRS: Record<string, string> = { repos: 'ソースのチェックアウト(記録ではない)', chats: 'ユーザーが書き出した Markdown(*.md)だけ写し、他は無関係なファイル' };
export const DESKTOP_JSON = 'desktop.json';
/** セッションごとの SQLite(todos / todo_deps)。Phase 7 から VACUUM INTO で複製する */
export const SNAPSHOT_SESSION_DB = 'session.db';
/** 複製した session.db の元の指紋(サイズと mtime)。同じなら次回は複製し直さない */
const SESSION_DB_FINGERPRINT = '.session.db.src';
export const SNAPSHOT_MANIFEST = 'snapshot-manifest.json';
/**
 * 集計を始めたときに出力先に書く、元の場所の印。SNAPSHOT_MANIFEST は最後まで終わったときにしか書かないので、
 * 途中で止まった集計の後でも、出力先がどこから集計したものかが分かるようにする
 */
export const SNAPSHOT_SOURCE = 'snapshot-source.json';
/** アップロード先のフォルダが並ぶ場所かどうかを確かめるとき、索引の無いフォルダを中まで見る数の上限 */
const UPLOAD_PROBE_MAX = 20;
/** セッションが 1 件も見つからなかったときに添える案内(上限のせいで見つけられなかったフォルダの指定のしかた) */
export const UPLOAD_PROBE_HINT =
  `索引(${UPLOAD_INDEX})の無いフォルダは、名前の順で先頭の ${UPLOAD_PROBE_MAX} 個までしか中を確かめません。` +
  '前の版でアップロードしたフォルダや手で写したフォルダが見つからないときは、そのフォルダ(セッションのフォルダが直下に並ぶもの)を直接指定してください';
/** 2 段下(人ごとのフォルダの下)にアップロード先のフォルダがあるかを確かめるとき、下のフォルダ 1 つにつき索引を探す数の上限 */
const NESTED_PROBE_MAX = 50;
/** 同じく、索引の無いフォルダ(前の版が写した、手で写した)を中まで見る数の上限(下のフォルダ 1 つにつき) */
const NESTED_FLAT_PROBE_MAX = 3;

export interface SnapshotOptions {
  /** この時刻以降に更新されたセッションだけを複製する(ISO 文字列か Date) */
  since?: string | Date;
  /** Phase 11: 既定で写さない大きなもの(rewind-snapshots、一覧に無い名前のもの、logs/)も写す */
  all?: boolean;
  /** 前回 --snapshot-all で写したが今回は写さないものを消す(既定は残して manifest の extras.leftover に日時を出す) */
  prune?: boolean;
}

/** 写さなかったもの(名前と容量) */
export interface SkippedEntry {
  /** 元のルートからの相対パス(/ 区切り) */
  path: string;
  bytes: number;
  reason: string;
}

export interface SnapshotManifest {
  createdAt: string;
  sourceRoot: string;
  /**
   * 元の形。'copilot' は ~/.copilot(session-state/ の下にセッション)、'flat' はセッションのフォルダが直下に並ぶもの
   * (atlas がアップロードしたグループ・プロジェクトのフォルダ)、'merged' はそのフォルダが下(2 段下まで)に並ぶもの(まとめて読む)。
   * 古いマニフェストには無い('copilot' と同じ)
   */
  layout?: SourceLayout;
  /**
   * layout が 'merged' のとき、まとめて読んだフォルダ(元のルートからの相対パス。/ 区切り。1 段下なら名前だけ、2 段下なら <人>/<プロジェクト>。
   * 名前の順)と、同じ id のセッションが複数のフォルダにあって 1 つだけ数えたときに、数えなかったほうの数。
   * owners は、セッションの id ごとの、数えたフォルダ(folders と同じ書き方)。人ごとの内訳に使う。
   * 元から消えたセッションの複製が出力先に残っているときは、前の集計の値を引き継ぐ。古いマニフェストには無い
   */
  merged?: { folders: string[]; duplicates: number; owners?: Record<string, string> };
  since: string | null;
  /** copied が false なら今回は複製できず、前回の複製(bytes が 0 なら無し)を使っている。理由は error */
  databases: Record<string, { copied: boolean; bytes: number; attempts: number; error?: string }>;
  sessions: { dirs: number; copiedFiles: number; reusedFiles: number; skippedBySince: number; bytes: number; dbCopied?: number; dbReused?: number };
  /** session.db を複製できなかったセッションと理由(Phase 7) */
  sessionDbErrors?: string[];
  /** インストール済みの skill / プラグインの名前(Phase 6。古いマニフェストには無い) */
  installed?: InstalledInventory;
  /** Phase 11: 追加で写したもの(セッションフォルダの中身と ~/.copilot 直下)と、写さなかったもの */
  extras?: {
    all: boolean;
    sessionFiles: number;
    sessionBytes: number;
    topLevel: Record<string, { files: number; bytes: number }>;
    skipped: SkippedEntry[];
    /** data.db(許可リストの列だけ)を desktop.json に書いたか。無ければ false。読めなければ理由 */
    desktop: { written: boolean; sessions: number; warnings: string[] } | null;
    /** 前回 --snapshot-all で写したが今回は写さなかったもの(残してある。--snapshot-prune で消す) */
    leftover: { path: string; mtime: string }[];
    /**
     * アップロードの置き換えの途中で止まって本体のフォルダ(<id>)が無かったため、写し終えていた作業用のフォルダ(.<id>.uploading)から
     * 今回写したセッション(path は元のルートからの相対パス)。無ければ項目ごと無い
     */
    recovered?: { id: string; path: string }[];
  };
}

export type SourceLayout = 'copilot' | 'flat' | 'merged';

/**
 * 集計の元に指したフォルダの形。
 * - copilot: ~/.copilot(session-state/ か session-store.db がある)
 * - flat: セッションのフォルダが直下に並ぶ(アップロードしたグループ・プロジェクトのフォルダ)
 * - merged: flat のフォルダが下に並ぶ。folders(src からの相対パス。/ 区切り)を 1 つのレポートにまとめて読む。
 *   1 段下に並ぶもの(人ごとのフォルダなど。folders は名前だけ)と、2 段下に並ぶもの(送り先そのものなど。folders は <人>/<プロジェクト>)の両方
 * - none: どれでもない(セッションが 1 件も見つからない)
 */
export type SourceShape = { kind: 'copilot' } | { kind: 'flat' } | { kind: 'merged'; folders: string[] } | { kind: 'none' };

/** 集計の元に指したフォルダの形を調べる(読むだけ)。無い・読めないフォルダは none */
export async function describeSource(src: string): Promise<SourceShape> {
  if (looksLikeCopilotHome(src)) return { kind: 'copilot' };
  if (await isFlatLayout(src)) return { kind: 'flat' };
  // 1 段下: アップロードしたフォルダ(プロジェクトやグループ)
  const direct = await allUploadFolders(src);
  const isDirect = new Set(direct);
  // ~/.copilot の形のフォルダ(バックアップや、集計の出力先)は、人ごとのフォルダとしては見ない
  const rest = (await subDirs(src)).filter((n) => !isDirect.has(n) && !looksLikeCopilotHome(join(src, n)));
  // 2 段下: 直下のフォルダ(人ごとのフォルダ)の下のアップロードしたフォルダ。
  // 1 段下に 1 つも無いときは、先頭の UPLOAD_PROBE_MAX 個を軽く確かめてから読む(関係のない大きなフォルダを指したときに、2 段下まで全部読まないように)
  if (direct.length === 0 && !(await hasNestedUploadFolder(src, rest.slice(0, UPLOAD_PROBE_MAX)))) return { kind: 'none' };
  const folders = [...direct];
  for (const n of rest) for (const f of await allUploadFolders(join(src, n))) folders.push(`${n}/${f}`);
  return { kind: 'merged', folders: folders.sort() };
}

/**
 * まとめて読んだフォルダ(manifest の merged.folders・merged.owners の書き方)から、人のフォルダの名前を取り出す。
 * 2 段下のフォルダ(<人>/<プロジェクト>)なら <人>。1 段下のフォルダ(名前だけ)や、フォルダが分からないときは null
 */
export function personOfFolder(folder: string | null | undefined): string | null {
  if (!folder) return null;
  const i = folder.indexOf('/');
  return i > 0 ? folder.slice(0, i) : null;
}

/** 同じ id のセッションが複数のフォルダにあって、数えなかったほうの理由(manifest の extras.skipped) */
export const DUPLICATE_REASON = '同じ id のセッションが別のフォルダにもある(events.jsonl が大きいほうだけ数えた)';

/**
 * ~/.copilot の必要部分を dest へ複製する。元は一切書き換えない。
 * - SQLite は本体と -wal をバイト列でコピーし、コピー側から VACUUM INTO(WAL の内容も含む単一ファイル)
 * - workspace.yaml / events.jsonl はファイルコピー(サイズと mtime が同じなら再利用)
 * - session-state/<id>/session.db(todos)は session-store.db と同じ方法で複製する(元は開かない)
 * - checkpoints/ は複製しない
 */
export async function snapshot(src: string, dest: string, opts: SnapshotOptions = {}): Promise<SnapshotManifest> {
  const since = opts.since ? new Date(opts.since) : null;
  const all = !!opts.all;
  const prune = !!opts.prune;
  const extras: NonNullable<SnapshotManifest['extras']> = { all, sessionFiles: 0, sessionBytes: 0, topLevel: {}, skipped: [], desktop: null, leftover: [] };
  if (since && Number.isNaN(since.getTime())) throw new Error(`since が日時として解釈できない: ${String(opts.since)}`);
  if (!existsSync(src)) throw new Error(`元ディレクトリが無い: ${src}`);
  // アップロードしたグループ・プロジェクトのフォルダ(<送り先>\<フォルダ>\<セッション id>\events.jsonl …)は、そのフォルダを session-state/ とみなす。
  // そのフォルダが並ぶ場所(人ごとのフォルダ)と、もう 1 段上(送り先そのもの。全員の分)は、下のフォルダをまとめて読む
  const shape = await describeSource(src);
  const flat = shape.kind === 'flat';
  const merged = shape.kind === 'merged' ? shape.folders : null;
  // 出力先が別の元から作ったものなら、足さずに止める(前の元のセッションと session-store.db が残っていて、黙って混ざるため)。
  // 前の複製は消さない(元で消したログの、最後の複製かもしれない)
  // 前の元は、最後まで終わった集計の manifest と、集計を始めたときに書く印(SNAPSHOT_SOURCE)の両方で確かめる
  // (manifest は最後に書くので、途中で止まった集計の後は印しか無い)
  const marks = await previousSources(dest);
  // 前の集計が何も写していなければ(場所を間違えて 0 件だったなど)、混ざるものが無いので止めない
  const kept = marks.length > 0 && (await holdsCopies(dest));
  for (const m of marks) {
    if (await sameLocation(m.root, src)) continue;
    if (!kept) {
      // 前の元の印は消しておく(今回の集計が途中で止まったときに、前の元と比べて止めないように)
      await rm(m.file, { force: true });
      continue;
    }
    throw new Error(
      `出力先 ${dest} は、別の場所(${m.root})から集計したものです。同じ出力先に足すと両方のセッションが混ざるので止めました。別の出力先(--out)を指定してください。` +
        `フォルダを移したなど、元が同じものだと分かっているなら、${marks.map((x) => x.file).join(' と ')} を消してからやり直すと、今の出力先を使い続けます`,
    );
  }
  // 前の集計で、セッションごとに数えたフォルダ(元から消えたセッションの複製が出力先に残っているときに引き継ぐ)。
  // 別の元の manifest は上で消してあるので、ここで読めるのは同じ元のものだけ
  let previousOwners: Record<string, string> = {};
  if (merged) {
    try {
      const o = (await readSnapshotManifest(dest))?.merged?.owners;
      if (o && typeof o === 'object') previousOwners = o;
    } catch {
      /* 前の manifest が読めない(引き継がない) */
    }
  }
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, SNAPSHOT_SOURCE), `${JSON.stringify({ sourceRoot: src, startedAt: new Date().toISOString() })}\n`);

  const manifest: SnapshotManifest = {
    createdAt: new Date().toISOString(),
    sourceRoot: src,
    since: since ? since.toISOString() : null,
    databases: {},
    sessions: { dirs: 0, copiedFiles: 0, reusedFiles: 0, skippedBySince: 0, bytes: 0, dbCopied: 0, dbReused: 0 },
  };

  /** 1 セッション分を写す(workspace.yaml / events.jsonl・session.db・追加のファイル)。since より前のもので写さなかったら false */
  async function snapshotSession(name: string, dirSrc: string, present: readonly string[]): Promise<boolean> {
    if (since && !(await isUpdatedSince(dirSrc, present, since))) {
      manifest.sessions.skippedBySince++;
      return false;
    }
    manifest.sessions.dirs++;
    const dirDest = join(stateDest, name);
    await mkdir(dirDest, { recursive: true });
    for (const f of present) {
      let r: { copied: boolean; bytes: number };
      try {
        r = await copyIfChanged(join(dirSrc, f), join(dirDest, f));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(join(dirSrc, f))) throw e;
        continue; // 一覧の後に消えたファイル
      }
      manifest.sessions.bytes += r.bytes;
      if (r.copied) manifest.sessions.copiedFiles++;
      else manifest.sessions.reusedFiles++;
    }
    const dbSrc = join(dirSrc, SNAPSHOT_SESSION_DB);
    // リンクの session.db(と -wal)は辿らない(前に写したものも消す。写さなかったことは copySessionExtras が manifest に残す)
    if ((await isLink(dbSrc)) || (await isLink(`${dbSrc}-wal`))) await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true });
    else if (existsSync(dbSrc)) {
      try {
        const copied = await copySessionDb(dbSrc, join(dirDest, SNAPSHOT_SESSION_DB), join(dest, '.tmp-sqlite'));
        if (copied) manifest.sessions.dbCopied!++;
        else manifest.sessions.dbReused!++;
      } catch (e) {
        // 1 セッションの session.db が壊れていてもスナップショット全体は止めない(理由は manifest に残し、extract が警告に出す)
        await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true });
        (manifest.sessionDbErrors ??= []).push(`${name}: ${(e as Error).message}`);
      }
    } else await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true }); // 元から消えたものは複製側も消す
    // Phase 11: plan.md・checkpoints/・files/ などを写す。大きいもの・一覧に無いものは --snapshot-all のときだけ
    await copySessionExtras(dirSrc, dirDest, src, all, prune, extras);
    return true;
  }

  for (const name of SNAPSHOT_STALE_FILES) await rm(join(dest, name), { force: true });

  for (const name of SNAPSHOT_DBS) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    const to = join(dest, name);
    try {
      const r = await copySqlite(from, to, join(dest, '.tmp-sqlite'));
      manifest.databases[name] = { copied: true, bytes: (await stat(to)).size, attempts: r.attempts };
    } catch (e) {
      // Copilot が書き続けていて一貫した複製が取れなくても、スナップショット全体は止めない。
      // 前回の複製があればそのまま使い(古い)、理由は manifest に残して extract が警告に出す
      manifest.databases[name] = { copied: false, bytes: existsSync(to) ? (await stat(to)).size : 0, attempts: SQLITE_COPY_ATTEMPTS, error: (e as Error).message };
    }
  }

  manifest.layout = shape.kind === 'flat' || shape.kind === 'merged' ? shape.kind : 'copilot';
  // セッションのフォルダが並ぶ場所。まとめて読むときは下のフォルダの数だけある
  const stateSrcs = merged ? merged.map((f) => join(src, f)) : [flat ? src : join(src, 'session-state')];
  const stateDest = join(dest, 'session-state');
  // まとめて読むとき、同じ id のセッションが複数のフォルダにあれば 1 つだけ数える(events.jsonl が大きいほう。同じなら名前の順で先のフォルダ)
  const owners = merged ? await sessionOwners(stateSrcs) : null;
  /** 元のルートからの相対パス(/ 区切り。manifest の merged.folders と同じ書き方) */
  const folderOf = (stateSrc: string): string => relative(src, stateSrc).replace(/\\/g, '/');
  /** セッションの id ごとの、数えたフォルダ(since で写さなかったものも入る) */
  const ownerFolders: Record<string, string> = {};
  if (owners) for (const [id, dir] of owners) ownerFolders[id] = folderOf(dir);
  if (merged) manifest.merged = { folders: merged, duplicates: 0, owners: ownerFolders };
  /** 写し終えたセッションの id(まとめて読むとき、作業用のフォルダから同じ id を 2 度写さないように) */
  const taken = new Set<string>();
  for (const stateSrc of stateSrcs) {
    if (!existsSync(stateSrc)) continue;
    for (const ent of await readdir(stateSrc, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dirSrc = join(stateSrc, ent.name);
      const rel = relative(src, dirSrc).replace(/\\/g, '/');
      // 写す先の名前(セッションの id)。作業用のフォルダから写すときだけ、フォルダの名前と違う
      let name = ent.name;
      // アップロードの置き換えの途中・消し残しのフォルダは、同じセッションの複製なので数えない(二重に数えないように)。
      // ただし、置き換えの途中で止まって本体(<id>)が無いセッションは、写し終えていた作業用のフォルダから写す(集計から消えたままにしない)
      const workId = uploadWorkDirId(ent.name);
      /** 作業用のフォルダから写しているとき、その元(元のルートからの相対パス) */
      let recoveredFrom: string | null = null;
      if (workId != null) {
        // 本体があるか。フォルダがあれば、中がリンクだけでも本体があるものとして扱う(本体のほうの片付けと食い違わないように)。
        // まとめて読むときは、本体が別のフォルダにあるもの・別のフォルダの作業用のフォルダから写したものも同じ
        const hasMain = existsSync(join(stateSrc, workId)) || (owners != null && owners.has(workId)) || taken.has(workId);
        const orphan = !hasMain && isRecoverableId(workId);
        const from = orphan ? orphanSource(stateSrc, workId) : null;
        if (from === ent.name) {
          name = workId;
          recoveredFrom = rel;
        } else {
          // 退けた前のフォルダだけが残っているもの(本体も、写し終えた新しいものも無い)は、理由を分けて残す
          const oldOnly = orphan && from == null && ent.name === uploadOldName(workId);
          if (hasSessionFile(dirSrc)) extras.skipped.push({ path: rel, bytes: 0, reason: oldOnly ? UPLOAD_OLD_ONLY_REASON : UPLOAD_WORK_REASON });
          continue;
        }
      } else if (owners != null && owners.has(name) && owners.get(name) !== stateSrc) {
        // 同じ id のセッションが別のフォルダにあり、そちらを数える(ここで止めて、下のリンクの片付けで数えるほうの複製を消さない)
        extras.skipped.push({ path: rel, bytes: 0, reason: DUPLICATE_REASON });
        manifest.merged!.duplicates++;
        continue;
      }
      // リンク(シンボリックリンク・ジャンクション)のファイルは辿らない(フォルダの外のファイルを写さないように)
      const present: string[] = [];
      const linked: string[] = [];
      for (const f of SNAPSHOT_SESSION_FILES) {
        if (await isLink(join(dirSrc, f))) linked.push(f);
        else if (existsSync(join(dirSrc, f))) present.push(f);
      }
      // 前に写した分は消す。この集計で同じ id を別のフォルダから写し終えていたら、それは消さない
      if (!taken.has(name)) for (const f of linked) await rm(join(stateDest, name, f), { force: true });
      if (present.length === 0) {
        // optimistic-chat-* など中身の無いディレクトリ。リンクしか無いものは、写さなかったことを残す
        for (const f of linked) extras.skipped.push({ path: `${rel}/${f}`, bytes: 0, reason: LINK_REASON });
        continue;
      }
      try {
        const copied = await snapshotSession(name, dirSrc, present);
        taken.add(name);
        // 作業用のフォルダから写したことは、写し終えてから残す(since で写さなかったもの・途中で消えたものは入れない)
        if (copied && recoveredFrom != null) (extras.recovered ??= []).push({ id: name, path: recoveredFrom });
        // 作業用のフォルダから写したセッションは、そのフォルダのものとして数える
        if (merged && recoveredFrom != null) ownerFolders[name] = folderOf(stateSrc);
      } catch (e) {
        // 走査中にセッションが消された(Copilot の削除・一時セッションの片付け)なら飛ばす。それ以外は止める
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(dirSrc)) continue;
        throw e;
      }
    }
  }

  // Phase 11: ~/.copilot 直下の plans/・attachments/(と chats/ の *.md)。logs/ は --snapshot-all、repos/ は写さない。
  // 直下にセッションが並ぶ形・そのフォルダが並ぶ形では、直下のフォルダはセッションかその入れ物なので写さない(写したものとして一覧に出さない)
  if (!flat && !merged) await copyTopLevel(src, dest, all, prune, extras);
  // Phase 11: data.db は複製せず、許可リストの列だけを desktop.json に書く(immutable で開く。元には触れない)
  try {
    const d = await readDesktopDb(join(src, 'data.db'));
    if (d) {
      await writeFile(join(dest, DESKTOP_JSON), JSON.stringify(d));
      extras.desktop = { written: true, sessions: d.tables.sessions?.length ?? 0, warnings: d.warnings };
    } else {
      await rm(join(dest, DESKTOP_JSON), { force: true });
      extras.desktop = null;
    }
  } catch (e) {
    extras.desktop = { written: false, sessions: 0, warnings: [`data.db を読めない (${(e as Error).message})`] };
  }
  manifest.extras = extras;

  // アップロードしたフォルダから集計するときは、送った人が添えたインストール済みの記録を読む(何人分かなら合わせる)。
  // 1 つも無ければ記録なし(元のフォルダの直下に skills/ は無いので、読むと 0 件に見えてしまう)
  const installed = flat ? await readSentInventory(src, ['.']) : merged ? await readSentInventory(src, merged) : await readInventory(src);
  if (installed) manifest.installed = installed;

  // 元から消えたセッションの複製が出力先に残っていれば、前の集計で数えたフォルダを引き継ぐ(人ごとの内訳から外さない)
  for (const [id, folder] of Object.entries(previousOwners)) {
    if (!(id in ownerFolders) && typeof folder === 'string' && existsSync(join(stateDest, id))) ownerFolders[id] = folder;
  }

  await writeFile(join(dest, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * 直下にセッションのフォルダ(workspace.yaml か events.jsonl を持つ)が並ぶ形か。~/.copilot の印(session-state/・session-store.db)があれば違う。
 * atlas のアップロード先(<基底>\<グループ>)を --home に指して集計し直すとき用
 */
export async function isFlatLayout(src: string): Promise<boolean> {
  if (looksLikeCopilotHome(src)) return false;
  let ents: import('node:fs').Dirent[];
  try {
    ents = await readdir(src, { withFileTypes: true });
  } catch {
    return false;
  }
  return ents.some((e) => e.isDirectory() && hasSessionFile(join(src, e.name)));
}

/** ~/.copilot の印(session-state/ か session-store.db)があるか */
function looksLikeCopilotHome(src: string): boolean {
  return existsSync(join(src, 'session-state')) || existsSync(join(src, 'session-store.db'));
}

/** セッションのフォルダか(workspace.yaml か events.jsonl を持つ) */
export const hasSessionFile = (dir: string): boolean => SNAPSHOT_SESSION_FILES.some((f) => existsSync(join(dir, f)));

/**
 * 作業用のフォルダの名前から取った id を、写す先のフォルダの名前に使ってよいか。
 * 共有フォルダに置かれた名前なので、そのまま信じない: 「.」「..」と、点や空白で終わる名前(Windows では別の名前のフォルダを指す)、
 * それ自体が作業用のフォルダの名前になるもの(写しても数えない)は使わない
 */
const isRecoverableId = (id: string): boolean => !/[.\s]$/u.test(id) && !isUploadWorkDir(id);

/**
 * 本体のフォルダ(<id>)が無いセッションを写す元にする、作業用のフォルダの名前(無ければ null)。
 * 使うのは、写し終えた新しいもの(送る側が最後に書く UPLOAD_SESSION_META まである .<id>.uploading)だけ。
 * 写している途中の .<id>.uploading(初めて送っている最中のもの)は使わない。
 * 退けた前のもの(.<id>.old)も使わない: 消し残しがあるセッションを共有から消したときと見分けられず、消したセッションが古い中身で戻ってしまう
 */
function orphanSource(stateSrc: string, id: string): string | null {
  const tmp = uploadTmpName(id);
  return existsSync(join(stateSrc, tmp, UPLOAD_SESSION_META)) && hasSessionFile(join(stateSrc, tmp)) ? tmp : null;
}

/** 出力先に、前の集計が写したもの(セッションのフォルダか session-store.db)があるか */
async function holdsCopies(dest: string): Promise<boolean> {
  return SNAPSHOT_DBS.some((n) => existsSync(join(dest, n))) || (await subDirs(join(dest, 'session-state'))).length > 0;
}

/** 直下のフォルダの名前(名前の順)。読めなければ空 */
async function subDirs(src: string): Promise<string[]> {
  try {
    return (await readdir(src, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 直下のフォルダのうち、アップロードしたグループ・プロジェクトのフォルダの名前(名前の順)。
 * 索引(写すたびに書く UPLOAD_INDEX)があるものは、フォルダ 1 つにつき 1 回調べるだけで分かる。
 * 索引の無いもの(前の版が写した、手で作った)は、セッションのフォルダが並ぶかを中まで見るので、名前の順で先頭の probeMax 個までにする
 * (関係のない大きなフォルダを指したときに、下のフォルダを全部読まないように)
 */
async function uploadFoldersUnder(src: string, probeMax: number): Promise<string[]> {
  const out: string[] = [];
  let probed = 0;
  for (const n of await subDirs(src)) {
    if (existsSync(join(src, n, UPLOAD_INDEX))) out.push(n);
    else if (probed++ < probeMax && (await isFlatLayout(join(src, n)))) out.push(n);
  }
  return out;
}

/**
 * 直下のアップロードしたフォルダを全部(名前の順)。あるかどうかは先頭の UPLOAD_PROBE_MAX 個までで決め、
 * あると決めたら残りも全部調べる(索引の無いフォルダを読み落とさないように)
 */
async function allUploadFolders(src: string): Promise<string[]> {
  return (await uploadFoldersUnder(src, UPLOAD_PROBE_MAX)).length ? uploadFoldersUnder(src, Infinity) : [];
}

/**
 * names(src の直下のフォルダ)のどれかが、アップロードしたフォルダを下に持つか。
 * 下のフォルダは名前の順で先頭の NESTED_PROBE_MAX 個までを索引(UPLOAD_INDEX)で確かめ、
 * 索引が無ければ先頭の NESTED_FLAT_PROBE_MAX 個だけ、セッションのフォルダが並ぶかを中まで見る
 */
async function hasNestedUploadFolder(src: string, names: readonly string[]): Promise<boolean> {
  for (const n of names) {
    const subs = (await subDirs(join(src, n))).slice(0, NESTED_PROBE_MAX);
    if (subs.some((s) => existsSync(join(src, n, s, UPLOAD_INDEX)))) return true;
    for (const s of subs.slice(0, NESTED_FLAT_PROBE_MAX)) if (await isFlatLayout(join(src, n, s))) return true;
  }
  return false;
}

/**
 * まとめて読むフォルダのうち、セッションの id ごとに、数えるほうのフォルダ(events.jsonl が大きいほう。同じなら先に見たほう)。
 * 作業用のフォルダ(置き換えの途中・消し残し)は入れない
 */
async function sessionOwners(stateSrcs: readonly string[]): Promise<Map<string, string>> {
  const best = new Map<string, { dir: string; bytes: number }>();
  for (const dir of stateSrcs) {
    for (const id of await subDirs(dir)) {
      if (isUploadWorkDir(id) || !hasSessionFile(join(dir, id))) continue;
      let bytes = 0;
      try {
        bytes = (await stat(join(dir, id, 'events.jsonl'))).size;
      } catch {
        /* events.jsonl が無い(workspace.yaml だけ) */
      }
      const cur = best.get(id);
      if (!cur || bytes > cur.bytes) best.set(id, { dir, bytes });
    }
  }
  return new Map([...best].map(([id, x]) => [id, x.dir]));
}

/** 出力先に残っている、前の集計の元の場所(最後まで終わった集計の manifest と、始めたときの印)。無い・読めないものは入れない(書き直す) */
async function previousSources(dest: string): Promise<{ root: string; file: string }[]> {
  const out: { root: string; file: string }[] = [];
  for (const name of [SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE]) {
    const file = join(dest, name);
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as { sourceRoot?: unknown } | null;
      if (typeof j?.sourceRoot === 'string') out.push({ root: j.sourceRoot, file });
    } catch {
      /* 無い・読めない */
    }
  }
  return out;
}

/**
 * 同じ場所を指すパスか。書き方の違い(相対・末尾の区切り・Windows の大文字小文字)のほか、実際の場所が同じもの
 * (リンク・ジャンクション・割り当てたドライブなど)も同じとみなす。無くなった場所は、書かれたパスのまま比べる
 */
async function sameLocation(a: string, b: string): Promise<boolean> {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(resolve(a)) === fold(resolve(b))) return true;
  const real = async (p: string): Promise<string | null> => {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  };
  const [ra, rb] = [await real(a), await real(b)];
  if (ra == null || rb == null) return false;
  if (fold(ra) === fold(rb)) return true;
  // 実際のパスの書き方が違っても、同じフォルダなら同じ(大文字小文字を区別しないディスクなど)
  try {
    const [sa, sb] = [await stat(ra, { bigint: true }), await stat(rb, { bigint: true })];
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** シンボリックリンク・ジャンクションか(無ければ false) */
async function isLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

const KNOWN_SESSION_ENTRIES = new Set<string>([
  ...SNAPSHOT_SESSION_FILES,
  SNAPSHOT_SESSION_DB,
  `${SNAPSHOT_SESSION_DB}-wal`,
  `${SNAPSHOT_SESSION_DB}-shm`,
  ...SNAPSHOT_SESSION_EXTRA_FILES,
  ...SNAPSHOT_SESSION_EXTRA_DIRS,
  ...SNAPSHOT_SESSION_HEAVY_DIRS,
]);
const isLock = (name: string): boolean => /^inuse\.\d+\.(lock|hold)$/.test(name) || name.endsWith('.lock');

const LINK_REASON = 'シンボリックリンク / ジャンクション(辿らない)';
/** アップロードの作業用のフォルダを数えなかったときの理由(manifest の extras.skipped) */
export const UPLOAD_WORK_REASON = 'アップロードの置き換えの途中か消し残しのフォルダ(セッションとして数えない)';
/** 本体のフォルダも写し終えた新しいフォルダも無く、退けた前のフォルダ(.<id>.old)だけが残っているもの(manifest の extras.skipped) */
export const UPLOAD_OLD_ONLY_REASON = '本体のフォルダが無く、アップロードの置き換えで退けた前のフォルダだけが残っている(共有から消したセッションかもしれないので数えない)';

/**
 * フォルダを歩く(シンボリックリンク・ジャンクションは辿らず、リンクの一覧に返す)。相対パスは / 区切り。
 * 読めないフォルダ(EPERM / EACCES 等)は全体を止めず errors に返す
 */
async function walk(dir: string): Promise<{ files: { rel: string; abs: string }[]; links: string[]; errors: { rel: string; code: string }[] }> {
  const files: { rel: string; abs: string }[] = [];
  const links: string[] = [];
  const errors: { rel: string; code: string }[] = [];
  const rec = async (d: string, rel: string): Promise<void> => {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      errors.push({ rel, code: err.code ?? err.message });
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) links.push(r);
      else if (e.isDirectory()) await rec(join(d, e.name), r);
      else if (e.isFile()) files.push({ rel: r, abs: join(d, e.name) });
    }
  };
  await rec(dir, '');
  return { files, links, errors };
}

/** フォルダの容量(再帰。リンクは辿らず、読めないフォルダは数えない) */
async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const f of (await walk(dir)).files) {
    try {
      n += (await stat(f.abs)).size;
    } catch {
      /* 消えた・読めないファイルは数えない */
    }
  }
  return n;
}

/**
 * フォルダを再帰的に写す(サイズと mtime が同じファイルは再利用)。元に無いファイルは複製先から消す(現存しないものを残さない)。
 * 削除の前に元の実在を確かめる(Windows で大文字小文字だけ変えた改名で、写したばかりの複製を消さない)。削除で空になったフォルダも消す。
 * 1 ファイルの失敗(EBUSY / EPERM 等)や読めないフォルダは全体を止めず skipped に理由を積む。リンクは辿らず skipped に残す
 */
async function copyTree(from: string, to: string, skipped: SkippedEntry[], relBase: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  await mkdir(to, { recursive: true });
  const src = await walk(from);
  for (const l of src.links) skipped.push({ path: `${relBase}/${l}`, bytes: 0, reason: LINK_REASON });
  for (const e of src.errors) skipped.push({ path: e.rel ? `${relBase}/${e.rel}` : relBase, bytes: 0, reason: `読めなかった (${e.code})` });
  const keep = new Set(src.files.map((f) => f.rel));
  for (const f of src.files) {
    const dst = join(to, ...f.rel.split('/'));
    try {
      await mkdir(dirname(dst), { recursive: true });
      const r = await copyIfChanged(f.abs, dst);
      files++;
      bytes += r.bytes;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      skipped.push({ path: `${relBase}/${f.rel}`, bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
    }
  }
  await pruneTree(from, to, keep);
  return { files, bytes };
}

/** 複製先にあって元に無いファイルを消し、空になったフォルダも消す。元の実在は大文字小文字を区別しないファイルシステムでも確かめる */
async function pruneTree(from: string, to: string, keep: Set<string>): Promise<void> {
  if (!existsSync(to)) return;
  const dst = await walk(to);
  const dirs = new Set<string>();
  for (const f of dst.files) {
    if (keep.has(f.rel)) continue;
    // 名前の大文字小文字だけが違う改名: 元に(大文字小文字を無視して)あるなら消さない
    if (existsSync(join(from, ...f.rel.split('/')))) continue;
    await rm(f.abs, { force: true });
    const parts = f.rel.split('/');
    for (let i = parts.length - 1; i >= 1; i--) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const p = join(to, ...d.split('/'));
    try {
      if ((await readdir(p)).length === 0) await rm(p, { recursive: true, force: true });
    } catch {
      /* 既に無い */
    }
  }
}

async function copySessionExtras(dirSrc: string, dirDest: string, root: string, all: boolean, prune: boolean, extras: NonNullable<SnapshotManifest['extras']>): Promise<void> {
  const relPath = (p: string): string => relative(root, p).replace(/\\/g, '/');
  const copyOne = async (from: string, to: string): Promise<void> => {
    try {
      const r = await copyIfChanged(from, to);
      extras.sessionFiles++;
      extras.sessionBytes += r.bytes;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      extras.skipped.push({ path: relPath(from), bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
    }
  };
  for (const f of SNAPSHOT_SESSION_EXTRA_FILES) {
    const p = join(dirSrc, f);
    // 送った人のメモが大きすぎるときは写さない(前に写したものも消す)
    if (f === UPLOAD_MEMO_FILE && existsSync(p) && (await sizeOr0(p)) > UPLOAD_MEMO_TEXT_LIMIT) {
      extras.skipped.push({ path: relPath(p), bytes: await sizeOr0(p), reason: `送った人のメモが大きすぎる(${UPLOAD_MEMO_TEXT_LIMIT / 1024 / 1024} MB まで)` });
      await rm(join(dirDest, f), { force: true });
      continue;
    }
    // リンクは辿らない(下の一覧で「写さなかったもの」に残る)。前に写したものは消す
    if (!(await isLink(p)) && existsSync(p)) await copyOne(p, join(dirDest, f));
    else await rm(join(dirDest, f), { force: true }); // 元から消えたものは複製先からも消す
  }
  const present = new Set<string>();
  let ents: import('node:fs').Dirent[];
  try {
    ents = await readdir(dirSrc, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    extras.skipped.push({ path: relPath(dirSrc), bytes: 0, reason: `読めなかった (${err.code ?? err.message})` });
    return;
  }
  for (const ent of ents) {
    const name = ent.name;
    const p = join(dirSrc, name);
    if (ent.isSymbolicLink()) {
      extras.skipped.push({ path: relPath(p), bytes: 0, reason: LINK_REASON });
      continue;
    }
    if (ent.isDirectory()) {
      const heavy = (SNAPSHOT_SESSION_HEAVY_DIRS as readonly string[]).includes(name);
      const known = (SNAPSHOT_SESSION_EXTRA_DIRS as readonly string[]).includes(name);
      // 送った人のメモの画像が合計で大きすぎるときは写さない(--snapshot-all でも。前に写したものは下の片付けで消える)
      if (name === UPLOAD_MEMO_IMAGES) {
        const n = await dirBytes(p);
        if (n > UPLOAD_MEMO_IMAGES_LIMIT) {
          extras.skipped.push({ path: relPath(p), bytes: n, reason: `送った人のメモの画像が大きすぎる(合計 ${UPLOAD_MEMO_IMAGES_LIMIT / 1024 / 1024} MB まで)` });
          await rm(join(dirDest, name), { recursive: true, force: true });
          continue;
        }
      }
      if (known || ((heavy || !KNOWN_SESSION_ENTRIES.has(name)) && all)) {
        present.add(name);
        const r = await copyTree(p, join(dirDest, name), extras.skipped, relPath(p));
        extras.sessionFiles += r.files;
        extras.sessionBytes += r.bytes;
      } else if (heavy || !KNOWN_SESSION_ENTRIES.has(name)) {
        extras.skipped.push({ path: relPath(p), bytes: await dirBytes(p), reason: heavy ? '大きい(--snapshot-all で写す)' : '一覧に無い名前(--snapshot-all で写す)' });
      }
    } else if (ent.isFile() && !KNOWN_SESSION_ENTRIES.has(name) && !isLock(name)) {
      if (all) {
        present.add(name);
        await copyOne(p, join(dirDest, name));
      } else extras.skipped.push({ path: relPath(p), bytes: await sizeOr0(p), reason: '一覧に無い名前(--snapshot-all で写す)' });
    }
  }
  // 複製先に残っている追加のフォルダ・ファイルで今回写さなかったもの: 元から消えたものは消す。
  // 前回 --snapshot-all で写したもの(元にはまだある)は、生成物を黙って消さない方針で残し、manifest の leftover に日時を出す(--snapshot-prune で消す)
  if (existsSync(dirDest)) {
    for (const ent of await readdir(dirDest, { withFileTypes: true })) {
      const name = ent.name;
      if (KNOWN_SESSION_ENTRIES.has(name) && !(SNAPSHOT_SESSION_EXTRA_DIRS as readonly string[]).includes(name) && !(SNAPSHOT_SESSION_HEAVY_DIRS as readonly string[]).includes(name)) continue;
      if (name === SESSION_DB_FINGERPRINT || present.has(name)) continue;
      const p = join(dirDest, name);
      if (!existsSync(join(dirSrc, name)) || prune) await rm(p, { recursive: true, force: true });
      else extras.leftover.push({ path: relPath(join(dirSrc, name)), mtime: (await stat(p)).mtime.toISOString() });
    }
  }
}

async function copyTopLevel(src: string, dest: string, all: boolean, prune: boolean, extras: NonNullable<SnapshotManifest['extras']>): Promise<void> {
  for (const name of SNAPSHOT_TOP_DIRS) {
    const p = join(src, name);
    if (!existsSync(p)) {
      await rm(join(dest, name), { recursive: true, force: true });
      continue;
    }
    extras.topLevel[name] = await copyTree(p, join(dest, name), extras.skipped, name);
  }
  for (const [name, reason] of Object.entries(SNAPSHOT_TOP_HEAVY_DIRS)) {
    const p = join(src, name);
    const d = join(dest, name);
    if (!existsSync(p)) {
      await rm(d, { recursive: true, force: true });
      continue;
    }
    if (all) extras.topLevel[name] = await copyTree(p, d, extras.skipped, name);
    else {
      extras.skipped.push({ path: name, bytes: await dirBytes(p), reason: `${reason}(--snapshot-all で写す)` });
      if (existsSync(d)) {
        if (prune) await rm(d, { recursive: true, force: true });
        else extras.leftover.push({ path: name, mtime: (await stat(d)).mtime.toISOString() });
      }
    }
  }
  // chats/: *.md(ユーザーが書き出したセッション記録)だけ写し、他は名前と容量だけ。元に無い .md は複製先から消す
  const chats = join(src, 'chats');
  if (existsSync(chats)) {
    let files = 0;
    let bytes = 0;
    let otherBytes = 0;
    let otherFiles = 0;
    const w = await walk(chats);
    for (const l of w.links) extras.skipped.push({ path: `chats/${l}`, bytes: 0, reason: LINK_REASON });
    const keep = new Set<string>();
    for (const f of w.files) {
      if (f.rel.toLowerCase().endsWith('.md')) {
        keep.add(f.rel);
        const to = join(dest, 'chats', ...f.rel.split('/'));
        try {
          await mkdir(dirname(to), { recursive: true });
          const r = await copyIfChanged(f.abs, to);
          files++;
          bytes += r.bytes;
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          extras.skipped.push({ path: `chats/${f.rel}`, bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
        }
      } else {
        otherFiles++;
        otherBytes += await sizeOr0(f.abs);
      }
    }
    if (existsSync(join(dest, 'chats'))) for (const f of (await walk(join(dest, 'chats'))).files) if (!keep.has(f.rel)) await rm(f.abs, { force: true });
    extras.topLevel.chats = { files, bytes };
    if (otherFiles) extras.skipped.push({ path: 'chats(*.md 以外)', bytes: otherBytes, reason: `${SNAPSHOT_TOP_SKIP_DIRS.chats}(${otherFiles} ファイル)` });
  } else await rm(join(dest, 'chats'), { recursive: true, force: true });
  const repos = join(src, 'repos');
  if (existsSync(repos)) extras.skipped.push({ path: 'repos', bytes: await dirBytes(repos), reason: SNAPSHOT_TOP_SKIP_DIRS.repos });
}

/** ディレクトリ(とそれを指すシンボリックリンク・ジャンクション)の名前。無ければ空 */
async function dirNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory() || ent.isSymbolicLink()) out.push(ent.name);
  }
  return out.sort();
}

/**
 * インストール済みの skill / プラグインを名前だけ記録する(SKILL.md などの中身は読まない)。
 * - ~/.copilot/skills/<name>/
 * - ~/.copilot/installed-plugins/<marketplace>/<plugin>/(と、その skills/<name>/)
 * - ~/.copilot/settings.json の disabledSkills(他のキーは記録しない)
 * 読めないものは warnings に理由を残し、黙って空にしない。
 */
export async function readInventory(src: string): Promise<InstalledInventory> {
  const inv: InstalledInventory = { skills: [], plugins: [], disabledSkills: [], warnings: [] };
  try {
    inv.skills = await dirNames(join(src, 'skills'));
  } catch (e) {
    inv.warnings.push(`skills/ を読めない (${(e as Error).message})`);
  }
  try {
    const root = join(src, 'installed-plugins');
    for (const market of await dirNames(root)) {
      for (const name of await dirNames(join(root, market))) {
        inv.plugins.push({ marketplace: market, name, skills: await dirNames(join(root, market, name, 'skills')) });
      }
    }
  } catch (e) {
    inv.warnings.push(`installed-plugins/ を読めない (${(e as Error).message})`);
  }
  const settings = join(src, 'settings.json');
  if (existsSync(settings)) {
    try {
      const v = JSON.parse(await readFile(settings, 'utf8')) as { disabledSkills?: unknown };
      const d = v?.disabledSkills;
      if (d == null) inv.disabledSkills = [];
      else if (Array.isArray(d)) inv.disabledSkills = d.filter((x): x is string => typeof x === 'string').sort();
      else {
        inv.disabledSkills = null;
        inv.warnings.push('settings.json の disabledSkills が配列でない');
      }
    } catch (e) {
      inv.disabledSkills = null;
      inv.warnings.push(`settings.json を読めない (${(e as Error).message})`);
    }
  }
  return inv;
}

/** 送った人のインストール済みの記録で使う名前の上限(共有フォルダに置かれたファイルなので、大きすぎるもの・おかしな名前は使わない) */
const SENT_NAMES_MAX = 5000;
const SENT_NAME_CHARS = 200;

/** 名前の並び。文字列でないもの・長すぎるもの・制御文字や見えない書式の文字を含むものは除く。並びでなければ null */
function sentNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = new Set<string>();
  for (const x of v) {
    if (out.size >= SENT_NAMES_MAX) break;
    if (typeof x !== 'string') continue;
    const n = x.trim();
    if (n && [...n].length <= SENT_NAME_CHARS && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(n)) out.add(n);
  }
  return [...out];
}

/**
 * アップロードしたフォルダ(src からの相対パス。/ 区切り。'.' は src そのもの)に添えられた、送った人のインストール済みの記録
 * (UPLOAD_INSTALLED)を読んで合わせる。名前はどれかのフォルダにあれば入れる(何人分かなら、誰かが入れているもの)。
 * 1 つも無ければ undefined(この版より前の atlas で送ったもの)。無いフォルダ・読めないフォルダは warnings に数を残す
 */
export async function readSentInventory(src: string, folders: readonly string[]): Promise<InstalledInventory | undefined> {
  const skills = new Set<string>();
  const plugins = new Map<string, { marketplace: string; name: string; skills: Set<string> }>();
  const disabled = new Set<string>();
  let anyDisabled = false;
  const warnings: string[] = [];
  let found = 0;
  let missing = 0;
  for (const f of folders) {
    const path = join(src, ...(f === '.' ? [] : f.split('/')), UPLOAD_INSTALLED);
    if (!existsSync(path)) {
      missing++;
      continue;
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (!j || typeof j !== 'object' || j.version !== 1) throw new Error('形が違う');
    } catch (e) {
      warnings.push(`${f === '.' ? '' : `${f} の `}${UPLOAD_INSTALLED} を読めない (${(e as Error).message})`);
      continue;
    }
    found++;
    for (const n of sentNames(j.skills) ?? []) skills.add(n);
    if (Array.isArray(j.plugins)) {
      for (const p of j.plugins.slice(0, SENT_NAMES_MAX) as unknown[]) {
        if (!p || typeof p !== 'object') continue;
        const o = p as Record<string, unknown>;
        const [market] = sentNames([o.marketplace]) ?? [];
        const [name] = sentNames([o.name]) ?? [];
        if (!market || !name) continue;
        const key = `${market}/${name}`;
        const x = plugins.get(key) ?? { marketplace: market, name, skills: new Set<string>() };
        for (const n of sentNames(o.skills) ?? []) x.skills.add(n);
        plugins.set(key, x);
      }
    }
    const d = sentNames(j.disabledSkills);
    if (d) {
      anyDisabled = true;
      for (const n of d) disabled.add(n);
    }
    for (const w of (sentNames(j.warnings) ?? []).slice(0, 20)) warnings.push(`${f === '.' ? '' : `${f}: `}${w}`);
  }
  if (!found) return undefined;
  if (missing) warnings.push(`送った人のインストール済みの記録が無いフォルダが ${missing} 件あります(この版より前の atlas で送ったもの。送り直すと付きます)`);
  return {
    skills: [...skills].sort(),
    plugins: [...plugins.values()].map((p) => ({ marketplace: p.marketplace, name: p.name, skills: [...p.skills].sort() })).sort((a, b) => `${a.marketplace}/${a.name}`.localeCompare(`${b.marketplace}/${b.name}`)),
    disabledSkills: anyDisabled ? [...disabled].sort() : null,
    warnings,
  };
}

export async function readSnapshotManifest(dir: string): Promise<SnapshotManifest | null> {
  const p = join(dir, SNAPSHOT_MANIFEST);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8')) as SnapshotManifest;
}

const SQLITE_COPY_ATTEMPTS = 8;

/**
 * WAL 付き SQLite を元に触れずに複製する。
 * 元を直接開くと、読み取り専用接続でも -shm(WAL インデックス)に読み取りマークを書くため
 * -shm の mtime が変わる(2026-10-28 実測)。そこで本体と -wal をバイト列のままコピーし、
 * コピー側を開いて VACUUM INTO で単一ファイルにする。
 * コピー中に元が書かれた(サイズか mtime が変わった)・-wal が消えた(チェックポイント)・quick_check が通らないときは、間を空けて取り直す。
 * 複製先は一時ファイルに作ってから置き換えるので、取り直しきれなくても前回の複製は残る。
 */
async function copySqlite(from: string, to: string, tmpDir: string): Promise<{ attempts: number }> {
  const name = basename(from);
  const parts = [`${from}-wal`, from]; // -wal を先に取る(後から取る本体は同じかより新しいページを持つ)
  let lastProblem = '';
  // 途中で例外になっても一時フォルダを残さない
  try {
    for (let attempt = 1; attempt <= SQLITE_COPY_ATTEMPTS; attempt++) {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      const present = parts.filter((p) => existsSync(p));
      let changed: boolean;
      try {
        const before = await Promise.all(present.map(fingerprint));
        for (const p of present) await copyFile(p, join(tmpDir, basename(p)));
        const after = await Promise.all(present.map(fingerprint));
        changed = before.join('|') !== after.join('|');
        if (changed) lastProblem = 'コピー中に元が更新された';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        changed = true;
        lastProblem = 'コピー中に元のファイルが消えた';
      }
      if (changed) {
        await sleep(200 * attempt);
        continue;
      }
      const copy = join(tmpDir, name);
      const fresh = join(tmpDir, `${name}.vacuum`);
      let broken = false;
      const db = await openWritable(copy); // 複製側なので書けてよい(-shm は複製側に作られる)
      try {
        const qc = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
        if (qc.length !== 1 || qc[0].quick_check !== 'ok') {
          lastProblem = `quick_check: ${qc.map((r) => r.quick_check).join('; ').slice(0, 200)}`;
          broken = true;
        } else {
          await rm(fresh, { force: true });
          db.exec(`VACUUM INTO ${sqlString(fresh)}`);
        }
      } finally {
        db.close();
      }
      if (broken) {
        await sleep(200 * attempt);
        continue;
      }
      await renameReplacing(fresh, to);
      return { attempts: attempt };
    }
    throw new Error(`${from} を一貫した状態で複製できなかった(${SQLITE_COPY_ATTEMPTS} 回): ${lastProblem}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * session.db を複製する(copySqlite と同じく、元の本体と -wal をバイト列でコピーしてから複製側で VACUUM INTO)。
 * 元の指紋(本体と -wal のサイズ・mtime)が前回と同じなら複製し直さない。複製したら true
 */
async function copySessionDb(from: string, to: string, tmpDir: string): Promise<boolean> {
  const fpPath = join(dirname(to), SESSION_DB_FINGERPRINT);
  const fp = (await Promise.all([from, `${from}-wal`].filter((p) => existsSync(p)).map(fingerprint))).join('|');
  if (existsSync(to) && existsSync(fpPath) && (await readFile(fpPath, 'utf8')) === fp) return false;
  await copySqlite(from, to, tmpDir);
  await writeFile(fpPath, fp);
  return true;
}

async function fingerprint(p: string): Promise<string> {
  const s = await stat(p);
  return `${s.size}:${s.mtimeMs}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isUpdatedSince(dir: string, files: readonly string[], since: Date): Promise<boolean> {
  for (const f of files) {
    try {
      if ((await stat(join(dir, f))).mtime >= since) return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return false;
}

/** ファイルの大きさ。一覧の後に消えた・読めないものは 0 */
async function sizeOr0(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

async function copyIfChanged(from: string, to: string): Promise<{ copied: boolean; bytes: number }> {
  const s = await stat(from);
  if (existsSync(to)) {
    const d = await stat(to);
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2) return { copied: false, bytes: s.size };
  }
  await copyFile(from, to);
  // 複製先の mtime を元に合わせる(次回の再利用判定用。元のファイルには触れない)
  await utimes(to, s.atime, s.mtime);
  return { copied: true, bytes: s.size };
}
