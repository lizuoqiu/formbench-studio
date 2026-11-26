import {importedSubsetIssues,partIdentity} from '../part-records.js';
import {wholePartBox} from '../cad-plan.js';
import {reconstructionPlacementIssues,reconstructParts} from './part-reconstruction.mjs';
import {sourceParts,sourcesForModel} from './part-sourcing.mjs';
import {reviseAssembly} from './design-revision.mjs';
import {responseProvenance} from './design-review.mjs';

export function partModelPlacementIssues(design,cache){
 const bodies=design.cadPlan?.bodies||[];
 return [...reconstructionPlacementIssues(design,cache),...design.parts.flatMap((part,i)=>{
  const model=cache[partIdentity(part)]?.importedModel;
  const own=bodies.filter(b=>b.partIndex===i);
  if(own.some(body=>body.sourceMeshes))return importedSubsetIssues(own,part,model)
    .map(issue=>`原厂/供应商分件装配：「${part.name}」${issue}`);
  if(!model)return [];
  if(part.placement!=='mounted'&&!own.length)return [];
  const same=size=>Array.isArray(size)&&size.length===3&&size.every((v,k)=>Math.abs(v-model.sizeMm[k])<.02);
  const matched=own.filter(b=>same(wholePartBox(b)?.sizeMm)).length;
  return matched===part.qty&&same(part.sizeMm)?[]:[`原厂/供应商模型装配：「${part.name}」的完整原生尺寸是 ${model.sizeMm.join(' × ')} mm；${part.qty} 个实例只有 ${matched} 个完整锚点匹配。对齐 BOM 尺寸、安装方向、基准和相关孔位，保持模型原生比例。`];
 })];
}

// New selections are researched after an assembly revision. Reconcile those
// authoritative dimensions before spending a full compilation/review cycle.
// Only model-returned operations may change the assembly; never resize it here.
export async function reconcilePartModels(draft,{state,ctx,instructions,env,send,signal,progress},
 {revise=reviseAssembly,source=sourceParts,reconstruct=reconstructParts}={}){
 let current=draft;
 while((current.alignments?.length||0)<2){
  const issues=partModelPlacementIssues(current.value,state.sources);
  if(!issues.length)break;
  await progress({stage:'aligning',attempt:current.attempt,message:'正在按真实部件模型修订安装尺寸与位置'});
  const result=await revise(current.value,{instructions:instructions+'\n当前是逐件资料更新后的装配对齐。以已编译的独立模型及原厂模型的原生尺寸和基准为依据，增量修改受影响的零件尺寸、实例或分件锚点、旋转、孔位、邻接结构和关联引用。不得缩放采购件、删掉实例或改成不展示来绕过检查。保留未受影响的内容，不额外增加功能或配套结构。',
   input:JSON.stringify({goal:ctx.prompt,conversation:ctx.history,architecture:state.selection?.architecture,rejectedDraft:current.value,issues,
    selectedParts:sourcesForModel(current.value.parts,current.value.parts.map(p=>state.sources[partIdentity(p)]))}),
   max_output_tokens:state.revisionOutputBudget||state.assemblyOutputBudget||65536},send,env,signal);
  current={...current,value:result.value,alignments:[...(current.alignments||[]),{issues,revision:result.revision,...responseProvenance(result)}]};
  state.draft=current;
  await progress({stage:'aligning',attempt:current.attempt,message:'装配修改已保存，正在核对受影响的部件'});
  await source(current.value.parts,state.sources,env,send,signal,progress,current.value.cadPlan);
  await reconstruct(current.value.parts,state.sources,env,send,signal,progress,current.value.cadPlan);
 }
 return current;
}
