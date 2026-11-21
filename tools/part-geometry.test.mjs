import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readPurchasedCad,makeDocumentedProxy} from '../part-geometry.js';

const file = new URL('../forge/pico-base.step',import.meta.url);
test('STEP (and .stp alias) uses units declared by STEP, returns relative mesh and source origin',async()=>{
  const raw=await readFile(file),r=await readPurchasedCad(raw,'housing.stp');
  r.sizeMm.forEach((n,i)=>assert.ok(Math.abs(n-[64,32,17][i])<.01));assert.ok(r.meshes.some(m=>m.triangles.length>100));
  const text=raw.toString();const scaled=text.replace(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/ig,'SI_UNIT(.CENTI.,.METRE.)');
  assert.notEqual(scaled,text);const cm=await readPurchasedCad(new TextEncoder().encode(scaled),'housing.step');
  cm.sizeMm.forEach((n,i)=>assert.ok(Math.abs(n-r.sizeMm[i]*10)<.02));
});
test('binary and ASCII STL; ASCII unitless coordinates are taken as mm, relative layout preserved',async()=>{
 const original=await readFile(new URL('../forge/pico-base.stl',import.meta.url));
 const b=await readPurchasedCad(original,'base.stl');assert.deepEqual(b.sizeMm,[64,32,17]);
 const ascii='solid test\n facet normal 0 0 1\n outer loop\n vertex -2 8 5\n vertex 10 8 5\n vertex -2 11 5\n endloop\n endfacet\nendsolid test';
 const a=await readPurchasedCad(new TextEncoder().encode(ascii),'flat.STL');
 assert.deepEqual(a.sizeMm,[12,3,0]);assert.deepEqual(a.originalMinMm,[-2,8,5]);assert.deepEqual(a.meshes[0].triangles[0],[[0,0,0],[12,0,0],[0,3,0]]);
});
test('documented through-bores leave both caps open; edges form closed two-manifold shell',()=>{
 for(const shape of ['box','cylinder']){
  const model=makeDocumentedProxy({shape,sizeMm:[20,20,8],holes:[{x:10,y:10,diameter:6}]}),f=model.meshes[0].triangles,edges=new Map(),area=[0,0];
  assert.deepEqual(model.sizeMm,[20,20,8]);
  for(const t of f){for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],k=[a.join(','),b.join(',')].sort().join('/');edges.set(k,1+(edges.get(k)||0));}
   if(t.every(p=>p[2]===t[0][2])){const signs=t.map((p,i)=>{const q=t[(i+1)%3];return(q[0]-p[0])*(10-p[1])-(q[1]-p[1])*(10-p[0])});assert.ok(!(signs.every(x=>x>=0)||signs.every(x=>x<=0)));const [a,b,c]=t;area[t[0][2]===0?0:1]+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))*.5;}
  }
  assert.ok([...edges.values()].every(n=>n===2));const wanted=(shape==='box'?400:Math.PI*100)-Math.PI*9;area.forEach(a=>assert.ok(Math.abs(wanted-a)<.22));
 }
});
test('reject outsized files, malformed STL, out-of-bounds and intersecting bores and diameter mismatch',async()=>{
 await assert.rejects(readPurchasedCad({size:17*1024*1024},'big.step'),/16 MiB/);
 await assert.rejects(readPurchasedCad(new Uint8Array([1,2,3]),'bad.stl'),/STL/);
 for(const args of [{shape:'box',sizeMm:[1,2001,2]},{shape:'cylinder',sizeMm:[10,12,8]},{shape:'box',sizeMm:[10,12,8],holes:[{x:2,y:2,diameter:4}]},{shape:'box',sizeMm:[10,12,8],holes:[{x:4,y:5,diameter:3},{x:6,y:5,diameter:3}]}])assert.throws(()=>makeDocumentedProxy(args));
});
