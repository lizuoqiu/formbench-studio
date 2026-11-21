import {initialInteraction,stepInteraction} from './interaction-model.js';
import {projectWorldPoint} from './mesh-renderer.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const bodyId=id=>Number(/^body-(\d+)-/.exec(id||'')?.[1]??-1);
const controlBodies=control=>control.kind==='touch'?[control.fixedBodyIndex]:control.movingBodyIndices;
const clock=value=>Math.floor(Math.max(0,value)/60).toString().padStart(2,'0')+':'+Math.floor(Math.max(0,value)%60).toString().padStart(2,'0');
let viewerSequence=0;

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

export function mountCadInteraction(root,model,{onChange=()=>{}}={}){
 if(!model?.controls?.length||!model?.states?.length)return null;
 const stage=root.querySelector('.cc-stage'),footer=root.querySelector('.cc-footer'),canvas=stage.querySelector('canvas');
 const overlay=document.createElement('div');overlay.className='ci-overlay';overlay.setAttribute('aria-hidden','true');
 const hint=document.createElement('p');hint.className='ci-gesture';hint.textContent='直接操作模型上的控件 · 拖动空白处转动视角';
 const panel=document.createElement('section');panel.className='ci-panel';panel.setAttribute('aria-label','功能交互预览');
 panel.innerHTML=`<div class="ci-heading"><strong>试用交互</strong><output data-ci-state role="status" aria-live="polite"></output>${model.timer?'<button type="button" data-ci-finish>快进到结束</button>':''}</div><div class="ci-controls">${model.controls.map(control=>{
  const name=escape(control.label),id=escape(control.id);
  if(control.kind==='turn')return `<div class="ci-control"><span>${name}</span><button type="button" data-ci-step="${id}" data-ci-delta="-1" aria-label="${name}减少">−</button><output data-ci-value="${id}"></output><button type="button" data-ci-step="${id}" data-ci-delta="1" aria-label="${name}增加">＋</button></div>`;
  if(control.kind==='slide')return `<label class="ci-control"><span>${name}</span><input type="range" min="0" max="100" value="0" data-ci-slide="${id}" aria-label="${name}"><small>释放复位</small></label>`;
  return `<button type="button" class="ci-control ci-press" data-ci-press="${id}">${name}</button>`;
 }).join('')}</div><p class="ci-note">功能行为预览 · 尚未实物验证<span data-ci-feedback></span></p>`;
 stage.append(overlay,hint);footer.prepend(panel);
 const markers=new Map(),outputs=new Map(),tracks=new Map();
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),arrow='ci-arrow-'+(++viewerSequence);
 svg.classList.add('ci-tracks');svg.innerHTML=`<defs><marker id="${arrow}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#5888a2"/></marker></defs>`;overlay.append(svg);
 for(const control of model.controls){
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
  const element=document.createElement('span');element.className='ci-output ci-output-'+output.kind;element.dataset.ciOutput=output.id;
  element.title=output.label;overlay.append(element);outputs.set(output.id,{element,output});
 }
 let snapshot=initialInteraction(model),gestures={},camera=null,scene=[],pick=null,enabled=false,active=null,lastTick=performance.now(),poseRevision=0;
 const transformed=new WeakMap();
 const timers=new Set();
 function renderState(){
  const state=model.states.find(state=>state.id===snapshot.stateId);
  panel.querySelector('[data-ci-state]').textContent=(state?.label||snapshot.stateId)+(model.timer?' · '+clock(snapshot.remainingSeconds):'');
  for(const element of panel.querySelectorAll('[data-ci-value]'))element.textContent=Number((snapshot.controlValues?.[element.dataset.ciValue]||0).toFixed(1))+'°';
  const finish=panel.querySelector('[data-ci-finish]');if(finish)finish.disabled=state?.clock!=='run'||snapshot.remainingSeconds<=0;
  panel.querySelector('[data-ci-feedback]').textContent=(model.outputs||[]).length?' · '+model.outputs.map(output=>output.label+' '+outputText(output)).join('，'):'';
  for(const {element,output} of outputs.values()){
   const mode=snapshot.outputs?.[output.id]||'off';element.dataset.mode=mode;
   element.textContent=output.kind==='light'?'':outputText(output);
   element.setAttribute('aria-label',output.label+' '+outputText(output));
  }
 }
 function outputText(output){
  const mode=snapshot.outputs?.[output.id]||'off';
  if(mode==='remaining')return clock(snapshot.remainingSeconds);
  if(mode==='value')return model.timer?clock(snapshot.setSeconds):String(snapshot.setSeconds??0);
  return {off:'关闭',on:'开启',breathe:'呼吸'}[mode]||mode;
 }
 function notify(){renderState();onChange(snapshot);}
 function dispatch(control,delta=1){
  const now=performance.now();snapshot=stepInteraction(model,snapshot,{elapsedSeconds:(now-lastTick)/1000});lastTick=now;
  snapshot=stepInteraction(model,snapshot,{controlId:control.id,delta});if(control.kind==='turn')poseRevision++;notify();
 }
 function pose(control,value){if((gestures[control.id]||0)===value)return;gestures={...gestures,[control.id]:value};poseRevision++;onChange(snapshot);}
 function pulse(control){pose(control,1);const timer=setTimeout(()=>{timers.delete(timer);pose(control,0)},160);timers.add(timer);}
 const aborter=new AbortController(),listen=(type,fn)=>panel.addEventListener(type,fn,{signal:aborter.signal});
 listen('click',event=>{
  const step=event.target.closest('[data-ci-step]'),press=event.target.closest('[data-ci-press]');
  if(step){const c=model.controls.find(c=>c.id===step.dataset.ciStep);dispatch(c,Number(step.dataset.ciDelta));}
  if(press){const c=model.controls.find(c=>c.id===press.dataset.ciPress);pulse(c);dispatch(c);}
  if(event.target.closest('[data-ci-finish]')){snapshot=stepInteraction(model,snapshot,{elapsedSeconds:snapshot.remainingSeconds});notify();}
 });
 listen('input',event=>{const c=model.controls.find(c=>c.id===event.target.dataset.ciSlide);if(c)pose(c,Number(event.target.value)/100)});
 listen('change',event=>{
  const c=model.controls.find(c=>c.id===event.target.dataset.ciSlide);if(!c)return;
  if(Number(event.target.value)>=50)dispatch(c);event.target.value='0';pose(c,0);
 });
 const interval=setInterval(()=>{
  const now=performance.now(),elapsed=(now-lastTick)/1000;lastTick=now;
  const state=model.states.find(state=>state.id===snapshot.stateId);
  if(state?.clock==='run'&&model.timer){
   const previous=snapshot;snapshot=stepInteraction(model,snapshot,{elapsedSeconds:elapsed});
   if(previous.stateId!==snapshot.stateId||Math.floor(previous.remainingSeconds)!==Math.floor(snapshot.remainingSeconds))notify();
  }
 },150);
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
  transform(mesh,offset,index){
   const key=[index,...offset,poseRevision].join(','),cached=transformed.get(mesh);if(cached?.key===key)return cached.mesh;
   const moved=interactionMesh(mesh,offset,index,model,snapshot,gestures);transformed.set(mesh,{key,mesh:moved});return moved;
  },
  paint(nextCamera,nextScene,nextPick,mode){
   camera=nextCamera;scene=nextScene;pick=nextPick;enabled=Boolean(camera)&&(mode==='closed'||mode==='inside');
   overlay.hidden=hint.hidden=!enabled;if(!enabled)return;
   for(const {element,indices} of markers.values())position(element,anchor(indices),true);
   for(const {element,output} of outputs.values())position(element,anchor(output.bodyIndices));
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
   if(press)pose(press,1);canvas.style.cursor=turn?'ew-resize':slide?'move':'pointer';return true;
  },
  pointerMove(event){
   const current=point(event);
   if(!active){canvas.style.cursor=controlAt(current).length?'pointer':'';return false;}
   event.preventDefault();const dx=current[0]-active.origin[0],dy=current[1]-active.origin[1];
   if(Math.hypot(dx,dy)>4){active.moved=true;if(active.press)pose(active.press,0);}
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
   if(gesture.press){pose(gesture.press,0);if(!cancelled&&!gesture.moved)dispatch(gesture.press);}
   if(gesture.slide){pose(gesture.slide,0);if(!cancelled&&gesture.travel>=.5)dispatch(gesture.slide);}
   canvas.style.cursor='';return true;
  },
  dispose(){active=null;clearInterval(interval);timers.forEach(clearTimeout);aborter.abort();overlay.remove();hint.remove();panel.remove();}
 };
}
