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
async function serveWorkbench(){
 const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local.test').pathname.slice(1)||'index.html';const full=path.resolve(root,name);if(!full.startsWith(root))throw Error();const body=await readFile(full);res.writeHead(200,{'Content-Type':types[path.extname(full)]||'application/octet-stream'});res.end(body)}catch{res.writeHead(404);res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
test('prompt, immutable regeneration, truthful backend model receipts, old projects and CAD state',async()=>{
 const {url,close}=await serveWorkbench();
 let b;
 try{
  b=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const p=await b.newPage({reducedMotion:'reduce'});const errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);
  const prompt='能提醒我休息的桌上装置',question='你更希望怎样收到提醒？';
  let first=true,release,failDiscussion=false;
  const gate=new Promise(resolve=>release=resolve),requests=[];
  await p.route('**/api/**',async route=>{
    const key=new URL(route.request().url()).pathname;
    if(key!=='/api/design'){
      const json=key==='/api/capabilities'?{ai:true,aiModel:'model-config',aiProvider:'local-codex'}:key==='/api/catalog'?{candidates:[]}:{configured:false,authenticated:false};
      return route.fulfill({json});
    }
    const req=route.request().postDataJSON();requests.push(req);
    if(req.action==='discuss'){
      if(failDiscussion)return route.fulfill({status:502,json:{error:'设计服务暂时不可用。'}});
      if(first){first=false;await gate;return route.fulfill({json:{decision:'ask',question,options:['光提醒','振动提醒']}})}
      return route.fulfill({json:{decision:'ready',options:[],question:''}});
    }
    const answer=req.baseDesign?{...fixture,name:'第二个版本',generation:{provider:'openai-api',modelId:'model-returned',modelSource:'response'}}:{...fixture,generation:{provider:'local-codex',modelId:'model-config',modelSource:'configured'}};
    return route.fulfill({json:{design:answer}});
  });
  await p.goto(url);await p.locator('#selected-model:not([hidden])').waitFor();
  assert.match(await p.locator('#selected-model').innerText(),/请求模型：model-config/);
  await p.locator('#wish').fill(prompt);await p.locator('#generate').click();
  assert(await p.locator('#entry-progress').isVisible());assert.equal(await p.locator('#entry-progress').getAttribute('data-phase'),'discuss');assert(await p.locator('#generate').isDisabled());release();
  await p.getByRole('group',{name:question}).waitFor();
  assert.equal(await p.getByRole('button',{name:'直接生成',exact:true}).count(),0);
  assert.ok(await p.getByRole('radio',{name:'由 AI 决定',exact:true}).isVisible());
  assert.deepEqual(requests.map(r=>r.action),['discuss']);
  await p.getByRole('radio',{name:'光提醒',exact:true}).check();
  assert.deepEqual(requests.map(r=>r.action),['discuss']);
  await p.getByRole('button',{name:'提交回答'}).click();
  await p.locator('#project:not([hidden])').waitFor();
  await p.locator('.project-origin > summary').click();
  assert.match(await p.locator('.model-stamp').innerText(),/本机 Codex.*请求指定模型：model-config.*未披露/);
  assert.deepEqual(requests.map(r=>r.action),['discuss','discuss','generate']);
  assert.equal(requests.at(-1).conversation.at(-1).text,'光提醒');
  await p.locator('#revision-prompt').fill('灯光减弱一半');await p.locator('#revise-design').click();
  await p.getByRole('heading',{name:'第二个版本',exact:true}).first().waitFor();
  await p.locator('.project-origin > summary').click();
  assert.match(await p.locator('.model-stamp').innerText(),/响应模型：model-returned/);
  const revision=requests.at(-1);assert.equal(revision.action,'generate');assert.equal(revision.prompt,prompt);
  assert.equal(revision.baseDesign.parts[0].name,'控制板');assert.equal(revision.discussionStart,2);assert.equal(revision.conversation.at(-1).text,'灯光减弱一半');
  await p.waitForFunction(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')||'[]').length===2);
  await p.locator('#previous-version').click();await p.getByRole('heading',{name:'触摸盒',exact:true}).first().waitFor();
  await p.evaluate(()=>{const a=JSON.parse(localStorage.getItem('formbench.consumer.guest.v1'));delete a[0].design.generation;delete a[0].iteration;a[0].design.parts[0].sizeMm=null;localStorage.setItem('formbench.consumer.guest.v1',JSON.stringify(a))});
  await p.locator('#back').click();await p.getByRole('button',{name:'我的项目'}).click();await p.locator('dialog button').filter({hasText:'第二个版本'}).click();
  await p.locator('.project-origin > summary').click();
  assert.match(await p.locator('.model-stamp').innerText(),/未记录/);await p.locator('[data-cc-status]').getByText(/尺寸|需要/).waitFor();
  failDiscussion=true;await p.locator('#revision-prompt').fill('声音轻一点');await p.locator('#revise-design').click();
  await p.getByRole('alert').filter({hasText:'设计服务暂时不可用。'}).waitFor();
  await p.locator('#cancel-discussion').click();assert(!(await p.locator('#revise-design').isDisabled()));
  assert.equal(await p.locator('#revision-prompt').inputValue(),'声音轻一点');await p.locator('#back').click();
  await p.getByRole('button',{name:'状态灯示例'}).click();await p.locator('#geometry-state[data-phase=ready]').waitFor();
  await p.locator('[data-cc-mode=inside]').click();await p.waitForFunction(()=>document.querySelector('#geometry-state')?.textContent.includes('内部'));assert.equal(await p.locator('[data-cc-mode=inside]').getAttribute('aria-pressed'),'true');
  await p.locator('#view-parts').click();
  assert.equal(await p.locator('#view-parts').getAttribute('aria-pressed'),'true');
  const search=p.locator('#part-search'),listed=p.locator('#items .part:visible');
  const allNames=await listed.locator('.part-name h3').allTextContents();
  assert.ok(allNames.includes('绿色 LED')&&allNames.includes('红色 LED'));
  await search.fill('绿色');
  assert.deepEqual(await listed.locator('.part-name h3').allTextContents(),['绿色 LED']);
  await listed.getByRole('checkbox').uncheck();
  await search.fill('');
  assert.deepEqual(await listed.locator('.part-name h3').allTextContents(),allNames);
  const unchecked=listed.filter({has:p.locator('input.include:not(:checked)')});
  assert.deepEqual(await unchecked.locator('.part-name h3').allTextContents(),['绿色 LED']);
  for(const [viewport,usesDetailsTab] of [[{width:1280,height:800},false],[{width:390,height:844},true]]){
    await p.setViewportSize(viewport);
    const detailsTab=p.locator('#view-details');
    if(usesDetailsTab){
      await detailsTab.click();
      assert.equal(await detailsTab.getAttribute('aria-pressed'),'true');
    }else assert.equal(await detailsTab.isVisible(),false);
    const revisionField=p.locator('#revision-prompt'),note=usesDetailsTab?'把绿色灯调暗':'增加红灯亮度';
    assert(await revisionField.isVisible()&&await revisionField.isEditable());
    await revisionField.fill(note);
    assert.equal(await revisionField.inputValue(),note);
    await p.locator('#view-model').click();
    assert(await p.locator('#cad-panel').isVisible());
    assert.equal(await p.locator('[data-cc-mode=inside]').getAttribute('aria-pressed'),'true');
    if(usesDetailsTab)await detailsTab.click();
    assert.equal(await revisionField.inputValue(),note);
  }
  await p.setViewportSize({width:1280,height:800});
  await p.getByRole('button',{name:'我的项目'}).click();await p.locator('dialog button').filter({hasText:'第二个版本'}).click();await p.locator('#geometry-state[data-phase=error]').waitFor();assert.deepEqual(errors,[]);
  const requestsBeforeRetry=requests.length;
  await p.locator('#revision-prompt').fill('保留这个修改意见');
  const previousCanvas=await p.locator('#cad-panel canvas').elementHandle();
  await p.getByRole('button',{name:'重新加载模型'}).click();
  await p.locator('#geometry-state[data-phase=error]').waitFor();
  assert.equal(await previousCanvas.evaluate(canvas=>canvas.isConnected),false);
  assert.equal(await p.locator('#revision-prompt').inputValue(),'保留这个修改意见');
  assert.equal(requests.length,requestsBeforeRetry);
  const handoff=await b.newContext({reducedMotion:'reduce'}),designRequests=[],meshFiles=[];
  let verifyPrivateBranch=false;
  await handoff.route(/https:\/\/formwork-ui-test\.github\.io\/|http:\/\/127\.0\.0\.1:4173\//,async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/api/')){
      if(pathname==='/api/design'){
        const body=route.request().postDataJSON();designRequests.push(body);
        if(!verifyPrivateBranch)return route.fulfill({status:500,json:{error:'Unexpected design request'}});
        return route.fulfill({json:body.action==='discuss'?{decision:'ready',question:'',options:[]}:{design:{...fixture,name:'从水平示例另存'}}});
      }
      return route.fulfill({json:pathname==='/api/capabilities'?{ai:true,aiProvider:'openai-api'}:pathname==='/api/catalog'?{candidates:[]}:{configured:false,authenticated:false}});
    }
    if(pathname.startsWith('/samples/fist-bump')&&pathname.endsWith('-cad.json'))meshFiles.push(pathname);
    const response=await fetch(url+pathname);
    await route.fulfill({status:response.status,contentType:response.headers.get('content-type'),body:Buffer.from(await response.arrayBuffer())});
  });
  const latest=JSON.parse(await readFile(path.join(root,'samples/fist-bump.json'),'utf8'));
  const history=JSON.parse(await readFile(path.join(root,'samples/fist-bump.v1.json'),'utf8'));
  assert.equal(latest.iteration.previousId,'builtin:fist-bump:v1');
  assert.notDeepEqual(latest.design.cadPlan.motions[0].axis,history.design.cadPlan.motions[0].axis);
  const publicPage=await handoff.newPage();await publicPage.goto('https://formwork-ui-test.github.io/?example=fist');
  for(const version of [2,1]){
    if(version===1){
      await publicPage.locator('#previous-version').click();
      await publicPage.waitForURL('**/?example=fist&version=1');
      await publicPage.reload();
    }
    const transfer=publicPage.getByRole('button',{name:'在本机继续修改'});
    await transfer.waitFor();assert.equal(await publicPage.locator('#version-label').innerText(),'第 '+version+' 版');
    await publicPage.locator('#geometry-state[data-phase=ready]').waitFor();
    assert.ok(meshFiles.includes(version===1?'/samples/fist-bump.v1-cad.json':'/samples/fist-bump-cad.json'));
    if(version===2){
      const readDownload=async button=>{
        const [download]=await Promise.all([publicPage.waitForEvent('download'),button.click()]);
        assert.ok(download.suggestedFilename().endsWith('.forge.js'));
        return readFile(await download.path(),'utf8');
      };
      const assembly=await readDownload(publicPage.locator('#download-forge'));
      await publicPage.locator('[data-cc-files] summary').click();
      const [urdf]=await Promise.all([publicPage.waitForEvent('download'),publicPage.getByRole('button',{name:'下载运动学 URDF 工程'}).click()]);
      assert.equal(urdf.suggestedFilename(),'formbench-kinematics.zip');
      const zip=await readFile(await urdf.path());
      assert.equal(zip.readUInt32LE(0),0x04034b50);
      assert.ok(zip.includes(Buffer.from('model.urdf'))&&zip.includes(Buffer.from('meshes/body_')));
      const board=await readDownload(publicPage.getByRole('button',{name:/固定交互控制板.*可编辑模型/}));
      for(const source of [assembly,board]){
        assert.match(source,/xiao-esp32s3/);assert.match(source,/const portSolid=/);assert.match(source,/castellated/);
      }
      const {bodies,motions:[stroke]}=latest.design.cadPlan;
      const prismatic=assembly.split('\n').filter(line=>line.includes('mechanism.addPrismatic('));
      assert.equal(prismatic.length,1);
      assert.ok(prismatic[0].includes(JSON.stringify('1. '+stroke.name)));
      assert.ok(prismatic[0].includes('axis:'+JSON.stringify(stroke.axis)+', min:0, max:'+stroke.travelMm+', default:0'));
      bodies.forEach(({name},i)=>{
        assert.ok(assembly.includes('mechanism.addPart('+JSON.stringify(name)+','));
        const jointAttachment=', "Motion frame 1", '+JSON.stringify(name)+');';
        assert.equal(assembly.includes(jointAttachment),stroke.movingBodyIndices.includes(i),name);
      });
      assert.match(assembly,/mechanism\.toJointsView\(/);
      assert.doesNotMatch(board,/mechanism\.|addPrismatic\(/);
      const latestFeedback=latest.iteration.conversation.filter(t=>t.role==='user').at(-1).text;
      assert.ok(latestFeedback.trim());await publicPage.locator('.iteration-history summary').click();
      assert.ok((await publicPage.locator('.iteration-history ol').innerText()).includes(latestFeedback));
    }else assert.equal(await publicPage.locator('#previous-version').count(),0);
    const feedback='第 '+version+' 版的行程缩短至 12 mm，保留拳面';
    await publicPage.locator('#revision-prompt').fill(feedback);
    const opened=handoff.waitForEvent('page');await transfer.click();const localPage=await opened;
    await localPage.waitForFunction(v=>document.querySelector('#revision-prompt')?.value===v,feedback);
    assert.equal(localPage.url(),'http://127.0.0.1:4173/?example=fist&version='+version);
    assert.equal(await localPage.locator('#version-label').innerText(),'第 '+version+' 版');
    await localPage.close();
  }
  assert.deepEqual(designRequests,[]);
  verifyPrivateBranch=true;
  const branch=await handoff.newPage();await branch.goto('http://127.0.0.1:4173/?example=fist&version=1');
  await branch.locator('#revision-prompt').fill('保留水平方向，缩短行程');
  await branch.locator('#revise-design').click();await branch.getByRole('heading',{name:'从水平示例另存',exact:true}).first().waitFor();
  assert.equal(await branch.locator('#version-label').innerText(),'第 2 版');
  assert.deepEqual(designRequests.map(req=>req.action),['discuss','generate']);
  assert.deepEqual(designRequests.at(-1).baseDesign.cadPlan.motions[0].axis,history.design.cadPlan.motions[0].axis);
  assert.equal(designRequests.at(-1).prompt,history.prompt);
  await branch.locator('#previous-version').click();await branch.getByRole('heading',{name:history.design.name,exact:true}).first().waitFor();
  assert.equal(await branch.locator('#version-label').innerText(),'第 1 版');
  const fromGuest=await branch.evaluate(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')));
  const savedBranch=fromGuest.find(record=>record.design.name==='从水平示例另存');
  assert.ok(savedBranch,JSON.stringify(fromGuest.map(record=>({id:record.id,name:record.design.name,iteration:record.iteration}))));
  assert.ok(savedBranch.iteration.previousId&&fromGuest.some(record=>record.id===savedBranch.iteration.previousId));
  await handoff.close();
 }finally{await b?.close();await close()}
});

test('grouped interview supports editable choices, typed answers and scoped delegation before design starts',async()=>{
 const {url,close}=await serveWorkbench();
 let browser;
 try{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const questions=[
   {topic:'outcome',question:'你想让装置提醒你哪件事？',options:['赶上出门时间','把要带的物品拿齐']},
   {topic:'use',question:'你一般在哪里准备出门？',options:['玄关','车库']},
   {topic:'use',question:'提醒时旁边通常有人吗？',options:['通常有','我一个人']}
  ];
  const follow={topic:'use',question:'出发前多久收到提醒比较合适？',options:[]};
  const requests=[];
  await page.route('**/api/**',async route=>{
   const api=new URL(route.request().url()).pathname;
   if(api!=='/api/design')return route.fulfill({json:api==='/api/capabilities'?{ai:true}:{}});
   const req=route.request().postDataJSON();requests.push(req);
   if(req.action==='generate')return route.fulfill({json:{design:fixture}});
   const groups=[questions,[follow],[]],batch=groups[requests.length-1];
   return route.fulfill({json:batch.length?{decision:'ask',questions:batch}:{decision:'ready'}});
  });
  await page.goto(url);await page.locator('#wish').fill('帮我做个出门提醒');await page.locator('#generate').click();
  const groups=questions.map(q=>page.getByRole('group',{name:q.question,exact:true}));
  const submit=page.getByRole('button',{name:'提交回答'});
  await groups[2].waitFor();
  await groups[0].getByRole('radio',{name:questions[0].options[1]}).check();
  await groups[0].getByRole('radio',{name:questions[0].options[0]}).check();
  await groups[1].getByRole('radio',{name:'自己填写'}).check();
  const custom=groups[1].getByRole('textbox');
  assert.ok(await custom.evaluate(el=>el===document.activeElement));
  await custom.fill('自行车棚');await groups[2].getByRole('radio',{name:'由 AI 决定'}).check();
  assert.ok(await submit.isEnabled());await custom.fill('  ');assert.ok(await submit.isDisabled());
  await custom.fill('自行车棚');assert.deepEqual(requests.map(r=>r.action),['discuss']);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await submit.click();await page.getByRole('group',{name:follow.question}).waitFor();
  assert.equal(requests.length,2);assert.equal(requests[1].conversation.length,6);
  assert.deepEqual(requests[1].conversation.filter(t=>t.role==='user'),[
   {role:'user',text:'赶上出门时间'},{role:'user',text:'自行车棚'},{role:'user',text:'这个选择由 AI 决定。',delegated:true}
  ]);
  assert.deepEqual(requests[1].conversation.filter(t=>t.role==='assistant').map(t=>t.topic),['outcome','use','use']);
  await page.getByRole('radio',{name:'自己填写'}).check();await page.getByRole('textbox',{name:follow.question+' 自己填写'}).fill('提前十分钟');await submit.click();
  await page.locator('#project:not([hidden])').waitFor();
  assert.deepEqual(requests.map(r=>r.action),['discuss','discuss','discuss','generate']);
  assert.equal(requests.at(-1).conversation.length,8);assert.deepEqual(requests[2].conversation,requests[3].conversation);
  assert.deepEqual(requests.at(-1).conversation.at(-1),{role:'user',text:'提前十分钟'});
 }finally{await browser?.close();await close()}
});

test('Luna stays project-scoped through Pages handoff, intake and durable job reload',async t=>{
 const {url,close}=await serveWorkbench();t.after(close);
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
 const context=await browser.newContext(),pages='https://formwork-luna-test.github.io',local='http://127.0.0.1:4173';
 const policy='local-codex-luna-max',id='01234567-89ab-cdef-0123-456789abcdef';
 const requests=[];
 let advertised=true,complete=false,reads=0;
 await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),request=route.request();
   if(![local,pages].includes(u.origin))return route.abort();
   if(!u.pathname.startsWith('/api/')){
     const res=await fetch(url+u.pathname);
     return route.fulfill({status:res.status,contentType:res.headers.get('content-type'),body:Buffer.from(await res.arrayBuffer())});
   }
   assert.equal(u.origin,local);
   if(u.pathname==='/api/capabilities')return route.fulfill({json:{ai:true,aiProvider:'local-codex',aiModel:'gpt-6.2-sol',designJobs:true,
     designProviders:[{id:'local-codex',model:'gpt-6.2-sol',...(advertised?{lunaMax:true}:{})}]}});
   if(['/api/design','/api/design-jobs'].includes(u.pathname))requests.push({path:u.pathname,policy:request.postDataJSON().provider,header:request.headers()['x-formbench-provider']});
   const job={id,policy,provider:'local-codex'};
   if(u.pathname==='/api/design')return route.fulfill({json:{decision:'ready'}});
   if(u.pathname==='/api/design-jobs')return route.fulfill({status:202,json:{...job,status:'running',progress:{stage:'sourcing'}}});
   if(u.pathname==='/api/design-jobs/'+id){reads++;return route.fulfill({json:complete?{...job,status:'complete',prompt:'会发光的钥匙扣',design:fixture}:{...job,status:'running',progress:{stage:'sourcing'}}})}
   return route.fulfill({json:{}});
 });
 const publicPage=await context.newPage();
 await publicPage.goto(pages+'/?new=1#provider='+policy);
 await publicPage.getByRole('button',{name:'在本机生成'}).waitFor();
 assert.equal(await publicPage.locator('#run-provider').inputValue(),policy);
 assert.match(await publicPage.locator('#selected-model').innerText(),/Luna \/ max/);
 const opened=context.waitForEvent('page');await publicPage.locator('#generate').click();const page=await opened;
 await page.waitForURL(local+'/?new=1#provider='+policy);
 await page.locator('#generate:enabled').waitFor();
 assert.equal(await page.locator('#run-provider').inputValue(),policy);assert.equal(await page.locator('#wish').inputValue(),'');
 assert.equal(requests.length,0);
 await page.locator('#wish').fill('会发光的钥匙扣');await page.locator('#generate').click();
 await page.locator('#entry-progress[data-phase=sourcing]').waitFor();
 assert.deepEqual(requests,[{path:'/api/design',policy,header:policy},{path:'/api/design-jobs',policy,header:undefined}]);
 assert.equal(page.url(),local+'/');assert.match(await page.locator('#selected-model').innerText(),/Luna \/ max/);
 await page.reload();await page.locator('#entry-progress[data-phase=sourcing]').waitFor();
 assert.ok(reads>0);assert.equal(await page.locator('#run-provider').inputValue(),policy);
 assert.match(await page.locator('#selected-model').innerText(),/Luna \/ max/);assert.equal(requests.length,2);
 complete=true;await page.locator('#project:not([hidden])').waitFor();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')||'[]')[0]?.iteration.policy==='local-codex-luna-max');
 await page.locator('#back').click();assert.equal(await page.locator('#run-provider').inputValue(),'auto');
 assert.match(await page.locator('#selected-model').innerText(),/gpt-6\.2-sol/);
 await page.goto(local+'/?job='+id);await page.locator('#revision-prompt').fill('加一个挂绳孔');await Promise.all([
   page.waitForResponse(response=>response.url()===local+'/api/design-jobs'),
   page.locator('#revise-design').click()
 ]);
 assert.equal(requests.at(-1).policy,policy);
 advertised=false;
 const unavailable=await context.newPage();await unavailable.goto(local+'/?new=1#provider='+policy);
 await unavailable.getByText('当前工作台未提供 GPT‑6‑Luna / max。请选择其他运行方式。').waitFor();
 assert.equal(await unavailable.locator('#run-provider').inputValue(),policy);
 assert.ok(await unavailable.locator('#generate').isDisabled());assert.ok(await unavailable.locator('option[value="'+policy+'"]').isDisabled());
 await unavailable.locator('.run-options summary').click();await unavailable.locator('#run-provider').selectOption('auto');
 assert.ok(await unavailable.locator('#generate').isEnabled());
});
