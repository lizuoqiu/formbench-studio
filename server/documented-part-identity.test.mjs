import test from 'node:test';
import assert from 'node:assert/strict';
import {documentedPartIdentity,selectedOrderIdentity} from './documented-part-identity.mjs';

const printed={manufacturers:['Copper Labs'],names:['Field Reader compact v2.1'],codes:['CR-42A']};
test('a catalogue part retains its fields across display ordering and preserves the precise revision',()=>{
 for(const label of ['CR-42A','Copper Labs CR-42A','Field Reader v2.1 CR-42A',
  'Copper Labs Field Reader v2.1 CR-42A','Copper Labs CR-42A Field Reader v2.1',
  'CR-42A – Field Reader v2.1 (Copper Labs)']){
  const result=documentedPartIdentity(label,printed);
  assert.equal(result?.orderCode,'CR-42A',label);
  assert.equal(result.productName,printed.names[0]);assert.equal(result.revision,'v2.1');
 }
 for(const wrong of ['WrongMaker CR-42A','Copper Labs Field Reader v2.10 CR-42A','Copper Labs Field Reader v3.1 CR-42A',
  'Copper Labs Field Reader v2.1 CR-42B','Copper Labs Field Reader v2.1 CR-42A-B','Copper Labs Field Reader Pro CR-42A']){
  assert.equal(documentedPartIdentity(wrong,printed),null,wrong);
 }
});
test('a structured selection resolves translated display labels only against the original make, MPN, product and revision',()=>{
 const model='Copper Labs 便携阅读器 v2.1 CR-42A',order={manufacturer:'Copper Labs',productName:'Field Reader',orderCode:'CR-42A',revision:'2.1'};
 assert.deepEqual(selectedOrderIdentity(model,order),order);
 assert.equal(documentedPartIdentity(model,printed,order,order)?.orderCode,'CR-42A');
 assert.equal(documentedPartIdentity(model.replace('便携阅读器','便携阅读器 Pro'),printed,order,order),null);
 assert.equal(documentedPartIdentity(model,printed,order),null,'a search suggestion cannot supply missing evidence for an unstructured selection');
 for(const fields of [{...printed,manufacturers:['Different Brand']},{...printed,codes:['CR-42B']},
  {...printed,names:['Field Reader v2.10']},{...printed,names:['Drive Unit v2.1']}])assert.equal(documentedPartIdentity(model,fields,order,order),null);
 assert.equal(selectedOrderIdentity(model,{...order,orderCode:'CR-42'}),undefined);
 assert.equal(selectedOrderIdentity(model,{...order,manufacturer:'Other'}),undefined);
});
test('a distributor number without a requested brand cannot identify an unrelated numeric SKU',()=>{
 const fields={names:['Geared belt motor'],codes:['501'],manufacturers:['Alto']};
 assert.equal(documentedPartIdentity('501',fields),null);
 assert.equal(documentedPartIdentity('Alto 501',fields).orderCode,'501');
 assert.equal(documentedPartIdentity('Beta 501',fields),null);
 assert.equal(documentedPartIdentity('501',fields,{manufacturer:'Beta',orderCode:'501'}),null);
});
