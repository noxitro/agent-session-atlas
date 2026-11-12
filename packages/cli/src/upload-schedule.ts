// 毎日決まった時刻に、プロジェクトのセッションを自動で送る(schedule-upload.bat から呼ぶ)。
// Windows のタスク スケジューラに、自分のユーザーで動くタスクを 1 つ登録する。タスクは窓を出さずに upload-auto.ts を動かし、
// 集計し直してから、画面の「プロジェクト別」で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先(uploadRoot)へ送る。
// 送る前の確認は出さない(登録するときに承知してもらう)。結果は out/auto-upload.json と out/auto-upload.log に残し、ここで見せる。
//
// タスクの作り:
//  - 毎日 HH:MM。その時刻に PC が止まっていたら、次に使い始めたときに動かす(StartWhenAvailable)
//  - ログオンしている間だけ、自分のユーザーで動かす(Interactive)。ネットワークドライブや NAS へ、いつもの資格情報で書けるように
//    (「ログオンしていなくても動かす」にすると、パスワードを預けるか、ネットワークに出られない動かし方になる)
//  - 電池で動いているときも動かし、電池に切り替わっても止めない(ノート PC で毎回飛ばされないように)
//  - 窓は出さない(conhost.exe --headless)。2 時間で打ち切り、前の回が動いていれば重ねない
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_ENTRY_NAME, AUTO_LOG_FILE, AUTO_STATUS_FILE, type AutoStatusFile } from './upload-auto-files.ts';

/** タスク スケジューラでの名前(ライブラリの直下。サブフォルダは、作る権限が無い PC があるため使わない) */
export const TASK_NAME = 'agent-session-atlas-upload';
/** 時刻を入れずに Enter を押したときの時刻 */
export const DEFAULT_TIME = '18:00';

const CLI_SRC = dirname(fileURLToPath(import.meta.url));
/** タスクが動かすもの */
export const AUTO_ENTRY = join(CLI_SRC, AUTO_ENTRY_NAME);
const REPO_ROOT = resolve(CLI_SRC, '..', '..', '..');

/** PowerShell のスクリプトを動かした結果 */
export interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** PowerShell を動かす口(テストでは偽物を渡す)。値はスクリプトに埋め込まず、環境変数で渡す(引用符の扱いで壊さない) */
export type PsRunner = (script: string, env: Record<string, string>) => Promise<PsResult>;

/** Windows に入っている PowerShell 5.1 で動かす(タスク スケジューラの操作と、Windows の通知を出すのに使う) */
export const runPowerShell: PsRunner = (script, env) =>
  new Promise((resolvePs, reject) => {
    // 進み具合(初めてモジュールを読むときの「準備しています」など)はエラー出力に混ざるので出さない
    const body = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => reject(new Error(`PowerShell を動かせませんでした(${e.message})`)));
    child.on('close', (code) => resolvePs({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });

/**
 * PowerShell のエラー出力を読める文にする。-EncodedCommand で動かすと、エラーは CLIXML(#< CLIXML の後の XML)で届くので、
 * エラーの文(<S S="Error">)だけを取り出す
 */
export function psErrorText(stderr: string): string {
  if (!stderr.trimStart().startsWith('#< CLIXML')) return stderr.trim();
  const xml = (s: string): string =>
    s
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  return [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => xml(m[1]!)).join('').trim();
}

/** PowerShell が失敗したときの理由(エラーの最初の行) */
function psError(r: PsResult, what: string): Error {
  const first = psErrorText(r.stderr).split(/\r?\n/).find((l) => l.trim()) ?? `終了コード ${r.code}`;
  return new Error(`${what}(${first.trim()})`);
}

/**
 * 送る時刻の入力(「18:00」「18」「1830」「18時30分」「8:5」。全角も可)を HH:MM にする。読めない・範囲の外は null
 */
export function parseTime(answer: string): string | null {
  const s = answer.normalize('NFKC').trim().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:時]?(\d{2})分?|:(\d{1,2})分?|時)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? m[3] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** タスクの登録(同じ名前があれば置き換える)。値は環境変数 ATLAS_TASK_* で渡す */
export const REGISTER_SCRIPT = `
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $env:ATLAS_TASK_ARGS -WorkingDirectory $env:ATLAS_TASK_CWD
$t = New-ScheduledTaskTrigger -Daily -At $env:ATLAS_TASK_TIME
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description $env:ATLAS_TASK_DESCRIPTION
if ($env:ATLAS_TASK_DRY_RUN -eq '1') {
  [Console]::Out.Write((@{ execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments; cwd = $task.Actions[0].WorkingDirectory; at = ([datetime]$task.Triggers[0].StartBoundary).ToString('HH:mm'); startWhenAvailable = $task.Settings.StartWhenAvailable; onBatteries = (-not $task.Settings.DisallowStartIfOnBatteries); logon = "$($task.Principal.LogonType)" } | ConvertTo-Json -Compress))
  return
}
Register-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\\' -InputObject $task -Force | Out-Null
`;

/** タスクの今の様子を JSON で 1 行返す(無ければ {"exists":false}) */
export const QUERY_SCRIPT = `
$t = Get-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\\' -ErrorAction SilentlyContinue
if (-not $t) { [Console]::Out.Write('{"exists":false}'); return }
$i = $t | Get-ScheduledTaskInfo
function When($d) { if ($d -and $d.Year -gt 2000) { $d.ToString('yyyy-MM-ddTHH:mm:ss') } else { $null } }
$at = $null
if ($t.Triggers.Count -gt 0 -and $t.Triggers[0].StartBoundary) { $at = ([datetime]$t.Triggers[0].StartBoundary).ToString('HH:mm') }
[Console]::Out.Write((@{ exists = $true; state = "$($t.State)"; at = $at; arguments = $t.Actions[0].Arguments; lastRun = (When $i.LastRunTime); lastResult = $i.LastTaskResult; nextRun = (When $i.NextRunTime) } | ConvertTo-Json -Compress))
`;

export const START_SCRIPT = `Start-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\\'`;
export const UNREGISTER_SCRIPT = `Unregister-ScheduledTask -TaskName $env:ATLAS_TASK_NAME -TaskPath '\\' -Confirm:$false`;

/** タスクの今の様子 */
export type TaskState =
  | { exists: false }
  | { exists: true; state: string; at: string | null; arguments: string; lastRun: string | null; lastResult: number | null; nextRun: string | null };

/** 窓を出さずに node で upload-auto.ts を動かす引数(conhost.exe に渡す) */
export function taskArguments(node: string, entry: string = AUTO_ENTRY): string {
  return `--headless "${node}" "${entry}"`;
}

/** タスクの引数から、登録したときの node のパスを取り出す(Node.js を入れ直して場所が変わったかを見る) */
export function nodeOf(args: string): string | null {
  return /^--headless "([^"]+)"/.exec(args)?.[1] ?? null;
}

export interface Scheduler {
  query(): Promise<TaskState>;
  register(time: string): Promise<void>;
  start(): Promise<void>;
  unregister(): Promise<void>;
}

/** タスク スケジューラを PowerShell で操作する(node は今動いているものを登録する) */
export function taskScheduler(run: PsRunner = runPowerShell, o: { node?: string; entry?: string; cwd?: string } = {}): Scheduler {
  const env = { ATLAS_TASK_NAME: TASK_NAME };
  return {
    async query() {
      const r = await run(QUERY_SCRIPT, env);
      if (r.code !== 0) throw psError(r, 'タスク スケジューラを読めませんでした');
      return JSON.parse(r.stdout.trim()) as TaskState;
    },
    async register(time) {
      const r = await run(REGISTER_SCRIPT, {
        ...env,
        ATLAS_TASK_ARGS: taskArguments(o.node ?? process.execPath, o.entry ?? AUTO_ENTRY),
        ATLAS_TASK_CWD: o.cwd ?? REPO_ROOT,
        ATLAS_TASK_TIME: time,
        ATLAS_TASK_DESCRIPTION: `agent-session-atlas: 毎日 ${time} に、印を付けたプロジェクトのセッションを送り先へ送ります(schedule-upload.bat で変更・停止できます)`,
      });
      if (r.code !== 0) throw psError(r, 'タスクを登録できませんでした');
    },
    async start() {
      const r = await run(START_SCRIPT, env);
      if (r.code !== 0) throw psError(r, 'タスクを動かせませんでした');
    },
    async unregister() {
      const r = await run(UNREGISTER_SCRIPT, env);
      if (r.code !== 0) throw psError(r, 'タスクを消せませんでした');
    },
  };
}

export type AutoStatus = AutoStatusFile;

export function readAutoStatus(outDir: string): AutoStatus | null {
  try {
    return JSON.parse(readFileSync(join(outDir, AUTO_STATUS_FILE), 'utf8')) as AutoStatus;
  } catch {
    return null;
  }
}

/** 日時を「2026-11-12 18:00」の形で(ローカルの時刻) */
export function when(iso: string | null): string {
  if (!iso) return '不明';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 前回の結果を 1 行で */
export function describeStatus(s: AutoStatus): string {
  if (!s.finishedAt) return `前回: ${when(s.startedAt)} に始めて、まだ終わっていません(動いている途中か、途中で止まりました)。`;
  if (!s.ok) return `前回: ${when(s.finishedAt)} に送れませんでした: ${s.error ?? '理由は記録をご覧ください'}`;
  const sessions = s.sent.reduce((a, p) => a + p.sessions, 0);
  return `前回: ${when(s.finishedAt)} に ${s.sent.length} プロジェクト・${sessions} セッションを送りました${s.secrets ? `(秘密らしい文字列 ${s.secrets} 件を含む)` : ''}。`;
}

export interface ScheduleIo {
  ask: (q: string) => Promise<string>;
  print: (line: string) => void;
  /** 今の様子を 1 行で書き換えて見せる(無ければ出さない) */
  status?: (text: string) => void;
}

export interface ScheduleOptions {
  scheduler: Scheduler;
  /** 送り先と印を読む設定 */
  config: () => Promise<{ uploadRoot: string | null; uploadProjects: string[] | null }>;
  outDir: string;
  /** 試しに 1 回送ったとき、終わるのを待つ長さ(既定 15 分)と、見に行く間隔 */
  waitMs?: number;
  pollMs?: number;
  /** ファイルがあるか(テストでは偽物を渡す) */
  exists?: (p: string) => boolean;
}

const yes = (a: string): boolean => /^(?:y|yes|はい)$/i.test(a.normalize('NFKC'));

/** 試しに 1 回送り、終わるのを待って結果を出す(窓は出ないので、ここで待って見せる) */
async function runOnce(io: ScheduleIo, o: ScheduleOptions): Promise<void> {
  const before = readAutoStatus(o.outDir)?.startedAt ?? '';
  await o.scheduler.start();
  io.print('  送り始めました(窓は出ません)。終わるまで待ちます。この窓を閉じても、送るのは続きます。');
  const started = Date.now();
  const wait = o.waitMs ?? 15 * 60_000;
  for (;;) {
    const s = readAutoStatus(o.outDir);
    if (s && s.startedAt !== before && s.finishedAt) {
      io.print(`  ${describeStatus(s).replace(/^前回: /, '')}`);
      if (!s.ok) io.print(`  記録: ${join(o.outDir, AUTO_LOG_FILE)}`);
      return;
    }
    if (Date.now() - started > wait) {
      io.print(`  まだ終わっていません。結果は、もう一度 schedule-upload.bat を開くと見られます(記録: ${join(o.outDir, AUTO_LOG_FILE)})。`);
      return;
    }
    io.status?.(`  送っています...(経過 ${Math.round((Date.now() - started) / 1000)} 秒)`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
  }
}

/** 送る時刻を尋ねる。やめたら null */
async function askTime(io: ScheduleIo, current: string | null): Promise<string | null> {
  for (;;) {
    const def = current ?? DEFAULT_TIME;
    const a = await io.ask(`  送る時刻を入れて Enter(例: 18:00。Enter だけなら ${def}。やめるなら n)\n  > `);
    if (/^n(o)?$/i.test(a.normalize('NFKC').trim())) return null;
    if (!a.trim()) return def;
    const t = parseTime(a);
    if (t) return t;
    io.print(`  「${a}」は時刻として読めません。18:00 や 17:30 の形で入れ直してください。`);
  }
}

/**
 * 対話の本体。登録していなければ、決まりを見せて時刻を尋ね、登録する。登録してあれば、様子と前回の結果を見せ、
 * 時刻を変える・今すぐ 1 回送る・やめる(登録を消す)を選んでもらう
 */
export async function runSchedule(io: ScheduleIo, o: ScheduleOptions): Promise<void> {
  const exists = o.exists ?? existsSync;
  const task = await o.scheduler.query();
  const cfg = await o.config();
  const last = readAutoStatus(o.outDir);
  io.print('');
  io.print('== 毎日自動で送る ==');
  if (task.exists) {
    io.print(`  毎日 ${task.at ?? '(時刻不明)'} に送ります${task.nextRun ? `(次: ${when(task.nextRun)})` : ''}。`);
    if (task.state === 'Disabled') io.print('  ただし、タスク スケジューラで「無効」になっています。t で登録し直すと有効に戻ります。');
    const node = nodeOf(task.arguments);
    if (node && !exists(node)) io.print(`  登録したときの Node.js が見つかりません(${node})。t で登録し直してください。`);
    if (last) io.print(`  ${describeStatus(last)}`);
    else if (task.lastRun) io.print(`  前回: ${when(task.lastRun)} に動きましたが、結果の記録がありません(終了コード ${task.lastResult})。`);
    else io.print('  まだ 1 回も動いていません。');
  } else {
    io.print('  まだ登録していません。');
  }
  // 自動で送るのに要るもの(尋ねずに送るので、先に揃っていないと毎回失敗する)
  const rootOk = cfg.uploadRoot != null && exists(cfg.uploadRoot);
  io.print(`  送り先: ${cfg.uploadRoot ? `${cfg.uploadRoot}${rootOk ? '' : '(今は見つかりません)'}` : 'まだ決まっていません'}`);
  io.print(`  送るプロジェクト: ${cfg.uploadProjects ? `画面で印を付けた ${cfg.uploadProjects.length} プロジェクト(${cfg.uploadProjects.slice(0, 3).join('、')}${cfg.uploadProjects.length > 3 ? ' ほか' : ''})` : '印がありません'}`);

  if (!task.exists) {
    const missing: string[] = [];
    if (!cfg.uploadRoot) missing.push('送り先を決めてください(upload-project.bat を一度使うか、atlas.bat の画面の「設定…」で決められます)。');
    if (!cfg.uploadProjects) missing.push('送るプロジェクトに印を付けてください(atlas.bat の画面の「プロジェクト別」の表の「まとめて送る」)。');
    if (missing.length) {
      io.print('');
      io.print('== 先に決めること ==');
      for (const m of missing) io.print(`  ${m}`);
      io.print('  決めてから、もう一度 schedule-upload.bat を開いてください(何も登録していません)。');
      return;
    }
    io.print('');
    io.print('== 自動で送るときの決まり ==');
    io.print('  - 毎日決まった時刻に、窓を出さずに集計し直してから、印を付けたプロジェクトを送り先へ送ります。');
    io.print('  - その時刻に PC が止まっていたら、次に PC を使い始めたときに送ります(ログオンしている間だけ動きます)。');
    io.print('  - 送る前の確認(送り先・大きさ・秘密らしい文字列)は出しません。秘密らしい文字列があっても送り、数を記録に残します。');
    io.print('  - 印の無いプロジェクトは送りません。新しく始めたプロジェクトは、画面で印を付けてください。');
    io.print('  - 送れなかったときは、Windows の通知で知らせます。結果は、この schedule-upload.bat を開くと見られます。');
    io.print('');
    const time = await askTime(io, null);
    if (!time) {
      io.print('  やめました(何も登録していません)。');
      return;
    }
    await o.scheduler.register(time);
    io.print(`  登録しました。毎日 ${time} に送ります。`);
    io.print('');
    if (yes(await io.ask('  今すぐ 1 回送って試しますか? y = 送る   Enter = 送らない\n  > '))) await runOnce(io, o);
    return;
  }

  io.print('');
  const a = (await io.ask('  t = 時刻を変える   s = 今すぐ 1 回送る   d = 自動で送るのをやめる   Enter = 閉じる\n  > ')).normalize('NFKC').trim().toLowerCase();
  if (a === 't') {
    const time = await askTime(io, task.at);
    if (!time) {
      io.print('  やめました(登録は今のままです)。');
      return;
    }
    await o.scheduler.register(time);
    io.print(`  登録し直しました。毎日 ${time} に送ります。`);
  } else if (a === 's') {
    await runOnce(io, o);
  } else if (a === 'd') {
    await o.scheduler.unregister();
    io.print('  登録を消しました。これからは自動で送りません(送ったものはそのまま残ります)。');
  }
}

// schedule-upload.bat から。黒い窓とのやりとりは upload-project.bat と同じ作り(尋ねていない間に打ったキーは捨てる)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { consoleIo } = await import('./upload-project.ts');
  const { defaultConfigPath, loadConfig } = await import('./config.ts');
  const { resolvePaths } = await import('./commands.ts');
  const c = consoleIo(async () => null);
  try {
    if (process.platform !== 'win32') {
      c.io.print('毎日自動で送る登録は、Windows でだけ使えます。ほかの OS では、cron などから次を動かしてください:');
      c.io.print(`  node "${AUTO_ENTRY}"`);
      process.exitCode = 1;
    } else {
      await runSchedule(c.io, {
        scheduler: taskScheduler(),
        config: () => loadConfig(defaultConfigPath(), false),
        // ATLAS_OUT は試すとき用(upload-auto.ts と同じ出力先を見る)
        outDir: process.env.ATLAS_OUT ? resolve(process.env.ATLAS_OUT) : resolvePaths({ home: null, out: null, judgments: null }).out,
      });
      process.exitCode = 0;
    }
  } catch (e) {
    c.clear();
    process.stderr.write(`\n止まりました: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    c.close();
  }
}
