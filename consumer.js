import {userProgress} from './consumer-progress.js';
import {mountQuestions} from './consumer-intake.js';
import {discussDesign,generateDesign,loadCompletedDesignJob,findProducts,partSearchTerms,pickProduct,makeCart,serviceCapabilities,sampleDesign} from './consumer-service.js';
import {pendingDesignJob} from './consumer-jobs.js';
import {mountConsumerAccount,saveConsumerProject,readConsumerProject} from './consumer-account.js';
import {currentCadPlan,mountConsumerCad} from './consumer-cad.js';
import {buildAssemblyWiring} from './assembly-wires.js';
import {factoryInterfaces} from './part-records.js';
import {photoPicker,versionImages} from './consumer-design-images.js';
import {galleryAsset,loadSharedProject,mountGallery,shareLink,sharedProjectBar,showShareDialog} from './consumer-gallery.js';
const $=s=>document.querySelector(s),entry=$('#entry'),project=$('#project');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const modelText=p=>[p.model,p.spec].filter(x=>typeof x==='string'&&x.trim()).filter((v,i,a)=>a.indexOf(v)===i).join(' · ');
const sourceText=s=>({catalog:'参考模型',cad:'CAD 文件尺寸',datasheet:'型号资料尺寸',estimated:'设计估算',specified:'已指定尺寸'}[s]||'尚未指定');
const safeUrl=v=>{try{const u=new URL(v);return u.protocol==='https:'||u.protocol==='http:'?u:null}catch{return null}};
const market=v=>{const u=safeUrl(v);return u?.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(?:^|\.)(?:taobao|tmall)\.com$/i.test(u.hostname)?u:null};
const productUrl=v=>{const u=market(v);return u&&/^(?:item\.taobao|detail\.tmall)\.com$/i.test(u.hostname)&&u.pathname==='/item.htm'&&u.searchParams.getAll('id').length===1&&u.searchParams.getAll('skuId').length<=1&&/^\d{1,25}$/.test(u.searchParams.get('id')||'')&&(!u.searchParams.has('skuId')||/^\d{1,25}$/.test(u.searchParams.get('skuId')))?u:null};
const localUrl=v=>{const u=safeUrl(v);return u&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)?u.href:''};
const shopLink=(u,label)=>`<a target="_blank" rel="noopener noreferrer" href="${esc(u)}">${esc(label)} <span aria-hidden="true">↗</span></a>`;
const defaultSearch=p=>'https://s.taobao.com/search?q='+encodeURIComponent(partSearchTerms(p)||[p.name,p.model,p.spec].filter(x=>typeof x==='string').join(' '));
let design=null,rows=[],generation=0,cadDispose=null,cartBusy=false,sample=false,caps={},cartVersion=0;
let exampleAsset=null,projectId=null,projectPrompt='',saveSerial=0,accountEpoch=0,saveTail=Promise.resolve();
let sharedProject=null,savedCadUrl=null,copyOrigin=null;
const firstFistVersion='builtin:fist-bump:v1';
const fistAsset=asset=>asset==='fist-bump'||asset==='fist-bump-v1';
function syncExampleUrl(example='',version=null){
  const url=new URL(location.href);
  const wasShared=url.searchParams.has('share');
  url.searchParams.delete('share');
  url.searchParams.delete('job');
  if(example){
    url.searchParams.set('example',example);
    if(version!=null)url.searchParams.set('version',String(version));
    else url.searchParams.delete('version');
  }else if(wasShared||['fist','status'].includes(url.searchParams.get('example'))){
    url.searchParams.delete('example');url.searchParams.delete('version');url.searchParams.delete('view');
  }
  history.replaceState(history.state,'',url);
}
let iteration={version:1,conversation:[]}, draft=null;
const entryPhotos=photoPicker($('#intent'),'new-design-images',()=>caps);
let revisionPhotos=null;
function readIteration(record){
  const value=record.iteration;
  const conversation=Array.isArray(value?.conversation)?value.conversation.filter(t=>['assistant','user'].includes(t?.role)&&typeof t.text==='string'&&t.text.trim()):[];
  return {version:Number.isSafeInteger(value?.version)&&value.version>0?value.version:1,conversation,
    ...(Number.isInteger(value?.imageCount)&&value.imageCount>0&&value.imageCount<=3?{imageCount:value.imageCount}:{}),
    ...(typeof value?.previousId==='string'?{previousId:value.previousId}:{})};
}
function revisionHistory(){
  if(!projectPrompt&&!iteration.conversation.length)return '';
  const original=projectPrompt?`<li><b>原始需求</b><span>${esc(projectPrompt)}</span></li>`:'';
  const turns=iteration.conversation.map(t=>`<li><b>${t.role==='assistant'?'AI':'你'}</b><span>${esc(t.text)}</span></li>`).join('');
  return `<details class="iteration-history"><summary>设计记录</summary><ol>${original}${turns}</ol></details>`;
}
function remember(attachmentsReady){
  if(!design||!projectId||sharedProject)return;
  const snap=structuredClone({id:projectId,prompt:projectPrompt,iteration,exampleAsset,savedCadUrl,copyOrigin,design,selected:rows.map(r=>({included:r.included,candidate:selected(r),holdKey:r.holdKey||'',holdStatus:r.holdStatus||''}))});
  const epoch=accountEpoch,seq=++saveSerial;
  saveTail=saveTail.then(async()=>{if(attachmentsReady)await attachmentsReady;if(epoch!==accountEpoch)return;try{await saveConsumerProject(snap)}catch{if(seq===saveSerial&&snap.id===projectId){const note=$('#save-status');if(note)note.textContent='项目暂未保存。'}}});
}
function notice(id,msg='',href='',label=''){const el=$(id);if(el)el.innerHTML=msg?`<p class="notice">${esc(msg)} ${href?shopLink(href,label):''}</p>`:''}
const localPrompt=()=>{try{if(!['127.0.0.1','localhost','[::1]'].includes(location.hostname))return;const incoming=new URLSearchParams(location.hash.slice(1)).get('wish');if(incoming){const mode=new URLSearchParams(location.hash.slice(1)).get('provider');if(['auto','openai-api','local-codex'].includes(mode))$('#run-provider').value=mode;$('#wish').value=incoming.slice(0,1800);history.replaceState(null,'',location.pathname+location.search)}}catch{}};
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
function capabilityHint(){if(!$('#entry-progress').hidden)return;const href=localUrl(caps.localUrl);if(caps.ai===false&&href){$('#generate').textContent='在本机生成';notice('#entry-notice','此页面可直接查看示例。生成新方案将在已启动的本机工作室继续。')}else if(caps.ai===false){notice('#entry-notice','此设备还没有接好设计服务，可以先查看示例。');$('#generate').disabled=true}}
function generationLabel(provider=caps.aiProvider){
 const who={'local-codex':'本机 Codex','openai-api':'OpenAI API'}[provider]||'设计服务';
 if(provider!==caps.aiProvider)return who;
 return caps.aiModel?`${who} · 请求模型：${caps.aiModel}`:`${who} · 当前未公开模型名`;
}
const capabilitiesReady=serviceCapabilities().then(v=>{caps=v||{};entryPhotos.refresh();revisionPhotos?.refresh();const model=$('#selected-model');model.hidden=!caps.ai;model.textContent=caps.ai?generationLabel():'';if(!entry.hidden)capabilityHint();else if($('#buy')){rows.forEach((_,i)=>refreshRow(i));syncCart()}}).catch(()=>{});
function showEntry(){stopDraft();if(caps.ai)$('#selected-model').textContent=generationLabel();entryPhotos.clear();revisionPhotos=null;syncExampleUrl();progress();projectId=null;projectPrompt='';design=null;sharedProject=null;savedCadUrl=null;copyOrigin=null;generation++;cartVersion++;cartBusy=false;cadDispose?.();cadDispose=null;entry.hidden=false;project.hidden=true;project.replaceChildren();$('#back').hidden=true;$('#generate').disabled=false;$('#generate').textContent='生成设计';$('#sample').disabled=false;notice('#entry-notice');capabilityHint();window.scrollTo(0,0);$('#wish').focus()}
$('#back').onclick=()=>{showEntry();$('#wish').value=''};
function progress(phase){
  const node=$('#entry-progress');node.hidden=!phase;$('#intent').setAttribute('aria-busy',String(!!phase));
  if(!phase)return;
  node.dataset.phase=typeof phase==='object'?phase.stage:phase;
  const {title,hint}=userProgress(phase);$('#build-title').textContent=title;$('#build-hint').textContent=hint;
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
  const projectGuide=g.skill?.project?.name==='interaction-hardware'?` · 装配建模规范 ${esc(g.skill.project.revision)}`:'';
  return `<span class="model-stamp">${esc(path)} · ${esc(evidence)}${skill}${projectGuide}</span>${g.reviewNote?`<details class="review-note"><summary>几何复核</summary><p>${esc(g.reviewNote)}</p></details>`:''}`;
}
function setDraftBusy(state,phase=''){
  const initial=state.mode==='new';
  state.photoInput?.lock(!!draft);
  const field=$(initial?'#wish':'#revision-prompt');
  const submit=$(initial?'#generate':'#revise-design');
  if(field)field.readOnly=!!draft;
  if(submit)submit.disabled=!!draft;
  if(initial){
    if(phase?.provider)$('#selected-model').textContent=generationLabel(phase.provider);
    progress(phase);
    if(phase==='discuss'){
      $('#build-title').textContent='正在读取需求';
      $('#build-hint').textContent='';
    }
    if(submit)submit.textContent=phase?'处理中…':state?.question?'等你回复':'生成设计';
  }else if($('#revision-status')){
    $('#revision-status').textContent=typeof phase==='object'?userProgress(phase).title:{discuss:'正在阅读你的修改意见…',request:'正在更新零件与 CAD 方案…',response:'已收到新版方案。'}[phase]||'';
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
  const reviewLink=/^[a-f0-9-]{36}$/.test(state.jobId||'')?`<a class="discussion-link" id="review-draft" href="./design-review.html?job=${state.jobId}">查看草稿与记录</a>`:'';
  if(state.busy){
    panel.innerHTML='<div class="discussion-controls">'+cancel+'</div>';
    panel.querySelector('#cancel-discussion').onclick=stopDraft;
    return;
  }
  if(['providers-exhausted','codex-quota','api-billing'].includes(state.stopReason)){
    panel.innerHTML=`<div class="discussion-card"><b>生成已停止</b><p role="alert">${esc(error)}</p><div class="discussion-controls">${reviewLink}<button type="button" class="discussion-link" id="close-stopped">返回编辑</button></div></div>`;panel.querySelector('#close-stopped').onclick=stopDraft;return;
  }
  if(state.repairCandidate){
    panel.innerHTML=`<div class="discussion-card"><h3>方案尚未通过评审</h3>${error?`<p role="alert" class="discussion-error">${esc(error)}</p>`:''}<details><summary>查看检查结果</summary><ul>${state.repairCandidate.issues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul></details><p>本次需求和照片已保留。修订后会重新检查，当前草稿尚未保存为项目。</p><div class="discussion-controls">${reviewLink}<button type="button" class="small-button" id="repair-discussion">按评审意见修订</button>${cancel}</div></div>`;
    panel.querySelector('#repair-discussion').onclick=()=>requestDraft(state,'generate');
    panel.querySelector('#cancel-discussion').onclick=stopDraft;
    return;
  }
  if(state.question){
    panel.replaceChildren();
    const card=document.createElement('div');card.className='discussion-card';panel.append(card);
    mountQuestions(card,state.question.questions,replies=>{
      if(draft!==state||state.busy)return;
      for(const {question:q,answer,delegated} of replies){
        const asked=q.options.length?q.question+'（'+q.options.join(' / ')+'）':q.question;
        state.conversation.push({role:'assistant',text:asked,...(q.topic?{topic:q.topic}:{})},
          {role:'user',text:answer,...(delegated?{delegated:true}:{})});
      }
      state.question=null;requestDraft(state,'discuss');
    },stopDraft);
    return;
  }
  panel.innerHTML=`<div class="discussion-card">${error?`<p role="alert" class="discussion-error">${esc(error)}</p>`:''}<div class="discussion-controls"><button type="button" class="small-button" id="retry-discussion">重试</button><button type="button" id="skip-discussion" class="discussion-link">按现有需求开始</button>${cancel}</div></div>`;
  panel.querySelector('#cancel-discussion').onclick=stopDraft;
  panel.querySelector('#skip-discussion').onclick=()=>requestDraft(state,'generate');
  panel.querySelector('#retry-discussion').onclick=()=>requestDraft(state,state.lastAction);
}
async function requestDraft(state,action){
  if(draft!==state||state.busy)return;
  state.busy=true;state.lastAction=action;
  const signal=state.controller.signal;
  setDraftBusy(state,action==='discuss'?'discuss':'request');renderDiscussion(state);
  try{
    state.images??=await state.photoInput?.selected()??[];
    if(draft!==state)return;
    const context={...(state.policy?{provider:state.policy}:{}),prompt:state.prompt,conversation:state.conversation,discussionStart:state.discussionStart,...(state.baseDesign?{baseDesign:state.baseDesign}:{}),...(state.images.length?{images:state.images}:{}),...(state.repairCandidate?{repairCandidate:state.repairCandidate}:{})};
    let d;
    if(action==='discuss'){
      const decision=await discussDesign(context,signal);
      if(draft!==state)return;
      if(decision.decision==='ask'){
        state.question=decision;
        state.busy=false;setDraftBusy(state);renderDiscussion(state);return;
      }
      d=decision.design;
    }
    if(!d){
      state.lastAction='generate';
      d=await generateDesign(state.prompt,{context,signal,iterative:caps.designJobs,onProgress:phase=>{if(draft===state)setDraftBusy(state,phase)}});
    }
    if(draft!==state)return;
    const next={version:state.version,conversation:state.conversation,...(state.images.length?{imageCount:state.images.length}:{}),...(state.previousId?{previousId:state.previousId}:{})};
    if(state.previousId&&sample)remember();
    await showProject(d,false,{prompt:state.prompt,iteration:next,...(d.generation?.cadUrl?{savedCadUrl:new URL(d.generation.cadUrl,location.origin).href}:{})},state.images);
  }catch(error){
    if(draft!==state)return;
    if(error?.jobId)state.jobId=error.jobId;
    if(error?.repairCandidate){state.repairCandidate=error.repairCandidate;state.question=null;}
    state.stopReason=error?.actionRequired;state.busy=false;setDraftBusy(state);renderDiscussion(state,error?.message||'设计服务暂时无法连接。');
  }
}
function startDraft(mode,prompt,feedback=''){
  if(draft)return;
  const revision=mode==='revision';
  const conversation=revision?structuredClone(iteration.conversation):[];
  const discussionStart=conversation.length;
  if(revision)conversation.push({role:'user',text:feedback});
  const state={mode,prompt,policy:$('#run-provider')?.value||'auto',conversation,discussionStart,photoInput:revision?revisionPhotos:entryPhotos,version:revision?iteration.version+1:1,
    baseDesign:revision?structuredClone({...design,summary:design.summary||design.name,steps:Array.isArray(design.steps)?design.steps:[]}):null,previousId:revision?projectId:null,
    controller:new AbortController(),panel:$(revision?'#revision-conversation':'#entry-conversation')};
  draft=state;requestDraft(state,'discuss');
}
$('#intent').onsubmit=e=>{
  e.preventDefault();const p=$('#wish').value.trim();const local=localUrl(caps.localUrl);
  if(!caps.ai&&local){const u=new URL(local);if(p)u.hash=new URLSearchParams({wish:p,...($('#run-provider')?.value&&$('#run-provider').value!=='auto'?{provider:$('#run-provider').value}:{})}).toString();window.open(u.href,'_blank','noopener,noreferrer');return}
  if(!p){$('#wish').focus();notice('#entry-notice','先写一句你想实现的功能。');return}
  notice('#entry-notice');startDraft('new',p);
};
async function openFistExample(version=null){
  stopDraft();const run=++generation;
  try{
    const historical=version===1;
    const path=historical?'./samples/fist-bump.v1.json':'./samples/fist-bump.json';
    const res=await fetch(new URL(path,import.meta.url));
    if(!res.ok)throw Error();
    const example=await res.json();
    if(run!==generation)return;
    const record={prompt:example.prompt,iteration:example.iteration,
      exampleAsset:historical?'fist-bump-v1':'fist-bump',exampleRoute:{example:'fist',version}};
    await showProject(example.design,true,record);
  }catch{
    if(run!==generation)return;
    const message='碰拳示例暂时无法打开，请刷新后重试。';
    if(project.hidden)notice('#entry-notice',message);
    else if($('#save-status'))$('#save-status').textContent=message;
  }
}
$('#fist-example').onclick=()=>openFistExample();
async function openStatusExample(){
  stopDraft();const run=++generation;
  try{const d=await sampleDesign();if(run===generation)await showProject(d,true,{exampleAsset:'status-light',exampleRoute:{example:'status'}})}
  catch(err){if(run===generation)notice('#entry-notice',err.message||'示例暂时无法打开。')}
}
$('#sample').onclick=openStatusExample;
async function openSharedProject(slug,version=null){
  stopDraft();const run=++generation;
  notice('#entry-notice','正在打开分享项目…');
  try{
    const value=await loadSharedProject(slug,version);
    if(run!==generation)return;
    await showProject(value.design,true,value.record);
    notice('#entry-notice');
  }catch(error){
    if(run!==generation)return;
    if(project.hidden)notice('#entry-notice',error.message);
    else {$('#save-status').textContent=error.message;if(sharedProject&&$('#shared-version'))$('#shared-version').value=String(sharedProject.selected.version)}
  }
}
async function openCompletedJob(id){
  stopDraft();const run=++generation;
  notice('#entry-notice','正在打开设计…');
  try{
    const {design:d,prompt}=await loadCompletedDesignJob(id);
    if(run!==generation)return;
    await showProject(d,false,{id,prompt,...(d.generation?.cadUrl?{savedCadUrl:new URL(d.generation.cadUrl,location.origin).href}:{})});
    const url=new URL(location.href);url.searchParams.set('job',id);history.replaceState(history.state,'',url);
    remember();notice('#entry-notice');
  }catch(error){if(run===generation)notice('#entry-notice',error.message);}
}
function publicProjectLink(){
  if(sharedProject)return shareLink(sharedProject.entry.slug,sharedProject.selected.version);
  if(exampleAsset&&!copyOrigin){const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('example',fistAsset(exampleAsset)?'fist':'status');url.searchParams.set('version',String(iteration.version));return url.href}
  return null;
}
const measure=p=>Array.isArray(p.sizeMm)&&p.sizeMm.length===3&&p.sizeMm.every(x=>Number.isFinite(Number(x))&&Number(x)>0)?p.sizeMm.map(Number):null;
const selected=r=>r.candidates[r.choice]||null;
function disposeViewer(){try{cadDispose?.()}finally{cadDispose=null}}
function mount(){
  disposeViewer();const info=$('#functional-details');if(info)info.innerHTML=functionalDetails(design);
  const target=$('#cad-panel'),badge=$('#geometry-state'),declared=!!design?.cadPlan?.bodies?.length;let active=true;
  const retry=$('#retry-model');
  retry.hidden=true;retry.onclick=mount;
  const onStatus=({phase,mode,message,exact,engine})=>{
    if(!active||!badge?.isConnected)return;
    const names={closed:'外观',open:'开盖',inside:'内部布局',references:'未定位件'};
    const messages={parts:'正在加载零件几何',enclosure:'正在构建内外结构',ready:declared?(exact?'实体几何已完成'+(engine?' · '+engine:''):'近似形体已显示，尚未确认实体几何'):'参考布局已显示',error:declared?'实体建模未完成':'未能生成三维预览',empty:'没有可预览的结构',view:'已切换到'+(names[mode]||'当前视图')};
    badge.dataset.phase=phase;badge.dataset.approximate=String(phase==='ready'&&declared&&!exact);badge.textContent=[messages[phase]||'正在准备三维预览',message].filter(Boolean).join(' · ');
    if(phase!=='view')retry.hidden=phase!=='error';
    target.setAttribute('aria-busy',String(['parts','enclosure'].includes(phase)));
  };
  const sourceButton=$('#download-forge');
  sourceButton.hidden=true;
  if(declared){
    try{
      const plan=currentCadPlan(design);
      if(plan.bodies.length){
        const filename=design.name.replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,80)||'assembly';
        sourceButton.hidden=false;
        sourceButton.disabled=false;
        const publishedPackage=galleryAsset(sharedProject?.selected.forgePackage);
        sourceButton.onclick=async()=>{
          if(publishedPackage){
            const file=document.createElement('a');file.href=publishedPackage;file.download=filename+'.zip';file.click();
            return;
          }
          sourceButton.disabled=true;
          try{
            const activeInteraction=design.parts.some(p=>p.modelSourceInvalidated)?null:design.interaction;
            const wiring=activeInteraction?buildAssemblyWiring({...design,cadPlan:plan,interaction:activeInteraction}):null;
            const {editableForgeDownload}=await import('./forge-package.js');
            const {blob,extension}=await editableForgeDownload(plan,design.parts,null,activeInteraction,wiring);
            if(!active)return;
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');a.href=url;a.download=filename+extension;a.click();
            setTimeout(()=>URL.revokeObjectURL(url),1500);
          }catch(error){if(active)badge.textContent=error.message||'整机模型下载失败。'}
          finally{if(active)sourceButton.disabled=false}
        };
      }
    }catch{sourceButton.hidden=true}
  }
  const initialMode=new URLSearchParams(location.search).get('view')==='inside'?'inside':undefined;
  try{onStatus({phase:'parts'});const cleanup=mountConsumerCad(target,design,{onStatus,initialMode,engine:caps.cadEngine,partsPanel:$('#model-components'),exampleAsset:fistAsset(exampleAsset)?exampleAsset:null,savedCadUrl});cadDispose=()=>{active=false;cleanup?.()}}
  catch(error){onStatus({phase:'error',message:error?.message||'当前设备暂时无法显示三维预览。'});target.replaceChildren()}
}
function projectDescription(text){
  const summary=String(text||'').trim();
  if(summary.length<=150)return `<p class="project-summary">${esc(summary)}</p>`;
  const sentence=summary.slice(36,145).search(/[。！？.!?]\s*/u);
  const split=sentence>=0?37+sentence:140;
  return `<p class="project-summary">${esc(summary.slice(0,split))}${sentence<0?'…':''}</p>
    <details class="description-more"><summary>完整说明</summary><p>${esc(summary)}</p></details>`;
}
function functionalDetails(d){
  const interaction=d.interaction,review=d.generation?.designReview;
  if(!interaction&&!review)return '';
  const parts=d.parts;
  const name=i=>esc(parts[i]?.name||'零件');
  const controller=interaction?.controllerPartIndex;
  const reviewList=items=>(items||[]).map(item=>`<li>${esc(item)}</li>`).join('');
  const checked=(review?.checks||[]).filter(c=>c.status==='pass');
  const physical=review?.physicalChecks||[];
  const replay=review?.behavior;
  const states=replay?.status==='replayed'?replay.visitedStates?.length:0;
  const operations=replay?.observations?.length;
  const replayNote=states&&operations?`<p>已重放 ${states} 个状态中的 ${operations} 次操作与计时事件。</p>`:'';
  const findings=review?`<details class="review-note"><summary>设计复核${review.attempts>1?' · 已修订并复查':''}</summary>
    ${review.correctedIssues?.length?`<p>生成时修订的问题</p><ul>${reviewList(review.correctedIssues)}</ul>`:''}
    <ul>${reviewList(checked.map(c=>c.note))}</ul>${replayNote}
    ${physical.length?`<p>实物待测</p><ul>${reviewList(physical)}</ul>`:''}</details>`:'';
  if(!interaction)return findings;
  const group=items=>[...new Set(items.map(x=>name(x.partIndex)))].join(' / ');
  const path=[group(interaction.controls),Number.isInteger(controller)?name(controller):'',group(interaction.outputs)].filter(Boolean).filter((v,i,a)=>!i||v!==a[i-1]).join(' → ');
  const refs=new Set([...interaction.controls.flatMap(c=>c.signalPins),...interaction.outputs.map(o=>o.signalPin),...(interaction.systemEvents||[]).flatMap(e=>e.sourcePins)]);
  const kindName={touch:'触摸面',button:'按键',display:'显示屏',clock:'实时时钟',light:'指示灯',sound:'声音输出'};
  const builtIn=factoryInterfaces(parts[controller]).filter(x=>refs.has('builtin:'+x.id)).map(x=>`<li><a href="${esc(x.sourceUrl)}" target="_blank" rel="noopener noreferrer">${kindName[x.kind]} · 查看型号资料 ↗</a></li>`).join('');
  const kinds={signal:'信号',power:'供电',ground:'共地'};
  const rows=interaction.connections.map((w,i)=>`<tr><td><button class="connection-link" type="button" data-focus-wiring="${i}" aria-label="查看${name(w.fromPartIndex)} ${esc(w.fromPin)} 到${name(w.toPartIndex)} ${esc(w.toPin)}">${kinds[w.kind]} ↗</button></td><td>${name(w.fromPartIndex)} <code>${esc(w.fromPin)}</code></td><td>${name(w.toPartIndex)} <code>${esc(w.toPin)}</code></td></tr>`).join('');
  return `<section class="functional-details" aria-label="交互原理"><h3>交互原理</h3><p>${path}</p>
    ${Number.isInteger(controller)?`<p>主控型号 · ${esc(parts[controller]?.model||parts[controller]?.name||'待选型')}</p>`:''}
    ${builtIn?`<details><summary>主控自带的功能</summary><ul>${builtIn}</ul></details>`:''}
    <div class="model-navigation">
      ${rows?'<button class="small-button" type="button" data-focus-wiring>查看内部接线</button>':''}
      ${Number.isInteger(controller)?`<button class="small-button" type="button" data-focus-controller="${controller}">在模型中查看控制板</button>`:''}
    </div>
    ${rows?`<details><summary>引脚连接方案 · ${interaction.connections.length} 项</summary><table><thead><tr><th>用途</th><th>起点</th><th>终点</th></tr></thead><tbody>${rows}</tbody></table></details>`:''}
    ${findings}</section>`;
}
function projectWorkspace(){
  const tabs = [
    ['model','M12 2 21 7v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10','模型'],
    ['parts','M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1','零件清单'],
    ['details','M4 4h16v13H9l-5 4z M8 9h8 M8 12h5','修改设计']
  ];
  const nav=tabs.map(([key,path,label])=>`<button type="button" id="view-${key}" data-project-view="${key}" aria-controls="project-${key}" aria-pressed="${key==='model'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>${label}${key==='parts'?`<span class="parts-count">${rows.length}</span>`:''}</button>`).join('');
  return `<div class="workspace-heading">
    <div class="project-heading"><h1>${esc(design.name)}</h1><span class="project-version">${sharedProject?'':copyOrigin?'个人副本 · ':sample?'示例 · ':''}<span id="version-label">第 ${iteration.version} 版</span></span></div>
    <nav class="project-views" aria-label="项目视图">${nav}</nav>
    <div class="project-actions">
      <a class="file-action" href="./urdf-viewer.html">查看本地 URDF</a>
      ${publicProjectLink()?'<button type="button" class="file-action" id="share-project">分享</button>':''}
      ${iteration.previousId?'<button id="previous-version" type="button" class="small-button">上一版</button>':''}
      <button type="button" class="file-action" id="download-forge" title="下载整机源文件与参考走线。含外部模型时打包为 ZIP。" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>ForgeCAD 工程</button>
    </div>
  </div>
  ${sharedProject?sharedProjectBar(sharedProject):exampleAsset&&!copyOrigin?`<section class="shared-project-bar" aria-label="示例来源"><div class="shared-project-context"><b>示例</b><span>${fistAsset(exampleAsset)?'仅 CAD 已核验':'参考布局'} · 未实物验证</span></div><button type="button" class="small-button" id="copy-project">创建个人副本</button></section>`:''}
  <small id="save-status" role="status"></small>
  <div class="project-layout">
    <div class="project-main">
      <section id="project-model" class="drawing-pane" aria-label="模型">
        <p class="geometry-state" id="geometry-state" role="status" aria-live="polite"></p>
        <button class="small-button" type="button" id="retry-model" hidden>重新加载模型</button>
        <div id="cad-panel" aria-label="可旋转的结构预览"></div><div id="mobile-components"></div>
      </section>
      <section id="project-parts" class="shopping" aria-label="零件清单" hidden>
        <div id="shopping-cart"><div class="purchase-head"><div><b>淘宝采购</b><small id="buy-summary"></small></div><button type="button" id="buy" class="primary">加入淘宝购物车</button></div>
        <div id="cart-feedback" aria-live="polite"></div><details class="cart-helper"><summary>购物车连接方式</summary><div id="helper-info"></div></details></div>
        <label class="parts-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg><input type="search" id="part-search" aria-label="查找零件" placeholder="搜索零件或型号"></label>
        <p id="parts-empty" hidden role="status">没有匹配的零件</p>
        <div id="items"></div>
      </section>
    </div>
    <aside class="project-inspector" id="project-details" aria-label="项目详情">
      <div id="desktop-components"><div id="model-components"></div></div>
      <section class="project-brief"><h2>项目说明</h2>${projectDescription(design.summary)}
        <div id="functional-details">${functionalDetails(design)}</div>
        <details class="project-origin"><summary>模型来源</summary>${provenance(design)}</details>
      </section>
      <section class="revision-panel" aria-label="修改设计">${sharedProject?'<p class="shared-edit-note">这是固定分享版本。创建个人副本后，可以继续修改。</p>':''}<form id="revision-form" ${sharedProject?'hidden':''}><label for="revision-prompt">修改设计</label>
        <div class="revision-row"><textarea id="revision-prompt" maxlength="1800" rows="3" placeholder="想改哪里？比如把外壳做矮一点。"></textarea><button class="primary" type="submit" id="revise-design">生成新版</button></div>
        </form><p id="revision-status" role="status"></p><div id="revision-conversation" aria-live="polite"></div>
      </section>
      ${revisionHistory()}
    </aside>
  </div>`;
}

function selectProjectView(view){
  const narrow=window.matchMedia('(max-width: 760px)').matches;
  if(view==='details'&&!narrow)view='model';
  project.dataset.view=view;
  $('#project-model').hidden=view!=='model';
  $('#project-parts').hidden=view!=='parts';
  $('#project-details').hidden=narrow&&view!=='details';
  const target=narrow?$('#mobile-components'):$('#desktop-components');
  const components=$('#model-components');
  if(components.parentElement!==target)target.append(components);
  $('#desktop-components').hidden=narrow||view!=='model';
  for(const button of project.querySelectorAll('[data-project-view]')){
    button.setAttribute('aria-pressed',String(button.dataset.projectView===view));
  }
  const download=$('#download-forge');
  download.classList.toggle('off-model',view!=='model');
}
project.addEventListener('click',event=>{
  const focus=event.target.closest('[data-focus-controller], [data-focus-wiring]');
  if(focus){
    selectProjectView('model');
    const panel=$('#cad-panel');
    if(focus.hasAttribute('data-focus-wiring')){
      const value=focus.dataset.focusWiring;
      panel.dispatchEvent(new CustomEvent('focus-wiring',{detail:value===''?{}:{connectionIndex:Number(value)}}));
    }else panel.dispatchEvent(new CustomEvent('focus-hardware',{detail:{partIndex:Number(focus.dataset.focusController)}}));
    if(window.matchMedia('(max-width: 760px)').matches)panel.scrollIntoView({block:'start'});
    return;
  }
  const button=event.target.closest('[data-project-view]');
  if(button)selectProjectView(button.dataset.projectView);
});
project.addEventListener('click',async event=>{
  if(event.target.closest('#share-project')){const link=publicProjectLink();if(link)showShareDialog(link);return}
  if(event.target.closest('#close-shared')){showEntry();return}
  const copy=event.target.closest('#copy-project');
  if(copy){
    copy.disabled=true;
    const from=sharedProject?{slug:sharedProject.entry.slug,version:sharedProject.selected.version}: {example:exampleAsset,version:iteration.version};
    const record={prompt:projectPrompt,iteration:{...iteration,previousId:undefined},exampleAsset,savedCadUrl,copyOrigin:from};
    try{await showProject(design,false,record);remember();await saveTail;if($('#save-status')&&!$('#save-status').textContent)$('#save-status').textContent='已创建个人副本。可以在「我的项目」中重新打开。'}
    catch(error){if($('#save-status'))$('#save-status').textContent=error.message}
  }
});
project.addEventListener('change',event=>{
  if(event.target.id==='shared-version'&&sharedProject)openSharedProject(sharedProject.entry.slug,Number(event.target.value));
});
window.matchMedia('(max-width: 760px)').addEventListener('change',()=>{
  if(!project.hidden&&$('#project-model'))selectProjectView(project.dataset.view);
});

async function showProject(d,isSample,record={},newImages=null){if(!d||!Array.isArray(d.parts)||!d.parts.length)throw Error('没有收到可用的零件方案，请换个描述再试。');stopDraft();iteration=readIteration(record);generation++;const run=generation;cartVersion++;cartBusy=false;design=structuredClone(d);exampleAsset=record.exampleAsset==='fist-bump'&&iteration.version===1?'fist-bump-v1':fistAsset(record.exampleAsset)||record.exampleAsset==='status-light'?record.exampleAsset:null;
  sharedProject=record.shared||null;savedCadUrl=record.savedCadUrl||null;copyOrigin=record.copyOrigin||null;
  project.dataset.shared=String(!!sharedProject);
  if(sharedProject)history.replaceState(history.state,'',shareLink(sharedProject.entry.slug,sharedProject.selected.version));
  else if(record.exampleRoute)syncExampleUrl(record.exampleRoute.example,record.exampleRoute.version);
  else syncExampleUrl();
  progress();sample=isSample||d.generation?.provider==='sample';projectId=record.id||crypto.randomUUID();projectPrompt=typeof record.prompt==='string'?record.prompt:'';rows=design.parts.map((p,i)=>{const prev=record.selected?.[i],c=prev?.candidate&&productUrl(prev.candidate.url)?prev.candidate:null;return {candidates:c?[c]:[],choice:c?0:-1,manual:c,searchUrl:defaultSearch(p),searching:!c&&!sharedProject&&!['custom','provided','included'].includes(p.kind),serial:0,holdKey:prev?.holdKey||'',holdStatus:prev?.holdStatus||'',included:!['custom','provided','included'].includes(p.kind)&&(prev?.included??true)}});entry.hidden=true;project.hidden=false;$('#back').hidden=false;project.innerHTML=projectWorkspace();
  // Capture this version now, but only list it as saved after its private images commit.
  const photoId=projectId;
  const attachmentsReady=!sample&&newImages?.length?versionImages(photoId,newImages).then(()=>true,()=>false):null;
  if(!sample&&!record.id)remember(attachmentsReady);
  selectProjectView(incomingRevision?'details':'model');if(!sharedProject)await capabilitiesReady;if(generation!==run)return;
  const restored=iteration.imageCount&&!sample&&!newImages?versionImages(photoId).catch(()=>[]).then(images=>{
    if(!images.length&&projectId===photoId)revisionPhotos?.message('这版参考照片保存在创建它的浏览器；可在此处重新添加。');
    return images;
  }):[];
  revisionPhotos=photoPicker($('#revision-form'),'revision-design-images',()=>caps,newImages??restored);
  if(attachmentsReady)attachmentsReady.then(saved=>{
    if(!saved&&projectId===photoId)revisionPhotos?.message('照片本次可用，重新打开前请保留原图再添加。');
  });
  const revisionField=$('#revision-prompt');
  if(incomingRevision){revisionField.value=incomingRevision;incomingRevision='';revisionField.focus({preventScroll:true})}
  if(!caps.ai&&localUrl(caps.localUrl))$('#revise-design').textContent=exampleAsset?'在本机继续修改':'在本机新建设计';
  mount();renderList();syncCart();window.scrollTo(0,0);const queue=rows.flatMap((r,i)=>r.searching?[i]:[]);await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length&&generation===run){await lookup(queue.shift(),run)}}))}
async function lookup(i,run){const p=design.parts[i],r=rows[i],serial=++r.serial;r.searching=true;try{const x=await findProducts(p);if(run!==generation||serial!==r.serial)return;r.searchUrl=market(x?.searchUrl)?.href||defaultSearch(p);r.candidates=(x?.candidates||[]).filter(c=>productUrl(c?.url));r.choice=r.candidates.length===1?0:-1}catch{if(run!==generation||serial!==r.serial)return;r.searchUrl=defaultSearch(p)}finally{if(run===generation&&serial===r.serial){r.searching=false;refreshRow(i);syncCart()}}}
const hardwareKindLabel={specified:'指定型号',candidate:'选型参考',custom:'按图定制',material:'材料参考',included:'随主件附带',provided:'用户自备'};
function procurementReference(ref){
  if(!ref||!Object.hasOwn(hardwareKindLabel,ref.kind)||!Array.isArray(ref.items))return '';
  const rows=ref.items.filter(item=>typeof item?.name==='string'&&item.name.trim()).map(item=>{
    const url=safeUrl(item.url);
    const link=url?.protocol==='https:'&&!url.username&&!url.password?shopLink(url.href,item.label||'资料'):'';
    return `<li><span>${esc(item.name)}</span>${link}</li>`;
  });
  if(!rows.length)return '';
  return `<div class="hardware-reference" data-hardware-reference="${ref.kind}"><span class="hardware-kind">${hardwareKindLabel[ref.kind]}</span><ul>${rows.join('')}</ul>${ref.note?`<p>${esc(ref.note)}</p>`:''}</div>`;
}
function card(i){const p=design.parts[i],r=rows[i],c=selected(r),dims=measure(p);const reference=procurementReference(p.hardwareReference);const status=p.kind==='provided'?'用户自备':p.kind==='included'?'随主件附带':c&&r.holdKey===skuKey(c)?(r.holdStatus==='added'?'已确认加购':'请核对购物车'):r.searching?'查找中':(!c?r.candidates.length?'待选商品':'待选商品':c.skuId&&!c.requiresSelection&&(c.sku||c.options?.length)?'已选规格':'待核对规格');const designMeasures=`<p class="measure">${dims?`${dims.map(esc).join(' × ')} mm · ${sourceText(p.dimensionSource)}`:'暂无尺寸'}${p.dimensionNote?' · '+esc(p.dimensionNote):''}</p>`;
if(p.kind==='custom')return `<article class="part" data-i="${i}"><div class="part-top"><h3>${esc(p.name)}</h3><span class="qty">× ${esc(p.qty||1)}</span></div><p class="spec">${esc(modelText(p))}</p><details class="hardware-specifications"><summary>加工规格</summary>${designMeasures}<p>${esc(p.spec||'按设计文件询价')}</p></details><p class="pick-note">委托加工 · 从模型的文件列表下载加工包，交给供应商询价。</p></article>`;
const originalSpec=reference?`<p class="spec">${esc(modelText(p))}</p>`:'';
const edit=sharedProject&&reference
  ?`<details class="hardware-specifications"><summary>尺寸与规格</summary>${originalSpec}${designMeasures}</details>`
  :`<details class="edit"><summary>尺寸与规格</summary>${originalSpec}${designMeasures}<form data-edit="${i}"><label>型号或规格<input name="spec" maxlength="240" value="${esc(p.spec)}" placeholder="例如：6 × 6 mm 轻触开关"></label><fieldset><legend>外形尺寸（毫米）</legend><div class="dims">${['长','宽','高'].map((a,j)=>`<label>${a}<input type="number" name="dim${j}" step="any" min="0.1" max="2000" value="${esc(dims?.[j]??'')}"></label>`).join('')}</div></fieldset><label>淘宝商品链接（可选）<input type="url" name="url" placeholder="粘贴淘宝或天猫商品详情链接" value="${esc(r.manual?.url||c?.url||'')}"></label><label>详情页商品标题（可选）<input name="listingTitle" maxlength="250" placeholder="可粘贴商品页面的原始标题" value="${esc(knownTitle(r.manual||c))}"></label><label>商品页的规格选项（可选）<input name="skuOptions" maxlength="300" placeholder="按淘宝选项原文填写，多项用分号隔开" value="${esc((r.manual?.options||c?.options||[]).join('；'))}"></label><div class="edit-actions"><small class="edit-note" role="status"></small><button class="small-button" type="submit">保存修改</button></div></form></details>`;
return `<article class="part" data-i="${i}"><div class="part-top"><div class="part-name"><label class="part-check" title="加入本次采购"><input class="include" type="checkbox" aria-label="采购${esc(p.name)}" ${r.included?'checked':''}></label><h3>${esc(p.name)}</h3></div><span class="qty">× ${esc(p.qty||1)}</span></div>${reference||`<p class="spec">${esc(modelText(p)||'按设计规格选择')}</p>`}<div class="part-links"><span class="tag ${c?.skuId?'matched':''}">${status}</span>${c?shopLink(c.url,'商品详情'):''}${shopLink(r.searchUrl||defaultSearch(p),'去淘宝搜索')}${caps.cart==='browser'?`<button type="button" class="picker" data-pick="${i}" ${r.picking?'disabled':''}>${r.picking?'等待选择…':'去淘宝选规格'}</button>`:''}</div>${r.pickNote?`<p class="pick-note" role="status">${esc(r.pickNote)}</p>`:''}${r.candidates.length>1?`<label class="product-select">匹配商品<select aria-label="${esc(p.name)}的匹配商品" data-product="${i}"><option value="">选择商品</option>${r.candidates.map((v,j)=>`<option value="${j}" ${j===r.choice?'selected':''}>${esc(v.title||'淘宝商品')}${v.sku?' · '+esc(v.sku):''}</option>`).join('')}</select></label>`:''}${c?`<p class="candidate-title">${esc(knownTitle(c)||c.title||'已绑定商品')}${c.sku?' · '+esc(c.sku):''}${c.selectionNote?' · '+esc(c.selectionNote):''}</p>`:''}${edit}</article>`}
function filterParts(){
  const query=$('#part-search').value.trim().toLocaleLowerCase();
  let count=0;
  for(const section of project.querySelectorAll('.part-section')){
    let matches=0;
    for(const row of section.querySelectorAll('.part')){
      const part=design.parts[Number(row.dataset.i)];
      const itemNames=part.hardwareReference?.items?.map(item=>item.name)||[];
      row.hidden=query!==''&&![part.name,part.model,part.spec,partSearchTerms(part),...itemNames].some(v=>String(v||'').toLocaleLowerCase().includes(query));
      if(!row.hidden)matches++;
    }
    section.hidden=matches===0;
    count+=matches;
  }
  $('#parts-empty').hidden=count>0;
}
project.addEventListener('input',event=>{
  if(event.target.id==='part-search')filterParts();
});

function renderList(){
  const printed=new Set((design.cadPlan?.bodies||[]).filter(body=>body.role==='printed').map(body=>body.partIndex));
  const parts=rows.map((_,i)=>i);
  const groups=printed.size?[
    ['打印件',parts.filter(i=>printed.has(i))],
    ['其他零件',parts.filter(i=>!printed.has(i))]
  ]:[['零件',parts]];
  $('#items').innerHTML=groups.filter(([,indices])=>indices.length).map(([name,indices])=>
    `<section class="part-section"><h3 class="part-group-title">${name} · ${indices.length}</h3>${indices.map(card).join('')}</section>`
  ).join('');
}
function refreshRow(i){const old=document.querySelector(`.part[data-i="${i}"]`);if(!old)return;const expanded=old.querySelector('details').open;const before=expanded?old.querySelector('details'):null;const template=document.createElement('template');template.innerHTML=card(i);const next=template.content.firstElementChild;if(before)next.querySelector('details').replaceWith(before);next.hidden=old.hidden;old.replaceWith(next);if($('#part-search').value.trim())filterParts()}
function clearFeedback(){cartVersion++;$('#cart-feedback')?.replaceChildren()}
const sameItem=(a,b)=>{const x=productUrl(a),y=productUrl(b);return !!x&&!!y&&x.hostname===y.hostname&&x.searchParams.get('id')===y.searchParams.get('id')};
const knownTitle=c=>c?.listingTitle||((c?.titleSource==='page'||c?.titleSource==='user')?c.title:'')||'';
const skuKey=c=>{const u=productUrl(c?.url);return u?[u.searchParams.get('id'),c.skuId||u.searchParams.get('skuId')||'',...(c.options||[c.sku||''])].join(':'):''};
function clearPartSource(p){
  if(design?.interaction)delete design.interaction;
  if(design?.generation?.designReview)delete design.generation.designReview;
  delete p.hardwareReference;delete p.geometryReference;delete p.mechanicalEvidenceReceipt;delete p.dimensionSourceUrl;delete p.sourceUrl;delete p.dimensionQuote;
}
function updateGeometry(p,dimensionsSupplied){
  clearPartSource(p);
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
  const included=rows.flatMap((r,i)=>r.included&&!['custom','provided','included'].includes(design.parts[i].kind)?[{part:design.parts[i],item:selected(r),row:r}]:[]);
  const linked=included.filter(x=>x.item),ready=linked.filter(({item:c})=>c.skuId&&!c.requiresSelection&&(c.options?.length||c.sku));
  return {included,linked,fresh:linked.filter(x=>x.row.holdKey!==skuKey(x.item)),ready,pending:linked.filter(x=>!ready.includes(x)),unmatched:included.length-linked.length};
}
function syncCart(){
  const browser=caps.cart==='browser',launch=caps.shoppingWindow&&!browser;const {included,linked,fresh,ready,pending,unmatched}=cartSelection(),loading=rows.some(r=>r.included&&r.searching);
  $('#buy-summary').textContent=loading?'正在匹配商品…':!included.length?'尚未勾选零件。':[`已勾选 ${included.length} 项`,`${ready.length} 项规格就绪`,...(pending.length?[`${pending.length} 项待选规格`]:[]),...(unmatched?[`${unmatched} 项待选商品`]:[])].join(' · ');
  $('#items').inert=cartBusy;const picking=rows.some(r=>r.picking);project.querySelectorAll('[data-pick]').forEach(b=>b.disabled=picking||cartBusy);const info=$('#helper-info');if(info&&info.dataset.browser!==String(browser||launch)){info.dataset.browser=String(browser||launch);info.innerHTML=launch?'专用采购窗口会带入当前零件清单，无需手动安装扩展。请在新窗口登录自己的淘宝账号，选好规格后确认加购。':browser?'已连接淘宝助手。它会先显示本次清单，经你确认后在自己的淘宝账号中逐项处理。':'<p>桌面 Chrome 或 Edge：<a href="./taobao-helper.zip" download>下载淘宝购物助手</a>，解压后，在 <code>chrome://extensions</code>（Edge 用 <code>edge://extensions</code>）打开开发者模式，选择「加载已解压的扩展」，再刷新此页。</p><p>手机可直接进入每件商品的淘宝详情页确认规格。</p>'}
  if(launch){$('#buy').disabled=cartBusy||!included.length;$('#buy').textContent=cartBusy?'正在打开…':'打开专用淘宝采购窗口';return}
  $('#buy').disabled=cartBusy||picking||!(browser?fresh:linked).length;$('#buy').textContent=cartBusy?'正在处理…':browser?(fresh.length?`在我的浏览器加购 ${fresh.length} 项`:linked.length?'先核对淘宝购物车':'在我的浏览器加购'):ready.length?`去淘宝加购 ${ready.length} 项`:linked.length?`去淘宝选规格 ${linked.length} 项`:'去淘宝加购';
}
project.addEventListener('change',e=>{const el=e.target,i=Number(el.closest('.part')?.dataset.i),r=rows[i];if(!r)return;if(el.matches('.include'))r.included=el.checked;else if(el.matches('[data-product]')){interruptPick(r);const was=selected(r);r.choice=el.value===''?-1:Number(el.value);const next=selected(r);if(reflectSelection(design.parts[i],was,next,{firstPick:true})){r.searchUrl=defaultSearch(design.parts[i]);mount()}refreshRow(i)}else return;remember();clearFeedback();syncCart()});
project.addEventListener('submit',e=>{
  if(sharedProject){e.preventDefault();return}
  if(e.target.matches('#revision-form')){
    e.preventDefault();const field=$('#revision-prompt'),feedback=field.value.trim();
    if(!caps.ai&&localUrl(caps.localUrl)){
      const target=new URL(localUrl(caps.localUrl));
      if(exampleAsset){
        target.searchParams.set('example',fistAsset(exampleAsset)?'fist':'status');
        if(fistAsset(exampleAsset))target.searchParams.set('version',String(iteration.version));
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
  if(!e.target.matches('[data-edit]'))return;e.preventDefault();const f=e.target,i=Number(f.dataset.edit),p=design.parts[i],r=rows[i],a=new FormData(f),err=f.querySelector('.edit-note');const raw=a.get('url').trim(),u=raw?productUrl(raw):null;if(raw&&!u){err.textContent='请粘贴带商品 id 的淘宝或天猫详情链接。';return}const dims=[0,1,2].map(j=>String(a.get('dim'+j)).trim()),spec=String(a.get('spec')).trim(),has=dims.some(Boolean);if(has&&(!dims.every(Boolean)||dims.some(v=>!Number.isFinite(Number(v))||Number(v)<0.1||Number(v)>2000))){err.textContent='请补齐三个 0.1–2000 mm 的尺寸。';return}interruptPick(r);const old=selected(r);const specChanged=spec!==String(p.spec||''),dimChanged=JSON.stringify(has?dims.map(Number):null)!==JSON.stringify(measure(p));if(dimChanged){clearPartSource(p);p.modelSourceInvalidated=true;p.sizeMm=has?dims.map(Number):null;p.dimensionSource=has?'specified':'estimated';p.dimensionNote=has?'按指定尺寸重新布局。':''}if(specChanged){p.spec=spec;p.model=spec;p.modelId=null}let needLookup=false;if(u){const skuId=u.searchParams.get('skuId');r.serial++;r.searching=false;const options=String(a.get('skuOptions')||'').split(/[;；]/).map(v=>v.trim()).filter(Boolean);const previous=r.candidates.find(k=>sameItem(k.url,u.href));
const given=String(a.get('listingTitle')||'').trim(),fromOther=old&&!sameItem(old.url,u.href)&&given===knownTitle(old);
const listingTitle=(!fromOther&&given)||knownTitle(previous);
r.manual={title:listingTitle||previous?.title||('商品编号 '+u.searchParams.get('id')),titleSource:listingTitle?'user':(previous?.titleSource||'label'),listingTitle,url:u.href,...(skuId?{skuId}:{}),...(options.length?{sku:options.join(' / '),options}:{})};r.candidates=[r.manual];r.choice=0;r.searchUrl=defaultSearch(p)}else if(specChanged||r.manual){r.serial++;r.manual=null;r.candidates=[];r.choice=-1;r.searchUrl=defaultSearch(p);r.searching=true;needLookup=true}const swapped=reflectSelection(p,old,u?r.manual:null,{dimensionsSupplied:dimChanged&&has,specChanged,firstPick:true});if(dimChanged||swapped)r.searchUrl=defaultSearch(p);clearFeedback();f.closest('details').open=false;refreshRow(i);if(dimChanged||specChanged||swapped)mount();syncCart();remember();if(needLookup)void lookup(i,generation)});
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
  const q=[`已勾选 ${total} 项`,`有成功回执 ${counts.added} 项`,...(counts.not_confirmed?[`结果未确认 ${counts.not_confirmed} 项`]:[]),...(unmatched?[`待选商品 ${unmatched} 项`]:[])].join(' · ');
  target.innerHTML=`<p>${esc(q)}</p>${out.reason?`<small>${esc(out.reason)}</small>`:''}<ul class="browser-results">${output.join('')}</ul>${shopLink(market(out.cartUrl)?.href||'https://cart.taobao.com/cart.htm','核对淘宝购物车')}`;
}
project.addEventListener('click',async e=>{
  if(e.target.closest('#previous-version')){
    const button=e.target.closest('#previous-version'),current=projectId,previous=iteration.previousId;
    stopDraft();button.disabled=true;
    try{
      if(previous===firstFistVersion){await openFistExample(1);return}
      await saveTail;const saved=await readConsumerProject(previous);
      if(projectId===current)await showProject(saved.design,false,saved);
    }
    catch(error){if(projectId===current)$('#save-status').textContent=error.message}
    finally{if(button.isConnected)button.disabled=false}return;
  }

  const picker=e.target.closest('[data-pick]');if(picker){await pickForRow(Number(picker.dataset.pick));return}if(!e.target.closest('#buy')||cartBusy||rows.some(r=>r.picking))return;
  if(caps.shoppingWindow&&caps.cart!=='browser'){
    const target=$('#cart-feedback');cartBusy=true;syncCart();try{const result=await shoppingRpc('shopping-window',{record:{design,selected:rows.map(r=>({included:r.included,candidate:selected(r),holdKey:r.holdKey,holdStatus:r.holdStatus}))}});if(result.state==='launched')target.textContent='已启动专用采购窗口，请在那里继续。此操作不会加购或下单。';}catch(err){target.textContent=err.message}finally{cartBusy=false;syncCart()}return;
  }
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
    const countMessage=[`已勾选 ${included.length} 项`,handed?`${handed} 项已获得确认链接`:verified?`${verified} 项已确认加购`:'未获得官方加购链接',`未交接 ${unhanded} 项`,`待选规格 ${pending.length} 项`,...(unmatched?[`待选商品 ${unmatched} 项`]:[])].join(' · ');
    target.innerHTML=`<p>${esc(stateMessage)}</p><small>${esc(countMessage)}</small>${out.reason?`<small>${esc(out.reason)}</small>`:''}<div class="cart-links">${links.map((l,i)=>shopLink(l.url,`淘宝确认${links.length>1?' '+(i+1):''} · ${l.count} 项`)).join('')}${!handed&&!verified?detailLinks(ready,'打开商品'):''}${detailLinks(pending,'选择规格')}${market(out.cartUrl)?shopLink(out.cartUrl,'查看淘宝购物车'):''}${localUrl(out.localUrl)?shopLink(localUrl(out.localUrl),'打开本机工作室'):''}</div>`;
  }catch(err){if(browser&&revision===cartVersion){renderBrowserOutcome(target,{items:[],state:'not_confirmed'},batch,included.length,unmatched);return}if(revision===cartVersion)target.innerHTML=`<p>暂未交接这 ${included.length} 项。请到淘宝商品页核对。</p><div class="cart-links">${detailLinks(ready,'打开商品')}${detailLinks(pending,'选择规格')}</div>`}
  finally{if(target.isConnected){cartBusy=false;syncCart()}}
});

mountConsumerAccount($('#consumer-account'),{onOpen:async rec=>{if(!rec?.design)return;try{await showProject(rec.design,false,rec)}catch(e){showEntry();notice('#entry-notice',e.message||'暂时无法打开项目。')}},onSignOut:()=>{accountEpoch++;showEntry();$('#wish').value=''}});

const requestedExample=new URLSearchParams(location.search).get('example');
const requestedShare=new URLSearchParams(location.search).get('share');
const requestedJob=new URLSearchParams(location.search).get('job');
mountGallery($('#studio-gallery'),openSharedProject);
if(requestedJob)openCompletedJob(requestedJob);
else if(requestedShare)openSharedProject(requestedShare,new URLSearchParams(location.search).get('version'));
else if(requestedExample==='fist'){
  const version=new URLSearchParams(location.search).get('version');
  openFistExample(version==='1'?1:version==='2'?2:null);
}
else if(requestedExample==='status')openStatusExample();

async function shoppingRpc(path,data){const response=await fetch('/api/'+path,{method:'POST',mode:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();if(!response.ok)throw Error(result.error||'无法打开采购窗口。');return result;}
const handoffToken=location.origin==='http://127.0.0.1:4173'&&new URLSearchParams(location.hash.slice(1)).get('shopping');
if(handoffToken&&/^[a-f0-9]{48}$/.test(handoffToken)){
 history.replaceState(null,'',location.pathname);shoppingRpc('shopping-window/claim',{token:handoffToken}).then(async({record:r})=>{await showProject(r.design,r.design.generation?.provider==='sample',{...r,id:crypto.randomUUID()});if(caps.cart!=='browser')notice('#cart-feedback','专用窗口未连接助手；可在淘宝详情页手动确认。');}).catch(err=>notice('#entry-notice',err.message));
}

capabilitiesReady.then(()=>{
  const pending=pendingDesignJob();
  if(!caps.designJobs||!pending||draft||!entry.hidden&&location.search)return;
  if(!entry.hidden){
    const input=pending.input;
    $('#wish').value=input.prompt;
    const state={mode:'new',prompt:input.prompt,policy:input.provider,conversation:input.conversation||[],discussionStart:input.discussionStart||0,
      images:input.images||[],baseDesign:input.baseDesign||null,repairCandidate:input.repairCandidate||null,version:input.baseDesign?2:1,
      controller:new AbortController(),panel:$('#entry-conversation')};
    draft=state;requestDraft(state,'generate');
  }
});
