// Photos are private to a version in this browser. Project records and share links carry no image bytes.
const limit=3,maxBytes=256*1024;
let database;
function openDatabase(){
 if(!database)database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('formwork-private-design-images',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('versions');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 }).catch(error=>{database=null;throw error});
 return database;
}
export async function versionImages(id,images){
 const db=await openDatabase();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('versions',images===undefined?'readonly':'readwrite'),store=tx.objectStore('versions');
  const request=images===undefined?store.get(id):store.put(images,id);
  tx.oncomplete=()=>resolve(images??request.result??[]);
  tx.onerror=tx.onabort=()=>reject(tx.error);
 });
}

async function compressPhoto(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('请选择 JPEG、PNG 或 WebP 照片。');
 if(file.size>24*1024*1024)throw Error('请选择小于 24 MB 的照片。');
 const url=URL.createObjectURL(file),image=new Image();
 try{
  image.src=url;
  await image.decode().catch(()=>{throw Error('这张照片无法读取，请换一张。')});
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  for(let edge=1600;edge>=500;edge=Math.floor(edge*.78)){
   const ratio=Math.min(1,edge/Math.max(image.naturalWidth,image.naturalHeight));
   canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));
   canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
   ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
   const dataUrl=canvas.toDataURL('image/jpeg',.84);
   if(dataUrl.startsWith('data:image/jpeg;base64,')&&dataUrl.length<=Math.floor(maxBytes*4/3))return {dataUrl};
  }
  throw Error('照片压缩后仍过大，请裁剪到产品和标尺所在区域。');
 }finally{URL.revokeObjectURL(url)}
}

export function photoPicker(form,id,capabilities,initial=[]){
 if(!form)return null;
 const box=document.createElement('fieldset');box.className='design-images';
 box.innerHTML='<legend class="sr">参考照片</legend><label class="photo-label">添加参考照片<input type="file" multiple accept="image/jpeg,image/png,image/webp"></label><small class="photo-help"></small><div class="photo-thumbs"></div><small role="status" aria-live="polite"></small>';
 const input=box.querySelector('input'),label=box.querySelector('label'),help=box.querySelector('.photo-help');
 const thumbs=box.querySelector('.photo-thumbs'),status=box.querySelector('[role=status]');
 input.id=id;input.setAttribute('aria-label','添加产品或带标尺的参考照片');
 const before=form.querySelector('.composer-foot');if(before)form.insertBefore(box,before);else form.append(box);
 let photos=[],busy=false,loading=false,error='',message='',enabled=false,pending=Promise.resolve(),selection=0;
 function render(){
  enabled=capabilities()?.designImages===true;
  input.disabled=busy||loading||!enabled||photos.length>=limit;
  label.classList.toggle('photo-disabled',input.disabled);
  help.textContent=enabled?'可选，最多 3 张产品或标尺照片。照片随本次需求发给模型，并保存在此浏览器。':
   capabilities()?.ai?'此连接仅支持文字。':'可在已连接图片模型的工作室添加照片。';
  thumbs.replaceChildren();
  photos.forEach((photo,i)=>{
   const figure=document.createElement('span'),img=document.createElement('img'),remove=document.createElement('button');
   img.src=photo.dataUrl;img.alt='参考照片 '+(i+1);
   remove.type='button';remove.dataset.removeImage=String(i);remove.textContent='×';remove.setAttribute('aria-label','移除参考照片 '+(i+1));
   remove.disabled=busy||loading;remove.onclick=()=>{photos.splice(i,1);error='';render()};
   figure.append(img,remove);thumbs.append(figure);
  });
  status.textContent=error||message||(loading?'正在准备照片…':'');
 }
 function change(load){
  const token=++selection;
  error='';message='';loading=true;render();
  pending=Promise.resolve().then(load).then(next=>{if(token===selection)photos=next})
   .catch(e=>{if(token===selection)error=e.message||'照片无法读取。'})
   .finally(()=>{if(token===selection){loading=false;render()}});
 }
 input.onchange=()=>{
  const selected=[...input.files];input.value='';if(!selected.length)return;
  change(async()=>{
   if(selected.length+photos.length>limit)throw Error('最多可选三张照片，请重新选择。');
   const next=[...photos];for(const file of selected)next.push(await compressPhoto(file));
   return next;
  });
 };
 if(initial instanceof Promise)change(()=>initial);
 else{photos=[...initial];render()}
 return {
  refresh:render,
  lock(value){busy=value;render()},
  message(value){message=value;render()},
  clear(){selection++;pending=Promise.resolve();photos=[];loading=false;error='';message='';render()},
  async selected(){
   await pending;
   if(error){const previous=error;error='';render();throw Error(previous);}
   if(photos.length&&!enabled)throw Error('此连接仅支持文字。请移除照片，或在支持图片的工作室继续。');
   return photos.map(({dataUrl})=>({dataUrl}));
  }
 };
}
