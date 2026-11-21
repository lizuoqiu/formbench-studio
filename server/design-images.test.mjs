import {test} from 'node:test';
import assert from 'node:assert/strict';
import {design} from './design.mjs';
import {modelInput,readDesignRequest} from './design-conversation.mjs';
import {capabilities} from './runtime.mjs';
const request=body=>new Request('https://formwork.test/api/design',{method:'POST',body:JSON.stringify(body)});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLsAAAAASUVORK5CYII=';
const env={OPENAI_MODEL:'test',OPENAI_API_KEY:'fixture'};
test('both design actions send attached photos as actual Responses image inputs, only from the user',async()=>{
 const photo={dataUrl:png},prompt='给这个旋钮做一个桌面支架，用照片参考外形。';
 const frozen={name:'旋钮支架',summary:'旋钮立在桌面。',steps:['检查旋钮位置'],parts:[{name:'底座',spec:'定制',purpose:'支撑旋钮',role:'enclosure',model:'自制',qty:1,sizeMm:[20,20,20]}],cadPlan:{version:1,bodies:[]}};
 for(const action of ['discuss','generate']){
  const ctx={action,prompt,images:[photo],conversation:[{role:'user',text:'接口留在侧面'}]};
  const out=await design(request(ctx),env,async(_url,options)=>{
   const input=JSON.parse(options.body);
   assert.equal(input.store,false);
   assert.match(input.instructions,/标尺照片/);
   const [{role,content}]=input.input;
   assert.equal(role,'user');assert.equal(content[0].type,'input_text');
   assert.match(content[0].text,/接口留在侧面/);assert.ok(!content[0].text.includes('base64'));
   assert.deepEqual(content[1],{type:'input_image',image_url:png,detail:'high'});
   const result=action==='generate'?frozen:{decision:'ready',question:'',options:[]};
   return Response.json({status:'completed',model:'test',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
  });
  assert.equal(out.status,200);assert.ok(!(await out.text()).includes('base64'));
 }
 assert.equal(modelInput(await readDesignRequest(request({prompt}))),prompt);
 assert.equal((await (capabilities(env)).json()).designImages,true);
});

test('invalid formats, remote URLs and excess photo payloads stop before model invocation',async()=>{
 const tooLarge='data:image/png;base64,'+Buffer.alloc(256*1024+1,0).toString('base64');
 for(const input of [[...Array(4)].map(()=>({dataUrl:png})),[{dataUrl:'https://photo.test/device.jpg'}],
  [{dataUrl:png.replace('image/png','image/jpeg')}],[{dataUrl:tooLarge}],{},[{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}]]){
  let calls=0;const out=await design(request({prompt:'参考照片',images:input}),env,async()=>{calls++;throw Error('unexpected');});
  assert.equal(out.status,400);assert.equal(calls,0);
 }
 const unsupported=await design(request({action:'discuss',prompt:'参考照片',images:[{dataUrl:png}]}),env,
  async()=>Response.json({error:{message:'image input is unsupported for this model'}},{status:400}));
 assert.equal(unsupported.status,502);assert.match((await unsupported.json()).error,/移除照片/);
});
