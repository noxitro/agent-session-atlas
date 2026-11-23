(function(){
var d=document,sec=d.getElementById('memo'),title=d.querySelector('main .title');if(!sec||!title)return;
var id=sec.dataset.session,mt=d.querySelector('meta[name="atlas-token"]'),token=mt?mt.content:'',H={'x-atlas-token':token};
var st=d.createElement('style');st.textContent="\n.session-ops{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:12px}\n.session-ops[hidden]{display:none}\n.session-ops .btn{display:inline-flex;align-items:center;min-height:30px;text-decoration:none}\n.session-ops .ops-help{flex-basis:100%;margin:0;font-size:.75rem;color:var(--ink-2)}\n.session-ops .ops-status{margin:0;font-size:.8125rem;color:var(--ink-2);min-height:1.5em}\n.session-ops .ops-status a{display:inline-flex;align-items:center;min-height:24px;margin-left:.5em}\n.session-ops .ops-err{flex-basis:100%;margin:2px 0 0;font-size:.8125rem;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch}\n";d.head.appendChild(st);
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
var JH={'x-atlas-token':token,'content-type':'application/json'};
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
// 管理ツールのタスク(表題の下の「タスク」の行。detail.rs の task_row が書く)。この PC の出力を開いた画面だけ、紐づけを手で変える操作を足す
// (読むだけの画面では、送った人の紐づけをそのまま出す)。1 つのセッションに、いくつかのタスクを紐づけられる(上限は MAXT)。
// 変える操作: 今の紐づけ(下書き)を外せる札で並べ、探す欄とタスクの select と「加える」で足し、「保存」で手動の紐づけにする。
// 「どのタスクでもない」(空の並びで保存)・「自動に戻す」は押してすぐ保存する。保存は PUT api/tasks/links/<id>。答え(GET api/tasks と同じ形)で行を書き直す
(function(){
var row=d.getElementById('task-row');if(!row)return;
var now=row.querySelector('.task-now'),SRC={machine:'機械',llm:'LLM',manual:'手動'};
// 1 つのセッションに紐づけるタスクの上限(crates/atlas-report/src/tasks/links.rs の MAX_TASKS_PER_SESSION と同じ)
var MAXT=10;
var ts=d.createElement('style');ts.textContent="\n.task-row .task-open{min-height:30px;padding:2px 10px}\n.task-edit{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;margin-top:4px;padding-top:8px;border-top:1px dashed var(--rule)}\n.task-edit[hidden]{display:none}\n.task-edit .fld{display:block;min-width:0}\n.task-edit .k{display:block;font-size:.6875rem;color:var(--form);margin-bottom:2px}\n.task-edit .picked{flex-basis:100%;min-width:0}\n.task-edit .chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}\n.task-edit .chips li{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;border:1px solid var(--rule-strong);background:var(--surface);padding:1px 2px 1px 8px}\n.task-edit .chips .lbl{overflow-wrap:anywhere;min-width:0}\n.task-edit .chips .lbl .id{font-family:var(--mono);color:var(--ink-3);margin-left:.25em}\n.task-edit .chips .btn{min-height:26px;padding:0 8px}\n.task-edit .chips .unknown{margin-left:.5em;padding:0 4px;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn)}\n.task-edit .chips li.unknown-chip{border-color:var(--warn)}\n.task-edit .chips-none{margin:0;color:var(--ink-2)}\n.task-edit input,.task-edit select{font:inherit;font-size:.8125rem;color:var(--ink);background:var(--surface);border:1px solid var(--control);border-radius:0;padding:3px 6px;height:30px;max-width:100%}\n.task-edit input{width:16em}\n.task-edit select{width:28em}\n.task-edit input:hover,.task-edit select:hover{border-color:var(--form)}\n.task-edit .acts{display:flex;flex-wrap:wrap;gap:6px}\n.task-edit .acts .btn,.task-edit .add{min-height:30px}\n.task-edit .btn.primary{background:var(--form);color:var(--surface)}\n.task-row .btn[aria-disabled=true]{border-color:var(--rule);color:var(--ink-3);background:var(--surface);cursor:not-allowed}\n.task-edit .task-msg{flex-basis:100%;margin:0;min-height:1.2em;color:var(--ink-2)}\n.task-edit .task-err{flex-basis:100%;margin:0;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch;overflow-wrap:anywhere}\n.task-edit .task-err[hidden]{display:none}\n@media (max-width:720px){.task-edit input,.task-edit select{width:100%}.task-edit .fld{flex:1 1 100%}}\n";d.head.appendChild(ts);
// 紐づけのタスクの並び(前の版の taskId(1 つか null)も読む)
function idsOf(l){return !l?[]:Array.isArray(l.taskIds)?l.taskIds:l.taskId?[l.taskId]:[]}
function itemOf(id){return items.filter(function(x){return x.id===id})[0]||null}
// 工数を数えるタスク(countedTaskIds。無ければ紐づいたタスクすべて)
function countedOf(l){return l&&Array.isArray(l.countedTaskIds)?l.countedTaskIds:idsOf(l)}
// 等分の 1 行(detail.rs の task_split_text と同じ文)。n は紐づいたタスクの数、k は工数を数えるタスクの数
function splitText(n,k){
  if(n<=1&&k===n)return '';
  return (n>1?n+' つのタスクに紐づいています。':'')+(k===0?'実働と推定人手工数は、どのタスクにも数えません':k===1?'実働と推定人手工数は、1 つのタスクにだけ数えます':'実働と推定人手工数は、'+k+' つのタスクで等分して数えます')+(k<n?'(一覧に無いタスクと、完了を確認した後に始めたセッションのタスクには数えません)':'');
}
// 行の中身(detail.rs の task_row の .task-now と同じ書き方)
function taskNow(l){
  now.textContent='';
  var ids=idsOf(l),cnt=countedOf(l);
  if(!ids.length){var v=el('span','task-v');v.setAttribute('data-testid','detail-task-name');v.appendChild(el('span','missing-value',l?'どのタスクでもない':'紐づけなし'));now.appendChild(v)}
  else{
    var ul=el('ul','task-list');now.appendChild(ul);
    ids.forEach(function(id){
      var item=itemOf(id),li=el('li','task-item'),v=el('span','task-v');li.setAttribute('data-testid','detail-task-item');v.setAttribute('data-testid','detail-task-name');
      v.appendChild(d.createTextNode(item&&item.name?item.name:id));var sid=el('span','id','('+id+')');sid.setAttribute('translate','no');v.appendChild(sid);li.appendChild(v);
      if(item){var st=el('span','task-st','状態: '+(item.status||'—')+'('+(item.done?'完了':'未完了')+')');st.setAttribute('data-testid','detail-task-status');li.appendChild(st)}
      if(cnt.indexOf(id)<0){var sk=el('span','task-skip',item?'完了を確認した後に始めたセッション(工数に数えない)':'一覧にないタスク(工数に数えない)');sk.setAttribute('data-testid','detail-task-skip');li.appendChild(sk)}
      ul.appendChild(li);
    });
    var stx=splitText(ids.length,ids.filter(function(x){return cnt.indexOf(x)>=0}).length);
    if(stx){var sp=el('span','task-split',stx);sp.setAttribute('data-testid','detail-task-split');now.appendChild(sp)}
  }
  if(l){var src=el('span','task-src','紐づけ: '+(SRC[l.source]||l.source)+(l.reason?'('+l.reason+')':'')+(typeof l.confidence==='number'?'・確度 '+Math.round(l.confidence*100)+'%':''));src.setAttribute('data-testid','detail-task-source');now.appendChild(src)}
}
var items=[],link=null,draft=[],tDown=false,saving=false;
var open=el('button','btn task-open','変える…');open.type='button';open.setAttribute('aria-expanded','false');open.setAttribute('aria-controls','task-edit');open.setAttribute('data-testid','detail-task-open');
var ed=el('div','task-edit');ed.id='task-edit';ed.hidden=true;ed.setAttribute('data-testid','detail-task-edit');
// 紐づけるタスク(下書き)。札ごとに「外す」
var picked=el('div','picked'),pk=el('span','k');pk.id='task-picked-k';picked.appendChild(pk);
var chips=el('ul','chips');chips.setAttribute('aria-labelledby','task-picked-k');chips.setAttribute('data-testid','detail-task-chips');picked.appendChild(chips);
var chipsNone=el('p','chips-none','まだありません。下で探して加えるか、「どのタスクでもない」を押します。');picked.appendChild(chipsNone);
var fq=el('label','fld'),fs=el('label','fld');fq.appendChild(el('span','k','探す(ID か名前の一部)'));fs.appendChild(el('span','k','加えるタスク'));
var q=el('input');q.type='search';q.name='task-search';q.autocomplete='off';q.spellcheck=false;q.setAttribute('data-testid','detail-task-search');fq.appendChild(q);
var sel=el('select');sel.name='task';sel.setAttribute('data-testid','detail-task-select');fs.appendChild(sel);
var bAdd=el('button','btn add','加える');bAdd.type='button';bAdd.setAttribute('data-testid','detail-task-add');
var acts=el('div','acts'),bSave=el('button','btn primary','保存'),bNone=el('button','btn','どのタスクでもない'),bAuto=el('button','btn','自動に戻す'),bClose=el('button','btn','閉じる');
[bSave,bNone,bAuto,bClose].forEach(function(b){b.type='button';acts.appendChild(b)});
bSave.setAttribute('data-testid','detail-task-save');bNone.setAttribute('data-testid','detail-task-none');bAuto.setAttribute('data-testid','detail-task-auto');
var tmsg=el('p','task-msg');tmsg.setAttribute('role','status');tmsg.setAttribute('data-testid','detail-task-msg');
var terr=el('p','task-err');terr.setAttribute('role','alert');terr.setAttribute('data-testid','detail-task-err');terr.hidden=true;
[picked,fq,fs,bAdd,acts,tmsg,terr].forEach(function(x){ed.appendChild(x)});
function label(t){return (t.name||t.id)+'('+t.id+')'+(t.done?'・完了':'')+(t.missing?'・書き出しに無い':'')}
// 押せないボタンは disabled にせず aria-disabled にする(保存の間も焦点を失わず、Esc で閉じられる。押しても何もしない)
function off(b,v){b.setAttribute('aria-disabled',v?'true':'false')}
function isOff(b){return b.getAttribute('aria-disabled')==='true'}
function same(a,b){return a.length===b.length&&a.every(function(x,i){return x===b[i]})}
// 下書きの札を描き直す。focusAt があれば、その位置の札の「外す」(無ければ探す欄)に焦点を移す
function chipsDraw(focusAt){
  chips.textContent='';pk.textContent='紐づけるタスク('+draft.length+' / '+MAXT+' 件)';
  draft.forEach(function(id,i){
    var known=itemOf(id),t=known||{id:id,name:''},li=el('li'),lb=el('span','lbl',t.name||id),sid=el('span','id','('+id+')'),rm=el('button','btn','外す');
    sid.setAttribute('translate','no');lb.appendChild(sid);li.setAttribute('data-testid','detail-task-chip');
    // タスクの一覧に無い ID(tasks.json に無いもの)は印を付ける。このままでは保存できないので外してもらう
    if(!known){var un=el('span','unknown','一覧にないタスク');un.setAttribute('data-testid','detail-task-unknown');lb.appendChild(un);li.className='unknown-chip'}
    rm.type='button';rm.setAttribute('aria-label',(t.name||id)+'('+id+')を外す');rm.setAttribute('data-testid','detail-task-remove');
    rm.addEventListener('click',function(){if(isOff(rm))return;draft.splice(i,1);tmsg.textContent=(t.name||id)+' を外しました(まだ保存していません)。';chipsDraw(i);fill()});
    li.appendChild(lb);li.appendChild(rm);chips.appendChild(li);
  });
  chipsNone.hidden=draft.length>0;
  if(focusAt!=null){var bs=chips.querySelectorAll('button');(bs[Math.min(focusAt,bs.length-1)]||q).focus()}
}
// 探す文字を含むタスクだけを並べる(下書きにあるものは除く。未完了を先に。多すぎるときは先頭から)。合った数を返す
var MAXOPT=500;
function fill(){
  var k=q.value.trim().toLowerCase(),cur=sel.value,n=0;sel.textContent='';
  var list=items.filter(function(t){return draft.indexOf(t.id)<0&&(!k||t.id.toLowerCase().indexOf(k)>=0||(t.name||'').toLowerCase().indexOf(k)>=0)});
  list.sort(function(a,b){return (a.done===b.done?0:a.done?1:-1)||(a.id<b.id?-1:a.id>b.id?1:0)});
  list.slice(0,MAXOPT).forEach(function(t){var o=el('option',null,label(t));o.value=t.id;if(t.id===cur)o.selected=true;sel.appendChild(o);n++});
  if(!n){var o=el('option',null,k?'合うタスクはありません':'加えられるタスクはありません');o.value='';o.disabled=true;sel.appendChild(o)}
  sync();
  return list.length;
}
// 探す文字を打つたびに絞り、打ち終えたら(少し待ってから)合った数を状態の行で知らせる
var qTimer=null;
function onSearch(){
  var n=fill();clearTimeout(qTimer);
  qTimer=setTimeout(function(){tmsg.textContent=!q.value.trim()?'タスク '+n+' 件。':n>MAXOPT?'合うタスク '+n+' 件のうち先頭の '+MAXOPT+' 件を出しています。探す文字を足して絞ってください。':'合うタスク '+n+' 件。'},400);
}
function sync(){
  var o=saving||tDown,manual=!!link&&link.source==='manual';
  off(bAdd,o||!sel.value||draft.length>=MAXT);
  off(bSave,o||!draft.length||(manual&&same(idsOf(link),draft)));
  off(bNone,o||(manual&&!idsOf(link).length));
  off(bAuto,o||!link||link.source==='machine');
  chips.querySelectorAll('button').forEach(function(b){off(b,o)});
  off(open,tDown);
  if(tDown)open.title='サーバが止まっています。atlas.bat を実行し直してください';else open.removeAttribute('title');
}
function apply(body){
  var t=body&&body.tasks;link=t&&t.links?t.links[row.dataset.session]||null:null;items=t&&t.items?t.items:[];
  draft=idsOf(link).slice();taskNow(link);chipsDraw();
}
function save(payload,done){
  if(saving||tDown)return;saving=true;terr.hidden=true;clearTimeout(qTimer);tmsg.textContent='保存しています…';sync();
  call('tasks/links/'+encodeURIComponent(row.dataset.session),{method:'PUT',headers:JH,body:JSON.stringify(payload)}).then(function(r){
    saving=false;
    if(!r.ok||!r.body){terr.textContent='保存できませんでした('+((r.body&&r.body.error)||('サーバの応答 '+r.status))+')';terr.hidden=false;tmsg.textContent='';sync();return}
    apply(r.body);fill();tmsg.textContent=done+'レポートの画面を開き直すと、一覧とタスクの節に出ます(tasks.csv は次の集計で作り直します)。';
  }).catch(function(e){saving=false;terr.textContent='保存できませんでした('+e.message+')';terr.hidden=false;tmsg.textContent='';sync()});
}
q.addEventListener('input',onSearch);
sel.addEventListener('change',sync);
bAdd.addEventListener('click',function(){
  if(isOff(bAdd)||!sel.value)return;
  var id=sel.value,t=itemOf(id);draft.push(id);chipsDraw();fill();
  tmsg.textContent=(t&&t.name?t.name:id)+' を加えました('+draft.length+' 件。まだ保存していません)。';
});
bSave.addEventListener('click',function(){if(!isOff(bSave)&&draft.length)save({taskIds:draft.slice()},draft.length>1?draft.length+' つのタスクに紐づけました。':'このタスクに紐づけました。')});
bNone.addEventListener('click',function(){if(!isOff(bNone))save({taskIds:[]},'どのタスクでもないことにしました。')});
bAuto.addEventListener('click',function(){if(!isOff(bAuto))save({auto:true},'自動の紐づけに戻しました。')});
// 開くときは、下書きを今の紐づけから始める(閉じる前の、保存していない変更は捨てる)
function setOpen(v){ed.hidden=!v;open.setAttribute('aria-expanded',v?'true':'false');if(v){tmsg.textContent='';terr.hidden=true;draft=idsOf(link).slice();chipsDraw();fill();q.focus()}else open.focus()}
open.addEventListener('click',function(){if(!isOff(open))setOpen(ed.hidden)});
bClose.addEventListener('click',function(){setOpen(false)});
// Esc で閉じる(漢字に変換している途中の Esc では閉じない)
ed.addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();setOpen(false)}});
call('tasks',{headers:H,cache:'no-store'}).then(function(r){
  // 読むだけの画面・古いサーバ・タスクの記録が無いときは、操作を足さない(行は集計したときのまま)
  if(!r.ok||!r.body||r.body.readOnly||!r.body.tasks)return;
  apply(r.body);
  row.insertBefore(open,row.querySelector('.term'));row.appendChild(ed);sync();
}).catch(function(){});
// サーバが止まったら閉じて押せなくする。焦点が中にあれば「変える…」へ移す(body に落とさない)
d.addEventListener('atlas-down',function(){var inside=ed.contains(d.activeElement);tDown=true;ed.hidden=true;open.setAttribute('aria-expanded','false');sync();if(inside)open.focus()});
})();
})();
