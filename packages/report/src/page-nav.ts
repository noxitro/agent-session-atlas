// 静的ページ(詳細・用語)の目次の帯と上部。atlas.html(App.svelte)と同じ作法:
// 1280px 以上は左に固定したサイドバー(戻る → 目次 → 別ページへのリンク → 配色)、1280px 未満は上部に固定した細い目次行(横に流れる)と、
// その上の帯(戻る・リンク・配色)。見た目は base.css の .rail / .toc / .top が持ち、動きは NAV_JS(外部参照なし、file:// で動く)。
import { esc } from './detail.ts';

export interface NavItem {
  href: string;
  label: string;
  /** 項目数などの小さな数字(用語ページの分類) */
  count?: number;
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
}
export interface PageNavOptions {
  crumbHref: string;
  crumbLabel: string;
  tocLabel: string;
  groups: NavGroup[];
  links: NavLink[];
}

const THEME_SEG = `<div class="seg" role="group" aria-label="配色" data-theme-seg><button type="button" data-theme="auto" aria-pressed="true">自動</button><button type="button" data-theme="light" aria-pressed="false">ライト</button><button type="button" data-theme="dark" aria-pressed="false">ダーク</button></div>`;

function links(ls: NavLink[]): string {
  return ls.map((l) => `<li><a href="${esc(l.href)}"${l.download ? ' download' : ''}>${esc(l.label)}</a></li>`).join('');
}

function toc(o: PageNavOptions): string {
  const groups = o.groups
    .map(
      (g) =>
        `<div class="toc-group"${g.title ? ` role="group" aria-label="${esc(g.title)}"` : ''}>${g.title ? `<span class="toc-title" aria-hidden="true">${esc(g.title)}</span>` : ''}<ol>${g.items
          .map(
            (it) =>
              `<li><a href="${esc(it.href)}">${esc(it.label)}${it.count != null ? `<span class="cnt" aria-label="${it.count} 項目">${it.count}</span>` : ''}${it.lead ? `<span class="lead">${esc(it.lead)}</span>` : ''}</a></li>`,
          )
          .join('')}</ol></div>`,
    )
    .join('');
  return `<nav class="toc" aria-label="${esc(o.tocLabel)}">${groups}</nav>`;
}

/** 1280px 未満で見せる上部の帯(戻る・別ページへのリンク・配色)。1280px 以上では CSS で隠し、同じ物をサイドバーに出す */
export function renderTop(o: PageNavOptions): string {
  return `<header class="top"><nav class="wrap" aria-label="ページの移動"><a class="crumb" href="${esc(o.crumbHref)}">${esc(o.crumbLabel)}</a><div class="top-right">${
    o.links.length ? `<ul class="top-links">${links(o.links)}</ul>` : ''
  }${THEME_SEG}</div></nav></header>`;
}

/** 目次の帯。1280px 以上はサイドバー(戻る・目次・リンク・配色)、未満は目次行だけ(戻る等は CSS で隠す) */
export function renderRail(o: PageNavOptions): string {
  return `<div class="rail"><div class="rail-in wrap"><a class="crumb rail-crumb" href="${esc(o.crumbHref)}">${esc(o.crumbLabel)}</a>${toc(o)}${
    o.links.length ? `<div class="rail-links"><ul>${links(o.links)}</ul></div>` : ''
  }<div class="rail-tools">${THEME_SEG}</div></div></div>`;
}

/**
 * 静的ページの動き(1 本にまとめて各ページに埋め込む):
 * - 配色の切り替え(localStorage の atlas-theme。atlas.html と同じ鍵)
 * - 1280px 未満で上部に固定した目次行の高さを --topbar-h に出す(飛び先の余白とキーボード移動の補正に使う)
 * - 読んでいる節に aria-current の印(見出しが画面上部 1/3 を越えた最後の節。末尾では最後の節)。狭い画面では現在地が見える位置まで目次行をずらす
 * - 「← 戻る」: atlas.html から来たとき(atlas.html が別ページへ移るときに sessionStorage に残す印。http では referrer でも分かる)は history.back() で戻り、
 *   URL の # に残る絞り込みを保つ。直接開いたとき・新しいタブ・修飾キー付きのクリックでは普通のリンク。印は読んだら消す
 */
export const NAV_JS = `(function(){var d=document,root=d.documentElement,W=matchMedia('(min-width:1280px)'),KEY='atlas-theme';
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
var m=false;try{m=sessionStorage.getItem('atlas-return')==='1';sessionStorage.removeItem('atlas-return')}catch(e){}
d.querySelectorAll('a.crumb').forEach(function(a){a.addEventListener('click',function(e){if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var ok=false;try{ok=history.length>1&&(m||/atlas\\.html/.test(d.referrer))}catch(err){}if(ok){e.preventDefault();history.back()}})});
})();`;
