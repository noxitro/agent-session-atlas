// atlas serve の API(画面と保存の境界)。http(s) で開かれ、serve が meta に token を入れたときだけ使える。
// file:// で開いたときは token がプレースホルダのままなので何も呼ばない(console にエラーを出さない)。
// fetch の宛先は同一オリジンの相対パス 'api/…' だけ(E2E の外部参照の検査はこの形だけを許す)。
import type { MemoSummary } from '../lib/memo.ts';
import type { ReportGroup } from '../lib/types.ts';

export interface ApiState {
  version: number;
  groups: ReportGroup[];
  /** セッション id → メモの概要(メモの API より古い serve には無い) */
  memos?: Record<string, MemoSummary>;
  notesDir: string;
  groupsPath: string;
  exists: boolean;
  warnings: string[];
}

/** serve が差し込んだ token。http(s) 以外・無し・プレースホルダ(__ で始まる)なら null */
export function serveToken(): string | null {
  if (!/^https?:$/.test(location.protocol)) return null;
  const t = document.querySelector<HTMLMetaElement>('meta[name="atlas-token"]')?.content ?? '';
  return t && !t.startsWith('__') ? t : null;
}

async function parse<T>(r: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = r.status === 204 ? null : await r.json();
  } catch {
    /* 本文が JSON でなければ状態コードだけで判断 */
  }
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `サーバの応答 ${r.status}`);
  return body as T;
}

const headers = (token: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-atlas-token': token });
/** 接続できない(サーバが止まった等)ときの TypeError を日本語の理由にする */
const connect = <T>(p: Promise<Response>, parseBody: (r: Response) => Promise<T>): Promise<T> =>
  p.then(parseBody, () => {
    throw new Error('サーバに接続できません(atlas.bat を実行し直してください)');
  });

/** グループの書き出しの結果(serve の group-export.ts と同じ形) */
export interface GroupExport {
  name: string;
  dir: string;
  sessions: number;
  turns: number;
  records: number;
  missing: number;
}

export const api = {
  state(): Promise<ApiState> {
    return connect(fetch('api/state', { cache: 'no-store' }), (r) => parse<ApiState>(r));
  },
  create(token: string, g: ReportGroup): Promise<{ group: ReportGroup; groups: ReportGroup[] }> {
    return connect(fetch('api/groups', { method: 'POST', headers: headers(token), body: JSON.stringify(g) }), (r) => parse(r));
  },
  /** patch は name / note / ids の全置換か、add / remove の差分(サーバが最新の ids に適用する。ids とは同時に使えない) */
  update(
    token: string,
    name: string,
    patch: Partial<ReportGroup> & { add?: string[]; remove?: string[] },
  ): Promise<{ group: ReportGroup; groups: ReportGroup[]; added: number; dup: number; removed: number }> {
    return connect(fetch('api/groups/' + encodeURIComponent(name), { method: 'PUT', headers: headers(token), body: JSON.stringify(patch) }), (r) => parse(r));
  },
  remove(token: string, name: string): Promise<{ groups: ReportGroup[] }> {
    return connect(fetch('api/groups/' + encodeURIComponent(name), { method: 'DELETE', headers: headers(token) }), (r) => parse(r));
  },
  /** グループの表(CSV)・集計・記録を out/groups/<名前>/ に書き出す */
  exportGroup(token: string, name: string): Promise<GroupExport> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/export', { method: 'POST', headers: headers(token) }), (r) => parse<GroupExport>(r));
  },
};

/** Phase 14: 画面から動かす処理(serve の jobs.ts と同じ形) */
export type JobKind = 'refresh' | 'judge' | 'full' | 'bundle' | 'export' | 'turn-bundle' | 'turn-judge';
/** 何を判定するか: 工数(セッションごと)/ 依頼ごとの採用・種類・工程 */
export type JudgeTarget = 'effort' | 'turns';
export type JobBackend = 'copilot-cli' | 'opencode';
export interface JobInfo {
  id: string;
  kind: JobKind;
  state: 'running' | 'done' | 'failed' | 'canceled';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  log: string[];
  target: { limit?: number; backend?: JobBackend; id?: string };
}
export type JobRequest =
  | { kind: 'refresh' }
  | { kind: 'judge'; limit: number; backend: JobBackend }
  | { kind: 'bundle' }
  | { kind: 'export' }
  | { kind: 'turn-bundle' }
  | { kind: 'turn-judge'; limit: number };

export const jobsApi = {
  /** 最後のジョブ(まだ無ければ null) */
  current(token: string): Promise<JobInfo | null> {
    return connect(fetch('api/jobs/current', { cache: 'no-store', headers: headers(token) }), (r) => parse<JobInfo | null>(r));
  },
  start(token: string, req: JobRequest): Promise<JobInfo> {
    return connect(fetch('api/jobs', { method: 'POST', headers: headers(token), body: JSON.stringify(req) }), (r) => parse<JobInfo>(r));
  },
  cancel(token: string): Promise<JobInfo> {
    return connect(fetch('api/jobs/current/cancel', { method: 'POST', headers: headers(token) }), (r) => parse<JobInfo>(r));
  },
  /** 判定の確認ダイアログの件数(工数: 依頼の記録があるセッション / 依頼: 依頼ごとの記録がある依頼。そのうち未判定のもの) */
  judgePreview(token: string, target: JudgeTarget = 'effort'): Promise<{ eligible: number; judged: number; pending: number; withoutTurns?: number }> {
    return connect(fetch('api/jobs/judge-preview' + (target === 'turns' ? '?target=turns' : ''), { cache: 'no-store', headers: headers(token) }), (r) => parse(r));
  },
};

/** チャットでの判定の添付ファイル(bundle/parts/)。path は atlas.html からの相対パス */
export interface ChatPart {
  path: string;
  name: string;
  sessions: number;
  judged: number;
  bytes: number;
}
export interface ChatParts {
  exists: boolean;
  generatedAt?: string;
  /** 未判定のセッションだけで作ったか(CLI の bundle で全件から作ったものは false) */
  unjudgedOnly?: boolean;
  count?: number;
  parts?: ChatPart[];
}
export interface ChatImportResult {
  imported: number;
  overwritten: number;
  duplicates: number;
  unknownIds: string[];
  total: number;
  parts: ChatParts;
}
/** 取り込みの失敗。problems は形が合わない項目の一覧(返答のどこが違うか) */
export class ChatImportError extends Error {
  problems: string[];
  constructor(message: string, problems: string[]) {
    super(message);
    this.problems = problems;
  }
}

const q = (target: JudgeTarget): string => (target === 'turns' ? '?target=turns' : '');

/** チャットでの判定。target が turns なら依頼ごとの判定(sessions / judged は依頼の数) */
export const chatJudgeApi = {
  parts(token: string, target: JudgeTarget = 'effort'): Promise<ChatParts> {
    return connect(fetch('api/judge/parts' + q(target), { cache: 'no-store', headers: headers(token) }), (r) => parse<ChatParts>(r));
  },
  /** 添付ファイルの本文(「本文をコピー」) */
  partText(token: string, name: string, target: JudgeTarget = 'effort'): Promise<string> {
    return connect(fetch('api/judge/parts/' + encodeURIComponent(name) + q(target), { cache: 'no-store', headers: headers(token) }), async (r) => (await parse<{ text: string }>(r)).text);
  },
  importText(token: string, text: string, target: JudgeTarget = 'effort'): Promise<ChatImportResult> {
    return connect(fetch('api/judge/import' + q(target), { method: 'POST', headers: headers(token), body: JSON.stringify({ text }) }), async (r) => {
      if (r.ok) return (await r.json()) as ChatImportResult;
      let body: { error?: string; problems?: string[] } | null = null;
      try {
        body = await r.json();
      } catch {
        /* 本文が JSON でなければ状態コードだけ */
      }
      throw new ChatImportError(body?.error ?? `サーバの応答 ${r.status}`, body?.problems ?? []);
    });
  },
};

/** 3 秒ごとに heartbeat を送る。失敗したら onDown を 1 回呼んで止める。戻り値で止められる */
export function startHeartbeat(token: string, onDown: () => void, intervalMs = 3000): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const beat = (): void => {
    fetch('api/heartbeat', { method: 'POST', headers: headers(token), keepalive: true })
      .then((r) => {
        if (!r.ok) {
          stop();
          onDown();
        }
      })
      .catch(() => {
        stop();
        onDown();
      });
  };
  timer = setInterval(beat, intervalMs);
  beat();
  return stop;
}
