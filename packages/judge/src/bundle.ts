// 評価バンドルの生成: <bundleDir>/sessions/<id>.md + manifest.json + INSTRUCTIONS.md + schema.json
// ZIP は作らない(Node 標準で作れず、依存を増やさないため)。フォルダごと ZIP にして外部 LLM に渡す。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from '../../core/src/index.ts';
import { collectTexts, DEFAULT_LIMITS, excerptTexts, hasRequest, renderPacket, type PacketLimits, type SessionTexts } from './packet.ts';
import { renderInstructions } from './rubric.ts';
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
}

export interface BundleOptions {
  /** 出力先(既定は <out>/bundle) */
  bundleDir: string;
  /** 本文を読み直すスナップショット(無ければ sessions.json の抜粋で代用) */
  snapshotDir?: string | null;
  limits?: PacketLimits;
  /** 依頼の無いセッションも含める */
  includeEmpty?: boolean;
  scope?: Record<string, string | null>;
  log?: (msg: string) => void;
  now?: () => Date;
}

export function packetFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

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

  // 前回の生成物を消す(絞り込みで減ったパケットを残さない)
  await rm(join(dir, 'sessions'), { recursive: true, force: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });

  const entries: BundleEntry[] = [];
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
  };
  await writeFile(join(dir, 'INSTRUCTIONS.md'), renderInstructions({ count: entries.length, generatedAt }));
  await writeFile(join(dir, 'schema.json'), `${JSON.stringify(JUDGMENTS_JSON_SCHEMA, null, 2)}\n`);
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
