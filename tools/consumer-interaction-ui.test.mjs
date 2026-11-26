// Direct manipulation of rendered bodies, using the same state machine as the
// generated hardware. Tests never call an AI service or use paid generations.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';
import {compileCadPlan} from '../cad-plan-compiler.js';
import {reviewDraftBrowser,checkJoints,checkHold,checkTravel} from '../server/draft-browser.mjs';

const root=new URL('../',import.meta.url),origin='http://127.0.0.1:4198';
const part=(name,role,sizeMm)=>({name,role,sizeMm,qty:1,spec:name,dimensionSource:'specified'});
const body=(name,partIndex,positionMm,shape,sizeMm)=>({name,partIndex,role:partIndex===0?'printed':'reference',positionMm,features:[{op:'add',shape,sizeMm,centerMm:[0,0,0]}]});
const design={name:'直接交互试件',parts:[part('底板','enclosure',[80,60,4]),part('旋钮','panel',[14,14,12]),part('按键','panel',[10,10,8]),part('滑块','panel',[8,14,6]),part('灯','panel',[8,8,3]),part('屏幕','panel',[23,10,2])],cadPlan:{version:1,bodies:[
 body('固定底板',0,[0,0,0],'box',[80,60,4]),
 body('旋钮电路板',1,[-20,0,3],'box',[14,14,2]),
 {...body('独立旋钮帽',1,[-20,0,10],'cylinder',[12,12,10]),features:[{op:'add',shape:'cylinder',sizeMm:[12,12,10],centerMm:[0,0,0]},{op:'add',shape:'box',sizeMm:[9,2,2],centerMm:[3,0,5]}]},
 body('按键固定座',2,[17,-12,3],'box',[12,12,2]),body('独立按键帽',2,[17,-12,8],'box',[10,10,6]),
 body('滑块轨道',3,[14,13,3],'box',[24,14,2]),body('独立滑块',3,[7,13,8],'box',[8,14,6]),
 body('指示灯',4,[-20,20,5],'cylinder',[8,8,3]),body('屏幕玻璃',5,[-10,-20,4],'box',[23,10,2])
 ]},interaction:{
 initialState:'off',timer:null,
 controls:[
  {id:'turn',label:'调节旋钮',kind:'turn',partIndex:1,fixedBodyIndex:1,movingBodyIndices:[2],axis:[0,0,1],pivotMm:[-20,0,10],step:30,signalPins:[]},
  {id:'press',label:'启停按键',kind:'press',partIndex:2,fixedBodyIndex:3,movingBodyIndices:[4],axis:[0,0,-1],pivotMm:[17,-12,8],step:2,signalPins:[]},
  {id:'slide',label:'切换滑块',kind:'slide',partIndex:3,fixedBodyIndex:5,movingBodyIndices:[6],axis:[1,0,0],pivotMm:[7,13,8],step:14,signalPins:[]}
 ],outputs:[{id:'lamp',label:'状态灯',kind:'light',partIndex:4,bodyIndices:[7],signalPin:'GP0'}],
 states:[{id:'off',label:'已关闭',clock:'hold',outputs:[{outputId:'lamp',mode:'off'}]},{id:'on',label:'已开启',clock:'hold',outputs:[{outputId:'lamp',mode:'on'}]}],
 transitions:[{from:'off',event:'press',to:'on',effect:'none'},{from:'on',event:'press',to:'off',effect:'none'},{from:'off',event:'slide',to:'on',effect:'none'},{from:'on',event:'slide',to:'off',effect:'none'}]
 }};
const rendered=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
test('draft review probes the supplied compiled revision before accepting viewer evidence',async()=>{
 const load=async file=>JSON.parse(await readFile(new URL('samples/shared/hygrometer/'+file,root),'utf8'));
 const [{design:fixture},compiled]=await Promise.all([load('v1.json'),load('v1-cad.json')]);
 // This fixture drives an existing mesh with a test-only joint in the viewer.
 const joint={name:'测试转轴',axis:[0,0,1],pivotMm:[0,0,0],minDegrees:-40,maxDegrees:40,
  movingBodyIndices:[2],fixedBodyIndex:0,actuatorPartIndex:0,parentIndex:null};
 fixture.cadPlan.joints=[joint];compiled.cadPlan.joints=[joint];
 const proof=await reviewDraftBrowser(fixture,compiled,process.env);
 assert.equal(proof.status,'observed',proof.reason);
 assert.equal(proof.joints.status,'passed',JSON.stringify(proof.joints));
 assert.deepEqual(proof.joints.changed,[0]);
 assert.deepEqual(proof.joints.observations[0].directMoved,[2]);
 assert.equal(proof.joints.observations[0].fixedVerified,true);
 assert.equal(proof.joints.home.pose.status,'passed');
 assert.equal(proof.held.status,'not-applicable');
 const stale=structuredClone(fixture);stale.cadPlan.bodies[0].name='另一版本';
 const unavailable=await reviewDraftBrowser(stale,compiled,process.env);
 assert.equal(unavailable.status,'unavailable');
 assert.equal(unavailable.joints,undefined);
});
async function target(page,id){
 return page.locator('[data-ci-target="'+id+'"]').evaluate(marker=>{
  const box=marker.closest('.cc-stage').getBoundingClientRect();
  return {x:box.left+parseFloat(marker.style.left),y:box.top+parseFloat(marker.style.top)};
 });
}
async function mount(page,fixture,solid,{freezeMesh=false}={}){
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/consumer-viewer.css"><link rel="stylesheet" href="/consumer-interaction.css"><main id="viewer"></main><aside id="parts"></aside>'});
  if(freezeMesh&&url.pathname==='/consumer-cad.js'){
   const original=await readFile(new URL('consumer-cad.js',root),'utf8');
   const faulty=original.replace('bodyPose(item,motions,motionProgress);','item.positionMm;');
   assert.notEqual(faulty,original,'fault injection must freeze the drawn mesh offset');
   return route.fulfill({contentType:'text/javascript',body:faulty});
  }
  if(freezeMesh&&url.pathname==='/assembly-joints.js')return route.fulfill({contentType:'text/javascript',body:'export * from "/working-assembly-joints.js"; export function jointMesh(mesh) { return mesh; }'});
  if(freezeMesh&&url.pathname==='/working-assembly-joints.js')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('assembly-joints.js',root))});
  if(url.pathname==='/api/forge/plan')return route.fulfill({json:solid});
  if(/\.(js|css|json)$/.test(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.json')?'application/json':'text/css',body:await readFile(new URL('.'+url.pathname,root))});
  return route.fulfill({status:404,body:''});
 });
 await page.goto(origin);
 await page.evaluate(async fixture=>{
  const {mountConsumerCad}=await import('/consumer-cad.js');
  window.unmount=mountConsumerCad(document.querySelector('#viewer'),fixture,{partsPanel:document.querySelector('#parts'),onDrawScene:(scene,backdrop,mode,values)=>{window.draftDrawing={scene,backdrop,mode,angles:[...values]};},onStatus:status=>window.geometryStatus=status});
 },fixture);
 await page.waitForFunction(()=>window.geometryStatus?.exact&&window.geometryStatus.phase==='ready');await rendered(page);
}

test('saved joint chains and linear travel expose their actual parts, directions, limits and controls',async t=>{
 const fixture=structuredClone(design);
 fixture.interaction=null;
 fixture.cadPlan.joints=[
  {name:'底座旋转',axis:[0,0,-1],pivotMm:[0,0,3],minDegrees:-40,maxDegrees:55,movingBodyIndices:[1,2],fixedBodyIndex:0,actuatorPartIndex:1,parentIndex:null},
  {name:'腕部摆动',axis:[0.6,0.8,0],pivotMm:[-20,0,10],minDegrees:-10,maxDegrees:20,movingBodyIndices:[2],fixedBodyIndex:1,actuatorPartIndex:1,parentIndex:0}];
 fixture.cadPlan.motions=[{name:'直线滑块',type:'prismatic',axis:[1,0,0],travelMm:12,movingBodyIndices:[6],actuatorPartIndex:3,guidePartIndex:3,controllerPartIndex:5}];
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:850}});
 await mount(page,fixture,await compileCadPlan(fixture.cadPlan));
 const measured=await checkJoints(page,fixture.cadPlan.joints);
 assert.equal(measured.status,'passed',JSON.stringify(measured));
 assert.deepEqual(measured.observations[0].directMoved,[1]);
 assert.deepEqual(measured.observations[0].downstreamMoved,[2]);
 assert.deepEqual(measured.observations[0].childMountsCarried,[1]);
 assert.equal(measured.observations[1].fixedVerified,true);
 assert.equal(measured.home.pose.status,'passed');
 const frozen=await browser.newPage();t.after(()=>frozen.close());
 await mount(frozen,fixture,await compileCadPlan(fixture.cadPlan),{freezeMesh:true});
 const failure=await checkJoints(frozen,fixture.cadPlan.joints);
 assert.deepEqual(failure.changed,[0,1],'joint controls still move');
 assert.equal(failure.status,'failed');
 assert.deepEqual(failure.observations[0].mismatched,[1,2]);
 assert.notEqual(failure.home.passed,true,'a viewer with permanently frozen meshes did not demonstrate a reset');
 const positiveTravel=await checkTravel(page,fixture);
 assert.equal(positiveTravel.status,'passed',JSON.stringify(positiveTravel));
 const [mid,end,back]=positiveTravel.observations[0].samples;
 assert.ok(mid.percent>0&&mid.percent<100);
 assert.deepEqual(end.pose.witness.displacementMm,[12,0,0]);
 assert.deepEqual(end.pose.fixedReferences,[0,5]);
 assert.deepEqual(back.pose.witness.displacementMm,[0,0,0]);
 const frozenTravel=await checkTravel(frozen,fixture);
 assert.equal(frozenTravel.status,'failed',JSON.stringify(frozenTravel));
 assert.ok(frozenTravel.observations[0].samples.every(s=>s.sliderPassed));
 assert.deepEqual(frozenTravel.observations[0].samples[1].pose.mismatched,[6]);
 const first=page.locator('[data-cc-mechanism="joint"][data-index="0"]');
 const wrist=page.locator('[data-cc-mechanism="joint"][data-index="1"]');
 const slide=page.locator('[data-cc-mechanism="travel"]');
 assert.equal(await first.locator('[data-cc-link-from="base_link"][data-cc-link-to="link_r1"]').innerText(),'连杆：固定部分 → 旋钮电路板');
 assert.equal(await wrist.locator('[data-cc-link-from="link_r1"][data-cc-link-to="link_r2"]').innerText(),'连杆：旋钮电路板 → 独立旋钮帽');
 assert.equal(await slide.locator('[data-cc-link-from="base_link"][data-cc-link-to="link_p1"]').innerText(),'连杆：固定部分 → 独立滑块');
 assert.match(await first.innerText(),/根关节 · 初始−Z 轴 · -40° 至 55°/);
 assert.match(await wrist.innerText(),/上级：底座旋转 · 初始轴向 \(0.6, 0.8, 0\) · -10° 至 20°/);
 await wrist.locator('summary').click();
 assert.match(await wrist.locator('dl').innerText(),/固定端\s+旋钮电路板/);
 assert.match(await wrist.locator('dl').innerText(),/初始轴心\s+-20，0，10 mm/);
 assert.equal(await wrist.locator('li').innerText(),'独立旋钮帽');
 assert.match(await slide.innerText(),/初始\+X 轴 · 0 至 12 mm/);
 assert.match(await slide.locator('output').innerText(),/0 \/ 12 mm/);
 await page.getByRole('button',{name:'分解',exact:true}).click();
 assert.ok(await wrist.locator('summary').isVisible());
 assert.equal(await wrist.locator('input').isVisible(),false);
 await wrist.getByRole('button',{name:'在装配中演示'}).click();
 assert.ok(await wrist.locator('input').isVisible());
 for(let i=0;i<5;i++)await wrist.getByRole('button',{name:'腕部摆动增加5度'}).click();
 assert.equal(await wrist.locator('output').innerText(),'20°');
 assert.equal(await first.locator('output').innerText(),'0°');
 await slide.locator('input').focus();await page.keyboard.press('End');
 assert.match(await slide.locator('output').innerText(),/12 \/ 12 mm/);
 await page.getByRole('button',{name:'回到初始姿态'}).click();
 assert.equal(await wrist.locator('output').innerText(),'0°');
 assert.match(await slide.locator('output').innerText(),/0 \/ 12 mm/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});

test('a model click explains its BOM purpose while dragging keeps camera control',async t=>{
 const fixture={name:'部件用途',parts:[{...part('外接操作端','external',[58,40,6]),kind:'provided',purpose:'发送角度指令和显示运行状态。'}],
  cadPlan:{version:1,bodies:[body('操作端外形',0,[0,0,0],'box',[58,40,6])]},interaction:null};
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:900,height:700}});t.after(()=>page.close());
 await mount(page,fixture,await compileCadPlan(fixture.cadPlan));
 const canvas=page.locator('.cc-stage canvas'),info=page.locator('[data-cc-focus-info]');
 const box=await canvas.boundingBox(),point={x:box.x+box.width*.5,y:box.y+box.height*.51};
 await page.mouse.click(point.x,point.y);await rendered(page);
 assert.equal(await info.locator('[data-cc-focus-name]').innerText(),'外接操作端');
 assert.equal(await info.locator('[data-cc-focus-kind]').innerText(),'用户自备');
 assert.equal(await info.locator('[data-cc-focus-purpose]').innerText(),fixture.parts[0].purpose);
 assert.equal(await page.locator('[data-cc-focus-part="0"]').getAttribute('aria-pressed'),'true');
 assert.ok(await page.locator('[data-cc-part-purpose="0"]').isVisible());
 await page.getByRole('button',{name:'返回装配',exact:true}).click();await rendered(page);
 await page.mouse.move(point.x,point.y);await page.mouse.down();
 await page.mouse.move(point.x+50,point.y,{steps:4});await rendered(page);
 await page.mouse.move(point.x,point.y,{steps:4});await page.mouse.up();await rendered(page);
 assert.equal(await info.isVisible(),false);
 assert.equal(await page.locator('[data-cc-focus-part="0"]').getAttribute('aria-pressed'),'false');
 await page.getByRole('button',{name:'定位外接操作端',exact:true}).click();
 assert.equal(await info.locator('[data-cc-focus-purpose]').innerText(),fixture.parts[0].purpose);
});

for(const remote of [false,true])test((remote?'page command without a CAD button':'physical button')+' moves its native joint and stops on release or cancellation',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1100}});t.after(()=>page.close());
 const fixture=structuredClone(design);
 fixture.cadPlan.joints=[{name:'预览转轴',axis:[0,0,1],pivotMm:[-20,0,10],minDegrees:-40,maxDegrees:40,
  movingBodyIndices:[2],fixedBodyIndex:1,actuatorPartIndex:1,parentIndex:null}];
 const control={...fixture.interaction.controls[1],id:'jog'};
 if(remote){fixture.parts.push({...part('手机命令端','external',[60,100,8]),kind:'provided',placement:'loose'});Object.assign(control,{kind:'command',partIndex:fixture.parts.length-1,fixedBodyIndex:null,movingBodyIndices:[],axis:[],pivotMm:[],step:0,range:null});}
 fixture.interaction.controls=[control];
 fixture.interaction.outputs=[{id:'axis',label:'转轴',kind:'motion',partIndex:1,bodyIndices:[2],signalPin:'signal',motion:{type:'joint',index:0,speed:30}}];
 fixture.interaction.initialState='off';
 fixture.interaction.states=[['off','off'],['moving','forward']].map(([id,mode])=>({id,label:id,clock:'hold',outputs:[{outputId:'axis',mode}]}));
 fixture.interaction.transitions=[{from:'off',event:'jog.down',to:'moving',effect:'none'},...['up','cancel'].map(phase=>({from:'moving',event:'jog.'+phase,to:'off',effect:'none'}))];
 await mount(page,fixture,await compileCadPlan(fixture.cadPlan));
 if(remote){
  assert.equal(await page.locator('[data-ci-target=jog]').count(),0,'a page command has no fictitious touch target in CAD');
  const proof=await checkHold(page,fixture.interaction,fixture.cadPlan.joints);
  assert.equal(proof.status,'passed',JSON.stringify(proof));
  assert.equal(proof.motion.witness.bodyIndex,2);
  assert.equal(proof.stop.status,'passed');
  await page.locator('[data-cc-motion-action="home"]').click();
 }
 const button=page.locator('[data-ci-press=jog]'),joint=page.locator('[data-cc-joint="0"]'),canvas=page.locator('.cc-stage canvas');
 await button.hover();const before=await canvas.screenshot();await page.mouse.down();
 await page.waitForFunction(()=>Number(document.querySelector('[data-cc-joint="0"]').value)>=10);
 assert.equal(await page.locator('[data-ci-state]').innerText(),'moving');
 await page.mouse.up();const stopped=Number(await joint.inputValue());
 await page.waitForTimeout(350);assert.equal(Number(await joint.inputValue()),stopped);
 assert.equal(await page.locator('[data-ci-state]').innerText(),'off');assert.ok(!before.equals(await canvas.screenshot()));
 await button.hover();await page.mouse.down();
 await page.waitForFunction(value=>Number(document.querySelector('[data-cc-joint="0"]').value)>value,stopped);
 await button.dispatchEvent('pointercancel',{pointerId:1});const cancelled=Number(await joint.inputValue());
 await page.waitForTimeout(350);assert.equal(Number(await joint.inputValue()),cancelled);assert.equal(await page.locator('[data-ci-state]').innerText(),'off');await page.mouse.up();
 await button.focus();await page.keyboard.down('Space');
 await page.waitForFunction(()=>Number(document.querySelector('[data-cc-joint="0"]').value)===40);
 await page.keyboard.up('Space');assert.equal(await page.locator('[data-ci-state]').innerText(),'off');
 await page.keyboard.down('Space');assert.equal(await page.locator('[data-ci-state]').innerText(),'moving');
 await page.keyboard.press('Tab');assert.equal(await page.locator('[data-ci-state]').innerText(),'off');await page.keyboard.up('Space');
 await page.getByRole('button',{name:'回到初始姿态',exact:true}).click();assert.equal(Number(await joint.inputValue()),0);
 await page.getByRole('button',{name:'预览转轴增加5度',exact:true}).click();assert.equal(Number(await joint.inputValue()),5);
 await button.hover();await page.mouse.down();await page.waitForFunction(()=>Number(document.querySelector('[data-cc-joint="0"]').value)>7);
 await page.locator('[data-cc-motion-action=stop]').evaluate(b=>b.click());const halted=Number(await joint.inputValue());await page.waitForTimeout(250);assert.equal(Number(await joint.inputValue()),halted);assert.equal(await page.locator('[data-ci-state]').innerText(),'off');await page.mouse.up();
 if(remote){await page.setViewportSize({width:390,height:1100});await rendered(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/formbench-controls-mobile.png',fullPage:true});}
});

test('native transforms rotate only declared caps and keep boards and source geometry fixed',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();t.after(()=>page.close());
 await mount(page,design,await compileCadPlan(design.cadPlan));
 const result=await page.evaluate(async model=>{
  const {interactionMesh}=await import('/consumer-interaction.js');
  const mesh={points:[[1,0,0]],indices:[],palette:[],projected:new Float64Array(3)},original=JSON.stringify(mesh.points),offset=[-20,0,10];
  const snapshot={controlValues:{turn:90}};
  const rotating=interactionMesh(mesh,offset,2,model,snapshot).points;
  const front=structuredClone(model);front.controls[0].axis=[0,-1,0];
  const frontRotation=interactionMesh(mesh,offset,2,front,snapshot).points;
  const board=interactionMesh(mesh,offset,1,model,snapshot),shell=interactionMesh(mesh,offset,0,model,snapshot);
  const pressed=interactionMesh(mesh,[17,-12,8],4,model,snapshot,{press:1}).points;
  const released=interactionMesh(mesh,[17,-12,8],4,model,snapshot,{press:0});
  return {rotating,frontRotation,pressed,boardUnchanged:board===mesh,shellUnchanged:shell===mesh,released:released===mesh,sourceUnchanged:original===JSON.stringify(mesh.points)};
 },design.interaction);
 assert.ok(Math.abs(result.rotating[0][0])<1e-7);assert.ok(Math.abs(result.rotating[0][1]-1)<1e-7);
 assert.ok(Math.abs(result.frontRotation[0][0])<1e-7);assert.ok(Math.abs(result.frontRotation[0][2]-1)<1e-7);
 assert.deepEqual(result.pressed,[[1,0,-2]]);assert.ok(result.boardUnchanged&&result.shellUnchanged&&result.released&&result.sourceUnchanged);
});

test('system scenarios are folded, state-aware, and change outputs without moving a control',async t=>{
 const fixture=structuredClone(design);
 fixture.interaction.systemEvents=[{id:'lost',label:'USB 断连',kind:'connection',partIndex:2,sourcePins:['DATA'],condition:'The connection detector reports a lost link',delayMs:null}];
 fixture.interaction.transitions.push({from:'on',event:'lost',to:'off',effect:'none'});
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:980,height:900},reducedMotion:'reduce'});t.after(()=>page.close());
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await mount(page,fixture,await compileCadPlan(fixture.cadPlan));
 const event=page.getByRole('button',{name:'USB 断连',exact:true});
 assert.equal(await event.isVisible(),false);
 await page.getByText('模拟连接与故障',{exact:true}).click();assert.ok(await event.isDisabled());
 await page.getByRole('button',{name:'启停按键',exact:true}).click();await page.waitForTimeout(200);await rendered(page);
 const before=await page.locator('canvas').evaluate(c=>c.toDataURL());assert.equal(await event.isDisabled(),false);
 await event.click();await rendered(page);
 assert.match(await page.locator('[data-ci-state]').innerText(),/已关闭/);
 assert.equal(await page.locator('[data-ci-output=lamp]').getAttribute('data-mode'),'off');
 assert.equal(await page.locator('canvas').evaluate(c=>c.toDataURL()),before);
 assert.ok(await event.isDisabled());assert.deepEqual(errors,[]);
});

test('actual canvas knob, button and slider act on a non-timer state machine; background still orbits',async t=>{
 const solid=await compileCadPlan(design.cadPlan),browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 for(const width of [980,390])await t.test('viewport '+width,async t=>{
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});t.after(()=>page.close());page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await mount(page,design,solid);
  const canvas=page.locator('#viewer canvas'),image=()=>canvas.evaluate(c=>c.toDataURL());
  assert.equal(await page.locator('[data-cc-mode=closed]').getAttribute('aria-pressed'),'true');
  assert.ok(await page.locator('.ci-gesture').isVisible());assert.equal(await page.locator('[data-ci-finish]').count(),0);
  const knob=await target(page,'turn'),before=await image();
  await page.mouse.move(knob.x,knob.y);await page.mouse.down();await page.mouse.move(knob.x+45,knob.y,{steps:5});await page.mouse.up();await rendered(page);
  assert.equal(await page.locator('[data-ci-value=turn]').innerText(),'150°');assert.ok(await image()!==before,'asymmetric physical knob visibly rotates');
  const button=await target(page,'press'),released=await image();
  await page.mouse.move(button.x,button.y);await page.mouse.down();await rendered(page);assert.ok(await image()!==released,'button cap moves while held');
  await page.mouse.up();await rendered(page);assert.match(await page.locator('[data-ci-state]').innerText(),/已开启/);assert.equal(await page.locator('[data-ci-output=lamp]').getAttribute('data-mode'),'on');
  assert.ok(await image()===released,'cap returns to its original physical position on release');
  await page.getByRole('button',{name:'启停按键',exact:true}).press('Enter');assert.match(await page.locator('[data-ci-state]').innerText(),/已关闭/);await page.waitForTimeout(180);
  // World +X direction is computed from the same native camera projection as
  // the marker positions, without a test-only viewer control.
  const slider=await target(page,'slide'),startImage=await image();
  const direction=await page.locator('[data-ci-track=slide]').evaluate(line=>({x:Number(line.getAttribute('x2'))-Number(line.getAttribute('x1')),y:Number(line.getAttribute('y2'))-Number(line.getAttribute('y1'))}));
  await page.mouse.move(slider.x,slider.y);await page.mouse.down();await page.mouse.move(slider.x+direction.x,slider.y+direction.y,{steps:6});await rendered(page);assert.ok(await image()!==startImage,'slider follows the pointer along its declared world axis');
  await page.mouse.up();await rendered(page);assert.match(await page.locator('[data-ci-state]').innerText(),/已开启/);
  const orbitBefore=await image(),box=await canvas.boundingBox();await page.mouse.move(box.x+15,box.y+70);await page.mouse.down();await page.mouse.move(box.x+70,box.y+90);await page.mouse.up();await rendered(page);assert.ok(await image()!==orbitBefore,'dragging background orbits');
  await page.evaluate(()=>document.querySelector('#viewer').dispatchEvent(new CustomEvent('focus-hardware',{detail:{partIndex:1}})));await rendered(page);assert.equal(await page.locator('[data-cc-mode=inside]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-cc-focus-part="1"]').getAttribute('aria-pressed'),'true');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 });
});

test('timer preview exposes anchored screen, running light, keyboard alternatives and advance-to-end',async t=>{
 const timer=structuredClone(design);
 timer.interaction.timer={initialSeconds:120,minSeconds:30,maxSeconds:600,stepSeconds:30};
 // An encoder's rotary and push actions share the same independently modeled
 // cap. Dragging it must not accidentally dispatch a press on release.
 Object.assign(timer.interaction.controls[1],{label:'按下旋钮',partIndex:1,fixedBodyIndex:1,movingBodyIndices:[2],pivotMm:[-20,0,10]});
 timer.interaction.outputs.push({id:'screen',label:'时间',kind:'display',partIndex:5,bodyIndices:[8],signalPin:'GP1'});
 timer.interaction.initialState='ready';
 timer.interaction.states=[
  {id:'ready',label:'待开始',clock:'hold',outputs:[{outputId:'lamp',mode:'off'},{outputId:'screen',mode:'value'}]},
  {id:'running',label:'倒计时',clock:'run',outputs:[{outputId:'lamp',mode:'breathe'},{outputId:'screen',mode:'remaining'}]},
  {id:'done',label:'已完成',clock:'hold',outputs:[{outputId:'lamp',mode:'on'},{outputId:'screen',mode:'remaining'}]}
 ];
 timer.interaction.transitions=[{from:'ready',event:'turn',to:'ready',effect:'adjust'},{from:'ready',event:'press',to:'running',effect:'restart'},{from:'running',event:'timer.expired',to:'done',effect:'none'},{from:'done',event:'press',to:'ready',effect:'reset'}];
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:980,height:900},reducedMotion:'reduce'});t.after(()=>page.close());
 await mount(page,timer,await compileCadPlan(timer.cadPlan));
 const finish=page.locator('[data-ci-finish]'),screen=page.locator('[data-ci-output=screen]');
 assert.ok(await screen.isVisible());assert.equal(await screen.innerText(),'02:00');assert.ok(await finish.isDisabled());
 await page.getByRole('button',{name:'调节旋钮增加'}).press('Enter');assert.equal(await screen.innerText(),'02:30');
 const button=await target(page,'turn');
 await page.mouse.move(button.x,button.y);await page.mouse.down();await page.mouse.move(button.x+18,button.y,{steps:3});await page.mouse.up();await rendered(page);
 assert.match(await page.locator('[data-ci-state]').innerText(),/待开始/);assert.equal(await screen.innerText(),'03:30');
 await page.mouse.click(button.x,button.y);await rendered(page);
 assert.equal(await page.locator('[data-ci-output=lamp]').getAttribute('data-mode'),'breathe');assert.equal(await finish.isDisabled(),false);
 await page.waitForFunction(()=>document.querySelector('[data-ci-output=screen]').textContent!=='03:30');
 await finish.click();assert.match(await page.locator('[data-ci-state]').innerText(),/已完成.*00:00/);assert.equal(await screen.innerText(),'00:00');assert.equal(await page.locator('[data-ci-output=lamp]').getAttribute('data-mode'),'on');
 await page.getByRole('button',{name:'按下旋钮',exact:true}).press('Space');assert.match(await page.locator('[data-ci-state]').innerText(),/待开始/);
});
