// Public studio snapshots are ordinary static files. Opening one never calls
// the design service or writes it into the viewer's personal project list.
const manifestUrl=new URL('./samples/shared/manifest.json',import.meta.url);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let galleryPromise;

export function galleryAsset(path){
  if(typeof path!=='string'||!path.trim())return null;
  const url=new URL(path,manifestUrl);
  return url.origin===manifestUrl.origin&&url.pathname.startsWith(new URL('./',manifestUrl).pathname)?url.href:null;
}
export function shareLink(slug,version,base=location.href){
  const url=new URL(base);url.search='';url.hash='';
  url.searchParams.set('share',slug);url.searchParams.set('version',String(version));
  return url.href;
}
export function verificationText(value){
  return value?.cad==='checked'?'仅 CAD 已核验 · 未实物验证':'CAD 尚未核验 · 未实物验证';
}
export async function galleryProjects(){
  if(!galleryPromise)galleryPromise=fetch(manifestUrl).then(async response=>{
    if(!response.ok)throw Error('精选项目暂时无法读取。');
    const data=await response.json();
    if(!Array.isArray(data.projects))throw Error('精选项目目录不完整。');
    return data.projects.filter(p=>typeof p?.slug==='string'&&/^[a-z0-9-]+$/.test(p.slug)&&typeof p.title==='string'&&Array.isArray(p.versions)).map(p=>({...p,
      versions:p.versions.filter(v=>Number.isSafeInteger(v.version)&&v.version>0&&galleryAsset(v.design)).sort((a,b)=>a.version-b.version)
    })).filter(p=>p.versions.length);
  }).catch(error=>{galleryPromise=null;throw error});
  return galleryPromise;
}
export async function loadSharedProject(slug,version){
  const projects=await galleryProjects(),entry=projects.find(p=>p.slug===slug);
  if(!entry)throw Error('没有找到这个分享项目，请从首页重新选择。');
  const selected=version==null?entry.versions.at(-1):entry.versions.find(v=>String(v.version)===String(version));
  if(!selected)throw Error('这个分享版本不存在，请从首页打开最新版本。');
  const response=await fetch(galleryAsset(selected.design));
  if(!response.ok)throw Error('这一版设计暂时无法读取。');
  const data=await response.json(),design=data.design||data;
  if(!design||!Array.isArray(design.parts)||!design.parts.length)throw Error('这一版设计的零件资料不完整。');
  return {design,record:{prompt:data.prompt||selected.prompt||'',iteration:{...data.iteration,version:selected.version,previousId:undefined},
    savedCadUrl:galleryAsset(selected.cad),shared:{entry,selected}}};
}
export async function mountGallery(container,onOpen){
  try{
    const projects=await galleryProjects();
    container.innerHTML=projects.map(p=>{
      const v=p.versions.at(-1),preview=galleryAsset(v.preview||p.preview),kind=v.previewKind||p.previewKind;
      return `<a class="example-card gallery-card" href="${esc(shareLink(p.slug,v.version))}" data-shared-slug="${esc(p.slug)}" data-shared-version="${v.version}">
        <span class="example-cover">${preview?`<img src="${esc(preview)}" alt="${esc(p.title)}${kind==='cad'?' CAD 预览':'设计示意'}" loading="lazy" width="960" height="600">`:'<span class="gallery-placeholder">查看设计</span>'}</span>
        <span class="example-caption"><span><strong>${esc(p.title)}</strong><small>${esc(p.summary||'查看零件与三维设计')}</small></span><span aria-hidden="true" class="card-arrow">↗</span></span>
        <span class="gallery-meta"><span>${p.source==='example'?'示例':'工作室精选'}</span><span>${esc(verificationText(v.verification))}</span></span></a>`;
    }).join('');
    container.hidden=!projects.length;
    container.onclick=event=>{
      const a=event.target.closest('[data-shared-slug]');
      if(!a||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
      event.preventDefault();onOpen(a.dataset.sharedSlug,Number(a.dataset.sharedVersion));
    };
  }catch{container.hidden=true}
}
export function sharedProjectBar(shared){
  const {entry,selected}=shared;
  const referenceImage=galleryAsset(selected.referenceImage);
  return `<section class="shared-project-bar" aria-label="分享项目"><div class="shared-project-context"><b>${entry.source==='example'?'示例':'工作室精选'}</b><span>公开版本 · 只读</span><span>${esc(verificationText(selected.verification))}</span></div>
    <div class="shared-project-controls"><label>版本 <select id="shared-version" aria-label="分享项目版本">${entry.versions.map(v=>`<option value="${v.version}" ${v.version===selected.version?'selected':''}>${esc(v.label||'第 '+v.version+' 版')}</option>`).join('')}</select></label><button type="button" class="small-button" id="copy-project">创建个人副本</button><button type="button" class="small-button" id="close-shared">关闭</button></div>
    ${selected.verification?.note?`<p class="shared-verification-note">${esc(selected.verification.note)}</p>`:''}${referenceImage?`<a class="shared-reference-image" href="${esc(referenceImage)}" target="_blank" rel="noopener noreferrer">查看该版参考图 ↗</a>`:''}</section>`;
}
export function showShareDialog(link){
  document.querySelector('#project-share-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='project-share-dialog';dialog.className='project-share-dialog';
  dialog.innerHTML=`<form method="dialog"><header><h2>分享这一版</h2><button class="quiet" aria-label="关闭分享窗口">关闭</button></header><p>链接固定到当前公开版本，打开即可查看模型与零件。</p><label for="project-share-url">分享链接</label><input id="project-share-url" type="url" readonly value="${esc(link)}"><div class="share-dialog-actions"><button type="button" class="primary" id="copy-share-link">复制链接</button><span role="status" id="share-copy-status"></span></div></form>`;
  document.body.append(dialog);dialog.showModal();
  const input=dialog.querySelector('input');input.focus();input.select();
  dialog.querySelector('#copy-share-link').onclick=async()=>{
    const status=dialog.querySelector('#share-copy-status');
    try{await navigator.clipboard.writeText(link);status.textContent='链接已复制。'}
    catch{input.focus();input.select();status.textContent='请复制上方已选中的链接。'}
  };
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
}
