import {validateCadPlan,cadPlanSchema} from './cad-plan.mjs';
import {modelingGuide,functionalReviewGuide,generation} from './modeling-guide.mjs';
import {locateDesignTerminals,terminalReview} from './design-terminals.mjs';
import {interactionSchema,validateInteraction,validateInteractionGeometry,validateTerminalLocations,normalizeInteractionTimerAliases} from '../interaction-model.js';
import {reviewInteractionGeometry} from './interaction-geometry-review.mjs';
import {ModelStageError,structuredCall,format,addModelData,evaluateDraft,replayInteraction} from './design-review.mjs';
import {DesignInputError,readDesignRequest,modelInput,projectDesignForModel,photoInstructions,ready,readDecision,discussionSchema,discussionInstructions,revisionInstructions} from './design-conversation.mjs';
import {referenceIds,catalogInstructions,designReference,alignCatalogAnchors,resolvedCatalogGeometry} from './design-references.mjs';
import {sourceMechanicalEvidence,retainedMechanicalEvidence,evidenceInstructions,withMechanicalEvidence,attachMechanicalEvidence} from './design-evidence.mjs';
const string={type:'string'},obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}),array=items=>({type:'array',items});
const role=['internal','external','panel','enclosure'];
const deviceMotion=['stationary','powered-linear','other'];
export const schema=obj({name:string,summary:string,deviceMotion:{type:'string',enum:deviceMotion},parts:array(obj({name:string,spec:string,qty:{type:'integer'},model:string,modelId:{type:'string',enum:['',...referenceIds]},sizeMm:array({type:'number'}),dimensionSource:{type:'string',enum:['catalog','estimated','specified']},dimensionQuote:string,role:{type:'string',enum:role},placement:{type:'string',enum:['mounted','loose']},purpose:string})),steps:array(string),cadPlan:cadPlanSchema,interaction:interactionSchema});
export const instructions=`你是研究原型硬件设计师。根据用户当前需求，从零选择合适结构、器件、接口、供电与制造方式，并用中文说明具体步骤、装配和功能验证；不要把每个项目都做成 Pico 状态灯。列真实可识别的器件系列或可搜索的采购规格，不能确认型号时写待选型，自制外壳列入 BOM。每项包括数量、作用、安装位置（internal 内部、panel 面板、external 外部、enclosure 自制壳体）、三维外包络 sizeMm [长,宽,高] 毫米；不要用电路板尺寸代替含连接器的整个组件。估计写 estimated。确为用户给出的三维尺寸，可写 specified，并以 dimensionQuote 摘录含部件和毫米尺寸的用户原文；否则引用留空。目录ID仅在型号和封装符合时使用，没有匹配填空。目录只代表参考几何，不能声称验证购买 SKU、公差、库存、商家、价格或真实装配。可用几何参考：${catalogInstructions}。未验证的供电、运动空间、安装孔位和功能在步骤中说明如何检查。`;
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
 const hasTravel=Boolean(plan.motions?.length);
 if(raw.deviceMotion!==undefined&&!deviceMotion.includes(raw.deviceMotion))throw new AssemblyError('设计缺少有效的设备动作说明。');
 if(!hasTravel&&(changingPoweredStroke||raw.deviceMotion==='powered-linear'||explicitlyExtends(prompt)||explicitlyExtends(raw.summary)))
  throw new AssemblyError('方案描述了装置主动伸缩，但 CAD 缺少驱动、导向、随动件或行程。请重新生成。');
 if(hasTravel&&raw.deviceMotion&&raw.deviceMotion!=='powered-linear')
  throw new AssemblyError('设计说明与 CAD 中的主动直线运动不一致。请重新生成。');
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
  const key=JSON.stringify([body.partIndex,body.role,motionByBody.get(index)??null,features]);
  if(placedGeometry.has(key))throw new AssemblyError('同一零件在相同安装位重复放置了相同的实体：'+raw.parts[body.partIndex].name+'。请核对数量和位置。');
  placedGeometry.add(key);
 }
 for(const [index,part] of raw.parts.entries()){
  if(part.placement==='mounted'&&!placedParts.has(index))
   throw new AssemblyError('CAD 缺少已安装零件的位置：'+part.name+'。请重新生成。');
 }
 return plan;
}
function normalizePhysical(raw,prompt,latestIntent=prompt,strokeDirection=requestedStrokeDirection([latestIntent]),changingPoweredStroke=false){if(!str(raw?.name,200)||!str(raw.summary,5000)||!Array.isArray(raw.parts)||!raw.parts.length||raw.parts.length>60||!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>60||!raw.steps.every(s=>str(s,2000)))throw Error('invalid design');
 const parts=raw.parts.map(p=>{if(!str(p?.name,200)||!str(p.spec,800)||!str(p.model,240)||!Number.isInteger(p.qty)||p.qty<1||p.qty>999||!role.includes(p.role)||!sizes(p.sizeMm)||!str(p.purpose,500))throw Error('invalid part');
 const result={name:p.name.trim(),spec:p.spec.trim(),model:p.model.trim(),qty:p.qty,role:p.role,purpose:p.purpose.trim(),modelId:'',sizeMm:p.sizeMm,dimensionSource:'estimated',dimensionNote:'AI 估算的设计包络；采购和制作前须核对实物。',dimensionSourceUrl:'',...(['mounted','loose'].includes(p.placement)?{placement:p.placement}:{})};
 if(p.dimensionSource==='specified'&&specified(p,prompt))return {...result,dimensionSource:'specified',dimensionQuote:p.dimensionQuote,dimensionNote:'需求原文：'+p.dimensionQuote};
 const reference=designReference(p);return reference?{...result,...reference}:result;});
 const plan=validateInstallation(raw,latestIntent,strokeDirection,changingPoweredStroke);
 const cadPlan=alignCatalogAnchors(plan,raw.parts,parts);
 return {name:raw.name.trim(),summary:raw.summary.trim(),parts,steps:raw.steps.map(s=>s.trim()),cadPlan,...(raw.deviceMotion?{deviceMotion:raw.deviceMotion}:{})};
}
function designInteraction(raw,design){
 try{return validateInteraction(raw,{bom:design.parts,cadPlan:design.cadPlan});}
 catch(error){throw new AssemblyError('交互定义未通过校验。'+error.message);}
}
export function normalizeDesign(raw,...args){
 const design=normalizePhysical(raw,...args),interaction=designInteraction(raw.interaction,design);
 return interaction?{...design,interaction}:design;
}
export async function design(request,env,send=fetch){const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply({error:'只支持 POST。'},405);
 if(!env.OPENAI_API_KEY||!env.OPENAI_MODEL)return reply({error:'设计服务尚未连接。'},503);
 const timeout=AbortSignal.timeout(600_000);
 const signal=AbortSignal.any([request.signal,timeout]);
 let discussing=false;
 try{
  const ctx=await readDesignRequest(request);
  discussing=ctx.action==='discuss';
  if(discussing&&ctx.history.slice(ctx.discussionStart).filter(turn=>turn.role==='assistant').length>=2)return reply(ready());
  const hasImages=ctx.images.length>0;
  const photos=hasImages?'\n'+photoInstructions:'';
  if(discussing){
   const call=await structuredCall(send,env,signal,{instructions:discussionInstructions+photos,input:modelInput(ctx),
    text:format('hardware_clarification',discussionSchema)},'设计讨论',{hasImages});
   return reply(readDecision(call.value));
  }
  const [guide,reviewSkill]=await Promise.all([modelingGuide(env),functionalReviewGuide(env)]);
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
  let evidence=retained?await retainedMechanicalEvidence(ctx,env):await sourceMechanicalEvidence(ctx,env,send,signal);
  const authoring=[instructions,...(ctx.history.length||ctx.baseDesign?[revisionInstructions]:[]),axisNote,evidenceInstructions,guide.text].join('\n')+photos;
  let originalInput=withMechanicalEvidence(modelInput(ctx),evidence);
  let previousIssues=ctx.repairCandidate?.issues||[],lastCandidate=null;
  let input=ctx.repairCandidate?addModelData(originalInput,{task:'从以下未发布草稿和失败记录继续修正，保留正确部分；仅以新一轮校验和资料为准。',rejectedDraft:projectDesignForModel(ctx.repairCandidate.design),issues:previousIssues}):originalInput;
  for(let attempt=1;attempt<=2;attempt++){
   const reuseThisDraft=retained&&attempt===1;
   const draft=reuseThisDraft?{value:pending,model:null}:await structuredCall(send,env,signal,{instructions:authoring,input,text:format('hardware_design',schema)},attempt===1?'设计生成':'设计修正',{hasImages});
   const aliases=normalizeInteractionTimerAliases(draft.value?.interaction);
   const normalizedDraft=aliases.corrections.length?{...draft.value,interaction:aliases.model}:draft.value;
   let candidate,definitionIssues=[],physicalValid=false,interactiveValid=false;
   try{candidate=normalizePhysical(normalizedDraft,...physicalArgs);physicalValid=true;}
   catch(error){definitionIssues.push(error instanceof AssemblyError?error.message:'草图的零件信息或结构数据不完整。');}
   let normalizedInteraction=normalizedDraft.interaction;
   let geometry={status:'unavailable',checks:['CAD 数据未通过，无法执行几何检查。'],issues:[]},catalogGeometry=[];
   let wiring={scope:'terminal-locations',status:'unavailable'};
   if(physicalValid){
    candidate=await attachMechanicalEvidence(candidate,evidence.records,env.OPENAI_API_KEY);
    catalogGeometry=resolvedCatalogGeometry(candidate);
    normalizedInteraction=locateDesignTerminals(normalizedInteraction,candidate);
    try{const model=designInteraction(normalizedInteraction,candidate);if(model)candidate.interaction=model;interactiveValid=true;}
    catch(error){candidate.interaction=normalizedInteraction;definitionIssues.push(error.message);}
    if(interactiveValid)wiring=terminalReview(candidate.interaction);
    else try{
     validateTerminalLocations(normalizedInteraction,candidate);
     wiring=terminalReview(normalizedInteraction);
    }catch(error){if(!definitionIssues.some(i=>i.includes(error.message)))definitionIssues.push(error.message);}
    let mechanicalInteraction=candidate.interaction;
    if(!interactiveValid){
     try{mechanicalInteraction=validateInteractionGeometry(candidate.interaction,{bom:candidate.parts,cadPlan:candidate.cadPlan});}
     catch{mechanicalInteraction=null;}
    }
    geometry=await reviewInteractionGeometry({...candidate,interaction:mechanicalInteraction},{signal,local:env.PUBLIC_WORKER!=='1'});
    if(!interactiveValid&&!mechanicalInteraction)geometry.checks.push('控制件的安装映射未通过校验，其操作行程未测试。');
   }else candidate={name:draft.value?.name,summary:draft.value?.summary,parts:Array.isArray(draft.value?.parts)?draft.value.parts.filter(Boolean).map(
    ({name,model,spec,sizeMm,qty,purpose,placement,role})=>({name,model,spec,sizeMm,qty,purpose,placement,role})):[],
    cadPlan:draft.value?.cadPlan,interaction:draft.value?.interaction,steps:draft.value?.steps,deviceMotion:draft.value?.deviceMotion};
   const behavior=interactiveValid?replayInteraction(candidate.interaction):{status:'unavailable',initialState:null,visitedStates:[],observations:[],issues:[]};
   const evaluation=await evaluateDraft({ctx,candidate,geometry,catalogGeometry,behavior,wiring,normalizations:aliases.corrections,definitionIssues,previousIssues,skill:reviewSkill,env,send,signal});
   lastCandidate=physicalValid?candidate:null;
   if(!evaluation.issues.length){
    const provenance=generation('openai-api',draft.model??env.OPENAI_MODEL,draft.model?'response':'configured',guide.skill);
    provenance.mechanicalResearch={status:evidence.status,requested:evidence.candidates.length,found:evidence.found,
     ...(evidence.inherited?{inherited:evidence.inherited}:{})};
    provenance.designReview={status:'preview-reviewed',attempts:attempt,skill:reviewSkill.skill,modelId:evaluation.model??null,
     checks:evaluation.review.checks,physicalChecks:evaluation.review.physicalChecks,geometry,behavior,wiring,
     ...(reuseThisDraft?{draftSource:'retained-candidate'}:{}),...(aliases.corrections.length?{normalizations:aliases.corrections}:{}),
     ...(attempt>1||reuseThisDraft?{correctedIssues:previousIssues}:{})};
    return reply({design:{...candidate,generation:provenance}});
   }
   previousIssues=evaluation.issues;
   if(reuseThisDraft){
    // The review found a genuine design defect after migration. Research any parts needed for an actual repair.
    evidence=await sourceMechanicalEvidence(ctx,env,send,signal);
    originalInput=withMechanicalEvidence(modelInput(ctx),evidence);
   }
   if(attempt<2)input=addModelData(originalInput,{task:'修改以下草稿，逐项解决评审发现的问题。保留已满足的目标。返回完整、索引一致、能重新接受独立评审的设计。',
    rejectedDraft:reuseThisDraft?projectDesignForModel({...pending,interaction:aliases.model}):normalizedDraft,issues:previousIssues,geometry,catalogGeometry});
  }
  return reply({error:'设计已修正并重新评审，仍需处理。'+previousIssues.slice(0,3).join(' '),
   review:{status:'needs-revision',attempts:2,issues:previousIssues},...(lastCandidate?{repairCandidate:{design:lastCandidate,issues:previousIssues.slice(0,12).map(s=>s.slice(0,1500))}}:{})},502);
 }catch(error){
  if(error instanceof DesignInputError)return reply({error:error.message},error.status);
  if(timeout.aborted||error.name==='TimeoutError')return reply({error:'设计或评审未在时限内完成（单阶段 5 分钟，整轮 10 分钟）。请重试。'},504);
  if(request.signal.aborted)return reply({error:'生成请求已取消。'},499);
  return reply({error:error instanceof AssemblyError||error instanceof ModelStageError?error.message:discussing?'设计讨论暂时无法完成，可以重试或直接生成。':'设计未完成或零件信息不完整，请重试。'},502);
 }
}
