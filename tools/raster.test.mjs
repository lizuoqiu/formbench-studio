import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMesh,createRaster} from '../mesh-renderer.js';

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
    for(const [x,y,id,channel] of [[75,80,'red',0],[125,80,'green',1]]){
      const start=4*(y*200+x),pixel=displayed.subarray(start,start+4);
      assert.equal(raster.pick(x,y),id);assert.ok(pixel[channel]>100);assert.equal(pixel[1-channel],0);assert.equal(pixel[3],255);
    }
    assert.equal(raster.pick(0,0),undefined);assert.equal(displayed[3],0);
  }
});
