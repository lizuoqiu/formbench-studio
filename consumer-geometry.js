import {validateCadPlan} from './cad-plan.js';
import {decodeSTL} from './assembly-hardware.js';
import {makeDocumentedProxy} from './part-geometry.js';

const solidColors=[[167,193,204],[225,166,115],[112,165,155],[164,143,185]];
const localHosts=new Set(['127.0.0.1','localhost','[::1]']);
const meshCache=new Map();

export function meshBounds(meshes){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(const mesh of meshes)for(const face of mesh.triangles)for(const point of face)for(let k=0;k<3;k++){
  if(!Number.isFinite(point[k]))throw Error('几何包含无效坐标。');
  min[k]=Math.min(min[k],point[k]);max[k]=Math.max(max[k],point[k]);
 }
 if(!min.every(Number.isFinite))throw Error('几何没有可显示的表面。');
 return {min,max,sizeMm:max.map((n,k)=>n-min[k])};
}

// Preview tessellation only. The real solid union/subtraction happens in the
// local Manifold service; intersecting preview surfaces are never sold as CAD.
function ellipsoid(size,center){
 const faces=[],segments=32,rings=16;
 const at=(i,j)=>{const theta=Math.PI*i/rings,phi=2*Math.PI*j/segments;return [size[0]/2*Math.sin(theta)*Math.cos(phi)+center[0],size[1]/2*Math.sin(theta)*Math.sin(phi)+center[1],size[2]/2*Math.cos(theta)+center[2]]};
 const top=[center[0],center[1],center[2]+size[2]/2],bottom=[center[0],center[1],center[2]-size[2]/2];
 for(let j=0;j<segments;j++){
  faces.push([top,at(1,j),at(1,j+1)],[at(rings-1,j),bottom,at(rings-1,j+1)]);
  for(let i=1;i<rings-1;i++){const a=at(i,j),b=at(i+1,j),c=at(i+1,j+1),d=at(i,j+1);faces.push([a,b,c],[a,c,d])}
 }
 return faces;
}
function previewFeature(feature){
 const faces=feature.shape==='ellipsoid'?ellipsoid(feature.sizeMm,[0,0,0]):makeDocumentedProxy({shape:feature.shape,sizeMm:feature.sizeMm}).meshes.flatMap(mesh=>mesh.triangles.map(face=>face.map(point=>point.map((n,k)=>n-feature.sizeMm[k]/2))));
 const angles=(feature.rotationDeg||[0,0,0]).map(n=>n*Math.PI/180),c=angles.map(Math.cos),s=angles.map(Math.sin);
 return faces.map(face=>face.map(([x,y,z])=>{[y,z]=[y*c[0]-z*s[0],y*s[0]+z*c[0]];[x,z]=[x*c[1]+z*s[1],-x*s[1]+z*c[1]];[x,y]=[x*c[2]-y*s[2],x*s[2]+y*c[2]];return [x,y,z].map((n,k)=>n+feature.centerMm[k])}));
}
export function previewCadPlan(raw,partCount=60){
 const plan=validateCadPlan(raw,partCount);
 return {engine:null,exact:false,notice:'形体预览，尚未执行实体布尔计算；切削特征未显示。',bodies:plan.bodies.map((body,index)=>({
  ...body,exact:false,meshes:body.features.filter(feature=>feature.op==='add').map(feature=>({triangles:previewFeature(feature),color:solidColors[index%solidColors.length],label:body.name})),
  hasCuts:body.features.some(feature=>feature.op==='cut')
 }))};
}

function bytesFromBase64(text){
 if(typeof text!=='string'||text.length>28_000_000)throw Error('实体文件缺失或过大。');
 const binary=atob(text),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 if(bytes.byteLength<84||bytes.byteLength>20_000_000)throw Error('实体文件大小无效。');
 const view=new DataView(bytes.buffer),count=view.getUint32(80,true);
 if(!count||count>250_000||84+count*50!==bytes.length)throw Error('实体网格格式无效。');
 return bytes;
}
export async function compileCadPlan(raw,options={}){
 const plan=validateCadPlan(raw,options.partCount??60),base=options.baseUrl??globalThis.location?.href;
 let url;try{url=new URL('./api/forge/plan',base)}catch{}
 const key=JSON.stringify(plan);
 if(meshCache.has(key))return meshCache.get(key);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90_000);
 const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
 if(options.signal?.aborted)controller.abort();
 try{
  let data;
  if(url&&localHosts.has(url.hostname)){
   try{
    const response=await(options.fetcher??globalThis.fetch)(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal,body:JSON.stringify({cadPlan:plan})});
    data=await response.json().catch(()=>null);
    if(!response.ok){const error=Error(typeof data?.error==='string'?data.error:'本机实体计算没有完成。');error.business=![404,429,503].includes(response.status);throw error}
   }catch(error){if(error.business||controller.signal.aborted)throw error;data=await runCadWorker(plan,{...options,signal:controller.signal})}
  }else data=await runCadWorker(plan,{...options,signal:controller.signal});
  if(typeof data?.engine!=='string'||!Array.isArray(data.bodies)||data.bodies.length!==plan.bodies.length)throw Error('实体计算返回的零件不完整。');
  const bodies=data.bodies.map((body,index)=>{
   const expected=plan.bodies[index];
   if(body.partIndex!==expected.partIndex||body.name!==expected.name||body.role!==expected.role||JSON.stringify(body.positionMm)!==JSON.stringify(expected.positionMm))throw Error('实体计算返回的零件与当前设计不一致。');
   const bytes=bytesFromBase64(body.stlBase64),triangles=decodeSTL(bytes.buffer),meshes=[{triangles,color:solidColors[index%solidColors.length],label:body.name}];meshBounds(meshes);
   return {...expected,meshes,stlBytes:bytes,exact:true};
  });
  const result={engine:data.engine,exact:true,bodies,notice:`${data.engine} 已完成实体布尔计算；制造和装配仍需验证。`};
  meshCache.set(key,result);if(meshCache.size>12)meshCache.delete(meshCache.keys().next().value);return result;
 }catch(error){if(error.name==='AbortError'&&!options.signal?.aborted)throw Error('实体计算超时，当前保留形体预览。');throw error}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel)}
}

export function runCadWorker(plan,options={}){
 const WorkerClass=options.WorkerClass??globalThis.Worker;
 if(!WorkerClass)return Promise.reject(Error('当前环境无法运行实体内核，保留形体预览。'));
 return new Promise((resolve,reject)=>{
  const worker=new WorkerClass(new URL('./cad-worker.js',import.meta.url),{type:'module'});let done=false,timer;
  const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);worker.terminate();fn(value)};
  const abort=()=>finish(reject,Object.assign(Error('实体计算已取消。'),{name:'AbortError'}));
  worker.onmessage=({data})=>data?.error?finish(reject,Error(data.error)):data?.result?finish(resolve,data.result):finish(reject,Error('实体内核未返回有效结果。'));
  worker.onerror=()=>finish(reject,Error('实体内核未能加载，当前保留形体预览。'));
  timer=setTimeout(()=>finish(reject,Error('实体计算超过 30 秒，当前保留形体预览。')),30_000);
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted){abort();return}
  try{worker.postMessage({cadPlan:plan})}catch(error){finish(reject,error)}
 });
}

// Emits only a fixed vocabulary plus validated finite numeric literals.
// The workbench never evaluates this source. Users can open it in ForgeCAD.
export function cadBodyToForgeScript(body){
 validateCadPlan({version:1,bodies:[body]},160);
 const lines=['// FormBench declarative body; dimensions in millimetres.', '// Local coordinates. Manufacturing and assembly are not validated.'];
 body.features.forEach((feature,index)=>{
  const [x,y,z]=feature.sizeMm,center=feature.centerMm;
  let expression=feature.shape==='ellipsoid'?`sphere(1, 48).scale(${JSON.stringify([x/2,y/2,z/2])})`:feature.shape==='cylinder'?`cylinder(${z}, ${x/2}, ${x/2}, 64).translate(0, 0, ${-z/2})`:`box(${x}, ${y}, ${z}).translate(0, 0, ${-z/2})`;
  (feature.rotationDeg||[0,0,0]).forEach((angle,k)=>{if(angle)expression+=`.rotate(${JSON.stringify([0,1,2].map(n=>n===k?1:0))}, ${angle})`});
  expression+=`.translate(${center.join(', ')})`;
  lines.push(`const feature${index} = ${expression};`);
  lines.push(index===0?'let body = feature0;':`body = ${feature.op==='cut'?'difference':'union'}(body, feature${index});`);
 });
 lines.push('return body;','');return lines.join('\n');
}

export function cadDownloadName(name,extension='stl'){
 const clean=String(name||'body').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'body';
 return `${clean}-concept-mm.${extension}`;
}
