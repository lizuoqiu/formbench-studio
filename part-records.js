const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
// Cosmetic company suffixes do not change the ordered part. Keep the actual
// manufacturer, part number, revision and package intact when reusing evidence.
export const partIdentity=part=>text(part?.model,240).normalize('NFKC').toLowerCase()
  .replace(/^(?:自制|定制)\s*/,'')
  .replace(/(?:^|\s)(?:co\.?\s*,?\s*ltd\.?|s\.r\.l\.?|incorporated|corporation|inc\.?|corp\.?|ltd\.?)(?=\s|$)/g,' ')
  .replace(/\s+/g,' ').trim();
const https=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export function hardwareReference(value){
  if(!value||!['specified','candidate','custom','material','included','provided'].includes(value.kind)||!Array.isArray(value.items))return null;
  return {kind:value.kind,items:value.items.slice(0,8).map(item=>({name:text(item.name,240),label:text(item.label,120),url:https(item.url)})).filter(item=>item.name),
    note:text(value.note,1800),searchTerms:text(value.searchTerms,280)};
}
export function importedModel(value,part){
  if(!value||part?.modelSourceInvalidated||partIdentity({model:value.sourceModel})!==partIdentity(part)||!['manufacturer','supplier'].includes(value.sourceType)||
    !/^[a-f0-9-]{36}$/.test(value.id)||!['step','stp','stl'].includes(value.format)||!Array.isArray(value.sizeMm)||value.sizeMm.length!==3||value.sizeMm.some(n=>!Number.isFinite(n)||n<=0||n>2000))return null;
  const prefix='/api/model-assets/'+value.id+'/';
  const meshes=Array.isArray(value.geometrySummary?.meshes)?value.geometrySummary.meshes.slice(0,120).filter(m=>
    Number.isInteger(m?.index)&&m.index>=0&&Array.isArray(m.boundsMm)&&m.boundsMm.length===2&&
    m.boundsMm.every(point=>Array.isArray(point)&&point.length===3&&point.every(n=>Number.isFinite(n)&&Math.abs(n)<=2000))
  ).map(({index,label,boundsMm})=>({index,label:text(label,200),boundsMm})):null;
  return {id:value.id,sourceModel:text(value.sourceModel,240),sourceUrl:https(value.sourceUrl),documentationUrl:https(value.documentationUrl),
    sourceType:value.sourceType,sizeMm:[...value.sizeMm],format:value.format,filename:text(value.filename,240),
    ...(meshes?{geometrySummary:{meshes}}:{}),
    meshUrl:prefix+'mesh.json',fileUrl:prefix+'source.'+value.format};
}

export function importedSubsetAnchor(body,model){
  const source=body.sourceMeshes,feature=body.features?.[0];
  if(!Array.isArray(source?.meshIndices)||!Array.isArray(model?.geometrySummary?.meshes)||
    body.role!=='reference'||body.features?.length!==1||feature.op!=='add'||feature.shape!=='box')return null;
  const modelMeshes=model.geometrySummary.meshes;
  const meshIndices=[...source.meshIndices].sort((a,b)=>a-b);
  const bounds=meshIndices.map(index=>modelMeshes.find(mesh=>mesh.index===index)?.boundsMm);
  if(!bounds.length||bounds.some(pair=>!Array.isArray(pair)||pair.length!==2||
    pair.some(point=>!Array.isArray(point)||point.length!==3||!point.every(Number.isFinite))))return null;
  const min=[0,1,2].map(i=>Math.min(...bounds.map(pair=>pair[0][i])));
  const max=[0,1,2].map(i=>Math.max(...bounds.map(pair=>pair[1][i])));
  if(!feature.sizeMm.every((n,i)=>Math.abs(n-(max[i]-min[i]))<.02))return null;
  // Mesh coordinates on disk are measured from the full model's lower corner.
  const sourceOriginMm=min.map((n,i)=>(n+max[i]+model.sizeMm[i])/2);
  return {...feature,meshIndices,sourceOriginMm};
}

export function importedSubsetIssues(bodies,part,model){
  if(!bodies.some(body=>body.sourceMeshes))return [];
  if(!model?.geometrySummary?.meshes)return ['装配分件缺少已读取的原厂或供应商网格。'];
  const usedByInstance=new Map(),issues=[];
  const dimensionedInstances=new Set();
  if(!part.sizeMm?.every((n,i)=>Math.abs(n-model.sizeMm[i])<.02))
    issues.push('BOM 尺寸须保留原厂 CAD 的完整原生包络；分件尺寸用于各自安装。');
  for(const body of bodies){
    if(!body.sourceMeshes)continue;
    const {instanceIndex,meshIndices,dimensionBasis}=body.sourceMeshes,anchor=importedSubsetAnchor(body,model);
    const dimensioned=Array.isArray(meshIndices)&&meshIndices.length===0&&typeof dimensionBasis==='string'&&dimensionBasis.trim();
    if(dimensioned&&Number.isInteger(instanceIndex)&&instanceIndex>=0&&instanceIndex<part.qty){
      dimensionedInstances.add(instanceIndex);
      continue;
    }
    if(!anchor||!Number.isInteger(instanceIndex)||instanceIndex<0||instanceIndex>=part.qty){
      issues.push('「'+body.name+'」的原厂分件索引、安装实例编号或参考包络不匹配。');
      continue;
    }
    let used=usedByInstance.get(instanceIndex);
    if(!used){used=new Set();usedByInstance.set(instanceIndex,used);}
    for(const index of anchor.meshIndices){
      if(used.has(index))issues.push('「'+body.name+'」重复使用同一实体实例的网格 #'+index+'。');
      used.add(index);
    }
  }
  if(usedByInstance.size!==part.qty)issues.push('需要为每个实际安装实例指定其原厂分件。');
  for(const i of dimensionedInstances)if(!usedByInstance.has(i))issues.push('第 '+(i+1)+' 个实例的按尺寸分件没有关联的原厂子件。');
  if(bodies.some(body=>!body.sourceMeshes&&body.features?.length===1&&body.features[0].op==='add'&&body.features[0].shape==='box'&&
    body.features[0].sizeMm.every((n,i)=>Math.abs(n-model.sizeMm[i])<.02)))
    issues.push('原厂整件锚点会与分件重叠，须将整件锚点改为对应分件。');
  return issues;
}

export function importedPartAnchors(bodies,parts){
  return bodies.map(body=>{
    const part=parts[body.partIndex],model=importedModel(part?.importedModel,part),feature=body.features?.[0];
    if(!model||body.role!=='reference'||body.features.length!==1||feature.op!=='add'||feature.shape!=='box')return null;
    if(body.sourceMeshes)return importedSubsetAnchor(body,part.importedModel);
    return feature.sizeMm.every((n,i)=>Math.abs(n-model.sizeMm[i])<.02)?feature:null;
  });
}
