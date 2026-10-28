// 生成した fixture(.fixtures/copilot-home)から「~/.copilot と同じ形」の作業ディレクトリを組み立てる。
// .fixtures/ は e2e/global-setup.ts が scripts/synthetic-fixtures.ts で毎回作り直す(架空の値だけ。git には入れない)。
// session-store.db は別プロセスの書き手が WAL モード(自動チェックポイント無効)で作る。
// → 実環境と同じく本体 + -wal + -shm が並び、行は WAL にだけある状態になる。
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWritable, type Database } from '../packages/core/src/sqlite.ts';
import { FIXTURES_DIR } from '../scripts/synthetic-fixtures.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 生成した fixture のデータ(.fixtures/) */
export const FIXTURES = FIXTURES_DIR;
/** テスト用のコード(偽の copilot)。データは置かない */
export const FIXTURE_CODE = join(ROOT, 'fixtures');

const SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), turn_index INTEGER NOT NULL,
  user_message TEXT, assistant_response TEXT, timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index));
CREATE TABLE session_files (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), file_path TEXT NOT NULL,
  tool_name TEXT, turn_index INTEGER, first_seen_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, file_path));
CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
  parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
  time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT,
  finish_reason TEXT, content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT DEFAULT (datetime('now')),
  output_ttft_ms REAL, copilot_usage_model TEXT);
`;

export interface FixtureStore {
  sessions: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  assistant_usage_events: Record<string, unknown>[];
  session_files: Record<string, unknown>[];
}

export async function readFixtureStore(): Promise<FixtureStore> {
  return JSON.parse(await readFile(join(FIXTURES, 'copilot-home', 'session-store.json'), 'utf8')) as FixtureStore;
}

function insertAll(db: Database, table: string, rows: Record<string, unknown>[]): void {
  for (const r of rows) {
    const cols = Object.keys(r).filter((k) => k !== 'id' || table === 'sessions');
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    stmt.run(...cols.map((c) => r[c] as never));
  }
}

/** 書き手: WAL モードで作って行を入れ、接続を開いたままにする(自動チェックポイント無効 → 行は WAL にだけある) */
export async function populateStore(dbPath: string): Promise<Database> {
  const store = await readFixtureStore();
  const writer = await openWritable(dbPath);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  writer.exec(SCHEMA);
  writer.exec('INSERT INTO schema_version VALUES (8)');
  insertAll(writer, 'sessions', store.sessions);
  insertAll(writer, 'turns', store.turns);
  insertAll(writer, 'assistant_usage_events', store.assistant_usage_events);
  insertAll(writer, 'session_files', store.session_files);
  return writer;
}

/**
 * dest に fixture の ~/.copilot を作る。session-store.db の書き手は別プロセスで動かす。
 * - writer: 'crashed'(既定): 書き手を強制終了し、本体 + -wal + -shm が残った状態にする。
 *   実環境の ~/.copilot はこの状態で、ここを読み取り専用で開くと SQLite が WAL インデックスを作り直して
 *   -shm を書く(mtime が変わる)ことを確認済み。
 * - writer: 'alive': 書き手が接続を開いたまま(Copilot 実行中に相当)。
 */
export async function buildFixtureHome(
  dest: string,
  opts: { writer?: 'crashed' | 'alive' } = {},
): Promise<{ home: string; close: () => Promise<void> }> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(join(FIXTURES, 'copilot-home', 'session-state'), join(dest, 'session-state'), { recursive: true });
  const child = spawn(process.execPath, [THIS_FILE, '--writer', join(dest, 'session-store.db')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  await new Promise<void>((resolveReady, reject) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      if (buf.includes('ready')) resolveReady();
    });
    child.on('exit', (code) => reject(new Error(`fixture の書き手が起動前に終了した (code ${code})`)));
  });
  if ((opts.writer ?? 'crashed') === 'crashed') {
    child.kill('SIGKILL');
    await exited;
    return { home: dest, close: async () => {} };
  }
  return {
    home: dest,
    close: async () => {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new Error(`fixture の書き手が異常終了した (code ${code})`);
    },
  };
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[2] === '--writer' && process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  const w = await populateStore(process.argv[3]);
  process.stdout.write('ready\n');
  process.stdin.resume();
  process.stdin.on('end', () => {
    w.close();
    process.exit(0);
  });
}
