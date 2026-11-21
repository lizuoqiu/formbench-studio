import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHandoffBundle,readHandoffBundle,assemblyHandoffUI,MAX_HANDOFF_BYTES} from '../assembly-handoff.js';
import {createCadBinding,resolveModelForRow,readBindingGeometry} from '../model-selection.js';

const design={name:'样机',summary:'安装按钮后试验',parts:[{name:'按钮',spec:'3 × 4 mm',qty:1},{name:'支架',spec:'1.2 mm 壁',qty:2}],steps:['检查安装间隙。','固定支架。']};
const file=await readFile(new URL('../assets/hardware/buzzer/socket.stl',import.meta.url));
const item={sku:'P7 | 红色',skuId:'37653',url:'https://item.taobao.com/item.htm?id=43&skuId=37653&utm_source=test',title:'按钮',quantity:4,price:399,cart:true};
const cadBindings={0:await createCadBinding({part:design.parts[0],item,kind:'manufacturer',model:'P7',file:new File([file],'switch.stl'),notes:'图纸参考'}),1:await createCadBinding({part:design.parts[1],kind:'dimensions',model:'B2',shape:'box',sizeMm:[20,30,4],holes:[{x:4,y:4,diameter:2}],notes:'卡尺测量'})};
const st={design,isSample:true,items:{0:item},cadBindings,cadDims:{w:75,d:33,h:22},assemblyStepParts:{0:[1,0],1:[1]},quote:{vendor:'private'},fitConfirmed:true,shipping:12,assembly:'private'};

test('round trip embeds actual CAD and dimension data, preserves exact part selections and restores only the real reference profile',async()=>{
  const bundle=createHandoffBundle(st),text=JSON.stringify(bundle),next=readHandoffBundle(text,{sampleDesign:design});
  assert.deepEqual(next.design,design);assert.deepEqual(next.cadDims,st.cadDims);assert.deepEqual(next.assemblyStepParts,{0:[0,1],1:[1]});
  const model=resolveModelForRow(next.design.parts[0],next.items[0],next.cadBindings[0]);
  assert.equal(model.stale,false);assert.equal(model.kind,'binding');assert.equal(next.cadBindings[0].fileBase64,file.toString('base64'));
  assert.ok((await readBindingGeometry(next.cadBindings[0])).meshes.length);
  assert.deepEqual(next.cadBindings[1],st.cadBindings[1]);assert.equal(next.isSample,true);
  assert.deepEqual(createHandoffBundle(next),bundle);
  for(const privateValue of ['399','utm_source','private','fitConfirmed','shipping','\"cart\"']) assert.ok(!text.includes(privateValue));
  assert.equal(readHandoffBundle(text).isSample,false);
  assert.equal(readHandoffBundle(JSON.stringify({...bundle,design:{...design,steps:['其他设计','固定支架。']}}),{sampleDesign:design}).isSample,false);
});
test('reject unexpected row indices, paths, URL schemes and oversized packages',()=>{
  const valid=createHandoffBundle(st),read=o=>readHandoffBundle(JSON.stringify({...valid,...o}));
  assert.throws(()=>read({assemblyStepParts:{0:[99]}}));assert.throws(()=>read({items:JSON.parse('{"__proto__":{}}')}));
  assert.throws(()=>read({cadBindings:{0:{...valid.cadBindings[0],fileName:'../file.stl'}}}));assert.throws(()=>read({items:{0:{url:'javascript:alert(1)'}}}));
  assert.throws(()=>readHandoffBundle(' '.repeat(MAX_HANDOFF_BYTES+1)));
  const extra=read({quote:{vendor:'evil'},assembly:true,fitConfirmed:true,items:{0:{...valid.items[0],cart:true}}});
  assert.equal(extra.quote,null);assert.equal(extra.assembly,undefined);assert.equal(extra.fitConfirmed,undefined);assert.equal(extra.items[0].cart,undefined);
});
test('UI escapes untrusted part names and step text; missing links remain explicit',()=>{
  const s={design:{...design,parts:[{name:'<img src=x>',spec:'&',qty:2}],steps:['<script>']},items:{}};
  const html=assemblyHandoffUI(s);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/本步尚未标注对应零件/);
});

test('a supplier-authored package needs no private keys or profile; steps show current model and mounting guidance',()=>{
  const item={manufacturer:'Example Devices',mpn:'R-17',url:'https://shop.example.org/part?mpn=R-17&variant=normally-open&utm_medium=email&gclid=99'};
  const notes='磁铁标记面朝向门框；确认间距 < 4 mm。';
  const record={kind:'supplier',model:'R-17',notes,fileName:'r17.stl',fileBase64:file.toString('base64')};
  const packet={format:'formwork-assembly-project',version:1,design,items:{0:item},cadBindings:{0:record},assemblyStepParts:{0:[0]}};
  const next=readHandoffBundle(JSON.stringify(packet));
  assert.equal(next.isSample,false);assert.equal(next.items[0].mpn,'R-17');assert.equal(next.items[0].manufacturer,'Example Devices');
  assert.equal(next.items[0].url,'https://shop.example.org/part?mpn=R-17&variant=normally-open');
  assert.equal(resolveModelForRow(design.parts[0],next.items[0],next.cadBindings[0]).stale,false);
  assert.equal(next.cadBindings[0].fileBase64,record.fileBase64);
  const html=assemblyHandoffUI(next);assert.match(html,/本步零件与装配要点[\s\S]*Example Devices · R-17/);assert.match(html,/磁铁标记面朝向门框；确认间距 &lt; 4 mm。/);
  assert.match(html,/href="\.\/samples\/assembly-example\.json"/);
  const withOldKey=readHandoffBundle(JSON.stringify({...packet,cadBindings:{0:{...record,purchaseKey:'previous-sku'}}}));
  assert.equal(withOldKey.cadBindings[0].purchaseKey,'previous-sku');assert.ok(withOldKey.cadBindings[0].partKey);
  const staleHtml=assemblyHandoffUI(withOldKey);assert.match(staleHtml,/旧绑定已停用/);assert.doesNotMatch(staleHtml,/磁铁标记面朝向门框/);
  assert.deepEqual(createHandoffBundle(next).items,next.items);
});

test('assembly handoff links only the parts in this step and retains the step across a remount of the same project',async()=>{
  const project={design,items:{},assemblyStepParts:{0:[0],1:[1]}};
  const {mountAssemblyHandoff}=await import('../assembly-handoff.js');
  const listeners={},nodes=new Map();
  const root={matches:()=>true,querySelector(s){if(!nodes.has(s))nodes.set(s,{focus(){}});return nodes.get(s)},addEventListener(k,fn){listeners[k]=fn},removeEventListener(k){delete listeners[k]}};
  const links=st=>[...assemblyHandoffUI(st).matchAll(/data-assembly-model="(\d+)"/g)].map(m=>Number(m[1]));
  assert.deepEqual(links(project),[0]);
  const dispose=mountAssemblyHandoff(root,project);
  await listeners.click({target:{closest:()=>({dataset:{ah:'next'}})}});
  dispose();
  assert.deepEqual(links(project),[1]);assert.match(assemblyHandoffUI(project),/步骤 2 \/ 2/);
  assert.deepEqual(links({...project}),[0]);
});
