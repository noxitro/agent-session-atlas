// .bat から動かす入口(setup・upload-project・upload-schedule・upload-auto)と、その中の self-update を、TS 版と Rust 版で同じ入力から動かし、
// 窓に出す文・書いたファイル・終了コードを突き合わせる(Rust 移行の段 7 の確認用。docs/rust-migration.md)。
//
//   node scripts/parity-cli.ts [--work <dir>] [--rs <exe>] [--only setup,upload-project,upload-auto,upload-schedule] [--keep]
//
// - 一時フォルダの中だけで動かす。利用者の atlas.config.json・out/・送り先・タスク スケジューラ・通知には触れない:
//   - setup: TS 版は packages/ を一時フォルダに写したもの(リポジトリ直下 = 一時フォルダ)を動かし、Rust 版は ATLAS_REPO_ROOT で同じ形の一時フォルダを指す
//   - upload-project・upload-auto: 集計(atlas all)は動かさない(Rust 版の all は段 4-2 で移すため)。TS 版はこのファイルの --child(各ファイルの入口と同じ手順で、
//     集計だけを空の処理にしたもの)、Rust 版は環境変数 ATLAS_PARITY_SKIP_AGGREGATE=1 で動かす
//   - PowerShell(タスク スケジューラの操作・通知・フォルダを選ぶ画面)は、どちらも偽物を使う(Rust 版は環境変数 ATLAS_PARITY_FAKE_PS)。
//     呼ばれたスクリプトの種類・sha256・渡した環境変数を calls.jsonl に残し、それも比べる
//   - self-update: 一時フォルダに git のリポジトリ(origin と、TS 用・Rust 用のチェックアウト)を作り、upload-auto の更新の流れで動かす
// - 比べないもの(伏せてから比べる): 実行のたびに変わる時刻(ISO とローカルの「YYYY-MM-DD hh:mm」)、側ごとの作業フォルダのパス、
//   送り先の atlas(送った atlas の版。TS 版はこのチェックアウトの版、Rust 版は一時フォルダの版になる)、TS 版だけが記録に書くスタックトレース
// - 違って当然のもの(結果に「説明つきの差」として出す): タスクに登録するコマンド(TS 版は node と upload-auto.ts、Rust 版は atlas.exe upload-auto)と作業フォルダ
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cmpJson, firstTextDiff } from './parity-common.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const src = (f: string): string => pathToFileURL(join(ROOT, 'packages', 'cli', 'src', f)).href;

// ---------- TS 版の入口(--child)。各ファイルの末尾の起動の部分と同じ手順で、集計と PowerShell だけを差し替える ----------

/** 偽の PowerShell(Rust 版の parity_fake_power_shell と同じ動き) */
async function fakePs(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = process.env.ATLAS_PARITY_FAKE_PS!;
  const sched = await import(src('upload-schedule.ts'));
  const auto = await import(src('upload-auto.ts'));
  const kind =
    script === sched.QUERY_SCRIPT ? 'query' : script === sched.REGISTER_SCRIPT ? 'register' : script === sched.START_SCRIPT ? 'start' : script === sched.UNREGISTER_SCRIPT ? 'unregister' : script === auto.TOAST_SCRIPT ? 'toast' : 'other';
  const { createHash } = await import('node:crypto');
  const sorted = Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const { appendFileSync } = await import('node:fs');
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ kind, script: createHash('sha256').update(script).digest('hex'), env: sorted })}\n`);
  const reply = existsSync(join(dir, `${kind}.json`)) ? (JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8')) as { code?: number; stdout?: string; stderr?: string }) : {};
  return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
}

async function childUploadProject(): Promise<void> {
  const up = await import(src('upload-project.ts'));
  const { resolvePaths } = await import(src('commands.ts'));
  const { defaultConfigPath } = await import(src('config.ts'));
  const { releaseOutLock } = await import(src('jobs.ts'));
  const { taskScheduler } = await import(src('upload-schedule.ts'));
  const root = process.env.PARITY_ROOT!;
  const paths = resolvePaths({ home: null, out: join(root, 'out'), judgments: null, notesDir: join(root, 'atlas-notes') });
  const c = up.consoleIo(async () => {
    throw new Error('parity: フォルダを選ぶ画面は出しません');
  });
  process.once('exit', () => releaseOutLock(paths.out));
  try {
    if (!(await up.refreshAggregate(c.io, { logPath: up.UPLOAD_LOG, run: async () => {} }))) process.exitCode = 1;
    else {
      const sent = await up.runUploadProject(c.io, { paths, configPath: defaultConfigPath() });
      process.exitCode = 0;
      if (sent && process.platform === 'win32') {
        const task = await taskScheduler(fakePs)
          .query()
          .catch(() => null);
        if (task && !task.exists) c.io.print('  毎日決まった時刻に自動で送るなら、schedule-upload.bat で登録できます。');
      }
    }
  } catch (e) {
    c.clear();
    if (!(e instanceof up.UploadIncompleteError)) process.stderr.write(`\n止まりました: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    c.close();
  }
}

async function childUploadSchedule(): Promise<void> {
  const { consoleIo } = await import(src('upload-project.ts'));
  const { defaultConfigPath, loadConfig } = await import(src('config.ts'));
  const sched = await import(src('upload-schedule.ts'));
  const c = consoleIo(async () => null);
  try {
    await sched.runSchedule(c.io, {
      // TS 版の既定(今の node・packages/cli/src/upload-auto.ts・リポジトリ直下)を、そのまま登録する値として使う
      scheduler: sched.taskScheduler(fakePs, { cwd: process.env.PARITY_ROOT }),
      config: () => loadConfig(defaultConfigPath(), false),
      outDir: resolve(process.env.ATLAS_OUT!),
      pollMs: 10,
    });
    process.exitCode = 0;
  } catch (e) {
    c.clear();
    process.stderr.write(`\n止まりました: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    c.close();
  }
}

/** upload-auto.ts の main と同じ手順(REPO_ROOT は PARITY_REPO、集計は空の処理、通知は偽の PowerShell、動かし直すのはこのファイルの --child) */
async function childUploadAuto(args: string[]): Promise<void> {
  const files = await import(src('upload-auto-files.ts'));
  const auto = await import(src('upload-auto.ts'));
  const { appendFileSync, mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
  const outDir = resolve(process.env.ATLAS_OUT!);
  mk(outDir, { recursive: true });
  const logPath = join(outDir, files.AUTO_LOG_FILE);
  if (process.env[files.UPDATED_ENV] == null) wr(logPath, '');
  const log = (line: string): void => appendFileSync(logPath, `${line}\n`);
  const statusPath = join(outDir, files.AUTO_STATUS_FILE);
  const toast = async (title: string, body: string): Promise<void> => {
    if (process.platform !== 'win32') return;
    const r = await fakePs(auto.TOAST_SCRIPT, { ATLAS_TOAST_TITLE: title, ATLAS_TOAST_BODY: body });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] ?? `終了コード ${r.code}`);
  };
  const su = await import(src('self-update.ts'));
  const updateOpts = { repo: process.env.PARITY_REPO!, log, busy: () => auto.atlasRunning(outDir), avoid: auto.readAvoid(outDir) };
  const writeStatus = (s: unknown): void => {
    wr(`${statusPath}.${process.pid}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
    const { renameSync } = require_('node:fs');
    renameSync(`${statusPath}.${process.pid}.tmp`, statusPath);
  };
  const first = await auto.runUpdateFlow({
    env: process.env,
    argv: ['node', 'upload-auto.ts', ...args],
    log,
    startedAt: new Date().toISOString(),
    update: () => su.selfUpdate(updateOpts),
    relaunch: (env: Record<string, string>) => {
      const r = spawnSync(process.execPath, [SELF, '--child', 'upload-auto', ...args], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
      return { code: r.status, stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
    },
    readStatus: () => {
      try {
        return JSON.parse(readFileSync(statusPath, 'utf8'));
      } catch {
        return null;
      }
    },
    writeStatus,
    rollback: (fromSha: string) => su.rollback(updateOpts, fromSha),
    avoid: (sha: string, note: string) => auto.writeAvoid(outDir, sha, note),
    notify: toast,
  });
  if (first.exitCode != null) {
    process.exitCode = first.exitCode;
    return;
  }
  const { defaultConfigPath } = await import(src('config.ts'));
  const { resolvePaths } = await import(src('commands.ts'));
  const { runningJobIn, releaseOutLock } = await import(src('jobs.ts'));
  const up = await import(src('upload-project.ts'));
  // TS 版の入口と同じく、メモとタスクタグの置き場はリポジトリ直下の atlas-notes/
  const paths = resolvePaths({ home: null, out: outDir, judgments: null, notesDir: join(process.env.PARITY_REPO!, 'atlas-notes') });
  process.once('exit', () => releaseOutLock(paths.out));
  const io = { ask: async () => '', print: (l: string) => log(l), pick: async () => null };
  const ok = await auto.runAutoUpload({
    outDir,
    log,
    busy: () => runningJobIn(outDir),
    aggregate: () => up.refreshAggregate(io, { logPath: join(outDir, files.AUTO_AGGREGATE_LOG_FILE), run: async () => {} }),
    upload: (summary: unknown) => up.runUploadProject(io, { paths, configPath: defaultConfigPath(), auto: true, summary }),
    notify: toast,
    update: first.update,
  });
  process.exitCode = ok ? 0 : 1;
}

/** ESM の中から node: の組み込みを同期で読む */
function require_(m: string): typeof import('node:fs') {
  return process.getBuiltinModule(m) as typeof import('node:fs');
}

const argv = process.argv.slice(2);
if (argv[0] === '--child') {
  const [, name, ...rest] = argv;
  if (name === 'upload-project') await childUploadProject();
  else if (name === 'upload-schedule') await childUploadSchedule();
  else if (name === 'upload-auto') await childUploadAuto(rest);
  else throw new Error(`不明な --child: ${name}`);
} else {
  await driver();
}

// ---------- 突き合わせ ----------

async function driver(): Promise<void> {
  const { values } = parseArgs({ options: { work: { type: 'string' }, rs: { type: 'string' }, only: { type: 'string' }, keep: { type: 'boolean', default: false } } });
  const exe = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
  const rsCli = values.rs ? resolve(values.rs) : [join(ROOT, 'target', 'debug', exe), join(ROOT, 'target', 'release', exe)].find((p) => existsSync(p));
  if (!rsCli || !existsSync(rsCli)) {
    console.error('Rust 版の atlas が見つかりません(cargo build -p atlas-cli を先に実行してください。--rs で場所を指定できます)');
    process.exit(2);
  }
  const work = resolve(values.work ?? join(tmpdir(), `atlas-parity-cli-${process.pid}`));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const only = values.only ? new Set(values.only.split(',')) : null;
  const results: { name: string; diffs: string[]; explained: string[] }[] = [];
  const want = (n: string): boolean => !only || only.has(n);

  // この PC の git の設定(フックや署名など)を使わない
  const gitCfg = join(work, 'gitconfig');
  writeFileSync(gitCfg, '');
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const k of ['ATLAS_CONFIG', 'ATLAS_OUT', 'ATLAS_COPILOT_HOME', 'ATLAS_REPO_ROOT', 'ATLAS_AUTO_UPDATED', 'ATLAS_AUTO_PARENT_PID', 'ATLAS_SERVE_JOB', 'ATLAS_PARITY_FAKE_PS', 'ATLAS_PARITY_SKIP_AGGREGATE']) delete baseEnv[k];

  interface Ran {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Ran => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, input, timeout: 300_000, maxBuffer: 1 << 26 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `\n[spawn] ${r.error.message}` : '') };
  };
  /** 側ごとのパスと時刻を伏せる(JSON の中の \\ で書いたパスも) */
  const masker =
    (pairs: [string, string][]) =>
    (s: string): string => {
      let t = s;
      for (const [from, to] of pairs) {
        for (const f of [from, from.replace(/\\/g, '\\\\'), from.replace(/\\/g, '/')]) t = t.split(f).join(to);
      }
      return t
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, '<ISO>')
        .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<LT>')
        .replace(/\r\n/g, '\n');
    };
  const cmpText = (label: string, a: string, b: string, diffs: string[]): void => {
    if (a !== b) diffs.push(`${label}: ${firstTextDiff(a, b)}`);
  };
  const IGNORE = new Set(['atlas', 'uploadedAt', 'sentAt', 'startedAt', 'finishedAt', 'at', 'generatedAt']);
  /** フォルダの中のファイルを比べる(JSON は値として、ほかは文字列として) */
  const cmpTree = (label: string, a: string, b: string, ma: (s: string) => string, mb: (s: string) => string, diffs: string[]): void => {
    const list = (d: string): string[] => {
      if (!existsSync(d)) return [];
      const out: string[] = [];
      const walk = (x: string): void => {
        for (const e of readdirSync(x, { withFileTypes: true })) {
          const p = join(x, e.name);
          if (e.isDirectory()) {
            out.push(`${relative(d, p).replace(/\\/g, '/')}/`);
            walk(p);
          } else out.push(relative(d, p).replace(/\\/g, '/'));
        }
      };
      walk(d);
      return out.sort();
    };
    const la = list(a);
    const lb = list(b);
    if (la.join('\n') !== lb.join('\n')) diffs.push(`${label}: ファイルの並びが違う\n      TS:   ${la.join(', ')}\n      Rust: ${lb.join(', ')}`);
    for (const f of la.filter((x) => !x.endsWith('/') && lb.includes(x))) {
      const ta = ma(readFileSync(join(a, f), 'utf8'));
      const tb = mb(readFileSync(join(b, f), 'utf8'));
      if (f.endsWith('.json') || f.endsWith('.jsonl')) {
        const parse = (t: string): unknown => (f.endsWith('.jsonl') ? t.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(t));
        const d: string[] = [];
        cmpJson(parse(ta), parse(tb), `${label}/${f}`, d, { maxDiffs: 20, ignoreKeys: IGNORE });
        diffs.push(...d);
        // 書き方(字下げと末尾の改行)も同じか
        if (!f.endsWith('.jsonl') && ta.endsWith('\n') !== tb.endsWith('\n')) diffs.push(`${label}/${f}: 末尾の改行が違う`);
      } else cmpText(`${label}/${f}`, ta, tb, diffs);
    }
  };
  const junction = (target: string, at: string): void => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  };

  /** TS 版を一時フォルダで動かすための、packages/ の写し(リポジトリ直下 = dir) */
  const tsRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    for (const p of ['cli', 'core', 'report', 'judge']) {
      cpSync(join(ROOT, 'packages', p), join(dir, 'packages', p), { recursive: true, filter: (s) => !/[\\/](node_modules|dist|test)([\\/]|$)/.test(relative(ROOT, s)) });
      if (existsSync(join(ROOT, 'packages', p, 'node_modules'))) junction(join(ROOT, 'packages', p, 'node_modules'), join(dir, 'packages', p, 'node_modules'));
    }
    cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    junction(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    // atlas.bat があるフォルダを Rust 版はリポジトリ直下とみなす(ATLAS_REPO_ROOT で指すので無くてよいが、形をそろえる)
    writeFileSync(join(dir, 'atlas.bat'), '');
  };

  // ---------- setup ----------
  if (want('setup')) {
    const diffs: string[] = [];
    const common = join(work, 'setup-common');
    const home = join(common, '.copilot');
    mkdirSync(join(home, 'skills', 'wiki-query'), { recursive: true });
    mkdirSync(join(home, 'skills', 'other'), { recursive: true });
    mkdirSync(join(home, 'installed-plugins', 'm', 'p', 'skills', 'llm-wiki-ingest'), { recursive: true });
    const vault = join(common, 'my vault');
    mkdirSync(join(vault, 'wiki'), { recursive: true });
    writeFileSync(join(vault, 'index.md'), '# index');
    const bare = join(common, 'bare vault');
    mkdirSync(bare, { recursive: true });
    const logs = join(common, 'atlas logs');
    mkdirSync(logs, { recursive: true });
    const ts = join(work, 'setup-ts');
    const rs = join(work, 'setup-rs');
    tsRepo(ts);
    mkdirSync(rs, { recursive: true });
    writeFileSync(join(rs, 'atlas.bat'), '');
    const cases: { name: string; before: string | null; answers: string[]; env?: Record<string, string>; eof?: boolean }[] = [
      { name: 'new', before: null, answers: [`"${vault}"`, '', 'y', 'my-wiki-skill', `${bare}\\`, 'README.md, home.md', 'notes', '', '', '', '設計 / 実装 / テスト', join(common, 'none'), 'relative', `"${logs}\\"`, ''] },
      { name: 'keep', before: JSON.stringify({ wikis: [{ path: 'old', pages: ['wiki'] }, '~/notes'], phases: ['a', 'b'], uploadRoot: common, uploadProjects: ['owner/app'] }), answers: ['', '1つだけ', 'x / x', 'x / y', '', ''] },
      { name: 'change-wikis', before: JSON.stringify({ wikis: ['old'] }), answers: ['n', 'work/notes', '', '', '', '', '', '', 'n'] },
      { name: 'broken', before: '{ 壊れた', answers: ['', '', '', ''], env: { ATLAS_CONFIG: join(common, 'other.json') } },
      { name: 'eof', before: null, answers: ['', ''], eof: true },
      { name: 'decline', before: null, answers: ['', '', '', 'n'] },
    ];
    const explainedSetup = new Set<string>();
    for (const c of cases) {
      const sides = [
        { side: 'ts', dir: ts, cmd: process.execPath, args: [join(ts, 'packages', 'cli', 'src', 'setup.ts')] },
        { side: 'rs', dir: rs, cmd: rsCli, args: ['setup'] },
      ] as const;
      const outs: Ran[] = [];
      for (const s of sides) {
        const cfg = join(s.dir, 'atlas.config.json');
        rmSync(cfg, { force: true });
        rmSync(`${cfg}.bak`, { force: true });
        if (c.before != null) writeFileSync(cfg, c.before);
        const env = { ...baseEnv, ATLAS_COPILOT_HOME: home, ATLAS_REPO_ROOT: s.dir, ...(c.env ?? {}) };
        outs.push(run(s.cmd, s.args, env, `${c.answers.join('\n')}\n`));
      }
      // 壊れた JSON の理由の文は、JSON を読む部品(V8 と serde_json)の文なので違って当然。そこだけ伏せる
      const jsonWhy = (m: (s: string) => string) => (s: string): string => {
        const t = m(s);
        const r = t.replace(/(を読めません: )[^\n]*?(\)。作り直します)/g, '$1<JSON の誤り>$2');
        if (r !== t) explainedSetup.add(`setup/${c.name}: 壊れた JSON の理由の文(V8 と serde_json で違う)`);
        return r;
      };
      const ma = jsonWhy(masker([[ts, '<REPO>']]));
      const mb = jsonWhy(masker([[rs, '<REPO>']]));
      if (outs[0]!.status !== outs[1]!.status) diffs.push(`setup/${c.name}: 終了コード ${outs[0]!.status} ≠ ${outs[1]!.status}`);
      cmpText(`setup/${c.name}/stdout`, ma(outs[0]!.stdout), mb(outs[1]!.stdout), diffs);
      cmpText(`setup/${c.name}/stderr`, ma(outs[0]!.stderr), mb(outs[1]!.stderr), diffs);
      for (const f of ['atlas.config.json', 'atlas.config.json.bak']) {
        const a = existsSync(join(ts, f)) ? readFileSync(join(ts, f), 'utf8') : '(無い)';
        const b = existsSync(join(rs, f)) ? readFileSync(join(rs, f), 'utf8') : '(無い)';
        cmpText(`setup/${c.name}/${f}`, a, b, diffs);
      }
    }
    results.push({ name: `setup(${cases.length} 通り)`, diffs, explained: [...explainedSetup] });
  }

  /** 送るものの元(sessions.json と snapshot/ と atlas-notes/)。両方の側から読むだけなので、ジャンクションで共有する */
  const uploadCommon = join(work, 'upload-common');
  const makeUploadCommon = (): void => {
    if (existsSync(uploadCommon)) return;
    const snap = join(uploadCommon, 'snapshot');
    const sessions = [
      { id: 's1', project: 'owner/app', projectSource: 'git-remote', empty: false, name: 'ログイン画面の修正', updatedAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-10-31T00:00:00.000Z' },
      { id: 's2', project: 'owner/app', empty: false, firstUserMessage: 'テストを | 直して', updatedAt: '2026-11-03T00:00:00.000Z' },
      { id: 's3', project: 'owner/app', empty: true, updatedAt: '2026-11-04T00:00:00.000Z' },
      { id: 's4', project: 'X:\\work\\tool', empty: false, updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 's5', project: '新しいプロジェクト', empty: false, updatedAt: '2026-11-05T00:00:00.000Z' },
      { id: 's6', project: '新しいプロジェクト', empty: false, updatedAt: '2026-11-06T00:00:00.000Z' },
    ];
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(uploadCommon, 'sessions.json'), JSON.stringify({ sessions }));
    const fake = ['ghp', 'PARITYFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFA'].join('_');
    for (const s of sessions) {
      if (s.id === 's6') continue; // ログのフォルダが無い(DB にだけ記録があるもの)
      const d = join(snap, 'session-state', s.id);
      mkdirSync(join(d, 'files'), { recursive: true });
      writeFileSync(join(d, 'events.jsonl'), `{"id":"${s.id}"}\n${s.id === 's4' ? `{"data":"${fake}"}\n` : ''}`);
      writeFileSync(join(d, '.session.db.src'), '1:2');
      writeFileSync(join(d, 'files', 'a.txt'), `a-${s.id}`);
      writeFileSync(join(d, 'session.db'), Buffer.from([0, 1, 2, 3]));
    }
    mkdirSync(join(snap, 'session-state', 's1', 'checkpoints'), { recursive: true });
    writeFileSync(join(snap, 'snapshot-manifest.json'), JSON.stringify({ createdAt: '2026-11-08T01:02:03.000Z', installed: { skills: ['wiki-query'], plugins: [], disabledSkills: [], warnings: [] } }));
    // session-store.db(s1 と s2 の行)
    const dbPath = join(snap, 'session-store.db');
    execFileSync(process.execPath, [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec("CREATE TABLE sessions(id TEXT, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);CREATE TABLE turns(session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);CREATE TABLE schema_version(version INTEGER);INSERT INTO schema_version VALUES(3);INSERT INTO sessions VALUES('s1','C:/w/app','owner/app','github','main','要約',NULL,'2026-11-01T00:00:00.000Z');INSERT INTO turns VALUES('s1',0,'依頼 ${fake}','応答','2026-11-01T00:00:00.000Z');INSERT INTO turns VALUES('s2',0,'依頼 2',NULL,NULL);");d.close();`,
      dbPath,
    ]);
    const notes = join(uploadCommon, 'atlas-notes');
    mkdirSync(join(notes, 'memos', 's1', 'sub'), { recursive: true });
    writeFileSync(join(notes, 'memos', 's1.md'), '# メモ\n\n![図](s1/a.png) と ![別](./s1/b.png)\n');
    writeFileSync(join(notes, 'memos', 's1', 'a.png'), 'png');
    writeFileSync(join(notes, 'memos', 's1', 'b.png'), 'png2');
    writeFileSync(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'Player-Weapon', note: '武器', ids: ['s1', 's4'] }, { name: '調査', note: '', ids: ['s1'] }] }));
  };
  /** 側ごとのフォルダ(リポジトリ直下の形: out/・atlas-notes/・送り先 logs/・設定・偽の PowerShell) */
  const uploadSide = (dir: string, config: unknown, query: unknown): void => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'out'), { recursive: true });
    cpSync(join(uploadCommon, 'sessions.json'), join(dir, 'out', 'sessions.json'));
    junction(join(uploadCommon, 'snapshot'), join(dir, 'out', 'snapshot'));
    junction(join(uploadCommon, 'atlas-notes'), join(dir, 'atlas-notes'));
    mkdirSync(join(dir, 'logs'), { recursive: true });
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    mkdirSync(join(dir, 'ps'), { recursive: true });
    writeFileSync(join(dir, 'atlas.bat'), '');
    const json = JSON.stringify(config).replace(/<LOGS>/g, JSON.stringify(join(dir, 'logs')).slice(1, -1));
    if (config != null) writeFileSync(join(dir, 'atlas.config.json'), json);
    writeFileSync(join(dir, 'ps', 'query.json'), JSON.stringify(query));
  };
  const sideEnv = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...baseEnv,
    PARITY_ROOT: dir,
    ATLAS_REPO_ROOT: dir,
    ATLAS_CONFIG: join(dir, 'atlas.config.json'),
    ATLAS_PARITY_FAKE_PS: join(dir, 'ps'),
    ATLAS_PARITY_SKIP_AGGREGATE: '1',
    TEMP: join(dir, 'tmp'),
    TMP: join(dir, 'tmp'),
    ...extra,
  });
  const notRegistered = { code: 0, stdout: '{"exists":false}' };

  // ---------- upload-project ----------
  if (want('upload-project')) {
    makeUploadCommon();
    const diffs: string[] = [];
    const ts = join(work, 'up-ts');
    const rs = join(work, 'up-rs');
    // runs: 同じ側で続けて動かす(2 回目は変わったものだけを送る、など)
    const cases: { name: string; config: unknown; runs: string[][]; prepare?: (dir: string) => void }[] = [
      { name: 'marked', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app', '消えたプロジェクト'] }, runs: [['y'], ['y'], ['n', '', '']] },
      { name: 'numbers', config: { uploadRoot: '<LOGS>' }, runs: [['9', '3-1', '1 2', 'y'], ['1-3', '']] },
      { name: 'quit', config: { uploadRoot: '<LOGS>' }, runs: [[''], ['2', '']] },
      { name: 'incomplete', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app', 'X:\\work\\tool'] }, runs: [['y']], prepare: (d) => writeFileSync(join(d, 'logs', 'owner_app'), 'ファイル') },
      { name: 'busy', config: { uploadRoot: '<LOGS>' }, runs: [['1', 'y']], prepare: (d) => writeFileSync(join(d, 'out', '.job.json'), JSON.stringify({ pid: process.pid, kind: 'refresh', by: 'serve' })) },
      { name: 'no-sessions', config: { uploadRoot: '<LOGS>' }, runs: [['1']], prepare: (d) => rmSync(join(d, 'out', 'sessions.json')) },
      { name: 'no-root-pick-fails', config: null, runs: [['1', 'y']] },
    ];
    const explainedUp = new Set<string>();
    for (const c of cases) {
      uploadSide(ts, c.config, notRegistered);
      uploadSide(rs, c.config, notRegistered);
      c.prepare?.(ts);
      c.prepare?.(rs);
      // OS のエラーの文(libuv の「EEXIST: file already exists, mkdir '…'」と Rust の「… (os error 183)」)は違って当然。そこだけ伏せる
      const osWhy = (m: (s: string) => string) => (s: string): string => {
        const t = m(s);
        const r = t.replace(/(送れませんでした: )(?:E[A-Z]+: [^\n]*|[^\n]*\(os error \d+\))/g, '$1<OS のエラー>');
        if (r !== t) explainedUp.add(`upload-project/${c.name}: OS のエラーの文(libuv と Rust で違う)`);
        return r;
      };
      const ma = osWhy(masker([[ts, '<SIDE>']]));
      const mb = osWhy(masker([[rs, '<SIDE>']]));
      c.runs.forEach((answers, i) => {
        const a = run(process.execPath, [SELF, '--child', 'upload-project'], sideEnv(ts), `${answers.join('\n')}\n`);
        const b = run(rsCli, ['upload-project'], sideEnv(rs), `${answers.join('\n')}\n`);
        const label = `upload-project/${c.name}#${i + 1}`;
        if (a.status !== b.status) diffs.push(`${label}: 終了コード ${a.status} ≠ ${b.status}`);
        cmpText(`${label}/stdout`, ma(a.stdout), mb(b.stdout), diffs);
        cmpText(`${label}/stderr`, ma(a.stderr), mb(b.stderr), diffs);
      });
      cmpTree(`upload-project/${c.name}/logs`, join(ts, 'logs'), join(rs, 'logs'), ma, mb, diffs);
      cmpTree(`upload-project/${c.name}/ps`, join(ts, 'ps'), join(rs, 'ps'), ma, mb, diffs);
      const cfg = (d: string, m: (s: string) => string): string => (existsSync(join(d, 'atlas.config.json')) ? m(readFileSync(join(d, 'atlas.config.json'), 'utf8')) : '(無い)');
      cmpText(`upload-project/${c.name}/atlas.config.json`, cfg(ts, ma), cfg(rs, mb), diffs);
      cmpText(`upload-project/${c.name}/集計の経過`, ma(readFileSync(join(ts, 'tmp', 'atlas-upload-project.log'), 'utf8')), mb(readFileSync(join(rs, 'tmp', 'atlas-upload-project.log'), 'utf8')), diffs);
      if (existsSync(join(rs, 'out', '.job.json')) && c.name !== 'busy') diffs.push(`upload-project/${c.name}: Rust 版が out/.job.json を残した`);
    }
    results.push({ name: `upload-project(${cases.length} 通り)`, diffs, explained: [...explainedUp] });
  }

  // ---------- upload-auto(と self-update) ----------
  if (want('upload-auto')) {
    makeUploadCommon();
    const diffs: string[] = [];
    const ts = join(work, 'auto-ts');
    const rs = join(work, 'auto-rs');
    // self-update 用の git のリポジトリ: origin と、作る人のチェックアウト(dev)と、側ごとのチェックアウト
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const gitRoot = join(work, 'git');
    const origin = join(gitRoot, 'origin.git');
    const dev = join(gitRoot, 'dev');
    const release = (file: string, text: string): string => {
      writeFileSync(join(dev, file), text);
      git(dev, 'add', '-A');
      git(dev, 'commit', '-q', '-m', `update ${file}`);
      git(dev, 'push', '-q', 'origin', 'main');
      return git(dev, 'rev-parse', 'HEAD');
    };
    mkdirSync(gitRoot, { recursive: true });
    git(gitRoot, 'init', '-q', '--bare', '-b', 'main', origin);
    git(gitRoot, 'clone', '-q', origin, dev);
    git(dev, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(dev, 'scripts'), { recursive: true });
    // 依存は揃っているものとする(npm ci は動かさない)
    writeFileSync(join(dev, 'scripts', 'deps-fresh.mjs'), 'process.exit(0);\n');
    writeFileSync(join(dev, 'a.txt'), 'first');
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '-m', 'first');
    git(dev, 'push', '-q', '-u', 'origin', 'main');
    const clone = (to: string): void => {
      rmSync(to, { recursive: true, force: true });
      git(gitRoot, 'clone', '-q', origin, to);
    };
    // expect: その場合を通ったことの目印(両方の記録にあること)
    const cases: { name: string; config: unknown; args: string[]; git?: 'latest' | 'updated' | 'dirty'; expect: string }[] = [
      { name: 'sent', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app', 'X:\\work\\tool', '新しいプロジェクト'] }, args: ['--no-update'], expect: '3 プロジェクト・4 セッションを送りました' },
      { name: 'no-marks', config: { uploadRoot: '<LOGS>' }, args: ['--no-update'], expect: 'まとめて送るプロジェクトに印がありません' },
      { name: 'no-root', config: { uploadProjects: ['owner/app'] }, args: ['--no-update'], expect: '送り先がまだ決まっていません' },
      { name: 'lost-root', config: { uploadRoot: '<LOGS>\\gone', uploadProjects: ['owner/app'] }, args: ['--no-update'], expect: '覚えている送り先が見つかりません' },
      { name: 'update-latest', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app'] }, args: [], git: 'latest', expect: 'atlas の更新: 最新です' },
      { name: 'update-relaunch', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app'] }, args: [], git: 'updated', expect: 'atlas の更新: 新しい版で動かし直します' },
      { name: 'update-dirty', config: { uploadRoot: '<LOGS>', uploadProjects: ['owner/app'] }, args: [], git: 'dirty', expect: '手で変えているので、更新しません' },
    ];
    for (const c of cases) {
      uploadSide(ts, c.config, notRegistered);
      uploadSide(rs, c.config, notRegistered);
      const repoTs = join(gitRoot, 'member-ts');
      const repoRs = join(gitRoot, 'member-rs');
      if (c.git) {
        clone(repoTs);
        clone(repoRs);
        junction(join(uploadCommon, 'atlas-notes'), join(repoTs, 'atlas-notes'));
        junction(join(uploadCommon, 'atlas-notes'), join(repoRs, 'atlas-notes'));
        if (c.git === 'updated') release('a.txt', `next-${c.name}`);
        if (c.git === 'dirty') {
          release('a.txt', `next-${c.name}`);
          writeFileSync(join(repoTs, 'a.txt'), 'local');
          writeFileSync(join(repoRs, 'a.txt'), 'local');
        }
      }
      const env = (dir: string, repo: string): NodeJS.ProcessEnv => sideEnv(dir, { ATLAS_OUT: join(dir, 'out'), PARITY_REPO: c.git ? repo : dir, ATLAS_REPO_ROOT: c.git ? repo : dir });
      const a = run(process.execPath, [SELF, '--child', 'upload-auto', ...c.args], env(ts, repoTs), '');
      const b = run(rsCli, ['upload-auto', ...c.args], env(rs, repoRs), '');
      const label = `upload-auto/${c.name}`;
      // 側ごとのパスに加えて、git のチェックアウトの場所も伏せる
      const ma = masker([[repoTs, '<REPO>'], [ts, '<SIDE>']]);
      const mb = masker([[repoRs, '<REPO>'], [rs, '<SIDE>']]);
      if (a.status !== b.status) diffs.push(`${label}: 終了コード ${a.status} ≠ ${b.status}`);
      cmpText(`${label}/stdout`, ma(a.stdout), mb(b.stdout), diffs);
      cmpText(`${label}/stderr`, ma(a.stderr), mb(b.stderr), diffs);
      // 記録: TS 版だけが書くスタックトレース(Error: … と at … の行)は除く
      const logOf = (d: string, m: (s: string) => string): string =>
        m(readFileSync(join(d, 'out', 'auto-upload.log'), 'utf8'))
          .split('\n')
          .filter((l) => !/^\s+at /.test(l) && !/^(Error|AutoUploadBlockedError): /.test(l))
          .join('\n');
      cmpText(`${label}/auto-upload.log`, logOf(ts, ma), logOf(rs, mb), diffs);
      if (!logOf(ts, ma).includes(c.expect) || !logOf(rs, mb).includes(c.expect)) diffs.push(`${label}: 記録に「${c.expect}」が無い(この場合を通っていない)`);
      for (const f of ['auto-upload.json', 'auto-update.json', 'auto-upload-aggregate.log']) {
        const pa = join(ts, 'out', f);
        const pb = join(rs, 'out', f);
        if (existsSync(pa) !== existsSync(pb)) diffs.push(`${label}/${f}: 片方にしか無い(TS ${existsSync(pa)} / Rust ${existsSync(pb)})`);
        else if (existsSync(pa)) {
          if (f.endsWith('.json')) {
            const d: string[] = [];
            cmpJson(JSON.parse(ma(readFileSync(pa, 'utf8'))), JSON.parse(mb(readFileSync(pb, 'utf8'))), `${label}/${f}`, d, { maxDiffs: 20, ignoreKeys: IGNORE });
            diffs.push(...d);
          } else cmpText(`${label}/${f}`, ma(readFileSync(pa, 'utf8')), mb(readFileSync(pb, 'utf8')), diffs);
        }
      }
      cmpTree(`${label}/logs`, join(ts, 'logs'), join(rs, 'logs'), ma, mb, diffs);
      cmpTree(`${label}/ps`, join(ts, 'ps'), join(rs, 'ps'), ma, mb, diffs);
      if (c.git) {
        const ha = git(repoTs, 'rev-parse', 'HEAD');
        const hb = git(repoRs, 'rev-parse', 'HEAD');
        if (ha !== hb) diffs.push(`${label}: 更新した後の版が違う ${ha} ≠ ${hb}`);
      }
    }
    results.push({ name: `upload-auto・self-update(${cases.length} 通り)`, diffs, explained: [] });
  }

  // ---------- upload-schedule ----------
  if (want('upload-schedule')) {
    makeUploadCommon();
    const diffs: string[] = [];
    const explained: string[] = [];
    const ts = join(work, 'sch-ts');
    const rs = join(work, 'sch-rs');
    const registered = (args: string, extra: Record<string, unknown> = {}) => ({
      code: 0,
      stdout: JSON.stringify({ exists: true, state: 'Ready', times: ['12:00', '18:00'], arguments: args, lastRun: '2026-11-12T18:00:00', lastResult: 0, nextRun: '2026-11-13T12:00:00', ...extra }),
    });
    const goodConfig = { uploadRoot: '<LOGS>', uploadProjects: ['owner/app', 'X:\\work\\tool', 'a', 'b'] };
    // 登録してあるタスクの引数は、TS 版で登録したもの(node と upload-auto.ts)の形でも、Rust 版の形でも読めること
    const tsArgs = `--headless "${process.execPath}" "${join(ROOT, 'packages', 'cli', 'src', 'upload-auto.ts')}"`;
    const cases: { name: string; config: unknown; query: unknown; answers: string[]; status?: unknown }[] = [
      { name: 'missing', config: { uploadProjects: ['owner/app'] }, query: notRegistered, answers: [] },
      { name: 'register', config: goodConfig, query: notRegistered, answers: ['25:00', '12:00,18:00、7時', ''] },
      { name: 'register-default', config: goodConfig, query: notRegistered, answers: ['', ''] },
      { name: 'register-cancel', config: goodConfig, query: notRegistered, answers: ['n'] },
      { name: 'change-times', config: goodConfig, query: registered(tsArgs), answers: ['t', ''], status: { startedAt: '2026-11-12T09:00:00.000Z', finishedAt: '2026-11-12T09:01:00.000Z', ok: true, error: null, sent: [{ name: 'owner/app', sessions: 3, unchanged: 1 }], secrets: 2, root: 'R', update: { outcome: 'skipped', from: 'aaaaaaa', to: null, note: '手で変えているので、更新しません' } } },
      { name: 'toggle-update', config: goodConfig, query: registered(`${tsArgs} --no-update`, { state: 'Disabled', nextRun: null }), answers: ['u'] },
      { name: 'gone-exe', config: goodConfig, query: registered('--headless "C:\\nowhere\\atlas.exe" upload-auto', { lastRun: null }), answers: ['d'] },
      { name: 'last-run-no-status', config: goodConfig, query: registered(tsArgs, { times: null }), answers: ['u'] },
      { name: 'failed-status', config: goodConfig, query: registered(tsArgs), answers: [''], status: { startedAt: '2026-11-12T09:00:00.000Z', finishedAt: '2026-11-12T09:01:00.000Z', ok: false, error: '集計に失敗しました', sent: [], secrets: 0, root: null, update: null } },
      { name: 'query-fails', config: goodConfig, query: { code: 1, stderr: '#< CLIXML\r\n<Objs><S S="Error">アクセスが拒否されました。_x000D__x000A_</S></Objs>' }, answers: [] },
    ];
    for (const c of cases) {
      uploadSide(ts, c.config, c.query);
      uploadSide(rs, c.config, c.query);
      if (c.status) {
        writeFileSync(join(ts, 'out', 'auto-upload.json'), JSON.stringify(c.status));
        writeFileSync(join(rs, 'out', 'auto-upload.json'), JSON.stringify(c.status));
      }
      const a = run(process.execPath, [SELF, '--child', 'upload-schedule'], sideEnv(ts, { ATLAS_OUT: join(ts, 'out') }), `${c.answers.join('\n')}\n`);
      const b = run(rsCli, ['upload-schedule'], sideEnv(rs, { ATLAS_OUT: join(rs, 'out') }), `${c.answers.join('\n')}\n`);
      const label = `upload-schedule/${c.name}`;
      const ma = masker([[ts, '<SIDE>']]);
      const mb = masker([[rs, '<SIDE>']]);
      if (a.status !== b.status) diffs.push(`${label}: 終了コード ${a.status} ≠ ${b.status}`);
      cmpText(`${label}/stdout`, ma(a.stdout), mb(b.stdout), diffs);
      cmpText(`${label}/stderr`, ma(a.stderr), mb(b.stderr), diffs);
      // 登録に渡す値: タスクが動かすコマンドだけは違って当然(TS 版は node と upload-auto.ts、Rust 版は atlas.exe upload-auto)。そこをそろえてから比べる
      const calls = (d: string, m: (s: string) => string): { kind: string; script: string; env: Record<string, string> }[] =>
        existsSync(join(d, 'ps', 'calls.jsonl'))
          ? m(readFileSync(join(d, 'ps', 'calls.jsonl'), 'utf8'))
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : [];
      const ca = calls(ts, ma);
      const cb = calls(rs, mb);
      for (const [i, x] of ca.entries()) {
        const y = cb[i];
        if (x.kind === 'register' && y?.kind === 'register') {
          explained.push(`${label}: 登録するコマンド TS「${x.env.ATLAS_TASK_ARGS}」/ Rust「${y.env.ATLAS_TASK_ARGS}」`);
          const norm = (s: string): string => s.replace(/^--headless "[^"]+"( "[^"]+")?( upload-auto)?/, '--headless "<EXE>" <ENTRY>');
          x.env.ATLAS_TASK_ARGS = norm(x.env.ATLAS_TASK_ARGS!);
          y.env.ATLAS_TASK_ARGS = norm(y.env.ATLAS_TASK_ARGS!);
        }
      }
      const d: string[] = [];
      cmpJson(ca, cb, `${label}/calls`, d, { maxDiffs: 20 });
      diffs.push(...d);
    }
    results.push({ name: `upload-schedule(${cases.length} 通り)`, diffs, explained });
  }

  // ---------- 結果 ----------
  let bad = 0;
  for (const r of results) {
    console.log(`${r.diffs.length ? '✗' : '✓'} ${r.name}: 差 ${r.diffs.length} 件`);
    for (const d of r.diffs.slice(0, 40)) console.log(`    ${d}`);
    if (r.explained.length) {
      console.log(`    説明つきの差 ${r.explained.length} 件:`);
      for (const e of [...new Set(r.explained)].slice(0, 3)) console.log(`      ${e}`);
    }
    bad += r.diffs.length;
  }
  if (!values.keep) rmSync(work, { recursive: true, force: true });
  else console.log(`作業フォルダ: ${work}`);
  process.exitCode = bad ? 1 : 0;
}
