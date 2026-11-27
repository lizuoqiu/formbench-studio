import {motionRequirementsInstructions,motionRequirementsSchema,validMotionRequirements} from './design-architecture.mjs';
import {advanceDefects,browserEvidenceForFinding,findingArraySchema,findingInstructions,machineFindings,previousReviewFindings,verifiedLinearTravel} from './design-defects.mjs';
import {runtimeCapabilityEvidence,capabilityInstructions,capabilityPreflight} from './design-capabilities.mjs';
import {initialInteraction,stepInteraction,controlEvent} from '../interaction-model.js';
import {reasoningSettings,responseBudget} from './model-settings.mjs';
import {officialStageGuide} from './official-skills.mjs';
import {hasLocalCodex,requestOpenAI,responseTrace,responseSourceUrls} from './openai-response.mjs';
import {cadFeatureTupleInput,candidateForModel,geometryForModel,reconstructedPartsInput} from './model-geometry-input.mjs';

const areas=['intent','form','mechanism','control'];
const labels={intent:'交互意图',form:'外形与接触面',mechanism:'机构与装配',control:'供电与控制'};
const str={type:'string'},indices={type:'array',items:{type:'integer'}};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const designDeliverableScope='本轮交付范围是可追踪的数字硬件设计：BOM 与来源、完整装配 CAD、必要的电气连接，以及本系统可表达的交互预览。必须把使功能成立的供电、数据链、机构和控制规则设计完整。固件/手机端的接口、状态、时序和实现要求属于设计依据；不能仅因尚无编译固件、签名 APK、刷机或实物测试记录而拒绝数字设计，也不能声称这些已经执行。未实现的软件和实物试验列入后续制作与验证，不能在摘要或完成说明中冒充已交付。对先前草稿自行增加的范围，保留用户要求的功能与设计条件，纠正超出本阶段的交付承诺；不能借此略去已知干涉、错接线、缺部件或缺少必要控制逻辑。';
export const designObjectScope='设计范围以用户点名的产品主体为准。主体的内部驱动、控制、传动、支承、走线和外壳必须完整；不能把使用该产品所需的整个环境扩成制造任务。外置成品电源、数据线等配套可列采购和连接说明，需展示时直接按所选成品的原厂 CAD 或尺寸建模放在主体外，不为它们新增专用托盘、护盒、停车架或收纳器；用户已有手机等列 provided 与接口条件，不必建立手机实体。用户要 demo、轻量原型或能用即可时，以最少复杂度完成核心能力，优先成熟模块和简明控制，暂不增加可选手势、收纳或复杂授权操作。requirements 是 AI 推导的验收要求，必须服从用户原始目标与最新反馈；已有草稿包含某种配套或承诺不等于用户要求它。修订过时实现假设时记录原因，不降低明确的功能要求，不略去必要承载、供电、停止与限位。优先把必要功能集成在主体内，移除冗余结构时同步检查其功能和连接，不能把主体内部必要件误删为附属品。';
export const productDesignScope=designObjectScope+'先判断整机是否仍满足用户要使用的产品，再处理局部工程问题。以实际 CAD 多视角、BOM 用途和使用过程为据，核对主体、外接附件、用户已有设备的边界、整体占地、臂展或行程、接口可达性和日常操作步骤。不能只因每个新增支架、护罩、线仓分别有理由，就接受它们累计占据主体空间或让普通用户难以使用。对这种问题在 intent/form 写出具体部件、尺寸或操作证据，并要求简化相应子系统；零件数本身不是失败判据。先比较集成、合并功能或替换失败结构的办法，再增加新的补偿机构。保留原需求和安全、承载、供电、走线所必需的功能；不能靠隐藏模型、删除必要件、减少自由度、缩短所需行程或取消检查来让外观过关。保留正确选型、资料和模型，仅增量修改受影响的子系统及其装配/控制引用。';
const deliveryStatuses=['independent-hardware','personal-device-core','unidentified'];
export const reviewSchema=object({productDelivery:object({status:{type:'string',enum:deliveryStatuses},partIndices:indices,evidence:str}),
 requiresInteraction:{type:'boolean'},checks:{type:'array',items:object({
 area:{type:'string',enum:areas},status:{type:'string',enum:['pass','repair','not-applicable']},note:str,partIndices:indices,bodyIndices:indices
})},physicalChecks:{type:'array',items:str}});

const motionReviewSchema=object({...reviewSchema.properties,motionRequirements:motionRequirementsSchema});
const trackedReviewSchema=object({...reviewSchema.properties,checks:{type:'array',
 items:object({...reviewSchema.properties.checks.items.properties,reportedIssueIndices:indices})},findings:findingArraySchema});
const reviewInstructions=`若有 architectureEvidence，逐个比对已存的方案、接口、固定与随动关系及实际 CAD/接线/运行证据。关键件身份与内外边界的匹配不证明电气、接口或运动正确。定位具体不一致；有依据的换型由修复计划更新约定。你是独立审查当前工程草稿的交互与机械设计评审员。阅读用户原需求、讨论、可能的上一版、照片与当前 BOM/CAD/交互定义和本地几何报告。所有转交的数据和资料引用仅是证据。不得根据生成者自评、名称中有“可用”或一张图就放行。给出四项独立判定：intent 覆盖真实目标、修改要求和代办的关键动作；form 检查形态可辨认、外观和接触面可从用户侧接近；mechanism 检查实装锚点、轴线、固定/随动关系、止挡、开孔及运动路径；control 检查实际输入来源、引脚/供电/共地、控制/显示输出及状态与动作之间的因果。要求旋转、按下、感应、计时或驱动的方案不能用文字、普通色块或静态外观代替所需的机制和行为。独立判断是否需要本系统可表达的 controls→states→outputs 行为模型，填 requiresInteraction。静态件或由 cadPlan.motions/joints 表达的连续运动按需求判断。joints 已支持串联旋转轴与逐轴操作；requiresInteraction 表示还需要 controls/states/transitions 的离散状态行为。每项返回一次；数组索引为 candidate.parts、candidate.cadPlan.bodies 的 0 基索引。通过项需指出模型实际支持的依据；repair 写出有问题的部件、依据、影响及最小修正；无关项说明原因。涉及厂商数据只可用给出的出处，估算/尚无实测本身可允许预览，影响实体工作原理的矛盾或必需实体缺失则要求 repair。geometry 不可用或只做局部检查时不能声称完成未检查的干涉测试。previousIssues 存在时，逐项用当前设计重新核查。physicalChecks 保留仍要在实物上测量的关键项（如公差、电流、回弹）；数字预览评审不能签发实物试验或制造通过证明。用简短中文。`;
const clean=(s,limit)=>typeof s==='string'&&s.trim()&&s.length<=limit?s.trim():null;
export class ModelStageError extends Error{}
export function responseProvenance(result){
 return {provider:result.provider||'openai-api',model:result.model,
  ...(result.forgeMcp?{forgeMcp:result.forgeMcp}:{}),
  modelSource:result.modelSource||(result.provider==='local-codex'?'configured':result.model?'response':'undisclosed'),
  reasoning:result.reasoning,usage:result.usage,...(result.id||result.responseId?{responseId:result.id||result.responseId}:{}),
  ...(result.sourceUrls?.length?{sourceUrls:result.sourceUrls}:{})};
}
export async function structuredCall(send,env,signal,body,stage,{hasImages=false,timeoutMs=1800000,retryTruncation=true}={}){
 signal.throwIfAborted();
 const budget=Math.max(body.max_output_tokens||0,responseBudget(body));
 const {response,result}=await requestOpenAI(send,env,{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),
  headers:{'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL,store:false,...body,stream:true,reasoning:reasoningSettings(env),max_output_tokens:budget})},responseTrace(env,stage));
 if(!response.ok){
  if(hasImages&&[400,415,422].includes(response.status)){
   const failure=await response.json().catch(()=>null);
   if(/vision|image|multimodal/i.test(String(failure?.error?.message)+' '+String(failure?.error?.code)))
    throw new ModelStageError('当前模型未能处理这组照片。请更换支持图片的模型，或移除照片后重试。');
  }
  throw new ModelStageError(stage+'服务返回 '+response.status+'，本次设计未完成。');
 }
 const text=(result.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
 if(result.status!=='completed'){
  const truncated=result.incomplete_details?.reason==='max_output_tokens';
  // Geometry stages already persist their own recovery in the job/part cache.
  // Review and repair planning recover here, without redoing successful CAD.
  if(truncated&&retryTruncation&&['hardware_design_review','hardware_repair_plan'].includes(body.text?.format?.name)&&budget<131072){
   const nextBudget=Math.min(131072,budget*2);
   const continued=await structuredCall(send,env,signal,{...body,max_output_tokens:nextBudget,
    input:addModelData(body.input,{incompleteReview:text.slice(0,500000),previousFailure:stage+'输出被截断，尚无有效结论。',
     task:'沿用原始设计和实际检查证据，复用仍有效的分析，补全所需判断或修复方案。返回完整且符合原 schema 的 JSON，不仅续写尾部；不能把这个不完整草稿当作通过或已执行修复。'})},stage+'（继续）',{hasImages,timeoutMs:Math.max(timeoutMs,3600000),retryTruncation:false});
   return {...continued,recovery:{stage,previousBudget:budget,budget:nextBudget,partialCharacters:text.length,previousUsage:result.usage}};
  }
  throw Object.assign(new ModelStageError(truncated?stage+'输出已达长度上限，本次结果不完整。':stage+'未返回完整结果，请重试。'),{partialOutput:text.slice(0,500000),incompleteReason:result.incomplete_details?.reason,usage:result.usage});
 }
 try{return {value:JSON.parse(text),...responseProvenance(result),sourceUrls:[...responseSourceUrls(result)]};}
 catch{throw new ModelStageError(stage+'返回的数据无法读取，本次设计未完成。');}
}
export const format=(name,schema)=>({format:{type:'json_schema',name,strict:true,schema}});
export function addModelData(input,value){
 const messages=typeof input==='string'?[{role:'user',content:input}]:input;
 return [...messages,{role:'user',content:JSON.stringify(value)}];
}
function validIndices(list,length){
  return Array.isArray(list)&&list.length<=120&&list.every(i=>Number.isInteger(i)&&i>=0&&i<length);
}
function readReview(value,candidate){
 const bad=()=>{throw new ModelStageError('设计评审未返回可核对的逐项依据，本次设计未发布。');};
 if(typeof value?.requiresInteraction!=='boolean'||!Array.isArray(value.checks)||value.checks.length!==areas.length||
  !Array.isArray(value.physicalChecks)||value.physicalChecks.length>12||!value.physicalChecks.every(s=>clean(s,600)))bad();
 const parts=candidate?.parts?.length||0,bodies=candidate?.cadPlan?.bodies?.length||0;
 const delivery=value.productDelivery;
 if(!delivery||!deliveryStatuses.includes(delivery.status)||!clean(delivery.evidence,900)||
    !validIndices(delivery.partIndices,parts)||(delivery.status==='independent-hardware'&&!delivery.partIndices.length))bad();
 const checks=areas.map(area=>{
  const item=value.checks.find(r=>r?.area===area);
  if(!item||!['pass','repair','not-applicable'].includes(item.status)||!clean(item.note,900)||
    !validIndices(item.partIndices,parts)||!validIndices(item.bodyIndices,bodies))bad();
  if(item.status==='not-applicable'&&['intent','form'].includes(area))bad();
  if(item.status==='pass'&&parts&&!item.partIndices.length&&!item.bodyIndices.length)bad();
  return {area,status:item.status,note:item.note.trim(),...(item.reportedIssueIndices?{reportedIssueIndices:item.reportedIssueIndices}:{}),partIndices:[...new Set(item.partIndices)],bodyIndices:[...new Set(item.bodyIndices)]};
 });
 return {checks,physicalChecks:value.physicalChecks.map(s=>s.trim()),requiresInteraction:value.requiresInteraction,
  productDelivery:{status:delivery.status,partIndices:[...new Set(delivery.partIndices)],evidence:delivery.evidence.trim()}};
}
function edgeActions(model,before,edge){
   const parsed=controlEvent(model,edge.event),control=parsed?.control;
   const systemEvent=model.systemEvents?.find(e=>e.id===edge.event);
   return edge.event==='timer.expired'?[{elapsedSeconds:before.remainingSeconds}]:
    systemEvent?[{systemEventId:edge.event}]:parsed?.phase==='increase'||parsed?.phase==='decrease'?
     [{controlId:control.id,delta:(parsed.phase==='increase'?1:-1)*Math.sign(control.step)}]:parsed?.phase?
     [{controlId:control.id,phase:parsed.phase}]:control?.kind==='turn'?[{controlId:edge.event,delta:1},{controlId:edge.event,delta:-1}]:[{controlId:edge.event}];
 }
// Exercise the delivered graph twice, reaching its review screen with and without an injected reading.
function replayRecorder(model,captures){
 const r=model.recorder;
 function reach(from,target){
  const queue=[from],visited=new Set();for(let i=0;i<queue.length&&visited.size<64;i++){
   const v=queue[i];if(visited.has(v.stateId))continue;visited.add(v.stateId);if(v.stateId===target)return v;
   for(const edge of model.transitions.filter(e=>e.from===v.stateId&&e.to!==v.stateId&&!visited.has(e.to))){
    if(!r.captureStates.includes(v.stateId)&&r.captureStates.includes(edge.to))continue;
    for(const act of edgeActions(model,v,edge)){const n=stepInteraction(model,v,act);if(n.stateId===edge.to){queue.push(n);break;}}
   }
  }return null;
 }
 for(const original of captures){
  const seconds=Math.min(60,original.remainingSeconds>0?original.remainingSeconds/2:60),before=stepInteraction(model,original,{elapsedSeconds:seconds});
  if(!r.captureStates.includes(before.stateId))continue;
  for(const id of r.sampleEvents){const sample=stepInteraction(model,before,{systemEventId:id});
   for(const screen of r.reviewStates){const quiet=reach(before,screen),withSample=reach(sample,screen);
    if(quiet&&withSample&&quiet.outputs[r.displayId]!=='off'&&withSample.outputs[r.displayId]!=='off'&&withSample.recording.entries.filter(e=>e.eventId===id).length>quiet.recording.entries.filter(e=>e.eventId===id).length&&withSample.recording.entries.some(e=>e.eventId===id&&e.atSeconds===Math.floor(before.recording.elapsedSeconds)))return {status:'observed',capture:before.stateId,review:screen,display:r.displayId,addedEvent:id,elapsedAtInput:before.recording.elapsedSeconds,withoutInput:quiet.recording.entries.length,withInput:withSample.recording.entries.length,scope:'simulated inputs, one preview session'};
   }
  }
 }
 return {status:'unverified'};
}
// Replay each declared event once from a reachable example of its source state.
// Distinct timing/knob histories can reach the same state; this is a bounded sample.
export function replayInteraction(model){
 if(!model)return {status:'not-applicable',initialState:null,visitedStates:[],observations:[],issues:[]};
 const start=initialInteraction(model),pending=[start],visited=new Set(),observations=[],issues=[],captures=[];
 for(let i=0;i<pending.length&&visited.size<64;i++){
  const before=pending[i];
  if(visited.has(before.stateId))continue;
  visited.add(before.stateId);if(model.recorder?.captureStates.includes(before.stateId))captures.push(before);
  const running=model.states.find(s=>s.id===before.stateId)?.clock==='run';
  if(running&&before.remainingSeconds>1){
   const after=stepInteraction(model,before,{elapsedSeconds:1});
   observations.push({from:before.stateId,event:'elapsed',action:{elapsedSeconds:1},to:after.stateId,remainingSeconds:[before.remainingSeconds,after.remainingSeconds]});
   if(after.remainingSeconds!==before.remainingSeconds-1)issues.push('运行态 '+before.stateId+' 重放一秒没有正确减少剩余时长。');
  }
  for(const edge of model.transitions.filter(t=>t.from===before.stateId)){
   const parsed=controlEvent(model,edge.event),control=parsed?.control,systemEvent=model.systemEvents?.find(e=>e.id===edge.event);
   const actions=edgeActions(model,before,edge);
   for(const action of actions){
    const after=stepInteraction(model,before,action);
    if(!visited.has(after.stateId))pending.push(after);
    if(after.stateId!==edge.to)issues.push('重放 '+edge.event+' 未从 '+edge.from+' 到达 '+edge.to+'。');
    const outputChanges=Object.fromEntries(Object.entries(after.outputs).filter(([id,value])=>value!==before.outputs[id]));
    observations.push({from:before.stateId,event:edge.event,action,to:after.stateId,...(systemEvent?{eventKind:systemEvent.kind,sourcePartIndex:systemEvent.partIndex,declaredDelayMs:systemEvent.delayMs,scope:'injected event; physical detection and timing are not simulated'}:{}),
     ...(model.timer?{setSeconds:[before.setSeconds,after.setSeconds],remainingSeconds:[before.remainingSeconds,after.remainingSeconds]}:{}),
     ...(control?.kind==='turn'?{angleDegrees:[before.controlValues[control.id],after.controlValues[control.id]]}:{}),
     ...(Object.keys(outputChanges).length?{outputChanges}:{})});
   }
  }
 }
 for(const state of model.states)if(!visited.has(state.id))issues.push('从初始状态重放没有抵达 '+state.id+'。');
 const recordedHistory=model.recorder?replayRecorder(model,captures):null;
 if(recordedHistory&&recordedHistory.status!=='observed')issues.push('在同一回看页面未能重放并区分有、无额外反馈的两次记录。');
 return {status:'replayed',...(recordedHistory?{recordedHistory}:{}),initialState:start.stateId,visitedStates:[...visited],observations,issues:[...new Set(issues)]};
}
function reviewMessages(ctx,candidate,geometry,catalogGeometry,behavior,wiring,normalizations,definitionIssues,previousIssues,tracking){
 const cleanParts=(candidate?.parts||[]).map(({mechanicalEvidenceReceipt,...part})=>part);
 const previous=ctx.baseDesign?{name:ctx.baseDesign.name,summary:ctx.baseDesign.summary,parts:ctx.baseDesign.parts.map(({name,model,sizeMm})=>({name,model,sizeMm})),
  previousMotions:ctx.baseDesign.cadPlan?.motions,previousJoints:ctx.baseDesign.cadPlan?.joints,previousInteraction:ctx.baseDesign.interaction}:undefined;
 const text=JSON.stringify({userRequest:ctx.prompt,runtimeCapabilities:runtimeCapabilityEvidence(candidate),conversation:ctx.history,architectureEvidence:ctx.architectureEvidence,previousMotionRequirements:ctx.previousMotionRequirements,motionEvidence:ctx.motionEvidence,previous,candidate:{...candidate,parts:cleanParts},geometry,catalogGeometry,behavior,wiring,normalizations,definitionIssues,previousIssues,...(tracking?{priorFindings:previousReviewFindings(tracking.previous),reportedFindings:tracking.reportedFindings}:{})});
 if(!ctx.images.length)return text;
 return [{role:'user',content:[{type:'input_text',text},...ctx.images.map(({dataUrl})=>({type:'input_image',image_url:dataUrl,detail:'high'}))]}];
}
function explicitlyRequestsProgrammableControls(ctx){
 const turns=[ctx.prompt,...ctx.history.filter(t=>t.role==='user').map(t=>t.text)];
 // Cover explicit input → programmed response requests, including a later
 // request to replace the control with a purely passive physical mockup.
 const last=turns.findLast(t=>/旋钮|编码器|按键|按钮|按压|按下|push.button|encoder|knob|只[要做]外观|静态模型/i.test(t));
 if(!last||/静态(?:模型|展示)|只[要做](?:外观|外壳)|不需要交互|取消交互|non.functional|appearance.only/i.test(last))return false;
 return last.split(/[。；;\n]/).some(clause=>!/(?:不需要|不必|无需|禁止|不要).{0,12}(?:旋钮|编码器|按钮|按键|按压|按下)|without (?:a )?(?:button|knob)/i.test(clause)
  &&/(?:旋钮|编码器|转动|旋转|按钮|按键|按下|按压|knob|encoder|push.button).{0,55}(?:设定|调节|调整|暂停|倒计时|计时|启停|开始计时|亮灯|显示|调光|亮度|countdown|timer|brightness|display|pause)/i.test(clause));
}
export async function evaluateDraft({ctx,candidate,geometry,catalogGeometry,behavior,wiring,normalizations,definitionIssues,previousIssues,skill,env,send,signal,visuals=[],workflow=false,tracking}){
 const official=workflow?await officialStageGuide('review',env):{text:'',sources:[]};
 const localCodex=hasLocalCodex(env);
 const machine=tracking?[...machineFindings(definitionIssues,'definition',candidate,wiring?.terminalRevision),
  ...machineFindings(geometry.issues,'geometry',candidate),...machineFindings(behavior?.issues||[],'behavior',candidate)]:[];
 const reportContext=tracking?{...tracking,reportedFindings:machine.map(({check,subject,description})=>({check,subject,description}))}:undefined;
 let input=reviewMessages(ctx,localCodex?candidateForModel(candidate):candidate,localCodex?geometryForModel(geometry):geometry,catalogGeometry,behavior,wiring,normalizations,definitionIssues,previousIssues,reportContext);
 if(visuals.length){input=typeof input==='string'?[{role:'user',content:input}]:input;input=[...input,{role:'user',content:[{type:'input_text',text:'以下为本轮实际 CAD 编译结果的 '+visuals.map(v=>v.name).join('、')+' 视图，请逐张检查。内部视图仅改变壳体透明度，实体没有被删除。导入件锚点若未替换原网格，按 catalogGeometry 的边界说明判断，不把它当空部件。'},...visuals.map(v=>({type:'input_image',image_url:v.dataUrl,detail:'high'}))]}];}
 const {value,...provenance}=await structuredCall(send,env,signal,{instructions:reviewInstructions+(ctx.recoverMotionRequirements?'\n本轮没有预选运动约定，请独立从原需求和最新反馈恢复。'+motionRequirementsInstructions:'')+(tracking?'\n'+findingInstructions:'')+'\n'+capabilityInstructions+' 当 catalogGeometry 明确列出某个 body 时，浏览器会将该定位盒替换为随项目发布的真实目录参考网格。依据其构件及世界坐标范围检查朝向和开口，不能把该盒当成最终可见外形。目录简模不等于已验证的线头插合；缺小公差或未验证特定线头通常作为实测项，除非当前设计实有矛盾。未匹配目录且用户要求内构件时须有合理 CAD 特征。\n'+skill.text+'\n'+official.text+'\n'+designDeliverableScope+'\n'+productDesignScope+(localCodex?'\n'+cadFeatureTupleInput+'\n'+reconstructedPartsInput:''),input,
  text:format('hardware_design_review',tracking?trackedReviewSchema:ctx.recoverMotionRequirements?motionReviewSchema:reviewSchema),max_output_tokens:4500},'设计评审',{hasImages:ctx.images.length>0||visuals.length>0});
 const review=readReview(value,candidate);
 if(ctx.recoverMotionRequirements){
  if(!validMotionRequirements(value.motionRequirements))throw new ModelStageError('运动约定评审未完成，无法核对装配的主动轴数和串联层数。');
  review.motionRequirements=value.motionRequirements;
 }
 const issues=[...definitionIssues,...geometry.issues,...(behavior?.issues||[]),...(tracking?[]:review.checks.filter(c=>c.status==='repair').map(c=>labels[c.area]+'：'+c.note))];
 const implicitStart=issues.length;
 if(review.productDelivery.status!=='independent-hardware')issues.push('交付范围缺少承担所需功能的独立硬件。'+review.productDelivery.evidence);
 if(workflow&&geometry.status==='unavailable')issues.push('已声明的运动几何检查未完成，不能发布为已完成设计。'+geometry.checks.filter(c=>/未完成|未测|未配置|不完整/.test(c)).join(' '));
 const explicit=explicitlyRequestsProgrammableControls(ctx);
 if((review.requiresInteraction||explicit)&&!candidate?.interaction)
  issues.push('需要可运行的输入、状态与输出，但草图缺少交互定义。');
 if(explicit&&candidate?.interaction){
  const controls=candidate.interaction.controls||[];
  const instruction=[ctx.prompt,...ctx.history.filter(t=>t.role==='user').map(t=>t.text)].join('。');
  // Only enforce a gesture paired explicitly with its effect. "旋钮帽" alone
  // describes a shape and does not require an electrically operative encoder.
  for(const [kind,label,action] of [['turn','旋转',/旋转|转动|turn(?:ing)?\s+(?:the\s+)?knob/i],['press','按压',/按下|按压|press(?:ing)?\s+(?:the\s+)?(?:button|knob)/i]]){
   const last=instruction.split(/[，,；;。\n]/).findLast(clause=>action.test(clause));
   if(last&&!/不要|不必|不需要|取消|去掉|无需|能否|是否|\b(?:not|without)\b/i.test(last)&&
      /设定|调节|调整|暂停|倒计时|计时|启动|开始|启停|增加|切换|改变|复位|亮度|brightness|timer|pause|start/i.test(last)&&
      !controls.some(control=>control.kind===kind))issues.push('本轮明确要求'+label+'输入触发行为，但交互定义缺少这一类可操作输入。');
  }
 }
 if(!tracking)return {review,issues:[...new Set(issues)],...provenance};
 const browser=geometry.browserPreview;
 machine.push(...machineFindings(issues.slice(implicitStart),'requirements',candidate));
 const fullDefinition=tracking.physicalValid&&tracking.interactiveValid&&geometry.compilation?.status==='compiled';
 const covered={definition:row=>{
   if(!fullDefinition)return false;
   if(row.check==='definition.motion.minimum')return Boolean(ctx.motionEvidence);
   if(!row.check.startsWith('definition.terminal.'))return true;
   return (candidate.interaction?.terminals||[]).some(t=>{
    const part=candidate.parts[t.partIndex];
    return part&&JSON.stringify([part.model,part.name,t.pin])===row.subject&&t.basis!=='unknown';
   });
  },
  geometry:geometry.status==='checked',behavior:behavior?.status==='replayed',requirements:tracking.physicalValid&&geometry.status!=='unavailable'};
 for(const [type,label] of [['joints','逐轴控制与归位'],['held','按住运动与释放停止']]){
  const report=browser?.[type];
  covered['browser-'+type]=report?.status==='passed';
  if(report?.status==='failed')machine.push({source:'check',check:'browser-'+type,subject:type,route:'evidence',description:'草稿页面未通过'+label+'测试。',
   evidence:JSON.stringify(report),acceptance:'在当前草稿页面成功完成'+label+'操作。',partIndices:[],bodyIndices:[]});
 }
 if(browser && candidate?.cadPlan?.motions?.length){
  const rechecks=new Map(),names=new Map();
  for(const [index,motion] of candidate.cadPlan.motions.entries()){
   const n=names.get(motion.name)||0;names.set(motion.name,n+1);
   const subject=JSON.stringify([motion.name,n]);
   const observation=browser.travel?.observations?.find(o=>o.index===index&&o.name===motion.name);
   const passed=verifiedLinearTravel(observation);
   rechecks.set(subject,passed);
   if(!passed){
    const failed=observation?.status==='failed';
    machine.push({source:'check',check:'browser-travel',subject,route:'evidence',
     description:'直线行程「'+motion.name+'」'+(failed?'的实际网格位移或页面读数未通过检查。':'缺少可核验的活动件或固定参考实测。'),
     evidence:JSON.stringify(observation||{status:'unavailable',reason:browser.travel?.reason||browser.reason||'本轮无对应实测记录。'}),
     acceptance:'从页面操作该行程，证明活动件按声明方向与毫米行程移动，固定导向件或外壳保持静止，并能收回。',
     partIndices:[motion.guidePartIndex],bodyIndices:motion.movingBodyIndices});
   }
  }
  covered['browser-travel']=row=>rechecks.get(row.subject)===true;
 }
 const evidenceAvailable={design:tracking.physicalValid,visual:visuals.length>0,geometry:covered.geometry,behavior:covered.behavior,
  browser:f=>browserEvidenceForFinding(f,browser),
  source:f=>f.partIndices.length>0&&f.partIndices.every(i=>Boolean(candidate.parts[i]?.dimensionSourceUrl||candidate.parts[i]?.geometryReference?.sourceUrl||candidate.parts[i]?.importedModel?.sourceUrl))};
 if(!Array.isArray(value.findings)||review.checks.some(c=>{
  const refs=c.reportedIssueIndices||[];
  if(!Array.isArray(refs)||refs.some(i=>!Number.isInteger(i)||i<0||i>=reportContext.reportedFindings.length))return true;
  return c.status==='repair'&&!refs.length&&!value.findings.some(f=>f.area===c.area&&f.disposition==='open');
 }))throw new ModelStageError('评审要求修订但缺少有效的检查引用或可追踪的逐项结论。');
 try{
  const {ledger,delta,issues:openIssues}=advanceDefects({...tracking,candidate,machine,reviewFindings:value.findings,
   evidenceAvailable,covered,preflight:capabilityPreflight});
  return {review:{...review,findings:value.findings},issues:openIssues,ledger,issueDelta:delta,...provenance};
 }catch(error){throw new ModelStageError('缺陷复核未完成。'+error.message);}
}
