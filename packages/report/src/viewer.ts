// Phase 14: セッション記録(out/sessions/<id>.md)と全文記録(out/full/<id>.md)を atlas serve の画面で読む(GET /view/<id>?kind=transcript|full)。
// - 描き方はメモと同じ規則(memo-render.ts の renderSafeMarkdown): 生の HTML は文字のまま、リンクは http / https / mailto だけ、外部の画像は読まない。
//   全文記録だけは out/full/assets/<id>/ への相対参照(画像と書き出したファイル)を通す(サーバが配る ../full/assets/<id>/<名前>)。
// - ページ(殻)は本文を持たない。本文は殻の script が token を付けて GET /api/view/<id>?kind=… で取り、描いた HTML を差し込む
//   (/view/ への移動にはヘッダを付けられないため。token が無ければ本文は読めない)。見た目は詳細ページと同じ(base.css と page-nav)。
// - file:// と共有用の HTML には出さない(serve だけが配る。静的な生成物は変えない)。
import { existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { esc } from './detail.ts';
import { renderSafeMarkdown, type SafeMarkdown } from './memo-render.ts';
import { isSafeFileName } from './lib/memo.ts';
import { NAV_JS, renderRail, renderTop } from './page-nav.ts';

export type ViewKind = 'transcript' | 'full';
export const VIEW_KINDS: readonly ViewKind[] = ['transcript', 'full'];
/** これより大きい .md は描かない(.md を直接開くリンクと大きさを出す) */
export const VIEW_LIMIT = 20 * 1024 * 1024;
/** 記録・全文記録の中で atlas 自身が書く、属性の無いタグ(これだけはタグとして描く。他の生の HTML は文字のまま) */
export const VIEW_ALLOWED_TAGS = ['small', 'details', 'summary'] as const;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/**
 * リンクにしてよい形式(開いても script が動かないもの)。svg・html・xml などはセッション由来の内容がサーバのオリジンで
 * 動きうるので、リンクにも画像にもしない(名前だけ。serve も静的ファイルに CSP sandbox を付ける)
 */
const PASSIVE_EXT = new Set([...IMAGE_EXT, '.txt', '.log', '.json', '.csv', '.pdf', '.bin']);

/** 全文記録の画像などの置き場の名前(full.ts / build.ts と同じ置き換え) */
export const assetFolder = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_');

/** 相対参照が out/full/assets/<id>/ の直下の実在するファイルなら、/view/<id> から見たパスを返す */
function assetPath(fullDir: string, id: string, href: string): { path: string; image: boolean } | null {
  let p: string;
  try {
    p = decodeURI(href).replace(/^\.\//, '');
  } catch {
    return null;
  }
  const folder = assetFolder(id);
  const parts = p.split('/');
  if (parts.length !== 3 || parts[0] !== 'assets' || parts[1] !== folder || !isSafeFileName(parts[2])) return null;
  if (!PASSIVE_EXT.has(extname(parts[2]).toLowerCase())) return null;
  const file = join(fullDir, 'assets', folder, parts[2]);
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { path: `../full/assets/${encodeURIComponent(folder)}/${encodeURIComponent(parts[2])}`, image: IMAGE_EXT.has(extname(parts[2]).toLowerCase()) };
}

/**
 * .md の本文を画面用の HTML にする。先頭の「# 表題」はページの h1 にするので本文から外して title で返し、## を h2 にして id を付け目次にする
 * (他の # も h2 より上にはしない)。fullDir は全文記録のときだけ(out/full)。記録には相対の画像もリンクも無いので、どちらも文字だけにする
 */
export function renderViewDocument(markdown: string, o: { kind: ViewKind; id: string; fullDir?: string | null }): SafeMarkdown & { title: string | null } {
  const fullDir = o.kind === 'full' ? (o.fullDir ?? null) : null;
  const head = /^\s*# +([^\n]+?)\s*#*[ \t]*(?:\r?\n|$)/.exec(markdown);
  const body = head ? markdown.slice(head[0].length) : markdown;
  const doc = renderSafeMarkdown(body, {
    headingShift: 0,
    headingMin: 2,
    headingIdLevel: 2,
    allowTags: VIEW_ALLOWED_TAGS,
    image: (href) => {
      if (!fullDir) return null;
      const a = assetPath(fullDir, o.id, href);
      return a?.image ? a.path : null;
    },
    relativeLink: (href) => (fullDir ? (assetPath(fullDir, o.id, href)?.path ?? null) : null),
  });
  return { ...doc, title: head ? head[1] : null };
}

export const VIEW_CSS = `
.view-status{margin:6px 0 0;min-height:1.55em}
.rail .toc:empty{display:none}
.view-err{margin:12px 0 0;padding:8px 12px;max-width:75ch;font-size:.8125rem;background:var(--warn-wash);border:1px solid var(--warn)}
.doc{margin-top:16px;padding:16px 20px 20px;max-width:120ch;background:var(--surface);border:1px solid var(--rule);border-top-color:var(--rule-strong);overflow-wrap:anywhere;font-size:.875rem;line-height:1.7}
.doc[hidden]{display:none}
.doc>:first-child{margin-top:0}
.doc h2{margin:28px 0 8px;padding-bottom:4px;font-size:1.0625rem;border-bottom:2px solid var(--form);scroll-margin-top:12px}
.doc h3{margin:20px 0 6px;font-size:1rem}
.doc h4{margin:16px 0 4px;font-size:.9375rem}
.doc h5,.doc h6{margin:12px 0 4px;font-size:.875rem}
.doc p,.doc ul,.doc ol{margin:6px 0}
.doc ul,.doc ol{padding-left:1.6em}
.doc pre{margin:8px 0;padding:8px 10px;max-height:60vh;overflow:auto;background:var(--page);border:1px solid var(--rule);font-family:var(--mono);font-size:.8125rem;line-height:1.5;overflow-wrap:normal}
.doc pre code{white-space:pre}
.doc code{font-family:var(--mono);font-size:.8125rem}
.doc blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:2px solid var(--rule-strong);color:var(--ink-2)}
.doc table{border-collapse:collapse;margin:8px 0;font-size:.8125rem}
.doc th,.doc td{border:1px solid var(--rule);padding:4px 8px;text-align:left;vertical-align:top}
.doc thead th{background:var(--form-wash);color:var(--form);font-weight:600;font-size:.75rem}
.doc img{display:block;max-width:100%;height:auto;margin:8px 0;border:1px solid var(--rule)}
.doc hr{border:0;border-top:1px solid var(--rule);margin:16px 0}
.doc small{font-size:.75rem;color:var(--ink-3)}
.doc details{margin:8px 0;padding:4px 10px;border:1px solid var(--rule)}
.doc summary{cursor:pointer;color:var(--form)}
@media (max-width:720px){.doc{padding:12px}}
`;

export const VIEW_LABEL: Record<ViewKind, string> = { transcript: 'セッション記録', full: '全文記録(解析用)' };

/**
 * 殻の script: token を付けて本文を取り、描いた HTML を差し込んで目次を作る。読んでいる節に印(NAV_JS と同じ規則)。
 * 本文はサーバが esc 済みの HTML(script を持たない)。innerHTML で入れても script は実行されない
 */
const VIEWER_JS = `(function(){var d=document,root=d.documentElement,main=d.querySelector('main'),id=main.dataset.session,kind=main.dataset.kind;
var mt=d.querySelector('meta[name="atlas-token"]'),token=mt?mt.content:'',st=d.getElementById('view-status'),body=d.getElementById('view-body'),h1=d.querySelector('.title h1');
function say(t){st.textContent=t}
function fail(t){var p=d.createElement('p');p.className='view-err';p.setAttribute('role','alert');p.textContent=t;st.textContent='';st.after(p)}
function mb(n){return n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(n<1048576*10?2:1)+' MB'}
if(!/^https?:$/.test(location.protocol)||!token||/^__/.test(token)){fail('atlas serve から開いたときだけ読めます。');return}
say('読み込んでいます…');
fetch('../api/view/'+encodeURIComponent(id)+'?kind='+encodeURIComponent(kind),{headers:{'x-atlas-token':token},cache:'no-store'}).then(function(r){return r.json().catch(function(){return{}}).then(function(b){return{ok:r.ok,status:r.status,body:b}})},function(){throw new Error('サーバに接続できません(atlas.bat を実行し直してください)')}).then(function(r){
  if(!r.ok)throw new Error(r.body.error||('サーバの応答 '+r.status));
  // 表題は「セッション記録 — 題名」(題名自体に「:」が入ることがあるので、区切りはダッシュにする)
  var b=r.body,t=b.docTitle?b.docTitle.replace(/^(セッション記録|全文記録): /,'$1 — '):(b.label+' — '+b.title);h1.textContent=t;d.title=t.slice(0,80)+' | Copilot Session Atlas';
  // 日時はレポートと同じ「2026-11-05 13:15」の形(lib/format.ts の dateTime)
  function dt(iso){var x=new Date(iso),p=function(n){return String(n).padStart(2,'0')};return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate())+' '+p(x.getHours())+':'+p(x.getMinutes())}
  var when=b.updatedAt?'、更新 '+dt(b.updatedAt):'';
  if(b.tooLarge){say('');fail(b.label+'は '+mb(b.size)+' あり、画面に描く上限('+mb(b.limit)+')を超えています。「.md を開く」から直接開いてください。');return}
  body.innerHTML=b.html;body.hidden=false;say(b.label+'(Markdown '+mb(b.size)+when+')');
  var toc=d.querySelector('.rail .toc'),ol=d.createElement('ol'),links=[],secs=[];
  (b.headings||[]).forEach(function(h){var el=d.getElementById(h.id);if(!el)return;var li=d.createElement('li'),a=d.createElement('a');a.href='#'+h.id;a.textContent=h.text||'(見出し)';li.appendChild(a);ol.appendChild(li);links.push(a);secs.push(el)});
  if(toc&&links.length){var g=d.createElement('div');g.className='toc-group';g.appendChild(ol);toc.appendChild(g)}
  var W=matchMedia('(min-width:1280px)'),rail=d.querySelector('.rail'),tick=false;
  function mark(){tick=false;if(!secs.length)return;var top=W.matches||!rail?0:rail.offsetHeight,line=top+Math.min(160,innerHeight/3),i=0,k;for(k=0;k<secs.length;k++){if(secs[k].getBoundingClientRect().top<=line)i=k}if(innerHeight+scrollY>=root.scrollHeight-2)i=secs.length-1;for(k=0;k<links.length;k++){if(k===i)links[k].setAttribute('aria-current','true');else links[k].removeAttribute('aria-current')}}
  addEventListener('scroll',function(){if(!tick){tick=true;requestAnimationFrame(mark)}},{passive:true});mark();
  if(location.hash.length>1){var t=d.getElementById(decodeURIComponent(location.hash.slice(1)));if(t)t.scrollIntoView()}
}).catch(function(e){fail(e.message)});
})();`;

export interface ViewerShellOptions {
  css: string;
  id: string;
  kind: ViewKind;
  /** 詳細ページ(sessions/<id>.html)・.md の場所(/view/<id> から見た相対パス) */
  detailHref: string;
  mdHref: string;
}

/** /view/<id> の殻。本文と表題は持たない(token の要る API から取る) */
export function renderViewerShell(o: ViewerShellOptions): string {
  const label = VIEW_LABEL[o.kind];
  const nav = {
    crumbHref: o.detailHref,
    crumbLabel: '← 詳細ページに戻る',
    tocLabel: `${label}の見出し`,
    groups: [],
    links: [
      { href: o.mdHref, label: '.md を開く', newWindow: true },
      { href: '../glossary.html', label: '用語の説明' },
    ],
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="atlas-token" content="__ATLAS_TOKEN__">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>${esc(label)} | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${VIEW_CSS}</style>
</head>
<body>
${renderTop(nav)}
<div class="shell">
${renderRail(nav)}
<div class="content">
<main class="wrap" data-session="${esc(o.id)}" data-kind="${esc(o.kind)}">
<div class="title"><h1>${esc(label)}</h1><p class="note view-status" id="view-status" role="status" aria-live="polite"></p></div>
<article class="doc" id="view-body" aria-label="${esc(label)}の本文" hidden></article>
</main>
<footer class="wrap page-foot">atlas serve が .md を描いた表示です(生の HTML は文字のまま、外部の画像は読み込みません)。</footer>
</div>
</div>
<script>${NAV_JS}</script>
<script>${VIEWER_JS}</script>
</body>
</html>
`;
}
