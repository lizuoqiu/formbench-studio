import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bindingKeys,createCadBinding,describeSelectedPurchase,readBindingGeometry,resolveModelForRow,validateCadBinding} from '../model-selection.js';

const pico={name:'Raspberry Pi Pico',spec:'RP2040, Micro-B'};
const selectedPico={manufacturer:'Raspberry Pi',mpn:'Pico',sku:'初代无排针'};
const part={name:'专用支架',spec:'R-17 直角固定架'};
const selected={url:'https://supplier.example/part?part=A',title:'固定架',sku:'标准型'};
const measured=(p=part,i=selected)=>({kind:'dimensions',model:'R-17',notes:'按到货件游标卡尺实测，孔距见随件图。',shape:'box',sizeMm:[32,16,4],holes:[{x:6,y:8,diameter:3}],...bindingKeys(p,i)});

test('specific original file outranks catalog; catalog manufacturer model outranks supplier and measured references',async()=>{
 const bytes=await readFile(new URL('../forge/pico-base.stl',import.meta.url));
 const file=new File([bytes],'reference.stl');
 const manufacturer=await createCadBinding({part:pico,item:selectedPico,kind:'manufacturer',model:'Raspberry Pi Pico',file});
 const keep=resolveModelForRow(pico,selectedPico,manufacturer);
 assert.equal(keep.kind,'binding');assert.equal(keep.binding,manufacturer);
 for(const b of [{...manufacturer,kind:'supplier'},validateCadBinding(measured(pico,selectedPico))]){
   const result=resolveModelForRow(pico,selectedPico,b);
   assert.equal(result.kind,'catalog');assert.equal(result.id,'pico');assert.equal(result.binding,null);
 }
});

test('changing to Pico W invalidates the old binding and does not reuse the classic catalog part',()=>{
 const saved=validateCadBinding(measured(pico,selectedPico));
 const after=resolveModelForRow(pico,{...selectedPico,mpn:'Pico W',sku:'W 无线版'},saved);
 assert.equal(after.stale,true);assert.equal(after.kind,'unmatched');assert.equal(after.id,null);assert.equal(after.binding,null);
});

for(const [scenario,before,after] of [
 ['supplier part query','https://supplier.example/part?part=A','https://supplier.example/part?part=B'],
 ['URL-only Taobao SKU','https://item.taobao.com/item.htm?id=1234&skuId=6101','https://item.taobao.com/item.htm?id=1234&skuId=6102']
]){
 test('changing the '+scenario+' invalidates the old binding',()=>{
   const item={url:before},other={url:after},saved=validateCadBinding(measured(part,item));
   const same=resolveModelForRow(part,item,saved);assert.equal(same.stale,false);assert.equal(same.binding,saved);
   assert.notEqual(describeSelectedPurchase(item).key,describeSelectedPurchase(other).key);
   const changed=resolveModelForRow(part,other,saved);assert.equal(changed.stale,true);assert.equal(changed.binding,null);
 });
}

test('tracking parameters and query order preserve the purchase identity',()=>{
 for(const [base,tracked] of [
   ['https://supplier.example/part?part=A&finish=raw','https://supplier.example/part?utm_source=chat&finish=raw&part=A&gclid=12'],
   ['https://item.taobao.com/item.htm?id=1234&skuId=6101','https://item.taobao.com/item.htm?spm=a.b.c&skuId=6101&id=1234']
 ]){
  const item={url:base},updated={url:tracked},saved=validateCadBinding(measured(part,item));
  const same=resolveModelForRow(part,updated,saved);assert.equal(same.stale,false);assert.equal(same.binding,saved);
 }
});

test('a dimension-based binding requires a source or measurements and rejects out-of-bounds geometry',async()=>{
 const b=measured();
 assert.throws(()=>validateCadBinding({...b,notes:'',sourceUrl:''}));
 assert.throws(()=>validateCadBinding({...b,sizeMm:[2001,16,4]}));
 assert.throws(()=>validateCadBinding({...b,holes:[{x:1,y:1,diameter:4}]}));
 const saved=validateCadBinding({...b,notes:'',sourceUrl:'https://supplier.example/R17/drawing'});
 assert.deepEqual((await readBindingGeometry(saved)).sizeMm,[32,16,4]);assert.equal(resolveModelForRow(part,selected,saved).kind,'binding');
});

test('moving a different BOM row into a previously bound index must not display that old part',()=>{
 const saved=validateCadBinding(measured());
 for(const next of [{name:'转轴',spec:part.spec},{...part,spec:'R-18 直角固定架'}]){
   const changed=resolveModelForRow(next,selected,saved);assert.equal(changed.stale,true);assert.equal(changed.binding,null);
 }
});
