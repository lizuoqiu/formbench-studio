import test from 'node:test';
import assert from 'node:assert/strict';
import {design} from './design.mjs';
import {candidateForModel,geometryForModel} from './model-geometry-input.mjs';
import {revisionFixture} from './test-fixtures/design-review.mjs';

const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'};
const part={name:'针织顶针',model:'自制触面',spec:'柔性材料',sizeMm:[18,18,20],qty:1,dimensionSource:'estimated',dimensionQuote:'',
 role:'external',placement:'mounted',purpose:'指尖按上圆弧外形',modelId:''};
function draft(shape){
 return {name:'指尖支托',summary:'桌面支托的凸面贴近指腹。',parts:[part],deviceMotion:'stationary',steps:['核对圆面与手指贴合程度。'],
  cadPlan:{version:1,bodies:[{name:'指尖接触面',partIndex:0,role:'printed',positionMm:[0,0,0],features:[
   {op:'add',shape,sizeMm:part.sizeMm,centerMm:[0,0,0],rotationDeg:[0,0,0]}]}],motions:[]},interaction:null};
}
const physical='实际打印后核对表面柔度与贴合程度。';
function report(repair=false){
 return {motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},requiresInteraction:false,checks:['intent','form','mechanism','control'].map(area=>({
  area,status:area==='form'&&repair?'repair':['mechanism','control'].includes(area)?'not-applicable':'pass',
  note:area==='form'&&repair?'接触面是棱角方块，应改为所需圆弧。':'主体与需求中的被动支托一致。',
  partIndices:[0],bodyIndices:[0]})),physicalChecks:[physical]};
}
const completed=value=>Response.json({model:'fixture-snapshot',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
test('relay groups repeated part geometry and preserves installed datum coordinates in CAD order',()=>{
 const shared={partIndex:3,sourceUrl:'https://manufacturer.example/spec',assumptions:['Solder fillets omitted']};
 const datum={id:'axis',positionMm:[0,0,1],axis:[0,0,1],basis:'datasheet'};
 const placed=(bodyIndex,local,positionWorldMm,axisWorld)=>({bodyIndex,...shared,datums:[{...local,positionWorldMm,axisWorld}]});
 const geometry={status:'checked',checks:['fixture check'],reconstructedParts:[
  placed(2,datum,[1,2,3],[0,0,1]),placed(8,datum,[4,5,6],[1,0,0]),
  placed(9,{...datum,positionMm:[1,0,1]},[4,5,7],[1,0,0]),{bodyIndex:10,partIndex:4}]};
 const {reconstructedParts:{models,placements},checks}=geometryForModel(geometry);
 assert.equal(models.length,3);
 assert.deepEqual(placements.map(p=>p.modelIndex),[0,0,1,2]);
 assert.deepEqual(checks,geometry.checks);
 assert.deepEqual(placements.map(({bodyIndex,modelIndex,worldDatums})=>{
  const {datums,...model}=models[modelIndex];
  return {bodyIndex,...model,...(datums?{datums:datums.map((local,i)=>({...local,...worldDatums[i]}))}:{})};
 }),geometry.reconstructedParts);
});
test('relay review retains each CAD feature and its index without repeating field names',()=>{
 const candidate=draft('ellipsoid'),body=candidate.cadPlan.bodies[0];
 body.features.push({op:'cut',shape:'box',sizeMm:[3,4,5],centerMm:[0,5,0]});
 const before=structuredClone(candidate),projected=candidateForModel(candidate);
 assert.deepEqual(projected.cadPlan.bodies[0].features,[
  ['add','ellipsoid',[18,18,20],[0,0,0],[0,0,0]],
  ['cut','box',[3,4,5],[0,5,0],null]
 ]);
 assert.deepEqual(candidate,before);
});
test('an incomplete autonomous motion check cannot be promoted by a positive reviewer verdict',async()=>{
 const {evaluateDraft}=await import('./design-review.mjs');
 for(const status of ['unavailable','checked','not-applicable']){
  const result=await evaluateDraft({ctx:{prompt:'A static test object',history:[],images:[]},candidate:draft('ellipsoid'),
   geometry:{status,checks:['几何检测未完成：余下姿态未测。'],issues:[]},definitionIssues:[],previousIssues:[],
   skill:{text:''},env,send:async()=>completed(report()),signal:new AbortController().signal,workflow:true});
  assert.equal(result.issues.length,status==='unavailable'?1:0);
  if(status==='unavailable')assert.match(result.issues[0],/不能发布.*余下姿态未测/);
 }
});
async function run({requirements={},generate,review}){
 let generated=0,reviewed=0;const calls=[];
 const result=await design(new Request('https://example.test/api/design',{method:'POST',body:JSON.stringify({prompt:'制作贴合手指的圆面支托',...requirements})}),env,async(_,opt)=>{
  const value=JSON.parse(opt.body),type=value.text?.format?.name;calls.push(type);
  if(type==='mechanical_shortlist')return completed({parts:[]});
  if(type==='hardware_design'||type==='hardware_design_revision')return completed(revisionFixture(value,generate(++generated,value)));
  assert.equal(type,'hardware_design_review');
  const result=review(++reviewed,value);
  return result instanceof Response?result:completed(result);
 });
 return {status:result.status,result:await result.json(),calls};
}
test('independent review identifies a geometric defect, sends the actual rejected draft to repair and reevaluates the new body',async()=>{
 const seen=[];
 const old=draft('box');delete old.interaction;
 const out=await run({requirements:{baseDesign:old,conversation:[{role:'user',text:'改成贴合指腹的圆面'}]},
  generate:(n,input)=>{
   if(n===2){const feedback=JSON.parse(input.input.at(-1).content);assert.match(feedback.issues[0],/棱角方块/);assert.equal(feedback.rejectedDraft.cadPlan.bodies[0].features[0].shape,'box');}
   return draft(n===1?'box':'ellipsoid');
  },
  review:(n,input)=>{
   assert.match(input.instructions,/functional-review/);
   const data=JSON.parse(input.input);assert.equal(data.previous.name,old.name);
   seen.push(data.candidate.cadPlan.bodies[0].features[0].shape);
   if(n===2)assert.match(data.previousIssues[0],/棱角方块/);
   return report(n===1);
  }});
 assert.equal(out.status,200);assert.deepEqual(seen,['box','ellipsoid']);
 assert.deepEqual(out.calls,['mechanical_shortlist','hardware_design_revision','hardware_design_review','hardware_design_revision','hardware_design_review']);
 const receipt=out.result.design.generation.designReview;
 assert.equal(receipt.attempts,2);assert.equal(receipt.skill.name,'functional-review');assert.deepEqual(receipt.physicalChecks,[physical]);
 assert.equal(receipt.skill.policy.name,'hardware-design-policy');assert.equal(receipt.skill.policy.stage,'review');
 assert.equal(out.result.design.cadPlan.bodies[0].features[0].shape,'ellipsoid');assert.match(receipt.correctedIssues[0],/棱角方块/);
});
test('static draft cannot pass an explicit programmable rotary request, even if both independent judgments say pass',async()=>{
 const out=await run({requirements:{prompt:'旋转旋钮调节亮度，然后按下按钮启停计时。'},generate:()=>draft('box'),review:()=>report()});
 assert.equal(out.status,502);assert.equal(out.result.design,undefined);assert.equal(out.result.review.attempts,2);
 assert.match(out.result.error,/交互定义/);assert.equal(out.calls.filter(n=>n==='hardware_design_review').length,2);
});
test('invalid non-null control model cannot override deterministic validation with a positive model verdict',async()=>{
 const broken={...draft('box'),interaction:{version:88}};
 const out=await run({generate:()=>broken,review:(_n,input)=>{assert.match(JSON.parse(input.input).definitionIssues.join(' '),/交互/);return report();}});
 assert.equal(out.status,502);assert.equal(out.result.design,undefined);assert.match(out.result.error,/交互/);
});
test('missing independent review, bad reference indices and failed service do not publish a candidate',async()=>{
 for(const broken of [new Response('',{status:503}),{...report(),checks:[]},{...report(),checks:report().checks.map(row=>({...row,bodyIndices:[55]}))}]){
  const out=await run({generate:()=>draft('ellipsoid'),review:()=>broken});
  assert.equal(out.status,502);assert.equal(out.result.design,undefined);assert.match(out.result.error,/评审/);
 }
});
test('bounded runtime evidence dispatches both encoder directions, button events, one second and timer expiry',async()=>{
 const {replayInteraction}=await import('./design-review.mjs');
 const state=(id,clock,mode)=>({id,clock,outputs:[{outputId:'led',mode}]});
 const edge=(from,event,to,effect='none')=>({from,event,to,effect});
 const machine={controls:[{id:'dial',kind:'turn',step:15},{id:'go',kind:'press'}],
  initialState:'idle',timer:{initialSeconds:60,minSeconds:10,maxSeconds:240,stepSeconds:10},
  states:[state('idle','hold','off'),state('running','run','on'),state('done','hold','breathe')],
  transitions:[edge('idle','dial','idle','adjust'),edge('idle','go','running','restart'),edge('running','timer.expired','done'),edge('done','go','idle','reset')]};
 const report=replayInteraction(machine);
 assert.equal(report.status,'replayed');assert.deepEqual(report.issues,[]);assert.deepEqual(report.visitedStates,['idle','running','done']);
 const turns=report.observations.filter(e=>e.event==='dial');
 assert.deepEqual(turns.map(e=>e.setSeconds),[[60,70],[60,50]]);
 assert.deepEqual(turns.map(e=>e.angleDegrees),[[0,15],[0,-15]]);
 assert.deepEqual(report.observations.find(e=>e.event==='elapsed').remainingSeconds,[60,59]);
 const expiry=report.observations.find(e=>e.event==='timer.expired');
 assert.deepEqual(expiry.outputChanges,{led:'breathe'});assert.deepEqual(expiry.remainingSeconds,[60,0]);
 assert.deepEqual(replayInteraction(machine),report);
});
test('system-event replay records an injected event without claiming measured timeout performance',async()=>{
 const {replayInteraction}=await import('./design-review.mjs');
 const machine={controls:[{id:'go',kind:'touch'}],initialState:'idle',timer:null,
  systemEvents:[{id:'watchdog',kind:'timeout',partIndex:0,delayMs:120}],
  states:['idle','running','stopped'].map(id=>({id,clock:'hold',outputs:[{outputId:'motor',mode:id==='running'?'on':'off'}]})),
  transitions:[{from:'idle',event:'go',to:'running',effect:'none'},{from:'running',event:'watchdog',to:'stopped',effect:'none'}]};
 const report=replayInteraction(machine);assert.deepEqual(report.issues,[]);assert.deepEqual(report.visitedStates,['idle','running','stopped']);
 const event=report.observations.find(o=>o.event==='watchdog');
 assert.deepEqual(event.action,{systemEventId:'watchdog'});assert.deepEqual(event.outputChanges,{motor:'off'});
 assert.equal(event.declaredDelayMs,120);assert.match(event.scope,/timing are not simulated/);
});

test('a wiring failure preserves matched board shape, USB mouth and successfully checked mechanical controls in the V4-derived review',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {design:prior}=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v4.json',import.meta.url),'utf8'));
 const candidate=structuredClone(prior);
 // The selected numeric ordering code and its neutral component name are also sufficient.
 candidate.parts[4].name='控制板';candidate.parts[4].model='Seeed Studio 113991114';
 candidate.parts[4].spec='基础版，无排针';candidate.parts[4].modelId='';
 candidate.parts[4].sizeMm=[22.482,17.78,4.46];
 candidate.cadPlan.bodies[4].features=[{op:'add',shape:'box',sizeMm:candidate.parts[4].sizeMm,centerMm:[0,0,2.23],rotationDeg:[0,0,0]}];
 const pair={partIndex:5,fixedBodyIndex:5,movingBodyIndices:[11],pivotMm:[32,-23.65,24]};
 candidate.interaction={version:1,controllerPartIndex:4,controls:[
  {...pair,id:'turn',label:'旋转',kind:'turn',axis:[0,-1,0],step:15,signalPins:['A','B']},
  {...pair,id:'push',label:'按下',kind:'press',axis:[0,1,0],step:.5,signalPins:['SW']}],
  outputs:[{id:'lamp',label:'灯',kind:'light',partIndex:3,bodyIndices:[2,3],signalPin:'DIN'}],
  connections:[],signalChannels:[],timer:null,initialState:'idle',states:[{id:'idle',label:'空闲',clock:'hold',outputs:[{outputId:'lamp',mode:'off'}]}],transitions:[]};
 let d;
 const out=await run({generate:()=>candidate,review:(_n,input)=>{d=JSON.parse(input.input);return report();}});
 {
  assert.match(d.definitionIssues.join(' '),/信号|输入|控制器|供电|接线/);
  assert.equal(d.geometry.status,'checked');assert.match(d.geometry.checks.join(' '),/旋转/);
  assert.equal(d.behavior.status,'unavailable');
  const ref=d.catalogGeometry.find(r=>r.modelId==='xiao-esp32s3');assert.ok(ref);
  assert.equal(d.candidate.parts[4].dimensionSource,'catalog');
  assert.ok(ref.meshes.some(m=>m.label.includes('USB-C')));
  assert.deepEqual(ref.interfaces[0].openingMm,[8.15,2.7]);assert.deepEqual(ref.interfaces[0].outwardWorld,[1,0,0]);
 }
 assert.equal(out.status,502);assert.ok(out.result.repairCandidate.design.cadPlan);
 assert.equal(out.result.repairCandidate.design.parts[4].modelId,'xiao-esp32s3');
});
test('explicit retry starts from a rejected draft and its issues and runs a fresh independent review',async()=>{
 const wrong=draft('box');
 const failed=await run({generate:()=>wrong,review:()=>report(true)});
 const pending=failed.result.repairCandidate;assert.ok(pending);assert.equal(failed.result.design,undefined);
 pending.design.parts[0].mechanicalEvidenceReceipt='v1.unverified.privatestuff';
 const retried=await run({requirements:{repairCandidate:pending},generate:(n,input)=>{
  assert.equal(n,1);const msg=JSON.parse(input.input.at(-1).content);
  assert.equal(msg.rejectedDraft.cadPlan.bodies[0].features[0].shape,'box');
  assert.match(msg.issues.join(' '),/棱角方块/);assert.doesNotMatch(JSON.stringify(input),/privatestuff/);
  return draft('ellipsoid');
 },review:()=>report()});
 assert.equal(retried.status,200);assert.equal(retried.result.design.generation.designReview.attempts,1);
 assert.deepEqual(retried.calls,['mechanical_shortlist','hardware_design_revision','hardware_design_review']);
});
test('a retained timer draft with a uniquely recoverable expiry alias goes straight to independent review and keeps every CAD body',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {timerModel}=await import('./test-fixtures/timer-model.mjs');
 const {design:base}=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v4.json',import.meta.url),'utf8'));
 const machine=timerModel();
 const expiry=machine.transitions.find(t=>t.event==='timer.expired');expiry.event='timeout';
 const before=structuredClone(base.cadPlan);
 const pending={design:{...base,interaction:machine},issues:['不认识 timeout，需要自然到时切换。']};
 const out=await run({requirements:{repairCandidate:pending},generate:()=>{throw Error('valid retained geometry was regenerated');},
  review:(_n,input)=>{
   const data=JSON.parse(input.input);assert.deepEqual(data.candidate.cadPlan,before);
   assert.ok(data.candidate.interaction.transitions.some(t=>t.from==='run'&&t.event==='timer.expired'));
   assert.deepEqual(data.normalizations.map(c=>c.fromEvent),['timeout']);
   assert.ok(data.behavior.observations.some(o=>o.event==='timer.expired'&&o.to==='done'));
   return {...report(),requiresInteraction:true};
  }});
 assert.equal(out.status,200,out.result.error);assert.deepEqual(out.calls,['hardware_design_review']);
 assert.deepEqual(out.result.design.cadPlan,before);assert.equal(expiry.event,'timeout');
 assert.equal(out.result.design.generation.modelSource,'configured');assert.equal(out.result.design.generation.designReview.modelId,'fixture-snapshot');
 assert.equal(out.result.design.generation.designReview.draftSource,'retained-candidate');
 assert.equal(out.result.design.generation.designReview.normalizations[0].toEvent,'timer.expired');
});

test('a positive model verdict cannot close a failed linear drawing until the matching stroke has measured poses',async()=>{
 const {evaluateDraft}=await import('./design-review.mjs');
 const candidate=draft('box');
 candidate.cadPlan.motions=[{name:'滑台升降',guidePartIndex:0,movingBodyIndices:[0]}];
 let previous=[];
 for(const [attempt,status] of ['failed','not-exercised','passed'].entries()){
  const observation={name:'滑台升降',index:0,status,samples:['intermediate','extended','retracted'].map(phase=>({phase,sliderPassed:true,pose:{status}}))};
  const result=await evaluateDraft({ctx:{prompt:'试验滑台',history:[],images:[]},candidate,
   geometry:{status:'checked',issues:[],checks:[],compilation:{status:'compiled'},browserPreview:{status:'observed',travel:{observations:[observation]}}},
   definitionIssues:[],previousIssues:[],skill:{text:''},env,send:async()=>completed({...report(),findings:[]}),
   signal:new AbortController().signal,workflow:true,tracking:{attempt:attempt+1,previous,history:[],physicalValid:true,interactiveValid:true}});
  assert.equal(result.ledger.length,1);
  assert.equal(result.ledger[0].check,'browser-travel');
  assert.equal(result.ledger[0].status,status==='passed'?'closed':'open');
  previous=result.ledger;
 }
});
