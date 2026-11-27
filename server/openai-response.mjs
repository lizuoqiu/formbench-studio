import {runSink,track} from './run-events.mjs';
import {openAIKeyPool} from './openai-keys.mjs';
import {mainLocalModel} from './model-settings.mjs';
const localCodex=Symbol('local Codex relay');
const workflowTools=Symbol('scoped workflow tools');
export const withWorkflowTools=(env,run)=>({...env,[workflowTools]:{run,baseEnv:env}});
export const withLocalCodex=(env,config)=>({...env,[localCodex]:config});
export const hasLocalCodex=env=>Boolean(env[localCodex]);
export function routineLookupEnv(env){
  if(!hasLocalCodex(env))return env;
  return withLocalCodex(env,{...env[localCodex],model:env.FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL||mainLocalModel,
    effort:env.FORMBENCH_LOCAL_CODEX_LOOKUP_EFFORT||'medium'});
}
// Long reasoning requests send headers and lifecycle events immediately. Only
// the terminal response is accepted as model output; partial JSON is not a draft.
export class OpenAIBillingError extends Error{
  constructor(){super('OpenAI API 额度不足或已达用量上限。请恢复额度后继续，已有设计进度已保存。');this.actionRequired='api-billing';}
}
export function isBillingFailure(value){
  const error=value?.error||value;
  return /insufficient_quota|billing_hard_limit_reached|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|no credits remaining|run out of credits|no balance left|exceeded your current quota|API 额度不足或已达用量上限/i.test(typeof error==='string'?error:String(error?.code||'')+' '+String(error?.type||'')+' '+String(error?.message||''));
}
function checkBillingFailure(value){if(isBillingFailure(value))throw new OpenAIBillingError();}
export function requireAvailableBilling(state){
  if(state?.billingRequired||Object.values(state?.sources||{}).some(r=>[r.error,r.researchError,r.reconstructionError].some(isBillingFailure)))throw new OpenAIBillingError();
}
export function clearBillingFailure(state){
  delete state.billingRequired;
  for(const record of Object.values(state.sources||{})){
    let research=false;
    for(const field of ['error','researchError','reconstructionError'])if(isBillingFailure(record[field])){delete record[field];if(field!=='reconstructionError')research=true;}
    if(research){record.attempts=0;delete record.lastResearchQuestion;}
  }
}
export async function openAIResponse(send,url,options){
  try{const response=await send(url,options);if(!response.ok)checkBillingFailure(await response.clone().json().catch(()=>null));return response;}
  catch(error){
    if(error instanceof OpenAIBillingError)throw error;
    options.signal?.throwIfAborted();
    if(error.name==='TimeoutError'||error.name==='AbortError')throw error;
    const code=error.cause?.code||error.code||error.name;
    throw Error('OpenAI 连接中断'+(/^[A-Z_]{3,60}$/.test(code)?'（'+code+'）':'')+'。');
  }
}
export async function readOpenAIResponse(response,signal,onEvent){
  if(!response.headers.get('content-type')?.includes('text/event-stream')){const result=await response.json();checkBillingFailure(result);return result;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',terminal;
  function event(block){
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    const value=JSON.parse(data);
    onEvent?.(value);
    checkBillingFailure(value);if(value.response)checkBillingFailure(value.response);
    if(['response.completed','response.incomplete','response.failed'].includes(value.type))terminal=value.response;
    if(value.type==='error')throw Error('OpenAI 流式任务失败：'+String(value.message||value.error?.message||'未知错误').slice(0,500));
  }
  try{
    for(;;){
      signal?.throwIfAborted();const {value,done}=await reader.read();
      pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
      let match;while((match=/\r?\n\r?\n/.exec(pending))){event(pending.slice(0,match.index));pending=pending.slice(match.index+match[0].length);}
      if(terminal){await reader.cancel();return terminal;}
      if(done){event(pending);if(terminal)return terminal;break;}
    }
    throw Error('OpenAI 流式连接结束，但未收到完整结果。');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// A stream may fail after successful HTTP headers. Keep send + terminal read in
// the same attempt so a billing error at either point can use the next key.
export async function requestOpenAI(send,env,options,onEvent){
  if(!runSink(env)||env[workflowTools])return executeCall(send,env,options,onEvent);
  const parsed=JSON.parse(options.body),stage=parsed.text?.format?.name||'response';
  const relay=env[localCodex];
  const ctx={stage,provider:relay?'local-codex':'openai-api',model:relay?(relay.model||mainLocalModel):parsed.model,
    effort:relay?relay.effort:parsed.reasoning?.effort};
  const started=Date.now(),elapsed=()=>Date.now()-started;
  track(env,'ai.start',ctx);
  const heartbeat=setInterval(()=>track(env,'ai.wait',{...ctx,durationMs:elapsed()}),30000);heartbeat.unref?.();
  try{const out=await executeCall(send,env,options,event=>{
    if(['formbench.codex.turn-started','formbench.codex.search','response.web_search_call.completed'].includes(event.type))track(env,'ai.activity',{...ctx,kind:event.type});
    onEvent?.(event);
  });const u=out.result?.usage||{};track(env,'ai.finish',{...ctx,durationMs:elapsed(),statusCode:out.response.status,status:out.result?.status,inputTokens:u.input_tokens,outputTokens:u.output_tokens});return out;
  }catch(e){track(env,'ai.failed',{...ctx,reason:e.quotaExhausted?'codex-quota':e.actionRequired||e.name,durationMs:elapsed()});throw e;}finally{clearInterval(heartbeat);}
}
async function executeCall(send,env,options,onEvent){
  if(hasLocalCodex(env)){
    const {requestLocalCodex}=await import('./local-codex-relay.mjs');
    const result=await requestLocalCodex(env[localCodex],options,onEvent);
    return {response:new Response(null),result};
  }
  const workflow=env[workflowTools];
  if(workflow)return workflow.run(options,next=>requestOpenAI(send,workflow.baseEnv,next,onEvent));
  const pool=openAIKeyPool(env),attempted=new Set();
  if(!pool.credentials.length)throw Error('OpenAI API 密钥尚未配置。');
  const available=()=>pool.credentials.filter(c=>!pool.exhausted.has(c.value)&&!attempted.has(c.value));
  const choose=()=>{const choices=available();return choices.find(c=>c.value===pool.preferred)||choices[0];};
  for(;;){
    options.signal?.throwIfAborted();
    const credential=choose();
    if(!credential)throw new OpenAIBillingError();
    attempted.add(credential.value);
    const headers=new Headers(options.headers);headers.set('Authorization','Bearer '+credential.value);
    try{
      const response=await openAIResponse(send,'https://api.openai.com/v1/responses',{...options,headers});
      if(!response.ok)return {response};
      const result=await readOpenAIResponse(response,options.signal,onEvent);
      if(!pool.exhausted.has(credential.value))pool.preferred=credential.value;
      return {response,result};
    }catch(error){
      options.signal?.throwIfAborted();
      if(error.actionRequired!=='api-billing')throw error;
      pool.exhausted.add(credential.value);pool.until.set(credential.value,Date.now()+15*60_000);
      track(env,'api.key.exhausted',{keySlot:pool.credentials.findIndex(c=>c.value===credential.value)+1});
      if(pool.preferred===credential.value)pool.preferred=null;
      const next=choose();
      if(!next)throw new OpenAIBillingError();
      onEvent?.({type:'formbench.key_switch',from:credential.name,to:next.name,reason:'billing'});
    }
  }
}

export function responseTrace(env,stage){
  if(env.FORMBENCH_TRACE_API!=='1')return undefined;
  let last=0,outputCharacters=0;
  return event=>{
    if(event.type?.startsWith('formbench.codex.')){
      const {provider,id,model,reasoning,usage}=event.response||{};
      console.info(JSON.stringify({stage,event:event.type,at:new Date().toISOString(),provider,id,model,reasoning,usage,reason:event.reason,inputCharacters:event.inputCharacters,imageCount:event.imageCount,exit:event.exit}));return;
    }
    if(event.type==='formbench.key_switch'){
      console.info(JSON.stringify({stage,event:event.type,at:new Date().toISOString(),from:event.from,to:event.to,reason:event.reason}));return;
    }
    if(event.type==='response.output_text.delta')outputCharacters+=event.delta?.length||0;
    if(event.type==='response.created'||event.type==='response.completed'||event.type==='response.incomplete'||event.type==='response.failed'||event.type==='error'||Date.now()-last>30000){
      last=Date.now();console.info(JSON.stringify({stage,event:event.type,at:new Date().toISOString(),id:event.response?.id,model:event.response?.model,outputCharacters,reasoning:event.response?.reasoning,usage:event.response?.usage}));
    }
  };
}

export function responseSourceUrls(response){
  const urls=new Set();
  const add=value=>{try{const url=new URL(value);url.hash='';if(url.protocol==='https:')urls.add(url.href);}catch{}};
  for(const item of response.output||[]){
    for(const source of item.action?.sources||[])add(source.url);
    if(item.action?.type==='open_page'||item.type==='web_search'&&item.action?.type==='find_in_page')add(item.action.url);
    for(const content of item.content||[])for(const citation of content.annotations||[])add(citation.url);
  }
  return urls;
}
