export {validateCadPlan} from '../cad-plan.js';
const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)}), arr=items=>({type:'array',items}),str={type:'string'},vec=arr({type:'number'});
const shapes=['box','ellipsoid','cylinder','roundedPrism','capsule'],ops=['add','cut'],roles=['printed','reference'];
const index={type:'integer'};
const motion=obj({
 type:{type:'string',enum:['prismatic']},name:str,axis:vec,travelMm:{type:'number'},
 movingBodyIndices:arr(index),actuatorPartIndex:index,guidePartIndex:index,controllerPartIndex:index
});
export const cadPlanSchema=obj({version:{type:'integer',enum:[1]},bodies:arr(obj({name:str,partIndex:index,role:{type:'string',enum:roles},positionMm:vec,features:arr(obj({op:{type:'string',enum:ops},shape:{type:'string',enum:shapes},sizeMm:vec,centerMm:vec,rotationDeg:vec}))})),motions:arr(motion)});
