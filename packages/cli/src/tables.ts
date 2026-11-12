// 表計算ソフトで開く表(依頼ごとの turns.csv・セッションごとの sessions.csv・VCS の照合のまとまりごとの vcs-hunks.csv)と、
// 同じ中身の SQLite(atlas.sqlite)を作る。out/tables/(metrics・build・export)とグループの書き出し(out/groups/<名前>/)が同じものを使う。
import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import {
  openWritable,
  readVcsRetention,
  retentionHunksTable,
  sessionsTable,
  toCsv,
  turnsTable,
  type SessionRecord,
  type SessionRetention,
  type Table,
  type VcsRetentionFile,
} from '../../core/src/index.ts';
import { readJudgments } from '../../judge/src/index.ts';
import { parseVerdicts } from '../../report/src/index.ts';

/** 表と同じ中身の SQLite(out/tables/ とグループの書き出しの中) */
export const SQLITE_FILE = 'atlas.sqlite';

export interface TablePaths {
  /** 工数の判定(judgments.json) */
  judgments: string;
  /** 依頼ごとの判定(turn-judgments.json) */
  turnJudgments: string;
  /** AI の変更が作業後の VCS に残っているか(vcs-retention.json)。無ければ照合の列を付けない */
  vcsRetention?: string;
}

export interface Tables {
  turns: string;
  sessions: string;
  /** VCS の照合のまとまりごとの表(照合の結果が無ければ null) */
  vcsHunks: string | null;
  /** SQLite に入れる表(名前 → 中身) */
  data: Record<string, Table>;
  /** turns.csv に依頼ごとの判定の列が入ったか */
  withVerdicts: boolean;
  /** sessions.csv に VCS の照合の列が入ったか */
  withRetention: boolean;
  /** 判定のファイルを読めなかったとき(表は判定の列なしで作る) */
  warnings: string[];
}

export async function buildTables(sessions: SessionRecord[], p: TablePaths): Promise<Tables> {
  const warnings: string[] = [];
  const j = existsSync(p.judgments)
    ? await readJudgments(p.judgments).catch((e: Error) => {
        warnings.push(`${p.judgments} を読めないため、推定人手工数の列は空にします(${e.message})`);
        return null;
      })
    : null;
  let verdicts: ReturnType<typeof parseVerdicts> = null;
  if (existsSync(p.turnJudgments)) {
    try {
      verdicts = parseVerdicts(JSON.parse(await readFile(p.turnJudgments, 'utf8')));
    } catch (e) {
      warnings.push(`${p.turnJudgments} を読めないため、依頼ごとの判定の列は付けません(${(e as Error).message})`);
    }
  }
  let retention: VcsRetentionFile | null = null;
  if (p.vcsRetention && existsSync(p.vcsRetention)) {
    retention = await readVcsRetention(p.vcsRetention);
    if (!retention) warnings.push(`${p.vcsRetention} を読めないため、VCS の照合の列は付けません(atlas vcs で作り直せます)`);
  }
  // 表に載せるセッションの照合の結果だけを使う(絞り込みに合わせる)
  const ids = new Set(sessions.map((s) => s.id));
  const byId: Map<string, SessionRetention> | null = retention ? new Map(retention.sessions.filter((r) => ids.has(r.sessionId)).map((r) => [r.sessionId, r])) : null;
  const turns = turnsTable(sessions, verdicts?.bySession ?? null);
  const sess = sessionsTable(sessions, new Map((j?.items ?? []).map((i) => [i.sessionId, i.humanEffort.hours])), byId);
  const hunks = byId ? retentionHunksTable([...byId.values()]) : null;
  return {
    turns: toCsv(turns.header, turns.rows),
    sessions: toCsv(sess.header, sess.rows),
    vcsHunks: hunks ? toCsv(hunks.header, hunks.rows) : null,
    data: { turns, sessions: sess, ...(hunks ? { vcs_hunks: hunks } : {}) },
    withVerdicts: !!verdicts,
    withRetention: !!byId,
    warnings,
  };
}

/** SQLite の名前(表・列)の引用。列名は CSV の見出しそのもの(日本語)なので、必ず "…" で囲む */
const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * 表を SQLite のファイルに書く(CSV と同じ列。型は値から SQLite が決める)。書き終えてから置き換えるので、
 * 途中で止まっても前のファイルは壊れない
 */
export async function writeSqlite(path: string, tables: Record<string, Table>): Promise<void> {
  const tmp = `${path}.writing`;
  await rm(tmp, { force: true });
  const db = await openWritable(tmp);
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec('BEGIN');
    for (const [name, t] of Object.entries(tables)) {
      // 同じ見出しが 2 回ある表は無いが、念のため 2 つ目以降に番号を付ける
      const seen = new Map<string, number>();
      const cols = t.header.map((h) => {
        const n = (seen.get(h) ?? 0) + 1;
        seen.set(h, n);
        return n > 1 ? `${h}_${n}` : h;
      });
      db.exec(`CREATE TABLE ${ident(name)} (${cols.map(ident).join(', ')})`);
      const ins = db.prepare(`INSERT INTO ${ident(name)} VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of t.rows) ins.run(...r.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  await rm(path, { force: true });
  await rename(tmp, path);
}
