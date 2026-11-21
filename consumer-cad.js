import {catalog,loadPartMeshes,getHardwareMetadata,encodeSTL} from './assembly-hardware.js';
import {makeDocumentedProxy} from './part-geometry.js';
import {prepareMesh,createRaster,fitCamera} from './mesh-renderer.js';
import {previewCadPlan,compileCadPlan,meshBounds,cadBodyToForgeScript,cadDownloadName} from './consumer-geometry.js';
import {validateCadPlan} from './cad-plan.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sizeText=size=>size.map(n=>Number(n.toFixed(1))).join(' × ')+' mm';
const validSize=size=>Array.isArray(size)&&size.length===3&&size.every(n=>Number.isFinite(n)&&n>=.1&&n<=2000);
const colors=[[66,139,131],[194,133,76],[82,132,175],[167,117,154],[145,160,86]];
const roleText={internal:'内部',panel:'顶面位置示意',external:'外接附件',enclosure:'外壳目标包络'};
const dataText={catalog:'资料几何',specified:'指定设计包络',estimated:'估算设计包络'};
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
 let count=0;
 return design.parts.map((part,index)=>{
  if(!validSize(part.sizeMm))throw Error(`「${part.name||index+1}」需要 0.1–2000 mm 的长、宽、高。`);
  if(part.shape!==undefined&&!['box','cylinder'].includes(part.shape))throw Error(`「${part.name||index+1}」的参考形状须为长方体或圆柱。`);
  if(part.shape==='cylinder'&&Math.abs(part.sizeMm[0]-part.sizeMm[1])>1e-8)throw Error(`「${part.name||index+1}」为圆柱，长与宽须填写同一个直径。`);
  if(!Number.isInteger(part.qty)||part.qty<1||(count+=part.qty)>160)throw Error('零件数量须为正整数，整机最多预览 160 个实例。');
  const dimensionSource=Object.hasOwn(dataText,part.dimensionSource)?part.dimensionSource:'estimated';
  return {...part,index,sizeMm:[...part.sizeMm],role:roleOf(part),dimensionSource};
 });
}

// Shelf packing is recomputed from envelopes and quantities; no part has a fixed
// Pico-specific coordinate. External cables are deliberately outside this pack.
function pack(parts,gap){
 const instances=parts.flatMap(part=>Array.from({length:part.qty},(_,copy)=>({partIndex:part.index,copy,sizeMm:part.sizeMm,role:part.role})));
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
export async function resolveConsumerGeometry(design){
 const normalized=normalizedParts(design),parts=[];
 for(const part of normalized){
  // A missing modelId can be an intentional result of changing the purchase.
  // Never reconstruct that identity from a familiar BOM name.
  const id=!part.modelSourceInvalidated&&Object.hasOwn(catalog,part.modelId||'')?part.modelId:null;
  const planned=design.cadPlan?.bodies?.some(body=>body.partIndex===part.index);
  let meshes,metadata=null,actualSize=null,geometryNote='';
  if(id){
   try{
    metadata=await getHardwareMetadata(id);
    if(part.dimensionSource==='catalog'&&!part.shape&&(planned||part.role!=='external')&&part.role!=='enclosure'){
     const raw=await loadPartMeshes(id),bounds=boundsOf(raw);
     if(bounds.size.every((n,k)=>Math.abs(n-part.sizeMm[k])<=.01)){
      actualSize=bounds.size;
      meshes=raw.map(mesh=>({...mesh,triangles:mesh.triangles.map(face=>face.map(p=>p.map((n,k)=>n-bounds.min[k])))}));
      geometryNote=metadata.modelType==='dimensioned-approximation'?'据资料绘制的近似参考模型，未缩放；器件高度等估计细节见来源说明':'资料模型原始尺寸，未缩放';
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
  parts.push({...part,sizeMm:[...part.sizeMm],dimensionSource:actualSize?'catalog':meshes&&part.dimensionSource==='catalog'?'specified':part.dimensionSource,meshes,metadata,geometryKind:actualSize?'catalog':'envelope',geometryNote});
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
 const instances=[],counts=new Map();
 for(let index=0;index<geometry.bodies.length;index++){
  const body=geometry.bodies[index],part=parts[body.partIndex];
  if(!part)throw Error('形体引用了不存在的零件。');
  if(part.modelSourceInvalidated)continue;
  counts.set(part.index,(counts.get(part.index)||0)+1);
  let meshes=body.meshes,source='generated';
  if(body.role==='reference'&&part.geometryKind==='catalog'&&part.meshes?.length){
   const box=meshBounds(body.meshes),center=box.min.map((v,k)=>(v+box.max[k])/2);
   meshes=shiftedMeshes(part.meshes,center.map((n,k)=>n-part.sizeMm[k]/2));source='catalog';
  }
  instances.push({partIndex:part.index,bodyIndex:index,copy:counts.get(part.index)-1,role:part.role,kind:body.role,name:body.name,positionMm:[...body.positionMm],meshes,source,exact:source==='catalog'||geometry.exact,placed:true});
 }
 const box=instances.length?meshBounds(instances.flatMap(item=>shiftedMeshes(item.meshes,item.positionMm))):{min:[0,0,0],max:[0,0,0],sizeMm:[0,0,0]};
 const unplaced=[];let unplacedCount=0,omittedCount=0;
 for(const part of parts){
  const remaining=Math.max(0,part.qty-(counts.get(part.index)||0));
  if(!part.meshes?.length||looseMaterial(part)){omittedCount+=remaining;continue}
  if(remaining)unplaced.push({...part,qty:remaining});
 }
 for(const item of pack(unplaced,6).instances){const part=parts[item.partIndex];instances.push({...item,kind:'reference',name:part.name,positionMm:[box.max[0]+20+item.positionMm[0],box.min[1]+item.positionMm[1],box.min[2]],meshes:part.meshes,source:part.geometryKind,exact:part.geometryKind==='catalog',placed:false});unplacedCount++}
 return {declared:true,parts,instances,bounds:box,sizeMm:box.sizeMm,unplacedCount,omittedCount,shell:null};
}

const style=`.cc{border:1px solid #d0dcde;border-radius:17px;overflow:hidden;background:#f9fbfc;color:#283f48}.cc-header{padding:20px 24px;display:flex;gap:20px;align-items:center;justify-content:space-between}.cc-header h3{margin:3px 0;font-size:20px;letter-spacing:-.6px}.cc-eyebrow{font:600 10px ui-monospace,monospace;letter-spacing:1.5px;color:#658692}.cc-size{font:600 15px ui-monospace,monospace;white-space:nowrap;color:#365e70}.cc-stage{position:relative;background:radial-gradient(circle at 1px 1px,#c9d8de .7px,transparent 1px) 0 0/22px 22px,#edf3f5;border-block:1px solid #dae4e8}.cc-stage canvas{width:100%;height:clamp(320px,46vh,510px);display:block;touch-action:none;cursor:grab}.cc-stage canvas:active{cursor:grabbing}.cc-tabs,.cc-camera{position:absolute;display:flex;gap:4px;padding:4px;border:1px solid #cfdee3;border-radius:10px;background:#ffffffed;z-index:1}.cc-tabs{top:14px;left:14px}.cc-camera{right:14px;bottom:14px}.cc button{font:inherit;cursor:pointer}.cc-tabs button,.cc-camera button{border:0;border-radius:7px;padding:7px 12px;background:transparent;color:#536d78;font-size:12px}.cc-tabs button[aria-pressed=true]{background:#2b596f;color:white}.cc-hint{position:absolute;left:17px;bottom:18px;color:#718b97;font-size:11px;pointer-events:none}.cc-footer{padding:17px 23px;display:grid;gap:12px;font-size:12px}.cc-footer p{margin:0;color:#647c88;line-height:1.7}.cc-status{color:#365c6b!important}.cc-sources{border-top:1px solid #dce6e9;padding-top:11px}.cc-sources summary{cursor:pointer;font-weight:600;color:#476b7a}.cc-source-list{display:grid;gap:9px;margin-top:13px}.cc-source{display:grid;grid-template-columns:minmax(100px,1.1fr) minmax(0,2fr);gap:12px;padding:10px 12px;background:#eef4f6;border-radius:7px}.cc-source strong{display:block;font-size:12px}.cc-source small{display:block;font-size:10px;color:#708995;margin-top:3px;overflow-wrap:anywhere}.cc-source a{color:#376f88}.cc-downloads{display:flex;gap:8px;flex-wrap:wrap}.cc-downloads button{border:1px solid #bfd1da;background:white;color:#426778;border-radius:7px;padding:8px 12px;font-size:11px}.cc button:disabled{opacity:.5;cursor:default}.cc button:focus-visible,.cc canvas:focus-visible{outline:3px solid #87b4cb;outline-offset:2px}@media(max-width:650px){.cc-header{padding:16px;align-items:flex-start;flex-direction:column;gap:6px}.cc-header h3{font-size:18px}.cc-footer{padding:14px 16px}.cc-source{grid-template-columns:1fr;gap:4px}.cc-tabs{left:10px;top:10px}.cc-tabs button{padding:6px 9px}.cc-hint{display:none}.cc-stage canvas{height:330px}}`;

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

export function visibleAssemblyInstances(concept,mode){
 return concept.instances.filter(item=>{
  if(mode==='references')return !item.placed;
  if(!item.placed)return false;
  if(mode==='inside')return item.role==='internal'||(item.kind==='reference'&&item.role==='panel');
  if(mode==='closed')return item.role!=='internal';
  return true;
 });
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

const controlStyle=`
.cc-motion{display:grid;gap:8px}
.cc-motion label{display:grid;grid-template-columns:auto minmax(100px,1fr) auto;gap:12px;align-items:center;color:#365c6b}
.cc-motion input{width:100%;accent-color:#2b596f}
.cc-motion output{min-width:88px;text-align:right;font-variant-numeric:tabular-nums}
.cc-context:empty,.cc-motion:empty,.cc-files[hidden]{display:none}
.cc-files[open] .cc-downloads{margin-top:9px}
.cc-empty{position:absolute;inset:24% 10%;display:grid;place-content:center;text-align:center;color:#506b78;pointer-events:none}
.cc-empty[hidden],.cc-tabs button[hidden],.cc-motion label[hidden]{display:none}
@media(max-width:650px){.cc-motion label{grid-template-columns:1fr auto}.cc-motion input{grid-row:2;grid-column:1/-1}}
`;

export function mountConsumerCad(container,design,options={}){
 if(!container)return ()=>{};
 const allowDownloads=options.downloads!==false,declared=!!design.cadPlan?.bodies?.length;
 container.innerHTML=`<style>${style}${controlStyle}</style><section class="cc"><header class="cc-header"><div><span class="cc-eyebrow" data-cc-engine>FORM / CONCEPT</span><h3>${esc(design?.name||'整机概念')}</h3></div><span class="cc-size" data-cc-size>正在整理尺寸…</span></header><div class="cc-stage"><canvas tabindex="0" aria-label="整机概念：拖动或方向键旋转，滚轮或加减键缩放"></canvas><div class="cc-tabs" aria-label="整机视图"><button type="button" data-cc-mode="closed">外观</button><button type="button" data-cc-mode="open">${declared?'分解':'开盖'}</button><button type="button" data-cc-mode="inside">内部布局</button><button type="button" data-cc-mode="references" hidden>未定位件</button></div><span class="cc-empty" data-cc-empty hidden></span><div class="cc-camera"><button type="button" data-cc-camera="out" aria-label="缩小">−</button><button type="button" data-cc-camera="in" aria-label="放大">＋</button><button type="button" data-cc-camera="home">归位</button></div><span class="cc-hint">拖动旋转 · 滚轮缩放 · 同一毫米比例</span></div><div class="cc-footer"><div class="cc-motion" data-cc-motion></div><p class="cc-context" data-cc-context></p><p class="cc-status" data-cc-status role="status">根据部件尺寸整理形体与布局…</p><p data-cc-note>${declared?'AI 声明式结构表达设计意图；材料、壁厚、装配间隙和强度仍需验证。':'这是尺寸驱动的整机概念。壳体开孔、固定结构和电气连接尚未设计；顶面件仅示意交互位置。'}</p>${allowDownloads?'<details class="cc-sources cc-files" data-cc-files hidden><summary>零件 CAD 文件</summary><div class="cc-downloads" data-cc-downloads></div></details>':''}<details class="cc-sources"><summary>尺寸、形体与安装位置依据</summary><div class="cc-source-list" data-cc-sources>正在读取…</div></details></div></section>`;
 const root=container.querySelector('.cc'),canvas=root.querySelector('canvas'),status=root.querySelector('[data-cc-status]'),raster=createRaster(canvas),aborter=new AbortController();
 let disposed=false,concept=null,parts=[],scene=[],backdrop=[],frameScene=[],motionProgress=[],shellMeshes=null,geometry=null,activePlan=null,mode=declared?'closed':'open',yaw=-.64,pitch=.56,zoom=1,drag=null,frame=0,pendingPhase='ready',homePose={yaw,pitch},buildState=declared?'compiling':'legacy';
 function emit(phase,message){try{options.onStatus?.({phase,mode,message,exact:geometry?.exact??false,engine:geometry?.engine??null,instances:concept?.instances.length??0})}catch{}}
 function paint(){
  frame=0;if(disposed||!root.isConnected||!scene.length)return;
  const box=canvas.getBoundingClientRect();if(!box.width||!box.height)return;
  const camera=fitCamera(frameScene.length?frameScene:scene,yaw,pitch,{x:box.width*.09,y:box.height*.16,width:box.width*.82,height:box.height*.68});camera.scale*=zoom;raster.draw(scene,camera,backdrop);
  if(pendingPhase){emit(pendingPhase,status.textContent);pendingPhase=null}
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(paint)}
 function updateScene(phase='view'){
  if(!concept)return;scene=[];backdrop=[];frameScene=[];pendingPhase=declared&&buildState==='compiling'?'enclosure':declared&&buildState==='fallback'?'error':phase;
  if(concept.declared){
   const items=visibleAssemblyInstances(concept,mode);
   const motions=(mode==='inside'||mode==='closed')?activePlan.motions||[]:[];
   const shell=mode==='inside'&&items.length?concept.instances.filter(item=>item.placed&&item.kind==='printed'&&item.role!=='internal'):[];
   function place(item,layer){
    const offset=mode==='open'?declaredExplosionOffset(item,concept).map((v,k)=>item.positionMm[k]+v):bodyPose(item,motions,motionProgress);
    const range=motions.find(motion=>motion.movingBodyIndices.includes(item.bodyIndex));
    for(const mesh of item.prepared){
     const instance={id:'body-'+item.bodyIndex+'-'+item.partIndex+'-'+item.copy,mesh,offset};
     layer.push(instance);
     if(range){
      frameScene.push({mesh,offset:item.positionMm},{mesh,offset:item.positionMm.map((v,k)=>v+range.axis[k]*range.travelMm)});
     }else frameScene.push(instance);
    }
   }
   shell.forEach(item=>place(item,backdrop));
   items.forEach(item=>place(item,scene));
   const context=root.querySelector('[data-cc-context]');
   const interiorLabel=backdrop.length?'外部结构已淡化，内部按安装坐标显示 ':'按安装坐标显示 ';
   context.textContent=mode==='inside'&&items.length?interiorLabel+[...new Set(items.map(item=>item.name))].join('、')+'。':mode==='references'?'这些零件按尺寸独立展示，尚未确定安装位置。':'';
   root.querySelectorAll('[data-cc-motion] label').forEach((label,index)=>{
    label.hidden=!motions[index]||![...shell,...items].some(item=>motions[index].movingBodyIndices.includes(item.bodyIndex));
   });
  }else if(concept.shell){
   const shell=concept.shell,lift=mode==='open'?Math.max(22,shell.baseHeight*.55):0;
   if(mode!=='inside'){scene.push({id:'case',mesh:shellMeshes.base});scene.push({id:'lid',mesh:shellMeshes.lid,offset:[0,0,shell.baseHeight+lift]})}
   for(const instance of concept.instances){if(mode==='closed'&&instance.role==='internal')continue;for(const mesh of instance.prepared)scene.push({id:'part-'+instance.partIndex+'-'+instance.copy,mesh,offset:[...instance.positionMm.slice(0,2),instance.positionMm[2]+(instance.role==='panel'?lift:0)]})}
  }
  const empty=root.querySelector('[data-cc-empty]');
  empty.hidden=!!scene.length;
  if(!scene.length)empty.textContent=mode==='inside'?'尚无已确定安装位置的内部硬件。':'当前视图没有可显示的部件。';
  root.querySelectorAll('[data-cc-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.ccMode===mode)));
  if(!scene.length){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);emit(['enclosure','error'].includes(pendingPhase)?pendingPhase:phase==='view'?'view':'empty',status.textContent+' 当前视图没有可显示的部件。');pendingPhase=null}else schedule();
 }
 function renderSources(){
  root.querySelector('[data-cc-sources]').innerHTML=parts.map(part=>{
   const bodies=geometry?.bodies.filter(body=>body.partIndex===part.index)||[],href=safeUrl(part.metadata?.sourceUrl||part.dimensionSourceUrl||part.sourceUrl),usedCatalog=concept.instances.some(item=>item.partIndex===part.index&&item.source==='catalog');
   const note=bodies.length?(usedCatalog?part.geometryNote:geometry.exact?'AI 声明式形体，经 '+geometry.engine+' 计算实体；不代表原厂 CAD':'AI 声明式形体预览；实体布尔计算尚未完成'):part.geometryNote;
   const placement=declared?(bodies.length?'安装位置来自 AI 声明式方案。':concept.instances.some(item=>item.partIndex===part.index&&!item.placed)?'尚未指定安装位置，可在「未定位件」中查看。':'柔性线材／附件仅在清单记录。'):'';
   return `<div class="cc-source"><div><strong>${esc(part.name)} × ${part.qty}</strong><small>${esc(roleText[part.role])} · ${sizeText(part.sizeMm)}</small></div><div>${esc(part.model||part.metadata?.label||dataText[part.dimensionSource])}<small>${esc(note)}</small>${placement?`<small>${esc(placement)}</small>`:''}${part.dimensionNote?`<small>${esc(part.dimensionNote)}</small>`:''}${part.metadata?.description?`<small>${esc(part.metadata.description)}</small>`:''}${part.metadata?.license?`<small>许可：${esc(part.metadata.license)}</small>`:''}${href?`<small><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${part.metadata?.modelType==='manufacturer-cad'?'CAD 来源':'尺寸／形体参考资料'}</a></small>`:''}</div></div>`;
  }).join('');
 }
 function renderDownloads(){
  const target=root.querySelector('[data-cc-downloads]');if(!target)return;
  if(concept.declared){target.innerHTML=geometry.bodies.map((body,index)=>`<span>${body.exact?`<button type="button" data-cc-body-stl="${index}">${esc(body.name)} · ${body.role==='printed'?'结构件':'装配参考'} STL</button>`:''}<button type="button" data-cc-body-forge="${index}">${esc(body.name)} · ForgeCAD 源文件</button></span>`).join('')}
  else target.innerHTML=concept.shell?'<button type="button" data-cc-download="base">下载概念底壳 STL</button><button type="button" data-cc-download="lid">下载概念上盖 STL</button>':'';
  target.parentElement.hidden=!target.childElementCount;
 }
 function prepareConcept(resetCamera=false){
  if(declared){
   concept=buildDeclaredAssembly(design,parts,geometry);
   for(const item of concept.instances)item.prepared=item.meshes.map(mesh=>prepareMesh(mesh.triangles,mesh.color||colors[item.partIndex%colors.length]));
   if(resetCamera){
    homePose=declaredHomeCamera(concept,activePlan.motions);yaw=homePose.yaw;pitch=homePose.pitch;
    if(mode==='closed'&&!visibleAssemblyInstances(concept,mode).length)mode=visibleAssemblyInstances(concept,'inside').length?'inside':'references';
    if(mode==='references'&&!concept.unplacedCount)mode='open';
   }
  }
  else{
   concept=buildConsumerConcept({...design,parts});
   if(concept.shell)shellMeshes={base:prepareMesh(concept.shell.base,[143,170,183]),lid:prepareMesh(concept.shell.lid,[191,208,215])};
   const prepared=new Map();for(const part of parts)if(part.meshes)prepared.set(part.index,part.meshes.map(mesh=>prepareMesh(mesh.triangles,mesh.color||colors[part.index%colors.length])));concept.instances.forEach(instance=>instance.prepared=prepared.get(instance.partIndex)||[]);
  }
  const size=concept.declared?concept.sizeMm:concept.shell?.sizeMm;root.querySelector('[data-cc-size]').textContent=size?sizeText(size):'暂无壳内零件';
  root.querySelector('[data-cc-engine]').textContent=geometry?.exact?'SOLID / '+geometry.engine:declared?'FORM / PREVIEW':'FORM / CONCEPT';
  root.querySelector('[data-cc-mode=references]').hidden=!concept.unplacedCount;
  if(concept.declared){
   const motions=activePlan.motions||[];
   const panel=root.querySelector('[data-cc-motion]');
   panel.innerHTML=motions.map((motion,index)=>{
    const value=motionProgress[index]||0;
    return `<label><span>${esc(motion.name)}</span><input type="range" min="0" max="100" value="${Math.round(value*100)}" data-cc-travel="${index}" aria-label="${esc(motion.name)}行程"><output></output></label>`;
   }).join('');
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
 async function load(){
  try{
   emit('parts','正在读取零件尺寸与来源。');parts=await resolveConsumerGeometry(design);if(disposed||!root.isConnected)return;
   emit('enclosure',declared?'正在生成声明式形体。':'正在计算外壳与内部布局。');
   if(declared){
    activePlan=currentCadPlan(design);
    geometry=previewCadPlan(activePlan,parts.length);
    if(!activePlan.bodies.length){buildState='fallback';mode='references';geometry.notice='当前仅显示修改后的尺寸包络。'}
   }
   prepareConcept(true);status.textContent=assemblyMessage();updateScene('ready');
   if(declared&&activePlan.bodies.length){
    emit('enclosure','正在生成内外部件的实体与切削特征。');
    try{
     const exact=await compileCadPlan(activePlan,{partCount:parts.length,engine:options.engine,exampleAsset:options.exampleAsset,baseUrl:options.baseUrl,fetcher:options.fetcher,WorkerClass:options.WorkerClass,signal:aborter.signal});
     if(disposed||!root.isConnected)return;geometry=exact;buildState='exact';prepareConcept();status.textContent=assemblyMessage();updateScene('ready');
    }catch(error){if(disposed||!root.isConnected)return;buildState='fallback';geometry.notice=String(error.message||error)+' 当前显示近似形体，未完成实体布尔，不能导出实体 STL。';status.textContent=assemblyMessage();renderSources();updateScene('error')}
   }
  }catch(error){if(disposed||!root.isConnected)return;root.querySelector('[data-cc-size]').textContent='尺寸信息待补充';status.textContent=String(error.message||error);root.querySelector('[data-cc-sources]').textContent='补齐有效尺寸或形体信息后会重新计算。';emit('error',status.textContent)}
 }
 function scale(by){zoom=Math.max(.3,Math.min(5,zoom*by));schedule()}
 function home(){yaw=homePose.yaw;pitch=homePose.pitch;zoom=1;schedule()}
 function download(bytes,name,type){const href=URL.createObjectURL(new Blob([bytes],{type})),anchor=document.createElement('a');anchor.href=href;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(href),1500)}
 root.onclick=e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.ccMode){mode=button.dataset.ccMode;zoom=1;updateScene('view')}
  if(button.dataset.ccCamera==='in')scale(1.2);if(button.dataset.ccCamera==='out')scale(1/1.2);if(button.dataset.ccCamera==='home')home();
  const part=button.dataset.ccDownload;if(part&&concept?.shell)download(encodeSTL(concept.shell[part],'FormBench concept enclosure; mm; no fit or manufacturing validation'),`concept-${part}-${concept.shell.sizeMm.map(n=>Number(n.toFixed(1))).join('x')}-mm.stl`,'model/stl');
  if(button.dataset.ccBodyStl!==undefined){const body=geometry?.bodies[Number(button.dataset.ccBodyStl)];if(body?.exact&&body.stlBytes)download(body.stlBytes,cadDownloadName(body.name),'model/stl')}
  if(button.dataset.ccBodyForge!==undefined){const body=activePlan?.bodies[Number(button.dataset.ccBodyForge)];if(body)download(cadBodyToForgeScript(body),cadDownloadName(body.name,'forge.js'),'text/javascript')}
 };
 root.oninput=e=>{
  if(e.target.dataset.ccTravel===undefined)return;
  const index=Number(e.target.dataset.ccTravel);
  motionProgress[index]=Number(e.target.value)/100;
  updateTravelLabel(index);
  updateScene();
 };
 canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY,yaw,pitch];canvas.setPointerCapture(e.pointerId)};
 canvas.onpointermove=e=>{if(!drag)return;yaw=drag[2]+(e.clientX-drag[0])*.012;pitch=Math.max(-1.5,Math.min(1.5,drag[3]+(e.clientY-drag[1])*.012));schedule()};canvas.onpointerup=canvas.onpointercancel=()=>{drag=null};
 const wheel=e=>{e.preventDefault();scale(Math.exp(-e.deltaY*.0018))};canvas.addEventListener('wheel',wheel,{passive:false});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=Math.min(1.5,pitch+.12);if(e.key==='ArrowDown')pitch=Math.max(-1.5,pitch-.12);if(e.key==='+'||e.key==='=')scale(1.2);if(e.key==='-')scale(1/1.2);if(e.key==='0')home();schedule()};
 const observer=new ResizeObserver(schedule);observer.observe(canvas);load();
 return ()=>{disposed=true;aborter.abort();observer.disconnect();cancelAnimationFrame(frame);canvas.removeEventListener('wheel',wheel);root.oninput=root.onclick=null;canvas.onpointerdown=canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=canvas.onkeydown=null;scene=[]};
}
