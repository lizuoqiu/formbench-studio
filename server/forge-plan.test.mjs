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
  const origin='http://127.0.0.1:'+port,child=spawn(process.execPath,['server/local.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),FORGECAD_RESEARCH_AUTOMATION:'false',FORGECAD_ENTERPRISE_AUTOMATION:'false'},stdio:['ignore','pipe','pipe']});
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

test('an explicit ForgeCAD request reports configuration errors without returning another engine',async()=>{
  const off=await forgePlan(req({cadPlan:plan,engine:'forgecad'}));
  assert.equal(off.status,503);assert.equal((await off.json()).engine,'ForgeCAD CLI');
  const env={FORGECAD_RESEARCH_AUTOMATION:'true',FORGECAD_BIN:process.execPath};
  const external=new Request('https://example.test/api/forge/plan',{method:'POST',body:JSON.stringify({cadPlan:plan})});
  assert.equal((await forgePlan(external,env)).status,403);
  const wrong=await forgePlan(req({cadPlan:plan}),env);
  assert.equal(wrong.status,503);assert.match((await wrong.json()).error,/0\.8\.2/);
});

test('the selected CLI receives separate generated parts and its binary STL reaches the caller',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path'),{tmpdir}=await import('node:os');
  const dir=await mkdtemp(join(tmpdir(),'formbench-cli-test-'));
  try {
    const bin=join(dir,'forgecad.cjs');
    const program=`#!${process.execPath}
      const fs=require('node:fs');
      const args=process.argv.slice(2);
      if(args.join(' ')==='--version') { console.log('0.99.0-mock');process.exit(0); }
      if(args[0]!=='export'||args[1]!=='stl'||args[3]!=='--output') process.exit(1);
      const src=fs.readFileSync(args[2],'utf8');
      if(!src.includes('return body;')||process.env.FORMBENCH_TEST_PRIVATE) process.exit(2);
      const bytes=Buffer.alloc(134);
      bytes.writeUInt32LE(1,80);bytes.writeFloatLE(1,108);bytes.writeFloatLE(1,124);
      fs.writeFileSync(args[4],bytes);`;
    await writeFile(bin,program,{mode:0o700});
    const env={FORGECAD_ENTERPRISE_AUTOMATION:'true',FORGECAD_BIN:bin,FORMBENCH_TEST_PRIVATE:'private'};
    const response=await forgePlan(req({cadPlan:plan}),env), result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.engine,'ForgeCAD CLI 0.99.0-mock');
    assert.deepEqual(result.bodies.map(b=>b.positionMm),plan.bodies.map(b=>b.positionMm));
    assert.deepEqual(result.bodies.map(b=>b.role),['printed','reference']);
    assert.equal(new Set(result.bodies.map(b=>b.fileName)).size,2);
    assert.equal(Buffer.from(result.bodies[1].stlBase64,'base64').length,134);
  } finally {await rm(dir,{recursive:true,force:true})}
});

test('editable assembly positions named bodies independently and parameterizes only moving bodies',async()=>{
  const {cadPlanToForgeScript}=await import('../forge-source.js');
  const p={version:1,bodies:[
    body([feature('add','box',[10,8,4])],{name:'座 "A"',partIndex:0}),
    body([feature('add','ellipsoid',[8,10,6])],{name:'拳',partIndex:1,role:'reference'})
  ],motions:[{type:'prismatic',name:'伸出',axis:[0,-1,0],travelMm:22,movingBodyIndices:[1],actuatorPartIndex:0,guidePartIndex:1,controllerPartIndex:0}]};
  const source=cadPlanToForgeScript(p);
  assert.ok(source.includes(JSON.stringify('座 "A"')));
  assert.match(source,/max:22/);
  assert.match(source,/buildPart0\(\)\.translate\(30, 40, 50\)/);
  assert.match(source,/buildPart1\(\)\.translate\(30, 40 \+ \(-1\) \* stroke0, 50\)/);
});

test('installed research ForgeCAD produces a measured through-hole and reference geometry',
  {skip:process.env.FORGECAD_RESEARCH_AUTOMATION!=='true'||!process.env.FORGECAD_BIN},
  async()=>{
    const result=await forgePlan(req({cadPlan:plan,engine:'forgecad'}),process.env);
    const json=await result.json();assert.equal(result.status,200,json.error);
    assert.equal(json.engine,'ForgeCAD CLI 0.8.2');
    const shell=summary(json.bodies[0].stlBase64),reference=summary(json.bodies[1].stlBase64);
    assert.deepEqual(shell.lo,[-6,-5,-4]);assert.deepEqual(shell.hi,[6,5,4]);assert.ok(Math.abs(shell.volume-832)<.001);
    assert.deepEqual(reference.lo,[-1,-1,1]);assert.deepEqual(reference.hi,[7,9,9]);assert.ok(reference.n>300);
});
