import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const code=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const id=randomUUID(), item={title:'红色按钮',url:'https://item.taobao.com/item.htm?id=417&skuId=83&utm_source=test',skuId:'83',qty:2,options:['红色']},second={...item,skuId:'84',url:item.url.replace('83','84')};
const studio={url:'https://lizuoqiu.github.io/formbench-studio/',tab:{id:3,windowId:9},id:'ext',frameId:0,documentId:'doc1'};
function harness(replies=[],cartReads){
  const nread=new Map();
  const created=[],sent=[],captured=[],forwarded=[],focused=[],storage={},map=new Map(),handlers=[],remove=[];
  let action;
  const chrome={action:{onClicked:{addListener:fn=>action=fn}},
    storage:{session:{get:async k=>structuredClone({[k]:storage[k]}),set:async obj=>Object.assign(storage,structuredClone(obj))}},
    runtime:{id:'ext',getURL:s=>'chrome-extension://ext/'+s,onMessage:{addListener:fn=>handlers.push(fn)}},
    tabs:{onRemoved:{addListener:fn=>remove.push(fn)},create:async p=>{const t={...p,id:10+created.length,status:'complete'};created.push(t);map.set(t.id,t);return t;},get:async i=>map.get(i),
      remove:async i=>{map.delete(i);},update:async i=>{focused.push(i);},sendMessage:async(i,m,opt)=>{
        if(m.type==='FB_CART_READ_LINE'){const n=nread.get(m.skuId)||0;nread.set(m.skuId,n+1);return {known:true,id:m.id,skuId:m.skuId,qty:cartReads?cartReads[n]:n*item.qty};}
        if(m.type==='FORMBENCH_ADD_LINE'){sent.push(m.line);return await (replies.shift()||{status:'not_confirmed',message:'无回执'});}
        if(m.type==='FORMBENCH_CAPTURE_LINE'){captured.push(i);return await replies.shift();}
        if(m.type==='FB_PICK_RESULT'){forwarded.push({i,m,opt});}
      }}};
  vm.runInNewContext(code,{chrome,crypto:{randomUUID},URL,Date,setTimeout,clearTimeout});
  const msg=(type,from,extra={})=> new Promise(resolve=>handlers.forEach(fn=>fn({type,requestId:id,...extra},from,resolve)));
  const confirmation=()=>({...studio,tab:{...studio.tab,id:created[0].id},url:created[0].url});
  const capture=async t=>{action(t); for(let k=0;k<4;k++)await new Promise(r=>setImmediate(r));};
  return {msg,created,sent,captured,forwarded,focused,storage,capture,confirmation,removed:()=>remove};

}
test('only allowed top-level document may open review; requests are idempotent; a studio page cannot approve',async()=>{
  const h=harness();for(const bad of [{...studio,url:studio.url+'other/'},{...studio,frameId:1},{...studio,url:'http://localhost:4174/'}])assert.equal((await h.msg('FB_CART_PREPARE',bad,{items:[item]})).state,'error');
  const [a,b]=await Promise.all([1,2].map(()=>h.msg('FB_CART_PREPARE',studio,{items:[item]})));assert.equal(a.state,'awaiting_confirmation');assert.equal(b.state,a.state);assert.equal(h.created.length,1);
  assert.equal((await h.msg('FB_EXT_APPROVE',studio)).state,'error');assert.equal((await h.msg('FB_EXT_NEXT',h.confirmation())).state,'awaiting_confirmation');
  const view=await h.msg('FB_EXT_READ',h.confirmation());assert.equal(view.items[0].originalUrl,item.url);assert(!view.items[0].url.includes('utm_source'));assert.equal((await h.msg('FB_EXT_CANCEL',h.confirmation())).state,'cancelled');assert.equal(h.sent.length,0);
});
test('invalid host, conflicting SKU, duplicate lines and changed document rejected',async()=>{
 const h=harness();for(const items of [[item,item],[{...item,url:'https://u@item.taobao.com/item.htm?id=417'}],[{...item,url:'https://example.org/item.htm?id=417'}],[{...item,skuId:'55'}]])assert.equal((await h.msg('FB_CART_PREPARE',studio,{items})).state,'error');
 assert.equal(h.created.length,0);await h.msg('FB_CART_PREPARE',studio,{items:[item]});assert.equal((await h.msg('FB_CART_STATUS',{...studio,documentId:'other'})).state,'error');
});
test('receipt and manual remainder returned; a concurrent next never resends a row',async()=>{
 let finish;const h=harness([new Promise(r=>finish=r),{status:'not_confirmed',message:'无回执'}]);await h.msg('FB_CART_PREPARE',studio,{items:[item,second,{...item,url:'https://item.taobao.com/item.htm?id=333',skuId:null,options:[]}]});const c=h.confirmation();await h.msg('FB_EXT_APPROVE',c);
 const inflight=h.msg('FB_EXT_NEXT',c);while(!h.sent.length)await new Promise(r=>setImmediate(r));const duplicate=await h.msg('FB_EXT_NEXT',c);assert.equal(duplicate.state,'running');finish({status:'added',message:'已加入购物车'});assert.equal((await inflight).results[0].status,'added');const final=await h.msg('FB_EXT_NEXT',c);assert.equal(final.state,'finished');assert.deepEqual(Array.from(final.results,x=>x.status),['added','not_confirmed','unattempted']);await h.msg('FB_EXT_NEXT',c);assert.equal(h.sent.length,2);
});
test('unspecified options or SKU leave official tab open, send no add request',async()=>{
 for(const incomplete of [{...item,options:[]},{...item,skuId:null,url:'https://item.taobao.com/item.htm?id=417'}]){
 const h=harness();await h.msg('FB_CART_PREPARE',studio,{items:[incomplete]});const c=h.confirmation();await h.msg('FB_EXT_APPROVE',c);const final=await h.msg('FB_EXT_NEXT',c);assert.equal(final.results[0].status,'needs_selection');assert.equal(h.sent.length,0);assert.equal(h.created.length,2);}
});
test('picker searches only on official site; manual toolbar selection is read-only and returns once to the original document',async()=>{
 const h=harness([{state:'picked',candidate:item}]);const cmd={partName:'红色按钮',query:'按 钮'};
 assert.equal((await h.msg('FB_PICK_PREPARE',studio,cmd)).state,'opened');
 assert.equal(h.created[0].url,'https://s.taobao.com/search?q='+encodeURIComponent(cmd.query));assert.equal(h.captured.length,0);
 await h.msg('FB_PICK_PREPARE',studio,cmd);assert.equal(h.created.length,1);
 assert.equal((await h.msg('FB_PICK_PREPARE',studio,{...cmd,requestId:randomUUID()})).state,'error');
 for(const t of [{id:12,url:item.url,active:false,windowId:9},{id:12,url:item.url,active:true,windowId:4}])await h.capture(t);
 assert.equal(h.captured.length,0);const t={id:20,windowId:9,active:true,url:item.url};await h.capture(t);
 assert.equal(h.sent.length,0);assert.equal(h.captured.length,1);const result=h.forwarded[0];assert.equal(result.i,studio.tab.id);assert.equal(result.opt.documentId,studio.documentId);assert.equal(result.m.candidate.sku,'红色');assert.equal(result.m.candidate.skuId,'83');assert.equal(h.focused[0],studio.tab.id);
 await h.capture(t);assert.equal(h.captured.length,1);assert.equal((await h.msg('FB_PICK_PREPARE',studio,cmd)).state,'picked');
});
test('picker rejects incorrect product, incomplete variant, expired and foreign source',async()=>{
 const h=harness();const cmd={partName:'红色按钮',url:item.url};
 assert.equal((await h.msg('FB_PICK_PREPARE',{...studio,frameId:1},cmd)).state,'error');
 assert.equal((await h.msg('FB_PICK_PREPARE',studio,{...cmd,url:'https://example.test/item.htm?id=417'})).state,'error');assert.equal(h.created.length,0);
 await h.msg('FB_PICK_PREPARE',studio,cmd);await h.capture({id:40,active:true,windowId:9,url:'https://item.taobao.com/item.htm?id=88'});
 assert.equal(h.captured.length,0);assert.equal(h.forwarded[0].m.state,'error');
 for(const kind of ['incomplete','expired']){
  const x=harness([{state:'picked',candidate:{...item,options:[]}}]);await x.msg('FB_PICK_PREPARE',studio,cmd);
  if(kind==='expired')x.storage.formbenchPickerV1.current.expires=1;
  await x.capture({id:40,windowId:9,active:true,url:item.url});
  assert.equal(x.forwarded[0].m.state,'error');assert.equal(x.sent.length,0);assert.equal(x.captured.length,kind==='expired'?0:1);
 }
});

test('storefront toast alone cannot confirm the cart or trigger another click',async()=>{
 const h=harness([{status:'added'}],[3,4]);await h.msg('FB_CART_PREPARE',studio,{items:[item]});const c=h.confirmation();await h.msg('FB_EXT_APPROVE',c);const r=await h.msg('FB_EXT_NEXT',c);assert.equal(r.results[0].status,'not_confirmed');await h.msg('FB_EXT_NEXT',c);assert.equal(h.sent.length,1);
});
