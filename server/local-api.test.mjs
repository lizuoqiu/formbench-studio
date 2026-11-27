import test from 'node:test';import assert from 'node:assert/strict';
import {once} from 'node:events';import {createServer} from 'node:net';
import {readFile,mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {isolatedLocalServer} from './test-fixtures/local-server.mjs';
async function freePort(){
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));return port;
}
test('production loopback design route refuses generation with only a legacy CLI opt-in', {timeout:12000}, async t=>{
 const {origin,close}=await isolatedLocalServer(await freePort(),{OPENAI_MODEL:'configured-model',FORM_BENCH_LOCAL_CODEX:'1',PATH:''});t.after(close);
 const bridge=origin+'/api/forge/mcp';
 const fromVisitor=await fetch(bridge,{method:'POST',headers:{Origin:'https://elsewhere.example','Content-Type':'application/json'},body:'{}'});
 assert.equal(fromVisitor.status,403);
 const login=bridge+'/login';
 assert.equal((await fetch(login)).status,405);
 assert.equal((await fetch(login,{method:'POST',headers:{Origin:'https://elsewhere.example','Content-Type':'application/json'},body:'{}'})).status,403);
 const badMethod=await fetch(bridge,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({operation:'not-a-protocol-operation'})});
 assert.equal(badMethod.status,400);assert.match((await badMethod.json()).error,/MCP/);
 const c=await fetch(origin+'/api/capabilities');assert.equal(c.status,200);const caps=await c.json();assert.equal(caps.ai,false);assert.equal(caps.aiProvider,undefined);
 const r=await fetch(origin+'/api/design',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({prompt:'测试缺少密钥时的正式设计入口'})});assert.equal(r.status,503);assert.ok((await r.json()).error);
});

test('starting a loopback verifier cannot see or resume a job owned by another server',async t=>{
 const first=await isolatedLocalServer(await freePort());t.after(first.close);
 await fetch(first.origin+'/api/capabilities');
 const id=randomUUID(),folder=join(first.jobDirectory,id),file=join(folder,'job.json');
 const original=JSON.stringify({id,status:'running',provider:'local-codex',input:{prompt:'fixture'},state:{},progress:{stage:'planning'}});
 await mkdir(folder,{recursive:true});await writeFile(file,original);
 const second=await isolatedLocalServer(await freePort());t.after(second.close);
 assert.notEqual(first.jobDirectory,second.jobDirectory);
 assert.equal((await fetch(second.origin+'/api/design-jobs/'+id)).status,404);
 assert.equal(await readFile(file,'utf8'),original);
});
