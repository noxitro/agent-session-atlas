import { describe, expect, it } from 'vitest';
import { emptyWiki, WikiClassifier } from '../src/wiki.ts';

describe('WikiClassifier', () => {
  it('index 読み・ページ読み・skill・書き込み・その他を分ける', () => {
    const c = new WikiClassifier([{ path: 'my-wiki', pages: ['wiki'], skills: ['wiki-query'] }]);
    const w = emptyWiki();
    expect(c.classify(w, 'view', { path: 'E:\\v\\my-wiki\\index.md' })).toBe(true);
    expect(c.classify(w, 'view', { path: 'E:\\v\\my-wiki\\wiki\\tech\\ページ.md' })).toBe(true);
    expect(c.classify(w, 'powershell', { command: "Get-Content 'E:/v/my-wiki/wiki/meta/a b.md'" })).toBe(true);
    expect(c.classify(w, 'glob', { pattern: 'wiki*/**', paths: ['E:\\v\\my-wiki'] })).toBe(true);
    expect(c.classify(w, 'edit', { path: 'E:\\v\\my-wiki\\log.md' })).toBe(true);
    expect(c.classify(w, 'skill', { skill: 'wiki-query' })).toBe(true);
    expect(c.classify(w, 'skill', { skill: 'impeccable' })).toBe(false);
    expect(c.classify(w, 'view', { path: 'E:\\other\\index.md' })).toBe(false);
    expect(w).toEqual({
      indexReads: 1,
      pageReads: ['wiki/tech/ページ.md', 'wiki/meta/a b.md'],
      skillCalls: ['wiki-query'],
      writes: 1,
      otherCalls: 1,
    });
  });

  it('指定が無ければ何も数えない(特定の vault を前提にしない)', () => {
    const c = new WikiClassifier();
    const w = emptyWiki();
    expect(c.classify(w, 'view', { path: 'E:/v/my-wiki/index.md' })).toBe(false);
    expect(c.classify(w, 'skill', { skill: 'wiki-query' })).toBe(false);
    expect(c.isSkill('wiki-query')).toBe(false);
    expect(w).toEqual(emptyWiki());
  });

  it('名前も形式も違う vault を指定できる', () => {
    const c = new WikiClassifier([{ path: 'second-brain', index: ['README.md', '00-home.md'], pages: ['notes', 'areas/work'], extensions: ['.md', '.mdx'], skills: ['brain-search'] }]);
    const w = emptyWiki();
    c.classify(w, 'view', { path: 'D:\\vaults\\second-brain\\README.md' });
    c.classify(w, 'view', { path: 'D:/vaults/second-brain/00-home.md' });
    c.classify(w, 'view', { path: 'D:/vaults/second-brain/notes/a.mdx' });
    c.classify(w, 'view', { path: 'D:/vaults/second-brain/areas/work/b.md' });
    c.classify(w, 'view', { path: 'D:/vaults/second-brain/inbox/c.md' });
    c.classify(w, 'skill', { skill: 'brain-search' });
    expect(c.classify(w, 'skill', { skill: 'wiki-query' })).toBe(false);
    expect(c.classify(w, 'view', { path: 'E:\\v\\other-wiki\\index.md' })).toBe(false);
    expect(w).toEqual({ indexReads: 2, pageReads: ['notes/a.mdx', 'areas/work/b.md'], skillCalls: ['brain-search'], writes: 0, otherCalls: 1 });
  });

  it('path だけの指定は vault 全体の .md をページとして数え、index.md は索引のまま。skill は数えない', () => {
    const c = new WikiClassifier([{ path: 'notes' }]);
    const w = emptyWiki();
    c.classify(w, 'view', { path: 'D:/notes/index.md' });
    c.classify(w, 'view', { path: 'D:/notes/日記/2026.md' });
    c.classify(w, 'view', { path: 'D:/notes/top.md' });
    c.classify(w, 'view', { path: 'D:/notes/image.png' });
    expect(c.classify(w, 'skill', { skill: 'wiki-query' })).toBe(false);
    expect(w).toEqual({ indexReads: 1, pageReads: ['日記/2026.md', 'top.md'], skillCalls: [], writes: 0, otherCalls: 1 });
  });

  it('vault 名は区切りまで一致したものだけ。大文字小文字は区別しない', () => {
    const c = new WikiClassifier([{ path: 'notes' }]);
    const w = emptyWiki();
    expect(c.classify(w, 'view', { path: 'D:/my-notes/index.md' })).toBe(false);
    expect(c.classify(w, 'view', { path: 'D:/notes-app/index.md' })).toBe(false);
    expect(c.classify(w, 'view', { path: 'D:/x/notes.md' })).toBe(false);
    expect(c.classify(w, 'powershell', { command: 'cd D:\\x\nnotes-tool run' })).toBe(false);
    expect(c.classify(w, 'view', { path: 'D:/NOTES/index.md' })).toBe(true);
    expect(w.indexReads).toBe(1);
  });

  it('パスでの指定は区切りの違いと末尾の / を吸収する', () => {
    const c = new WikiClassifier([{ path: 'D:\\vaults\\notes\\' }]);
    const w = emptyWiki();
    expect(c.classify(w, 'view', { path: 'D:/vaults/notes/index.md' })).toBe(true);
    expect(c.classify(w, 'view', { path: 'E:\\vaults\\notes\\index.md' })).toBe(false);
  });

  it('改行をまたいでページ名を伸ばさない', () => {
    const c = new WikiClassifier([{ path: 'my-wiki' }]);
    const w = emptyWiki();
    c.classify(w, 'powershell', { command: 'cat E:/v/my-wiki/wiki/a.md\ncat E:/v/my-wiki/wiki/b.md' });
    expect(w.pageReads).toEqual(['wiki/a.md', 'wiki/b.md']);
  });

  it('vault が複数なら、ページの先頭に vault 名を付けて区別する', () => {
    const c = new WikiClassifier([{ path: 'alpha' }, { path: 'D:/x/beta', pages: ['docs'], index: ['HOME.md'] }]);
    const w = emptyWiki();
    c.classify(w, 'view', { path: 'D:/alpha/wiki/a.md' });
    c.classify(w, 'view', { path: 'D:/x/beta/docs/a.md' });
    c.classify(w, 'view', { path: 'D:/x/beta/HOME.md' });
    expect(w).toMatchObject({ indexReads: 1, pageReads: ['alpha/wiki/a.md', 'beta/docs/a.md'] });
  });

  it('skill のファイルの場所でも判定する', () => {
    const c = new WikiClassifier([{ path: 'notes' }]);
    expect(c.isSkill('custom', 'D:\\notes\\skills\\custom\\SKILL.md')).toBe(true);
    expect(c.isSkill('custom', 'D:\\other\\SKILL.md')).toBe(false);
  });
});
