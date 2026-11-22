// The installed orientation is a build choice. The unpopulated JP2 solder row
// goes at the top of the panel, with the OLED glass facing the user (-Y).
export const oled938Id='adafruit-938-qt';

export function matchOled938Reference(part){
  if(!part||part.modelSourceInvalidated||part.dimensionSource==='specified'||part.modelId&&part.modelId!==oled938Id)return null;
  const identity=[part.name,part.model].filter(Boolean).join(' ').normalize('NFKC');
  const spec=[identity,part.spec].join(' ').normalize('NFKC');
  if(!/\bAdafruit\b[^;；。]{0,40}?\b938\b/i.test(identity)||!/(?:STEMMA\s*QT|双\s*QT|dual\s*QT)/i.test(spec))return null;
  if(!/(?:无|未焊|不带)排针|headerless|without (?:pin )?headers?|no headers?/i.test(spec))return null;
  if(/(?:旧版|原版|legacy|original revision|含排针|带排针版|预焊排针|pre[- ]?soldered headers?|clone|仿制)/i.test(spec))return null;
  return oled938Id;
}

const near=(values,reference,tolerance)=>Array.isArray(values)&&values.length===reference.length&&values.every((v,k)=>Math.abs(v-reference[k])<=tolerance);
const alignedBox=f=>f.op==='add'&&f.shape==='box'&&near(f.rotationDeg||[0,0,0],[0,0,0],.001);

// Match independent mounting details before replacing a reference; a generic
// OLED box does not establish a PCB mid-plane, a display face, or a hole pattern.
export function resolvePanelHardwareReference(body,part,metadata){
  if(body?.role!=='reference'||!matchOled938Reference(part)||!metadata?.boundsMm||!metadata?.sizeMm)return null;
  const features=body.features||[],board=features.find(f=>alignedBox(f)&&near(f.sizeMm,[35.56,1.57,33.02],.12));
  if(!board)return null;
  const origin=board.centerMm;
  const offset=f=>f.centerMm.map((v,k)=>v-origin[k]);
  const hole=([x,z])=>features.some(f=>f.op==='cut'&&f.shape==='cylinder'&&near(f.sizeMm.slice(0,2),[2.5,2.5],.1)&&f.sizeMm[2]>board.sizeMm[1]&&Math.abs(Math.abs(f.rotationDeg?.[0]||0)-90)<.01&&near(f.rotationDeg.slice(1),[0,0],.01)&&near(offset(f),[x,0,z],.15));
  if(![[-15.24,-13.97],[-15.24,13.97],[15.24,-13.97],[15.24,13.97]].every(hole))return null;
  const glass=features.find(f=>alignedBox(f)&&near(f.sizeMm,[34.5,1.45,23],.2)&&near(offset(f),[0,-1.5,0],.35));
  if(!glass)return null;
  const socket=sign=>features.some(f=>{
    if(!alignedBox(f))return false;
    const [x,y,z]=offset(f);
    return sign*x>=12&&sign*x<=16&&y>0&&Math.abs(z)<.5&&f.sizeMm[0]<=8&&f.sizeMm.every(n=>n>=2&&n<=8);
  });
  if(!socket(-1)||!socket(1))return null;
  const {min,max}=metadata.boundsMm;
  const centerMm=origin.map((v,k)=>v+(min[k]+max[k])/2);
  return {op:'add',shape:'box',sizeMm:[...metadata.sizeMm],centerMm,rotationDeg:[0,0,0],catalogId:oled938Id};
}
