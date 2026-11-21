import {reviewedFixture} from './test-fixtures/design-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {design} from './design.mjs';

const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture-model'};
const url='https://www.pololu.com/product/4942',file='https://www.pololu.com/file/0J123/example.step';
const chosen={manufacturer:'Pololu',mpn:'U3V16F6',domain:'pololu.com'};
const cited={manufacturer:'Pololu',mpn:'U3V16F6',sourceUrl:url,sourceQuote:'Overall dimensions: 13.1 × 8.1 × 2.82 mm',detail:'本型号无排针整件的外形尺寸。',extentMm:[13.1,8.1,2.82],cadUrl:file};
const part={name:'稳压板',spec:'无排针 Pololu 板',model:'Pololu U3V16F6',modelId:'',sizeMm:[13.1,8.1,2.82],dimensionSource:'estimated',dimensionQuote:'',role:'internal',placement:'mounted',purpose:'电源',qty:1};
const body={partIndex:0,name:'电源板',positionMm:[4,5,6],role:'reference',features:[{op:'add',shape:'box',centerMm:[0,0,0],sizeMm:part.sizeMm,rotationDeg:[0,0,0]}]};
const raw={name:'电源盒',summary:'电源板固定在盒内。',parts:[part],steps:['核查接口'],cadPlan:{version:1,bodies:[body],motions:[]},deviceMotion:'stationary'};
function completed(value,output=[]){
 return Response.json({status:'completed',model:'actual-model',output:[...output,{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
}
async function run({request={},rows=[cited],sources=[url,file],candidates=[chosen],final=raw,fail=false}={}){
 const calls=[],result=await design(new Request('https://example.test/api/design',{method:'POST',body:JSON.stringify({prompt:'给不公开的工坊做一个6V模块',...request})}),env,async(_,options)=>{
  const data=JSON.parse(options.body),review=reviewedFixture(data);
  if(review)return review;
  calls.push(data);
  if(data.text?.format?.name==='mechanical_shortlist')return completed({parts:candidates});
  if(data.tools)return fail?Response.json({}, {status:503}):completed({parts:rows},[{type:'web_search_call',status:'completed',action:{type:'search',sources:sources.map(url=>({url}))}}]);
  return completed(final);
 });
 assert.equal(result.status,200);
 return {calls,design:(await result.json()).design};
}
test('sources reach the model before CAD on initial and revised designs; public lookup gets only identifiers',async()=>{
 for(const request of [{},{baseDesign:raw,conversation:[{role:'user',text:'未发表项目仅改板子位置'}]}]){
  const {calls,design:d}=await run({request});
  assert.equal(calls.length,3);
  assert.equal(calls[0].text.format.name,'mechanical_shortlist');
  assert.ok(calls[0].input.includes('不公开的工坊'));
  assert.deepEqual(JSON.parse(calls[1].input),[{manufacturer:'Pololu',mpn:'U3V16F6'}]);
  assert.deepEqual(calls[1].tools,[{type:'web_search',filters:{allowed_domains:['pololu.com']}}]);
  assert.doesNotMatch(JSON.stringify(calls[1]),/不公开|未发表项目|data:image/);
  assert.equal(calls[2].text.format.name,'hardware_design');
  const data=JSON.parse(calls[2].input.at(-1).content);
  assert.equal(data.mechanicalResearch.sources[0].sourceQuote,cited.sourceQuote);
  assert.ok(!calls[2].instructions.includes(cited.sourceQuote));
  assert.deepEqual(d.generation.mechanicalResearch,{status:'searched',requested:1,found:1});
  assert.equal(d.parts[0].dimensionSource,'datasheet');
  assert.equal(d.parts[0].geometryReference.kind,'datasheet-approximation');
  assert.equal(d.parts[0].geometryReference.cadUrl,file);
  assert.equal(d.parts[0].modelId,'');
  assert.deepEqual(d.cadPlan,raw.cadPlan);
 }
});
test('require exact model and issuer with a returned tool source; do not attach arbitrary CAD links',async()=>{
 for(const entry of [
  {...cited,sourceUrl:'https://www.pololu.com/not-consulted',cadUrl:''},
  {...cited,sourceUrl:'https://pololu.com.retailer.org/listing',cadUrl:''},
  {...cited,mpn:'U3V16F9',cadUrl:''}
 ]){
  const {design:d}=await run({rows:[entry],sources:[url,'https://pololu.com.retailer.org/listing']});
  assert.equal(d.parts[0].geometryReference,undefined);assert.equal(d.parts[0].dimensionSource,'estimated');
 }
 const {design:d}=await run({sources:[url]});
 assert.equal(d.parts[0].geometryReference.cadUrl,undefined);
 const switched=await run({final:{...raw,parts:[{...part,model:'Pololu U3V16F6 + carrier'}]}});
 assert.equal(switched.design.parts[0].geometryReference,undefined);
 const custom=await run({final:{...raw,cadPlan:{...raw.cadPlan,bodies:[{...body,role:'printed'}]}}});
 assert.equal(custom.design.parts[0].geometryReference,undefined);
 const chip=await run({rows:[{...cited,sourceQuote:'IC package: WSON 13.1 × 8.1 × 2.82 mm'}]});
 assert.equal(chip.design.parts[0].geometryReference,undefined);
});
test('single measurements, extra mounting allowances and user overrides never become manufacturer dimensions',async()=>{
 const {design:partial}=await run({rows:[{...cited,sourceQuote:'PCB thickness 1.02 mm',detail:'厂图的PCB厚度为 1.02 mm。'}]});
 assert.equal(partial.parts[0].geometryReference.sourceUrl,url);assert.equal(partial.parts[0].dimensionSource,'estimated');
 const {design:bare}=await run({rows:[{...cited,sourceQuote:'Board outline: 13.1 × 8.1 × 2.82 mm'}]});
 assert.equal(bare.parts[0].dimensionSource,'estimated');
 const {design:invented}=await run({rows:[{...cited,sourceQuote:'PCB thickness 1.02 mm',detail:'板厚 1.02 mm，还有孔距 17 mm。'}]});
 assert.doesNotMatch(invented.parts[0].geometryReference.detail,/17/);
 const {design:spaced}=await run({final:{...raw,parts:[{...part,sizeMm:[23,14,8]}]}});
 assert.equal(spaced.parts[0].dimensionSource,'estimated');assert.equal(spaced.parts[0].dimensionSourceUrl,url);
 const changed={...part,sizeMm:[13,8,3],dimensionSource:'specified',dimensionQuote:'稳压板 13×8×3 mm'};
 const {design:specified}=await run({request:{prompt:changed.dimensionQuote},final:{...raw,parts:[changed]}});
 assert.equal(specified.parts[0].dimensionSource,'specified');assert.equal(specified.parts[0].geometryReference.sourceUrl,url);assert.equal(specified.parts[0].dimensionSourceUrl,'');
 const {design:link}=await run({rows:[{...cited,sourceUrl:'',detail:'',sourceQuote:''}]});
 assert.equal(link.parts[0].dimensionSource,'estimated');assert.equal(link.parts[0].geometryReference.kind,'envelope-approximation');
});
test('unavailable lookup still generates estimates; empty and local-model shortlists skip search',async()=>{
 const failed=await run({fail:true});
 assert.equal(failed.design.generation.mechanicalResearch.status,'unavailable');assert.equal(failed.design.parts[0].dimensionSource,'estimated');
 for(const candidates of [[],[{manufacturer:'Seeed Studio',mpn:'XIAO ESP32S3',domain:'seeedstudio.com'}]]){
  const {calls,design:d}=await run({candidates});
  assert.equal(calls.length,2);assert.equal(d.generation.mechanicalResearch.status,'no-candidates');assert.equal(calls[1].text.format.name,'hardware_design');
 }
});

test('signed 2226 partial evidence survives a revised BOM, different shortlist and rewritten headerless spec',async()=>{
 const jewel={manufacturer:'Adafruit',mpn:'2226',domain:'adafruit.com'},product='https://www.adafruit.com/product/2226';
 const jewelfacts={...jewel,sourceUrl:product,sourceQuote:'PCB diameter: 23 mm',detail:'标称板外径 23 mm。',extentMm:[],cadUrl:''};
 const row={...part,name:'NeoPixel Jewel',model:'Adafruit 2226',sizeMm:[23,23,4],spec:'无排针 NeoPixel Jewel RGB。板外径 23 mm，含灯珠高度暂估 4 mm。'};
 const assembly={...raw,parts:[row]};
 const first=(await run({rows:[jewelfacts],sources:[product],candidates:[jewel],final:assembly})).design;
 const proof=first.parts[0].mechanicalEvidenceReceipt;
 assert.match(proof,/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
 const revised={...assembly,parts:[{...row,spec:'无排针 NeoPixel Jewel；Ø23 mm，含灯珠厚度暂估 4 mm。固定背面。'}]};
 const next=await run({request:{baseDesign:first},final:revised});
 const result=next.design.parts[0];
 assert.equal(result.dimensionSource,'estimated');assert.equal(result.geometryReference.sourceQuote,jewelfacts.sourceQuote);
 assert.deepEqual(next.design.generation.mechanicalResearch,{status:'searched',requested:1,found:1,inherited:1});
 assert.notEqual(result.mechanicalEvidenceReceipt,proof);
 assert.ok(!JSON.stringify(next.calls).includes(proof));assert.ok(!JSON.stringify(next.calls).includes('mechanicalEvidenceReceipt'));
 assert.ok(JSON.parse(next.calls[2].input.at(-1).content).mechanicalResearch.sources.some(r=>r.model==='Adafruit 2226'));
 const third=await run({request:{baseDesign:next.design},candidates:[],final:revised});
 assert.equal(third.design.parts[0].geometryReference.sourceUrl,product);
 const changed=await run({request:{baseDesign:first},candidates:[],final:{...assembly,parts:[{...row,spec:'已焊排针版本'}]}});
 assert.equal(changed.design.parts[0].geometryReference,undefined);
});
test('untrusted edits, copied receipts and unsigned legacy evidence cannot certify dimensions or enter final model context',async()=>{
 const original=(await run()).design.parts[0];
 const marker='unverified-external-claim';
 for(const previous of [
  {...original,mechanicalEvidenceReceipt:original.mechanicalEvidenceReceipt.slice(0,15)+'q'+original.mechanicalEvidenceReceipt.slice(16)},
  {...original,mechanicalEvidenceReceipt:undefined},
  {...original,model:'Same named carrier'}, {...original,spec:'改过的采购规格'},
  {...original,modelSourceInvalidated:true}
 ]){
  const base={...raw,parts:[{...previous,dimensionNote:marker,geometryReference:{sourceUrl:'https://not-a-source.example',detail:marker}}]};
  const next=await run({request:{baseDesign:base},candidates:[]});
  assert.equal(next.design.parts[0].mechanicalEvidenceReceipt,undefined);
  assert.equal(next.design.parts[0].geometryReference,undefined);
  assert.equal(next.design.parts[0].dimensionSource,'estimated');
  assert.doesNotMatch(JSON.stringify(next.calls.at(-1).input),/unverified-external-claim/);
 }
});
test('new dimensions are compared again on every revision; conflicting sources never promote the new extent',async()=>{
 const initial=(await run()).design;
 const larger={...raw,parts:[{...part,sizeMm:[23,14,8]}]};
 const off=await run({request:{baseDesign:initial},candidates:[],final:larger});
 assert.equal(off.design.parts[0].dimensionSource,'estimated');assert.equal(off.design.parts[0].geometryReference.sourceUrl,url);
 const fallback=await run({request:{baseDesign:off.design},fail:true});
 assert.equal(fallback.design.parts[0].dimensionSource,'datasheet');assert.equal(fallback.design.generation.mechanicalResearch.inherited,1);
 const revisedUrl='https://www.pololu.com/file/latest-dimensions.pdf';
 const conflicted=await run({request:{baseDesign:initial},rows:[{...cited,sourceUrl:revisedUrl,extentMm:[23,14,8],sourceQuote:'Overall dimensions: 23 × 14 × 8 mm'}],sources:[revisedUrl],final:larger});
 assert.equal(conflicted.design.parts[0].dimensionSource,'estimated');assert.match(conflicted.design.parts[0].geometryReference.detail,/不一致/);
});
