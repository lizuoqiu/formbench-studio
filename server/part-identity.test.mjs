import test from 'node:test';
import assert from 'node:assert/strict';
import {partIdentity} from '../part-records.js';
import {researchPart,sourceParts,sourcesForModel,sourcingIssues} from './part-sourcing.mjs';
import {reconstructParts} from './part-reconstruction.mjs';
import {withLocalCodex} from './openai-response.mjs';

const env={OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'},signal=()=>new AbortController().signal;
const answer=(value,urls=[])=>Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:urls.map(url=>({url}))}},
 {type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const selected={name:'connector',model:'Vendor A1',kind:'purchase',placement:'mounted'};

test('a researched replacement cannot lend its links or dimensions to the selected SKU',async()=>{
 const url='https://vendor.example/b2',cad='https://vendor.example/b2.step';
 const record=await researchPart(selected,env,async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.text.format.name,'part_research');assert.equal(body.text.format.strict,true);
  return answer({model:'Vendor B2',productUrl:url,sourceUrl:url,extentMm:[12,15,20],cadUrl:cad,cadAuthority:'manufacturer'},[url,cad]);
 },signal());
 assert.equal(record.model,selected.model);assert.equal(record.identityStatus,'mismatch');
 assert.equal(record.productUrl,'');assert.equal(record.cadUrl,'');assert.deepEqual(record.extentMm,[]);
 assert.equal(record.alternatives[0].model,'Vendor B2');assert.equal(record.alternatives[0].cadUrl,cad);
 assert.match(sourcingIssues({parts:[selected]},{[partIdentity(selected)]:record})[0],/对应型号未确认/);
 await reconstructParts([selected],{[partIdentity(selected)]:record},env,async()=>{throw Error('Unmatched evidence must not be modeled');},signal());
});

test('explicit candidates keep independent verified URLs and cannot introduce unobserved links',async()=>{
 const a='https://vendor.example/a1',b='https://vendor.example/b2';
 const r=await researchPart(selected,env,async()=>answer({model:selected.model,productUrl:a,sourceUrl:a,extentMm:[10,10,10],
  alternatives:[{model:'Vendor B2',productUrl:b,sourceUrl:b,extentMm:[20,20,20],cadUrl:'https://invented.example/b2.step'}]},[a,b]),signal());
 assert.equal(r.identityStatus,'matched');assert.deepEqual(r.extentMm,[10,10,10]);
 assert.equal(r.alternatives[0].productUrl,b);assert.equal(r.alternatives[0].cadUrl,'');assert.deepEqual(r.alternatives[0].extentMm,[20,20,20]);
 await assert.rejects(researchPart(selected,env,async()=>answer({productUrl:a},[a]),signal()),/缺少明确的对应型号/);
});

test('preserved source links keep their earlier provider when newer research only verifies a product page',async()=>{
 const identity=partIdentity(selected),earlierDate='2026-11-21T10:00:00Z',newerDate='2026-11-23T10:00:00Z';
 const earlierDrawing='https://vendor.example/old-drawing',product='https://vendor.example/product';
 const cache={[identity]:{model:selected.model,kind:'purchase',evidenceModel:selected.model,identityStatus:'matched',
  sourceUrl:earlierDrawing,sourceQuote:'Earlier source fact',extentMm:[10,10,10],observedUrls:[earlierDrawing],queriedAt:earlierDate}};
 const deps={research:async()=>({model:selected.model,identityStatus:'matched',evidenceModel:selected.model,productUrl:product,
  sourceUrl:'',sourceQuote:'Unverified quote',extentMm:[],observedUrls:[product],queriedAt:newerDate,
  researchProvenance:{provider:'local-codex',model:'gpt-6.2-sol',reasoning:{effort:'ultra'}}}),fetchSource:async()=>({})};
 await sourceParts([{...selected,researchQuestion:'Verify exactly this part'}],cache,env,null,signal(),undefined,null,deps);
 const record=cache[identity];
 assert.deepEqual(record.observedUrls,[product]);
 assert.equal(record.linkProvenance.productUrl.provider,'local-codex');
 assert.equal(record.linkProvenance.productUrl.queriedAt,newerDate);
 assert.equal(record.linkProvenance.sourceUrl.provider,'openai-api');
 assert.equal(record.linkProvenance.sourceUrl.queriedAt,earlierDate);
 assert.equal(record.sourceQuote,'Earlier source fact');
 assert.deepEqual(record.extentMm,[10,10,10]);
});

test('relay capacity failure leaves the unprocessed part cache intact',async()=>{
 const identity=partIdentity(selected),saved={model:selected.model,kind:'purchase',lastResearchQuestion:'Older focused question',
  sourceUrl:'https://vendor.example/drawing',reconstruction:{sizeMm:[10,10,10]}};
 const cache={[identity]:structuredClone(saved)},relayEnv=withLocalCodex(env,{binary:process.execPath,effort:'ultra'});
 const blocked=Object.assign(Error('Model at capacity'),{actionRequired:'local-codex-unavailable'}),started=[];
 await assert.rejects(()=>sourceParts([{...selected,researchQuestion:'Recheck'}, {...selected,model:'Vendor A2'}],cache,relayEnv,null,
  signal(),undefined,null,{research:async part=>{started.push(part.model);throw blocked;}}),e=>e===blocked);
 assert.deepEqual(started,[selected.model]);
 assert.deepEqual(cache,{[identity]:saved});
});

test('targeted alternatives preserve confirmed current evidence and require explicit BOM reselection',async()=>{
 const cache={[partIdentity(selected)]:{model:selected.model,kind:'purchase',identityStatus:'matched',evidenceModel:selected.model,
  productUrl:'https://vendor.example/a1',sourceUrl:'https://vendor.example/a1',reconstruction:{sizeMm:[10,10,10]}}},calls=[];
 const deps={research:async part=>{calls.push(part.model);return part.model===selected.model?
  {model:part.model,identityStatus:'mismatch',evidenceModel:'',productUrl:'',sourceUrl:'',cadUrl:'',alternatives:[{model:'Vendor B2',productUrl:'https://vendor.example/b2'}]}:
  {model:part.model,identityStatus:'matched',evidenceModel:part.model,productUrl:'https://vendor.example/b2'};},fetchSource:async()=>({})};
 await sourceParts([{...selected,researchQuestion:'Find a compatible replacement'}],cache,env,null,signal(),undefined,null,deps);
 assert.equal(cache[partIdentity(selected)].productUrl,'https://vendor.example/a1');
 assert.deepEqual(cache[partIdentity(selected)].reconstruction.sizeMm,[10,10,10]);
 assert.equal(cache[partIdentity(selected)].alternatives[0].model,'Vendor B2');
 await sourceParts([{...selected,model:'Vendor B2'}],cache,env,null,signal(),undefined,null,deps);
 assert.deepEqual(calls,['Vendor A1','Vendor B2']);assert.equal(cache[partIdentity({model:'Vendor B2'})].productUrl,'https://vendor.example/b2');
});

test('legacy targeted evidence is rechecked before reuse and quarantined when identity remains unknown',async()=>{
 const part={...selected,researchQuestion:'Find replacement'},cache={[partIdentity(selected)]:{model:selected.model,kind:'purchase',attempts:9,
  lastResearchQuestion:part.researchQuestion,productUrl:'https://vendor.example/b2',sourceUrl:'https://vendor.example/b2',
  importedModel:{sourceUrl:'https://vendor.example/b2.step'},reconstruction:{sizeMm:[20,20,20]}}};
 let calls=0;
 const deps={research:async p=>{calls++;assert.equal(p.previousEvidence.identityUnconfirmed,true);throw Error('source service unavailable');}};
 await sourceParts([part],cache,env,null,signal(),undefined,null,deps);
 const record=cache[partIdentity(part)];assert.equal(calls,1);assert.equal(record.identityStatus,'mismatch');
 assert.equal(record.productUrl,undefined);assert.equal(record.importedModel,undefined);assert.equal(record.reconstruction,undefined);
 assert.equal(record.unverifiedEvidence.productUrl,'https://vendor.example/b2');
 assert.equal(sourcesForModel([part],[record])[0].research.unverifiedEvidence,undefined);
});

test('a truncated research reply is saved and the retry receives more output budget',async()=>{
 const cache={};let calls=0;
 const deps={research:async p=>{if(++calls===1)throw Object.assign(Error('incomplete'),{incompleteReason:'max_output_tokens',partialOutput:'{"model":"Vendor A1"'});
  assert.equal(p.researchTokenBudget,32768);assert.equal(p.researchDraft,'{"model":"Vendor A1"');
  return {model:selected.model,identityStatus:'matched',evidenceModel:selected.model,productUrl:'https://vendor.example/a1'};},fetchSource:async()=>({})};
 await sourceParts([selected],cache,env,null,signal(),undefined,null,deps);
 await sourceParts([selected],cache,env,null,signal(),undefined,null,deps);
 assert.equal(calls,2);assert.equal(cache[partIdentity(selected)].researchDraft,undefined);
});

test('ordinary resume validates old targeted records once and preserves a confirmed native model',async()=>{
 const cache={[partIdentity(selected)]:{model:selected.model,kind:'purchase',lastResearchQuestion:'Check mounting interface',
  productUrl:'https://vendor.example/a1',sourceUrl:'https://vendor.example/a1',importedModel:{id:'original-native-cad'}}};let calls=0;
 const deps={research:async p=>{calls++;assert.equal(p.researchQuestion,'Check mounting interface');return {model:p.model,evidenceModel:p.model,identityStatus:'matched',productUrl:'https://vendor.example/a1',sourceUrl:'https://vendor.example/a1'};},fetchSource:async url=>({url,bytes:Buffer.from('<title>'+selected.model+'</title>')})};
 await sourceParts([selected],cache,env,null,signal(),undefined,null,deps);
 await sourceParts([{...selected,researchQuestion:'Check mounting interface'}],cache,env,null,signal(),undefined,null,deps);
 assert.equal(calls,1);assert.equal(cache[partIdentity(selected)].importedModel.id,'original-native-cad');
});
