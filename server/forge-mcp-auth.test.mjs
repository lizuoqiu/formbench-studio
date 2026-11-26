import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {forgeMcpEndpoint, forgetForgeLogin, loginToForge, makeForgeLoginRoute, storedForgeAccessToken} from './forge-mcp-auth.mjs';
import {withForgeMcp} from './forge-mcp.mjs';

const origin = new URL(forgeMcpEndpoint).origin;
function oauthFixture() {
  const calls = [];
  let challenge;
  const metadata = {issuer:origin, authorization_endpoint:origin+'/oauth/authorize', token_endpoint:origin+'/oauth/token',
    registration_endpoint:origin+'/oauth/register', code_challenge_methods_supported:['S256'], scopes_supported:['mcp'],
    authorization_response_iss_parameter_supported:true,
    response_types_supported:['code'], grant_types_supported:['refresh_token','authorization_code'], token_endpoint_auth_methods_supported:['none']};
  async function send(input, init) {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    calls.push(url.pathname);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return Response.json({resource:forgeMcpEndpoint,
      authorization_servers:[origin], scopes_supported:['mcp']});
    if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json(metadata);
    if (url.pathname === '/oauth/register') return Response.json({client_id:'test-client', ...JSON.parse(init.body)}, {status:201});
    if (url.pathname === '/oauth/token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('resource'), forgeMcpEndpoint);
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('code'),'test-code');
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge);
        return Response.json({access_token:'first', token_type:'Bearer', refresh_token:'refresh1', expires_in:3600});
      }
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'refresh1');
      return Response.json({access_token:'second', token_type:'Bearer', refresh_token:'refresh2', expires_in:3600});
    }
    if (url.pathname === '/mcp' && init.method === 'POST') {
      const message = JSON.parse(init.body);
      const bearer = new Headers(init.headers).get('authorization');
      if (message.method === 'initialize' && bearer === 'Bearer first') return new Response(null, {status:401});
      assert.equal(bearer,'Bearer second');
      if (message.method === 'notifications/initialized') return new Response(null,{status:202});
      const result = message.method === 'initialize' ? {protocolVersion:'2025-11-25', serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}} :
        {tools:[]};
      return Response.json({jsonrpc:'2.0', id:message.id, result});
    }
    if (url.pathname === '/mcp' && init.method === 'GET') return new Response(null,{status:405});
    throw Error('Unexpected fixture URL ' + url.pathname);
  }
  async function confirm(start, destination) {
    const response = await fetch(start, {redirect:'manual'});
    const target = new URL(response.headers.get('location'));
    assert.equal(target.origin, origin);
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(target.searchParams.get('scope'), 'mcp');
    challenge = target.searchParams.get('code_challenge');
    const callback = new URL(target.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', 'wrong');
    callback.searchParams.set('code', 'test-code');
    assert.equal((await fetch(callback)).status,400);
    callback.searchParams.set('state', target.searchParams.get('state'));
    assert.equal((await fetch(callback)).status,400);
    callback.searchParams.set('iss', 'https://wrong.example');
    assert.equal((await fetch(callback)).status,400);
    callback.searchParams.set('iss', origin);
    const completed = await fetch(callback,{redirect:'manual'});
    assert.equal(completed.status, destination ? 303 : 200);
    if (destination) assert.equal(completed.headers.get('location'),destination);
  }
  return {send,confirm,calls};
}

test('loopback PKCE OAuth validates state and issuer, stores private credentials, and refreshes revocation before discovery', async t => {
  const dir = await mkdtemp(join(tmpdir(),'forge-oauth-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const env = {FORMBENCH_FORGE_OAUTH_DIR:dir};
  const remote = oauthFixture();
  const destination = 'http://127.0.0.1:4173/forge-connect.html?inventory=1';
  await loginToForge(env, {send:remote.send, ready:url=>remote.confirm(url,destination),
    listenPort:0, returnTo:destination, signal:AbortSignal.timeout(5000)});
  assert.equal((await stat(join(dir,'credentials.json'))).mode & 0o777, 0o600);
  assert.equal(await storedForgeAccessToken(env),'first');
  assert.deepEqual(await withForgeMcp(env, undefined, session=>session.tools(), {fetch:remote.send}), []);
  assert.equal(await storedForgeAccessToken(env),'second');
  assert.equal(remote.calls.filter(path => path === '/oauth/token').length,2);
  await forgetForgeLogin(env);
  assert.equal(await storedForgeAccessToken(env), undefined);
});

test('workbench clicks share one handoff, and after expiry the same local URL can start a fresh handoff', async () => {
  let attempts = 0, expire;
  const route = makeForgeLoginRoute(async (_env, {ready, returnTo}) => {
    attempts++;
    assert.equal(returnTo, 'http://127.0.0.1:4173/forge-connect.html?inventory=1');
    ready('http://127.0.0.1:43168/start');
    await new Promise((_resolve, reject) => { expire = () => reject(Error('expired')); });
  });
  const request = new Request('http://127.0.0.1:4173/api/forge/mcp/login', {method:'POST'});
  const starts = await Promise.all([route(request, {}), route(request, {})]);
  for (const start of starts) assert.equal((await start.json()).url,'http://127.0.0.1:43168/start');
  assert.equal(attempts,1);
  expire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await route(request, {})).status,200);
  assert.equal(attempts,2);
  expire();
});
