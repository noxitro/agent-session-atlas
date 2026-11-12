// Phase 14: 詳細ページの「記録を読む」「全文を作って読む」(atlas serve のときだけ GET /api/session-tools.js で配る)。
// 静的ページには埋め込まない(file:// と共有用の HTML を 1 行も増やさない。メモの編集の script と同じ作法)。
// 「全文を作って読む」は POST /api/jobs {kind:"full", id} → GET /api/jobs/current を待つ → 終わったら ../view/<id>?kind=full を開く。
// 記録の .md が無いページ(build だけで作ったとき)では「記録を読む」を出さない。
// どちらも別のウィンドウで開き、詳細ページは残す。全文は作り終わるまで待つので、押した時点で空のウィンドウを開いておき
// (押した直後でないとポップアップとして止められる)、できたらそこへ移す。開けなかったとき・再読み込みで続きから待ったときは
// 状態の行に「全文記録を開く」のリンクを出す。
// あわせて、このセッションが入っているグループを GET /api/state から出す(静的ページは作った時点の情報で古くなるので、serve のときだけ)。

const TOOLS_CSS = `
.session-ops{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:12px}
.session-ops[hidden]{display:none}
.session-ops .btn{display:inline-flex;align-items:center;min-height:30px;text-decoration:none}
.session-ops .ops-help{flex-basis:100%;margin:0;font-size:.75rem;color:var(--ink-2)}
.session-ops .ops-status{margin:0;font-size:.8125rem;color:var(--ink-2);min-height:1.5em}
.session-ops .ops-status a{display:inline-flex;align-items:center;min-height:24px;margin-left:.5em}
.ops-groups{margin:10px 0 0;font-size:.8125rem;color:var(--ink-2)}
.ops-groups[hidden]{display:none}
.ops-groups .k{color:var(--form);font-size:.75rem;margin-right:.75em}
.ops-groups .none{color:var(--ink-3)}
.ops-groups{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.ops-groups .tags{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.ops-groups .tag{display:inline-flex;align-items:center;border:1px solid var(--rule);background:var(--form-wash)}
.ops-groups .tag a{padding:2px 6px}
.ops-groups .tag-x{min-width:24px;min-height:24px;border:0;border-left:1px solid var(--rule);background:none;color:var(--ink-2);cursor:pointer;font:inherit}
.ops-groups .tag-x:hover{color:var(--ink)}
.ops-groups .tag-add{display:inline-flex;gap:6px;align-items:center}
.ops-groups .tag-add input{min-height:28px;padding:2px 6px;font:inherit;border:1px solid var(--rule-strong);background:var(--surface);color:var(--ink);width:16em;max-width:60vw}
.ops-groups .tag-msg{flex-basis:100%;margin:0;min-height:1.2em;font-size:.75rem;color:var(--ink-2)}
.session-ops .ops-err{flex-basis:100%;margin:2px 0 0;font-size:.8125rem;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch}
`;

export const SESSION_TOOLS_JS = `(function(){
var d=document,sec=d.getElementById('memo'),title=d.querySelector('main .title');if(!sec||!title)return;
var id=sec.dataset.session,mt=d.querySelector('meta[name="atlas-token"]'),token=mt?mt.content:'',H={'x-atlas-token':token};
var st=d.createElement('style');st.textContent=${JSON.stringify(TOOLS_CSS)};d.head.appendChild(st);
function el(tag,cls,text){var e=d.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
var box=el('div','session-ops');box.setAttribute('role','group');box.setAttribute('aria-label','記録の表示');
var view='../view/'+encodeURIComponent(id);
function label(e,t){e.textContent=t;var m=el('span','ext','↗');m.setAttribute('aria-hidden','true');e.appendChild(m);e.appendChild(el('span','sr-only','(別のウィンドウで開きます)'))}
var md=d.querySelector('.rail-links a[href$=".md"]:not([download]):not([href^="../full/"])');
if(md){var read=el('a','btn');label(read,'記録を読む');read.href=view+'?kind=transcript';read.target='_blank';read.rel='noopener';box.appendChild(read)}
var full=el('button','btn');label(full,'全文を作って読む');full.type='button';full.setAttribute('aria-describedby','ops-status');box.appendChild(full);
// 2 つの記録の違い(初めての人が「記録」と「全文」の違いで迷わないように)
box.appendChild(el('p','ops-help',(md?'記録を読む: 依頼・応答・ツールの経過をまとめたもの。':'')+'全文を作って読む: ログのイベントを省かずに書き出した解析用のもの(初回は作るのに時間がかかります)。'));
var status=el('p','ops-status');status.id='ops-status';status.setAttribute('role','status');box.appendChild(status);
var err=el('p','ops-err');err.setAttribute('role','alert');err.hidden=true;box.appendChild(err);
title.appendChild(box);
// タスクタグ(保存は atlas-notes/groups.json のグループ。atlas serve の最新を出す)。名前を押すとレポートをそのタグで絞り込む。
// ここで付け外しできる: 「×」で外す(タグは 0 件でも残る)、入力して「付ける」(今あるタグなら足し、無ければ新しく作る)
var gl=el('div','ops-groups');gl.setAttribute('data-testid','detail-groups');gl.setAttribute('role','group');gl.setAttribute('aria-label','タスクタグ');gl.hidden=true;title.insertBefore(gl,box);
var JH={'x-atlas-token':token,'content-type':'application/json'},tagBusy=false,tagDown=false,allTags=[];
// ro: 読むだけの画面(別のフォルダを開いたもの)。送った人が付けたタグを出すだけで、外す・付けるは出さない
function drawTags(groups,ro){
  allTags=groups.map(function(g){return g.name});
  var mine=groups.filter(function(g){return Array.isArray(g.ids)&&g.ids.indexOf(id)>=0}).map(function(g){return g.name});
  gl.textContent='';
  gl.appendChild(el('span','k',ro?'タスクタグ(送った人が付けたもの)':'タスクタグ'));
  var ul=el('ul','tags');
  if(!mine.length)ul.appendChild(el('li','none','なし'));
  mine.forEach(function(n){
    var li=el('li','tag'),a=el('a',null,n);a.href='../atlas.html#group='+encodeURIComponent(n);li.appendChild(a);
    if(ro){ul.appendChild(li);return}
    var x=el('button','tag-x','×');x.type='button';x.setAttribute('aria-label','タスクタグ「'+n+'」を外す');x.disabled=tagDown;
    x.addEventListener('click',function(){tagOp(function(){return call('groups/'+encodeURIComponent(n),{method:'PUT',headers:JH,body:JSON.stringify({remove:[id]})})},'「'+n+'」を外しました')});
    li.appendChild(x);ul.appendChild(li);
  });
  gl.appendChild(ul);
  if(ro){gl.hidden=false;return}
  var f=el('form','tag-add'),inp=el('input'),dl=el('datalist'),b=el('button','btn','付ける');
  dl.id='tag-options';allTags.filter(function(n){return mine.indexOf(n)<0}).forEach(function(n){var o=el('option');o.value=n;dl.appendChild(o)});
  inp.type='text';inp.setAttribute('list','tag-options');inp.maxLength=100;inp.placeholder='タグの名前(例: Player-Weapon)';inp.setAttribute('aria-label','付けるタスクタグ');inp.disabled=tagDown;
  b.type='submit';b.disabled=tagDown;
  f.appendChild(inp);f.appendChild(dl);f.appendChild(b);
  f.addEventListener('submit',function(e){
    e.preventDefault();var n=inp.value.trim();if(!n){inp.focus();return}
    if(mine.indexOf(n)>=0){tagMsg('「'+n+'」は付いています');return}
    // 付ける直前に最新のタグの一覧を読み、今あるタグなら足し、無ければ作る(開いた時点の一覧で決めると、別の画面で増えたタグに「既にあります」で付けられない)
    tagOp(function(){return call('state',{headers:H,cache:'no-store'}).then(function(s){var has=!!(s.ok&&s.body&&Array.isArray(s.body.groups)&&s.body.groups.some(function(g){return g.name===n}));return has?call('groups/'+encodeURIComponent(n),{method:'PUT',headers:JH,body:JSON.stringify({add:[id]})}):call('groups',{method:'POST',headers:JH,body:JSON.stringify({name:n,note:'',ids:[id]})})})},'「'+n+'」を付けました');
  });
  gl.appendChild(f);
  var m=el('p','tag-msg');m.setAttribute('role','status');gl.appendChild(m);
  gl.hidden=false;
}
function tagMsg(t){var m=gl.querySelector('.tag-msg');if(m)m.textContent=t}
function tagOp(run,done){
  if(tagBusy||tagDown)return;tagBusy=true;err.hidden=true;
  run().then(function(r){
    if(!r.ok||!r.body||!Array.isArray(r.body.groups))throw new Error((r.body&&r.body.error)||('サーバの応答 '+r.status));
    drawTags(r.body.groups);tagMsg(done);
    // 描き直すと押したボタンが消えるので、焦点はタグの入力欄へ
    var t=gl.querySelector('.tag-add input');if(t)t.focus();
  }).catch(function(e){err.textContent='タスクタグを変えられませんでした('+e.message+')';err.hidden=false}).then(function(){tagBusy=false});
}
d.addEventListener('atlas-down',function(){tagDown=true;gl.querySelectorAll('button,input').forEach(function(x){x.disabled=true})});
call('state',{headers:H,cache:'no-store'}).then(function(r){
  if(!r.ok||!r.body||!Array.isArray(r.body.groups))return;
  drawTags(r.body.groups,r.body.readOnly===true);
}).catch(function(){});
var busy=false,down=false,t0=0,win=null,fullUrl=new URL(view+'?kind=full',location.href).href;
function shut(){if(win&&!win.closed){try{win.close()}catch(e){}}win=null}
function reset(){busy=false;full.disabled=down;label(full,'全文を作って読む')}
function fail(m){shut();err.textContent=m;err.hidden=false;status.textContent='';reset()}
function opened(){
  reset();status.textContent='';
  if(win&&!win.closed){try{win.opener=null}catch(e){}win.location.replace(fullUrl);win=null;status.appendChild(d.createTextNode('全文記録を別のウィンドウに開きました。'))}
  var a=el('a');label(a,'全文記録を開く');a.href=fullUrl;a.target='_blank';a.rel='noopener';status.appendChild(a);
}
function call(path,init){return fetch('../api/'+path,init).then(function(r){return r.json().catch(function(){return null}).then(function(b){return{ok:r.ok,status:r.status,body:b}})},function(){throw new Error('サーバに接続できません(atlas.bat を実行し直してください)')})}
function sec2(){return Math.max(0,Math.round((Date.now()-t0)/1000))}
function wait(jobId){
  call('jobs/current',{headers:H,cache:'no-store'}).then(function(r){
    var j=r.body;if(!r.ok)throw new Error((j&&j.error)||('サーバの応答 '+r.status));
    if(!j||j.id!==jobId)throw new Error('全文記録の作成の状態が分からなくなりました。もう一度押してください。');
    if(j.state==='running'){status.textContent='全文記録を作っています(経過 '+sec2()+' 秒)…';setTimeout(function(){wait(jobId)},700);return}
    if(j.state==='done'){opened();return}
    var last=(j.log||[]).slice(-1)[0]||'';
    fail(j.state==='canceled'?'全文記録の作成は止められました。':'全文記録を作れませんでした'+(last?': '+last:'。'));
  }).catch(function(e){fail(e.message)});
}
full.addEventListener('click',function(){
  if(busy||down)return;busy=true;err.hidden=true;full.disabled=true;full.textContent='作成中…';t0=Date.now();status.textContent='全文記録を作っています…';
  shut();try{win=window.open('','_blank')}catch(e){win=null}
  if(win){try{win.document.title='全文記録を作っています';win.document.body.style.cssText='font:14px/1.6 system-ui,sans-serif;margin:24px;color:#555';win.document.body.textContent='全文記録を作っています。できたらこのウィンドウに表示します…'}catch(e){}}
  call('jobs',{method:'POST',headers:{'content-type':'application/json','x-atlas-token':token},body:JSON.stringify({kind:'full',id:id})}).then(function(r){
    if(r.ok&&r.body){wait(r.body.id);return}
    fail(r.status===409?'ほかの処理(集計し直す・判定)が動いているので、終わってから押してください。':((r.body&&r.body.error)||('サーバの応答 '+r.status)));
  }).catch(function(e){fail(e.message)});
});
// 開いたときに同じセッションの全文を作っている最中なら、続きから待つ(再読み込みしたとき)
call('jobs/current',{headers:H,cache:'no-store'}).then(function(r){var j=r.body;if(r.ok&&j&&j.state==='running'&&j.kind==='full'&&j.target&&j.target.id===id&&!busy){busy=true;full.disabled=true;full.textContent='作成中…';t0=Date.parse(j.startedAt)||Date.now();wait(j.id)}}).catch(function(){});
d.addEventListener('atlas-down',function(){down=true;full.disabled=true;box.hidden=true});
})();`;
