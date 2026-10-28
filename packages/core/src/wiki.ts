// llm-wiki(global-llm-wiki)参照の分類
import type { WikiUsage } from './types.ts';

export const WIKI_MARKER = 'global-llm-wiki';
const WRITE_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace_editor']);
const WIKI_SKILL_RE = /^wiki-(ingest|query|lint)$/;

export function emptyWiki(): WikiUsage {
  return { indexReads: 0, pageReads: [], skillCalls: [], writes: 0, otherCalls: 0 };
}

export function isWikiSkill(name: string): boolean {
  return WIKI_SKILL_RE.test(name);
}

/**
 * ツール呼び出し 1 件を分類して w に加える。対象でなければ false。
 * - skill: 引数に global-llm-wiki を含むか、skill 名が wiki-ingest/query/lint
 * - 書き込み系ツール: writes
 * - index.md を含む: indexReads
 * - wiki/ 配下の .md: pageReads(vault からの相対パス)
 * - それ以外(log.md、glob 等): otherCalls
 */
export function classifyWikiToolCall(w: WikiUsage, toolName: string, args: unknown): boolean {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  if (toolName === 'skill') {
    const skill = typeof (args as any)?.skill === 'string' ? (args as any).skill : '';
    if (!text.includes(WIKI_MARKER) && !isWikiSkill(skill)) return false;
    w.skillCalls.push(skill || '(unknown)');
    return true;
  }
  if (!text.includes(WIKI_MARKER)) return false;
  if (WRITE_TOOLS.has(toolName)) {
    w.writes++;
    return true;
  }
  // JSON 文字列中のバックスラッシュは \\ になっているので正規化して見る
  const norm = text.replace(/\\\\/g, '/').replace(/\\/g, '/');
  const pages = [...norm.matchAll(/global-llm-wiki\/+(wiki\/[^"'`*?<>|\n]+?\.md)/g)].map((m) => m[1]);
  if (/global-llm-wiki\/+index\.md/.test(norm)) {
    w.indexReads++;
    return true;
  }
  if (pages.length > 0) {
    for (const p of new Set(pages)) w.pageReads.push(p);
    return true;
  }
  w.otherCalls++;
  return true;
}
