// 共通スタイル(src/styles/base.css)の書き方の決まり。全画面(atlas.html・詳細・用語・改善点・指示文と skill・記録の表示)に埋め込むので、
// 古いブラウザで規則ごと捨てられる書き方をしない
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BASE_CSS = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'styles', 'base.css'), 'utf8');

/** :has() を、ほかのセレクタと同じ一覧(「,」で並べたもの)に入れている規則のセレクタを返す */
export function hasInSharedList(css: string): string[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of body.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@') || !sel.includes(':has(')) continue;
    // 括弧の外の「,」があれば、一覧に 2 つ以上のセレクタがある
    let depth = 0;
    let shared = false;
    for (const c of sel) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) shared = true;
    }
    if (shared) out.push(sel.replace(/\s+/g, ' '));
  }
  return out;
}

describe('base.css', () => {
  it(':has() は規則を分けて書く(:has() を知らないブラウザは、:has() を含むセレクタの一覧を規則ごと捨て、同じ一覧のほかの部品の指定まで消えるため)', () => {
    expect(hasInSharedList(BASE_CSS)).toEqual([]);
    // 検査そのものが見つけられること(陽性コントロール)。括弧の中の「,」は一覧の区切りに数えない
    expect(hasInSharedList('summary,\nlabel:has(input) { cursor: pointer; }')).toEqual(['summary, label:has(input)']);
    expect(hasInSharedList('label:has(input:is([type="a"], [type="b"])) { cursor: pointer; }')).toEqual([]);
    expect(hasInSharedList('@media (min-width: 1px) { a, b:has(c) { color: red; } }')).toEqual(['a, b:has(c)']);
  });

  it('チェックボックス・ラジオとそのラベルの指のカーソルを、ここでそろえている(部品ごとには書かない)', () => {
    for (const sel of ["input[type='checkbox'],", "input:is([type='checkbox'], [type='radio']) + label", "label:has(input:is([type='checkbox'], [type='radio'])) {"])
      expect(BASE_CSS).toContain(sel);
  });
});
