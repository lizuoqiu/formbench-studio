import { mkdir,readdir,cp,rm,writeFile } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
for(const name of ['index.html','style.css','app.js','studio.js','mechanical.js','mechanical.css','wiring.js','wiring.css','samples'])await cp(name,'dist/'+name,{recursive:true});
await mkdir('dist/forge');
const assets=(await readdir('forge',{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})).filter(d=>d.isFile()&&/^pico-[\w-]+\.(forge\.js|stl|step|stp|glb|3mf)$/i.test(d.name)).map(d=>d.name).sort();
for(const name of assets)await cp('forge/'+name,'dist/forge/'+name);
await writeFile('dist/forge/assets.json',JSON.stringify(assets));
