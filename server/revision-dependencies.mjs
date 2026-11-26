import {featurePlacement,validateCadPlan} from '../cad-plan.js';
import {cadReviewKernel} from './interaction-geometry-review.mjs';

// A body index is local to one revision; a BOM row and body name may also be
// ambiguous. Never compare a solid against a guessed identity after reordering.
function bodyIdentities(design){
  const keys=design.cadPlan.bodies.map(body=>{
    const part=design.parts[body.partIndex];
    return JSON.stringify([part.name,part.model,body.name]);
  });
  const indices=new Map();
  keys.forEach((key,i)=>indices.set(key,indices.has(key)?null:i));
  return {keys,indices};
}

function bodyGeometry({positionMm,features,sourceMeshes,role}){
  return JSON.stringify([positionMm,features,sourceMeshes,role]);
}

// An additive primitive's rotated box is a conservative bound. Holes and
// rounded corners are examined using the actual CSG before reporting a change.
function extent(body){
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const f of body.features){
    if(f.op!=='add')continue;
    const rotate=featurePlacement({...f,centerMm:[0,0,0]});
    const basis=[[1,0,0],[0,1,0],[0,0,1]].map(rotate);
    for(let k=0;k<3;k++){
      const half=basis.reduce((v,axis,i)=>v+Math.abs(axis[k])*f.sizeMm[i]/2,0);
      const center=body.positionMm[k]+f.centerMm[k];
      min[k]=Math.min(min[k],center-half);max[k]=Math.max(max[k],center+half);
    }
  }
  return {min,max};
}
const touching=(a,b)=>a.min.every((v,i)=>v<=b.max[i]+1e-6&&b.min[i]<=a.max[i]+1e-6);
const membership=(index,rigs)=>rigs.flatMap((rig,k)=>rig.movingBodyIndices?.includes(index)?[k]:[]).join(',');
const pairLimit=64;
function affectedRig(bodies,parts){
  return rig=>bodies.has(rig.fixedBodyIndex)||rig.movingBodyIndices?.some(i=>bodies.has(i))||
    [rig.actuatorPartIndex,rig.guidePartIndex,rig.controllerPartIndex,rig.partIndex].some(i=>parts.has(i));
}

export async function revisedMechanicalDependencies(before,after,{local=true,signal,reconstructedParts=[]}={}){
  if(!before?.cadPlan?.bodies||!after?.cadPlan?.bodies)return null;
  try{validateCadPlan(before.cadPlan,before.parts.length);}
  catch{return {status:'unavailable',reason:'基线 CAD 未通过结构校验，无法比较修订前的几何。'};}
  const old=before.cadPlan.bodies,current=after.cadPlan.bodies;
  const prev=bodyIdentities(before),next=bodyIdentities(after);
  const match=next.keys.map(key=>Number.isInteger(next.indices.get(key))?prev.indices.get(key):null);
  const changed=new Set(current.flatMap((body,i)=>Number.isInteger(match[i])&&bodyGeometry(body)===bodyGeometry(old[match[i]])?[]:[i]));
  const partIndices=new Set([...changed].map(i=>current[i].partIndex));
  const depends=affectedRig(changed,partIndices);
  const {joints=[],motions=[]}=after.cadPlan;
  const controls=Array.isArray(after.interaction?.controls)?after.interaction.controls.filter(c=>c&&Array.isArray(c.movingBodyIndices)):[];
  const previousIndices=new Set(match.filter(Number.isInteger));
  const unmatchedPrevious=old.flatMap((_,i)=>previousIndices.has(i)?[]:[i]);
  const removed=new Set(unmatchedPrevious);
  const formerParts=new Set(unmatchedPrevious.map(i=>old[i].partIndex));
  const usedRemoved=affectedRig(removed,formerParts);
  const result={status:'checked',changedBodyIndices:[...changed],unmatchedCurrent:[...changed].filter(i=>!Number.isInteger(match[i])),
    unmatchedPrevious,priorDependentJoints:(before.cadPlan.joints||[]).filter(usedRemoved).map(j=>j.name),
    priorDependentMotions:(before.cadPlan.motions||[]).filter(usedRemoved).map(m=>m.name),
    jointIndices:joints.flatMap((j,i)=>depends(j)?[i]:[]),motionIndices:motions.flatMap((m,i)=>depends(m)?[i]:[]),
    controlIds:controls.filter(depends).map(c=>c.id),
    datumBodyIndices:reconstructedParts.filter(p=>changed.has(p.bodyIndex)&&p.datums?.length).map(p=>p.bodyIndex),
    neighbors:{pairs:[],total:0},staticChecks:{tested:0,eligible:0,newIntersections:[]},
    scope:'邻件按前后两版零位包络接触选择（列前 32 对及总数）。零位实体相交比较限于可对应身份、不同 BOM 行、同运动组的打印件，每轮至多 64 对。基准与关节引用可供评审；孔、螺钉和配合面没有成对约束，未自动验证紧固、承载或实物配合。'};
  if(!changed.size)return result;
  const oldBounds=old.map(extent),bounds=current.map(extent);
  const rigs=[...joints,...motions,...controls],groups=current.map((_,i)=>membership(i,rigs));
  const solids=new Map();
  let lib,buildCadSolid;
  function placed(body){
    if(!solids.has(body)){
      const built=buildCadSolid(lib,body);
      try{solids.set(body,built.translate(body.positionMm));}finally{built.delete();}
    }
    return solids.get(body);
  }
  function volume(a,b){
    const intersection=placed(a).intersect(placed(b));
    try{
      const value=intersection.volume();
      if(!Number.isFinite(value))throw Error('布尔相交未返回有限体积。');
      return value;
    }finally{intersection.delete();}
  }
  try{
    for(let i=0;i<current.length;i++)for(let j=i+1;j<current.length;j++){
      if(!changed.has(i)&&!changed.has(j))continue;
      signal?.throwIfAborted();
      const known=Number.isInteger(match[i])&&Number.isInteger(match[j]);
      const wasNear=known&&touching(oldBounds[match[i]],oldBounds[match[j]]);
      const nowNear=touching(bounds[i],bounds[j]);
      if(!nowNear&&!wasNear)continue;
      const {neighbors,staticChecks}=result;
      neighbors.total++;
      if(neighbors.pairs.length<32)neighbors.pairs.push({bodies:[i,j],before:known?wasNear:null,after:nowNear});
      if(!known||!nowNear||groups[i]!==groups[j]||current[i].partIndex===current[j].partIndex||
         [current[i],current[j],old[match[i]],old[match[j]]].some(b=>b.role!=='printed'))continue;
      staticChecks.eligible++;
      if(!local||staticChecks.tested>=pairLimit)continue;
      if(!lib){lib=await cadReviewKernel();({buildCadSolid}=await import('../cad-plan-compiler.js'));}
      const nextVolume=volume(current[i],current[j]);
      if(nextVolume>.05){
        const previousVolume=wasNear?volume(old[match[i]],old[match[j]]):0;
        if(previousVolume<=.05)staticChecks.newIntersections.push({bodies:[i,j],beforeMm3:previousVolume,afterMm3:nextVolume});
      }
      staticChecks.tested++;
    }
    if(result.staticChecks.tested<result.staticChecks.eligible)result.status='partial';
  }catch(error){
    if(signal?.aborted)throw error;
    result.status='partial';result.reason=error.message;
  }finally{for(const solid of solids.values())solid.delete();}
  return result;
}
