import {mkdir,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {design} from './design.mjs';
import {reviewDraftBrowser} from './draft-browser.mjs';
import {readDesignRequest} from './design-conversation.mjs';
import {clearBillingFailure} from './openai-response.mjs';
import {resetOpenAIKeyPool} from './openai-keys.mjs';
import {bindJobForgeTools} from './forge-workflow-tools.mjs';

import {jobProvider,checkChoice,providerEnv,initialProvider,quotaRoute} from './design-provider.mjs';
import {debugSink} from './debug-log.mjs';
import {observeRun} from './run-events.mjs';
const active=new Map();
const queued=new Map();
const root=env=>env.FORMBENCH_JOB_DIR||join(homedir(),'.formbench','design-jobs');
const file=(env,id,name='job.json')=>join(root(env),id,name);
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const checkpoint=job=>JSON.stringify([job.state.nextAttempt||0,!!job.state.selection,Object.keys(job.state.sources||{}).length,Object.values(job.state.sources||{}).filter(r=>r?.reconstruction).length,job.state.rounds?.length||0]);
async function atomic(path,value){await writeFile(path+'.tmp',JSON.stringify(value));await rename(path+'.tmp',path);}
async function readPreviewCad(job,env){
  const data=await readFile(file(env,job.id,'cad.json'));
  if(!isDeepStrictEqual(JSON.parse(data).cadPlan,job.state.candidate.cadPlan))
    throw Object.assign(new Error('这一轮尚未生成可用的 CAD。旧版本已保留，不作为本轮预览。'),{status:409});
  return data;
}
async function pauseRequested(env,id,attempt){
  try{const control=JSON.parse(await readFile(file(env,id,'control.json'),'utf8'));return Number.isInteger(control.pauseAfterAttempt)&&attempt>=control.pauseAfterAttempt;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
async function savedCheckpoint(job,env){
  const round=job.state.rounds?.at(-1);
  if(job.status!=='running'||!round?.issues?.length)return false;
  const diagnostic=round.issueDelta?.decision==='diagnose'&&job.state.diagnosisAcknowledgedAt!==round.attempt;
  if(!diagnostic&&!await pauseRequested(env,job.id,round.attempt))return false;
  job.status='paused';job.result=diagnostic?{paused:true,error:round.issueDelta.reason,actionRequired:'workflow-diagnosis'}:
    {paused:true,error:'第 '+round.attempt+' 轮检查已完成，按要求暂停后续修订。'};
  job.progress={stage:'paused',attempt:round.attempt,message:job.result.error};
  await atomic(file(env,job.id),job);return true;
}
function publicJob(job){
  const repairCandidate=job.result?.repairCandidate||(job.state.candidate?{design:job.state.candidate,issues:job.state.issues||[job.result?.error||'任务中断，需继续检查。']}:undefined);
  const progress=job.status==='needs-revision'?{...job.progress,stage:'needs-revision',message:'本轮修订已结束，草稿与未解决的问题已保存。'}:
    job.status==='failed'?{...job.progress,stage:'failed',message:'任务中断，已保存的进度可以继续。'}:job.progress;
  return {id:job.id,provider:job.provider,policy:job.policy,status:job.status,progress,createdAt:job.createdAt,updatedAt:job.updatedAt,
    rounds:(job.state.rounds||[]).map(r=>({attempt:r.attempt,issues:r.issues,...(r.issueDelta?{issueDelta:r.issueDelta}:{})})),
    ...(job.state.issueLedger?{issueLedger:job.state.issueLedger}:{}),
    ...(job.status==='complete'?{...job.result,prompt:job.input.prompt}:{}),...(job.status==='paused'?{error:job.result?.error||job.progress?.message,...(job.result?.actionRequired?{actionRequired:job.result.actionRequired}:{})}:{}),...(['needs-revision','failed','cancelled'].includes(job.status)?{error:job.result?.error||'任务已停止。',repairCandidate,...(job.result?.actionRequired?{actionRequired:job.result.actionRequired}:{})}:{}),
    ...(job.state.candidate?{parts:job.state.candidate.parts.map(({name,model,sourcing})=>({name,model,sourcing}))}:{})};
}
function start(job,env,run=design){
  if(active.has(job.id))return;
  if(queued.has(job.id)){clearTimeout(queued.get(job.id));queued.delete(job.id);}
  job.provider=jobProvider(job,env);
  const sink=debugSink(env,job.id);
  sink?.('job.start',{provider:job.provider,stage:job.progress.stage,attempt:job.state.nextAttempt||1});
  const before=checkpoint(job);
  const controller=new AbortController();
  const resumedAttempt=job.state.draft?.attempt;
  let writing=Promise.resolve(),compiled=null,continueRun=false;
  const save=()=>{
    const {compiled:current,...state}=job.state;
    const snapshot={...job,state,updatedAt:new Date().toISOString()};
    writing=writing.then(async()=>{
      if(current&&current!==compiled){await atomic(file(env,job.id,'cad.json'),current);compiled=current;}
      await atomic(file(env,job.id),snapshot);
    });
    return writing;
  };
  const progress=async event=>{
    const {record,...visible}=event;
    job.progress=visible;
    await save();
    sink?.('job.checkpoint',{...visible,provider:job.provider,assets:Object.keys(job.state.sources||{}).length});
    if(event.stage==='repairing'||event.stage==='complete'){const d=job.state.rounds?.at(-1)?.issueDelta;if(d)sink?.('review.result',{attempt:event.attempt,decision:d.decision,open:d.openCount,closed:d.closed?.length,added:d.opened?.length,regressed:d.reopened?.length});}
  };
  const loadCompiled=async(attempt,plan)=>{
    if(attempt!==resumedAttempt)return null;
    try{
      const saved=JSON.parse(await readFile(file(env,job.id,'cad.json'),'utf8'));
      // Compare as persisted JSON so rotation components of -0 and 0 agree.
      if(!isDeepStrictEqual(saved.cadPlan,JSON.parse(JSON.stringify(plan)))||saved.bodies?.length!==plan.bodies.length||typeof saved.engine!=='string')return null;
      compiled=saved;
      return saved;
    }catch{return null;}
  };
  active.set(job.id,{controller,job});
  const request=new Request('http://127.0.0.1/api/design',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify(job.input)});
  Promise.resolve().then(()=>{
    const scoped=observeRun(providerEnv(job.provider,env,job.id),sink);
    const runEnv=job.provider==='local-codex'?scoped:bindJobForgeTools(scoped,job,save);
    return run(request,runEnv,fetch,{id:job.id,state:job.state,progress,loadCompiled,
      checkBrowser:(candidate,compiled,signal)=>reviewDraftBrowser(candidate,compiled,env,signal),
      shouldPause:attempt=>pauseRequested(env,job.id,attempt)});
  }).then(async out=>{
    job.result=await out.json();
    if(!out.ok){job.state.serviceFailures??=[];job.state.serviceFailures.push({at:new Date().toISOString(),stage:job.progress?.stage,partIndex:job.progress?.partIndex,completed:job.progress?.completed,provider:job.provider,retryable:job.result.retryable,status:out.status,error:job.result.error});}
    const route=!controller.signal.aborted&&!out.ok&&quotaRoute(job.policy,job.provider,job.result,env,job.state.apiQuotaExhausted);
    if(route?.next){
      sink?.('provider.switch',{from:job.provider,to:route.next,reason:'api-quota'});
      job.state.apiQuotaExhausted=true;job.state.providerHistory??=[];job.state.providerHistory.push({from:job.provider,to:route.next,reason:'api-quota',at:new Date().toISOString()});
      job.provider=route.next;clearBillingFailure(job.state);job.state.serviceRetries=0;
      job.result={continue:true};job.progress={stage:'switching',message:'正在接续已保存的工作'};job.status='running';continueRun=true;return;
    }
    if(route?.stop){job.result={error:route.message,actionRequired:route.stop,retryable:false};job.status='failed';return;}
    const transient=!out.ok&&(job.result.retryable??[429,500,502,503,504].includes(out.status));
    if(before!==checkpoint(job))job.state.serviceRetries=0;
    continueRun=!controller.signal.aborted&&!job.result.paused&&(job.result.continue===true||(transient&&(job.state.serviceRetries||0)<3));
    if(job.result.continue){job.state.serviceRetries=0;}
    else if(continueRun){job.state.serviceRetries=(job.state.serviceRetries||0)+1;job.progress={stage:'recovering',message:'服务暂时中断，正在自动恢复已保存的设计进度。'};}
    job.status=controller.signal.aborted?'cancelled':job.result.paused?'paused':continueRun?'running':out.ok?'complete':job.result.repairCandidate?'needs-revision':'failed';
    if(job.status==='paused')job.progress={...job.progress,stage:'paused',message:job.result.error};
  }).catch(error=>{job.status=controller.signal.aborted?'cancelled':'failed';job.result={error:error.message,...(error.actionRequired?{actionRequired:error.actionRequired}:{})};})
    .finally(async()=>{try{await save();sink?.(continueRun&&job.status==='running'?'job.continuing':'job.end',{provider:job.provider,status:job.status,reason:job.result?.actionRequired,stage:job.progress.stage,retries:job.state.serviceRetries,attempt:job.state.nextAttempt});}finally{active.delete(job.id);if(continueRun&&job.status==='running'&&!controller.signal.aborted){
      const timer=setTimeout(async()=>{
        queued.delete(job.id);
        try{const saved=JSON.parse(await readFile(file(env,job.id),'utf8'));if(saved.status==='running'&&!await savedCheckpoint(saved,env))start(saved,env,run);}catch{/* A removed job must not restart. */}
      },Math.min(30000,1000*2**(job.state.serviceRetries||0)));queued.set(job.id,timer);timer.unref?.();
    }}});
}
export async function designJobs(request,env,{run=design}={}){
  const path=new URL(request.url).pathname;
  if(path==='/api/design-jobs'&&request.method==='POST'){
    const input=await request.json();
    try{checkChoice(input.provider,env);}catch(e){return response({error:e.message},e.status);}
    // Validate before persisting or starting a paid background operation.
    await readDesignRequest(new Request(request.url,{method:'POST',body:JSON.stringify({...input,action:'generate'})}));
    if(input.forgeProject===undefined && env.FORMBENCH_FORGE_MCP_DEFAULT_PROJECT && !env.FORMBENCH_FORGE_MCP_JOB_ID) {
      input.forgeProject=env.FORMBENCH_FORGE_MCP_DEFAULT_PROJECT;
    }
    const id=randomUUID(),policy=input.provider??'auto',job={id,policy,provider:initialProvider(policy,env),input:{...input,action:'generate'},state:{},status:'running',createdAt:new Date().toISOString(),progress:{stage:'planning',message:'正在准备设计任务'}};
    await mkdir(join(root(env),id),{recursive:true,mode:0o700});await atomic(file(env,id),job);start(job,env,run);
    return response(publicJob(job),202);
  }
  const match=/^\/api\/design-jobs\/([a-f0-9-]{36})(?:\/(cancel|retry|preview|cad\.json))?$/.exec(path);
  if(!match)return response({error:'设计任务不存在。'},404);
  const [,id,action]=match;
  let job;
  try{job=active.get(id)?.job||JSON.parse(await readFile(file(env,id),'utf8'));}
  catch(error){return response({error:'设计任务无法读取。'},error.code==='ENOENT'?404:500);}
  if(action==='preview'&&request.method==='GET'){
    if(job.status!=='paused'||!job.state.candidate?.cadPlan)return response({error:'当前没有可查看的暂停草稿。'},409);
    try{await readPreviewCad(job,env);}
    catch(error){return response({error:error.status?error.message:'本轮 CAD 文件无法读取。'},error.status||404);}
    return response({...publicJob(job),preview:{design:job.state.candidate,attempt:job.state.rounds?.at(-1)?.attempt,
      cadUrl:'/api/design-jobs/'+id+'/cad.json?preview=1'}});
  }
  if(action==='cad.json'&&request.method==='GET'){
    const preview=job.status==='paused'&&new URL(request.url).searchParams.get('preview')==='1';
    if(job.status!=='complete'&&!preview)return response({error:'CAD 尚未完成评审。'},409);
    try{return new Response(preview?await readPreviewCad(job,env):await readFile(file(env,id,'cad.json')),{headers:{'Content-Type':'application/json','Cache-Control':preview?'no-store':'private, max-age=86400'}});}
    catch(error){return response({error:error.status?error.message:'本轮 CAD 文件无法读取。'},error.status||404);}
  }
  if(action==='cancel'&&request.method==='POST'){
    if(queued.has(id)){clearTimeout(queued.get(id));queued.delete(id);}
    active.get(id)?.controller.abort();job.status='cancelled';job.result={error:'设计任务已取消，已有版本已保存。'};
    if(!active.has(id))await atomic(file(env,id),job);
    return response(publicJob(job));
  }
  if(action==='retry'&&request.method==='POST'){
    if(active.has(id))return response(publicJob(job),202);
    let options;
    try{const text=await request.text();options=text?JSON.parse(text):{};}catch{return response({error:'续修请求需要有效的 JSON。'},400);}
    if(!options||typeof options!=='object'||Array.isArray(options))return response({error:'续修参数无效。'},400);
    const {instruction,pauseAfterAttempt}=options,nextAttempt=job.state.nextAttempt||1;
    if(pauseAfterAttempt!==undefined&&(!Number.isInteger(pauseAfterAttempt)||pauseAfterAttempt<nextAttempt))return response({error:'停止轮次不能早于下一轮。'},400);
    if(instruction!==undefined){
      if(typeof instruction!=='string'||!instruction.trim())return response({error:'请填写修改意见。'},400);
      const input={...job.input,conversation:[...(job.input.conversation||[]),{role:'user',text:instruction.trim()}]};
      try{await readDesignRequest(new Request(request.url,{method:'POST',body:JSON.stringify(input)}));}catch(error){return response({error:error.message},error.status||400);}
      job.input=input;delete job.state.repair;delete job.state.draft;delete job.state.generationRecovery;
    }
    if(pauseAfterAttempt!==undefined)await atomic(file(env,id,'control.json'),{pauseAfterAttempt});
    else await rm(file(env,id,'control.json'),{force:true});
    if(jobProvider(job,env)!=='local-codex'&&(job.result?.actionRequired==='api-billing'||job.state.billingRequired))resetOpenAIKeyPool(env);
    if(job.state.rounds?.at(-1)?.issueDelta?.decision==='diagnose')job.state.diagnosisAcknowledgedAt=job.state.rounds.at(-1).attempt;
    clearBillingFailure(job.state);
    job.state.retries??=[];job.state.retries.push({at:new Date().toISOString(),status:job.status,nextAttempt:job.state.nextAttempt||1,error:job.result?.error||''});
    // Keep the monotonically increasing round and its failure history.
    // The loop decides when a design passes; a slice ending is not completion.
    job.state.serviceRetries=0;
    job.status='running';delete job.result;
    await atomic(file(env,id),job);start(job,env,run);return response(publicJob(job),202);
  }
  if(request.method!=='GET'||action)return response({error:'不支持此操作。'},405);
  if(job.status==='running'&&!active.has(id)&&!queued.has(id)&&!await savedCheckpoint(job,env))start(job,env,run);
  const visible=publicJob(job);
  if(job.status==='paused'){
    try{await readPreviewCad(job,env);visible.previewAvailable=true;}
    catch{visible.previewAvailable=false;}
  }
  return response(visible);
}

// A viewer is not a scheduler: restore only unfinished jobs on server startup.
export async function resumeRunningJobs(env,{run=design}={}){
 let dirs;try{dirs=await readdir(root(env),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
 const ids=[];for(const d of dirs){if(!d.isDirectory()||!/^[a-f0-9-]{36}$/.test(d.name)||active.has(d.name)||queued.has(d.name))continue;
  try{const job=JSON.parse(await readFile(file(env,d.name),'utf8'));if(job.id!==d.name||job.status!=='running'||await savedCheckpoint(job,env))continue;start(job,env,run);ids.push(job.id);}
  catch(e){console.warn('Formbench: could not restore job',d.name,e.code||e.name);}}return ids;
}
