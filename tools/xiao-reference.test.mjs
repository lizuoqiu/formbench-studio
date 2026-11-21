import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchXiaoC3Reference,decodeSTL} from '../assembly-hardware.js';
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
