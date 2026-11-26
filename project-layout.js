import {resolveModelForRow,readBindingGeometry,bindingKeys} from './model-selection.js';
import {loadPartMeshes} from './assembly-hardware.js';
import {prepareMesh,createRaster,fitCamera} from './mesh-renderer.js';
import {MAX_CAD_BODIES} from './cad-plan.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const tuple=v=>v.map(n=>Number(n.toFixed(2))).join(', ');

export function cleanPlacements(input,design,items={}){
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>MAX_CAD_BODIES)throw Error('装配位置须为数组，最多 '+MAX_CAD_BODIES+' 个实例。');
 const parts=design?.parts;if(!Array.isArray(parts))throw Error('装配位置缺少对应的零件清单。');
 const counts=new Map();
 return input.map((p,i)=>{
  if(!p||!Number.isInteger(p.partIndex)||p.partIndex<0||p.partIndex>=parts.length)throw Error(`第 ${i+1} 个位置引用了无效的零件行。`);
  if(!vec(p.positionMm)||!vec(p.rotationDeg))throw Error(`第 ${i+1} 个位置须包含三向有限坐标与旋转角度。`);
  const count=(counts.get(p.partIndex)||0)+1,qty=parts[p.partIndex]?.qty;
  if(!Number.isInteger(qty)||qty<1||count>qty)throw Error(`「${parts[p.partIndex]?.name||p.partIndex+1}」的位置数量超过 BOM 数量。`);
  counts.set(p.partIndex,count);
  const current=bindingKeys(parts[p.partIndex],items[p.partIndex]),keys={};
  for(const key of ['partKey','purchaseKey']){const value=p[key]===undefined?current[key]:p[key];if(typeof value!=='string'||value.length>5000)throw Error(`第 ${i+1} 个位置的型号关联无效。`);keys[key]=value}
  return {partIndex:p.partIndex,positionMm:[...p.positionMm],rotationDeg:[...p.rotationDeg],...keys};
 });
}

// Each imported/model-library part gets one common local origin across its
// material meshes: XY envelope centre at the lowest Z, then Rx -> Ry -> Rz.
export function placeModelMeshes(meshes,placement){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 if(!Array.isArray(meshes)||!meshes.length)throw Error('模型没有可显示的网格。');
 for(const mesh of meshes){
  if(!Array.isArray(mesh.triangles)||!mesh.triangles.length)throw Error('模型网格不完整。');
  for(const face of mesh.triangles){if(!Array.isArray(face)||face.length!==3)throw Error('模型三角面无效。');for(const point of face){if(!vec(point))throw Error('模型坐标无效。');for(let k=0;k<3;k++){min[k]=Math.min(min[k],point[k]);max[k]=Math.max(max[k],point[k])}}}
 }
 const origin=[min[0]/2+max[0]/2,min[1]/2+max[1]/2,min[2]],angle=placement.rotationDeg.map(v=>(v%360)*Math.PI/180);
 const [sx,sy,sz]=angle.map(Math.sin),[cx,cy,cz]=angle.map(Math.cos);
 const transform=p=>{const [x,y,z]=p.map((v,k)=>v-origin[k]),y1=y*cx-z*sx,z1=y*sx+z*cx,x2=x*cy+z1*sy,z2=-x*sy+z1*cy;const rotated=[x2*cz-y1*sz,x2*sz+y1*cz,z2];return rotated.map((v,k)=>v+placement.positionMm[k])};
 return meshes.map(mesh=>({...mesh,triangles:mesh.triangles.map(face=>face.map(transform))}));
}

export function projectLayoutUI(st){
 let placements;try{placements=cleanPlacements(st.placements,st.design,st.items||{})}catch(error){return `<section class="panel" id="project-layout"><h2>当前项目装配布局</h2><p role="alert">${esc(error.message)}</p></section>`}
 if(!placements.length)return '';
 const total=st.design.parts.reduce((n,part)=>n+part.qty,0);
 return `<section class="mc" id="project-layout"><header class="mc-top"><span class="mc-label">PROJECT / ASSEMBLY</span><strong>当前项目装配布局</strong><small>世界坐标 mm · +Z 向上</small></header><div class="mc-actions" style="padding-top:14px"><p style="margin:0">使用项目明确给出的 ${placements.length} 个位置；清单共有 ${total} 个零件。布局用于检查空间关系，尚未验证安装、干涉或制造。</p><small>各零件以自身包络底面中心为原点；按 X → Y → Z 旋转后平移。未给出位置的零件不自动摆放。</small></div><div class="mc-stage"><canvas tabindex="0" aria-label="项目装配视图：拖动或方向键旋转，加减键缩放，0 键归位"></canvas><div class="mc-switch" aria-label="装配观察方向"><button type="button" data-layout-view="home">轴测视图</button><button type="button" data-layout-view="top">俯视</button><button type="button" data-layout-view="front">正视</button></div><div class="mc-view"><button type="button" data-layout-view="out" aria-label="缩小装配">−</button><button type="button" data-layout-view="in" aria-label="放大装配">＋</button><button type="button" data-layout-view="home">归位</button></div><span class="mc-hint">拖动旋转 · 滚轮缩放 · 点击选择实例</span></div><div class="mc-actions" style="padding-top:14px"><p data-layout-status role="status" style="margin:0">正在读取零件几何…</p><p data-layout-selection class="muted" style="margin:0"></p><details><summary>位置与朝向 · ${placements.length} 个实例</summary><div class="table-wrap"><table><thead><tr><th>零件实例</th><th>位置 X, Y, Z / mm</th><th>旋转 X, Y, Z / °</th><th>模型状态</th></tr></thead><tbody>${placements.map((p,i)=>`<tr data-layout-row="${i}"><td><button class="btn" type="button" data-layout-instance="${i}">${String(i+1).padStart(2,'0')} · ${esc(st.design.parts[p.partIndex].name)}</button></td><td>${tuple(p.positionMm)}</td><td>${tuple(p.rotationDeg)}</td><td data-layout-row-status>待加载</td></tr>`).join('')}</tbody></table></div></details><ul data-layout-skipped hidden style="margin:0;padding-left:18px"></ul></div></section>`;
}

export function mountProjectLayout(root,st){
 if(!root)return ()=>{};
 const canvas=root.querySelector('canvas');if(!canvas)return ()=>{};
 let placements;try{placements=cleanPlacements(st.placements,st.design,st.items||{})}catch{return ()=>{}}
 if(!placements.length)return ()=>{};
 const raster=createRaster(canvas),status=root.querySelector('[data-layout-status]'),selection=root.querySelector('[data-layout-selection]'),skipped=root.querySelector('[data-layout-skipped]');
 canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
 status.textContent='正在读取零件几何…';selection.textContent='';skipped.hidden=true;skipped.replaceChildren();
 for(const cell of root.querySelectorAll('[data-layout-row-status]')){cell.textContent='待加载';cell.title=''}
 for(const button of root.querySelectorAll('[data-layout-instance]'))button.setAttribute('aria-pressed','false');
 let scene=[],disposed=false,frame=0,yaw=-.65,pitch=.55,zoom=1,drag=null,selected=null;
 const instances=new Map();
 function paint(){frame=0;if(disposed||!root.isConnected||!scene.length)return;const box=canvas.getBoundingClientRect();if(!box.width||!box.height)return;const camera=fitCamera(scene,yaw,pitch,{x:box.width*.08,y:box.height*.15,width:box.width*.84,height:box.height*.7});camera.scale*=zoom;camera.selected=selected;raster.draw(scene,camera)}
 function schedule(){if(!frame)frame=requestAnimationFrame(paint)}
 function reset(){yaw=-.65;pitch=.55;zoom=1;schedule()}
 function scale(by){zoom=Math.min(5,Math.max(.3,zoom*by));schedule()}
 function choose(id){selected=instances.has(id)?id:null;const instance=instances.get(selected);selection.textContent=instance?`选中：${instance.name} · ${instance.source} · 位置 (${tuple(instance.placement.positionMm)}) mm`:'请选择一个已加载的实例。';root.querySelectorAll('[data-layout-instance]').forEach(button=>button.setAttribute('aria-pressed',String('instance-'+button.dataset.layoutInstance===selected)));schedule()}
 async function load(){
  const models=new Map(),errors=[];let shown=0;
  // CAD imports share a single worker service; read each BOM model once in sequence.
  for(let i=0;i<placements.length;i++){
   if(disposed||!root.isConnected)return;
   const p=placements[i],part=st.design.parts[p.partIndex],name=`${i+1} · ${part.name}`,cell=root.querySelector(`[data-layout-row="${i}"] [data-layout-row-status]`);
   try{
    const keys=bindingKeys(part,st.items?.[p.partIndex]);
    if(p.partKey!==keys.partKey||p.purchaseKey!==keys.purchaseKey)throw Error('这个位置属于先前的零件或采购型号，需重新确认安装姿态。');
    let model=models.get(p.partIndex);
    if(!model){
     const resolved=resolveModelForRow(part,st.items?.[p.partIndex],st.cadBindings?.[p.partIndex]);
     if(resolved.stale)throw Error('采购规格或型号已变化，旧绑定与布局需重新核对。');
     if(resolved.kind==='unmatched')throw Error(resolved.notice||'没有对应的模型。');
     const meshes=resolved.kind==='binding'?(await readBindingGeometry(resolved.binding)).meshes:await loadPartMeshes(resolved.id);
     const source=resolved.kind==='binding'?(resolved.binding.kind==='dimensions'?'尺寸近似模型':resolved.binding.kind==='manufacturer'?'原厂 CAD':'供货商 CAD'):resolved.catalogOriginal?'原厂 CAD（内置）':'目录参考模型';
     model={meshes,source,notice:resolved.notice};models.set(p.partIndex,model);
    }
    if(disposed||!root.isConnected)return;
    const id='instance-'+i,placed=placeModelMeshes(model.meshes,p);
    for(const mesh of placed)scene.push({id,mesh:prepareMesh(mesh.triangles,mesh.color||[135,156,148])});
    instances.set(id,{name,placement:p,source:model.source});shown++;cell.textContent=model.source;cell.title=model.notice||'';
   }catch(error){if(disposed||!root.isConnected)return;const reason=String(error.message||error);errors.push(`${name}：${reason}`);cell.textContent='未显示';cell.title=reason}
  }
  if(disposed||!root.isConnected)return;
  status.textContent=`已显示 ${shown} / ${placements.length} 个位置实例${errors.length?`；${errors.length} 个未显示`:'。'}${shown?' 位置来源于项目记录，不代表已验证适配。':'。请先绑定对应型号的模型。'}`;
  skipped.hidden=!errors.length;skipped.innerHTML=errors.map(error=>`<li>${esc(error)}</li>`).join('');schedule();
 }
 root.onclick=e=>{const button=e.target.closest('[data-layout-view],[data-layout-instance]');if(!button)return;if(button.dataset.layoutInstance!==undefined){choose('instance-'+button.dataset.layoutInstance);return}const action=button.dataset.layoutView;if(action==='home')reset();if(action==='top'){yaw=0;pitch=Math.PI/2;zoom=1;schedule()}if(action==='front'){yaw=0;pitch=0;zoom=1;schedule()}if(action==='in')scale(1.2);if(action==='out')scale(1/1.2)};
 canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY,yaw,pitch];canvas.setPointerCapture(e.pointerId)};
 canvas.onpointermove=e=>{if(!drag)return;yaw=drag[2]+(e.clientX-drag[0])*.012;pitch=Math.min(Math.PI/2,Math.max(-Math.PI/2,drag[3]+(e.clientY-drag[1])*.012));schedule()};
 canvas.onpointerup=e=>{if(drag&&Math.hypot(e.clientX-drag[0],e.clientY-drag[1])<4){const box=canvas.getBoundingClientRect();choose(raster.pick(e.clientX-box.left,e.clientY-box.top))}drag=null};canvas.onpointercancel=()=>{drag=null};
 const wheel=e=>{e.preventDefault();scale(Math.exp(-e.deltaY*.0018))};canvas.addEventListener('wheel',wheel,{passive:false});
 canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=Math.min(Math.PI/2,pitch+.12);if(e.key==='ArrowDown')pitch=Math.max(-Math.PI/2,pitch-.12);if(e.key==='+'||e.key==='=')scale(1.2);if(e.key==='-')scale(1/1.2);if(e.key==='0')reset();schedule()};
 const observer=new ResizeObserver(schedule);observer.observe(canvas);load();
 return ()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);canvas.removeEventListener('wheel',wheel);root.onclick=null;canvas.onpointerdown=canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=canvas.onkeydown=null;scene=[]};
}
