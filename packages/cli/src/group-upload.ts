// グループのアップロード: グループのセッションの生ログを、決めておいた場所へタスク(グループ)ごとに写す。
//   <基底>/<グループ名>/<セッション id>/events.jsonl            ← Copilot のセッションのフォルダ(前回の集計で複製したもの)
//                                      workspace.yaml / session.db / plan.md / checkpoints/ / files/ …
//                                      atlas-session-store.json   ← session-store.db と data.db(許可リストの列)のそのセッションの行(atlas が添える)
// 同じセッションのフォルダは丸ごと置き換える。グループから外したセッションや、他の人が写したセッションのフォルダには触れない
// (同じ場所を何人かで使うため)。受け取った側は `atlas all --home <基底>/<グループ名>` でそのまま集計できる。
// 元(~/.copilot)は読まず、前回の集計で out/snapshot/ に複製したものを写す(SQLite は一貫した複製を取ってあるため)。
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DESKTOP_JSON, desktopForSession, readSnapshotManifest, SESSION_STORE_JSON, sessionStoreRows, type DesktopData, type SessionStoreJson } from '../../core/src/index.ts';
import { loadGroups } from '../../report/src/index.ts';
import { safeDirName } from './group-export.ts';

/** スナップショットのセッションのフォルダにある、atlas の作業用のファイル(写さない) */
const SNAPSHOT_PRIVATE = /^\.session\.db\.src$/;
/** セッション id として写してよい名前(Copilot の id は英数字と - だけ。. で始まるもの・区切りを含むものは除く) */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface GroupUploadPaths {
  /** out/snapshot(前回の集計の複製) */
  snapshot: string;
  groups: string;
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
  const missing: string[] = [];
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
      const had = existsSync(dest);
      if (had) await rm(dest, { recursive: true, force: true });
      await rename(tmp, dest);
      uploaded++;
      if (had) replaced++;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`セッション ${id} を写せませんでした(${(e as Error).message})。写し終えたのは ${uploaded} 件です`);
    }
  }
  log(`group upload: 「${name}」 ${uploaded} セッション(置き換え ${replaced} 件)→ ${dir}${missing.length ? `。前回の集計に無い ${missing.length} 件は写していません` : ''}`);
  return { name, dir, uploaded, replaced, missing, snapshotAt: manifest?.createdAt ?? null };
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
