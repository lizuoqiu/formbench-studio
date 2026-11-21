import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';import {makeWorker} from './worker.mjs';
test('only valid app tokens for this Access policy can dispatch same-origin requests',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const env={ACCESS_ISSUER:'https://test.cloudflareaccess.com',ACCESS_AUD:'research'};
 const sign=(aud,type='app',exp='1h')=>new SignJWT({type}).setProtectedHeader({alg:'RS256'}).setIssuer(env.ACCESS_ISSUER).setAudience(aud).setExpirationTime(exp).sign(privateKey);
 let calls=0;const worker=makeWorker({keys:()=>publicKey,generate:()=>{calls++;return new Response('test');}});
 const run=(token,origin='https://example.org',path='/api/design',config=env)=>worker.fetch(new Request('https://example.org'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{'Cf-Access-Jwt-Assertion':token}:{})}}),config).then(x=>x.status);
 assert.equal(await run(null),403);assert.equal(await run('forged'),403);assert.equal(await run(await sign('other')),403);assert.equal(await run(await sign('research','org')),403);assert.equal(await run(await sign('research','app',1)),403);
 const valid=await sign('research');assert.equal(await run(valid,'https://elsewhere.org'),403);assert.equal(await run(valid,undefined,'/api/cart'),400);assert.equal(await run(valid,undefined,undefined,{}),503);assert.equal(calls,0);assert.equal(await run(valid),200);assert.equal(calls,1);
 const read=(path,token)=>worker.fetch(new Request('https://example.org'+path,{headers:token?{'Cf-Access-Jwt-Assertion':token}:{}}),env);
 assert.equal((await read('/api/capabilities')).status,403);assert.deepEqual(await (await read('/api/capabilities',valid)).json(),{ai:false,catalog:false,cart:'manual'});
 assert.equal((await read('/api/auth/status')).status,403);assert.deepEqual((await (await read('/api/auth/status',valid)).json()).authenticated,false);
});
