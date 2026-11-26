// Legacy design tests assert on generation and research. Give the independent
// reviewer its own Responses result so those assertions still see the right call.
export function revisionFixture(input,target){
 if(input.text?.format?.name!=='hardware_design_revision')return target;
 const messages=typeof input.input==='string'?[{content:input.input}]:input.input;
 const base=messages.map(message=>{
  const text=typeof message.content==='string'?message.content:message.content.find(item=>item.type==='input_text')?.text;
  try{return JSON.parse(text).rejectedDraft;}catch{return null;}
 }).findLast(Boolean);
 if(!base)throw Error('Fixture revision has no rejectedDraft');
 const operations=[],emit=(op,path,value)=>operations.push({op,path,valueJson:op==='remove'?null:JSON.stringify(value)});
 const diff=(before,after,path)=>{
  if(JSON.stringify(before)===JSON.stringify(after))return;
  if(Array.isArray(before)&&Array.isArray(after)){
   for(let i=before.length-1;i>=after.length;i--)emit('remove',path+'/'+i);
   for(let i=0;i<after.length;i++){
    if(i>=before.length)emit('add',path+'/-',after[i]);else diff(before[i],after[i],path+'/'+i);
   }
   return;
  }
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===after.length)){
   for(const key of Object.keys(before))if(!Object.hasOwn(after,key))emit('remove',path+'/'+key.replaceAll('~','~0').replaceAll('/','~1'));
   for(const key of Object.keys(after)){
    const next=path+'/'+key.replaceAll('~','~0').replaceAll('/','~1');
    if(!Object.hasOwn(before,key))emit('add',next,after[key]);else diff(before[key],after[key],next);
   }
  }else emit('replace',path,after);
 };
 diff(base,target,'');
 if(!operations.length)emit('replace','/name',target.name);
 return {summary:'Apply the fixture changes to the existing design',operations};
}

export function reviewedFixture(input){
 if(input.text?.format?.name!=='hardware_design_review')return null;
 const content=typeof input.input==='string'?input.input:input.input.at(-1).content;
 const text=typeof content==='string'?content:content.findLast(item=>item.type==='input_text').text;
 const {candidate}=JSON.parse(text);
 const partIndices=candidate.parts.length?[0]:[];
 const bodyIndices=candidate.cadPlan?.bodies?.length?[0]:[];
 const checks=['intent','form','mechanism','control'].map(area=>({
  area,status:area==='control'||area==='mechanism'?'not-applicable':'pass',
  note:'本测试核对生成请求与装配记录，采用固定复核结果。',partIndices,bodyIndices
 }));
 const value={motionRequirements:{minRotaryAxes:0,minLinearAxes:0,minSerialRotaryDepth:0},requiresInteraction:false,checks,physicalChecks:['核对实物配合']};
 return Response.json({status:'completed',model:'fixture-review-model',
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
}
