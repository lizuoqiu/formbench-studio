import test from 'node:test';
import assert from 'node:assert/strict';
import {checkForgeSession} from './check-forge-mcp.mjs';

test('live-inventory checker distinguishes untested tools, failed dependencies and independent calls', async () => {
  const seen = [];
  const names = ['first', 'dependent', 'independent', 'untested'];
  const session = {
    inventory: async () => ({tools:names.map(name => ({name, inputSchema:{required:['project']}}))}),
    callTool: async (name, args) => {
      assert.deepEqual(args, {project:'design-data'});
      seen.push(name);
      return {isError:name === 'first', content:[{type:'text',text:'private returned CAD'}]};
    },
  };
  const cases = names.slice(0, 3).map(name => ({id:name, name, arguments:{project:'design-data'}}));
  cases[1].dependsOn = ['first'];
  const report = await checkForgeSession(session, cases);
  assert.deepEqual(seen, ['first','independent']);
  assert.deepEqual(report.tools.map(tool => tool.calls.map(c => c.status)), [['tool-error'], ['dependency-failed'], ['returned'], []]);
  assert.doesNotMatch(JSON.stringify(report),/private returned CAD|design-data/);
  seen.length = 0;
  await assert.rejects(checkForgeSession(session, [...cases,{id:'unknown',name:'not-in-inventory',arguments:{}}]), /absent/);
  assert.deepEqual(seen, []);
});
