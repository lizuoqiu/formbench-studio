import {validateCadPlan,wholePartBox,completeCatalogAnchors} from './cad-plan.js';
import {getHardwareMetadata} from './assembly-hardware.js';
import {matchOled938Reference,oled938Id} from './panel-hardware-reference.js';
import {forgeNativeFeature} from './native-features.js';
import {forgeJointAssembly,forgeWiring,forgeWireShape,referenceWireBuilder} from './forge-joints.js';
import {encoderElectricalPins} from './purchased-body-details.js';

const axisVectors = [[1,0,0], [0,1,0], [0,0,1]];
const nativeFiles=new Map([
  ['xiao-esp32s3',new URL('./assets/hardware/xiao-esp32s3/reference.forge.js',import.meta.url)],
  ['xiao-esp32c3',new URL('./assets/hardware/xiao-esp32c3/reference.forge.js',import.meta.url)]
]);
export const hasEditableCatalogSource=id=>nativeFiles.has(id);

export {completeCatalogAnchors} from './cad-plan.js';

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

function bodyStatements(body,native,part) {
  if(native?.standaloneApproximation)return [
    '// Standalone design approximation. The full assembly package carries the supplier geometry and material meshes.',
    ...bodyStatements(body,null,part)
  ];
  if(native){
    const lines=native.external?[
      '// Adafruit source STEP and matching display meshes are bundled with their licenses.',
      '// Meshes preserve this assembly’s material groups, including EAGLE-derived plated rings.'
    ]:[
      '// Embedded CC0-1.0 dimensional reference: '+native.id+' (millimetres).',
      'function catalogBoard(Param, param) {',
      ...native.source.trimEnd().split('\n').map(line=>'  '+line),'}'
    ];
    const layers=native.layers.map((mesh,k)=>{
      const shape=native.external?'importMesh('+JSON.stringify('./assets/hardware/'+native.id+'/'+mesh.file)+')':
        'catalogBoard({number:()=>'+(k+1)+'}, ()=>'+(k+1)+')';
      const hex='#'+mesh.color.map(v=>v.toString(16).padStart(2,'0')).join('');
      return '  {name:'+JSON.stringify(mesh.label)+', shape:'+shape+'.color('+JSON.stringify(hex)+')}';
    });
    lines.push('const materials = group(',layers.join(',\n'),');');
    const localShape='materials.translate('+native.center.map(x=>-x).join(', ')+')';
    lines.push('return '+placeFeature(localShape,native.anchor)+';');
    return lines;
  }
  const lines = [];
  if(wholePartBox(body))lines.push('// Placement envelope (mm); editable component geometry is not included for this part.');
  body.features.forEach((feature,i) => {
    lines.push(`const feature${i} = ${featureExpression(feature)};`);
    lines.push(i === 0 ? 'let body = feature0;' :
      `body = ${feature.op === 'cut' ? 'difference' : 'union'}(body, feature${i});`);
  });
  const pins=encoderElectricalPins(body,part).filter(pin=>pin.supplemental);
  if(pins.length){
    lines.push('// Five electrical terminals reconstructed from the Bourns PEC11 drawing.',
      '// '+pins[0].sourceUrl,'return group(', '  {name:"固定座与机械焊耳", shape:body},');
    lines.push(pins.map(pin=>'  {name:'+JSON.stringify(pin.name+' 电气脚')+', shape:'+
      featureExpression(pin.feature)+'.color("#BEBAB0")}').join(',\n'),');');
  }else lines.push('return body;');
  return lines;
}

export function cadBodyToForgeScript(body) {
  validateCadPlan({version:1,bodies:[body]},160);
  return ['// Local part coordinates, in millimetres.', ...bodyStatements(body), ''].join('\n');
}

export function cadPlanToForgeScript(raw,interaction=null,wiring=null) {
  return assemblySource(validateCadPlan(raw,160),new Map(),interaction,wiring);
}
function assemblySource(plan,natives,interaction,wiring,parts=[]) {
  if (!plan.bodies.length) throw Error('没有可以导出的 CAD 实体。');
  const lines = ['// Named assembly parts in millimetres, initially shown retracted.'];
  const members = plan.bodies.map((body,i) => {
    lines.push('', `function buildPart${i}() {`, ...bodyStatements(body,natives.get(i),parts[body.partIndex]).map(s=>'  '+s), '}');
    return `  { name: ${JSON.stringify(body.name)}, tags: ${JSON.stringify(body.role)}, shape: buildPart${i}().translate(${body.positionMm.join(', ')}) }`;
  });
  const wires=forgeWiring(plan,wiring);
  if(wires.length)lines.push('',...referenceWireBuilder);
  const mechanism=forgeJointAssembly(plan,interaction,wires);
  if(!mechanism)for(const wire of wires)members.push('  { name: '+JSON.stringify(wire.name)+', tags: "reference", shape: '+forgeWireShape(wire)+' }');
  lines.push('', ...(mechanism || ['return [', members.join(',\n'), '];']), '');
  return lines.join('\n');
}

async function readNative(id){
  const response=await fetch(nativeFiles.get(id),{redirect:'error',mode:'same-origin'});
  if(!response.ok)throw Error('无法读取 '+id+' 的可编辑模型。请重试下载。');
  const source=await response.text();
  if(!source.includes('const groupId =')||!source.includes('return groupId==='))throw Error(id+' 的可编辑模型资源无效。');
  const {boundsMm:{min,max},sizeMm,meshes}=await getHardwareMetadata(id);
  return {id,source,sizeMm,layers:meshes,center:min.map((n,k)=>(n+max[k])/2)};
}

// Source text comes only from the fixed assets above, never from a design/part.
export async function editableForgeSource(raw,parts,bodyIndex=null,interaction=null,wiring=null,{externalAssets}={}){
  const plan=validateCadPlan(raw,parts.length);
  if(bodyIndex!==null&&(!Number.isInteger(bodyIndex)||!plan.bodies[bodyIndex]))throw Error('零件不存在。');
  const metadata=new Map();
  const candidates=plan.bodies.filter((b,i)=>(bodyIndex===null||bodyIndex===i)&&b.role==='reference'&&b.features.length>1)
    .map(b=>parts[b.partIndex]).map(p=>matchOled938Reference(p)||(!p.modelSourceInvalidated&&p.dimensionSource==='catalog'&&nativeFiles.has(p.modelId)?p.modelId:null));
  await Promise.all([...new Set(candidates.filter(Boolean))].map(async id=>{
    try{metadata.set(id,await getHardwareMetadata(id))}catch{/* Keep the authored features if registration is unavailable. */}
  }));
  const anchors=completeCatalogAnchors(plan.bodies,parts,p=>metadata.get(p.modelId||matchOled938Reference(p)));
  const natives=new Map(),assets=new Map();
  for(const [i,body] of plan.bodies.entries()){
    if(bodyIndex!==null&&i!==bodyIndex)continue;
    const part=parts[body.partIndex],id=part.modelId,anchor=anchors[i];
    if(anchor?.catalogId===oled938Id){
      if(!externalAssets){natives.set(i,{standaloneApproximation:true});continue;}
      const meta=metadata.get(oled938Id),{min,max}=meta.boundsMm;
      natives.set(i,{id:oled938Id,external:true,anchor,layers:meta.meshes,center:min.map((n,k)=>(n+max[k])/2)});
      if(!externalAssets.some(a=>a.id===oled938Id))externalAssets.push({id:oled938Id,stepFile:meta.stepFile,
        files:[...meta.meshes.map(m=>m.file),meta.stepFile,'reference.forge.js','metadata.json','NOTICE.txt','LICENSE-MIT.txt','LICENSE-CC-BY-SA-3.0.txt']});
      continue;
    }
    if(!anchor||part.modelSourceInvalidated||part.dimensionSource!=='catalog'||part.shape||part.role==='enclosure'||!nativeFiles.has(id))continue;
    if(!assets.has(id))assets.set(id,await readNative(id));
    const native=assets.get(id);
    if(native.sizeMm.every((n,k)=>Math.abs(n-part.sizeMm[k])<=.01))natives.set(i,{...native,anchor});
  }
  if(bodyIndex===null)return assemblySource(plan,natives,interaction,wiring,parts);
  const body=plan.bodies[bodyIndex];
  return ['// Local part coordinates, in millimetres.',...bodyStatements(body,natives.get(bodyIndex),parts[body.partIndex]),''].join('\n');
}
