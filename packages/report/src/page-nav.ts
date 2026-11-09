// 静的ページ(詳細・用語)の目次の帯と上部。atlas.html(App.svelte)と同じ作法:
// 768px 以上は左に固定したサイドバー(戻る → 目次 → 別ページへのリンク → 配色)、768px 未満は上部に固定した細い目次行(横に流れる)と、
// その上の帯(戻る・リンク・配色)。見た目は base.css の .rail / .toc / .top が持ち、動きは NAV_JS(外部参照なし、file:// で動く)。
import { esc } from './detail.ts';
import { SCROLLERS } from './lib/scroll-focus.ts';

export interface NavItem {
  href: string;
  label: string;
  /** 項目数などの小さな数字(用語ページの分類) */
  count?: number;
  /** 件数の読み上げの単位(既定は「項目」) */
  countLabel?: string;
  /** 単位を数字の後ろに見せる(数字だけだと番号に読めるもの。既定は読み上げだけ) */
  showCountLabel?: boolean;
  /** 1 行の説明(サイドバーでだけ出す) */
  lead?: string;
}
export interface NavGroup {
  /** 群の題(サイドバーでだけ出す。無ければ区切りだけ) */
  title?: string;
  items: NavItem[];
}
export interface NavLink {
  href: string;
  label: string;
  download?: boolean;
  /** 別のウィンドウ(タブ)で開く。記録の .md など、今のページを残したまま読むもの */
  newWindow?: boolean;
}
export interface PageNavOptions {
  crumbHref: string;
  crumbLabel: string;
  tocLabel: string;
  groups: NavGroup[];
  links: NavLink[];
}

const THEME_SEG = `<div class="seg" role="group" aria-label="配色" data-theme-seg><button type="button" data-theme="auto" aria-pressed="true">自動</button><button type="button" data-theme="light" aria-pressed="false">ライト</button><button type="button" data-theme="dark" aria-pressed="false">ダーク</button></div>`;

/** 別ウィンドウで開くリンクの印(見た目は ↗、読み上げは文で) */
export const NEW_WINDOW_MARK = `<span class="ext" aria-hidden="true">↗</span><span class="sr-only">(別のウィンドウで開きます)</span>`;

function links(ls: NavLink[]): string {
  return ls
    .map(
      (l) =>
        `<li><a href="${esc(l.href)}"${l.download ? ' download' : ''}${l.newWindow ? ` target="_blank" rel="noopener">${esc(l.label)}${NEW_WINDOW_MARK}` : `>${esc(l.label)}`}</a></li>`,
    )
    .join('');
}

function toc(o: PageNavOptions): string {
  const groups = o.groups
    .map(
      (g) =>
        `<div class="toc-group"${g.title ? ` role="group" aria-label="${esc(g.title)}"` : ''}>${g.title ? `<span class="toc-title" aria-hidden="true">${esc(g.title)}</span>` : ''}<ol>${g.items
          .map(
            (it) =>
              `<li><a href="${esc(it.href)}">${esc(it.label)}${it.count != null ? (it.showCountLabel ? `<span class="cnt">${it.count} ${esc(it.countLabel ?? '項目')}</span>` : `<span class="cnt" aria-label="${it.count} ${esc(it.countLabel ?? '項目')}">${it.count}</span>`) : ''}${it.lead ? `<span class="lead">${esc(it.lead)}</span>` : ''}</a></li>`,
          )
          .join('')}</ol></div>`,
    )
    .join('');
  return `<nav class="toc" aria-label="${esc(o.tocLabel)}">${groups}</nav>`;
}

/** 768px 未満で見せる上部の帯(戻る・別ページへのリンク・配色)。768px 以上では CSS で隠し、同じ物をサイドバーに出す */
export function renderTop(o: PageNavOptions): string {
  return `<header class="top"><nav class="wrap" aria-label="ページの移動"><a class="crumb" href="${esc(o.crumbHref)}">${esc(o.crumbLabel)}</a><div class="top-right">${
    o.links.length ? `<ul class="top-links">${links(o.links)}</ul>` : ''
  }${THEME_SEG}</div></nav></header>`;
}

/** 目次の帯。768px 以上はサイドバー(戻る・目次・リンク・配色)、未満は目次行だけ(戻る等は CSS で隠す) */
export function renderRail(o: PageNavOptions): string {
  return `<div class="rail"><div class="rail-in wrap"><a class="crumb rail-crumb" href="${esc(o.crumbHref)}">${esc(o.crumbLabel)}</a>${toc(o)}${
    o.links.length ? `<div class="rail-links"><ul>${links(o.links)}</ul></div>` : ''
  }<div class="rail-tools">${THEME_SEG}</div></div></div>`;
}

/**
 * 静的ページの動き(1 本にまとめて各ページに埋め込む):
 * - 配色の切り替え(localStorage の atlas-theme。atlas.html と同じ鍵)
 * - あふれてスクロールする枠(SCROLLERS)に、あふれているときだけ tabindex="0"(lib/scroll-focus.ts と同じ。開閉と幅の変化で付け直す)
 * - 768px 未満で上部に固定した目次行の高さを --topbar-h に出す(飛び先の余白とキーボード移動の補正に使う)
 * - 読んでいる節に aria-current の印(見出しが画面上部 1/3 を越えた最後の節。末尾では最後の節)。狭い画面では現在地が見える位置まで目次行をずらす
 * - 「← 戻る」: atlas.html から来たとき(atlas.html が別ページへ移るときに sessionStorage に残す印。http では referrer でも分かる)は history.back() で戻り、
 *   URL の # に残る絞り込みを保つ。直接開いたとき・新しいタブ・修飾キー付きのクリックでは普通のリンク。印は読んだら消す
 * - heartbeat: atlas serve から開かれたとき(http(s) で、meta の token がプレースホルダでない)だけ 3 秒ごとに POST し、ページを閉じるときは bye を送る
 *   (atlas.html の startHeartbeat と同じ作法。ページの id を x-atlas-client で送る)。続けて 3 回失敗したら(403 ならすぐ)止めて「サーバが止まっています」の帯を出す。
 *   タブが表に戻ったとき・戻る / 進むで戻ったときはすぐ送る。宛先は同一オリジンの相対パス(詳細ページは ../api/、用語ページは api/)
 * - メモの編集: atlas serve のときだけ、メモの節(#memo)があるページに編集の script を読み込む。止まったら atlas-down を知らせる
 * - Phase 14: 同じ条件で「記録を読む」「全文を作って読む」の script(api/session-tools.js)も読み込む(伏せ字版には #memo が無いので出ない)
 */
export const NAV_JS = `(function(){var SCROLLERS=${JSON.stringify(SCROLLERS)};var d=document,root=d.documentElement,W=matchMedia('(min-width:768px)'),KEY='atlas-theme';
var segs=d.querySelectorAll('[data-theme-seg] button');function paint(t){segs.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.theme===t?'true':'false')})}
segs.forEach(function(b){b.addEventListener('click',function(){var t=b.dataset.theme;if(t==='auto')delete root.dataset.theme;else root.dataset.theme=t;try{if(t==='auto')localStorage.removeItem(KEY);else localStorage.setItem(KEY,t)}catch(e){}paint(t)})});
(function(){var t='auto';try{var v=localStorage.getItem(KEY);if(v==='light'||v==='dark')t=v}catch(e){}paint(t)})();
var rail=d.querySelector('.rail'),links=[],secs=[],tick=false;
d.querySelectorAll('.rail .toc a[href^="#"]').forEach(function(a){var el=d.getElementById(a.getAttribute('href').slice(1));if(el){links.push(a);secs.push(el)}});
function mark(){tick=false;var top=W.matches||!rail?0:rail.offsetHeight;root.style.setProperty('--topbar-h',top+'px');if(!secs.length)return;
var line=top+Math.min(160,innerHeight/3),i=0,k;for(k=0;k<secs.length;k++){if(secs[k].getBoundingClientRect().top<=line)i=k}if(innerHeight+scrollY>=root.scrollHeight-2)i=secs.length-1;
for(k=0;k<links.length;k++){if(k===i)links[k].setAttribute('aria-current','true');else links[k].removeAttribute('aria-current')}
if(!W.matches){var a=links[i],ol=a.closest('.toc');if(ol&&ol.scrollWidth>ol.clientWidth){var l=a.getBoundingClientRect().left-ol.getBoundingClientRect().left+ol.scrollLeft,r=l+a.offsetWidth;if(l<ol.scrollLeft)ol.scrollLeft=l-12;else if(r>ol.scrollLeft+ol.clientWidth)ol.scrollLeft=r-ol.clientWidth+12}}}
function onS(){if(!tick){tick=true;requestAnimationFrame(mark)}}addEventListener('scroll',onS,{passive:true});addEventListener('resize',onS);mark();
function sf(){d.querySelectorAll(SCROLLERS).forEach(function(el){var o=el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1;if(o&&!el.hasAttribute('tabindex')){el.tabIndex=0;el.setAttribute('data-scroll-focus','')}else if(!o&&el.hasAttribute('data-scroll-focus')){el.removeAttribute('tabindex');el.removeAttribute('data-scroll-focus')}})}
sf();addEventListener('resize',sf);d.addEventListener('toggle',sf,true);
var m=false;try{m=sessionStorage.getItem('atlas-return')==='1';sessionStorage.removeItem('atlas-return')}catch(e){}
d.querySelectorAll('a.crumb').forEach(function(a){a.addEventListener('click',function(e){if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var ok=false;try{ok=history.length>1&&(m||/atlas\\.html/.test(d.referrer))}catch(err){}if(ok){e.preventDefault();history.back()}})});
(function(){var mt=d.querySelector('meta[name="atlas-token"]'),t=mt?mt.content:'';if(!/^https?:$/.test(location.protocol)||!t||/^__/.test(t))return;
var c=d.querySelector('a.crumb'),up=!!c&&/^\\.\\.\\//.test(c.getAttribute('href')||''),cid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,10),o={method:'POST',headers:{'X-Atlas-Token':t,'X-Atlas-Client':cid},keepalive:true},iv=null,fails=0;
function down(){if(!iv)return;clearInterval(iv);iv=null;var b=d.createElement('div');b.className='down-band';b.setAttribute('role','alert');b.textContent='サーバが止まっています。atlas.bat を実行し直してください(閲覧はそのままできます)。';d.body.insertBefore(b,d.body.firstChild);d.dispatchEvent(new Event('atlas-down'))}
function fail(now){if(now||++fails>=3)down()}
function beat(){if(!iv)return;try{(up?fetch('../api/heartbeat',o):fetch('api/heartbeat',o)).then(function(r){if(r.ok)fails=0;else fail(r.status===403)}).catch(function(){fail(false)})}catch(e){fail(false)}}
iv=setInterval(beat,3000);beat();
addEventListener('pagehide',function(e){if(!e.persisted&&iv)try{(up?fetch('../api/bye',o):fetch('api/bye',o)).catch(function(){})}catch(err){}});
addEventListener('pageshow',function(e){if(e.persisted)beat()});
d.addEventListener('visibilitychange',function(){if(d.visibilityState==='visible')beat()});
if(up&&d.getElementById('memo')){['../api/memo-editor.js','../api/session-tools.js'].forEach(function(p){var s=d.createElement('script');s.src=p;d.body.appendChild(s)})}})();
})();`;
