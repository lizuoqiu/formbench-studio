// Executed inside Playwright. Capture actual raster inputs in world millimetres.
// The same [mesh, vertex] references selected at home are sampled after each
// action so even a symmetric cylinder can provide identifiable off-axis vertices.
export function sampleDrawnVertices({references,mode}) {
  const drawing = window.draftDrawing;
  if (!drawing) return null;
  if (drawing.mode!==mode) return {vertices:{},angles:null};
  const meshes = new Map();
  for (const item of [...drawing.scene, ...drawing.backdrop]) {
    const match = /^body-(\d+)-/.exec(item.id);
    if (!match) continue;
    const id = Number(match[1]);
    if (!meshes.has(id)) meshes.set(id, []);
    meshes.get(id).push(item);
  }
  const result = {};
  for (const [id, items] of meshes) {
    if (references && !references[id]) continue;
    let refs = references?.[id];
    if (!refs) {
      const extrema = [null,null,null,null,null,null];
      items.forEach(({mesh,offset}, m) => mesh.points.forEach((p, v) => {
        for (let k=0; k<3; k++) {
          const n = p[k] + offset[k], lo = k*2, hi = lo+1;
          if (!extrema[lo] || n<extrema[lo].value) extrema[lo]={value:n,m,v};
          if (!extrema[hi] || n>extrema[hi].value) extrema[hi]={value:n,m,v};
        }
      }));
      refs = [];
      for (const e of extrema) {
        if (e && !refs.some(([m,v])=>m===e.m && v===e.v)) refs.push([e.m,e.v]);
      }
    }
    const points = refs.map(([m,v]) => {
      const item = items[m], point = item?.mesh.points[v];
      return point ? point.map((n,k)=>n+item.offset[k]) : null;
    });
    if (points.length && points.every(p=>p?.every(Number.isFinite))) result[id] = {refs,points};
  }
  return {vertices:result,angles:drawing.angles};
}

const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const cross = ([a,b,c],[x,y,z]) => [b*z-c*y,c*x-a*z,a*y-b*x];
const TOLERANCE_MM = 0.001;

// Independent of the viewer's matrix implementation. Source axes and pivots
// are in the assembly home frame. Parent transforms carry every child frame.
function rotate(p,joint,degrees) {
  const r = p.map((v,k)=>v-joint.pivotMm[k]);
  const half = degrees*Math.PI/360;
  const scale = Math.sin(half)/Math.hypot(...joint.axis);
  const v = joint.axis.map(n=>n*scale);
  const vr = cross(v,r), vvr = cross(v,vr);
  return p.map((x,k)=>x+2*(Math.cos(half)*vr[k]+vvr[k]));
}

function expectedGroups(joints){
  const groups=joints.map(j=>new Set(j.movingBodyIndices));
  for(let i=joints.length-1;i>=0;i--){
    const p=joints[i].parentIndex;
    if(!Number.isInteger(p)||p<0||p>=i)continue;
    groups[p].add(joints[i].fixedBodyIndex);
    for(const b of groups[i])groups[p].add(b);
  }
  return groups;
}

const rounded = n=>Number(n.toFixed(5));
export function inspectDrawnJoint(joints,index,home,before,after,oldAngles,newAngles) {
  const groups=expectedGroups(joints),joint=joints[index];
  const moving=groups[index];
  const downstream=new Set(),childMounts=[];
  for(let i=index+1;i<joints.length;i++){
    if(joints[i].parentIndex!==index)continue;
    for(const id of groups[i])downstream.add(id);
    childMounts.push(joints[i].fixedBodyIndex);
  }
  const targets=new Set([...Object.keys(home).map(Number),...moving,joint.fixedBodyIndex]);
  function posed(p,id,angles){
    for(let i=joints.length-1;i>=0;i--)if(angles[i] && groups[i].has(id))p=rotate(p,joints[i],angles[i]);
    return p;
  }
  const missing=[],insufficient=[],mismatched=[],moved=[],stationary=[];
  let maxError=0,maxFixedDrift=0,witness=null;
  for(const id of targets){
    const original=home[id],old=before[id],current=after[id];
    if(!original?.length||old?.length!==original.length||current?.length!==original.length){missing.push(id);continue;}
    let expectedMotion=0,error=0,drift=0,probe=null;
    original.forEach((p,i)=>{
      const expectedBefore=posed(p,id,oldAngles),expectedAfter=posed(p,id,newAngles);
      const displacement=distance(expectedBefore,expectedAfter);
      if(displacement>expectedMotion){expectedMotion=displacement;probe={vertex:i,expectedWorldMm:expectedAfter.map(rounded),observedWorldMm:current[i].map(rounded)};}
      error=Math.max(error,distance(current[i],expectedAfter),distance(old[i],expectedBefore));
      drift=Math.max(drift,distance(old[i],current[i]));
    });
    maxError=Math.max(error,maxError);
    if(!moving.has(id))maxFixedDrift=Math.max(drift,maxFixedDrift);
    if(error>TOLERANCE_MM){mismatched.push(id);continue;}
    if(moving.has(id)){
      if(expectedMotion<TOLERANCE_MM*4){insufficient.push(id);continue;}
      moved.push(id);
      if(!witness||expectedMotion>witness.displacementMm)witness={bodyIndex:id,displacementMm:rounded(expectedMotion),...probe};
    }else stationary.push(id);
  }
  const status=mismatched.length?'failed':missing.length||insufficient.length||!moved.length?'not-exercised':'passed';
  return {status,index,fixedBodyIndex:joint.fixedBodyIndex,fixedVerified:stationary.includes(joint.fixedBodyIndex),childMountsCarried:childMounts.filter(id=>moved.includes(id)),
    directMoved:moved.filter(id=>!downstream.has(id)),downstreamMoved:moved.filter(id=>downstream.has(id)),
    maxErrorMm:rounded(maxError),maxStationaryDriftMm:rounded(maxFixedDrift),witness,missing,insufficient,mismatched};
}

export function inspectDrawnHome(initial,returned,observations){
  let maxError=0;
  const mismatched=[],missing=[];
  for(const [id,points] of Object.entries(initial)){
    if(!points.length||returned[id]?.length!==points.length){missing.push(Number(id));continue;}
    const error=Math.max(...points.map((p,i)=>distance(p,returned[id][i])));
    if(error>TOLERANCE_MM)mismatched.push(Number(id));
    maxError=Math.max(maxError,error);
  }
  const exercised=observations.length>0&&observations.every(o=>o.status==='passed');
  const status=mismatched.length?'failed':!exercised||missing.length?'not-exercised':'passed';
  return {status,maxErrorMm:rounded(maxError),observedBodies:Object.keys(initial).length,mismatched,missing};
}

// A linear stroke uses a world-space direction. Compare every sampled vertex
// with its own home vertex, including components that should not move.
export function inspectDrawnTravel(motion, fixedReferences, home, drawn, fraction) {
  const moving=new Set(motion.movingBodyIndices);
  const targets=new Set([...Object.keys(home).map(Number),...moving,...fixedReferences]);
  const vector=motion.axis.map(n=>n*motion.travelMm*fraction);
  const missing=[],mismatched=[],moved=[],fixed=[];
  let maxError=0,maxFixedDrift=0,witness=null;
  for(const id of targets){
    const initial=home[id],current=drawn?.[id];
    if(!initial?.length||current?.length!==initial.length){missing.push(id);continue;}
    const active=moving.has(id),expected=active?vector:[0,0,0];
    let error=0;
    for(let i=0;i<initial.length;i++){
      const delta=current[i].map((n,k)=>n-initial[i][k]);
      error=Math.max(error,distance(delta,expected));
      if(active&&!witness)witness={bodyIndex:id,displacementMm:delta.map(rounded)};
    }
    maxError=Math.max(maxError,error);
    if(!active)maxFixedDrift=Math.max(maxFixedDrift,error);
    if(error>TOLERANCE_MM)mismatched.push(id);
    else if(active)moved.push(id);
    else if(fixedReferences.includes(id))fixed.push(id);
  }
  const resolvable=fraction===0||Math.hypot(...vector)>=TOLERANCE_MM*4;
  const status=mismatched.length?'failed':missing.length||!resolvable||!moved.length||!fixed.length?'not-exercised':'passed';
  return {status,toleranceMm:TOLERANCE_MM,expectedDisplacementMm:vector.map(rounded),maxErrorMm:rounded(maxError),maxFixedDriftMm:rounded(maxFixedDrift),
    trackedMoving:moved,fixedReferences:fixed,witness,missing,mismatched};
}
