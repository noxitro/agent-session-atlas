// テストが使う node:sqlite の読み込み(fixture の session-store.db を作る・出力の SQLite を読む)。
// 読み込みは本体(packages/core/src/sqlite.ts)のものを使う(SQLite の ExperimentalWarning だけを抑える)。
import { openReadOnly } from '../packages/core/src/sqlite.ts';

export { openReadOnly, openWritable, type Database } from '../packages/core/src/sqlite.ts';

/** session-store.db に、そのセッションの使用量の行(assistant_usage_events)があるか */
export async function hasUsageRows(dbPath: string, id: string): Promise<boolean> {
  const db = await openReadOnly(dbPath);
  try {
    return db.prepare('SELECT 1 FROM assistant_usage_events WHERE session_id = ? LIMIT 1').get(id) != null;
  } finally {
    db.close();
  }
}
