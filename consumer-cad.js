import {occurrenceGroups,occurrenceOf} from './installed-parts.js';
import {catalog,loadPartMeshes,getHardwareMetadata,encodeSTL} from './assembly-hardware.js';
import {makeDocumentedProxy} from './part-geometry.js';
import {prepareMesh,createRaster,fitCamera,cameraBasis,projectWorldPoint,worldPointAtZ} from './mesh-renderer.js';
import {previewCadPlan,compileCadPlan,meshBounds,featurePlacement,cadDownloadName} from './consumer-geometry.js';
import {completeCatalogAnchors,hasEditableCatalogSource} from './forge-source.js';
import {validateCadPlan,wholePartBox,MAX_CAD_BODIES} from './cad-plan.js';
import {mountCadInteraction} from './consumer-interaction.js';
import {advanceMotionPreview} from './interaction-model.js';
import {buildAssemblyWiring} from './assembly-wires.js';
import {mountConsumerWiring} from './consumer-wiring.js';
import {matchOled938Reference,resolvePanelHardwareReference} from './panel-hardware-reference.js';
import {stylePurchasedBodyMeshes} from './purchased-body-details.js';
import {importedModel,importedPartAnchors} from './part-records.js';
import {jointMesh,jointPoint} from './assembly-joints.js';
import {mechanismConnections} from './kinematic-urdf.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sizeText=size=>size.map(n=>Number(n.toFixed(1))).join(' × ')+' mm';
const validSize=size=>Array.isArray(size)&&size.length===3&&size.every(n=>Number.isFinite(n)&&n>=.1&&n<=2000);
const colors=[[66,139,131],[194,133,76],[82,132,175],[167,117,154],[145,160,86]];
const roleText={internal:'内部',panel:'顶面位置示意',external:'外接附件',enclosure:'外壳目标包络'};
const inspectionPitch=1.15;
const dataText={catalog:'资料几何',cad:'CAD 文件尺寸',datasheet:'型号资料尺寸',specified:'指定设计包络',estimated:'估算设计包络'};
const safeUrl=value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)?u.href:null}catch{return null}};
const looseMaterial=part=>/线束|胶材|胶带|导线|USB.*线|USB.*cable|wire|adhesive/i.test(part.name+' '+part.spec);

function roleOf(part){
 if(Object.hasOwn(roleText,part.role))return part.role;
 const text=part.name+' '+part.spec;
 if(/外壳|壳体|enclosure|housing/i.test(text))return 'enclosure';
 if(/外接|外置|USB.*线|USB.*cable|电源适配器|power adapter/i.test(text))return 'external';
 if(/按钮|按键|显示屏|LED|pushbutton|display/i.test(text))return 'panel';
 return 'internal';
}

function normalizedParts(design){
 if(!Array.isArray(design?.parts)||!design.parts.length)throw Error('请先提供零件和尺寸，才能生成整机布局。');
 const declared=design.cadPlan?.bodies;
 let count=Array.isArray(declared)?declared.length:0;
 return design.parts.map((part,index)=>{
  if(!validSize(part.sizeMm))throw Error(`「${part.name||index+1}」需要 0.1–2000 mm 的长、宽、高。`);
  if(part.shape!==undefined&&!['box','cylinder'].includes(part.shape))throw Error(`「${part.name||index+1}」的参考形状须为长方体或圆柱。`);
  if(part.shape==='cylinder'&&Math.abs(part.sizeMm[0]-part.sizeMm[1])>1e-8)throw Error(`「${part.name||index+1}」为圆柱，长与宽须填写同一个直径。`);
  if(!Number.isInteger(part.qty)||part.qty<1||part.qty>999)throw Error('零件数量须为 1–999 的整数。');
  if(part.placement!=='loose'&&!looseMaterial(part))count+=Math.max(0,part.qty-(declared?.filter(b=>b.partIndex===index).length||0));
  if(count>MAX_CAD_BODIES)throw Error('整机最多预览 '+MAX_CAD_BODIES+' 个三维实例；仅列在清单的材料与附件不计入。');
  const dimensionSource=Object.hasOwn(dataText,part.dimensionSource)?part.dimensionSource:'estimated';
  return {...part,index,sizeMm:[...part.sizeMm],role:roleOf(part),dimensionSource};
 });
}

// Shelf packing is recomputed from envelopes and quantities; no part has a fixed
// Pico-specific coordinate. External cables are deliberately outside this pack.
function pack(parts,gap){
 const instances=parts.filter(part=>part.placement!=='loose'&&!looseMaterial(part)).flatMap(part=>Array.from({length:part.qty},(_,copy)=>({partIndex:part.index,copy,sizeMm:part.sizeMm,role:part.role})));
 if(!instances.length)return {instances:[],sizeMm:[0,0,0]};
 const width=Math.max(...instances.map(item=>item.sizeMm[0]),Math.sqrt(instances.reduce((sum,item)=>sum+(item.sizeMm[0]+gap)*(item.sizeMm[1]+gap),0))*1.25);
 let x=0,y=0,rowDepth=0,usedWidth=0,height=0;
 for(const item of instances){const [w,d,h]=item.sizeMm;if(x&&x+w>width){x=0;y+=rowDepth+gap;rowDepth=0}item.positionMm=[x,y,0];x+=w+gap;rowDepth=Math.max(rowDepth,d);usedWidth=Math.max(usedWidth,x-gap);height=Math.max(height,h)}
 return {instances,sizeMm:[usedWidth,y+rowDepth,height]};
}

function profile(w,d,inset=0,bevel=5){
 const x=inset,y=inset,a=w-inset,b=d-inset,r=Math.max(.1,Math.min(bevel-inset,(a-x)/4,(b-y)/4));
 return [[x+r,y],[a-r,y],[a,y+r],[a,b-r],[a-r,b],[x+r,b],[x,b-r],[x,y+r]];
}
function quad(out,a,b,c,d){out.push([a,b,c],[a,c,d])}
function cap(out,ring,z,reverse=false){for(let i=1;i<ring.length-1;i++){const face=[ring[0],ring[i],ring[i+1]].map(p=>[...p,z]);out.push(reverse?face.reverse():face)}}
function closedSlab(ring,h){const faces=[];cap(faces,ring,0,true);cap(faces,ring,h);ring.forEach((a,i)=>{const b=ring[(i+1)%ring.length];quad(faces,[...a,0],[...b,0],[...b,h],[...a,h])});return faces}
function hollowBase(w,d,h,wall){
 const bevel=Math.min(6,w*.12,d*.12),outer=profile(w,d,0,bevel),inner=profile(w,d,wall,bevel),faces=[];
 cap(faces,outer,0,true);cap(faces,inner,wall);
 outer.forEach((a,i)=>{const j=(i+1)%outer.length,b=outer[j],c=inner[i],e=inner[j];quad(faces,[...a,0],[...b,0],[...b,h],[...a,h]);quad(faces,[...c,wall],[...c,h],[...e,h],[...e,wall]);quad(faces,[...a,h],[...b,h],[...e,h],[...c,h])});
 return {faces,profile:outer};
}

export function buildConsumerConcept(design){
 const parts=normalizedParts(design),wall=2,gap=4,margin=7,headroom=6,lidThickness=2;
 const internal=pack(parts.filter(part=>part.role==='internal'),gap),panel=pack(parts.filter(part=>part.role==='panel'),gap);
 const target=parts.filter(part=>part.role==='enclosure').reduce((box,part)=>box.map((n,k)=>Math.max(n,part.sizeMm[k])),[0,0,0]);
 if(!internal.instances.length&&!panel.instances.length&&!target.some(Boolean))return {parts,instances:[],external:parts.filter(part=>part.role==='external'),shell:null,defaults:{wall,gap,headroom}};
 const w=Math.max(24,target[0],internal.sizeMm[0]+margin*2,panel.sizeMm[0]+margin*2),d=Math.max(20,target[1],internal.sizeMm[1]+margin*2,panel.sizeMm[1]+margin*2),h=Math.max(14,target[2]-lidThickness,wall+internal.sizeMm[2]+headroom);
 const base=hollowBase(w,d,h,wall),lid=closedSlab(base.profile,lidThickness);
 const instances=[...internal.instances.map(item=>({...item,positionMm:[item.positionMm[0]+(w-internal.sizeMm[0])/2,item.positionMm[1]+(d-internal.sizeMm[1])/2,wall+2]})),...panel.instances.map(item=>({...item,positionMm:[item.positionMm[0]+(w-panel.sizeMm[0])/2,item.positionMm[1]+(d-panel.sizeMm[1])/2,h+lidThickness]}))];
 return {parts,instances,external:parts.filter(part=>part.role==='external'),shell:{sizeMm:[w,d,h+lidThickness],baseHeight:h,lidThickness,base:base.faces,lid},defaults:{wall,gap,headroom}};
}

function boundsOf(meshes){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(const mesh of meshes)for(const face of mesh.triangles)for(const p of face)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k])}
 const size=max.map((n,k)=>n-min[k]);if(!validSize(size))throw Error('资料模型没有有效的包络。');
 return {min,size};
}
export async function resolveConsumerGeometry(design,options={}){
 const normalized=normalizedParts(design),parts=[];
 for(const part of normalized){
  options.signal?.throwIfAborted();
  const record={stage:'prepare',partIndex:part.index,name:part.name,total:normalized.length};
  options.onProgress?.({...record,phase:'start',completed:part.index});
  // A changed purchase must not inherit its old reference. The legacy OLED
  // matcher requires its exact revision, connector and unpopulated-header spec.
  const candidate=part.modelId||matchOled938Reference(part);
  const id=!part.modelSourceInvalidated&&Object.hasOwn(catalog,candidate||'')?candidate:null;
  const planned=design.cadPlan?.bodies?.some(body=>body.partIndex===part.index);
  let meshes,metadata=null,actualSize=null,geometryNote='',registered=false;
  const downloaded=importedModel(part.importedModel,part);
  if(downloaded){
   try{
    const response=await fetch(downloaded.meshUrl,{signal:options.signal,credentials:'same-origin',mode:'same-origin',redirect:'error'});
    if(!response.ok)throw Error('模型文件无法读取');
    const model=await response.json(),bounds=boundsOf(model.meshes);
    if(!bounds.size.every((n,i)=>Math.abs(n-downloaded.sizeMm[i])<.02))throw Error('文件尺寸与导入记录不一致');
    meshes=model.meshes;actualSize=downloaded.sizeMm;registered=true;
    metadata={modelType:downloaded.sourceType==='manufacturer'?'manufacturer-cad':'supplier-cad',manufacturerCadUrl:downloaded.sourceUrl,sourceUrl:downloaded.documentationUrl,sizeMm:actualSize};
    geometryNote='已读取 '+downloaded.format.toUpperCase()+'，保持原生毫米尺寸，通过安装锚点定位。';
   }catch(error){options.signal?.throwIfAborted();geometryNote='已下载模型暂未载入，显示尺寸简模。'+error.message;}
  }
  if(id&&!meshes){
   try{
    metadata=await getHardwareMetadata(id);
    const registrations=(design.cadPlan?.bodies||[]).filter(body=>body.partIndex===part.index&&resolvePanelHardwareReference(body,part,metadata));
    registered=registrations.length>0&&registrations.length<=part.qty;
    if((registered||part.dimensionSource==='catalog'&&!part.shape)&&(planned||part.role!=='external')&&part.role!=='enclosure'){
     const raw=await loadPartMeshes(id),bounds=boundsOf(raw);
     if(registered||bounds.size.every((n,k)=>Math.abs(n-part.sizeMm[k])<=.01)){
      actualSize=bounds.size;
      meshes=raw.map(mesh=>({...mesh,triangles:mesh.triangles.map(face=>face.map(p=>p.map((n,k)=>n-bounds.min[k])))}));
      geometryNote=registered?'以原方案的 PCB、安装孔和屏面定位原厂模型，未缩放；保留原清单尺寸记录':metadata.modelType==='dimensioned-approximation'?'据资料绘制的近似参考模型，未缩放；器件高度等估计细节见来源说明':'资料模型原始尺寸，未缩放';
     }else geometryNote='输入尺寸与目录几何不一致，保留输入尺寸显示设计包络，未缩放目录模型';
    }
   }catch{geometryNote='资料几何暂不可用，按当前尺寸显示近似包络'}
  }
  if(!meshes&&(planned||part.role!=='external'||design.cadPlan&&!looseMaterial(part))&&(part.role!=='enclosure'||part.modelSourceInvalidated)){
   meshes=makeDocumentedProxy({shape:part.shape||'box',sizeMm:part.sizeMm}).meshes.map(mesh=>({...mesh,color:colors[part.index%colors.length]}));
   geometryNote=geometryNote||`按当前尺寸生成的${part.shape==='cylinder'?'圆柱':'长方体'}设计包络，不代表原厂外形`;
  }
  if(part.role==='external'&&!planned)geometryNote='外接附件的尺寸记录，未指定安装位置；不参与外壳包络';
  if(part.role==='enclosure')geometryNote=planned?'按声明式结构生成形体，不代表原厂外壳或已验证的制造设计':'作为目标外包络下限；当前显示重新计算的概念壳体';
  if(planned&&part.modelSourceInvalidated)geometryNote='型号或尺寸已更改，旧形体与安装位置已撤下；当前为新尺寸包络，请重新生成结构。';
  parts.push({...part,sizeMm:[...part.sizeMm],dimensionSource:registered?part.dimensionSource:actualSize?'catalog':meshes&&part.dimensionSource==='catalog'?'specified':part.dimensionSource,...(actualSize?{resolvedModelId:id}:{}),meshes,metadata,geometryKind:actualSize?'catalog':'envelope',geometryNote});
  options.onProgress?.({...record,phase:'finish',completed:part.index+1});
 }
 return parts;
}

// A declared body owns its placement. A catalogue reference replaces an AI
// reference envelope at the same centre without stretching the purchased part.
function shiftedMeshes(meshes,offset){return meshes.map(mesh=>({...mesh,triangles:mesh.triangles.map(face=>face.map(point=>point.map((n,k)=>n+offset[k])))}))}
export function currentCadPlan(design){
 const plan=validateCadPlan(design.cadPlan,design.parts.length);
 const bodies=[],indices=new Map();
 plan.bodies.forEach((body,index)=>{
  if(design.parts[body.partIndex].modelSourceInvalidated)return;
  indices.set(index,bodies.length);
  bodies.push(body);
 });
 const active={version:1,bodies};
 if(plan.joints?.length&&bodies.length===plan.bodies.length)active.joints=plan.joints;
 else if(plan.joints)active.joints=[];
 if(plan.motions){
  active.motions=plan.motions.filter(motion=>{
   const supports=[motion.actuatorPartIndex,motion.guidePartIndex,motion.controllerPartIndex];
   return motion.movingBodyIndices.length<bodies.length&&supports.every(index=>!design.parts[index].modelSourceInvalidated)
    &&motion.movingBodyIndices.every(index=>indices.has(index));
  }).map(motion=>({...motion,movingBodyIndices:motion.movingBodyIndices.map(index=>indices.get(index))}));
 }
 return active;
}
export function buildDeclaredAssembly(design,parts,geometry){
 const instances=[];
 const anchors=completeCatalogAnchors(geometry.bodies,parts);
 const importedAnchors=importedPartAnchors(geometry.bodies,parts);
 for(let index=0;index<geometry.bodies.length;index++){
  const body=geometry.bodies[index],part=parts[body.partIndex];
  if(!part)throw Error('形体引用了不存在的零件。');
  if(part.modelSourceInvalidated)continue;
  let meshes=body.meshes,source='generated';
  // A motor and its rod can share a BOM row. Swap only a complete part's
  // placement box or an explicit native mesh selection.
  const anchor=importedAnchors[index]||anchors[index];
  if(body.sourceMeshes?.meshIndices.length&&geometry.exact&&(!importedAnchors[index]||part.geometryKind!=='catalog'))
   throw Error('无法读取「'+body.name+'」的已安装原厂分件。');
  if(anchor&&part.geometryKind==='catalog'&&part.meshes?.length){
   const selected=anchor.meshIndices?anchor.meshIndices.map(i=>part.meshes[i]):part.meshes;
   if(selected.some(mesh=>!mesh))throw Error('原厂模型文件缺少已检查的分件。');
   const place=featurePlacement(anchor,anchor.sourceOriginMm||anchor.sizeMm.map(n=>n/2));
   meshes=selected.map(mesh=>({...mesh,triangles:mesh.triangles.map(face=>face.map(place))}));
   source='catalog';
  }
  if(source==='generated'&&!body.color)meshes=stylePurchasedBodyMeshes(body,part,meshes);
  instances.push({partIndex:part.index,bodyIndex:index,copy:occurrenceOf(body,part)??null,role:part.role,kind:body.role,name:body.name,positionMm:[...body.positionMm],meshes,source,exact:source==='catalog'||geometry.exact,placed:true});
 }
 const box=instances.length?meshBounds(instances.flatMap(item=>shiftedMeshes(item.meshes,item.positionMm))):{min:[0,0,0],max:[0,0,0],sizeMm:[0,0,0]};
 const unplaced=[];let unplacedCount=0,omittedCount=0;
 for(const part of parts){
  const remaining=Math.max(0,part.qty-occurrenceGroups(geometry,part,part.index).groups.size);
  if(!part.meshes?.length||part.placement==='loose'||looseMaterial(part)){omittedCount+=remaining;continue}
  if(remaining)unplaced.push({...part,qty:remaining});
 }
 for(const item of pack(unplaced,6).instances){const part=parts[item.partIndex];instances.push({...item,kind:'reference',name:part.name,positionMm:[box.max[0]+20+item.positionMm[0],box.min[1]+item.positionMm[1],box.min[2]],meshes:part.meshes,source:part.geometryKind,exact:part.geometryKind==='catalog',placed:false});unplacedCount++}
 return {declared:true,parts,instances,bounds:box,sizeMm:box.sizeMm,unplacedCount,omittedCount,shell:null};
}

export function declaredHomeCamera(concept,motions=[]){
 // Frame the approaching face and enough of its path to see the stroke.
 // A panel connector can sit on the back of the device.
 const externalMotion=motions.find(motion=>Math.hypot(motion.axis[0],motion.axis[1])>.1
  &&concept.instances.some(item=>item.placed&&item.role!=='internal'&&motion.movingBodyIndices.includes(item.bodyIndex)));
 if(externalMotion)return {yaw:Math.atan2(externalMotion.axis[0],externalMotion.axis[1])+.69,pitch:.37};
 const panels=concept.instances.filter(item=>item.placed&&item.role==='panel');
 if(!panels.length)return {yaw:-.64,pitch:.4};
 const center=concept.bounds.min.map((n,k)=>(n+concept.bounds.max[k])/2),target=[0,0,0];
 for(const panel of panels){const box=meshBounds(panel.meshes);for(let k=0;k<3;k++)target[k]+=panel.positionMm[k]+(box.min[k]+box.max[k])/2}
 const dx=target[0]/panels.length-center[0],dy=target[1]/panels.length-center[1];
 return {yaw:Math.hypot(dx,dy)>.01?Math.atan2(dx,dy)-.49:-.64,pitch:.32};
}

export function declaredExplosionOffset(item,concept){
 if(!item.placed||item.kind!=='printed')return [0,0,0];
 const bounds=meshBounds(item.meshes),center=bounds.min.map((n,k)=>item.positionMm[k]+(n+bounds.max[k])/2),origin=concept.bounds.min.map((n,k)=>(n+concept.bounds.max[k])/2);
 const delta=center.map((n,k)=>(n-origin[k])/Math.max(1,concept.sizeMm[k]));
 const axis=delta.reduce((best,n,k)=>Math.abs(n)>Math.abs(delta[best])?k:best,0),length=Math.max(22,Math.max(...concept.sizeMm)*.38);
 if(Math.abs(delta[axis])<.18)return [0,0,length];
 return [0,0,0].map((_,k)=>k===axis?Math.sign(delta[k])*length:0);
}

export function visibleAssemblyInstances(concept,mode,includeInterior=false,motions=[]){
 const hasEnclosure=mode==='closed'&&concept.instances.some(item=>item.placed&&item.role==='enclosure');
 return concept.instances.filter(item=>{
  if(mode==='references')return !item.placed;
  if(!item.placed)return false;
  if(mode==='inside')return item.role==='internal'||(item.kind==='reference'&&item.role==='panel');
  if(mode==='closed'&&!includeInterior&&item.role==='internal'){
   // The enclosure's depth buffer hides the covered length. A shaft can
   // cross the enclosure even though its BOM location is marked internal.
   return hasEnclosure&&(item.kind==='printed'||motions.some(motion=>
    motion.movingBodyIndices.includes(item.bodyIndex)&&
    (item.partIndex===motion.actuatorPartIndex||item.partIndex===motion.guidePartIndex)
   ));
  }
  return true;
 });
}

function installedHardwareView(concept,defaultYaw,wiring){
 const positioned=concept.instances.filter(item=>item.placed);
 function worldBox(item){
  const local=meshBounds(item.meshes);
  return {min:local.min.map((v,k)=>v+item.positionMm[k]),max:local.max.map((v,k)=>v+item.positionMm[k])};
 }
 const enclosures=positioned.filter(item=>item.role==='enclosure').map(worldBox);
 const hardware=positioned.filter(item=>item.kind==='reference'&&(item.role==='internal'||item.role==='panel'))
  .map(item=>({item,box:worldBox(item)}));
 const inside=hardware.filter(({box})=>enclosures.some(shell=>box.min.every((n,k)=>n<=shell.max[k]&&box.max[k]>=shell.min[k])));
 const installed=inside.length?inside:hardware;
 const terminalDirections=[...new Map((wiring?.routes||[]).flatMap(route=>[route.from,route.to])
  .filter(end=>end.exitDirection?.length===3).map(end=>[end.partIndex+':'+end.exitDirection.join(','),end.exitDirection])).values()];
 // Keep documented terminal faces in view as well as separating modules.
 // Pure overlap minimization can turn a vertical PCB edge-on.
 // Two CAD bodies from the same purchased actuator form one part.
 function coverage(yaw){
  const {right,down,toward}=cameraBasis(yaw,inspectionPitch);
  const projected=installed.map(({item,box})=>{
   const [x,y,z]=box.min.map((n,k)=>(n+box.max[k])/2),[w,d,h]=box.min.map((n,k)=>(box.max[k]-n)/2);
   const [u,v]=projectWorldPoint([x,y,z],{yaw,pitch:inspectionPitch}),half=[w,d,h];
   const du=half.reduce((sum,n,k)=>sum+n*Math.abs(right[k]),0),dv=half.reduce((sum,n,k)=>sum+n*Math.abs(down[k]),0);
   return {part:item.partIndex,left:u-du,right:u+du,top:v-dv,bottom:v+dv,area:4*du*dv};
  });
  let overlap=0;
  for(const [index,a] of projected.entries())for(const b of projected.slice(index+1)){
   if(a.part===b.part)continue;
   const width=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));
   const height=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
   overlap+=width*height/Math.max(.01,Math.min(a.area,b.area));
  }
  return overlap+terminalDirections.reduce((sum,normal)=>sum+2*Math.max(0,.2-normal.reduce((dot,n,k)=>dot+n*toward[k],0)),0);
 }
 let yaw=defaultYaw,min=coverage(yaw);
 for(const step of [1,-1,2,-2,3,-3,4]){
  if(min<1e-6)break;
  const candidate=defaultYaw+step*Math.PI/4,score=coverage(candidate);
  if(score<min-1e-6){yaw=candidate;min=score}
 }
 return {bodies:new Set(installed.map(({item})=>item.bodyIndex)),yaw};
}

function partGeometryLabel(part,instances){
 const catalogMatch=instances.some(item=>item.source==='catalog')||instances.some(item=>!item.kind)&&part?.geometryKind==='catalog';
 if(catalogMatch){
  if(part.metadata?.modelType==='manufacturer-cad')return '原厂 CAD';
  if(part.metadata?.modelType==='supplier-cad')return '供应商 CAD';
  if(part.metadata?.modelType==='dimensioned-approximation')return '资料简模';
  return '目录参考模型';
 }
 if(instances.some(item=>item.kind==='printed'))return '定制结构';
 return part?.geometryReference?.kind==='datasheet-approximation'?'资料简模':'尺寸简模';
}

// Design coordinates describe the retracted state. Only declared moving bodies
// translate, and the mechanism controls are independent of the exploded view.
export function bodyPose(item,motions,progress){
 const position=[...item.positionMm];
 for(const [index,motion] of motions.entries()){
  if(!motion.movingBodyIndices.includes(item.bodyIndex))continue;
  const travel=motion.travelMm*Math.max(0,Math.min(1,progress[index]||0));
  for(let axis=0;axis<3;axis++)position[axis]+=motion.axis[axis]*travel;
 }
 return position;
}

// Single-part exports use the body origin. An assembled STL keeps the same
// world-space poses as the viewer, including the current mechanism travel.
export function assemblyStl(concept,motions=[],progress=[],joints=[],jointValues=[]){
 const faces=[];
 for(const item of concept.instances){
  if(!item.placed)continue;
  const offset=bodyPose(item,motions,progress);
  for(const mesh of item.meshes)for(const face of mesh.triangles){
   faces.push(face.map(point=>jointPoint(point.map((n,k)=>n+offset[k]),item.bodyIndex,joints,jointValues)));
  }
 }
 return encodeSTL(faces,'Formwork assembled reference in mm');
}

const viewerSymbols={
 files:'<path d="M8 2.5h6l4 4v13H8zM14 2.5v4h4M5 6v15h10"/>',
 parts:'<path d="m12 2.8 8.2 4.5v9.3L12 21l-8.2-4.4V7.3zM3.8 7.3 12 12l8.2-4.7M12 12v9"/>',
 fit:'<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/>',
 minus:'<path d="M5 12h14"/>',plus:'<path d="M5 12h14m-7-7v14"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>'
};
function viewerIcon(name){
 return `<svg class="cc-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${viewerSymbols[name]}</svg>`;
}

// Intersect the four viewport corners with the assembly's XY floor and draw
// whole millimetre intervals using the same orthographic camera as its solids.
function drawFloorGrid(canvas,box,camera,floorZ){
 const {pitch,scale}=camera;
 if(Math.sin(pitch)<.14)return;
 const corners=[[0,0],[box.width,0],[box.width,box.height],[0,box.height]].map(p=>worldPointAtZ(p,camera,floorZ));
 const bounds=[0,1].map(axis=>[Math.min(...corners.map(p=>p[axis])),Math.max(...corners.map(p=>p[axis]))]);
 const targetStep=48/scale,decade=10**Math.floor(Math.log10(targetStep));
 const step=Math.max(1,decade*([1,2,5,10].find(n=>n*decade>=targetStep)||10));
 function screen(x,y){
  return projectWorldPoint([x,y,floorZ],camera).slice(0,2);
 }
 const ctx=canvas.getContext('2d');
 ctx.save();
 ctx.setTransform(canvas.width/box.width,0,0,canvas.height/box.height,0,0);
 ctx.globalCompositeOperation='destination-over';
 ctx.lineWidth=.8;
 for(const major of [true,false]){
  ctx.beginPath();ctx.strokeStyle=major?'#c9c9c9':'#e7e7e7';
  for(let axis=0;axis<2;axis++){
   const [min,max]=bounds[axis],other=bounds[1-axis];
   for(let i=Math.ceil(min/step);i<=Math.floor(max/step);i++){
    if((i%5===0)!==major)continue;
    const a=i*step;
    ctx.moveTo(...(axis===0?screen(a,other[0]):screen(other[0],a)));
    ctx.lineTo(...(axis===0?screen(a,other[1]):screen(other[1],a)));
   }
  }
  ctx.stroke();
 }
 ctx.restore();
}

function mechanismCard(plan,parts,mechanism,index,rotary,value,connections){
 const m=mechanism,name=esc(m.name),number=n=>Number(n.toFixed(4));
 const axisIndex=m.axis.findIndex((_,i)=>m.axis.every((v,k)=>k===i?Math.abs(Math.abs(v)-1)<1e-9:Math.abs(v)<1e-9));
 const axis=axisIndex<0?'轴向 ('+m.axis.map(number).join(', ')+')':(m.axis[axisIndex]<0?'−':'+')+'XYZ'[axisIndex]+' 轴';
 const span=rotary?`${m.minDegrees}° 至 ${m.maxDegrees}°`:`0 至 ${m.travelMm} mm`;
 const parent=rotary?(m.parentIndex===null?'根关节':'上级：'+plan.joints[m.parentIndex].name):'直线行程';
 const pair=connections?.[rotary?'joint':'travel']?.[index];
 const connection=pair?`<p class="cc-link-pair" data-cc-link-from="${esc(pair.parent.id)}" data-cc-link-to="${esc(pair.child.id)}">连杆：${esc(pair.parent.label)} → ${esc(pair.child.label)}</p>`:
  '<p class="cc-link-pair">直接连杆关系未确定</p>';
 const members=pair?'<dt>直接装在此连杆上</dt><dd>'+esc(pair.child.bodies.map(i=>plan.bodies[i].name).join('、')||'未指定实体')+'</dd>':
  '<dt>连接说明</dt><dd>'+esc(connections?.reason)+'</dd>';
 const fixed=rotary?`<dt>固定端</dt><dd>${esc(plan.bodies[m.fixedBodyIndex].name)}</dd><dt>初始轴心</dt><dd>${m.pivotMm.map(number).join('，')} mm</dd>`:
  `<dt>导向件</dt><dd>${esc(parts[m.guidePartIndex].name)}</dd>`;
 const step=Number.isInteger(m.minDegrees)&&Number.isInteger(m.maxDegrees)?'1':'any';
 const range=rotary?`min="${m.minDegrees}" max="${m.maxDegrees}" step="${step}" value="${value}" data-cc-joint="${index}" aria-label="${name}角度"`:
  `min="0" max="100" value="${Math.round(value*100)}" data-cc-travel="${index}" aria-label="${name}行程"`;
 const jog=rotary?`<span class="cc-jog"><button type="button" data-cc-jog="${index}" data-cc-delta="-5" aria-label="${name}减小5度">−</button><button type="button" data-cc-jog="${index}" data-cc-delta="5" aria-label="${name}增加5度">＋</button></span>`:'';
 return `<section class="cc-motion-item" data-cc-mechanism="${rotary?'joint':'travel'}" data-index="${index}">
  <div class="cc-motion-name"><strong>${name}</strong><span>${esc(parent)} · 初始${axis} · ${span}</span></div>${connection}
  <div class="cc-motion-row"><input type="range" ${range}><output>${rotary?value+'°':''}</output>${jog}</div>
  <button type="button" data-cc-preview-mechanism hidden>在装配中演示</button>
  <details><summary>连接与随动件</summary><dl>${fixed}${members}<dt>驱动件</dt><dd>${esc(parts[m.actuatorPartIndex].name)}</dd>
  <dt>随动实体（${m.movingBodyIndices.length}）</dt><dd><ul>${m.movingBodyIndices.map(i=>'<li>'+esc(plan.bodies[i].name)+'</li>').join('')}</ul></dd></dl></details>
 </section>`;
}

export function mountConsumerCad(container,design,options={}){
 if(!container)return ()=>{};
 const allowDownloads=options.downloads!==false,declared=!!design.cadPlan?.bodies?.length;
 const research=design.generation?.mechanicalResearch;
 const priorNote=Number.isInteger(research?.inherited)&&research.inherited>0?`另有 ${research.inherited} 个型号沿用上版已查到的资料。`:'';
 const sourcingNote=research?.status==='searched'?`本轮查询了 ${research.requested} 个候选型号，其中 ${research.found} 个有可引用的厂家资料。`:
  research?.status==='unavailable'?'本轮未取得在线查参结果。各件采用的其他依据见下表。':'';
 container.innerHTML=`<section class="cc" aria-label="三维装配视图" data-cc-state="loading">
  <div class="cc-stage">
   <div class="cc-header">
    <div class="cc-tabs" role="group" aria-label="三维视图">
     <button type="button" data-cc-mode="closed">外观</button>
     <button type="button" data-cc-mode="open">${declared?'分解':'开盖'}</button>
     <button type="button" data-cc-mode="inside" aria-label="内部布局">内部</button>
     <button type="button" data-cc-mode="references" hidden>未定位件</button>
    </div>
    <span class="cc-size" data-cc-size></span>
   </div>
   <canvas tabindex="0" aria-label="三维装配模型。点击部件查看用途，拖动或使用方向键旋转，滚轮或加减键缩放，按 0 归位。"></canvas>
   <span class="cc-empty" data-cc-empty hidden></span>
   <div class="cc-focus-info" data-cc-focus-info hidden><div class="cc-focus-copy"><strong data-cc-focus-name></strong><small data-cc-focus-kind hidden></small><p data-cc-focus-purpose hidden></p></div><button type="button" data-cc-reset-focus>返回装配</button></div>
   <div class="cc-progress" data-cc-progress data-phase="loading">
    <span class="cc-progress-mark" aria-hidden="true"><i></i><i></i><i></i></span>
    <div class="cc-progress-copy" role="status" aria-live="polite" aria-atomic="true"><strong data-cc-progress-title>正在读取模型</strong><span data-cc-progress-detail></span></div>
    <button type="button" data-cc-retry hidden>重试</button>
   </div>
   <div class="cc-camera" role="group" aria-label="相机控制">
    <button type="button" data-cc-camera="out" aria-label="缩小" title="缩小">${viewerIcon('minus')}</button>
    <button type="button" data-cc-camera="in" aria-label="放大" title="放大">${viewerIcon('plus')}</button>
    <button type="button" data-cc-camera="home" aria-label="归位" title="视图归位">${viewerIcon('fit')}</button>
   </div>
  </div>
  <div class="cc-footer">
   <p class="cc-status" data-cc-status>正在加载零件几何…</p>
   <div class="cc-motion" data-cc-motion></div>
   <div class="cc-context" data-cc-context></div>
   ${allowDownloads?`<details class="cc-inspector cc-files" data-cc-files hidden>
    <summary>${viewerIcon('files')}<span>零件 CAD 文件</span>${viewerIcon('chevron')}</summary>
    <div class="cc-downloads" data-cc-downloads></div>
   </details>`:''}
   <details class="cc-inspector cc-sources">
    <summary>${viewerIcon('parts')}<span>零件与尺寸依据</span>${viewerIcon('chevron')}</summary>
    <div class="cc-metadata">
     <strong data-cc-engine></strong>
     ${sourcingNote||priorNote?`<p>${esc(sourcingNote+priorNote)}</p>`:''}
     <p data-cc-note>${declared?'装配间隙、材料和强度仍需实物验证。':'壳体尺寸根据零件包络计算，顶面件仅示意交互位置。'}</p>
    </div>
    <div class="cc-source-list" data-cc-sources>正在读取零件…</div>
   </details>
  </div>
 </section>`;
 const root=container.querySelector('.cc'),canvas=root.querySelector('canvas'),status=root.querySelector('[data-cc-status]'),raster=createRaster(canvas),aborter=new AbortController();
 const bubble=root.querySelector('[data-cc-progress]'),bubbleTitle=bubble.querySelector('[data-cc-progress-title]'),bubbleDetail=bubble.querySelector('[data-cc-progress-detail]'),retry=bubble.querySelector('[data-cc-retry]');
 const partWork=new Map();
 let progressStage='',confirmationTimer=0,jobBusy=false,compileFailed=false,pendingComplete=false,existingGeometry=false,partAnimation=null;
 function refreshRowWork(){
  if(!partsPanel)return;
  for(const badge of partsPanel.querySelectorAll('[data-cc-part-work]')){
   const value=partWork.get(Number(badge.dataset.ccPartWork))||'';
   if(value!==badge.textContent)badge.textContent=value;
  }
 }
 function showBubble(phase,title,detail=''){
  clearTimeout(confirmationTimer);
  bubble.hidden=false;bubble.dataset.phase=phase;
  if(bubbleTitle.textContent!==title)bubbleTitle.textContent=title;
  if(bubbleDetail.textContent!==detail)bubbleDetail.textContent=detail;
  retry.hidden=phase!=='error'||!compileFailed;
 }
 function progress(event){
  if(disposed||!root.isConnected)return;
  const {stage,phase,partIndex,bodyIndex,name,total,completed}=event;
  if(stage!==progressStage||phase==='request'){partWork.clear();progressStage=stage}
  existingGeometry=stage==='load'||(existingGeometry&&stage!=='generate');
  let title={prepare:'正在读取零件',load:'正在加载已有 CAD',generate:'正在生成 CAD',decode:'正在读取生成的实体',assemble:'正在放置模型'}[stage];
  const counted=Number.isInteger(completed)&&total>0;
  if(stage==='generate'&&phase==='finish'&&completed===total)title='实体已生成，正在接收模型';
  if(counted)title+=' · '+completed+' / '+total;
  showBubble('loading',title,name||'');
  bubble.dataset.stage=stage;
  if(phase==='start'&&Number.isInteger(bodyIndex)&&!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
   partAnimation?.cancel();
   partAnimation=bubble.animate?.([{transform:'translateY(3px) scale(.975)'},{transform:'translateY(0) scale(1)'}],{duration:185,easing:'ease-out'});
  }
  if(Number.isInteger(partIndex)){
   if(phase==='start')partWork.set(partIndex,{prepare:'读取中',load:'加载中',generate:'生成中',decode:'读取中'}[stage]);
   else if(phase==='finish'){
    const remaining=activePlan?.bodies.slice(bodyIndex+1).some(body=>body.partIndex===partIndex);
    partWork.set(partIndex,stage==='prepare'?'已读取':remaining?'部分完成':stage==='generate'?'已生成':'已加载');
   }
  }
  refreshRowWork();
 }
 function completeProgress(){
  if(!pendingComplete)return;
  pendingComplete=false;compileFailed=false;
  const count=geometry?.bodies.length||0;
  if(geometry?.exact){
   for(const body of geometry.bodies)partWork.set(body.partIndex,'就绪');
   refreshRowWork();
  }
  const title=declared?(existingGeometry?'已有 CAD 已加载':'模型已生成'):'布局已加载';
  showBubble('complete',title,count?count+' 个实体':'');
  confirmationTimer=setTimeout(()=>{bubble.hidden=true;partWork.clear();refreshRowWork()},1800);
 }
 function failProgress(message){
  pendingComplete=false;
  for(const [key,value] of partWork)if(value.endsWith('中'))partWork.set(key,'未完成');
  refreshRowWork();
  showBubble('error',existingGeometry?'CAD 加载未完成':'模型未完成',message);
 }
 const partsPanel=options.partsPanel,hiddenParts=new Set();
 const wiringModel=declared?buildAssemblyWiring(design):null;
 let partsSignature='',selectedPart=null,installationView=options.initialMode==='inside',installationBodies=new Set(),installationYaw=-.64,inspectionFrame=[];
 if(partsPanel)partsPanel.innerHTML=`<section class="cc-parts" aria-label="模型部件">
  <div class="cc-parts-head"><h3>模型部件</h3><button type="button" data-cc-show-all disabled>全部显示</button></div>
  <div class="cc-parts-list" data-cc-parts-list>正在读取零件…</div>
  <details class="cc-list-only" data-cc-bom-only hidden><summary>仅清单</summary><div data-cc-other-parts></div></details>
 </section>`;
 let disposed=false,concept=null,parts=[],scene=[],backdrop=[],frameScene=[],motionProgress=[],jointValues=[],shellMeshes=null,geometry=null,activePlan=null,linkConnections=null,mode=installationView?'inside':declared?'closed':'open',yaw=-.64,pitch=.56,zoom=1,drag=null,frame=0,pendingPhase='ready',homePose={yaw,pitch},buildState=declared?'compiling':'legacy',interaction=null,wiring=null,bodyOffsets=new Map();
 function emit(phase,message){
  const busy=phase==='parts'||phase==='enclosure';
  root.dataset.ccState=busy?'loading':phase==='error'?'error':'ready';
  if(phase==='ready'||phase==='view'||phase==='empty')completeProgress();
  try{options.onStatus?.({phase,mode,message,exact:geometry?.exact??false,engine:geometry?.engine??null,instances:concept?.instances.length??0})}catch{}
 }
 function paint(){
  frame=0;if(disposed||!root.isConnected||(!scene.length&&!backdrop.length))return;
  const box=canvas.getBoundingClientRect();if(!box.width||!box.height)return;
  const target=inspectionFrame.length?inspectionFrame:frameScene.length?frameScene:scene;
  const inset=selectedPart!==null ? .22 : .08;
  const camera=fitCamera(target,yaw,pitch,{x:box.width*inset,y:box.height*.15,width:box.width*(1-2*inset),height:box.height*.72});camera.scale*=zoom;raster.draw(scene,camera,backdrop);
  options.onDrawScene?.(scene,backdrop,mode,jointValues);
  drawFloorGrid(canvas,box,camera,concept.bounds?.min[2]||0);
  interaction?.paint(camera,scene,(x,y)=>raster.pick(x,y),mode);
  wiring?.paint(camera,{mode,hiddenParts,selectedPart,depthAt:(x,y)=>raster.depthAt(x,y),scene,backdrop,bodyOffsets,joints:mode==='inside'?activePlan?.joints||[]:[],jointValues});
  if(pendingPhase){emit(pendingPhase,status.textContent);pendingPhase=null}
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(paint)}
 const referenceKinds={specified:'指定型号',candidate:'选型参考',custom:'按图定制',material:'材料参考',included:'随主件附带',provided:'用户自备'};
 function hardwareDetails(row){
  const {reference,files,name}=row;
  if(!reference)return '';
  const sources=reference.items.map(item=>{
   const href=safeUrl(item.url);
   const title=esc(item.name),label=esc(item.label||'实物资料');
   return href?.startsWith('https://')
    ?`<li><a data-cc-source-link href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}<small>${label} ↗</small></a></li>`
    :`<li>${title}</li>`;
  }).join('');
  const downloads=files.map(({index,name:bodyName})=>
   `<button type="button" data-cc-source-stl="${index}" aria-label="下载${esc(bodyName)}的单件 STL">${files.length===1?'单件':esc(bodyName)} STL ↓</button>`
  ).join('');
  return `<details class="cc-hardware" data-cc-hardware-kind="${esc(reference.kind)}"><summary aria-label="${esc(name)}的${referenceKinds[reference.kind]}资料">${referenceKinds[reference.kind]}<span>${files.length?'资料与文件':'查看资料'}</span></summary><div class="cc-hardware-content">${sources?`<ul>${sources}</ul>`:''}${reference.note?`<p>${esc(reference.note)}</p>`:''}${downloads}</div></details>`;
 }
 function renderPartsPanel(available){
  if(!partsPanel)return;
  const list=partsPanel.querySelector('[data-cc-parts-list]'),other=partsPanel.querySelector('[data-cc-bom-only]');
  function partRow(key,name,inView){
   const part=parts[Number(key)];
   const items=concept?.instances.filter(item=>String(item.partIndex)===key)||[];
   const shell=key==='shell'||(!concept?.declared&&part?.role==='enclosure');
   let kind='仅清单';
   if(inView)kind=shell?'概念壳体':partGeometryLabel(part,items);
   else if(items.length||shell)kind=items.length&&items.every(item=>item.placed===false)?'未定位件':'其他视图';
   const ref=part?.hardwareReference;
   const reference=ref&&!part.modelSourceInvalidated&&Object.hasOwn(referenceKinds,ref.kind)&&Array.isArray(ref.items)&&ref.items.every(item=>typeof item?.name==='string')?ref:null;
   const referenceName=reference&&[...new Set(reference.items.map(item=>item.name).filter(Boolean))].join(' / ');
   const model=referenceName||part?.model||part?.metadata?.label||'';
   const files=allowDownloads&&['custom','material'].includes(reference?.kind)?items.filter(item=>Number.isInteger(item.bodyIndex)&&item.exact).map(item=>({index:item.bodyIndex,name:item.name})):[];
   const source=design.parts?.[Number(key)], plan=design.cadPlan;
   const placement=source?.placement==='loose'?'单列配件 · '+source.qty+' 件':source?.placement==='mounted'&&plan?.bodies?'已定位 '+occurrenceGroups(plan,source,Number(key)).groups.size+' / '+source.qty+' 件':'';
   const n=Number(key),neighbors=[...new Set((design.interaction?.connections||[]).flatMap(w=>w.fromPartIndex===n?[w.toPartIndex]:w.toPartIndex===n?[w.fromPartIndex]:[]).map(i=>design.parts?.[i]?.name).filter(Boolean))];
   const method={purchase:'采购成品',custom:'定制制作',provided:'用户自备',material:'采购材料'}[source?.kind];
   return {key,name,kind,model,reference,files,inView,placement,purpose:[part?.purpose,method,neighbors.length?'连接：'+neighbors.join('、'):''].filter(Boolean).join(' · '),provided:part?.kind==='provided'};
  }
  const rows=[...available].map(([key,name])=>partRow(key,name,true));
  const rest=parts.filter(part=>!available.has(String(part.index))).map(part=>partRow(String(part.index),part.name,false));
  const signature=JSON.stringify([rows,rest]);
  if(signature!==partsSignature){
   partsSignature=signature;
   const expanded=new Set([...partsPanel.querySelectorAll('.cc-hardware[open]')].map(details=>details.parentElement.dataset.ccPartRow));
   function rowMarkup(row){
    const {key,name,kind,model,inView,purpose,provided}=row;
    const title=`<span>${esc(name)}${provided?'<small class="cc-part-provided">用户自备</small>':''}${model&&model!==name?`<small class="cc-part-model">${esc(model)}</small>`:''}</span><small>${esc(kind)}${row.placement?`<br>${esc(row.placement)}`:''}</small>`;
    const header=inView
     ?`<input type="checkbox" data-cc-part="${esc(key)}" aria-label="显示${esc(name)}"><button type="button" data-cc-focus-part="${esc(key)}" aria-label="定位${esc(name)}" title="定位${esc(name)}${model?' · '+esc(model):''}">${title}</button><small data-cc-part-work="${esc(key)}"></small>`
     :`<div class="cc-part-readonly">${title}</div>`;
    return `<div class="cc-part-entry" data-cc-part-row="${esc(key)}"><div class="cc-part">${header}</div>${purpose?`<p class="cc-part-purpose" data-cc-part-purpose="${esc(key)}"${inView?' hidden':''}>${esc(purpose)}</p>`:''}${hardwareDetails(row)}</div>`;
   }
   list.innerHTML=rows.length?rows.map(rowMarkup).join(''):'<p>当前视图没有可单独显示的部件。</p>';
   other.hidden=!rest.length;
   other.querySelector('summary').textContent=(rest.every(row=>row.kind==='仅清单')?'仅清单':'其他清单部件')+' · '+rest.length;
   other.querySelector('[data-cc-other-parts]').innerHTML=rest.map(rowMarkup).join('');
   for(const details of partsPanel.querySelectorAll('.cc-hardware')){
    if(expanded.has(details.parentElement.dataset.ccPartRow))details.open=true;
   }
  }
  list.querySelectorAll('input').forEach(input=>{input.checked=!hiddenParts.has(input.dataset.ccPart)});
  list.querySelectorAll('[data-cc-focus-part]').forEach(button=>{
   const key=button.dataset.ccFocusPart;
   button.disabled=hiddenParts.has(key);button.setAttribute('aria-pressed',String(key===selectedPart));
  });
  list.querySelectorAll('[data-cc-part-purpose]').forEach(node=>{node.hidden=node.dataset.ccPartPurpose!==selectedPart;});
  partsPanel.querySelector('[data-cc-show-all]').disabled=!hiddenParts.size;
  refreshRowWork();
 }
 function togglePart(event){
  const key=event.target.dataset.ccPart;
  if(!key)return;
  if(event.target.checked)hiddenParts.delete(key);
  else{hiddenParts.add(key);if(selectedPart===key){selectedPart=null;zoom=1}}
  updateScene();
 }
 function handlePartClick(event){
  const file=event.target.closest('[data-cc-source-stl]');
  if(file){downloadBodyStl(Number(file.dataset.ccSourceStl));return}
  if(event.target.closest('[data-cc-show-all]')){hiddenParts.clear();updateScene();return}
  const button=event.target.closest('[data-cc-focus-part]');
  if(!button||button.disabled)return;
  selectPart(button.dataset.ccFocusPart);
 }
 function selectPart(key){
  selectedPart=selectedPart===key?null:key;
  zoom=1;updateScene();
 }
 partsPanel?.addEventListener('change',togglePart);
 partsPanel?.addEventListener('click',handlePartClick);
 const focusHardware=event=>{
  const index=event.detail?.partIndex;
  if(!Number.isInteger(index)||!concept?.instances.some(item=>item.partIndex===index))return;
  hiddenParts.delete(String(index));selectedPart=String(index);zoom=1;
  mode='inside';installationView=true;yaw=installationYaw;pitch=inspectionPitch;
  updateScene('view');
 };
 container.addEventListener('focus-hardware',focusHardware);
 const focusWiring=event=>{
  if(!wiring)return;
  const index=event.detail?.connectionIndex;
  wiring.enable();wiring.select(Number.isInteger(index)?index:wiring.firstRoute()?.connectionIndex);
  const route=wiring.selectedRoute();if(route)for(const end of [route.from,route.to])hiddenParts.delete(String(end.partIndex));
  mode='inside';setOverview(true);
 };
 container.addEventListener('focus-wiring',focusWiring);
 function updateScene(phase='view'){
  if(!concept)return;scene=[];backdrop=[];frameScene=[];inspectionFrame=[];bodyOffsets=new Map();root.dataset.view=mode;pendingPhase=declared&&buildState==='compiling'?'enclosure':declared&&buildState==='fallback'?'error':phase;
  const available=new Map();
  function visible(key,name){available.set(key,name);return !hiddenParts.has(key)}
  function placeMesh(object,key,show,layer,zone=false,range=[]){
   const selected=key===selectedPart;
   const target=selectedPart===null?layer:selected?scene:backdrop;
   if(show)target.push(object);
   const fit=range.length?range:[object];
   frameScene.push(...fit);
   if(selected)inspectionFrame.push(...fit);
   else if(selectedPart===null&&installationView&&zone)inspectionFrame.push(...fit);
  }
  if(concept.declared){
   // Opaque shell surfaces occlude actual contained hardware in an assembled
   // view. Removing an outer panel can therefore reveal the parts beneath.
   const motions=(mode==='inside'||mode==='closed')?activePlan.motions||[]:[];
   const items=visibleAssemblyInstances(concept,mode,Boolean(partsPanel),motions);
   const closedExterior=mode==='closed'&&!items.some(item=>item.role!=='internal'&&hiddenParts.has(String(item.partIndex)))
    ?new Set(visibleAssemblyInstances(concept,mode,false,motions)):null;
   const shell=mode==='inside'&&items.length?concept.instances.filter(item=>item.placed&&item.kind==='printed'&&item.role!=='internal'):[];
   function place(item,layer){
    const key=String(item.partIndex),enabled=visible(key,parts[item.partIndex].name);
    const show=enabled&&(key===selectedPart||!closedExterior||closedExterior.has(item));
    const offset=mode==='open'?declaredExplosionOffset(item,concept).map((v,k)=>item.positionMm[k]+v):bodyPose(item,motions,motionProgress);
    bodyOffsets.set(item.bodyIndex,offset.map((value,k)=>value-item.positionMm[k]));
    const range=motions.find(motion=>motion.movingBodyIndices.includes(item.bodyIndex));
    for(const mesh of item.prepared){
     const operated=(mode==='closed'||mode==='inside')?interaction?.transform(mesh,offset,item.bodyIndex)||mesh:mesh;
     const animated=(mode==='closed'||mode==='inside')?jointMesh(operated,offset,item.bodyIndex,activePlan.joints||[],jointValues):operated;
     const instance={id:'body-'+item.bodyIndex+'-'+item.partIndex+'-'+item.copy,mesh:animated,offset};
     const endpoints=range?[{mesh,offset:item.positionMm},{mesh,offset:item.positionMm.map((v,k)=>v+range.axis[k]*range.travelMm)}]:[{mesh,offset}];
     const installed=installationBodies.has(item.bodyIndex);
     // Keep the full mechanism in context while exposing the installed modules.
     const contextLayer=installationView&&installationBodies.size&&!installed?backdrop:layer;
     placeMesh(instance,key,show,contextLayer,installed,endpoints);
    }
   }
   shell.forEach(item=>place(item,backdrop));
   items.forEach(item=>place(item,scene));
   const context=root.querySelector('[data-cc-context]');
   const visibleItems=items.filter(item=>!hiddenParts.has(String(item.partIndex)));
   const legendKey=mode+'-'+Number(geometry.exact)+'-'+visibleItems.map(item=>item.bodyIndex).join(',');
   if(context.dataset.view!==legendKey){
    context.dataset.view=legendKey;
    if(mode==='inside'&&visibleItems.length){
     const unique=new Map(visibleItems.map(item=>[item.name,item]));
     const entries=Array.from(unique.values(),item=>{
      const color=item.meshes[0].color||colors[item.partIndex%colors.length];
      return `<li><i style="--piece:rgb(${color.join(',')})"></i>${esc(item.name)}</li>`;
     }).join('');
     context.innerHTML=`<details class="cc-legend"><summary>内部部件 · ${unique.size} ${viewerIcon('chevron')}</summary><ul>${entries}</ul></details>`;
    }else context.textContent=mode==='references'?'这些零件尚未指定安装位置。':'';
   }
   root.querySelectorAll('[data-cc-mechanism]').forEach(card=>{
    const mechanism=(card.dataset.ccMechanism==='joint'?activePlan.joints:activePlan.motions)[Number(card.dataset.index)];
    const canOperate=['closed','inside'].includes(mode)&&[...shell,...visibleItems].some(item=>!hiddenParts.has(String(item.partIndex))&&mechanism.movingBodyIndices.includes(item.bodyIndex));
    card.querySelector('.cc-motion-row').hidden=!canOperate;
    card.querySelector('[data-cc-preview-mechanism]').hidden=canOperate;
   });
  }else if(concept.shell){
   const shell=concept.shell,lift=mode==='open'?Math.max(22,shell.baseHeight*.55):0;
   if(mode!=='inside'){
    const targets=parts.filter(part=>part.role==='enclosure');
    const key=targets.length===1?String(targets[0].index):'shell';
    const show=visible(key,targets.length===1?targets[0].name:'概念外壳');
    const pieces=[{id:'case',mesh:shellMeshes.base},{id:'lid',mesh:shellMeshes.lid,offset:[0,0,shell.baseHeight+lift]}];
    for(const object of pieces)placeMesh(object,key,show,scene);
   }
   for(const instance of concept.instances){
    if(mode==='closed'&&!partsPanel&&instance.role==='internal')continue;
    const key=String(instance.partIndex),show=visible(key,parts[instance.partIndex].name);
    for(const mesh of instance.prepared){
     const object={id:'part-'+instance.partIndex+'-'+instance.copy,mesh,offset:[...instance.positionMm.slice(0,2),instance.positionMm[2]+(instance.role==='panel'?lift:0)]};
     placeMesh(object,key,show,scene,mode==='inside');
    }
   }
  }
  renderPartsPanel(available);
  const empty=root.querySelector('[data-cc-empty]');
  const hasGeometry=scene.length||backdrop.length;
  const focusInfo=root.querySelector('[data-cc-focus-info]');
  focusInfo.hidden=!hasGeometry||!inspectionFrame.length;
  if(!focusInfo.hidden){
   const part=selectedPart!==null?parts[Number(selectedPart)]:null;
   focusInfo.querySelector('[data-cc-focus-name]').textContent=selectedPart!==null?available.get(selectedPart):'硬件安装区';
   const purpose=focusInfo.querySelector('[data-cc-focus-purpose]'),kind=focusInfo.querySelector('[data-cc-focus-kind]');
   purpose.textContent=part?.purpose||'';purpose.hidden=!purpose.textContent;
   kind.textContent=({purchase:'购买件',custom:'定制件',material:'材料',included:'随主件附带',provided:'用户自备'})[part?.kind]||'';kind.hidden=!kind.textContent;
  }
  empty.hidden=!!hasGeometry;
  if(!hasGeometry)empty.textContent=hiddenParts.size&&available.size?'当前视图的部件已隐藏。':mode==='inside'?'尚无已确定安装位置的内部硬件。':'当前视图没有可显示的部件。';
  root.querySelectorAll('[data-cc-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.ccMode===mode)));
  if(!hasGeometry){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);interaction?.paint(null,[],()=>undefined,mode);wiring?.paint(null,{mode,hiddenParts,selectedPart,scene,backdrop,bodyOffsets});emit(['enclosure','error'].includes(pendingPhase)?pendingPhase:phase==='view'?'view':'empty',status.textContent+' '+empty.textContent);pendingPhase=null}else schedule();
 }
 function renderSources(){
  root.querySelector('[data-cc-sources]').innerHTML=parts.map(part=>{
   const bodies=geometry?.bodies.filter(body=>body.partIndex===part.index)||[],usedCatalog=concept.instances.some(item=>item.partIndex===part.index&&item.source==='catalog');
   const supply=bodies.some(body=>body.role==='printed')?'定制结构':bodies.length||usedCatalog?'采购件':'';
   const href=safeUrl((usedCatalog&&part.metadata?.sourceUrl)||part.geometryReference?.sourceUrl||part.dimensionSourceUrl||part.metadata?.sourceUrl||part.sourceUrl);
   const cadLink=safeUrl(part.geometryReference?.cadUrl);
   const note=bodies.length?(usedCatalog?part.geometryNote:part.geometryReference?.detail||(geometry.exact?'结构方案由 '+geometry.engine+' 计算实体。':'结构方案正在计算实体。')):part.geometryNote;
   const placement=declared?(bodies.length?'安装位置来自 AI 声明式方案。':concept.instances.some(item=>item.partIndex===part.index&&!item.placed)?'尚未指定安装位置，可在「未定位件」中查看。':'柔性线材／附件仅在清单记录。'):'';
   return `<div class="cc-source"><div><strong>${esc(part.name)} × ${part.qty}</strong><small>${supply?supply+' · ':''}${esc(roleText[part.role])} · ${sizeText(part.sizeMm)}</small></div><div>${esc(part.model||part.metadata?.label||dataText[part.dimensionSource])}<small>${esc(note)}</small>${placement?`<small>${esc(placement)}</small>`:''}${part.dimensionNote?`<small>${esc(part.dimensionNote)}</small>`:''}${part.metadata?.description?`<small>${esc(part.metadata.description)}</small>`:''}${part.metadata?.license?`<small>许可：${esc(part.metadata.license)}</small>`:''}${href?`<small><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${usedCatalog&&part.metadata?.modelType==='manufacturer-cad'?'原厂 CAD 来源':'尺寸／形体参考资料'}</a></small>`:''}${cadLink?`<small><a href="${esc(cadLink)}" target="_blank" rel="noopener noreferrer">查看供应商 CAD 资源</a> · 本次按尺寸建模</small>`:''}</div></div>`;
  }).join('');
 }
 function renderDownloads(){
  const target=root.querySelector('[data-cc-downloads]');if(!target)return;
  if(concept.declared){
   const assembly=geometry.exact?'<div class="cc-file"><div><strong>整机装配</strong><small>含全部已定位零件，按当前行程导出</small></div><button type="button" data-cc-assembly-stl aria-label="下载整机装配 STL">STL</button></div>':'';
   const pendingMesh=!geometry.exact&&!compileFailed;
   const urdfDetail=pendingMesh?'正在准备零位网格':geometry.exact?'关节树、行程与已确认的零位网格':'包含关节树、行程及已读取的网格';
   const mechanism=activePlan.bodies.length===design.cadPlan.bodies.length&&(activePlan.joints?.length||activePlan.motions?.length)
    ?'<div class="cc-file"><div><strong>运动学 URDF</strong><small>'+urdfDetail+'</small></div><button type="button" data-cc-urdf aria-label="下载运动学 URDF 工程"'+(pendingMesh?' disabled':'')+'>ZIP</button></div>':'';
   const fabrication=geometry.exact&&design.parts.some(p=>p.kind==='custom')?'<div class="cc-file"><div><strong>委托加工包</strong><small>按定制件分组的毫米 STL、数量与加工规格，供厂商核对</small></div><button type="button" data-cc-fabrication>下载 ZIP</button></div>':'';
   target.innerHTML=assembly+mechanism+fabrication+geometry.bodies.map((body,index)=>{
    const item=concept.instances.find(instance=>instance.bodyIndex===index),catalogPart=item?.source==='catalog';
    const label=esc(body.name),role=body.role==='printed'?'结构件':'装配参考';
    const part=parts[body.partIndex],editable=catalogPart&&hasEditableCatalogSource(part.resolvedModelId||part.modelId);
    const packaged=catalogPart&&!!part.metadata?.stepFile;
    const sourceLabel=packaged?'ForgeCAD 工程 .zip':editable?'可编辑模型 .forge.js':wholePartBox(body)?'定位包络 .forge.js':'.forge.js';
    const original=catalogPart&&safeUrl(parts[body.partIndex].metadata?.manufacturerCadUrl);
    const manufacturer=original?`<small><a href="${esc(original)}" target="_blank" rel="noopener noreferrer">原厂 CAD 下载 ↗</a></small>`:'';
    return `<div class="cc-file"><div><strong>${label}</strong><small>${role}</small>${manufacturer}</div><div class="cc-file-actions">${body.exact||catalogPart?`<button type="button" data-cc-body-stl="${index}" aria-label="下载 ${label} 的 ${role} STL">STL</button>`:''}<button type="button" data-cc-body-forge="${index}" aria-label="下载 ${label} 的 ${sourceLabel}">${sourceLabel}</button></div></div>`;
   }).join('');
  }
  else target.innerHTML=concept.shell?'<button type="button" data-cc-download="base">下载概念底壳 STL</button><button type="button" data-cc-download="lid">下载概念上盖 STL</button>':'';
  target.parentElement.hidden=!target.childElementCount;
 }
 function prepareConcept(resetCamera=false){
  if(declared){
   concept=buildDeclaredAssembly(design,parts,geometry);
   const defaultPose=declaredHomeCamera(concept,activePlan.motions),install=installedHardwareView(concept,defaultPose.yaw,wiringModel);
   const keepInstallAngle=installationView&&selectedPart===null&&Math.abs(yaw-installationYaw)<1e-6;
   installationBodies=install.bodies;installationYaw=install.yaw;
   if(keepInstallAngle)yaw=installationYaw;
   for(const item of concept.instances)item.prepared=item.meshes.map(mesh=>prepareMesh(mesh.triangles,mesh.color||colors[item.partIndex%colors.length]));
   if(resetCamera){
    homePose=defaultPose;yaw=installationView?installationYaw:homePose.yaw;pitch=installationView?inspectionPitch:homePose.pitch;
    if(mode==='closed'&&!visibleAssemblyInstances(concept,mode).length){
     mode=visibleAssemblyInstances(concept,'inside').length?'inside':'references';
     installationView=mode==='inside';if(installationView){yaw=installationYaw;pitch=inspectionPitch}
    }
    if(mode==='references'&&!concept.unplacedCount)mode='open';
   }
  }
  else{
   concept=buildConsumerConcept({...design,parts});
   if(concept.shell)shellMeshes={base:prepareMesh(concept.shell.base,[143,170,183]),lid:prepareMesh(concept.shell.lid,[191,208,215])};
   const prepared=new Map();for(const part of parts)if(part.meshes)prepared.set(part.index,part.meshes.map(mesh=>prepareMesh(mesh.triangles,mesh.color||colors[part.index%colors.length])));concept.instances.forEach(instance=>instance.prepared=prepared.get(instance.partIndex)||[]);
   if(resetCamera&&installationView)pitch=inspectionPitch;
  }
  const size=concept.declared?concept.sizeMm:concept.shell?.sizeMm;
  const poseLabel=concept.declared&&activePlan?.motions?.length?'收回时 ':'';
  root.querySelector('[data-cc-size]').textContent=size?poseLabel+sizeText(size):'暂无壳内零件';
  root.querySelector('[data-cc-engine]').textContent=geometry?.exact?geometry.engine:declared?'近似形体预览':'按尺寸排布的概念模型';
  root.querySelector('[data-cc-mode=references]').hidden=!concept.unplacedCount;
  if(concept.declared){
   const motions=activePlan.motions||[];
   const panel=root.querySelector('[data-cc-motion]');
   const joints=activePlan.joints||[];
   panel.innerHTML=(joints.length||motions.length?'<div class="cc-motion-heading"><strong>关节控制</strong><div><button type="button" data-cc-motion-action="stop">停止</button><button type="button" data-cc-motion-action="home">回到初始姿态</button></div></div>':'')+
    motions.map((m,i)=>mechanismCard(activePlan,parts,m,i,false,motionProgress[i]||0,linkConnections)).join('')+
    joints.map((j,i)=>mechanismCard(activePlan,parts,j,i,true,jointValues[i]||0,linkConnections)).join('');
   motions.forEach((_,index)=>updateTravelLabel(index));
  }
  renderSources();renderDownloads();
 }
 function updateTravelLabel(index){
  const input=root.querySelector(`[data-cc-travel="${index}"]`),motion=activePlan.motions[index],value=motionProgress[index]||0;
  const state=value===0?'已缩回':value===1?'已伸出':'伸出';
  const text=state+' '+Number((motion.travelMm*value).toFixed(2))+' / '+motion.travelMm+' mm';
  input.setAttribute('aria-valuetext',text);
  input.parentElement.querySelector('output').textContent=text;
 }
 function assemblyMessage(){
  if(concept.declared){const invalid=design.cadPlan.bodies.length-activePlan.bodies.length;return `${geometry.notice} ${invalid?`${invalid} 个旧形体因型号或尺寸变动已撤下，请重新生成。`:''}${concept.unplacedCount?`${concept.unplacedCount} 个零件可在「未定位件」中查看。`:''}${concept.omittedCount?`${concept.omittedCount} 个线材或附件仅在清单记录。`:''}`}
  return concept.shell?`${concept.instances.length} 个内部／顶面实例已自动排布${concept.external.length?`；${concept.external.reduce((n,part)=>n+part.qty,0)} 个外接附件不计入外壳`:'。'} 默认壁厚 ${concept.defaults.wall} mm，部件间距 ${concept.defaults.gap} mm。`:'当前清单为外接附件，尚无需要包裹的部件。';
 }
 async function buildExact(){
  if(jobBusy||disposed)return;
  jobBusy=true;compileFailed=false;pendingComplete=false;existingGeometry=false;
  buildState='compiling';renderDownloads();emit('enclosure','正在准备 CAD 实体。');
  try{
   const exact=await compileCadPlan(activePlan,{
    partCount:parts.length,engine:options.engine,exampleAsset:options.exampleAsset,savedCadUrl:options.savedCadUrl,baseUrl:options.baseUrl,
    fetcher:options.fetcher,WorkerClass:options.WorkerClass,signal:aborter.signal,onProgress:progress
   });
   if(disposed||!root.isConnected)return;
   progress({stage:'assemble',phase:'request',total:exact.bodies.length});
   geometry=exact;buildState='exact';prepareConcept();status.textContent=assemblyMessage();
   pendingComplete=true;updateScene('ready');
  }catch(error){
   if(disposed||!root.isConnected)return;
   buildState='fallback';compileFailed=true;
   geometry.notice=String(error.message||error)+' 当前保留近似形体。';
   status.textContent=assemblyMessage();renderSources();renderDownloads();failProgress(geometry.notice);updateScene('error');
  }finally{jobBusy=false}
 }
 async function load(){
  try{
   emit('parts','正在读取零件尺寸与来源。');
   parts=await resolveConsumerGeometry(design,{onProgress:progress,signal:aborter.signal});
   if(disposed||!root.isConnected)return;
   emit('enclosure','正在准备装配视图。');
   if(declared){
    activePlan=currentCadPlan(design);
    if(activePlan.joints?.length||activePlan.motions?.length){
     try{linkConnections=mechanismConnections(activePlan)}catch(error){linkConnections={reason:error.message}}
    }
    // Removed/reindexed bodies invalidate interaction references as well as CAD.
    if(activePlan.bodies.length===design.cadPlan.bodies.length){
     interaction=mountCadInteraction(root,design.interaction,{design,onChange:()=>updateScene(),onMotion:(snapshot,elapsed)=>{
      const next=advanceMotionPreview(design.interaction,snapshot,activePlan,{jointValues,motionProgress},elapsed);
      if(!next.changed)return;
      jointValues=next.jointValues;motionProgress=next.motionProgress;
      for(const input of root.querySelectorAll('[data-cc-joint]')){const value=jointValues[Number(input.dataset.ccJoint)]||0;input.value=String(value);input.nextElementSibling.textContent=Number(value.toFixed(1))+'°';}
      for(const input of root.querySelectorAll('[data-cc-travel]')){const index=Number(input.dataset.ccTravel);input.value=String((motionProgress[index]||0)*100);updateTravelLabel(index);}
      updateScene();
     }});
     wiring=mountConsumerWiring(root,wiringModel,{parts:design.parts,onChange:schedule,onFocusPart:partIndex=>focusHardware({detail:{partIndex}})});
    }
    geometry=previewCadPlan(activePlan,parts.length);
    if(!activePlan.bodies.length){
     buildState='fallback';mode='references';geometry.notice='型号或尺寸已变更，请重新生成结构。';
     failProgress(geometry.notice);
    }
   }
   prepareConcept(true);status.textContent=assemblyMessage();
   if(!declared)pendingComplete=true;
   updateScene('ready');
   if(declared&&activePlan.bodies.length)await buildExact();
  }catch(error){
   if(disposed||!root.isConnected)return;
   root.querySelector('[data-cc-size]').textContent='尺寸信息待补充';status.textContent=String(error.message||error);
   root.querySelector('[data-cc-sources]').textContent='补齐有效尺寸或形体信息后会重新计算。';
   renderPartsPanel(new Map());failProgress(status.textContent);emit('error',status.textContent);
  }
 }
 function scale(by){zoom=Math.max(.3,Math.min(5,zoom*by));schedule()}
 function setOverview(installation=false){
  selectedPart=null;installationView=installation;zoom=1;
  yaw=installation?installationYaw:homePose.yaw;pitch=installation?inspectionPitch:homePose.pitch;
  updateScene('view');
 }
 function home(){setOverview(mode==='inside')}
 function download(bytes,name,type){const href=URL.createObjectURL(new Blob([bytes],{type})),anchor=document.createElement('a');anchor.href=href;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(href),1500)}
 function downloadBodyStl(index){
  const body=geometry?.bodies[index],item=concept?.instances.find(instance=>instance.bodyIndex===index);
  if(!body)return;
  const bytes=item&&(body.exact||item.source==='catalog')?encodeSTL(item.meshes.flatMap(mesh=>mesh.triangles),'Formwork reference part in mm'):body.stlBytes;
  if(bytes)download(bytes,cadDownloadName(body.name),'model/stl');
 }
 root.onclick=async e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-cc-preview-mechanism')){
   const card=button.closest('[data-cc-mechanism]');
   const m=(card.dataset.ccMechanism==='joint'?activePlan.joints:activePlan.motions)[Number(card.dataset.index)];
   for(const i of m.movingBodyIndices)hiddenParts.delete(String(activePlan.bodies[i].partIndex));
   const internal=visibleAssemblyInstances(concept,'inside').some(item=>m.movingBodyIndices.includes(item.bodyIndex));
   mode=internal?'inside':'closed';setOverview(internal);card.querySelector('input').focus({preventScroll:true});return;
  }
  if(button.dataset.ccMotionAction||button.dataset.ccJog!==undefined){
   interaction?.cancel();
   if(button.dataset.ccMotionAction==='home'){
    jointValues=(activePlan.joints||[]).map(j=>Math.max(j.minDegrees,Math.min(j.maxDegrees,0)));
    motionProgress=(activePlan.motions||[]).map(()=>0);motionProgress.forEach((_,i)=>updateTravelLabel(i));
   }
   if(button.dataset.ccJog!==undefined){const i=Number(button.dataset.ccJog),j=activePlan.joints[i];jointValues[i]=Math.max(j.minDegrees,Math.min(j.maxDegrees,(jointValues[i]||0)+Number(button.dataset.ccDelta)));}
   for(const input of root.querySelectorAll('[data-cc-joint]')){const value=jointValues[Number(input.dataset.ccJoint)]||0;input.value=String(value);input.nextElementSibling.textContent=Number(value.toFixed(1))+'°';}
   updateScene();return;
  }
  if(button.hasAttribute('data-cc-retry')){if(compileFailed)buildExact();return}
  if(button.hasAttribute('data-cc-reset-focus')){setOverview(mode==='inside');return}
  if(button.dataset.ccMode){mode=button.dataset.ccMode;setOverview(mode==='inside')}
  if(button.dataset.ccCamera==='in')scale(1.2);if(button.dataset.ccCamera==='out')scale(1/1.2);if(button.dataset.ccCamera==='home')home();
  const part=button.dataset.ccDownload;if(part&&concept?.shell)download(encodeSTL(concept.shell[part],'FormBench concept enclosure; mm; no fit or manufacturing validation'),`concept-${part}-${concept.shell.sizeMm.map(n=>Number(n.toFixed(1))).join('x')}-mm.stl`,'model/stl');
  if(button.hasAttribute('data-cc-assembly-stl')&&geometry?.exact)download(assemblyStl(concept,activePlan.motions,motionProgress,activePlan.joints,jointValues),cadDownloadName(design.name+'-assembly'),'model/stl');
  if(button.hasAttribute('data-cc-fabrication')){
   try{const {fabricationZip}=await import('./fabrication-package.js');const bytes=fabricationZip(design,geometry);if(!disposed)download(bytes,'formbench-fabrication.zip','application/zip');}catch(error){if(!disposed)status.textContent=error.message;}return;
  }
  if(button.hasAttribute('data-cc-urdf')){
   button.disabled=true;
   try{
    const {kinematicUrdfZip}=await import('./kinematic-urdf.js');
    const bytes=await kinematicUrdfZip(activePlan,concept.instances,design.name);
    if(!disposed)download(bytes,'formbench-kinematics.zip','application/zip');
   }catch(error){if(!disposed)status.textContent=error.message||'运动学 URDF 导出失败。';}
   finally{button.disabled=false}
  }
  if(button.dataset.ccBodyStl!==undefined)downloadBodyStl(Number(button.dataset.ccBodyStl));
  if(button.dataset.ccBodyForge!==undefined){
   const index=Number(button.dataset.ccBodyForge),body=activePlan?.bodies[index];if(!body)return;
   button.disabled=true;
   try{
    const {editableForgeDownload}=await import('./forge-package.js');
    const {blob,extension}=await editableForgeDownload(activePlan,parts,index);
    if(!disposed)download(blob,cadDownloadName(body.name,extension.slice(1)),blob.type);
   }catch(error){if(!disposed)status.textContent=error.message||'零件模型下载失败。'}
   finally{button.disabled=false}
  }
 };
 root.oninput=e=>{
  if(e.target.dataset.ccJoint!==undefined){const index=Number(e.target.dataset.ccJoint);jointValues[index]=Number(e.target.value);e.target.nextElementSibling.textContent=jointValues[index]+'°';updateScene();return;}
  if(e.target.dataset.ccTravel===undefined)return;
  const index=Number(e.target.dataset.ccTravel);
  motionProgress[index]=Number(e.target.value)/100;
  updateTravelLabel(index);
  updateScene();
 };
 canvas.onpointerdown=e=>{if(!interaction?.pointerDown(e))drag=[e.clientX,e.clientY,yaw,pitch];canvas.setPointerCapture(e.pointerId)};
 canvas.onpointermove=e=>{if(interaction?.pointerMove(e))return;if(!drag)return;if(Math.hypot(e.clientX-drag[0],e.clientY-drag[1])>4)drag[4]=true;if(!drag[4])return;yaw=drag[2]+(e.clientX-drag[0])*.012;pitch=Math.max(-1.5,Math.min(1.5,drag[3]+(e.clientY-drag[1])*.012));schedule()};
 canvas.onpointerup=e=>{
  interaction?.pointerUp(e);
  const clicked=drag&&!drag[4]&&Math.hypot(e.clientX-drag[0],e.clientY-drag[1])<=4;drag=null;
  if(!clicked)return;
  const box=canvas.getBoundingClientRect(),id=raster.pick(e.clientX-box.left,e.clientY-box.top);
  const match=/^body-\d+-(\d+)-/.exec(id||'')||/^part-(\d+)-/.exec(id||'');
  if(match)selectPart(match[1]);
  else if(id==='case'||id==='lid'){
   const shells=parts.filter(part=>part.role==='enclosure');selectPart(shells.length===1?String(shells[0].index):'shell');
  }
 };
 canvas.onpointercancel=e=>{interaction?.pointerUp(e,true);drag=null};
 const wheel=e=>{e.preventDefault();scale(Math.exp(-e.deltaY*.0018))};canvas.addEventListener('wheel',wheel,{passive:false});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=Math.min(1.5,pitch+.12);if(e.key==='ArrowDown')pitch=Math.max(-1.5,pitch-.12);if(e.key==='+'||e.key==='=')scale(1.2);if(e.key==='-')scale(1/1.2);if(e.key==='0')home();schedule()};
 const observer=new ResizeObserver(schedule);observer.observe(canvas);load();
 return ()=>{disposed=true;interaction?.dispose();wiring?.dispose();aborter.abort();clearTimeout(confirmationTimer);partAnimation?.cancel();observer.disconnect();cancelAnimationFrame(frame);canvas.removeEventListener('wheel',wheel);container.removeEventListener('focus-hardware',focusHardware);container.removeEventListener('focus-wiring',focusWiring);partsPanel?.removeEventListener('change',togglePart);partsPanel?.removeEventListener('click',handlePartClick);partsPanel?.replaceChildren();root.oninput=root.onclick=null;canvas.onpointerdown=canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=canvas.onkeydown=null;scene=[]};
}
