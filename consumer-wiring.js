import {projectWorldPoint} from './mesh-renderer.js';
import {wireColors} from './assembly-wires.js';
import {jointPoint} from './assembly-joints.js';

const svgNS='http://www.w3.org/2000/svg';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types={signal:'信号',power:'供电',ground:'共地'};
const arrow=route=>route.bidirectional?' ↔ ':' → ';
const pinLabel=route=>route.from.pin+arrow(route)+route.to.pin;
const fullLabel=route=>route.from.partName+' '+route.from.pin+arrow(route)+route.to.partName+' '+route.to.pin;
const element=(tag,attributes={})=>{const node=document.createElementNS(svgNS,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);return node;};

// Sample in CSS pixels, then ask the raster's own DPR-aware depth buffer. Wires
// behind opaque hardware are omitted rather than painted over that hardware.
export function projectWireRoute(points,camera,depthAt){
 const projected=points.map(point=>projectWorldPoint(point,camera)),samples=[];
 for(let segment=1;segment<projected.length;segment++){
  const a=projected[segment-1],b=projected[segment],count=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/3));
  for(let step=segment===1?0:1;step<=count;step++){
   const t=step/count,p=a.map((value,k)=>value+(b[k]-value)*t);
   samples.push({p,visible:p[2]+.18>=depthAt(p[0],p[1])});
  }
 }
 let d='',drawing=false;
 for(const {p,visible} of samples){if(visible){d+=(drawing?' L':' M')+p[0].toFixed(2)+' '+p[1].toFixed(2);drawing=true}else drawing=false;}
 return {d:d.trim(),projected,samples};
}

// Follow the same serial transforms as the owning hardware. Between different
// moving groups the line remains illustrative, not an inextensible cable solve.
export function poseWireRoute(route,bodyOffsets=new Map(),joints=[],jointValues=[]){
 const ends=[route.from,route.to],offsets=ends.map(end=>bodyOffsets.get(end.bodyIndex)||[0,0,0]);
 const together=offsets[0].every((n,k)=>n===offsets[1][k])&&joints.every(j=>j.movingBodyIndices.includes(ends[0].bodyIndex)===j.movingBodyIndices.includes(ends[1].bodyIndex));
 if(together)return route.points.map(point=>jointPoint(point.map((n,k)=>n+offsets[0][k]),ends[0].bodyIndex,joints,jointValues));
 const deltas=ends.map((end,i)=>{
  const point=route.points[i?route.points.length-1:0];
  return jointPoint(point.map((n,k)=>n+offsets[i][k]),end.bodyIndex,joints,jointValues).map((n,k)=>n-point[k]);
 });
 return route.points.map((point,index)=>{
  const t=index/Math.max(1,route.points.length-1);return point.map((n,k)=>n+deltas[0][k]*(1-t)+deltas[1][k]*t);
 });
}

export function mountConsumerWiring(root,wiring,{parts=[],onChange=()=>{},onFocusPart=()=>{}}={}){
 const rows=[...wiring.routes,...wiring.mates,...wiring.unresolved].sort((a,b)=>a.connectionIndex-b.connectionIndex);
 if(!rows.length)return null;
 const stage=root.querySelector('.cc-stage'),header=root.querySelector('.cc-header'),footer=root.querySelector('.cc-footer');
 const toggle=document.createElement('label');toggle.className='cc-wiring-toggle';toggle.hidden=true;
 toggle.innerHTML='<input type="checkbox" data-cc-wiring-toggle checked>走线';header.append(toggle);
 const svg=element('svg',{'class':'cc-wires','aria-label':'参考走线与针脚',hidden:''});stage.append(svg);
 const panel=document.createElement('section');panel.className='cc-wiring-panel';panel.hidden=true;panel.setAttribute('aria-label','参考走线');
 panel.innerHTML=`<div class="cc-wiring-tools"><strong>参考走线</strong><span class="cc-wire-key"><i style="--wire:${wireColors.signal}"></i>信号 <i style="--wire:${wireColors.power}"></i>供电 <i style="--wire:${wireColors.ground}"></i>共地</span><select data-cc-wire-choice aria-label="选择连接查看针脚"><option value="">点选模型中的线，查看两端针脚</option>${rows.map(row=>`<option value="${row.connectionIndex}">${escape(fullLabel(row))}${row.routing==='mate'?' · 插口配接':row.routing==='unlocated'?' · 待定位':''}</option>`).join('')}</select></div><div data-cc-wire-detail class="cc-wire-detail"></div><p class="cc-wire-routing-note">${wiring.routes.length} 条内部参考线${wiring.mates.length?' · '+wiring.mates.length+' 项插口配接':''}${wiring.unresolved.length?' · '+wiring.unresolved.length+' 项端点待定位':''}。线形为示意，未核验实际布线空间。</p>`;
 footer.prepend(panel);
 const choice=panel.querySelector('[data-cc-wire-choice]'),detail=panel.querySelector('[data-cc-wire-detail]'),groups=new Map();
 for(const route of wiring.routes){
  const group=element('g',{'data-cc-wire-index':route.connectionIndex,'role':'button','tabindex':'0','aria-label':fullLabel(route),'aria-pressed':'false'}),title=element('title');title.textContent=fullLabel(route);group.append(title);
  const halo=element('path',{'class':'cc-wire-halo'}),path=element('path',{'class':'cc-wire-path',stroke:wireColors[route.kind]}),hit=element('path',{'class':'cc-wire-hit'});
  group.append(halo,path,hit);
  const ends=['from','to'].map(name=>{
   const end=element('circle',{'class':'cc-wire-end','data-cc-wire-end':name,r:3.5,stroke:wireColors[route.kind]});
   group.append(end);return end;
  });
  const labels=['from','to'].map(name=>{
   const label=element('g',{'class':'cc-wire-pin-label','data-cc-wire-pin':name}),box=element('rect',{rx:4,height:21}),text=element('text',{x:7,y:14});
   text.textContent=route[name].pin;box.setAttribute('width',Math.max(30,route[name].pin.length*7+14));label.append(box,text);group.append(label);return label;
  });
  svg.append(group);groups.set(route.connectionIndex,{route,group,path,halo,hit,ends,labels});
 }
 let enabled=true,selected=null;
 function renderDetail(){
  const row=rows.find(row=>row.connectionIndex===selected);
  if(!row){detail.innerHTML='<span>每条线都对应两端针脚；点击线或使用上方选择框。</span>';return;}
  const endpoint=end=>{
   const model=parts[end.partIndex]?.model||'',quality={modeled:'模型端点',estimated:'针脚估位',connector:'插口配接',unlocated:'端点待定位'}[end.quality]||'端点待定位';
   return `<div><button type="button" data-cc-wire-focus="${end.partIndex}">${escape(end.partName)} <b>${escape(end.pin)}</b></button>${model?`<span>${escape(model)}</span>`:''}<small>${quality}${end.evidence?' · '+escape(end.evidence):''}</small></div>`;
  };
  detail.innerHTML=`<strong style="--wire:${wireColors[row.kind]}">${escape(pinLabel(row))} <small>${types[row.kind]}</small></strong><div class="cc-wire-end-details">${endpoint(row.from)}${endpoint(row.to)}</div>${row.routing==='mate'?'<p>外接线通过插口配接，不画成穿过外壳的内部导线。</p>':row.routing==='unlocated'?'<p>此连接尚无足够的针脚位置，保留连接关系，不绘制猜测端点。</p>':''}`;
 }
 function select(index){
  selected=rows.some(row=>row.connectionIndex===index)?index:null;choice.value=selected===null?'':String(selected);renderDetail();onChange();
 }
 function nearestWire(event){
  const box=svg.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
  let closest=null,distance=Infinity;
  for(const entry of groups.values()){
   if(!entry.visible)continue;const samples=entry.samples||[];
   for(let i=1;i<samples.length;i++){
    if(!samples[i-1].visible||!samples[i].visible)continue;
    const a=samples[i-1].p,b=samples[i].p,dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
    const t=length?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/length)):0;
    const gap=Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);
    if(gap<distance){distance=gap;closest=entry.route.connectionIndex;}
   }
  }
  return distance<=10?closest:null;
 }
 const aborter=new AbortController();
 toggle.querySelector('input').addEventListener('change',event=>{enabled=event.target.checked;onChange()},{signal:aborter.signal});
 choice.addEventListener('change',()=>select(choice.value===''?null:Number(choice.value)),{signal:aborter.signal});
 svg.addEventListener('click',event=>{const nearest=nearestWire(event);if(nearest!==null)select(nearest);},{signal:aborter.signal});
 svg.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key))return;const group=event.target.closest('[data-cc-wire-index]');if(group){event.preventDefault();select(Number(group.dataset.ccWireIndex));}},{signal:aborter.signal});
 panel.addEventListener('click',event=>{const button=event.target.closest('[data-cc-wire-focus]');if(button)onFocusPart(Number(button.dataset.ccWireFocus));},{signal:aborter.signal});
 renderDetail();
 return {
  select,enable(){enabled=true;toggle.querySelector('input').checked=true;},
  selectedRoute:()=>rows.find(row=>row.connectionIndex===selected),
  firstRoute:()=>wiring.routes[0]||rows[0],
  paint(camera,{mode,hiddenParts,selectedPart,depthAt,scene,backdrop,bodyOffsets,joints=[],jointValues=[]}){
   const supported=mode==='inside'||mode==='open',hidden=!supported||!enabled||!camera;toggle.hidden=panel.hidden=!supported;svg.toggleAttribute('hidden',hidden);
   panel.dataset.enabled=String(enabled);choice.disabled=!enabled;
   if(hidden)return;
   const viewport=stage.querySelector('canvas').getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);
   const bodySet=new Set([...scene,...backdrop].map(item=>Number(/^body-(\d+)-/.exec(item.id||'')?.[1]??-1)));
   for(const entry of groups.values()){
    const {route,group,path,halo,hit,ends,labels}=entry;
    const related=selectedPart===null||[route.from.partIndex,route.to.partIndex].some(index=>String(index)===selectedPart);
    const visible=related&&![route.from.partIndex,route.to.partIndex].some(index=>hiddenParts.has(String(index)))&&bodySet.has(route.from.bodyIndex)&&bodySet.has(route.to.bodyIndex);
    entry.visible=visible;group.style.display=visible?'':'none';if(!visible)continue;
    const points=poseWireRoute(route,bodyOffsets,joints,jointValues);
    const projection=projectWireRoute(points,camera,depthAt),active=selected===route.connectionIndex;entry.samples=projection.samples;
    group.dataset.selected=String(active);group.setAttribute('aria-pressed',String(active));group.dataset.quality=route.quality;
    for(const node of [path,halo,hit])node.setAttribute('d',projection.d);
    ends.forEach((node,index)=>{
     const p=projection.projected[index?projection.projected.length-1:0],shown=p&&p[2]+.18>=depthAt(p[0],p[1]);node.style.display=shown?'':'none';
     if(!p)return;node.setAttribute('cx',p[0]);node.setAttribute('cy',p[1]);node.dataset.quality=route[index?'to':'from'].quality;
     const label=labels[index];label.style.display=active&&shown?'':'none';
     const width=Number(label.querySelector('rect').getAttribute('width'));
     const x=Math.max(4,Math.min(viewport.width-width-4,p[0]+(index?8:-width-8))),y=Math.max(45,Math.min(viewport.height-30,p[1]-26));
     label.setAttribute('transform',`translate(${x},${y})`);
    });
   }
   // Selected connections sit on top of other reference wires, but their
   // geometry still obeys the opaque-body depth samples above.
   if(selected!==null){const group=groups.get(selected)?.group;if(group)svg.append(group);}
  },
  dispose(){aborter.abort();toggle.remove();svg.remove();panel.remove();}
 };
}
