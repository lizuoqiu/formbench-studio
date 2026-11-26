import URDFLoader from 'urdf-loader';

const children=(node,tag)=>[...node.children].filter(n=>n.localName===tag);
const child=(node,tag)=>children(node,tag)[0];
const movable=new Set(['revolute','prismatic','continuous']);
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
function tuple(value,context){
 if(value===null)return null;
 const tokens=value.trim().split(/\s+/),numbers=tokens.map(Number);
 if(tokens.length!==3||!tokens.every(t=>decimal.test(t))||!numbers.every(Number.isFinite))throw Error(context+' 须有三个有效数值。');
 return numbers;
}
function numeric(value,context){
 if(value===null)return null;
 if(!decimal.test(value.trim())||!Number.isFinite(Number(value)))throw Error(context+' 数值无效。');
 return Number(value);
}

export function readUrdf(text){
 const doc=new DOMParser().parseFromString(text,'application/xml'),root=doc.documentElement;
 if(root.localName!=='robot'||doc.querySelector('parsererror'))throw Error('文件不是有效的 URDF <robot> 文档。');
 if([...root.getElementsByTagName('*')].some(n=>n.prefix==='xacro')||/\$\{[^}]*\}/.test(text))throw Error('请先用 RobotCAD 或 ROS 展开 Xacro，再选择导出的 URDF。');
 const linkNodes=children(root,'link'),jointNodes=children(root,'joint');
 const links=new Set(),jointNames=new Set(),parents=new Map();
 function register(node,names){
  const name=node.getAttribute('name');
  if(!name||names.has(name)||Object.hasOwn(Object.prototype,name)||/["\\]/.test(name))throw Error('连杆或关节名称为空、重复或无法解析：'+(name??''));
  names.add(name);return name;
 }
 linkNodes.forEach(node=>register(node,links));
 if(!links.size)throw Error('文件中没有连杆。');
 const joints=jointNodes.map(node=>{
  const name=register(node,jointNames),type=node.getAttribute('type'),from=child(node,'parent')?.getAttribute('link'),to=child(node,'child')?.getAttribute('link');
  if(!['fixed','revolute','prismatic','continuous','floating','planar'].includes(type))throw Error(name+' 的关节类型无效。');
  if(!links.has(from)||!links.has(to)||parents.has(to))throw Error(name+' 的父子连杆不存在或子连杆已有父级。');
  parents.set(to,from);
  const origin=child(node,'origin');
  if(origin){tuple(origin.getAttribute('xyz'),name+' origin xyz');tuple(origin.getAttribute('rpy'),name+' origin rpy');}
  // Fixed and floating joints have no single motion axis. Exporters may
  // serialize a zero vector here; keep the declared link transform intact.
  if(type==='fixed'||type==='floating')child(node,'axis')?.remove();
  const axisNode=child(node,'axis'),axis=axisNode?tuple(axisNode.getAttribute('xyz'),name+' axis'):null;
  if(axisNode&&(!axis||Math.hypot(...axis)===0))throw Error(name+' 的 axis 缺失或为零。');
  if(axis)axisNode.setAttribute('xyz',axis.join(' '));
  const limit=child(node,'limit'),lower=numeric(limit?.getAttribute('lower')??null,name+' lower'),upper=numeric(limit?.getAttribute('upper')??null,name+' upper');
  if(lower!==null&&upper!==null&&lower>upper)throw Error(name+' 的上下限顺序错误。');
  const mimicNode=child(node,'mimic'),mimic=mimicNode?.getAttribute('joint');
  if(mimicNode){if(!mimic)throw Error(name+' 缺少 mimic 源关节。');numeric(mimicNode.getAttribute('multiplier'),name+' mimic multiplier');numeric(mimicNode.getAttribute('offset'),name+' mimic offset');}
  return {name,type,from,to,axis,lower,upper,mimic,movable:movable.has(type),canDrive:!mimic&&movable.has(type)&&(type==='continuous'||lower!==null&&upper!==null&&upper>lower)};
 });
 const roots=[...links].filter(n=>!parents.has(n));
 if(roots.length!==1)throw Error('需要一个根连杆；当前模型有 '+roots.length+' 个。');
 const verified=new Set(roots);
 for(const link of links){const path=new Set();let next=link;while(!verified.has(next)){if(path.has(next))throw Error('关节链包含闭环，无法作为 URDF 树预览。');path.add(next);next=parents.get(next);}for(const n of path)verified.add(n);}
 for(const j of joints)if(j.mimic&&!jointNames.has(j.mimic))throw Error(j.name+' 的 mimic 引用了未知关节。');
 // Keep texture/material declarations out of the upstream parser: no URLs in
 // a user-provided description are fetched by this kinematics-only view.
 children(root,'material').forEach(n=>n.remove());
 const loader=new URDFLoader();loader.parseVisual=false;loader.parseCollision=false;
 let model;
 try{model=loader.parse(root);}
 catch(error){if(error.message.includes('infinite loop of mimic joints'))throw Error('mimic 关节之间存在循环引用。');throw error;}
 for(const j of joints)if(j.movable&&!j.mimic){
  const zero=j.type!=='continuous'&&j.lower!==null&&j.upper!==null?Math.max(j.lower,Math.min(0,j.upper)):0;
  model.setJointValue(j.name,zero);
 }
 model.updateMatrixWorld(true);
 return {model,joints,links:[...links],root:roots[0],name:root.getAttribute('name')||roots[0]};
}
