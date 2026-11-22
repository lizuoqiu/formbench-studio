// CAD body positions are translations. Rotations/offsets of features on a body
// have already been applied in the body-local terminal coordinates.
import {resolveAssemblyPinAnchor} from './assembly-pin-anchors.js';

export const wireColors=Object.freeze({signal:'#D99A27',power:'#D65A4B',ground:'#465564'});
const vec = p => Array.isArray(p) && p.length===3 && p.every(Number.isFinite);
const plus=(a,b)=>a.map((v,i)=>v+b[i]);
const minus=(a,b)=>a.map((v,i)=>v-b[i]);
const scaled=(a,k)=>a.map(v=>v*k);
const length=a=>Math.hypot(...a);
const unit=a=>scaled(a,1/length(a));
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const pinName=pin=>String(pin??'').normalize('NFKC').trim().toUpperCase();
const pinKey=(index,pin)=>JSON.stringify([index,pinName(pin)]);
const publicSource=url=>typeof url==='string' && /^https?:\/\//i.test(url)?url:'';

function endPoint(design,terminals,resolveAnchor,partIndex,pin) {
  const part=design.parts?.[partIndex];
  const unknown={partIndex,pin,partName:part?.name||'',bodyIndex:null,worldMm:null,quality:'unlocated',
    origin:'none',basis:'unknown',evidence:'缺少可对应此针脚的安装位置。',sourceUrl:''};
  if (!part || part.modelSourceInvalidated) return unknown;
  const terminal=terminals.get(pinKey(partIndex,pin));
  let anchor,origin;
  if (terminal) {
    origin='declared';
    if (!['geometry','datasheet','estimated'].includes(terminal.basis)) return {...unknown,origin,
      evidence:terminal.evidence||unknown.evidence,sourceUrl:publicSource(terminal.sourceUrl)};
    anchor={bodyIndex:terminal.bodyIndex,localMm:terminal.positionMm,
      kind:terminal.basis==='estimated'?'estimated':'modeled',evidence:terminal.evidence,sourceUrl:terminal.sourceUrl,
      featureIndex:terminal.featureIndex};
    // A saved local coordinate can name the exact same pad as the catalogue.
    // Preserve its physical lead-out direction when re-opening that design.
    const mapped=resolveAnchor(design,partIndex,pin);
    if (mapped?.bodyIndex===anchor.bodyIndex && vec(mapped.localMm) && vec(anchor.localMm) &&
        length(minus(mapped.localMm,anchor.localMm))<=.02) {
      anchor.exitDirection=mapped.exitDirection;
    }
  } else {
    origin='model-map';
    anchor=resolveAnchor(design,partIndex,pin);
  }
  const body=design.cadPlan?.bodies?.[anchor?.bodyIndex];
  if (!anchor || !Number.isInteger(anchor.bodyIndex) || body?.partIndex!==partIndex ||
      !vec(body.positionMm) || !vec(anchor.localMm) || !['modeled','estimated','connector'].includes(anchor.kind))
    return unknown;
  const exit=anchor.exitDirection;
  return {partIndex,pin,partName:part.name||'',bodyIndex:anchor.bodyIndex,
    worldMm:plus(anchor.localMm,body.positionMm),quality:anchor.kind,origin,
    basis:terminal?.basis||anchor.basis||(anchor.kind==='estimated'?'estimated':'geometry'),
    featureIndex:Number.isInteger(anchor.featureIndex)?anchor.featureIndex:null,
    exitDirection:vec(exit)&&length(exit)>.001?unit(exit):null,
    evidence:anchor.evidence||'',sourceUrl:publicSource(anchor.sourceUrl)};
}

function externalMate(design,cableEnd,socketEnd) {
  const cable=design.parts?.[cableEnd.partIndex],socket=design.parts?.[socketEnd.partIndex];
  if (!cable || !socket || cable.modelSourceInvalidated || socket.modelSourceInvalidated ||
      cable.placement!=='loose' || !design.cadPlan?.bodies?.some(b=>b.partIndex===socketEnd.partIndex) ||
      design.cadPlan.bodies.some(b=>b.partIndex===cableEnd.partIndex)) return false;
  const label=[cable.name,cable.model,cable.spec].join(' ');
  if (!/线缆|数据线|电源线|供电线|跳线|线束|连接线|cable|cord|harness/i.test(label)) return false;
  // A loose cable and a mounted connector mate at a receptacle. A generic
  // bundle of wire listed in the BOM does not imply such a connector.
  return socketEnd.quality==='connector' || (/USB/i.test(label) && /USB/i.test(socketEnd.pin));
}

// A proposed centreline only. It is not a collision-checked cable, bend radius
// or cutting length. The free span fans parallel conductors apart; terminals
// remain anchored exactly even where several wires share the same ground pad.
function routedPoints(from,to,lane) {
  const a=from.worldMm,b=to.worldMm,chord=minus(b,a),span=length(chord);
  const along=unit(chord);
  const side=unit(cross(along, Math.abs(along[2])<.9?[0,0,1]:[0,1,0]));
  const normal=unit(cross(side,along));
  const lead=Math.min(5,span*.17);
  const start=plus(a,scaled(from.exitDirection||along,lead));
  const end=plus(b,scaled(to.exitDirection||scaled(along,-1),lead));
  const bend=plus(scaled(side,Math.max(-span*.12,Math.min(span*.12,lane))),
    scaled(normal,Math.min(4,span*.075)));
  const count=Math.max(6,Math.min(24,Math.ceil(span/4)));
  const points=[a,start];
  for (let j=1;j<count;j++) {
    const t=j/count;
    points.push(plus(lerp(start,end,t),scaled(bend,Math.sin(Math.PI*t))));
  }
  return [...points,end,b];
}

export function buildAssemblyWiring(design,resolveAnchor=resolveAssemblyPinAnchor) {
  const routes=[],mates=[],unresolved=[],model=design?.interaction;
  if (!Array.isArray(model?.connections)) return {routes,mates,unresolved};
  const terminals=new Map((Array.isArray(model.terminals)?model.terminals:[]).map(t=>[pinKey(t.partIndex,t.pin),t]));
  const cached=new Map(),bundles=new Map();
  function endpoint(part,pin) {
    const key=pinKey(part,pin);
    if (!cached.has(key)) cached.set(key,endPoint(design,terminals,resolveAnchor,part,pin));
    return cached.get(key);
  }
  model.connections.forEach((connection,connectionIndex)=>{
    const w=connection;
    const from=endpoint(w.fromPartIndex,w.fromPin),to=endpoint(w.toPartIndex,w.toPin);
    const row={connectionIndex,kind:w.kind,color:wireColors[w.kind],from,to,points:[]};
    if (externalMate(design,from,to) || externalMate(design,to,from)) {
      mates.push({...row,quality:'connector',routing:'mate'});
    } else if (!from.worldMm || !to.worldMm || length(minus(from.worldMm,to.worldMm))<.001) {
      unresolved.push({...row,quality:'unlocated',routing:'unlocated'});
    } else {
      const key=[from.bodyIndex,to.bodyIndex].sort((a,b)=>a-b).join('/');
      if (!bundles.has(key)) bundles.set(key,[]);
      const route={...row,quality:from.quality==='modeled' && to.quality==='modeled'?'modeled':'estimated',routing:'illustrative'};
      bundles.get(key).push(route);
      routes.push(route);
    }
  });
  for (const bundle of bundles.values()) {
    bundle.forEach((wire,i)=>{
      // Keep the fan ordering consistent when a conductor runs back from the
      // load towards its source (e.g. separate signal and common conductors).
      const orientation=wire.from.bodyIndex<=wire.to.bodyIndex?1:-1;
      const lane=(i-(bundle.length-1)/2)*1.45*orientation;
      wire.points=routedPoints(wire.from,wire.to,lane);
    });
  }
  return {routes,mates,unresolved};
}
