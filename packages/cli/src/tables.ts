// 表計算ソフトで開く表(依頼ごとの turns.csv・セッションごとの sessions.csv)の中身を作る。
// out/tables/(metrics・build・export)とグループの書き出し(out/groups/<名前>/)が同じものを使う。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sessionsCsv, turnsCsv, type SessionRecord } from '../../core/src/index.ts';
import { readJudgments } from '../../judge/src/index.ts';
import { parseVerdicts } from '../../report/src/index.ts';

export interface TablePaths {
  /** 工数の判定(judgments.json) */
  judgments: string;
  /** 依頼ごとの判定(turn-judgments.json) */
  turnJudgments: string;
}

export interface Tables {
  turns: string;
  sessions: string;
  /** turns.csv に依頼ごとの判定の列が入ったか */
  withVerdicts: boolean;
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
  return {
    turns: turnsCsv(sessions, verdicts?.bySession ?? null),
    sessions: sessionsCsv(sessions, new Map((j?.items ?? []).map((i) => [i.sessionId, i.humanEffort.hours]))),
    withVerdicts: !!verdicts,
    warnings,
  };
}
