import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp'};
test('shared snapshots open without generation, pin versions, copy privately and retain originals',async()=>{
  const server=createServer(async(req,res)=>{
    try{const name=new URL(req.url,'http://local.test').pathname.slice(1)||'index.html';const full=path.resolve(root,name);if(!full.startsWith(root))throw Error();res.writeHead(200,{'Content-Type':types[path.extname(full)]||'application/octet-stream'});res.end(await readFile(full))}
    catch{res.writeHead(404);res.end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const manifest=JSON.parse(await readFile(path.join(root,'samples/shared/manifest.json')));
  const first=manifest.projects[0],v1=first.versions[0];
  const fixture={...manifest,projects:[{...first,versions:[{...v1,label:'第一版',version:1},{...v1,label:'第二版',version:2}]}]};
  let browser;
  try{
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage(),errors=[],api=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    await page.route('**/samples/shared/manifest.json',route=>route.fulfill({json:fixture}));
    await page.route('**/api/**',route=>{
      const pathname=new URL(route.request().url()).pathname;api.push(pathname);
      if(pathname==='/api/capabilities')return route.fulfill({json:{ai:false,cadEngine:'forgecad',cart:false}});
      if(pathname==='/api/auth/status')return route.fulfill({json:{configured:false,authenticated:false}});
      if(pathname==='/api/catalog')return route.fulfill({json:{candidates:[]}});
      return route.fulfill({status:503,json:{error:'Test has no generation service'}});
    });
    await page.goto(base);await page.locator('#studio-gallery:not([hidden])').waitFor();
    assert.match(await page.locator('#studio-gallery').innerText(),/工作室精选.*仅 CAD 已核验.*未实物验证/s);
    const card=page.locator('#studio-gallery a').first();assert.match(await card.getAttribute('href'),/share=.*version=2/);await card.click();
    await page.locator('#project[data-shared=true]').waitFor();await page.locator('#geometry-state[data-phase=ready][data-approximate=false]').waitFor();
    assert.equal(await page.locator('#shared-version').inputValue(),'2');assert.equal(await page.locator('#revision-form').isVisible(),false);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')||'[]').length),0);
    await page.locator('#view-parts').click();assert.equal(await page.locator('#shopping-cart').isVisible(),false);assert.equal(await page.locator('.edit').first().isVisible(),false);
    await page.locator('#shared-version').selectOption('1');await page.waitForURL(/version=1/);await page.locator('#geometry-state[data-phase=ready]').waitFor();
    await page.locator('#share-project').click();assert.match(await page.locator('#project-share-url').inputValue(),/share=.*version=1/);
    await page.locator('#copy-share-link').click();await page.locator('#share-copy-status').getByText('链接已复制。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭分享窗口'}).click();await page.locator('#project-share-dialog').waitFor({state:'detached'});
    await page.reload();await page.locator('#project[data-shared=true]').waitFor();assert.equal(await page.locator('#shared-version').inputValue(),'1');
    const originalName=await page.locator('.project-heading h1').innerText();
    await page.locator('#copy-project').click();await page.locator('#project[data-shared=false]').waitFor();assert.equal(await page.locator('#revision-form').isVisible(),true);assert.equal(new URL(page.url()).searchParams.has('share'),false);
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1')||'[]').length===1);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('formbench.consumer.guest.v1'))[0]);assert.equal(saved.copyOrigin.slug,first.slug);assert.equal(saved.copyOrigin.version,1);assert.equal(saved.design.name,originalName);
    await page.locator('#back').click();await page.getByRole('button',{name:'我的项目',exact:true}).click();await page.locator('dialog button').filter({hasText:originalName}).click();await page.locator('#project[data-shared=false]').waitFor();assert.match(await page.locator('.project-version').innerText(),/个人副本/);
    await page.goto(base+'/?share='+first.slug+'&version=2');await page.locator('#geometry-state[data-phase=ready][data-approximate=false]').waitFor();assert.equal(await page.locator('#shared-version').inputValue(),'2');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});await page.locator('#view-model').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.GALLERY_SCREENSHOTS)await page.screenshot({path:path.join(process.env.GALLERY_SCREENSHOTS,`gallery-project-${width}.png`)});
    }
    await page.locator('#close-shared').click();assert.equal(await page.locator('#entry').isVisible(),true);assert.equal(new URL(page.url()).searchParams.has('share'),false);
    await page.setViewportSize({width:1440,height:900});
    if(process.env.GALLERY_SCREENSHOTS){
      await page.goto(base);await page.locator('#studio-gallery:not([hidden])').waitFor();
      await page.locator('.example-cover img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode().catch(()=>{}))));
      await page.screenshot({path:path.join(process.env.GALLERY_SCREENSHOTS,'gallery-home.png'),fullPage:true});
    }
    await page.goto(base+'/?share='+first.slug+'&version=999');await page.getByText('这个分享版本不存在，请从首页打开最新版本。').waitFor();assert.equal(await page.locator('#project').isVisible(),false);
    assert.deepEqual(api.filter(p=>/design|cad\/|export/.test(p)),[]);assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
});
