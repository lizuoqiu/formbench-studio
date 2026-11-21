// Orthographic, two-sided triangle rasterizer. Color and picking share the exact
// same depth test, including when two faces intersect or projected depths cross.
export function prepareMesh(triangles,tint){
 const points=[],indices=[],palette=[],seen=new Map();
 for(const f of triangles){const [a,b,c]=f, ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];const normal=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx],len=Math.hypot(...normal)||1;
  // Light in fixed world coordinates. This is calculated after the lid flip.
  const light=Math.min(1.13,.64+.42*Math.max(-.45,(-.31*normal[0]-.39*normal[1]+.87*normal[2])/len));palette.push(tint.map(x=>Math.min(255,Math.round(x*light))));
  for(const p of f){const k=p.join(',');if(!seen.has(k)){seen.set(k,points.length);points.push(p)}indices.push(seen.get(k))}
 }
 return {points,indices,palette,projected:new Float64Array(points.length*3)};
}
// Fit actual mesh vertices, including each part's assembly/explosion transform.
// A fit is cached only for the same mesh and angle, independently of translation.
const projectionCache=new WeakMap();
export function fitCamera(scene,yaw,pitch,viewport){
 const cy=Math.cos(yaw),sy=Math.sin(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
 let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
 for(const {mesh,offset=[0,0,0]} of scene){
  let b=projectionCache.get(mesh);
  if(!b||b.yaw!==yaw||b.pitch!==pitch){
   b={yaw,pitch,x0:Infinity,x1:-Infinity,y0:Infinity,y1:-Infinity};
   for(const [x,y,z] of mesh.points){const u=x*cy-y*sy,v=(x*sy+y*cy)*sp-z*cp;b.x0=Math.min(b.x0,u);b.x1=Math.max(b.x1,u);b.y0=Math.min(b.y0,v);b.y1=Math.max(b.y1,v)}
   projectionCache.set(mesh,b);
  }
  const [x,y,z]=offset,dx=x*cy-y*sy,dy=(x*sy+y*cy)*sp-z*cp;
  x0=Math.min(x0,b.x0+dx);x1=Math.max(x1,b.x1+dx);y0=Math.min(y0,b.y0+dy);y1=Math.max(y1,b.y1+dy);
 }
 const u=(x0+x1)/2,v=(y0+y1)/2;
 return {yaw,pitch,target:[u*cy+v*sy*sp,-u*sy+v*cy*sp,-v*cp],center:[viewport.x+viewport.width/2,viewport.y+viewport.height/2],scale:Math.min(viewport.width/Math.max(1e-6,x1-x0),viewport.height/Math.max(1e-6,y1-y0))};
}
export function createRaster(canvas){
 const ctx=canvas.getContext('2d');let image,depth,objects,ids=[],width,height;
 function draw(scene,camera){const box=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.5,Math.sqrt(860000/Math.max(1,box.width*box.height)));const w=Math.round(box.width*ratio),h=Math.round(box.height*ratio);if(!w||!h)return;
  if(w!==width||h!==height){width=canvas.width=w;height=canvas.height=h;image=ctx.createImageData(w,h);depth=new Float32Array(w*h);objects=new Uint16Array(w*h)}image.data.fill(0);depth.fill(-Infinity);objects.fill(0);ids=[];
  const {yaw,pitch,target,scale}=camera, cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),s=scale*ratio,ox=(camera.center?.[0]??box.width/2)*ratio,oy=(camera.center?.[1]??box.height/2)*ratio;
  for(const obj of scene){const {mesh,offset=[0,0,0]}=obj,objectId=ids.push(obj.id),p=mesh.projected;for(let i=0;i<mesh.points.length;i++){const v=mesh.points[i],x=v[0]+offset[0]-target[0],y=v[1]+offset[1]-target[1],z=v[2]+offset[2]-target[2],forward=x*sy+y*cy;p[i*3]=ox+(x*cy-y*sy)*s;p[i*3+1]=oy+(forward*sp-z*cp)*s;p[i*3+2]=forward*cp+z*sp}
   for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i]*3,b=mesh.indices[i+1]*3,c=mesh.indices[i+2]*3,ax=p[a],ay=p[a+1],az=p[a+2],bx=p[b],by=p[b+1],cx=p[c],cyy=p[c+1],ux=bx-ax,uy=by-ay,vx=cx-ax,vy=cyy-ay,area=ux*vy-uy*vx;if(Math.abs(area)<1e-9)continue;
    const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(w-1,Math.floor(Math.max(ax,bx,cx)-.5)),y0=Math.max(0,Math.ceil(Math.min(ay,by,cyy)-.5)),y1=Math.min(h-1,Math.floor(Math.max(ay,by,cyy)-.5));const dzb=p[b+2]-az,dzc=p[c+2]-az,du=vy/area,dv=-uy/area,tint=mesh.palette[i/3],src=obj.id===camera.selected?[Math.min(255,tint[0]*1.12+16),Math.min(255,tint[1]*1.1+14),Math.min(255,tint[2]*1.06+6)]:tint;for(let y=y0;y<=y1;y++){let u=((x0+.5-ax)*vy-(y+.5-ay)*vx)/area,v=(ux*(y+.5-ay)-uy*(x0+.5-ax))/area;let idx=y*w+x0;for(let x=x0;x<=x1;x++,idx++,u+=du,v+=dv){if(u< -1e-7||v< -1e-7||u+v>1.0000001)continue;const z=az+u*dzb+v*dzc;if(z<=depth[idx])continue;depth[idx]=z;objects[idx]=objectId;const k=idx*4;image.data[k]=src[0];image.data[k+1]=src[1];image.data[k+2]=src[2];image.data[k+3]=255}}
   }
  }ctx.putImageData(image,0,0);
 }
 return {draw,pick(x,y){const box=canvas.getBoundingClientRect(),px=Math.floor(x*width/box.width),py=Math.floor(y*height/box.height);return px>=0&&px<width&&py>=0&&py<height?ids[objects?.[py*width+px]-1]:undefined}};
}
