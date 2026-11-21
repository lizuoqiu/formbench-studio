import earcut from './assets/cad-reader/earcut.js';
const MM_LIMIT=2000,MAX_BYTES=16*1024*1024,MAX_FACES=65_000,TIMEOUT=30_000;
const neutral=[129,156,167];
const fail=msg=>{throw Error(msg)};
const finiteVec=p=>Array.isArray(p)&&p.length===3&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7);
function finish(meshes) {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let count=0;
  for(const m of meshes)for(const f of m.triangles){
    if(++count>MAX_FACES)fail('模型超过 65,000 个三角面，请简化 CAD 后再导入。');
    for(const p of f){if(!finiteVec(p))fail('CAD 包含无效坐标。');for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}}
  }
  if(!count)fail('CAD 中没有可预览的三角面。');
  const sizeMm=max.map((v,k)=>v-min[k]);if(!sizeMm.some(v=>v>0))fail('CAD 没有有效的空间尺寸。');
  if(min.some(n=>n!==0))for(const m of meshes)for(const f of m.triangles)for(let i=0;i<3;i++)f[i]=f[i].map((v,k)=>v-min[k]);
  return {meshes,sizeMm,originalMinMm:min};
}

export function makeDocumentedProxy(spec){
  const {shape,sizeMm,holes=[]}=spec??{};
  if(!['box','cylinder'].includes(shape)||!finiteVec(sizeMm)||sizeMm.some(n=>n<.1||n>MM_LIMIT))fail('请选择长方体或圆柱，并填写 0.1–2000 mm 的长宽高。');
  const [w,d,h]=sizeMm,round=shape==='cylinder';
  if(round&&Math.abs(w-d)>1e-8)fail('圆柱的长、宽须相同，均为直径。');
  if(!Array.isArray(holes)||holes.length>32)fail('最多支持 32 个通孔。');
  const circle=(cx,cy,r,n,dir)=>Array.from({length:n},(_,i)=>[cx+r*Math.cos(dir*i*2*Math.PI/n),cy+r*Math.sin(dir*i*2*Math.PI/n)]);
  const loops=[round?circle(w/2,d/2,w/2,96,1):[[0,0],[w,0],[w,d],[0,d]]];
  for(let i=0;i<holes.length;i++){
    const {x,y,diameter}=holes[i]??{},r=diameter/2;
    if(![x,y,diameter].every(Number.isFinite)||diameter<.1)fail('孔直径须至少 0.1 mm，并填写有效孔中心坐标。');
    // Keep a margin even against the faceted approximation of the circular outline.
    if(x-r<=0||x+r>=w||y-r<=0||y+r>=d||(round&&Math.hypot(x-w/2,y-d/2)+r>=w/2*Math.cos(Math.PI/96)))fail('通孔必须完整位于轮廓内部。');
    for(let j=0;j<i;j++)if(Math.hypot(x-holes[j].x,y-holes[j].y)<=r+holes[j].diameter/2)fail('通孔不能相交或相切。');
    loops.push(circle(x,y,r,48,-1));
  }
  const xy=loops.flat(),holesAt=[];let offset=loops[0].length;for(const hole of loops.slice(1)){holesAt.push(offset);offset+=hole.length;}
  const indices=earcut(xy.flat(),holesAt,2),triangles=[];
  const at=(p,z)=>[p[0],p[1],z];
  for(let i=0;i<indices.length;i+=3){const [a,b,c]=indices.slice(i,i+3).map(j=>xy[j]);triangles.push([at(a,h),at(b,h),at(c,h)],[at(c,0),at(b,0),at(a,0)]);}
  // CCW outer boundary and CW hole boundaries give outward and bore-facing normals.
  for(const loop of loops)for(let i=0;i<loop.length;i++){const a=loop[i],b=loop[(i+1)%loop.length];triangles.push([at(a,0),at(b,0),at(b,h)],[at(a,0),at(b,h),at(a,h)]);}
  return finish([{label:'实物尺寸参考 · '+(round?'圆柱':'长方体'),triangles,color:[113,158,149]}]);
}
function readSTL(bytes,name){
  const triangles=[];let binary=false;
  if(bytes.byteLength>=84){const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=dv.getUint32(80,true);
    if(84+n*50===bytes.byteLength){binary=true;if(n>MAX_FACES)fail('STL 超过 65,000 个三角面，请先简化。');
      for(let i=0;i<n;i++){const f=[];for(let j=0;j<3;j++){const a=96+i*50+j*12;f.push([dv.getFloat32(a,true),dv.getFloat32(a+4,true),dv.getFloat32(a+8,true)]);}triangles.push(f);}
    }
  }
  if(!binary){const s=new TextDecoder().decode(bytes);
    if(!/^\s*solid\b/i.test(s)||!/^\s*endsolid\b/im.test(s))fail('STL 文件不完整或格式不正确。');
    let facet=null;
    for(const line of s.split(/\r\n|\n|\r/)){const tokens=line.trim().split(/\s+/),tag=tokens[0].toLowerCase();
      if(tag==='facet'){if(facet!==null)fail('ASCII STL 面结构无效。');facet=[];}
      if(tag==='vertex'){if(!facet||facet.length>=3||tokens.length!==4)fail('ASCII STL 顶点无效。');facet.push(tokens.slice(1).map(Number));}
      if(tag==='endfacet'){if(facet?.length!==3)fail('ASCII STL 面缺少顶点。');triangles.push(facet);facet=null;if(triangles.length>MAX_FACES)fail('STL 超过 65,000 个三角面，请先简化。');}
    }if(facet)fail('ASCII STL 面不完整。');
  }return finish([{label:name,color:neutral.slice(),triangles}]);
}
function convertStep(bytes,name,occt){
  if(!/^\s*ISO-10303-21;/i.test(new TextDecoder().decode(bytes.subarray(0,128))))fail('需要 ISO 10303-21 格式的 STEP 文件。');
  const model=occt.ReadStepFile(bytes,{linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:.001,angularDeflection:.45});
  if(!model.success||!model.meshes?.length)fail('STEP 没有可预览的实体表面。');
  const meshes=[];let count=0;
  for(const m of model.meshes){const xyz=m.attributes.position.array,idx=m.index.array;
    if(idx.length%3||xyz.length%3)fail('STEP 网格无效。');count+=idx.length/3;if(count>MAX_FACES)fail('STEP 网格超过 65,000 个三角面，请使用简化模型。');
    const triangles=[];for(let i=0;i<idx.length;i+=3){const f=[];for(let j=0;j<3;j++){const a=idx[i+j]*3;f.push([xyz[a],xyz[a+1],xyz[a+2]]);}triangles.push(f);}
    if(triangles.length)meshes.push({label:m.name||name,color:m.color?.length>=3?m.color.slice(0,3).map(v=>Math.round(255*Math.min(1,Math.max(0,v)))):neutral.slice(),triangles});
  }return finish(meshes);
}
export function decodePurchasedCad(bytes,name,occt){return /\.stl$/i.test(name)?readSTL(bytes,name):convertStep(bytes,name,occt);}
let queue=Promise.resolve(),cadWorker;
export function readPurchasedCad(fileOrBytes,filename=fileOrBytes?.name){
  const job=queue.then(()=>readOneCad(fileOrBytes,filename));
  queue=job.catch(()=>{});
  return job;
}
async function readOneCad(fileOrBytes,filename){
  if(typeof filename!=='string'||!/\.(stl|step|stp)$/i.test(filename))fail('请选择 .stl、.step 或 .stp 文件。');
  const size=fileOrBytes?.size??fileOrBytes?.byteLength;if(!Number.isSafeInteger(size)||size<=0||size>MAX_BYTES)fail('请选择非空且不超过 16 MiB 的 CAD 文件。');

    const buf=typeof fileOrBytes.arrayBuffer==='function'?await fileOrBytes.arrayBuffer():ArrayBuffer.isView(fileOrBytes)?new Uint8Array(fileOrBytes.buffer,fileOrBytes.byteOffset,fileOrBytes.byteLength).slice().buffer:fileOrBytes.slice(0);
    if(typeof Worker==='undefined'){
      if(typeof window!=='undefined')fail('此浏览器不支持后台读取 CAD，请改用支持 Worker 的浏览器。');
      if(/\.stl$/i.test(filename))return decodePurchasedCad(new Uint8Array(buf),filename);
      // Native regression tests use the identical, vendored WASM reader and options.
      const {createRequire}=await import('node:module'),require=createRequire(import.meta.url);
      const factory=require('./assets/cad-reader/occt-import-js.js');return decodePurchasedCad(new Uint8Array(buf),filename,await factory());
    }
    return await new Promise((resolve,reject)=>{
      const w=cadWorker??=new Worker(new URL('./assets/cad-reader/reader-worker.js',import.meta.url));
      let timer;
      const finish=(fn,arg,reset=false)=>{
        clearTimeout(timer);w.onmessage=w.onerror=null;
        if(reset){w.terminate();cadWorker=null}
        fn(arg);
      };
      const limit=(ms,message)=>{clearTimeout(timer);timer=setTimeout(()=>finish(reject,Error(message),true),ms)};
      limit(180_000,'CAD 读取器下载超时，请检查网络后重试。');
      w.onmessage=({data})=>{
        if(data.phase==='parsing'){limit(TIMEOUT,'CAD 解析超时，请使用简化的模型文件。');return}
        if(data.error)finish(reject,Error(data.error));
        else finish(resolve,data.result);
      };
      w.onerror=()=>finish(reject,Error('CAD 读取器无法运行，请重新加载页面后重试。'),true);
      w.postMessage({buffer:buf,filename,protocol:2},[buf]);
    });
}
