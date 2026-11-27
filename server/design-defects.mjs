// The four review areas remain summaries. These records belong to one saved job
// and keep their IDs when the independent reviewer rephrases the finding.
const string={type:'string'};
const indices={type:'array',items:{type:'integer'}};
const fields={
  priorId:string, check:string, subject:string, area:{type:'string',enum:['intent','form','mechanism','control']},
  disposition:{type:'string',enum:['open','resolved']}, route:{type:'string',enum:['design','research','platform','evidence']},
  capability:string, description:string, evidence:string, acceptance:string, partIndices:indices,bodyIndices:indices,
  basis:{type:'string',enum:['design','source','geometry','visual','behavior','browser']},
};
export const findingArraySchema={type:'array',items:{type:'object',properties:fields,required:Object.keys(fields),additionalProperties:false}};
export const findingInstructions='findings 逐个列出影响用户需求的独立缺陷与复核结论。check 是稳定的 ASCII 检查名，subject 是稳定的部件或功能标识。对同一根因复用 priorFindings 的 id（填入 priorId）、check 和 subject。再次出现已关闭的缺陷也复用编号。新发现填空 priorId。每条说明具体问题、影响、受影响索引、可检验通过判据和本轮证据。页面证据要填写 viewer.jointHome、viewer.jointJog 或 viewer.holdRelease 对应的 capability，按住测试的 subject 为实际 control id。直线行程用 viewer.linearTravel 并以行程名为 subject。当某个 repair 结论依据已有的程序缺陷，填出 reportedFindings 的零基 reportedIssueIndices。新的独立问题逐条写入 findings；其余检查的 reportedIssueIndices 填空数组。resolved 须引用本轮与 basis 对应的已执行检查或候选字段，不能凭计划或沉默关闭。连续两轮相同根因将转入诊断与子系统重规划。只列必需项，可选美化或实物测试放在其他说明。';
const key=f=>JSON.stringify([f.source,f.check,f.subject]);
function present(text,max){return typeof text==='string'&&Boolean(text.trim())&&text.length<=max;}
function validIndices(values,length){return Array.isArray(values)&&values.every(i=>Number.isInteger(i)&&i>=0&&i<length);}
export function previousReviewFindings(records=[]){
  return records.filter(r=>r.source==='review').map(({id,check,subject,status,evidence,acceptance})=>({id,check,subject,status,evidence,acceptance}));
}
function validFinding(f,candidate){
  return f && typeof f.check==='string'&&/^[a-z][a-z0-9._-]{0,99}$/i.test(f.check)
    &&present(f.subject,300)&&typeof f.priorId==='string'
    &&['description','evidence','acceptance'].every(field=>present(f[field],1000))
    &&['basis','route','disposition','area'].every(field=>fields[field].enum.includes(f[field]))
    &&typeof f.capability==='string'&&f.capability.length<=100
    &&validIndices(f.partIndices,candidate?.parts?.length||0)&&validIndices(f.bodyIndices,candidate?.cadPlan?.bodies?.length||0);
}
const terminalRules=[
 ['body','的实体属于其他 BOM 行或不存在'],['url','的资料链接无效'],['unknown','无定位依据时坐标和特征应留空'],
 ['coordinates','须提供实体及该实体局部的三轴毫米坐标'],['feature','没有落在引用的 CAD 特征范围内'],
 ['floating','的接线点悬在实体外'],['source','声称资料定位但缺少出处'],['pinFeature','不能以整件定位盒或整块板体作为引脚几何'],
 ['buried','的端点埋在特征内部'],['duplicate','不是唯一已接线端点'],['part','的 BOM 行不存在'],
 ['sharedSite','与同一实体另一针脚共用了相同的精确坐标'],
];
export function verifiedLinearTravel(observation){
 const samples=observation?.samples;
 return observation?.status==='passed'&&samples?.length===3&&['intermediate','extended','retracted'].every((phase,i)=>{
  const s=samples[i];
  return s.phase===phase&&s.sliderPassed&&s.pose?.status==='passed';
 });
}
const browserActions=new Set(['viewer.jointHome','viewer.jointJog','viewer.holdRelease','viewer.linearTravel']);
export function browserEvidenceForFinding(finding,report){
 if(report?.status!=='observed')return false;
 switch(finding.capability){
  case 'viewer.jointHome': return report.joints?.home?.passed===true&&report.joints.home.pose?.status==='passed';
  case 'viewer.jointJog': return report.joints?.observations?.length>0&&report.joints.observations.every(o=>o.sliderPassed&&o.status==='passed');
  case 'viewer.linearTravel': {
    const matches=report.travel?.observations?.filter(o=>o.name===finding.subject)||[];
    return matches.length===1&&verifiedLinearTravel(matches[0]);
  }
  case 'viewer.holdRelease': return report.held?.status==='passed'&&report.held.motion?.status==='passed'&&report.held.stop?.status==='passed'&&finding.subject===report.held.control;
  default: return false;
 }
}
export function machineFindings(messages,group,candidate,terminalRevision){
  const result=new Map();
  for(const description of messages.flatMap(s=>s.split('\n')).filter(Boolean)){
    const finding={source:'check',check:group,subject:description,route:'design',description,evidence:description,
      acceptance:'本轮对应检查完整执行，且不再报告此错误。',partIndices:[],bodyIndices:[]};
    if(group==='geometry'){
      const pair=[...description.matchAll(/「[^」]+」\(#(\d+)\)/g)].map(m=>Number(m[1]));
      if(pair.length===2){
        const bodies=candidate?.cadPlan?.bodies||[];
        if(pair.every(i=>bodies[i])){
          finding.check='geometry.overlap';
          finding.bodyIndices=pair;finding.partIndices=[...new Set(pair.map(i=>bodies[i].partIndex))];
          finding.subject=JSON.stringify(pair.map(i=>[candidate.parts?.[bodies[i].partIndex]?.model,bodies[i].name,
            bodies.slice(0,i).filter(b=>b.name===bodies[i].name&&b.partIndex===bodies[i].partIndex).length]).sort());
          finding.residual=Number(description.match(/重叠 ([\d.]+) mm³/)?.[1]);
        }
      }
    }
    if(group==='definition'){
      const terminals=Array.isArray(candidate?.interaction?.terminals)?candidate.interaction.terminals:[];
      if(description.startsWith('交互设计：')){
        for(const t of terminals){
          const part=candidate.parts?.[t?.partIndex];
          if(!part||typeof t.pin!=='string')continue;
          const prefix='交互设计：'+part.name+' / '+t.pin+' ';
          if(!description.startsWith(prefix))continue;
          const detail=description.slice(prefix.length);
          const rule=terminalRules.find(([,prefix])=>detail.startsWith(prefix));
          if(!rule)continue;
          finding.check='definition.terminal.'+rule[0];
          finding.subject=JSON.stringify([part.model,part.name,t.pin]);
          finding.partIndices=[t.partIndex];
          if(Number.isInteger(t.bodyIndex))finding.bodyIndices=[t.bodyIndex];
          const change=terminalRevision?.checked?.find(c=>c.partIndex===t.partIndex&&c.pin===t.pin&&c.issue===description);
          if(change?.status==='regression')finding.regressionEvidence='同一端子的旧装配可定位，修订后的实体或端点映射未通过同一检查。';
          break;
        }
      }
      const motion=/^运动约定：(主动旋转轴数|主动直线轴数|单条旋转父子链层数)最低要求 (\d+)，当前 CAD 为 (\d+)。/.exec(description);
      if(motion){finding.check='definition.motion.minimum';finding.subject=motion[1];finding.residual=Number(motion[2])-Number(motion[3]);}
      const coverage=/^部件覆盖：「([^」]+)」需要安装 (\d+) 件，CAD 只有 (\d+) 个实体/.exec(description);
      if(coverage){finding.check='definition.instanceCount';finding.subject=coverage[1];finding.residual=Number(coverage[2])-Number(coverage[3]);}
    }
    if(group==='requirements'&&description.startsWith('已声明的运动几何检查未完成')){
      finding.check='requirements.geometry-run';finding.subject='motion';finding.route='evidence';
    }
    if(!Number.isFinite(finding.residual))delete finding.residual;
    const existing=result.get(key(finding));
    if(!existing||finding.residual>existing.residual)result.set(key(finding),finding);
  }
  return [...result.values()];
}
export function advanceDefects({previous=[],reviewFindings,machine,attempt,candidate,evidenceAvailable,covered,history=[],preflight}){
  if(!Array.isArray(reviewFindings)||reviewFindings.length>200)throw Error('缺少有效的逐项评审记录。');
  // Earlier checkpoints grouped architecture and CAD together. The saved
  // architecture report identifies those checks without matching prose patterns.
  const earlierArchitecture=new Set(history.flatMap(round=>round.review?.architecture?.issues||[]));
  const ledger=previous.map(r=>r.source==='check'&&r.check==='definition'&&earlierArchitecture.has(r.description)
    ?{...r,check:'architecture'}:{...r});
  const byId=new Map(ledger.map(r=>[r.id,r])),byKey=new Map(ledger.map(r=>[key(r),r]));
  const delta={opened:[],persisted:[],reopened:[],closed:[],improved:[]};
  const seen=new Set();
  function observe(finding,priorId=''){
    const prior=priorId?byId.get(priorId):byKey.get(key(finding));
    if(priorId&&(!prior||key(prior)!==key(finding)))throw Error('评审引用了无效的既有问题编号 '+priorId);
    if(prior){
      if(seen.has(prior.id))throw Error('同一问题存在重复评审结论 '+prior.id);
      seen.add(prior.id);
      if(finding.disposition==='resolved'){
        const allowed=evidenceAvailable[finding.basis];
        const verified=typeof allowed==='function'?allowed(finding):allowed;
        const specific=browserActions.has(prior.capability)?finding.capability===prior.capability&&finding.basis==='browser':
          prior.basis==='design'||prior.basis===finding.basis;
        if(prior.status==='open'&&verified&&specific){
          prior.status='closed';prior.closedAt=attempt;prior.closureEvidence=finding.evidence;prior.closureBasis=finding.basis;
          delta.closed.push(prior.id);
        }else if(prior.status==='open'){
          prior.streak++;delta.persisted.push(prior.id);
        }
        return;
      }
      const improved=Number.isFinite(finding.residual)&&Number.isFinite(prior.residual)&&finding.residual<prior.residual;
      const reopened=prior.status==='closed';
      delta[reopened?'reopened':'persisted'].push(prior.id);
      if(improved)delta.improved.push(prior.id);
      const {check,subject}=prior;
      Object.assign(prior,finding,{check,subject,status:'open',lastSeen:attempt,streak:improved||reopened?1:prior.streak+1});
      delete prior.closedAt;delete prior.closureEvidence;delete prior.closureBasis;
      return;
    }
    if(finding.disposition==='resolved')throw Error('关闭记录没有关联到历史问题。');
    const row={...finding,origin:finding.regressionEvidence?'verified-regression':'first-observed',id:'ISSUE-'+String(ledger.length+1).padStart(3,'0'),status:'open',firstSeen:attempt,lastSeen:attempt,streak:1};
    ledger.push(row);byKey.set(key(row),row);byId.set(row.id,row);seen.add(row.id);delta.opened.push(row.id);
  }
  for(const f of machine)observe(f);
  for(const f of reviewFindings){
    if(!validFinding(f,candidate))throw Error('具体问题记录缺少检验依据、判据或有效索引。');
    const gate=f.capability&&preflight?.(f.capability,candidate);
    let route=f.route;
    if(gate)route=gate.route==='review'?'evidence':gate.route;
    else if(route==='platform')route='evidence';
    observe({...f,source:'review',route,...(gate?{capabilityVerdict:gate}:{})},f.priorId);
  }
  for(const row of ledger){
    if(row.status!=='open'||seen.has(row.id))continue;
    const group=row.check.split('.')[0];
    const eligible=covered[group];
    const checked=typeof eligible==='function'?eligible(row):eligible;
    if(row.source==='check'&&checked){
      row.status='closed';row.closedAt=attempt;row.closureEvidence='第 '+attempt+' 轮完整运行 '+group+' 检查，此项通过。';row.closureBasis='check';
      delta.closed.push(row.id);
    }else{
      row.streak++;delta.persisted.push(row.id);
    }
  }
  const pending=ledger.filter(f=>f.status==='open');
  delta.decision=pending.length?'continue':'complete';
  delta.reason='';
  delta.openCount=pending.length;
  const window=[...history.slice(-2).map(r=>r.issueDelta),delta];
  const churn=pending.length&&window.length===3&&window.every(d=>d&&d.openCount>0&&!d.improved.length)
    &&window.slice(1).every((d,i)=>d.openCount>=window[i].openCount&&(d.opened.length||d.reopened.length));
  if(pending.some(f=>f.streak>=2)||churn){
    delta.decision='replan';delta.reason=churn?'多轮修订持续出现缺陷，待办数量未下降，重新诊断受影响的子系统。':
      '同一问题连续两轮缺少已验证的改善，重新诊断并改变修复办法。';
  }
  const priorReplan=history.slice(-2).some(r=>r.repair?.strategy==='replan');
  if(pending.length&&(pending.every(f=>f.route==='platform')||priorReplan&&(pending.some(f=>f.streak>=4)||churn))){
    delta.decision='diagnose';delta.reason=pending.every(f=>f.route==='platform')?
      '所需检查或表达能力未接通，已记录平台缺口。':'更换修复办法后仍未收敛，已保存问题与证据，停止自动续修。';
  }
  return {ledger,delta,issues:pending.map(f=>f.id+' '+f.description)};
}
