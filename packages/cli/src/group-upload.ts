// グループのアップロード: グループのセッションの生ログを、決めておいた場所へタスク(グループ)ごとに写す。
//   <基底>/<グループ名>/<セッション id>/events.jsonl            ← Copilot のセッションのフォルダ(前回の集計で複製したもの)
//                                      workspace.yaml / session.db / plan.md / checkpoints/ / files/ …
//                                      atlas-session-store.json   ← session-store.db と data.db(許可リストの列)のそのセッションの行(atlas が添える)
//                                      atlas-memo.md / atlas-memo/ ← そのセッションのメモと画像(atlas-notes/memos/。あれば)
//   <基底>/<グループ名>/README.md                                 ← グループ名・説明・写した日時・セッションの一覧(写すたびに書き直す)
// 同じセッションのフォルダは丸ごと置き換える。グループから外したセッションや、他の人が写したセッションのフォルダには触れない
// (同じ場所を何人かで使うため)。受け取った側は `atlas all --home <基底>/<グループ名>` でそのまま集計できる。
// 元(~/.copilot)は読まず、前回の集計で out/snapshot/ に複製したものを写す(SQLite は一貫した複製を取ってあるため)。
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESKTOP_JSON, desktopForSession, readSnapshotManifest, SESSION_STORE_JSON, sessionStoreRows, type DesktopData, type SessionStoreJson } from '../../core/src/index.ts';
import type { SessionRecord, SessionsFile } from '../../core/src/index.ts';
import { loadGroups, memosDir, readMemo } from '../../report/src/index.ts';
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

/** アップロード先のグループのフォルダ(<基底>/<グループ名>)。フォルダ名に使えない文字は _ にする */
export function uploadDir(root: string, name: string): string {
  return join(root, safeDirName(name));
}

export async function uploadGroup(p: GroupUploadPaths, name: string, root: string, log: (m: string) => void = () => {}): Promise<GroupUploadResult> {
  const loaded = await loadGroups(p.groups);
  const g = loaded.groups.find((x) => x.name === name);
  if (!g) throw new Error(`グループ「${name}」はありません${loaded.groups.length ? `(あるのは: ${loaded.groups.map((x) => x.name).join(', ')})` : ''}`);
  if (g.ids.length === 0) throw new Error(`グループ「${name}」にセッションがありません`);
  // 基底のフォルダは作らない(ネットワークドライブの切断やドライブ名の違いで、思わぬ場所に作らないように)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`アップロード先のフォルダが見つかりません: ${root}(フォルダを作るか、場所を選び直してください)`);
  const stateDir = join(p.snapshot, 'session-state');
  if (!existsSync(stateDir)) throw new Error(`${stateDir} がありません。先に集計してください(atlas.bat か atlas all)`);
  const manifest = await readSnapshotManifest(p.snapshot);
  const dir = uploadDir(root, name);
  await mkdir(dir, { recursive: true });
  const storeDb = join(p.snapshot, 'session-store.db');
  // デスクトップアプリのセッションは題名・モデル・トークン数などが data.db にしかない(snapshot が許可リストの列だけを desktop.json に書いたもの)
  const desktop = await readDesktopJson(join(p.snapshot, DESKTOP_JSON));
  const memoDir = p.notes ? memosDir(p.notes) : null;
  const missing: string[] = [];
  const done: string[] = [];
  const withMemo = new Set<string>();
  let uploaded = 0;
  let replaced = 0;
  for (const id of g.ids) {
    const src = join(stateDir, id);
    // groups.json は手で書けるので、フォルダの外を指す id(.. や区切りを含むもの)は写さない(元にも先にも触れない)
    if (!SAFE_ID.test(id) || !existsSync(src)) {
      missing.push(id);
      continue;
    }
    const dest = join(dir, id);
    // 書きかけのフォルダを残さないよう、隣に写し終えてから置き換える
    const tmp = join(dir, `.${id}.uploading`);
    await rm(tmp, { recursive: true, force: true });
    try {
      await cp(src, tmp, { recursive: true, filter: (from) => !SNAPSHOT_PRIVATE.test(from.split(/[\\/]/).pop() ?? '') });
      const rows = await sessionStoreRows(storeDb, id);
      const desk = desktop ? desktopForSession(desktop, id) : null;
      if (rows || desk) {
        const j: SessionStoreJson = { ...(rows ?? { version: 1, schemaVersion: null, sessions: [], turns: [], usage: [], files: [] }), ...(desk ? { desktop: desk } : {}) };
        await writeFile(join(tmp, SESSION_STORE_JSON), `${JSON.stringify(j)}\n`);
      }
      if (memoDir && (await copyMemo(memoDir, id, tmp))) withMemo.add(id);
      const had = existsSync(dest);
      if (had) await rm(dest, { recursive: true, force: true });
      await rename(tmp, dest);
      uploaded++;
      done.push(id);
      if (had) replaced++;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`セッション ${id} を写せませんでした(${(e as Error).message})。写し終えたのは ${uploaded} 件です`);
    }
  }
  const snapshotAt = manifest?.createdAt ?? null;
  const records = await readRecords(p.sessions, done);
  await writeFile(join(dir, UPLOAD_README), groupReadme({ name, note: g.note, dir, done, missing, withMemo, snapshotAt, records }));
  log(`group upload: 「${name}」 ${uploaded} セッション(置き換え ${replaced} 件・メモ ${withMemo.size} 件)→ ${dir}${missing.length ? `。前回の集計に無い ${missing.length} 件は写していません` : ''}`);
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
    // デスクトップアプリのセッションは name が「New session」のままで、題名は data.db にある
    const desk = r?.desktop?.session?.title;
    const title = r ? cell(truncate((typeof desk === 'string' && desk) || r.name || r.firstUserMessage || '', 60)) : '';
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
