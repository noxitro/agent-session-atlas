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
  /** グループのアップロード先(atlas.config.json の uploadRoot)。この機能より古い serve には無い */
  upload?: UploadSetting;
}

/** グループのアップロード先の設定。root は基底フォルダ(未設定は null)、error は設定ファイルを読めない理由、canPick はフォルダを選ぶ画面を出せるか */
export interface UploadSetting {
  root: string | null;
  error: string | null;
  canPick: boolean;
}

/** アップロードの操作(App が下の api をつなぎ、GroupHead が使う)。setting は今のアップロード先 */
export interface UploadHandlers {
  setting: UploadSetting;
  /** フォルダを選ぶ画面を出して既定にする。取り消したら null */
  pick: () => Promise<string | null>;
  /** 入力したパスを既定にする */
  setRoot: (root: string) => Promise<string>;
  /** 写す前の点検(大きさと秘密らしい文字列) */
  check: (name: string) => Promise<UploadCheck>;
  run: (name: string) => Promise<GroupUpload>;
  /** 写している途中の進み具合。終わっていれば直近の結果(10 分以内)。どちらでもなければ null */
  progress: (name: string) => Promise<UploadPoll>;
  open: (name: string) => Promise<void>;
}

/** 写す前の点検(serve の group-upload.ts の UploadCheck と同じ形) */
export interface UploadCheck {
  name: string;
  dir: string;
  sessions: number;
  missing: string[];
  replace: number;
  bytes: number;
  files: number;
  largest: { id: string; path: string; bytes: number }[];
  secrets: { count: number; kinds: { label: string; count: number }[]; files: { id: string; path: string; count: number }[]; skipped: number };
  snapshotAt: string | null;
}

/** 写している途中の進み具合(serve の group-upload.ts の UploadProgress と同じ形) */
export interface UploadProgress {
  sessions: number;
  done: number;
  bytes: number;
  copied: number;
  current: string | null;
}

/** 進み具合の問い合わせの答え: 写している途中なら進み具合、終わっていれば直近の結果、どちらでもなければ null */
export type UploadPoll = UploadProgress | { finished: true; ok: boolean; error: string | null; result: GroupUpload | null } | null;

/** グループのアップロードの結果(serve の group-upload.ts と同じ形) */
export interface GroupUpload {
  name: string;
  dir: string;
  uploaded: number;
  replaced: number;
  missing: string[];
  snapshotAt: string | null;
  /** メモを添えたセッションの数 */
  memos: number;
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
  /** フォルダを選ぶ画面を出し、選んだ場所をアップロード先にする(取り消したら root は null) */
  pickUploadRoot(token: string): Promise<{ root: string | null }> {
    return connect(fetch('api/upload-root', { method: 'POST', headers: headers(token) }), (r) => parse(r));
  },
  /** 入力したパスをアップロード先にする(実在するフォルダだけ) */
  setUploadRoot(token: string, root: string): Promise<{ root: string }> {
    return connect(fetch('api/upload-root', { method: 'PUT', headers: headers(token), body: JSON.stringify({ root }) }), (r) => parse(r));
  },
  uploadGroup(token: string, name: string): Promise<GroupUpload> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/upload', { method: 'POST', headers: headers(token) }), (r) => parse<GroupUpload>(r));
  },
  /** 写した先のフォルダをエクスプローラーで開く */
  checkUpload(token: string, name: string): Promise<UploadCheck> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/upload/check', { method: 'POST', headers: headers(token) }), (r) => parse<UploadCheck>(r));
  },
  uploadProgress(token: string, name: string): Promise<UploadPoll> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/upload/progress', { headers: headers(token) }), (r) => parse<UploadPoll>(r));
  },
  openUpload(token: string, name: string): Promise<{ dir: string }> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/upload/open', { method: 'POST', headers: headers(token) }), (r) => parse(r));
  },
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

/** heartbeat が続けてこの回数失敗したら止まったとみなす(スリープからの復帰などで 1 回失敗しただけでは決めない) */
export const HEARTBEAT_FAILS = 3;

/** このページを表す id(サーバは開いている画面を数え、すべて閉じられたら止まる) */
export function clientId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 3 秒ごとに heartbeat を送り、ページを閉じるときは bye を送る(serve.ts の先頭の説明)。
 * 続けて HEARTBEAT_FAILS 回失敗したら(token が違うと言われたらすぐ)onDown を 1 回呼んで止める。
 * タブが表に戻ったとき・戻る / 進むでこのページに戻ったときは、間隔を待たずにすぐ送る。戻り値で止められる
 */
export function startHeartbeat(token: string, onDown: () => void, intervalMs = 3000): () => void {
  const client = clientId();
  const h = { ...headers(token), 'x-atlas-client': client };
  /** 送った順の番号(サーバは bye より前に出た heartbeat が遅れて届いても数え直さない) */
  let seq = 0;
  // 宛先は文字列のまま書く(外へ通信しないことを e2e が fetch( の直後の文字列で確かめる)
  const send = (path: 'heartbeat' | 'bye'): Promise<Response> => {
    const init: RequestInit = { method: 'POST', headers: { ...h, 'x-atlas-seq': String(++seq) }, keepalive: true };
    return path === 'bye' ? fetch('api/bye', init) : fetch('api/heartbeat', init);
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let fails = 0;
  const fail = (now: boolean): void => {
    if (timer == null) return;
    if (now || ++fails >= HEARTBEAT_FAILS) {
      stop();
      onDown();
    }
  };
  const beat = (): void => {
    send('heartbeat')
      .then((r) => {
        if (r.ok) fails = 0;
        else fail(r.status === 403);
      })
      .catch(() => fail(false));
  };
  // 閉じるときも、戻る / 進むのためにページが残される(bfcache)ときも bye を送る(残されたページは heartbeat を送れないので、
  // 開いている画面に数えたままにすると、ほかを閉じてもサーバが止まらない)。戻ってきたら pageshow ですぐ heartbeat を送って数え直してもらう
  const onHide = (): void => {
    if (timer != null) void send('bye').catch(() => {});
  };
  const onShow = (e: PageTransitionEvent): void => {
    if (e.persisted && timer != null) beat();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && timer != null) beat();
  };
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    removeEventListener('pagehide', onHide);
    removeEventListener('pageshow', onShow);
    document.removeEventListener('visibilitychange', onVisible);
  }
  timer = setInterval(beat, intervalMs);
  addEventListener('pagehide', onHide);
  addEventListener('pageshow', onShow);
  document.addEventListener('visibilitychange', onVisible);
  beat();
  return stop;
}
