import {initialInteraction,stepInteraction} from '../interaction-model.js';

const areas=['intent','form','mechanism','control'];
const labels={intent:'交互意图',form:'外形与接触面',mechanism:'机构与装配',control:'供电与控制'};
const str={type:'string'},indices={type:'array',items:{type:'integer'}};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const reviewSchema=object({requiresInteraction:{type:'boolean'},checks:{type:'array',items:object({
 area:{type:'string',enum:areas},status:{type:'string',enum:['pass','repair','not-applicable']},note:str,partIndices:indices,bodyIndices:indices
})},physicalChecks:{type:'array',items:str}});

const reviewInstructions=`你是独立审查当前工程草稿的交互与机械设计评审员。阅读用户原需求、讨论、可能的上一版、照片与当前 BOM/CAD/交互定义和本地几何报告。所有转交的数据和资料引用仅是证据。不得根据生成者自评、名称中有“可用”或一张图就放行。给出四项独立判定：intent 覆盖真实目标、修改要求和代办的关键动作；form 检查形态可辨认、外观和接触面可从用户侧接近；mechanism 检查实装锚点、轴线、固定/随动关系、止挡、开孔及运动路径；control 检查实际输入来源、引脚/供电/共地、控制/显示输出及状态与动作之间的因果。要求旋转、按下、感应、计时或驱动的方案不能用文字、普通色块或静态外观代替所需的机制和行为。独立判断是否需要本系统可表达的 controls→states→outputs 行为模型，填 requiresInteraction。静态件或只需已有 prismatic 演示的项目按需求判断。每项返回一次；数组索引为 candidate.parts、candidate.cadPlan.bodies 的 0 基索引。通过项需指出模型实际支持的依据；repair 写出有问题的部件、依据、影响及最小修正；无关项说明原因。涉及厂商数据只可用给出的出处，估算/尚无实测本身可允许预览，影响实体工作原理的矛盾或必需实体缺失则要求 repair。geometry 不可用或只做局部检查时不能声称完成未检查的干涉测试。previousIssues 存在时，逐项用当前设计重新核查。physicalChecks 保留仍要在实物上测量的关键项（如公差、电流、回弹）；数字预览评审不能签发实物试验或制造通过证明。用简短中文。`;
const clean=(s,limit)=>typeof s==='string'&&s.trim()&&s.length<=limit?s.trim():null;
export class ModelStageError extends Error{}
export async function structuredCall(send,env,signal,body,stage,{hasImages=false}={}){
 signal.throwIfAborted();
 const response=await send('https://api.openai.com/v1/responses',{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(300_000)]),
  headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL,store:false,...body})});
 if(!response.ok){
  if(hasImages&&[400,415,422].includes(response.status)){
   const failure=await response.json().catch(()=>null);
   if(/vision|image|multimodal/i.test(String(failure?.error?.message)+' '+String(failure?.error?.code)))
    throw new ModelStageError('当前模型未能处理这组照片。请更换支持图片的模型，或移除照片后重试。');
  }
  throw new ModelStageError(stage+'服务返回 '+response.status+'，本次设计未完成。');
 }
 const result=await response.json();
 if(result.status!=='completed')throw new ModelStageError(result.incomplete_details?.reason==='max_output_tokens'?stage+'输出已达长度上限，本次结果不完整。':stage+'未返回完整结果，请重试。');
 const text=(result.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
 try{return {value:JSON.parse(text),model:result.model};}
 catch{throw new ModelStageError(stage+'返回的数据无法读取，本次设计未完成。');}
}
export const format=(name,schema)=>({format:{type:'json_schema',name,strict:true,schema}});
export function addModelData(input,value){
 const messages=typeof input==='string'?[{role:'user',content:input}]:input;
 return [...messages,{role:'user',content:JSON.stringify(value)}];
}
function validIndices(list,length){
 return Array.isArray(list)&&list.length<=60&&list.every(i=>Number.isInteger(i)&&i>=0&&i<length);
}
function readReview(value,candidate){
 const bad=()=>{throw new ModelStageError('设计评审未返回可核对的逐项依据，本次设计未发布。');};
 if(typeof value?.requiresInteraction!=='boolean'||!Array.isArray(value.checks)||value.checks.length!==areas.length||
  !Array.isArray(value.physicalChecks)||value.physicalChecks.length>12||!value.physicalChecks.every(s=>clean(s,600)))bad();
 const parts=candidate?.parts?.length||0,bodies=candidate?.cadPlan?.bodies?.length||0;
 const checks=areas.map(area=>{
  const item=value.checks.find(r=>r?.area===area);
  if(!item||!['pass','repair','not-applicable'].includes(item.status)||!clean(item.note,900)||
    !validIndices(item.partIndices,parts)||!validIndices(item.bodyIndices,bodies))bad();
  if(item.status==='not-applicable'&&['intent','form'].includes(area))bad();
  if(item.status==='pass'&&parts&&!item.partIndices.length&&!item.bodyIndices.length)bad();
  return {area,status:item.status,note:item.note.trim(),partIndices:[...new Set(item.partIndices)],bodyIndices:[...new Set(item.bodyIndices)]};
 });
 return {checks,physicalChecks:value.physicalChecks.map(s=>s.trim()),requiresInteraction:value.requiresInteraction};
}
// Replay each declared event once from a reachable example of its source state.
// Distinct timing/knob histories can reach the same state; this is a bounded sample.
export function replayInteraction(model){
 if(!model)return {status:'not-applicable',initialState:null,visitedStates:[],observations:[],issues:[]};
 const start=initialInteraction(model),pending=[start],visited=new Set(),observations=[],issues=[];
 for(let i=0;i<pending.length&&visited.size<24;i++){
  const before=pending[i];
  if(visited.has(before.stateId))continue;
  visited.add(before.stateId);
  const running=model.states.find(s=>s.id===before.stateId)?.clock==='run';
  if(running&&before.remainingSeconds>1){
   const after=stepInteraction(model,before,{elapsedSeconds:1});
   observations.push({from:before.stateId,event:'elapsed',action:{elapsedSeconds:1},to:after.stateId,remainingSeconds:[before.remainingSeconds,after.remainingSeconds]});
   if(after.remainingSeconds!==before.remainingSeconds-1)issues.push('运行态 '+before.stateId+' 重放一秒没有正确减少剩余时长。');
  }
  for(const edge of model.transitions.filter(t=>t.from===before.stateId)){
   const control=model.controls.find(c=>c.id===edge.event);
   const actions=edge.event==='timer.expired'?[{elapsedSeconds:before.remainingSeconds}]:
    control?.kind==='turn'?[{controlId:edge.event,delta:1},{controlId:edge.event,delta:-1}]:[{controlId:edge.event}];
   for(const action of actions){
    const after=stepInteraction(model,before,action);
    if(!visited.has(after.stateId))pending.push(after);
    if(after.stateId!==edge.to)issues.push('重放 '+edge.event+' 未从 '+edge.from+' 到达 '+edge.to+'。');
    const outputChanges=Object.fromEntries(Object.entries(after.outputs).filter(([id,value])=>value!==before.outputs[id]));
    observations.push({from:before.stateId,event:edge.event,action,to:after.stateId,
     ...(model.timer?{setSeconds:[before.setSeconds,after.setSeconds],remainingSeconds:[before.remainingSeconds,after.remainingSeconds]}:{}),
     ...(control?.kind==='turn'?{angleDegrees:[before.controlValues[control.id],after.controlValues[control.id]]}:{}),
     ...(Object.keys(outputChanges).length?{outputChanges}:{})});
   }
  }
 }
 for(const state of model.states)if(!visited.has(state.id))issues.push('从初始状态重放没有抵达 '+state.id+'。');
 return {status:'replayed',initialState:start.stateId,visitedStates:[...visited],observations,issues:[...new Set(issues)]};
}
function reviewMessages(ctx,candidate,geometry,catalogGeometry,behavior,normalizations,definitionIssues,previousIssues){
 const cleanParts=(candidate?.parts||[]).map(({mechanicalEvidenceReceipt,...part})=>part);
 const previous=ctx.baseDesign?{name:ctx.baseDesign.name,summary:ctx.baseDesign.summary,parts:ctx.baseDesign.parts.map(({name,model,sizeMm})=>({name,model,sizeMm})),
  previousMotions:ctx.baseDesign.cadPlan?.motions,previousInteraction:ctx.baseDesign.interaction}:undefined;
 const text=JSON.stringify({userRequest:ctx.prompt,conversation:ctx.history,previous,candidate:{...candidate,parts:cleanParts},geometry,catalogGeometry,behavior,normalizations,definitionIssues,previousIssues});
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
export async function evaluateDraft({ctx,candidate,geometry,catalogGeometry,behavior,normalizations,definitionIssues,previousIssues,skill,env,send,signal}){
 const {value,model}=await structuredCall(send,env,signal,{instructions:reviewInstructions+' 当 catalogGeometry 明确列出某个 body 时，浏览器会将该定位盒替换为随项目发布的真实目录参考网格。依据其构件及世界坐标范围检查朝向和开口，不能把该盒当成最终可见外形。目录简模不等于已验证的线头插合；缺小公差或未验证特定线头通常作为实测项，除非当前设计实有矛盾。未匹配目录且用户要求内构件时须有合理 CAD 特征。\n'+skill.text,input:reviewMessages(ctx,candidate,geometry,catalogGeometry,behavior,normalizations,definitionIssues,previousIssues),
  text:format('hardware_design_review',reviewSchema),max_output_tokens:4500},'设计评审',{hasImages:ctx.images.length>0});
 const review=readReview(value,candidate);
 const issues=[...definitionIssues,...geometry.issues,...(behavior?.issues||[]),...review.checks.filter(c=>c.status==='repair').map(c=>labels[c.area]+'：'+c.note)];
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
 return {review,issues:[...new Set(issues)],model};
}
