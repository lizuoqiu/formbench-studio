import {loadPartVisual,withVisualInput} from './part-visual-reference.mjs';
import {structuredCall,format,responseProvenance} from './design-review.mjs';
import {hasLocalCodex} from './openai-response.mjs';
import {officialStageGuide} from './official-skills.mjs';
import {hardwarePolicyGuide} from './modeling-guide.mjs';
import {cadPlanSchema,validateCadPlan} from './cad-plan.mjs';
import {partIdentity} from '../part-records.js';
import {compileWithForge,forgeMode} from './forge-plan-cli.mjs';
import {decodeSTL} from '../assembly-hardware.js';
import {featurePlacement,wholePartBox} from '../cad-plan.js';
import {designReference} from './design-references.mjs';
const str={type:'string'},obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const vec={type:'array',items:{type:'number'}};
const datum=obj({name:str,positionMm:vec,axis:{anyOf:[vec,{type:'null'}]},basis:{type:'string',enum:['datasheet','estimated','geometry']},evidence:str});
const schema=obj({description:str,assumptions:{type:'array',items:str},datums:{type:'array',items:datum},features:cadPlanSchema.properties.bodies.items.properties.features});

export function centerReconstruction(model,center){
  const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
  if(!vector(center))throw Error('零件模型缺少有效中心。');
  for(const d of model.datums||[])if(!vector(d.positionMm)||d.axis!==null&&(!vector(d.axis)||Math.abs(Math.hypot(...d.axis)-1)>.005))throw Error('安装基准 '+d.name+' 需要三轴坐标及单位方向；不适用的方向填 null。');
  return {...model,features:model.features.map(f=>({...f,centerMm:f.centerMm.map((n,k)=>n-center[k])})),
    datums:(model.datums||[]).map(d=>({...d,positionMm:d.positionMm.map((n,k)=>n-center[k])})),
    originalToCenteredTranslationMm:center.map(n=>-n)};
}

export function queueReconstructionRevision(record,reason){
  if(!record?.reconstruction||record.importedModel)return false;
  const evidence=record.reconstruction.evidenceVersion;
  // A resumed run may have just rebuilt the part before reaching its saved
  // repair plan. The same evidence and question do not justify another call.
  if(evidence?.queriedAt&&evidence.queriedAt===record.queriedAt&&evidence.question===reason)return false;
  record.reconstructionPrior={model:record.reconstruction,reason};
  delete record.reconstruction;
  return true;
}

export async function reconstructParts(parts,cache,env,send,signal,progress=async()=>{},cadPlan=null){
  const [guide,policy]=await Promise.all([officialStageGuide('sourcing',env),hardwarePolicyGuide('reconstruction',env)]);
  let next=0,actionError=null;
  async function run(){while(next<parts.length&&!actionError){
    const partIndex=next++,part=parts[partIndex],record=cache[partIdentity(part)];
    if(record?.reconstruction?.datums?.some(d=>typeof d==='string'))delete record.reconstruction;
    const shownExternal=part.placement==='loose'&&['purchase','included'].includes(part.kind)&&cadPlan?.bodies?.some(b=>b.partIndex===partIndex);
    if(!record||record.identityStatus==='mismatch'||record.importedModel||record.reconstruction||designReference(part)||part.kind==='custom'||part.kind==='provided'||part.placement==='loose'&&!shownExternal)continue;
    let error=record.reconstructionError||'';
    const visual=await loadPartVisual(record,signal); 
    for(let attempt=1;attempt<=2;attempt++){
      signal.throwIfAborted();await progress({stage:'reconstructing',message:'正在按资料建立 '+part.name+' 的独立模型'});
      try{
        const lengthLimited=/输出已达长度上限/.test(error)||record.reconstructionTokenBudget===65536;
        record.reconstructionTokenBudget=lengthLimited?65536:32768;
        const generated=await structuredCall(send,env,signal,{instructions:guide.text+'\n'+policy.text+'\n为所选采购件制作可辨认、独立的零件 CAD。输入事实优先；缺 CAD 不等于缺零件。按已有外廓、接口和照片资料推导合理参数，缺失的细节作明确估算。不要等待用户测量。只建立该商品本身，不把支架或整机画进来。局部毫米坐标，Z 向上；PCB、插座、芯片、针排应表现为有区别的实体特征，电机须表现壳体、轴/舵盘接口和固定耳。合理控制细节，优先外形、轴线和安装特征。采购件不可见且无资料的内部细节可以简化；本步骤不重新设计该器件的电气原理或整机安装方案。使用受支持图元的并/差，feature 数不超过 60；每个 sizeMm 三轴均为 0.1–2000 mm，cylinder 的 X/Y 必须相等。不影响安装且小于 0.1 mm 的涂层、镀层或丝印可合并进主体，保留有依据的整件包络与端子位置。买来的一个模块可以包含多个不连通材料实体。facts 和 estimated assumptions 分开。已有数据能支持的孔距不要改成猜测。后端会实际用 ForgeCAD 编译，失败会回传。返回 features，不要写代码。',
          max_output_tokens:record.reconstructionTokenBudget,
          input:withVisualInput(JSON.stringify({part,evidence:{...record,observedUrls:undefined,researchProvenance:undefined,linkProvenance:undefined,reconstructionDraft:undefined,reconstructionPrior:undefined},previousFailure:error,...(record.reconstructionPrior?{previousModel:record.reconstructionPrior.model,revisionReason:record.reconstructionPrior.reason,revisionInstruction:'这是之前实际编译过的单件模型，不表示新资料或整机配合已验证。依据更新的资料和基准修订，保留仍正确的特征及坐标。返回完整模型并重新编译，不从零任意改变已知孔距、外形或端子。'}:{}),...(record.reconstructionDraft?{previousDraft:record.reconstructionDraft,repairInstruction:'以下是上次尚未通过验证的输出，可能有几何错误或被截断。结合具体报错复用合理的几何选择，修正并补全，返回完整 JSON；不要将草稿当作已通过。'}:{}),datumConvention:'datums 中用结构化的三轴 positionMm 记录安装孔、轴线及连接器的基准点，坐标与 features 一致；axis 为单位向量或 null；basis 和 evidence 区分来源事实、模型几何和估算。后端将几何和基准一起转换到居中坐标，不在描述文字里另写一套坐标。'}),visual),text:format('purchased_part_geometry',schema)},'部件建模 '+part.name,{timeoutMs:lengthLimited?3600000:1800000});
        record.reconstructionDraft=JSON.stringify(generated.value).slice(0,120000);
        const body={name:part.name,partIndex:0,role:'reference',positionMm:[0,0,0],features:generated.value.features};
        const plan={version:1,bodies:[body],motions:[],joints:[]};validateCadPlan(plan,1);
        const mode=forgeMode(env);if(!mode)throw Error('独立零件建模需要 ForgeCAD。');
        const compiled=await compileWithForge(plan,env,mode,signal);
        const bytes=Buffer.from(compiled.bodies[0].stlBase64,'base64'),faces=decodeSTL(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
        const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const face of faces)for(const p of face)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
        const sizeMm=max.map((n,k)=>Number((n-min[k]).toFixed(4))),center=min.map((n,k)=>(n+max[k])/2);
        record.reconstruction={...centerReconstruction(generated.value,center),sizeMm,
          visualReference:visual?.meta||null,engine:compiled.engine,...responseProvenance(generated),source:'dimension-reconstruction',skills:guide.sources,policy:policy.skill,
          evidenceVersion:{queriedAt:record.queriedAt||null,question:record.lastResearchQuestion||''}};
        delete record.reconstructionError;
        delete record.reconstructionDraft;
        delete record.reconstructionPrior;
        await progress({stage:'reconstructing',message:part.name+' 的独立模型已编译',record});break;
      }catch(e){signal.throwIfAborted();if(e.actionRequired==='local-codex-unavailable'){actionError=e;return;}error=e.message;record.reconstructionError=error;if(e.partialOutput)record.reconstructionDraft=e.partialOutput;if(e.actionRequired==='api-billing')actionError=e;await progress({stage:'reconstructing',message:actionError?'额度不足，已保存 '+part.name+' 的模型进度':'正在修正 '+part.name+' 的独立模型',record});if(actionError)break;}
    }
  }}
  await Promise.all(Array.from({length:Math.min(hasLocalCodex(env)?1:3,parts.length)},run));
  if(actionError)throw actionError;
}

function composeRotation(parent,child){
  const basis=[[1,0,0],[0,1,0],[0,0,1]],rotate=v=>featurePlacement({centerMm:[0,0,0],rotationDeg:parent})(v),inner=featurePlacement({centerMm:[0,0,0],rotationDeg:child});
  const columns=basis.map(v=>rotate(inner(v))),y=Math.asin(Math.max(-1,Math.min(1,-columns[0][2])));
  const x=Math.abs(Math.cos(y))>1e-7?Math.atan2(columns[1][2],columns[2][2]):0;
  const z=Math.abs(Math.cos(y))>1e-7?Math.atan2(columns[0][1],columns[0][0]):Math.atan2(-columns[1][0],columns[1][1]);
  return [x,y,z].map(n=>n*180/Math.PI);
}

// New or substituted parts can be researched after the assembly draft. Their
// earlier estimated solids must not silently bypass the independently built model.
export function reconstructionPlacementIssues(design,cache){
  const bodies=design.cadPlan?.bodies||[];
  const motions=[...(design.cadPlan?.joints||[]),...(design.cadPlan?.motions||[]),...(design.interaction?.controls||[])];
  return design.parts.flatMap((part,partIndex)=>{
    const record=cache[partIdentity(part)],model=record?.reconstruction;
    const own=bodies.flatMap((body,index)=>body.partIndex===partIndex?[{body,index}]:[]);
    if(record?.importedModel||designReference(part)||part.placement!=='mounted'&&!own.length||!['purchase','included'].includes(part.kind||record?.kind))return [];
    if(!model)return record?.reconstructionError?[`独立模型未完成：「${part.name}」的建模尚未通过：${record.reconstructionError}。继续修正该件并实际编译，不能用未验证的占位形体替代后发布。`]:[];
    // A purchased actuator may legitimately be split into fixed and moving
    // subcomponents. Its mechanical mapping is reviewed separately.
    const groups=new Set(own.map(({index})=>motions.flatMap((m,i)=>m.movingBodyIndices?.includes(index)?[i]:[]).join(',')));
    if(own.length>part.qty&&groups.size>1)return [];
    const matches=size=>Array.isArray(size)&&size.length===3&&size.every((n,i)=>Math.abs(n-model.sizeMm[i])<.05);
    const complete=own.filter(({body})=>matches(wholePartBox(body)?.sizeMm)).length;
    if(complete===part.qty&&matches(part.sizeMm))return [];
    const differences=[...(complete!==part.qty?[`${part.qty} 个实例中仅 ${complete} 个使用匹配的完整锚点`]:[]),...(!matches(part.sizeMm)?['BOM 的 sizeMm 尚未与模型一致']:[])];
    return [`独立模型装配：「${part.name}」已有已编译的 ${model.sizeMm.join(' × ')} mm 零件模型；${differences.join('；')}。将该行 sizeMm 和每个 reference box 的原生尺寸对齐此模型，用 centerMm/rotationDeg 安装，依据新 datums 重新核对孔位、轴线及邻件。不要继续沿用查证前的估计形体。`];
  });
}
// Replace only an explicit full-part anchor. Coordinates, indices and the
// author's structural bodies stay intact; no benchmark-specific geometry.
function reconstructedAnchor(body,part,cache){
  const record=cache[partIdentity(part)],anchor=wholePartBox(body),model=record?.reconstruction;
  if(!anchor||record?.importedModel||!model||!anchor.sizeMm.every((n,k)=>Math.abs(n-model.sizeMm[k])<.05))return null;
  return {record,anchor,model};
}
export function reconstructedGeometry(design,cache){
  return (design.cadPlan?.bodies||[]).flatMap((body,bodyIndex)=>{
    const part=design.parts[body.partIndex],match=reconstructedAnchor(body,part,cache);
    if(!match)return [];
    const {record,anchor,model}=match,place=featurePlacement(anchor),origin=place([0,0,0]);
    return [{partIndex:body.partIndex,bodyIndex,name:part.name,model:part.model,status:'matched-anchor',
      nativeSizeMm:model.sizeMm,featureCount:model.features.length,modelCompilation:model.engine,
      sourceUrl:record.sourceUrl,description:model.description,assumptions:model.assumptions,
      datums:(model.datums||[]).map(d=>({...d,positionWorldMm:place(d.positionMm).map((v,k)=>v+(body.positionMm?.[k]||0)),
        axisWorld:d.axis?place(d.axis).map((v,k)=>v-origin[k]):null})),
      scope:'Matching full-part anchor is expanded into the independently generated features before assembly compilation; not manufacturer CAD or physical fit verification.'}];
  });
}
export function materializeReconstructedParts(design,cache){
  return {...design,cadPlan:{...design.cadPlan,bodies:design.cadPlan.bodies.map(body=>{
    const match=reconstructedAnchor(body,design.parts[body.partIndex],cache);
    if(!match)return body;
    const {anchor,model}=match;
    const place=featurePlacement(anchor);
    return {...body,features:model.features.map(f=>({...f,centerMm:place(f.centerMm),rotationDeg:composeRotation(anchor.rotationDeg||[0,0,0],f.rotationDeg||[0,0,0])}))};
  })}};
}
