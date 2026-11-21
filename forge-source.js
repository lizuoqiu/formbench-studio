import {validateCadPlan} from './cad-plan.js';
import {forgeNativeFeature} from './native-features.js';

const axisVectors = [[1,0,0], [0,1,0], [0,0,1]];

// Only validated numbers and fixed CAD operations become executable expressions.
function featureExpression(feature) {
  const [x,y,z] = feature.sizeMm;
  let shape = forgeNativeFeature(feature);
  if (!shape) switch (feature.shape) {
    case 'ellipsoid':
      shape = `sphere(1, 48).scale(${JSON.stringify([x/2,y/2,z/2])})`;
      break;
    case 'cylinder':
      shape = `cylinder(${z}, ${x/2}, ${x/2}, 64).translate(0, 0, ${-z/2})`;
      break;
    case 'box':
      shape = `box(${x}, ${y}, ${z}).translate(0, 0, ${-z/2})`;
      break;
  }
  (feature.rotationDeg || []).forEach((degrees,i) => {
    if (degrees) shape += `.rotate(${JSON.stringify(axisVectors[i])}, ${degrees})`;
  });
  return `${shape}.translate(${feature.centerMm.join(', ')})`;
}

function bodyStatements(body) {
  const lines = [];
  body.features.forEach((feature,i) => {
    lines.push(`const feature${i} = ${featureExpression(feature)};`);
    lines.push(i === 0 ? 'let body = feature0;' :
      `body = ${feature.op === 'cut' ? 'difference' : 'union'}(body, feature${i});`);
  });
  lines.push('return body;');
  return lines;
}

export function cadBodyToForgeScript(body) {
  validateCadPlan({version:1,bodies:[body]},160);
  return ['// Local part coordinates, in millimetres.', ...bodyStatements(body), ''].join('\n');
}

export function cadPlanToForgeScript(raw) {
  const plan = validateCadPlan(raw,160);
  if (!plan.bodies.length) throw Error('没有可以导出的 CAD 实体。');
  const lines = ['// Named assembly parts in millimetres, initially shown retracted.'];
  const motionByBody = new Map();
  for (const [index,motion] of (plan.motions || []).entries()) {
    const label = JSON.stringify(`${index+1}. ${motion.name} (mm)`);
    lines.push(`const stroke${index} = Param.number(${label}, 0, {min:0,max:${motion.travelMm},unit:"mm"});`);
    for (const i of motion.movingBodyIndices) motionByBody.set(i,{index,axis:motion.axis});
  }
  const members = plan.bodies.map((body,i) => {
    lines.push('', `function buildPart${i}() {`, ...bodyStatements(body).map(s=>'  '+s), '}');
    const motion = motionByBody.get(i);
    const position = body.positionMm.map((p,k) => motion && motion.axis[k] ?
      `${p} + (${motion.axis[k]}) * stroke${motion.index}` : String(p));
    return `  { name: ${JSON.stringify(body.name)}, tags: ${JSON.stringify(body.role)}, shape: buildPart${i}().translate(${position.join(', ')}) }`;
  });
  lines.push('', 'return [', members.join(',\n'), '];', '');
  return lines.join('\n');
}
