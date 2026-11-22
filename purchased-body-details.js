// Secondary material groups leave the authored mechanical surfaces in place.
// The five documented encoder leads are separate from its two mounting tabs.
import {makeDocumentedProxy} from './part-geometry.js';

const pecDrawing='https://cdn-shop.adafruit.com/datasheets/pec11.pdf';
const encoderPads=[['A',-2.5,-7.5],['C',0,-7.5],['B',2.5,-7.5],['SW1',-2.5,7],['SW2',2.5,7]];
const close=(a,b,t=.12)=>Array.isArray(a)&&a.length===b.length&&a.every((n,k)=>Math.abs(n-b[k])<=t);
const box=(f,size)=>f.op==='add'&&f.shape==='box'&&close(f.sizeMm,size);
const alongY=f=>close(f.rotationDeg||[0,0,0],[90,0,0],.01)||close(f.rotationDeg||[0,0,0],[-90,0,0],.01);
const pec11=p=>p&&!p.modelSourceInvalidated&&/\bPEC11[-\s]4215F[-\s]S(?:00)?24\b/i.test([p.name,p.model,p.spec].join(' '));

function encoderBackplate(body,part){
  if(body?.role!=='reference'||!pec11(part))return null;
  const f=body.features||[],caseBody=f.find(x=>box(x,[12,6.5,14])),plate=f.find(x=>box(x,[10,1,20]));
  const bush=f.find(x=>x.op==='add'&&x.shape==='cylinder'&&alongY(x)&&Math.abs(x.sizeMm[0]-7)<.12);
  if(!caseBody||!plate||!bush)return null;
  const [x,y,z]=plate.centerMm;
  if(Math.abs(x-bush.centerMm[0])>.1||Math.abs(z-bush.centerMm[2])>.1||y<=caseBody.centerMm[1])return null;
  return [x,y+plate.sizeMm[1]/2,z];
}

export function encoderElectricalPins(body,part){
  const plane=encoderBackplate(body,part);
  if(!plane)return [];
  return encoderPads.map(([name,x,z])=>{
    const baseMm=[plane[0]+x,plane[1],plane[2]+z];
    // The manufacturer's PCB drawing gives pad axes and its side view gives the 3.5-mm projection.
    // The rectangular cross section depicts a blade within the 1.0-mm drilled hole.
    const existing=body.features.find(f=>f.op==='add'&&f.shape==='box'&&close([f.centerMm[0],f.centerMm[2]],[baseMm[0],baseMm[2]],.15)&&f.sizeMm[0]<1&&f.sizeMm[2]<1&&f.sizeMm[1]>2&&Math.abs(f.centerMm[1]-f.sizeMm[1]/2-baseMm[1])<.2);
    const feature=existing||{op:'add',shape:'box',sizeMm:[.45,3.5,.4],centerMm:[baseMm[0],baseMm[1]+1.75,baseMm[2]]};
    return {name,baseMm,tipMm:[feature.centerMm[0],feature.centerMm[1]+feature.sizeMm[1]/2,feature.centerMm[2]],feature,supplemental:!existing,sourceUrl:pecDrawing};
  });
}

const colors={
  frame:['固定座与焊耳',[163,170,176]],wafer:['编码器绝缘底座',[74,57,48]],
  bushing:['螺母与轴套',[185,178,150]],shaft:['金属转轴',[180,189,195]],
  cap:['防滑旋钮帽',[57,62,67]],mark:['旋钮指示槽',[196,199,193]],
  pin:['电气焊脚（按图补绘）',[190,186,169]],wire:['金属引线',[177,184,187]],
  red:['雾面红光透镜与法兰',[188,56,51]],green:['绿光透镜与法兰',[63,157,85]]
};

function materialAt(body,part){
  const f=body.features||[],back=encoderBackplate(body,part);
  if(back){
    const caseBody=f.find(x=>box(x,[12,6.5,14])),front=caseBody.centerMm[1]-caseBody.sizeMm[1]/2;
    return ([x,y,z])=>y<=front+.04&&Math.hypot(x-back[0],z-back[2])<5.1?'bushing':y>=back[1]-1.1&&Math.abs(x-back[0])<5.1?'wafer':'frame';
  }
  const axis=f.find(x=>x.op==='add'&&x.shape==='cylinder'&&alongY(x)&&Math.abs(x.sizeMm[0]-6)<.12);
  const cap=f.find(x=>x.op==='add'&&x.shape==='cylinder'&&alongY(x)&&x.sizeMm[0]>=12&&x.sizeMm[0]<=20&&x.sizeMm[2]>5);
  if(pec11(part)&&axis&&cap&&close([axis.centerMm[0],axis.centerMm[2]],[cap.centerMm[0],cap.centerMm[2]],.1)){
    const rear=cap.centerMm[1]+cap.sizeMm[2]/2;
    const mark=f.find(x=>x.op==='cut'&&x.shape==='box');
    return point=>{
      if(mark&&point.every((n,k)=>Math.abs(n-mark.centerMm[k])<=mark.sizeMm[k]/2+.04))return 'mark';
      return point[1]>rear+.03?'shaft':'cap';
    };
  }
  const description=[part?.name,part?.model,part?.spec].join(' ');
  const lens=/红[色光]|\bred\b/i.test(description)?'red':/绿[色光]|\bgreen\b/i.test(description)?'green':null;
  if(lens&&/(?:5\s*(?:mm|毫米)|T[-‐‑–]1[¾3])/i.test(description)&&/LED/i.test(description)&&f.some(x=>x.op==='add'&&x.shape==='ellipsoid')){
    const leads=f.filter(x=>x.op==='add'&&x.shape==='box'&&x.sizeMm[0]<=1&&x.sizeMm[2]<=1&&x.sizeMm[1]>=2);
    if(leads.length===2)return point=>leads.some(l=>point.every((n,k)=>Math.abs(n-l.centerMm[k])<=l.sizeMm[k]/2+.02))?'wire':lens;
  }
  return null;
}

export function stylePurchasedBodyMeshes(body,part,meshes){
  if(!part||part.modelSourceInvalidated||body?.role!=='reference'||!meshes?.length)return meshes;
  const classify=materialAt(body,part);
  if(!classify)return meshes;
  const result=new Map();
  const group=id=>{
    if(!result.has(id))result.set(id,{label:colors[id][0],color:colors[id][1],triangles:[]});
    return result.get(id);
  };
  for(const mesh of meshes)for(const face of mesh.triangles){
    const center=face[0].map((a,k)=>(a+face[1][k]+face[2][k])/3);
    group(classify(center)).triangles.push(face);
  }
  for(const {feature,supplemental} of encoderElectricalPins(body,part)){
    if(!supplemental)continue;
    const {sizeMm,centerMm}=feature,min=centerMm.map((x,i)=>x-sizeMm[i]/2);
    const faces=makeDocumentedProxy({shape:'box',sizeMm}).meshes[0].triangles;
    group('pin').triangles.push(...faces.map(face=>face.map(p=>p.map((n,k)=>n+min[k]))));
  }
  return [...result.values()];
}
