import {completeCatalogAnchors, featurePlacement} from './cad-plan.js';
import xiaoMetadata from './assets/hardware/xiao-esp32s3/metadata.json' with {type:'json'};
import oledMetadata from './assets/hardware/adafruit-938-qt/metadata.json' with {type:'json'};
import {matchOled938Reference,oled938Id} from './panel-hardware-reference.js';
import {matchXiaoS3Reference} from './assembly-hardware.js';
import {encoderElectricalPins} from './purchased-body-details.js';

const sources={
  xiao:'https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/img/XIAO_ESP32-S3_front_pinout.png',
  oled:'https://github.com/adafruit/Adafruit-1.3inch-128x64-Mono-OLED-PCB/blob/02c953af3a9c7c53d0c33faaa98a8aa1bffca5be/Adafruit%201.3in%20128x64%20OLED%20STEMMA%20QT.brd',
  led:'https://learn.adafruit.com/arduino-lesson-2-leds/leds',
  resistor:'https://github.com/KiCad/kicad-packages3D/blob/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Resistor_THT.3dshapes/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal.wrl'
};
// Seeed top view, turned so that the USB receptacle points along +X and components face +Z.
const xiaoRows=[['D0','D1','D2','D3','D4','D5','D6'],['5V','GND','3V3','D10','D9','D8','D7']];
const xyzClose=(a,b,tol=.02)=>a?.length===3&&a.every((n,i)=>Math.abs(n-b[i])<=tol);
const unrotated=f=>f&&!f.rotationDeg?.some(n=>Math.abs(n)>.01);
const rounded=v=>v.map(n=>Number(n.toFixed(4)));

function result(kind,point,direction,evidence,sourceUrl,featureIndex){
  return {kind,localMm:rounded(point),exitDirection:rounded(direction),evidence,sourceUrl,
    ...(Number.isInteger(featureIndex)?{featureIndex}:{})};
}

function atCatalog(anchor,boundsCenter,kind,point,direction,evidence,url){
  const place=featurePlacement(anchor,boundsCenter),rotate=featurePlacement({...anchor,centerMm:[0,0,0]});
  return result(kind,place(point),rotate(direction),evidence,url);
}

function xiaoTerminal(pin,part,body,anchor){
  if(!matchXiaoS3Reference(part))return null;
  const row=xiaoRows.findIndex(pins=>pins.includes(pin));
  const usb=/^USB[ -]?C[ -]?(VBUS|GND)$/.test(pin);
  if(row<0&&!usb)return null;
  const isCatalog=Boolean(anchor&&part.modelId==='xiao-esp32s3'&&part.dimensionSource==='catalog'&&xyzClose(part.sizeMm,[22.482,17.78,4.46]));
  const boundary=isCatalog?xiaoMetadata.boundsMm.min.map((n,i)=>(n+xiaoMetadata.boundsMm.max[i])/2):null;
  const x=row<0?0:(3-xiaoRows[row].indexOf(pin))*2.54,sign=row===0?1:-1;
  if(isCatalog){
    if(usb)return atCatalog(anchor,boundary,'connector',[12.0045,0,2.78],[1,0,0],
      'VBUS 与 GND 通过 USB-C 插头内部触点连接。标记定位到插座口面。',sources.xiao);
    // Off the drill centre, on copper between the plated through-hole and castellated edge.
    return atCatalog(anchor,boundary,'modeled',[x,sign*8.3,1.285],[0,0,1],
      'Seeed 顶视针序对应目录板两排铜焊盘；端点落在顶面铜皮上。',sources.xiao);
  }
  const features=body.features||[];
  const pcb=features.find(f=>f.op==='add'&&f.shape==='box'&&unrotated(f)&&xyzClose(f.sizeMm,[20.955,17.78,1.25]));
  if(!pcb)return null;
  const base=[pcb.centerMm[0],pcb.centerMm[1],pcb.centerMm[2]-.625];
  const mouth=features.find(f=>f.op==='cut'&&f.shape==='box'&&unrotated(f)&&xyzClose(f.sizeMm,[6.4,8.25,2.56])&&xyzClose(f.centerMm,base.map((n,i)=>n+[9.1,0,2.85][i])));
  if(!mouth)return null; // Identifies the +X connector orientation of this custom geometry.
  if(usb)return result('connector',base.map((n,i)=>n+[12.0045,0,2.85][i]),[1,0,0],
    'VBUS 与 GND 通过 USB-C 插头内部触点连接。该点标出 CAD 插座口面，未单画细触点。',sources.xiao);
  const target=base.map((n,i)=>n+[x,sign*7.94,1.3][i]);
  const index=features.findIndex(f=>f.op==='add'&&f.shape==='box'&&unrotated(f)&&xyzClose(f.centerMm,target)&&xyzClose(f.sizeMm,[1.55,1.9,.18]));
  if(index<0)return null;
  return result('modeled',[target[0],target[1],target[2]+.09],[0,0,1],
    'Seeed 顶视针序与此板的右向 USB-C 对齐，端点位于已建模焊盘顶面。',sources.xiao,index);
}

function resistorTerminal(pin,part,anchor){
  if(!anchor||part.modelId!=='resistor'||part.dimensionSource!=='catalog'||!xyzClose(part.sizeMm,[10.754,2.5,5.499])||!['1','2'].includes(pin))return null;
  return atCatalog(anchor,[0,0,-.2505],'modeled',[pin==='1'?-5.08:5.08,0,-3],[0,0,-1],
    'KiCad DIN0207 横装封装，弯脚间距 10.16 mm。电阻无极性，本设计将 −X 脚编为 1。',sources.resistor);
}

function ledTerminal(pin,part,body){
  if(!['A','K'].includes(pin)||!/LED|发光二极管/i.test([part.name,part.model,part.spec].join(' ')))return null;
  const legs=(body.features||[]).map((f,index)=>({f,index})).filter(({f})=>f.op==='add'&&f.shape==='box'&&unrotated(f)&&f.sizeMm[0]<=.8&&f.sizeMm[2]<=.8&&f.sizeMm[1]>2);
  if(legs.length!==2)return null;
  legs.sort((a,b)=>b.f.sizeMm[1]-a.f.sizeMm[1]);
  const [long,short]=legs.map(({f})=>f);
  const baseY=f=>f.centerMm[1]-f.sizeMm[1]/2;
  if(long.sizeMm[1]-short.sizeMm[1]<.3||Math.abs(baseY(long)-baseY(short))>.1||!body.features.some(f=>f.shape==='cylinder'&&f.centerMm[1]<Math.min(baseY(long),baseY(short))))return null;
  const {f,index}=legs[pin==='A'?0:1];
  return result('modeled',[f.centerMm[0],f.centerMm[1]+f.sizeMm[1]/2,f.centerMm[2]],[0,1,0],
    `${pin==='A'?'长脚为阳极':'短脚为阴极'}，端点位于此模型的金属引脚末端。实际 LED 料号及剪脚后的极性须复核。`,sources.led,index);
}

function oledTerminal(pin,part,body,anchor){
  const coordinates={SDA:-8.89,SCL:-6.35,VIN:6.35,GND:8.89};
  if(!Object.hasOwn(coordinates,pin)||!/Adafruit(?: Industries)?\s+938\b/i.test(part.model||''))return null;
  if(!matchOled938Reference(part))return null;
  if(anchor&&(anchor.catalogId===oled938Id||part.modelId===oled938Id&&xyzClose(part.sizeMm,oledMetadata.sizeMm))){
    const center=oledMetadata.boundsMm.min.map((n,i)=>(n+oledMetadata.boundsMm.max[i])/2);
    const [x,y,z]=oledMetadata.pinCentersMm[pin];
    return atCatalog(anchor,center,'modeled',[x+.65,y,z],[0,1,0],
      '原厂 938 双 QT EAGLE 的 JP2 焊排，按玻璃朝前、焊排朝上安装。端点位于背面铜环上，避开通孔中心。',oledMetadata.printedCircuitSourceUrl);
  }
  const features=body.features||[],pcb=features.find(f=>f.op==='add'&&f.shape==='box'&&unrotated(f)&&xyzClose(f.sizeMm,[35.6,1.6,33]));
  if(!pcb||features.filter(f=>f.op==='cut'&&f.shape==='cylinder'&&Math.abs(f.sizeMm[0]-2.5)<.02).length!==4||
    !features.some(f=>f.op==='add'&&f.shape==='box'&&f.centerMm[1]<pcb.centerMm[1]&&xyzClose(f.sizeMm,[34.5,1.45,23])))return null;
  const [x,y,z]=pcb.centerMm;
  return result('estimated',[x+coordinates[pin],y+.8,z+13.97],[0,1,0],
    '按 Adafruit 双 QT 版 Eagle 的 JP2 焊排定位，装配假定焊排朝上、显示朝前。此 CAD 未画出这些通孔，实物依丝印核对方向。',sources.oled);
}

function encoderTerminal(pin,part,body){
  const lead=encoderElectricalPins(body,part).find(candidate=>candidate.name===pin);
  if(!lead)return null;
  const index=lead.supplemental?undefined:body.features.indexOf(lead.feature);
  const detail=pin.startsWith('SW')?'两只无极性开关脚按装配图编号。':'三端按原厂 A／C／B 顺序。';
  const anchor=result('modeled',lead.tipMm,[0,1,0],
    `端点位于电气焊片末端。脚位和 3.5 mm 伸出量据 Bourns 机械图，焊片截面为示意；安装约定从正面看三针排朝下。${detail}两侧较宽金属耳仅固定座体。`,lead.sourceUrl,index);
  return {...anchor,basis:'datasheet'};
}

export function resolveAssemblyPinAnchor(design,partIndex,pin){
  const part=design?.parts?.[partIndex],bodies=design?.cadPlan?.bodies;
  if(!part||part.modelSourceInvalidated||!Array.isArray(bodies)||typeof pin!=='string')return null;
  const id=pin.trim().toUpperCase(),anchors=completeCatalogAnchors(bodies,design.parts,p=>p.metadata||(p.modelId==='xiao-esp32s3'?xiaoMetadata:matchOled938Reference(p)?oledMetadata:null)),matches=[];
  bodies.forEach((body,bodyIndex)=>{
    if(body.partIndex!==partIndex||body.role!=='reference')return;
    const anchor=anchors[bodyIndex];
    const p=xiaoTerminal(id,part,body,anchor)||resistorTerminal(id,part,anchor)||ledTerminal(id,part,body)||oledTerminal(id,part,body,anchor)||encoderTerminal(id,part,body);
    if(p)matches.push({...p,bodyIndex,worldMm:rounded(body.positionMm.map((v,i)=>v+p.localMm[i]))});
  });
  return matches.length===1?matches[0]:null;
}
