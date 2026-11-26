import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyFactoryInterfaces} from './factory-interfaces.mjs';
import {attachPartSources,sourceParts,sourcesForModel} from './part-sourcing.mjs';
import {assemblyEvidenceForModel} from './model-geometry-input.mjs';
import {readDesignRequest} from './design-conversation.mjs';
import {observeRun} from './run-events.mjs';
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
 const activity=[];
 const env=observeRun({OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},(event,result)=>{if(event==='part.factory-checked')activity.push(result);});
 const records=await sourceParts([selected],cache,env,send,signal,undefined,null,
  {fetchSource:async u=>{fetched.push(u);return document();}});
 assert.deepEqual(fetched,[url]);
 assert.deepEqual(activity.map(x=>[x.partIndex,x.count,x.checks,x.status]),[[0,3,3,'verified']]);
 const reviewed=sourcesForModel([selected],records);
 const reduced=assemblyEvidenceForModel({selectedParts:reviewed,review:{checks:[{status:'repair',partIndices:[3]}]},terminalBindings:[]});
 assert.deepEqual(reduced.selectedParts[0].research.factoryInterfaces.map(x=>x.id),['touch','display','clock']);
 const [part]=attachPartSources({parts:[selected]},cache).parts;
 assert.equal(part.sourcing.factoryInterfaces.length,3);assert.ok(!Object.hasOwn(records[0],'factoryClaims'));
});
test('an identified technical sheet can print the manufacturer and order code separately',async()=>{
 const verify=async(selected,content)=>verifyFactoryInterfaces(claims,{model:selected,observedUrls:[url]},async()=>({url,bytes:Buffer.from(content)}),signal);
 const page='<main><h1>Nova Instruments controller</h1><p>SKU: LAB-T2</p><p>'+Object.values(quote).join(' ')+'</p></main>';
 assert.equal((await verify('Nova Instruments LAB-T2',page)).length,3);
 assert.equal((await verify('LAB-T2',page)).length,3);
 for(const bad of ['WrongMaker LAB-T2','Nova Instruments LAB-T2B','Nova Instruments LAB-T2 revision 3'])assert.deepEqual(await verify(bad,page),[]);
 assert.deepEqual(await verify('Nova Instruments LAB-T2',page.replace('SKU: LAB-T2','SKU: LAB-T2A and SKU: LAB-T2')),[]);
});
test('technical evidence falls back to another observed document and records only its affirmative wording',async()=>{
 const shop='https://shop.example/products/t2',guide='https://docs.example/guide/model',reads=[],checks=[];
 const quoted='The front has an integrated capacitive touch screen.';
 const source='<main><h1>Nova Controls</h1><p>SKU: LAB-T2</p><p>'+quoted+'</p><p>A connector for an optional speaker is provided.</p></main>';
 const inputs=[{id:'touch',kind:'touch',quote:'Integrated capacitive touchscreen rated for 4K resolution',sourceUrl:shop},
  {id:'audio',kind:'sound',quote:'Integrated speaker',sourceUrl:shop}];
 const verified=await verifyFactoryInterfaces(inputs,{model:'Nova Controls LAB-T2',sourceUrl:guide,observedUrls:[shop,guide]},async u=>{
  reads.push(u);if(u===shop)throw Error('HTTP 429');return {url:u,bytes:Buffer.from(source)};
 },signal,v=>checks.push(v));
 assert.deepEqual(reads,[shop,guide]);assert.deepEqual(verified.map(v=>[v.id,v.sourceUrl,v.quote]),[['touch',guide,quoted]]);
 assert.deepEqual(checks.map(c=>[c.id,c.reason]),[['touch','document-statement'],['audio','quote-unconfirmed']]);
 assert.deepEqual(await verifyFactoryInterfaces([{...inputs[1],quote:'optional speaker',sourceUrl:guide}],{model,observedUrls:[guide]},async()=>({url:guide,bytes:Buffer.from(source)}),signal),[]);
});
test('an essential built-in is checked before CAD even when research did not provide a quote',async()=>{
 const sel={model:'Copper Labs Field Reader v2.1 CR-42A',name:'reader',kind:'purchase',placement:'mounted',
  selectedIdentity:{manufacturer:'Copper Labs',productName:'Field Reader',orderCode:'CR-42A',revision:'v2.1'},requiredFactoryFunctions:['touch','display']};
 const href='https://docs.copperlabs.example/devices/field-reader',source='<main><h1>Field Reader v2.1</h1><p>SKU: CR-42A</p><p>It has an integrated capacitive touch screen.</p></main>';
 const cache={};let searches=0;
 const [r]=await sourceParts([sel],cache,{},null,signal,undefined,null,{research:async()=>{
  searches++;return {model:sel.model,identityStatus:'matched',sourceUrl:href,observedUrls:[href],factoryClaims:[]};
 },fetchSource:async()=>({url:href,bytes:Buffer.from(source)})});
 assert.equal(searches,1);assert.deepEqual(r.factoryInterfaces.map(x=>x.kind),['touch','display']);
 assert.deepEqual(r.factoryInterfaces[0].documentIdentity,{manufacturer:'copperlabs',productName:'Field Reader v2.1',orderCode:'CR-42A',revision:'v2.1'});
 assert.equal(r.factoryChecks[0].reason,'document-statement');
});
test('a missing essential interface gets one focused documentation lookup and stays unverified on failure',async()=>{
 const sel={model,name:'panel',kind:'purchase',placement:'mounted',requiredFactoryFunctions:['touch']},cache={},queries=[];
 const deps={research:async x=>{queries.push(x.researchQuestion);return {model,identityStatus:'matched',sourceUrl:url,observedUrls:[url]};},
  fetchSource:async()=>({url,bytes:Buffer.from('<main><h1>LAB-T2</h1><p>Uses an external touchscreen accessory.</p></main>')})};
 const [r]=await sourceParts([sel],cache,{},null,signal,undefined,null,deps);
 await sourceParts([sel],cache,{},null,signal,undefined,null,deps);
 assert.equal(queries.length,2);assert.match(queries[1],/touch/);assert.deepEqual(r.factoryInterfaces,[]);
 assert.equal(r.builtinResearchAttempted,true);assert.equal(r.factoryChecks[0].status,'unverified');
});
test('a property in the identified technical specifications can prove an integrated part without a model-generated quote',async()=>{
 const spec='<main><h1>LAB-T2</h1><p>The device features a capacitive touchscreen.</p><table><tr><td>RTC</td><td>RB1025</td></tr>'+
  '<tr><td>Speaker</td><td>Optional accessory</td></tr><tr><td>Push button socket</td><td>PB1</td></tr></table></main>';
 const checks=[],r=await verifyFactoryInterfaces([],{model,sourceUrl:url,observedUrls:[url],requiredFactoryFunctions:['clock','touch','sound','button']},
  async()=>({url,bytes:Buffer.from(spec)}),signal,c=>checks.push(c));
 assert.deepEqual(r.map(v=>v.kind),['clock','touch']);assert.equal(checks[0].reason,'document-specification');assert.equal(r[0].quote,'RTC RB1025');
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
