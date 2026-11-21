import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {serviceCapabilities,generateDesign,findProducts,makeCart,sampleDesign} from '../consumer-service.js';

const at=(t,href,fetcher)=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL(href)});
  t.after(()=>{if(old)Object.defineProperty(globalThis,'location',old);else delete globalThis.location});
  return t.mock.method(globalThis,'fetch',fetcher);
};
const part={name:'红色 LED',spec:'5 mm 直插'};
const choice={url:'https://item.taobao.com/item.htm?id=123&skuId=42',title:'测试商品',qty:2,options:['红色']};

test('Pages makes no service or loopback requests, including for carts',async t=>{
  const fetcher=at(t,'https://example.github.io/work/',()=>{throw Error('unexpected request')});
  assert.deepEqual(await serviceCapabilities(),{ai:false,catalog:false,cart:'manual',localUrl:'http://127.0.0.1:4173/'});
  await assert.rejects(generateDesign('桌面指示灯'),e=>e.localUrl==='http://127.0.0.1:4173/');
  const r=await findProducts(part);
  assert.deepEqual(r.candidates,[]);assert.equal(new URL(r.searchUrl).searchParams.get('q'),'红色 LED 5 mm 直插');
  assert.equal((await makeCart([choice])).state,'manual');assert.equal(fetcher.mock.callCount(),0);
});
test('deployment-relative API, listing canonicalisation and source SKU preservation',async t=>{
  at(t,'https://demo.example.edu/research/app/',(url,init)=>{
    assert.equal(url.href,'https://demo.example.edu/research/app/api/catalog');
    assert.deepEqual(JSON.parse(init.body),part);assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');
    return Response.json({candidates:[choice,{...choice,url:choice.url+'&ref=a'},{...choice,url:'https://invalid.test/item.htm?id=123'},{...choice,skuId:'99'}]});
  });
  const out=await findProducts(part);
  assert.equal(out.candidates.length,1);assert.equal(out.candidates[0].skuId,'42');assert.deepEqual(out.candidates[0].options,['红色']);
});
test('cart sends confirmed specification only, rejects stray links and never upgrades a handoff to a verified purchase',async t=>{
  const fetcher=at(t,'http://127.0.0.1:4173/',(url,init)=>{
    assert.equal(url.pathname,'/api/cart');assert.equal(JSON.parse(init.body).items[0].skuId,'42');return Response.json({state:'links_ready',verified:false,links:[{url:'https://cart.taobao.com/cart.htm',count:1},{url:'https://unrelated.invalid/',count:8}]});
  });
  assert.equal((await makeCart([{...choice,skuId:'14'}])).state,'needs_selection');
  assert.equal(fetcher.mock.callCount(),0);
  const out=await makeCart({lines:[choice]});assert.equal(out.state,'links_ready');assert.equal(out.verified,false);assert.equal(out.links.length,1);
});
test('sample size labels refer to real local reference geometry',async()=>{
  const d=sampleDesign();assert.equal(d.parts.length,6);
  for (const p of d.parts){
    const dir=p.modelId.endsWith('-led')?'led':p.modelId;
    const md=JSON.parse(await readFile(new URL('../assets/hardware/'+dir+'/metadata.json',import.meta.url)));
    const size=md.sizeMm||md.boundsMm[0].map((v,i)=>+(md.boundsMm[1][i]-v).toFixed(3));assert.deepEqual(p.sizeMm,size);assert.equal(p.dimensionSource,'catalog');
  }
});
test('design without a known catalog match preserves unknown dimensions',async t=>{
  at(t,'https://test.example/site/',(url,init)=>{
    assert.equal(url.pathname,'/site/api/design');assert.deepEqual(JSON.parse(init.body),{prompt:'帮我设计一个小设备'});
    return Response.json({design:{name:'温度计',summary:'室内温度',parts:[{name:'温感头',spec:'待选型',qty:1}],steps:[]}});
  });
  const d=await generateDesign('帮我设计一个小设备');
  assert.equal(d.parts[0].sizeMm,null);assert.equal(d.parts[0].modelId,undefined);
});
test('specific product and user dimensions survive even when name resembles a catalog part',async t=>{
  const common={name:'轻触开关',qty:1,role:'panel',spec:'本项目供应商定制',model:'定制版',purpose:'切换状态',shape:'cylinder',sizeMm:[12,12,9],dimensionNote:'原文：定制按钮直径 12、高 9 mm',dimensionSourceUrl:'https://example.edu/data/switch'};
  const parts=[{...common,dimensionSource:'specified',modelId:'button'},{...common,dimensionSource:'estimated',modelId:''},{...common,name:'库存标准按钮',modelId:'button',dimensionSource:'catalog'}];
  const network=at(t,'https://example.edu/site/',()=>Response.json({design:{name:'测试',parts}}));
  const design=await generateDesign('定制按钮');
  for(const part of design.parts){assert.deepEqual(part.sizeMm,[12,12,9]);assert.equal(part.shape,'cylinder');assert.equal(part.purpose,common.purpose);assert.equal(part.role,'panel');assert.equal(part.dimensionNote,common.dimensionNote);assert.equal(part.dimensionSourceUrl,common.dimensionSourceUrl);}
  assert.deepEqual(design.parts.map(p=>p.modelId),[undefined,undefined,'button']);assert.deepEqual(design.parts.map(p=>p.dimensionSource),['specified','estimated','catalog']);assert.equal(network.mock.callCount(),1);
  assert.deepEqual(sampleDesign().parts.map(p=>p.role),['internal','panel','panel','panel','internal','external']);
  assert.ok(sampleDesign().parts.every(p=>p.purpose));
});
test('reference links require the unchanged sample specification, dimensions and model',async t=>{
  const catalog=JSON.parse(await readFile(new URL('../samples/taobao-parts.json',import.meta.url)));
  const requests=at(t,'https://example.github.io/studio/',(url,opts)=>{
    assert.equal(url.href,'https://example.github.io/studio/samples/taobao-parts.json');assert.equal(opts.mode,'same-origin');return Response.json(catalog);
  });
  const cable=sampleDesign().parts.find(x=>x.modelId==='usb-cable');
  const {candidates:[candidate]}=await findProducts(cable);
  assert.equal(candidate.skuId,'6292854915476');assert.ok(candidate.requiresSelection);assert.deepEqual(candidate.options,[]);
  for(const changed of [{spec:cable.spec+' 5 米'},{sizeMm:[2,4,3]},{modelId:'other'}])assert.deepEqual((await findProducts({...cable,...changed})).candidates,[]);
  const found=await findProducts(sampleDesign().parts[0]);assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].skuId,undefined);assert.equal(requests.mock.callCount(),2);
});
test('compatible browser helper confirms items individually including ones without SKU; duplicate pending batch is not replayed',async t=>{
  at(t,'https://example.github.io/studio/',()=>{throw Error('unexpected fetch')});
  const bus=new EventTarget(),sent=[];let submitted;
  const origin='https://example.github.io';
  const answer=(m,fields)=>{const ev=new Event('message');Object.assign(ev,{source:bus,origin,data:{requestId:m.requestId,version:1,source:'formbench-extension',...fields}});bus.dispatchEvent(ev)};
  bus.postMessage=(m,target)=>{assert.equal(target,origin);sent.push(m.type);
    if(m.type==='FB_HELPER_PING')queueMicrotask(()=>answer(m,{type:'FB_HELPER_PONG'}));
    if(m.type==='FB_CART_PREPARE')submitted=m;
  };
  Object.defineProperty(globalThis,'window',{value:bus,configurable:true});t.after(()=>delete globalThis.window);
  assert.equal((await serviceCapabilities()).cart,'browser');
  const batch=[choice,{title:'选规格',url:'https://item.taobao.com/item.htm?id=456',qty:1,options:[]}];
  const a=makeCart(batch),b=makeCart(batch);await new Promise(setImmediate);
  assert.equal(sent.filter(x=>x==='FB_CART_PREPARE').length,1);assert.equal(submitted.items[1].skuId,undefined);
  answer(submitted,{type:'FB_CART_UPDATE',state:'finished',results:[{index:0,status:'added',message:'页面显示已成功加入购物车'},{index:1,status:'needs_selection',message:'须先确认型号'}]});
  const [one,two]=await Promise.all([a,b]);assert.equal(one.state,'partial');assert.deepEqual(one,two);assert.deepEqual(one.items.map(i=>i.status),['added','needs_selection']);assert.equal(one.verified,false);
});
test('lost or forged helper delivery never triggers a second preparation or an API cart fallback',async t=>{
  const network=at(t,'https://example.github.io/studio/',()=>{throw Error('unexpected request')});
  const bus=new EventTarget(),origin='https://example.github.io';let prepared=0,capture;
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const reply=(req,originUsed,body)=>{
    const ev=new Event('message');Object.assign(ev,{source:bus,origin:originUsed,data:{requestId:req.requestId,version:1,source:'formbench-extension',...body}});bus.dispatchEvent(ev);
  };
  bus.postMessage=m=>{
    if(m.type==='FB_HELPER_PING')queueMicrotask(()=>reply(m,origin,{type:'FB_HELPER_PONG'}));
    if(m.type==='FB_CART_PREPARE'){prepared++;capture=m}
  };
  Object.defineProperty(globalThis,'window',{value:bus,configurable:true});t.after(()=>delete globalThis.window);
  const promise=makeCart([choice]);await new Promise(setImmediate);
  reply(capture,'https://unrelated.example',{type:'FB_CART_UPDATE',state:'finished',results:[{index:0,status:'added'}]});
  reply({...capture,requestId:'not-this-batch'},origin,{type:'FB_CART_UPDATE',state:'finished',results:[{index:0,status:'added'}]});
  t.mock.timers.tick(300000);const out=await promise;
  assert.equal(out.state,'manual');assert.equal(out.items[0].status,'not_confirmed');assert.equal(out.verified,false);assert.equal(prepared,1);assert.equal(network.mock.callCount(),0);
});
test('picker is read-only: one request, official URL + explicit variant required, returns original page title and labels',async t=>{
  const http=at(t,'https://example.github.io/studio/',()=>{throw Error('unexpected request')});
  const bus=new EventTarget(),origin='https://example.github.io',actions=[];let candidate;
  bus.postMessage=m=>{
    actions.push(m.type);
    if(m.type==='FB_PICK_PREPARE'){assert.equal(m.url,undefined);assert.equal(m.partName,part.name);assert.ok(m.query.includes(part.spec));}
    const ev=new Event('message');Object.assign(ev,{source:bus,origin,data:{source:'formbench-extension',version:1,requestId:m.requestId,...(m.type==='FB_HELPER_PING'?{type:'FB_HELPER_PONG'}:{type:'FB_PICK_RESULT',state:'picked',candidate})}});
    queueMicrotask(()=>bus.dispatchEvent(ev));
  };
  Object.defineProperty(globalThis,'window',{value:bus,configurable:true});t.after(()=>delete globalThis.window);
  const {pickProduct}=await import('../consumer-service.js');
  candidate={...choice,title:'店铺实物标题'};const good=await pickProduct(part,'https://example.net/bad');
  assert.equal(good.candidate.listingTitle,candidate.title);assert.equal(good.candidate.titleSource,'page');assert.deepEqual(good.candidate.options,choice.options);
  for(const wrong of [{...choice,options:[]},{...choice,skuId:'999'},{...choice,url:'https://elsewhere.example/?id=123'}]){candidate=wrong;assert.equal((await pickProduct(part)).candidate,undefined);}
  assert.ok(actions.every(x=>['FB_PICK_PREPARE','FB_HELPER_PING'].includes(x)));assert.equal(http.mock.callCount(),0);
});
