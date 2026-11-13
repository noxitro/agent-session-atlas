// 設定ファイル atlas.config.json の読み込み。wiki の指定と、依頼ごとの判定に使う普段の工程名、グループのアップロード先、upload-project.bat がまとめて送るプロジェクトを持つ
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_PHASE_NAMES, renameReplacing, RETENTION_STATUSES, type PathMapping, type RetentionStatus, type WikiSpec } from '../../core/src/index.ts';

export const CONFIG_FILE = 'atlas.config.json';

export interface AtlasConfig {
  /** 読んだ設定ファイル。使っていなければ null */
  path: string | null;
  /** 参照を数える vault。設定に無ければ null(wiki は数えない) */
  wikis: WikiSpec[] | null;
  /** 依頼ごとの判定(段階 2)で LLM に選ばせる普段の工程名。設定に無ければ null(既定の DEFAULT_PHASE_NAMES) */
  phases: string[] | null;
  /** グループのアップロード先の基底フォルダ(<基底>\<グループ名>\<セッション id>\ に写す)。設定に無ければ null */
  uploadRoot: string | null;
  /** upload-project.bat がまとめて送るプロジェクト(集計のプロジェクト名。画面の「プロジェクト別」で選ぶ)。設定に無いか空なら null(bat で番号を選ぶ) */
  uploadProjects: string[] | null;
  /**
   * LLM の判定(judge run・turns run・skill-draft と画面の「このツールが判定する」)で Copilot CLI に渡すモデル。
   * 自分の API キーのモデル(BYOK)は <プロバイダー名>/<モデル ID>(例: anthropic/claude-sonnet-5-5)。設定に無ければ null(Copilot の既定のモデル。AI クレジットを使う)
   */
  judgeModel: string | null;
  /**
   * AI の変更がその後の VCS のファイルに残っているかの照合(atlas vcs)。pathMap はリポジトリを別の場所へ移したときの、ログのパス → 今の場所。
   * mode は比べる版をどこで見るか(worktree = 今の作業ツリー、committed = 最後に取り込んだ版、fixed = セッションの終わりから lagDays 日後の版)。設定に無ければ省略
   */
  vcs?: VcsConfig | null;
}

export interface VcsConfig {
  pathMap: PathMapping[];
  mode: 'worktree' | 'committed' | 'fixed' | null;
  /** mode が fixed のときの日数(1〜365。設定に無ければ省略し、既定の 7 日) */
  lagDays?: number;
  /** 状態の名前の差し替え(kept / modified / missing / unattributable → 表と画面に出す名前)。設定に無ければ省略 */
  labels?: Partial<Record<RetentionStatus, string>>;
  /** 画面の「AI の変更の残存」の節の説明に足す一文。設定に無ければ省略 */
  note?: string;
}

/** 名前と一文の長さの上限(画面と表の見出しに入るため) */
const VCS_LABEL_MAX = 40;
const VCS_NOTE_MAX = 1000;

const KEYS = ['wikis', 'phases', 'uploadRoot', 'uploadProjects', 'judgeModel', 'vcs'] as const;

/** vcs の項目。書き間違いは照合が 0 件になって気付きにくいので止める */
function parseVcs(v: unknown): VcsConfig {
  if (!isObject(v)) throw new Error('vcs はオブジェクトで指定してください(例: { "pathMap": [{ "from": "D:\\\\old\\\\repo", "to": "E:\\\\dev\\\\repo" }] })');
  for (const k of Object.keys(v)) if (!['pathMap', 'mode', 'lagDays', 'labels', 'note'].includes(k)) throw new Error(`vcs の不明な項目です: ${k}`);
  let labels: VcsConfig['labels'];
  if (v.labels !== undefined) {
    if (!isObject(v.labels)) throw new Error('vcs.labels は { "kept": "…", "modified": "…", "missing": "…", "unattributable": "…" } の形で指定してください');
    labels = {};
    for (const [k, name] of Object.entries(v.labels)) {
      if (!(RETENTION_STATUSES as readonly string[]).includes(k)) throw new Error(`vcs.labels の不明な状態です: ${k}(${RETENTION_STATUSES.join(' / ')})`);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > VCS_LABEL_MAX || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error(`vcs.labels.${k} には ${VCS_LABEL_MAX} 文字以内の名前を指定してください`);
      labels[k as RetentionStatus] = name.trim();
    }
  }
  let note: string | undefined;
  if (v.note !== undefined) {
    if (typeof v.note !== 'string' || !v.note.trim() || v.note.length > VCS_NOTE_MAX) throw new Error(`vcs.note には ${VCS_NOTE_MAX} 文字以内の文を指定してください`);
    note = v.note.trim();
  }
  let mode: VcsConfig['mode'] = null;
  if (v.mode !== undefined) {
    if (v.mode !== 'worktree' && v.mode !== 'committed' && v.mode !== 'fixed') throw new Error('vcs.mode は "worktree"・"committed"・"fixed" のどれかです');
    mode = v.mode;
  }
  let lagDays: number | undefined;
  if (v.lagDays !== undefined) {
    if (typeof v.lagDays !== 'number' || !Number.isInteger(v.lagDays) || v.lagDays < 1 || v.lagDays > 365) throw new Error('vcs.lagDays には 1〜365 の整数(日数)を指定してください');
    lagDays = v.lagDays;
  }
  const pathMap: PathMapping[] = [];
  if (v.pathMap !== undefined) {
    if (!Array.isArray(v.pathMap)) throw new Error('vcs.pathMap は配列で指定してください');
    v.pathMap.forEach((m, i) => {
      const where = `vcs.pathMap[${i}]`;
      if (!isObject(m)) throw new Error(`${where} は { "from": "...", "to": "..." } で指定してください`);
      for (const k of Object.keys(m)) if (k !== 'from' && k !== 'to') throw new Error(`${where} の不明な項目です: ${k}`);
      if (typeof m.from !== 'string' || typeof m.to !== 'string' || !m.from.trim() || !m.to.trim()) throw new Error(`${where} の from と to にフォルダのパスを指定してください`);
      const from = m.from.trim();
      const to = m.to.trim();
      // Windows のパスは、POSIX で集計するときもフルパスとして受け付ける(ログに残るのは元の PC のパスのため)
      if (!isAbsolute(from) && !/^[A-Za-z]:[\\/]/.test(from)) throw new Error(`${where}.from はフルパスで指定してください: ${from}`);
      if (!isAbsolute(to) && !/^[A-Za-z]:[\\/]/.test(to)) throw new Error(`${where}.to はフルパスで指定してください: ${to}`);
      pathMap.push({ from, to });
    });
  }
  return { pathMap, mode, ...(lagDays ? { lagDays } : {}), ...(labels ? { labels } : {}), ...(note ? { note } : {}) };
}

const WIKI_LISTS = ['index', 'pages', 'extensions', 'skills'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) throw new Error(`${where} は文字列の配列で指定してください`);
  return v as string[];
}

function parseWiki(v: unknown, i: number): WikiSpec {
  const where = `wikis[${i}]`;
  if (typeof v === 'string') return parseWiki({ path: v }, i);
  if (!isObject(v)) throw new Error(`${where} は文字列かオブジェクトで指定してください`);
  // 書き間違いは 0 件の集計になって気付きにくいので止める
  for (const k of Object.keys(v)) if (k !== 'path' && !(WIKI_LISTS as readonly string[]).includes(k)) throw new Error(`${where} の不明な項目です: ${k}`);
  const { path } = v;
  if (typeof path !== 'string' || !/[^./\\~\s]/.test(path)) throw new Error(`${where}.path に vault のフォルダ名かパスを指定してください`);
  const spec: WikiSpec = { path: /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path };
  for (const k of WIKI_LISTS) if (v[k] !== undefined) spec[k] = stringList(v[k], `${where}.${k}`);
  return spec;
}

export function parseConfig(v: unknown): Omit<AtlasConfig, 'path'> {
  if (!isObject(v)) throw new Error('全体をオブジェクトにしてください');
  for (const k of Object.keys(v)) if (!(KEYS as readonly string[]).includes(k)) throw new Error(`不明な項目です: ${k}`);
  let wikis: WikiSpec[] | null = null;
  if (v.wikis !== undefined) {
    if (!Array.isArray(v.wikis)) throw new Error('wikis は配列で指定してください');
    wikis = v.wikis.map(parseWiki);
  }
  let phases: string[] | null = null;
  if (v.phases !== undefined) {
    phases = stringList(v.phases, 'phases').map((x) => x.trim());
    if (phases.length < 2) throw new Error('phases は 2 つ以上指定してください');
    if (new Set(phases).size !== phases.length) throw new Error('phases に同じ名前が 2 回あります');
  }
  let uploadRoot: string | null = null;
  if (v.uploadRoot !== undefined) uploadRoot = parseUploadRoot(v.uploadRoot);
  let uploadProjects: string[] | null = null;
  if (v.uploadProjects !== undefined) {
    // 名前は集計のプロジェクト名そのもの(前後の空白も名前のうちなので削らない)。同じ名前は 1 つにする
    const names = [...new Set(stringList(v.uploadProjects, 'uploadProjects'))];
    uploadProjects = names.length ? names : null;
  }
  let judgeModel: string | null = null;
  if (v.judgeModel !== undefined) {
    if (typeof v.judgeModel !== 'string' || !/^[^\s"]+$/.test(v.judgeModel.trim())) throw new Error('judgeModel にはモデル名を 1 つ指定してください(例: anthropic/claude-sonnet-5-5)');
    judgeModel = v.judgeModel.trim();
  }
  const vcs = v.vcs !== undefined ? parseVcs(v.vcs) : null;
  return { wikis, phases, uploadRoot, uploadProjects, judgeModel, ...(vcs ? { vcs } : {}) };
}

/** Copilot CLI の BYOK のモデル(<プロバイダー名>/<モデル ID>)か。Copilot が用意するモデルの名前には / が無い */
export function isByokModel(model: string | null): boolean {
  return !!model && /^[^/\s]+\/[^/\s]+$/.test(model);
}

/** アップロード先の基底フォルダ。フルパス(~\ で始まるものはホームから)だけを受け付ける(相対パスは起動した場所で意味が変わるため) */
export function parseUploadRoot(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('uploadRoot にはアップロード先のフォルダのフルパスを指定してください');
  const raw = v.trim().replace(/^"(.*)"$/, '$1');
  const full = /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(full)) throw new Error(`uploadRoot はフルパスで指定してください(例: E:\\dev\\atlas-logs): ${raw}`);
  return resolve(full);
}

/** 設定ファイルの既定の場所(環境変数 ATLAS_CONFIG、無ければリポジトリ直下の atlas.config.json) */
export function defaultConfigPath(): string {
  const explicit = process.env.ATLAS_CONFIG ?? null;
  return explicit ? resolve(explicit) : join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), CONFIG_FILE);
}

/** modifyConfig の関数がこれを返したら、何も書かない(変わらないときに書き方を崩さないように) */
export const NO_CHANGE: unique symbol = Symbol('no change');

/** ロックを取れるまで待つ長さと、落ちた処理が残したロックとみなす古さ */
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;
/**
 * Windows で、ロックを作る・消すときに一時的に出る失敗。消したばかりのロックをほかのプログラム(ウイルス対策の検査など)がまだ
 * 開いていると、同じ名前で作るのが EPERM(削除待ち)になり、消すのが EBUSY / EPERM になる。少し待ってやり直す
 * (fs-retry.ts の renameReplacing と同じ考え方)
 */
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const isTransientLockError = (e: unknown): boolean => process.platform === 'win32' && TRANSIENT_LOCK_CODES.has((e as NodeJS.ErrnoException).code ?? '');

/**
 * 設定ファイルの書き換えを 1 つずつ行うためのロック(<設定ファイル>.lock を排他で作る)。
 * serve(画面の印・アップロード先)と upload-project.bat(送り先の選び直し)は別のプロセスから同じファイルを読んで書くので、
 * 重なると先に書いた分が消える。落ちた処理が残したロックは、古ければ消して取り直す
 */
async function withConfigLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const started = Date.now();
  /** 一時的な失敗のまま待ちきったときに出す、元の失敗 */
  let transient: unknown = null;
  for (;;) {
    try {
      await (await open(lock, 'wx')).close();
      break;
    } catch (e) {
      if (isTransientLockError(e)) {
        transient = e;
        if (Date.now() - started > LOCK_WAIT_MS) throw e;
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
    } catch {
      continue; // 調べる間に消えた(か、消せなかった): すぐ取り直す
    }
    if (Date.now() - started > LOCK_WAIT_MS) {
      if (transient) throw transient;
      throw new Error(`設定ファイル ${path} を別の処理が書き換えています(${lock})。少し待ってからやり直してください`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    return await fn();
  } finally {
    // 書き終えた後にロックを消せなくても、書いたことは失敗にしない(残ったロックは、古くなれば次の処理が消して取り直す)
    await rm(lock, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

/**
 * raw(JSON のオブジェクト)の一番外側にある "key": <値> の、名前の始まりと値の範囲。文字列と括弧の対応を見て読む。見つからなければ null。
 * 外れても、書く前に中身が狙いどおりかを確かめるので、整えて書く方に倒れる
 */
function topLevelSpan(raw: string, key: string): { keyStart: number; start: number; end: number } | null {
  let depth = 0;
  let i = 0;
  const skipString = (k: number): number => {
    for (let j = k + 1; j < raw.length; j++) {
      if (raw[j] === '\\') j++;
      else if (raw[j] === '"') return j + 1;
    }
    return raw.length;
  };
  const skipSpace = (k: number): number => {
    while (k < raw.length && /\s/.test(raw[k]!)) k++;
    return k;
  };
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      const close = skipString(i);
      const colon = skipSpace(close);
      if (depth === 1 && raw[colon] === ':' && JSON.parse(raw.slice(i, close)) === key) {
        const start = skipSpace(colon + 1);
        let end = start;
        if (raw[start] === '"') end = skipString(start);
        else if (raw[start] === '[' || raw[start] === '{') {
          let d = 0;
          for (end = start; end < raw.length; end++) {
            if (raw[end] === '"') {
              end = skipString(end) - 1;
              continue;
            }
            if (raw[end] === '[' || raw[end] === '{') d++;
            else if (raw[end] === ']' || raw[end] === '}') {
              d--;
              if (d === 0) {
                end++;
                break;
              }
            }
          }
        } else while (end < raw.length && !/[\s,}\]]/.test(raw[end]!)) end++;
        return { keyStart: i, start, end };
      }
      i = close;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

/** 書き方をできるだけ残して、1 項目を差し替える・足す・消した JSON の文字列。作れなければ null */
function keepFormatting(raw: string, cur: Record<string, unknown>, key: string, value: unknown): string | null {
  const span = topLevelSpan(raw, key);
  if (value === undefined) {
    if (!span) return null;
    // 前の区切りの , から消す。先頭の項目なら後ろの , と、その行の残りまで消す
    let a = span.keyStart;
    let b = span.end;
    let i = a - 1;
    while (i >= 0 && /\s/.test(raw[i]!)) i--;
    if (raw[i] === ',') a = i;
    else {
      while (a > 0 && /[ \t]/.test(raw[a - 1]!)) a--;
      let j = b;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === ',') {
        b = j + 1;
        while (b < raw.length && /[ \t]/.test(raw[b]!)) b++;
        if (raw[b] === '\r') b++;
        if (raw[b] === '\n') b++;
      }
    }
    return raw.slice(0, a) + raw.slice(b);
  }
  // 値は 2 字下げの形で書く(setup.bat が書く形と同じ。文字列なら 1 行)
  const lit = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  if (key in cur) return span ? raw.slice(0, span.start) + lit + raw.slice(span.end) : null;
  const end = raw.lastIndexOf('}');
  return end > 0 ? `${raw.slice(0, end).trimEnd()}${Object.keys(cur).length ? ',' : ''}\n  "${key}": ${lit}\n${raw.slice(end)}` : null;
}

/**
 * 設定ファイルの 1 項目を、今の設定から決めて書き換える(読んでから書くまでをロックの中で行い、別の処理の書き換えと重ならないようにする)。
 * fn は今の設定(読めた中身を検査したもの)と、書いてあるとおりの中身(~/ などを展開していないもの)を受け取り、新しい値を返す。undefined なら項目を消し、NO_CHANGE なら何も書かない。
 * 書く前に読むときと同じ検査を通す。ファイルが無ければ作る。読めない(壊れた)ファイルは上書きしない。
 * 値を差し替える・末尾に足す・消すだけで済むときは、他の項目の書き方(手で詰めた配列など)をそのまま残す。済まなければ全体を整えて書く。
 * 一時ファイルに書いてから置き換える(途中で止まっても設定ファイルが欠けない)。返すのは fn の返した値
 */
export async function modifyConfig<T>(path: string, key: (typeof KEYS)[number], fn: (current: Omit<AtlasConfig, 'path'>, raw: Readonly<Record<string, unknown>>) => T | typeof NO_CHANGE): Promise<T | typeof NO_CHANGE> {
  return withConfigLock(path, async () => {
    let cur: Record<string, unknown> = {};
    let raw: string | null = null;
    if (existsSync(path)) {
      try {
        raw = (await readFile(path, 'utf8')).replace(/^﻿/, '');
        const v = JSON.parse(raw) as unknown;
        if (!isObject(v)) throw new Error('全体がオブジェクトではありません');
        cur = v;
      } catch (e) {
        throw new Error(`設定ファイル ${path} を読めないので書き換えません(${(e as Error).message})。setup.bat で作り直すか、手で直してください`);
      }
    }
    const value = fn(parseConfig(cur), cur);
    if (value === NO_CHANGE) return value;
    const next = { ...cur, [key]: value };
    if (value === undefined) delete next[key];
    parseConfig(next);
    let text = Object.keys(next).length ? `${JSON.stringify(next, null, 2)}\n` : '{}\n';
    if (raw != null && Object.keys(next).length) {
      const kept = keepFormatting(raw, cur, key, value);
      // 差し替えた結果が狙いどおりの中身になったときだけ使う(読み違えたら、整えて書く)
      try {
        if (kept != null && isDeepStrictEqual(JSON.parse(kept), next)) text = kept;
      } catch {
        /* 整えて書く */
      }
    }
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, text);
    try {
      await renameReplacing(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return value;
  });
}

/** 設定ファイルの 1 項目だけを、決まった値に書き換える(undefined なら消す)。書き方の残し方とロックは modifyConfig と同じ */
export async function updateConfig(path: string, key: (typeof KEYS)[number], value: unknown): Promise<void> {
  await modifyConfig(path, key, () => value);
}

/** 依頼ごとの判定に使う普段の工程名(環境変数 ATLAS_CONFIG かリポジトリ直下の atlas.config.json の phases、無ければ既定) */
export async function phaseNames(): Promise<string[]> {
  return (await loadConfig(defaultConfigPath(), process.env.ATLAS_CONFIG != null)).phases ?? [...DEFAULT_PHASE_NAMES];
}

/** 判定に使うモデル(環境変数 ATLAS_CONFIG かリポジトリ直下の atlas.config.json の judgeModel、無ければ null) */
export async function judgeModelSetting(): Promise<string | null> {
  return (await loadConfig(defaultConfigPath(), process.env.ATLAS_CONFIG != null)).judgeModel;
}

/**
 * 判定に使うモデルを決めて、どこから来たかをログに書く。指定(--model)> 設定の judgeModel > なし(Copilot の既定のモデル)。
 * 設定は copilot-cli のときだけ使う(anthropic バックエンドのモデル名は形が違う)
 */
export async function resolveJudgeModel(explicit: string | null, label: string, log: (msg: string) => void): Promise<string | null> {
  if (explicit) return explicit;
  const m = await judgeModelSetting();
  if (m) log(`${label}: 判定に使うモデル ${m}(atlas.config.json の judgeModel${isByokModel(m) ? '。自分の API キーのモデル(BYOK)なので、Copilot の AI クレジットは使いません' : ''})`);
  else log(`${label}: 注意 モデルを指定していないので、Copilot の既定のモデルで判定します(AI クレジットを使います)。自分の API キーのモデル(BYOK)を使うときは、atlas.config.json に "judgeModel": "anthropic/claude-sonnet-5-5" のように書きます`);
  return m;
}

/** 設定を読む。path を明示したときだけファイルが無いと失敗し、既定の場所に無ければ設定なしで続ける */
export async function loadConfig(path: string, required: boolean): Promise<AtlasConfig> {
  if (!existsSync(path)) {
    if (required) throw new Error(`設定ファイルがありません: ${path}`);
    return { path: null, wikis: null, phases: null, uploadRoot: null, uploadProjects: null, judgeModel: null };
  }
  try {
    // メモ帳などが付ける BOM は取り除く
    return { path, ...parseConfig(JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))) };
  } catch (e) {
    throw new Error(`設定ファイル ${path} を読めません: ${(e as Error).message}`);
  }
}
