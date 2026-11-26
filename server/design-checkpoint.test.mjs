import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {designJobs} from './design-jobs.mjs';
import {hasLocalCodex} from './openai-response.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=(path,body)=>new Request('http://localhost/api/design-jobs'+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
const finishedRound={attempt:6,issues:['安装仍有干涉。']};

test('an explicit Codex relay retry preserves the saved API draft and leaves new jobs on API',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-codex-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const env={FORMBENCH_JOB_DIR:dir,FORMBENCH_LOCAL_CODEX_JOB_ID:id,FORMBENCH_LOCAL_CODEX_BIN:process.execPath};
 const draft={attempt:8,model:'gpt-6.2-sol',value:{name:'Saved API draft'},revision:{operations:[{op:'add',path:'/parts/-'}]}};
 const state={draft,repair:{attempt:8,research:[]},generationRecovery:{attempt:8,partialOutput:'retained'},nextAttempt:8,billingRequired:true};
 await writeFile(join(folder,'job.json'),JSON.stringify({id,status:'failed',input:{prompt:'A desktop arm'},result:{actionRequired:'api-billing'},state}));
 await writeFile(join(folder,'control.json'),JSON.stringify({pauseAfterAttempt:8}));
 const calls=[];
 const run=async(_request,runEnv,_send,workflow)=>{
  calls.push({id:workflow.id,relay:hasLocalCodex(runEnv)});
  if(workflow.id!==id){assert.equal(runEnv,env);return Response.json({design:{parts:[]}});}
  assert.deepEqual(workflow.state.draft,draft);
  assert.deepEqual(workflow.state.repair,state.repair);
  assert.deepEqual(workflow.state.generationRecovery,state.generationRecovery);
  assert.equal(workflow.state.billingRequired,undefined);
  assert.equal(await workflow.shouldPause(8),false);
  return Response.json({error:'Model capacity unavailable',actionRequired:'local-codex-unavailable',retryable:false},{status:424});
 };
 assert.equal((await designJobs(request('/'+id+'/retry',{}),env,{run})).status,202);
 const fresh=await(await designJobs(request('',{prompt:'A different design'}),env,{run})).json();
 await wait(1250);
 const resumed=await(await designJobs(request('/'+id),env,{run})).json();
 assert.equal(resumed.status,'failed');assert.equal(resumed.actionRequired,'local-codex-unavailable');
 assert.deepEqual(calls,[{id,relay:true},{id:fresh.id,relay:false}]);
 assert.deepEqual(JSON.parse(await readFile(join(folder,'job.json'),'utf8')).state.draft,draft);
});

test('a saved completed-round checkpoint prevents read-only polling from starting the next paid round after restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-checkpoint-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir},id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const state={rounds:[finishedRound],nextAttempt:7,lastDraft:{name:'Preserved draft'},candidate:{name:'Not accepted',parts:[]}};
 await writeFile(join(folder,'job.json'),JSON.stringify({id,status:'running',input:{prompt:'Test arm'},state,progress:{stage:'repairing',attempt:6}}));
 await writeFile(join(folder,'control.json'),JSON.stringify({pauseAfterAttempt:6}));
 let calls=0;const run=async()=>{calls++;throw Error('Unexpected next-round API operation');};
 for(let i=0;i<2;i++){
  const result=await(await designJobs(request('/'+id),env,{run})).json();
  assert.equal(result.status,'paused');assert.equal(result.design,undefined);assert.equal(result.repairCandidate,undefined);assert.deepEqual(result.rounds,[finishedRound]);
 }
 assert.equal(calls,0);assert.deepEqual(JSON.parse(await readFile(join(folder,'job.json'),'utf8')).state,state);
 assert.equal((await designJobs(request('/'+id+'/cad.json'),env,{run})).status,409);
});

test('a worker pauses after its saved review, never queues another slice, and only explicit retry clears that checkpoint',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-checkpoint-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir};let calls=0,release;
 const ready=new Promise(resolve=>{release=resolve;});
 const run=async(_request,_env,_send,w)=>{
  if(++calls===1){
   await ready;w.state.rounds=[finishedRound];w.state.nextAttempt=7;w.state.lastDraft={name:'Saved geometry'};
   await w.progress({stage:'repairing',attempt:6,message:'Review saved'});
   assert.equal(await w.shouldPause(5),false);assert.equal(await w.shouldPause(6),true);
   return Response.json({paused:true,error:'Paused at review checkpoint'},{status:202});
  }
  assert.equal(await w.shouldPause(7),false);assert.equal(w.state.nextAttempt,7);assert.equal(w.state.lastDraft.name,'Saved geometry');
  assert.deepEqual(w.state.rounds,[finishedRound]);return Response.json({design:{name:'Finished fixture',parts:[]}});
 };
 const job=await(await designJobs(request('',{prompt:'A checkpoint test'}),env,{run})).json();
 await writeFile(join(dir,job.id,'control.json'),JSON.stringify({pauseAfterAttempt:6}));release();await wait(1250);
 for(let i=0;i<2;i++)assert.equal((await(await designJobs(request('/'+job.id),env,{run})).json()).status,'paused');
 assert.equal(calls,1);
 await designJobs(request('/'+job.id+'/retry',{}),env,{run});await wait(80);
 assert.equal((await(await designJobs(request('/'+job.id),env,{run})).json()).status,'complete');assert.equal(calls,2);
});

test('an explicit paused preview reads the saved design and solids without publishing, mutating or resuming the task',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir},id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const candidate={name:'Unaccepted arm',parts:[{name:'Cover'}],cadPlan:{version:1,bodies:[]}},cad={engine:'Fixture compiler',bodies:[],cadPlan:candidate.cadPlan};
 const job={id,status:'paused',input:{prompt:'Test arm'},state:{rounds:[finishedRound],nextAttempt:7,candidate},progress:{stage:'paused',attempt:6}};
 const stored=JSON.stringify(job),control=JSON.stringify({pauseAfterAttempt:6});
 await writeFile(join(folder,'job.json'),stored);await writeFile(join(folder,'control.json'),control);await writeFile(join(folder,'cad.json'),JSON.stringify(cad));
 let calls=0;const run=async()=>{calls++;throw Error('Viewing started a paid request');};
 for(let i=0;i<2;i++){
  const result=await(await designJobs(request('/'+id+'/preview'),env,{run})).json();
  assert.equal(result.status,'paused');assert.equal(result.design,undefined);assert.deepEqual(result.preview.design,candidate);assert.equal(result.preview.attempt,6);
  const mesh=await designJobs(new Request('http://localhost'+result.preview.cadUrl),env,{run});
  assert.equal(mesh.headers.get('cache-control'),'no-store');assert.deepEqual(await mesh.json(),cad);
 }
 const normal=await(await designJobs(request('/'+id),env,{run})).json();assert.equal(normal.previewAvailable,true);assert.equal(normal.preview,undefined);assert.equal(normal.design,undefined);assert.equal(normal.repairCandidate,undefined);
 assert.equal((await designJobs(request('/'+id+'/cad.json'),env,{run})).status,409);
 assert.equal(calls,0);assert.equal(await readFile(join(folder,'job.json'),'utf8'),stored);assert.equal(await readFile(join(folder,'control.json'),'utf8'),control);
 job.status='running';await writeFile(join(folder,'job.json'),JSON.stringify(job));
 assert.equal((await designJobs(request('/'+id+'/preview'),env,{run})).status,409);assert.equal(calls,0,'the preview route never autostarts a saved task');
});

test('a bounded retry passes new user feedback and installs the next stop before work starts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-bounded-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir},id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const candidate={name:'Saved arm',parts:[{name:'Existing servo',model:'Keep this model'}],cadPlan:{bodies:[]}};
 const state={candidate,lastDraft:candidate,rounds:[finishedRound],nextAttempt:7,repair:{attempt:7,changes:['stale plan']},draft:{attempt:7},generationRecovery:{partialOutput:'stale'}};
 await writeFile(join(folder,'job.json'),JSON.stringify({id,status:'paused',input:{prompt:'A desktop arm'},state}));
 await writeFile(join(folder,'control.json'),JSON.stringify({pauseAfterAttempt:6}));
 let calls=0;
 const run=async(r,_env,_send,w)=>{
  calls++;const input=await r.json();
  assert.deepEqual(input.conversation,[{role:'user',text:'Keep the main assembly compact.'}]);
  assert.deepEqual(w.state.candidate,candidate);assert.deepEqual(w.state.lastDraft,candidate);
  assert.equal(w.state.repair,undefined);assert.equal(w.state.draft,undefined);assert.equal(w.state.generationRecovery,undefined);
  assert.equal(await w.shouldPause(6),false);assert.equal(await w.shouldPause(7),true);
  w.state.rounds.push({attempt:7,issues:['Further work needed']});w.state.nextAttempt=8;
  return Response.json({paused:true,error:'Round 7 checkpoint'},{status:202});
 };
 assert.equal((await designJobs(request('/'+id+'/retry',{pauseAfterAttempt:6}),env,{run})).status,400);
 assert.equal(calls,0);
 assert.equal((await designJobs(request('/'+id+'/retry',{instruction:'Keep the main assembly compact.',pauseAfterAttempt:7}),env,{run})).status,202);
 await wait(1250);
 const result=await(await designJobs(request('/'+id),env,{run})).json();
 assert.equal(result.status,'paused');assert.equal(calls,1);assert.equal(result.rounds.at(-1).attempt,7);
 assert.deepEqual(JSON.parse(await readFile(join(folder,'control.json'),'utf8')),{pauseAfterAttempt:7});
});

test('a paused failed compilation cannot present the previous round solids as the new revision',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-stale-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir},id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const candidate={name:'Revised arm',parts:[],cadPlan:{version:1,bodies:[{name:'New integrated base'}]}};
 const job={id,status:'paused',input:{prompt:'Test arm'},state:{candidate,rounds:[{attempt:7,issues:['CAD compilation failed']}],nextAttempt:8}};
 const cad={engine:'Fixture compiler',bodies:[],cadPlan:{version:1,bodies:[{name:'Previous external tray'}]}};
 const stored=JSON.stringify(job),oldCad=JSON.stringify(cad);
 await writeFile(join(folder,'job.json'),stored);await writeFile(join(folder,'cad.json'),oldCad);
 let calls=0;const run=async()=>{calls++;throw Error('Preview started a paid request');};
 for(const path of ['/preview','/cad.json?preview=1']){
  const result=await designJobs(request('/'+id+path),env,{run});
  assert.equal(result.status,409);assert.match((await result.json()).error,/不作为本轮预览/);
 }
 assert.equal((await(await designJobs(request('/'+id),env,{run})).json()).previewAvailable,false);
 assert.equal(calls,0);assert.equal(await readFile(join(folder,'job.json'),'utf8'),stored);
 assert.equal(await readFile(join(folder,'cad.json'),'utf8'),oldCad,'previous geometry remains available for recovery');
});

test('resuming review reuses saved CAD for the same draft and placement',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-cad-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={FORMBENCH_JOB_DIR:dir},id=randomUUID(),folder=join(dir,id);await mkdir(folder);
 const cadPlan={version:1,bodies:[{name:'Body',features:[{rotationDeg:[0,0,90]}]}]};
 const cad={engine:'ForgeCAD CLI fixture',bodies:[{name:'Body'}],cadPlan};
 await writeFile(join(folder,'job.json'),JSON.stringify({
  id,status:'failed',input:{prompt:'Test arm'},state:{draft:{attempt:7},nextAttempt:7}
 }));
 await writeFile(join(folder,'cad.json'),JSON.stringify(cad));
 let record;
 const checked=new Promise(resolve=>{record=resolve;});
 const run=async(_request,_env,_send,workflow)=>{
  const current=structuredClone(cadPlan);
  current.bodies[0].features[0].rotationDeg[1]=-0;
  const same=await workflow.loadCompiled(7,current),differentRound=await workflow.loadCompiled(8,current);
  current.bodies[0].features[0].rotationDeg[1]=1;
  record({same,differentRound,changed:await workflow.loadCompiled(7,current)});
  return Response.json({design:{name:'Test complete'}});
 };
 assert.equal((await designJobs(request('/'+id+'/retry',{}),env,{run})).status,202);
 const {same,differentRound,changed}=await checked;
 assert.deepEqual(same,cad);assert.equal(differentRound,null);assert.equal(changed,null);
 await wait(100);
});
