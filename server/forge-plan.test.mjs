import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {forgePlan} from './forge-plan.mjs';
const feature=(op,shape,sizeMm,centerMm=[0,0,0])=>({op,shape,sizeMm,centerMm});
const body=(features,fields={})=>({name:'试件',partIndex:0,role:'printed',positionMm:[30,40,50],features,...fields});
const plan={version:1,bodies:[
  body([feature('add','box',[12,10,8]),feature('cut','box',[4,4,12])]),
  body([feature('add','ellipsoid',[8,10,6],[3,4,5]),feature('add','cylinder',[3,3,8],[3,4,5])],{name:'曲面和圆柱',role:'reference'})]};
const req=p=>new Request('http://127.0.0.1/api/forge/plan',{method:'POST',body:JSON.stringify(p)});
function summary(data){
  const b=Buffer.from(data,'base64'),n=b.readUInt32LE(80);assert.equal(b.length,84+n*50);
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];let vol=0;
  for(let i=0;i<n;i++){
    const [a,c,d]=Array.from({length:3},(_,j)=>Array.from({length:3},(_,k)=>{
      const v=b.readFloatLE(96+i*50+j*12+k*4);lo[k]=Math.min(lo[k],v);hi[k]=Math.max(hi[k],v);return v}));
    vol+=(a[0]*(c[1]*d[2]-c[2]*d[1])+a[1]*(c[2]*d[0]-c[0]*d[2])+a[2]*(c[0]*d[1]-c[1]*d[0]))/6;
  }
  return {lo,hi,volume:Math.abs(vol),n};
}
test('loopback HTTP compiles one plan into two separate, measured real STL meshes',async()=>{
  // Ask the OS for an unused port, then start the same loopback server as the app.
  const {createServer}=await import('node:net');const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin='http://127.0.0.1:'+port,child=spawn(process.execPath,['server/local.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([c])=>{throw Error('server exited: '+c)})]);
    const opts={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({cadPlan:plan})},endpoint=origin+'/api/forge/plan';
    assert.equal((await fetch(endpoint,{...opts,headers:{...opts.headers,origin:'https://example.invalid'}})).status,403);
    const res=await fetch(endpoint,opts),j=await res.json();assert.equal(res.status,200,JSON.stringify(j));assert.equal(j.engine,'Manifold 3.5.1');assert.equal(j.bodies.length,2);
    let [shell,round]=j.bodies;assert.notEqual(shell.fileName,round.fileName);assert.deepEqual(shell.positionMm,[30,40,50]);
    const a=summary(shell.stlBase64);assert.deepEqual(a.lo,[-6,-5,-4]);assert.deepEqual(a.hi,[6,5,4]);assert.ok(Math.abs(a.volume-(12*10*8-4*4*8))<.001);
    const b=summary(round.stlBase64);assert.deepEqual(b.lo,[-1,-1,1]);assert.deepEqual(b.hi,[7,9,9]);assert.ok(b.n>300);
  }finally{child.kill()}
});
test('invalid or empty plans never execute supplied code; impossible solids do not yield partial downloads',async()=>{
  for(const bad of [{cadPlan:{...plan,code:'return anything'}},{cadPlan:{version:1,bodies:[]}},{cadPlan:plan,path:'other'}])assert.equal((await forgePlan(req(bad))).status,400);
  const zero=body([feature('add','box',[1,1,1]),feature('cut','box',[5,5,5])]);const r=await forgePlan(req({cadPlan:{version:1,bodies:[plan.bodies[0],zero]}}));assert.equal(r.status,422);const j=await r.json();assert.ok(j.error);assert.equal(j.bodies,undefined);
});

test('rotates about the feature center before translating: fixed X then Y then Z',async()=>{
  const cadPlan={version:1,bodies:[body([{...feature('add','box',[2,6,10],[11,5,3]),rotationDeg:[90,90,0]}])]};
  const res=await forgePlan(req({cadPlan})),result=await res.json();assert.equal(res.status,200,JSON.stringify(result));
  const mesh=summary(result.bodies[0].stlBase64);
  // Half spans [1,3,5] -> [1,5,3] -> [3,5,1] around [11,5,3].
  assert.deepEqual(mesh.lo,[8,0,2]);assert.deepEqual(mesh.hi,[14,10,4]);assert.ok(Math.abs(mesh.volume-120)<.00001);
});
