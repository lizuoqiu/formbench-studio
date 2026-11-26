import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForgeSession } from '../tools/check-forge-mcp.mjs';
import { buildReadCases } from './forge-mcp-read-cases.mjs';

const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const inventory = [
  { name: 'read_docs', inputSchema: schema() },
  { name: 'search_docs', inputSchema: schema({ query: string }, ['query']) },
  { name: 'list_projects', inputSchema: schema() },
  { name: 'list_versions', inputSchema: schema({ projectId: string }, ['projectId']) },
  { name: 'list_drafts', inputSchema: schema({ projectId: string }, ['projectId']) },
  { name: 'check_fit', inputSchema: schema() },
];

test('general read manifest works without a project and is accepted by the probe', async () => {
  const { cases, skipped } = buildReadCases(inventory);
  assert.deepEqual(cases.map(row => row.name), ['read_docs', 'search_docs', 'list_projects']);
  assert.deepEqual(skipped.map(row => row.name), ['list_versions', 'list_drafts']);
  const result = await checkForgeSession({ inventory: async () => ({ tools: inventory }), callTool: async () => ({ content: [] }) }, cases);
  assert.equal(result.tools.filter(row => row.calls[0]?.status === 'returned').length, 3);
});

test('project scopes are exact and schema changes disable incompatible reads', () => {
  const descriptors = inventory.map(tool => {
    if (tool.name === 'list_drafts') return { ...tool, annotations: { readOnlyHint: false } };
    if (tool.name === 'list_projects') return { ...tool, inputSchema: schema({ teamId: string }, ['teamId']) };
    if (tool.name === 'search_docs') return { ...tool, inputSchema: { type: 'object' } };
    return tool;
  });
  const { cases, skipped } = buildReadCases(descriptors, 'chosen-bench');
  assert.deepEqual(cases.map(row => row.name), ['read_docs', 'list_versions']);
  assert.deepEqual(cases[1].arguments, { projectId: 'chosen-bench' });
  assert.deepEqual(skipped.map(row => row.name), ['search_docs', 'list_projects', 'list_drafts']);
});
