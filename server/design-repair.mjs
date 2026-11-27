import {runtimeCapabilityEvidence,capabilityInstructions} from './design-capabilities.mjs';
import {applyArchitectureRevision,architectureRevisionSchema,validateArchitectureRevision} from './design-architecture.mjs';
import {structuredCall,format,designDeliverableScope,productDesignScope,responseProvenance} from './design-review.mjs';
import {officialStageGuide} from './official-skills.mjs';
import {validateInteraction,validateInteractionGeometry} from '../interaction-model.js';
import {reviewInteractionGeometry} from './interaction-geometry-review.mjs';
import {reconstructedGeometry} from './part-reconstruction.mjs';
import {MAX_CAD_BODIES,MAX_CAD_FEATURES} from '../cad-plan.js';
import {modelingGuide} from './modeling-guide.mjs';
import {hasLocalCodex} from './openai-response.mjs';
import {cadFeatureTupleInput,candidateForModel,geometryForModel,invalidTerminalBindings,reconstructedPartsInput} from './model-geometry-input.mjs';
const s={type:'string'},object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schema=object({architectureRevision:architectureRevisionSchema,strategy:{type:'string',enum:['repair','replan']},diagnosis:s,requirements:{type:'array',items:s},requirementsReason:s,changes:{type:'array',items:s},research:{type:'array',items:object({partIndex:{type:'integer'},question:s,reviseIndependentModel:{type:'boolean'}})},acceptance:{type:'array',items:s}});

export function applyRepairRequirements(state,repair){
  applyArchitectureRevision(state,repair);
  // Earlier saved plans have no requirements field. Their original baseline
  // remains intact; new plans explicitly reconcile it with the conversation.
  const next=repair.requirements;
  if(!Array.isArray(next)||!next.length||next.length>40||!next.every(r=>typeof r==='string'&&r.trim()&&r.length<=4000))return;
  if(JSON.stringify(next)===JSON.stringify(state.selection.requirements))return;
  state.requirementRevisions??=[];
  state.requirementRevisions.push({attempt:repair.attempt,previous:state.selection.requirements,requirements:next,reason:repair.requirementsReason||repair.diagnosis});
  state.selection={...state.selection,requirements:next};
}
export async function planRepair(ctx,state,env,send,signal){
  const [guide,runtimeGuide]=await Promise.all([officialStageGuide('repair',env),modelingGuide(env,{stage:'repair'})]);
  const candidate=state.candidate||state.lastDraft;
  const localCodex=hasLocalCodex(env);
  // Recheck persisted candidates with the current validator on resume, so a
  // recovered job also receives independent defects hidden by an older check.
  let currentValidationIssues=[];
  if(candidate?.interaction&&Array.isArray(candidate.parts)&&Array.isArray(candidate.cadPlan?.bodies)){
    try{validateInteraction(candidate.interaction,candidate);}catch(error){currentValidationIssues=error.issues||[error.message];}
  }
  let currentGeometry;
  if(candidate?.cadPlan?.joints?.length>1){
    let interaction=null;
    try{interaction=validateInteractionGeometry(candidate.interaction,{bom:candidate.parts,cadPlan:candidate.cadPlan});}catch{/* Joint geometry can still be checked independently. */}
    currentGeometry=await reviewInteractionGeometry({...candidate,interaction},{signal,local:env.PUBLIC_WORKER!=='1'});
    currentGeometry.reconstructedParts=reconstructedGeometry(state.lastDraft||candidate,state.sources||{});
  }
  const openFindings=(state.issueLedger||[]).filter(row=>row.status==='open');
  const repeated=openFindings.filter(row=>row.streak>=2).map(row=>row.id);
  const replanRequired=state.rounds?.at(-1)?.issueDelta?.decision==='replan'||repeated.length>0;
  const previousRounds=state.rounds?.slice(-3).map(r=>({attempt:r.attempt,issues:r.issues,
    ...(localCodex&&r.repair?.researched&&r.repair?.research?.length?{completedResearch:r.repair.research}:{})}));
  const terminalBindings=localCodex?invalidTerminalBindings(state.lastDraft||candidate):[];
  const reuseEvidence=localCodex?'\n重复的已查问题见 previousRounds.completedResearch，并结合 candidate 的来源与 currentGeometry，复用已保存的结果。只安排取得不同证据且为修复确有必要的查证。terminalBindings 是原始修订基线上的具体路径，标出实体归属错误、未接线与重复声明。修复计划须落实有关端子的电气路径、接点归属和必要的索引修正。\n'+cadFeatureTupleInput+'\n'+reconstructedPartsInput:'';
  const architectureInstruction='保留选型时确定的最低主动轴数及串联层数 motionRequirements；可改传动方案、部件和分支，不因已有草图缺轴而降低用户要求。沿用 architecture 及其边界与接口。architectureRevision 默认 null。当选型查证、新用户要求或已发现的工程冲突需要改变架构时，给出 reason 和完整的新 decisions，标明受影响的接口、运动及 BOM 项，保留用户要求。新约定的每个成员用 deviceUse 明确实际分工：product-core、support、result-viewer 或 personal-device-core。由专用实物承担核心功能；已有通用终端限于查看结果。已有旧任务没有架构时不虚构原有约定。';
  const capacity=runtimeGuide.text+'\n'+capabilityInstructions+'\n'+architectureInstruction+'\n当前装配支持 '+MAX_CAD_BODIES+' 个独立 body、累计 '+MAX_CAD_FEATURES+' 个特征。每件实际安装的采购件保留独立锚点与正确数量，不能合并同型号实例规避覆盖检查。查证项仅在现有独立模型的几何或安装基准确需修正时将 reviseIndependentModel 设为 true。只查电气逻辑、更新装配位置或确认已记录资料时保留原模型，填 false。修复步骤必须符合上述当前接口，不安排尚不存在的动态几何求解、快照接口或固件能力来代替缺陷修复。公开资料检索不能索取到货实测、供应商签认或装配方试验；自制件的设计图和参数由 AI 根据现有依据定义，实测保留为后续验证。先核对当前 requirements：它们是先前 AI 的推导，不全是用户的原话。返回完整更新后的 requirements，保留明确核心能力，以最新反馈纠正过时实现假设和超范围承诺，在 requirementsReason 说明变化或沿用的理由。不得为消除报错而降低用户要求或删除未解决的必需功能。';
  const result=await structuredCall(send,env,signal,{instructions:guide.text+'\n'+designDeliverableScope+'\n'+productDesignScope+'\n'+capacity+'\n你负责实际消除缺陷。根据已经执行的检查选择最小有效修复；连续两轮同类问题仍未解决时，重构失败子系统或更换资料可查的成品模块，不能重复同一份缺孔、缺壳或错接线的草稿。用户不懂硬件，不向用户索取技术补充。不把验收条件降低，也不把无法实现的功能改名为演示功能。currentGeometry 是本次重新执行的逐轴与联动检测，连同 currentValidationIssues 一起处理，不能只看旧评审。研究请求须具体到缺失的孔距/轴线/接口/供电资料或可下载替代文件；最多三件最影响装配的部件。无 CAD 的部件用资料推导的参数模型，不能一直停在下载失败。需要新选型在 changes 中指示设计器，下一轮会自动查证。openFindings 按 route 处理：research 先获取具体资料，evidence 先核实当前检查或页面报告；已确认的 platform 项只能采用等效且可验证的现有方案，或留给平台开发。已证实平台缺能力时不要要求 CAD 重做相同操作。replanRequired 为 true 时必须选择 replan，明确替换失败子结构或其建模方法，保留其他正确部分。'+reuseEvidence,input:JSON.stringify({goal:ctx.prompt,runtimeCapabilities:runtimeCapabilityEvidence(candidate),conversation:ctx.history,requirements:state.selection.requirements,architecture:state.selection.architecture,motionRequirements:state.selection.motionRequirements,candidate:localCodex?candidateForModel(candidate):candidate,previousRounds,openFindings,issues:state.issues,currentValidationIssues,currentGeometry:localCodex?geometryForModel(currentGeometry):currentGeometry,repeatedFailures:repeated,replanRequired,...(terminalBindings.length?{terminalBindings}:{})}),text:format('hardware_repair_plan',schema)},'制定修复方案');
  const p=result.value;
  validateArchitectureRevision(p.architectureRevision,true);
  if(!['repair','replan'].includes(p.strategy)||!Array.isArray(p.changes)||!p.changes.length||!Array.isArray(p.research))throw Error('修复计划缺少可执行修改。');
  if(replanRequired&&p.strategy!=='replan')throw Error('重复缺陷需要重新规划失败子系统。');
  p.research=p.research.filter(r=>Number.isInteger(r.partIndex)&&candidate?.parts?.[r.partIndex]&&typeof r.question==='string').slice(0,3);
  return {...p,...responseProvenance(result),skills:guide.sources,runtimeSkill:runtimeGuide.skill.project,policy:runtimeGuide.skill.policy,...(currentGeometry?{verification:{currentGeometry,currentValidationIssues}}:{}),...(result.recovery?{recovery:result.recovery}:{})};
}
