import {occurrenceGroups} from '../installed-parts.js';
import {cadReviewKernel} from './interaction-geometry-review.mjs';
import {buildCadSolid} from '../cad-plan-compiler.js';

// All distances are mm. This certifies only the declared nominal, straight assembly route.
// Convex sweeps per solid overestimate concave moving features; a failed sweep is not
// proof that no other insertion route exists. Never upgrade these checks to a physical test.
const dims=[0,1,2],eps=1e-6;
const intersectBox=(a,b)=>dims.every(k=>a.min[k]<b.max[k]-eps&&a.max[k]>b.min[k]+eps);
const covers=(a,b)=>dims.every(k=>a.min[k]<=b.min[k]+eps&&a.max[k]>=b.max[k]-eps);
const bounds=items=>({min:dims.map(k=>Math.min(...items.map(s=>s.boundingBox().min[k]))),max:dims.map(k=>Math.max(...items.map(s=>s.boundingBox().max[k])))});
function contacts(s,t){if(!intersectBox(s.boundingBox(),t.boundingBox()))return false;const hit=s.intersect(t);try{return hit.volume()>eps;}finally{hit.delete();}}
export function needsHousing(design,requirements=[]){return Boolean(design.parts.some(p=>p.role==='enclosure'&&p.placement!=='loose')||requirements.some(t=>/外壳|封闭外罩|盖板|enclosure|closed housing/i.test(t)&&!/无需外壳|不要外壳|不需要外壳|no enclosure/i.test(t)));}
export async function reviewAssemblyFit(design,requirements=[],options={}){
 const {parts,cadPlan:plan}=design,checks=plan.fitChecks||[],issues=[],rows=[];
 const scope='标称 CAD：最终装配、封闭件的腔壁或开放件的支撑面（0.5 mm 标称接触范围）、逐件直线装入（各实体凸包连续扫掠）、盖板最终位置、沿声明方向合盖及适用的外接插头包络；使用草案实体或采购件的安装包络，不等于对原厂曲面、公差、线缆或实物的验证。';
 if(!needsHousing(design,requirements)&&!checks.length)return {status:'not-applicable',rows,issues,scope};
 const targets=new Set();for(const [p,part] of parts.entries())if(part.role==='internal'&&part.placement==='mounted')for(let i=0;i<part.qty;i++)targets.add(`${p}:${i}`);
 const closed=plan.bodies.flatMap((b,i)=>parts[b.partIndex]?.role==='enclosure'&&parts[b.partIndex].placement!=='loose'?[i]:[]);
 const explicitlyClosed=requirements.some(t=>/封闭(?:的)?(?:外壳|外罩|机壳)|closed (?:housing|enclosure)/i.test(t)&&!/无需|不要|不需要|不要求|not required|no closed/i.test(t));
 if(!closed.length&&(explicitlyClosed||!checks.length||checks.some(f=>f.mountType!=='open-mount')))issues.push('装入检查：没有可检查的壳体。');
 if(explicitlyClosed&&checks.length&&checks.every(f=>f.mountType==='open-mount'))issues.push('装入检查：明确要求封闭外壳，但没有任何实体接受内腔检查。');
 for(const k of targets)if(!checks.some(f=>`${f.partIndex}:${f.instanceIndex}`===k))issues.push(`装入检查：${parts[+k.split(':')[0]].name} #${+k.split(':')[1]+1} 未声明安装形式、实际支撑及装入方向。`);
 if(!checks.length&&!targets.size)issues.push('装入检查：外壳未声明任何待装入的实体，无法验证可用内腔。');
 const cache=new Map();let lib;const inserted=new Set(),closures=new Map();
 const pending=new Set(checks.flatMap(f=>parts[f.partIndex]?occurrenceGroups(plan,parts[f.partIndex],f.partIndex).groups.get(f.instanceIndex)||[]:[]));
 const lids=new Set(checks.flatMap(f=>f.lidBodyIndices));
 const fixed=plan.bodies.flatMap((b,i)=>parts[b.partIndex]?.placement==='mounted'&&!pending.has(i)&&!lids.has(i)?[i]:[]);
 const sameDirection=(a,b)=>dims.every(k=>Math.abs(a[k]/Math.hypot(...a)-b[k]/Math.hypot(...b))<eps);
 try{
  if(checks.length){if(options.local===false)throw Error('本环境未执行本地实体检查');lib=await cadReviewKernel();}
  const get=i=>{if(!cache.has(i)){const body=plan.bodies[i],s=buildCadSolid(lib,body);try{cache.set(i,s.translate(body.positionMm));}finally{s.delete();}}return cache.get(i);};
  const sweeps=(indices,travel,obstacles)=>{for(const i of indices){const s=get(i),start=s.translate(travel);try{const swept=lib.Manifold.hull([s,start]);try{for(const o of obstacles)if(o!==i&&contacts(swept,get(o)))return o;}finally{swept.delete();}}finally{start.delete();}}return -1;};
  for(const f of checks){options.signal?.throwIfAborted();const part=parts[f.partIndex],key=`${f.partIndex}:${f.instanceIndex}`,ids=part&&occurrenceGroups(plan,part,f.partIndex).groups.get(f.instanceIndex)||[],h=f.housingBodyIndices,l=f.lidBodyIndices,delta=f.insertionOffsetMm;
   const open=f.mountType==='open-mount',problems=[],row={mountType:open?'open-mount':'closed-housing',partIndex:f.partIndex,instanceIndex:f.instanceIndex,bodyIndices:ids,issues:problems,dimensions:part?.dimensionSource||'unknown'};rows.push(row);
   if(!part||part.placement!=='mounted'||!ids.length||!h.length||[...h,...l].some(i=>ids.includes(i)||(open?parts[plan.bodies[i]?.partIndex]?.placement!=='mounted':!closed.includes(i)))){problems.push('未找到有效的安装件、壳或可拆盖。');continue;}
   const shell=[...h,...l].map(get),bd=bounds(ids.map(get)),outer=bounds(shell),center=dims.map(k=>(bd.max[k]+bd.min[k])/2);
   const supports=h.map(get),surfaceTolerance=.5; // mm, nominal seating; not retention strength
   if(open){
    row.seated=ids.some(j=>supports.some(s=>get(j).minGap(s,surfaceTolerance+1)<=surfaceTolerance));
    if(!row.seated)problems.push('开放安装件未接触声明的支撑面（间隙超过 0.5 mm）。');
   }else if(!covers(outer,bd))problems.push('部件在壳体边界外。');
   const wallHits=open?[]:dims.flatMap(k=>[-1,1].map(sign=>{const end=[...center];end[k]=sign>0?outer.max[k]+1:outer.min[k]-1;return shell.some(s=>s.rayCast(center,end).length>0);}));
   if(!open&&wallHits.filter(Boolean).length<5)problems.push('在目标位置未找到包围部件的实际腔壁。');
   const others=plan.bodies.flatMap((b,i)=>parts[b.partIndex]?.placement==='mounted'&&!ids.includes(i)?[i]:[]);
   const clash=others.find(i=>ids.some(j=>contacts(get(i),get(j))));if(clash!==undefined)problems.push('最终位置与实体 #'+clash+' 相交。');
   if(open){
    const free=ids.every(i=>{const start=get(i).translate(delta);try{return supports.every(s=>start.minGap(s,surfaceTolerance+1)>surfaceTolerance);}finally{start.delete();}});
    if(!free)problems.push('开放安装路径的起点未脱离支撑。');
   }else if(intersectBox(outer,{min:bd.min.map((v,k)=>v+delta[k]),max:bd.max.map((v,k)=>v+delta[k])}))problems.push('声明的装入起点仍在壳体内。');
   const pinKey=v=>String(v||'').trim().toLowerCase(),links=design.interaction?.connections||[];
   const externalPins=new Set();for(const w of links)for(const [a,pin,b] of [[w.fromPartIndex,w.fromPin,w.toPartIndex],[w.toPartIndex,w.toPin,w.fromPartIndex]])if(a===f.partIndex&&parts[b]?.placement==='loose')externalPins.add(pinKey(pin));
   for(const p of f.portAccess||[]){
    if(!ids.includes(p.bodyIndex)){problems.push('外接插头引用了另一个安装实例。');continue;}
    const socket=get(p.bodyIndex).boundingBox(),raw=lib.Manifold.cube(p.plugSizeMm,true),plug=raw.translate(p.centerMm);raw.delete();
    try{const plugBox=plug.boundingBox(),pad={min:socket.min.map(v=>v-2),max:socket.max.map(v=>v+2)};
     if(!intersectBox(plugBox,pad))problems.push('插头终点未到达声明的接口实体。');
     for(const pin of p.pins){const key=pinKey(pin),terminal=design.interaction?.terminals?.find(t=>t.partIndex===f.partIndex&&pinKey(t.pin)===key);externalPins.delete(key);
      if(terminal&&Array.isArray(terminal.positionMm)&&plan.bodies[terminal.bodyIndex]){const absolute=terminal.positionMm.map((v,k)=>v+plan.bodies[terminal.bodyIndex].positionMm[k]);if(dims.some(k=>absolute[k]<plugBox.min[k]-2||absolute[k]>plugBox.max[k]+2))problems.push('插头终点未对准接线点 '+pin+'。');}}
     const start=plug.translate(p.approachMm);try{if(open?start.minGap(get(p.bodyIndex),2)<=1:intersectBox(start.boundingBox(),outer))problems.push('插头路径起点未离开外壳。');const hull=lib.Manifold.hull([start,plug]);try{const hit=others.find(i=>contacts(hull,get(i)))??ids.find(i=>i!==p.bodyIndex&&contacts(hull,get(i)));if(hit!==undefined)problems.push('关闭盖板后外接插头路径受实体 #'+hit+' 阻挡。');}finally{hull.delete();}}finally{start.delete();}
    }finally{plug.delete();}
   }
   if(externalPins.size)problems.push('以下外接引脚未验证合盖后的插头通道：'+[...externalPins].join('、'));
   const blockers=new Set([...h,...fixed,...inserted]);const blocking=sweeps(ids,delta,blockers);if(blocking!==-1)problems.push('连续装入路径受实体 #'+blocking+' 阻挡。');
   for(const i of ids)inserted.add(i);
   for(const i of l){const offset=f.lidOffsetMm||delta,prev=closures.get(i);if(prev&&!sameDirection(prev.delta,offset))problems.push('同一盖板有冲突的合盖方向。');else if(!prev||Math.hypot(...offset)>Math.hypot(...prev.delta))closures.set(i,{delta:offset,row,housing:h});}
   if(!open)row.wallDirections=wallHits.filter(Boolean).length;row.key=key;
  }
  const installedLids=new Set();for(const [lid,{delta,row,housing}] of closures){const box=get(lid).boundingBox(),shell=bounds(housing.map(get));
   if(intersectBox(shell,{min:box.min.map((v,k)=>v+delta[k]),max:box.max.map((v,k)=>v+delta[k])}))row.issues.push('盖板起点未离开壳体。');
   const obstacles=new Set([...fixed,...inserted,...installedLids]),hit=sweeps([lid],delta,obstacles);if(hit!==-1)row.issues.push(`合盖路径受实体 #${hit} 阻挡。`);installedLids.add(lid);}
 }catch(e){if(options.signal?.aborted)throw e;issues.push('装入检查未能执行：'+e.message);}finally{for(const s of cache.values())s.delete();}
 for(const r of rows)for(const issue of r.issues)issues.push(`装入检查：${parts[r.partIndex]?.name||r.partIndex} #${r.instanceIndex+1}：${issue}`);
 return {status:issues.length?'repair':'nominal-pass',rows,issues,scope};
}
