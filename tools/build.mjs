import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import { mkdir,readdir,cp,rm,writeFile,readFile } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
for(const page of ['workbench.html','consumer.js','consumer.css','consumer-account.css','consumer-gallery.css','consumer-gallery.js','consumer-design-images.css','consumer-design-images.js','consumer-entry.css','consumer-workspace.css','consumer-viewer.css','consumer-interaction.css','consumer-interaction.js','consumer-wiring.js','assembly-wires.js','assembly-pin-anchors.js','panel-hardware-reference.js','purchased-body-details.js','forge-package.js','interaction-model.js','workbench-ui.css','consumer-account.js','consumer-cad.js','consumer-geometry.js','forge-source.js','forge-joints.js','native-features.js','cad-plan.js','cad-plan-compiler.js','cad-worker.js','consumer-service.js'])await cp(page,'dist/'+page);
await cp('assets/ui','dist/assets/ui',{recursive:true});
await cp('assets/fflate','dist/assets/fflate',{recursive:true});
await cp('assets/xstate-fsm','dist/assets/xstate-fsm',{recursive:true});
await cp('assets/manifold-3d','dist/assets/manifold-3d',{recursive:true});
for(const skill of ['interaction-hardware','functional-review'])await cp('server/skills/'+skill,'dist/skills/'+skill,{recursive:true});
const helperFiles=(await readdir('extension',{withFileTypes:true})).filter(f=>f.isFile()&&/^[\w-]+\.(?:html|css|js|json|png)$/.test(f.name)).map(f=>f.name).sort();
for(const file of ['manifest.json','bridge.js','background.js','product.js','confirm.html','confirm.js'])if(!helperFiles.includes(file))throw Error('Missing browser helper file: '+file);
const helperArchive=resolve('dist/taobao-helper.zip');
if(process.platform==='win32'){
  execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath ${helperFiles.map(f=>"'"+f+"'").join(',')} -DestinationPath '${helperArchive.replaceAll("'","''")}'`],{cwd:'extension'});
}else{
  execFileSync('zip',['-q','-X',helperArchive,...helperFiles],{cwd:'extension'});
}
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
