// Generate a --cases manifest from a real live inventory. No tools are executed.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { withForgeMcp } from './forge-mcp.mjs';

export function buildReadCases(tools, projectId) {
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) throw Error('Supply an existing bench project ID or omit it.');
  const validator = new AjvJsonSchemaValidator();
  const candidates = [
    ['read_docs', {}], ['search_docs', { query: 'connectors' }], ['list_projects', {}],
  ];
  const projectReads = ['list_versions', 'list_drafts'];
  const cases = [], skipped = [];
  for (const name of projectReads) {
    if (projectId) candidates.push([name, { projectId }]);
    else skipped.push({ name, reason: 'Project scope omitted' });
  }
  for (const [name, args] of candidates) {
    const tool = tools.find(item => item.name === name);
    if (!tool?.inputSchema || tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false) {
      skipped.push({ name, reason: 'Missing descriptor or non-read-only annotation' });
      continue;
    }
    // Never allow JSON Schema's default additionalProperties behavior to accept
    // a bench identifier or search query that the server does not recognize.
    if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties || {}, key))) {
      skipped.push({ name, reason: 'Argument name absent from published properties' });
      continue;
    }
    try {
      const validate = validator.getValidator(tool.inputSchema);
      if (!validate(args).valid) throw Error();
    } catch {
      skipped.push({ name, reason: 'Published schema requires other arguments or cannot be validated' });
      continue;
    }
    cases.push({ id: name, name, arguments: args });
  }
  return { cases, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw Error('Usage: node server/forge-mcp-read-cases.mjs [existing-bench-project-id]');
    const { cases, skipped } = await withForgeMcp(process.env, undefined, async session => buildReadCases(await session.tools(), process.argv[2]));
    for (const entry of skipped) console.error(entry.name + ': ' + entry.reason);
    if (!cases.length) throw Error('The current inventory exposes no eligible read cases.');
    console.log(JSON.stringify(cases, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
