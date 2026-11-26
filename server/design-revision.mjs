import {structuredCall,format,addModelData,ModelStageError} from './design-review.mjs';

// Every existing design is revised in place. Size does not decide whether
// previously correct geometry, part choices and references should be retained.
export const needsIncrementalRevision=base=>Boolean(base);
const schema={type:'object',additionalProperties:false,required:['summary','operations'],properties:{
 summary:{type:'string'},operations:{type:'array',items:{type:'object',additionalProperties:false,
  required:['op','path','valueJson'],properties:{op:{type:'string',enum:['add','replace','remove']},path:{type:'string'},valueJson:{type:['string','null']}}}
}}};
const guidance=`当前正在修订已有设计，必须返回 hardware_design_revision 增量操作，不重写整份设计；这同样适用于小项目、用户调整和评审后的自动修复。summary 简述修改及必要的关联影响；operations 是按顺序应用到 rejectedDraft 原始 JSON 的 JSON Pointer 操作。add/replace 的 valueJson 是要写入的有效 JSON 字符串（对象、数组、数字、字符串等）；remove 的 valueJson 为 null。路径如 /parts/3/sizeMm、/cadPlan/bodies/12/features、/cadPlan/bodies/-、/interaction。只写需要改变的字段，未受影响的部件型号、来源、尺寸、安装位置、几何和索引保持原样。新增数组项优先追加到 /-，保留已有索引；如插入、删除或重排，必须同时修正全部 BOM、body、关节、端子和交互引用。仅在该子系统确实整体受影响时 replace 整个子系统数组，并在 summary 说明理由；后台禁止整体替换、删除 /parts、/cadPlan、/cadPlan/bodies，必须定位到具体零件、实体或字段。修正所有列出的缺陷，不通过省略实例、改成 loose 或删掉必要能力来规避检查。上面的完整设计契约适用于应用修订之后的结果。后台复用未变部件的已存资料与独立模型，核对新增和受影响部件，并对完整结果重新编译、做几何和功能评审。操作应用失败时修正同一基线的操作，不退回全量重写。本次不是文字建议或评审通过声明，不返回代码，不假设系统会替你补全未写出的修改。`;

export function applyDesignRevision(base,revision){
 if(!base||typeof base!=='object'||!revision||typeof revision.summary!=='string'||!Array.isArray(revision.operations)||!revision.operations.length||revision.operations.length>512)
  throw Error('修订需要说明及 1–512 项操作。');
 const result=structuredClone(base);
 for(const [i,operation] of revision.operations.entries()){
  const fail=message=>{throw Error('operations['+i+'] '+message);};
  if(!operation||!['add','replace','remove'].includes(operation.op)||typeof operation.path!=='string'||!operation.path.startsWith('/')||operation.path.length>500)fail('操作或路径无效。');
  const path=operation.path.slice(1).split('/').map(part=>{
   if(/~(?![01])/u.test(part))fail('JSON Pointer 转义无效。');
   const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
   if(['__proto__','prototype','constructor'].includes(key))fail('路径包含保留名称。');
   return key;
  });
  let parent=result;
  for(const key of path.slice(0,-1)){
   if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))fail('父路径不存在：'+operation.path);
   parent=parent[key];
  }
  if(!parent||typeof parent!=='object')fail('目标不是对象或数组。');
  let value;
  if(operation.op==='remove'){if(operation.valueJson!==null)fail('remove 的 valueJson 必须为 null。');}
  else{
   if(typeof operation.valueJson!=='string')fail('valueJson 必须是 JSON 字符串。');
   try{value=JSON.parse(operation.valueJson);}catch{fail('valueJson 不是有效 JSON。');}
  }
  const key=path.at(-1);
  if(['/parts','/cadPlan','/cadPlan/bodies'].includes(operation.path)&&(operation.op!=='add'||Object.hasOwn(parent,key)))
   fail('不能整体替换或删除 BOM、CAD 或全部实体；请定位到需要调整的零件、实体或字段。');
  if(Array.isArray(parent)){
   const index=key==='-'&&operation.op==='add'?parent.length:/^(0|[1-9]\d*)$/.test(key)?Number(key):NaN;
   if(!Number.isSafeInteger(index)||index<0||index>(operation.op==='add'?parent.length:parent.length-1))fail('数组索引无效：'+operation.path);
   if(operation.op==='add')parent.splice(index,0,value);
   else if(operation.op==='remove')parent.splice(index,1);
   else parent[index]=value;
  }else{
   if(operation.op!=='add'&&!Object.hasOwn(parent,key))fail('目标字段不存在：'+operation.path);
   if(operation.op==='remove')delete parent[key];else parent[key]=value;
  }
 }
 return result;
}

export async function reviseAssembly(base,body,send,env,signal,{timeoutMs=3600000,hasImages=false}={}){
 let input=body.input;
 for(let attempt=1;attempt<=2;attempt++){
  const result=await structuredCall(send,env,signal,{...body,instructions:body.instructions+'\n'+guidance,input,
   text:format('hardware_design_revision',schema)},'装配增量修订',{timeoutMs,hasImages,retryTruncation:false});
  try{return {...result,value:applyDesignRevision(base,result.value),revision:{...result.value,attempts:attempt}};}
  catch(error){
   if(attempt===2)throw new ModelStageError('装配修订操作无法应用：'+error.message);
   input=addModelData(body.input,{invalidRevision:result.value,applicationError:error.message,
    task:'操作未能应用，原始设计没有改变。根据错误修正操作，返回针对同一 rejectedDraft 的完整修订操作列表。'});
  }
 }
}
