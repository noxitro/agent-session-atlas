// プロジェクトのセッションをまとめて送る(upload-project.bat から、集計の後に呼ぶ)。
// 集計のプロジェクト(プロジェクト別の表と同じ単位)を番号で選び、そのセッションの生ログを <送り先>/<プロジェクト名>/<セッション id>/ に写す。
// 送り先は一度選んだら atlas.config.json の uploadRoot に覚える(画面のグループのアップロードと共通)。まだ無ければエクスプローラーで選ぶ。
// 送る前に毎回、送り先・件数・大きさ・秘密らしい文字列を見せて確認する(y で送る / c で送り先を選び直す / それ以外はやめる)。
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig, updateConfig } from './config.ts';
import { pickFolder } from './folder-picker.ts';
import { resolvePaths } from './commands.ts';
import { acquireOutLock, OutBusyError } from './jobs.ts';
import { dateTime } from '../../report/src/lib/format.ts';
import { checkTarget, listProjects, projectTarget, readSessions, UploadChangedError, uploadTarget, type GroupUploadPaths, type GroupUploadResult, type UploadCheck } from './group-upload.ts';

export interface UploadProjectIo {
  ask: (q: string) => Promise<string>;
  print: (line: string) => void;
  /** 送り先のフォルダを選んでもらう(取り消しは null) */
  pick: (initial: string | null) => Promise<string | null>;
}

const size = (b: number): string => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '日付不明');

/** 送り先を選んでもらい、設定に覚える。取り消したら null */
async function chooseRoot(io: UploadProjectIo, configPath: string, current: string | null): Promise<string | null> {
  io.print('送り先のフォルダを選ぶ画面を開きます(見えないときはタスクバーを確かめてください)。');
  const r = await io.pick(current);
  if (!r) return null;
  if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error(`フォルダが見つかりません: ${r}`);
  await updateConfig(configPath, 'uploadRoot', r);
  io.print(`送り先を覚えました: ${r}(${configPath} の uploadRoot。画面のアップロードでも使います)`);
  return r;
}

function describe(io: UploadProjectIo, c: UploadCheck): void {
  io.print(`  送り先: ${c.dir}`);
  io.print(`  ${c.sessions} セッション・合計 ${size(c.bytes)}(${c.files} ファイル)${c.replace ? `。うち ${c.replace} 件は前に送ったものを置き換えます` : ''}`);
  if (c.snapshotAt) io.print(`  送るのは ${dateTime(c.snapshotAt)} の集計の時点のログです`);
  if (c.largest.length) io.print(`  大きいもの: ${c.largest.slice(0, 3).map((x) => `${x.id.slice(0, 8)}…/${x.path} ${size(x.bytes)}`).join('、')}`);
  if (c.secrets.count) {
    io.print(`  注意: 秘密らしい文字列が ${c.secrets.count} 件あります(${c.secrets.kinds.map((k) => `${k.label} ${k.count}`).join('・')}。偽陽性もありえます)`);
    for (const f of c.secrets.files) io.print(`    ${f.id}/${f.path}: ${f.count} 件`);
    io.print('  生ログはそのまま写ります。送り先で見られる人を確かめてください。本物の鍵なら、送るかどうかに関わらず作り直してください。');
  }
}

/**
 * 集計の作業中を示すロック(out/.job.json)を取って fn を動かす。画面の「集計し直す」と重なると、写す元(out/snapshot/)が書き換わるため。
 * 入力を待つ間は持たない(画面の操作を長く止めないように)
 */
async function withOutLock<T>(outDir: string, fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  try {
    release = acquireOutLock(outDir, 'project upload', 'cli');
  } catch (e) {
    if (e instanceof OutBusyError) throw new Error(`${e.message}(何も送っていません)`);
    throw e;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 対話の本体。送ったら true、やめたら false */
export async function runUploadProject(io: UploadProjectIo, o: { paths: GroupUploadPaths & { sessions: string }; configPath: string }): Promise<boolean> {
  const outDir = dirname(o.paths.snapshot);
  // sessions.json は 1 回だけ読み、一覧・送るまとまり・README で使い回す(実データでは十数 MB ある)
  const records = await readSessions(o.paths.sessions);
  const projects = await listProjects(records, o.paths.snapshot);
  if (!projects.length) {
    io.print('送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)。');
    return false;
  }
  io.print('プロジェクト(集計のプロジェクト別と同じ単位。空のセッションは数えません):');
  projects.forEach((p, i) =>
    io.print(`  ${String(i + 1).padStart(3)}. ${p.name}  ${p.sessions} 件  最終更新 ${day(p.updatedAt)}${p.noLog ? `(ほかにログのフォルダが無いので送れないもの ${p.noLog} 件)` : ''}`),
  );
  const answer = await io.ask('送るプロジェクトの番号を入れて Enter(やめるなら何も入れずに Enter): ');
  if (!answer) {
    io.print('やめました(何も送っていません)。');
    return false;
  }
  const n = Number(answer);
  const chosen = Number.isInteger(n) && n >= 1 && n <= projects.length ? projects[n - 1] : projects.find((p) => p.name === answer);
  if (!chosen) throw new Error(`「${answer}」に当たるプロジェクトがありません(何も送っていません)`);
  const target = await projectTarget(o.paths, chosen.name, records);

  let root = (await loadConfig(o.configPath, false)).uploadRoot;
  // 覚えた送り先が無い(ネットワークドライブの切断・フォルダの削除)ときも、ここで選び直せるようにする
  if (root && !(existsSync(root) && statSync(root).isDirectory())) {
    io.print(`覚えている送り先が見つかりません: ${root}(ドライブがつながっているか確かめるか、選び直してください)`);
    root = null;
  }
  if (!root) {
    io.print('送り先を選んでください。');
    root = await chooseRoot(io, o.configPath, null);
    if (!root) {
      io.print('送り先を選ばなかったので、やめました(何も送っていません)。');
      return false;
    }
  }
  // 送る前に毎回確かめる(送り先は覚えたものを使うので、違っていたらここで選び直す)。
  // 入力を待つ間はロックを放すので、写すときに確かめた中身と同じかを見直し、変わっていたら(集計し直したなど)もう一度確かめる
  let r: GroupUploadResult;
  for (;;) {
    io.print(`「${chosen.name}」を送る前に確かめてください(調べています…)`);
    const r0 = root;
    const c = await withOutLock(outDir, () => checkTarget(o.paths, target, r0));
    describe(io, c);
    const a = (await io.ask('送るなら y、送り先を選び直すなら c、やめるなら Enter: ')).toLowerCase();
    if (a === 'c') {
      const picked = await chooseRoot(io, o.configPath, root);
      if (picked) root = picked;
      continue;
    }
    if (a !== 'y') {
      io.print('やめました(何も送っていません)。');
      return false;
    }
    let last = -1;
    try {
      r = await withOutLock(outDir, () =>
        uploadTarget(o.paths, target, r0, () => {}, {
          expect: c.fingerprint,
          sessions: records,
          onProgress: (p) => {
            const pct = p.bytes ? Math.floor((p.copied / p.bytes) * 10) * 10 : 0;
            if (pct !== last) {
              last = pct;
              io.print(`  写しています: ${p.done} / ${p.sessions} セッション(${size(p.copied)} / ${size(p.bytes)})`);
            }
          },
        }),
      );
    } catch (e) {
      if (!(e instanceof UploadChangedError)) throw e;
      io.print(e.message);
      continue;
    }
    break;
  }
  io.print(`送りました: ${r.uploaded} セッション${r.memos ? `・メモ ${r.memos} 件` : ''}${r.replaced ? `(うち ${r.replaced} 件は置き換え)` : ''} → ${r.dir}`);
  io.print('プロジェクトの説明とセッションの一覧は、そのフォルダの README.md にあります。');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 置き場は atlas.bat と同じ既定(out/ と atlas-notes/)
  const paths = resolvePaths({ home: null, out: null, judgments: null });
  // rl.question は入力を流し込んだとき(パイプ)に、尋ねる前に届いた行を落とすので、行の反復子から 1 行ずつ読む
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const io: UploadProjectIo = {
    ask: async (q) => {
      process.stdout.write(q);
      const r = await lines.next();
      return r.done ? '' : r.value.trim();
    },
    print: (l) => process.stdout.write(`${l}\n`),
    pick: (initial) => pickFolder('プロジェクトのセッションを送る先のフォルダを選んでください', initial),
  };
  try {
    await runUploadProject(io, {
      paths,
      configPath: defaultConfigPath(),
    });
    process.exitCode = 0;
  } catch (e) {
    process.stderr.write(`upload-project: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
