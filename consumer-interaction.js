import {initialInteraction,stepInteraction,usesHeldEvents} from './interaction-model.js';
import {projectWorldPoint} from './mesh-renderer.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const sessionTime=value=>[Math.floor(value/3600),Math.floor(value/60)%60,Math.floor(value)%60].map(v=>String(v).padStart(2,'0')).join(':');
const bodyId=id=>Number(/^body-(\d+)-/.exec(id||'')?.[1]??-1);
const controlBodies=control=>control.kind==='command'?[]:control.kind==='touch'?[control.fixedBodyIndex]:control.movingBodyIndices;
const clock=value=>Math.floor(Math.max(0,value)/60).toString().padStart(2,'0')+':'+Math.floor(Math.max(0,value)%60).toString().padStart(2,'0');
let viewerSequence=0;

const lightColors=[
 ['red',/(?<!粉)(?:红色|红光|红灯)|\bred\b/i,'240 68 68','#ffb2b2'],
 ['green',/绿色|绿光|绿灯|\bgreen\b/i,'77 226 138','#a0ffbd'],
 ['blue',/蓝色|蓝光|蓝灯|\bblue\b/i,'67 135 245','#b0d2ff'],
 ['yellow',/黄色|黄光|黄灯|\byellow\b/i,'245 206 63','#fff0a2'],
 ['orange',/橙色|橙光|橙灯|琥珀|\borange\b|\bamber\b/i,'245 152 55','#ffdda6'],
 ['purple',/紫色|紫光|紫灯|\bpurple\b|\bviolet\b/i,'173 103 240','#e2bcff'],
 ['pink',/粉色|粉红|粉光|\bpink\b/i,'242 106 174','#ffc0e1'],
 ['cyan',/青色|青光|青灯|\bcyan\b/i,'58 211 221','#b0f7ff'],
 ['white',/白色|白光|白灯|\bwhite\b/i,'230 238 245','#ffffff']
];
// Read only explicit light specifications and clauses bound to this output.
// PWM frequency, timer durations and another lamp's instructions are not cycles.
export function lightPresentation(output,design={}){
 const part=design.parts?.[output.partIndex]||{},metadata=[output.label,part.name,part.model,part.spec,part.purpose].filter(value=>typeof value==='string');
 const names=[output.label,part.name,part.model].filter(value=>typeof value==='string'&&value.length>=2);
 const single=(design.interaction?.outputs||[]).filter(item=>item.kind==='light').length===1;
 const clauses=(design.steps||[]).filter(step=>typeof step==='string').flatMap(step=>step.split(/[。；;\n，,]/)).filter(clause=>names.some(name=>clause.includes(name))||(single&&/单灯|LED|(?:指示|提示|呼吸|红|绿|蓝|黄|橙|紫|白|青)灯/i.test(clause)));
 const text=[...metadata,...clauses].join('\n');
 const colors=lightColors.filter(([,pattern])=>pattern.test(text));
 const selected=colors.length===1?colors[0]:lightColors.find(([name])=>name==='green');
 const cycles=[];
 const patterns=[
  /(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?|s)\s*(?:的\s*)?(?:明暗|亮灭|呼吸)\s*(?:周期|循环)/gi,
  /(?:明暗|亮灭|呼吸)\s*(?:周期|循环)\s*(?:为|是|约|[:：=])?\s*(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?|s)/gi,
  /每\s*(\d+(?:\.\d+)?)\s*秒\s*(?:完成)?\s*一(?:次|轮|个)\s*(?:呼吸|明暗|亮灭)/g,
  /(\d+(?:\.\d+)?)\s*秒\s*一(?:轮|次)\s*(?:明暗|亮灭|呼吸)/g,
  /(?:breath(?:e|ing)?|pulse)\s*(?:cycle|period)\s*(?:of|is|[:=])?\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi,
  /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s*(?:breath(?:e|ing)?|pulse)\s*(?:cycle|period)\b/gi
 ];
 for(const pattern of patterns)for(const match of text.matchAll(pattern)){const value=Number(match[1]);if(value>0&&Number.isFinite(value))cycles.push(value);}
 const unique=[...new Set(cycles)];
 return {color:selected[0],rgb:selected[2],core:selected[3],cycleSeconds:unique.length===1?unique[0]:2.8,explicitColor:colors.length===1,explicitCycle:unique.length===1};
}

export function displayValue(output,design={},seconds){
 const part=design.parts?.[output.partIndex]||{};
 const metadata=[output.label,part.name,part.model,part.spec,part.purpose].filter(value=>typeof value==='string').join('\n');
 if(/分钟|\bminutes?\b/i.test(metadata)&&!/秒|\bseconds?\b/i.test(metadata)){
  const names=[output.label,part.name].filter(value=>typeof value==='string'&&value.length>=2);
  const clauses=(design.steps||[]).filter(step=>typeof step==='string').flatMap(step=>step.split(/[。；;\n，,]/)).filter(clause=>names.some(name=>clause.includes(name))||/分钟|\bminutes?\b/i.test(clause));
  const instructions=[metadata,...clauses].join('\n');
  if(/分钟[^。；;\n]{0,12}向上取整|向上取整[^。；;\n]{0,12}分钟|\bminutes?[^.\n]{0,30}(?:round(?:ed)?\s+up|ceil)|(?:round(?:ed)?\s+up|ceil)[^.\n]{0,30}\bminutes?/i.test(instructions)&&!/向下取整|四舍五入|\bfloor\b|round(?:ed)?\s+down/i.test(instructions))return String(Math.ceil(Math.max(0,seconds)/60));
 }
 return clock(seconds);
}

// The contract names moving bodies explicitly. A control's fixed board and all
// other bodies retain their original vertices, even when they share a BOM part.
export function interactionMesh(mesh,offset,bodyIndex,model,snapshot,gestures={}){
 const controls=(model?.controls||[]).filter(control=>control.fixedBodyIndex!==bodyIndex&&control.movingBodyIndices.includes(bodyIndex));
 const transforms=controls.map(control=>({control,value:control.kind==='turn'?snapshot.controlValues?.[control.id]||0:(gestures[control.id]||0)*control.step})).filter(item=>item.value).map(({control,value})=>{
  const transform=new DOMMatrix(),axis=control.axis;
  if(control.kind==='turn')transform.translateSelf(...control.pivotMm).rotateAxisAngleSelf(...axis,value).translateSelf(...control.pivotMm.map(v=>-v));
  else{const length=Math.hypot(...axis)||1;transform.translateSelf(...axis.map(v=>v*value/length));}
  return transform;
 });
 if(!transforms.length)return mesh;
 const points=mesh.points.map(point=>{
  let world=point.map((value,k)=>value+offset[k]);
  for(const transform of transforms){const p=transform.transformPoint({x:world[0],y:world[1],z:world[2]});world=[p.x,p.y,p.z];}
  return world.map((v,k)=>v-offset[k]);
 });
 return {...mesh,points,projected:new Float64Array(points.length*3)};
}

export function mountCadInteraction(root,model,{design={},onChange=()=>{},onMotion=()=>{}}={}){
 if(!model?.states?.length||!(model.controls?.length||model.systemEvents?.length))return null;
 const stage=root.querySelector('.cc-stage'),footer=root.querySelector('.cc-footer'),canvas=stage.querySelector('canvas');
 const overlay=document.createElement('div');overlay.className='ci-overlay';overlay.setAttribute('aria-hidden','true');
 const hint=document.createElement('p');hint.className='ci-gesture';hint.textContent=model.controls.some(c=>c.kind!=='command')?'可操作模型上的控件或下方控制台':'使用下方控制台试动作 · 拖动模型转动视角';
 const panel=document.createElement('section');panel.className='ci-panel';panel.setAttribute('aria-label','功能交互预览');
 const recorder=model.recorder,samples=(model.systemEvents||[]).filter(e=>recorder?.sampleEvents.includes(e.id)),otherEvents=(model.systemEvents||[]).filter(e=>!samples.includes(e));
 const webOutputs=model.outputs.filter(output=>output.kind==='web');
 const historyTitle=webOutputs.some(output=>output.id===recorder?.displayId)?'手机网页 · 记录预览':'记录预览';
 const eventButton=e=>`<button type="button" class="ci-control" data-ci-event="${escape(e.id)}" title="${escape(e.condition)}">${escape(e.label)}${e.kind==='timeout'?' · '+Number(e.delayMs)+' ms':''}</button>`;
 panel.innerHTML=`<div class="ci-heading"><strong>交互控制台</strong><output data-ci-state role="status" aria-live="polite"></output>${model.timer?'<button type="button" data-ci-finish>快进到结束</button>':''}</div><div class="ci-controls">${model.controls.map(control=>{
  const name=escape(control.label),id=escape(control.id);
  if(control.kind==='turn')return `<div class="ci-control"><span>${name}</span><button type="button" data-ci-step="${id}" data-ci-delta="${-Math.sign(control.step)}" aria-label="${name}减少">−</button><output data-ci-value="${id}"></output><button type="button" data-ci-step="${id}" data-ci-delta="${Math.sign(control.step)}" aria-label="${name}增加">＋</button></div>`;
  if(control.kind==='slide')return `<label class="ci-control"><span>${name}</span><input type="range" min="0" max="100" value="0" data-ci-slide="${id}" aria-label="${name}"><small>释放复位</small></label>`;
  return `<button type="button" class="ci-control ci-press" data-ci-press="${id}">${name}</button>`;
 }).join('')}</div>${webOutputs.map(o=>`<p class="ci-web-readout">${escape(o.label)} <output data-ci-web="${escape(o.id)}" data-ci-output="${escape(o.id)}"></output></p>`).join('')}${recorder?`<section class="ci-history" aria-label="${historyTitle}"><strong>${historyTitle}</strong><p data-ci-session></p><ol data-ci-log></ol><div class="ci-controls"><button type="button" data-ci-advance>模拟经过 15 分钟</button>${samples.map(eventButton).join('')}</div><small>这里使用模拟输入；没有收到记录的时段，不能推断实际发生了什么。</small></section>`:''}${otherEvents.length?`<details class="ci-events" ${!model.controls.length?'open':''}><summary>模拟设备事件</summary><div class="ci-controls">${otherEvents.map(eventButton).join('')}</div></details>`:''}<p class="ci-note">功能行为预览 · 尚未实物验证<span data-ci-feedback></span></p>`;
 stage.append(overlay,hint);footer.prepend(panel);
 const markers=new Map(),outputs=new Map(),tracks=new Map();
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),arrow='ci-arrow-'+(++viewerSequence);
 svg.classList.add('ci-tracks');svg.innerHTML=`<defs><marker id="${arrow}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#5888a2"/></marker></defs>`;overlay.append(svg);
 for(const control of model.controls){
  if(control.kind==='command')continue;
  // A combined turn/press knob gets one physical gesture marker.
  const key=controlBodies(control).join(',');if(markers.has(key))continue;
  const peers=model.controls.filter(c=>controlBodies(c).join(',')===key);
  const marker=document.createElement('span');marker.className='ci-marker';marker.dataset.ciTarget=control.id;
  marker.textContent=peers.some(c=>c.kind==='turn')?'拖动旋转'+(peers.some(c=>c.kind==='press')?' · 点按':''):control.kind==='slide'?'沿轨道拖动':'点按';
  overlay.append(marker);markers.set(key,{element:marker,indices:controlBodies(control)});
  if(control.kind==='slide'){
   const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('marker-end','url(#'+arrow+')');line.dataset.ciTrack=control.id;svg.append(line);tracks.set(control.id,{element:line,control});
  }
 }
 for(const output of model.outputs||[]){
  if(output.kind==='web'){
   const element=[...panel.querySelectorAll('[data-ci-web]')].find(node=>node.dataset.ciWeb===output.id);
   element.title=output.label;outputs.set(output.id,{element,output});continue;
  }
  const element=document.createElement('span');element.className='ci-output ci-output-'+output.kind;element.dataset.ciOutput=output.id;
  if(output.kind==='light'){
   const appearance=lightPresentation(output,{...design,interaction:model});
   element.style.setProperty('--ci-light-rgb',appearance.rgb);element.style.setProperty('--ci-light-core',appearance.core);
   element.style.setProperty('--ci-breathe-cycle',appearance.cycleSeconds+'s');
  }
  element.title=output.label;overlay.append(element);outputs.set(output.id,{element,output});
 }
 let snapshot=initialInteraction(model),gestures={},camera=null,scene=[],pick=null,enabled=false,active=null,lastTick=performance.now(),poseRevision=0;
 const transformed=new WeakMap();
 const timers=new Set(),heldControls=new Set();
 let listedEntries,listedState;
 function renderState(){
  const state=model.states.find(state=>state.id===snapshot.stateId);
  const stateNode=panel.querySelector('[data-ci-state]'),stateText=(state?.label||snapshot.stateId)+(model.timer?' · '+clock(snapshot.remainingSeconds):'');
  if(stateNode.textContent!==stateText)stateNode.textContent=stateText;
  for(const element of panel.querySelectorAll('[data-ci-value]'))element.textContent=Number((snapshot.controlValues?.[element.dataset.ciValue]||0).toFixed(1))+'°';
  for(const button of panel.querySelectorAll('[data-ci-step]')){const c=model.controls.find(c=>c.id===button.dataset.ciStep),angle=snapshot.controlValues[c.id]||0;button.disabled=Boolean(c.range&&(Number(button.dataset.ciDelta)*c.step>0?angle>=c.range.max:angle<=c.range.min));}
  const finish=panel.querySelector('[data-ci-finish]');if(finish)finish.disabled=state?.clock!=='run'||snapshot.remainingSeconds<=0;
  const capturing=recorder?.captureStates.includes(snapshot.stateId),reviewing=recorder?.reviewStates.includes(snapshot.stateId);
  for(const button of panel.querySelectorAll('[data-ci-event]'))button.disabled=!(capturing&&recorder.sampleEvents.includes(button.dataset.ciEvent))&&!model.transitions.some(t=>t.from===snapshot.stateId&&t.event===button.dataset.ciEvent);
  if(recorder){
   const r=snapshot.recording,list=panel.querySelector('[data-ci-log]');panel.querySelector('[data-ci-advance]').disabled=!capturing;
   panel.querySelector('[data-ci-session]').textContent=capturing?'正在记录 · '+sessionTime(r.elapsedSeconds)+' · '+(r.entries.length+r.dropped)+' 条':reviewing?'本次时长 '+sessionTime(r.elapsedSeconds)+' · '+(r.entries.length?'已记录 '+(r.entries.length+r.dropped)+' 条':'尚无记录')+(r.dropped?'；仅显示最近 '+r.entries.length+' 条':''):'等待开始记录';
   if(listedEntries!==r.entries||listedState!==snapshot.stateId){list.replaceChildren();list.hidden=!reviewing||!r.entries.length;if(reviewing)for(const e of r.entries){const li=document.createElement('li');li.textContent=sessionTime(e.atSeconds)+'　'+e.label;list.append(li);}listedState=snapshot.stateId;listedEntries=r.entries;}
  }
  panel.querySelector('[data-ci-feedback]').textContent=(model.outputs||[]).length?' · '+model.outputs.map(output=>output.label+' '+outputText(output)).join('，'):'';
  for(const {element,output} of outputs.values()){
   const mode=snapshot.outputs?.[output.id]||'off';element.dataset.mode=mode;
   element.textContent=output.kind==='light'?'':outputText(output);
   element.setAttribute('aria-label',output.label+' '+outputText(output));
  }
 }
 function outputText(output){
  const mode=snapshot.outputs?.[output.id]||'off';
  if(mode!=='off'&&recorder?.displayId===output.id&&(recorder.reviewStates.includes(snapshot.stateId)||recorder.captureStates.includes(snapshot.stateId)))return (recorder.reviewStates.includes(snapshot.stateId)?'本次记录 ':'记录中 ')+(snapshot.recording.entries.length+snapshot.recording.dropped)+' 条';
  if(mode==='remaining')return displayValue(output,design,snapshot.remainingSeconds);
  if(mode==='value')return model.timer?displayValue(output,design,snapshot.setSeconds):String(snapshot.setSeconds??0);
  return {off:'关闭',on:'开启',breathe:'呼吸',forward:'正向运动',reverse:'反向运动'}[mode]||mode;
 }
 function notify(){renderState();onChange(snapshot);}
 function dispatch(control,delta=1,phase){
  const now=performance.now();snapshot=stepInteraction(model,snapshot,{elapsedSeconds:(now-lastTick)/1000});lastTick=now;
  snapshot=stepInteraction(model,snapshot,{controlId:control.id,delta,...(phase?{phase}:{})});if(control.kind==='turn')poseRevision++;notify();
 }
 function pose(control,value){if((gestures[control.id]||0)===value)return;gestures={...gestures,[control.id]:value};poseRevision++;onChange(snapshot);}
 function pulse(control){pose(control,1);const timer=setTimeout(()=>{timers.delete(timer);pose(control,0)},160);timers.add(timer);}
 function held(control,phase){
  if(phase==='down'){if(heldControls.has(control.id))return;heldControls.add(control.id);}
  else if(!heldControls.delete(control.id))return;
  pose(control,phase==='down'?1:0);dispatch(control,1,phase);
 }
 function cancelHeld(){for(const id of [...heldControls])held(model.controls.find(c=>c.id===id),'cancel');if(active?.press)pose(active.press,0);active=null;}
 const aborter=new AbortController(),listen=(type,fn)=>panel.addEventListener(type,fn,{signal:aborter.signal});
 const heldButton=event=>{const button=event.target.closest('[data-ci-press]'),control=button&&model.controls.find(c=>c.id===button.dataset.ciPress);return control&&usesHeldEvents(model,control)?{button,control}:null;};
 listen('pointerdown',event=>{const item=heldButton(event);if(!item||event.button!==0)return;item.button.setPointerCapture(event.pointerId);held(item.control,'down');});
 listen('pointerup',event=>{const item=heldButton(event);if(item)held(item.control,'up');});
 listen('pointercancel',event=>{const item=heldButton(event);if(item)held(item.control,'cancel');});
 listen('lostpointercapture',event=>{const item=heldButton(event);if(item)held(item.control,'cancel');});
 listen('focusout',event=>{const item=heldButton(event);if(item)held(item.control,'cancel');});
 listen('keydown',event=>{const item=heldButton(event);if(item&&[' ','Enter'].includes(event.key)){event.preventDefault();if(!event.repeat)held(item.control,'down');}});
 listen('keyup',event=>{const item=heldButton(event);if(item&&[' ','Enter'].includes(event.key)){event.preventDefault();held(item.control,'up');}});
 window.addEventListener('blur',cancelHeld,{signal:aborter.signal});
 listen('click',event=>{
  const step=event.target.closest('[data-ci-step]'),press=event.target.closest('[data-ci-press]');
  if(step){const c=model.controls.find(c=>c.id===step.dataset.ciStep);dispatch(c,Number(step.dataset.ciDelta));}
  if(press){const c=model.controls.find(c=>c.id===press.dataset.ciPress);if(!usesHeldEvents(model,c)){pulse(c);dispatch(c);}}
  if(event.target.closest('[data-ci-finish]')){snapshot=stepInteraction(model,snapshot,{elapsedSeconds:snapshot.remainingSeconds});notify();}
  if(event.target.closest('[data-ci-advance]')){snapshot=stepInteraction(model,snapshot,{elapsedSeconds:900});notify();}
  const system=event.target.closest('[data-ci-event]');
  if(system&&!system.disabled){snapshot=stepInteraction(model,snapshot,{systemEventId:system.dataset.ciEvent});notify();}
 });
 listen('input',event=>{const c=model.controls.find(c=>c.id===event.target.dataset.ciSlide);if(c)pose(c,Number(event.target.value)/100)});
 listen('change',event=>{
  const c=model.controls.find(c=>c.id===event.target.dataset.ciSlide);if(!c)return;
  if(Number(event.target.value)>=50)dispatch(c);event.target.value='0';pose(c,0);
 });
 const interval=setInterval(()=>{
  const now=performance.now(),elapsed=(now-lastTick)/1000;lastTick=now;
  if(enabled)onMotion(snapshot,Math.min(elapsed,.2));
  const state=model.states.find(state=>state.id===snapshot.stateId);
  if(state?.clock==='run'&&model.timer||recorder?.captureStates.includes(snapshot.stateId)){
   const previous=snapshot;snapshot=stepInteraction(model,snapshot,{elapsedSeconds:elapsed});
   if(previous.stateId!==snapshot.stateId||Math.floor(previous.remainingSeconds)!==Math.floor(snapshot.remainingSeconds)||Math.floor(previous.recording?.elapsedSeconds??0)!==Math.floor(snapshot.recording?.elapsedSeconds??0))notify();
  }
 },100);
 function point(event){const box=canvas.getBoundingClientRect();return [event.clientX-box.left,event.clientY-box.top]}
 function controlAt(point){
  if(!enabled||!pick)return [];
  const index=bodyId(pick(...point));
  return model.controls.filter(control=>controlBodies(control).includes(index));
 }
 function anchor(indices){
  const objects=scene.filter(object=>indices.includes(bodyId(object.id)));if(!objects.length)return null;
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const {mesh,offset=[0,0,0]} of objects)for(const p of mesh.points)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]+offset[k]);max[k]=Math.max(max[k],p[k]+offset[k]);}
  const center=min.map((v,k)=>(v+max[k])/2),projected=projectWorldPoint(center,camera);
  const points=[];for(const x of [min[0],max[0]])for(const y of [min[1],max[1]])for(const z of [min[2],max[2]])points.push(projectWorldPoint([x,y,z],camera));
  const width=Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]));
  const height=Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]));
  // Check the same depth-tested surface used by pointer picking. This prevents
  // lights, screens and controls showing through an opaque enclosure/back side.
  const visible=[0,-.23,.23].some(dx=>[0,-.23,.23].some(dy=>indices.includes(bodyId(pick(projected[0]+dx*width,projected[1]+dy*height)))));
  return {...{x:projected[0],y:projected[1],width,height},visible};
 }
 function position(element,value,marker=false){
  element.hidden=!value?.visible||!enabled;if(element.hidden)return;
  element.style.left=value.x+'px';element.style.top=value.y+'px';
  if(marker)element.style.setProperty('--ci-distance',(value.height/2+16)+'px');
  if(!marker&&element.classList.contains('ci-output-display'))element.style.width=clamp(value.width*.8,38,110)+'px';
 }
 renderState();
 return {
  snapshot:()=>snapshot,
  cancel:cancelHeld,
  transform(mesh,offset,index){
   const key=[index,...offset,poseRevision].join(','),cached=transformed.get(mesh);if(cached?.key===key)return cached.mesh;
   const moved=interactionMesh(mesh,offset,index,model,snapshot,gestures);transformed.set(mesh,{key,mesh:moved});return moved;
  },
  paint(nextCamera,nextScene,nextPick,mode){
   camera=nextCamera;scene=nextScene;pick=nextPick;enabled=Boolean(camera)&&(mode==='closed'||mode==='inside');
   overlay.hidden=hint.hidden=!enabled;if(!enabled){cancelHeld();return;}
   for(const {element,indices} of markers.values())position(element,anchor(indices),true);
   for(const {element,output} of outputs.values())if(output.kind!=='web')position(element,anchor(output.bodyIndices));
   for(const {element,control} of tracks.values()){
    const at=anchor(controlBodies(control));element.style.display=enabled&&at?.visible?'':'none';
    const start=projectWorldPoint(control.pivotMm,camera),end=projectWorldPoint(control.pivotMm.map((v,k)=>v+control.axis[k]*control.step),camera);
    for(const [name,value] of [['x1',start[0]],['y1',start[1]],['x2',end[0]],['y2',end[1]]])element.setAttribute(name,value);
   }
  },
  pointerDown(event){
   const origin=point(event),controls=controlAt(origin);if(!controls.length)return false;
   event.preventDefault();canvas.focus({preventScroll:true});
   const turn=controls.find(c=>c.kind==='turn'),slide=controls.find(c=>c.kind==='slide'),press=controls.find(c=>c.kind==='press'||c.kind==='touch');
   active={origin,turn,slide,press,steps:0,travel:0,moved:false};
   if(press){pose(press,1);if(usesHeldEvents(model,press))held(press,'down');}canvas.style.cursor=turn?'ew-resize':slide?'move':'pointer';return true;
  },
  pointerMove(event){
   const current=point(event);
   if(!active){canvas.style.cursor=controlAt(current).length?'pointer':'';return false;}
   event.preventDefault();const dx=current[0]-active.origin[0],dy=current[1]-active.origin[1];
   if(Math.hypot(dx,dy)>4){active.moved=true;if(active.press){pose(active.press,0);if(usesHeldEvents(model,active.press))held(active.press,'cancel');}}
   if(active.turn&&active.moved){
    const steps=Math.trunc((dx-dy)/9),delta=steps-active.steps;
    if(delta){active.steps=steps;dispatch(active.turn,delta);}
   }else if(active.slide){
    const c=active.slide,a=projectWorldPoint(c.pivotMm,camera),b=projectWorldPoint(c.pivotMm.map((v,k)=>v+c.axis[k]*c.step),camera),sx=b[0]-a[0],sy=b[1]-a[1],length=sx*sx+sy*sy;
    active.travel=clamp(length>4?(dx*sx+dy*sy)/length:(dx-dy)/40,0,1);pose(c,active.travel);
   }
   return true;
  },
  pointerUp(event,cancelled=false){
   if(!active)return false;
   const gesture=active;active=null;
   if(gesture.press){pose(gesture.press,0);if(usesHeldEvents(model,gesture.press))held(gesture.press,cancelled?'cancel':'up');else if(!cancelled&&!gesture.moved)dispatch(gesture.press);}
   if(gesture.slide){pose(gesture.slide,0);if(!cancelled&&gesture.travel>=.5)dispatch(gesture.slide);}
   canvas.style.cursor='';return true;
  },
  dispose(){active=null;clearInterval(interval);timers.forEach(clearTimeout);aborter.abort();overlay.remove();hint.remove();panel.remove();}
 };
}
