import {reviewedFixture,revisionFixture} from './test-fixtures/design-review.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {design} from './design.mjs';
import {readDesignRequest} from './design-conversation.mjs';
const env={OPENAI_MODEL:'test-model',OPENAI_API_KEY:'test'};
const req=body=>new Request('https://unit.test/api/design',{method:'POST',body:JSON.stringify(body)});
const sendResult=(value,check=()=>{})=>async(_url,options)=>{
 const input=JSON.parse(options.body),review=reviewedFixture(input);
 if(review)return review;
 check(input);
 return Response.json({status:'completed',model:env.OPENAI_MODEL,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(revisionFixture(input,value))}]}]});
};
const decision={decision:'ask',question:'希望装置佩戴在手上，还是放在桌面？',options:['戴在手上','放在桌面']};
const part={name:'接触面',qty:1,spec:'圆弧表面',model:'定制件',modelId:'',role:'panel',purpose:'用手轻触',sizeMm:[40,30,20],dimensionSource:'estimated',dimensionQuote:'',placement:'mounted'};
const body={name:'圆弧接触面',partIndex:0,role:'printed',positionMm:[0,0,0],features:[{op:'add',shape:'ellipsoid',sizeMm:[40,30,20],centerMm:[0,0,0],rotationDeg:[0,0,0]}]};
const base={name:'接触按钮',summary:'使用者触碰圆弧形面板。',steps:['检查触面安装位置。'],parts:[part],cadPlan:{version:1,bodies:[body],motions:[]}};
const response=(request,model)=>design(req(request),env,model);

test('clarification is a small separate API request with a direct choice or no question at all',async()=>{
 const result=await response({action:'discuss',prompt:'给我设计一个提醒装置。'},sendResult(decision,input=>{
  assert.equal(input.model,env.OPENAI_MODEL);assert.equal(input.store,false);
  assert.equal(input.input,'给我设计一个提醒装置。');assert.equal(input.text.format.name,'hardware_clarification');
  assert.equal(input.text.format.schema.properties.cadPlan,undefined);
  assert.match(input.instructions,/一个普通使用者/);assert.ok(!input.instructions.includes('ForgeCAD'));
 }));
 assert.deepEqual(await result.json(),decision);
 const ready=await response({action:'discuss',prompt:'需求明确了，直接生成。'},sendResult({decision:'ready',question:'should clear',options:['clear']}));
 assert.deepEqual(await ready.json(),{decision:'ready',question:'',options:[]});
});

test('two answered questions end the current discussion without another model call; a later revision has its own round',async()=>{
 const conversation=['需要多大？','手掌大小','放在哪里？','桌面'].map((text,i)=>({role:i%2?'user':'assistant',text}));
 const request={action:'discuss',prompt:'触觉装置',baseDesign:base,conversation};
 const capped=await response(request,()=>{throw Error('unnecessary model call')});
 assert.equal(capped.status,200);assert.equal((await capped.json()).decision,'ready');
 const next=await response({...request,discussionStart:4},sendResult(decision,input=>{
  const data=JSON.parse(input.input);assert.equal(data.baseDesign.cadPlan,undefined);
  assert.equal(data.baseDesign.name,base.name);assert.deepEqual(data.conversation,conversation);
 }));
 assert.equal((await next.json()).decision,'ask');
});

test('direct revision includes validated prior CAD and BOM, dimensions from user replies, and the latest motion intent',async()=>{
 const quote='接触面为 40×30×20 mm';
 const history=[{role:'assistant',text:'尺寸？'},{role:'user',text:'改为固定式，只调整接触面。'+quote}];
 const previous={...base,deviceMotion:'stationary',parts:[{...part,unrelatedSecret:'internal metadata'}],rawResponse:'discard'};
 const updated={...base,deviceMotion:'stationary',parts:[{...part,dimensionSource:'specified',dimensionQuote:quote}]};
 const r=await response({prompt:'设备主动伸出',baseDesign:previous,conversation:history},sendResult(updated,input=>{
  const ctx=JSON.parse(input.input[0].content),prior=JSON.parse(input.input.at(-1).content).rejectedDraft;assert.equal(ctx.prompt,'设备主动伸出');
  assert.deepEqual(prior.cadPlan,base.cadPlan);assert.deepEqual(prior.parts,[part]);assert.equal(prior.deviceMotion,'stationary');
  assert.deepEqual(ctx.conversation,history);assert.equal(prior.rawResponse,undefined);assert.equal(ctx.baseDesign,undefined,'the patch base is not repeated in conversation context');
  assert.match(input.instructions,/保留无关零件/);assert.equal(input.text.format.name,'hardware_design_revision');
 }));
 assert.equal(r.status,200);const result=(await r.json()).design;
 assert.equal(result.parts[0].dimensionSource,'specified');assert.equal(result.parts[0].dimensionQuote,quote);assert.equal(result.parts[0].placement,'mounted');
 assert.equal(result.deviceMotion,'stationary');assert.deepEqual(result.cadPlan,base.cadPlan);
 assert.equal(result.generation.assemblyRevision.mode,'incremental');assert.equal(result.generation.assemblyRevision.baseSource,'existing-design');
});

test('a suggested size in an assistant question does not become user-specified dimensional evidence',async()=>{
 const quote='接触面为 40×30×20 mm';
 const result=await response({prompt:'制作桌面按钮',conversation:[{role:'assistant',text:'是否'+quote+'？'},{role:'user',text:'你来决定'}]},
  sendResult({...base,parts:[{...part,dimensionSource:'specified',dimensionQuote:quote}]}));
 assert.equal(result.status,200);assert.equal((await result.json()).design.parts[0].dimensionSource,'estimated');
});

test('invalid history, malformed prior CAD and invalid decisions never publish a design',async()=>{
 const noCall=()=>{throw Error('invalid input reached API')};
 for(const fields of [{action:'guess'},{conversation:[{role:'system',text:'x'}]},{discussionStart:2},{baseDesign:{...base,cadPlan:{version:1,bodies:[{...body,partIndex:1}]}}}]){
  const r=await response({prompt:'修改',...fields},noCall);assert.equal(r.status,400);
 }
 for(const value of [{decision:'ask',question:'',options:[]},{decision:'ask',question:'选什么？',options:['a','b','c','d']}]){
  const r=await response({action:'discuss',prompt:'修改'},sendResult(value));assert.equal(r.status,502);assert.equal((await r.json()).design,undefined);
 }
 const legacy=await readDesignRequest(req({prompt:'让它更小',baseDesign:{...base,cadPlan:null}}));
 assert.equal(legacy.baseDesign.cadPlan,undefined);
});

test('an explicit retry retains system-event evidence in the inert rejected draft',async()=>{
 const systemEvents=[{id:'lost',label:'连接断开',kind:'connection',partIndex:0,sourcePins:['USB_DP','USB_DM'],condition:'USB detached',delayMs:null}];
 const rejected={...base,interaction:{version:1,systemEvents,states:[],transitions:[],unrelatedMetadata:'discard'}};
 const context=await readDesignRequest(req({prompt:'继续修复',repairCandidate:{design:rejected,issues:['补全连接恢复状态。']}}));
 assert.deepEqual(context.repairCandidate.design.interaction.systemEvents,systemEvents);
 assert.equal(context.repairCandidate.design.interaction.unrelatedMetadata,undefined);
 assert.equal(context.baseDesign,null);
});

test('a revised single powered stroke follows the latest unambiguous world direction',async()=>{
 const build=axis=>{
  const assembly=structuredClone(base);
  assembly.deviceMotion='powered-linear';
  assembly.parts.push({...part,name:'导向驱动模组',sizeMm:[90,90,4]});
  const ring=(op,diameter,height)=>({op,shape:'cylinder',sizeMm:[diameter,diameter,height],centerMm:[0,0,0],rotationDeg:[0,0,0]});
  // A through-bore leaves room for the pad throughout the tested 12 mm strokes.
  assembly.cadPlan.bodies.push({...body,partIndex:1,name:'固定导向环',features:[ring('add',90,4),ring('cut',80,6)]});
  assembly.cadPlan.motions=[{type:'prismatic',name:'触面伸缩',axis,travelMm:12,movingBodyIndices:[0],actuatorPartIndex:1,guidePartIndex:1,controllerPartIndex:1}];
  return assembly;
 };
 const old=build([1,0,0]);old.summary='触面水平向前伸出。';
 const edit=text=>({prompt:'设备原来沿桌面水平向前伸出',baseDesign:old,conversation:[{role:'user',text},{role:'assistant',text:'面层保留吗？'},{role:'user',text:'保留 TPU。'}]});
 const request=edit('把水平伸出改为垂直向上（世界坐标 +Z）伸出，再向下收回。');
 const received=await response(request,sendResult(old,input=>assert.match(input.instructions,/本轮用户指定所述部件垂直向上伸出/)));
 assert.equal(received.status,502);assert.match((await received.json()).error,/\+Z.*\[1, 0, 0\]/);
 for(const axis of [[0,0,-1],[.6,0,.8]]){
  assert.equal((await response(request,sendResult(build(axis)))).status,502);
 }
 assert.equal((await response(request,sendResult(build([0,0,1])))).status,200);
 assert.equal((await response({prompt:'改为垂直向上伸出。',baseDesign:old},sendResult(old))).status,502);
 assert.equal((await response({prompt:'手动让装置垂直向上伸出。'},sendResult({...base,deviceMotion:'stationary'}))).status,200);
 const vertical=edit('垂直伸缩，而不是水平平移');
 const actualRevision=edit('请在上一版桌面碰拳装置上修改：把拳头的行程改为竖直方向。桌面和底座保持水平，拳头从底座上方沿竖直方向缓慢向上伸出 16 mm，停在上方等待用户轻碰；用户轻碰后，拳头再缓慢垂直向下收回原位。请让可单独 3D 打印的柔性 TPU 握拳、USB-C 供电、轻触感知和低速等待交互保持可用。请随之重新布置底座内的竖直执行器、导向和限位机构，并调整外壳和顶部通道、让运动件互相对齐，拳头能沿真实安装轴上升，电路板和 USB-C 端口保持固定。不要保留上一版水平推杆、平移滑轨或水平磁拖滑鞋。CAD 和实际交互都应体现竖直行程；高度和底座外形可以为合理安装而调整。');
 for(const [revision,expectedAxis] of [[vertical,/沿竖直轴伸缩/],[actualRevision,/垂直向上伸出/]]){
  const bad=await response(revision,sendResult(old,input=>assert.match(input.instructions,expectedAxis)));
  assert.equal(bad.status,502);assert.match((await bad.json()).error,expectedAxis);
  const stationary=await response(revision,sendResult({...base,deviceMotion:'stationary'}));
  assert.equal(stationary.status,502);assert.match((await stationary.json()).error,/主动伸缩/);
  assert.equal((await response(revision,sendResult(build([0,0,1])))).status,200);
 }
 assert.equal((await response(vertical,sendResult(build([0,0,-1])))).status,200);
 assert.equal((await response(actualRevision,sendResult(build([0,0,-1])))).status,502);
 const horizontal=edit('改为水平向前伸出。');
 assert.equal((await response(horizontal,sendResult(build([0,1,0])))).status,200);
 assert.equal((await response(horizontal,sendResult(build([0,0,1])))).status,502);
 for(const text of ['想和 AI 碰拳。','拳面垂直朝上，按现在的方向伸出。','不要改为垂直向上伸出。','考虑垂直向上伸出或水平伸出。','请做多轴机构，先垂直向上伸出，再侧移。']){
  const r=await response(edit(text),sendResult(old,input=>assert.doesNotMatch(input.instructions,/本轮用户指定/)));
  assert.equal(r.status,200,text);
 }
 const multi=build([1,0,0]);
 multi.cadPlan.bodies.push({...body,partIndex:0,name:'第二滑台',positionMm:[0,100,0]});
 multi.cadPlan.motions.push({...multi.cadPlan.motions[0],name:'升降',axis:[0,0,1],movingBodyIndices:[2]});
 assert.equal((await response(request,sendResult(multi))).status,200);
});
