import {deviceMotionTypes,validMotionRequirements} from './design-architecture.mjs';
import {MAX_DESIGN_PARTS,validateCadPlan} from '../cad-plan.js';
import {validateInteraction} from '../interaction-model.js';
import {factoryInterfaces,hardwareReference,importedModel} from '../part-records.js';

export const maxDesignRequestBytes=2*1024*1024;
export const maxDesignSteps=80;
const encoder=new TextEncoder();
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

export class DesignInputError extends Error{
 constructor(message,status=400){super(message);this.status=status;}
}

function readImages(images=[]){
 if(!Array.isArray(images)||images.length>3)throw new DesignInputError('最多可附三张参考照片。');
 return images.map(image=>{
  const url=image?.dataUrl;
  if(typeof url!=='string'||url.length>Math.ceil(256*1024/3)*4+30)
   throw new DesignInputError('每张参考照片压缩后须小于 256 KB。');
  const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if(!match||match[2].length%4!==0)throw new DesignInputError('参考照片须为 JPEG、PNG 或 WebP 图片数据。');
  const encoded=match[2],padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
  if(encoded.length*3/4-padding>256*1024)throw new DesignInputError('每张参考照片压缩后须小于 256 KB。');
  const head=atob(match[2].slice(0,24));
  const valid=match[1]==='jpeg'?head.startsWith('\xff\xd8\xff'):
   match[1]==='png'?head.startsWith('\x89PNG\r\n\x1a\n'):head.startsWith('RIFF')&&head.slice(8,12)==='WEBP';
  if(!valid)throw new DesignInputError('参考照片的文件格式与内容不一致。');
  return {dataUrl:url};
 });
}

function previousDesign(raw){
 if(!isObject(raw)||!nonempty(raw.name,200)||!nonempty(raw.summary,5000)||
    !Array.isArray(raw.parts)||!raw.parts.length||raw.parts.length>MAX_DESIGN_PARTS||
    !Array.isArray(raw.steps)||raw.steps.length>maxDesignSteps||!raw.steps.every(step=>nonempty(step,2000)))
  throw new DesignInputError('上一版设计的名称、简介、零件或步骤无效。');
 const parts=raw.parts.map((part,index)=>{
  if(!isObject(part)||!nonempty(part.name,200)||!Number.isInteger(part.qty)||part.qty<1||part.qty>999)
   throw new DesignInputError('上一版设计的第 '+(index+1)+' 个零件缺少有效的名称或数量。');
  const result={name:part.name,qty:part.qty};
  for(const [field,max] of Object.entries({spec:800,model:240,modelId:200,kind:24,role:24,purpose:500,placement:12,shape:24,dimensionSource:20,dimensionNote:900,dimensionQuote:500,dimensionSourceUrl:4096})){
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
  const source=hardwareReference(part.hardwareReference),model=importedModel(part.importedModel,part);
  if(source&&!part.modelSourceInvalidated)result.hardwareReference=source;
  if(model)result.importedModel=model;
  if(nonempty(part.mechanicalEvidenceReceipt,8192))result.mechanicalEvidenceReceipt=part.mechanicalEvidenceReceipt;
  return result;
 });
 const base={name:raw.name,summary:raw.summary,parts,steps:raw.steps};
 if(raw.deviceMotion!=null){
  if(!deviceMotionTypes.includes(raw.deviceMotion))throw new DesignInputError('上一版设计的动作类型无效。');
  base.deviceMotion=raw.deviceMotion;
 }
 if(raw.cadPlan!=null){
  try{base.cadPlan=validateCadPlan(raw.cadPlan,parts.length);}
  catch{throw new DesignInputError('上一版设计的 CAD 方案无效。');}
 }
 if(raw.interaction!=null){
  // Check that the submitted history can be replayed. Client-side receipts
  // are deliberately kept out of the returned BOM and future sourcing.
  const previousParts=parts.map((part,i)=>({...part,sourcing:{factoryInterfaces:factoryInterfaces({...part,sourcing:raw.parts[i].sourcing})}}));
  try{base.interaction=validateInteraction(raw.interaction,{bom:previousParts,cadPlan:base.cadPlan});}
  catch{throw new DesignInputError('上一版交互定义与 BOM 或 CAD 不一致。');}
 }
 return base;
}

function readRepairCandidate(raw){
 if(raw==null)return null;
 if(!isObject(raw)||!isObject(raw.design)||!Array.isArray(raw.issues)||!raw.issues.length||raw.issues.length>12||
    !raw.issues.every(issue=>nonempty(issue,1500))||encoder.encode(JSON.stringify(raw)).length>512000)
  throw new DesignInputError('续修草稿或问题记录无效。');
 // The rejected interaction is inert input for the designer. Never start its runtime.
 const design=previousDesign({...raw.design,interaction:null});
 const model=raw.design.interaction;
 if(model!=null){
  if(!isObject(model)||encoder.encode(JSON.stringify(model)).length>160000)throw new DesignInputError('续修交互草稿格式无效。');
  design.interaction=Object.fromEntries(['version','controllerPartIndex','controls','systemEvents','outputs','connections','terminals','signalChannels','timer','recorder','initialState','states','transitions']
    .filter(k=>Object.hasOwn(model,k)).map(k=>[k,model[k]]));
 }
 return {design,issues:raw.issues.map(s=>s.trim())};
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
 const history=conversation.map(({role,text,topic,delegated})=>({role,text:text.trim(),
   ...(role==='assistant'&&['outcome','use'].includes(topic)?{topic}:{}),
   ...(role==='user'&&delegated===true?{delegated:true}:{})}));
 if(history.reduce((total,turn)=>total+turn.text.length,0)>100_000)
  throw new DesignInputError('讨论记录超过本次请求上限。',413);
 if(!Number.isInteger(discussionStart)||discussionStart<0||discussionStart>history.length)
  throw new DesignInputError('本轮讨论的起始位置无效。');
 const priorMinimum=body.baseDesign?.generation?.designReview?.motion?.required;
 return {action,prompt:prompt.trim(),history,discussionStart,...(validMotionRequirements(priorMinimum)?{previousMotionRequirements:priorMinimum}:{}),images:readImages(body.images),repairCandidate:readRepairCandidate(body.repairCandidate),baseDesign:body.baseDesign==null?null:previousDesign(body.baseDesign)};
}

export function pendingDesignQuestion({history,discussionStart}){
 const last=history.slice(discussionStart).at(-1);
 return last?.role==='assistant'?last.text:null;
}
export const answerBeforeStarting='请先在追问框回答，或选择由 AI 决定。';
export const revisionInstructions=`这是一项连续设计任务。按原始需求和历次讨论理解目标，后来明确的用户意见优先。助手提出的备选项并不代表用户已经选择。若给出 baseDesign，以上一版完整 BOM、实体、运动关系、毫米尺寸和装配位置为起点。对于局部修改，保留无关零件的型号、尺寸、位置、特征和顺序，仅更新相关实体和必要的关联部件；增删零件后校正所有 BOM/body 索引。modelSourceInvalidated=true 代表原有尺寸或型号后来变更，按当前值重新确定该件的 CAD。已有设计一律通过 hardware_design_revision 增量操作修改，不重新输出整份设计；后台应用操作后对完整新版重新验证，索引和关联关系必须一致。用户给出的尺寸可引用原始需求或后续用户发言。`;

export const photoInstructions='用户附上产品或标尺照片。用照片辨认外形、接口位置、安装朝向和相对比例。只有看得清刻度、测量平面且无明显透视误差时才可作粗略尺寸参考，并标为估算。仅将用户明确提供的尺寸作为指定尺寸。隐藏面、深度和公差没有依据时，在必要处询问或标明待核对。';
export function projectDesignForModel(base){
 return {...base,parts:base.parts.map(part=>{
  const {mechanicalEvidenceReceipt,...data}=part;
  // Manufacturer claims in a client-owned project are reintroduced through
  // validated evidence. The drawing and its existing design dimensions remain usable.
  if(data.dimensionSource==='datasheet'||(data.dimensionSource==='estimated'&&data.dimensionSourceUrl)){
   data.dimensionSource='estimated';delete data.dimensionSourceUrl;delete data.dimensionNote;
  }
  return data;
 })};
}
export function modelInput({prompt,history,discussionStart,baseDesign,action,images=[]}){
 let base=baseDesign;
 if(base&&action==='discuss')base={name:base.name,summary:base.summary,parts:base.parts.map(({name,purpose,qty})=>({name,purpose,qty}))};
 else if(base)base=projectDesignForModel(base);
 const text=!history.length&&!base?prompt:JSON.stringify({prompt,conversation:history,discussionStart,...(base?{baseDesign:base}:{})});
 if(!images.length)return text;
 return [{role:'user',content:[{type:'input_text',text},...images.map(({dataUrl})=>({type:'input_image',image_url:dataUrl,detail:'high'}))]}];
}
