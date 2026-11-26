import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import http from 'node:http';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization} from '@modelcontextprotocol/sdk/client/auth.js';

const origin = 'https://forgecad.io';
export const forgeMcpEndpoint = origin + '/mcp';
const callbackPath = '/oauth/callback';
const port = 43168;
const unauthorized = () => Object.assign(new Error('请从本机工作台的 ForgeCAD 连接页面重新授权。'), {status:401});
const credentialsDir = env => env.FORMBENCH_FORGE_OAUTH_DIR || join(homedir(), '.formbench', 'forge-mcp-oauth');

async function readCredentials(dir) {
  const file = join(dir, 'credentials.json');
  try {
    const entry = await stat(file);
    if (!entry.isFile() || (entry.mode & 0o077)) throw Error('ForgeCAD 凭据文件只允许当前用户读取。');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveCredentials(dir, value) {
  const temporary = join(dir, randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(value), {mode:0o600, flag:'wx'});
    await rename(temporary, join(dir, 'credentials.json'));
  } finally {
    await rm(temporary, {force:true});
  }
}

// Rotation is shared by the CLI, local API, and independent validation processes.
async function withCredentialsLock(dir, work) {
  await mkdir(dir, {mode:0o700, recursive:true});
  const lock = join(dir, 'update.lock');
  // All network operations under this lock have short deadlines. A stale marker
  // from a terminated process expires after three minutes.
  for (let attempts = 0; ; attempts++) {
    try {
      await mkdir(lock, {mode:0o700});
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entry = await stat(lock).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (entry && Date.now() - entry.mtimeMs > 180000) await rm(lock, {recursive:true, force:true});
      else if (attempts === 300) throw Error('其他进程正在更新 ForgeCAD 授权，请稍后重试。');
      else await delay(100);
    }
  }
  try { return await work(await readCredentials(dir)); }
  finally { await rm(lock, {recursive:true, force:true}); }
}

function oauthFetch(send, signal) {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== origin || url.username || url.password) throw Error('ForgeCAD OAuth 返回了其他认证域名。');
    const read = !init.method || init.method.toUpperCase() === 'GET';
    for (let attempt = 1; ; attempt++) {
      const signals = [signal, init.signal, AbortSignal.timeout(20000)].filter(Boolean);
      let response;
      try {
        response = await send(url, {...init, redirect:'manual', credentials:'omit', signal:AbortSignal.any(signals)});
      } catch {
        signal?.throwIfAborted();
        init.signal?.throwIfAborted();
        if (read && attempt < 3) { await delay(300 * attempt); continue; }
        throw Error('连接 ForgeCAD OAuth 超时或失败。');
      }
      if (response.ok) return response;
      // Do not forward upstream OAuth error_description, which can contain input.
      const status = response.status;
      await response.body?.cancel();
      if (read && [408,500,502,503,504].includes(status) && attempt < 3) {
        await delay(300 * attempt); continue;
      }
      return Response.json({error:'server_error'}, {status:status >= 400 ? status : 502});
    }
  };
}

async function discover(fetchFn) {
  const info = await discoverOAuthServerInfo(forgeMcpEndpoint, {fetchFn});
  const metadata = info.authorizationServerMetadata;
  if (info.resourceMetadata?.resource !== forgeMcpEndpoint || metadata?.issuer !== origin ||
    !metadata.code_challenge_methods_supported?.includes('S256') || !metadata.scopes_supported?.includes('mcp')) {
    throw Error('ForgeCAD 授权服务未公布此 MCP 资源的 S256 和 mcp scope。');
  }
  return metadata;
}
function tokenRecord(client, tokens) {
  return {client, tokens, expiresAt: Number.isFinite(tokens.expires_in) ? Date.now() + tokens.expires_in * 1000 : null};
}
function fresh(c) {
  return c.tokens?.access_token && (!c.expiresAt || c.expiresAt > Date.now() + 30000);
}

export async function storedForgeAccessToken(env, {rejected, send = fetch, signal} = {}) {
  const dir = credentialsDir(env);
  const existing = await readCredentials(dir);
  if (!existing.tokens) return undefined;
  if (fresh(existing) && existing.tokens.access_token !== rejected) return existing.tokens.access_token;
  return withCredentialsLock(dir, async current => {
    if (fresh(current) && current.tokens.access_token !== rejected) return current.tokens.access_token;
    if (!current.tokens?.refresh_token) throw unauthorized();
    const fetchFn = oauthFetch(send, signal);
    const metadata = await discover(fetchFn);
    let refreshed;
    try {
      refreshed = await refreshAuthorization(origin, {metadata, resource:forgeMcpEndpoint, clientInformation:current.client,
        refreshToken:current.tokens.refresh_token, fetchFn});
    } catch {
      throw Object.assign(new Error('ForgeCAD 登录续期未成功，请稍后重试或从本机工作台重新连接。'), {status:401});
    }
    await saveCredentials(dir, tokenRecord(current.client, refreshed));
    return refreshed.access_token;
  });
}

export async function forgetForgeLogin(env) {
  const dir = credentialsDir(env);
  await withCredentialsLock(dir, () => rm(join(dir, 'credentials.json'), {force:true}));
}

export async function loginToForge(env, {send = fetch, ready, signal = AbortSignal.timeout(10 * 60 * 1000), listenPort = port, returnTo} = {}) {
  const dir = credentialsDir(env);
  if (returnTo) {
    const destination = new URL(returnTo);
    if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1' || destination.pathname !== '/forge-connect.html' ||
        destination.username || destination.password) throw Error('ForgeCAD 授权只能返回本机工作台。');
  }
  let complete, fail, callback, used = false;
  const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  done.catch(() => {});
  const server = http.createServer(async (req, res) => {
    const reply = (status, text, location) => {
      res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',
        'Referrer-Policy':'no-referrer', ...(location ? {Location:location} : {})}).end(text);
    };
    if (!callback || req.method !== 'GET' || req.headers.host !== callback.base.host) return reply(404, '');
    const url = new URL(req.url, callback.base);
    if (url.pathname === '/start') return reply(302, '', String(callback.authorizationUrl));
    if (url.pathname !== callbackPath) return reply(404, '');
    const checkIssuer = callback.metadata.authorization_response_iss_parameter_supported || url.searchParams.has('iss');
    if (used || url.searchParams.get('state') !== callback.state ||
        (checkIssuer && url.searchParams.get('iss') !== origin)) return reply(400, '授权请求无效。');
    used = true;
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      reply(400, '没有完成 ForgeCAD 授权，可以关闭此页。');
      return fail(Error('用户未完成 ForgeCAD 授权。'));
    }
    try {
      const tokens = await exchangeAuthorization(origin, {metadata:callback.metadata, clientInformation:callback.client,
        authorizationCode:url.searchParams.get('code'), codeVerifier:callback.codeVerifier,
        redirectUri:callback.redirectUri, resource:forgeMcpEndpoint, fetchFn:callback.fetchFn});
      await withCredentialsLock(dir, () => saveCredentials(dir, tokenRecord(callback.client, tokens)));
      if (returnTo) reply(303, '', returnTo);
      else reply(200, 'ForgeCAD 已连接到本机 Formbench。可以关闭此页。');
      complete();
    } catch {
      reply(502, 'ForgeCAD 授权交换失败，请重新开始。');
      fail(Error('ForgeCAD 授权交换失败。'));
    }
  });
  const onAbort = () => fail(Error('ForgeCAD 授权已超时或取消。'));
  try {
    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, {once:true});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, '127.0.0.1', resolve);
    });
    const base = new URL('http://127.0.0.1:' + server.address().port);
    const redirectUri = new URL(callbackPath, base).href;
    const fetchFn = oauthFetch(send, signal);
    const metadata = await discover(fetchFn);
    const client = await withCredentialsLock(dir, async current => {
      if (current.client?.redirect_uris?.includes(redirectUri)) return current.client;
      const registered = await registerClient(origin, {metadata, scope:'mcp', fetchFn, clientMetadata:{
        client_name:'Formbench (local)', redirect_uris:[redirectUri], grant_types:['authorization_code','refresh_token'],
        response_types:['code'], token_endpoint_auth_method:'none',
      }});
      if (!current.tokens) await saveCredentials(dir, {client:registered});
      return registered;
    });
    const state = randomBytes(32).toString('base64url');
    const {authorizationUrl, codeVerifier} = await startAuthorization(origin, {metadata, clientInformation:client,
      state, scope:'mcp', resource:forgeMcpEndpoint, redirectUrl:redirectUri});
    if (authorizationUrl.origin !== origin) throw Error('ForgeCAD 返回了其他授权域名。');
    callback = {authorizationUrl, codeVerifier, state, redirectUri, base, client, metadata, fetchFn};
    await ready?.(new URL('/start', base).href);
    await done;
  } finally {
    signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeIdleConnections();
  }
}

// Opening the static connection page does no registration. Multiple explicit
// button clicks share one pending PKCE verifier and callback listener.
export function makeForgeLoginRoute(login = loginToForge) {
  let pending;
  return async (request, env) => {
    if (!pending) {
      const returnTo = new URL('/forge-connect.html?inventory=1', request.url).href;
      let ready, failed;
      pending = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
      Promise.resolve().then(() => login(env, {ready, returnTo})).catch(failed).finally(() => { pending = undefined; });
    }
    const headers = {'Cache-Control':'no-store'};
    try { return Response.json({url:await pending}, {headers}); }
    catch (error) {
      const message = error?.code === 'EADDRINUSE' ? '另一个本机授权窗口正在使用此端口，请完成该窗口的授权或稍后重试。' : '暂时无法打开 ForgeCAD 授权页面，请稍后重试。';
      return Response.json({error:message}, {status:503, headers});
    }
  };
}
export const forgeLoginRequest = makeForgeLoginRoute();
