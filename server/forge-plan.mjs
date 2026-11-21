import {Worker} from 'node:worker_threads';
import {forgeMode,compileWithForge} from './forge-plan-cli.mjs';
import {validateCadPlan} from './cad-plan.mjs';
const workerUrl=new URL('./forge-plan-worker.mjs',import.meta.url), maxWait=30000;
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status)=>Object.assign(new Error(message),{status});
let active=null;
export {configuredForgeEngine as forgePlanEngine} from './forge-plan-cli.mjs';

async function compileWithWorker(plan,signal,onProgress) {
  let worker,timeout,abort;
  try {
    worker=new Worker(workerUrl,{workerData:{plan,progress:Boolean(onProgress)},execArgv:[]});
    return await new Promise((resolve,reject)=>{
      worker.on('message',m=>{
        if(m.progress){onProgress?.(m.progress);return}
        if(m.result)resolve(m.result);
        else reject(fail(m.error||'实体编译失败。',422));
      });
      worker.once('error',()=>reject(fail('几何编译器未能启动，请检查本机安装。',503)));
      worker.once('exit',()=>reject(fail('几何编译进程提前结束。',502)));
      timeout=setTimeout(()=>reject(fail('实体编译耗时过长，请简化设计或分件。',504)),maxWait);
      abort=()=>reject(fail('已取消编译。',408));
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
  } catch(e) {throw e.status?e:fail('几何编译器未能启动。',503)}
  finally {
    clearTimeout(timeout);if(abort)signal.removeEventListener('abort',abort);
    if(worker)await worker.terminate();
  }
}

export async function forgePlan(req,env={}) {
  if(req.method!=='POST')return reply({error:'需要 POST。'},405);
  const mode=forgeMode(env);
  let plan,useForge=Boolean(mode);
  try{
    const payload=await req.json();
    if(!payload||Object.keys(payload).some(k=>!['cadPlan','engine'].includes(k))||!Object.hasOwn(payload,'cadPlan'))throw Error('请提供 cadPlan。');
    if(Object.hasOwn(payload,'engine')){
      if(!['forgecad','manifold'].includes(payload.engine))throw Error('未知 CAD 引擎。');
      useForge=payload.engine==='forgecad';
    }
    plan=validateCadPlan(payload.cadPlan);
    if(!plan?.bodies?.length)throw Error('CAD 计划缺少可编译的实体。');
  }catch(e){return reply({error:e.message||'CAD 计划格式无效。'},400)}
  const engine=useForge?{engine:'ForgeCAD CLI'}:{};
  if(useForge&&!mode)return reply({...engine,error:'本机尚未启用 ForgeCAD 的研究版或授权 CLI。'},503);
  if(useForge&&mode==='research'&&new URL(req.url).hostname!=='127.0.0.1')return reply({...engine,error:'ForgeCAD 研究模式仅在本机使用。'},403);
  // A navigation can cancel the prior HTTP response just before this revision arrives.
  // Let that exporter release its files before claiming the slot.
  if(active?.signal.aborted)await active.finished;
  if(active)return reply({...engine,error:'另一个 CAD 任务正在编译，请稍后再试。'},429);
  if(req.signal.aborted)return reply({...engine,error:'已取消编译。'},408);
  const cancelled=new AbortController(),signal=AbortSignal.any([req.signal,cancelled.signal]);
  let release;
  active={signal,finished:new Promise(resolve=>{release=resolve})};
  const compile=async(onProgress)=>{
    try {
      return useForge ? await compileWithForge(plan,env,mode,signal,onProgress) :
        await compileWithWorker(plan,signal,onProgress);
    } finally {active=null;release()}
  };
  const streaming=(req.headers.get('Accept')||'').split(',').some(value=>value.trim().split(';')[0]==='application/x-ndjson');
  if(!streaming){
    try{return reply(await compile())}
    catch(e){return reply({...engine,error:e.message},e.status||502)}
  }
  const encoder=new TextEncoder();
  const body=new ReadableStream({
    start(controller){
      const send=event=>{if(!cancelled.signal.aborted)controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'))};
      // start must return immediately so the HTTP bridge can send each line while work is in flight.
      compile(send).then(result=>send({type:'result',result}),
        e=>send({type:'error',...engine,status:e.status||502,error:e.message}))
        .finally(()=>{if(!cancelled.signal.aborted)controller.close()});
    },
    cancel(){cancelled.abort()}
  });
  return new Response(body,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'}});
}
