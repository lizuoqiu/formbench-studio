// Both the browser and Node workers execute these same bounded CSG operations.
import initManifold from './assets/manifold-3d/manifold.js';
import {validateCadPlan,cadBodyProgress} from './cad-plan.js';
import {manifoldNativeFeature} from './native-features.js';
const engine='Manifold 3.5.1',segments=48,maxBytes=12*1024*1024;
function binaryStl(mesh,remaining) {
  const {vertProperties:p,numProp:s,triVerts:t}=mesh,n=t.length/3,bytes=84+n*50;
  if(!Number.isInteger(n)||n<=0||n>65000||bytes>remaining)throw Error('网格为空或过大，请减少曲面和布尔特征。');
  const file=new Uint8Array(bytes),view=new DataView(file.buffer);file.set(new TextEncoder().encode('FormBench | Manifold | millimetres'));view.setUint32(80,n,true);
  for(let j=0;j<n;j++){
    const a=t[3*j]*s,b=t[3*j+1]*s,c=t[3*j+2]*s;
    const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx,h=Math.hypot(x,y,z);
    if(!(h>0&&Number.isFinite(h)))throw Error('网格包含无效三角面，请调整特征尺寸与位置。');
    let at=84+j*50;
    for(const v of [x/h,y/h,z/h,p[a],p[a+1],p[a+2],p[b],p[b+1],p[b+2],p[c],p[c+1],p[c+2]]){view.setFloat32(at,v,true);at+=4;}
  }
  return file;
}
function toBase64(bytes){
  if(typeof bytes.toBase64==='function')return bytes.toBase64();
  const groups=[];for(let i=0;i<bytes.length;i+=24576)groups.push(btoa(String.fromCharCode(...bytes.subarray(i,i+24576))));
  return groups.join('');
}
export async function initializeCadKernel(){
  const lib=await initManifold();lib.setup();return lib;
}

// The caller owns the returned local-space solid, including on the review path.
export function buildCadSolid(lib,body){
  const M=lib.Manifold;let solid=null;
  try{
    for(const f of body.features){
      const [w,d,h]=f.sizeMm;
      let primitive;
      if(f.shape==='box')primitive=M.cube([w,d,h],true);
      else if(f.shape==='cylinder'){const unit=M.cylinder(h,1,1,segments,true);try{primitive=unit.scale([w/2,d/2,1])}finally{unit.delete()}}
      else if(f.shape==='ellipsoid'){const unit=M.sphere(1,segments);try{primitive=unit.scale([w/2,d/2,h/2])}finally{unit.delete()}}
      else primitive=manifoldNativeFeature(lib,f,segments);
      if(!primitive)throw Error('未知几何图元。');
      if(f.rotationDeg?.some(angle=>angle!==0)){
        const rotated=primitive.rotate(f.rotationDeg);primitive.delete();primitive=rotated;
      }
      const next=primitive.translate(f.centerMm);primitive.delete();
      if(!solid){if(f.op!=='add'){next.delete();throw Error('首个特征须为添加实体。')}solid=next}
      else {const previous=solid;solid=null;try{solid=f.op==='cut'?previous.subtract(next):previous.add(next)}finally{previous.delete();next.delete()}}
    }
    if(!solid||solid.status()!=='NoError'||solid.isEmpty()||!(solid.volume()>0))throw Error('布尔操作没有留下有效实体，请调整尺寸或切除位置。');
    return solid;
  }catch(error){solid?.delete();throw error;}
}

export async function compileCadPlan(plan,onProgress){
  validateCadPlan(plan);if(!plan.bodies.length)throw Error('CAD 计划缺少可编译的实体。');
  const lib=await initializeCadKernel();let remaining=maxBytes;
  const bodies=[];
  for(const [index,body] of plan.bodies.entries()){
    onProgress?.(cadBodyProgress(plan,index,'start'));
    const solid=buildCadSolid(lib,body);
    const {partIndex,name,role,positionMm}=body;
    try{
      const file=binaryStl(solid.getMesh(),remaining);remaining-=file.length;
      bodies.push({partIndex,name,role,positionMm,fileName:'part-'+(partIndex+1)+'-body-'+(bodies.length+1)+'.stl',stlBase64:toBase64(file)});
    }finally{solid.delete();}
    onProgress?.(cadBodyProgress(plan,index,'finish'));
  }
  return {engine,units:'mm',bodies};
}
