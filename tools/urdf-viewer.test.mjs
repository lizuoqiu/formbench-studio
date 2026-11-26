import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url),origin='http://127.0.0.1:49232/';
const arm='<robot name="rotation-fixture"><link name="base"/><link name="arm"/><link name="tip"/><joint name="hinge" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="0" upper="1.5707963267948966" effort="2" velocity="1"/></joint><joint name="tool" type="fixed"><parent link="arm"/><child link="tip"/><origin xyz="0.1 0 0"/></joint><material name="unused"><texture filename="https://test.invalid/model.png"/></material></robot>';
const slide='<robot name="slide-fixture"><link name="base"/><link name="slide"/><link name="tip"/><joint name="extension" type="prismatic"><parent link="base"/><child link="slide"/><limit lower="0" upper="0.025"/></joint><joint name="follower" type="prismatic"><parent link="slide"/><child link="tip"/><axis xyz="0 1 0"/><limit lower="-0.01" upper="0.03"/><mimic joint="extension" multiplier="0.5" offset="0.002"/></joint></robot>';
test('local URDF import drives published FK, folder selection, mimic and unknown limits without external requests',async t=>{
 const script=(await build({entryPoints:[fileURLToPath(new URL('./urdf-viewer.js',import.meta.url))],bundle:true,format:'esm',write:false})).outputFiles[0].text;
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome'});t.after(()=>browser.close());
 const page=await browser.newPage(),otherRequests=[];
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url===origin)return route.fulfill({path:fileURLToPath(new URL('urdf-viewer.html',root)),contentType:'text/html'});
  if(url===origin+'urdf-viewer.css')return route.fulfill({path:fileURLToPath(new URL('urdf-viewer.css',root)),contentType:'text/css'});
  if(url===origin+'assets/urdf/viewer.js')return route.fulfill({body:script,contentType:'text/javascript'});
  otherRequests.push(url);return route.abort();
 });
 await page.goto(origin);
 const open=text=>page.locator('#file').setInputFiles({name:'robot.urdf',mimeType:'application/xml',buffer:Buffer.from(text)});
 // Real iCub exports include a redundant zero axis on fixed frame joints.
 await open(arm.replace('<origin xyz="0.1 0 0"/>','<axis xyz="0 0 0"/><origin xyz="0.1 0 0"/>'));await page.getByRole('heading',{name:'rotation-fixture'}).waitFor();
 await page.getByRole('slider',{name:'hinge °'}).press('End');
 await page.getByRole('button',{name:'tool',exact:true}).click();
 assert.match(await page.locator('#coordinates').innerText(),/\[0, 100, 0\] mm/);
 await page.getByRole('button',{name:'复位',exact:true}).click();
 assert.match(await page.locator('#coordinates').innerText(),/\[100, 0, 0\] mm/);
 const dir=await mkdtemp(join(tmpdir(),'local-urdf-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'urdf'));await writeFile(join(dir,'urdf','a.urdf'),arm);await writeFile(join(dir,'urdf','b.urdf'),slide);
 await page.locator('#folder').setInputFiles(dir);await page.locator('#files').waitFor();await page.locator('#files').selectOption('1');
 await page.getByRole('heading',{name:'slide-fixture'}).waitFor();assert.match(await page.locator('#joints').innerText(),/URDF 默认/);
 await page.getByRole('slider',{name:'extension mm'}).press('End');await page.getByRole('button',{name:'follower',exact:true}).click();
 assert.match(await page.locator('#coordinates').innerText(),/\[25, 14.5, 0\] mm/);
 await open(slide.replace('upper="0.025"',''));await page.getByText(/未给出完整限位/).waitFor();assert.equal(await page.getByRole('slider').count(),0);
 await open(arm.replace('xyz="0 0 1"','xyz="0 0 0"'));await page.getByRole('status').filter({hasText:'axis 缺失或为零'}).waitFor();assert.equal(await page.locator('#workspace').isVisible(),false);
 for(const source of ['extension','follower']){
  const loop=slide.replace('<parent link="base"/>','<mimic joint="'+source+'"/><parent link="base"/>');
  await open(loop);await page.getByRole('status').filter({hasText:'循环引用'}).waitFor();assert.equal(await page.locator('#workspace').isVisible(),false);
 }
 assert.deepEqual(otherRequests,[]);
});
