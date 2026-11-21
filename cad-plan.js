const shapes=['box','ellipsoid','cylinder'],ops=['add','cut'],roles=['printed','reference'];
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const isvec=(v,min,max)=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>=min&&n<=max);
export function validateCadPlan(plan,partCount=60){
 const bad=()=>{throw Error('Invalid CAD plan')};
 if(!exact(plan,['version','bodies'])||plan.version!==1||!Array.isArray(plan.bodies)||plan.bodies.length>40)bad();
 let n=0;for(const b of plan.bodies){
 if(!exact(b,['name','partIndex','role','positionMm','features'])||typeof b.name!=='string'||!b.name.trim()||b.name.length>200||!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>=partCount||!roles.includes(b.role)||!isvec(b.positionMm,-2000,2000)||!Array.isArray(b.features)||!b.features.length||b.features.length>40||(n+=b.features.length)>240||b.features[0]?.op!=='add')bad();
 for(const f of b.features)if(!exact(f,['op','shape','sizeMm','centerMm'])||!ops.includes(f.op)||!shapes.includes(f.shape)||!isvec(f.sizeMm,.1,2000)||!isvec(f.centerMm,-2000,2000)||(f.shape==='cylinder'&&Math.abs(f.sizeMm[0]-f.sizeMm[1])>1e-6))bad();
 }
 return plan;
}
