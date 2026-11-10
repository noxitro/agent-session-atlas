// atlas serve: out/ を 127.0.0.1 だけに配信し、画面からグループ(atlas-notes/groups.json)とメモ(atlas-notes/memos/)を書く小さな API を持つ。
// Phase 14: 画面からの操作(集計し直す・工数を判定する・全文を作る。jobs.ts)と、記録・全文記録の表示(/view/<id>)も持つ。
// チャットでの判定(M365 Copilot など): 添付ファイル(bundle/parts/)の一覧と進み具合(/api/judge/parts)、貼った返答の取り込み(/api/judge/import)。
// 画面(3 画面)は 3 秒ごとに heartbeat を送り、ページを閉じるときは bye を送る。開いている画面がすべて bye を送ったら BYE_GRACE_MS 後に、
// heartbeat がどの画面からも IDLE の間届かなければ、自分で終了する(ブラウザを閉じれば止まる)。ジョブの実行中は止めず、終わってから判定を再開する。
// IDLE を短くしないこと: ブラウザは隠れたタブのタイマーを間引く(Chrome は 5 分以上隠れたタブを 1 分に 1 回まで)。以前の 8 秒では、別のタブで作業している間に止まっていた。
// 画面と保存の境界はこの API だけ(後でアプリ化するときに差し替える)。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import {
  addIds,
  extractEmbedded,
  imageExt,
  isSafeMemoId,
  loadGroups,
  loadGroupsForWrite,
  loadMemoIndex,
  MEMO_EDITOR_JS,
  MEMO_IMAGE_LIMIT,
  readPageCss,
  renderViewDocument,
  renderViewerShell,
  SESSION_TOOLS_JS,
  transcriptFileName,
  fullFileName,
  VIEW_KINDS,
  VIEW_LABEL,
  VIEW_LIMIT,
  writeFullRecord,
  detailFileName,
  type ViewKind,
  memosDir,
  memoSummary,
  readMemo,
  removeIds,
  renderMemo,
  saveGroups,
  saveMemo,
  saveMemoImage,
  uniqueIds,
  type MemoFile,
  type ReportData,
  type SessionGroup,
} from '../../report/src/index.ts';
import type { SessionRecord, SessionsFile, WikiSpec } from '../../core/src/index.ts';
import { DEFAULT_PHASE_NAMES } from '../../core/src/index.ts';
import { homedir } from 'node:os';
import { describeVault, wikiSkillCandidates } from './setup.ts';
import { importJudgmentsText, importTurnJudgmentsText, JudgmentValidationError, readBundleManifest, readTurnBundleManifest, readTurnJudgments, turnImportPhases } from '../../judge/src/index.ts';
import { phaseNames } from './config.ts';
import { acquireOutLock, JobError, JobRunner, OutBusyError, parseJobRequest, runningJobIn, type RunFullFn, type SpawnFn } from './jobs.ts';
import { exportGroup } from './group-export.ts';
import { checkUpload, UploadChangedError, uploadDir, uploadedAt, uploadGroup, type GroupUploadResult, type UploadProgress } from './group-upload.ts';
import { defaultConfigPath, loadConfig, modifyConfig, NO_CHANGE, parseConfig, parseUploadRoot, updateConfig } from './config.ts';
import { CAN_PICK_FOLDER, openFolder, pickFolder } from './folder-picker.ts';

export const TOKEN_PLACEHOLDER = '__ATLAS_TOKEN__';
export const SERVE_STATE_FILE = '.serve.json';
/** 画面が heartbeat を送る間隔(ms) */
export const HEARTBEAT_INTERVAL_MS = 3000;
/** どの画面からも heartbeat が届かなくなってから止まるまで(閉じたことを bye で知らせずに消えた画面・眠らされたタブのための保険) */
export const DEFAULT_IDLE_MS = 30 * 60_000;
/** 開いている画面がすべて bye を送ってから止まるまで(ページの移動なら、次のページの heartbeat がこの間に届く) */
export const BYE_GRACE_MS = 15_000;
/** この間 heartbeat の無い画面は、開いている画面に数えない(隠れたタブでも 1 分に 1 回は届く) */
const CLIENT_STALE_MS = 3 * 60_000;
export const DEFAULT_FIRST_HEARTBEAT_MS = 60_000;

export interface ServeOptions {
  outDir: string;
  notesDir: string;
  /** groups.json のパス(notesDir 配下) */
  groupsPath: string;
  /** 0 なら空きポート */
  port?: number;
  /** 起動後に既定のブラウザで開く */
  open?: boolean;
  log?: (msg: string) => void;
  /** 最後の heartbeat からこの時間で終了 */
  idleMs?: number;
  /** 開いている画面がすべて bye を送ってから、この時間で終了 */
  byeGraceMs?: number;
  /** 最初の heartbeat をこの時間待つ */
  firstHeartbeatMs?: number;
  /** メモの画像 1 枚の上限(バイト)。既定は MEMO_IMAGE_LIMIT */
  memoImageLimit?: number;
  /** Phase 14: ジョブの子プロセスの起動(既定は process.execPath を shell なしで)と環境変数の追加、全文の書き出し(既定は writeFullRecord)。テストで差し替える */
  jobs?: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv; runFull?: RunFullFn };
  /** Phase 14: 記録の表示で描く .md の上限(バイト)。既定は VIEW_LIMIT(20MB) */
  viewLimit?: number;
  /** グループのアップロード先(uploadRoot)を読み書きする設定ファイル。既定は defaultConfigPath() */
  configPath?: string;
  /** フォルダを選ぶ画面とエクスプローラーで開く操作(既定は folder-picker.ts。テストで差し替える) */
  folders?: { canPick?: boolean; pick?: (title: string, initial: string | null) => Promise<string | null>; open?: (dir: string) => void };
  /** Copilot のデータの場所(画面の設定で、名前に wiki を含むインストール済みの skill を候補に出すのに使う)。既定は ATLAS_COPILOT_HOME か ~/.copilot */
  copilotHome?: string;
}

export interface ServeHandle {
  port: number;
  url: string;
  token: string;
  /** 終了したときに解決する(理由つき) */
  done: Promise<string>;
  close(reason?: string): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** 応答の種類を取り違えさせない(どの応答にも付ける) */
const NOSNIFF = { 'x-content-type-options': 'nosniff' } as const;
/** HTML(token 入り)は他のサイトの枠に入れさせない(費用のかかる操作のボタンを押させるクリックジャッキングを防ぐ) */
const HTML_HEADERS = { ...NOSNIFF, 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } as const;
/**
 * HTML 以外の静的ファイル(.md・全文記録の assets・snapshot の写しなど、セッション由来の内容)は、直接開かれても
 * script を動かさない(svg などがサーバのオリジンで動くと token を読めてしまう)
 */
const FILE_HEADERS = { ...NOSNIFF, 'content-security-policy': 'sandbox' } as const;
/** atlas 自身が作る HTML(token を差し込み、操作を出す)。out/ の直下のこれらと sessions/<id>.html だけ */
const APP_PAGES = new Set(['atlas.html', 'glossary.html', 'insights.html', 'instructions.html']);
/**
 * out/ からの相対パス(/ 区切り)が atlas の画面か。snapshot/(原本の files/ などの写し)・full/・library/ の下の .html は
 * セッション由来でありうるので、token を入れず静的ファイルとして(sandbox で)返す
 */
export function isAppPage(rel: string): boolean {
  return APP_PAGES.has(rel) || /^sessions\/[^/]+\.html$/.test(rel);
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-serve': '1', ...NOSNIFF });
  res.end(text);
}

/** 上限を超えても最後まで読み捨ててから 413 にする(途中で打ち切ると送信中の相手が応答を受け取れず止まる) */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= limit) chunks.push(c as Buffer);
  }
  if (size > limit) throw new HttpError(413, '本文が大きすぎます');
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('オブジェクトではない');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new HttpError(400, `JSON を読めません: ${(e as Error).message}`);
  }
}

const idList = (v: unknown, key: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, `${key} は文字列の配列です`);
  return uniqueIds(v as string[]);
};

/**
 * PUT の差分: { add, remove }。ids(全置換)と同時には使えない(400)。
 * 画面は差分だけを送り、サーバが読み直した最新の ids に適用する(画面を開いたまま CLI で足した id が消えない)
 */
function deltaInput(body: Record<string, unknown>): { add: string[]; remove: string[] } | null {
  if (body.add === undefined && body.remove === undefined) return null;
  if (body.ids !== undefined) throw new HttpError(400, 'ids と add / remove は同時に指定できません');
  return { add: body.add === undefined ? [] : idList(body.add, 'add'), remove: body.remove === undefined ? [] : idList(body.remove, 'remove') };
}

function groupInput(body: Record<string, unknown>, partial: boolean): Partial<SessionGroup> {
  const out: Partial<SessionGroup> = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new HttpError(400, '名前を入れてください');
    if (name.length > 100) throw new HttpError(400, '名前は 100 文字までです');
    out.name = name;
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') throw new HttpError(400, 'note は文字列です');
    out.note = body.note.trim();
  } else if (!partial) out.note = '';
  if (body.ids !== undefined || !partial) {
    if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'ids は文字列の配列です');
    out.ids = uniqueIds(body.ids as string[]);
  }
  return out;
}

/** 既定のブラウザで URL を開く(失敗しても止めない) */
export function openInBrowser(url: string, log: (m: string) => void = () => {}): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', (e) => log(`serve: ブラウザを開けませんでした(${e.message})。${url} を手で開いてください`));
    child.unref();
  } catch (e) {
    log(`serve: ブラウザを開けませんでした(${(e as Error).message})。${url} を手で開いてください`);
  }
}

/** 既に動いているサーバがあれば { port } を返す(out/.serve.json を見て GET /api/state が応えるか) */
export async function findRunningServer(outDir: string): Promise<{ port: number; pid: number } | null> {
  const p = join(outDir, SERVE_STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(await readFile(p, 'utf8')) as { port?: number; pid?: number };
    if (!j.port) return null;
    const r = await fetch(`http://127.0.0.1:${j.port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (r.headers.get('x-atlas-serve') !== '1') return null;
    return { port: j.port, pid: j.pid ?? 0 };
  } catch {
    return null;
  }
}

export async function startServe(o: ServeOptions): Promise<ServeHandle> {
  const log = o.log ?? (() => {});
  const outDir = resolve(o.outDir);
  const groupsPath = resolve(o.groupsPath);
  const memoDir = memosDir(resolve(o.notesDir));
  const token = randomBytes(24).toString('base64url');
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS;
  const byeGraceMs = o.byeGraceMs ?? BYE_GRACE_MS;
  const firstMs = o.firstHeartbeatMs ?? DEFAULT_FIRST_HEARTBEAT_MS;

  // 伏せ字版かどうかは atlas.html の埋め込みデータで判断(mtime が変わるまで覚える)
  let anonCache: { mtime: number; anonymized: boolean } | null = null;
  async function isAnonymized(): Promise<boolean> {
    const p = join(outDir, 'atlas.html');
    if (!existsSync(p)) return false;
    const m = (await stat(p)).mtimeMs;
    if (!anonCache || anonCache.mtime !== m) {
      let anonymized = false;
      try {
        anonymized = !!extractEmbedded<ReportData>(await readFile(p, 'utf8')).anonymized;
      } catch {
        /* 読めなければ通常版とみなす(編集できるだけで、壊れはしない) */
      }
      anonCache = { mtime: m, anonymized };
    }
    return anonCache.anonymized;
  }

  // Phase 14: sessions.json の id → 表題と判定の対象か(mtime が変わるまで覚える。本文は持たない)
  let sessionsCache: { mtime: number; ids: Map<string, { title: string; eligible: boolean; turns: number }> } | null = null;
  async function sessionIndex(): Promise<Map<string, { title: string; eligible: boolean; turns: number }> | null> {
    const p = join(outDir, 'sessions.json');
    if (!existsSync(p)) return null;
    const m = (await stat(p)).mtimeMs;
    if (!sessionsCache || sessionsCache.mtime !== m) {
      let file: SessionsFile;
      try {
        file = JSON.parse(await readFile(p, 'utf8')) as SessionsFile;
      } catch (e) {
        throw new HttpError(503, `sessions.json を読めません(集計の途中かもしれません): ${(e as Error).message}`);
      }
      // 判定の対象は bundle と同じ「依頼の記録がある」セッション(judge/src/packet.ts の hasRequest の近似。本文は sessions.json の範囲で見る)
      // turns は依頼ごとの記録(turnStats)の数。依頼ごとの判定の対象
      sessionsCache = {
        mtime: m,
        ids: new Map(file.sessions.map((r) => [r.id, { title: r.name?.trim() || '(名前なし)', eligible: r.turns > 0 || !!r.firstUserMessage, turns: r.analysis?.turnStats?.length ?? 0 }])),
      };
    }
    return sessionsCache.ids;
  }

  /** 1 件の全文記録を書く(サーバ内。atlas.html・coverage.json・他のセッションの全文は触らない) */
  const runFullDefault: RunFullFn = async (id, ctx) => {
    const t = performance.now();
    const file = JSON.parse(await readFile(join(outDir, 'sessions.json'), 'utf8')) as SessionsFile;
    const record: SessionRecord | undefined = file.sessions.find((r) => r.id === id);
    if (!record) throw new Error(`セッション ${id} は sessions.json にありません`);
    ctx.log(`全文記録を書いています: ${id}`);
    const r = await writeFullRecord({ record, snapshotDir: join(outDir, 'snapshot'), outDir, walNote: file.desktop?.wal?.note ?? null, signal: ctx.signal });
    ctx.log(`全文記録 ${r.path}(${(r.bytes / 1024 / 1024).toFixed(2)} MB、イベント ${r.events} 件、画像など ${r.assets.files} ファイル、${((performance.now() - t) / 1000).toFixed(1)} 秒)`);
  };
  const jobs = new JobRunner({
    outDir,
    notesDir: resolve(o.notesDir),
    spawn: o.jobs?.spawn,
    env: o.jobs?.env,
    runFull: o.jobs?.runFull ?? runFullDefault,
    log,
    onEnd: () => {
      // 画面が閉じられた後もジョブは最後まで走らせ、終わってから判定を再開する。
      // 画面がすべて閉じていたら短い猶予で(以前は 30 分の保険を張り直していた)
      if (idlePending) {
        idlePending = null;
        if (leaving && clients.size === 0) armLeaving();
        else armIdle();
      }
    },
  });
  const refreshing = (): boolean => jobs.running() && jobs.current()?.kind === 'refresh';
  /** タスクタグの書き出し・写す前の点検・アップロードのどれかをしている最中なら、その内容(「「A」をアップロードしている」など)。その間はほかの書き出し・点検・アップロード・ジョブを始めない */
  let busyWith: string | null = null;
  /** 写している途中のアップロード(画面が進み具合を問い合わせる) */
  let uploading: { name: string; progress: UploadProgress } | null = null;
  /** タスクタグごとの直近のアップロードの結果(写している途中に別のページへ移って戻った画面が、成功か失敗かを出せるように。10 分だけ) */
  const lastUpload = new Map<string, { at: number; ok: boolean; error: string | null; result: GroupUploadResult | null }>();
  const LAST_UPLOAD_MS = 10 * 60_000;
  const configPath = resolve(o.configPath ?? defaultConfigPath());
  const canPick = o.folders?.canPick ?? CAN_PICK_FOLDER;
  const pick = o.folders?.pick ?? pickFolder;
  const openDir = o.folders?.open ?? openFolder;
  /** 設定のアップロード先と、upload-project.bat がまとめて送るプロジェクト(読めない設定は理由つきで返す。画面に出す) */
  async function uploadRootOf(): Promise<{ root: string | null; projects: string[]; error: string | null }> {
    try {
      const c = await loadConfig(configPath, false);
      return { root: c.uploadRoot, projects: c.uploadProjects ?? [], error: null };
    } catch (e) {
      return { root: null, projects: [], error: (e as Error).message };
    }
  }
  /** upload-project.bat がまとめて送るプロジェクトに足す・外す(画面の「プロジェクト別」の印)。返すのは書いた後の一覧 */
  async function saveUploadProject(input: Record<string, unknown>): Promise<string[]> {
    const { project, on } = input;
    if (typeof project !== 'string' || project.trim() === '' || project.length > 1000) throw new HttpError(400, 'project にプロジェクト名を指定してください');
    if (typeof on !== 'boolean') throw new HttpError(400, 'on に true(まとめて送る)か false(送らない)を指定してください');
    // 読んでから書くまでを設定ファイルのロックの中で行う(続けて押したときや、bat が送り先を書き換えるときに、先に書いた分を消さない)
    let next: string[] = [];
    let changed: boolean;
    try {
      changed =
        (await modifyConfig(configPath, 'uploadProjects', (c) => {
          const cur = c.uploadProjects ?? [];
          next = on ? (cur.includes(project) ? cur : [...cur, project]) : cur.filter((x) => x !== project);
          if (next.length === cur.length) return NO_CHANGE;
          return next.length ? next : undefined;
        })) !== NO_CHANGE;
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    if (changed) log(`serve: 「${project}」を upload-project.bat で${on ? 'まとめて送る' : '送らない'}ようにしました(まとめて送るもの ${next.length} 件。${configPath})`);
    return next;
  }
  /** アップロード先を決めて設定に書く(実在するフォルダだけ) */
  async function saveUploadRoot(input: unknown): Promise<string> {
    let root: string;
    try {
      root = parseUploadRoot(input);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (!existsSync(root) || !(await stat(root)).isDirectory()) throw new HttpError(400, `フォルダが見つかりません: ${root}`);
    try {
      await updateConfig(configPath, 'uploadRoot', root);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    log(`serve: アップロード先を ${root} にしました(${configPath})`);
    return root;
  }
  let picking = false;
  // --- 画面の「設定」(setup.bat と同じ項目を画面から決める)。書き換えは modifyConfig(設定ファイルのロックの中で読んでから書く) ---
  const copilotHome = resolve(o.copilotHome ?? process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot'));
  /** 画面の設定に出す今の設定。読めない設定ファイルは理由を返す(画面は理由を出し、書き換えさせない) */
  async function settingsOf(): Promise<Record<string, unknown>> {
    let error: string | null = null;
    let c: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      c = await loadConfig(configPath, false);
    } catch (e) {
      error = (e as Error).message;
    }
    return {
      configPath,
      error,
      canPick,
      wikis: c?.wikis ?? [],
      phases: c?.phases ?? null,
      defaultPhases: [...DEFAULT_PHASE_NAMES],
      uploadRoot: c?.uploadRoot ?? null,
      uploadProjects: c?.uploadProjects ?? [],
      // 名前に wiki を含むインストール済みの skill(vault を足すときに、wiki の skill として数えるか選べるように。setup.bat と同じ候補)
      skillCandidates: await wikiSkillCandidates(copilotHome).catch(() => []),
    };
  }
  /** 設定ファイルの 1 項目を書き換える。読めない設定・ロックが取れないときは 409、検査に通らない値は 400 */
  async function writeSetting<T>(key: Parameters<typeof modifyConfig>[1], fn: Parameters<typeof modifyConfig<T>>[2]): Promise<void> {
    try {
      await modifyConfig(configPath, key, fn);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const m = (e as Error).message;
      throw new HttpError(/読めないので書き換えません|別の処理が書き換えています/.test(m) ? 409 : 400, m);
    }
  }
  const strings = (v: unknown, where: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${where} は文字列の配列で指定してください`);
    const list = (v as string[]).map((x) => x.trim()).filter(Boolean);
    return list.length ? list : undefined;
  };
  /** 画面から足す vault の指定(path と、任意の index・pages・skills)。設定ファイルには setup.bat と同じ形(path だけなら文字列)で書く */
  function vaultSpec(v: unknown): string | WikiSpec {
    if (typeof v !== 'object' || v === null) throw new HttpError(400, 'vault の指定がありません');
    const r = v as Record<string, unknown>;
    if (typeof r.path !== 'string' || !/[^./\\~\s]/.test(r.path)) throw new HttpError(400, 'vault のフォルダ名かパスを指定してください');
    const spec: WikiSpec = { path: r.path.trim() };
    const index = strings(r.index, 'index');
    const pages = strings(r.pages, 'pages');
    const skills = strings(r.skills, 'skills');
    if (index) spec.index = index;
    // ページのフォルダが vault 全体(.)だけなら書かない(既定と同じ)
    if (pages && !(pages.length === 1 && pages[0] === '.')) spec.pages = pages;
    if (skills) spec.skills = [...new Set(skills)];
    return Object.keys(spec).length === 1 ? spec.path : spec;
  }
  const REFRESHING ='集計し直している最中です(詳細ページと記録は作り直しの途中です)。集計が終わってから開き直してください。';
  let cssCache: string | null = null;
  const pageCss = async (): Promise<string> => (cssCache ??= await readPageCss());

  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => (resolveDone = r));
  let server!: Server;
  let closed = false;
  let firstTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  /** heartbeat が途切れたがジョブの実行中なので待っている(理由) */
  let idlePending: string | null = null;
  let port = 0;

  async function close(reason = '停止'): Promise<void> {
    if (closed) return;
    closed = true;
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
    await rm(join(outDir, SERVE_STATE_FILE), { force: true }).catch(() => {});
    jobs.dropLock();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    resolveDone(reason);
  }

  /** 猶予が切れた。ジョブの実行中は止めずに待ち、終わってから(onEnd)猶予を測り直す */
  function expire(reason: string): void {
    if (jobs.running()) {
      if (!idlePending) log(`serve: ${reason}。処理が終わるまで止めずに待ちます`);
      idlePending = reason;
      return;
    }
    void close(reason);
  }
  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire('画面が閉じられた(heartbeat が途切れた)'), idleMs);
  }
  /** 開いている画面がすべて閉じられ、短い猶予(byeGraceMs)を測っている */
  let leaving = false;
  /** 開いている画面(heartbeat の x-atlas-client)と、最後に heartbeat が届いた時刻 */
  const clients = new Map<string, number>();
  const clientOf = (req: IncomingMessage): string | null => {
    const c = req.headers['x-atlas-client'];
    return typeof c === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(c) ? c : null;
  };
  /** 画面が送った順の番号(x-atlas-seq)。古い画面は送らない(null) */
  const seqOf = (req: IncomingMessage): number | null => {
    const s = Number(req.headers['x-atlas-seq']);
    return Number.isSafeInteger(s) && s >= 0 ? s : null;
  };
  /** bye を送った画面と、その bye の番号。bye より前に出た heartbeat が遅れて届いても、開いている画面に数え直さない */
  const byeSeq = new Map<string, number>();
  function heartbeat(client: string | null, seq: number | null): void {
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (client) {
      const b = byeSeq.get(client);
      // 閉じた後に届いた、閉じる前の heartbeat(keepalive の追い越し)は無視する。番号が新しければ戻ってきた画面(bfcache)なので数え直す
      if (b != null && (seq == null || seq <= b)) return;
      byeSeq.delete(client);
      clients.set(client, Date.now());
    }
    idlePending = null;
    leaving = false;
    armIdle();
  }
  /** 猶予(byeGraceMs)を測り始める */
  function armLeaving(): void {
    leaving = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire('画面がすべて閉じられた'), byeGraceMs);
  }
  /** 画面が閉じられた(bfcache に入るときも)。ほかに開いている画面が無ければ、少し待って(次のページの heartbeat が来なければ)止まる */
  function bye(client: string | null, seq: number | null): void {
    if (client) {
      clients.delete(client);
      // 番号の無い bye(番号を送らない古いページ)は記録しない。記録すると、そのページが戻ってきても heartbeat を数え直せない
      if (seq != null) byeSeq.set(client, seq);
      // 覚えておくのは最近のものだけ(長く開いたままのサーバで増え続けないように)
      if (byeSeq.size > 200) byeSeq.delete(byeSeq.keys().next().value!);
    }
    const now = Date.now();
    for (const [c, at] of clients) if (now - at > CLIENT_STALE_MS) clients.delete(c);
    if (clients.size) return;
    log(`serve: 開いている画面がすべて閉じられました。${Math.round(byeGraceMs / 1000)} 秒のうちに次の画面が開かなければ止まります`);
    armLeaving();
  }
  /** 重い同期処理(大きな記録の描画)の直後に猶予を測り直す(止まっていた間に溜まった heartbeat より先に期限切れで閉じないため) */
  function touchIdle(): void {
    if (idleTimer && !idlePending && !leaving) armIdle();
  }

  /** DNS rebinding を防ぐ: Host が自分でなければ同一オリジンに見えても応えない */
  function checkHost(req: IncomingMessage): void {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, '127.0.0.1 と localhost 以外の名前では開けません');
  }
  function checkOrigin(req: IncomingMessage): void {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '同一オリジン以外からの要求は受け付けません');
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, '同一オリジン以外からの要求は受け付けません');
  }
  function checkToken(req: IncomingMessage): void {
    if (req.headers['x-atlas-token'] !== token) throw new HttpError(403, 'token が無いか違います(atlas serve から開いた画面だけが書けます)');
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    checkOrigin(req);
    const method = req.method ?? 'GET';
    if (path === '/api/heartbeat' && method === 'POST') {
      checkToken(req);
      heartbeat(clientOf(req), seqOf(req));
      res.writeHead(204, { 'x-atlas-serve': '1' });
      res.end();
      return;
    }
    if (path === '/api/bye' && method === 'POST') {
      checkToken(req);
      bye(clientOf(req), seqOf(req));
      res.writeHead(204);
      res.end();
      return;
    }
    if (await isAnonymized()) throw new HttpError(403, '伏せ字版では編集できません');
    if (path === '/api/state' && method === 'GET') {
      const g = await loadGroups(groupsPath);
      const memos = Object.fromEntries([...(await loadMemoIndex(memoDir))].map(([id, x]) => [id, memoSummary(x.text, x.updatedAt)]));
      const up = await uploadRootOf();
      sendJson(res, 200, { version: 1, groups: g.groups, memos, notesDir: o.notesDir, groupsPath, exists: g.exists, warnings: g.warnings, upload: { root: up.root, projects: up.projects, error: up.error, canPick } });
      return;
    }
    if (path === '/api/upload-root') {
      checkToken(req);
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { root: await saveUploadRoot(body.root) });
        return;
      }
      if (method === 'POST') {
        // フォルダを選ぶ画面を出し、選んだ場所を既定にする(取り消したら root: null で何も変えない)
        if (!canPick) throw new HttpError(501, 'この OS ではフォルダを選ぶ画面を出せません。パスを入力してください');
        if (picking) throw new HttpError(409, 'フォルダを選ぶ画面が開いています(タスクバーを確かめてください)');
        picking = true;
        try {
          const cur = (await uploadRootOf()).root;
          let chosen: string | null;
          try {
            chosen = await pick('アップロード先の基底フォルダを選んでください(この中にタスクタグ名のフォルダを作ります)', cur);
          } catch (e) {
            throw new HttpError(500, (e as Error).message);
          }
          sendJson(res, 200, { root: chosen == null ? null : await saveUploadRoot(chosen) });
        } finally {
          picking = false;
        }
        return;
      }
      throw new HttpError(405, 'この方法では使えません');
    }
    if (path === '/api/settings' || path.startsWith('/api/settings/')) {
      checkToken(req);
      if (path === '/api/settings' && method === 'GET') {
        sendJson(res, 200, await settingsOf());
        return;
      }
      if (method !== 'POST' && method !== 'PUT') throw new HttpError(405, 'この方法では使えません');
      if (path === '/api/settings/vault/describe') {
        // 入力されたフォルダ名かパスを調べる(実在すればフォルダ名だけにし、中の index.md と wiki/ を見る。setup.bat と同じ)
        const body = await readJsonBody(req);
        if (typeof body.input !== 'string' || !body.input.trim()) throw new HttpError(400, 'vault のフォルダ名かパスを入力してください');
        const d = describeVault(body.input);
        if (!/[^./\\~\s]/.test(d.name)) throw new HttpError(400, `フォルダ名を読めませんでした: ${body.input}`);
        sendJson(res, 200, d);
        return;
      }
      if (path === '/api/settings/vault/pick') {
        if (!canPick) throw new HttpError(501, 'この OS ではフォルダを選ぶ画面を出せません。フォルダ名かパスを入力してください');
        if (picking) throw new HttpError(409, 'フォルダを選ぶ画面が開いています(タスクバーを確かめてください)');
        picking = true;
        try {
          let chosen: string | null;
          try {
            chosen = await pick('llm-wiki の vault のフォルダを選んでください', null);
          } catch (e) {
            throw new HttpError(500, (e as Error).message);
          }
          sendJson(res, 200, chosen ? describeVault(chosen) : null);
        } finally {
          picking = false;
        }
        return;
      }
      if (path === '/api/settings/wikis') {
        // vault を 1 つ足す(同じ名前があれば足さない)
        const spec = vaultSpec((await readJsonBody(req)).vault);
        const name = typeof spec === 'string' ? spec : spec.path;
        try {
          parseConfig({ wikis: [spec] });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        await writeSetting('wikis', (c, raw) => {
          if ((c.wikis ?? []).some((w) => w.path === name)) throw new HttpError(409, `vault「${name}」はもう入っています`);
          return [...(Array.isArray(raw.wikis) ? raw.wikis : []), spec];
        });
        log(`serve: vault「${name}」を足しました(${configPath})`);
        sendJson(res, 200, await settingsOf());
        return;
      }
      if (path === '/api/settings/wikis/remove') {
        // 見えている一覧の何番目かと名前で外す(開いてからほかで書き換えていたら、違うものを外さないよう止める)。書いてあるとおりの値から外す
        const body = await readJsonBody(req);
        const at = body.index;
        if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || typeof body.path !== 'string') throw new HttpError(400, '外す vault の番号と名前を指定してください');
        await writeSetting('wikis', (c, raw) => {
          if (!Array.isArray(raw.wikis) || c.wikis?.[at]?.path !== body.path) throw new HttpError(409, '設定がほかで書き換えられました。設定を開き直してください(何も外していません)');
          const next = raw.wikis.filter((_, i) => i !== at);
          return next.length ? next : undefined;
        });
        log(`serve: vault「${body.path}」を外しました(${configPath})`);
        sendJson(res, 200, await settingsOf());
        return;
      }
      if (path === '/api/settings/phases') {
        // 普段の工程名(null なら既定に戻す)
        const body = await readJsonBody(req);
        let phases: string[] | undefined;
        if (body.phases !== null) {
          phases = strings(body.phases, 'phases');
          if (!phases) throw new HttpError(400, '工程名を 2 つ以上入力してください');
          try {
            parseConfig({ phases });
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
        }
        await writeSetting('phases', () => phases);
        log(`serve: 普段の工程名を${phases ? ` ${phases.join(' / ')} に` : '既定に'}しました(${configPath})`);
        sendJson(res, 200, await settingsOf());
        return;
      }
      throw new HttpError(404, '見つかりません');
    }
    if (path === '/api/upload-projects') {
      checkToken(req);
      if (method !== 'PUT') throw new HttpError(405, 'この方法では使えません');
      sendJson(res, 200, { projects: await saveUploadProject(await readJsonBody(req)) });
      return;
    }
    if (path === '/api/memo-editor.js' && method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', 'x-atlas-serve': '1', ...NOSNIFF });
      res.end(MEMO_EDITOR_JS);
      return;
    }
    if (path === '/api/session-tools.js' && method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', 'x-atlas-serve': '1', ...NOSNIFF });
      res.end(SESSION_TOOLS_JS);
      return;
    }
    if (path === '/api/jobs' || path.startsWith('/api/jobs/')) {
      await jobsApi(req, res, method, path, url);
      return;
    }
    if (path.startsWith('/api/judge/')) {
      await chatJudgeApi(req, res, method, path, url.searchParams.get('target') === 'turns' ? 'turns' : 'effort');
      return;
    }
    const view = /^\/api\/view\/([^/]+)$/.exec(path);
    if (view) {
      await viewApi(req, res, method, view[1], url);
      return;
    }
    const memo = /^\/api\/memos\/([^/]+)(\/images)?$/.exec(path);
    if (memo) {
      await memoApi(req, res, method, memo[1], !!memo[2]);
      return;
    }
    // upload(写す)・upload/check(写す前の点検: 大きさと秘密らしい文字列)・upload/progress(写している途中の進み具合)・upload/open(写した先を開く)
    const gu = /^\/api\/groups\/([^/]+)\/upload(?:\/(open|check|progress))?$/.exec(path);
    if (gu) {
      const sub = gu[2] ?? '';
      if (method !== (sub === 'progress' ? 'GET' : 'POST')) throw new HttpError(405, 'この方法では使えません');
      checkToken(req);
      let name: string;
      try {
        name = decodeURIComponent(gu[1]);
      } catch {
        throw new HttpError(400, 'タスクタグの名前を読めません');
      }
      if (sub === 'progress') {
        // このグループを写している途中なら進み具合、そうでなければ null
        // 写している途中なら進み具合。終わっていれば直近の結果({ finished: true, ok, error, result })。どちらでもなければ null
        if (uploading?.name === name) sendJson(res, 200, uploading.progress);
        else {
          const last = lastUpload.get(name);
          let fresh = !!last && Date.now() - last.at < LAST_UPLOAD_MS;
          // 失敗の後に、ほかから(CLI など)送り直して成功していれば、失敗は出さない(送り先の索引の日時が新しい)
          if (fresh && last && !last.ok) {
            const root = (await uploadRootOf()).root;
            const at = root ? await uploadedAt(root, name) : null;
            if (at && Date.parse(at) > last.at) fresh = false;
          }
          sendJson(res, 200, fresh && last ? { finished: true, at: last.at, ok: last.ok, error: last.error, result: last.result } : null);
        }
        return;
      }
      const up = await uploadRootOf();
      if (up.error) throw new HttpError(409, up.error);
      if (!up.root) throw new HttpError(409, 'アップロード先が決まっていません。先に場所を選んでください');
      // 写すときは、確かめたときの点検の指紋(expect)を受け取り、写す直前に点検し直して違えば写さない(本文は、ほかの処理の最中かを見る前に読む。間で待つと割り込まれる)
      const body = sub === '' ? await readJsonBody(req).catch(() => ({}) as Record<string, unknown>) : {};
      const expect = typeof body.expect === 'string' ? body.expect : undefined;
      if (sub === 'open') {
        // 写した先のフォルダを開く(開けるのは設定のアップロード先の中の、このグループのフォルダだけ)
        const dir = uploadDir(up.root, name);
        if (!existsSync(dir)) throw new HttpError(404, `まだアップロードしていません: ${dir}`);
        openDir(dir);
        sendJson(res, 200, { dir });
        return;
      }
      // 集計の途中は out/snapshot/ が書きかけのことがあるので待ってもらう
      if (jobs.running()) throw new HttpError(409, jobs.current()?.kind === 'refresh' ? '集計し直している最中です。終わってからアップロードしてください' : 'ほかの処理が動いています。終わってからアップロードしてください');
      if (busyWith) throw new HttpError(409, `${busyWith}最中です。終わってからもう一度押してください`);
      const other = runningJobIn(outDir);
      if (other) throw new HttpError(409, `別の atlas の処理(${other})が動いています。終わってからアップロードしてください`);
      let release: () => void;
      try {
        release = acquireOutLock(outDir, 'group upload', 'serve');
      } catch (e) {
        if (e instanceof OutBusyError) throw new HttpError(409, e.message);
        throw e;
      }
      busyWith = sub === 'check' ? `「${name}」を写す前に調べている` : `「${name}」をアップロードしている`;
      const paths = { snapshot: join(outDir, 'snapshot'), groups: groupsPath, notes: resolve(o.notesDir), sessions: join(outDir, 'sessions.json') };
      try {
        if (sub === 'check') sendJson(res, 200, await checkUpload(paths, name, up.root));
        else {
          uploading = { name, progress: { sessions: 0, done: 0, bytes: 0, copied: 0, current: null } };
          const cur = uploading;
          try {
            const result = await uploadGroup(paths, name, up.root, log, { onProgress: (pr) => void (cur.progress = pr), expect });
            lastUpload.set(name, { at: Date.now(), ok: true, error: null, result });
            sendJson(res, 200, result);
          } catch (e) {
            // 中身が変わったので写さなかったときは、失敗として覚えない(押した画面がその場で理由を出し、確かめ直してもらう)
            if (!(e instanceof UploadChangedError)) lastUpload.set(name, { at: Date.now(), ok: false, error: (e as Error).message, result: null });
            throw e;
          }
        }
      } catch (e) {
        throw new HttpError(/^タスクタグ「.*」はありません/.test((e as Error).message) ? 404 : 409, (e as Error).message);
      } finally {
        uploading = null;
        busyWith = null;
        release();
      }
      return;
    }
    const ge = /^\/api\/groups\/([^/]+)\/export$/.exec(path);
    if (ge) {
      if (method !== 'POST') throw new HttpError(405, 'この方法では使えません');
      checkToken(req);
      let name: string;
      try {
        name = decodeURIComponent(ge[1]);
      } catch {
        throw new HttpError(400, 'タスクタグの名前を読めません');
      }
      // 集計・記録の書き出し中は sessions.json や記録が書きかけのことがあるので待ってもらう
      if (jobs.running()) throw new HttpError(409, jobs.current()?.kind === 'refresh' ? REFRESHING : 'ほかの処理が動いています。終わってから書き出してください');
      if (busyWith) throw new HttpError(409, `${busyWith}最中です。終わってから書き出してください`);
      const other = runningJobIn(outDir);
      if (other) throw new HttpError(409, `別の atlas の処理(${other})が動いています。終わってから書き出してください`);
      // 書き出しの間は out/ の印を取り、別の atlas(CLI)が集計を始めないようにする。同じ serve のジョブは busyWith で止める
      let release: () => void;
      try {
        release = acquireOutLock(outDir, 'group export', 'serve');
      } catch (e) {
        if (e instanceof OutBusyError) throw new HttpError(409, e.message);
        throw e;
      }
      busyWith = `「${name}」を書き出している`;
      try {
        sendJson(res, 200, await exportGroup({ out: outDir, sessions: join(outDir, 'sessions.json'), judgments: join(outDir, 'judgments.json'), groups: groupsPath }, name, log));
      } catch (e) {
        throw new HttpError(/はありません/.test((e as Error).message) ? 404 : 409, (e as Error).message);
      } finally {
        busyWith = null;
        release();
      }
      return;
    }
    const m = /^\/api\/groups(?:\/(.+))?$/.exec(path);
    if (!m) throw new HttpError(404, '無い API です');
    const target = m[1] != null ? decodeURIComponent(m[1]) : null;
    if (method === 'POST' && target == null) {
      checkToken(req);
      const input = groupInput(await readJsonBody(req), false) as SessionGroup;
      await withGroupsLock(async () => {
        const groups = await loadForWrite();
        if (groups.some((g) => g.name === input.name)) throw new HttpError(409, `タスクタグ「${input.name}」は既にあります`);
        groups.push(input);
        await saveGroups(groupsPath, groups);
        sendJson(res, 201, { group: input, groups });
      });
      return;
    }
    if (method === 'PUT' && target != null) {
      checkToken(req);
      const body = await readJsonBody(req);
      const delta = deltaInput(body);
      const input = groupInput(body, true);
      await withGroupsLock(async () => {
        const groups = await loadForWrite();
        const cur = groups.find((g) => g.name === target);
        if (!cur) throw new HttpError(404, `タスクタグ「${target}」はありません`);
        if (input.name != null && input.name !== cur.name && groups.some((g) => g.name === input.name)) throw new HttpError(409, `タスクタグ「${input.name}」は既にあります`);
        Object.assign(cur, input);
        let added = 0;
        let dup = 0;
        let removed = 0;
        if (delta) {
          const a = addIds(cur, delta.add);
          added = a.added;
          dup = a.dup;
          const r = removeIds(a.group, delta.remove);
          removed = r.removed;
          cur.ids = r.group.ids;
        }
        await saveGroups(groupsPath, groups);
        sendJson(res, 200, { group: cur, groups, added, dup, removed });
      });
      return;
    }
    if (method === 'DELETE' && target != null) {
      checkToken(req);
      await withGroupsLock(async () => {
        const groups = await loadForWrite();
        const i = groups.findIndex((g) => g.name === target);
        if (i < 0) throw new HttpError(404, `タスクタグ「${target}」はありません`);
        groups.splice(i, 1);
        await saveGroups(groupsPath, groups);
        sendJson(res, 200, { groups });
      });
      return;
    }
    throw new HttpError(405, 'この方法では使えません');
  }
  /** Phase 14: ジョブ。読みも書きも token が要る(ログに生の文字列が入るため) */
  async function jobsApi(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL): Promise<void> {
    checkToken(req);
    try {
      if (path === '/api/jobs' && method === 'POST') {
        const body = await readJsonBody(req);
        const ids = body.kind === 'full' ? await sessionIndex() : null;
        const r = parseJobRequest(body, (id) => !!ids?.has(id));
        // グループの書き出しは out/ を読んでいるので、終わるまで集計などを始めない
        if (busyWith) throw new JobError(409, `${busyWith}最中です。終わってから実行してください`);
        sendJson(res, 202, jobs.start(r));
        return;
      }
      if (path === '/api/jobs/current' && method === 'GET') {
        sendJson(res, 200, jobs.current());
        return;
      }
      if (path === '/api/jobs/current/cancel' && method === 'POST') {
        sendJson(res, 200, jobs.cancel());
        return;
      }
      if (path === '/api/jobs/judge-preview' && method === 'GET') {
        sendJson(res, 200, url.searchParams.get('target') === 'turns' ? await turnPreview() : await judgePreview());
        return;
      }
    } catch (e) {
      if (e instanceof JobError) throw new HttpError(e.status, e.message);
      throw e;
    }
    if (['/api/jobs', '/api/jobs/current', '/api/jobs/current/cancel', '/api/jobs/judge-preview'].includes(path)) throw new HttpError(405, 'この方法では使えません');
    throw new HttpError(404, '無い API です');
  }
  /** judgments.json にあるセッション id(無ければ空) */
  async function judgedIds(): Promise<Set<string>> {
    const judged = new Set<string>();
    const jp = join(outDir, 'judgments.json');
    if (existsSync(jp)) {
      try {
        const j = JSON.parse(await readFile(jp, 'utf8')) as { items?: { sessionId?: unknown }[] };
        for (const it of j.items ?? []) if (typeof it?.sessionId === 'string') judged.add(it.sessionId);
      } catch (e) {
        throw new HttpError(409, `judgments.json を読めません: ${(e as Error).message}`);
      }
    }
    return judged;
  }
  /** 判定の確認ダイアログの件数: 依頼の記録があるセッションのうち judgments.json に無いもの */
  async function judgePreview(): Promise<{ eligible: number; judged: number; pending: number }> {
    const ids = await sessionIndex();
    if (!ids) return { eligible: 0, judged: 0, pending: 0 };
    const judged = await judgedIds();
    let eligible = 0;
    let done = 0;
    for (const [id, x] of ids) {
      if (!x.eligible) continue;
      eligible++;
      if (judged.has(id)) done++;
    }
    return { eligible, judged: done, pending: eligible - done };
  }
  /** turn-judgments.json の判定済みの依頼(セッション ID#依頼番号) */
  async function judgedTurns(): Promise<Set<string>> {
    try {
      const j = await readTurnJudgments(join(outDir, 'turn-judgments.json'));
      return new Set((j?.items ?? []).map((i) => `${i.sessionId}#${i.turn}`));
    } catch (e) {
      throw new HttpError(409, `turn-judgments.json を読めません: ${(e as Error).message}`);
    }
  }
  /** 依頼ごとの判定の件数(依頼ごとの記録がある依頼のうち、turn-judgments.json に無いもの) */
  async function turnPreview(): Promise<{ eligible: number; judged: number; pending: number; withoutTurns: number }> {
    const ids = await sessionIndex();
    if (!ids) return { eligible: 0, judged: 0, pending: 0, withoutTurns: 0 };
    const judged = await judgedTurns();
    let eligible = 0;
    let done = 0;
    // 依頼があるのに依頼ごとの記録が無いセッション(古い集計)。「集計し直す」で入る
    let withoutTurns = 0;
    for (const [id, x] of ids) {
      if (x.eligible && x.turns === 0) withoutTurns++;
      for (let t = 1; t <= x.turns; t++) {
        eligible++;
        if (judged.has(`${id}#${t}`)) done++;
      }
    }
    return { eligible, judged: done, pending: eligible - done, withoutTurns };
  }
  /**
   * チャットでの判定。読みも書きも token が要る(進み具合にセッション id が入るため)。
   * ?target=turns は依頼ごとの判定(turn-bundle/・turn-judgments.json)、それ以外は工数の判定。
   * GET  /api/judge/parts:  bundle/parts/ の各ファイルと、その中のセッションのうち判定済みの数(bundle が無ければ exists: false)
   * GET  /api/judge/parts/<名前>: そのファイルの本文 { text }(画面の「本文をコピー」。manifest にある名前だけ)
   * POST /api/judge/import: { text } 貼った返答を検証して judgments.json に取り込む(1 件でも形が合わなければ何も書かない)。
   *      レポートへの反映は別(export のジョブ)。判定・集計のジョブや CLI が out/ に書いている間は 409
   */
  async function chatJudgeApi(req: IncomingMessage, res: ServerResponse, method: string, path: string, target: 'effort' | 'turns'): Promise<void> {
    checkToken(req);
    const partsOf = () => (target === 'turns' ? turnParts() : chatParts());
    if (path === '/api/judge/parts') {
      if (method !== 'GET') throw new HttpError(405, 'この方法では使えません');
      sendJson(res, 200, await partsOf());
      return;
    }
    const one = /^\/api\/judge\/parts\/([^/]+)$/.exec(path);
    if (one) {
      if (method !== 'GET') throw new HttpError(405, 'この方法では使えません');
      let name: string;
      try {
        name = decodeURIComponent(one[1]);
      } catch {
        throw new HttpError(400, 'ファイル名を読めません');
      }
      const part = (await partsOf()).parts?.find((p) => p.name === name);
      if (!part) throw new HttpError(404, `添付ファイル ${name} はありません(作り直すと番号が変わります)`);
      sendJson(res, 200, { name, text: await readFile(join(outDir, ...part.path.split('/')), 'utf8') });
      return;
    }
    if (path === '/api/judge/import') {
      if (method !== 'POST') throw new HttpError(405, 'この方法では使えません');
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, '返答を貼り付けてください');
      if (jobs.running()) throw new HttpError(409, `ほかの処理が動いています。終わってから取り込んでください`);
      const other = runningJobIn(outDir);
      if (other) throw new HttpError(409, `別の atlas の処理(${other})が動いています。終わってから取り込んでください`);
      const ids = await sessionIndex();
      let r;
      try {
        r =
          target === 'turns'
            ? await importTurnJudgmentsText(body.text, join(outDir, 'turn-judgments.json'), { phases: await turnImportPhases(join(outDir, 'turn-bundle'), await phaseNames()), turnsBySession: ids ? new Map([...ids].map(([id, x]) => [id, x.turns])) : undefined })
            : await importJudgmentsText(body.text, join(outDir, 'judgments.json'), { knownIds: ids ? new Set(ids.keys()) : undefined });
      } catch (e) {
        if (e instanceof JudgmentValidationError) {
          sendJson(res, 400, { error: '返答の形が判定の形式に合いません(何も取り込んでいません)', problems: e.problems });
          return;
        }
        throw new HttpError(400, (e as Error).message);
      }
      log(`${target === 'turns' ? 'turns import' : 'judge import'}(画面): ${r.imported} 件を取り込みました(既存の上書き ${r.overwritten} 件)`);
      const unknownIds = 'unknownIds' in r ? r.unknownIds : r.unknown;
      sendJson(res, 200, { imported: r.imported, overwritten: r.overwritten, duplicates: 'duplicates' in r ? r.duplicates : 0, unknownIds, total: r.total, parts: await partsOf() });
      return;
    }
    throw new HttpError(404, '無い API です');
  }
  async function chatParts(): Promise<{
    exists: boolean;
    generatedAt?: string;
    unjudgedOnly?: boolean;
    count?: number;
    parts?: { path: string; name: string; sessions: number; judged: number; bytes: number }[];
  }> {
    const dir = join(outDir, 'bundle');
    if (!existsSync(join(dir, 'manifest.json'))) return { exists: false };
    let m;
    try {
      m = await readBundleManifest(dir);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    const judged = await judgedIds();
    const parts = (m.parts ?? [])
      .filter((p) => existsSync(join(dir, ...p.path.split('/'))))
      .map((p) => ({ path: `bundle/${p.path}`, name: p.path.split('/').pop()!, sessions: p.sessions.length, judged: p.sessions.filter((id) => judged.has(id)).length, bytes: p.bytes }));
    return { exists: true, generatedAt: m.generatedAt, unjudgedOnly: m.scope?.unjudged === 'yes', count: m.count, parts };
  }
  /** 依頼ごとの判定の添付ファイル(turn-bundle/parts/)。sessions / judged は依頼の数 */
  async function turnParts(): Promise<Awaited<ReturnType<typeof chatParts>>> {
    const dir = join(outDir, 'turn-bundle');
    if (!existsSync(join(dir, 'manifest.json'))) return { exists: false };
    let m;
    try {
      m = await readTurnBundleManifest(dir);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    const judged = await judgedTurns();
    const parts = m.parts
      .filter((p) => existsSync(join(dir, ...p.path.split('/'))))
      .map((p) => ({
        path: `turn-bundle/${p.path}`,
        name: p.path.split('/').pop()!,
        sessions: p.turns,
        judged: p.chunks.reduce((a, c) => a + c.turns.filter((t) => judged.has(`${c.sessionId}#${t}`)).length, 0),
        bytes: p.bytes,
      }));
    return { exists: true, generatedAt: m.generatedAt, unjudgedOnly: m.unjudgedOnly, count: m.count, parts };
  }
  function viewTarget(rawId: string, kindParam: string | null): { id: string; kind: ViewKind; file: string; mdHref: string } {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      throw new HttpError(400, 'セッション id を読めません');
    }
    if (!isSafeMemoId(id)) throw new HttpError(400, 'セッション id の形が正しくありません');
    const kind = (kindParam ?? 'transcript') as ViewKind;
    if (!VIEW_KINDS.includes(kind)) throw new HttpError(400, `kind は ${VIEW_KINDS.join(' / ')} のどちらかです`);
    const name = kind === 'transcript' ? transcriptFileName(id) : fullFileName(id);
    const dir = kind === 'transcript' ? 'sessions' : 'full';
    return { id, kind, file: join(outDir, dir, name), mdHref: `../${dir}/${encodeURIComponent(name)}` };
  }
  /** GET /api/view/<id>?kind=transcript|full: .md をメモと同じ規則で HTML にして返す(上限を超えたら描かない) */
  async function viewApi(req: IncomingMessage, res: ServerResponse, method: string, rawId: string, url: URL): Promise<void> {
    checkToken(req);
    if (method !== 'GET') throw new HttpError(405, 'この方法では使えません');
    const t = viewTarget(rawId, url.searchParams.get('kind'));
    const ids = await sessionIndex();
    if (!ids?.has(t.id)) throw new HttpError(404, refreshing() ? REFRESHING : `セッション ${t.id} は sessions.json にありません`);
    if (!existsSync(t.file))
      throw new HttpError(
        404,
        refreshing()
          ? REFRESHING
          : t.kind === 'full'
            ? '全文記録はまだありません。詳細ページの「全文を作って読む」で作ってください。'
            : 'セッション記録(.md)がありません。atlas.html の「集計し直す」で作られます。',
      );
    const st = await stat(t.file);
    const limit = o.viewLimit ?? VIEW_LIMIT;
    const base = { id: t.id, kind: t.kind, label: VIEW_LABEL[t.kind], title: ids.get(t.id)!.title, size: st.size, limit, updatedAt: st.mtime.toISOString(), mdHref: t.mdHref };
    if (st.size > limit) {
      sendJson(res, 200, { ...base, tooLarge: true });
      return;
    }
    const doc = renderViewDocument(await readFile(t.file, 'utf8'), { kind: t.kind, id: t.id, fullDir: join(outDir, 'full') });
    touchIdle();
    sendJson(res, 200, { ...base, tooLarge: false, docTitle: doc.title, html: doc.html, headings: doc.headings });
  }
  /** GET /view/<id>?kind=…: 表示の殻(本文は持たない。token は HTML の meta で渡し、本文は殻の script が API から取る) */
  async function viewShell(req: IncomingMessage, res: ServerResponse, rawId: string, url: URL): Promise<void> {
    checkOrigin(req);
    if (await isAnonymized()) throw new HttpError(403, '伏せ字版では記録を表示しません');
    const t = viewTarget(rawId, url.searchParams.get('kind'));
    const html = renderViewerShell({ css: await pageCss(), id: t.id, kind: t.kind, detailHref: `../sessions/${encodeURIComponent(detailFileName(t.id))}`, mdHref: t.mdHref }).replace(TOKEN_PLACEHOLDER, token);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'x-atlas-serve': '1', ...HTML_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : html);
  }
  // groups.json の読み・変更・書き込みは順番に行う(2 つの要求が同じ内容を読み、後の書き込みが先の変更を消さないように)
  let groupsLock: Promise<unknown> = Promise.resolve();
  function withGroupsLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = groupsLock.then(fn);
    groupsLock = next.catch(() => {});
    return next;
  }
  const memoLocks = new Map<string, Promise<unknown>>();
  function withMemoLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (memoLocks.get(id) ?? Promise.resolve()).then(fn);
    memoLocks.set(id, next.catch(() => {}));
    return next;
  }
  function memoBody(id: string, x: MemoFile | null): Record<string, unknown> {
    return x ? { text: x.text, rev: x.rev, html: renderMemo(memoDir, id, x.text), updatedAt: x.updatedAt } : { text: '', rev: '', html: '', updatedAt: null };
  }
  /** GET / PUT /api/memos/<id>、POST /api/memos/<id>/images。PUT の rev が今の本文と違えば書かずに 409(Obsidian や CLI と同時に触っても黙って消さない) */
  async function memoApi(req: IncomingMessage, res: ServerResponse, method: string, rawId: string, images: boolean): Promise<void> {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      throw new HttpError(400, 'セッション id を読めません');
    }
    if (!isSafeMemoId(id)) throw new HttpError(400, 'メモに使えないセッション id です');
    if (images) {
      if (method !== 'POST') throw new HttpError(405, 'この方法では使えません');
      checkToken(req);
      const data = await readBody(req, o.memoImageLimit ?? MEMO_IMAGE_LIMIT);
      if (!imageExt(data)) throw new HttpError(415, 'png / jpeg / gif / webp の画像だけ追加できます');
      sendJson(res, 201, await saveMemoImage(memoDir, id, data));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, memoBody(id, await readMemo(memoDir, id)));
      return;
    }
    if (method !== 'PUT') throw new HttpError(405, 'この方法では使えません');
    checkToken(req);
    const body = await readJsonBody(req);
    if (typeof body.text !== 'string') throw new HttpError(400, 'text は文字列です');
    if (typeof body.rev !== 'string') throw new HttpError(400, 'rev は文字列です');
    // 確認と書き込みの間に別の PUT が入らないよう、同じ id の保存は順番に行う(2 つのタブで同じ rev を送っても片方は 409 になる)
    const r = await withMemoLock(id, () => saveMemo(memoDir, id, body.text as string, body.rev as string));
    if (r.conflict) sendJson(res, 409, { error: 'メモが別の場所で更新されました', rev: r.conflict.rev });
    else sendJson(res, 200, memoBody(id, r.memo));
  }
  async function loadForWrite(): Promise<SessionGroup[]> {
    try {
      return await loadGroupsForWrite(groupsPath);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const view = /^\/view\/([^/]+)$/.exec(path);
    if (view) {
      await viewShell(req, res, view[1], url);
      return;
    }
    if (path === '/') {
      res.writeHead(302, { location: '/atlas.html' });
      res.end();
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new HttpError(400, 'パスを読めません');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'パスを読めません');
    // out/ の外は読めない(正規化して out/ 配下か見る)。.serve.json も出さない
    const file = resolve(outDir, `.${decoded}`);
    if (file !== outDir && !file.startsWith(outDir + sep)) throw new HttpError(404, 'ありません');
    if (file === join(outDir, SERVE_STATE_FILE)) throw new HttpError(404, 'ありません');
    // 集計し直している間は build が sessions/ を消してから書くので、詳細ページが一時的に無いことがある
    if (!existsSync(file)) throw new HttpError(404, refreshing() ? REFRESHING : 'ありません');
    const st = await stat(file);
    if (st.isDirectory()) throw new HttpError(404, 'ありません');
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (extname(file).toLowerCase() === '.html' && isAppPage(relative(outDir, file).split(sep).join('/'))) {
      // token は HTML の meta のプレースホルダを置き換えて渡す(file:// で開いたときはプレースホルダのまま = 空扱い)
      const html = (await readFile(file, 'utf8')).replace(TOKEN_PLACEHOLDER, token);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...HTML_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store', ...FILE_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const handle = async (): Promise<void> => {
      checkHost(req);
      await (path.startsWith('/api/') ? api(req, res, path, url) : serveStatic(req, res, path, url));
    };
    handle().catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : `サーバの内部エラー: ${(e as Error).message}`;
      if (path.startsWith('/api/')) sendJson(res, status, { error: message });
      else {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    });
  });
  await new Promise<void>((ok, ng) => {
    server.once('error', ng);
    server.listen(o.port ?? 0, '127.0.0.1', () => ok());
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/atlas.html`;
  await writeFile(join(outDir, SERVE_STATE_FILE), `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  firstTimer = setTimeout(() => expire('ブラウザから最初の heartbeat が届かなかった'), firstMs);
  log(`serve: ${url}(127.0.0.1 だけに公開。ブラウザを閉じるか、この窓を閉じると終了します)`);
  if (o.open !== false) openInBrowser(url, log);
  return { port, url, token, done, close };
}
