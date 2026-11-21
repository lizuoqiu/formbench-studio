import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchXiaoC3Reference,matchXiaoS3Reference,matchHardware,encodeSTL,decodeSTL} from '../assembly-hardware.js';
const part={name:'主控板',model:'Seeed Studio XIAO ESP32C3',spec:'无排针'};
test('exact original headerless XIAO board only; preserve the specified purchase and dimensions',()=>{
 assert.equal(matchXiaoC3Reference(part),'xiao-esp32c3');
 for(const x of [{model:'ESP32-C3'},{model:'XIAO ESP32S3'},{spec:'pre-soldered'},{spec:'有排针版'},{spec:'无排针 XIAO ESP32C6替代板'},{modelSourceInvalidated:true},{dimensionSource:'specified'},{modelId:'another-purchase'}])assert.equal(matchXiaoC3Reference({...part,...x}),null);
});
test('dimensioned approximate geometry matches its recorded extents in millimetres',async()=>{
 const root=new URL('../assets/hardware/xiao-esp32c3/',import.meta.url),m=JSON.parse(await readFile(new URL('metadata.json',root)));
 const points=[];
 for(const mesh of m.meshes){
  const b=await readFile(new URL(mesh.file,root));const fs=decodeSTL(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));assert.equal(fs.length,mesh.triangles);
  points.push(...fs.flat());
 }
 const size=[0,1,2].map(k=>+(Math.max(...points.map(p=>p[k]))-Math.min(...points.map(p=>p[k]))).toFixed(3));
 assert.deepEqual(size,m.sizeMm);assert.equal(m.modelType,'dimensioned-approximation');assert.deepEqual(m.boardSizeMm,[20.955,17.78,1.6]);
});

test('the S3 catalog matches only the base board and rejects variant or changed dimensions',()=>{
 const base={name:'交互控制板',model:'Seeed Studio XIAO ESP32-S3',spec:'非 Sense，无排针版'};
 assert.equal(matchHardware(base),'xiao-esp32s3');
 assert.equal(matchHardware({...base,model:'XIAO ESP32‑S3',spec:'基础版'}),'xiao-esp32s3');
 for(const x of [{model:'ESP32-S3'},{model:'XIAO ESP32C3'},{model:'XIAO ESP32S3 Sense'},
  {model:'XIAO ESP32S3 Plus'},{model:'XIAO ESP32S3+'},{spec:'带预焊排针'},{spec:'XIAO expansion board'},
  {spec:'可替换 ESP32-C6'},{modelId:'xiao-esp32c3'},{dimensionSource:'specified'},{modelSourceInvalidated:true}]){
  assert.equal(matchXiaoS3Reference({...base,...x}),null);
 }
});

test('S3 combined STL contains the same four material meshes and board envelope as its catalog preview',async()=>{
 const root=new URL('../assets/hardware/xiao-esp32s3/',import.meta.url);
 const meta=JSON.parse(await readFile(new URL('metadata.json',root)));
 const groups=await Promise.all(meta.meshes.map(async m=>{
  const b=await readFile(new URL(m.file,root));
  const faces=decodeSTL(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  assert.equal(faces.length,m.triangles);return faces;
 }));
 const preview=groups.flat(),combined=decodeSTL(encodeSTL(preview)),points=combined.flat();
 assert.deepEqual(combined,preview);
 assert.equal(new Set(meta.meshes.map(m=>m.color.join(','))).size,4);
 const size=[0,1,2].map(k=>+(Math.max(...points.map(v=>v[k]))-Math.min(...points.map(v=>v[k]))).toFixed(3));
 assert.deepEqual(size,meta.sizeMm);assert.deepEqual(size,[22.482,17.78,4.46]);assert.deepEqual(meta.boardSizeMm,[20.955,17.78,1.25]);
 assert.match(meta.manufacturerCadUrl,/esp32s3-3d_model\.zip$/);
 assert.equal(meta.modelType,'dimensioned-approximation');
});
