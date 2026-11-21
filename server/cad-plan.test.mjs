import test from 'node:test';import assert from 'node:assert/strict';
import {validateCadPlan} from '../cad-plan.js';import {modelingGuide,generation} from './modeling-guide.mjs';
import {design} from './design.mjs';
import {readFile} from 'node:fs/promises';
import {cadPlanSchema} from './cad-plan.mjs';
const feature=(shape,centerMm,sizeMm,op='add')=>({shape,op,centerMm,sizeMm});
const body={name:'被动轻触拳面',role:'printed',partIndex:1,positionMm:[0,0,20],features:[feature('ellipsoid',[0,0,12],[60,42,24]),...[-18,-6,6,18].map(x=>feature('ellipsoid',[x,13,17],[14,18,16])),feature('ellipsoid',[-24,-4,14],[18,22,16]),feature('cylinder',[0,0,2],[8,8,5],'cut')]};
const plan={version:1,bodies:[body]};
test('a passive fist-shaped print has one palm, four knuckles, thumb and registration recess in its own coordinate frame',()=>{assert.equal(validateCadPlan(plan,2),plan);assert.throws(()=>validateCadPlan(plan,1));for(const patch of [{features:[feature('cylinder',[0,0,0],[2,3,4])]},{features:[feature('box',[0,0,0],[2,3,4],'cut')]},{features:[]},{name:'x',code:'not accepted'},{positionMm:[Infinity,0,0]}])assert.throws(()=>validateCadPlan({version:1,bodies:[{...body,...patch}]},2));});
test('API receives versioned modeling guidance and model identity is never inferred from generated text',async()=>{const g=await modelingGuide({});assert.match(g.skill.sourceUrl,/github\.com/);assert.match(g.text,/\.forge\.js/);let apiInput;const r=await design(new Request('https://unit.invalid/api/design',{method:'POST',body:JSON.stringify({prompt:'碰拳'})}),{OPENAI_API_KEY:'fixture',OPENAI_MODEL:'configured'},async(_,o)=>{apiInput=JSON.parse(o.body);return Response.json({status:'incomplete'});});assert.equal(r.status,502);assert.ok(apiInput.instructions.endsWith(g.text));assert.ok(apiInput.text.format.schema.required.includes('cadPlan'));assert.deepEqual(generation('openai-api',null,'configured',g.skill),{provider:'openai-api',modelId:null,modelSource:'undisclosed',skill:g.skill});assert.equal(generation('openai-api','actual-version','response',g.skill).modelSource,'response');});

test('historical plans omit Euler angles; new plans accept only bounded finite 3-axis degrees',()=>{const rotated=(v)=>({version:1,bodies:[{...body,features:[{...body.features[0],rotationDeg:v}]}]});for(const a of [[0,0,0],[-30.5,90,24],[360,-360,0]])assert.doesNotThrow(()=>validateCadPlan(rotated(a)));for(const a of [[0,0],[0,0,null],[361,0,0],[NaN,0,0],false])assert.throws(()=>validateCadPlan(rotated(a)));assert.doesNotThrow(()=>validateCadPlan(plan));});

test('motion metadata uses separate body and BOM indices, including split modules and a moving sensor',()=>{
 const bodies=[4,2,0,2,1,3].map(partIndex=>({...body,partIndex}));
 const motion={name:'滑台伸出',type:'prismatic',axis:[0,-1,0],travelMm:16,movingBodyIndices:[3,4,5],actuatorPartIndex:2,guidePartIndex:2,controllerPartIndex:0};
 const assembly=motions=>({version:1,bodies,motions});
 assert.ok(cadPlanSchema.required.includes('motions'));
 assert.doesNotThrow(()=>validateCadPlan(assembly([motion]),6));
 assert.doesNotThrow(()=>validateCadPlan(assembly([]),6));
 for(const patch of [{travelMm:0},{axis:[0,-2,0]},{axis:[0.1,0,0]},{movingBodyIndices:[6]},{movingBodyIndices:[4,4]},{movingBodyIndices:[]},{movingBodyIndices:bodies.map((_,i)=>i)},{controllerPartIndex:5},{guidePartIndex:7},{actuatorPartIndex:'2'}]){
  assert.throws(()=>validateCadPlan(assembly([{...motion,...patch}]),6));
 }
 assert.throws(()=>validateCadPlan(assembly([motion,{...motion,movingBodyIndices:[0,3]}]),6));
});

test('the Worker reads exactly the same maintained interaction skill that local API calls use',async()=>{
 const skill=await readFile(new URL('./skills/interaction-hardware/SKILL.md',import.meta.url),'utf8');
 const local=await modelingGuide();
 const worker=await modelingGuide({ASSETS:{fetch:async request=>{
  assert.equal(new URL(request.url).pathname,'/skills/interaction-hardware/SKILL.md');
  return new Response(skill);
 }}});
 assert.ok(local.text.endsWith(skill));
 assert.equal(worker.text,local.text);
 assert.deepEqual(worker.skill.project,local.skill.project);
 assert.equal(local.skill.project.name,'interaction-hardware');
 assert.equal(local.skill.project.sourcePath,'skills/interaction-hardware/SKILL.md');
 assert.ok(skill.split('\n---\n',1)[0].includes('revision: '+local.skill.project.revision));
 assert.equal(generation('openai-api','test-model','response',local.skill).skill.project.revision,local.skill.project.revision);
 assert.ok(skill.includes('movingBodyIndices')&&skill.includes('收回')&&skill.includes('placement=mounted'));
 await assert.rejects(modelingGuide({ASSETS:{fetch:async()=>new Response('<html>SPA fallback</html>')}}));
 await assert.rejects(modelingGuide({ASSETS:{fetch:async()=>new Response(skill.replace(/^  revision: .+\n/m,''))}}),/revision/);
});
