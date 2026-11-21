import test from 'node:test';
import assert from 'node:assert/strict';
import {previewCadPlan,compileCadPlan,meshBounds,cadBodyToForgeScript,runCadWorker,cadDownloadName} from '../consumer-geometry.js';
import {buildDeclaredAssembly,resolveConsumerGeometry,declaredHomeCamera,declaredExplosionOffset,currentCadPlan,bodyPose,visibleAssemblyInstances,assemblyStl} from '../consumer-cad.js';
import {decodeSTL} from '../assembly-hardware.js';
import {compileCadPlan as compileSolid} from '../cad-plan-compiler.js';
import {editableForgeSource} from '../forge-source.js';

const feature=(shape,sizeMm,centerMm=[0,0,0],op='add')=>({op,shape,sizeMm,centerMm});
const body=(name,features,extra={})=>({name,partIndex:0,role:'printed',positionMm:[30,40,50],features,...extra});
const plan=bodies=>({version:1,bodies});
const part=(fields={})=>({name:'打印拳部',spec:'定制',model:'自建结构',qty:1,role:'external',sizeMm:[50,40,45],dimensionSource:'specified',...fields});
const near=(a,b)=>a.forEach((v,k)=>assert.ok(Math.abs(v-b[k])<1e-5,`${a} != ${b}`));
const volume=faces=>Math.abs(faces.reduce((sum,[a,b,c])=>sum+(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6,0));

test('editable exports embed only the packaged board program in complete catalog anchors',async t=>{
 const {readFile}=await import('node:fs/promises');
 const seen=[];
 t.mock.method(globalThis,'fetch',async url=>{
  seen.push(url.pathname);
  assert.match(url.pathname,/\/assets\/hardware\/xiao-esp32(?:s3|c3)\/(?:metadata\.json|reference\.forge\.js)$/);
  return new Response(await readFile(url));
 });
 for(const [modelId,size] of [['xiao-esp32s3',[22.482,17.78,4.46]],['xiao-esp32c3',[22.463,17.78,4.7]]]){
  const row=part({modelId,sizeMm:size,dimensionSource:'catalog',role:'internal',sourceFile:'https://invalid.example/injected.js'});
  const anchor=body('可编辑控制板',[{...feature('box',size,[2,3,4]),rotationDeg:[20,30,40]}],{role:'reference'});
  const source=await editableForgeSource(plan([anchor]),[row],0);
  assert.ok(source.includes(modelId));assert.match(source,/\.rotate\(\[1,0,0\], 20\)\.rotate\(\[0,1,0\], 30\)\.rotate\(\[0,0,1\], 40\)\.translate\(2, 3, 4\)/);
  assert.doesNotMatch(source,/injected\.js|Placement envelope/);
  const fallback=await editableForgeSource(plan([anchor,anchor]),[row]);
  assert.match(fallback,/Placement envelope/);assert.doesNotMatch(fallback,/function catalogBoard/);
  for(const patch of [{modelId:'../../injected'},{modelSourceInvalidated:true},{dimensionSource:'specified'},{sizeMm:[30,20,10]}]){
   const ordinary=await editableForgeSource(plan([anchor]),[{...row,...patch}],0);
   assert.match(ordinary,/Placement envelope/);assert.doesNotMatch(ordinary,/function catalogBoard|injected/);
  }
 }
 assert.ok(seen.some(path=>path.endsWith('xiao-esp32c3/reference.forge.js')));
});

test('a purchased part uses its complete placement box and exports the displayed, rotated detail at the current travel',()=>{
 const p=part({index:0,qty:1,role:'internal',geometryKind:'catalog',sizeMm:[20,10,4],
  meshes:[{label:'connector',triangles:[[[2,2,2],[6,2,2],[2,3,2]]]}]});
 const box={...feature('box',p.sizeMm,[3,4,5]),rotationDeg:[0,0,90]};
 const anchor=body('板卡',[box],{role:'reference',positionMm:[50,20,10]});
 function assemble(bodies,parts=[p]){
  const cadPlan=plan(bodies),geometry=previewCadPlan(cadPlan,1);
  return buildDeclaredAssembly({parts,cadPlan},parts,geometry);
 }
 const assembly=assemble([anchor]),item=assembly.instances[0];
 assert.equal(item.source,'catalog');near(item.meshes[0].triangles[0][0],[6,-4,5]);
 const travel=[{axis:[0,0,1],travelMm:16,movingBodyIndices:[0]}];
 const [worldFace]=decodeSTL(assemblyStl(assembly,travel,[.5]));
 near(worldFace[0],[56,16,23]);
 const split=assemble([anchor,body('输出杆',[feature('cylinder',[2,2,12])],{role:'reference'})]);
 assert.deepEqual(split.instances.map(i=>i.source),['generated','generated']);
 assert.equal(assemble([{...anchor,features:[feature('box',[12,10,4])]}]).instances[0].source,'generated');
 const copies=assemble([anchor,{...anchor,positionMm:[50,80,10]}],[{...p,qty:2}]);
 assert.deepEqual(copies.instances.map(i=>i.source),['catalog','catalog']);
});

test('closed enclosure submits physical shafts to depth testing while keeping embedded reference pads inside',()=>{
 const items=[
  ['enclosure','printed'],['internal','printed'],['internal','reference'],
  ['external','printed'],['internal','reference'],['internal','reference']
 ].map(([role,kind],index)=>({role,kind,placed:true,bodyIndex:index,partIndex:index}));
 const motions=[{movingBodyIndices:[1,2,3,4],actuatorPartIndex:2,guidePartIndex:0}];
 const view=(mode,reveal=false)=>visibleAssemblyInstances({instances:items},mode,reveal,motions).map(b=>b.bodyIndex);
 assert.deepEqual(view('closed'),[0,1,2,3]);
 assert.deepEqual(view('closed',true),[0,1,2,3,4,5]);
 assert.deepEqual(view('inside'),[1,2,4,5]);
});

test('the static built-in example reads a saved export only for the exact complete plan',async()=>{
 const baseUrl='https://example.test/project/workbench.html',exampleAsset='fist-bump';
 const p=plan([body('缓存契约试件',[feature('box',[5,4,3])])]);
 const result=await compileSolid(p); // Synthetic in-memory export format fixture.
 const cached={engine:'ForgeCAD CLI 0.0.0-test',version:'0.0.0-test',units:'mm',cadPlan:{bodies:p.bodies,version:1},bodies:result.bodies};
 let assetReads=0,workers=0;
 const fetcher=async url=>{assetReads++;assert.equal(url.pathname,'/project/samples/fist-bump-cad.json');return Response.json(cached)};
 class WorkerMock{
  postMessage({cadPlan}){workers++;compileSolid(cadPlan).then(result=>this.onmessage({data:{result}}))}
  terminate(){}
 }
 const options={baseUrl,WorkerClass:WorkerMock,fetcher};
 const exact=await compileCadPlan(p,{...options,exampleAsset});
 assert.equal(exact.engine,cached.engine);assert.match(exact.notice,/示例保存/);assert.equal(workers,0);
 const ordinary=await compileCadPlan(p,options);
 assert.equal(ordinary.engine,'Manifold 3.5.1');assert.equal(assetReads,1);assert.equal(workers,1);
 const changed=structuredClone(p);changed.bodies[0].features[0].sizeMm[0]=7;
 const newResult=await compileCadPlan(changed,{...options,exampleAsset});
 assert.equal(newResult.engine,'Manifold 3.5.1');near(meshBounds(newResult.bodies[0].meshes).sizeMm,[7,4,3]);
 for(const response of [new Response('missing',{status:404}),Response.json({...cached,cadPlan:changed,version:'9.0.0'}),Response.json({...cached,cadPlan:changed,bodies:[]})]){
  const fallback=await compileCadPlan(changed,{...options,exampleAsset,fetcher:async()=>response});
  assert.equal(fallback.engine,'Manifold 3.5.1');
 }
 const local=await compileCadPlan(p,{...options,exampleAsset,baseUrl:'http://127.0.0.1:4173',fetcher:async(url,req)=>{
  assert.equal(url.pathname,'/api/forge/plan');assert.equal(req.method,'POST');return Response.json(result);
 }});
 assert.equal(local.engine,result.engine);
});

test('rounded profiles and elliptical capsules keep their declared bounds and rounded volume',async()=>{
 const cases=[
  ['roundedPrism',[30,20,10],(30*20-(4-Math.PI)*4**2)*10],
  ['capsule',[30,20,10],Math.PI*5*10*(20+4*5/3)],
  ['capsule',[10,30,20],Math.PI*5*10*(20+4*5/3)],
  ['capsule',[20,10,30],Math.PI*5*10*(20+4*5/3)],
  ['capsule',[10,10,10],4*Math.PI*5**3/3]
 ];
 const p=plan(cases.map(([shape,size])=>body(shape,[feature(shape,size)])));
 const preview=previewCadPlan(p);
 const exact=await compileCadPlan(p,{baseUrl:'http://127.0.0.1/',fetcher:async(_url,request)=>Response.json(await compileSolid(JSON.parse(request.body).cadPlan))});
 for(const result of [preview,exact])for(const [i,[,size,expectedVolume]] of cases.entries()){
  const meshes=result.bodies[i].meshes;
  near(meshBounds(meshes).min,size.map(n=>-n/2));near(meshBounds(meshes).max,size.map(n=>n/2));
  assert.ok(Math.abs(volume(meshes[0].triangles)/expectedVolume-1)<.02);
 }
});

test('curved body preview has its declared shape, rotation and local coordinates',()=>{
 const p=plan([body('拳形',[feature('ellipsoid',[40,30,20]),feature('cylinder',[10,10,40],[0,0,-12])])]);
 const preview=previewCadPlan(p,1);assert.equal(preview.exact,false);assert.equal(preview.bodies[0].meshes.length,2);
 assert.ok(preview.bodies[0].meshes[0].triangles.length>500);
 near(meshBounds(preview.bodies[0].meshes).min,[-20,-15,-32]);
 const f={...feature('box',[2,6,10],[11,5,3]),rotationDeg:[90,90,0]};
 const rotated=previewCadPlan(plan([body('转角',[f])]),1);
 near(meshBounds(rotated.bodies[0].meshes).min,[8,0,2]);near(meshBounds(rotated.bodies[0].meshes).max,[14,10,4]);
});

test('real kernel triangles retain cuts and the viewer adds whole-body translation once',async()=>{
 const p=plan([body('通孔试件',[feature('box',[12,10,8]),feature('box',[4,4,12],[0,0,0],'cut')])]);
 const result=await compileCadPlan(p,{baseUrl:'http://127.0.0.1:4173/',partCount:1,fetcher:async(_url,request)=>new Response(JSON.stringify(await compileSolid(JSON.parse(request.body).cadPlan)))});
 assert.equal(result.engine,'Manifold 3.5.1');assert.equal(result.exact,true);
 near(meshBounds(result.bodies[0].meshes).min,[-6,-5,-4]);assert.ok(Math.abs(volume(result.bodies[0].meshes[0].triangles)-832)<1e-4);
 const design={parts:[part()],cadPlan:p},parts=await resolveConsumerGeometry(design),assembly=buildDeclaredAssembly(design,parts,result);
 near(assembly.bounds.min,[24,35,46]);near(assembly.bounds.max,[36,45,54]);assert.equal(assembly.shell,null);
 assert.equal(assembly.instances[0].role,'external');assert.ok(result.bodies[0].stlBytes.length>84);
});

test('unplaced electronic parts are separate references and do not become an enclosing box',async()=>{
 const p=plan([body('拳壳',[feature('ellipsoid',[60,50,80])],{positionMm:[0,0,0]}),body('接触面',[feature('ellipsoid',[42,8,24])],{partIndex:1,positionMm:[0,-30,10]})]);
 const design={parts:[part({role:'enclosure'}),part({role:'panel'}),part({name:'控制板',role:'internal',sizeMm:[22,18,5]}),part({name:'USB 数据线',role:'external',sizeMm:[1000,10,6]})],cadPlan:p};
 const parts=await resolveConsumerGeometry(design),assembly=buildDeclaredAssembly(design,parts,previewCadPlan(p,4));
 assert.equal(assembly.shell,null);assert.equal(assembly.unplacedCount,1);assert.equal(assembly.omittedCount,1);
 assert.equal(assembly.instances.filter(item=>item.placed).length,2);
 assert.ok(assembly.instances.find(item=>!item.placed).positionMm[0]>assembly.bounds.max[0]);
 near(assembly.sizeMm,[60,59,80]);
 const camera=declaredHomeCamera(assembly);assert.ok(camera.yaw>2.5&&camera.yaw<2.8);assert.equal(camera.pitch,.32);
});

test('static worker consumes the same real kernel response and terminates after completion',async()=>{
 let terminated=0;
 class WorkerMock{postMessage({cadPlan}){compileSolid(cadPlan).then(result=>this.onmessage({data:{result}}))}terminate(){terminated++}}
 const p=plan([body('静态曲面',[feature('ellipsoid',[8,10,6],[3,4,5])])]);
 const result=await compileCadPlan(p,{baseUrl:'https://example.test/workbench/',WorkerClass:WorkerMock,partCount:1});
 assert.equal(result.exact,true);assert.equal(terminated,1);near(meshBounds(result.bodies[0].meshes).sizeMm,[8,10,6]);
});

test('explicit Forge selection requires the server engine even when a static worker result is cached',async()=>{
 const p=plan([body('测试固定引擎',[feature('box',[7,8,9])])]);
 let workers=0;
 class WorkerMock{constructor(){workers++}postMessage({cadPlan}){compileSolid(cadPlan).then(result=>this.onmessage({data:{result}}))}terminate(){}}
 const baseUrl='https://example.test/subdirectory/',config={baseUrl,WorkerClass:WorkerMock};
 await compileCadPlan(p,config);
 const local={...config,engine:'forgecad'};
 await assert.rejects(compileCadPlan(p,{...local,fetcher:async()=>{throw Error('服务未连接')}}),/服务未连接/);
 const onServer=await compileSolid(p);
 await assert.rejects(compileCadPlan(p,{...local,fetcher:async()=>Response.json(onServer)}),/ForgeCAD/);
 const exact=await compileCadPlan(p,{...local,fetcher:async (url,request)=>{
  assert.equal(url.pathname,'/subdirectory/api/forge/plan');
  assert.equal(JSON.parse(request.body).engine,'forgecad');
  return Response.json({...onServer,engine:'ForgeCAD CLI'});
 }});
 assert.equal(exact.engine,'ForgeCAD CLI');
 await assert.rejects(compileCadPlan(p,{...config,baseUrl:'http://localhost:8444/',fetcher:async()=>Response.json({engine:'ForgeCAD CLI',error:'ForgeCAD 未启动'},{status:503})}),/ForgeCAD 未启动/);
 assert.equal(workers,1);
});

test('motion starts from assembly coordinates, affects only declared bodies and survives index changes',async()=>{
 const names=['尺寸已修改的附件','外部接触件','滑台','驱动器','导轨','控制板','尚未定位的支架'];
 const roles=['external','panel','internal','internal','internal','internal','internal'];
 const fixture=names.map((name,i)=>part({name,role:roles[i],sizeMm:[8,8,8],modelSourceInvalidated:i===0}));
 const p=plan(names.slice(0,6).map((name,i)=>body(name,[feature('box',[8,8,8])],{partIndex:i,role:i<3?'printed':'reference',positionMm:[8*i,12,20]})));
 p.motions=[{type:'prismatic',name:'接触件伸缩',axis:[0,-1,0],travelMm:18,movingBodyIndices:[1,2],actuatorPartIndex:3,guidePartIndex:4,controllerPartIndex:5}];
 const design={cadPlan:p,parts:fixture},active=currentCadPlan(design);
 assert.deepEqual(active.motions[0].movingBodyIndices,[0,1]);
 const parts=await resolveConsumerGeometry(design);
 const concept=buildDeclaredAssembly(design,parts,previewCadPlan(active,parts.length));
 const home=declaredHomeCamera(concept,active.motions);
 const facing=Math.sin(home.yaw)*active.motions[0].axis[0]+Math.cos(home.yaw)*active.motions[0].axis[1];
 assert.ok(facing>.5&&facing<.95,'view sees the advancing face and its lateral travel');
 assert.deepEqual(visibleAssemblyInstances(concept,'inside').map(item=>item.name),['滑台','驱动器','导轨','控制板']);
 assert.deepEqual(visibleAssemblyInstances(concept,'closed').map(item=>item.name),['外部接触件']);
 assert.deepEqual(visibleAssemblyInstances(concept,'references').map(item=>item.name),['尺寸已修改的附件','尚未定位的支架']);
 const [contact,carriage,actuator]=concept.instances;
 near(bodyPose(contact,active.motions,[0]),[8,12,20]);
 near(bodyPose(contact,active.motions,[1]),[8,-6,20]);
 near(bodyPose(carriage,active.motions,[.5]),[16,3,20]);
 near(bodyPose(actuator,active.motions,[1]),actuator.positionMm);
 for(const i of [1,3,4,5]){
  const invalid=structuredClone(design);invalid.parts[i].modelSourceInvalidated=true;
  assert.deepEqual(currentCadPlan(invalid).motions,[]);
 }
});

test('busy local service falls back to a separate real browser-worker computation',async()=>{
 let workers=0;class WorkerMock{constructor(){workers++}postMessage({cadPlan}){compileSolid(cadPlan).then(result=>this.onmessage({data:{result}}))}terminate(){}}
 const p=plan([body('并发备用',[feature('box',[3,4,5])])]);
 const result=await compileCadPlan(p,{baseUrl:'http://127.0.0.1/',WorkerClass:WorkerMock,fetcher:async()=>Response.json({error:'请等待'},{status:429})});
 assert.equal(result.exact,true);assert.equal(workers,1);
});

test('explosion separates a central shell, front contact surface and bottom cover',async()=>{
 const p=plan([body('主体',[feature('box',[60,50,60])],{positionMm:[0,0,30]}),body('前板',[feature('box',[30,4,20])],{partIndex:1,positionMm:[0,-27,36]}),body('底盖',[feature('box',[55,45,2])],{partIndex:2,positionMm:[0,0,0]})]);
 const design={cadPlan:p,parts:[part({role:'enclosure'}),part({role:'panel'}),part({role:'enclosure'})]},parts=await resolveConsumerGeometry(design),assembly=buildDeclaredAssembly(design,parts,previewCadPlan(p,3));
 const offsets=assembly.instances.map(item=>declaredExplosionOffset(item,assembly));
 assert.ok(offsets[0][2]>0);assert.ok(offsets[1][1]<0);assert.ok(offsets[2][2]<0);assert.equal(new Set(offsets.map(JSON.stringify)).size,3);
});

test('changing a purchase or dimensions invalidates only that body and exposes its current envelope',async()=>{
 const p=plan([body('旧拳壳',[feature('ellipsoid',[50,40,45])]),body('保持的底盖',[feature('box',[30,20,2])],{partIndex:1})]);
 const design={cadPlan:p,parts:[part({modelSourceInvalidated:true,sizeMm:[65,46,57],role:'enclosure'}),part({role:'enclosure'})]};
 const active=currentCadPlan(design);assert.equal(active.bodies.length,1);assert.equal(active.bodies[0].name,'保持的底盖');assert.equal(active.bodies[0].partIndex,1);
 const parts=await resolveConsumerGeometry(design),assembly=buildDeclaredAssembly(design,parts,previewCadPlan(active,2));
 assert.equal(assembly.instances.filter(item=>item.placed).length,1);assert.equal(assembly.unplacedCount,1);
 const changed=assembly.instances.find(item=>item.partIndex===0);assert.equal(changed.placed,false);near(meshBounds(changed.meshes).sizeMm,[65,46,57]);assert.match(parts[0].geometryNote,/旧形体与安装位置已撤下/);
});

test('invalid kernel output and business errors never turn into a successful preview or download',async()=>{
 let workers=0;class UnexpectedWorker{constructor(){workers++}}
 const p=plan([body('完全切除',[feature('box',[2,2,2])])]);
 await assert.rejects(compileCadPlan(p,{baseUrl:'http://127.0.0.1/',WorkerClass:UnexpectedWorker,fetcher:async()=>Response.json({error:'实体被完全切除'},{status:422})}),/完全切除/);assert.equal(workers,0);
 await assert.rejects(compileCadPlan(plan([body('损坏实体',[feature('box',[2,2,2])])]),{baseUrl:'http://127.0.0.1/',fetcher:async()=>Response.json({engine:'Manifold 3.5.1',bodies:[]})}),/不完整/);
});

test('canceling a worker disposes it and prevents a result',async()=>{
 let terminated=0;class PendingWorker{postMessage(){}terminate(){terminated++}}
 const controller=new AbortController(),job=runCadWorker(plan([body('取消',[feature('box',[1,1,1])])]),{WorkerClass:PendingWorker,signal:controller.signal});controller.abort();
 await assert.rejects(job,{name:'AbortError'});assert.equal(terminated,1);
});

test('Forge source contains only supported numeric construction and handles rotations before translation',()=>{
 const p=body('ignored name: return malicious()', [{...feature('box',[2,6,10],[11,5,3]),rotationDeg:[90,90,0]},feature('cylinder',[2,2,12],[0,0,0],'cut')]);
 const source=cadBodyToForgeScript(p);assert.ok(!source.includes('malicious'));assert.match(source,/rotate\(\[1,0,0\], 90\)\.rotate\(\[0,1,0\], 90\)\.translate\(11, 5, 3\)/);assert.match(source,/difference\(body, feature1\)/);
 assert.throws(()=>cadBodyToForgeScript({...p,code:'evil()'}),/Invalid CAD/);
 assert.equal(cadDownloadName('../../拳部','forge.js'),'拳部-concept-mm.forge.js');
});

const wireRecord=value=>Buffer.from(JSON.stringify(value)+'\n');
const streamHeaders={'Content-Type':'application/x-ndjson; charset=utf-8'};
function bodyProgress(p,index,phase){
 const {partIndex,name}=p.bodies[index];
 return {type:'progress',phase,bodyIndex:index,partIndex,name,completed:index+(phase==='finish'?1:0),total:p.bodies.length};
}
function observedBodies(events,stage){
 return events.filter(event=>event.stage===stage&&Number.isInteger(event.bodyIndex)).map(({bodyIndex,partIndex,name,phase,completed,total})=>({bodyIndex,partIndex,name,phase,completed,total}));
}
function expectedBodies(p){
 return p.bodies.flatMap((_,i)=>['start','finish'].map(phase=>{
  const {type,...event}=bodyProgress(p,i,phase);
  return event;
 }));
}

test('progress reaches the viewer before the final solid, including across a split UTF-8 name',async()=>{
 const p=plan([body('伸缩杆测试',[feature('box',[2,3,4])]),body('导向体',[feature('box',[5,6,7])])]);
 const result=await compileSolid(p),events=[];
 let wire,accept;
 const response=new Response(new ReadableStream({start(controller){wire=controller}}),{headers:streamHeaders});
 const job=compileCadPlan(p,{baseUrl:'http://127.0.0.1/',fetcher:async(_url,request)=>{
  accept=new Headers(request.headers).get('accept');return response;
 },onProgress:event=>events.push(event)});
 const first=wireRecord(bodyProgress(p,0,'start')),split=first.indexOf(Buffer.from(p.bodies[0].name))+1;
 wire.enqueue(first.subarray(0,split));wire.enqueue(first.subarray(split));
 await new Promise(resolve=>setImmediate(resolve));
 const beforeResult=observedBodies(events,'generate');
 wire.enqueue(Buffer.concat([
  wireRecord(bodyProgress(p,0,'finish')),wireRecord(bodyProgress(p,1,'start')),
  wireRecord(bodyProgress(p,1,'finish')),wireRecord({type:'result',result})
 ]));
 wire.close();
 assert.equal((await job).bodies.length,2);
 assert.match(accept,/application\/x-ndjson/);
 assert.deepEqual(beforeResult,expectedBodies(p).slice(0,1));
 assert.deepEqual(observedBodies(events,'generate'),expectedBodies(p));
 assert.deepEqual(observedBodies(events,'decode'),expectedBodies(p));
});

test('interrupted streams, wrong body identity and failed jobs cannot fall back to a different engine',async()=>{
 const p=plan([body('连接中断试件',[feature('box',[2,2,2])])]),result=await compileSolid(p);
 const start=bodyProgress(p,0,'start'),finished=bodyProgress(p,0,'finish'),terminal={type:'result',result};
 const mismatched={...result,bodies:result.bodies.map(b=>({...b,name:'其它方案'}))};
 let workers=0;
 class UnexpectedWorker{constructor(){workers++;throw Error('unexpected fallback')}}
 const cases=[
  [start],
  [start,finished],
  [{...start,name:'错误的形体'},finished,terminal],
  [start,{type:'error',status:503,error:'编译连接故障'}],
  [start,finished,{type:'result',result:mismatched}]
 ];
 for(const records of cases){
  const events=[];
  await assert.rejects(compileCadPlan(p,{baseUrl:'http://127.0.0.1/',WorkerClass:UnexpectedWorker,
   fetcher:async()=>new Response(Buffer.concat(records.map(wireRecord)),{headers:streamHeaders}),
   onProgress:event=>events.push(event)
  }));
  assert.equal(observedBodies(events,'decode').filter(event=>event.phase==='finish').length,0);
 }
 assert.equal(workers,0);
});

test('a saved export reports loading and an old JSON compiler reports decoding without made-up generation events',async()=>{
 const p=plan([body('静态零件加载测试',[feature('box',[3,4,5])]),body('独立控制板',[feature('box',[6,7,8])],{partIndex:1})]);
 const result=await compileSolid(p),loadEvents=[],decodeEvents=[];
 const saved={...result,engine:'ForgeCAD CLI 0.0.0-test',version:'0.0.0-test',units:'mm',cadPlan:p};
 const asset=await compileCadPlan(p,{baseUrl:'https://example.test/',exampleAsset:'fist-bump',fetcher:async()=>Response.json(saved),onProgress:event=>loadEvents.push(event)});
 assert.equal(asset.engine,saved.engine);
 assert.deepEqual(observedBodies(loadEvents,'load'),expectedBodies(p));
 assert.deepEqual(observedBodies(loadEvents,'generate'),[]);
 const cachedEvents=[];
 const warm=await compileCadPlan(p,{baseUrl:'https://example.test/',exampleAsset:'fist-bump',
  fetcher:()=>{throw Error('warm mesh cache should not fetch')},onProgress:event=>cachedEvents.push(event)
 });
 assert.equal(warm.engine,saved.engine);
 assert.deepEqual(observedBodies(cachedEvents,'generate'),[]);
 assert.deepEqual(observedBodies(cachedEvents,'decode'),[]);

 const legacy=await compileCadPlan(p,{baseUrl:'http://localhost:8100/',fetcher:async()=>Response.json(result),onProgress:event=>decodeEvents.push(event)});
 assert.equal(legacy.engine,result.engine);
 assert.deepEqual(observedBodies(decodeEvents,'decode'),expectedBodies(p));
 assert.deepEqual(observedBodies(decodeEvents,'generate'),[]);
});

test('browser worker body events pass through before decoding its final mesh',async()=>{
 const p=plan([body('离线工作线程试件',[feature('box',[4,4,6])])]);
 const result=await compileSolid(p),events=[];
 let requestedProgress,terminated=0;
 class WorkerMock{
  postMessage(request){
   requestedProgress=request.progress;
   for(const phase of ['start','finish']){
    this.onmessage({data:{progress:bodyProgress(p,0,phase)}});
   }
   this.onmessage({data:{result}});
  }
  terminate(){terminated++}
 }
 const solid=await compileCadPlan(p,{baseUrl:'https://static.example.test/',WorkerClass:WorkerMock,onProgress:event=>events.push(event)});
 assert.equal(requestedProgress,true);
 assert.equal(terminated,1);
 assert.equal(solid.exact,true);
 assert.deepEqual(observedBodies(events,'generate'),expectedBodies(p));
 assert.deepEqual(observedBodies(events,'decode'),expectedBodies(p));
});
