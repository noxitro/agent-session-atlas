// node:sqlite の読み込み。ExperimentalWarning(SQLite)だけを抑制し、他の警告は従来どおり出す。
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

let loaded: typeof import('node:sqlite') | null = null;
let filterInstalled = false;

function installWarningFilter(): void {
  if (filterInstalled) return;
  filterInstalled = true;
  // 既定の warning リスナー(stderr 出力)を外し、SQLite の ExperimentalWarning 以外を同じ形式で出し直す
  const previous = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w: Error & { name: string }) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    if (previous.length > 0) for (const l of previous) (l as (w: Error) => void)(w);
    else process.stderr.write(`(node) ${w.name}: ${w.message}\n`);
  });
}

export async function loadSqlite(): Promise<typeof import('node:sqlite')> {
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

/** SQL 文字列リテラル用のエスケープ */
export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
