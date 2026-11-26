import {accessSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {hasLocalCodex,withLocalCodex} from './openai-response.mjs';
import {hasOpenAIKey} from './openai-keys.mjs';
const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
function binary(env){const path=env.FORMBENCH_LOCAL_CODEX_BIN||bundled;if(!isAbsolute(path))return null;try{accessSync(path,constants.X_OK);return path;}catch{return null;}}
const problem=(message,status)=>Object.assign(new Error(message),{status});
export function designProviders(env){const list=[];
 if(!hasLocalCodex(env)&&hasOpenAIKey(env)&&env.OPENAI_MODEL)list.push({id:'openai-api',model:env.OPENAI_MODEL,effort:env.OPENAI_REASONING_EFFORT||'max'});
 if(hasLocalCodex(env)||env.FORMBENCH_ALLOW_LOCAL_CODEX==='1'&&binary(env))list.push({id:'local-codex',model:'gpt-6.2-sol',effort:env.FORMBENCH_LOCAL_CODEX_EFFORT||'max'});
 return list;
}
export function jobProvider(job,env){return job.provider??((job.id&&env.FORMBENCH_LOCAL_CODEX_JOB_ID===job.id)||hasLocalCodex(env)?'local-codex':'openai-api');}
export function checkChoice(choice,env){if(choice==null||choice==='auto')return;
 if(!['local-codex','openai-api'].includes(choice))throw problem('未知的运行方式。',400);
 if(!designProviders(env).some(p=>p.id===choice))throw problem(choice==='local-codex'?'本机 Codex 未启用，请从已启动的本机工作台运行。':'当前工作台未配置 OpenAI API。',409);
}
export function providerEnv(provider,env,id){
 if(provider==='openai-api'){if(hasLocalCodex(env))throw problem('此运行器仅支持本机 Codex。',409);return env;}
 if(provider!=='local-codex')throw problem('未知的运行方式。',400);
 if(hasLocalCodex(env))return env;
 if((env.FORMBENCH_ALLOW_LOCAL_CODEX!=='1'&&!(id&&id===env.FORMBENCH_LOCAL_CODEX_JOB_ID))||!binary(env))throw problem('当前设备不能运行已选的本机 Codex；任务不会切换到 API。',409);
 return withLocalCodex(env,{binary:binary(env),effort:env.FORMBENCH_LOCAL_CODEX_EFFORT||'max'});
}

// Only new, automatic tasks opt in. Old jobs and explicit selections remain pinned.
export function initialProvider(policy,env){
 if(policy!=='auto')return policy;
 return designProviders(env)[0]?.id||'openai-api';
}
export function quotaRoute(policy,current,result,env,previousApiQuota=false){
 if(policy!=='auto')return null;
 if(current==='openai-api'&&result.actionRequired==='api-billing'&&designProviders(env).some(p=>p.id==='local-codex'))return {next:'local-codex'};
 if(current==='local-codex'&&result.quotaExhausted===true)return previousApiQuota?{stop:'providers-exhausted',message:'API 和本机 Codex 的可用额度都已用完，本次任务已停止。'}:{stop:'codex-quota',message:'本机 Codex 的可用额度已用完，本次任务已停止。'};
 return null;
}
export async function routedDiscussion(request,env,{run,sink}={}){
 const policy=request.headers.get('X-Formbench-Provider')||'auto';
 checkChoice(policy,env);let provider=initialProvider(policy,env),usedApi=false;
 const body=await request.text();
 for(;;){
   const r=new Request(request.url,{method:request.method,headers:request.headers,signal:request.signal,body});
   const out=await run(r,providerEnv(provider,env));
   if(out.ok){sink?.('discussion.finish',{provider,statusCode:out.status});return out;}
   const data=await out.clone().json().catch(()=>({})),route=quotaRoute(policy,provider,data,env,usedApi);
   if(route?.next){sink?.('provider.switch',{from:provider,to:route.next,reason:'api-quota'});usedApi=true;provider=route.next;continue;}
   sink?.('discussion.stop',{provider,statusCode:out.status,reason:route?.stop||data.actionRequired||'service-error'});
   if(route?.stop)return Response.json({error:route.message,actionRequired:route.stop,retryable:false},{status:429,headers:{'Cache-Control':'no-store'}});
   return out;
 }
}
