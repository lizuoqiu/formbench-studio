import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withForgeMcp} from '../server/forge-mcp.mjs';

// Test cases explicitly identify the project and arguments for every remote call.
// The report retains neither argument values nor returned CAD, documents or images.
export async function checkForgeSession(session, cases = []) {
  const inventory = await session.inventory();
  const tools = new Map(inventory.tools.map(tool => [tool.name, {
    name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema,
    annotations: tool.annotations, execution: tool.execution, calls: [],
  }]));
  if (!Array.isArray(cases)) throw Error('Expected an array of test cases.');
  const ids = new Set();
  for (const {id, name, arguments: args, dependsOn = []} of cases) {
    if (typeof id !== 'string' || !id || ids.has(id)) throw Error('Expected a unique case id.');
    if (!tools.has(name)) throw Error('Tool absent from the current inventory: ' + name);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Expected an arguments object for ' + name);
    if (!Array.isArray(dependsOn) || dependsOn.some(prior => !ids.has(prior))) throw Error('Dependencies must reference earlier cases.');
    ids.add(id);
  }
  const succeeded = new Set();
  for (const {id, name, arguments: args, dependsOn = []} of cases) {
    const calls = tools.get(name).calls;
    if (dependsOn.some(prior => !succeeded.has(prior))) {
      calls.push({id, status:'dependency-failed'});
      continue;
    }
    try {
      const reply = await session.callTool(name, args);
      const status = reply.isError ? 'tool-error' : 'returned';
      calls.push({id, status, contentTypes:(reply.content || []).map(item => item.type)});
      if (!reply.isError) succeeded.add(id);
    } catch (error) {
      calls.push({id, status:'request-failed', code:error?.code || error?.status || null});
    }
  }
  return {
    server: inventory.server, capabilities: inventory.capabilities,
    unavailable: inventory.unavailable || [],
    resources: (inventory.resources || []).length, resourceTemplates: (inventory.resourceTemplates || []).length,
    prompts: (inventory.prompts || []).length, tools: [...tools.values()],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--cases')) {
      throw Error('Usage: node tools/check-forge-mcp.mjs [--cases <json-file>]');
    }
    const cases = args.length ? JSON.parse(await readFile(args[1], 'utf8')) : [];
    const report = await withForgeMcp(process.env, undefined, session => checkForgeSession(session, cases));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.tools.some(row => row.calls.some(call => call.status !== 'returned'))) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
