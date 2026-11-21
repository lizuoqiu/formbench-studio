// Resolve a BOM row against the actual selection. Package shapes are references;
// only a part-specific claim or exact catalog identity may represent the purchase.
import {matchHardware} from './assembly-hardware.js';
import {readPurchasedCad,makeDocumentedProxy} from './part-geometry.js';

const capFile=2*1024*1024;
export const maxCadBytes=capFile;
const str=(v,len=250)=>typeof v==='string'?v.trim().slice(0,len):'';
const norm=v=>str(v,2000).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
function safeLink(value){if(!value)return '';try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:''}catch{return ''}}
export function bindingKeys(part,item){return {partKey:rowKey(part),purchaseKey:describeSelectedPurchase(item).key}}
function rowKey(p){return JSON.stringify([norm(p?.name),norm(p?.spec)])}
export function describeSelectedPurchase(item={}){
  item=item||{};const title=str(item.title),sku=str(item.sku),url=safeLink(str(item.url,2000));
  let skuId=str(String(item.skuId||''),45);
  let listing=url;
  if(url){
    const u=new URL(url);
    if(['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.searchParams.has('id')){
      listing=u.host+u.pathname+'?id='+u.searchParams.get('id');
      if(!skuId)skuId=u.searchParams.get('skuId')||'';
    }else{
      for(const k of [...u.searchParams.keys()])if(/^(utm_.*|gclid|fbclid|msclkid)$/i.test(k))u.searchParams.delete(k);
      u.searchParams.sort();listing=u.href;
    }
  }
  const make=str(item.manufacturer),mpn=str(item.mpn);
  const key=listing||skuId||sku||title||mpn||make?JSON.stringify([listing,skuId,norm(sku),skuId?'':norm(title),...(mpn||make?[norm(make),norm(mpn)]:[])]):'';
  return {label:[[make,mpn].filter(Boolean).join(' '),title,sku].filter(Boolean).join(' · ')||skuId||listing,key,sku,url};
}
const otherPico=/pico[\s-]*(?:2|wh|w|h|plus|mini|zero)(?:[^a-z]|$)|rp2350|type[ -]?c|usb[ -]?c|已焊|预焊|带排针|with headers?|兼容|替代|仿制|compatible|clone/i;
const originalPico=t=>/(raspberry\s*pi\s*pico\b|树莓派\s*pico\b|^pico(?:\s|$))/i.test(t)&&!otherPico.test(t);
function rejectConflict(id,text){
  const s=norm(text);if(!s)return false;
  if(id==='pico')return otherPico.test(s);
  if(id==='red-led'||id==='green-led')return /贴片|smd|ws2812|(?:^|[^\d.])(?:3|8|10)\s*(?:mm|毫米)/.test(s)||(id==='red-led'?/绿色|绿光|green/:/红色|红光|red\b/).test(s);
  if(id==='screw'){const m=s.match(/\bm\s*(\d+(?:\.\d+)?)\s*(?:[x×*]\s*(\d+(?:\.\d+)?))?/);return (m && (+m[1]!==2 || m[2] && +m[2]!==6))||/沉头|自攻/.test(s)}
  if(id==='usb-cable')return /type[ -]?c|usb[ -]?c|lightning/.test(s);
  return false;
}
function fromSelection(item, fallback){
  const variant=norm(item?.sku),named=norm([item?.manufacturer,item?.mpn].filter(Boolean).join(' ')),title=norm(item?.title),text=named||variant||title;
  if(named&&fallback&&rejectConflict(fallback,variant+' '+named))return {id:null,conflict:true};
  if(fallback&&rejectConflict(fallback,text))return {id:null,conflict:true};
  // Listings can advertise several variants, so a specific conflicting SKU wins.
  if(rejectConflict('pico',text)&&/pico|rp2350/.test(title+' '+variant))return {id:null,conflict:true};
  const make=norm(item?.manufacturer),mpn=norm(item?.mpn);
  if(mpn&&/^(raspberry\s*pi|树莓派)$/.test(make)){
    if(mpn==='sc0915'||originalPico(mpn))return {id:'pico',official:true};
    if(fallback==='pico')return {id:null,conflict:true};
  }
  if((!named||originalPico(named))&&!otherPico.test(title)&&
      (originalPico(text)||(!/pico|排针|rp2350|type[ -]?c|usb[ -]?c/.test(variant)&&originalPico(title))))return {id:'pico',official:true};
  if(/\bdfr0032\b/i.test(text)||(!variant&&/\bdfr0032\b/i.test(title)))return {id:'buzzer'};
  if(/adafruit\s*(?:#|pid\s*)?375\b/.test(text))return {id:'reed'};
  return {id:fallback};
}
export function resolveModelForRow(part,item,binding){
  const selected=describeSelectedPurchase(item);
  const base=matchHardware(part),picked=selected.key?fromSelection(item,base):{id:base};
  const stale=!!binding&&(binding.purchaseKey!==selected.key || binding.partKey!==rowKey(part));
  const valid=!!binding&&!stale;
  const notice=stale?'采购规格或 BOM 行已变更，原绑定已停用。':'';
  const result=(kind,id,b,more)=>({kind,id,binding:b,stale,selected,notice:[notice,more].filter(Boolean).join(' ')});
  // The supplied original file wins first. If the explicitly identified part is
  // in our manufacturer catalog, use that original rather than a lower-tier proxy.
  if(valid&&binding.kind==='manufacturer')return result('binding',null,binding,'已按该型号提供原厂文件；请核对文件版本。');
  const exactOriginal=picked.official || (!selected.key && (!binding || originalPico(binding.model)) && base==='pico');
  if(exactOriginal&&picked.id==='pico')return {...result('catalog','pico',null,'优先使用对应初代 Pico 的原厂 R3 CAD。'),catalogOriginal:true};
  if(valid)return result('binding',null,binding,binding.kind==='supplier'?'使用为这个型号提供的供应商文件。':'按型号资料建模；用于识别和装配说明。');
  if(picked.conflict)return result('unmatched',null,null,'已选规格与现有目录模型不符，需要对应文件或尺寸。');
  if(picked.id)return result('catalog',picked.id,null,selected.key?'目录参考，未确认与所选商品完全一致。':'按 BOM 描述提供的目录参考。');
  return result('unmatched',null,null,'暂无对应模型，可使用这件硬件的 CAD 或尺寸。');
}
function checkedText(v,label,len,{optional=false}={}){
  if(optional && (v==null||v===''))return '';
  if(typeof v!=='string'||!v.trim()||v.length>len)throw Error(label+'缺失或过长');return v.trim();
}
function cleanDimensions(r){
  if(!['box','cylinder'].includes(r.shape)||!Array.isArray(r.sizeMm)||r.sizeMm.length!==3||r.sizeMm.some(n=>!Number.isFinite(n)||n<.1||n>2000))throw Error('请提供 0.1–2000 mm 的有效三向尺寸。');
  if(r.shape==='cylinder'&&Math.abs(r.sizeMm[0]-r.sizeMm[1])>1e-6)throw Error('圆柱的长度与宽度均应填写同一个外径。');
  const holes=r.holes??[];if(!Array.isArray(holes)||holes.length>32||holes.some(h=>!h||[h.x,h.y,h.diameter].some(n=>!Number.isFinite(n))||h.diameter<=0))throw Error('通孔的中心和直径无效。');
  return {shape:r.shape,sizeMm:[...r.sizeMm],holes:holes.map(({x,y,diameter})=>({x,y,diameter}))};
}
function byteArray(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
function asBase64(a){let s='';for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000));return btoa(s)}
export function validateCadBinding(r){
  if(!r||!['manufacturer','supplier','dimensions'].includes(r.kind))throw Error('未知的零件模型来源。');
  const model=checkedText(r.model,'型号',240),notes=checkedText(r.notes,'说明',1600,{optional:true});
  const sourceUrl=checkedText(r.sourceUrl,'来源链接',2000,{optional:true});
  if(sourceUrl&&!safeLink(sourceUrl))throw Error('来源链接须为 HTTP 或 HTTPS 地址。');
  const partKey=checkedText(r.partKey,'关联零件',5000),purchaseKey=checkedText(r.purchaseKey,'关联采购规格',4000,{optional:true});
  const clean={version:1,kind:r.kind,model,sourceUrl,notes,partKey,purchaseKey};
  if(r.kind==='dimensions'){
    if(!sourceUrl&&!notes)throw Error('请注明尺寸来自哪份图纸、规格表或实测记录。');
    const spec=cleanDimensions(r);makeDocumentedProxy(spec);return {...clean,...spec};
  }
  const fileName=checkedText(r.fileName,'CAD 文件名',220);
  if(!/\.(stl|step|stp)$/i.test(fileName)||/[\\/]/.test(fileName))throw Error('模型文件应为 STEP 或 STL。');
  const b=r.fileBase64;if(typeof b!=='string'||!b.length||b.length>4*Math.ceil(capFile/3)||b.length%4||!/^[A-Za-z\d+/]+={0,2}$/.test(b))throw Error('模型附件无效或超过 2 MiB。');
  if((b.length/4*3)-(b.endsWith('==')?2:b.endsWith('=')?1:0)>capFile)throw Error('模型附件超过 2 MiB。');
  return {...clean,fileName,fileBase64:b};
}
export async function createCadBinding({item,part,model,sourceUrl='',notes='',kind,file,shape,sizeMm,holes}){
  const record={kind,model,sourceUrl,notes,purchaseKey:describeSelectedPurchase(item).key,partKey:rowKey(part)};
  if(kind==='dimensions')return validateCadBinding({...record,shape,sizeMm,holes});
  if(!file||!file.size||file.size>capFile)throw Error('请选择不超过 2 MiB 的 STEP 或 STL 文件。');
  const bytes=new Uint8Array(await file.arrayBuffer());const checked=validateCadBinding({...record,fileName:file.name,fileBase64:asBase64(bytes)});
  await readBindingGeometry(checked);return checked;
}
const geometries=new WeakMap();
export async function readBindingGeometry(r){
  if(geometries.has(r))return geometries.get(r);
  const job=Promise.resolve().then(()=>r.kind==='dimensions'?makeDocumentedProxy(cleanDimensions(r)):readPurchasedCad(byteArray(r.fileBase64),r.fileName));
  geometries.set(r,job);try{return await job}catch(e){geometries.delete(r);throw e}
}
