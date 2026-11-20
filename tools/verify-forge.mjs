// Integration test using the real local HTTP adapter and official ForgeCAD CLI.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const origin='http://127.0.0.1:4876',p=spawn(process.execPath,['server/local.mjs'],{env:{...process.env,PORT:'4876'},stdio:['ignore','pipe','inherit']});
try{await once(p.stdout,'data');for(const part of ['lid','base']){const r=await fetch(origin+'/api/forge',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({part,w:76,d:38,h:21})});assert.equal(r.status,200,`${part} HTTP ${r.status}`);const b=Buffer.from(await r.arrayBuffer());const n=b.readUInt32LE(80);assert.ok(n>0&&b.length===84+50*n);const lo=[Infinity,Infinity,Infinity],hi=lo.map(()=>-Infinity);for(let i=0;i<n;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++){const v=b.readFloatLE(84+50*i+12+12*j+4*k);lo[k]=Math.min(lo[k],v);hi[k]=Math.max(hi[k],v);}const bounds=hi.map((v,k)=>Math.round(100*(v-lo[k]))/100);assert.deepEqual(bounds,[76,38,part==='lid'?3.5:21]);console.log(part,n,bounds);}}finally{p.kill()}
