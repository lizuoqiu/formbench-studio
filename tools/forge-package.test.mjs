import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {editableForgeDownload} from '../forge-package.js';
import {buildAssemblyWiring} from '../assembly-wires.js';

const run=promisify(execFile);
const {design}=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v5.json',import.meta.url)));
const {cadPlan,parts,interaction}=design;
const wires=buildAssemblyWiring(design);
const panelFolder='assets/hardware/adafruit-938-qt/';
const expected=['adafruit-938-stemma-qt.step','glass.stl','NOTICE.txt','LICENSE-MIT.txt','LICENSE-CC-BY-SA-3.0.txt'];
function localAssets(t,missing){
 const fetched=[];
 t.mock.method(globalThis,'fetch',async url=>{
  fetched.push(url.pathname);
  if(url.pathname.endsWith('/'+missing))return new Response(null,{status:404});
  return new Response(await readFile(url));
 });
 return fetched;
}

test('single prints and the dimensioned encoder stay standalone, while the seven OLED material files travel together',async t=>{
 const fetched=localAssets(t);
 const one=await editableForgeDownload(cadPlan,parts,0,interaction,wires);
 assert.equal(one.extension,'.forge.js');assert.doesNotMatch(await one.blob.text(),/importMesh|参考线束/);
 const encoder=await editableForgeDownload(cadPlan,parts,5);
 assert.equal(encoder.extension,'.forge.js');assert.equal((await encoder.blob.text()).match(/电气脚/g).length,5);
 const oled=await editableForgeDownload(cadPlan,parts,7);
 assert.equal(oled.extension,'.zip');assert.equal(oled.blob.type,'application/zip');
 assert.deepEqual(Array.from(new Uint8Array(await oled.blob.slice(0,4).arrayBuffer())),[0x50,0x4b,3,4]);
 for(const f of expected)assert.ok(fetched.some(p=>p.endsWith('/'+panelFolder+f)),f);
 assert.equal(fetched.filter(p=>p.endsWith('.stl')).length,7);
});

test('a missing registered OLED asset is reported before returning an incomplete package',async t=>{
 localAssets(t,'glass.stl');
 await assert.rejects(editableForgeDownload(cadPlan,parts,7),/glass\.stl/);
});

test('an extracted V5 project loads in real ForgeCAD with registered material bounds, pin geometry and wire routes',
 {skip:process.env.FORGECAD_RESEARCH_AUTOMATION!=='true'||!process.env.FORGECAD_BIN},async t=>{
 localAssets(t);const dir=await mkdtemp(join(tmpdir(),'formwork-panel-project-'));
 try{
  const {blob,extension}=await editableForgeDownload(cadPlan,parts,null,interaction,wires);
  assert.equal(extension,'.zip');const archive=join(dir,'project.zip');await writeFile(archive,new Uint8Array(await blob.arrayBuffer()));
  await run('unzip',['-q',archive,'-d',dir]);
  for(const f of expected){
   assert.deepEqual(await readFile(join(dir,panelFolder,f)),await readFile(new URL('../'+panelFolder+f,import.meta.url)));
  }
  const {stdout}=await run(process.env.FORGECAD_BIN,['run',join(dir,'main.forge.js')],{timeout:35_000});
  const objects=stdout.split('\n').filter(line=>line.includes(': vol='));
  assert.equal(objects.filter(line=>line.startsWith('  参考线束')).length,wires.routes.length);
  assert.equal(objects.filter(line=>line.includes('电气脚')).length,5);
  assert.equal(objects.filter(line=>line.includes('938 前向屏')&&line.includes('sources:imported')).length,7);
  // The V5 screen faces -Y and its PCB origin is (0,-21,24) mm in assembly coordinates.
  assert.match(objects.find(line=>line.includes('OLED 玻璃与屏面')),/bbox=\[-17\.2,-23\.8,12\.6\] → \[17\.2,-21\.8,35\.6\]/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
