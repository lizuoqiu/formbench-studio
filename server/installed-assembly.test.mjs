import test from 'node:test';
import assert from 'node:assert/strict';
import {designCoverage} from './design-coverage.mjs';
import * as coverage from './design-coverage.mjs';
const box=(sizeMm,centerMm=[0,0,0],op='add')=>({op,shape:'box',sizeMm,centerMm});
const body=(name,partIndex,features,positionMm=[0,0,0],instanceIndex=0)=>({name,partIndex,features,positionMm,instanceIndex,role:partIndex===0?'printed':'reference'});
const part=(name,role,qty=1)=>({name,qty,role,kind:role==='enclosure'?'custom':'purchase',placement:'mounted',sizeMm:[20,12,6]});
const example=(cut=true)=>({parts:[part('case','enclosure'),part('board','internal')],cadPlan:{version:1,bodies:[body('tub',0,[box([60,40,30]),cut?box([54,34,30],[0,0,3],'cut'):box([2,2,1],[0,0,15],'cut')]),body('lid',0,[box([60,40,2])],[0,0,16]),body('board',1,[box([20,12,6])])],fitChecks:[{partIndex:1,instanceIndex:0,housingBodyIndices:[0],lidBodyIndices:[1],insertionOffsetMm:[0,0,45]}]}});
const review=async d=>{assert.equal(typeof coverage.reviewAssemblyFit,'function');return coverage.reviewAssemblyFit(d,['封闭外壳']);};
test('two subsolids from one physical servo never cover two installed servos; distinct explicit occurrences do',()=>{
 const make=i=>[body('case',0,[box([20,12,6])],[i*26,0,0],i),body('horn',0,[box([2,4,1])],[i*26,0,4],i)];
 const d={parts:[part('servo','internal',2)],cadPlan:{bodies:make(0)}};
 assert.ok(designCoverage(d).issues.length);d.cadPlan.bodies.push(...make(1));assert.deepEqual(designCoverage(d).issues,[]);
 d.cadPlan.bodies.splice(2,1);assert.ok(designCoverage(d).issues.length);
 d.cadPlan.bodies=make(0).concat(make(0).map(b=>({...b,instanceIndex:1})));assert.ok(designCoverage(d).issues.length);
});
test('a shallow cut cannot certify a shell, nor can a loose module outside the cavity',async()=>{
 assert.ok((await review(example(false))).issues.length);const d=example();d.cadPlan.bodies[2].positionMm=[80,0,0];assert.ok((await review(d)).issues.length);
});
test('board, removable lid and straight insertion are independently checked, including a thin obstruction midway',async()=>{
 const d=example();assert.deepEqual((await review(d)).issues,[]);
 d.cadPlan.bodies[0].features.push(box([60,1,0.25],[0,0,8]));assert.match((await review(d)).issues.join(' '),/装入/);
 const blocked=example();blocked.cadPlan.bodies[1].positionMm=[0,0,3];assert.ok((await review(blocked)).issues.length);
 const absent=example();absent.cadPlan.fitChecks=[];assert.ok((await review(absent)).issues.length);
});
test('a pre-mounted bracket in the insertion route blocks the board even though final poses are clear',async()=>{
 const d=example();d.parts.push(part('固定支架','structural'));d.cadPlan.bodies.push(body('挡片',2,[box([3,3,0.2])],[0,0,9]));assert.match((await review(d)).issues.join(' '),/装入路径受实体 #3/);
});
test('external connector needs an aligned, unobstructed approach with lid closed',async()=>{
 const d=example();d.parts.push({...part('external power','external'),placement:'loose'});d.interaction={connections:[{fromPartIndex:2,fromPin:'OUT',toPartIndex:1,toPin:'VIN'}]};
 assert.match((await review(d)).issues.join(),/外接引脚/);d.cadPlan.fitChecks[0].portAccess=[{pins:['VIN'],bodyIndex:2,centerMm:[12,0,0],plugSizeMm:[4,6,2],approachMm:[45,0,0]}];
 assert.match((await review(d)).issues.join(),/插头路径受/);d.cadPlan.bodies[0].features.push(box([10,8,4],[28,0,0],'cut'));assert.deepEqual((await review(d)).issues,[]);
});
