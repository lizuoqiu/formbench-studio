import test from 'node:test';
import assert from 'node:assert/strict';
import {partIdentity} from '../part-records.js';
import {partModelPlacementIssues,reconcilePartModels} from './assembly-alignment.mjs';
import {applyRepairRequirements} from './design-repair.mjs';

function fixture(){
 const part={name:'fixture motor',model:'Fixture M1',kind:'purchase',placement:'mounted',qty:2,sizeMm:[10,20,30]};
 const anchor={name:'fixture instance',partIndex:0,role:'reference',positionMm:[0,0,0],features:[{shape:'box',op:'add',sizeMm:part.sizeMm,centerMm:[0,0,0]}]};
 return {draft:{attempt:2,value:{parts:[part],cadPlan:{bodies:[anchor,{...structuredClone(anchor),positionMm:[40,0,0]}]}}},
  state:{sources:{[partIdentity(part)]:{reconstruction:{sizeMm:[12,20,30],datums:[],features:[]}}}}};
}
const options=state=>({state,ctx:{prompt:'A lightweight device',history:[]},instructions:'fixture',env:{},send:null,signal:new AbortController().signal,progress:async()=>{}});

test('new part evidence triggers AI alignment, then reuses the unchanged source cache',async()=>{
 const {draft,state}=fixture(),original=structuredClone(draft),calls=[];
 const result=await reconcilePartModels(draft,options(state),{
  revise:async(base,request)=>{calls.push('revision');const input=JSON.parse(request.input);assert.equal(input.issues.length,1);
   const value=structuredClone(base);value.parts[0].sizeMm=[12,20,30];value.cadPlan.bodies.forEach(b=>b.features[0].sizeMm=[12,20,30]);
   return {value,revision:{mode:'incremental',operations:[{op:'replace',path:'/parts/0/sizeMm',value:[12,20,30]}]},model:'fixture'};},
  source:async(parts,cache)=>{calls.push('sources');assert.equal(cache,state.sources);},
  reconstruct:async(parts,cache,env,send,signal,progress,plan)=>{calls.push('models');assert.deepEqual(plan.bodies[1].positionMm,[40,0,0]);}
 });
 assert.deepEqual(calls,['revision','sources','models']);assert.equal(result.alignments.length,1);
 assert.equal(result.alignments[0].revision.mode,'incremental');assert.deepEqual(draft,original);
 assert.equal(state.draft,result);assert.deepEqual(partModelPlacementIssues(result.value,state.sources),[]);
});

test('unresolved alignment stays a defect and saved passes are not re-billed on resume',async()=>{
 const {draft,state}=fixture();let calls=0;
 const deps={revise:async value=>{calls++;return{value,revision:{mode:'incremental',operations:[]}};},source:async()=>{},reconstruct:async()=>{}};
 const unresolved=await reconcilePartModels(draft,options(state),deps);
 assert.equal(calls,2);assert.equal(partModelPlacementIssues(unresolved.value,state.sources).length,1);
 await reconcilePartModels(state.draft,options(state),deps);assert.equal(calls,2);
});

test('matching original CAD is untouched; external product models also retain native scale',async()=>{
 const {draft,state}=fixture(),part=draft.value.parts[0],record=state.sources[partIdentity(part)];
 record.importedModel={sizeMm:[10,20,30]};delete record.reconstruction;part.placement='loose';
 const result=await reconcilePartModels(draft,options(state),{revise:async()=>{throw Error('An unchanged assembly must not call the API');}});
 assert.equal(result,draft);
 draft.value.cadPlan.bodies[1].features[0].sizeMm=[9,20,30];
 assert.match(partModelPlacementIssues(draft.value,state.sources)[0],/2 个实例只有 1 个/);
});

test('AI requirement revisions preserve their previous baseline and do not repeat on resume',()=>{
 const state={selection:{requirements:['core capability','AI-added storage stand'],parts:['unchanged']}};
 const repair={attempt:8,requirements:['core capability','basic web controls'],requirementsReason:'Latest user request removes added peripherals.'};
 applyRepairRequirements(state,repair);applyRepairRequirements(state,repair);
 assert.deepEqual(state.selection.requirements,repair.requirements);assert.equal(state.requirementRevisions.length,1);
 assert.equal(state.requirementRevisions[0].previous[1],'AI-added storage stand');assert.deepEqual(state.selection.parts,['unchanged']);
 applyRepairRequirements(state,{attempt:9,requirements:[]});assert.deepEqual(state.selection.requirements,repair.requirements);
});
