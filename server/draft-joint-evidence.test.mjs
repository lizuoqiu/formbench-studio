import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDrawnJoint,inspectDrawnHome} from './draft-joint-evidence.mjs';

const joint={axis:[0,0,1],pivotMm:[10,20,30],movingBodyIndices:[1],fixedBodyIndex:0,parentIndex:null};
const fixed=[[0,0,0],[0,0,1]];

test('rotationally symmetric visible shapes can be observed by following vertex identities',()=>{
 const home={0:fixed,1:[[11,20,30],[10,21,30],[9,20,30],[10,19,30]]};
 // The ring occupies the same set of points, but each physical vertex moved.
 const posed={0:fixed,1:[[10,21,30],[9,20,30],[10,19,30],[11,20,30]]};
 const result=inspectDrawnJoint([joint],0,home,home,posed,[0],[90]);
 assert.equal(result.status,'passed');
 assert.ok(result.witness.displacementMm>1.4);
 assert.equal(inspectDrawnHome(home,posed,[result]).status,'failed');
 assert.equal(inspectDrawnHome(home,home,[result]).status,'passed');
});

test('a purely axial probe or an invisible fixed mount cannot verify the rendered joint',()=>{
 const home={0:fixed,1:[[10,20,29],[10,20,31]]};
 const axial=inspectDrawnJoint([joint],0,home,home,home,[0],[5]);
 assert.equal(axial.status,'not-exercised');
 assert.deepEqual(axial.insufficient,[1]);
 const missing=inspectDrawnJoint([joint],0,{1:home[1]},home,home,[0],[5]);
 assert.deepEqual(missing.missing,[0]);
 assert.equal(missing.fixedVerified,false);
 assert.equal(inspectDrawnHome(home,home,[axial]).status,'not-exercised');
});

test('a fixed housing that rotates with its output fails even when every moving probe is right',()=>{
 const home={0:[[11,20,30]],1:[[12,20,30]]},moved={0:[[10,21,30]],1:[[10,22,30]]};
 const result=inspectDrawnJoint([joint],0,home,home,moved,[0],[90]);
 assert.equal(result.status,'failed');assert.deepEqual(result.mismatched,[0]);assert.ok(result.maxStationaryDriftMm>1.4);
});
