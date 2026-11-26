import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {forgeMcpEndpoint, withForgeMcp} from './forge-mcp.mjs';

const anonymous = {FORMBENCH_FORGE_OAUTH_DIR: await mkdtemp(join(tmpdir(), 'forge-anonymous-'))};
after(() => rm(anonymous.FORMBENCH_FORGE_OAUTH_DIR, {recursive:true, force:true}));
const env = {...anonymous, FORGECAD_MCP_ACCESS_TOKEN:'forge-fixture', OPENAI_API_KEY:'must-not-leave-host'};
const tool = (name, props = {}) => ({name, inputSchema: {type:'object', properties:props, required:Object.keys(props)}});
const signal = () => new AbortController().signal;

function remote(callback) {
  const messages = [];
  const fetch = async (url, init) => {
    assert.equal(String(url), forgeMcpEndpoint);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    const message = init.body ? JSON.parse(init.body) : {method:init.method};
    messages.push({method:message.method, params:message.params, headers:Object.fromEntries(init.headers)});
    if (message.method === 'GET') return new Response(null, {status:405});
    if (message.method === 'DELETE') return new Response(null, {status:204});
    if (message.method === 'notifications/initialized') return new Response(null, {status:202});
    const data = await callback(message, messages) ?? (message.method === 'initialize' ? {
      protocolVersion:'2025-11-25',serverInfo:{name:'ForgeCAD test',version:'fixture'},capabilities:{tools:{},resources:{},prompts:{}},
    } : undefined);
    if (data instanceof Response) return data;
    if (data === undefined) throw Error('Unexpected request '+ message.method);
    return Response.json({jsonrpc:'2.0',id:message.id,result:data}, {headers:{'mcp-session-id':'session-fixture'}});
  };
  return {messages,fetch,wait:async()=>{}};
}

test('discovery negotiates a session, walks each catalog, validates inputs, sends only the dedicated token, and can call a newly advertised tool',async()=>{
  const endpoint=remote(({method,params,id})=>{
    switch(method){
      case 'tools/list': return params.cursor ? {tools:[tool('new_dynamic_tool',{id:{type:'integer'}})]} :
          {tools:[tool('first')],nextCursor:'tools-2'};
      case 'resources/list': return {resources:[]};
      case 'resources/templates/list': return {resourceTemplates:[{name:'part',uriTemplate:'forgecad://parts/{id}'}]};
      case 'resources/read': return {contents:[{uri:params.uri,text:'part'}]};
      case 'prompts/list': return {prompts:[{name:'shape'}]};
      case 'prompts/get': return {messages:[{role:'user',content:{type:'text',text:'box'}}]};
      case 'tools/call': {
        const response={jsonrpc:'2.0',id,result:{content:[{type:'text',text:'tool result'}]}};
        return new Response('event: message\ndata: '+JSON.stringify(response)+'\n\n',{headers:{'content-type':'text/event-stream'}});
      }
    }
  });
  await withForgeMcp(env,signal(),async session=>{
    const inventory=await session.inventory();
    assert.equal(inventory.server.name,'ForgeCAD test');
    assert.deepEqual(inventory.tools.map(t=>t.name),['first','new_dynamic_tool']);
    assert.equal(inventory.resourceTemplates[0].uriTemplate,'forgecad://parts/{id}');
    assert.equal((await session.readResource('forgecad://parts/3')).contents[0].text,'part');
    assert.equal((await session.getPrompt('shape')).messages[0].content.text,'box');
    await assert.rejects(session.callTool('made_up',{}),/没有公布/);
    await assert.rejects(session.callTool('new_dynamic_tool',{id:'3'}),/inputSchema/);
    assert.equal((await session.callTool('new_dynamic_tool',{id:3})).content[0].text,'tool result');
  },endpoint);
  assert.equal(endpoint.messages.filter(m=>m.method==='tools/call').length,1);
  assert.equal(endpoint.messages.filter(m=>m.method==='tools/list').length,2);
  assert.ok(endpoint.messages.every(m=>m.headers.authorization==='Bearer forge-fixture'));
  assert.ok(endpoint.messages.filter(m=>m.method!=='initialize').every(m=>m.headers['mcp-session-id']==='session-fixture'));
  assert.equal(endpoint.messages.at(-1).method,'DELETE');
});

test('discovery retries transient network and HTTP errors while anonymous access sends no unrelated credentials',async()=>{
  let attempts=0;
  const endpoint=remote(({method})=>{
    if(method==='tools/list') {
      attempts++;
      if(attempts===1) throw new TypeError('socket closed');
      if(attempts===2) return new Response(null,{status:503});
      return {tools:[tool('ping')]};
    }
    if(method==='tools/call')return {content:[]};
  });
  await withForgeMcp({...anonymous,OPENAI_API_KEY:'openai-secret',FORGECAD_TOKEN:'cli-secret'},signal(),s=>s.callTool('ping'),endpoint);
  assert.equal(attempts,3);
  assert.ok(endpoint.messages.every(m=>!m.headers.authorization));
});

test('does not repeat a possibly executed tools/call on timeout or service failure',async()=>{
  for(const fail of [()=>new Response(null,{status:503}),()=>{throw Error('response lost')}]) {
    const endpoint=remote(({method})=>{
      if(method==='tools/list')return {tools:[tool('create_part')]};
      if(method==='tools/call')return fail();
    });
    await assert.rejects(withForgeMcp(env,signal(),s=>s.callTool('create_part'),endpoint),/ForgeCAD MCP/);
    assert.equal(endpoint.messages.filter(m=>m.method==='tools/call').length,1);
  }
});

test('denied access and redirects stop immediately without credential forwarding',async()=>{
  for(const status of [401,403,307]) {
    const endpoint=remote(()=>new Response(null,{status,headers:{Location:'https://other.example/mcp'}}));
    await assert.rejects(withForgeMcp(env,signal(),s=>s.tools(),endpoint),new RegExp('HTTP '+status));
    assert.deepEqual(endpoint.messages.map(m=>m.method),['initialize']);
  }
});

test('a repeated pagination cursor fails instead of hiding tools or looping',async()=>{
  const endpoint=remote(({method})=>method==='tools/list'?{tools:[],nextCursor:'broken'}:undefined);
  await assert.rejects(withForgeMcp(env,signal(),s=>s.tools(),endpoint),/分页游标/);
});

test('inventory retains tool discovery if an advertised resources capability omits template listing', async () => {
  const endpoint = remote(({method, id}) => {
    if (method === 'tools/list') return {tools: [tool('get_model')]};
    if (method === 'resources/list') return {resources: []};
    if (method === 'prompts/list') return {prompts: []};
    if (method === 'resources/templates/list') {
      return Response.json({jsonrpc:'2.0', id, error: {code:-32601, message:'Method not found'}});
    }
  });
  const result = await withForgeMcp(anonymous, signal(), session => session.inventory(), endpoint);
  assert.deepEqual(result.unavailable, ['resourceTemplates']);
  assert.deepEqual(result.tools.map(entry => entry.name), ['get_model']);
});

test('a task-required tool uses its negotiated task handle for polling and the final result', async () => {
  const task = {taskId:'job-1', ttl:null, createdAt:'2026-01-01T00:00:00Z', lastUpdatedAt:'2026-01-01T00:00:00Z'};
  const endpoint = remote(({method, params}) => {
    if (method === 'initialize') return {protocolVersion:'2025-11-25', serverInfo:{name:'fixture', version:'1'},
      capabilities:{tools:{}, tasks:{requests:{tools:{call:{}}}}}};
    if (method === 'tools/list') return {tools:[{...tool('render'), execution:{taskSupport:'required'}}]};
    if (method === 'tools/call') {
      assert.deepEqual(params.task, {});
      return {task:{...task, status:'working'}};
    }
    if (method === 'tasks/get') return {...task, status:'completed'};
    if (method === 'tasks/result') {
      assert.equal(params.taskId, task.taskId);
      return {content:[{type:'text', text:'render result'}]};
    }
  });
  const result = await withForgeMcp(anonymous, signal(), session => session.callTool('render'), endpoint);
  assert.equal(result.content[0].text, 'render result');
  assert.equal(endpoint.messages.filter(entry => entry.method === 'tools/call').length, 1);
});
