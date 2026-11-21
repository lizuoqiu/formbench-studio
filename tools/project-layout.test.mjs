import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleanPlacements,placeModelMeshes} from '../project-layout.js';
import {bindingKeys,resolveModelForRow} from '../model-selection.js';
import {createHandoffBundle,readHandoffBundle} from '../assembly-handoff.js';

const sample=await readFile(new URL('../samples/assembly-example.json',import.meta.url),'utf8');
test('the supplied assembly kit retains three positioned models and their selected variants through handoff',()=>{
  const state=readHandoffBundle(sample);
  assert.deepEqual(state.placements.map(p=>p.partIndex),[0,1,2]);
  assert.equal(resolveModelForRow(state.design.parts[0],state.items[0]).id,'pico');
  assert.deepEqual([1,2].map(i=>resolveModelForRow(state.design.parts[i],state.items[i],state.cadBindings[i]).binding.sizeMm),[[29,15.2,9],[29,15.2,9]]);
  const roundTrip=readHandoffBundle(JSON.stringify(createHandoffBundle(state)));
  assert.deepEqual(roundTrip.placements,state.placements);
  const other={...state.items,1:{...state.items[1],mpn:'another model'}};
  const existing=cleanPlacements(state.placements,state.design,other);
  assert.notEqual(existing[1].purchaseKey,bindingKeys(state.design.parts[1],other[1]).purchaseKey);
  assert.throws(()=>cleanPlacements([state.placements[0],state.placements[0]],state.design),/数量/);
  assert.throws(()=>cleanPlacements([{partIndex:1,positionMm:[1,2,NaN],rotationDeg:[0,0,0]}],state.design),/坐标/);
});
test('placed materials share one origin; rotate around X then Y then Z and translate in millimetres',()=>{
  const meshes=[{triangles:[[[10,5,2],[14,5,2],[10,9,2]]]},{triangles:[[[14,9,4],[14,9,2],[14,5,2]]]}];
  const moved=placeModelMeshes(meshes,{rotationDeg:[90,90,0],positionMm:[100,200,300]});
  const round=v=>v.map(x=>Math.round(x*1e8)/1e8);
  assert.deepEqual(round(moved[0].triangles[0][0]),[98,200,302]);
  assert.deepEqual(round(moved[1].triangles[0][0]),[102,198,298]);
  assert.deepEqual(meshes[0].triangles[0][0],[10,5,2]);
});
