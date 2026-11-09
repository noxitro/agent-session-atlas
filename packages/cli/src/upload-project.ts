// プロジェクトのセッションをまとめて送る(upload-project.bat から、集計の後に呼ぶ)。
// 集計のプロジェクト(プロジェクト別の表と同じ単位)を番号で選び、そのセッションの生ログを <送り先>/<プロジェクト名>/<セッション id>/ に写す。
// 送り先は一度選んだら atlas.config.json の uploadRoot に覚える(画面のグループのアップロードと共通)。まだ無ければエクスプローラーで選ぶ。
// 送る前に毎回、送り先・件数・大きさ・秘密らしい文字列を見せて確認する(y で送る / c で送り先を選び直す / それ以外はやめる)。
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig, updateConfig } from './config.ts';
import { pickFolder } from './folder-picker.ts';
import { resolvePaths } from './commands.ts';
import { checkTarget, listProjects, projectTarget, uploadTarget, type GroupUploadPaths, type UploadCheck } from './group-upload.ts';

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
  if (c.snapshotAt) io.print(`  送るのは ${c.snapshotAt.slice(0, 16).replace('T', ' ')}(UTC)の集計の時点のログです`);
  if (c.largest.length) io.print(`  大きいもの: ${c.largest.slice(0, 3).map((x) => `${x.id.slice(0, 8)}…/${x.path} ${size(x.bytes)}`).join('、')}`);
  if (c.secrets.count) {
    io.print(`  注意: 秘密らしい文字列が ${c.secrets.count} 件あります(${c.secrets.kinds.map((k) => `${k.label} ${k.count}`).join('・')}。偽陽性もありえます)`);
    for (const f of c.secrets.files) io.print(`    ${f.id}/${f.path}: ${f.count} 件`);
    io.print('  生ログはそのまま写ります。送り先で見られる人を確かめてください。本物の鍵なら、送るかどうかに関わらず作り直してください。');
  }
}

/** 対話の本体。送ったら true、やめたら false */
export async function runUploadProject(io: UploadProjectIo, o: { paths: GroupUploadPaths & { sessions: string }; configPath: string }): Promise<boolean> {
  const projects = await listProjects(o.paths.sessions);
  if (!projects.length) {
    io.print('送れるセッションがありません(空のセッションは送りません)。');
    return false;
  }
  io.print('プロジェクト(集計のプロジェクト別と同じ単位。空のセッションは数えません):');
  projects.forEach((p, i) => io.print(`  ${String(i + 1).padStart(3)}. ${p.name}  ${p.sessions} 件  最終更新 ${day(p.updatedAt)}`));
  const answer = await io.ask('送るプロジェクトの番号を入れて Enter(やめるなら何も入れずに Enter): ');
  if (!answer) {
    io.print('やめました(何も送っていません)。');
    return false;
  }
  const n = Number(answer);
  const chosen = Number.isInteger(n) && n >= 1 && n <= projects.length ? projects[n - 1] : projects.find((p) => p.name === answer);
  if (!chosen) throw new Error(`「${answer}」に当たるプロジェクトがありません(何も送っていません)`);
  const target = await projectTarget(o.paths.sessions, chosen.name);

  let root = (await loadConfig(o.configPath, false)).uploadRoot;
  if (!root) {
    io.print('送り先がまだ決まっていません。');
    root = await chooseRoot(io, o.configPath, null);
    if (!root) {
      io.print('送り先を選ばなかったので、やめました(何も送っていません)。');
      return false;
    }
  }
  // 送る前に毎回確かめる(送り先は覚えたものを使うので、違っていたらここで選び直す)
  for (;;) {
    io.print(`「${chosen.name}」を送る前に確かめてください(調べています…)`);
    const c = await checkTarget(o.paths, target, root);
    describe(io, c);
    const a = (await io.ask('送るなら y、送り先を選び直すなら c、やめるなら Enter: ')).toLowerCase();
    if (a === 'c') {
      const r = await chooseRoot(io, o.configPath, root);
      if (r) root = r;
      continue;
    }
    if (a !== 'y') {
      io.print('やめました(何も送っていません)。');
      return false;
    }
    break;
  }
  let last = -1;
  const r = await uploadTarget(o.paths, target, root, () => {}, {
    onProgress: (p) => {
      const pct = p.bytes ? Math.floor((p.copied / p.bytes) * 10) * 10 : 0;
      if (pct !== last) {
        last = pct;
        io.print(`  写しています: ${p.done} / ${p.sessions} セッション(${size(p.copied)} / ${size(p.bytes)})`);
      }
    },
  });
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
