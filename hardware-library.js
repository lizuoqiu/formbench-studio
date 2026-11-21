import {catalog,loadPartMeshes,getHardwareMetadata,encodeSTL} from './assembly-hardware.js';
import {prepareMesh,createRaster} from './mesh-renderer.js';
import {resolveModelForRow,createCadBinding,readBindingGeometry,describeSelectedPurchase} from './model-selection.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const entries=(parts,ctx={})=>parts.map((part,index)=>{const resolved=resolveModelForRow(part,ctx.items?.[index],ctx.bindings?.[index]);return {part,index,id:resolved.id,resolved}});
const url=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}};
const sourceLink=(label,value)=>{const href=url(value);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:''};
const measure=n=>Number(n.toFixed(2)).toLocaleString('zh-CN',{maximumFractionDigits:2});
function safeDownloadName(value,fallback,maxBytes=200){
 const base=String(value||fallback).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g,'_').replace(/^\.+/,'').replace(/[. ]+$/,'')||fallback;
 const suffix=base.match(/\.(?:step|stp|stl)$/i)?.[0]||'',stem=suffix?base.slice(0,-suffix.length):base,encoder=new TextEncoder();let kept='',bytes=encoder.encode(suffix).length;
 for(const character of stem){const size=encoder.encode(character).length;if(bytes+size>maxBytes)break;kept+=character;bytes+=size}
 return (kept||'part')+suffix;
}
export async function prepareBindingDownload(binding){
 if(binding.kind!=='dimensions'){
  if(!['manufacturer','supplier'].includes(binding.kind)||!binding.fileBase64)throw Error('此绑定没有可下载的原始 CAD 附件。');
  return {name:safeDownloadName(binding.fileName,'part.step'),bytes:Uint8Array.from(atob(binding.fileBase64),c=>c.charCodeAt(0)),type:'application/octet-stream'};
 }
 const {meshes}=await readBindingGeometry(binding);
 const buffer=encodeSTL(meshes.flatMap(mesh=>mesh.triangles),'FormBench assembly reference; units:mm; not manufacturing validated');
 return {name:safeDownloadName(binding.model,'part',130)+'-assembly-reference-mm.stl',bytes:new Uint8Array(buffer),type:'model/stl'};
}
const localModelFile=(id,file)=>{const dir=catalog[id]?.dir;if(!/^[a-zA-Z0-9_-]+$/.test(dir||'')||typeof file!=='string'||!/^[a-zA-Z0-9_][\w.-]*\.(?:stl|step|stp|zip|scad|py|js|wrl|json)$/i.test(file))return null;return new URL(`./assets/hardware/${dir}/${file}`,import.meta.url).href};
function sourceClass(data){
 const type=data?.modelType||data?.sourceType||'';
 if(type==='dimensioned-approximation')return {label:'按尺寸自绘的参考模型',independent:true};
 if(/^(?:independent-reference|independent-model|self-authored|illustrative-cable-route|illustrative-wire-route)$/.test(type)||/\bindependent model\b|\bFormBench contributors\b/i.test(data?.author||''))return {label:'自建参考模型',independent:true};
 if(type==='manufacturer-cad')return {label:'原厂 CAD 转换',independent:false};
 if(type==='open-cad-reference'||type==='candidate-fastener')return {label:'开放授权 CAD',independent:false};
 if(type==='package-reference')return {label:'封装库参考模型',independent:false};
 return {label:'有来源记录的参考模型',independent:false};
}
export function hardwareMetadataUI(id,data,bounds,resolved){
 const entry=catalog[id]||{},kind=sourceClass(data),links=[sourceLink(kind.independent?'尺寸与产品资料':'上游模型来源',data?.sourceUrl),sourceLink('原厂 CAD 下载',data?.manufacturerCadUrl),sourceLink('许可说明',data?.licenseUrl)].filter(Boolean);
 const sourceFiles=[['STEP 实体',data?.stepFile],['建模源文件',data?.sourceFile!==data?.stepFile?data?.sourceFile:null]].map(([label,file])=>{const href=localModelFile(id,file);return href?`<a download href="${esc(href)}">下载 ${esc(label)} <small>${esc(file)}</small></a>`:''}).filter(Boolean);
 const meshes=(data?.meshes||[]).map(mesh=>{const href=/\.stl$/i.test(mesh.file||'')&&localModelFile(id,mesh.file);return href?`<li><a download href="${esc(href)}">${esc(mesh.label||mesh.file)} <small>${esc(mesh.file)}</small></a></li>`:''}).filter(Boolean);
 return `<dl><div><dt>参考型号</dt><dd><strong>${esc(data?.label||entry.label||id)}</strong></dd></div><div><dt>来源类型</dt><dd>${esc(data?kind.label:'来源记录暂不可用')}</dd></div><div><dt>适配情况</dt><dd>${resolved?.catalogOriginal?'已匹配原厂参考型号。请按到货版本核对接口和安装。':'按零件描述给出的候选。安装尺寸需结合选购型号核对。'}</dd></div>${bounds?`<div><dt>模型外包络</dt><dd>${bounds.map(measure).join(' × ')} mm</dd></div>`:''}${data?.author?`<div><dt>模型作者</dt><dd>${esc(data.author)}</dd></div>`:''}<div><dt>许可</dt><dd>${esc(data?.license||'来源记录未提供')}</dd></div></dl>${data?.description||entry.description?`<p>${esc(data?.description||entry.description)}</p>`:''}${kind.independent?'<p class="hl-provenance">此几何由项目独立建立。下方链接提供尺寸或产品参考资料，不是原厂 CAD 文件。</p>':''}${links.length?`<div class="hl-sources">${links.join('')}</div>`:'<p>暂无可打开的来源链接。</p>'}${sourceFiles.length?`<div class="hl-downloads">${sourceFiles.join('')}</div>`:''}${meshes.length?`<details class="hl-mesh-files"><summary>下载分件 STL · ${meshes.length} 个文件</summary><p>各分件使用模型坐标，单位 mm；STL 文件不保存预览颜色。</p><ul>${meshes.join('')}</ul></details>`:''}${data?.modifications||data?.provenance?`<details class="hl-source-record"><summary>来源与处理记录</summary><p>${esc(data.modifications||data.provenance)}</p></details>`:''}`;
}

const rowLabel=row=>row.resolved.stale?'采购型号已变化 · 旧绑定已停用':row.resolved.kind==='binding'?'已绑定：'+row.resolved.binding.model:row.id?(row.resolved.catalogOriginal?'原厂 CAD：':'目录参考：')+(catalog[row.id]?.label||row.id):'未匹配模型';
const bindingKind=kind=>({manufacturer:'制造商 CAD（按提供者记录）',supplier:'供货商 CAD（按提供者记录）',dimensions:'按尺寸建立的近似模型'}[kind]||'选购型号参考模型');
function bindingMetadataUI(binding,bounds){return `<dl><div><dt>绑定型号</dt><dd><strong>${esc(binding.model)}</strong></dd></div><div><dt>来源类型</dt><dd>${esc(bindingKind(binding.kind))}</dd></div>${binding.fileName?`<div><dt>源文件</dt><dd>${esc(binding.fileName)}</dd></div>`:''}<div><dt>模型外包络</dt><dd>${bounds.map(measure).join(' × ')} mm</dd></div><div><dt>适用范围</dt><dd>${binding.kind==='dimensions'?`零件辨识、粗略装配定位。包含录入的外包络${binding.holes?.length?'及 '+binding.holes.length+' 个通孔':''}，不可作为制造图。`:'装配定位参考。源文件与实际型号的对应关系须核对，制造适用性未验证。'}</dd></div><div><dt>接口与来源备注</dt><dd>${esc(binding.notes||'尚未提供接口朝向或安装备注。')}</dd></div></dl>${binding.sourceUrl?`<div class="hl-sources">${sourceLink(binding.kind==='dimensions'?'尺寸与产品资料':'CAD 来源记录',binding.sourceUrl)}</div>`:''}<div class="hl-downloads"><button class="btn" type="button" data-binding-download>${binding.kind==='dimensions'?'下载装配参考 STL（mm）':'下载原始 CAD 附件'}</button></div>`}
function bindingEditorUI(row,item,binding){
 const selected=describeSelectedPurchase(item),kind=binding?.kind||'manufacturer',dimension=kind==='dimensions',size=binding?.sizeMm||['','',''];
 return `<details class="hl-binding"><summary>按选购型号绑定模型</summary><div class="hl-purchase"><strong>当前采购记录</strong><p>${esc(selected.label||'尚未登记选购商品')}</p>${selected.sku?`<small>规格：${esc(selected.sku)}</small>`:''}${selected.url?sourceLink('查看选购商品',selected.url):''}</div><p class="hl-binding-help">商品链接用于识别选品，不能单独构造模型。有 CAD 时提供对应文件；没有 CAD 时，依据图纸、规格或实测尺寸创建近似参考。</p>${row.resolved.stale?'<p class="hl-binding-warning">采购型号已变化，旧绑定不再代表当前选品。请核对型号和资料后重新绑定。</p>':''}<form data-hardware-binding="${row.index}" class="hl-binding-form"><label>实际型号<input name="model" required maxlength="160" value="${esc(binding?.model||'')}" placeholder="如：制造商名称 + 具体料号／板卡版本"></label><label>模型来源<select name="kind"><option value="manufacturer" ${kind==='manufacturer'?'selected':''}>制造商提供的 CAD</option><option value="supplier" ${kind==='supplier'?'selected':''}>供货商提供的 CAD</option><option value="dimensions" ${dimension?'selected':''}>按图纸／实测尺寸建近似模型</option></select></label><label>来源资料链接（可选）<input name="sourceUrl" type="url" value="${esc(binding?.sourceUrl||'')}" placeholder="CAD 下载页、器件图纸或尺寸规格页"></label><div data-cad-input ${dimension?'hidden':''}><label>对应型号的 CAD 文件<input name="cadFile" type="file" accept=".step,.stp,.stl" ${dimension?'disabled':'required'}></label><small>支持不超过 2 MiB 的 STEP、STP、STL；STL 按 mm 解释。保存会读取所选文件并生成预览。</small></div><fieldset data-dimensions-input ${dimension?'':'hidden disabled'}><legend>外包络尺寸 / mm</legend><label>近似形状<select name="shape"><option value="box" ${binding?.shape!=='cylinder'?'selected':''}>长方体</option><option value="cylinder" ${binding?.shape==='cylinder'?'selected':''}>圆柱体</option></select></label><div class="hl-size-inputs">${['长 X','宽 Y','高 Z'].map((label,i)=>`<label>${label}<input name="size${i}" type="number" min="0.1" max="2000" step="any" required value="${esc(size[i])}"></label>`).join('')}</div><small>圆柱的长、宽均填写直径。尺寸须来自图纸、规格或实测；未提供的接口和插拔空间不会自动补全。</small><details class="hl-hole-input"><summary>可选通孔 · 贯穿 Z 方向</summary><label>孔中心 X、Y、直径 / mm<textarea name="holes" rows="3" placeholder="4, 4, 2.5&#10;28, 4, 2.5">${esc((binding?.holes||[]).map(h=>`${h.x}, ${h.y}, ${h.diameter}`).join("\n"))}</textarea></label><small>每行一个孔，三项以逗号分隔。XY 原点为外包络左下角；圆柱中心为（长/2，宽/2）。孔必须位于轮廓内，不能相交。</small></details></fieldset><label>尺寸依据与接口朝向备注<textarea name="notes" maxlength="1600" rows="3" placeholder="如：尺寸来自厂商图纸第 2 页；USB 朝 -Y，板底为 Z=0；连接器突出量尚未确认。">${esc(binding?.notes||'')}</textarea></label><div class="hl-binding-actions"><button class="btn btn-primary" type="submit">${binding?'更新型号绑定':'保存型号绑定'}</button>${binding?'<button class="btn" type="button" data-binding-clear>移除本项绑定</button>':''}</div><p class="hl-binding-feedback" data-binding-feedback role="status"></p></form></details>`;
}

export function hardwareLibraryUI(parts,ctx={}){
 const rows=entries(parts,ctx),matched=rows.filter(row=>row.resolved.kind!=='unmatched').length;
 return `<section class="hl" id="hardware-library" aria-labelledby="hl-title"><header class="hl-head"><div><h2 id="hl-title">零件模型</h2></div><span class="hl-count">${matched} / ${rows.length} 项有可查看模型</span></header><p class="hl-intro">选择零件查看模型，或绑定对应型号的 CAD 与尺寸。</p><div class="hl-layout"><nav class="hl-list" aria-label="当前清单中的零件">${rows.map(row=>`<button type="button" class="hl-item" data-hardware-row="${row.index}" aria-pressed="false"><span class="hl-item-top"><strong>${esc(row.part.name)}</strong><span>× ${esc(row.part.qty)}</span></span><span class="hl-spec">${esc(row.part.spec)}</span><span class="hl-match ${row.resolved.kind==='unmatched'?'hl-unmatched':''}">${esc(rowLabel(row))}</span></button>`).join('')||'<p class="hl-empty">当前项目还没有零件。</p>'}</nav><div class="hl-detail"><div class="hl-selection"><h3 data-hardware-title>选择一个零件</h3><p data-hardware-spec></p></div><div class="hl-stage"><canvas hidden tabindex="0" aria-label="零件实体视图：拖动或方向键旋转，加减键缩放，0 键归位"></canvas><p class="hl-empty" data-hardware-empty>选择左侧零件查看模型。</p><div class="hl-controls" hidden><button type="button" data-hardware-view="out" aria-label="缩小零件">−</button><button type="button" data-hardware-view="in" aria-label="放大零件">＋</button><button type="button" data-hardware-view="reset">归位</button></div><span class="hl-gesture" hidden>拖动旋转 · 滚轮缩放</span></div><p class="hl-status" data-hardware-status role="status"></p><div class="hl-metadata" data-hardware-meta></div><div data-hardware-binding-slot></div></div></div></section>`;
}

export function mountHardwareLibrary(root,parts,ctx={}){
 if(!root)return ()=>{};
 const bindings={...ctx.bindings},localContext={...ctx,bindings};
 let rows=entries(parts,localContext),selectedIndex=-1;
 const canvas=root.querySelector('canvas'),raster=createRaster(canvas),bindingSlot=root.querySelector('[data-hardware-binding-slot]');
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
  meta.innerHTML=hardwareMetadataUI(row.id,data,bounds,row.resolved);
  if(data?.label&&!row.resolved.stale){const label=root.querySelector(`[data-hardware-row="${row.index}"] .hl-match`);if(label)label.textContent=(row.resolved.catalogOriginal?'原厂 CAD：':'目录参考：')+data.label}
 }
 async function select(index){
  rows=entries(parts,localContext);const row=rows[index];if(!row)return;selectedIndex=index;const token=++request;scene=[];drag=null;reset();showMesh(false);meta.replaceChildren();
  title.textContent=row.part.name;spec.textContent=row.part.spec||'';
  bindingSlot.innerHTML=bindingEditorUI(row,ctx.items?.[index],bindings[index]);
  root.querySelectorAll('[data-hardware-row]').forEach(el=>el.setAttribute('aria-pressed',String(Number(el.dataset.hardwareRow)===index)));
  if(row.resolved.kind==='unmatched'){empty.textContent=row.resolved.stale?'采购型号已变化，需重新绑定模型':'尚无匹配的三维模型';status.textContent=row.resolved.notice||'可在下方绑定对应型号的 CAD 或依据尺寸建立近似参考。';return}
  empty.textContent='正在读取零件模型…';status.textContent='';
  const bound=row.resolved.kind==='binding',record=row.resolved.binding;
  const [meshResult,metadataResult]=await Promise.allSettled([bound?readBindingGeometry(record).then(result=>result.meshes):loadPartMeshes(row.id),bound?Promise.resolve(null):getHardwareMetadata(row.id)]);
  if(disposed||token!==request||!root.isConnected)return;
  const data=metadataResult.status==='fulfilled'?metadataResult.value:null;
  if(meshResult.status!=='fulfilled'||!Array.isArray(meshResult.value)||!meshResult.value.length){empty.textContent='模型暂不可用';status.textContent='当前无法加载实体文件，尚不能预览或核对尺寸。';if(!bound)metadata(row,data);return}
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  try{
   scene=meshResult.value.map((part,i)=>{
    if(!Array.isArray(part.triangles)||!part.triangles.length)throw Error('模型没有网格');
    for(const face of part.triangles){if(face.length!==3)throw Error('无效网格');for(const point of face){if(point.length!==3||!point.every(Number.isFinite))throw Error('无效坐标');point.forEach((v,k)=>{min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v)})}}
    return {id:String(i),mesh:prepareMesh(part.triangles,part.color||[130,148,142])};
   });
  }catch{scene=[];empty.textContent='模型暂不可用';status.textContent='实体文件不完整，尚不能预览或核对尺寸。';if(!bound)metadata(row,data);return}
  const bounds=max.map((v,k)=>v-min[k]);target=min.map((v,k)=>(v+max[k])/2);extent=Math.hypot(...bounds)||1;
  if(bound)meta.innerHTML=bindingMetadataUI(record,bounds);else metadata(row,data,bounds);
  showMesh(true);status.textContent=row.resolved.notice||(bound?'显示已绑定型号的几何参考；尚未验证实物装配。':metadataResult.status==='fulfilled'?'当前显示目录候选网格；尚未验证实物装配。':'模型已加载，来源记录暂时无法读取。');schedule();
 }
 async function saveBinding(index,record){
  if(typeof ctx.onBinding!=='function')throw Error('当前项目暂不能保存型号绑定。');
  await ctx.onBinding(index,record);
  if(record)bindings[index]=record;else delete bindings[index];
  if(disposed||!root.isConnected)return;
  rows=entries(parts,localContext);root.querySelectorAll('[data-hardware-row]').forEach(el=>{const row=rows[Number(el.dataset.hardwareRow)],label=el.querySelector('.hl-match');label.textContent=rowLabel(row);label.classList.toggle('hl-unmatched',row.resolved.kind==='unmatched')});
  root.querySelector('.hl-count').textContent=`${rows.filter(row=>row.resolved.kind!=='unmatched').length} / ${rows.length} 项有可查看模型`;
  if(selectedIndex===index)await select(index);
 }
 root.onclick=async e=>{
  const item=e.target.closest('[data-hardware-row]');if(item){select(Number(item.dataset.hardwareRow));return}
  const download=e.target.closest('[data-binding-download]');if(download){const index=selectedIndex,record=rows[index]?.resolved.binding;if(!record)return;download.disabled=true;try{const file=await prepareBindingDownload(record);if(disposed||!root.isConnected)return;const href=URL.createObjectURL(new Blob([file.bytes],{type:file.type})),anchor=document.createElement('a');anchor.href=href;anchor.download=file.name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(href),1500);if(index===selectedIndex)status.textContent=record.kind==='dimensions'?'已下载毫米单位的装配参考 STL；尚未验证制造适用性。':'已下载原始 CAD 附件，文件内容未经转换。'}catch(error){if(index===selectedIndex)status.textContent=String(error.message||error)}finally{if(download.isConnected)download.disabled=false}return}
  const clear=e.target.closest('[data-binding-clear]');if(clear){const form=clear.closest('form'),index=Number(form.dataset.hardwareBinding),feedback=form.querySelector('[data-binding-feedback]');clear.disabled=true;feedback.textContent='正在移除绑定…';try{await saveBinding(index,null)}catch(error){feedback.textContent=String(error.message||error);clear.disabled=false}return}
  const action=e.target.closest('[data-hardware-view]')?.dataset.hardwareView;if(action==='in')zoomBy(1.2);if(action==='out')zoomBy(1/1.2);if(action==='reset')reset();
 };
 root.onchange=e=>{if(e.target.name!=='kind')return;const form=e.target.closest('[data-hardware-binding]');if(!form)return;const dimension=e.target.value==='dimensions',file=form.elements.cadFile;form.querySelector('[data-cad-input]').hidden=dimension;file.disabled=dimension;file.required=!dimension;const fields=form.querySelector('[data-dimensions-input]');fields.hidden=!dimension;fields.disabled=!dimension};
 root.onsubmit=async e=>{
  const form=e.target.closest('[data-hardware-binding]');if(!form)return;e.preventDefault();e.stopPropagation();if(form.dataset.saving||!form.reportValidity())return;
  const index=Number(form.dataset.hardwareBinding),fd=new FormData(form),kind=fd.get('kind'),feedback=form.querySelector('[data-binding-feedback]'),buttons=form.querySelectorAll('button');form.dataset.saving='1';buttons.forEach(button=>button.disabled=true);feedback.textContent=kind==='dimensions'?'正在生成尺寸参考…':'正在读取 CAD 并生成预览…';
  try{
   const input={item:ctx.items?.[index],part:parts[index],model:String(fd.get('model')||'').trim(),sourceUrl:String(fd.get('sourceUrl')||'').trim(),notes:String(fd.get('notes')||'').trim(),kind};
   if(kind==='dimensions'){input.shape=fd.get('shape');input.sizeMm=[0,1,2].map(i=>Number(fd.get('size'+i)));input.holes=String(fd.get('holes')||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map((line,i)=>{const values=line.split(/[,，]/).map(v=>v.trim());if(values.length!==3||values.some(v=>!v||!Number.isFinite(Number(v))))throw Error('第 '+(i+1)+' 行通孔应为 X, Y, 直径。');const [x,y,diameter]=values.map(Number);return {x,y,diameter}})}else input.file=form.elements.cadFile.files[0];
   const record=await createCadBinding(input);if(disposed||!root.isConnected)return;await saveBinding(index,record);
  }catch(error){if(form.isConnected)feedback.textContent=String(error.message||error)}finally{delete form.dataset.saving;if(form.isConnected)buttons.forEach(button=>button.disabled=false)}
 };
 canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY,yaw,pitch];canvas.setPointerCapture(e.pointerId)};
 canvas.onpointermove=e=>{if(!drag)return;yaw=drag[2]+(e.clientX-drag[0])*.012;pitch=Math.min(1.5,Math.max(-1.5,drag[3]+(e.clientY-drag[1])*.012));schedule()};
 canvas.onpointerup=canvas.onpointercancel=()=>{drag=null};
 const wheel=e=>{e.preventDefault();zoomBy(Math.exp(-e.deltaY*.0018))};canvas.addEventListener('wheel',wheel,{passive:false});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=Math.min(1.5,pitch+.12);if(e.key==='ArrowDown')pitch=Math.max(-1.5,pitch-.12);if(e.key==='+'||e.key==='=')zoomBy(1.2);if(e.key==='-')zoomBy(1/1.2);if(e.key==='0')reset();schedule()};
 const observer=new ResizeObserver(schedule);observer.observe(canvas);
 if(rows.length)select(Math.max(0,rows.findIndex(row=>row.resolved.kind!=='unmatched')));
 return ()=>{disposed=true;request++;observer.disconnect();cancelAnimationFrame(frame);canvas.removeEventListener('wheel',wheel);root.onclick=root.onchange=root.onsubmit=null;canvas.onpointerdown=canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=canvas.onkeydown=null};
}
