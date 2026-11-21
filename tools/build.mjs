import {gzipSync} from 'node:zlib';
import { mkdir,readdir,cp,rm,writeFile,readFile } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
for(const name of ['index.html','style.css','app.js','studio.js','mechanical.js','mechanical.css','mesh-renderer.js','assembly-hardware.js','part-geometry.js','model-selection.js','project-layout.js','assembly-handoff.js','hardware-library.js','hardware-library.css','wiring.js','wiring.css','frame.css','studio-entry.css','samples'])await cp(name,'dist/'+name,{recursive:true});
await mkdir('dist/forge');
const assets=(await readdir('forge',{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})).filter(d=>d.isFile()&&/^pico-[\w-]+\.(forge\.js|stl|step|stp|glb|3mf)$/i.test(d.name)).map(d=>d.name).sort();
for(const name of assets)await cp('forge/'+name,'dist/forge/'+name);
await writeFile('dist/forge/assets.json',JSON.stringify(assets));

// Preserve per-model source links and license notices alongside their public geometry.
await cp('assets/hardware','dist/assets/hardware',{recursive:true});
for(const folder of await readdir('dist/assets/hardware',{withFileTypes:true})){
  if(!folder.isDirectory())continue;
  const dir='dist/assets/hardware/'+folder.name+'/',metadata=JSON.parse(await readFile(dir+'metadata.json','utf8'));
  let changed=false;
  for(const mesh of metadata.meshes){
    const data=await readFile(dir+mesh.file);
    if(data.length<48*1024)continue;
    mesh.previewGzip=mesh.file+'.gz';
    await writeFile(dir+mesh.previewGzip,gzipSync(data,{level:9}));changed=true;
  }
  if(changed)await writeFile(dir+'metadata.json',JSON.stringify(metadata,null,2));
}
await cp('assets/cad-reader','dist/assets/cad-reader',{recursive:true});
const wasm=await readFile('assets/cad-reader/occt-import-js.wasm');
await writeFile('dist/assets/cad-reader/occt-import-js.wasm.gz',gzipSync(wasm,{level:9}));

// The same assets and transforms that power the viewer, for CAD tools consuming the BOM.
const {catalog,picoLayout}=await import('../assembly-hardware.js');
const records=await Promise.all(Object.values(catalog).map(async ({id,dir,label})=>{
  const folder='assets/hardware/'+dir+'/', raw=JSON.parse(await readFile(folder+'metadata.json','utf8'));
  return {id,label,model:raw.label,metadata:folder+'metadata.json',license:raw.license,source:raw.sourceUrl,
    geometry:raw.meshes.map(m=>({file:folder+m.file,role:m.role||m.label,color:m.role==='lens'?(id==='green-led'?[56,194,106]:[225,67,59]):m.color})),...(raw.stepFile?{step:folder+raw.stepFile}:{}),...(raw.sourceFile?{sourceFile:folder+raw.sourceFile}:{})};
}));
await writeFile('dist/hardware-catalog.json',JSON.stringify({units:'mm',models:records},null,2));
await writeFile('dist/pico-layout.json',JSON.stringify({units:'mm',axis:'Z up',hardwareCatalog:'hardware-catalog.json',
  note:'Translations below apply to the catalog preview STL coordinates in mm. Original STEP files use their own axes and origins; see each metadata file before import. Default Pico layout study, not a verified assembly or wiring plan.',
  shell:[{file:'forge/pico-base.stl',translationMm:[0,0,0]},{file:'forge/pico-lid.stl',rotationAboutXDegrees:180,translationMm:[0,32,19]}],
  instances:picoLayout.map(({id,instance,translationMm})=>({model:id,instance,translationMm})),
  unplaced:['usb-cable','wire','screw']},null,2));
