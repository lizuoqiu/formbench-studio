import {mountConsumerCad} from './consumer-cad.js';
import {validateInteraction} from './interaction-model.js';
import {readDesignJob} from './consumer-jobs.js';

const $=selector=>document.querySelector(selector),params=new URL(location.href).searchParams,id=params.get('job'),preview=params.get('preview')==='1';
const controller=new AbortController();let dispose=null;
addEventListener('pagehide',()=>{controller.abort();dispose?.();},{once:true});
const decisionLabels={complete:'检查通过',continue:'继续修订',replan:'重新规划相关部件',diagnose:'已转入诊断'};
function history(rounds,ledger=[]){
  const container=$('#review-history'),last=rounds.at(-1);
  const records=new Map(ledger.map(issue=>[issue.id,issue]));
  container.replaceChildren();
  for(const round of rounds){
    const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');
    const delta=round.issueDelta,notes=round.issues||[];
    const result=delta?(decisionLabels[delta.decision]||'检查已记录'):(notes.length?'待修订评语 '+notes.length+' 条':'本轮没有待修订评语');
    summary.textContent='第 '+round.attempt+' 轮 · '+result;
    details.append(summary);
    if(delta){
      for(const [key,label] of [['opened','新增'],['persisted','仍待修订'],['improved','已有改善'],['reopened','再次出现'],['closed','已验证关闭']]){
        const ids=delta[key]||[];
        if(!ids.length)continue;
        const line=document.createElement('p');
        line.textContent=label+' '+ids.join('、');details.append(line);
      }
      if(delta.reason){const reason=document.createElement('p');reason.textContent=delta.reason;details.append(reason);}
    }
    for(const note of notes){const li=document.createElement('li');li.textContent=note;list.append(li);}
    if(list.childElementCount)details.append(list);
    if(round===last&&delta){
      const relevant=new Set(['opened','persisted','reopened','closed'].flatMap(key=>delta[key]||[]));
      for(const id of relevant){
        const record=records.get(id);if(!record)continue;
        const evidence=document.createElement('details'),title=document.createElement('summary');title.textContent=id+' · 核查依据';evidence.append(title);
        for(const [label,value] of [['首次记录',Number.isInteger(record.firstSeen)?'第 '+record.firstSeen+' 轮':''],['观察结果',record.evidence],['关闭条件',record.acceptance],['关闭依据',record.closureEvidence]]){
          if(!value)continue;
          const line=document.createElement('p');line.textContent=label+'　'+value;evidence.append(line);
        }
        details.append(evidence);
      }
    }
    details.open=round===last;container.append(details);
  }
}
async function request(retry=false){
  const response=await fetch('/api/design-jobs/'+id+(retry?'/retry':preview?'/preview':''),{signal:controller.signal,cache:'no-store',credentials:'same-origin',
    ...(retry?{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}:{})});
  const job=await response.json().catch(()=>null);if(!response.ok||!job)throw Object.assign(Error(job?.error||'任务无法读取。'),{status:response.ok?503:response.status});return job;
}
async function show(){
  if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('请从设计任务链接打开这份记录。');
  $('#review-retry').hidden=true;$('#review-open').hidden=true;$('#review-preview').hidden=true;
  let job;
  do{
    job=await readDesignJob(id,{call:()=>request(),signal:controller.signal,onReconnect:event=>{
      $('#review-status').dataset.state='running';$('#review-label').textContent='正在重新连接';$('#review-progress').textContent=event.message;
      const spinner=document.createElement('span');spinner.className='review-spinner';$('#review-progress').prepend(spinner);
    }});$('#review-status').dataset.state=job.status;history(job.rounds||[],job.issueLedger);
    const billing=job.actionRequired==='api-billing';
    $('#review-label').textContent=billing?'服务额度不足，进度已保存':job.actionRequired==='workflow-diagnosis'?'修订已暂停，等待处理诊断结果':job.status==='paused'?'本轮检查已完成，已暂停':job.status==='running'?'设计进行中':job.status==='complete'?'数字设计检查已完成':'这版仍需修订';
    $('#review-retry').textContent=billing?'恢复额度后继续':'继续修订';
    $('#review-progress').textContent=billing||job.status==='paused'?job.error:job.status==='running'?job.progress?.message||'正在处理':job.status==='complete'?
      '可打开项目查看零件与结构。加工配合、实际供电和负载仍需实物验证。':'这是待修订草稿，可检查结构与部件资料；尚不能作为下单或制作的定稿。';
    if(job.status==='running'){
      const spinner=document.createElement('span');spinner.className='review-spinner';$('#review-progress').prepend(spinner);
      await new Promise(resolve=>setTimeout(resolve,1800));
    }
  }while(job.status==='running'&&!controller.signal.aborted);
  controller.signal.throwIfAborted();
  if(job.status==='paused'){
    $('#review-retry').hidden=false;
    if(!job.preview){
      $('#review-grid').hidden=true;$('#review-preview').hidden=job.previewAvailable===false||!job.parts?.length;
      if(job.previewAvailable===false)$('#review-progress').textContent=(job.error||'本轮已暂停。')+' 本轮 CAD 未完成，模型预览暂不可用。';
      $('#review-preview').href='./design-review.html?job='+id+'&preview=1';return;
    }
    $('#review-label').textContent='第 '+job.preview.attempt+' 轮 · 待修订预览';
    $('#review-progress').textContent='查看已保存的外壳、内部部件和关节运动。任务已暂停；当前设计仍有待修订项。';
  }
  const original=job.actionRequired==='api-billing'?null:job.preview?.design||job.design||job.repairCandidate?.design;
  if(original?.parts?.length&&original.cadPlan){
    const design=structuredClone(original);
    // Invalid behavior remains in the stored draft and review history. The
    // inspection view can still show its unchanged solids and declared joints.
    try{validateInteraction(design.interaction,{bom:design.parts,cadPlan:design.cadPlan});}
    catch(error){design.interaction=null;$('#review-behavior').hidden=false;$('#review-behavior').textContent='交互定义未通过校验，当前可查看结构与关节运动。完整问题记录见下方。';}
    $('#review-title').textContent=design.name;$('#review-grid').hidden=false;
    dispose=mountConsumerCad($('#review-cad'),design,{partsPanel:$('#review-parts'),downloads:false,savedCadUrl:job.preview?.cadUrl||design.generation?.cadUrl,
      onStatus:value=>{const node=$('#review-cad');node.dataset.phase=value.phase;node.dataset.exact=String(value.exact);node.dataset.engine=value.engine||'';}});
  }
  if(job.status==='complete'){$('#review-open').hidden=false;$('#review-open').href='./?job='+id;}
  else if(['needs-revision','failed'].includes(job.status))$('#review-retry').hidden=false;
}
function error(error){if(!controller.signal.aborted){$('#review-label').textContent='任务暂时无法读取';$('#review-progress').textContent=error.message;}}
$('#review-retry').onclick=async()=>{
  $('#review-retry').disabled=true;
  try{await request(true);if(preview){location.replace('./design-review.html?job='+id);return;}dispose?.();$('#review-grid').hidden=true;$('#review-behavior').hidden=true;await show();}
  catch(e){error(e);}finally{$('#review-retry').disabled=false;}
};
show().catch(error);
