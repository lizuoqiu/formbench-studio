import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewInteractionGeometry} from './interaction-geometry-review.mjs';

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
});

test('a single box from a purchased dimensional envelope does not block an assembly',async()=>{
  const d=design([body('采购件外框',0,[4,0,0],[box([1,4,4])],'reference'),body('滑块',1,[0,0,0],[box([1,2,2])])]);
  const r=await reviewInteractionGeometry(d);assert.deepEqual(r.issues,[]);assert.ok(r.checks.some(c=>c.includes('实际轮廓')));
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
