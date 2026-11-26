import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceParts,attachPartSources,researchPart,sourcingIssues,sourcesForModel} from './part-sourcing.mjs';
import {importSourceCad,modelAsset,findCadFiles,cadGeometrySummary,inspectImportedCad} from './source-files.mjs';
import {designJobs} from './design-jobs.mjs';
import {encodeSTL} from '../assembly-hardware.js';
import {makeDocumentedProxy} from '../part-geometry.js';
import {validateJoints,jointPoint} from '../assembly-joints.js';
import {partIdentity} from '../part-records.js';
import {zipSync,strToU8} from 'fflate';
import {hardwarePolicyGuide} from './modeling-guide.mjs';

test('revision context carries current evidence once without changing saved part records',()=>{
  const part={name:'drive',model:'Example D1',sizeMm:[10,20,30],qty:2,placement:'mounted',purpose:'move the arm',dimensionSource:'estimated'};
  const record={model:part.model,kind:'purchase',productUrl:'https://vendor.example/d1',sourceUrl:'https://vendor.example/drawing',
    detail:'shaft and mounting dimensions',extentMm:[10,20,30],sourceQuote:'drawing note',
    reconstruction:{sizeMm:[10,20,30],description:'independent model',datums:[{name:'shaft',positionMm:[0,0,15],axis:[0,0,1],basis:'datasheet',evidence:'drawing A'}],assumptions:['hidden surface estimated'],engine:'ForgeCAD'},
    importedModel:{sizeMm:[10,20,30],sourceUrl:'https://vendor.example/d1.step',sourceType:'manufacturer',format:'step',filename:'d1.step',geometrySummary:{components:[{name:'housing'}]}}};
  const saved=attachPartSources({parts:[part]},{[partIdentity(part)]:record}).parts;
  const before=JSON.stringify({saved,record}),context=sourcesForModel(saved,[record])[0];
  assert.equal(context.hardwareReference,undefined);assert.equal(context.geometryReference,undefined);
  assert.equal(context.sourcing,undefined);assert.equal(context.importedModel,undefined);
  assert.equal(context.model,part.model);assert.equal(context.qty,2);assert.deepEqual(context.sizeMm,part.sizeMm);
  assert.equal(context.purpose,part.purpose);assert.equal(context.research.productUrl,record.productUrl);
  assert.equal(context.research.detail,record.detail);assert.equal(context.research.sourceQuote,record.sourceQuote);
  assert.deepEqual(context.research.reconstruction.datums,record.reconstruction.datums);
  assert.deepEqual(context.research.reconstruction.assumptions,record.reconstruction.assumptions);
  assert.deepEqual(context.research.importedModel.geometrySummary,record.importedModel.geometrySummary);
  assert.equal(JSON.stringify({saved,record}),before,'Only the request projection changes');
});

test('revision context keeps references without a matching server-generated source snapshot',()=>{
  const part={name:'module',model:'Example M1',hardwareReference:{items:[{url:'https://vendor.example/user-reference'}]},geometryReference:{detail:'user reference'}};
  assert.deepEqual(sourcesForModel([part],[])[0],part);
  const withRecord=sourcesForModel([part],[{model:part.model,kind:'provided'}])[0];
  assert.deepEqual(withRecord.hardwareReference,part.hardwareReference);
  const mismatched={...part,sourcing:{model:'Example M2'}};
  assert.deepEqual(sourcesForModel([mismatched],[{model:part.model}])[0].geometryReference,part.geometryReference);
});

test('all BOM rows are researched, retained on retry and invalidated on model substitution',async()=>{
  const cache={},parts=Array.from({length:7},(_,i)=>({name:'module '+i,model:'Brand M'+i,spec:'assembled',qty:1,role:'internal'}));
  const calls=[],signal=new AbortController().signal;
  const deps={research:async part=>{calls.push(part.model);return {model:part.model,productUrl:'https://vendor.example/'+part.model,extentMm:[10,20,30]};},fetchSource:async url=>({url,bytes:Buffer.from('<h1>'+decodeURI(new URL(url).pathname.slice(1))+'</h1>')})};
  await sourceParts(parts,cache,{},null,signal,undefined,null,deps);
  assert.equal(calls.length,7);
  await sourceParts(parts,cache,{},null,signal,undefined,null,deps);assert.equal(calls.length,7);
  parts[3]={...parts[3],model:'Brand M8'};
  await sourceParts(parts,cache,{},null,signal,undefined,null,deps);assert.equal(calls.length,8);
  const design=attachPartSources({parts:parts.map(p=>({...p,sizeMm:[10,20,30],dimensionSource:'estimated'}))},cache);
  assert.equal(design.parts[3].hardwareReference.items[0].name,'Brand M8');
  assert.ok(design.parts.every(p=>p.hardwareReference.items.length===1));
});

test('manufacturer suffix edits reuse the exact SKU but revision and package changes do not',()=>{
  assert.equal(partIdentity({model:'Example Co., Ltd. M42-T Rev.A'}),partIdentity({model:'Example M42-T Rev.A'}));
  assert.notEqual(partIdentity({model:'Example M42-T Rev.A'}),partIdentity({model:'Example M42-R Rev.A'}));
  assert.notEqual(partIdentity({model:'Example M42-T Rev.A'}),partIdentity({model:'Example M42-T Rev.B'}));
  assert.equal(partIdentity({model:'自制 BOARD6 Rev.A'}),partIdentity({model:'BOARD6 Rev.A'}));
});
test('dimensions measured from loaded CAD are not labelled as estimates or bare housing dimensions',()=>{
  const part={name:'module',model:'Example full module',sizeMm:[10,20,42],dimensionSource:'estimated'},cache={[partIdentity(part)]:{
    model:part.model,kind:'purchase',extentMm:[10,20,34],sourceUrl:'https://vendor.example/drawing',
    importedModel:{sizeMm:[10,20,42],sourceType:'manufacturer',format:'step',sourceUrl:'https://vendor.example/model.step',documentationUrl:'https://vendor.example/drawing'}
  }};
  const measured=attachPartSources({parts:[part]},cache).parts[0];assert.equal(measured.dimensionSource,'cad');assert.match(measured.dimensionNote,/原厂 CAD/);
  const wrong=attachPartSources({parts:[{...part,sizeMm:[10,20,41]}]},cache).parts[0];assert.equal(wrong.dimensionSource,'estimated');
});

test('a failed CAD transfer retries the saved URL without researching the part again',async()=>{
  const cache={},parts=[{name:'motor',model:'Example M1',kind:'purchase'}];let queries=0,downloads=0;
  const deps={research:async()=>{queries++;return{model:'Example M1',productUrl:'https://vendor.example/m1',cadUrl:'https://vendor.example/m1.step',cadAuthority:'manufacturer'};},
    fetchSource:async url=>({url,bytes:Buffer.from('<h1>Example M1</h1>')}),importCad:async record=>{downloads++;assert.equal(record.cadUrl,'https://vendor.example/m1.step');if(downloads===1)throw Error('download timeout');return{id:'downloaded'};}};
  const run=()=>sourceParts(parts,cache,{},null,new AbortController().signal,undefined,null,deps);
  await run();assert.equal(cache[partIdentity(parts[0])].cadStatus,'unavailable');
  await run();await run();assert.equal(queries,1);assert.equal(downloads,2);assert.equal(cache[partIdentity(parts[0])].cadStatus,'imported');
});
test('successful source recovery clears the previous connection failure',async()=>{
  const parts=[{name:'part',model:'Example recovered module',kind:'purchase'}],cache={};let queries=0;
  const deps={research:async()=>{if(++queries===1)throw Error('connection timeout');return {model:parts[0].model,productUrl:'https://vendor.example/module'};},fetchSource:async()=>({})};
  const run=()=>sourceParts(parts,cache,{},null,new AbortController().signal,undefined,null,deps);
  await run();assert.equal(cache[partIdentity(parts[0])].error,'connection timeout');
  await run();assert.equal(queries,2);assert.equal(cache[partIdentity(parts[0])].productStatus,'retrieved');assert.equal(cache[partIdentity(parts[0])].error,undefined);
  cache[partIdentity(parts[0])].error='obsolete saved error';await run();assert.equal(queries,2);assert.equal(cache[partIdentity(parts[0])].error,undefined);
});

test('the user-owned host remains in the assembly without becoming a required purchase',async()=>{
  const cache={},parts=[{name:'existing host',model:'user device',spec:'specified data interface',kind:'provided',sizeMm:[10,20,30]}];
  await sourceParts(parts,cache,{},null,new AbortController().signal,undefined,null,{research:async()=>{throw Error('Must not research a new purchase');}});
  const design=attachPartSources({parts},cache);assert.deepEqual(sourcingIssues(design,cache),[]);
  assert.equal(design.parts[0].hardwareReference.kind,'provided');assert.equal(design.parts[0].kind,'provided');
});

test('installed kit contents obtain their own mechanical evidence without requiring a separate purchase',async()=>{
  const included={name:'kit hinge',model:'Example hinge H2',spec:'included in kit K2',kind:'included',placement:'mounted',sizeMm:[10,20,30]},cache={
    [partIdentity(included)]:{model:included.model,kind:'included',attempts:1,detail:included.spec,reconstruction:{description:'old estimate'}}
  };
  const parts=[included,{name:'spare lead',model:'included spare',kind:'included',placement:'loose'},{name:'case',model:'custom case',kind:'custom',placement:'mounted'}];let queries=0;
  const deps={research:async p=>{queries++;assert.equal(p.kind,'included');return {model:p.model,sourceUrl:'https://vendor.example/hinge-drawing',detail:'Exact hinge mounting dimensions',extentMm:[10,20,30],productUrl:''};}};
  const run=()=>sourceParts(parts,cache,{},null,new AbortController().signal,undefined,null,deps);
  await run();await run();assert.equal(queries,1);
  const record=cache[partIdentity(included)];assert.equal(record.productStatus,'included');assert.equal(record.reconstruction,undefined);
  const design=attachPartSources({parts},cache);assert.deepEqual(sourcingIssues(design,cache),[]);
  assert.equal(design.parts[0].hardwareReference.items[0].url,'https://vendor.example/hinge-drawing');
});

test('a legacy included-part record retries a failed mechanical lookup before caching success',async()=>{
  const part={name:'kit fitting',model:'Example fitting',kind:'included',placement:'mounted'},cache={
    [partIdentity(part)]:{model:part.model,kind:'included',attempts:1,detail:'old placeholder',reconstruction:{description:'old estimate'}}
  };let queries=0;
  const deps={research:async()=>{if(++queries===1)throw Error('temporary source failure');return {model:part.model,sourceUrl:'https://vendor.example/fitting',detail:'fitting facts'};}};
  const run=()=>sourceParts([part],cache,{},null,new AbortController().signal,undefined,null,deps);
  await run();assert.equal(cache[partIdentity(part)].attempts,1);await run();await run();
  assert.equal(queries,2);assert.equal(cache[partIdentity(part)].researchError,undefined);assert.equal(cache[partIdentity(part)].reconstruction,undefined);
});

test('an invented product/CAD URL absent from tool results cannot become a source',async()=>{
  const policy=await hardwarePolicyGuide('research');
  const send=async(_url,options)=>{const request=JSON.parse(options.body);assert.ok(request.instructions.includes(policy.text));return Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:[{url:'https://vendor.example/doc'}]}},
    {type:'message',content:[{type:'output_text',text:JSON.stringify({model:'M1',productUrl:'https://fake.example/item',sourceUrl:'https://vendor.example/doc',extentMm:[1,2,3],cadUrl:'https://fake.example/model.stl'})}]}]});};
  const result=await researchPart({name:'part',model:'M1'},{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal);
  assert.equal(result.productUrl,'');assert.equal(result.cadUrl,'');assert.equal(result.sourceUrl,'https://vendor.example/doc');
  assert.deepEqual(result.researchProvenance.policy,policy.skill);
});

test('source JSON preserves quoted braces and ignores appended citation metadata',async()=>{
  const send=async()=>Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:[{url:'https://vendor.example/item'}]}},
    {type:'message',content:[{type:'output_text',text:JSON.stringify({model:'M1',productUrl:'https://vendor.example/item',detail:'Datum {A} and "B"'})+'\nCitation: {"id":1}'}]}]});
  const result=await researchPart({name:'part',model:'M1'},{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,new AbortController().signal);
  assert.equal(result.productUrl,'https://vendor.example/item');assert.equal(result.detail,'Datum {A} and "B"');
});

test('the CAD file is parsed, persisted and served with its measured scale',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formbench-cad-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const mesh=makeDocumentedProxy({shape:'box',sizeMm:[10,20,30]}),bytes=Buffer.from(encodeSTL(mesh.meshes[0].triangles));
  const asset=await importSourceCad({model:'Example M1',cadUrl:'https://vendor.example/m1.stl',cadAuthority:'manufacturer'},{FORMBENCH_ASSET_DIR:dir},
    {signal:new AbortController().signal,fetcher:async()=>({bytes,url:'https://vendor.example/m1.stl'})});
  assert.deepEqual(asset.sizeMm,[10,20,30]);
  const response=await modelAsset(new Request('http://127.0.0.1'+asset.meshUrl),{FORMBENCH_ASSET_DIR:dir});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).sizeMm,[10,20,30]);
  assert.deepEqual(await readFile(join(dir,asset.id,'source.stl')),bytes);
  assert.deepEqual(asset.geometrySummary.groups[0].boundsMm,[[-5,-10,-15],[5,10,15]]);
  const {geometrySummary,...oldAsset}=asset;
  assert.deepEqual((await inspectImportedCad(oldAsset,{FORMBENCH_ASSET_DIR:dir})).geometrySummary,geometrySummary);
  const step=await readFile(new URL('../forge/pico-base.step',import.meta.url));
  const parsed=await importSourceCad({model:'STEP fixture',cadUrl:'https://vendor.example/fixture.step',cadAuthority:'manufacturer'},{FORMBENCH_ASSET_DIR:dir},
    {signal:new AbortController().signal,fetcher:async()=>({bytes:step,url:'https://vendor.example/fixture.step'})});
  parsed.sizeMm.forEach((n,i)=>assert.ok(Math.abs(n-[64,32,17][i])<.02));
});
test('imported CAD anatomy uses the same centred coordinates as assembly anchors',()=>{
  const summary=cadGeometrySummary({sizeMm:[20,40,30],originalMinMm:[-10,-30,-5],meshes:[
    {label:'output horn',triangles:[[[8,30,26],[12,30,30],[8,34,26]]]},
    {label:'output horn',triangles:[[[8,30,24],[12,34,24],[12,34,30]]]},
    {label:'motor case',triangles:[[[0,0,0],[20,40,0],[20,40,20]]]}
  ]});
  assert.deepEqual(summary.originalOriginMm,[0,10,-10]);
  assert.equal(summary.meshCount,3);assert.equal(summary.groupCount,2);
  assert.deepEqual(summary.groups[0],{label:'output horn',count:2,boundsMm:[[-2,10,9],[2,14,15]]});
  assert.deepEqual(summary.meshes[0],{index:0,label:'output horn',boundsMm:[[-2,10,11],[2,14,15]]});
  assert.deepEqual(summary.meshes[1],{index:1,label:'output horn',boundsMm:[[-2,10,9],[2,14,15]]});
});
test('supplier download pages expose literal file destinations without executing scripts',async()=>{
  const urls=await findCadFiles('https://vendor.example/download.php?id=1',{fetcher:async()=>({url:'https://vendor.example/download.php?id=1',bytes:Buffer.from('<script>startDownload("https://files.example/cad/motor.stp?download=1")</script>')})});
  assert.deepEqual(urls,['https://files.example/cad/motor.stp?download=1']);
});

test('a ZIP of the same part in two formats selects STEP while a multi-part archive stays unresolved',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formbench-zip-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const record={model:'Example motor',cadUrl:'https://vendor.example/motor.zip',cadAuthority:'manufacturer'},model={sizeMm:[10,20,30],meshes:[]};let chosen;
  const deps={signal:new AbortController().signal,fetcher:async()=>({url:record.cadUrl,bytes:zipSync({'motor.step':strToU8('STEP'),'motor.stl':strToU8('STL')})}),parser:async(_bytes,name)=>{chosen=name;return model;}};
  await importSourceCad(record,{FORMBENCH_ASSET_DIR:dir},deps);assert.equal(chosen,'motor.step');
  await assert.rejects(()=>importSourceCad(record,{FORMBENCH_ASSET_DIR:dir},{...deps,fetcher:async()=>({url:record.cadUrl,bytes:zipSync({'rotor.step':strToU8('A'),'case.step':strToU8('B')})})}),/不同 CAD/);
});

test('jobs persist the goal and completed result, and cancellation reaches the active run',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formbench-jobs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const env={FORMBENCH_JOB_DIR:dir},request=(path,body)=>new Request('http://127.0.0.1/api/design-jobs'+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
  let release;const gate=new Promise(r=>release=r);
  const run=async(_req,_env,_send,workflow)=>{workflow.state.rounds=[{attempt:1,issues:['initial fit']}];await workflow.progress({stage:'repairing',message:'adjusting fit'});await gate;return Response.json({design:{name:'finished',parts:[]}});};
  const created=await (await designJobs(request('',{prompt:'a real requirement'}),env,{run})).json();
  assert.equal(created.status,'running');release();
  let result;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,10));result=await(await designJobs(request('/'+created.id),env,{run})).json();if(result.status==='complete')break;}
  assert.equal(result.design.name,'finished');assert.equal(result.rounds.length,1);
  const saved=JSON.parse(await readFile(join(dir,created.id,'job.json')));assert.equal(saved.input.prompt,'a real requirement');
  let aborted=false;
  const cancellable=req=>new Promise(resolve=>req.signal.addEventListener('abort',()=>{aborted=true;resolve(Response.json({error:'cancelled'},{status:499}));}));
  const second=await(await designJobs(request('',{prompt:'cancel this test'}),env,{run:cancellable})).json();
  await designJobs(request('/'+second.id+'/cancel',{}),env);assert.equal(aborted,true);
  await new Promise(r=>setTimeout(r,30));
  const fail=async(_request,_env,_send,workflow)=>{workflow.state.candidate={name:'saved draft',parts:[{name:'part',model:'M1'}]};workflow.state.issues=['Needs fit repair'];await workflow.progress({stage:'reviewing'});throw Error('Service interrupted');};
  const third=await(await designJobs(request('',{prompt:'retain this draft'}),env,{run:fail})).json();
  let failed;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,10));failed=await(await designJobs(request('/'+third.id),env,{run:fail})).json();if(failed.status==='failed')break;}
  assert.equal(failed.status,'failed');assert.equal(failed.repairCandidate.design.name,'saved draft');
});

test('serial joints carry their descendants and preserve fixed links',()=>{
  const bodies=[{partIndex:0},{partIndex:1},{partIndex:2}],joints=[
    {name:'base',axis:[0,0,1],pivotMm:[0,0,0],minDegrees:-90,maxDegrees:90,movingBodyIndices:[1,2],fixedBodyIndex:0,actuatorPartIndex:0,parentIndex:null},
    {name:'elbow',axis:[0,1,0],pivotMm:[10,0,0],minDegrees:-90,maxDegrees:90,movingBodyIndices:[2],fixedBodyIndex:1,actuatorPartIndex:1,parentIndex:0}];
  assert.doesNotThrow(()=>validateJoints({bodies,joints}));
  const tip=jointPoint([20,0,0],2,joints,[90,90]);
  assert.ok(Math.hypot(tip[0],tip[1]-10,tip[2]+10)<1e-9);
  assert.deepEqual(jointPoint([0,0,0],0,joints,[90,90]),[0,0,0]);
  assert.throws(()=>validateJoints({bodies,joints:[joints[0],{...joints[1],parentIndex:null}]}),/非父关节/);
});
