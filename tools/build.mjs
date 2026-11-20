import { mkdir, readdir, cp, rm } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
const entries=await readdir('.');
const publicFiles=['index.html','style.css','app.js','studio.js','mechanical.js','mechanical.css','cart-ui.js','wiring.js','wiring.css','samples','forge'];
for(const file of publicFiles.filter(f=>entries.includes(f))) await cp(file,'dist/'+file,{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|\.[^/]+|__pycache__)(?:\/|$)/.test(p)});
// The UI lists only authoring files and geometry actually present in this build.
const {writeFile,mkdir:mkdirPublic}=await import('node:fs/promises');
const listForge=async(dir,rel='')=>{const paths=[];for(const d of await readdir(dir,{withFileTypes:true})){const sub=rel+d.name;if(d.isDirectory())paths.push(...await listForge(dir+'/'+d.name,sub+'/'));else if(/(?:\.forge\.js|\.(?:stl|step|stp|glb|iges|brep|3mf))$/i.test(d.name))paths.push(sub);}return paths;};
await mkdirPublic('dist/forge',{recursive:true});await writeFile('dist/forge/assets.json',JSON.stringify((await listForge('dist/forge')).sort()));
