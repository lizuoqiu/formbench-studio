import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {lightPresentation,displayValue} from '../consumer-interaction.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const real=(JSON.parse(await readFile(path.join(root,'samples/shared/reading-timer/v5.json'),'utf8'))).design;
const lamp=real.interaction.outputs.find(output=>output.kind==='light'),screen=real.interaction.outputs.find(output=>output.kind==='display');
test('output appearance follows explicit bound lamp specifications and retains ambiguous defaults',()=>{
 assert.deepEqual(lightPresentation(lamp,real),{color:'red',rgb:'240 68 68',core:'#ffb2b2',cycleSeconds:6,explicitColor:true,explicitCycle:true});
 const output={label:'状态灯',kind:'light',partIndex:0};
 const design={parts:[{name:'绿色指示灯',spec:'绿色 LED'}],interaction:{outputs:[output]},steps:['状态灯呼吸周期为 4 秒。计时 300 秒；PWM 1 kHz。']};
 assert.equal(lightPresentation(output,design).color,'green');assert.equal(lightPresentation(output,design).cycleSeconds,4);
 design.steps=['状态灯以 1 kHz PWM 控制，等待 300 秒。'];assert.equal(lightPresentation(output,design).cycleSeconds,2.8);
 design.parts[0]={name:'指示灯',spec:'待选型'};
 assert.deepEqual(lightPresentation(output,design),{color:'green',rgb:'77 226 138',core:'#a0ffbd',cycleSeconds:2.8,explicitColor:false,explicitCycle:false});
 design.parts[0]={name:'可选红色或蓝色 LED'};design.steps=['状态灯呼吸周期 4 秒或呼吸周期 6 秒。'];
 assert.equal(lightPresentation(output,design).explicitColor,false);assert.equal(lightPresentation(output,design).explicitCycle,false);
 const two={parts:[{name:'左灯',spec:'蓝色 LED'},{name:'右灯',spec:'红色 LED'}],interaction:{outputs:[{...output,label:'左灯'},{...output,label:'右灯',partIndex:1}]},steps:['左灯呼吸周期为 4 秒，右灯呼吸周期为 6 秒。']};
 assert.equal(lightPresentation(two.interaction.outputs[0],two).cycleSeconds,4);assert.equal(lightPresentation(two.interaction.outputs[0],two).color,'blue');
});
test('declared rounded-up minutes apply to the device display while unspecified timers retain mm:ss',()=>{
 assert.equal(displayValue(screen,real,1500),'25');assert.equal(displayValue(screen,real,1800),'30');
 assert.equal(displayValue(screen,real,1499),'25');assert.equal(displayValue(screen,real,0),'0');
 assert.equal(displayValue({label:'时间',partIndex:0},{parts:[{name:'计时屏'}]},1499),'24:59');
 assert.equal(displayValue(screen,{...real,steps:[]},1499),'24:59','unit without an explicit rounding rule retains the clock default');
});

test('real accepted V5 normal share entry shows red 6-second breathing and rounded minutes without API calls',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),api=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 const origin='https://formwork-feedback-test.github.io';page.setDefaultTimeout(15000);
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  if(/\/api\//.test(url.pathname)||route.request().method()!=='GET'){api.push(route.request().url());return route.abort();}
  const filename=path.resolve(root,'.'+url.pathname,...(url.pathname.endsWith('/')?['index.html']:[]));
  const types={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html','.wasm':'application/wasm'};
  try{return route.fulfill({body:await readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(origin+'/?share=reading-timer&version=5');await page.locator('#geometry-state[data-phase=ready][data-approximate=false]').waitFor();
 const display=page.locator('[data-ci-output="'+screen.id+'"]'),state=page.locator('[data-ci-state]'),light=page.locator('[data-ci-output="'+lamp.id+'"]');
 assert.equal(await display.innerText(),'25');assert.match(await state.innerText(),/25:00/);
 const turn=real.interaction.controls.find(control=>control.kind==='turn'),press=real.interaction.controls.find(control=>control.kind==='press');
 await page.locator('[data-ci-step="'+turn.id+'"][data-ci-delta="1"]').click();assert.equal(await display.innerText(),'30');assert.match(await state.innerText(),/30:00/);
 await page.locator('[data-ci-step="'+turn.id+'"][data-ci-delta="-1"]').click();
 await page.locator('[data-ci-press="'+press.id+'"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-ci-state]').textContent.includes('24:59'));assert.equal(await display.innerText(),'25');
 await page.locator('[data-ci-finish]').click();assert.equal(await display.innerText(),'0');assert.match(await state.innerText(),/00:00/);
 const css=await light.evaluate(element=>{const style=getComputedStyle(element);return {rgb:style.getPropertyValue('--ci-light-rgb').trim(),cycle:style.getPropertyValue('--ci-breathe-cycle').trim(),duration:style.animationDuration,direction:style.animationDirection,mode:element.dataset.mode,frames:element.getAnimations()[0].effect.getKeyframes().map(frame=>({offset:frame.offset,opacity:frame.opacity}))};});
 assert.equal(css.rgb,'240 68 68');assert.equal(css.cycle,'6s');assert.equal(css.duration,'6s');assert.equal(css.direction,'normal');assert.equal(css.mode,'breathe');
 assert.deepEqual(css.frames,[{offset:0,opacity:'0.4'},{offset:.5,opacity:'1'},{offset:1,opacity:'0.4'}]);
 assert.deepEqual(api,[]);assert.deepEqual(errors,[]);
});
