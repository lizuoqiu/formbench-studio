import test from 'node:test';
import assert from 'node:assert/strict';
import {kinematicUrdfFiles} from '../kinematic-urdf.js';
import {decodeSTL} from '../assembly-hardware.js';
import {jointPoint} from '../assembly-joints.js';
import {bodyPose} from '../consumer-cad.js';

const arm=()=>{
 const bodies=['base','shoulder','wrist','gripper','external slide'].map((name,i)=>({name,partIndex:i,role:'printed',positionMm:[10,20+20*i,30],
  features:[{op:'add',shape:'box',sizeMm:[2,4,6],centerMm:[0,0,0],rotationDeg:[0,0,0]}]}));
 const joints=[{name:'rotation',parentIndex:null,axis:[0,0,1],pivotMm:[10,20,20],minDegrees:-90,maxDegrees:90,
  actuatorPartIndex:0,fixedBodyIndex:0,movingBodyIndices:[1,2,3]},{
  name:'wrist',parentIndex:0,axis:[1,0,0],pivotMm:[10,60,25],minDegrees:-30,maxDegrees:45,
  actuatorPartIndex:1,fixedBodyIndex:1,movingBodyIndices:[2,3]}];
 const motions=[{type:'prismatic',name:'slide',axis:[0,1,0],travelMm:16,movingBodyIndices:[4],actuatorPartIndex:0,guidePartIndex:0,controllerPartIndex:0}];
 return {version:1,bodies,joints,motions};
};
const triangles=[[[0,0,0],[1,0,0],[0,1,0]]];
const instances=plan=>plan.bodies.map((_,bodyIndex)=>({placed:true,exact:true,bodyIndex,source:'generated',meshes:[{triangles,color:[36,84,24]}]}));
const xml=file=>new TextDecoder().decode(file);
test('URDF zero frames, direct ownership, signed limits and local mm meshes match a rotary tree with a separate slide',()=>{
 const p=arm(),mesh=instances(p);
 p.bodies[3].role='reference';
 mesh[0].placed=false;
 const files=kinematicUrdfFiles(p,mesh),doc=xml(files['model.urdf']),map=JSON.parse(xml(files['assembly.json']));
 assert.match(doc,/version="1\.2"/);
 assert.match(doc,/name="joint_r2" type="revolute">\s*<parent link="link_r1"\/><child link="link_r2"\/>\s*<origin xyz="0 0.04 0.005"\/><axis xyz="1 0 0"\/>/);
 assert.match(doc,/name="joint_p1" type="prismatic">\s*<parent link="base_link"\/><child link="link_p1"\/>\s*<origin xyz="0.01 0.1 0.03"\/><axis xyz="0 1 0"\/>\s*<limit lower="0" upper="0.016"\/>/);
 const limits=[...doc.matchAll(/<limit lower="([^"]+)" upper="([^"]+)"/g)].map(m=>m.slice(1).map(Number));
 assert.ok(Math.abs(limits[1][0]+Math.PI/6)<1e-10);
 assert.ok(Math.abs(limits[1][1]-Math.PI/4)<1e-10);
 assert.deepEqual(map.bodies.map(b=>[b.bodyIndex,b.link,b.visual]),[[0,'base_link','unavailable'],[1,'link_r1','compiled-design'],[2,'link_r2','compiled-design'],[3,'link_r2','reference-envelope-omitted'],[4,'link_p1','compiled-design']]);
 assert.match(doc,/<visual name="body_3"><origin xyz="0 0 0.005"\/><geometry><mesh filename="meshes\/body_3.stl" scale="0.001 0.001 0.001"/);
 assert.deepEqual(decodeSTL(files['meshes/body_3.stl'].buffer),triangles);
 assert.doesNotMatch(doc,/effort|velocity|collision|inertial/);
 assert.deepEqual(Object.keys(files).filter(p=>p.endsWith('.stl')).length,3);
});

test('overlapping rotary and prismatic memberships and cross-driven stationary mounts have no valid declared tree',()=>{
 for(const moving of [[1],[2,4],[0]]){
  const plan=arm();plan.motions[0].movingBodyIndices=moving;
  assert.throws(()=>kinematicUrdfFiles(plan),/直线轴父子关系/);
 }
 const p=arm();
 p.joints.push({...p.joints[1],name:'different wrist',movingBodyIndices:[1],fixedBodyIndex:2});
 assert.throws(()=>kinematicUrdfFiles(p),/直接父连杆/);
});

test('rounded diagonal axes round-trip the web joint pose and slider endpoint',()=>{
 const plan=arm(),diagonal=[.707,.707,0];
 plan.joints[0].axis=diagonal;plan.motions[0].axis=diagonal;
 const doc=xml(kinematicUrdfFiles(plan)['model.urdf']);
 const read=name=>{
  const section=doc.split('name="'+name+'" type="')[1].split('</joint>')[0];
  const axis=section.match(/<axis xyz="([^"]+)"/)[1].split(' ').map(Number);
  const upper=Number(section.match(/ upper="([^"]+)"/)[1]);
  assert.ok(Math.abs(Math.hypot(...axis)-1)<1e-10);
  return {axis,upper};
 };
 const r=read('joint_r1'),[x,y]=r.axis,pivot=plan.joints[0].pivotMm;
 const start=pivot.map((v,i)=>v+(i===0?1:0));
 // Rodrigues rotation of +X through 90° about the export's XY-axis.
 const turn=[x*x,x*y,-y].map((v,i)=>v+pivot[i]);
 assert.ok(Math.abs(r.upper-Math.PI/2)<1e-10);
 assert.ok(jointPoint(start,1,plan.joints,[90,0]).every((v,i)=>Math.abs(v-turn[i])<1e-10));
 const slide=read('joint_p1'),item={bodyIndex:4,positionMm:plan.bodies[4].positionMm};
 const end=bodyPose(item,plan.motions,[1]);
 assert.ok(end.every((v,i)=>Math.abs(v-(item.positionMm[i]+slide.axis[i]*slide.upper*1000))<1e-9));
});

test('a gripper opens in its wrist frame even with both positioning joints rotated',()=>{
 const p=arm();Object.assign(p.motions[0],{movingBodyIndices:[3],guidePartIndex:2,parentJointIndex:1});
 const doc=xml(kinematicUrdfFiles(p,instances(p))['model.urdf']);
 assert.match(doc,/joint_p1" type="prismatic">\s*<parent link="link_r2"\/><child link="link_p1"/);
 const pos=p.bodies[3].positionMm,start=jointPoint(pos,3,p.joints,[90,45]);
 const end=jointPoint(bodyPose({bodyIndex:3,positionMm:pos},p.motions,[1]),3,p.joints,[90,45]);
 assert.ok(Math.abs(Math.hypot(...end.map((v,i)=>v-start[i]))-16)<1e-6);assert.ok(Math.abs(end[2]-start[2])>10);
 p.motions[0].guidePartIndex=0;assert.throws(()=>kinematicUrdfFiles(p),/固定导向/);
});
