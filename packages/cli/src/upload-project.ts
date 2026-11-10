// プロジェクトのセッションをまとめて送る(upload-project.bat から、集計の後に呼ぶ)。
// 集計のプロジェクト(プロジェクト別の表と同じ単位)のセッションの生ログを、<送り先>/<プロジェクト名>/<セッション id>/ に写す。
// 送るプロジェクトは、画面の「プロジェクト別」で「まとめて送る」に印を付けたもの(atlas.config.json の uploadProjects)。
// 印が無ければ、その場で番号を選ぶ(1 3 5-8 のように複数選べる)。印の無い新しいプロジェクトは送らず、名前を出して知らせる。
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
import { safeDirName } from './group-export.ts';
import {
  checkTarget,
  listProjects,
  projectTarget,
  readSessions,
  UploadChangedError,
  uploadTarget,
  type GroupUploadPaths,
  type GroupUploadResult,
  type ProjectSummary,
  type UploadCheck,
  type UploadTarget,
} from './group-upload.ts';

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

/** 名前の一覧を短く(多ければ最初の数件と「ほか N 件」) */
function names(list: string[], max = 10): string {
  return list.slice(0, max).join('、') + (list.length > max ? ` ほか ${list.length - max} 件` : '');
}

/**
 * 番号の指定(「1 3 5-8」「1,3」。全角の数字も可)を、選んだ番号(1 始まり・入力の順・重複なし)にする。
 * 番号として読めない・範囲の外なら null
 */
export function parseNumbers(answer: string, max: number): number[] | null {
  const parts = answer
    .normalize('NFKC')
    .split(/[\s,、]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const out: number[] = [];
  for (const part of parts) {
    const m = /^(\d+)(?:[-~〜](\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) return null;
    for (let i = a; i <= b; i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}

const projectLine = (p: ProjectSummary, i: number): string =>
  `  ${String(i + 1).padStart(3)}. ${p.name}  ${p.sessions} 件  最終更新 ${day(p.updatedAt)}${p.noLog ? `(ほかにログのフォルダが無いので送れないもの ${p.noLog} 件)` : ''}`;

/** 番号で選んでもらう。やめたら null */
async function askProjects(io: UploadProjectIo, projects: ProjectSummary[]): Promise<ProjectSummary[] | null> {
  io.print('プロジェクト(集計のプロジェクト別と同じ単位。空のセッションは数えません):');
  projects.forEach((p, i) => io.print(projectLine(p, i)));
  const answer = await io.ask('送るプロジェクトの番号を入れて Enter(1 3 5-8 のように複数選べます。やめるなら何も入れずに Enter): ');
  if (!answer) return null;
  const nums = parseNumbers(answer, projects.length);
  const chosen = nums ? nums.map((n) => projects[n - 1]!) : projects.filter((p) => p.name === answer);
  if (!chosen.length) throw new Error(`「${answer}」に当たるプロジェクトがありません(何も送っていません)`);
  return chosen;
}

function secretAdvice(io: UploadProjectIo): void {
  io.print('  生ログはそのまま写ります。送り先で見られる人を確かめてください。本物の鍵なら、送るかどうかに関わらず作り直してください。');
}

/** 1 プロジェクトを送るときの確認 */
function describe(io: UploadProjectIo, c: UploadCheck): void {
  io.print(`  送り先: ${c.dir}`);
  io.print(`  ${c.sessions} セッション・合計 ${size(c.bytes)}(${c.files} ファイル)${c.replace ? `。うち ${c.replace} 件は前に送ったものを置き換えます` : ''}`);
  if (c.snapshotAt) io.print(`  送るのは ${dateTime(c.snapshotAt)} の集計の時点のログです`);
  if (c.largest.length) io.print(`  大きいもの: ${c.largest.slice(0, 3).map((x) => `${x.id.slice(0, 8)}…/${x.path} ${size(x.bytes)}`).join('、')}`);
  if (c.secrets.count) {
    io.print(`  注意: 秘密らしい文字列が ${c.secrets.count} 件あります(${c.secrets.kinds.map((k) => `${k.label} ${k.count}`).join('・')}。偽陽性もありえます)`);
    for (const f of c.secrets.files) io.print(`    ${f.id}/${f.path}: ${f.count} 件`);
    secretAdvice(io);
  }
}

/** 何プロジェクトかをまとめて送るときの確認(プロジェクトごとに 1 行と、合計) */
function describeMany(io: UploadProjectIo, checks: UploadCheck[], root: string): void {
  io.print(`  送り先: ${root}(この中にプロジェクトごとのフォルダを作ります)`);
  const at = checks.find((c) => c.snapshotAt)?.snapshotAt;
  if (at) io.print(`  送るのは ${dateTime(at)} の集計の時点のログです`);
  checks.forEach((c, i) =>
    io.print(
      `  ${String(i + 1).padStart(3)}. ${c.name}: ${c.sessions} セッション・${size(c.bytes)}${c.replace ? `(置き換え ${c.replace} 件)` : ''}${c.secrets.count ? `  秘密らしい文字列 ${c.secrets.count} 件` : ''}`,
    ),
  );
  const sum = (f: (c: UploadCheck) => number): number => checks.reduce((a, c) => a + f(c), 0);
  const replace = sum((c) => c.replace);
  io.print(`  合計: ${sum((c) => c.sessions)} セッション・${size(sum((c) => c.bytes))}(${sum((c) => c.files)} ファイル)${replace ? `。うち ${replace} 件は前に送ったものを置き換えます` : ''}`);
  const largest = checks
    .flatMap((c) => c.largest.map((x) => ({ ...x, name: c.name })))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);
  if (largest.length) io.print(`  大きいもの: ${largest.map((x) => `${x.name} の ${x.id.slice(0, 8)}…/${x.path} ${size(x.bytes)}`).join('、')}`);
  const secrets = sum((c) => c.secrets.count);
  if (secrets) {
    const kinds = new Map<string, number>();
    for (const c of checks) for (const k of c.secrets.kinds) kinds.set(k.label, (kinds.get(k.label) ?? 0) + k.count);
    io.print(`  注意: 秘密らしい文字列が ${secrets} 件あります(${[...kinds].map(([k, n]) => `${k} ${n}`).join('・')}。偽陽性もありえます)`);
    const files = checks.flatMap((c) => c.secrets.files.map((f) => ({ ...f, name: c.name }))).sort((a, b) => b.count - a.count);
    for (const f of files.slice(0, 10)) io.print(`    ${f.name}: ${f.id}/${f.path}: ${f.count} 件`);
    if (files.length > 10) io.print(`    ほか ${files.length - 10} ファイル`);
    secretAdvice(io);
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

/** 送るプロジェクトを決める(画面の印があればそれ、無ければ番号で選ぶ)。やめたら null */
async function chooseProjects(io: UploadProjectIo, projects: ProjectSummary[], marked: string[] | null): Promise<ProjectSummary[] | null> {
  if (marked) {
    // 画面で印を付けたプロジェクトを、番号を聞かずに送る(並びは一覧と同じ多い順)
    const set = new Set(marked);
    const chosen = projects.filter((p) => set.has(p.name));
    const gone = marked.filter((n) => !projects.some((p) => p.name === n));
    const others = projects.filter((p) => !set.has(p.name));
    io.print(`まとめて送るプロジェクト(画面の「プロジェクト別」で「まとめて送る」に印を付けたもの): ${chosen.length} 件`);
    chosen.forEach((p, i) => io.print(projectLine(p, i)));
    if (gone.length) io.print(`  印はあるが、今の集計に送れるセッションが無いもの(送りません): ${names(gone)}`);
    if (others.length) {
      io.print(`  印の無いプロジェクトが ${others.length} 件あります(送りません): ${names(others.map((p) => p.name))}`);
      io.print('  送るなら、atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けてください。');
    }
    if (chosen.length) return chosen;
    io.print('印を付けたプロジェクトに、今送れるものがありません。番号で選んでください。');
  }
  const chosen = await askProjects(io, projects);
  if (chosen && !marked) io.print('(毎回同じものを送るなら、atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けておくと、番号を聞かずに送ります)');
  return chosen;
}

/** 対話の本体。すべて送ったら true、やめたら false。送れなかったプロジェクトがあれば、送れたものを知らせてから止まる(例外) */
export async function runUploadProject(io: UploadProjectIo, o: { paths: GroupUploadPaths & { sessions: string }; configPath: string }): Promise<boolean> {
  const outDir = dirname(o.paths.snapshot);
  // sessions.json は 1 回だけ読み、一覧・送るまとまり・README で使い回す(実データでは十数 MB ある)
  const records = await readSessions(o.paths.sessions);
  const projects = await listProjects(records, o.paths.snapshot);
  if (!projects.length) {
    io.print('送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)。');
    return false;
  }
  const config = await loadConfig(o.configPath, false);
  const chosen = await chooseProjects(io, projects, config.uploadProjects);
  if (!chosen) {
    io.print('やめました(何も送っていません)。');
    return false;
  }
  // フォルダ名が同じになるプロジェクト(owner/app と owner_app など)を一度に送ると、2 つめが混ざるので送る前に止める
  const byFolder = new Map<string, string>();
  for (const p of chosen) {
    const key = safeDirName(p.name).toLowerCase();
    const prev = byFolder.get(key);
    if (prev) throw new Error(`プロジェクト「${prev}」と「${p.name}」は、送り先のフォルダ名が同じ「${safeDirName(p.name)}」になります。混ざるので、片方ずつ別の送り先に送ってください(何も送っていません)`);
    byFolder.set(key, p.name);
  }
  let pending: UploadTarget[] = [];
  for (const p of chosen) pending.push(await projectTarget(o.paths, p.name, records));

  let root = config.uploadRoot;
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
  // 入力を待つ間はロックを放すので、写すときに確かめた中身と同じかを見直し、変わっていたら(集計し直したなど)残りをもう一度確かめる
  const sent: GroupUploadResult[] = [];
  const failed: { name: string; error: string }[] = [];
  while (pending.length) {
    const todo = pending;
    const many = todo.length > 1;
    io.print(many ? `${todo.length} プロジェクトを送る前に確かめてください(調べています…)` : `「${todo[0]!.name}」を送る前に確かめてください(調べています…)`);
    const r0 = root;
    const checks = await withOutLock(outDir, async () => {
      const a: UploadCheck[] = [];
      for (const t of todo) a.push(await checkTarget(o.paths, t, r0));
      return a;
    });
    if (many) describeMany(io, checks, r0);
    else describe(io, checks[0]!);
    const a = (await io.ask('送るなら y、送り先を選び直すなら c、やめるなら Enter: ')).toLowerCase();
    if (a === 'c') {
      const picked = await chooseRoot(io, o.configPath, root);
      if (picked) root = picked;
      continue;
    }
    if (a !== 'y') {
      io.print(sent.length ? `やめました(残りの ${todo.length} プロジェクトは送っていません)。` : 'やめました(何も送っていません)。');
      break;
    }
    // まとめて送る間はロックを持ち続ける(途中で集計し直されて、残りが確かめた中身と変わらないように)
    pending = await withOutLock(outDir, async () => {
      for (let i = 0; i < todo.length; i++) {
        const t = todo[i]!;
        const tag = many ? `[${i + 1}/${todo.length}] ${t.name}: ` : '';
        let last = '';
        try {
          const r = await uploadTarget(o.paths, t, r0, () => {}, {
            expect: checks[i]!.fingerprint,
            sessions: records,
            onProgress: (p) => {
              // 1 割進むごとと、セッションを 1 件写し終えるごとに 1 行出す(最後に「1 / 1」まで出す)
              const pct = p.bytes ? Math.floor((p.copied / p.bytes) * 10) * 10 : 0;
              const key = `${pct}/${p.done}`;
              if (key !== last) {
                last = key;
                io.print(`  ${tag}写しています: ${p.done} / ${p.sessions} セッション(${size(p.copied)} / ${size(p.bytes)})`);
              }
            },
          });
          sent.push(r);
          io.print(`送りました: ${many ? `「${t.name}」 ` : ''}${r.uploaded} セッション${r.memos ? `・メモ ${r.memos} 件` : ''}${r.replaced ? `(うち ${r.replaced} 件は置き換え)` : ''} → ${r.dir}`);
        } catch (e) {
          if (e instanceof UploadChangedError) {
            // 確かめた後にログが変わった: これと残りを確かめ直す(送ったものはそのまま)
            io.print(e.message);
            return todo.slice(i);
          }
          // 1 つ送れなくても残りは送る(ネットワークの一時的な切断や、送り先で開かれているファイルなど)
          failed.push({ name: t.name, error: (e as Error).message });
          io.print(`送れませんでした: 「${t.name}」(${(e as Error).message})`);
        }
      }
      return [];
    });
  }
  if (sent.length) io.print(sent.length > 1 ? 'プロジェクトの説明とセッションの一覧は、それぞれのフォルダの README.md にあります。' : 'プロジェクトの説明とセッションの一覧は、そのフォルダの README.md にあります。');
  if (failed.length) {
    io.print(`送れなかったプロジェクト(${failed.length} 件): ${names(failed.map((f) => f.name))}。理由を確かめてから、もう一度実行してください(送れたものは、送り直しても置き換えるだけです)。`);
    throw new Error(`${failed.length} プロジェクトを送れませんでした(送れたのは ${sent.length} プロジェクトです)`);
  }
  return sent.length > 0 && pending.length === 0;
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
