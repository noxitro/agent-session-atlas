(function(){var d=document,root=d.documentElement,main=d.querySelector('main'),id=main.dataset.session,kind=main.dataset.kind;
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
  var W=matchMedia('(min-width:768px)'),rail=d.querySelector('.rail'),tick=false;
  function mark(){tick=false;if(!secs.length)return;var top=W.matches||!rail?0:rail.offsetHeight,line=top+Math.min(160,innerHeight/3),i=0,k;for(k=0;k<secs.length;k++){if(secs[k].getBoundingClientRect().top<=line)i=k}if(innerHeight+scrollY>=root.scrollHeight-2)i=secs.length-1;for(k=0;k<links.length;k++){if(k===i)links[k].setAttribute('aria-current','true');else links[k].removeAttribute('aria-current')}}
  addEventListener('scroll',function(){if(!tick){tick=true;requestAnimationFrame(mark)}},{passive:true});mark();
  if(location.hash.length>1){var t=d.getElementById(decodeURIComponent(location.hash.slice(1)));if(t)t.scrollIntoView()}
}).catch(function(e){fail(e.message)});
})();