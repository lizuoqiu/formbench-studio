import {deflateSync,crc32} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {decodeSTL,catalog} from '../assembly-hardware.js';
import {prepareMesh,createRaster,fitCamera} from '../mesh-renderer.js';
import {cadBodyColor,featurePlacement,wholePartBox} from '../cad-plan.js';
import {importedPartAnchors} from '../part-records.js';
import {assetRoot} from './source-files.mjs';
import {resolvedCatalogGeometry} from './design-references.mjs';
const decode=bytes=>decodeSTL(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
function middleOf(meshes){
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const m of meshes)for(const f of m.triangles)for(const p of f)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
  return min.map((v,k)=>(v+max[k])/2);
}
function chunk(name,data){const n=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([n,data])));return Buffer.concat([len,n,data,crc]);}
function png(data,w,h){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  const rows=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)Buffer.from(data.buffer,data.byteOffset+y*w*4,w*4).copy(rows,y*(w*4+1)+1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
// Uses the very same depth-tested triangle renderer as the product viewer.
export async function designVisuals(design,compiled,env={}){
  const anchors=importedPartAnchors(design.cadPlan.bodies,design.parts),references=new Map(resolvedCatalogGeometry(design).map(r=>[r.bodyIndex,r]));
  const all=[],importedMeshes=new Map();
  for(const [i,b]of (compiled?.bodies||[]).entries()){
    const part=design.parts[b.partIndex];let meshes,anchor;
    if(anchors[i]){
      const id=part.importedModel.id;
      if(!importedMeshes.has(id))importedMeshes.set(id,JSON.parse(await readFile(join(assetRoot(env),id,'mesh.json'),'utf8')).meshes);
      const whole=importedMeshes.get(id);
      anchor=anchors[i];meshes=anchor.meshIndices?anchor.meshIndices.map(index=>whole[index]):whole;
      if(meshes.some(mesh=>!mesh))throw Error('原厂模型文件缺少已检查的分件。');
    }else if(references.has(i)){
      const dir=new URL('../assets/hardware/'+catalog[part.modelId].dir+'/',import.meta.url),meta=JSON.parse(await readFile(new URL('metadata.json',dir),'utf8'));
      meshes=await Promise.all(meta.meshes.map(async m=>({triangles:decode(await readFile(new URL(m.file,dir))),color:m.color||[85,116,101]})));
      anchor=wholePartBox(design.cadPlan.bodies[i]);
    }
    if(meshes&&anchor){
      const place=featurePlacement(anchor,anchor.sourceOriginMm||middleOf(meshes));
      for(const [j,m]of meshes.entries())all.push({id:i+':'+j,partIndex:b.partIndex,mesh:prepareMesh(m.triangles.map(f=>f.map(place)),m.color||[88,101,119]),offset:b.positionMm});
    }else {
      const fallback=b.role==='printed'?[185,192,200]:/板|控制|board/i.test(part.name)?[49,115,88]:[88,101,119];
      const color=cadBodyColor(design.cadPlan.bodies[i],fallback);
      all.push({id:String(i),partIndex:b.partIndex,mesh:prepareMesh(decode(Buffer.from(b.stlBase64,'base64')),color),offset:b.positionMm});
    }
  }
  if(!all.length)return [];
  globalThis.devicePixelRatio??=1;
  return [['iso',-.65,.6],['front',Math.PI,0],['right',Math.PI/2,0],['top',0,Math.PI/2],['inside',-.65,.65]].map(([name,yaw,pitch])=>{
    let pixels;const w=720,h=520;
    const ctx={createImageData:()=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{pixels=image.data;}};
    const canvas={getContext:()=>ctx,getBoundingClientRect:()=>({width:w,height:h})};
    const interior=name==='inside',shells=all.filter(o=>design.parts[o.partIndex].role==='enclosure');
    const scene=interior?all.filter(o=>!shells.includes(o)):all;
    const camera=fitCamera(all,yaw,pitch,{x:20,y:20,width:w-40,height:h-40});createRaster(canvas).draw(scene,camera,interior?shells:[]);
    for(let i=0;i<pixels.length;i+=4){const a=pixels[i+3]/255;for(let k=0;k<3;k++)pixels[i+k]=Math.round(pixels[i+k]*a+246*(1-a));pixels[i+3]=255;}
    return {name,dataUrl:'data:image/png;base64,'+png(pixels,w,h).toString('base64'),scope:'compiled-cad-and-loaded-references',bodyCount:compiled.bodies.length};
  });
}
