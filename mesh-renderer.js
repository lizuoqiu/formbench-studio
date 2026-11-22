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
// Screen Y points down; depth points toward the eye (larger wins). Therefore
// right × down must point away from the eye. The old +X screen basis reflected
// the assembly while retaining the near-face depth order.
export function cameraBasis(yaw,pitch){
 const cy=Math.cos(yaw),sy=Math.sin(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
 return {right:[-cy,sy,0],down:[sy*sp,cy*sp,-cp],toward:[sy*cp,cy*cp,sp]};
}
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export function projectWorldPoint(point,camera){
 const basis=cameraBasis(camera.yaw,camera.pitch),delta=point.map((v,k)=>v-(camera.target?.[k]||0)),scale=camera.scale??1,center=camera.center||[0,0];
 return [center[0]+dot(delta,basis.right)*scale,center[1]+dot(delta,basis.down)*scale,dot(delta,basis.toward)];
}
export function worldPointAtZ(point,camera,z){
 const basis=cameraBasis(camera.yaw,camera.pitch),target=camera.target||[0,0,0],center=camera.center||[0,0],scale=camera.scale??1;
 if(Math.abs(basis.toward[2])<1e-8)return null;
 const u=(point[0]-center[0])/scale,v=(point[1]-center[1])/scale;
 const depth=(z-target[2]-u*basis.right[2]-v*basis.down[2])/basis.toward[2];
 return target.map((n,k)=>n+u*basis.right[k]+v*basis.down[k]+depth*basis.toward[k]);
}
export function fitCamera(scene,yaw,pitch,viewport){
 const {right,down}=cameraBasis(yaw,pitch);
 let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
 for(const {mesh,offset=[0,0,0]} of scene){
  let b=projectionCache.get(mesh);
  if(!b||b.yaw!==yaw||b.pitch!==pitch){
   b={yaw,pitch,x0:Infinity,x1:-Infinity,y0:Infinity,y1:-Infinity};
   for(const point of mesh.points){const u=dot(point,right),v=dot(point,down);b.x0=Math.min(b.x0,u);b.x1=Math.max(b.x1,u);b.y0=Math.min(b.y0,v);b.y1=Math.max(b.y1,v)}
   projectionCache.set(mesh,b);
  }
  const dx=dot(offset,right),dy=dot(offset,down);
  x0=Math.min(x0,b.x0+dx);x1=Math.max(x1,b.x1+dx);y0=Math.min(y0,b.y0+dy);y1=Math.max(y1,b.y1+dy);
 }
 const u=(x0+x1)/2,v=(y0+y1)/2;
 return {yaw,pitch,target:right.map((n,k)=>u*n+v*down[k]),center:[viewport.x+viewport.width/2,viewport.y+viewport.height/2],scale:Math.min(viewport.width/Math.max(1e-6,x1-x0),viewport.height/Math.max(1e-6,y1-y0))};
}
export function createRaster(canvas){
 const ctx=canvas.getContext('2d');let image,depth,objects,ids=[],width,height;
 function draw(scene,camera,backdrop=[]){const box=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.5,Math.sqrt(860000/Math.max(1,box.width*box.height)));const w=Math.round(box.width*ratio),h=Math.round(box.height*ratio);if(!w||!h)return;
  if(w!==width||h!==height){width=canvas.width=w;height=canvas.height=h;image=ctx.createImageData(w,h);depth=new Float32Array(w*h);objects=new Uint16Array(w*h)}image.data.fill(0);depth.fill(-Infinity);objects.fill(0);ids=[];
  const {yaw,pitch,target,scale}=camera,{right,down,toward}=cameraBasis(yaw,pitch),s=scale*ratio,ox=(camera.center?.[0]??box.width/2)*ratio,oy=(camera.center?.[1]??box.height/2)*ratio;
  // Draw the shell as its own depth-tested translucent layer. Mounted hardware
  // then keeps its own depth and stays readable through the enclosure.
  for(const layer of backdrop.length?[backdrop,scene]:[scene]){
   const behind=layer===backdrop;
   if(!behind&&backdrop.length)depth.fill(-Infinity);
   const opacity=behind?56:255;
   for(const obj of layer){const {mesh,offset=[0,0,0]}=obj,objectId=behind?0:ids.push(obj.id),p=mesh.projected;for(let i=0;i<mesh.points.length;i++){const v=mesh.points[i],x=v[0]+offset[0]-target[0],y=v[1]+offset[1]-target[1],z=v[2]+offset[2]-target[2];p[i*3]=ox+(x*right[0]+y*right[1])*s;p[i*3+1]=oy+(x*down[0]+y*down[1]+z*down[2])*s;p[i*3+2]=x*toward[0]+y*toward[1]+z*toward[2]}
   for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i]*3,b=mesh.indices[i+1]*3,c=mesh.indices[i+2]*3,ax=p[a],ay=p[a+1],az=p[a+2],bx=p[b],by=p[b+1],cx=p[c],cyy=p[c+1],ux=bx-ax,uy=by-ay,vx=cx-ax,vy=cyy-ay,area=ux*vy-uy*vx;if(Math.abs(area)<1e-9)continue;
    const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(w-1,Math.floor(Math.max(ax,bx,cx)-.5)),y0=Math.max(0,Math.ceil(Math.min(ay,by,cyy)-.5)),y1=Math.min(h-1,Math.floor(Math.max(ay,by,cyy)-.5));const dzb=p[b+2]-az,dzc=p[c+2]-az,du=vy/area,dv=-uy/area,tint=mesh.palette[i/3],src=obj.id===camera.selected?[Math.min(255,tint[0]*1.12+16),Math.min(255,tint[1]*1.1+14),Math.min(255,tint[2]*1.06+6)]:tint;for(let y=y0;y<=y1;y++){let u=((x0+.5-ax)*vy-(y+.5-ay)*vx)/area,v=(ux*(y+.5-ay)-uy*(x0+.5-ax))/area;let idx=y*w+x0;for(let x=x0;x<=x1;x++,idx++,u+=du,v+=dv){if(u< -1e-7||v< -1e-7||u+v>1.0000001)continue;const z=az+u*dzb+v*dzc;if(z<=depth[idx])continue;depth[idx]=z;objects[idx]=objectId;const k=idx*4;image.data[k]=src[0];image.data[k+1]=src[1];image.data[k+2]=src[2];image.data[k+3]=opacity}}
   }
   }
  }ctx.putImageData(image,0,0);
 }
 function pixelAt(x,y){const box=canvas.getBoundingClientRect(),px=Math.floor(x*width/box.width),py=Math.floor(y*height/box.height);return px>=0&&px<width&&py>=0&&py<height?py*width+px:-1;}
 function depthAt(x,y){
  const pixel=pixelAt(x,y);if(pixel<0||!depth)return Infinity;
  const box=canvas.getBoundingClientRect(),u=x*width/box.width-.5,v=y*height/box.height-.5,px=Math.floor(u),py=Math.floor(v);
  // Depth samples describe pixel centres. Interpolate only within the same
  // opaque mesh; otherwise preserve the nearest occluder at silhouettes.
  if(px>=0&&px+1<width&&py>=0&&py+1<height&&objects[pixel]){
   const indices=[py*width+px,py*width+px+1,(py+1)*width+px,(py+1)*width+px+1];
   if(indices.every(i=>objects[i]===objects[pixel]&&Number.isFinite(depth[i]))){
    const a=u-px,b=v-py;return (depth[indices[0]]*(1-a)+depth[indices[1]]*a)*(1-b)+(depth[indices[2]]*(1-a)+depth[indices[3]]*a)*b;
   }
  }
  return depth[pixel];
 }
 return {draw,pick(x,y){const pixel=pixelAt(x,y);return pixel>=0?ids[objects?.[pixel]-1]:undefined},depthAt};
}
