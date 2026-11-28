import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {setTimeout as wait} from 'node:timers/promises';
import {designProviders,quotaRoute,routedDiscussion} from './design-provider.mjs';import {designJobs,resumeRunningJobs} from './design-jobs.mjs';import {hasLocalCodex,requestOpenAI,routineLookupEnv} from './openai-response.mjs';import {debugSink} from './debug-log.mjs';import {userProgress} from '../consumer-progress.js';
const base={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture',FORMBENCH_ALLOW_LOCAL_CODEX:'1',FORMBENCH_LOCAL_CODEX_BIN:process.execPath};const quota={error:'no credits',actionRequired:'api-billing',retryable:false};
const req=(path,body)=>new Request('http://localhost'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
test('automatic route preserves the identical saved job when API credit is exhausted, then exits once on local quota',async t=>{const dir=await mkdtemp(join(tmpdir(),'bench-route-'));t.after(()=>rm(dir,{recursive:true,force:true}));const env={...base,FORMBENCH_JOB_DIR:dir},calls=[];
 const run=async(r,e,_f,j)=>{calls.push([j.id,hasLocalCodex(e)]);if(calls.length===1){j.state.evidenceMarker='saved';return Response.json(quota,{status:402});}assert.equal(j.state.evidenceMarker,'saved');return Response.json({error:'local exhausted',quotaExhausted:true,retryable:false},{status:429});};
 const init=await designJobs(req('/api/design-jobs',{prompt:'桌面上的小型提示灯'}),env,{run});assert.equal(init.status,202);const {id}=await init.json();let saved;const end=Date.now()+9000;do{await wait(80);saved=JSON.parse(await readFile(join(dir,id,'job.json'),'utf8'));}while(saved.status==='running'&&Date.now()<end);
 assert.equal(saved.status,'failed');assert.equal(saved.result.actionRequired,'providers-exhausted');assert.equal(saved.policy,'auto');assert.deepEqual(calls,[[id,false],[id,true]]);assert.deepEqual(await resumeRunningJobs(env,{run}),[]);
});
test('temporary limits, bad credentials and pinned providers never silently change backend',()=>{for(const data of [{error:'rate limit',retryable:true},{error:'invalid api key'},{}])assert.equal(quotaRoute('auto','openai-api',data,base),null);assert.equal(quotaRoute('openai-api','openai-api',quota,base),null);assert.equal(quotaRoute('auto','openai-api',quota,{...base,FORMBENCH_ALLOW_LOCAL_CODEX:'0'}),null);});
test('clarification uses the same policy and preserves the typed request',async()=>{const providers=[];const result=await routedDiscussion(req('/api/design',{prompt:'example'}),base,{run:async(r,e)=>{providers.push(hasLocalCodex(e));assert.equal((await r.json()).prompt,'example');return hasLocalCodex(e)?Response.json({answer:'ok'}):Response.json(quota,{status:402});}});assert.deepEqual(providers,[false,true]);assert.equal((await result.json()).answer,'ok');});

const lunaPolicy='local-codex-luna-max';
test('Luna Max is an explicit choice only when the local relay is available',async t=>{
 const choices=designProviders(base);
 assert.deepEqual(choices.map(choice=>choice.id),['openai-api','local-codex']);
 assert.equal(choices[1].lunaMax,true);
 const directory=await mkdtemp(join(tmpdir(),'bench-disabled-luna-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const disabled={...base,FORMBENCH_ALLOW_LOCAL_CODEX:'0',FORMBENCH_JOB_DIR:directory};
 assert.ok(!designProviders(disabled).some(choice=>choice.lunaMax));
 const response=await designJobs(req('/api/design-jobs',{prompt:'Fixture lamp',provider:lunaPolicy}),disabled,
   {run:()=>assert.fail('An unavailable choice started a job')});
 assert.equal(response.status,409);
});

async function finishedJob(directory,id){
 const path=join(directory,id,'job.json'),end=Date.now()+8000;
 let saved;
 do{
   saved=JSON.parse(await readFile(path,'utf8'));
   if(saved.status!=='running')return saved;
   await wait(20);
 }while(Date.now()<end);
 assert.fail('Job was still running at the fixture deadline: '+id);
}

test('Luna Max keeps the local backend and both CLI stages pinned across retry and startup restore',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bench-luna-route-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const binary=join(directory,'fixture-codex');
 await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
const option=key=>args[args.indexOf(key)+1];
fs.readFileSync(0);
const model=option('--model'),setting=args.find(value=>value.startsWith('model_reasoning_effort='));
fs.writeFileSync(option('--output-last-message'),JSON.stringify({model,effort:JSON.parse(setting.split('=')[1])}));
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'turn.completed',usage:{}}));`,{mode:0o700});
 const firstEnv={...base,FORMBENCH_JOB_DIR:directory,FORMBENCH_LOCAL_CODEX_BIN:binary,
   FORMBENCH_LOCAL_CODEX_EFFORT:'high',FORMBENCH_LOCAL_CODEX_LOOKUP_EFFORT:'low',
   FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL:'fixture-first-lookup'};
 const restartEnv={...firstEnv,FORMBENCH_LOCAL_CODEX_EFFORT:'ultra',FORMBENCH_LOCAL_CODEX_LOOKUP_EFFORT:'medium',
   FORMBENCH_LOCAL_CODEX_LOOKUP_MODEL:'fixture-restart-lookup'};
 const schema={type:'object',properties:{model:{type:'string'},effort:{type:'string'}},required:['model','effort'],additionalProperties:false};
 const options={body:JSON.stringify({input:'Read the fixture arguments.',text:{format:{type:'json_schema',strict:true,schema}}})};
 async function probe(env){
   const {result}=await requestOpenAI(()=>assert.fail('Local job attempted an API call'),env,options);
   return JSON.parse(result.output.at(-1).content[0].text);
 }
 const runs=[];
 async function run(_request,env,_send,job){
   const stages=hasLocalCodex(env)?[await probe(env),await probe(routineLookupEnv(env))]:[];
   runs.push({id:job.id,stages});
   return Response.json({paused:true,error:'Fixture checkpoint'});
 }
 const path='/api/design-jobs';
 async function postJob(provider,env){
   const response=await designJobs(req(path,{prompt:'Fixture desk lamp',provider}),env,{run});
   assert.equal(response.status,202);
   return response.json();
 }
 const job=await postJob(lunaPolicy,firstEnv);
 assert.equal(job.provider,'local-codex');
 assert.equal(job.policy,lunaPolicy);
 const saved=await finishedJob(directory,job.id);
 assert.equal(saved.status,'paused',saved.result?.error);
 assert.equal(saved.provider,'local-codex');
 assert.equal(saved.policy,lunaPolicy);
 const retry=await designJobs(req(path+'/'+job.id+'/retry',{}),restartEnv,{run});
 assert.equal(retry.status,202);
 const afterRetry=await finishedJob(directory,job.id);
 assert.equal(afterRetry.status,'paused',afterRetry.result?.error);
 assert.equal(afterRetry.policy,lunaPolicy);
 // A saved running checkpoint is what the startup scan sees after interruption.
 const checkpoint={...afterRetry,status:'running'};
 delete checkpoint.result;
 await writeFile(join(directory,job.id,'job.json'),JSON.stringify(checkpoint));
 assert.deepEqual(await resumeRunningJobs(restartEnv,{run}),[job.id]);
 const restored=await finishedJob(directory,job.id);
 assert.equal(restored.status,'paused',restored.result?.error);
 const visible=await (await designJobs(req(path+'/'+job.id),restartEnv,{run})).json();
 assert.equal(visible.provider,'local-codex');
 assert.equal(visible.policy,lunaPolicy);
 const fixed={model:'gpt-6-luna',effort:'max'};
 assert.deepEqual(runs,Array.from({length:3},()=>({id:job.id,stages:[fixed,fixed]})));

 const regular=await postJob('local-codex',restartEnv);
 assert.equal((await finishedJob(directory,regular.id)).status,'paused');
 assert.deepEqual(runs.at(-1),{id:regular.id,stages:[
   {model:'gpt-6.2-sol',effort:'ultra'},{model:'fixture-restart-lookup',effort:'medium'}
 ]});
 const automatic=await postJob(undefined,restartEnv);
 assert.equal(automatic.provider,'openai-api');
 assert.equal((await finishedJob(directory,automatic.id)).status,'paused');
 assert.deepEqual(runs.at(-1),{id:automatic.id,stages:[]});
});
test('debug collector records only operational fields and human progress does not reveal review rounds',async t=>{const dir=await mkdtemp(join(tmpdir(),'bench-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));const lines=[],id=randomUUID();await writeFile(join(dir,'2020-01-01.jsonl'),'old');const sink=debugSink({FORMBENCH_DEBUG:'1',FORMBENCH_DEBUG_DIR:dir},id,{now:()=>new Date('2026-11-26T14:00:00Z'),output:s=>lines.push(s)});sink('ai.waiting',{provider:'local-codex',durationMs:30000,model:'sk-fake-credential',prompt:'private',url:'https://private.example'});const f=join(dir,'2026-11-26.jsonl');assert.equal((await readFile(f,'utf8')).trim(),lines[0]);assert.doesNotMatch(lines[0],/private|sk-fake/);assert.equal(JSON.parse(lines[0]).id,id);assert.equal((await stat(f)).mode&0o777,0o600);await assert.rejects(stat(join(dir,'2020-01-01.jsonl')),{code:'ENOENT'});assert.doesNotMatch(JSON.stringify(userProgress({stage:'repairing',attempt:6,message:'第六轮debug'})),/debug|六轮/);});
