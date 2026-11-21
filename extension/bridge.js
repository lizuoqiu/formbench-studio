// Chrome match patterns do not support ports. Enforce the full origin/path here and in the worker.
(() => {
  if (self !== top || !(
    location.origin === 'https://lizuoqiu.github.io' && location.pathname === '/formbench-studio/' ||
    ['http://127.0.0.1:4173','http://localhost:4173'].includes(location.origin) && location.pathname === '/'
  )) return;
  const post = message => window.postMessage({ ...message,source:'formbench-extension',version:1 },location.origin);
  const allowed = ['FB_CART_STATUS','FB_CART_PREPARE','FB_HELPER_PING','FB_PICK_PREPARE'];
  window.addEventListener('message',async event=>{
    const m=event.data;
    if(event.source!==window || event.origin!==location.origin || m?.source!=='formbench-studio' || !allowed.includes(m.type) || typeof m.requestId!=='string' || m.requestId.length>80)return;
    if(m.type==='FB_HELPER_PING'){post({type:'FB_HELPER_PONG',requestId:m.requestId,features:['pick']});return;}
    try {
      if(m.type!=='FB_CART_STATUS' && !navigator.userActivation.isActive) throw Error('请在工作台点击对应按钮以打开淘宝。');
      const response=await chrome.runtime.sendMessage(m.type==='FB_PICK_PREPARE'?{type:m.type,requestId:m.requestId,partName:m.partName,query:m.query,url:m.url}:{type:m.type,requestId:m.requestId,items:m.type==='FB_CART_PREPARE'?m.items:undefined});
      if(response)post(response);
    }catch(e){post({type:m.type==='FB_PICK_PREPARE'?'FB_PICK_RESULT':'FB_CART_UPDATE',requestId:m.requestId,state:'error',message:e.message,results:[]});}
  });
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{
    if(sender.id===chrome.runtime.id && ['FB_CART_UPDATE','FB_PICK_RESULT'].includes(m?.type)){post(m);reply({delivered:true});}
  });
})();
