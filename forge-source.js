import {validateCadPlan,wholePartBox} from './cad-plan.js';
import {getHardwareMetadata} from './assembly-hardware.js';
import {forgeNativeFeature} from './native-features.js';

const axisVectors = [[1,0,0], [0,1,0], [0,0,1]];
const nativeFiles=new Map([
  ['xiao-esp32s3',new URL('./assets/hardware/xiao-esp32s3/reference.forge.js',import.meta.url)],
  ['xiao-esp32c3',new URL('./assets/hardware/xiao-esp32c3/reference.forge.js',import.meta.url)]
]);
export const hasEditableCatalogSource=id=>nativeFiles.has(id);

// A row containing the housing and the rod of a single actuator is not two
// instances of that actuator. Only full-size anchors of complete copies qualify.
export function completeCatalogAnchors(bodies,parts){
  const anchors=bodies.map(wholePartBox),counts=new Map(),partial=new Set();
  bodies.forEach(({partIndex},i)=>{
    const size=parts[partIndex]?.sizeMm;
    counts.set(partIndex,(counts.get(partIndex)||0)+1);
    if(!size||!anchors[i]?.sizeMm.every((n,k)=>Math.abs(n-size[k])<=.01))partial.add(partIndex);
  });
  return bodies.map(({partIndex},i)=>!partial.has(partIndex)&&counts.get(partIndex)<=parts[partIndex]?.qty?anchors[i]:null);
}

function placeFeature(shape,feature){
  (feature.rotationDeg || []).forEach((degrees,i) => {
    if (degrees) shape += '.rotate('+JSON.stringify(axisVectors[i])+', '+degrees+')';
  });
  return shape+'.translate('+feature.centerMm.join(', ')+')';
}

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
  return placeFeature(shape,feature);
}

function bodyStatements(body,native) {
  if(native){
    const localShape='catalogBoard({number:defaultValue}, defaultValue).translate('+native.center.map(x=>-x).join(', ')+')';
    return [
      '// Embedded CC0-1.0 dimensional reference: '+native.id+' (millimetres).',
      '// All material groups are included in this editable assembly.',
      'function defaultValue(name, value) { return value; }',
      'function catalogBoard(Param, param) {',
      ...native.source.trimEnd().split('\n').map(line=>'  '+line),'}',
      'return '+placeFeature(localShape,native.anchor)+';'
    ];
  }
  const lines = [];
  if(wholePartBox(body))lines.push('// Placement envelope (mm); editable component geometry is not included for this part.');
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
  return assemblySource(validateCadPlan(raw,160),new Map());
}
function assemblySource(plan,natives) {
  if (!plan.bodies.length) throw Error('没有可以导出的 CAD 实体。');
  const lines = ['// Named assembly parts in millimetres, initially shown retracted.'];
  const motionByBody = new Map();
  if(plan.motions?.length)lines.push('const strokeParameter = typeof Param === "undefined" ? param : (...args) => Param.number(...args);');
  for (const [index,motion] of (plan.motions || []).entries()) {
    const label = JSON.stringify(`${index+1}. ${motion.name} (mm)`);
    lines.push(`const stroke${index} = strokeParameter(${label}, 0, {min:0,max:${motion.travelMm},unit:"mm"});`);
    for (const i of motion.movingBodyIndices) motionByBody.set(i,{index,axis:motion.axis});
  }
  const members = plan.bodies.map((body,i) => {
    lines.push('', `function buildPart${i}() {`, ...bodyStatements(body,natives.get(i)).map(s=>'  '+s), '}');
    const motion = motionByBody.get(i);
    const position = body.positionMm.map((p,k) => motion && motion.axis[k] ?
      `${p} + (${motion.axis[k]}) * stroke${motion.index}` : String(p));
    return `  { name: ${JSON.stringify(body.name)}, tags: ${JSON.stringify(body.role)}, shape: buildPart${i}().translate(${position.join(', ')}) }`;
  });
  lines.push('', 'return [', members.join(',\n'), '];', '');
  return lines.join('\n');
}

async function readNative(id){
  const response=await fetch(nativeFiles.get(id),{redirect:'error',mode:'same-origin'});
  if(!response.ok)throw Error('无法读取 '+id+' 的可编辑模型。请重试下载。');
  const source=await response.text();
  if(!source.includes('const groupId =')||!source.includes('return groupId==='))throw Error(id+' 的可编辑模型资源无效。');
  const {boundsMm:{min,max},sizeMm}=await getHardwareMetadata(id);
  return {id,source,sizeMm,center:min.map((n,k)=>(n+max[k])/2)};
}

// Source text comes only from the fixed assets above, never from a design/part.
export async function editableForgeSource(raw,parts,bodyIndex=null){
  const plan=validateCadPlan(raw,parts.length),anchors=completeCatalogAnchors(plan.bodies,parts);
  if(bodyIndex!==null&&(!Number.isInteger(bodyIndex)||!plan.bodies[bodyIndex]))throw Error('零件不存在。');
  const natives=new Map(),assets=new Map();
  for(const [i,body] of plan.bodies.entries()){
    if(bodyIndex!==null&&i!==bodyIndex)continue;
    const part=parts[body.partIndex],id=part.modelId,anchor=anchors[i];
    if(!anchor||part.modelSourceInvalidated||part.dimensionSource!=='catalog'||part.shape||part.role==='enclosure'||!nativeFiles.has(id))continue;
    if(!assets.has(id))assets.set(id,await readNative(id));
    const native=assets.get(id);
    if(native.sizeMm.every((n,k)=>Math.abs(n-part.sizeMm[k])<=.01))natives.set(i,{...native,anchor});
  }
  if(bodyIndex===null)return assemblySource(plan,natives);
  return ['// Local part coordinates, in millimetres.',...bodyStatements(plan.bodies[bodyIndex],natives.get(bodyIndex)),''].join('\n');
}
