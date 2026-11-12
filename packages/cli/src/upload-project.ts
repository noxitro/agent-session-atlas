// プロジェクトのセッションをまとめて送る(upload-project.bat から呼ぶ。最新のログを集計し直してから、送る操作に進む)。
// 集計のプロジェクト(プロジェクト別の表と同じ単位)のセッションの生ログを、<送り先>/<プロジェクト名>/<セッション id>/ に写す。
// 送るプロジェクトは、画面の「プロジェクト別」で「まとめて送る」に印を付けたもの(atlas.config.json の uploadProjects)。
// 印が無ければ、その場で番号を選ぶ(1 3 5-8 のように複数選べる)。印の無い新しいプロジェクトは送らず、最近更新したものの名前を出して知らせる。
// 送り先は一度選んだら atlas.config.json の uploadRoot に覚える(画面のグループのアップロードと共通)。まだ無ければエクスプローラーで選ぶ。
// 送る前に毎回、送り先・セッション数・大きさ・秘密らしい文字列を見せて確認する(y で送る / n で今回だけ番号で選び直す / c で送り先を選び直す / それ以外はやめる)。
//
// 黒い窓に出す文の決まり(読み飛ばされないように):
//  - 場面ごとに見出し(== … ==)で区切り、前に空行を 1 つ置く。中身は 2 文字下げる
//  - 1 行に 1 つのことだけを書く。一覧は名前の列をそろえる
//  - 調べている・写している途中の様子は、行を増やさずに 1 行を書き換えて出す(io.status。端末でなければ出さない)
import { closeSync, existsSync, openSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearLine, createInterface, cursorTo, moveCursor } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { format, stripVTControlCharacters } from 'node:util';
import { parseCli } from './args.ts';
import { defaultConfigPath, loadConfig, updateConfig } from './config.ts';
import { pickFolder } from './folder-picker.ts';
import { resolvePaths, run as runCli } from './commands.ts';
import { acquireOutLock, OutBusyError, releaseOutLock } from './jobs.ts';
import { safeDirName } from './group-export.ts';
import {
  checkTarget,
  listProjects,
  openUploadContext,
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
import type { SessionRecord } from '../../core/src/index.ts';

export interface UploadProjectIo {
  ask: (q: string) => Promise<string>;
  print: (line: string) => void;
  /** 送り先のフォルダを選んでもらう(取り消しは null) */
  pick: (initial: string | null) => Promise<string | null>;
  /** 今の様子(調べている・写している)を、行を増やさずに 1 行で見せる。次の print・ask で消える。無ければ出さない(端末でないとき) */
  status?: (text: string) => void;
}

/** 送れなかったプロジェクトがある(どれが送れなかったかと理由は、もう画面に出してある) */
export class UploadIncompleteError extends Error {}

const size = (b: number): string => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '日付不明');

/** 幅を取らない文字(結合する記号・異体字セレクタ・ZWJ などの書式の文字)。ソフトハイフン(U+00AD)は書式の文字だが、端末では 1 桁で出るので除く */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
/** 端末で絵文字として 2 桁で出る文字(☕ ⭐ ✅ など、全角の範囲の外にもある) */
const EMOJI = /\p{Emoji_Presentation}/u;
/** 肌の色の修飾(U+1F3FB〜1F3FF)を後ろに受けて、1 つの絵文字として出る文字(👍 ☝ など) */
const SKIN_BASE = /\p{Emoji_Modifier_Base}/u;

/**
 * 画面での幅(全角の文字と絵文字は 2、結合する記号などは 0、ほかは 1)。一覧の列をそろえるのと、1 行に収めるのに使う。
 * 後ろに U+FE0F(絵文字で出す指定)が付いた文字(✔️ など)は 2 と数える。
 * 1 つの絵文字として出るもの(ZWJ でつないだ 👨‍👩‍👧、地域指示記号 2 つの国旗 🇯🇵、肌の色の修飾が付いた 👍🏽)は、全体で 2 と数える。
 * 肌の色の修飾が重なるのは、修飾を受ける絵文字(SKIN_BASE)の後ろだけ(漢字の後ろに置いたものは、それだけで 2)
 */
export function width(s: string): number {
  let n = 0;
  let prev = 0;
  let joined = false;
  let flagHalf = false;
  // 直前の見える文字が、肌の色の修飾を受ける絵文字(👍 ☝ など)か
  let base = false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // ZWJ の次の文字は、前の絵文字とつながって 1 つに出る
    if (joined) {
      joined = false;
      if (!ZERO_WIDTH.test(ch)) {
        base = SKIN_BASE.test(ch);
        continue;
      }
    }
    if (c === 0x200d) {
      joined = prev === 2;
      continue;
    }
    // 地域指示記号は 2 つで 1 つの国旗になる(1 つ目を 2、2 つ目を 0 と数える)
    if (c >= 0x1f1e6 && c <= 0x1f1ff) {
      if (flagHalf) {
        flagHalf = false;
        continue;
      }
      flagHalf = true;
      n += 2;
      prev = 2;
      base = false;
      continue;
    }
    flagHalf = false;
    // 肌の色の修飾(U+1F3FB〜1F3FF)は、修飾を受ける絵文字の後ろでは重なって出る(合わせて 2)。
    // ほかの文字(漢字など)の後ろや先頭では、それだけで 1 つの絵文字として 2
    if (c >= 0x1f3fb && c <= 0x1f3ff && base) {
      base = false;
      if (prev === 1) {
        n += 1;
        prev = 2;
      }
      continue;
    }
    if (c !== 0xad && ZERO_WIDTH.test(ch)) {
      if (c === 0xfe0f && prev === 1) {
        n += 1;
        prev = 2;
      }
      continue;
    }
    const wide =
      EMOJI.test(ch) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    prev = wide ? 2 : 1;
    n += prev;
    base = SKIN_BASE.test(ch);
  }
  return n;
}

/** 右を空白で埋めて、画面での幅を n にそろえる(長ければそのまま) */
const padEnd = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)));

/** 画面での幅が max に収まるところで切る(書き換える 1 行が折り返すと、消し残るため) */
export function fit(s: string, max: number): string {
  let out = '';
  // 1 文字ずつではなく、ここまでの全体の幅で見る(U+FE0F のように、前の文字の幅を変えるものがあるため)
  for (const ch of s) {
    if (width(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** 名前の列の幅(いちばん長い名前に合わせる。長すぎる名前があっても、ほかの行まで間延びしないよう上限を置く) */
const NAME_MAX = 40;
const nameWidth = (list: string[]): number => Math.min(NAME_MAX, Math.max(0, ...list.map(width)));

/** 送り先を選んでもらい、設定に覚える。取り消したら null */
async function chooseRoot(io: UploadProjectIo, configPath: string, current: string | null): Promise<string | null> {
  io.print('  送り先のフォルダを選ぶ画面を開きます。見えないときはタスクバーを確かめてください。');
  const r = await io.pick(current);
  if (!r) return null;
  if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error(`フォルダが見つかりません: ${r}`);
  await updateConfig(configPath, 'uploadRoot', r);
  io.print(`  送り先を覚えました(次からは聞きません): ${r}`);
  return r;
}

/** 名前の一覧を短く(多ければ最初の数件と「ほか N 件」) */
function names(list: string[], max = 10): string {
  return list.slice(0, max).join('、') + (list.length > max ? ` ほか ${list.length - max} 件` : '');
}

/**
 * 番号の指定(「1 3 5-8」「1,3」「5 - 8」。全角の数字も可)を、選んだ番号(1 始まり・入力の順・重複なし)にする。
 * 番号として読めない・範囲の外なら null
 */
export function parseNumbers(answer: string, max: number): number[] | null {
  const parts = answer
    .normalize('NFKC')
    .replace(/\s*([-~〜])\s*/g, '$1')
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

/** 番号つきの行の頭(番号は右にそろえる) */
const numbered = (i: number, count: number): string => `  ${String(i + 1).padStart(String(count).length + 1)}. `;

/** 番号で選んでもらう。当たらなければ尋ね直す(打ち間違いで集計からやり直しにならないように)。やめたら null */
async function askProjects(io: UploadProjectIo, projects: ProjectSummary[]): Promise<ProjectSummary[] | null> {
  const w = nameWidth(projects.map((p) => p.name));
  const sw = String(Math.max(...projects.map((p) => p.sessions))).length;
  io.print('');
  io.print('== 送るプロジェクトを選ぶ ==');
  projects.forEach((p, i) =>
    io.print(
      `${numbered(i, projects.length)}${padEnd(p.name, w)}  ${String(p.sessions).padStart(sw)} セッション   最終更新 ${day(p.updatedAt)}${p.noLog ? `(ほかに、ログが無くて送れないもの ${p.noLog} 件)` : ''}`,
    ),
  );
  io.print('');
  for (;;) {
    const answer = await io.ask('  番号を入れて Enter(例: 1 3 5-8。やめるなら Enter だけ)\n  > ');
    if (!answer) return null;
    const nums = parseNumbers(answer, projects.length);
    const chosen = nums ? nums.map((n) => projects[n - 1]!) : projects.filter((p) => p.name === answer);
    if (chosen.length) return chosen;
    io.print(`  「${answer}」に当たるプロジェクトがありません。一覧の番号(1〜${projects.length})か名前を入れ直してください。`);
  }
}

/**
 * 送る前の確認。1 プロジェクトなら送り先はそのフォルダ、何プロジェクトかならプロジェクトごとの 1 行と合計。
 * 秘密らしい文字列はまとめて出す(何プロジェクトかなら、どのプロジェクトのものかを添える)
 */
function describe(io: UploadProjectIo, checks: UploadCheck[], root: string): void {
  const many = checks.length > 1;
  const one = checks[0]!;
  const sum = (f: (c: UploadCheck) => number): number => checks.reduce((a, c) => a + f(c), 0);
  if (many) {
    io.print(`  送り先: ${root}(この中にプロジェクトごとのフォルダを作ります)`);
    const total = '合計';
    const w = Math.max(nameWidth(checks.map((c) => c.name)), width(total));
    const sw = String(sum((c) => c.sessions)).length;
    const sizes = checks.map((c) => size(c.bytes));
    const all = size(sum((c) => c.bytes));
    const bw = Math.max(all.length, ...sizes.map((s) => s.length));
    checks.forEach((c, i) =>
      io.print(
        `${numbered(i, checks.length)}${padEnd(c.name, w)}  ${String(c.sessions).padStart(sw)} セッション  ${sizes[i]!.padStart(bw)}${c.secrets.count ? `   秘密らしい文字列 ${c.secrets.count} 件` : ''}`,
      ),
    );
    io.print(`${' '.repeat(numbered(0, checks.length).length)}${padEnd(total, w)}  ${String(sum((c) => c.sessions)).padStart(sw)} セッション  ${all.padStart(bw)}`);
  } else {
    io.print(`  送り先: ${one.dir}`);
    io.print(`  ${one.name}: ${one.sessions} セッション・${size(one.bytes)}`);
  }
  const replace = sum((c) => c.replace);
  if (replace) io.print(`  うち ${replace} セッションは、前に送ったものを置き換えます。`);
  const secrets = sum((c) => c.secrets.count);
  if (secrets) {
    const kinds = new Map<string, number>();
    for (const c of checks) for (const k of c.secrets.kinds) kinds.set(k.label, (kinds.get(k.label) ?? 0) + k.count);
    io.print('');
    io.print(`  注意: 秘密らしい文字列が ${secrets} 件あります(${[...kinds].map(([k, n]) => `${k} ${n}`).join('・')}。偽陽性もありえます)`);
    // 点検はプロジェクトごとに多い順 10 ファイルまで返す。並べ直して全体の多い順 5 ファイルを出す
    const files = checks.flatMap((c) => c.secrets.files.map((f) => ({ ...f, name: c.name }))).sort((a, b) => b.count - a.count);
    for (const f of files.slice(0, 5)) io.print(`    ${many ? `${f.name}: ` : ''}${f.id}/${f.path}: ${f.count} 件`);
    if (files.length > 5) io.print('    ほかのファイルにもあります');
    io.print('  ログはそのまま写ります。送り先を見られる人を確かめてください。');
    io.print('  本物の鍵なら、送る・送らないに関わらず作り直してください。');
  }
}

/**
 * 集計の作業中を示すロック(out/.job.json)を取って fn を動かす。画面の「集計し直す」と重なると、写す元(out/snapshot/)が書き換わるため。
 * 入力を待つ間は持たない(画面の操作を長く止めないように)。取れなければ note(ここまでに送ったもの)を添えて止まる
 */
async function withOutLock<T>(outDir: string, note: string, fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  try {
    release = acquireOutLock(outDir, 'project upload', 'cli');
  } catch (e) {
    if (e instanceof OutBusyError) throw new Error(`${e.message}(${note})`);
    throw e;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 自動で送る(schedule-upload.bat で登録したタスク)ときに、人に尋ねないと進めない場面。理由は message に書く(何も送っていない) */
export class AutoUploadBlockedError extends Error {}

/** 自動で送るときに、確かめ直しが続いてもあきらめずに送り直す回数(送っている間に画面で集計し直し続けるなど) */
const AUTO_RECHECKS = 3;

/** 送るプロジェクトを決める(画面の印があればそれ、無ければ番号で選ぶ)。やめたら null */
async function chooseProjects(io: UploadProjectIo, projects: ProjectSummary[], marked: string[] | null, auto = false): Promise<ProjectSummary[] | null> {
  if (auto) {
    // 自動のときは番号を尋ねられないので、印のあるものだけを送る(印の無い新しいプロジェクトは名前を記録に残す)
    if (!marked) throw new AutoUploadBlockedError('まとめて送るプロジェクトに印がありません。atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けてください(何も送っていません)');
    const set = new Set(marked);
    const chosen = projects.filter((p) => set.has(p.name));
    if (!chosen.length) throw new AutoUploadBlockedError(`印を付けたプロジェクト(${names(marked, 3)})に、今送れるセッションがありません(何も送っていません)`);
    const others = projects.filter((p) => !set.has(p.name));
    io.print('');
    io.print('== 送るプロジェクト ==');
    io.print(`  印を付けた ${chosen.length} プロジェクトを送ります: ${names(chosen.map((p) => p.name))}`);
    const noLog = chosen.reduce((a, p) => a + p.noLog, 0);
    if (noLog) io.print(`  このほかに、ログが無くて送れないセッションが ${noLog} 件あります(送りません)。`);
    const gone = marked.filter((n) => !projects.some((p) => p.name === n));
    if (gone.length) io.print(`  印はあるが、送れるセッションが無いもの: ${names(gone, 3)}`);
    if (others.length) {
      const recent = [...others].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((p) => p.name);
      io.print(`  印の無い ${others.length} プロジェクトは送りません(最近更新: ${names(recent, 3)})。`);
    }
    return chosen;
  }
  if (marked) {
    // 画面で印を付けたプロジェクトを、番号を聞かずに送る(並びは一覧と同じ多い順)。どれを送るかは、すぐ後の確認に並ぶ
    const set = new Set(marked);
    const chosen = projects.filter((p) => set.has(p.name));
    const gone = marked.filter((n) => !projects.some((p) => p.name === n));
    const others = projects.filter((p) => !set.has(p.name));
    io.print('');
    io.print('== 送るプロジェクト ==');
    io.print(chosen.length ? `  画面で印を付けた ${chosen.length} プロジェクトを送ります。` : '  印を付けたプロジェクトに、今送れるものがありません。番号で選んでください。');
    // 一覧を出さないので、ログが無くて送れないセッションの数はここで知らせる(画面の件数と合わない理由が分かるように)
    const noLog = chosen.reduce((a, p) => a + p.noLog, 0);
    if (noLog) io.print(`  このほかに、ログが無くて送れないセッションが ${noLog} 件あります(送りません)。`);
    if (gone.length) io.print(`  印はあるが、送れるセッションが無いもの: ${names(gone, 3)}`);
    if (chosen.length && others.length) {
      // 全部の名前は並べない(送らないと決めたものが毎回並ぶため)。新しく始めたプロジェクトを見落とさないよう、最近更新したものだけ出す
      const recent = [...others].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((p) => p.name);
      io.print(`  印の無い ${others.length} プロジェクトは送りません(最近更新: ${names(recent, 3)})。`);
      io.print('  印は、atlas.bat の画面の「プロジェクト別」で付け外しできます。');
    }
    if (chosen.length) return chosen;
  }
  return askProjects(io, projects);
}

/** 選んだプロジェクトを、写すまとまりにする。フォルダ名が同じになるもの(owner/app と owner_app など)を一度に選んだら、2 つめが混ざるので止める */
async function targetsOf(paths: GroupUploadPaths & { sessions: string }, chosen: ProjectSummary[], records: SessionRecord[]): Promise<UploadTarget[]> {
  const byFolder = new Map<string, string>();
  for (const p of chosen) {
    const key = safeDirName(p.name).toLowerCase();
    const prev = byFolder.get(key);
    if (prev) throw new Error(`プロジェクト「${prev}」と「${p.name}」は、送り先のフォルダ名が同じ「${safeDirName(p.name)}」になります。混ざるので、片方ずつ別の送り先に送ってください(何も送っていません)`);
    byFolder.set(key, p.name);
  }
  const out: UploadTarget[] = [];
  for (const p of chosen) out.push(await projectTarget(paths, p.name, records));
  return out;
}

/** 自動で送った結果(schedule-upload.bat の状態の表示に使う) */
export interface UploadSummary {
  /** 送ったプロジェクトと、送ったセッションの数 */
  sent: { name: string; sessions: number }[];
  /** 送ったものにあった秘密らしい文字列の数(偽陽性もありうる) */
  secrets: number;
  root: string | null;
}

/**
 * 対話の本体。すべて送ったら true、やめたら false。送れなかったプロジェクトがあれば、送れたものを知らせてから止まる(例外)。
 * auto なら尋ねない(schedule-upload.bat で登録したタスクから動かすとき): 印のあるプロジェクトを、覚えた送り先へ、送る前の確認を出さずに送る。
 * 印や送り先が無いなど、尋ねないと進めないときは AutoUploadBlockedError で止まる(何も送らない)。summary を渡すと、送ったものを書き込む
 */
export async function runUploadProject(
  io: UploadProjectIo,
  o: { paths: GroupUploadPaths & { sessions: string }; configPath: string; auto?: boolean; summary?: UploadSummary },
): Promise<boolean> {
  const auto = o.auto === true;
  const outDir = dirname(o.paths.snapshot);
  // sessions.json は 1 回だけ読み、一覧・送るまとまり・README で使い回す(実データでは十数 MB ある)
  const records = await readSessions(o.paths.sessions);
  const projects = await listProjects(records, o.paths.snapshot);
  if (!projects.length) {
    if (auto) throw new AutoUploadBlockedError('送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)');
    io.print('');
    io.print('送れるセッションがありません(空のセッションと、ログのフォルダが無いものは送りません)。');
    return false;
  }
  const config = await loadConfig(o.configPath, false);
  const chosen = await chooseProjects(io, projects, config.uploadProjects, auto);
  if (!chosen) {
    io.print('  やめました(何も送っていません)。');
    return false;
  }
  let pending = await targetsOf(o.paths, chosen, records);

  let root = config.uploadRoot;
  // 覚えた送り先が無い(ネットワークドライブの切断・フォルダの削除)ときも、ここで選び直せるようにする
  const lost = root != null && !(existsSync(root) && statSync(root).isDirectory());
  if (auto && !root) throw new AutoUploadBlockedError('送り先がまだ決まっていません。upload-project.bat か atlas.bat の画面の「設定…」で決めてください(何も送っていません)');
  if (auto && lost) throw new AutoUploadBlockedError(`覚えている送り先が見つかりません: ${root}(ドライブがつながっているか確かめてください。何も送っていません)`);
  if (!root || lost) {
    io.print('');
    io.print('== 送り先 ==');
    if (lost) {
      io.print(`  覚えている送り先が見つかりません: ${root}`);
      io.print('  ドライブがつながっているか確かめるか、選び直してください。');
    }
    root = await chooseRoot(io, o.configPath, null);
    if (!root) {
      io.print('  送り先を選ばなかったので、やめました(何も送っていません)。');
      return false;
    }
  }
  // 送る前に毎回確かめる(送り先は覚えたものを使うので、違っていたらここで選び直す)。
  // 入力を待つ間はロックを放すので、写すときに確かめた中身と同じかを見直し、変わっていたら(集計し直したなど)残りをもう一度確かめる
  const sent: GroupUploadResult[] = [];
  const failed: { name: string; error: string }[] = [];
  /** 途中で止まったときに添える、ここまでに送ったもの */
  const sentNote = (): string => (sent.length ? `ここまでに ${sent.length} プロジェクトを送りました(${names(sent.map((r) => r.name))})。残りは送っていません` : '何も送っていません');
  let stopped = false;
  if (o.summary) o.summary.root = root;
  let rechecks = 0;
  // 送ったもの・送れなかったものがあれば、送っていない残りはすぐ後のまとめに出す(同じことを 2 度書かない)
  const quit = (): void => io.print(sent.length || failed.length ? '  やめました。' : '  やめました(何も送っていません)。');
  try {
    while (pending.length) {
      // 自動のときは確かめ直しが続いても尋ねられないので、決まった回数で止める(送ったものはまとめに出る)
      if (auto && rechecks++ > AUTO_RECHECKS) throw new Error(`確かめる間にログが変わり続けたので、残りの ${pending.length} プロジェクトは送っていません。次の回に送ります`);
      const todo = pending;
      const many = todo.length > 1;
      io.print('');
      io.print('== 送る前の確認 ==');
      io.status?.('  調べています...');
      const r0 = root;
      // session-store.db などは 1 回だけ開き、プロジェクトの間で使い回す
      const checks = await withOutLock(outDir, sentNote(), async () => {
        const ctx = await openUploadContext(o.paths);
        try {
          const a: UploadCheck[] = [];
          for (const t of todo) a.push(await checkTarget(o.paths, t, r0, ctx));
          return a;
        } finally {
          ctx.close();
        }
      });
      describe(io, checks, r0);
      io.print('');
      // 自動のときは、登録したときに「確認を出さずに送る」と承知してもらっている(schedule-upload.bat)
      const a = auto ? 'y' : (await io.ask('  y = 送る   n = 番号で選び直す   c = 送り先を変える   Enter = やめる\n  > ')).toLowerCase();
      if (a === 'c') {
        const picked = await chooseRoot(io, o.configPath, root);
        if (picked) root = picked;
        continue;
      }
      if (a === 'n') {
        // 印は変えずに、今回送るものだけを選び直す
        const picked = await askProjects(io, projects);
        if (!picked) {
          quit();
          break;
        }
        pending = await targetsOf(o.paths, picked, records);
        continue;
      }
      if (a !== 'y') {
        quit();
        break;
      }
      io.print('');
      io.print('== 送っています ==');
      const w = nameWidth(todo.map((t) => t.name));
      const sw = String(Math.max(...checks.map((c) => c.sessions))).length;
      // まとめて送る間はロックを持ち続ける(途中で集計し直されて、残りが確かめた中身と変わらないように)
      pending = await withOutLock(outDir, sentNote(), async () => {
        const ctx = await openUploadContext(o.paths);
        try {
          for (let i = 0; i < todo.length; i++) {
            const t = todo[i]!;
            const tag = many ? `[${i + 1}/${todo.length}] ` : '';
            let shownAt = 0;
            let shownDone = -1;
            try {
              const r = await uploadTarget(o.paths, t, r0, () => {}, {
                expect: checks[i]!.fingerprint,
                sessions: records,
                context: ctx,
                onProgress: (p) => {
                  // 写すたびに呼ばれるので、セッションを 1 件写し終えたときと、間が空いたときだけ書き換える(窓への書き込みで写すのが遅くならないように)
                  const now = Date.now();
                  if (!io.status || (p.done === shownDone && now - shownAt < 200)) return;
                  shownAt = now;
                  shownDone = p.done;
                  io.status(`  ${tag}${t.name}  ${p.done} / ${p.sessions} セッション(${size(p.copied)} / ${size(p.bytes)})`);
                },
              });
              sent.push(r);
              o.summary?.sent.push({ name: r.name, sessions: r.uploaded });
              if (o.summary) o.summary.secrets += checks[i]!.secrets.count;
              const extra = [r.replaced ? `置き換え ${r.replaced} セッション` : '', r.memos ? `メモ ${r.memos} 件` : ''].filter(Boolean).join('・');
              io.print(`  ${tag}${padEnd(t.name, w)}  ${String(r.uploaded).padStart(sw)} セッションを送りました${extra ? `(${extra})` : ''}`);
              if (r.leftovers.length) {
                // 置き換えた前のフォルダが、送り先で開かれていたなどで消せずに残った(次に送るときも残り続けるので、手で消してもらう)
                io.print(`      置き換えた前のフォルダを ${r.leftovers.length} 件消せませんでした。閉じてから手で消してください:`);
                for (const l of r.leftovers.slice(0, 3)) io.print(`        ${l}`);
                if (r.leftovers.length > 3) io.print(`        ほか ${r.leftovers.length - 3} 件`);
              }
            } catch (e) {
              if (e instanceof UploadChangedError) {
                // 確かめた後にログやメモが変わった: これと残りを確かめ直す(送ったものはそのまま)
                io.print(`  ${e.message}`);
                return todo.slice(i);
              }
              // 1 つ送れなくても残りは送る(ネットワークの一時的な切断や、送り先で開かれているファイルなど)
              failed.push({ name: t.name, error: (e as Error).message });
              io.print(`  ${tag}${padEnd(t.name, w)}  送れませんでした: ${(e as Error).message}`);
            }
          }
          return [];
        } finally {
          ctx.close();
        }
      });
    }
  } catch (e) {
    stopped = true;
    throw e;
  } finally {
    // 途中で止まっても(ロックが取れないなど)、送ったもの・送れなかったものを知らせる
    if (sent.length || failed.length) {
      io.print('');
      // 残り(pending)があるのは、送る途中で確かめ直しになり、そこでやめたとき(送れなかったものがあっても、残りは出す)
      io.print(failed.length ? '== 送れなかったものがあります ==' : stopped ? '== 途中で止まりました ==' : pending.length ? '== 途中でやめました ==' : '== 終わりました ==');
      if (sent.length) {
        io.print(`  ${sent.length} プロジェクト・${sent.reduce((a, r) => a + r.uploaded, 0)} セッションを送りました。`);
        io.print(`  送り先: ${sent.length > 1 ? [...new Set(sent.map((r) => dirname(r.dir)))].join('、') : sent[0]!.dir}`);
        io.print(sent.length > 1 ? '  説明とセッションの一覧は、それぞれのフォルダの README.md にあります。' : '  説明とセッションの一覧は、そのフォルダの README.md にあります。');
      }
      if (pending.length && !stopped) io.print(`  残りの ${pending.length} プロジェクト(${names(pending.map((t) => t.name), 3)})は送っていません。`);
      if (failed.length) {
        io.print(`  送れなかったプロジェクト(${failed.length} 件): ${names(failed.map((f) => f.name))}`);
        io.print('  理由を確かめてから、もう一度実行してください(送れたものは、送り直しても置き換えるだけです)。');
      }
      if (sent.length && !config.uploadProjects && !auto) io.print('  毎回同じものを送るなら、atlas.bat の画面の「プロジェクト別」で「まとめて送る」に印を付けると、番号を聞かずに送ります。');
    }
  }
  if (failed.length) throw new UploadIncompleteError(`${failed.length} プロジェクトを送れませんでした(送れたのは ${sent.length} プロジェクトです)`);
  return sent.length > 0 && pending.length === 0;
}

/** 集計の各段階(ログの行の頭)を、途中の様子に出す言葉にする */
const STAGES: Record<string, string> = {
  snapshot: 'ログを写しています',
  extract: 'ログを読んでいます',
  metrics: '数えています',
  build: 'レポートを作っています',
  export: 'セッション記録を作っています',
  all: '仕上げています',
};

/** 改行やタブを空白にして 1 行にする(書き換える 1 行と、窓に出す注意に使う) */
const oneLine = (s: string): string => s.replace(/[\r\n\t\v\f]+/g, ' ').trim();

/**
 * 送る前に、最新のログを集計し直す(upload-project.bat から、送る操作の前に呼ぶ)。
 * 経過の行(長いパスが続く)は窓に出さずに logPath に書き、途中の様子は 1 行の書き換えで出す。
 * 窓に出す注意は、送るものに関わるもの(ログを写す段階の注意: 複製できず前回の複製を使った、など)だけ。
 * ほかの段階の注意(記録で伏せた文字列の数など)は、画面と CLI で見られるので経過のファイルにだけ書く。
 * 失敗したら理由と logPath を出して false
 */
export async function refreshAggregate(io: UploadProjectIo, o: { logPath: string; run: (log: (m: string) => void) => Promise<unknown> }): Promise<boolean> {
  io.print('');
  io.print('== 集計 ==');
  io.print('  最新のログを集計しています。少し待ってください。');
  // 経過は 1 行ごとにその場でファイルに書く(途中で窓を閉じても、そこまでの経過が残るように)。書けなくても集計は続ける(経過を残す場所が無いだけ)
  let fd: number | null = null;
  try {
    fd = openSync(o.logPath, 'w');
  } catch {
    /* 経過を残せないだけ */
  }
  const keep = (m: string): void => {
    if (fd == null) return;
    try {
      writeSync(fd, `${m}\n`);
    } catch {
      /* 書けなかった行は残らないだけ */
    }
  };
  const log = (m: string): void => {
    keep(m);
    // 行の頭が「snapshot: 注意」のものだけ(文の途中に「注意」とある行や、ほかの段階の注意は出さない)
    const notice = /^snapshot: 注意 ([\s\S]+)/.exec(m)?.[1];
    if (notice) {
      io.print(`  注意: ${oneLine(notice)}`);
      return;
    }
    const stage = /^([a-z-]+)[ :]/.exec(m)?.[1];
    // 段階の頭が無い行(「レポートのテンプレートをビルドしています…」など)は、その文のまま出す
    if (stage) io.status?.(`  ${STAGES[stage] ?? '集計しています'}...`);
    else if (m.trim()) io.status?.(`  ${oneLine(m)}`);
  };
  // 集計の中で窓に直に書かれるもの(初回のテンプレートのビルドで Vite が console に出す警告、node の警告を stderr に書く core/sqlite.ts など)は、
  // 窓に出さずに経過のファイルに書く。直に書かれると、書き換えている 1 行の途中に混ざり、消す行がずれるため。
  // 警告とエラー(console.warn/error と stderr)は、あったことと経過のファイルの場所を最後に 1 行で知らせる
  // (件数は出さない。1 つの警告が何回かに分けて書かれることも、何行にもなることもあり、数が合わないため)
  let warned = false;
  const warn = (text: string): void => {
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      keep(`警告: ${l}`);
      warned = true;
    }
  };
  const plain = (args: unknown[]): string => stripVTControlCharacters(format(...args));
  /** process.stdout/stderr の write の代わり(呼び出し側が渡した終わりの合図は呼ぶ) */
  const capture =
    (to: (text: string) => void) =>
    (chunk: unknown, a?: unknown, b?: unknown): boolean => {
      to(stripVTControlCharacters(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')));
      const done = typeof a === 'function' ? a : b;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  console.log = console.info = console.debug = (...args: unknown[]) => log(plain(args));
  console.warn = console.error = (...args: unknown[]) => warn(plain(args));
  process.stdout.write = capture((t) => t.split(/\r?\n/).forEach((l) => l.trim() && keep(l))) as typeof process.stdout.write;
  process.stderr.write = capture(warn) as typeof process.stderr.write;
  const restore = (): void => {
    Object.assign(console, saved);
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  };
  // 差し替えた出力は、集計が終わったところ(成功でも失敗でも)で 1 度だけ戻す。結果を窓に出すのはその後
  let failure: Error | null = null;
  try {
    await o.run(log);
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  } finally {
    restore();
  }
  try {
    if (failure) {
      keep(`失敗しました: ${failure.message}`);
      // どこで失敗したかも残す(窓には理由だけを出す)
      if (failure.stack) keep(failure.stack);
      io.print(`  集計に失敗しました: ${oneLine(failure.message)}`);
      io.print('  atlas.bat の画面で集計し直している最中なら、終わってからもう一度実行してください。');
      io.print(`  集計の経過: ${o.logPath}`);
      return false;
    }
    if (warned) io.print(`  集計の途中で警告が出ました(経過のファイルに書きました): ${o.logPath}`);
    io.print('  集計しました。');
    return true;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** 黒い窓の出力(テストでは偽物を渡す) */
export interface ConsoleOut {
  write: (s: string) => boolean;
  isTTY?: boolean;
  columns?: number;
}

/** 黒い窓の入力(端末なら setRawMode を持つ。テストでは偽物を渡す) */
export type ConsoleIn = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

/**
 * 黒い窓(標準入出力)とやりとりする io。pick は送り先のフォルダを選ぶ画面。
 * 書き換える 1 行(status)は、出力が端末のときだけ使う(ファイルやパイプに流すと、書き換えの制御文字が残るため)。
 * 入力が端末のときは、尋ねていない間に打ったキーを捨てる(集計を待つ間に打った文字や Enter が、まだ見ていない質問の答えにならないように)。
 * 端末は、Enter を押すまでの文字を自分で持っていて、こちらには届かない(届いた行を捨てるだけでは、Enter を押していない文字が次の答えの頭に付く)。
 * そこで、尋ねていない間は 1 文字ずつ届く状態(raw)にしてその場で捨て、尋ねている間だけ行で受け取る状態に戻す。
 * 流し込んだ入力(パイプ)では、尋ねる前に届いた行も順に答えに使う
 */
export function consoleIo(
  pick: UploadProjectIo['pick'],
  s: { input?: ConsoleIn; output?: ConsoleOut; settleMs?: number; exit?: (code: number) => void } = {},
): { io: UploadProjectIo; clear: () => void; close: () => void } {
  const input: ConsoleIn = s.input ?? process.stdin;
  const out = s.output ?? process.stdout;
  // 書く口は今のうちに取っておく(集計の間は process.stdout.write を差し替えるので、書くたびに引くと自分の出力まで経過のファイルに行く)
  const write = out.write.bind(out) as (text: string) => boolean;
  const stream = { write } as unknown as NodeJS.WritableStream;
  const setRaw = (on: boolean): boolean => {
    if (input.isTTY !== true || typeof input.setRawMode !== 'function') return false;
    try {
      input.setRawMode(on);
      return true;
    } catch {
      return false;
    }
  };
  /** 1 文字ずつ受け取る状態にできた端末か(できなければ、届いた行を捨てるだけの前のやり方に落とす) */
  const raw = setRaw(true);
  // raw のときは、尋ねている間に届いた分だけを行に分ける(尋ねていない間の分は渡さないので、行の頭に残らない)
  const feed = raw ? new PassThrough() : null;
  const rl = createInterface({ input: feed ?? input, crlfDelay: Infinity });
  const keepEarly = input.isTTY !== true;
  const early: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  let asking = false;
  let closed = false;
  const answer = (line: string): void => {
    const w = waiting;
    waiting = null;
    if (asking) {
      asking = false;
      setRaw(true);
    }
    w?.(line);
  };
  const onData = (chunk: Buffer | string): void => {
    if (asking) {
      feed!.write(chunk);
      return;
    }
    // 1 文字ずつ受け取る間は Ctrl+C も文字として届く(端末が止めてくれない)ので、ここで終わる。
    // 端末を元に戻し、書き換えていた 1 行を消して、中断したことを 1 行で出す。
    // 終わり方は、端末が止めたとき(SIGINT)にそろえて、終了コード 130 で終わる。
    // process.exit は finally を通らないので、要る後始末は 'exit' に掛けておく(このファイルの末尾の起動の部分)
    if (String(chunk).includes('\x03')) {
      setRaw(false);
      const had = shown;
      clear();
      write(`${had ? '' : '\n'}  中断しました。\n`);
      if (s.exit) s.exit(130);
      else process.exit(130);
    }
  };
  const onEnd = (): void => void feed!.end();
  if (feed) {
    input.on('data', onData);
    input.on('end', onEnd);
  }
  rl.on('line', (line) => {
    if (waiting) answer(line);
    else if (keepEarly) early.push(line);
    else dropped();
  });
  rl.on('close', () => {
    closed = true;
    answer('');
  });
  // 書き換える 1 行が出ているか。次に何かを書く前に消す
  let shown = false;
  let lastStatus = '';
  /**
   * raw にできなかった端末で、尋ねていない間に入った行を捨てたとき: 窓には打った文字と改行が写っている(行を読む前に端末が写す)ので、
   * 1 行上に戻ってその行を消し、書き換えていた 1 行を書き直す(進み具合の行が 1 行で済むように)。raw のときは端末が写さないので要らない
   */
  const dropped = (): void => {
    if (!out.isTTY || raw) return;
    moveCursor(stream, 0, -1);
    clearLine(stream, 0);
    cursorTo(stream, 0);
    if (shown) write(lastStatus);
  };
  const clear = (): void => {
    if (!shown) return;
    clearLine(stream, 0);
    cursorTo(stream, 0);
    shown = false;
  };
  const io: UploadProjectIo = {
    ask: async (q) => {
      clear();
      write(q);
      if (early.length) return early.shift()!.trim();
      if (closed) return '';
      if (feed) {
        // 集計などで手が離せなかった間に打たれたキーは、まだ届いていないことがある。届き切るのを少し待って捨ててから、行で受け取る状態に戻す
        await new Promise((r) => setTimeout(r, s.settleMs ?? 50));
        if (closed) return '';
        asking = true;
        setRaw(false);
      }
      const line = await new Promise<string>((r) => (waiting = r));
      return line.trim();
    },
    print: (l) => {
      clear();
      write(`${l}\n`);
    },
    pick,
    ...(out.isTTY
      ? {
          status: (text: string): void => {
            clear();
            // 折り返すと 1 行では消えないので、改行やタブは空白にして、窓の幅に収める
            lastStatus = fit(text.replace(/[\r\n\t\v\f]+/g, ' '), (out.columns || 80) - 1);
            write(lastStatus);
            shown = true;
          },
        }
      : {}),
  };
  return {
    io,
    clear,
    close: () => {
      rl.close();
      if (feed) {
        input.off('data', onData);
        input.off('end', onEnd);
        // 端末を元の状態(行で受け取る)に戻し、読むのを止める(読み続けると、プロセスが終わらない)
        setRaw(false);
        input.pause();
      }
    },
  };
}

/** 集計の経過を書くファイル(集計に失敗したときに場所を出す) */
export const UPLOAD_LOG = join(tmpdir(), 'atlas-upload-project.log');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 置き場は atlas.bat と同じ既定(out/ と atlas-notes/)
  const paths = resolvePaths({ home: null, out: null, judgments: null });
  const c = consoleIo((initial) => pickFolder('プロジェクトのセッションを送る先のフォルダを選んでください', initial));
  // Ctrl+C で終わるときは finally を通らないので、集計の作業中の印(out/.job.json)はここで外す(自分の印だけを消す。無ければ何もしない)。
  // 写している途中のフォルダ(.<id>.uploading)は消さない(置き換えの最中かもしれない。次のアップロードが片付け、集計は数えない)
  process.once('exit', () => releaseOutLock(paths.out));
  try {
    // 集計もここで動かす(別のプログラムにすると、集計を待つ間に押した Enter が、送る操作の最初の答えになるため)
    if (!(await refreshAggregate(c.io, { logPath: UPLOAD_LOG, run: (log) => runCli(parseCli(['all']), log) }))) process.exitCode = 1;
    else {
      const sent = await runUploadProject(c.io, {
        paths,
        configPath: defaultConfigPath(),
      });
      process.exitCode = 0;
      // 毎回手で送らずに済むよう、自動で送る登録がまだなら知らせる(調べられなければ何も出さない)
      if (sent && process.platform === 'win32') {
        const { taskScheduler } = await import('./upload-schedule.ts');
        const task = await taskScheduler()
          .query()
          .catch(() => null);
        if (task && !task.exists) c.io.print('  毎日決まった時刻に自動で送るなら、schedule-upload.bat で登録できます。');
      }
    }
  } catch (e) {
    c.clear();
    // 送れなかったプロジェクトと理由は、もう画面に出してある(同じことを 2 度書かない)
    if (!(e instanceof UploadIncompleteError)) process.stderr.write(`\n止まりました: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    c.close();
  }
}
