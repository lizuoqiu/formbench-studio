import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {functionalReviewGuide,modelingGuide,hardwarePolicyGuide} from './modeling-guide.mjs';
import {timerModel} from './test-fixtures/timer-model.mjs';
import {initialInteraction,stepInteraction,validateInteraction} from '../interaction-model.js';

test('functional review uses the same independent, versioned instructions locally and in Workers',async()=>{
 const name='functional-review',sourcePath='skills/'+name+'/SKILL.md';
 const text=await readFile(new URL(sourcePath,import.meta.url),'utf8');
 const revision=/^metadata:\n  revision: ([\w.-]+)$/m.exec(text)[1];
 const policy=await hardwarePolicyGuide('review');
 const local=await functionalReviewGuide();
 assert.deepEqual(local,{text:text+'\n\n'+policy.text,skill:{name,revision,sourcePath,policy:policy.skill}});

 const requests=[];
 const worker=await functionalReviewGuide({ASSETS:{fetch:async request=>{
  requests.push(new URL(request.url).pathname);
  return new Response(await readFile(new URL('.'+new URL(request.url).pathname,import.meta.url),'utf8'));
 }}});
 assert.deepEqual(requests.sort(),['/'+sourcePath,'/skills/hardware-design-policy/SKILL.md'].sort());
 assert.deepEqual(worker,local);
 const previous=await functionalReviewGuide({ASSETS:{fetch:async request=>new Response((await readFile(new URL('.'+new URL(request.url).pathname,import.meta.url),'utf8')).replace('metadata:\n  revision:','revision:'))}});
 assert.deepEqual(previous.skill,local.skill);
 const modeling=await modelingGuide();
 assert.equal(modeling.skill.project.name,'interaction-hardware');
 assert.match(modeling.text,/powered-rotary[\s\S]*powered-mixed[\s\S]*motionRequirements[\s\S]*parentIndex/);
 assert.ok(!modeling.text.includes(local.text));
});

test('functional review rejects a missing resource or a different skill served at its URL',async()=>{
 for(const response of [
  new Response('Not found',{status:404}),
  new Response('<html>Application shell</html>'),
  new Response('---\nname: interaction-hardware\nrevision: 1\n---\nOther skill'),
  new Response('---\nname: functional-review\n---\nUnversioned'),
 ])await assert.rejects(functionalReviewGuide({ASSETS:{fetch:async request=>new URL(request.url).pathname.includes('hardware-design-policy')?
  new Response(await readFile(new URL('./skills/hardware-design-policy/SKILL.md',import.meta.url),'utf8')):response}}),/functional-review/);
});

test('each hardware stage receives a versioned policy subset with local and Worker parity',async()=>{
 const whole=await readFile(new URL('./skills/hardware-design-policy/SKILL.md',import.meta.url),'utf8');
 const revision=/^  revision: ([\w.-]+)$/m.exec(whole)[1];
 for(const stage of ['planning','research','reconstruction','modeling','review','repair']){
  const local=await hardwarePolicyGuide(stage);
  const remote=await hardwarePolicyGuide(stage,{ASSETS:{fetch:async request=>{
   assert.equal(new URL(request.url).pathname,'/skills/hardware-design-policy/SKILL.md');
   return new Response(whole);
  }}});
  assert.deepEqual(remote,local);assert.equal(local.skill.revision,revision);assert.equal(local.skill.stage,stage);
  assert.ok(local.text.length<whole.length,'Stage calls should not resend unrelated chapters');
 }
 const model=await modelingGuide(),repair=await modelingGuide({},{stage:'repair'}),review=await functionalReviewGuide();
 assert.equal(model.skill.policy.stage,'modeling');assert.equal(repair.skill.policy.stage,'repair');assert.equal(review.skill.policy.stage,'review');
 await assert.rejects(hardwarePolicyGuide('unknown'),/Unknown hardware policy stage/);
 await assert.rejects(hardwarePolicyGuide('planning',{ASSETS:{fetch:async()=>new Response(whole.replace('## 方案选择','## Absent'))}}),/Missing hardware policy section/);
});

test('the authoring guide timer example runs with the documented event names and effects',async()=>{
 const {text}=await modelingGuide();
 const snippet=text.match(/这台设备的 transitions。\s*```json\n([\s\S]+?)\n```/);
 assert.ok(snippet,'Missing runnable transitions from the authoring guide');
 const sample=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v4.json',import.meta.url)));
 const model=timerModel(),stateNames={set:'idle',run:'running',pause:'paused',done:'done'};
 model.states=model.states.map(s=>({...s,id:stateNames[s.id]}));
 model.initialState='idle';
 model.transitions=JSON.parse(snippet[1]);
 validateInteraction(model,sample.design);
 let state=initialInteraction(model);
 const send=event=>{state=stepInteraction(model,state,event)};
 send({controlId:'wheel',delta:1});
 assert.equal(state.remainingSeconds,model.timer.initialSeconds+model.timer.stepSeconds);
 send({controlId:'push'});
 send({elapsedSeconds:5});
 const beforePause=state.remainingSeconds;
 send({controlId:'push'});
 send({elapsedSeconds:1000});
 assert.deepEqual([state.stateId,state.remainingSeconds],['paused',beforePause]);
 send({controlId:'push'});
 assert.deepEqual([state.stateId,state.remainingSeconds],['running',beforePause]);
 send({elapsedSeconds:beforePause});
 assert.deepEqual([state.stateId,state.remainingSeconds],['done',0]);
 send({controlId:'push'});
 assert.deepEqual([state.stateId,state.remainingSeconds],['idle',state.setSeconds]);
});
