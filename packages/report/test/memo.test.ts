// Phase 13: セッションごとのメモ(描画の安全性・抜粋・読み書きと競合・画像・絞り込み)
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFilter, decodeFilter, emptyFilter, encodeFilter } from '../src/lib/filter.ts';
import { isSafeFileName, isSafeMemoId, memoExcerpt, memoSummary } from '../src/lib/memo.ts';
import type { SessionSummary } from '../src/lib/types.ts';
import { imageExt, loadMemoIndex, MEMO_IMAGE_LIMIT, memoRev, readMemo, renderMemo, saveMemo, saveMemoImage } from '../src/memo-io.ts';
import { renderMemoHtml } from '../src/memo-render.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const render = (md: string, image: (h: string) => string | null = () => null): string => renderMemoHtml(md, image);

describe('renderMemoHtml', () => {
  it('生の HTML は文字として出し、属性やタグとして残さない', () => {
    const html = render('<script>alert(1)</script>\n\n本文 <img src=x onerror=alert(2)> と <b>太字</b>');
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('リンクは http(s) と mailto だけ。それ以外は文字だけにする', () => {
    expect(render('[a](https://example.test/x)')).toContain('<a href="https:&#47;&#47;example.test/x" rel="noreferrer noopener">a</a>');
    expect(render('[m](mailto:a@example.test)')).toContain('href="mailto:a@example.test"');
    for (const md of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<b>)', '[x](vbscript:x)']) {
      const html = render(md);
      expect(html).not.toContain('<a ');
      expect(html).toContain('x');
    }
  });

  it('本文に http:// をそのまま出さない(外部参照の静的検査)。autolink もコードも同じ', () => {
    const html = render('見る http://example.test/a と `https://example.test/b` と foo://bar\n\n```\nfetch("http://example.test")\n```');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('fetch(');
  });

  it('見出しは 2 段下げ、h6 で止める', () => {
    expect(render('# a')).toContain('<h3>a</h3>');
    expect(render('###### a')).toContain('<h6>a</h6>');
  });

  it('外部の画像は読み込まず、スキームの怪しいものはリンクにもしない', () => {
    const remote = render('![図](https://example.test/a.png)');
    expect(remote).not.toContain('<img');
    expect(remote).toContain('外部の画像(読み込みません): 図');
    expect(render('![図](javascript:alert(1))')).not.toMatch(/<img|<a /);
    expect(render('![図](//example.test/a.png)')).not.toContain('<img');
  });

  it('解決できた画像だけ img にし、alt を esc する。解決できなければ欠測の語', () => {
    expect(render('![a"b](x/y.png)', () => 'data:image/png;base64,AA==')).toContain('<img src="data:image/png;base64,AA==" alt="a&quot;b">');
    expect(render('![a](x/y.png)')).toContain('画像を表示できません: x/y.png');
  });

  it('GFM の表と改行、タスクリストが出る', () => {
    expect(render('- [ ] 未\n- [x] 済')).toMatch(/type="checkbox"/);
    expect(render('| a |\n|---|\n| 1 |')).toContain('<table>');
    expect(render('1 行目\n2 行目')).toContain('<br>');
  });
});

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

describe('memo-io', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-memo-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('保存と読み取り。一時ファイルを残さず、空の本文は削除で画像は残す', async () => {
    const { memo } = await saveMemo(join(dir, 'memos'), 's1', '本文', null);
    expect(memo).toMatchObject({ id: 's1', text: '本文', rev: memoRev('本文') });
    expect(await readdir(join(dir, 'memos'))).toEqual(['s1.md']);
    await saveMemoImage(join(dir, 'memos'), 's1', PNG);
    expect(await saveMemo(join(dir, 'memos'), 's1', '  \n', null)).toEqual({ memo: null, conflict: null });
    expect(await readMemo(join(dir, 'memos'), 's1')).toBeNull();
    expect(await readdir(join(dir, 'memos', 's1'))).toHaveLength(1);
  });

  it('rev が違えば書かずに競合を返す。無いメモは rev が空', async () => {
    const m = join(dir, 'memos');
    expect((await saveMemo(m, 's1', 'A', 'stale')).conflict).toMatchObject({ rev: '' });
    expect(existsSync(join(m, 's1.md'))).toBe(false);
    const first = (await saveMemo(m, 's1', 'A', '')).memo!;
    await writeFile(join(m, 's1.md'), '別の場所で更新'); // Obsidian などが書いた
    const r = await saveMemo(m, 's1', 'B', first.rev);
    expect(r.conflict?.rev).toBe(memoRev('別の場所で更新'));
    expect(await readFile(join(m, 's1.md'), 'utf8')).toBe('別の場所で更新');
    expect((await saveMemo(m, 's1', 'B', r.conflict!.rev)).memo?.text).toBe('B');
  });

  it('BOM 付きの手書きのファイルも読め、rev は本文で決まる', async () => {
    await mkdir(join(dir, 'memos'));
    await writeFile(join(dir, 'memos', 's1.md'), '﻿本文');
    expect((await readMemo(join(dir, 'memos'), 's1'))?.rev).toBe(memoRev('本文'));
  });

  it('一覧は id に使えない名前と .md 以外を飛ばす', async () => {
    const m = join(dir, 'memos');
    await mkdir(join(m, 's1'), { recursive: true });
    await writeFile(join(m, 's1.md'), 'A');
    await writeFile(join(m, '.hidden.md'), 'B');
    await writeFile(join(m, 'a b.md'), 'C');
    await writeFile(join(m, 'x.txt'), 'D');
    await utimes(join(m, 's1.md'), new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    const index = await loadMemoIndex(m);
    expect([...index.keys()]).toEqual(['s1']);
    expect(index.get('s1')?.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect((await loadMemoIndex(join(dir, 'none'))).size).toBe(0);
  });

  it('使えない id では読み書きしない(置き場の外に出ない)', async () => {
    await expect(readMemo(dir, '../x')).rejects.toThrow('使えない');
    await expect(saveMemo(dir, '..', 'A', null)).rejects.toThrow('使えない');
    await expect(saveMemoImage(dir, '../x', PNG)).rejects.toThrow('使えない');
  });

  it('画像は先頭のバイトで判定し、svg や偽物は置かない。同じ内容は同じ名前', async () => {
    expect(imageExt(PNG)).toBe('.png');
    expect(imageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('.jpg');
    expect(imageExt(Buffer.from('GIF89a'))).toBe('.gif');
    expect(imageExt(Buffer.from('RIFF0000WEBPVP8 '))).toBe('.webp');
    expect(imageExt(Buffer.from('<svg xmlns="x"><script>alert(1)</script></svg>'))).toBeNull();
    await expect(saveMemoImage(dir, 's1', Buffer.from('<svg/>'))).rejects.toThrow('画像だけ');
    const a = await saveMemoImage(dir, 's1', PNG);
    const b = await saveMemoImage(dir, 's1', PNG);
    expect(a).toEqual(b);
    expect(a.markdown).toBe(`![画像](s1/${a.name})`);
  });

  it('手で置いた日本語や空白の名前の画像も読み、上限を超える画像は埋め込まない', async () => {
    const m = join(dir, 'memos');
    await mkdir(join(m, 's1'), { recursive: true });
    await writeFile(join(m, 's1', 'Pasted image 1.png'), PNG);
    await writeFile(join(m, 's1', '画面 2.png'), PNG);
    await writeFile(join(m, 's1', 'big.png'), Buffer.alloc(MEMO_IMAGE_LIMIT + 1));
    expect(renderMemo(m, 's1', '![a](s1/Pasted%20image%201.png)')).toContain('src="data:image/png;base64,');
    expect(renderMemo(m, 's1', '![a](<s1/画面 2.png>)')).toContain('src="data:image/png;base64,');
    expect(renderMemo(m, 's1', '![a](s1/big.png)')).toContain('画像を表示できません');
  });

  it('描画は自分のフォルダの直下の画像だけを data: URI にする', async () => {
    const m = join(dir, 'memos');
    const { name } = await saveMemoImage(m, 's1', PNG);
    await saveMemoImage(m, 's2', PNG);
    await writeFile(join(dir, 'secret.png'), PNG);
    await writeFile(join(m, 's1', 'note.txt'), 'x');
    expect(renderMemo(m, 's1', `![a](s1/${name})`)).toContain('src="data:image/png;base64,');
    expect(renderMemo(m, 's1', `![a](./s1/${name})`)).toContain('src="data:image/png;base64,');
    for (const href of [`s2/${name}`, '../secret.png', 's1/../../secret.png', `s1/..%2F..%2Fsecret.png`, 's1/note.txt', `s1/x/${name}`]) {
      expect({ href, html: renderMemo(m, 's1', `![a](${href})`) }).toMatchObject({ href, html: expect.not.stringContaining('<img') });
    }
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
