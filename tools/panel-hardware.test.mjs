import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {decodeSTL,matchHardware} from '../assembly-hardware.js';
import {resolvePanelHardwareReference} from '../panel-hardware-reference.js';
import {encoderElectricalPins,stylePurchasedBodyMeshes} from '../purchased-body-details.js';

const load=async name=>JSON.parse(await readFile(new URL(name,import.meta.url)));
const {design}=await load('../samples/shared/reading-timer/v5.json');
const cad=await load('../samples/shared/reading-timer/v5-cad.json');
const metadata=await load('../assets/hardware/adafruit-938-qt/metadata.json');
const oled=design.parts[10],screen=design.cadPlan.bodies[7];

test('the dual-QT bare 938 mounts by its PCB midplane, four holes, forward glass and two sockets',()=>{
  assert.equal(matchHardware(oled),'adafruit-938-qt');
  assert.equal(matchHardware({...oled,spec:'原版 SPI 无排针'}),null);
  assert.equal(matchHardware({...oled,model:'Adafruit 326'}),null);
  const fit=resolvePanelHardwareReference(screen,oled,metadata);
  assert.deepEqual(fit.sizeMm,metadata.sizeMm);
  assert.ok(Math.abs(fit.centerMm[1]-.4818)<1e-4);
  const holesOnly={...screen,features:screen.features.slice(0,5)};
  assert.equal(resolvePanelHardwareReference(holesOnly,oled,metadata),null);
  const movedHole=structuredClone(screen);movedHole.features[1].centerMm[0]++;
  assert.equal(resolvePanelHardwareReference(movedHole,oled,metadata),null);
  assert.equal(resolvePanelHardwareReference(screen,{...oled,modelSourceInvalidated:true},metadata),null);
});

test('the supplier meshes are millimetre-scale and the four routed pins land on copper around open JP2 holes',async()=>{
  const output=metadata.meshes.find(m=>m.file==='pads.stl');
  const buffer=await readFile(new URL('../assets/hardware/adafruit-938-qt/pads.stl',import.meta.url));
  const triangles=decodeSTL(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
  assert.equal(triangles.length,output.triangles);
  for(const [name,x] of Object.entries({SDA:-8.89,SCL:-6.35,VIN:6.35,GND:8.89})){
    const [px,y,z]=metadata.pinCentersMm[name];assert.equal(px,x);
    const faces=triangles.filter(t=>t.every(p=>Math.abs(p[1]-y)<1e-5&&Math.hypot(p[0]-px,p[2]-z)<.90));
    assert.ok(faces.length>=90);
    const radii=faces.flat().map(p=>Math.hypot(p[0]-px,p[2]-z));
    assert.ok(Math.abs(Math.min(...radii)-.5)<1e-4);
    assert.ok(Math.abs(Math.max(...radii)-.889)<1e-4);
  }
});

test('colored LED and cap retain their geometry; five separate chart-derived blades project past the encoder base',()=>{
  for(const [i,expectedGroups] of [[3,2],[5,4],[10,3]]){
    const b=design.cadPlan.bodies[i],part=design.parts[b.partIndex],bytes=Buffer.from(cad.bodies[i].stlBase64,'base64');
    const triangles=decodeSTL(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length));
    const pins=encoderElectricalPins(b,part),meshes=stylePurchasedBodyMeshes(b,part,[{triangles}]);
    assert.equal(meshes.length,expectedGroups);
    assert.equal(meshes.flatMap(m=>m.triangles).length,triangles.length+pins.length*12);
    if(i===5){
      assert.deepEqual(pins.map(p=>p.name),['A','C','B','SW1','SW2']);
      assert.deepEqual(pins.map(p=>p.tipMm),[[-2.5,9.8,-7.5],[0,9.8,-7.5],[2.5,9.8,-7.5],[-2.5,9.8,7],[2.5,9.8,7]]);
      assert.equal(encoderElectricalPins({...b,features:[...b.features,...pins.map(p=>p.feature)]},part).filter(p=>p.supplemental).length,0);
    }
  }
});
