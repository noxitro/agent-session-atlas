#!/usr/bin/env node
// 生成したレポートの全ページを Playwright の Chromium で開き、機械で分かる不備を洗い出す(網羅チェック)。
//   node scripts/ui-audit.ts <out ディレクトリ> [--json <結果.json>] [--shots <スクリーンショットの置き場>] [--layout-sessions <N>]
// 目視のレビュー(impeccable / web-design-guidelines)は見た目の良し悪しを見るが、ページをまたぐ食い違いやリンク切れ、
// 一部の幅・配色だけで起きる崩れは拾い漏れる。それをここで全ページ・全幅・両配色について機械的に確かめる。
//
// 検査(error は直す、warn は目で確かめる):
//  - 構造(全ページ): id の重複 / ページ内リンク(#id)の行き先が無い / 別ページへのリンクの行き先(ファイルと #id)が無い /
//    「版 N」のリンク文言と行き先の版番号の食い違い
//  - 文言(全ページ、atlas.html はタブを 1 つずつ押した状態も): undefined・NaN・[object Object]・テンプレートの ${…}・
//    二重に逃がした実体参照(&amp; 等)・HTML コメントや生のタグの漏れ(pre / code / textarea の中は除く)
//  - アクセシビリティの基本(全ページ): lang / 名前の無いリンクとボタン / alt の無い画像 / ラベルの無い入力欄 / 見出しの段の飛び(warn)
//  - 押せそうで押せない要素(全ページ、atlas.html はタブごと、開閉要素を開いた状態、レイアウトの見本は 3 幅でも): 自分自身へのリンク /
//    指のカーソルが出るのに操作できない要素 / ホバーで見た目が変わるのに操作できない要素(warn)/ 下線があるのにリンクでない文字(warn)。
//    サーバが要るダイアログ・ポップアップの中は ui/ の画面の操作の検査が clickableFindings で見る
//  - 実行時(全ページ): ページ内の例外とコンソールのエラー
//  - レイアウト(主要ページと詳細ページの見本、375 / 1024 / 1440px × ライト / ダーク): 横のはみ出し / 文字のコントラスト不足 /
//    切れた文字(warn)/ キーボードで届かないスクロール領域(warn)/ 375px での小さすぎる押す的(warn)/
//    375px で字間を広げた状態(字幅の広いフォントの代わり)での横のはみ出し
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface Finding {
  page: string;
  severity: 'error' | 'warn';
  kind: string;
  detail: string;
  /** レイアウトの検査で、どの幅・配色か */
  where?: string;
}

export interface AuditOptions {
  /** レイアウトの検査に使う詳細ページの数(大きい順と名前順から半分ずつ) */
  layoutSessions?: number;
  /** 主要ページのスクリーンショット(全体)を置く場所 */
  shotsDir?: string | null;
  log?: (msg: string) => void;
}

export interface AuditResult {
  pages: number;
  findings: Finding[];
}

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;
/** 字幅の広いフォントの代わりに足す字間。CI(Linux)で 375px の詳細ページが 7〜17px はみ出したときの差を、手元(Windows)で再現できる強さ */
const WIDE_TEXT_SPACING = '.1em';

/** 生成物のうち検査する HTML(トップの *.html と sessions/*.html) */
export function listPages(outDir: string): string[] {
  const top = readdirSync(outDir).filter((f) => f.endsWith('.html') && statSync(join(outDir, f)).isFile());
  const sessDir = join(outDir, 'sessions');
  const sessions = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith('.html')).map((f) => `sessions/${f}`) : [];
  return [...top.sort(), ...sessions.sort()];
}

// ---------- ページ内で動かす検査(文字列にして evaluate に渡す。ページの文脈で動く) ----------

interface PageFacts {
  ids: string[];
  links: { href: string; text: string }[];
  findings: { severity: 'error' | 'warn'; kind: string; detail: string }[];
  tabs: number;
}

/** 構造・文言・アクセシビリティの検査。表示中の状態(タブの選択など)に対して何度でも呼べる */
const STATIC_CHECK = `(() => {
  const out = [];
  const add = (severity, kind, detail) => out.push({ severity, kind, detail });
  const desc = (el) => {
    const t = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    return t + id + cls + (txt ? ' 「' + txt + '」' : '');
  };
  // id の重複
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const seen = new Set(), dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  for (const id of dup) add('error', 'id の重複', id);
  // ページ内リンク(#id)。絞り込みの状態を表すハッシュ(a=b を含む)は画面の経路なので除く
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
    links.push({ href, text });
    if (href.startsWith('#') && href.length > 1) {
      const frag = href.slice(1);
      if (frag.split('&').some((p) => p.indexOf('=') > 0)) continue;
      let id = frag;
      try { id = decodeURIComponent(frag); } catch (e) {}
      if (!document.getElementById(id)) add('error', 'ページ内リンクの行き先が無い', href + ' 「' + text.slice(0, 40) + '」');
    }
  }
  // 文言の漏れ(pre / code / textarea / script / style の中は本文の引用なので除く)
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('pre, code, textarea, script, style, template').forEach((e) => e.remove());
  const text = clone.textContent || '';
  const leaks = [
    [/\\bundefined\\b/, 'undefined'],
    [/\\bNaN\\b/, 'NaN'],
    [/\\[object Object\\]/, '[object Object]'],
    [/\\bInfinity\\b/, 'Infinity'],
    [/\\$\\{[^}]*\\}/, 'テンプレートの \${…}'],
    [/&(?:amp|lt|gt|quot|#\\d+|#x[0-9a-f]+);/i, '二重に逃がした実体参照'],
    [/<!--|-->/, 'HTML コメントの印'],
  ];
  const snippet = (i) => text.slice(Math.max(0, i - 30), i + 30).replace(/\\s+/g, ' ').trim();
  for (const [re, name] of leaks) {
    const m = re.exec(text);
    if (m) add('error', '文言の漏れ: ' + name, snippet(m.index));
  }
  // 生のタグは依頼文などの本文(C++ の #include <span> 等)にも現れるので、目で確かめる側(warn)に回す
  const tag = /<\\/?(?:div|span|p|a|br|b|strong|em|code|pre|table|tr|td|th|li|ul|ol|details|summary|section|h[1-6])\\b[^>]*>/i.exec(text);
  if (tag) add('warn', '生の HTML タグ(本文の引用なら問題なし)', snippet(tag.index));
  // アクセシビリティの基本
  if (!document.documentElement.getAttribute('lang')) add('error', 'html に lang が無い', '');
  const named = (el) => {
    if ((el.getAttribute('aria-label') || '').trim() || el.getAttribute('aria-labelledby') || (el.getAttribute('title') || '').trim()) return true;
    if ((el.textContent || '').trim()) return true;
    return [...el.querySelectorAll('img[alt], svg[aria-label], [aria-label]')].some((x) => (x.getAttribute('alt') || x.getAttribute('aria-label') || '').trim());
  };
  for (const el of document.querySelectorAll('a[href], button, [role="button"], [role="tab"], summary')) if (!named(el)) add('error', '名前の無い操作要素', desc(el) + ' ' + (el.getAttribute('href') || ''));
  for (const img of document.querySelectorAll('img:not([alt])')) add('error', 'alt の無い画像', img.getAttribute('src') || '');
  for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    const ok = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
    if (!ok) add('error', 'ラベルの無い入力欄', desc(el));
  }
  const hs = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => !h.closest('[hidden]'));
  if (document.querySelectorAll('h1').length !== 1) add('warn', 'h1 が 1 つでない', String(document.querySelectorAll('h1').length) + ' 個');
  let prev = 0;
  for (const h of hs) {
    const lv = Number(h.tagName[1]);
    if (prev && lv > prev + 1) add('warn', '見出しの段の飛び', 'h' + prev + ' → h' + lv + ' ' + desc(h));
    prev = lv;
  }
  const tabs = document.querySelectorAll('[role="tab"]').length;
  return { ids, links, findings: out, tabs };
})()`;

/**
 * 押せそうで押せない要素の検査(押しても何も起きない、または同じ場所に留まるだけ)。今の幅・開閉の状態に対して何度でも呼べる。
 * 全要素の計算済みスタイルと「操作要素の中か」を 1 回ずつだけ求め、指のカーソルと下線の検査で使い回す
 */
export const CLICKABLE_CHECK = `(() => {
  const out = [];
  const add = (severity, kind, detail) => out.push({ severity, kind, detail });
  const desc = (el) => {
    const t = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    return t + id + cls + (txt ? ' 「' + txt + '」' : '');
  };
  // 操作できる要素(ネイティブの操作要素と、操作を受ける ARIA の役割)
  const ROLES = ['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'treeitem', 'combobox', 'slider', 'spinbutton', 'searchbox', 'textbox', 'gridcell', 'scrollbar'];
  const CONTROL = 'a[href], button, summary, label, input, select, textarea, [onclick], [contenteditable=""], [contenteditable="true"], ' +
    ROLES.map((r) => '[role="' + r + '"]').join(', ');
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const cs = new Map();
  const style = (el) => { let s = cs.get(el); if (!s) { s = getComputedStyle(el); cs.set(el, s); } return s; };
  // 「操作要素の中か」は文書順(親が先)に親の答えを引き継いで求める(要素ごとに closest を呼ばない)
  const all = [document.documentElement, ...document.documentElement.querySelectorAll('body, body *')];
  const inCtl = new Map();
  for (const el of all) inCtl.set(el, inCtl.get(el.parentElement) || el.matches(CONTROL));
  // 見えているか: 閉じた details の中身は Chromium では箱を持つ(getClientRects が空でない)ので checkVisibility で見る。
  // display: contents の要素は箱を持たないが、子に指のカーソルを引き継ぐので検査の対象にする
  const rendered = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0) || style(el).display === 'contents';

  // 自分自身へのリンク: 行き先が自分か、自分を含む「語や見出し」の要素(<dt id="x"><a href="#x">語</a></dt>・<h2 id="x"><a href="#x">見出し</a> …</h2>)。
  // 同じページをファイル名付きで指すもの(glossary.html#x)も同じ。節の先頭へ戻るリンクのように、行き先が節や枠でほかの中身も持つものは指摘しない
  const here = location.origin + location.pathname + location.search;
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
    if (u.origin + u.pathname + u.search !== here) continue;
    const frag = u.hash.slice(1);
    if (!frag || frag.split('&').some((p) => p.indexOf('=') > 0)) continue;
    let id = frag;
    try { id = decodeURIComponent(frag); } catch (e) {}
    const t = document.getElementById(id);
    if (!t) continue;
    if (t === a || (t.contains(a) && (norm(t.textContent) === norm(a.textContent) || t.matches('h1, h2, h3, h4, h5, h6, dt, th, caption, figcaption, legend'))))
      add('error', '自分自身へのリンク(押しても同じ場所に留まる)', desc(a));
  }

  // 指のカーソルが出るのに操作できない要素。カーソルは子に引き継がれるので、親から引き継いでいない(そこで付けた)要素だけを挙げる
  const decorated = new Set();
  for (const el of all) {
    if (inCtl.get(el) || !rendered(el)) continue;
    const s = style(el);
    if (s.cursor === 'pointer') {
      const p = el.parentElement;
      if (!p || style(p).cursor !== 'pointer') add('error', '指のカーソルが出るのに操作できない', desc(el));
    }
    // 下線があるのにリンクでない文字(リンクに見える)。下線は子孫の字にも引かれるので、字を持つ要素から祖先へたどって下線を付けた要素を挙げる。
    // インラインブロック・浮動・絶対配置の境は越えない(そこから先の祖先の下線は引かれない)。<u>・<ins>・title 付きの <abbr> は意図した下線なので除く
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    for (let q = el; q && q !== document.documentElement; q = q.parentElement) {
      if (inCtl.get(q) || q.matches('u, ins, abbr[title]')) break;
      const qs = style(q);
      if (qs.textDecorationLine.includes('underline')) {
        if (!decorated.has(q)) { decorated.add(q); add('warn', '下線があるのにリンクでない', desc(q)); }
        break;
      }
      if (/^inline-(?:block|flex|grid|table)$/.test(qs.display) || qs.position === 'absolute' || qs.position === 'fixed' || qs.float !== 'none') break;
    }
  }

  // ホバーで見た目が変わるのに操作できない要素(表の行の読み取り補助など意図したものもあるので目で確かめる)。
  // セレクタの一覧を括弧・引用符の外の「,」で分け、:hover を含む段(.a:hover > .b なら .a、:is(.a, .b):hover ならその段)までを、:hover を外して当てる
  const topLevel = (s, at) => {
    let depth = 0, q = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\\\') { i++; continue; }
      if (q) { if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0) at(c, i);
    }
  };
  const PSEUDO_EL = /::?(?:before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button)\\b(?:\\([^)]*\\))?/g;
  const hoveredOf = (part) => {
    const cuts = [];
    topLevel(part, (c, i) => { if (/[\\s>+~]/.test(c)) cuts.push(i); });
    let start = 0;
    for (const end of [...cuts, part.length]) {
      if (part.slice(start, end).includes(':hover')) return part.slice(0, end).replace(/:hover\\b/g, ':is(*)').replace(PSEUDO_EL, '').trim();
      start = end + 1;
    }
    return '';
  };
  const hoverSel = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText && r.selectorText.includes(':hover')) hoverSel.push(r.selectorText);
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch (e) {} }
  const seenH = new Set();
  for (const sel of hoverSel) {
    const parts = [];
    let start = 0;
    topLevel(sel, (c, i) => { if (c === ',') { parts.push(sel.slice(start, i)); start = i + 1; } });
    parts.push(sel.slice(start));
    for (const part of parts) {
      const hovered = part.includes(':hover') ? hoveredOf(part) : '';
      if (!hovered) continue;
      let els;
      try { els = document.querySelectorAll(hovered); } catch (e) { continue; }
      for (const el of els) {
        if (inCtl.get(el) || !rendered(el)) continue;
        const key = part.trim() + '|' + desc(el);
        if (seenH.has(key)) continue;
        seenH.add(key);
        add('warn', 'ホバーで見た目が変わるのに操作できない', part.trim() + ' → ' + desc(el));
      }
    }
  }
  return out;
})()`;

/** 閉じている開閉要素(details と aria-expanded="false" のボタン)を開く。開いたものの数を返す */
const OPEN_ALL = `(() => {
  let n = 0;
  for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; n++; }
  for (const b of document.querySelectorAll('button[aria-expanded="false"]')) {
    if (b.disabled || b.getClientRects().length === 0) continue;
    b.click();
    n++;
  }
  return n;
})()`;

type RawFinding = { severity: 'error' | 'warn'; kind: string; detail: string };

/** 押せそうで押せない要素の指摘(ui/ の画面の操作の検査から、ダイアログやポップアップを開いた状態で呼ぶ) */
export async function clickableFindings(page: Page): Promise<RawFinding[]> {
  return (await page.evaluate(CLICKABLE_CHECK)) as RawFinding[];
}

/** レイアウトの検査(今の幅・配色で) */
const LAYOUT_CHECK = `((narrow) => {
  const out = [];
  const add = (severity, kind, detail) => out.push({ severity, kind, detail });
  const desc = (el) => {
    const t = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return t + id + cls + (txt ? ' 「' + txt + '」' : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const W = document.documentElement.clientWidth;
  // 横のはみ出し: ページ全体と、横スクロールの枠に入っていない要素
  if (document.documentElement.scrollWidth > W + 1) {
    const clipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
      }
      return false;
    };
    const offenders = [...document.body.querySelectorAll('*')].filter((el) => visible(el) && el.getBoundingClientRect().right > W + 1 && !clipped(el));
    // 外側の要素だけを挙げる
    const top = offenders.filter((el) => !offenders.includes(el.parentElement)).slice(0, 5).map(desc);
    add('error', '横にはみ出している', 'ページ幅 ' + document.documentElement.scrollWidth + 'px > ' + W + 'px: ' + top.join(' / '));
  }
  // コントラスト(WCAG 2.x の相対輝度。背景は透明でない祖先まで遡って重ねる)
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null; // 画像・グラデーションの上は測らない
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const seenC = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const s = getComputedStyle(el);
    const fg0 = parse(s.color);
    const bg = bgOf(el);
    if (!fg0 || !bg) continue;
    const fg = over({ ...fg0, a: fg0.a * Number(s.opacity) }, bg);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) {
      const key = s.color + '|' + s.backgroundColor + '|' + el.tagName + '|' + el.className;
      if (seenC.has(key)) continue;
      seenC.add(key);
      add('error', 'コントラスト不足', desc(el) + ' ' + ratio.toFixed(2) + ':1(必要 ' + need + ':1、文字 ' + s.color + ')');
    }
  }
  // 切れた文字(overflow: hidden で省略記号も無い)
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    if (s.overflowX !== 'hidden' && s.overflowX !== 'clip') continue;
    if (s.textOverflow === 'ellipsis') continue;
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue; // 読み上げ専用(sr-only)
    if (el.scrollWidth > el.clientWidth + 2 && (el.textContent || '').trim()) add('warn', '文字が切れている', desc(el) + ' ' + el.scrollWidth + 'px > ' + el.clientWidth + 'px');
  }
  // スクロール領域にキーボードで届くか
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const sx = (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    const sy = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    if (!sx && !sy) continue;
    if (el === document.body || el === document.documentElement) continue;
    if (el.tabIndex >= 0 || el.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')) continue;
    add('warn', 'キーボードで届かないスクロール領域', desc(el));
  }
  // 375px での押す的(24px 未満。文中のリンクは除く)
  if (narrow) {
    for (const el of document.body.querySelectorAll('button, input, select, summary, [role="tab"], a[href]')) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      if (el.tagName === 'A' && s.display === 'inline') continue;
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.closest('label')) continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) add('warn', '押す的が小さい(375px)', desc(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  }
  return out;
})`;

// ---------- 本体 ----------

function pageUrl(outDir: string, rel: string): string {
  return pathToFileURL(join(outDir, rel)).href;
}

async function openPage(ctx: BrowserContext, url: string, errors: string[]): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`ページ内の例外: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`コンソールのエラー: ${m.text().slice(0, 200)}`);
  });
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

/** atlas.html のタブ(利用ランキングの種類など)を 1 つずつ押し、その状態で検査する */
async function eachTab(page: Page, fn: (label: string) => Promise<void>): Promise<void> {
  const tabs = page.locator('[role="tab"]');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    const t = tabs.nth(i);
    if (!(await t.isVisible())) continue;
    if ((await t.getAttribute('aria-selected')) === 'true') continue;
    const label = ((await t.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await t.click();
    await page.waitForTimeout(50);
    await fn(label);
  }
}

export async function audit(outDir: string, o: AuditOptions = {}): Promise<AuditResult> {
  const log = o.log ?? (() => {});
  const root = resolve(outDir);
  const pages = listPages(root);
  const findings: Finding[] = [];
  const idsByPage = new Map<string, Set<string>>();
  const versionLabel = new Map<string, string>(); // instructions.html の版の id → 「版 N」
  const crossLinks: { from: string; href: string; text: string }[] = [];
  /** 同じページ・種類・中身の指摘は、状態(タブ・開閉・幅)が違っても 1 回だけ数える */
  const addOnce = (f: Finding): void => {
    if (!findings.some((x) => x.page === f.page && x.kind === f.kind && x.detail === f.detail)) findings.push(f);
  };
  const browser: Browser = await chromium.launch();
  try {
    // 1) 構造・文言・a11y(全ページ、1440px ライト)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    let k = 0;
    for (const rel of pages) {
      const errors: string[] = [];
      const page = await openPage(ctx, pageUrl(root, rel), errors);
      const facts = (await page.evaluate(STATIC_CHECK)) as PageFacts;
      for (const f of facts.findings) findings.push({ page: rel, ...f });
      for (const f of await clickableFindings(page)) addOnce({ page: rel, ...f });
      if (facts.tabs > 0)
        await eachTab(page, async (label) => {
          const again = (await page.evaluate(STATIC_CHECK)) as PageFacts;
          for (const f of again.findings) if (!facts.findings.some((x) => x.kind === f.kind && x.detail === f.detail)) findings.push({ page: rel, ...f, where: `タブ「${label}」` });
          for (const f of await clickableFindings(page)) addOnce({ page: rel, ...f, where: `タブ「${label}」` });
        });
      // 開閉要素(details・aria-expanded のボタン)の中は、閉じたままだと表示されず検査されないので、開いた状態でもう一度見る
      if (((await page.evaluate(OPEN_ALL)) as number) > 0) {
        await page.waitForTimeout(50);
        for (const f of await clickableFindings(page)) addOnce({ page: rel, ...f, where: '開閉要素を開いた状態' });
      }
      idsByPage.set(rel, new Set(facts.ids));
      if (rel === 'instructions.html') {
        for (const [id, label] of (await page.evaluate(`[...document.querySelectorAll('details.ver')].map((d) => [d.id, d.querySelector('summary b')?.textContent ?? ''])`)) as [string, string][]) versionLabel.set(id, label);
      }
      for (const l of facts.links) if (!l.href.startsWith('#')) crossLinks.push({ from: rel, ...l });
      for (const e of errors) findings.push({ page: rel, severity: 'error', kind: '実行時のエラー', detail: e });
      await page.close();
      if (++k % 100 === 0) log(`構造の検査: ${k} / ${pages.length} ページ`);
    }
    await ctx.close();

    // 2) 別ページへのリンク: ファイルと #id があるか、「版 N」の文言が行き先と合うか
    for (const l of crossLinks) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(l.href)) {
        if (/^https?:/i.test(l.href)) findings.push({ page: l.from, severity: 'warn', kind: '外部へのリンク', detail: l.href });
        continue;
      }
      const [pathPart, frag] = l.href.split('#', 2);
      const decoded = (() => {
        try {
          return decodeURIComponent(pathPart.split('?')[0]);
        } catch {
          return pathPart;
        }
      })();
      const targetAbs = resolve(dirname(join(root, l.from)), decoded);
      const targetRel = relative(root, targetAbs).split(sep).join('/');
      if (!existsSync(targetAbs)) {
        findings.push({ page: l.from, severity: 'error', kind: 'リンク先のファイルが無い', detail: `${l.href} 「${l.text.slice(0, 40)}」` });
        continue;
      }
      if (!frag || frag.split('&').some((p) => p.indexOf('=') > 0)) continue;
      const ids = idsByPage.get(targetRel);
      if (!ids) continue; // .md などページ以外
      let id = frag;
      try {
        id = decodeURIComponent(frag);
      } catch {
        /* そのまま */
      }
      if (!ids.has(id)) findings.push({ page: l.from, severity: 'error', kind: '別ページのリンクの行き先が無い', detail: `${l.href} 「${l.text.slice(0, 40)}」` });
      const m = /版 (\d+)/.exec(l.text);
      if (m && targetRel === 'instructions.html' && versionLabel.has(id) && versionLabel.get(id) !== `版 ${m[1]}`)
        findings.push({ page: l.from, severity: 'error', kind: '版の番号が行き先と違う', detail: `「${l.text.slice(0, 50)}」→ ${versionLabel.get(id)}(${id})` });
    }

    // 3) レイアウト(主要ページ + 詳細ページの見本)× 幅 × 配色
    const sessions = pages.filter((p) => p.startsWith('sessions/'));
    const nSample = Math.min(o.layoutSessions ?? 6, sessions.length);
    const bySize = [...sessions].sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size);
    const sample = [...new Set([...bySize.slice(0, Math.ceil(nSample / 2)), ...sessions.filter((_, i) => i % Math.max(1, Math.floor(sessions.length / Math.max(1, Math.floor(nSample / 2)))) === 0).slice(0, Math.floor(nSample / 2))])];
    const layoutPages = [...pages.filter((p) => !p.startsWith('sessions/')), ...sample];
    if (o.shotsDir) await mkdir(o.shotsDir, { recursive: true });
    for (const vp of VIEWPORTS)
      for (const scheme of SCHEMES) {
        const lctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, isMobile: vp.width < 768, hasTouch: vp.width < 768 });
        for (const rel of layoutPages) {
          const errors: string[] = [];
          const page = await openPage(lctx, pageUrl(root, rel), errors);
          const where = `${vp.name}px ${scheme === 'light' ? 'ライト' : 'ダーク'}`;
          const run = async (extra: string): Promise<void> => {
            const res = (await page.evaluate(`${LAYOUT_CHECK}(${vp.width < 768})`)) as { severity: 'error' | 'warn'; kind: string; detail: string }[];
            for (const f of res) if (!findings.some((x) => x.page === rel && x.kind === f.kind && x.detail === f.detail)) findings.push({ page: rel, ...f, where: where + extra });
          };
          await run('');
          if (rel === 'atlas.html') await eachTab(page, (label) => run(` タブ「${label}」`));
          // 押せそうで押せない要素は幅で出る部品が変わる(375px の上部の目次の行など)ので、幅ごとに見る(配色では変わらないのでライトだけ)
          if (scheme === 'light') for (const f of await clickableFindings(page)) addOnce({ page: rel, ...f, where });
          // 字の幅は OS のフォントで変わる(Linux の Noto は Windows の游ゴシックより広く、CI でだけはみ出した)。
          // 375px では字間を広げた状態でも横のはみ出しだけを確かめ、手元のフォントで収まっていても見逃さないようにする
          if (vp.width < 768 && scheme === 'light') {
            await page.addStyleTag({ content: `body{letter-spacing:${WIDE_TEXT_SPACING}}` });
            const res = (await page.evaluate(`${LAYOUT_CHECK}(true)`)) as { severity: 'error' | 'warn'; kind: string; detail: string }[];
            for (const f of res) if (f.kind === '横にはみ出している') findings.push({ page: rel, ...f, kind: '横にはみ出している(字幅の広いフォント)', where });
          }
          if (o.shotsDir && !rel.startsWith('sessions/')) await page.screenshot({ path: join(o.shotsDir, `${rel.replace(/[\\/]/g, '_')}-${vp.name}-${scheme}.png`), fullPage: true });
          for (const e of errors) findings.push({ page: rel, severity: 'error', kind: '実行時のエラー', detail: e, where });
          await page.close();
        }
        await lctx.close();
        log(`レイアウトの検査: ${vp.name}px ${scheme}`);
      }
    return { pages: pages.length, findings };
  } finally {
    await browser.close();
  }
}

/** 種類ごとに数えて、各種類の例を数件ずつ出す */
export function summarize(r: AuditResult, examples = 5): string {
  const byKind = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const k = `${f.severity === 'error' ? '[要修正]' : '[要確認]'} ${f.kind}`;
    (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f);
  }
  const lines = [`検査したページ: ${r.pages}、指摘: ${r.findings.length} 件(要修正 ${r.findings.filter((f) => f.severity === 'error').length})`];
  for (const [k, fs] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pagesN = new Set(fs.map((f) => f.page)).size;
    lines.push(`\n${k}: ${fs.length} 件(${pagesN} ページ)`);
    for (const f of fs.slice(0, examples)) lines.push(`  - ${f.page}${f.where ? `(${f.where})` : ''}: ${f.detail}`);
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const out = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!out || argv.includes('--help')) {
    process.stdout.write('使い方: node scripts/ui-audit.ts <out ディレクトリ> [--json <結果.json>] [--shots <dir>] [--layout-sessions <N>]\n');
    return out ? 0 : 2;
  }
  const opt = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const r = await audit(out, { layoutSessions: Number(opt('--layout-sessions') ?? 6), shotsDir: opt('--shots'), log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`${summarize(r)}\n`);
  const json = opt('--json');
  if (json) await writeFile(json, JSON.stringify(r, null, 1));
  return r.findings.some((f) => f.severity === 'error') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
