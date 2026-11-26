import {Vector3} from 'three';
import {readUrdf} from './urdf-model.js';

const $=id=>document.getElementById(id),canvas=$('scene'),ctx=canvas.getContext('2d');
let rig,selected,files=[],request=0,az=-.65,el=.4,scale=1,span=1,target=new Vector3(),pointer;
const rows=new Map();
const node=(tag,value='')=>Object.assign(document.createElement(tag),{textContent:value});
const pos=link=>rig.model.links[link].getWorldPosition(new Vector3());
const rounded=v=>Number(v.toFixed(3));
const coordinates=v=>v.toArray().map(rounded).join(', ');
const factor=j=>j.type==='prismatic'?1000:180/Math.PI;
const unit=j=>j.type==='prismatic'?'mm':'°';
const home=j=>j.type==='continuous'?0:Math.max(j.lower,Math.min(j.upper,0));
const info=(text,error=false)=>{ $('status').textContent=text;$('status').classList.toggle('error',error); };

function fit(){
 if(!rig)return;
 const points=rig.links.map(pos);
 const min=new Vector3(Infinity,Infinity,Infinity),max=new Vector3(-Infinity,-Infinity,-Infinity);
 for(const p of points){min.min(p);max.max(p);}
 target.copy(min).add(max).multiplyScalar(.5);
 // Include prismatic travel when all link frames coincide in the home pose.
 span=Math.max(min.distanceTo(max),...rig.joints.filter(j=>j.type==='prismatic'&&j.canDrive).map(j=>j.upper-j.lower),.01);
 scale=1;draw();
}
function draw(){
 if(!rig)return;
 const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
 const dpr=window.devicePixelRatio||1,pixels=Math.min(w,h)*.72*scale/span;
 if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
 const project=p=>{
  const {x,y,z}=p.clone().sub(target),ca=Math.cos(az),sa=Math.sin(az);
  return [w/2+pixels*(ca*x-sa*y),h/2-pixels*(Math.cos(el)*z-Math.sin(el)*(sa*x+ca*y))];
 };
 const line=(a,b,color,width)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...project(a));ctx.lineTo(...project(b));ctx.stroke();};
 const label=(p,text,color)=>{const [x,y]=project(p);ctx.fillStyle=color;ctx.font='13px system-ui';ctx.fillText(text,x+5,y-5);};
 rig.model.updateMatrixWorld(true);
 for(const j of rig.joints)line(pos(j.from),pos(j.to),j===selected?'#dc8241':'#497864',j===selected?5:3);
 const frameLength=span*.12,active=selected?.to||rig.root,activeLink=rig.model.links[active];
 for(const link of rig.links){
  const p=pos(link),[x,y]=project(p);ctx.beginPath();ctx.arc(x,y,link===active?5:3,0,Math.PI*2);ctx.fillStyle=link===active?'#af642c':'#254537';ctx.fill();
 }
 for(const [direction,color,name] of [[[1,0,0],'#b64035','X'],[[0,1,0],'#30804e','Y'],[[0,0,1],'#276bac','Z']]){
  const end=activeLink.localToWorld(new Vector3(...direction).multiplyScalar(frameLength));
  line(pos(active),end,color,2);label(end,name,color);
 }
 label(pos(rig.root),rig.root,'#344b3e');
 if(selected?.movable){
  const obj=rig.model.joints[selected.name],p=obj.getWorldPosition(new Vector3()),end=obj.localToWorld(obj.axis.clone().multiplyScalar(frameLength*1.5));
  ctx.setLineDash([5,3]);line(p,end,'#784794',2);ctx.setLineDash([]);label(end,'轴','#784794');
 }
 $('coordinates').textContent=active+' · 位置 ['+coordinates(pos(active).multiplyScalar(1000))+'] mm';
}
const typeNames={fixed:'固定',revolute:'旋转',continuous:'连续旋转',prismatic:'直线',floating:'浮动',planar:'平面'};
function refresh(){
 for(const j of rig.joints){
  const row=rows.get(j.name);row.button.setAttribute('aria-pressed',String(selected===j));
  if(j.movable&&row.output){const raw=rig.model.joints[j.name].angle;row.output.value=rounded(raw*factor(j))+' '+unit(j);if(row.slider)row.slider.value=String(raw*factor(j));}
 }draw();
}
function showRig(data){
 rig=data;selected=rig.joints.find(j=>j.canDrive)||rig.joints[0];
 $('workspace').hidden=false;$('name').textContent=rig.name;$('summary').textContent=rig.links.length+' 个连杆 · '+rig.joints.length+' 个关节 · 根连杆 '+rig.root;
 $('joints').replaceChildren();rows.clear();
 for(const j of rig.joints){
  const card=node('div');card.className='joint';const button=node('button',j.name);button.type='button';button.onclick=()=>{selected=j;refresh();};
  card.append(button,node('small',j.from+' → '+j.to+' · '+typeNames[j.type]+' ('+j.type+')'));
  const axis=j.axis?'轴 ['+j.axis.join(', ')+']':'轴 [1, 0, 0]（URDF 默认）';
  const range=j.type==='continuous'?'无限位，滑杆显示一圈':j.lower!==null&&j.upper!==null?'限位 '+rounded(j.lower*factor(j))+' 至 '+rounded(j.upper*factor(j))+' '+unit(j):'未给出完整限位，无法拖动';
  let slider,output;
  if(j.movable){
   card.append(node('small',axis+' · '+range+(j.mimic?' · 跟随 '+j.mimic:'')));
   if(j.canDrive){
    slider=node('input');slider.type='range';
    const lo=j.type==='continuous'?-180:j.lower*factor(j),hi=j.type==='continuous'?180:j.upper*factor(j);
    slider.min=lo;slider.max=hi;slider.step='any';slider.setAttribute('aria-label',j.name+' '+unit(j));
    slider.oninput=()=>{selected=j;rig.model.setJointValue(j.name,Number(slider.value)/factor(j));refresh();};
    card.append(slider);
   }
   output=node('output');card.append(output);
  }else if(j.type!=='fixed')card.append(node('small','当前仅显示零位关系'));
  rows.set(j.name,{button,slider,output});$('joints').append(card);
 }
 fit();refresh();
}
async function openFile(file){
 const run=++request;rig=null;$('workspace').hidden=true;
 if(!file){info('文件夹中未找到 .urdf 文件。Xacro 需要先展开。',true);return;}
 info('正在读取 '+file.name);
 try{
  const text=await file.text();if(run!==request)return;
  const model=readUrdf(text);showRig(model);info('已打开 '+(file.webkitRelativePath||file.name));
 }catch(e){if(run===request){rig=null;$('workspace').hidden=true;info(e.message||'无法解析 URDF。',true);}}
}
function listFiles(input){
 files=[...input].filter(f=>/\.urdf(?:\.xml)?$/i.test(f.name)).sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath));
 $('files').replaceChildren(...files.map((f,i)=>{const o=node('option',f.webkitRelativePath||f.name);o.value=i;return o;}));
 $('picker').hidden=files.length<2;openFile(files[0]);
}
$('file').onchange=e=>{const f=e.target.files[0];if(f){$('picker').hidden=true;openFile(f);}e.target.value='';};
$('folder').onchange=e=>{if(e.target.files.length)listFiles(e.target.files);e.target.value='';};
$('files').onchange=e=>openFile(files[Number(e.target.value)]);
$('fit').onclick=fit;$('reset').onclick=()=>{for(const j of rig.joints)if(j.canDrive)rig.model.setJointValue(j.name,home(j));refresh();};
canvas.onpointerdown=e=>{pointer=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);};
canvas.onpointermove=e=>{if(!pointer)return;az+=(e.clientX-pointer[0])*.009;el=Math.max(-1.53,Math.min(1.53,el+(e.clientY-pointer[1])*.009));pointer=[e.clientX,e.clientY];draw();};
canvas.onlostpointercapture=()=>{pointer=null;};canvas.onpointerup=canvas.onpointercancel=()=>{pointer=null;};
canvas.addEventListener('wheel',e=>{e.preventDefault();scale=Math.max(.2,Math.min(8,scale*Math.exp(-e.deltaY*.002)));draw();},{passive:false});
new ResizeObserver(draw).observe(canvas);
