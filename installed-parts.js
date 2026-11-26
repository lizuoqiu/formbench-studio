// An occurrence is a purchased/printed unit, never a count of its submeshes.
export function occurrenceOf(body,part){return body.instanceIndex??body.sourceMeshes?.instanceIndex??(part?.qty===1?0:null);}
export function occurrenceGroups(plan,part,index){
 const groups=new Map(),unknown=[];
 plan.bodies.forEach((body,i)=>{if(body.partIndex!==index)return;const id=occurrenceOf(body,part);
  if(!Number.isInteger(id)||id<0||id>=part.qty){unknown.push(i);return;}
  if(!groups.has(id))groups.set(id,[]);groups.get(id).push(i);
 });return {groups,unknown};
}
// Compare intrinsic geometry, allowing each instance its own world orientation.
const dimSig=f=>(f.sizeMm||[]).map(v=>Math.round(v*100)/100).sort((a,b)=>a-b).join(',');
export const componentProfile=b=>JSON.stringify([b.sourceMeshes?.meshIndices?.slice().sort((a,c)=>a-c)||null,(b.features||[]).map(f=>[f.op,f.shape,dimSig(f)]).sort()]);
