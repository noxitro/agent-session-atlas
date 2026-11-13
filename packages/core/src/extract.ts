import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseAtlasBuild, type AtlasBuild } from './atlas-version.ts';
import { newParseStats, parseEvents } from './events.ts';
import { resolveInstructions } from './instructions.ts';
import { normalizeSession } from './normalize.ts';
import { ProjectResolver, type ProjectResolverOptions } from './project.ts';
import { ATLAS_JUDGE_PROJECT, HOME_PROJECT, TEMP_PROJECT } from './project-keys.ts';
import { DESKTOP_JSON, hasSessionFile, isUploadWorkDir, mapLimit, personOfFolder, readSnapshotManifest, SESSION_STORE_JSON, SNAPSHOT_SESSION_DB, UPLOAD_OLD_ONLY_REASON, UPLOAD_SESSION_META, UPLOAD_WORK_REASON, uploadWorkDirId } from './snapshot.ts';
import { desktopForSession, type DesktopData, type DesktopSessionInfo } from './desktop.ts';
import { openReadOnly } from './sqlite.ts';
import { WikiClassifier, type WikiSpec } from './wiki.ts';

export { SESSION_STORE_JSON };
import {
  SESSIONS_SCHEMA_VERSION,
  type DbFileRow,
  type DbSessionRow,
  type DbTurnRow,
  type DbUsageRow,
  type ProjectSource,
  type SessionRecord,
  type SessionsFile,
  type TodoSummary,
  type WorkspaceInfo,
} from './types.ts';

export interface StoreData {
  sessions: Map<string, DbSessionRow>;
  turns: Map<string, DbTurnRow[]>;
  usage: Map<string, DbUsageRow[]>;
  files: Map<string, DbFileRow[]>;
  schemaVersion: number | null;
}

function group<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    let a = m.get(r.session_id);
    if (!a) m.set(r.session_id, (a = []));
    a.push(r);
  }
  return m;
}

function tableExists(db: Awaited<ReturnType<typeof openReadOnly>>, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/** session-store.db から読む表と列(セッション 1 件分を書き出すときも同じ問い合わせを使う) */
/** セッションごとのファイルを並べて読む数(読み込みの待ちを重ねる。解析は 1 つのスレッドで順に進むので、増やしても速くならない) */
const EXTRACT_CONCURRENCY = 8;

const STORE_QUERIES = {
  sessions: { table: 'sessions', sql: 'SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions', key: 'id', order: '' },
  turns: { table: 'turns', sql: 'SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns', key: 'session_id', order: '' },
  usage: { table: 'assistant_usage_events', sql: 'SELECT * FROM assistant_usage_events', key: 'session_id', order: ' ORDER BY id' },
  files: { table: 'session_files', sql: 'SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files', key: 'session_id', order: '' },
} as const;


export interface SessionStoreJson {
  version: 1;
  /** session-store.db の schema_version(無ければ null) */
  schemaVersion: number | null;
  sessions: DbSessionRow[];
  turns: DbTurnRow[];
  usage: DbUsageRow[];
  files: DbFileRow[];
  /** デスクトップアプリの data.db(許可リストの列)の、このセッションの行。アップロードで添える。無ければ省く */
  desktop?: DesktopSessionInfo | null;
}

/** session-store.db(スナップショット側)を読む。無ければ空 */
export async function loadStore(dbPath: string): Promise<StoreData> {
  const empty: StoreData = { sessions: new Map(), turns: new Map(), usage: new Map(), files: new Map(), schemaVersion: null };
  if (!existsSync(dbPath)) return empty;
  const db = await openReadOnly(dbPath);
  try {
    const all = <T>(q: (typeof STORE_QUERIES)[keyof typeof STORE_QUERIES]): T[] => (tableExists(db, q.table) ? (db.prepare(q.sql + q.order).all() as unknown as T[]) : []);
    const sessions = all<DbSessionRow>(STORE_QUERIES.sessions);
    const turns = all<DbTurnRow>(STORE_QUERIES.turns);
    const usage = all<DbUsageRow>(STORE_QUERIES.usage);
    const files = all<DbFileRow>(STORE_QUERIES.files);
    const sv = tableExists(db, 'schema_version') ? (db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined) : undefined;
    return {
      sessions: new Map(sessions.map((s) => [s.id, { ...s }])),
      turns: group(turns.map((r) => ({ ...r }))),
      usage: group(usage.map((r) => ({ ...r }))),
      files: group(files.map((r) => ({ ...r }))),
      schemaVersion: sv?.version ?? null,
    };
  } finally {
    db.close();
  }
}

/** session-store.db をセッションごとに読む道具(1 回だけ開き、使い終わったら close する)。rows はそのセッションの行が 1 つも無ければ null */
export interface SessionStoreReader {
  rows: (id: string) => SessionStoreJson | null;
  close: () => void;
}

/** session-store.db を 1 回だけ開き、セッションごとの行を取り出す道具を返す(アップロードで添える)。DB が無ければ null */
export async function openSessionStoreReader(dbPath: string): Promise<SessionStoreReader | null> {
  if (!existsSync(dbPath)) return null;
  const db = await openReadOnly(dbPath);
  const has = new Map<string, boolean>();
  const exists = (table: string): boolean => {
    if (!has.has(table)) has.set(table, tableExists(db, table));
    return has.get(table)!;
  };
  const schemaVersion = exists('schema_version') ? ((db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version ?? null) : null;
  const stmts = new Map<string, ReturnType<typeof db.prepare>>();
  const rows = <T>(q: (typeof STORE_QUERIES)[keyof typeof STORE_QUERIES], id: string): T[] => {
    if (!exists(q.table)) return [];
    const sql = `${q.sql} WHERE ${q.key} = ?${q.order}`;
    let st = stmts.get(sql);
    if (!st) {
      st = db.prepare(sql);
      stmts.set(sql, st);
    }
    return (st.all(id) as unknown as T[]).map((r) => ({ ...r }));
  };
  return {
    rows: (id) => {
      const out: SessionStoreJson = {
        version: 1,
        schemaVersion,
        sessions: rows<DbSessionRow>(STORE_QUERIES.sessions, id),
        turns: rows<DbTurnRow>(STORE_QUERIES.turns, id),
        usage: rows<DbUsageRow>(STORE_QUERIES.usage, id),
        files: rows<DbFileRow>(STORE_QUERIES.files, id),
      };
      return out.sessions.length + out.turns.length + out.usage.length + out.files.length ? out : null;
    },
    close: () => db.close(),
  };
}

/** session-store.db からセッション 1 件分の行を取り出す(1 件だけ読むとき)。DB が無いか、そのセッションの行が 1 つも無ければ null */
export async function sessionStoreRows(dbPath: string, id: string): Promise<SessionStoreJson | null> {
  const r = await openSessionStoreReader(dbPath);
  if (!r) return null;
  try {
    return r.rows(id);
  } finally {
    r.close();
  }
}

/**
 * セッションのフォルダに添えた行(SESSION_STORE_JSON)を store に足す。session-store.db に同じセッションの行があればそちらを優先する
 * (Copilot の DB が正。添えた行はアップロード先から集計し直すときのためのもの)。読めなければ理由を返す
 */
export async function mergeSessionStoreJson(store: StoreData, id: string, path: string, desktops?: Map<string, DesktopSessionInfo>): Promise<string | null> {
  let j: SessionStoreJson;
  try {
    j = JSON.parse(await readFile(path, 'utf8')) as SessionStoreJson;
    if (j?.version !== 1 || !Array.isArray(j.sessions) || !Array.isArray(j.turns) || !Array.isArray(j.usage) || !Array.isArray(j.files)) throw new Error('形が違います');
    // 行の形と列の型も確かめる(版の違う・手で直した・壊れたファイルの 1 つで、集計の全体が止まらないように。使わないことにして警告に出す)
    checkRows('sessions', j.sessions, 'id', id, SESSION_COLS);
    checkRows('turns', j.turns, 'session_id', id, TURN_COLS);
    checkRows('usage', j.usage, 'session_id', id, USAGE_COLS);
    checkRows('files', j.files, 'session_id', id, FILE_COLS);
  } catch (e) {
    return `${id}: ${SESSION_STORE_JSON} を読めない (${(e as Error).message})`;
  }
  // 別のセッションの行が混じっていても、このフォルダのセッションの分だけを使う
  const s = j.sessions.find((r) => r.id === id);
  if (s && !store.sessions.has(id)) store.sessions.set(id, { ...s });
  const add = <T extends { session_id: string }>(m: Map<string, T[]>, rows: T[]): void => {
    const mine = rows.filter((r) => r.session_id === id);
    if (mine.length && !m.get(id)?.length) m.set(id, mine.map((r) => ({ ...r })));
  };
  add(store.turns, j.turns);
  add(store.usage, j.usage);
  add(store.files, j.files);
  if (store.schemaVersion == null && j.schemaVersion != null) store.schemaVersion = j.schemaVersion;
  // data.db の行(desktop.json に同じセッションがあればそちらを使う。extract が決める)。
  // 形が違えば使わない(レポートは contextUsage などを配列として読むので、版の違う・手で直したファイルで止まらないように)
  if (j.desktop == null) return null;
  if (!isDesktopSessionInfo(j.desktop)) return `${id}: ${SESSION_STORE_JSON} の desktop の形が違うため使いません`;
  desktops?.set(id, j.desktop);
  return null;
}

/** デスクトップアプリが作ったばかりのセッションの workspace.yaml に残る仮の名前(題名は data.db の側で付く) */
const PLACEHOLDER_NAMES = new Set(['New session']);

/**
 * セッションの名前。workspace.yaml の名前が無いか仮の名前(New session)のままなら、デスクトップアプリの data.db の題名を使う。
 * 名前があればそちらを残す(利用者が付けた名前の方が、自動で付いた題名より短く的確なことがある)
 */
export function sessionName(name: string | null, desktopTitle: unknown): string | null {
  const t = typeof desktopTitle === 'string' ? desktopTitle.trim() : '';
  return t && (!name?.trim() || PLACEHOLDER_NAMES.has(name.trim())) ? t : name;
}

const isRow = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRowOrNull = (v: unknown): boolean => v === null || isRow(v);
const isRows = (v: unknown): boolean => Array.isArray(v) && v.every(isRow);

/** 添えた行の列の型。s / n は文字列 / 数値(null か欠けていてもよい)、S / N は必ずある文字列 / 数値 */
type ColKind = 's' | 'n' | 'S' | 'N';
const SESSION_COLS: Record<string, ColKind> = { cwd: 's', repository: 's', host_type: 's', branch: 's', summary: 's', created_at: 's', updated_at: 's' };
const TURN_COLS: Record<string, ColKind> = { turn_index: 'N', user_message: 's', assistant_response: 's', timestamp: 's' };
const USAGE_COLS: Record<string, ColKind> = {
  id: 'n',
  turn_index: 'n',
  agent_id: 's',
  parent_tool_call_id: 's',
  model: 'S',
  input_tokens: 'n',
  output_tokens: 'n',
  cache_read_tokens: 'n',
  cache_write_tokens: 'n',
  reasoning_tokens: 'n',
  total_nano_aiu: 'n',
  request_multiplier: 'n',
  initiator: 's',
  reasoning_effort: 's',
  finish_reason: 's',
  duration_ms: 'n',
  time_to_first_token_ms: 'n',
  created_at: 's',
};
const FILE_COLS: Record<string, ColKind> = { file_path: 'S', tool_name: 's', turn_index: 'n', first_seen_at: 's' };

/**
 * 添えた行が、DB から読んだ行と同じ形か。どの要素もオブジェクトで、このセッションの行は列の型が合っていること
 * (一覧に無い列は、文字列・数値・真偽値・null ならよい)。違えば例外
 */
function checkRows(table: string, rows: unknown[], key: 'id' | 'session_id', id: string, cols: Record<string, ColKind>): void {
  for (const r of rows) {
    if (!isRow(r)) throw new Error(`形が違います(${table} の行)`);
    const row = r as Record<string, unknown>;
    if (row[key] !== id) continue; // ほかのセッションの行は使わない
    for (const [k, kind] of Object.entries(cols)) if ((kind === 'S' || kind === 'N') && row[k] == null) throw new Error(`形が違います(${table} の ${k} が無い)`);
    for (const [k, v] of Object.entries(row)) {
      if (v == null || k === key) continue;
      const kind = cols[k]?.toLowerCase();
      const ok = kind === 's' ? typeof v === 'string' : kind === 'n' ? typeof v === 'number' : typeof v !== 'object';
      if (!ok) throw new Error(`形が違います(${table} の ${k})`);
    }
  }
}

const PROJECT_SOURCES: readonly string[] = ['repository', 'git-remote', 'path', 'home', 'temp', 'atlas-judge', 'unknown'] satisfies ProjectSource[];

/** まとめ用のプロジェクト名(名前と決め方が 1 対 1 で決まるもの) */
const GROUPED_SOURCE = new Map<string, ProjectSource>([
  [TEMP_PROJECT, 'temp'],
  [HOME_PROJECT, 'home'],
  [ATLAS_JUDGE_PROJECT, 'atlas-judge'],
]);
const GROUPED_SOURCES = new Set<ProjectSource>(GROUPED_SOURCE.values());

/**
 * アップロードで添えた記録(UPLOAD_SESSION_META)から、送った側が決めたプロジェクト名とその決め方を読む。
 * 無い・読めない・形が違う・ほかのセッションのものなら null。決め方の記録が無い(前の版が書いた)ものは source が null。
 * 共有フォルダに置かれたファイルなので、そのまま信じない: 名前は前後の空白を落とし、制御文字(改行など)と、
 * 見えない書式の文字(文字の向きを変えるもの・幅の無い空白など。別の名前に見せかけられる)を含むものは使わない。
 * 決め方は名前と合うものだけ使う(まとめ用の名前はその決め方に揃え、ほかの名前にまとめ用の決め方が付いていたら捨てる)
 */
export async function readSenderProject(path: string, id: string): Promise<{ project: string; source: ProjectSource | null } | null> {
  return (await readSenderMeta(path, id))?.project ?? null;
}

/**
 * アップロードで添えた記録(UPLOAD_SESSION_META)を 1 度だけ読み、プロジェクト名(readSenderProject)とタスクタグ(readSenderTags)を返す。
 * 無い・読めない・形が違う・ほかのセッションのものなら null
 */
export async function readSenderMeta(path: string, id: string): Promise<{ project: { project: string; source: ProjectSource | null } | null; tags: string[]; atlas: AtlasBuild | null } | null> {
  if (!existsSync(path)) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isRow(j) || j.version !== 1 || j.id !== id) return null;
  return { project: senderProjectOf(j), tags: senderTagsOf(j), atlas: parseAtlasBuild(j.atlas) };
}

function senderProjectOf(j: Record<string, unknown>): { project: string; source: ProjectSource | null } | null {
  if (typeof j.project !== 'string' || j.project.length > 1000) return null;
  const project = j.project.trim();
  if (!project || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(project)) return null;
  const grouped = GROUPED_SOURCE.get(project);
  if (grouped) return { project, source: grouped };
  const source = typeof j.projectSource === 'string' && PROJECT_SOURCES.includes(j.projectSource) ? (j.projectSource as ProjectSource) : null;
  return { project, source: source && GROUPED_SOURCES.has(source) ? null : source };
}

/** 送った人のタスクタグの数と長さの上限(共有フォルダに置かれたファイルなので、大きすぎるものは使わない) */
const SENDER_TAGS_MAX = 50;
const SENDER_TAG_CHARS = 100;

/**
 * アップロードで添えた記録(UPLOAD_SESSION_META)から、送った人がそのセッションに付けていたタスクタグを読む。
 * 無い・読めない・形が違う・ほかのセッションのものなら空。名前の扱いは readSenderProject と同じ(前後の空白を落とし、
 * 制御文字と見えない書式の文字を含むもの、長すぎるものは使わない)。同じ名前は 1 つにする
 */
export async function readSenderTags(path: string, id: string): Promise<string[]> {
  return (await readSenderMeta(path, id))?.tags ?? [];
}

/** 上限は使えるものを数えてから掛ける(先頭に使えない名前や重なりが並んでも、後ろの使える名前を落とさない) */
function senderTagsOf(j: Record<string, unknown>): string[] {
  if (!Array.isArray(j.tags)) return [];
  const out: string[] = [];
  for (const t of j.tags) {
    if (out.length >= SENDER_TAGS_MAX) break;
    if (typeof t !== 'string') continue;
    const name = t.trim();
    if (!name || [...name].length > SENDER_TAG_CHARS || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 決め方の記録が無いプロジェクト名から、決め方を推す(まとめ用の名前はそれぞれ、owner/repo の形は git の origin、ほかはパス) */
function inferProjectSource(project: string): ProjectSource {
  if (project === TEMP_PROJECT) return 'temp';
  if (project === HOME_PROJECT) return 'home';
  if (project === ATLAS_JUDGE_PROJECT) return 'atlas-judge';
  return /^[^\\/:\s]+\/[^\\/:\s]+$/.test(project) ? 'git-remote' : 'path';
}

/** desktopForSession が返す形か(添えたファイルを信じる前に確かめる) */
function isDesktopSessionInfo(v: unknown): v is DesktopSessionInfo {
  if (!isRow(v)) return false;
  const d = v as Record<string, unknown>;
  return isRowOrNull(d.session) && isRows(d.contextUsage) && isRows(d.checkpoints) && isRows(d.activity) && isRowOrNull(d.workspace) && isRowOrNull(d.project);
}

/**
 * スナップショット側の session.db から todo の状態別件数と依存の数を読む(タイトル・説明は読まない)。
 * todos テーブルが無ければ 0 件として返す。ファイルが無ければ null
 */
export async function readTodos(dbPath: string): Promise<TodoSummary | null> {
  if (!existsSync(dbPath)) return null;
  const db = await openReadOnly(dbPath);
  try {
    const out: TodoSummary = { total: 0, byStatus: {}, deps: 0 };
    if (tableExists(db, 'todos')) {
      for (const r of db.prepare('SELECT status, count(*) AS n FROM todos GROUP BY status').all() as { status: string | null; n: number }[]) {
        const k = r.status ?? '(unknown)';
        out.byStatus[k] = (out.byStatus[k] ?? 0) + Number(r.n);
        out.total += Number(r.n);
      }
    }
    if (tableExists(db, 'todo_deps')) out.deps = Number((db.prepare('SELECT count(*) AS n FROM todo_deps').get() as { n: number }).n);
    return out;
  } finally {
    db.close();
  }
}

export async function readWorkspaceYaml(path: string): Promise<WorkspaceInfo | null> {
  if (!existsSync(path)) return null;
  const v = parseYaml(await readFile(path, 'utf8'));
  if (!v || typeof v !== 'object') throw new Error(`workspace.yaml がマップでない: ${path}`);
  // YAML の日付型は文字列に戻す
  const out: WorkspaceInfo = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val instanceof Date ? val.toISOString() : val;
  return out;
}

/**
 * session-state/ 配下のセッションディレクトリ(workspace.yaml か events.jsonl を持つもの)。
 * アップロードの作業用のフォルダ(.<id>.uploading / .<id>.old)は同じセッションの複製なので入れない(前の版が写したスナップショットに残っていても数えない)
 */
export async function listSessionDirs(stateDir: string): Promise<string[]> {
  return (await listStateDirs(stateDir)).sessions;
}

/**
 * session-state/ 配下の、セッションのファイルを持つフォルダの名前(1 回読んで分ける)。
 * sessions はセッションのフォルダ、work は残っているアップロードの作業用のフォルダ(どちらも名前の順)
 */
async function listStateDirs(stateDir: string): Promise<{ sessions: string[]; work: string[] }> {
  const sessions: string[] = [];
  const work: string[] = [];
  if (!existsSync(stateDir)) return { sessions, work };
  for (const ent of await readdir(stateDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !hasSessionFile(join(stateDir, ent.name))) continue;
    (isUploadWorkDir(ent.name) ? work : sessions).push(ent.name);
  }
  return { sessions: sessions.sort(), work: work.sort() };
}

export interface ExtractOptions {
  /** 指定時はこの時刻以降に更新されたセッションだけ(未指定ならスナップショットの since を使う) */
  since?: string | null;
  onProgress?: (done: number, total: number, id: string) => void;
  /**
   * プロジェクトの統合(git の origin・ホーム・一時フォルダ)の設定。false なら統合しない(パスのまま)。
   * 既定はこのマシンのホーム・一時フォルダと、スナップショット元が <home>/.copilot ならその <home>。
   */
  projects?: ProjectResolverOptions | false;
  /** 参照を数える wiki の vault。未指定か空なら数えない */
  wikis?: WikiSpec[];
}

/**
 * スナップショット(snapshot() の出力先、または同じ構造のディレクトリ)から sessions.json を作る。
 * 索引は session-store.db の sessions とディレクトリの和集合。
 */
export async function extract(snapshotDir: string, opts: ExtractOptions = {}): Promise<SessionsFile> {
  const manifest = await readSnapshotManifest(snapshotDir);
  const since = opts.since !== undefined ? opts.since : (manifest?.since ?? null);
  const sinceMs = since ? Date.parse(since) : null;
  const store = await loadStore(join(snapshotDir, 'session-store.db'));
  // Phase 11: data.db の許可リストの列(snapshot が desktop.json に書いたもの)。無ければ null
  const messages: string[] = [];
  let desktop: DesktopData | null = null;
  const desktopPath = join(snapshotDir, DESKTOP_JSON);
  if (existsSync(desktopPath)) {
    try {
      desktop = JSON.parse(await readFile(desktopPath, 'utf8')) as DesktopData;
    } catch (e) {
      desktop = null;
      messages.push(`${DESKTOP_JSON} を読めない(デスクトップアプリの記録は使っていない): ${(e as Error).message}`);
    }
  }
  const stateDir = join(snapshotDir, 'session-state');
  const listed = await listStateDirs(stateDir);
  const dirs = new Set(listed.sessions);
  const work = (manifest?.extras?.skipped ?? []).filter((x) => x.reason === UPLOAD_WORK_REASON).map((x) => x.path);
  if (work.length) messages.push(`アップロードの置き換えの途中か消し残しのフォルダ ${work.length} 件は、セッションとして数えていない(${work.slice(0, 3).join('、')}${work.length > 3 ? ' ほか' : ''})`);
  // 本体が無く、退けた前のフォルダだけが残っているもの。共有から消したセッションと見分けられないので数えず、どうすればよいかを出す
  // (前の集計の複製が出力先に残っていて数えているものは、出さない)
  const oldOnlyId = (x: { path: string }): string => uploadWorkDirId(basename(x.path)) ?? '';
  const oldOnlyRows = (manifest?.extras?.skipped ?? []).filter((x) => x.reason === UPLOAD_OLD_ONLY_REASON && !dirs.has(oldOnlyId(x)));
  const oldOnly = oldOnlyRows.map((x) => x.path);
  if (oldOnly.length) {
    // まとめて読むときは、同じセッションのものが複数のフォルダにあることがある(件数はセッションの数)
    messages.push(
      `本体のフォルダが無く、アップロードの置き換えで退けた前のフォルダだけが残っているセッション ${new Set(oldOnlyRows.map(oldOnlyId)).size} 件は、数えていない(${oldOnly.slice(0, 3).join('、')}${oldOnly.length > 3 ? ' ほか' : ''})。` +
        '共有から消したセッションなら、このフォルダも消すと出なくなる。消した覚えが無ければ、送った PC でもう一度アップロードすると戻る',
    );
  }
  // 前の版が写した作業用のフォルダが出力先に残っているとき(今の版は写さない)。数えないので、前の集計より件数が減った理由を出す
  const stale = listed.work;
  if (stale.length) {
    messages.push(
      `前の版が写した、アップロードの作業用のフォルダ ${stale.length} 件が出力先に残っている。セッションとして数えていない(${stale.slice(0, 3).join('、')}${stale.length > 3 ? ' ほか' : ''})。` +
        `要らなければ ${stateDir} の下から消してよい`,
    );
  }
  const recovered = manifest?.extras?.recovered ?? [];
  if (recovered.length) {
    messages.push(
      `アップロードの置き換えが途中で止まっていたセッション ${recovered.length} 件は、写し終えていた作業用のフォルダから読んだ(${recovered
        .slice(0, 3)
        .map((r) => r.path)
        .join('、')}${recovered.length > 3 ? ' ほか' : ''})。送った PC でもう一度アップロードすると、元の形に戻る`,
    );
  }
  // アップロード先から集計し直すとき: セッションのフォルダに添えた session-store.db と data.db の行を足す
  const dirDesktops = new Map<string, DesktopSessionInfo>();
  for (const id of dirs) {
    const p = join(stateDir, id, SESSION_STORE_JSON);
    if (!existsSync(p)) continue;
    const w = await mergeSessionStoreJson(store, id, p, dirDesktops);
    if (w) messages.push(w);
  }

  const ids = [...new Set([...store.sessions.keys(), ...dirs])].sort();
  // アップロード先から集計し直すとき(直下にセッションが並ぶ形と、そのフォルダをまとめて読む形)は、ログのパスを読む側の PC のディスクで調べない
  // (送った人の作業フォルダは無いか、同じパスに別のリポジトリがある。ネットワークのパスなら読みに行ってしまう)。
  // プロジェクト名は、送った側が決めて添えた記録(UPLOAD_SESSION_META)から取る
  const layout = manifest?.layout === 'flat' || manifest?.layout === 'merged' ? manifest.layout : null;
  const uploaded = layout != null;
  const resolver = opts.projects === false ? null : new ProjectResolver({ ...withSourceHome(opts.projects ?? {}, manifest?.sourceRoot ?? null), ...(uploaded ? { readGit: false } : {}) });
  const wikiClassifier = new WikiClassifier(opts.wikis);
  const sessions: SessionRecord[] = [];
  const unknownAll: Record<string, number> = {};
  let badLines = 0;
  let done = 0;
  // セッションごとのファイル(workspace.yaml・events.jsonl・session.db・送った側の記録)を読むところは並べて行う
  // (1 件ずつだと、読み込みの待ちが件数分積み重なる)。プロジェクト名を決める・数を足す・警告を並べるところは、id の順に行う
  // (ProjectResolver は見つけたものを覚えて使い回し、警告の順も今までと同じにするため)
  const loaded = await mapLimit(ids, EXTRACT_CONCURRENCY, async (id) => {
    const hasDir = dirs.has(id);
    const dir = join(stateDir, id);
    const notes: string[] = [];
    let workspace: WorkspaceInfo | null = null;
    if (hasDir) {
      try {
        workspace = await readWorkspaceYaml(join(dir, 'workspace.yaml'));
      } catch (err) {
        notes.push(`${id}: workspace.yaml を読めない (${(err as Error).message})`);
      }
    }
    const eventsPath = join(dir, 'events.jsonl');
    const stats = newParseStats();
    const rec = await normalizeSession({
      id,
      hasDir,
      workspace,
      db: { session: store.sessions.get(id) ?? null, turns: store.turns.get(id), usage: store.usage.get(id), files: store.files.get(id) },
      events: hasDir && existsSync(eventsPath) ? parseEvents(eventsPath, stats) : null,
      eventStats: stats,
      wikiClassifier,
    });
    rec.events.badLines = stats.badLines;
    if (hasDir) {
      try {
        rec.todos = await readTodos(join(dir, SNAPSHOT_SESSION_DB));
      } catch (err) {
        notes.push(`${id}: session.db を読めない (${(err as Error).message})`);
      }
    }
    // 送り先から集計したときは、添えた記録(プロジェクト名とタスクタグ)を 1 度だけ読む
    const meta = uploaded && hasDir ? await readSenderMeta(join(dir, UPLOAD_SESSION_META), id) : null;
    return { id, rec, stats, meta, notes };
  });
  for (const { id, rec, stats, meta, notes } of loaded) {
    messages.push(...notes);
    if (resolver) {
      const p = resolver.resolve(rec);
      const sent = meta?.project ?? null;
      rec.project = sent?.project ?? p.project;
      rec.projectSource = sent ? (sent.source ?? (sent.project === p.project ? p.source : inferProjectSource(sent.project))) : p.source;
    }
    // 送り先をまとめて集計したとき(<人>/<プロジェクト> の下のセッション)は、人のフォルダの名前を持たせる
    rec.person = layout === 'merged' ? personOfFolder(manifest?.merged?.owners?.[id]) : null;
    // 送り先から集計したときは、そのセッションを数えたフォルダも持たせる(絞り込んだレポートで、対象のセッションがあるフォルダだけを見るため)
    if (uploaded) rec.uploadFolder = layout === 'merged' ? (manifest?.merged?.owners?.[id] ?? null) : '.';
    // 送り先から集計したときは、送った人が付けていたタスクタグも持たせる(画面は人ごとに分けて、読むだけで出す)
    if (uploaded) rec.uploadTags = meta?.tags ?? [];
    // 送り先から集計したときは、そのセッションのフォルダを写した atlas の版も持たせる(記録が無ければ null。古い版で送ったものを数えるため)
    if (uploaded) rec.uploadAtlas = meta?.atlas ?? null;
    rec.desktop = (desktop ? desktopForSession(desktop, id) : null) ?? dirDesktops.get(id) ?? null;
    rec.name = sessionName(rec.name, rec.desktop?.session?.title);
    done++;
    opts.onProgress?.(done, ids.length, id);
    if (sinceMs != null) {
      const u = rec.updatedAt ? Date.parse(rec.updatedAt) : NaN;
      if (!(u >= sinceMs)) continue;
    }
    if (stats.badLines > 0) messages.push(`${id}: 壊れた行 ${stats.badLines} 件をスキップ`);
    badLines += stats.badLines;
    for (const [t, n] of Object.entries(rec.unknownEventTypes)) unknownAll[t] = (unknownAll[t] ?? 0) + n;
    sessions.push(rec);
  }
  resolveInstructions(sessions);
  for (const t of Object.keys(unknownAll)) messages.push(`未知のイベント種別: ${t} (${unknownAll[t]} 件)`);
  if (resolver) messages.push(...resolver.warnings);
  for (const e of manifest?.sessionDbErrors ?? []) messages.push(`session.db を複製できなかった: ${e}`);
  for (const [name, d] of Object.entries(manifest?.databases ?? {})) if (!d.copied && d.error) messages.push(`${name} を今回は複製できなかった(${d.bytes ? '前回の複製を使用' : '前回の複製も無いため、このファイルの内容は使っていない'}): ${d.error}`);
  const installed = manifest?.installed ?? null;
  if (installed) for (const w of installed.warnings) messages.push(`インストール済みの記録: ${w}`);

  const both = sessions.filter((s) => s.sources.length === 2).length;
  const dbOnly = sessions.filter((s) => s.sources.length === 1 && s.sources[0] === 'db').length;
  if (desktop) for (const w of desktop.warnings) messages.push(`data.db: ${w}`);
  return {
    schemaVersion: SESSIONS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      root: manifest?.sourceRoot ?? null,
      snapshotDir,
      since,
      ...(layout ? { layout, ...(manifest?.merged ? { folders: manifest.merged.folders } : {}), ...(manifest?.uploads ? { uploads: manifest.uploads } : {}) } : {}),
    },
    desktop: desktop ? { readAt: desktop.readAt, wal: desktop.wal, coverage: desktop.coverage, warnings: desktop.warnings, sessions: desktop.tables.sessions?.length ?? 0 } : null,
    counts: { sessions: sessions.length, dbOnly, dirOnly: sessions.length - both - dbOnly, both, empty: sessions.filter((s) => s.empty).length },
    installed,
    ...(manifest?.installedByPerson ? { installedByPerson: manifest.installedByPerson } : {}),
    warnings: { unknownEventTypes: unknownAll, badLines, messages },
    sessions,
  };
}

/** スナップショット元が <home>/.copilot なら、その <home> もホームとして扱う(別のマシンのデータを読むとき用) */
function withSourceHome(o: ProjectResolverOptions, sourceRoot: string | null): ProjectResolverOptions {
  if (!sourceRoot || o.homes) return o;
  const parts = sourceRoot.split(/[\\/]+/);
  if (parts[parts.length - 1]?.toLowerCase() !== '.copilot') return o;
  return { ...o, homes: [homedir(), dirname(sourceRoot)] };
}
