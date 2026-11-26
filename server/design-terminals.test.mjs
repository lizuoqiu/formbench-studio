import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTerminalLocations,validateInteraction,connectedTerminalPins,revisedTerminalLocations} from '../interaction-model.js';
import {design as generate} from './design.mjs';
import {locateDesignTerminals,terminalReview} from './design-terminals.mjs';
import {revisionFixture} from './test-fixtures/design-review.mjs';

const {design:prior}=JSON.parse(readFileSync(new URL('../samples/shared/reading-timer/v5.json',import.meta.url)));
const completed=value=>Response.json({status:'completed',model:'fixture',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const input=(fromPartIndex,fromPin,toPartIndex,toPin)=>({kind:'signal',fromPartIndex,fromPin,toPartIndex,toPin});
const feature=(sizeMm,centerMm)=>({op:'add',shape:'box',sizeMm,centerMm,rotationDeg:[0,0,0]});
const sourceUrl='https://maker.example/drawing/board';
const custom={
 parts:[{name:'自制转接板',model:'TEST-P01'},{name:'外接线',model:'UNKNOWN-CABLE'}],
 cadPlan:{bodies:[{partIndex:0,name:'转接板',positionMm:[40,17,10],
  features:[feature([20,20,2],[0,0,0]),feature([2,4,.2],[3,4,1])]}]}
};
const connections=[input(0,'P1',1,'USB'),input(0,'P1',1,'SHIELD')];
const pin={partIndex:0,pin:'P1',bodyIndex:0,positionMm:[3,4,1],basis:'geometry',featureIndex:1,evidence:'铜接线焊盘',sourceUrl:''};

test('a malformed terminal leaves other bad and missing pins individually diagnosable',()=>{
 const model={connections,terminals:[{...pin,evidence:null},{...pin,partIndex:1,pin:'USB'}]};
 const checkIssues=error=>{
  assert.ok(error.issues.some(m=>m.includes('terminals[0].evidence')));
  assert.ok(error.issues.some(m=>m.includes('USB')&&m.includes('其他 BOM')));
  assert.ok(error.issues.some(m=>m.includes('缺少')&&m.includes('SHIELD')));
  assert.ok(!error.issues.some(m=>m.includes('缺少')&&m.includes('P1')));
  return true;
 };
 assert.throws(()=>validateTerminalLocations(model,custom),checkIssues);
 assert.throws(()=>validateInteraction({...prior.interaction,...model},custom),error=>{
  assert.ok(error.issues.some(m=>m.includes('线路检查未完成')));return checkIssues(error);
 });
});

test('incremental terminal review follows a rigid placement and detects a moved solder feature',()=>{
 const base={...custom,interaction:locateDesignTerminals({connections,terminals:[pin]},custom)};
 const next=structuredClone(base);
 next.cadPlan.bodies[0].positionMm[0]+=50;
 assert.deepEqual(revisedTerminalLocations(base,next).checked,[{partIndex:0,pin:'P1',bodyIndex:0,status:'verified'}]);
 next.cadPlan.bodies[0].features[1].centerMm[0]+=5;
 let [record]=revisedTerminalLocations(base,next).checked;
 assert.equal(record.status,'regression');assert.match(record.issue,/P1.*特征范围/);
 const repaired=structuredClone(next);
 repaired.interaction.terminals[0].positionMm[0]+=5;
 [record]=revisedTerminalLocations(next,repaired).checked;
 assert.equal(record.status,'verified');assert.doesNotThrow(()=>validateTerminalLocations(repaired.interaction,repaired));
 assert.deepEqual(revisedTerminalLocations(repaired,structuredClone(repaired)).checked,[]);
 assert.equal(revisedTerminalLocations(null,next),null);
});

test('each distinct connected pin gets one body-local entry or an explicit unknown',()=>{
 const model=locateDesignTerminals({connections,terminals:[pin]},custom);
 assert.equal(model.terminals.length,3);assert.deepEqual(model.terminals[0],pin);
 assert.deepEqual(model.terminals.slice(1).map(t=>[t.bodyIndex,t.positionMm,t.basis]),[[null,null,'unknown'],[null,null,'unknown']]);
 assert.doesNotThrow(()=>validateTerminalLocations(model,custom));
 assert.deepEqual(terminalReview(model),{scope:'terminal-locations',status:'partial',terminals:3,connections:2,bothPositioned:0,bothSupported:0,
  coverage:{geometry:1,datasheet:0,estimated:0,unknown:2}});
 for(const [replacement,expected] of [
  [{positionMm:[43,21,11]},/特征范围/],[{bodyIndex:12},/其他 BOM/],
  [{positionMm:[0,0,0],featureIndex:0},/整件定位盒/],[{basis:'unknown'},/应留空/]
 ]){
  const t={...pin,...replacement};
  assert.throws(()=>validateTerminalLocations({...model,terminals:[t,...model.terminals.slice(1)]},custom),expected);
 }
 assert.throws(()=>validateTerminalLocations({...model,terminals:[...model.terminals,pin]},custom),/唯一/);
 assert.throws(()=>validateTerminalLocations({...model,terminals:[pin]},custom),/每个/);
 const bulky=structuredClone(custom);bulky.cadPlan.bodies[0].features[1].sizeMm=[2,4,2];
 assert.throws(()=>validateTerminalLocations(model,bulky),/埋在/);
});
test('a generic drawing, pitch, mismatched XYZ and unsupported model claims cannot certify pin coordinates',()=>{
 const run=(sourceQuote,t,refUrl=sourceUrl)=>{
  const design=structuredClone(custom);design.parts[0].geometryReference={sourceUrl:refUrl,sourceQuote};
  return locateDesignTerminals({connections,terminals:[{...pin,...t}]},design).terminals[0];
 };
 const t={basis:'datasheet',sourceUrl,featureIndex:null};
 assert.equal(run('P1: X=3 Y=4 Z=1 mm relative to the board centre.',t).basis,'datasheet');
 for(const [quote,u] of [['10 mm PCB; P1 to P2 pitch 2.54 mm',sourceUrl],['P12 X=3 Y=4 Z=1 mm',sourceUrl],['P1 X=1 Y=2 Z=3 mm',sourceUrl],['P1 X=3 Y=4 Z=1 mm','https://other.example/board']]){
  const row=run(quote,t,u);assert.equal(row.basis,'estimated');assert.equal(row.sourceUrl,'');
 }
 assert.equal(run('P1 X=3 Y=4 Z=1 mm',{featureIndex:null}).basis,'estimated');
});
test('legacy project is unchanged, registered geometry and estimated anchors have separate coverage',()=>{
 const model=locateDesignTerminals(prior.interaction,prior);
 assert.equal(prior.interaction.terminals,undefined);
 assert.doesNotThrow(()=>validateInteraction(prior.interaction,prior));
 assert.doesNotThrow(()=>validateInteraction(model,prior));
 assert.equal(connectedTerminalPins(prior.interaction.connections).size,model.terminals.length);
 const report=terminalReview(model);
 assert.ok(report.coverage.geometry>0);assert.ok(report.coverage.estimated>0);assert.ok(report.coverage.unknown>0);
 assert.ok(report.bothSupported>0&&report.bothSupported<=report.bothPositioned);assert.ok(report.bothPositioned<report.connections);
 const modeled=model.terminals.find(t=>t.basis==='geometry'),desired={...modeled,positionMm:[999,999,999]};
 const restored=locateDesignTerminals({...prior.interaction,terminals:[desired]},prior).terminals[0];
 assert.deepEqual(restored,modeled);
 const estimated=model.terminals.find(t=>t.basis==='estimated');
 const unknown={...estimated,basis:'unknown',positionMm:null,featureIndex:null,bodyIndex:null};
 assert.deepEqual(locateDesignTerminals({...prior.interaction,terminals:[unknown]},prior).terminals[0],estimated);
});
test('both fresh and revised design requests submit actual terminal coverage and normalized positions to independent review',async()=>{
 let baseDesign;
 for(let iteration=0;iteration<2;iteration++){
  let reviewCount=0,reviewedChange;
  const target=structuredClone(prior);
  if(iteration)target.cadPlan.bodies[4].positionMm[0]+=.01;
  const response=await generate(new Request('https://example.test/api/design',{method:'POST',body:JSON.stringify({prompt:'阅读用桌面计时器',baseDesign})}),
   {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},async(_,opts)=>{
    const request=JSON.parse(opts.body),stage=request.text?.format?.name;
    if(stage==='mechanical_shortlist')return completed({parts:[]});
    if(stage==='hardware_design'||stage==='hardware_design_revision'){
     assert.match(request.instructions,/interaction\.terminals/);
     if(iteration===0){assert.equal(stage,'hardware_design');assert.ok(request.text.format.schema.properties.interaction.anyOf[0].properties.terminals);}
     else assert.equal(stage,'hardware_design_revision');
     return completed(revisionFixture(request,target));
    }
    assert.equal(stage,'hardware_design_review');reviewCount++;
    const data=JSON.parse(request.input);assert.equal(data.definitionIssues.length,0,data.definitionIssues.join(' '));
    assert.equal(data.wiring.connections,data.candidate.interaction.connections.length);
    assert.equal(data.wiring.terminals,data.candidate.interaction.terminals.length);
    reviewedChange=data.wiring.terminalRevision;
    if(iteration)assert.ok(reviewedChange.checked.some(row=>row.bodyIndex===4&&row.status==='verified'));
    if(iteration)assert.ok(data.geometry.revisionDependencies.changedBodyIndices.includes(4));
    assert.match(request.instructions,/bothSupported/);
    return completed({motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},requiresInteraction:true,checks:['intent','form','mechanism','control'].map(area=>({
     area,status:'pass',note:'测试中核对该项与端点记录。',partIndices:[0],bodyIndices:[0]})),physicalChecks:['实际核对端子丝印与焊接。']});
   });
  const body=await response.json();assert.equal(response.status,200,body.error);assert.equal(reviewCount,1);
  const {terminalRevision,...wiring}=body.design.generation.designReview.wiring;
  assert.deepEqual(terminalRevision,reviewedChange);assert.deepEqual(wiring,terminalReview(body.design.interaction));
  baseDesign=body.design;
 }
});
test('review can inspect CAD terminals despite a bad timer event and a retained draft keeps its terminal evidence',async()=>{
 const broken={...prior,interaction:locateDesignTerminals(structuredClone(prior.interaction),prior)};
 const edge=broken.interaction.transitions.find(t=>t.event==='timer.expired');
 edge.event='made.up';
 let reviews=0;
 const response=await generate(new Request('https://example.test/api/design',{method:'POST',body:JSON.stringify({
  prompt:'阅读用桌面计时器',repairCandidate:{design:broken,issues:['核查计时器转换，请保持接线不变。']}
 })}),{OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},async(_,options)=>{
  const request=JSON.parse(options.body),stage=request.text.format.name;
  if(stage==='mechanical_shortlist')return completed({parts:[]});
  if(stage==='hardware_design_revision'){
   const {rejectedDraft}=JSON.parse(request.input.at(-1).content);
   assert.equal(rejectedDraft.interaction.terminals.length,broken.interaction.terminals.length);
   return completed(revisionFixture(request,broken));
  }
  assert.equal(stage,'hardware_design_review');reviews++;
  const data=JSON.parse(request.input);assert.match(data.definitionIssues.join(' '),/made\.up/);
  assert.equal(data.behavior.status,'unavailable');assert.equal(data.wiring.status,'partial');
  return completed({motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},requiresInteraction:true,checks:['intent','form','mechanism','control'].map(area=>({
   area,status:'pass',note:'测试端点与状态规则独立评审。',partIndices:[0],bodyIndices:[0]})),physicalChecks:['实物复核。']});
 });
 const body=await response.json();assert.equal(response.status,502,body.error);assert.equal(reviews,2);
 assert.equal(body.repairCandidate.design.interaction.terminals.length,broken.interaction.terminals.length);
});
