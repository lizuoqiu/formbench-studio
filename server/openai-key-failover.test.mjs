import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredOpenAIKeys,hasOpenAIKey,resetOpenAIKeyPool} from './openai-keys.mjs';
import {requestOpenAI,isBillingFailure} from './openai-response.mjs';
import {structuredCall,format} from './design-review.mjs';
import {researchPart} from './part-sourcing.mjs';
import {capabilities} from './runtime.mjs';
import {catalog} from './catalog.mjs';
import {designJobs} from './design-jobs.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const environment=()=>({OPENAI_API_KEY:'fixture-primary-secret',OPENAI_API_KEY_2:'fixture-backup-secret',OPENAI_MODEL:'chosen-model'});
const options=()=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'chosen-model',reasoning:{effort:'max'},input:'Keep this exact request',stream:true}),signal:new AbortController().signal});
const authorization=opts=>new Headers(opts.headers).get('Authorization');
const quota=()=>Response.json({error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'You have no credits remaining.'}},{status:429});
const completed=(value={ok:true})=>({status:'completed',model:'chosen-model',reasoning:{effort:'max'},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const stream=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const billing=e=>e.actionRequired==='api-billing';

test('numbered keys preserve the primary, sort numerically, ignore blanks and deduplicate secret values',async()=>{
 const env={OPENAI_API_KEY:' primary ',OPENAI_API_KEY_2:'backup',OPENAI_API_KEY_3:'primary',OPENAI_API_KEY_10:'third',OPENAI_API_KEY_4:' ',OPENAI_MODEL:'configured',OPENAI_API_KEY_note:'not a key'};
 assert.deepEqual(configuredOpenAIKeys(env),[{name:'OPENAI_API_KEY',value:'primary'},{name:'OPENAI_API_KEY_2',value:'backup'},{name:'OPENAI_API_KEY_10',value:'third'}]);
 assert.equal(env.OPENAI_API_KEY,' primary ');assert.equal(hasOpenAIKey({OPENAI_API_KEY_2:'backup'}),true);
 assert.equal((await capabilities({OPENAI_API_KEY_2:'backup',OPENAI_MODEL:'configured'}).json()).ai,true);
 assert.equal(hasOpenAIKey({OPENAI_API_KEY:' ',OPENAI_API_KEY_2:''}),false);
});

test('HTTP quota failure switches the identical request and later calls stay on the working key',async()=>{
 const env=environment(),seen=[],events=[],original=options();
 const send=async(url,opts)=>{seen.push({url,key:authorization(opts),body:opts.body});return authorization(opts).endsWith(env.OPENAI_API_KEY)?quota():Response.json(completed());};
 const result=await requestOpenAI(send,env,original,e=>events.push(e));
 assert.equal(result.result.status,'completed');assert.equal(seen.length,2);assert.equal(seen[0].body,seen[1].body);
 assert.equal(seen[0].key,'Bearer '+env.OPENAI_API_KEY);assert.equal(seen[1].key,'Bearer '+env.OPENAI_API_KEY_2);
 assert.equal(original.headers.Authorization,undefined);
 await requestOpenAI(send,env,options());assert.equal(seen.length,3);assert.equal(seen[2].key,seen[1].key);
 assert.deepEqual(events,[{type:'formbench.key_switch',from:'OPENAI_API_KEY',to:'OPENAI_API_KEY_2',reason:'billing'}]);
 for(const key of [env.OPENAI_API_KEY,env.OPENAI_API_KEY_2])assert.equal(JSON.stringify(events).includes(key),false);
});

test('a quota failure after partial SSE output retries the request, never accepts partial output',async()=>{
 const env=environment(),bodies=[];
 const send=async(_url,opts)=>{bodies.push(opts.body);return authorization(opts).endsWith(env.OPENAI_API_KEY)?stream([
  {type:'response.output_text.delta',delta:'{"wrong":'},
  {type:'response.failed',response:{status:'failed',error:{code:'project_spend_limit_exceeded',message:'Project spend limit reached'}}}
 ]):stream([{type:'response.completed',response:completed({correct:true})}]);};
 const {result}=await requestOpenAI(send,env,options());
 assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.deepEqual(JSON.parse(result.output[0].content[0].text),{correct:true});
});

test('JSON and SSE billing codes all switch, including code-only terminal failures',async()=>{
 for(const code of ['insufficient_quota','billing_hard_limit_reached','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded']){
  assert.equal(isBillingFailure({error:{code}}),true);
  for(const failure of [()=>Response.json({status:'failed',error:{code}}),()=>stream([{type:'error',code}])]){
   let calls=0;const {result}=await requestOpenAI(async()=>++calls===1?failure():Response.json(completed()),environment(),options());
   assert.equal(calls,2);assert.equal(result.status,'completed');
  }
 }
});

test('each distinct exhausted key is attempted once; explicit recovery or a new key permits progress',async()=>{
 const env={...environment(),OPENAI_API_KEY_3:'fixture-primary-secret'},seen=[];
 const send=async(_u,o)=>{seen.push(authorization(o));return quota();};
 await assert.rejects(()=>requestOpenAI(send,env,options()),billing);assert.equal(seen.length,2);
 await assert.rejects(()=>requestOpenAI(send,env,options()),billing);assert.equal(seen.length,2);
 env.OPENAI_API_KEY_4='new-authorized-fixture';
 const after=await requestOpenAI(async(_u,o)=>{seen.push(authorization(o));return Response.json(completed());},env,options());
 assert.equal(after.result.status,'completed');assert.equal(seen.at(-1),'Bearer new-authorized-fixture');
 resetOpenAIKeyPool(env);
 await requestOpenAI(async(_u,o)=>{seen.push(authorization(o));return Response.json(completed());},env,options());
 assert.equal(seen.at(-1),'Bearer '+env.OPENAI_API_KEY);
});

test('in-flight steps may finish, but new concurrent work skips the exhausted key',async()=>{
 const env=environment(),seen=[];let release,started=0;
 const allStarted=new Promise(resolve=>{release=resolve;});
 const send=async(_u,o)=>{
  const key=authorization(o);seen.push(key);
  if(key.endsWith(env.OPENAI_API_KEY)){if(++started===3)release();await allStarted;return quota();}
  return Response.json(completed());
 };
 await Promise.all(Array.from({length:3},()=>requestOpenAI(send,env,options())));
 assert.equal(seen.filter(k=>k==='Bearer '+env.OPENAI_API_KEY).length,3);assert.equal(seen.length,6);
 await requestOpenAI(send,env,options());assert.equal(seen.at(-1),'Bearer '+env.OPENAI_API_KEY_2);assert.equal(seen.length,7);
});

test('ordinary throttling, auth, model access and server errors do not rotate keys',async()=>{
 for(const [status,code]of [[429,'rate_limit_exceeded'],[429,'slow_down'],[401,'invalid_api_key'],[403,'permission_denied'],[404,'model_not_found'],[500,'server_error']]){
  let calls=0;const output=await requestOpenAI(async()=>{calls++;return Response.json({error:{code}},{status});},environment(),options());
  assert.equal(calls,1);assert.equal(output.response.status,status);assert.equal(output.result,undefined);
  assert.equal((await output.response.json()).error.code,code);
 }
});

test('network failure and user cancellation do not trigger a backup request',async()=>{
 let calls=0;await assert.rejects(()=>requestOpenAI(async()=>{calls++;throw Error('connection failed');},environment(),options()),/OpenAI 连接中断/);assert.equal(calls,1);
 const controller=new AbortController();calls=0;
 await assert.rejects(()=>requestOpenAI(async()=>{calls++;controller.abort();return quota();},environment(),{...options(),signal:controller.signal}),{name:'AbortError'});assert.equal(calls,1);
});

test('structured generation keeps the selected model, max reasoning and schema through failover',async()=>{
 const env=environment(),calls=[];
 const out=await structuredCall(async(_u,o)=>{calls.push({key:authorization(o),body:JSON.parse(o.body)});return calls.length===1?quota():Response.json(completed({design:'fixture'}));},env,new AbortController().signal,
  {input:'fixture',text:format('hardware_design',{type:'object',properties:{design:{type:'string'}},required:['design'],additionalProperties:false})},'fixture');
 assert.deepEqual(out.value,{design:'fixture'});assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body);
 assert.equal(calls[1].body.model,'chosen-model');assert.equal(calls[1].body.reasoning.effort,'max');
 assert.equal(calls[1].body.max_output_tokens,65536);
});

test('per-part research also switches keys and retains only actual cited product sources',async()=>{
 const url='https://vendor.example/model-1';let calls=0;
 const answer=completed({model:'Vendor M1',productUrl:url,productEvidence:'Matched',sourceUrl:url,sourceQuote:'10 mm',detail:'Source dimensions',extentMm:[],cadUrl:'',cadAuthority:'none',cadSearch:'No downloadable model'});
 answer.output.unshift({type:'web_search_call',status:'completed',action:{sources:[{url}]}});
 const result=await researchPart({name:'Fixture module',model:'Vendor M1'},environment(),async()=>++calls===1?quota():Response.json(answer),new AbortController().signal);
 assert.equal(calls,2);assert.equal(result.productUrl,url);assert.equal(result.model,'Vendor M1');
});

test('product lookup uses backup keys and returns neither credentials nor an unverified URL',async()=>{
 const env=environment(),url='https://item.taobao.com/item.htm?id=123';let calls=0;
 const result=completed();result.output.unshift({type:'web_search_call',action:{sources:[{url,title:'Fixture product'}]}});
 const response=await catalog(new Request('http://localhost/api/catalog',{method:'POST',body:JSON.stringify({name:'fixture',spec:'10 mm'})}),env,
  async()=>++calls===1?quota():Response.json(result));
 const json=await response.json();assert.equal(response.status,200);assert.equal(calls,2);assert.equal(json.candidates[0].url,url);
 for(const key of [env.OPENAI_API_KEY,env.OPENAI_API_KEY_2])assert.equal(JSON.stringify(json).includes(key),false);
});

test('a persisted design job continues through quota failover without losing its draft',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-key-job-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={...environment(),FORMBENCH_JOB_DIR:dir};let calls=0;
 const run=async(_req,e,_send,w)=>{
  w.state.draft={attempt:4,value:{name:'saved fixture',parts:[]}};w.state.sources={fixture:{productUrl:'https://vendor.example/fixture'}};
  const result=await structuredCall(async()=>++calls===1?quota():Response.json(completed({name:'finished fixture',parts:[]})),e,new AbortController().signal,
   {input:'fixture',text:format('hardware_design',{type:'object',properties:{},additionalProperties:false,required:[]})},'fixture');
  assert.equal(w.state.draft.attempt,4);return Response.json({design:result.value});
 };
 const created=await(await designJobs(new Request('http://localhost/api/design-jobs',{method:'POST',body:JSON.stringify({prompt:'A persisted failover fixture'})}),env,{run})).json();
 let job;const deadline=Date.now()+3000;
 do{await new Promise(resolve=>setTimeout(resolve,10));job=await(await designJobs(new Request('http://localhost/api/design-jobs/'+created.id),env,{run})).json();}while(job.status==='running'&&Date.now()<deadline);
 assert.equal(job.status,'complete');assert.equal(calls,2);assert.equal(job.design.name,'finished fixture');
 const saved=await readFile(join(dir,created.id,'job.json'),'utf8'),record=JSON.parse(saved);
 assert.equal(record.state.draft.attempt,4);assert.equal(record.state.sources.fixture.productUrl,'https://vendor.example/fixture');
 for(const key of [env.OPENAI_API_KEY,env.OPENAI_API_KEY_2])assert.equal(saved.includes(key),false);
});
