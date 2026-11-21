import {validateCadPlan,wholePartBox} from '../cad-plan.js';

const maxComparisons=1400;
// The shared CSG compiler represents a full cylindrical circumference with 48 facets.
const facetSagittaRatio=1-Math.cos(Math.PI/48);
let kernel;

function mechanisms(design){
  const controls=(design.interaction?.controls||[]).filter(c=>['turn','press','slide'].includes(c.kind)).map(c=>({
    label:c.label,kind:c.kind,axis:c.axis,pivot:c.pivotMm,step:c.step,moving:c.movingBodyIndices,fixed:[c.fixedBodyIndex]
  }));
  for(const m of design.cadPlan.motions||[]){
    const fixed=design.cadPlan.bodies.flatMap((b,i)=>[m.actuatorPartIndex,m.guidePartIndex].includes(b.partIndex)&&!m.movingBodyIndices.includes(i)?[i]:[]);
    controls.push({label:m.name,kind:'slide',axis:m.axis,step:m.travelMm,moving:m.movingBodyIndices,fixed});
  }
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

function sampledSteps(kind,step){
  const n=kind==='turn'?Math.max(4,Math.min(12,Math.ceil(step/6))):8;
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

export async function reviewInteractionGeometry(design,{signal,local=true}={}){
  const checks=[],issues=[];
  const result=status=>({status,checks,issues});
  if(!design?.cadPlan?.bodies?.length)return result('not-applicable');
  const bodies=design.cadPlan.bodies,solids=new Map();
  let comparisons=0;
  try{
    signal?.throwIfAborted();
    validateCadPlan(design.cadPlan,design.parts.length);
    const rigs=mechanisms(design);
    if(!rigs.length){checks.push('无已声明的实体行程或转轴。');return result('not-applicable');}
    if(!local){checks.push('此运行环境未配置服务端几何内核。');return result('unavailable');}
    const {initializeCadKernel,buildCadSolid}=await import('../cad-plan-compiler.js');
    kernel??=initializeCadKernel().catch(error=>{kernel=undefined;throw error;});
    const lib=await kernel;
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
    const deadline=lastYield+5000;
    for(const rig of rigs){
      signal?.throwIfAborted();
      const {moving,fixed,step,axis,kind,label}=rig;
      if(!Array.isArray(moving)||!moving.length||!fixed.length||!Number.isFinite(step)||step<=0||
         !Array.isArray(axis)||axis.length!==3||!axis.every(Number.isFinite)||Math.abs(Math.hypot(...axis)-1)>.006||
         (kind==='turn'&&(!Array.isArray(rig.pivot)||rig.pivot.length!==3||!rig.pivot.every(Number.isFinite)))||
         ![...moving,...fixed].every(i=>Number.isInteger(i)&&bodies[i])||fixed.some(i=>moving.includes(i))){
        checks.push(`${label}的动件、定件或轴线映射不完整。`);return result('unavailable');
      }
      const unit=axis.map(v=>v/Math.hypot(...axis));
      const obstacles=[...new Set([...fixed,...bodies.flatMap((b,i)=>b.role==='printed'&&!moving.includes(i)?[i]:[])])];
      const uncertain=new Set(),faceted=new Set(),overlaps=new Map(),poses=sampledSteps(kind,step),unitLabel=kind==='turn'?'°':' mm';
      function compare(i,placed,j,value){
        if(i===j)return;
        if(++comparisons>maxComparisons)throw Error('已达到单次姿态配对预算；余下姿态未测。');
        const obstacle=solid(j);
        if(!boxesOverlap(placed.boundingBox(),obstacle.boundingBox()))return;
        const intersection=placed.intersect(obstacle);let volume,thinFacets=false;
        try{
          volume=intersection.volume();
          // A faceted shaft inside a same-radius hole produces angular slivers even
          // though the analytic circles meet only on their surfaces. Such thin curved
          // overlaps need better tolerances or vendor geometry to be conclusive.
          if(kind==='turn'&&value!==0&&volume>0.05){
            const radius=Math.min(curvedRadius(bodies[i]),curvedRadius(bodies[j]));
            if(radius>0)thinFacets=2*volume/intersection.surfaceArea()<=radius*facetSagittaRatio;
          }
        }finally{intersection.delete();}
        if(!Number.isFinite(volume))throw Error('布尔相交未返回有限体积。');
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
        if(performance.now()-lastYield>20){
          await new Promise(resolve=>setTimeout(resolve,0));
          signal?.throwIfAborted();lastYield=performance.now();
          if(lastYield>deadline)throw Error('超过单次几何检测时限，余下姿态未测。');
        }
        for(const i of moving){
          const initial=solid(i),positioned=value===0?initial:kind==='turn'?
            initial.transform(rotation(unit,rig.pivot,value)):initial.translate(unit.map(v=>v*value));
          try{for(const j of obstacles)compare(i,positioned,j,value);}finally{if(positioned!==initial)positioned.delete();}
        }
      }
      checks.push(`${label}：${moving.length} 个动件对 ${obstacles.length} 个固定件；${poses.length} 个姿态，${kind==='turn'?'±':''}${fmt(step)}${unitLabel}。`);
      if(faceted.size)checks.push(`曲面旋转时检测到接近表面离散误差的薄层交叠，需复核径向公差：${[...faceted].slice(0,3).join('、')}。`);
      if(uncertain.size)checks.push(`尺寸包络或可压缩件有重叠，需核对实际轮廓或材料：${[...uncertain].slice(0,3).join('、')}。`);
    }
    checks.push('Manifold 3.5.1 按毫米重建声明的 CAD，在离散姿态检测正体积交叠；刚好接触不算干涉。未测实物摩擦、夹力或弹簧回弹。');
    return result('checked');
  }catch(error){
    if(signal?.aborted)throw error;
    checks.push(`几何检测未完成：${error.message}`);return result('unavailable');
  }finally{for(const s of solids.values())s.delete();}
}
