const shapes=['box','ellipsoid','cylinder','roundedPrism','capsule'],ops=['add','cut'],roles=['printed','reference'];
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const isvec=(v,min,max)=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&n>=min&&n<=max);
export function validateCadPlan(plan,partCount=60){
 const bad=()=>{throw Error('Invalid CAD plan')};
 if(!(exact(plan,['version','bodies'])||exact(plan,['version','bodies','motions']))||plan.version!==1||!Array.isArray(plan.bodies)||plan.bodies.length>40)bad();
 let n=0;for(const b of plan.bodies){
 if(!exact(b,['name','partIndex','role','positionMm','features'])||typeof b.name!=='string'||!b.name.trim()||b.name.length>200||!Number.isInteger(b.partIndex)||b.partIndex<0||b.partIndex>=partCount||!roles.includes(b.role)||!isvec(b.positionMm,-2000,2000)||!Array.isArray(b.features)||!b.features.length||b.features.length>40||(n+=b.features.length)>240||b.features[0]?.op!=='add')bad();
 for(const f of b.features)if(!(exact(f,['op','shape','sizeMm','centerMm'])||(exact(f,['op','shape','sizeMm','centerMm','rotationDeg'])&&isvec(f.rotationDeg,-360,360)))||!ops.includes(f.op)||!shapes.includes(f.shape)||!isvec(f.sizeMm,.1,2000)||!isvec(f.centerMm,-2000,2000)||(f.shape==='cylinder'&&Math.abs(f.sizeMm[0]-f.sizeMm[1])>1e-6))bad();
 }
 if(Object.hasOwn(plan,'motions'))validateMotions(plan);
 return plan;
}

function validateMotions({motions,bodies}){
 if(!Array.isArray(motions)||motions.length>8)throw Error('CAD 运动计划格式无效。');
 const placedParts=new Set(bodies.map(body=>body.partIndex));
 const assignedBodies=new Set();
 for(const motion of motions){
  if(!exact(motion,['type','name','axis','travelMm','movingBodyIndices','actuatorPartIndex','guidePartIndex','controllerPartIndex'])||
     motion.type!=='prismatic'||typeof motion.name!=='string'||!motion.name.trim()||motion.name.length>200)
   throw Error('伸缩机构需要有效的名称和运动类型。');
  if(!isvec(motion.axis,-1,1)||Math.abs(Math.hypot(...motion.axis)-1)>.005||
     !Number.isFinite(motion.travelMm)||motion.travelMm<=0||motion.travelMm>2000)
   throw Error('伸缩机构需要世界坐标下的单位方向和有效的毫米行程。');
  const moving=motion.movingBodyIndices;
  if(!Array.isArray(moving)||moving.length===0||moving.length>=bodies.length)
   throw Error('伸缩机构须同时保留固定件和随动件。');
  for(const i of moving){
   if(!Number.isInteger(i)||i<0||i>=bodies.length||assignedBodies.has(i))
    throw Error('运动计划包含无效或重复的随动件。');
   assignedBodies.add(i);
  }
  for(const index of [motion.actuatorPartIndex,motion.guidePartIndex,motion.controllerPartIndex]){
   if(!placedParts.has(index))throw Error('请为驱动、导向和控制部件提供 BOM 零件及对应的 CAD 安装位置。');
  }
 }
}
