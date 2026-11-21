// Original simplified Seeed Studio XIAO ESP32S3 base board, headerless.
// Coordinates in mm: origin at PCB centre on the underside, USB port faces +X.
const groupId = typeof Param === "undefined" ? param('Material group', 0, {min:0,max:4,step:1}) : Param.number('Material group', 0, {min:0,max:4,step:1});
const L=20.955, W=17.78, pcbTop=1.25;
const block=(x,y,z,w,d,h)=>box(w,d,h).moveTo(x-w/2,y-d/2,z);
const rounded=(x,y,z,w,d,h,r)=>roundedRect(w,d,r).extrude(h).moveTo(x-w/2,y-d/2,z);
const disc=(x,y,z,diameter,h)=>cylinder(h,diameter/2,diameter/2,16).translate(x,y,z);
const footprint=rounded(0,0,.035,L,W,pcbTop-.035,1.5);
const holes=[], contacts=[];
for(let row=-1;row<=1;row+=2)for(let n=0;n<7;n++){
  const x=(n-3)*2.54, y=row*7.62, edge=row*W/2;
  const drill=disc(x,y,-.1,.86,1.6), castellated=disc(x,edge,-.1,.76,1.6);
  holes.push(drill,castellated);
  const pad=block(x,row*8.14,0,1.6,1.49,.035);
  for(const z of [0,pcbTop])contacts.push(difference(pad.translate(0,0,z),drill,castellated));
}
const pcb=difference(footprint,...holes);
for(const x of [-4.85,-2.31,.23,2.77])for(const y of [-1.85,1.85])contacts.push(disc(x,y,0,1.35,.035));
contacts.push(block(-6.7,0,0,2.55,2.55,.035),block(-2.7,-4.7,0,2.0,1.0,.035));
// Reference port aperture, two retention windows and a polymer tongue.
const portRear=4.7045,portFront=12.0045,portWidth=8.94;
const portSolid=(x,z,len,width,height,r)=>roundedRect(width,height,r).extrude(len)
  .rotate([1,1,1],120).moveTo(x,-width/2,z);
const usb=difference(portSolid(portRear,1.15,portFront-portRear,portWidth,3.31,.7),
  portSolid(portRear+.5,1.43,7.4,8.15,2.70,.58),
  block(8.03,-1.57,4.12,1.00,1.22,.60),block(8.03,1.57,4.12,1.00,1.22,.60));
const shield=rounded(-1.5325,0,pcbTop,10.60,12.60,2,.32);
const frames=[],caps=[];
for(const y of [-5.93,5.93]){
  frames.push(rounded(8.895,y,pcbTop,2.60,1.60,.55,.18));
  caps.push(rounded(8.905,y,pcbTop+.54,1.56,1.14,.24,.23));
}
const antennaX=-8.7565,antennaY=4.727;
const socketRing=difference(disc(antennaX,antennaY,1.62,2.08,.88),disc(antennaX,antennaY,1.66,1.36,.98));
contacts.push(socketRing,disc(antennaX,antennaY,1.66,.48,.47));
const dark=[block(9.32,0,2.50,4.60,6.70,.51),rounded(antennaX,antennaY,pcbTop,3,3.1,.46,.25),...caps];
const layers=[pcb,union(...contacts),union(usb,shield,...frames),union(...dark)];
return groupId===0?union(...layers):layers[groupId-1];
