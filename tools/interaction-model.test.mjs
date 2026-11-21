import {wire,timerModel} from '../server/test-fixtures/timer-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateInteraction,validateInteractionGeometry,initialInteraction,stepInteraction} from '../interaction-model.js';

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
test('a pushbutton and LED can operate without a display, timer or rotary input',()=>{
  const d=timerModel();
  d.timer=null;d.controls.shift();d.outputs.shift();
  d.states=['off','on'].map(id=>({id,label:id,clock:'hold',outputs:[{outputId:'lamp',mode:id}]}));
  d.initialState='off';d.transitions=[{from:'off',event:'push',to:'on',effect:'none'},{from:'on',event:'push',to:'off',effect:'none'}];
  const model=validate(d),s=input(model,initialInteraction(model),'push');assert.equal(s.outputs.lamp,'on');
  assert.equal(tick(model,s,4),s);assert.equal(input(model,s,'push').outputs.lamp,'off');
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
