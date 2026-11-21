import {readFile} from 'node:fs/promises';
import vendor from './skills/forgecad-vendor.json' with {type:'json'};
const projectSkillPath='skills/interaction-hardware/SKILL.md';

export async function modelingGuide(env={}){
 if(!vendor.text?.trim()||!vendor.revision||!vendor.sourceUrl)throw Error('Missing versioned modeling instruction');
 let projectSkill;
 if(env.ASSETS){
  const response=await env.ASSETS.fetch(new Request('https://formbench.invalid/'+projectSkillPath));
  if(!response.ok)throw Error('Missing interaction design skill');
  projectSkill=await response.text();
 }else projectSkill=await readFile(new URL(projectSkillPath,import.meta.url),'utf8');
 if(!projectSkill.startsWith('---\nname: interaction-hardware\n'))throw Error('Invalid interaction design skill');
 return {
  skill:{name:'ForgeCAD · 官方建模指导',revision:vendor.revision,sourceUrl:vendor.sourceUrl},
  text:vendor.text+'\n\n工作台通过受限的结构化几何接口实现上述设计。遵循本项目的交互与装配规范。\n'+projectSkill
 };
}
export function generation(provider,model,source,skill){const id=typeof model==='string'&&/^[\w][\w.:-]{0,160}$/.test(model)?model:null;return {provider,modelId:id,modelSource:id?source:'undisclosed',skill};}
