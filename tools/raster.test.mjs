import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMesh,createRaster,fitCamera,projectWorldPoint,worldPointAtZ} from '../mesh-renderer.js';

test('intersecting triangles change frontmost color and part across the image, in either draw order',()=>{
  globalThis.devicePixelRatio=1;
  let displayed;
  const ctx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:i=>{displayed=i.data;}};
  const canvas={getContext:()=>ctx,getBoundingClientRect:()=>({width:200,height:200})};
  const raster=createRaster(canvas);
  const mesh=(left,right,color)=>prepareMesh([[[-30,-20,left],[30,-20,right],[0,35,0]]],color);
  const red={id:'red',mesh:mesh(15,-15,[255,0,0])},green={id:'green',mesh:mesh(-15,15,[0,255,0])};
  const camera={yaw:0,pitch:Math.PI/2,target:[0,0,0],scale:2};
  for(const order of [[red,green],[green,red]]){
    raster.draw(order,camera);
    for(const [x,y,id,channel] of [[125,80,'red',0],[75,80,'green',1]]){
      const start=4*(y*200+x),pixel=displayed.subarray(start,start+4);
      assert.equal(raster.pick(x,y),id);assert.ok(pixel[channel]>100);assert.equal(pixel[1-channel],0);assert.equal(pixel[3],255);
    }
    assert.equal(raster.pick(0,0),undefined);assert.equal(displayed[3],0);
  }
});

test('front and back views preserve physical handedness, near surfaces and picking in either draw order',()=>{
 globalThis.devicePixelRatio=1;
 let pixels;
 const ctx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{pixels=image.data}};
 const canvas={getContext:()=>ctx,getBoundingClientRect:()=>({width:200,height:200})},raster=createRaster(canvas);
 // The product front is -Y. Its left and right marks are -X and +X.
 // Looking at its back reverses those marks, and the rear surfaces occlude them.
 const mark=(id,x,y,color)=>({id,mesh:prepareMesh([[[x-9,y,-9],[x+9,y,-9],[x,y,9]]],color)});
 const scene=[mark('left-front',-30,-10,[255,0,0]),mark('right-front',30,-10,[0,255,0]),mark('left-back',-30,10,[0,0,255]),mark('right-back',30,10,[255,255,0])];
 for(const order of [scene,[...scene].reverse()]){
  for(const [yaw,left,right,leftChannel] of [[Math.PI,'left-front','right-front',0],[0,'right-back','left-back',1]]){
   raster.draw(order,{yaw,pitch:0,target:[0,0,0],center:[100,100],scale:1});
   assert.equal(raster.pick(70,100),left);assert.equal(raster.pick(130,100),right);
   assert.ok(pixels[(100*200+70)*4+leftChannel]>100);
  }
 }
});

test('fit, trajectory endpoints and floor projection use one unmirrored camera frame',()=>{
 const camera={yaw:Math.PI,pitch:.45,target:[10,-5,3],center:[180,120],scale:4};
 const left=projectWorldPoint([-20,-30,10],camera),right=projectWorldPoint([20,-30,10],camera);
 assert.ok(left[0]<right[0],'-X stays left when looking from the front (-Y)');
 assert.ok(projectWorldPoint([0,0,20],camera)[1]<projectWorldPoint([0,0,0],camera)[1],'+Z points upward');
 assert.ok(projectWorldPoint([0,-30,10],camera)[2]>projectWorldPoint([0,30,10],camera)[2],'-Y is nearer to this camera');
 const start=projectWorldPoint([-20,-30,10],camera),end=projectWorldPoint([10,-30,10],camera);
 assert.ok(end[0]>start[0],'+X motion and its plotted path travel to the right');
 for(const yaw of [-2.1,.4,Math.PI])for(const pitch of [.35,1.15]){
  const view={...camera,yaw,pitch},world=[23,-17,4],screen=projectWorldPoint(world,view),back=worldPointAtZ(screen,view,world[2]);
  back.forEach((v,k)=>assert.ok(Math.abs(v-world[k])<1e-9,'floor grid agrees with solid projection'));
 }
 const mesh=prepareMesh([[[-10,-3,0],[25,7,2],[4,-6,18]]],[100,100,100]);
 const scene=[{mesh,offset:[13,-40,5]}],viewport={x:20,y:30,width:280,height:180};
 const fit=fitCamera(scene,Math.PI-.49,.32,viewport);
 const projected=mesh.points.map(point=>projectWorldPoint(point.map((v,k)=>v+scene[0].offset[k]),fit));
 for(const [x,y] of projected){assert.ok(x>=20-1e-9&&x<=300+1e-9);assert.ok(y>=30-1e-9&&y<=210+1e-9)}
 assert.ok(Math.abs((Math.min(...projected.map(p=>p[0]))+Math.max(...projected.map(p=>p[0])))/2-160)<1e-9);
 assert.ok(Math.abs((Math.min(...projected.map(p=>p[1]))+Math.max(...projected.map(p=>p[1])))/2-120)<1e-9);
});

test('inspection draws the actual shell translucently behind opaque interior hardware',()=>{
 globalThis.devicePixelRatio=1;
 let pixels;
 const context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{pixels=image.data}};
 const canvas={getContext:()=>context,getBoundingClientRect:()=>({width:60,height:60})};
 const renderer=createRaster(canvas),camera={yaw:0,pitch:Math.PI/2,target:[0,0,0],scale:1};
 const surface=(radius,z,color)=>prepareMesh([[[-radius,-radius,z],[radius,-radius,z],[0,radius,z]]],color);
 const shell={id:'shell',mesh:surface(25,20,[255,0,0])};
 const controller={id:'controller',mesh:surface(6,0,[0,255,0])};
 renderer.draw([controller],camera,[shell]);
 const alpha=(x,y)=>pixels[(y*60+x)*4+3];
 assert.equal(renderer.pick(30,30),'controller');
 assert.equal(alpha(30,30),255);
 assert.ok(alpha(30,20)>0&&alpha(30,20)<100);
 assert.equal(renderer.pick(30,20),undefined);
});

test('depth sampling shares CSS coordinates with picking at high device pixel ratios',()=>{
 globalThis.devicePixelRatio=2;
 const context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{}};
 const canvas={getContext:()=>context,getBoundingClientRect:()=>({width:200,height:120})},raster=createRaster(canvas);
 const mesh=prepareMesh([[[-25,-20,7],[25,-20,7],[0,30,7]]],[120,160,180]);
 raster.draw([{id:'board',mesh}],{yaw:0,pitch:Math.PI/2,target:[0,0,0],center:[100,60],scale:1});
 assert.equal(raster.pick(100,60),'board');assert.ok(Math.abs(raster.depthAt(100,60)-7)<1e-6);
 assert.equal(raster.depthAt(0,0),-Infinity);assert.equal(raster.depthAt(-1,60),Infinity);
});
