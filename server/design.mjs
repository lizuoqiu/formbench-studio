import {validateCadPlan,cadPlanSchema} from './cad-plan.mjs';
import {MAX_DESIGN_PARTS} from '../cad-plan.js';
import {modelingGuide,functionalReviewGuide,generation} from './modeling-guide.mjs';
import {locateDesignTerminals,terminalReview} from './design-terminals.mjs';
import {interactionSchema,validateInteraction,validateInteractionGeometry,validateTerminalLocations,revisedTerminalLocations,normalizeInteractionTimerAliases} from '../interaction-model.js';
import {reviewInteractionGeometry} from './interaction-geometry-review.mjs';
import {revisedMechanicalDependencies} from './revision-dependencies.mjs';
import {ModelStageError,structuredCall,format,addModelData,evaluateDraft,replayInteraction,designDeliverableScope,responseProvenance} from './design-review.mjs';
import {DesignInputError,maxDesignSteps,readDesignRequest,modelInput,projectDesignForModel,photoInstructions,revisionInstructions,answerBeforeStarting,pendingDesignQuestion} from './design-conversation.mjs';
import {discussRequirements} from './design-intake.mjs';
import {referenceIds,catalogInstructions,designReference,alignCatalogAnchors,resolvedCatalogGeometry} from './design-references.mjs';
import {sourceMechanicalEvidence,retainedMechanicalEvidence,evidenceInstructions,withMechanicalEvidence,attachMechanicalEvidence} from './design-evidence.mjs';
import {selectParts,sourceParts,sourcesForModel,attachPartSources,sourcingIssues} from './part-sourcing.mjs';
import {importedSubsetIssues,partIdentity} from '../part-records.js';
import {officialStageGuide} from './official-skills.mjs';
import {deviceMotionTypes,inspectArchitecture,inspectMotionRequirements} from './design-architecture.mjs';
import {planRepair,applyRepairRequirements} from './design-repair.mjs';
import {needsIncrementalRevision,reviseAssembly} from './design-revision.mjs';
import {reconstructParts,materializeReconstructedParts,reconstructionPlacementIssues,reconstructedGeometry,queueReconstructionRevision} from './part-reconstruction.mjs';
import {designCoverage,reviewAssemblyFit} from './design-coverage.mjs';
import {reconcilePartModels} from './assembly-alignment.mjs';
import {designVisuals} from './design-visuals.mjs';
import {hasLocalCodex,requireAvailableBilling} from './openai-response.mjs';
import {assemblyEvidenceForModel,invalidTerminalBindings,reconstructedPartsInput} from './model-geometry-input.mjs';
import {hasOpenAIKey,primaryOpenAIKey} from './openai-keys.mjs';
const string={type:'string'},obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}),array=items=>({type:'array',items});
const role=['internal','external','panel','enclosure'];
export const schema=obj({name:string,summary:string,deviceMotion:{type:'string',enum:deviceMotionTypes},parts:array(obj({name:string,spec:string,kind:{type:'string',enum:['purchase','custom','material','included','provided']},qty:{type:'integer'},model:string,modelId:{type:'string',enum:['',...referenceIds]},sizeMm:array({type:'number'}),dimensionSource:{type:'string',enum:['catalog','estimated','specified']},dimensionQuote:string,role:{type:'string',enum:role},placement:{type:'string',enum:['mounted','loose']},purpose:string})),steps:array(string),cadPlan:cadPlanSchema,interaction:interactionSchema});
export const instructions=`你是研究原型硬件设计师。根据用户当前需求，首次设计选择合适结构、器件、接口、供电与制造方式；已有设计则只增量修改受影响的部分，并用中文说明具体步骤、装配和功能验证；不要把每个项目都做成 Pico 状态灯。列真实可识别的器件系列或可搜索的采购规格，不能确认型号时写待选型，自制外壳列入 BOM。每项包括数量、作用、安装位置（internal 内部、panel 面板、external 外部、enclosure 自制壳体）、三维外包络 sizeMm [长,宽,高] 毫米；不要用电路板尺寸代替含连接器的整个组件。估计写 estimated。确为用户给出的三维尺寸，可写 specified，并以 dimensionQuote 摘录含部件和毫米尺寸的用户原文；否则引用留空。目录ID仅在型号和封装符合时使用，没有匹配填空。目录只代表参考几何，不能声称验证购买 SKU、公差、库存、商家、价格或真实装配。可用几何参考：${catalogInstructions}。未验证的供电、运动空间、安装孔位和功能在步骤中说明如何检查。`;
const str=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
const sizes=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>0&&n<=10000);
const triplet=/(\d+(?:\.\d+)?)\s*[x×*＊]\s*(\d+(?:\.\d+)?)\s*[x×*＊]\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)/ig;
function specified(p,prompt){const q=p.dimensionQuote;return str(q,500)&&prompt.includes(q)&&(q.toLowerCase().includes(p.name.toLowerCase())||q.toLowerCase().includes(p.model.toLowerCase()))&&Array.from(q.matchAll(triplet)).some(m=>p.sizeMm.every((v,k)=>v===Number(m[k+1])));}
class AssemblyError extends Error {}

const strokeAxes={
 up:{label:'垂直向上伸出（+Z）',accepts:([x,y,z])=>Math.hypot(x,y)<=0.001&&z>0},
 vertical:{label:'沿竖直轴伸缩',accepts:([x,y])=>Math.hypot(x,y)<=0.001},
 horizontal:{label:'沿水平面伸出',accepts:([,,z])=>Math.abs(z)<=0.001}
};

// Enforce only an unambiguous extension direction in the user's own instructions.
// Ambiguous language, orientation of the housing, and multi-axis design stay with the model.
function requestedStrokeDirection(turns){
 const note=turns.findLast(text=>/伸出|伸缩|推出|顶出|轴向|方向|上升|倾斜|斜上|斜向|固定|静止|不动|手动|手摇|向前|旋转|停止运动|extend|extension|stationary|rotat/i.test(text));
 if(!note||/多轴|双轴|两轴|自由度|多方向|多种方向|(?:改用|改为|改成|采用)手[动摇推]|multi.axis|degrees? of freedom/i.test(note))return null;
 const directions=new Set();
 for(const clause of note.split(/[，,。.!！;；\n]|而是|而要|\bbut\b/i)){
  if(/[？?或]|是否|选择|考虑|也许|可能|如果|不要|避免|不应|不想|不用|禁止|不能|不是|不再|无需|手动|(?:用户|人|我)(?:的手|的手臂|用手|把手|本人)?(?:沿|朝|向|垂直|竖直|水平)|\b(?:not|never|without|if|or|manual(?:ly)?|my hand)\b/i.test(clause))continue;
  const revision=clause.split(/改成|改为|调整为/);
  const action=revision.at(-1).replace(/[（(](?:世界坐标|重力|[+-]Z)[^()（）]{0,40}[)）]/gi,'');
  // Keep the direction adjacent to the extension verb. A face pointing up can still slide forward.
  const compact=action.replace(/重力的?反方向|\+Z轴?/gi,'竖直向上').replaceAll('垂直','竖直')
   .replace(/的?方向|缓慢|慢慢|主动|直线|地|\s+/g,'');
  const motion=compact.match(/(竖直向上|竖直|水平(?:向前|向外)?)(?=伸出|伸缩|顶出|推出)/);
  const english=action.match(/\bextends?\s+(vertically(?:\s+up(?:wards?)?)?|horizontally)\b/i);
  const direction=motion?.[1]??english?.[1];
  if(direction){
   if(revision.length>1)directions.clear();
   if(/水平|horizontally/i.test(direction))directions.add('horizontal');
   else directions.add(/向上|up/i.test(direction)?'up':'vertical');
  }
 }
 // An upward extension also satisfies an unsigned vertical constraint.
 if(directions.has('up'))directions.delete('vertical');
 return directions.size===1?[...directions][0]:null;
}

// Catch explicit device-driven extension even if the model labels the design stationary.
// The model handles relational cues such as reciprocal greetings in the interaction skill.
function explicitlyExtends(text){
 const clauses=text.split(/[，。！？；,.!?;\n]|但是|而是|\bbut\b/i);
 return clauses.some(clause=>{
  if(/不要|不需要|不能|无需|不应|不会|不想|不主动|禁止|手动|手摇|手推|\b(?:never|not|without|manual(?:ly)?)\b|n['’]t\b/i.test(clause))return false;
  return /(?<!向|朝|朝着|对着|给|面向)(?:AI|装置|设备|机器人|机构|它|执行器|电机|机械臂)\s*(?:本身|自己|应该|应当|需要|能够|应|要|先|再|会|主动|自动|自行|缓慢|慢慢|向前|向外|向我|向人|向上|向下|轻轻|垂直|竖直|水平|直线|地|可以)*(?:伸出|伸展|伸缩|推出)|\b(?:device|robot|actuator|it)\s+(?:(?:itself|should|will|can|automatically|actively|slowly|gently|first)\s+)*(?:extend|retract)s?\b/i.test(clause);
 });
}

function validateInstallation(raw,prompt,strokeDirection,changingPoweredStroke){
 let plan;
 try {plan=validateCadPlan(raw.cadPlan,raw.parts.length);}
 catch(error){
  const detail=error.message==='Invalid CAD plan'?'请检查零件索引、图元尺寸、旋转和布尔操作。':error.message;
  throw new AssemblyError('CAD 方案未通过校验。'+detail);
 }
 const hasTravel=Boolean(plan.motions?.length),hasRotation=Boolean(plan.joints?.length);
 const declaredLinear=['powered-linear','powered-mixed'].includes(raw.deviceMotion);
 const declaredRotary=['powered-rotary','powered-mixed'].includes(raw.deviceMotion);
 if(raw.deviceMotion!==undefined&&!deviceMotionTypes.includes(raw.deviceMotion))throw new AssemblyError('设计缺少有效的设备动作说明。');
 if(!hasTravel&&(changingPoweredStroke||declaredLinear||explicitlyExtends(prompt)||explicitlyExtends(raw.summary)))
  throw new AssemblyError('方案描述了装置主动伸缩，但 CAD 缺少驱动、导向、随动件或行程。请重新生成。');
 if(hasTravel&&raw.deviceMotion&&!declaredLinear)
  throw new AssemblyError('设计说明与 CAD 中的主动直线运动不一致。请重新生成。');
 if(declaredRotary&&!hasRotation)throw new AssemblyError('方案描述了装置主动旋转，但 CAD 缺少旋转关节、固定件及随动件。');
 if(hasRotation&&raw.deviceMotion==='stationary')throw new AssemblyError('设备声明为静止，但 CAD 含有主动旋转关节。');
 if(strokeDirection&&plan.motions?.length===1){
  const {label,accepts}=strokeAxes[strokeDirection],axis=plan.motions[0].axis;
  if(!accepts(axis))throw new AssemblyError('要求'+label+'，当前 CAD 伸出方向为 ['+axis.join(', ')+']。请重新生成机构。');
 }
 const placedParts=new Set(),placedGeometry=new Set(),motionByBody=new Map();
 for(const [motionIndex,motion] of (plan.motions||[]).entries()){
  for(const index of motion.movingBodyIndices)motionByBody.set(index,motionIndex);
 }
 for(const [index,body] of plan.bodies.entries()){
  placedParts.add(body.partIndex);
  // A single purchased assembly can contribute several different fixed and moving solids.
  // Only coincident copies of the same geometry for the same BOM row are duplicates.
  const features=body.features.map(f=>[f.op,f.shape,f.sizeMm,
   f.centerMm.map((v,i)=>v+body.positionMm[i]),f.rotationDeg||[0,0,0]]);
  const meshIndices=body.sourceMeshes?[...body.sourceMeshes.meshIndices].sort((a,b)=>a-b):null;
  const key=JSON.stringify([body.partIndex,body.role,motionByBody.get(index)??null,features,meshIndices]);
  if(placedGeometry.has(key))throw new AssemblyError('同一零件在相同安装位重复放置了相同的实体：'+raw.parts[body.partIndex].name+'。请核对数量和位置。');
  placedGeometry.add(key);
 }
 for(const [index,part] of raw.parts.entries()){
  if(part.placement==='mounted'&&!placedParts.has(index))
   throw new AssemblyError('CAD 缺少已安装零件的位置：'+part.name+'。请重新生成。');
 }
 return plan;
}
function normalizePhysical(raw,prompt,latestIntent=prompt,strokeDirection=requestedStrokeDirection([latestIntent]),changingPoweredStroke=false){if(!str(raw?.name,200)||!str(raw.summary,5000)||!Array.isArray(raw.parts)||!raw.parts.length||raw.parts.length>MAX_DESIGN_PARTS)throw Error('invalid design');
 if(!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>maxDesignSteps||!raw.steps.every(s=>str(s,2000)))
  throw new AssemblyError('装配步骤须为 1 至 '+maxDesignSteps+' 条，每条不超过 2000 字。');
 const parts=raw.parts.map(p=>{if(!str(p?.name,200)||!str(p.spec,800)||!str(p.model,240)||!Number.isInteger(p.qty)||p.qty<1||p.qty>999||!role.includes(p.role)||!sizes(p.sizeMm)||!str(p.purpose,500))throw Error('invalid part');
 const result={name:p.name.trim(),spec:p.spec.trim(),model:p.model.trim(),qty:p.qty,role:p.role,...(['purchase','custom','material','included','provided'].includes(p.kind)?{kind:p.kind}:{}),purpose:p.purpose.trim(),modelId:'',sizeMm:p.sizeMm,dimensionSource:'estimated',dimensionNote:'AI 估算的设计包络；采购和制作前须核对实物。',dimensionSourceUrl:'',...(['mounted','loose'].includes(p.placement)?{placement:p.placement}:{})};
 if(p.dimensionSource==='specified'&&specified(p,prompt))return {...result,dimensionSource:'specified',dimensionQuote:p.dimensionQuote,dimensionNote:'需求原文：'+p.dimensionQuote};
 const reference=designReference(p);return reference?{...result,...reference}:result;});
 const plan=validateInstallation(raw,latestIntent,strokeDirection,changingPoweredStroke);
 const cadPlan=alignCatalogAnchors(plan,raw.parts,parts);
 return {name:raw.name.trim(),summary:raw.summary.trim(),parts,steps:raw.steps.map(s=>s.trim()),cadPlan,...(raw.deviceMotion?{deviceMotion:raw.deviceMotion}:{})};
}
function designInteraction(raw,design){
 try{return validateInteraction(raw,{bom:design.parts,cadPlan:design.cadPlan});}
 catch(error){throw Object.assign(new AssemblyError('交互定义未通过校验。'+error.message),{issues:error.issues});}
}
export function normalizeDesign(raw,...args){
 const design=normalizePhysical(raw,...args),interaction=designInteraction(raw.interaction,design);
 return interaction?{...design,interaction}:design;
}
// A resumed draft re-enters sourcing before and after assembly. Both visits
// share its lookup results, including completed searches with unverified links.
function sourcingPass(state,attempt){
  if(state.sourcingPass?.attempt!==attempt)state.sourcingPass={attempt,ordinaryLookups:{}};
  return state.sourcingPass;
}
export async function design(request,env,send=fetch,workflow=null){const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply({error:'只支持 POST。'},405);
 if(!hasLocalCodex(env)&&(!hasOpenAIKey(env)||!env.OPENAI_MODEL))return reply({error:'设计服务尚未连接。'},503);
 const timeout=AbortSignal.timeout(workflow?180*60_000:600_000);
 const signal=AbortSignal.any([request.signal,timeout]);
 let discussing=false;
 try{
  const ctx=await readDesignRequest(request);
  discussing=ctx.action==='discuss';
  if(!discussing&&pendingDesignQuestion(ctx)){
   if(!workflow)return reply({error:answerBeforeStarting},409);
   // Older saved jobs could start after skipping a question. Keep the job,
   // without passing that unanswered suggestion to the designer as a preference.
   ctx.history=ctx.history.slice(0,-1);
  }
  const hasImages=ctx.images.length>0;
  const photos=hasImages?'\n'+photoInstructions:'';
  if(discussing)return reply(await discussRequirements(ctx,env,send,signal));
  const [guide,reviewSkill]=await Promise.all([modelingGuide(env),functionalReviewGuide(env)]);
  const state=workflow?.state;
  const progress=async event=>{if(workflow)await workflow.progress(event);};
  if(state?.serviceFailures?.some(f=>f.stage==='generating'&&/输出已达长度上限/.test(f.error)))state.assemblyOutputBudget=131072;
  const startAttempt=state?.nextAttempt||1;
  const attempts=workflow?startAttempt+2:2;
  if(workflow){
   state.sources??={};
   if(!hasLocalCodex(env))requireAvailableBilling(state);
   if(!state.selection){
    await progress({stage:'planning',message:'正在确定功能与零件方案'});
    state.selection=await selectParts(ctx,env,send,signal);
    await progress({stage:'planning',message:'零件方案已确定'});
   }
   const parts=state.draft?.value?.parts||state.candidate?.parts||state.lastDraft?.parts||state.selection.parts;
   const sourceAttempt=state.draft?.attempt||state.rounds?.at(-1)?.attempt||startAttempt;
   await sourceParts(parts,state.sources,env,send,signal,progress,state.draft?.value?.cadPlan||state.lastDraft?.cadPlan,sourcingPass(state,sourceAttempt));
   await reconstructParts(parts,state.sources,env,send,signal,progress,state.draft?.value?.cadPlan||state.lastDraft?.cadPlan);
  }
  const userMessages=[ctx.prompt,...ctx.history.filter(turn=>turn.role==='user').map(turn=>turn.text)];
  const currentTurns=ctx.baseDesign?ctx.history.slice(ctx.discussionStart).filter(turn=>turn.role==='user').map(turn=>turn.text):userMessages;
  const strokeDirection=requestedStrokeDirection(currentTurns.length?currentTurns:[ctx.prompt]);
  const changingPoweredStroke=Boolean(strokeDirection)&&ctx.baseDesign?.cadPlan?.motions?.length===1;
  const axisNote=strokeDirection?'本轮用户指定所述部件'+strokeAxes[strokeDirection].label+'。按装配世界坐标布置机构和回程。':'';
  const physicalArgs=[userMessages.join('\n'),userMessages.at(-1),strokeDirection,changingPoweredStroke];
  const pending=ctx.repairCandidate?.design,priorAlias=normalizeInteractionTimerAliases(pending?.interaction);
  let retained=false;
  if(pending&&priorAlias.corrections.length){
   try{normalizeDesign({...pending,interaction:priorAlias.model},...physicalArgs);retained=true;}catch{/* another defect still requires design work */}
  }
  let evidence=workflow?{candidates:[],records:[],status:'per-part',found:0}:retained?await retainedMechanicalEvidence(ctx,env):await sourceMechanicalEvidence(ctx,env,send,signal);
  const official=workflow?await officialStageGuide('modeling',env):{text:'',sources:[]};
  const authoring=[instructions,...(ctx.history.length||ctx.baseDesign?[revisionInstructions]:[]),axisNote,workflow?'使用逐件 research 的实际记录。importedModel 是已下载并读取的 CAD。research.reconstruction 是已独立生成且用 ForgeCAD 编译过的采购件模型：每个实际实例用单个 reference box 锚点，sizeMm 逐轴等于 reconstruction.sizeMm，centerMm 与 rotationDeg 定位，后台会用真实的独立零件特征替换这个锚点。不要把带重建模型的板卡、电机再画成别的粗略模型。为采购数量逐个放置锚点。对既有部分保持正确数据，所有自制壳体、盖板、固定和随动件仍独立建模，不能因部件多省掉。terminalBindings 如有内容，列出 rejectedDraft 中的错误端子路径及当前实体归属。按实际端点依据和安装关系修复这些路径。':evidenceInstructions,guide.text,official.text,designDeliverableScope].filter(Boolean).join('\n')+photos;
  // Include the exact patch base once, below. Conversation context and photos
  // stay available without also repeating the client baseDesign in each call.
  const designContext=()=>modelInput({...ctx,baseDesign:null});
  let originalInput=withMechanicalEvidence(designContext(),evidence);
  const currentParts=state?.draft?.value?.parts||state?.candidate?.parts||state?.lastDraft?.parts||state?.selection?.parts;
  if(workflow)originalInput=addModelData(originalInput,{requirements:state.selection.requirements,architecture:state.selection.architecture,motionRequirements:state.selection.motionRequirements,
   ...(startAttempt===1&&state.selection.architectureIssues?{initialArchitectureIssues:state.selection.architectureIssues}:{}),
   selectedParts:sourcesForModel(currentParts,currentParts.map(p=>state.sources[partIdentity(p)])),
   task:'依据逐件查证结果制作装配。importedModel 已在服务器读取。可按原生 XYZ 尺寸用单个 reference box 安装整件，或按建模规则用 sourceMeshes 安装实际可分离的原厂子件；centerMm 和 rotationDeg 明确各自定位，禁止缩放。安装数量对应 BOM。无原厂可用网格的子件利用已查尺寸建立可辨认形体。所有源码和几何将实际编译，检查后继续修订。'});
  let previousIssues=state?.issues||ctx.repairCandidate?.issues||[],lastCandidate=state?.candidate||null;
  let revisionBase=state?.lastDraft||state?.candidate||((pending||ctx.baseDesign)?projectDesignForModel(pending||ctx.baseDesign):null);
  let input=revisionBase?addModelData(originalInput,{task:'在以下已有设计上增量修订。保留正确部分；仅以新一轮校验和资料为准。',rejectedDraft:revisionBase,issues:previousIssues}):originalInput;
  for(let attempt=startAttempt;attempt<=attempts;attempt++){
   if(workflow&&previousIssues.length){
    if(state.repair?.attempt!==attempt){
     await progress({stage:'repair-planning',attempt,message:'正在分析问题并选择修复方法'});
     state.repair={...await planRepair(ctx,state,env,send,signal),attempt};
     applyRepairRequirements(state,state.repair);
     await progress({stage:'repair-planning',attempt,message:'修复方案已确定'});
    }
    const repairParts=state.candidate?.parts||state.lastDraft?.parts||state.selection.parts;
    const selected=state.repair.research.map(({partIndex,question,reviseIndependentModel})=>({...repairParts[partIndex],researchQuestion:question,reviseIndependentModel}));
    if(selected.length&&!state.repair.researched){
     await sourceParts(selected,state.sources,env,send,signal,progress);
     for(const part of selected)if(part.reviseIndependentModel!==false)queueReconstructionRevision(state.sources[partIdentity(part)],part.researchQuestion);
     await reconstructParts(selected,state.sources,env,send,signal,progress);
     state.repair.researched=true;await progress({stage:"repair-planning",attempt,message:"缺失资料与部件模型已重新核对"});
    }
    const repair=state.repair,localRelay=hasLocalCodex(env);
    const terminalBindings=localRelay?invalidTerminalBindings(revisionBase):[];
    const selectedParts=sourcesForModel(repairParts,repairParts.map(p=>state.sources[partIdentity(p)]));
    const modelEvidence=localRelay?assemblyEvidenceForModel({selectedParts,geometry:repair.verification?.currentGeometry,
      repair,review:state.rounds?.at(-1)?.review,draft:revisionBase,terminalBindings}):{selectedParts};
    const repairPlan=localRelay&&repair.verification?.currentGeometry?{...repair,verification:{...repair.verification,
      currentGeometry:modelEvidence.geometry,reconstructedPartsInput}}:repair;
    input=addModelData(withMechanicalEvidence(designContext(),evidence),{requirements:state.selection.requirements,architecture:state.selection.architecture,motionRequirements:state.selection.motionRequirements,
      selectedParts:modelEvidence.selectedParts,rejectedDraft:revisionBase,repairPlan,issues:previousIssues,
      ...(localRelay?{evidenceScope:'rejectedDraft 是完整补丁基线；selectedParts 按 partIndex 给出查证资料。保留未涉及的已有安装和模型，部分无关件只带来源及尺寸摘要。'}:{}),
      ...(terminalBindings.length?{terminalBindings}:{})});
   }
   await progress({stage:'generating',attempt,message:'第 '+attempt+' 轮 · 正在生成结构'});
   const reuseThisDraft=retained&&attempt===1;
   let draft=state?.draft?.attempt===attempt?state.draft:reuseThisDraft?{value:pending,model:null}:null;
   if(!draft){
    const recovery=state?.generationRecovery?.attempt===attempt?state.generationRecovery:null;
    // Only a previously saved, incomplete legacy full response retains its old
    // recovery format. Every newly started revision uses operations.
    const incremental=needsIncrementalRevision(revisionBase)&&recovery?.mode!=='full';
    const budget=incremental?(state?.revisionOutputBudget||state?.assemblyOutputBudget||65536):(state?.assemblyOutputBudget||65536);
    const generationInput=recovery?.partialOutput?addModelData(input,{truncatedDraft:recovery.partialOutput,previousFailure:recovery.error,
     task:incremental?'上轮修订操作因长度上限中断，尚未应用。针对同一个 rejectedDraft 返回完整修订操作，保留有效分析，不能仅续写尾部。':'上轮整体输出因长度上限中断，尚未形成可校验的设计。参考其合理内容与原修复方案，保留正确部分并返回完整 JSON；不能只续写尾部，也不能删除所需部件来缩短输出。'}):input;
    try{draft=incremental
     ?await reviseAssembly(revisionBase,{instructions:authoring,input:generationInput,max_output_tokens:budget},send,env,signal,{hasImages,timeoutMs:workflow?3600000:300000})
     :await structuredCall(send,env,signal,{instructions:authoring,input:generationInput,max_output_tokens:budget,text:format('hardware_design',schema)},attempt===1?'设计生成':'设计修正',{hasImages,timeoutMs:workflow?3600000:300000});}
    catch(error){
     if(workflow&&error.incompleteReason==='max_output_tokens'){
      state.generationRecovery={attempt,mode:incremental?'revision':'full',error:error.message,partialOutput:error.partialOutput,usage:error.usage};
      if(incremental)state.revisionOutputBudget=131072;else state.assemblyOutputBudget=131072;
      await progress({stage:'recovering',attempt,message:'设计输出较长，正在保留草稿并继续生成'});
      if(budget<131072)return reply({continue:true,message:'已保存截断草稿，将提高输出额度继续。'},202);
     }
     throw error;
    }
    if(state)delete state.generationRecovery;
   }
   if(workflow){state.draft={...draft,attempt};await progress({stage:'sourcing',attempt,message:'第 '+attempt+' 轮 · 正在核对新增和变更的部件'});}
   let aliases=normalizeInteractionTimerAliases(draft.value?.interaction);
   let normalizedDraft=aliases.corrections.length?{...draft.value,interaction:aliases.model}:draft.value;
   if(workflow&&Array.isArray(normalizedDraft.parts)){
    await sourceParts(normalizedDraft.parts,state.sources,env,send,signal,progress,normalizedDraft.cadPlan,sourcingPass(state,attempt));
    await reconstructParts(normalizedDraft.parts,state.sources,env,send,signal,progress,normalizedDraft.cadPlan);
    draft=await reconcilePartModels({...draft,value:normalizedDraft,attempt},{state,ctx,instructions:authoring,env,send,signal,progress});
    aliases=normalizeInteractionTimerAliases(draft.value?.interaction);
    normalizedDraft=aliases.corrections.length?{...draft.value,interaction:aliases.model}:draft.value;
   }
   revisionBase=reuseThisDraft?projectDesignForModel(normalizedDraft):normalizedDraft;
   delete ctx.motionEvidence;
   let candidate,definitionIssues=[],reconstructedParts=[],physicalValid=false,interactiveValid=false;
   try{candidate=normalizePhysical(normalizedDraft,...physicalArgs);physicalValid=true;}
   catch(error){definitionIssues.push(error instanceof AssemblyError?error.message:'草图的零件信息或结构数据不完整。');}
   let normalizedInteraction=normalizedDraft.interaction;
   let geometry={status:'unavailable',checks:['CAD 数据未通过，无法执行几何检查。'],issues:[]},catalogGeometry=[];
   let wiring={scope:'terminal-locations',status:'unavailable'};
   if(physicalValid){
    ctx.motionEvidence=inspectMotionRequirements(state?.selection?.motionRequirements||evidence.motionRequirements,candidate.cadPlan);
    if(ctx.motionEvidence){
     ctx.motionEvidence.source=workflow?'part-selection':evidence.motionSource||'mechanical-shortlist';
     definitionIssues.push(...ctx.motionEvidence.issues);
    }
    candidate=await attachMechanicalEvidence(candidate,evidence.records,primaryOpenAIKey(env));
    if(workflow){candidate=attachPartSources(candidate,state.sources);definitionIssues.push(...reconstructionPlacementIssues({...candidate,interaction:normalizedInteraction},state.sources));reconstructedParts=reconstructedGeometry(candidate,state.sources);candidate=materializeReconstructedParts(candidate,state.sources);definitionIssues.push(...sourcingIssues(candidate,state.sources));}
    catalogGeometry=resolvedCatalogGeometry(candidate);
    normalizedInteraction=locateDesignTerminals(normalizedInteraction,candidate);
    const terminalRevision=draft.revision?revisedTerminalLocations(lastCandidate||ctx.baseDesign,{...candidate,interaction:normalizedInteraction}):null;
    try{const model=designInteraction(normalizedInteraction,candidate);if(model)candidate.interaction=model;interactiveValid=true;}
    catch(error){candidate.interaction=normalizedInteraction;definitionIssues.push(...(error.issues||[error.message]));}
    if(interactiveValid)wiring=terminalReview(candidate.interaction);
    else try{
     validateTerminalLocations(normalizedInteraction,candidate);
     wiring=terminalReview(normalizedInteraction);
    }catch(error){for(const issue of error.issues||[error.message])if(!definitionIssues.includes(issue))definitionIssues.push(issue);}
    if(terminalRevision?.checked.length){
     wiring={...wiring,terminalRevision};
     for(const {issue} of terminalRevision.checked)if(issue&&!definitionIssues.includes(issue))definitionIssues.push(issue);
    }
    let mechanicalInteraction=candidate.interaction;
    if(!interactiveValid){
     try{mechanicalInteraction=validateInteractionGeometry(candidate.interaction,{bom:candidate.parts,cadPlan:candidate.cadPlan});}
     catch{mechanicalInteraction=null;}
    }
    const inspectOptions={signal,local:env.PUBLIC_WORKER!=='1'};
    const revisionDependencies=draft.revision?await revisedMechanicalDependencies(lastCandidate||pending||ctx.baseDesign,candidate,
      {...inspectOptions,reconstructedParts}):null;
    geometry=await reviewInteractionGeometry({...candidate,interaction:mechanicalInteraction},inspectOptions);
    if(revisionDependencies)geometry.revisionDependencies=revisionDependencies;
    if(workflow){
     geometry.reconstructedParts=reconstructedParts;
     geometry.installation=designCoverage(candidate,state.selection.requirements);
     geometry.assemblyFit=await reviewAssemblyFit(candidate,state.selection.requirements,inspectOptions);
     definitionIssues.push(...geometry.installation.issues,...geometry.assemblyFit.issues);
    }
    if(!interactiveValid&&!mechanicalInteraction)geometry.checks.push('控制件的安装映射未通过校验，其操作行程未测试。');
   }else candidate={name:draft.value?.name,summary:draft.value?.summary,parts:Array.isArray(draft.value?.parts)?draft.value.parts.filter(Boolean).map(
    ({name,model,spec,sizeMm,qty,purpose,placement,role})=>({name,model,spec,sizeMm,qty,purpose,placement,role})):[],
    cadPlan:draft.value?.cadPlan,interaction:draft.value?.interaction,steps:draft.value?.steps,deviceMotion:draft.value?.deviceMotion};
   let visuals=[];
   if(workflow&&physicalValid){
    const savedCad=await workflow.loadCompiled?.(attempt,candidate.cadPlan);
    let compiled=savedCad,compilationError;
    if(!compiled){
      await progress({stage:'building',attempt,message:'第 '+attempt+' 轮 · 正在制作 CAD'});
      const {forgePlan}=await import('./forge-plan.mjs');
      const built=await forgePlan(new Request('http://127.0.0.1/api/forge/plan',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({cadPlan:candidate.cadPlan})}),env);
      compiled=await built.json();
      if(!built.ok)compilationError=compiled.error||('HTTP '+built.status);
    }
    if(!compilationError){state.compiled=savedCad||{...compiled,cadPlan:candidate.cadPlan};geometry.compilation={engine:compiled.engine||'Manifold',bodies:compiled.bodies?.length,status:'compiled',...(savedCad?{reused:true}:{})};
     await progress({stage:'inspecting',attempt,message:'正在检查外观、内部与不同方向的结构'});
     visuals=await designVisuals(candidate,compiled,env);state.visuals=visuals;geometry.visualViews=visuals.map(v=>({name:v.name,scope:v.scope,bodyCount:v.bodyCount}));
     if(workflow.checkBrowser)geometry.browserPreview=await workflow.checkBrowser(candidate,state.compiled,signal);}
    else {state.compiled=null;definitionIssues.push('实际 CAD 编译失败：'+compilationError);}
    for(const [partIndex,part]of candidate.parts.entries()){
      const own=candidate.cadPlan.bodies.flatMap((body,bodyIndex)=>body.partIndex===partIndex?[{body,bodyIndex}]:[]);
      const subsets=own.filter(({body})=>body.sourceMeshes);
      if(subsets.length){
        const issues=importedSubsetIssues(own.map(({body})=>body),part,part.importedModel);
        definitionIssues.push(...issues.map(issue=>part.name+' 的 CAD 分件：'+issue));
        if(!issues.length){
          const native=subsets.filter(({body})=>body.sourceMeshes.meshIndices.length);
          const dimensions=subsets.filter(({body})=>!body.sourceMeshes.meshIndices.length);
          catalogGeometry.push({partIndex,name:part.name,source:part.importedModel.sourceType+' CAD',
            sourceUrl:part.importedModel.sourceUrl,bodyIndices:native.map(({bodyIndex})=>bodyIndex),
            meshPlacements:native.map(({body,bodyIndex})=>({bodyIndex,...body.sourceMeshes})),
            dimensionedBodies:dimensions.map(({body,bodyIndex})=>({bodyIndex,instanceIndex:body.sourceMeshes.instanceIndex,basis:body.sourceMeshes.dimensionBasis}))});
        }
        continue;
      }
      if(!part.importedModel)continue;
      const expected=part.importedModel.sizeMm;
      const complete=own.filter(({body:b})=>b.role==='reference'&&b.features.length===1&&b.features[0].shape==='box'&&b.features[0].sizeMm.every((n,i)=>Math.abs(n-expected[i])<.02));
      if(part.placement==='mounted'&&complete.length!==part.qty)definitionIssues.push(part.name+' 的已导入 CAD 需要 '+part.qty+' 个按 '+expected.join(' × ')+' mm 原生轴向建立的完整 reference box 锚点。用 rotationDeg 调整朝向，保留实际尺寸，其他组件应单列 BOM。');
      if(complete.length)catalogGeometry.push({partIndex,name:part.name,source:part.importedModel.sourceType+' CAD',sizeMm:expected,sourceUrl:part.importedModel.sourceUrl,bodyIndices:complete.map(({bodyIndex})=>bodyIndex)});
    }
   }
   delete ctx.architectureEvidence;
   if(workflow&&state.selection.architecture&&Array.isArray(normalizedDraft?.parts)){
    ctx.architectureEvidence=inspectArchitecture(state.selection.architecture,physicalValid?candidate.parts:normalizedDraft.parts,
      {interaction:interactiveValid?candidate.interaction:null,cadPlan:physicalValid?candidate.cadPlan:null});
    definitionIssues.push(...ctx.architectureEvidence.issues);
   }
   await progress({stage:'reviewing',attempt,message:'第 '+attempt+' 轮 · 正在检查装配与功能'});
   const behavior=interactiveValid?replayInteraction(candidate.interaction):{status:'unavailable',initialState:null,visitedStates:[],observations:[],issues:[]};
   ctx.recoverMotionRequirements=!workflow&&!evidence.motionRequirements;
   const evaluation=await evaluateDraft({ctx,candidate,geometry,catalogGeometry,behavior,wiring,normalizations:aliases.corrections,definitionIssues,previousIssues,skill:reviewSkill,env,send,signal,visuals,workflow:Boolean(workflow),
    tracking:workflow?{previous:state.issueLedger||[],attempt,history:state.rounds||[],physicalValid,interactiveValid}:undefined});
   if(ctx.recoverMotionRequirements){
    evidence.motionRequirements=evaluation.review.motionRequirements;
    evidence.motionSource='independent-review';
    originalInput=withMechanicalEvidence(designContext(),evidence);
    if(physicalValid){
     ctx.motionEvidence=inspectMotionRequirements(evidence.motionRequirements,candidate.cadPlan);
     ctx.motionEvidence.source=evidence.motionSource;
     evaluation.issues.push(...ctx.motionEvidence.issues);
    }
   }
   if(ctx.architectureEvidence)evaluation.review.architecture=ctx.architectureEvidence;
   if(ctx.motionEvidence)evaluation.review.motion=ctx.motionEvidence;
   if(wiring.terminalRevision)evaluation.review.terminalRevision=wiring.terminalRevision;
   lastCandidate=physicalValid?candidate:null;
   if(workflow){
    state.candidate=lastCandidate;state.lastDraft=normalizedDraft;state.issues=evaluation.issues;state.nextAttempt=attempt+1;delete state.draft;
    state.issueLedger=evaluation.ledger;
    state.rounds??=[];state.rounds.push({attempt,issueDelta:evaluation.issueDelta,...responseProvenance(draft),...(draft.revision?{revision:draft.revision}:{}),...(draft.alignments?.length?{alignments:draft.alignments}:{}),repair:state.repair,skills:official.sources,candidate:physicalValid?candidate:normalizedDraft,issues:evaluation.issues,review:{...evaluation.review,...responseProvenance(evaluation)},...(evaluation.recovery?{reviewRecovery:evaluation.recovery}:{}),geometry,at:new Date().toISOString()});
    await progress({stage:evaluation.issues.length?'repairing':'complete',attempt,message:evaluation.issues.length?'第 '+attempt+' 轮发现 '+evaluation.issues.length+' 项问题，正在修订':'模型与零件资料已完成'});
    if(evaluation.issueDelta.decision==='diagnose')return reply({paused:true,error:evaluation.issueDelta.reason,actionRequired:'workflow-diagnosis'},202);
    if(evaluation.issues.length&&await workflow.shouldPause?.(attempt))return reply({paused:true,error:'第 '+attempt+' 轮检查已完成，按要求暂停后续修订。'},202);
   }
   if(!evaluation.issues.length){
    const {provider,model,modelSource,...draftProvenance}=responseProvenance(draft);
    const provenance={...generation(provider,model??env.OPENAI_MODEL,model?modelSource:'configured',guide.skill),...draftProvenance};
    if(draft.revision)provenance.assemblyRevision={mode:'incremental',operations:draft.revision.operations.length+(draft.alignments||[]).reduce((n,a)=>n+a.revision.operations.length,0),alignmentPasses:draft.alignments?.length||0,...(draft.alignments?.length?{alignmentProvenance:draft.alignments.map(responseProvenance)}:{}),...(attempt>1?{baseAttempt:attempt-1}:{baseSource:'existing-design'})};
    provenance.mechanicalResearch={status:evidence.status,requested:evidence.candidates.length,found:evidence.found,
     ...(evidence.inherited?{inherited:evidence.inherited}:{})};
    const {model:reviewModel,...reviewProvenance}=responseProvenance(evaluation);
    provenance.designReview={status:'preview-reviewed',attempts:attempt,skill:reviewSkill.skill,modelId:reviewModel??null,...reviewProvenance,
     checks:evaluation.review.checks,physicalChecks:evaluation.review.physicalChecks,geometry,behavior,wiring,...(ctx.motionEvidence?{motion:ctx.motionEvidence}:{}),...(ctx.architectureEvidence?{architecture:ctx.architectureEvidence}:{}),...(evaluation.recovery?{recovery:evaluation.recovery}:{}),
     ...(reuseThisDraft?{draftSource:'retained-candidate'}:{}),...(aliases.corrections.length?{normalizations:aliases.corrections}:{}),
     ...(attempt>1||reuseThisDraft?{correctedIssues:previousIssues}:{})};
    if(workflow){provenance.workflow={jobId:workflow.id,attempts:attempt,parts:candidate.parts.length,imported:candidate.parts.filter(p=>p.importedModel).length,rounds:state.rounds.map(r=>({attempt:r.attempt,issues:r.issues}))};provenance.cadUrl='/api/design-jobs/'+workflow.id+'/cad.json';}
    return reply({design:{...candidate,generation:provenance}});
   }
   previousIssues=evaluation.issues;
   if(reuseThisDraft){
    // The review found a genuine design defect after migration. Research any parts needed for an actual repair.
    const researched=await sourceMechanicalEvidence(ctx,env,send,signal);
    evidence={...researched,motionRequirements:evidence.motionRequirements||researched.motionRequirements,motionSource:evidence.motionSource};
    originalInput=withMechanicalEvidence(designContext(),evidence);
   }
   // Replace the previous evidence snapshot. Accumulating every old BOM makes
   // later rounds longer and reintroduces superseded specifications.
   if(workflow)originalInput=addModelData(withMechanicalEvidence(designContext(),evidence),{requirements:state.selection.requirements,architecture:state.selection.architecture,motionRequirements:state.selection.motionRequirements,updatedParts:sourcesForModel(candidate.parts,candidate.parts.map(p=>state.sources[partIdentity(p)])),
    task:'依据已执行的下载、建模和评审进行针对性修复。优先修复具体错误，保留正确部件。相同错误再次出现时改变失败的表达或结构；不要只改说明。资料不全则更换可查型号，系统会查证。'});
   if(attempt<attempts)input=addModelData(originalInput,{task:'增量修改以下草稿，逐项解决评审发现的问题。保留已满足的目标。仅输出必要操作，使应用后的完整设计索引一致并重新接受独立评审。',
    rejectedDraft:revisionBase,issues:previousIssues,geometry,catalogGeometry});
  }
  if(workflow)return reply({continue:true,message:'正在根据检查结果继续完善设计。'},202);
  return reply({error:'设计已修正并重新评审，仍需处理。'+previousIssues.slice(0,3).join(' '),
   review:{status:'needs-revision',attempts,issues:previousIssues},...(lastCandidate?{repairCandidate:{design:lastCandidate,issues:previousIssues.slice(0,12).map(s=>s.slice(0,1500))}}:{})},502);
 }catch(error){
  if(error.actionRequired==='local-codex-unavailable'&&error.retryable)return reply({error:error.message,reason:error.reason,retryable:true},504);
  if(error.actionRequired==='local-codex-unavailable')return reply({error:error.message,actionRequired:error.actionRequired,quotaExhausted:error.quotaExhausted===true,retryable:false},424);
  if(error.actionRequired==='api-billing'){if(workflow)workflow.state.billingRequired=true;return reply({error:error.message,actionRequired:error.actionRequired,retryable:false},402);}
  if(error.actionRequired==='independent-hardware')return reply({error:error.message,actionRequired:error.actionRequired,retryable:false},422);
  if(error instanceof DesignInputError)return reply({error:error.message},error.status);
  if(timeout.aborted||error.name==='TimeoutError')return reply({retryable:true,error:'本次执行时段已结束，已保存进度。'},504);
  if(request.signal.aborted)return reply({error:'生成请求已取消。'},499);
  return reply({error:error instanceof AssemblyError||error instanceof ModelStageError||error.message?.startsWith('OpenAI ')?error.message:discussing?'设计讨论暂时无法完成，可以重试或直接生成。':'设计未完成或零件信息不完整，请重试。'},502);
 }
}
