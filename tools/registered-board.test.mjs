import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {completeCatalogAnchors,featurePlacement} from '../cad-plan.js';
import {editableForgeSource} from '../forge-source.js';

const json=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const {design}=await json('../samples/shared/reading-timer/v5.json');
const meta=await json('../assets/hardware/xiao-esp32s3/metadata.json');
const originalPart=design.parts.find(p=>p.modelId==='xiao-esp32s3');
const originalBody=design.cadPlan.bodies.find(b=>design.parts[b.partIndex]===originalPart);
const placed=(b,part=originalPart)=>completeCatalogAnchors([{...b,partIndex:0}],[part],()=>meta)[0];
const half=meta.boundsMm.min.map((n,k)=>(n+meta.boundsMm.max[k])/2);
const near=(a,b)=>assert.ok(a.every((n,i)=>Math.abs(n-b[i])<1e-6),JSON.stringify({a,b}));

test('the historical multi-feature XIAO registers at the board datum and connector plane',()=>{
  const anchor=placed(originalBody);
  assert.ok(anchor);
  near(anchor.centerMm,half);
  const toWorld=p=>featurePlacement(anchor,half)(p).map((n,i)=>n+originalBody.positionMm[i]);
  near(toWorld([0,0,0]),[33.9955,0,5.9]);
  near(toWorld(meta.interfaces[0].centerMm),[46,0,8.68]);
});

test('board symmetry is resolved by connector and asymmetric socket, including an inverted mounting',()=>{
  const pose={centerMm:[8,-3,1],rotationDeg:[180,0,30]};
  const toBody=featurePlacement(pose);
  const body=structuredClone(originalBody);
  body.features.forEach(f=>{
    f.centerMm=toBody(f.centerMm);
    f.rotationDeg=[...pose.rotationDeg];
  });
  // A plate is the same solid after a half-turn; its primitive cannot identify its upper face.
  body.features[0].rotationDeg=[0,0,30];
  const anchor=placed(body);
  assert.ok(anchor);
  const registered=featurePlacement(anchor,half);
  for(const point of [meta.interfaces[0].centerMm,meta.registration.landmarks[2].centerMm,[0,0,0]])
    near(registered(point),toBody(point));
});

test('unregistered custom boards, ambiguous landmarks and modified copies keep authored geometry',()=>{
  const cutIntoBoard={op:'cut',shape:'box',sizeMm:[2,2,3],centerMm:[3,0,.625]};
  const oversizeFoot={op:'add',shape:'box',sizeMm:[2,2,2],centerMm:[-19,0,0]};
  for(const change of [
    b=>b.features.splice(6,1),
    b=>b.features.push({...b.features[6]}),
    b=>{b.features[1].centerMm[0]-=2},
    b=>b.features.push(cutIntoBoard),
    b=>b.features.push(oversizeFoot)
  ]){
    const b=structuredClone(originalBody);change(b);assert.equal(placed(b),null);
  }
  for(const part of [{...originalPart,spec:'Sense 带摄像头'}, {...originalPart,modelSourceInvalidated:true},
    {...originalPart,modelId:''}, {...originalPart,dimensionSource:'estimated'}])assert.equal(placed(originalBody,part),null);
  const broken=[originalBody,{...originalBody,features:[oversizeFoot]}];
  assert.ok(completeCatalogAnchors(broken,design.parts,()=>meta).every(anchor=>!anchor));
});

test('V5 exports the registered controller by material and the registered display with its real supplier files',async t=>{
  t.mock.method(globalThis,'fetch',async target=>new Response(await readFile(new URL(target))));
  const boardIndex=design.cadPlan.bodies.indexOf(originalBody);
  const native=await editableForgeSource(design.cadPlan,design.parts,boardIndex);
  for(const mesh of meta.meshes)assert.ok(native.includes(JSON.stringify(mesh.label)));
  assert.ok(native.includes('const materials = group('));
  const displayMeta=await json('../assets/hardware/adafruit-938-qt/metadata.json');
  const displayPart=design.parts.findIndex(p=>/Adafruit.*938/.test(p.model));
  const displayIndex=design.cadPlan.bodies.findIndex(b=>b.partIndex===displayPart);
  const externalAssets=[];
  const source=await editableForgeSource(design.cadPlan,design.parts,displayIndex,null,null,{externalAssets});
  assert.deepEqual(externalAssets.map(a=>a.id),['adafruit-938-qt']);
  for(const m of displayMeta.meshes){
    assert.ok(source.includes('importMesh("./assets/hardware/adafruit-938-qt/'+m.file+'")'));
    assert.ok(externalAssets[0].files.includes(m.file));
  }
  for(const f of [displayMeta.stepFile,'NOTICE.txt','LICENSE-MIT.txt','LICENSE-CC-BY-SA-3.0.txt'])
    assert.ok(externalAssets[0].files.includes(f));
  // A loose .forge.js with no sidecars remains independently runnable.
  const standalone=await editableForgeSource(design.cadPlan,design.parts,displayIndex);
  assert.doesNotMatch(standalone,/importMesh/);
  assert.match(standalone,/difference\(/);
});
