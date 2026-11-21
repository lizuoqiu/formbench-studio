import {discussDesign,generateDesign,findProducts,pickProduct,makeCart,serviceCapabilities,sampleDesign} from './consumer-service.js';
import {mountConsumerAccount,saveConsumerProject,readConsumerProject} from './consumer-account.js';
import {currentCadPlan,mountConsumerCad} from './consumer-cad.js';
import {cadPlanToForgeScript} from './forge-source.js';
const $=s=>document.querySelector(s),entry=$('#entry'),project=$('#project');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const modelText=p=>[p.model,p.spec].filter(x=>typeof x==='string'&&x.trim()).filter((v,i,a)=>a.indexOf(v)===i).join(' · ');
const sourceText=s=>({catalog:'参考模型',estimated:'设计估算',specified:'已指定尺寸'}[s]||'尚未指定');
const safeUrl=v=>{try{const u=new URL(v);return u.protocol==='https:'||u.protocol==='http:'?u:null}catch{return null}};
const market=v=>{const u=safeUrl(v);return u?.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(?:^|\.)(?:taobao|tmall)\.com$/i.test(u.hostname)?u:null};
const productUrl=v=>{const u=market(v);return u&&/^(?:item\.taobao|detail\.tmall)\.com$/i.test(u.hostname)&&u.pathname==='/item.htm'&&u.searchParams.getAll('id').length===1&&u.searchParams.getAll('skuId').length<=1&&/^\d{1,25}$/.test(u.searchParams.get('id')||'')&&(!u.searchParams.has('skuId')||/^\d{1,25}$/.test(u.searchParams.get('skuId')))?u:null};
const localUrl=v=>{const u=safeUrl(v);return u&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)?u.href:''};
const shopLink=(u,label)=>`<a target="_blank" rel="noopener noreferrer" href="${esc(u)}">${esc(label)} <span aria-hidden="true">↗</span></a>`;
const defaultSearch=p=>'https://s.taobao.com/search?q='+encodeURIComponent([p.name,p.model,p.spec].filter(x=>typeof x==='string').join(' '));
let design=null,rows=[],generation=0,cadDispose=null,cartBusy=false,sample=false,caps={},cartVersion=0;
let exampleAsset=null,projectId=null,projectPrompt='',saveSerial=0,accountEpoch=0,saveTail=Promise.resolve();
let iteration={version:1,conversation:[]}, draft=null;
function readIteration(record){
  const value=record.iteration;
  const conversation=Array.isArray(value?.conversation)?value.conversation.filter(t=>['assistant','user'].includes(t?.role)&&typeof t.text==='string'&&t.text.trim()):[];
  return {version:Number.isSafeInteger(value?.version)&&value.version>0?value.version:1,conversation,
    ...(typeof value?.previousId==='string'?{previousId:value.previousId}:{})};
}
function revisionHistory(){
  if(!projectPrompt&&!iteration.conversation.length)return '';
  const original=projectPrompt?`<li><b>最初需求</b><span>${esc(projectPrompt)}</span></li>`:'';
  const turns=iteration.conversation.map(t=>`<li><b>${t.role==='assistant'?'AI':'你'}</b><span>${esc(t.text)}</span></li>`).join('');
  return `<details class="iteration-history"><summary>需求与修改记录</summary><ol>${original}${turns}</ol></details>`;
}
function remember(){
  if(!design||!projectId)return;
  const snap=structuredClone({id:projectId,prompt:projectPrompt,iteration,exampleAsset,design,selected:rows.map(r=>({included:r.included,candidate:selected(r),holdKey:r.holdKey||'',holdStatus:r.holdStatus||''}))});
  const epoch=accountEpoch,seq=++saveSerial;
  saveTail=saveTail.then(async()=>{if(epoch!==accountEpoch)return;try{await saveConsumerProject(snap)}catch{if(seq===saveSerial&&snap.id===projectId){const note=$('#save-status');if(note)note.textContent='项目暂未保存。'}}});
}
function notice(id,msg='',href='',label=''){const el=$(id);if(el)el.innerHTML=msg?`<p class="notice">${esc(msg)} ${href?shopLink(href,label):''}</p>`:''}
const localPrompt=()=>{try{if(!['127.0.0.1','localhost','[::1]'].includes(location.hostname))return;const incoming=new URLSearchParams(location.hash.slice(1)).get('wish');if(incoming){$('#wish').value=incoming.slice(0,1800);history.replaceState(null,'',location.pathname+location.search)}}catch{}};
let incomingRevision='';
if(['127.0.0.1','localhost','[::1]'].includes(location.hostname)
   &&['fist','status'].includes(new URLSearchParams(location.search).get('example'))){
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(fragment.has('feedback')){
    incomingRevision=(fragment.get('feedback')||'').slice(0,1800);
    history.replaceState(null,'',location.pathname+location.search);
  }
}
localPrompt();
function capabilityHint(){if(!$('#entry-progress').hidden)return;const href=localUrl(caps.localUrl);if(caps.ai===false&&href){$('#generate').textContent='在本机生成 →';notice('#entry-notice','此页面可直接查看示例。生成新方案将在已启动的本机工作室继续。')}else if(caps.ai===false){notice('#entry-notice','OpenAI API 尚未连接，可以先查看示例。');$('#generate').disabled=true}}
function generationLabel(){
 const who={'local-codex':'本机 Codex','openai-api':'OpenAI API'}[caps.aiProvider]||'设计服务';
 return caps.aiModel?`${who} · 请求模型：${caps.aiModel}`:`${who} · 当前未公开模型名`;
}
const capabilitiesReady=serviceCapabilities().then(v=>{caps=v||{};const model=$('#selected-model');model.hidden=!caps.ai;model.textContent=caps.ai?generationLabel():'';if(!entry.hidden)capabilityHint();else if($('#buy')){rows.forEach((_,i)=>refreshRow(i));syncCart()}}).catch(()=>{});
function showEntry(){stopDraft();progress();projectId=null;projectPrompt='';design=null;generation++;cartVersion++;cartBusy=false;cadDispose?.();cadDispose=null;entry.hidden=false;project.hidden=true;project.replaceChildren();$('#back').hidden=true;$('#generate').disabled=false;$('#generate').textContent='生成设计 →';$('#sample').disabled=false;notice('#entry-notice');capabilityHint();window.scrollTo(0,0);$('#wish').focus()}
$('#back').onclick=()=>{showEntry();$('#wish').value=''};
function progress(phase){
  const node=$('#entry-progress');node.hidden=!phase;$('#intent').setAttribute('aria-busy',String(!!phase));
  if(!phase)return;
  node.dataset.phase=phase;
  const labels={request:[caps.aiProvider==='local-codex'?'本机 Codex 正在生成方案':caps.aiProvider==='openai-api'?'正在请求 OpenAI 设计方案':'正在请求设计方案',(caps.aiModel?'请求模型：'+caps.aiModel+'。':'')+'等待返回零件与结构方案。'],response:['已收到设计方案','正在读取零件数据和几何计划。']};
  const info=labels[phase];if(info){$('#build-title').textContent=info[0];$('#build-hint').textContent=info[1]}
}
function planOrigin(d){
 if(Array.isArray(d.cadPlan?.bodies)){
   const n=d.cadPlan.bodies.length;
   return n?`本次形体计划 · ${n} 个实体描述`:'本次计划未包含自制形体';
 }
 return d.generation?.provider==='sample'?'示例参考布局':'没有记录专属形体计划';
}
function provenance(d){
  const g=d.generation||{};
  if(g.provider==='sample')return '<span class="model-stamp">内置示例 · 未调用生成模型</span>';
  const path={'openai-api':'OpenAI API','local-codex':'本机 Codex'}[g.provider];
  if(!path)return '<span class="model-stamp">生成模型：未记录</span>';
  const evidence=g.modelSource==='response'&&g.modelId?`响应模型：${g.modelId}`:g.modelSource==='configured'&&g.modelId?`请求指定模型：${g.modelId}（响应未披露）`:'服务未披露具体模型';
  const url=safeUrl(g.skill?.sourceUrl);
  const label=g.skill?.name?esc(g.skill.name):'';
  const skill=label?(url?` · <a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" title="${esc(g.skill.revision||'建模指导来源')}">${label}</a>`:` · ${label}`):'';
  return `<span class="model-stamp">${esc(path)} · ${esc(evidence)}${skill}</span>${g.reviewNote?`<details class="review-note"><summary>示例的几何复核记录</summary><p>${esc(g.reviewNote)}</p></details>`:''}`;
}
function setDraftBusy(state,phase=''){
  const initial=state.mode==='new';
  const field=$(initial?'#wish':'#revision-prompt');
  const submit=$(initial?'#generate':'#revise-design');
  if(field)field.readOnly=!!draft;
  if(submit)submit.disabled=!!draft;
  if(initial){
    progress(phase);
    if(phase==='discuss'){
      $('#build-title').textContent='正在理解你的需求';
      $('#build-hint').textContent='AI 正在判断是否需要确认交互方式。';
    }
    if(submit)submit.textContent=phase?'处理中…':'生成设计 →';
  }else if($('#revision-status')){
    $('#revision-status').textContent={discuss:'正在阅读你的修改意见…',request:'正在更新零件与 CAD 方案…',response:'已收到新版方案。'}[phase]||'';
  }
}
function stopDraft(){
  if(!draft)return;
  const state=draft;draft=null;state.controller.abort();
  state.panel.replaceChildren();setDraftBusy(state);
}
function renderDiscussion(state,error=''){
  if(draft!==state)return;
  const panel=state.panel;
  const cancel='<button type="button" class="discussion-link" id="cancel-discussion">取消</button>';
  if(state.busy){
    panel.innerHTML='<div class="discussion-controls">'+cancel+'</div>';
    panel.querySelector('#cancel-discussion').onclick=stopDraft;
    return;
  }
  const ask=state.question;
  panel.innerHTML=`<div class="discussion-card">${error?`<p role="alert" class="discussion-error">${esc(error)}</p>`:''}${ask?`<h3 id="discussion-question">${esc(ask.question)}</h3><div class="answer-options">${ask.options.map((label,i)=>`<button type="button" data-answer-index="${i}" class="small-button">${esc(label)}</button>`).join('')}</div><form class="answer-form"><label for="discussion-answer">也可以用自己的话回答</label><div><input id="discussion-answer" maxlength="1800" autocomplete="off"><button type="submit" id="send-answer" class="small-button">回复</button></div></form>`:''}<div class="discussion-controls">${error?'<button type="button" class="small-button" id="retry-discussion">重试</button>':''}<button type="button" id="skip-discussion" class="discussion-link">按当前想法直接生成</button>${cancel}</div></div>`;
  const answer=value=>{
    if(!value.trim()||state.busy)return;
    state.conversation.push({role:'user',text:value.trim()});state.question=null;
    requestDraft(state,'discuss');
  };
  panel.querySelectorAll('[data-answer-index]').forEach(button=>button.onclick=()=>answer(ask.options[Number(button.dataset.answerIndex)]));
  const form=panel.querySelector('.answer-form');
  if(form)form.onsubmit=e=>{e.preventDefault();answer($('#discussion-answer').value)};
  panel.querySelector('#cancel-discussion').onclick=stopDraft;
  panel.querySelector('#skip-discussion').onclick=()=>{
    const extra=panel.querySelector('#discussion-answer')?.value.trim();
    if(extra)state.conversation.push({role:'user',text:extra});
    state.question=null;requestDraft(state,'generate');
  };
  const retry=panel.querySelector('#retry-discussion');if(retry)retry.onclick=()=>requestDraft(state,state.lastAction);
  if(ask)panel.querySelector('#discussion-question').scrollIntoView({block:'nearest'});
}
async function requestDraft(state,action){
  if(draft!==state||state.busy)return;
  state.busy=true;state.lastAction=action;
  const signal=state.controller.signal;
  const context={prompt:state.prompt,conversation:state.conversation,discussionStart:state.discussionStart,...(state.baseDesign?{baseDesign:state.baseDesign}:{})};
  setDraftBusy(state,action==='discuss'?'discuss':'request');renderDiscussion(state);
  try{
    let d;
    if(action==='discuss'){
      const decision=await discussDesign(context,signal);
      if(draft!==state)return;
      if(decision.decision==='ask'){
        state.question=decision;
        const asked=decision.options.length?decision.question+'（'+decision.options.join(' / ')+'）':decision.question;
        state.conversation.push({role:'assistant',text:asked});
        state.busy=false;setDraftBusy(state);renderDiscussion(state);return;
      }
      d=decision.design;
    }
    if(!d){
      state.lastAction='generate';
      d=await generateDesign(state.prompt,{context,signal,onProgress:phase=>{if(draft===state)setDraftBusy(state,phase)}});
    }
    if(draft!==state)return;
    const next={version:state.version,conversation:state.conversation,...(state.previousId?{previousId:state.previousId}:{})};
    if(state.previousId&&sample)remember();
    await showProject(d,false,{prompt:state.prompt,iteration:next});
  }catch(error){
    if(draft!==state)return;
    state.busy=false;setDraftBusy(state);renderDiscussion(state,error?.message||'设计服务暂时无法连接。');
  }
}
function startDraft(mode,prompt,feedback=''){
  if(draft)return;
  const revision=mode==='revision';
  const conversation=revision?structuredClone(iteration.conversation):[];
  const discussionStart=conversation.length;
  if(revision)conversation.push({role:'user',text:feedback});
  const state={mode,prompt,conversation,discussionStart,version:revision?iteration.version+1:1,
    baseDesign:revision?structuredClone({...design,summary:design.summary||design.name,steps:Array.isArray(design.steps)?design.steps:[]}):null,previousId:revision?projectId:null,
    controller:new AbortController(),panel:$(revision?'#revision-conversation':'#entry-conversation')};
  draft=state;requestDraft(state,'discuss');
}
$('#intent').onsubmit=e=>{
  e.preventDefault();const p=$('#wish').value.trim();const local=localUrl(caps.localUrl);
  if(!caps.ai&&local){const u=new URL(local);if(p)u.hash=new URLSearchParams({wish:p}).toString();window.open(u.href,'_blank','noopener,noreferrer');return}
  if(!p){$('#wish').focus();notice('#entry-notice','先写一句你想实现的功能。');return}
  notice('#entry-notice');startDraft('new',p);
};
async function openFistExample(){
 stopDraft();const run=++generation;
 try{
  const res=await fetch(new URL('./samples/fist-bump.json',import.meta.url));
  if(!res.ok)throw Error();
  const example=await res.json();
  if(run===generation)await showProject(example.design,true,{prompt:example.prompt,exampleAsset:'fist-bump'});
 }catch{if(run===generation)notice('#entry-notice','碰拳示例暂时无法打开，请刷新后重试。')}
}
$('#fist-example').onclick=openFistExample;
async function openStatusExample(){
  stopDraft();const run=++generation;
  try{const d=await sampleDesign();if(run===generation)await showProject(d,true,{exampleAsset:'status-light'})}
  catch(err){if(run===generation)notice('#entry-notice',err.message||'示例暂时无法打开。')}
}
$('#sample').onclick=openStatusExample;
const measure=p=>Array.isArray(p.sizeMm)&&p.sizeMm.length===3&&p.sizeMm.every(x=>Number.isFinite(Number(x))&&Number(x)>0)?p.sizeMm.map(Number):null;
const selected=r=>r.candidates[r.choice]||null;
function disposeViewer(){try{cadDispose?.()}finally{cadDispose=null}}
function mount(){
  disposeViewer();const target=$('#cad-panel'),badge=$('#geometry-state'),declared=!!design?.cadPlan?.bodies?.length;let active=true;
  const onStatus=({phase,mode,message,exact,engine})=>{
    if(!active||!badge?.isConnected)return;
    const names={closed:'外观',open:'开盖',inside:'内部布局',references:'未定位件'};
    const messages={parts:'正在加载零件几何',enclosure:'正在构建内外结构',ready:declared?(exact?'实体几何已完成'+(engine?' · '+engine:''):'近似形体已显示，尚未确认实体几何'):'参考布局已显示',error:declared?'实体建模未完成':'未能生成三维预览',empty:'没有可预览的结构',view:'已切换到'+(names[mode]||'当前视图')};
    badge.dataset.phase=phase;badge.textContent=[messages[phase]||'正在准备三维预览',message].filter(Boolean).join(' · ');
    target.setAttribute('aria-busy',String(['parts','enclosure'].includes(phase)));
  };
  const sourceButton=$('#download-forge');
  sourceButton.hidden=true;
  if(declared){
    try{
      const plan=currentCadPlan(design);
      if(plan.bodies.length){
        const source=cadPlanToForgeScript(plan),filename=design.name.replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,80)||'assembly';
        sourceButton.hidden=false;
        sourceButton.onclick=()=>{
          const url=URL.createObjectURL(new Blob([source],{type:'text/javascript;charset=utf-8'}));
          const a=document.createElement('a');a.href=url;a.download=filename+'.forge.js';a.click();
          setTimeout(()=>URL.revokeObjectURL(url),1500);
        };
      }
    }catch{sourceButton.hidden=true}
  }
  try{onStatus({phase:'parts'});const cleanup=mountConsumerCad(target,design,{onStatus,engine:caps.cadEngine,exampleAsset:exampleAsset==='fist-bump'?exampleAsset:null});cadDispose=()=>{active=false;cleanup?.()}}
  catch(error){onStatus({phase:'error',message:error?.message||'当前设备暂时无法显示三维预览。'});target.replaceChildren()}
}
async function showProject(d,isSample,record={}){if(!d||!Array.isArray(d.parts)||!d.parts.length)throw Error('没有收到可用的零件方案，请换个描述再试。');stopDraft();iteration=readIteration(record);generation++;const run=generation;cartVersion++;cartBusy=false;design=structuredClone(d);exampleAsset=(isSample||d.generation?.provider==='sample')&&['fist-bump','status-light'].includes(record.exampleAsset)?record.exampleAsset:null;progress();sample=isSample||d.generation?.provider==='sample';projectId=record.id||crypto.randomUUID();projectPrompt=typeof record.prompt==='string'?record.prompt:'';rows=design.parts.map((p,i)=>{const prev=record.selected?.[i],c=prev?.candidate&&productUrl(prev.candidate.url)?prev.candidate:null;return {candidates:c?[c]:[],choice:c?0:-1,manual:c,searchUrl:defaultSearch(p),searching:!c,serial:0,holdKey:prev?.holdKey||'',holdStatus:prev?.holdStatus||'',included:prev?.included!==false}});entry.hidden=true;project.hidden=false;$('#back').hidden=false;project.innerHTML=`<div class="result-head"><div>${sample?'<p class="kicker">示例设计</p>':''}<h1>${esc(design.name)}</h1><p>${esc(design.summary)}</p><div class="result-provenance">${provenance(design)}<span id="version-label">第 ${iteration.version} 版</span>${iteration.previousId?'<button id="previous-version" type="button" class="discussion-link">查看上一版</button>':''}</div><small id="save-status" role="status"></small></div></div><section class="revision-panel" aria-label="继续修改方案"><form id="revision-form"><label for="revision-prompt">继续修改</label><div class="revision-row"><textarea id="revision-prompt" maxlength="1800" rows="2" placeholder="例如：把外壳做矮一点，保留现在的交互方式。"></textarea><button class="primary" type="submit" id="revise-design">更新设计</button></div></form><p id="revision-status" role="status"></p><div id="revision-conversation" aria-live="polite"></div>${revisionHistory()}</section><div class="split"><section class="drawing-pane"><div class="pane-label"><h2>结构预览</h2><span class="geometry-origin">${esc(planOrigin(design))}</span></div><p class="geometry-state" id="geometry-state" role="status" aria-live="polite"></p><div id="cad-panel" aria-label="可旋转的结构预览"></div><button type="button" class="small-button" id="download-forge" hidden>下载 ForgeCAD 整机源文件</button></section><section class="shopping"><div class="pane-label"><h2>零件清单</h2><span>${rows.length} 项</span></div><div id="shopping-cart"><div class="purchase-head"><div><b>淘宝采购</b><small id="buy-summary"></small></div><button type="button" id="buy" class="primary">一键淘宝加购</button></div><div id="cart-feedback" aria-live="polite"></div><details class="cart-helper"><summary>使用自己的淘宝购物车</summary><div id="helper-info"></div></details></div><div id="items"></div></section></div>`;await capabilitiesReady;if(generation!==run)return;
  const revisionField=$('#revision-prompt');
  if(incomingRevision){revisionField.value=incomingRevision;incomingRevision='';revisionField.focus({preventScroll:true})}
  if(!caps.ai&&localUrl(caps.localUrl))$('#revise-design').textContent=exampleAsset?'在本机继续修改 ↗':'在本机新建设计 ↗';
  mount();renderList();syncCart();window.scrollTo(0,0);if(!sample&&!record.id)remember();const queue=rows.flatMap((r,i)=>r.searching?[i]:[]);await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length&&generation===run){await lookup(queue.shift(),run)}}))}
async function lookup(i,run){const p=design.parts[i],r=rows[i],serial=++r.serial;r.searching=true;try{const x=await findProducts(p);if(run!==generation||serial!==r.serial)return;r.searchUrl=market(x?.searchUrl)?.href||defaultSearch(p);r.candidates=(x?.candidates||[]).filter(c=>productUrl(c?.url));r.choice=r.candidates.length===1?0:-1}catch{if(run!==generation||serial!==r.serial)return;r.searchUrl=defaultSearch(p)}finally{if(run===generation&&serial===r.serial){r.searching=false;refreshRow(i);syncCart()}}}
function card(i){const p=design.parts[i],r=rows[i],c=selected(r),dims=measure(p);const status=c&&r.holdKey===skuKey(c)?(r.holdStatus==='added'?'已确认加购':'请核对购物车'):r.searching?'查找中':(!c?r.candidates.length?'待选商品':'待匹配':c.skuId&&!c.requiresSelection&&(c.sku||c.options?.length)?'已选规格':'待核对规格');const edit=`<details class="edit"><summary>尺寸与采购规格</summary><p class="measure">${dims?`${dims.map(esc).join(' × ')} mm · ${sourceText(p.dimensionSource)}`:'暂无尺寸'}${p.dimensionNote?' · '+esc(p.dimensionNote):''}</p><form data-edit="${i}"><label>固定采购型号或规格<input name="spec" maxlength="240" value="${esc(p.spec)}" placeholder="例如：6 × 6 mm 轻触开关"></label><fieldset><legend>外形尺寸（毫米）</legend><div class="dims">${['长','宽','高'].map((a,j)=>`<label>${a}<input type="number" name="dim${j}" step="any" min="0.1" max="2000" value="${esc(dims?.[j]??'')}"></label>`).join('')}</div></fieldset><label>淘宝商品链接（可选）<input type="url" name="url" placeholder="粘贴淘宝或天猫商品详情链接" value="${esc(r.manual?.url||c?.url||'')}"></label><label>详情页商品标题（可选）<input name="listingTitle" maxlength="250" placeholder="可粘贴商品页面的原始标题" value="${esc(knownTitle(r.manual||c))}"></label><label>商品页的规格选项（可选）<input name="skuOptions" maxlength="300" placeholder="按淘宝选项原文填写，多项用分号隔开" value="${esc((r.manual?.options||c?.options||[]).join('；'))}"></label><div class="edit-actions"><small class="edit-note" role="status"></small><button class="small-button" type="submit">保存并更新设计</button></div></form></details>`;
return `<article class="part" data-i="${i}"><div class="part-top"><div class="part-name"><label class="part-check" title="加入本次采购"><input class="include" type="checkbox" aria-label="采购${esc(p.name)}" ${r.included?'checked':''}></label><h3>${esc(p.name)}</h3></div><span class="qty">× ${esc(p.qty||1)}</span></div><p class="spec">${esc(modelText(p)||'按设计规格选择')}</p><div class="part-links"><span class="tag ${c?.skuId?'matched':''}">${status}</span>${c?shopLink(c.url,'商品详情'):''}${shopLink(r.searchUrl||defaultSearch(p),'淘宝精确搜索')}${caps.cart==='browser'?`<button type="button" class="picker" data-pick="${i}" ${r.picking?'disabled':''}>${r.picking?'等待选择…':'去淘宝选规格'}</button>`:''}</div>${r.pickNote?`<p class="pick-note" role="status">${esc(r.pickNote)}</p>`:''}${r.candidates.length>1?`<label class="product-select">匹配商品<select aria-label="${esc(p.name)}的匹配商品" data-product="${i}"><option value="">选择商品</option>${r.candidates.map((v,j)=>`<option value="${j}" ${j===r.choice?'selected':''}>${esc(v.title||'淘宝商品')}${v.sku?' · '+esc(v.sku):''}</option>`).join('')}</select></label>`:''}${c?`<p class="candidate-title">${esc(knownTitle(c)||c.title||'已绑定商品')}${c.sku?' · '+esc(c.sku):''}${c.selectionNote?' · '+esc(c.selectionNote):''}</p>`:''}${edit}</article>`}
function renderList(){$('#items').innerHTML=rows.map((_,i)=>card(i)).join('')}
function refreshRow(i){const old=document.querySelector(`.part[data-i="${i}"]`);if(!old)return;const expanded=old.querySelector('details').open;const before=expanded?old.querySelector('details'):null;const template=document.createElement('template');template.innerHTML=card(i);const next=template.content.firstElementChild;if(before)next.querySelector('details').replaceWith(before);old.replaceWith(next)}
function clearFeedback(){cartVersion++;$('#cart-feedback')?.replaceChildren()}
const sameItem=(a,b)=>{const x=productUrl(a),y=productUrl(b);return !!x&&!!y&&x.hostname===y.hostname&&x.searchParams.get('id')===y.searchParams.get('id')};
const knownTitle=c=>c?.listingTitle||((c?.titleSource==='page'||c?.titleSource==='user')?c.title:'')||'';
const skuKey=c=>{const u=productUrl(c?.url);return u?[u.searchParams.get('id'),c.skuId||u.searchParams.get('skuId')||'',...(c.options||[c.sku||''])].join(':'):''};
function updateGeometry(p,dimensionsSupplied){
  if(!measure(p))return;
  p.modelId=null;p.modelSourceInvalidated=true;
  if(dimensionsSupplied){p.dimensionSource='specified';p.dimensionNote='已更换采购规格，按本次指定的尺寸重新布局。'}
  else {p.dimensionSource='estimated';p.dimensionNote='已换商品规格，当前沿用设计尺寸，待核对所选规格。'}
}
function reflectSelection(p,before,after,{dimensionsSupplied=false,specChanged=false,firstPick=false}={}){
  const changed=!!after&&(before?skuKey(before)!==skuKey(after):firstPick);
  if(specChanged||changed)updateGeometry(p,dimensionsSupplied);
  return specChanged||changed;
}
function interruptPick(r){r.pickSerial=(r.pickSerial||0)+1;r.picking=false;r.pickNote=''}
async function pickForRow(i){
  if(caps.cart!=='browser'||cartBusy)return;
  const r=rows[i],p=design.parts[i],old=selected(r),run=generation,token=(r.pickSerial||0)+1;
  if(r.picking||rows.some(other=>other.picking))return;
  r.pickSerial=token;r.picking=true;r.pickNote='在淘宝选好规格后，点击浏览器里的 FormBench 助手带回。';
  // A slow catalog request must not overwrite an explicitly picked SKU.
  r.serial++;r.searching=false;
  const active=()=>generation===run&&rows[i]===r&&r.pickSerial===token;
  refreshRow(i);syncCart();
  try{
    const result=await pickProduct(p,old?.url);if(!active())return;
    const c=result?.candidate;
    if(!c||!productUrl(c.url)){r.pickNote=result?.reason||'没有带回有效的淘宝商品，已保留之前的选择。';return}
    const changed=reflectSelection(p,old,c,{firstPick:true});
    r.manual=c;r.candidates=[c];r.choice=0;r.searchUrl=defaultSearch(p);
    r.pickNote=c.skuId&&c.options?.length?'已带回所选规格，采购数量保持不变。':'已带回商品，具体规格仍需确认。';
    const edit=document.querySelector(`.part[data-i="${i}"] details`);if(edit)edit.open=false;
    clearFeedback();if(changed)mount();remember();
  }catch(error){if(active())r.pickNote=error?.message||'没有完成选择，已保留原商品。'}
  finally{if(active()){r.picking=false;refreshRow(i);syncCart()}}
}
function cartSelection(){
  const included=rows.flatMap((r,i)=>r.included?[{part:design.parts[i],item:selected(r),row:r}]:[]);
  const linked=included.filter(x=>x.item),ready=linked.filter(({item:c})=>c.skuId&&!c.requiresSelection&&(c.options?.length||c.sku));
  return {included,linked,fresh:linked.filter(x=>x.row.holdKey!==skuKey(x.item)),ready,pending:linked.filter(x=>!ready.includes(x)),unmatched:included.length-linked.length};
}
function syncCart(){
  const browser=caps.cart==='browser';const {included,linked,fresh,ready,pending,unmatched}=cartSelection(),loading=rows.some(r=>r.included&&r.searching);
  $('#buy-summary').textContent=loading?'正在匹配商品…':!included.length?'尚未勾选零件。':[`已勾选 ${included.length} 项`,`${ready.length} 项规格就绪`,...(pending.length?[`${pending.length} 项待选规格`]:[]),...(unmatched?[`${unmatched} 项待匹配`]:[])].join(' · ');
  $('#items').inert=cartBusy;const picking=rows.some(r=>r.picking);project.querySelectorAll('[data-pick]').forEach(b=>b.disabled=picking||cartBusy);const info=$('#helper-info');if(info&&info.dataset.browser!==String(browser)){info.dataset.browser=String(browser);info.innerHTML=browser?'已连接淘宝助手。它会先显示本次清单，经你确认后在自己的淘宝账号中逐项处理。':'<p>桌面 Chrome 或 Edge：<a href="./taobao-helper.zip" download>下载淘宝购物助手</a>，解压后，在 <code>chrome://extensions</code>（Edge 用 <code>edge://extensions</code>）打开开发者模式，选择「加载已解压的扩展」，再刷新此页。</p><p>手机可直接进入每件商品的淘宝详情页确认规格。</p>'}
  $('#buy').disabled=cartBusy||picking||!(browser?fresh:linked).length;$('#buy').textContent=cartBusy?'正在处理…':browser?(fresh.length?`在我的浏览器加购 ${fresh.length} 项`:linked.length?'先核对淘宝购物车':'在我的浏览器加购'):ready.length?`去淘宝加购 ${ready.length} 项`:linked.length?`去淘宝选规格 ${linked.length} 项`:'去淘宝加购';
}
project.addEventListener('change',e=>{const el=e.target,i=Number(el.closest('.part')?.dataset.i),r=rows[i];if(!r)return;if(el.matches('.include'))r.included=el.checked;else if(el.matches('[data-product]')){interruptPick(r);const was=selected(r);r.choice=el.value===''?-1:Number(el.value);const next=selected(r);if(reflectSelection(design.parts[i],was,next,{firstPick:true}))mount();refreshRow(i)}else return;remember();clearFeedback();syncCart()});
project.addEventListener('submit',e=>{
  if(e.target.matches('#revision-form')){
    e.preventDefault();const field=$('#revision-prompt'),feedback=field.value.trim();
    if(!caps.ai&&localUrl(caps.localUrl)){
      const target=new URL(localUrl(caps.localUrl));
      if(exampleAsset){
        target.searchParams.set('example',exampleAsset==='fist-bump'?'fist':'status');
        if(feedback)target.hash=new URLSearchParams({feedback}).toString();
      }else if(feedback){
        target.hash=new URLSearchParams({wish:feedback}).toString();
      }
      window.open(target.href,'_blank','noopener,noreferrer');
      $('#revision-status').textContent=exampleAsset?'已打开本机示例，可以在那里确认修改意见。':'本机工作室会带上本次输入，请补充原方案的要求。';
      return;
    }
    if(!feedback){field.focus();$('#revision-status').textContent='写下希望修改的地方。';return}
    if(caps.ai===false){$('#revision-status').textContent='此工作室的 AI 服务暂时不可用。';return}
    startDraft('revision',projectPrompt||design.summary||design.name,feedback);return;
  }
  if(!e.target.matches('[data-edit]'))return;e.preventDefault();const f=e.target,i=Number(f.dataset.edit),p=design.parts[i],r=rows[i],a=new FormData(f),err=f.querySelector('.edit-note');const raw=a.get('url').trim(),u=raw?productUrl(raw):null;if(raw&&!u){err.textContent='请粘贴带商品 id 的淘宝或天猫详情链接。';return}const dims=[0,1,2].map(j=>String(a.get('dim'+j)).trim()),spec=String(a.get('spec')).trim(),has=dims.some(Boolean);if(has&&(!dims.every(Boolean)||dims.some(v=>!Number.isFinite(Number(v))||Number(v)<0.1||Number(v)>2000))){err.textContent='请补齐三个 0.1–2000 mm 的尺寸。';return}interruptPick(r);const old=selected(r);const specChanged=spec!==String(p.spec||''),dimChanged=JSON.stringify(has?dims.map(Number):null)!==JSON.stringify(measure(p));if(dimChanged){p.modelSourceInvalidated=true;p.sizeMm=has?dims.map(Number):null;p.dimensionSource=has?'specified':'estimated';p.dimensionNote=has?'按指定尺寸重新布局。':''}if(specChanged){p.spec=spec;p.model=spec;p.modelId=null}let needLookup=false;if(u){const skuId=u.searchParams.get('skuId');r.serial++;r.searching=false;const options=String(a.get('skuOptions')||'').split(/[;；]/).map(v=>v.trim()).filter(Boolean);const previous=r.candidates.find(k=>sameItem(k.url,u.href));
const given=String(a.get('listingTitle')||'').trim(),fromOther=old&&!sameItem(old.url,u.href)&&given===knownTitle(old);
const listingTitle=(!fromOther&&given)||knownTitle(previous);
r.manual={title:listingTitle||previous?.title||('商品编号 '+u.searchParams.get('id')),titleSource:listingTitle?'user':(previous?.titleSource||'label'),listingTitle,url:u.href,...(skuId?{skuId}:{}),...(options.length?{sku:options.join(' / '),options}:{})};r.candidates=[r.manual];r.choice=0;r.searchUrl=defaultSearch(p)}else if(specChanged||r.manual){r.serial++;r.manual=null;r.candidates=[];r.choice=-1;r.searchUrl=defaultSearch(p);r.searching=true;needLookup=true}const swapped=reflectSelection(p,old,u?r.manual:null,{dimensionsSupplied:dimChanged&&has,specChanged,firstPick:true});clearFeedback();f.closest('details').open=false;refreshRow(i);if(dimChanged||specChanged||swapped)mount();syncCart();remember();if(needLookup)void lookup(i,generation)});
function renderBrowserOutcome(target,out,batch,total,unmatched){
  const records=Array.isArray(out.items)?[...out.items]:[];
  const counts={added:0,needs_login:0,needs_selection:0,not_confirmed:0,unattempted:0,cancelled:0};
  const labels={added:'淘宝已确认加购',needs_login:'请登录淘宝',needs_selection:'请确认商品规格',not_confirmed:'结果未确认，请先核对购物车',unattempted:'尚未操作',cancelled:'已取消，未操作'};
  const output=batch.map(({part,item,row})=>{
    const u=productUrl(item.url);
    // Authenticate row identity before showing a success: receipt order alone is not sufficient.
    const at=records.findIndex(r=>{const a=productUrl(r.url);return a?.searchParams.get('id')===u.searchParams.get('id')&&String(r.skuId||a.searchParams.get('skuId')||'')===String(item.skuId||u.searchParams.get('skuId')||'')});
    const rec=at>=0?records.splice(at,1)[0]:null;
    const status=Object.hasOwn(counts,rec?.status)?rec.status:(out.state==='cancelled'?'cancelled':'not_confirmed');
    counts[status]++;
    if(status==='added'||status==='not_confirmed'){row.holdKey=skuKey(item);row.holdStatus=status;refreshRow(rows.indexOf(row))}
    return `<li><b>${esc(part.name)} ×${esc(part.qty||1)}</b><span>${labels[status]}</span>${rec?.message||rec?.reason?`<small>${esc(rec.message||rec.reason)}</small>`:''}${['needs_login','needs_selection'].includes(status)?shopLink(u.href,'打开商品详情'):''}</li>`;
  });
  if(counts.added||counts.not_confirmed)remember();
  const q=[`已勾选 ${total} 项`,`有成功回执 ${counts.added} 项`,...(counts.not_confirmed?[`结果未确认 ${counts.not_confirmed} 项`]:[]),...(unmatched?[`待匹配 ${unmatched} 项`]:[])].join(' · ');
  target.innerHTML=`<p>${esc(q)}</p>${out.reason?`<small>${esc(out.reason)}</small>`:''}<ul class="browser-results">${output.join('')}</ul>${shopLink(market(out.cartUrl)?.href||'https://cart.taobao.com/cart.htm','核对淘宝购物车')}`;
}
project.addEventListener('click',async e=>{
  if(e.target.closest('#previous-version')){
    const button=e.target.closest('#previous-version'),current=projectId,previous=iteration.previousId;
    stopDraft();button.disabled=true;
    try{await saveTail;const saved=await readConsumerProject(previous);if(projectId===current)await showProject(saved.design,false,saved)}
    catch(error){if(projectId===current)$('#save-status').textContent=error.message}
    finally{if(button.isConnected)button.disabled=false}return;
  }

  const picker=e.target.closest('[data-pick]');if(picker){await pickForRow(Number(picker.dataset.pick));return}if(!e.target.closest('#buy')||cartBusy||rows.some(r=>r.picking))return;
  const {included,linked,fresh,ready,pending,unmatched}=cartSelection();if(!linked.length)return;const browser=caps.cart==='browser',batch=browser?fresh:ready;
  const lines=batch.map(({part,item})=>({...item,qty:part.qty||1,options:item.options||[]}));
  const revision=cartVersion;cartBusy=true;syncCart();const target=$('#cart-feedback');
  target.textContent=browser?'请在浏览器助手中核对清单并确认，结果将逐项显示在这里。':'正在准备淘宝采购资料…';
  const detailLinks=(arr,action)=>arr.map(({item,part})=>shopLink(item.url,`${part.name} ×${part.qty||1} · ${action}`)).join('');
  try{
    const out=lines.length?await makeCart(lines):{state:'needs_selection',links:[],items:[]};if(revision!==cartVersion)return;
    if(browser&&out.state!=='links_ready'){
      renderBrowserOutcome(target,out,batch,included.length,unmatched);
      return;
    }
    const links=(out.links||[]).filter(l=>market(l.url)&&Number.isSafeInteger(l.count)&&l.count>0);
    const handed=out.state==='links_ready'?Math.min(lines.length,links.reduce((n,l)=>n+l.count,0)):0;
    const verified=0;
    const unhanded=Math.max(0,included.length-handed-verified);
    const stateMessage=handed?'已准备淘宝加购链接，请打开后在淘宝确认。':verified?'淘宝已确认加购。':out.state==='needs_login'?'请先登录淘宝，再继续加购。':out.state==='needs_selection'?'请打开商品详情页，确认所需规格。':'请打开以下商品详情，核对数量并在淘宝加购。';
    const countMessage=[`已勾选 ${included.length} 项`,handed?`${handed} 项已获得确认链接`:verified?`${verified} 项已确认加购`:'未获得官方加购链接',`未交接 ${unhanded} 项`,`待选规格 ${pending.length} 项`,...(unmatched?[`待匹配 ${unmatched} 项`]:[])].join(' · ');
    target.innerHTML=`<p>${esc(stateMessage)}</p><small>${esc(countMessage)}</small>${out.reason?`<small>${esc(out.reason)}</small>`:''}<div class="cart-links">${links.map((l,i)=>shopLink(l.url,`淘宝确认${links.length>1?' '+(i+1):''} · ${l.count} 项`)).join('')}${!handed&&!verified?detailLinks(ready,'打开商品'):''}${detailLinks(pending,'选择规格')}${market(out.cartUrl)?shopLink(out.cartUrl,'查看淘宝购物车'):''}${localUrl(out.localUrl)?shopLink(localUrl(out.localUrl),'打开本机工作室'):''}</div>`;
  }catch(err){if(browser&&revision===cartVersion){renderBrowserOutcome(target,{items:[],state:'not_confirmed'},batch,included.length,unmatched);return}if(revision===cartVersion)target.innerHTML=`<p>暂未交接这 ${included.length} 项。请到淘宝商品页核对。</p><div class="cart-links">${detailLinks(ready,'打开商品')}${detailLinks(pending,'选择规格')}</div>`}
  finally{if(target.isConnected){cartBusy=false;syncCart()}}
});

mountConsumerAccount($('#consumer-account'),{onOpen:async rec=>{if(!rec?.design)return;try{await showProject(rec.design,false,rec)}catch(e){showEntry();notice('#entry-notice',e.message||'暂时无法打开项目。')}},onSignOut:()=>{accountEpoch++;showEntry();$('#wish').value=''}});

const requestedExample=new URLSearchParams(location.search).get('example');
if(requestedExample==='fist')openFistExample();
else if(requestedExample==='status')openStatusExample();
