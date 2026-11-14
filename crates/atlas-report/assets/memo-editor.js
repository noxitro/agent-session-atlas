(function(){
var d=document,sec=d.getElementById('memo');if(!sec)return;
var mt=d.querySelector('meta[name="atlas-token"]'),token=mt?mt.content:'',base='../api/memos/'+encodeURIComponent(sec.dataset.session);
var st=d.createElement('style');st.textContent="\n.memo-body{padding:10px 12px;background:var(--surface);border:1px solid var(--rule);overflow-wrap:anywhere;font-size:.875rem;line-height:1.7}\n.memo-body>:first-child{margin-top:0}\n.memo-body>:last-child{margin-bottom:0}\n.memo-body h3,.memo-body h4,.memo-body h5,.memo-body h6{margin:12px 0 4px;font-size:.875rem;line-height:1.5}\n.memo-body h3{font-size:1rem}\n.memo-body img{display:block;max-width:100%;height:auto;margin:8px 0;border:1px solid var(--rule)}\n.memo-body pre{overflow:auto;padding:8px 10px;border:1px solid var(--rule);font-family:var(--mono);font-size:.8125rem}\n.memo-body code{font-family:var(--mono)}\n.memo-body blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--rule-strong);color:var(--ink-2)}\n.memo-body table{border-collapse:collapse}\n.memo-body th,.memo-body td{border:1px solid var(--rule);padding:3px 8px}\n\n.memo-actions{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}\n.memo-actions[hidden]{display:none}\n.memo-empty{margin:0}\n.memo-form textarea{display:block;width:100%;min-height:14em;resize:vertical;font-family:var(--mono);font-size:.875rem;line-height:1.6;color:var(--ink);background:var(--surface);border:1px solid var(--control);border-radius:0;padding:8px 10px}\n.memo-form.drop textarea{border-color:var(--form);background:var(--form-wash)}\n.memo-form .k{display:block;font-size:.6875rem;color:var(--form);margin-bottom:2px}\n.memo-hint{margin:4px 0 0;font-size:.75rem;color:var(--ink-3)}\n.memo-status{margin:6px 0 0;min-height:1.5em;font-size:.8125rem;color:var(--ink-2)}\n.memo-err{margin:6px 0 0;font-size:.8125rem;color:var(--ink);background:var(--warn-wash);border:1px solid var(--warn);padding:4px 8px}\n";d.head.appendChild(st);
var head=sec.querySelector('.section-head'),when=head.querySelector('p');
if(!when){when=d.createElement('p');head.appendChild(when)}
var view=sec.querySelector('.memo-body');
if(!view){view=d.createElement('div');view.className='memo-body';sec.appendChild(view)}
var memo={text:'',rev:'',html:'',updatedAt:null},editing=null,dirty=false,busy=false,uploads=0,down=false,ready=false;
function el(tag,cls,text){var e=d.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function btn(text,fn){var b=el('button','btn',text);b.type='button';b.addEventListener('click',fn);return b}
var empty=el('p','note memo-empty','メモはまだありません。');empty.hidden=true;sec.appendChild(empty);
var problem=el('p','memo-err');problem.setAttribute('role','alert');problem.hidden=true;sec.appendChild(problem);
var actions=el('div','memo-actions'),open=btn('編集',begin);actions.hidden=true;actions.appendChild(open);sec.appendChild(actions);
function stamp(s){if(!s)return '';var t=new Date(s);return isNaN(t)?'':'更新 '+t.toLocaleString('ja-JP')}
function paint(){sec.hidden=false;var has=!!memo.text.trim();view.innerHTML=memo.html;view.hidden=!has||!!editing;empty.hidden=has||!!editing;actions.hidden=!ready||!!editing||down;open.textContent=has?'編集':'メモを書く';when.textContent=has?stamp(memo.updatedAt):''}
function call(path,init){return fetch(base+path,init).then(function(r){return r.json().catch(function(){return{}}).then(function(b){return{ok:r.ok,status:r.status,body:b}})},function(){throw new Error('サーバに接続できません(atlas.bat を実行し直してください)')})}
function load(){return call('',{cache:'no-store'}).then(function(r){if(r.ok&&!editing){memo=r.body;ready=true;paint()}})}
function begin(){
  if(editing||open.disabled)return;
  open.disabled=true;problem.hidden=true;
  call('',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.body.error||('サーバの応答 '+r.status));memo=r.body;start()})
    .catch(function(e){problem.textContent=e.message;problem.hidden=false}).finally(function(){open.disabled=false});
}
function start(){
  var f=el('form','memo-form'),lab=el('label'),ta=el('textarea'),row=el('div','memo-actions'),status=el('p','memo-status'),err=el('p','memo-err'),pick=el('input');
  f.setAttribute('aria-label','メモの編集');lab.appendChild(el('span','k','本文(Markdown)'));ta.value=memo.text;ta.setAttribute('data-testid','memo-text');lab.appendChild(ta);f.appendChild(lab);
  f.appendChild(el('p','memo-hint','Ctrl+S で保存。画像は貼り付けかドロップで追加できます。'));
  status.setAttribute('role','status');err.setAttribute('role','alert');err.id='memo-err';err.hidden=true;
  pick.type='file';pick.accept='image/png,image/jpeg,image/gif,image/webp';pick.multiple=true;pick.hidden=true;
  var save=el('button','btn','保存'),cancel=btn('取消',leave),img=btn('画像を追加',function(){pick.click()}),extra=el('span');
  save.type='submit';row.append(save,cancel,img,extra);f.append(row,pick,status,err);sec.insertBefore(f,actions);
  editing={save:save,img:img};dirty=false;paint();ta.focus();
  function fail(m){err.textContent=m;err.hidden=false;status.textContent='';ta.setAttribute('aria-describedby','memo-err');if(!down)ta.focus()}
  function clearMsg(){err.hidden=true;err.textContent='';status.textContent='';extra.textContent='';ta.removeAttribute('aria-describedby')}
  function ask(msg,ok,fn){clearMsg();status.textContent=msg;var y=btn(ok,function(){extra.textContent='';fn()}),n=btn('やめる',function(){clearMsg();ta.focus()});extra.append(y,' ',n);n.focus()}
  editing.fail=fail;
  function finish(){editing=null;dirty=false;f.remove();paint();open.focus()}
  function reload(){finish();load().catch(function(){})}
  function leave(){if(uploads){fail('画像の追加が終わるまでお待ちください。');return}if(!dirty){reload();return}ask('入力した内容を破棄しますか。','破棄する',reload)}
  function submit(force){
    if(busy||down)return;
    if(uploads){fail('画像の追加が終わってから保存してください。');return}
    if(!ta.value.trim()&&memo.text.trim()&&!force){ask('本文が空なのでメモを削除します(画像は残ります)。','削除する',function(){submit(true)});return}
    busy=true;clearMsg();save.textContent='保存中…';f.setAttribute('aria-busy','true');
    call('',{method:'PUT',headers:{'content-type':'application/json','x-atlas-token':token},body:JSON.stringify({text:ta.value,rev:memo.rev})}).then(function(r){
      if(r.ok){memo=r.body;finish();return}
      if(r.status===409&&r.body.rev!=null){var rev=r.body.rev;fail('別の場所でメモが更新されました。入力はそのまま残しています。');extra.append(btn('上書きして保存',function(){memo.rev=rev;extra.textContent='';submit(true)}));return}
      fail(r.body.error||('サーバの応答 '+r.status));
    }).catch(function(e){fail(e.message)}).finally(function(){busy=false;save.textContent='保存';f.removeAttribute('aria-busy')});
  }
  function insert(md){var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value,before=s>0&&v[s-1]!=='\n'?'\n':'',t=before+md+'\n';ta.value=v.slice(0,s)+t+v.slice(e);ta.selectionStart=ta.selectionEnd=s+t.length;dirty=true}
  function upload(files){
    var list=[].filter.call(files,function(x){return /^image\//.test(x.type)});if(!list.length||down)return false;
    clearMsg();status.textContent='画像を追加しています…';uploads++;
    list.reduce(function(p,file){return p.then(function(){return call('/images',{method:'POST',headers:{'content-type':file.type,'x-atlas-token':token},body:file}).then(function(r){if(!r.ok)throw new Error(r.body.error||('サーバの応答 '+r.status));insert(r.body.markdown)})})},Promise.resolve())
      .then(function(){status.textContent=list.length+' 枚の画像を追加しました。保存すると反映されます。';ta.focus()}).catch(function(e){fail(e.message)}).finally(function(){uploads--});
    return true;
  }
  f.addEventListener('submit',function(e){e.preventDefault();submit()});
  f.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='Enter')){e.preventDefault();submit()}});
  ta.addEventListener('input',function(){dirty=true});
  ta.addEventListener('keydown',function(e){if(e.key==='Escape'&&!dirty)leave()});
  ta.addEventListener('paste',function(e){if(e.clipboardData&&upload(e.clipboardData.files))e.preventDefault()});
  ['dragenter','dragover'].forEach(function(n){f.addEventListener(n,function(e){if(e.dataTransfer&&[].indexOf.call(e.dataTransfer.types,'Files')>=0){e.preventDefault();f.classList.add('drop')}})});
  f.addEventListener('dragleave',function(e){if(!f.contains(e.relatedTarget))f.classList.remove('drop')});
  f.addEventListener('drop',function(e){f.classList.remove('drop');if(e.dataTransfer&&e.dataTransfer.files.length){e.preventDefault();upload(e.dataTransfer.files)}});
  pick.addEventListener('change',function(){upload(pick.files);pick.value=''});
}
addEventListener('beforeunload',function(e){if(editing&&dirty){e.preventDefault();e.returnValue=''}});
d.addEventListener('atlas-down',function(){down=true;if(editing){editing.save.disabled=true;editing.img.disabled=true;editing.fail('サーバが止まっているため保存できません。入力した内容は控えてから atlas.bat を実行し直してください。')}paint()});
load().catch(function(e){problem.textContent=e.message;problem.hidden=false});
})();