import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {jointFrameConflicts, jointMesh, jointPoint, validateJoints} from '../assembly-joints.js';
import {editableForgeSource} from '../forge-source.js';

const bodies = [0, 1, 1, 2, 3].map(partIndex => ({partIndex}));
function joint(name, axis, pivotMm, fixedBodyIndex, movingBodyIndices, parentIndex = null) {
  return {name, axis, pivotMm, fixedBodyIndex, movingBodyIndices, parentIndex,
    actuatorPartIndex: 1, minDegrees: -90, maxDegrees: 90};
}
const chain = [
  joint('base', [0,0,1], [10,20,30], 0, [1,2,3]),
  joint('elbow', [0,1,0], [20,20,30], 1, [2,3], 0),
  joint('wrist', [1,0,0], [25,20,30], 2, [3], 1)
];
function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.hypot(...actual.map((v, i) => v - expected[i])) < tolerance,
    'actual=' + actual + ' expected=' + expected);
}

test('three world-home axes retain their offsets, parent frames, and rigid groups', () => {
  validateJoints({bodies, joints: chain});
  assert.deepEqual(jointFrameConflicts(chain), []);
  close(jointPoint([25,22,30], 3, chain, [90,90,90]), [10,32,25]);
  close(jointPoint([25,22,30], 3, chain, [90,0,0]), [8,35,30]);
  close(jointPoint([25,20,30], 2, chain, [90,90,90]), [10,30,25]);
  close(jointPoint([20,20,30], 1, chain, [90,90,90]), [10,30,30]);
  close(jointPoint([10,20,30], 0, chain, [90,90,90]), [10,20,30]);
  close(jointPoint([15,16,17], 4, chain, [90,90,90]), [15,16,17]);
});

test('an accepted rounded, oblique axis preserves length and respects asymmetric limits', () => {
  const axis = [0.71,0.71,0], joints = [{...chain[0], axis, minDegrees: -30, maxDegrees: 90}];
  validateJoints({bodies, joints});
  const pivot = joints[0].pivotMm;
  const point = [10,20,32], diagonal = Math.SQRT2;
  close(jointPoint(point, 1, joints, [200]), [10+diagonal,20-diagonal,30]);
  close(jointPoint(point, 1, joints, [-200]), [10-Math.SQRT1_2,20+Math.SQRT1_2,30+Math.sqrt(3)]);
  close(jointPoint(pivot, 1, joints, [90]), pivot);
  close(jointPoint(point, 1, joints, [NaN]), point);
  close(jointPoint(point, 1, joints, [Infinity]), point);
  close(jointPoint(point, 1, joints, []), point);
});

test('mesh offset and local vertices retain the same joint pose as world points and wire endpoints', () => {
  const offset = [25,20,30];
  const mesh = {points: [[0,2,0],[1,2,0]], indices: [0,1], projected: new Float64Array(6)};
  const posed = jointMesh(mesh, offset, 3, chain, [90,90,90]);
  close(posed.points[0].map((v,k) => v + offset[k]), [10,32,25]);
  close(posed.points[1].map((v,k) => v + offset[k]), [10,32,24]);
  assert.equal(posed.indices, mesh.indices);
  assert.deepEqual(mesh.points, [[0,2,0],[1,2,0]]);
  assert.equal(jointMesh(mesh, offset, 0, chain, [90,90,90]), mesh);
  assert.equal(jointMesh(mesh, offset, 3, chain, [0,0,0]), mesh);
});

test('fixed links may be shared by siblings but cannot be moved by an unrelated joint', () => {
  const left = joint('left', [0,0,1], [0,0,0], 0, [1]);
  const right = joint('right', [1,0,0], [0,1,0], 0, [2]);
  assert.deepEqual(jointFrameConflicts([left,right]), []);
  const dangling = {...right, fixedBodyIndex: 1};
  for (const joints of [[left,dangling],[dangling,left]]) {
    assert.doesNotThrow(() => validateJoints({bodies, joints}));
    const issues = jointFrameConflicts(joints);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /right.*#1.*left/);
  }
  const cyclic = [{...left, fixedBodyIndex: 2},dangling];
  assert.equal(jointFrameConflicts(cyclic).length, 2);
});

test('plans predating joint fields and math-only wire bindings still work', () => {
  assert.doesNotThrow(() => validateJoints({bodies}));
  assert.deepEqual(jointFrameConflicts(), []);
  const legacy = [{axis:[0,0,1],pivotMm:[10,20,30],movingBodyIndices:[1]}];
  close(jointPoint([11,20,30], 1, legacy, [180]), [9,20,30]);
  assert.throws(() => validateJoints({bodies, joints:[null]}), /关节 0/);
});

test('native ForgeCAD and the workbench agree on offset three-axis end-effector positions',
  {skip:process.env.FORGECAD_RESEARCH_AUTOMATION!=='true'||!process.env.FORGECAD_BIN}, async () => {
  const centers = [[10,20,30],[20,20,30],[25,20,30],[25,22,30]];
  const names = ['ground','upper','forearm','probe'];
  const bodies = centers.map((positionMm, partIndex) => ({name:names[partIndex], partIndex, role:'printed',
    positionMm, features:[{op:'add', shape:'box', sizeMm:[1,1,1], centerMm:[0,0,0]}]}));
  const source = await editableForgeSource({version:1, bodies, joints:chain}, bodies.map(() => ({qty:1, sizeMm:[1,1,1]})));
  const poses = [[90,0,0],[90,90,90],[-22,13,37]];
  const sample = `
    const positions = ${JSON.stringify(poses)}.map(function(a) {
      const model = mechanism.solve({"1. base":a[0], "2. elbow":a[1], "3. wrist":a[2]});
      const box = model.getPart("probe").boundingBox();
      return box.min.map((v, k) => (v + box.max[k]) / 2);
    });
    console.log("FK_PROBE=" + JSON.stringify(positions));
  `;
  const dir = await mkdtemp(join(tmpdir(), 'formwork-fk-'));
  try {
    const file = join(dir, 'three-axis.forge.js');
    await writeFile(file, source.replace('return mechanism.solve();', sample + '\nreturn mechanism.solve();'));
    await writeFile(join(dir, 'forgecad.json'), '{}');
    const {stdout} = await promisify(execFile)(process.env.FORGECAD_BIN, ['run',file], {timeout:30000});
    const native = JSON.parse(/FK_PROBE=(\[.*\])/.exec(stdout)[1]);
    poses.forEach((angles, i) => close(jointPoint(centers[3], 3, chain, angles), native[i]));
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});
