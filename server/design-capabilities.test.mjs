import assert from 'node:assert/strict';
import test from 'node:test';
import {MAX_CAD_BODIES, MAX_CAD_FEATURES, validateCadPlan} from '../cad-plan.js';
import {cadBodyColor} from '../cad-plan.js';
import {capabilityPreflight, runtimeCapabilityEvidence} from './design-capabilities.mjs';

const feature = {shape:'box',op:'add',centerMm:[0,0,0],sizeMm:[3,4,5]};
const body = {name:'fixture',partIndex:0,role:'reference',positionMm:[0,0,0],features:[feature]};
const design = bodies => ({parts:[{name:'fixture'}],cadPlan:{version:1,bodies}});

test('required append operations distinguish an exhausted body budget from available feature capacity', () => {
  const candidate = design(Array.from({length:MAX_CAD_BODIES}, () => body));
  assert.doesNotThrow(() => validateCadPlan(candidate.cadPlan, 1));
  assert.equal(capabilityPreflight('cad.addBody', candidate).route, 'platform');
  assert.equal(capabilityPreflight('cad.addFeature', candidate).route, 'design');
  assert.equal(runtimeCapabilityEvidence(candidate).usage.features.remaining, MAX_CAD_FEATURES - MAX_CAD_BODIES);
  const addedBody = {...candidate.cadPlan,bodies:[...candidate.cadPlan.bodies,body]};
  assert.throws(() => validateCadPlan(addedBody, 1), /bodies/);
  const withFeature = {...candidate.cadPlan,bodies:candidate.cadPlan.bodies.with(0,{...body,features:[feature,feature]})};
  assert.doesNotThrow(() => validateCadPlan(withFeature, 1));
});

test('a split native mesh and body tint are valid inputs while a bitmap requires another representation', () => {
  const sourceBody = {...body, color:'#bb1245',sourceMeshes:{instanceIndex:0,meshIndices:[1],dimensionBasis:null}};
  const candidate = design([sourceBody]);
  assert.doesNotThrow(() => validateCadPlan(candidate.cadPlan, 1));
  assert.deepEqual(cadBodyColor(sourceBody), [187,18,69]);
  assert.equal(capabilityPreflight('cad.bodyColor',candidate).route,'design');
  assert.equal(capabilityPreflight('cad.nativeSubmeshBinding',candidate).route,'design');
  const withTexture = design([{...body,texture:'board.png'}]);
  assert.throws(() => validateCadPlan(withTexture.cadPlan, 1), /字段/);
  assert.equal(capabilityPreflight('cad.bitmapTexture',candidate).route,'platform');
});

test('unmeasured capacity and unknown capability requests stay unverified', () => {
  const candidate = {parts:[]};
  const {usage} = runtimeCapabilityEvidence(candidate);
  assert.equal(usage.bodies.remaining,null);
  assert.equal(usage.features.remaining,null);
  assert.equal(capabilityPreflight('cad.addBody',candidate).route,'evidence');
  assert.equal(capabilityPreflight('some.future.tool',candidate).route,'evidence');
  assert.equal(capabilityPreflight('viewer.jointHome',candidate).route,'evidence');
  assert.equal(capabilityPreflight('viewer.jointHome',{cadPlan:{joints:[{}]}}).route,'review');
  assert.equal(capabilityPreflight('viewer.jointJog',{cadPlan:{joints:[{}]}}).route,'review');
  assert.equal(capabilityPreflight('viewer.holdRelease',candidate).route,'evidence');
  assert.equal(capabilityPreflight('viewer.holdRelease',{interaction:{transitions:[{event:'drive.down'}]}}).route,'review');
});
