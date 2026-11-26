import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {requestOpenAI,responseSourceUrls,withLocalCodex} from './openai-response.mjs';

const schema={type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false};
const options=(input='research fixture',extra={})=>({body:JSON.stringify({input,
  text:{format:{type:'json_schema',schema,strict:true}},...extra})});
const fixture=async(t,implementation)=>{
  const directory=await mkdtemp(join(tmpdir(),'formbench-codex-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const binary=join(directory,'fake-codex');
  await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
const arg=name=>args[args.indexOf(name)+1];
const emit=event=>console.log(JSON.stringify(event));
const prompt=fs.readFileSync(0,'utf8');
emit({type:'thread.started',thread_id:'fixture-thread'});
${implementation}\n`,{mode:0o700});
  return withLocalCodex({OPENAI_API_KEY:'api-fixture'},{binary,effort:'ultra'});
};
const unexpectedApi=()=>assert.fail('The relay called the API');
const finish=`fs.writeFileSync(arg('--output-last-message'),JSON.stringify({url:'https://claimed.example/fake'}));
emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:7}});`;

test('local relay uses real native search URLs and keeps credentials, images and execution isolated',async t=>{
  const env=await fixture(t,`
const assert=require('node:assert/strict');
assert.equal(arg('--model'),'gpt-6.2-sol');
assert.equal(arg('--sandbox'),'read-only');
assert(args.includes('model_reasoning_effort="ultra"'));
assert(args.includes('web_search="live"'));
assert.equal(process.env.OPENAI_API_KEY,undefined);
assert.equal(process.env.OPENAI_API_KEY_2,undefined);
assert.equal(process.env.CODEX_API_KEY,undefined);
assert.equal(fs.readFileSync(arg('--image'),'utf8'),'image fixture');
assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(require('node:path').dirname(arg('--image'))));
assert.match(prompt,/picture notes/);
assert.match(prompt,/Attached image 1/);
assert.doesNotMatch(prompt,/base64/);
assert.equal(JSON.parse(fs.readFileSync(arg('--output-schema'))).additionalProperties,false);
emit({type:'item.started',item:{type:'web_search',action:{type:'open_page',url:'https://started.example/'}}});
emit({type:'item.completed',item:{type:'web_search',action:{type:'search',query:'https://query.example/'},results:[{url:'https://search.example/model#fragment'}]}});
emit({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://opened.example/spec'}}});
${finish}`);
  const image={type:'input_image',image_url:'data:image/png;base64,'+Buffer.from('image fixture').toString('base64')};
  const input=[{role:'user',content:[{type:'input_text',text:'picture notes'},image]}];
  const {result}=await requestOpenAI(unexpectedApi,env,options(input,{tools:[{type:'web_search'}]}));
  assert.deepEqual([...responseSourceUrls(result)],['https://search.example/model','https://opened.example/spec']);
  assert.equal(result.provider,'local-codex');
  assert.equal(result.model,'gpt-6.2-sol');
  assert.deepEqual(result.reasoning,{effort:'ultra'});
  assert.equal(result.id,'fixture-thread');
  assert.deepEqual(result.usage,{input_tokens:3,output_tokens:7});
});

test('relay refuses a completed response without required search events or after a model reroute',async t=>{
  const noSearch=await fixture(t,finish);
  await assert.rejects(requestOpenAI(unexpectedApi,noSearch,options('search',{tools:[{type:'web_search'}]})),
    {actionRequired:'local-codex-unavailable',message:/原生搜索事件/});
  const rerouted=await fixture(t,`emit({type:'item.completed',item:{type:'error',message:'model rerouted: gpt-6.2-sol -> other'}});\n${finish}`);
  await assert.rejects(requestOpenAI(unexpectedApi,rerouted,options()),{actionRequired:'local-codex-unavailable',message:/模型已切换/});
});

test('relay reports the native turn text limit before launching Codex',async t=>{
  const env=await fixture(t,'process.exit(31);');
  await assert.rejects(requestOpenAI(unexpectedApi,env,options('a'.repeat(1<<20))),
    {actionRequired:'local-codex-unavailable',message:/字符上限/});
});

test('relay timeouts stop the child with a recoverable job error and cancellation is preserved',async t=>{
  const env=await fixture(t,'setInterval(()=>{},1000);');
  await assert.rejects(requestOpenAI(unexpectedApi,env,{...options(),signal:AbortSignal.timeout(100)}),
    {actionRequired:'local-codex-unavailable',message:/请求超时/});
  const controller=new AbortController();
  const request=requestOpenAI(unexpectedApi,env,{...options(),signal:controller.signal});
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
});
