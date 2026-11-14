// Phase 13: セッションごとのメモの、画面の lib(抜粋・id の形・絞り込み)。
// メモの描画(Markdown の安全な HTML)と読み書き・画像は Rust(crates/atlas-report/src/memo_render.rs・memo_io.rs)に移り、そちらの単体テストが受け持つ
import { describe, expect, it } from 'vitest';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter } from '../src/lib/filter.ts';
import { isSafeFileName, isSafeMemoId, memoExcerpt, memoSummary } from '../src/lib/memo.ts';
import type { SessionSummary } from '../src/lib/types.ts';

describe('memoExcerpt / memoSummary', () => {
  it('Markdown の印を除いた最初の読める行', () => {
    expect(memoExcerpt('\n\n# 見出し\n本文')).toBe('見出し');
    expect(memoExcerpt('- [ ] **やること** と [リンク](x)')).toBe('やること と リンク');
    expect(memoExcerpt('```\ncode\n```\n\nあと')).toBe('あと');
    expect(memoExcerpt('![図](a/b.png)')).toBe('[画像]');
    expect(memoExcerpt('   \n\n')).toBe('');
    expect(memoExcerpt('session_id の調査、2*3、~/.copilot')).toBe('session_id の調査、2*3、~/.copilot');
    expect(memoExcerpt('---\ntitle: x\n---\n\n本文')).toBe('本文');
    expect(memoExcerpt('---\n\n本文')).toBe('本文');
  });
  it('80 字で切り、字数は符号点で数え、画像を数える', () => {
    const s = memoSummary(`${'あ'.repeat(100)}\n![a](x/1.png) ![b](x/2.png)`, '2026-11-03T00:00:00.000Z');
    expect(s.excerpt).toBe(`${'あ'.repeat(80)}…`);
    expect(s.images).toBe(2);
    expect(s.chars).toBe(100 + 1 + 27);
  });
});

describe('isSafeMemoId', () => {
  it('ファイル名に使える形だけ通す', () => {
    for (const id of ['abc', '6a04046b-eb70-4f32-b422-9752012502ed', 'a.b_c']) expect(isSafeMemoId(id)).toBe(true);
    for (const id of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b', 'a'.repeat(201), 'NUL', 'con', 'COM1', 'con.md', 'abc.']) expect({ id, ok: isSafeMemoId(id) }).toEqual({ id, ok: false });
    for (const name of ['Pasted image 2026.png', 'スクリーンショット 2026-11-03.png', 'a(1).jpg']) expect(isSafeFileName(name)).toBe(true);
    for (const name of ['', '..', '.png', 'a/b.png', 'a\\b.png', 'a:b.png', 'CON.png', 'a.png.', 'a\u0001.png']) expect({ name, ok: isSafeFileName(name) }).toEqual({ name, ok: false });
  });
});

describe('絞り込み', () => {
  it('memo はハッシュで往復し、不正な値は捨てる', () => {
    const f = { ...emptyFilter(), memo: '1' as const };
    expect(encodeFilter(f)).toBe('memo=1');
    expect(decodeFilter('#memo=1').memo).toBe('1');
    expect(decodeFilter('#memo=x').memo).toBe('');
  });
  it('メモのあるセッションだけ残す', () => {
    const base = { empty: false, project: 'p', client: null, branch: null, models: [], createdAt: null, updatedAt: null } as unknown as SessionSummary;
    const a = { ...base, id: 'a', memo: { excerpt: 'x', chars: 1, images: 0, updatedAt: null } };
    const b = { ...base, id: 'b' };
    expect(applyFilter([a, b], { ...emptyFilter(), memo: '1' }).map((s) => s.id)).toEqual(['a']);
    expect(applyFilter([a, b], emptyFilter())).toHaveLength(2);
  });
});
