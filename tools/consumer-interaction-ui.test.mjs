// Direct manipulation of rendered bodies, using the same state machine as the
// generated hardware. Tests never call an AI service or use paid generations.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';
import {compileCadPlan} from '../cad-plan-compiler.js';

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
async function target(page,id){
 return page.locator('[data-ci-target="'+id+'"]').evaluate(marker=>{
  const box=marker.closest('.cc-stage').getBoundingClientRect();
  return {x:box.left+parseFloat(marker.style.left),y:box.top+parseFloat(marker.style.top)};
 });
}
async function mount(page,fixture,solid){
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/consumer-viewer.css"><link rel="stylesheet" href="/consumer-interaction.css"><main id="viewer"></main><aside id="parts"></aside>'});
  if(url.pathname==='/api/forge/plan')return route.fulfill({json:solid});
  if(/\.(js|css)$/.test(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('.'+url.pathname,root))});
  return route.fulfill({status:404,body:''});
 });
 await page.goto(origin);
 await page.evaluate(async fixture=>{
  const {mountConsumerCad}=await import('/consumer-cad.js');
  window.unmount=mountConsumerCad(document.querySelector('#viewer'),fixture,{partsPanel:document.querySelector('#parts'),onStatus:status=>window.geometryStatus=status});
 },fixture);
 await page.waitForFunction(()=>window.geometryStatus?.exact&&window.geometryStatus.phase==='ready');await rendered(page);
}

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
