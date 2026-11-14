(function(){var d=document,live=d.getElementById('copy-status');
d.querySelectorAll('button[data-copy-link]').forEach(function(b){var label=b.textContent,timer=0;b.addEventListener('click',function(){
var url=location.href.split('#')[0]+'#'+b.getAttribute('data-copy-link');
function done(ok){live.textContent=ok?'リンクをコピーしました: '+url:'コピーできませんでした。URL: '+url;b.textContent=ok?'コピーしました':'コピーできませんでした';clearTimeout(timer);timer=setTimeout(function(){b.textContent=label},2000)}
function old(){var t=d.createElement('textarea');t.value=url;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';d.body.appendChild(t);t.select();var ok=false;try{ok=d.execCommand('copy')}catch(e){}t.remove();b.focus();done(ok)}
if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(url).then(function(){done(true)},old);else old()})})})();