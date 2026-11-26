import {occurrenceGroups,componentProfile} from '../installed-parts.js';
import {needsHousing} from './design-fit.mjs';
export {reviewAssemblyFit,needsHousing} from './design-fit.mjs';
export function designCoverage(design,requirements=[]){
 const issues=[],rows=[],bodies=design.cadPlan?.bodies||[];
 for(const [i,p] of design.parts.entries()){
  const {groups,unknown}=occurrenceGroups({bodies},p,i),occurrences=[...groups].map(([instanceIndex,bodyIndices])=>({instanceIndex,bodyIndices}));
  const row={partIndex:i,quantity:p.qty,bodies:occurrences.reduce((s,g)=>s+g.bodyIndices.length,unknown.length),placement:p.placement,occurrences};rows.push(row);
  if(p.placement!=='mounted')continue;
  const missing=Array.from({length:p.qty},(_,j)=>j).filter(j=>!groups.has(j));
  if(missing.length||unknown.length)issues.push(`部件覆盖：「${p.name}」需要安装 ${p.qty} 件，CAD 只有 ${groups.size} 个已编号实例。缺少实例 ${missing.map(j=>'#'+(j+1)).join('、')||'无'}；未正确归属的实体：${unknown.join('、')||'无'}。同一件产品的壳和输出端共用 instanceIndex。`);
  const profiles=new Set(),poses=new Set();
  for(const [id,indices] of groups){const solids=indices.map(j=>bodies[j]);profiles.add(JSON.stringify(solids.map(componentProfile).sort()));
   const pose=JSON.stringify(solids.map(b=>b.positionMm.map((v,k)=>Math.round((v+(b.features?.[0]?.centerMm[k]||0))*100)/100)).sort());
   if(poses.has(pose))issues.push(`部件覆盖：「${p.name}」的安装实例 #${id+1} 与另一件重合。`);poses.add(pose);
  }
  if(profiles.size>1&&p.kind!=='material')issues.push(`部件覆盖：「${p.name}」同一型号的安装实例包含不同的实体或特征；核对每件的完整性，不能把一台的壳体、输出盘各算成一台。`);
 }
 const shells=bodies.filter(b=>design.parts[b.partIndex]?.role==='enclosure');
 if(needsHousing(design,requirements)&&!shells.length)issues.push('部件覆盖：需求中的外壳没有实体。');
 return {rows,shellBodies:shells.length,issues};
}
