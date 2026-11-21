import {featurePlacement} from './cad-plan.js';
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
export {featurePlacement} from './cad-plan.js';
function previewFeature(feature){
 let faces;
 if(feature.shape==='capsule'){
  const {radii,axis,offset}=capsuleDimensions(feature.sizeMm);
  faces=cappedSurface(radii,axis,offset[axis]);
 }else if(feature.shape==='roundedPrism') faces=roundedPrismPreview(feature.sizeMm);
 else if(feature.shape==='ellipsoid') faces=cappedSurface(feature.sizeMm.map(n=>n/2));
 else faces=makeDocumentedProxy({shape:feature.shape,sizeMm:feature.sizeMm}).meshes.flatMap(mesh=>mesh.triangles.map(face=>face.map(point=>point.map((n,k)=>n-feature.sizeMm[k]/2))));
 const place=featurePlacement(feature);
 return faces.map(face=>face.map(place));
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
async function decodeSolidResult(plan,data,requireForge,stage,options){
  if(typeof data?.engine!=='string'||!Array.isArray(data.bodies)||data.bodies.length!==plan.bodies.length)throw Error('实体计算返回的零件不完整。');
  if(requireForge&&!/^ForgeCAD\b/i.test(data.engine))throw Error('所选的 ForgeCAD 引擎没有生成本次实体。');
  const bodies=[];
  for(const [index,body] of data.bodies.entries()){
   options.signal?.throwIfAborted();
   const expected=plan.bodies[index];
   if(body.partIndex!==expected.partIndex||body.name!==expected.name||body.role!==expected.role||JSON.stringify(body.positionMm)!==JSON.stringify(expected.positionMm))throw Error('实体计算返回的零件与当前设计不一致。');
   const record={stage,bodyIndex:index,partIndex:body.partIndex,name:body.name,total:plan.bodies.length};
   options.onProgress?.({...record,phase:'start',completed:index});
   // Yield the UI thread between potentially large STL decodes.
   if(options.onProgress&&typeof document!=='undefined'){
    if(globalThis.scheduler?.yield)await globalThis.scheduler.yield();
    else await new Promise(resolve=>setTimeout(resolve,0));
    options.signal?.throwIfAborted();
   }
   const bytes=bytesFromBase64(body.stlBase64),triangles=decodeSTL(bytes.buffer),meshes=[{triangles,color:solidColors[index%solidColors.length],label:body.name}];meshBounds(meshes);
   bodies.push({...expected,meshes,stlBytes:bytes,exact:true});
   options.onProgress?.({...record,phase:'finish',completed:index+1});
  }
  return {engine:data.engine,exact:true,bodies,notice:`${data.engine} 已完成实体布尔计算；制造和装配仍需验证。`};
}

// Object member order is irrelevant, while feature sequence, body order, every
// dimension, and the motions all describe the particular published assembly.
function planKey(plan){
 return JSON.stringify(plan,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}

const sampleExportFiles={'fist-bump':'fist-bump-cad.json','fist-bump-v1':'fist-bump.v1-cad.json'};
async function savedExample(plan,url,fetcher,signal,onProgress){
 try{
  const response=await fetcher(url,{credentials:'same-origin',mode:'same-origin',redirect:'error',signal});
  if(!response.ok)return null;
  const data=await response.json();
  if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)||data.engine!=='ForgeCAD CLI '+data.version||data.units!=='mm'||planKey(data.cadPlan)!==planKey(plan))return null;
  const result=await decodeSolidResult(plan,data,true,'load',{signal,onProgress});
  result.notice='已加载示例保存的 '+data.engine+' 实体。制造和装配仍需验证。';
  return result;
 }catch{
  signal.throwIfAborted();
  return null;
 }
}

function generationProgress(plan,onProgress){
 let events=0;
 return {
  accept({bodyIndex,partIndex,name,phase,completed,total}){
   const expected=plan.bodies[bodyIndex];
   if(!expected||bodyIndex!==Math.floor(events/2)||partIndex!==expected.partIndex||name!==expected.name||
      phase!==(events%2?'finish':'start')||total!==plan.bodies.length||completed!==bodyIndex+Number(phase==='finish'))
    throw Error('建模进度与当前设计不一致。');
   events++;
   onProgress?.({stage:'generate',bodyIndex,partIndex,name,phase,completed,total});
  },
  finish(){
   if(events&&events!==plan.bodies.length*2)throw Error('实体生成过程不完整。');
  }
 };
}

async function readCompilation(response,plan,onProgress,signal){
 const reader=response.body.getReader(),decoder=new TextDecoder(),progress=generationProgress(plan,onProgress);
 let pieces=[],bytes=0,result=null;
 function consume(text){
  if(!text.trim())return;
  if(result)throw Error('建模结果之后出现多余的数据。');
  const event=JSON.parse(text);
  if(event.type==='progress')progress.accept(event);
  else if(event.type==='result'&&event.result){progress.finish();result=event.result}
  else throw Error(event.error||'无法读取建模结果。');
 }
 function readLines(text){
  const lines=text.split('\n');
  for(let i=0;i<lines.length-1;i++){
   pieces.push(lines[i]);consume(pieces.join(''));pieces=[];
  }
  if(lines.at(-1))pieces.push(lines.at(-1));
 }
 const stop=()=>{reader.cancel().catch(()=>{})};
 signal.addEventListener('abort',stop,{once:true});
 try{
  for(;;){
   signal.throwIfAborted();
   const {value,done}=await reader.read();
   if(done)break;
   if((bytes+=value.byteLength)>32*1024*1024)throw Error('实体文件过大。');
   readLines(decoder.decode(value,{stream:true}));
  }
  signal.throwIfAborted();readLines(decoder.decode());consume(pieces.join(''));
  if(!result)throw Error('建模连接中断，未收到完整实体。');
  return result;
 }catch(error){stop();throw error}
 finally{signal.removeEventListener('abort',stop);reader.releaseLock()}
}

export async function compileCadPlan(raw,options={}){
 const plan=validateCadPlan(raw,options.partCount??60),base=options.baseUrl??globalThis.location?.href;
 let url;try{url=new URL('./api/forge/plan',base)}catch{}
 const requireForge=/^forgecad\b/i.test(options.engine||'');
 const useEndpoint=url&&(requireForge||localHosts.has(url.hostname));
 let savedURL;
 if(options.savedCadUrl){
  const sharedRoot=new URL('./samples/shared/',base),candidate=new URL(options.savedCadUrl,base);
  if(candidate.origin!==sharedRoot.origin||!candidate.pathname.startsWith(sharedRoot.pathname))
   throw Error('项目的 CAD 存档地址无效。');
  savedURL=candidate;
 }else if(Object.hasOwn(sampleExportFiles,options.exampleAsset)&&url&&!localHosts.has(url.hostname)){
  savedURL=new URL('./samples/'+sampleExportFiles[options.exampleAsset],base);
 }
 const key=(savedURL?savedURL.href+':':'design:')+JSON.stringify(plan);
 // The server's selected engine can change between requests.
 options.signal?.throwIfAborted();
 if(!useEndpoint&&!requireForge&&meshCache.has(key)){
  options.onProgress?.({stage:'load',phase:'cache',completed:plan.bodies.length,total:plan.bodies.length});
  return meshCache.get(key);
 }
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90_000);
 const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
 if(options.signal?.aborted)controller.abort();
 try{
  if(savedURL){
   options.onProgress?.({stage:'load',phase:'request',total:plan.bodies.length});
   const result=await savedExample(plan,savedURL,options.fetcher??globalThis.fetch,controller.signal,options.onProgress);
   if(result){
    if(meshCache.size>=12)meshCache.delete(meshCache.keys().next().value);
    meshCache.set(key,result);return result;
   }
   if(options.savedCadUrl)throw Error('此版保存的 CAD 缺失或与设计不符，请重新载入项目。');
  }
  let data;
  options.onProgress?.({stage:'generate',phase:'request',total:plan.bodies.length});
  if(requireForge&&!url)throw Error('当前缺少 ForgeCAD 服务地址。');
  if(useEndpoint){
   try{
    const response=await(options.fetcher??globalThis.fetch)(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson, application/json'},credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal,body:JSON.stringify({cadPlan:plan,...(requireForge?{engine:"forgecad"}:{})})});
    if(!response.ok){
     data=await response.json().catch(()=>null);
     const error=Error(typeof data?.error==='string'?data.error:'实体计算服务没有完成请求。');
     error.business=/^ForgeCAD\b/i.test(data?.engine||'')||![404,429,503].includes(response.status);
     throw error;
    }
    if(response.headers?.get('content-type')?.includes('application/x-ndjson')){
     // Once an engine has started, a broken stream must not select a different kernel.
     try{data=await readCompilation(response,plan,options.onProgress,controller.signal)}
     catch(error){error.business=true;throw error}
    }else data=await response.json();
   }catch(error){if(requireForge||error.business||controller.signal.aborted)throw error;data=await runCadWorker(plan,{...options,signal:controller.signal})}
  }else data=await runCadWorker(plan,{...options,signal:controller.signal});
  const result=await decodeSolidResult(plan,data,requireForge,'decode',{onProgress:options.onProgress,signal:controller.signal});
  if(!useEndpoint&&!savedURL){meshCache.set(key,result);if(meshCache.size>12)meshCache.delete(meshCache.keys().next().value)}
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
  const progress=generationProgress(plan,options.onProgress);
  worker.onmessage=({data})=>{
   try{
    if(data?.progress){progress.accept(data.progress);return}
    if(data?.result){progress.finish();finish(resolve,data.result)}
    else finish(reject,Error(data?.error||'实体内核未返回有效结果。'));
   }catch(error){finish(reject,error)}
  };
  worker.onerror=()=>finish(reject,Error('实体内核未能加载，当前保留形体预览。'));
  timer=setTimeout(()=>finish(reject,Error('实体计算超过 30 秒，当前保留形体预览。')),30_000);
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted){abort();return}
  try{worker.postMessage({cadPlan:plan,progress:Boolean(options.onProgress)})}catch(error){finish(reject,error)}
 });
}

export {cadBodyToForgeScript,cadPlanToForgeScript} from './forge-source.js';

export function cadDownloadName(name,extension='stl'){
 const clean=String(name||'body').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'body';
 return `${clean}-concept-mm.${extension}`;
}
