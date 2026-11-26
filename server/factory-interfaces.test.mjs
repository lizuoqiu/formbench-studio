import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyFactoryInterfaces} from './factory-interfaces.mjs';
import {attachPartSources,sourceParts,sourcesForModel} from './part-sourcing.mjs';
import {assemblyEvidenceForModel} from './model-geometry-input.mjs';
import {readDesignRequest} from './design-conversation.mjs';
import {partIdentity} from '../part-records.js';
import {validateInteraction,initialInteraction,stepInteraction} from '../interaction-model.js';
import {recorderFixture} from './test-fixtures/timer-model.mjs';

const model='LAB-T2',url='https://maker.example/docs/LAB-T2',type='text/html';
const quote={touch:'The integrated capacitive touch panel handles several touch regions.',display:'Includes a 2 inch LCD display.',clock:'Onboard real-time clock with battery backup.'};
const claims=Object.entries(quote).map(([kind,quote])=>({id:kind,kind,quote,sourceUrl:url}));
const document=(name=model,extra='')=>({url,type,bytes:Buffer.from('<main><h1>'+name+' controller</h1><p>'+Object.values(quote).join(' ')+'</p></main>'+extra)});
const signal=new AbortController().signal;
const evidence=(items=claims,fetchSource=async()=>document())=>verifyFactoryInterfaces(items,{model,observedUrls:[url]},fetchSource,signal);
test('accept the selected model and literal source text once; ignore other models, related page content and unobserved URLs',async()=>{
 let reads=0;const result=await evidence(claims,async()=>{reads++;return document()});assert.equal(reads,1);assert.deepEqual(result.map(x=>x.id),['touch','display','clock']);assert.match(result[0].sourceSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(await evidence(claims,async()=>document('LAB-T20')),[]);
 assert.deepEqual(await evidence([{...claims[0],sourceUrl:'https://other.example/unsourced'}]),[]);
 assert.deepEqual(await evidence([{...claims[0],quote:'Optional external touchscreen accessory.'}],async()=>document(model,'<aside>Optional external touchscreen accessory.</aside>')),[]);
 assert.deepEqual(await evidence([{...claims[0],quote:'This board has no touch sensor.'}],async()=>({url,type,bytes:Buffer.from('<main><h1>LAB-T2</h1>This board has no touch sensor.</main>')})),[]);
});
test('normal procurement verifies a product document once and keeps the observed functions in the assembly input',async()=>{
 const selected={model,name:'LCD controller',kind:'purchase',placement:'mounted'},cache={},fetched=[];
 const unseen='https://elsewhere.example/unseen';
 const send=async()=>Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:[{url}]}},
  {type:'message',content:[{type:'output_text',text:JSON.stringify({model,productUrl:url,sourceUrl:url,
   factoryClaims:[...claims,{...claims[0],id:'spare',sourceUrl:unseen}]})}]}]});
 const records=await sourceParts([selected],cache,{OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},send,signal,undefined,null,
  {fetchSource:async u=>{fetched.push(u);return document();}});
 assert.deepEqual(fetched,[url]);
 const reviewed=sourcesForModel([selected],records);
 const reduced=assemblyEvidenceForModel({selectedParts:reviewed,review:{checks:[{status:'repair',partIndices:[3]}]},terminalBindings:[]});
 assert.deepEqual(reduced.selectedParts[0].research.factoryInterfaces.map(x=>x.id),['touch','display','clock']);
 const [part]=attachPartSources({parts:[selected]},cache).parts;
 assert.equal(part.sourcing.factoryInterfaces.length,3);assert.ok(!Object.hasOwn(records[0],'factoryClaims'));
});
async function design(){
 const {design}=JSON.parse(readFileSync(new URL('../samples/shared/reading-timer/v4.json',import.meta.url)));
 const raw=design.parts[4]={...design.parts[4],model,name:'Controller with integrated panel',kind:'purchase',placement:'mounted'};
 const record={model,kind:'purchase',identityStatus:'matched',factoryInterfaces:await evidence()},cache={[partIdentity(raw)]:record};
 const board=attachPartSources(design,cache);assert.equal(sourcesForModel([raw],[record])[0].research.factoryInterfaces.length,3);
 const m=recorderFixture(),idx=board.cadPlan.bodies.findIndex(b=>b.partIndex===4),input=id=>({id,label:id,kind:'touch',partIndex:4,fixedBodyIndex:idx,movingBodyIndices:[],axis:[0,0,1],pivotMm:[0,0,0],step:0,range:null,signalPins:['builtin:touch']});
 m.controls=[input('begin'),input('finish')];m.outputs[0]={...m.outputs[0],partIndex:4,bodyIndices:[idx],signalPin:'builtin:display'};
 m.connections=m.connections.filter(w=>w.toPartIndex!==11&&w.fromPartIndex!==11);m.systemEvents=m.systemEvents.filter(e=>e.id==='sample');
 m.systemEvents.push({id:'deadline',label:'记录到期',kind:'timeout',partIndex:4,sourcePins:['builtin:clock'],condition:'达到时长',delayMs:120000});m.transitions.push({from:'capture',event:'deadline',to:'review',effect:'none'});
 return {board,m};
}
test('an unopened module shares its verified touch surface between actions and displays real, separately wired sensor samples',async()=>{
 const {board,m}=await design(),verified=validateInteraction(m,board);
 let a=stepInteraction(verified,initialInteraction(verified),{controlId:'begin'});a=stepInteraction(verified,a,{elapsedSeconds:37});a=stepInteraction(verified,a,{systemEventId:'sample'});a=stepInteraction(verified,a,{systemEventId:'deadline'});assert.equal(a.stateId,'review');assert.equal(a.recording.entries[0].atSeconds,37);
 assert.ok(!verified.connections.some(w=>w.fromPin.startsWith('builtin:')||w.toPin.startsWith('builtin:')));
});
test('a built-in function cannot replace an external lead, motor, host command, or another variant',async()=>{
 for(const change of [
  (m,b)=>{b.parts[4].model='LAB-T2B'},
  (m,b)=>{delete b.parts[4].sourcing.factoryInterfaces},
  m=>{m.connections=m.connections.filter(w=>w.toPin!=='D4'&&w.fromPin!=='D4')},
  m=>{m.controls[0].kind='command'},
  m=>{m.outputs[0].kind='motion'},
  m=>{m.outputs[0].partIndex=11},
  m=>{m.connections[0].fromPin='builtin:touch'},
  m=>{m.systemEvents[0].sourcePins=['builtin:clock']},
 ]){
  const {board,m}=await design();change(m,board);assert.throws(()=>validateInteraction(m,board),/交互设计/);
 }
});
test('a shared project can be reopened for revision without promoting the submitted document receipts to new evidence',async()=>{
 const {board,m}=await design();
 const request=()=>new Request('http://localhost/api/design',{method:'POST',body:JSON.stringify({prompt:'Update the enclosure',baseDesign:{...board,interaction:m}})});
 const {baseDesign}=await readDesignRequest(request());
 assert.deepEqual(baseDesign.interaction.controls[0].signalPins,['builtin:touch']);assert.equal(baseDesign.parts[4].sourcing,undefined);
 board.parts[4].model='LAB-T2B';
 await assert.rejects(()=>readDesignRequest(request()),/交互定义/);
});
