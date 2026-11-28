import test from 'node:test';
import assert from 'node:assert/strict';
import {applyArchitectureRevision,inspectArchitecture,inspectMotionRequirements,validMotionRequirements,validateArchitecture} from './design-architecture.mjs';
import {selectParts} from './part-sourcing.mjs';
import {design} from './design.mjs';
import {fixtureProductDelivery,reviewedFixture,revisionFixture} from './test-fixtures/design-review.mjs';

const supply={model:'Acme Supply A',kind:'purchase',role:'external',placement:'loose'};
const decisions=[{subsystem:'Power',rationale:'Use a compatible external adapter',interfaces:'Barrel jack on rear panel',motion:null,members:[supply]}];

for(const deviceUse of ['companion-interface','result-viewer'])test('personal terminals may command and display with role '+deviceUse,()=>{
  const device={model:'Shelf counter X4',kind:'provided',role:'enclosure',placement:'loose',deviceUse:'product-core'};
  const phone={model:'Personal screen Z',kind:'provided',role:'external',placement:'loose',deviceUse};
  const architecture=[{...decisions[0],members:[device,phone]}],parts=[phone,device];
  const inspect=(interaction,cadPlan)=>inspectArchitecture(architecture,parts,{interaction,cadPlan});
  const controls=[{id:'calibrate',partIndex:0,kind:'command',signalPins:['CONTROL']}];
  const digital={controllerPartIndex:0,controls,outputs:[{id:'review',partIndex:0,kind:'web'}],systemEvents:[
    {id:'connected',partIndex:0,kind:'connection'}, {id:'clock_sync',partIndex:0,kind:'timeout'},
    {id:'state',partIndex:0,kind:'feedback',sourcePins:['CONTROL']}]};
  assert.deepEqual(inspect(digital,{joints:[{actuatorPartIndex:1,controllerPartIndex:0}]}).issues,[]);
  assert.deepEqual(inspect(digital).companionFeedbackToReview,[{eventId:'state',partIndex:0,sourcePins:['CONTROL'],sharedControls:['calibrate']}]);
  const hardwareFeedback={id:'threshold',partIndex:1,kind:'feedback',sourcePins:['PRESSURE']};
  assert.deepEqual(inspect({...digital,systemEvents:[hardwareFeedback],recorder:{sampleEvents:['threshold']}}).issues,[]);
  const phoneMeasurement={...hardwareFeedback,partIndex:0};
  assert.match(inspect({...digital,systemEvents:[phoneMeasurement]}).issues.join(' '),/物理测量.*Personal screen Z/);
  assert.match(inspect({...digital,systemEvents:[{id:'change',partIndex:0}],recorder:{sampleEvents:['change']}}).issues.join(' '),/Personal screen Z/);
  assert.match(inspect(digital,{joints:[{actuatorPartIndex:0}]}).issues.join(' '),/Personal screen Z/);
  const ambiguous={id:'packet',label:'温度检查通过',kind:'feedback',partIndex:0,sourcePins:['RX']};
  const observation=inspect({...digital,systemEvents:[ambiguous]});
  assert.deepEqual(observation.issues,[]);
  assert.deepEqual(observation.companionFeedbackToReview,[{eventId:'packet',partIndex:0,sourcePins:['RX']}]);
  const received=inspect({...digital,systemEvents:[phoneMeasurement],connections:[{kind:'signal',fromPartIndex:1,
    fromPin:'OUT',toPartIndex:0,toPin:'PRESSURE'}]});
  assert.deepEqual(received.issues,[]);
  assert.deepEqual(received.companionFeedbackToReview[0].inboundPins,['PRESSURE']);
  const relayedRecording=inspect({...digital,systemEvents:[phoneMeasurement],recorder:{sampleEvents:['threshold']},
    connections:[{kind:'signal',fromPartIndex:1,fromPin:'OUT',toPartIndex:0,toPin:'PRESSURE'}]});
  assert.deepEqual(relayedRecording.issues,[]);
  assert.deepEqual(relayedRecording.companionFeedbackToReview[0].inboundPins,['PRESSURE']);
  const previous={selection:{architecture}};
  const revision=members=>({architectureRevision:{reason:'Change the product.',decisions:[{...decisions[0],members}]}});
  assert.throws(()=>applyArchitectureRevision(previous,revision([phone,supply])),/部件承担/);
  assert.throws(()=>applyArchitectureRevision(previous,revision([{...phone,deviceUse:'personal-device-core'}])),/独立硬件/);
  assert.deepEqual(previous.selection.architecture,architecture);
});

test('a documented clock reference on a companion may supply time for calibration',()=>{
  const clock={id:'clock_source',kind:'clock',model:'Terminal V',sourceUrl:'https://vendor.example/terminal',
    quote:'The module provides the factory time reference.',sourceSha256:'a'.repeat(64)};
  const terminal={...supply,model:clock.model,deviceUse:'companion-interface',sourcing:{factoryInterfaces:[clock]}};
  const reference={...supply,model:'Dedicated photo gate',deviceUse:'product-core'};
  const plan=[{...decisions[0],members:[reference,terminal]}];
  const interaction={controllerPartIndex:1,systemEvents:[{id:'sync',kind:'feedback',partIndex:1,
    label:'校时',sourcePins:['builtin:clock_source']}]};
  const observation=inspectArchitecture(plan,[reference,terminal],{interaction});
  assert.deepEqual(observation.issues,[]);
  assert.equal(observation.companionFeedbackToReview,undefined);
  const unknown=inspectArchitecture(plan,[reference,{...terminal,sourcing:{factoryInterfaces:[]}}],{interaction});
  assert.deepEqual(unknown.issues,[]);
  assert.equal(unknown.companionFeedbackToReview[0].eventId,'sync');
});

test('a documented wireless port carries observations for source review, including recorded samples',()=>{
  const wifi={id:'radio',kind:'wifi',model:'Link client',sourceUrl:'https://vendor.example/radio',
    quote:'The terminal can receive packets over Wi-Fi.',sourceSha256:'b'.repeat(64)};
  const terminal={...supply,model:wifi.model,deviceUse:'companion-interface',sourcing:{factoryInterfaces:[wifi]}};
  const sensor={...supply,model:'Wireless light meter',deviceUse:'product-core'};
  const design=[{...decisions[0],members:[sensor,terminal]}];
  const event={id:'telemetry',kind:'feedback',partIndex:1,sourcePins:['builtin:radio']};
  for(const recorder of [null,{sampleEvents:['telemetry']}]){
    const inspect=e=>inspectArchitecture(design,[sensor,terminal],{interaction:{controllerPartIndex:1,
      connections:[],systemEvents:[e],recorder}});
    const forwarded=inspect(event);
    assert.deepEqual(forwarded.issues,[]);
    assert.deepEqual(forwarded.companionFeedbackToReview,[{eventId:'telemetry',partIndex:1,
      sourcePins:['builtin:radio'],wirelessPins:['BUILTIN:RADIO']}]);
    const local=inspect({...event,sourcePins:['ACCEL_X','builtin:radio']});
    assert.match(local.issues.join(' '),/物理测量.*Link client/);
  }
});

test('planning corrects a personal-device design before sourcing and still accepts zero custom parts',async()=>{
  const personal={...supply,model:'Personal device W',kind:'provided',deviceUse:'personal-device-core'};
  const bought={...supply,model:'Dedicated indicator D',deviceUse:'product-core'};
  const plan=members=>({name:'Quiet door indicator',summary:'Show when the door opens.',requirements:['Visible indication'],
    motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},
    architecture:[{...decisions[0],members}],parts:members.map(({deviceUse,...part})=>({...part,name:part.model,qty:1}))});
  const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'};
  function respond(values,calls){
    return async(_url,options)=>{
      const request=JSON.parse(options.body);calls.push(request);
      assert.equal(request.text.format.name,'part_selection');
      return Response.json({status:'completed',model:'fixture',output:[{type:'web_search_call',status:'completed',action:{sources:[]}},
        {type:'message',content:[{type:'output_text',text:JSON.stringify(values[calls.length-1])}]}]});
    };
  }
  const bad=plan([personal]),good=plan([bought,{...personal,deviceUse:'result-viewer'}]),calls=[];
  const selected=await selectParts({prompt:'Show me whether the door has opened.',history:[]},env,respond([bad,good],calls),new AbortController().signal);
  assert.equal(calls.length,2);
  assert.match(calls[1].input.at(-1).content,/承担了核心功能/);
  assert.equal(selected.parts.length,2);assert.ok(selected.parts.every(p=>p.kind!=='custom'));
  const failedCalls=[],state={};
  const res=await design(new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'提醒我门什么时候打开。'})}),
    env,respond([bad,bad],failedCalls),{id:'fixture',state,progress:async()=>{}});
  const failure=await res.json();
  assert.equal(res.status,422);assert.equal(failure.actionRequired,'independent-hardware');assert.equal(failure.retryable,false);
  assert.equal(failedCalls.length,2);assert.equal(state.selection,undefined);
});

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
  const report={productDelivery:fixtureProductDelivery,requiresInteraction:false,findings:[],checks:['intent','form','mechanism','control'].map(area=>({
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
  assert.equal(result.design.generation.designReview.productDelivery.status,'independent-hardware');
  assert.deepEqual(result.design.generation.designReview.motion.required,fixed);
});
