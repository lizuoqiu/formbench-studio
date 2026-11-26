import {readFile} from 'node:fs/promises';

export const officialRevision='7523f68ce05ec642608c7f2001c5ae7ca7b1bee0';
const routes={
  planning:['forgecad-design-spec'],
  sourcing:['forgecad-reconstruct-from-images'],
  modeling:['forgecad-design-spec','forgecad-build-model'],
  repair:['forgecad-design-spec','forgecad-inspect-model'],
  review:['forgecad-inspect-model','forgecad-grade-model'],
};
// Load complete relevant sections, not an arbitrary character prefix.
const sections={
  planning:['# Design Spec','## Phase 1'],
  sourcing:['# Reconstruct From Images','## Core Rule','## Workflow','## Done and Report'],
  modeling:null,
  repair:['# Design Spec','## Phase 2','## Workflow','## Misread Traps'],
  review:null,
};
const cache=new Map();
async function read(path,env){
  const key=(env.ASSETS?'assets:':'local:')+path;
  if(!cache.has(key))cache.set(key,env.ASSETS?env.ASSETS.fetch(new Request('https://formbench.invalid/skills/forgecad-official/'+path)).then(async r=>{if(!r.ok)throw Error('官方指导缺失：'+path);return r.text();}):readFile(new URL('./skills/forgecad-official/'+path,import.meta.url),'utf8'));
  return cache.get(key);
}
function extract(text,prefixes){
  if(!prefixes)return text;
  // The HLD section contains a fenced Markdown template. Its example headings
  // belong to the section; treating them as document boundaries loses the spec.
  const blocks=[];let lines=[],fence=null;
  for(const line of text.split('\n')){
    if(!fence&&/^#{1,2} /.test(line)){if(lines.length)blocks.push(lines.join('\n'));lines=[];}
    lines.push(line);
    const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;}
  }
  if(lines.length)blocks.push(lines.join('\n'));
  return blocks.filter(block=>prefixes.some(p=>block.startsWith(p))).join('\n');
}
export async function officialStageGuide(stage,env={}){
  const names=routes[stage]||[];
  const sources=[];const texts=[];
  for(const name of names){
    const path='skills/'+name+'/SKILL.md';
    // Detailed engineering belongs after measured parts are available. Do not
    // make intake solve exact interfaces before the sourcing stage has run.
    const selected=stage==='modeling'&&name==='forgecad-design-spec'?['## Phase 3']:sections[stage];
    texts.push(extract(await read(path,env),selected));
    sources.push({name,revision:officialRevision,sourceUrl:'https://github.com/ForgeCAD/forgecad-public-kit/blob/'+officialRevision+'/'+path});
  }
  if(stage==='modeling')for(const path of ['skills/forgecad/docs/guides/joint-design.md','skills/forgecad/docs/guides/positioning.md']){
    texts.push(await read(path,env));sources.push({name:path,revision:officialRevision});
  }
  const adapter=`工作流适配：上述内容是 ForgeCAD 官方方法参考。用户已授权 AI 自主作出工程决策，不要求用户审核 HLD/LLD、给出孔位/电机选型或执行技术修复；不虚构公司、人物、项目背景。工程决策及其理由写入本轮数据。当前运行时是 ForgeCAD CLI 0.8.2 和声明式 cadPlan：将官方关于真实外壳、内部结构、局部坐标、配合基准、先运动骨架后实体、检查再修复的方法落实到受支持的 JSON、编译和检查工具。新版文档中的命令/API 不代表当前运行时已执行。不得声称执行过没有提供结果的 inspect、verify、MuJoCo 或托管同步。保留可用原厂 CAD 作为采购件，仅在缺失或确需重建时重建。估算允许用于有合理依据的设计和可辨认模型，注明关键配合假设；有明确结构矛盾时必须修复。按调用方 schema 返回结果，不生成审批请求或改变任务目标。`;
  return {text:[...texts,adapter+' 本项目适配规则优先于上面原文中的人工审批、虚构使用背景或特定输出格式要求。'].join('\n\n'),sources};
}
