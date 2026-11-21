// Viewer-only fixture. No model service, accounts or shopping requests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';
import {compileCadPlan} from '../cad-plan-compiler.js';

const root=new URL('../',import.meta.url);
const origin='http://127.0.0.1:4199';
const hardware=(name,role,sizeMm)=>({name,role,sizeMm,qty:1,spec:name,dimensionSource:'specified'});
const body=(name,partIndex,role,positionMm,shape,sizeMm)=>({
 name,partIndex,role,positionMm,features:[{op:'add',shape,sizeMm,centerMm:[0,0,0]}]
});
const design={
 name:'内部视图试件',
 parts:[
  hardware('固定壳体','enclosure',[60,48,18]),hardware('圆形控制板','internal',[22,22,.5]),
  {...hardware('升降推杆','internal',[6,6,22]),geometryReference:{kind:'datasheet-approximation',detail:'测试件轴径资料'}},hardware('外接 USB 线','external',[120,5,3])
 ],
 cadPlan:{version:1,bodies:[
  body('机壳',0,'printed',[0,0,10],'box',[60,48,18]),
  body('圆板',1,'reference',[-12,-8,7],'cylinder',[22,22,.5]),
  body('推杆',2,'reference',[13,5,16],'cylinder',[6,6,22])
 ],motions:[{type:'prismatic',name:'升降行程',axis:[0,0,1],travelMm:9,movingBodyIndices:[2],actuatorPartIndex:2,guidePartIndex:0,controllerPartIndex:1}]}
};
const rendered=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));

// Isolate the screen pixels of one actual body by toggling only its visibility.
// This also catches camera reframing on hide and works with any material palette.
async function pixelBoundsOfPart(page,index){
 const checkbox=page.locator('[data-cc-part="'+index+'"]');
 await rendered(page);
 await page.evaluate(()=>{
  const c=document.querySelector('#viewer canvas');
  window.frameBeforeHiding=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
 });
 await checkbox.uncheck();await rendered(page);
 const bounds=await page.evaluate(()=>{
  const c=document.querySelector('#viewer canvas'),first=window.frameBeforeHiding;
  const second=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let left=c.width,right=-1,top=c.height,bottom=-1,count=0;
  for(let i=0;i<second.length;i+=4){
   if(first[i]===second[i]&&first[i+1]===second[i+1]&&first[i+2]===second[i+2]&&first[i+3]===second[i+3])continue;
   const x=i/4%c.width,y=Math.floor(i/4/c.width);
   left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
  }
  delete window.frameBeforeHiding;
  return {left,right,top,bottom,count,width:right-left+1,height:bottom-top+1};
 });
 await checkbox.check();await rendered(page);
 return bounds;
}

test('inside inspection focuses real parts without changing visibility and preserves axis motion',async t=>{
 const solid=await compileCadPlan(design.cadPlan);
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 t.after(()=>browser.close());
 for(const width of [980,390])await t.test('viewport '+width,async t=>{
  const page=await browser.newPage({viewport:{width,height:790},reducedMotion:'reduce'});
  t.after(()=>page.close());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(4000);
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!==origin)return route.abort();
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/consumer-viewer.css"><main id="viewer"></main><aside id="parts"></aside>'});
   if(u.pathname==='/api/forge/plan')return route.fulfill({json:solid});
   if(/\.(js|css)$/.test(u.pathname))return route.fulfill({contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('.'+u.pathname,root))});
   return route.fulfill({status:404,body:''});
  });
  await page.goto(origin);
  await page.evaluate(async design=>{
   const {mountConsumerCad}=await import('/consumer-cad.js');
   mountConsumerCad(document.querySelector('#viewer'),design,{initialMode:'inside',partsPanel:document.querySelector('#parts'),onStatus:status=>window.geometryStatus=status});
  },design);
  await page.waitForFunction(()=>window.geometryStatus?.exact&&window.geometryStatus.phase==='ready');
  assert.equal(await page.locator('[data-cc-mode=inside]').getAttribute('aria-pressed'),'true');
  const boardBounds=await pixelBoundsOfPart(page,1);
  assert.ok(boardBounds.count>200,'control board is visibly rendered inside the shell');
  assert.ok(boardBounds.height/boardBounds.width>.6,'flat circle shows a high-angle initial camera');

  const side=page.locator('#parts'),focus=side.locator('[data-cc-focus-part="1"]'),reset=page.locator('[data-cc-reset-focus]');
  const visibility=()=>side.locator('[data-cc-part]').evaluateAll(inputs=>inputs.map(i=>[i.dataset.ccPart,i.checked]));
  assert.match(await side.locator('[data-cc-focus-part="0"]').innerText(),/定制结构/);
  assert.match(await focus.innerText(),/尺寸简模/);
  assert.match(await side.locator('[data-cc-focus-part="2"]').innerText(),/资料简模/);
  const initialChecks=await visibility(),canvas=page.locator('#viewer canvas');
  const image=()=>canvas.evaluate(c=>c.toDataURL());
  const assembled=await image();
  await focus.click();await rendered(page);
  assert.equal(await focus.getAttribute('aria-pressed'),'true');
  const focused=await image();
  assert.notEqual(focused,assembled,'focus changes the model rendering');
  assert.deepEqual(await visibility(),initialChecks,'focus is independent of part visibility');
  await reset.click();await rendered(page);
  assert.equal(await focus.getAttribute('aria-pressed'),'false');
  assert.notEqual(await image(),focused,'reset restores an overall view');
  assert.deepEqual(await visibility(),initialChecks);
  await focus.click();
  await side.locator('[data-cc-part="1"]').uncheck();await rendered(page);
  assert.equal(await focus.getAttribute('aria-pressed'),'false');
  assert.equal(await side.locator('[data-cc-part="1"]').isChecked(),false);

  const only=side.locator('[data-cc-bom-only]'),cable=only.getByText('外接 USB 线',{exact:true});
  if(!await cable.isVisible())await only.locator('summary').click();
  assert.ok(await cable.isVisible());
  assert.equal(await side.locator('[data-cc-part="3"]').count(),0);
  await page.locator('[data-cc-mode=closed]').click();
  const before=await pixelBoundsOfPart(page,2);
  const stroke=page.locator('[data-cc-travel="0"]');await stroke.press('End');
  const after=await pixelBoundsOfPart(page,2);
  assert.ok(before.count>30&&after.count>before.count,'exposed length of the shaft increases');
  assert.ok(after.top<before.top-2,'+Z extension visibly projects upwards');
  assert.ok(Math.abs(after.left-before.left)<=2&&Math.abs(after.right-before.right)<=2,'the shaft stays on its vertical world axis');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
 });
});
