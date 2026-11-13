// 自動で送る(schedule-upload.bat で登録したタスクが、毎日決まった時刻に窓を出さずに動かす)。
// 集計し直してから、画面で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先へ尋ねずに送る(upload-project.bat の y まで進めたのと同じ)。
// 窓が無いので、経過は out/auto-upload.log に、結果は out/auto-upload.json に書き、送れなかったときは Windows の通知で知らせる。
// 送る前に、atlas 自身を新しい版にする(self-update.ts。タスクの引数に --no-update があればしない)。新しい版にしたら、
// 新しいコードで動かし直す(今のプロセスは古いコードを読み込んだままなので)。動かし直した側が結果を残さずに終わったら
// (新しい版がこの PC で動かない)、その版を覚えて前の版に戻し、前の版で動かし直して送る(runUpdateFlow)。
// 依存が欠けていても(npm install の前など)記録と通知が残るよう、ここで読むのは node: の標準モジュールだけにし、ほかは動かすときに読む
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_AGGREGATE_LOG_FILE,
  AUTO_LOG_FILE,
  AUTO_STATUS_FILE,
  AUTO_UPDATE_STATE_FILE,
  JOB_LOCK_NAME,
  NO_UPDATE_FLAG,
  PARENT_ENV,
  SERVE_STATE_NAME,
  UPDATED_ENV,
  type AutoStatusFile,
  type AutoUpdateResult,
} from './upload-auto-files.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 画面などが out/ で集計し直している間は待つ長さと、見に行く間隔 */
const BUSY_WAIT_MS = 60 * 60_000;
const BUSY_POLL_MS = 30_000;

/** 結果を書く(書きかけを読まれないよう、別の名前に書いてから置き換える) */
function writeStatus(path: string, s: AutoStatusFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    /* 結果を残せないだけ(記録には書いてある) */
  }
}

export interface AutoDeps {
  outDir: string;
  /** 1 行を記録に書く */
  log: (line: string) => void;
  /** 集計し直す。失敗したら false(理由は記録に書いてある) */
  aggregate: () => Promise<boolean>;
  /** 送る。summary に送ったものを書き込む */
  upload: (summary: { sent: { name: string; sessions: number }[]; secrets: number; root: string | null }) => Promise<boolean>;
  /** out/ で動いている別の処理(画面の「集計し直す」など)の種類。無ければ null */
  busy: () => string | null;
  /** 送れなかったことを知らせる(失敗しても止めない) */
  notify: (title: string, body: string) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  busyWaitMs?: number;
  /** 送る前に atlas を新しい版にした結果(結果のファイルに残す)。更新しない設定なら null */
  update?: AutoUpdateResult | null;
}

/** 自動で送る本体。送れたら true */
export async function runAutoUpload(d: AutoDeps): Promise<boolean> {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const statusPath = join(d.outDir, AUTO_STATUS_FILE);
  const status: AutoStatusFile = { startedAt: now().toISOString(), finishedAt: null, ok: false, error: null, sent: [], secrets: 0, root: null, update: d.update ?? null };
  writeStatus(statusPath, status);
  d.log(`自動で送ります(${status.startedAt})`);
  try {
    // 画面で集計し直している最中なら、終わるまで待つ(重なると、写す元が書き換わるので止まる)
    const waitUntil = Date.now() + (d.busyWaitMs ?? BUSY_WAIT_MS);
    for (let b = d.busy(); b; b = d.busy()) {
      if (Date.now() > waitUntil) throw new Error(`別の処理(${b})が出力先で動き続けているので、送りませんでした。次の回に送ります`);
      d.log(`別の処理(${b})が出力先で動いているので、終わるのを待ちます`);
      await sleep(BUSY_POLL_MS);
    }
    if (!(await d.aggregate())) throw new Error('集計に失敗しました(理由は記録に書きました)');
    const all = await d.upload(status);
    if (!all) throw new Error('送り終えませんでした(理由は記録に書きました)');
    status.ok = true;
    d.log('終わりました');
    return true;
  } catch (e) {
    status.error = (e as Error).message.replace(/\s+/g, ' ').trim();
    d.log(`送れませんでした: ${status.error}`);
    if ((e as Error).stack) d.log((e as Error).stack!);
    try {
      await d.notify('agent-session-atlas: 自動で送れませんでした', `${status.error}\nschedule-upload.bat を開くと、結果と記録の場所が見られます。`);
    } catch (n) {
      d.log(`通知を出せませんでした: ${(n as Error).message}`);
    }
    return false;
  } finally {
    status.finishedAt = now().toISOString();
    writeStatus(statusPath, status);
  }
}

/** Windows の通知(トースト)を出すスクリプト。題と本文は環境変数で渡す。PowerShell 5.1 の名前で出す(アプリとして登録しなくても出せる) */
export const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$(& $esc $env:ATLAS_TOAST_TITLE)</text><text>$(& $esc $env:ATLAS_TOAST_BODY)</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

/** リポジトリの直下 */
const REPO_ROOT = resolve(HERE, '..', '..', '..');
/** 呼び出し元が止められていないかを見る間隔 */
const PARENT_POLL_MS = 30_000;

/** プロセスがあるか(jobs.ts の alive と同じ。依存を読まずに確かめるので、ここにも置く) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * このチェックアウトで atlas の処理が動いているか(動いていれば、その説明)。見るのは、いつもの出力先と、別のフォルダを開いた出力先
 * (<out>-folders/<キー>/out)の、集計の印(.job.json)とサーバの印(.serve.json)。印のプロセスが無ければ、動いていないとみなす
 */
export function atlasRunning(outDir: string): string | null {
  const dirs = [outDir];
  try {
    const root = `${outDir}-folders`;
    for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(root, e.name, 'out'));
  } catch {
    /* 別のフォルダを開いたことが無い */
  }
  for (const dir of dirs) {
    for (const [file, what] of [
      [JOB_LOCK_NAME, '集計など'],
      [SERVE_STATE_NAME, '画面のサーバ'],
    ] as const) {
      try {
        const pid = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { pid?: unknown }).pid;
        if (typeof pid === 'number' && pid !== process.pid && alive(pid)) return `${what}。${dir}`;
      } catch {
        /* 印が無い・読めない */
      }
    }
  }
  return null;
}

/** 前にこの PC で動かなかった版(もっと新しい版が出るまで使わない) */
export function readAvoid(outDir: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(outDir, AUTO_UPDATE_STATE_FILE), 'utf8')) as { avoid?: unknown };
    return typeof j.avoid === 'string' && j.avoid ? j.avoid : null;
  } catch {
    return null;
  }
}

export function writeAvoid(outDir: string, sha: string, note: string): void {
  try {
    writeFileSync(join(outDir, AUTO_UPDATE_STATE_FILE), `${JSON.stringify({ avoid: sha, at: new Date().toISOString(), note }, null, 2)}\n`);
  } catch {
    /* 覚えられないだけ(次の回も新しい版を試し、同じように前の版に戻す) */
  }
}

export interface UpdateFlowDeps {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  log: (line: string) => void;
  /** この回を始めた時刻(動かし直した側が、この回の結果を書いたかを見分ける) */
  startedAt: string;
  /** 新しい版にする(self-update.ts の selfUpdate) */
  update: () => AutoUpdateResult;
  /** 今のコード(新しい版にした後なら新しいコード)で自分を動かし直す。env は足す環境変数 */
  relaunch: (env: Record<string, string>) => { code: number | null; stderr: string };
  readStatus: () => AutoStatusFile | null;
  writeStatus: (s: AutoStatusFile) => void;
  /** 前の版に戻す(self-update.ts の rollback) */
  rollback: (fromSha: string) => { ok: boolean; note: string };
  /** この PC で動かなかった版を覚える */
  avoid: (sha: string, note: string) => void;
  notify: (title: string, body: string) => Promise<void>;
  now?: () => Date;
}

/**
 * 送る前に atlas を新しい版にする。返すのは、この回で使う更新の結果と、動かし直したならその終了コード(動かし直さなければ null。
 * そのときは、呼び出した側がこのまま送る)。
 * 新しい版にしたら、新しいコードで動かし直す。動かし直した側が結果を残さずに終わったら(新しい版がこの PC で動かない)、
 * その版を覚えて前の版に戻し、前の版で動かし直して送る。前の版でも結果が残らなければ、送れなかったことを結果に書いて知らせる
 */
export async function runUpdateFlow(d: UpdateFlowDeps): Promise<{ update: AutoUpdateResult | null; exitCode: number | null }> {
  const now = d.now ?? (() => new Date());
  const passed = d.env[UPDATED_ENV];
  if (passed != null) {
    try {
      return { update: JSON.parse(passed) as AutoUpdateResult, exitCode: null };
    } catch {
      return { update: null, exitCode: null };
    }
  }
  if (d.argv.includes(NO_UPDATE_FLAG)) {
    d.log('atlas の更新: しない設定です(schedule-upload.bat の u で切り替えられます)');
    return { update: null, exitCode: null };
  }
  let update: AutoUpdateResult;
  try {
    update = d.update();
  } catch (e) {
    update = { outcome: 'failed', from: null, to: null, note: `更新できませんでした(${(e as Error).message.replace(/\s+/g, ' ').trim()})` };
    d.log(`atlas の更新: ${update.note}`);
  }
  if (update.outcome !== 'updated') return { update, exitCode: null };

  /** 動かし直して、その側がこの回の結果を書き終えたか */
  const relaunch = (u: AutoUpdateResult): { done: boolean; code: number | null } => {
    const r = d.relaunch({ [UPDATED_ENV]: JSON.stringify(u), [PARENT_ENV]: String(process.pid) });
    const s = d.readStatus();
    const done = s != null && s.startedAt >= d.startedAt && s.finishedAt != null;
    if (!done) {
      d.log(`atlas の更新: 動かし直した側が、結果を残さずに終わりました(終了コード ${r.code ?? '不明'})`);
      for (const line of r.stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-20)) d.log(`  ${line}`);
    }
    return { done, code: r.code };
  };
  const fail = async (message: string, u: AutoUpdateResult): Promise<{ update: AutoUpdateResult; exitCode: number }> => {
    d.log(`送れませんでした: ${message}`);
    d.writeStatus({ startedAt: d.startedAt, finishedAt: now().toISOString(), ok: false, error: message, sent: [], secrets: 0, root: null, update: u });
    await d.notify('agent-session-atlas: 自動で送れませんでした', `${message}\nschedule-upload.bat を開くと、結果と記録の場所が見られます。`).catch((e: Error) => d.log(`通知を出せませんでした: ${e.message}`));
    return { update: u, exitCode: 1 };
  };

  d.log('atlas の更新: 新しい版で動かし直します');
  const first = relaunch(update);
  if (first.done) return { update, exitCode: first.code ?? 1 };
  // 新しい版がこの PC で動かない。もっと新しい版が出るまで使わず、前の版で送る
  if (!update.fromSha || !update.toSha) return fail(`新しい版(${update.to ?? '不明'})で動かせませんでした(記録をご覧ください)`, update);
  const bad = `新しい版(${update.to})はこの PC で動かなかった`;
  d.avoid(update.toSha, bad);
  const back = d.rollback(update.fromSha);
  if (!back.ok) return fail(`${bad}ので前の版に戻そうとしましたが、${back.note}`, { ...update, outcome: 'failed', note: `${bad}。${back.note}` });
  const fallback: AutoUpdateResult = {
    outcome: 'failed',
    from: update.from,
    to: update.from,
    fromSha: update.fromSha,
    toSha: update.fromSha,
    note: `${bad}ので、${back.note}。前の版で送ります(もっと新しい版が出たら、それにします。直らなければ atlas を作っている人に知らせてください)`,
  };
  d.log(`atlas の更新: ${fallback.note}`);
  const second = relaunch(fallback);
  if (second.done) return { update: fallback, exitCode: second.code ?? 1 };
  return fail(`${bad}ので前の版に戻しましたが、前の版でも動かせませんでした(記録をご覧ください)`, fallback);
}

async function main(): Promise<void> {
  // 置き場は atlas.bat と同じ既定(out/)。依存を読む前に決める(読めなくても記録を残すため)。ATLAS_OUT は試すとき用
  const outDir = process.env.ATLAS_OUT ? resolve(process.env.ATLAS_OUT) : resolve(HERE, '..', '..', '..', 'out');
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, AUTO_LOG_FILE);
  // 記録は回ごとに書き直す。新しい版にして動かし直した側は、前の側が書いた記録(更新の経過)に続けて書く
  // (動かし直した側が終わった後に、前の側がもう一度書くことがあるので、1 行ずつ足す)
  if (process.env[UPDATED_ENV] == null) {
    try {
      writeFileSync(logPath, '');
    } catch {
      /* 記録を残せないだけ */
    }
  }
  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      /* 書けなかった行は残らないだけ */
    }
  };
  // 動かし直された側: 呼び出し元が止められたら(タスクの打ち切りなど)、こちらも止まる(残って次の回と重ならないように)
  const parent = Number(process.env[PARENT_ENV]);
  if (Number.isInteger(parent) && parent > 0)
    setInterval(() => {
      if (alive(parent)) return;
      log('呼び出し元が止められたので、止まります');
      process.exit(1);
    }, PARENT_POLL_MS).unref();
  const statusPath = join(outDir, AUTO_STATUS_FILE);
  const toast = async (title: string, body: string): Promise<void> => {
    if (process.platform !== 'win32') return;
    const sched = await import('./upload-schedule.ts');
    const r = await sched.runPowerShell(TOAST_SCRIPT, { ATLAS_TOAST_TITLE: title, ATLAS_TOAST_BODY: body });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] ?? `終了コード ${r.code}`);
  };
  // self-update.ts は node: の標準モジュールだけを使う(依存が欠けていても読める)。読めなくても、今の版のまま送る
  const su = await import('./self-update.ts').catch((e: Error) => {
    log(`atlas の更新: 更新の仕組みを読めませんでした(${e.message})`);
    return null;
  });
  const updateOpts = { repo: REPO_ROOT, log, busy: () => atlasRunning(outDir), avoid: readAvoid(outDir) };
  const first = await runUpdateFlow({
    env: process.env,
    argv: process.argv,
    log,
    startedAt: new Date().toISOString(),
    update: () => {
      if (!su) throw new Error('更新の仕組みを読めませんでした');
      return su.selfUpdate(updateOpts);
    },
    relaunch: (env) => {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...env },
      });
      return { code: r.status, stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
    },
    readStatus: () => {
      try {
        return JSON.parse(readFileSync(statusPath, 'utf8')) as AutoStatusFile;
      } catch {
        return null;
      }
    },
    writeStatus: (s) => writeStatus(statusPath, s),
    rollback: (fromSha) => (su ? su.rollback(updateOpts, fromSha) : { ok: false, note: '更新の仕組みを読めませんでした' }),
    avoid: (sha, note) => writeAvoid(outDir, sha, note),
    notify: toast,
  });
  if (first.exitCode != null) {
    process.exitCode = first.exitCode;
    return;
  }
  const notify: AutoDeps['notify'] = toast;
  let ok = false;
  try {
    const { parseCli } = await import('./args.ts');
    const { defaultConfigPath } = await import('./config.ts');
    const { resolvePaths, run: runCli } = await import('./commands.ts');
    const { runningJobIn, releaseOutLock } = await import('./jobs.ts');
    const up = await import('./upload-project.ts');
    const paths = resolvePaths({ home: null, out: outDir, judgments: null });
    // 途中で止められたとき(タスクの打ち切りなど)も、集計の作業中の印は外す(自分の印だけを消す)
    process.once('exit', () => releaseOutLock(paths.out));
    const io = { ask: async () => '', print: (l: string) => log(l), pick: async () => null };
    ok = await runAutoUpload({
      outDir,
      log,
      busy: () => runningJobIn(outDir),
      aggregate: () => up.refreshAggregate(io, { logPath: join(outDir, AUTO_AGGREGATE_LOG_FILE), run: (l) => runCli(parseCli(['all', '--out', outDir]), l) }),
      upload: (summary) => up.runUploadProject(io, { paths, configPath: defaultConfigPath(), auto: true, summary }),
      notify,
      update: first.update,
    });
  } catch (e) {
    // 依存が読めないなど、本体に入る前に止まったとき
    const message = (e as Error).message.replace(/\s+/g, ' ').trim();
    log(`送れませんでした: ${message}`);
    if ((e as Error).stack) log((e as Error).stack!);
    writeStatus(statusPath, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, error: `始められませんでした: ${message}(atlas.bat を一度開くと、足りない依存を入れます)`, sent: [], secrets: 0, root: null, update: first.update });
    await notify('agent-session-atlas: 自動で送れませんでした', `${message}\natlas.bat を一度開いてから、schedule-upload.bat で試してください。`).catch(() => {});
  }
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
