// 判定の評価バンドル(atlas bundle)と judgments.json を確かめるための道具(e2e の phase3 が使う)。
// 判定の本体は Rust(crates/atlas-judge)。パケットの見出しと既定の上限は、Rust のソースの定数を読んで使う(テストと本体で値を二重に持たない)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixture-home.ts';

const JUDGE_SRC = join(ROOT, 'crates', 'atlas-judge', 'src');

function rustSource(file: string): string {
  return readFileSync(join(JUDGE_SRC, file), 'utf8');
}

function constOf(text: string, re: RegExp, what: string): string {
  const m = re.exec(text);
  if (!m) throw new Error(`crates/atlas-judge/src の ${what} が読めません(定数の書き方が変わったら、ここを直してください)`);
  return m[1];
}

const PACKET_RS = rustSource('packet.rs');

/** パケットの必須の見出し(packet.rs の PACKET_SECTIONS) */
export const PACKET_SECTIONS: readonly string[] = [...constOf(PACKET_RS, /pub const PACKET_SECTIONS: \[&str; \d+\] = \[([\s\S]*?)\];/, 'PACKET_SECTIONS').matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/** 1 パケットの文字数の上限の既定(packet.rs の DEFAULT_LIMITS.max_chars) */
export const DEFAULT_MAX_CHARS = Number(constOf(PACKET_RS, /pub const DEFAULT_LIMITS: PacketLimits = PacketLimits \{ max_chars: ([\d_]+)/, 'DEFAULT_LIMITS').replaceAll('_', ''));

/** 1 つの分割ファイル(parts/)に入れるパケットの数の既定(bundle.rs の DEFAULT_PER_PART) */
export const DEFAULT_PER_PART = Number(constOf(rustSource('bundle.rs'), /pub const DEFAULT_PER_PART: usize = (\d+);/, 'DEFAULT_PER_PART'));

/** パケットに無い必須の見出し */
export function missingSections(md: string): string[] {
  const lines = md.split(/\r?\n/);
  return PACKET_SECTIONS.filter((h) => !lines.includes(h));
}

/** パケットからセッション ID を読む */
export function packetSessionId(md: string): string | null {
  const m = /^- セッション ID: (\S+)$/m.exec(md);
  return m ? m[1] : null;
}

/** パケットのファイル名 */
export function packetFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/** bundle/manifest.json(テストが見るところだけ) */
export interface BundleManifest {
  version: number;
  generatedAt: string;
  scope: Record<string, string | null>;
  count: number;
  totalBytes: number;
  maxBytes: number;
  limits: { maxChars: number; [key: string]: number };
  files: { instructions: string; schema: string };
  sessions: { id: string; path: string; project: string; client: string | null; turns: number; chars: number; bytes: number; textSource: string; truncated: number }[];
  skipped: { id: string; reason: string }[];
  perPart?: number;
  parts?: { path: string; sessions: string[]; bytes: number }[];
}

export interface JudgmentItem {
  sessionId: string;
  taskCategory: string;
  taskSummary: string;
  humanEffort: { hours: number; low: number; high: number; confidence: number; rationale: string };
  judge?: { backend: string; model: string | null; ranAt: string };
  [key: string]: unknown;
}

/** judgments.json(テストが見るところだけ) */
export interface JudgmentsFile {
  schemaVersion: 1;
  judge: { backend: string; model: string | null; ranAt: string; usage?: { runs: number; missing: number; totals: Record<string, number> } };
  items: JudgmentItem[];
  failures?: { sessionId: string; backend: string; error: string; [key: string]: unknown }[];
}

/**
 * judgments.json の形を確かめて返す(schemaVersion・judge・items の各項目の必須の欄・sessionId の重複)。
 * 項目の値の範囲の検査は Rust(crates/atlas-judge/src/schema.rs)の単体テストが受け持つ
 */
export function validateJudgments(v: unknown): JudgmentsFile {
  const problems: string[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(v)) throw new Error('judgments: ルートがオブジェクトではありません');
  if (v.schemaVersion !== 1) problems.push(`schemaVersion が 1 ではありません(${JSON.stringify(v.schemaVersion)})`);
  if (!isObj(v.judge) || typeof v.judge.backend !== 'string' || typeof v.judge.ranAt !== 'string') problems.push('judge は {backend, model, ranAt} です');
  if (!Array.isArray(v.items)) problems.push('items が配列ではありません');
  else {
    const seen = new Set<string>();
    for (const [i, it] of (v.items as unknown[]).entries()) {
      if (!isObj(it) || typeof it.sessionId !== 'string' || typeof it.taskCategory !== 'string' || typeof it.taskSummary !== 'string' || !isObj(it.humanEffort)) {
        problems.push(`items[${i}] の形が違います`);
        continue;
      }
      if (seen.has(it.sessionId)) problems.push(`sessionId ${it.sessionId} が重複しています`);
      seen.add(it.sessionId);
    }
  }
  if (v.failures !== undefined && !Array.isArray(v.failures)) problems.push('failures が配列ではありません');
  if (problems.length) throw new Error(`judgments の形が正しくありません:\n- ${problems.join('\n- ')}`);
  return v as unknown as JudgmentsFile;
}
