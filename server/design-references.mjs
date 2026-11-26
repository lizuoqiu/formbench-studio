import {wholePartBox,completeCatalogAnchors,featurePlacement} from '../cad-plan.js';
import {catalog,matchHardware} from '../assembly-hardware.js';
import xiaoC3 from '../assets/hardware/xiao-esp32c3/metadata.json' with {type:'json'};
import xiaoS3 from '../assets/hardware/xiao-esp32s3/metadata.json' with {type:'json'};
import pico from '../assets/hardware/pico/metadata.json' with {type:'json'};
import led from '../assets/hardware/led/metadata.json' with {type:'json'};
import button from '../assets/hardware/button/metadata.json' with {type:'json'};
import resistor from '../assets/hardware/resistor/metadata.json' with {type:'json'};
import screw from '../assets/hardware/screw/metadata.json' with {type:'json'};
import wire from '../assets/hardware/wire/metadata.json' with {type:'json'};
import cable from '../assets/hardware/usb-cable/metadata.json' with {type:'json'};
import buzzer from '../assets/hardware/buzzer/metadata.json' with {type:'json'};

// The door-contact kit contains two independently mounted housings in an illustrative pose.
// Only mountable single units and named illustrative accessories are advertised here.
const references={'xiao-esp32c3':xiaoC3,'xiao-esp32s3':xiaoS3,pico,'red-led':led,'green-led':led,button,resistor,screw,wire,'usb-cable':cable,buzzer};
export const referenceIds=Object.keys(references);
const boundsPair=box=>Array.isArray(box)?box:box?[box.min,box.max]:null;
export function resolvedCatalogGeometry(design){
 const bodies=design.cadPlan?.bodies||[],anchors=completeCatalogAnchors(bodies,design.parts,part=>references[part.modelId]);
 return anchors.flatMap((anchor,index)=>{
  if(!anchor)return [];
  const body=bodies[index],part=design.parts[body.partIndex],meta=references[part?.modelId];
  if(part?.dimensionSource!=='catalog'||part.modelSourceInvalidated||!meta)return [];
  const bounds=boundsPair(meta.boundsMm);
  if(!bounds||!part.sizeMm.every((d,i)=>Math.abs(bounds[1][i]-bounds[0][i]-d)<=.01))return [];
  const middle=bounds[0].map((n,i)=>(n+bounds[1][i])/2);
  const place=featurePlacement(anchor,middle),world=xyz=>place(xyz).map((n,i)=>+(n+body.positionMm[i]).toFixed(3));
  const worldOrigin=world(middle),axes=middle.map((_,axis)=>world(middle.map((n,i)=>n+Number(i===axis))).map((n,i)=>+(n-worldOrigin[i]).toFixed(3)));
  const meshes=meta.meshes.map(m=>{
   const b=boundsPair(m.boundsMm);
   if(!b)return {label:m.label};
   const corners=Array.from({length:8},(_,mask)=>world(b[0].map((_,i)=>b[(mask>>i)&1][i])));
   return {label:m.label,worldBoundsMm:[Math.min,Math.max].map(fn=>[0,1,2].map(i=>fn(...corners.map(c=>c[i]))))};
  });
  const interfaces=(meta.interfaces||[]).map(port=>({name:port.name,
   centerWorldMm:world(port.centerMm),outwardWorld:axes[0].map((_,i)=>+axes.reduce((v,axis,k)=>v+axis[i]*port.normal[k],0).toFixed(3)),
   openingMm:port.openingMm,evidence:port.evidence}));
  return [{partIndex:body.partIndex,bodyIndex:index,modelId:part.modelId,label:meta.label,kind:meta.modelType,
   sourceUrl:meta.measurementSourceUrl||meta.sourceUrl,description:meta.description,limitations:meta.limitations,datum:meta.datum||meta.origin,
   nativeAxesInWorld:axes,meshes,interfaces}];
 });
}
function outerSize(meta){
  if(meta.sizeMm)return meta.sizeMm;
  const [low,high]=meta.boundsMm;
  return high.map((n,i)=>Number((n-low[i]).toFixed(3)));
}
export const catalogInstructions=referenceIds.map(id=>{
  const meta=references[id],size=outerSize(meta);
  const pose=meta.datum||meta.origin;
  return id+'='+meta.label+'，展示几何全长 XYZ '+size.join('×')+' mm；'+catalog[id].description+
    (pose&&['pico','xiao-esp32c3','xiao-esp32s3'].includes(id)?' 局部方向：'+pose:'');
}).join('\n');

const headerless=/(?:无|不带|未焊|未预焊|未装)(?:接)?排针|headerless|without (?:pin )?headers?|no headers?/i;
function exactDesignId(p){
  if(p.role==='enclosure'||p.dimensionSource==='specified'||p.modelSourceInvalidated)return null;
  const identity=(p.name+' '+p.model).normalize('NFKC');
  if(/支架|外壳|转接板|扩展底板|配套线束|适配器|adapter|enclosure|carrier|holder/i.test(identity))return null;
  const properties=(identity+' '+p.spec).normalize('NFKC');
  if(/兼容板|转接板|扩展底板|breakout carrier|\bclone\b/i.test(properties))return null;
  if(/\bDFR0032\b/i.test(identity)){
    return /无源|裸蜂鸣器|passive buzzer|\bKY[- ]?012\b/i.test(properties)?null:'buzzer';
  }
  let name=p.name;
  if(/(?:Seeed|矽递)/i.test(identity)&&/\b113991114\b/.test(identity)){
    // Seeed's 113991114 is the basic ESP32S3 board; 113991115 is Sense.
    name='Seeed Studio XIAO ESP32S3 '+name;
  }
  if(/XIAO[\s_-]*ESP32[\s_-]*S3/i.test(identity)&&/\b113991115\b/.test(identity))return null;
  if(/\bRaspberry\s*Pi\s+Pico\b/i.test(identity))name='Raspberry Pi Pico';
  if(/SW_PUSH_6mm_H4[.]3mm/i.test(p.model))name='轻触开关';
  if(/DIN\s*0207/i.test(properties)&&/电阻|resistor/i.test(identity))name='电阻';
  if(/LED_D5[.]0mm/i.test(p.model)){
    const red=/红色?|\bred\b/i.test(identity),green=/绿色?|\bgreen\b/i.test(identity);
    if(red!==green)name=red?'红色 LED':'绿色 LED';
  }
  const id=matchHardware({...p,name,spec:properties.replace(headerless,' headerless ')});
  if(id==='pico'){
    if(!headerless.test(properties)||/无线|wireless|Pico\s*(?:2|W|H|Plus)\b|预焊版|\bwith (?:pin )?headers?/i.test(properties.replace(headerless,'')))return null;
    if(!/RP2040|Pico\s*R3/i.test(properties)||!/micro[- ]?(?:usb|b)\b/i.test(properties))return null;
  }
  if((id==='red-led'||id==='green-led')&&/RGB|双色|共阳|共阴|三脚|四脚/i.test(properties))return null;
  if(id==='button'&&!/SW_PUSH_6mm_H4[.]3mm|6\s*[×x*]\s*6\s*[×x*]\s*4[.]3\s*(?:mm|毫米)|6\s*[×x*]\s*6\s*(?:mm|毫米)[^。;；]{0,18}4[.]3\s*(?:mm|毫米)/i.test(properties))return null;
  if(id==='screw'&&(!/M2\s*[×x*]\s*6(?![.\d])/i.test(properties)||!/内六角.*圆柱头|圆柱头.*内六角|socket.head.cap/i.test(properties)))return null;
  if(id==='wire'&&!/22\s*AWG|AWG\s*22/i.test(properties))return null;
  if(id==='resistor'&&!/DIN\s*0207/i.test(properties))return null;
  if(id==='usb-cable'&&!/USB[- ]?A|Type[- ]?A/i.test(properties))return null;
  if(id==='buzzer')return null;
  if((id==='wire'||id==='usb-cable')&&!p.modelId)return null;
  return id;
}

export function designReference(p){
  const id=exactDesignId(p);
  // An empty suggestion may be recovered from a specific identity. Disagreement remains unresolved.
  if(!id||!Object.hasOwn(references,id)||(p.modelId&&p.modelId!==id))return null;
  const meta=references[id];
  const approximation=meta.modelType==='dimensioned-approximation'?' '+meta.description:'';
  return {modelId:id,sizeMm:outerSize(meta),dimensionSource:'catalog',
    dimensionNote:'目录参考模型外廓：'+meta.label+'；'+approximation+' 不代表已核对购买规格。',
    dimensionSourceUrl:meta.measurementSourceUrl||meta.sourceUrl};
}


const sameSize=(a,b)=>a.every((n,i)=>n===b[i]);
function keepsNativeAxes(estimate,native){
 // A swap improves the match if the order reverses. Tied estimated lengths
 // cannot identify two distinct native axes. Never guess the connector direction.
 for(const [i,j] of [[0,1],[0,2],[1,2]]){
  if(native[i]!==native[j]&&(estimate[i]-estimate[j])*(native[i]-native[j])<=0)return false;
 }
 return true;
}

export function alignCatalogAnchors(plan,rawParts,parts){
 const byPart=new Map(),adjusted=new Map();
 for(const body of plan.bodies){
  if(!byPart.has(body.partIndex))byPart.set(body.partIndex,[]);
  byPart.get(body.partIndex).push(body);
 }
 for(const [index,bodies] of byPart){
  const part=parts[index],original=rawParts[index];
  if(part.dimensionSource!=='catalog'||original.dimensionSource==='specified'||part.placement==='loose'||
     ['wire','usb-cable'].includes(part.modelId)||bodies.length>part.qty||bodies.some(b=>b.sourceMeshes))continue;
  const native=part.sizeMm,estimate=original.sizeMm;
  if(sameSize(estimate,native)||!keepsNativeAxes(estimate,native))continue;
  const anchors=bodies.map(wholePartBox);
  if(!anchors.every(box=>box&&(sameSize(box.sizeMm,estimate)||sameSize(box.sizeMm,native))))continue;
  bodies.forEach((body,i)=>{
   if(sameSize(anchors[i].sizeMm,estimate))adjusted.set(body,{...body,features:[{...anchors[i],sizeMm:[...native]}]});
  });
 }
 return adjusted.size?{...plan,bodies:plan.bodies.map(body=>adjusted.get(body)||body)}:plan;
}
