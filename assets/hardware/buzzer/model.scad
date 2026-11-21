// SPDX-License-Identifier: CC0-1.0. Original dimension-informed reference, not vendor CAD.
// Origin midway across connector-side edge at PCB underside; units mm.
$fn=48; part="pcb"; pcb=1.6;
module opening(){for(x=[-7.5,7.5]) translate([x,26.5,-1]) cylinder(d=3,h=5);}
module board(){difference(){hull() for(x=[-7.5,7.5],y=[3.5,26.5]) translate([x,y,0]) cylinder(r=3.5,h=pcb); opening();}}
module transducer(){translate([0,19,pcb]) difference(){cylinder(r=5.95,h=8.9); translate([0,0,7.5]) cylinder(r=1.5,h=2);}}
module socket(){difference(){translate([-4,0,pcb]) cube([8,5.4,5.9]); translate([-3.36,-.01,pcb+1.15]) cube([6.72,4.65,4.05]);translate([-1.72,-.01,pcb+4.8]) cube([3.44,3.05,1.3]);}}
module conductive(){for(x=[-7.5,7.5]) translate([x,26.5,pcb]) difference(){cylinder(d=5.8,h=.14);translate([0,0,-.01]) cylinder(d=3,h=.2);} for(x=[-2,0,2]) translate([x-.22,.65,pcb+2.4]) cube([.44,4.1,.44]); for(v=[[-6,9],[6,9.8],[-3.5,12.2]]) for(a=[-1,1]) translate([v[0]+a*.73-.3,v[1]-.49,pcb]) cube([.6,.98,.47]); for(v=[[6.2,15.1],[6.2,17],[9.1,16.05]]) translate([v[0]-.55,v[1]-.23,pcb]) cube([1.1,.46,.4]);}
module electronics(){for(v=[[-6,9],[6,9.8],[-3.5,12.2]]) translate([v[0]-.56,v[1]-.49,pcb]) cube([1.12,.98,.53]); translate([6.73,14.55,pcb]) cube([2.0,3.0,1.15]);}
if(part=="pcb") board(); if(part=="buzzer") transducer(); if(part=="socket") socket(); if(part=="metal") conductive(); if(part=="electronics") electronics();
