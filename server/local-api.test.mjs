import test from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
test('production loopback design route refuses generation with only a legacy CLI opt-in', {timeout:12000}, async t=>{
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
 // Override any machine credentials/.env.local with explicit empty values; model traffic is never needed.
 const child=spawn(process.execPath,[fileURLToPath(new URL('local.mjs',import.meta.url))],{env:{PORT:String(port),OPENAI_API_KEY:'',OPENAI_MODEL:'configured-model',FORM_BENCH_LOCAL_CODEX:'1',PATH:''},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('local server exited before listening')})]);
 const c=await fetch(origin+'/api/capabilities');assert.equal(c.status,200);const caps=await c.json();assert.equal(caps.ai,false);assert.equal(caps.aiProvider,undefined);
 const r=await fetch(origin+'/api/design',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({prompt:'测试缺少密钥时的正式设计入口'})});assert.equal(r.status,503);assert.ok((await r.json()).error);
});
