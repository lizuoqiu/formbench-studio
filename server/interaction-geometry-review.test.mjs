import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewInteractionGeometry} from './interaction-geometry-review.mjs';
import {planRepair} from './design-repair.mjs';

const box=(sizeMm,centerMm=[0,0,0],op='add')=>({op,shape:'box',sizeMm,centerMm});
const body=(name,partIndex,positionMm,features,role='printed')=>({name,role,partIndex,positionMm,features});
const press={label:'推动手柄',kind:'press',axis:[1,0,0],step:8,fixedBodyIndex:0,movingBodyIndices:[1]};
function design(bodies,control=press){return {parts:bodies.map(b=>({name:b.name})),cadPlan:{version:1,bodies},interaction:{controls:[control]}};}

test('a press stops at a fixed obstruction halfway, even when the end pose clears',async()=>{
  const d=design([body('障碍',0,[4,0,0],[box([1,4,4])]),body('滑块',1,[0,0,0],[box([1,2,2])])]);
  const result=await reviewInteractionGeometry(d);assert.equal(result.status,'checked');assert.equal(result.issues.length,1);assert.match(result.issues[0],/4 mm.*滑块.*障碍.*4 mm³/);
});

test('sitting in a housing hole and end-face contact are allowed; excess travel conflicts',async()=>{
  const d=design([body('基座',0,[0,0,0],[box([10,6,6]),box([10,3,3],[-1,0,0],'cut')]),body('压杆',1,[-3,0,0],[box([2,2,2])])],{...press,step:6});
  assert.deepEqual((await reviewInteractionGeometry(d)).issues,[]);d.interaction.controls[0].step=7;assert.match((await reviewInteractionGeometry(d)).issues[0],/压杆.*基座/);
});

test('tests rotation in world coordinates, both directions, around an offset non-Z axis',async()=>{
  const controls={...press,label:'摇臂',kind:'turn',step:90,pivotMm:[10,8,4],axis:[0,1,0]};
  const d=design([body('左止挡',0,[10,8,9],[box([1.5,2,1.5])]),body('摆块',1,[15,8,4],[box([1,1,1])])],controls);
  const result=await reviewInteractionGeometry(d);assert.equal(result.status,'checked');assert.match(result.issues[0],/-90°.*摆块.*左止挡/);
  d.interaction.controls[0].step=-90;
  const reverse=await reviewInteractionGeometry(d);assert.equal(reverse.status,'checked');assert.match(reverse.issues[0],/-90°.*摆块.*左止挡/);
  assert.ok(reverse.checks.some(c=>c.includes('25 个姿态')));
});

test('a single box from a purchased dimensional envelope does not block an assembly',async()=>{
  const d=design([body('采购件外框',0,[4,0,0],[box([1,4,4])],'reference'),body('滑块',1,[0,0,0],[box([1,2,2])])]);
  const r=await reviewInteractionGeometry(d);assert.deepEqual(r.issues,[]);assert.ok(r.checks.some(c=>c.includes('实际轮廓')));
});

test('an asymmetric angle sweep checks the interior of its shorter side',async()=>{
  const degrees=-2.5, t=degrees*Math.PI/180, radius=80;
  const d=design([body('侧向止挡',0,[radius*Math.cos(t),radius*Math.sin(t),0],[box([1,1,1])]),
    body('摆臂触点',1,[radius,0,0],[box([1,1,1])])]);
  d.interaction.controls=[];
  d.cadPlan.joints=[{name:'探针',axis:[0,0,1],pivotMm:[0,0,0],minDegrees:-5,maxDegrees:150,
    movingBodyIndices:[1],fixedBodyIndex:0,actuatorPartIndex:0,parentIndex:null}];
  const result=await reviewInteractionGeometry(d);
  assert.equal(result.status,'checked');
  assert.equal(result.issues.length,1);
  assert.match(result.issues[0],/-2\.5°.*摆臂触点.*侧向止挡/);
});

test('a legacy draft with a cross-driven mount opens but cannot pass a new hierarchy review',async()=>{
  const d=twoAxisDesign([-100,100,0]);
  d.cadPlan.joints[0].movingBodyIndices=[1];
  d.cadPlan.joints[1].parentIndex=null;
  const r=await reviewInteractionGeometry(d);
  assert.equal(r.status,'unavailable');
  assert.equal(r.issues.length,1);
  assert.match(r.issues[0],/末端轴.*#1.*底座轴/);
  assert.ok(r.checks.some(c=>c.includes('未执行几何运动采样')));
});

test('fixed control mount crossing a printed panel is identified independently of cap travel',async()=>{
  const d=design([body('固定座',0,[0,0,0],[box([4,4,4]),box([3,3,1],[0,0,2])],'reference'),body('外部帽',1,[-10,0,0],[box([2,2,2])]),body('面板',2,[0,0,2],[box([10,10,1])])],{...press,step:1});
  const r=await reviewInteractionGeometry(d);assert.equal(r.issues.length,1);assert.match(r.issues[0],/0 mm.*固定座.*面板/);
});

test('touch-only, unsupported kernels and cancelled evaluations do not announce a geometry check',async()=>{
  const d=design([body('A',0,[0,0,0],[box([1,1,1])]),body('B',1,[2,0,0],[box([1,1,1])])]);
  assert.equal((await reviewInteractionGeometry(d,{local:false})).status,'unavailable');
  await assert.rejects(reviewInteractionGeometry(d,{signal:AbortSignal.abort()}),{name:'AbortError'});
  d.interaction.controls=[{kind:'touch'}];assert.equal((await reviewInteractionGeometry(d)).status,'not-applicable');
});

test('matching cylindrical shaft/bore facets that rotate out of phase are not a proven collision',async()=>{
  const cylinder=(op,d,h)=>({op,shape:'cylinder',sizeMm:[d,d,h],centerMm:[0,0,0]});
  const d=design([body('轴座',0,[0,0,0],[box([24,24,10]),cylinder('cut',20,12)]),body('转轴',1,[0,0,0],[cylinder('add',20,8)])],{...press,kind:'turn',axis:[0,0,1],pivotMm:[0,0,0],step:15});
  const r=await reviewInteractionGeometry(d);assert.deepEqual(r.issues,[]);assert.ok(r.checks.some(c=>c.includes('复核径向公差')));
  d.cadPlan.bodies[1].features[0]=cylinder('add',21,8);assert.match((await reviewInteractionGeometry(d)).issues[0],/转轴.*轴座/);
});

test('a nominated body whose cuts leave no real solid must be repaired',async()=>{
  const d=design([body('被切空的轴座',0,[4,0,0],[box([1,1,1]),box([2,2,2],[0,0,0],'cut')]),body('杆',1,[0,0,0],[box([1,1,1])])]);
  const r=await reviewInteractionGeometry(d);assert.equal(r.status,'unavailable');assert.match(r.issues[0],/被切空的轴座.*无法重建/);
});

test('a driven mechanism uses its CAD guide and actuator even without an interactive control',async()=>{
  const d=design([body('导架',0,[4,0,0],[box([1,4,4])]),body('滑车',1,[0,0,0],[box([1,2,2])]),body('驱动缸',2,[-8,0,0],[box([1,4,4])])]);
  d.interaction.controls=[];
  d.cadPlan.motions=[{type:'prismatic',name:'滑车进给',axis:[1,0,0],travelMm:8,movingBodyIndices:[1],actuatorPartIndex:2,guidePartIndex:0,controllerPartIndex:2}];
  const r=await reviewInteractionGeometry(d);assert.equal(r.status,'checked');assert.match(r.issues[0],/滑车进给在 4 mm.*导架/);
});

test('a larger assembly checks all poses without spending the solid budget on disjoint boxes',async()=>{
  const bodies=Array.from({length:40},(_,i)=>body('part '+i,i,[i*10,0,i<13?20:1000],[box([1,1,1])]));
  const d=design(bodies,{...press,kind:'turn',label:'serial joint',axis:[0,0,1],pivotMm:[0,0,0],step:90,
    movingBodyIndices:Array.from({length:12},(_,i)=>i+1),fixedBodyIndex:0});
  const r=await reviewInteractionGeometry(d);assert.equal(r.status,'checked');assert.deepEqual(r.issues,[]);
  assert.ok(r.checks.some(c=>c.includes('25 个姿态')));
});

test('later axes finish over 1400 intersections per axis without inheriting exhausted budgets',async()=>{
 const bodies=Array.from({length:45},(_,i)=>body('envelope '+i,i,[0,0,0],[box([4,4,4])],i<40?'printed':'reference'));
 const d=design(bodies);
 d.interaction.controls=[0,1,2].map(k=>({...press,label:'axis '+k,kind:'turn',axis:[0,0,1],pivotMm:[0,0,0],step:1,
  movingBodyIndices:[40,41,42,43,44],fixedBodyIndex:0}));
 const result=await reviewInteractionGeometry(d);
 assert.equal(result.status,'checked',result.checks.join('\n'));
 for(let k=0;k<3;k++)assert.ok(result.checks.some(c=>c.startsWith('axis '+k+'：')&&c.includes('9 个姿态')));
});

function twoAxisDesign(obstacle,role='printed'){
 const bodies=[body('组合姿态障碍',0,obstacle,[box([1,1,1])],role),
  body('第二轴固定座',1,[10,0,0],[box([1,1,1])]),body('末端负载',2,[20,0,0],[box([1,1,1])])];
 return {parts:bodies.map(b=>({name:b.name})),cadPlan:{version:1,bodies,joints:[
  {name:'底座轴',axis:[0,0,1],pivotMm:[0,0,0],minDegrees:0,maxDegrees:90,movingBodyIndices:[1,2],fixedBodyIndex:0,actuatorPartIndex:0,parentIndex:null},
  {name:'末端轴',axis:[0,0,1],pivotMm:[10,0,0],minDegrees:0,maxDegrees:90,movingBodyIndices:[2],fixedBodyIndex:1,actuatorPartIndex:1,parentIndex:0}
 ]}};
}

test('a collision requiring both serial joints is found after all individual sweeps clear',async()=>{
 const d=twoAxisDesign([-10,10,0]);
 const result=await reviewInteractionGeometry(d);
 assert.equal(result.status,'checked');
 assert.equal(result.issues.length,1);
 assert.match(result.issues[0],/联动姿态.*J1=90°.*J2=90°.*组合姿态障碍.*末端负载.*1 mm³/);
 assert.ok(result.checks.some(c=>c.includes('联动检查：2 个关节')));
 d.cadPlan.bodies[0].positionMm=[-100,100,0];
 assert.deepEqual((await reviewInteractionGeometry(d)).issues,[]);
});

test('combined sweeps leave imported envelopes uncertain and preserve rigid-group contacts',async()=>{
 const envelopeDesign=twoAxisDesign([-10,10,0],'reference');
 const envelopeResult=await reviewInteractionGeometry(envelopeDesign);
 assert.equal(envelopeResult.status,'checked');assert.deepEqual(envelopeResult.issues,[]);
 assert.ok(envelopeResult.checks.some(c=>c.includes('联动中尺寸包络')));
 const rigid=twoAxisDesign([-100,100,0]);
 rigid.parts.push({name:'同架连接件'});
 rigid.cadPlan.bodies.push(body('同架连接件',3,[20,0,0],[box([1,1,1])]));
 rigid.cadPlan.joints[0].movingBodyIndices.push(3);
 rigid.cadPlan.joints[1].movingBodyIndices.push(3);
 const r=await reviewInteractionGeometry(rigid);
 assert.equal(r.status,'checked');assert.deepEqual(r.issues,[]);
});

test('repair planning rechecks an older saved assembly and sends combined collision evidence to the model',async()=>{
 let input,instructions;
 const candidate=twoAxisDesign([-10,10,0]);
 const send=async(_url,options)=>{const body=JSON.parse(options.body);input=JSON.parse(body.input);instructions=body.instructions;return Response.json({status:'completed',model:'fixture',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({strategy:'repair',diagnosis:'combined collision',changes:['repair collision'],research:[],acceptance:['combined sweep clears']})}]}]});};
 const plan=await planRepair({prompt:'An articulated device'}, {selection:{requirements:['combined motion']},candidate,issues:[],rounds:[]},
  {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},send,new AbortController().signal);
 assert.equal(input.currentGeometry.status,'checked');assert.match(input.currentGeometry.issues[0],/联动姿态/);
 assert.deepEqual(plan.verification.currentGeometry,input.currentGeometry);
 assert.match(instructions,/name: interaction-hardware/);assert.match(instructions,/不安排尚不存在的动态几何/);
 assert.equal(plan.runtimeSkill.name,'interaction-hardware');
 assert.equal(plan.policy.name,'hardware-design-policy');assert.equal(plan.policy.stage,'repair');
});
test('a wrist-mounted jaw strikes a fixed post only after rotating and independently extending',async()=>{
 const bodies=[body('固定柱',0,[0,16,0],[box([1,1,1])]),body('导轨',1,[7,0,0],[box([1,1,1])]),body('夹爪',2,[10,0,0],[box([1,1,1])])];
 const d={parts:bodies.map(b=>({name:b.name})),cadPlan:{version:1,bodies,joints:[{name:'转腕',axis:[0,0,1],pivotMm:[0,0,0],minDegrees:0,maxDegrees:90,movingBodyIndices:[1,2],fixedBodyIndex:0,actuatorPartIndex:1,parentIndex:null}],motions:[{type:'prismatic',actuatorPartIndex:1,controllerPartIndex:0,name:'夹爪开合',axis:[1,0,0],travelMm:6,guidePartIndex:1,movingBodyIndices:[2],parentJointIndex:0}]}};
 const r=await reviewInteractionGeometry(d);assert.equal(r.status,'checked',r.checks.join(' '));assert.match(r.issues.join(' '),/J1=90°.*滑动 100%.*固定柱.*夹爪/);
 bodies[0].positionMm=[0,19,0];assert.deepEqual((await reviewInteractionGeometry(d)).issues,[]);
});
