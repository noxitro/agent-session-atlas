// atlas serve の API(画面と保存の境界)。http(s) で開かれ、serve が meta に token を入れたときだけ使える。
// file:// で開いたときは token がプレースホルダのままなので何も呼ばない(console にエラーを出さない)。
// fetch の宛先は同一オリジンの相対パス 'api/…' だけ(E2E の外部参照の検査はこの形だけを許す)。
import { isStaleServer } from '../lib/code-check.ts';
import type { MemoSummary } from '../lib/memo.ts';
import type { ReportGroup } from '../lib/types.ts';

export interface ApiState {
  version: number;
  /** 別のフォルダを開いた画面(読むだけ)。タスクタグは送った人のもので、メモ・アップロード先は返さない */
  readOnly?: boolean;
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
  /** upload-project.bat がまとめて送るプロジェクト(atlas.config.json の uploadProjects)。この機能より古い serve には無い */
  projects?: string[];
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
  /** 写す。expect は確かめたときの点検の指紋(写す直前に点検し直し、違えば写さずに理由を返す) */
  run: (name: string, expect?: string) => Promise<GroupUpload>;
  /** 写している途中の進み具合。終わっていれば直近の結果(10 分以内)。どちらでもなければ null */
  progress: (name: string) => Promise<UploadPoll>;
  open: (name: string) => Promise<void>;
}

/** 写す前の点検(serve の group-upload.ts の UploadCheck と同じ形) */
export interface UploadCheck {
  name: string;
  dir: string;
  sessions: number;
  /** 前に写したときから変わっていないので写さないセッション(古いサーバは返さない) */
  unchanged?: number;
  missing: string[];
  replace: number;
  bytes: number;
  files: number;
  largest: { id: string; path: string; bytes: number }[];
  secrets: { count: number; kinds: { label: string; count: number }[]; files: { id: string; path: string; count: number }[]; skipped: number };
  snapshotAt: string | null;
  /** この点検の指紋(写すときに渡す) */
  fingerprint: string;
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
export type UploadPoll = UploadProgress | { finished: true; at: number; ok: boolean; error: string | null; result: GroupUpload | null } | null;

/** グループのアップロードの結果(serve の group-upload.ts と同じ形) */
export interface GroupUpload {
  name: string;
  dir: string;
  uploaded: number;
  replaced: number;
  /** 前に写したときから変わっていないので写さなかったセッション(古いサーバは返さない) */
  unchanged?: number;
  missing: string[];
  snapshotAt: string | null;
  /** メモを添えたセッションの数 */
  memos: number;
  /** 置き換えた前のフォルダのうち、消せずに送り先に残ったもの(送り先で開かれていたなど) */
  leftovers: string[];
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
  /** upload-project.bat がまとめて送るプロジェクトに足す(on: true)・外す(on: false)。返すのは書いた後の一覧 */
  setUploadProject(token: string, project: string, on: boolean): Promise<{ projects: string[] }> {
    return connect(fetch('api/upload-projects', { method: 'PUT', headers: headers(token), body: JSON.stringify({ project, on }) }), (r) => parse(r));
  },
  uploadGroup(token: string, name: string, expect?: string): Promise<GroupUpload> {
    return connect(fetch('api/groups/' + encodeURIComponent(name) + '/upload', { method: 'POST', headers: headers(token), body: JSON.stringify(expect ? { expect } : {}) }), (r) => parse<GroupUpload>(r));
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
/** 画面の「設定」(serve の settingsOf と同じ形)。setup.bat と同じ項目を画面から決める */
export interface WikiSetting {
  path: string;
  index?: string[];
  pages?: string[];
  extensions?: string[];
  skills?: string[];
}
export interface Settings {
  configPath: string;
  /** 設定ファイルを読めない理由(読めなければ書き換えない) */
  error: string | null;
  canPick: boolean;
  wikis: WikiSetting[];
  /** 普段の工程名。設定に無ければ null(既定の defaultPhases を使う) */
  phases: string[] | null;
  defaultPhases: string[];
  uploadRoot: string | null;
  uploadProjects: string[];
  /** 名前に wiki を含むインストール済みの skill */
  skillCandidates: string[];
}
/** 調べた vault(serve の describeVault と同じ形)。dir は実在したときのフルパス */
export interface VaultInfo {
  name: string;
  dir: string | null;
  hasIndex: boolean;
  pagesDir: string | null;
}
export const settingsApi = {
  get(token: string): Promise<Settings> {
    return connect(fetch('api/settings', { cache: 'no-store', headers: headers(token) }), (r) => parse<Settings>(r));
  },
  describeVault(token: string, input: string): Promise<VaultInfo> {
    return connect(fetch('api/settings/vault/describe', { method: 'POST', headers: headers(token), body: JSON.stringify({ input }) }), (r) => parse<VaultInfo>(r));
  },
  /** フォルダを選ぶ画面を出して vault を選ぶ(取り消したら null) */
  pickVault(token: string): Promise<VaultInfo | null> {
    return connect(fetch('api/settings/vault/pick', { method: 'POST', headers: headers(token) }), (r) => parse<VaultInfo | null>(r));
  },
  addWiki(token: string, vault: WikiSetting): Promise<Settings> {
    return connect(fetch('api/settings/wikis', { method: 'POST', headers: headers(token), body: JSON.stringify({ vault }) }), (r) => parse<Settings>(r));
  },
  /** 見えている一覧の index 番目(名前が path のもの)を外す */
  removeWiki(token: string, index: number, path: string): Promise<Settings> {
    return connect(fetch('api/settings/wikis/remove', { method: 'POST', headers: headers(token), body: JSON.stringify({ index, path }) }), (r) => parse<Settings>(r));
  },
  /** 普段の工程名(null なら既定に戻す) */
  setPhases(token: string, phases: string[] | null): Promise<Settings> {
    return connect(fetch('api/settings/phases', { method: 'PUT', headers: headers(token), body: JSON.stringify({ phases }) }), (r) => parse<Settings>(r));
  },
};

// --- 別のフォルダを開く(serve の folders.ts と同じ形) ---
export type FolderStatus = 'current' | 'open' | 'starting' | 'failed' | 'idle';
export interface FolderEntry {
  key: string;
  path: string;
  name: string;
  openedAt: string;
  /** current: この画面 / open: 別のサーバで開いている / starting: 集計中か起動中 / failed: 失敗 / idle: 開いていない */
  status: FolderStatus;
  url: string | null;
  error: string | null;
  /** 集計中の進み具合(記録の最後の行) */
  progress: string | null;
}
export interface FolderList {
  canPick: boolean;
  /** この画面が開いているフォルダ(この PC のセッションなら null) */
  current: { path: string; name: string } | null;
  /** この PC のセッションの画面 */
  local: { status: 'current' | 'open' | 'idle'; url: string | null };
  folders: FolderEntry[];
}
/** 選んだフォルダを調べた結果(ok でなければ、集計できない理由) */
export type FolderCheck = { path: string; ok: true; name: string; summary: string } | { path: string; ok: false; error: string };
export const foldersApi = {
  list(token: string): Promise<FolderList> {
    return connect(fetch('api/folders', { cache: 'no-store', headers: headers(token) }), (r) => parse<FolderList>(r));
  },
  /** フォルダを選ぶ画面を出す(取り消したら path が null) */
  pick(token: string): Promise<FolderCheck | { path: null }> {
    return connect(fetch('api/folders/pick', { method: 'POST', headers: headers(token) }), (r) => parse<FolderCheck | { path: null }>(r));
  },
  check(token: string, path: string): Promise<FolderCheck> {
    return connect(fetch('api/folders/check', { method: 'POST', headers: headers(token), body: JSON.stringify({ path }) }), (r) => parse<FolderCheck>(r));
  },
  /** 集計して別のサーバで開く(もう開いていれば、その場所を返す) */
  open(token: string, path: string): Promise<FolderEntry> {
    return connect(fetch('api/folders/open', { method: 'POST', headers: headers(token), body: JSON.stringify({ path }) }), (r) => parse<FolderEntry>(r));
  },
  /** 一覧から外す(集計の出力とメモは残す) */
  forget(token: string, key: string): Promise<FolderList> {
    return connect(fetch('api/folders/forget', { method: 'POST', headers: headers(token), body: JSON.stringify({ key }) }), (r) => parse<FolderList>(r));
  },
};

export type JobKind = 'refresh' | 'judge' | 'full' | 'bundle' | 'export' | 'turn-bundle' | 'turn-judge' | 'm365' | 'turn-m365';
/** 何を判定するか: 工数(セッションごと)/ 依頼ごとの採用・種類・工程 */
export type JudgeTarget = 'effort' | 'turns';
export type JobBackend = 'copilot-cli';
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
  | { kind: 'judge'; limit: number }
  | { kind: 'bundle' }
  | { kind: 'export' }
  | { kind: 'turn-bundle' }
  | { kind: 'turn-judge'; limit: number }
  | { kind: 'm365' }
  | { kind: 'turn-m365' };

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
  judgePreview(token: string, target: JudgeTarget = 'effort'): Promise<JudgePreview> {
    return connect(fetch('api/jobs/judge-preview' + (target === 'turns' ? '?target=turns' : ''), { cache: 'no-store', headers: headers(token) }), (r) => parse(r));
  },
};

/** 判定の確認ダイアログの件数と、判定に使うモデル(設定の judgeModel。null は Copilot の既定のモデル) */
export interface JudgePreview {
  eligible: number;
  judged: number;
  pending: number;
  withoutTurns?: number;
  model?: string | null;
  /** 自分の API キーのモデル(BYOK。<プロバイダー名>/<モデル ID>)か。Copilot の AI クレジットは使わない */
  byok?: boolean;
  /** 設定ファイルを読めなかったときの理由 */
  modelError?: string | null;
}

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
  /** M365 Copilot のアプリを自動で操作できるか(サーバが Windows のとき) */
  canAutomate?: boolean;
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
 * タブが表に戻ったとき・戻る / 進むでこのページに戻ったときは、間隔を待たずにすぐ送る。戻り値で止められる。
 * 最初に成功した応答の版の目印(x-atlas-code)がページの meta atlas-code と違えば(返さない古いサーバも)onStale を 1 回呼ぶ
 */
export function startHeartbeat(token: string, onDown: () => void, o: { intervalMs?: number; onStale?: () => void } = {}): () => void {
  const intervalMs = o.intervalMs ?? 3000;
  const pageCode = document.querySelector<HTMLMetaElement>('meta[name="atlas-code"]')?.content ?? null;
  let checked = false;
  const client = clientId();
  const h = { ...headers(token), 'x-atlas-client': client };
  /** 送った順の番号(サーバは bye より前に出た heartbeat が遅れて届いても数え直さない) */
  let seq = 0;
  const init = (): RequestInit => ({ method: 'POST', headers: { ...h, 'x-atlas-seq': String(++seq) }, keepalive: true });
  let timer: ReturnType<typeof setInterval> | null = null;
  let fails = 0;
  /** bye を送った(閉じる途中・bfcache に入った)。その後はタイマーが動いても heartbeat を送らない(bye より新しい番号で数え直されてしまうため) */
  let gone = false;
  const fail = (now: boolean): void => {
    if (timer == null) return;
    if (now || ++fails >= HEARTBEAT_FAILS) {
      stop();
      onDown();
    }
  };
  const beat = (): void => {
    if (gone) return;
    // 宛先は呼ぶところで文字列のまま書く(外へ通信しないことを e2e が fetch( の直後の文字列で確かめる。1 つの関数で宛先を選ぶと、最小化で fetch(条件 ? … : …) にまとめられる)
    fetch('api/heartbeat', init())
      .then((r) => {
        if (!r.ok) return fail(r.status === 403);
        fails = 0;
        if (checked) return;
        checked = true;
        if (isStaleServer(pageCode, r.headers.get('x-atlas-code'))) o.onStale?.();
      })
      .catch(() => fail(false));
  };
  // 閉じるときも、戻る / 進むのためにページが残される(bfcache)ときも bye を送る(残されたページは heartbeat を送れないので、
  // 開いている画面に数えたままにすると、ほかを閉じてもサーバが止まらない)。戻ってきたら pageshow ですぐ heartbeat を送って数え直してもらう
  const onHide = (): void => {
    if (timer == null || gone) return;
    gone = true;
    void fetch('api/bye', init()).catch(() => {});
  };
  const onShow = (e: PageTransitionEvent): void => {
    if (!e.persisted || timer == null) return;
    gone = false;
    beat();
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
