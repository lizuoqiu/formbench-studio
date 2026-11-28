import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {requestOpenAI,responseSourceUrls,withLocalCodex} from './openai-response.mjs';
import {researchPart} from './part-sourcing.mjs';
import {checkChoice,designProviders,providerEnv,routedDiscussion} from './design-provider.mjs';
import {format,structuredCall} from './design-review.mjs';
import {observeRun} from './run-events.mjs';

const schema={type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false};
const options=(input='research fixture',extra={})=>({body:JSON.stringify({input,
  text:{format:{type:'json_schema',schema,strict:true}},...extra})});
const fixture=async(t,implementation)=>{
  const directory=await mkdtemp(join(tmpdir(),'formbench-codex-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const binary=join(directory,'fake-codex');
  await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
const arg=name=>args[args.indexOf(name)+1];
const emit=event=>console.log(JSON.stringify(event));
const prompt=fs.readFileSync(0,'utf8');
emit({type:'thread.started',thread_id:'fixture-thread'});
${implementation}\n`,{mode:0o700});
  return withLocalCodex({OPENAI_API_KEY:'api-fixture'},{binary,effort:'ultra'});
};
const unexpectedApi=()=>assert.fail('The relay called the API');
const finish=`fs.writeFileSync(arg('--output-last-message'),JSON.stringify({url:'https://claimed.example/fake'}));
emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:7}});`;

test('routine part research uses its selected local model and targeted engineering research keeps the main model',async t=>{
 const relay=await fixture(t,`
 const model=arg('--model'),effort=args.find(value=>value.startsWith('model_reasoning_effort='));
 emit({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://maker.example/connector'}}});
 fs.writeFileSync(arg('--output-last-message'),JSON.stringify({model:'Vendor A1',detail:[model,effort].join(' ')}));
 emit({type:'turn.completed',usage:{}});`);
 const events=[];
 const env=observeRun({...relay,FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL:'gpt-6-luna'},(event,data)=>events.push({event,...data}));
 const part={name:'connector',model:'Vendor A1',kind:'purchase'};
 const first=await researchPart(part,env,unexpectedApi,new AbortController().signal);
 const focused=await researchPart({...part,researchQuestion:'Verify the pinout'},env,unexpectedApi,new AbortController().signal);
 const retry=await researchPart({...part,previousEvidence:{detail:'Unverified link'}},env,unexpectedApi,new AbortController().signal);
 assert.match(first.detail,/gpt-6-luna model_reasoning_effort="medium"/);
 assert.match(focused.detail,/gpt-6\.2-sol model_reasoning_effort="ultra"/);
 assert.equal(first.researchProvenance.model,'gpt-6-luna');
 assert.equal(retry.researchProvenance.model,focused.researchProvenance.model);
 assert.deepEqual(events.filter(row=>row.event==='ai.start').map(row=>[row.model,row.effort]),[
  ['gpt-6-luna','medium'],['gpt-6.2-sol','ultra'],['gpt-6.2-sol','ultra']]);
});

test('explicit Luna discussions, CAD stages and every sourcing call share the same scoped CLI profile',async t=>{
 const relay=await fixture(t,`
 const requestedModel=arg('--model'),requestedEffort=args.find(a=>a.startsWith('model_reasoning_effort='));
 if(args.includes('web_search="live"'))emit({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://maker.example/item'}}});
 fs.writeFileSync(arg('--output-last-message'),JSON.stringify({model:'Vendor A1',detail:[requestedModel,requestedEffort].join(' ')}));
 emit({type:'turn.completed',usage:{}});
 `);
 const base={...relay,FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL:'gpt-6.2-sol',FORMBENCH_LOCAL_CODEX_LOOKUP_EFFORT:'low'};
 const policy='local-codex-luna-max',signal=new AbortController().signal;
 assert.deepEqual(designProviders(base).map(p=>[p.id,p.lunaMax]),[['local-codex',true]]);
 assert.throws(()=>checkChoice(policy,{OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'}),{status:409});
 const answer={type:'object',properties:{model:{type:'string'},detail:{type:'string'}},required:['model','detail'],additionalProperties:false};
 const stage=(name,env)=>structuredCall(unexpectedApi,env,signal,{input:'fixture',text:format(name,answer)},name);
 function verify(receipt){
  assert.equal(receipt.provider,'local-codex');
  assert.equal(receipt.model,'gpt-6-luna');
  assert.equal(receipt.modelSource,'configured');
  assert.equal(receipt.reasoning.effort,'max');
 }
 const request=new Request('http://localhost/api/design',{method:'POST',headers:{'X-Formbench-Provider':policy},body:'{}'});
 const discussion=await routedDiscussion(request,base,{run:async(_request,env)=>{
  for(const name of ['hardware_clarification','hardware_clarification_review']){
   const response=await stage(name,env);verify(response);
   assert.equal(response.value.detail,'gpt-6-luna model_reasoning_effort="max"');
  }
  return Response.json({decision:'ready'});
 }});
 assert.equal(discussion.status,200);
 const scoped=providerEnv('local-codex',base,undefined,policy);
 for(const name of ['hardware_design','hardware_design_revision','hardware_design_review']){
  const result=await stage(name,scoped);verify(result);
  assert.equal(result.value.detail,'gpt-6-luna model_reasoning_effort="max"');
 }
 const part={name:'connector',model:'Vendor A1',kind:'purchase'};
 for(const lookup of [part,{...part,researchQuestion:'verify pinout'}]){
  const record=await researchPart(lookup,scoped,unexpectedApi,signal);
  verify(record.researchProvenance);
  assert.equal(record.detail,'gpt-6-luna model_reasoning_effort="max"');
 }
 const ordinary=await researchPart(part,base,unexpectedApi,signal);
 assert.equal(ordinary.detail,'gpt-6.2-sol model_reasoning_effort="low"');
});

test('local relay uses real native search URLs and keeps credentials, images and execution isolated',async t=>{
  const env=await fixture(t,`
const assert=require('node:assert/strict');
assert.equal(arg('--model'),'gpt-6.2-sol');
assert.equal(arg('--sandbox'),'read-only');
assert(args.includes('model_reasoning_effort="ultra"'));
assert(args.includes('web_search="live"'));
assert.equal(process.env.OPENAI_API_KEY,undefined);
assert.equal(process.env.OPENAI_API_KEY_2,undefined);
assert.equal(process.env.CODEX_API_KEY,undefined);
assert.equal(fs.readFileSync(arg('--image'),'utf8'),'image fixture');
assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(require('node:path').dirname(arg('--image'))));
assert.match(prompt,/picture notes/);
assert.match(prompt,/Attached image 1/);
assert.doesNotMatch(prompt,/base64/);
assert.equal(JSON.parse(fs.readFileSync(arg('--output-schema'))).additionalProperties,false);
emit({type:'item.started',item:{type:'web_search',action:{type:'open_page',url:'https://started.example/'}}});
emit({type:'item.completed',item:{type:'web_search',action:{type:'search',query:'https://query.example/'},results:[{url:'https://search.example/model#fragment'}]}});
emit({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://opened.example/spec'}}});
${finish}`);
  const image={type:'input_image',image_url:'data:image/png;base64,'+Buffer.from('image fixture').toString('base64')};
  const input=[{role:'user',content:[{type:'input_text',text:'picture notes'},image]}];
  const {result}=await requestOpenAI(unexpectedApi,env,options(input,{tools:[{type:'web_search'}]}));
  assert.deepEqual([...responseSourceUrls(result)],['https://search.example/model','https://opened.example/spec']);
  assert.equal(result.provider,'local-codex');
  assert.equal(result.model,'gpt-6.2-sol');
  assert.deepEqual(result.reasoning,{effort:'ultra'});
  assert.equal(result.id,'fixture-thread');
  assert.deepEqual(result.usage,{input_tokens:3,output_tokens:7});
});

test('relay refuses a completed response without required search events or after a model reroute',async t=>{
  const noSearch=await fixture(t,finish);
  await assert.rejects(requestOpenAI(unexpectedApi,noSearch,options('search',{tools:[{type:'web_search'}]})),
    {actionRequired:'local-codex-unavailable',message:/原生搜索事件/});
  const rerouted=await fixture(t,`emit({type:'item.completed',item:{type:'error',message:'model rerouted: gpt-6.2-sol -> other'}});\n${finish}`);
  await assert.rejects(requestOpenAI(unexpectedApi,rerouted,options()),{actionRequired:'local-codex-unavailable',message:/模型已切换/});
});

test('relay reports the native turn text limit before launching Codex',async t=>{
  const env=await fixture(t,'process.exit(31);');
  await assert.rejects(requestOpenAI(unexpectedApi,env,options('a'.repeat(1<<20))),
    {actionRequired:'local-codex-unavailable',message:/字符上限/});
});

test('relay timeouts stop the child with a recoverable job error and cancellation is preserved',async t=>{
  const env=await fixture(t,'setInterval(()=>{},1000);');
  await assert.rejects(requestOpenAI(unexpectedApi,env,{...options(),signal:AbortSignal.timeout(100)}),
    {actionRequired:'local-codex-unavailable',message:/请求超时/});
  const controller=new AbortController();
  const request=requestOpenAI(unexpectedApi,env,{...options(),signal:controller.signal});
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
});
