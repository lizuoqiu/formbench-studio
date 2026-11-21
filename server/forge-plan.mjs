import {Worker} from 'node:worker_threads';
import {validateCadPlan} from './cad-plan.mjs';
const workerUrl=new URL('./forge-plan-worker.mjs',import.meta.url), maxWait=30000;
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
let active=false;
export async function forgePlan(req) {
  if(req.method!=='POST')return reply({error:'需要 POST。'},405);
  let plan;
  try{
    const payload=await req.json();
    if(!payload||Object.keys(payload).length!==1||!Object.hasOwn(payload,'cadPlan'))throw Error('请提供 cadPlan。');
    plan=validateCadPlan(payload.cadPlan);
    if(!plan?.bodies?.length)throw Error('CAD 计划缺少可编译的实体。');
  }catch(e){return reply({error:e.message||'CAD 计划格式无效。'},400)}
  if(active)return reply({error:'另一个 CAD 任务正在编译，请稍后再试。'},429);
  if(req.signal.aborted)return reply({error:'已取消编译。'},408);
  active=true;let worker,timeout,abort;
  try{
    worker=new Worker(workerUrl,{workerData:plan,execArgv:[]});
    return await new Promise(resolve=>{
      worker.once('message',m=>resolve(m.result?reply(m.result):reply({error:m.error||'实体编译失败。'},422)));
      worker.once('error',()=>resolve(reply({error:'几何编译器未能启动，请检查本机安装。'},503)));
      worker.once('exit',()=>resolve(reply({error:'几何编译进程提前结束。'},502)));
      timeout=setTimeout(()=>resolve(reply({error:'实体编译耗时过长，请简化设计或分件。'},504)),maxWait);
      abort=()=>resolve(reply({error:'已取消编译。'},408));req.signal.addEventListener('abort',abort,{once:true});
    });
  }catch{return reply({error:'几何编译器未能启动。'},503)}
  finally{clearTimeout(timeout);if(abort)req.signal.removeEventListener('abort',abort);try{if(worker)await worker.terminate()}finally{active=false}}
}
