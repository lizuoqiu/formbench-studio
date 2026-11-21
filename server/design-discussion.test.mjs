import {test} from 'node:test';
import assert from 'node:assert/strict';
import {design} from './design.mjs';
import {readDesignRequest} from './design-conversation.mjs';
const env={OPENAI_MODEL:'test-model',OPENAI_API_KEY:'test'};
const req=body=>new Request('https://unit.test/api/design',{method:'POST',body:JSON.stringify(body)});
const sendResult=(value,check=()=>{})=>async(_url,options)=>{
 check(JSON.parse(options.body));
 return Response.json({status:'completed',model:env.OPENAI_MODEL,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
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
  const ctx=JSON.parse(input.input);assert.equal(ctx.prompt,'设备主动伸出');
  assert.deepEqual(ctx.baseDesign.cadPlan,base.cadPlan);assert.deepEqual(ctx.baseDesign.parts,[part]);assert.equal(ctx.baseDesign.deviceMotion,'stationary');
  assert.deepEqual(ctx.conversation,history);assert.equal(ctx.baseDesign.rawResponse,undefined);
  assert.match(input.instructions,/保留无关零件/);assert.equal(input.text.format.name,'hardware_design');
 }));
 assert.equal(r.status,200);const result=(await r.json()).design;
 assert.equal(result.parts[0].dimensionSource,'specified');assert.equal(result.parts[0].dimensionQuote,quote);assert.equal(result.parts[0].placement,'mounted');
 assert.equal(result.deviceMotion,'stationary');assert.deepEqual(result.cadPlan,base.cadPlan);
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
