import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {advanceDefects,machineFindings} from './design-defects.mjs';
import {capabilityPreflight} from './design-capabilities.mjs';
import {designJobs} from './design-jobs.mjs';

const candidate={parts:[{name:'电机',model:'M1'},{name:'盖板',model:'L1'}],cadPlan:{bodies:[{partIndex:0,name:'电机壳体',features:[]},{partIndex:1,name:'盖板',features:[]}]}};
const finding={check:'motor.output',subject:'joint-2',priorId:'',area:'mechanism',description:'从动端未随动',evidence:'输出与壳体引用同一运动组',acceptance:'壳体固定、输出端随动',
  route:'design',capability:'',disposition:'open',partIndices:[0],bodyIndices:[0],basis:'geometry'};
const run=(args={})=>advanceDefects({previous:[],reviewFindings:[],machine:[],attempt:1,candidate,evidenceAvailable:{geometry:true},covered:{geometry:true,definition:true},preflight:capabilityPreflight,...args});

test('a completed architecture recheck can close a historical sourcing conflict while CAD stays invalid',()=>{
 const sourcing='原来选定的模块在 BOM 中缺失。',cad='连接口仍引用了错误的实体。';
 const before=run({machine:machineFindings([sourcing,cad],'definition',candidate)});
 const history=[{review:{architecture:{issues:[sourcing]}}}];
 const recheck=(available,issues)=>run({previous:before.ledger,attempt:2,history,covered:{definition:false,architecture:available},
  machine:machineFindings(issues,'architecture',candidate)});
 assert.deepEqual(recheck(false,[]).delta.closed,[]);
 const stillPresent=recheck(true,[sourcing]);
 assert.equal(stillPresent.ledger.length,2);assert.deepEqual(stillPresent.delta.closed,[]);
 const fixed=recheck(true,[]);
 assert.deepEqual(fixed.delta.closed,[before.ledger[0].id]);
 assert.equal(fixed.ledger[1].status,'open');
});

test('paraphrased findings persist across rounds; missing or unavailable rechecks cannot close them',()=>{
 const a=run({reviewFindings:[finding]}),id=a.ledger[0].id;
 const revised={...finding,priorId:id,description:'输出盘仍与固定件同动'};
 const b=run({previous:a.ledger,attempt:2,reviewFindings:[revised]});
 assert.deepEqual(b.delta.persisted,[id]);assert.equal(b.delta.decision,'replan');
 const c=run({previous:b.ledger,attempt:3,reviewFindings:[{...revised,disposition:'resolved'}],evidenceAvailable:{geometry:false}});
 assert.deepEqual(c.delta.persisted,[id]);assert.equal(c.ledger[0].streak,3);
 const d=run({previous:c.ledger,attempt:4,history:[{repair:{strategy:'replan'}}]});
 assert.equal(d.delta.decision,'diagnose');assert.equal(d.ledger[0].firstSeen,1);
 const e=run({previous:d.ledger,attempt:5,reviewFindings:[{...revised,disposition:'resolved',evidence:'本轮逐轴测试显示输出盘转动、固定壳体不动。'}]});
 assert.deepEqual(e.delta.closed,[id]);assert.equal(e.ledger[0].closedAt,5);assert.match(e.ledger[0].closureEvidence,/逐轴/);
 assert.equal(e.delta.decision,'complete');
 const f=run({previous:e.ledger,attempt:6,reviewFindings:[finding]});
 assert.deepEqual(f.delta.reopened,[id]);assert.equal(f.ledger[0].streak,1);
 assert.throws(()=>run({previous:e.ledger,attempt:6,reviewFindings:[{...revised,subject:'other'}]}),/无效/);
 assert.deepEqual(a.ledger.map(x=>x.status),['open']);
});

test('checks group repeated overlap samples by their body pair, measure residuals, and keep failures when a check is blocked',()=>{
 const geometry=(volume,pose)=>pose+' 「电机壳体」(#0) 与「盖板」(#1) 的 CAD 实体重叠 '+volume+' mm³。';
 const earlier=machineFindings([geometry(8,'J2=-4'),geometry(9.5,'J2=7')],'geometry',candidate);
 const later=machineFindings([geometry(5,'J2=-2')],'geometry',candidate);
 assert.equal(earlier.length,1);assert.equal(earlier[0].residual,9.5);
 const a=run({machine:earlier}),b=run({previous:a.ledger,machine:later,attempt:2});
 assert.deepEqual(b.delta.improved,[a.ledger[0].id]);assert.equal(b.delta.decision,'continue');
 const c=run({previous:b.ledger,attempt:3,covered:{geometry:false}});
 assert.equal(c.delta.openCount,1);
 const d=run({previous:c.ledger,attempt:4});
 assert.equal(d.delta.closed.length,1);assert.equal(d.delta.decision,'complete');
});

test('requires a known runtime gap to route a necessary operation to the platform',()=>{
 const reported=capability=>run({reviewFindings:[{...finding,route:'platform',capability}]});
 assert.equal(reported('cad.freeformScript').delta.decision,'diagnose');
 assert.equal(reported('cad.bodyColor').ledger[0].route,'design');
 assert.equal(reported('unknown').ledger[0].route,'evidence');
});

test('restart from a persisted diagnostic checkpoint stops scheduling until an explicit retry',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'formbench-pause-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const id='11223344-0000-0000-0000-000000000000',env={FORMBENCH_JOB_DIR:dir};
 const root=join(dir,id);await mkdir(root);
 const fault=run({reviewFindings:[{...finding,capability:'cad.bitmapTexture'}]});
 const round={attempt:3,issues:fault.issues,issueDelta:fault.delta};
 await writeFile(join(root,'job.json'),JSON.stringify({id,input:{prompt:'fixed test'},status:'running',state:{nextAttempt:4,issueLedger:fault.ledger,rounds:[round]}}));
 let calls=0;const runJob=async()=>{calls++;return Response.json({design:{name:'saved',parts:[]}});};
 const get=()=>designJobs(new Request('http://local.test/api/design-jobs/'+id),env,{run:runJob});
 const a=await (await get()).json();
 assert.equal(a.status,'paused');assert.equal(a.actionRequired,'workflow-diagnosis');assert.equal(a.issueLedger[0].id,fault.ledger[0].id);assert.equal(a.rounds[0].issueDelta.decision,'diagnose');
 assert.equal(calls,0);
 const resumed=await designJobs(new Request('http://local.test/api/design-jobs/'+id+'/retry',{method:'POST',body:'{}'}),env,{run:runJob});
 assert.equal(resumed.status,202);for(let i=0;i<25;i++){if((await(await get()).json()).status==='complete')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(calls,1);assert.equal(JSON.parse(await readFile(join(root,'job.json'))).state.diagnosisAcknowledgedAt,3);
});

test('terminal identity survives measured text and body index changes; a regression has before-and-after evidence',()=>{
 const base={...candidate,interaction:{terminals:[{pin:'T2.A',partIndex:0,bodyIndex:0}]}};
 const msg='交互设计：电机 / T2.A 的接线点悬在实体外，距离 3.2 mm。',msg2=msg.replace('3.2','2.4');
 const a=machineFindings([msg],'definition',base,{checked:[{issue:msg,partIndex:0,pin:'T2.A',status:'regression'}]});
 assert.equal(a[0].check,'definition.terminal.floating');assert.ok(a[0].regressionEvidence);
 const initial=run({candidate:base,machine:a});
 const current={...base,interaction:{terminals:[{pin:'T2.A',partIndex:0,bodyIndex:1}]}};
 const b=run({previous:initial.ledger,attempt:2,candidate:current,machine:machineFindings([msg2],'definition',current)});
 assert.deepEqual(b.delta.persisted,[initial.ledger[0].id]);assert.deepEqual(b.ledger[0].bodyIndices,[1]);
 const c=run({previous:b.ledger,attempt:3,covered:{definition:()=>false}});
 assert.deepEqual(c.delta.persisted,b.delta.persisted);
});

test('a browser failure can only close when its own interaction was observed and passed',async()=>{
 const {browserEvidenceForFinding}=await import('./design-defects.mjs');
 const report={status:'observed',joints:{home:{passed:true,pose:{status:'passed'}},changed:[0,1],unchanged:[]},held:{status:'not-exercised'}};
 const held={...finding,capability:'viewer.holdRelease',subject:'jog-2'};
 assert.equal(browserEvidenceForFinding({...held,capability:'viewer.jointHome'},report),true);
 assert.equal(browserEvidenceForFinding(held,report),false);
 report.held={status:'passed',control:'jog-1',motion:{status:'passed'},stop:{status:'passed'}};
 assert.equal(browserEvidenceForFinding(held,report),false);
 report.held.control='jog-2';
 assert.equal(browserEvidenceForFinding(held,report),true);
 const a=run({reviewFindings:[held]});
 const b=run({previous:a.ledger,attempt:2,reviewFindings:[{...held,disposition:'resolved',priorId:a.ledger[0].id,basis:'visual'}],evidenceAvailable:{visual:true}});
 assert.equal(b.delta.openCount,1);
});

test('a steady stream of replacement defects triggers a changed plan even if every open ID changes',()=>{
 const history=[];
 let previous=[];
 for(let attempt=1;attempt<=5;attempt++){
  const closed=previous.filter(row=>row.status==='open').map(row=>({...finding,priorId:row.id,subject:row.subject,disposition:'resolved'}));
  const a=run({attempt,previous,history,reviewFindings:[...closed,{...finding,subject:'link-'+attempt}]});
  if(attempt===3)assert.equal(a.delta.decision,'replan');
  if(attempt===5)assert.equal(a.delta.decision,'diagnose');
  previous=a.ledger;history.push({attempt,issueDelta:a.delta,repair:{strategy:attempt===4?'replan':'repair'}});
 }
});
