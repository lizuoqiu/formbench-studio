import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {designJobs} from './design-jobs.mjs';
import {design} from './design.mjs';
import {sourceParts,selectParts} from './part-sourcing.mjs';
import {partIdentity} from '../part-records.js';
import {materializeReconstructedParts,centerReconstruction,reconstructParts,reconstructionPlacementIssues,reconstructedGeometry,queueReconstructionRevision} from './part-reconstruction.mjs';
import {designVisuals} from './design-visuals.mjs';
import {designCoverage} from './design-coverage.mjs';
import {officialStageGuide} from './official-skills.mjs';
import {hardwarePolicyGuide} from './modeling-guide.mjs';
import {structuredCall,format} from './design-review.mjs';
import {readOpenAIResponse} from './openai-response.mjs';
import {validateCadPlan} from '../cad-plan.js';
import {makeDocumentedProxy} from '../part-geometry.js';
import {encodeSTL} from '../assembly-hardware.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const req=(path='',body)=>new Request('http://localhost/api/design-jobs'+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});

test('resuming a saved draft researches its current BOM instead of the obsolete selection',async()=>{
  const controller=new AbortController(),seen=[];
  const state={selection:{parts:[{name:'obsolete selected item',model:'OLD'}]},draft:{attempt:1,value:{parts:[{name:'current draft item',model:'NEW',kind:'provided'}]}}};
  const workflow={state,progress:async event=>{seen.push(event);if(event.stage==='sourcing'){controller.abort();throw controller.signal.reason;}}};
  const response=await design(new Request('http://localhost/api/design',{method:'POST',signal:controller.signal,body:JSON.stringify({prompt:'A complete test device'})}),
    {OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},async()=>{throw Error('No API request is expected before the sourcing checkpoint');},workflow);
  assert.equal(response.status,499);assert.equal(seen[0].message,'正在核对 current draft item');
});

test('a truncated assembly raises its budget and resumes with saved partial work',async()=>{
  const part={name:'provided item',model:'Fixture supplied module',kind:'provided',role:'external',placement:'loose'};
  const architecture=[{subsystem:'Input',rationale:'Use the supplied module',interfaces:'USB',motion:null,
    members:[{model:part.model,kind:part.kind,role:part.role,placement:part.placement}]}];
  const state={selection:{requirements:['a test design'],parts:[part],architecture}};
  const calls=[],partial='{"name":"partly returned assembly","parts":[';
  const send=async(_url,options)=>{calls.push(JSON.parse(options.body));return calls.length===1?
    Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:partial}]}]}):
    Response.json({error:{}},{status:503});};
  const run=()=>design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'A test supplied item'})}),
    {OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,{state,progress:async()=>{}});
  const first=await run();assert.equal(first.status,202);assert.equal((await first.json()).continue,true);
  assert.equal(state.assemblyOutputBudget,131072);assert.equal(state.generationRecovery.partialOutput,partial);
  await run();assert.deepEqual(calls.map(c=>c.max_output_tokens),[65536,131072]);
  for(const call of calls){
    const contract=call.input.map(item=>item.content).filter(content=>typeof content==='string'&&content.startsWith('{')).map(content=>JSON.parse(content)).find(value=>value.architecture);
    assert.deepEqual(contract?.architecture,architecture);
  }
  const recovered=JSON.parse(calls[1].input.at(-1).content);
  assert.equal(recovered.truncatedDraft,partial);assert.equal(state.candidate,undefined);
});

test('execution slices continue without user repair and preserve round history',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formbench-loop-'));t.after(()=>rm(dir,{recursive:true,force:true}));const env={FORMBENCH_JOB_DIR:dir};
  let calls=0;
  const run=async(_r,_e,_s,w)=>{calls++;w.state.rounds??=[];w.state.rounds.push({attempt:calls,issues:calls===1?['fit']:[]});return calls===1?Response.json({continue:true},{status:202}):Response.json({design:{name:'finished',parts:[]}});};
  const first=await(await designJobs(req('',{prompt:'continuous test'}),env,{run})).json();
  await wait(1250);
  const result=await(await designJobs(req('/'+first.id),env,{run})).json();
  assert.equal(result.status,'complete');assert.equal(calls,2);assert.deepEqual(result.rounds.map(r=>r.attempt),[1,2]);
});

test('cancelling between execution slices prevents a delayed restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formbench-cancel-'));t.after(()=>rm(dir,{recursive:true,force:true}));const env={FORMBENCH_JOB_DIR:dir};let calls=0;
  const run=async()=>{calls++;return Response.json({continue:true},{status:202});};
  const first=await(await designJobs(req('',{prompt:'cancel between slices'}),env,{run})).json();
  await wait(80);await designJobs(req('/'+first.id+'/cancel',{}),env,{run});await wait(1200);
  assert.equal(calls,1);assert.equal(JSON.parse(await readFile(join(dir,first.id,'job.json'))).status,'cancelled');
});

test('targeted research refreshes a cached part without losing its known product page',async()=>{
  const part={name:'motor',model:'Example M1',kind:'purchase'},key=partIdentity(part),cache={[key]:{...part,productUrl:'https://vendor.example/m1',cadUrl:'https://vendor.example/old.stl',cadAuthority:'manufacturer',cadAttempts:2,productStatus:'retrieved'}};
  let query,download;
  await sourceParts([{...part,researchQuestion:'find mounting datum'}],cache,{},null,new AbortController().signal,undefined,null,{
    research:async p=>{query=p;return{model:part.model,detail:'Mounting datum found',cadUrl:'https://vendor.example/new.stp',cadAuthority:'manufacturer'};},
    fetchSource:async()=>({}),importCad:async r=>{download=r.cadUrl;return{id:'read'};}
  });
  assert.equal(query.researchQuestion,'find mounting datum');assert.equal(download,'https://vendor.example/new.stp');assert.equal(cache[key].productUrl,'https://vendor.example/m1');
});

test('initial planning can consult current sources and records returned evidence separately from the BOM',async()=>{
  let request;
  const result=await selectParts({prompt:'a device',history:[]},{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},async(_url,options)=>{
    request=JSON.parse(options.body);
    return Response.json({status:'completed',model:'fixture',reasoning:{effort:'max'},output:[
      {type:'web_search_call',action:{sources:[{url:'https://vendor.example/architecture'}]}},
      {type:'message',content:[{type:'output_text',text:JSON.stringify({name:'fixture',summary:'test',requirements:['test'],motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},architecture:[{subsystem:'Sensing',rationale:'Reuse a matched board.',interfaces:'USB data and power',motion:null,members:[{model:'Candidate M1',kind:'purchase',role:'internal',placement:'mounted'}]}],parts:[{name:'module',model:'Candidate M1',kind:'purchase',role:'internal',placement:'mounted'}]})}]}]});
  },new AbortController().signal);
  assert.equal(request.tools[0].type,'web_search');assert.equal(request.tool_choice,'required');assert.equal(request.text.format.strict,true);
  const policy=await hardwarePolicyGuide('planning');
  assert.ok(request.instructions.includes(policy.text));assert.deepEqual(result.generation.policy,policy.skill);
  assert.deepEqual(result.generation.sourceUrls,['https://vendor.example/architecture']);assert.equal(result.parts[0].model,'Candidate M1');
  assert.equal(result.parts[0].productUrl,undefined);assert.equal(result.generation.reasoning.effort,'max');
});

test('independent geometry replaces the matching anchor with its pose and scale intact',()=>{
  const feature={shape:'box',op:'add',sizeMm:[10,20,30],centerMm:[0,0,0],rotationDeg:[0,0,90]},part={model:'Example board'};
  const design={parts:[part],cadPlan:{bodies:[{partIndex:0,role:'reference',positionMm:[100,0,0],features:[feature]}]}};
  const recipe={sizeMm:[10,20,30],features:[{...feature,sizeMm:[4,2,1],centerMm:[2,0,0],rotationDeg:[0,0,0]}]};
  const result=materializeReconstructedParts(design,{[partIdentity(part)]:{reconstruction:recipe}});
  const out=result.cadPlan.bodies[0];assert.deepEqual(out.positionMm,[100,0,0]);assert.ok(Math.abs(out.features[0].centerMm[1]-2)<1e-9);
  assert.ok(Math.abs(out.features[0].rotationDeg[2]-90)<1e-9);assert.deepEqual(out.features[0].sizeMm,[4,2,1]);
  assert.deepEqual(design.cadPlan.bodies[0].features[0],feature);
});

test('review evidence records the exact reconstructed anchor and transformed datum without changing a case',()=>{
 const part={name:'fixture module',model:'Fixture M1'},anchor={shape:'box',op:'add',sizeMm:[10,20,30],centerMm:[3,4,5],rotationDeg:[0,0,90]};
 const design={parts:[part],cadPlan:{bodies:[{partIndex:0,role:'reference',positionMm:[100,0,0],features:[anchor]},
  {partIndex:0,role:'reference',positionMm:[0,0,0],features:[{...anchor,sizeMm:[10,20,31]}]}]}};
 const cache={[partIdentity(part)]:{sourceUrl:'https://example.test/module',reconstruction:{sizeMm:[10,20,30],features:[anchor],engine:'fixture compiler',datums:[{name:'shaft',positionMm:[2,0,0],axis:[1,0,0],basis:'geometry'}]}}};
 const before=JSON.stringify(design),evidence=reconstructedGeometry(design,cache);
 assert.equal(evidence.length,1);assert.equal(evidence[0].bodyIndex,0);assert.equal(evidence[0].featureCount,1);
 assert.deepEqual(evidence[0].datums[0].positionWorldMm,[103,6,5]);
 assert.ok(Math.abs(evidence[0].datums[0].axisWorld[0])<1e-9);assert.equal(evidence[0].datums[0].axisWorld[1],1);
 assert.equal(JSON.stringify(design),before);
 cache[partIdentity(part)].importedModel={};assert.deepEqual(reconstructedGeometry(design,cache),[]);
});

test('recentering a reconstructed part also translates its mechanical datums',()=>{
  const model={features:[{shape:'box',op:'add',sizeMm:[8,4,2],centerMm:[10,3,2]}],datums:[{name:'shaft',positionMm:[12,3,2],axis:[1,0,0],basis:'estimated',evidence:'fixture'}]};
  const centered=centerReconstruction(model,[10,3,2]);
  assert.deepEqual(centered.features[0].centerMm,[0,0,0]);assert.deepEqual(centered.datums[0].positionMm,[2,0,0]);assert.deepEqual(centered.datums[0].axis,[1,0,0]);
  assert.deepEqual(model.datums[0].positionMm,[12,3,2]);
});

test('newly researched geometry must be integrated into every whole-part instance before acceptance',()=>{
  const part={name:'hinge',model:'Example H3',kind:'included',placement:'mounted',qty:2,sizeMm:[40,20,38]};
  const feature={op:'add',shape:'box',sizeMm:part.sizeMm,centerMm:[0,0,0]},body={name:'hinge',partIndex:0,role:'reference',features:[feature]};
  const design={parts:[part],cadPlan:{bodies:[body,{...body,features:[{...feature,sizeMm:[40,24,30]}]}]}};
  const cache={[partIdentity(part)]:{reconstruction:{sizeMm:[40,24,30]}}};
  assert.match(reconstructionPlacementIssues(design,cache)[0],/仅 1 个/);
  design.parts=[{...part,sizeMm:[40,24,30]}];design.cadPlan.bodies=[design.cadPlan.bodies[1],design.cadPlan.bodies[1]];
  assert.deepEqual(reconstructionPlacementIssues(design,cache),[]);
  design.cadPlan.bodies[0]={...body,features:[feature,{...feature,shape:'cylinder',sizeMm:[3,3,8]}]};
  assert.equal(reconstructionPlacementIssues(design,cache).length,1);
  cache[partIdentity(part)]={reconstructionError:'feature smaller than supported minimum'};
  assert.match(reconstructionPlacementIssues(design,cache)[0],/独立模型未完成.*supported minimum/);
});

test('whole-model integration does not replace cut stock or fixed/moving subcomponents with a complete assembly',()=>{
  const part={name:'actuator',model:'Example A3',kind:'purchase',placement:'mounted',qty:1,sizeMm:[20,20,40]},cache={[partIdentity(part)]:{reconstruction:{sizeMm:part.sizeMm}}};
  const body={name:'subcomponent',partIndex:0,role:'reference',features:[{op:'add',shape:'cylinder',sizeMm:[5,5,20],centerMm:[0,0,0]}]};
  const design={parts:[part],cadPlan:{bodies:[body,body],motions:[{movingBodyIndices:[1]}]}};
  assert.deepEqual(reconstructionPlacementIssues(design,cache),[]);
  assert.deepEqual(reconstructionPlacementIssues({...design,cadPlan:{bodies:[body,body]},interaction:{controls:[{movingBodyIndices:[1]}]}},cache),[]);
  assert.deepEqual(reconstructionPlacementIssues({...design,parts:[{...part,kind:'material'}],cadPlan:{bodies:[body]}},cache),[]);
});
test('truncated part output raises its budget and retains it across service retries',async()=>{
  const part={name:'test bracket',model:'Example bracket M1',kind:'purchase',placement:'mounted'},cache={[partIdentity(part)]:{model:part.model,kind:'purchase'}},calls=[];
  const partial='{"description":"partial bracket","features":[',send=async(_url,options)=>{calls.push(JSON.parse(options.body));return calls.length===1?Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:partial}]}]}):Response.json({error:{message:'fixture transient failure'}},{status:503});};
  const run=()=>reconstructParts([part],cache,{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal);
  await run();assert.deepEqual(calls.map(b=>b.max_output_tokens),[32768,65536]);
  const policy=await hardwarePolicyGuide('reconstruction');
  assert.ok(calls.every(b=>b.instructions.includes(policy.text)));
  assert.match(JSON.parse(calls[1].input).previousFailure,/输出已达长度上限/);
  assert.equal(JSON.parse(calls[1].input).previousDraft,partial);
  await run();assert.deepEqual(calls.slice(2).map(b=>b.max_output_tokens),[65536,65536]);
  assert.equal(JSON.parse(calls[2].input).previousDraft,partial);assert.equal(cache[partIdentity(part)].reconstruction,undefined);
  assert.ok(calls.every(b=>b.reasoning.effort==='max'));
});
test('a shown loose purchased product enters reconstruction without adding a custom support',async()=>{
 const part={name:'external supply',model:'Fixture external module',kind:'purchase',placement:'loose'},cache={[partIdentity(part)]:{model:part.model,kind:'purchase'}};
 let calls=0;const send=async()=>{calls++;return Response.json({error:{}},{status:503});};
 const run=plan=>reconstructParts([part],cache,{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal,undefined,plan);
 await run(null);assert.equal(calls,0);
 await run({bodies:[{partIndex:0}]});assert.equal(calls,2);
 assert.match(cache[partIdentity(part)].reconstructionError,/503/);
 assert.equal(part.placement,'loose');assert.equal(part.model,'Fixture external module');
});
test('a rejected geometry draft and its feature error are given to the repair attempt',async()=>{
  const part={name:'test fitting',model:'Example fitting M2',kind:'purchase',placement:'mounted'},cache={[partIdentity(part)]:{model:part.model,kind:'purchase'}},calls=[];
  const value={description:'unverified fitting',assumptions:[],datums:[],features:[{shape:'cylinder',op:'add',sizeMm:[4,5,8],centerMm:[0,0,0],rotationDeg:[0,0,0]}]};
  const send=async(_url,options)=>{calls.push(JSON.parse(options.body));return calls.length===1?Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}):Response.json({error:{}},{status:503});};
  await reconstructParts([part],cache,{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal);
  const retry=JSON.parse(calls[1].input);assert.deepEqual(JSON.parse(retry.previousDraft),value);assert.match(retry.previousFailure,/features\[0\]/);assert.equal(cache[partIdentity(part)].reconstruction,undefined);
});

test('targeted model revision retains prior geometry through a service failure without accepting it as revised',async()=>{
  const part={name:'test module',model:'Example M3',kind:'purchase',placement:'mounted'};
  const old={description:'previous compiled module',features:[{shape:'box',op:'add',sizeMm:[20,10,5],centerMm:[0,0,0]}],datums:[],sizeMm:[20,10,5]};
  const record={model:part.model,kind:part.kind,reconstruction:old},cache={[partIdentity(part)]:record},calls=[];
  queueReconstructionRevision(record,'New drawing specifies two mounting holes');
  const send=async(_url,options)=>{calls.push(JSON.parse(JSON.parse(options.body).input));return Response.json({error:{}},{status:503});};
  await reconstructParts([part],cache,{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal);
  assert.deepEqual(calls[0].previousModel,old);assert.equal(calls[0].revisionReason,'New drawing specifies two mounting holes');
  assert.deepEqual(calls[1].previousModel,old);assert.equal(record.reconstruction,undefined);
  assert.deepEqual(record.reconstructionPrior.model,old);assert.match(record.reconstructionError,/503/);
});

test('resuming the same researched repair keeps its compiled model; new evidence or a new question invalidates it',()=>{
 const model={features:[{shape:'box',op:'add',sizeMm:[20,10,5],centerMm:[0,0,0]}],evidenceVersion:{queriedAt:'2026-11-23T10:00:00Z',question:'Check mounting holes'}};
 const record={queriedAt:'2026-11-23T10:00:00Z',reconstruction:model};
 assert.equal(queueReconstructionRevision(record,'Check mounting holes'),false);
 assert.equal(record.reconstruction,model);assert.equal(record.reconstructionPrior,undefined);
 record.queriedAt='2026-11-23T11:00:00Z';
 assert.equal(queueReconstructionRevision(record,'Check mounting holes'),true);
 assert.equal(record.reconstruction,undefined);assert.equal(record.reconstructionPrior.model,model);
 const different={queriedAt:'2026-11-23T10:00:00Z',reconstruction:model};
 assert.equal(queueReconstructionRevision(different,'Check output shaft'),true);
 const legacy={queriedAt:'2026-11-23T10:00:00Z',reconstruction:{features:model.features}};
 assert.equal(queueReconstructionRevision(legacy,'Check mounting holes'),true);
});

test('multi-view review renders real triangles and produces different views',async()=>{
  const mesh=makeDocumentedProxy({shape:'box',sizeMm:[10,20,30]}),body={partIndex:0,role:'reference',positionMm:[0,0,0],features:[{shape:'box',op:'add',sizeMm:[10,20,30],centerMm:[0,0,0]}]};
  const views=await designVisuals({parts:[{name:'controller',role:'internal'}],cadPlan:{bodies:[body]}},{bodies:[{...body,stlBase64:Buffer.from(encodeSTL(mesh.meshes[0].triangles)).toString('base64')}]});
  assert.equal(views.length,5);assert.notEqual(views[0].dataUrl,views[1].dataUrl);
  const bytes=Buffer.from(views[0].dataUrl.split(',')[1],'base64');let offset=8,idat=[];
  while(offset<bytes.length){const n=bytes.readUInt32BE(offset);if(bytes.toString('ascii',offset+4,offset+8)==='IDAT')idat.push(bytes.subarray(offset+8,offset+8+n));offset+=12+n;}
  const pixels=inflateSync(Buffer.concat(idat));assert.ok(pixels.filter(v=>v!==246&&v!==255&&v!==0).length>500);
});

test('coverage rejects omitted installed copies and a missing requested shell',()=>{
  const result=designCoverage({parts:[{name:'motor',qty:6,kind:'purchase',placement:'mounted'}],cadPlan:{bodies:[{partIndex:0,features:[]}]}},['完整外壳']);
  assert.equal(result.issues.length,2);
});

test('geometry failures identify the exact feature for autonomous repair',()=>{
  const plan={version:1,bodies:[{name:'test',partIndex:0,role:'reference',positionMm:[0,0,0],features:[{shape:'cylinder',op:'add',sizeMm:[4,5,8],centerMm:[0,0,0]}]}]};
  assert.throws(()=>validateCadPlan(plan,1),/bodies\[0\]\.features\[0\].*XY 等径/);
});

test('official stage routing includes real inspection and modeling sources plus AI decision policy',async()=>{
  const build=await officialStageGuide('modeling'),review=await officialStageGuide('review'),plan=await officialStageGuide('planning'),repair=await officialStageGuide('repair');
  assert.match(build.text,/Build Bottom-Up/);assert.match(build.text,/Positioning Decision Ladder/);assert.match(build.text,/不要求用户审核/);
  assert.match(build.text,/Phase 3 — Low-Level Design/);assert.doesNotMatch(build.text,/## Phase 1/);
  assert.deepEqual(review.sources.map(s=>s.name),['forgecad-inspect-model','forgecad-grade-model']);
  assert.match(plan.text,/Phase 1/);assert.doesNotMatch(plan.text,/## Phase 3/);
  assert.match(repair.text,/## Key Interfaces/);assert.match(repair.text,/## Alternatives/);
  assert.match(repair.text,/## Usage Guide/);assert.match(repair.text,/## Decisions/);
  assert.doesNotMatch(repair.text,/## Phase 3/);
  assert.equal((repair.text.match(/^```/gm)||[]).length%2,0);
  assert.match(repair.text,/适配规则优先于上面原文/);
});

test('generation and full-assembly review allow maximum reasoning plus a complete final JSON',async()=>{
 for(const name of ['hardware_design','hardware_design_review','hardware_repair_plan']){
  let body;
  const result=await structuredCall(async(_url,options)=>{body=JSON.parse(options.body);return Response.json({status:'completed',model:'test',reasoning:{effort:'max'},output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});},
    {OPENAI_MODEL:'test',OPENAI_API_KEY:'fixture'},new AbortController().signal,{max_output_tokens:4500,text:format(name,{type:'object',properties:{},required:[],additionalProperties:false})},'test');
  assert.equal(body.reasoning.effort,'max');assert.equal(body.max_output_tokens,65536);assert.equal(body.stream,true);assert.equal(result.reasoning.effort,'max');
 }
});

test('review and repair planning recover a truncated judgment without losing the original evidence',async()=>{
 for(const [name,initial] of [['hardware_design_review',65536],['hardware_repair_plan',65536]]){
  const calls=[],partial='{"ok":',original=[{role:'user',content:[{type:'input_text',text:'actual compiled evidence'}]}];
  const result=await structuredCall(async(_url,options)=>{
   const request=JSON.parse(options.body);calls.push(request);
   return Response.json(calls.length===1?
    {status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{output_tokens:initial},output:[{type:'message',content:[{type:'output_text',text:partial}]}]}:
    {status:'completed',model:'test',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]});
  },{OPENAI_MODEL:'test',OPENAI_API_KEY:'fixture'},new AbortController().signal,
  {input:original,text:format(name,{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false})},'review');
  assert.deepEqual(calls.map(c=>c.max_output_tokens),[initial,initial*2]);
  assert.deepEqual(calls[1].input[0],original[0]);
  assert.equal(JSON.parse(calls[1].input[1].content).incompleteReview,partial);
  assert.equal(calls[1].reasoning.effort,'max');
  assert.deepEqual(result.value,{ok:true});assert.equal(result.recovery.previousBudget,initial);
  assert.equal(result.recovery.partialCharacters,partial.length);
 }
});

test('a second truncated review is still a failure, never a partial acceptance or unlimited retry',async()=>{
 let calls=0;
 await assert.rejects(()=>structuredCall(async()=>{calls++;return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'{"ok":'}]}]});},
  {OPENAI_MODEL:'test',OPENAI_API_KEY:'fixture'},new AbortController().signal,{input:'evidence',text:format('hardware_design_review',{})},'review'),
  error=>error.incompleteReason==='max_output_tokens'&&error.partialOutput==='{"ok":');
 assert.equal(calls,2);
});

test('SSE handles split UTF-8 chunks and accepts only the completed response',async()=>{
  const result={status:'completed',model:'fixture',output:[{type:'message',content:[{type:'output_text',text:'完整'}]}]},encoder=new TextEncoder();
  const wire='event: response.created\r\ndata: {"type":"response.created"}\r\n\r\ndata: '+JSON.stringify({type:'response.completed',response:result})+'\n\n';
  const bytes=encoder.encode(wire),stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}});
  const output=await readOpenAIResponse(new Response(stream,{headers:{'content-type':'text/event-stream'}}));assert.deepEqual(output,result);
  await assert.rejects(()=>readOpenAIResponse(new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{'content-type':'text/event-stream'}})),/未收到完整结果/);
});
