// Formbench Pico indicator, bottom shell. Millimetres; measure purchased board and connector before fabrication.
const Length = Param.number('Length', 64, {min:62, max:100, unit:'mm'});
const Width = Param.number('Width', 32, {min:29, max:64, unit:'mm'});
const Height = Param.number('Height', 17, {min:15, max:42, unit:'mm'});
const wall=2, floor=2;
const shell=box(Length,Width,Height).subtract(box(Length-2*wall,Width-2*wall,Height).translate(0,0,floor),box(4,12,8).translate(-Length/2+1,0,3));
const feet=[];
for(const x of [5,52]) for(const y of [-5.7,5.7]) {
  feet.push(cylinder(2.02,2.75).subtract(cylinder(2.1,1.05).translate(0,0,-0.03)).translate(x-Length/2,y,floor-0.02));
}
return union(shell,...feet).translate(Length/2,Width/2,0);
