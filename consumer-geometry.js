import {validateCadPlan} from './cad-plan.js';
import {decodeSTL} from './assembly-hardware.js';
import {makeDocumentedProxy} from './part-geometry.js';
import {capsuleDimensions,cornerRadius} from './native-features.js';

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

// Preview tessellation only. The selected solid engine performs the booleans.
function joinRings(top,bottom,faces){
 for(let j=0;j<top.length;j++){
  const next=(j+1)%top.length;
  faces.push([top[j],bottom[j],bottom[next]],[top[j],bottom[next],top[next]]);
 }
}
function cappedSurface(radii,axis=2,offset=0){
 const faces=[],rings=[],segments=32,levels=16,x=(axis+1)%3,y=(axis+2)%3;
 const ring=(theta,shift)=>Array.from({length:segments},(_,j)=>{
  const point=[0,0,0],phi=2*Math.PI*j/segments;
  point[x]=radii[x]*Math.sin(theta)*Math.cos(phi);point[y]=radii[y]*Math.sin(theta)*Math.sin(phi);
  point[axis]=radii[axis]*Math.cos(theta)+shift;return point;
 });
 for(let i=1;i<levels;i++){
  rings.push(ring(Math.PI*i/levels,i<=levels/2?offset:-offset));
  if(offset>0&&i===levels/2)rings.push(ring(Math.PI/2,-offset));
 }
 const top=[0,0,0],bottom=[0,0,0],last=rings.at(-1);
 top[axis]=radii[axis]+offset;bottom[axis]=-top[axis];
 for(let j=0;j<segments;j++){const next=(j+1)%segments;faces.push([top,rings[0][j],rings[0][next]],[last[j],bottom,last[next]])}
 for(let i=1;i<rings.length;i++)joinRings(rings[i-1],rings[i],faces);
 return faces;
}
function roundedPrismPreview(size){
 const [w,d,h]=size,r=cornerRadius(size),top=[],faces=[];
 for(let corner=0;corner<4;corner++){
  const cx=(corner===0||corner===3?1:-1)*(w/2-r),cy=(corner<2?1:-1)*(d/2-r);
  for(let i=0;i<=8;i++){
   const theta=(corner+i/8)*Math.PI/2;
   top.push([cx+r*Math.cos(theta),cy+r*Math.sin(theta),h/2]);
  }
 }
 const bottom=top.map(([x,y])=>[x,y,-h/2]);
 joinRings(top,bottom,faces);
 for(let i=0;i<top.length;i++){
  const j=(i+1)%top.length;faces.push([[0,0,h/2],top[i],top[j]],[[0,0,-h/2],bottom[j],bottom[i]]);
 }
 return faces;
}
function previewFeature(feature){
 let faces;
 if(feature.shape==='capsule'){
  const {radii,axis,offset}=capsuleDimensions(feature.sizeMm);
  faces=cappedSurface(radii,axis,offset[axis]);
 }else if(feature.shape==='roundedPrism') faces=roundedPrismPreview(feature.sizeMm);
 else if(feature.shape==='ellipsoid') faces=cappedSurface(feature.sizeMm.map(n=>n/2));
 else faces=makeDocumentedProxy({shape:feature.shape,sizeMm:feature.sizeMm}).meshes.flatMap(mesh=>mesh.triangles.map(face=>face.map(point=>point.map((n,k)=>n-feature.sizeMm[k]/2))));
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
function decodeSolidResult(plan,data,requireForge){
  if(typeof data?.engine!=='string'||!Array.isArray(data.bodies)||data.bodies.length!==plan.bodies.length)throw Error('实体计算返回的零件不完整。');
  if(requireForge&&!/^ForgeCAD\b/i.test(data.engine))throw Error('所选的 ForgeCAD 引擎没有生成本次实体。');
  const bodies=data.bodies.map((body,index)=>{
   const expected=plan.bodies[index];
   if(body.partIndex!==expected.partIndex||body.name!==expected.name||body.role!==expected.role||JSON.stringify(body.positionMm)!==JSON.stringify(expected.positionMm))throw Error('实体计算返回的零件与当前设计不一致。');
   const bytes=bytesFromBase64(body.stlBase64),triangles=decodeSTL(bytes.buffer),meshes=[{triangles,color:solidColors[index%solidColors.length],label:body.name}];meshBounds(meshes);
   return {...expected,meshes,stlBytes:bytes,exact:true};
  });
  return {engine:data.engine,exact:true,bodies,notice:`${data.engine} 已完成实体布尔计算；制造和装配仍需验证。`};
}

// Object member order is irrelevant, while feature sequence, body order, every
// dimension, and the motions all describe the particular published assembly.
function planKey(plan){
 return JSON.stringify(plan,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}

async function savedExample(plan,base,fetcher,signal){
 try{
  const url=new URL('./samples/fist-bump-cad.json',base);
  const response=await fetcher(url,{credentials:'same-origin',mode:'same-origin',redirect:'error',signal});
  if(!response.ok)return null;
  const data=await response.json();
  if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)||data.engine!=='ForgeCAD CLI '+data.version||data.units!=='mm'||planKey(data.cadPlan)!==planKey(plan))return null;
  const result=decodeSolidResult(plan,data,true);
  result.notice='已加载示例保存的 '+data.engine+' 实体。制造和装配仍需验证。';
  return result;
 }catch{
  signal.throwIfAborted();
  return null;
 }
}

export async function compileCadPlan(raw,options={}){
 const plan=validateCadPlan(raw,options.partCount??60),base=options.baseUrl??globalThis.location?.href;
 let url;try{url=new URL('./api/forge/plan',base)}catch{}
 const requireForge=/^forgecad\b/i.test(options.engine||'');
 const useEndpoint=url&&(requireForge||localHosts.has(url.hostname));
 const useSavedExample=options.exampleAsset==='fist-bump'&&url&&!localHosts.has(url.hostname);
 const key=(useSavedExample?'example:':'design:')+JSON.stringify(plan);
 // The server's selected engine can change between requests.
 if(!useEndpoint&&!requireForge&&meshCache.has(key))return meshCache.get(key);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90_000);
 const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
 if(options.signal?.aborted)controller.abort();
 try{
  if(useSavedExample){
   const result=await savedExample(plan,base,options.fetcher??globalThis.fetch,controller.signal);
   if(result){
    if(meshCache.size>=12)meshCache.delete(meshCache.keys().next().value);
    meshCache.set(key,result);return result;
   }
  }
  let data;
  if(requireForge&&!url)throw Error('当前缺少 ForgeCAD 服务地址。');
  if(useEndpoint){
   try{
    const response=await(options.fetcher??globalThis.fetch)(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal,body:JSON.stringify({cadPlan:plan,...(requireForge?{engine:"forgecad"}:{})})});
    data=await response.json().catch(()=>null);
    if(!response.ok){
     const error=Error(typeof data?.error==='string'?data.error:'实体计算服务没有完成请求。');
     error.business=/^ForgeCAD\b/i.test(data?.engine||'')||![404,429,503].includes(response.status);
     throw error;
    }
   }catch(error){if(requireForge||error.business||controller.signal.aborted)throw error;data=await runCadWorker(plan,{...options,signal:controller.signal})}
  }else data=await runCadWorker(plan,{...options,signal:controller.signal});
  const result=decodeSolidResult(plan,data,requireForge);
  if(!useEndpoint&&!useSavedExample){meshCache.set(key,result);if(meshCache.size>12)meshCache.delete(meshCache.keys().next().value)}
  return result;
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

export {cadBodyToForgeScript,cadPlanToForgeScript} from './forge-source.js';

export function cadDownloadName(name,extension='stl'){
 const clean=String(name||'body').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'body';
 return `${clean}-concept-mm.${extension}`;
}
