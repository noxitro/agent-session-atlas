// 用語の説明ページ(out/glossary.html)。atlas.html と詳細ページから本文を外し、1 枚だけ別に置く
// (読む人は初回だけ要るもので、毎ページに 33 項目を展開するとノイズになるため)。
// 詳細ページと同じ base.css を埋め込み、同じ「様式」の見た目にする。各項目は id を持ち、他ページから glossary.html#<id> で飛べる。
// 本文は 5 つの分類(h2、id は g-<分類>)で区切り、目次は分類だけを載せる。目次の帯は atlas.html・詳細ページと同じ作法(page-nav.ts): 1280px 以上は左のサイドバー、未満は上部の固定行。
import { dateTime } from './lib/format.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from './lib/glossary.ts';
import { esc } from './detail.ts';
import { NAV_JS, renderRail, renderTop } from './page-nav.ts';

export interface GlossaryPageOptions {
  css: string;
  generatedAt: string;
}

export const GLOSSARY_FILE = 'glossary.html';

const GLOSSARY_CSS = `
.group{margin-top:28px}
.group:first-child{margin-top:0}
.group .section-head p{max-width:none}
dl.glossary{margin-top:10px}
dl.glossary dt{scroll-margin-top:12px}
dl.glossary dt a{color:inherit;text-decoration:none}
dl.glossary dt a:hover,dl.glossary dt a:focus-visible{text-decoration:underline}
dl.glossary dt:target,dl.glossary dt:target+dd{background:var(--form-wash)}
.gbody .missing-legend{margin:10px 0 0}
`;

const MISSING_LEGEND = `<ul class="missing-legend" aria-label="欠測の語の使い分け">
  <li><b>記録なし</b><span>ログにその項目の記録が無い</span></li>
  <li><b>推計不可</b><span>出力トークンだけ記録があり、入力は求められない</span></li>
  <li><b>未判定</b><span>LLM による工数判定をまだ実行していない</span></li>
  <li><b>不明</b><span>記録はあるが分類できない(クライアント・モデルなど)</span></li>
  <li><b>—</b><span>該当なし(0 件、または求める元の値が無い)</span></li>
</ul>`;

export function renderGlossaryHtml(o: GlossaryPageOptions): string {
  const nav = {
    crumbHref: 'atlas.html',
    crumbLabel: '← レポートに戻る',
    tocLabel: '用語の分類',
    groups: [{ items: GLOSSARY_GROUPS.map((g) => ({ href: `#g-${g.id}`, label: g.title, count: termsByGroup(g.id).length, lead: g.lead })) }],
    links: [],
  };
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
${renderTop(nav)}
<div class="shell">
${renderRail(nav)}
<div class="content">
<main class="wrap">
<div class="title"><h1>用語の説明</h1><p class="note">このレポートを初めて読む人向けです。${GLOSSARY.length} 語を ${GLOSSARY_GROUPS.length} つに分けて、各欄の数値がどの記録から来ていて、何を含み何を含まないかを書いています。</p></div>
<div class="gbody">${groups}</div>
</main>
<footer class="wrap page-foot">Copilot Session Atlas が ${esc(dateTime(o.generatedAt))} に生成。</footer>
</div>
</div>
<script>${NAV_JS}</script>
</body>
</html>
`;
}
