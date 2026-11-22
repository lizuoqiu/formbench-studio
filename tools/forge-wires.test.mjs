import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {buildAssemblyWiring} from '../assembly-wires.js';
import {cadPlanToForgeScript,editableForgeSource} from '../forge-source.js';

const {design}=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v5.json',import.meta.url)));
const {cadPlan,interaction,parts}=design;
const wiring=buildAssemblyWiring(design);

test('an editable assembly draws the same reference routes, endpoints and colors as its wiring view',async()=>{
 assert.equal(wiring.routes.length,12);
 assert.equal(wiring.mates.length,2);
 const moving=await editableForgeSource(cadPlan,parts,null,interaction,wiring);
 const fixed=cadPlanToForgeScript(cadPlan,null,wiring);
 for(const source of [moving,fixed]){
  assert.match(source,/不用于打印、裁线或干涉验证/);
  assert.equal(source.match(/参考线束 · /g).length,wiring.routes.length);
  for(const route of wiring.routes){
   assert.ok(source.includes('referenceWire('+JSON.stringify(route.points)+', '+JSON.stringify(route.color)+')'));
   assert.ok(source.includes(route.from.partName+' '+route.from.pin+' → '+route.to.partName+' '+route.to.pin));
  }
 }
 assert.match(moving,/mechanism\.addPart\("参考线束/);
 assert.match(fixed,/tags: "reference", shape: referenceWire/);
 const printable=await editableForgeSource(cadPlan,parts,0);
 assert.equal(await editableForgeSource(cadPlan,parts,0,interaction,wiring),printable);
});

test('empty, stale and unlocated routes do not add wires to the assembly',()=>{
 const reference=cadPlanToForgeScript(cadPlan,interaction),r=wiring.routes[0];
 for(const w of [undefined,{routes:[],mates:wiring.mates,unresolved:[r]},
  {routes:[{...r,from:{...r.from,worldMm:null}},{...r,to:{...r.to,bodyIndex:999}},
    {...r,quality:'unlocated'},{...r,points:[r.to.worldMm,r.from.worldMm]}]}]){
  assert.equal(cadPlanToForgeScript(cadPlan,interaction,w),reference);
 }
});

test('ForgeCAD creates a distinct solid with positive volume for every V5 wire',{skip:process.env.FORGECAD_RESEARCH_AUTOMATION!=='true'||!process.env.FORGECAD_BIN},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'formwork-wire-export-'));
 try{
  await writeFile(join(dir,'forgecad.json'),'{}');
  const path=join(dir,'reference.forge.js');
  await writeFile(path,cadPlanToForgeScript(cadPlan,interaction,wiring));
  const {stdout}=await promisify(execFile)(process.env.FORGECAD_BIN,['run',path],{timeout:30_000});
  const volumes=[...stdout.matchAll(/^\s*参考线束 · .*?: vol=([\d.]+)mm³/gm)].map(match=>Number(match[1]));
  assert.ok(stdout.includes('Objects: '+(cadPlan.bodies.length+wiring.routes.length)));
  assert.equal(volumes.length,wiring.routes.length);
  assert.ok(volumes.every(volume=>volume>0));
 }finally{await rm(dir,{recursive:true,force:true});}
});
