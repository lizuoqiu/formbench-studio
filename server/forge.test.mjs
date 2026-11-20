import {test} from 'node:test';import assert from 'node:assert/strict';import {forge} from './forge.mjs';
const req=p=>new Request('http://127.0.0.1/api/forge',{method:'POST',body:JSON.stringify(p)});
test('local CAD accepts trusted part/size inputs only',async()=>{for(const patch of [{source:'return box()'},{w:101},{d:'32'},{part:'../other'}])assert.equal((await forge(req({part:'base',w:64,d:32,h:17,...patch}),{})).status,400)});
