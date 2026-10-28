import { describe, expect, it } from 'vitest';
import { classifyWikiToolCall, emptyWiki } from '../src/wiki.ts';

describe('classifyWikiToolCall', () => {
  it('index 読み・ページ読み・skill・書き込み・その他を分ける', () => {
    const w = emptyWiki();
    expect(classifyWikiToolCall(w, 'view', { path: 'E:\\v\\global-llm-wiki\\index.md' })).toBe(true);
    expect(classifyWikiToolCall(w, 'view', { path: 'E:\\v\\global-llm-wiki\\wiki\\tech\\ページ.md' })).toBe(true);
    expect(classifyWikiToolCall(w, 'powershell', { command: "Get-Content 'E:/v/global-llm-wiki/wiki/meta/a b.md'" })).toBe(true);
    expect(classifyWikiToolCall(w, 'glob', { pattern: 'wiki*/**', paths: ['E:\\v\\global-llm-wiki'] })).toBe(true);
    expect(classifyWikiToolCall(w, 'edit', { path: 'E:\\v\\global-llm-wiki\\log.md' })).toBe(true);
    expect(classifyWikiToolCall(w, 'skill', { skill: 'wiki-query' })).toBe(true);
    expect(classifyWikiToolCall(w, 'skill', { skill: 'impeccable' })).toBe(false);
    expect(classifyWikiToolCall(w, 'view', { path: 'E:\\other\\index.md' })).toBe(false);
    expect(w).toEqual({
      indexReads: 1,
      pageReads: ['wiki/tech/ページ.md', 'wiki/meta/a b.md'],
      skillCalls: ['wiki-query'],
      writes: 1,
      otherCalls: 1,
    });
  });
});
