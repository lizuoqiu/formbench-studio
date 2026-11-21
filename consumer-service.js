// Browser adapter. A static deployment never forwards a prompt, login or cart to another origin.
import {catalog as models} from './assembly-hardware.js';

const localUrl='http://127.0.0.1:4173/', cartUrl='https://cart.taobao.com/cart.htm';
const text=(s,max=500)=>typeof s==='string'?s.trim().slice(0,max):'';
const id=n=>typeof n==='string'&&/^\d{1,25}$/.test(n);
const place=()=>new URL(globalThis.location.href);
const isPages=()=>/(?:^|\.)github\.io$/i.test(place().hostname);
const hereIsLocal=()=>['127.0.0.1','localhost','[::1]'].includes(place().hostname);
const capabilityFallback=()=>({ai:false,catalog:false,cart:'manual',...(!hereIsLocal()?{localUrl}:{})});
async function call(path,body,signal){
  if(isPages())throw Object.assign(Error('此静态页面未连接生成服务，请在本机打开设计工作台。'),{localUrl});
  const response=await fetch(new URL('./api/'+path,place()),{
    method:body===undefined?'GET':'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal,
    ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||typeof data!=='object')throw Error(text(data?.error)||'暂时无法连接服务。');
  return data;
}
const helperMessage=(type,requestId,extra={})=>window.postMessage({source:'formbench-studio',type,requestId,...extra},place().origin);
function fromHelper(e,requestId,type){
  return e.source===window&&e.origin===place().origin&&e.data?.source==='formbench-extension'&&e.data.type===type&&e.data.version===1&&e.data.requestId===requestId;
}
function helperPresent(){
  if(typeof window==='undefined'||!globalThis.crypto?.randomUUID)return Promise.resolve(false);
  const requestId=crypto.randomUUID();
  return new Promise(resolve=>{
    const done=value=>{clearTimeout(timer);window.removeEventListener('message',listen);resolve(value);};
    const listen=e=>{if(fromHelper(e,requestId,'FB_HELPER_PONG'))done(true)};
    const timer=setTimeout(()=>done(false),650);
    window.addEventListener('message',listen);
    try{helperMessage('FB_HELPER_PING',requestId)}catch{done(false)}
  });
}
export async function serviceCapabilities(){
  const fallback=capabilityFallback();
  const [ext,d]=await Promise.all([helperPresent(),isPages()?null:call('capabilities').catch(()=>null)]);
  return {...fallback,...(d?.cadEngine==='forgecad'?{cadEngine:'forgecad'}:{}),ai:d?.ai===true,...(d?.ai===true&&d.aiProvider==='openai-api'&&d.designImages===true?{designImages:true}:{}),...(d?.ai===true&&text(d.aiModel,180)?{aiModel:text(d.aiModel,180)}:{}),...(['local-codex','openai-api'].includes(d?.aiProvider)?{aiProvider:d.aiProvider}:{}),catalog:d?.catalog===true,cart:ext?'browser':d?.cart==='official'?'official':'manual'};
}

const sampleRows=[
  ['Raspberry Pi Pico','初代 RP2040，无排针，Micro-B','Raspberry Pi Pico R3','pico',[52.3,21,3.73],'Raspberry Pi 原厂 R3 STEP，含连接器的整板外廓','internal','管理专注与休息状态。'],
  ['红色 LED','5 mm 红色直插，双脚','LED_D5.0mm','red-led',[5.4,5.8,14.1],'KiCad 5 mm 直插 LED 封装，含引脚','panel','亮起时表示专注中。'],
  ['绿色 LED','5 mm 绿色直插，双脚','LED_D5.0mm','green-led',[5.4,5.8,14.1],'KiCad 5 mm 直插 LED 封装，含引脚','panel','亮起时表示可以打扰。'],
  ['轻触开关','6 × 6 mm，4.3 mm 高，四脚直插','SW_PUSH_6mm_H4.3mm','button',[7.172,6,7.8],'KiCad 轻触开关封装，含引脚','panel','按一下切换当前状态。'],
  ['限流电阻','330 Ω，1/4 W，DIN0207 轴向直插','DIN0207','resistor',[10.754,2.5,5.499],'KiCad DIN0207 水平弯脚封装，非具体商品','internal','每盏灯各串联一只。',2],
  ['USB 数据线','USB-A 公头至 Micro-B 公头，供电与数据','USB-A → Micro-B','usb-cable',[74.546,48.75,7.8],'原创短线展示路由，仅为预览外廓，不代表实物线长','external','连接电脑，供电并写入程序。']
];
export function sampleDesign(){
  return {generation:{provider:'sample',modelId:null,modelSource:'undisclosed'},name:'桌面专注状态灯',summary:'按一下按钮，就能在红色的「专注中」和绿色的「可以打扰」之间切换。由电脑的 USB 接口供电。',
    parts:sampleRows.map(([name,spec,model,modelId,sizeMm,dimensionSource,role,purpose,qty=1])=>({name,spec,qty,model,modelId,sizeMm:[...sizeMm],dimensionSource:'catalog',dimensionNote:dimensionSource,role,purpose})),
    steps:['分别为两只 LED 串联限流电阻后连接到控制板。','连接按钮和 USB 数据线，写入切换状态的程序。','依次测试两种状态，再按实物尺寸确认安装位置。']};
}
const size=v=>Array.isArray(v)&&v.length===3&&v.every(x=>Number.isFinite(x)&&x>0)?v:null;
function citationUrl(value){
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
function partReference(raw){
  if(!raw||!['datasheet-approximation','envelope-approximation'].includes(raw.kind))return null;
  const sourceUrl=citationUrl(raw.sourceUrl),cadUrl=citationUrl(raw.cadUrl);
  if(!sourceUrl&&!cadUrl)return null;
  return {kind:raw.kind,detail:text(raw.detail,1200),sourceUrl,
    ...(cadUrl?{cadUrl}:{}),...(raw.sourceQuote?{sourceQuote:text(raw.sourceQuote,500)}:{})};
}
function designPart(raw){
  if(!raw||!text(raw.name,200)||!Number.isInteger(raw.qty)||raw.qty<1||raw.qty>999)throw Error('设计中的零件名称或数量无效，请重新生成。');
  const sizeMm=size(raw.sizeMm),ref=raw.dimensionSource==='catalog'&&Object.hasOwn(models,raw.modelId)?raw.modelId:undefined;
  // Server checks the part/variant and the original user-specified dimensions.
  // An omitted modelId is intentional; a name-only match can bind the wrong purchase.
  const reference=partReference(raw.geometryReference);
  const sourceUrl=citationUrl(raw.dimensionSourceUrl||raw.sourceUrl);
  const dimensionSource=sizeMm&&raw.dimensionSource==='specified'?'specified':sizeMm&&ref?'catalog':
    sizeMm&&raw.dimensionSource==='datasheet'&&reference?.kind==='datasheet-approximation'&&sourceUrl?'datasheet':'estimated';
  return {name:text(raw.name,200),spec:text(raw.spec,800),qty:raw.qty,model:text(raw.model,240)||'待选型',
    ...(ref&&dimensionSource==='catalog'?{modelId:ref}:{}),sizeMm,dimensionSource,
    dimensionNote:text(raw.dimensionNote,900),dimensionSourceUrl:sourceUrl,sourceUrl,
    ...(reference?{geometryReference:reference}:{}),
    ...(typeof raw.mechanicalEvidenceReceipt==='string'&&raw.mechanicalEvidenceReceipt.length<=8192?{mechanicalEvidenceReceipt:raw.mechanicalEvidenceReceipt}:{}),
    ...(['internal','panel','external','enclosure'].includes(raw.role)?{role:raw.role}:{}),
    ...(['mounted','loose'].includes(raw.placement)?{placement:raw.placement}:{}),
    ...(raw.dimensionQuote?{dimensionQuote:text(raw.dimensionQuote,500)}:{}),
    ...(['box','cylinder'].includes(raw.shape)?{shape:raw.shape}:{}),purpose:text(raw.purpose,500)};
}
function normalizeDesign(d){
  if(!text(d?.name,200)||!Array.isArray(d.parts)||!d.parts.length||d.parts.length>60)throw Error('没有收到有效的硬件方案，请重新生成。');
  const g=d.generation;
  const project=g?.skill?.project;
  const skill=g?.skill?.name?{name:text(g.skill.name,200),revision:text(g.skill.revision,150),sourceUrl:citationUrl(g.skill.sourceUrl),
    ...(project?.name==='interaction-hardware'&&text(project.revision,150)?{project:{name:project.name,revision:text(project.revision,150),sourcePath:'skills/interaction-hardware/SKILL.md'}}:{})}:null;
  const generation=g&&['openai-api','local-codex'].includes(g.provider)?{provider:g.provider,modelId:text(g.modelId,200)||null,modelSource:['response','configured'].includes(g.modelSource)?g.modelSource:'undisclosed',...(skill?{skill}:{})}:undefined;
  const research=g?.mechanicalResearch;
  if(generation&&['searched','no-candidates','unavailable'].includes(research?.status)&&
    Number.isInteger(research.requested)&&research.requested>=0&&Number.isInteger(research.found)&&research.found>=0&&research.found<=research.requested){
    generation.mechanicalResearch={status:research.status,requested:research.requested,found:research.found,
      ...(Number.isInteger(research.inherited)&&research.inherited>0?{inherited:research.inherited}:{})};
  }
  return {...(generation?{generation}:{}),...(d.cadPlan?{cadPlan:d.cadPlan}:{}),...(d.deviceMotion?{deviceMotion:d.deviceMotion}:{}),name:text(d.name,200),summary:text(d.summary,5000),steps:(Array.isArray(d.steps)?d.steps:[]).map(s=>text(s,2000)).filter(Boolean),parts:d.parts.map(designPart)};
}
export async function discussDesign(context,signal){
  const data=await call('design',{...context,action:'discuss'},signal);
  if(data.design)return {design:normalizeDesign(data.design)};
  if(data.decision==='ready')return {decision:'ready'};
  if(data.decision==='ask'&&text(data.question,600)&&Array.isArray(data.options)){
    return {decision:'ask',question:text(data.question,600),options:data.options.slice(0,3).map(option=>text(option,160)).filter(Boolean)};
  }
  throw Error('没有收到有效的设计回复，请重试。');
}
export async function generateDesign(prompt,{onProgress,context,signal}={}){
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw Error('请填写 1–10000 字的设计需求。');
  onProgress?.('request');
  const data=await call('design',{...(context?{...context,action:'generate'}:{}),prompt:prompt.trim()},signal);
  onProgress?.('response');
  return normalizeDesign(data.design);
}
function detail(raw){
  if(!raw||typeof raw!=='object')return null;
  let u;try{u=new URL(raw.url)}catch{return null}
  const item=u.searchParams.get('id'),variant=u.searchParams.get('skuId');
  if(u.protocol!=='https:'||u.username||u.password||u.port||!['item.taobao.com','detail.tmall.com'].includes(u.hostname)||u.pathname!=='/item.htm'||!id(item)||u.searchParams.getAll('id').length!==1||u.searchParams.getAll('skuId').length>1)return null;
  if((variant!==null&&!id(variant))||(raw.skuId!=null&&raw.skuId!==''&&!id(raw.skuId))||(variant&&raw.skuId&&variant!==raw.skuId))return null;
  const skuId=raw.skuId||variant||'';
  return {url:u.origin+'/item.htm?id='+item+(skuId?'&skuId='+skuId:''),title:text(raw.title,250)||'查看淘宝商品 '+item,...(['user','page'].includes(raw.titleSource)&&text(raw.listingTitle,250)?{listingTitle:text(raw.listingTitle,250),titleSource:raw.titleSource}:{titleSource:'label'}),...(skuId?{skuId}:{}),...(text(raw.sku)?{sku:text(raw.sku,220)}:{}),...(Array.isArray(raw.options)&&raw.options.length&&raw.options.length<=12&&raw.options.every(v=>typeof v==='string'&&v.trim()&&v.length<=150)?{options:raw.options.map(v=>v.trim())}:{})};
}
const searchLink=query=>'https://s.taobao.com/search?q='+encodeURIComponent(query);
// Only the unmodified reference row qualifies for curated evidence. Its shape is not a retailer SKU.
async function curatedFor(part){
  const row=sampleRows.find(([name,spec,model,modelId,dims])=>part.name===name&&part.spec===spec&&part.model===model&&part.modelId===modelId&&part.dimensionSource==='catalog'&&Array.isArray(part.sizeMm)&&dims.every((n,i)=>n===part.sizeMm[i])&&part.sizeMm.length===3);
  if(!row)return [];
  try{
    const res=await fetch(new URL('./samples/taobao-parts.json',place()),{credentials:'same-origin',mode:'same-origin',redirect:'error'});
    if(!res.ok)return [];
    const data=await res.json(),out=[];
    for(const r of Array.isArray(data.items)?data.items:[]){
      if(r.modelId!==row[3]||!['manufacturer-link','seller-link'].includes(r.sourceType)||!citationUrl(r.sourceUrl))continue;
      const candidate=detail({url:r.url,title:r.title,skuId:r.skuId});
      if(!candidate||new URL(candidate.url).searchParams.get('id')!==r.itemId)continue;
      // An official listing is evidence, but none of the possible lengths describes the linked variant until verified.
      out.push({...candidate,options:[],sourceUrl:r.sourceUrl,sourceTitle:text(r.sourceTitle),selectionNote:text(r.selectionNote),requiresSelection:true});
    }
    return out;
  }catch{return [];}
}
export async function findProducts(part){
  const name=text(part?.name,200),spec=text(part?.spec,800),query=[name,spec].filter(Boolean).join(' ');
  const fallback={candidates:[],searchUrl:searchLink(query)};
  if(!name)return {...fallback,reason:'请先选择零件。'};
  const [curated,data]=await Promise.all([curatedFor(part),isPages()?null:call('catalog',{name,spec}).catch(e=>({reason:e.message}))]);
  const unique=new Map(curated.map(i=>[i.url,i]));
  for(const raw of Array.isArray(data?.candidates)?data.candidates:[]){const candidate=detail(raw);if(candidate&&!unique.has(candidate.url))unique.set(candidate.url,candidate);}
  const candidates=[...unique.values()].slice(0,12);
  return {...fallback,candidates,...(!candidates.length?{reason:text(data?.reason)||'请按零件型号和规格在淘宝搜索。'}:{})};
}
let pendingPick=false;
export async function pickProduct(part,currentUrl){
  const partName=text(part?.name,200);
  if(!partName)return {reason:'请先选择零件。'};
  if(pendingPick)return {reason:'请先完成已打开的淘宝选品。'};
  pendingPick=true;
  try{
    if(!await helperPresent())return {reason:'未检测到淘宝选品助手，请使用淘宝搜索或粘贴商品详情。'};
    const requestId=crypto.randomUUID(),query=[partName,text(part.model,150),text(part.spec,300)].filter(Boolean).join(' ').slice(0,280);
    const start=detail({url:currentUrl})?.url; // Otherwise the helper uses the precise Taobao search query.
    return await new Promise(resolve=>{
      const done=out=>{clearTimeout(timer);window.removeEventListener('message',listen);resolve(out)};
      const listen=e=>{
        if(!fromHelper(e,requestId,'FB_PICK_RESULT'))return;
        const result=e.data;
        if(result.state!=='picked')return done({reason:text(result.message)||'未选定淘宝商品。'});
        const raw=result.candidate,candidate=detail(raw);
        if(!candidate||!candidate.skuId||!candidate.options?.length||!text(raw.title,250))return done({reason:'没有收到可核对的商品详情、具体 SKU 和页面规格，请重新选择。'});
        done({candidate:{...candidate,sku:candidate.options.join(' / '),listingTitle:text(raw.title,250),titleSource:'page',requiresSelection:false}});
      };
      const timer=setTimeout(()=>done({reason:'等待选品已结束，没有修改零件清单。'}),5*60*1000);
      window.addEventListener('message',listen);
      try{helperMessage('FB_PICK_PREPARE',requestId,{partName,query,...(start?{url:start}:{})})}catch{done({reason:'未能打开淘宝选品助手。'})}
    });
  }finally{pendingPick=false;}
}
function cartLine(raw){
  const item=detail(raw);
  if(!item||!Number.isInteger(raw.qty)||raw.qty<1||raw.qty>999)return null;
  const opts=Array.isArray(raw.options)&&raw.options.length?raw.options:item.sku?[item.sku]:[];
  if(!Array.isArray(opts)||opts.length>12||opts.some(v=>typeof v!=='string'||!v.trim()||v.length>150))return null;
  return {...item,qty:raw.qty,options:opts.map(v=>v.trim())};
}
function officialLink(raw){
  try{const u=new URL(raw.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(?:^|\.)(?:taobao|tmall)\.com$/.test(u.hostname)&&Number.isInteger(raw.count)&&raw.count>0?{url:u.href,count:raw.count}:null;}catch{return null}
}
const outcomes=['added','needs_login','needs_selection','not_confirmed','unattempted'];
let activeBatch=null;
function extensionCart(items){
  const requestId=crypto.randomUUID(),progress=new Map();
  return new Promise(resolve=>{
    const finish=(state,note)=>{
      clearTimeout(timeout);clearInterval(poll);window.removeEventListener('message',listen);
      const resultItems=items.map((i,n)=>({...i,...(progress.get(n)||{status:state==='cancelled'?'unattempted':'not_confirmed',message:''})}));
      const added=resultItems.filter(i=>i.status==='added').length;
      const needs=resultItems.find(i=>['needs_login','needs_selection'].includes(i.status));
      const aggregate=added===items.length?'added':added?'partial':needs?.status||'manual';
      resolve({state:aggregate,items:resultItems,verified:added===items.length,cartUrl,links:[],reason:note||needs?.message||(!added?'未收到淘宝商品页新增成功的反馈。':'')});
    };
    const listen=e=>{
      if(!fromHelper(e,requestId,'FB_CART_UPDATE'))return;
      const u=e.data;
      if(!['awaiting_confirmation','running','finished','cancelled','error'].includes(u.state))return;
      if(Array.isArray(u.results))for(const r of u.results){
        if(!Number.isInteger(r?.index)||r.index<0||r.index>=items.length||!outcomes.includes(r.status))continue;
        // An explicit added result is issued only for observed marketplace feedback. A click or opened URL is not one.
        if(progress.get(r.index)?.status!=='added')progress.set(r.index,{status:r.status,message:text(r.message,500)});
      }
      if(['finished','cancelled','error'].includes(u.state))finish(u.state,text(u.message,500)||(u.state==='cancelled'?'本批次已取消。':''));
    };
    const timeout=setTimeout(()=>finish('timeout','未及时收到完整回执，请先在淘宝购物车核对；没有重新提交。'),5*60*1000);
    // Check progress only. Never replay PREPARE or silently fall back after possible side effects.
    const poll=setInterval(()=>{try{helperMessage('FB_CART_STATUS',requestId)}catch{/* timeout handles disconnection */}},1500);
    window.addEventListener('message',listen);
    try{helperMessage('FB_CART_PREPARE',requestId,{items})}catch{finish('error','未收到助手确认，请先核对淘宝购物车。')}
  });
}
export async function makeCart(selected){
  const lines=Array.isArray(selected)?selected:selected?.lines;
  const base={state:'needs_selection',cartUrl,links:[],items:[],verified:false};
  if(!Array.isArray(lines)||!lines.length||lines.length>40)return {...base,reason:'请先选择 1–40 个商品。'};
  const items=lines.map(cartLine);
  if(items.some(i=>!i))return {...base,items:items.filter(Boolean),reason:'请先选择有效商品详情与数量。'};
  if(new Set(items.map(i=>i.url)).size!==items.length)return {...base,items,reason:'请先合并重复的商品规格。'};
  const manual={...base,state:'manual',items};
  if(await helperPresent()){
    const key=JSON.stringify(items);
    if(activeBatch)return activeBatch.key===key?activeBatch.promise:{...manual,reason:'另一批商品正在等待确认，请先完成或取消。'};
    const promise=extensionCart(items).finally(()=>{activeBatch=null});
    activeBatch={key,promise};return promise;
  }
  if(items.some(i=>!i.skuId||!i.options.length))return {...base,items,reason:'请先在商品详情确认所购规格和数量。'};
  if(isPages())return {...manual,localUrl,reason:'请打开已启动的本机工作台，或在淘宝商品页加购。'};
  try{
    const data=await call('cart',{items});
    const links=(Array.isArray(data.links)?data.links:[]).map(officialLink).filter(Boolean);
    if(data.state==='links_ready'&&links.length)return {...manual,state:'links_ready',links};
    if(data.state==='needs_login'||data.state==='needs_selection')return {...manual,state:data.state,reason:text(data.reason)||'需要在淘宝确认。'};
    // Our official-link service never verifies an account mutation. A bare success flag isn't a receipt.
    return {...manual,reason:text(data.reason)||'请在淘宝商品页核对规格、加购，并查看购物车。'};
  }catch(e){return {...manual,reason:e.message};}
}
