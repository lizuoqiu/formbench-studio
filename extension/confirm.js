'use strict';
const id=new URL(location.href).searchParams.get('batch'),statusEl=document.getElementById('status');
const approve=document.getElementById('approve'),cancel=document.getElementById('cancel'),list=document.getElementById('items');
const states={unattempted:'未执行',added:'已观察到加购成功',needs_login:'需要登录',needs_selection:'需要核对规格',not_confirmed:'未确认'};
const call=type=>chrome.runtime.sendMessage({type,requestId:id});
function row(tag,txt){const n=document.createElement(tag);n.textContent=txt;return n;}
function show(r){
  if(!r)throw Error('无法连接扩展。');if(r.state==='error')throw Error(r.message);
  if(r.items){list.replaceChildren(...r.items.map(i=>{
    const li=document.createElement('li');li.append(row('b',i.title),row('p',(i.options.length?i.options.join(' / '):'规格待选')+' × '+i.qty),row('p','商品编号 '+i.id+' · SKU '+(i.skuId||'待选')),row('code','来自工作台：'+i.originalUrl));
    if(i.url!==i.originalUrl)li.append(row('p','实际打开：'+i.url));
    li.append(row('p',''));return li;
  }));}
  for(const x of r.results||[]){const li=list.children[x.index];if(li)li.lastChild.textContent=(states[x.status]||'未确认')+(x.message&&x.status!=='unattempted'?' · '+x.message:'');}
  approve.disabled=cancel.disabled=r.state!=='awaiting_confirmation';statusEl.textContent=r.message||({awaiting_confirmation:'等待你确认；目前没有打开商品或更改购物车。',running:'正在本人浏览器中处理。',cancelled:'已取消。',finished:'处理已结束。'})[r.state]||'请返回工作台查看。';return r;
}
function fail(e){approve.disabled=cancel.disabled=true;statusEl.textContent=e.message||'未收到回执，请到淘宝核对。';}
approve.addEventListener('click',async e=>{
  if(!e.isTrusted||approve.disabled)return;approve.disabled=cancel.disabled=true;
  try{let r=show(await call('FB_EXT_APPROVE'));while(r.state==='running')r=show(await call('FB_EXT_NEXT'));}catch(e){fail(e);}
});
cancel.addEventListener('click',async e=>{if(!e.isTrusted||cancel.disabled)return;approve.disabled=cancel.disabled=true;try{show(await call('FB_EXT_CANCEL'));}catch(e){fail(e);}});
call('FB_EXT_READ').then(r=>{show(r);if(r.state==='running')statusEl.textContent='已有加购任务；页面刷新不会重新发送。请在工作台或淘宝查看结果。';}).catch(fail);
