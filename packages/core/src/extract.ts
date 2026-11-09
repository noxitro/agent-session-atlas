import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { newParseStats, parseEvents } from './events.ts';
import { resolveInstructions } from './instructions.ts';
import { normalizeSession } from './normalize.ts';
import { ProjectResolver, type ProjectResolverOptions } from './project.ts';
import { DESKTOP_JSON, readSnapshotManifest, SESSION_STORE_JSON, SNAPSHOT_SESSION_DB } from './snapshot.ts';
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

/** session-store.db からセッション 1 件分の行を取り出す(アップロードで添える)。DB が無いか、そのセッションの行が 1 つも無ければ null */
export async function sessionStoreRows(dbPath: string, id: string): Promise<SessionStoreJson | null> {
  if (!existsSync(dbPath)) return null;
  const db = await openReadOnly(dbPath);
  try {
    const rows = <T>(q: (typeof STORE_QUERIES)[keyof typeof STORE_QUERIES]): T[] =>
      tableExists(db, q.table) ? (db.prepare(`${q.sql} WHERE ${q.key} = ?${q.order}`).all(id) as unknown as T[]).map((r) => ({ ...r })) : [];
    const out: SessionStoreJson = {
      version: 1,
      schemaVersion: tableExists(db, 'schema_version') ? ((db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version ?? null) : null,
      sessions: rows<DbSessionRow>(STORE_QUERIES.sessions),
      turns: rows<DbTurnRow>(STORE_QUERIES.turns),
      usage: rows<DbUsageRow>(STORE_QUERIES.usage),
      files: rows<DbFileRow>(STORE_QUERIES.files),
    };
    return out.sessions.length + out.turns.length + out.usage.length + out.files.length ? out : null;
  } finally {
    db.close();
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
  // data.db の行(desktop.json に同じセッションがあればそちらを使う。extract が決める)
  if (desktops && j.desktop && typeof j.desktop === 'object') desktops.set(id, j.desktop);
  if (store.schemaVersion == null && j.schemaVersion != null) store.schemaVersion = j.schemaVersion;
  return null;
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

/** session-state/ 配下のセッションディレクトリ(workspace.yaml か events.jsonl を持つもの) */
export async function listSessionDirs(stateDir: string): Promise<string[]> {
  if (!existsSync(stateDir)) return [];
  const out: string[] = [];
  for (const ent of await readdir(stateDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const d = join(stateDir, ent.name);
    if (existsSync(join(d, 'workspace.yaml')) || existsSync(join(d, 'events.jsonl'))) out.push(ent.name);
  }
  return out.sort();
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
  let desktop: DesktopData | null = null;
  const desktopPath = join(snapshotDir, DESKTOP_JSON);
  if (existsSync(desktopPath)) {
    try {
      desktop = JSON.parse(await readFile(desktopPath, 'utf8')) as DesktopData;
    } catch (e) {
      desktop = null;
    }
  }
  const stateDir = join(snapshotDir, 'session-state');
  const dirs = new Set(await listSessionDirs(stateDir));
  const messages: string[] = [];
  // アップロード先から集計し直すとき: セッションのフォルダに添えた session-store.db と data.db の行を足す
  const dirDesktops = new Map<string, DesktopSessionInfo>();
  for (const id of dirs) {
    const p = join(stateDir, id, SESSION_STORE_JSON);
    if (!existsSync(p)) continue;
    const w = await mergeSessionStoreJson(store, id, p, dirDesktops);
    if (w) messages.push(w);
  }

  const ids = [...new Set([...store.sessions.keys(), ...dirs])].sort();
  const resolver = opts.projects === false ? null : new ProjectResolver(withSourceHome(opts.projects ?? {}, manifest?.sourceRoot ?? null));
  const wikiClassifier = new WikiClassifier(opts.wikis);
  const sessions: SessionRecord[] = [];
  const unknownAll: Record<string, number> = {};
  let badLines = 0;
  let done = 0;
  for (const id of ids) {
    const hasDir = dirs.has(id);
    const dir = join(stateDir, id);
    let workspace: WorkspaceInfo | null = null;
    if (hasDir) {
      try {
        workspace = await readWorkspaceYaml(join(dir, 'workspace.yaml'));
      } catch (err) {
        messages.push(`${id}: workspace.yaml を読めない (${(err as Error).message})`);
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
        messages.push(`${id}: session.db を読めない (${(err as Error).message})`);
      }
    }
    if (resolver) {
      const p = resolver.resolve(rec);
      rec.project = p.project;
      rec.projectSource = p.source;
    }
    rec.desktop = (desktop ? desktopForSession(desktop, id) : null) ?? dirDesktops.get(id) ?? null;
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
    source: { root: manifest?.sourceRoot ?? null, snapshotDir, since },
    desktop: desktop ? { readAt: desktop.readAt, wal: desktop.wal, coverage: desktop.coverage, warnings: desktop.warnings, sessions: desktop.tables.sessions?.length ?? 0 } : null,
    counts: { sessions: sessions.length, dbOnly, dirOnly: sessions.length - both - dbOnly, both, empty: sessions.filter((s) => s.empty).length },
    installed,
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
