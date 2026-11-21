import test from 'node:test';
import assert from 'node:assert/strict';
import {previewCadPlan,compileCadPlan,meshBounds,cadBodyToForgeScript,runCadWorker,cadDownloadName} from '../consumer-geometry.js';
import {buildDeclaredAssembly,resolveConsumerGeometry,declaredHomeCamera,declaredExplosionOffset,currentCadPlan} from '../consumer-cad.js';
import {compileCadPlan as compileSolid} from '../cad-plan-compiler.js';

const feature=(shape,sizeMm,centerMm=[0,0,0],op='add')=>({op,shape,sizeMm,centerMm});
const body=(name,features,extra={})=>({name,partIndex:0,role:'printed',positionMm:[30,40,50],features,...extra});
const plan=bodies=>({version:1,bodies});
const part=(fields={})=>({name:'打印拳部',spec:'定制',model:'自建结构',qty:1,role:'external',sizeMm:[50,40,45],dimensionSource:'specified',...fields});
const near=(a,b)=>a.forEach((v,k)=>assert.ok(Math.abs(v-b[k])<1e-5,`${a} != ${b}`));
const volume=faces=>Math.abs(faces.reduce((sum,[a,b,c])=>sum+(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6,0));

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
