// SPDX-License-Identifier: CC0-1.0. Original reference model; see metadata.json.
// Local X follows the length. Both STL files share coordinates (do not recenter individually).
$fn=32; part="switch"; L=29; W=15.2; H=9; gap=4;
module rr(l,w,r,h){hull() for(x=[r,l-r],y=[r,w-r]) translate([x,y,0]) cylinder(r=r,h=h);}
module slot(){hull() for(x=[-1.6,1.6]) translate([x,0,-.1]) cylinder(r=1.6,h=3.2);}
module casehalf(){difference(){union(){rr(L,W,1.35,2.5); translate([0,6.4,0]) rr(L,W-6.4,1.5,H);} for(x=[5.3,L-5.3]) translate([x,3.45,0]) slot();}}
module wires(){for(y=[10.1,12.15]) translate([-10,y,4.4]) rotate([0,90,0]) cylinder(r=.89,h=10.7);}
if(part=="switch") union(){casehalf(); wires();}
if(part=="magnet") translate([0,W*2+gap,0]) mirror([0,1,0]) casehalf();
