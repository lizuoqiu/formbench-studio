// Browser-level generation/provenance contracts. No model network, accounts or purchase calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};
const fixture={name:'触摸盒',summary:'触摸顶面启动提醒。',steps:['接线'],parts:[{name:'控制板',spec:'接口板',model:'B1',qty:1,sizeMm:[30,20,9],role:'internal',dimensionSource:'estimated'}]};
test('prompt, immutable regeneration, truthful backend model receipts, old projects and CAD state',async()=>{
 const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local.test').pathname.slice(1)||'index.html';const full=path.resolve(root,name);if(!full.startsWith(root))throw Error();const body=await readFile(full);res.writeHead(200,{'Content-Type':types[path.extname(full)]||'application/octet-stream'});res.end(body)}catch{res.writeHead(404);res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 let b;
 try{
  b=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const p=await b.newPage({reducedMotion:'reduce'});const errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);
  let release,received,expected;const gate=()=>{received=new Promise(r=>expected=r);return new Promise(r=>release=r)};
  let wait=gate(),failure=false,answer={...fixture,generation:{provider:'local-codex',modelId:'model-config',modelSource:'configured'}};
  await p.route('**/api/**',async r=>{const key=new URL(r.request().url()).pathname;if(key==='/api/design'){expected();await wait;return failure?r.fulfill({status:502,json:{error:'设计服务暂时不可用。'}}):r.fulfill({json:{design:answer}})}return r.fulfill({json:key==='/api/capabilities'?{ai:true,aiModel:'model-config',aiProvider:'local-codex'}:key==='/api/catalog'?{candidates:[]}:{configured:false,authenticated:false}})});
  await p.goto(url);await p.locator('#selected-model:not([hidden])').waitFor();assert.match(await p.locator('#selected-model').innerText(),/请求模型：model-config/);await p.locator('#wish').fill('能提醒我休息的桌上装置');await p.locator('#generate').click();await received;assert(await p.locator('#entry-progress').isVisible());assert.equal(await p.locator('#entry-progress').getAttribute('data-phase'),'request');assert.equal(await p.locator('#generate').isDisabled(),true);release();
  await p.locator('#project:not([hidden])').waitFor();
  assert.match(await p.locator('.model-stamp').innerText(),/本机 Codex.*请求指定模型：model-config.*未披露/);

  await p.locator('#revise-design').click();assert.equal(await p.locator('#wish').inputValue(),'能提醒我休息的桌上装置');
  wait=gate();answer={...fixture,name:'第二个版本',generation:{provider:'openai-api',modelId:'model-returned',modelSource:'response'}};
  await p.locator('#generate').click();await received;release();await p.getByRole('heading',{name:'第二个版本',exact:true}).first().waitFor();assert.match(await p.locator('.model-stamp').innerText(),/响应模型：model-returned/);await p.waitForFunction(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')||'[]').length===2);
  await p.evaluate(()=>{const a=JSON.parse(localStorage.getItem('formbench.consumer.guest.v1'));delete a[0].design.generation;a[0].design.parts[0].sizeMm=null;localStorage.setItem('formbench.consumer.guest.v1',JSON.stringify(a))});
  await p.locator('#back').click();await p.getByRole('button',{name:'我的项目'}).click();await p.locator('dialog button').filter({hasText:'第二个版本'}).click();assert.match(await p.locator('.model-stamp').innerText(),/未记录/);await p.locator('[data-cc-status]').getByText(/尺寸|需要/).waitFor();await p.locator('#revise-design').click();
  wait=gate();failure=true;await p.locator('#generate').click();await received;release();await p.locator('#entry-notice').getByText('设计服务暂时不可用。').waitFor();assert(await p.locator('#entry-progress').isHidden());assert(!(await p.locator('#generate').isDisabled()));
  await p.getByRole('button',{name:'状态灯示例'}).click();await p.locator('#geometry-state[data-phase=ready]').waitFor();
  await p.locator('[data-cc-mode=inside]').click();await p.waitForFunction(()=>document.querySelector('#geometry-state')?.textContent.includes('内部'));assert.equal(await p.locator('[data-cc-mode=inside]').getAttribute('aria-pressed'),'true');
  await p.getByRole('button',{name:'我的项目'}).click();await p.locator('dialog button').filter({hasText:'第二个版本'}).click();await p.locator('#geometry-state[data-phase=error]').waitFor();assert.deepEqual(errors,[]);
 }finally{await b?.close();await new Promise(r=>server.close(r))}
});
