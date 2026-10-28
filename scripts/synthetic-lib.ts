// 合成 fixture の生成で共用する小物(値はすべて架空)。
// scripts/synthetic-base.ts(001〜006・099)と scripts/synthetic-fixtures.ts(007〜013 と書き出し)が使う。

/** 架空のセッション ID(00000000-0000-4000-8000-0000000000NN) */
export const fakeId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 合成の「プロバイダ設定の ID」(実データの形 <UUID>/<model> を真似た架空の値) */
export const PROVIDER = '11111111-2222-4333-8444-555555555555';

export interface Ev {
  type: string;
  data: Record<string, unknown>;
  agentId?: string;
}

/** 直前のイベントとの間を既定の 1 秒より空ける(アイドル時間の確認用) */
export interface Gap {
  gapMs: number;
}

/**
 * イベントを JSONL の行にする。時刻は start から 1 秒ずつ進め、Gap があればその分だけ足す。
 * id は e1, e2, …、parentId は直前のイベントの id。
 */
export function lines(events: (Ev | Gap)[], start: string): string[] {
  const t0 = Date.parse(start);
  let offset = 0;
  let i = 0;
  const out: string[] = [];
  for (const e of events) {
    if ('gapMs' in e) {
      offset += e.gapMs;
      continue;
    }
    out.push(
      JSON.stringify({
        type: e.type,
        data: e.data,
        id: `e${i + 1}`,
        timestamp: new Date(t0 + offset).toISOString(),
        parentId: i === 0 ? null : `e${i}`,
        ...(e.agentId ? { agentId: e.agentId } : {}),
      }),
    );
    i++;
    offset += 1000;
  }
  return out;
}

/** lines() が i 番目(0 始まり、Gap を除く)のイベントに付ける時刻 */
export function timeOf(events: (Ev | Gap)[], start: string, index: number): string {
  const t0 = Date.parse(start);
  let offset = 0;
  let i = 0;
  for (const e of events) {
    if ('gapMs' in e) {
      offset += e.gapMs;
      continue;
    }
    if (i === index) return new Date(t0 + offset).toISOString();
    i++;
    offset += 1000;
  }
  throw new Error(`イベント ${index} が無い`);
}

/** 1 セッション分の合成データ(session-state/<id>/ に書く) */
export interface SyntheticSession {
  id: string;
  role: string;
  workspace: Record<string, unknown>;
  events: string[];
}

/** session-store.db の中身(テスト時に WAL の DB へ組み立てる) */
export interface SyntheticStore {
  sessions: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  assistant_usage_events: Record<string, unknown>[];
  session_files: Record<string, unknown>[];
}
