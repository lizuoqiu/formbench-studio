import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAssemblyWiring} from '../assembly-wires.js';

const {design:v5}=JSON.parse(readFileSync(new URL('../samples/shared/reading-timer/v5.json',import.meta.url)));
const connect=(kind,fromPartIndex,fromPin,toPartIndex,toPin)=>({kind,fromPartIndex,fromPin,toPartIndex,toPin});
const fixture=()=>({
  parts:[{name:'控制板',placement:'mounted'},{name:'输入板',placement:'mounted'}],
  cadPlan:{bodies:[{partIndex:0,positionMm:[20,10,5]},{partIndex:1,positionMm:[-30,5,12]}]},
  interaction:{connections:[connect('signal',0,'D4',1,'CLK'),connect('ground',1,'GND',0,'GND')]}
});
const sampleAnchor=(_,partIndex,pin)=>({
  bodyIndex:partIndex,localMm:[pin==='GND'?2:0,2,1],exitDirection:[0,0,1],kind:'modeled',
  evidence:'测试 CAD 针脚坐标',sourceUrl:''
});

test('Reading Timer V5 maps all twelve internal conductors and two USB mating contacts separately',()=>{
  const result=buildAssemblyWiring(v5);
  assert.deepEqual(result.routes.map(w=>w.connectionIndex),Array.from({length:12},(_,i)=>i+2));
  assert.deepEqual(result.mates.map(w=>w.connectionIndex),[0,1]);
  assert.deepEqual(result.unresolved,[]);
  assert.ok(result.mates.every(w=>w.points.length===0 && w.routing==='mate'));
  const data=result.routes.find(w=>w.from.pin==='D4' && w.to.pin==='SDA');
  assert.deepEqual([data.from.bodyIndex,data.to.bodyIndex],[4,7]);
  for (const route of result.routes) {
    assert.equal(route.routing,'illustrative');
    assert.ok(route.points.length>3 && route.points.every(p=>p.length===3 && p.every(Number.isFinite)));
    assert.deepEqual(route.points[0],route.from.worldMm);
    assert.deepEqual(route.points.at(-1),route.to.worldMm);
    for (const end of [route.from,route.to]) {
      assert.notDeepEqual(end.worldMm,v5.cadPlan.bodies[end.bodyIndex].positionMm);
      assert.ok(end.evidence);
    }
  }
  const gnds=result.routes.flatMap(w=>[w.from,w.to]).filter(p=>p.partIndex===4 && p.pin==='GND');
  assert.ok(gnds.length>1 && gnds.every(p=>p.worldMm.every((v,i)=>v===gnds[0].worldMm[i])));
});
test('translation uses the owning body and exit directions are respected, for both wire directions',()=>{
  const d=fixture(),first=buildAssemblyWiring(d,sampleAnchor);
  const a=first.routes[0],back=first.routes[1];
  assert.deepEqual(a.from.worldMm,[20,12,6]);assert.deepEqual(a.to.worldMm,[-30,7,13]);
  assert.equal(a.from.origin,'model-map');assert.equal(a.quality,'modeled');
  assert.deepEqual(a.points[1].slice(0,2),a.from.worldMm.slice(0,2));
  assert.ok(a.points[1][2]>a.from.worldMm[2]);
  assert.deepEqual(a.points.at(-2).slice(0,2),a.to.worldMm.slice(0,2));
  assert.ok(a.points.at(-2)[2]>a.to.worldMm[2]);
  assert.ok(back.points.length>0);assert.deepEqual(buildAssemblyWiring(d,sampleAnchor),first);
  d.cadPlan.bodies[1].positionMm[0]+=123;
  assert.deepEqual(buildAssemblyWiring(d,sampleAnchor).routes[0].to.worldMm,[93,7,13]);
});
test('a design-supplied estimate overrides a model map, and an explicit unknown stays unlocated',()=>{
  const d=fixture();
  d.interaction.terminals=[{partIndex:0,pin:'D4',bodyIndex:0,positionMm:[1,4,2],basis:'estimated',
    evidence:'接线区有安装位置，焊盘间距待测。',sourceUrl:''}];
  const output=buildAssemblyWiring(d,sampleAnchor);
  assert.equal(output.routes[0].quality,'estimated');assert.equal(output.routes[0].from.origin,'declared');
  assert.deepEqual(output.routes[0].from.worldMm,[21,14,7]);
  d.interaction.terminals[0].basis='unknown';d.interaction.terminals[0].positionMm=null;
  const unknown=buildAssemblyWiring(d,sampleAnchor).unresolved[0];
  assert.equal(unknown.from.worldMm,null);assert.equal(unknown.from.origin,'declared');assert.deepEqual(unknown.points,[]);
  d.interaction.terminals=[];
  const invalid=buildAssemblyWiring(d,(_,p,pin)=>({...sampleAnchor(_,p,pin),bodyIndex:1-p}));
  assert.equal(invalid.routes.length,0);assert.equal(invalid.unresolved.length,2);
  assert.deepEqual(buildAssemblyWiring({...d,interaction:null}),{routes:[],mates:[],unresolved:[]});
});

test('saving known V5 terminal positions preserves how wires leave pads and approach encoder blades',()=>{
  const first=buildAssemblyWiring(v5),terminals=new Map();
  for (const w of first.routes) for (const e of [w.from,w.to]) {
    const origin=v5.cadPlan.bodies[e.bodyIndex].positionMm;
    terminals.set(e.partIndex+'/'+e.pin,{partIndex:e.partIndex,pin:e.pin,bodyIndex:e.bodyIndex,
      positionMm:e.worldMm.map((x,i)=>x-origin[i]),basis:e.basis,evidence:e.evidence,sourceUrl:e.sourceUrl});
  }
  const saved={...v5,interaction:{...v5.interaction,terminals:[...terminals.values()]}};
  const restored=buildAssemblyWiring(saved);
  first.routes.forEach((route,i)=>{
    assert.deepEqual(restored.routes[i].from.exitDirection,route.from.exitDirection);
    assert.deepEqual(restored.routes[i].to.exitDirection,route.to.exitDirection);
    route.points.forEach((p,k)=>p.forEach((x,j)=>assert.ok(Math.abs(restored.routes[i].points[k][j]-x)<1e-8)));
  });
});
