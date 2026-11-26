import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {makeDocumentedProxy} from '../part-geometry.js';
import {readDesignJob} from '../consumer-jobs.js';

test('normal generation resumes one background job after reload and shows each imported part source',async t=>{
 const browser=await chromium.launch({channel:'chrome'});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage();
 const origin='https://formbench-job.test',id='01234567-89ab-cdef-0123-456789abcdef',root=new URL('../',import.meta.url);
 const mesh=makeDocumentedProxy({shape:'box',sizeMm:[10,20,30]});
 const model={id,sourceModel:'Example M1',sourceType:'manufacturer',sourceUrl:'https://vendor.example/m1.stl',sizeMm:[10,20,30],format:'stl'};
 const part={name:'控制模块',model:'Example M1',qty:1,spec:'assembled',sizeMm:[10,20,30],role:'internal',importedModel:model,
   hardwareReference:{kind:'specified',items:[{name:'Example M1',label:'商品页',url:'https://vendor.example/m1'}],note:'已读取尺寸',searchTerms:'Example M1'}};
 const owned={name:'自备终端',model:'Existing USB host',kind:'provided',spec:'USB host',qty:1,sizeMm:[68,145,8],role:'external'};
 const design={name:'恢复后的项目',summary:'测试后台任务恢复',steps:['检查配合'],parts:[part,owned],generation:{provider:'openai-api',modelId:'fixture'}};
 let creates=0,ready=false,rejected=false,billing=false,paused=false,diagnosis=false,polls=0,failures=2;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.route(origin+'/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/capabilities')return route.fulfill({json:{ai:true,aiModel:'fixture',aiProvider:'openai-api',designJobs:true}});
   if(url.pathname==='/api/design')return route.fulfill({json:{decision:'ready'}});
   if(url.pathname==='/api/design-jobs'){creates++;return route.fulfill({status:202,json:{id,status:'running',progress:{stage:'sourcing',message:'正在核对控制模块'}}});}
   if(url.pathname==='/api/design-jobs/'+id&&diagnosis){
     return route.fulfill({json:{id,status:'paused',actionRequired:'workflow-diagnosis',error:'需要复核安装配合。',
       rounds:[{attempt:7,issues:[],issueDelta:{decision:'diagnose',opened:[],persisted:['ISSUE-001'],closed:['ISSUE-002'],reopened:[]}}],
       issueLedger:[{id:'ISSUE-001',firstSeen:5,evidence:'孔位偏差 2 mm',acceptance:'两孔同轴'},
         {id:'ISSUE-002',firstSeen:4,evidence:'原端点悬空',acceptance:'端点位于焊盘',closureEvidence:'第 7 轮端子完整复核通过'}]}});
   }
   if(url.pathname==='/api/design-jobs/'+id&&paused){polls++;return route.fulfill({json:{id,status:'paused',error:'第 6 轮检查已完成，按要求暂停后续修订。',rounds:[{attempt:6,issues:['配合待修订']}]}});}
   if(url.pathname==='/api/design-jobs/'+id&&billing)return route.fulfill({json:{id,status:'failed',actionRequired:'api-billing',error:'OpenAI API 额度不足，已有设计进度已保存。',repairCandidate:{design,issues:['配合待修订']}}});
   if(url.pathname==='/api/design-jobs/'+id){polls++;if(failures===2){failures--;return route.abort('failed');}if(failures===1){failures--;return route.fulfill({status:503,json:{error:'temporary restart'}});}return route.fulfill({json:rejected?{id,status:'needs-revision',repairCandidate:{design,issues:['配合待修订']},rounds:[{attempt:1,issues:['配合待修订']}]}:ready?{id,status:'complete',design}:{id,status:'running',progress:{stage:'importing',message:'正在导入控制模块 CAD'}}});}
   if(url.pathname==='/api/model-assets/'+id+'/mesh.json')return route.fulfill({json:mesh});
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{candidates:[],configured:false,authenticated:false}});
   const path=url.pathname==='/'?'index.html':url.pathname.slice(1);
   try{return route.fulfill({body:await readFile(new URL(path,root)),contentType:({js:'text/javascript',json:'application/json',html:'text/html',css:'text/css',wasm:'application/wasm'})[path.split('.').pop()]||'application/octet-stream'});}
   catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(origin);await page.locator('#selected-model:not([hidden])').waitFor();
 await page.locator('#wish').fill('从头生成一个项目');await page.locator('#generate').click();
 await page.getByText('正在重新连接',{exact:true}).waitFor();
 await page.getByText('正在载入零件外形',{exact:true}).waitFor();
 await page.reload();await page.getByText('正在载入零件外形',{exact:true}).waitFor();
 ready=true;await page.locator('#project').waitFor({state:'visible'});
 await page.locator('[data-cc-part-row="0"] [data-cc-source-link]').waitFor({state:'attached'});
 const row=page.locator('[data-cc-part-row="0"]');
 assert.match(await row.innerText(),/Example M1/);assert.match(await row.innerText(),/原厂 CAD/);
 assert.equal(await page.locator('[data-i="1"] .include').isChecked(),false);
 assert.match(await page.locator('[data-i="1"] .tag').innerText(),/用户自备/);
 assert.equal(creates,1);assert.ok(polls>=2);assert.deepEqual(errors,[]);
 await page.evaluate(()=>localStorage.clear());await page.goto(origin+'/?job='+id);
 await page.locator('#project').waitFor({state:'visible'});
 await page.locator('[data-cc-part-row="0"] [data-cc-source-link]').waitFor({state:'attached'});
 assert.match(await page.locator('#project h1').innerText(),/恢复后的项目/);
 assert.equal(creates,1);assert.deepEqual(errors,[]);
 rejected=true;design.cadPlan={version:1,bodies:[{name:'module',role:'reference',partIndex:0,positionMm:[0,0,0],features:[{op:'add',shape:'box',sizeMm:[10,20,30],centerMm:[0,0,0]}]}],motions:[],joints:[]};
 design.interaction={version:1};
 await page.goto(origin);await page.locator('#selected-model:not([hidden])').waitFor();
 await page.locator('#wish').fill('查看未通过评审的草稿');await page.locator('#generate').click();
 await page.locator('#review-draft').waitFor();
 assert.equal(await page.locator('#review-draft').getAttribute('href'),'./design-review.html?job='+id);
 failures=2;
 await page.locator('#review-draft').click();
 await page.locator('#review-label').filter({hasText:'正在重新连接'}).waitFor();
 await page.locator('#review-grid').waitFor({state:'visible'});
 await page.locator('[data-cc-part-row="0"] [data-cc-source-link]').waitFor({state:'attached'});
 assert.match(await page.locator('#review-label').innerText(),/仍需修订/);
 assert.match(await page.locator('#review-history').innerText(),/配合待修订/);
 assert.match(await page.locator('#review-behavior').innerText(),/交互定义未通过校验/);
 assert.equal(await page.locator('#review-open').isVisible(),false);assert.equal(creates,2);assert.deepEqual(errors,[]);
 billing=true;await page.reload();await page.getByText('服务额度不足，进度已保存',{exact:true}).waitFor();
 assert.match(await page.locator('#review-progress').innerText(),/额度不足/);
 assert.equal(await page.locator('#review-grid').isVisible(),false);
 assert.equal(await page.locator('#review-open').isVisible(),false);
 assert.equal(await page.locator('#review-retry').innerText(),'恢复额度后继续');
 assert.equal(creates,2);assert.deepEqual(errors,[]);
 paused=true;await page.reload();await page.getByText('本轮检查已完成，已暂停',{exact:true}).waitFor();
 assert.equal(await page.locator('#review-grid').isVisible(),false);assert.equal(await page.locator('#review-open').isVisible(),false);
 assert.equal(await page.locator('#review-retry').innerText(),'继续修订');assert.match(await page.locator('#review-history').innerText(),/第 6 轮.*待修订评语 1 条/);
 const stoppedPolls=polls;await page.waitForTimeout(2000);assert.equal(polls,stoppedPolls,'a paused page must not keep polling or resume work');
 diagnosis=true;await page.reload();
 await page.getByText('修订已暂停，等待处理诊断结果',{exact:true}).waitFor();
 await page.getByText('仍待修订 ISSUE-001',{exact:true}).waitFor();
 await page.getByText('已验证关闭 ISSUE-002',{exact:true}).waitFor();
 await page.getByText('ISSUE-002 · 核查依据',{exact:true}).click();
 assert.match(await page.locator('#review-history').innerText(),/第 7 轮端子完整复核通过/);
 assert.equal(creates,2);assert.deepEqual(errors,[]);
});

test('job read recovery stops for a missing job or an aborted connection',async()=>{
 let calls=0;
 await assert.rejects(()=>readDesignJob('missing',{call:async()=>{calls++;throw Object.assign(Error('job missing'),{status:404});}}),/job missing/);
 assert.equal(calls,1);
 const controller=new AbortController();calls=0;
 await assert.rejects(()=>readDesignJob('running',{signal:controller.signal,onReconnect:()=>controller.abort(),call:async()=>{calls++;throw TypeError('network disconnected');}}),{name:'AbortError'});
 assert.equal(calls,1);
});
