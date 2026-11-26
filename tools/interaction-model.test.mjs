import {wire,timerModel} from '../server/test-fixtures/timer-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInteraction,validateInteractionGeometry,initialInteraction,stepInteraction,connectedTerminalPins,advanceMotionPreview,MAX_INTERACTION_CONNECTIONS} from '../interaction-model.js';
import {replayInteraction} from '../server/design-review.mjs';

// Real V4 solids: the front-mounted encoder has two separate CAD bodies for its
// shaft and fixed casing. Wiring and firmware below are test data, not a release.
const {design}=JSON.parse(readFileSync(new URL('../samples/shared/reading-timer/v4.json',import.meta.url)));
const validate=model=>validateInteraction(model,design);
const input=(model,s,controlId,delta)=>stepInteraction(model,s,{controlId,delta});
const tick=(model,s,elapsedSeconds)=>stepInteraction(model,s,{elapsedSeconds});

test('real encoder front-axis geometry, two-stage light wiring, and timer/display loop',()=>{
  const model=validate(timerModel());
  let s=initialInteraction(model);
  assert.deepEqual([s.stateId,s.outputs.screen,s.outputs.lamp,s.remainingSeconds],['set','value','off',180]);
  s=input(model,s,'wheel',2);
  assert.equal(s.controlValues.wheel,30); assert.equal(s.setSeconds,300);
  s=input(model,s,'push'); s=tick(model,s,10);
  assert.deepEqual([s.stateId,s.outputs.screen,s.remainingSeconds],['run','remaining',290]);
  s=input(model,s,'push'); s=tick(model,s,120);
  assert.equal(s.stateId,'pause'); assert.equal(s.remainingSeconds,290);
  s=input(model,s,'push'); s=tick(model,s,289.5);
  assert.equal(s.remainingSeconds,0.5);
  s=tick(model,s,12); assert.equal(s.remainingSeconds,0); assert.equal(s.outputs.lamp,'breathe');
  s=input(model,s,'push'); assert.deepEqual([s.stateId,s.outputs.lamp,s.remainingSeconds],['set','off',300]);
  assert.equal(input(model,s,'wheel',-999).setSeconds,60);
  assert.equal(input(model,s,'wheel',999).setSeconds,3600);
  assert.equal(input(model,s,'wheel',Infinity),s);
});
test('reject a detached input, wrong shaft axis, rotating the fixed mount, and missing output mesh',()=>{
  for (const change of [
    d=>{d.controls[0].fixedBodyIndex=4},d=>{d.controls[0].movingBodyIndices=[5,11]},
    d=>{d.controls[0].axis=[0,0,1]},d=>{d.controls[0].pivotMm=[32,-24,0]},
    d=>{d.controls[1].axis=[1,0,0]},d=>{d.controls[1].axis=[0,-1,0]},d=>{d.outputs[0].bodyIndices=[2]}]) {
    const d=timerModel(); change(d); assert.throws(()=>validate(d),/交互设计/);
  }
});
test('a signal must reach its physical pin in the correct direction; power and ground must connect',()=>{
  for (const change of [
    d=>{d.controls[0].signalPins=['A']},
    d=>{d.controls[1].signalPins=['A']},
    d=>{d.connections[1].toPin='D2'},
    d=>{d.connections=d.connections.filter(w=>w.fromPin!=='2')},
    d=>{d.connections[2]=wire('signal',4,'D4',5,'SW')},
    d=>{d.connections[5].fromPin='D2'},
    d=>{d.connections=d.connections.filter(w=>w.toPin!=='COM')},
    d=>{d.connections[8].fromPin='GND'},
    d=>{d.connections[7].toPin='D3'},
    d=>{d.connections=d.connections.filter(w=>w.kind!=='ground'||w.toPartIndex!==3)},
    d=>{d.connections=d.connections.filter(w=>w.kind!=='power'||w.toPartIndex!==11)}]) {
    const d=timerModel();change(d);assert.throws(()=>validate(d),/交互设计/);
  }
});
test('a bounded timer needs observable outputs, handling of expiry, and reachable controls',()=>{
  for (const change of [
    d=>{d.transitions=d.transitions.filter(x=>x.event!=='timer.expired')},
    d=>{d.transitions=d.transitions.filter(x=>x.from!=='run'||x.event!=='push')},
    d=>{d.transitions.push({from:'done',event:'wheel',to:'run',effect:'none'})},
    d=>{d.timer.minSeconds=0},d=>{d.states[3].outputs[1].mode='remaining'},
    d=>{d.states.forEach(s=>s.outputs[1].mode='off')},d=>{d.transitions.push({...d.transitions[0]})}]) {
    const d=timerModel();change(d);assert.throws(()=>validate(d),/交互设计/);
  }
});
test('a conflicting electrical net identifies its part and pin for automatic repair',()=>{
  const d=timerModel();d.connections.push(wire('power',5,'A',4,'D2'));
  assert.throws(()=>validate(d),error=>{
    assert.match(error.message,/同一针脚.*\(#5\) \/ A.*signal.*power/);
    return true;
  });
});
test('larger wiring tables retain endpoint checks and room for both terminals of every wire',()=>{
  const d=timerModel();
  const added=MAX_INTERACTION_CONNECTIONS-d.connections.length;
  for(let i=0;i<added;i++)d.connections.push(wire('ground',4,'GROUND_'+i,10,'RETURN_'+i));
  d.terminals=[...connectedTerminalPins(d.connections).values()].map(({partIndex,pin})=>({
    partIndex,pin,bodyIndex:null,positionMm:null,basis:'unknown',featureIndex:null,evidence:'Fixture endpoints have no measured coordinates.',sourceUrl:''
  }));
  assert.ok(d.connections.length>160&&d.terminals.length>320);
  assert.equal(validate(d).connections.length,MAX_INTERACTION_CONNECTIONS);
  const invalid=structuredClone(d);invalid.connections.at(-1).fromPartIndex=999;
  assert.throws(()=>validate(invalid),/接线端点无效/);
  const tooMany=structuredClone(d);
  tooMany.connections.push(wire('ground',4,'GROUND_'+added,10,'RETURN_'+added));
  assert.throws(()=>validate(tooMany),/interaction.connections 超出列表范围/);
});
test('one review reports independent mechanical, circuit, and state failures together',()=>{
  const d=timerModel();
  d.controls[0].movingBodyIndices=[];
  d.connections=d.connections.filter(w=>w.toPin!=='COM');
  d.transitions=d.transitions.filter(t=>t.event!=='timer.expired');
  assert.throws(()=>validate(d),error=>{
    assert.match(error.message,/独立活动实体/);
    assert.match(error.message,/公共端或电源参考缺少回路/);
    assert.match(error.message,/缺少倒计时结束事件/);
    assert.equal(error.issues.length,3);
    return true;
  });
});
test('sourced system events are distinct from physical controls and replay without moving a fake button',()=>{
  const d=timerModel();
  d.systemEvents=[{id:'link.lost',label:'连接中断',kind:'connection',partIndex:4,sourcePins:['D4'],condition:'The input connection is reported disconnected',delayMs:null},
    {id:'link.timeout',label:'消息超时',kind:'timeout',partIndex:4,sourcePins:['D4'],condition:'No valid input message within the specified interval',delayMs:150}];
  d.transitions.push({from:'run',event:'link.lost',to:'pause',effect:'none'},{from:'run',event:'link.timeout',to:'pause',effect:'none'});
  const m=validate(d),running=input(m,initialInteraction(m),'push');
  const stopped=stepInteraction(m,running,{systemEventId:'link.lost'});
  assert.equal(stopped.stateId,'pause');assert.deepEqual(stopped.controlValues,running.controlValues);
  assert.equal(stepInteraction(m,running,{systemEventId:'link.timeout'}).stateId,'pause');
  assert.equal(stepInteraction(m,running,{controlId:'link.lost'}),running);
  assert.equal(stepInteraction(m,running,{systemEventId:'unreported'}),running);
  for(const change of [x=>{x.systemEvents[0].id='push'},x=>{x.systemEvents[0].partIndex=999},x=>{x.systemEvents[0].sourcePins=['UNCONNECTED']},
    x=>{x.systemEvents[1].delayMs=0},x=>{x.systemEvents[0].delayMs=150},x=>{x.transitions.at(-1).effect='reset'}]){
    const bad=structuredClone(d);change(bad);assert.throws(()=>validate(bad),/交互设计/);
  }
});
test('a pushbutton and LED can operate without a display, timer or rotary input',()=>{
  const d=timerModel();
  d.timer=null;d.controls.shift();d.outputs.shift();
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'lamp',mode:id}]}));
  d.initialState='off';d.transitions=[{from:'off',event:'push',to:'on',effect:'none'},{from:'on',event:'push',to:'off',effect:'none'}];
  const model=validate(d),s=input(model,initialInteraction(model),'push');assert.equal(s.outputs.lamp,'on');
  assert.equal(tick(model,s,4),s);assert.equal(input(model,s,'push').outputs.lamp,'off');
});

test('distinct USB touch events share their real data pin without inventing per-button wires',()=>{
  const board=structuredClone(design),d=timerModel();board.parts[5]={...board.parts[5],name:'USB touch panel',model:'USB CDC panel',spec:'USB data'};
  const touch={...d.controls[1],kind:'touch',movingBodyIndices:[],step:0,signalPins:['D+']};
  d.controls=[{...touch,id:'on',label:'on'},{...touch,id:'off',label:'off'}];d.timer=null;d.outputs.shift();
  d.connections.splice(0,3,wire('signal',5,'D+',4,'USB-D+'));
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'lamp',mode:id}]}));
  d.initialState='off';d.transitions=[{from:'off',event:'on',to:'on',effect:'none'},{from:'on',event:'off',to:'off',effect:'none'}];
  assert.doesNotThrow(()=>validateInteraction(d,board));
  d.controls.forEach(c=>c.signalPins=['GPIO0']);d.connections[0].fromPin='GPIO0';
  assert.throws(()=>validateInteraction(d,board),/重复使用/);
});

test('page and Agent commands use the USB path without requiring a phone or button CAD body',()=>{
 const board=structuredClone(design),d=timerModel();
 board.parts[5]={...board.parts[5],name:'用户手机',model:'USB Host phone',spec:'USB CDC',kind:'provided',role:'external',placement:'loose'};
 const oldBodies=board.cadPlan.bodies,indexMap=new Map();
 board.cadPlan.bodies=oldBodies.filter((b,i)=>{if(b.partIndex===5)return false;indexMap.set(i,indexMap.size);return true;});
 d.timer=null;d.outputs.shift();d.outputs.forEach(o=>o.bodyIndices=o.bodyIndices.map(i=>indexMap.get(i)));
 const command={id:'jog',label:'页面点动',kind:'command',partIndex:5,fixedBodyIndex:null,movingBodyIndices:[],axis:[],pivotMm:[],step:0,range:null,signalPins:['D+']};
 d.controls=[command];d.connections.splice(0,3,wire('signal',5,'D+',4,'USB-D+'));
 d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'lamp',mode:id}]}));d.initialState='off';
 d.transitions=[{from:'off',event:'jog.down',to:'on',effect:'none'},...['up','cancel'].map(phase=>({from:'on',event:'jog.'+phase,to:'off',effect:'none'}))];
 validateInteraction(d,board);assert.deepEqual(replayInteraction(d).issues,[]);
 const running=stepInteraction(d,initialInteraction(d),{controlId:'jog',phase:'down'});assert.equal(running.stateId,'on');
 for(const phase of ['up','cancel'])assert.equal(stepInteraction(d,running,{controlId:'jog',phase}).stateId,'off');
 const unbound=structuredClone(d);unbound.connections.shift();assert.throws(()=>validateInteraction(unbound,board),/控制器输入脚/);
 const physical=structuredClone(d);physical.controls[0].kind='touch';assert.throws(()=>validateInteraction(physical,board),/固定基座/);
 const fakeBody=structuredClone(d);fakeBody.controls[0].fixedBodyIndex=0;assert.throws(()=>validateInteraction(fakeBody,board),/不绑定 CAD/);
});
test('multi-axis controls can share USB and use more than 120 distinct transitions',()=>{
  const board=structuredClone(design),d=timerModel();board.parts[5]={...board.parts[5],name:'USB panel',model:'USB touch fixture',spec:'USB CDC'};
  d.controls=Array.from({length:20},(_,i)=>({...d.controls[1],id:'action'+i,label:'Action '+i,kind:'touch',movingBodyIndices:[],step:1,signalPins:['D+']}));
  d.timer=null;d.outputs.shift();d.connections.splice(0,3,wire('signal',5,'D+',4,'USB-D+'));
  d.states=Array.from({length:8},(_,i)=>({id:'s'+i,label:'State '+i,clock:'hold',outputs:[{outputId:'lamp',mode:i%2?'on':'off'}]}));
  d.initialState='s0';d.transitions=d.states.flatMap((s,i)=>d.controls.map(c=>({from:s.id,event:c.id,to:'s'+((i+1)%8),effect:'none'})));
  assert.equal(validateInteraction(d,board).transitions.length,160);
  const bad=structuredClone(d);bad.controls.push(...Array.from({length:13},(_,i)=>({...bad.controls[0],id:'extra'+i})));
  assert.throws(()=>validateInteraction(bad,board),/1–32/);
  d.controls[0].movingBodyIndices=[11];assert.throws(()=>validateInteraction(d,board),/触摸面应保持固定/);
});

test('a signed rotary increment retains its handedness; linear strokes still require positive travel',()=>{
  const d=timerModel();d.controls[0].step=-15;
  const m=validate(d),s=input(m,initialInteraction(m),'wheel',1);
  assert.equal(s.controlValues.wheel,-15);assert.equal(input(m,s,'wheel',-1).controlValues.wheel,0);
  d.controls[0].step=0;assert.throws(()=>validate(d),/有效角度/);
  d.controls[0].step=-15;d.controls[1].step=-.5;assert.throws(()=>validate(d),/有效角度/);
});

test('an actuator motion output can bind to the load of its declared joint, while other outputs retain ownership checks',()=>{
  const board=structuredClone(design),d=timerModel();
  board.parts[3]={...board.parts[3],name:'Fixture motor',model:'M1',qty:1};
  board.cadPlan.joints=[{fixedBodyIndex:3,movingBodyIndices:[11]}];
  d.outputs[1]={...d.outputs[1],kind:'motion',bodyIndices:[11]};
  d.states.forEach(s=>s.outputs.forEach(o=>{if(o.outputId==='lamp'&&o.mode==='breathe')o.mode='on';}));
  assert.doesNotThrow(()=>validateInteraction(d,board));
  const other=structuredClone(board);other.cadPlan.joints[0].fixedBodyIndex=5;
  assert.throws(()=>validateInteraction(d,other),/对应的 CAD 实体/);
  const repeated=structuredClone(board),mapped=structuredClone(d),second=repeated.cadPlan.bodies.length;
  repeated.parts[3].qty=2;repeated.cadPlan.bodies.push({...structuredClone(repeated.cadPlan.bodies[3]),positionMm:[100,0,0]});
  assert.throws(()=>validateInteraction(mapped,repeated),/对应的 CAD 实体/);
  mapped.terminals=[...connectedTerminalPins(mapped.connections).values()].map(t=>({...t,bodyIndex:t.partIndex===3&&t.pin==='DIN'?3:null,positionMm:null,featureIndex:null,basis:'unknown',sourceUrl:'',evidence:'Fixture instance binding'}));
  assert.doesNotThrow(()=>validateInteraction(mapped,repeated));
  mapped.terminals.find(t=>t.partIndex===3&&t.pin==='DIN').bodyIndex=second;
  assert.throws(()=>validateInteraction(mapped,repeated),/对应的 CAD 实体/);
  board.cadPlan.joints[0].movingBodyIndices=[10];assert.throws(()=>validateInteraction(d,board),/对应的 CAD 实体/);
  board.cadPlan.joints[0].movingBodyIndices=[11];d.outputs[1].kind='light';assert.throws(()=>validateInteraction(d,board),/对应的 CAD 实体/);
});

test('a bounded rotary switch changes state only on a reachable signed contact edge',()=>{
 const source=timerModel(),c={...source.controls[0],step:-90,range:{min:-90,max:0,initial:0},signalPins:[]};
 const model=validate({...source,controllerPartIndex:null,timer:null,controls:[c],outputs:[],connections:[],terminals:[],signalChannels:[],
  initialState:'off',states:['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[]})),
  transitions:[{from:'off',event:c.id+'.decrease',to:'on',effect:'none'},{from:'on',event:c.id+'.increase',to:'off',effect:'none'}]});
 let s=initialInteraction(model);assert.equal(input(model,s,c.id,-1),s);
 s=input(model,s,c.id,1);assert.equal(s.stateId,'on');assert.equal(s.controlValues[c.id],-90);
 assert.equal(input(model,s,c.id,1),s);
 s=input(model,s,c.id,-1);assert.equal(s.stateId,'off');assert.equal(s.controlValues[c.id],0);
 assert.deepEqual(replayInteraction(model).issues,[]);
});

test('held input events drive a declared axis in both directions and release or cancel stops the preview',()=>{
 const board=structuredClone(design),model=timerModel(),motor={...model.outputs[1],kind:'motion',bodyIndices:[11],motion:{type:'joint',index:0,speed:10}};
 board.parts[3]={...board.parts[3],name:'Fixture motor',model:'M1',qty:1};
 board.cadPlan.joints=[{fixedBodyIndex:3,movingBodyIndices:[11],actuatorPartIndex:3,minDegrees:-20,maxDegrees:20}];
 model.controls=model.controls.map((c,i)=>({...c,id:i?'minus':'plus',kind:'touch',movingBodyIndices:[],step:0}));model.timer=null;model.outputs=[motor];model.initialState='idle';
 model.states=[['idle','off'],['positive','forward'],['negative','reverse']].map(([id,mode])=>({id,label:id,clock:'hold',outputs:[{outputId:motor.id,mode}]}));
 model.transitions=[['plus','positive'],['minus','negative']].flatMap(([id,state])=>[
  {from:'idle',event:id+'.down',to:state,effect:'none'},...['up','cancel'].map(phase=>({from:state,event:id+'.'+phase,to:'idle',effect:'none'}))]);
 validateInteraction(model,board);assert.deepEqual(replayInteraction(model).issues,[]);
 let s=stepInteraction(model,initialInteraction(model),{controlId:'plus',phase:'down'});
 let pose=advanceMotionPreview(model,s,board.cadPlan,{},1);assert.equal(pose.jointValues[0],10);
 pose=advanceMotionPreview(model,s,board.cadPlan,pose,100);assert.equal(pose.jointValues[0],20);
 s=stepInteraction(model,s,{controlId:'plus',phase:'up'});assert.equal(advanceMotionPreview(model,s,board.cadPlan,pose,1).changed,false);
 s=stepInteraction(model,s,{controlId:'minus',phase:'down'});pose=advanceMotionPreview(model,s,board.cadPlan,pose,1);assert.equal(pose.jointValues[0],10);
 s=stepInteraction(model,s,{controlId:'minus',phase:'cancel'});assert.equal(s.stateId,'idle');assert.equal(advanceMotionPreview(model,s,board.cadPlan,pose,1).changed,false);
 const noRelease=structuredClone(model);noRelease.transitions=noRelease.transitions.filter(t=>t.event!=='plus.cancel');assert.throws(()=>validateInteraction(noRelease,board),/取消事件停止/);
 const badAxis=structuredClone(model);badAxis.outputs[0].motion.index=1;assert.throws(()=>validateInteraction(badAxis,board),/绑定实际关节/);
});

test('wires between explicit instances of one BOM row are external, not invented internal chip channels',()=>{
  const board=structuredClone(design),d=timerModel(),i=board.parts.length,first=board.cadPlan.bodies.length;
  board.parts.push({name:'Two pass-through fixtures',model:'M2',qty:2});
  for(let k=0;k<2;k++)board.cadPlan.bodies.push({name:'Fixture '+k,partIndex:i,role:'reference',positionMm:[k*20,0,0],features:[{op:'add',shape:'box',sizeMm:[4,4,4],centerMm:[0,0,0]}]});
  const source=d.connections.find(w=>w.fromPin==='D6');source.toPartIndex=i;source.toPin='unit1.IN';
  d.connections.push(wire('signal',i,'unit1.IN',i,'unit2.IN'),wire('signal',i,'unit2.IN',6,'1'));
  d.terminals=[...connectedTerminalPins(d.connections).values()].map(t=>({...t,bodyIndex:t.partIndex===i?first+(t.pin==='unit2.IN'?1:0):null,positionMm:null,featureIndex:null,basis:'unknown',sourceUrl:'',evidence:'Fixture endpoint mapping, contact location unknown'}));
  assert.doesNotThrow(()=>validateInteraction(d,board));
  const same=structuredClone(d);same.terminals.find(t=>t.partIndex===i&&t.pin==='unit2.IN').bodyIndex=first;
  assert.throws(()=>validateInteraction(same,board),/同一器件不同针脚/);
  board.parts[i].qty=1;assert.throws(()=>validateInteraction(d,board),/同一器件不同针脚/);
});
test('a physical power switch uses its two power contacts without inventing a GPIO input',()=>{
  const board=structuredClone(design),d=timerModel();
  board.parts[5]={...board.parts[5],name:'机械电源开关',model:'two-contact rotary switch',spec:'串联电源触点'};
  d.controls=[{...d.controls[0],signalPins:['IN','OUT']}];d.timer=null;d.outputs=[d.outputs[1]];
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'lamp',mode:id}]}));
  d.initialState='off';d.transitions=[{from:'off',event:'wheel',to:'on',effect:'none'},{from:'on',event:'wheel',to:'off',effect:'none'}];
  d.connections=d.connections.filter(w=>!(w.kind==='signal'&&w.fromPartIndex===5)&&!(w.kind==='power'&&w.toPartIndex===4));
  d.connections.push(wire('power',10,'VBUS',5,'IN'),wire('power',5,'OUT',4,'USB-VBUS'));
  assert.doesNotThrow(()=>validateInteraction(d,board));
  const detached=structuredClone(d);detached.controls[0].movingBodyIndices=[];
  assert.throws(()=>validateInteraction(detached,board),/独立活动实体/);
  d.connections=d.connections.filter(w=>!(w.fromPartIndex===5&&w.fromPin==='OUT'));
  assert.throws(()=>validateInteraction(d,board),/明确的控制器输入脚/);
});
test('a supplied USB host can send commands and receive a display response on the same physical data wire',()=>{
  const board=structuredClone(design),d=timerModel();
  board.parts[5]={...board.parts[5],name:'用户手机',model:'USB Host phone',spec:'USB OTG host with internal battery',kind:'provided',role:'external',placement:'loose'};
  board.parts[4]={...board.parts[4],spec:board.parts[4].spec+' USB device'};
  d.controls=[{...d.controls[1],id:'tap',kind:'touch',movingBodyIndices:[],step:0,signalPins:['D+']}];d.timer=null;
  d.outputs=[{id:'readout',label:'手机显示',kind:'display',partIndex:5,bodyIndices:[5],signalPin:'D+'}];
  d.connections=[wire('signal',5,'D+',4,'D+'),wire('power',5,'VBUS',4,'USB-VBUS'),wire('ground',5,'GND',4,'GND')];
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'readout',mode:id}]}));
  d.initialState='off';d.transitions=[{from:'off',event:'tap',to:'on',effect:'none'},{from:'on',event:'tap',to:'off',effect:'none'}];
  const model=validateInteraction(d,board);assert.equal(model.connections.length,3);
  assert.equal(input(model,initialInteraction(model),'tap').outputs.readout,'on');
  const crossed=structuredClone(d);crossed.connections[0].toPin='D-';
  assert.throws(()=>validateInteraction(crossed,board),/正负端接反/);
  const unpowered=structuredClone(d);unpowered.connections[1]=wire('power',10,'VBUS',4,'USB-VBUS');
  assert.throws(()=>validateInteraction(unpowered,board),/手机显示 的电源输入脚/);
  board.parts[4].spec='GPIO only';
  assert.throws(()=>validateInteraction(d,board),/需要从控制器输出脚获得信号/);
});
test('USB test pads preserve bidirectional data and a board can identify USB through retained source evidence',()=>{
  const board=structuredClone(design),d=timerModel(),i=board.parts.length;
  board.parts[5]={...board.parts[5],name:'USB Host phone',model:'Phone',spec:'USB OTG',kind:'provided',role:'external',placement:'loose'};
  board.parts[4]={...board.parts[4],name:'MCU board',model:'M3',spec:'Controller',geometryReference:{detail:'Manufacturer documentation identifies native USB D+ and D-.'}};
  board.parts.push({name:'USB test board',model:'USB breakout',spec:'Inline test pad'});
  d.controls=[{...d.controls[1],id:'tap',kind:'touch',movingBodyIndices:[],step:0,signalPins:['D+']}];d.timer=null;
  d.outputs=[{id:'readout',label:'Phone readout',kind:'display',partIndex:5,bodyIndices:[5],signalPin:'D+'}];
  d.connections=[wire('signal',5,'D+',i,'TP_DP'),wire('signal',i,'TP_DP',4,'D+'),wire('power',5,'VBUS',4,'VBUS'),wire('ground',5,'GND',4,'GND')];
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'readout',mode:id}]}));d.initialState='off';
  d.transitions=[{from:'off',event:'tap',to:'on',effect:'none'},{from:'on',event:'tap',to:'off',effect:'none'}];
  assert.doesNotThrow(()=>validateInteraction(d,board));
  const cross=structuredClone(d);cross.connections[0].toPin='TP_DM';assert.throws(()=>validateInteraction(cross,board),/正负端接反/);
  board.parts[4].modelSourceInvalidated=true;assert.throws(()=>validateInteraction(d,board),/需要从控制器输出脚获得信号/);
});
test('legacy static projects and a manual linkage do not need a fictitious circuit or timer',()=>{
  assert.equal(validateInteraction(undefined),null);assert.equal(initialInteraction(null),null);
  const d=timerModel();d.timer=null;d.controllerPartIndex=null;d.controls=[{...d.controls[1],signalPins:[]}];
  d.outputs=[];d.connections=[];d.states=[{id:'rest',label:'原位',outputs:[],clock:'hold'}];
  d.initialState='rest';d.transitions=[];
  const model=validate(d),s=initialInteraction(model);
  assert.equal(input(model,s,'push').stateId,'rest');assert.equal(s.remainingSeconds,null);
});

test('D6 → enabled AHCT125 channel → series resistor → Jewel DIN, with no invented direct wire',()=>{
  const parts=[...design.parts,{name:'四路缓冲器',model:'TI SN74AHCT125N'}],i=parts.length-1;
  const board={...design,parts},d=timerModel(),signal=d.connections.find(w=>w.fromPin==='D6');
  signal.toPartIndex=i;signal.toPin='1A';
  d.connections.push(wire('signal',i,'1Y',6,'1'),wire('power',4,'5V',i,'VCC'),
    wire('ground',4,'GND',i,'GND'),wire('ground',4,'GND',i,'/1OE'));
  const run=x=>validateInteraction(x,board);
  assert.equal(run(d),d);
  for (const change of [
    x=>{x.connections.find(w=>w.fromPartIndex===i).fromPin='2Y'},
    x=>{x.connections=x.connections.filter(w=>w.toPin!=='/1OE')},
    x=>{x.connections=x.connections.filter(w=>!(w.toPartIndex===i && w.toPin==='VCC'))},
    x=>{x.connections=x.connections.filter(w=>!(w.toPartIndex===i && w.toPin==='GND'))},
    x=>{x.connections.find(w=>w.fromPin==='D6').toPin='1Y'},
    x=>{x.connections.push(wire('signal',i,'1A',i,'2Y'))}]) {
    const broken=structuredClone(d);change(broken);assert.throws(()=>run(broken),/交互设计/,String(change));
    // Circuit failures still leave its CAD eligible for the independent sweep.
    assert.equal(validateInteractionGeometry(broken,board),broken);
  }
});
test('other device internals need an explicitly sourced, connected channel matching the chosen BOM model',()=>{
  const parts=[...design.parts,{name:'光隔离模块示例',model:'EXAMPLE-ISO42'}],i=parts.length-1;
  const d=timerModel(),signal=d.connections.find(w=>w.fromPin==='D6');
  signal.toPartIndex=i; signal.toPin='IN-A';
  d.connections.push(wire('signal',i,'OUT-A',6,'1'));
  const run=x=>validateInteraction(x,{...design,parts});
  assert.throws(()=>run(d),/DIN/);
  d.signalChannels=[{partIndex:i,model:'EXAMPLE-ISO42',inputPin:'IN-A',outputPin:'OUT-A',
    sourceUrl:'https://example.org/module-test-datasheet',evidence:'Channel A transfers IN-A to OUT-A.'}];
  assert.equal(run(d),d);
  for (const [field,value] of [['model','DIFFERENT'],['sourceUrl','datasheet pending'],['outputPin','OUT-B'],['evidence','No mapping available']]) {
    const broken=structuredClone(d);broken.signalChannels[0][field]=value;assert.throws(()=>run(broken),/交互设计/);
  }
  d.connections='bad';d.states=null;d.controls[0].signalPins=null;
  assert.equal(validateInteractionGeometry(d,{...design,parts}),d);
  d.controls[0].axis=[1,0,0];assert.throws(()=>validateInteractionGeometry(d,{...design,parts}),/旋转轴/);
});

test('one half-duplex wire supports both documented directions across a data switch',()=>{
  const parts=[...design.parts,{name:'双向半双工开关试件',model:'EXAMPLE-SW42'}],i=parts.length-1;
  const d=timerModel(),upstream=d.connections.find(w=>w.fromPin==='D6');
  Object.assign(upstream,{toPartIndex:i,toPin:'A',bidirectional:true});
  d.connections=d.connections.filter(w=>w.fromPartIndex!==6);
  const downstream={...wire('signal',i,'B',3,'DIN'),bidirectional:true};
  d.connections.push(downstream);
  d.signalChannels=[['A','B'],['B','A']].map(([inputPin,outputPin])=>({
    partIndex:i,model:'EXAMPLE-SW42',inputPin,outputPin,sourceUrl:'https://example.org/switch-test',
    evidence:'When selected, signal passes from '+inputPin+' to '+outputPin+'.'
  }));
  const run=()=>validateInteraction(d,{...design,parts});
  assert.equal(run(),d);
  downstream.bidirectional=false;
  assert.throws(run,/B → A/);
  downstream.bidirectional=true;
  d.connections.find(w=>w.kind==='ground').bidirectional=true;
  assert.throws(run,/双向接线只用于/);
});

test('only unique automatic expiry aliases on running-to-held states migrate; ambiguity and unrelated events remain errors',async()=>{
 const {normalizeInteractionTimerAliases}=await import('../interaction-model.js');
 for(const alias of ['timeout','timerExpired','timer.elapsed']){
  const m=timerModel();const e=m.transitions.find(t=>t.event==='timer.expired');e.event=alias;
  const {model,corrections}=normalizeInteractionTimerAliases(m);
  assert.equal(corrections.length,1);assert.equal(e.event,alias);assert.equal(validate(m).transitions[corrections[0].transitionIndex].event,'timer.expired');
  assert.equal(normalizeInteractionTimerAliases(model).model,model);
 }
 const alias=()=>{const m=timerModel();m.transitions.find(t=>t.event==='timer.expired').event='timeout';return m;};
 for(const change of [
  m=>{m.timer=null;},m=>{m.controls[0].id='timeout';},m=>{m.transitions.find(t=>t.event==='timeout').from='pause';},
  m=>{m.transitions.find(t=>t.event==='timeout').to='run';},m=>{m.transitions.find(t=>t.event==='timeout').effect='restart';},
  m=>{m.transitions.push({...m.transitions.find(t=>t.event==='timeout'),event:'timer.expired'});},
  m=>{m.transitions.push({...m.transitions.find(t=>t.event==='timeout'),event:'timerExpired'});},
  m=>{m.transitions.find(t=>t.event==='timeout').event='tick';}
 ]){
  const m=alias();change(m);assert.equal(normalizeInteractionTimerAliases(m).corrections.length,0);
  assert.throws(()=>validate(m));
 }
 const unknown=alias();unknown.transitions.find(t=>t.event==='timeout').event='timeout-ish';
 assert.throws(()=>validate(unknown),/timeout-ish.*timer\.expired/);
 const namedControl=timerModel();namedControl.controls.find(c=>c.id==='push').id='timeout';
 for(const t of namedControl.transitions)if(t.event==='push')t.event='timeout';
 assert.equal(normalizeInteractionTimerAliases(namedControl).corrections.length,0);
 assert.equal(validate(namedControl).controls.find(c=>c.kind==='press').id,'timeout');
});
