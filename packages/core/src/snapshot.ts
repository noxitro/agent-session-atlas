import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { readDesktopDb } from './desktop.ts';
import { openWritable, sqlString } from './sqlite.ts';
import type { InstalledInventory } from './types.ts';

/** 複製する SQLite(ルート直下)。data.db(デスクトップアプリ)は資格情報列を含むので複製せず、Phase 11 から許可リストの列だけを desktop.json に書く */
export const SNAPSHOT_DBS = ['session-store.db'] as const;
/** 以前のバージョンが複製していたが今は複製しないファイル。snapshot 時に残っていれば消す */
export const SNAPSHOT_STALE_FILES = ['data.db'] as const;
export const SNAPSHOT_SESSION_FILES = ['workspace.yaml', 'events.jsonl'] as const;
/** Phase 11: セッションフォルダの追加のファイル(あれば写す) */
export const SNAPSHOT_SESSION_EXTRA_FILES = ['plan.md', 'vscode.metadata.json'] as const;
/** Phase 11: セッションフォルダの追加のサブフォルダ(あれば再帰的に写す) */
export const SNAPSHOT_SESSION_EXTRA_DIRS = ['checkpoints', 'files', 'rewind-file-snapshots', 'policies', 'research', 'sandbox-denials'] as const;
/** Phase 11: 既定では写さず --snapshot-all で写すサブフォルダ(大きい。rewind-snapshots は 1 セッションで数十 MB) */
export const SNAPSHOT_SESSION_HEAVY_DIRS = ['rewind-snapshots'] as const;
/** Phase 11: ~/.copilot 直下で写すフォルダ */
export const SNAPSHOT_TOP_DIRS = ['plans', 'attachments'] as const;
/** Phase 11: ~/.copilot 直下で既定では写さないフォルダ(--snapshot-all で写す)と理由 */
export const SNAPSHOT_TOP_HEAVY_DIRS: Record<string, string> = { logs: 'アプリのログ(資格情報を含みうる。セッションの解析には使わない)' };
/** Phase 11: 写さないフォルダ(名前と容量だけ残す)と理由 */
export const SNAPSHOT_TOP_SKIP_DIRS: Record<string, string> = { repos: 'ソースのチェックアウト(記録ではない)', chats: 'ユーザーが書き出した Markdown(*.md)だけ写し、他は無関係なファイル' };
export const DESKTOP_JSON = 'desktop.json';
/** セッションごとの SQLite(todos / todo_deps)。Phase 7 から VACUUM INTO で複製する */
export const SNAPSHOT_SESSION_DB = 'session.db';
/** 複製した session.db の元の指紋(サイズと mtime)。同じなら次回は複製し直さない */
const SESSION_DB_FINGERPRINT = '.session.db.src';
export const SNAPSHOT_MANIFEST = 'snapshot-manifest.json';

export interface SnapshotOptions {
  /** この時刻以降に更新されたセッションだけを複製する(ISO 文字列か Date) */
  since?: string | Date;
  /** Phase 11: 既定で写さない大きなもの(rewind-snapshots、一覧に無い名前のもの、logs/)も写す */
  all?: boolean;
  /** 前回 --snapshot-all で写したが今回は写さないものを消す(既定は残して manifest の extras.leftover に日時を出す) */
  prune?: boolean;
}

/** 写さなかったもの(名前と容量) */
export interface SkippedEntry {
  /** 元のルートからの相対パス(/ 区切り) */
  path: string;
  bytes: number;
  reason: string;
}

export interface SnapshotManifest {
  createdAt: string;
  sourceRoot: string;
  since: string | null;
  /** copied が false なら今回は複製できず、前回の複製(bytes が 0 なら無し)を使っている。理由は error */
  databases: Record<string, { copied: boolean; bytes: number; attempts: number; error?: string }>;
  sessions: { dirs: number; copiedFiles: number; reusedFiles: number; skippedBySince: number; bytes: number; dbCopied?: number; dbReused?: number };
  /** session.db を複製できなかったセッションと理由(Phase 7) */
  sessionDbErrors?: string[];
  /** インストール済みの skill / プラグインの名前(Phase 6。古いマニフェストには無い) */
  installed?: InstalledInventory;
  /** Phase 11: 追加で写したもの(セッションフォルダの中身と ~/.copilot 直下)と、写さなかったもの */
  extras?: {
    all: boolean;
    sessionFiles: number;
    sessionBytes: number;
    topLevel: Record<string, { files: number; bytes: number }>;
    skipped: SkippedEntry[];
    /** data.db(許可リストの列だけ)を desktop.json に書いたか。無ければ false。読めなければ理由 */
    desktop: { written: boolean; sessions: number; warnings: string[] } | null;
    /** 前回 --snapshot-all で写したが今回は写さなかったもの(残してある。--snapshot-prune で消す) */
    leftover: { path: string; mtime: string }[];
  };
}

/**
 * ~/.copilot の必要部分を dest へ複製する。元は一切書き換えない。
 * - SQLite は本体と -wal をバイト列でコピーし、コピー側から VACUUM INTO(WAL の内容も含む単一ファイル)
 * - workspace.yaml / events.jsonl はファイルコピー(サイズと mtime が同じなら再利用)
 * - session-state/<id>/session.db(todos)は session-store.db と同じ方法で複製する(元は開かない)
 * - checkpoints/ は複製しない
 */
export async function snapshot(src: string, dest: string, opts: SnapshotOptions = {}): Promise<SnapshotManifest> {
  const since = opts.since ? new Date(opts.since) : null;
  const all = !!opts.all;
  const prune = !!opts.prune;
  const extras: NonNullable<SnapshotManifest['extras']> = { all, sessionFiles: 0, sessionBytes: 0, topLevel: {}, skipped: [], desktop: null, leftover: [] };
  if (since && Number.isNaN(since.getTime())) throw new Error(`since が日時として解釈できない: ${String(opts.since)}`);
  if (!existsSync(src)) throw new Error(`元ディレクトリが無い: ${src}`);
  await mkdir(dest, { recursive: true });

  const manifest: SnapshotManifest = {
    createdAt: new Date().toISOString(),
    sourceRoot: src,
    since: since ? since.toISOString() : null,
    databases: {},
    sessions: { dirs: 0, copiedFiles: 0, reusedFiles: 0, skippedBySince: 0, bytes: 0, dbCopied: 0, dbReused: 0 },
  };

  /** 1 セッション分を写す(workspace.yaml / events.jsonl・session.db・追加のファイル) */
  async function snapshotSession(name: string, dirSrc: string, present: readonly string[]): Promise<void> {
    if (since && !(await isUpdatedSince(dirSrc, present, since))) {
      manifest.sessions.skippedBySince++;
      return;
    }
    manifest.sessions.dirs++;
    const dirDest = join(stateDest, name);
    await mkdir(dirDest, { recursive: true });
    for (const f of present) {
      let r: { copied: boolean; bytes: number };
      try {
        r = await copyIfChanged(join(dirSrc, f), join(dirDest, f));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(join(dirSrc, f))) throw e;
        continue; // 一覧の後に消えたファイル
      }
      manifest.sessions.bytes += r.bytes;
      if (r.copied) manifest.sessions.copiedFiles++;
      else manifest.sessions.reusedFiles++;
    }
    const dbSrc = join(dirSrc, SNAPSHOT_SESSION_DB);
    if (existsSync(dbSrc)) {
      try {
        const copied = await copySessionDb(dbSrc, join(dirDest, SNAPSHOT_SESSION_DB), join(dest, '.tmp-sqlite'));
        if (copied) manifest.sessions.dbCopied!++;
        else manifest.sessions.dbReused!++;
      } catch (e) {
        // 1 セッションの session.db が壊れていてもスナップショット全体は止めない(理由は manifest に残し、extract が警告に出す)
        await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true });
        (manifest.sessionDbErrors ??= []).push(`${name}: ${(e as Error).message}`);
      }
    } else await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true }); // 元から消えたものは複製側も消す
    // Phase 11: plan.md・checkpoints/・files/ などを写す。大きいもの・一覧に無いものは --snapshot-all のときだけ
    await copySessionExtras(dirSrc, dirDest, src, all, prune, extras);
  }

  for (const name of SNAPSHOT_STALE_FILES) await rm(join(dest, name), { force: true });

  for (const name of SNAPSHOT_DBS) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    const to = join(dest, name);
    try {
      const r = await copySqlite(from, to, join(dest, '.tmp-sqlite'));
      manifest.databases[name] = { copied: true, bytes: (await stat(to)).size, attempts: r.attempts };
    } catch (e) {
      // Copilot が書き続けていて一貫した複製が取れなくても、スナップショット全体は止めない。
      // 前回の複製があればそのまま使い(古い)、理由は manifest に残して extract が警告に出す
      manifest.databases[name] = { copied: false, bytes: existsSync(to) ? (await stat(to)).size : 0, attempts: SQLITE_COPY_ATTEMPTS, error: (e as Error).message };
    }
  }

  const stateSrc = join(src, 'session-state');
  const stateDest = join(dest, 'session-state');
  if (existsSync(stateSrc)) {
    for (const ent of await readdir(stateSrc, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dirSrc = join(stateSrc, ent.name);
      const present = SNAPSHOT_SESSION_FILES.filter((f) => existsSync(join(dirSrc, f)));
      if (present.length === 0) continue; // optimistic-chat-* など中身の無いディレクトリ
      try {
        await snapshotSession(ent.name, dirSrc, present);
      } catch (e) {
        // 走査中にセッションが消された(Copilot の削除・一時セッションの片付け)なら飛ばす。それ以外は止める
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(dirSrc)) continue;
        throw e;
      }
    }
  }

  // Phase 11: ~/.copilot 直下の plans/・attachments/(と chats/ の *.md)。logs/ は --snapshot-all、repos/ は写さない
  await copyTopLevel(src, dest, all, prune, extras);
  // Phase 11: data.db は複製せず、許可リストの列だけを desktop.json に書く(immutable で開く。元には触れない)
  try {
    const d = await readDesktopDb(join(src, 'data.db'));
    if (d) {
      await writeFile(join(dest, DESKTOP_JSON), JSON.stringify(d));
      extras.desktop = { written: true, sessions: d.tables.sessions?.length ?? 0, warnings: d.warnings };
    } else {
      await rm(join(dest, DESKTOP_JSON), { force: true });
      extras.desktop = null;
    }
  } catch (e) {
    extras.desktop = { written: false, sessions: 0, warnings: [`data.db を読めない (${(e as Error).message})`] };
  }
  manifest.extras = extras;

  manifest.installed = await readInventory(src);

  await writeFile(join(dest, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

const KNOWN_SESSION_ENTRIES = new Set<string>([
  ...SNAPSHOT_SESSION_FILES,
  SNAPSHOT_SESSION_DB,
  `${SNAPSHOT_SESSION_DB}-wal`,
  `${SNAPSHOT_SESSION_DB}-shm`,
  ...SNAPSHOT_SESSION_EXTRA_FILES,
  ...SNAPSHOT_SESSION_EXTRA_DIRS,
  ...SNAPSHOT_SESSION_HEAVY_DIRS,
]);
const isLock = (name: string): boolean => /^inuse\.\d+\.(lock|hold)$/.test(name) || name.endsWith('.lock');

const LINK_REASON = 'シンボリックリンク / ジャンクション(辿らない)';

/**
 * フォルダを歩く(シンボリックリンク・ジャンクションは辿らず、リンクの一覧に返す)。相対パスは / 区切り。
 * 読めないフォルダ(EPERM / EACCES 等)は全体を止めず errors に返す
 */
async function walk(dir: string): Promise<{ files: { rel: string; abs: string }[]; links: string[]; errors: { rel: string; code: string }[] }> {
  const files: { rel: string; abs: string }[] = [];
  const links: string[] = [];
  const errors: { rel: string; code: string }[] = [];
  const rec = async (d: string, rel: string): Promise<void> => {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      errors.push({ rel, code: err.code ?? err.message });
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) links.push(r);
      else if (e.isDirectory()) await rec(join(d, e.name), r);
      else if (e.isFile()) files.push({ rel: r, abs: join(d, e.name) });
    }
  };
  await rec(dir, '');
  return { files, links, errors };
}

/** フォルダの容量(再帰。リンクは辿らず、読めないフォルダは数えない) */
async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const f of (await walk(dir)).files) {
    try {
      n += (await stat(f.abs)).size;
    } catch {
      /* 消えた・読めないファイルは数えない */
    }
  }
  return n;
}

/**
 * フォルダを再帰的に写す(サイズと mtime が同じファイルは再利用)。元に無いファイルは複製先から消す(現存しないものを残さない)。
 * 削除の前に元の実在を確かめる(Windows で大文字小文字だけ変えた改名で、写したばかりの複製を消さない)。削除で空になったフォルダも消す。
 * 1 ファイルの失敗(EBUSY / EPERM 等)や読めないフォルダは全体を止めず skipped に理由を積む。リンクは辿らず skipped に残す
 */
async function copyTree(from: string, to: string, skipped: SkippedEntry[], relBase: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  await mkdir(to, { recursive: true });
  const src = await walk(from);
  for (const l of src.links) skipped.push({ path: `${relBase}/${l}`, bytes: 0, reason: LINK_REASON });
  for (const e of src.errors) skipped.push({ path: e.rel ? `${relBase}/${e.rel}` : relBase, bytes: 0, reason: `読めなかった (${e.code})` });
  const keep = new Set(src.files.map((f) => f.rel));
  for (const f of src.files) {
    const dst = join(to, ...f.rel.split('/'));
    try {
      await mkdir(dirname(dst), { recursive: true });
      const r = await copyIfChanged(f.abs, dst);
      files++;
      bytes += r.bytes;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      skipped.push({ path: `${relBase}/${f.rel}`, bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
    }
  }
  await pruneTree(from, to, keep);
  return { files, bytes };
}

/** 複製先にあって元に無いファイルを消し、空になったフォルダも消す。元の実在は大文字小文字を区別しないファイルシステムでも確かめる */
async function pruneTree(from: string, to: string, keep: Set<string>): Promise<void> {
  if (!existsSync(to)) return;
  const dst = await walk(to);
  const dirs = new Set<string>();
  for (const f of dst.files) {
    if (keep.has(f.rel)) continue;
    // 名前の大文字小文字だけが違う改名: 元に(大文字小文字を無視して)あるなら消さない
    if (existsSync(join(from, ...f.rel.split('/')))) continue;
    await rm(f.abs, { force: true });
    const parts = f.rel.split('/');
    for (let i = parts.length - 1; i >= 1; i--) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const p = join(to, ...d.split('/'));
    try {
      if ((await readdir(p)).length === 0) await rm(p, { recursive: true, force: true });
    } catch {
      /* 既に無い */
    }
  }
}

async function copySessionExtras(dirSrc: string, dirDest: string, root: string, all: boolean, prune: boolean, extras: NonNullable<SnapshotManifest['extras']>): Promise<void> {
  const relPath = (p: string): string => relative(root, p).replace(/\\/g, '/');
  const copyOne = async (from: string, to: string): Promise<void> => {
    try {
      const r = await copyIfChanged(from, to);
      extras.sessionFiles++;
      extras.sessionBytes += r.bytes;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      extras.skipped.push({ path: relPath(from), bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
    }
  };
  for (const f of SNAPSHOT_SESSION_EXTRA_FILES) {
    const p = join(dirSrc, f);
    if (existsSync(p)) await copyOne(p, join(dirDest, f));
    else await rm(join(dirDest, f), { force: true }); // 元から消えたものは複製先からも消す
  }
  const present = new Set<string>();
  let ents: import('node:fs').Dirent[];
  try {
    ents = await readdir(dirSrc, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    extras.skipped.push({ path: relPath(dirSrc), bytes: 0, reason: `読めなかった (${err.code ?? err.message})` });
    return;
  }
  for (const ent of ents) {
    const name = ent.name;
    const p = join(dirSrc, name);
    if (ent.isSymbolicLink()) {
      extras.skipped.push({ path: relPath(p), bytes: 0, reason: LINK_REASON });
      continue;
    }
    if (ent.isDirectory()) {
      const heavy = (SNAPSHOT_SESSION_HEAVY_DIRS as readonly string[]).includes(name);
      const known = (SNAPSHOT_SESSION_EXTRA_DIRS as readonly string[]).includes(name);
      if (known || ((heavy || !KNOWN_SESSION_ENTRIES.has(name)) && all)) {
        present.add(name);
        const r = await copyTree(p, join(dirDest, name), extras.skipped, relPath(p));
        extras.sessionFiles += r.files;
        extras.sessionBytes += r.bytes;
      } else if (heavy || !KNOWN_SESSION_ENTRIES.has(name)) {
        extras.skipped.push({ path: relPath(p), bytes: await dirBytes(p), reason: heavy ? '大きい(--snapshot-all で写す)' : '一覧に無い名前(--snapshot-all で写す)' });
      }
    } else if (ent.isFile() && !KNOWN_SESSION_ENTRIES.has(name) && !isLock(name)) {
      if (all) {
        present.add(name);
        await copyOne(p, join(dirDest, name));
      } else extras.skipped.push({ path: relPath(p), bytes: await sizeOr0(p), reason: '一覧に無い名前(--snapshot-all で写す)' });
    }
  }
  // 複製先に残っている追加のフォルダ・ファイルで今回写さなかったもの: 元から消えたものは消す。
  // 前回 --snapshot-all で写したもの(元にはまだある)は、生成物を黙って消さない方針で残し、manifest の leftover に日時を出す(--snapshot-prune で消す)
  if (existsSync(dirDest)) {
    for (const ent of await readdir(dirDest, { withFileTypes: true })) {
      const name = ent.name;
      if (KNOWN_SESSION_ENTRIES.has(name) && !(SNAPSHOT_SESSION_EXTRA_DIRS as readonly string[]).includes(name) && !(SNAPSHOT_SESSION_HEAVY_DIRS as readonly string[]).includes(name)) continue;
      if (name === SESSION_DB_FINGERPRINT || present.has(name)) continue;
      const p = join(dirDest, name);
      if (!existsSync(join(dirSrc, name)) || prune) await rm(p, { recursive: true, force: true });
      else extras.leftover.push({ path: relPath(join(dirSrc, name)), mtime: (await stat(p)).mtime.toISOString() });
    }
  }
}

async function copyTopLevel(src: string, dest: string, all: boolean, prune: boolean, extras: NonNullable<SnapshotManifest['extras']>): Promise<void> {
  for (const name of SNAPSHOT_TOP_DIRS) {
    const p = join(src, name);
    if (!existsSync(p)) {
      await rm(join(dest, name), { recursive: true, force: true });
      continue;
    }
    extras.topLevel[name] = await copyTree(p, join(dest, name), extras.skipped, name);
  }
  for (const [name, reason] of Object.entries(SNAPSHOT_TOP_HEAVY_DIRS)) {
    const p = join(src, name);
    const d = join(dest, name);
    if (!existsSync(p)) {
      await rm(d, { recursive: true, force: true });
      continue;
    }
    if (all) extras.topLevel[name] = await copyTree(p, d, extras.skipped, name);
    else {
      extras.skipped.push({ path: name, bytes: await dirBytes(p), reason: `${reason}(--snapshot-all で写す)` });
      if (existsSync(d)) {
        if (prune) await rm(d, { recursive: true, force: true });
        else extras.leftover.push({ path: name, mtime: (await stat(d)).mtime.toISOString() });
      }
    }
  }
  // chats/: *.md(ユーザーが書き出したセッション記録)だけ写し、他は名前と容量だけ。元に無い .md は複製先から消す
  const chats = join(src, 'chats');
  if (existsSync(chats)) {
    let files = 0;
    let bytes = 0;
    let otherBytes = 0;
    let otherFiles = 0;
    const w = await walk(chats);
    for (const l of w.links) extras.skipped.push({ path: `chats/${l}`, bytes: 0, reason: LINK_REASON });
    const keep = new Set<string>();
    for (const f of w.files) {
      if (f.rel.toLowerCase().endsWith('.md')) {
        keep.add(f.rel);
        const to = join(dest, 'chats', ...f.rel.split('/'));
        try {
          await mkdir(dirname(to), { recursive: true });
          const r = await copyIfChanged(f.abs, to);
          files++;
          bytes += r.bytes;
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          extras.skipped.push({ path: `chats/${f.rel}`, bytes: 0, reason: `複製できなかった (${err.code ?? err.message})` });
        }
      } else {
        otherFiles++;
        otherBytes += await sizeOr0(f.abs);
      }
    }
    if (existsSync(join(dest, 'chats'))) for (const f of (await walk(join(dest, 'chats'))).files) if (!keep.has(f.rel)) await rm(f.abs, { force: true });
    extras.topLevel.chats = { files, bytes };
    if (otherFiles) extras.skipped.push({ path: 'chats(*.md 以外)', bytes: otherBytes, reason: `${SNAPSHOT_TOP_SKIP_DIRS.chats}(${otherFiles} ファイル)` });
  } else await rm(join(dest, 'chats'), { recursive: true, force: true });
  const repos = join(src, 'repos');
  if (existsSync(repos)) extras.skipped.push({ path: 'repos', bytes: await dirBytes(repos), reason: SNAPSHOT_TOP_SKIP_DIRS.repos });
}

/** ディレクトリ(とそれを指すシンボリックリンク・ジャンクション)の名前。無ければ空 */
async function dirNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory() || ent.isSymbolicLink()) out.push(ent.name);
  }
  return out.sort();
}

/**
 * インストール済みの skill / プラグインを名前だけ記録する(SKILL.md などの中身は読まない)。
 * - ~/.copilot/skills/<name>/
 * - ~/.copilot/installed-plugins/<marketplace>/<plugin>/(と、その skills/<name>/)
 * - ~/.copilot/settings.json の disabledSkills(他のキーは記録しない)
 * 読めないものは warnings に理由を残し、黙って空にしない。
 */
export async function readInventory(src: string): Promise<InstalledInventory> {
  const inv: InstalledInventory = { skills: [], plugins: [], disabledSkills: [], warnings: [] };
  try {
    inv.skills = await dirNames(join(src, 'skills'));
  } catch (e) {
    inv.warnings.push(`skills/ を読めない (${(e as Error).message})`);
  }
  try {
    const root = join(src, 'installed-plugins');
    for (const market of await dirNames(root)) {
      for (const name of await dirNames(join(root, market))) {
        inv.plugins.push({ marketplace: market, name, skills: await dirNames(join(root, market, name, 'skills')) });
      }
    }
  } catch (e) {
    inv.warnings.push(`installed-plugins/ を読めない (${(e as Error).message})`);
  }
  const settings = join(src, 'settings.json');
  if (existsSync(settings)) {
    try {
      const v = JSON.parse(await readFile(settings, 'utf8')) as { disabledSkills?: unknown };
      const d = v?.disabledSkills;
      if (d == null) inv.disabledSkills = [];
      else if (Array.isArray(d)) inv.disabledSkills = d.filter((x): x is string => typeof x === 'string').sort();
      else {
        inv.disabledSkills = null;
        inv.warnings.push('settings.json の disabledSkills が配列でない');
      }
    } catch (e) {
      inv.disabledSkills = null;
      inv.warnings.push(`settings.json を読めない (${(e as Error).message})`);
    }
  }
  return inv;
}

export async function readSnapshotManifest(dir: string): Promise<SnapshotManifest | null> {
  const p = join(dir, SNAPSHOT_MANIFEST);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8')) as SnapshotManifest;
}

const SQLITE_COPY_ATTEMPTS = 8;

/**
 * WAL 付き SQLite を元に触れずに複製する。
 * 元を直接開くと、読み取り専用接続でも -shm(WAL インデックス)に読み取りマークを書くため
 * -shm の mtime が変わる(2026-10-28 実測)。そこで本体と -wal をバイト列のままコピーし、
 * コピー側を開いて VACUUM INTO で単一ファイルにする。
 * コピー中に元が書かれた(サイズか mtime が変わった)・-wal が消えた(チェックポイント)・quick_check が通らないときは、間を空けて取り直す。
 * 複製先は一時ファイルに作ってから置き換えるので、取り直しきれなくても前回の複製は残る。
 */
async function copySqlite(from: string, to: string, tmpDir: string): Promise<{ attempts: number }> {
  const name = basename(from);
  const parts = [`${from}-wal`, from]; // -wal を先に取る(後から取る本体は同じかより新しいページを持つ)
  let lastProblem = '';
  // 途中で例外になっても一時フォルダを残さない
  try {
    for (let attempt = 1; attempt <= SQLITE_COPY_ATTEMPTS; attempt++) {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      const present = parts.filter((p) => existsSync(p));
      let changed: boolean;
      try {
        const before = await Promise.all(present.map(fingerprint));
        for (const p of present) await copyFile(p, join(tmpDir, basename(p)));
        const after = await Promise.all(present.map(fingerprint));
        changed = before.join('|') !== after.join('|');
        if (changed) lastProblem = 'コピー中に元が更新された';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        changed = true;
        lastProblem = 'コピー中に元のファイルが消えた';
      }
      if (changed) {
        await sleep(200 * attempt);
        continue;
      }
      const copy = join(tmpDir, name);
      const fresh = join(tmpDir, `${name}.vacuum`);
      let broken = false;
      const db = await openWritable(copy); // 複製側なので書けてよい(-shm は複製側に作られる)
      try {
        const qc = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
        if (qc.length !== 1 || qc[0].quick_check !== 'ok') {
          lastProblem = `quick_check: ${qc.map((r) => r.quick_check).join('; ').slice(0, 200)}`;
          broken = true;
        } else {
          await rm(fresh, { force: true });
          db.exec(`VACUUM INTO ${sqlString(fresh)}`);
        }
      } finally {
        db.close();
      }
      if (broken) {
        await sleep(200 * attempt);
        continue;
      }
      await rename(fresh, to);
      return { attempts: attempt };
    }
    throw new Error(`${from} を一貫した状態で複製できなかった(${SQLITE_COPY_ATTEMPTS} 回): ${lastProblem}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * session.db を複製する(copySqlite と同じく、元の本体と -wal をバイト列でコピーしてから複製側で VACUUM INTO)。
 * 元の指紋(本体と -wal のサイズ・mtime)が前回と同じなら複製し直さない。複製したら true
 */
async function copySessionDb(from: string, to: string, tmpDir: string): Promise<boolean> {
  const fpPath = join(dirname(to), SESSION_DB_FINGERPRINT);
  const fp = (await Promise.all([from, `${from}-wal`].filter((p) => existsSync(p)).map(fingerprint))).join('|');
  if (existsSync(to) && existsSync(fpPath) && (await readFile(fpPath, 'utf8')) === fp) return false;
  await copySqlite(from, to, tmpDir);
  await writeFile(fpPath, fp);
  return true;
}

async function fingerprint(p: string): Promise<string> {
  const s = await stat(p);
  return `${s.size}:${s.mtimeMs}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isUpdatedSince(dir: string, files: readonly string[], since: Date): Promise<boolean> {
  for (const f of files) {
    try {
      if ((await stat(join(dir, f))).mtime >= since) return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return false;
}

/** ファイルの大きさ。一覧の後に消えた・読めないものは 0 */
async function sizeOr0(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

async function copyIfChanged(from: string, to: string): Promise<{ copied: boolean; bytes: number }> {
  const s = await stat(from);
  if (existsSync(to)) {
    const d = await stat(to);
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2) return { copied: false, bytes: s.size };
  }
  await copyFile(from, to);
  // 複製先の mtime を元に合わせる(次回の再利用判定用。元のファイルには触れない)
  await utimes(to, s.atime, s.mtime);
  return { copied: true, bytes: s.size };
}
