// 生成した fixture(.fixtures/copilot-home)から「~/.copilot と同じ形」の作業ディレクトリを組み立てる。
// .fixtures/ は e2e/global-setup.ts が scripts/synthetic-fixtures.ts で毎回作り直す(架空の値だけ。git には入れない)。
// session-store.db は別プロセスの書き手が WAL モード(自動チェックポイント無効)で作る。
// → 実環境と同じく本体 + -wal + -shm が並び、行は WAL にだけある状態になる。
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { appendFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWritable, type Database } from '../packages/core/src/sqlite.ts';
import { FIXTURES_DIR } from '../scripts/synthetic-fixtures.ts';
import type { ServeHandle, ServeOptions } from '../packages/cli/src/serve.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 生成した fixture のデータ(.fixtures/) */
export const FIXTURES = FIXTURES_DIR;
/** テスト用のコード(偽の copilot)。データは置かない */
export const FIXTURE_CODE = join(ROOT, 'fixtures');
/** fixture の vault(架空)の指定 */
export const FIXTURE_WIKIS = [{ path: 'synthetic-wiki', pages: ['wiki'], skills: ['wiki-query'] }];

const SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), turn_index INTEGER NOT NULL,
  user_message TEXT, assistant_response TEXT, timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index));
CREATE TABLE session_files (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), file_path TEXT NOT NULL,
  tool_name TEXT, turn_index INTEGER, first_seen_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, file_path));
CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
  parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
  time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT,
  finish_reason TEXT, content_filter_triggered INTEGER, token_details_json TEXT, created_at TEXT DEFAULT (datetime('now')),
  output_ttft_ms REAL, copilot_usage_model TEXT);
`;

export interface FixtureStore {
  sessions: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  assistant_usage_events: Record<string, unknown>[];
  session_files: Record<string, unknown>[];
}

export async function readFixtureStore(): Promise<FixtureStore> {
  return JSON.parse(await readFile(join(FIXTURES, 'copilot-home', 'session-store.json'), 'utf8')) as FixtureStore;
}

function insertAll(db: Database, table: string, rows: Record<string, unknown>[]): void {
  for (const r of rows) {
    const cols = Object.keys(r).filter((k) => k !== 'id' || table === 'sessions');
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    stmt.run(...cols.map((c) => r[c] as never));
  }
}

/** 書き手: WAL モードで作って行を入れ、接続を開いたままにする(自動チェックポイント無効 → 行は WAL にだけある) */
export async function populateStore(dbPath: string): Promise<Database> {
  const store = await readFixtureStore();
  const writer = await openWritable(dbPath);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  writer.exec(SCHEMA);
  writer.exec('INSERT INTO schema_version VALUES (8)');
  insertAll(writer, 'sessions', store.sessions);
  insertAll(writer, 'turns', store.turns);
  insertAll(writer, 'assistant_usage_events', store.assistant_usage_events);
  insertAll(writer, 'session_files', store.session_files);
  return writer;
}

/**
 * dest に fixture の ~/.copilot を作る。session-store.db の書き手は別プロセスで動かす。
 * - writer: 'crashed'(既定): 書き手を強制終了し、本体 + -wal + -shm が残った状態にする。
 *   実環境の ~/.copilot はこの状態で、ここを読み取り専用で開くと SQLite が WAL インデックスを作り直して
 *   -shm を書く(mtime が変わる)ことを確認済み。
 * - writer: 'alive': 書き手が接続を開いたまま(Copilot 実行中に相当)。
 */
export async function buildFixtureHome(
  dest: string,
  opts: { writer?: 'crashed' | 'alive'; phase11?: boolean; phase12?: boolean } = {},
): Promise<{ home: string; close: () => Promise<void> }> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(join(FIXTURES, 'copilot-home', 'session-state'), join(dest, 'session-state'), { recursive: true });
  if (opts.phase11) await addPhase11Fixtures(dest);
  if (opts.phase12) await addPhase12Fixtures(dest);
  const child = spawn(process.execPath, [THIS_FILE, '--writer', join(dest, 'session-store.db')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  await new Promise<void>((resolveReady, reject) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      if (buf.includes('ready')) resolveReady();
    });
    child.on('exit', (code) => reject(new Error(`fixture の書き手が起動前に終了した (code ${code})`)));
  });
  if ((opts.writer ?? 'crashed') === 'crashed') {
    child.kill('SIGKILL');
    await exited;
    return { home: dest, close: async () => {} };
  }
  return {
    home: dest,
    close: async () => {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new Error(`fixture の書き手が異常終了した (code ${code})`);
    },
  };
}

/** Phase 11 の fixture で使う「資格情報らしい合成値」。out/ のどこにも出てはいけない */
/** トークンの形の合成値をソースに直書きしない(公開リポジトリの秘密情報検査が反応するため)。実行時に組み立てる */
const tok = (prefix: string, body: string): string => `${prefix}_${body}`;
export const FAKE_SECRETS = {
  accessToken: tok('ghp', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0001'),
  /** トークンの形でない値(redactSecrets で伏せられず、出れば必ず検出できる) */
  accessTokenPlain: 'plain-access-token-value-FAKE-71c0',
  settingsToken: tok('gho', 'SETTINGSFAKEFAKEFAKEFAKEFAKEFAKEFAKE2'),
  settingsInstructions: 'settings-instructions-text-FAKE-3b9a',
  providerKey: ['sk', 'ant', 'FAKEPROVIDERKEY0000000000000000000000'].join('-'),
  providerName: 'provider-settings-name-FAKE-5e2d',
  appStateValue: 'app-state-secret-value-FAKE-9f8e7d',
  logToken: tok('ghp', 'LOGFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0003'),
  logPlain: 'log-plain-line-FAKE-8d4c',
} as const;
/** 許可リストに無い列の値(読まないので out/ のどこにも出ない) */
export const UNLISTED_VALUES = {
  remoteConnectTarget: 'unlisted-remote-connect-target-FAKE-1a2b',
  failureEventJson: '{"unlisted":"failure-event-json-FAKE-2b3c"}',
  activityMetadata: '{"meta":"activity-metadata-json-FAKE-3c4d"}',
  setupScript: 'unlisted-setup-script-FAKE-4d5e',
  projectInstructions: 'unlisted-project-instructions-FAKE-5e6f',
  bootstrapConfig: '{"bootstrap":"workspace-bootstrap-config-FAKE-6f7a"}',
} as const;
export const P11_SESSION = fakeIdP11(1);
export const P11_SESSION_HEAVY = fakeIdP11(5);
function fakeIdP11(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * Phase 11: data.db(許可リストの列と、開いてはいけない資格情報の表)と、セッションフォルダの付随物、~/.copilot 直下のフォルダを足す。
 * data.db は WAL 無しの単一ファイルで作る(immutable で読める)
 */
export async function addPhase11Fixtures(home: string): Promise<void> {
  const db = await openWritable(join(home, 'data.db'));
  db.exec(`
CREATE TABLE accounts (id TEXT PRIMARY KEY, login TEXT, access_token TEXT, host TEXT);
CREATE TABLE settings (id INTEGER PRIMARY KEY, github_access_token TEXT, instructions TEXT);
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE model_providers (id TEXT PRIMARY KEY, name TEXT, settings_json TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, mode TEXT, model TEXT, reasoning_effort TEXT, created_at TEXT, updated_at TEXT,
  auto_approve INTEGER, permission_mode TEXT, sandbox_enabled INTEGER, enabled_experiments_json TEXT, forked_from_session_id TEXT,
  total_input_tokens INTEGER, total_output_tokens INTEGER, context_current_tokens INTEGER, context_tier TEXT, agent TEXT,
  remote_connect_target TEXT, empty_execution_failure_event_json TEXT);
CREATE TABLE session_context_usage (id INTEGER PRIMARY KEY, session_id TEXT, ts_ms INTEGER, current_tokens INTEGER, token_limit INTEGER);
CREATE TABLE session_checkpoints (session_id TEXT, event_id TEXT, commit_sha TEXT, created_at TEXT);
CREATE TABLE activity_items (id TEXT PRIMARY KEY, workspace_id TEXT, session_id TEXT, activity_type TEXT, preview TEXT, is_read INTEGER, created_at TEXT, updated_at TEXT, metadata_json TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, main_repo_path TEXT, default_branch TEXT, github_owner TEXT, github_repo TEXT, created_at TEXT, setup_script TEXT, instructions TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, branch TEXT, name TEXT, created_at TEXT, session_id TEXT, created_pr_html_url TEXT, session_bootstrap_config TEXT);
`);
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...(args as never[]));
  };
  run('INSERT INTO accounts VALUES (?,?,?,?)', 'acc-1', 'someone', `${FAKE_SECRETS.accessToken} ${FAKE_SECRETS.accessTokenPlain}`, 'github.com');
  run('INSERT INTO settings VALUES (?,?,?)', 1, FAKE_SECRETS.settingsToken, FAKE_SECRETS.settingsInstructions);
  run('INSERT INTO app_state VALUES (?,?,?)', 'secret-key', FAKE_SECRETS.appStateValue, '2026-10-01T00:00:00Z');
  run('INSERT INTO model_providers VALUES (?,?,?)', 'prov-1', FAKE_SECRETS.providerName, JSON.stringify({ apiKey: FAKE_SECRETS.providerKey }));
  run(
    'INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    P11_SESSION, 'デスクトップのセッション', 'interactive', 'claude-opus-5.5', 'high', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z',
    1, 'auto', 0, '["exp-a"]', null, 1234, 567, 4321, 'standard', 'default',
    UNLISTED_VALUES.remoteConnectTarget, UNLISTED_VALUES.failureEventJson,
  );
  run('INSERT INTO session_context_usage VALUES (?,?,?,?,?)', 1, P11_SESSION, 1760000000000, 4000, 200000);
  run('INSERT INTO session_context_usage VALUES (?,?,?,?,?)', 2, P11_SESSION, 1760000060000, 8000, 200000);
  run('INSERT INTO session_checkpoints VALUES (?,?,?,?)', P11_SESSION, 'ev-1', 'abc123def456', '2026-10-01T00:30:00Z');
  run('INSERT INTO activity_items VALUES (?,?,?,?,?,?,?,?,?)', 'act-1', 'ws-1', P11_SESSION, 'pr_created', 'PR を作成', 0, '2026-10-01T00:40:00Z', '2026-10-01T00:40:00Z', UNLISTED_VALUES.activityMetadata);
  run('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)', 'proj-1', 'synthetic-project', 'X:\\synthetic', 'main', 'someone', 'synthetic', '2026-09-01T00:00:00Z', UNLISTED_VALUES.setupScript, UNLISTED_VALUES.projectInstructions);
  run('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?)', 'ws-1', 'proj-1', 'feature/p11', 'ws-p11', '2026-10-01T00:00:00Z', P11_SESSION, 'https://example.invalid/pr/1', UNLISTED_VALUES.bootstrapConfig);
  db.close();

  // セッションフォルダの付随物と、暗号化データ・画像を含むイベント(全文記録の除外の検査用)
  const sdir = join(home, 'session-state', P11_SESSION);
  const opaque = 'QUJD'.repeat(60);
  const extraEvents = [
    { type: 'assistant.message', id: 'p11-a', parentId: null, timestamp: '2026-07-01T09:12:00.000Z', data: { messageId: 'p11-m', content: 'P11 の応答', reasoningText: 'P11 の推論 UNIQUE-P11-REASONING', reasoningBlocks: [{ type: 'text', text: '読める推論 P11' }, { type: 'enc', data: opaque }], encryptedContent: opaque, reasoningOpaque: opaque, toolRequests: [], outputTokens: 3 } },
    { type: 'session.binary_asset', id: 'p11-b', parentId: 'p11-a', timestamp: '2026-07-01T09:12:01.000Z', data: { assetId: 'p11-asset', type: 'image', mimeType: 'image/png', byteLength: 8, data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), description: 'P11 の画像' } },
  ];
  await appendFile(join(sdir, 'events.jsonl'), extraEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await mkdir(join(sdir, 'checkpoints'), { recursive: true });
  await mkdir(join(sdir, 'files'), { recursive: true });
  await mkdir(join(sdir, 'policies'), { recursive: true });
  await mkdir(join(sdir, 'rewind-snapshots', 'backups'), { recursive: true });
  await mkdir(join(sdir, 'fake-solution'), { recursive: true });
  await writeFile(join(sdir, 'plan.md'), '# 計画\n\n合成の plan.md です。\n');
  await writeFile(join(sdir, 'checkpoints', 'index.md'), '# Checkpoints\n\n- 001\n');
  await writeFile(join(sdir, 'checkpoints', '001-first.md'), '# 001 first checkpoint\n\n合成のチェックポイント本文。\n');
  await writeFile(join(sdir, 'files', 'note.txt'), 'files フォルダの合成ファイル\n');
  await writeFile(join(sdir, 'policies', 'p1.json'), '{"policy":"synthetic"}\n');
  await writeFile(join(sdir, 'rewind-snapshots', 'backups', 'big.bin'), Buffer.alloc(64 * 1024, 1));
  await writeFile(join(sdir, 'rewind-snapshots', 'index.json'), '{"backups":1}');
  await writeFile(join(sdir, 'fake-solution', 'x.txt'), 'unlisted dir');
  await writeFile(join(sdir, 'inuse.1234.lock'), '1234');
  // ~/.copilot 直下
  await mkdir(join(home, 'plans'), { recursive: true });
  await writeFile(join(home, 'plans', 'plan-synthetic.md'), '# plan\n');
  await mkdir(join(home, 'attachments'), { recursive: true });
  await writeFile(join(home, 'attachments', 'clip.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await mkdir(join(home, 'chats', '2026-10-01', 'x'), { recursive: true });
  await writeFile(join(home, 'chats', '2026-10-01', 'x', 'copilot-session-x.md'), '# Copilot CLI Session\n');
  await writeFile(join(home, 'chats', '2026-10-01', 'x', 'junk.exe'), Buffer.alloc(100, 2));
  await mkdir(join(home, 'logs'), { recursive: true });
  await writeFile(join(home, 'logs', 'github-app.1.log'), `INFO started token=${FAKE_SECRETS.logToken} ${FAKE_SECRETS.logPlain}\n`);
  // ジャンクション(Windows では権限なしで作れる。作れない環境では飛ばす): 辿らずに skipped に残ることの検査用
  try {
    await symlink(join(sdir, 'files'), join(sdir, 'linked'), 'junction');
  } catch {
    /* リンクを作れない環境 */
  }
  await mkdir(join(home, 'repos', 'copilot-worktrees', 'x'), { recursive: true });
  await writeFile(join(home, 'repos', 'copilot-worktrees', 'x', 'README.md'), '# repo\n');
}

/** Phase 12 の fixture: 似た依頼文の繰り返し(3 セッション)と、同じツールの並び(view → apply_patch → powershell → apply_patch → powershell)の繰り返し */
export const P12_SESSIONS = [1, 2, 3].map((n) => `00000000-0000-4000-8000-0000000012000${n}`);
const P12_REQUESTS = [
  'リポジトリの README を更新してください。章立ては変えないでください',
  'リポジトリの README を更新して下さい。章立ては変えないでください。',
  'リポジトリの README を更新してください。章立ては変えないで',
];
export async function addPhase12Fixtures(home: string): Promise<void> {
  const tools = ['view', 'apply_patch', 'powershell', 'apply_patch', 'powershell'];
  for (const [i, id] of P12_SESSIONS.entries()) {
    const dir = join(home, 'session-state', id);
    await mkdir(dir, { recursive: true });
    const t0 = Date.parse('2026-08-01T09:00:00.000Z') + i * 3_600_000;
    const ts = (k: number): string => new Date(t0 + k * 1000).toISOString();
    const ev: object[] = [{ type: 'session.start', id: `${id}-s`, parentId: null, timestamp: ts(0), data: { sessionId: id, version: 1, copilotVersion: '1.0.50', selectedModel: 'gpt-5.5-mini', context: { cwd: 'X:\\synthetic-p12', gitRoot: 'X:\\synthetic-p12' } } }];
    let k = 1;
    // 2 ターン: 1 つ目が繰り返しの依頼文、2 つ目は相づち(候補にしない)。どちらも同じツールの並び
    for (const [turn, req] of [P12_REQUESTS[i], 'OK'].entries()) {
      ev.push({ type: 'user.message', id: `${id}-u${turn}`, parentId: null, timestamp: ts(k++), data: { content: req } });
      ev.push({ type: 'assistant.turn_start', id: `${id}-ts${turn}`, parentId: null, timestamp: ts(k++), data: { turnId: `t${turn}` } });
      for (const [j, name] of tools.entries()) {
        const call = `call_p12_${i}_${turn}_${j}`;
        ev.push({ type: 'tool.execution_start', id: `${id}-a${turn}${j}`, parentId: null, timestamp: ts(k++), data: { toolCallId: call, toolName: name, arguments: {} } });
        ev.push({ type: 'tool.execution_complete', id: `${id}-b${turn}${j}`, parentId: null, timestamp: ts((k += 60) - 1), data: { toolCallId: call, success: true, result: { content: '(合成の結果)' } } });
      }
      ev.push({ type: 'assistant.message', id: `${id}-m${turn}`, parentId: null, timestamp: ts(k++), data: { messageId: `${id}-mm${turn}`, content: '終わりました。', toolRequests: [], outputTokens: 5 } });
      ev.push({ type: 'assistant.turn_end', id: `${id}-te${turn}`, parentId: null, timestamp: ts(k++), data: { turnId: `t${turn}` } });
    }
    await writeFile(join(dir, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await writeFile(
      join(dir, 'workspace.yaml'),
      [`id: ${id}`, 'cwd: X:\\synthetic-p12', 'git_root: X:\\synthetic-p12', 'repository: zz-owner/zz-p12', 'host_type: github', 'branch: main', 'client_name: github/cli', `name: "合成 P12 ${i + 1}"`, 'user_named: false', `created_at: ${ts(0)}`, `updated_at: ${ts(k)}`, ''].join('\n'),
    );
  }
}

// ---------- Rust 版への切り替え(docs/rust-migration.md の段 5・8) ----------
// 環境変数 ATLAS_CLI に Rust 版の atlas の実行ファイルを指定すると、e2e と画面のテストは TS 版の入口(packages/cli/src/*.ts)の代わりに
// それを動かす。サーバも別のプロセス(atlas serve)として動かし、テストが TS 版の startServe に直接渡していた設定は環境変数で渡す。

/** Rust 版の atlas の実行ファイル(無ければ TS 版を動かす) */
export const ATLAS_CLI = process.env.ATLAS_CLI || null;

/** CLI の入口。main は atlas のコマンド、ほかは TS 版では別のファイル(Rust 版ではサブコマンド) */
export type CliEntry = 'main' | 'judge-flow' | 'setup' | 'upload-project' | 'upload-schedule' | 'upload-auto';

/** CLI を動かすコマンドと引数([コマンド, 引数])。spawn / spawnSync にそのまま渡す */
export function cliCommand(args: string[], entry: CliEntry = 'main'): [string, string[]] {
  if (ATLAS_CLI) return [ATLAS_CLI, entry === 'main' ? args : [entry, ...args]];
  return [process.execPath, [join(ROOT, 'packages', 'cli', 'src', `${entry}.ts`), ...args]];
}

/**
 * サーバを起動する。ATLAS_CLI が無ければ TS 版の startServe、あれば Rust 版の atlas serve を別のプロセスで動かして、同じ形の handle を返す。
 * Rust 版で渡せないもの(ジョブの spawn・runFull の差し替え、別のフォルダを開く起動の差し替え)は渡せばエラーにする。
 * フォルダを選ぶ画面とエクスプローラーで開く操作の差し替えは、テストの側に小さなサーバを立てて Rust 版から尋ねさせる(ATLAS_TEST_HOOK_URL)
 */
export async function startServer(o: ServeOptions): Promise<ServeHandle> {
  if (!ATLAS_CLI) {
    const { startServe } = await import('../packages/cli/src/serve.ts');
    return startServe(o);
  }
  if (o.jobs?.spawn || o.jobs?.runFull || o.reports || o.home || o.m365 !== undefined || o.viewLimit !== undefined) throw new Error('startServer: Rust 版には渡せない設定です');
  if (resolve(o.groupsPath) !== resolve(join(o.notesDir, 'groups.json'))) throw new Error('startServer: Rust 版の groups.json は notesDir の直下だけです');
  const env: NodeJS.ProcessEnv = { ...process.env, ...o.jobs?.env };
  const ms = (k: string, v: number | undefined): void => {
    if (v !== undefined) env[k] = String(v);
  };
  ms('ATLAS_SERVE_IDLE_MS', o.idleMs);
  ms('ATLAS_SERVE_BYE_GRACE_MS', o.byeGraceMs);
  ms('ATLAS_SERVE_FIRST_HEARTBEAT_MS', o.firstHeartbeatMs);
  ms('ATLAS_SERVE_MEMO_IMAGE_LIMIT', o.memoImageLimit);
  if (o.codeStamp !== undefined) env.ATLAS_SERVE_CODE_STAMP = o.codeStamp ?? 'null';
  if (o.copilotHome) env.ATLAS_COPILOT_HOME = o.copilotHome;
  if (o.folders?.canPick !== undefined) env.ATLAS_SERVE_CAN_PICK = o.folders.canPick ? '1' : '0';
  let hook: Server | null = null;
  if (o.folders?.pick || o.folders?.open) {
    const f = o.folders;
    hook = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        void (async () => {
          const j = JSON.parse(body || '{}') as { title?: string; initial?: string | null; dir?: string };
          if (req.url === '/pick') {
            const path = f.pick ? await f.pick(j.title ?? '', j.initial ?? null) : null;
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path }));
          } else {
            f.open?.(j.dir ?? '');
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          }
        })().catch((e: unknown) => res.writeHead(500).end(String(e)));
      });
    });
    await new Promise<void>((ok) => hook!.listen(0, '127.0.0.1', () => ok()));
    env.ATLAS_TEST_HOOK_URL = `http://127.0.0.1:${(hook.address() as { port: number }).port}`;
  }
  // TS 版の startServe は、同じ出力先で動いているサーバがあっても起動する(atlas serve は開くだけにする)ので、その印を外してから起動する
  await rm(join(o.outDir, '.serve.json'), { force: true });
  const args = ['serve', '--out', o.outDir, '--notes-dir', o.notesDir, '--port', String(o.port ?? 0), ...(o.open === false ? ['--no-open'] : []), ...(o.configPath ? ['--config', o.configPath] : [])];
  const child = spawn(ATLAS_CLI, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = o.log ?? (() => {});
  let reason: string | null = null;
  let closing: string | null = null;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  let rest = '';
  let started!: (port: number) => void;
  let failed!: (e: Error) => void;
  const ready = new Promise<number>((ok, ng) => ((started = ok), (failed = ng)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    const lines = (rest + d).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const l of lines) {
      const m = /^serve: http:\/\/127\.0\.0\.1:(\d+)\/atlas\.html/.exec(l);
      if (m) started(Number(m[1]));
      const end = /^serve: 終了\((.*)\)$/.exec(l);
      if (end) reason = end[1];
      log(l);
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr += d));
  void exited.then(() => {
    hook?.close();
    failed(new Error(`atlas serve が起動前に終わりました: ${stderr}`));
  });
  const port = await ready;
  const url = `http://127.0.0.1:${port}/atlas.html`;
  const page = await (await fetch(url)).text();
  const token = /<meta name="atlas-token" content="([^"]*)"/.exec(page)?.[1] ?? '';
  const done = exited.then(() => closing ?? reason ?? '停止');
  return {
    port,
    url,
    token,
    done,
    async close(r = '停止') {
      if (child.exitCode !== null || closing) return void (await exited);
      closing = r;
      child.kill();
      await exited;
      // 止めたプロセスは後始末をしないので、TS 版の close と同じく .serve.json と自分の実行中の印を消す
      await rm(join(o.outDir, '.serve.json'), { force: true });
      try {
        const j = JSON.parse(await readFile(join(o.outDir, '.job.json'), 'utf8')) as { pid?: number };
        if (j.pid === child.pid) await rm(join(o.outDir, '.job.json'), { force: true });
      } catch {
        /* 印が無い */
      }
    },
  };
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[2] === '--writer' && process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  const w = await populateStore(process.argv[3]);
  process.stdout.write('ready\n');
  process.stdin.resume();
  process.stdin.on('end', () => {
    w.close();
    process.exit(0);
  });
}
