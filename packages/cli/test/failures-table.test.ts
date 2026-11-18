// out/tables/ の失敗と拒否ごとの表(failures.csv と atlas.sqlite の failures)。イベントはすべて架空のもの
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../../core/src/normalize.ts';
import { openReadOnly } from '../../core/src/sqlite.ts';
import type { CopilotEvent, SessionRecord } from '../../core/src/types.ts';
import { resolvePaths, runMetrics, type Paths } from '../src/commands.ts';
import { SQLITE_FILE } from '../src/tables.ts';

const T0 = Date.parse('2026-11-06T00:00:00Z');
const ev = (type: string, data: unknown, ms: number): CopilotEvent => ({ type, data, timestamp: new Date(T0 + ms).toISOString() });
const NO_FILTER = { since: null, project: null, client: null, model: null, branch: null };

/** 失敗 1 件と拒否 1 件のあるセッション */
function failing(id: string): Promise<SessionRecord> {
  return normalizeSession({
    id,
    events: [
      ev('session.start', { context: { cwd: 'X:\\synthetic-p' } }, 0),
      ev('user.message', { content: '直して' }, 1000),
      ev('tool.execution_start', { toolCallId: 'a', toolName: 'view', arguments: { path: 'X:\\synthetic-p\\a.ts' } }, 1100),
      ev('tool.execution_complete', { toolCallId: 'a', success: false, error: { code: 'failure', message: 'Path does not exist' } }, 1350),
      ev('tool.execution_start', { toolCallId: 'b', toolName: 'edit', arguments: { path: 'X:\\synthetic-p\\a.ts' } }, 1400),
      ev('tool.execution_complete', { toolCallId: 'b', success: false, error: { code: 'denied', message: 'denied by user' } }, 1500),
    ],
  });
}

const withoutLedger = (r: SessionRecord): SessionRecord => {
  const { failures: _f, failuresDropped: _d, ...analysis } = r.analysis;
  return { ...r, analysis };
};

async function metrics(p: Paths, sessions: SessionRecord[]): Promise<string> {
  await writeFile(
    p.sessions,
    JSON.stringify({ schemaVersion: 19, generatedAt: new Date(T0).toISOString(), source: { root: null, snapshotDir: p.snapshot, since: null }, counts: { sessions: sessions.length, dbOnly: 0, dirOnly: 0, both: sessions.length, empty: 0 }, installed: null, warnings: { unknownEventTypes: {}, badLines: 0 }, sessions }),
  );
  const logs: string[] = [];
  await runMetrics(p, NO_FILTER, (m) => logs.push(m));
  return logs.filter((l) => l.startsWith('metrics: 表 → ')).at(-1) ?? '';
}

const tablesOf = async (path: string): Promise<string[]> => {
  const db = await openReadOnly(path);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
};

describe('out/tables/ の failures.csv と SQLite の failures', () => {
  it('台帳があれば書き、台帳の無い古い記録だけなら書かず前のものも残さない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-failures-'));
    const p = resolvePaths({ home: join(dir, 'home'), out: dir, judgments: null, notesDir: join(dir, 'notes') });
    const tables = join(dir, 'tables');
    const csv = join(tables, 'failures.csv');

    const rec = await failing('00000000-0000-4000-8000-000000000031');
    let last = await metrics(p, [rec]);
    const lines = (await readFile(csv, 'utf8')).trimEnd().split('\r\n');
    expect(lines[0].startsWith('\ufeffセッションID,セッション名,プロジェクト,依頼番号,開始,種類,要因,ツール,')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(last).toContain('・sessions.csv・failures.csv・atlas.sqlite');
    expect(last).not.toContain('古い記録');
    expect(last).not.toContain('上限');
    expect(await tablesOf(join(tables, SQLITE_FILE))).toEqual(['failures', 'sessions', 'turns']);
    {
      const db = await openReadOnly(join(tables, SQLITE_FILE));
      try {
        // 列名は CSV の見出しと同じ
        const cols = (db.prepare("SELECT name FROM pragma_table_info('failures')").all() as { name: string }[]).map((r) => r.name);
        expect(cols).toEqual(lines[0].replace(/^\ufeff/, '').split(','));
        const rows = db.prepare('SELECT "依頼番号" AS t, "種類" AS k, "要因" AS c, "所要(ミリ秒)" AS ms, "その後" AS n, "呼び直し" AS r FROM failures ORDER BY rowid').all();
        expect(rows).toEqual([
          { t: 1, k: '失敗', c: '対象が見つからない', ms: 250, n: 'ツール', r: 0 },
          { t: 1, k: '拒否', c: '', ms: 100, n: '続きなし', r: null },
        ]);
        // 依頼番号で turns と結べる
        const joined = db.prepare('SELECT count(*) AS n FROM failures f JOIN turns t ON t."セッションID" = f."セッションID" AND t."依頼番号" = f."依頼番号"').get() as { n: number };
        expect(joined.n).toBe(2);
      } finally {
        db.close();
      }
    }

    // 台帳の無い古い記録だけ: 表を書かず、前の failures.csv を消す。SQLite にも入れない
    const old = withoutLedger(rec);
    last = await metrics(p, [old]);
    expect(existsSync(csv)).toBe(false);
    expect(await tablesOf(join(tables, SQLITE_FILE))).toEqual(['sessions', 'turns']);
    expect(last).not.toContain('・failures.csv');
    expect(last).toContain('(失敗の台帳が無い古い記録 1 セッションは failures.csv に入りません。集計し直すと付きます)');

    // 混ざっているとき: 台帳のある記録の行だけを書き、載せていない件数を知らせる
    const capped = await failing('00000000-0000-4000-8000-000000000032');
    capped.analysis.failuresDropped = 3;
    last = await metrics(p, [{ ...old, id: '00000000-0000-4000-8000-000000000033' }, capped]);
    expect(
      (await readFile(csv, 'utf8'))
        .trimEnd()
        .split('\r\n')
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual([capped.id, capped.id]);
    expect(await tablesOf(join(tables, SQLITE_FILE))).toEqual(['failures', 'sessions', 'turns']);
    expect(last).toContain('(1 セッション 500 行の上限で failures.csv に載せていない失敗・拒否 3 件)');
    expect(last).toContain('(失敗の台帳が無い古い記録 1 セッション');
  });
});
