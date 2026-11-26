// A rejected design is a recoverable in-memory draft, never a published version.
// Exercise normal upload, discussion, revision and save paths with local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url)),origin='https://formwork-repair.test',guestKey='formbench.consumer.guest.v1';
const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.wasm':'application/wasm'};
const approved={name:'通过评审的按钮盒',summary:'按下按钮点亮灯。',steps:['检查按钮。'],parts:[{name:'按钮',qty:1,spec:'轻触',model:'T1',sizeMm:[8,8,4],role:'panel'}]};
const candidate=(number,issue)=>({design:{...approved,name:'未通过草稿'+number,interaction:{rejected:number}},issues:[issue]});
const first=candidate(1,'旋钮的活动轴与固定轴套没有对齐。');
const second=candidate(2,'显示屏与外壳开孔位置不一致。');
const revisionCandidate=candidate(3,'按钮行程会碰到内部控制板。');
const saved=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),guestKey);

test('review failure can repair the same new draft and revision, retain photos, and never retry or save silently',async t=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({reducedMotion:'reduce'});page.setDefaultTimeout(10000);
 const requests=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
 let newGenerations=0,revisionGenerations=0,releaseRepair;
 const repairGate=new Promise(resolve=>releaseRepair=resolve);
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  if(url.pathname==='/api/design'){
   const body=route.request().postDataJSON();requests.push(body);
   if(body.action==='discuss')return route.fulfill({json:{decision:'ready'}});
   if(body.baseDesign){
    revisionGenerations++;
    if(revisionGenerations===1)return route.fulfill({status:502,json:{error:'新版尚未通过评审。',repairCandidate:revisionCandidate}});
    return route.fulfill({json:{design:{...approved,name:'修订后通过的第二版'}}});
   }
   newGenerations++;
   if(newGenerations===2)await repairGate;
   if(newGenerations<=2)return route.fulfill({status:502,json:{error:'方案尚未通过评审。',repairCandidate:newGenerations===1?first:second}});
   return route.fulfill({json:{design:approved}});
  }
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:url.pathname==='/api/capabilities'?{ai:true,aiModel:'test-model',aiProvider:'openai-api',designImages:true}:url.pathname==='/api/catalog'?{candidates:[]}:{configured:false,authenticated:false}});
  const filename=path.resolve(root,'.'+url.pathname,...(url.pathname.endsWith('/')?['index.html']:[]));
  try{return route.fulfill({body:await readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(origin);await page.locator('#selected-model:not([hidden])').waitFor();
 const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=24;canvas.getContext('2d').fillRect(0,0,24,24);return canvas.toDataURL('image/png').split(',')[1]});
 await page.locator('#new-design-images').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
 await page.locator('.photo-thumbs img').waitFor();
 const prompt='按照片做一个带按钮的桌面盒，保持它的外形';
 await page.locator('#wish').fill(prompt);await page.locator('#generate').click();
 const repair=page.getByRole('button',{name:'按评审意见修订',exact:true});await repair.waitFor();
 assert.equal(await page.getByText('活动轴与固定轴套没有对齐',{exact:false}).first().isVisible(),false);
 await page.getByText('查看检查结果',{exact:true}).click();
 assert.match(await page.locator('#entry-conversation').innerText(),/活动轴与固定轴套没有对齐/);
 assert.equal(await page.locator('#project').isVisible(),false);assert.equal((await saved(page)).length,0);
 assert.equal(requests.length,2);assert.equal(newGenerations,1);assert.equal(await page.locator('#wish').inputValue(),prompt);
 const original=requests.at(-1);assert.equal(original.images.length,1);assert.equal(original.repairCandidate,undefined);
 // Even two deliveries of the same button event only start one repair request.
 const repairing=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/design');
 await repair.evaluate(button=>{button.click();button.click()});await repairing;
 assert.equal(await repair.count(),0);assert.equal(await page.locator('#generate').isDisabled(),true);
 assert.equal(newGenerations,2);releaseRepair();await repair.waitFor();
 assert.equal(newGenerations,2);assert.equal((await saved(page)).length,0);
 assert.equal(await page.getByText('开孔位置不一致',{exact:false}).first().isVisible(),false);
 await page.getByText('查看检查结果',{exact:true}).click();
 assert.match(await page.locator('#entry-conversation').innerText(),/开孔位置不一致/);
 assert.doesNotMatch(await page.locator('#entry-conversation').innerText(),/活动轴与固定轴套没有对齐/);
 assert.deepEqual(requests.at(-1),{...original,repairCandidate:first});
 await repair.click();await page.getByRole('heading',{name:approved.name,exact:true}).first().waitFor();
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'[]').length===1,guestKey);
 assert.deepEqual(requests.at(-1),{...original,repairCandidate:second});
 assert.equal(await page.locator('#version-label').innerText(),'第 1 版');
 assert.doesNotMatch(JSON.stringify(await saved(page)),/未通过草稿|repairCandidate|rejected/);

 const feedback='把按钮行程加长一点，保持照片中的外形';
 await page.locator('#revision-design-images').locator('xpath=ancestor::fieldset').locator('img').waitFor();
 await page.locator('#revision-prompt').fill(feedback);await page.locator('#revise-design').click();await repair.waitFor();
 const originalRevision=requests.at(-1);
 assert.equal(originalRevision.baseDesign.name,approved.name);assert.equal(originalRevision.prompt,prompt);
 assert.equal(originalRevision.conversation.at(-1).text,feedback);assert.deepEqual(originalRevision.images,original.images);
 assert.equal((await saved(page)).length,1);assert.equal(await page.locator('#version-label').innerText(),'第 1 版');
 assert.equal(await page.getByText('会碰到内部控制板',{exact:false}).first().isVisible(),false);
 await page.getByText('查看检查结果',{exact:true}).click();
 assert.match(await page.locator('#revision-conversation').innerText(),/会碰到内部控制板/);
 await repair.click();await page.getByRole('heading',{name:'修订后通过的第二版',exact:true}).first().waitFor();
 await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'[]').length===2,guestKey);
 assert.deepEqual(requests.at(-1),{...originalRevision,repairCandidate:revisionCandidate});
 assert.equal(await page.locator('#version-label').innerText(),'第 2 版');
 assert.doesNotMatch(JSON.stringify(await saved(page)),/未通过草稿|repairCandidate|rejected/);
 await page.locator('#previous-version').click();await page.getByRole('heading',{name:approved.name,exact:true}).first().waitFor();
 assert.equal(await page.locator('#version-label').innerText(),'第 1 版');assert.deepEqual(errors,[]);
});
