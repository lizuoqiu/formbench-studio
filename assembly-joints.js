const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export function validateJoints(plan){
  const {joints=[],bodies}=plan;
  if(!Array.isArray(joints)||joints.length>12)throw Error('旋转关节最多 12 个。');
  for(const [i,joint]of joints.entries()){
    if(!joint||typeof joint!=='object')throw Error('关节 '+i+' 缺少关节定义。');
    const {name,axis,pivotMm,minDegrees,maxDegrees,movingBodyIndices,fixedBodyIndex,actuatorPartIndex,parentIndex}=joint;
    if(typeof name!=='string'||!name.trim()||name.length>200||!vector(axis)||Math.abs(Math.hypot(...axis)-1)>.005||!vector(pivotMm)||
      !Number.isFinite(minDegrees)||!Number.isFinite(maxDegrees)||minDegrees>0||maxDegrees<0||minDegrees>=maxDegrees||minDegrees< -360||maxDegrees>360)
      throw Error('关节 '+i+' 的轴线、原点或角度范围无效。');
    if(!Number.isInteger(fixedBodyIndex)||!bodies[fixedBodyIndex]||!Number.isInteger(actuatorPartIndex)||!bodies.some(b=>b.partIndex===actuatorPartIndex)||
      !Array.isArray(movingBodyIndices)||!movingBodyIndices.length||new Set(movingBodyIndices).size!==movingBodyIndices.length||
      !movingBodyIndices.every(n=>Number.isInteger(n)&&bodies[n]&&n!==fixedBodyIndex))throw Error(name+' 需要真实的驱动、固定件和随动件。');
    if(parentIndex!==null&&(!Number.isInteger(parentIndex)||parentIndex<0||parentIndex>=i||!movingBodyIndices.every(n=>joints[parentIndex].movingBodyIndices.includes(n))||!joints[parentIndex].movingBodyIndices.includes(fixedBodyIndex)))
      throw Error(name+' 的父关节须位于前面，并带动此关节的定件和全部动件。');
    for(let k=0;k<i;k++)if(joints[k].movingBodyIndices.some(n=>movingBodyIndices.includes(n))){
      let parent=parentIndex;
      while(parent!==null&&parent!==k)parent=joints[parent].parentIndex;
      if(parent!==k)throw Error(name+' 与非父关节重复驱动同一实体。');
    }
  }
}

// The file format predates this design check. Older drafts can still open;
// review reports every incompatible mount before attempting a motion sweep.
export function jointFrameConflicts(joints = []) {
  const issues = [];
  for (const joint of joints) {
    const ancestors = new Set();
    for (let parent = joint.parentIndex; parent != null; parent = joints[parent].parentIndex) {
      ancestors.add(parent);
    }
    for (const [otherIndex, other] of joints.entries()) {
      if (!ancestors.has(otherIndex) && other.movingBodyIndices.includes(joint.fixedBodyIndex)) {
        issues.push('关节「' + joint.name + '」的固定实体 #' + joint.fixedBodyIndex +
          ' 随非祖先关节「' + other.name + '」运动。请校正父链、固定实体或随动实体索引。');
      }
    }
  }
  return issues;
}

function bodyRotations(bodyIndex, joints, values) {
  const rotations = [];
  // Pivots and axes use assembly coordinates in the home pose. Applying the
  // child first lets the ancestor carry its pivot, axis, and the whole link.
  for (let i = joints.length - 1; i >= 0; i--) {
    const joint = joints[i];
    if (!joint.movingBodyIndices.includes(bodyIndex)) continue;
    const input = values?.[i];
    if (!Number.isFinite(input) || input === 0) continue;
    const degrees = Math.min(joint.maxDegrees ?? Infinity, Math.max(joint.minDegrees ?? -Infinity, input));
    if (degrees === 0) continue;
    const length = Math.hypot(...joint.axis);
    const [x, y, z] = joint.axis.map(value => value / length);
    const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
    rotations.push({pivot: joint.pivotMm, matrix: [
      c + x*x*t, x*y*t - z*s, x*z*t + y*s,
      y*x*t + z*s, c + y*y*t, y*z*t - x*s,
      z*x*t - y*s, z*y*t + x*s, c + z*z*t
    ]});
  }
  return rotations;
}

function rotatePoint(point, rotations) {
  let result = point;
  for (const {pivot, matrix: m} of rotations) {
    const x = result[0] - pivot[0], y = result[1] - pivot[1], z = result[2] - pivot[2];
    result = [pivot[0] + m[0]*x + m[1]*y + m[2]*z,
      pivot[1] + m[3]*x + m[4]*y + m[5]*z,
      pivot[2] + m[6]*x + m[7]*y + m[8]*z];
  }
  return result;
}

export function jointPoint(point, bodyIndex, joints, values) {
  return rotatePoint(point, bodyRotations(bodyIndex, joints, values));
}

export function jointMesh(mesh, offset, bodyIndex, joints, values) {
  const rotations = bodyRotations(bodyIndex, joints, values);
  if (!rotations.length) return mesh;
  const points = mesh.points.map(point => {
    const world = point.map((v, k) => v + offset[k]);
    return rotatePoint(world, rotations).map((v, k) => v - offset[k]);
  });
  return {...mesh, points, projected: new Float64Array(points.length * 3)};
}
