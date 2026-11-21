// Unmodified @xstate/fsm 2.1.0 ESM distribution; its MIT license ships alongside it.
import {createMachine} from './assets/xstate-fsm/xstate-fsm-2.1.0.js';

// The same bounded format drives design review and the interactive CAD view.
// All part/body references are zero-based. Axes and pivots use assembly coordinates.
const obj = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const arr = items => ({type:'array', items});
const choice = (...values) => ({type:'string', enum:values});
const number = {type:'number'}, integer = {type:'integer'}, str = {type:'string'};
const nullable = spec => ({anyOf:[spec, {type:'null'}]});
const spec = obj({
  version:{type:'integer', enum:[1]}, controllerPartIndex:nullable(integer),
  controls:arr(obj({id:str,label:str,kind:choice('turn','press','slide','touch'),partIndex:integer,
    fixedBodyIndex:integer,movingBodyIndices:arr(integer),axis:arr(number),pivotMm:arr(number),
    step:number,signalPins:arr(str)})),
  outputs:arr(obj({id:str,label:str,kind:choice('display','light','motion','sound'),partIndex:integer,
    bodyIndices:arr(integer),signalPin:str})),
  connections:arr(obj({kind:choice('signal','power','ground'),fromPartIndex:integer,fromPin:str,
    toPartIndex:integer,toPin:str})),
  signalChannels:arr(obj({partIndex:integer,model:str,inputPin:str,outputPin:str,sourceUrl:str,evidence:str})),
  timer:nullable(obj({initialSeconds:integer,minSeconds:integer,maxSeconds:integer,stepSeconds:integer})),
  initialState:str,
  states:arr(obj({id:str,label:str,clock:choice('hold','run'),
    outputs:arr(obj({outputId:str,mode:choice('off','on','breathe','remaining','value')}))})),
  transitions:arr(obj({from:str,event:str,to:str,effect:choice('none','adjust','restart','reset')}))
});
export const interactionSchema = nullable(spec);
const spatial = spec.properties;
const fields=(record,keys)=>Object.fromEntries(keys.map(k=>[k,record.properties[k]]));
const geometrySpec=obj({...fields(spec,['version','controllerPartIndex']),
  controls:arr(obj(fields(spatial.controls.items,['id','label','kind','partIndex','fixedBodyIndex','movingBodyIndices','axis','pivotMm','step']))),
  outputs:arr(obj(fields(spatial.outputs.items,['id','label','kind','partIndex','bodyIndices'])))});

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
    check(Array.isArray(value) && value.length <= 160,path+' 超出列表范围。');
    value.forEach((item,i)=>structure(item,schema.items,path+'['+i+']',allowOtherFields));
  } else {
    const valid = schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? Number.isFinite(value)
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
const isBusPin=(part,pin)=>/^(SDA|SCL|MOSI|MISO|SCK|CS)$/i.test(pin.trim()) &&
  /i[²2]c|spi|总线/i.test([part.name,part.model,part.spec].join(' '));
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

function checkBindings(model, parts, bodies) {
  const active = model.controllerPartIndex!==null;
  const placed = new Set(bodies.map(b=>b.partIndex));
  check(model.controls.length>=1 && model.controls.length<=16 && model.outputs.length<=16,
    '需要 1–16 个可操作输入，且输出须在范围内。');
  if (active) check(placed.has(model.controllerPartIndex) && model.outputs.length>0,'控制器和至少一个输出须有对应 BOM 与 CAD 实体。');
  else check(!model.outputs.length,'纯机械方案不能声明控制器输出。');
  const ids = [...model.controls,...model.outputs].map(item=>item.id);
  check(unique(ids) && !ids.includes(reservedEvent) && ids.every(id=>id.length<=80 && !Object.hasOwn(Object.prototype,id)),
    '操作与输出标识须唯一，且不能使用系统事件名。');
  const fixed = new Set(model.controls.map(c=>c.fixedBodyIndex));
  const shaftEvidence = new Map();
  for (const c of model.controls) {
    const body = bodies[c.fixedBodyIndex];
    check(body && body.partIndex===c.partIndex && parts[c.partIndex],c.label+' 的固定基座须对应此输入器件，且在 BOM 中存在。');
    check(indices(c.movingBodyIndices,bodies.length) && !c.movingBodyIndices.some(i=>fixed.has(i)),
      c.label+' 的活动实体重复、越界或包含固定基座。');
    check(c.axis.length===3 && c.pivotMm.length===3 && c.pivotMm.every(v=>Math.abs(v)<=4000),
      c.label+' 的世界坐标方向与轴心无效。');
    if (c.kind==='touch') check(!c.movingBodyIndices.length && c.step===0,c.label+' 的触摸面应保持固定。');
    else check(c.movingBodyIndices.length>0 && Math.abs(Math.hypot(...c.axis)-1)<.005 &&
      c.step>0 && c.step<=(c.kind==='turn'?360:2000),c.label+' 需要独立活动实体、单位轴向及有效角度/行程。');
    if (c.kind==='turn') shaftEvidence.set(c.id,checkShaft(c,bodies));
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
  for (const out of model.outputs) {
    check(parts[out.partIndex] && out.bodyIndices.length && indices(out.bodyIndices,bodies.length) &&
      out.bodyIndices.some(i=>bodies[i].partIndex===out.partIndex),
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
      gets.get(i)?.has(from) && sends.get(i)?.has(to),'内部通道需要同一 BOM 器件上的真实输入、输出接线和唯一方向。');
    declared.add(key);
    const modelId=canonicalPin(c.model);
    const chosen=typeof part.model==='string'?canonicalPin(part.model):'';
    check(modelId.length>=4 && (modelId===chosen || chosen.split(/[^A-Z0-9_./-]+/).includes(modelId)),
      '内部通道型号与 BOM 选件不一致。');
    let url;
    try {url=new URL(c.sourceUrl);} catch {}
    const evidence=canonicalPin(c.evidence);
    check(url?.protocol==='https:' && evidence.includes(canonicalPin(c.inputPin)) &&
      evidence.includes(canonicalPin(c.outputPin)), '内部通道需要 HTTPS 数据表链接及写明两个针脚的依据。');
    if (bufferFamily(part)) check(internal.has(key),'AHCT125 通道必须同号 A→Y，接好 VCC、GND 并将对应 OE 拉低。');
    else link(from,to);
  }
  return internal;
}

function checkWiring(model,parts) {
  const controller = model.controllerPartIndex;
  const channels=model.signalChannels || [];
  check(model.connections.length<=96 && channels.length<=24,'接线或器件内部通道超出范围。');
  if (controller===null) check(!model.connections.length && !channels.length && !model.timer,
    '纯机械方案不能声明电气接线、内部通道或计时。');
  const assignedPins=new Set();
  for (const c of model.controls) {
    check(c.signalPins.length<=8 && unique(c.signalPins.map(canonicalPin)) &&
      (controller!==null ? c.signalPins.length>0 : !c.signalPins.length),c.label+' 的信号脚与控制方式不符。');
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
    seen.add(edge);
    for (const pin of [w.a,w.b]) {
      check(!pins.has(pin) || pins.get(pin)===w.kind,'同一针脚被同时用于不同类型的信号或供电。');
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
  const external=signals.filter(w=>w.fromPartIndex!==w.toPartIndex);
  for (const w of external) addEdge(w.a,w.b);
  const gets = new Map(), sends = new Map();
  function recordPin(map,part,pin) {
    if (!map.has(part)) map.set(part,new Set());
    map.get(part).add(pin);
  }
  for (const w of external) {
    recordPin(gets,w.toPartIndex,w.b);
    recordPin(sends,w.fromPartIndex,w.a);
  }
  const internal=signalChannels(model,parts,wires,gets,sends,addEdge);
  for (const w of signals.filter(w=>w.fromPartIndex===w.toPartIndex))
    check(internal.has(JSON.stringify([w.a,w.b])),'同一器件不同针脚间的信号通道须有型号与针脚映射依据。');
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
      check(supply.some(w=>w.toPartIndex===o.partIndex),o.label+' 的电源输入脚缺少供电连接。');
    }
  }
}

const transitionKey = (from,event)=>JSON.stringify([from,event]);

function checkMachine(model) {
  const {states,transitions,timer,controls,outputs}=model;
  check(states.length>=1 && states.length<=24 && transitions.length<=120 &&
    unique(states.map(s=>s.id)) && states.some(s=>s.id===model.initialState),'状态须唯一，且初始状态必须存在。');
  const byId=new Map(states.map(s=>[s.id,s]));
  const byControl=new Map(controls.map(c=>[c.id,c]));
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
        (!['remaining','value'].includes(o.mode) || (def.kind==='display' && timer)),
        s.label+' 的输出模式与实际输出器件不匹配。');
    }
  }
  const edges=new Map(), used = new Set();
  for (const t of transitions) {
    const key=transitionKey(t.from,t.event), from=byId.get(t.from), to=byId.get(t.to);
    check(from && to && !edges.has(key),'状态转换引用了未知状态或同一事件有多个结果。');
    const c=byControl.get(t.event);
    if (t.event===reservedEvent) {
      check(timer && from.clock==='run' && to.clock==='hold' && t.effect==='none','计时结束须从运行态进入停止计时的反馈态。');
    } else {
      check(c,'状态转换引用了未知操作 '+t.event+'。'+(timer?'用户操作请填写控件 id；自然到时请使用 timer.expired，从运行态到停止态，effect 为 none。':''));
      if (t.to!==t.from || t.effect!=='none') used.add(t.event);
    }
    if (t.effect!=='none') check(timer,'时间更新必须绑定一个计时器。');
    if (t.effect==='adjust') check(c?.kind==='turn' && from.clock==='hold' && to.clock==='hold',
      '时间调整须由静止计时状态下的旋转操作触发。');
    if (t.effect==='restart') check(to.clock==='run','启动计时必须进入运行态。');
    if (t.effect==='reset') check(to.clock==='hold','复位必须回到停止计时的状态。');
    edges.set(key,t);
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
    check(timer || states.some(s=>s.outputs.some(o=>o.mode!==states[0].outputs.find(x=>x.outputId===o.outputId).mode)),
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
  structure(raw,geometrySpec,'interaction',true);
  checkBindings(raw,parts,cadPlan.bodies);
  return raw;
}
export function validateInteraction(raw,{bom,parts=bom,cadPlan}={}) {
  if (raw==null) return null;
  raw=normalizeInteractionTimerAliases(raw).model;
  structure({signalChannels:[],...raw},spec,'interaction');
  validateInteractionGeometry(raw,{parts,cadPlan});
  checkWiring(raw,parts);
  checkMachine(raw);
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
    controlValues:Object.fromEntries(model.controls.map(c=>[c.id,0]))};
}
export function stepInteraction(model,runtime,event) {
  if (!model || !runtime || !event) return runtime;
  let {stateId,setSeconds,remainingSeconds,controlValues}=runtime;
  let eventId, delta=1;
  if (Object.hasOwn(event,'elapsedSeconds')) {
    if (!Number.isFinite(event.elapsedSeconds) || event.elapsedSeconds<=0 ||
        model.states.find(s=>s.id===stateId)?.clock!=='run') return runtime;
    remainingSeconds=Math.max(0,remainingSeconds-event.elapsedSeconds);
    if (remainingSeconds>0) return {...runtime,remainingSeconds};
    eventId=reservedEvent;
  } else {
    const control=model.controls.find(c=>c.id===event.controlId);
    if (!control) return runtime;
    eventId=control.id;
    if (control.kind==='turn') {
      delta=event.delta??1;
      if (!Number.isSafeInteger(delta) || !delta || Math.abs(delta)>1000000) return runtime;
      let angle=controlValues[control.id]+delta*control.step;
      if (Math.abs(angle)>1e9) angle%=360;
      controlValues={...controlValues,[control.id]:angle};
    }
  }
  const next=machineFor(model).transition(stateId,'control:'+eventId);
  if (!next.changed && controlValues===runtime.controlValues) return runtime;
  stateId=next.value;
  const effect=next.actions[0]?.type;
  if (effect==='adjust') {
    setSeconds=Math.max(model.timer.minSeconds,Math.min(model.timer.maxSeconds,setSeconds+delta*model.timer.stepSeconds));
    remainingSeconds=setSeconds;
  } else if (effect==='reset' || effect==='restart') remainingSeconds=setSeconds;
  return {stateId,setSeconds,remainingSeconds,controlValues,outputs:displayedOutputs(model,stateId)};
}
