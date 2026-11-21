import {validateCadPlan} from '../cad-plan.js';

export const maxDesignRequestBytes=1_048_576;
const encoder=new TextEncoder();
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

export class DesignInputError extends Error{
 constructor(message,status=400){super(message);this.status=status;}
}

function previousDesign(raw){
 if(!isObject(raw)||!nonempty(raw.name,200)||!nonempty(raw.summary,5000)||
    !Array.isArray(raw.parts)||!raw.parts.length||raw.parts.length>60||
    !Array.isArray(raw.steps)||raw.steps.length>60||!raw.steps.every(step=>nonempty(step,2000)))
  throw new DesignInputError('上一版设计的名称、简介、零件或步骤无效。');
 const parts=raw.parts.map((part,index)=>{
  if(!isObject(part)||!nonempty(part.name,200)||!Number.isInteger(part.qty)||part.qty<1||part.qty>999)
   throw new DesignInputError('上一版设计的第 '+(index+1)+' 个零件缺少有效的名称或数量。');
  const result={name:part.name,qty:part.qty};
  for(const [field,max] of Object.entries({spec:800,model:240,modelId:200,role:24,purpose:500,placement:12,shape:24,dimensionSource:20,dimensionNote:900,dimensionQuote:500,dimensionSourceUrl:4096})){
   if(part[field]==null)continue;
   if(typeof part[field]!=='string'||part[field].length>max)throw new DesignInputError('上一版零件信息无效。');
   result[field]=part[field];
  }
  if(part.sizeMm!=null){
   if(!Array.isArray(part.sizeMm)||part.sizeMm.length!==3||!part.sizeMm.every(v=>Number.isFinite(v)&&v>0&&v<=10000))
    throw new DesignInputError('上一版零件的三维尺寸无效。');
   result.sizeMm=part.sizeMm;
  }
  if(part.modelSourceInvalidated===true)result.modelSourceInvalidated=true;
  return result;
 });
 const base={name:raw.name,summary:raw.summary,parts,steps:raw.steps};
 if(raw.deviceMotion!=null){
  if(!['stationary','powered-linear','other'].includes(raw.deviceMotion))throw new DesignInputError('上一版设计的动作类型无效。');
  base.deviceMotion=raw.deviceMotion;
 }
 if(raw.cadPlan!=null){
  try{base.cadPlan=validateCadPlan(raw.cadPlan,parts.length);}
  catch{throw new DesignInputError('上一版设计的 CAD 方案无效。');}
 }
 return base;
}

export async function readDesignRequest(request){
 if(Number(request.headers.get('content-length'))>maxDesignRequestBytes)throw new DesignInputError('设计与讨论记录超过本次请求上限。',413);
 const text=await request.text();
 if(encoder.encode(text).length>maxDesignRequestBytes)throw new DesignInputError('设计与讨论记录超过本次请求上限。',413);
 let body;
 try{body=JSON.parse(text);}catch{throw new DesignInputError('设计请求需要有效的 JSON。');}
 if(!isObject(body)||!nonempty(body.prompt,10000))throw new DesignInputError('设计说明须在 1–10000 字之间。');
 const {prompt,action='generate',conversation=[],discussionStart=0}=body;
 if(action!=='discuss'&&action!=='generate')throw new DesignInputError('未知的设计操作。');
 if(!Array.isArray(conversation)||conversation.length>200||!conversation.every(turn=>
   isObject(turn)&&['user','assistant'].includes(turn.role)&&nonempty(turn.text,10000)))
  throw new DesignInputError('讨论记录须包含有效的用户或设计师发言。');
 const history=conversation.map(({role,text})=>({role,text:text.trim()}));
 if(history.reduce((total,turn)=>total+turn.text.length,0)>100_000)
  throw new DesignInputError('讨论记录超过本次请求上限。',413);
 if(!Number.isInteger(discussionStart)||discussionStart<0||discussionStart>history.length)
  throw new DesignInputError('本轮讨论的起始位置无效。');
 return {action,prompt:prompt.trim(),history,discussionStart,baseDesign:body.baseDesign==null?null:previousDesign(body.baseDesign)};
}

export const ready=()=>({decision:'ready',question:'',options:[]});
export const discussionSchema={
 type:'object',additionalProperties:false,required:['decision','question','options'],
 properties:{decision:{type:'string',enum:['ask','ready']},question:{type:'string'},options:{type:'array',items:{type:'string'}}}
};
export const discussionInstructions=`你是与用户共同设计可触摸硬件的设计师。读原始需求、之前的提问回答、已有方案以及最新意见。判断现在是否可以着手生成或修改。用户可以随时直接开始，也可以随时改变之前的决定；后来明确的意见优先。
只有两种都合理、但会明显改变用户如何使用或体验成品的方向尚未确定时，才返回 ask。用自然中文只问一个普通使用者能回答的问题，可以给 0–3 个简短、彼此不同的具体选项，也允许自由回答。不要让使用者选电机型号、接线、制造流程。不要重问已回答或用户已交由你决定的问题。用户已经说清动作、交互方式或修改目标，或者希望先按目前设想试做时，返回 ready，question 留空，options 为空数组。这个阶段只讨论影响体验的选择。`;
export const revisionInstructions=`这是一项连续设计任务。按原始需求和历次讨论理解目标，后来明确的用户意见优先。助手提出的备选项并不代表用户已经选择。若给出 baseDesign，以上一版完整 BOM、实体、运动关系、毫米尺寸和装配位置为起点。对于局部修改，保留无关零件的型号、尺寸、位置、特征和顺序，仅更新相关实体和必要的关联部件；增删零件后校正所有 BOM/body 索引。modelSourceInvalidated=true 代表原有尺寸或型号后来变更，按当前值重新确定该件的 CAD。始终返回一份完整、相互一致的新版设计。用户给出的尺寸可引用原始需求或后续用户发言。`;

export function modelInput({prompt,history,discussionStart,baseDesign,action}){
 if(!history.length&&!baseDesign)return prompt;
 let base=baseDesign;
 if(base&&action==='discuss')base={name:base.name,summary:base.summary,parts:base.parts.map(({name,purpose,qty})=>({name,purpose,qty}))};
 return JSON.stringify({prompt,conversation:history,discussionStart,...(base?{baseDesign:base}:{})});
}

export function readDecision(value){
 if(value?.decision==='ready')return ready();
 if(value?.decision!=='ask'||!nonempty(value.question,600)||!Array.isArray(value.options)||value.options.length>3||
    !value.options.every(option=>nonempty(option,160)))throw Error('invalid clarification response');
 return {decision:'ask',question:value.question.trim(),options:[...new Set(value.options.map(option=>option.trim()))]};
}
