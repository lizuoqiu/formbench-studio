import {readFile} from 'node:fs/promises';
import vendor from './skills/forgecad-vendor.json' with {type:'json'};

async function loadProjectGuide(name,env){
 const sourcePath='skills/'+name+'/SKILL.md';
 let text;
 if(env.ASSETS){
  const response=await env.ASSETS.fetch(new Request('https://formbench.invalid/'+sourcePath));
  if(!response.ok)throw Error('Missing skill: '+name);
  text=await response.text();
 }else text=await readFile(new URL(sourcePath,import.meta.url),'utf8');
 const end=text.indexOf('\n---\n',4);
 if(end<0||!text.startsWith('---\nname: '+name+'\n'))throw Error('Invalid skill: '+name);
 const header=text.slice(0,end);
 const metadata=/^metadata:\n((?: +[^\n]*(?:\n|$))+)/m.exec(header)?.[1]||'';
 // Older published copies used a top-level revision. Preserve their receipts.
 const revision=/^ +revision: ([\w.-]+)$/m.exec(metadata)?.[1]||/^revision: ([\w.-]+)$/m.exec(header)?.[1];
 if(!revision)throw Error('Missing skill revision: '+name);
 return {text,skill:{name,revision,sourcePath}};
}

export function functionalReviewGuide(env={}){
 return loadProjectGuide('functional-review',env);
}

export async function modelingGuide(env={}){
 if(!vendor.text?.trim()||!vendor.revision||!vendor.sourceUrl)throw Error('Missing versioned modeling instruction');
 const project=await loadProjectGuide('interaction-hardware',env);
 return {
  skill:{name:'ForgeCAD · 官方建模指导',revision:vendor.revision,sourceUrl:vendor.sourceUrl,project:project.skill},
  text:vendor.text+'\n\n工作台通过受限的结构化几何接口实现上述设计。遵循本项目的交互与装配规范。\n'+project.text
 };
}
export function generation(provider,model,source,skill){const id=typeof model==='string'&&/^[\w][\w.:-]{0,160}$/.test(model)?model:null;return {provider,modelId:id,modelSource:id?source:'undisclosed',skill};}
