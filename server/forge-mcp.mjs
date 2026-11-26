import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {forgeMcpEndpoint, storedForgeAccessToken} from './forge-mcp-auth.mjs';

export {forgeMcpEndpoint};
const safeToRepeat = new Set(['initialize', 'tools/list', 'prompts/list', 'resources/list',
  'resources/templates/list', 'resources/read', 'prompts/get', 'completion/complete', 'tasks/get', 'tasks/result']);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

function failure(message, status = 502) {
  return Object.assign(new Error(message), {status});
}

function delayForRetry(response, attempt) {
  const hint = response?.headers.get('retry-after');
  if (hint) {
    const seconds = /^\d+(?:\.\d+)?$/.test(hint) ? Number(hint) : (Date.parse(hint) - Date.now()) / 1000;
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  return 300 * 2 ** attempt;
}

function officialFetch(send, token, signal, pause, renew) {
  return async (url, init = {}) => {
    if (new URL(url).href !== forgeMcpEndpoint) throw failure('ForgeCAD MCP 请求目标与官方端点不一致。');
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', 'Bearer ' + token);
    const operation = init.body ? JSON.parse(init.body).method : undefined;
    const signals = [signal, init.signal].filter(Boolean);
    // The SDK closes its notification stream in client.close(). Explicit termination
    // must not keep a finished request alive if the remote loses the session.
    if (init.method === 'DELETE') signals.push(AbortSignal.timeout(5000));
    const requestSignal = AbortSignal.any(signals);
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      requestSignal.throwIfAborted();
      let response;
      try {
        response = await send(url, {...init, headers, signal: requestSignal, redirect: 'manual', credentials: 'omit'});
      } catch (error) {
        requestSignal.throwIfAborted();
        if (!safeToRepeat.has(operation) || attempt >= 2) throw failure('连接 ForgeCAD MCP 失败。');
      }
      if (response?.status === 401 && token && renew && !renewed && safeToRepeat.has(operation)) {
        await response.body?.cancel();
        token = await renew(token);
        if (!token) throw failure('ForgeCAD 本机授权已清除。', 401);
        headers.set('authorization', 'Bearer ' + token);
        renewed = true;
        continue;
      }
      const delay = delayForRetry(response, attempt);
      if ((!response || transientStatuses.has(response.status)) && safeToRepeat.has(operation) && attempt < 2 && delay <= 30000) {
        await response?.body?.cancel();
        await pause(delay, undefined, {signal: requestSignal});
        continue;
      }
      if (!response.ok && !(response.status === 405 && ['GET','DELETE'].includes(init.method))) {
        const status = response.status;
        await response.body?.cancel();
        if (status === 401) throw failure('ForgeCAD MCP 需要授权（HTTP 401）。请从本机工作台连接 ForgeCAD。', status);
        if (status === 403) throw failure('ForgeCAD MCP 拒绝访问（HTTP 403），请检查服务访问权限。', status);
        throw failure('ForgeCAD MCP 返回 HTTP ' + status + '。', status >= 400 ? status : 502);
      }
      return response;
    }
  };
}

async function collectPages(fetchPage, field) {
  const cursors = new Set();
  const items = [];
  let cursor;
  do {
    const page = await fetchPage(cursor === undefined ? {} : {cursor});
    items.push(...page[field]);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) throw failure('ForgeCAD MCP 返回重复的分页游标。');
    cursors.add(cursor);
  } while (cursor !== undefined);
  return items;
}

function makeSession(client, signal) {
  const capabilities = client.getServerCapabilities() || {};
  const options = {signal, timeout: 300000};
  let catalog;
  const tools = () => catalog ??= capabilities.tools
    ? collectPages(params => client.listTools(params, options), 'tools')
    : Promise.resolve([]);
  const validator = new AjvJsonSchemaValidator();
  return {
    tools,
    async inventory() {
      const unavailable = [];
      async function optionalCatalog(key, getter, field) {
        if (!capabilities[key]) return [];
        try { return await collectPages(getter, field); }
        catch (error) {
          // Some MCP servers advertise resources but implement only direct reads.
          // Only method-not-found is accepted here. Other errors must remain visible.
          if (error.code !== -32601) throw error;
          unavailable.push(field);
          return [];
        }
      }
      const [descriptors, resources, resourceTemplates, prompts] = await Promise.all([
        tools(),
        optionalCatalog('resources', params => client.listResources(params, options), 'resources'),
        optionalCatalog('resources', params => client.listResourceTemplates(params, options), 'resourceTemplates'),
        optionalCatalog('prompts', params => client.listPrompts(params, options), 'prompts'),
      ]);
      return {server: client.getServerVersion(), capabilities, tools: descriptors, resources, resourceTemplates, prompts, unavailable};
    },
    async callTool(name, args = {}) {
      const descriptor = (await tools()).find(tool => tool.name === name);
      if (!descriptor) throw failure('该 ForgeCAD MCP 会话没有公布这个工具。', 400);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('工具参数须为 JSON 对象。', 400);
      let check;
      try { check = validator.getValidator(descriptor.inputSchema); }
      catch { /* The server validates dialects and references the local validator cannot resolve. */ }
      const result = check?.(args);
      if (result && !result.valid) throw failure('ForgeCAD MCP 工具参数不符合其 inputSchema。' + result.errorMessage, 400);
      const params = {name, arguments: args};
      if (descriptor.execution?.taskSupport === 'required') {
        for await (const message of client.experimental.tasks.callToolStream(params, undefined, {...options, task: {}})) {
          if (message.type === 'error') throw message.error;
          if (message.type === 'result') return message.result;
        }
        throw failure('ForgeCAD MCP 任务流结束时没有工具结果。');
      }
      return client.callTool(params, undefined, options);
    },
    readResource(uri) { return client.readResource({uri}, options); },
    getPrompt(name, args = {}) { return client.getPrompt({name, arguments: args}, options); },
    complete(params) { return client.complete(params, options); },
  };
}

// A callback retains one negotiated session across discovery, model calls and results.
// Credentials stay on this server, separate from the OpenAI and local CAD CLI credentials.
export async function withForgeMcp(env, signal, callback, {fetch: send = fetch, wait = sleep} = {}) {
  const requestSignal = signal ?? new AbortController().signal;
  const configuredToken = env.FORGECAD_MCP_ACCESS_TOKEN?.trim();
  const localToken = rejected => storedForgeAccessToken(env, {rejected, send, signal:requestSignal});
  const token = configuredToken || await localToken();
  const transport = new StreamableHTTPClientTransport(new URL(forgeMcpEndpoint), {
    fetch: officialFetch(send, token, requestSignal, wait, configuredToken ? undefined : localToken),
    reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1},
  });
  const client = new Client({name: 'formbench', version: '1.0.0'});
  try {
    await client.connect(transport, {signal: requestSignal, timeout: 90000});
    return await callback(makeSession(client, requestSignal));
  } finally {
    if (transport.sessionId && !requestSignal.aborted) await transport.terminateSession().catch(() => {});
    await client.close();
  }
}

const hostedOperations = {
  inventory: session => session.inventory(),
  'tools/list': session => session.tools(),
  'tools/call': (session, body) => session.callTool(body.name, body.arguments),
  'resources/read': (session, body) => session.readResource(body.uri),
  'prompts/get': (session, body) => session.getPrompt(body.name, body.arguments),
  'completion/complete': (session, body) => session.complete(body.params),
};

// Exposed only by local.mjs behind its loopback Host, same-origin and JSON checks.
export async function forgeMcpRequest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Object.hasOwn(hostedOperations, body.operation)) return Response.json({error: '未知的 ForgeCAD MCP 操作。'}, {status: 400});
  try {
    const result = await withForgeMcp(env, request.signal, session => hostedOperations[body.operation](session, body));
    return Response.json(result, {headers: {'Cache-Control':'no-store'}});
  } catch (error) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    const message = String(error.message || 'ForgeCAD MCP 请求失败。');
    const token = env.FORGECAD_MCP_ACCESS_TOKEN?.trim();
    return Response.json({error: (token ? message.replaceAll(token, '[redacted]') : message).slice(0, 1000)}, {status, headers: {'Cache-Control':'no-store'}});
  }
}
