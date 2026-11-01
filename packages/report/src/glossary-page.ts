// 用語の説明ページ(out/glossary.html)。atlas.html と詳細ページから本文を外し、1 枚だけ別に置く
// (読む人は初回だけ要るもので、毎ページに 33 項目を展開するとノイズになるため)。
// 詳細ページと同じ base.css を埋め込み、同じ「様式」の見た目にする。各項目は id を持ち、他ページから glossary.html#<id> で飛べる。
// 本文は 5 つの分類(h2、id は g-<分類>)で区切り、目次は分類だけを載せる。広い画面では左に固定した側面目次、狭い画面では分類の行だけ。
import { dateTime } from './lib/format.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from './lib/glossary.ts';
import { BACK_JS, esc } from './detail.ts';

export interface GlossaryPageOptions {
  css: string;
  generatedAt: string;
}

export const GLOSSARY_FILE = 'glossary.html';

const GLOSSARY_CSS = `
.gloss{display:grid;grid-template-columns:minmax(0,1fr);gap:0 32px;margin-top:16px}
.gtoc ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 8px}
.gtoc a{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);text-decoration:none;font-size:.8125rem}
.gtoc a:hover{background:var(--form-wash);color:var(--form)}
.gtoc a[aria-current="true"]{border-left:3px solid var(--form);padding-left:10px;color:var(--form);font-weight:600}
.gtoc .cnt{color:var(--ink-3);font-size:.75rem;font-variant-numeric:tabular-nums}
.gtoc .lead{display:none}
.group{margin-top:28px;scroll-margin-top:12px}
.group:first-child{margin-top:0}
.group .section-head p{max-width:none}
dl.glossary{margin-top:10px}
dl.glossary dt{scroll-margin-top:12px}
dl.glossary dt a{color:inherit;text-decoration:none}
dl.glossary dt a:hover,dl.glossary dt a:focus-visible{text-decoration:underline}
dl.glossary dt:target,dl.glossary dt:target+dd{background:var(--form-wash)}
.gloss .missing-legend{margin:10px 0 0}
@media (min-width:960px){
.gloss{grid-template-columns:15em minmax(0,1fr)}
.gtoc{position:sticky;top:16px;align-self:start}
.gtoc ol{display:block;border-top:1px solid var(--rule-strong)}
.gtoc a{border-width:0 0 1px;flex-wrap:wrap;row-gap:0;padding:8px 12px}
.gtoc a[aria-current="true"]{padding-left:9px}
.gtoc .lead{display:block;flex-basis:100%;font-size:.75rem;color:var(--ink-3);font-weight:400}
.gtoc a:hover .lead,.gtoc a[aria-current="true"] .lead{color:var(--ink-2)}
}
`;

// 読んでいる分類(画面上部 1/3 より上に見出しが来た最後の節)を側面目次に印として写す。スクロールごとに rAF で 1 回だけ測る
const GLOSSARY_JS = `(function(){var links={},secs=[];document.querySelectorAll('.gtoc a[href^="#g-"]').forEach(function(a){links[a.getAttribute('href').slice(1)]=a});document.querySelectorAll('section.group').forEach(function(s){secs.push(s)});if(!secs.length)return;var tick=false;function mark(){tick=false;var line=Math.min(160,window.innerHeight/3),cur=secs[0].id;for(var i=0;i<secs.length;i++){if(secs[i].getBoundingClientRect().top<=line)cur=secs[i].id}if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2)cur=secs[secs.length-1].id;for(var k in links){if(k===cur)links[k].setAttribute('aria-current','true');else links[k].removeAttribute('aria-current')}}function onScroll(){if(!tick){tick=true;requestAnimationFrame(mark)}}window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',onScroll);mark()})();`;

const MISSING_LEGEND = `<ul class="missing-legend" aria-label="欠測の語の使い分け">
  <li><b>記録なし</b><span>ログにその項目の記録が無い</span></li>
  <li><b>推計不可</b><span>出力トークンだけ記録があり、入力は求められない</span></li>
  <li><b>未判定</b><span>LLM による工数判定をまだ実行していない</span></li>
  <li><b>不明</b><span>記録はあるが分類できない(クライアント・モデルなど)</span></li>
  <li><b>—</b><span>該当なし(0 件、または求める元の値が無い)</span></li>
</ul>`;

export function renderGlossaryHtml(o: GlossaryPageOptions): string {
  const toc = GLOSSARY_GROUPS.map(
    (g) =>
      `<li><a href="#g-${g.id}">${esc(g.title)}<span class="cnt" aria-label="${termsByGroup(g.id).length} 項目">${termsByGroup(g.id).length}</span><span class="lead">${esc(g.lead)}</span></a></li>`,
  ).join('');
  const groups = GLOSSARY_GROUPS.map((g) => {
    const terms = termsByGroup(g.id);
    const dl = terms.map((t) => `<dt id="${esc(t.id)}"><a href="#${esc(t.id)}">${esc(t.term)}</a></dt><dd>${esc(t.body)}</dd>`).join('');
    return `<section class="section group" id="g-${g.id}" aria-labelledby="h-${g.id}"><div class="section-head"><h2 id="h-${g.id}">${esc(g.title)}</h2><p>${esc(g.lead)}</p></div>${
      g.id === 'records' ? MISSING_LEGEND : ''
    }<dl class="glossary">${dl}</dl></section>`;
  }).join('');
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
<header class="top"><nav class="wrap" aria-label="ページの移動"><a class="crumb" href="atlas.html">← レポートに戻る</a></nav></header>
<main class="wrap">
<div class="title"><h1>用語の説明</h1><p class="note">このレポートを初めて読む人向けです。${GLOSSARY.length} 語を ${GLOSSARY_GROUPS.length} つに分けて、各欄の数値がどの記録から来ていて、何を含み何を含まないかを書いています。</p></div>
<div class="gloss">
<nav class="gtoc" aria-label="用語の分類"><ol>${toc}</ol></nav>
<div class="gbody">${groups}</div>
</div>
</main>
<footer class="wrap page-foot">Copilot Session Atlas が ${esc(dateTime(o.generatedAt))} に生成。</footer>
<script>${GLOSSARY_JS}</script>
<script>${BACK_JS}</script>
</body>
</html>
`;
}
