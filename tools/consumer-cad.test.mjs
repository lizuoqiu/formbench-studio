import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildConsumerConcept,resolveConsumerGeometry} from '../consumer-cad.js';
import {encodeSTL,decodeSTL} from '../assembly-hardware.js';

const board={name:'接口板',spec:'M-1',model:'M-1',qty:1,sizeMm:[42,24,9],dimensionSource:'specified',role:'internal'};
const panel={name:'操作按钮',spec:'P-1',model:'P-1',qty:2,sizeMm:[10,10,6],dimensionSource:'specified',role:'panel'};
const boxOf=faces=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const f of faces)for(const p of f)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k])}return max.map((v,k)=>v-min[k])};
function checkSolid(faces){
 const edges=new Map();let volume=0;
 for(const [a,b,c] of faces){volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;for(const [p,q] of [[a,b],[b,c],[c,a]]){const x=p.join(','),y=q.join(','),key=[x,y].sort().join('|');const edge=edges.get(key)||{count:0,balance:0};edge.count++;edge.balance+=x<y?1:-1;edges.set(key,edge)}}
 assert.ok(volume>0);for(const value of edges.values()){assert.equal(value.count,2);assert.equal(value.balance,0)}
}

test('case and actual reference geometry change with the edited component size',async()=>{
 const original=buildConsumerConcept({parts:[board,panel]}),bigger={...board,sizeMm:[80,36,21]};
 const changed=buildConsumerConcept({parts:[bigger,panel]});
 assert.ok(changed.shell.sizeMm[0]>original.shell.sizeMm[0]);assert.ok(changed.shell.sizeMm[1]>original.shell.sizeMm[1]);assert.ok(changed.shell.sizeMm[2]>original.shell.sizeMm[2]);
 assert.notDeepEqual(changed.shell.base,original.shell.base);
 const [part]=await resolveConsumerGeometry({parts:[bigger]});
 assert.deepEqual(boxOf(part.meshes.flatMap(mesh=>mesh.triangles)),bigger.sizeMm);
 assert.deepEqual(changed.instances[0].sizeMm,bigger.sizeMm);
});

test('external cable dimensions never enlarge the case or enter its instance layout',()=>{
 const base=buildConsumerConcept({parts:[board,panel]});
 const cable={name:'USB 数据线',spec:'2 米',model:'外接线',qty:1,sizeMm:[1900,900,30],dimensionSource:'estimated'};
 const result=buildConsumerConcept({parts:[board,panel,cable]});
 assert.deepEqual(result.shell.sizeMm,base.shell.sizeMm);assert.equal(result.instances.length,base.instances.length);assert.equal(result.external.length,1);
 assert.equal(buildConsumerConcept({parts:[cable]}).shell,null);
});

test('packing accounts for quantities and leaves separated envelopes within the shell',()=>{
 const result=buildConsumerConcept({parts:[{...board,qty:6},{...panel,qty:3}]});
 assert.equal(result.instances.length,9);
 const internal=result.instances.filter(item=>item.role==='internal');
 for(const item of internal){const [x,y,z]=item.positionMm,[w,d,h]=item.sizeMm;assert.ok(x>=2&&y>=2&&z>=2);assert.ok(x+w<=result.shell.sizeMm[0]-2);assert.ok(y+d<=result.shell.sizeMm[1]-2);assert.ok(z+h<result.shell.baseHeight)}
 for(let i=0;i<internal.length;i++)for(let j=i+1;j<internal.length;j++){const a=internal[i],b=internal[j];assert.ok(a.positionMm[0]+a.sizeMm[0]<=b.positionMm[0]||b.positionMm[0]+b.sizeMm[0]<=a.positionMm[0]||a.positionMm[1]+a.sizeMm[1]<=b.positionMm[1]||b.positionMm[1]+b.sizeMm[1]<=a.positionMm[1])}
});

test('hollow base and separate lid are closed oriented solids and round-trip as binary STL',()=>{
 const {shell}=buildConsumerConcept({parts:[board,panel]});
 checkSolid(shell.base);checkSolid(shell.lid);
 const bytes=encodeSTL(shell.base,'concept enclosure mm');assert.equal(new DataView(bytes).getUint32(80,true),shell.base.length);
 const bounds=boxOf(decodeSTL(bytes));assert.deepEqual(bounds,[shell.sizeMm[0],shell.sizeMm[1],shell.baseHeight]);
 assert.deepEqual(boxOf(shell.lid),[shell.sizeMm[0],shell.sizeMm[1],shell.lidThickness]);
});

test('catalog geometry keeps its native size; edited envelope does not deform it',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async input=>{const bytes=await readFile(new URL(input));return new Response(bytes)};
 try{
  const catalogPart={name:'Raspberry Pi Pico',spec:'RP2040',modelId:'pico',model:'Pico R3',qty:1,sizeMm:[52.3,21,3.73],dimensionSource:'catalog',role:'internal'};
  const [native]=await resolveConsumerGeometry({parts:[catalogPart]});
  assert.equal(native.dimensionSource,'catalog');assert.ok(native.metadata.sourceUrl.includes('Pico-R3-step'));assert.ok(native.sizeMm[0]>51);assert.match(native.geometryNote,/未缩放/);
  const [edited]=await resolveConsumerGeometry({parts:[{...catalogPart,sizeMm:[72,30,10],dimensionSource:'specified'}]});
  assert.deepEqual(boxOf(edited.meshes.flatMap(mesh=>mesh.triangles)),[72,30,10]);assert.match(edited.geometryNote,/不代表原厂外形/);
  const [conflict]=await resolveConsumerGeometry({parts:[{...catalogPart,sizeMm:[72,30,10]}]});
  assert.deepEqual(conflict.sizeMm,[72,30,10]);assert.deepEqual(boxOf(conflict.meshes.flatMap(mesh=>mesh.triangles)),[72,30,10]);assert.match(conflict.geometryNote,/输入尺寸与目录几何不一致/);
  const [explicitBox]=await resolveConsumerGeometry({parts:[{...catalogPart,shape:'box'}]});
  assert.equal(explicitBox.meshes[0].triangles.length,12);assert.match(explicitBox.geometryNote,/长方体设计包络/);
 }finally{globalThis.fetch=previous}
});

test('changed explicit model or missing modelId never falls back to a familiar BOM name',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('unexpected catalog lookup')};
 try{
  for(const modelId of [undefined,null,'not-a-catalog-model']){
   const p={...board,name:'Raspberry Pi Pico',model:'指定的其他模块',modelId,sizeMm:[28,15,6],dimensionSource:'specified'};
   const [result]=await resolveConsumerGeometry({parts:[p]});
   assert.equal(result.model,p.model);assert.equal(result.metadata,null);assert.deepEqual(result.sizeMm,p.sizeMm);
  }
  const [invalidated]=await resolveConsumerGeometry({parts:[{...board,model:'新选购模块',modelId:'pico',modelSourceInvalidated:true,dimensionSource:'catalog'}]});
  assert.equal(invalidated.metadata,null);assert.equal(invalidated.meshes[0].triangles.length,12);
  assert.match(invalidated.geometryNote,/设计包络/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=previous}
});

test('specified cylinders keep their shape and dimensions; unequal diameters are rejected',async()=>{
 const cylinder={...board,name:'圆柱探头',model:'Probe 20',shape:'cylinder',sizeMm:[20,20,18],dimensionSource:'specified'};
 const [part]=await resolveConsumerGeometry({parts:[cylinder]}),faces=part.meshes.flatMap(mesh=>mesh.triangles);
 assert.deepEqual(boxOf(faces),[20,20,18]);assert.ok(faces.length>100);assert.match(part.geometryNote,/圆柱设计包络/);
 for(const face of faces)for(const [x,y] of face)assert.ok(Math.abs(Math.hypot(x-10,y-10)-10)<1e-8);
 assert.throws(()=>buildConsumerConcept({parts:[{...cylinder,sizeMm:[20,18,18]}]}),/同一个直径/);
 await assert.rejects(resolveConsumerGeometry({parts:[{...cylinder,modelId:'pico',dimensionSource:'catalog',sizeMm:[20,18,18]}]}),/同一个直径/);
});

test('invalid input fails with an actionable dimension or quantity message',()=>{
 assert.throws(()=>buildConsumerConcept({parts:[{...board,sizeMm:[0,2,3]}]}),/长、宽、高/);
 assert.throws(()=>buildConsumerConcept({parts:[{...board,qty:161}]}),/160/);
});
