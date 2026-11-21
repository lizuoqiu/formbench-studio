// SPDX-License-Identifier: CC0-1.0. Original dimensional study, not vendor STEP.
// Local axes: PCB centred in XY, underside Z=0, connector mating face points +X.
// Measurements: Seeed Studio XIAO ESP32C3 v1.3 KiCad (2026-01-16).
const groupId = Param.number('Group', 0, {min: 0, max: 4, step: 1});
const L=20.955,W=17.780,H=1.6,R=1.905;
const at=(x,y,z,part)=>part.translate(x,y,z);
const cub=(x,y,z,w,d,h)=>at(x,y,z,box(w,d,h));
const cyl=(x,y,z,h,r)=>at(x,y,z,cylinder(h,r));
const rowXs=Array.from({length:7},(_,i)=>-0.0635+(i-3)*2.54);
const drill=[];const gold=[];
for(const y of [-7.62,7.62])for(const x of rowXs){
  drill.push(cyl(x,y,-0.2,H+0.4,0.425));
  drill.push(cyl(x,Math.sign(y)*W/2,-0.2,H+0.4,0.425));
  const contact=cub(x,y+Math.sign(y)*0.39,H,1.5,1.71,0.045);
  gold.push(contact.subtract(cyl(x,y,H-0.05,0.15,0.425),cyl(x,Math.sign(y)*W/2,H-0.05,0.15,0.425)));
}
const corners=[];for(const x of [-1,1])for(const y of [-1,1])corners.push(cyl(x*(L/2-R),y*(W/2-R),0,H,R));
const board=union(box(L-2*R,W,H),box(L,W-2*R,H),...corners).subtract(...drill);
// UBF31-0171 footprint silk is 7.35 by 9; connector height and tongue are visual estimates.
const rear=4.6355,depth=7.35,front=rear+depth;
const shell=cub(rear+depth/2,0,H,depth,9,3.10).subtract(cub(front-2.9,0,H+0.30,6.0,8.18,2.34));
const tongue=cub(front-2.55,0,H+1.28,4.55,6.45,0.48);
// Two tactile switches at the BOOT / RST centres, antenna connector and EM shield proxy.
// The shield is a visual approximation; Seeed's PCB has placement data but no enclosure solid.
const switchBases=[], caps=[];
for(const y of [-4.445,4.445]){
  switchBases.push(cub(-8.9535,y,H,2.15,3.55,0.82));
  caps.push(cub(-9.02,y,H+0.82,1.49,2.10,0.52));
}
const ipx=cyl(-9.0805,0,H,1.1,1.25).subtract(cyl(-9.0805,0,H+0.1,1.5,0.78));
const shield=cub(-.92,0,H,10.0,12.35,1.64);
const forms=[board,union(...gold),union(shell,shield,ipx,...switchBases),union(tongue,...caps)];
return groupId===0?union(...forms):forms[groupId-1];
