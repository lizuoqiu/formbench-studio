import test from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
test('production loopback design route refuses generation with only a legacy CLI opt-in', {timeout:12000}, async t=>{
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
 // Override any machine credentials/.env.local with explicit empty values; model traffic is never needed.
 const local=await readFile(new URL('../.env.local',import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
 const names=local.split('\n').map(line=>/^\s*(?:export\s+)?(OPENAI_API_KEY(?:_[1-9]\d*)?)\s*=/.exec(line)?.[1]).filter(Boolean);
 const emptyKeys=Object.fromEntries(names.map(name=>[name,'']));
 const child=spawn(process.execPath,[fileURLToPath(new URL('local.mjs',import.meta.url))],{env:{...emptyKeys,PORT:String(port),OPENAI_API_KEY:'',OPENAI_MODEL:'configured-model',FORM_BENCH_LOCAL_CODEX:'1',PATH:''},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('local server exited before listening')})]);
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
