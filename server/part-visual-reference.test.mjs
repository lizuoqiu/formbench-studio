import test from 'node:test';import assert from 'node:assert/strict';
import {inspectProductDocument,loadPartVisual,withVisualInput} from './part-visual-reference.mjs';
const base='https://maker.example/servo';const doc=(html,url=base)=>({url,bytes:Buffer.from(html)});
const product=(sku,path)=>({'@type':'Product',name:'Nova '+sku,sku,brand:'Nova',url:path,image:'/img/'+sku+'.png'});
const html=products=>`<script type="application/ld+json">${JSON.stringify(products)}</script>`;
test('only the selected full product matches; mentions and sibling variants do not',()=>{
 assert.equal(inspectProductDocument(doc(html(product('A10',base))+'<h1>Nova A1</h1>'),'Nova A1').status,'unverified');
 assert.equal(inspectProductDocument(doc('<h1>Motor family</h1><p>Nova A1</p>'),'Nova A1').status,'unverified');
 const s=html([product('A1','?variant=1'),product('A10','?variant=10')]);
 assert.equal(inspectProductDocument(doc(s),'Nova A1').status,'family');assert.equal(inspectProductDocument(doc(s,base+'?variant=10'),'Nova A1').status,'family');
 const good=inspectProductDocument(doc(s,base+'?variant=1'),'Nova A1');assert.equal(good.status,'matched');assert.equal(good.imageUrl,'https://maker.example/img/A1.png');
 assert.equal(inspectProductDocument(doc('<h1>Raspberry Pi Pico</h1>'),'Raspberry Pi Pico').status,'matched');
});
test('visual reconstruction sends real image bytes, missing images leave text only',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=','base64');const visual=await loadPartVisual({visualUrl:base},undefined,async()=>({url:base,bytes:png}));assert.equal(visual.meta.mime,'image/png');assert.equal(withVisualInput('x',visual)[0].content[1].image_url,'data:image/png;base64,'+png.toString('base64'));
 const empty=await loadPartVisual({visualUrl:base},undefined,async()=>doc('<title>not an image</title>'));assert.equal(withVisualInput('x',empty),'x');
});
