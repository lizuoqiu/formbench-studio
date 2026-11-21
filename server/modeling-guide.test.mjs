import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {functionalReviewGuide,modelingGuide} from './modeling-guide.mjs';
import {timerModel} from './test-fixtures/timer-model.mjs';
import {initialInteraction,stepInteraction,validateInteraction} from '../interaction-model.js';

test('functional review uses the same independent, versioned instructions locally and in Workers',async()=>{
 const name='functional-review',sourcePath='skills/'+name+'/SKILL.md';
 const text=await readFile(new URL(sourcePath,import.meta.url),'utf8');
 const revision=/^metadata:\n  revision: ([\w.-]+)$/m.exec(text)[1];
 const local=await functionalReviewGuide();
 assert.deepEqual(local,{text,skill:{name,revision,sourcePath}});

 const requests=[];
 const worker=await functionalReviewGuide({ASSETS:{fetch:async request=>{
  requests.push(new URL(request.url).pathname);
  return new Response(text);
 }}});
 assert.deepEqual(requests,['/'+sourcePath]);
 assert.deepEqual(worker,local);
 const previous=await functionalReviewGuide({ASSETS:{fetch:async()=>new Response(text.replace('metadata:\n  revision:','revision:'))}});
 assert.deepEqual(previous.skill,local.skill);
 const modeling=await modelingGuide();
 assert.equal(modeling.skill.project.name,'interaction-hardware');
 assert.ok(!modeling.text.includes(local.text));
});

test('functional review rejects a missing resource or a different skill served at its URL',async()=>{
 for(const response of [
  new Response('Not found',{status:404}),
  new Response('<html>Application shell</html>'),
  new Response('---\nname: interaction-hardware\nrevision: 1\n---\nOther skill'),
  new Response('---\nname: functional-review\n---\nUnversioned'),
 ])await assert.rejects(functionalReviewGuide({ASSETS:{fetch:async()=>response}}),/functional-review/);
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
