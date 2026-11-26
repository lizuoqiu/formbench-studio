import {encodeSTL} from './assembly-hardware.js';
import {occurrenceGroups} from './installed-parts.js';
import {zipSync} from './assets/fflate/zip-0.8.3.js';

// One file per physical unit. Preserve the relative position of shells within that unit,
// but remove its arbitrary position in the complete assembly.
export function fabricationPackage(design,geometry){
 if(!geometry?.exact)throw Error('请等待精确实体计算完成，再下载加工文件。');
 const entries={},parts=[];
 design.parts.forEach((part,idx)=>{
  if(part.kind!=='custom')return;
  const {groups,unknown}=occurrenceGroups(geometry,part,idx),files=[];
  if(unknown.length||groups.size!==part.qty)throw Error('「'+part.name+'」的加工件数量或归属尚未核对，暂不能导出。');
  for(const [copy,ids] of [...groups].sort((a,b)=>a[0]-b[0])){
   const bodies=ids.map(i=>geometry.bodies[i]),anchor=bodies[0].positionMm;
   const file=`parts/part-${idx+1}-${copy+1}.stl`;
   if(!bodies.every(b=>b.exact&&b.meshes?.length&&b.meshes.every(m=>m.triangles?.length)))throw Error('「'+part.name+'」的实体网格不完整。');
   const faces=bodies.flatMap(b=>b.meshes.flatMap(m=>m.triangles.map(t=>t.map(p=>p.map((v,k)=>v+b.positionMm[k]-anchor[k])))));
   entries[file]=new Uint8Array(encodeSTL(faces,'FormBench custom component, mm; quotation only'));
   files.push({file,quantity:1,bodies:bodies.map(b=>b.name)});
  }
  const spec=String(part.spec||''),material=part.material||[...new Set((spec+' '+(part.model||'')).match(/\b(?:PETG|PLA\+?|ABS|TPU|ASA|PA12|PMMA|POM)\b|亚克力|聚碳酸酯|铝合金|硅胶/gi)||[])].join(' / ')||'未指定，请确认';
  parts.push({name:part.name,model:part.model||'',material,spec,quantity:part.qty,files});
 });
 if(!parts.length)throw Error('这个设计没有委托加工件。');
 const manifest={design:design.name,units:'mm',purpose:'加工询价；每个文件制作一件，不再乘以清单数量。多实体文件须由厂商核对。未排产，未验证实物。',parts};
 entries['manifest.json']=new TextEncoder().encode(JSON.stringify(manifest,null,2));
 return {entries,manifest};
}
export const fabricationZip=(design,geometry)=>zipSync(fabricationPackage(design,geometry).entries,{level:5});
