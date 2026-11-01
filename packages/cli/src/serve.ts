// atlas serve: out/ を 127.0.0.1 だけに配信し、画面からグループ(atlas-notes/groups.json)を作る小さな API を持つ。
// 画面(3 画面)が 3 秒ごとに送る heartbeat が途切れたら自分で終了する(ブラウザを閉じれば止まる)。
// 画面と保存の境界はこの API だけ(後でアプリ化するときに差し替える)。
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { addIds, extractEmbedded, loadGroups, loadGroupsForWrite, removeIds, saveGroups, uniqueIds, type ReportData, type SessionGroup } from '../../report/src/index.ts';

export const TOKEN_PLACEHOLDER = '__ATLAS_TOKEN__';
export const SERVE_STATE_FILE = '.serve.json';
/** 画面が heartbeat を送る間隔(ms)。サーバの猶予(IDLE)はこの 2 回分より長くとる */
export const HEARTBEAT_INTERVAL_MS = 3000;
export const DEFAULT_IDLE_MS = 8000;
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
  /** 最初の heartbeat をこの時間待つ */
  firstHeartbeatMs?: number;
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
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-serve': '1' });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new HttpError(413, '本文が大きすぎます');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  const token = randomBytes(24).toString('base64url');
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS;
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

  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => (resolveDone = r));
  let server!: Server;
  let closed = false;
  let firstTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let port = 0;

  async function close(reason = '停止'): Promise<void> {
    if (closed) return;
    closed = true;
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
    await rm(join(outDir, SERVE_STATE_FILE), { force: true }).catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    resolveDone(reason);
  }

  function heartbeat(): void {
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close('画面が閉じられた(heartbeat が途切れた)'), idleMs);
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

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    checkOrigin(req);
    const method = req.method ?? 'GET';
    if (path === '/api/heartbeat' && method === 'POST') {
      checkToken(req);
      heartbeat();
      res.writeHead(204, { 'x-atlas-serve': '1' });
      res.end();
      return;
    }
    if (await isAnonymized()) throw new HttpError(403, '伏せ字版では編集できません');
    if (path === '/api/state' && method === 'GET') {
      const g = await loadGroups(groupsPath);
      sendJson(res, 200, { version: 1, groups: g.groups, notesDir: o.notesDir, groupsPath, exists: g.exists, warnings: g.warnings });
      return;
    }
    const m = /^\/api\/groups(?:\/(.+))?$/.exec(path);
    if (!m) throw new HttpError(404, '無い API です');
    const target = m[1] != null ? decodeURIComponent(m[1]) : null;
    if (method === 'POST' && target == null) {
      checkToken(req);
      const input = groupInput(await readJsonBody(req), false) as SessionGroup;
      const groups = await loadForWrite();
      if (groups.some((g) => g.name === input.name)) throw new HttpError(409, `グループ「${input.name}」は既にあります`);
      groups.push(input);
      await saveGroups(groupsPath, groups);
      sendJson(res, 201, { group: input, groups });
      return;
    }
    if (method === 'PUT' && target != null) {
      checkToken(req);
      const body = await readJsonBody(req);
      const delta = deltaInput(body);
      const input = groupInput(body, true);
      const groups = await loadForWrite();
      const cur = groups.find((g) => g.name === target);
      if (!cur) throw new HttpError(404, `グループ「${target}」はありません`);
      if (input.name != null && input.name !== cur.name && groups.some((g) => g.name === input.name)) throw new HttpError(409, `グループ「${input.name}」は既にあります`);
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
      return;
    }
    if (method === 'DELETE' && target != null) {
      checkToken(req);
      const groups = await loadForWrite();
      const i = groups.findIndex((g) => g.name === target);
      if (i < 0) throw new HttpError(404, `グループ「${target}」はありません`);
      groups.splice(i, 1);
      await saveGroups(groupsPath, groups);
      sendJson(res, 200, { groups });
      return;
    }
    throw new HttpError(405, 'この方法では使えません');
  }
  async function loadForWrite(): Promise<SessionGroup[]> {
    try {
      return await loadGroupsForWrite(groupsPath);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
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
    if (!existsSync(file)) throw new HttpError(404, 'ありません');
    const st = await stat(file);
    if (st.isDirectory()) throw new HttpError(404, 'ありません');
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    if (extname(file).toLowerCase() === '.html') {
      // token は HTML の meta のプレースホルダを置き換えて渡す(file:// で開いたときはプレースホルダのまま = 空扱い)
      const html = (await readFile(file, 'utf8')).replace(TOKEN_PLACEHOLDER, token);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    (path.startsWith('/api/') ? api(req, res, path) : serveStatic(req, res, path)).catch((e: unknown) => {
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
  firstTimer = setTimeout(() => void close('ブラウザから最初の heartbeat が届かなかった'), firstMs);
  log(`serve: ${url}(127.0.0.1 だけに公開。ブラウザを閉じるか、この窓を閉じると終了します)`);
  if (o.open !== false) openInBrowser(url, log);
  return { port, url, token, done, close };
}
