import {validateCadPlan,wholePartBox} from '../cad-plan.js';
import {jointFrameConflicts,jointPoint} from '../assembly-joints.js';

const maxComparisons=30000;
// The shared CSG compiler represents a full cylindrical circumference with 48 facets.
const facetSagittaRatio=1-Math.cos(Math.PI/48);
let kernel;
export async function cadReviewKernel(){
  const {initializeCadKernel}=await import('../cad-plan-compiler.js');
  kernel??=initializeCadKernel().catch(error=>{kernel=undefined;throw error;});
  return kernel;
}

function mechanisms(design){
  const controls=(design.interaction?.controls||[]).filter(c=>['turn','press','slide'].includes(c.kind)).map(c=>({
    label:c.label,kind:c.kind,axis:c.axis,pivot:c.pivotMm,step:c.step,moving:c.movingBodyIndices,fixed:[c.fixedBodyIndex],...(c.range?{range:[c.range.min,c.range.max]}:{})
  }));
  for(const m of design.cadPlan.motions||[]){
    const fixed=design.cadPlan.bodies.flatMap((b,i)=>[m.actuatorPartIndex,m.guidePartIndex].includes(b.partIndex)&&!m.movingBodyIndices.includes(i)?[i]:[]);
    controls.push({label:m.name,kind:'slide',axis:m.axis,step:m.travelMm,moving:m.movingBodyIndices,fixed});
  }
  for(const j of design.cadPlan.joints||[])controls.push({label:j.name,kind:'turn',axis:j.axis,pivot:j.pivotMm,
    step:Math.max(Math.abs(j.minDegrees),Math.abs(j.maxDegrees)),moving:j.movingBodyIndices,fixed:[j.fixedBodyIndex],range:[j.minDegrees,j.maxDegrees]});
  return controls;
}

function rotation(axis,pivot,degrees){
  const [x,y,z]=axis,t=degrees*Math.PI/180,c=Math.cos(t),s=Math.sin(t),v=1-c;
  const colX=[c+x*x*v,y*x*v+z*s,z*x*v-y*s];
  const colY=[x*y*v-z*s,c+y*y*v,z*y*v+x*s];
  const colZ=[x*z*v+y*s,y*z*v-x*s,c+z*z*v];
  const pos=pivot.map((p,i)=>p-colX[i]*pivot[0]-colY[i]*pivot[1]-colZ[i]*pivot[2]);
  return [...colX,0,...colY,0,...colZ,0,...pos,1];
}

function sampledSteps(kind,step,range){
  if(kind==='turn'&&range){
    const [min,max]=range;
    const bothDirections=min<0&&max>0;
    const spans=bothDirections?[[min,0],[0,max]]:[[min,max]];
    const angles=new Set();
    for(const [start,end] of spans){
      const count=Math.max(4,Math.min(12,Math.ceil((end-start)/6)));
      angles.add(start);
      for(let i=1;i<count;i++)angles.add(start+(end-start)*i/count);
      angles.add(end);
    }
    return [...angles];
  }
  const n=kind==='turn'?Math.max(4,Math.min(12,Math.ceil(Math.abs(step)/6))):8;
  const values=[0];
  for(let i=1;i<=n;i++){
    values.push(step*i/n);
    if(kind==='turn')values.push(-step*i/n);
  }
  return values;
}

function boxesOverlap(a,b){return a.min.every((v,i)=>v<b.max[i]&&b.min[i]<a.max[i]);}
function envelope(body,part){
  return Boolean(wholePartBox(body)||part?.geometryReference?.kind==='envelope-approximation'||
    /keep[- ]?out|clearance volume|避让体|预留空间|软垫|泡棉|flexure|foam pad|压缩垫/i.test(body.name));
}
function curvedRadius(body){
  return Math.max(0,...body.features.filter(f=>f.shape==='cylinder'||f.shape==='ellipsoid').map(f=>Math.max(f.sizeMm[0],f.sizeMm[1])/2));
}
const fmt=value=>Number(value.toFixed(3)).toString();

function combinedPoses(joints){
  const poses=[joints.map(()=>0)];
  for(let pattern=0;pattern<4;pattern++){
    const end=joints.map((j,i)=>((pattern<2?pattern:(i+pattern)%2)?j.maxDegrees:j.minDegrees));
    for(const fraction of [.25,.5,.75,1])poses.push(end.map(v=>v*fraction));
  }
  return [...new Map(poses.map(p=>[JSON.stringify(p),p])).values()];
}

// Recover an affine transform from the viewer's own forward kinematics. This
// keeps child pivots and axes in the same serial frame used by the UI.
function jointTransform(bodyIndex,joints,values){
  const origin=jointPoint([0,0,0],bodyIndex,joints,values);
  const basis=[[1,0,0],[0,1,0],[0,0,1]].map(p=>jointPoint(p,bodyIndex,joints,values).map((n,k)=>n-origin[k]));
  return [...basis[0],0,...basis[1],0,...basis[2],0,...origin,1];
}

function intersectionInfo(placed,obstacle,a,b,rotated){
  const intersection=placed.intersect(obstacle);let volume,thinFacets=false;
  try{
    volume=intersection.volume();
    if(rotated&&volume>0.05){
      const radius=Math.min(curvedRadius(a),curvedRadius(b));
      if(radius>0)thinFacets=2*volume/intersection.surfaceArea()<=radius*facetSagittaRatio;
    }
  }finally{intersection.delete();}
  if(!Number.isFinite(volume))throw Error('布尔相交未返回有限体积。');
  return {volume,thinFacets};
}

export async function reviewInteractionGeometry(design,{signal,local=true}={}){
  const checks=[],issues=[];
  const result=status=>({status,checks,issues});
  if(!design?.cadPlan?.bodies?.length)return result('not-applicable');
  const bodies=design.cadPlan.bodies,solids=new Map();
  let comparisons=0;
  try{
    signal?.throwIfAborted();
    validateCadPlan(design.cadPlan,design.parts.length);
    const frameIssues=jointFrameConflicts(design.cadPlan.joints);
    if(frameIssues.length){
      issues.push(...frameIssues);
      checks.push('关节固定关系存在冲突，未执行几何运动采样。');
      return result('unavailable');
    }
    const rigs=mechanisms(design);
    if(!rigs.length){checks.push('无已声明的实体行程或转轴。');return result('not-applicable');}
    if(!local){checks.push('此运行环境未配置服务端几何内核。');return result('unavailable');}
    const {buildCadSolid}=await import('../cad-plan-compiler.js');
    const lib=await cadReviewKernel();
    function solid(index){
      if(!solids.has(index)){
        const body=bodies[index];
        let shape;
        try{shape=buildCadSolid(lib,body);}
        catch(error){
          issues.push(`「${body.name}」(#${index}) 无法重建为可检测的 CAD 实体：${error.message}`);
          throw error;
        }
        try{solids.set(index,shape.translate(body.positionMm));}finally{shape.delete();}
      }
      return solids.get(index);
    }
    let lastYield=performance.now();
    const joints=design.cadPlan.joints||[];
    const deadline=lastYield+600000;
    async function yieldIfNeeded(){
      if(performance.now()-lastYield<=20)return;
      await new Promise(resolve=>setTimeout(resolve,0));
      signal?.throwIfAborted();lastYield=performance.now();
      if(lastYield>deadline)throw Error('超过单次几何检测时限，余下姿态未测。');
    }
    for(const rig of rigs){
      // Reserve an independent narrow-phase budget for each axis. Earlier
      // joints must not consume the later wrist joints' entire allowance.
      comparisons=0;
      signal?.throwIfAborted();
      const {moving,fixed,step,axis,kind,label}=rig;
      if(!Array.isArray(moving)||!moving.length||!fixed.length||!Number.isFinite(step)||(kind==='turn'?step===0:step<=0)||
         !Array.isArray(axis)||axis.length!==3||!axis.every(Number.isFinite)||Math.abs(Math.hypot(...axis)-1)>.006||
         (kind==='turn'&&(!Array.isArray(rig.pivot)||rig.pivot.length!==3||!rig.pivot.every(Number.isFinite)))||
         ![...moving,...fixed].every(i=>Number.isInteger(i)&&bodies[i])||fixed.some(i=>moving.includes(i))){
        checks.push(`${label}的动件、定件或轴线映射不完整。`);return result('unavailable');
      }
      const unit=axis.map(v=>v/Math.hypot(...axis));
      const obstacles=[...new Set([...fixed,...bodies.flatMap((b,i)=>b.role==='printed'&&!moving.includes(i)?[i]:[])])];
      const uncertain=new Set(),faceted=new Set(),overlaps=new Map(),poses=sampledSteps(kind,step,rig.range),unitLabel=kind==='turn'?'°':' mm';
      function compare(i,placed,j,value){
        if(i===j)return;
        const obstacle=solid(j);
        if(!boxesOverlap(placed.boundingBox(),obstacle.boundingBox()))return;
        // Disjoint broad-phase pairs are cheap and do not consume the budget
        // reserved for exact solid intersections in larger serial assemblies.
        if(++comparisons>maxComparisons)throw Error('已达到单次实体相交预算；余下姿态未测。');
        const {volume,thinFacets}=intersectionInfo(placed,obstacle,bodies[i],bodies[j],kind==='turn'&&value!==0);
        if(volume<=0.05)return; // Ignore face contact and numerical slivers (mm³).
        const key=i+':'+j;
        if(envelope(bodies[i],design.parts[bodies[i].partIndex])||envelope(bodies[j],design.parts[bodies[j].partIndex])){
          uncertain.add(`${bodies[i].name}／${bodies[j].name}`);return;
        }
        if(thinFacets){faceted.add(`${bodies[i].name}／${bodies[j].name}`);return;}
        const prev=overlaps.get(key);
        if(!prev||volume>prev.volume){
          const row=prev?.row??issues.length;
          overlaps.set(key,{row,volume});
          issues[row]=`${label}在 ${fmt(value)}${unitLabel} 处，「${bodies[i].name}」(#${i}) 与「${bodies[j].name}」(#${j}) 的 CAD 实体重叠 ${fmt(volume)} mm³。请核对移动映射、安装孔及让位，保留承面。`;
        }
      }
      // Check that a control mount can sit in its housing before moving its cap/lever.
      for(const i of fixed)for(const j of obstacles)if(!fixed.includes(j))compare(i,solid(i),j,0);
      for(const value of poses){
        await yieldIfNeeded();
        for(const i of moving){
          const initial=solid(i),positioned=value===0?initial:kind==='turn'?
            initial.transform(rotation(unit,rig.pivot,value)):initial.translate(unit.map(v=>v*value));
          try{for(const j of obstacles)compare(i,positioned,j,value);}finally{if(positioned!==initial)positioned.delete();}
        }
      }
      checks.push(`${label}：${moving.length} 个动件对 ${obstacles.length} 个固定件；${poses.length} 个姿态，${rig.range?rig.range.map(fmt).join(' 至 '):kind==='turn'?'±'+fmt(Math.abs(step)):fmt(step)}${unitLabel}。`);
      if(faceted.size)checks.push(`曲面旋转时检测到接近表面离散误差的薄层交叠，需复核径向公差：${[...faceted].slice(0,3).join('、')}。`);
      if(uncertain.size)checks.push(`尺寸包络或可压缩件有重叠，需核对实际轮廓或材料：${[...uncertain].slice(0,3).join('、')}。`);
    }
    const slides=(design.cadPlan.motions||[]).filter(m=>m.parentJointIndex!=null);
    if(joints.length>1||(joints.length&&slides.length)){
      const groups=bodies.map((_,i)=>[...joints,...slides].flatMap((j,k)=>j.movingBodyIndices.includes(i)?[k]:[]).join(','));
      const fixed=new Set(joints.map(j=>j.fixedBodyIndex));
      const pairs=[];
      for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
        if(groups[i]!==groups[j]&&(bodies[i].role==='printed'||bodies[j].role==='printed'||fixed.has(i)||fixed.has(j)))pairs.push([i,j]);
      }
      const poses=combinedPoses(joints),overlaps=new Map(),uncertain=new Set(),faceted=new Set();
      const settings=[...new Map([slides.map(()=>0),...slides.flatMap((_,n)=>[.5,1].map(f=>slides.map((__,k)=>k===n?f:0))),slides.map(()=>1)].map(v=>[v.join(','),v])).values()];
      for(const values of poses)for(const opening of settings){
        signal?.throwIfAborted();comparisons=0;
        const placed=new Map(),boxes=new Map();
        const at=i=>{
          if(!placed.has(i)){
            const d=[0,0,0];slides.forEach((m,k)=>{if(m.movingBodyIndices.includes(i))m.axis.forEach((v,q)=>{d[q]+=v*m.travelMm*opening[k];});});
            const base=solid(i),shift=d.some(Boolean)?base.translate(d):base;
            try{placed.set(i,groups[i]?shift.transform(jointTransform(i,joints,values)):base);}finally{if(shift!==base)shift.delete();}
            boxes.set(i,placed.get(i).boundingBox());
          }
          return placed.get(i);
        };
        try{
          for(const [i,j]of pairs){
            await yieldIfNeeded();
            const a=at(i),b=at(j);
            if(!boxesOverlap(boxes.get(i),boxes.get(j)))continue;
            if(++comparisons>maxComparisons)throw Error('联动姿态达到实体相交预算；余下组合未测。');
            const relative=joints.some((joint,k)=>values[k]!==0&&joint.movingBodyIndices.includes(i)!==joint.movingBodyIndices.includes(j))||slides.some((slide,k)=>opening[k]!==0&&slide.movingBodyIndices.includes(i)!==slide.movingBodyIndices.includes(j));
            const {volume,thinFacets}=intersectionInfo(a,b,bodies[i],bodies[j],relative);
            if(volume<=0.05)continue;
            const label=`${bodies[i].name}／${bodies[j].name}`;
            if(envelope(bodies[i],design.parts[bodies[i].partIndex])||envelope(bodies[j],design.parts[bodies[j].partIndex])){uncertain.add(label);continue;}
            if(thinFacets){faceted.add(label);continue;}
            const key=i+':'+j,previous=overlaps.get(key);
            if(!previous||volume>previous.volume){
              const row=previous?.row??issues.length;overlaps.set(key,{row,volume});
              issues[row]=`联动姿态 [${values.map((v,k)=>`J${k+1}=${fmt(v)}°`).join(', ')}${slides.length?'；滑动 '+opening.map(v=>fmt(v*100)+'%').join(', '):''}] 时，「${bodies[i].name}」(#${i}) 与「${bodies[j].name}」(#${j}) 的 CAD 实体重叠 ${fmt(volume)} mm³。请按串联运动修正让位与安装，不可只检查单轴零位。`;
            }
          }
        }finally{for(const [i,s]of placed)if(s!==solids.get(i))s.delete();}
      }
      checks.push(`联动检查：${joints.length} 个关节按查看器串联变换，采样 ${poses.length*settings.length} 个同向/交错端点及中间组合；检查不同运动组之间的结构实体。未穷举全角度空间，也未模拟连续轨迹或动力学。`);
      if(faceted.size)checks.push(`联动曲面离散薄层交叠需复核公差：${[...faceted].slice(0,3).join('、')}。`);
      if(uncertain.size)checks.push(`联动中尺寸包络或可压缩件重叠，需核对实际轮廓或材料：${[...uncertain].slice(0,3).join('、')}。`);
    }
    checks.push('Manifold 3.5.1 按毫米重建声明的 CAD，在离散姿态检测正体积交叠；刚好接触不算干涉。未测实物摩擦、夹力或弹簧回弹。');
    return result('checked');
  }catch(error){
    if(signal?.aborted)throw error;
    checks.push(`几何检测未完成：${error.message}`);return result('unavailable');
  }finally{for(const s of solids.values())s.delete();}
}
