// TS 版と Rust 版の atlas serve を同じ出力先の写し 2 つで動かし、同じ要求を順に送って、応答(状態コード・見出し・本文)を突き合わせる
// (Rust 移行の段 5 の確認用。docs/rust-migration.md)。
//
//   node scripts/parity-serve.ts [--work <dir>] [--rs <exe>] [--port <TS 版のポート>] [--keep]
//
// - e2e と同じ架空の fixture を TS 版の atlas all で 1 度だけ集計し、出力先とメモの置き場を TS 用・Rust 用に写してから、
//   それぞれのサーバを --no-open と決まったポート(TS 版は --port、Rust 版はその次)で起動する。設定ファイルも側ごとに分ける。
// - 送る要求: 静的ページ(画面・詳細ページ・.md・JSON・HEAD)、/view/<id>、GET の API すべて、メモ・タスクタグ・設定の書き込み、
//   ジョブ(bundle と export。実物の子プロセス)、チャットでの判定の一覧・本文・取り込み(作った返答)、グループの書き出し、
//   失敗するもの(token なし・違う token・他のオリジン・別の Host・out/ の外・大きすぎる画像・知らない経路・使えない方法)。
// - 比べる見出し: content-type・cache-control・location・content-length・x-atlas-serve・x-atlas-code・x-content-type-options・x-frame-options・content-security-policy。
//   date・connection・keep-alive(サーバの実装ごとに違う)は比べない。
// - 伏せてから比べるもの: token・ポート・側ごとの作業フォルダのパス・時刻(ISO)・ジョブの id、ジョブのログの所要時間、判定の添付ファイルのパケットの境界(乱数)。
// - 違って当然のもの(説明つきの差として出す): JSON を読めないときの理由の文(JSON.parse と serde_json の文)。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cmpJson, firstTextDiff } from './parity-common.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const { values } = parseArgs({ options: { work: { type: 'string' }, rs: { type: 'string' }, port: { type: 'string', default: '47710' }, keep: { type: 'boolean', default: false } } });
const exe = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const rsCli = values.rs ?? [join(ROOT, 'target', 'release', exe), join(ROOT, 'target', 'debug', exe)].find((p) => existsSync(p));
if (!rsCli || !existsSync(rsCli)) {
  console.error('Rust 版の atlas が見つかりません(cargo build -p atlas-cli を先に実行してください。--rs で場所を指定できます)');
  process.exit(2);
}
const work = resolve(values.work ?? join(ROOT, 'out', 'parity-serve'));
const BASE_PORT = Number(values.port);

/** 比べる見出し */
const HEADERS = ['content-type', 'cache-control', 'location', 'content-length', 'x-atlas-serve', 'x-atlas-code', 'x-content-type-options', 'x-frame-options', 'content-security-policy'];

interface Side {
  name: 'ts' | 'rs';
  dir: string;
  out: string;
  notes: string;
  config: string;
  port: number;
  token: string;
  child: ChildProcess | null;
  agent: Agent;
  log: string[];
}

interface Res {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function send(s: Side, method: string, path: string, o: { token?: boolean | string; headers?: Record<string, string>; body?: string | Buffer; host?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}`, ...o.headers };
  if (o.token !== undefined && o.token !== false) headers['x-atlas-token'] = o.token === true ? s.token : o.token;
  const body = o.body === undefined ? undefined : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
  if (body) {
    headers['content-length'] = String(body.length);
    headers['content-type'] ??= 'application/json';
  }
  return new Promise((ok, ng) => {
    const r = request({ host: '127.0.0.1', port: s.port, method, path, headers, setHost: false, agent: s.agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
        ok({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
      });
    });
    r.on('error', ng);
    r.end(body);
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 側ごとに違う値を伏せる */
function mask(s: Side, text: string): string {
  let t = text.split(s.token).join('<TOKEN>');
  for (const p of [s.dir, s.dir.replace(/\\/g, '\\\\'), s.dir.replace(/\\/g, '/'), encodeURIComponent(s.dir)]) t = t.split(p).join('<SIDE>');
  t = t.replace(new RegExp(`(127\\.0\\.0\\.1|localhost):${s.port}`, 'g'), '$1:<PORT>');
  // 手元の通信フィルタ(AdGuard など)が HTML に書き足す script には、URL がエンコードされて入る
  t = t.split(`%3A${s.port}`).join('%3A<PORT>');
  // 判定の添付ファイルのパケットの境界(作るたびに変わる乱数)
  t = t.replace(/PACKET_(BEGIN|END) [0-9a-f]{8,}/g, 'PACKET_$1 <NONCE>');
  t = t.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TIME>');
  return t;
}

const diffs: string[] = [];
const explained: string[] = [];
let count = 0;

/** JSON を読めないときの理由の文(JSON.parse と serde_json で文が違う)。違って当然なので、説明つきの差にする */
const PARSE_ERROR = /^JSON を読めません: /;

function compare(label: string, a: Res, b: Res, ts: Side, rs: Side, o: { mapJson?: (v: unknown) => unknown } = {}): void {
  count++;
  const out: string[] = [];
  if (a.status !== b.status) out.push(`状態コード ${a.status} ≠ ${b.status}`);
  for (const h of HEADERS) {
    const x = a.headers[h] === undefined ? undefined : mask(ts, a.headers[h]);
    const y = b.headers[h] === undefined ? undefined : mask(rs, b.headers[h]);
    // content-length は TS 版が書いたとき(静的ファイル)だけ比べる。Node は writeHead の後の end では chunked で送り、Rust 版(hyper)は大きさを書く(送り方の違い)。
    // JSON は伏せた値で長さが変わるので、本文の比べ方で見る
    if (h === 'content-length' && (x === undefined || (a.headers['content-type'] ?? '').includes('json'))) continue;
    if (x !== y) out.push(`見出し ${h}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
  }
  const ta = mask(ts, a.body.toString('utf8'));
  const tb = mask(rs, b.body.toString('utf8'));
  if ((a.headers['content-type'] ?? '').includes('json') && ta && tb) {
    let ja: unknown = JSON.parse(ta);
    let jb: unknown = JSON.parse(tb);
    if (o.mapJson) {
      ja = o.mapJson(ja);
      jb = o.mapJson(jb);
    }
    const e = (ja as { error?: unknown })?.error;
    const f = (jb as { error?: unknown })?.error;
    if (typeof e === 'string' && typeof f === 'string' && PARSE_ERROR.test(e) && PARSE_ERROR.test(f) && e !== f) {
      explained.push(`${label}: JSON を読めない理由の文(TS: ${e} / Rust: ${f})`);
      (ja as { error: string }).error = (jb as { error: string }).error = '<PARSE>';
    }
    cmpJson(ja, jb, '$', out, { maxDiffs: 20 });
    // 長い文字列の差は、最初に違う場所も出す
    const xa = (ja as { text?: unknown })?.text;
    const xb = (jb as { text?: unknown })?.text;
    if (typeof xa === 'string' && typeof xb === 'string' && xa !== xb) out.push(`$.text: ${firstTextDiff(xa, xb)}`);
  } else if (ta !== tb) out.push(`本文: ${firstTextDiff(ta, tb)}`);
  if (out.length) diffs.push(`${label}\n  ${out.join('\n  ')}`);
}

async function both(label: string, method: string, path: string, o: Parameters<typeof send>[3] & { mapJson?: (v: unknown) => unknown; perSide?: (s: Side) => Parameters<typeof send>[3] } = {}): Promise<[Res, Res]> {
  const [ts, rs] = sides;
  const a = await send(ts, method, path, { ...o, ...o.perSide?.(ts) });
  const b = await send(rs, method, path, { ...o, ...o.perSide?.(rs) });
  compare(`${method} ${path}${label ? `(${label})` : ''}`, a, b, ts, rs, o);
  return [a, b];
}

function startServer(s: Side, cmd: string, args: string[]): Promise<void> {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ATLAS_COPILOT_HOME: join(work, 'home') } });
  s.child = child;
  return new Promise((ok, ng) => {
    let rest = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      const lines = (rest + d).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) {
        s.log.push(l);
        if (/^serve: http:\/\/127\.0\.0\.1:\d+\/atlas\.html/.test(l)) ok();
      }
    });
    let err = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => (err += d));
    child.once('exit', (code) => ng(new Error(`${s.name} のサーバが終わりました(${code}): ${err}`)));
  });
}

async function waitJob(s: Side): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const r = await send(s, 'GET', '/api/jobs/current', { token: true });
    if ((JSON.parse(r.body.toString()) as { state?: string } | null)?.state !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${s.name}: ジョブが終わりません`);
}

/** ジョブの記録のうち、実行ごとに変わるもの(id とログの所要時間・時刻)を伏せる */
const maskJob = (v: unknown): unknown => {
  if (!v || typeof v !== 'object') return v;
  const j = { ...(v as Record<string, unknown>) };
  if ('id' in j) j.id = '<JOB>';
  if (Array.isArray(j.log)) j.log = (j.log as string[]).map((l) => l.replace(/\d+(\.\d+)? 秒/g, '<秒>').replace(/\d+(\.\d+)? MB/g, '<MB>'));
  return j;
};

const sides: [Side, Side] = [
  { name: 'ts', dir: join(work, 'ts'), out: '', notes: '', config: '', port: BASE_PORT, token: '', child: null, agent: new Agent({ keepAlive: true, maxSockets: 1 }), log: [] },
  { name: 'rs', dir: join(work, 'rs'), out: '', notes: '', config: '', port: BASE_PORT + 1, token: '', child: null, agent: new Agent({ keepAlive: true, maxSockets: 1 }), log: [] },
];

async function main(): Promise<number> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // 架空の fixture を TS 版で 1 度だけ集計する(両方のサーバは同じ出力の写しを配る)
  const { writeFixtures } = await import('./synthetic-fixtures.ts');
  const { buildFixtureHome, FIXTURE_WIKIS } = await import('../e2e/fixture-home.ts');
  await writeFixtures();
  const { home } = await buildFixtureHome(join(work, 'home'), { phase11: true, phase12: true });
  const baseOut = join(work, 'base', 'out');
  const baseNotes = join(work, 'base', 'notes');
  const cfg = join(work, 'base', 'atlas.config.json');
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ wikis: FIXTURE_WIKIS }));
  const all = spawnSync(process.execPath, [TS_CLI, 'all', '--home', home, '--out', baseOut, '--notes-dir', baseNotes, '--config', cfg], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  if (all.status !== 0) throw new Error(`atlas all に失敗しました: ${all.stderr}`);
  for (const s of sides) {
    s.out = join(s.dir, 'out');
    s.notes = join(s.dir, 'notes');
    s.config = join(s.dir, 'atlas.config.json');
    cpSync(baseOut, s.out, { recursive: true });
    if (existsSync(baseNotes)) cpSync(baseNotes, s.notes, { recursive: true });
    writeFileSync(s.config, JSON.stringify({ wikis: FIXTURE_WIKIS }));
  }
  const [ts, rs] = sides;
  const common = (s: Side): string[] => ['serve', '--out', s.out, '--notes-dir', s.notes, '--no-open', '--port', String(s.port), '--config', s.config];
  await Promise.all([startServer(ts, process.execPath, [TS_CLI, ...common(ts)]), startServer(rs, rsCli!, common(rs))]);
  try {
    // token は画面の HTML から取る(atlas serve から開いた画面と同じ)
    for (const s of sides) s.token = /<meta name="atlas-token" content="([^"]*)"/.exec((await send(s, 'GET', '/atlas.html')).body.toString())![1];
    await run();
  } finally {
    for (const s of sides) {
      s.child?.kill();
      s.agent.destroy();
    }
  }
  console.log(`\n要求 ${count} 個を比べました(TS: ${ts.port} / Rust: ${rs.port})`);
  if (explained.length) console.log(`\n説明つきの差 ${explained.length} 件:\n  ${explained.join('\n  ')}`);
  if (diffs.length) {
    console.log(`\n差 ${diffs.length} 件:\n${diffs.join('\n')}`);
    return 1;
  }
  console.log('差はありません');
  if (!values.keep) rmSync(work, { recursive: true, force: true });
  return 0;
}

async function run(): Promise<void> {
  const [ts] = sides;
  const sessions = (JSON.parse(readFileSync(join(ts.out, 'sessions.json'), 'utf8')) as { sessions: { id: string; turns: number }[] }).sessions;
  const id = sessions.find((s) => existsSync(join(ts.out, 'sessions', `${s.id}.md`)))!.id;
  const t = { token: true } as const;
  await both('', 'POST', '/api/heartbeat', { ...t, headers: { 'x-atlas-client': 'parity', 'x-atlas-seq': '1' } });

  // ---------- 静的ファイル ----------
  for (const p of ['/', '/atlas.html', '/glossary.html', '/insights.html', '/instructions.html', `/sessions/${id}.html`, `/sessions/${id}.md`, '/sessions.json', '/metrics.json', '/coverage.json']) await both('', 'GET', p);
  for (const p of ['/atlas.html', `/sessions/${id}.md`, '/metrics.json']) await both('', 'HEAD', p);
  for (const f of readdirSync(join(ts.out, 'snapshot')).slice(0, 3)) await both('snapshot の写し', 'GET', `/snapshot/${encodeURIComponent(f)}`);
  for (const p of ['/sessions/', '/sessions', '/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/..%5C..%5Csecret.txt', '/%2E%2E%2F%2E%2E%2Fx', '/.serve.json', '/nope.html', '/%E0%A4%A', '/a%00b', '/sessions/%2e%2e/atlas.html']) await both('', 'GET', p);
  await both('POST でも静的ファイル', 'POST', '/metrics.json', { body: '{}' });

  // ---------- 記録の表示 ----------
  for (const p of [`/view/${id}?kind=transcript`, `/view/${id}`, `/view/${id}?kind=full`, '/view/x?kind=nope', '/view/..%2Fx', '/view/%E0%A4%A']) await both('', 'GET', p);
  await both('', 'HEAD', `/view/${id}?kind=transcript`);
  await both('他のオリジン', 'GET', `/view/${id}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  for (const p of [`/api/view/${id}?kind=transcript`, `/api/view/${id}?kind=full`, '/api/view/nope?kind=transcript', `/api/view/${id}?kind=raw`]) await both('', 'GET', p, t);
  await both('token なし', 'GET', `/api/view/${id}?kind=transcript`);
  await both('', 'POST', `/api/view/${id}`, t);

  // ---------- GET の API ----------
  for (const p of ['/api/state', '/api/memo-editor.js', '/api/session-tools.js', `/api/memos/${id}`]) await both('', 'GET', p);
  for (const p of ['/api/settings', '/api/folders', '/api/jobs/current', '/api/jobs/judge-preview', '/api/jobs/judge-preview?target=turns', '/api/judge/parts', '/api/judge/parts?target=turns']) {
    await both('', 'GET', p, t);
    await both('token なし', 'GET', p);
  }
  await both('違う token', 'GET', '/api/settings', { token: 'wrong' });
  await both('他のオリジン', 'GET', '/api/state', { headers: { origin: 'http://evil.example' } });
  await both('同じオリジン', 'GET', '/api/state', { perSide: (s) => ({ headers: { origin: `http://127.0.0.1:${s.port}`, 'sec-fetch-site': 'same-origin' } }) });
  await both('別の Host', 'GET', '/api/state', { perSide: (s) => ({ host: `evil.example:${s.port}` }) });
  await both('別の Host', 'GET', '/atlas.html', { host: 'evil.example' });
  await both('localhost', 'GET', '/api/state', { perSide: (s) => ({ host: `localhost:${s.port}` }) });
  for (const p of ['/api/nope', '/api/jobs/nope', '/api/judge/nope', '/api/groups/a/b/c/upload/x']) await both('', 'GET', p, t);
  await both('', 'PUT', '/api/jobs', { ...t, body: '{}' });
  await both('', 'DELETE', '/api/jobs/current', t);
  await both('', 'PATCH', '/api/groups', { ...t, body: '{}' });
  await both('', 'GET', '/api/settings/nope', t);
  await both('', 'POST', '/api/settings/nope', { ...t, body: '{}' });
  await both('', 'DELETE', '/api/settings', t);
  await both('', 'PUT', '/api/folders', { ...t, body: '{}' });
  await both('', 'POST', '/api/folders/nope', { ...t, body: '{}' });

  // ---------- メモ ----------
  const memo = `/api/memos/${id}`;
  await both('token なし', 'PUT', memo, { body: JSON.stringify({ text: 'x', rev: '' }) });
  const [saved] = await both('', 'PUT', memo, { ...t, body: JSON.stringify({ text: '# 見出し\n\n本文 **太字**', rev: '' }) });
  const rev = (JSON.parse(saved.body.toString()) as { rev: string }).rev;
  await both('古い rev', 'PUT', memo, { ...t, body: JSON.stringify({ text: '上書き', rev: '0000' }) });
  await both('', 'PUT', memo, { ...t, body: JSON.stringify({ text: '更新', rev }) });
  await both('', 'GET', memo);
  await both('text が数', 'PUT', memo, { ...t, body: JSON.stringify({ text: 1, rev: '' }) });
  await both('壊れた JSON', 'PUT', memo, { ...t, body: '{oops' });
  await both('配列', 'PUT', memo, { ...t, body: '[1]' });
  await both('', 'DELETE', memo, t);
  for (const bad of ['..%2Fsecret', 'a%2Fb', '%E0%A4%A', '.hidden', '..', '%2e%2e']) await both('', 'GET', `/api/memos/${bad}`);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await both('画像', 'POST', `${memo}/images`, { ...t, body: png, headers: { 'content-type': 'image/png' } });
  await both('画像 token なし', 'POST', `${memo}/images`, { body: png, headers: { 'content-type': 'image/png' } });
  await both('画像でない', 'POST', `${memo}/images`, { ...t, body: '<svg/>', headers: { 'content-type': 'image/svg+xml' } });
  await both('大きすぎる画像', 'POST', `${memo}/images`, { ...t, body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x89), headers: { 'content-type': 'image/png' } });
  await both('', 'GET', `${memo}/images`, t);
  await both('本文が大きすぎる', 'PUT', memo, { ...t, body: JSON.stringify({ text: 'x'.repeat(1024 * 1024), rev: '' }) });

  // ---------- タスクタグ ----------
  const g = (b: unknown) => ({ ...t, body: JSON.stringify(b) });
  await both('token なし', 'POST', '/api/groups', { body: JSON.stringify({ name: 'a', ids: [] }) });
  await both('', 'POST', '/api/groups', g({ name: ' 調査: A/B ', note: '比べる', ids: [id, id, 'gone'] }));
  await both('同じ名前', 'POST', '/api/groups', g({ name: '調査: A/B', ids: [] }));
  await both('名前なし', 'POST', '/api/groups', g({ name: '', ids: [] }));
  await both('ids が文字列', 'POST', '/api/groups', g({ name: 'b', ids: 'x' }));
  await both('名前が長い', 'POST', '/api/groups', g({ name: 'x'.repeat(101), ids: [] }));
  await both('', 'POST', '/api/groups', g({ name: 'b', ids: [] }));
  const ga = `/api/groups/${encodeURIComponent('調査: A/B')}`;
  await both('差分', 'PUT', ga, g({ add: ['y', id, 'y'], remove: ['gone'] }));
  await both('差分と全置換', 'PUT', ga, g({ add: ['q'], ids: [] }));
  await both('同じ名前に改名', 'PUT', ga, g({ name: 'b' }));
  await both('', 'PUT', '/api/groups/b', g({ name: 'c', note: ' n ' }));
  await both('無い', 'PUT', '/api/groups/zzz', g({ note: '' }));
  await both('無い', 'DELETE', '/api/groups/zzz', t);
  await both('', 'DELETE', '/api/groups/c', t);
  await both('壊れた名前', 'DELETE', '/api/groups/%E0%A4%A', t);
  await both('', 'GET', '/api/state');
  await both('書き出し token なし', 'POST', `${ga}/export`);
  await both('書き出し', 'POST', `${ga}/export`, t);
  await both('書き出し 無い', 'POST', '/api/groups/zzz/export', t);
  await both('', 'GET', `${ga}/export`, t);
  await both('アップロード先が無い', 'POST', `${ga}/upload/check`, g({}));
  await both('', 'GET', `${ga}/upload/progress`, t);
  await both('', 'GET', `${ga}/upload`, t);

  // ---------- 設定 ----------
  await both('無いフォルダ', 'PUT', '/api/upload-root', g({ root: join(rsDirless(), 'nope') }));
  await both('相対パス', 'PUT', '/api/upload-root', g({ root: 'rel' }));
  await both('', 'DELETE', '/api/upload-root', t);
  await both('project なし', 'PUT', '/api/upload-projects', g({ on: true }));
  await both('on なし', 'PUT', '/api/upload-projects', g({ project: 'p' }));
  await both('', 'PUT', '/api/upload-projects', g({ project: 'proj-a', on: true }));
  await both('2 回目', 'PUT', '/api/upload-projects', g({ project: 'proj-a', on: true }));
  await both('外す', 'PUT', '/api/upload-projects', g({ project: 'proj-a', on: false }));
  await both('', 'GET', '/api/upload-projects', t);
  await both('', 'POST', '/api/settings/phases', g({ phases: ['設計', '実装', 'テスト'] }));
  await both('1 つだけ', 'POST', '/api/settings/phases', g({ phases: ['設計'] }));
  await both('既定に戻す', 'POST', '/api/settings/phases', g({ phases: null }));
  await both('無い', 'POST', '/api/settings/phases', g({}));
  await both('', 'POST', '/api/settings/vault/describe', g({ input: 'my-vault' }));
  await both('空', 'POST', '/api/settings/vault/describe', g({ input: ' ' }));
  await both('', 'POST', '/api/settings/wikis', g({ vault: { path: 'other-vault', pages: ['.'], skills: ['s', 's'] } }));
  await both('同じ vault', 'POST', '/api/settings/wikis', g({ vault: { path: 'other-vault' } }));
  await both('vault なし', 'POST', '/api/settings/wikis', g({}));
  await both('違う番号', 'POST', '/api/settings/wikis/remove', g({ index: 0, path: 'nope' }));
  await both('', 'POST', '/api/settings/wikis/remove', g({ index: 1, path: 'other-vault' }));
  await both('', 'GET', '/api/settings', t);

  // ---------- 別のフォルダを開く(開くのは別のプロセスなので、調べる・一覧・外すだけ) ----------
  await both('', 'POST', '/api/folders/check', g({ path: join(work, 'home') }));
  await both('無い', 'POST', '/api/folders/check', g({ path: join(work, 'nope') }));
  await both('相対', 'POST', '/api/folders/check', g({ path: 'logs' }));
  await both('空', 'POST', '/api/folders/check', g({}));
  await both('外す 形が違う', 'POST', '/api/folders/forget', g({ key: '../x' }));
  await both('外す 無い', 'POST', '/api/folders/forget', g({ key: 'none-00000000' }));
  await both('開く 無い', 'POST', '/api/folders/open', g({ path: join(work, 'nope') }));

  // ---------- ジョブとチャットでの判定 ----------
  for (const bad of [{}, { kind: 'nope' }, { kind: 'judge', limit: 1.5 }, { kind: 'judge', limit: 10, backend: 'anthropic' }, { kind: 'full', id: '..' }, { kind: 'full', id: 'nope' }, { kind: 'refresh', out: 'x' }]) {
    await both(JSON.stringify(bad), 'POST', '/api/jobs', g(bad));
  }
  await both('token なし', 'POST', '/api/jobs', { body: JSON.stringify({ kind: 'bundle' }) });
  await both('動いていない', 'POST', '/api/jobs/current/cancel', t);
  await both('', 'POST', '/api/jobs', { ...g({ kind: 'bundle' }), mapJson: maskJob });
  for (const s of sides) await waitJob(s);
  await both('bundle の後', 'GET', '/api/jobs/current', { ...t, mapJson: maskJob });
  const [parts] = await both('', 'GET', '/api/judge/parts', t);
  const first = (JSON.parse(parts.body.toString()) as { parts?: { name: string }[] }).parts?.[0]?.name;
  if (first) await both('', 'GET', `/api/judge/parts/${encodeURIComponent(first)}`, t);
  for (const bad of ['part-999.md', '..%2Fmanifest.json', '%E0%A4%A']) await both('', 'GET', `/api/judge/parts/${bad}`, t);
  await both('空', 'POST', '/api/judge/import', g({ text: ' ' }));
  await both('JSON が無い', 'POST', '/api/judge/import', g({ text: 'JSON の無い返答' }));
  await both('形が違う', 'POST', '/api/judge/import', g({ text: '```json\n{"items":[{"sessionId":"' + id + '"}]}\n```' }));
  await both('形が違う(依頼)', 'POST', '/api/judge/import?target=turns', g({ text: '```json\n{"items":[{"sessionId":"' + id + '","turn":1}]}\n```' }));
  const item = {
    sessionId: id,
    taskCategory: 'feature',
    taskSummary: '要約',
    humanEffort: { hours: 2, low: 1, high: 4, confidence: 0.5, rationale: '根拠' },
    aiOutcome: { completed: true, quality: 4, rework: 1, rationale: '成果' },
    instructionsEffect: { score: 1, evidence: 'e' },
    wikiEffect: { score: 0, evidence: '参照なし' },
    skillsAgentsEffect: { score: 0, evidence: '参照なし' },
  };
  const reply = `判定しました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'm365', ranAt: null }, items: [item, { ...item, sessionId: 'zz' }, item] })}\n\`\`\``;
  await both('取り込み', 'POST', '/api/judge/import', g({ text: reply }));
  await both('取り込みの後', 'GET', '/api/jobs/judge-preview', t);
  await both('取り込みの後', 'GET', '/api/judge/parts', t);
  await both('', 'POST', '/api/jobs', { ...g({ kind: 'export' }), mapJson: maskJob });
  await both('2 つ目', 'POST', '/api/jobs', g({ kind: 'bundle' }));
  await both('動いている間の取り込み', 'POST', '/api/judge/import', g({ text: reply }));
  for (const s of sides) await waitJob(s);
  await both('export の後', 'GET', '/api/jobs/current', { ...t, mapJson: maskJob });
  await both('export の後', 'GET', '/api/state');

  await both('', 'POST', '/api/bye', { ...t, headers: { 'x-atlas-client': 'parity', 'x-atlas-seq': '2' } });
  await both('token なし', 'POST', '/api/bye');
  await both('', 'POST', '/api/heartbeat', { ...t, headers: { 'x-atlas-client': 'parity', 'x-atlas-seq': '3' } });
}

/** 側に依らない、無いフォルダの親(作業フォルダの外) */
function rsDirless(): string {
  return join(work, 'nowhere');
}

process.exitCode = await main();
