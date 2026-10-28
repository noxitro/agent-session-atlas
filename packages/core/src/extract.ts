import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { newParseStats, parseEvents } from './events.ts';
import { resolveInstructions } from './instructions.ts';
import { normalizeSession } from './normalize.ts';
import { ProjectResolver, type ProjectResolverOptions } from './project.ts';
import { readSnapshotManifest, SNAPSHOT_SESSION_DB } from './snapshot.ts';
import { openReadOnly } from './sqlite.ts';
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

/** session-store.db(スナップショット側)を読む。無ければ空 */
export async function loadStore(dbPath: string): Promise<StoreData> {
  const empty: StoreData = { sessions: new Map(), turns: new Map(), usage: new Map(), files: new Map(), schemaVersion: null };
  if (!existsSync(dbPath)) return empty;
  const db = await openReadOnly(dbPath);
  try {
    const all = <T>(table: string, sql: string): T[] => (tableExists(db, table) ? (db.prepare(sql).all() as unknown as T[]) : []);
    const sessions = all<DbSessionRow>('sessions', 'SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions');
    const turns = all<DbTurnRow>('turns', 'SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns');
    const usage = all<DbUsageRow>('assistant_usage_events', 'SELECT * FROM assistant_usage_events ORDER BY id');
    const files = all<DbFileRow>('session_files', 'SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files');
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
  const stateDir = join(snapshotDir, 'session-state');
  const dirs = new Set(await listSessionDirs(stateDir));

  const ids = [...new Set([...store.sessions.keys(), ...dirs])].sort();
  const resolver = opts.projects === false ? null : new ProjectResolver(withSourceHome(opts.projects ?? {}, manifest?.sourceRoot ?? null));
  const sessions: SessionRecord[] = [];
  const messages: string[] = [];
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
  const installed = manifest?.installed ?? null;
  if (installed) for (const w of installed.warnings) messages.push(`インストール済みの記録: ${w}`);

  const both = sessions.filter((s) => s.sources.length === 2).length;
  const dbOnly = sessions.filter((s) => s.sources.length === 1 && s.sources[0] === 'db').length;
  return {
    schemaVersion: SESSIONS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: { root: manifest?.sourceRoot ?? null, snapshotDir, since },
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
