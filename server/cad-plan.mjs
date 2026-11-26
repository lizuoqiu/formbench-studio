export {validateCadPlan} from '../cad-plan.js';
const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}), arr=items=>({type:'array',items}),str={type:'string'},vec=arr({type:'number'});
const shapes=['box','ellipsoid','cylinder','roundedPrism','capsule'],ops=['add','cut'],roles=['printed','reference'];
const index={type:'integer'};
const motion=obj({
 type:{type:'string',enum:['prismatic']},name:str,axis:vec,travelMm:{type:'number'},
 movingBodyIndices:arr(index),actuatorPartIndex:index,guidePartIndex:index,controllerPartIndex:index,parentJointIndex:{anyOf:[index,{type:'null'}]}
});
const joint=obj({name:str,axis:vec,pivotMm:vec,minDegrees:{type:'number'},maxDegrees:{type:'number'},movingBodyIndices:arr(index),fixedBodyIndex:index,actuatorPartIndex:index,parentIndex:{anyOf:[index,{type:'null'}]}});
const sourceMeshes={anyOf:[obj({instanceIndex:index,meshIndices:arr(index),dimensionBasis:{anyOf:[str,{type:'null'}]}}),{type:'null'}]};
export const cadPlanSchema=obj({version:{type:'integer',enum:[1]},bodies:arr(obj({name:str,partIndex:index,instanceIndex:index,role:{type:'string',enum:roles},positionMm:vec,features:arr(obj({op:{type:'string',enum:ops},shape:{type:'string',enum:shapes},sizeMm:vec,centerMm:vec,rotationDeg:vec})),sourceMeshes,color:{anyOf:[str,{type:'null'}]}})),motions:arr(motion),joints:arr(joint),fitChecks:arr(obj({mountType:{type:'string',enum:['closed-housing','open-mount']},partIndex:index,instanceIndex:index,housingBodyIndices:arr(index),lidBodyIndices:arr(index),insertionOffsetMm:vec,portAccess:arr(obj({pins:arr(str),bodyIndex:index,centerMm:vec,plugSizeMm:vec,approachMm:vec})),lidOffsetMm:{anyOf:[vec,{type:'null'}]}}))});
