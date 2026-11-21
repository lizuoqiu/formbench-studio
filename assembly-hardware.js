// Reference components are matched to the BOM, not to a merchant SKU.
// All meshes are millimetres. A project-specific layout is independent of a model match.
const rows = [
  ['pico','pico','Raspberry Pi Pico','初代 RP2040、Micro-B、无排针的参考板。'],
  ['red-led','led','红色 LED','5 mm 直插圆形封装，红色是显示颜色。'],
  ['green-led','led','绿色 LED','5 mm 直插圆形封装，绿色是显示颜色。'],
  ['resistor','resistor','轴向电阻','DIN0207、约 1/4 W 的封装；阻值由 BOM 决定。'],
  ['button','button','瞬时按钮','直插轻触开关候选；不等同于已选定的面板按钮。'],
  ['usb-cable','usb-cable','USB 数据线','外接 A 至 Micro-B 线缆候选；线长和弯曲姿态另定。'],
  ['wire','wire','绝缘连接导线','导线与剥线端参考；线径、长度、布线另定。'],
  ['screw','screw','固定螺钉','紧固件候选；长度、牙型和柱深必须配套。'],
  ['reed','reed','门磁开关与磁铁','成对识别；安装姿态和触发距离取决于实物。'],
  ['buzzer','buzzer','有源蜂鸣模块','需要带驱动的模块，电平和供电需按具体型号确认。']
];
export const catalog = Object.fromEntries(rows.map(([id,dir,label,description])=>[id,{id,dir,label,description}]));
// The prototype's ten known BOM rows only. An unfamiliar device, package, or
// variant should be reported as unresolved instead of inheriting plausible-looking CAD.
export function matchHardware(part) {
  const n=String(part?.name||'').normalize('NFKC').trim(), s=String(part?.spec||'').normalize('NFKC');
  if(/^(?:Raspberry\s*Pi\s+)?Pico$/i.test(n) && !/Pico\s*(?:2|W|H)\b|RP2350|USB[ -]?C|Type[ -]?C|已焊|预焊/i.test(s))return 'pico';
  if(/^(红色?|绿色?)\s*LED$/i.test(n)&&/(?:^|[^.\d])5(?:\.0)?\s*(?:mm|毫米)/i.test(s)&&!/贴片|SMD|5050|WS2812|方形/i.test(s))return n.startsWith('红')?'red-led':'green-led';
  if(/^(?:限流|轴向)?电阻$/.test(n)&&/(?:1\s*\/\s*4|0\.25)\s*W|DIN\s*0207/i.test(s)&&!/贴片|SMD|0805|0603|1206/i.test(s))return 'resistor';
  if(/^(?:瞬时按钮|轻触开关)$/.test(n)&&!/(?:防水|面板安装|贴片|SMD|自锁|12\s*mm|16\s*mm)/i.test(s))return 'button';
  if(/^USB\s*数据线$/i.test(n)&&/micro[ -]?(?:usb|b)\b/i.test(s)&&!/(?:Type[- ]?C|USB[- ]?C)/i.test(s))return 'usb-cable';
  if(/^(?:绝缘)?连接导线$/.test(n)&&!/排线|杜邦|端子/.test(s))return 'wire';
  if(/^固定螺钉$/.test(n)&&!/(?:M(?!2(?:\b|×|x))\d|沉头|自攻)/i.test(s))return 'screw';
  if(/^门磁开关$/.test(n))return 'reed';
  if(/^有源蜂鸣(?:器)?模块$/.test(n))return 'buzzer';
  return null;
}
const infoCache=new Map(),geomCache=new Map();
function cached(map,key,load){if(!map.has(key))map.set(key,load().catch(e=>{map.delete(key);throw e}));return map.get(key)}
function base(id){if(!Object.hasOwn(catalog,id))throw Error('没有匹配的硬件模型');return new URL('./assets/hardware/'+catalog[id].dir+'/',import.meta.url)}
async function read(url){const response=await fetch(url);if(!response.ok)throw Error('模型文件未能加载：'+url.pathname.split('/').pop());return response}
export function getHardwareMetadata(id){const u=base(id);return cached(infoCache,u.href,async()=>{const m=await(await read(new URL('metadata.json',u))).json();if(!m.sourceUrl||!m.license||!m.meshes?.length)throw Error('模型目录未就绪');return m})}
export function decodeSTL(buf){
  const v=new DataView(buf),n=v.byteLength>=84?v.getUint32(80,true):0;
  if(!n||84+50*n!==v.byteLength)throw Error('不是有效的二进制 STL');
  return Array.from({length:n},(_,i)=>Array.from({length:3},(_,j)=>Array.from({length:3},(_,k)=>v.getFloat32(96+50*i+12*j+4*k,true))));
}
export async function loadPartMeshes(id){
  const meta=await getHardwareMetadata(id),u=base(id);
  return Promise.all(meta.meshes.map(async m=>{
    if(!/^[\w.-]+\.stl$/i.test(m.file))throw Error('模型文件名无效');
    const url=new URL(m.file,u);
    const triangles=await cached(geomCache,url.href,async()=>decodeSTL(await(await read(url)).arrayBuffer()));
    const color=m.role==='lens'?(id==='green-led'?[56,194,106]:[225,67,59]):m.color||[150,158,164];
    return {label:m.label||catalog[id].label,color,triangles,role:m.role||'',file:m.file};
  }));
}

// A pose transforms millimetres without rescaling a catalog part to fit a hole.
// A layout must stay a tracked choice; it is never inferred from a text match.
function placed(meshes,instance,pose,explode) {
  const transform=offset(...pose.translationMm);
  return meshes.map(o=>({
    id:instance,group:instance,label:catalog[pose.id].label,
    triangles:o.triangles.map(f=>f.map(p=>transform(...p))),
    color:o.color,explode
  }));
}
const offset=(x,y,z)=>(u,v,w)=>[x+u,y+v,z+w];
export const picoLayout=[
  {id:'pico',instance:'board',translationMm:[28.5,16,4],explode:[0,0,5]},
  // LED flange at local Z=3..4 seats just below the lid underside (Z=17).
  {id:'red-led',instance:'led-red',translationMm:[21,16,12.9],explode:[0,0,15]},
  {id:'green-led',instance:'led-green',translationMm:[33,16,12.9],explode:[0,0,15]},
  // Leave the short switch recessed. Do not scale its plunger to fill the aperture.
  {id:'button',instance:'switch',translationMm:[46,16,13.2],explode:[0,0,15]},
  {id:'resistor',instance:'r1',translationMm:[18,27.9,7.8],explode:[0,2,8]},
  {id:'resistor',instance:'r2',translationMm:[39,27.9,7.8],explode:[0,2,8]}
];
export async function loadHardwareInstances(){
  const results=await Promise.allSettled(picoLayout.map(async p=>placed(await loadPartMeshes(p.id),p.instance,p,p.explode)));
  const entries=[],unavailable=new Set();
  results.forEach((r,i)=>{if(r.status==='fulfilled')entries.push(...r.value);else unavailable.add(catalog[picoLayout[i].id].label)});
  entries.unavailableLabels=[...unavailable];return entries;
}
