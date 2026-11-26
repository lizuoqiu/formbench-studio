import {validateCadPlan,wholePartBox} from './cad-plan.js';
import {encodeSTL} from './assembly-hardware.js';

const text=value=>new TextEncoder().encode(value);
const number=value=>Number(value.toPrecision(12)).toString();
const metres=vector=>vector.map(mm=>number(mm/1000)).join(' ');
const offset=(point,origin)=>point.map((v,i)=>v-origin[i]);
const baseFrame={name:'base_link',origin:[0,0,0]};
const radians=degrees=>degrees*Math.PI/180;
const unit=axis=>axis.map(value=>value/Math.hypot(...axis));

function mechanicalFrames(plan){
 validateCadPlan(plan);
 const {joints=[],motions=[]}=plan;
 if(!joints.length&&!motions.length)throw Error('该装配未定义旋转关节或直线行程。');
 const frames=[],owners=plan.bodies.map(()=>baseFrame);
 for(const [i,joint] of joints.entries()){
  const parent=joint.parentIndex===null?baseFrame:frames[joint.parentIndex];
  const frame={name:'link_r'+(i+1),joint:'joint_r'+(i+1),label:joint.name,type:'revolute',parent,
   origin:joint.pivotMm,axis:unit(joint.axis),lower:radians(joint.minDegrees),upper:radians(joint.maxDegrees)};
  for(const body of joint.movingBodyIndices)owners[body]=frame;
  frames.push(frame);
 }
 for(const [i,joint] of joints.entries()){
  if(owners[joint.fixedBodyIndex]!==frames[i].parent)throw Error(joint.name+' 的固定件不归其直接父连杆，无法确定 URDF 运动树。');
 }
 for(const [i,motion] of motions.entries()){
  const parent=motion.parentJointIndex==null?baseFrame:frames[motion.parentJointIndex];
  const moving=new Set(motion.movingBodyIndices);
  if(motion.movingBodyIndices.some(n=>owners[n]!==parent)||joints.some(j=>moving.has(j.fixedBodyIndex)))
   throw Error(motion.name+' 与旋转链共用实体，当前设计缺少明确的直线轴父子关系。');
  const frame={name:'link_p'+(i+1),joint:'joint_p'+(i+1),label:motion.name,type:'prismatic',parent,
   // The web slider translates by the supplied vector times travelMm. URDF
   // normalizes its axis; carry any rounding of that vector into the range.
   origin:plan.bodies[motion.movingBodyIndices[0]].positionMm,axis:unit(motion.axis),lower:0,upper:motion.travelMm*Math.hypot(...motion.axis)/1000};
  for(const index of moving)owners[index]=frame;
  frames.push(frame);
 }
 return {frames,owners};
}

// Drive the project panel and URDF exporter from the same body ownership tree.
export function mechanismConnections(plan){
 const {frames,owners}=mechanicalFrames(plan),links=new Map();
 for(const frame of [baseFrame,...frames])links.set(frame,{id:frame.name,bodies:[]});
 owners.forEach((frame,i)=>links.get(frame).bodies.push(i));
 for(const [frame,link] of links){
  const [first,...rest]=link.bodies;
  link.label=frame===baseFrame?'固定部分':first===undefined?frame.label+'的输出连杆':
   plan.bodies[first].name+(rest.length?'等 '+link.bodies.length+' 件':'');
 }
 const rows=frames.map(f=>({parent:links.get(f.parent),child:links.get(f)}));
 const n=plan.joints?.length||0;
 return {joint:rows.slice(0,n),travel:rows.slice(n)};
}

export function kinematicUrdfFiles(plan,instances=[],projectName=''){
 const {frames,owners}=mechanicalFrames(plan);
 const installed=new Map(instances.filter(item=>item.placed).map(item=>[item.bodyIndex,item]));
 const files={},links=[],bodyRecords=[];
 for(const frame of [baseFrame,...frames]){
  const visuals=[];
  plan.bodies.forEach((body,index)=>{
   if(owners[index]!==frame)return;
   const item=installed.get(index);
   const record={bodyIndex:index,name:body.name,partIndex:body.partIndex,link:frame.name};
   bodyRecords.push(record);
   if(!item?.exact||!item.meshes?.length){record.visual='unavailable';return;}
   if(item.source!=='catalog'&&wholePartBox(body)){record.visual='reference-envelope-omitted';return;}
   const filename='meshes/body_'+(index+1)+'.stl';
   const faces=item.meshes.flatMap(mesh=>mesh.triangles);
   if(!faces.length){record.visual='unavailable';return;}
   files[filename]=new Uint8Array(encodeSTL(faces,'FormBench resting body geometry (mm)'));
   record.visual=item.source==='catalog'?'source-model':'compiled-design';record.mesh=filename;
   const color=item.meshes[0].color;
   const material=Array.isArray(color)&&color.length===3&&color.every(v=>Number.isFinite(v)&&v>=0&&v<=255)
    ?'<material name="body_'+(index+1)+'_color"><color rgba="'+color.map(v=>number(v/255)).join(' ')+' 1"/></material>':'';
   visuals.push('    <visual name="body_'+(index+1)+'"><origin xyz="'+metres(offset(body.positionMm,frame.origin))+'"/><geometry><mesh filename="'+filename+'" scale="0.001 0.001 0.001"/></geometry>'+material+'</visual>');
  });
  links.push(visuals.length?'  <link name="'+frame.name+'">\n'+visuals.join('\n')+'\n  </link>':'  <link name="'+frame.name+'"/>');
 }
 const xmlJoints=frames.map(frame=>[
  '  <joint name="'+frame.joint+'" type="'+frame.type+'">',
  '    <parent link="'+frame.parent.name+'"/><child link="'+frame.name+'"/>',
  '    <origin xyz="'+metres(offset(frame.origin,frame.parent.origin))+'"/><axis xyz="'+frame.axis.map(number).join(' ')+'"/>',
  '    <limit lower="'+number(frame.lower)+'" upper="'+number(frame.upper)+'"/>',
  '  </joint>'
 ].join('\n'));
 files['model.urdf']=text(['<?xml version="1.0" encoding="UTF-8"?>','<robot name="formbench_mechanism" version="1.2">',...links,...xmlJoints,'</robot>',''].join('\n'));
 files['assembly.json']=text(JSON.stringify({project:projectName,scope:'kinematics',joints:frames.map(f=>({joint:f.joint,label:f.label,
  type:f.type,parentLink:f.parent.name,childLink:f.name})),bodies:bodyRecords},null,2));
 files['README.txt']=text('运动学 URDF 1.2\n解压后用支持 URDF 1.2 的查看器打开 model.urdf，保留 meshes 子目录。assembly.json 列出关节名称、BOM 索引、各连杆直接拥有的实体和几何来源。\n旋转限位以弧度表示，直线行程以米表示。STL 使用毫米，URDF 写入换算比例。模型使用网页装配零位，保留已定位且已加载的原厂或编译几何。包络和无法核实的预览件仅记录装配归属。\n此文件描述装配的旋转轴和直线行程。按钮和软件事件另见工作台。质量、惯量、额定速度、扭矩和碰撞几何未提供。\n');
 return files;
}

export async function kinematicUrdfZip(plan,instances,projectName){
 const files=kinematicUrdfFiles(plan,instances,projectName);
 const {zipSync}=await import('./assets/fflate/zip-0.8.3.js');
 return zipSync(files,{level:4});
}
