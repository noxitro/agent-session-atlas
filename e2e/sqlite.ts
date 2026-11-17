// テストが使う node:sqlite の読み込み(fixture の session-store.db を作る・出力の SQLite を読む)。
// ExperimentalWarning(SQLite)だけを抑え、ほかの警告は従来どおり出す。
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

let loaded: typeof import('node:sqlite') | null = null;
let filterInstalled = false;

function installWarningFilter(): void {
  if (filterInstalled) return;
  filterInstalled = true;
  const previous = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w: Error & { name: string }) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    if (previous.length > 0) for (const l of previous) (l as (w: Error) => void)(w);
    else process.stderr.write(`(node) ${w.name}: ${w.message}\n`);
  });
}

async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  if (loaded) return loaded;
  installWarningFilter();
  loaded = await import('node:sqlite');
  return loaded;
}

export type Database = DatabaseSyncType;

export async function openReadOnly(path: string): Promise<DatabaseSyncType> {
  const { DatabaseSync } = await loadSqlite();
  return new DatabaseSync(path, { readOnly: true });
}

export async function openWritable(path: string): Promise<DatabaseSyncType> {
  const { DatabaseSync } = await loadSqlite();
  return new DatabaseSync(path);
}

/** session-store.db に、そのセッションの使用量の行(assistant_usage_events)があるか */
export async function hasUsageRows(dbPath: string, id: string): Promise<boolean> {
  const db = await openReadOnly(dbPath);
  try {
    return db.prepare('SELECT 1 FROM assistant_usage_events WHERE session_id = ? LIMIT 1').get(id) != null;
  } finally {
    db.close();
  }
}
