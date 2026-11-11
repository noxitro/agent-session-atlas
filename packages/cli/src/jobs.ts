// Phase 14: atlas serve の画面から動かす処理(ジョブ)。同時に 1 つだけ。
// - refresh: 子プロセス `main.ts all --out <out> --notes-dir <notes>`(集計し直す)
// - judge:   子プロセス `judge-flow.ts --limit <n> --backend <b> --out <out> --notes-dir <notes>`(bundle → judge run → export)
// - full:    サーバ内で 1 件だけ全文記録を書く(writeFullRecord。atlas.html・coverage.json・他のセッションは触らない)
// - bundle:  子プロセス `main.ts bundle --unjudged …`(チャットに添付する評価バンドルを未判定のセッションだけで作る。LLM は呼ばない)
// - export:  子プロセス `main.ts export …`(チャットの返答を取り込んだ後、判定をレポートに反映する)
// - turn-bundle: 子プロセス `main.ts turns bundle --unjudged …`(依頼ごとの判定でチャットに添付するファイルを作る。LLM は呼ばない)
// - turn-judge:  子プロセス `judge-flow.ts --turns --limit <n> …`(依頼ごとの判定を GitHub Copilot CLI で回し、レポートを作り直す)
// 子プロセスの引数はここで固定の配列に組み立て、process.execPath を shell なしで起動する(画面からの文字列をコマンドラインに入れない)。
// 起動の仕方(spawn)と全文の書き出し(runFull)は差し替えられる(単体テストを速く回すため)。
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeMemoId } from '../../report/src/index.ts';

export const JOB_KINDS = ['refresh', 'judge', 'full', 'bundle', 'export', 'turn-bundle', 'turn-judge'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
/** 画面から始める判定のバックエンド(従量課金の anthropic は CLI だけ) */
export const JOB_BACKENDS = ['copilot-cli'] as const;
export type JobBackend = (typeof JOB_BACKENDS)[number];
export const JOB_LIMIT_MAX = 500;
/** 依頼ごとの判定の件数の上限(1 セッション 200 依頼 × 数十セッション) */
export const TURN_LIMIT_MAX = 5000;
/** 残すログの行数(子プロセスの stdout / stderr の末尾) */
export const JOB_LOG_LINES = 200;
/**
 * out/ に書く処理の実行中だけ置く印({ pid, kind, by, startedAt })。serve のジョブも CLI の書き込むコマンド(all・judge・build など)も置き、
 * 他のプロセスの印があれば始めずに止まる(atlas.bat の再実行や npm run atlas:judge と画面の判定が、同じ out/ に並行して書かないように)。
 * ジョブの子プロセスには JOB_ENV を渡し、親(serve)の印では止まらないようにする
 */
export const JOB_LOCK_FILE = '.job.json';
export const JOB_ENV = 'ATLAS_SERVE_JOB';
/** 中身を読めない印を、まだ書きかけとみなす時間(作った直後に別のプロセスが読むと空のことがある) */
const LOCK_WRITE_GRACE_MS = 10_000;

interface LockInfo {
  pid?: number;
  kind?: string;
  /** 印を置いたのは serve(画面のジョブ)か CLI か */
  by?: 'serve' | 'cli';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM はプロセスがあるが触れない(別の利用者など)
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(p: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

function writtenWithin(p: string, ms: number): boolean {
  try {
    return Date.now() - statSync(p).mtimeMs < ms;
  } catch {
    return false;
  }
}

/** 他のプロセスの処理が out/ で動いていれば、その種類を返す。印が古い(プロセスが無い)・自分の印・ジョブの子プロセスなら null */
export function runningJobIn(outDir: string): string | null {
  if (process.env[JOB_ENV]) return null;
  const j = readLock(join(outDir, JOB_LOCK_FILE));
  if (!j?.pid || j.pid === process.pid || !alive(j.pid)) return null;
  return j.kind ?? 'job';
}

export class OutBusyError extends Error {
  constructor(outDir: string, j: LockInfo) {
    const what = j.by === 'cli' ? `別の atlas の処理(${j.kind ?? '不明'})` : `画面から実行した処理(${j.kind ?? '不明'})`;
    const hint = j.by === 'cli' ? '' : '画面の帯で進み具合を見られます。';
    super(`${what}が ${outDir} で動いています。終わってから実行してください(${hint}処理がもう動いていないのにこの表示が続くときは ${join(outDir, JOB_LOCK_FILE)} を消してください)`);
  }
}

/**
 * out/ の印を取り、外す関数を返す。他のプロセスが持っていれば OutBusyError。
 * 印は排他的に作る(wx)ので、2 つが同時に取りに来ても片方だけが取れる。次のときは何もしない関数を返す:
 * 同じプロセスが持っている(atlas:judge の bundle → judge → export の入れ子)・ジョブの子プロセス・印が書けない(並行実行を止められないだけで、処理は動かす)
 */
export function acquireOutLock(outDir: string, kind: string, by: 'serve' | 'cli'): () => void {
  const none = (): void => {};
  if (process.env[JOB_ENV]) return none;
  const p = join(outDir, JOB_LOCK_FILE);
  const body = `${JSON.stringify({ pid: process.pid, kind, by, startedAt: new Date().toISOString() })}\n`;
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    return none;
  }
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p, body, { flag: 'wx' });
      return () => releaseOutLock(outDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return none;
    }
    const cur = readLock(p);
    if (cur?.pid === process.pid) return none;
    if (cur?.pid ? alive(cur.pid) : writtenWithin(p, LOCK_WRITE_GRACE_MS)) throw new OutBusyError(outDir, cur ?? {});
    // 古い印(プロセスが無い・壊れたまま時間が経った)は消して取り直す
    rmSync(p, { force: true });
  }
  throw new OutBusyError(outDir, readLock(p) ?? {});
}

/** 自分の印だけを消す(消せなくても止めない。次に取りに来た側はプロセスの有無で古い印を無視する) */
export function releaseOutLock(outDir: string): void {
  try {
    const p = join(outDir, JOB_LOCK_FILE);
    if (!existsSync(p)) return;
    if (readLock(p)?.pid === process.pid) rmSync(p, { force: true });
  } catch {
    /* ウイルス対策ソフトが握っている等 */
  }
}

export type JobRequest =
  | { kind: 'refresh' }
  | { kind: 'judge'; limit: number; backend: JobBackend }
  | { kind: 'full'; id: string }
  | { kind: 'bundle' }
  | { kind: 'export' }
  | { kind: 'turn-bundle' }
  | { kind: 'turn-judge'; limit: number };
export type JobState = 'running' | 'done' | 'failed' | 'canceled';

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  state: JobState;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  /** 子プロセスの stdout / stderr(full はサーバ内の進み具合)の末尾 JOB_LOG_LINES 行 */
  log: string[];
  /** 要求の中身(判定の件数とバックエンド、全文のセッション id) */
  target: { limit?: number; backend?: JobBackend; id?: string };
}

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const KEYS: Record<JobKind, string[]> = {
  refresh: ['kind'],
  judge: ['kind', 'limit', 'backend'],
  full: ['kind', 'id'],
  bundle: ['kind'],
  export: ['kind'],
  'turn-bundle': ['kind'],
  'turn-judge': ['kind', 'limit'],
};

/**
 * POST /api/jobs の本文を検証する(純関数)。kind は列挙、limit は 0〜500 の整数(数値で必須。画面の確認で決めた件数だけ受ける)、
 * backend は省ける(画面から始める判定は copilot-cli だけなので、無ければそれ。書くなら copilot-cli)、id はファイル名に使える形で、
 * knownId(sessions.json にあるか)を満たすこと。知らないキーは 400
 */
export function parseJobRequest(body: Record<string, unknown>, knownId: (id: string) => boolean): JobRequest {
  const kind = body.kind;
  if (typeof kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(kind)) throw new JobError(400, `kind は ${JOB_KINDS.join(' / ')} のどれかです`);
  const extra = Object.keys(body).filter((k) => !KEYS[kind as JobKind].includes(k));
  if (extra.length) throw new JobError(400, `${kind} では使えない項目です: ${extra.join(', ')}`);
  if (kind === 'refresh' || kind === 'bundle' || kind === 'export' || kind === 'turn-bundle') return { kind };
  if (kind === 'turn-judge') {
    const { limit } = body;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > TURN_LIMIT_MAX) throw new JobError(400, `limit には 0〜${TURN_LIMIT_MAX} の整数を指定してください(判定する依頼の数の上限)`);
    return { kind: 'turn-judge', limit };
  }
  if (kind === 'judge') {
    const { limit } = body;
    const backend = body.backend === undefined ? JOB_BACKENDS[0] : body.backend;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > JOB_LIMIT_MAX) throw new JobError(400, `limit には 0〜${JOB_LIMIT_MAX} の整数を指定してください(判定する件数の上限)`);
    if (typeof backend !== 'string' || !(JOB_BACKENDS as readonly string[]).includes(backend)) throw new JobError(400, `backend は ${JOB_BACKENDS.join(' / ')} です(従量課金の anthropic は CLI からだけ使えます)`);
    return { kind: 'judge', limit, backend: backend as JobBackend };
  }
  const id = body.id;
  if (typeof id !== 'string' || !isSafeMemoId(id)) throw new JobError(400, 'セッション id の形が正しくありません');
  if (!knownId(id)) throw new JobError(404, `セッション ${id} は sessions.json にありません(集計し直すと出ることがあります)`);
  return { kind: 'full', id };
}

const CLI_DIR = fileURLToPath(new URL('.', import.meta.url));
export const MAIN_TS = join(CLI_DIR, 'main.ts');
export const JUDGE_FLOW_TS = join(CLI_DIR, 'judge-flow.ts');

/** 子プロセスの引数(process.execPath の後ろ)。サーバが固定の形で組み立てる。full はサーバ内なので null */
export function jobArgs(req: JobRequest, p: { outDir: string; notesDir: string; main?: string; judgeFlow?: string }): string[] | null {
  const common = ['--out', p.outDir, '--notes-dir', p.notesDir];
  if (req.kind === 'refresh') return [p.main ?? MAIN_TS, 'all', ...common];
  if (req.kind === 'judge') return [p.judgeFlow ?? JUDGE_FLOW_TS, '--limit', String(req.limit), '--backend', req.backend, ...common];
  if (req.kind === 'bundle') return [p.main ?? MAIN_TS, 'bundle', '--unjudged', ...common];
  if (req.kind === 'export') return [p.main ?? MAIN_TS, 'export', ...common];
  if (req.kind === 'turn-bundle') return [p.main ?? MAIN_TS, 'turns', 'bundle', '--unjudged', ...common];
  if (req.kind === 'turn-judge') return [p.judgeFlow ?? JUDGE_FLOW_TS, '--turns', '--limit', String(req.limit), ...common];
  return null;
}

/** spawn の差し替え口。stdout / stderr を読み、close(終了コード)と error を受け、kill で止める */
export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  kill(): void;
}
export type SpawnFn = (args: string[], env: NodeJS.ProcessEnv) => ChildLike;

/** 既定の起動: process.execPath を shell なしで。止めるときは Windows では子孫ごと(judge-flow が起動した copilot を残さない) */
export const defaultSpawn: SpawnFn = (args, env) => {
  const c = nodeSpawn(process.execPath, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    stdout: c.stdout,
    stderr: c.stderr,
    on: (event: 'close' | 'error', cb: (...args: any[]) => void) => c.on(event, cb),
    kill() {
      if (process.platform === 'win32' && c.pid) {
        const tk = nodeSpawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(c.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        tk.on('error', () => c.kill());
      } else c.kill('SIGTERM');
    },
  } as ChildLike;
};

export type RunFullFn = (id: string, ctx: { log: (line: string) => void; signal: AbortSignal }) => Promise<void>;

export interface JobRunnerOptions {
  outDir: string;
  notesDir: string;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  runFull: RunFullFn;
  /** serve の窓に流す(atlas.bat の窓にもジョブのログが出る) */
  log?: (msg: string) => void;
  /** ジョブが終わったとき(serve が idle の判定を再開する) */
  onEnd?: (job: JobSnapshot) => void;
}

const LABEL: Record<JobKind, string> = {
  refresh: '集計し直す',
  judge: '工数を判定する',
  full: '全文を作る',
  bundle: '添付ファイルを作る',
  export: 'レポートに反映する',
  'turn-bundle': '依頼の判定の添付ファイルを作る',
  'turn-judge': '依頼を判定する',
};

export class JobRunner {
  private job: JobSnapshot | null = null;
  private stop: (() => void) | null = null;
  private canceling = false;
  private seq = 0;
  private readonly o: JobRunnerOptions;
  constructor(o: JobRunnerOptions) {
    this.o = o;
  }

  current(): JobSnapshot | null {
    return this.job ? { ...this.job, log: [...this.job.log], target: { ...this.job.target } } : null;
  }
  running(): boolean {
    return this.job?.state === 'running';
  }

  private push(line: string): void {
    const j = this.job!;
    j.log.push(line);
    if (j.log.length > JOB_LOG_LINES) j.log.splice(0, j.log.length - JOB_LOG_LINES);
    this.o.log?.(`[${LABEL[j.kind]}] ${line}`);
  }

  private finish(state: JobState, exitCode: number | null): void {
    const j = this.job!;
    if (j.state !== 'running') return;
    j.state = this.canceling ? 'canceled' : state;
    j.exitCode = exitCode;
    j.endedAt = new Date().toISOString();
    this.stop = null;
    this.dropLock();
    this.o.log?.(`[${LABEL[j.kind]}] ${j.state === 'done' ? '完了' : j.state === 'canceled' ? '止めました' : `失敗${exitCode != null ? `(終了コード ${exitCode})` : ''}`}`);
    this.o.onEnd?.(this.current()!);
  }

  start(req: JobRequest): JobSnapshot {
    if (this.running()) throw new JobError(409, `ほかの処理(${LABEL[this.job!.kind]})が動いています。終わってから実行してください`);
    // CLI(atlas.bat の再実行・npm run atlas:judge)が同じ out/ に書いている最中なら始めない
    try {
      acquireOutLock(this.o.outDir, req.kind, 'serve');
    } catch (e) {
      if (e instanceof OutBusyError) throw new JobError(409, e.message);
      throw e;
    }
    this.canceling = false;
    this.job = {
      id: `${Date.now().toString(36)}-${++this.seq}`,
      kind: req.kind,
      state: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      log: [],
      target: req.kind === 'judge' ? { limit: req.limit, backend: req.backend } : req.kind === 'turn-judge' ? { limit: req.limit } : req.kind === 'full' ? { id: req.id } : {},
    };
    this.o.log?.(`[${LABEL[req.kind]}] 開始${req.kind === 'judge' ? `(最大 ${req.limit} 件、${req.backend})` : req.kind === 'turn-judge' ? `(最大 ${req.limit} 依頼)` : req.kind === 'full' ? `(${req.id})` : ''}`);
    const args = jobArgs(req, this.o);
    if (args) this.startChild(args);
    else this.startFull((req as { kind: 'full'; id: string }).id);
    return this.current()!;
  }

  private startChild(args: string[]): void {
    let child: ChildLike;
    try {
      child = (this.o.spawn ?? defaultSpawn)(args, { ...process.env, ...this.o.env, [JOB_ENV]: '1' });
    } catch (e) {
      this.push(`起動できませんでした: ${(e as Error).message}`);
      this.finish('failed', null);
      return;
    }
    const lines = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let rest = '';
      stream.setEncoding?.('utf8');
      stream.on('data', (chunk: string | Buffer) => {
        const parts = (rest + String(chunk)).split(/\r?\n/);
        rest = parts.pop() ?? '';
        for (const l of parts) this.push(l);
      });
      stream.on('end', () => {
        if (rest) this.push(rest);
        rest = '';
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    child.on('error', (e) => {
      this.push(`起動できませんでした: ${e.message}`);
      this.finish('failed', null);
    });
    child.on('close', (code) => this.finish(code === 0 ? 'done' : 'failed', code));
    this.stop = () => child.kill();
  }

  private startFull(id: string): void {
    const ac = new AbortController();
    this.stop = () => ac.abort();
    this.o
      .runFull(id, { log: (l) => this.push(l), signal: ac.signal })
      .then(
        () => this.finish('done', 0),
        (e: unknown) => {
          this.push(`失敗しました: ${(e as Error).message}`);
          this.finish('failed', 1);
        },
      );
  }

  /** 実行中の印を消す(ジョブの終わりと serve の終了時。消せなくても serve は止めない) */
  dropLock(): void {
    releaseOutLock(this.o.outDir);
  }

  cancel(): JobSnapshot {
    if (!this.running()) throw new JobError(409, '動いている処理はありません');
    this.canceling = true;
    this.push('止めています…');
    this.stop?.();
    return this.current()!;
  }
}
