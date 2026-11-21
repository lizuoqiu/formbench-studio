import {bindingKeys,validateCadBinding,resolveModelForRow} from './model-selection.js';
import {cleanPlacements} from './project-layout.js';

// A local interchange format. Purchase, approval and checkout records never travel with it.
const FORMAT='formwork-assembly-project', VERSION=1;
export const MAX_HANDOFF_BYTES=6*1024*1024;
const MAX_PARTS=160, MAX_STEPS=160, MAX_FILE_B64=4*Math.ceil((2*1024*1024)/3);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=why=>{throw Error(why)};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const utf8bytes=s=>new TextEncoder().encode(s).length;
const str=(s,limit,field,required=true)=>{
  if(typeof s!=='string'||s.length>limit||(required&&!s.trim()))fail('资料无效：'+field);
  return s;
};
function cleanDesign(d) {
  if(!object(d)||!Array.isArray(d.parts)||!d.parts.length||d.parts.length>MAX_PARTS||!Array.isArray(d.steps)||d.steps.length>MAX_STEPS)fail('需要有效的项目名称、零件清单和装配步骤。');
  const name=str(d.name,256,'项目名称'),summary=str(d.summary,14000,'项目说明',false);
  return {name,summary,parts:d.parts.map((p,i)=>{
    if(!object(p)||!Number.isInteger(p.qty)||p.qty<1||p.qty>99999)fail('数量无效：零件 '+(i+1));
    return {name:str(p.name,400,'零件名称'),spec:str(p.spec,4000,'零件规格',false),qty:p.qty};
  }),steps:d.steps.map(s=>str(s,5000,'装配说明'))};
}
function rowMap(input,length,fn) {
  if(input==null)return {};
  if(!object(input))fail('资料中的行号表无效。');
  return Object.fromEntries(Object.entries(input).map(([k,v])=>{
    if(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=length)fail('资料引用了不存在的行。');
    return [k,fn(v,Number(k))];
  }));
}
function productSource(s) {
  let u;try{u=new URL(s)}catch{fail('商品详情链接无效。')}
  if(u.protocol!=='https:'||u.username||u.password)fail('供货商商品链接必须是无登录信息的 HTTPS 地址。');
  if(['item.taobao.com','detail.tmall.com'].includes(u.hostname)){
    if(u.port||u.pathname!='/item.htm'||!/^\d+$/.test(u.searchParams.get('id')||''))fail('淘宝或天猫链接必须指向带商品 ID 的详情页。');
    const clean=new URL('/item.htm',u.origin);clean.searchParams.set('id',u.searchParams.get('id'));
    if(/^\d+$/.test(u.searchParams.get('skuId')||''))clean.searchParams.set('skuId',u.searchParams.get('skuId'));
    return clean.href;
  }
  // Keep product selectors, order codes and hash-based catalogue routes.
  for(const k of [...u.searchParams.keys()])if(/^(utm_.*|gclid|fbclid|msclkid)$/i.test(k))u.searchParams.delete(k);
  return u.href;
}
function cleanItem(v) {
  if(!object(v))fail('商品型号记录无效。');const out={};
  for(const [k,limit] of [['title',1000],['sku',1000],['skuId',100],['url',3000],['manufacturer',250],['mpn',250]])if(v[k]!=null&&v[k]!==''){
    const val=str(v[k],limit,'商品型号记录');
    if(k==='skuId'&&!/^\d+$/.test(val))fail('商品 SKU ID 应为数字。');
    out[k]=k==='url'?productSource(val):val;
  }
  return out;
}
function cleanBinding(record,part,item) {
  if(!object(record)||(record.fileBase64!=null&&(typeof record.fileBase64!=='string'||record.fileBase64.length>MAX_FILE_B64)))fail('单个 CAD 文件不能超过 2 MiB。');
  return validateCadBinding({...bindingKeys(part,item),...record});
}
function cleanDims(d) {
  if(!object(d))fail('外壳尺寸无效。');
  return Object.fromEntries(Object.entries({w:[62,100],d:[29,64],h:[15,42]}).map(([k,[lo,hi]])=>{
    if(!Number.isFinite(d[k])||d[k]<lo||d[k]>hi)fail('外壳尺寸超出参考参数范围。');return [k,d[k]];
  }));
}
function getPayload(input) {
  const design=cleanDesign(input.design),count=design.parts.length;
  const items=Object.fromEntries(Object.entries(rowMap(input.items,count,cleanItem)).filter(([,v])=>Object.keys(v).length));
  const cadBindings=rowMap(input.cadBindings,count,(record,i)=>cleanBinding(record,design.parts[i],items[i]));
  const assemblyStepParts=rowMap(input.assemblyStepParts,design.steps.length,arr=>{
    if(!Array.isArray(arr)||arr.length>count||arr.some(i=>!Number.isInteger(i)||i<0||i>=count))fail('装配步骤关联了无效零件。');
    return [...new Set(arr)].sort((a,b)=>a-b);
  });
  const placements=cleanPlacements(input.placements,design,items);
  return {design,items,cadBindings,assemblyStepParts,...(placements.length?{placements}:{}),...(input.cadDims==null?{}:{cadDims:cleanDims(input.cadDims)})};
}
export function createHandoffBundle(st) {
  const bundle={format:FORMAT,version:VERSION,profile:st.isSample?'pico-reference':st.design?.studioMode==='local'?'local-draft':'design-draft',...getPayload(st)};
  if(utf8bytes(JSON.stringify(bundle))>MAX_HANDOFF_BYTES)fail('项目包超过 6 MiB，请减少附带的 CAD 文件。');
  return bundle;
}
function sameSample(d,sample) {
  return !!sample&&JSON.stringify(d.parts)===JSON.stringify(cleanDesign(sample).parts)&&JSON.stringify(d.steps)===JSON.stringify(sample.steps);
}
export function readHandoffBundle(text,{sampleDesign}={}) {
  if(typeof text!=='string'||text.length>MAX_HANDOFF_BYTES||utf8bytes(text)>MAX_HANDOFF_BYTES)fail('项目包超过 6 MiB。');
  let input;try{input=JSON.parse(text)}catch{fail('不是有效的 JSON 文件。')}
  if(!object(input)||input.format!==FORMAT||input.version!==VERSION||(input.profile!==undefined&&!['design-draft','local-draft','pico-reference'].includes(input.profile)))fail('请选择工作台导出的装配项目包（版本 1）。');
  const payload=getPayload(input),isSample=input.profile==='pico-reference'&&sameSample(payload.design,sampleDesign);
  const out={...payload,isSample,items:payload.items,quote:null};
  if(input.profile==='local-draft'){out.studioMode='local';out.design.studioMode='local'}
  return out;
}
function summarize(st) {
  return st.design.parts.map((p,i)=>{
    const item=st.items?.[i]||{}, binding=st.cadBindings?.[i];
    const resolved=resolveModelForRow(p,item,binding),stale=resolved.stale;
    const cad=stale?'保留的绑定与当前选型不符':resolved.catalogOriginal?'内置原厂 CAD':binding?.kind==='dimensions'?'近似尺寸':binding?'已附 CAD':'无绑定 CAD';
    return `<li><b>${esc(p.name)}</b> × ${esc(p.qty)}　${esc(p.spec)}<br><small class="muted">${[item.manufacturer,item.mpn,item.title,item.sku,item.skuId?'SKU '+item.skuId:'',cad].filter(Boolean).map(esc).join(' · ')}</small></li>`;
  }).join('');
}
const lastSteps=new WeakMap();
const currentStep=st=>Math.min(lastSteps.get(st)||0,Math.max(0,st.design.steps.length-1));
function stepView(st,i) {
  const {parts,steps}=st.design;
  if(!steps.length)return '<p>当前设计尚未提供装配步骤。</p>';
  const linked=st.assemblyStepParts?.[i]||[];
  return `<div class="row"><span class="badge">步骤 ${i+1} / ${steps.length}</span><button class="btn" type="button" data-ah="previous" ${i===0?'disabled':''}>上一步</button><button class="btn" type="button" data-ah="next" ${i===steps.length-1?'disabled':''}>下一步</button></div>
  <p style="white-space:pre-line">${esc(steps[i])}</p>
  <div data-ah-part-summary>${partsSummary(st,linked)}</div>
  <details><summary>关联此步用到的零件</summary><div class="stack">${parts.map((p,j)=>`<label><input type="checkbox" data-ah-part="${j}" ${linked.includes(j)?'checked':''}> ${esc(p.name)} · ${esc(p.spec)}</label>`).join('')}</div></details>`;
}
function partsSummary(st,links){
  if(!links.length)return '<p>本步尚未标注对应零件。</p>';
  return '<b>本步零件与装配要点</b><ul>'+links.map(i=>{
    const p=st.design.parts[i],item=st.items?.[i]||{},record=st.cadBindings?.[i];
    const resolved=resolveModelForRow(p,item,record),active=record&&!resolved.stale?record:null;
    const action=resolved.kind==='unmatched'?'查看零件资料':'查看零件模型';
    const ids=[...new Set([item.manufacturer,item.mpn,active?.model,item.sku].filter(Boolean))];
    return `<li><b>${esc(p.name)}</b> · ${esc(ids.join(' · ')||item.title||'型号待核对')}${active?.notes?`<div style="white-space:pre-line">型号资料备注：${esc(active.notes)}</div>`:''}${record&&!active?' <small class="muted">旧绑定已停用，请按当前型号核对。</small>':''} <button type="button" class="btn" data-assembly-model="${i}" aria-label="${action}：${esc(p.name)}">${action}</button></li>`;
  }).join('')+'</ul>';
}
export function assemblyHandoffUI(st) {
  const n=st.design.parts.length;
  return `<section class="panel" data-assembly-handoff><div class="panel-head"><h2>装配指引</h2></div><div class="stack">
    <div class="stack" data-ah-step aria-live="polite">${stepView(st,currentStep(st))}</div>
    <details><summary>项目零件 · ${n} 项</summary><ol>${summarize(st)}</ol></details>
    <details><summary>待确认事项</summary><p data-ah-issues>${esc(issues(st))}</p></details>
    <details class="handoff-files"><summary>项目文件与交接</summary><p>项目包包含零件、装配步骤和已绑定的 CAD。采购记录保存在当前设备。</p>
    <div class="row"><button class="btn" type="button" data-ah="export">导出装配项目包</button><button class="btn" type="button" data-ah="choose">导入项目包…</button><a class="btn" href="./samples/assembly-example.json" download>下载示例项目包</a><input type="file" accept=".json,application/json" data-ah-file hidden></div>
    <div data-ah-preview hidden class="card"><b data-ah-preview-title></b><p data-ah-preview-info></p><div class="row"><button class="btn btn-primary" type="button" data-ah="apply">替换当前项目</button><button class="btn" type="button" data-ah="cancel">取消导入</button></div></div>
    <p data-ah-message role="status" aria-live="polite"></p></details></div></section>`;
}
function issues(st){
  const {parts,steps}=st.design;
  const noModel=parts.filter((p,i)=>!st.cadBindings?.[i]&&!resolveModelForRow(p,st.items?.[i]).catalogOriginal).length,stale=parts.filter((p,i)=>st.cadBindings?.[i]&&resolveModelForRow(p,st.items?.[i],st.cadBindings[i]).stale).length,noSku=parts.filter((_,i)=>!(st.items?.[i]?.skuId||st.items?.[i]?.mpn||st.items?.[i]?.sku)).length,unmapped=steps.filter((_,i)=>!st.assemblyStepParts?.[i]?.length).length;
  return [[noSku,'项未登记商品规格或料号'],[noModel,'项未附型号 CAD 或尺寸'],[stale,'项绑定已与当前选型不符'],[unmapped,'步未关联零件']].filter(([v])=>v).map(([v,label])=>v+' '+label+'。').join('')+' 请对照到货实物检查尺寸、配合与功能。';
}
const mounted=new WeakMap();
export function mountAssemblyHandoff(root,st,{onImport,onSave,sampleDesign}={}) {
  const node=root?.matches?.('[data-assembly-handoff]')?root:root?.querySelector('[data-assembly-handoff]');
  if(!node)return ()=>{};
  mounted.get(node)?.();
  const q=s=>node.querySelector(s), file=q('[data-ah-file]'),preview=q('[data-ah-preview]'),status=q('[data-ah-message]');
  let current=currentStep(st),pending=null,serial=0,importing=false,disposed=false;
  const say=s=>{status.textContent=s};
  function resetPreview(){serial++;pending=null;preview.hidden=true;file.value=''}
  function redraw(){q('[data-ah-step]').innerHTML=stepView(st,current)}
  async function change(e){
    if(e.target===file){
      const f=file.files?.[0];resetPreview();if(!f){say('');return}
      const request=serial;say('正在读取本地文件…');
      try{
        if(f.size>MAX_HANDOFF_BYTES)fail('项目包超过 6 MiB。');
        const raw=await f.text();if(disposed||serial!==request)return;
        const next=readHandoffBundle(raw,{sampleDesign});pending=next;preview.hidden=false;
        q('[data-ah-preview-title]').textContent='准备导入：'+next.design.name;
        q('[data-ah-preview-info]').textContent=`${next.design.parts.length} 类零件 · ${next.design.steps.length} 个步骤 · ${Object.keys(next.cadBindings).length} 个模型绑定。替换后，当前项目及采购记录将从此工作台移除。需要保留时请先导出。`;
        say('已读取资料，当前项目尚未改变。');q('[data-ah="apply"]').focus();
      }catch(error){if(disposed||serial!==request)return;resetPreview();say(error.message)}
      return;
    }
    if(!e.target.matches?.('[data-ah-part]')||importing)return;
    const i=Number(e.target.dataset.ahPart);if(!Number.isInteger(i)||i<0||i>=st.design.parts.length)return;
    const before=st.assemblyStepParts||{},set=new Set(before[current]||[]);
    if(e.target.checked)set.add(i);else set.delete(i);
    st.assemblyStepParts={...before,[current]:[...set].sort((a,b)=>a-b)};
    try{
      if(await onSave?.(st)===false)fail('浏览器未能保存步骤关联。');
      if(disposed)return;
      q('[data-ah-part-summary]').innerHTML=partsSummary(st,st.assemblyStepParts[current]||[]);
      q('[data-ah-issues]').textContent=issues(st);say('已更新本步关联零件。');
    }catch(error){st.assemblyStepParts=before;if(!disposed){redraw();say(error.message)}}
  }
  async function click(e) {
    const action=e.target.closest?.('button[data-ah]')?.dataset.ah;if(!action||importing)return;
    try{
      if(action==='previous'||action==='next'){current=Math.max(0,Math.min(st.design.steps.length-1,current+(action==='next'?1:-1)));lastSteps.set(st,current);redraw();q('[data-ah="'+(action==='next'&&current===st.design.steps.length-1?'previous':action==='previous'&&current===0?'next':action)+'"]')?.focus();return}
      if(action==='choose'){file.click();return}
      if(action==='cancel'){resetPreview();say('已取消导入。');return}
      if(action==='apply'&&pending){
        if(typeof onImport!=='function')fail('当前工作台未接入项目导入。');
        importing=true;const buttons=[...node.querySelectorAll('button,input')],flags=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);
        try{
          await onImport(pending);
          if(!disposed){resetPreview();say('装配项目已导入。')}
        }finally{importing=false;if(!disposed)buttons.forEach((b,i)=>b.disabled=flags[i])}
        return;
      }
      if(action==='export'){
        const json=JSON.stringify(createHandoffBundle(st)),url=URL.createObjectURL(new Blob([json],{type:'application/json;charset=utf-8'})),a=document.createElement('a');
        try{a.href=url;a.download='formwork-assembly-project.json';a.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),2000)}
        say('已生成装配项目包。');return;
      }
    }catch(error){if(!disposed)say(error?.message||'未能完成此操作。')}
  }
  node.addEventListener('change',change);node.addEventListener('click',click);
  const dispose=()=>{disposed=true;serial++;pending=null;node.removeEventListener('change',change);node.removeEventListener('click',click);mounted.delete(node)};
  mounted.set(node,dispose);return dispose;
}
