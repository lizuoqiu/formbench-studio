// Only verified studio tabs can propose a batch; only this extension's own confirmation tab can start it.
const jobsKey='formbenchBatchesV1',allowedStatus=new Set(['added','needs_login','needs_selection','not_confirmed']);
const digits=x=>typeof x==='string'&&/^\d{1,25}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(x);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function studio(url){try{const u=new URL(url);return !u.username&&!u.password&&(u.origin==='https://lizuoqiu.github.io'&&u.pathname==='/formbench-studio/'||['http://localhost:4173','http://127.0.0.1:4173'].includes(u.origin)&&u.pathname==='/');}catch{return false;}}
function normalize(items){
  if(!Array.isArray(items)||!items.length||items.length>40)throw Error('一次可处理 1–40 件商品。');
  const seen=new Set();
  return items.map(i=>{
    if(!i||typeof i.url!=='string'||i.url.length>2048||typeof i.title!=='string'||!i.title.trim()||i.title.length>250||!Number.isInteger(i.qty)||i.qty<1||i.qty>999||!Array.isArray(i.options)||i.options.length>12||i.options.some(o=>typeof o!=='string'||!o.trim()||o.length>150))throw Error('商品信息不完整。');
    const u=new URL(i.url),ids=u.searchParams.getAll('id'),skus=u.searchParams.getAll('skuId'),sku=i.skuId==null||i.skuId===''?null:i.skuId;
    if(u.protocol!=='https:'||u.username||u.password||u.port||!['item.taobao.com','detail.tmall.com'].includes(u.hostname)||u.pathname!=='/item.htm'||ids.length!==1||!digits(ids[0])||skus.length>1||(skus.length&&!digits(skus[0]))||(sku!==null&&!digits(sku))||(sku&&skus.length&&skus[0]!==sku))throw Error('仅支持可核对的淘宝或天猫官方商品与 SKU。');
    const skuId=sku||skus[0]||null,key=ids[0]+'/'+(skuId||'');if(seen.has(key))throw Error('同批有重复商品和规格，请先合并数量。');seen.add(key);
    const url=new URL('/item.htm',u.origin);url.searchParams.set('id',ids[0]);if(skuId)url.searchParams.set('skuId',skuId);
    return {title:i.title.trim(),id:ids[0],url:url.href,originalUrl:i.url,skuId,options:i.options.map(x=>x.trim()),qty:i.qty};
  });
}
let queue=Promise.resolve();
function edit(fn){
  const op=queue.then(async()=>{const all=(await chrome.storage.session.get(jobsKey))[jobsKey]||{};const value=await fn(all);await chrome.storage.session.set({[jobsKey]:all});return value;});queue=op.catch(()=>{});return op;
}
const results=j=>({type:'FB_CART_UPDATE',version:1,requestId:j.id,state:j.state,results:j.results.map(x=>x.index===j.attempt?{index:x.index,status:'not_confirmed',message:'本项正在处理，尚未观察到淘宝回执。'}:{...x}),message:j.message||''});
const notify=j=>chrome.tabs.sendMessage(j.owner,results(j),{documentId:j.document}).catch(()=>{});
function end(j,msg){j.state='finished';j.message=msg;delete j.attempt;j.touched=Date.now();}
function expire(j){
  if(j.state==='awaiting_confirmation'&&Date.now()-j.touched>600000){j.state='cancelled';j.message='确认已超时；没有执行。';}
  if(j.state==='running'&&Date.now()-j.touched>100000){
    if(j.attempt!==undefined)j.results[j.attempt]={index:j.attempt,status:'not_confirmed',message:'未取得该项回执，请去淘宝核对，不要重复加购。'};
    end(j,'任务中断，后续商品未执行。');
  }
}
const pending=j=>['awaiting_confirmation','running'].includes(j.state);
const fromStudio=s=>s.id===chrome.runtime.id&&s.frameId===0&&Number.isInteger(s.tab?.id)&&studio(s.url)&&s.documentId;
function isOwner(j,s){return fromStudio(s)&&s.tab.id===j.owner&&s.documentId===j.document;}
const confirmPath=()=>chrome.runtime.getURL('confirm.html');
function isConfirm(j,s){return s.id===chrome.runtime.id&&(s.frameId==null||s.frameId===0)&&s.url===confirmPath()+'?batch='+j.id+'&key='+j.key&&(!s.tab||s.tab.id===j.confirmTab);}
function assertConfirm(j,s){if(!j||!isConfirm(j,s))throw Error('请在本次扩展确认页内操作。');}
async function pageCommand(m,s){
  if(!fromStudio(s)||!uuid(m.requestId))throw Error('请求来源或编号无效。');
  return edit(async all=>{
    let j=all[m.requestId];
    if(j){if(!isOwner(j,s))throw Error('无法读取此清单。');expire(j);return results(j);}
    if(m.type!=='FB_CART_PREPARE')throw Error('没有此批次记录。浏览器重启或页面重载后，请先到淘宝核对购物车。');
    const lines=normalize(m.items);
    for(const job of Object.values(all)){expire(job);if(pending(job))throw Error('另有清单正在等待确认或处理，请先完成它。');}
    // Retain only the latest 128 jobs in this browser session. Each new batch requires fresh confirmation.
    const keys=Object.values(all).sort((a,b)=>a.touched-b.touched);while(keys.length>=128)delete all[keys.shift().id];
    j={id:m.requestId,key:crypto.randomUUID(),owner:s.tab.id,windowId:s.tab.windowId,document:s.documentId,touched:Date.now(),state:'awaiting_confirmation',lines,results:lines.map((_,index)=>({index,status:'unattempted',message:'尚未执行'}))};
    all[j.id]=j;const t=await chrome.tabs.create({windowId:j.windowId,url:confirmPath()+'?batch='+j.id+'&key='+j.key,active:true});j.confirmTab=t.id;return results(j);
  });
}
async function readCartLine(j,line){
  const tab=await chrome.tabs.create({windowId:j.windowId,url:'https://cart.taobao.com/cart.htm',active:false});
  try{const until=Date.now()+9000;do{const t=await chrome.tabs.get(tab.id);if(t.status==='complete'&&t.url){const u=new URL(t.url);if(u.hostname==='login.taobao.com')return {known:false};if(u.origin==='https://cart.taobao.com'){
    const r=await chrome.tabs.sendMessage(tab.id,{type:'FB_CART_READ_LINE',id:line.id,skuId:line.skuId},{frameId:0}).catch(()=>null);
    if(r?.known&&r.id===line.id&&r.skuId===line.skuId&&Number.isInteger(r.qty)&&r.qty>=0)return r;
   }}await sleep(350);}while(Date.now()<until);return {known:false};}finally{await chrome.tabs.remove(tab.id).catch(()=>{});}
}
async function inspect(j,index) {
  const line=j.lines[index],tab=await chrome.tabs.create({windowId:j.windowId,url:line.url,active:true}),id=tab.id;
  // Wait for the final document to load; no add request has been sent yet.
  const until=Date.now()+22000;let current;
  do {
    current=await chrome.tabs.get(id);
    if(current.status==='complete' && current.url && !current.url.startsWith('about:'))break;
    await sleep(325);
  }while(Date.now()<until);
  if(!current?.url||current.status!=='complete')return {status:'not_confirmed',message:'商品页未在时限内就绪，请在已打开的标签页核对。'};
  const u=new URL(current.url);
  if(['https://login.taobao.com','https://login.tmall.com'].includes(u.origin))return {status:'needs_login',message:'请在已打开的淘宝页面登录，本次没有继续加购。'};
  const target=new URL(line.url);
  if(u.origin!==target.origin||u.pathname!=='/item.htm'||u.searchParams.getAll('id').length!==1||u.searchParams.get('id')!==line.id||u.searchParams.getAll('skuId').length>1||(u.searchParams.has('skuId')&&u.searchParams.get('skuId')!==line.skuId))return {status:'not_confirmed',message:'未定位到指定商品或规格，请在官方页面核对。'};
  if(!line.skuId||!line.options.length)return {status:'needs_selection',message:'清单缺少确切 SKU 或规格；请在打开的官方商品页面选择并确认。'};
  // Never resend this message. Delivery without acknowledgement can already have changed the cart.
  const before=await readCartLine(j,line);
  if(!before.known)return {status:'not_confirmed',message:'无法从官方购物车确认此规格的原有数量，本项未加购。'};
  let timer;
  try{
    const result=await Promise.race([chrome.tabs.sendMessage(id,{type:'FORMBENCH_ADD_LINE',line},{frameId:0}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('等待页面回执超时')),38000);})]);
    if(!allowedStatus.has(result?.status))throw Error('没有可验证的页面回执');
    if(result.status!=='added')return {status:result.status,message:String(result.message||'').slice(0,600)};
    const after=await readCartLine(j,line);if(!after.known||after.qty!==before.qty+line.qty)return {status:'not_confirmed',message:'商品页已提示加购，但未在购物车核对到该规格的预期数量变化。请自行核对，不要重复添加。'};
    return {status:'added',message:'已在淘宝购物车核对规格与数量：'+before.qty+' → '+after.qty+'。',receipt:{id:line.id,skuId:line.skuId,before:before.qty,after:after.qty}};
  }finally{clearTimeout(timer);}
}
async function confirmCommand(m,s){
  if(!uuid(m.requestId))throw Error('无效的批次。');
  const queued=await edit(all=>{
    const j=all[m.requestId];assertConfirm(j,s);expire(j);
    if(m.type==='FB_EXT_READ')return {view:{...results(j),items:j.lines}};
    if(m.type==='FB_EXT_CANCEL'){
      if(j.state==='awaiting_confirmation'){j.state='cancelled';j.message='买家取消，未执行。';}
      return {job:j};
    }
    if(m.type==='FB_EXT_APPROVE'){
      if(j.state==='awaiting_confirmation'){j.state='running';j.touched=Date.now();}
      return {job:j};
    }
    if(j.state!=='running'||j.attempt!==undefined) return {job:j};
    const idx=j.results.findIndex(x=>x.status==='unattempted');
    if(idx<0){end(j,'清单处理完毕。');return {job:j};}
    j.attempt=idx;j.touched=Date.now();return {job:j,idx};
  });
  if(queued.view)return queued.view;
  if(queued.idx===undefined){void notify(queued.job);return results(queued.job);}
  const idx=queued.idx;let outcome;try{outcome=await inspect(queued.job,idx);}catch{outcome={status:'not_confirmed',message:'未收到可核对的加购结果，请查看淘宝购物车；助手不会自动重试。'};}
  const done=await edit(all=>{
    const j=all[m.requestId];if(!j||j.state!=='running'||j.attempt!==idx)return j;
    j.results[idx]={index:idx,...outcome};delete j.attempt;j.touched=Date.now();
    if(j.stopAfterLine||outcome.status!=='added'||idx===j.lines.length-1)end(j,j.stopAfterLine?'页面已关闭，后续商品未执行。':outcome.status==='added'?'已处理全部商品。':'清单已暂停，后续商品未执行。');
    return j;
  });if(!done)throw Error('批次已结束。');void notify(done);return results(done);
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(!m||!['FB_CART_PREPARE','FB_CART_STATUS','FB_EXT_READ','FB_EXT_APPROVE','FB_EXT_NEXT','FB_EXT_CANCEL'].includes(m.type))return;
  const job=m.type.startsWith('FB_CART_')?pageCommand(m,s):confirmCommand(m,s);
  job.then(reply,e=>reply({type:'FB_CART_UPDATE',requestId:m.requestId,version:1,state:'error',results:[],message:e.message}));return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{
  edit(all=>{const jobs=[];for(const j of Object.values(all)){if(!pending(j)||j.confirmTab!==tabId&&j.owner!==tabId)continue;
    if(j.state==='awaiting_confirmation'){j.state='cancelled';j.message='页面已关闭，未执行清单。';}
    else if(j.attempt===undefined)end(j,'页面已关闭，剩余商品未执行。');
    // The in-flight line may already have changed the cart. Capture the result before ending.
    else j.stopAfterLine=true;
    jobs.push(j);
  }return jobs;}).then(js=>js.forEach(notify)).catch(()=>{});
});

// Capturing a listing is a separate, read-only workflow. The toolbar click selects the buyer's active detail tab.
const pickKey='formbenchPickerV1',pickTtl=5*60*1000;
let pickQueue=Promise.resolve();
function withPicker(fn){
 const p=pickQueue.then(async()=>{const obj=(await chrome.storage.session.get(pickKey))[pickKey]||{};const v=await fn(obj);await chrome.storage.session.set({[pickKey]:obj});return v;});pickQueue=p.catch(()=>{});return p;
}
const pickedWire=(id,body)=>({type:'FB_PICK_RESULT',version:1,requestId:id,...body});
function detailLine(url){return normalize([{title:'商品',url,options:[],qty:1}])[0];}
function textWithin(v,n){return typeof v==='string'&&v.trim().length>0&&v.length<=n;}
async function preparePick(m,s){
 if(!fromStudio(s)||!uuid(m.requestId)||!Number.isInteger(s.tab.windowId))throw Error('选择请求来源或编号无效。');
 const t=Date.now(),url=m.url?detailLine(m.url):null;
 if(!textWithin(m.partName,250)||!url&&!textWithin(m.query||m.partName,1000))throw Error('请提供零件名称或搜索关键词。');
 return withPicker(async box=>{
   const prev=box.current;
   if(prev&&prev.expires>t){
     if(prev.id===m.requestId&&isOwner(prev,s))return prev.reply||{type:'FB_PICK_OPENED',requestId:prev.id,version:1,state:'opened'};
     if(!prev.reply)throw Error('已有零件正在淘宝选规格，请先完成该次选择。');
   }
   const href=url?.url||('https://s.taobao.com/search?q='+encodeURIComponent((m.query||m.partName).trim()));
   const tab=await chrome.tabs.create({windowId:s.tab.windowId,url:href,active:true});
   box.current={id:m.requestId,owner:s.tab.id,document:s.documentId,windowId:s.tab.windowId,targetId:url?.id||null,partName:m.partName.trim(),expires:t+pickTtl};
   return {type:'FB_PICK_OPENED',version:1,state:'opened',requestId:m.requestId};
 });
}
async function capturePick(tab){
 const p=await withPicker(box=>{
   const p=box.current;if(!p||p.windowId!==tab.windowId||p.reply||p.capturing||!tab.active||!Number.isInteger(tab.id))return;
   if(Date.now()>p.expires){p.reply=pickedWire(p.id,{state:'error',message:'选规格请求已过期，请从工作台重新打开。'});}
   else{p.capturing=true;}
   return {...p};
 });if(!p)return;
 let reply=p.reply;
 if(!reply)try{
    const curr=detailLine(tab.url);
    if(p.targetId&&curr.id!==p.targetId)throw Error('当前商品和工作台指定的商品编号不同。');
    const raw=await chrome.tabs.sendMessage(tab.id,{type:'FORMBENCH_CAPTURE_LINE'},{frameId:0});
    const c=raw?.candidate;if(!c||!(raw.state==='picked'||raw.status==='picked'))throw Error(raw?.message||'请先在商品详情页选好规格，再从工作台重新带回。');
    const [item]=normalize([{...c,qty:1}]);
    if(item.id!==curr.id||new URL(curr.url).origin!==new URL(item.url).origin||!item.skuId||curr.skuId&&curr.skuId!==item.skuId||!item.options.length)throw Error('没有取得与当前商品相符的完整 SKU 和选项。');
    if(Date.now()>p.expires)throw Error('选择请求已过期，请重新选择。');
    reply=pickedWire(p.id,{state:'picked',candidate:{url:item.url,title:item.title,skuId:item.skuId,options:item.options,sku:item.options.join(' / ')}});
 }catch(e){reply=pickedWire(p.id,{state:'error',message:typeof e.message==='string'&&e.message.length<=400&&!e.message.startsWith('Invalid URL')?e.message:'请打开淘宝或天猫官方商品详情，选择完整规格后重新带回。'});}
 const same=await withPicker(box=>{const j=box.current;if(!j||j.id!==p.id||j.document!==p.document)return false;j.reply=reply;j.capturing=false;return true;});
 if(same)try{
   // Only focus the original workspace if its document is still listening, never a later page in the same tab.
   await chrome.tabs.sendMessage(p.owner,reply,{documentId:p.document});await chrome.tabs.update(p.owner,{active:true});
 }catch{}
}
chrome.action.onClicked.addListener(tab=>{void capturePick(tab).catch(()=>{});});
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m?.type!=='FB_PICK_PREPARE')return;
 preparePick(m,s).then(reply,e=>reply(pickedWire(m.requestId,{state:'error',message:e.message})));return true;
});
chrome.tabs.onRemoved.addListener(id=>{void withPicker(box=>{if(box.current?.owner===id)delete box.current;}).catch(()=>{});});
