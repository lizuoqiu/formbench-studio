import {Worker} from 'node:worker_threads';
import {forgeMode,compileWithForge} from './forge-plan-cli.mjs';
import {validateCadPlan} from './cad-plan.mjs';
const workerUrl=new URL('./forge-plan-worker.mjs',import.meta.url), maxWait=30000;
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
let active=false;
export {configuredForgeEngine as forgePlanEngine} from './forge-plan-cli.mjs';
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
  if(active)return reply({...engine,error:'另一个 CAD 任务正在编译，请稍后再试。'},429);
  if(req.signal.aborted)return reply({...engine,error:'已取消编译。'},408);
  active=true;let worker,timeout,abort;
  try{
    if(useForge){
      try{return reply(await compileWithForge(plan,env,mode,req.signal))}
      catch(e){return reply({...engine,error:e.message},e.status||502)}
    }
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
