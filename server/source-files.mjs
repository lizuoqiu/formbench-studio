import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,extname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {unzipSync} from 'fflate';

const maxBytes=16*1024*1024;
export const assetRoot=env=>env.FORMBENCH_ASSET_DIR||join(homedir(),'.formbench','models');
function publicAddress(address){
  if(isIP(address)===6)return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address);
  const [a,b]=address.split('.').map(Number);
  return a>0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);
}
export async function sourceFetch(raw,{signal,fetcher=fetch,limit=maxBytes}={}){
  let url=new URL(raw);
  for(let redirects=0;redirects<5;redirects++){
    if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('资料需要公开 HTTPS 地址。');
    const addresses=await lookup(url.hostname,{all:true});
    if(!addresses.length||addresses.some(({address})=>!publicAddress(address)))throw Error('资料地址未指向公开网站。');
    const response=await fetcher(url,{signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(limit===maxBytes?180000:35000)]),redirect:'manual',headers:{'User-Agent':'Formbench/1.0 hardware-reference'}});
    if([301,302,303,307,308].includes(response.status)){
      url=new URL(response.headers.get('location'),url);await response.body?.cancel();continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error('资料下载返回 HTTP '+response.status);}
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('资料文件超过大小限制。');}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('资料文件超过大小限制。');chunks.push(chunk);}
    return {bytes:Buffer.concat(chunks),url:url.href,type:response.headers.get('content-type')||'',disposition:response.headers.get('content-disposition')||''};
  }
  throw Error('资料地址重定向过多。');
}
function rawGithub(url){
  const u=new URL(url),pieces=u.pathname.split('/');
  if(u.hostname==='github.com'&&pieces[3]==='blob')return 'https://raw.githubusercontent.com/'+pieces.slice(1,3).concat(pieces.slice(4)).join('/');
  return u.href;
}
const fileType=url=>/\.(step|stp|stl|zip)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
export async function findCadFiles(url,{signal,fetcher=sourceFetch}={}){
  const u=new URL(url);
  if(fileType(url))return [rawGithub(url)];
  if(u.hostname==='github.com'){
    const p=u.pathname.split('/').filter(Boolean);
    const path=p[2]==='tree'?p.slice(4).join('/'):'';
    const api='https://api.github.com/repos/'+p.slice(0,2).join('/')+'/contents/'+path+(p[2]==='tree'?'?ref='+encodeURIComponent(p[3]):'');
    const response=await fetcher(api,{signal});
    const entries=JSON.parse(response.bytes.toString());
    if(Array.isArray(entries))return entries.filter(e=>e.type==='file'&&fileType(e.name)).map(e=>e.download_url).filter(Boolean).slice(0,8);
  }
  const response=await fetcher(url,{signal,limit:3*1024*1024});
  const content=response.bytes.toString();
  if(/^\s*ISO-10303-21;/.test(content)||/filename[^;]*\.(stp|step|stl)/i.test(response.disposition||''))return [url];
  const links=[...content.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(m=>new URL(m[1].replaceAll('&amp;','&'),response.url).href);
  // Some supplier landing pages expose a literal file URL to their download
  // handler. Read that URL as data without executing the page's JavaScript.
  for(const match of content.matchAll(/["'](https:\/\/[^"'\s]+)["']/g))if(fileType(match[1]))links.push(match[1].replaceAll('&amp;','&'));
  return [...new Set(links.filter(fileType).map(rawGithub))].slice(0,8);
}
async function parseCad(bytes,filename,signal){
  const worker=new Worker(new URL('./source-model-worker.mjs',import.meta.url),{workerData:{bytes,filename}});
  let timer,abort;
  try{return await new Promise((resolve,reject)=>{
    worker.once('message',data=>data.error?reject(Error(data.error)):resolve(data));
    worker.once('error',reject);worker.once('exit',code=>reject(Error('CAD 读取进程结束 '+code)));
    timer=setTimeout(()=>reject(Error('原厂 CAD 解析超时。')),90000);
    abort=()=>reject(signal.reason||Error('已取消模型导入。'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await worker.terminate();}
}
export function cadGeometrySummary(model){
  const half=model.sizeMm.map(n=>n/2),groups=new Map();
  const meshes=[];
  // The CAD reader places the lower envelope corner at zero. Assembly anchors
  // instead use the envelope centre; all reported subpart bounds use that frame.
  for(const [index,mesh] of (model.meshes||[]).entries()){
    const label=String(mesh.label||'unnamed'),entry=groups.get(label)||{label,count:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    entry.count++;
    for(const face of mesh.triangles)for(const point of face)for(let k=0;k<3;k++){
      const coordinate=point[k]-half[k];min[k]=Math.min(min[k],coordinate);max[k]=Math.max(max[k],coordinate);
    }
    for(let k=0;k<3;k++){entry.min[k]=Math.min(entry.min[k],min[k]);entry.max[k]=Math.max(entry.max[k],max[k]);}
    groups.set(label,entry);
    if(index<120&&min.every(Number.isFinite)&&max.every(Number.isFinite))meshes.push({index,label,boundsMm:[min,max]});
  }
  const round=xs=>xs.map(n=>Number(n.toFixed(4)));
  return {coordinateSystem:'原生 XYZ 轴向，毫米；零点为完整网格包络中心，与 reference box 锚点中心相同。子件名称与边界来自 CAD，不代表已识别孔位或运动轴。',
    originalOriginMm:round((model.originalMinMm||[0,0,0]).map((n,k)=>-n-half[k])),
    meshCount:(model.meshes||[]).length,groupCount:groups.size,
    meshes:meshes.map(({index,label,boundsMm})=>({index,label,boundsMm:boundsMm.map(round)})),
    groups:[...groups.values()].slice(0,60).map(({label,count,min,max})=>({label,count,boundsMm:[round(min),round(max)]}))};
}
export async function inspectImportedCad(imported,env){
  if(Array.isArray(imported.geometrySummary?.meshes))return imported;
  const model=JSON.parse(await readFile(join(assetRoot(env),imported.id,'mesh.json'),'utf8'));
  return {...imported,geometrySummary:cadGeometrySummary(model)};
}
export async function importSourceCad(record,env,{signal,fetcher=sourceFetch,parser=parseCad}={}){
  const candidates=await findCadFiles(record.cadUrl,{signal,fetcher});
  candidates.sort((a,b)=>(/\.st(?:ep|p)(?:$|\?)/i.test(b)?1:0)-(/\.st(?:ep|p)(?:$|\?)/i.test(a)?1:0));
  const errors=[];
  for(const url of candidates.slice(0,5)){
    try{
      signal?.throwIfAborted();
      const response=await fetcher(url,{signal});
      let bytes=response.bytes,filename=decodeURIComponent(basename(new URL(url).pathname));
      if(!/\.(stl|step|stp|zip)$/i.test(filename)&&/^\s*ISO-10303-21;/.test(bytes.subarray(0,80).toString()))filename='model.step';
      if(fileType(url)==='zip'){
        const entries=unzipSync(bytes,{filter:e=>e.originalSize<=maxBytes&&/\.(step|stp|stl)$/i.test(e.name)});
        let files=Object.keys(entries).filter(name=>!name.startsWith('__MACOSX/')).sort((a,b)=>Number(/\.stl$/i.test(a))-Number(/\.stl$/i.test(b)));
        // One part distributed as STEP + STL is still one selectable model.
        // Distinct assembly components must not be mistaken for the whole SKU.
        if(new Set(files.map(name=>name.replace(/\.(step|stp|stl)$/i,''))).size===1)files=files.slice(0,1);
        if(files.length!==1)throw Error('压缩包含 '+files.length+' 个不同 CAD，需继续查找对应的整件文件或按资料建模。');
        filename=basename(files[0]);bytes=entries[files[0]];
      }
      const model=await parser(bytes,filename,signal);
      if(model.sizeMm.some(n=>!Number.isFinite(n)||n<=0||n>2000))throw Error('CAD 的毫米尺寸超出工作台范围。');
      // The selected file may be a drawing part or a different variant. Keep its
      // measured bounds for the designer rather than stretching it to the BOM.
      const id=randomUUID(),folder=join(assetRoot(env),id),extension=extname(filename).toLowerCase();
      const sourceFile='source'+extension;
      await mkdir(folder,{recursive:true});
      await writeFile(join(folder,sourceFile),bytes);
      await writeFile(join(folder,'mesh.json'),JSON.stringify(model));
      const imported={id,sourceModel:record.model,sourceUrl:response.url,documentationUrl:record.sourceUrl||record.productUrl,
        sizeMm:model.sizeMm,originalMinMm:model.originalMinMm,filename,format:extension.slice(1),
        geometrySummary:cadGeometrySummary(model),
        meshUrl:'/api/model-assets/'+id+'/mesh.json',fileUrl:'/api/model-assets/'+id+'/'+sourceFile,
        sourceType:record.cadAuthority==='manufacturer'?'manufacturer':'supplier'};
      await writeFile(join(folder,'metadata.json'),JSON.stringify(imported));
      return imported;
    }catch(error){signal?.throwIfAborted();errors.push(error.message);}
  }
  throw Error(errors.join(' ')||'该资料页未提供可直接读取的 STEP 或 STL 文件。');
}
export async function modelAsset(request,env){
  const match=/^\/api\/model-assets\/([a-f0-9-]{36})\/(mesh\.json|metadata\.json|source\.(?:step|stp|stl))$/.exec(new URL(request.url).pathname);
  if(request.method!=='GET'||!match)return new Response(null,{status:404});
  try{return new Response(await readFile(join(assetRoot(env),match[1],match[2])),{headers:{'Content-Type':match[2].endsWith('.json')?'application/json':'application/octet-stream','Cache-Control':'private, max-age=86400'}});}
  catch(error){return new Response(null,{status:error.code==='ENOENT'?404:500});}
}
