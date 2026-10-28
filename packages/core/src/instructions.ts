// system.message 本文から指示ファイルの注入を切り出す。
// Copilot CLI は各ファイルを <custom_instruction> で包むだけでファイル名を書かない(1.0.18 の app.js で確認)。
// ファイル名が分かるのは <imported_custom_instruction source="..."> の場合だけなので、残りは見出し等から推定する。
import { createHash } from 'node:crypto';
import type { InstructionFile, InstructionInjection, InstructionMethod, SessionRecord } from './types.ts';

export interface InstructionBlock {
  file: InstructionFile;
  method: InstructionMethod;
  chars: number;
  heading: string;
  contentHash: string;
  sourcePath?: string;
}

const CUSTOM_RE = /<custom_instruction>\n?([\s\S]*?)\n?<\/custom_instruction>/g;
const IMPORTED_RE = /<imported_custom_instruction source="([^"]*)">\n?([\s\S]*?)\n?<\/imported_custom_instruction>/g;
const APPLY_TO_PREFIX = 'This instruction applies to files matching the pattern:';

/** コードポイント数(サロゲートペアを 1 字と数える。匿名化で長さが変わらないように) */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function contentHash(s: string): string {
  return createHash('sha1').update(s.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12);
}

export function firstHeading(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

export function fileFromPath(p: string): InstructionFile {
  const norm = p.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  if (/\.github\/instructions\//i.test(norm) || /\.instructions\.md$/i.test(base)) return '.github/instructions';
  if (/^copilot-instructions\.md$/i.test(base)) return 'copilot-instructions.md';
  if (/^AGENTS\.md$/i.test(base)) return 'AGENTS.md';
  if (/^CLAUDE\.md$/i.test(base)) return 'CLAUDE.md';
  if (/^GEMINI\.md$/i.test(base)) return 'GEMINI.md';
  return 'unknown';
}

function classifyByContent(text: string): { file: InstructionFile; method: InstructionMethod } {
  const t = text.trim();
  if (t.startsWith(APPLY_TO_PREFIX)) return { file: '.github/instructions', method: 'apply-to' };
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^@\S+$/.test(l))) return { file: 'CLAUDE.md', method: 'import-stub' };
  const h = firstHeading(t);
  if (/^#/.test(h)) {
    if (/AGENTS\.md/i.test(h)) return { file: 'AGENTS.md', method: 'heading-keyword' };
    if (/CLAUDE\.md|\bclaude\b/i.test(h)) return { file: 'CLAUDE.md', method: 'heading-keyword' };
    if (/copilot-instructions\.md|\bcopilot\b/i.test(h)) return { file: 'copilot-instructions.md', method: 'heading-keyword' };
  }
  return { file: 'unknown', method: 'unresolved' };
}

/** 1 つの system.message 本文から指示ブロックを取り出す */
export function extractInstructionBlocks(content: string): InstructionBlock[] {
  const out: InstructionBlock[] = [];
  for (const m of content.matchAll(CUSTOM_RE)) {
    const body = m[1];
    let outer = body;
    for (const im of body.matchAll(IMPORTED_RE)) {
      const inner = im[2];
      out.push({
        file: fileFromPath(im[1]),
        method: 'imported-source',
        chars: charCount(inner),
        heading: firstHeading(inner),
        contentHash: contentHash(inner),
        sourcePath: im[1],
      });
      outer = outer.replace(im[0], '');
    }
    if (outer.trim() === '') continue;
    const c = classifyByContent(outer);
    out.push({ file: c.file, method: c.method, chars: charCount(outer), heading: firstHeading(outer), contentHash: contentHash(outer) });
  }
  return out;
}

/** セッション内の指示ブロックを内容ハッシュで束ねる */
export class InstructionCollector {
  private map = new Map<string, InstructionInjection>();

  add(content: string, at: string | null): void {
    for (const b of extractInstructionBlocks(content)) {
      const key = `${b.contentHash}:${b.sourcePath ?? ''}`;
      const cur = this.map.get(key);
      if (cur) {
        cur.injections++;
        continue;
      }
      this.map.set(key, {
        file: b.file,
        scope: b.file === 'unknown' ? 'unknown' : 'repo',
        method: b.method,
        chars: b.chars,
        firstSeenAt: at,
        heading: b.heading,
        contentHash: b.contentHash,
        injections: 1,
        ...(b.sourcePath ? { sourcePath: b.sourcePath } : {}),
      });
    }
  }

  result(): InstructionInjection[] {
    return [...this.map.values()];
  }
}

/**
 * 全セッションを見て未特定のブロックを埋める(破壊的に更新)。
 * 1) 同じ内容ハッシュ / 同じ見出しが他所で特定済みならそれに合わせる(learned-heading)
 * 2) 3 プロジェクト以上で同一内容なら、ユーザー単位の指示(~/.copilot/copilot-instructions.md)とみなす(cross-project)
 */
export function resolveInstructions(sessions: SessionRecord[], crossProjectThreshold = 3): void {
  const all = sessions.flatMap((s) => s.instructions.map((i) => ({ s, i })));

  // 1) 同一内容が閾値以上のプロジェクトに現れる → ユーザー単位
  const projectsByHash = new Map<string, Set<string>>();
  for (const { s, i } of all) {
    let ps = projectsByHash.get(i.contentHash);
    if (!ps) projectsByHash.set(i.contentHash, (ps = new Set()));
    ps.add(s.project);
  }
  for (const { i } of all) {
    if (i.method === 'imported-source') continue;
    if ((projectsByHash.get(i.contentHash)?.size ?? 0) < crossProjectThreshold) continue;
    i.scope = 'user';
    if (i.file === 'unknown') {
      i.file = 'copilot-instructions.md';
      i.method = 'cross-project';
    }
  }

  // 2) 特定済みのものから 内容ハッシュ → ファイル / 見出し → ファイル を学習(見出しが一意に決まる場合のみ)
  type Label = { file: InstructionFile; scope: InstructionInjection['scope'] };
  const byHash = new Map<string, Label>();
  const byHeading = new Map<string, Map<string, Label>>();
  for (const { i } of all) {
    if (i.file === 'unknown') continue;
    const label = { file: i.file, scope: i.scope };
    byHash.set(i.contentHash, label);
    if (!i.heading.startsWith('#')) continue;
    let hs = byHeading.get(i.heading);
    if (!hs) byHeading.set(i.heading, (hs = new Map()));
    hs.set(`${i.file}|${i.scope}`, label);
  }

  // 3) 未特定のものを埋める
  for (const { i } of all) {
    if (i.file !== 'unknown') continue;
    const hs = byHeading.get(i.heading);
    const learned = byHash.get(i.contentHash) ?? (hs && hs.size === 1 ? [...hs.values()][0] : undefined);
    if (!learned) continue;
    i.file = learned.file;
    i.scope = learned.scope;
    i.method = 'learned-heading';
  }
}
