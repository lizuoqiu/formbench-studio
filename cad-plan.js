import {matchHardware} from './assembly-hardware.js';
import {matchOled938Reference,resolvePanelHardwareReference} from './panel-hardware-reference.js';
const shapes=['box','ellipsoid','cylinder','roundedPrism','capsule'],ops=['add','cut'],roles=['printed','reference'];
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const isvec=(v,min,max)=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>=min&&n<=max);
// A clearance or a feature of a larger assembly is not an instance of a purchased part.
export function wholePartBox(body){
 if(body.role!=='reference'||body.features.length!==1)return null;
 if(/净空|避让|让位|预留|留空|插拔空间|扫掠|运动空间|keep[ -]?out|clearance|(?:swept|reserved) (?:space|volume|envelope)/i.test(body.name))return null;
 const feature=body.features[0];
 return feature.op==='add'&&feature.shape==='box'?feature:null;
}

// A row containing the housing and the rod of a single actuator is not two
// instances of that actuator. Only full-size anchors of complete copies qualify.
export function completeCatalogAnchors(bodies,parts,metadataForPart=part=>part.metadata){
  const anchors=bodies.map(body=>{
    const simple=wholePartBox(body),part=parts[body.partIndex];
    if(simple||!part||body.role!=='reference'||body.features.length<3)return simple;
    if(matchOled938Reference(part))return resolvePanelHardwareReference(body,part,metadataForPart(part));
    if(!part.modelId||part.modelSourceInvalidated||part.dimensionSource!=='catalog'||part.shape||matchHardware(part)!==part.modelId)return null;
    return registeredCatalogAnchor(body,part,metadataForPart(part));
  }),counts=new Map(),partial=new Set();
  bodies.forEach(({partIndex},i)=>{
    const size=parts[partIndex]?.sizeMm;
    counts.set(partIndex,(counts.get(partIndex)||0)+1);
    if(!anchors[i]||(!anchors[i].catalogId&&(!size||!nearDimensions(anchors[i].sizeMm,size,.01))))partial.add(partIndex);
  });
  return bodies.map(({partIndex},i)=>!partial.has(partIndex)&&counts.get(partIndex)<=parts[partIndex]?.qty?anchors[i]:null);
}

const nearDimensions=(a,b,tolerance)=>a.every((v,i)=>Math.abs(v-b[i])<=tolerance);
const dot3=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const subtract3=(a,b)=>a.map((v,i)=>v-b[i]);
const unitAxes=[[1,0,0],[0,1,0],[0,0,1]];

// Fit a known purchased part to the generated features, not to their combined
// bounding box. A rectangular PCB alone cannot resolve which edge faces USB or
// which side faces the components. Missing or ambiguous landmarks retain CSG.
function registeredCatalogAnchor(body,part,meta){
  const registration=meta?.registration,marks=registration?.landmarks;
  if(!marks||marks.length<3||!nearDimensions(part.sizeMm,meta.sizeMm,.01))return null;
  const matches=(f,m)=>f.op==='add'&&f.shape===m.shape&&nearDimensions(f.sizeMm,m.sizeMm,m.sizeToleranceMm);
  const boards=body.features.filter(f=>matches(f,marks[0]));
  if(boards.length!==1)return null;
  const board=boards[0],pitch=marks[0].centerMm;
  const [x,y,z]=board.rotationDeg||[0,0,0];
  // These are R_board times the four proper rotations that leave a non-square
  // rectangle on its own axes (including cases with components facing down).
  const rotations=[[x,y,z],[x+180,y,z],[-x,y+180,z],[-x,-y,z+180]];
  const middle=meta.boundsMm.min.map((n,i)=>(n+meta.boundsMm.max[i])/2);
  const solutions=[];
  for(const rotationDeg of rotations){
    const toBody=featurePlacement({centerMm:board.centerMm,rotationDeg},pitch);
    const fit=marks.slice(1).every(mark=>{
      const expected=toBody(mark.centerMm);
      return body.features.filter(f=>matches(f,mark)&&Math.hypot(...subtract3(f.centerMm,expected))<=mark.centerToleranceMm).length===1;
    });
    if(!fit)continue;
    // Keep added fixtures, oversize accessories and modifications through the
    // board in the authored model. A socket aperture above the board is fine.
    const rotation=featurePlacement({centerMm:[0,0,0],rotationDeg});
    const basis=unitAxes.map(rotation);
    const typical=body.features.every(f=>{
      const local=basis.map((axis,k)=>dot3(subtract3(f.centerMm,board.centerMm),axis)+pitch[k]);
      const axes=unitAxes.map(featurePlacement({centerMm:[0,0,0],rotationDeg:f.rotationDeg}));
      const reach=basis.map(axis=>axes.reduce((total,v,k)=>total+Math.abs(dot3(v,axis))*f.sizeMm[k]/2,0));
      if(f.op==='cut')return local[2]-reach[2]>=pitch[2]+marks[0].sizeMm[2]/2-.02
        ||local[2]+reach[2]<=pitch[2]-marks[0].sizeMm[2]/2+.02;
      return local.every((coord,k)=>coord-reach[k]>=meta.boundsMm.min[k]-registration.envelopeToleranceMm
        &&coord+reach[k]<=meta.boundsMm.max[k]+registration.envelopeToleranceMm);
    });
    if(typical)solutions.push({op:'add',shape:'box',sizeMm:[...meta.sizeMm],centerMm:toBody(middle),rotationDeg});
  }
  return solutions.length===1?solutions[0]:null;
}

// The kernel rotates features about X, then Y, then Z before placing their centre.
export function featurePlacement(feature,origin=[0,0,0]){
 const angles=(feature.rotationDeg||[0,0,0]).map(n=>n*Math.PI/180),c=angles.map(Math.cos),s=angles.map(Math.sin);
 return point=>{
  let [x,y,z]=point.map((n,k)=>n-origin[k]);
  [y,z]=[y*c[0]-z*s[0],y*s[0]+z*c[0]];
  [x,z]=[x*c[1]+z*s[1],-x*s[1]+z*c[1]];
  [x,y]=[x*c[2]-y*s[2],x*s[2]+y*c[2]];
  return [x,y,z].map((n,k)=>n+feature.centerMm[k]);
 };
}

export function validateCadPlan(plan,partCount=60){
 const bad=()=>{throw Error('Invalid CAD plan')};
 if(!(exact(plan,['version','bodies'])||exact(plan,['version','bodies','motions']))||plan.version!==1||!Array.isArray(plan.bodies)||plan.bodies.length>40)bad();
 let n=0;for(const b of plan.bodies){
 if(!exact(b,['name','partIndex','role','positionMm','features'])||typeof b.name!=='string'||!b.name.trim()||b.name.length>200||!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>=partCount||!roles.includes(b.role)||!isvec(b.positionMm,-2000,2000)||!Array.isArray(b.features)||!b.features.length||b.features.length>40||(n+=b.features.length)>240||b.features[0]?.op!=='add')bad();
 for(const f of b.features)if(!(exact(f,['op','shape','sizeMm','centerMm'])||(exact(f,['op','shape','sizeMm','centerMm','rotationDeg'])&&isvec(f.rotationDeg,-360,360)))||!ops.includes(f.op)||!shapes.includes(f.shape)||!isvec(f.sizeMm,.1,2000)||!isvec(f.centerMm,-2000,2000)||(f.shape==='cylinder'&&Math.abs(f.sizeMm[0]-f.sizeMm[1])>1e-6))bad();
 }
 if(Object.hasOwn(plan,'motions'))validateMotions(plan);
 return plan;
}

function validateMotions({motions,bodies}){
 if(!Array.isArray(motions)||motions.length>8)throw Error('CAD 运动计划格式无效。');
 const placedParts=new Set(bodies.map(body=>body.partIndex));
 const assignedBodies=new Set();
 for(const motion of motions){
  if(!exact(motion,['type','name','axis','travelMm','movingBodyIndices','actuatorPartIndex','guidePartIndex','controllerPartIndex'])||
     motion.type!=='prismatic'||typeof motion.name!=='string'||!motion.name.trim()||motion.name.length>200)
   throw Error('伸缩机构需要有效的名称和运动类型。');
  if(!isvec(motion.axis,-1,1)||Math.abs(Math.hypot(...motion.axis)-1)>.005||
     !Number.isFinite(motion.travelMm)||motion.travelMm<=0||motion.travelMm>2000)
   throw Error('伸缩机构需要世界坐标下的单位方向和有效的毫米行程。');
  const moving=motion.movingBodyIndices;
  if(!Array.isArray(moving)||moving.length===0||moving.length>=bodies.length)
   throw Error('伸缩机构须同时保留固定件和随动件。');
  for(const i of moving){
   if(!Number.isInteger(i)||i<0||i>=bodies.length||assignedBodies.has(i))
    throw Error('运动计划包含无效或重复的随动件。');
   assignedBodies.add(i);
  }
  for(const index of [motion.actuatorPartIndex,motion.guidePartIndex,motion.controllerPartIndex]){
   if(!placedParts.has(index))throw Error('请为驱动、导向和控制部件提供 BOM 零件及对应的 CAD 安装位置。');
  }
 }
}

// bodyIndex identifies a CAD solid. Several solids may belong to one BOM part.
export function cadBodyProgress(plan,bodyIndex,phase) {
  const {partIndex,name}=plan.bodies[bodyIndex];
  return {type:'progress',phase,bodyIndex,partIndex,name,total:plan.bodies.length,
    completed:bodyIndex+(phase==='finish'?1:0)};
}
