// 評価バンドルの生成: <bundleDir>/sessions/<id>.md + manifest.json + INSTRUCTIONS.md + schema.json + parts/part-<番号>.md
// ZIP は作らない(Node 標準で作れず、依存を増やさないため)。フォルダごと ZIP にして外部 LLM に渡すか、
// ZIP を渡せない相手(M365 Copilot のようにテキストの添付だけ)には parts/ のファイルを 1 つずつ渡す。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from '../../core/src/index.ts';
import { collectTexts, DEFAULT_LIMITS, excerptTexts, hasRequest, renderPacket, type PacketLimits, type SessionTexts } from './packet.ts';
import { packetBoundary, renderInstructions, renderPartInstructions } from './rubric.ts';
import { JUDGMENTS_JSON_SCHEMA } from './schema.ts';

export const BUNDLE_MANIFEST_VERSION = 1;

export interface BundleEntry {
  id: string;
  /** バンドルからの相対パス(/ 区切り) */
  path: string;
  project: string;
  client: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  turns: number;
  chars: number;
  bytes: number;
  textSource: SessionTexts['source'];
  /** 上限で中略した本文の件数 */
  truncated: number;
}

export interface BundleManifest {
  version: number;
  generatedAt: string;
  /** 絞り込み条件など(表示用) */
  scope: Record<string, string | null>;
  count: number;
  totalBytes: number;
  maxBytes: number;
  limits: PacketLimits;
  files: { instructions: string; schema: string };
  sessions: BundleEntry[];
  /** 依頼が無くて対象外にしたセッション */
  skipped: { id: string; reason: string }[];
  /** 1 つの分割ファイル(parts/)に入れるパケットの数。古い manifest には無い */
  perPart?: number;
  /** 指示とパケットを数件ずつまとめた分割ファイル。並びは sessions と同じ。古い manifest には無い */
  parts?: { path: string; sessions: string[]; bytes: number }[];
}

export interface BundleOptions {
  /** 出力先(既定は <out>/bundle) */
  bundleDir: string;
  /** 本文を読み直すスナップショット(無ければ sessions.json の抜粋で代用) */
  snapshotDir?: string | null;
  limits?: PacketLimits;
  /** 依頼の無いセッションも含める */
  includeEmpty?: boolean;
  /** 1 つの分割ファイルに入れるパケットの数(既定 DEFAULT_PER_PART) */
  perPart?: number;
  /** テスト用: 分割ファイルの境界の文字列を作る */
  boundary?: () => string;
  scope?: Record<string, string | null>;
  log?: (msg: string) => void;
  now?: () => Date;
}

/** 1 つの分割ファイルに入れるパケットの既定の数。1 パケットは最大 24,000 字なので、1 ファイル最大 12 万字ほど */
export const DEFAULT_PER_PART = 5;

export function packetFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/**
 * 前回の生成物を消すときの指定。ほかのプログラム(ウイルス対策・検索の索引・開いたままのアプリ)がファイルを一時的に掴んでいると
 * Windows では EBUSY / EPERM / ENOTEMPTY になるので、少し待ってやり直す。
 * やり直しはフォルダーとその中のファイルの両方で数えられるので、待ちは掛け算で延びる:
 * この指定で、フォルダーの直下のファイルが掴まれ続けたときに諦めるまで約 3 秒(maxRetries 5 / retryDelay 200 だと約 21 秒で、画面が長く止まって見える)
 */
export const REMOVE = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const;

export async function buildBundle(sessions: SessionRecord[], opts: BundleOptions): Promise<BundleManifest> {
  const log = opts.log ?? (() => {});
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const generatedAt = (opts.now?.() ?? new Date()).toISOString();
  const dir = opts.bundleDir;

  let texts = new Map<string, SessionTexts>();
  if (opts.snapshotDir && existsSync(join(opts.snapshotDir, 'session-state'))) {
    texts = await collectTexts(opts.snapshotDir, sessions);
  } else {
    log(`bundle: 注意 スナップショット${opts.snapshotDir ? `(${opts.snapshotDir})` : ''}が無いため、本文は sessions.json の抜粋(先頭・末尾 2,000 字)で代用します`);
  }

  // 前回の生成物を消す(絞り込みで減ったパケットを残さない)。一覧(manifest.json)を最初に消す:
  // 途中で止まったときに、消した後のファイルを指す古い一覧が「作成済み」として残らないようにする
  await rm(join(dir, 'manifest.json'), REMOVE);
  await rm(join(dir, 'sessions'), REMOVE);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await rm(join(dir, 'parts'), REMOVE);

  const entries: BundleEntry[] = [];
  const markdowns = new Map<string, string>();
  const skipped: BundleManifest['skipped'] = [];
  for (const s of sessions) {
    const t = texts.get(s.id) ?? excerptTexts(s);
    if (!opts.includeEmpty && !hasRequest(s, t)) {
      skipped.push({ id: s.id, reason: 'ユーザーの依頼が記録されていない' });
      continue;
    }
    const p = renderPacket(s, t, limits);
    const file = packetFileName(s.id);
    const bytes = Buffer.byteLength(p.markdown);
    await writeFile(join(dir, 'sessions', file), p.markdown);
    markdowns.set(s.id, p.markdown);
    entries.push({
      id: s.id,
      path: `sessions/${file}`,
      project: s.project,
      client: s.client,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      turns: s.turns,
      chars: p.chars,
      bytes,
      textSource: t.source,
      truncated: p.truncated,
    });
  }
  entries.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

  const perPart = opts.perPart ?? DEFAULT_PER_PART;
  if (!Number.isInteger(perPart) || perPart < 1) throw new Error(`perPart は 1 以上の整数です: ${perPart}`);
  const schemaJson = `${JSON.stringify(JUDGMENTS_JSON_SCHEMA, null, 2)}\n`;
  const parts: NonNullable<BundleManifest['parts']> = [];
  const partCount = Math.ceil(entries.length / perPart);
  if (partCount > 0) await mkdir(join(dir, 'parts'), { recursive: true });
  const width = Math.max(2, String(partCount).length);
  for (let i = 0; i < partCount; i++) {
    const chunk = entries.slice(i * perPart, (i + 1) * perPart);
    const boundary = (opts.boundary ?? packetBoundary)();
    const head = renderPartInstructions({ part: i + 1, parts: partCount, ids: chunk.map((e) => e.id), total: entries.length, generatedAt, boundary, schemaJson });
    const body = chunk.map((e) => `\n<<<PACKET_BEGIN ${boundary}\n${markdowns.get(e.id)!.trimEnd()}\nPACKET_END ${boundary}>>>\n`).join('');
    const md = head + body;
    const path = `parts/part-${String(i + 1).padStart(width, '0')}.md`;
    await writeFile(join(dir, path), md);
    parts.push({ path, sessions: chunk.map((e) => e.id), bytes: Buffer.byteLength(md) });
  }

  const manifest: BundleManifest = {
    version: BUNDLE_MANIFEST_VERSION,
    generatedAt,
    scope: opts.scope ?? {},
    count: entries.length,
    totalBytes: entries.reduce((a, e) => a + e.bytes, 0),
    maxBytes: entries.reduce((a, e) => Math.max(a, e.bytes), 0),
    limits,
    files: { instructions: 'INSTRUCTIONS.md', schema: 'schema.json' },
    sessions: entries,
    skipped,
    perPart,
    parts,
  };
  await writeFile(join(dir, 'INSTRUCTIONS.md'), renderInstructions({ count: entries.length, generatedAt }));
  await writeFile(join(dir, 'schema.json'), schemaJson);
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readBundleManifest(bundleDir: string): Promise<BundleManifest> {
  const p = join(bundleDir, 'manifest.json');
  if (!existsSync(p)) throw new Error(`${p} がありません。先に atlas bundle を実行してください。`);
  const m = JSON.parse(await readFile(p, 'utf8')) as BundleManifest;
  if (m.version !== BUNDLE_MANIFEST_VERSION || !Array.isArray(m.sessions)) throw new Error(`${p} の形式が想定と違います(version ${String(m.version)})`);
  return m;
}
