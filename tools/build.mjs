import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
await rm('dist/blueprint-pico-main.py',{force:true});
await mkdir('dist',{recursive:true});
for(const file of ['index.html','style.css','app.js']) await copyFile(file,`dist/${file}`);
await cp('samples','dist/samples',{recursive:true});
