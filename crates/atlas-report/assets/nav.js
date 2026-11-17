(function(){var SCROLLERS=".table-scroll, blockquote.msg",STALE="画面とサーバの版が違います(この画面を作ったときと、サーバを起動したときとで、atlas のコードが違います)。atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行し、新しく開いた画面を使ってください(それまでは使えない操作があります。閲覧はそのままできます)。";var d=document,root=d.documentElement,W=matchMedia('(min-width:768px)'),KEY='atlas-theme';
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
d.querySelectorAll('a.crumb').forEach(function(a){a.addEventListener('click',function(e){if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var ok=false;try{ok=history.length>1&&(m||/atlas\.html/.test(d.referrer))}catch(err){}if(ok){e.preventDefault();history.back()}})});
(function(){var mt=d.querySelector('meta[name="atlas-token"]'),t=mt?mt.content:'';if(!/^https?:$/.test(location.protocol)||!t||/^__/.test(t))return;
var c=d.querySelector('a.crumb'),up=!!c&&/^\.\.\//.test(c.getAttribute('href')||''),cid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,10),sq=0,iv=null,fails=0,gone=false,vc=false;
function o(){return{method:'POST',headers:{'X-Atlas-Token':t,'X-Atlas-Client':cid,'X-Atlas-Seq':String(++sq)},keepalive:true}}
function down(){if(!iv)return;clearInterval(iv);iv=null;var s=d.querySelector('.stale-band');if(s)s.remove();var b=d.createElement('div');b.className='down-band';b.setAttribute('role','alert');b.textContent='サーバが止まっています。atlas.bat を実行し直してください(閲覧はそのままできます)。';d.body.insertBefore(b,d.body.firstChild);d.dispatchEvent(new Event('atlas-down'))}
function fail(now){if(now||++fails>=3)down()}
function ver(r){if(vc)return;vc=true;var mc=d.querySelector('meta[name="atlas-code"]'),v=mc?mc.content:'';if(!v||/^__/.test(v)||r.headers.get('x-atlas-code')===v)return;var b=d.createElement('div');b.className='down-band stale-band';b.setAttribute('role','alert');b.textContent=STALE;d.body.insertBefore(b,d.body.firstChild)}
function beat(){if(!iv||gone)return;try{(up?fetch('../api/heartbeat',o()):fetch('api/heartbeat',o())).then(function(r){if(r.ok){fails=0;ver(r)}else fail(r.status===403)}).catch(function(){fail(false)})}catch(e){fail(false)}}
iv=setInterval(beat,3000);beat();
addEventListener('pagehide',function(){if(!iv||gone)return;gone=true;try{(up?fetch('../api/bye',o()):fetch('api/bye',o())).catch(function(){})}catch(err){}});
addEventListener('pageshow',function(e){if(e.persisted){gone=false;beat()}});
d.addEventListener('visibilitychange',function(){if(d.visibilityState==='visible')beat()});
if(up&&d.getElementById('memo')){['../api/memo-editor.js','../api/session-tools.js'].forEach(function(p){var s=d.createElement('script');s.src=p;d.body.appendChild(s)})}})();
})();