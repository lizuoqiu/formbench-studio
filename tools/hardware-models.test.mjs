import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalog, matchHardware, getHardwareMetadata, loadPartMeshes, loadHardwareInstances} from '../assembly-hardware.js';

test('use package candidates only for compatible BOM descriptions',()=>{
  for(const [name,spec,expected] of [
    ['Raspberry Pi Pico','RP2040 · Micro USB · 无排针版','pico'],
    ['绿色 LED','5 mm 直插','green-led'],['红色 LED','5 mm 直插','red-led'],
    ['限流电阻','330 Ω · 1/4 W','resistor'],['瞬时按钮','按下时闭合，输入端上拉','button'],
    ['USB 数据线','Micro USB · 可传输数据','usb-cable'],['连接导线','绝缘导线 · 1 组','wire'],
    ['固定螺钉','按最终外壳与板孔确认 · 1 套','screw'],['门磁开关','干簧管与磁铁配对','reed'],
    ['有源蜂鸣模块','带驱动，3.3 V 逻辑输入','buzzer'],
    ['绿色 LED','15 mm 直插',null],['红色 LED','5050 SMD',null],
    ['USB 数据线','USB-C to USB-C',null],['Raspberry Pi Pico W','带无线模块',null],
    ['限流电阻','330Ω 0603 1/4 W',null],['固定螺钉','M3×6',null],['ESP32-C3','',null]
  ])assert.equal(matchHardware({name,spec}),expected,name+' / '+spec);
});

test('the published catalog files, material groups and default assembly agree',async t=>{
  const area=new URL('../assets/hardware/',import.meta.url).href;
  t.mock.method(globalThis,'fetch',async input=>{
    const u=new URL(input);assert.ok(u.href.startsWith(area));return new Response(await readFile(u))
  });
  for(const id of Object.keys(catalog)){
    const data=await getHardwareMetadata(id);
    assert.ok(data.author && data.license && new URL(data.sourceUrl).protocol==='https:',id);
    const meshes=await loadPartMeshes(id);assert.ok(meshes.length>0,id);
    for(const m of meshes){assert.ok(m.triangles.length>0 && m.triangles.every(f=>f.flat().every(Number.isFinite)),id);assert.equal(m.color.length,3)}
  }
  const scene=await loadHardwareInstances();
  assert.deepEqual(scene.unavailableLabels,[]);
  assert.equal(new Set(scene.map(s=>s.id)).size,6);
  const top=id=>{let z=-Infinity;for(const m of scene.filter(m=>m.id===id))for(const f of m.triangles)for(const v of f)z=Math.max(z,v[2]);return z;};
  assert.ok(Math.abs(top('switch')-17.5)<.1,'the short switch remains recessed instead of being stretched');
  assert.ok(top('led-red')>19 && top('led-green')>19,'LEDs protrude through the nominal 19-mm shell');
  // On the STEP-derived PCB top face, each pillar is under a hole, with
  // board material next to it. A box or an incorrectly oriented board fails.
  const topFaces=scene.filter(m=>m.id==='board').flatMap(m=>m.triangles.filter(f=>f.every(p=>Math.abs(p[2]-5)<.001)));
  function pcbContains(x,y){return topFaces.some(f=>{
    const ds=f.map(([px,py],i)=>{const q=f[(i+1)%3];return(q[0]-px)*(y-py)-(q[1]-py)*(x-px);});
    return ds.every(v=>v>=0)||ds.every(v=>v<=0);
  })}
  for(const x of [5,52])for(const y of [10.3,21.7]){
    assert.equal(pcbContains(x,y),false,'mounting hole center is empty');
    assert.equal(pcbContains(x+1.3,y),true,'surface beside mounting hole is board');
  }
  for(const s of scene)assert.ok(!['usb-cable','wire','screw','reed','buzzer'].includes(s.id));
});
