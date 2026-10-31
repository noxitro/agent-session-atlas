// 用語の説明ページ(out/glossary.html)。atlas.html と詳細ページから本文を外し、1 枚だけ別に置く
// (読む人は初回だけ要るもので、毎ページに 34 項目を展開するとノイズになるため)。
// 詳細ページと同じ base.css を埋め込み、同じ「様式」の見た目にする。各項目は id を持ち、他ページから glossary.html#<id> で飛べる。
import { dateTime } from './lib/format.ts';
import { GLOSSARY } from './lib/glossary.ts';
import { esc } from './detail.ts';

export interface GlossaryPageOptions {
  css: string;
  generatedAt: string;
}

export const GLOSSARY_FILE = 'glossary.html';

const GLOSSARY_CSS = `
.top{background:var(--surface);border-bottom:1px solid var(--rule-strong)}
.top .wrap{display:flex;gap:16px;align-items:center;justify-content:space-between;padding-top:10px;padding-bottom:10px;flex-wrap:wrap}
.crumb{font-size:.8125rem}
.title{padding:20px 0 4px}
.toc{display:flex;flex-wrap:wrap;gap:4px 12px;margin:12px 0 20px;padding:0;list-style:none;font-size:.8125rem}
.toc li{margin:0}
dl.glossary dt{scroll-margin-top:56px}
dl.glossary dt a{color:inherit;text-decoration:none}
dl.glossary dt a:hover,dl.glossary dt a:focus-visible{text-decoration:underline}
dl.glossary dt:target,dl.glossary dt:target+dd{background:var(--form-wash)}
footer{margin:40px 0 32px;color:var(--ink-3);font-size:.75rem}
`;

export function renderGlossaryHtml(o: GlossaryPageOptions): string {
  const toc = GLOSSARY.map((g) => `<li><a href="#${esc(g.id)}">${esc(g.term)}</a></li>`).join('');
  const body = GLOSSARY.map((g) => `<dt id="${esc(g.id)}"><a href="#${esc(g.id)}">${esc(g.term)}</a></dt><dd>${esc(g.body)}</dd>`).join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>用語の説明 | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${GLOSSARY_CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="crumb" href="atlas.html">← レポートに戻る</a></div></header>
<main class="wrap">
<div class="title"><h1>用語の説明</h1><p class="note">このレポートを初めて読む人向けです。レポートの各欄の数値がどの記録から来ていて、何を含み何を含まないかを書いています。</p></div>
<nav aria-label="用語の一覧"><ul class="toc">${toc}</ul></nav>
<section class="section" aria-label="用語"><dl class="glossary">${body}</dl></section>
<footer>Copilot Session Atlas が ${esc(dateTime(o.generatedAt))} に生成。</footer>
</main>
</body>
</html>
`;
}
