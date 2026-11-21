import {reviewedFixture} from './test-fixtures/design-review.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {design,normalizeDesign,schema,instructions} from './design.mjs';
const row={name:'Raspberry Pi Pico',spec:'初代 RP2040，无排针 Micro-B',qty:1,model:'Raspberry Pi Pico R3',modelId:'pico',sizeMm:[90,80,70],dimensionSource:'catalog',dimensionQuote:'',role:'internal',purpose:'控制开关'};
const raw=p=>({name:'传感盒',summary:'采集环境读数',parts:[p],steps:['检查装配空间'],cadPlan:{version:1,bodies:[] }});
test('catalog geometry overrides invented dimensions only for matched packages; other sizes remain estimates',()=>{const p=normalizeDesign(raw(row),'').parts[0];assert.deepEqual(p.sizeMm,[52.3,21,3.73]);assert.equal(p.dimensionSource,'catalog');assert.ok(p.dimensionSourceUrl);const q=normalizeDesign(raw({...row,model:'Raspberry Pi Pico W'}),'').parts[0];assert.equal(q.dimensionSource,'estimated');assert.equal(q.modelId,'');});
test('specified size must be supported by explicit component and dimensions in original prompt',()=>{const s='壳体为 40×30×20 mm';const r={...row,name:'壳体',role:'enclosure',modelId:'',sizeMm:[40,30,20],dimensionSource:'specified',dimensionQuote:s};assert.equal(normalizeDesign(raw(r),s).parts[0].dimensionSource,'specified');assert.equal(normalizeDesign(raw(r),'做个小盒子').parts[0].dimensionSource,'estimated');});
test('model dispatch uses strict structured output and refuses incomplete responses',async()=>{
 const req=()=>new Request('https://workbench.invalid/api/design',{method:'POST',body:JSON.stringify({prompt:'制作湿度报警器'})});
 const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'};
 let generated=false;
 const r=await design(req(),env,async(_,options)=>{
  const b=JSON.parse(options.body),review=reviewedFixture(b);
  if(review)return review;
  assert.equal(b.text.format.name,'hardware_design');assert.equal(b.text.format.strict,true);assert.equal(b.store,false);
  assert.match(b.instructions,/xiao-esp32s3[^\n]+22[.]482×17[.]78×4[.]46/);
  assert.match(b.instructions,/完整 reference body 作锚点/);
  assert.match(b.instructions,/不为增加细节虚构引脚、安装耳、螺孔/);
  generated=true;
  return Response.json({status:'completed',model:'response-model-snapshot',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(raw(row))}]}]});
 });
 assert.ok(generated);assert.equal(r.status,200);
 const d=(await r.json()).design;
 assert.equal(d.parts[0].dimensionSource,'catalog');assert.equal(d.generation.modelId,'response-model-snapshot');
 assert.equal(d.generation.modelSource,'response');assert.ok(d.generation.skill.revision);
 assert.equal((await design(req(),env,async()=>Response.json({status:'incomplete'}))).status,502);
});
test('XIAO ESP32C3 catalog identity uses the cited board reference; the model envelope is not a verified manufacturer solid',()=>{const p=normalizeDesign(raw({...row,name:'Seeed Studio XIAO ESP32C3',spec:'无排针版，USB-C',model:'Seeed Studio XIAO ESP32C3',modelId:'xiao-esp32c3'}),'').parts[0];assert.equal(p.dimensionSource,'catalog');assert.deepEqual(p.sizeMm,[22.463,17.78,4.7]);assert.match(p.dimensionSourceUrl,/seeedstudio\.com.*KiCad/);assert.match(p.dimensionNote,/近似|独立绘制/);});

test('powered translation cannot be published with a static assembly; passive requests remain valid',()=>{
 const stationary={...raw(row),deviceMotion:'stationary'};
 for(const prompt of ['AI 主动伸出然后收回','The device should slowly extend its arm.','装置自行伸出']){
  assert.throws(()=>normalizeDesign(stationary,prompt),/主动伸缩/);
 }
 for(const prompt of ['我主动伸出手碰固定表面','当用户向设备伸出手时，指示灯亮起','装置不要主动伸出，只在按压时振动','The device should not extend.','我只需要碰一个静止的感应面']){
  assert.doesNotThrow(()=>normalizeDesign(stationary,prompt));
 }
 assert.throws(()=>normalizeDesign({...stationary,deviceMotion:'powered-linear'},'桌面互动'),/主动伸缩/);
 assert.throws(()=>normalizeDesign({...stationary,summary:'设备主动伸出面板'},'桌面互动'),/主动伸缩/);
 assert.throws(()=>normalizeDesign(raw({...row,placement:'mounted'}),''),/缺少已安装零件的位置/);
 assert.doesNotThrow(()=>normalizeDesign(raw({...row,placement:'loose'}),''));
});

test('API returns a useful assembly diagnostic or timeout while withholding incomplete designs',async()=>{
 const env={OPENAI_API_KEY:'fixture',OPENAI_MODEL:'unit'}, req=()=>new Request('https://test.invalid/api/design',{method:'POST',body:JSON.stringify({prompt:'动态组件'})});
 const missing={...raw(row),deviceMotion:'powered-linear'};
 const result=await design(req(),env,async(_url,options)=>{
  const review=reviewedFixture(JSON.parse(options.body));
  return review||Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(missing)}]}]});
 });
 assert.equal(result.status,502);
 const error=await result.json();assert.match(error.error,/主动伸缩/);assert.equal(error.design,undefined);
 const timeout=await design(req(),env,async()=>{throw new DOMException('timeout','TimeoutError');});
 assert.equal(timeout.status,504);assert.match((await timeout.json()).error,/5 分钟/);
});

test('exact catalog identity restores an omitted model ID and rejects conflicting variants',()=>{
 const board={...row,name:'主控制板',modelId:'',dimensionSource:'estimated'};
 assert.equal(normalizeDesign(raw(board),'').parts[0].modelId,'pico');
 for(const spec of ['RP2040 无排针 USB-C','RP2040 Micro-B 预焊排针','RP2040 兼容板 Micro-B 无排针']){
  assert.equal(normalizeDesign(raw({...board,spec}),'').parts[0].modelId,'');
 }
 for(const conflicting of [{modelId:'button'},{name:'配套支架'},{role:'enclosure'}]){
  assert.equal(normalizeDesign(raw({...board,...conflicting}),'').parts[0].dimensionSource,'estimated');
 }
 const xiao={...row,name:'USB-C 开发板',model:'Seeed Studio XIAO ESP32C3',modelId:'',spec:'无排针版',dimensionSource:'estimated'};
 assert.equal(normalizeDesign(raw(xiao),'').parts[0].modelId,'xiao-esp32c3');
 const s3={...xiao,model:'Seeed Studio XIAO ESP32S3',spec:'基础版 USB-C',modelId:''};
 const selected=normalizeDesign(raw(s3),'').parts[0];
 assert.equal(selected.modelId,'xiao-esp32s3');assert.deepEqual(selected.sizeMm,[22.482,17.78,4.46]);
 assert.equal(selected.dimensionSource,'catalog');assert.match(selected.dimensionSourceUrl,/seeedstudio/i);
 assert.ok(schema.properties.parts.items.properties.modelId.enum.includes('xiao-esp32s3'));
 assert.match(instructions,/xiao-esp32s3[^\n]+22[.]482×17[.]78×4[.]46/);
 for(const variant of [{spec:'预焊排针版'},{model:'XIAO ESP32S3 Sense'},{model:'XIAO ESP32S3 Plus'},{model:'ESP32-S3'},{modelId:'xiao-esp32c3'}]){
  assert.equal(normalizeDesign(raw({...s3,...variant}),'').parts[0].modelId,'');
 }
 const buzzer={...board,name:'提示音模块',model:'DFRobot Gravity DFR0032',spec:'三针有源蜂鸣模块',modelId:''};
 const exact=normalizeDesign(raw(buzzer),'').parts[0];
 assert.equal(exact.modelId,'buzzer');assert.deepEqual(exact.sizeMm,[22,30,10.5]);assert.match(exact.dimensionSourceUrl,/dfrobot/);
 for(const substitute of [{name:'有源蜂鸣器模块',model:'待选型',modelId:'buzzer'},{name:'门磁开关',model:'Adafruit 375',modelId:'reed'}]){
  assert.equal(normalizeDesign(raw({...buzzer,...substitute}),'').parts[0].modelId,'');
 }
});

test('duplicate geometry is rejected only for identical placement of the same BOM row',()=>{
 const p={...row,placement:'mounted',qty:2};
 const shape={op:'add',shape:'box',sizeMm:[20,12,4],centerMm:[0,0,0],rotationDeg:[0,0,0]};
 const a={name:'第一块板',partIndex:0,role:'reference',positionMm:[3,0,0],features:[shape]};
 const d={...raw(p),cadPlan:{version:1,bodies:[a,{...a,name:'重复板',positionMm:[0,0,0],features:[{...shape,centerMm:[3,0,0]}]}]}};
 assert.throws(()=>normalizeDesign(d,''),/相同安装位重复放置/);
 d.cadPlan.bodies[1].positionMm=[32,0,0];
 assert.equal(normalizeDesign(d,'').cadPlan.bodies.length,2);
});

test('the base XIAO SKU can explicitly exclude its Sense expansion board and keep a custom PCB model',()=>{
 const controller={...row,name:'控制板',model:'Seeed Studio XIAO ESP32S3',modelId:'',
  spec:'基础版 SKU 113991114，无排针、无 Sense 扩展板。尺寸为含 USB-C 的目录整板包络，不是 PCB 裸板尺寸。',
  sizeMm:[22.482,17.78,4.46],dimensionSource:'estimated',placement:'mounted'};
 const feature=(sizeMm,centerMm)=>({shape:'box',op:'add',sizeMm,centerMm,rotationDeg:[0,0,0]});
 const pcb={name:'主控板及 USB-C',partIndex:0,role:'reference',positionMm:[33.9955,0,5.9],
  features:[feature([20.955,17.78,1.25],[0,0,0]),feature([6,8,3.2],[8,0,1.8])]};
 const make=p=>normalizeDesign({...raw(p),cadPlan:{version:1,bodies:[pcb]}},'');
 for(const p of [controller,{...controller,model:'Seeed Studio 113991114',spec:'Board without the Sense expansion board'}]){
  const d=make(p);
  assert.equal(d.parts[0].modelId,'xiao-esp32s3');assert.equal(d.parts[0].dimensionSource,'catalog');
  assert.deepEqual(d.cadPlan.bodies,[pcb]);
 }
 for(const p of [{...controller,model:'Seeed Studio XIAO ESP32S3 Sense'},
  {...controller,spec:'113991115，无排针'}, {...controller,spec:'无排针，附 Sense 扩展板'},
  {...controller,spec:'基础版 SKU 113991114，无 Sense 扩展板，另装扩展板'}]){
  assert.equal(make(p).parts[0].modelId,'');
 }
});

test('a confirmed whole-board anchor adopts native XYZ without changing its mounting pose',()=>{
 const s3={...row,name:'主控板',model:'Seeed Studio XIAO ESP32S3',modelId:'',spec:'基础版 USB-C',
  sizeMm:[22,18,6],dimensionSource:'estimated',placement:'mounted',qty:2};
 const feature={op:'add',shape:'box',sizeMm:[22,18,6],rotationDeg:[0,90,90],centerMm:[3,4,5]};
 const anchor={role:'reference',partIndex:0,name:'主控板',positionMm:[40,-20,8],features:[feature]};
 const make=(part,bodies)=>({...raw(part),cadPlan:{version:1,bodies}});
 const original=make(s3,[anchor,{...anchor,positionMm:[70,-20,8]}]);
 const fixed=normalizeDesign(original,'');
 const native=[22.482,17.78,4.46];
 assert.deepEqual(fixed.parts[0].sizeMm,native);
 assert.deepEqual(fixed.cadPlan.bodies,original.cadPlan.bodies.map(b=>({...b,features:[{...feature,sizeMm:native}]})));
 assert.deepEqual(original.cadPlan.bodies[0].features[0].sizeMm,[22,18,6]);

 for(const candidate of [
  make(s3,[{...anchor,features:[{...feature,sizeMm:[22,18,7]}]}]),
  make(s3,[{...anchor,name:'主控板连接器插拔净空'}]),
  make(s3,[{...anchor,role:'printed'}]),
  make(s3,[anchor,{...anchor,name:'芯片分件',features:[{...feature,shape:'ellipsoid'}]}]),
  make({...s3,qty:1},original.cadPlan.bodies),
  make({...s3,placement:'loose'},[anchor]),
  make({...s3,sizeMm:[18,22,6]},[{...anchor,features:[{...feature,sizeMm:[18,22,6]}]}]),
  make({...s3,sizeMm:[20,20,6]},[{...anchor,features:[{...feature,sizeMm:[20,20,6]}]}]),
  make({...s3,model:'XIAO ESP32S3 Sense'},[anchor]),
  make({...s3,dimensionSource:'specified',dimensionQuote:'主控板 22×18×6 mm'},[anchor])
 ]){
  assert.deepEqual(normalizeDesign(candidate,'主控板 22×18×6 mm').cadPlan,candidate.cadPlan);
 }
});
