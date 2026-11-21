// Guest drafts belong to this browser. Account projects are read and written
// through the authenticated service, with no cross-account offline cache.
const guestKey='formbench.consumer.guest.v1', pendingKey='formbench.consumer.signin-draft.v1';
let account={configured:false,user:null}, service='loading', initial, lastGuestId=null, mountState;
let saveQueue=Promise.resolve(),epoch=0;
const staticPage=()=>location.hostname.endsWith('.github.io');
const ownEndpoint=name=>new URL('./api/'+name,document.baseURI);
const guestProjects=()=>{try{const list=JSON.parse(localStorage.getItem(guestKey)||'[]');return Array.isArray(list)?list.filter(p=>typeof p?.id==='string'&&p.design?.name):[]}catch{return []}};
function keepGuest(record){
  const existing=guestProjects().filter(p=>p.id!==record.id);
  localStorage.setItem(guestKey,JSON.stringify([record,...existing]));
  lastGuestId=record.id;
}
async function api(path,method='GET',body){
  const r=await fetch(ownEndpoint(path),{method,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const data=await r.json().catch(()=>null);
  if(!r.ok||!data)throw Object.assign(new Error(data?.error||'暂时无法连接账号服务。'),{status:r.status});
  return data;
}
async function check(){
  if(staticPage()){service='static';return}
  try{
    const data=await api('auth/status');
    const previous=account.user?.id;
    account={configured:data.configured===true,user:data.authenticated&&data.user?.id?data.user:null};service='ready';
    if(previous&&previous!==account.user?.id){epoch++;mountState?.onSignOut?.()}
  }catch{service='offline'}
}
export async function saveConsumerProject(project){
  const record=structuredClone(project),generation=epoch;
  if(!record.id||!record.design?.name)throw Error('项目资料不完整。');
  await initial;
  const owner=account.user?.id;
  const save=async()=>{
    if(generation!==epoch||owner!==account.user?.id)return;
    if(service==='offline')throw Error('账号服务暂时无法连接，请稍后再保存。');
    if(owner){
      try{await api('projects/'+encodeURIComponent(record.id),'PUT',record)}
      catch(e){if(e.status===401)await check();throw e}
    }else keepGuest({...record,updatedAt:new Date().toISOString()});
  };
  const job=saveQueue.then(save);saveQueue=job.catch(()=>{});return job;
}
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node};
function button(text,action,cls){const b=el('button',text,cls);b.type='button';b.addEventListener('click',action);return b}
export function mountConsumerAccount(container,callbacks={}){
  if(!container)return;
  mountState=callbacks;
  const dialog=document.createElement('dialog');dialog.className='fb-account-dialog';dialog.setAttribute('aria-labelledby','fb-account-title');
  const top=el('header'),title=el('h2','我的项目');title.id='fb-account-title';
  const close=button('关闭',()=>dialog.close(),'fb-account-close');top.append(title,close);
  const body=el('div','','fb-account-body');dialog.append(top,body);document.body.append(dialog);
  const setMessage=(msg)=>{const p=el('p',msg,'fb-account-note');p.setAttribute('role','status');body.append(p)};
  let opened=0;
  function updateBar(){
    container.replaceChildren(button('我的项目',()=>open('projects'),'fb-account-projects'),
      button(account.user||!account.configured?'淘宝账号':'淘宝登录',()=>open('account'),'fb-account-login'));
  }
  function allowLogin(sync=false){
    if(sync&&lastGuestId)sessionStorage.setItem(pendingKey,lastGuestId);
    else sessionStorage.removeItem(pendingKey);
    location.assign(ownEndpoint('auth/taobao').href);
  }
  async function open(tab){
    const serial=++opened;
    if(!dialog.open)dialog.showModal();
    title.textContent=tab==='projects'?'我的项目':'淘宝账号';
    body.replaceChildren(el('p','正在读取…','fb-account-note'));
    await initial;await check();
    if(serial!==opened||!dialog.open)return;
    updateBar();body.replaceChildren();
    if(service==='offline'){
      setMessage('账号服务暂时无法连接。请稍后重试。');
      body.append(button('重试',()=>open(tab),'fb-account-action'));return;
    }
    if(tab==='account'){
      if(account.user){
        body.append(el('strong',account.user.nickname||account.user.displayName||'已连接淘宝账号'));
        setMessage('项目保存在这个账号下。购买时会在淘宝确认商品和规格。');
        body.append(button('退出登录',async()=>{
          try{await saveQueue;await api('auth/logout','POST',{});account.user=null;epoch++;
            callbacks.onSignOut?.();dialog.close();updateBar()}
          catch(e){setMessage(e.message)}
        },'fb-account-action'));return;
      }
      if(account.configured){
        setMessage('前往淘宝完成授权，回来后即可保存和查看账号里的项目。');
        body.append(button('前往淘宝登录',()=>allowLogin(false),'fb-account-action'));
        if(lastGuestId)body.append(button('登录并保存当前方案',()=>allowLogin(true),'fb-account-action'));
      }else{
        setMessage('此站暂未开放淘宝账号登录。你可以在这台设备上保存、重新打开设计。');
        body.append(button('查看此设备的项目',()=>open('projects'),'fb-account-action'));
      }
      return;
    }
    const owner=account.user?.id;
    let rows;
    try{await saveQueue;rows=owner?(await api('projects')).projects:guestProjects()}
    catch(e){if(serial===opened&&dialog.open)setMessage(e.message);return}
    if(serial!==opened||!dialog.open)return;
    body.append(el('p',owner?'保存在淘宝账号中的项目':'保存在此浏览器的项目','fb-account-sub'));
    if(!rows.length){setMessage('还没有保存的项目。生成第一个方案后，就能在这里找到它。');return}
    const list=el('ul','','fb-account-list');body.append(list);
    for(const p of rows){
      const li=el('li'),b=button('',async()=>{
        b.disabled=true;
        try{const rec=owner?(await api('projects/'+encodeURIComponent(p.id))).project:p;
          if(serial!==opened||!dialog.open||owner!==account.user?.id)return;
          if(!rec?.design)throw Error('项目资料暂时无法读取。');
          if(!owner)lastGuestId=rec.id;dialog.close();await callbacks.onOpen?.(rec);
        }catch(e){if(dialog.open)setMessage(e.message)}finally{b.disabled=false}
      });b.append(el('strong',p.name||p.design?.name||'硬件方案'));
      const date=new Date(p.updatedAt);if(!Number.isNaN(date.valueOf()))b.append(el('small',date.toLocaleDateString('zh-CN')));
      li.append(b);list.append(li);
    }
  }
  dialog.addEventListener('close',()=>{opened++});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dialog.close()}});
  const returning=new URL(location.href).searchParams.get('account')==='linked';
  initial=check();updateBar();
  initial.then(async()=>{
    updateBar();
    if(!returning||!account.user)return;
    const url=new URL(location.href);url.searchParams.delete('account');history.replaceState(null,'',url);
    const pending=sessionStorage.getItem(pendingKey);
    if(pending){const draft=guestProjects().find(p=>p.id===pending);if(draft){
      try{await saveConsumerProject(draft);sessionStorage.removeItem(pendingKey);await callbacks.onOpen?.(draft);return}
      catch(e){await open('projects');setMessage(e.message);return}
    }}
    await open('projects');
  });
}
