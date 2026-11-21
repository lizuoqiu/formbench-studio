import {catalog,matchHardware,loadPartMeshes,getHardwareMetadata} from './assembly-hardware.js';
import {prepareMesh,createRaster} from './mesh-renderer.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const entries=parts=>parts.map((part,index)=>({part,index,id:matchHardware(part)}));
const url=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}};
const sourceLink=(label,value)=>{const href=url(value);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:''};
const measure=n=>Number(n.toFixed(2)).toLocaleString('zh-CN',{maximumFractionDigits:2});
const localModelFile=(id,file)=>{const dir=catalog[id]?.dir;if(!/^[a-zA-Z0-9_-]+$/.test(dir||'')||typeof file!=='string'||!/^[a-zA-Z0-9_][\w.-]*\.(?:stl|step|stp|zip|scad|py|js|wrl|json)$/i.test(file))return null;return new URL(`./assets/hardware/${dir}/${file}`,import.meta.url).href};
function sourceClass(data){
 const type=data?.modelType||data?.sourceType||'';
 if(/^(?:independent-reference|independent-model|self-authored|illustrative-cable-route|illustrative-wire-route)$/.test(type)||/\bindependent model\b|\bFormBench contributors\b/i.test(data?.author||''))return {label:'自建参考模型',independent:true};
 if(type==='manufacturer-cad')return {label:'原厂 CAD 转换',independent:false};
 if(type==='open-cad-reference'||type==='candidate-fastener')return {label:'开放授权 CAD',independent:false};
 if(type==='package-reference')return {label:'封装库参考模型',independent:false};
 return {label:'有来源记录的参考模型',independent:false};
}
export function hardwareMetadataUI(id,data,bounds){
 const entry=catalog[id]||{},kind=sourceClass(data),links=[sourceLink(kind.independent?'尺寸与产品资料':'上游模型来源',data?.sourceUrl),sourceLink('许可说明',data?.licenseUrl)].filter(Boolean);
 const sourceFiles=[['STEP 实体',data?.stepFile],['建模源文件',data?.sourceFile!==data?.stepFile?data?.sourceFile:null]].map(([label,file])=>{const href=localModelFile(id,file);return href?`<a download href="${esc(href)}">下载 ${esc(label)} <small>${esc(file)}</small></a>`:''}).filter(Boolean);
 const meshes=(data?.meshes||[]).map(mesh=>{const href=/\.stl$/i.test(mesh.file||'')&&localModelFile(id,mesh.file);return href?`<li><a download href="${esc(href)}">${esc(mesh.label||mesh.file)} <small>${esc(mesh.file)}</small></a></li>`:''}).filter(Boolean);
 return `<dl><div><dt>参考型号</dt><dd><strong>${esc(data?.label||entry.label||id)}</strong></dd></div><div><dt>来源类型</dt><dd>${esc(data?kind.label:'来源记录暂不可用')}</dd></div><div><dt>适配情况</dt><dd>按清单描述匹配的候选；尚未核对具体型号、孔位与装配。</dd></div>${bounds?`<div><dt>模型外包络</dt><dd>${bounds.map(measure).join(' × ')} mm</dd></div>`:''}${data?.author?`<div><dt>模型作者</dt><dd>${esc(data.author)}</dd></div>`:''}<div><dt>许可</dt><dd>${esc(data?.license||'来源记录未提供')}</dd></div></dl>${data?.description||entry.description?`<p>${esc(data?.description||entry.description)}</p>`:''}${kind.independent?'<p class="hl-provenance">此几何由项目独立建立。下方链接提供尺寸或产品参考资料，不是原厂 CAD 文件。</p>':''}${links.length?`<div class="hl-sources">${links.join('')}</div>`:'<p>暂无可打开的来源链接。</p>'}${sourceFiles.length?`<div class="hl-downloads">${sourceFiles.join('')}</div>`:''}${meshes.length?`<details class="hl-mesh-files"><summary>下载分件 STL · ${meshes.length} 个文件</summary><p>各分件使用模型坐标，单位 mm；STL 文件不保存预览颜色。</p><ul>${meshes.join('')}</ul></details>`:''}${data?.modifications||data?.provenance?`<details class="hl-source-record"><summary>来源与处理记录</summary><p>${esc(data.modifications||data.provenance)}</p></details>`:''}`;
}

export function hardwareLibraryUI(parts){
 const rows=entries(parts),matched=rows.filter(row=>row.id).length;
 return `<section class="hl" id="hardware-library" aria-labelledby="hl-title"><header class="hl-head"><div><span class="hl-kicker">BOM / 零件模型</span><h2 id="hl-title">当前清单的零件</h2></div><span class="hl-count">${matched} / ${rows.length} 项有候选模型</span></header><p class="hl-intro">按当前零件清单匹配可查看的模型。选择零件检查外形、尺寸和来源，再核对所购型号与装配空间。</p><div class="hl-layout"><nav class="hl-list" aria-label="当前清单中的零件">${rows.map(({part,index,id})=>`<button type="button" class="hl-item" data-hardware-row="${index}" aria-pressed="false"><span class="hl-item-top"><strong>${esc(part.name)}</strong><span>× ${esc(part.qty)}</span></span><span class="hl-spec">${esc(part.spec)}</span><span class="hl-match ${id?'':'hl-unmatched'}">${id?'候选：'+esc(catalog[id]?.label||id):'未匹配模型'}</span></button>`).join('')||'<p class="hl-empty">当前项目还没有零件。</p>'}</nav><div class="hl-detail"><div class="hl-selection"><h3 data-hardware-title>选择一个零件</h3><p data-hardware-spec></p></div><div class="hl-stage"><canvas hidden tabindex="0" aria-label="零件实体视图：拖动或方向键旋转，加减键缩放，0 键归位"></canvas><p class="hl-empty" data-hardware-empty>选择左侧零件查看模型。</p><div class="hl-controls" hidden><button type="button" data-hardware-view="out" aria-label="缩小零件">−</button><button type="button" data-hardware-view="in" aria-label="放大零件">＋</button><button type="button" data-hardware-view="reset">归位</button></div><span class="hl-gesture" hidden>拖动旋转 · 滚轮缩放</span></div><p class="hl-status" data-hardware-status role="status"></p><div class="hl-metadata" data-hardware-meta></div></div></div></section>`;
}

export function mountHardwareLibrary(root,parts){
 if(!root)return ()=>{};
 const rows=entries(parts),canvas=root.querySelector('canvas'),raster=createRaster(canvas);
 const title=root.querySelector('[data-hardware-title]'),spec=root.querySelector('[data-hardware-spec]');
 const empty=root.querySelector('[data-hardware-empty]'),status=root.querySelector('[data-hardware-status]'),meta=root.querySelector('[data-hardware-meta]');
 const controls=root.querySelector('.hl-controls'),gesture=root.querySelector('.hl-gesture');
 let disposed=false,request=0,scene=[],yaw=-.65,pitch=.5,zoom=1,target=[0,0,0],extent=1,drag=null,frame=0;
 function paint(){frame=0;if(disposed||!root.isConnected||!scene.length)return;const box=canvas.getBoundingClientRect();raster.draw(scene,{yaw,pitch,target,scale:zoom*Math.min(box.width,box.height)*.72/extent})}
 function schedule(){if(!frame)frame=requestAnimationFrame(paint)}
 function zoomBy(by){zoom=Math.min(5,Math.max(.35,zoom*by));schedule()}
 function reset(){yaw=-.65;pitch=.5;zoom=1;schedule()}
 function showMesh(show){canvas.hidden=!show;controls.hidden=!show;gesture.hidden=!show;empty.hidden=show}
 function metadata(row,data,bounds){
  meta.innerHTML=hardwareMetadataUI(row.id,data,bounds);
  if(data?.label){const label=root.querySelector(`[data-hardware-row="${row.index}"] .hl-match`);if(label)label.textContent='候选：'+data.label}
 }
 async function select(index){
  const row=rows[index];if(!row)return;const token=++request;scene=[];drag=null;reset();showMesh(false);meta.replaceChildren();
  title.textContent=row.part.name;spec.textContent=row.part.spec||'';
  root.querySelectorAll('[data-hardware-row]').forEach(el=>el.setAttribute('aria-pressed',String(Number(el.dataset.hardwareRow)===index)));
  if(!row.id){empty.textContent='尚无匹配的三维模型';status.textContent='这项零件保留在清单中；取得对应型号的模型后才能检查几何配合。';return}
  empty.textContent='正在读取零件模型…';status.textContent='';
  const [meshResult,metadataResult]=await Promise.allSettled([loadPartMeshes(row.id),getHardwareMetadata(row.id)]);
  if(disposed||token!==request||!root.isConnected)return;
  const data=metadataResult.status==='fulfilled'?metadataResult.value:null;
  if(meshResult.status!=='fulfilled'||!Array.isArray(meshResult.value)||!meshResult.value.length){empty.textContent='模型暂不可用';status.textContent='当前无法加载实体文件，尚不能预览或核对尺寸。';metadata(row,data);return}
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  try{
   scene=meshResult.value.map((part,i)=>{
    if(!Array.isArray(part.triangles)||!part.triangles.length)throw Error('模型没有网格');
    for(const face of part.triangles){if(face.length!==3)throw Error('无效网格');for(const point of face){if(point.length!==3||!point.every(Number.isFinite))throw Error('无效坐标');point.forEach((v,k)=>{min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v)})}}
    return {id:String(i),mesh:prepareMesh(part.triangles,part.color||[130,148,142])};
   });
  }catch{scene=[];empty.textContent='模型暂不可用';status.textContent='实体文件不完整，尚不能预览或核对尺寸。';metadata(row,data);return}
  const bounds=max.map((v,k)=>v-min[k]);target=min.map((v,k)=>(v+max[k])/2);extent=Math.hypot(...bounds)||1;
  metadata(row,data,bounds);showMesh(true);status.textContent=metadataResult.status==='fulfilled'?'当前显示该候选模型的实体网格；尚未验证实物装配。':'模型已加载，来源记录暂时无法读取。';schedule();
 }
 root.onclick=e=>{const item=e.target.closest('[data-hardware-row]');if(item){select(Number(item.dataset.hardwareRow));return}const action=e.target.closest('[data-hardware-view]')?.dataset.hardwareView;if(action==='in')zoomBy(1.2);if(action==='out')zoomBy(1/1.2);if(action==='reset')reset()};
 canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY,yaw,pitch];canvas.setPointerCapture(e.pointerId)};
 canvas.onpointermove=e=>{if(!drag)return;yaw=drag[2]+(e.clientX-drag[0])*.012;pitch=Math.min(1.5,Math.max(-1.5,drag[3]+(e.clientY-drag[1])*.012));schedule()};
 canvas.onpointerup=canvas.onpointercancel=()=>{drag=null};
 const wheel=e=>{e.preventDefault();zoomBy(Math.exp(-e.deltaY*.0018))};canvas.addEventListener('wheel',wheel,{passive:false});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=Math.min(1.5,pitch+.12);if(e.key==='ArrowDown')pitch=Math.max(-1.5,pitch-.12);if(e.key==='+'||e.key==='=')zoomBy(1.2);if(e.key==='-')zoomBy(1/1.2);if(e.key==='0')reset();schedule()};
 const observer=new ResizeObserver(schedule);observer.observe(canvas);
 if(rows.length)select(Math.max(0,rows.findIndex(row=>row.id)));
 return ()=>{disposed=true;request++;observer.disconnect();cancelAnimationFrame(frame);canvas.removeEventListener('wheel',wheel);root.onclick=null;canvas.onpointerdown=canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=canvas.onkeydown=null};
}
