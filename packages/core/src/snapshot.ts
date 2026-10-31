import { copyFile, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openWritable, sqlString } from './sqlite.ts';
import type { InstalledInventory } from './types.ts';

/** 複製する SQLite(ルート直下)。data.db(デスクトップアプリ)は資格情報列を含み、どこからも読まないので複製しない */
export const SNAPSHOT_DBS = ['session-store.db'] as const;
/** 以前のバージョンが複製していたが今は読まないファイル。snapshot 時に残っていれば消す */
export const SNAPSHOT_STALE_FILES = ['data.db'] as const;
export const SNAPSHOT_SESSION_FILES = ['workspace.yaml', 'events.jsonl'] as const;
/** セッションごとの SQLite(todos / todo_deps)。Phase 7 から VACUUM INTO で複製する */
export const SNAPSHOT_SESSION_DB = 'session.db';
/** 複製した session.db の元の指紋(サイズと mtime)。同じなら次回は複製し直さない */
const SESSION_DB_FINGERPRINT = '.session.db.src';
export const SNAPSHOT_MANIFEST = 'snapshot-manifest.json';

export interface SnapshotOptions {
  /** この時刻以降に更新されたセッションだけを複製する(ISO 文字列か Date) */
  since?: string | Date;
}

export interface SnapshotManifest {
  createdAt: string;
  sourceRoot: string;
  since: string | null;
  databases: Record<string, { copied: boolean; bytes: number; attempts: number }>;
  sessions: { dirs: number; copiedFiles: number; reusedFiles: number; skippedBySince: number; bytes: number; dbCopied?: number; dbReused?: number };
  /** session.db を複製できなかったセッションと理由(Phase 7) */
  sessionDbErrors?: string[];
  /** インストール済みの skill / プラグインの名前(Phase 6。古いマニフェストには無い) */
  installed?: InstalledInventory;
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

  for (const name of SNAPSHOT_STALE_FILES) await rm(join(dest, name), { force: true });

  for (const name of SNAPSHOT_DBS) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    const to = join(dest, name);
    const r = await copySqlite(from, to, join(dest, '.tmp-sqlite'));
    manifest.databases[name] = { copied: true, bytes: (await stat(to)).size, attempts: r.attempts };
  }

  const stateSrc = join(src, 'session-state');
  const stateDest = join(dest, 'session-state');
  if (existsSync(stateSrc)) {
    for (const ent of await readdir(stateSrc, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dirSrc = join(stateSrc, ent.name);
      const present = SNAPSHOT_SESSION_FILES.filter((f) => existsSync(join(dirSrc, f)));
      if (present.length === 0) continue; // optimistic-chat-* など中身の無いディレクトリ

      if (since && !(await isUpdatedSince(dirSrc, present, since))) {
        manifest.sessions.skippedBySince++;
        continue;
      }
      manifest.sessions.dirs++;
      const dirDest = join(stateDest, ent.name);
      await mkdir(dirDest, { recursive: true });
      for (const f of present) {
        const r = await copyIfChanged(join(dirSrc, f), join(dirDest, f));
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
          (manifest.sessionDbErrors ??= []).push(`${ent.name}: ${(e as Error).message}`);
        }
      } else await rm(join(dirDest, SNAPSHOT_SESSION_DB), { force: true }); // 元から消えたものは複製側も消す
    }
  }

  manifest.installed = await readInventory(src);

  await writeFile(join(dest, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
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

const SQLITE_COPY_ATTEMPTS = 5;

/**
 * WAL 付き SQLite を元に触れずに複製する。
 * 元を直接開くと、読み取り専用接続でも -shm(WAL インデックス)に読み取りマークを書くため
 * -shm の mtime が変わる(2026-10-28 実測)。そこで本体と -wal をバイト列のままコピーし、
 * コピー側を開いて VACUUM INTO で単一ファイルにする。
 * コピー中に元が書かれた(サイズか mtime が変わった)ら取り直し、quick_check が通らなければ失敗にする。
 */
async function copySqlite(from: string, to: string, tmpDir: string): Promise<{ attempts: number }> {
  const name = basename(from);
  const parts = [`${from}-wal`, from]; // -wal を先に取る(後から取る本体は同じかより新しいページを持つ)
  let lastProblem = '';
  for (let attempt = 1; attempt <= SQLITE_COPY_ATTEMPTS; attempt++) {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const present = parts.filter((p) => existsSync(p));
    const before = await Promise.all(present.map(fingerprint));
    for (const p of present) await copyFile(p, join(tmpDir, basename(p)));
    const after = await Promise.all(present.map(fingerprint));
    if (before.join('|') !== after.join('|')) {
      lastProblem = 'コピー中に元が更新された';
      await sleep(200 * attempt);
      continue;
    }
    const copy = join(tmpDir, name);
    const db = await openWritable(copy); // 複製側なので書けてよい(-shm は複製側に作られる)
    try {
      const qc = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      if (qc.length !== 1 || qc[0].quick_check !== 'ok') {
        lastProblem = `quick_check: ${qc.map((r) => r.quick_check).join('; ').slice(0, 200)}`;
        continue;
      }
      await rm(to, { force: true });
      db.exec(`VACUUM INTO ${sqlString(to)}`);
    } finally {
      db.close();
    }
    await rm(tmpDir, { recursive: true, force: true });
    return { attempts: attempt };
  }
  await rm(tmpDir, { recursive: true, force: true });
  throw new Error(`${from} を一貫した状態で複製できなかった(${SQLITE_COPY_ATTEMPTS} 回): ${lastProblem}`);
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
    if ((await stat(join(dir, f))).mtime >= since) return true;
  }
  return false;
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
