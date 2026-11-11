// グループのアップロード: グループのセッションの生ログを、決めておいた場所へタスク(グループ)ごとに写す。
//   <基底>/<グループ名>/<セッション id>/events.jsonl            ← Copilot のセッションのフォルダ(前回の集計で複製したもの)
//                                      workspace.yaml / session.db / plan.md / checkpoints/ / files/ …
//                                      atlas-session-store.json   ← session-store.db と data.db(許可リストの列)のそのセッションの行(atlas が添える)
//                                      atlas-memo.md / atlas-memo/ ← そのセッションのメモと画像(atlas-notes/memos/。あれば)
//   <基底>/<グループ名>/README.md                                 ← グループ名・説明・写した日時・セッションの一覧(写すたびに書き直す)
// 同じセッションのフォルダは丸ごと置き換える。グループから外したセッションや、ほかの回・ほかの PC から写したセッションのフォルダには触れない
// (前に写したものを消さないため)。送った先は `atlas all --home <基底>/<グループ名>` でそのまま集計できる。
// 元(~/.copilot)は読まず、前回の集計で out/snapshot/ に複製したものを写す(SQLite は一貫した複製を取ってあるため)。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DESKTOP_JSON, desktopForSession, openSessionStoreReader, readSnapshotManifest, renameReplacing, SESSION_STORE_JSON, type DesktopData, type SessionStoreJson } from '../../core/src/index.ts';
import type { SessionRecord, SessionsFile } from '../../core/src/index.ts';
import { loadGroups, memosDir, readMemo, SECRET_PATTERNS } from '../../report/src/index.ts';
import { dateTime, truncate } from '../../report/src/lib/format.ts';
import { safeDirName } from './group-export.ts';

/** スナップショットのセッションのフォルダにある、atlas の作業用のファイル(写さない) */
const SNAPSHOT_PRIVATE = /^\.session\.db\.src$/;
/** セッション id として写してよい名前(Copilot の id は英数字と - だけ。. で始まるもの・区切りを含むものは除く) */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** セッションのフォルダに添えるメモ(本文)と、その画像のフォルダ */
export const UPLOAD_MEMO_FILE = 'atlas-memo.md';
export const UPLOAD_MEMO_IMAGES = 'atlas-memo';
/** グループ・プロジェクトのフォルダの説明(人が読む) */
export const UPLOAD_README = 'README.md';
/** グループ・プロジェクトのフォルダの索引(プログラムや AI が読む。セッションごとのタスクタグ・題名・日時) */
export const UPLOAD_INDEX = 'atlas-index.json';
/** セッションのフォルダに添える、そのセッションのタスクタグ・題名・日時(1 つのフォルダだけを渡されても分かるように) */
export const UPLOAD_SESSION_META = 'atlas-session.json';

/** 索引とセッションのフォルダに書く、1 セッション分の情報 */
export interface UploadedSession {
  id: string;
  title: string | null;
  project: string | null;
  /** タスクタグ(そのセッションが入っているグループの名前)。無ければ空 */
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  memo: boolean;
}

/** タスクタグ(グループ)ごとの、入っているセッションの id。groups.json が無い・読めなければ空 */
async function tagsById(groupsPath: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    for (const g of (await loadGroups(groupsPath)).groups) for (const id of g.ids) out.set(id, [...(out.get(id) ?? []), g.name]);
  } catch {
    /* タグ無しとして書く */
  }
  return out;
}

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
  /** 置き換えた前のフォルダのうち、消せずに残ったもの(送り先で開かれていたなど。手で消してもらう) */
  leftovers: string[];
}

interface FileEntry {
  /** セッションのフォルダからの相対パス(区切りは /) */
  rel: string;
  bytes: number;
  /** シンボリックリンク(中身は辿らず、リンクのまま写す) */
  link: boolean;
  /** 空のフォルダ(中身が無くても形を保つ。以前の cp と同じ) */
  dir?: boolean;
}

/** セッションのフォルダの中のファイル(atlas の作業用のファイルは除く) */
async function listFiles(base: string, sub = ''): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const e of await readdir(join(base, sub), { withFileTypes: true })) {
    if (SNAPSHOT_PRIVATE.test(e.name)) continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const inner = await listFiles(base, rel);
      out.push(...(inner.length ? inner : [{ rel, bytes: 0, link: false, dir: true }]));
    }
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
    if (f.dir) await mkdir(to, { recursive: true });
    else if (f.link) await cp(from, to, { verbatimSymlinks: true });
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
  /** carry の先頭のうち、前の塊で数え終えた文字数(\b が前の文字を見られるよう 1 文字だけ持ち越す) */
  let from = 0;
  // 塊ごとに、重ねる部分より前で始まるものだけを数える(重ねた部分は次の塊で数える)。最後の塊は末尾まで数える
  const scan = (text: string, last: boolean): void => {
    const limit = last ? text.length : text.length - SCAN_OVERLAP;
    for (const [label, re] of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) if (m.index >= from && m.index < limit) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const keep = Math.max(0, limit - 1);
    carry = last ? '' : text.slice(keep);
    from = last ? 0 : limit - keep;
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    const text = carry + decoder.write(chunk as Buffer);
    if (text.length > SCAN_OVERLAP + from) scan(text, false);
    else carry = text;
  }
  scan(carry + decoder.end(), true);
  return counts;
}

/** 文字列の中の秘密らしい文字列を種類ごとに数える(atlas が足して写すもの: DB の行・メモ) */
function countSecrets(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [label, re] of SECRET_PATTERNS) {
    const n = [...text.matchAll(re)].length;
    if (n) counts.set(label, n);
  }
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
  /**
   * この点検の指紋(セッション数・ファイル数・大きさ・秘密らしい文字列の数)。写すときに渡すと、写す直前に点検し直して違えば写さない
   * (確認してから写すまでの間に集計し直してログが変わると、点検していない中身を写してしまうため)
   */
  fingerprint: string;
}

/** 確認してから写すまでの間に、写す中身が変わった(写していない) */
export class UploadChangedError extends Error {
  constructor() {
    super('確かめた後に、写すログが変わりました(集計し直したなど)。何も写していません。もう一度確かめてください');
  }
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

/** 確認に「大きいもの」を出す目安 */
export const UPLOAD_CONFIRM_BYTES = 100 * 1024 * 1024;

/** 写すセッションのまとまり(グループか、集計のプロジェクト)。名前がアップロード先のフォルダ名になる */
export interface UploadTarget {
  kind: 'group' | 'project';
  name: string;
  /** README に書く説明 */
  note: string;
  ids: string[];
}

const KIND_LABEL: Record<UploadTarget['kind'], string> = { group: 'タスクタグ', project: 'プロジェクト' };

interface Prepared {
  g: UploadTarget;
  stateDir: string;
  dir: string;
  present: string[];
  missing: string[];
}

/** groups.json のグループ(画面ではタスクタグ)を、写すまとまりにする(無い・空・フォルダ名が別のタグと同じなら止まる) */
export async function groupTarget(p: Pick<GroupUploadPaths, 'groups'>, name: string): Promise<UploadTarget> {
  const loaded = await loadGroups(p.groups);
  const g = loaded.groups.find((x) => x.name === name);
  if (!g) throw new Error(`タスクタグ「${name}」はありません${loaded.groups.length ? `(あるのは: ${loaded.groups.map((x) => x.name).join(', ')})` : ''}`);
  if (g.ids.length === 0) throw new Error(`タスクタグ「${name}」にセッションがありません`);
  // フォルダ名に直すと同じになる別のタスクタグ(Player/Weapon と Player_Weapon。Windows は大文字小文字も区別しない)があれば、混ざるので写さない
  // (プロジェクトや、ほかの PC から送ったものとの衝突は、送り先のフォルダの索引で見る。prepare)
  const folder = safeDirName(name);
  const clash = loaded.groups.find((x) => x.name !== name && safeDirName(x.name).toLowerCase() === folder.toLowerCase());
  if (clash) throw new Error(`タスクタグ「${name}」と「${clash.name}」は、アップロード先のフォルダ名が同じ「${folder}」になります。どちらかの名前を変えてください`);
  return { kind: 'group', name, note: g.note, ids: g.ids };
}

export interface ProjectSummary {
  name: string;
  /** 送れるセッション(空でなく、前回の集計の複製にログのフォルダがあるもの) */
  sessions: number;
  /** 記録はあるが、ログのフォルダが無いので送れないもの(session-store.db にだけ残っているセッション) */
  noLog: number;
  updatedAt: string | null;
}

/** sessions.json のセッションの記録。無ければ止まる(先に集計してもらう) */
export async function readSessions(path: string): Promise<SessionRecord[]> {
  if (!existsSync(path)) throw new Error(`${path} がありません。先に集計してください(atlas.bat か atlas all)`);
  return (JSON.parse(await readFile(path, 'utf8')) as SessionsFile).sessions;
}

/**
 * 集計のプロジェクト(sessions.json の project。プロジェクト別の表と同じ単位)ごとの、送れるセッションの数と最終更新。多い順。
 * snapshot を渡すと、ログのフォルダがあるものだけを数え、無いものは noLog に分ける(一覧の件数と確認の件数を揃える)。
 * sessions には sessions.json のパスか、読み込み済みの記録を渡す(何度も読まないように)
 */
export async function listProjects(sessions: string | SessionRecord[], snapshot?: string): Promise<ProjectSummary[]> {
  const stateDir = snapshot ? join(snapshot, 'session-state') : null;
  const by = new Map<string, { sessions: number; noLog: number; updatedAt: string | null }>();
  for (const s of typeof sessions === 'string' ? await readSessions(sessions) : sessions) {
    if (s.empty || typeof s.project !== 'string') continue;
    const x = by.get(s.project) ?? { sessions: 0, noLog: 0, updatedAt: null };
    if (stateDir && !(SAFE_ID.test(s.id) && existsSync(join(stateDir, s.id)))) x.noLog++;
    else {
      x.sessions++;
      if (s.updatedAt && (!x.updatedAt || s.updatedAt > x.updatedAt)) x.updatedAt = s.updatedAt;
    }
    by.set(s.project, x);
  }
  return [...by]
    .map(([name, x]) => ({ name, ...x }))
    .filter((x) => x.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

/** 集計のプロジェクトの、送れるセッション(空でなく、ログのフォルダがあるもの)を、写すまとまりにする。sessions は読み込み済みの記録(無ければ読む) */
export async function projectTarget(p: Pick<GroupUploadPaths, 'snapshot'> & { sessions: string }, name: string, sessions?: SessionRecord[]): Promise<UploadTarget> {
  const stateDir = join(p.snapshot, 'session-state');
  const ids = (sessions ?? (await readSessions(p.sessions))).filter((s) => s.project === name && !s.empty && SAFE_ID.test(s.id) && existsSync(join(stateDir, s.id))).map((s) => s.id);
  if (!ids.length) throw new Error(`プロジェクト「${name}」の送れるセッションは、前回の集計にありません(空のセッションと、ログのフォルダが無いものは送りません)`);
  return { kind: 'project', name, note: `集計のプロジェクト「${name}」のセッション(空のものとログのフォルダが無いものを除く ${ids.length} 件)`, ids };
}

/** 送り先のフォルダの索引(前に送ったときに書いたもの)。無いか読めなければ null */
async function readIndex(dir: string): Promise<{ kind: UploadTarget['kind']; name: string; uploadedAt: string | null } | null> {
  const path = join(dir, UPLOAD_INDEX);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(await readFile(path, 'utf8')) as { kind?: unknown; name?: unknown; uploadedAt?: unknown };
    if ((j.kind !== 'group' && j.kind !== 'project') || typeof j.name !== 'string') return null;
    return { kind: j.kind, name: j.name, uploadedAt: typeof j.uploadedAt === 'string' ? j.uploadedAt : null };
  } catch {
    return null;
  }
}

/** 送り先のフォルダに前に送ったときの日時(索引の uploadedAt)。無ければ null */
export async function uploadedAt(root: string, name: string): Promise<string | null> {
  return (await readIndex(uploadDir(root, name)))?.uploadedAt ?? null;
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
  const dir = uploadDir(root, name);
  // 送り先のフォルダに、別のもの(フォルダ名が同じになる別のタスクタグ・プロジェクト)がすでに送られていれば、README と索引が上書きし合うので写さない。
  // 名前だけで比べると、まだ送っていない名前や 0 件のタグでも止めてしまうので、実際に送られているものを見る
  const prev = await readIndex(dir);
  if (prev && (prev.kind !== g.kind || prev.name !== name))
    throw new Error(
      `送り先のフォルダ「${dir}」には、${KIND_LABEL[prev.kind]}「${prev.name}」がすでに送られています。混ざるので写しません(${g.kind === 'group' ? 'タスクタグの名前を変えるか、' : ''}送り先を変えてください)`,
    );
  // groups.json は手で書けるので、フォルダの外を指す id(.. や区切りを含むもの)は写さない(元にも先にも触れない)
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of g.ids) (SAFE_ID.test(id) && existsSync(join(stateDir, id)) ? present : missing).push(id);
  return { g, stateDir, dir, present, missing };
}

/** グループ(タスクタグ)を写す前の点検 */
export async function checkUpload(p: GroupUploadPaths, name: string, root: string): Promise<UploadCheck> {
  return checkTarget(p, await groupTarget(p, name), root);
}

/** atlas がセッションのフォルダに足して写すもの(session-store.db と data.db の行、メモと画像)を作る道具。点検とアップロードで共通。使い終わったら close */
/** atlas が足して写すもの(DB の行・メモと画像)を読む口。session-store.db を開いたままにするので、使い終わったら close する */
export interface UploadContext {
  /** atlas-session-store.json の中身(DB にも data.db にも行が無ければ null) */
  storeJson: (id: string) => string | null;
  /** メモの本文(無いか空なら null) */
  memo: (id: string) => Promise<string | null>;
  /** メモの画像(<notes>/memos/<id>/)。メモの本文が無ければ写さないので空 */
  memoImages: (id: string) => Promise<FileEntry[]>;
  /** atlas が足して写すものの大きさの合計(本文・DB の行・画像) */
  bytes: (id: string) => Promise<number>;
  close: () => void;
}

/**
 * 点検とアップロードで共有できる、atlas が足して写すものを読む口。何プロジェクトかをまとめて点検・送るときに 1 回だけ開く
 * (session-store.db・desktop.json をまとまりごとに開き直さないように)。渡さなければ点検・アップロードがそれぞれ開いて閉じる
 */
export function openUploadContext(p: GroupUploadPaths): Promise<UploadContext> {
  return addedFiles(p);
}

async function addedFiles(p: GroupUploadPaths): Promise<UploadContext> {
  // session-store.db は 1 回だけ開く(セッションごとに開き直すと、数百件のプロジェクトで点検とアップロードが遅くなる)
  const reader = await openSessionStoreReader(join(p.snapshot, 'session-store.db'));
  // デスクトップアプリのセッションは題名・モデル・トークン数などが data.db にしかない(snapshot が許可リストの列だけを desktop.json に書いたもの)
  const desktop = await readDesktopJson(join(p.snapshot, DESKTOP_JSON));
  const memoDir = p.notes ? memosDir(p.notes) : null;
  const storeJson = (id: string): string | null => {
    const rows = reader?.rows(id) ?? null;
    const desk = desktop ? desktopForSession(desktop, id) : null;
    if (!rows && !desk) return null;
    const j: SessionStoreJson = { ...(rows ?? { version: 1, schemaVersion: null, sessions: [], turns: [], usage: [], files: [] }), ...(desk ? { desktop: desk } : {}) };
    return `${JSON.stringify(j)}\n`;
  };
  const memo = async (id: string): Promise<string | null> => {
    if (!memoDir) return null;
    const m = await readMemo(memoDir, id);
    return m && m.text.trim() ? m.text : null;
  };
  const memoImages = async (id: string): Promise<FileEntry[]> => {
    if (!memoDir || !(await memo(id))) return [];
    const dir = join(memoDir, id);
    return existsSync(dir) && statSync(dir).isDirectory() ? (await listFiles(dir)).filter((f) => !f.dir) : [];
  };
  return {
    storeJson,
    memo,
    memoImages,
    bytes: async (id) => {
      const s = storeJson(id);
      const m = await memo(id);
      return (s ? Buffer.byteLength(s) : 0) + (m ? Buffer.byteLength(m) : 0) + (await memoImages(id)).reduce((a, f) => a + f.bytes, 0);
    },
    close: () => reader?.close(),
  };
}

/** 写す前の点検(大きさと秘密らしい文字列)。何も写さない。ctx は共有する読む口(渡せば閉じない) */
export async function checkTarget(p: GroupUploadPaths, target: UploadTarget, root: string, ctx?: UploadContext): Promise<UploadCheck> {
  const { stateDir, dir, present, missing } = await prepare(p, target, root);
  const name = target.name;
  const added = ctx ?? (await addedFiles(p));
  const tops: UploadCheck['largest'] = [];
  const hits: UploadCheck['secrets']['files'] = [];
  const kinds = new Map<string, number>();
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  const tally = (id: string, path: string, found: Map<string, number>): void => {
    let n = 0;
    for (const [label, c] of found) {
      kinds.set(label, (kinds.get(label) ?? 0) + c);
      n += c;
    }
    if (n) hits.push({ id, path, count: n });
  };
  const addTop = (id: string, path: string, n: number): void => {
    const t = tops.find((x) => x.id === id && x.path === path);
    if (t) t.bytes += n;
    else tops.push({ id, path, bytes: n });
  };
  try {
    for (const id of present) {
      const base = join(stateDir, id);
      for (const f of await listFiles(base)) {
        // 空のフォルダは数えない。シンボリックリンクはリンクのまま写すので中身を開かない(リンク切れで点検が止まらないように)
        if (f.dir) continue;
        bytes += f.bytes;
        files++;
        addTop(id, f.rel.split('/')[0], f.bytes);
        if (f.link) continue;
        const found = await scanSecrets(join(base, f.rel));
        if (found == null) skipped++;
        else tally(id, f.rel, found);
      }
      // atlas が足して写すもの(DB の行には依頼文や応答の本文が入る。メモには利用者が貼ったものが入る)も調べる
      for (const [path, text] of [
        [SESSION_STORE_JSON, added.storeJson(id)],
        [UPLOAD_MEMO_FILE, await added.memo(id)],
      ] as const) {
        if (text == null) continue;
        const n = Buffer.byteLength(text);
        bytes += n;
        files++;
        addTop(id, path, n);
        tally(id, path, countSecrets(text));
      }
      // メモの画像も写すので、大きさに入れる(中身は画像なので調べない)
      for (const f of await added.memoImages(id)) {
        bytes += f.bytes;
        files++;
        skipped++;
        addTop(id, UPLOAD_MEMO_IMAGES, f.bytes);
      }
    }
  } finally {
    if (!ctx) added.close();
  }
  const manifest = await readSnapshotManifest(p.snapshot);
  const count = [...kinds.values()].reduce((a, b) => a + b, 0);
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
      count,
      kinds: [...kinds].map(([label, c]) => ({ label, count: c })).sort((a, b) => b.count - a.count),
      files: hits.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id) || a.path.localeCompare(b.path)).slice(0, 10),
      skipped,
    },
    snapshotAt: manifest?.createdAt ?? null,
    fingerprint: [present.join(','), files, bytes, count, manifest?.createdAt ?? ''].join('|'),
  };
}

export interface UploadOptions {
  onProgress?: (p: UploadProgress) => void;
  /** 確かめたときの点検の指紋(UploadCheck.fingerprint)。渡すと写す直前に点検し直し、違えば UploadChangedError で止まる(何も写さない) */
  expect?: string;
  /** 読み込み済みの sessions.json の記録(README の題名と日付に使う。無ければ読む) */
  sessions?: SessionRecord[];
  /** 共有する読む口(openUploadContext。渡せば閉じない) */
  context?: UploadContext;
}

export async function uploadGroup(p: GroupUploadPaths, name: string, root: string, log: (m: string) => void = () => {}, opts: UploadOptions = {}): Promise<GroupUploadResult> {
  return uploadTarget(p, await groupTarget(p, name), root, log, opts);
}

/** まとまり(グループかプロジェクト)のセッションを <基底>/<名前>/<セッション id>/ に写す */
export async function uploadTarget(p: GroupUploadPaths, target: UploadTarget, root: string, log: (m: string) => void = () => {}, opts: UploadOptions = {}): Promise<GroupUploadResult> {
  // 確かめてから今までに中身が変わっていたら写さない(点検していないログを写さないように)
  if (opts.expect != null && (await checkTarget(p, target, root, opts.context)).fingerprint !== opts.expect) throw new UploadChangedError();
  const { g, stateDir, dir, present, missing } = await prepare(p, target, root);
  const name = target.name;
  const manifest = await readSnapshotManifest(p.snapshot);
  await mkdir(dir, { recursive: true });
  const added = opts.context ?? (await addedFiles(p));
  const memoDir = p.notes ? memosDir(p.notes) : null;
  const done: string[] = [];
  const withMemo = new Set<string>();
  let uploaded = 0;
  let replaced = 0;
  const leftovers: string[] = [];
  const records = await readRecords(opts.sessions ?? p.sessions, present);
  const tags = await tagsById(p.groups);
  const info = (id: string): UploadedSession => {
    const r = records.get(id);
    // name はデスクトップアプリの題名も反映済み(extract の sessionName)
    return { id, title: r ? r.name || r.firstUserMessage || null : null, project: r?.project ?? null, tags: tags.get(id) ?? [], createdAt: r?.createdAt ?? null, updatedAt: r?.updatedAt ?? null, memo: withMemo.has(id) };
  };
  try {
    // 進み具合はバイト数で出す(大きなセッションは 1 件で数百 MB になり、件数だけでは止まって見えるため)。
    // 合計は点検と同じく、atlas が足して写すもの(DB の行・メモと画像)も入れる(確認の合計と揃える)
    const lists = new Map<string, FileEntry[]>();
    const extra = new Map<string, number>();
    for (const id of present) {
      lists.set(id, await listFiles(join(stateDir, id)));
      extra.set(id, await added.bytes(id));
    }
    const total = [...lists.values()].flat().reduce((a, f) => a + f.bytes, 0) + [...extra.values()].reduce((a, n) => a + n, 0);
    const progress: UploadProgress = { sessions: present.length, done: 0, bytes: total, copied: 0, current: null };
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
        const store = added.storeJson(id);
        if (store != null) await writeFile(join(tmp, SESSION_STORE_JSON), store);
        if (memoDir && (await copyMemo(memoDir, id, tmp))) withMemo.add(id);
        progress.copied += extra.get(id) ?? 0;
        report();
        await writeFile(join(tmp, UPLOAD_SESSION_META), `${JSON.stringify({ version: 1, ...info(id) }, null, 2)}\n`);
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
          await rm(old, { recursive: true, force: true }).catch((e: Error) => {
            leftovers.push(old);
            log(`${g.kind} upload: 前のフォルダ ${old} を消せませんでした(${e.message})。手で消してください`);
          });
        }
      } catch (e) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw new Error(`セッション ${id} を写せませんでした(${(e as Error).message})。前に写したフォルダはそのままです。写し終えたのは ${uploaded} 件です`);
      }
    }
  } finally {
    if (!opts.context) added.close();
  }
  const snapshotAt = manifest?.createdAt ?? null;
  const now = new Date();
  const sessions = done.map(info);
  await writeFile(join(dir, UPLOAD_README), groupReadme({ kind: g.kind, name, note: g.note, dir, sessions, missing, snapshotAt, now }));
  await writeFile(
    join(dir, UPLOAD_INDEX),
    `${JSON.stringify({ version: 1, kind: g.kind, name, note: g.note, uploadedAt: now.toISOString(), snapshotAt, sessions, missing }, null, 2)}\n`,
  );
  log(`${g.kind} upload: 「${name}」 ${uploaded} セッション(置き換え ${replaced} 件・メモ ${withMemo.size} 件)→ ${dir}${missing.length ? `。前回の集計に無い ${missing.length} 件は写していません` : ''}`);
  return { name, dir, uploaded, replaced, missing, snapshotAt, memos: withMemo.size, leftovers };
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
async function readRecords(source: string | SessionRecord[] | undefined, ids: string[]): Promise<Map<string, SessionRecord>> {
  const out = new Map<string, SessionRecord>();
  if (!source || !ids.length) return out;
  try {
    const want = new Set(ids);
    const list = typeof source === 'string' ? (existsSync(source) ? (JSON.parse(await readFile(source, 'utf8')) as SessionsFile).sessions : []) : source;
    for (const s of list) if (want.has(s.id)) out.set(s.id, s);
  } catch {
    /* README は ID だけになる */
  }
  return out;
}

/** 表のセルに入れる文字(| と改行で表を崩さない) */
const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** この PC の時刻で「YYYY-MM-DD hh:mm」(画面と同じ dateTime。無ければ -) */
const localTime = (iso: string | null): string => dateTime(iso, '-');

/** グループのフォルダの README.md(写すたびに書き直す)。人が開いて、何のまとまりか・どれにメモがあるかが分かるように */
export function groupReadme(o: {
  kind?: UploadTarget['kind'];
  name: string;
  note: string;
  dir: string;
  sessions: UploadedSession[];
  missing: string[];
  snapshotAt: string | null;
  now?: Date;
}): string {
  const kind = o.kind ?? 'group';
  const lines = [`# ${o.name}`, ''];
  lines.push(o.note.trim() ? o.note.trim() : '(グループの説明はありません。atlas の画面のタスクタグの見出しで書けます)', '');
  lines.push(
    `- アップロードした日時: ${localTime((o.now ?? new Date()).toISOString())}`,
    `- ログの時点: ${o.snapshotAt ? `${localTime(o.snapshotAt)} の集計` : '不明'}`,
    `- セッション: ${o.sessions.length} 件(うちメモあり ${o.sessions.filter((s) => s.memo).length} 件)`,
    '',
    `この README と ${UPLOAD_INDEX}(プログラムや AI が読む索引)はアップロードするたびに書き直します。このフォルダには、ほかの回やほかの PC から写したセッションのフォルダもあることがあります。`,
    `タスクタグは、atlas の画面でセッションに付けたものです(各セッションのフォルダの ${UPLOAD_SESSION_META} にもあります)。`,
    '',
    '| セッション ID | 題名 | タスクタグ | 最終更新 | メモ |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const s of o.sessions) {
    const memo = s.memo ? `[あり](${s.id}/${UPLOAD_MEMO_FILE})` : '';
    lines.push(`| [${s.id}](${s.id}/) | ${cell(truncate(s.title ?? '', 60)) || '-'} | ${s.tags.length ? cell(s.tags.join('、')) : 'タグなし'} | ${localTime(s.updatedAt)} | ${memo || '-'} |`);
  }
  // タスクごとに見分けられるよう、タグごとの一覧も書く(1 つのセッションが複数のタグに入ることがある)
  const byTag = new Map<string, UploadedSession[]>();
  for (const s of o.sessions) for (const tag of s.tags.length ? s.tags : ['']) byTag.set(tag, [...(byTag.get(tag) ?? []), s]);
  if (byTag.size > 1 || !byTag.has(o.name)) {
    lines.push('', '## タスクタグごと', '');
    const order = [...byTag.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const tag of order) {
      const list = byTag.get(tag)!;
      lines.push(`### ${tag ? cell(tag) : 'タグなし'}(${list.length} 件)`, '');
      for (const s of list) lines.push(`- [${cell(truncate(s.title ?? s.id, 60))}](${s.id}/) — ${localTime(s.updatedAt)}`);
      lines.push('');
    }
    lines.pop();
  }
  if (o.missing.length) lines.push('', `${KIND_LABEL[kind]}にあっても、前回の集計に無かったため写していないもの: ${o.missing.map((x) => `\`${cell(x)}\``).join(', ')}`);
  lines.push(
    '',
    '## 集計し直すには(読みやすい記録もここで作れます)',
    '',
    'agent-session-atlas のフォルダで、次を実行します(出力先は好きな場所に)。',
    '',
    '```',
    `npm run atlas -- all --home "${o.dir}" --out "<出力先>"`,
    '```',
    '',
    '<出力先> に、画面(atlas.html)と、セッションごとの読みやすい記録(sessions\\<セッション ID>.md。依頼・応答・ツールの経過・消費をまとめた Markdown)ができます。',
    '記録はここに送った生ログから作れるので、送るものには含めていません(送り先の容量を使わないため)。',
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
