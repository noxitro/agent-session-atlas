// 自動で送る(schedule-upload.bat で登録したタスクが、毎日決まった時刻に窓を出さずに動かす)。
// 集計し直してから、画面で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先へ尋ねずに送る(upload-project.bat の y まで進めたのと同じ)。
// 窓が無いので、経過は out/auto-upload.log に、結果は out/auto-upload.json に書き、送れなかったときは Windows の通知で知らせる。
// 依存が欠けていても(npm install の前など)記録と通知が残るよう、ここで読むのは node: の標準モジュールだけにし、ほかは動かすときに読む
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_AGGREGATE_LOG_FILE, AUTO_LOG_FILE, AUTO_STATUS_FILE, type AutoStatusFile } from './upload-auto-files.ts';

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
}

/** 自動で送る本体。送れたら true */
export async function runAutoUpload(d: AutoDeps): Promise<boolean> {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const statusPath = join(d.outDir, AUTO_STATUS_FILE);
  const status: AutoStatusFile = { startedAt: now().toISOString(), finishedAt: null, ok: false, error: null, sent: [], secrets: 0, root: null };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 置き場は atlas.bat と同じ既定(out/)。依存を読む前に決める(読めなくても記録を残すため)。ATLAS_OUT は試すとき用
  const outDir = process.env.ATLAS_OUT ? resolve(process.env.ATLAS_OUT) : resolve(HERE, '..', '..', '..', 'out');
  mkdirSync(outDir, { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(join(outDir, AUTO_LOG_FILE), 'w');
  } catch {
    /* 記録を残せないだけ */
  }
  const log = (line: string): void => {
    if (fd == null) return;
    try {
      writeSync(fd, `${line}\n`);
    } catch {
      /* 書けなかった行は残らないだけ */
    }
  };
  let notify: AutoDeps['notify'] = async () => {};
  let ok = false;
  try {
    const sched = await import('./upload-schedule.ts');
    notify = async (title, body) => {
      if (process.platform !== 'win32') return;
      const r = await sched.runPowerShell(TOAST_SCRIPT, { ATLAS_TOAST_TITLE: title, ATLAS_TOAST_BODY: body });
      if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] ?? `終了コード ${r.code}`);
    };
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
    });
  } catch (e) {
    // 依存が読めないなど、本体に入る前に止まったとき
    const message = (e as Error).message.replace(/\s+/g, ' ').trim();
    log(`送れませんでした: ${message}`);
    if ((e as Error).stack) log((e as Error).stack!);
    writeStatus(join(outDir, AUTO_STATUS_FILE), { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, error: `始められませんでした: ${message}(atlas.bat を一度開くと、足りない依存を入れます)`, sent: [], secrets: 0, root: null });
    await notify('agent-session-atlas: 自動で送れませんでした', `${message}\natlas.bat を一度開いてから、schedule-upload.bat で試してください。`).catch(() => {});
  } finally {
    if (fd != null) closeSync(fd);
  }
  process.exitCode = ok ? 0 : 1;
}
