import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
import {projectWireRoute} from '../consumer-wiring.js';
import {buildAssemblyWiring} from '../assembly-wires.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const real=JSON.parse(await readFile(path.join(root,'samples/shared/reading-timer/v5.json'),'utf8')).design;
const paint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
test('wire projection removes the segments occluded by an opaque part',()=>{
 const camera={yaw:Math.PI,pitch:Math.PI/2,target:[0,0,0],center:[100,100],scale:1};
 const result=projectWireRoute([[-30,0,0],[30,0,0]],camera,(x)=>x>=90&&x<=110?8:-Infinity);
 assert.equal((result.d.match(/M/g)||[]).length,2);
 assert.ok(result.samples.filter(({p})=>p[0]>=90&&p[0]<=110).every(sample=>!sample.visible));
 assert.ok(result.samples.some(sample=>sample.visible));
});

test('normal shared V5 interior exposes selectable reference wires and model names on desktop and mobile',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const model=buildAssemblyWiring(real),signal=model.routes.find(route=>route.from.pin==='D4'&&route.to.pin==='SDA');assert.ok(signal);
 for(const width of [1440,390])await t.test('viewport '+width,async t=>{
  const origin='https://formwork-wiring-test.github.io',page=await browser.newPage({viewport:{width,height:980},deviceScaleFactor:width===390?2:1,reducedMotion:'reduce'});t.after(()=>page.close());page.setDefaultTimeout(15000);
  const api=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(/\/api\//.test(url.pathname)||route.request().method()!=='GET'){api.push(route.request().url());return route.abort();}
   const filename=path.resolve(root,'.'+url.pathname,...(url.pathname.endsWith('/')?['index.html']:[])),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
   try{return route.fulfill({body:await readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(origin+'/?share=reading-timer&version=5');await page.locator('#geometry-state[data-phase=ready][data-approximate=false]').waitFor();
  assert.equal(await page.locator('.cc-wires').isVisible(),false,'assembled exterior must not show wires through the enclosure');
  await page.locator('[data-cc-mode=inside]').click();await paint(page);
  const toggle=page.locator('[data-cc-wiring-toggle]'),choice=page.locator('[data-cc-wire-choice]'),detail=page.locator('[data-cc-wire-detail]');
  assert.ok(await toggle.isChecked());assert.ok(await page.locator('.cc-wires').isVisible());
  assert.equal(await page.locator('[data-cc-wire-index]').count(),12);assert.equal(await choice.locator('option').count(),15);
  const drawn=await page.locator('.cc-wire-path').evaluateAll(paths=>paths.filter(p=>(p.getAttribute('d')||'').includes('L')).length);assert.ok(drawn>=6,'several real routes have visible, depth-tested segments');
  assert.equal(await page.locator('.ci-overlay').isVisible(),false,'functional output labels do not obscure PCB pin inspection');
  assert.match(await page.locator('[data-cc-focus-part="4"]').innerText(),/XIAO ESP32S3/);
  await choice.selectOption(String(signal.connectionIndex));await paint(page);
  assert.match(await detail.innerText(),/D4 → SDA/);assert.match(await detail.innerText(),/模型端点/);assert.match(await detail.innerText(),/JP2/);
  const route=page.locator('[data-cc-wire-index="'+signal.connectionIndex+'"]');assert.equal(await route.getAttribute('aria-pressed'),'true');
  const hit=await route.locator('.cc-wire-hit').evaluate(node=>{
   const length=node.getTotalLength();if(!length)throw Error('selected route has no visible path');
   const p=node.getPointAtLength(length*.45),svg=node.ownerSVGElement,pt=svg.createSVGPoint();pt.x=p.x;pt.y=p.y;const screen=pt.matrixTransform(svg.getScreenCTM());return {x:screen.x,y:screen.y};
  });
  await choice.selectOption('');await paint(page);await page.mouse.click(hit.x,hit.y);await paint(page);
  assert.equal(await choice.inputValue(),String(signal.connectionIndex),'nearest visible centerline wins over overlapping touch target areas');
  await choice.selectOption(String(signal.connectionIndex));
  await toggle.uncheck();await paint(page);assert.equal(await page.locator('.cc-wires').isVisible(),false);
  await toggle.check();await paint(page);assert.equal(await page.locator('.cc-wires').isVisible(),true);
  await page.locator('[data-cc-part="'+signal.to.partIndex+'"]').uncheck();await paint(page);assert.equal(await route.isVisible(),false,'hiding an endpoint hides its connected path');
  await page.locator('#cad-panel').evaluate((container,index)=>container.dispatchEvent(new CustomEvent('focus-wiring',{detail:{connectionIndex:index}})),signal.connectionIndex);await paint(page);
  assert.equal(await choice.inputValue(),String(signal.connectionIndex));assert.ok(await page.locator('[data-cc-part="'+signal.to.partIndex+'"]').isChecked());
  await detail.locator('[data-cc-wire-focus="4"]').click();await paint(page);
  assert.equal(await page.locator('[data-cc-focus-part="4"]').getAttribute('aria-pressed'),'true');assert.equal(await route.isVisible(),true);
  await page.locator('[data-cc-reset-focus]').click();await paint(page);
  if(process.env.WIRING_SCREENSHOTS){await mkdir(process.env.WIRING_SCREENSHOTS,{recursive:true});await page.locator('.cc-stage').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.WIRING_SCREENSHOTS,'inside-'+width+'.png'),fullPage:true});}
  await page.locator('[data-cc-mode=closed]').click();await paint(page);assert.equal(await page.locator('.cc-wires').isVisible(),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(api,[]);assert.deepEqual(errors,[]);
 });
});
