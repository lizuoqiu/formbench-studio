// Exercise the real browser upload, IndexedDB and project reopen paths. All requests are intercepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const origin='https://formwork-images.test';
const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.wasm':'application/wasm'};
const fixture={name:'参考图按钮',summary:'轻触顶面点亮指示灯。',steps:['按下按钮检查指示灯。'],parts:[{name:'按钮',model:'T1',spec:'轻触开关',role:'panel',qty:1,sizeMm:[8,8,4]}]};
const guestKey='formbench.consumer.guest.v1';

async function solidImage(page,color,mimeType,name){
  const data=await page.evaluate(({color,mimeType})=>{
    const canvas=document.createElement('canvas');
    canvas.width=192;canvas.height=144;
    const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,canvas.width,canvas.height);
    return canvas.toDataURL(mimeType).split(',')[1];
  },{color,mimeType});
  return {name,mimeType,buffer:Buffer.from(data,'base64')};
}

async function submittedColors(page,request){
  assert.ok(Array.isArray(request.images),'design request includes reference images');
  for(const image of request.images)assert.match(image.dataUrl,/^data:image\/(jpeg|png|webp);base64,/);
  return page.evaluate(async urls=>{
    const colors=[];
    for(const url of urls){
      const image=new Image();image.src=url;await image.decode();
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      ctx.drawImage(image,0,0,1,1);
      const rgb=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
      const dominant=rgb.indexOf(Math.max(...rgb));
      if(!rgb.every((value,i)=>i===dominant?value>220:value<30))throw Error('Unreadable image colour');
      colors.push(['red','green','blue'][dominant]);
    }
    return colors;
  },request.images.map(item=>item.dataUrl));
}

test('reference images reach design and revision after a reload, with an explicit text-only mode',async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  try{
    const ctx=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'}),page=await ctx.newPage();
    const designRequests=[],pageErrors=[],externalRequests=[];let provider='openai-api';
    page.on('pageerror',err=>pageErrors.push(err.message));page.setDefaultTimeout(10000);
    await ctx.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.origin!==origin){externalRequests.push(u.origin);return route.abort();}
      if(u.pathname==='/api/design'){
        const body=route.request().postDataJSON();designRequests.push(body);
        const payload=body.action==='discuss'?{decision:'ready',question:'',options:[]}:
          {design:{...fixture,name:body.baseDesign?'参考图按钮第二版':fixture.name,generation:{provider,modelId:'test-model',modelSource:'response'}}};
        return route.fulfill({json:payload});
      }
      if(u.pathname.startsWith('/api/')){
        const json=u.pathname==='/api/capabilities'?{ai:true,aiModel:'test-model',aiProvider:provider,designImages:provider==='openai-api'}:
          u.pathname==='/api/catalog'?{candidates:[]}:{configured:false,authenticated:false};
        return route.fulfill({json});
      }
      const file=path.resolve(root,'.'+decodeURIComponent(u.pathname),...(u.pathname.endsWith('/')?['index.html']:[]));
      assert.ok(file.startsWith(root));
      try{return await route.fulfill({body:await readFile(file),contentType:types[path.extname(file)]||'application/octet-stream'});}
      catch{return route.fulfill({status:404,body:'missing test asset'});}
    });
    await page.goto(origin);await page.locator('#selected-model:not([hidden])').waitFor();
    const red=await solidImage(page,'#ff0000','image/png','housing.png');
    const green=await solidImage(page,'#00ff00','image/jpeg','removed.jpg');
    const blue=await solidImage(page,'#0000ff','image/jpeg','side-view.jpg');
    const fresh=page.locator('.design-images:has(#new-design-images)'),revision=page.locator('.design-images:has(#revision-design-images)');
    await fresh.locator('input[type=file]').setInputFiles([red,green]);
    await fresh.locator('img').nth(1).waitFor();
    await fresh.locator('[data-remove-image]').nth(1).click();
    assert.equal(await fresh.locator('img').count(),1);
    const prompt='做一个如图的桌面按钮';await page.locator('#wish').fill(prompt);await page.locator('#generate').click();
    await page.getByRole('heading',{name:fixture.name,exact:true}).first().waitFor();
    assert.deepEqual(designRequests.map(r=>r.action),['discuss','generate']);
    for(const request of designRequests){assert.equal(request.prompt,prompt);assert.deepEqual(await submittedColors(page,request),['red']);}

    await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'[]').length===1,guestKey);
    await page.reload();await page.getByRole('button',{name:'我的项目'}).click();
    await page.locator('dialog button').filter({hasText:fixture.name}).click();
    await revision.locator('img').first().waitFor();
    await revision.locator('input[type=file]').setInputFiles(blue);await revision.locator('img').nth(1).waitFor();
    const feedback='保留红色壳体，按蓝图修改侧面';
    await page.locator('#revision-prompt').fill(feedback);await page.locator('#revise-design').click();
    await page.getByRole('heading',{name:'参考图按钮第二版',exact:true}).first().waitFor();
    assert.deepEqual(designRequests.slice(2).map(r=>r.action),['discuss','generate']);
    for(const request of designRequests.slice(2)){
      assert.equal(request.baseDesign.name,fixture.name);assert.equal(request.conversation.at(-1).text,feedback);
      assert.deepEqual(await submittedColors(page,request),['red','blue']);
    }
    await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'[]').length===2,guestKey);
    const stored=await page.evaluate(key=>localStorage.getItem(key),guestKey);
    assert.doesNotMatch(stored,/data:image\//);
    for(const {images} of designRequests)for(const {dataUrl} of images)assert.ok(!stored.includes(dataUrl.split(',')[1]));
    await page.locator('#previous-version').click();
    await page.getByRole('heading',{name:fixture.name,exact:true}).first().waitFor();
    await revision.locator('img').first().waitFor();
    assert.equal(await revision.locator('img').count(),1,'adding a revision image preserves the original version');

    provider='local-codex';await page.reload();
    await page.locator('#selected-model:not([hidden])').waitFor();
    assert.ok(await page.locator('#new-design-images').isDisabled());
    assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);
  }finally{await browser.close();}
});
