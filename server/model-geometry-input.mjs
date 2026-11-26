// Each matched anchor carries a copy of its part model and the model's local
// datums. Keep that information once and pair it with every installed pose.
export function geometryForModel(geometry){
  if(!geometry?.reconstructedParts?.length)return geometry;
  const models=[],modelIndices=new Map();
  const placements=geometry.reconstructedParts.map(({bodyIndex,datums,...model})=>{
    const localDatums=[],worldDatums=[];
    for(const {positionWorldMm,axisWorld,...localDatum} of datums||[]){
      localDatums.push(localDatum);
      worldDatums.push({positionWorldMm,axisWorld});
    }
    const definition=datums===undefined?model:{...model,datums:localDatums};
    const key=JSON.stringify(definition);
    if(!modelIndices.has(key)){
      modelIndices.set(key,models.length);
      models.push(definition);
    }
    return {bodyIndex,modelIndex:modelIndices.get(key),worldDatums};
  });
  return {...geometry,reconstructedParts:{models,placements}};
}

export const reconstructedPartsInput='当 reconstructedParts 含 models 和 placements 时，每条安装位置的 modelIndex 指向 models 的零基索引，bodyIndex 仍对应当前 CAD。worldDatums 与该模型的局部 datums 按数组索引一一对应。';
export const cadFeatureTupleInput='candidate 中的 CAD features 可按 [op, shape, sizeMm, centerMm, rotationDeg] 五项数组表示。顺序与原实体逐项相同，rotationDeg 的 null 表示该图元未声明旋转。零件、实体和特征的索引不变。';

// The sourcing display note repeats the same leading evidence already in
// geometryReference. Keep the evidence and any additional note in model input.
export function candidateForModel(candidate){
  if(!Array.isArray(candidate?.parts))return candidate;
  const parts=candidate.parts.map(part=>{
    const reference=part.hardwareReference,detail=part.geometryReference?.detail;
    if(!reference?.note||!detail)return part;
    const note=detail.startsWith(reference.note)?'':reference.note.startsWith(detail+' ')?reference.note.slice(detail.length+1):reference.note;
    return note===reference.note?part:{...part,hardwareReference:{...reference,note}};
  });
  const features=['op','shape','sizeMm','centerMm','rotationDeg'];
  const cadPlan=Array.isArray(candidate.cadPlan?.bodies)?{...candidate.cadPlan,bodies:candidate.cadPlan.bodies.map(body=>{
    if(!Array.isArray(body?.features))return body;
    return {...body,features:body.features.map(feature=>
      feature&&Object.keys(feature).every(key=>features.includes(key))&&features.slice(0,4).every(key=>Object.hasOwn(feature,key))
        ?features.map(key=>feature[key]??null)
        :feature)};
  })}:candidate.cadPlan;
  return {...candidate,parts,cadPlan};
}

// Use the exact, unmaterialized patch base. Normalization may add terminal
// entries, so indices from the reviewed candidate are not patch addresses.
export function invalidTerminalBindings(draft){
  const bodies=draft?.cadPlan?.bodies;
  if(!Array.isArray(bodies)||!Array.isArray(draft.interaction?.terminals))return [];
  const connections=draft.interaction.connections;
  const needed=Array.isArray(connections)?connectedTerminalPins(connections):null;
  const seen=new Map();
  return draft.interaction.terminals.flatMap((terminal,index)=>{
    if(typeof terminal?.pin!=='string')return [];
    const {partIndex,pin,bodyIndex}=terminal,bodyPartIndex=bodies[bodyIndex]?.partIndex??null;
    const key=JSON.stringify([partIndex,pin.trim().toUpperCase()]),existing=seen.get(key);
    if(existing===undefined)seen.set(key,index);
    const issues=[];
    if(Number.isInteger(bodyIndex)&&bodyPartIndex!==partIndex)issues.push('wrongBodyOwner');
    if(needed&&!needed.has(key))issues.push('noDeclaredConnection');
    if(existing!==undefined)issues.push('duplicateTerminal');
    if(!issues.length)return [];
    return [{path:'/interaction/terminals/'+index,partIndex,pin,bodyIndex,bodyPartIndex,issues,
      ...(existing!==undefined?{firstPath:'/interaction/terminals/'+existing}:{})}];
  });
}

export function assemblyEvidenceForModel({selectedParts,geometry,repair,review,draft,terminalBindings}){
  const checks=(review?.checks||[]).filter(check=>check.status==='repair');
  const referencedParts=checks.flatMap(check=>[
    ...(check.partIndices||[]),...(check.bodyIndices||[]).map(index=>draft?.cadPlan?.bodies?.[index]?.partIndex)
  ]);
  const focus=new Set([...referencedParts,...(repair?.research||[]).map(item=>item.partIndex),
    ...(draft?.cadPlan?.joints||[]).map(joint=>joint.actuatorPartIndex),draft?.interaction?.controllerPartIndex,
    ...terminalBindings.flatMap(item=>[item.partIndex,item.bodyPartIndex])].filter(Number.isInteger));
  if(!focus.size)return {selectedParts,geometry:geometryForModel(geometry)};
  const parts=selectedParts.map(({model,research},partIndex)=>{
    if(!research||focus.has(partIndex))return {partIndex,model,research};
    const {productUrl,sourceUrl,extentMm,detail,importedModel,reconstruction,factoryInterfaces}=research;
    return {partIndex,model,research:{productUrl,sourceUrl,extentMm,detail:detail?.slice(0,180),
      ...(factoryInterfaces?.length?{factoryInterfaces:factoryInterfaces.map(({id,kind,sourceUrl,quote})=>({id,kind,sourceUrl,quote}))}:{}),
      importedModel:importedModel?{sizeMm:importedModel.sizeMm,sourceUrl:importedModel.sourceUrl}:null,
      reconstruction:reconstruction?{sizeMm:reconstruction.sizeMm,engine:reconstruction.engine}:null}};
  });
  const currentGeometry=geometry?.reconstructedParts?{...geometry,
    reconstructedParts:geometry.reconstructedParts.filter(item=>focus.has(item.partIndex))}:geometry;
  return {selectedParts:parts,geometry:geometryForModel(currentGeometry)};
}
import {connectedTerminalPins} from '../interaction-model.js';

