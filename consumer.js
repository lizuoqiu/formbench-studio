import {discussDesign,generateDesign,findProducts,pickProduct,makeCart,serviceCapabilities,sampleDesign} from './consumer-service.js';
import {mountConsumerAccount,saveConsumerProject,readConsumerProject} from './consumer-account.js';
import {currentCadPlan,mountConsumerCad} from './consumer-cad.js';
import {editableForgeSource} from './forge-source.js';
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
const firstFistVersion='builtin:fist-bump:v1';
const fistAsset=asset=>asset==='fist-bump'||asset==='fist-bump-v1';
function syncExampleUrl(example='',version=null){
  const url=new URL(location.href);
  if(example){
    url.searchParams.set('example',example);
    if(version!=null)url.searchParams.set('version',String(version));
    else url.searchParams.delete('version');
  }else if(['fist','status'].includes(url.searchParams.get('example'))){
    url.searchParams.delete('example');url.searchParams.delete('version');url.searchParams.delete('view');
  }else return;
  history.replaceState(history.state,'',url);
}
let iteration={version:1,conversation:[]}, draft=null;
function readIteration(record){
  const value=record.iteration;
  const conversation=Array.isArray(value?.conversation)?value.conversation.filter(t=>['assistant','user'].includes(t?.role)&&typeof t.text==='string'&&t.text.trim()):[];
  return {version:Number.isSafeInteger(value?.version)&&value.version>0?value.version:1,conversation,
    ...(typeof value?.previousId==='string'?{previousId:value.previousId}:{})};
}
function revisionHistory(){
  if(!projectPrompt&&!iteration.conversation.length)return '';
  const original=projectPrompt?`<li><b>原始需求</b><span>${esc(projectPrompt)}</span></li>`:'';
  const turns=iteration.conversation.map(t=>`<li><b>${t.role==='assistant'?'AI':'你'}</b><span>${esc(t.text)}</span></li>`).join('');
  return `<details class="iteration-history"><summary>设计记录</summary><ol>${original}${turns}</ol></details>`;
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
function capabilityHint(){if(!$('#entry-progress').hidden)return;const href=localUrl(caps.localUrl);if(caps.ai===false&&href){$('#generate').textContent='在本机生成';notice('#entry-notice','此页面可直接查看示例。生成新方案将在已启动的本机工作室继续。')}else if(caps.ai===false){notice('#entry-notice','OpenAI API 尚未连接，可以先查看示例。');$('#generate').disabled=true}}
function generationLabel(){
 const who={'local-codex':'本机 Codex','openai-api':'OpenAI API'}[caps.aiProvider]||'设计服务';
 return caps.aiModel?`${who} · 请求模型：${caps.aiModel}`:`${who} · 当前未公开模型名`;
}
const capabilitiesReady=serviceCapabilities().then(v=>{caps=v||{};const model=$('#selected-model');model.hidden=!caps.ai;model.textContent=caps.ai?generationLabel():'';if(!entry.hidden)capabilityHint();else if($('#buy')){rows.forEach((_,i)=>refreshRow(i));syncCart()}}).catch(()=>{});
function showEntry(){stopDraft();syncExampleUrl();progress();projectId=null;projectPrompt='';design=null;generation++;cartVersion++;cartBusy=false;cadDispose?.();cadDispose=null;entry.hidden=false;project.hidden=true;project.replaceChildren();$('#back').hidden=true;$('#generate').disabled=false;$('#generate').textContent='生成设计';$('#sample').disabled=false;notice('#entry-notice');capabilityHint();window.scrollTo(0,0);$('#wish').focus()}
$('#back').onclick=()=>{showEntry();$('#wish').value=''};
function progress(phase){
  const node=$('#entry-progress');node.hidden=!phase;$('#intent').setAttribute('aria-busy',String(!!phase));
  if(!phase)return;
  node.dataset.phase=phase;
  const labels={request:['正在生成设计','正在准备零件清单和模型。'],response:['设计已生成','正在加载模型。']};
  const info=labels[phase];if(info){$('#build-title').textContent=info[0];$('#build-hint').textContent=info[1]}
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
  return `<span class="model-stamp">${esc(path)} · ${esc(evidence)}${skill}</span>${g.reviewNote?`<details class="review-note"><summary>几何复核</summary><p>${esc(g.reviewNote)}</p></details>`:''}`;
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
      $('#build-title').textContent='正在读取需求';
      $('#build-hint').textContent='';
    }
    if(submit)submit.textContent=phase?'处理中…':'生成设计';
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
  panel.innerHTML=`<div class="discussion-card">${error?`<p role="alert" class="discussion-error">${esc(error)}</p>`:''}${ask?`<h3 id="discussion-question">${esc(ask.question)}</h3><div class="answer-options">${ask.options.map((label,i)=>`<button type="button" data-answer-index="${i}" class="small-button">${esc(label)}</button>`).join('')}</div><form class="answer-form"><label for="discussion-answer">其他想法</label><div><input id="discussion-answer" maxlength="1800" autocomplete="off"><button type="submit" id="send-answer" class="small-button">回复</button></div></form>`:''}<div class="discussion-controls">${error?'<button type="button" class="small-button" id="retry-discussion">重试</button>':''}<button type="button" id="skip-discussion" class="discussion-link">直接生成</button>${cancel}</div></div>`;
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
const measure=p=>Array.isArray(p.sizeMm)&&p.sizeMm.length===3&&p.sizeMm.every(x=>Number.isFinite(Number(x))&&Number(x)>0)?p.sizeMm.map(Number):null;
const selected=r=>r.candidates[r.choice]||null;
function disposeViewer(){try{cadDispose?.()}finally{cadDispose=null}}
function mount(){
  disposeViewer();const target=$('#cad-panel'),badge=$('#geometry-state'),declared=!!design?.cadPlan?.bodies?.length;let active=true;
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
        sourceButton.onclick=async()=>{
          sourceButton.disabled=true;
          try{
            const source=await editableForgeSource(plan,design.parts);
            if(!active)return;
            const url=URL.createObjectURL(new Blob([source],{type:'text/javascript;charset=utf-8'}));
            const a=document.createElement('a');a.href=url;a.download=filename+'.forge.js';a.click();
            setTimeout(()=>URL.revokeObjectURL(url),1500);
          }catch(error){if(active)badge.textContent=error.message||'整机模型下载失败。'}
          finally{if(active)sourceButton.disabled=false}
        };
      }
    }catch{sourceButton.hidden=true}
  }
  const initialMode=new URLSearchParams(location.search).get('view')==='inside'?'inside':undefined;
  try{onStatus({phase:'parts'});const cleanup=mountConsumerCad(target,design,{onStatus,initialMode,engine:caps.cadEngine,partsPanel:$('#model-components'),exampleAsset:fistAsset(exampleAsset)?exampleAsset:null});cadDispose=()=>{active=false;cleanup?.()}}
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
function projectWorkspace(){
  const tabs = [
    ['model','M12 2 21 7v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10','模型'],
    ['parts','M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1','零件清单'],
    ['details','M4 4h16v13H9l-5 4z M8 9h8 M8 12h5','修改设计']
  ];
  const nav=tabs.map(([key,path,label])=>`<button type="button" id="view-${key}" data-project-view="${key}" aria-controls="project-${key}" aria-pressed="${key==='model'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>${label}${key==='parts'?`<span class="parts-count">${rows.length}</span>`:''}</button>`).join('');
  return `<div class="workspace-heading">
    <div class="project-heading"><h1>${esc(design.name)}</h1><span class="project-version">${sample?'示例 · ':''}<span id="version-label">第 ${iteration.version} 版</span></span></div>
    <nav class="project-views" aria-label="项目视图">${nav}</nav>
    <div class="project-actions">
      ${iteration.previousId?'<button id="previous-version" type="button" class="small-button">上一版</button>':''}
      <button type="button" class="file-action" id="download-forge" title="下载可编辑的整机结构和行程。采购件的可编辑模型或定位包络见下方 CAD 文件。" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>ForgeCAD 源文件</button>
    </div>
  </div>
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
        <details class="project-origin"><summary>模型来源</summary>${provenance(design)}</details>
      </section>
      <section class="revision-panel" aria-label="修改设计"><form id="revision-form"><label for="revision-prompt">修改设计</label>
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
  const button=event.target.closest('[data-project-view]');
  if(button)selectProjectView(button.dataset.projectView);
});
window.matchMedia('(max-width: 760px)').addEventListener('change',()=>{
  if(!project.hidden&&$('#project-model'))selectProjectView(project.dataset.view);
});

async function showProject(d,isSample,record={}){if(!d||!Array.isArray(d.parts)||!d.parts.length)throw Error('没有收到可用的零件方案，请换个描述再试。');stopDraft();iteration=readIteration(record);generation++;const run=generation;cartVersion++;cartBusy=false;design=structuredClone(d);exampleAsset=record.exampleAsset==='fist-bump'&&iteration.version===1?'fist-bump-v1':fistAsset(record.exampleAsset)||record.exampleAsset==='status-light'?record.exampleAsset:null;
  if(record.exampleRoute)syncExampleUrl(record.exampleRoute.example,record.exampleRoute.version);
  else syncExampleUrl();
  progress();sample=isSample||d.generation?.provider==='sample';projectId=record.id||crypto.randomUUID();projectPrompt=typeof record.prompt==='string'?record.prompt:'';rows=design.parts.map((p,i)=>{const prev=record.selected?.[i],c=prev?.candidate&&productUrl(prev.candidate.url)?prev.candidate:null;return {candidates:c?[c]:[],choice:c?0:-1,manual:c,searchUrl:defaultSearch(p),searching:!c,serial:0,holdKey:prev?.holdKey||'',holdStatus:prev?.holdStatus||'',included:prev?.included!==false}});entry.hidden=true;project.hidden=false;$('#back').hidden=false;project.innerHTML=projectWorkspace();
  // Capture the new revision before asynchronous rendering or navigation can replace it.
  if(!sample&&!record.id)remember();
  selectProjectView(incomingRevision?'details':'model');await capabilitiesReady;if(generation!==run)return;
  const revisionField=$('#revision-prompt');
  if(incomingRevision){revisionField.value=incomingRevision;incomingRevision='';revisionField.focus({preventScroll:true})}
  if(!caps.ai&&localUrl(caps.localUrl))$('#revise-design').textContent=exampleAsset?'在本机继续修改':'在本机新建设计';
  mount();renderList();syncCart();window.scrollTo(0,0);const queue=rows.flatMap((r,i)=>r.searching?[i]:[]);await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length&&generation===run){await lookup(queue.shift(),run)}}))}
async function lookup(i,run){const p=design.parts[i],r=rows[i],serial=++r.serial;r.searching=true;try{const x=await findProducts(p);if(run!==generation||serial!==r.serial)return;r.searchUrl=market(x?.searchUrl)?.href||defaultSearch(p);r.candidates=(x?.candidates||[]).filter(c=>productUrl(c?.url));r.choice=r.candidates.length===1?0:-1}catch{if(run!==generation||serial!==r.serial)return;r.searchUrl=defaultSearch(p)}finally{if(run===generation&&serial===r.serial){r.searching=false;refreshRow(i);syncCart()}}}
function card(i){const p=design.parts[i],r=rows[i],c=selected(r),dims=measure(p);const status=c&&r.holdKey===skuKey(c)?(r.holdStatus==='added'?'已确认加购':'请核对购物车'):r.searching?'查找中':(!c?r.candidates.length?'待选商品':'待选商品':c.skuId&&!c.requiresSelection&&(c.sku||c.options?.length)?'已选规格':'待核对规格');const edit=`<details class="edit"><summary>尺寸与规格</summary><p class="measure">${dims?`${dims.map(esc).join(' × ')} mm · ${sourceText(p.dimensionSource)}`:'暂无尺寸'}${p.dimensionNote?' · '+esc(p.dimensionNote):''}</p><form data-edit="${i}"><label>型号或规格<input name="spec" maxlength="240" value="${esc(p.spec)}" placeholder="例如：6 × 6 mm 轻触开关"></label><fieldset><legend>外形尺寸（毫米）</legend><div class="dims">${['长','宽','高'].map((a,j)=>`<label>${a}<input type="number" name="dim${j}" step="any" min="0.1" max="2000" value="${esc(dims?.[j]??'')}"></label>`).join('')}</div></fieldset><label>淘宝商品链接（可选）<input type="url" name="url" placeholder="粘贴淘宝或天猫商品详情链接" value="${esc(r.manual?.url||c?.url||'')}"></label><label>详情页商品标题（可选）<input name="listingTitle" maxlength="250" placeholder="可粘贴商品页面的原始标题" value="${esc(knownTitle(r.manual||c))}"></label><label>商品页的规格选项（可选）<input name="skuOptions" maxlength="300" placeholder="按淘宝选项原文填写，多项用分号隔开" value="${esc((r.manual?.options||c?.options||[]).join('；'))}"></label><div class="edit-actions"><small class="edit-note" role="status"></small><button class="small-button" type="submit">保存修改</button></div></form></details>`;
return `<article class="part" data-i="${i}"><div class="part-top"><div class="part-name"><label class="part-check" title="加入本次采购"><input class="include" type="checkbox" aria-label="采购${esc(p.name)}" ${r.included?'checked':''}></label><h3>${esc(p.name)}</h3></div><span class="qty">× ${esc(p.qty||1)}</span></div><p class="spec">${esc(modelText(p)||'按设计规格选择')}</p><div class="part-links"><span class="tag ${c?.skuId?'matched':''}">${status}</span>${c?shopLink(c.url,'商品详情'):''}${shopLink(r.searchUrl||defaultSearch(p),'去淘宝搜索')}${caps.cart==='browser'?`<button type="button" class="picker" data-pick="${i}" ${r.picking?'disabled':''}>${r.picking?'等待选择…':'去淘宝选规格'}</button>`:''}</div>${r.pickNote?`<p class="pick-note" role="status">${esc(r.pickNote)}</p>`:''}${r.candidates.length>1?`<label class="product-select">匹配商品<select aria-label="${esc(p.name)}的匹配商品" data-product="${i}"><option value="">选择商品</option>${r.candidates.map((v,j)=>`<option value="${j}" ${j===r.choice?'selected':''}>${esc(v.title||'淘宝商品')}${v.sku?' · '+esc(v.sku):''}</option>`).join('')}</select></label>`:''}${c?`<p class="candidate-title">${esc(knownTitle(c)||c.title||'已绑定商品')}${c.sku?' · '+esc(c.sku):''}${c.selectionNote?' · '+esc(c.selectionNote):''}</p>`:''}${edit}</article>`}
function filterParts(){
  const query=$('#part-search').value.trim().toLocaleLowerCase();
  let count=0;
  for(const section of project.querySelectorAll('.part-section')){
    let matches=0;
    for(const row of section.querySelectorAll('.part')){
      const part=design.parts[Number(row.dataset.i)];
      row.hidden=query!==''&&![part.name,part.model,part.spec].some(v=>String(v||'').toLocaleLowerCase().includes(query));
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
  $('#buy-summary').textContent=loading?'正在匹配商品…':!included.length?'尚未勾选零件。':[`已勾选 ${included.length} 项`,`${ready.length} 项规格就绪`,...(pending.length?[`${pending.length} 项待选规格`]:[]),...(unmatched?[`${unmatched} 项待选商品`]:[])].join(' · ');
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
if(requestedExample==='fist'){
  const version=new URLSearchParams(location.search).get('version');
  openFistExample(version==='1'?1:version==='2'?2:null);
}
else if(requestedExample==='status')openStatusExample();
