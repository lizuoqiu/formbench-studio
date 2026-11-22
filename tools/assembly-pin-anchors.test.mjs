import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {resolveAssemblyPinAnchor} from '../assembly-pin-anchors.js';
import {decodeSTL} from '../assembly-hardware.js';
import {stylePurchasedBodyMeshes} from '../purchased-body-details.js';

const design=JSON.parse(await readFile(new URL('../samples/shared/reading-timer/v5.json',import.meta.url))).design;
const get=(part,pin,d=design)=>resolveAssemblyPinAnchor(d,part,pin);
async function triangles(file){
  const b=await readFile(new URL('../assets/hardware/'+file,import.meta.url));
  return decodeSTL(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
}
// Independent ray–triangle test of the exported conductive layer. Height along the
// chosen normal must equal the terminal, and XY must be inside a real triangle.
function surfaceAt(faces,point,axis){
  const a=(axis+1)%3,b=(axis+2)%3;
  return faces.some(([p,q,r])=>{
    const qa=q[a]-p[a],qb=q[b]-p[b],ra=r[a]-p[a],rb=r[b]-p[b],det=qa*rb-qb*ra;
    if(Math.abs(det)<1e-10)return false;
    const u=((point[a]-p[a])*rb-(point[b]-p[b])*ra)/det,v=(qa*(point[b]-p[b])-qb*(point[a]-p[a]))/det;
    return u>=-1e-6&&v>=-1e-6&&u+v<=1.000001&&Math.abs(p[axis]+u*(q[axis]-p[axis])+v*(r[axis]-p[axis])-point[axis])<.002;
  });
}

test('XIAO signal, supply and ground ends lie on eight distinct real top copper pads',async()=>{
  const pads=await triangles('xiao-esp32s3/pads.stl');
  const ids=['D0','D1','D3','D4','D5','D10','3V3','GND'];
  const points=ids.map(id=>get(4,id));
  for(const p of points){assert.equal(p.kind,'modeled');assert.equal(p.bodyIndex,4);assert.ok(surfaceAt(pads,p.localMm,2));}
  assert.equal(new Set(points.map(p=>p.localMm.join('/'))).size,ids.length);
  assert.ok(points[0].localMm[0]>points[1].localMm[0]);assert.ok(points[0].localMm[1]>0&&points.at(-1).localMm[1]<0);
  assert.equal(get(4,'USB-C VBUS').kind,'connector');assert.deepEqual(get(4,'USB-C GND').worldMm,get(4,'USB-C VBUS').worldMm);
  assert.equal(get(9,'VBUS'),null);assert.equal(get(4,'NOT_A_PIN'),null);
});

test('pin label follows physical catalog registration, including 90-degree feature rotations',()=>{
  const d=structuredClone(design),p=d.parts[4],b=d.cadPlan.bodies[4];b.features=[{op:'add',shape:'box',sizeMm:[...p.sizeMm],centerMm:[-5,3,2],rotationDeg:[0,0,90]}];
  const a=get(4,'D0',d);assert.equal(a.kind,'modeled');assert.deepEqual(a.localMm,[-13.3,9.8565,1.055]);
  d.parts[4].model='ESP32 clone';assert.equal(get(4,'D0',d),null);
  d.parts[4].modelSourceInvalidated=true;assert.equal(get(4,'D0',d),null);
});

test('the two LED leads are identifiable by the actual modeled tip lengths; resistor legs lie on terminal metal',async()=>{
  const a=get(3,'A'),k=get(3,'K');assert.equal(a.featureIndex,3);assert.equal(k.featureIndex,4);assert.equal(a.worldMm[1]-k.worldMm[1],1);
  const leads=await triangles('resistor/leads.stl');
  for(const id of ['1','2']){const p=get(6,id);assert.equal(p.kind,'modeled');assert.ok(surfaceAt(leads,[p.localMm[0],p.localMm[1],p.localMm[2]-.2505],2));}
  assert.equal(get(6,'A'),null);
});

test('Bourns electrical contacts use the five datasheet holes, and never the two mechanical retaining lugs',()=>{
  const expected={A:[-2.5,-7.5],B:[2.5,-7.5],C:[0,-7.5],SW1:[-2.5,7],SW2:[2.5,7]};
  const groups=stylePurchasedBodyMeshes(design.cadPlan.bodies[5],design.parts[5],[{triangles:[]}]);
  const tips=groups.flatMap(g=>g.triangles);assert.equal(tips.length,60);
  for(const [pin,[x,z]] of Object.entries(expected)){const a=get(5,pin);assert.equal(a.bodyIndex,5);assert.equal(a.kind,'modeled');assert.equal(a.basis,'datasheet');assert.deepEqual(a.localMm,[x,9.8,z]);assert.ok(surfaceAt(tips,a.localMm,1));assert.ok(!('featureIndex' in a));}
  const d=structuredClone(design);d.parts[5].model='unknown encoder';d.parts[5].spec='unknown';assert.equal(get(5,'A',d),null);
});

test('four OLED JP2 ends lie on rear copper from the official EAGLE design, outside the drill holes',async()=>{
  const pads=await triangles('adafruit-938-qt/pads.stl');
  const pins=['SDA','SCL','VIN','GND'],anchors=pins.map(p=>get(10,p));assert.deepEqual(anchors.map(a=>a.localMm[0]),[-8.24,-5.7,7,9.54]);
  for(const a of anchors){assert.equal(a.kind,'modeled');assert.equal(a.localMm[2],13.97);assert.ok(surfaceAt(pads,a.localMm,1));assert.match(a.evidence,/焊排朝上/);assert.ok(a.sourceUrl.includes('STEMMA'));}
  const d=structuredClone(design);d.parts[10].model='OLED with similar shape';assert.equal(get(10,'VIN',d),null);
});
