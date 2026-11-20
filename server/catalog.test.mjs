import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,verifiedSources} from './catalog.mjs';
test('only product sources from an actual search, without tracking fields',()=>{const urls=['https://item.taobao.com/item.htm?id=123&tracking=a','https://example.org/item.htm?id=123','https://detail.tmall.com/item.htm','https://item.taobao.com/item.htm?id=123'];assert.deepEqual(verifiedSources({output:[{type:'message',action:{sources:[{url:'https://detail.tmall.com/item.htm?id=456'}]}},{type:'web_search_call',action:{sources:urls.map(url=>({url}))}}]}).map(r=>r.url),['https://item.taobao.com/item.htm?id=123']);});
test('no key returns a manual search and no candidate',async()=>{const r=await catalog(new Request('http://localhost/api/catalog',{method:'POST',body:JSON.stringify({name:'Pico',spec:'RP2040'})}),{});assert.equal(r.status,503);assert.deepEqual((await r.json()).candidates,[]);});
