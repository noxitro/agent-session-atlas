(function(){
var d=document,sec=d.getElementById('memo'),title=d.querySelector('main .title');if(!sec||!title)return;
var id=sec.dataset.session,mt=d.querySelector('meta[name="atlas-token"]'),token=mt?mt.content:'',H={'x-atlas-token':token};
var st=d.createElement('style');st.textContent="\n.session-ops{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:12px}\n.session-ops[hidden]{display:none}\n.session-ops .btn{display:inline-flex;align-items:center;min-height:30px;text-decoration:none}\n.session-ops .ops-help{flex-basis:100%;margin:0;font-size:.75rem;color:var(--ink-2)}\n.session-ops .ops-status{margin:0;font-size:.8125rem;color:var(--ink-2);min-height:1.5em}\n.session-ops .ops-status a{display:inline-flex;align-items:center;min-height:24px;margin-left:.5em}\n.session-ops .ops-err{flex-basis:100%;margin:2px 0 0;font-size:.8125rem;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch}\n.ops-judge{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 0 0;font-size:.8125rem;color:var(--ink-2)}\n.ops-judge .k{color:var(--form);font-size:.75rem;margin-right:.75em}\n.ops-judge .btn{display:inline-flex;align-items:center;min-height:30px}\n.ops-judge .judge-note,.ops-judge .judge-log{flex-basis:100%;margin:0;font-size:.75rem;color:var(--ink-2);overflow-wrap:anywhere}\n.ops-judge .judge-msg{flex-basis:100%;margin:0;min-height:1.2em}\n.ops-judge .judge-err{flex-basis:100%;margin:2px 0 0;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch;overflow-wrap:anywhere}\n.ops-judge[hidden],.ops-judge [hidden]{display:none}\n";d.head.appendChild(st);
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
// LLM 判定(このセッションだけ)。判定したかどうかは上の札(「LLM 判定」。detail.rs が書く)に出し、ここは判定を始めるボタンと進み具合を出す。
// 判定は AI クレジット(BYOK なら API の利用料)を使うので、押したら件数・モデル・費用を確かめてから始める。
// 終わっても自動では読み直さない(メモの入力中などを守る)。「読み込み直す」で、作り直したページを出す
var jg=el('div','ops-judge');jg.setAttribute('data-testid','detail-judge');jg.setAttribute('role','group');jg.setAttribute('aria-label','LLM 判定');jg.hidden=true;title.insertBefore(jg,box);
var jBusy=false,jDown=false,jPick=false,jt0=0,pv=null,pt=null;
// 依頼ごとの判定で 1 回にまとめる依頼の数は、サーバが judge-preview の chunk で返す(返さない古いサーバのときだけ 6)
function jchunk(p){return p.chunk>0?p.chunk:6}
var je=el('button','btn'),jt=el('button','btn'),jc=el('button','btn','止める'),jr=el('button','btn','読み込み直す'),jnote=el('p','judge-note'),jmsg=el('p','judge-msg'),jlog=el('p','judge-log'),jerr=el('p','judge-err');
je.type=jt.type=jc.type=jr.type='button';je.setAttribute('data-testid','detail-judge-effort');jt.setAttribute('data-testid','detail-judge-turns');jc.setAttribute('data-testid','detail-judge-cancel');jr.setAttribute('data-testid','detail-judge-reload');
jnote.id='judge-note';jmsg.setAttribute('role','status');jerr.setAttribute('role','alert');jc.hidden=jr.hidden=jerr.hidden=true;
[el('span','k','LLM 判定'),je,jt,jc,jnote,jmsg,jr,jlog,jerr].forEach(function(x){jg.appendChild(x)});
function jname(kind){return kind==='turn-judge'?'依頼ごとの判定':'工数の判定'}
function jsec(){return Math.max(0,Math.round((Date.now()-jt0)/1000))}
function jq(turns){return call('jobs/judge-preview?session='+encodeURIComponent(id)+(turns?'&target=turns':''),{headers:H,cache:'no-store'})}
// 押せないときは、その理由を下に書く(色だけで伝えない)
function syncJudge(){
  var off=jBusy||jDown||jPick,why=[];
  je.textContent=pv.judged>0?'工数を判定し直す':'工数を判定する';
  je.disabled=off||!(pv.eligible>0);
  if(!(pv.eligible>0))why.push('工数: 依頼の記録が無いので判定できません。');
  jt.hidden=!pt;
  if(pt){
    jt.textContent=pt.pending>0?'依頼ごとに判定する(未判定 '+pt.pending+' 件)':'依頼ごとに判定する';
    jt.disabled=off||!(pt.pending>0);
    if(!(pt.eligible>0))why.push(pt.withoutTurns>0?'依頼ごと: 依頼ごとの記録がありません(古い集計)。レポートの画面で「集計し直す」を押すと判定できます。':'依頼ごと: 依頼ごとの記録が無いので判定できません。');
    else if(!(pt.pending>0))why.push('依頼ごと: '+pt.judged+' 件とも判定済みです。');
  }
  jnote.textContent=why.join(' ');jnote.hidden=!why.length;
  [je,jt].forEach(function(b){if(b.disabled&&why.length)b.setAttribute('aria-describedby','judge-note');else b.removeAttribute('aria-describedby')});
  jc.hidden=!jBusy||jDown;
}
// strict: 数えられなければ(押した後に数え直すとき)理由を添えて失敗にする。turns: 押したのが依頼ごとのボタンなら、依頼ごとの件数も読めないと失敗
function loadJudge(strict,turns){
  return Promise.all([jq(false),jq(true)]).then(function(rs){
    var bad=function(r){return !r.ok||!r.body},why=function(r){return new Error((r.body&&r.body.error)||('サーバの応答 '+r.status))};
    // セッションが sessions.json に無い(古いページ)などで数えられなければ、判定のボタンは出さない
    if(bad(rs[0])){if(strict)throw why(rs[0]);return false}
    // 依頼ごとの件数だけ読めなかったのを「判定できる依頼が無くなっていた」としない
    if(strict&&turns&&bad(rs[1]))throw why(rs[1]);
    pv=rs[0].body;pt=rs[1].ok&&rs[1].body?rs[1].body:null;syncJudge();jg.hidden=false;return true;
  });
}
function jcost(p){
  return 'モデル: '+(p.model?p.model+(p.byok?'(自分の API キー・BYOK)':''):'Copilot の既定のモデル(atlas.config.json の judgeModel が未設定)')+'\n'
    +(p.byok?'API の利用料がかかります(自分の API キーのモデルで判定するので、GitHub Copilot の AI クレジットは使いません)。':'GitHub Copilot の AI クレジットを消費します。')
    +(p.modelError?'\n設定ファイルを読めませんでした: '+p.modelError:'');
}
function jstart(kind,since,focus){
  jBusy=true;jt0=since||Date.now();jerr.hidden=true;jr.hidden=true;jlog.textContent='';jmsg.textContent=jname(kind)+'を始めています…';syncJudge();
  if(focus&&!jc.hidden)jc.focus();
}
function jfail(m){jBusy=false;jerr.textContent=m;jerr.hidden=false;jmsg.textContent='';jlog.textContent='';syncJudge()}
function jdone(kind){
  jBusy=false;jlog.textContent='';jmsg.textContent=jname(kind)+'が終わり、レポートを作り直しました。読み込み直すと、上の「LLM 判定」の札と表に出ます。';jr.hidden=false;syncJudge();
  loadJudge().catch(function(){});
}
// 進み具合を確かめられない(通信の失敗・サーバの 5xx)ときは、間隔を空けてやり直す。判定は裏で続いているので、
// 1 回の失敗では諦めない(諦めると「止める」が消え、判定のボタンをまた押せてしまう)。続けて JRETRY 回失敗したときだけ諦める
var JRETRY=10;
function jretry(jobId,miss,why){
  if(miss>JRETRY){jfail('判定の進み具合を確かめられません('+why+')。判定は続いているかもしれないので、レポートの画面で確かめてください。');return}
  jmsg.textContent='サーバの応答を待っています…(進み具合を確かめられませんでした。やり直し '+miss+' 回目)';
  setTimeout(function(){jwait(jobId,miss)},Math.min(5000,700*miss));
}
function jwait(jobId,miss){
  miss=miss||0;
  // サーバが止まった(atlas-down)ら、もう答えないので待つのをやめる
  if(jDown){jfail('サーバが止まったので、判定の進み具合を確かめられません。atlas.bat を実行し直して、レポートの画面で確かめてください。');return}
  call('jobs/current',{headers:H,cache:'no-store'}).then(function(r){
    var j=r.body;
    if(r.status>=500){jretry(jobId,miss+1,(j&&j.error)||('サーバの応答 '+r.status));return}
    if(!r.ok)throw new Error((j&&j.error)||('サーバの応答 '+r.status));
    if(!j||j.id!==jobId)throw new Error('判定の状態が分からなくなりました。レポートの画面で確かめてください。');
    var last=(j.log||[]).slice(-1)[0]||'';
    if(j.state==='running'){jmsg.textContent=jname(j.kind)+'をしています(経過 '+jsec()+' 秒)…';jlog.textContent=last;setTimeout(function(){jwait(jobId)},700);return}
    if(j.state==='done'){jdone(j.kind);return}
    jfail(j.state==='canceled'?'判定を止めました。判定できた分は保存されていて、次の「集計し直す」でレポートに出ます。':jname(j.kind)+'ができませんでした'+(last?': '+last:'。'));
  },function(e){jretry(jobId,miss+1,e.message)}).catch(function(e){jfail(e.message)});
}
// 押したら件数を数え直してから確かめる(ページを開いた後に、ほかの所で判定されているかもしれない。古い件数のままだと
// 判定し直す(force)を付けずに送り、0 件で終わって「終わり」と出てしまう)。数え直す間はボタンを押せない(二重押しを防ぐ)
function runJudge(turns){
  if(jBusy||jDown||jPick||!pv)return;
  // 前の判定の「読み込み直す」とその知らせは、判定を始めるとき(jstart)まで残す(確かめで取りやめたとき・対象が無いときに消えないように)
  var prev=jmsg.textContent;
  jPick=true;jerr.hidden=true;jmsg.textContent='判定の件数を数え直しています…';syncJudge();
  loadJudge(true,turns).then(function(){
    jPick=false;jmsg.textContent=prev;syncJudge();
    askJudge(turns);
  },function(e){
    jPick=false;jmsg.textContent=prev;jerr.textContent='判定の件数を数え直せませんでした('+e.message+')。もう一度押してください。';jerr.hidden=false;syncJudge();
  });
}
function askJudge(turns){
  var p=turns?pt:pv;if(jBusy||jDown)return;
  // 数え直したら、押したボタンの対象が無くなっていた
  if(turns&&!(p&&p.pending>0)){jmsg.textContent=p&&p.eligible>0?'依頼ごと: '+p.judged+' 件とも判定済みになっていたので、判定しませんでした。':'依頼ごと: 判定できる依頼が無くなっていたので、判定しませんでした。';return}
  if(!turns&&!(p.eligible>0)){jmsg.textContent='工数: 依頼の記録が無くなっていたので、判定しませんでした。';return}
  var again=!turns&&pv.judged>0;
  var what=turns?'このセッションの未判定の依頼 '+p.pending+' 件を LLM で判定します(約 '+Math.ceil(p.pending/jchunk(p))+' 回以上の判定。判定済みの '+p.judged+' 件は判定し直しません)。'
    :again?'このセッションの工数を LLM で判定し直します(前の判定は置き換わります)。':'このセッションの工数(推定人手工数と、成果の質・手戻り)を LLM で判定します。';
  if(!window.confirm(what+'\n\n'+jcost(p)+'\n\n判定のあと、レポートを作り直します(数分かかることがあります)。'))return;
  var kind=turns?'turn-judge':'judge',body=turns?{kind:kind,limit:Math.max(1,Math.min(5000,p.pending)),session:id}:{kind:kind,limit:1,session:id};
  if(again)body.force=true;
  jstart(kind,0,true);
  call('jobs',{method:'POST',headers:JH,body:JSON.stringify(body)}).then(function(r){
    if(r.ok&&r.body){jwait(r.body.id);return}
    jfail(r.status===409?'ほかの処理(集計し直す・判定)が動いているので、終わってから押してください。':((r.body&&r.body.error)||('サーバの応答 '+r.status)));
  }).catch(function(e){jfail(e.message)});
}
je.addEventListener('click',function(){runJudge(false)});
jt.addEventListener('click',function(){runJudge(true)});
jr.addEventListener('click',function(){location.reload()});
jc.addEventListener('click',function(){
  jc.disabled=true;
  call('jobs/current/cancel',{method:'POST',headers:H}).then(function(r){if(!r.ok)throw new Error((r.body&&r.body.error)||('サーバの応答 '+r.status))})
    .catch(function(e){jerr.textContent='止められませんでした('+e.message+')';jerr.hidden=false}).then(function(){jc.disabled=false});
});
d.addEventListener('atlas-down',function(){jDown=true;if(pv)syncJudge()});
// 開いたときにこのセッションの判定が動いている最中なら、続きから待つ(再読み込みしたとき)
loadJudge().then(function(ok){
  if(!ok)return;
  return call('jobs/current',{headers:H,cache:'no-store'}).then(function(r){var j=r.body;if(r.ok&&j&&j.state==='running'&&(j.kind==='judge'||j.kind==='turn-judge')&&j.target&&j.target.session===id&&!jBusy){jstart(j.kind,Date.parse(j.startedAt),false);jwait(j.id)}});
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
// 管理ツールのタスク(表題の下の「タスク」の行。detail.rs の task_row が書く)。この PC の出力を開いた画面だけ、紐づけを手で変える操作を足す
// (読むだけの画面では、送った人の紐づけをそのまま出す)。保存は PUT api/tasks/links/<id>。答え(GET api/tasks と同じ形)で行を書き直す
(function(){
var row=d.getElementById('task-row');if(!row)return;
var now=row.querySelector('.task-now'),SRC={machine:'機械',llm:'LLM',manual:'手動'};
var ts=d.createElement('style');ts.textContent="\n.task-row .task-open{min-height:28px;padding:2px 10px}\n.task-edit{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;margin-top:4px;padding-top:8px;border-top:1px dashed var(--rule)}\n.task-edit[hidden]{display:none}\n.task-edit .fld{display:block;min-width:0}\n.task-edit .fld .k{display:block;font-size:.6875rem;color:var(--form);margin-bottom:2px}\n.task-edit input,.task-edit select{font:inherit;font-size:.8125rem;color:var(--ink);background:var(--surface);border:1px solid var(--control);border-radius:0;padding:3px 6px;height:30px;max-width:100%}\n.task-edit input{width:16em}\n.task-edit select{width:28em}\n.task-edit input:hover,.task-edit select:hover{border-color:var(--form)}\n.task-edit .acts{display:flex;flex-wrap:wrap;gap:6px}\n.task-edit .acts .btn{min-height:30px}\n.task-edit .btn.primary{background:var(--form);color:var(--surface)}\n.task-edit .btn.primary:disabled{background:var(--surface);color:var(--ink-3)}\n.task-edit .task-msg{flex-basis:100%;margin:0;min-height:1.2em;color:var(--ink-2)}\n.task-edit .task-err{flex-basis:100%;margin:0;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px;max-width:75ch;overflow-wrap:anywhere}\n.task-edit .task-err[hidden]{display:none}\n@media (max-width:720px){.task-edit input,.task-edit select{width:100%}.task-edit .fld{flex:1 1 100%}}\n";d.head.appendChild(ts);
// 行の中身(detail.rs の task_row の .task-now と同じ書き方)
function taskNow(l,item){
  now.textContent='';
  var v=el('span','task-v');v.setAttribute('data-testid','detail-task-name');now.appendChild(v);
  if(!l||!l.taskId){v.appendChild(el('span','missing-value',l?'どのタスクでもない':'紐づけなし'))}
  else{
    v.appendChild(d.createTextNode(item&&item.name?item.name:l.taskId));v.appendChild(el('span','id','('+l.taskId+')'));
    if(item){var st=el('span','task-st','状態: '+(item.status||'—')+'('+(item.done?'完了':'未完了')+')');st.setAttribute('data-testid','detail-task-status');now.appendChild(st)}
  }
  if(l){var src=el('span','task-src','紐づけ: '+(SRC[l.source]||l.source)+(l.reason?'('+l.reason+')':'')+(typeof l.confidence==='number'?'・確度 '+Math.round(l.confidence*100)+'%':''));src.setAttribute('data-testid','detail-task-source');now.appendChild(src)}
}
var items=[],link=null,tDown=false,saving=false;
var open=el('button','btn task-open','変える…');open.type='button';open.setAttribute('aria-expanded','false');open.setAttribute('aria-controls','task-edit');open.setAttribute('data-testid','detail-task-open');
var ed=el('div','task-edit');ed.id='task-edit';ed.hidden=true;ed.setAttribute('data-testid','detail-task-edit');
var fq=el('label','fld'),fs=el('label','fld');fq.appendChild(el('span','k','探す(ID か名前の一部)'));fs.appendChild(el('span','k','タスク'));
var q=el('input');q.type='search';q.autocomplete='off';q.spellcheck=false;q.setAttribute('data-testid','detail-task-search');fq.appendChild(q);
var sel=el('select');sel.setAttribute('data-testid','detail-task-select');fs.appendChild(sel);
var acts=el('div','acts'),bSet=el('button','btn primary','このタスクにする'),bNone=el('button','btn','どのタスクでもない'),bAuto=el('button','btn','自動に戻す'),bClose=el('button','btn','閉じる');
[bSet,bNone,bAuto,bClose].forEach(function(b){b.type='button';acts.appendChild(b)});
bSet.setAttribute('data-testid','detail-task-set');bNone.setAttribute('data-testid','detail-task-none');bAuto.setAttribute('data-testid','detail-task-auto');
var tmsg=el('p','task-msg');tmsg.setAttribute('role','status');tmsg.setAttribute('data-testid','detail-task-msg');
var terr=el('p','task-err');terr.setAttribute('role','alert');terr.hidden=true;
[fq,fs,acts,tmsg,terr].forEach(function(x){ed.appendChild(x)});
function label(t){return (t.name||t.id)+'('+t.id+')'+(t.done?'・完了':'')+(t.missing?'・書き出しに無い':'')}
// 探す文字を含むタスクだけを並べる(未完了を先に。多すぎるときは先頭から)
var MAXOPT=500;
function fill(){
  var k=q.value.trim().toLowerCase(),cur=sel.value||(link&&link.taskId)||'',n=0;sel.textContent='';
  var list=items.filter(function(t){return !k||t.id.toLowerCase().indexOf(k)>=0||(t.name||'').toLowerCase().indexOf(k)>=0});
  list.sort(function(a,b){return (a.done===b.done?0:a.done?1:-1)||(a.id<b.id?-1:a.id>b.id?1:0)});
  list.slice(0,MAXOPT).forEach(function(t){var o=el('option',null,label(t));o.value=t.id;if(t.id===cur)o.selected=true;sel.appendChild(o);n++});
  if(!n){var o=el('option',null,k?'合うタスクはありません':'タスクがありません');o.value='';o.disabled=true;sel.appendChild(o)}
  if(list.length>MAXOPT)tmsg.textContent='合うタスク '+list.length+' 件のうち先頭の '+MAXOPT+' 件を出しています。探す文字を足して絞ってください。';
  sync();
}
function sync(){
  var off=saving||tDown;
  bSet.disabled=off||!sel.value||(!!link&&link.source==='manual'&&link.taskId===sel.value);
  bNone.disabled=off||(!!link&&link.source==='manual'&&link.taskId==null);
  bAuto.disabled=off||!link||link.source==='machine';
  open.disabled=tDown;
}
function apply(body){
  var t=body&&body.tasks;link=t&&t.links?t.links[row.dataset.session]||null:null;items=t&&t.items?t.items:[];
  var item=link&&link.taskId?items.filter(function(x){return x.id===link.taskId})[0]:null;taskNow(link,item);
}
function save(payload,done){
  if(saving||tDown)return;saving=true;terr.hidden=true;tmsg.textContent='保存しています…';sync();
  call('tasks/links/'+encodeURIComponent(row.dataset.session),{method:'PUT',headers:JH,body:JSON.stringify(payload)}).then(function(r){
    saving=false;
    if(!r.ok||!r.body){terr.textContent='保存できませんでした('+((r.body&&r.body.error)||('サーバの応答 '+r.status))+')';terr.hidden=false;tmsg.textContent='';sync();return}
    apply(r.body);fill();tmsg.textContent=done+'レポートの画面を開き直すと、一覧とタスクの節に出ます(tasks.csv は次の集計で作り直します)。';
  }).catch(function(e){saving=false;terr.textContent='保存できませんでした('+e.message+')';terr.hidden=false;tmsg.textContent='';sync()});
}
q.addEventListener('input',fill);
sel.addEventListener('change',sync);
bSet.addEventListener('click',function(){if(sel.value)save({taskId:sel.value},'このタスクに紐づけました。')});
bNone.addEventListener('click',function(){save({taskId:null},'どのタスクでもないことにしました。')});
bAuto.addEventListener('click',function(){save({auto:true},'自動の紐づけに戻しました。')});
function setOpen(v){ed.hidden=!v;open.setAttribute('aria-expanded',v?'true':'false');if(v){tmsg.textContent='';terr.hidden=true;fill();q.focus()}else open.focus()}
open.addEventListener('click',function(){setOpen(ed.hidden)});
bClose.addEventListener('click',function(){setOpen(false)});
ed.addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.isComposing){e.preventDefault();setOpen(false)}});
call('tasks',{headers:H,cache:'no-store'}).then(function(r){
  // 読むだけの画面・古いサーバ・タスクの記録が無いときは、操作を足さない(行は集計したときのまま)
  if(!r.ok||!r.body||r.body.readOnly||!r.body.tasks)return;
  apply(r.body);
  row.insertBefore(open,row.querySelector('.term'));row.appendChild(ed);sync();
}).catch(function(){});
d.addEventListener('atlas-down',function(){tDown=true;ed.hidden=true;open.hidden=true;sync()});
})();
})();