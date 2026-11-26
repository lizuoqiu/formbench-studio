import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);
const origin='https://formbench-parts-test.github.io';
const types={js:'application/javascript',css:'text/css',json:'application/json',html:'text/html',wasm:'application/wasm'};

test('shared hardware references connect each V5 model row to its own supplier or fabrication file',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome'});
 t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:980},reducedMotion:'reduce'});
 const errors=[],api=[];
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin)return route.fulfill({contentType:'text/html',body:'<title>Product reference</title>'});
  if(url.pathname.startsWith('/api/')||request.method()!=='GET'){api.push(url.pathname);return route.abort();}
  const pathname=url.pathname==='/'?'index.html':url.pathname.slice(1);
  try{return route.fulfill({contentType:types[pathname.split('.').pop()]||'application/octet-stream',
    body:await readFile(new URL(pathname,root))});}
  catch{return route.fulfill({status:404,body:''});}
 });
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
 const go=async version=>{
  await page.goto(origin+'/?share=reading-timer&version='+version+'&view=inside');
  await page.locator('#geometry-state[data-phase=ready][data-approximate=false]').waitFor();
 };
 await go(5);
 const side=page.locator('#model-components'),row=index=>side.locator('[data-cc-part-row="'+index+'"]');
 const sideDisclosure=index=>row(index).locator('details[data-cc-hardware-kind]');
 async function openReference(index){
  const outside=row(index).locator('xpath=ancestor::details[@data-cc-bom-only]');
  if(await outside.count()&&!await outside.evaluate(el=>el.open))await outside.locator(':scope > summary').click();
  const details=sideDisclosure(index);
  if(!await details.evaluate(el=>el.open))await details.locator(':scope > summary').click();
  return details;
 }
 const all=await side.locator('[data-cc-part-row]').evaluateAll(rows=>rows.map(el=>Number(el.dataset.ccPartRow)));
 assert.deepEqual(all.sort((a,b)=>a-b),Array.from({length:13},(_,i)=>i),'each V5 BOM item has one model-list row');
 assert.equal(await side.locator('[data-cc-hardware-kind]').count(),13);
 for(const index of [0,1])assert.equal(await sideDisclosure(index).getAttribute('data-cc-hardware-kind'),'custom');
 assert.equal(await sideDisclosure(3).getAttribute('data-cc-hardware-kind'),'candidate');
 assert.equal(await sideDisclosure(4).getAttribute('data-cc-hardware-kind'),'specified');
 const board=await openReference(4);
 assert.match(await row(4).innerText(),/XIAO ESP32S3/i);
 const link=board.locator('a[data-cc-source-link]').first(),href=await link.getAttribute('href');
 assert.equal(new URL(href).protocol,'https:');
 assert.match(new URL(href).hostname,/seeedstudio\.com$/i);
 const focus=row(4).locator('[data-cc-focus-part]'),checkbox=row(4).locator('[data-cc-part]');
 const focusBefore=await focus.getAttribute('aria-pressed'),checked=await checkbox.isChecked();
 const [product]=await Promise.all([context.waitForEvent('page'),link.click()]);await product.waitForLoadState();
 assert.equal(product.url(),href);await product.close();
 assert.equal(await focus.getAttribute('aria-pressed'),focusBefore);
 assert.equal(await checkbox.isChecked(),checked);
 for(const index of [7,8,9,11,12]){
  const reference=await openReference(index);
  assert.ok(await reference.locator('a[data-cc-source-link]').count()>0,'supplier access for accessory '+index);
 }
 const shell=await openReference(0);
 const [download]=await Promise.all([page.waitForEvent('download'),shell.locator('[data-cc-source-stl="0"]').click()]);
 const bytes=await readFile(await download.path());
 assert.match(download.suggestedFilename(),/\.stl$/i);
 const saved=JSON.parse(await readFile(new URL('samples/shared/reading-timer/v5-cad.json',root),'utf8'));
 assert.equal(bytes.readUInt32LE(80),Buffer.from(saved.bodies[0].stlBase64,'base64').readUInt32LE(80),'front-shell download uses its own mesh');

 await page.setViewportSize({width:390,height:840});
 await page.locator('#mobile-components #model-components').waitFor({state:'attached'});
 assert.equal(await page.locator('#mobile-components #model-components').count(),1);
 assert.ok(await row(4).isVisible());
 await page.getByRole('button',{name:/零件清单/}).click();
 const card=index=>page.locator('.part[data-i="'+index+'"]');
 assert.equal(await page.locator('.part [data-hardware-reference]').count(),13);
 assert.match(await card(4).locator('[data-hardware-reference]').innerText(),/XIAO ESP32S3/i);
 assert.equal(await card(4).locator('[data-hardware-reference] a').first().getAttribute('href'),href);
 assert.equal(await card(3).locator('[data-hardware-reference]').getAttribute('data-hardware-reference'),'candidate');
 assert.ok(new URL(await card(3).getByRole('link',{name:/淘宝搜索/}).getAttribute('href')).hostname==='s.taobao.com');
 await page.locator('#part-search').fill('CFR-25JB-52-330R');
 assert.equal(await page.locator('.part:visible').count(),1);assert.ok(await card(6).isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await go(4);
 assert.equal(await side.locator('[data-cc-hardware-kind]').count(),0,'V5-only source choices are not assigned to V4');
 assert.equal(await page.locator('.part [data-hardware-reference]').count(),0);
 const references=JSON.parse(await readFile(new URL('samples/shared/reading-timer/v5-hardware.json',root)));
 await page.route('**/v5-hardware.json',route=>route.fulfill({json:references.slice(0,1)}));
 await go(5);
 await page.getByText('部分实物资料未能加载，可刷新重试。').waitFor();
 assert.equal(await side.locator('[data-cc-hardware-kind]').count(),1,'missing sources do not inherit references from other rows');
 assert.deepEqual(errors,[]);assert.deepEqual(api,[]);
});
