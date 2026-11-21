// Legacy design tests assert on generation and research. Give the independent
// reviewer its own Responses result so those assertions still see the right call.
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
 const value={requiresInteraction:false,checks,physicalChecks:['核对实物配合']};
 return Response.json({status:'completed',model:'fixture-review-model',
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
}
