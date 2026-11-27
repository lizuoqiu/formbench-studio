import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedLocalServer} from './test-fixtures/local-server.mjs';
import {once} from 'node:events';
import {forgePlan} from './forge-plan.mjs';
const feature=(op,shape,sizeMm,centerMm=[0,0,0])=>({op,shape,sizeMm,centerMm});
const body=(features,fields={})=>({name:'试件',partIndex:0,role:'printed',positionMm:[30,40,50],features,...fields});
const plan={version:1,bodies:[
  body([feature('add','box',[12,10,8]),feature('cut','box',[4,4,12])]),
  body([feature('add','ellipsoid',[8,10,6],[3,4,5]),feature('add','cylinder',[3,3,8],[3,4,5])],{name:'曲面和圆柱',role:'reference'})]};
const req=p=>new Request('http://127.0.0.1/api/forge/plan',{method:'POST',body:JSON.stringify(p)});
test('CAD compilation and preview accept the final BOM row while explicit counts remain bounded',async()=>{
  const {MAX_DESIGN_PARTS,validateCadPlan}=await import('../cad-plan.js');
  const {previewCadPlan}=await import('../consumer-geometry.js');
  const last=MAX_DESIGN_PARTS-1;
  const cadPlan={version:1,bodies:[body([feature('add','box',[4,6,8])],{partIndex:last})]};
  assert.equal(previewCadPlan(cadPlan).bodies[0].partIndex,last);
  assert.throws(()=>validateCadPlan(cadPlan,last));
  assert.throws(()=>previewCadPlan(cadPlan,last));
  const response=await forgePlan(req({cadPlan})),result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.bodies[0].partIndex,last);
  assert.ok(Math.abs(summary(result.bodies[0].stlBase64).volume-192)<1e-6);
  assert.equal((await forgePlan(req({cadPlan:{version:1,bodies:[{...cadPlan.bodies[0],partIndex:MAX_DESIGN_PARTS}]}}))).status,400);
});
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
  const {origin,close}=await isolatedLocalServer(port,{FORGECAD_RESEARCH_AUTOMATION:'false',FORGECAD_ENTERPRISE_AUTOMATION:'false'});
  try{
    const opts={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({cadPlan:plan})},endpoint=origin+'/api/forge/plan';
    assert.equal((await fetch(endpoint,{...opts,headers:{...opts.headers,origin:'https://example.invalid'}})).status,403);
    const res=await fetch(endpoint,opts),j=await res.json();assert.equal(res.status,200,JSON.stringify(j));assert.equal(j.engine,'Manifold 3.5.1');assert.equal(j.bodies.length,2);
    let [shell,round]=j.bodies;assert.notEqual(shell.fileName,round.fileName);assert.deepEqual(shell.positionMm,[30,40,50]);
    const a=summary(shell.stlBase64);assert.deepEqual(a.lo,[-6,-5,-4]);assert.deepEqual(a.hi,[6,5,4]);assert.ok(Math.abs(a.volume-(12*10*8-4*4*8))<.001);
    const b=summary(round.stlBase64);assert.deepEqual(b.lo,[-1,-1,1]);assert.deepEqual(b.hi,[7,9,9]);assert.ok(b.n>300);
  }finally{await close()}
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
    await writeFile(bin,program.replace('const bytes=Buffer.alloc(134);',
      "if(args[2].endsWith('part-2.forge.js')){fs.writeFileSync(args[4],Buffer.alloc(84));process.exit(0)} const bytes=Buffer.alloc(134);"),{mode:0o700});
    const failed=await forgePlan(req({cadPlan:plan}),env),error=await failed.json();
    assert.equal(failed.status,422);assert.equal(error.bodies,undefined);
    assert.match(error.error,/实体 #1「曲面和圆柱」（BOM #0）.*实体为空/);
    await writeFile(bin,program.replace('const bytes=Buffer.alloc(134);','const bytes=Buffer.alloc(84+50000*50);').replace('bytes.writeUInt32LE(1,80);','bytes.writeUInt32LE(50000,80);'),{mode:0o700});
    const largePlan={version:1,bodies:Array.from({length:15},(_,i)=>({...plan.bodies[0],name:'Dense fixture '+i}))};
    const largeResponse=await forgePlan(req({cadPlan:largePlan}),env),large=await largeResponse.json();
    assert.equal(largeResponse.status,200,large.error);assert.equal(large.bodies.length,15);
    assert.ok(JSON.stringify(large).length>32*1024*1024);
    assert.ok(JSON.stringify(large).length<144*1024*1024);
    const tooLarge={version:1,bodies:Array.from({length:41},(_,i)=>({...plan.bodies[0],name:'Dense fixture '+i}))};
    const oversized=await forgePlan(req({cadPlan:tooLarge}),env),oversizedResult=await oversized.json();
    assert.equal(oversized.status,422);assert.match(oversizedResult.error,/整机网格总量超出 96 MiB/);assert.equal(oversizedResult.bodies,undefined);
  } finally {await rm(dir,{recursive:true,force:true})}
});

test('editable assembly attaches only the moving body to a native linear joint',async()=>{
  const {cadPlanToForgeScript}=await import('../forge-source.js');
  const p={version:1,bodies:[
    body([feature('add','box',[10,8,4])],{name:'座 "A"',partIndex:0}),
    body([feature('add','ellipsoid',[8,10,6])],{name:'拳',partIndex:1,role:'reference'})
  ],motions:[{type:'prismatic',name:'伸出',axis:[0,-1,0],travelMm:22,movingBodyIndices:[1],actuatorPartIndex:0,guidePartIndex:1,controllerPartIndex:0}]};
  const source=cadPlanToForgeScript(p);
  assert.ok(source.includes(JSON.stringify('座 "A"')));
  assert.match(source,/max:22/);
  assert.match(source,/buildPart0\(\)\.translate\(30, 40, 50\)/);
  assert.match(source,/buildPart1\(\)\.translate\(30, 40, 50\)/);
  assert.match(source,/addPrismatic\("1\. 伸出", "Assembly origin", "Motion frame 1", \{axis:\[0,-1,0\]/);
  assert.match(source,/addFixed\("Attach 拳", "Motion frame 1", "拳"\)/);
  assert.doesNotMatch(source,/addFixed\("Attach 座/);
  assert.match(source,/toJointsView\(/);
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

test('Manifold reports actual per-body work and returns a terminal failure for an invalid second solid',async()=>{
  const zero=body([feature('add','box',[1,1,1]),feature('cut','box',[5,5,5])],{name:'被完全切除'});
  const request=req({cadPlan:{version:1,bodies:[plan.bodies[0],zero]}});
  request.headers.set('Accept','application/x-ndjson');
  const res=await forgePlan(request);
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/x-ndjson/);
  const rows=(await res.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.filter(v=>v.type==='progress').map(v=>[v.phase,v.bodyIndex,v.partIndex,v.name,v.completed,v.total]),[
    ['start',0,0,'试件',0,2],['finish',0,0,'试件',1,2],['start',1,0,'被完全切除',1,2]]);
  assert.equal(rows.at(-1).type,'error');assert.equal(rows.at(-1).status,422);
  assert.ok(rows.at(-1).error);assert.ok(!rows.some(v=>v.result));
});

test('loopback streams ForgeCAD work, cancels the exporter on disconnect, and accepts the next revision',async()=>{
  const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
  const {setTimeout:delay}=await import('node:timers/promises');
  const {join}=await import('node:path'),{tmpdir}=await import('node:os');
  const {Readable}=await import('node:stream'),{createInterface}=await import('node:readline');
  const {createServer}=await import('node:net');
  const dir=await mkdtemp(join(tmpdir(),'formbench-live-forge-')),bin=join(dir,'forgecad.cjs'),gate=join(dir,'allow-export');
  const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port,origin='http://127.0.0.1:'+port;await new Promise(r=>probe.close(r));
  let server,reader;
  try{
    await writeFile(bin,`#!${process.execPath}
      const fs=require('node:fs');const args=process.argv.slice(2);
      if(args[0]==='--version'){console.log('0.99.0-test');process.exit(0)}
      fs.writeFileSync(${JSON.stringify(gate+'.pid')},String(process.pid));
      const deadline=Date.now()+6000;
      (function wait(){if(Date.now()>deadline)process.exit(1);
       if(!fs.existsSync(${JSON.stringify(gate)})){setTimeout(wait,10);return}
       const bytes=Buffer.alloc(134);bytes.writeUInt32LE(1,80);bytes.writeFloatLE(1,108);bytes.writeFloatLE(1,124);
       fs.writeFileSync(args[4],bytes)})();`,{mode:0o700});
    server=await isolatedLocalServer(port,{FORGECAD_ENTERPRISE_AUTOMATION:'true',FORGECAD_RESEARCH_AUTOMATION:'false',FORGECAD_BIN:bin});
    const opts={method:'POST',headers:{origin,accept:'application/x-ndjson','content-type':'application/json'},body:JSON.stringify({cadPlan:plan,engine:'forgecad'}),signal:AbortSignal.timeout(8000)};
    const endpoint=origin+'/api/forge/plan';
    const disconnect=new AbortController();
    const abandoned=await fetch(endpoint,{...opts,signal:AbortSignal.any([opts.signal,disconnect.signal])});
    const abandonedReader=abandoned.body.getReader();
    assert.equal((await abandonedReader.read()).done,false);
    const deadline=Date.now()+3500;
    let pid=0;
    while(!pid && Date.now()<deadline){
      try{pid=Number(await readFile(gate+'.pid','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
      if(!pid)await delay(10);
    }
    assert.ok(pid,'exporter started and is waiting for a mesh');
    disconnect.abort();
    // The exporter is blocked on a file nobody has released. Only disconnect can stop it here.
    let stopped=false;
    while(!stopped && Date.now()<deadline){
      try{process.kill(pid,0)}catch(e){if(e.code!=='ESRCH')throw e;stopped=true}
      if(!stopped)await delay(10);
    }
    assert.ok(stopped,'disconnect terminated the in-flight exporter');
    const response=await fetch(endpoint,opts);
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/x-ndjson/);
    reader=createInterface({input:Readable.fromWeb(response.body),crlfDelay:Infinity});
    const iterator=reader[Symbol.asyncIterator](),first=JSON.parse((await iterator.next()).value);
    assert.deepEqual(first,{type:'progress',phase:'start',bodyIndex:0,partIndex:0,name:'试件',completed:0,total:2});
    assert.equal((await fetch(origin+'/api/forge/plan',opts)).status,429);
    await writeFile(gate,'');const rest=[];for await(const line of iterator)rest.push(JSON.parse(line));
    assert.deepEqual(rest.slice(0,-1).map(v=>[v.phase,v.bodyIndex,v.completed]),[['finish',0,1],['start',1,1],['finish',1,2]]);
    const end=rest.at(-1);assert.equal(end.type,'result');assert.equal(end.result.engine,'ForgeCAD CLI 0.99.0-test');assert.equal(end.result.bodies.length,2);
  }finally{reader?.close();await server?.close();await rm(dir,{recursive:true,force:true})}
});
