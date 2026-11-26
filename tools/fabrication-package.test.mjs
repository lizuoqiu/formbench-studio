import test from 'node:test';import assert from 'node:assert/strict';
import {fabricationPackage,fabricationZip} from '../fabrication-package.js';import {decodeSTL} from '../assembly-hardware.js';
const design={name:'A',parts:[{name:'Bracket',kind:'custom',qty:2,spec:'PETG machined edge'},{name:'Board',kind:'purchase',qty:1}]};
const body=(id,part,x)=>({name:'body'+x,partIndex:part,instanceIndex:id,positionMm:[x,0,0],exact:true,meshes:[{triangles:[[[0,0,0],[1,0,0],[0,1,0]]]}]});
const geometry={exact:true,bodies:[body(0,0,100),body(0,0,105),body(1,0,150),body(0,1,200)]};
test('fabrication files group submeshes by unit and never order purchased parts',()=>{const {entries,manifest}=fabricationPackage(design,geometry);assert.equal(manifest.parts.length,1);assert.equal(manifest.parts[0].material,'PETG');assert.deepEqual(manifest.parts[0].files.map(x=>x.quantity),[1,1]);const faces=decodeSTL(entries['parts/part-1-1.stl'].buffer);assert.equal(faces[1][0][0],5);assert.deepEqual([...fabricationZip(design,geometry).slice(0,2)],[80,75]);});
test('preview or missing instances cannot produce a fabrication package',()=>{assert.throws(()=>fabricationPackage(design,{...geometry,exact:false}),/精确/);assert.throws(()=>fabricationPackage(design,{...geometry,bodies:geometry.bodies.slice(0,2)}),/数量/);});
