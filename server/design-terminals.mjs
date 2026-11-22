import {connectedTerminalPins} from '../interaction-model.js';
import {resolveAssemblyPinAnchor} from '../assembly-pin-anchors.js';

const key=(part,pin)=>JSON.stringify([part,String(pin).trim().toUpperCase()]);
const url=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
function supportsPinLocation(part,terminal){
 const doc=part?.geometryReference;
 if(!doc||!url(terminal.sourceUrl)||url(doc.sourceUrl)!==url(terminal.sourceUrl)||!doc.sourceQuote)return false;
 const quote=doc.sourceQuote.normalize('NFKC').toUpperCase(),pin=terminal.pin.trim().toUpperCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 if(!new RegExp('(?:^|[^A-Z0-9])'+pin+'(?:$|[^A-Z0-9])').test(quote)||
   !/(?:\bMM\b|毫米)/.test(quote)||!Array.isArray(terminal.positionMm)||terminal.positionMm.length!==3)return false;
 // Only accept coordinates that can be read directly in the local datum. A
 // package pitch, pinout or dimensioned envelope alone cannot locate a pad.
 return ['X','Y','Z'].every((axis,i)=>{
  const match=quote.match(new RegExp('(?:^|[^A-Z0-9])'+axis+'\\s*[=:]?\\s*([+−-]?\\d+(?:\\.\\d+)?)'));
  return match&&Math.abs(Number(match[1].replace('−','-'))-terminal.positionMm[i])<.005;
 });
}
function fromAnchor(partIndex,pin,anchor){
 return {partIndex,pin,bodyIndex:anchor.bodyIndex,positionMm:anchor.localMm,
  basis:anchor.kind==='modeled'?'geometry':'estimated',featureIndex:anchor.featureIndex??null,
  evidence:anchor.evidence,sourceUrl:url(anchor.sourceUrl)};
}
function unknown(partIndex,pin){
 return {partIndex,pin,bodyIndex:null,positionMm:null,basis:'unknown',featureIndex:null,
  evidence:'当前型号和 CAD 未提供可定位到该针脚的位置。',sourceUrl:''};
}
export function locateDesignTerminals(raw,design){
 if(!raw||!Array.isArray(raw.connections)||(raw.terminals!=null&&!Array.isArray(raw.terminals)))return raw;
 const needed=connectedTerminalPins(raw.connections);
 // A generated static or purely mechanical model has no electrical endpoints.
 if(!needed.size)return raw;
 const declared=raw.terminals||[],seen=new Set(),rows=[];
 for(const terminal of declared){
  if(!terminal||typeof terminal.pin!=='string'){rows.push(terminal);continue;}
  const id=key(terminal.partIndex,terminal.pin);seen.add(id);
  const verified=needed.has(id)?resolveAssemblyPinAnchor(design,terminal.partIndex,terminal.pin):null;
  if(verified&&(verified.kind==='modeled'||terminal.basis==='unknown')){
   rows.push(fromAnchor(terminal.partIndex,terminal.pin,verified));continue;
  }
  if((terminal.basis==='datasheet'&&!supportsPinLocation(design.parts[terminal.partIndex],terminal))||
     (terminal.basis==='geometry'&&terminal.featureIndex===null)){
   rows.push({...terminal,basis:'estimated',sourceUrl:'',evidence:'该位置按设计估算；现有资料没有独立确认此针脚在该装配中的坐标。'});continue;
  }
  rows.push(terminal);
 }
 for(const [id,{partIndex,pin}] of needed){
  if(seen.has(id))continue;
  const anchor=resolveAssemblyPinAnchor(design,partIndex,pin);
  rows.push(anchor?fromAnchor(partIndex,pin,anchor):unknown(partIndex,pin));
 }
 return {...raw,terminals:rows};
}
export function terminalReview(model){
 const terminals=model?.terminals||[],connections=model?.connections||[];
 const coverage={geometry:0,datasheet:0,estimated:0,unknown:0},positions=new Map();
 for(const t of terminals){if(!t||!Object.hasOwn(coverage,t.basis))continue;coverage[t.basis]++;positions.set(key(t.partIndex,t.pin),t);}
 let bothPositioned=0,bothSupported=0;
 for(const edge of connections){
  const pair=[positions.get(key(edge.fromPartIndex,edge.fromPin)),positions.get(key(edge.toPartIndex,edge.toPin))];
  if(pair.every(t=>Array.isArray(t?.positionMm))){bothPositioned++;if(pair.every(t=>['geometry','datasheet'].includes(t.basis)))bothSupported++;}
 }
 return {scope:'terminal-locations',status:!connections.length?'not-applicable':bothSupported===connections.length?'located':'partial',
  terminals:terminals.length,connections:connections.length,bothPositioned,bothSupported,coverage};
}
