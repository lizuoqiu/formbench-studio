import {editableForgeSource} from './forge-source.js';

// Pack only dependencies selected by our catalog registration. A plain design
// needs no archive or compression library and keeps its standalone source.
export async function editableForgeDownload(plan,parts,bodyIndex=null,interaction=null,wiring=null){
  const externalAssets=[];
  const source=await editableForgeSource(plan,parts,bodyIndex,interaction,wiring,{externalAssets});
  if(!externalAssets.length){
    const blob=new Blob([source],{type:'text/javascript;charset=utf-8'});
    return {blob,extension:'.forge.js'};
  }
  const encoder=new TextEncoder();
  const entries={'main.forge.js':encoder.encode(source),'forgecad.json':encoder.encode('{}\n')};
  const paths=new Set();
  for(const asset of externalAssets)for(const file of asset.files){
    paths.add('assets/hardware/'+asset.id+'/'+file);
  }
  const [{zipSync}]=await Promise.all([import('./assets/fflate/zip-0.8.3.js'),...Array.from(paths,async path=>{
    const response=await fetch(new URL('./'+path,import.meta.url),{mode:'same-origin',redirect:'error'});
    if(!response.ok||response.headers.get('Content-Type')?.includes('text/html')){
      throw Error('整机 CAD 包缺少依赖文件 '+path.split('/').at(-1)+'，请重试下载。');
    }
    entries[path]=new Uint8Array(await response.arrayBuffer());
  })]);
  const bytes=zipSync(entries,{level:6});
  return {blob:new Blob([bytes],{type:'application/zip'}),extension:'.zip'};
}
