import {fixtureProductDelivery} from './test-fixtures/design-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDesignRevision,needsIncrementalRevision,reviseAssembly} from './design-revision.mjs';
import {design,normalizeDesign} from './design.mjs';
import {validateCadPlan,MAX_CAD_BODIES,MAX_CAD_FEATURES} from '../cad-plan.js';
import {cleanPlacements} from '../project-layout.js';
import {cadPlanToForgeScript} from '../forge-source.js';

const feature={op:'add',shape:'box',sizeMm:[10,10,4],centerMm:[0,0,0],rotationDeg:[0,0,0]};
function fixture(count=1){
 const features=[feature,...Array.from({length:5},(_,i)=>({op:'cut',shape:'box',sizeMm:[.8,.8,6],centerMm:[-3+i*1.5,0,0],rotationDeg:[0,0,0]}))];
 return {name:'带孔安装片',summary:'独立安装的固定片。',deviceMotion:'stationary',
  parts:[{name:'安装片',model:'自制固定片',spec:'按孔位加工',kind:'custom',role:'internal',placement:'mounted',qty:count,sizeMm:[10,10,4],purpose:'固定',dimensionSource:'estimated',dimensionQuote:'',modelId:''}],
  steps:['按图加工并核对孔位。'],interaction:null,
  cadPlan:{version:1,bodies:Array.from({length:count},(_,i)=>({name:'安装片 '+i,partIndex:0,instanceIndex:i,role:'printed',positionMm:[(i%16)*15,Math.floor(i/16)*15,0],features:structuredClone(features)})),motions:[],joints:[]}};
}
const op=(op,path,value)=>({op,path,valueJson:op==='remove'?null:JSON.stringify(value)});
const revision=operations=>({summary:'调整固定片',operations});
const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture-model'};
const completed=value=>Response.json({model:'fixture-snapshot',reasoning:{effort:'max'},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('model-authored operations preserve the original and untouched geometry, then receive normal design validation',()=>{
 const base=fixture(2),before=structuredClone(base);
 const value=applyDesignRevision(base,revision([
  op('replace','/cadPlan/bodies/1/positionMm',[22,0,0]),
  op('add','/steps/-','核对第二片的位置。'),op('remove','/steps/0')
 ]));
 assert.deepEqual(base,before);assert.deepEqual(value.cadPlan.bodies[0],base.cadPlan.bodies[0]);
 assert.deepEqual(value.cadPlan.bodies[1].positionMm,[22,0,0]);assert.equal(value.steps.length,1);
 assert.doesNotThrow(()=>normalizeDesign(value,'固定片'));
 const invalid=applyDesignRevision(base,revision([op('replace','/cadPlan/bodies/1/partIndex',99)]));
 assert.throws(()=>normalizeDesign(invalid,'固定片'),/索引/);
});

test('invalid patch paths, values and inherited targets fail without mutating the stored draft',()=>{
 const base=fixture(),before=structuredClone(base);
 for(const operation of [op('replace','/cadPlan/bodies/9/name','x'),op('add','/__proto__/polluted',true),op('replace','/missing','x'),op('add','/steps/00','x'),op('replace','/steps/~2','x'),{op:'replace',path:'/name',valueJson:'invalid JSON'}])
  assert.throws(()=>applyDesignRevision(base,revision([op('replace','/name','changed'),operation])));
 assert.deepEqual(base,before);assert.equal({}.polluted,undefined);
 for(const path of ['/parts','/cadPlan','/cadPlan/bodies'])for(const action of ['add','replace','remove'])
  assert.throws(()=>applyDesignRevision(base,revision([op(action,path,[])])),/不能整体替换/);
 const {cadPlan,...legacy}=base;
 assert.deepEqual(applyDesignRevision(legacy,revision([op('add','/cadPlan',cadPlan)])).cadPlan,cadPlan,'a missing CAD field can be introduced without rewriting the existing BOM');
 const escaped=applyDesignRevision({'a/b':{'~key':1}},revision([op('replace','/a~1b/~0key',2)]));
 assert.equal(escaped['a/b']['~key'],2);
});

test('large assemblies retain independent instances across validation, layout and ForgeCAD source',()=>{
 const base=fixture(203);
 assert.equal(validateCadPlan(base.cadPlan),base.cadPlan);
 const positions=base.cadPlan.bodies.map(b=>({partIndex:0,positionMm:b.positionMm,rotationDeg:[0,0,0]}));
 assert.equal(cleanPlacements(positions,base).length,203);
 assert.match(cadPlanToForgeScript(base.cadPlan),/安装片 202/);
 assert.throws(()=>validateCadPlan(fixture(MAX_CAD_BODIES+1).cadPlan),new RegExp(String(MAX_CAD_BODIES)));
 const tooMany=fixture(60);tooMany.cadPlan.bodies.forEach(b=>{b.features=Array.from({length:70},()=>structuredClone(feature));});
 assert.ok(tooMany.cadPlan.bodies.length*70>MAX_CAD_FEATURES);assert.throws(()=>validateCadPlan(tooMany.cadPlan),/4096/);
});

test('an inapplicable model edit is returned to the API, with the same original draft',async()=>{
 const base=fixture();let calls=0;
 const result=await reviseAssembly(base,{instructions:'fixture',input:'saved design'},async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.text.format.name,'hardware_design_revision');assert.equal(body.reasoning.effort,'max');
  if(++calls===1)return completed(revision([op('replace','/cadPlan/bodies/7/name','x')]));
  assert.match(body.input.at(-1).content,/不存在|索引无效/);
  return completed(revision([op('replace','/name','修订后的安装片')]));
 },env,new AbortController().signal);
 assert.equal(calls,2);assert.equal(result.value.name,'修订后的安装片');assert.equal(base.name,'带孔安装片');
 assert.equal(result.model,'fixture-snapshot');assert.equal(result.revision.attempts,2);
});

test('a large saved workflow applies API edits, compiles all bodies and sends the complete result to independent review',async()=>{
 const base=fixture(220);assert.equal(needsIncrementalRevision(base),true);assert.equal(needsIncrementalRevision(fixture()),true);assert.equal(needsIncrementalRevision(null),false);
 const state={selection:{parts:base.parts,requirements:[]},sources:{},candidate:base,lastDraft:base,nextAttempt:2,assemblyOutputBudget:131072,
  issues:['第二片需要调整位置'],repair:{attempt:2,research:[],researched:true},rounds:[]},calls=[];
 const result=await design(new Request('http://127.0.0.1/api/design',{method:'POST',body:JSON.stringify({prompt:'独立的带孔固定片'})}),env,async(_url,options)=>{
  const body=JSON.parse(options.body),name=body.text.format.name;calls.push(name);
  if(name==='hardware_design_revision'){assert.equal(body.max_output_tokens,131072,'preserve the existing large-design output budget');return completed(revision([op('replace','/cadPlan/bodies/1/positionMm',[16,0,0])]));}
  assert.equal(name,'hardware_design_review');
  const first=typeof body.input==='string'?body.input:body.input[0].content;
  const input=JSON.parse(typeof first==='string'?first:first.find(c=>c.type==='input_text').text);
  assert.equal(input.candidate.cadPlan.bodies.length,220);assert.deepEqual(input.candidate.cadPlan.bodies[1].positionMm,[16,0,0]);
  assert.deepEqual(input.candidate.cadPlan.bodies[219],base.cadPlan.bodies[219]);
  return completed({productDelivery:fixtureProductDelivery,requiresInteraction:false,findings:[],checks:['intent','form','mechanism','control'].map(area=>({area,status:'pass',note:'Fixture accepted',partIndices:[0],bodyIndices:[0]})),physicalChecks:['Fixture only.']});
 },{id:'revision-fixture',state,progress:async()=>{}});
 const body=await result.json();assert.equal(result.status,200,body.error);assert.deepEqual(calls,['hardware_design_revision','hardware_design_review']);
 assert.equal(state.compiled.bodies.length,220);assert.equal(body.design.generation.assemblyRevision.mode,'incremental');
 assert.equal(state.rounds[0].revision.operations.length,1);assert.equal(base.cadPlan.bodies[1].positionMm[0],15);
});

test('a small saved design is incrementally repaired and stops at the requested completed review',async()=>{
 const base=fixture(2),before=structuredClone(base),calls=[],state={selection:{parts:base.parts,requirements:[]},sources:{},
  candidate:base,lastDraft:base,nextAttempt:6,issues:['调整第二片'],repair:{attempt:6,research:[],researched:true},rounds:[]};
 let pauseChecks=0;
 const response=await design(new Request('http://127.0.0.1/api/design',{method:'POST',body:JSON.stringify({prompt:'两个独立固定片'})}),env,async(_url,options)=>{
  const body=JSON.parse(options.body),name=body.text.format.name;calls.push(name);
  if(name==='hardware_design_revision'){
   assert.deepEqual(JSON.parse(body.input.at(-1).content).rejectedDraft,base);
   return completed(revision([op('replace','/cadPlan/bodies/1/positionMm',[16,0,0])]));
  }
  assert.equal(name,'hardware_design_review');
  return completed({productDelivery:fixtureProductDelivery,requiresInteraction:false,findings:[{priorId:'',check:'mount.spacing',subject:'片2',area:'form',disposition:'open',route:'design',capability:'',
   description:'第二片安装间距仍需调整。',evidence:'第二片中心为 16 mm。',acceptance:'安装间距达到图纸要求。',partIndices:[0],bodyIndices:[1],basis:'design'}],
   checks:['intent','form','mechanism','control'].map(area=>({area,status:area==='form'?'repair':'pass',
   note:area==='form'?'第二片安装间距仍需调整。':'Fixture accepted',partIndices:[0],bodyIndices:[1]})),physicalChecks:['Fixture only.']});
 },{id:'small-revision-fixture',state,progress:async()=>{},shouldPause:async attempt=>{pauseChecks++;assert.equal(attempt,6);return true;}});
 const result=await response.json();assert.equal(response.status,202,result.error);assert.equal(result.paused,true);assert.equal(result.design,undefined);
 assert.equal(pauseChecks,1);assert.deepEqual(calls,['hardware_design_revision','hardware_design_review']);
 assert.equal(state.rounds.length,1);assert.equal(state.rounds[0].attempt,6);assert.equal(state.nextAttempt,7);assert.equal(state.compiled.bodies.length,2);
 assert.equal(state.lastDraft.cadPlan.bodies[1].positionMm[0],16);assert.deepEqual(state.lastDraft.cadPlan.bodies[0],before.cadPlan.bodies[0]);assert.deepEqual(base,before);
});
