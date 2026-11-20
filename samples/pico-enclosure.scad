// Pico desk indicator · revision A · millimetres · UNVERIFIED fit study.
// Measure board, USB lead, LEDs and actual switch before producing.
// Export two STLs: set part="base" or "lid", then Render and Export STL.
part="assembly"; $fn=48;
w=64; d=32; h=17; wall=2; floor=2; lidT=2;
module base(){difference(){cube([w,d,h]);translate([wall,wall,floor])cube([w-2*wall,d-2*wall,h]);translate([-1,d/2-6,3])cube([wall+2,12,8]);} for(x=[5,52])for(y=[d/2-5.7,d/2+5.7])translate([x,y,floor])difference(){cylinder(h=2,r=2.5);translate([0,0,-0.1])cylinder(h=2.2,r=1.05);}}
module lid(){difference(){union(){cube([w,d,lidT]);translate([wall+0.25,wall+0.25,-1.5])difference(){cube([w-2*wall-0.5,d-2*wall-0.5,1.5]);translate([1,1,-0.1])cube([w-2*wall-2.5,d-2*wall-2.5,1.7]);}}for(p=[[21,16,2.6],[33,16,2.6],[46,16,3.5]])translate([p[0],p[1],-2])cylinder(h=6,r=p[2]);}}
if(part=="base")base();else if(part=="lid")translate([0,d,lidT])rotate([180,0,0])lid();else{base();translate([0,0,h+8])lid();}
