// Single-user, loopback-only adapter. Model code and CLI path are server-owned.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile), ranges={w:[62,100],d:[29,64],h:[15,42]};
const fail=(error,status)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
let active=false;
export async function forge(req,env){
 if(req.method!=='POST')return fail('需要 POST。',405);
 const p=await req.json().catch(()=>null);
 if(!p||!['base','lid'].includes(p.part)||Object.keys(p).some(k=>!['part','w','d','h'].includes(k))||!Object.entries(ranges).every(([k,[lo,hi]])=>Number.isFinite(p[k])&&p[k]>=lo&&p[k]<=hi))return fail('请选择底壳或上盖并输入受支持的外壳尺寸。',400);
 if(active)return fail('请等待上一个 ForgeCAD 导出完成。',429);
 active=true;let dir;
 try{
 dir=await mkdtemp(join(tmpdir(),'formwork-forge-'));const out=join(dir,'part.stl');
 const source=fileURLToPath(new URL(`../forge/pico-${p.part}.forge.js`,import.meta.url));
 await run(env.FORGECAD_BIN||'forgecad',['export','stl',source,'--output',out,'--param',`Length=${p.w}`,'--param',`Width=${p.d}`,...(p.part==='base'?['--param',`Height=${p.h}`]:[])],{cwd:dir,timeout:90000,maxBuffer:256*1024});
 const mesh=await readFile(out);
 if(mesh.length<84||mesh.length!==84+50*mesh.readUInt32LE(80)||!mesh.readUInt32LE(80))return fail('ForgeCAD 未返回有效的二进制 STL。',502);
 const name=`forge-pico-${p.part}-${p.w}x${p.d}x${p.h}.stl`;
 return new Response(mesh,{headers:{'Content-Type':'model/stl','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store'}});
 }catch(e){return e.code==='ENOENT'?fail('请在本机安装 ForgeCAD CLI，并检查可信模板与导出路径。',503):fail('ForgeCAD 未能完成导出，请检查本机 CLI、模型及运行许可。',502)}finally{try{if(dir)await rm(dir,{recursive:true,force:true})}finally{active=false}}
}
