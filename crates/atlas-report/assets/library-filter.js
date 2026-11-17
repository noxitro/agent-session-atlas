(function(){var d=document,box=d.getElementById('lib-filter'),names={},cur=null;try{names=JSON.parse(d.getElementById('lib-sessions').textContent)}catch(e){}
function el(t,c,x){var e=d.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function filter(){var m=/^#session=([^&]+)/.exec(location.hash),id='';if(m){try{id=decodeURIComponent(m[1])}catch(e){}}if(id===cur)return;cur=id;var ni=0,ns=0;
d.querySelectorAll('.lib-group').forEach(function(sec){var used=[];sec.querySelectorAll('.ver').forEach(function(v){var on=!id||(' '+v.getAttribute('data-sessions')+' ').indexOf(' '+id+' ')>=0;v.hidden=!on;v.open=id?on:v.hasAttribute('data-latest');if(id&&on)used.push(v.getAttribute('data-n'))});
var any=used.length>0,line=sec.querySelector('.in-session');if(line){line.hidden=!id||!any;line.textContent=id&&any?'このセッションで使った版: 版 '+used.join('・'):''}
sec.hidden=!!id&&!any;if(id&&any){if(sec.getAttribute('data-kind')==='skill')ns++;else ni++}
d.querySelectorAll('a[href="#'+sec.id+'"]').forEach(function(a){var li=a.closest('li');if(li)li.hidden=sec.hidden})});
box.textContent='';box.hidden=!id;if(!id)return;var s=names[id];
box.appendChild(d.createTextNode('セッション「'));box.appendChild(el('b',null,s?s[0]:id.slice(0,8)));
box.appendChild(d.createTextNode(ni+ns?'」で使われた指示文 '+ni+' 件・skill '+ns+' 件だけを表示しています(skill は本文が記録に残った呼び出しだけ。使えただけの skill は詳細ページの表にあります)。':'」には、注入された指示文も、本文が記録に残った skill の呼び出しもないため、表示するものがありません(使えただけの skill は詳細ページの表にあります)。'));
var all=el('a',null,'すべて表示');all.href='#';all.addEventListener('click',function(e){e.preventDefault();history.replaceState(null,'',location.pathname+location.search);apply()});box.appendChild(all);
var back=el('a',null,'セッションの詳細に戻る');back.href='sessions/'+(s?s[1]:id.replace(/[^A-Za-z0-9._-]/g,'_')+'.html');box.appendChild(back)}
function jump(){var h=location.hash;if(h.indexOf('#v-')!==0)return;var t=d.getElementById(h.slice(1));if(!t)return;t.open=true;t.scrollIntoView()}
function apply(){filter();jump()}
addEventListener('hashchange',apply);apply()})()