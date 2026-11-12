// 「別のフォルダを開く」(atlas open)で、前に集計したときから何も変わっていなければ、作り直さずにそのときのレポートを使う。
// 共有フォルダから写す(snapshot)のは毎回行う(元が変わったかは、写してみないと分からない)。その後の extract・metrics・build は、
// 入力が前と同じなら出力も同じなので省く。
//   <置き場>/<キー>/built.json … 前に集計したときの入力の印(key)と、そのとき書いた出力の大きさと更新日時(outputs)
// 入力の印に入れるもの(どれかが変われば作り直す):
//   - atlas のコードの版(codeStamp)
//   - 集計に渡したオプション(絞り込みなど)と、設定ファイルの中身
//   - 写した複製(<out>/snapshot/)の全ファイルの名前・大きさ・更新日時と、manifest(作った日時は除く)
//   - 判定(judgments.json・turn-judgments.json)とタスクタグ(groups.json)の大きさと更新日時
// 出力(atlas.html・sessions.json・metrics.json と、あれば vcs-retention.json)が built.json に書いたものと違えば、別の処理(画面の「集計し直す」・判定・手で実行した export)が
// 書き換えているので、作り直す。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { codeStamp, SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE, VCS_RETENTION_FILE } from '../../core/src/index.ts';

export const BUILT_FILE = 'built.json';

export interface BuiltStamp {
  version: 1;
  /** 入力の印 */
  key: string;
  /** 出力のファイル(出力先からの相対パス)ごとの「大きさ:更新日時」 */
  outputs: Record<string, string>;
  builtAt: string;
}

/** 入力の印と出力を確かめるのに使う場所 */
export interface ReusePaths {
  out: string;
  snapshot: string;
  judgments: string;
  turnJudgments: string;
  groups: string;
}

/** 確かめる出力(出力先からの相対パス)。画面が読む atlas.html と、その元の sessions.json・metrics.json */
const OUTPUT_FILES = ['atlas.html', 'sessions.json', 'metrics.json'] as const;
/** あれば確かめる出力。VCS の照合の結果(照合できなかったときは無い。手で atlas vcs を実行して作り直したら、レポートも作り直す) */
const OPTIONAL_OUTPUT_FILES = [VCS_RETENTION_FILE] as const;
/** 無いファイルの印 */
const ABSENT = 'none';

/** manifest の sessions のうち、元が同じでも変わる項目(1 回目は写した数、2 回目からは前の複製を使った数に入る) */
const VOLATILE_SESSION_COUNTS = ['copiedFiles', 'reusedFiles', 'dbCopied', 'dbReused'] as const;

/** ファイルの「大きさ:更新日時」。無ければ null */
function statKey(path: string): string | null {
  try {
    const s = statSync(path);
    return s.isFile() ? `${s.size}:${s.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/** 出力のファイルごとの「大きさ:更新日時」。1 つでも無ければ null(使い回せない) */
export function outputsOf(out: string): Record<string, string> | null {
  const r: Record<string, string> = {};
  for (const f of OUTPUT_FILES) {
    const k = statKey(join(out, f));
    if (k == null) return null;
    r[f] = k;
  }
  for (const f of OPTIONAL_OUTPUT_FILES) r[f] = statKey(join(out, f)) ?? ABSENT;
  return r;
}

/**
 * 入力の印。options は集計に渡したオプション(JSON にできる値)、configPath は読む設定ファイル(無ければ中身は空として数える)。
 * 写した複製は手元のディスクにあるので、全ファイルを調べても軽い(1,600 セッションで 1 秒未満)
 */
export function inputsKey(p: ReusePaths, options: unknown, configPath: string): string {
  const h = createHash('sha256');
  const add = (label: string, value: string): void => {
    h.update(label);
    h.update('\0');
    h.update(value);
    h.update('\0');
  };
  add('code', codeStamp());
  add('options', JSON.stringify(options));
  let config = '';
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    /* 設定ファイルが無い */
  }
  add('config', config);
  // manifest は、元が同じでも集計のたびに変わる項目(作った日時と、今回写した数・前の複製を使った数)を除いた中身を入れる。
  // 始めたときの印(SNAPSHOT_SOURCE)も毎回変わるので入れない
  let manifest = '';
  try {
    const m = JSON.parse(readFileSync(join(p.snapshot, SNAPSHOT_MANIFEST), 'utf8')) as { createdAt?: unknown; sessions?: Record<string, unknown> };
    delete m.createdAt;
    if (m.sessions && typeof m.sessions === 'object') for (const k of VOLATILE_SESSION_COUNTS) delete m.sessions[k];
    manifest = JSON.stringify(m);
  } catch {
    /* manifest が無い・読めない */
  }
  add('manifest', manifest);
  const files: string[] = [];
  for (const e of readdirSync(p.snapshot, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    const rel = relative(p.snapshot, path).split(sep).join('/');
    if (rel === SNAPSHOT_MANIFEST || rel === SNAPSHOT_SOURCE) continue;
    files.push(`${rel}\0${statKey(path) ?? ''}`);
  }
  files.sort();
  add('snapshot', files.join('\n'));
  for (const [label, path] of [
    ['judgments', p.judgments],
    ['turn-judgments', p.turnJudgments],
    ['groups', p.groups],
  ] as const)
    add(label, statKey(path) ?? '');
  return h.digest('hex');
}

export function readBuilt(file: string): BuiltStamp | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuiltStamp>;
    if (j.version !== 1 || typeof j.key !== 'string' || !j.outputs || typeof j.outputs !== 'object' || typeof j.builtAt !== 'string') return null;
    return { version: 1, key: j.key, outputs: j.outputs, builtAt: j.builtAt };
  } catch {
    return null;
  }
}

/** 前に集計したときのレポートを使い回せるか(入力の印が同じで、出力がそのときのまま) */
export function canReuse(prev: BuiltStamp | null, key: string, out: string): prev is BuiltStamp {
  if (!prev || prev.key !== key) return false;
  const now = outputsOf(out);
  return now != null && [...OUTPUT_FILES, ...OPTIONAL_OUTPUT_FILES].every((f) => prev.outputs[f] === now[f]);
}

/** 作り直す前に、前の印を消す(途中で止まったときに、古い印と新しい出力が食い違ったまま残らないように) */
export function clearBuilt(file: string): void {
  rmSync(file, { force: true });
}

/** 集計が最後まで済んだら、入力の印と出力を書く。出力が揃っていなければ書かない */
export function writeBuilt(file: string, key: string, out: string): void {
  const outputs = outputsOf(out);
  if (!outputs) return;
  const s: BuiltStamp = { version: 1, key, outputs, builtAt: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}
