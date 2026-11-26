import {matchHardware} from './assembly-hardware.js';
import {validateJoints} from './assembly-joints.js';
import {matchOled938Reference,resolvePanelHardwareReference} from './panel-hardware-reference.js';
const shapes=['box','ellipsoid','cylinder','roundedPrism','capsule'],ops=['add','cut'],roles=['printed','reference'];
export const MAX_DESIGN_PARTS=132;
export const MAX_CAD_BODIES=320;
export const MAX_CAD_FEATURES=4096;
export const MAX_FEATURES_PER_BODY=80;
export const MIN_CAD_FEATURE_MM=0.1;
export const MAX_CAD_FEATURE_MM=2000;
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const isvec=(v,min,max)=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>=min&&n<=max);
export const cadBodyColor=(body,fallback)=>body.color
 ?[1,3,5].map(index=>Number.parseInt(body.color.slice(index,index+2),16)):fallback;
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

export function validateCadPlan(plan,partCount=MAX_DESIGN_PARTS){
 const bad=detail=>{throw Error('Invalid CAD plan'+(detail?'：'+detail:''))};
 if(!plan||!Object.keys(plan).every(k=>['version','bodies','motions','joints','fitChecks'].includes(k))||plan.version!==1||!Array.isArray(plan.bodies)||plan.bodies.length>MAX_CAD_BODIES)bad('version 应为 1，bodies 为不超过 '+MAX_CAD_BODIES+' 件的数组。');
 let n=0;for(const [bi,b]of plan.bodies.entries()){
 const location='bodies['+bi+']';
 const bodyKeys=['name','partIndex','role','positionMm','features'];
 if(Object.hasOwn(b||{},'sourceMeshes'))bodyKeys.push('sourceMeshes');
 if(Object.hasOwn(b||{},'color'))bodyKeys.push('color');
 if(Object.hasOwn(b||{},'instanceIndex')){bodyKeys.push('instanceIndex');if(!Number.isSafeInteger(b.instanceIndex)||b.instanceIndex<0||b.instanceIndex>9999||(b.sourceMeshes&&b.sourceMeshes.instanceIndex!==b.instanceIndex))bad(location+' 安装实例编号无效或与原厂分件不一致。');}
 if(!exact(b,bodyKeys)||typeof b.name!=='string'||!b.name.trim()||b.name.length>200||!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>=partCount||!roles.includes(b.role)||!isvec(b.positionMm,-2000,2000)||!Array.isArray(b.features)||!b.features.length||b.features.length>MAX_FEATURES_PER_BODY||b.features[0]?.op!=='add')bad(location+' 的字段、BOM 索引、位置或 features 无效；每件 1–'+MAX_FEATURES_PER_BODY+' 个特征且先 add。');
 if(b.color!=null&&(typeof b.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(b.color)))bad(location+' 的 color 须为 #RRGGBB 或 null。');
 if((n+=b.features.length)>MAX_CAD_FEATURES)bad(location+' 使累计特征超过 '+MAX_CAD_FEATURES+'。');
 for(const [fi,f]of b.features.entries()){
  const at=location+'.features['+fi+']';
  if(!(exact(f,['op','shape','sizeMm','centerMm'])||(exact(f,['op','shape','sizeMm','centerMm','rotationDeg'])&&isvec(f.rotationDeg,-360,360)))||!ops.includes(f.op)||!shapes.includes(f.shape))bad(at+' 的字段、图元、操作或旋转无效。');
  if(!isvec(f.sizeMm,MIN_CAD_FEATURE_MM,MAX_CAD_FEATURE_MM))bad(at+' 的 sizeMm 每轴必须在 '+MIN_CAD_FEATURE_MM+'–'+MAX_CAD_FEATURE_MM+' mm；收到 '+JSON.stringify(f.sizeMm));
  if(!isvec(f.centerMm,-2000,2000))bad(at+' 的 centerMm 每轴必须在 ±2000 mm。');
  if(f.shape==='cylinder'&&Math.abs(f.sizeMm[0]-f.sizeMm[1])>1e-6)bad(at+' 的 cylinder 必须 XY 等径，收到 '+JSON.stringify(f.sizeMm)+'；朝向用 rotationDeg 表达。');
 }
 if(b.sourceMeshes!=null){
  const {instanceIndex,meshIndices,dimensionBasis}=b.sourceMeshes;
  const sourceKeys=Object.hasOwn(b.sourceMeshes,'dimensionBasis')?['instanceIndex','meshIndices','dimensionBasis']:['instanceIndex','meshIndices'];
  if(!exact(b.sourceMeshes,sourceKeys)||b.role!=='reference'||
    !Number.isInteger(instanceIndex)||instanceIndex<0||!Array.isArray(meshIndices)||meshIndices.length>120||
    meshIndices.some(i=>!Number.isInteger(i)||i<0)||new Set(meshIndices).size!==meshIndices.length)
   bad(location+' 的 sourceMeshes 需要 reference 实体、非负安装实例索引和不重复的网格索引。');
  if(meshIndices.length?(!wholePartBox(b)||dimensionBasis!=null):
    (wholePartBox(b)||typeof dimensionBasis!=='string'||!dimensionBasis.trim()||dimensionBasis.length>500))
   bad(location+' 的原厂分件使用单个 reference box；按尺寸建模的分件须有实体特征及不超过 500 字的 dimensionBasis。');
 }
 }
 if(Object.hasOwn(plan,'fitChecks')){
  if(!Array.isArray(plan.fitChecks)||plan.fitChecks.length>plan.bodies.length)bad('fitChecks 数量无效。');
  const seen=new Set();for(const f of plan.fitChecks){
   if(!exact(f,['partIndex','instanceIndex','housingBodyIndices','lidBodyIndices','insertionOffsetMm',...(f&&Object.hasOwn(f,'mountType')?['mountType']:[]),...(f&&Object.hasOwn(f,'lidOffsetMm')?['lidOffsetMm']:[]),...(f&&Object.hasOwn(f,'portAccess')?['portAccess']:[])])||(f.lidOffsetMm!=null&&(!isvec(f.lidOffsetMm,-2000,2000)||Math.hypot(...f.lidOffsetMm)<0.1))||!Number.isInteger(f.partIndex)||f.partIndex<0||f.partIndex>=partCount||!Number.isInteger(f.instanceIndex)||f.instanceIndex<0||!isvec(f.insertionOffsetMm,-2000,2000)||Math.hypot(...f.insertionOffsetMm)<0.1)bad('fitChecks 的目标或直线装入偏移无效。');
   if(Object.hasOwn(f,'mountType')&&!['closed-housing','open-mount'].includes(f.mountType))bad('安装形式无效。');
   if(!Array.isArray(f.housingBodyIndices)||!f.housingBodyIndices.length||!Array.isArray(f.lidBodyIndices))bad('fitChecks 需要壳体和适用的可拆盖。');
   if(f.portAccess!==undefined&&(!Array.isArray(f.portAccess)||f.portAccess.length>64||f.portAccess.some(p=>!exact(p,['pins','bodyIndex','centerMm','plugSizeMm','approachMm'])||!Array.isArray(p.pins)||!p.pins.length||p.pins.some(v=>typeof v!=='string'||!v.trim())||!Number.isInteger(p.bodyIndex)||plan.bodies[p.bodyIndex]?.partIndex!==f.partIndex||!isvec(p.centerMm,-2000,2000)||!isvec(p.plugSizeMm,.1,500)||!isvec(p.approachMm,-2000,2000)||Math.hypot(...p.approachMm)<1)))bad('fitChecks 的外部插头、尺寸或插入路径无效。');
   const indexes=[...f.housingBodyIndices,...f.lidBodyIndices];const id=f.partIndex+':'+f.instanceIndex;
   if(indexes.some(i=>!Number.isInteger(i)||!plan.bodies[i])||new Set(indexes).size!==indexes.length||seen.has(id))bad('fitChecks 的壳、盖或目标重复或不存在。');seen.add(id);
  }
 }
 if(Object.hasOwn(plan,'motions'))validateMotions(plan);
 if(Object.hasOwn(plan,'joints'))validateJoints(plan);
 return plan;
}

function validateMotions({motions,bodies,joints=[]}){
 if(!Array.isArray(motions)||motions.length>8)throw Error('CAD 运动计划格式无效。');
 const placedParts=new Set(bodies.map(body=>body.partIndex));
 const assignedBodies=new Set();
 for(const motion of motions){
  if(!exact(motion,['type','name','axis','travelMm','movingBodyIndices','actuatorPartIndex','guidePartIndex','controllerPartIndex',...(Object.hasOwn(motion||{},'parentJointIndex')?['parentJointIndex']:[])])||
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
  const parent=motion.parentJointIndex??null;
  if(parent!==null&&(!Number.isInteger(parent)||!joints?.[parent]))throw Error('直线轴父子关系指向不存在的转轴。');
  const owner=i=>joints.reduce((found,j,k)=>j.movingBodyIndices?.includes(i)?k:found,null);
  if(moving.some(i=>owner(i)!==parent)||joints.some(j=>moving.includes(j.fixedBodyIndex))||
     (parent!==null&&!bodies.some((b,i)=>b.partIndex===motion.guidePartIndex&&!moving.includes(i)&&owner(i)===parent)))
   throw Error('直线轴父子关系错误：固定导向和移动件须在声明的直接父连杆上，不能移走转轴固定件。');
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
