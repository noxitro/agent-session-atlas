// 設定ファイル atlas.config.json の読み込み。wiki の指定と、依頼ごとの判定に使う普段の工程名、グループのアップロード先を持つ
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_PHASE_NAMES, renameReplacing, type WikiSpec } from '../../core/src/index.ts';

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
}

const KEYS = ['wikis', 'phases', 'uploadRoot'] as const;

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
  return { wikis, phases, uploadRoot };
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

/**
 * 設定ファイルの 1 項目だけを書き換える。書く前に読むときと同じ検査を通す。ファイルが無ければ作る。読めない(壊れた)ファイルは上書きしない。
 * 文字列の値を差し替える・末尾に足すだけで済むときは、他の項目の書き方(手で詰めた配列など)をそのまま残す。済まなければ全体を整えて書く。
 * 一時ファイルに書いてから置き換える(途中で止まっても設定ファイルが欠けない)
 */
export async function updateConfig(path: string, key: (typeof KEYS)[number], value: unknown): Promise<void> {
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
  const next = { ...cur, [key]: value };
  if (value === undefined) delete next[key];
  parseConfig(next);
  let text = `${JSON.stringify(next, null, 2)}\n`;
  if (raw != null && typeof value === 'string') {
    const lit = JSON.stringify(value);
    const at = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    const end = raw.lastIndexOf('}');
    const kept =
      key in cur
        ? raw.replace(at, (_m, head: string) => `${head}${lit}`)
        : end > 0
          ? `${raw.slice(0, end).trimEnd()}${Object.keys(cur).length ? ',' : ''}\n  "${key}": ${lit}\n${raw.slice(end)}`
          : null;
    // 差し替えた結果が狙いどおりの中身になったときだけ使う(同じ名前が別の場所にある等で外れたら、整えて書く)
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
}

/** 依頼ごとの判定に使う普段の工程名(環境変数 ATLAS_CONFIG かリポジトリ直下の atlas.config.json の phases、無ければ既定) */
export async function phaseNames(): Promise<string[]> {
  return (await loadConfig(defaultConfigPath(), process.env.ATLAS_CONFIG != null)).phases ?? [...DEFAULT_PHASE_NAMES];
}

/** 設定を読む。path を明示したときだけファイルが無いと失敗し、既定の場所に無ければ設定なしで続ける */
export async function loadConfig(path: string, required: boolean): Promise<AtlasConfig> {
  if (!existsSync(path)) {
    if (required) throw new Error(`設定ファイルがありません: ${path}`);
    return { path: null, wikis: null, phases: null, uploadRoot: null };
  }
  try {
    // メモ帳などが付ける BOM は取り除く
    return { path, ...parseConfig(JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))) };
  } catch (e) {
    throw new Error(`設定ファイル ${path} を読めません: ${(e as Error).message}`);
  }
}
