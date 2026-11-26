import test from 'node:test';
import assert from 'node:assert/strict';
import {revisedMechanicalDependencies} from './revision-dependencies.mjs';
const box=(sizeMm,op='add')=>({shape:'box',sizeMm,op,centerMm:[0,0,0]});
const part=name=>({name,model:name});
const body=(name,partIndex,x,features)=>({name,partIndex,role:'printed',positionMm:[x,0,0],features});
function fixture(){
  return {parts:['frame','insert','motor'].map(part),cadPlan:{version:1,bodies:[
    body('frame',0,0,[box([10,10,10]),box([6,6,12],'cut')]),body('insert',1,8,[box([2,2,4])]),
    body('rotor',2,20,[box([3,3,3])])],joints:[{name:'turn',axis:[0,0,1],pivotMm:[20,0,0],minDegrees:-10,maxDegrees:10,
      movingBodyIndices:[2],fixedBodyIndex:1,actuatorPartIndex:2,parentIndex:null}]}};
}
test('changed mounts and neighbors are selected; an insert in the frame aperture has zero real intersection',async()=>{
  const before=fixture(),after=structuredClone(before);
  after.cadPlan.bodies[1].positionMm=[0,0,0];
  const result=await revisedMechanicalDependencies(before,after,{reconstructedParts:[{bodyIndex:1,datums:[{name:'flange'}]}]});
  assert.deepEqual(result.changedBodyIndices,[1]);
  assert.deepEqual(result.jointIndices,[0]);assert.deepEqual(result.datumBodyIndices,[1]);
  assert.deepEqual(result.neighbors.pairs,[{bodies:[0,1],before:false,after:true}]);
  assert.deepEqual(result.staticChecks,{tested:1,eligible:1,newIntersections:[]});
  after.cadPlan.bodies[1].positionMm=[4,0,0];
  const report=await revisedMechanicalDependencies(before,after);
  assert.deepEqual(report.staticChecks.newIntersections,[{bodies:[0,1],beforeMm3:0,afterMm3:16}]);
  const hosted=await revisedMechanicalDependencies(before,after,{local:false});
  assert.equal(hosted.status,'partial');assert.equal(hosted.staticChecks.tested,0);
});
test('inserting another body preserves existing identities and movements compare in their own reference groups',async()=>{
  const before=fixture(),after=structuredClone(before);
  after.cadPlan.bodies.unshift(body('new bracket',0,35,[box([1,1,1])]));
  after.cadPlan.joints[0].fixedBodyIndex=2;after.cadPlan.joints[0].movingBodyIndices=[3];
  const reordered=await revisedMechanicalDependencies(before,after);
  assert.deepEqual(reordered.changedBodyIndices,[0]);assert.deepEqual(reordered.unmatchedPrevious,[]);
  after.cadPlan.bodies[3].positionMm=[4,0,0];
  const moved=await revisedMechanicalDependencies(before,after);
  assert.deepEqual(moved.jointIndices,[0]);assert.equal(moved.neighbors.total,1);assert.equal(moved.staticChecks.eligible,0);
});
