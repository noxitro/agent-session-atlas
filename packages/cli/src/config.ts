// 設定ファイル atlas.config.json の読み込み。今は wiki の指定だけを持つ
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WikiSpec } from '../../core/src/index.ts';

export const CONFIG_FILE = 'atlas.config.json';

export interface AtlasConfig {
  /** 読んだ設定ファイル。使っていなければ null */
  path: string | null;
  /** 参照を数える vault。設定に無ければ null(core の既定) */
  wikis: WikiSpec[] | null;
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
  for (const k of Object.keys(v)) if (k !== 'wikis') throw new Error(`不明な項目です: ${k}`);
  if (v.wikis === undefined) return { wikis: null };
  if (!Array.isArray(v.wikis)) throw new Error('wikis は配列で指定してください');
  return { wikis: v.wikis.map(parseWiki) };
}

/** 設定を読む。path を明示したときだけファイルが無いと失敗し、既定の場所に無ければ設定なしで続ける */
export async function loadConfig(path: string, required: boolean): Promise<AtlasConfig> {
  if (!existsSync(path)) {
    if (required) throw new Error(`設定ファイルがありません: ${path}`);
    return { path: null, wikis: null };
  }
  try {
    // メモ帳などが付ける BOM は取り除く
    return { path, ...parseConfig(JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))) };
  } catch (e) {
    throw new Error(`設定ファイル ${path} を読めません: ${(e as Error).message}`);
  }
}
