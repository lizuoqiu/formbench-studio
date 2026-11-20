// Formbench Pico indicator, lid in print orientation. Millimetres; nominal clearance only.
const Length = Param.number('Length', 64, {min:62, max:100, unit:'mm'});
const Width = Param.number('Width', 32, {min:29, max:64, unit:'mm'});
const wall=2,gap=0.25,lip=1.65,plate=2,lipHeight=1.5;
const u=Length-2*(wall+gap), v=Width-2*(wall+gap);
const rim=box(u,v,lipHeight+0.02).subtract(box(u-2*lip,v-2*lip,lipHeight+0.12).translate(0,0,-0.05)).translate(0,0,plate-0.02);
const bores=[[21,2.6],[33,2.6],[46,3.5]].map(([x,r])=>cylinder(plate+1,r).translate(x-Length/2,0,-0.5));
return union(box(Length,Width,plate),rim).subtract(...bores).translate(Length/2,Width/2,0);
