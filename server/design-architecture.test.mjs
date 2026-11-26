import test from 'node:test';
import assert from 'node:assert/strict';
import {applyArchitectureRevision,inspectArchitecture,inspectMotionRequirements,validMotionRequirements,validateArchitecture} from './design-architecture.mjs';
import {design} from './design.mjs';
import {reviewedFixture,revisionFixture} from './test-fixtures/design-review.mjs';

const supply={model:'Acme Supply A',kind:'purchase',role:'external',placement:'loose'};
const decisions=[{subsystem:'Power',rationale:'Use a compatible external adapter',interfaces:'Barrel jack on rear panel',motion:null,members:[supply]}];

test('contract uses component identity rather than row index and reports changed sourcing and placement',()=>{
  validateArchitecture(decisions);
  const result=inspectArchitecture(decisions,[{model:'Controller'},supply]);
  assert.deepEqual(result.issues,[]);
  assert.equal(result.subsystems[0].members[0].matches[0].partIndex,1);
  assert.equal(inspectArchitecture(decisions,[{...supply,kind:'custom',placement:'mounted'}]).issues.length,1);
  assert.equal(inspectArchitecture(decisions,[{...supply,model:'Acme Supply B'}]).issues.length,1);
  assert.equal(inspectArchitecture(undefined,[]),undefined);
});

test('only a stated revision changes the contract, preserving both versions on a retry',()=>{
  const state={selection:{architecture:decisions}};
  const parts=[{...supply,model:'Acme Supply B'}];
  const changed=[{...decisions[0],members:parts}];
  const repair={attempt:4,architectureRevision:{reason:'Manufacturer replaced the adapter with a compatible variant.',decisions:changed}};
  applyArchitectureRevision(state,{attempt:3});
  assert.equal(state.selection.architecture,decisions);
  assert.throws(()=>applyArchitectureRevision(state,{architectureRevision:{decisions:changed}}),/原因/);
  assert.equal(state.selection.architecture,decisions);
  applyArchitectureRevision(state,repair);
  applyArchitectureRevision(state,repair);
  assert.equal(state.architectureRevisions.length,1);
  assert.equal(state.architectureRevisions[0].previous,decisions);
  assert.deepEqual(inspectArchitecture(state.selection.architecture,parts).issues,[]);
});

test('a reviewed round retains its assembly decisions and a positive review cannot hide a missing selected part',async()=>{
  const part={name:'Pad',model:'Custom P1',kind:'custom',role:'external',placement:'mounted',purpose:'Finger rest',
    qty:1,spec:'Silicone pad',sizeMm:[20,20,12],dimensionSource:'estimated'};
  const body={name:'Pad',partIndex:0,role:'printed',positionMm:[0,0,0],
    features:[{op:'add',shape:'ellipsoid',centerMm:[0,0,0],sizeMm:part.sizeMm}]};
  const value={name:'Finger rest',summary:'A round fingertip pad.',parts:[part],steps:['Seat the pad.'],
    cadPlan:{version:1,bodies:[body],motions:[]},deviceMotion:'stationary',interaction:null};
  const motionRequirements={minRotaryAxes:2,minLinearAxes:0,minSerialRotaryDepth:2};
  const state={selection:{architecture:decisions,motionRequirements,requirements:['Round pad'],parts:[part]},draft:{attempt:1,value}};
  const report={requiresInteraction:false,findings:[],checks:['intent','form','mechanism','control'].map(area=>({
    area,status:'pass',note:'The provided fixture meets this criterion.',partIndices:[0],bodyIndices:[0]
  })),physicalChecks:[]};
  let evidence;
  const response=await design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'Create a fingertip rest.'})}),
    {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture',PUBLIC_WORKER:'1'},async(_url,options)=>{
      const request=JSON.parse(options.body);
      assert.equal(request.text.format.name,'hardware_design_review');
      const input=typeof request.input==='string'?request.input:request.input[0].content;
      evidence=JSON.parse(input).architectureEvidence;
      return Response.json({status:'completed',model:'fixture',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(report)}]}]});
    },{id:'fixture',state,shouldPause:async()=>true,progress:async()=>{},loadCompiled:async()=>({bodies:[]})});
  const result=await response.json();
  assert.equal(result.paused,true,JSON.stringify(result));
  assert.match(evidence.issues[0],/Acme Supply A/);
  assert.deepEqual(state.rounds[0].review.architecture,evidence);
  assert.deepEqual(state.rounds[0].review.motion.required,motionRequirements);
  assert.equal(state.rounds[0].review.motion.source,'part-selection');
  assert.equal(state.rounds[0].review.motion.observed.rotaryAxes,0);
  assert.deepEqual(state.issueLedger.filter(row=>row.check==='definition.motion.minimum').map(row=>row.residual),[2,2]);
  assert.ok(state.rounds[0].issues.some(issue=>issue.includes('Acme Supply A')));
});

test('motion requirements compare powered axes and the longest rotary parent chain independently',()=>{
  const requirement={minRotaryAxes:3,minLinearAxes:1,minSerialRotaryDepth:2};
  const plan={joints:[null,null,1].map(parentIndex=>({parentIndex})),motions:[{}]};
  assert.deepEqual(inspectMotionRequirements(requirement,plan),{required:requirement,observed:{rotaryAxes:3,linearAxes:1,serialRotaryDepth:2},issues:[]});
  const separate={...plan,joints:[null,null,null].map(parentIndex=>({parentIndex}))};
  assert.match(inspectMotionRequirements(requirement,separate).issues.join(' '),/父子链层数最低要求 2，当前 CAD 为 1/);
  assert.equal(inspectMotionRequirements(requirement,{joints:[],motions:[]}).issues.length,3);
  assert.deepEqual(inspectMotionRequirements({...requirement,minRotaryAxes:0,minSerialRotaryDepth:0},{motions:[{}]}).issues,[]);
  assert.equal(inspectMotionRequirements(undefined,{motions:[{}]}),undefined);
  assert.equal(validMotionRequirements({...requirement,minSerialRotaryDepth:4}),false);
});

for(const planningAvailable of [true,false])test(
  'direct API enforces the '+(planningAvailable?'intake':'independent reviewer fallback')+' motion requirement on the first draft and its revision',
  async()=>{
  const requirement={minRotaryAxes:2,minLinearAxes:0,minSerialRotaryDepth:2};
  const body={name:'Pad',partIndex:0,role:'printed',positionMm:[0,0,0],features:[{op:'add',shape:'box',centerMm:[0,0,0],sizeMm:[10,8,2]}]};
  const value={name:'Pad',summary:'A fixed pad.',deviceMotion:'stationary',interaction:null,steps:['Fit the pad.'],
    parts:[{name:'Pad',model:'P',kind:'custom',role:'enclosure',placement:'mounted',purpose:'Support',spec:'Pad',qty:1,sizeMm:[10,8,2]}],
    cadPlan:{version:1,bodies:[body],motions:[],joints:[]}};
  const completed=data=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});
  const stages=[];
  const response=await design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'An articulated inspection arm.'})}),
    {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture',PUBLIC_WORKER:'1'},async(_url,options)=>{
      const input=JSON.parse(options.body),stage=input.text.format.name;stages.push(stage);
      if(stage==='mechanical_shortlist')return planningAvailable?completed({parts:[],motionRequirements:requirement}):new Response('Service unavailable',{status:503});
      if(stage==='hardware_design_review'){
        const data=JSON.parse(input.input);
        if(data.motionEvidence){
          assert.deepEqual(data.motionEvidence.required,requirement);
          assert.equal(data.motionEvidence.observed.rotaryAxes,0);
          assert.equal(data.motionEvidence.source,planningAvailable?'mechanical-shortlist':'independent-review');
          return reviewedFixture(input);
        }
        assert.equal(planningAvailable,false);
        assert.ok(input.text.format.schema.required.includes('motionRequirements'));
        const review=await reviewedFixture(input).json();
        const content=review.output[0].content[0];
        content.text=JSON.stringify({...JSON.parse(content.text),motionRequirements:requirement});
        return Response.json(review);
      }
      return completed(revisionFixture(input,value));
    });
  const result=await response.json();
  assert.equal(response.status,502,JSON.stringify(result));
  assert.equal(result.design,undefined);
  assert.match(result.review.issues.join(' '),/主动旋转轴数最低要求 2，当前 CAD 为 0/);
  assert.match(result.review.issues.join(' '),/父子链层数最低要求 2/);
  assert.deepEqual(stages,['mechanical_shortlist','hardware_design','hardware_design_review','hardware_design_revision','hardware_design_review']);
});

test('an explicit change to a static model can supersede an earlier serial motion contract',async()=>{
  const fixed={minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0};
  const priorRequired={minRotaryAxes:2,minLinearAxes:0,minSerialRotaryDepth:2};
  const parts=['Base','Link 1','Link 2'].map(name=>({name,model:name,kind:'custom',role:'internal',placement:'mounted',purpose:name,
    qty:1,spec:'Fixture bar',sizeMm:[5,5,2],dimensionSource:'estimated'}));
  const bodies=parts.map((p,i)=>({name:p.name,partIndex:i,role:'printed',positionMm:[i*10,0,0],
    features:[{op:'add',shape:'box',centerMm:[0,0,0],sizeMm:p.sizeMm}]}));
  const joints=[0,1].map(i=>({name:'J'+i,axis:[0,0,1],pivotMm:[10*i,0,0],minDegrees:-90,maxDegrees:90,
    fixedBodyIndex:i,movingBodyIndices:i?[2]:[1,2],actuatorPartIndex:i,parentIndex:i?0:null}));
  const prior={name:'Arm',summary:'Rotating links.',parts,steps:['Fit the links.'],deviceMotion:'powered-rotary',
    cadPlan:{version:1,bodies,motions:[],joints},generation:{designReview:{motion:{required:priorRequired}}}};
  const target={...prior,name:'Static model',summary:'Fixed links.',deviceMotion:'stationary',cadPlan:{...prior.cadPlan,joints:[]}};
  delete target.generation;
  const completed=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
  const prompt='Change it to a static display with fixed links.';
  const response=await design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt,baseDesign:prior})}),
    {OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture',PUBLIC_WORKER:'1'},async(_url,options)=>{
      const input=JSON.parse(options.body);
      if(input.text.format.name==='mechanical_shortlist'){
        const request=JSON.parse(input.input);
        assert.deepEqual(request.previousMotionRequirements,priorRequired);
        assert.deepEqual(request.previousMotion.jointParents,[null,0]);
        return completed({parts:[],motionRequirements:fixed});
      }
      if(input.text.format.name==='hardware_design_revision')return completed(revisionFixture(input,target));
      assert.equal(input.text.format.name,'hardware_design_review');
      const request=JSON.parse(input.input);
      assert.deepEqual(request.previous.previousJoints,joints);
      assert.deepEqual(request.motionEvidence.required,fixed);
      return reviewedFixture(input);
    });
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.deepEqual(result.design.generation.designReview.motion.required,fixed);
});
