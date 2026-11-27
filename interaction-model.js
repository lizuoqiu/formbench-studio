// Unmodified @xstate/fsm 2.1.0 ESM distribution; its MIT license ships alongside it.
import {createMachine} from './assets/xstate-fsm/xstate-fsm-2.1.0.js';
import {resolveAssemblyPinAnchor} from './assembly-pin-anchors.js';
import {factoryInterfaces} from './part-records.js';

// The same bounded format drives design review and the interactive CAD view.
// All part/body references are zero-based. Axes and pivots use assembly coordinates.
const obj = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const arr = items => ({type:'array', items});
const choice = (...values) => ({type:'string', enum:values});
const number = {type:'number'}, integer = {type:'integer'}, str = {type:'string'};
const nullable = spec => ({anyOf:[spec, {type:'null'}]});
export const MAX_INTERACTION_CONNECTIONS=224;
const interactionListLimits={
  'interaction.connections':MAX_INTERACTION_CONNECTIONS,
  'interaction.terminals':2*MAX_INTERACTION_CONNECTIONS,
  'interaction.transitions':512
};
const spec = obj({
  version:{type:'integer', enum:[1]}, controllerPartIndex:nullable(integer),
  controls:arr(obj({id:str,label:str,kind:choice('turn','press','slide','touch','command'),partIndex:integer,
    fixedBodyIndex:nullable(integer),movingBodyIndices:arr(integer),axis:arr(number),pivotMm:arr(number),
    step:number,range:nullable(obj({min:number,max:number,initial:number})),signalPins:arr(str)})),
  outputs:arr(obj({id:str,label:str,kind:choice('display','web','light','motion','sound'),partIndex:integer,
    bodyIndices:arr(integer),signalPin:str,motion:nullable(obj({type:choice('joint','linear'),index:integer,speed:number}))})),
  connections:arr(obj({kind:choice('signal','power','ground'),fromPartIndex:integer,fromPin:str,
    toPartIndex:integer,toPin:str,bidirectional:{type:'boolean'}})),
  terminals:arr(obj({partIndex:integer,pin:str,bodyIndex:nullable(integer),positionMm:nullable(arr(number)),
    basis:choice('geometry','datasheet','estimated','unknown'),featureIndex:nullable(integer),evidence:str,sourceUrl:str})),
  signalChannels:arr(obj({partIndex:integer,model:str,inputPin:str,outputPin:str,sourceUrl:str,evidence:str})),
  systemEvents:arr(obj({id:str,label:str,kind:choice('connection','timeout','fault','feedback'),partIndex:integer,
    sourcePins:arr(str),condition:str,delayMs:nullable(number)})),
  timer:nullable(obj({initialSeconds:integer,minSeconds:integer,maxSeconds:integer,stepSeconds:integer})),
  recorder:nullable(obj({displayId:str,captureStates:arr(str),reviewStates:arr(str),sampleEvents:arr(str)})),
  initialState:str,
  states:arr(obj({id:str,label:str,clock:choice('hold','run'),
    outputs:arr(obj({outputId:str,mode:choice('off','on','breathe','remaining','value','forward','reverse')}))})),
  transitions:arr(obj({from:str,event:str,to:str,effect:choice('none','adjust','restart','reset')}))
});
export const interactionSchema = nullable(spec);
const spatial = spec.properties;
const fields=(record,keys)=>Object.fromEntries(keys.map(k=>[k,record.properties[k]]));
const geometrySpec=obj({...fields(spec,['version','controllerPartIndex']),
  controls:arr(obj(fields(spatial.controls.items,['id','label','kind','partIndex','fixedBodyIndex','movingBodyIndices','axis','pivotMm','step','range']))),
  outputs:arr(obj(fields(spatial.outputs.items,['id','label','kind','partIndex','bodyIndices','motion'])))});
const withMotionDefaults=model=>({...model,controls:model.controls?.map(c=>({range:null,...c})),outputs:model.outputs?.map(o=>({motion:null,...o}))});
const withConnectionDefaults=connections=>Array.isArray(connections)
  ?connections.map(w=>w?{bidirectional:false,...w}:w):connections;
export function controlEvent(model,eventId){
  const direct=model.controls.find(c=>c.id===eventId);
  if(direct)return {control:direct,phase:null};
  for(const control of model.controls)for(const phase of control.kind==='turn'?['increase','decrease']:['press','touch','command'].includes(control.kind)?['down','up','cancel']:[])
    if(eventId===control.id+'.'+phase)return {control,phase};
  return null;
}
export function usesHeldEvents(model,control){return ['press','touch','command'].includes(control.kind)&&model.transitions.some(t=>t.event===control.id+'.down');}

function check(ok, message) {
  if (!ok) throw new Error('交互设计：' + message);
}
function structure(value, schema, path, allowOtherFields=false) {
  if (schema.anyOf) {
    if (value !== null) structure(value, schema.anyOf[0], path,allowOtherFields);
    return;
  }
  if (schema.type === 'object') {
    check(value && typeof value === 'object' && !Array.isArray(value), path+' 缺少记录。');
    const keys = Object.keys(value);
    check((allowOtherFields || keys.length===schema.required.length) &&
      schema.required.every(key=>Object.hasOwn(value,key)), path+' 的字段与规范不符。');
    for (const [key,child] of Object.entries(schema.properties)) structure(value[key],child,path+'.'+key,allowOtherFields);
  } else if (schema.type === 'array') {
    check(Array.isArray(value) && value.length <= (interactionListLimits[path]??160),path+' 超出列表范围。');
    value.forEach((item,i)=>structure(item,schema.items,path+'['+i+']',allowOtherFields));
  } else {
    const valid = schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? Number.isFinite(value)
      : schema.type === 'boolean' ? typeof value === 'boolean'
      : /^interaction\.terminals\[\d+\]\.sourceUrl$/.test(path)?typeof value==='string'&&value.length<=2048
      : typeof value === 'string' && value.length <= 200 && Boolean(value.trim());
    check(valid && (!schema.enum || schema.enum.includes(value)), path+' 的值无效。');
  }
}
const unique = values => new Set(values).size === values.length;
const indices = (a,n) => unique(a) && a.every(i=>i>=0 && i<n);
const dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);
const minus = (a,b) => a.map((v,i)=>v-b[i]);
const lineDistance = (v,axis) => Math.hypot(...v.map((x,i)=>x-dot(v,axis)*axis[i]));
const canonicalPin = s => s.trim().toUpperCase();
const pinKey = (part,pin) => JSON.stringify([part,canonicalPin(pin)]);
export function connectedTerminalPins(connections){
  const pins=new Map();
  for(const edge of connections||[])for(const [partIndex,pin] of [[edge?.fromPartIndex,edge?.fromPin],[edge?.toPartIndex,edge?.toPin]]){
    if(Number.isInteger(partIndex)&&typeof pin==='string'&&pin.trim())pins.set(pinKey(partIndex,pin),{partIndex,pin:pin.trim()});
  }
  return pins;
}
function nearFeature(f,p,slack){
  let [x,y,z]=p.map((v,i)=>v-f.centerMm[i]);
  const angles=(f.rotationDeg||[0,0,0]).map(deg=>-deg*Math.PI/180),c=angles.map(Math.cos),s=angles.map(Math.sin);
  [x,y]=[x*c[2]-y*s[2],x*s[2]+y*c[2]];
  [x,z]=[x*c[1]+z*s[1],-x*s[1]+z*c[1]];
  [y,z]=[y*c[0]-z*s[0],y*s[0]+z*c[0]];
  const radii=f.sizeMm.map(d=>d/2+slack);
  if(radii.some(r=>r<=0))return false;
  const v=[x,y,z].map((n,i)=>n/radii[i]);
  if(v.some(n=>Math.abs(n)>1))return false;
  if(f.shape==='cylinder')return v[0]**2+v[1]**2<=1;
  if(f.shape==='ellipsoid')return v.reduce((t,n)=>t+n*n,0)<=1;
  return true;
}
function checkTerminalFeature(t,tag,parts,bodies){
  const body=bodies[t.bodyIndex];
  check(t.bodyIndex===null||body?.partIndex===t.partIndex,tag+' 的实体属于其他 BOM 行或不存在。');
  if(t.sourceUrl){let url;try{url=new URL(t.sourceUrl);}catch{}
    check(url?.protocol==='https:'&&!url.username&&!url.password,tag+' 的资料链接无效。');}
  if(t.basis==='unknown'){
    check(t.positionMm===null&&t.featureIndex===null,tag+' 无定位依据时坐标和特征应留空。');return;
  }
  check(body&&Array.isArray(t.positionMm)&&t.positionMm.length===3&&t.positionMm.every(n=>Number.isFinite(n)&&Math.abs(n)<=10000),
    tag+' 须提供实体及该实体局部的三轴毫米坐标。');
  const feature=body.features[t.featureIndex];
  check(t.featureIndex===null||(Number.isInteger(t.featureIndex)&&feature&&nearFeature(feature,t.positionMm,.25)),
    tag+' 没有落在引用的 CAD 特征范围内（坐标应为实体局部毫米）。');
  const catalog=t.basis==='geometry'&&t.featureIndex===null?resolveAssemblyPinAnchor({parts,cadPlan:{bodies}},t.partIndex,t.pin):null;
  const onCatalog=catalog?.kind==='modeled'&&catalog.bodyIndex===t.bodyIndex&&catalog.localMm.every((v,i)=>Math.abs(v-t.positionMm[i])<.005);
  check(onCatalog||body.features.some(f=>f.op==='add'&&nearFeature(f,t.positionMm,1)),
    tag+' 的接线点悬在实体外，请核对局部坐标或保留未知。');
  if(t.basis==='datasheet')check(Boolean(t.sourceUrl),tag+' 声称资料定位但缺少出处。');
  if(t.basis==='geometry'){
    const terminalBody=/焊盘|焊耳|焊脚|引脚|针脚|端子|端头|引线|触点|\b(?:pad|lead|pin|lug|contact|terminal)\b/i.test(body.name);
    check(onCatalog||(feature&&(t.featureIndex>0||terminalBody)),
      tag+' 不能以整件定位盒或整块板体作为引脚几何；请给出端子特征或标记估算。');
    check(!feature||!nearFeature(feature,t.positionMm,-.25),tag+' 的端点埋在特征内部，应定位到可接线的表面。');
  }
}

function throwInteractionIssues(issues){
  if(!issues.length)return;
  const distinct=[...new Set(issues)];
  throw Object.assign(new Error(distinct.join('\n')),{issues:distinct});
}

// An individual malformed row cannot prevent checking its well-formed peers.
// Terminal coordinates are body-local. Rigid placement changes carry their
// endpoints; changing a reference feature can actually invalidate an endpoint.
function terminalLocationIssues(model,parts,bodies,malformedRows){
  if(!Object.hasOwn(model,'terminals'))return [];
  const needed=connectedTerminalPins(model.connections),seen=new Set(),sites=new Set(),issues=[];
  check(Array.isArray(model.terminals)&&model.terminals.length<=interactionListLimits['interaction.terminals'],
    'interaction.terminals 超出列表范围。');
  for(const [i,t] of model.terminals.entries()){
    try{
      structure(t,spatial.terminals.items,'interaction.terminals['+i+']');
    }catch(error){
      malformedRows?.push(i);
      issues.push(error.message+' 此行的几何定位无法检查。');
      if(Number.isInteger(t?.partIndex)&&typeof t.pin==='string')seen.add(pinKey(t.partIndex,t.pin));
      continue;
    }
    const id=pinKey(t.partIndex,t.pin),tag=(parts[t.partIndex]?.name||'未知部件')+' / '+t.pin;
    if(!needed.has(id)||seen.has(id))issues.push('交互设计：'+tag+' 不是唯一已接线端点。');
    seen.add(id);
    if(!parts[t.partIndex]){issues.push('交互设计：'+tag+' 的 BOM 行不存在。');continue;}
    try{checkTerminalFeature(t,tag,parts,bodies);}
    catch(error){issues.push(error.message);continue;}
    if(['geometry','datasheet'].includes(t.basis)){
      const site=JSON.stringify([t.bodyIndex,...t.positionMm.map(n=>Math.round(n*1000))]);
      if(sites.has(site))issues.push('交互设计：'+tag+' 与同一实体另一针脚共用了相同的精确坐标。');
      sites.add(site);
    }
  }
  for(const [id,t] of needed){
    if(!seen.has(id))issues.push('交互设计：每个已接线的引脚都须说明端子位置或标记未知，缺少 '+(parts[t.partIndex]?.name||'未知部件')+' / '+t.pin+'。');
  }
  return issues;
}
// A wiring location can still be reviewed when a separate state transition is invalid.
export function validateTerminalLocations(model,{parts,cadPlan}){
  if(model==null)return;
  structure(withConnectionDefaults(model.connections),spatial.connections,'interaction.connections');
  if(!Object.hasOwn(model,'terminals')) {
    check(!model.connections.length,'缺少已接线端点的定位表。');
    return;
  }
  throwInteractionIssues(terminalLocationIssues(model,parts,cadPlan.bodies));
}

// Compare installed geometry on both revisions, after imported and rebuilt
// models have been placed. A translated body retains its body-local endpoint.
export function revisedTerminalLocations(before,after){
  const prior=before?.interaction?.terminals,current=after?.interaction?.terminals;
  if(!Array.isArray(prior)||!Array.isArray(current)||!before.cadPlan?.bodies||!after.cadPlan?.bodies)return null;
  const identifiable=t=>Number.isInteger(t?.partIndex)&&typeof t.pin==='string'&&t.pin.trim();
  const previous=new Map(prior.filter(identifiable).map(t=>[pinKey(t.partIndex,t.pin),t]));
  const checked=[];
  for(const [i,t] of current.entries()){
    if(!identifiable(t))continue;
    const old=previous.get(pinKey(t.partIndex,t.pin));
    if(!old)continue;
    const oldBody=before.cadPlan.bodies[old.bodyIndex],body=after.cadPlan.bodies[t.bodyIndex];
    if(JSON.stringify(old)===JSON.stringify(t)&&JSON.stringify(oldBody)===JSON.stringify(body))continue;
    const result={partIndex:t.partIndex,pin:t.pin,bodyIndex:t.bodyIndex};
    const tag=(after.parts[t.partIndex]?.name||'未知部件')+' / '+t.pin;
    const inspect=(row,design)=>{
      structure(row,spatial.terminals.items,'interaction.terminals['+i+']');
      checkTerminalFeature(row,tag,design.parts,design.cadPlan.bodies);
    };
    try{
      inspect(t,after);
      result.status=t.basis==='unknown'?'unlocated':'verified';
    }catch(error){
      result.status='invalid';result.issue=error.message;
      try{inspect(old,before);if(old.basis!=='unknown')result.status='regression';}
      catch{/* Geometry in the baseline was already invalid. */}
    }
    checked.push(result);
  }
  return {scope:'changed-terminal-bindings',checked};
}
const reservedEvent = 'timer.expired';
const legacyTimerEvents=new Set(['timeout','timerExpired','timer.elapsed']);
// Only migrate old automatic-expiry spellings with exactly one possible meaning.
// A control named "timeout" remains a user-operated event.
export function normalizeInteractionTimerAliases(raw){
 const corrections=[];
 if(!raw?.timer||!Array.isArray(raw.states)||!Array.isArray(raw.controls)||!Array.isArray(raw.transitions))
  return {model:raw,corrections};
 const controls=new Set(raw.controls.map(c=>c?.id)),clocks=new Map(raw.states.map(s=>[s?.id,s?.clock]));
 const isTimerEdge=e=>e&&(e.event===reservedEvent||(legacyTimerEvents.has(e.event)&&!controls.has(e.event)));
 const counts=new Map();
 for(const edge of raw.transitions)if(isTimerEdge(edge))counts.set(edge.from,(counts.get(edge.from)||0)+1);
 const transitions=raw.transitions.map((edge,index)=>{
  if(!edge||!legacyTimerEvents.has(edge.event)||controls.has(edge.event)||counts.get(edge.from)!==1||
     clocks.get(edge.from)!=='run'||clocks.get(edge.to)!=='hold'||edge.effect!=='none')return edge;
  corrections.push({transitionIndex:index,fromState:edge.from,fromEvent:edge.event,toEvent:reservedEvent});
  return {...edge,event:reservedEvent};
 });
 return {model:corrections.length?{...raw,transitions}:raw,corrections};
}

function placedCylinders(body) {
  const rad = Math.PI/180;
  return (body.features || []).filter(f=>f.shape==='cylinder').map(f=>{
    const [x,y,z] = (f.rotationDeg || [0,0,0]).map(n=>n*rad);
    const a = Math.sin(y)*Math.cos(x), b = -Math.sin(x);
    return {axis:[a*Math.cos(z)-b*Math.sin(z), a*Math.sin(z)+b*Math.cos(z), Math.cos(y)*Math.cos(x)],
      point:f.centerMm.map((v,i)=>v+body.positionMm[i]), op:f.op};
  });
}
const isEncoder=part=>/encoder|编码器/i.test([part.name,part.model,part.spec].join(' '));
const isBusPin=(part,pin)=>{
  const description=[part.name,part.model,part.spec].join(' '),name=pin.trim();
  return /^(SDA|SCL|MOSI|MISO|SCK|CS)$/i.test(name)&&/i[²2]c|spi|总线/i.test(description)||
    /^(?:USB[_ -]?)?D[+\-PM]$/i.test(name)&&/USB/i.test(description);
};
function usbDataLine(part,pin){
  const evidence=part?.modelSourceInvalidated?null:part?.geometryReference;
  if(!/USB/i.test([part?.name,part?.model,part?.spec,evidence?.detail,evidence?.sourceQuote].join(' ')))return null;
  const label=canonicalPin(pin).replace(/[ _]/g,'').replace(/^TP(?=(?:USB)?D[+\-PM]$)/,'');
  if(/^(?:(?:USB-?)?(?:[12]?D|D[12]?)[+P]|A6(?:\/B6)?|B6(?:\/A6)?)$/.test(label))return '+';
  if(/^(?:(?:USB-?)?(?:[12]?D|D[12]?)[-M]|A7(?:\/B7)?|B7(?:\/A7)?)$/.test(label))return '-';
  return null;
}
// Only infer a shaft centerline when a fixed bearing and moving cylinder actually
// share it. A free-form lever may have a pivot outside its visible moving solid.
function checkShaft(control, bodies) {
  const fixed = placedCylinders(bodies[control.fixedBodyIndex]);
  const shafts = control.movingBodyIndices.flatMap(i=>placedCylinders(bodies[i])).filter(c=>c.op==='add');
  const pairs = shafts.filter(s=>fixed.some(f=>Math.abs(dot(f.axis,s.axis))>.999 &&
    lineDistance(minus(f.point,s.point),s.axis)<.35));
  if (!pairs.length || pairs.some(p=>Math.abs(dot(p.axis,pairs[0].axis))<.999 ||
        lineDistance(minus(p.point,pairs[0].point),pairs[0].axis)>.35)) return;
  const shaft = pairs[0];
  check(Math.abs(dot(shaft.axis,control.axis))>.995 &&
    lineDistance(minus(control.pivotMm,shaft.point),shaft.axis)<=1,
    control.label+' 的旋转轴及轴心必须与 CAD 中固定轴套和活动轴的共同中心线重合。');
  return {shafts:pairs,bearings:fixed.filter(c=>Math.abs(dot(c.axis,shaft.axis))>.999 &&
    lineDistance(minus(c.point,shaft.point),shaft.axis)<.35)};
}

function checkBindings(model, parts, bodies, cadPlan={}) {
  const active = model.controllerPartIndex!==null;
  const placed = new Set(bodies.map(b=>b.partIndex));
  check((model.controls.length>0||active&&model.systemEvents?.length>0) && model.controls.length<=32 && model.outputs.length<=16,
    '需要可操作的输入或已连接的传感事件；最多 32 个控件、16 个输出。');
  if (active) check(placed.has(model.controllerPartIndex) && model.outputs.length>0,'控制器和至少一个输出须有对应 BOM 与 CAD 实体。');
  else check(!model.outputs.length,'纯机械方案不能声明控制器输出。');
  const ids = [...model.controls,...model.outputs,...(model.systemEvents||[])].map(item=>item.id);
  check(unique(ids) && !ids.includes(reservedEvent) && ids.every(id=>id.length<=80 && !Object.hasOwn(Object.prototype,id)),
    '操作与输出标识须唯一，且不能使用系统事件名。');
  for(const c of model.controls)for(const suffix of ['increase','decrease','down','up','cancel'])check(!ids.includes(c.id+'.'+suffix),'控件派生事件名与另一个标识冲突。');
  for(const event of model.systemEvents||[])check(parts[event.partIndex],event.label+' 的检测器件不在 BOM 中。');
  const fixed = new Set(model.controls.map(c=>c.fixedBodyIndex));
  const shaftEvidence = new Map();
  for (const c of model.controls) {
    if(c.kind==='command'){
      const host=parts[c.partIndex];
      const onboard=active&&c.partIndex===model.controllerPartIndex&&host?.placement==='mounted';
      check(active&&(onboard||host?.role==='external'&&host.placement==='loose'),c.label+' 的页面/Agent 命令需要控制器的无线通信或外部有线通信端。');
      check(c.fixedBodyIndex===null&&!c.movingBodyIndices.length&&!c.axis.length&&!c.pivotMm.length&&c.step===0&&!c.range,
        c.label+' 是页面/Agent 命令，不绑定 CAD 实体、轴线或机械行程。');
      continue;
    }
    const body = bodies[c.fixedBodyIndex];
    check(body && body.partIndex===c.partIndex && parts[c.partIndex],c.label+' 的固定基座须对应此输入器件，且在 BOM 中存在。');
    check(indices(c.movingBodyIndices,bodies.length) && !c.movingBodyIndices.some(i=>fixed.has(i)),
      c.label+' 的活动实体重复、越界或包含固定基座。');
    check(c.axis.length===3 && c.pivotMm.length===3 && c.pivotMm.every(v=>Math.abs(v)<=4000),
      c.label+' 的世界坐标方向与轴心无效。');
    // A touch event has no displacement; the common step field is unused.
    if (c.kind==='touch') check(!c.movingBodyIndices.length,c.label+' 的触摸面应保持固定。');
    else check(c.movingBodyIndices.length>0 && Math.abs(Math.hypot(...c.axis)-1)<.005 &&
      (c.kind==='turn'?Math.abs(c.step)>0&&Math.abs(c.step)<=360:c.step>0&&c.step<=2000),c.label+' 需要独立活动实体、单位轴向及有效角度/行程。');
    if (c.kind==='turn') shaftEvidence.set(c.id,checkShaft(c,bodies));
    if(c.range)check(c.kind==='turn'&&c.range.min<c.range.max&&c.range.min>=-360&&c.range.max<=360&&
      c.range.initial>=c.range.min&&c.range.initial<=c.range.max,c.label+' 的绝对角度挡位或初始角度无效。');
  }
  for (const turn of model.controls.filter(c=>c.kind==='turn')) {
    const press = model.controls.find(c=>c.kind==='press' && c.partIndex===turn.partIndex &&
      c.movingBodyIndices.some(i=>turn.movingBodyIndices.includes(i)));
    if (!press) continue;
    const part = parts[turn.partIndex];
    if (!isEncoder(part)) continue;
    check(turn.fixedBodyIndex===press.fixedBodyIndex && Math.abs(dot(turn.axis,press.axis))>.995,
      '带按压的旋转编码器须沿同一固定轴套旋转和按压。');
    const geometry=shaftEvidence.get(turn.id);
    if (geometry) {
      const moving=geometry.shafts.map(c=>dot(c.point,press.axis)), fixed=geometry.bearings.map(c=>dot(c.point,press.axis));
      check(Math.max(...fixed)+.35>=Math.min(...moving),
        '编码器的按压方向朝外。CAD 中的旋钮须沿轴向靠近固定座。');
    }
  }
  check(unique(model.outputs.filter(o=>o.motion).map(o=>o.motion.type+':'+o.motion.index)),'同一运动轴只能绑定一个输出；用该输出的正反模式表示方向。');
  for (const out of model.outputs) {
    if(out.kind==='web'){
      check(active&&out.partIndex===model.controllerPartIndex&&parts[out.partIndex]?.placement==='mounted'&&
        !out.bodyIndices.length&&!out.motion,out.label+' 是控制器提供的网页，不应绑定实体屏幕或运动部件。');
      continue;
    }
    const terminal=model.terminals?.find(t=>t.partIndex===out.partIndex&&canonicalPin(t.pin)===canonicalPin(out.signalPin||''));
    if(out.motion){
      const target=out.motion.type==='joint'?cadPlan.joints?.[out.motion.index]:cadPlan.motions?.[out.motion.index];
      check(out.kind==='motion'&&target&&target.actuatorPartIndex===out.partIndex&&out.bodyIndices.every(i=>target.movingBodyIndices.includes(i))&&
        (!(parts[out.partIndex]?.qty>1)||(out.motion.type==='joint'&&terminal?.bodyIndex===target.fixedBodyIndex))&&
        out.motion.speed>0&&out.motion.speed<=(out.motion.type==='joint'?360:1000),out.label+' 的运动输出须绑定实际关节/行程、驱动件与正的预览速度。');
    }
    const drivesLoad=out.kind==='motion'&&(
      (cadPlan.joints||[]).some(j=>bodies[j.fixedBodyIndex]?.partIndex===out.partIndex&&
        (!(parts[out.partIndex]?.qty>1)||terminal?.bodyIndex===j.fixedBodyIndex)&&
        out.bodyIndices.every(i=>j.movingBodyIndices.includes(i)))||
      (cadPlan.motions||[]).some(m=>m.actuatorPartIndex===out.partIndex&&!(parts[out.partIndex]?.qty>1)&&placed.has(out.partIndex)&&
        out.bodyIndices.every(i=>m.movingBodyIndices.includes(i))));
    check(parts[out.partIndex] && out.bodyIndices.length && indices(out.bodyIndices,bodies.length) &&
      (out.bodyIndices.some(i=>bodies[i].partIndex===out.partIndex)||drivesLoad),
      out.label+' 缺少与该输出器件对应的 CAD 实体。');
  }
}

// TI's SN74AHCT125 and SN74AHCT1G125 function tables specify active-low
// enable and independent A→Y buffers. Only match named pins, as package
// numbers alone are ambiguous.
// https://www.ti.com/product/SN74AHCT125
// https://www.ti.com/product/SN74AHCT1G125
const bufferFamily=part=>/74AHCT(1G)?125/i.exec([part.model,part.name,part.spec].join(' '));
function bufferTerminal(label,single) {
  const tokens=canonicalPin(label).match(/[A-Z0-9]+/g) || [];
  for (const token of tokens) {
    if (['VCC','VDD','GND','VSS'].includes(token)) return token;
    if (single && ['A','Y','OE'].includes(token)) return '1'+token;
    const match=/^([1-4])(A|Y|OE)$/.exec(token)||/^(A|Y|OE)([1-4])$/.exec(token);
    if (match) return /[1-4]/.test(match[1])?match[1]+match[2]:match[2]+match[1];
  }
  return null;
}
function signalChannels(model,parts,wires,gets,sends,addEdge) {
  const claimed=model.signalChannels || [], internal=new Set();
  const link=(from,to)=>{
    const key=JSON.stringify([from,to]);
    if (!internal.has(key)) {internal.add(key);addEdge(from,to);}
  };
  for (const [i,inPins] of gets) {
    const outPins=sends.get(i);
    if (!outPins) continue;
    const part=parts[i],family=bufferFamily(part);
    const name=[part.name,part.model].join(' ');
    if (!family) {
      if (inPins.size===1 && outPins.size===1 && /resistor|电阻/i.test(name) &&
          !/array|network|potentiometer|电阻排|排阻|阵列|网络|电位器/i.test(name))
        link([...inPins][0],[...outPins][0]);
      continue;
    }
    const terminal=pin=>bufferTerminal(pin,Boolean(family[1]));
    for (const pin of inPins) check(!/^[1-4]Y$/.test(terminal(JSON.parse(pin)[1])),
      'AHCT125 的 Y 是输出脚，控制器数据须接 A 输入脚。');
    const tied=(kind,labels)=>wires.some(w=>w.kind===kind &&
      ((w.toPartIndex===i && labels.includes(terminal(w.toPin))) ||
       (kind==='ground' && w.fromPartIndex===i && labels.includes(terminal(w.fromPin)))));
    if (!tied('power',['VCC','VDD']) || !tied('ground',['GND','VSS'])) continue;
    for (const from of inPins) {
      const a=terminal(JSON.parse(from)[1]);
      if (!/^[1-4]A$/.test(a) || !tied('ground',[a[0]+'OE'])) continue;
      for (const to of outPins) if (terminal(JSON.parse(to)[1])===a[0]+'Y') link(from,to);
    }
  }
  const declared=new Set();
  for (const c of claimed) {
    const i=c.partIndex,from=pinKey(i,c.inputPin),to=pinKey(i,c.outputPin);
    const part=parts[i],key=JSON.stringify([from,to]);
    check(part && i!==model.controllerPartIndex && from!==to && !declared.has(key) &&
      gets.get(i)?.has(from) && sends.get(i)?.has(to),(part?.name||'未知器件')+' 的 '+c.inputPin+' → '+c.outputPin+' 内部通道需要同一 BOM 器件上的真实输入、输出接线和唯一方向。');
    declared.add(key);
    const modelId=canonicalPin(c.model);
    const chosen=typeof part.model==='string'?canonicalPin(part.model):'';
    check(modelId.length>=4 && (modelId===chosen || chosen.split(/[^A-Z0-9_./-]+/).includes(modelId)),
      '内部通道型号与 BOM 选件不一致。');
    let url;
    try {url=new URL(c.sourceUrl);} catch {}
    const evidence=canonicalPin(c.evidence);
    check(url?.protocol==='https:' && evidence.includes(canonicalPin(c.inputPin)) &&
      evidence.includes(canonicalPin(c.outputPin)), (part.name||part.model)+' 的 '+c.inputPin+' → '+c.outputPin+' 内部通道需要 HTTPS 数据表链接及写明这两个针脚的依据。');
    if (bufferFamily(part)) check(internal.has(key),'AHCT125 通道必须同号 A→Y，接好 VCC、GND 并将对应 OE 拉低。');
    else link(from,to);
  }
  return internal;
}

const isFactoryRef=pin=>typeof pin==='string'&&/^builtin:/i.test(pin.trim());
function usesFactoryInterface(model,parts,item,pins,allowed){
  if(!pins.some(isFactoryRef))return false;
  const part=parts[item.partIndex],prefix='builtin:';
  const feature=pins.length===1&&pins[0].startsWith(prefix)&&factoryInterfaces(part).find(x=>x.id===pins[0].slice(prefix.length));
  check(feature&&item.partIndex===model.controllerPartIndex&&part.placement==='mounted'&&allowed.includes(feature.kind),
    item.label+' 的自带功能需要同一已安装主控的型号资料与相符用途；外部信号仍需实际接线。');
  return true;
}
function checkWiring(model,parts,bodies) {
  const controller = model.controllerPartIndex;
  const channels=model.signalChannels || [];
  check(model.connections.length<=MAX_INTERACTION_CONNECTIONS && channels.length<=24,
    '接线最多 '+MAX_INTERACTION_CONNECTIONS+' 项，器件内部通道最多 24 项。');
  if (controller===null) check(!model.connections.length && !channels.length && !model.timer,
    '纯机械方案不能声明电气接线、内部通道或计时。');
  check(!model.connections.some(w=>isFactoryRef(w.fromPin)||isFactoryRef(w.toPin))&&!channels.some(c=>isFactoryRef(c.inputPin)||isFactoryRef(c.outputPin)),
    '主控自带功能不是接线端子，外部连接须使用实物针脚。');
  const assignedPins=new Set(),factoryInputs=new Set();
  for (const c of model.controls) {
    check(c.signalPins.length<=8 && unique(c.signalPins.map(canonicalPin)) &&
      (controller!==null ? c.signalPins.length>0 : !c.signalPins.length),c.label+' 的信号脚与控制方式不符。');
    if(usesFactoryInterface(model,parts,c,c.signalPins,c.kind==='touch'?['touch']:c.kind==='press'?['button']:c.kind==='command'?['wifi']:[])){factoryInputs.add(c.id);continue;}
    if(c.kind==='command')check(c.partIndex!==controller&&c.signalPins.every(pin=>isBusPin(parts[c.partIndex],pin)),c.label+' 的命令须通过外部通信引脚或经型号资料核实的无线接口进入控制器。');
    if (c.kind==='turn' && controller!==null && isEncoder(parts[c.partIndex]) &&
        model.controls.some(p=>p.kind==='press' && p.partIndex===c.partIndex) &&
        !c.signalPins.some(pin=>isBusPin(parts[c.partIndex],pin))) {
      check(c.signalPins.length>=2,'增量编码器的旋转须有独立的 A/B 信号，按键使用另一根输入线。');
    }
    for (const pin of c.signalPins) {
      const key=pinKey(c.partIndex,pin);
      check(!assignedPins.has(key) || isBusPin(parts[c.partIndex],pin),c.label+' 与另一个操作重复使用了同一输入针脚。');
      assignedPins.add(key);
    }
  }
  if (controller===null) return;
  const wires = model.connections.map(w=>({...w, a:pinKey(w.fromPartIndex,w.fromPin),b:pinKey(w.toPartIndex,w.toPin)}));
  const pins = new Map(), seen = new Set();
  for (const w of wires) {
    const edge=JSON.stringify([w.kind,w.a,w.b]);
    check(parts[w.fromPartIndex] && parts[w.toPartIndex] && w.a!==w.b && !seen.has(edge),'接线端点无效或重复。');
    check(!w.bidirectional||w.kind==='signal','双向接线只用于真实的双向信号线。');
    seen.add(edge);
    for (const [pin,partIndex,pinName] of [[w.a,w.fromPartIndex,w.fromPin],[w.b,w.toPartIndex,w.toPin]]) {
      check(!pins.has(pin) || pins.get(pin)===w.kind,'同一针脚被同时用于不同类型的信号或供电：'+
        (parts[partIndex].name||parts[partIndex].model)+' (#'+partIndex+') / '+pinName+'，接线分类 '+pins.get(pin)+' 与 '+w.kind+' 不一致。');
      pins.set(pin,w.kind);
    }
    const terminals=[canonicalPin(w.fromPin),canonicalPin(w.toPin)];
    if (w.kind!=='ground') check(!terminals.some(p=>/^(GND|0V|VSS|AGND|DGND)$/.test(p)),
      '地端不能作为信号或正电源端。');
    if (w.kind==='ground') check(!terminals.some(p=>/^(VCC|VDD|VBUS|VIN|3V3|5V|\+5V)$/.test(p)),
      '正电源端不能作为地端。');
  }
  const signals = wires.filter(w=>w.kind==='signal');
  const signalGraph = new Map();
  function addEdge(a,b) {
    if (!signalGraph.has(a)) signalGraph.set(a,[]);
    signalGraph.get(a).push(b);
  }
  const differentInstance=w=>{
    if(w.fromPartIndex!==w.toPartIndex)return true;
    if(!(parts[w.fromPartIndex]?.qty>1))return false;
    const a=model.terminals?.find(t=>pinKey(t.partIndex,t.pin)===w.a),b=model.terminals?.find(t=>pinKey(t.partIndex,t.pin)===w.b);
    return Number.isInteger(a?.bodyIndex)&&Number.isInteger(b?.bodyIndex)&&a.bodyIndex!==b.bodyIndex&&
      bodies[a.bodyIndex]?.partIndex===w.fromPartIndex&&bodies[b.bodyIndex]?.partIndex===w.toPartIndex;
  };
  // A BOM row can contain several physical devices. Explicit terminal → body
  // bindings distinguish their interconnect from a path inside one device.
  const external=signals.filter(differentInstance);
  // A shared half-duplex conductor has one installed wire and two reachable
  // directions. Active devices still need each documented internal channel.
  const isBidirectional=w=>{
    const line=usbDataLine(parts[w.fromPartIndex],w.fromPin),other=usbDataLine(parts[w.toPartIndex],w.toPin);
    check(line===null||other===null||line===other,'USB 数据对的正负端接反。');
    return (line!==null&&line===other)||w.bidirectional===true;
  };
  for (const w of external){addEdge(w.a,w.b);if(isBidirectional(w))addEdge(w.b,w.a);}
  const gets = new Map(), sends = new Map();
  function recordPin(map,part,pin) {
    if (!map.has(part)) map.set(part,new Set());
    map.get(part).add(pin);
  }
  for (const w of external) {
    recordPin(gets,w.toPartIndex,w.b);
    recordPin(sends,w.fromPartIndex,w.a);
    if(isBidirectional(w)){recordPin(gets,w.fromPartIndex,w.a);recordPin(sends,w.toPartIndex,w.b);}
  }
  const internal=signalChannels(model,parts,wires,gets,sends,addEdge);
  for (const w of signals.filter(w=>!differentInstance(w)))
    check(internal.has(JSON.stringify([w.a,w.b])),'同一器件不同针脚间的信号通道须有型号与针脚映射依据。'+
      parts[w.fromPartIndex].name+' (#'+w.fromPartIndex+') / '+w.fromPin+' → '+w.toPin+'。');
  function trace(start,endpoint) {
    const found = new Set(), visited = new Set();
    const next=[start];
    for (let i=0;i<next.length;i++) {
      const pin=next[i];
      if (visited.has(pin)) continue;
      visited.add(pin);
      if (pin!==start && endpoint(pin)) {found.add(pin); continue;}
      for (const neighbor of signalGraph.get(pin) || []) next.push(neighbor);
    }
    return found;
  }
  const incoming = gets.get(controller) || new Set(), outgoing=sends.get(controller) || new Set();
  const consumed = new Map();
  for (const c of model.controls) {
    if(factoryInputs.has(c.id))continue;
    const powerPins=new Set(c.signalPins.map(pin=>pinKey(c.partIndex,pin)));
    const directPower=c.partIndex!==controller&&!['touch','command'].includes(c.kind)&&!isEncoder(parts[c.partIndex])&&powerPins.size>=2&&
      [...powerPins].every(pin=>pins.get(pin)==='power')&&
      wires.some(w=>w.kind==='power'&&w.fromPartIndex!==c.partIndex&&powerPins.has(w.b))&&
      wires.some(w=>w.kind==='power'&&w.toPartIndex!==c.partIndex&&powerPins.has(w.a));
    // A physical power contact has no fictitious GPIO input. Its moving body,
    // incoming/outgoing power terminals and state effects are checked elsewhere.
    if(directPower)continue;
    for (const pin of c.signalPins) {
      const matches=trace(pinKey(c.partIndex,pin),p=>incoming.has(p));
      check(matches.size===1,c.label+' 的 '+pin+' 需要连至一个明确的控制器输入脚。');
      const end=[...matches][0];
      const bus=isBusPin(parts[c.partIndex],pin)?canonicalPin(pin):null;
      check(!consumed.has(end) || (bus && consumed.get(end)===bus),c.label+' 的独立输入与另一信号短接到同一个控制器针脚。');
      consumed.set(end,bus);
    }
  }
  for (const o of model.outputs) {
    if(o.kind==='web'){
      check(usesFactoryInterface(model,parts,o,[o.signalPin],['wifi']),o.label+' 需要主控型号资料已经证实的无线接口。');
      continue;
    }
    if(usesFactoryInterface(model,parts,o,[o.signalPin],['light','sound','display'].includes(o.kind)?[o.kind]:[]))continue;
    const end=pinKey(o.partIndex,o.signalPin);
    check([...outgoing].some(pin=>trace(pin,p=>p===end).size),o.label+' 的 '+o.signalPin+' 需要从控制器输出脚获得信号。');
  }
  for (const pin of outgoing) check(!consumed.has(pin) || consumed.get(pin),
    '同一控制器 GPIO 同时充当独立输入与输出，检查收发引脚分配。');
  const rails = kind => wires.filter(w=>w.kind===kind);
  const supply=rails('power'), ground=rails('ground');
  check(supply.some(w=>w.fromPartIndex===controller || w.toPartIndex===controller) &&
    ground.some(w=>w.fromPartIndex===controller || w.toPartIndex===controller),
    '控制器须有对应到 BOM 针脚的电源和公共地连接。');
  const common = new Set([controller]);
  for (let prior=-1;prior!==common.size;) {
    prior=common.size;
    for (const w of ground) if (common.has(w.fromPartIndex) || common.has(w.toPartIndex)) {
      common.add(w.fromPartIndex); common.add(w.toPartIndex);
    }
  }
  for (const c of model.controls) {
    if (!isEncoder(parts[c.partIndex]) || c.partIndex===controller) continue;
    check(common.has(c.partIndex) || supply.some(w=>w.toPartIndex===c.partIndex) ||
      signals.some(w=>w.fromPartIndex===controller && w.toPartIndex===c.partIndex),
      c.label+' 的编码器公共端或电源参考缺少回路。');
  }
  for (const o of model.outputs.filter(o=>o.kind==='light' || o.kind==='display')) {
    check(common.has(o.partIndex),o.label+' 需要可追溯到控制器的公共地或回流连接。');
    if (o.kind==='display' && o.partIndex!==controller) {
      const part=parts[o.partIndex];
      const suppliedHost=part.kind==='provided'&&part.role==='external'&&part.placement==='loose'&&
        /USB/i.test([part.name,part.model,part.spec].join(' '))&&/host|OTG|主机/i.test([part.name,part.model,part.spec].join(' '))&&
        supply.some(w=>w.fromPartIndex===o.partIndex&&canonicalPin(w.fromPin)==='VBUS');
      check(suppliedHost||supply.some(w=>w.toPartIndex===o.partIndex),o.label+' 的电源输入脚缺少供电连接。');
    }
  }
}

const transitionKey = (from,event)=>JSON.stringify([from,event]);

function checkMachine(model,parts) {
  const {states,transitions,timer,controls,outputs}=model;
  check(states.length>=1 && states.length<=64 && transitions.length<=512,'状态需要 1–64 项，状态转换最多 512 项。');
  check(unique(states.map(s=>s.id)) && states.some(s=>s.id===model.initialState),'状态须唯一，且初始状态必须存在。');
  const byId=new Map(states.map(s=>[s.id,s]));
  const byControl=new Map(controls.map(c=>[c.id,c]));
  const systemEvents=model.systemEvents||[],bySystem=new Map(systemEvents.map(e=>[e.id,e]));
  const recorder=model.recorder;
  if(recorder){
    const {displayId,captureStates,reviewStates,sampleEvents}=recorder;
    check(model.controllerPartIndex!==null&&outputs.some(o=>o.id===displayId&&['display','web'].includes(o.kind)),'记录要关联控制器和用于回看的网页或显示屏。');
    check(captureStates.length&&reviewStates.length&&unique([...captureStates,...reviewStates])&&[...captureStates,...reviewStates].every(id=>byId.has(id)),'请指定互不重叠且存在的记录、回看状态。');
    check(reviewStates.every(id=>byId.get(id).outputs.some(o=>o.outputId===displayId&&o.mode==='on')),'回看时对应的网页或显示屏需要能显示记录。');
    check(sampleEvents.length&&unique(sampleEvents)&&sampleEvents.every(id=>bySystem.get(id)?.kind==='feedback'),'记录来源必须是已接线的传感反馈事件。');
    const connected=new Set(reviewStates);for(let i=0;i<states.length;i++)for(const t of transitions)if(connected.has(t.to))connected.add(t.from);
    check(captureStates.every(id=>connected.has(id)),'每个记录状态都需要可到达的回看操作。');
  }
  check(systemEvents.length<=24 && (!systemEvents.length||model.controllerPartIndex!==null),'系统事件需要控制器，且最多 24 项。');
  for(const event of systemEvents){
    check(event.sourcePins.length>0&&event.sourcePins.length<=8&&unique(event.sourcePins.map(canonicalPin)),event.label+' 须明确检测来源针脚。');
    check(event.kind==='timeout'?Number.isFinite(event.delayMs)&&event.delayMs>0&&event.delayMs<=86400000:event.delayMs===null,
      event.label+' 的超时阈值无效；非超时事件的 delayMs 应为 null。');
    const onboard=usesFactoryInterface(model,parts,event,event.sourcePins,event.kind==='timeout'?['clock']:event.kind==='connection'?['wifi']:event.kind==='fault'?['clock','button']:event.kind==='feedback'&&!recorder?.sampleEvents.includes(event.id)?['touch','button','clock']:[]);
    check(onboard||event.sourcePins.every(pin=>model.connections.some(w=>
      w.fromPartIndex===event.partIndex&&canonicalPin(w.fromPin)===canonicalPin(pin)||
      w.toPartIndex===event.partIndex&&canonicalPin(w.toPin)===canonicalPin(pin))),event.label+' 的检测来源未对应真实接线端点。');
    check(transitions.some(t=>t.event===event.id)||recorder?.sampleEvents.includes(event.id),event.label+' 既不触发状态变化，也未用于记录。');
  }
  if (timer) {
    check(timer.minSeconds>=1 && timer.maxSeconds<=31536000 && timer.initialSeconds>=timer.minSeconds &&
      timer.initialSeconds<=timer.maxSeconds && timer.stepSeconds>=1 && timer.stepSeconds<=timer.maxSeconds,
      '计时范围、初始值或每格钟数无效。');
    check(byId.get(model.initialState).clock==='hold' && states.some(s=>s.clock==='run'),'计时器需要初始待机状态及倒计时状态。');
  }
  for (const s of states) {
    check(s.clock!=='run' || timer,s.label+' 的倒计时缺少时间范围。');
    check(s.outputs.length===outputs.length && unique(s.outputs.map(o=>o.outputId)),s.label+' 须指定每个输出一次。');
    for (const o of s.outputs) {
      const def=outputs.find(x=>x.id===o.outputId);
      check(def && (o.mode!=='breathe' || def.kind==='light') &&
        (!['forward','reverse'].includes(o.mode)||(def.kind==='motion'&&def.motion))&&
        (!['remaining','value'].includes(o.mode) || (['display','web'].includes(def.kind) && timer)),
        s.label+' 的输出模式与实际输出器件不匹配。');
    }
  }
  const edges=new Map(), used = new Set();
  for (const t of transitions) {
    const key=transitionKey(t.from,t.event), from=byId.get(t.from), to=byId.get(t.to);
    check(from && to && !edges.has(key),'状态转换引用了未知状态或同一事件有多个结果。');
    const parsed=controlEvent(model,t.event),c=parsed?.control;
    if (t.event===reservedEvent) {
      check(timer && from.clock==='run' && to.clock==='hold' && t.effect==='none','计时结束须从运行态进入停止计时的反馈态。');
    } else {
      check(c||bySystem.has(t.event),'状态转换引用了未知操作 '+t.event+'。'+(timer?'用户操作请填写控件 id；自然到时请使用 timer.expired，从运行态到停止态，effect 为 none。':''));
      if(bySystem.has(t.event))check(t.effect==='none','系统事件只切换状态，不能冒充用户调节或倒计时时钟。');
      if (t.to!==t.from || t.effect!=='none') used.add(c?.id||t.event);
    }
    if (t.effect!=='none') check(timer,'时间更新必须绑定一个计时器。');
    if (t.effect==='adjust') check(c?.kind==='turn' && from.clock==='hold' && to.clock==='hold',
      '时间调整须由静止计时状态下的旋转操作触发。');
    if (t.effect==='restart') check(to.clock==='run','启动计时必须进入运行态。');
    if (t.effect==='reset') check(to.clock==='hold','复位必须回到停止计时的状态。');
    edges.set(key,t);
  }
  for(const t of transitions){
    const parsed=controlEvent(model,t.event);
    if(parsed?.phase!=='down'||!byId.get(t.to).outputs.some(o=>['forward','reverse'].includes(o.mode)))continue;
    for(const phase of ['up','cancel']){
      const stop=edges.get(transitionKey(t.to,parsed.control.id+'.'+phase));
      check(stop&&!byId.get(stop.to).outputs.some(o=>['forward','reverse'].includes(o.mode)),parsed.control.label+' 的持续动作需要原按钮抬起和取消事件停止运动。');
    }
  }
  for (const s of states.filter(x=>x.clock==='run')) {
    check(edges.has(transitionKey(s.id,reservedEvent)),s.label+' 缺少倒计时结束事件 timer.expired。');
  }
  const reachable=new Set([model.initialState]), queue=[model.initialState];
  for (let i=0;i<queue.length;i++) {
    for (const t of transitions.filter(e=>e.from===queue[i])) {
      if (!reachable.has(t.to)) { reachable.add(t.to); queue.push(t.to); }
    }
  }
  check(reachable.size===states.length,'存在从初始操作流程无法达到的状态。');
  if (model.controllerPartIndex!==null) {
    for (const c of controls) check(used.has(c.id),c.label+' 没有连接到状态或计时行为。');
    for (const o of outputs) check(states.some(s=>s.outputs.some(x=>x.outputId===o.id && x.mode!=='off')),
      o.label+' 在全部可达状态都关闭，无法产生输出。');
    check(timer || recorder || states.some(s=>s.outputs.some(o=>o.mode!==states[0].outputs.find(x=>x.outputId===o.outputId).mode)),
      '操作没有改变任何可观察的输出。');
  }
  if (timer) {
    check(transitions.some(t=>t.effect==='restart'),'缺少从设定时长启动倒计时的操作。');
    // A resumed clock must already contain time. Zero at expiry remains zero
    // until an explicit reset, restart or adjustment; explore both possibilities.
    const initial=[model.initialState,true], queue=[initial], visited=new Set();
    for (let i=0;i<queue.length;i++) {
      const [id,hasTime]=queue[i], key=JSON.stringify(queue[i]);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const t of transitions.filter(e=>e.from===id)) {
        const positive=t.effect!=='none' || (t.event!==reservedEvent && hasTime);
        check(byId.get(t.to).clock!=='run' || positive, '倒计时归零后必须重新装入设定时长才能再次启动。');
        queue.push([t.to,positive]);
      }
    }
  }
}

export function validateInteractionGeometry(raw,{bom,parts=bom,cadPlan}={}) {
  if (raw==null) return null;
  check(Array.isArray(parts) && Array.isArray(cadPlan?.bodies),'需要 BOM 和 CAD 实体表。');
  structure(withMotionDefaults(raw),geometrySpec,'interaction',true);
  checkBindings(raw,parts,cadPlan.bodies,cadPlan);
  return raw;
}
export function validateInteraction(raw,{bom,parts=bom,cadPlan}={}) {
  if (raw==null) return null;
  raw=normalizeInteractionTimerAliases(raw).model;
  const connections=withConnectionDefaults(raw.connections);
  structure(withMotionDefaults({signalChannels:[],systemEvents:[],recorder:null,...raw,connections,terminals:[]}),spec,'interaction');
  check(Array.isArray(parts) && Array.isArray(cadPlan?.bodies),'需要 BOM 和 CAD 实体表。');
  // These four checks are independent after shape validation. A bad moving
  // body must not conceal a circuit or state-machine defect until the next
  // expensive design iteration. No failed category is accepted or skipped.
  const issues=[],malformedRows=[];
  try{issues.push(...terminalLocationIssues(raw,parts,cadPlan.bodies,malformedRows));}
  catch(error){issues.push(error.message);malformedRows.push(-1);}
  const checks=[()=>checkMachine(raw,parts)];
  if(malformedRows.length)issues.push('交互设计：端子表格式不完整，依赖端子的装配绑定和线路检查未完成。');
  else checks.unshift(()=>checkBindings(raw,parts,cadPlan.bodies,cadPlan),()=>checkWiring(raw,parts,cadPlan.bodies));
  for(const run of checks) {
    try {run();} catch(error) {issues.push(...(error.issues||[error.message]));}
  }
  throwInteractionIssues(issues);
  machines.delete(raw);
  return raw;
}

// XState owns event resolution and state changes. The only actions accepted
// from a design are the four data-only effects declared in the schema.
const machines=new WeakMap();
function machineFor(model) {
  if (!machines.has(model)) {
    const states=Object.fromEntries(model.states.map(s=>[s.id,{on:Object.create(null)}]));
    for (const t of model.transitions) {
      states[t.from].on['control:'+t.event]={target:t.to,actions:t.effect==='none'?[]:[t.effect]};
    }
    machines.set(model,createMachine({initial:model.initialState,states}));
  }
  return machines.get(model);
}
function displayedOutputs(model,id) {
  return Object.fromEntries(model.states.find(s=>s.id===id).outputs.map(o=>[o.outputId,o.mode]));
}
export function initialInteraction(model) {
  if (!model) return null;
  const stateId=machineFor(model).initialState.value;
  return {stateId,setSeconds:model.timer?.initialSeconds??null,
    remainingSeconds:model.timer?.initialSeconds??null,outputs:displayedOutputs(model,model.initialState),
    controlValues:Object.fromEntries(model.controls.map(c=>[c.id,c.range?.initial??0])),...(model.recorder?{recording:emptyRecording()}:{})};
}
const emptyRecording=()=>({elapsedSeconds:0,entries:[],dropped:0});
const capture=(model,id)=>model.recorder?.captureStates.includes(id);
export const PREVIEW_HISTORY_LIMIT=256;
export function stepInteraction(model,runtime,event) {
  if (!model || !runtime || !event) return runtime;
  let {stateId,setSeconds,remainingSeconds,controlValues}=runtime;
  let eventId, delta=1,extraElapsed=0,recording=runtime.recording;
  if (Object.hasOwn(event,'elapsedSeconds')) {
    if (!Number.isFinite(event.elapsedSeconds) || event.elapsedSeconds<=0) return runtime;
    const countdown=model.states.find(s=>s.id===stateId)?.clock==='run'&&model.timer;
    if(capture(model,stateId))recording={...recording,elapsedSeconds:recording.elapsedSeconds+(countdown?Math.min(event.elapsedSeconds,remainingSeconds):event.elapsedSeconds)};
    if(!countdown)return recording!==runtime.recording?{...runtime,recording}:runtime;
    extraElapsed=Math.max(0,event.elapsedSeconds-remainingSeconds);
    remainingSeconds=Math.max(0,remainingSeconds-event.elapsedSeconds);
    if (remainingSeconds>0) return {...runtime,remainingSeconds,...(recording?{recording}:{})};
    eventId=reservedEvent;
  } else if(Object.hasOwn(event,'systemEventId')) {
    if(!(model.systemEvents||[]).some(e=>e.id===event.systemEventId))return runtime;
    eventId=event.systemEventId;
    if(capture(model,stateId)&&model.recorder.sampleEvents.includes(eventId)){
      const label=model.systemEvents.find(e=>e.id===eventId).label,full=recording.entries.length>=PREVIEW_HISTORY_LIMIT;
      recording={...recording,dropped:recording.dropped+Number(full),entries:[...(full?recording.entries.slice(1):recording.entries),{atSeconds:Math.floor(recording.elapsedSeconds),eventId,label}]};
    }
  } else {
    const control=model.controls.find(c=>c.id===event.controlId);
    if (!control) return runtime;
    eventId=control.id;
    if (control.kind==='turn') {
      delta=event.delta??1;
      if (!Number.isSafeInteger(delta) || !delta || Math.abs(delta)>1000000) return runtime;
      let angle=controlValues[control.id]+delta*control.step;
      if(control.range)angle=Math.max(control.range.min,Math.min(control.range.max,angle));
      if(angle===controlValues[control.id])return runtime;
      if (Math.abs(angle)>1e9) angle%=360;
      const direction=angle>controlValues[control.id]?'increase':'decrease';
      if(model.transitions.some(t=>t.event===control.id+'.'+direction))eventId=control.id+'.'+direction;
      controlValues={...controlValues,[control.id]:angle};
    }else if(event.phase){
      if(!['press','touch','command'].includes(control.kind)||!['down','up','cancel'].includes(event.phase))return runtime;
      eventId=control.id+'.'+event.phase;
    }
  }
  const next=machineFor(model).transition(stateId,'control:'+eventId);
  if (!next.changed && controlValues===runtime.controlValues && recording===runtime.recording) return runtime;
  stateId=next.value;
  if(capture(model,stateId)&&!capture(model,runtime.stateId))recording=emptyRecording();
  if(extraElapsed&&capture(model,stateId))recording={...recording,elapsedSeconds:recording.elapsedSeconds+extraElapsed};
  const effect=next.actions[0]?.type;
  if (effect==='adjust') {
    setSeconds=Math.max(model.timer.minSeconds,Math.min(model.timer.maxSeconds,setSeconds+delta*model.timer.stepSeconds));
    remainingSeconds=setSeconds;
  } else if (effect==='reset' || effect==='restart') remainingSeconds=setSeconds;
  return {stateId,setSeconds,remainingSeconds,controlValues,outputs:displayedOutputs(model,stateId),...(recording?{recording}:{})};
}

// Uses the declared kinematic axes. This is a bounded visual pose update, not dynamics.
export function advanceMotionPreview(model,snapshot,plan,{jointValues=[],motionProgress=[]}={},elapsedSeconds){
  const nextJoints=[...jointValues],nextMotions=[...motionProgress];let changed=false;
  if(!(elapsedSeconds>0&&Number.isFinite(elapsedSeconds)))return {jointValues:nextJoints,motionProgress:nextMotions,changed};
  for(const output of model?.outputs||[]){
    const binding=output.motion,mode=snapshot?.outputs?.[output.id];
    if(!binding||!['forward','reverse'].includes(mode))continue;
    const target=binding.type==='joint'?plan.joints?.[binding.index]:plan.motions?.[binding.index];
    if(!target)continue;
    const list=binding.type==='joint'?nextJoints:nextMotions,old=list[binding.index]||0;
    const value=old+(mode==='forward'?1:-1)*binding.speed*elapsedSeconds/(binding.type==='joint'?1:target.travelMm);
    const next=Math.max(binding.type==='joint'?target.minDegrees:0,Math.min(binding.type==='joint'?target.maxDegrees:1,value));
    list[binding.index]=next;changed||=next!==old;
  }
  return {jointValues:nextJoints,motionProgress:nextMotions,changed};
}
