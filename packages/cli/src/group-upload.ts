// グループのアップロード: グループのセッションの生ログを、決めておいた場所へタスク(グループ)ごとに写す。
//   <基底>/<グループ名>/<セッション id>/events.jsonl            ← Copilot のセッションのフォルダ(前回の集計で複製したもの)
//                                      workspace.yaml / session.db / plan.md / checkpoints/ / files/ …
//                                      atlas-session-store.json   ← session-store.db と data.db(許可リストの列)のそのセッションの行(atlas が添える)
//                                      atlas-memo.md / atlas-memo/ ← そのセッションのメモと画像(atlas-notes/memos/。あれば)
//   <基底>/<グループ名>/README.md                                 ← グループ名・説明・写した日時・セッションの一覧(写すたびに書き直す)
// 同じセッションのフォルダは丸ごと置き換える。グループから外したセッションや、他の人が写したセッションのフォルダには触れない
// (同じ場所を何人かで使うため)。受け取った側は `atlas all --home <基底>/<グループ名>` でそのまま集計できる。
// 元(~/.copilot)は読まず、前回の集計で out/snapshot/ に複製したものを写す(SQLite は一貫した複製を取ってあるため)。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DESKTOP_JSON, desktopForSession, readSnapshotManifest, renameReplacing, SESSION_STORE_JSON, sessionStoreRows, type DesktopData, type SessionStoreJson } from '../../core/src/index.ts';
import type { SessionRecord, SessionsFile } from '../../core/src/index.ts';
import { loadGroups, memosDir, readMemo, SECRET_PATTERNS } from '../../report/src/index.ts';
import { truncate } from '../../report/src/lib/format.ts';
import { safeDirName } from './group-export.ts';

/** スナップショットのセッションのフォルダにある、atlas の作業用のファイル(写さない) */
const SNAPSHOT_PRIVATE = /^\.session\.db\.src$/;
/** セッション id として写してよい名前(Copilot の id は英数字と - だけ。. で始まるもの・区切りを含むものは除く) */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** セッションのフォルダに添えるメモ(本文)と、その画像のフォルダ */
export const UPLOAD_MEMO_FILE = 'atlas-memo.md';
export const UPLOAD_MEMO_IMAGES = 'atlas-memo';
/** グループのフォルダの説明 */
export const UPLOAD_README = 'README.md';

export interface GroupUploadPaths {
  /** out/snapshot(前回の集計の複製) */
  snapshot: string;
  groups: string;
  /** メモの置き場の親(atlas-notes/)。無ければメモは添えない */
  notes?: string;
  /** out/sessions.json(README の題名と日付に使う)。無ければ ID だけ並べる */
  sessions?: string;
}

export interface GroupUploadResult {
  name: string;
  /** 写した先(<基底>/<グループ名>) */
  dir: string;
  /** 写したセッション */
  uploaded: number;
  /** そのうち、前にも写してあって置き換えたもの */
  replaced: number;
  /** グループの id のうち、前回の集計の複製に無かったもの */
  missing: string[];
  /** 写した元の複製を作った日時(前回の集計)。分からなければ null */
  snapshotAt: string | null;
  /** メモを添えたセッションの数 */
  memos: number;
}

interface FileEntry {
  /** セッションのフォルダからの相対パス(区切りは /) */
  rel: string;
  bytes: number;
  /** シンボリックリンク(中身は辿らず、リンクのまま写す) */
  link: boolean;
}

/** セッションのフォルダの中のファイル(atlas の作業用のファイルは除く) */
async function listFiles(base: string, sub = ''): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const e of await readdir(join(base, sub), { withFileTypes: true })) {
    if (SNAPSHOT_PRIVATE.test(e.name)) continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(base, rel)));
    else if (e.isSymbolicLink()) out.push({ rel, bytes: 0, link: true });
    else if (e.isFile()) out.push({ rel, bytes: (await stat(join(base, rel))).size, link: false });
  }
  return out;
}

/** 一覧のファイルを写し、1 つ写すごとにその大きさを知らせる(cp では進み具合が取れないため) */
async function copyFiles(src: string, dest: string, files: FileEntry[], onBytes: (n: number) => void): Promise<void> {
  await mkdir(dest, { recursive: true });
  const made = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split('/');
    const parent = parts.slice(0, -1).join('/');
    if (parent && !made.has(parent)) {
      await mkdir(join(dest, ...parent.split('/')), { recursive: true });
      made.add(parent);
    }
    const from = join(src, ...parts);
    const to = join(dest, ...parts);
    if (f.link) await cp(from, to, { verbatimSymlinks: true });
    else await copyFile(from, to);
    onBytes(f.bytes);
  }
}

/** 先頭がこの大きさの中に NUL があればバイナリとして中身を調べない */
const SNIFF_BYTES = 8192;
/** 区切りをまたぐ文字列を取りこぼさないよう、前の塊の末尾をこれだけ重ねて調べる(鍵 1 つより長く取る) */
const SCAN_OVERLAP = 16 * 1024;

/** ファイルの中の秘密らしい文字列を種類ごとに数える(transcript.ts の SECRET_PATTERNS と同じ形)。バイナリなら null */
export async function scanSecrets(path: string): Promise<Map<string, number> | null> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(head, 0, SNIFF_BYTES, 0);
    if (head.subarray(0, bytesRead).includes(0)) return null;
  } finally {
    await fh.close();
  }
  const counts = new Map<string, number>();
  const decoder = new StringDecoder('utf8');
  let carry = '';
  // 塊ごとに、重ねる部分より前で始まるものだけを数える(重ねた部分は次の塊で数える)。最後の塊は末尾まで数える
  const scan = (text: string, last: boolean): void => {
    const limit = last ? text.length : text.length - SCAN_OVERLAP;
    for (const [label, re] of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) if (m.index < limit) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    carry = last ? '' : text.slice(Math.max(0, limit));
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    const text = carry + decoder.write(chunk as Buffer);
    if (text.length > SCAN_OVERLAP) scan(text, false);
    else carry = text;
  }
  scan(carry + decoder.end(), true);
  return counts;
}

/** アップロード先のグループのフォルダ(<基底>/<グループ名>)。フォルダ名に使えない文字は _ にする */
export function uploadDir(root: string, name: string): string {
  return join(root, safeDirName(name));
}

/** 写す前の点検(画面の確認に出す)。大きさと、秘密らしい文字列 */
export interface UploadCheck {
  name: string;
  dir: string;
  /** 写すセッション(前回の集計にあるもの) */
  sessions: number;
  missing: string[];
  /** そのうち、前にも写してあって置き換えるもの */
  replace: number;
  bytes: number;
  files: number;
  /** 大きいもの(セッションの直下のフォルダ・ファイル)。大きい順に最大 5 件 */
  largest: { id: string; path: string; bytes: number }[];
  secrets: {
    /** 見つかった数(偽陽性もありうる) */
    count: number;
    kinds: { label: string; count: number }[];
    /** 見つかったファイル。多い順に最大 10 件 */
    files: { id: string; path: string; count: number }[];
    /** 中身を調べなかったバイナリのファイルの数(session.db・画像・ビルドの成果物など) */
    skipped: number;
  };
  snapshotAt: string | null;
}

/** 写している途中の進み具合(画面が問い合わせて出す) */
export interface UploadProgress {
  sessions: number;
  done: number;
  bytes: number;
  copied: number;
  /** 写しているセッション */
  current: string | null;
}

/** 確認を挟む目安: 秘密らしい文字列が 1 つでもあるか、合計がこの大きさを超えるとき */
export const UPLOAD_CONFIRM_BYTES = 100 * 1024 * 1024;

/** 写すセッションのまとまり(グループか、集計のプロジェクト)。名前がアップロード先のフォルダ名になる */
export interface UploadTarget {
  kind: 'group' | 'project';
  name: string;
  /** README に書く説明 */
  note: string;
  ids: string[];
}

const KIND_LABEL: Record<UploadTarget['kind'], string> = { group: 'グループ', project: 'プロジェクト' };

interface Prepared {
  g: UploadTarget;
  stateDir: string;
  dir: string;
  present: string[];
  missing: string[];
}

/** groups.json のグループを、写すまとまりにする(無い・空・フォルダ名が別のグループと同じなら止まる) */
export async function groupTarget(p: Pick<GroupUploadPaths, 'groups'>, name: string): Promise<UploadTarget> {
  const loaded = await loadGroups(p.groups);
  const g = loaded.groups.find((x) => x.name === name);
  if (!g) throw new Error(`グループ「${name}」はありません${loaded.groups.length ? `(あるのは: ${loaded.groups.map((x) => x.name).join(', ')})` : ''}`);
  if (g.ids.length === 0) throw new Error(`グループ「${name}」にセッションがありません`);
  // フォルダ名に直すと同じになる別のグループ(Player/Weapon と Player_Weapon。Windows は大文字小文字も区別しない)があれば、混ざるので写さない
  const folder = safeDirName(name);
  const clash = loaded.groups.find((x) => x.name !== name && safeDirName(x.name).toLowerCase() === folder.toLowerCase());
  if (clash) throw new Error(`グループ「${name}」と「${clash.name}」は、アップロード先のフォルダ名が同じ「${folder}」になります。どちらかの名前を変えてください`);
  return { kind: 'group', name, note: g.note, ids: g.ids };
}

/** 集計のプロジェクト(sessions.json の project。プロジェクト別の表と同じ単位)ごとの、空でないセッションの数と最終更新。多い順 */
export async function listProjects(sessionsPath: string): Promise<{ name: string; sessions: number; updatedAt: string | null }[]> {
  const by = new Map<string, { sessions: number; updatedAt: string | null }>();
  for (const s of await readSessions(sessionsPath)) {
    if (s.empty) continue;
    const x = by.get(s.project) ?? { sessions: 0, updatedAt: null };
    x.sessions++;
    if (s.updatedAt && (!x.updatedAt || s.updatedAt > x.updatedAt)) x.updatedAt = s.updatedAt;
    by.set(s.project, x);
  }
  return [...by].map(([name, x]) => ({ name, ...x })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

/** 集計のプロジェクトのセッション(空のものは除く)を、写すまとまりにする */
export async function projectTarget(sessionsPath: string, name: string): Promise<UploadTarget> {
  const ids = (await readSessions(sessionsPath)).filter((s) => s.project === name && !s.empty).map((s) => s.id);
  if (!ids.length) throw new Error(`プロジェクト「${name}」のセッションは、前回の集計にありません(空のセッションは写しません)`);
  return { kind: 'project', name, note: `集計のプロジェクト「${name}」のセッション(空のものを除く ${ids.length} 件)`, ids };
}

async function readSessions(path: string): Promise<SessionRecord[]> {
  if (!existsSync(path)) throw new Error(`${path} がありません。先に集計してください(atlas.bat か atlas all)`);
  return (JSON.parse(await readFile(path, 'utf8')) as SessionsFile).sessions;
}

/** 写せるかを確かめ、写すセッションと写さないセッションに分ける(点検とアップロードで同じ条件) */
async function prepare(p: GroupUploadPaths, g: UploadTarget, root: string): Promise<Prepared> {
  const name = g.name;
  // 基底のフォルダは作らない(ネットワークドライブの切断やドライブ名の違いで、思わぬ場所に作らないように)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`アップロード先のフォルダが見つかりません: ${root}(フォルダを作るか、場所を選び直してください)`);
  const stateDir = join(p.snapshot, 'session-state');
  if (!existsSync(stateDir)) throw new Error(`${stateDir} がありません。先に集計してください(atlas.bat か atlas all)`);
  // 1 件も写せないなら、フォルダを作らず README も書き直さない(前に写したものの一覧が「0 件」で上書きされないように)
  if (!g.ids.some((id) => SAFE_ID.test(id) && existsSync(join(stateDir, id))))
    throw new Error(`${KIND_LABEL[g.kind]}「${name}」のセッション(${g.ids.length} 件)は、前回の集計に 1 件もありません。先に集計し直してください(何も写していません)`);
  // groups.json は手で書けるので、フォルダの外を指す id(.. や区切りを含むもの)は写さない(元にも先にも触れない)
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of g.ids) (SAFE_ID.test(id) && existsSync(join(stateDir, id)) ? present : missing).push(id);
  return { g, stateDir, dir: uploadDir(root, name), present, missing };
}

/** グループを写す前の点検 */
export async function checkUpload(p: GroupUploadPaths, name: string, root: string): Promise<UploadCheck> {
  return checkTarget(p, await groupTarget(p, name), root);
}

/** 写す前の点検(大きさと秘密らしい文字列)。何も写さない */
export async function checkTarget(p: GroupUploadPaths, target: UploadTarget, root: string): Promise<UploadCheck> {
  const { stateDir, dir, present, missing } = await prepare(p, target, root);
  const name = target.name;
  const tops: UploadCheck['largest'] = [];
  const hits: UploadCheck['secrets']['files'] = [];
  const kinds = new Map<string, number>();
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  for (const id of present) {
    const base = join(stateDir, id);
    for (const f of await listFiles(base)) {
      bytes += f.bytes;
      files++;
      const top = f.rel.split('/')[0];
      const t = tops.find((x) => x.id === id && x.path === top);
      if (t) t.bytes += f.bytes;
      else tops.push({ id, path: top, bytes: f.bytes });
      const found = await scanSecrets(join(base, f.rel));
      if (found == null) {
        skipped++;
        continue;
      }
      let n = 0;
      for (const [label, c] of found) {
        kinds.set(label, (kinds.get(label) ?? 0) + c);
        n += c;
      }
      if (n) hits.push({ id, path: f.rel, count: n });
    }
  }
  const manifest = await readSnapshotManifest(p.snapshot);
  return {
    name,
    dir,
    sessions: present.length,
    missing,
    replace: present.filter((id) => existsSync(join(dir, id))).length,
    bytes,
    files,
    largest: tops.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    secrets: {
      count: [...kinds.values()].reduce((a, b) => a + b, 0),
      kinds: [...kinds].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      files: hits.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id) || a.path.localeCompare(b.path)).slice(0, 10),
      skipped,
    },
    snapshotAt: manifest?.createdAt ?? null,
  };
}

export async function uploadGroup(
  p: GroupUploadPaths,
  name: string,
  root: string,
  log: (m: string) => void = () => {},
  opts: { onProgress?: (p: UploadProgress) => void } = {},
): Promise<GroupUploadResult> {
  return uploadTarget(p, await groupTarget(p, name), root, log, opts);
}

/** まとまり(グループかプロジェクト)のセッションを <基底>/<名前>/<セッション id>/ に写す */
export async function uploadTarget(
  p: GroupUploadPaths,
  target: UploadTarget,
  root: string,
  log: (m: string) => void = () => {},
  opts: { onProgress?: (p: UploadProgress) => void } = {},
): Promise<GroupUploadResult> {
  const { g, stateDir, dir, present, missing } = await prepare(p, target, root);
  const name = target.name;
  const manifest = await readSnapshotManifest(p.snapshot);
  await mkdir(dir, { recursive: true });
  const storeDb = join(p.snapshot, 'session-store.db');
  // デスクトップアプリのセッションは題名・モデル・トークン数などが data.db にしかない(snapshot が許可リストの列だけを desktop.json に書いたもの)
  const desktop = await readDesktopJson(join(p.snapshot, DESKTOP_JSON));
  const memoDir = p.notes ? memosDir(p.notes) : null;
  const done: string[] = [];
  const withMemo = new Set<string>();
  let uploaded = 0;
  let replaced = 0;
  // 進み具合はバイト数で出す(大きなセッションは 1 件で数百 MB になり、件数だけでは止まって見えるため)
  const lists = new Map<string, FileEntry[]>();
  for (const id of present) lists.set(id, await listFiles(join(stateDir, id)));
  const progress: UploadProgress = { sessions: present.length, done: 0, bytes: [...lists.values()].flat().reduce((a, f) => a + f.bytes, 0), copied: 0, current: null };
  const report = (): void => opts.onProgress?.({ ...progress });
  for (const id of present) {
    const src = join(stateDir, id);
    const dest = join(dir, id);
    progress.current = id;
    report();
    // 書きかけのフォルダを残さないよう、隣に写し終えてから置き換える
    const tmp = join(dir, `.${id}.uploading`);
    await rm(tmp, { recursive: true, force: true });
    try {
      await copyFiles(src, tmp, lists.get(id) ?? [], (n) => {
        progress.copied += n;
        report();
      });
      const rows = await sessionStoreRows(storeDb, id);
      const desk = desktop ? desktopForSession(desktop, id) : null;
      if (rows || desk) {
        const j: SessionStoreJson = { ...(rows ?? { version: 1, schemaVersion: null, sessions: [], turns: [], usage: [], files: [] }), ...(desk ? { desktop: desk } : {}) };
        await writeFile(join(tmp, SESSION_STORE_JSON), `${JSON.stringify(j)}\n`);
      }
      if (memoDir && (await copyMemo(memoDir, id, tmp))) withMemo.add(id);
      const had = existsSync(dest);
      // 前のフォルダは先に消さず、名前を変えて退ける(中のファイルが開かれていて動かせなければ、ここで止まり前のフォルダはそのまま残る)。
      // 新しいフォルダを置けなければ前のフォルダを戻す。退けたものは最後に消す
      const old = join(dir, `.${id}.old`);
      if (had) {
        await rm(old, { recursive: true, force: true });
        await renameReplacing(dest, old);
      }
      try {
        await renameReplacing(tmp, dest);
      } catch (e) {
        if (had) await renameReplacing(old, dest).catch(() => {});
        throw e;
      }
      uploaded++;
      done.push(id);
      progress.done = uploaded;
      report();
      if (had) {
        replaced++;
        await rm(old, { recursive: true, force: true }).catch((e: Error) => log(`group upload: 前のフォルダ ${old} を消せませんでした(${e.message})。手で消してください`));
      }
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`セッション ${id} を写せませんでした(${(e as Error).message})。前に写したフォルダはそのままです。写し終えたのは ${uploaded} 件です`);
    }
  }
  const snapshotAt = manifest?.createdAt ?? null;
  const records = await readRecords(p.sessions, done);
  await writeFile(join(dir, UPLOAD_README), groupReadme({ name, note: g.note, dir, done, missing, withMemo, snapshotAt, records }));
  log(`${g.kind} upload: 「${name}」 ${uploaded} セッション(置き換え ${replaced} 件・メモ ${withMemo.size} 件)→ ${dir}${missing.length ? `。前回の集計に無い ${missing.length} 件は写していません` : ''}`);
  return { name, dir, uploaded, replaced, missing, snapshotAt, memos: withMemo.size };
}

/**
 * そのセッションのメモ(<notes>/memos/<id>.md)と画像(<id>/)を、写すフォルダの atlas-memo.md と atlas-memo/ に入れる。
 * 本文の画像の参照(<id>/<名前>)は atlas-memo/<名前> に直す(エクスプローラーや Markdown のビューアでそのまま読めるように)。
 * メモが無ければ false
 */
async function copyMemo(memoDir: string, id: string, into: string): Promise<boolean> {
  const memo = await readMemo(memoDir, id);
  if (!memo || !memo.text.trim()) return false;
  const images = join(memoDir, id);
  if (existsSync(images) && statSync(images).isDirectory()) await cp(images, join(into, UPLOAD_MEMO_IMAGES), { recursive: true });
  // id は SAFE_ID(英数字・_・-)なので、そのまま正規表現に入れてよい
  const text = memo.text.replace(new RegExp(`(\\]\\()(\\./)?${id}/`, 'g'), `$1${UPLOAD_MEMO_IMAGES}/`);
  await writeFile(join(into, UPLOAD_MEMO_FILE), text);
  return true;
}

/** README に載せる題名と日付のため、sessions.json から写したセッションだけを拾う。読めなければ空 */
async function readRecords(path: string | undefined, ids: string[]): Promise<Map<string, SessionRecord>> {
  const out = new Map<string, SessionRecord>();
  if (!path || !existsSync(path) || !ids.length) return out;
  try {
    const want = new Set(ids);
    for (const s of (JSON.parse(await readFile(path, 'utf8')) as SessionsFile).sessions) if (want.has(s.id)) out.set(s.id, s);
  } catch {
    /* README は ID だけになる */
  }
  return out;
}

/** 表のセルに入れる文字(| と改行で表を崩さない) */
const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** 日時を、この PC の時刻で「2026-11-09 10:05」にする */
function localTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** グループのフォルダの README.md(写すたびに書き直す)。人が開いて、何のまとまりか・どれにメモがあるかが分かるように */
export function groupReadme(o: {
  name: string;
  note: string;
  dir: string;
  done: string[];
  missing: string[];
  withMemo: Set<string>;
  snapshotAt: string | null;
  records: Map<string, SessionRecord>;
  now?: Date;
}): string {
  const lines = [`# ${o.name}`, ''];
  lines.push(o.note.trim() ? o.note.trim() : '(グループの説明はありません。atlas の画面のグループの見出しで書けます)', '');
  lines.push(
    `- アップロードした日時: ${localTime((o.now ?? new Date()).toISOString())}`,
    `- ログの時点: ${o.snapshotAt ? `${localTime(o.snapshotAt)} の集計` : '不明'}`,
    `- セッション: ${o.done.length} 件(うちメモあり ${o.withMemo.size} 件)`,
    '',
    'この README はアップロードするたびに書き直します。このフォルダには、ほかの人やほかの回に写したセッションのフォルダもあることがあります。',
    '',
    '| セッション ID | 題名 | 最終更新 | メモ |',
    '| --- | --- | --- | --- |',
  );
  for (const id of o.done) {
    const r = o.records.get(id);
    // name はデスクトップアプリの題名も反映済み(extract の sessionName)
    const title = r ? cell(truncate(r.name || r.firstUserMessage || '', 60)) : '';
    const memo = o.withMemo.has(id) ? `[あり](${id}/${UPLOAD_MEMO_FILE})` : '';
    lines.push(`| [${id}](${id}/) | ${title || '-'} | ${localTime(r?.updatedAt ?? null)} | ${memo || '-'} |`);
  }
  if (o.missing.length) lines.push('', `グループにあっても、前回の集計に無かったため写していないもの: ${o.missing.map((x) => `\`${cell(x)}\``).join(', ')}`);
  lines.push(
    '',
    '## 集計し直すには',
    '',
    'agent-session-atlas のフォルダで、次を実行します(出力先は好きな場所に)。',
    '',
    '```',
    `npm run atlas -- all --home "${o.dir}" --out "<出力先>"`,
    '```',
    '',
    `メモ(各セッションのフォルダの ${UPLOAD_MEMO_FILE})は、集計し直した画面には出ません。ファイルを開いて読んでください。`,
    '',
  );
  return lines.join('\n');
}

/** snapshot の desktop.json を読む。無いか読めなければ null(添えないだけで、アップロードは止めない) */
async function readDesktopJson(path: string): Promise<DesktopData | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DesktopData;
  } catch {
    return null;
  }
}
