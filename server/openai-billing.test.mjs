import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAIResponse,readOpenAIResponse,OpenAIBillingError,isBillingFailure,requireAvailableBilling,clearBillingFailure} from './openai-response.mjs';
import {sourceParts} from './part-sourcing.mjs';
import {reconstructParts} from './part-reconstruction.mjs';
import {partIdentity} from '../part-records.js';
import {design} from './design.mjs';
import {designJobs} from './design-jobs.mjs';

const billing={code:'insufficient_quota',message:'You have no credits remaining.'};
const isBilling=e=>e.actionRequired==='api-billing';
const stream=value=>new Response('data: '+JSON.stringify(value)+'\n\n',{headers:{'content-type':'text/event-stream'}});
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('HTTP quota exhaustion and rate limits remain different failures',async()=>{
 await assert.rejects(()=>openAIResponse(async()=>Response.json({error:billing},{status:429}),'https://example.test',{}),isBilling);
 const response=await openAIResponse(async()=>Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},{status:429}),'https://example.test',{});
 assert.equal(response.status,429);assert.equal((await response.json()).error.code,'rate_limit_exceeded');
 assert.equal(isBillingFailure('model_not_found'),false);
});

test('stream errors, failed responses and JSON failures preserve the billing classification',async()=>{
 for(const response of [stream({type:'error',...billing}),stream({type:'response.failed',response:{status:'failed',error:billing}}),Response.json({status:'failed',error:billing})])
  await assert.rejects(()=>readOpenAIResponse(response),isBilling);
 await assert.rejects(()=>readOpenAIResponse(stream({type:'error',code:'server_error',message:'Temporary service failure'})),e=>!isBilling(e)&&/Temporary service/.test(e.message));
});

test('sourcing drains active work but does not launch the remaining queue after billing fails',async()=>{
 const parts=Array.from({length:6},(_,i)=>({name:'module '+i,model:'Fixture module '+i,kind:'purchase',placement:'mounted'})),cache={},started=[];
 await assert.rejects(()=>sourceParts(parts,cache,{},null,new AbortController().signal,()=>{},null,{
  research:async p=>{started.push(p.name);await wait(p.name==='module 0'?5:25);if(p.name==='module 0')throw new OpenAIBillingError();return{model:p.model,productUrl:'https://vendor.example/'+p.index,cadAuthority:'none'};},
  fetchSource:async()=>({})
 }),isBilling);
 assert.deepEqual(started,['module 0','module 1','module 2']);
 assert.equal(cache[partIdentity(parts[1])].productStatus,'retrieved');assert.equal(cache[partIdentity(parts[2])].productStatus,'retrieved');
 assert.ok(isBillingFailure(cache[partIdentity(parts[0])].error));assert.equal(cache[partIdentity(parts[3])],undefined);
});

test('independent part reconstruction stops quota failures without retrying each part',async()=>{
 const parts=Array.from({length:6},(_,i)=>({name:'fixture '+i,model:'Fixture geometric part '+i,kind:'purchase',placement:'mounted'}));
 const cache=Object.fromEntries(parts.map(p=>[partIdentity(p),{model:p.model}]));let calls=0;
 await assert.rejects(()=>reconstructParts(parts,cache,{OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},async()=>{calls++;await wait(5);return Response.json({error:billing},{status:429});},new AbortController().signal),isBilling);
 assert.equal(calls,3);assert.equal(cache[partIdentity(parts[3])].reconstructionError,undefined);
});

test('saved billing failures need an explicit retry and preserve the saved design and models',()=>{
 const model={features:[{shape:'box'}]},draft={attempt:4,value:{name:'Saved design'}};
 const state={billingRequired:true,draft,sources:{a:{model:'A',attempts:2,error:billing.message,reconstruction:model,lastResearchQuestion:'Q'},b:{model:'B',cadError:'Download unavailable',attempts:2}}};
 assert.throws(()=>requireAvailableBilling(state),isBilling);
 clearBillingFailure(state);assert.doesNotThrow(()=>requireAvailableBilling(state));
 assert.equal(state.draft,draft);assert.equal(state.sources.a.reconstruction,model);assert.equal(state.sources.a.attempts,0);
 assert.equal(state.sources.a.lastResearchQuestion,undefined);assert.equal(state.sources.b.cadError,'Download unavailable');assert.equal(state.sources.b.attempts,2);
});

test('resuming an exhausted job reports an action requirement without sending another API request',async()=>{
 const draft={attempt:4,value:{name:'Retained draft'}},state={draft,sources:{a:{model:'A',error:billing.message}}};let calls=0;
 const response=await design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'A complete test device'})}),
  {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},async()=>{calls++;throw Error('Unexpected paid request');},{state,progress:async()=>{}});
 assert.equal(response.status,402);assert.equal((await response.json()).actionRequired,'api-billing');assert.equal(calls,0);assert.equal(state.draft,draft);assert.equal(state.billingRequired,true);
});

test('job scheduler does not retry billing failures until an explicit resume',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-billing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir};let calls=0;
 const run=async(_request,_env,_send,w)=>{
  calls++;if(calls===1){w.state.billingRequired=true;w.state.sources={a:{model:'A',error:billing.message,attempts:1}};return Response.json({error:'Billing action required',actionRequired:'api-billing'},{status:402});}
  assert.equal(w.state.billingRequired,undefined);assert.equal(w.state.sources.a.error,undefined);return Response.json({design:{name:'Finished fixture',parts:[]}});
 };
 const req=(path='',body)=>new Request('http://localhost/api/design-jobs'+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
 const first=await(await designJobs(req('',{prompt:'A billing recovery test'}),env,{run})).json();await wait(1250);
 const failed=await(await designJobs(req('/'+first.id),env,{run})).json();
 assert.equal(failed.status,'failed');assert.equal(failed.actionRequired,'api-billing');assert.equal(calls,1);
 await designJobs(req('/'+first.id+'/retry',{}),env,{run});await wait(100);
 assert.equal((await(await designJobs(req('/'+first.id),env,{run})).json()).status,'complete');assert.equal(calls,2);
});
